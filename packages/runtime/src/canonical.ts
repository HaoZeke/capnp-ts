/**
 * Cap'n Proto canonical form (encoding.html#canonicalization).
 *
 * Output is a raw single segment: first word is the root pointer, no segment
 * table. Objects are laid out in preorder; struct data and pointer sections
 * drop trailing zero words / null pointers; composite list elements share one
 * uniform trimmed size. Capability pointers are rejected.
 *
 * Algorithm mirrors capnp-janet capnp_canonical.c / capnp-fortran
 * capnp_canonical.f90 (preorder copy into one segment).
 */

import { storeU64 } from "./endian.ts";
import {
  CapnpError,
  DEFAULT_DEPTH_LIMIT,
  ElemSize,
  listStepBits,
  PtrKind,
  WORD_BYTES,
} from "./kinds.ts";
import { Message, Ptr } from "./message.ts";
import { wpMakeList, wpMakeStruct } from "./pointer.ts";

// --- truncation --------------------------------------------------------------

/** Trailing zero words dropped from a struct's data section. */
function trimmedDwords(p: Ptr): number {
  let nd = p.dwords;
  while (nd > 0) {
    if (p.msg.readWord(p.seg, p.word + nd - 1) !== 0n) break;
    nd--;
  }
  return nd;
}

/** Trailing null pointers dropped from a struct's pointer section. */
function trimmedPwords(p: Ptr): number {
  let np = p.pwords;
  while (np > 0) {
    if (p.getP(np - 1).kind !== PtrKind.Null) break;
    np--;
  }
  return np;
}

/**
 * Uniform trimmed element sizes for a composite list: max over all elements
 * (canonical lists share one tag).
 */
function compositeTrim(list: Ptr): { nd: number; np: number } {
  let nd = 0;
  let np = 0;
  for (let i = 0; i < list.count; i++) {
    const el = list.listGetStruct(i);
    const td = trimmedDwords(el);
    const tp = trimmedPwords(el);
    if (td > nd) nd = td;
    if (tp > np) np = tp;
  }
  return { nd, np };
}

// --- single-segment builder --------------------------------------------------

class CanonBuilder {
  data: Uint8Array;
  words = 0;

  constructor(initialWords = 16) {
    this.data = new Uint8Array(Math.max(initialWords, 1) * WORD_BYTES);
  }

  private ensure(needWords: number): void {
    const needBytes = needWords * WORD_BYTES;
    if (needBytes <= this.data.length) return;
    let ncap = this.data.length || WORD_BYTES;
    while (ncap < needBytes) ncap *= 2;
    const next = new Uint8Array(ncap);
    next.set(this.data);
    this.data = next;
  }

  /** Allocate `n` zeroed words; return starting word index. */
  alloc(n: number): number {
    if (n === 0) return this.words;
    this.ensure(this.words + n);
    const start = this.words;
    this.words += n;
    return start;
  }

  storeWord(word: number, v: bigint): void {
    storeU64(this.data, word * WORD_BYTES, v);
  }

  copyBytesFrom(destWord: number, src: Ptr, nbytes: number): void {
    if (nbytes <= 0) return;
    const seg = src.msg.segments[src.seg]!;
    const s = src.word * WORD_BYTES + (src.bodyByte || 0);
    this.data.set(seg.subarray(s, s + nbytes), destWord * WORD_BYTES);
  }

  finish(): Uint8Array {
    return this.data.subarray(0, this.words * WORD_BYTES);
  }
}

function writeStructBodyData(
  b: CanonBuilder,
  bodyWord: number,
  nd: number,
  src: Ptr,
): void {
  let nbytes = Math.min(nd, src.dwords) * WORD_BYTES;
  if (src.dataBits > 0) {
    nbytes = Math.min(nbytes, (src.dataBits + 7) >>> 3);
  }
  b.copyBytesFrom(bodyWord, src, nbytes);
}

function copyPtrToWord(
  b: CanonBuilder,
  slotWord: number,
  src: Ptr,
  depth: number,
): void {
  if (depth > DEFAULT_DEPTH_LIMIT) {
    throw new CapnpError("DEPTH", "canonical copy depth exceeded");
  }
  if (src.kind === PtrKind.Null) {
    b.storeWord(slotWord, 0n);
    return;
  }
  if (src.kind === PtrKind.Cap) {
    throw new CapnpError(
      "CANONICAL",
      "capability pointers have no canonical form",
    );
  }
  if (src.kind === PtrKind.List) {
    writeListToSlot(b, slotWord, src, depth);
    return;
  }
  if (src.kind === PtrKind.Struct) {
    const nd = trimmedDwords(src);
    const np = trimmedPwords(src);
    if (nd === 0 && np === 0) {
      b.storeWord(slotWord, wpMakeStruct(-1, 0, 0));
      return;
    }
    const body = b.alloc(nd + np);
    const off = body - slotWord - 1;
    b.storeWord(slotWord, wpMakeStruct(off, nd, np));
    writeStructBodyData(b, body, nd, src);
    for (let k = 0; k < np; k++) {
      const cslot = body + nd + k;
      if (k < src.pwords) {
        copyPtrToWord(b, cslot, src.getP(k), depth + 1);
      } else {
        b.storeWord(cslot, 0n);
      }
    }
    return;
  }
  throw new CapnpError("KIND", "unhandled pointer kind in canonical copy");
}

