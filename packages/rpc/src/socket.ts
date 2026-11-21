/**
 * A Transport over a byte stream, for talking to a real peer.
 *
 * The RPC layer deals in whole framed messages, so this recovers the
 * message boundary from the stream itself: the segment table at the head
 * of every message says how many words follow, which is the only length
 * information Cap'n Proto puts on the wire.
 */
import type { Transport } from "./transport.ts";

/**
 * Bytes the frame starting at `buf[0]` occupies, or 0 if incomplete.
 *
 * As capnp-C++ `BufferedMessageStream` reads RPC frames, any segment
 * count is accepted.
 */
export function frameLength(buf: Uint8Array): number {
  if (buf.length < 8) return 0;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const first = view.getUint32(0, true);
  if (first === 0xffffffff) {
    throw new Error("expected segmentCount != 0 [0 != 0]; Message segment count too large, caused overflow.");
  }
  const nsegs = first + 1;
  const tableWords = Math.floor(nsegs / 2) + 1;
  const known = Math.min(nsegs, Math.floor(buf.length / 8) * 2 - 1);
  let words = tableWords;
  for (let i = 0; i < known; i++) words += view.getUint32(4 + i * 4, true);
  if (known < nsegs) return 0;
  const total = words * 8;
  return buf.length < total ? 0 : total;
}

/**
 * Transport over a duplex byte stream. `write` hands bytes to the peer;
 * `feed` takes bytes as they arrive, in whatever chunks the stream
 * delivers them.
 */
export class StreamTransport implements Transport {
  private buffer = new Uint8Array(0);
  private readonly inbox: Uint8Array[] = [];
  private shut = false;

  constructor(
    private readonly write: (bytes: Uint8Array) => void,
    private readonly sendBufferSize?: () => number | undefined,
  ) {}

  getSendBufferSize(): number | undefined {
    return this.sendBufferSize?.();
  }

  /** Take bytes off the stream; complete frames become receivable. */
  feed(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    for (;;) {
      const n = frameLength(this.buffer);
      if (n === 0) break;
      this.inbox.push(this.buffer.slice(0, n));
      this.buffer = this.buffer.slice(n);
    }
  }

  send(frame: Uint8Array): void {
    if (this.shut) throw new Error("transport is closed");
    this.write(frame);
  }

  receive(): Uint8Array | null {
    return this.inbox.shift() ?? null;
  }

  get pending(): number {
    return this.inbox.length;
  }

  close(): void {
    this.shut = true;
  }

  get closed(): boolean {
    return this.shut;
  }
}
