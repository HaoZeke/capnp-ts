/**
 * Raw Text bytes inside JavaScript strings, for byte-exact CLI output.
 *
 * Text may hold bytes that are not valid UTF-8, which a JavaScript string
 * cannot carry. Such a byte b is held as the lone surrogate U+DC00 + b,
 * which valid UTF-8 never decodes to, and is written back as the single
 * byte b by `rawStringToBytes`.
 */

const UTF8_ENC = new TextEncoder();
const UTF8_DEC = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

function isByteSentinel(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdcff;
}

/** Length of the shortest-form UTF-8 sequence at `i`, or 0 when it is invalid. */
export function validUtf8SeqLen(bytes: Uint8Array, i: number): number {
  const b0 = bytes[i]!;
  if (b0 >= 0xc2 && b0 <= 0xdf) {
    return i + 1 < bytes.length && (bytes[i + 1]! & 0xc0) === 0x80 ? 2 : 0;
  }
  if (b0 >= 0xe0 && b0 <= 0xef) {
    if (i + 2 >= bytes.length) return 0;
    const b1 = bytes[i + 1]!;
    const b2 = bytes[i + 2]!;
    if ((b2 & 0xc0) !== 0x80) return 0;
    if (b0 === 0xe0) return b1 >= 0xa0 && b1 <= 0xbf ? 3 : 0;
    if (b0 === 0xed) return b1 >= 0x80 && b1 <= 0x9f ? 3 : 0;
    return (b1 & 0xc0) === 0x80 ? 3 : 0;
  }
  if (b0 >= 0xf0 && b0 <= 0xf4) {
    if (i + 3 >= bytes.length) return 0;
    const b1 = bytes[i + 1]!;
    const b2 = bytes[i + 2]!;
    const b3 = bytes[i + 3]!;
    if ((b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) return 0;
    if (b0 === 0xf0) return b1 >= 0x90 && b1 <= 0xbf ? 4 : 0;
    if (b0 === 0xf4) return b1 >= 0x80 && b1 <= 0x8f ? 4 : 0;
    return (b1 & 0xc0) === 0x80 ? 4 : 0;
  }
  return 0;
}

/** Decode Text bytes, holding each byte outside valid UTF-8 as a sentinel. */
export function rawTextToString(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i]!;
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i++;
      continue;
    }
    const seqLen = validUtf8SeqLen(bytes, i);
    if (seqLen > 0) {
      out += UTF8_DEC.decode(bytes.subarray(i, i + seqLen));
      i += seqLen;
      continue;
    }
    out += String.fromCharCode(0xdc00 + b);
    i++;
  }
  return out;
}

/** UTF-8 encode `text`, writing each sentinel back as its raw byte. */
export function rawStringToBytes(text: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    let chunk: Uint8Array;
    if (isByteSentinel(code)) {
      chunk = Uint8Array.of(code - 0xdc00);
    } else {
      const cp = text.codePointAt(i)!;
      chunk = UTF8_ENC.encode(String.fromCodePoint(cp));
      if (cp > 0xffff) i++;
    }
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.byteLength;
  }
  return out;
}

/** Byte length of `rawStringToBytes(text)`. */
export function rawStringByteLength(text: string): number {
  let size = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isByteSentinel(code)) {
      size++;
      continue;
    }
    const cp = text.codePointAt(i)!;
    size += UTF8_ENC.encode(String.fromCodePoint(cp)).byteLength;
    if (cp > 0xffff) i++;
  }
  return size;
}
