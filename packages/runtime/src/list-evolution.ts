/**
 * Schema-evolution list upgrade/downgrade views.
 *
 * Cap'n Proto allows a writer and a reader to disagree on whether a list is a
 * primitive list or a list of structs that only use field `@0` (encoding.html
 * "list upgrades"). Parity with Cap'n C++ / capnp-fortran / capnp-janet:
 *
 * | Writer encoded              | Reader asks for                    | API |
 * |-----------------------------|------------------------------------|-----|
 * | List(UInt8/16/32/64)        | List(Struct) scalar @0             | listGetStruct + getU* |
 * | List(pointer) e.g. List(Text)| List(Struct) pointer @0           | listGetStruct + getText/getP |
 * | List(Struct) data word 0    | List(UInt*) field @0               | listGetU8/U16/U32/U64/F64 |
 * | List(Struct) pointer 0      | List(Text) / pointer list          | listGetText |
 *
 * Upgrade views limit `dataBits` to the element width so oversize field reads
 * return the caller default and never spill into the next element.
 *
 * encoding.html: any list element size except bit (C=1) may be decoded as a
 * struct list. List(Void) upgrades to a zero-size struct view. Explicit
 * non-goals (KIND or default, no silent partial):
 * - List(Bool) / bit lists do not upgrade to struct views.
 * - Cross-width primitive demotion without a composite is not supported.
 *
 * Implementation lives on {@link Ptr} in message.ts; this module re-exports
 * free-function aliases matching the janet `capnp_list_get_*` surface.
 */

import type { Ptr } from "./message.ts";

/** Element i as a struct (composite real element, or prim/pointer upgrade). */
export function listGetStruct(list: Ptr, index: number): Ptr {
  return list.listGetStruct(index);
}

/** List(Text) element, or composite downgrade to pointer field @0. */
export function listGetText(list: Ptr, index: number): string {
  return list.listGetText(index);
}

/** Primitive list element, or composite downgrade to field @0. */
export function listGetU8(list: Ptr, index: number, dflt = 0): number {
  return list.listGetU8(index, dflt);
}

export function listGetU16(list: Ptr, index: number, dflt = 0): number {
  return list.listGetU16(index, dflt);
}

export function listGetU32(list: Ptr, index: number, dflt = 0): number {
  return list.listGetU32(index, dflt);
}

export function listGetU64(list: Ptr, index: number, dflt = 0n): bigint {
  return list.listGetU64(index, dflt);
}

export function listGetF64(list: Ptr, index: number, dflt = 0): number {
  return list.listGetF64(index, dflt);
}

/** List(Bool) bit-list element. */
export function listGetBool(list: Ptr, index: number, dflt = false): boolean {
  return list.listGetBool(index, dflt);
}
