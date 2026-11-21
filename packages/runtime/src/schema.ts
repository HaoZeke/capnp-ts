/**
 * Cap'n Proto runtime schema reflection (models capnp/schema.h + schema-loader.h).
 *
 * Loads compiled schema nodes or a framed CodeGeneratorRequest into an indexed
 * graph of Schema, StructSchema, EnumSchema, InterfaceSchema, ConstSchema,
 * AnnotationSchema, ListSchema, and Type handles with generic brand resolution.
 */

import { CapnpError, ElemSize, PtrKind, assertCapnp } from "./kinds.ts";
import { Message, Ptr } from "./message.ts";

export const SchemaNodeKind = {
  File: 0,
  Struct: 1,
  Enum: 2,
  Interface: 3,
  Const: 4,
  Annotation: 5,
} as const;
export type SchemaNodeKind =
  (typeof SchemaNodeKind)[keyof typeof SchemaNodeKind];

export type SchemaNodeWhich =
  | "file"
  | "struct"
  | "enum"
  | "interface"
  | "const"
  | "annotation";

const NODE_WHICH_BY_TAG: readonly SchemaNodeWhich[] = [
  "file",
  "struct",
  "enum",
  "interface",
  "const",
  "annotation",
];

export const TypeKind = {
  Void: 0,
  Bool: 1,
  Int8: 2,
  Int16: 3,
  Int32: 4,
  Int64: 5,
  UInt8: 6,
  UInt16: 7,
  UInt32: 8,
  UInt64: 9,
  Float32: 10,
  Float64: 11,
  Text: 12,
  Data: 13,
  List: 14,
  Enum: 15,
  Struct: 16,
  Interface: 17,
  AnyPointer: 18,
} as const;
export type TypeKind = (typeof TypeKind)[keyof typeof TypeKind];

export type TypeWhich =
  | "void"
  | "bool"
  | "int8"
  | "int16"
  | "int32"
  | "int64"
  | "uint8"
  | "uint16"
  | "uint32"
  | "uint64"
  | "float32"
  | "float64"
  | "text"
  | "data"
  | "list"
  | "enum"
  | "struct"
  | "interface"
  | "anyPointer";

const TYPE_WHICH_BY_TAG: readonly TypeWhich[] = [
  "void",
  "bool",
  "int8",
  "int16",
  "int32",
  "int64",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "float32",
  "float64",
  "text",
  "data",
  "list",
  "enum",
  "struct",
  "interface",
  "anyPointer",
];

export type AnyPointerKind = "anyKind" | "struct" | "list" | "capability";

const ANY_POINTER_KINDS: readonly AnyPointerKind[] = [
  "anyKind",
  "struct",
  "list",
  "capability",
];

export const NO_DISCRIMINANT = 0xffff;

/** Decoded schema.capnp Value payload, retaining raw bits and pointer handles. */
export type SchemaValue =
  | { readonly which: "void" }
  | { readonly which: "bool"; readonly value: boolean }
  | {
      readonly which:
        | "int8"
        | "int16"
        | "int32"
        | "uint8"
        | "uint16"
        | "uint32"
        | "enum";
      readonly value: number;
    }
  | { readonly which: "int64" | "uint64"; readonly value: bigint }
  | {
      readonly which: "float32";
      readonly value: number;
      readonly rawBits: number;
    }
  | {
      readonly which: "float64";
      readonly value: number;
      readonly rawBits: bigint;
    }
  | { readonly which: "text"; readonly value: string; readonly ptr: Ptr }
  | { readonly which: "data"; readonly value: Uint8Array; readonly ptr: Ptr }
  | { readonly which: "list"; readonly ptr: Ptr }
  | { readonly which: "struct"; readonly ptr: Ptr }
  | { readonly which: "interface" }
  | { readonly which: "anyPointer"; readonly ptr: Ptr };

export interface NestedNodeInfo {
  readonly name: string;
  readonly id: bigint;
}

export interface RequestedFileImport {
  readonly id: bigint;
  readonly name: string;
}

export interface RequestedFileSchema {
  readonly id: bigint;
  readonly filename: string;
  readonly imports: readonly RequestedFileImport[];
}

export interface AnnotationTargets {
  readonly file: boolean;
  readonly const: boolean;
  readonly enum: boolean;
  readonly enumerant: boolean;
  readonly struct: boolean;
  readonly field: boolean;
  readonly union: boolean;
  readonly group: boolean;
  readonly interface: boolean;
  readonly method: boolean;
  readonly param: boolean;
  readonly annotation: boolean;
}

type BrandMap = ReadonlyMap<bigint, readonly Type[]>;
const EMPTY_BRAND: BrandMap = new Map();

interface RawAnnotationRecord {
  readonly id: bigint;
  readonly value: SchemaValue;
  readonly brandPtr: Ptr;
}

interface RawFieldRecord {
  readonly proto: Ptr;
  readonly name: string;
  readonly index: number;
  readonly codeOrder: number;
  readonly discriminantValue: number;
  readonly kind: "slot" | "group";
  readonly offset: number;
  readonly typePtr: Ptr | null;
  readonly groupTypeId: bigint;
  readonly defaultValue: SchemaValue;
  readonly hadExplicitDefault: boolean;
  readonly explicitOrdinal: number | null;
  readonly annotations: readonly RawAnnotationRecord[];
}

interface RawEnumerantRecord {
  readonly proto: Ptr;
  readonly name: string;
  readonly ordinal: number;
  readonly codeOrder: number;
  readonly annotations: readonly RawAnnotationRecord[];
}

interface RawSuperclassRecord {
  readonly id: bigint;
  readonly brandPtr: Ptr;
}

interface RawMethodRecord {
  readonly proto: Ptr;
  readonly name: string;
  readonly ordinal: number;
  readonly codeOrder: number;
  readonly implicitParameters: readonly string[];
  readonly paramStructType: bigint;
  readonly paramBrandPtr: Ptr;
  readonly resultStructType: bigint;
  readonly resultBrandPtr: Ptr;
  readonly annotations: readonly RawAnnotationRecord[];
}

interface RawNodeRecord {
  readonly proto: Ptr;
  readonly id: bigint;
  readonly displayName: string;
  readonly displayNamePrefixLength: number;
  readonly scopeId: bigint;
  readonly which: SchemaNodeWhich;
  readonly whichTag: number;
  readonly isGeneric: boolean;
  readonly parameters: readonly string[];
  readonly nestedNodes: readonly NestedNodeInfo[];
  readonly annotations: readonly RawAnnotationRecord[];
  readonly dataWordCount: number;
  readonly pointerCount: number;
  readonly preferredListEncoding: number;
  readonly isGroup: boolean;
  readonly discriminantCount: number;
  readonly discriminantOffset: number;
  readonly fields: readonly RawFieldRecord[];
  readonly enumerants: readonly RawEnumerantRecord[];
  readonly methods: readonly RawMethodRecord[];
  readonly superclasses: readonly RawSuperclassRecord[];
  readonly constTypePtr: Ptr | null;
  readonly constValue: SchemaValue;
  readonly annotationTypePtr: Ptr | null;
  readonly annotationTargets: AnnotationTargets;
}

const EMPTY_TARGETS: AnnotationTargets = {
  file: false,
  const: false,
  enum: false,
  enumerant: false,
  struct: false,
  field: false,
  union: false,
  group: false,
  interface: false,
  method: false,
  param: false,
  annotation: false,
};

