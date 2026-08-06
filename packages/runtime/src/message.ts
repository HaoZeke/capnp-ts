/**
 * Cap'n Proto message reader: stream framing, far/double-far resolve,
 * struct/list accessors with traversal + depth limits.
 *
 * Wire rules follow encoding.html and the capnp-janet reader.
 */

import {
  CapnpError,
  DEFAULT_DEPTH_LIMIT,
  DEFAULT_TRAVERSAL_WORDS,
  ElemSize,
  MAX_SEGMENTS,
  PtrKind,
  WORD_BYTES,
  WireKind,
} from "./kinds.ts";
import { loadF64, loadU16, loadU32, loadU64, loadU8, storeU32 } from "./endian.ts";
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

/** Segment payload as {data, words} — used by builder/canonical helpers. */
export interface SegmentView {
  readonly data: Uint8Array;
  readonly words: number;
}

export class Message {
  /** Segment payloads (each length multiple of 8). */
  segments: Uint8Array[];
  /** Words remaining for pointer traversal (C++ default: 8 Mi words). */
  traversalLeft: number;
  depthLimit: number;
  /** Owned copy of framed bytes when deserialized via fromFlat. */
  owned?: Uint8Array;

  constructor(
    segments: Uint8Array[] = [],
    opts?: { traversalLeft?: number; depthLimit?: number; owned?: Uint8Array },
  ) {
    this.segments = segments;
    this.traversalLeft = opts?.traversalLeft ?? DEFAULT_TRAVERSAL_WORDS;
    this.depthLimit = opts?.depthLimit ?? DEFAULT_DEPTH_LIMIT;
    this.owned = opts?.owned;
  }

  /** SegmentView projection of `segments` (for builder / older call sites). */
  get segs(): SegmentView[] {
    return this.segments.map((data) => ({
      data,
      words: data.byteLength / WORD_BYTES,
    }));
  }

  get segmentCount(): number {
    return this.segments.length;
  }

  /**
   * Zero-copy view of already-separated segments.
   * Accepts either `Uint8Array[]` or `SegmentView[]`.
   */
  static fromSegments(
    segs: Array<Uint8Array | SegmentView>,
    opts?: { traversalLeft?: number; depthLimit?: number },
  ): Message {
    if (segs.length === 0 || segs.length > MAX_SEGMENTS) {
      throw new CapnpError("FRAMING", "invalid segment count");
    }
    const out: Uint8Array[] = [];
    for (let i = 0; i < segs.length; i++) {
      const raw = segs[i]!;
      const data = raw instanceof Uint8Array ? raw : raw.data;
      const words =
        raw instanceof Uint8Array ? data.byteLength / WORD_BYTES : raw.words;
      if (data.byteLength < words * WORD_BYTES) {
        throw new CapnpError("FRAMING", "segment buffer shorter than words");
      }
      if (words === 0 && i === 0) {
        throw new CapnpError("FRAMING", "empty first segment");
      }
      // Slice to exact word length so byteLength matches words.
      out.push(data.subarray(0, words * WORD_BYTES));
    }
    return new Message(out, opts);
  }

  /** Parse stream framing and copy into owned storage. */
  static fromFlat(bytes: Uint8Array): Message {
    return parseFlat(bytes, true);
  }

  /** Zero-copy stream-framed view; `bytes` must outlive the Message. */
  static viewFlat(bytes: Uint8Array): Message {
    return parseFlat(bytes, false);
  }

  /** Root object: resolve pointer at segment 0 word 0. */
  root(): Ptr {
    if (this.segments.length === 0) {
      throw new CapnpError("ARG", "empty message");
    }
    return resolvePtr(this, 0, 0, this.depthLimit);
  }

  segWords(seg: number): number {
    const s = this.segments[seg];
    if (!s) return 0;
    return s.byteLength / WORD_BYTES;
  }

  readWord(seg: number, word: number): bigint {
    const s = this.segments[seg];
    if (!s) throw new CapnpError("SEGMENT");
    return loadU64(s, word * WORD_BYTES);
  }

