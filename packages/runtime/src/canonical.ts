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
  ElemSize,
  clearTrailingListBits,
  exactProduct,
  listStepBits,
  primitiveBodySize,
  PtrKind,
  WORD_BYTES,
  WireKind,
} from "./kinds.ts";
import { Message, type Ptr } from "./message.ts";
import {
  wpCompositeElementCount,
  wpKind,
  wpListCount,
  wpListEsize,
  wpMakeList,
  wpMakeStruct,
  wpOffset,
  wpStructDwords,
  wpStructPwords,
} from "./pointer.ts";

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
    const seg = src.msg.segs[src.seg]!;
    const s = src.word * WORD_BYTES + (src.bodyByte || 0);
    this.data.set(seg.data.subarray(s, s + nbytes), destWord * WORD_BYTES);
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
  if (depth > src.msg.depthLimit) {
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
    const content = exactProduct(n, step);
    const tagWord = b.alloc(1 + content);
    // Tag word reuses struct layout: offset field holds element count.
    b.storeWord(tagWord, wpMakeStruct(n, nd, np));
    const off = tagWord - slotWord - 1;
    // List count field = content words excluding tag.
    b.storeWord(slotWord, wpMakeList(off, ElemSize.Composite, content));
    const first = tagWord + 1;
    // Zero-sized elements contribute no words. Walking `n` would amplify.
    if (step > 0) {
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
    }
    return;
  }

  if (esize === ElemSize.Pointer) {
    const listStart = b.alloc(n);
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
  const { nbytes, nwords } = primitiveBodySize(n, stepBits);
  const start = b.alloc(nwords);
  if (nwords > 0) {
    const seg = list.msg.segs[list.seg]!;
    const srcOff = list.word * WORD_BYTES;
    b.data.set(
      seg.data.subarray(srcOff, srcOff + nbytes),
      start * WORD_BYTES,
    );
    clearTrailingListBits(b.data, start * WORD_BYTES, n, stepBits);
  }
  const off = start - slotWord - 1;
  b.storeWord(slotWord, wpMakeList(off, esize, n));
}

/**
 * Canonical bytes of a message's root object: one raw segment starting with
 * the root pointer (no segment table). Matches `capnp convert binary:canonical`.
 */