function decodeSchemaValue(v: Ptr): SchemaValue {
  if (v.kind !== PtrKind.Struct) {
    return { which: "void" };
  }
  const tag = v.getU16(0);
  switch (tag) {
    case TypeKind.Void:
      return { which: "void" };
    case TypeKind.Bool:
      return { which: "bool", value: v.getBool(16) };
    case TypeKind.Int8:
      return { which: "int8", value: (v.getU8(2) << 24) >> 24 };
    case TypeKind.Int16:
      return { which: "int16", value: (v.getU16(2) << 16) >> 16 };
    case TypeKind.Int32:
      return { which: "int32", value: v.getU32(4) | 0 };
    case TypeKind.Int64:
      return { which: "int64", value: BigInt.asIntN(64, v.getU64(8)) };
    case TypeKind.UInt8:
      return { which: "uint8", value: v.getU8(2) };
    case TypeKind.UInt16:
      return { which: "uint16", value: v.getU16(2) };
    case TypeKind.UInt32:
      return { which: "uint32", value: v.getU32(4) >>> 0 };
    case TypeKind.UInt64:
      return { which: "uint64", value: v.getU64(8) };
    case TypeKind.Float32:
      return {
        which: "float32",
        value: v.getF32(4),
        rawBits: v.getU32(4) >>> 0,
      };
    case TypeKind.Float64:
      return {
        which: "float64",
        value: v.getF64(8),
        rawBits: v.getU64(8),
      };
    case TypeKind.Text:
      return { which: "text", value: v.getText(0), ptr: v.getP(0) };
    case TypeKind.Data:
      return { which: "data", value: v.getData(0), ptr: v.getP(0) };
    case TypeKind.List:
      return { which: "list", ptr: v.getP(0) };
    case TypeKind.Enum:
      return { which: "enum", value: v.getU16(2) };
    case TypeKind.Struct:
      return { which: "struct", ptr: v.getP(0) };
    case TypeKind.Interface:
      return { which: "interface" };
    case TypeKind.AnyPointer:
      return { which: "anyPointer", ptr: v.getP(0) };
    default:
      return { which: "void" };
  }
}

function decodeAnnotations(list: Ptr): RawAnnotationRecord[] {
  if (list.kind !== PtrKind.List) return [];
  const out: RawAnnotationRecord[] = [];
  for (let i = 0; i < list.listLen(); i++) {
    const a = list.listGetP(i);
    if (a.kind !== PtrKind.Struct) continue;
    out.push({
      id: a.getU64(0),
      value: decodeSchemaValue(a.getP(0)),
      brandPtr: a.getP(1),
    });
  }
  return out;
}

function decodeParameters(list: Ptr): string[] {
  if (list.kind !== PtrKind.List) return [];
  const out: string[] = [];
  for (let i = 0; i < list.listLen(); i++) {
    const p = list.listGetP(i);
    out.push(p.kind === PtrKind.Struct ? p.getText(0) : "");
  }
  return out;
}

function decodeRawNode(n: Ptr): RawNodeRecord {
  assertCapnp(n.kind === PtrKind.Struct, "KIND", "schema Node is not a struct");
  const id = n.getU64(0);
  const displayName = n.getText(0);
  const displayNamePrefixLength = n.getU32(8) >>> 0;
  const whichTag = n.getU16(12);
  const which: SchemaNodeWhich = NODE_WHICH_BY_TAG[whichTag] ?? "file";
  const scopeId = n.getU64(16);
  const isGeneric = n.getBool(288);

  const nestedList = n.getP(1);
  const nestedNodes: NestedNodeInfo[] = [];
  if (nestedList.kind === PtrKind.List) {
    for (let i = 0; i < nestedList.listLen(); i++) {
      const nn = nestedList.listGetP(i);
      if (nn.kind !== PtrKind.Struct) continue;
      nestedNodes.push({
        name: nn.getText(0),
        id: nn.getU64(0),
      });
    }
  }

  const annotations = decodeAnnotations(n.getP(2));
  const parameters = decodeParameters(n.getP(5));

  let dataWordCount = 0;
  let pointerCount = 0;
  let preferredListEncoding = 0;
  let isGroup = false;
  let discriminantCount = 0;
  let discriminantOffset = 0;
  const fields: RawFieldRecord[] = [];
  const enumerants: RawEnumerantRecord[] = [];
  const methods: RawMethodRecord[] = [];
  const superclasses: RawSuperclassRecord[] = [];
  let constTypePtr: Ptr | null = null;
  let constValue: SchemaValue = { which: "void" };
  let annotationTypePtr: Ptr | null = null;
  let annotationTargets = EMPTY_TARGETS;

  if (which === "struct") {
    dataWordCount = n.getU16(14);
    pointerCount = n.getU16(24);
    preferredListEncoding = n.getU16(26);
    isGroup = n.getBool(224);
    discriminantCount = n.getU16(30);
    discriminantOffset = n.getU32(32) >>> 0;
    const flist = n.getP(3);
    if (flist.kind === PtrKind.List) {
      for (let i = 0; i < flist.listLen(); i++) {
        const f = flist.listGetP(i);
        if (f.kind !== PtrKind.Struct) continue;
        const fWhich = f.getU16(8);
        const ordWhich = f.getU16(10);
        const explicitOrdinal = ordWhich === 1 ? f.getU16(12) : null;
        const discriminantValue = f.getU16(2, NO_DISCRIMINANT);
        if (fWhich === 1) {
          fields.push({
            proto: f,
            name: f.getText(0),
            index: i,
            codeOrder: f.getU16(0),
            discriminantValue,
            kind: "group",
            offset: 0,
            typePtr: null,
            groupTypeId: f.getU64(16),
            defaultValue: { which: "void" },
            hadExplicitDefault: false,
            explicitOrdinal,
            annotations: decodeAnnotations(f.getP(1)),
          });
        } else {
          fields.push({
            proto: f,
            name: f.getText(0),
            index: i,
            codeOrder: f.getU16(0),
            discriminantValue,
            kind: "slot",
            offset: f.getU32(4) >>> 0,
            typePtr: f.getP(2),
            groupTypeId: 0n,
            defaultValue: decodeSchemaValue(f.getP(3)),
            hadExplicitDefault: f.getBool(128),
            explicitOrdinal,
            annotations: decodeAnnotations(f.getP(1)),
          });
        }
      }
    }
  } else if (which === "enum") {
    const elist = n.getP(3);
    if (elist.kind === PtrKind.List) {
      for (let i = 0; i < elist.listLen(); i++) {
        const e = elist.listGetP(i);
        if (e.kind !== PtrKind.Struct) continue;
        enumerants.push({
          proto: e,
          name: e.getText(0),
          ordinal: i,
          codeOrder: e.getU16(0),
          annotations: decodeAnnotations(e.getP(1)),
        });
      }
    }
  } else if (which === "interface") {
    const mlist = n.getP(3);
    if (mlist.kind === PtrKind.List) {
      for (let i = 0; i < mlist.listLen(); i++) {
        const m = mlist.listGetP(i);
        if (m.kind !== PtrKind.Struct) continue;
        methods.push({
          proto: m,
          name: m.getText(0),
          ordinal: i,
          codeOrder: m.getU16(0),
          implicitParameters: decodeParameters(m.getP(4)),
          paramStructType: m.getU64(8),
          paramBrandPtr: m.getP(2),
          resultStructType: m.getU64(16),
          resultBrandPtr: m.getP(3),
          annotations: decodeAnnotations(m.getP(1)),
        });
      }
    }
    const slist = n.getP(4);
    if (slist.kind === PtrKind.List) {
      for (let i = 0; i < slist.listLen(); i++) {
        const sc = slist.listGetP(i);
        if (sc.kind !== PtrKind.Struct) continue;
        superclasses.push({
          id: sc.getU64(0),
          brandPtr: sc.getP(0),
        });
      }
    }
  } else if (which === "const") {
    constTypePtr = n.getP(3);
    constValue = decodeSchemaValue(n.getP(4));
  } else if (which === "annotation") {
    annotationTypePtr = n.getP(3);
    annotationTargets = {
      file: n.getBool(112),
      const: n.getBool(113),
      enum: n.getBool(114),
      enumerant: n.getBool(115),
      struct: n.getBool(116),
      field: n.getBool(117),
      union: n.getBool(118),
      group: n.getBool(119),
      interface: n.getBool(120),
      method: n.getBool(121),
      param: n.getBool(122),
      annotation: n.getBool(123),
    };
  }

  return {
    proto: n,
    id,
    displayName,
    displayNamePrefixLength,
    scopeId,
    which,
    whichTag,
    isGeneric,
    parameters,
    nestedNodes,
    annotations,
    dataWordCount,
    pointerCount,
    preferredListEncoding,
    isGroup,
    discriminantCount,
    discriminantOffset,
    fields,
    enumerants,
    methods,
    superclasses,
    constTypePtr,
    constValue,
    annotationTypePtr,
    annotationTargets,
  };
}

