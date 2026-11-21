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
  bitsToF32,
  bitsToF64,
  f32ToBits,
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
  wpCompositeElementCount,
  wpListCount,
  wpListEsize,
  wpOffset,
  wpStructDwords,
  wpStructPwords,
} from "./pointer.ts";

const EMPTY_DATA = new Uint8Array(0);

/** Data bits of a non-composite element. Pointer lists contribute 0 data bits. */
function listDataBits(esize: number): number {
  switch (esize) {
    case ElemSize.Void:
      return 0;
    case ElemSize.Bit:
      return 1;
    case ElemSize.Byte:
      return 8;
    case ElemSize.TwoBytes:
      return 16;
    case ElemSize.FourBytes:
      return 32;
    case ElemSize.EightBytes:
      return 64;
    default:
      return 0;
  }
}

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
  assertCapnp(
    Number.isFinite(s.words) && s.words >= 0 && (s.words | 0) === s.words,
    "FRAMING",
    "bad segment word count",
  );
  assertCapnp(
    s.data.byteLength >= s.words * WORD_BYTES,
    "FRAMING",
    "segment buffer shorter than words*8",
  );
  return s;
}

/** An error capnp reports and then recovers from while reading. */
export interface RecoverableReadError {
  readonly description: string;
  readonly location: string;
}

export interface FlatOptions {
  traversalWords?: number;
  depthLimit?: number;
  /** Most segments a frame may have. */
  maxSegments?: number;
}

export class Message {
  /** Internal segment views (data + word count). */
  readonly segs: SegmentView[];
  traversalLeft: number;
  readonly depthLimit: number;
  owned?: Uint8Array;
  /**
   * Receives errors capnp recovers from while reading, after which the read
   * continues with capnp's fallback. Without a handler they are thrown.
   */
  onRecoverable?: (error: RecoverableReadError) => void;

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

  /**
   * Parse stream-framed message, copying so the input buffer may be reused.
   * capnp-C++ `FlatArrayMessageReader` has no segment cap. Pass
   * `maxSegments` to apply one. `InputStreamMessageReader` and the packed
   * reader cap the count at 511.
   */
  static fromFlat(data: Uint8Array, opts?: FlatOptions): Message {
    return Message.parseFlat(data, true, opts);
  }

  /** Zero-copy view of stream-framed message; data must outlive the Message. */
  static viewFlat(data: Uint8Array, opts?: FlatOptions): Message {
    return Message.parseFlat(data, false, opts);
  }

  /**
   * Attach already-separated segments (no framing). Accepts raw Uint8Array
   * buffers or `{ data, words }` views. Buffers must outlive the Message.
   */
  static fromSegments(
    segs: SegmentInput[],
    opts?: { traversalWords?: number; depthLimit?: number; segmentLimit?: number },
  ): Message {
    const limit = opts?.segmentLimit ?? MAX_SEGMENTS;
    assertCapnp(segs.length > 0 && segs.length <= limit, "FRAMING");
    const views = segs.map(asView);
    for (let i = 0; i < views.length; i++) {
      const s = views[i]!;
      assertCapnp(s.data && (s.words > 0 || i > 0), "FRAMING");
    }
    return new Message(views, opts);
  }

