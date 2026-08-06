/**
 * Cap'n Proto message reader: stream framing, far resolution, struct/list access.
 *
 * Stream framing (encoding.html):
 *   u32 segmentCountMinusOne
 *   u32 sizes[segmentCount]  (words)
 *   pad to 8-byte boundary
 *   segment0 bytes ...
 */

import {
  bitsToF64,
  f64ToBits,
  loadF64,
  loadU16,
  loadU32,
  loadU64,
  storeU32,
} from "./endian.ts";
import {
  CapnpError,
  DEFAULT_DEPTH_LIMIT,
  DEFAULT_TRAVERSAL_WORDS,
  ElemSize,
  MAX_SEGMENTS,
  PtrKind,
  WORD_BYTES,
  WireKind,
  assertCapnp,
  listStepBits,
} from "./kinds.ts";
import {
  wpFarOff,
  wpFarSeg,
  wpFarTwo,
  wpKind,
  wpListCount,
  wpListEsize,
  wpOffset,
  wpStructDwords,
  wpStructPwords,
} from "./pointer.ts";

export interface SegmentView {
  readonly data: Uint8Array;
  readonly words: number;
}

export type SegmentInput = Uint8Array | SegmentView;

function asView(s: SegmentInput): SegmentView {
  if (s instanceof Uint8Array) {
    assertCapnp(s.byteLength % WORD_BYTES === 0, "FRAMING", "segment not word-aligned");
    return { data: s, words: s.byteLength / WORD_BYTES };
  }
  return s;
}

export class Message {
  /** Internal segment views (data + word count). */
  readonly segs: SegmentView[];
  traversalLeft: number;
  readonly depthLimit: number;
  owned?: Uint8Array;

  private constructor(
    segs: SegmentView[],
    opts?: {
      traversalWords?: number;
      depthLimit?: number;
      owned?: Uint8Array;
    },
  ) {
    this.segs = segs;
    this.traversalLeft = opts?.traversalWords ?? DEFAULT_TRAVERSAL_WORDS;
    this.depthLimit = opts?.depthLimit ?? DEFAULT_DEPTH_LIMIT;
    this.owned = opts?.owned;
  }

  get segmentCount(): number {
    return this.segs.length;
  }

  /**
   * Segment bodies as Uint8Array views (used by serializeToFlat and tests).
   * Each buffer length is words * 8.
   */
  get segments(): Uint8Array[] {
    return this.segs.map((s) => s.data.subarray(0, s.words * WORD_BYTES));
  }

  /** Parse stream-framed message, copying so the input buffer may be reused. */
  static fromFlat(
    data: Uint8Array,
    opts?: { traversalWords?: number; depthLimit?: number },
  ): Message {
    return parseFlat(data, true, opts);
  }

  /** Zero-copy view of stream-framed message; data must outlive the Message. */
  static viewFlat(
    data: Uint8Array,
    opts?: { traversalWords?: number; depthLimit?: number },
  ): Message {
    return parseFlat(data, false, opts);
  }

  /**
   * Attach already-separated segments (no framing). Accepts raw Uint8Array
   * buffers or `{ data, words }` views. Buffers must outlive the Message.
   */
  static fromSegments(
    segs: SegmentInput[],
    opts?: { traversalWords?: number; depthLimit?: number },
  ): Message {
    assertCapnp(segs.length > 0 && segs.length <= MAX_SEGMENTS, "FRAMING");
    const views = segs.map(asView);
    for (let i = 0; i < views.length; i++) {
      const s = views[i]!;
      assertCapnp(s.data && (s.words > 0 || i > 0), "FRAMING");
    }
    return new Message(views, opts);
  }

  root(): Ptr {
    assertCapnp(this.segs.length > 0, "ARG");
    return resolvePtr(this, 0, 0, this.depthLimit);
  }

  /** Word count of segment `seg`. */
  segWords(seg: number): number {
    return this.segs[seg]?.words ?? 0;
  }

