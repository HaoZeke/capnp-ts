/**
 * Cap'n Proto text-format encoder and decoder (models capnp/pretty-print.h
 * and capnp/serialize-text.h, matching `capnp decode` and `capnp encode`).
 */

import { MessageBuilder } from "./builder.ts";
import {
  DynamicCapabilityClient,
  DynamicEnum,
  DynamicListBuilder,
  DynamicListReader,
  DynamicStructBuilder,
  DynamicStructReader,
  DynamicValueBuilder,
  DynamicValueReader,
  DynamicValueType,
  initDynamicRoot,
} from "./dynamic.ts";
import { CapnpError, assertCapnp } from "./kinds.ts";
import { Message } from "./message.ts";
import {
  ListSchema,
  StructField,
  StructSchema,
  Type,
  TypeKind,
} from "./schema.ts";

const UTF8_ENC = new TextEncoder();
const UTF8_DEC = new TextDecoder("utf-8", { fatal: false });

function utf8ByteLength(s: string): number {
  return UTF8_ENC.encode(s).byteLength;
}

/**
 * Format a positive/negative finite number using C `snprintf("%.*g", prec, v)`
 * rules with KJ exponent normalization (`e+06` -> `e06`, `e-05` -> `e-05`).
 */
function formatCPrintfG(v: number, prec: number): string {
  const sign = v < 0 || Object.is(v, -0) ? "-" : "";
  const abs = Math.abs(v);
  if (abs === 0) return `${sign}0`;

  const expStr = abs.toExponential(prec - 1);
  const eIdx = expStr.indexOf("e");
  const mant = expStr.slice(0, eIdx);
  const exp = Number.parseInt(expStr.slice(eIdx + 1), 10);
  const digits = mant.replace(".", "");
  const sig = digits.replace(/0+$/, "") || "0";

  if (exp < -4 || exp >= prec) {
    const m = sig.length === 1 ? sig : `${sig[0]}.${sig.slice(1)}`;
    const eSign = exp < 0 ? "-" : "";
    const eAbs = Math.abs(exp).toString().padStart(2, "0");
    return `${sign}${m}e${eSign}${eAbs}`;
  }

  if (exp < 0) {
    return `${sign}0.${"0".repeat(-exp - 1)}${sig}`;
  }
  if (exp + 1 >= sig.length) {
    return `${sign}${sig}${"0".repeat(exp + 1 - sig.length)}`;
  }
  return `${sign}${sig.slice(0, exp + 1)}.${sig.slice(exp + 1)}`;
}

/** Format a Float32 matching `kj::str(float)`. */
export function formatKjFloat32(v: number): string {
  const f = Math.fround(v);
  if (Number.isNaN(f)) return "nan";
  if (f === Infinity) return "inf";
  if (f === -Infinity) return "-inf";
  if (f === 0) return Object.is(f, -0) ? "-0" : "0";

  for (const prec of [6, 7, 8, 9]) {
    const s = formatCPrintfG(f, prec);
    if (Math.fround(Number(s)) === f) return s;
  }
  return formatCPrintfG(f, 9);
}

/** Format a Float64 matching `kj::str(double)`. */
export function formatKjFloat64(v: number): string {
  if (Number.isNaN(v)) return "nan";
  if (v === Infinity) return "inf";
  if (v === -Infinity) return "-inf";
  if (v === 0) return Object.is(v, -0) ? "-0" : "0";

  const s15 = formatCPrintfG(v, 15);
  if (Number(s15) === v) return s15;
  return formatCPrintfG(v, 17);
}

function escapeByteC(b: number): string {
  switch (b) {
    case 0x07:
      return "\\a";
    case 0x08:
      return "\\b";
    case 0x09:
      return "\\t";
    case 0x0a:
      return "\\n";
    case 0x0b:
      return "\\v";
    case 0x0c:
      return "\\f";
    case 0x0d:
      return "\\r";
    case 0x22:
      return '\\"';
    case 0x27:
      return "\\'";
    case 0x5c:
      return "\\\\";
    default:
      if (b >= 0x20 && b < 0x7f) {
        return String.fromCharCode(b);
      }
      return `\\${b.toString(8).padStart(3, "0")}`;
  }
}

/** Escape Data bytes matching `kj::encodeCEscape(ArrayPtr<const byte>)`. */
export function encodeCEscapeData(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += escapeByteC(bytes[i]!);
  }
  return out;
}

