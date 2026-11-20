/**
 * Cap'n Proto dynamic value reader/builder API (models capnp/dynamic.h).
 *
 * Manipulates messages through runtime StructSchema, EnumSchema, ListSchema,
 * InterfaceSchema, ConstSchema, and AppliedAnnotation handles without static
 * code generation, preserving Cap'n Proto wire defaults and schema evolution.
 */

import {
  BuilderPointer,
  MessageBuilder,
  Orphan,
  StructBuilder,
} from "./builder.ts";
import { deepCopyPtrToSlot } from "./copy.ts";
import {
  bitsToF32,
  bitsToF64,
  f32ToBits,
  f64ToBits,
  loadF32,
  loadF64,
  loadU16,
  loadU32,
  loadU64,
  storeF32,
  storeF64,
  storeU16,
  storeU32,
  storeU64,
} from "./endian.ts";
import {
  CapnpError,
  ElemSize,
  PtrKind,
  WORD_BYTES,
  assertCapnp,
  assertDataBlobSize,
  assertListElementCount,
  assertTextBlobSize,
  bytesToWords,
  compositeContentWords,
  listStepBits,
  primitiveBodySize,
} from "./kinds.ts";
import { Message, Ptr, decodeWireText } from "./message.ts";
import { wpCompositeElementCount, wpMakeCap, wpMakeStruct } from "./pointer.ts";
import {
  AppliedAnnotation,
  ConstSchema,
  EnumSchema,
  Enumerant,
  InterfaceMethod,
  InterfaceSchema,
  ListSchema,
  type SchemaValue,
  StructField,
  StructSchema,
  Type,
  TypeKind,
} from "./schema.ts";

export const HasMode = {
  NON_NULL: "nonNull",
  NON_DEFAULT: "nonDefault",
} as const;
export type HasMode = (typeof HasMode)[keyof typeof HasMode];

export const DynamicValueType = {
  UNKNOWN: "unknown",
  VOID: "void",
  BOOL: "bool",
  INT: "int",
  UINT: "uint",
  FLOAT: "float",
  TEXT: "text",
  DATA: "data",
  LIST: "list",
  ENUM: "enum",
  STRUCT: "struct",
  CAPABILITY: "capability",
  ANY_POINTER: "anyPointer",
} as const;
export type DynamicValueType =
  (typeof DynamicValueType)[keyof typeof DynamicValueType];

const INT8_MIN = -128n;
const INT8_MAX = 127n;
const INT16_MIN = -32768n;
const INT16_MAX = 32767n;
const INT32_MIN = -2147483648n;
const INT32_MAX = 2147483647n;
const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;
const UINT8_MAX = 255n;
const UINT16_MAX = 65535n;
const UINT32_MAX = 4294967295n;
const UINT64_MAX = 18446744073709551615n;

const EMPTY_BYTES = new Uint8Array(0);
const ZERO_SEGMENT = new Uint8Array(8);

function emptyMessageView(): Message {
  return Message.fromSegments([ZERO_SEGMENT], {
    traversalWords: 1_073_741_824,
    depthLimit: 256,
  });
}

function builderMessageView(builder: MessageBuilder): Message {
  return Message.fromSegments(
    builder.segs.map((s) => ({
      data: s.data.subarray(0, s.words * WORD_BYTES),
      words: s.words,
    })),
    {
      traversalWords: 1_073_741_824,
      depthLimit: 256,
    },
  );
}

function checkSignedRange(v: bigint, min: bigint, max: bigint, label: string): void {
  assertCapnp(
    v >= min && v <= max,
    "ARG",
    `value ${v} out of range for ${label}`,
  );
}

function checkUnsignedRange(v: bigint, max: bigint, label: string): void {
  assertCapnp(
    v >= 0n && v <= max,
    "ARG",
    `value ${v} out of range for ${label}`,
  );
}

function toBigIntChecked(v: number | bigint, label: string): bigint {
  if (typeof v === "bigint") return v;
  assertCapnp(
    Number.isFinite(v) && Math.trunc(v) === v,
    "ARG",
    `non-integer ${v} for ${label}`,
  );
  return BigInt(v);
}

/** Dynamic enum value pairing an EnumSchema with a 16-bit wire ordinal. */
export class DynamicEnum {
  readonly schema: EnumSchema;
  readonly raw: number;

  constructor(schema: EnumSchema, raw: number) {
    assertCapnp(
      Number.isInteger(raw) && raw >= 0 && raw <= 0xffff,
      "ARG",
      `invalid enum ordinal ${raw}`,
    );
    this.schema = schema;
    this.raw = raw & 0xffff;
  }

  static fromEnumerant(enumerant: Enumerant): DynamicEnum {
    return new DynamicEnum(enumerant.getContainingEnum(), enumerant.getOrdinal());
  }

  getSchema(): EnumSchema {
    return this.schema;
  }

  getRaw(): number {
    return this.raw;
  }

  getEnumerant(): Enumerant | null {
    const list = this.schema.getEnumerants();
    return this.raw < list.length ? (list[this.raw] ?? null) : null;
  }

  getName(): string | null {
    return this.getEnumerant()?.name ?? null;
  }
}

export interface DynamicCapabilityHook {
  call(
    interfaceId: bigint,
    methodId: number,
    params: DynamicStructReader,
    paramSchema: StructSchema,
    resultSchema: StructSchema,
  ): Promise<DynamicStructReader> | DynamicStructReader;
}

/** Abstract base for dynamically-typed capability servers. */
export abstract class DynamicCapabilityServer {
  readonly schema: InterfaceSchema;

  constructor(schema: InterfaceSchema) {
    this.schema = schema;
  }

  getSchema(): InterfaceSchema {
    return this.schema;
  }

  abstract call(
    method: InterfaceMethod,
    params: DynamicStructReader,
    results: DynamicStructBuilder,
  ): Promise<void> | void;

  async dispatchCall(
    interfaceId: bigint,
    methodId: number,
    paramsPtr: Ptr,
  ): Promise<DynamicStructReader> {
    const targetIface = this.schema.findSuperclass(interfaceId);
    assertCapnp(
      targetIface !== null,
      "UNSUPPORTED",
      `interface 0x${interfaceId.toString(16)} not implemented by ${this.schema.getShortDisplayName()}`,
    );
    const methods = targetIface.getMethods();
    assertCapnp(
      methodId >= 0 && methodId < methods.length,
      "UNSUPPORTED",
      `method ordinal ${methodId} out of range on ${targetIface.getShortDisplayName()}`,
    );
    const method = methods[methodId]!;
    const params = new DynamicStructReader(method.getParamType(), paramsPtr);
    const outBuilder = new MessageBuilder();
    const resBuilder = initDynamicRoot(outBuilder, method.getResultType());
    await this.call(method, params, resBuilder);
    return resBuilder.asReader();
  }
}

/** Dynamically-typed capability client handle (wire cap index and optional dispatch hook). */
export class DynamicCapabilityClient {
  readonly schema: InterfaceSchema;
  readonly capIndex: number | null;
  readonly server: DynamicCapabilityServer | null;
  readonly hook: DynamicCapabilityHook | null;

  constructor(
    schema: InterfaceSchema,
    target?: number | DynamicCapabilityServer | null,
    hook?: DynamicCapabilityHook | null,
  ) {
    this.schema = schema;
    if (target instanceof DynamicCapabilityServer) {
      assertCapnp(
        target.getSchema().extends(schema),
        "KIND",
        `server ${target.getSchema().getShortDisplayName()} does not extend ${schema.getShortDisplayName()}`,
      );
      this.capIndex = 0;
      this.server = target;
      this.hook = hook ?? null;
    } else {
      this.capIndex = typeof target === "number" ? target >>> 0 : null;
      this.server = null;
      this.hook = hook ?? null;
    }
  }

  get isNull(): boolean {
    return this.capIndex === null && this.server === null && this.hook === null;
  }

  getSchema(): InterfaceSchema {
    return this.schema;
  }

  getCapIndex(): number | null {
    return this.capIndex;
  }

  upcast(requestedSchema: InterfaceSchema): DynamicCapabilityClient {
    assertCapnp(
      this.schema.extends(requestedSchema),
      "KIND",
      `${this.schema.getShortDisplayName()} does not extend ${requestedSchema.getShortDisplayName()}`,
    );
    return new DynamicCapabilityClient(
      requestedSchema,
      this.server ?? this.capIndex,
      this.hook,
    );
  }

  castAs(requestedSchema: InterfaceSchema): DynamicCapabilityClient {
    return new DynamicCapabilityClient(
      requestedSchema,
      this.server ?? this.capIndex,
      this.hook,
    );
  }

  async call(
    methodOrName: InterfaceMethod | string,
    buildParams?: (params: DynamicStructBuilder) => void,
  ): Promise<DynamicStructReader> {
    const method =
      typeof methodOrName === "string"
        ? this.schema.getMethodByName(methodOrName)
        : methodOrName;
    assertCapnp(
      this.schema.extends(method.getContainingInterface()),
      "ARG",
      `method ${method.name} does not belong to ${this.schema.getShortDisplayName()}`,
    );
    const paramMsg = new MessageBuilder();
    const paramBuilder = initDynamicRoot(paramMsg, method.getParamType());
    if (buildParams) buildParams(paramBuilder);
    const paramReader = paramBuilder.asReader();

    if (this.server) {
      return this.server.dispatchCall(
        method.getContainingInterface().id,
        method.getOrdinal(),
        paramReader.ptr,
      );
    }
    if (this.hook) {
      return await this.hook.call(
        method.getContainingInterface().id,
        method.getOrdinal(),
        paramReader,
        method.getParamType(),
        method.getResultType(),
      );
    }
    throw new CapnpError("UNSUPPORTED", "capability client has no active hook");
  }
}

export namespace DynamicCapability {
  export type Client = DynamicCapabilityClient;
  export type Server = DynamicCapabilityServer;
}

export const DynamicCapability = {
  Client: DynamicCapabilityClient,
  Server: DynamicCapabilityServer,
} as const;

export type DynamicSetValue =
  | DynamicValueReader
  | DynamicValueBuilder
  | DynamicStructReader
  | DynamicStructBuilder
  | DynamicListReader
  | DynamicListBuilder
  | DynamicEnum
  | DynamicCapabilityClient
  | DynamicCapabilityServer
  | Ptr
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | readonly DynamicSetValue[]
  | null
  | undefined;

/** Read-only tagged dynamic value (models capnp::DynamicValue::Reader). */
export class DynamicValueReader {
  readonly type: DynamicValueType;
  private readonly payload: unknown;

  private constructor(type: DynamicValueType, payload: unknown) {
    this.type = type;
    this.payload = payload;
  }

  static readonly UNKNOWN = new DynamicValueReader(DynamicValueType.UNKNOWN, null);
  static readonly VOID = new DynamicValueReader(DynamicValueType.VOID, undefined);

  static fromBool(v: boolean): DynamicValueReader {
    return new DynamicValueReader(DynamicValueType.BOOL, v);
  }

  static fromInt(v: number | bigint): DynamicValueReader {
    const b = toBigIntChecked(v, "int");
    checkSignedRange(b, INT64_MIN, INT64_MAX, "Int64");
    return new DynamicValueReader(DynamicValueType.INT, b);
  }

  static fromUInt(v: number | bigint): DynamicValueReader {
    const b = toBigIntChecked(v, "uint");
    checkUnsignedRange(b, UINT64_MAX, "UInt64");
    return new DynamicValueReader(DynamicValueType.UINT, b);
  }

  static fromFloat(v: number): DynamicValueReader {
    return new DynamicValueReader(DynamicValueType.FLOAT, v);
  }

  static fromText(v: string): DynamicValueReader {
    return new DynamicValueReader(DynamicValueType.TEXT, v);
  }

  static fromData(v: Uint8Array): DynamicValueReader {
    return new DynamicValueReader(DynamicValueType.DATA, v);
  }

  static fromEnum(v: DynamicEnum): DynamicValueReader {
    return new DynamicValueReader(DynamicValueType.ENUM, v);
  }

  static fromStruct(v: DynamicStructReader): DynamicValueReader {
    return new DynamicValueReader(DynamicValueType.STRUCT, v);
  }

  static fromList(v: DynamicListReader): DynamicValueReader {
    return new DynamicValueReader(DynamicValueType.LIST, v);
  }

  static fromCapability(v: DynamicCapabilityClient): DynamicValueReader {
    return new DynamicValueReader(DynamicValueType.CAPABILITY, v);
  }

  static fromAnyPointer(v: Ptr): DynamicValueReader {
    return new DynamicValueReader(DynamicValueType.ANY_POINTER, v);
  }

  static fromConst(constant: ConstSchema): DynamicValueReader {
    return schemaValueToDynamic(constant.rawValue, constant.getType());
  }

  static fromAnnotation(annotation: AppliedAnnotation): DynamicValueReader {
    return schemaValueToDynamic(annotation.rawValue, annotation.getType());
  }

  getType(): DynamicValueType {
    return this.type;
  }

  asVoid(): undefined {
    assertCapnp(this.type === DynamicValueType.VOID, "KIND", `expected void, got ${this.type}`);
    return undefined;
  }

  asBool(): boolean {
    assertCapnp(this.type === DynamicValueType.BOOL, "KIND", `expected bool, got ${this.type}`);
    return this.payload as boolean;
  }