  /** Read little-endian u64 at segment/word (no traversal charge). */
  readWord(seg: number, word: number): bigint {
    const s = this.segs[seg];
    assertCapnp(!!s, "SEGMENT");
    assertCapnp(word >= 0 && word < s.words, "BOUNDS");
    return loadU64(s.data, word * WORD_BYTES);
  }

  /** Re-frame segments into a stream buffer. */
  copyFlat(): Uint8Array {
    const segs = this.segs;
    assertCapnp(segs.length > 0, "ARG");
    let bodyWords = 0;
    for (const s of segs) bodyWords += s.words;
    let tableBytes = 4 + 4 * segs.length;
    if (tableBytes % 8 !== 0) tableBytes += 4;
    const buf = new Uint8Array(tableBytes + bodyWords * WORD_BYTES);
    storeU32(buf, 0, segs.length - 1);
    for (let i = 0; i < segs.length; i++) {
      storeU32(buf, 4 + 4 * i, segs[i]!.words);
    }
    let off = tableBytes;
    for (const s of segs) {
      const nbytes = s.words * WORD_BYTES;
      if (nbytes) buf.set(s.data.subarray(0, nbytes), off);
      off += nbytes;
    }
    return buf;
  }

  charge(words: number): void {
    assertCapnp(words <= this.traversalLeft, "TRAVERSAL");
    this.traversalLeft -= words;
  }

  remainingTraversal(): number {
    return this.traversalLeft;
  }
}

function parseFlat(
  data: Uint8Array,
  copy: boolean,
  opts?: { traversalWords?: number; depthLimit?: number },
): Message {
  assertCapnp(data.length >= 8, "FRAMING", "message shorter than 8 bytes");
  const nsegs = loadU32(data, 0) + 1;
  assertCapnp(nsegs > 0 && nsegs <= MAX_SEGMENTS, "FRAMING", `bad nsegs ${nsegs}`);
  let tableBytes = 4 + 4 * nsegs;
  if (tableBytes % 8 !== 0) tableBytes += 4;
  assertCapnp(data.length >= tableBytes, "FRAMING", "truncated segment table");

  const sizes: number[] = [];
  let totalWords = 0;
  for (let i = 0; i < nsegs; i++) {
    const sz = loadU32(data, 4 + 4 * i);
    sizes.push(sz);
    totalWords += sz;
  }
  const body = tableBytes + totalWords * WORD_BYTES;
  assertCapnp(body <= data.length, "FRAMING", "truncated segment body");

  const owned = copy ? data.slice(0, body) : undefined;
  const base = owned ?? data.subarray(0, body);
  const segs: SegmentView[] = [];
  let off = tableBytes;
  for (let i = 0; i < nsegs; i++) {
    const words = sizes[i]!;
    const nbytes = words * WORD_BYTES;
    segs.push({ data: base.subarray(off, off + nbytes), words });
    off += nbytes;
  }
  return new Message(segs, { ...opts, owned });
}

function boundsWord(m: Message, seg: number, word: number): void {
  assertCapnp(seg < m.segs.length, "SEGMENT");
  assertCapnp(word < m.segs[seg]!.words, "BOUNDS");
}

function readWord(m: Message, seg: number, word: number): bigint {
  return loadU64(m.segs[seg]!.data, word * WORD_BYTES);
}

function resolvePtr(m: Message, seg: number, word: number, depth: number): Ptr {
  boundsWord(m, seg, word);
  m.charge(1);
  return resolveWord(m, seg, word, readWord(m, seg, word), depth);
}

