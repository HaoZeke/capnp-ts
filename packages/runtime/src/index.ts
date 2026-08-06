/**
 * @haozeke/capnp — pure TypeScript Cap'n Proto wire runtime.
 *
 * Public surface: kinds, endian, pointer, message, serialize, packed, canonical.
 * Builder lives in builder.ts (exported when stable).
 */

export {
  CapnpError,
  DEFAULT_DEPTH_LIMIT,
  DEFAULT_TRAVERSAL_WORDS,
  ElemSize,
  ElementSize,
  MAX_SEGMENTS,
  PtrKind,
  WORD_BYTES,
  WireKind,
  assertCapnp,
  listStepBits,
  type CapnpErrorCode,
} from "./kinds.ts";

export {
  loadF32,
  loadF64,
  loadI32,
  loadI64,
  loadU16,
  loadU32,
  loadU64,
  loadU8,
  storeF32,
  storeF64,
  storeI32,
  storeI64,
  storeU16,
  storeU32,
  storeU64,
  storeU8,
} from "./endian.ts";

export {
  makeCap,
  makeFar,
  makeList,
  makeStruct,
  wpCapIndex,
  wpFarOff,
  wpFarSeg,
  wpFarTwo,
  wpKind,
  wpListCount,
  wpListEsize,
  wpMakeCap,
  wpMakeFar,
  wpMakeList,
  wpMakeStruct,
  wpOffset,
  wpStructDwords,
  wpStructPwords,
} from "./pointer.ts";

export {
  CapnpPointer,
  Message,
  Ptr,
  frameSegments,
  type SegmentView,
} from "./message.ts";

export { serializeToFlat } from "./serialize.ts";

export { pack, unpack } from "./packed.ts";

export {
  canonicalize,
  canonicalizeFlat,
  messageFromRawSegment,
} from "./canonical.ts";

export {
  BuilderPointer,
  DEFAULT_FIRST_WORDS,
  MAX_SEGMENT_WORDS,
  MessageBuilder,
  StructBuilder,
  type BuilderOptions,
} from "./builder.ts";