  private asSignedBigInt(min: bigint, max: bigint, label: string): bigint {
    if (this.type === DynamicValueType.INT || this.type === DynamicValueType.UINT) {
      const b = this.payload as bigint;
      checkSignedRange(b, min, max, label);
      return b;
    }
    if (this.type === DynamicValueType.FLOAT) {
      const f = this.payload as number;
      assertCapnp(Number.isFinite(f) && Math.trunc(f) === f, "ARG", `non-integer float ${f} for ${label}`);
      const b = BigInt(f);
      checkSignedRange(b, min, max, label);
      return b;
    }
    throw new CapnpError("KIND", `expected integer for ${label}, got ${this.type}`);
  }

  private asUnsignedBigInt(max: bigint, label: string): bigint {
    if (this.type === DynamicValueType.INT || this.type === DynamicValueType.UINT) {
      const b = this.payload as bigint;
      checkUnsignedRange(b, max, label);
      return b;
    }
    if (this.type === DynamicValueType.FLOAT) {
      const f = this.payload as number;
      assertCapnp(Number.isFinite(f) && f >= 0 && Math.trunc(f) === f, "ARG", `non-integer float ${f} for ${label}`);
      const b = BigInt(f);
      checkUnsignedRange(b, max, label);
      return b;
    }
    throw new CapnpError("KIND", `expected unsigned integer for ${label}, got ${this.type}`);
  }

  asInt8(): number {
    return Number(this.asSignedBigInt(INT8_MIN, INT8_MAX, "Int8"));
  }

  asInt16(): number {
    return Number(this.asSignedBigInt(INT16_MIN, INT16_MAX, "Int16"));
  }

  asInt32(): number {
    return Number(this.asSignedBigInt(INT32_MIN, INT32_MAX, "Int32"));
  }

  asInt64(): bigint {
    return this.asSignedBigInt(INT64_MIN, INT64_MAX, "Int64");
  }

  asUInt8(): number {
    return Number(this.asUnsignedBigInt(UINT8_MAX, "UInt8"));
  }

  asUInt16(): number {
    return Number(this.asUnsignedBigInt(UINT16_MAX, "UInt16"));
  }

  asUInt32(): number {
    return Number(this.asUnsignedBigInt(UINT32_MAX, "UInt32"));
  }

  asUInt64(): bigint {
    return this.asUnsignedBigInt(UINT64_MAX, "UInt64");
  }

  asBigInt(): bigint {
    if (this.type === DynamicValueType.INT || this.type === DynamicValueType.UINT) {
      return this.payload as bigint;
    }
    throw new CapnpError("KIND", `expected 64-bit integer, got ${this.type}`);
  }

  asFloat32(): number {
    return Math.fround(this.asFloat64());
  }

  asFloat64(): number {
    if (this.type === DynamicValueType.FLOAT) {
      return this.payload as number;
    }
    if (this.type === DynamicValueType.INT || this.type === DynamicValueType.UINT) {
      return Number(this.payload as bigint);
    }
    throw new CapnpError("KIND", `expected float, got ${this.type}`);
  }

  asNumber(): number {
    if (this.type === DynamicValueType.FLOAT) return this.payload as number;
    if (this.type === DynamicValueType.INT || this.type === DynamicValueType.UINT) {
      return Number(this.payload as bigint);
    }
    throw new CapnpError("KIND", `expected numeric value, got ${this.type}`);
  }

  asText(): string {
    assertCapnp(this.type === DynamicValueType.TEXT, "KIND", `expected text, got ${this.type}`);
    return this.payload as string;
  }

  asData(): Uint8Array {
    assertCapnp(this.type === DynamicValueType.DATA, "KIND", `expected data, got ${this.type}`);
    return this.payload as Uint8Array;
  }

  asEnum(): DynamicEnum {
    assertCapnp(this.type === DynamicValueType.ENUM, "KIND", `expected enum, got ${this.type}`);
    return this.payload as DynamicEnum;
  }

  asStruct(): DynamicStructReader {
    assertCapnp(this.type === DynamicValueType.STRUCT, "KIND", `expected struct, got ${this.type}`);
    return this.payload as DynamicStructReader;
  }

  asList(): DynamicListReader {
    assertCapnp(this.type === DynamicValueType.LIST, "KIND", `expected list, got ${this.type}`);
    return this.payload as DynamicListReader;
  }

  asCapability(): DynamicCapabilityClient {
    assertCapnp(
      this.type === DynamicValueType.CAPABILITY,
      "KIND",
      `expected capability, got ${this.type}`,
    );
    return this.payload as DynamicCapabilityClient;
  }

  asAnyPointer(): Ptr {
    if (this.type === DynamicValueType.ANY_POINTER) {
      return this.payload as Ptr;
    }
    if (this.type === DynamicValueType.STRUCT) {
      return (this.payload as DynamicStructReader).ptr;
    }
    if (this.type === DynamicValueType.LIST) {
      return (this.payload as DynamicListReader).ptr;
    }
    throw new CapnpError("KIND", `expected pointer value, got ${this.type}`);
  }
}

/** Mutable tagged dynamic value handle (models capnp::DynamicValue::Builder). */
export class DynamicValueBuilder {
  readonly type: DynamicValueType;
  private readonly payload: unknown;

  /** @internal */
  constructor(type: DynamicValueType, payload: unknown) {
    this.type = type;
    this.payload = payload;
  }

  getType(): DynamicValueType {
    return this.type;
  }

  asReader(): DynamicValueReader {
    switch (this.type) {
      case DynamicValueType.UNKNOWN:
        return DynamicValueReader.UNKNOWN;
      case DynamicValueType.VOID:
        return DynamicValueReader.VOID;
      case DynamicValueType.BOOL:
        return DynamicValueReader.fromBool(this.payload as boolean);
      case DynamicValueType.INT:
        return DynamicValueReader.fromInt(this.payload as bigint);
      case DynamicValueType.UINT:
        return DynamicValueReader.fromUInt(this.payload as bigint);
      case DynamicValueType.FLOAT:
        return DynamicValueReader.fromFloat(this.payload as number);
      case DynamicValueType.TEXT:
        return DynamicValueReader.fromText(this.payload as string);
      case DynamicValueType.DATA:
        return DynamicValueReader.fromData(this.payload as Uint8Array);
      case DynamicValueType.ENUM:
        return DynamicValueReader.fromEnum(this.payload as DynamicEnum);
      case DynamicValueType.STRUCT:
        return DynamicValueReader.fromStruct(
          (this.payload as DynamicStructBuilder).asReader(),
        );
      case DynamicValueType.LIST:
        return DynamicValueReader.fromList(
          (this.payload as DynamicListBuilder).asReader(),
        );
      case DynamicValueType.CAPABILITY:
        return DynamicValueReader.fromCapability(
          this.payload as DynamicCapabilityClient,
        );
      case DynamicValueType.ANY_POINTER: {
        const bp = this.payload as BuilderPointer;
        const msg = builderMessageView(bp.builder);
        // Resolve the pointer slot at (bp.seg, bp.word)
        const fakeStruct = Ptr.struct(msg, bp.seg, bp.word, 0, 1);
        return DynamicValueReader.fromAnyPointer(fakeStruct.getP(0));
      }
    }
  }

  asBool(): boolean {
    return this.asReader().asBool();
  }
  asInt8(): number {
    return this.asReader().asInt8();
  }
  asInt16(): number {
    return this.asReader().asInt16();
  }
  asInt32(): number {
    return this.asReader().asInt32();
  }
  asInt64(): bigint {
    return this.asReader().asInt64();
  }
  asUInt8(): number {
    return this.asReader().asUInt8();
  }
  asUInt16(): number {
    return this.asReader().asUInt16();
  }
  asUInt32(): number {
    return this.asReader().asUInt32();
  }
  asUInt64(): bigint {
    return this.asReader().asUInt64();
  }
  asFloat32(): number {
    return this.asReader().asFloat32();
  }
  asFloat64(): number {
    return this.asReader().asFloat64();
  }
  asNumber(): number {
    return this.asReader().asNumber();
  }
  asText(): string {
    return this.asReader().asText();
  }
  asData(): Uint8Array {
    return this.asReader().asData();
  }
  asEnum(): DynamicEnum {
    return this.asReader().asEnum();
  }
  asCapability(): DynamicCapabilityClient {
    return this.asReader().asCapability();
  }

  asStruct(): DynamicStructBuilder {
    assertCapnp(
      this.type === DynamicValueType.STRUCT,
      "KIND",
      `expected struct builder, got ${this.type}`,
    );
    return this.payload as DynamicStructBuilder;
  }

  asList(): DynamicListBuilder {
    assertCapnp(
      this.type === DynamicValueType.LIST,
      "KIND",
      `expected list builder, got ${this.type}`,
    );
    return this.payload as DynamicListBuilder;
  }

  asAnyPointer(): BuilderPointer {
    assertCapnp(
      this.type === DynamicValueType.ANY_POINTER,
      "KIND",
      `expected AnyPointer builder, got ${this.type}`,
    );
    return this.payload as BuilderPointer;
  }
}

export namespace DynamicValue {
  export type Reader = DynamicValueReader;
  export type Builder = DynamicValueBuilder;
}

export const DynamicValue = {
  Type: DynamicValueType,
  Reader: DynamicValueReader,
  Builder: DynamicValueBuilder,
  UNKNOWN: DynamicValueReader.UNKNOWN,
  VOID: DynamicValueReader.VOID,
  fromConst: DynamicValueReader.fromConst,
  fromAnnotation: DynamicValueReader.fromAnnotation,
} as const;

export function schemaValueToDynamic(
  sv: SchemaValue,
  type: Type | null,
): DynamicValueReader {
  switch (sv.which) {
    case "void":
      return DynamicValueReader.VOID;
    case "bool":
      return DynamicValueReader.fromBool(sv.value);
    case "int8":
    case "int16":
    case "int32":
    case "int64":
      return DynamicValueReader.fromInt(sv.value);
    case "uint8":
    case "uint16":
    case "uint32":
    case "uint64":
      return DynamicValueReader.fromUInt(sv.value);
    case "float32":
    case "float64":
      return DynamicValueReader.fromFloat(sv.value);
    case "text":
      return DynamicValueReader.fromText(sv.value);
    case "data":
      return DynamicValueReader.fromData(sv.value);
    case "enum":
      if (type && type.isEnum()) {
        return DynamicValueReader.fromEnum(
          new DynamicEnum(type.asEnum(), sv.value),
        );
      }
      return DynamicValueReader.fromUInt(sv.value);
    case "struct":
      if (type && type.isStruct()) {
        return DynamicValueReader.fromStruct(
          new DynamicStructReader(type.asStruct(), sv.ptr),
        );
      }
      return DynamicValueReader.fromAnyPointer(sv.ptr);
    case "list":
      if (type && type.isList()) {
        return DynamicValueReader.fromList(
          new DynamicListReader(type.asList(), sv.ptr),
        );
      }
      return DynamicValueReader.fromAnyPointer(sv.ptr);
    case "interface":
      if (type && type.isInterface()) {
        return DynamicValueReader.fromCapability(
          new DynamicCapabilityClient(type.asInterface(), null),
        );
      }
      return DynamicValueReader.UNKNOWN;
    case "anyPointer":
      if (type) {
        if (type.isStruct()) {
          return DynamicValueReader.fromStruct(
            new DynamicStructReader(type.asStruct(), sv.ptr),
          );
        }
        if (type.isList()) {
          return DynamicValueReader.fromList(
            new DynamicListReader(type.asList(), sv.ptr),
          );
        }
        if (type.isText()) {
          return DynamicValueReader.fromText(readPtrAsText(sv.ptr, ""));
        }
        if (type.isData()) {
          return DynamicValueReader.fromData(readPtrAsData(sv.ptr, EMPTY_BYTES));
        }
      }
      return DynamicValueReader.fromAnyPointer(sv.ptr);
  }
}

function readPtrAsText(p: Ptr, dflt: string): string {
  if (p.kind === PtrKind.Null) return dflt;
  assertCapnp(
    p.kind === PtrKind.List && p.esize === ElemSize.Byte,
    "KIND",
    "Text pointer is not a byte list",
  );
  return decodeWireText(p);
}

function readPtrAsData(p: Ptr, dflt: Uint8Array): Uint8Array {
  if (p.kind === PtrKind.Null) return dflt;
  assertCapnp(
    p.kind === PtrKind.List && p.esize === ElemSize.Byte,
    "KIND",
    "Data pointer is not a byte list",
  );
  const s = p.msg.segs[p.seg]!;
  const start = p.word * WORD_BYTES;
  return s.data.subarray(start, start + p.count);
}

function defaultScalarNumber(sv: SchemaValue): number {
  if (
    sv.which === "int8" ||
    sv.which === "int16" ||
    sv.which === "int32" ||
    sv.which === "uint8" ||
    sv.which === "uint16" ||
    sv.which === "uint32" ||
    sv.which === "enum"
  ) {
    return sv.value;
  }
  return 0;
}

function defaultScalarBigInt(sv: SchemaValue): bigint {
  if (sv.which === "int64" || sv.which === "uint64") return sv.value;
  return 0n;
}

function defaultFloat32Bits(sv: SchemaValue): number {
  return sv.which === "float32" ? sv.rawBits : 0;
}

function defaultFloat64Bits(sv: SchemaValue): bigint {
  return sv.which === "float64" ? sv.rawBits : 0n;
}

/** Detached dynamic value within a MessageBuilder arena (models capnp::Orphan<DynamicValue>). */
export class DynamicOrphan {
  readonly type: DynamicValueType;
  readonly orphan: Orphan | null;
  readonly scalarReader: DynamicValueReader | null;
  readonly structSchema: StructSchema | null;
  readonly listSchema: ListSchema | null;
  readonly interfaceSchema: InterfaceSchema | null;
  private consumed = false;

