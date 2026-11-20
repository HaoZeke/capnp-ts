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
  const append = (bytes: readonly number[]): void => {
    for (const byte of bytes) out.push(byte);
  };
  if (!ends) {
    append(packRange(source, 0, source.length));
  } else {
    let start = 0;
    for (const end of ends) {
      append(packRange(source, start, end));
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
/**
 * Unpack one or more packed messages, stopping zero-runs and verbatim runs
 * on the reads InputStreamMessageReader issues: the first table word, the
 * rest of the segment table, then the segment bodies.
 */
function unpackMessages(input: Uint8Array, maxWords: number): Uint8Array {
  const src = new PackedReader(input);
  const out: number[] = [];
  while (src.pos < input.length) {
    const msg = src.readMessage(maxWords - Math.floor(out.length / WORD_BYTES));
    for (const b of msg) out.push(b);
  }
  if (out.length > maxWords * WORD_BYTES) {
    throw new CapnpError("PACKED", "expanded size exceeds word cap");
  }
  return Uint8Array.from(out);
}

class PackedReader {
  pos = 0;

  constructor(private readonly input: Uint8Array) {}

  /** Read exactly `nbytes` (a multiple of 8) using one packed read. */
  readExact(nbytes: number): number[] {
    const out: number[] = [];
    while (out.length < nbytes) {
      if (this.pos >= this.input.length) {
        throw new CapnpError("PACKED", "Premature end of packed input.");
      }
      const tag = this.input[this.pos++]!;
      for (let k = 0; k < 8; k++) {
        if (tag & (1 << k)) {
          if (this.pos >= this.input.length) {
            throw new CapnpError("PACKED", "truncated tag payload");
          }
          out.push(this.input[this.pos++]!);
        } else {
          out.push(0);
        }
      }
      if (out.length > nbytes) {
        throw new CapnpError(
          "PACKED",
          "Packed input did not end cleanly on a segment boundary.",
        );
      }
      if (tag === 0 || tag === 0xff) {
        if (this.pos >= this.input.length) {
          throw new CapnpError("PACKED", tag === 0 ? "truncated zero run" : "truncated verbatim count");
        }
        const cnt = this.input[this.pos++]!;
        const run = cnt * WORD_BYTES;
        if (out.length + run > nbytes) {
          throw new CapnpError(
            "PACKED",
            "Packed input did not end cleanly on a segment boundary.",
          );
        }
        if (tag === 0) {
          for (let i = 0; i < run; i++) out.push(0);
        } else {
          if (this.pos + run > this.input.length) {
            throw new CapnpError("PACKED", "truncated verbatim run");
          }
          for (let i = 0; i < run; i++) out.push(this.input[this.pos++]!);
        }
      }
    }
    return out;
  }

  readMessage(maxWords: number): number[] {
    const first = this.readExact(WORD_BYTES);
    const nsegs = u32(first, 0) + 1;
    if (nsegs <= 0 || nsegs > 511) {
      throw new CapnpError("FRAMING", "Message has too many segments.");
    }
    let total = BigInt(u32(first, 4));
    const parts: number[][] = [first];
    if (nsegs > 1) {
      const restBytes = (nsegs & ~1) * 4;
      const more = this.readExact(restBytes);
      parts.push(more);
      const extra = nsegs - 1;
      for (let i = 0; i < extra; i++) {
        total += BigInt(u32(more, i * 4));
      }
    }
    if (total > BigInt(maxWords)) {
      throw new CapnpError("PACKED", "expanded size exceeds word cap");
    }
    if (total > 0n) parts.push(this.readExact(Number(total) * WORD_BYTES));
    const out: number[] = [];
    for (const p of parts) for (const b of p) out.push(b);
    const words = out.length / WORD_BYTES;
    if (words > maxWords) {
      throw new CapnpError("PACKED", "expanded size exceeds word cap");
    }
    return out;
  }
}

function u32(b: number[], off: number): number {
  return (
    (b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24)) >>>
    0
  );
}

export function unpack(
  input: Uint8Array,
  opts?: { maxWords?: number },
): Uint8Array {
  const maxWords = opts?.maxWords ?? MAX_UNPACKED_WORDS;
  if (input.length > 0) {
    try {
      return unpackMessages(input, maxWords);
    } catch (err) {
      if (
        err instanceof CapnpError &&
        err.message.includes("segment boundary")
      ) {
        throw err;
      }
    }
  }
  return unpackFlat(input, maxWords);
}

function unpackFlat(input: Uint8Array, maxWords: number): Uint8Array {
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
