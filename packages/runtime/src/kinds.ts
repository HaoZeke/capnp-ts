/**
 * Wire-format constants, pointer/list kind codes, and CapnpError.
 * Shared by every runtime module.
 */

/** Error code strings. CapnpError.code carries one of these. */
export const ErrorCode = {
  OK: "OK",
  BOUNDS: "BOUNDS",
  KIND: "KIND",
  DEPTH: "DEPTH",
  TRAVERSAL: "TRAVERSAL",
  ALLOC: "ALLOC",
  FRAMING: "FRAMING",
  PACKED: "PACKED",
  ARG: "ARG",
  SEGMENT: "SEGMENT",
  IO: "IO",
} as const;

export type ErrorCodeName = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Thrown on wire / reader failures. Prefer this over Result so callers can
 * match on `.code` (string) in tests and catch blocks.
 */
export class CapnpError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "CapnpError";
    this.code = code;
    // Preserve prototype chain under ES5 targets / some bundlers.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Wire pointer kinds (bits 0-1 of a pointer word). */
export const WireKind = {
  STRUCT: 0,
  LIST: 1,
  FAR: 2,
  CAP: 3,
} as const;

export type WireKindCode = (typeof WireKind)[keyof typeof WireKind];

/** Resolved object kinds carried by a resolved pointer value. */
export const PtrKind = {
  NULL: 0,
  STRUCT: 1,
  LIST: 2,
  CAP: 3,
} as const;

export type PtrKindCode = (typeof PtrKind)[keyof typeof PtrKind];

/** List element size codes (bits 32-34 of a list pointer). */
export const ListElementSize = {
  VOID: 0,
  BIT: 1,
  BYTE: 2,
  TWO: 3,
  FOUR: 4,
  EIGHT: 5,
  PTR: 6,
  COMPOSITE: 7,
} as const;

export type ListElementSizeCode =
  (typeof ListElementSize)[keyof typeof ListElementSize];

/** Bytes per Cap'n Proto word. */
export const CAPNP_WORD_BYTES = 8;

/** Reader default: 64 MiB of traversal words (C++ parity). */
export const DEFAULT_TRAVERSAL_WORDS = 8_388_608;

/** Reader default nesting depth limit. */
export const DEFAULT_DEPTH_LIMIT = 64;

/** Maximum segments in a single message framing table. */
export const MAX_SEGMENTS = 512;

/**
 * Stride of one list element in bits for a non-composite size code.
 * Returns -1 for COMPOSITE or unknown codes.
 */
export function listStepBits(esize: number): number {
  switch (esize) {
    case ListElementSize.VOID:
      return 0;
    case ListElementSize.BIT:
      return 1;
    case ListElementSize.BYTE:
      return 8;
    case ListElementSize.TWO:
      return 16;
    case ListElementSize.FOUR:
      return 32;
    case ListElementSize.EIGHT:
    case ListElementSize.PTR:
      return 64;
    default:
      return -1;
  }
}
