/**
 * Attached file descriptors over a real unix socket, against capnp-C++ 1.4.0.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, readSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "../src/index.ts";
import { openFdLib, UnixFdTransport, unixConnect } from "../src/unix.ts";
import { RpcConnection } from "../src/vat.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function compileSo(): string | undefined {
  const dir = mkdtempSync(join(tmpdir(), "fdmsg-"));
  const so = join(dir, "libfdmsg.so");
  const cc = spawnSync("cc", ["-shared", "-fPIC", "-o", so, join(root, "packages/rpc/src/fdmsg.c")]);
  if (cc.status !== 0) return undefined;
  return so;
}

function buildPeer(): { so: string; peer: string } | undefined {
  const so = compileSo();
  if (so === undefined) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "fd-peer-"));
  const peer = join(dir, "fd_peer");
  const schema = join(root, "schema/fdcap.capnp");
  const gen = spawnSync(
    "capnp",
    ["compile", "--src-prefix=" + join(root, "schema"), "-oc++:" + dir, schema],
    { encoding: "utf8" },
  );
  if (gen.status !== 0) return undefined;
  const cxx = spawnSync(
    "g++",
    [
      "-std=c++17",
      "-o",
      peer,
      join(root, "interop/fd_peer.c++"),
      join(dir, "fdcap.capnp.c++"),
      "-I",
      dir,
      ...spawnSync("pkg-config", ["--cflags", "--libs", "capnp-rpc"], { encoding: "utf8" }).stdout.trim().split(/\s+/),
    ],
  );
  if (cxx.status !== 0) return undefined;
  return { so, peer };
}

describe("unix socket attached fd", () => {
  test("a C++ peer's bootstrap capability arrives with its pipe", async () => {
    const built = buildPeer();
    expect(built).toBeDefined();
    const sock = join(mkdtempSync(join(tmpdir(), "fd-sock-")), "peer.sock");
    const child = Bun.spawn([built!.peer, sock], { stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("ready");
    const lib = openFdLib(built!.so);
    const fd = unixConnect(lib, sock);
    expect(fd).toBeGreaterThan(2);
    const transport = new UnixFdTransport(fd, lib, 8);
    const conn = new RpcConnection(transport);
    const cap: Client = conn.bootstrap();
    let got: number | undefined;
    for (let i = 0; i < 20 && got === undefined; i++) {
      transport.pull();
      conn.pump();
      got = cap.getFd();
      if (got === undefined) await new Promise((r) => setTimeout(r, 10));
    }
    expect(got).toBeGreaterThan(2);
    const buf = Buffer.alloc(1);
    expect(readSync(got!, buf, 0, 1, null)).toBe(1);
    expect(String.fromCharCode(buf[0]!)).toBe("Q");
    cap.release();
    child.kill();
    lib.close();
  });
});

const libc = dlopen("libc.so.6", {
  socketpair: {
    args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr],
    returns: FFIType.i32,
  },
  pipe: {
    args: [FFIType.ptr],
    returns: FFIType.i32,
  },
  fcntl: {
    args: [FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
});

function socketpair(): [number, number] {
  const fds = new Int32Array(2);
  // AF_UNIX, SOCK_STREAM.
  if (libc.symbols.socketpair(1, 1, 0, ptr(fds)) !== 0) throw new Error("socketpair");
  return [fds[0]!, fds[1]!];
}

function sendFds(lib: ReturnType<typeof openFdLib>, sock: number, bytes: Uint8Array, fds: number[]): void {
  const raw = new Int32Array(Math.max(fds.length, 1));
  for (let i = 0; i < fds.length; i++) raw[i] = fds[i]!;
  const n = lib.symbols.capnp_send_fds(sock, ptr(bytes), bytes.byteLength, ptr(raw), fds.length);
  if (n !== bytes.byteLength) throw new Error(`sendmsg wrote ${n}`);
}

describe("recvmsg fd association", () => {
  test("ingest closes received descriptors when frame parsing throws", () => {
    const closed: number[] = [];
    const transport = new UnixFdTransport(
      -1,
      {} as ReturnType<typeof openFdLib>,
      2,
    );
    (transport as unknown as { feed(chunk: Uint8Array): void }).feed = () => {
      throw new Error("bad frame");
    };
    (transport as unknown as { closeFd(fd: number): void }).closeFd = (fd) => {
      closed.push(fd);
    };

    expect(() => transport.ingest(Uint8Array.of(1), [7, 8])).toThrow("bad frame");
    expect(closed).toEqual([7, 8]);
  });

  test("a frame error closes descriptors carried from earlier reads", () => {
    const so = compileSo();
    expect(so).toBeDefined();
    const lib = openFdLib(so!);
    const cases: Array<{ head: number[]; tail: number[]; error: string }> = [
      { head: [0xff, 0xff, 0xff, 0xff], tail: [0, 0, 0, 0], error: "segment count too large" },
      { head: [0, 0, 0, 0], tail: [0xff, 0xff, 0xff, 0x7f], error: "exceeds size limit" },
    ];
    try {
      for (const { head, tail, error } of cases) {
        const [a, b] = socketpair();
        const pipe = new Int32Array(2);
        expect(libc.symbols.pipe(ptr(pipe))).toBe(0);
        const transport = new UnixFdTransport(b, lib, 2);
        try {
          sendFds(lib, a, Uint8Array.from(head), [pipe[0]!]);
          closeSync(pipe[0]!);
          expect(transport.pull()).toBe(0);
          sendFds(lib, a, Uint8Array.from(tail), []);
          expect(() => transport.pull()).toThrow(error);
          expect(() => writeSync(pipe[1]!, Buffer.from("x"))).toThrow();
        } finally {
          transport.close();
          closeSync(a);
          closeSync(b);
          try { closeSync(pipe[1]!); } catch { /* write end */ }
        }
      }
    } finally {
      lib.close();
    }
  });

  test("a recvmsg error closes descriptors carried from earlier reads", () => {
    const libcWrite = dlopen("libc.so.6", {
      memcpy: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
        returns: FFIType.ptr,
      },
    });
    const lib = {
      symbols: {
        capnp_send_fds: () => 0,
        capnp_unix_connect: () => -1,
        capnp_recv_fds: (
          _sock: number,
          _buf: unknown,
          _cap: number,
          _fds: unknown,
          _max: number,
          nfds: number,
        ) => {
          // ECONNRESET.
          libcWrite.symbols.memcpy(nfds, ptr(new Int32Array([104])), 4);
          return -2;
        },
      },
      close() {},
    } as ReturnType<typeof openFdLib>;
    const closed: number[] = [];
    const transport = new UnixFdTransport(-1, lib, 2);
    (transport as unknown as { closeFd(fd: number): void }).closeFd = (fd) => {
      closed.push(fd);
    };
    try {
      expect(transport.ingest(Uint8Array.of(0, 0, 0, 0), [7])).toBe(0);
      expect(closed).toEqual([]);
      expect(() => transport.pull()).toThrow("errno = 104");
      expect(closed).toEqual([7]);
      transport.close();
      expect(closed).toEqual([7]);
    } finally {
      libcWrite.close();
    }
  });

  test("a closed transport takes no more descriptors off the socket", () => {
    const so = compileSo();
    expect(so).toBeDefined();
    const lib = openFdLib(so!);
    const [a, b] = socketpair();
    const pipe = new Int32Array(2);
    expect(libc.symbols.pipe(ptr(pipe))).toBe(0);
    const transport = new UnixFdTransport(b, lib, 2);
    try {
      transport.close();
      sendFds(lib, a, new Uint8Array(8), [pipe[0]!]);
      closeSync(pipe[0]!);
      expect(transport.pull()).toBe(0);
      closeSync(a);
      closeSync(b);
      expect(() => writeSync(pipe[1]!, Buffer.from("x"))).toThrow();
    } finally {
      lib.close();
      try { closeSync(pipe[1]!); } catch { /* write end */ }
    }
  });

  test("fds from one read belong to the frame that holds its last byte", () => {
    const so = compileSo();
    expect(so).toBeDefined();
    const lib = openFdLib(so!);
    const [a, b] = socketpair();
    const extra = new Int32Array(2);
    expect(libc.symbols.pipe(ptr(extra))).toBe(0);
    try {
      sendFds(lib, a, new Uint8Array(16), [extra[0]!]);
      closeSync(extra[0]!);
      const transport = new UnixFdTransport(b, lib, 8);
      expect(transport.pull()).toBe(2);
      expect(transport.receive()).not.toBeNull();
      expect([...transport.receivedFds()]).toEqual([]);
      expect(transport.receive()).not.toBeNull();
      expect(transport.receivedFds().length).toBe(1);
      transport.close();
    } finally {
      lib.close();
      closeSync(a);
      closeSync(b);
      try { closeSync(extra[1]!); } catch { /* write end */ }
    }
  });

  test("a read that ends mid-frame carries its fds onto that frame", () => {
    const so = compileSo();
    expect(so).toBeDefined();
    const lib = openFdLib(so!);
    const [a, b] = socketpair();
    const extra = new Int32Array(2);
    expect(libc.symbols.pipe(ptr(extra))).toBe(0);
    try {
      sendFds(lib, a, new Uint8Array(12), [extra[0]!]);
      closeSync(extra[0]!);
      const transport = new UnixFdTransport(b, lib, 8);
      expect(transport.pull()).toBe(1);
      expect(transport.receive()).not.toBeNull();
      expect([...transport.receivedFds()]).toEqual([]);
      sendFds(lib, a, new Uint8Array(4), []);
      expect(transport.pull()).toBe(1);
      expect(transport.receive()).not.toBeNull();
      expect(transport.receivedFds().length).toBe(1);
      transport.close();
    } finally {
      lib.close();
      closeSync(a);
      closeSync(b);
      try { closeSync(extra[1]!); } catch { /* write end */ }
    }
  });

  test("close() closes fds still waiting in the inbox and carried over", () => {
    const so = compileSo();
    expect(so).toBeDefined();
    const lib = openFdLib(so!);
    const [a, b] = socketpair();
    const extra = new Int32Array(2);
    expect(libc.symbols.pipe(ptr(extra))).toBe(0);
    try {
      sendFds(lib, a, new Uint8Array(16), [extra[0]!]);
      closeSync(extra[0]!);
      const transport = new UnixFdTransport(b, lib, 8);
      expect(transport.pull()).toBe(2);
      transport.close();
      expect(() => writeSync(extra[1]!, Buffer.from("x"))).toThrow();
    } finally {
      lib.close();
      closeSync(a);
      closeSync(b);
      try { closeSync(extra[1]!); } catch { /* already closed or EPIPE */ }
    }
  });

  test("partial reads keep at most maxFdsPerMessage descriptors", () => {
    const so = compileSo();
    expect(so).toBeDefined();
    const lib = openFdLib(so!);
    const [a, b] = socketpair();
    const writes: number[] = [];
    const transport = new UnixFdTransport(b, lib, 2);
    const frame = new Uint8Array(16);
    frame[4] = 1;
    try {
      for (let i = 0; i < 3; i++) {
        const pipe = new Int32Array(2);
        expect(libc.symbols.pipe(ptr(pipe))).toBe(0);
        writes.push(pipe[1]!);
        sendFds(lib, a, frame.subarray(i * 4, i * 4 + 4), [pipe[0]!]);
        closeSync(pipe[0]!);
        transport.pull();
      }
      sendFds(lib, a, frame.subarray(12), []);
      expect(transport.pull()).toBe(1);
      expect(transport.receive()).not.toBeNull();
      expect(transport.receivedFds().length).toBeLessThanOrEqual(2);
      expect(() => writeSync(writes[2]!, Buffer.from("x"))).toThrow();
    } finally {
      transport.close();
      lib.close();
      closeSync(a);
      closeSync(b);
      for (const fd of writes) {
        try { closeSync(fd); } catch { /* closed with the pipe */ }
      }
    }
  });

  test("received descriptors are close-on-exec and extras are closed", () => {
    const so = compileSo();
    expect(so).toBeDefined();
    const lib = openFdLib(so!);
    const [a, b] = socketpair();
    const pipes = [new Int32Array(2), new Int32Array(2)];
    const transport = new UnixFdTransport(b, lib, 1);
    try {
      for (const pipe of pipes) expect(libc.symbols.pipe(ptr(pipe))).toBe(0);
      sendFds(lib, a, new Uint8Array(8), [pipes[0]![0]!, pipes[1]![0]!]);
      closeSync(pipes[0]![0]!);
      closeSync(pipes[1]![0]!);
      expect(transport.pull()).toBe(1);
      expect(transport.receive()).not.toBeNull();
      const got = transport.receivedFds();
      expect(got.length).toBe(1);
      expect(libc.symbols.fcntl(got[0]!, 1) & 1).toBe(1);
      expect(() => writeSync(pipes[1]![1]!, Buffer.from("x"))).toThrow();
    } finally {
      transport.close();
      lib.close();
      closeSync(a);
      closeSync(b);
      for (const pipe of pipes) {
        try { closeSync(pipe[1]!); } catch { /* write end */ }
      }
    }
  });

  test("two SCM_RIGHTS headers in one recvmsg are both kept", () => {
    const so = compileSo();
    expect(so).toBeDefined();
    const lib = dlopen(so!, {
      capnp_send_two: {
        args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
    });
    const [a, b] = socketpair();
    const pipes = [new Int32Array(2), new Int32Array(2)];
    const transport = new UnixFdTransport(b, openFdLib(so!), 4);
    try {
      for (const pipe of pipes) expect(libc.symbols.pipe(ptr(pipe))).toBe(0);
      const bytes = new Uint8Array(8);
      const n = lib.symbols.capnp_send_two(a, ptr(bytes), bytes.byteLength, pipes[0]![0]!, pipes[1]![0]!);
      expect(n).toBe(bytes.byteLength);
      closeSync(pipes[0]![0]!);
      closeSync(pipes[1]![0]!);
      expect(transport.pull()).toBe(1);
      expect(transport.receive()).not.toBeNull();
      expect(transport.receivedFds().length).toBe(2);
    } finally {
      transport.close();
      lib.close();
      closeSync(a);
      closeSync(b);
      for (const pipe of pipes) {
        try { closeSync(pipe[1]!); } catch { /* write end */ }
      }
    }
  });

  test("a partial frame that already has an fd leaves the next message's fd open", () => {
    const so = compileSo();
    expect(so).toBeDefined();
    const lib = openFdLib(so!);
    const [a, b] = socketpair();
    const first = new Int32Array(2);
    const second = new Int32Array(2);
    expect(libc.symbols.pipe(ptr(first))).toBe(0);
    expect(libc.symbols.pipe(ptr(second))).toBe(0);
    const transport = new UnixFdTransport(b, lib, 1);
    const head = new Uint8Array(8);
    head[4] = 1;
    try {
      sendFds(lib, a, head, [first[0]!]);
      closeSync(first[0]!);
      expect(transport.pull()).toBe(0);
      sendFds(lib, a, new Uint8Array(8), []);
      sendFds(lib, a, new Uint8Array(8), [second[0]!]);
      closeSync(second[0]!);
      expect(transport.pull()).toBe(1);
      expect(transport.receive()).not.toBeNull();
      expect(transport.receivedFds().length).toBe(1);
      expect(transport.pull()).toBe(1);
      expect(transport.receive()).not.toBeNull();
      expect(transport.receivedFds().length).toBe(1);
      expect(writeSync(second[1]!, Buffer.from("x"))).toBe(1);
    } finally {
      transport.close();
      lib.close();
      closeSync(a);
      closeSync(b);
      for (const fd of [first[1]!, second[1]!]) {
        try { closeSync(fd); } catch { /* write end */ }
      }
    }
  });

  test("pull retries when recvmsg returns EINTR", () => {
    const libcWrite = dlopen("libc.so.6", {
      memcpy: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
        returns: FFIType.ptr,
      },
    });
    let calls = 0;
    const lib = {
      symbols: {
        capnp_send_fds: () => 0,
        capnp_unix_connect: () => -1,
        capnp_recv_fds: (
          _sock: number,
          _buf: unknown,
          _cap: number,
          _fds: unknown,
          _max: number,
          nfds: number,
        ) => {
          calls++;
          if (calls === 1) {
            const err = new Int32Array([4]);
            libcWrite.symbols.memcpy(nfds, ptr(err), 4);
            return -2;
          }
          return 0;
        },
      },
      close() {},
    } as ReturnType<typeof openFdLib>;
    const transport = new UnixFdTransport(-1, lib, 1);
    try {
      expect(transport.pull()).toBe(0);
      expect(calls).toBe(2);
    } finally {
      libcWrite.close();
    }
  });

  test("an error other than EAGAIN is thrown", () => {
    const so = compileSo();
    expect(so).toBeDefined();
    const transport = new UnixFdTransport(-1, openFdLib(so!), 1);
    expect(() => transport.pull()).toThrow(/errno/);
  });

  test("pull does not read while paused", () => {
    const so = compileSo();
    expect(so).toBeDefined();
    const lib = openFdLib(so!);
    const [a, b] = socketpair();
    const transport = new UnixFdTransport(b, lib, 4);
    try {
      sendFds(lib, a, new Uint8Array(8), []);
      transport.setPaused(true);
      expect(transport.pull()).toBe(0);
      expect(transport.pending).toBe(0);
      transport.setPaused(false);
      expect(transport.pull()).toBe(1);
    } finally {
      transport.close();
      lib.close();
      closeSync(a);
      closeSync(b);
    }
  });
});