/** Escape UTF-8 Text matching `kj::encodeCEscape(StringPtr)`. */
export function encodeCEscapeText(text: string): string {
  const bytes = UTF8_ENC.encode(text);
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i]!;
    if (b < 0x80) {
      out += escapeByteC(b);
      i++;
      continue;
    }
    // Preserve valid multi-byte UTF-8 sequences verbatim as KJ does for chars.
    let seqLen = 0;
    if ((b & 0xe0) === 0xc0) seqLen = 2;
    else if ((b & 0xf0) === 0xe0) seqLen = 3;
    else if ((b & 0xf8) === 0xf0) seqLen = 4;
    if (seqLen > 0 && i + seqLen <= bytes.length) {
      let valid = true;
      for (let k = 1; k < seqLen; k++) {
        if ((bytes[i + k]! & 0xc0) !== 0x80) {
          valid = false;
          break;
        }
      }
      if (valid) {
        out += UTF8_DEC.decode(bytes.subarray(i, i + seqLen));
        i += seqLen;
        continue;
      }
    }
    out += escapeByteC(b);
    i++;
  }
  return out;
}

type PrintMode = "bare" | "prefixed" | "parenthesized";
type PrintKind = "list" | "record";

const MAX_INLINE_VALUE_SIZE = 24;
const MAX_INLINE_RECORD_SIZE = 64;

class Indent {
  readonly amount: number;

  constructor(amount: number) {
    this.amount = amount;
  }

  static root(enable: boolean): Indent {
    return new Indent(enable ? 1 : 0);
  }

  next(): Indent {
    return new Indent(this.amount === 0 ? 0 : this.amount + 1);
  }

  delimit(items: readonly string[], mode: PrintMode, kind: PrintKind): string {
    if (this.amount === 0 || Indent.canPrintAllInline(items, kind)) {
      return items.join(", ");
    }
    const spaces = " ".repeat(this.amount * 2);
    const delim = `,\n${spaces}`;
    const prefix = mode === "bare" ? " " : `\n${spaces}`;
    return `${prefix}${items.join(delim)} `;
  }

  private static canPrintInline(item: string): boolean {
    if (item.includes("\n")) return false;
    return utf8ByteLength(item) <= MAX_INLINE_VALUE_SIZE;
  }

  private static canPrintAllInline(
    items: readonly string[],
    kind: PrintKind,
  ): boolean {
    let totalSize = 0;
    for (const item of items) {
      if (!Indent.canPrintInline(item)) return false;
      if (kind === "record") {
        totalSize += utf8ByteLength(item);
        if (totalSize > MAX_INLINE_RECORD_SIZE) return false;
      }
    }
    return true;
  }
}

function whichFieldTypeCode(field: StructField): number {
  if (field.isGroup()) return TypeKind.Struct;
  return field.getType().whichCode;
}

function printDynamicValue(
  value: DynamicValueReader,
  typeCode: number,
  indent: Indent,
  mode: PrintMode,
): string {
  switch (value.getType()) {
    case DynamicValueType.UNKNOWN:
      return "?";
    case DynamicValueType.VOID:
      return "void";
    case DynamicValueType.BOOL:
      return value.asBool() ? "true" : "false";
    case DynamicValueType.INT:
      return value.asInt64().toString(10);
    case DynamicValueType.UINT:
      return value.asUInt64().toString(10);
    case DynamicValueType.FLOAT:
      if (typeCode === TypeKind.Float32) {
        return formatKjFloat32(value.asFloat32());
      }
      return formatKjFloat64(value.asFloat64());
    case DynamicValueType.TEXT:
      return `"${encodeCEscapeText(value.asText())}"`;
    case DynamicValueType.DATA:
      return `"${encodeCEscapeData(value.asData())}"`;
    case DynamicValueType.LIST: {
      const list = value.asList();
      const elemCode = list.getSchema().whichElementTypeCode();
      const nextIndent = indent.next();
      const elements: string[] = [];
      for (let i = 0; i < list.size(); i++) {
        elements.push(
          printDynamicValue(list.get(i), elemCode, nextIndent, "bare"),
        );
      }
      return `[${indent.delimit(elements, mode, "list")}]`;
    }
    case DynamicValueType.ENUM: {
      const e = value.asEnum();
      const enumerant = e.getEnumerant();
      if (enumerant) return enumerant.name;
      return `(${e.getRaw()})`;
    }
    case DynamicValueType.STRUCT: {
      const st = value.asStruct();
      const schema = st.getSchema();
      const nonUnionFields = schema.getNonUnionFields();
      const printed: string[] = [];

      let activeUnion = st.which();
      let unionRendered = "";
      if (activeUnion) {
        if (activeUnion.discriminantValue !== 0 || st.has(activeUnion)) {
          unionRendered = `${activeUnion.name} = ${printDynamicValue(
            st.get(activeUnion),
            whichFieldTypeCode(activeUnion),
            indent.next(),
            "prefixed",
          )}`;
        } else {
          activeUnion = null;
        }
      }

      for (const field of nonUnionFields) {
        if (activeUnion && activeUnion.index < field.index) {
          printed.push(unionRendered);
          activeUnion = null;
        }
        if (st.has(field)) {
          printed.push(
            `${field.name} = ${printDynamicValue(
              st.get(field),
              whichFieldTypeCode(field),
              indent.next(),
              "prefixed",
            )}`,
          );
        }
      }
      if (activeUnion) {
        printed.push(unionRendered);
      }

      if (mode === "parenthesized") {
        return indent.delimit(printed, mode, "record");
      }
      return `(${indent.delimit(printed, mode, "record")})`;
    }
    case DynamicValueType.CAPABILITY:
      return "<external capability>";
    case DynamicValueType.ANY_POINTER:
      return "<opaque pointer>";
  }
}