  /** Charge traversal budget. */
  charge(words: number): void {
    if (words > this.traversalLeft) {
      throw new CapnpError("TRAVERSAL", "traversal limit exceeded");
    }
    this.traversalLeft -= words;
  }

  remainingTraversal(): number {
    return this.traversalLeft;
  }

  /** Re-frame segments into a stream buffer. */
  copyFlat(): Uint8Array {
    return frameSegments(this.segs);
  }
}

/**
 * Encode segments as a stream-framed Cap'n Proto buffer.
 * Accepts SegmentView[] or Message.segs.
 */
export function frameSegments(segs: readonly SegmentView[]): Uint8Array {
  if (segs.length === 0) {
    throw new CapnpError("ARG", "empty message");
  }
  let bodyWords = 0;
  for (const s of segs) bodyWords += s.words;
  let tableBytes = 4 + 4 * segs.length;
  if (tableBytes % 8 !== 0) tableBytes += 4;
  const total = tableBytes + bodyWords * WORD_BYTES;
  const buf = new Uint8Array(total);
  // storeU32 via direct LE writes (endian helper)
  const store32 = (off: number, v: number) => {
    buf[off] = v & 0xff;
    buf[off + 1] = (v >>> 8) & 0xff;
    buf[off + 2] = (v >>> 16) & 0xff;
    buf[off + 3] = (v >>> 24) & 0xff;
  };
  store32(0, segs.length - 1);
  for (let i = 0; i < segs.length; i++) {
    store32(4 + 4 * i, segs[i]!.words);
  }
  let off = tableBytes;
  for (const s of segs) {
    const nbytes = s.words * WORD_BYTES;
    if (nbytes) buf.set(s.data.subarray(0, nbytes), off);
    off += nbytes;
  }
  return buf;
}

/**
 * Resolved object handle (struct, list, null, or capability).
 * Never a far landing pad.
 */
export class Ptr {
  msg: Message;
  seg: number;
  /** Word offset of content (struct body / list start / after composite tag). */
  word: number;
  kind: PtrKind;
  dwords: number;
  pwords: number;
  esize: number;
  count: number;
  stepWords: number;
  /** Extra byte offset within the body word (primitive-list upgrade views). */
  bodyByte: number;
  /** If non-zero, data-section size in bits (field @0 upgrade views). */
  dataBits: number;

  constructor(init?: Partial<Ptr> & { msg: Message }) {
    this.msg = init?.msg ?? (null as unknown as Message);
    this.seg = init?.seg ?? 0;
    this.word = init?.word ?? 0;
    this.kind = init?.kind ?? PtrKind.Null;
    this.dwords = init?.dwords ?? 0;
    this.pwords = init?.pwords ?? 0;
    this.esize = init?.esize ?? 0;
    this.count = init?.count ?? 0;
    this.stepWords = init?.stepWords ?? 0;
    this.bodyByte = init?.bodyByte ?? 0;
    this.dataBits = init?.dataBits ?? 0;
  }

  get isNull(): boolean {
    return this.kind === PtrKind.Null;
  }

  /** Read pointer slot @ptrIndex from a struct. Past end -> null. */
  getP(ptrIndex: number): Ptr {
    if (this.kind !== PtrKind.Struct) {
      throw new CapnpError("KIND", "getP on non-struct");
    }
    if (ptrIndex >= this.pwords) {
      return nullPtr(this.msg, this.seg);
    }
    const word = this.word + this.dwords + ptrIndex;
    return resolvePtr(this.msg, this.seg, word, this.msg.depthLimit);
  }

  /** Alias used by some call sites. */
  getp(ptrIndex: number): Ptr {
    return this.getP(ptrIndex);
  }

  getU8(byteOffset: number, dflt = 0): number {
    if (this.kind !== PtrKind.Struct) return dflt;
    if ((byteOffset + 1) * 8 > dataBitCount(this)) return dflt;
    return loadU8(dataBytes(this), byteOffset);
  }

