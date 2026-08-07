/**
 * Walk framed CodeGeneratorRequest (schema.capnp).
 * Offsets match capnp-fortran capnp_schema.f90 / capnp compile -ocapnp schema.capnp.
 *
 * CodeGeneratorRequest: 0 data words, 4 pointers
 *   ptr0 nodes : List(Node)
 *   ptr1 requestedFiles : List(RequestedFile)
 *   ptr2 capnpVersion
 *   ptr3 sourceInfo
 *
 * Node: 6 data words, 6 ptrs
 *   id u64 @0; displayNamePrefixLength u32 @8; which u16 @12; scopeId u64 @16
 *   displayName Text ptr0; nestedNodes ptr1; annotations ptr2
 *   struct: dataWordCount u16 @14, pointerCount u16 @24, isGroup bool bit224,
 *           discriminantCount u16 @30, discriminantOffset u32 @32, fields List ptr3
 *   enum: enumerants List ptr3
 *
 * Field: 3 data words, 4 ptrs
 *   codeOrder u16 @0; discriminantValue u16 @2 (default 0xffff, wire XOR);
 *   which u16 @8 (slot=0/group=1); slot.offset u32 @4; group.typeId u64 @16
 *   name Text ptr0; annotations ptr1; slot.type ptr2; slot.defaultValue ptr3
 *   slot.hadExplicitDefault :Bool bit 128 (data; schema.capnp Field.slot @10)
 *
 * Type: which u16 @0; list.elementType ptr0; enum/struct/interface typeId u64 @8
 *
 * Value: which u16 @0; scalar payload in data / text-data at ptr0 (schema.capnp)
 *
 * RequestedFile: 1 data word (id u64), 2+ pointers
 *   ptr0 filename : Text
 */

import {
  PtrKind,
  ElemSize,
  WireKind,
  WORD_BYTES,
} from "../../runtime/src/kinds.ts";
import { loadU32, loadU64 } from "../../runtime/src/endian.ts";
import {
  wpKind,
  wpOffset,
  wpStructDwords,
  wpStructPwords,
  wpListEsize,
  wpListCount,
} from "../../runtime/src/pointer.ts";
import type { Ptr } from "../../runtime/src/message.ts";

// ---------------------------------------------------------------------------
// Rich AST types (schema.capnp Node / Field / Type / Enumerant)
// ---------------------------------------------------------------------------

/** Node union tags (u16 at data byte 12). */
export const NODE_FILE = 0;
export const NODE_STRUCT = 1;
export const NODE_ENUM = 2;
export const NODE_INTERFACE = 3;
export const NODE_CONST = 4;
export const NODE_ANNOTATION = 5;

export type NodeWhichName =
  | "file"
  | "struct"
  | "enum"
  | "interface"
  | "const"
  | "annotation";

const NODE_WHICH_NAMES: readonly NodeWhichName[] = [
  "file",
  "struct",
  "enum",
  "interface",
  "const",
  "annotation",
] as const;

/** Field union tags (u16 at data byte 8). */
export const FIELD_SLOT = 0;
export const FIELD_GROUP = 1;

/** Type union tags (u16 at data byte 0). */
export const TYPE_VOID = 0;
export const TYPE_BOOL = 1;
export const TYPE_INT8 = 2;
export const TYPE_INT16 = 3;
export const TYPE_INT32 = 4;
export const TYPE_INT64 = 5;
export const TYPE_UINT8 = 6;
export const TYPE_UINT16 = 7;
export const TYPE_UINT32 = 8;
export const TYPE_UINT64 = 9;
export const TYPE_FLOAT32 = 10;
export const TYPE_FLOAT64 = 11;
export const TYPE_TEXT = 12;
export const TYPE_DATA = 13;
export const TYPE_LIST = 14;
export const TYPE_ENUM = 15;
export const TYPE_STRUCT = 16;
export const TYPE_INTERFACE = 17;
export const TYPE_ANY_POINTER = 18;

export type TypeWhichName =
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

const TYPE_WHICH_NAMES: readonly TypeWhichName[] = [
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
] as const;