export interface BrandParameterRef {
  readonly scopeId: bigint;
  readonly index: number;
}

export interface ImplicitParameterRef {
  readonly index: number;
}

/** Applied annotation instance on a schema declaration or member. */
export class AppliedAnnotation {
  readonly id: bigint;
  readonly rawValue: SchemaValue;
  private readonly loader: SchemaLoader;
  private readonly brandPtr: Ptr;
  private readonly parentBrand: BrandMap;

  /** @internal */
  constructor(
    loader: SchemaLoader,
    raw: RawAnnotationRecord,
    parentBrand: BrandMap,
  ) {
    this.id = raw.id;
    this.rawValue = raw.value;
    this.loader = loader;
    this.brandPtr = raw.brandPtr;
    this.parentBrand = parentBrand;
  }

  getSchema(): AnnotationSchema | null {
    const s = this.loader.tryGet(this.id, this.brandPtr, this.parentBrand);
    return s && s.which === "annotation" ? s.asAnnotation() : null;
  }

  getType(): Type | null {
    const s = this.getSchema();
    return s ? s.getType() : null;
  }
}

function resolveAnnotationId(idOrSchema: bigint | AnnotationSchema): bigint {
  return typeof idOrSchema === "bigint" ? idOrSchema : idOrSchema.id;
}

/** Cap'n Proto reflection Type (models capnp::Type). */
export class Type {
  readonly which: TypeWhich;
  readonly whichCode: number;
  private readonly _schema: Schema | ListSchema | null;
  private readonly _anyKind: AnyPointerKind;
  private readonly _brandParam: BrandParameterRef | null;
  private readonly _implicitParam: ImplicitParameterRef | null;
  private _listOfThis: ListSchema | null = null;

  private constructor(
    which: TypeWhich,
    whichCode: number,
    schema: Schema | ListSchema | null = null,
    anyKind: AnyPointerKind = "anyKind",
    brandParam: BrandParameterRef | null = null,
    implicitParam: ImplicitParameterRef | null = null,
  ) {
    this.which = which;
    this.whichCode = whichCode;
    this._schema = schema;
    this._anyKind = anyKind;
    this._brandParam = brandParam;
    this._implicitParam = implicitParam;
  }

  static readonly VOID = new Type("void", TypeKind.Void);
  static readonly BOOL = new Type("bool", TypeKind.Bool);
  static readonly INT8 = new Type("int8", TypeKind.Int8);
  static readonly INT16 = new Type("int16", TypeKind.Int16);
  static readonly INT32 = new Type("int32", TypeKind.Int32);
  static readonly INT64 = new Type("int64", TypeKind.Int64);
  static readonly UINT8 = new Type("uint8", TypeKind.UInt8);
  static readonly UINT16 = new Type("uint16", TypeKind.UInt16);
  static readonly UINT32 = new Type("uint32", TypeKind.UInt32);
  static readonly UINT64 = new Type("uint64", TypeKind.UInt64);
  static readonly FLOAT32 = new Type("float32", TypeKind.Float32);
  static readonly FLOAT64 = new Type("float64", TypeKind.Float64);
  static readonly TEXT = new Type("text", TypeKind.Text);
  static readonly DATA = new Type("data", TypeKind.Data);
  static readonly ANY_POINTER = new Type(
    "anyPointer",
    TypeKind.AnyPointer,
    null,
    "anyKind",
  );
  static readonly ANY_STRUCT = new Type(
    "anyPointer",
    TypeKind.AnyPointer,
    null,
    "struct",
  );
  static readonly ANY_LIST = new Type(
    "anyPointer",
    TypeKind.AnyPointer,
    null,
    "list",
  );
  static readonly CAPABILITY = new Type(
    "anyPointer",
    TypeKind.AnyPointer,
    null,
    "capability",
  );

  static primitive(which: TypeWhich): Type {
    switch (which) {
      case "void":
        return Type.VOID;
      case "bool":
        return Type.BOOL;
      case "int8":
        return Type.INT8;
      case "int16":
        return Type.INT16;
      case "int32":
        return Type.INT32;
      case "int64":
        return Type.INT64;
      case "uint8":
        return Type.UINT8;
      case "uint16":
        return Type.UINT16;
      case "uint32":
        return Type.UINT32;
      case "uint64":
        return Type.UINT64;
      case "float32":
        return Type.FLOAT32;
      case "float64":
        return Type.FLOAT64;
      case "text":
        return Type.TEXT;
      case "data":
        return Type.DATA;
      case "anyPointer":
        return Type.ANY_POINTER;
      default:
        throw new CapnpError("ARG", `not a primitive type: ${which}`);
    }
  }

  static fromStruct(schema: StructSchema): Type {
    return schema._getOrCreateType(() => new Type("struct", TypeKind.Struct, schema));
  }

  static fromEnum(schema: EnumSchema): Type {
    return schema._getOrCreateType(() => new Type("enum", TypeKind.Enum, schema));
  }

  static fromInterface(schema: InterfaceSchema): Type {
    return schema._getOrCreateType(
      () => new Type("interface", TypeKind.Interface, schema),
    );
  }

  static fromList(schema: ListSchema): Type {
    return schema._getOrCreateType(() => new Type("list", TypeKind.List, schema));
  }

  /** @internal */
  _getOrCreateList(factory: () => ListSchema): ListSchema {
    if (!this._listOfThis) {
      this._listOfThis = factory();
    }
    return this._listOfThis;
  }

  static anyPointer(kind: AnyPointerKind = "anyKind"): Type {
    switch (kind) {
      case "anyKind":
        return Type.ANY_POINTER;
      case "struct":
        return Type.ANY_STRUCT;
      case "list":
        return Type.ANY_LIST;
      case "capability":
        return Type.CAPABILITY;
    }
  }

  static fromBrandParameter(scopeId: bigint, index: number): Type {
    return new Type("anyPointer", TypeKind.AnyPointer, null, "anyKind", {
      scopeId,
      index,
    });
  }

  static fromImplicitParameter(index: number): Type {
    return new Type(
      "anyPointer",
      TypeKind.AnyPointer,
      null,
      "anyKind",
      null,
      { index },
    );
  }

  isVoid(): boolean {
    return this.whichCode === TypeKind.Void;
  }
  isBool(): boolean {
    return this.whichCode === TypeKind.Bool;
  }
  isInt8(): boolean {
    return this.whichCode === TypeKind.Int8;
  }
  isInt16(): boolean {
    return this.whichCode === TypeKind.Int16;
  }
  isInt32(): boolean {
    return this.whichCode === TypeKind.Int32;
  }
  isInt64(): boolean {
    return this.whichCode === TypeKind.Int64;
  }
  isUInt8(): boolean {
    return this.whichCode === TypeKind.UInt8;
  }
  isUInt16(): boolean {
    return this.whichCode === TypeKind.UInt16;
  }
  isUInt32(): boolean {
    return this.whichCode === TypeKind.UInt32;
  }
  isUInt64(): boolean {
    return this.whichCode === TypeKind.UInt64;
  }
  isFloat32(): boolean {
    return this.whichCode === TypeKind.Float32;
  }
  isFloat64(): boolean {
    return this.whichCode === TypeKind.Float64;
  }
  isText(): boolean {
    return this.whichCode === TypeKind.Text;
  }
  isData(): boolean {
    return this.whichCode === TypeKind.Data;
  }
  isList(): boolean {
    return this.whichCode === TypeKind.List;
  }
  isEnum(): boolean {
    return this.whichCode === TypeKind.Enum;
  }
  isStruct(): boolean {
    return this.whichCode === TypeKind.Struct;
  }
  isInterface(): boolean {
    return this.whichCode === TypeKind.Interface;
  }
  isAnyPointer(): boolean {
    return this.whichCode === TypeKind.AnyPointer;
  }

