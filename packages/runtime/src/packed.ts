/**
 * Cap'n Proto packed encoding (encoding.html).
 * Encoder matches Cap'n C++ PackedOutputStream: after tag 0xff, following
 * words with fewer than two zero bytes stay in the verbatim run.
 */

import { CapnpError, WORD_BYTES } from "./kinds.ts";

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

export function pack(input: Uint8Array): Uint8Array {
  if (input.length % WORD_BYTES !== 0) {
    throw new CapnpError("ARG", "pack input length must be multiple of 8");
  }
  const nwords = input.length / WORD_BYTES;
  const out: number[] = [];
  let w = 0;
  while (w < nwords) {
    const base = w * WORD_BYTES;
    let tag = 0;
    let nz = 0;
    for (let k = 0; k < 8; k++) {
      if (input[base + k] !== 0) {
        tag |= 1 << k;
        nz++;
      }
    }
    out.push(tag);
    for (let k = 0; k < 8; k++) {
      if (tag & (1 << k)) out.push(input[base + k]!);
    }
    w++;
    if (tag === 0) {
      let run = 0;
      while (w + run < nwords && run < 255 && wordAllZero(input, (w + run) * WORD_BYTES)) {
        run++;
      }
      out.push(run);
      w += run;
    } else if (nz === 8) {
      let run = 0;
      while (
        w + run < nwords &&
        run < 255 &&
        wordFewerThanTwoZeros(input, (w + run) * WORD_BYTES)
      ) {
        run++;
      }
      out.push(run);
      for (let r = 0; r < run; r++) {
        const o = (w + r) * WORD_BYTES;
        for (let k = 0; k < 8; k++) out.push(input[o + k]!);
      }
      w += run;
    }
  }
  return Uint8Array.from(out);
}

export function unpack(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let ipos = 0;
  while (ipos < input.length) {
    const tag = input[ipos++]!;
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
      for (let i = 0; i < cnt; i++) {
        for (let k = 0; k < 8; k++) out.push(0);
      }
    } else if (tag === 0xff) {
      if (ipos >= input.length) throw new CapnpError("PACKED", "truncated verbatim count");
      const cnt = input[ipos++]!;
      const need = cnt * 8;
      if (ipos + need > input.length) throw new CapnpError("PACKED", "truncated verbatim run");
      for (let i = 0; i < need; i++) out.push(input[ipos++]!);
    }
  }
  return Uint8Array.from(out);
}
