/**
 * Encode and decode 64-bit wire pointer words as bigint.
 * Pure bit manipulation; no segment or arena knowledge.
 *
 * Layouts (bit 0 = least significant), matching capnp-fortran / C++:
 *   struct: kind(0-1)=0 | offset(2-31, signed) | dwords(32-47) | pwords(48-63)
 *   list:   kind(0-1)=1 | offset(2-31, signed) | esize(32-34)  | count(35-63)
 *   far:    kind(0-1)=2 | two(2) | pad word offset(3-31) | segment id(32-63)
 *   cap:    kind(0-1)=3 | zero(2-31) | capability index(32-63)
 */

import { WireKind } from "./kinds.ts";

const MASK_2 = 0x3n;
const MASK_3 = 0x7n;
const MASK_16 = 0xffffn;
const MASK_29 = 0x1fffffffn;
const MASK_30 = 0x3fffffffn;
const MASK_32 = 0xffffffffn;

/** Bits 0-1: wire pointer kind. */
export function kindOf(word: bigint): number {
  return Number(word & MASK_2);
}

/**
 * Signed 30-bit word offset shared by struct and list pointers (bits 2-31).
 */
export function offsetOf(word: bigint): number {
  let u = Number((word >> 2n) & MASK_30);
  // Sign-extend 30-bit two's complement.
  if (u >= 0x2000_0000) u -= 0x4000_0000;
  return u;
}

/** Struct data section size in words (bits 32-47). */
export function structDataWords(word: bigint): number {
  return Number((word >> 32n) & MASK_16);
}

/** Struct pointer section size in words (bits 48-63). */
export function structPointerWords(word: bigint): number {
  return Number((word >> 48n) & MASK_16);
}

/** List element size code (bits 32-34). */
export function listElementSize(word: bigint): number {
  return Number((word >> 32n) & MASK_3);
}

/**
 * List element count, or content word count (tag excluded) for composite lists
 * (bits 35-63, 29 bits).
 */
export function listElementCount(word: bigint): number {
  return Number((word >> 35n) & MASK_29);
}

/** Far pointer double-far flag (bit 2). */
export function farIsDouble(word: bigint): boolean {
  return ((word >> 2n) & 1n) !== 0n;
}

/** Word offset of the landing pad within the target segment (bits 3-31). */
export function farPadOffset(word: bigint): number {
  return Number((word >> 3n) & MASK_29);
}

/** Far pointer target segment id (bits 32-63). */
export function farSegmentId(word: bigint): number {
  return Number((word >> 32n) & MASK_32);
}

/** Capability table index (bits 32-63). */
export function capIndex(word: bigint): number {
  return Number((word >> 32n) & MASK_32);
}

/**
 * Build a struct pointer word.
 * @param offset signed word offset from end of pointer to start of data section
 * @param dataWords data section size in words (0..65535)
 * @param pointerWords pointer section size in words (0..65535)
 */
export function makeStruct(
  offset: number,
  dataWords: number,
  pointerWords: number,
): bigint {
  // kind = 0
  let w = BigInt(offset & 0x3fff_ffff) << 2n;
  w |= BigInt(dataWords & 0xffff) << 32n;
  w |= BigInt(pointerWords & 0xffff) << 48n;
  return w;
}

/**
 * Build a list pointer word.
 * @param offset signed word offset to first element (or tag for composite)
 * @param esize list element size code (0..7)
 * @param count element count, or content words for composite
 */
export function makeList(offset: number, esize: number, count: number | bigint): bigint {
  const c = typeof count === "bigint" ? count : BigInt(count);
  let w = BigInt(WireKind.LIST) | (BigInt(offset & 0x3fff_ffff) << 2n);
  w |= BigInt(esize & 0x7) << 32n;
  w |= (c & MASK_29) << 35n;
  return w;
}

/**
 * Build a far pointer word.
 * @param doubleFar true for double-far (landing pad is far+tag)
 * @param padOffset word offset of landing pad in target segment
 * @param segmentId target segment id
 */
export function makeFar(
  doubleFar: boolean,
  padOffset: number | bigint,
  segmentId: number | bigint,
): bigint {
  const off = typeof padOffset === "bigint" ? padOffset : BigInt(padOffset);
  const seg = typeof segmentId === "bigint" ? segmentId : BigInt(segmentId);
  let w = BigInt(WireKind.FAR);
  if (doubleFar) w |= 4n;
  w |= (off & MASK_29) << 3n;
  w |= (seg & MASK_32) << 32n;
  return w;
}

/** Build a capability pointer word for the given table index. */
export function makeCap(index: number | bigint): bigint {
  const idx = typeof index === "bigint" ? index : BigInt(index);
  return BigInt(WireKind.CAP) | ((idx & MASK_32) << 32n);
}

// --- Fortran-style aliases (parity with capnp_pointer.f90) ---

export const wp_kind = kindOf;
export const wp_offset = offsetOf;
export const wp_struct_dwords = structDataWords;
export const wp_struct_pwords = structPointerWords;
export const wp_list_esize = listElementSize;
export const wp_list_count = listElementCount;
export const wp_far_two = farIsDouble;
export const wp_far_off = farPadOffset;
export const wp_far_seg = farSegmentId;
export const wp_cap_index = capIndex;
export const wp_make_struct = makeStruct;
export const wp_make_list = makeList;
export const wp_make_far = makeFar;
export const wp_make_cap = makeCap;
