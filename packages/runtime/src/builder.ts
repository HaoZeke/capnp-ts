/**
 * Multi-segment growable arena builder.
 *
 * Segment size policy (matches capnp-janet):
 *   - Default first segment: DEFAULT_FIRST_WORDS (1024 = 8 KiB).
 *   - Normal alloc tries the last segment; if the run does not fit remaining
 *     capacity, a new segment is appended (unless forceSingle for canonicalize).
 *   - Far landing pads allocate in the target object's segment when possible;
 *     else a double-far pad is placed in a fresh segment.
 *   - Hard ceiling: MAX_SEGMENT_WORDS (1<<29).
 */

import { storeF64, storeU16, storeU32, storeU64 } from "./endian.ts";
import {
  CapnpError,
  ElemSize,
  WORD_BYTES,
  assertCapnp,
} from "./kinds.ts";
import { serializeToFlat } from "./serialize.ts";
import { Message } from "./message.ts";
import { wpMakeFar, wpMakeList, wpMakeStruct } from "./pointer.ts";

export const DEFAULT_FIRST_WORDS = 1024;
export const MAX_SEGMENT_WORDS = 1 << 29;

interface BSeg {
  data: Uint8Array;
  words: number;
  cap: number;
}

export interface BuilderOptions {
  /** First segment capacity in words (default 1024). Small values force multi-seg. */
  firstWords?: number;
  /** Per-segment hard cap in words (default MAX_SEGMENT_WORDS). */
  maxSegWords?: number;
  /** Grow last segment instead of appending (canonical path). */
  forceSingle?: boolean;
}

/** Pointer slot or object body location inside a MessageBuilder. */
export class BuilderPointer {
  constructor(
    readonly builder: MessageBuilder,
    readonly seg: number,
    readonly word: number,
  ) {}

  add(wordDelta: number): BuilderPointer {
    return new BuilderPointer(this.builder, this.seg, this.word + wordDelta);
  }
}

export class MessageBuilder {
  /** @internal segments (mutable arena). */
  segs: BSeg[] = [];
  maxSegWords: number;
  forceSingle: boolean;

  constructor(opts: BuilderOptions = {}) {
    this.maxSegWords = opts.maxSegWords ?? 0;
    this.forceSingle = opts.forceSingle ?? false;
    let first = opts.firstWords ?? DEFAULT_FIRST_WORDS;
    if (first < 1) first = 1;
    if (first > MAX_SEGMENT_WORDS) first = MAX_SEGMENT_WORDS;
    this.appendSegment(first);
  }

  private limWords(): number {
    return this.maxSegWords ? this.maxSegWords : MAX_SEGMENT_WORDS;
  }

  get segmentCount(): number {
    return this.segs.length;
  }

  segmentWords(seg: number): number {
    return this.segs[seg]?.words ?? 0;
  }

  segmentData(seg: number): Uint8Array {
    const s = this.segs[seg];
    assertCapnp(s, "SEGMENT");
    return s.data.subarray(0, s.words * WORD_BYTES);
  }

  /** Mutable segment buffer (full capacity). */
  segBytes(seg: number): Uint8Array {
    return this.segs[seg]!.data;
  }

  private appendSegment(capWords: number): void {
    const lim = this.limWords();
    if (capWords < 1) capWords = 1;
    if (capWords > lim) capWords = lim;
    this.segs.push({
      data: new Uint8Array(capWords * WORD_BYTES),
      words: 0,
      cap: capWords,
    });
  }

  private segEnsure(seg: number, needWords: number): void {
    const lim = this.limWords();
    const s = this.segs[seg];
    assertCapnp(s, "SEGMENT");
    if (needWords <= s.cap) return;
    assertCapnp(needWords <= lim, "ALLOC");
    let ncap = s.cap ? s.cap * 2 : 16;
    while (ncap < needWords) ncap *= 2;
    if (ncap > lim) ncap = lim;
    assertCapnp(ncap >= needWords, "ALLOC");
    const nd = new Uint8Array(ncap * WORD_BYTES);
    nd.set(s.data.subarray(0, s.cap * WORD_BYTES));
    s.data = nd;
    s.cap = ncap;
  }

