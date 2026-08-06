/**
 * Stream-framing encoder: segments -> flat Cap'n Proto message buffer.
 */

import { CapnpError, WORD_BYTES } from "./kinds.ts";
import { storeU32 } from "./endian.ts";
import type { Message } from "./message.ts";

/**
 * Serialize a Message's segments into stream-framed flat bytes
 * (segment table + concatenated segment bodies).
 */
export function serializeToFlat(msg: Message): Uint8Array {
  const nsegs = msg.segments.length;
  if (nsegs === 0) {
    throw new CapnpError("ARG", "empty message");
  }

  let bodyWords = 0;
  for (const s of msg.segments) {
    if (s.byteLength % WORD_BYTES !== 0) {
      throw new CapnpError("FRAMING", "segment not word-aligned");
    }
    bodyWords += s.byteLength / WORD_BYTES;
  }

  let tableBytes = 4 + 4 * nsegs;
  if (tableBytes % 8 !== 0) tableBytes += 4;

  const total = tableBytes + bodyWords * WORD_BYTES;
  const buf = new Uint8Array(total);

  storeU32(buf, 0, nsegs - 1);
  for (let i = 0; i < nsegs; i++) {
    storeU32(buf, 4 + 4 * i, msg.segments[i]!.byteLength / WORD_BYTES);
  }

  let off = tableBytes;
  for (const s of msg.segments) {
    buf.set(s, off);
    off += s.byteLength;
  }
  return buf;
}