  isPointerType(): boolean {
    return (
      this.whichCode === TypeKind.Text ||
      this.whichCode === TypeKind.Data ||
      this.whichCode === TypeKind.List ||
      this.whichCode === TypeKind.Struct ||
      this.whichCode === TypeKind.Interface ||
      this.whichCode === TypeKind.AnyPointer
    );
  }

  whichAnyPointerKind(): AnyPointerKind {
    assertCapnp(this.isAnyPointer(), "KIND", "Type is not AnyPointer");
    return this._anyKind;
  }

  getBrandParameter(): BrandParameterRef | null {
    assertCapnp(this.isAnyPointer(), "KIND", "Type is not AnyPointer");
    return this._brandParam;
  }

  getImplicitParameter(): ImplicitParameterRef | null {
    assertCapnp(this.isAnyPointer(), "KIND", "Type is not AnyPointer");
    return this._implicitParam;
  }

  asStruct(): StructSchema {
    assertCapnp(
      this.whichCode === TypeKind.Struct && this._schema instanceof StructSchema,
      "KIND",
      `expected struct type, got ${this.which}`,
    );
    return this._schema;
  }

  asEnum(): EnumSchema {
    assertCapnp(
      this.whichCode === TypeKind.Enum && this._schema instanceof EnumSchema,
      "KIND",
      `expected enum type, got ${this.which}`,
    );
    return this._schema;
  }

  asInterface(): InterfaceSchema {
    assertCapnp(
      this.whichCode === TypeKind.Interface &&
        this._schema instanceof InterfaceSchema,
      "KIND",
      `expected interface type, got ${this.which}`,
    );
    return this._schema;
  }

  asList(): ListSchema {
    assertCapnp(
      this.whichCode === TypeKind.List && this._schema instanceof ListSchema,
      "KIND",
      `expected list type, got ${this.which}`,
    );
    return this._schema;
  }

  wrapInList(depth = 1): Type {
    let cur: Type = this;
    for (let i = 0; i < depth; i++) {
      cur = Type.fromList(ListSchema.of(cur));
    }
    return cur;
  }

  /** Canonical string key used for brand memoization and type equality. */
  canonicalKey(): string {
    switch (this.whichCode) {
      case TypeKind.List:
        return `L(${this.asList().getElementType().canonicalKey()})`;
      case TypeKind.Struct:
        return `S:${this.asStruct().brandKey}`;
      case TypeKind.Enum:
        return `E:${this.asEnum().brandKey}`;
      case TypeKind.Interface:
        return `I:${this.asInterface().brandKey}`;
      case TypeKind.AnyPointer:
        if (this._brandParam) {
          return `P:${this._brandParam.scopeId.toString(16)}#${this._brandParam.index}`;
        }
        if (this._implicitParam) {
          return `M:#${this._implicitParam.index}`;
        }
        return `A:${this._anyKind}`;
      default:
        return this.which;
    }
  }

  equals(other: Type): boolean {
    if (this === other) return true;
    return this.canonicalKey() === other.canonicalKey();
  }
}

/** Schema for a `List(T)` type (models capnp::ListSchema). */
export class ListSchema {
  readonly elementType: Type;
  private _selfType: Type | null = null;

  private constructor(elementType: Type) {
    this.elementType = elementType;
  }

  static of(elementType: Type): ListSchema {
    return elementType._getOrCreateList(() => new ListSchema(elementType));
  }

  /** @internal */
  _getOrCreateType(factory: () => Type): Type {
    if (!this._selfType) {
      this._selfType = factory();
    }
    return this._selfType;
  }

  getElementType(): Type {
    return this.elementType;
  }

  whichElementType(): TypeWhich {
    return this.elementType.which;
  }

  whichElementTypeCode(): number {
    return this.elementType.whichCode;
  }

  getStructElementType(): StructSchema {
    return this.elementType.asStruct();
  }

  getEnumElementType(): EnumSchema {
    return this.elementType.asEnum();
  }

  getListElementType(): ListSchema {
    return this.elementType.asList();
  }

  getInterfaceElementType(): InterfaceSchema {
    return this.elementType.asInterface();
  }

  /** Wire ElemSize code used when allocating a list of this element type. */
  wireElementSize(): number {
    switch (this.elementType.whichCode) {
      case TypeKind.Void:
        return ElemSize.Void;
      case TypeKind.Bool:
        return ElemSize.Bit;
      case TypeKind.Int8:
      case TypeKind.UInt8:
        return ElemSize.Byte;
      case TypeKind.Int16:
      case TypeKind.UInt16:
      case TypeKind.Enum:
        return ElemSize.TwoBytes;
      case TypeKind.Int32:
      case TypeKind.UInt32:
      case TypeKind.Float32:
        return ElemSize.FourBytes;
      case TypeKind.Int64:
      case TypeKind.UInt64:
      case TypeKind.Float64:
        return ElemSize.EightBytes;
      case TypeKind.Text:
      case TypeKind.Data:
      case TypeKind.List:
      case TypeKind.Interface:
      case TypeKind.AnyPointer:
        return ElemSize.Pointer;
      case TypeKind.Struct:
        return ElemSize.Composite;
      default:
        throw new CapnpError("KIND", `unsupported list element ${this.elementType.which}`);
    }
  }

  asType(): Type {
    return Type.fromList(this);
  }
}

/** Base wrapper around a compiled schema.capnp Node (models capnp::Schema). */
export class Schema {
  readonly loader: SchemaLoader;
  /** @internal */
  readonly raw: RawNodeRecord;
  /** @internal */
  readonly brandMap: BrandMap;
  /** @internal */
  readonly brandKey: string;
  private _annotations: readonly AppliedAnnotation[] | null = null;
  private _selfType: Type | null = null;

  /** @internal */
  _getOrCreateType(factory: () => Type): Type {
    if (!this._selfType) {
      this._selfType = factory();
    }
    return this._selfType;
  }

  /** @internal */
  constructor(
    loader: SchemaLoader,
    raw: RawNodeRecord,
    brandMap: BrandMap,
    brandKey: string,
  ) {
    this.loader = loader;
    this.raw = raw;
    this.brandMap = brandMap;
    this.brandKey = brandKey;
  }

  get id(): bigint {
    return this.raw.id;
  }

  get which(): SchemaNodeWhich {
    return this.raw.which;
  }

  get displayName(): string {
    return this.raw.displayName;
  }

  get displayNamePrefixLength(): number {
    return this.raw.displayNamePrefixLength;
  }

  get scopeId(): bigint {
    return this.raw.scopeId;
  }

  get isGeneric(): boolean {
    return this.raw.isGeneric;
  }

  get parameters(): readonly string[] {
    return this.raw.parameters;
  }

  get nestedNodes(): readonly NestedNodeInfo[] {
    return this.raw.nestedNodes;
  }

  getProto(): Ptr {
    return this.raw.proto;
  }

  getShortDisplayName(): string {
    return this.raw.displayName.slice(this.raw.displayNamePrefixLength);
  }

  getUnqualifiedName(): string {
    return this.getShortDisplayName();
  }

  isBranded(): boolean {
    return this.brandMap.size > 0;
  }

  getGeneric(): Schema {
    if (!this.isBranded()) return this;
    return this.loader.get(this.id);
  }

  getBrandArgumentsAtScope(scopeId: bigint): readonly Type[] {
    return this.brandMap.get(scopeId) ?? [];
  }

  getAnnotations(): readonly AppliedAnnotation[] {
    if (!this._annotations) {
      this._annotations = this.raw.annotations.map(
        (a) => new AppliedAnnotation(this.loader, a, this.brandMap),
      );
    }
    return this._annotations;
  }

  hasAnnotation(idOrSchema: bigint | AnnotationSchema): boolean {
    return this.findAnnotation(idOrSchema) !== null;
  }

