/**
 * Cap'n Proto packed encoding (encoding.html).
 * Encoder matches Cap'n C++ PackedOutputStream: after tag 0xff, following
 * words with fewer than two zero bytes stay in the verbatim run.
 */

import {
  CapnpError,
  DEFAULT_TRAVERSAL_WORDS,
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
   * When true (default), treat stream-framed message input like `capnp convert`:
   * parse, compact reachable objects into one segment, then pack.
   * Disable for raw word-stream packing with `compactFramed: false`.
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

export function pack(input: Uint8Array, opts?: PackOptions): Uint8Array {
  if (input.length % WORD_BYTES !== 0) {
    throw new CapnpError("ARG", "pack input length must be multiple of 8");
  }
  const source = opts?.compactFramed === false ? input : compactFramedMessage(input);
  if (source.length % WORD_BYTES !== 0) {
    throw new CapnpError("ARG", "pack source length must be multiple of 8");
  }
  const nwords = source.length / WORD_BYTES;
  const out: number[] = [];
  let w = 0;
  while (w < nwords) {
    const base = w * WORD_BYTES;
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
      while (w + run < nwords && run < 255 && wordAllZero(source, (w + run) * WORD_BYTES)) {
        run++;
      }
      out.push(run);
      w += run;
    } else if (nz === 8) {
      let run = 0;
      while (
        w + run < nwords &&
        run < 255 &&
        wordFewerThanTwoZeros(source, (w + run) * WORD_BYTES)
      ) {
        run++;
      }
      out.push(run);
      for (let r = 0; r < run; r++) {
        const o = (w + r) * WORD_BYTES;
        for (let k = 0; k < 8; k++) out.push(source[o + k]!);
      }
      w += run;
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
