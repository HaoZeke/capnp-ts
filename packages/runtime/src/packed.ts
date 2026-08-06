/**
 * Cap'n Proto packing codec (byte-identical to Cap'n C++ PackedOutputStream).
 *
 * After a full tag 0xff, following words with fewer than two zero bytes
 * (zero or one zero) are emitted verbatim with a run-length count.
 * Zero-tag words are followed by a count of additional zero words.
 *
 * Input to pack must be a multiple of 8 bytes (whole words).
 */

function wordAllZero(src: Uint8Array, off: number): boolean {
  return (
    src[off] === 0 &&
    src[off + 1] === 0 &&
    src[off + 2] === 0 &&
    src[off + 3] === 0 &&
    src[off + 4] === 0 &&
    src[off + 5] === 0 &&
    src[off + 6] === 0 &&
    src[off + 7] === 0
  );
}

/** True when the word has 0 or 1 zero bytes (C++ uncompressed-run heuristic). */
function wordFewerThanTwoZeros(src: Uint8Array, off: number): boolean {
  let z = 0;
  for (let k = 0; k < 8; k++) {
    if (src[off + k] === 0) {
      z++;
      if (z >= 2) return false;
    }
  }
  return true;
}

/**
 * Pack Cap'n Proto message words into the packed wire format.
 * @param input Unpacked bytes; length must be a multiple of 8.
 */
export function pack(input: Uint8Array): Uint8Array {
  if (input.length % 8 !== 0) {
    throw new Error(
      `capnp pack: input length ${input.length} is not a multiple of 8`,
    );
  }

  const nwords = input.length / 8;
  // Worst case ~10 bytes/word (tag + 8 payload + optional run count).
  const out = new Uint8Array(nwords === 0 ? 0 : nwords * 10 + 8 * 256);
  let opos = 0;
  let w = 0;

  while (w < nwords) {
    const base = w * 8;
    let tag = 0;
    let nz = 0;
    for (let k = 0; k < 8; k++) {
      const b = input[base + k]!;
      if (b !== 0) {
        tag |= 1 << k;
        nz++;
      }
    }
    out[opos++] = tag;
    for (let k = 0; k < 8; k++) {
      if (tag & (1 << k)) {
        out[opos++] = input[base + k]!;
      }
    }
    w++;

    if (tag === 0) {
      let run = 0;
      while (w + run < nwords && run < 255 && wordAllZero(input, (w + run) * 8)) {
        run++;
      }
      out[opos++] = run;
      w += run;
    } else if (nz === 8) {
      // C++ heuristic: words with 0 or 1 zero byte, up to 255.
      let run = 0;
      while (
        w + run < nwords &&
        run < 255 &&
        wordFewerThanTwoZeros(input, (w + run) * 8)
      ) {
        run++;
      }
      out[opos++] = run;
      if (run > 0) {
        out.set(input.subarray(w * 8, (w + run) * 8), opos);
        opos += run * 8;
        w += run;
      }
    }
  }

  return out.subarray(0, opos);
}

/**
 * Unpack Cap'n Proto packed wire data into message words.
 */
export function unpack(input: Uint8Array): Uint8Array {
  // Packed is usually smaller; grow as needed.
  let cap = Math.max(input.length * 4 + 64, 64);
  let buf = new Uint8Array(cap);
  let ipos = 0;
  let opos = 0;

  const ensure = (need: number): void => {
    if (opos + need <= cap) return;
    let ncap = cap * 2 + 8 * 256;
    while (ncap < opos + need) ncap *= 2;
    const nb = new Uint8Array(ncap);
    nb.set(buf.subarray(0, opos));
    buf = nb;
    cap = ncap;
  };

  while (ipos < input.length) {
    ensure(8 + 255 * 8);
    const tag = input[ipos++]!;
    for (let k = 0; k < 8; k++) {
      if (tag & (1 << k)) {
        if (ipos >= input.length) {
          throw new Error("capnp unpack: truncated packed data (payload byte)");
        }
        buf[opos + k] = input[ipos++]!;
      } else {
        buf[opos + k] = 0;
      }
    }
    opos += 8;

    if (tag === 0) {
      if (ipos >= input.length) {
        throw new Error("capnp unpack: truncated packed data (zero run count)");
      }
      const cnt = input[ipos++]!;
      ensure(cnt * 8);
      // Already zero-filled by new Uint8Array / growth path.
      opos += cnt * 8;
    } else if (tag === 0xff) {
      if (ipos >= input.length) {
        throw new Error("capnp unpack: truncated packed data (ff run count)");
      }
      const cnt = input[ipos++]!;
      if (ipos + cnt * 8 > input.length) {
        throw new Error("capnp unpack: truncated packed data (ff run body)");
      }
      ensure(cnt * 8);
      if (cnt > 0) {
        buf.set(input.subarray(ipos, ipos + cnt * 8), opos);
        ipos += cnt * 8;
        opos += cnt * 8;
      }
    }
  }

  if (opos % 8 !== 0) {
    throw new Error("capnp unpack: output length is not a multiple of 8");
  }

  return buf.subarray(0, opos);
}