  /** Allocate `n` words; returns {seg, word} of the start. */
  allocWords(n: number): { seg: number; word: number } {
    assertCapnp(this.segs.length > 0, "ARG");
    const lim = this.limWords();
    assertCapnp(n <= lim, "ALLOC");
    const lastIdx = this.segs.length - 1;
    const last = this.segs[lastIdx]!;
    if (last.words + n <= last.cap && last.words + n <= lim) {
      const word = last.words;
      last.words += n;
      return { seg: lastIdx, word };
    }
    if (this.forceSingle) {
      this.segEnsure(lastIdx, last.words + n);
      const s = this.segs[lastIdx]!;
      const word = s.words;
      s.words += n;
      return { seg: lastIdx, word };
    }
    let ncap = last.cap ? last.cap * 2 : 16;
    if (ncap < n) ncap = n;
    if (ncap > lim) ncap = lim;
    assertCapnp(ncap >= n, "ALLOC");
    this.appendSegment(ncap);
    const s = this.segs[this.segs.length - 1]!;
    s.words = n;
    return { seg: this.segs.length - 1, word: 0 };
  }

  /** Allocate `n` words inside a specific segment (grow in place). */
  private allocIn(seg: number, n: number): number | null {
    const s = this.segs[seg];
    if (!s) return null;
    if (s.words + n > this.limWords()) return null;
    try {
      this.segEnsure(seg, s.words + n);
    } catch {
      return null;
    }
    const word = s.words;
    s.words += n;
    return word;
  }

  /** Fresh segment for far pad. */
  private allocPadSegment(n: number): { seg: number; word: number } {
    const need = n < 1 ? 1 : n;
    const saved = this.maxSegWords;
    if (saved && saved < need) this.maxSegWords = need;
    try {
      this.appendSegment(need);
    } finally {
      this.maxSegWords = saved;
    }
    const seg = this.segs.length - 1;
    this.segs[seg]!.words = need;
    return { seg, word: 0 };
  }

  storeW(seg: number, word: number, w: bigint): void {
    storeU64(this.segs[seg]!.data, word * WORD_BYTES, w);
  }

  writeStructPtr(
    slotSeg: number,
    slotWord: number,
    bodySeg: number,
    bodyWord: number,
    dwords: number,
    pwords: number,
  ): void {
    if (slotSeg === bodySeg) {
      const off = bodyWord - slotWord - 1;
      this.storeW(slotSeg, slotWord, wpMakeStruct(off, dwords, pwords));
      return;
    }
    const pad = this.allocIn(bodySeg, 1);
    if (pad !== null) {
      const off = bodyWord - pad - 1;
      this.storeW(bodySeg, pad, wpMakeStruct(off, dwords, pwords));
      this.storeW(slotSeg, slotWord, wpMakeFar(false, pad, bodySeg));
      return;
    }
    const { seg: padSeg, word: padWord } = this.allocPadSegment(2);
    this.storeW(padSeg, padWord, wpMakeFar(false, bodyWord, bodySeg));
    this.storeW(padSeg, padWord + 1, wpMakeStruct(0, dwords, pwords));
    this.storeW(slotSeg, slotWord, wpMakeFar(true, padWord, padSeg));
  }

  writeListPtr(
    slotSeg: number,
    slotWord: number,
    contentSeg: number,
    contentWord: number,
    esize: number,
    count: number,
  ): void {
    if (slotSeg === contentSeg) {
      const off = contentWord - slotWord - 1;
      this.storeW(slotSeg, slotWord, wpMakeList(off, esize, count));
      return;
    }
    const pad = this.allocIn(contentSeg, 1);
    if (pad !== null) {
      const off = contentWord - pad - 1;
      this.storeW(contentSeg, pad, wpMakeList(off, esize, count));
      this.storeW(slotSeg, slotWord, wpMakeFar(false, pad, contentSeg));
      return;
    }
    const { seg: padSeg, word: padWord } = this.allocPadSegment(2);
    this.storeW(padSeg, padWord, wpMakeFar(false, contentWord, contentSeg));
    this.storeW(padSeg, padWord + 1, wpMakeList(0, esize, count));
    this.storeW(slotSeg, slotWord, wpMakeFar(true, padWord, padSeg));
  }

  /**
   * Reserve the root pointer word (seg 0 word 0). Call once on a fresh builder.
   */
  rootSlot(): BuilderPointer {
    assertCapnp(this.segs.length > 0 && this.segs[0]!.words === 0, "ARG");
    const { seg, word } = this.allocWords(1);
    assertCapnp(seg === 0 && word === 0, "ALLOC");
    return new BuilderPointer(this, 0, 0);
  }

