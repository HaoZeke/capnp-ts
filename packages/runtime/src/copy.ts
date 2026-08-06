/**
 * Deep-copy Cap'n pointers into a MessageBuilder (cross-message setp).
 *
 * Mirrors C++ set() / capnp-fortran deep copy / capnp-janet capnp_builder_copy_ptr:
 * allocate objects in the destination arena and recurse into struct/list children.
 * Capability indices are preserved on the wire (no cap table merge yet).
 */

import {
  CapnpError,
  DEFAULT_DEPTH_LIMIT,
  ElemSize,
  PtrKind,
  WORD_BYTES,
  listStepBits,
} from "./kinds.ts";
import type { Ptr } from "./message.ts";
import {
  BuilderPointer,
  MessageBuilder,
  type StructBuilder,
} from "./builder.ts";
import { wpMakeCap, wpMakeStruct } from "./pointer.ts";

/**
 * Deep-copy `src` into the pointer word at `slot`.
 * Allocates new objects in the destination builder arena.
 */
export function deepCopyPtr(
  src: Ptr,
  builder: MessageBuilder,
  slot: BuilderPointer,
  depth = 0,
): void {
  deepCopyPtrToSlot(builder, slot, src, depth);
}

/**
 * Deep-copy `src` into the pointer word at `slot` of `builder`.
 * Allocates new objects in the destination arena.
 */
export function deepCopyPtrToSlot(
  builder: MessageBuilder,
  slot: BuilderPointer,
  src: Ptr,
  depth = 0,
): void {
  if (depth > DEFAULT_DEPTH_LIMIT) {
    throw new CapnpError("DEPTH", "deep-copy depth exceeded");
  }
  if (src.kind === PtrKind.Null) {
    builder.storeW(slot.seg, slot.word, 0n);
    return;
  }
  if (src.kind === PtrKind.Cap) {
    builder.storeW(slot.seg, slot.word, wpMakeCap(src.count));
    return;
  }
  if (src.kind === PtrKind.Struct) {
    copyStruct(builder, slot, src, depth);
    return;
  }
  if (src.kind === PtrKind.List) {
    copyList(builder, slot, src, depth);
    return;
  }
  throw new CapnpError("KIND", "deep-copy: unhandled pointer kind");
}

function copyStructData(
  builder: MessageBuilder,
  destSeg: number,
  destWord: number,
  src: Ptr,
  nd: number,
): void {
  let nbytes = Math.min(nd, src.dwords) * WORD_BYTES;
  if (src.dataBits > 0) {
    nbytes = Math.min(nbytes, (src.dataBits + 7) >>> 3);
  }
  if (nbytes <= 0) return;
  const dest = builder.segBytes(destSeg);
  const srcSeg = src.msg.segs[src.seg]!;
  const srcOff = src.word * WORD_BYTES + (src.bodyByte || 0);
  dest.set(srcSeg.data.subarray(srcOff, srcOff + nbytes), destWord * WORD_BYTES);
}

function copyStruct(
  builder: MessageBuilder,
  slot: BuilderPointer,
  src: Ptr,
  depth: number,
): void {
  const nd = src.dwords;
  const np = src.pwords;
  if (nd === 0 && np === 0) {
    builder.storeW(slot.seg, slot.word, wpMakeStruct(-1, 0, 0));
    return;
  }
  const { seg: bodySeg, word: bodyWord } = builder.allocWords(nd + np);
  builder.writeStructPtr(slot.seg, slot.word, bodySeg, bodyWord, nd, np);
  copyStructData(builder, bodySeg, bodyWord, src, nd);

  for (let k = 0; k < np; k++) {
    const childSlot = new BuilderPointer(builder, bodySeg, bodyWord + nd + k);
    if (k < src.pwords) {
      deepCopyPtrToSlot(builder, childSlot, src.getP(k), depth + 1);
    } else {
      builder.storeW(bodySeg, bodyWord + nd + k, 0n);
    }
  }
}

function copyList(
  builder: MessageBuilder,
  slot: BuilderPointer,
  list: Ptr,
  depth: number,
): void {
  const n = list.count;
  const esize = list.esize;

  if (esize === ElemSize.Composite) {
    const step = list.stepWords || list.dwords + list.pwords;
    const nd = list.dwords;
    const np = list.pwords;
    const contentWords = n * step;
    const need = 1 + contentWords;
    const { seg: tagSeg, word: tagWord } = builder.allocWords(need);
    builder.storeW(tagSeg, tagWord, wpMakeStruct(n | 0, nd, np));
    builder.writeListPtr(
      slot.seg,
      slot.word,
      tagSeg,
      tagWord,
      ElemSize.Composite,
      contentWords,
    );
    for (let i = 0; i < n; i++) {
      const el = list.listGetStruct(i);
      const elWord = tagWord + 1 + i * step;
      copyStructData(builder, tagSeg, elWord, el, nd);
      for (let k = 0; k < np; k++) {
        const cslot = new BuilderPointer(builder, tagSeg, elWord + nd + k);
        if (k < el.pwords) {
          deepCopyPtrToSlot(builder, cslot, el.getP(k), depth + 1);
        } else {
          builder.storeW(tagSeg, elWord + nd + k, 0n);
        }
      }
    }
    return;
  }

  if (esize === ElemSize.Pointer) {
    let listSeg: number;
    let listStart: number;
    if (n > 0) {
      ({ seg: listSeg, word: listStart } = builder.allocWords(n));
    } else {
      listSeg = slot.seg;
      listStart = slot.word + 1;
    }
    builder.writeListPtr(
      slot.seg,
      slot.word,
      listSeg,
      listStart,
      ElemSize.Pointer,
      n,
    );
    for (let i = 0; i < n; i++) {
      deepCopyPtrToSlot(
        builder,
        new BuilderPointer(builder, listSeg, listStart + i),
        list.listGetP(i),
        depth + 1,
      );
    }
    return;
  }

  // Primitive lists (void / bit / byte / two / four / eight): raw payload copy.
  const stepBits = listStepBits(esize);
  if (stepBits < 0) throw new CapnpError("KIND", `bad list esize ${esize}`);
  const bits = stepBits === 0 ? 0 : stepBits === 1 ? n : n * stepBits;
  const nbytes = (bits + 7) >>> 3;
  const nwords = (nbytes + 7) >>> 3;
  let startSeg: number;
  let startWord: number;
  if (nwords > 0) {
    ({ seg: startSeg, word: startWord } = builder.allocWords(nwords));
    const dest = builder.segBytes(startSeg);
    const srcSeg = list.msg.segs[list.seg]!;
    dest.set(
      srcSeg.data.subarray(
        list.word * WORD_BYTES,
        list.word * WORD_BYTES + nbytes,
      ),
      startWord * WORD_BYTES,
    );
  } else {
    startSeg = slot.seg;
    startWord = slot.word + 1;
  }
  builder.writeListPtr(slot.seg, slot.word, startSeg, startWord, esize, n);
}

/** StructBuilder.setP helper: deep-copy a reader pointer into a pointer slot. */
export function structSetP(
  sb: StructBuilder,
  ptrIndex: number,
  src: Ptr,
): void {
  sb.setP(ptrIndex, src);
}