  getU16(byteOffset: number, dflt = 0): number {
    if (this.kind !== PtrKind.Struct) return dflt;
    if ((byteOffset + 2) * 8 > dataBitCount(this)) return dflt;
    return loadU16(dataBytes(this), byteOffset);
  }

  getU32(byteOffset: number, dflt = 0): number {
    if (this.kind !== PtrKind.Struct) return dflt;
    if ((byteOffset + 4) * 8 > dataBitCount(this)) return dflt;
    return loadU32(dataBytes(this), byteOffset);
  }

  getU64(byteOffset: number, dflt: bigint = 0n): bigint {
    if (this.kind !== PtrKind.Struct) return dflt;
    if ((byteOffset + 8) * 8 > dataBitCount(this)) return dflt;
    return loadU64(dataBytes(this), byteOffset);
  }

  getF64(byteOffset: number, dflt = 0): number {
    if (this.kind !== PtrKind.Struct) return dflt;
    if ((byteOffset + 8) * 8 > dataBitCount(this)) return dflt;
    return loadF64(dataBytes(this), byteOffset);
  }

  getBool(bitOffset: number, dflt = false): boolean {
    if (this.kind !== PtrKind.Struct) return dflt;
    if (bitOffset >= dataBitCount(this)) return dflt;
    const byteOffset = (bitOffset / 8) | 0;
    const bit = 1 << (bitOffset % 8);
    return (dataBytes(this)[byteOffset]! & bit) !== 0;
  }

  /**
   * Text at pointer slot: List(UInt8) with trailing NUL counted on the wire.
   * Returns decoded string without the NUL.
   */
  getText(ptrIndex: number): string {
    const list = this.getP(ptrIndex);
    if (list.kind === PtrKind.Null) return "";
    if (list.kind !== PtrKind.List || list.esize !== ElemSize.Byte) {
      throw new CapnpError("KIND", "text field is not List(UInt8)");
    }
    if (list.count === 0) return "";
    const seg = list.msg.segments[list.seg]!;
    const start = list.word * WORD_BYTES;
    let n = list.count;
    if (n > 0 && seg[start + n - 1] === 0) n -= 1;
    return new TextDecoder().decode(seg.subarray(start, start + n));
  }

  /**
   * Data at pointer slot: List(UInt8), length includes all bytes (no NUL strip).
   */
  getData(ptrIndex: number): Uint8Array | null {
    const list = this.getP(ptrIndex);
    if (list.kind === PtrKind.Null) return null;
    if (list.kind !== PtrKind.List || list.esize !== ElemSize.Byte) {
      throw new CapnpError("KIND", "data field is not List(UInt8)");
    }
    const seg = list.msg.segments[list.seg]!;
    const start = list.word * WORD_BYTES;
    return seg.subarray(start, start + list.count);
  }

  listLen(): number {
    if (this.kind !== PtrKind.List) return 0;
    return this.count;
  }

  /**
   * Element as pointer/struct:
   * - esize Pointer: resolve the pointer word
   * - esize Composite: struct view of the element
   */
  listGetP(index: number): Ptr {
    if (this.kind !== PtrKind.List) {
      throw new CapnpError("KIND", "listGetP on non-list");
    }
    if (index >= this.count) {
      throw new CapnpError("BOUNDS", "list index out of range");
    }
    if (this.esize === ElemSize.Pointer) {
      return resolvePtr(this.msg, this.seg, this.word + index, this.msg.depthLimit);
    }
    if (this.esize === ElemSize.Composite) {
      return new Ptr({
        msg: this.msg,
        seg: this.seg,
        word: this.word + index * this.stepWords,
        kind: PtrKind.Struct,
        dwords: this.dwords,
        pwords: this.pwords,
      });
    }
    throw new CapnpError("KIND", "listGetP requires pointer or composite list");
  }