  findAnnotation(idOrSchema: bigint | AnnotationSchema): AppliedAnnotation | null {
    const id = resolveAnnotationId(idOrSchema);
    for (const a of this.getAnnotations()) {
      if (a.id === id) return a;
    }
    return null;
  }

  getAnnotation(idOrSchema: bigint | AnnotationSchema): AppliedAnnotation {
    const found = this.findAnnotation(idOrSchema);
    assertCapnp(
      found !== null,
      "ARG",
      `annotation 0x${resolveAnnotationId(idOrSchema).toString(16)} not present on ${this.displayName}`,
    );
    return found;
  }

  asStruct(): StructSchema {
    assertCapnp(
      this instanceof StructSchema,
      "KIND",
      `Schema ${this.displayName} is ${this.which}, not struct`,
    );
    return this;
  }

  asEnum(): EnumSchema {
    assertCapnp(
      this instanceof EnumSchema,
      "KIND",
      `Schema ${this.displayName} is ${this.which}, not enum`,
    );
    return this;
  }

  asInterface(): InterfaceSchema {
    assertCapnp(
      this instanceof InterfaceSchema,
      "KIND",
      `Schema ${this.displayName} is ${this.which}, not interface`,
    );
    return this;
  }

  asConst(): ConstSchema {
    assertCapnp(
      this instanceof ConstSchema,
      "KIND",
      `Schema ${this.displayName} is ${this.which}, not const`,
    );
    return this;
  }

  asAnnotation(): AnnotationSchema {
    assertCapnp(
      this instanceof AnnotationSchema,
      "KIND",
      `Schema ${this.displayName} is ${this.which}, not annotation`,
    );
    return this;
  }
}

/** One field of a StructSchema (models capnp::StructSchema::Field). */
export class StructField {
  private readonly parent: StructSchema;
  /** @internal */
  readonly raw: RawFieldRecord;
  private _type: Type | null = null;
  private _annotations: readonly AppliedAnnotation[] | null = null;

  /** @internal */
  constructor(parent: StructSchema, raw: RawFieldRecord) {
    this.parent = parent;
    this.raw = raw;
  }

  get name(): string {
    return this.raw.name;
  }

  get index(): number {
    return this.raw.index;
  }

  get codeOrder(): number {
    return this.raw.codeOrder;
  }

  get discriminantValue(): number {
    return this.raw.discriminantValue;
  }

  get isUnionMember(): boolean {
    return this.raw.discriminantValue !== NO_DISCRIMINANT;
  }

  get kind(): "slot" | "group" {
    return this.raw.kind;
  }

  get offset(): number {
    return this.raw.offset;
  }

  get defaultValue(): SchemaValue {
    return this.raw.defaultValue;
  }

  get hadExplicitDefault(): boolean {
    return this.raw.hadExplicitDefault;
  }

  get explicitOrdinal(): number | null {
    return this.raw.explicitOrdinal;
  }

  getProto(): Ptr {
    return this.raw.proto;
  }

  getIndex(): number {
    return this.raw.index;
  }

  getContainingStruct(): StructSchema {
    return this.parent;
  }

  isSlot(): boolean {
    return this.raw.kind === "slot";
  }

  isGroup(): boolean {
    return this.raw.kind === "group";
  }

  getType(): Type {
    if (!this._type) {
      if (this.raw.kind === "group") {
        // Group nodes share the enclosing struct's generic brand bindings.
        const groupSchema = this.parent.loader
          .getWithBrandMap(this.raw.groupTypeId, this.parent.brandMap)
          .asStruct();
        this._type = Type.fromStruct(groupSchema);
      } else {
        this._type = this.parent.loader.interpretType(
          this.raw.typePtr,
          this.parent.brandMap,
        );
      }
    }
    return this._type;
  }

  getAnnotations(): readonly AppliedAnnotation[] {
    if (!this._annotations) {
      this._annotations = this.raw.annotations.map(
        (a) => new AppliedAnnotation(this.parent.loader, a, this.parent.brandMap),
      );
    }
    return this._annotations;
  }

  hasAnnotation(idOrSchema: bigint | AnnotationSchema): boolean {
    return this.findAnnotation(idOrSchema) !== null;
  }

  findAnnotation(idOrSchema: bigint | AnnotationSchema): AppliedAnnotation | null {
    const id = resolveAnnotationId(idOrSchema);
    for (const a of this.getAnnotations()) {
      if (a.id === id) return a;
    }
    return null;
  }

  getAnnotation(idOrSchema: bigint | AnnotationSchema): AppliedAnnotation {
    const found = this.findAnnotation(idOrSchema);
    assertCapnp(
      found !== null,
      "ARG",
      `annotation 0x${resolveAnnotationId(idOrSchema).toString(16)} not present on field ${this.name}`,
    );
    return found;
  }
}

/** Struct or group schema (models capnp::StructSchema). */
export class StructSchema extends Schema {
  static readonly Field = StructField;

  private _fields: readonly StructField[] | null = null;
  private _unionFields: readonly StructField[] | null = null;
  private _nonUnionFields: readonly StructField[] | null = null;
  private _byName: Map<string, StructField> | null = null;
  private _byDisc: Map<number, StructField> | null = null;

  get dataWordCount(): number {
    return this.raw.dataWordCount;
  }

  get pointerCount(): number {
    return this.raw.pointerCount;
  }

  get preferredListEncoding(): number {
    return this.raw.preferredListEncoding;
  }

  get isGroup(): boolean {
    return this.raw.isGroup;
  }

  get discriminantCount(): number {
    return this.raw.discriminantCount;
  }

  /** Offset of the 16-bit union tag in multiples of 16 bits (byteOffset = discriminantOffset * 2). */
  get discriminantOffset(): number {
    return this.raw.discriminantOffset;
  }

  getFields(): readonly StructField[] {
    if (!this._fields) {
      this._fields = this.raw.fields.map((f) => new StructField(this, f));
    }
    return this._fields;
  }

  getFieldsByCodeOrder(): readonly StructField[] {
    return [...this.getFields()].sort((a, b) => a.codeOrder - b.codeOrder);
  }

  getUnionFields(): readonly StructField[] {
    if (!this._unionFields) {
      this._unionFields = this.getFields().filter((f) => f.isUnionMember);
    }
    return this._unionFields;
  }

  getNonUnionFields(): readonly StructField[] {
    if (!this._nonUnionFields) {
      this._nonUnionFields = this.getFields().filter((f) => !f.isUnionMember);
    }
    return this._nonUnionFields;
  }

  findFieldByName(name: string): StructField | null {
    if (!this._byName) {
      this._byName = new Map();
      for (const f of this.getFields()) {
        this._byName.set(f.name, f);
      }
    }
    return this._byName.get(name) ?? null;
  }

  getFieldByName(name: string): StructField {
    const f = this.findFieldByName(name);
    assertCapnp(
      f !== null,
      "ARG",
      `struct ${this.getShortDisplayName()} has no field '${name}'`,
    );
    return f;
  }

  getFieldByDiscriminant(discriminant: number): StructField | null {
    if (this.discriminantCount === 0) return null;
    if (!this._byDisc) {
      this._byDisc = new Map();
      for (const f of this.getUnionFields()) {
        this._byDisc.set(f.discriminantValue, f);
      }
    }
    return this._byDisc.get(discriminant) ?? null;
  }

  mayContainCapabilities(seen: Set<string> = new Set()): boolean {
    if (seen.has(this.brandKey)) return false;
    seen.add(this.brandKey);
    for (const f of this.getFields()) {
      let t = f.getType();
      while (t.isList()) t = t.asList().getElementType();
      if (t.isInterface()) return true;
      if (t.isAnyPointer()) {
        const k = t.whichAnyPointerKind();
        if (k === "anyKind" || k === "capability" || k === "struct" || k === "list") {
          return true;
        }
      }
      if (t.isStruct() && t.asStruct().mayContainCapabilities(seen)) {
        return true;
      }
    }
    return false;
  }