  /** @internal */
  constructor(init: {
    type: DynamicValueType;
    orphan?: Orphan | null;
    scalarReader?: DynamicValueReader | null;
    structSchema?: StructSchema | null;
    listSchema?: ListSchema | null;
    interfaceSchema?: InterfaceSchema | null;
  }) {
    this.type = init.type;
    this.orphan = init.orphan ?? null;
    this.scalarReader = init.scalarReader ?? null;
    this.structSchema = init.structSchema ?? null;
    this.listSchema = init.listSchema ?? null;
    this.interfaceSchema = init.interfaceSchema ?? null;
  }

  get isAlive(): boolean {
    return !this.consumed && (this.orphan === null || this.orphan.isAlive);
  }

  getType(): DynamicValueType {
    return this.type;
  }

  /** @internal */
  markConsumed(): void {
    assertCapnp(this.isAlive, "ARG", "DynamicOrphan already adopted");
    this.consumed = true;
  }

  getReader(): DynamicValueReader {
    if (this.scalarReader) return this.scalarReader;
    if (!this.orphan || this.orphan.isNull || !this.orphan.builder) {
      if (this.structSchema) {
        return DynamicValueReader.fromStruct(
          DynamicStructReader.empty(this.structSchema),
        );
      }
      if (this.listSchema) {
        return DynamicValueReader.fromList(
          DynamicListReader.empty(this.listSchema),
        );
      }
      return DynamicValueReader.UNKNOWN;
    }
    const msg = builderMessageView(this.orphan.builder);
    if (this.type === DynamicValueType.STRUCT && this.structSchema) {
      const p = Ptr.struct(
        msg,
        this.orphan.seg,
        this.orphan.word,
        this.orphan.dwords,
        this.orphan.pwords,
      );
      return DynamicValueReader.fromStruct(
        new DynamicStructReader(this.structSchema, p),
      );
    }
    if (this.type === DynamicValueType.LIST && this.listSchema) {
      const p = orphanToListPtr(msg, this.orphan);
      return DynamicValueReader.fromList(
        new DynamicListReader(this.listSchema, p),
      );
    }
    if (this.type === DynamicValueType.TEXT) {
      const p = Ptr.list(
        msg,
        this.orphan.seg,
        this.orphan.word,
        this.orphan.esize,
        this.orphan.count,
        0,
        0,
        0,
      );
      return DynamicValueReader.fromText(readPtrAsText(p, ""));
    }
    if (this.type === DynamicValueType.DATA) {
      const p = Ptr.list(
        msg,
        this.orphan.seg,
        this.orphan.word,
        this.orphan.esize,
        this.orphan.count,
        0,
        0,
        0,
      );
      return DynamicValueReader.fromData(readPtrAsData(p, EMPTY_BYTES));
    }
    if (this.type === DynamicValueType.CAPABILITY && this.interfaceSchema) {
      return DynamicValueReader.fromCapability(
        new DynamicCapabilityClient(this.interfaceSchema, this.orphan.count),
      );
    }
    return DynamicValueReader.UNKNOWN;
  }
}

function orphanToListPtr(msg: Message, orphan: Orphan): Ptr {
  if (orphan.esize === ElemSize.Composite) {
    const tag = msg.readWord(orphan.seg, orphan.word);
    const nelem = wpCompositeElementCount(tag);
    const dw = Number((tag >> 32n) & 0xffffn);
    const pw = Number((tag >> 48n) & 0xffffn);
    return Ptr.list(
      msg,
      orphan.seg,
      orphan.word + 1,
      ElemSize.Composite,
      nelem,
      dw,
      pw,
      dw + pw,
    );
  }
  return Ptr.list(
    msg,
    orphan.seg,
    orphan.word,
    orphan.esize,
    orphan.count,
    0,
    0,
    0,
  );
}

/** Read-only view over a struct or group governed by a StructSchema. */
export class DynamicStructReader {
  readonly schema: StructSchema;
  readonly ptr: Ptr;

  constructor(schema: StructSchema, ptr: Ptr) {
    assertCapnp(
      ptr.kind === PtrKind.Struct || ptr.kind === PtrKind.Null,
      "KIND",
      `expected struct or null pointer for ${schema.getShortDisplayName()}`,
    );
    this.schema = schema;
    this.ptr = ptr;
  }

  static empty(schema: StructSchema): DynamicStructReader {
    const msg = emptyMessageView();
    return new DynamicStructReader(schema, Ptr.nullPtr(msg, 0, 0));
  }

  getSchema(): StructSchema {
    return this.schema;
  }

  private resolveField(fieldOrName: StructField | string): StructField {
    if (typeof fieldOrName === "string") {
      return this.schema.getFieldByName(fieldOrName);
    }
    assertCapnp(
      fieldOrName.getContainingStruct() === this.schema,
      "ARG",
      `field '${fieldOrName.name}' does not belong to ${this.schema.getShortDisplayName()}`,
    );
    return fieldOrName;
  }

  which(): StructField | null {
    if (this.schema.discriminantCount === 0) return null;
    const disc = this.ptr.getU16(this.schema.discriminantOffset * 2, 0);
    return this.schema.getFieldByDiscriminant(disc);
  }

  has(fieldOrName: StructField | string, mode: HasMode = HasMode.NON_NULL): boolean {
    const field = this.resolveField(fieldOrName);
    if (field.isUnionMember) {
      const disc = this.ptr.getU16(this.schema.discriminantOffset * 2, 0);
      if (disc !== field.discriminantValue) return false;
    }
    if (field.isGroup()) {
      return true;
    }

    const t = field.getType();
    switch (t.whichCode) {
      case TypeKind.Void:
        return mode === HasMode.NON_NULL;
      case TypeKind.Bool:
        return mode === HasMode.NON_NULL || this.ptr.getBool(field.offset, false);
      case TypeKind.Int8:
      case TypeKind.UInt8:
        return mode === HasMode.NON_NULL || this.ptr.getU8(field.offset, 0) !== 0;
      case TypeKind.Int16:
      case TypeKind.UInt16:
      case TypeKind.Enum:
        return (
          mode === HasMode.NON_NULL ||
          this.ptr.getU16(field.offset * 2, 0) !== 0
        );
      case TypeKind.Int32:
      case TypeKind.UInt32:
      case TypeKind.Float32:
        return (
          mode === HasMode.NON_NULL ||
          this.ptr.getU32(field.offset * 4, 0) !== 0
        );
      case TypeKind.Int64:
      case TypeKind.UInt64:
      case TypeKind.Float64:
        return (
          mode === HasMode.NON_NULL ||
          this.ptr.getU64(field.offset * 8, 0n) !== 0n
        );
      default: {
        if (this.ptr.kind !== PtrKind.Struct) return false;
        return !this.ptr.getP(field.offset).isNull;
      }
    }
  }

  get(fieldOrName: StructField | string): DynamicValueReader {
    const field = this.resolveField(fieldOrName);
    if (field.isUnionMember) {
      const disc = this.ptr.getU16(this.schema.discriminantOffset * 2, 0);
      assertCapnp(
        disc === field.discriminantValue,
        "ARG",
        `union member '${field.name}' is not active on ${this.schema.getShortDisplayName()}`,
      );
    }

    const t = field.getType();
    if (field.isGroup()) {
      return DynamicValueReader.fromStruct(
        new DynamicStructReader(t.asStruct(), this.ptr),
      );
    }

    const dval = field.defaultValue;
    const slotPtr = (): Ptr =>
      this.ptr.kind === PtrKind.Struct
        ? this.ptr.getP(field.offset)
        : Ptr.nullPtr(this.ptr.msg, 0, 0, this.ptr.depth);

    switch (t.whichCode) {
      case TypeKind.Void:
        return DynamicValueReader.VOID;
      case TypeKind.Bool:
        return DynamicValueReader.fromBool(
          this.ptr.getBool(
            field.offset,
            dval.which === "bool" ? dval.value : false,
          ),
        );
      case TypeKind.Int8: {
        const u = this.ptr.getU8(
          field.offset,
          defaultScalarNumber(dval) & 0xff,
        );
        return DynamicValueReader.fromInt((u << 24) >> 24);
      }
      case TypeKind.Int16: {
        const u = this.ptr.getU16(
          field.offset * 2,
          defaultScalarNumber(dval) & 0xffff,
        );
        return DynamicValueReader.fromInt((u << 16) >> 16);
      }
      case TypeKind.Int32: {
        const u = this.ptr.getU32(
          field.offset * 4,
          defaultScalarNumber(dval) >>> 0,
        );
        return DynamicValueReader.fromInt(u | 0);
      }
      case TypeKind.Int64: {
        const u = this.ptr.getU64(
          field.offset * 8,
          BigInt.asUintN(64, defaultScalarBigInt(dval)),
        );
        return DynamicValueReader.fromInt(BigInt.asIntN(64, u));
      }
      case TypeKind.UInt8:
        return DynamicValueReader.fromUInt(
          this.ptr.getU8(field.offset, defaultScalarNumber(dval) & 0xff),
        );
      case TypeKind.UInt16:
        return DynamicValueReader.fromUInt(
          this.ptr.getU16(field.offset * 2, defaultScalarNumber(dval) & 0xffff),
        );
      case TypeKind.UInt32:
        return DynamicValueReader.fromUInt(
          this.ptr.getU32(field.offset * 4, defaultScalarNumber(dval) >>> 0),
        );
      case TypeKind.UInt64:
        return DynamicValueReader.fromUInt(
          this.ptr.getU64(field.offset * 8, defaultScalarBigInt(dval)),
        );
      case TypeKind.Float32: {
        const wireBits = this.ptr.getU32(field.offset * 4, 0);
        return DynamicValueReader.fromFloat(
          bitsToF32((wireBits ^ defaultFloat32Bits(dval)) >>> 0),
        );
      }
      case TypeKind.Float64: {
        const wireBits = this.ptr.getU64(field.offset * 8, 0n);
        return DynamicValueReader.fromFloat(
          bitsToF64(wireBits ^ defaultFloat64Bits(dval)),
        );
      }
      case TypeKind.Enum: {
        const ord = this.ptr.getU16(
          field.offset * 2,
          defaultScalarNumber(dval) & 0xffff,
        );
        return DynamicValueReader.fromEnum(new DynamicEnum(t.asEnum(), ord));
      }
      case TypeKind.Text: {
        const p = slotPtr();
        if (p.isNull) {
          if (dval.which === "text") return DynamicValueReader.fromText(dval.value);
          if (dval.which === "anyPointer" && !dval.ptr.isNull) {
            return DynamicValueReader.fromText(readPtrAsText(dval.ptr, ""));
          }
          return DynamicValueReader.fromText("");
        }
        return DynamicValueReader.fromText(readPtrAsText(p, ""));
      }
      case TypeKind.Data: {
        const p = slotPtr();
        if (p.isNull) {
          if (dval.which === "data") return DynamicValueReader.fromData(dval.value);
          if (dval.which === "anyPointer" && !dval.ptr.isNull) {
            return DynamicValueReader.fromData(readPtrAsData(dval.ptr, EMPTY_BYTES));
          }
          return DynamicValueReader.fromData(EMPTY_BYTES);
        }
        return DynamicValueReader.fromData(readPtrAsData(p, EMPTY_BYTES));
      }
      case TypeKind.Struct: {
        const p = slotPtr();
        if (p.isNull) {
          if (
            (dval.which === "struct" || dval.which === "anyPointer") &&
            !dval.ptr.isNull
          ) {
            return DynamicValueReader.fromStruct(
              new DynamicStructReader(t.asStruct(), dval.ptr),
            );
          }
        }
        return DynamicValueReader.fromStruct(
          new DynamicStructReader(t.asStruct(), p),
        );
      }
      case TypeKind.List: {
        const p = slotPtr();
        if (p.isNull) {
          if (
            (dval.which === "list" || dval.which === "anyPointer") &&
            !dval.ptr.isNull
          ) {
            return DynamicValueReader.fromList(
              new DynamicListReader(t.asList(), dval.ptr),
            );
          }
        }
        return DynamicValueReader.fromList(new DynamicListReader(t.asList(), p));
      }
      case TypeKind.Interface: {
        const p = slotPtr();
        if (p.isNull) {
          return DynamicValueReader.fromCapability(
            new DynamicCapabilityClient(t.asInterface(), null),
          );
        }
        assertCapnp(
          p.kind === PtrKind.Cap,
          "KIND",
          `expected capability pointer for '${field.name}'`,
        );
        return DynamicValueReader.fromCapability(
          new DynamicCapabilityClient(t.asInterface(), p.count),
        );
      }
      case TypeKind.AnyPointer: {
        const p = slotPtr();
        if (p.isNull && dval.which === "anyPointer" && !dval.ptr.isNull) {
          return DynamicValueReader.fromAnyPointer(dval.ptr);
        }
        return DynamicValueReader.fromAnyPointer(p);
      }
      default:
        return DynamicValueReader.UNKNOWN;
    }
  }
}

/** Mutable view over a struct or group inside a MessageBuilder. */
export class DynamicStructBuilder {
  readonly schema: StructSchema;
  readonly sb: StructBuilder;

  constructor(schema: StructSchema, sb: StructBuilder) {
    this.schema = schema;
    this.sb = sb;
  }

  getSchema(): StructSchema {
    return this.schema;
  }

  asReader(): DynamicStructReader {
    const msg = builderMessageView(this.sb.builder);
    const p = Ptr.struct(
      msg,
      this.sb.seg,
      this.sb.word,
      this.sb.dwords,
      this.sb.pwords,
    );
    return new DynamicStructReader(this.schema, p);
  }

