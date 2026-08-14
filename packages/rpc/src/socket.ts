/**
 * A Transport over a byte stream, for talking to a real peer.
 *
 * The RPC layer deals in whole framed messages, so this recovers the
 * message boundary from the stream itself: the segment table at the head
 * of every message says how many words follow, which is the only length
 * information Cap'n Proto puts on the wire.
 */
import type { Transport } from "./transport.ts";

const MAX_SEGMENTS = 64;

/** Bytes the frame starting at `buf[0]` occupies, or 0 if incomplete. */
export function frameLength(buf: Uint8Array): number {
  if (buf.length < 4) return 0;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const nsegs = view.getUint32(0, true) + 1;
  if (nsegs > MAX_SEGMENTS) throw new Error(`bad segment count ${nsegs}`);
  let table = 4 + nsegs * 4;
  if (table % 8 !== 0) table += 4;
  if (buf.length < table) return 0;
  let words = 0;
  for (let i = 0; i < nsegs; i++) words += view.getUint32(4 + i * 4, true);
  const total = table + words * 8;
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

  constructor(private readonly write: (bytes: Uint8Array) => void) {}

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