/** Field.noDiscriminant — not a union member (schema.capnp default 0xffff). */
export const NO_DISCRIMINANT = 0xffff;

/** Decoded Cap'n Proto Type (recursive for list). */
export type TypeAst =
  | { which: Exclude<TypeWhichName, "list" | "enum" | "struct" | "interface"> }
  | { which: "list"; elementType: TypeAst }
  | { which: "enum"; typeId: bigint }
  | { which: "struct"; typeId: bigint }
  | { which: "interface"; typeId: bigint };

/**
 * Decoded schema.capnp Value (scalar + text/data only for v1 walk).
 * Pointer/list/struct/anyPointer defaults are recorded as `{ which }` without payload.
 */
export type ValueAst =
  | { which: "void" }
  | { which: "bool"; value: boolean }
  | {
      which:
        | "int8"
        | "int16"
        | "int32"
        | "uint8"
        | "uint16"
        | "uint32"
        | "enum";
      value: number;
    }
  | { which: "int64" | "uint64"; value: bigint }
  | { which: "float32" | "float64"; value: number }
  | { which: "text"; value: string }
  | { which: "data"; value: Uint8Array }
  | {
      which:
        | "list"
        | "struct"
        | "interface"
        | "anyPointer";
    };

/** One struct field (slot or group). */
export type FieldAst = {
  name: string;
  codeOrder: number;
  /** Union discriminant arm, or NO_DISCRIMINANT (0xffff) if not in a union. */
  discriminant: number;
  /** Present when field.which == slot. */
  slot?: {
    /** Offset in units of the field's own size (bits for Bool, ptr slots for pointers). */
    offset: number;
    type: TypeAst;
    /** schema.capnp Field.slot.defaultValue (always present on wire; often zero). */
    defaultValue?: ValueAst;
    /** Field.slot.hadExplicitDefault (@10). */
    hadExplicitDefault?: boolean;
  };
  /** Present when field.which == group. */
  group?: {
    typeId: bigint;
  };
};

/** One enum member. */
export type EnumerantAst = {
  name: string;
  codeOrder: number;
};

/** NestedNode entry (name + id). */
export type NestedNodeAst = {
  name: string;
  id: bigint;
};

/** Struct-specific Node payload. */
export type StructNodeAst = {
  dataWordCount: number;
  pointerCount: number;
  isGroup: boolean;
  discriminantCount: number;
  /** Discriminant offset in multiples of 16 bits (schema.capnp). */
  discriminantOffset: number;
  fields: FieldAst[];
};

/** Full Node from CodeGeneratorRequest.nodes. */
export type NodeAst = {
  id: bigint;
  displayName: string;
  displayNamePrefixLength: number;
  scopeId: bigint;
  which: NodeWhichName;
  whichTag: number;
  nestedNodes: NestedNodeAst[];
  /** Set when which === "struct". */
  struct?: StructNodeAst;
  /** Set when which === "enum". */
  enumerants?: EnumerantAst[];
};

export type RequestedFileAst = {
  id: bigint;
  filename: string;
};

/** Full decoded CodeGeneratorRequest graph (nodes + requested files). */
export type CgrAst = {
  nodes: NodeAst[];
  requestedFiles: RequestedFileAst[];
};

export type CgrSummary = {
  nodeCount: number;
  requestedFileCount: number;
  /** Paths from requestedFiles[i].filename (may be empty if unreadable). */
  requestedFilenames: string[];
};

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Prefer Message.fromFlat when the wire reader module is present;
 * otherwise hand-offset walk of the same CGR layout.
 */
export async function summarizeCgr(bytes: Uint8Array): Promise<CgrSummary> {
  try {
    const ast = await walkCgr(bytes);
    return summaryFromAst(ast);
  } catch (primary) {
    try {
      return summarizeViaHandWalk(bytes);
    } catch {
      throw primary;
    }
  }
}

/** Derive the thin count summary from a full AST. */
export function summaryFromAst(ast: CgrAst): CgrSummary {
  return {
    nodeCount: ast.nodes.length,
    requestedFileCount: ast.requestedFiles.length,
    requestedFilenames: ast.requestedFiles.map((f) => f.filename),
  };
}