function resolveWord(
  m: Message,
  seg: number,
  word: number,
  w: bigint,
  depth: number,
): Ptr {
  if (depth <= 0) throw new CapnpError("DEPTH");
  if (w === 0n) return Ptr.nullPtr(m, seg, word);

  const kind = wpKind(w);
  if (kind === WireKind.Far) {
    const tseg = wpFarSeg(w);
    const toff = wpFarOff(w);
    if (wpFarTwo(w)) {
      boundsWord(m, tseg, toff);
      boundsWord(m, tseg, toff + 1);
      m.charge(2);
      const pad = readWord(m, tseg, toff);
      const tag = readWord(m, tseg, toff + 1);
      assertCapnp(wpKind(pad) === WireKind.Far && !wpFarTwo(pad), "KIND");
      const cseg = wpFarSeg(pad);
      const coff = wpFarOff(pad);
      if (wpKind(tag) === WireKind.Struct) {
        const dwords = wpStructDwords(tag);
        const pwords = wpStructPwords(tag);
        m.charge(dwords + pwords);
        return Ptr.struct(m, cseg, coff, dwords, pwords);
      }
      if (wpKind(tag) === WireKind.List) {
        return finishList(m, cseg, coff, tag);
      }
      throw new CapnpError("KIND");
    }
    boundsWord(m, tseg, toff);
    m.charge(1);
    return resolveWord(m, tseg, toff, readWord(m, tseg, toff), depth - 1);
  }

  if (kind === WireKind.Struct) {
    const off = wpOffset(w);
    const body = word + 1 + off;
    const dwords = wpStructDwords(w);
    const pwords = wpStructPwords(w);
    if (dwords || pwords) {
      const end = body + dwords + pwords;
      boundsWord(m, seg, body);
      if (end > 0) boundsWord(m, seg, end - 1);
    }
    m.charge(dwords + pwords);
    return Ptr.struct(m, seg, body, dwords, pwords);
  }

  if (kind === WireKind.List) {
    const off = wpOffset(w);
    return finishList(m, seg, word + 1 + off, w);
  }

  if (kind === WireKind.Cap) {
    return Ptr.cap(m, seg, word, Number((w >> 32n) & 0xffff_ffffn));
  }
  throw new CapnpError("KIND");
}

function finishList(m: Message, seg: number, start: number, w: bigint): Ptr {
  const esize = wpListEsize(w);
  let count = wpListCount(w);
  if (esize === ElemSize.Composite) {
    boundsWord(m, seg, start);
    m.charge(1);
    const tag = readWord(m, seg, start);
    count = wpOffset(tag) >>> 0;
    const dwords = wpStructDwords(tag);
    const pwords = wpStructPwords(tag);
    const step = dwords + pwords;
    const need = count * step;
    if (need) {
      boundsWord(m, seg, start + 1 + need - 1);
      m.charge(need);
    }
    return Ptr.list(m, seg, start + 1, esize, count, dwords, pwords, step);
  }

  const stepBits = listStepBits(esize);
  if (stepBits < 0) throw new CapnpError("KIND");
  const bits =
    stepBits === 0 ? 0 : stepBits === 1 ? count : count * stepBits;
  const words = (bits + 63) >>> 6;
  if (words) {
    boundsWord(m, seg, start + words - 1);
    m.charge(words);
  }
  return Ptr.list(m, seg, start, esize, count, 0, 0, 0);
}

/** Resolved object handle (struct or list). Never a far landing pad. */
export class Ptr {
  readonly msg: Message;
  readonly seg: number;
  readonly word: number;
  readonly kind: number;
  readonly dwords: number;
  readonly pwords: number;
  readonly esize: number;
  readonly count: number;
  readonly stepWords: number;
  readonly bodyByte: number;
  readonly dataBits: number;

  private constructor(init: {
    msg: Message;
    seg: number;
    word: number;
    kind: number;
    dwords?: number;
    pwords?: number;
    esize?: number;
    count?: number;
    stepWords?: number;
    bodyByte?: number;
    dataBits?: number;
  }) {
    this.msg = init.msg;
    this.seg = init.seg;
    this.word = init.word;
    this.kind = init.kind;
    this.dwords = init.dwords ?? 0;
    this.pwords = init.pwords ?? 0;
    this.esize = init.esize ?? 0;
    this.count = init.count ?? 0;
    this.stepWords = init.stepWords ?? 0;
    this.bodyByte = init.bodyByte ?? 0;
    this.dataBits = init.dataBits ?? 0;
  }

  static nullPtr(msg: Message, seg: number, word: number): Ptr {
    return new Ptr({ msg, seg, word, kind: PtrKind.Null });
  }