  /**
   * Allocate root struct and return its body.
   * Equivalent to rootSlot + initStruct(dwords, pwords).
   */
  initRoot(dwords: number, pwords: number): StructBuilder {
    const slot = this.rootSlot();
    return this.initStructAt(slot, dwords, pwords);
  }

  initStructAt(
    slot: BuilderPointer,
    dwords: number,
    pwords: number,
  ): StructBuilder {
    const n = dwords + pwords;
    if (n === 0) {
      const bodySeg = slot.seg;
      const bodyWord = slot.word + 1;
      this.writeStructPtr(slot.seg, slot.word, bodySeg, bodyWord, 0, 0);
      return new StructBuilder(this, bodySeg, bodyWord, dwords, pwords);
    }
    const { seg: bodySeg, word: bodyWord } = this.allocWords(n);
    this.writeStructPtr(slot.seg, slot.word, bodySeg, bodyWord, dwords, pwords);
    return new StructBuilder(this, bodySeg, bodyWord, dwords, pwords);
  }

  /** Stream-framed multi-segment message. */
  toFlat(): Uint8Array {
    assertCapnp(this.segs.length > 0 && this.segs[0]!.words > 0, "ARG");
    const msg = Message.fromSegments(
      this.segs.map((s) => ({
        data: s.data.subarray(0, s.words * WORD_BYTES),
        words: s.words,
      })),
    );
    return serializeToFlat(msg);
  }

  /** Optional orphan hooks (stubs for M4 deep-copy / adopt). */
  adopt(_orphan: never): never {
    throw new CapnpError("ARG", "adopt not implemented");
  }

  disown(_slot: BuilderPointer): never {
    throw new CapnpError("ARG", "disown not implemented");
  }
}

export class StructBuilder {
  constructor(
    readonly builder: MessageBuilder,
    readonly seg: number,
    /** Word offset of the struct body (data section start). */
    readonly word: number,
    readonly dwords: number,
    readonly pwords: number,
  ) {}

  asPointer(): BuilderPointer {
    return new BuilderPointer(this.builder, this.seg, this.word);
  }

  private bodyOk(absEnd: number): void {
    assertCapnp(
      absEnd <= this.builder.segmentWords(this.seg) * WORD_BYTES,
      "BOUNDS",
    );
  }

  private data(): Uint8Array {
    return this.builder.segBytes(this.seg);
  }

  setU8(byteOffset: number, value: number): void {
    const abs = this.word * WORD_BYTES + byteOffset;
    this.bodyOk(abs + 1);
    this.data()[abs] = value & 0xff;
  }

  setU16(byteOffset: number, value: number): void {
    const abs = this.word * WORD_BYTES + byteOffset;
    this.bodyOk(abs + 2);
    storeU16(this.data(), abs, value);
  }

  setU32(byteOffset: number, value: number): void {
    const abs = this.word * WORD_BYTES + byteOffset;
    this.bodyOk(abs + 4);
    storeU32(this.data(), abs, value);
  }

  setU64(byteOffset: number, value: bigint): void {
    const abs = this.word * WORD_BYTES + byteOffset;
    this.bodyOk(abs + 8);
    storeU64(this.data(), abs, value);
  }

  setF64(byteOffset: number, value: number): void {
    const abs = this.word * WORD_BYTES + byteOffset;
    this.bodyOk(abs + 8);
    storeF64(this.data(), abs, value);
  }

  setBool(bitOffset: number, value: boolean): void {
    const abs = this.word * WORD_BYTES + ((bitOffset / 8) | 0);
    this.bodyOk(abs + 1);
    const bit = 1 << (bitOffset % 8);
    const d = this.data();
    if (value) d[abs] = d[abs]! | bit;
    else d[abs] = d[abs]! & ~bit;
  }

  /** Pointer slot at index. */
  slot(ptrIndex: number): BuilderPointer {
    const pw = this.word + this.dwords + ptrIndex;
    assertCapnp(pw < this.builder.segmentWords(this.seg), "BOUNDS");
    return new BuilderPointer(this.builder, this.seg, pw);
  }

  initStruct(ptrIndex: number, dwords: number, pwords: number): StructBuilder {
    return this.builder.initStructAt(this.slot(ptrIndex), dwords, pwords);
  }