  listGetp(index: number): Ptr {
    return this.listGetP(index);
  }

  /**
   * List(Text): pointer list (esize=6) of Text blobs, or composite upgrade
   * (struct with Text at pointer 0).
   */
  listGetText(index: number): string {
    if (this.kind !== PtrKind.List) {
      throw new CapnpError("KIND", "listGetText on non-list");
    }
    if (this.esize === ElemSize.Pointer) {
      const elem = this.listGetP(index);
      if (elem.kind === PtrKind.Null) return "";
      if (elem.kind === PtrKind.List && elem.esize === ElemSize.Byte) {
        const seg = elem.msg.segments[elem.seg]!;
        const start = elem.word * WORD_BYTES;
        let n = elem.count;
        if (n > 0 && seg[start + n - 1] === 0) n -= 1;
        return new TextDecoder().decode(seg.subarray(start, start + n));
      }
      throw new CapnpError("KIND", "List(Text) element is not Text");
    }
    if (this.esize === ElemSize.Composite) {
      const elem = this.listGetP(index);
      if (elem.kind !== PtrKind.Struct) {
        throw new CapnpError("KIND", "composite List(Text) element not struct");
      }
      return elem.getText(0);
    }
    throw new CapnpError("KIND", "listGetText requires pointer or composite list");
  }

  listGetU8(index: number, dflt = 0): number {
    if (this.kind !== PtrKind.List || index >= this.count) return dflt;
    if (this.esize === ElemSize.Byte) {
      return loadU8(listElemBytes(this, index, 1), 0);
    }
    if (this.esize === ElemSize.Composite && this.dwords >= 1) {
      return loadU8(compositeElemData(this, index), 0);
    }
    return dflt;
  }

  listGetU16(index: number, dflt = 0): number {
    if (this.kind !== PtrKind.List || index >= this.count) return dflt;
    if (this.esize === ElemSize.TwoBytes) {
      return loadU16(listElemBytes(this, index, 2), 0);
    }
    if (this.esize === ElemSize.Composite && this.dwords >= 1) {
      return loadU16(compositeElemData(this, index), 0);
    }
    return dflt;
  }

  listGetU32(index: number, dflt = 0): number {
    if (this.kind !== PtrKind.List || index >= this.count) return dflt;
    if (this.esize === ElemSize.FourBytes) {
      return loadU32(listElemBytes(this, index, 4), 0);
    }
    if (this.esize === ElemSize.Composite && this.dwords >= 1) {
      return loadU32(compositeElemData(this, index), 0);
    }
    return dflt;
  }

  listGetU64(index: number, dflt: bigint = 0n): bigint {
    if (this.kind !== PtrKind.List || index >= this.count) return dflt;
    if (this.esize === ElemSize.EightBytes) {
      return loadU64(listElemBytes(this, index, 8), 0);
    }
    if (this.esize === ElemSize.Composite && this.dwords >= 1) {
      return loadU64(compositeElemData(this, index), 0);
    }
    return dflt;
  }