export type PrintableDynamic =
  | DynamicValueReader
  | DynamicValueBuilder
  | DynamicStructReader
  | DynamicStructBuilder
  | DynamicListReader
  | DynamicListBuilder
  | DynamicEnum
  | DynamicCapabilityClient;

function normalizePrintable(v: PrintableDynamic): {
  reader: DynamicValueReader;
  defaultTypeCode: number;
} {
  if (v instanceof DynamicValueReader) {
    return { reader: v, defaultTypeCode: TypeKind.Struct };
  }
  if (v instanceof DynamicValueBuilder) {
    return { reader: v.asReader(), defaultTypeCode: TypeKind.Struct };
  }
  if (v instanceof DynamicStructReader) {
    return {
      reader: DynamicValueReader.fromStruct(v),
      defaultTypeCode: TypeKind.Struct,
    };
  }
  if (v instanceof DynamicStructBuilder) {
    return {
      reader: DynamicValueReader.fromStruct(v.asReader()),
      defaultTypeCode: TypeKind.Struct,
    };
  }
  if (v instanceof DynamicListReader) {
    return {
      reader: DynamicValueReader.fromList(v),
      defaultTypeCode: TypeKind.List,
    };
  }
  if (v instanceof DynamicListBuilder) {
    return {
      reader: DynamicValueReader.fromList(v.asReader()),
      defaultTypeCode: TypeKind.List,
    };
  }
  if (v instanceof DynamicEnum) {
    return {
      reader: DynamicValueReader.fromEnum(v),
      defaultTypeCode: TypeKind.Enum,
    };
  }
  return {
    reader: DynamicValueReader.fromCapability(v),
    defaultTypeCode: TypeKind.Interface,
  };
}

/** Multi-line indented Cap'n Proto text output matching `capnp::prettyPrint`. */
export function prettyPrint(
  value:
    | DynamicStructReader
    | DynamicStructBuilder
    | DynamicListReader
    | DynamicListBuilder,
): string {
  const { reader, defaultTypeCode } = normalizePrintable(value);
  return printDynamicValue(reader, defaultTypeCode, Indent.root(true), "bare");
}

/** Single-line Cap'n Proto text output matching `kj::str(DynamicValue::Reader)`. */
export function stringify(value: PrintableDynamic, type?: Type): string {
  const { reader, defaultTypeCode } = normalizePrintable(value);
  return printDynamicValue(
    reader,
    type ? type.whichCode : defaultTypeCode,
    Indent.root(false),
    "bare",
  );
}

// ---------------------------------------------------------------------------
// Text-format Lexer and Recursive-Descent Parser
// ---------------------------------------------------------------------------

type TextAst =
  | { readonly kind: "ident"; readonly name: string }
  | { readonly kind: "int"; readonly value: bigint; readonly negativeZero: boolean }
  | { readonly kind: "float"; readonly value: number }
  | { readonly kind: "bytes"; readonly bytes: Uint8Array; readonly isHexBlob: boolean }
  | { readonly kind: "list"; readonly items: readonly TextAst[] }
  | {
      readonly kind: "tuple";
      readonly entries: readonly {
        readonly name: string | null;
        readonly value: TextAst;
      }[];
    };

function isHexDigit(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) ||
    (c >= 0x41 && c <= 0x46) ||
    (c >= 0x61 && c <= 0x66)
  );
}

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  throw new CapnpError("TEXT", "invalid hex digit");
}

function isIdentStart(c: number): boolean {
  return (
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    c === 0x5f
  );
}

function isIdentCont(c: number): boolean {
  return isIdentStart(c) || (c >= 0x30 && c <= 0x39);
}

class TextParser {
  private readonly src: string;
  private pos = 0;

  constructor(src: string) {
    this.src = src;
  }

  private fail(msg: string): never {
    throw new CapnpError("TEXT", `${msg} at offset ${this.pos}`);
  }

  skipSpaceAndComments(): void {
    while (this.pos < this.src.length) {
      const c = this.src.charCodeAt(this.pos);
      if (
        c === 0x20 ||
        c === 0x09 ||
        c === 0x0a ||
        c === 0x0d ||
        c === 0x0b ||
        c === 0x0c ||
        c === 0xfeff
      ) {
        this.pos++;
        continue;
      }
      if (c === 0x23 /* '#' */) {
        while (
          this.pos < this.src.length &&
          this.src.charCodeAt(this.pos) !== 0x0a
        ) {
          this.pos++;
        }
        continue;
      }
      break;
    }
  }