  static struct(
    msg: Message,
    seg: number,
    word: number,
    dwords: number,
    pwords: number,
  ): Ptr {
    return new Ptr({ msg, seg, word, kind: PtrKind.Struct, dwords, pwords });
  }

  static list(
    msg: Message,
    seg: number,
    word: number,
    esize: number,
    count: number,
    dwords: number,
    pwords: number,
    stepWords: number,
  ): Ptr {
    return new Ptr({
      msg,
      seg,
      word,
      kind: PtrKind.List,
      esize,
      count,
      dwords,
      pwords,
      stepWords,
    });
  }

  static cap(msg: Message, seg: number, word: number, index: number): Ptr {
    return new Ptr({ msg, seg, word, kind: PtrKind.Cap, count: index });
  }

  get isNull(): boolean {
    return this.kind === PtrKind.Null;
  }

  private dataBitCount(): number {
    if (this.dataBits !== 0) return this.dataBits;
    return this.dwords * 64;
  }

  private dataBytes(): Uint8Array {
    const s = this.msg.segs[this.seg]!;
    return s.data.subarray(this.word * WORD_BYTES + this.bodyByte);
  }

  /**
   * Scalar data-section reads.
   *
   * Cap'n Proto stores each scalar as `wire = logical XOR default` so a zeroed
   * data section yields schema defaults without per-field writes. Pass the
   * field's schema default as `dflt` (codegen does this); omit when default is
   * zero. Past-end / non-struct reads return `dflt` (older-schema evolution).
   * Float defaults XOR the IEEE bit pattern; bool defaults XOR the bit.
   */
  getU8(byteOffset: number, dflt = 0): number {
    if (this.kind !== PtrKind.Struct) return dflt;
    if ((byteOffset + 1) * 8 > this.dataBitCount()) return dflt;
    return (this.dataBytes()[byteOffset]! ^ dflt) & 0xff;
  }

  getU16(byteOffset: number, dflt = 0): number {
    if (this.kind !== PtrKind.Struct) return dflt;
    if ((byteOffset + 2) * 8 > this.dataBitCount()) return dflt;
    return (loadU16(this.dataBytes(), byteOffset) ^ dflt) & 0xffff;
  }

  getU32(byteOffset: number, dflt = 0): number {
    if (this.kind !== PtrKind.Struct) return dflt;
    if ((byteOffset + 4) * 8 > this.dataBitCount()) return dflt;
    return (loadU32(this.dataBytes(), byteOffset) ^ dflt) >>> 0;
  }

  getU64(byteOffset: number, dflt = 0n): bigint {
    if (this.kind !== PtrKind.Struct) return dflt;
    if ((byteOffset + 8) * 8 > this.dataBitCount()) return dflt;
    return loadU64(this.dataBytes(), byteOffset) ^ dflt;
  }

  getF64(byteOffset: number, dflt = 0): number {
    if (this.kind !== PtrKind.Struct) return dflt;
    if ((byteOffset + 8) * 8 > this.dataBitCount()) return dflt;
    const wire = loadU64(this.dataBytes(), byteOffset);
    return bitsToF64(wire ^ f64ToBits(dflt));
  }

  getBool(bitOffset: number, dflt = false): boolean {
    if (this.kind !== PtrKind.Struct) return dflt;
    if (bitOffset >= this.dataBitCount()) return dflt;
    const byteOffset = (bitOffset / 8) | 0;
    const bit = 1 << (bitOffset % 8);
    const wire = (this.dataBytes()[byteOffset]! & bit) !== 0;
    return wire !== dflt;
  }

  /** Resolve struct pointer slot. Out-of-range → null. */
  getP(ptrIndex: number): Ptr {
    assertCapnp(this.kind === PtrKind.Struct, "KIND");
    if (ptrIndex >= this.pwords) {
      return Ptr.nullPtr(this.msg, this.seg, 0);
    }
    return resolvePtr(
      this.msg,
      this.seg,
      this.word + this.dwords + ptrIndex,
      this.msg.depthLimit,
    );
  }

