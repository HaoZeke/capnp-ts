/**
 * Two-party transport over a unix socket, carrying `SCM_RIGHTS`
 * with each frame the way capnp-C++ `rpc-twoparty.c++` does.
 *
 * `lib` is a shared library exporting `capnp_send_fds` and `capnp_recv_fds`
 * (`packages/rpc/src/fdmsg.c`). The socket is read with `recvmsg`, because
 * a plain byte read drops the attached descriptors.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { frameLength, StreamTransport } from "./socket.ts";

const MAX_FDS = 253;
const RECV_CAP = 1024 * 1024;

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
    const n = this.lib.symbols.capnp_recv_fds(
      this.socketFd,
      ptr(this.recvBuf),
      this.recvBuf.byteLength,
      ptr(this.fdBuf),
      MAX_FDS,
      ptr(this.nfdBuf),
    );
    if (n < 0) return 0;
    if (n === 0) {
      this.close();
      return 0;
    }
    const chunk = this.recvBuf.slice(0, n);
    const fds = Array.from(this.fdBuf.subarray(0, this.nfdBuf[0] ?? 0));
    const before = this.pending;
    this.feed(chunk);
    const gained = this.pending - before;
    if (gained <= 0) {
      this.carriedFds.push(...fds);
      return 0;
    }
    for (let i = 0; i < gained; i++) {
      this.inboxFds.push(i === 0 ? [...this.carriedFds, ...fds] : []);
    }
    this.carriedFds = [];
    return gained;
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