  atEnd(): boolean {
    this.skipSpaceAndComments();
    return this.pos >= this.src.length;
  }

  parseSingleExpression(): TextAst {
    this.skipSpaceAndComments();
    if (this.pos >= this.src.length) {
      this.fail("empty text input");
    }
    const expr = this.parseExpression();
    this.skipSpaceAndComments();
    if (this.pos < this.src.length) {
      this.fail("unexpected extra tokens in text input");
    }
    return expr;
  }

  parseExpression(): TextAst {
    this.skipSpaceAndComments();
    if (this.pos >= this.src.length) {
      this.fail("premature end of text input");
    }
    const c = this.src.charCodeAt(this.pos);

    if (c === 0x28 /* '(' */) {
      return this.parseTuple();
    }
    if (c === 0x5b /* '[' */) {
      return this.parseList();
    }
    if (c === 0x22 /* '"' */ || c === 0x27 /* '\'' */ || c === 0x60 /* '`' */) {
      return this.parseStringChain(false);
    }
    if (
      c === 0x30 /* '0' */ &&
      this.pos + 2 < this.src.length &&
      (this.src[this.pos + 1] === "x" || this.src[this.pos + 1] === "X") &&
      (this.src[this.pos + 2] === '"' || this.src[this.pos + 2] === "'")
    ) {
      return this.parseHexBlobChain();
    }
    if (
      c === 0x2d /* '-' */ ||
      (c >= 0x30 && c <= 0x39)
    ) {
      return this.parseNumberOrSignedIdent();
    }
    if (isIdentStart(c)) {
      const name = this.readIdentifier();
      return { kind: "ident", name };
    }

    this.fail(`unexpected character '${this.src[this.pos]}'`);
  }

  private readIdentifier(): string {
    const start = this.pos;
    while (
      this.pos < this.src.length &&
      isIdentCont(this.src.charCodeAt(this.pos))
    ) {
      this.pos++;
    }
    if (this.pos === start) this.fail("expected identifier");
    return this.src.slice(start, this.pos);
  }

  private parseTuple(): TextAst {
    this.pos++; // '('
    const entries: Array<{ name: string | null; value: TextAst }> = [];
    this.skipSpaceAndComments();
    if (this.pos < this.src.length && this.src[this.pos] === ")") {
      this.pos++;
      return { kind: "tuple", entries };
    }

    for (;;) {
      this.skipSpaceAndComments();
      if (this.pos < this.src.length && this.src[this.pos] === ")") {
        this.pos++;
        break;
      }

      // Check for `ident = expr` vs positional `(expr)` (e.g. unknown enum `(77)`).
      const savedPos = this.pos;
      let fieldName: string | null = null;
      if (
        this.pos < this.src.length &&
        isIdentStart(this.src.charCodeAt(this.pos))
      ) {
        const cand = this.readIdentifier();
        this.skipSpaceAndComments();
        if (this.pos < this.src.length && this.src[this.pos] === "=") {
          this.pos++; // '='
          fieldName = cand;
        } else {
          this.pos = savedPos;
        }
      }

      const value = this.parseExpression();
      entries.push({ name: fieldName, value });

      this.skipSpaceAndComments();
      if (this.pos < this.src.length && this.src[this.pos] === ",") {
        this.pos++;
        continue;
      }
      if (this.pos < this.src.length && this.src[this.pos] === ")") {
        this.pos++;
        break;
      }
      this.fail("expected ',' or ')' in struct literal");
    }

    return { kind: "tuple", entries };
  }

  private parseList(): TextAst {
    this.pos++; // '['
    const items: TextAst[] = [];
    this.skipSpaceAndComments();
    if (this.pos < this.src.length && this.src[this.pos] === "]") {
      this.pos++;
      return { kind: "list", items };
    }

    for (;;) {
      this.skipSpaceAndComments();
      if (this.pos < this.src.length && this.src[this.pos] === "]") {
        this.pos++;
        break;
      }
      items.push(this.parseExpression());
      this.skipSpaceAndComments();
      if (this.pos < this.src.length && this.src[this.pos] === ",") {
        this.pos++;
        continue;
      }
      if (this.pos < this.src.length && this.src[this.pos] === "]") {
        this.pos++;
        break;
      }
      this.fail("expected ',' or ']' in list literal");
    }

    return { kind: "list", items };
  }