  private resolveField(fieldOrName: StructField | string): StructField {
    if (typeof fieldOrName === "string") {
      return this.schema.getFieldByName(fieldOrName);
    }
    assertCapnp(
      fieldOrName.getContainingStruct() === this.schema,
      "ARG",
      `field '${fieldOrName.name}' does not belong to ${this.schema.getShortDisplayName()}`,
    );
    return fieldOrName;
  }

  private setInUnion(field: StructField): void {
    if (field.isUnionMember) {
      this.sb.setU16(this.schema.discriminantOffset * 2, field.discriminantValue, 0);
    }
  }

  private verifySetInUnion(field: StructField): void {
    if (field.isUnionMember) {
      const msg = builderMessageView(this.sb.builder);
      const p = Ptr.struct(
        msg,
        this.sb.seg,
        this.sb.word,
        this.sb.dwords,
        this.sb.pwords,
      );
      const disc = p.getU16(this.schema.discriminantOffset * 2, 0);
      assertCapnp(
        disc === field.discriminantValue,
        "ARG",
        `union member '${field.name}' is not active on ${this.schema.getShortDisplayName()}`,
      );
    }
  }

  which(): StructField | null {
    return this.asReader().which();
  }

  has(fieldOrName: StructField | string, mode: HasMode = HasMode.NON_NULL): boolean {
    return this.asReader().has(fieldOrName, mode);
  }

  get(fieldOrName: StructField | string): DynamicValueBuilder {
    const field = this.resolveField(fieldOrName);
    this.verifySetInUnion(field);

    const t = field.getType();
    if (field.isGroup()) {
      return new DynamicValueBuilder(
        DynamicValueType.STRUCT,
        new DynamicStructBuilder(t.asStruct(), this.sb),
      );
    }

    if (!t.isPointerType()) {
      const r = this.asReader().get(field);
      switch (r.getType()) {
        case DynamicValueType.VOID:
          return new DynamicValueBuilder(DynamicValueType.VOID, undefined);
        case DynamicValueType.BOOL:
          return new DynamicValueBuilder(DynamicValueType.BOOL, r.asBool());
        case DynamicValueType.INT:
          return new DynamicValueBuilder(DynamicValueType.INT, r.asBigInt());
        case DynamicValueType.UINT:
          return new DynamicValueBuilder(DynamicValueType.UINT, r.asBigInt());
        case DynamicValueType.FLOAT:
          return new DynamicValueBuilder(
            DynamicValueType.FLOAT,
            t.isFloat32() ? r.asFloat32() : r.asFloat64(),
          );
        case DynamicValueType.ENUM:
          return new DynamicValueBuilder(DynamicValueType.ENUM, r.asEnum());
        default:
          return new DynamicValueBuilder(DynamicValueType.UNKNOWN, null);
      }
    }

    const slot = this.sb.slot(field.offset);
    const resolved = this.sb.builder.resolveSlot(slot);
    const dval = field.defaultValue;

    switch (t.whichCode) {
      case TypeKind.Struct: {
        const subSchema = t.asStruct();
        if (resolved.isNull) {
          if (
            (dval.which === "struct" || dval.which === "anyPointer") &&
            !dval.ptr.isNull
          ) {
            deepCopyPtrToSlot(this.sb.builder, slot, dval.ptr, 0);
            return this.get(field);
          }
          const childSb = this.sb.initStruct(
            field.offset,
            subSchema.dataWordCount,
            subSchema.pointerCount,
          );
          return new DynamicValueBuilder(
            DynamicValueType.STRUCT,
            new DynamicStructBuilder(subSchema, childSb),
          );
        }
        assertCapnp(resolved.kind === PtrKind.Struct, "KIND", "slot is not a struct");
        if (
          resolved.dwords < subSchema.dataWordCount ||
          resolved.pwords < subSchema.pointerCount
        ) {
          // Upgrade smaller older-version struct in place so all new schema fields are writable.
          const oldOrphan = this.sb.disown(field.offset);
          const childSb = this.sb.initStruct(
            field.offset,
            Math.max(resolved.dwords, subSchema.dataWordCount),
            Math.max(resolved.pwords, subSchema.pointerCount),
          );
          if (!oldOrphan.isNull && oldOrphan.builder) {
            const srcBytes = oldOrphan.builder
              .segBytes(oldOrphan.seg)
              .subarray(
                oldOrphan.word * WORD_BYTES,
                (oldOrphan.word + oldOrphan.dwords) * WORD_BYTES,
              );
            childSb
              .builder
              .segBytes(childSb.seg)
              .set(srcBytes, childSb.word * WORD_BYTES);
            for (let k = 0; k < oldOrphan.pwords; k++) {
              const pSlot = new BuilderPointer(
                oldOrphan.builder,
                oldOrphan.seg,
                oldOrphan.word + oldOrphan.dwords + k,
              );
              const subOrphan = oldOrphan.builder.disown(pSlot);
              childSb.adopt(k, subOrphan);
            }
          }
          oldOrphan.consume();
          return new DynamicValueBuilder(
            DynamicValueType.STRUCT,
            new DynamicStructBuilder(subSchema, childSb),
          );
        }
        return new DynamicValueBuilder(
          DynamicValueType.STRUCT,
          new DynamicStructBuilder(
            subSchema,
            new StructBuilder(
              this.sb.builder,
              resolved.seg,
              resolved.word,
              resolved.dwords,
              resolved.pwords,
            ),
          ),
        );
      }
      case TypeKind.List: {
        const listSchema = t.asList();
        if (resolved.isNull) {
          if (
            (dval.which === "list" || dval.which === "anyPointer") &&
            !dval.ptr.isNull
          ) {
            deepCopyPtrToSlot(this.sb.builder, slot, dval.ptr, 0);
            return this.get(field);
          }
          return new DynamicValueBuilder(
            DynamicValueType.LIST,
            DynamicListBuilder.empty(this.sb.builder, listSchema),
          );
        }
        assertCapnp(resolved.kind === PtrKind.List, "KIND", "slot is not a list");
        if (listSchema.getElementType().isStruct()) {
          const upgraded = upgradeStructListAtSlot(
            this.sb.builder,
            slot,
            listSchema,
            resolved,
          );
          if (upgraded) {
            return new DynamicValueBuilder(DynamicValueType.LIST, upgraded);
          }
        }
        return new DynamicValueBuilder(
          DynamicValueType.LIST,
          DynamicListBuilder.fromResolvedOrphan(
            this.sb.builder,
            listSchema,
            resolved,
          ),
        );
      }
      case TypeKind.Text:
        return new DynamicValueBuilder(
          DynamicValueType.TEXT,
          this.asReader().get(field).asText(),
        );
      case TypeKind.Data:
        return new DynamicValueBuilder(
          DynamicValueType.DATA,
          this.asReader().get(field).asData(),
        );
      case TypeKind.Interface:
        return new DynamicValueBuilder(
          DynamicValueType.CAPABILITY,
          this.asReader().get(field).asCapability(),
        );
      case TypeKind.AnyPointer:
        return new DynamicValueBuilder(DynamicValueType.ANY_POINTER, slot);
      default:
        return new DynamicValueBuilder(DynamicValueType.UNKNOWN, null);
    }
  }

  init(fieldOrName: StructField | string, size?: number): DynamicValueBuilder {
    const field = this.resolveField(fieldOrName);
    this.setInUnion(field);
    const t = field.getType();

    if (size === undefined) {
      if (field.isGroup()) {
        this.clear(field);
        return new DynamicValueBuilder(
          DynamicValueType.STRUCT,
          new DynamicStructBuilder(t.asStruct(), this.sb),
        );
      }
      if (t.isStruct()) {
        const subSchema = t.asStruct();
        const childSb = this.sb.initStruct(
          field.offset,
          subSchema.dataWordCount,
          subSchema.pointerCount,
        );
        return new DynamicValueBuilder(
          DynamicValueType.STRUCT,
          new DynamicStructBuilder(subSchema, childSb),
        );
      }
      if (t.isAnyPointer()) {
        const slot = this.sb.slot(field.offset);
        this.sb.builder.storeW(slot.seg, slot.word, 0n);
        return new DynamicValueBuilder(DynamicValueType.ANY_POINTER, slot);
      }
      throw new CapnpError(
        "ARG",
        `init() without size requires struct, group, or AnyPointer field (got ${t.which})`,
      );
    }

    assertCapnp(
      !field.isGroup() && Number.isInteger(size) && size >= 0,
      "ARG",
      `invalid init size ${size} on '${field.name}'`,
    );
    const slot = this.sb.slot(field.offset);

    if (t.isList()) {
      assertListElementCount(size);
      const lb = DynamicListBuilder.allocateAtSlot(
        this.sb.builder,
        slot,
        t.asList(),
        size,
      );
      return new DynamicValueBuilder(DynamicValueType.LIST, lb);
    }
    if (t.isText()) {
      assertTextBlobSize(size, "integer overflow");
      const bytes = new Uint8Array(size);
      this.sb.setText(field.offset, new TextDecoder().decode(bytes));
      return new DynamicValueBuilder(DynamicValueType.TEXT, "\0".repeat(size));
    }
    if (t.isData()) {
      assertDataBlobSize(size, "integer overflow");
      const bytes = new Uint8Array(size);
      this.sb.setData(field.offset, bytes);
      const resolved = this.sb.builder.resolveSlot(slot);
      const slice = this.sb.builder
        .segBytes(resolved.seg)
        .subarray(resolved.word * WORD_BYTES, resolved.word * WORD_BYTES + size);
      return new DynamicValueBuilder(DynamicValueType.DATA, slice);
    }
    throw new CapnpError(
      "ARG",
      `init() with size requires list, Text, or Data field (got ${t.which})`,
    );
  }

  set(fieldOrName: StructField | string, rawInput: DynamicSetValue): void {
    const field = this.resolveField(fieldOrName);
    this.setInUnion(field);
    const t = field.getType();

    if (field.isGroup()) {
      const src = coerceStructReader(rawInput, t.asStruct());
      const dst = this.init(field).asStruct();
      copyDynamicStructFields(src, dst);
      return;
    }

    if (Array.isArray(rawInput)) {
      assertCapnp(t.isList(), "KIND", `cannot assign array to non-list field '${field.name}'`);
      const lb = this.init(field, rawInput.length).asList();
      for (let i = 0; i < rawInput.length; i++) {
        lb.set(i, rawInput[i]!);
      }
      return;
    }

    const dval = field.defaultValue;
    const val = coerceToDynamicReader(rawInput, t);

    const checkDataBytes = (byteOffset: number, size: number) => {
      assertCapnp(
        byteOffset + size <= this.sb.dwords * WORD_BYTES,
        "BOUNDS",
        `struct data section (${this.sb.dwords} words) too small for field '${field.name}'`,
      );
    };

    switch (t.whichCode) {
      case TypeKind.Void:
        val.asVoid();
        return;
      case TypeKind.Bool:
        checkDataBytes(field.offset >>> 3, 1);
        this.sb.setBool(
          field.offset,
          val.asBool(),
          dval.which === "bool" ? dval.value : false,
        );
        return;
      case TypeKind.Int8:
        checkDataBytes(field.offset, 1);
        this.sb.setU8(
          field.offset,
          val.asInt8() & 0xff,
          defaultScalarNumber(dval) & 0xff,
        );
        return;
      case TypeKind.Int16:
        checkDataBytes(field.offset * 2, 2);
        this.sb.setU16(
          field.offset * 2,
          val.asInt16() & 0xffff,
          defaultScalarNumber(dval) & 0xffff,
        );
        return;
      case TypeKind.Int32:
        checkDataBytes(field.offset * 4, 4);
        this.sb.setU32(
          field.offset * 4,
          val.asInt32() >>> 0,
          defaultScalarNumber(dval) >>> 0,
        );
        return;
      case TypeKind.Int64:
        checkDataBytes(field.offset * 8, 8);
        this.sb.setU64(
          field.offset * 8,
          BigInt.asUintN(64, val.asInt64()),
          BigInt.asUintN(64, defaultScalarBigInt(dval)),
        );
        return;
      case TypeKind.UInt8:
        checkDataBytes(field.offset, 1);
        this.sb.setU8(
          field.offset,
          val.asUInt8(),
          defaultScalarNumber(dval) & 0xff,
        );
        return;
      case TypeKind.UInt16:
        checkDataBytes(field.offset * 2, 2);
        this.sb.setU16(
          field.offset * 2,
          val.asUInt16(),
          defaultScalarNumber(dval) & 0xffff,
        );
        return;
      case TypeKind.UInt32:
        checkDataBytes(field.offset * 4, 4);
        this.sb.setU32(
          field.offset * 4,
          val.asUInt32(),
          defaultScalarNumber(dval) >>> 0,
        );
        return;
      case TypeKind.UInt64:
        checkDataBytes(field.offset * 8, 8);
        this.sb.setU64(
          field.offset * 8,
          val.asUInt64(),
          defaultScalarBigInt(dval),
        );
        return;
      case TypeKind.Float32: {
        checkDataBytes(field.offset * 4, 4);
        const bits = f32ToBits(val.asFloat32());
        this.sb.setU32(
          field.offset * 4,
          (bits ^ defaultFloat32Bits(dval)) >>> 0,
          0,
        );
        return;
      }
      case TypeKind.Float64: {
        checkDataBytes(field.offset * 8, 8);
        const bits = f64ToBits(val.asFloat64());
        this.sb.setU64(
          field.offset * 8,
          bits ^ defaultFloat64Bits(dval),
          0n,
        );
        return;
      }
      case TypeKind.Enum: {
        checkDataBytes(field.offset * 2, 2);
        const enumSchema = t.asEnum();
        let ord: number;
        if (val.getType() === DynamicValueType.TEXT) {
          ord = enumSchema.getEnumerantByName(val.asText()).getOrdinal();
        } else if (
          val.getType() === DynamicValueType.INT ||
          val.getType() === DynamicValueType.UINT
        ) {
          ord = val.asUInt16();
        } else {
          const ev = val.asEnum();
          assertCapnp(
            ev.getSchema() === enumSchema,
            "KIND",
            `enum schema mismatch on '${field.name}'`,
          );
          ord = ev.getRaw();
        }
        this.sb.setU16(
          field.offset * 2,
          ord,
          defaultScalarNumber(dval) & 0xffff,
        );
        return;
      }
      case TypeKind.Text:
        this.sb.setText(field.offset, val.asText());
        return;
      case TypeKind.Data:
        this.sb.setData(field.offset, val.asData());
        return;
      case TypeKind.Struct: {
        const sv = val.asStruct();
        assertCapnp(
          sv.getSchema() === t.asStruct(),
          "KIND",
          `struct schema mismatch on '${field.name}'`,
        );
        this.sb.setP(field.offset, sv.ptr);
        return;
      }
      case TypeKind.List: {
        const lv = val.asList();
        assertCapnp(
          lv.getSchema() === t.asList(),
          "KIND",
          `list schema mismatch on '${field.name}'`,
        );
        this.sb.setP(field.offset, lv.ptr);
        return;
      }
      case TypeKind.Interface: {
        const cv = val.asCapability();
        assertCapnp(
          cv.getSchema().extends(t.asInterface()),
          "KIND",
          `capability schema mismatch on '${field.name}'`,
        );
        const slot = this.sb.slot(field.offset);
        if (cv.getCapIndex() === null) {
          this.sb.builder.storeW(slot.seg, slot.word, 0n);
        } else {
          this.sb.builder.storeW(slot.seg, slot.word, wpMakeCap(cv.getCapIndex()!));
        }
        return;
      }
      case TypeKind.AnyPointer: {
        const slot = this.sb.slot(field.offset);
        writeAnyPointerValue(this.sb, field.offset, slot, val);
        return;
      }
    }
  }