  asType(): Type {
    return Type.fromStruct(this);
  }
}

/** One member of an EnumSchema (models capnp::EnumSchema::Enumerant). */
export class Enumerant {
  private readonly parent: EnumSchema;
  /** @internal */
  readonly raw: RawEnumerantRecord;
  private _annotations: readonly AppliedAnnotation[] | null = null;

  /** @internal */
  constructor(parent: EnumSchema, raw: RawEnumerantRecord) {
    this.parent = parent;
    this.raw = raw;
  }

  get name(): string {
    return this.raw.name;
  }

  get ordinal(): number {
    return this.raw.ordinal;
  }

  get codeOrder(): number {
    return this.raw.codeOrder;
  }

  getProto(): Ptr {
    return this.raw.proto;
  }

  getOrdinal(): number {
    return this.raw.ordinal;
  }

  getIndex(): number {
    return this.raw.ordinal;
  }

  getContainingEnum(): EnumSchema {
    return this.parent;
  }

  getAnnotations(): readonly AppliedAnnotation[] {
    if (!this._annotations) {
      this._annotations = this.raw.annotations.map(
        (a) => new AppliedAnnotation(this.parent.loader, a, this.parent.brandMap),
      );
    }
    return this._annotations;
  }

  hasAnnotation(idOrSchema: bigint | AnnotationSchema): boolean {
    return this.findAnnotation(idOrSchema) !== null;
  }

  findAnnotation(idOrSchema: bigint | AnnotationSchema): AppliedAnnotation | null {
    const id = resolveAnnotationId(idOrSchema);
    for (const a of this.getAnnotations()) {
      if (a.id === id) return a;
    }
    return null;
  }

  getAnnotation(idOrSchema: bigint | AnnotationSchema): AppliedAnnotation {
    const found = this.findAnnotation(idOrSchema);
    assertCapnp(
      found !== null,
      "ARG",
      `annotation 0x${resolveAnnotationId(idOrSchema).toString(16)} not present on enumerant ${this.name}`,
    );
    return found;
  }
}

/** Enum schema (models capnp::EnumSchema). */
export class EnumSchema extends Schema {
  static readonly Enumerant = Enumerant;

  private _enumerants: readonly Enumerant[] | null = null;
  private _byName: Map<string, Enumerant> | null = null;

  getEnumerants(): readonly Enumerant[] {
    if (!this._enumerants) {
      this._enumerants = this.raw.enumerants.map((e) => new Enumerant(this, e));
    }
    return this._enumerants;
  }

  findEnumerantByName(name: string): Enumerant | null {
    if (!this._byName) {
      this._byName = new Map();
      for (const e of this.getEnumerants()) {
        this._byName.set(e.name, e);
      }
    }
    return this._byName.get(name) ?? null;
  }

  getEnumerantByName(name: string): Enumerant {
    const e = this.findEnumerantByName(name);
    assertCapnp(
      e !== null,
      "ARG",
      `enum ${this.getShortDisplayName()} has no enumerant '${name}'`,
    );
    return e;
  }

  asType(): Type {
    return Type.fromEnum(this);
  }
}

/** One RPC method of an InterfaceSchema (models capnp::InterfaceSchema::Method). */
export class InterfaceMethod {
  private readonly parent: InterfaceSchema;
  /** @internal */
  readonly raw: RawMethodRecord;
  private _paramType: StructSchema | null = null;
  private _resultType: StructSchema | null = null;
  private _annotations: readonly AppliedAnnotation[] | null = null;

  /** @internal */
  constructor(parent: InterfaceSchema, raw: RawMethodRecord) {
    this.parent = parent;
    this.raw = raw;
  }

  get name(): string {
    return this.raw.name;
  }

  get ordinal(): number {
    return this.raw.ordinal;
  }

  get codeOrder(): number {
    return this.raw.codeOrder;
  }

  get implicitParameters(): readonly string[] {
    return this.raw.implicitParameters;
  }

  getProto(): Ptr {
    return this.raw.proto;
  }

  getOrdinal(): number {
    return this.raw.ordinal;
  }

  getIndex(): number {
    return this.raw.ordinal;
  }

  getContainingInterface(): InterfaceSchema {
    return this.parent;
  }

  getParamType(): StructSchema {
    if (!this._paramType) {
      this._paramType = this.parent.loader
        .get(this.raw.paramStructType, this.raw.paramBrandPtr, this.parent.brandMap)
        .asStruct();
    }
    return this._paramType;
  }

  getResultType(): StructSchema {
    if (!this._resultType) {
      this._resultType = this.parent.loader
        .get(this.raw.resultStructType, this.raw.resultBrandPtr, this.parent.brandMap)
        .asStruct();
    }
    return this._resultType;
  }

  getAnnotations(): readonly AppliedAnnotation[] {
    if (!this._annotations) {
      this._annotations = this.raw.annotations.map(
        (a) => new AppliedAnnotation(this.parent.loader, a, this.parent.brandMap),
      );
    }
    return this._annotations;
  }

  hasAnnotation(idOrSchema: bigint | AnnotationSchema): boolean {
    return this.findAnnotation(idOrSchema) !== null;
  }

  findAnnotation(idOrSchema: bigint | AnnotationSchema): AppliedAnnotation | null {
    const id = resolveAnnotationId(idOrSchema);
    for (const a of this.getAnnotations()) {
      if (a.id === id) return a;
    }
    return null;
  }

  getAnnotation(idOrSchema: bigint | AnnotationSchema): AppliedAnnotation {
    const found = this.findAnnotation(idOrSchema);
    assertCapnp(
      found !== null,
      "ARG",
      `annotation 0x${resolveAnnotationId(idOrSchema).toString(16)} not present on method ${this.name}`,
    );
    return found;
  }
}

/** Interface schema (models capnp::InterfaceSchema). */
export class InterfaceSchema extends Schema {
  static readonly Method = InterfaceMethod;

  private _methods: readonly InterfaceMethod[] | null = null;
  private _superclasses: readonly InterfaceSchema[] | null = null;

  getMethods(): readonly InterfaceMethod[] {
    if (!this._methods) {
      this._methods = this.raw.methods.map((m) => new InterfaceMethod(this, m));
    }
    return this._methods;
  }

  getSuperclasses(): readonly InterfaceSchema[] {
    if (!this._superclasses) {
      this._superclasses = this.raw.superclasses.map((sc) =>
        this.loader.get(sc.id, sc.brandPtr, this.brandMap).asInterface(),
      );
    }
    return this._superclasses;
  }

  findMethodByName(name: string): InterfaceMethod | null {
    return this.findMethodByNameBounded(name, { steps: 0 });
  }

  private findMethodByNameBounded(
    name: string,
    budget: { steps: number },
  ): InterfaceMethod | null {
    assertCapnp(++budget.steps <= 256, "DEPTH", "interface hierarchy too deep");
    for (const m of this.getMethods()) {
      if (m.name === name) return m;
    }
    for (const sc of this.getSuperclasses()) {
      const hit = sc.findMethodByNameBounded(name, budget);
      if (hit) return hit;
    }
    return null;
  }

  getMethodByName(name: string): InterfaceMethod {
    const m = this.findMethodByName(name);
    assertCapnp(
      m !== null,
      "ARG",
      `interface ${this.getShortDisplayName()} has no method '${name}'`,
    );
    return m;
  }

  extends(other: InterfaceSchema): boolean {
    return this.extendsBounded(other, { steps: 0 });
  }

  private extendsBounded(
    other: InterfaceSchema,
    budget: { steps: number },
  ): boolean {
    assertCapnp(++budget.steps <= 256, "DEPTH", "interface hierarchy too deep");
    if (this === other) return true;
    for (const sc of this.getSuperclasses()) {
      if (sc.extendsBounded(other, budget)) return true;
    }
    return false;
  }

  findSuperclass(typeId: bigint): InterfaceSchema | null {
    return this.findSuperclassBounded(typeId, { steps: 0 });
  }

