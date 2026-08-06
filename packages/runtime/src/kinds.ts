/** Cap'n Proto wire constants and resolved pointer kinds. */

export const WORD_BYTES = 8;
export const DEFAULT_TRAVERSAL_WORDS = 8 * 1024 * 1024; // 8 Mi words
export const DEFAULT_DEPTH_LIMIT = 64;
export const MAX_SEGMENTS = 512;

/** Wire pointer kinds (bits 0-1). */
export const enum WireKind {
  Struct = 0,
  List = 1,
  Far = 2,
  Cap = 3,
}

/** Resolved pointer kinds (after far resolution). */
export const enum PtrKind {
  Null = 0,
  Struct = 1,
  List = 2,
  Cap = 3,
}

/** List element size codes (bits 32-34 of a list pointer). */
export const enum ElemSize {
  Void = 0,
  Bit = 1,
  Byte = 2,
  TwoBytes = 3,
  FourBytes = 4,
  EightBytes = 5,
  Pointer = 6,
  Composite = 7,
}

/** Alias used by some call sites. */
export const ElementSize = ElemSize;

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

export type CapnpErrorCode =
  | "ARG"
  | "ALLOC"
  | "FRAMING"
  | "BOUNDS"
  | "SEGMENT"
  | "KIND"
  | "DEPTH"
  | "TRAVERSAL"
  | "PACKED"
  | "CANONICAL"
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