  private parseNumberOrSignedIdent(): TextAst {
    let neg = false;
    if (this.src[this.pos] === "-") {
      neg = true;
      this.pos++;
      this.skipSpaceAndComments();
    }
    if (this.pos >= this.src.length) {
      this.fail("expected number after sign");
    }
    if (isIdentStart(this.src.charCodeAt(this.pos))) {
      const id = this.readIdentifier();
      if (id === "inf") return { kind: "float", value: -Infinity };
      this.fail(`unexpected signed identifier '-${id}'`);
    }

    const start = this.pos;
    if (
      this.src[this.pos] === "0" &&
      this.pos + 1 < this.src.length &&
      (this.src[this.pos + 1] === "x" || this.src[this.pos + 1] === "X")
    ) {
      this.pos += 2;
      const hexStart = this.pos;
      while (
        this.pos < this.src.length &&
        isHexDigit(this.src.charCodeAt(this.pos))
      ) {
        this.pos++;
      }
      if (this.pos === hexStart) this.fail("expected hex digits after 0x");
      const mag = BigInt(`0x${this.src.slice(hexStart, this.pos)}`);
      return {
        kind: "int",
        value: neg ? -mag : mag,
        negativeZero: neg && mag === 0n,
      };
    }

    let isFloat = false;
    while (
      this.pos < this.src.length &&
      this.src.charCodeAt(this.pos) >= 0x30 &&
      this.src.charCodeAt(this.pos) <= 0x39
    ) {
      this.pos++;
    }
    if (this.pos === start) {
      this.fail("invalid numeric literal");
    }
    if (this.pos < this.src.length && this.src[this.pos] === ".") {
      isFloat = true;
      this.pos++;
      while (
        this.pos < this.src.length &&
        this.src.charCodeAt(this.pos) >= 0x30 &&
        this.src.charCodeAt(this.pos) <= 0x39
      ) {
        this.pos++;
      }
    }
    if (
      this.pos < this.src.length &&
      (this.src[this.pos] === "e" || this.src[this.pos] === "E")
    ) {
      isFloat = true;
      this.pos++;
      if (
        this.pos < this.src.length &&
        (this.src[this.pos] === "+" || this.src[this.pos] === "-")
      ) {
        this.pos++;
      }
      const expStart = this.pos;
      while (
        this.pos < this.src.length &&
        this.src.charCodeAt(this.pos) >= 0x30 &&
        this.src.charCodeAt(this.pos) <= 0x39
      ) {
        this.pos++;
      }
      if (this.pos === expStart) this.fail("expected exponent digits");
    }

    const rawNum = this.src.slice(start, this.pos);
    if (rawNum.length === 0 || rawNum === ".") {
      this.fail("invalid numeric literal");
    }

    if (isFloat) {
      const f = Number(`${neg ? "-" : ""}${rawNum}`);
      if (Number.isNaN(f)) this.fail(`invalid float literal '${rawNum}'`);
      return { kind: "float", value: f };
    }

    // Leading 0 with all-octal digits in Cap'n Proto is octal (KJ p::integer).
    let mag: bigint;
    if (rawNum.length > 1 && rawNum[0] === "0") {
      if (!/^[0-7]+$/.test(rawNum)) {
        this.fail(`invalid octal literal '${rawNum}'`);
      }
      mag = BigInt(`0o${rawNum}`);
    } else {
      mag = BigInt(rawNum);
    }
    return {
      kind: "int",
      value: neg ? -mag : mag,
      negativeZero: neg && mag === 0n,
    };
  }

  private parseStringChain(isHexBlob: boolean): TextAst {
    const chunks: Uint8Array[] = [];
    for (;;) {
      this.skipSpaceAndComments();
      if (this.pos >= this.src.length) break;
      const ch = this.src[this.pos];
      if (ch === '"' || ch === "'") {
        chunks.push(this.readQuotedBytes(ch));
        continue;
      }
      if (ch === "`") {
        chunks.push(this.readBacktickLine());
        continue;
      }
      break;
    }
    return { kind: "bytes", bytes: concatChunks(chunks), isHexBlob };
  }

