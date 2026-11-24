/**
 * Two-party transport over a unix socket, carrying `SCM_RIGHTS`
 * with each frame the way capnp-C++ `rpc-twoparty.c++` does.
 *
 * `lib` is a shared library exporting `capnp_send_fds` and `capnp_recv_fds`
 * (`packages/rpc/src/fdmsg.c`). The socket is read with `recvmsg`, because
 * a plain byte read drops the attached descriptors.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync } from "node:fs";

import { frameLength, StreamTransport } from "./socket.ts";

const MAX_FDS = 253;
const RECV_CAP = 1024 * 1024;
/** Linux `EINTR`. `KJ_NONBLOCKING_SYSCALL` retries this and no other errno. */
const EINTR = 4;

type FdLib = {
  symbols: {
    capnp_send_fds: (sock: number, buf: ReturnType<typeof ptr>, len: number, fds: ReturnType<typeof ptr>, nfds: number) => number;
    capnp_recv_fds: (
      sock: number,
      buf: ReturnType<typeof ptr>,
      cap: number,
      fds: ReturnType<typeof ptr>,
      maxfds: number,
      nfds: ReturnType<typeof ptr>,
    ) => number;
    capnp_unix_connect: (path: string) => number;
  };
  close: () => void;
};

export function openFdLib(soPath: string): FdLib {
  return dlopen(soPath, {
    capnp_send_fds: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
    capnp_recv_fds: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr],
      returns: FFIType.i32,
    },
    capnp_unix_connect: {
      args: [FFIType.cstring],
      returns: FFIType.i32,
    },
  }) as unknown as FdLib;
}

export function unixConnect(lib: FdLib, path: string): number {
  return lib.symbols.capnp_unix_connect(path);
}

/**
 * Byte-stream transport that sends and receives file descriptors with
 * the frame. `fd` is the connected unix socket.
 */
export class UnixFdTransport extends StreamTransport {
  private readonly recvBuf = new Uint8Array(RECV_CAP);
  private readonly fdBuf = new Int32Array(MAX_FDS);
  private readonly nfdBuf = new Int32Array(1);
  private readonly inboxFds: number[][] = [];
  private carriedFds: number[] = [];
  private lastFds: readonly number[] = [];
  private readonly socketFd: number;

  constructor(
    fd: number,
    private readonly lib: FdLib,
    /** FDs accepted for one message. `0` accepts none, as `maxFdsPerMessage`. */
    private readonly maxFdsPerMessage = 0,
  ) {
    super((bytes) => {
      UnixFdTransport.sendRaw(lib, fd, bytes, []);
    });
    this.socketFd = fd;
  }

  override send(frame: Uint8Array, fds?: readonly number[]): void {
    if (this.closed) throw new Error("transport is closed");
    UnixFdTransport.sendRaw(this.lib, this.socketFd, frame, fds ?? []);
  }

  /** Read one `recvmsg` and split complete frames off the buffer. */
  pull(): number {
    if (this.paused) return 0;
    for (;;) {
      const room = Math.max(0, this.maxFdsPerMessage - this.carriedFds.length);
      // Descriptors already queued belong to the unfinished frame. Reading
      // past it would take the next message's descriptors with `room == 0`.
      const need = this.bytesToFinishFrame();
      const cap =
        this.carriedFds.length > 0 && need > 0 ? Math.min(this.recvBuf.byteLength, need) : this.recvBuf.byteLength;
      const n = this.lib.symbols.capnp_recv_fds(
        this.socketFd,
        ptr(this.recvBuf),
        cap,
        ptr(this.fdBuf),
        room,
        ptr(this.nfdBuf),
      );
      if (n === -1) return 0;
      if (n < 0) {
        if ((this.nfdBuf[0] ?? 0) === EINTR) continue;
        throw new Error(`recvmsg failed; errno = ${this.nfdBuf[0] ?? 0}`);
      }
      if (n === 0) {
        this.close();
        return 0;
      }
      const chunk = this.recvBuf.slice(0, n);
      const fds = Array.from(this.fdBuf.subarray(0, this.nfdBuf[0] ?? 0));
      return this.ingest(chunk, fds);
    }
  }

  /**
   * Split `chunk` into frames and attach `fds` the way
   * `serialize-async.c++` does. Descriptors from one read belong to the
   * message that contains that read's last byte. Bytes left over after
   * the last complete frame carry the descriptors to a later read.
   */
  ingest(chunk: Uint8Array, fds: readonly number[]): number {
    const before = this.pending;
    try {
      this.feed(chunk);
    } catch (error) {
      for (const fd of fds) this.closeFd(fd);
      throw error;
    }
    const gained = this.pending - before;
    const incoming = this.keepFds([...this.carriedFds, ...fds]);
    this.carriedFds = [];
    const tail = this.incompleteBytes() > 0;
    if (gained <= 0 || tail) {
      for (let i = 0; i < gained; i++) this.inboxFds.push([]);
      this.carriedFds = incoming;
      return gained;
    }
    for (let i = 0; i < gained; i++) {
      this.inboxFds.push(i === gained - 1 ? incoming : []);
    }
    return gained;
  }

  /** Keep the first `maxFdsPerMessage` descriptors and close the rest. */
  private keepFds(fds: readonly number[]): number[] {
    const keep: number[] = [];
    for (const fd of fds) {
      if (keep.length < this.maxFdsPerMessage) keep.push(fd);
      else this.closeFd(fd);
    }
    return keep;
  }

  /** Close one OS descriptor received on this socket. */
  closeFd(fd: number): void {
    try {
      closeSync(fd);
    } catch {
      // The descriptor may already be closed.
    }
  }

  override close(): void {
    for (const group of this.inboxFds) {
      for (const fd of group) this.closeFd(fd);
    }
    for (const fd of this.carriedFds) this.closeFd(fd);
    this.inboxFds.length = 0;
    this.carriedFds = [];
    super.close();
  }

  override receive(): Uint8Array | null {
    this.lastFds = this.inboxFds.shift() ?? [];
    return super.receive();
  }

  receivedFds(): readonly number[] {
    return this.lastFds;
  }

  ownsReceivedFds(): boolean {
    return true;
  }

  private static sendRaw(lib: FdLib, sock: number, frame: Uint8Array, fds: readonly number[]): void {
    const bytes = frame.byteOffset === 0 && frame.buffer instanceof ArrayBuffer ? frame : frame.slice();
    const raw = new Int32Array(Math.max(fds.length, 1));
    for (let i = 0; i < fds.length; i++) raw[i] = fds[i]!;
    const n = lib.symbols.capnp_send_fds(sock, ptr(bytes), bytes.byteLength, ptr(raw), fds.length);
    if (n !== frame.byteLength) {
      throw new Error(`sendmsg wrote ${n} of ${frame.byteLength}`);
    }
  }
}

/** True when `buf` holds at least one complete frame. Exposed for tests. */
export function hasFrame(buf: Uint8Array): boolean {
  return frameLength(buf) > 0;
}