  root(expected?: "struct" | "text" | "data" | "copy"): Ptr {
    assertCapnp(this.segs.length > 0, "ARG");
    // C++ charges the root word in MessageReader::getRootInternal and again
    // in PointerReader::getRoot. Nesting limit 0 rejects this read.
    return resolvePtr(this, 0, 0, 0, 2, expected);
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

  recover(description: string, location: string): void {
    if (!this.onRecoverable) throw new CapnpError("KIND", description);
    this.onRecoverable({ description, location });
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
    if (words > this.traversalLeft) {
      throw new CapnpError(
        "TRAVERSAL",
        "Exceeded message traversal limit.  See capnp::ReaderOptions.",
      );
    }
    this.traversalLeft -= words;
  }

  remainingTraversal(): number {
    return this.traversalLeft;
  }

  private static parseFlat(data: Uint8Array, copy: boolean, opts?: FlatOptions): Message {
    assertCapnp(data.length >= 8, "FRAMING", "message shorter than 8 bytes");
    const first = loadU32(data, 0);
    // FlatArrayMessageReader rejects only the uint32 wrap, not a 511 cap.
    if (first === 0xffffffff) {
      throw new CapnpError(
        "FRAMING",
        "expected segmentCount != 0 [0 != 0]; Message segment count too large, caused overflow.",
      );
    }
    const nsegs = first + 1;
    if (opts?.maxSegments !== undefined) {
      assertCapnp(nsegs <= opts.maxSegments, "FRAMING", "Message has too many segments.");
    }
    let tableBytes = 4 + 4 * nsegs;
    if (tableBytes % 8 !== 0) tableBytes += 4;
    const arrayWords = Math.floor(data.length / WORD_BYTES);
    // FlatArrayMessageReader::init sizes the table as segmentCount/2 + 1 words.
    let offset = Math.floor(nsegs / 2) + 1;
    if (arrayWords < offset) {
      throw new CapnpError(
        "FRAMING",
        `expected array.size() >= offset [${arrayWords} >= ${offset}]; Message ends prematurely in segment table.`,
      );
    }

    const sizes: number[] = [];
    let totalWords = 0;
    for (let i = 0; i < nsegs; i++) {
      const sz = loadU32(data, 4 + 4 * i);
      sizes.push(sz);
      totalWords += sz;
    }
    assertCapnp(
      totalWords <= (opts?.traversalWords ?? DEFAULT_TRAVERSAL_WORDS),
      "TRAVERSAL",
      "Message is too large.",
    );
    for (let i = 0; i < nsegs; i++) {
      const segmentSize = sizes[i]!;
      if (arrayWords < offset + segmentSize) {
        const where = i === 0 ? "Message ends prematurely in first segment." : "Message ends prematurely.";
        throw new CapnpError(
          "FRAMING",
          `expected array.size() >= offset + segmentSize [${arrayWords} >= ${offset + segmentSize}]; ${where}`,
        );
      }
      offset += segmentSize;
    }
    const body = tableBytes + totalWords * WORD_BYTES;

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
    return new Message(segs, {
      traversalWords: opts?.traversalWords,
      depthLimit: opts?.depthLimit,
      owned,
    });
  }
}


const OUT_OF_BOUNDS_DETAIL =
  "This usually indicates that the input data was corrupted, used a different encoding " +
  "than specified (e.g. packed vs. non-packed), or was not a Cap'n Proto message to begin " +
  "with. Note that this error is NOT due to a schema mismatch; the input is invalid " +
  "regardless of schema.";

function recoverNull(m: Message, description: string, line: number): true {
  m.recover(description, `capnp/layout.c++:${line}`);
  return true;
}

/**
 * Whether the pointer word at `seg`/`word` reads as null, like C++
 * `PointerReader::getPointerType`: far pointers are followed but the target
 * is not bounds-checked, and malformed pointers count as null once the error
 * is reported.
 */
function pointerWordIsNull(m: Message, seg: number, word: number): boolean {
  let w = m.readWord(seg, word);
  if (w === 0n) return true;
  if (wpKind(w) === WireKind.Far) {
    const tseg = wpFarSeg(w);
    const toff = wpFarOff(w);
    if (tseg >= m.segs.length) {
      return recoverNull(
        m,
        "expected segment != nullptr [0 != nullptr]; Message contains far pointer to unknown segment.",
        580,
      );
    }
    if (toff + (wpFarTwo(w) ? 2 : 1) > m.segs[tseg]!.words) {
      return recoverNull(
        m,
        "expected boundsCheck(segment, ptr, padWords); Message contains out-of-bounds far " +
          `pointer. ${OUT_OF_BOUNDS_DETAIL}`,
        587,
      );
    }
    const pad = readWord(m, tseg, toff);
    if (!wpFarTwo(w)) {
      w = pad;
    } else {
      if (wpFarSeg(pad) >= m.segs.length) {
        return recoverNull(
          m,
          "expected newSegment != nullptr [0 != nullptr]; Message contains double-far pointer to unknown segment.",
          606,
        );
      }
      if (wpKind(pad) !== WireKind.Far) {
        return recoverNull(
          m,
          `expected pad->kind() == WirePointer::FAR [${wpKind(pad)} == 2]; Second word of double-far pad must be far pointer.`,
          610,
        );
      }
      w = readWord(m, tseg, toff + 1);
    }
  }
  switch (wpKind(w)) {
    case WireKind.Struct:
    case WireKind.List:
      return false;
    case WireKind.Far:
      return recoverNull(m, "far pointer not followed?", 2773);
    default:
      if ((w & 0xffffffffn) === 3n) return false;
      return recoverNull(m, "expected ptr->isCapability(); unknown pointer type", 2779);
  }
}

/** A capnp-C++ `KJ_REQUIRE` description, including the compared values. */
function kjExpected(cond: string, detail: string, values?: string): string {
  const bracket = values === undefined ? "" : ` [${values}]`;
  return `expected ${cond}${bracket}; ${detail}`;
}

/** `readStructPointer` when the pointer is not a struct. `wireKind` is the wire enum value. */
export function nonStructPointerMessage(wireKind: number): string {
  return kjExpected(
    "ref->kind() == WirePointer::STRUCT",
    "Schema mismatch: Message contains non-struct pointer where struct pointerwas expected.",
    `${wireKind} == 0`,
  );
}

function nonListBlobMessage(blob: "text" | "data", wireKind: number): string {
  return kjExpected(
    "ref->kind() == WirePointer::LIST",
    `Schema mismatch: Message contains non-list pointer where ${blob} was expected.`,
    `${wireKind} == 1`,
  );
}

function nonBytesBlobMessage(blob: "text" | "data"): string {
  // `ElementSize` is an enum class. capnp-C++ 1.4.0 prints it as "(can't stringify)".
  return kjExpected(
    "ref->listRef.elementSize() == ElementSize::BYTE",
    `Schema mismatch: Message contains list pointer of non-bytes where ${blob} was expected.`,
    "(can't stringify) == (can't stringify)",
  );
}

function resolvedWireKind(p: Ptr): number {
  if (p.kind === PtrKind.List) return WireKind.List;
  if (p.kind === PtrKind.Cap) return WireKind.Cap;
  return WireKind.Struct;
}

const FAR_UNKNOWN = kjExpected(
  "segment != nullptr",
  "Message contains far pointer to unknown segment.",
  "0 != nullptr",
);
const DOUBLE_FAR_UNKNOWN = kjExpected(
  "newSegment != nullptr",
  "Message contains double-far pointer to unknown segment.",
  "0 != nullptr",
);
const FAR_OOB = kjExpected(
  "boundsCheck(segment, ptr, padWords)",
  `Message contains out-of-bounds far pointer. ${OUT_OF_BOUNDS_DETAIL}`,
);
const STRUCT_OOB = kjExpected(
  "boundsCheck(segment, ptr, ref->structRef.wordSize())",
  `Message contained out-of-bounds struct pointer. ${OUT_OF_BOUNDS_DETAIL}`,
);
const LIST_OOB = kjExpected(
  "boundsCheck(segment, ptr, wordCount)",
  `Message contains out-of-bounds list pointer. ${OUT_OF_BOUNDS_DETAIL}`,
);
const TEXT_OOB = kjExpected(
  "boundsCheck(segment, ptr, roundBytesUpToWords(size))",
  `Message contained out-of-bounds text pointer. ${OUT_OF_BOUNDS_DETAIL}`,
);
const DATA_OOB = kjExpected(
  "boundsCheck(segment, ptr, roundBytesUpToWords(size))",
  `Message contained out-of-bounds data pointer. ${OUT_OF_BOUNDS_DETAIL}`,
);

type Expect = "struct" | "text" | "data" | "copy";

/** Bounds sentence for a list, matching the capnp-C++ read or copy path. */
function listDetail(expected: Expect | undefined, w: bigint): string {
  if (expected === "text") return TEXT_OOB;
  if (expected === "data") return DATA_OOB;
  if (expected === "copy") {
    const esize = wpListEsize(w);
    const cond =
      esize === ElemSize.Pointer
        ? "boundsCheck(segment, ptr, count * WORDS_PER_POINTER)"
        : esize === ElemSize.Composite
          ? "boundsCheck(segment, ptr, wordCount + POINTER_SIZE_IN_WORDS)"
          : "boundsCheck(segment, ptr, totalWords)";
    return kjExpected(cond, `Message contained out-of-bounds list pointer. ${OUT_OF_BOUNDS_DETAIL}`);
  }
  // readListPointer checks the tag word as well as the element body.
  if (wpListEsize(w) === ElemSize.Composite) {
    return kjExpected(
      "boundsCheck(segment, ptr, wordCount + POINTER_SIZE_IN_WORDS)",
      `Message contains out-of-bounds list pointer. ${OUT_OF_BOUNDS_DETAIL}`,
    );
  }
  return LIST_OOB;
}
const DEPTH_MSG = kjExpected(
  "nestingLimit > 0",
  "Message is too deeply-nested or contains cycles.  See capnp::ReaderOptions.",
  "0 > 0",
);
const TEXT_EMPTY = kjExpected(
  "size > ZERO * BYTES",
  "Message contains text that is not NUL-terminated.",
  "0 > 0",
);

function boundsWord(
  m: Message,
  seg: number,
  word: number,
  boundsDetail?: string,
  segmentDetail?: string,
): void {
  assertCapnp(seg >= 0 && seg < m.segs.length, "SEGMENT", segmentDetail);
  // Negative word offsets must not reach loadU64 (would throw TypeError/RangeError).
  assertCapnp(word >= 0 && word < m.segs[seg]!.words, "BOUNDS", boundsDetail);
}

function readWord(m: Message, seg: number, word: number): bigint {
  return loadU64(m.segs[seg]!.data, word * WORD_BYTES);
}

/**
 * `PointerReader::isNull`: a zero word is null. A far pointer is followed,
 * and a bad landing throws the same text as `followFars` / `getPointerType`.
 */
export function pointerFieldIsNull(m: Message, seg: number, word: number): boolean {
  let w = readWord(m, seg, word);
  if (w === 0n) return true;
  if (wpKind(w) === WireKind.Far) {
    const tseg = wpFarSeg(w);
    const toff = wpFarOff(w);
    if (wpFarTwo(w)) {
      boundsWord(m, tseg, toff, FAR_OOB, FAR_UNKNOWN);
      boundsWord(m, tseg, toff + 1, FAR_OOB, FAR_UNKNOWN);
      m.charge(2);
      const pad = readWord(m, tseg, toff);
      const cseg = wpFarSeg(pad);
      assertCapnp(
        cseg >= 0 && cseg < m.segs.length && m.segs[cseg]!.words > 0,
        "SEGMENT",
        DOUBLE_FAR_UNKNOWN,
      );
      assertCapnp(
        wpKind(pad) === WireKind.Far,
        "KIND",
        kjExpected(
          "pad->kind() == WirePointer::FAR",
          "Second word of double-far pad must be far pointer.",
          `${wpKind(pad)} == 2`,
        ),
      );
      w = readWord(m, tseg, toff + 1);
    } else {
      if (tseg < 0 || tseg >= m.segs.length || m.segs[tseg]!.words === 0) {
        throw new CapnpError("SEGMENT", FAR_UNKNOWN);
      }
      boundsWord(m, tseg, toff, FAR_OOB, FAR_UNKNOWN);
      m.charge(1);
      w = readWord(m, tseg, toff);
    }
    if (wpKind(w) === WireKind.Far) {
      throw new CapnpError("KIND", "far pointer not followed?");
    }
  }
  if (wpKind(w) === WireKind.Cap && ((w >> 2n) & 0x3fff_ffffn) !== 0n) {
    throw new CapnpError("KIND", "expected ptr->isCapability(); unknown pointer type");
  }
  return false;
}

/**
 * Charge `words` against the traversal budget. Rejects non-finite / negative
 * sizes before mutating the budget (no under-charge via wrap).
 */
function chargeWords(m: Message, words: number | bigint): void {
  const w = typeof words === "bigint" ? words : BigInt(words);
  assertCapnp(w >= 0n, "BOUNDS");
  m.charge(Number(w));
}

/**
 * Word count for a primitive list body: ceil(count * stepBits / 64).
 * Uses bigint so large counts cannot wrap via `>>>` (uint32) under-charge.
 */
function primitiveListWords(count: number, stepBits: number): bigint {
  if (stepBits <= 0 || count <= 0) return 0n;
  const bits = BigInt(count) * BigInt(stepBits);
  return (bits + 63n) / 64n;
}

function resolvePtr(
  m: Message,
  seg: number,
  word: number,
  depth: number,
  pointerWords: number,
  expected?: Expect,
): Ptr {
  boundsWord(m, seg, word);
  // Child pointer words are already inside a charged struct or list. The root
  // word is charged twice, matching getRootInternal plus PointerReader::getRoot.
  if (pointerWords > 0) m.charge(pointerWords);
  return resolveWord(m, seg, word, readWord(m, seg, word), depth, false, expected);
}

function resolveWord(
  m: Message,
  seg: number,
  word: number,
  w: bigint,
  depth: number,
  fromFar: boolean,
  expected?: Expect,
): Ptr {
  // A far landing pad of all zeros is an empty struct. Null is only a direct zero word.
  if (w === 0n && !fromFar) return Ptr.nullPtr(m, seg, word, depth);

  const kind = wpKind(w);
  // nestingLimit is decremented once per struct or list pointer, including the
  // root. Null pointers are answered before the limit is consulted.
  if (kind !== WireKind.Cap && depth >= m.depthLimit) {
    throw new CapnpError(
      "DEPTH",
      expected === "copy"
        ? "expected nestingLimit > 0 [0 > 0]; Message is too deeply-nested."
        : DEPTH_MSG,
    );
  }
  if (kind === WireKind.Far) {
    // followFars is one hop. A second far word is a non-struct/non-list pointer.
    // totalSize reports a far landing that is itself far as an unexpected far.
    if (fromFar) {
      if (expected === "text" || expected === "data") {
        throw new CapnpError("KIND", nonListBlobMessage(expected, kind));
      }
      if (expected === "copy") throw new CapnpError("KIND", "Unexpected FAR pointer.");
      throw new CapnpError("KIND", nonStructPointerMessage(kind));
    }
    const tseg = wpFarSeg(w);
    const toff = wpFarOff(w);
    if (wpFarTwo(w)) {
      // Far hops do not consume nesting depth. The landing object stays at `depth`.
      boundsWord(m, tseg, toff, FAR_OOB, FAR_UNKNOWN);
      boundsWord(m, tseg, toff + 1, FAR_OOB, FAR_UNKNOWN);
      m.charge(2);
      const pad = readWord(m, tseg, toff);
      const tag = readWord(m, tseg, toff + 1);
      const cseg = wpFarSeg(pad);
      const coff = wpFarOff(pad);
      // followFars checks the landing segment before the pad's kind.
      // ReaderArena::tryGetSegment treats an empty segment as absent.
      assertCapnp(
        cseg >= 0 && cseg < m.segs.length && m.segs[cseg]!.words > 0,
        "SEGMENT",
        DOUBLE_FAR_UNKNOWN,
      );
      // C++ checks kind == FAR and does not reject a landing pad with the double-far bit set.
      assertCapnp(
        wpKind(pad) === WireKind.Far,
        "KIND",
        kjExpected(
          "pad->kind() == WirePointer::FAR",
          "Second word of double-far pad must be far pointer.",
          `${wpKind(pad)} == 2`,
        ),
      );
      if (wpKind(tag) === WireKind.Struct) {
        if (expected === "text" || expected === "data") {
          throw new CapnpError("KIND", nonListBlobMessage(expected, WireKind.Struct));
        }
        const dwords = wpStructDwords(tag);
        const pwords = wpStructPwords(tag);
        if (dwords || pwords) {
          const end = coff + dwords + pwords;
          boundsWord(m, cseg, coff, STRUCT_OOB);
          if (end > 0) boundsWord(m, cseg, end - 1, STRUCT_OOB);
        }
        chargeWords(m, dwords + pwords);
        return Ptr.struct(m, cseg, coff, dwords, pwords, depth);
      }
      if (wpKind(tag) === WireKind.List) {
        if (expected === "struct") {
          throw new CapnpError("KIND", nonStructPointerMessage(WireKind.List));
        }
        return finishList(
          m,
          cseg,
          coff,
          tag,
          depth,
          listDetail(expected, tag),
          expected === "copy",
        );
      }
      // totalSize / copyPointer: a far tag after the double-far hop.
      if (wpKind(tag) === WireKind.Far && expected === "copy") {
        throw new CapnpError("KIND", "Unexpected FAR pointer.");
      }
      if (expected === "text" || expected === "data") {
        throw new CapnpError("KIND", nonListBlobMessage(expected, wpKind(tag)));
      }
      throw new CapnpError("KIND", nonStructPointerMessage(wpKind(tag)));
    }
    // tryGetSegment treats a missing or empty segment as absent.
    if (tseg < 0 || tseg >= m.segs.length || m.segs[tseg]!.words === 0) {
      throw new CapnpError("SEGMENT", FAR_UNKNOWN);
    }
    boundsWord(m, tseg, toff, FAR_OOB, FAR_UNKNOWN);
    m.charge(1);
    return resolveWord(m, tseg, toff, readWord(m, tseg, toff), depth, true, expected);
  }

  if ((expected === "text" || expected === "data") && kind !== WireKind.List) {
    throw new CapnpError("KIND", nonListBlobMessage(expected, kind));
  }

  if (kind === WireKind.Struct) {
    const off = wpOffset(w);
    const body = word + 1 + off;
    const dwords = wpStructDwords(w);
    const pwords = wpStructPwords(w);
    if (dwords || pwords) {
      const end = body + dwords + pwords;
      boundsWord(m, seg, body, STRUCT_OOB);
      if (end > 0) boundsWord(m, seg, end - 1, STRUCT_OOB);
    }
    chargeWords(m, dwords + pwords);
    return Ptr.struct(m, seg, body, dwords, pwords, depth);
  }

  if (kind === WireKind.List) {
    if (expected === "struct") {
      throw new CapnpError("KIND", nonStructPointerMessage(WireKind.List));
    }
    if ((expected === "text" || expected === "data") && wpListEsize(w) !== ElemSize.Byte) {
      throw new CapnpError("KIND", nonBytesBlobMessage(expected));
    }
    const off = wpOffset(w);
    return finishList(
      m,
      seg,
      word + 1 + off,
      w,
      depth,
      listDetail(expected, w),
      expected === "copy",
    );
  }

  if (kind === WireKind.Cap) {
    if (expected === "struct") {
      throw new CapnpError("KIND", nonStructPointerMessage(WireKind.Cap));
    }
    // encoding.html: B (30 bits after the kind) must be zero; other values
    // are reserved for future "other" pointer forms.
    assertCapnp(
      ((w >> 2n) & 0x3fff_ffffn) === 0n,
      "KIND",
      "Unknown pointer type.",
    );
    return Ptr.cap(m, seg, word, Number((w >> 32n) & 0xffff_ffffn), depth);
  }
  throw new CapnpError("KIND");
}

/**
 * Populate a list handle. For composite lists the list pointer's count is the
 * content word count (excluding tag); the tag word holds element count and
 * struct shape (encoding.html / capnp-fortran fill_list).
 */
function finishList(
  m: Message,
  seg: number,
  start: number,
  w: bigint,
  depth: number,
  boundsDetail: string = LIST_OOB,
  copy = false,
): Ptr {
  const esize = wpListEsize(w);
  const wireCount = wpListCount(w);

  if (esize === ElemSize.Composite) {
    // contentWords = words after the tag.
    const contentWords = wireCount;
    if (copy) {
      // totalSize bounds-checks, then rejects a non-struct tag, then an overrun,
      // and only then charges the words a copy would keep.
      boundsWord(m, seg, start, boundsDetail);
      if (contentWords > 0) boundsWord(m, seg, start + contentWords, boundsDetail);
      const tag = readWord(m, seg, start);
      if (wpKind(tag) !== WireKind.Struct) {
        throw new CapnpError("KIND", "Don't know how to handle non-STRUCT inline composite.");
      }
      const nelem = wpCompositeElementCount(tag);
      const dwords = wpStructDwords(tag);
      const pwords = wpStructPwords(tag);
      const step = dwords + pwords;
      const actual = BigInt(nelem) * BigInt(step);
      if (actual > BigInt(contentWords)) {
        throw new CapnpError(
          "BOUNDS",
          `expected actualSize <= wordCount [${actual} <= ${contentWords}]; Struct list pointer's elements overran size. ${OUT_OF_BOUNDS_DETAIL}`,
        );
      }
      chargeWords(m, actual + 1n);
      return Ptr.list(m, seg, start + 1, esize, nelem, dwords, pwords, step, depth);
    }
    const totalWords = BigInt(contentWords) + 1n;
    chargeWords(m, totalWords);
    boundsWord(m, seg, start, boundsDetail);
    if (contentWords > 0) {
      boundsWord(m, seg, start + contentWords, boundsDetail);
    }
    const tag = readWord(m, seg, start);
    assertCapnp(
      wpKind(tag) === WireKind.Struct,
      "KIND",
      "INLINE_COMPOSITE lists of non-STRUCT type are not supported.",
    );
    const nelem = wpCompositeElementCount(tag);
    const dwords = wpStructDwords(tag);
    const pwords = wpStructPwords(tag);
    const step = dwords + pwords;
    if (BigInt(nelem) * BigInt(step) > BigInt(contentWords)) {
      throw new CapnpError("BOUNDS", boundsDetail);
    }
    if (step === 0) {
      // Zero-sized structs carry no words. The reader charges one word per
      // element so the count cannot outrun the traversal limit.
      chargeWords(m, nelem);
    }
    return Ptr.list(m, seg, start + 1, esize, nelem, dwords, pwords, step, depth);
  }

  if (esize === ElemSize.Void) {
    // totalSize does nothing for void elements. The reader still charges one
    // word per element so a huge count cannot slip past the traversal limit.
    if (!copy) chargeWords(m, wireCount);
    return Ptr.list(m, seg, start, esize, wireCount, 0, 0, 0, depth);
  }

  const stepBits = listStepBits(esize);
  if (stepBits < 0) throw new CapnpError("KIND");
  const words = primitiveListWords(wireCount, stepBits);
  if (words > 0n) {
    const last = BigInt(start) + words - 1n;
    if (start < 0 || last > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CapnpError("BOUNDS", boundsDetail);
    }
    if (copy) {
      boundsWord(m, seg, Number(last), boundsDetail);
      chargeWords(m, words);
    } else {
      chargeWords(m, words);
      boundsWord(m, seg, Number(last), boundsDetail);
    }
  }
  return Ptr.list(m, seg, start, esize, wireCount, 0, 0, 0, depth);
}

/** Byte list as Text. The list must be non-empty and end with NUL. */
export function decodeWireText(list: Ptr): string {
  if (list.kind !== PtrKind.List) {
    throw new CapnpError("KIND", nonListBlobMessage("text", resolvedWireKind(list)));
  }
  if (list.esize !== ElemSize.Byte) {
    throw new CapnpError("KIND", nonBytesBlobMessage("text"));
  }
  const s = list.msg.segs[list.seg]!;
  const start = list.word * WORD_BYTES;
  const count = list.count;
  if (count === 0) throw new CapnpError("TEXT", TEXT_EMPTY);
  const last = s.data[start + count - 1]!;
  if (last !== 0) {
    // kj stringifies `char` as the raw code unit, including NUL on the right.
    const left = String.fromCharCode(last);
    const right = String.fromCharCode(0);
    throw new CapnpError(
      "TEXT",
      `expected cptr[unboundedSize] == '\\0' [${left} == ${right}]; Message contains text that is not NUL-terminated.`,
    );
  }
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(s.data.subarray(start, start + count - 1));
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
  /**
   * Nesting level at which this handle was resolved (root = 0). Subsequent
   * getP / listGetP walks use depth+1 against msg.depthLimit (capnp-fortran).
   */
  readonly depth: number;

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
    depth?: number;
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
    this.depth = init.depth ?? 0;
  }