  clear(fieldOrName: StructField | string): void {
    const field = this.resolveField(fieldOrName);
    this.setInUnion(field);
    const t = field.getType();

    if (field.isGroup()) {
      const group = new DynamicStructBuilder(t.asStruct(), this.sb);
      const defaultUnionField = group.schema.getFieldByDiscriminant(0);
      if (defaultUnionField) {
        group.clear(defaultUnionField);
      }
      for (const sf of group.schema.getNonUnionFields()) {
        group.clear(sf);
      }
      return;
    }

    switch (t.whichCode) {
      case TypeKind.Void:
        return;
      case TypeKind.Bool:
        this.sb.setBool(field.offset, false, false);
        return;
      case TypeKind.Int8:
      case TypeKind.UInt8:
        this.sb.setU8(field.offset, 0, 0);
        return;
      case TypeKind.Int16:
      case TypeKind.UInt16:
      case TypeKind.Enum:
        this.sb.setU16(field.offset * 2, 0, 0);
        return;
      case TypeKind.Int32:
      case TypeKind.UInt32:
      case TypeKind.Float32:
        this.sb.setU32(field.offset * 4, 0, 0);
        return;
      case TypeKind.Int64:
      case TypeKind.UInt64:
      case TypeKind.Float64:
        this.sb.setU64(field.offset * 8, 0n, 0n);
        return;
      default: {
        const slot = this.sb.slot(field.offset);
        this.sb.builder.storeW(slot.seg, slot.word, 0n);
        return;
      }
    }
  }

  disown(fieldOrName: StructField | string): DynamicOrphan {
    const field = this.resolveField(fieldOrName);
    this.verifySetInUnion(field);
    const t = field.getType();

    if (field.isGroup()) {
      const groupSchema = t.asStruct();
      const src = new DynamicStructBuilder(groupSchema, this.sb);
      const tempSlot = allocDetachedSlot(this.sb.builder);
      const dstSb = this.sb.builder.initStructAt(
        tempSlot,
        groupSchema.dataWordCount,
        groupSchema.pointerCount,
      );
      const dst = new DynamicStructBuilder(groupSchema, dstSb);
      const active = src.which();
      if (active) {
        dst.adopt(active, src.disown(active));
      }
      const dfltUnion = groupSchema.getFieldByDiscriminant(0);
      if (dfltUnion) src.clear(dfltUnion);
      for (const sf of groupSchema.getNonUnionFields()) {
        if (src.has(sf)) {
          dst.adopt(sf, src.disown(sf));
        }
      }
      return new DynamicOrphan({
        type: DynamicValueType.STRUCT,
        orphan: this.sb.builder.disown(tempSlot),
        structSchema: groupSchema,
      });
    }

    if (!t.isPointerType()) {
      const reader = this.asReader().get(field);
      this.clear(field);
      return new DynamicOrphan({
        type: reader.getType(),
        scalarReader: reader,
      });
    }

    const rawOrphan = this.sb.disown(field.offset);
    switch (t.whichCode) {
      case TypeKind.Struct:
        return new DynamicOrphan({
          type: DynamicValueType.STRUCT,
          orphan: rawOrphan,
          structSchema: t.asStruct(),
        });
      case TypeKind.List:
        return new DynamicOrphan({
          type: DynamicValueType.LIST,
          orphan: rawOrphan,
          listSchema: t.asList(),
        });
      case TypeKind.Text:
        return new DynamicOrphan({
          type: DynamicValueType.TEXT,
          orphan: rawOrphan,
        });
      case TypeKind.Data:
        return new DynamicOrphan({
          type: DynamicValueType.DATA,
          orphan: rawOrphan,
        });
      case TypeKind.Interface:
        return new DynamicOrphan({
          type: DynamicValueType.CAPABILITY,
          orphan: rawOrphan,
          interfaceSchema: t.asInterface(),
        });
      default:
        return new DynamicOrphan({
          type: DynamicValueType.ANY_POINTER,
          orphan: rawOrphan,
        });
    }
  }

  adopt(fieldOrName: StructField | string, orphan: DynamicOrphan): void {
    const field = this.resolveField(fieldOrName);
    assertCapnp(orphan.isAlive, "ARG", "DynamicOrphan already adopted");
    this.setInUnion(field);
    const t = field.getType();

    if (field.isGroup()) {
      assertCapnp(
        orphan.type === DynamicValueType.STRUCT &&
          orphan.structSchema === t.asStruct(),
        "KIND",
        `orphan type mismatch for group '${field.name}'`,
      );
      const reader = orphan.getReader().asStruct();
      orphan.markConsumed();
      orphan.orphan?.consume();
      const dst = this.init(field).asStruct();
      copyDynamicStructFields(reader, dst);
      return;
    }

    if (!t.isPointerType()) {
      const r = orphan.getReader();
      orphan.markConsumed();
      this.set(field, r);
      return;
    }

    switch (t.whichCode) {
      case TypeKind.Text:
        assertCapnp(orphan.type === DynamicValueType.TEXT, "KIND", "expected Text orphan");
        break;
      case TypeKind.Data:
        assertCapnp(orphan.type === DynamicValueType.DATA, "KIND", "expected Data orphan");
        break;
      case TypeKind.Struct:
        assertCapnp(
          orphan.type === DynamicValueType.STRUCT &&
            orphan.structSchema === t.asStruct(),
          "KIND",
          "Struct orphan schema mismatch",
        );
        break;
      case TypeKind.List:
        assertCapnp(
          orphan.type === DynamicValueType.LIST &&
            orphan.listSchema === t.asList(),
          "KIND",
          "List orphan schema mismatch",
        );
        break;
      case TypeKind.Interface:
        assertCapnp(
          orphan.type === DynamicValueType.CAPABILITY &&
            orphan.interfaceSchema !== null &&
            orphan.interfaceSchema.extends(t.asInterface()),
          "KIND",
          "Capability orphan schema mismatch",
        );
        break;
      case TypeKind.AnyPointer:
        assertCapnp(
          orphan.orphan !== null,
          "KIND",
          "AnyPointer cannot adopt scalar orphan",
        );
        break;
    }
    orphan.markConsumed();
    this.sb.adopt(field.offset, orphan.orphan ?? Orphan.null());
  }
}

function allocDetachedSlot(builder: MessageBuilder): BuilderPointer {
  const { seg, word } = builder.allocWords(1);
  return new BuilderPointer(builder, seg, word);
}

function writeAnyPointerValue(
  sb: StructBuilder,
  ptrIndex: number,
  slot: BuilderPointer,
  val: DynamicValueReader,
): void {
  switch (val.getType()) {
    case DynamicValueType.TEXT:
      sb.setText(ptrIndex, val.asText());
      return;
    case DynamicValueType.DATA:
      sb.setData(ptrIndex, val.asData());
      return;
    case DynamicValueType.STRUCT:
      deepCopyPtrToSlot(sb.builder, slot, val.asStruct().ptr, 0);
      return;
    case DynamicValueType.LIST:
      deepCopyPtrToSlot(sb.builder, slot, val.asList().ptr, 0);
      return;
    case DynamicValueType.ANY_POINTER:
      deepCopyPtrToSlot(sb.builder, slot, val.asAnyPointer(), 0);
      return;
    case DynamicValueType.CAPABILITY: {
      const ci = val.asCapability().getCapIndex();
      sb.builder.storeW(slot.seg, slot.word, ci === null ? 0n : wpMakeCap(ci));
      return;
    }
    default:
      throw new CapnpError("KIND", `AnyPointer cannot store ${val.getType()}`);
  }
}

function copyDynamicStructFields(
  src: DynamicStructReader,
  dst: DynamicStructBuilder,
): void {
  const active = src.which();
  if (active && (active.discriminantValue !== 0 || src.has(active))) {
    dst.set(active, src.get(active));
  }
  for (const f of src.getSchema().getNonUnionFields()) {
    if (src.has(f)) {
      dst.set(f, src.get(f));
    }
  }
}

/** Read-only view over a list governed by a ListSchema, supporting list evolution. */
export class DynamicListReader implements Iterable<DynamicValueReader> {
  readonly schema: ListSchema;
  readonly ptr: Ptr;

  constructor(schema: ListSchema, ptr: Ptr) {
    assertCapnp(
      ptr.kind === PtrKind.List || ptr.kind === PtrKind.Null,
      "KIND",
      "expected list or null pointer",
    );
    this.schema = schema;
    this.ptr = ptr;
  }

  static empty(schema: ListSchema): DynamicListReader {
    const msg = emptyMessageView();
    return new DynamicListReader(schema, Ptr.nullPtr(msg, 0, 0));
  }

  getSchema(): ListSchema {
    return this.schema;
  }

  size(): number {
    return this.ptr.kind === PtrKind.List ? this.ptr.count : 0;
  }

  get length(): number {
    return this.size();
  }

