/**
 * Message transport for a two-party vat.
 *
 * The RPC layer deals in whole framed messages, so a transport moves
 * `Uint8Array` frames rather than a byte stream: whatever carries them
 * (a socket, a WebSocket, a worker port) is responsible for preserving
 * the boundaries, exactly as the stream framing already does when the
 * carrier is a byte stream.
 */
export interface Transport {
  /** Hand one framed message to the peer. `fds` ride with it as `SCM_RIGHTS`. */
  send(frame: Uint8Array, fds?: readonly number[]): void;
  /** Next frame from the peer, or null when none is pending. */
  receive(): Uint8Array | null;
  /** FDs attached to the frame just returned by `receive`. */
  receivedFds?(): readonly number[];
  /** True when those FDs are OS descriptors the receiver must close. */
  ownsReceivedFds?(): boolean;
  /** Frames waiting to be read. */
  readonly pending: number;
  close(): void;
  readonly closed: boolean;
  /** Optional dynamic send-buffer window in bytes, as capnp-C++'s `getSendBufferSize()`. */
  getSendBufferSize?(): number | undefined;
  /**
   * Close one OS file descriptor this transport handed out.
   * The portable core never imports a host filesystem; the transport does.
   */
  closeFd?(fd: number): void;
  /**
   * Stop taking bytes while the vat is over its flow limit.
   * `false` passes on what arrived in the meantime.
   */
  setPaused?(paused: boolean): void;
}

/**
 * A connected pair of in-memory transports.
 *
 * Both ends live in one process and neither blocks, so a test can pump
 * the two vats in lockstep and observe every message in a deterministic
 * order — the same shape as a socketpair, without the syscalls.
 */
export class MemoryTransportPair {
  readonly a: Transport;
  readonly b: Transport;

  constructor() {
    const toA: Uint8Array[] = [];
    const toB: Uint8Array[] = [];
    const fdsA: number[][] = [];
    const fdsB: number[][] = [];
    const state = { closed: false };

    const make = (
      outbox: Uint8Array[],
      inbox: Uint8Array[],
      outFds: number[][],
      inFds: number[][],
    ): Transport => {
      let lastFds: readonly number[] = [];
      return {
      send(frame: Uint8Array, fds?: readonly number[]): void {
        if (state.closed) throw new Error("transport is closed");
        // Copy: the caller may reuse its buffer once send returns.
        outbox.push(frame.slice());
        outFds.push(fds ? [...fds] : []);
      },
      receive(): Uint8Array | null {
        lastFds = inFds.shift() ?? [];
        return inbox.shift() ?? null;
      },
      receivedFds(): readonly number[] {
        return lastFds;
      },
      get pending(): number {
        return inbox.length;
      },
      close(): void {
        state.closed = true;
      },
      get closed(): boolean {
        return state.closed;
      },
    };
    };

    this.a = make(toB, toA, fdsB, fdsA);
    this.b = make(toA, toB, fdsA, fdsB);
  }
}