  static nullPtr(msg: Message, seg: number, word: number, depth = 0): Ptr {
    return new Ptr({ msg, seg, word, kind: PtrKind.Null, depth });
  }

  static struct(
    msg: Message,
    seg: number,
    word: number,
    dwords: number,
    pwords: number,
    depth = 0,
  ): Ptr {
    return new Ptr({
      msg,
      seg,
      word,
      kind: PtrKind.Struct,
      dwords,
      pwords,
      depth,
    });
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
    depth = 0,
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
      depth,
    });
  }

  static cap(
    msg: Message,
    seg: number,
    word: number,
    index: number,
    depth = 0,
  ): Ptr {
    return new Ptr({ msg, seg, word, kind: PtrKind.Cap, count: index, depth });
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
   * zero. A null pointer and a read past the struct return `dflt`. A list
   * or capability throws the struct mismatch capnp-C++ raises from
   * `getAs<Struct>()`. Float defaults XOR the IEEE bit pattern; bool
   * defaults XOR the bit.
   */
  private isStructData(): boolean {
    if (this.kind === PtrKind.Struct) return true;
    if (this.kind === PtrKind.Null) return false;
    const wire =
      this.kind === PtrKind.List ? WireKind.List : this.kind === PtrKind.Cap ? WireKind.Cap : WireKind.Struct;
    throw new CapnpError("KIND", nonStructPointerMessage(wire));
  }

  getU8(byteOffset: number, dflt = 0): number {
    if (!this.isStructData()) return dflt;
    if ((byteOffset + 1) * 8 > this.dataBitCount()) return dflt;
    return (this.dataBytes()[byteOffset]! ^ dflt) & 0xff;
  }

  getU16(byteOffset: number, dflt = 0): number {
    if (!this.isStructData()) return dflt;
    if ((byteOffset + 2) * 8 > this.dataBitCount()) return dflt;
    return (loadU16(this.dataBytes(), byteOffset) ^ dflt) & 0xffff;
  }

  getU32(byteOffset: number, dflt = 0): number {
    if (!this.isStructData()) return dflt;
    if ((byteOffset + 4) * 8 > this.dataBitCount()) return dflt;
    return (loadU32(this.dataBytes(), byteOffset) ^ dflt) >>> 0;
  }

  getU64(byteOffset: number, dflt = 0n): bigint {
    if (!this.isStructData()) return dflt;
    if ((byteOffset + 8) * 8 > this.dataBitCount()) return dflt;
    return loadU64(this.dataBytes(), byteOffset) ^ dflt;
  }

  getF32(byteOffset: number, dflt = 0): number {
    if (!this.isStructData()) return dflt;
    if ((byteOffset + 4) * 8 > this.dataBitCount()) return dflt;
    const wire = loadU32(this.dataBytes(), byteOffset);
    return bitsToF32((wire ^ f32ToBits(dflt)) >>> 0);
  }

  getF64(byteOffset: number, dflt = 0): number {
    if (!this.isStructData()) return dflt;
    if ((byteOffset + 8) * 8 > this.dataBitCount()) return dflt;
    const wire = loadU64(this.dataBytes(), byteOffset);
    return bitsToF64(wire ^ f64ToBits(dflt));
  }

  getBool(bitOffset: number, dflt = false): boolean {
    if (!this.isStructData()) return dflt;
    if (bitOffset >= this.dataBitCount()) return dflt;
    const byteOffset = (bitOffset / 8) | 0;
    const bit = 1 << (bitOffset % 8);
    const wire = (this.dataBytes()[byteOffset]! & bit) !== 0;
    return wire !== dflt;
  }

  /**
   * Resolve struct pointer slot. Out-of-range → null.
   * `expected` checks the wire kind before the pointed-to object's bounds,
   * as capnp-C++ `readStructPointer` / `readTextPointer` do.
   */
  getP(ptrIndex: number, expected?: "struct" | "text" | "data" | "copy"): Ptr {
    // A null struct reads as empty: every pointer slot is null, and getters
    // then return the schema default. A list or capability still mismatches.
    if (this.kind === PtrKind.Null) {
      return Ptr.nullPtr(this.msg, this.seg, 0, this.depth);
    }
    assertCapnp(this.kind === PtrKind.Struct, "KIND");
    if (ptrIndex >= this.pwords) {
      return Ptr.nullPtr(this.msg, this.seg, 0, this.depth);
    }
    // Nesting budget continues from this handle — never restart at depthLimit.
    return resolvePtr(
      this.msg,
      this.seg,
      this.word + this.dwords + ptrIndex,
      this.depth + 1,
      0,
      expected,
    );
  }

  /**
   * Whether pointer slot `ptrIndex` is null, like C++ `PointerReader::isNull`.
   * The target object is not resolved or bounds-checked.
   */
  isNullP(ptrIndex: number): boolean {
    if (this.kind !== PtrKind.Struct || ptrIndex >= this.pwords) return true;
    return pointerWordIsNull(this.msg, this.seg, this.word + this.dwords + ptrIndex);
  }

  /** Alias for getP (canonical / C-style naming). */
  getp(ptrIndex: number): Ptr {
    return this.getP(ptrIndex);
  }

  getText(ptrIndex: number, dflt = ""): string {
    const list = this.getP(ptrIndex, "text");
    if (list.kind === PtrKind.Null) return dflt;
    if (list.kind !== PtrKind.List) {
      throw new CapnpError("KIND", nonListBlobMessage("text", resolvedWireKind(list)));
    }
    if (list.esize !== ElemSize.Byte) {
      throw new CapnpError("KIND", nonBytesBlobMessage("text"));
    }
    return decodeWireText(list);
  }

  getData(ptrIndex: number, dflt: Uint8Array = EMPTY_DATA): Uint8Array {
    const list = this.getP(ptrIndex, "data");
    if (list.kind === PtrKind.Null) return dflt;
    if (list.kind !== PtrKind.List) {
      throw new CapnpError("KIND", nonListBlobMessage("data", resolvedWireKind(list)));
    }
    if (list.esize !== ElemSize.Byte) {
      throw new CapnpError("KIND", nonBytesBlobMessage("data"));
    }
    const s = list.msg.segs[list.seg]!;
    const start = list.word * WORD_BYTES;
    return s.data.subarray(start, start + list.count);
  }

  listLen(): number {
    if (this.kind !== PtrKind.List) return 0;
    return this.count;
  }

  listGetP(index: number, expected?: "struct" | "text" | "data" | "copy"): Ptr {
    assertCapnp(this.kind === PtrKind.List, "KIND");
    assertCapnp(index >= 0 && index < this.count, "BOUNDS");
    if (this.esize === ElemSize.Pointer) {
      return resolvePtr(
        this.msg,
        this.seg,
        this.word + index,
        this.depth + 1,
        0,
        expected,
      );
    }
    if (this.esize === ElemSize.Composite) {
      return Ptr.struct(
        this.msg,
        this.seg,
        this.word + index * this.stepWords,
        this.dwords,
        this.pwords,
        this.elementDepth(),
      );
    }
    throw new CapnpError("KIND");
  }

  /**
   * Depth of a struct element. ListReader::getStructElement requires a
   * remaining nesting budget and hands the element one level less.
   */
  private elementDepth(): number {
    const depth = this.depth + 1;
    if (depth >= this.msg.depthLimit) throw new CapnpError("DEPTH");
    return depth;
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
   * - List(Void): zero-size struct view (encoding.html allows every esize but bit).
   * - List(Bool) / bit: refuse with KIND — encoding.html's only upgrade ban.
   *
   * Parity: encoding.html Void-vs-Bool upgrade rule; capnp-fortran upgrade views.
   */
  listGetStruct(index: number): Ptr {
    assertCapnp(this.kind === PtrKind.List, "KIND");
    assertCapnp(index >= 0 && index < this.count, "BOUNDS");
    const depth = this.elementDepth();

    if (this.esize === ElemSize.Composite) {
      return Ptr.struct(
        this.msg,
        this.seg,
        this.word + index * this.stepWords,
        this.dwords,
        this.pwords,
        depth,
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
        depth,
      });
    }
    // encoding.html: "any element size (except C = 1, i.e. 1-bit) may be
    // decoded as a struct list". List(Void) upgrades to a zero-size struct.
    if (this.esize === ElemSize.Bit) {
      throw new CapnpError("KIND", "List(Bool) cannot upgrade to struct");
    }
    if (this.esize === ElemSize.Void) {
      return new Ptr({
        msg: this.msg,
        seg: this.seg,
        word: this.word,
        kind: PtrKind.Struct,
        dwords: 0,
        pwords: 0,
        dataBits: 0,
        depth,
      });
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
      depth,
    });
  }

  listGetText(index: number): string {
    assertCapnp(this.kind === PtrKind.List, "KIND");
    assertCapnp(index >= 0, "BOUNDS");
    // List(Text) is a pointer list. C++ rejects data lists and data-only structs.
    this.assertListCompat(0, 1);
    if (this.esize === ElemSize.Pointer) {
      const elem = this.listGetP(index);
      if (elem.kind === PtrKind.Null) return "";
      if (elem.kind === PtrKind.List && elem.esize === ElemSize.Byte) {
        const s = elem.msg.segs[elem.seg]!;
        const start = elem.word * WORD_BYTES;
        assertCapnp(
          elem.count > 0 && s.data[start + elem.count - 1] === 0,
          "TEXT",
          "Text pointer is not NUL-terminated",
        );
        return new TextDecoder("utf-8", { ignoreBOM: true }).decode(s.data.subarray(start, start + elem.count - 1));
      }
      throw new CapnpError("KIND");
    }
    if (this.esize === ElemSize.Composite) {
      return this.listGetStruct(index).getText(0);
    }
    throw new CapnpError("KIND");
  }

  /**
   * C++ `readListPointer` element-size check (capnp 1.4.0).
   * `expectedBits` is 1 for Bool and 8/16/32/64 for data. `expectedPointers`
   * is 1 for a pointer list. Promotions and Bool-to-data reads throw SCHEMA.
   * A Bool reader may view a wider data list; the bool accessor then ignores step.
   */
  assertListCompat(expectedBits: number, expectedPointers: number): void {
    if (this.esize === ElemSize.Composite) {
      if (expectedBits === 1 && expectedPointers === 0) {
        throw new CapnpError(
          "SCHEMA",
          "Schema mismatch: Found struct list where bit list was expected; upgrading boolean lists to structs is no longer supported.",
        );
      }
      if (expectedBits > 0 && this.dwords <= 0) {
        throw new CapnpError(
          "SCHEMA",
          "Schema mismatch: Expected a primitive list, but got a list of pointer-only structs.",
        );
      }
      if (expectedPointers > this.pwords) {
        throw new CapnpError(
          "SCHEMA",
          "Schema mismatch: Expected a pointer list, but got a list of data-only structs.",
        );
      }
      return;
    }

    if (this.esize === ElemSize.Bit && !(expectedBits === 1 && expectedPointers === 0)) {
      throw new CapnpError(
        "SCHEMA",
        "Schema mismatch: Found bit list where struct list was expected; upgrading boolean lists to structs is no longer supported.",
      );
    }

    const dataBits = listDataBits(this.esize);
    const pointers = this.esize === ElemSize.Pointer ? 1 : 0;
    if (expectedBits > dataBits || expectedPointers > pointers) {
      throw new CapnpError(
        "SCHEMA",
        "Schema mismatch: Message contained list with incompatible element type.",
      );
    }
  }

  /** Negative index is BOUNDS. A mismatched element size is SCHEMA even past the end. */
  private preparePrimitive(expectedBits: number, index: number): boolean {
    assertCapnp(index >= 0, "BOUNDS");
    this.assertListCompat(expectedBits, 0);
    return index < this.count;
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
    if (this.kind !== PtrKind.List) return dflt;
    if (!this.preparePrimitive(8, index)) return dflt;
    if (this.esize === ElemSize.Byte) return this.listElemBytes(index, 1)[0]!;
    if (this.esize === ElemSize.Composite) return this.compositeElemData(index)[0]!;
    const el = this.listGetStruct(index);
    return el.dataBytes()[0]!;
  }

  listGetU16(index: number, dflt = 0): number {
    if (this.kind !== PtrKind.List) return dflt;
    if (!this.preparePrimitive(16, index)) return dflt;
    if (this.esize === ElemSize.TwoBytes) {
      return loadU16(this.listElemBytes(index, 2), 0);
    }
    if (this.esize === ElemSize.Composite) {
      return loadU16(this.compositeElemData(index), 0);
    }
    const el = this.listGetStruct(index);
    return loadU16(el.dataBytes(), 0);
  }

  listGetU32(index: number, dflt = 0): number {
    if (this.kind !== PtrKind.List) return dflt;
    if (!this.preparePrimitive(32, index)) return dflt;
    if (this.esize === ElemSize.FourBytes) {
      return loadU32(this.listElemBytes(index, 4), 0);
    }
    if (this.esize === ElemSize.Composite) {
      return loadU32(this.compositeElemData(index), 0);
    }
    const el = this.listGetStruct(index);
    return loadU32(el.dataBytes(), 0);
  }

  listGetU64(index: number, dflt = 0n): bigint {
    if (this.kind !== PtrKind.List) return dflt;
    if (!this.preparePrimitive(64, index)) return dflt;
    if (this.esize === ElemSize.EightBytes) {
      return loadU64(this.listElemBytes(index, 8), 0);
    }
    if (this.esize === ElemSize.Composite) {
      return loadU64(this.compositeElemData(index), 0);
    }
    const el = this.listGetStruct(index);
    return loadU64(el.dataBytes(), 0);
  }

  listGetF64(index: number, dflt = 0): number {
    if (this.kind !== PtrKind.List) return dflt;
    if (!this.preparePrimitive(64, index)) return dflt;
    if (this.esize === ElemSize.EightBytes) {
      return loadF64(this.listElemBytes(index, 8), 0);
    }
    if (this.esize === ElemSize.Composite) {
      return loadF64(this.compositeElemData(index), 0);
    }
    const el = this.listGetStruct(index);
    return loadF64(el.dataBytes(), 0);
  }

  listGetBool(index: number, dflt = false): boolean {
    if (this.kind !== PtrKind.List) return dflt;
    assertCapnp(index >= 0, "BOUNDS");
    // Bool-from-data is allowed: expected width is 1 bit, so any wider data
    // list passes. Bool-to-data, void, pointer, and struct lists throw.
    this.assertListCompat(1, 0);
    if (index >= this.count) return dflt;
    // C++ ListReader::getDataElement<bool> ignores step. The result is the
    // first `count` packed bits of the data area.
    const base = this.msg.segs[this.seg]!.data;
    const off = this.word * WORD_BYTES + ((index / 8) | 0);
    const bit = 1 << (index % 8);
    return (base[off]! & bit) !== 0;
  }
}

/** Alias for Ptr used by canonical / internal code. */
export { Ptr as CapnpPointer };
