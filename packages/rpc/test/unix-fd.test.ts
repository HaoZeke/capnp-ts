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
    const transport = new UnixFdTransport(fd, lib);
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
      const transport = new UnixFdTransport(b, lib);
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
      const transport = new UnixFdTransport(b, lib);
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
      const transport = new UnixFdTransport(b, lib);
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
});
