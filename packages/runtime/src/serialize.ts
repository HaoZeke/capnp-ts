/**
 * Stream-framing encoder helpers.
 */

import { CapnpError, WORD_BYTES } from "./kinds.ts";
import { storeU32 } from "./endian.ts";
import { Message } from "./message.ts";

/** Segment as either a raw buffer or {data, words} view. */
export type FrameSeg = Uint8Array | { data: Uint8Array; words: number };

function segBytes(s: FrameSeg): Uint8Array {
  if (s instanceof Uint8Array) return s;
  return s.data.subarray(0, s.words * WORD_BYTES);
}

function segWords(s: FrameSeg): number {
  if (s instanceof Uint8Array) {
    if (s.byteLength % WORD_BYTES !== 0) {
      throw new CapnpError("FRAMING", "segment not word-aligned");
    }
    return s.byteLength / WORD_BYTES;
  }
  return s.words;
}

/**
 * Frame segment payloads into a single stream buffer
 * (segment table + concatenated segment bodies).
 */
export function frameSegments(segs: readonly FrameSeg[]): Uint8Array {
  const nsegs = segs.length;
  if (nsegs === 0) {
    throw new CapnpError("ARG", "empty message");
  }

  let bodyWords = 0;
  for (const s of segs) bodyWords += segWords(s);

  let tableBytes = 4 + 4 * nsegs;
  if (tableBytes % 8 !== 0) tableBytes += 4;

  const total = tableBytes + bodyWords * WORD_BYTES;
  const buf = new Uint8Array(total);

  storeU32(buf, 0, nsegs - 1);
  for (let i = 0; i < nsegs; i++) {
    storeU32(buf, 4 + 4 * i, segWords(segs[i]!));
  }

  let off = tableBytes;
  for (const s of segs) {
    const bytes = segBytes(s);
    if (bytes.byteLength) buf.set(bytes, off);
    off += bytes.byteLength;
  }
  return buf;
}

/**
 * Serialize a Message into stream-framed flat bytes.
 * Uses Message.copyFlat when present; otherwise frames msg.segments.
 */
export function serializeToFlat(msg: Message): Uint8Array {
  if (typeof (msg as { copyFlat?: () => Uint8Array }).copyFlat === "function") {
    return (msg as { copyFlat: () => Uint8Array }).copyFlat();
  }
  const segs = (msg as { segments?: Uint8Array[] }).segments;
  if (!segs || segs.length === 0) {
    throw new CapnpError("ARG", "empty message");
  }
  return frameSegments(segs);
}
