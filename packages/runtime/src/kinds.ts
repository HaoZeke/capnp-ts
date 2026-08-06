/** Cap'n Proto constants, errors, and pointer/list kind codes. */

export const WORD_BYTES = 8;
export const DEFAULT_TRAVERSAL_WORDS = 8 * 1024 * 1024; // 8 Mi words (C++ default)
export const DEFAULT_DEPTH_LIMIT = 64;
export const MAX_SEGMENTS = 512;

/** Wire pointer kind (bits 0–1 of a pointer word). */
export const enum WireKind {
  Struct = 0,
  List = 1,
  Far = 2,
  Cap = 3,
}

/** Resolved object kind (after far resolution). */
export const enum PtrKind {
  Null = 0,
  Struct = 1,
  List = 2,
  Cap = 3,
}

/** List element size (esize) codes. */
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
  readonly code: CapnpErrorCode;

  constructor(code: CapnpErrorCode, message?: string) {
    super(message ?? code);
    this.name = "CapnpError";
    this.code = code;
  }
}