  get(index: number): DynamicValueReader {
    const n = this.size();
    assertCapnp(
      Number.isInteger(index) && index >= 0 && index < n,
      "BOUNDS",
      `list index ${index} out of bounds (size ${n})`,
    );

    const elemType = this.schema.getElementType();
    if (elemType.isStruct()) {
      return DynamicValueReader.fromStruct(
        new DynamicStructReader(
          elemType.asStruct(),
          this.ptr.listGetStruct(index),
        ),
      );
    }

    const isComposite = this.ptr.esize === ElemSize.Composite;
    const compStruct = isComposite ? this.ptr.listGetStruct(index) : null;

    switch (elemType.whichCode) {
      case TypeKind.Void:
        assertCapnp(
          this.ptr.esize !== ElemSize.Bit,
          "KIND",
          "List(Bool) cannot be read as List(Void)",
        );
        return DynamicValueReader.VOID;
      case TypeKind.Bool:
        assertCapnp(
          this.ptr.esize === ElemSize.Bit ||
            this.ptr.esize === ElemSize.Byte ||
            this.ptr.esize === ElemSize.TwoBytes ||
            this.ptr.esize === ElemSize.FourBytes ||
            this.ptr.esize === ElemSize.EightBytes,
          "KIND",
          "expected bit or primitive data list for List(Bool)",
        );
        return DynamicValueReader.fromBool(this.ptr.listGetBool(index));
      case TypeKind.Int8: {
        const u = compStruct
          ? this.readCompositePrimU8(compStruct)
          : this.readPrimBytes(index, 1)[0]!;
        return DynamicValueReader.fromInt((u << 24) >> 24);
      }
      case TypeKind.UInt8: {
        const u = compStruct
          ? this.readCompositePrimU8(compStruct)
          : this.readPrimBytes(index, 1)[0]!;
        return DynamicValueReader.fromUInt(u);
      }
      case TypeKind.Int16: {
        const u = compStruct
          ? this.readCompositePrimU16(compStruct)
          : loadU16(this.readPrimBytes(index, 2), 0);
        return DynamicValueReader.fromInt((u << 16) >> 16);
      }
      case TypeKind.UInt16: {
        const u = compStruct
          ? this.readCompositePrimU16(compStruct)
          : loadU16(this.readPrimBytes(index, 2), 0);
        return DynamicValueReader.fromUInt(u);
      }
      case TypeKind.Enum: {
        const u = compStruct
          ? this.readCompositePrimU16(compStruct)
          : loadU16(this.readPrimBytes(index, 2), 0);
        return DynamicValueReader.fromEnum(
          new DynamicEnum(elemType.asEnum(), u),
        );
      }
      case TypeKind.Int32: {
        const u = compStruct
          ? this.readCompositePrimU32(compStruct)
          : loadU32(this.readPrimBytes(index, 4), 0);
        return DynamicValueReader.fromInt(u | 0);
      }
      case TypeKind.UInt32: {
        const u = compStruct
          ? this.readCompositePrimU32(compStruct)
          : loadU32(this.readPrimBytes(index, 4), 0);
        return DynamicValueReader.fromUInt(u >>> 0);
      }
      case TypeKind.Float32: {
        const f = compStruct
          ? this.readCompositePrimF32(compStruct)
          : loadF32(this.readPrimBytes(index, 4), 0);
        return DynamicValueReader.fromFloat(f);
      }
      case TypeKind.Int64: {
        const u = compStruct
          ? this.readCompositePrimU64(compStruct)
          : loadU64(this.readPrimBytes(index, 8), 0);
        return DynamicValueReader.fromInt(BigInt.asIntN(64, u));
      }
      case TypeKind.UInt64: {
        const u = compStruct
          ? this.readCompositePrimU64(compStruct)
          : loadU64(this.readPrimBytes(index, 8), 0);
        return DynamicValueReader.fromUInt(u);
      }
      case TypeKind.Float64: {
        const f = compStruct
          ? this.readCompositePrimF64(compStruct)
          : loadF64(this.readPrimBytes(index, 8), 0);
        return DynamicValueReader.fromFloat(f);
      }
      case TypeKind.Text:
        if (compStruct) {
          assertCapnp(
            this.ptr.pwords >= 1,
            "KIND",
            "expected pointer list, got data-only struct list",
          );
          return DynamicValueReader.fromText(readPtrAsText(compStruct.getP(0), ""));
        }
        return DynamicValueReader.fromText(readPtrAsText(this.readPtrElem(index), ""));
      case TypeKind.Data: {
        const p = compStruct
          ? this.readCompositePtr(compStruct)
          : this.readPtrElem(index);
        return DynamicValueReader.fromData(readPtrAsData(p, EMPTY_BYTES));
      }
      case TypeKind.List: {
        const p = compStruct
          ? this.readCompositePtr(compStruct)
          : this.readPtrElem(index);
        return DynamicValueReader.fromList(
          new DynamicListReader(elemType.asList(), p),
        );
      }
      case TypeKind.Interface: {
        const p = compStruct
          ? this.readCompositePtr(compStruct)
          : this.readPtrElem(index);
        if (p.isNull) {
          return DynamicValueReader.fromCapability(
            new DynamicCapabilityClient(elemType.asInterface(), null),
          );
        }
        assertCapnp(p.kind === PtrKind.Cap, "KIND", "expected capability pointer");
        return DynamicValueReader.fromCapability(
          new DynamicCapabilityClient(elemType.asInterface(), p.count),
        );
      }
      case TypeKind.AnyPointer: {
        const p = compStruct
          ? this.readCompositePtr(compStruct)
          : this.readPtrElem(index);
        return DynamicValueReader.fromAnyPointer(p);
      }
      default:
        return DynamicValueReader.UNKNOWN;
    }
  }

  private assertCompositeData(): void {
    assertCapnp(
      this.ptr.dwords >= 1,
      "KIND",
      "expected primitive list, got pointer-only struct list",
    );
  }

  private readCompositePrimU8(el: Ptr): number {
    this.assertCompositeData();
    return el.getU8(0);
  }

  private readCompositePrimU16(el: Ptr): number {
    this.assertCompositeData();
    return el.getU16(0);
  }

  private readCompositePrimU32(el: Ptr): number {
    this.assertCompositeData();
    return el.getU32(0);
  }

  private readCompositePrimF32(el: Ptr): number {
    this.assertCompositeData();
    return el.getF32(0);
  }

  private readCompositePrimU64(el: Ptr): bigint {
    this.assertCompositeData();
    return el.getU64(0);
  }

  private readCompositePrimF64(el: Ptr): number {
    this.assertCompositeData();
    return el.getF64(0);
  }

  private readCompositePtr(el: Ptr): Ptr {
    assertCapnp(
      this.ptr.pwords >= 1,
      "KIND",
      "expected pointer list, got data-only struct list",
    );
    return el.getP(0);
  }

  private readPrimBytes(index: number, minBytes: number): Uint8Array {
    let srcBytes = 0;
    switch (this.ptr.esize) {
      case ElemSize.Byte:
        srcBytes = 1;
        break;
      case ElemSize.TwoBytes:
        srcBytes = 2;
        break;
      case ElemSize.FourBytes:
        srcBytes = 4;
        break;
      case ElemSize.EightBytes:
        srcBytes = 8;
        break;
      default:
        throw new CapnpError(
          "KIND",
          `list element size mismatch: wire=${this.ptr.esize} expected>=${minBytes}B`,
        );
    }
    assertCapnp(
      srcBytes >= minBytes,
      "KIND",
      `list element width ${srcBytes}B smaller than requested ${minBytes}B`,
    );
    const s = this.ptr.msg.segs[this.ptr.seg]!;
    const off = this.ptr.word * WORD_BYTES + index * srcBytes;
    return s.data.subarray(off, off + minBytes);
  }

  private readPtrElem(index: number): Ptr {
    assertCapnp(
      this.ptr.esize === ElemSize.Pointer,
      "KIND",
      "expected pointer list",
    );
    return this.ptr.listGetP(index);
  }

  *[Symbol.iterator](): Iterator<DynamicValueReader> {
    const n = this.size();
    for (let i = 0; i < n; i++) {
      yield this.get(i);
    }
  }

  toArray(): DynamicValueReader[] {
    return [...this];
  }
}

/** Mutable view over a list inside a MessageBuilder. */
export class DynamicListBuilder implements Iterable<DynamicValueBuilder> {
  readonly builder: MessageBuilder;
  readonly schema: ListSchema;
  readonly seg: number;
  /** First element word (for composite: tagWord + 1). */
  readonly word: number;
  readonly esize: number;
  readonly count: number;
  readonly elemDwords: number;
  readonly elemPwords: number;

  private constructor(init: {
    builder: MessageBuilder;
    schema: ListSchema;
    seg: number;
    word: number;
    esize: number;
    count: number;
    elemDwords: number;
    elemPwords: number;
  }) {
    this.builder = init.builder;
    this.schema = init.schema;
    this.seg = init.seg;
    this.word = init.word;
    this.esize = init.esize;
    this.count = init.count;
    this.elemDwords = init.elemDwords;
    this.elemPwords = init.elemPwords;
  }

  static empty(builder: MessageBuilder, schema: ListSchema): DynamicListBuilder {
    return new DynamicListBuilder({
      builder,
      schema,
      seg: 0,
      word: 0,
      esize: schema.wireElementSize(),
      count: 0,
      elemDwords: schema.getElementType().isStruct()
        ? schema.getStructElementType().dataWordCount
        : 0,
      elemPwords: schema.getElementType().isStruct()
        ? schema.getStructElementType().pointerCount
        : 0,
    });
  }

  /** @internal */
  static fromResolvedOrphan(
    builder: MessageBuilder,
    schema: ListSchema,
    orphan: Orphan,
  ): DynamicListBuilder {
    if (orphan.esize === ElemSize.Composite) {
      const tag = builder.loadW(orphan.seg, orphan.word);
      const nelem = wpCompositeElementCount(tag);
      const dw = Number((tag >> 32n) & 0xffffn);
      const pw = Number((tag >> 48n) & 0xffffn);
      return new DynamicListBuilder({
        builder,
        schema,
        seg: orphan.seg,
        word: orphan.word + 1,
        esize: ElemSize.Composite,
        count: nelem,
        elemDwords: dw,
        elemPwords: pw,
      });
    }
    return new DynamicListBuilder({
      builder,
      schema,
      seg: orphan.seg,
      word: orphan.word,
      esize: orphan.esize,
      count: orphan.count,
      elemDwords: 0,
      elemPwords: 0,
    });
  }

  /** @internal */
  static allocateCompositeAtSlot(
    builder: MessageBuilder,
    slot: BuilderPointer,
    schema: ListSchema,
    count: number,
    dw: number,
    pw: number,
  ): DynamicListBuilder {
    const step = dw + pw;
    const contentWords = compositeContentWords(count, step);
    const { seg: tagSeg, word: tagWord } = builder.allocWords(1 + contentWords);
    builder.storeW(tagSeg, tagWord, wpMakeStruct(count | 0, dw, pw));
    builder.writeListPtr(
      slot.seg,
      slot.word,
      tagSeg,
      tagWord,
      ElemSize.Composite,
      contentWords,
    );
    return new DynamicListBuilder({
      builder,
      schema,
      seg: tagSeg,
      word: tagWord + 1,
      esize: ElemSize.Composite,
      count,
      elemDwords: dw,
      elemPwords: pw,
    });
  }

  /** @internal */
  static allocateAtSlot(
    builder: MessageBuilder,
    slot: BuilderPointer,
    schema: ListSchema,
    count: number,
  ): DynamicListBuilder {
    assertListElementCount(count);
    const elemType = schema.getElementType();
    const esize = schema.wireElementSize();

    if (elemType.isStruct()) {
      const st = elemType.asStruct();
      return DynamicListBuilder.allocateCompositeAtSlot(
        builder,
        slot,
        schema,
        count,
        st.dataWordCount,
        st.pointerCount,
      );
    }

    if (esize === ElemSize.Pointer) {
      let listSeg: number;
      let listWord: number;
      if (count > 0) {
        ({ seg: listSeg, word: listWord } = builder.allocWords(count));
      } else {
        listSeg = slot.seg;
        listWord = slot.word + 1;
      }
      builder.writeListPtr(
        slot.seg,
        slot.word,
        listSeg,
        listWord,
        ElemSize.Pointer,
        count,
      );
      return new DynamicListBuilder({
        builder,
        schema,
        seg: listSeg,
        word: listWord,
        esize: ElemSize.Pointer,
        count,
        elemDwords: 0,
        elemPwords: 0,
      });
    }

    const stepBits = listStepBits(esize);
    const { nwords } = primitiveBodySize(count, stepBits);
    let startSeg: number;
    let startWord: number;
    if (nwords > 0) {
      ({ seg: startSeg, word: startWord } = builder.allocWords(nwords));
      const d = builder.segBytes(startSeg);
      d.fill(0, startWord * WORD_BYTES, (startWord + nwords) * WORD_BYTES);
    } else {
      startSeg = slot.seg;
      startWord = slot.word + 1;
    }
    builder.writeListPtr(slot.seg, slot.word, startSeg, startWord, esize, count);
    return new DynamicListBuilder({
      builder,
      schema,
      seg: startSeg,
      word: startWord,
      esize,
      count,
      elemDwords: 0,
      elemPwords: 0,
    });
  }

  getSchema(): ListSchema {
    return this.schema;
  }

  size(): number {
    return this.count;
  }

  get length(): number {
    return this.count;
  }

  asReader(): DynamicListReader {
    if (this.count === 0 && this.seg === 0 && this.word === 0) {
      return DynamicListReader.empty(this.schema);
    }
    const msg = builderMessageView(this.builder);
    const step = this.elemDwords + this.elemPwords;
    const p = Ptr.list(
      msg,
      this.seg,
      this.word,
      this.esize,
      this.count,
      this.elemDwords,
      this.elemPwords,
      step,
    );
    return new DynamicListReader(this.schema, p);
  }

  private checkIndex(index: number): void {
    assertCapnp(
      Number.isInteger(index) && index >= 0 && index < this.count,
      "BOUNDS",
      `list index ${index} out of bounds (size ${this.count})`,
    );
  }

  get(index: number): DynamicValueBuilder {
    this.checkIndex(index);
    const elemType = this.schema.getElementType();

    if (elemType.isStruct()) {
      assertCapnp(
        this.esize === ElemSize.Composite,
        "KIND",
        "cannot mutate upgraded non-composite struct list in place",
      );
      const step = this.elemDwords + this.elemPwords;
      const sb = new StructBuilder(
        this.builder,
        this.seg,
        this.word + index * step,
        this.elemDwords,
        this.elemPwords,
      );
      return new DynamicValueBuilder(
        DynamicValueType.STRUCT,
        new DynamicStructBuilder(elemType.asStruct(), sb),
      );
    }

    if (elemType.isList()) {
      const slot = new BuilderPointer(this.builder, this.seg, this.pointerWord(index));
      const resolved = this.builder.resolveSlot(slot);
      const innerSchema = elemType.asList();
      if (resolved.isNull) {
        return new DynamicValueBuilder(
          DynamicValueType.LIST,
          DynamicListBuilder.empty(this.builder, innerSchema),
        );
      }
      // List(List(Struct)) must upgrade an older inner struct list the same
      // way a struct field that is List(Struct) does. Otherwise a write of a
      // field the new schema added fails.
      if (innerSchema.getElementType().isStruct()) {
        const upgraded = upgradeStructListAtSlot(
          this.builder,
          slot,
          innerSchema,
          resolved,
        );
        if (upgraded) {
          return new DynamicValueBuilder(DynamicValueType.LIST, upgraded);
        }
      }
      return new DynamicValueBuilder(
        DynamicValueType.LIST,
        DynamicListBuilder.fromResolvedOrphan(
          this.builder,
          innerSchema,
          resolved,
        ),
      );
    }

    if (elemType.isAnyPointer()) {
      return new DynamicValueBuilder(
        DynamicValueType.ANY_POINTER,
        new BuilderPointer(this.builder, this.seg, this.pointerWord(index)),
      );
    }

    const r = this.asReader().get(index);
    return new DynamicValueBuilder(
      r.getType(),
      r.getType() === DynamicValueType.VOID
        ? undefined
        : r.getType() === DynamicValueType.BOOL
          ? r.asBool()
          : r.getType() === DynamicValueType.INT ||
              r.getType() === DynamicValueType.UINT
            ? r.asBigInt()
            : r.getType() === DynamicValueType.FLOAT
              ? r.asFloat64()
              : r.getType() === DynamicValueType.TEXT
                ? r.asText()
                : r.getType() === DynamicValueType.DATA
                  ? r.asData()
                  : r.getType() === DynamicValueType.ENUM
                    ? r.asEnum()
                    : r.asCapability(),
    );
  }

