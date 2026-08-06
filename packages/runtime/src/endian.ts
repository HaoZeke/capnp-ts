/**
 * Little-endian scalar load/store for Cap'n wire words.
 * All multi-byte access goes through these so host endianness never leaks.
 */

export function loadU8(buf: Uint8Array, off: number): number {
  return buf[off]!;
}

export function storeU8(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
}

export function loadU16(buf: Uint8Array, off: number): number {
  return buf[off]! | (buf[off + 1]! << 8);
}

export function storeU16(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
}

export function loadU32(buf: Uint8Array, off: number): number {
  return (
    (buf[off]! |
      (buf[off + 1]! << 8) |
      (buf[off + 2]! << 16) |
      (buf[off + 3]! << 24)) >>>
    0
  );
}

export function storeU32(buf: Uint8Array, off: number, v: number): void {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
  buf[off + 2] = (v >>> 16) & 0xff;
  buf[off + 3] = (v >>> 24) & 0xff;
}

/** Unsigned 64-bit; returns bigint in 0n .. 2^64-1. */
export function loadU64(buf: Uint8Array, off: number): bigint {
  const lo = loadU32(buf, off);
  const hi = loadU32(buf, off + 4);
  return BigInt(lo) | (BigInt(hi) << 32n);
}

export function storeU64(buf: Uint8Array, off: number, v: bigint): void {
  storeU32(buf, off, Number(v & 0xffff_ffffn));
  storeU32(buf, off + 4, Number((v >> 32n) & 0xffff_ffffn));
}

export function loadI8(buf: Uint8Array, off: number): number {
  const u = loadU8(buf, off);
  return u > 0x7f ? u - 0x100 : u;
}

export function storeI8(buf: Uint8Array, off: number, v: number): void {
  storeU8(buf, off, v);
}

export function loadI16(buf: Uint8Array, off: number): number {
  const u = loadU16(buf, off);
  return u > 0x7fff ? u - 0x1_0000 : u;
}

export function storeI16(buf: Uint8Array, off: number, v: number): void {
  storeU16(buf, off, v);
}

export function loadI32(buf: Uint8Array, off: number): number {
  return (
    buf[off]! |
    (buf[off + 1]! << 8) |
    (buf[off + 2]! << 16) |
    (buf[off + 3]! << 24)
  );
}

export function storeI32(buf: Uint8Array, off: number, v: number): void {
  storeU32(buf, off, v);
}

export function loadI64(buf: Uint8Array, off: number): bigint {
  const u = loadU64(buf, off);
  // Sign-extend via BigInt64 view of the same bits.
  const tmp = new BigUint64Array([u]);
  return new BigInt64Array(tmp.buffer)[0]!;
}

export function storeI64(buf: Uint8Array, off: number, v: bigint): void {
  storeU64(buf, off, BigInt.asUintN(64, v));
}

export function loadF32(buf: Uint8Array, off: number): number {
  return bitsToF32(loadU32(buf, off));
}

export function storeF32(buf: Uint8Array, off: number, v: number): void {
  storeU32(buf, off, f32ToBits(v));
}

export function loadF64(buf: Uint8Array, off: number): number {
  return bitsToF64(loadU64(buf, off));
}

export function storeF64(buf: Uint8Array, off: number, v: number): void {
  storeU64(buf, off, f64ToBits(v));
}

/** IEEE-754 bit pattern of an f64 (for default XOR on the wire). */
export function f64ToBits(v: number): bigint {
  const f = new Float64Array([v]);
  return new BigUint64Array(f.buffer)[0]!;
}

/** Reconstruct f64 from IEEE-754 bit pattern. */
export function bitsToF64(bits: bigint): number {
  const u = new BigUint64Array([bits]);
  return new Float64Array(u.buffer)[0]!;
}

/** IEEE-754 bit pattern of an f32. */
export function f32ToBits(v: number): number {
  const f = new Float32Array([v]);
  return new Uint32Array(f.buffer)[0]!;
}

/** Reconstruct f32 from IEEE-754 bit pattern. */
export function bitsToF32(bits: number): number {
  const u = new Uint32Array([bits >>> 0]);
  return new Float32Array(u.buffer)[0]!;
}
