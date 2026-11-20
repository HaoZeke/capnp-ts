/** Cap'n Proto wire constants and resolved pointer kinds. */

export const WORD_BYTES = 8;
export const DEFAULT_TRAVERSAL_WORDS = 8 * 1024 * 1024; // 8 Mi words
export const DEFAULT_DEPTH_LIMIT = 64;
export const MAX_SEGMENTS = 512;

/**
 * Wire pointer kinds (bits 0-1).
 * Const objects (not `const enum`) so Bun strip / isolatedModules preserve values.
 */
export const WireKind = {
  Struct: 0,
  List: 1,
  Far: 2,
  Cap: 3,
} as const;
export type WireKind = (typeof WireKind)[keyof typeof WireKind];

/** Resolved pointer kinds (after far resolution). */
export const PtrKind = {
  Null: 0,
  Struct: 1,
  List: 2,
  Cap: 3,
} as const;
export type PtrKind = (typeof PtrKind)[keyof typeof PtrKind];

/** List element size codes (bits 32-34 of a list pointer). */
export const ElemSize = {
  Void: 0,
  Bit: 1,
  Byte: 2,
  TwoBytes: 3,
  FourBytes: 4,
  EightBytes: 5,
  Pointer: 6,
  Composite: 7,
} as const;
export type ElemSize = (typeof ElemSize)[keyof typeof ElemSize];

/** Alias used by some call sites. */
export const ElementSize = ElemSize;
export type ElementSize = ElemSize;

/** Bits per list element for primitive esize codes; -1 if composite/unknown. */
export function listStepBits(esize: number): number {
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
    case ElemSize.Pointer:
      return 64;
    default:
      return -1;
  }
}

/**
 * C++ `LIST_ELEMENT_COUNT_BITS`. `init(list, n)` rejects `n` above this
 * (`tried to allocate list with too many elements`).
 */
export const MAX_LIST_ELEMENTS = (1 << 29) - 1;

/** C++ `MAX_TEXT_SIZE` (`maxValueForBits<29>() - 1`, room for the NUL). */
export const MAX_TEXT_BYTES = (1 << 29) - 2;

/** C++ `BLOB_SIZE_BITS` maximum for Data. */
export const MAX_BLOB_BYTES = (1 << 29) - 1;

/**
 * C++ `assertMax<maxValueForBits<29>() - 1>` on a composite list's word count
 * (the tag word is allocated on top of this).
 */
export const MAX_COMPOSITE_CONTENT_WORDS = (1 << 29) - 2;

export function assertListElementCount(count: number): void {
  assertCapnp(
    Number.isInteger(count) && count >= 0 && count <= MAX_LIST_ELEMENTS,
    "ARG",
    "tried to allocate list with too many elements",
  );
}

export function assertTextBlobSize(size: number, message: string): void {
  assertCapnp(
    Number.isInteger(size) && size >= 0 && size <= MAX_TEXT_BYTES,
    "ARG",
    message,
  );
}

export function assertDataBlobSize(size: number, message: string): void {
  assertCapnp(
    Number.isInteger(size) && size >= 0 && size <= MAX_BLOB_BYTES,
    "ARG",
    message,
  );
}

/** Exact non-negative product. Rejects values JS numbers cannot hold. */
export function exactProduct(a: number, b: number): number {
  const p = BigInt(a) * BigInt(b);
  assertCapnp(
    p >= 0n && p <= BigInt(Number.MAX_SAFE_INTEGER),
    "ALLOC",
    "requested list size is too large",
  );
  return Number(p);
}

/**
 * Body size of a primitive list. Bigint division so `>>>` cannot wrap a
 * legal count (for example 2^28 two-byte elements) down to zero words.
 */
export function primitiveBodySize(
  count: number,
  stepBits: number,
): { nbytes: number; nwords: number } {
  if (stepBits <= 0 || count <= 0) return { nbytes: 0, nwords: 0 };
  const bits = BigInt(count) * BigInt(stepBits);
  const nbytes = (bits + 7n) / 8n;
  const nwords = (nbytes + 7n) / 8n;
  assertCapnp(
    nbytes <= BigInt(Number.MAX_SAFE_INTEGER) &&
      nwords <= BigInt(Number.MAX_SAFE_INTEGER),
    "ALLOC",
    "requested list size is too large",
  );
  return { nbytes: Number(nbytes), nwords: Number(nwords) };
}

/** Word count of `nbytes` payload bytes, without a uint32 shift wrap. */
export function bytesToWords(nbytes: number): number {
  if (nbytes <= 0) return 0;
  const nwords = (BigInt(nbytes) + 7n) / 8n;
  assertCapnp(
    nwords <= BigInt(Number.MAX_SAFE_INTEGER),
    "ALLOC",
    "requested list size is too large",
  );
  return Number(nwords);
}

/**
 * Content words of a composite list. Enforces the C++ element-count cap and
 * the segment word cap before the product can wrap.
 */
export function compositeContentWords(count: number, step: number): number {
  assertListElementCount(count);
  const words = exactProduct(count, step);
  assertCapnp(
    words <= MAX_COMPOSITE_CONTENT_WORDS,
    "ALLOC",
    "total size of struct list is larger than max segment size",
  );
  return words;
}

export type CapnpErrorCode =
  | "ARG"
  | "ALLOC"
  | "FRAMING"
  | "BOUNDS"
  | "SEGMENT"
  | "KIND"
  | "SCHEMA"
  | "DEPTH"
  | "TRAVERSAL"
  | "PACKED"
  | "CANONICAL"
  | "TEXT"
  | "JSON"
  | "UNSUPPORTED";

export class CapnpError extends Error {
  readonly code: CapnpErrorCode | string;
  constructor(code: CapnpErrorCode | string, message?: string) {
    super(message ?? code);
    this.name = "CapnpError";
    this.code = code;
  }
}

export function assertCapnp(
  cond: unknown,
  code: CapnpErrorCode | string,
  message?: string,
): asserts cond {
  if (!cond) throw new CapnpError(code, message);
}