  init(index: number, subSize: number): DynamicValueBuilder {
    this.checkIndex(index);
    assertCapnp(
      Number.isInteger(subSize) && subSize >= 0,
      "ARG",
      `invalid sub-list size ${subSize}`,
    );
    const elemType = this.schema.getElementType();
    // Composite lists, including ones upgraded from a primitive list, keep
    // the blob in the element's pointer section. pointerWord rejects a
    // data-only element the way C++ ListBuilder does.
    const slot = new BuilderPointer(this.builder, this.seg, this.pointerWord(index));

    if (elemType.isList()) {
      return new DynamicValueBuilder(
        DynamicValueType.LIST,
        DynamicListBuilder.allocateAtSlot(
          this.builder,
          slot,
          elemType.asList(),
          subSize,
        ),
      );
    }
    if (elemType.isData()) {
      assertDataBlobSize(subSize, "integer overflow");
      writeDataToSlot(this.builder, slot, new Uint8Array(subSize));
      // C++ Data::Builder is a view of the bytes just allocated in the message.
      const resolved = this.builder.resolveSlot(slot);
      const start = resolved.word * WORD_BYTES;
      const slice = this.builder.segBytes(resolved.seg).subarray(start, start + subSize);
      return new DynamicValueBuilder(DynamicValueType.DATA, slice);
    }
    if (elemType.isText()) {
      assertTextBlobSize(subSize, "integer overflow");
      writeTextToSlot(this.builder, slot, "\0".repeat(subSize));
      return new DynamicValueBuilder(DynamicValueType.TEXT, "\0".repeat(subSize));
    }
    throw new CapnpError(
      "ARG",
      `list init(index, size) requires List, Text, or Data element (got ${elemType.which})`,
    );
  }

  /**
   * Byte offset of a primitive in element `index`. Composite lists store it
   * at the start of that struct's data section. Any other list uses the
   * wire element stride, which may be wider than the schema type.
   */
  private primByte(index: number, width: number): number {
    if (this.esize === ElemSize.Composite) {
      // C++ ListBuilder accepts a primitive on a composite element only when
      // the data section is at least one word (every primitive fits) and
      // rejects a pointer-only element. A primitive list upgraded to a
      // struct keeps that one word; a pointer list upgraded in place does not.
      assertCapnp(
        this.elemDwords * WORD_BYTES >= width,
        "SCHEMA",
        "Schema mismatch: Expected a primitive list, but got a list of pointer-only structs.",
      );
      const step = this.elemDwords + this.elemPwords;
      return (this.word + index * step) * WORD_BYTES;
    }
    const stride = dataListStride(this.esize);
    assertCapnp(
      stride >= width,
      "SCHEMA",
      "Schema mismatch: Message contained list with incompatible element type.",
    );
    return this.word * WORD_BYTES + index * stride;
  }

  /** Word of pointer 0 in element `index`. */
  private pointerWord(index: number): number {
    if (this.esize === ElemSize.Composite) {
      assertCapnp(
        this.elemPwords >= 1,
        "SCHEMA",
        "Schema mismatch: Expected a pointer list, but got a list of data-only structs.",
      );
      const step = this.elemDwords + this.elemPwords;
      return this.word + index * step + this.elemDwords;
    }
    assertCapnp(this.esize === ElemSize.Pointer, "KIND", "expected pointer list");
    return this.word + index;
  }

  set(index: number, rawInput: DynamicSetValue): void {
    this.checkIndex(index);
    const elemType = this.schema.getElementType();

    if (Array.isArray(rawInput)) {
      assertCapnp(elemType.isList(), "KIND", "cannot assign array to non-list element");
      const sub = this.init(index, rawInput.length).asList();
      for (let i = 0; i < rawInput.length; i++) {
        sub.set(i, rawInput[i]!);
      }
      return;
    }

    if (elemType.isStruct()) {
      const st = elemType.asStruct();
      // C++ getWritableStructListPointer refuses to write a struct into a
      // composite element that is smaller than the schema, including a list
      // upgraded from a primitive (one data word, no pointers).
      if (this.esize === ElemSize.Composite) {
        assertCapnp(
          this.elemDwords >= st.dataWordCount && this.elemPwords >= st.pointerCount,
          "SCHEMA",
          "Schema mismatch: Existing list value is incompatible with expected type.",
        );
      }
      const src = coerceStructReader(rawInput, st);
      const dst = this.get(index).asStruct();
      // Zero existing inline element body and copy active fields
      const step = this.elemDwords + this.elemPwords;
      const elWord = this.word + index * step;
      const segBytes = this.builder.segBytes(this.seg);
      segBytes.fill(0, elWord * WORD_BYTES, (elWord + step) * WORD_BYTES);
      copyDynamicStructFields(src, dst);
      return;
    }

    const val = coerceToDynamicReader(rawInput, elemType);
    const data = this.builder.segBytes(this.seg);

    switch (elemType.whichCode) {
      case TypeKind.Void:
        val.asVoid();
        return;
      case TypeKind.Bool: {
        if (this.esize === ElemSize.Composite) {
          throw new CapnpError(
            "SCHEMA",
            "Schema mismatch: Found struct list where bit list was expected; upgrading boolean lists to structs is no longer supported.",
          );
        }
        if (
          this.esize !== ElemSize.Bit &&
          this.esize !== ElemSize.Byte &&
          this.esize !== ElemSize.TwoBytes &&
          this.esize !== ElemSize.FourBytes &&
          this.esize !== ElemSize.EightBytes
        ) {
          throw new CapnpError(
            "SCHEMA",
            "Schema mismatch: Expected a primitive list where bool elements can be stored.",
          );
        }
        // C++ ListReader::getDataElement<bool> ignores element step and reads
        // packed bits. Writes follow that layout.
        const b = val.asBool();
        const byteIdx = this.word * WORD_BYTES + (index >>> 3);
        const mask = 1 << (index & 7);
        if (b) data[byteIdx] = data[byteIdx]! | mask;
        else data[byteIdx] = data[byteIdx]! & ~mask;
        return;
      }
      case TypeKind.Int8:
        data[this.primByte(index, 1)] = val.asInt8() & 0xff;
        return;
      case TypeKind.UInt8:
        data[this.primByte(index, 1)] = val.asUInt8() & 0xff;
        return;
      case TypeKind.Int16:
        storeU16(data, this.primByte(index, 2), val.asInt16() & 0xffff);
        return;
      case TypeKind.UInt16:
        storeU16(data, this.primByte(index, 2), val.asUInt16());
        return;
      case TypeKind.Enum: {
        const enumSchema = elemType.asEnum();
        let ord: number;
        if (val.getType() === DynamicValueType.TEXT) {
          ord = enumSchema.getEnumerantByName(val.asText()).getOrdinal();
        } else if (
          val.getType() === DynamicValueType.INT ||
          val.getType() === DynamicValueType.UINT
        ) {
          ord = val.asUInt16();
        } else {
          const ev = val.asEnum();
          assertCapnp(ev.getSchema() === enumSchema, "KIND", "enum schema mismatch");
          ord = ev.getRaw();
        }
        storeU16(data, this.primByte(index, 2), ord);
        return;
      }
      case TypeKind.Int32:
        storeU32(data, this.primByte(index, 4), val.asInt32() >>> 0);
        return;
      case TypeKind.UInt32:
        storeU32(data, this.primByte(index, 4), val.asUInt32());
        return;
      case TypeKind.Float32:
        storeF32(data, this.primByte(index, 4), val.asFloat32());
        return;
      case TypeKind.Int64:
        storeU64(data, this.primByte(index, 8), BigInt.asUintN(64, val.asInt64()));
        return;
      case TypeKind.UInt64:
        storeU64(data, this.primByte(index, 8), val.asUInt64());
        return;
      case TypeKind.Float64:
        storeF64(data, this.primByte(index, 8), val.asFloat64());
        return;
      case TypeKind.Text: {
        const slot = new BuilderPointer(this.builder, this.seg, this.pointerWord(index));
        writeTextToSlot(this.builder, slot, val.asText());
        return;
      }
      case TypeKind.Data: {
        const slot = new BuilderPointer(this.builder, this.seg, this.pointerWord(index));
        writeDataToSlot(this.builder, slot, val.asData());
        return;
      }
      case TypeKind.List: {
        const lv = val.asList();
        assertCapnp(lv.getSchema() === elemType.asList(), "KIND", "list schema mismatch");
        const slot = new BuilderPointer(this.builder, this.seg, this.pointerWord(index));
        deepCopyPtrToSlot(this.builder, slot, lv.ptr, 0);
        return;
      }
      case TypeKind.Interface: {
        const cv = val.asCapability();
        assertCapnp(
          cv.getSchema().extends(elemType.asInterface()),
          "KIND",
          "capability schema mismatch",
        );
        const ci = cv.getCapIndex();
        this.builder.storeW(
          this.seg,
          this.pointerWord(index),
          ci === null ? 0n : wpMakeCap(ci),
        );
        return;
      }
      case TypeKind.AnyPointer: {
        const word = this.pointerWord(index);
        const slot = new BuilderPointer(this.builder, this.seg, word);
        const tempSb = new StructBuilder(this.builder, this.seg, word, 0, 1);
        writeAnyPointerValue(tempSb, 0, slot, val);
        return;
      }
    }
  }

  disown(index: number): DynamicOrphan {
    this.checkIndex(index);
    const elemType = this.schema.getElementType();

    if (elemType.isStruct()) {
      const st = elemType.asStruct();
      const src = this.get(index).asStruct();
      const tempSlot = allocDetachedSlot(this.builder);
      const dstSb = this.builder.initStructAt(
        tempSlot,
        st.dataWordCount,
        st.pointerCount,
      );
      const dst = new DynamicStructBuilder(st, dstSb);
      copyDynamicStructFields(src.asReader(), dst);
      const step = this.elemDwords + this.elemPwords;
      const elWord = this.word + index * step;
      this.builder
        .segBytes(this.seg)
        .fill(0, elWord * WORD_BYTES, (elWord + step) * WORD_BYTES);
      return new DynamicOrphan({
        type: DynamicValueType.STRUCT,
        orphan: this.builder.disown(tempSlot),
        structSchema: st,
      });
    }

    if (!elemType.isPointerType()) {
      const r = this.asReader().get(index);
      this.set(index, defaultZeroForType(elemType));
      return new DynamicOrphan({ type: r.getType(), scalarReader: r });
    }

    const slot = new BuilderPointer(this.builder, this.seg, this.pointerWord(index));
    const rawOrphan = this.builder.disown(slot);
    if (elemType.isList()) {
      return new DynamicOrphan({
        type: DynamicValueType.LIST,
        orphan: rawOrphan,
        listSchema: elemType.asList(),
      });
    }
    if (elemType.isText()) {
      return new DynamicOrphan({ type: DynamicValueType.TEXT, orphan: rawOrphan });
    }
    if (elemType.isData()) {
      return new DynamicOrphan({ type: DynamicValueType.DATA, orphan: rawOrphan });
    }
    if (elemType.isInterface()) {
      return new DynamicOrphan({
        type: DynamicValueType.CAPABILITY,
        orphan: rawOrphan,
        interfaceSchema: elemType.asInterface(),
      });
    }
    return new DynamicOrphan({
      type: DynamicValueType.ANY_POINTER,
      orphan: rawOrphan,
    });
  }

  adopt(index: number, orphan: DynamicOrphan): void {
    this.checkIndex(index);
    assertCapnp(orphan.isAlive, "ARG", "DynamicOrphan already adopted");
    const elemType = this.schema.getElementType();

    if (elemType.isStruct() || !elemType.isPointerType()) {
      const r = orphan.getReader();
      orphan.markConsumed();
      orphan.orphan?.consume();
      this.set(index, r);
      return;
    }

    const slot = new BuilderPointer(this.builder, this.seg, this.pointerWord(index));
    orphan.markConsumed();
    this.builder.adopt(slot, orphan.orphan ?? Orphan.null());
  }

  *[Symbol.iterator](): Iterator<DynamicValueBuilder> {
    for (let i = 0; i < this.count; i++) {
      yield this.get(i);
    }
  }
}

function dataListStride(esize: number): number {
  switch (esize) {
    case ElemSize.Byte:
      return 1;
    case ElemSize.TwoBytes:
      return 2;
    case ElemSize.FourBytes:
      return 4;
    case ElemSize.EightBytes:
      return 8;
    default:
      return 0;
  }
}