function writeListToSlot(
  b: CanonBuilder,
  slotWord: number,
  list: Ptr,
  depth: number,
): void {
  const n = list.count;
  const esize = list.esize;

  if (esize === ElemSize.Composite) {
    const { nd, np } = compositeTrim(list);
    const step = nd + np;
    const content = n * step;
    const tagWord = b.alloc(1 + content);
    // Tag word reuses struct layout: offset field holds element count.
    b.storeWord(tagWord, wpMakeStruct(n, nd, np));
    const off = tagWord - slotWord - 1;
    // List count field = content words excluding tag.
    b.storeWord(slotWord, wpMakeList(off, ElemSize.Composite, content));
    const first = tagWord + 1;
    for (let i = 0; i < n; i++) {
      const el = list.listGetStruct(i);
      writeStructBodyData(b, first + i * step, nd, el);
      for (let k = 0; k < np; k++) {
        const cslot = first + i * step + nd + k;
        if (k < el.pwords) {
          copyPtrToWord(b, cslot, el.getP(k), depth + 1);
        } else {
          b.storeWord(cslot, 0n);
        }
      }
    }
    return;
  }

  if (esize === ElemSize.Pointer) {
    let listStart: number;
    if (n > 0) {
      listStart = b.alloc(n);
    } else {
      listStart = slotWord + 1;
    }
    const off = listStart - slotWord - 1;
    b.storeWord(slotWord, wpMakeList(off, ElemSize.Pointer, n));
    for (let i = 0; i < n; i++) {
      copyPtrToWord(b, listStart + i, list.listGetP(i), depth + 1);
    }
    return;
  }

  // Primitive lists (void / bit / byte / two / four / eight).
  const stepBits = listStepBits(esize);
  if (stepBits < 0) {
    throw new CapnpError("KIND", `bad list esize ${esize}`);
  }
  const bits = stepBits === 0 ? 0 : stepBits === 1 ? n : n * stepBits;
  const nbytes = (bits + 7) >>> 3;
  const nwords = (nbytes + 7) >>> 3;
  let start: number;
  if (nwords > 0) {
    start = b.alloc(nwords);
    const seg = list.msg.segments[list.seg]!;
    const srcOff = list.word * WORD_BYTES;
    b.data.set(seg.subarray(srcOff, srcOff + nbytes), start * WORD_BYTES);
  } else {
    start = slotWord + 1;
  }
  const off = start - slotWord - 1;
  b.storeWord(slotWord, wpMakeList(off, esize, n));
}

/**
 * Canonical bytes of a message's root object: one raw segment starting with
 * the root pointer (no segment table). Matches `capnp convert binary:canonical`.
 */
export function canonicalize(message: Message): Uint8Array {
  // Fresh Message over the same segment buffers so traversal budget is full
  // and the caller's charge counter is left alone.
  const fresh = Message.fromSegments(message.segments);
  const root = fresh.root();
  const b = new CanonBuilder(Math.max(64, estimateWords(fresh)));
  const rootWord = b.alloc(1);
  copyPtrToWord(b, rootWord, root, 0);
  return b.finish();
}

/** Upper bound for output words: sum of segment sizes + root pointer headroom. */
function estimateWords(message: Message): number {
  let n = 1;
  for (const s of message.segments) {
    n += s.byteLength / WORD_BYTES;
  }
  return n;
}

/**
 * Parse a stream-framed Cap'n message and emit canonical raw segment bytes.
 */
export function canonicalizeFlat(framed: Uint8Array): Uint8Array {
  return canonicalize(Message.fromFlat(framed));
}

/**
 * Wrap a raw single-segment payload (no stream table; word 0 is the root
 * pointer) as a Message for canonicalize / readers.
 */
export function messageFromRawSegment(raw: Uint8Array): Message {
  if (raw.byteLength % WORD_BYTES !== 0) {
    throw new CapnpError("FRAMING", "raw segment length not word-aligned");
  }
  if (raw.byteLength === 0) {
    throw new CapnpError("FRAMING", "empty raw segment");
  }
  return Message.fromSegments([raw]);
}