/**
 * Full CodeGeneratorRequest walk: all nodes with struct fields, types,
 * enumerants. Uses Message.fromFlat (far pointers, multi-segment).
 */
export async function walkCgr(bytes: Uint8Array): Promise<CgrAst> {
  const { Message } = await import("../../runtime/src/message.ts");
  const msg = Message.fromFlat(bytes);
  // Schema graphs are deep; raise traversal budget after open.
  msg.traversalLeft = 1_073_741_824;
  msg.depthLimit = 256;

  const root = msg.root();
  if (root.kind !== PtrKind.Struct) {
    throw new Error("CGR: root is not a struct");
  }

  const nodesList = root.getp(0);
  const reqFiles = root.getp(1);
  const nodes: NodeAst[] = [];
  if (nodesList.kind === PtrKind.List) {
    for (let i = 0; i < nodesList.listLen(); i++) {
      nodes.push(decodeNode(nodesList.listGetp(i)));
    }
  }

  const requestedFiles: RequestedFileAst[] = [];
  if (reqFiles.kind === PtrKind.List) {
    for (let i = 0; i < reqFiles.listLen(); i++) {
      const rf = reqFiles.listGetp(i);
      if (rf.kind !== PtrKind.Struct) {
        requestedFiles.push({ id: 0n, filename: "" });
        continue;
      }
      requestedFiles.push({
        id: rf.getU64(0),
        filename: rf.getText(0),
      });
    }
  }

  return { nodes, requestedFiles };
}

async function summarizeViaMessage(bytes: Uint8Array): Promise<CgrSummary> {
  return summaryFromAst(await walkCgr(bytes));
}

// Keep export for callers that want the Message-only summary path name.
export { summarizeViaMessage };

// ---------------------------------------------------------------------------
// Node / Field / Type decode (Message Ptr path)
// ---------------------------------------------------------------------------

function nodeWhichName(tag: number): NodeWhichName {
  return NODE_WHICH_NAMES[tag] ?? "file";
}

function typeWhichName(tag: number): TypeWhichName {
  return TYPE_WHICH_NAMES[tag] ?? "void";
}

function decodeType(t: Ptr): TypeAst {
  if (t.kind !== PtrKind.Struct) {
    return { which: "void" };
  }
  const tag = t.getU16(0);
  const which = typeWhichName(tag);
  if (which === "list") {
    return { which: "list", elementType: decodeType(t.getp(0)) };
  }
  if (which === "enum" || which === "struct" || which === "interface") {
    return { which, typeId: t.getU64(8) };
  }
  return { which };
}

/**
 * Decode schema.capnp Value for Field.slot.defaultValue.
 * Layout mirrors Type tags; scalar payload lives in the data section / ptr0.
 */
function decodeValue(v: Ptr): ValueAst {
  if (v.kind !== PtrKind.Struct) {
    return { which: "void" };
  }
  const tag = v.getU16(0);
  // Value which tags match Type for void..anyPointer (schema.capnp).
  switch (tag) {
    case TYPE_VOID:
      return { which: "void" };
    case TYPE_BOOL:
      return { which: "bool", value: v.getBool(16) };
    case TYPE_INT8:
      return { which: "int8", value: (v.getU8(2) << 24) >> 24 };
    case TYPE_INT16:
      return { which: "int16", value: (v.getU16(2) << 16) >> 16 };
    case TYPE_INT32:
      return { which: "int32", value: v.getU32(4) | 0 };
    case TYPE_INT64:
      return { which: "int64", value: v.getU64(8) };
    case TYPE_UINT8:
      return { which: "uint8", value: v.getU8(2) };
    case TYPE_UINT16:
      return { which: "uint16", value: v.getU16(2) };
    case TYPE_UINT32:
      return { which: "uint32", value: v.getU32(4) >>> 0 };
    case TYPE_UINT64:
      return { which: "uint64", value: v.getU64(8) };
    case TYPE_FLOAT32:
      // Value.float32 is IEEE bits at byte 4; return the float, not the bits.
      return { which: "float32", value: v.getF32(4) };
    case TYPE_FLOAT64:
      return { which: "float64", value: v.getF64(8) };
    case TYPE_TEXT:
      return { which: "text", value: v.getText(0) };
    case TYPE_DATA:
      return { which: "data", value: v.getData(0) };
    case TYPE_ENUM:
      return { which: "enum", value: v.getU16(2) };
    case TYPE_LIST:
      return { which: "list" };
    case TYPE_STRUCT:
      return { which: "struct" };
    case TYPE_INTERFACE:
      return { which: "interface" };
    case TYPE_ANY_POINTER:
      return { which: "anyPointer" };
    default:
      return { which: "void" };
  }
}