  listGetF64(index: number, dflt = 0): number {
    if (this.kind !== PtrKind.List || index >= this.count) return dflt;
    if (this.esize === ElemSize.EightBytes) {
      return loadF64(listElemBytes(this, index, 8), 0);
    }
    if (this.esize === ElemSize.Composite && this.dwords >= 1) {
      return loadF64(compositeElemData(this, index), 0);
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
    const seg = this.msg.segments[this.seg]!;
    const base = this.word * WORD_BYTES;
    const bit = 1 << (index % 8);
    return (seg[base + ((index / 8) | 0)]! & bit) !== 0;
  }

  /**
   * Element i as a struct. Composite lists return the real element.
   * Primitive/pointer lists return a schema-evolution upgrade view.
   */
  listGetStruct(index: number): Ptr {
    if (this.kind !== PtrKind.List) {
      throw new CapnpError("KIND", "listGetStruct on non-list");
    }
    if (index >= this.count) {
      throw new CapnpError("BOUNDS", "list index out of range");
    }

    switch (this.esize) {
      case ElemSize.Composite:
        return new Ptr({
          msg: this.msg,
          seg: this.seg,
          word: this.word + index * this.stepWords,
          kind: PtrKind.Struct,
          dwords: this.dwords,
          pwords: this.pwords,
        });

      case ElemSize.Pointer:
        return new Ptr({
          msg: this.msg,
          seg: this.seg,
          word: this.word + index,
          kind: PtrKind.Struct,
          dwords: 0,
          pwords: 1,
        });

      case ElemSize.Byte:
      case ElemSize.TwoBytes:
      case ElemSize.FourBytes:
      case ElemSize.EightBytes: {
        const elemBytes =
          this.esize === ElemSize.Byte
            ? 1
            : this.esize === ElemSize.TwoBytes
              ? 2
              : this.esize === ElemSize.FourBytes
                ? 4
                : 8;
        const absByte = this.word * WORD_BYTES + index * elemBytes;
        return new Ptr({
          msg: this.msg,
          seg: this.seg,
          word: (absByte / WORD_BYTES) | 0,
          kind: PtrKind.Struct,
          dwords: 1,
          pwords: 0,
          bodyByte: absByte % WORD_BYTES,
          dataBits: elemBytes * 8,
        });
      }

      case ElemSize.Void:
      case ElemSize.Bit:
        // encoding.html list-upgrade rules: List(Bool)/List(Void) refuse.
        throw new CapnpError(
          "KIND",
          "List(Bool)/List(Void) cannot upgrade to struct",
        );

      default:
        throw new CapnpError("KIND", `list esize ${this.esize} cannot upgrade`);
    }
  }
}

/** Alias for call sites that used CapnpPointer. */
export { Ptr as CapnpPointer };

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/** One segment payload for framing helpers (byte view + word count). */
export interface SegmentView {
  readonly data: Uint8Array;
  readonly words: number;
}

/**
 * Encode segment payloads as a stream-framed Cap'n Proto buffer
 * (segment table + concatenated bodies). Accepts `Uint8Array` segments
 * or `{ data, words }` views (builder path).
 */
export function frameSegments(
  segs: readonly Uint8Array[] | readonly SegmentView[],
): Uint8Array {
  const n = segs.length;
  if (n < 1 || n > MAX_SEGMENTS) {
    throw new CapnpError("FRAMING", `bad segment count ${n}`);
  }

  const payloads: Uint8Array[] = new Array(n);
  const sizes: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const s = segs[i]!;
    if (s instanceof Uint8Array) {
      if (s.byteLength % WORD_BYTES !== 0) {
        throw new CapnpError("FRAMING", "segment not word-aligned");
      }
      payloads[i] = s;
      sizes[i] = s.byteLength / WORD_BYTES;
    } else {
      const words = s.words;
      const need = words * WORD_BYTES;
      if (s.data.byteLength < need) {
        throw new CapnpError("FRAMING", "segment view shorter than word count");
      }
      payloads[i] = s.data.subarray(0, need);
      sizes[i] = words;
    }
  }

  let headerBytes = (1 + n) * 4;
  if (headerBytes % 8 !== 0) headerBytes += 4;

  let total = headerBytes;
  for (const p of payloads) total += p.byteLength;

  const out = new Uint8Array(total);
  storeU32(out, 0, n - 1);
  for (let i = 0; i < n; i++) {
    storeU32(out, 4 + 4 * i, sizes[i]!);
  }
  let pos = headerBytes;
  for (const p of payloads) {
    out.set(p, pos);
    pos += p.byteLength;
  }
  return out;
}

/*
 * Stream framing:
 *   u32 segmentCountMinusOne
 *   u32 sizes[segmentCount]   (in words)
 *   pad to 8-byte boundary
 *   segment0 bytes ...
 */
