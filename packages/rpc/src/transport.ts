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
  /** Hand one framed message to the peer. */
  send(frame: Uint8Array): void;
  /** Next frame from the peer, or null when none is pending. */
  receive(): Uint8Array | null;
  /** Frames waiting to be read. */
  readonly pending: number;
  close(): void;
  readonly closed: boolean;
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
    const state = { closed: false };

    const make = (outbox: Uint8Array[], inbox: Uint8Array[]): Transport => ({
      send(frame: Uint8Array): void {
        if (state.closed) throw new Error("transport is closed");
        // Copy: the caller may reuse its buffer once send returns.
        outbox.push(frame.slice());
      },
      receive(): Uint8Array | null {
        return inbox.shift() ?? null;
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
    });

    this.a = make(toB, toA);
    this.b = make(toA, toB);
  }
}