  private parseHexBlobChain(): TextAst {
    const chunks: Uint8Array[] = [];
    for (;;) {
      this.skipSpaceAndComments();
      if (
        this.pos + 2 < this.src.length &&
        this.src[this.pos] === "0" &&
        (this.src[this.pos + 1] === "x" || this.src[this.pos + 1] === "X") &&
        (this.src[this.pos + 2] === '"' || this.src[this.pos + 2] === "'")
      ) {
        const quote = this.src[this.pos + 2]!;
        this.pos += 3;
        const bytes: number[] = [];
        while (this.pos < this.src.length && this.src[this.pos] !== quote) {
          const c = this.src.charCodeAt(this.pos);
          if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
            this.pos++;
            continue;
          }
          if (
            !isHexDigit(c) ||
            this.pos + 1 >= this.src.length ||
            !isHexDigit(this.src.charCodeAt(this.pos + 1))
          ) {
            this.fail("hex binary literal requires pairs of hex digits");
          }
          const hi = hexVal(c);
          const lo = hexVal(this.src.charCodeAt(this.pos + 1));
          bytes.push((hi << 4) | lo);
          this.pos += 2;
        }
        if (this.pos >= this.src.length) {
          this.fail("unterminated hex binary literal");
        }
        this.pos++; // closing quote
        chunks.push(Uint8Array.from(bytes));
        continue;
      }
      break;
    }
    return { kind: "bytes", bytes: concatChunks(chunks), isHexBlob: true };
  }

  private readBacktickLine(): Uint8Array {
    this.pos++; // '`'
    const start = this.pos;
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === "\r" || ch === "\n") break;
      this.pos++;
    }
    const line = this.src.slice(start, this.pos);
    if (this.pos < this.src.length && this.src[this.pos] === "\r") this.pos++;
    if (this.pos < this.src.length && this.src[this.pos] === "\n") this.pos++;
    return UTF8_ENC.encode(`${line}\n`);
  }

  private readQuotedBytes(quote: string): Uint8Array {
    this.pos++; // opening quote
    const out: number[] = [];

    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]!;
      if (ch === quote) {
        this.pos++;
        return Uint8Array.from(out);
      }
      if (ch === "\n" || ch === "\r") {
        this.fail("unescaped newline in string literal");
      }
      if (ch !== "\\") {
        const cp = this.src.codePointAt(this.pos)!;
        const sub = String.fromCodePoint(cp);
        const encoded = UTF8_ENC.encode(sub);
        for (let i = 0; i < encoded.length; i++) out.push(encoded[i]!);
        this.pos += sub.length;
        continue;
      }

      // Escape sequence
      this.pos++;
      if (this.pos >= this.src.length) {
        this.fail("unterminated escape sequence");
      }
      const esc = this.src[this.pos]!;
      switch (esc) {
        case "a":
          out.push(0x07);
          this.pos++;
          break;
        case "b":
          out.push(0x08);
          this.pos++;
          break;
        case "f":
          out.push(0x0c);
          this.pos++;
          break;
        case "n":
          out.push(0x0a);
          this.pos++;
          break;
        case "r":
          out.push(0x0d);
          this.pos++;
          break;
        case "t":
          out.push(0x09);
          this.pos++;
          break;
        case "v":
          out.push(0x0b);
          this.pos++;
          break;
        case "'":
          out.push(0x27);
          this.pos++;
          break;
        case '"':
          out.push(0x22);
          this.pos++;
          break;
        case "\\":
          out.push(0x5c);
          this.pos++;
          break;
        case "?":
          out.push(0x3f);
          this.pos++;
          break;
        case "x": {
          this.pos++;
          if (
            this.pos + 1 >= this.src.length ||
            !isHexDigit(this.src.charCodeAt(this.pos)) ||
            !isHexDigit(this.src.charCodeAt(this.pos + 1))
          ) {
            this.fail("expected two hex digits after \\x");
          }
          const b =
            (hexVal(this.src.charCodeAt(this.pos)) << 4) |
            hexVal(this.src.charCodeAt(this.pos + 1));
          out.push(b);
          this.pos += 2;
          break;
        }
        default: {
          const code = esc.charCodeAt(0);
          if (code >= 0x30 && code <= 0x37) {
            let oct = code - 0x30;
            this.pos++;
            for (let k = 0; k < 2 && this.pos < this.src.length; k++) {
              const d = this.src.charCodeAt(this.pos);
              if (d < 0x30 || d > 0x37) break;
              oct = (oct << 3) | (d - 0x30);
              this.pos++;
            }
            if (oct > 0xff) this.fail("octal escape out of byte range");
            out.push(oct);
          } else {
            this.fail(`unknown string escape '\\${esc}'`);
          }
          break;
        }
      }
    }

    this.fail("unterminated string literal");
  }
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function fillStructFromAst(output: DynamicStructBuilder, ast: TextAst): void {
  assertCapnp(
    ast.kind === "tuple",
    "TEXT",
    `expected struct tuple '(...)' for ${output.getSchema().getShortDisplayName()}`,
  );
  const schema = output.getSchema();
  const seenFields = new Set<number>();
  let seenUnion = false;

  for (const entry of ast.entries) {
    assertCapnp(
      entry.name !== null,
      "TEXT",
      `expected 'field = value' assignment in ${schema.getShortDisplayName()}`,
    );
    const field = schema.findFieldByName(entry.name);
    assertCapnp(
      field !== null,
      "TEXT",
      `struct '${schema.getShortDisplayName()}' has no field '${entry.name}'`,
    );
    assertCapnp(
      !seenFields.has(field.index),
      "TEXT",
      `duplicate assignment to field '${field.name}'`,
    );
    seenFields.add(field.index);

    if (field.isUnionMember) {
      assertCapnp(
        !seenUnion,
        "TEXT",
        `multiple union members initialized in '${schema.getShortDisplayName()}'`,
      );
      seenUnion = true;
    }

    assignFieldFromAst(output, field, entry.value);
  }
}

function assignFieldFromAst(
  output: DynamicStructBuilder,
  field: StructField,
  ast: TextAst,
): void {
  const t = field.getType();
  if (field.isGroup()) {
    const grp = output.init(field).asStruct();
    fillStructFromAst(grp, ast);
    return;
  }

  if (t.isStruct()) {
    const sub = output.init(field).asStruct();
    fillStructFromAst(sub, ast);
    return;
  }

  if (t.isList()) {
    assertCapnp(ast.kind === "list", "TEXT", `expected '[...]' for list field '${field.name}'`);
    const lb = output.init(field, ast.items.length).asList();
    fillListFromAst(lb, ast.items);
    return;
  }

  output.set(field, evalScalarOrBlobAst(ast, t));
}