function parseFlat(data: Uint8Array, copy: boolean): Message {
  if (data.byteLength < 8) {
    throw new CapnpError("FRAMING", "message shorter than framing header");
  }
  const nsegs = loadU32(data, 0) + 1;
  if (nsegs === 0 || nsegs > MAX_SEGMENTS) {
    throw new CapnpError("FRAMING", `segment count ${nsegs} out of range`);
  }
  let tableBytes = 4 + 4 * nsegs;
  if (tableBytes % 8 !== 0) tableBytes += 4;
  if (data.byteLength < tableBytes) {
    throw new CapnpError("FRAMING", "truncated segment table");
  }

  const sizes: number[] = [];
  let totalWords = 0;
  for (let i = 0; i < nsegs; i++) {
    const sz = loadU32(data, 4 + 4 * i);
    sizes.push(sz);
    totalWords += sz;
  }
  const body = tableBytes + totalWords * WORD_BYTES;
  if (body > data.byteLength) {
    throw new CapnpError("FRAMING", "truncated segment body");
  }

  let base: Uint8Array;
  let owned: Uint8Array | undefined;
  if (copy) {
    owned = data.slice(0, body);
    base = owned;
  } else {
    base = data.subarray(0, body);
  }

  let off = tableBytes;
  const segs: Uint8Array[] = [];
  for (let i = 0; i < nsegs; i++) {
    const nbytes = sizes[i]! * WORD_BYTES;
    segs.push(base.subarray(off, off + nbytes));
    off += nbytes;
  }
  return new Message(segs, { owned });
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

function nullPtr(msg: Message, seg: number): Ptr {
  return new Ptr({
    msg,
    seg,
    word: 0,
    kind: PtrKind.Null,
  });
}

function boundsWord(m: Message, seg: number, word: number): void {
  if (seg >= m.segments.length) {
    throw new CapnpError("SEGMENT", `segment ${seg} missing`);
  }
  if (word < 0 || word >= m.segWords(seg)) {
    throw new CapnpError("BOUNDS", `word ${word} out of segment ${seg}`);
  }
}

function resolvePtr(m: Message, seg: number, word: number, depth: number): Ptr {
  boundsWord(m, seg, word);
  m.charge(1);
  const w = m.readWord(seg, word);
  return resolveWord(m, seg, word, w, depth);
}

function resolveWord(
  m: Message,
  seg: number,
  word: number,
  w: bigint,
  depth: number,
): Ptr {
  if (depth <= 0) {
    throw new CapnpError("DEPTH", "pointer depth limit exceeded");
  }
  if (w === 0n) {
    return nullPtr(m, seg);
  }

  const kind = wpKind(w);

  if (kind === WireKind.Far) {
    const tseg = wpFarSeg(w);
    const toff = wpFarOff(w);
    if (wpFarTwo(w)) {
      // double-far: landing pad is two words in tseg
      boundsWord(m, tseg, toff);
      boundsWord(m, tseg, toff + 1);
      m.charge(2);
      const pad = m.readWord(tseg, toff);
      const tag = m.readWord(tseg, toff + 1);
      if (wpKind(pad) !== WireKind.Far || wpFarTwo(pad)) {
        throw new CapnpError("KIND", "invalid double-far landing pad");
      }
      const cseg = wpFarSeg(pad);
      const coff = wpFarOff(pad);
      if (wpKind(tag) === WireKind.Struct) {
        const out = new Ptr({
          msg: m,
          seg: cseg,
          word: coff,
          kind: PtrKind.Struct,
          dwords: wpStructDwords(tag),
          pwords: wpStructPwords(tag),
        });
        m.charge(out.dwords + out.pwords);
        return out;
      }
      if (wpKind(tag) === WireKind.List) {
        const out = new Ptr({
          msg: m,
          seg: cseg,
          word: coff,
          kind: PtrKind.List,
          esize: wpListEsize(tag),
          count: wpListCount(tag),
        });
        if (out.esize === ElemSize.Composite) {
          boundsWord(m, cseg, coff);
          const t = m.readWord(cseg, coff);
          out.count = wpOffset(t) >>> 0;
          out.dwords = wpStructDwords(t);
          out.pwords = wpStructPwords(t);
          out.stepWords = out.dwords + out.pwords;
          out.word = coff + 1;
          m.charge(1 + out.count * out.stepWords);
        }
        return out;
      }
      throw new CapnpError("KIND", "double-far tag not struct/list");
    }
    // single far: one word landing pad is the real pointer
    boundsWord(m, tseg, toff);
    m.charge(1);
    const land = m.readWord(tseg, toff);
    return resolveWord(m, tseg, toff, land, depth - 1);
  }

  if (kind === WireKind.Struct) {
    const off = wpOffset(w);
    const body = word + 1 + off;
    const out = new Ptr({
      msg: m,
      seg,
      word: body,
      kind: PtrKind.Struct,
      dwords: wpStructDwords(w),
      pwords: wpStructPwords(w),
    });
    if (out.dwords || out.pwords) {
      const end = body + out.dwords + out.pwords;
      boundsWord(m, seg, body);
      if (end > 0) boundsWord(m, seg, end - 1);
    }
    m.charge(out.dwords + out.pwords);
    return out;
  }

  if (kind === WireKind.List) {
    const off = wpOffset(w);
    const start = word + 1 + off;
    const out = new Ptr({
      msg: m,
      seg,
      word: start,
      kind: PtrKind.List,
      esize: wpListEsize(w),
      count: wpListCount(w),
    });
    if (out.esize === ElemSize.Composite) {
      boundsWord(m, seg, start);
      m.charge(1);
      const tag = m.readWord(seg, start);
      // list count field was words of content excl. tag; tag carries elem count
      out.count = wpOffset(tag) >>> 0;
      out.dwords = wpStructDwords(tag);
      out.pwords = wpStructPwords(tag);
      out.stepWords = out.dwords + out.pwords;
      out.word = start + 1;
      const need = out.count * out.stepWords;
      if (need) boundsWord(m, seg, out.word + need - 1);
      m.charge(need);
      return out;
    }
    let bits = 0;
    switch (out.esize) {
      case ElemSize.Void:
        bits = 0;
        break;
      case ElemSize.Bit:
        bits = out.count;
        break;
      case ElemSize.Byte:
        bits = out.count * 8;
        break;
      case ElemSize.TwoBytes:
        bits = out.count * 16;
        break;
      case ElemSize.FourBytes:
        bits = out.count * 32;
        break;
      case ElemSize.EightBytes:
      case ElemSize.Pointer:
        bits = out.count * 64;
        break;
      default:
        throw new CapnpError("KIND", `unknown list esize ${out.esize}`);
    }
    const words = (bits + 63) >>> 6;
    if (words) boundsWord(m, seg, start + words - 1);
    m.charge(words);
    return out;
  }

  if (kind === WireKind.Cap) {
    return new Ptr({
      msg: m,
      seg,
      word,
      kind: PtrKind.Cap,
      count: Number((w >> 32n) & 0xffffffffn),
    });
  }

  throw new CapnpError("KIND", `unknown wire kind ${kind}`);
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

function dataBitCount(s: Ptr): number {
  if (s.dataBits !== 0) return s.dataBits;
  return s.dwords * 64;
}

function dataBytes(s: Ptr): Uint8Array {
  const seg = s.msg.segments[s.seg]!;
  const start = s.word * WORD_BYTES + s.bodyByte;
  return seg.subarray(start);
}

function listElemBytes(list: Ptr, index: number, elemBytes: number): Uint8Array {
  const seg = list.msg.segments[list.seg]!;
  const start = list.word * WORD_BYTES + index * elemBytes;
  return seg.subarray(start, start + elemBytes);
}

function compositeElemData(list: Ptr, index: number): Uint8Array {
  const seg = list.msg.segments[list.seg]!;
  const start = (list.word + index * list.stepWords) * WORD_BYTES;
  return seg.subarray(start);
}