  private findSuperclassBounded(
    typeId: bigint,
    budget: { steps: number },
  ): InterfaceSchema | null {
    assertCapnp(++budget.steps <= 256, "DEPTH", "interface hierarchy too deep");
    if (this.id === typeId) return this;
    for (const sc of this.getSuperclasses()) {
      const hit = sc.findSuperclassBounded(typeId, budget);
      if (hit) return hit;
    }
    return null;
  }

  asType(): Type {
    return Type.fromInterface(this);
  }
}

/** Constant schema declaration (models capnp::ConstSchema). */
export class ConstSchema extends Schema {
  private _type: Type | null = null;

  get rawValue(): SchemaValue {
    return this.raw.constValue;
  }

  getType(): Type {
    if (!this._type) {
      this._type = this.loader.interpretType(this.raw.constTypePtr, this.brandMap);
    }
    return this._type;
  }
}

/** Annotation declaration schema (models schema.capnp Node.annotation). */
export class AnnotationSchema extends Schema {
  private _type: Type | null = null;

  get targets(): AnnotationTargets {
    return this.raw.annotationTargets;
  }

  getType(): Type {
    if (!this._type) {
      this._type = this.loader.interpretType(
        this.raw.annotationTypePtr,
        this.brandMap,
      );
    }
    return this._type;
  }
}