function fillListFromAst(
  lb: DynamicListBuilder,
  items: readonly TextAst[],
): void {
  const elemType = lb.getSchema().getElementType();
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (elemType.isStruct()) {
      fillStructFromAst(lb.get(i).asStruct(), item);
    } else if (elemType.isList()) {
      assertCapnp(item.kind === "list", "TEXT", "expected nested '[...]' list");
      const sub = lb.init(i, item.items.length).asList();
      fillListFromAst(sub, item.items);
    } else {
      lb.set(i, evalScalarOrBlobAst(item, elemType));
    }
  }
}

function evalScalarOrBlobAst(ast: TextAst, type: Type): DynamicValueReader {
  switch (type.whichCode) {
    case TypeKind.Void:
      assertCapnp(
        ast.kind === "ident" && ast.name === "void",
        "TEXT",
        "expected 'void'",
      );
      return DynamicValueReader.VOID;
    case TypeKind.Bool:
      assertCapnp(
        ast.kind === "ident" && (ast.name === "true" || ast.name === "false"),
        "TEXT",
        "expected 'true' or 'false'",
      );
      return DynamicValueReader.fromBool(ast.name === "true");
    case TypeKind.Int8:
    case TypeKind.Int16:
    case TypeKind.Int32:
    case TypeKind.Int64: {
      assertCapnp(ast.kind === "int", "TEXT", `expected integer for ${type.which}`);
      const r = DynamicValueReader.fromInt(ast.value);
      // Trigger width check immediately
      if (type.whichCode === TypeKind.Int8) r.asInt8();
      else if (type.whichCode === TypeKind.Int16) r.asInt16();
      else if (type.whichCode === TypeKind.Int32) r.asInt32();
      else r.asInt64();
      return r;
    }
    case TypeKind.UInt8:
    case TypeKind.UInt16:
    case TypeKind.UInt32:
    case TypeKind.UInt64: {
      assertCapnp(ast.kind === "int", "TEXT", `expected unsigned integer for ${type.which}`);
      const r = DynamicValueReader.fromUInt(ast.value);
      if (type.whichCode === TypeKind.UInt8) r.asUInt8();
      else if (type.whichCode === TypeKind.UInt16) r.asUInt16();
      else if (type.whichCode === TypeKind.UInt32) r.asUInt32();
      else r.asUInt64();
      return r;
    }
    case TypeKind.Float32:
    case TypeKind.Float64: {
      if (ast.kind === "float") {
        return DynamicValueReader.fromFloat(ast.value);
      }
      if (ast.kind === "int") {
        if (ast.negativeZero) return DynamicValueReader.fromFloat(-0);
        return DynamicValueReader.fromFloat(Number(ast.value));
      }
      if (ast.kind === "ident") {
        if (ast.name === "inf") return DynamicValueReader.fromFloat(Infinity);
        if (ast.name === "nan") return DynamicValueReader.fromFloat(NaN);
      }
      throw new CapnpError("TEXT", `expected float value for ${type.which}`);
    }
    case TypeKind.Text: {
      assertCapnp(
        ast.kind === "bytes" && !ast.isHexBlob,
        "TEXT",
        "expected quoted string literal for Text",
      );
      const dec = new TextDecoder("utf-8", { fatal: true });
      try {
        return DynamicValueReader.fromText(dec.decode(ast.bytes));
      } catch {
        throw new CapnpError("TEXT", "Text literal contains invalid UTF-8 bytes");
      }
    }
    case TypeKind.Data: {
      assertCapnp(
        ast.kind === "bytes",
        "TEXT",
        "expected string or 0x\"...\" literal for Data",
      );
      return DynamicValueReader.fromData(ast.bytes);
    }
    case TypeKind.Enum: {
      const enumSchema = type.asEnum();
      if (ast.kind === "ident") {
        return DynamicValueReader.fromEnum(
          DynamicEnum.fromEnumerant(enumSchema.getEnumerantByName(ast.name)),
        );
      }
      // Also support `(rawOrdinal)` emitted when printing unrecognized ordinals.
      if (
        ast.kind === "tuple" &&
        ast.entries.length === 1 &&
        ast.entries[0]!.name === null &&
        ast.entries[0]!.value.kind === "int"
      ) {
        const ord = Number(ast.entries[0]!.value.value);
        return DynamicValueReader.fromEnum(new DynamicEnum(enumSchema, ord));
      }
      throw new CapnpError(
        "TEXT",
        `expected enumerant identifier for ${enumSchema.getShortDisplayName()}`,
      );
    }
    default:
      throw new CapnpError(
        "UNSUPPORTED",
        `cannot decode text value into ${type.which}`,
      );
  }
}

