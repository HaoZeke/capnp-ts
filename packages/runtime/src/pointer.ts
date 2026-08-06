/** Encode / decode 64-bit little-endian Cap'n pointer words. */

import { WireKind } from "./kinds.ts";

export function wpKind(w: bigint): number {
  return Number(w & 3n);
}

/** Signed 30-bit word offset for struct/list pointers. */
export function wpOffset(w: bigint): number {
  let u = Number((w >> 2n) & 0x3fff_ffffn);
  if (u >= 0x2000_0000) u -= 0x4000_0000;
  return u | 0;
}

export function wpStructDwords(w: bigint): number {
  return Number((w >> 32n) & 0xffffn);
}

export function wpStructPwords(w: bigint): number {
  return Number((w >> 48n) & 0xffffn);
}

export function wpListEsize(w: bigint): number {
  return Number((w >> 32n) & 7n);
}

export function wpListCount(w: bigint): number {
  return Number((w >> 35n) & 0x1fff_ffffn);
}

export function wpFarTwo(w: bigint): boolean {
  return ((w >> 2n) & 1n) !== 0n;
}

export function wpFarOff(w: bigint): number {
  return Number((w >> 3n) & 0x1fff_ffffn);
}

export function wpFarSeg(w: bigint): number {
  return Number((w >> 32n) & 0xffff_ffffn);
}

export function wpCapIndex(w: bigint): number {
  return Number((w >> 32n) & 0xffff_ffffn);
}

export function wpMakeStruct(off: number, dwords: number, pwords: number): bigint {
  let w = BigInt(off & 0x3fff_ffff) << 2n;
  w |= BigInt(dwords & 0xffff) << 32n;
  w |= BigInt(pwords & 0xffff) << 48n;
  return w;
}

export function wpMakeList(off: number, esize: number, count: number): bigint {
  let w = 1n | (BigInt(off & 0x3fff_ffff) << 2n);
  w |= BigInt(esize & 7) << 32n;
  w |= BigInt(count & 0x1fff_ffff) << 35n;
  return w;
}

export function wpMakeFar(
  twoWordPad: boolean,
  wordOff: number,
  segId: number,
): bigint {
  let w = BigInt(WireKind.Far);
  if (twoWordPad) w |= 4n;
  w |= BigInt(wordOff & 0x1fff_ffff) << 3n;
  w |= BigInt(segId >>> 0) << 32n;
  return w;
}

export function wpMakeCap(index: number): bigint {
  return 3n | (BigInt(index >>> 0) << 32n);
}

/** Aliases used by some call sites. */
export const makeStruct = wpMakeStruct;
export const makeList = wpMakeList;
export const makeFar = wpMakeFar;
export const makeCap = wpMakeCap;