  /** Alias for getP (canonical / C-style naming). */
  getp(ptrIndex: number): Ptr {
    return this.getP(ptrIndex);
  }

  getText(ptrIndex: number): string {
    const list = this.getP(ptrIndex);
    if (list.kind === PtrKind.Null) return "";
    assertCapnp(
      list.kind === PtrKind.List && list.esize === ElemSize.Byte,
      "KIND",
    );
    if (list.count === 0) return "";
    const s = list.msg.segs[list.seg]!;
    const start = list.word * WORD_BYTES;
    let n = list.count;
    if (n > 0 && s.data[start + n - 1] === 0) n -= 1;
    return new TextDecoder().decode(s.data.subarray(start, start + n));
  }

  getData(ptrIndex: number): Uint8Array {
    const list = this.getP(ptrIndex);
    if (list.kind === PtrKind.Null) return new Uint8Array(0);
    assertCapnp(
      list.kind === PtrKind.List && list.esize === ElemSize.Byte,
      "KIND",
    );
    const s = list.msg.segs[list.seg]!;
    const start = list.word * WORD_BYTES;
    return s.data.subarray(start, start + list.count);
  }

  listLen(): number {
    if (this.kind !== PtrKind.List) return 0;
    return this.count;
  }

  listGetP(index: number): Ptr {
    assertCapnp(this.kind === PtrKind.List, "KIND");
    assertCapnp(index < this.count, "BOUNDS");
    if (this.esize === ElemSize.Pointer) {
      return resolvePtr(
        this.msg,
        this.seg,
        this.word + index,
        this.msg.depthLimit,
      );
    }
    if (this.esize === ElemSize.Composite) {
      return Ptr.struct(
        this.msg,
        this.seg,
        this.word + index * this.stepWords,
        this.dwords,
        this.pwords,
      );
    }
    throw new CapnpError("KIND");
  }

  listGetp(index: number): Ptr {
    return this.listGetP(index);
  }

  /**
   * Element i as a struct (schema-evolution list upgrade / composite access).
   *
   * - Composite: real element struct.
   * - Primitive byte/two/four/eight: upgrade view — field @0 is the element;
   *   `dataBits` limits oversize reads so they yield defaults (no neighbour spill).
   * - Pointer list (e.g. List(Text)): upgrade to 0-data / 1-pointer struct.
   * - List(Bool) / List(Void): refuse with KIND (encoding.html list-upgrade rules).
   *
   * Parity: capnp-fortran t_list_upgrade_views, capnp-janet list_evolution.
   */
  listGetStruct(index: number): Ptr {
    assertCapnp(this.kind === PtrKind.List, "KIND");
    assertCapnp(index >= 0 && index < this.count, "BOUNDS");

    if (this.esize === ElemSize.Composite) {
      return Ptr.struct(
        this.msg,
        this.seg,
        this.word + index * this.stepWords,
        this.dwords,
        this.pwords,
      );
    }
    if (this.esize === ElemSize.Pointer) {
      // Upgrade: pointer list element is a 0-data / 1-pointer struct.
      return new Ptr({
        msg: this.msg,
        seg: this.seg,
        word: this.word + index,
        kind: PtrKind.Struct,
        dwords: 0,
        pwords: 1,
      });
    }
    if (this.esize === ElemSize.Void || this.esize === ElemSize.Bit) {
      throw new CapnpError(
        "KIND",
        "List(Bool)/List(Void) cannot upgrade to struct",
      );
    }

    // Primitive data list → synthetic struct with field @0 = the element.
    let elemBytes: number;
    switch (this.esize) {
      case ElemSize.Byte:
        elemBytes = 1;
        break;
      case ElemSize.TwoBytes:
        elemBytes = 2;
        break;
      case ElemSize.FourBytes:
        elemBytes = 4;
        break;
      case ElemSize.EightBytes:
        elemBytes = 8;
        break;
      default:
        throw new CapnpError("KIND");
    }
    const absByte = this.word * WORD_BYTES + index * elemBytes;
    return new Ptr({
      msg: this.msg,
      seg: this.seg,
      word: Math.floor(absByte / WORD_BYTES),
      kind: PtrKind.Struct,
      dwords: 1,
      pwords: 0,
      bodyByte: absByte % WORD_BYTES,
      dataBits: elemBytes * 8,
    });
  }

