/**
 * Stream-framing encoder helpers.
 */

import { CapnpError, MAX_SEGMENTS, WORD_BYTES } from "./kinds.ts";
import { storeU32 } from "./endian.ts";
import { Message } from "./message.ts";

/** Segment as either a raw buffer or {data, words} view. */
export type FrameSeg = Uint8Array | { data: Uint8Array; words: number };

/**
 * Word count for a frame segment. Rejects unaligned raw buffers and
 * `{ data, words }` views whose buffer is shorter than `words * 8`.
 */
function segWords(s: FrameSeg): number {
  if (s instanceof Uint8Array) {
    if (s.byteLength % WORD_BYTES !== 0) {
      throw new CapnpError("FRAMING", "segment not word-aligned");
    }
    return s.byteLength / WORD_BYTES;
  }
  if (!Number.isFinite(s.words) || s.words < 0 || (s.words | 0) !== s.words) {
    throw new CapnpError("FRAMING", "bad segment word count");
  }
  if (s.data.byteLength < s.words * WORD_BYTES) {
    throw new CapnpError("FRAMING", "segment buffer shorter than words*8");
  }
  return s.words;
}

function segBytes(s: FrameSeg, words: number): Uint8Array {
  if (s instanceof Uint8Array) return s;
  return s.data.subarray(0, words * WORD_BYTES);
}

/**
 * Frame segment payloads into a single stream buffer
 * (segment table + concatenated segment bodies).
 *
 * Body cursor always advances by `words * 8` per segment (table sizes),
 * never by the raw buffer length alone — short buffers are rejected above.
 */
export function frameSegments(segs: readonly FrameSeg[]): Uint8Array {
  const nsegs = segs.length;
  if (nsegs === 0) {
    throw new CapnpError("ARG", "empty message");
  }
  if (nsegs > MAX_SEGMENTS) {
    throw new CapnpError(
      "FRAMING",
      `segment count exceeds MAX_SEGMENTS (${MAX_SEGMENTS})`,
    );
  }

  const words: number[] = [];
  let bodyWords = 0;
  for (const s of segs) {
    const w = segWords(s);
    words.push(w);
    bodyWords += w;
  }

  let tableBytes = 4 + 4 * nsegs;
  if (tableBytes % 8 !== 0) tableBytes += 4;

  const total = tableBytes + bodyWords * WORD_BYTES;
  const buf = new Uint8Array(total);

  storeU32(buf, 0, nsegs - 1);
  for (let i = 0; i < nsegs; i++) {
    storeU32(buf, 4 + 4 * i, words[i]!);
  }

  let off = tableBytes;
  for (let i = 0; i < nsegs; i++) {
    const w = words[i]!;
    const nbytes = w * WORD_BYTES;
    if (nbytes) buf.set(segBytes(segs[i]!, w), off);
    // Always advance by declared size, not raw buffer length.
    off += nbytes;
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