function decodeField(f: Ptr): FieldAst {
  const name = f.kind === PtrKind.Struct ? f.getText(0) : "";
  const codeOrder = f.getU16(0);
  // discriminantValue default is 0xffff; Cap'n Proto stores wire XOR default.
  const discriminant = (f.getU16(2) ^ NO_DISCRIMINANT) & 0xffff;
  const which = f.getU16(8);
  if (which === FIELD_GROUP) {
    return {
      name,
      codeOrder,
      discriminant,
      group: { typeId: f.getU64(16) },
    };
  }
  // slot (default). type = ptr2, defaultValue = ptr3; hadExplicitDefault @ bit 128.
  return {
    name,
    codeOrder,
    discriminant,
    slot: {
      offset: f.getU32(4) >>> 0,
      type: decodeType(f.getp(2)),
      defaultValue: decodeValue(f.getp(3)),
      hadExplicitDefault: f.getBool(128),
    },
  };
}

function decodeNestedNodes(list: Ptr): NestedNodeAst[] {
  if (list.kind !== PtrKind.List) return [];
  const out: NestedNodeAst[] = [];
  for (let i = 0; i < list.listLen(); i++) {
    const nn = list.listGetp(i);
    out.push({
      name: nn.kind === PtrKind.Struct ? nn.getText(0) : "",
      id: nn.kind === PtrKind.Struct ? nn.getU64(0) : 0n,
    });
  }
  return out;
}

function decodeEnumerants(list: Ptr): EnumerantAst[] {
  if (list.kind !== PtrKind.List) return [];
  const out: EnumerantAst[] = [];
  for (let i = 0; i < list.listLen(); i++) {
    const e = list.listGetp(i);
    out.push({
      name: e.kind === PtrKind.Struct ? e.getText(0) : "",
      codeOrder: e.kind === PtrKind.Struct ? e.getU16(0) : 0,
    });
  }
  return out;
}

function decodeStructFields(list: Ptr): FieldAst[] {
  if (list.kind !== PtrKind.List) return [];
  const out: FieldAst[] = [];
  for (let i = 0; i < list.listLen(); i++) {
    out.push(decodeField(list.listGetp(i)));
  }
  return out;
}

function decodeNode(n: Ptr): NodeAst {
  if (n.kind !== PtrKind.Struct) {
    return {
      id: 0n,
      displayName: "",
      displayNamePrefixLength: 0,
      scopeId: 0n,
      which: "file",
      whichTag: 0,
      nestedNodes: [],
    };
  }

  const whichTag = n.getU16(12);
  const which = nodeWhichName(whichTag);
  const base: NodeAst = {
    id: n.getU64(0),
    displayName: n.getText(0),
    displayNamePrefixLength: n.getU32(8) >>> 0,
    scopeId: n.getU64(16),
    which,
    whichTag,
    nestedNodes: decodeNestedNodes(n.getp(1)),
  };

  if (which === "struct") {
    base.struct = {
      dataWordCount: n.getU16(14),
      pointerCount: n.getU16(24),
      isGroup: n.getBool(224),
      discriminantCount: n.getU16(30),
      discriminantOffset: n.getU32(32) >>> 0,
      fields: decodeStructFields(n.getp(3)),
    };
  } else if (which === "enum") {
    base.enumerants = decodeEnumerants(n.getp(3));
  }

  return base;
}

// ---------------------------------------------------------------------------
// Pretty-print (human walk dump)
// ---------------------------------------------------------------------------