  setText(ptrIndex: number, text: string): void {
    const enc = new TextEncoder().encode(text);
    const nbytes = enc.length + 1; // trailing NUL
    const nwords = (nbytes + 7) >> 3;
    const slot = this.slot(ptrIndex);
    const { seg: startSeg, word: startWord } = this.builder.allocWords(nwords);
    const data = this.builder.segBytes(startSeg);
    const base = startWord * WORD_BYTES;
    data.fill(0, base, base + nwords * WORD_BYTES);
    data.set(enc, base);
    this.builder.writeListPtr(
      slot.seg,
      slot.word,
      startSeg,
      startWord,
      ElemSize.Byte,
      nbytes,
    );
  }

  setData(ptrIndex: number, bytes: Uint8Array): void {
    const slot = this.slot(ptrIndex);
    const nwords = (bytes.length + 7) >> 3;
    let startSeg: number;
    let startWord: number;
    if (nwords) {
      ({ seg: startSeg, word: startWord } = this.builder.allocWords(nwords));
      const data = this.builder.segBytes(startSeg);
      const base = startWord * WORD_BYTES;
      data.fill(0, base, base + nwords * WORD_BYTES);
      data.set(bytes, base);
    } else {
      startSeg = slot.seg;
      startWord = slot.word + 1;
    }
    this.builder.writeListPtr(
      slot.seg,
      slot.word,
      startSeg,
      startWord,
      ElemSize.Byte,
      bytes.length,
    );
  }

  /**
   * Init composite List(Struct) of `count` elements.
   * Returns the first element body; use `.nextElement()` for subsequent ones.
   */
  initCompositeList(
    ptrIndex: number,
    count: number,
    elemDwords: number,
    elemPwords: number,
  ): StructBuilder {
    const slot = this.slot(ptrIndex);
    const step = elemDwords + elemPwords;
    const contentWords = count * step;
    const need = 1 + contentWords;
    const { seg: tagSeg, word: tagWord } = this.builder.allocWords(need);
    this.builder.storeW(
      tagSeg,
      tagWord,
      wpMakeStruct(count | 0, elemDwords, elemPwords),
    );
    this.builder.writeListPtr(
      slot.seg,
      slot.word,
      tagSeg,
      tagWord,
      ElemSize.Composite,
      contentWords,
    );
    return new StructBuilder(
      this.builder,
      tagSeg,
      tagWord + 1,
      elemDwords,
      elemPwords,
    );
  }

  /** Alias: initList for composite structs. */
  initList(
    ptrIndex: number,
    count: number,
    elemDwords: number,
    elemPwords: number,
  ): StructBuilder {
    return this.initCompositeList(ptrIndex, count, elemDwords, elemPwords);
  }

  /** Init List of pointer-sized elements (e.g. List(Text) slots). */
  initPointerList(ptrIndex: number, count: number): BuilderPointer {
    const slot = this.slot(ptrIndex);
    let listSeg: number;
    let listStart: number;
    if (count) {
      ({ seg: listSeg, word: listStart } = this.builder.allocWords(count));
    } else {
      listSeg = slot.seg;
      listStart = slot.word + 1;
    }
    this.builder.writeListPtr(
      slot.seg,
      slot.word,
      listSeg,
      listStart,
      ElemSize.Pointer,
      count,
    );
    return new BuilderPointer(this.builder, listSeg, listStart);
  }

  /** Init primitive list and optionally copy little-endian payload. */
  initPrimList(
    ptrIndex: number,
    esize: number,
    count: number,
    itemBytes: number,
    items?: Uint8Array,
  ): BuilderPointer {
    const slot = this.slot(ptrIndex);
    const nbytes = count * itemBytes;
    const nwords = (nbytes + 7) >> 3;
    let startSeg: number;
    let startWord: number;
    if (nwords) {
      ({ seg: startSeg, word: startWord } = this.builder.allocWords(nwords));
      const data = this.builder.segBytes(startSeg);
      const base = startWord * WORD_BYTES;
      data.fill(0, base, base + nwords * WORD_BYTES);
      if (items && nbytes) data.set(items.subarray(0, nbytes), base);
    } else {
      startSeg = slot.seg;
      startWord = slot.word + 1;
    }
    this.builder.writeListPtr(
      slot.seg,
      slot.word,
      startSeg,
      startWord,
      esize,
      count,
    );
    return new BuilderPointer(this.builder, startSeg, startWord);
  }

  /** Next composite element: step = dwords + pwords. */
  nextElement(): StructBuilder {
    return new StructBuilder(
      this.builder,
      this.seg,
      this.word + this.dwords + this.pwords,
      this.dwords,
      this.pwords,
    );
  }
}
