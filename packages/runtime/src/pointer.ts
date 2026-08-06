/**
 * Encode/decode 64-bit Cap'n Proto pointer words (pure bit ops).
 * Layout: https://capnproto.org/encoding.html
 */

import { WireKind } from "./kinds.ts";

const MASK2 = 0x3n;
const MASK3 = 0x7n;
const MASK16 = 0xffffn;
const MASK29 = 0x1fffffffn;
const MASK30 = 0x3fffffffn;
const MASK32 = 0xffffffffn;

export function wpKind(w: bigint): WireKind {
  return Number(w & MASK2) as WireKind;
}

/** Signed 30-bit word offset (struct/list). */
export function wpOffset(w: bigint): number {
  let u = Number((w >> 2n) & MASK30);
  if (u >= 0x2000_0000) u -= 0x4000_0000;
  return u;
}

export function wpStructDwords(w: bigint): number {
  return Number((w >> 32n) & MASK16);
}

export function wpStructPwords(w: bigint): number {
  return Number((w >> 48n) & MASK16);
}

export function wpListEsize(w: bigint): number {
  return Number((w >> 32n) & MASK3);
}

export function wpListCount(w: bigint): number {
  return Number((w >> 35n) & MASK29);
}

export function wpFarTwo(w: bigint): boolean {
  return ((w >> 2n) & 1n) !== 0n;
}

export function wpFarOff(w: bigint): number {
  return Number((w >> 3n) & MASK29);
}

export function wpFarSeg(w: bigint): number {
  return Number((w >> 32n) & MASK32);
}

export function wpCapIndex(w: bigint): number {
  return Number((w >> 32n) & MASK32);
}

export function wpMakeStruct(offset: number, dwords: number, pwords: number): bigint {
  const off = BigInt(offset) & MASK30;
  return (off << 2n) | (BigInt(dwords & 0xffff) << 32n) | (BigInt(pwords & 0xffff) << 48n);
}

export function wpMakeList(offset: number, esize: number, count: number | bigint): bigint {
  const off = BigInt(offset) & MASK30;
  const c = BigInt(count) & MASK29;
  return 1n | (off << 2n) | (BigInt(esize & 7) << 32n) | (c << 35n);
}

export function wpMakeFar(doubleFar: boolean, padWordOff: number, segId: number): bigint {
  let w = 2n;
  if (doubleFar) w |= 4n;
  w |= (BigInt(padWordOff) & MASK29) << 3n;
  w |= (BigInt(segId) & MASK32) << 32n;
  return w;
}

export function wpMakeCap(index: number): bigint {
  return 3n | ((BigInt(index) & MASK32) << 32n);
}