/** Format a TypeAst as a short schema-like string. */
export function formatType(t: TypeAst): string {
  switch (t.which) {
    case "list":
      return `List(${formatType(t.elementType)})`;
    case "enum":
      return `Enum(0x${t.typeId.toString(16)})`;
    case "struct":
      return `Struct(0x${t.typeId.toString(16)})`;
    case "interface":
      return `Interface(0x${t.typeId.toString(16)})`;
    default:
      return t.which;
  }
}

/** Multi-line dump of one node (id, displayName, which, fields/enumerants). */
export function formatNode(node: NodeAst): string {
  const lines: string[] = [];
  lines.push(
    `${node.which} 0x${node.id.toString(16)} ${node.displayName}`,
  );
  if (node.struct) {
    const s = node.struct;
    lines.push(
      `  dataWordCount=${s.dataWordCount} pointerCount=${s.pointerCount}` +
        ` isGroup=${s.isGroup} discriminantCount=${s.discriminantCount}` +
        ` discriminantOffset=${s.discriminantOffset}`,
    );
    for (const f of s.fields) {
      const disc =
        f.discriminant === NO_DISCRIMINANT
          ? "none"
          : String(f.discriminant);
      if (f.slot) {
        lines.push(
          `  field ${f.name} codeOrder=${f.codeOrder} discriminant=${disc}` +
            ` slot offset=${f.slot.offset} type=${formatType(f.slot.type)}`,
        );
      } else if (f.group) {
        lines.push(
          `  field ${f.name} codeOrder=${f.codeOrder} discriminant=${disc}` +
            ` group typeId=0x${f.group.typeId.toString(16)}`,
        );
      } else {
        lines.push(
          `  field ${f.name} codeOrder=${f.codeOrder} discriminant=${disc}`,
        );
      }
    }
  }
  if (node.enumerants) {
    for (let i = 0; i < node.enumerants.length; i++) {
      const e = node.enumerants[i]!;
      lines.push(`  enumerant ${i} ${e.name} codeOrder=${e.codeOrder}`);
    }
  }
  return lines.join("\n");
}