function defaultZeroForType(t: Type): DynamicValueReader {
  switch (t.whichCode) {
    case TypeKind.Void:
      return DynamicValueReader.VOID;
    case TypeKind.Bool:
      return DynamicValueReader.fromBool(false);
    case TypeKind.Int8:
    case TypeKind.Int16:
    case TypeKind.Int32:
    case TypeKind.Int64:
      return DynamicValueReader.fromInt(0n);
    case TypeKind.UInt8:
    case TypeKind.UInt16:
    case TypeKind.UInt32:
    case TypeKind.UInt64:
      return DynamicValueReader.fromUInt(0n);
    case TypeKind.Float32:
    case TypeKind.Float64:
      return DynamicValueReader.fromFloat(0);
    case TypeKind.Enum:
      return DynamicValueReader.fromEnum(new DynamicEnum(t.asEnum(), 0));
    default:
      return DynamicValueReader.UNKNOWN;
  }
}

function writeTextToSlot(
  builder: MessageBuilder,
  slot: BuilderPointer,
  text: string,
): void {
  const enc = new TextEncoder().encode(text);
  assertTextBlobSize(enc.length, "text blob too big");
  const nbytes = enc.length + 1;
  const nwords = bytesToWords(nbytes);
  const { seg, word } = builder.allocWords(nwords);
  const data = builder.segBytes(seg);
  const base = word * WORD_BYTES;
  data.fill(0, base, base + nwords * WORD_BYTES);
  data.set(enc, base);
  builder.writeListPtr(slot.seg, slot.word, seg, word, ElemSize.Byte, nbytes);
}

function writeDataToSlot(
  builder: MessageBuilder,
  slot: BuilderPointer,
  bytes: Uint8Array,
): void {
  assertDataBlobSize(bytes.length, "text blob too big");
  const nwords = bytesToWords(bytes.length);
  let seg: number;
  let word: number;
  if (nwords > 0) {
    ({ seg, word } = builder.allocWords(nwords));
    const data = builder.segBytes(seg);
    const base = word * WORD_BYTES;
    data.fill(0, base, base + nwords * WORD_BYTES);
    data.set(bytes, base);
  } else {
    seg = slot.seg;
    word = slot.word + 1;
  }
  builder.writeListPtr(
    slot.seg,
    slot.word,
    seg,
    word,
    ElemSize.Byte,
    bytes.length,
  );
}

function coerceStructReader(
  input: DynamicSetValue,
  expected: StructSchema,
): DynamicStructReader {
  if (input instanceof DynamicStructReader) {
    assertCapnp(input.getSchema() === expected, "KIND", "struct schema mismatch");
    return input;
  }
  if (input instanceof DynamicStructBuilder) {
    assertCapnp(input.getSchema() === expected, "KIND", "struct schema mismatch");
    return input.asReader();
  }
  if (input instanceof DynamicValueReader) {
    const sr = input.asStruct();
    assertCapnp(sr.getSchema() === expected, "KIND", "struct schema mismatch");
    return sr;
  }
  if (input instanceof DynamicValueBuilder) {
    const sr = input.asReader().asStruct();
    assertCapnp(sr.getSchema() === expected, "KIND", "struct schema mismatch");
    return sr;
  }
  throw new CapnpError("KIND", `expected struct ${expected.getShortDisplayName()}`);
}

function coerceToDynamicReader(
  input: DynamicSetValue,
  targetType: Type,
): DynamicValueReader {
  if (input instanceof DynamicValueReader) return input;
  if (input instanceof DynamicValueBuilder) return input.asReader();
  if (input instanceof DynamicStructReader) {
    return DynamicValueReader.fromStruct(input);
  }
  if (input instanceof DynamicStructBuilder) {
    return DynamicValueReader.fromStruct(input.asReader());
  }
  if (input instanceof DynamicListReader) {
    return DynamicValueReader.fromList(input);
  }
  if (input instanceof DynamicListBuilder) {
    return DynamicValueReader.fromList(input.asReader());
  }
  if (input instanceof DynamicEnum) {
    return DynamicValueReader.fromEnum(input);
  }
  if (input instanceof DynamicCapabilityClient) {
    return DynamicValueReader.fromCapability(input);
  }
  if (input instanceof DynamicCapabilityServer) {
    return DynamicValueReader.fromCapability(
      new DynamicCapabilityClient(input.getSchema(), input),
    );
  }
  if (input instanceof Ptr) {
    return DynamicValueReader.fromAnyPointer(input);
  }
  if (input === null || input === undefined) {
    return DynamicValueReader.VOID;
  }
  if (typeof input === "boolean") {
    return DynamicValueReader.fromBool(input);
  }
  if (typeof input === "bigint") {
    return input < 0n
      ? DynamicValueReader.fromInt(input)
      : DynamicValueReader.fromUInt(input);
  }
  if (typeof input === "number") {
    if (targetType.isFloat32() || targetType.isFloat64()) {
      return DynamicValueReader.fromFloat(input);
    }
    if (Number.isFinite(input) && Math.trunc(input) === input) {
      return input < 0
        ? DynamicValueReader.fromInt(BigInt(input))
        : DynamicValueReader.fromUInt(BigInt(input));
    }
    return DynamicValueReader.fromFloat(input);
  }
  if (typeof input === "string") {
    return DynamicValueReader.fromText(input);
  }
  if (input instanceof Uint8Array) {
    return DynamicValueReader.fromData(input);
  }
  throw new CapnpError("ARG", "unsupported dynamic value input");
}

/** Open the root of a Message as a DynamicStructReader. */
export function readDynamicRoot(
  msg: Message,
  schema: StructSchema,
): DynamicStructReader {
  return new DynamicStructReader(schema, msg.root());
}

/** Allocate and return a root DynamicStructBuilder on a fresh MessageBuilder. */
export function initDynamicRoot(
  builder: MessageBuilder,
  schema: StructSchema,
): DynamicStructBuilder {
  const sb = builder.initRoot(schema.dataWordCount, schema.pointerCount);
  return new DynamicStructBuilder(schema, sb);
}

function upgradeStructListAtSlot(
  builder: MessageBuilder,
  slot: BuilderPointer,
  listSchema: ListSchema,
  resolved: Orphan,
): DynamicListBuilder | null {
  const subSchema = listSchema.getStructElementType();

  if (resolved.esize === ElemSize.Composite) {
    const tag = builder.loadW(resolved.seg, resolved.word);
    const nelem = wpCompositeElementCount(tag);
    const dw = Number((tag >> 32n) & 0xffffn);
    const pw = Number((tag >> 48n) & 0xffffn);
    if (dw >= subSchema.dataWordCount && pw >= subSchema.pointerCount) {
      return null;
    }

    const oldOrphan = builder.disown(slot);
    const newDw = Math.max(dw, subSchema.dataWordCount);
    const newPw = Math.max(pw, subSchema.pointerCount);
    const lb = DynamicListBuilder.allocateCompositeAtSlot(
      builder,
      slot,
      listSchema,
      nelem,
      newDw,
      newPw,
    );
    const oldStep = dw + pw;
    const newStep = newDw + newPw;
    const dstSeg = builder.segBytes(lb.seg);
    const srcSeg = builder.segBytes(oldOrphan.seg);
    for (let i = 0; i < nelem; i++) {
      const srcElWord = oldOrphan.word + 1 + i * oldStep;
      const dstElWord = lb.word + i * newStep;
      if (dw > 0) {
        dstSeg.set(
          srcSeg.subarray(srcElWord * WORD_BYTES, (srcElWord + dw) * WORD_BYTES),
          dstElWord * WORD_BYTES,
        );
      }
      for (let k = 0; k < pw; k++) {
        const subOrphan = builder.disown(
          new BuilderPointer(builder, oldOrphan.seg, srcElWord + dw + k),
        );
        builder.adopt(
          new BuilderPointer(builder, lb.seg, dstElWord + newDw + k),
          subOrphan,
        );
      }
    }
    oldOrphan.consume();
    return lb;
  }

  if (resolved.esize === ElemSize.Bit) {
    throw new CapnpError("KIND", "List(Bool) cannot upgrade to struct list");
  }

  const elemBytes =
    resolved.esize === ElemSize.Byte
      ? 1
      : resolved.esize === ElemSize.TwoBytes
        ? 2
        : resolved.esize === ElemSize.FourBytes
          ? 4
          : resolved.esize === ElemSize.EightBytes
            ? 8
            : 0;
  const nelem = resolved.count;
  const newDw = Math.max(subSchema.dataWordCount, elemBytes > 0 ? 1 : 0);
  const newPw = Math.max(
    subSchema.pointerCount,
    resolved.esize === ElemSize.Pointer ? 1 : 0,
  );
  const oldOrphan = builder.disown(slot);
  const lb = DynamicListBuilder.allocateCompositeAtSlot(
    builder,
    slot,
    listSchema,
    nelem,
    newDw,
    newPw,
  );
  const newStep = newDw + newPw;
  if (resolved.esize === ElemSize.Pointer) {
    for (let i = 0; i < nelem; i++) {
      const subOrphan = builder.disown(
        new BuilderPointer(builder, oldOrphan.seg, oldOrphan.word + i),
      );
      builder.adopt(
        new BuilderPointer(builder, lb.seg, lb.word + i * newStep + newDw),
        subOrphan,
      );
    }
  } else if (elemBytes > 0) {
    const srcSeg = builder.segBytes(oldOrphan.seg);
    const dstSeg = builder.segBytes(lb.seg);
    for (let i = 0; i < nelem; i++) {
      const srcOff = oldOrphan.word * WORD_BYTES + i * elemBytes;
      const dstOff = (lb.word + i * newStep) * WORD_BYTES;
      dstSeg.set(srcSeg.subarray(srcOff, srcOff + elemBytes), dstOff);
    }
  }
  oldOrphan.consume();
  return lb;
}

/** Deep-copy a DynamicStructReader as the root of a fresh MessageBuilder. */
export function setDynamicRoot(
  builder: MessageBuilder,
  value: DynamicStructReader,
): void {
  const slot = builder.rootSlot();
  deepCopyPtrToSlot(builder, slot, value.ptr, 0);
}

/**
 * Copy an existing struct or message root into a fresh `MessageBuilder`,
 * upgrading its root word counts to at least `schema`'s dimensions.
 */
export function upgradeDynamicRoot(
  builder: MessageBuilder,
  source: Message | DynamicStructReader | Ptr,
  schema: StructSchema,
): DynamicStructBuilder {
  const srcPtr =
    source instanceof Message
      ? source.root()
      : source instanceof DynamicStructReader
        ? source.ptr
        : source;
  if (srcPtr.kind === PtrKind.Null) {
    return initDynamicRoot(builder, schema);
  }
  assertCapnp(
    srcPtr.kind === PtrKind.Struct,
    "KIND",
    `expected struct or null pointer for ${schema.getShortDisplayName()}`,
  );
  const newDw = Math.max(srcPtr.dwords, schema.dataWordCount);
  const newPw = Math.max(srcPtr.pwords, schema.pointerCount);
  const sb = builder.initRoot(newDw, newPw);
  const copyBytes =
    srcPtr.dataBits > 0
      ? Math.min(srcPtr.dwords * WORD_BYTES, (srcPtr.dataBits + 7) >>> 3)
      : srcPtr.dwords * WORD_BYTES;
  if (copyBytes > 0) {
    const srcSeg = srcPtr.msg.segs[srcPtr.seg]!;
    const srcOff = srcPtr.word * WORD_BYTES + (srcPtr.bodyByte || 0);
    builder
      .segBytes(sb.seg)
      .set(srcSeg.data.subarray(srcOff, srcOff + copyBytes), sb.word * WORD_BYTES);
  }
  for (let k = 0; k < srcPtr.pwords; k++) {
    deepCopyPtrToSlot(builder, sb.slot(k), srcPtr.getP(k), 0);
  }
  return new DynamicStructBuilder(schema, sb);
}

/** Allocate a detached struct orphan inside `builder`. */
export function newDynamicStructOrphan(
  builder: MessageBuilder,
  schema: StructSchema,
): { orphan: DynamicOrphan; builder: DynamicStructBuilder } {
  const tempSlot = allocDetachedSlot(builder);
  const sb = builder.initStructAt(
    tempSlot,
    schema.dataWordCount,
    schema.pointerCount,
  );
  const rawOrphan = builder.disown(tempSlot);
  return {
    orphan: new DynamicOrphan({
      type: DynamicValueType.STRUCT,
      orphan: rawOrphan,
      structSchema: schema,
    }),
    builder: new DynamicStructBuilder(schema, sb),
  };
}

/** Allocate a detached list orphan inside `builder`. */
export function newDynamicListOrphan(
  builder: MessageBuilder,
  schema: ListSchema,
  size: number,
): { orphan: DynamicOrphan; builder: DynamicListBuilder } {
  const tempSlot = allocDetachedSlot(builder);
  const lb = DynamicListBuilder.allocateAtSlot(builder, tempSlot, schema, size);
  const rawOrphan = builder.disown(tempSlot);
  return {
    orphan: new DynamicOrphan({
      type: DynamicValueType.LIST,
      orphan: rawOrphan,
      listSchema: schema,
    }),
    builder: lb,
  };
}

export namespace DynamicStruct {
  export type Reader = DynamicStructReader;
  export type Builder = DynamicStructBuilder;
}

export const DynamicStruct = {
  Reader: DynamicStructReader,
  Builder: DynamicStructBuilder,
  fromMessage: readDynamicRoot,
  initRoot: initDynamicRoot,
  setRoot: setDynamicRoot,
  upgradeRoot: upgradeDynamicRoot,
  empty: DynamicStructReader.empty,
} as const;

export namespace DynamicList {
  export type Reader = DynamicListReader;
  export type Builder = DynamicListBuilder;
}

export const DynamicList = {
  Reader: DynamicListReader,
  Builder: DynamicListBuilder,
  empty: DynamicListReader.empty,
} as const;
