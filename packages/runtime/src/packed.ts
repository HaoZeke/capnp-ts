/**
 * Cap'n Proto packed encoding (encoding.html).
 * Encoder matches PackedOutputStream: after tag 0xff, following words with
 * fewer than two zero bytes stay in the verbatim run.
 *
 * A framed message is packed as separate chunks — the segment table, then
 * each segment — because the packed writer issues one write per chunk and a
 * zero or verbatim run does not cross those boundaries.
 */

import { loadU32 } from "./endian.ts";
import {
  CapnpError,
  DEFAULT_TRAVERSAL_WORDS,
  MAX_SEGMENTS,
  WORD_BYTES,
} from "./kinds.ts";
import { Message } from "./message.ts";
import { MessageBuilder } from "./builder.ts";
import { deepCopyPtrToSlot } from "./copy.ts";

/**
 * Max words `unpack` may expand into (default matches reader traversal budget).
 * Blocks packed amplification bombs (e.g. repeated 0x00 0xff zero runs).
 */
export const MAX_UNPACKED_WORDS = DEFAULT_TRAVERSAL_WORDS;

export interface PackOptions {
  /**
   * When true, treat stream-framed message input like `capnp convert`:
   * parse, compact reachable objects into one segment, then pack.
   * Default is false, so `unpack(pack(x))` keeps the input bytes.
   */
  compactFramed?: boolean;
}

function compactFramedMessage(input: Uint8Array): Uint8Array {
  try {
    const msg = Message.fromFlat(input);
    const b = new MessageBuilder({ forceSingle: true });
    deepCopyPtrToSlot(b, b.rootSlot(), msg.root(), 0);
    return b.toFlat();
  } catch {
    // Not a valid framed message (or not compactable under defaults): pack raw bytes.
    return input;
  }
}

function wordAllZero(w: Uint8Array, off: number): boolean {
  for (let i = 0; i < 8; i++) if (w[off + i] !== 0) return false;
  return true;
}

/** C++ heuristic: zero or one zero byte (not two or more). */
function wordFewerThanTwoZeros(w: Uint8Array, off: number): boolean {
  let z = 0;
  for (let i = 0; i < 8; i++) {
    if (w[off + i] === 0) {
      z++;
      if (z >= 2) return false;
    }
  }
  return true;
}

/**
 * Byte ends of the segment table and each segment, when `input` is exactly
 * one stream-framed message. Null when the buffer is not that frame, so raw
 * word buffers keep a single packing run.
 */
function framedPieceEnds(input: Uint8Array): number[] | null {
  if (input.length < WORD_BYTES) return null;
  const nsegs = loadU32(input, 0) + 1;
  if (nsegs <= 0 || nsegs > MAX_SEGMENTS) return null;
  let tableBytes = 4 + 4 * nsegs;
  if (tableBytes % WORD_BYTES !== 0) tableBytes += 4;
  if (tableBytes > input.length) return null;
  let total = BigInt(tableBytes);
  const sizes: number[] = [];
  for (let i = 0; i < nsegs; i++) {
    const sz = loadU32(input, 4 + 4 * i);
    sizes.push(sz);
    total += BigInt(sz) * BigInt(WORD_BYTES);
    if (total > BigInt(input.length)) return null;
  }
  if (total !== BigInt(input.length)) return null;
  const ends: number[] = [tableBytes];
  let off = tableBytes;
  for (const sz of sizes) {
    off += sz * WORD_BYTES;
    ends.push(off);
  }
  return ends;
}

/** Pack words in [byteStart, byteEnd). The range is a multiple of 8. */
function packRange(source: Uint8Array, byteStart: number, byteEnd: number): number[] {
  const out: number[] = [];
  const nwords = (byteEnd - byteStart) / WORD_BYTES;
  let w = 0;
  while (w < nwords) {
    const base = byteStart + w * WORD_BYTES;
    let tag = 0;
    let nz = 0;
    for (let k = 0; k < 8; k++) {
      if (source[base + k] !== 0) {
        tag |= 1 << k;
        nz++;
      }
    }
    out.push(tag);
    for (let k = 0; k < 8; k++) {
      if (tag & (1 << k)) out.push(source[base + k]!);
    }
    w++;
    if (tag === 0) {
      let run = 0;
      while (
        w + run < nwords &&
        run < 255 &&
        wordAllZero(source, byteStart + (w + run) * WORD_BYTES)
      ) {
        run++;
      }
      out.push(run);
      w += run;
    } else if (nz === 8) {
      let run = 0;
      while (
        w + run < nwords &&
        run < 255 &&
        wordFewerThanTwoZeros(source, byteStart + (w + run) * WORD_BYTES)
      ) {
        run++;
      }
      out.push(run);
      for (let r = 0; r < run; r++) {
        const o = byteStart + (w + r) * WORD_BYTES;
        for (let k = 0; k < 8; k++) out.push(source[o + k]!);
      }
      w += run;
    }
  }
  return out;
}

export function pack(input: Uint8Array, opts?: PackOptions): Uint8Array {
  if (input.length % WORD_BYTES !== 0) {
    throw new CapnpError("ARG", "pack input length must be multiple of 8");
  }
  const source = opts?.compactFramed ? compactFramedMessage(input) : input;
  if (source.length % WORD_BYTES !== 0) {
    throw new CapnpError("ARG", "pack source length must be multiple of 8");
  }
  const ends = framedPieceEnds(source);
  const out: number[] = [];
  if (!ends) {
    out.push(...packRange(source, 0, source.length));
  } else {
    let start = 0;
    for (const end of ends) {
      out.push(...packRange(source, start, end));
      start = end;
    }
  }
  return Uint8Array.from(out);
}

/**
 * Unpack a packed Cap'n Proto buffer.
 * @param opts.maxWords Cap on expanded words (default {@link MAX_UNPACKED_WORDS}).
 *   Exceeding the cap throws `CapnpError("PACKED")` before unbounded allocation.
 */
export function unpack(
  input: Uint8Array,
  opts?: { maxWords?: number },
): Uint8Array {
  const maxWords = opts?.maxWords ?? MAX_UNPACKED_WORDS;
  const maxBytes = maxWords * WORD_BYTES;
  const out: number[] = [];
  let ipos = 0;

  const ensure = (extraBytes: number): void => {
    if (out.length + extraBytes > maxBytes) {
      throw new CapnpError("PACKED", "expanded size exceeds word cap");
    }
  };

  while (ipos < input.length) {
    const tag = input[ipos++]!;
    ensure(WORD_BYTES);
    for (let k = 0; k < 8; k++) {
      if (tag & (1 << k)) {
        if (ipos >= input.length) throw new CapnpError("PACKED", "truncated tag payload");
        out.push(input[ipos++]!);
      } else {
        out.push(0);
      }
    }
    if (tag === 0) {
      if (ipos >= input.length) throw new CapnpError("PACKED", "truncated zero run");
      const cnt = input[ipos++]!;
      ensure(cnt * WORD_BYTES);
      for (let i = 0; i < cnt; i++) {
        for (let k = 0; k < 8; k++) out.push(0);
      }
    } else if (tag === 0xff) {
      if (ipos >= input.length) throw new CapnpError("PACKED", "truncated verbatim count");
      const cnt = input[ipos++]!;
      const need = cnt * WORD_BYTES;
      if (ipos + need > input.length) throw new CapnpError("PACKED", "truncated verbatim run");
      ensure(need);
      for (let i = 0; i < need; i++) out.push(input[ipos++]!);
    }
  }
  return Uint8Array.from(out);
}