  listGetText(index: number): string {
    assertCapnp(this.kind === PtrKind.List, "KIND");
    if (this.esize === ElemSize.Pointer) {
      const elem = this.listGetP(index);
      if (elem.kind === PtrKind.Null) return "";
      if (elem.kind === PtrKind.List && elem.esize === ElemSize.Byte) {
        const s = elem.msg.segs[elem.seg]!;
        const start = elem.word * WORD_BYTES;
        let n = elem.count;
        if (n > 0 && s.data[start + n - 1] === 0) n -= 1;
        return new TextDecoder().decode(s.data.subarray(start, start + n));
      }
      throw new CapnpError("KIND");
    }
    if (this.esize === ElemSize.Composite) {
      return this.listGetStruct(index).getText(0);
    }
    throw new CapnpError("KIND");
  }

  private listElemBytes(index: number, elemBytes: number): Uint8Array {
    const s = this.msg.segs[this.seg]!;
    const off = this.word * WORD_BYTES + index * elemBytes;
    return s.data.subarray(off);
  }

  private compositeElemData(index: number): Uint8Array {
    const s = this.msg.segs[this.seg]!;
    const off = (this.word + index * this.stepWords) * WORD_BYTES;
    return s.data.subarray(off);
  }

  listGetU8(index: number, dflt = 0): number {
    if (this.kind !== PtrKind.List || index >= this.count) return dflt;
    if (this.esize === ElemSize.Byte) return this.listElemBytes(index, 1)[0]!;
    if (this.esize === ElemSize.Composite && this.dwords >= 1) {
      return this.compositeElemData(index)[0]!;
    }
    return dflt;
  }

  listGetU16(index: number, dflt = 0): number {
    if (this.kind !== PtrKind.List || index >= this.count) return dflt;
    if (this.esize === ElemSize.TwoBytes) {
      return loadU16(this.listElemBytes(index, 2), 0);
    }
    if (this.esize === ElemSize.Composite && this.dwords >= 1) {
      return loadU16(this.compositeElemData(index), 0);
    }
    return dflt;
  }

  listGetU32(index: number, dflt = 0): number {
    if (this.kind !== PtrKind.List || index >= this.count) return dflt;
    if (this.esize === ElemSize.FourBytes) {
      return loadU32(this.listElemBytes(index, 4), 0);
    }
    if (this.esize === ElemSize.Composite && this.dwords >= 1) {
      return loadU32(this.compositeElemData(index), 0);
    }
    return dflt;
  }

  listGetU64(index: number, dflt = 0n): bigint {
    if (this.kind !== PtrKind.List || index >= this.count) return dflt;
    if (this.esize === ElemSize.EightBytes) {
      return loadU64(this.listElemBytes(index, 8), 0);
    }
    if (this.esize === ElemSize.Composite && this.dwords >= 1) {
      return loadU64(this.compositeElemData(index), 0);
    }
    return dflt;
  }

  listGetF64(index: number, dflt = 0): number {
    if (this.kind !== PtrKind.List || index >= this.count) return dflt;
    if (this.esize === ElemSize.EightBytes) {
      return loadF64(this.listElemBytes(index, 8), 0);
    }
    if (this.esize === ElemSize.Composite && this.dwords >= 1) {
      return loadF64(this.compositeElemData(index), 0);
    }
    return dflt;
  }

  listGetBool(index: number, dflt = false): boolean {
    if (
      this.kind !== PtrKind.List ||
      this.esize !== ElemSize.Bit ||
      index >= this.count
    ) {
      return dflt;
    }
    const base = this.msg.segs[this.seg]!.data;
    const off = this.word * WORD_BYTES + ((index / 8) | 0);
    const bit = 1 << (index % 8);
    return (base[off]! & bit) !== 0;
  }
}

/** Alias for Ptr used by canonical / internal code. */
export { Ptr as CapnpPointer };