/**
 * Cap'n Proto text codec matching `capnp::TextCodec` (`capnp/serialize-text.h`).
 */
export class TextCodec {
  private pretty: boolean;

  constructor(opts?: { prettyPrint?: boolean }) {
    this.pretty = opts?.prettyPrint ?? false;
  }

  setPrettyPrint(enabled: boolean): void {
    this.pretty = enabled;
  }

  encode(value: PrintableDynamic, type?: Type): string {
    const { reader, defaultTypeCode } = normalizePrintable(value);
    const code = type ? type.whichCode : defaultTypeCode;
    if (!this.pretty) {
      return printDynamicValue(reader, code, Indent.root(false), "bare");
    }
    if (
      reader.getType() === DynamicValueType.STRUCT ||
      reader.getType() === DynamicValueType.LIST
    ) {
      return printDynamicValue(reader, code, Indent.root(true), "bare");
    }
    return printDynamicValue(reader, code, Indent.root(false), "bare");
  }

  decodeStruct(input: string, output: DynamicStructBuilder): void {
    const ast = new TextParser(input).parseSingleExpression();
    fillStructFromAst(output, ast);
  }

  decode(
    input: string,
    schema: StructSchema,
    builder: MessageBuilder = new MessageBuilder(),
  ): DynamicStructReader {
    const root = initDynamicRoot(builder, schema);
    this.decodeStruct(input, root);
    return root.asReader();
  }

  decodeValue(
    input: string,
    type: Type,
    builder: MessageBuilder = new MessageBuilder(),
  ): DynamicValueReader {
    const ast = new TextParser(input).parseSingleExpression();
    if (type.isStruct()) {
      const root = initDynamicRoot(builder, type.asStruct());
      fillStructFromAst(root, ast);
      return DynamicValueReader.fromStruct(root.asReader());
    }
    if (type.isList()) {
      assertCapnp(ast.kind === "list", "TEXT", "expected '[...]' for list value");
      const slot = builder.rootSlot();
      const lb = DynamicListBuilder.allocateAtSlot(
        builder,
        slot,
        type.asList(),
        ast.items.length,
      );
      fillListFromAst(lb, ast.items);
      return DynamicValueReader.fromList(lb.asReader());
    }
    return evalScalarOrBlobAst(ast, type);
  }
}

/** Encode a DynamicStruct to Cap'n Proto text format (`pretty` defaults to true, like `capnp decode`). */
export function encodeText(
  value: DynamicStructReader | DynamicStructBuilder,
  opts?: { pretty?: boolean },
): string {
  const codec = new TextCodec({ prettyPrint: opts?.pretty ?? true });
  return codec.encode(value);
}

/** Decode a single Cap'n Proto text struct literal into a stream-framed `Message`. */
export function decodeText(input: string, schema: StructSchema): Message {
  const builder = new MessageBuilder();
  const root = initDynamicRoot(builder, schema);
  new TextCodec().decodeStruct(input, root);
  return Message.fromFlat(builder.toFlat());
}

/**
 * Split a multi-message text stream into individual parenthesized message slices,
 * matching `readOneText` in the `capnp` CLI.
 */
export function splitTextMessages(input: string): string[] {
  const messages: string[] = [];
  let state:
    | "normal"
    | "comment"
    | "quote"
    | "quoteEscape"
    | "dquote"
    | "dquoteEscape"
    | "backtick" = "normal";
  let depth = 0;
  let sawClose = false;
  let start = 0;

  const hasMeaningfulToken = (slice: string): boolean => {
    const p = new TextParser(slice);
    return !p.atEnd();
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    switch (state) {
      case "normal":
        if (c === "#") {
          state = "comment";
        } else if (c === "'") {
          state = "quote";
        } else if (c === '"') {
          state = "dquote";
        } else if (c === "`") {
          state = "backtick";
        } else if (c === "(") {
          if (depth === 0 && sawClose) {
            messages.push(input.slice(start, i));
            start = i;
            sawClose = false;
          }
          depth++;
        } else if (c === ")") {
          if (depth > 0) {
            depth--;
            if (depth === 0) {
              sawClose = true;
            }
          }
        }
        break;
      case "comment":
        if (c === "\n") state = "normal";
        break;
      case "quote":
        if (c === "'") state = "normal";
        else if (c === "\\") state = "quoteEscape";
        break;
      case "quoteEscape":
        state = "quote";
        break;
      case "dquote":
        if (c === '"') state = "normal";
        else if (c === "\\") state = "dquoteEscape";
        break;
      case "dquoteEscape":
        state = "dquote";
        break;
      case "backtick":
        if (c === "\n" || c === "\r") state = "normal";
        break;
    }
  }

  const tail = input.slice(start);
  if (hasMeaningfulToken(tail)) {
    messages.push(tail);
  }
  return messages;
}