export function canonicalize(
  message: Message,
  limits?: { traversalWords?: number; depthLimit?: number },
): Uint8Array {
  // Fresh Message over the same segment bodies so traversal budget is full
  // and the caller's charge counter is left alone.
  const fresh = Message.fromSegments(message.segments, limits);
  const root = fresh.root();
  const b = new CanonBuilder(Math.max(64, estimateWords(fresh)));
  const rootWord = b.alloc(1);
  // StructReader::canonicalize of a null struct is the empty-struct pointer.
  if (root.kind === PtrKind.Null) {
    b.storeWord(rootWord, wpMakeStruct(-1, 0, 0));
    return b.finish();
  }
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
export function messageFromRawSegment(
  raw: Uint8Array,
  limits?: { traversalWords?: number; depthLimit?: number },
): Message {
  if (raw.byteLength % WORD_BYTES !== 0) {
    throw new CapnpError("FRAMING", "raw segment length not word-aligned");
  }
  if (raw.byteLength === 0) {
    throw new CapnpError("FRAMING", "empty raw segment");
  }
  return Message.fromSegments([raw], limits);
}

/**
 * Cap'n Proto 1.4.0 `MessageReader::isCanonical`: one segment, preorder
 * layout, truncated struct sections, and zero padding in partial list bytes.
 */
export function isCanonical(message: Message): boolean {
  if (message.segmentCount !== 1) return false;
  const words = message.segWords(0);
  if (words < 1) return false;
  const head = { at: 1 };
  if (!pointerCanonical(message, 0, 0, head)) return false;
  return head.at === words;
}

function inRange(m: Message, word: number): boolean {
  return word >= 0 && word < m.segWords(0);
}

function pointerCanonical(
  m: Message,
  seg: number,
  word: number,
  head: { at: number },
): boolean {
  if (!inRange(m, word)) return false;
  const w = m.readWord(seg, word);
  if (w === 0n) return true;
  const kind = wpKind(w);
  if (kind === WireKind.Far || kind === WireKind.Cap) return false;
  const off = wpOffset(w);
  const target = word + 1 + off;
  if (kind === WireKind.Struct) {
    const dw = wpStructDwords(w);
    const pw = wpStructPwords(w);
    if (dw === 0 && pw === 0) return target === word;
    const body = structCanonical(m, seg, target, dw, pw, head, head);
    return body.ok && body.dataTrunc && body.ptrTrunc;
  }
  if (kind === WireKind.List) return listCanonical(m, seg, word, w, target, head);
  return false;
}

function structCanonical(
  m: Message,
  seg: number,
  loc: number,
  dw: number,
  pw: number,
  read: { at: number },
  ptrHead: { at: number },
): { ok: boolean; dataTrunc: boolean; ptrTrunc: boolean } {
  if (loc !== read.at || !inRange(m, loc) || !inRange(m, loc + dw + pw - (dw + pw > 0 ? 1 : 0))) {
    return { ok: false, dataTrunc: false, ptrTrunc: false };
  }
  const dataTrunc = dw === 0 || m.readWord(seg, loc + dw - 1) !== 0n;
  const ptrTrunc = pw === 0 || m.readWord(seg, loc + dw + pw - 1) !== 0n;
  read.at = loc + dw + pw;
  for (let i = 0; i < pw; i++) {
    if (!pointerCanonical(m, seg, loc + dw + i, ptrHead)) {
      return { ok: false, dataTrunc, ptrTrunc };
    }
  }
  return { ok: true, dataTrunc, ptrTrunc };
}

function listCanonical(
  m: Message,
  seg: number,
  _pointerWord: number,
  w: bigint,
  target: number,
  head: { at: number },
): boolean {
  const esize = wpListEsize(w);
  if (esize === ElemSize.Composite) {
    if (target !== head.at || !inRange(m, target)) return false;
    const tag = m.readWord(seg, target);
    if (wpKind(tag) !== WireKind.Struct) return false;
    const dw = wpStructDwords(tag);
    const pw = wpStructPwords(tag);
    const nelem = wpCompositeElementCount(tag);
    const step = dw + pw;
    const content = wpListCount(w);
    if (step === 0) {
      head.at = target + 1;
      return true;
    }
    if (nelem * step !== content) return false;
    const read = { at: target + 1 };
    const pointerHead = { at: target + 1 + content };
    let dataAny = false;
    let ptrAny = false;
    for (let i = 0; i < nelem; i++) {
      const loc = read.at;
      const body = structCanonical(m, seg, loc, dw, pw, read, pointerHead);
      if (!body.ok) return false;
      dataAny = dataAny || body.dataTrunc;
      ptrAny = ptrAny || body.ptrTrunc;
    }
    if (read.at !== target + 1 + content) return false;
    head.at = pointerHead.at;
    return dataAny && ptrAny;
  }
  if (esize === ElemSize.Pointer) {
    const count = wpListCount(w);
    if (target !== head.at) return false;
    head.at = target + count;
    for (let i = 0; i < count; i++) {
      if (!pointerCanonical(m, seg, target + i, head)) return false;
    }
    return true;
  }
  const stepBits = listStepBits(esize);
  if (stepBits < 0) return false;
  if (target !== head.at) return false;
  const count = wpListCount(w);
  const bitSize = BigInt(count) * BigInt(stepBits);
  const wholeBytes = Number(bitSize / 8n);
  const leftover = Number(bitSize % 8n);
  const endWord = head.at + Number((bitSize + 63n) / 64n);
  if (endWord > m.segWords(seg)) return false;
  const data = m.segs[seg]!.data;
  let byte = head.at * WORD_BYTES + wholeBytes;
  if (leftover > 0) {
    const mask = (~((1 << leftover) - 1)) & 0xff;
    if ((data[byte]! & mask) !== 0) return false;
    byte++;
  }
  const endByte = endWord * WORD_BYTES;
  while (byte < endByte) {
    if (data[byte] !== 0) return false;
    byte++;
  }
  head.at = endWord;
  return true;
}