function formatBrandKey(id: bigint, brandMap: BrandMap): string {
  const base = id.toString(16);
  if (brandMap.size === 0) return base;
  const entries = [...brandMap.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const parts = entries.map(
    ([scopeId, args]) =>
      `${scopeId.toString(16)}=[${args.map((t) => t.canonicalKey()).join(",")}]`,
  );
  return `${base}<${parts.join(";")}>`;
}

/**
 * Runtime registry of Cap'n Proto schema nodes (models capnp::SchemaLoader).
 */
export class SchemaLoader {
  private readonly rawNodes = new Map<bigint, RawNodeRecord>();
  private readonly instances = new Map<string, Schema>();
  private readonly reqFiles: RequestedFileSchema[] = [];

  static fromCgr(input: Uint8Array | Message): SchemaLoader {
    const loader = new SchemaLoader();
    loader.loadCgr(input);
    return loader;
  }

  loadNode(nodePtr: Ptr): Schema {
    const raw = decodeRawNode(nodePtr);
    this.rawNodes.set(raw.id, raw);
    return this.get(raw.id);
  }

  loadCgr(input: Uint8Array | Message): void {
    const msg =
      input instanceof Message
        ? input
        : Message.fromFlat(input, {
            traversalWords: 1_073_741_824,
            depthLimit: 256,
          });
    const root = msg.root();
    assertCapnp(
      root.kind === PtrKind.Struct,
      "KIND",
      "CodeGeneratorRequest root is not a struct",
    );

    const nodesList = root.getP(0);
    if (nodesList.kind === PtrKind.List) {
      for (let i = 0; i < nodesList.listLen(); i++) {
        const raw = decodeRawNode(nodesList.listGetP(i));
        this.rawNodes.set(raw.id, raw);
      }
    }

    const reqList = root.getP(1);
    if (reqList.kind === PtrKind.List) {
      for (let i = 0; i < reqList.listLen(); i++) {
        const rf = reqList.listGetP(i);
        if (rf.kind !== PtrKind.Struct) continue;
        const impList = rf.getP(1);
        const imports: RequestedFileImport[] = [];
        if (impList.kind === PtrKind.List) {
          for (let j = 0; j < impList.listLen(); j++) {
            const imp = impList.listGetP(j);
            if (imp.kind !== PtrKind.Struct) continue;
            imports.push({
              id: imp.getU64(0),
              name: imp.getText(0),
            });
          }
        }
        this.reqFiles.push({
          id: rf.getU64(0),
          filename: rf.getText(0),
          imports,
        });
      }
    }
  }

  allNodes(): Schema[] {
    const out: Schema[] = [];
    for (const id of this.rawNodes.keys()) {
      out.push(this.get(id));
    }
    return out;
  }

  requestedFiles(): readonly RequestedFileSchema[] {
    return this.reqFiles;
  }

  has(id: bigint): boolean {
    return this.rawNodes.has(id);
  }

  /** @internal */
  resolveBrandPtr(brandPtr: Ptr | null | undefined, parentBrand: BrandMap): BrandMap {
    if (!brandPtr || brandPtr.kind !== PtrKind.Struct) return EMPTY_BRAND;
    const scopes = brandPtr.getP(0);
    if (scopes.kind !== PtrKind.List || scopes.listLen() === 0) return EMPTY_BRAND;

    const map = new Map<bigint, readonly Type[]>();
    for (let i = 0; i < scopes.listLen(); i++) {
      const sc = scopes.listGetP(i);
      if (sc.kind !== PtrKind.Struct) continue;
      const scopeId = sc.getU64(0);
      const which = sc.getU16(8);
      if (which === 1) {
        // inherit from enclosing brand context
        const inherited = parentBrand.get(scopeId);
        if (inherited && inherited.length > 0) {
          map.set(scopeId, inherited);
        }
      } else {
        // bind explicit parameter list
        const bindList = sc.getP(0);
        if (bindList.kind !== PtrKind.List) continue;
        const bound: Type[] = [];
        for (let j = 0; j < bindList.listLen(); j++) {
          const b = bindList.listGetP(j);
          if (b.kind !== PtrKind.Struct || b.getU16(0) === 0) {
            bound.push(Type.ANY_POINTER);
          } else {
            bound.push(this.interpretType(b.getP(0), parentBrand));
          }
        }
        if (bound.length > 0) {
          map.set(scopeId, bound);
        }
      }
    }
    return map.size === 0 ? EMPTY_BRAND : map;
  }

  /** @internal */
  getWithBrandMap(id: bigint, brandMap: BrandMap): Schema {
    const raw = this.rawNodes.get(id);
    assertCapnp(
      raw !== undefined,
      "ARG",
      `schema node 0x${id.toString(16)} is not loaded`,
    );
    const key = formatBrandKey(id, brandMap);
    let inst = this.instances.get(key);
    if (!inst) {
      switch (raw.which) {
        case "struct":
          inst = new StructSchema(this, raw, brandMap, key);
          break;
        case "enum":
          inst = new EnumSchema(this, raw, brandMap, key);
          break;
        case "interface":
          inst = new InterfaceSchema(this, raw, brandMap, key);
          break;
        case "const":
          inst = new ConstSchema(this, raw, brandMap, key);
          break;
        case "annotation":
          inst = new AnnotationSchema(this, raw, brandMap, key);
          break;
        default:
          inst = new Schema(this, raw, brandMap, key);
          break;
      }
      this.instances.set(key, inst);
    }
    return inst;
  }

  tryGet(
    id: bigint,
    brandPtr?: Ptr | null,
    parentBrand: BrandMap = EMPTY_BRAND,
  ): Schema | null {
    if (!this.rawNodes.has(id)) return null;
    const brandMap = this.resolveBrandPtr(brandPtr, parentBrand);
    return this.getWithBrandMap(id, brandMap);
  }

  get(
    id: bigint,
    brandPtr?: Ptr | null,
    parentBrand: BrandMap = EMPTY_BRAND,
  ): Schema {
    const brandMap = this.resolveBrandPtr(brandPtr, parentBrand);
    return this.getWithBrandMap(id, brandMap);
  }

  getStruct(id: bigint): StructSchema {
    return this.get(id).asStruct();
  }

  getEnum(id: bigint): EnumSchema {
    return this.get(id).asEnum();
  }

  getInterface(id: bigint): InterfaceSchema {
    return this.get(id).asInterface();
  }

  getConst(id: bigint): ConstSchema {
    return this.get(id).asConst();
  }

  getAnnotation(id: bigint): AnnotationSchema {
    return this.get(id).asAnnotation();
  }

  /** @internal */
  interpretType(typePtr: Ptr | null | undefined, brandMap: BrandMap): Type {
    if (!typePtr || typePtr.kind !== PtrKind.Struct) {
      return Type.VOID;
    }
    const tag = typePtr.getU16(0);
    const which = TYPE_WHICH_BY_TAG[tag];
    if (!which) return Type.VOID;

    switch (tag) {
      case TypeKind.List:
        return Type.fromList(
          ListSchema.of(this.interpretType(typePtr.getP(0), brandMap)),
        );
      case TypeKind.Enum: {
        const targetId = typePtr.getU64(8);
        return Type.fromEnum(
          this.get(targetId, typePtr.getP(0), brandMap).asEnum(),
        );
      }
      case TypeKind.Struct: {
        const targetId = typePtr.getU64(8);
        return Type.fromStruct(
          this.get(targetId, typePtr.getP(0), brandMap).asStruct(),
        );
      }
      case TypeKind.Interface: {
        const targetId = typePtr.getU64(8);
        return Type.fromInterface(
          this.get(targetId, typePtr.getP(0), brandMap).asInterface(),
        );
      }
      case TypeKind.AnyPointer: {
        const subWhich = typePtr.getU16(8);
        if (subWhich === 0) {
          const k = ANY_POINTER_KINDS[typePtr.getU16(10)] ?? "anyKind";
          return Type.anyPointer(k);
        }
        if (subWhich === 1) {
          const paramIdx = typePtr.getU16(10);
          const scopeId = typePtr.getU64(16);
          const scopeBindings = brandMap.get(scopeId);
          if (scopeBindings) {
            return scopeBindings[paramIdx] ?? Type.ANY_POINTER;
          }
          // Unbound parameter on an unbranded generic resolves to AnyPointer,
          // matching C++ Schema::getBrandBinding.
          return Type.ANY_POINTER;
        }
        return Type.fromImplicitParameter(typePtr.getU16(10));
      }
      default:
        return Type.primitive(which);
    }
  }

  /** Look up a direct nested declaration inside `scopeId` by petname. */
  lookupChild(scopeId: bigint, name: string): bigint | null {
    const scope = this.rawNodes.get(scopeId);
    if (!scope) return null;
    for (const nn of scope.nestedNodes) {
      if (nn.name === name) return nn.id;
    }
    return null;
  }

  /**
   * Resolve a type or declaration expression (such as `AddressBook`,
   * `Person.PhoneNumber`, or `Envelope(Text)`) within `fileId` (defaults to the
   * first requested file in the CGR, or searches all file scopes).
   */
  resolve(expr: string, fileId?: bigint): Schema {
    const t = this.resolveType(expr, fileId);
    if (t.isStruct()) return t.asStruct();
    if (t.isEnum()) return t.asEnum();
    if (t.isInterface()) return t.asInterface();
    throw new CapnpError("ARG", `'${expr}' does not name a declaration schema`);
  }

  resolveStruct(expr: string, fileId?: bigint): StructSchema {
    return this.resolve(expr, fileId).asStruct();
  }

  resolveType(expr: string, fileId?: bigint): Type {
    const trimmed = expr.trim();
    assertCapnp(trimmed.length > 0, "ARG", "empty type expression");

    switch (trimmed) {
      case "Void":
        return Type.VOID;
      case "Bool":
        return Type.BOOL;
      case "Int8":
        return Type.INT8;
      case "Int16":
        return Type.INT16;
      case "Int32":
        return Type.INT32;
      case "Int64":
        return Type.INT64;
      case "UInt8":
        return Type.UINT8;
      case "UInt16":
        return Type.UINT16;
      case "UInt32":
        return Type.UINT32;
      case "UInt64":
        return Type.UINT64;
      case "Float32":
        return Type.FLOAT32;
      case "Float64":
        return Type.FLOAT64;
      case "Text":
        return Type.TEXT;
      case "Data":
        return Type.DATA;
      case "AnyPointer":
        return Type.ANY_POINTER;
      case "AnyStruct":
        return Type.ANY_STRUCT;
      case "AnyList":
        return Type.ANY_LIST;
      case "Capability":
        return Type.CAPABILITY;
    }

    if (trimmed.startsWith("List(") && trimmed.endsWith(")")) {
      const inner = trimmed.slice(5, -1);
      return Type.fromList(ListSchema.of(this.resolveType(inner, fileId)));
    }

    const segments = splitQualifiedTypeExpr(trimmed);
    assertCapnp(segments.length > 0, "ARG", `invalid type expression '${expr}'`);

    let curId = this.findRootSymbol(segments[0]!.name, fileId);
    const brandAcc = new Map<bigint, readonly Type[]>();

    const applySegmentArgs = (nodeId: bigint, args: readonly string[]) => {
      if (args.length === 0) return;
      brandAcc.set(
        nodeId,
        args.map((a) => this.resolveType(a, fileId)),
      );
    };

    applySegmentArgs(curId, segments[0]!.args);

    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i]!;
      const nextId = this.lookupChild(curId, seg.name);
      assertCapnp(
        nextId !== null,
        "ARG",
        `'${this.get(curId).getShortDisplayName()}' has no nested '${seg.name}'`,
      );
      curId = nextId;
      applySegmentArgs(curId, seg.args);
    }

    const resolved = this.getWithBrandMap(
      curId,
      brandAcc.size === 0 ? EMPTY_BRAND : brandAcc,
    );
    switch (resolved.which) {
      case "struct":
        return Type.fromStruct(resolved.asStruct());
      case "enum":
        return Type.fromEnum(resolved.asEnum());
      case "interface":
        return Type.fromInterface(resolved.asInterface());
      default:
        throw new CapnpError(
          "ARG",
          `'${expr}' resolves to ${resolved.which}, not a type`,
        );
    }
  }

  /** Find a top-level declaration ID (including consts and annotations) by name. */
  findRootSymbol(name: string, fileId?: bigint): bigint {
    const clean = name.startsWith(".") ? name.slice(1) : name;
    if (fileId !== undefined) {
      const hit = this.lookupChild(fileId, clean);
      assertCapnp(hit !== null, "ARG", `'${clean}' is not defined`);
      return hit;
    }
    if (this.reqFiles.length > 0) {
      for (const rf of this.reqFiles) {
        const hit = this.lookupChild(rf.id, clean);
        if (hit !== null) return hit;
      }
    }
    for (const [id, raw] of this.rawNodes) {
      if (raw.which === "file") {
        const hit = this.lookupChild(id, clean);
        if (hit !== null) return hit;
      }
    }
    for (const [id, raw] of this.rawNodes) {
      if (raw.displayName.slice(raw.displayNamePrefixLength) === clean) {
        return id;
      }
    }
    throw new CapnpError("ARG", `'${clean}' is not defined`);
  }
}

function splitTopLevel(input: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") {
      assertCapnp(depth > 0, "ARG", `unmatched ')' in '${input}'`);
      depth--;
    } else if (depth === 0 && ch === sep) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  assertCapnp(depth === 0, "ARG", `unclosed '(' in '${input}'`);
  parts.push(input.slice(start));
  return parts;
}

function splitQualifiedTypeExpr(
  expr: string,
): Array<{ name: string; args: string[] }> {
  const clean = expr.startsWith(".") ? expr.slice(1) : expr;
  const rawSegs = splitTopLevel(clean, ".");
  return rawSegs.map((raw) => {
    const s = raw.trim();
    const open = s.indexOf("(");
    if (open < 0) {
      assertCapnp(/^[A-Za-z_][A-Za-z0-9_]*$/.test(s), "ARG", `bad type name '${s}'`);
      return { name: s, args: [] };
    }
    assertCapnp(s.endsWith(")"), "ARG", `malformed type segment '${s}'`);
    const name = s.slice(0, open).trim();
    assertCapnp(
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
      "ARG",
      `bad type name '${name}'`,
    );
    const inner = s.slice(open + 1, -1).trim();
    const args = inner.length === 0 ? [] : splitTopLevel(inner, ",").map((a) => a.trim());
    return { name, args };
  });
}