/** Full multi-line walk dump for a CGR AST. */
export function formatCgrAst(ast: CgrAst): string {
  const lines: string[] = [];
  lines.push(
    `CodeGeneratorRequest nodes=${ast.nodes.length} requestedFiles=${ast.requestedFiles.length}`,
  );
  for (const rf of ast.requestedFiles) {
    lines.push(`  requested 0x${rf.id.toString(16)} ${rf.filename}`);
  }
  for (const n of ast.nodes) {
    lines.push(formatNode(n));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Hand-offset walk (schema.capnp CodeGeneratorRequest layout) — summary only
// ---------------------------------------------------------------------------

/** Parse stream framing; return segment byte slices (views into `bytes`). */
export function parseFramedSegments(bytes: Uint8Array): Uint8Array[] {
  if (bytes.length < 8) {
    throw new Error("CGR framing: buffer too short for segment table");
  }
  const segCount = loadU32(bytes, 0) + 1;
  if (segCount < 1 || segCount > 512) {
    throw new Error(`CGR framing: absurd segment count ${segCount}`);
  }
  const tableBytes = 4 + 4 * segCount;
  const headerBytes = (tableBytes + 7) & ~7;
  if (bytes.length < headerBytes) {
    throw new Error("CGR framing: truncated segment table");
  }
  const segs: Uint8Array[] = [];
  let pos = headerBytes;
  for (let i = 0; i < segCount; i++) {
    const words = loadU32(bytes, 4 + 4 * i);
    const nbytes = words * WORD_BYTES;
    if (pos + nbytes > bytes.length) {
      throw new Error(`CGR framing: segment ${i} overruns buffer`);
    }
    segs.push(bytes.subarray(pos, pos + nbytes));
    pos += nbytes;
  }
  return segs;
}

function readWord(seg: Uint8Array, byteOff: number): bigint {
  if (byteOff < 0 || byteOff + 8 > seg.length) {
    throw new Error(`CGR walk: word read OOB at ${byteOff}`);
  }
  return loadU64(seg, byteOff);
}

function nearBody(seg: Uint8Array, ptrByteOff: number, word: bigint): number {
  const kind = wpKind(word);
  if (kind === WireKind.Far || kind === WireKind.Cap) {
    throw new Error(`CGR walk: unsupported pointer kind ${kind} (far/cap)`);
  }
  if (word === 0n) {
    throw new Error("CGR walk: null pointer");
  }
  const off = wpOffset(word);
  return ptrByteOff + WORD_BYTES + off * WORD_BYTES;
}

function listLenHand(seg: Uint8Array, ptrByteOff: number, word: bigint): number {
  if (wpKind(word) !== WireKind.List) {
    throw new Error(`CGR walk: expected list pointer, got kind ${wpKind(word)}`);
  }
  const esize = wpListEsize(word);
  if (esize === ElemSize.Composite) {
    const body = nearBody(seg, ptrByteOff, word);
    const tag = readWord(seg, body);
    return Number((tag >> 2n) & 0x3fffffffn);
  }
  return wpListCount(word);
}

function readTextHand(seg: Uint8Array, ptrByteOff: number, word: bigint): string {
  if (word === 0n) return "";
  if (wpKind(word) !== WireKind.List) {
    throw new Error("CGR walk: Text is not a list pointer");
  }
  if (wpListEsize(word) !== ElemSize.Byte) {
    throw new Error("CGR walk: Text esize != byte");
  }
  const count = wpListCount(word);
  const body = nearBody(seg, ptrByteOff, word);
  const n = Math.max(0, count - 1);
  if (body + n > seg.length) {
    throw new Error("CGR walk: Text overruns segment");
  }
  return new TextDecoder().decode(seg.subarray(body, body + n));
}

/** Single-segment near-pointer hand walk of CGR (counts + filenames only). */
export function summarizeViaHandWalk(bytes: Uint8Array): CgrSummary {
  const segs = parseFramedSegments(bytes);
  const seg0 = segs[0];
  if (!seg0 || seg0.length < WORD_BYTES) {
    throw new Error("CGR walk: empty segment 0");
  }

  const rootWord = readWord(seg0, 0);
  if (wpKind(rootWord) !== WireKind.Struct) {
    throw new Error(`CGR walk: root is not a struct (kind ${wpKind(rootWord)})`);
  }
  const rootBody = nearBody(seg0, 0, rootWord);
  const dwords = wpStructDwords(rootWord);
  const pwords = wpStructPwords(rootWord);
  if (pwords < 2) {
    throw new Error(`CGR walk: root has only ${pwords} pointers`);
  }
  const ptrBase = rootBody + dwords * WORD_BYTES;

  const nodesWord = readWord(seg0, ptrBase + 0 * WORD_BYTES);
  const reqWord = readWord(seg0, ptrBase + 1 * WORD_BYTES);

  const nodeCount =
    nodesWord === 0n ? 0 : listLenHand(seg0, ptrBase + 0 * WORD_BYTES, nodesWord);
  const requestedFileCount =
    reqWord === 0n ? 0 : listLenHand(seg0, ptrBase + 1 * WORD_BYTES, reqWord);

  const requestedFilenames: string[] = [];
  if (reqWord !== 0n && requestedFileCount > 0) {
    const listBody = nearBody(seg0, ptrBase + 1 * WORD_BYTES, reqWord);
    const tag = readWord(seg0, listBody);
    const elemDw = wpStructDwords(tag);
    const elemPw = wpStructPwords(tag);
    const elemBytes = (elemDw + elemPw) * WORD_BYTES;
    const firstElem = listBody + WORD_BYTES;
    for (let i = 0; i < requestedFileCount; i++) {
      const elemOff = firstElem + i * elemBytes;
      const fnamePtrOff = elemOff + elemDw * WORD_BYTES;
      try {
        const fw = readWord(seg0, fnamePtrOff);
        requestedFilenames.push(readTextHand(seg0, fnamePtrOff, fw));
      } catch {
        requestedFilenames.push("");
      }
    }
  }

  return { nodeCount, requestedFileCount, requestedFilenames };
}
