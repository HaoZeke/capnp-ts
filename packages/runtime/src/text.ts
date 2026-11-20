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
 * `Number.prototype.toExponential` rounds exact ties up, but glibc `printf`
 * rounds them to even. Detect a tie with exact integer arithmetic and round
 * it down when the kept digit is even.
 */
function toExponentialHalfEven(abs: number, fractionDigits: number): string {
  const rounded = abs.toExponential(fractionDigits);
  if (fractionDigits >= 100) return rounded;
  const longer = abs.toExponential(fractionDigits + 1);
  const eIdx = longer.indexOf("e");
  if (longer[eIdx - 1] !== "5") return rounded;

  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, abs);
  const hi = bits.getUint32(0);
  const lo = bits.getUint32(4);
  const biased = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (biased !== 0) mant |= 1n << 52n;
  const q = (biased === 0 ? 1 : biased) - 1075;

  const exp10 = Number.parseInt(longer.slice(eIdx + 1), 10);
  const digits = BigInt(longer.slice(0, eIdx).replace(".", ""));
  const s = exp10 - (fractionDigits + 1);
  const lhs = mant * 2n ** BigInt(Math.max(q, 0)) * 10n ** BigInt(Math.max(-s, 0));
  const rhs = digits * 10n ** BigInt(Math.max(s, 0)) * 2n ** BigInt(Math.max(-q, 0));
  if (lhs !== rhs) return rounded;

  const kept = digits / 10n;
  if (kept % 2n !== 0n) return rounded;
  const keptStr = kept.toString();
  const mantissa =
    fractionDigits === 0 ? keptStr : `${keptStr[0]}.${keptStr.slice(1)}`;
  return `${mantissa}e${exp10 < 0 ? "-" : "+"}${Math.abs(exp10)}`;
}

/**
 * Format a positive/negative finite number using C `snprintf("%.*g", prec, v)`
 * rules with KJ exponent normalization (`e+06` -> `e06`, `e-05` -> `e-05`).
 */
function formatCPrintfG(v: number, prec: number): string {
  const sign = v < 0 || Object.is(v, -0) ? "-" : "";
  const abs = Math.abs(v);
  if (abs === 0) return `${sign}0`;

  const expStr = toExponentialHalfEven(abs, prec - 1);
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

  // KJ retains eight significant digits for Float32 subnormals even when
  // fewer digits would round-trip in JavaScript.
  if (Math.abs(f) < 1.1754943508222875e-38) return formatCPrintfG(f, 8);

  // kj::FloatToBuffer tries FLT_DIG (6) digits, then FLT_DIG + 2 (8) only.
  const s = formatCPrintfG(f, 6);
  if (Math.fround(Number(s)) === f) return s;
  return formatCPrintfG(f, 8);
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

/** Escape UTF-8 Text matching `kj::encodeCEscape()` for a string. */
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
  /** `x.name` or `x(...)`, which capnp parses as a reference to a constant. */
  | { readonly kind: "external" }
  | { readonly kind: "int"; readonly value: bigint }
  | { readonly kind: "float"; readonly value: number }
  | { readonly kind: "bytes"; readonly bytes: Uint8Array; readonly isHexBlob: boolean }
  | { readonly kind: "list"; readonly items: readonly TextAst[] }
  | {
      readonly kind: "tuple";
      readonly entries: readonly TextAstEntry[];
    };

interface TextAstEntry {
  readonly name: string | null;
  readonly value: TextAst;
}

/** Byte offsets of an expression or field name in the message text. */
interface TextSpan {
  readonly start: number;
  readonly end: number;
}

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
  readonly src: string;
  /** Spans of parsed expressions, and of field names keyed by their entry. */
  readonly spans = new WeakMap<object, TextSpan>();
  private pos = 0;
  private skipFrom = -1;
  private skipTo = -1;

  constructor(src: string) {
    this.src = src;
  }

  private fail(msg: string): never {
    throw new CapnpError("TEXT", `${msg} at offset ${this.pos}`);
  }

  /** End of the last token: spans leave out the whitespace and comments after it. */
  private tokenEnd(): number {
    return this.pos === this.skipTo ? this.skipFrom : this.pos;
  }

  skipSpaceAndComments(): void {
    const from = this.pos;
    this.skipBlanks();
    if (this.pos !== from) {
      this.skipFrom = from;
      this.skipTo = this.pos;
    }
  }

  private skipBlanks(): void {
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
    const start = this.pos;
    let expr = this.parseExpressionHere();
    // `(x)` is x and keeps the span of x, as in capnp.
    if (!this.spans.has(expr)) this.spans.set(expr, { start, end: this.tokenEnd() });
    while (this.parseSuffix()) expr = { kind: "external" };
    return expr;
  }

  /** Consumes a `.name` or `(...)` suffix, if one follows. */
  private parseSuffix(): boolean {
    const [pos, skipFrom, skipTo] = [this.pos, this.skipFrom, this.skipTo];
    this.skipSpaceAndComments();
    const c = this.src.charCodeAt(this.pos);
    if (c === 0x28 /* '(' */) {
      this.parseTuple();
      return true;
    }
    // A '.' is its own operator only when no other operator character follows.
    if (c === 0x2e /* '.' */ && !"!$%&*+-./:<=>?@^|~".includes(this.src[this.pos + 1] ?? "")) {
      this.pos++;
      this.skipSpaceAndComments();
      if (isIdentStart(this.src.charCodeAt(this.pos))) {
        this.readIdentifier();
        return true;
      }
    }
    [this.pos, this.skipFrom, this.skipTo] = [pos, skipFrom, skipTo];
    return false;
  }

  private parseExpressionHere(): TextAst {
    const c = this.src.charCodeAt(this.pos);

    if (c === 0x28 /* '(' */) {
      return this.parseTuple();
    }
    if (c === 0x5b /* '[' */) {
      return this.parseList();
    }
    if (c === 0x22 /* '"' */ || c === 0x60 /* '`' */) {
      return this.parseStringChain(false);
    }
    if (
      c === 0x30 /* '0' */ &&
      this.pos + 2 < this.src.length &&
      this.src[this.pos + 1] === "x" &&
      this.src[this.pos + 2] === '"'
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
    const entries: TextAstEntry[] = [];
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

      // Check for `ident = expr` vs a positional `(expr)`.
      const savedPos = this.pos;
      let fieldName: string | null = null;
      let nameEnd = savedPos;
      if (
        this.pos < this.src.length &&
        isIdentStart(this.src.charCodeAt(this.pos))
      ) {
        const cand = this.readIdentifier();
        nameEnd = this.pos;
        this.skipSpaceAndComments();
        if (this.pos < this.src.length && this.src[this.pos] === "=") {
          this.pos++; // '='
          fieldName = cand;
        } else {
          this.pos = savedPos;
        }
      }

      const value = this.parseExpression();
      const entry = { name: fieldName, value };
      if (fieldName !== null) this.spans.set(entry, { start: savedPos, end: nameEnd });
      entries.push(entry);

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

    // As in the capnp parser, a tuple of one unnamed value is that value.
    if (entries.length === 1 && entries[0]!.name === null) return entries[0]!.value;
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
      const mag = BigInt.asUintN(64, BigInt(`0x${this.src.slice(hexStart, this.pos)}`));
      return this.number(start, { kind: "int", value: neg ? -mag : mag });
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
      return this.number(start, { kind: "float", value: f });
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
    // kj reads integer literals into a uint64_t, so larger ones wrap.
    mag = BigInt.asUintN(64, mag);
    return this.number(start, { kind: "int", value: neg ? -mag : mag });
  }

  /** A number's span starts at its digits: capnp leaves out a leading '-'. */
  private number(start: number, node: TextAst): TextAst {
    this.spans.set(node, { start, end: this.pos });
    return node;
  }

  private parseStringChain(isHexBlob: boolean): TextAst {
    const chunks: Uint8Array[] = [];
    for (;;) {
      this.skipSpaceAndComments();
      if (this.pos >= this.src.length) break;
      const ch = this.src[this.pos];
      if (ch === '"') {
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
    this.pos += 3; // `0x"`
    const bytes: number[] = [];
    while (this.pos < this.src.length && this.src[this.pos] !== '"') {
      while (
        this.pos < this.src.length &&
        this.src[this.pos] !== '"' &&
        /[ \t\n\r\v\f]/.test(this.src[this.pos]!)
      ) {
        this.pos++;
      }
      if (this.pos >= this.src.length || this.src[this.pos] === '"') break;
      const c = this.src.charCodeAt(this.pos);
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
    if (bytes.length === 0) {
      this.fail("hex binary literal requires at least one byte");
    }
    this.pos++; // closing quote
    return { kind: "bytes", bytes: Uint8Array.from(bytes), isHexBlob: true };
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
      if (ch === "\n") {
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
            out.push(oct & 0xff);
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

/** A value compiled from text, waiting to be written into a message. */
type TextValue =
  | { readonly kind: "void" }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "int"; readonly value: bigint }
  | { readonly kind: "float"; readonly value: number }
  | { readonly kind: "text"; readonly bytes: Uint8Array }
  | { readonly kind: "data"; readonly bytes: Uint8Array }
  | { readonly kind: "enum"; readonly value: DynamicEnum }
  | { readonly kind: "list"; readonly schema: ListSchema; readonly items: readonly (TextValue | null)[] }
  | { readonly kind: "struct"; readonly schema: StructSchema; readonly fields: readonly TextAssignment[] };

type TextAssignment =
  | { readonly field: StructField; readonly value: TextValue }
  | { readonly field: StructField; readonly group: readonly TextAssignment[] };

const INT_RANGE: Partial<Record<number, readonly [bigint, bigint]>> = {
  [TypeKind.Int8]: [-0x80n, 0x7fn],
  [TypeKind.Int16]: [-0x8000n, 0x7fffn],
  [TypeKind.Int32]: [-0x8000_0000n, 0x7fff_ffffn],
  [TypeKind.Int64]: [-0x8000_0000_0000_0000n, 0x7fff_ffff_ffff_ffffn],
  [TypeKind.UInt8]: [0n, 0xffn],
  [TypeKind.UInt16]: [0n, 0xffffn],
  [TypeKind.UInt32]: [0n, 0xffff_ffffn],
  [TypeKind.UInt64]: [0n, 0xffff_ffff_ffff_ffffn],
};

/** The type name `capnp` uses in "Type mismatch" errors. */
function textTypeName(type: Type): string {
  switch (type.whichCode) {
    case TypeKind.Void: return "Void";
    case TypeKind.Bool: return "Bool";
    case TypeKind.Int8: return "Int8";
    case TypeKind.Int16: return "Int16";
    case TypeKind.Int32: return "Int32";
    case TypeKind.Int64: return "Int64";
    case TypeKind.UInt8: return "UInt8";
    case TypeKind.UInt16: return "UInt16";
    case TypeKind.UInt32: return "UInt32";
    case TypeKind.UInt64: return "UInt64";
    case TypeKind.Float32: return "Float32";
    case TypeKind.Float64: return "Float64";
    case TypeKind.Text: return "Text";
    case TypeKind.Data: return "Data";
    case TypeKind.List: return `List(${textTypeName(type.asList().getElementType())})`;
    case TypeKind.Enum: return type.asEnum().getShortDisplayName();
    case TypeKind.Struct: return type.asStruct().getShortDisplayName();
    case TypeKind.Interface: return type.asInterface().getShortDisplayName();
    default: return "AnyPointer";
  }
}

/**
 * An error `capnp` reports on text input and then recovers from: the value
 * is left out and translation goes on. `description` starts with the
 * columns of the bad value, counted from the newline before it as kj
 * counts them, and `location` is what capnp prints as the code location.
 */
export interface TextInputError {
  readonly description: string;
  readonly location: string;
}

function locateTextError(src: string, span: TextSpan, message: string): TextInputError {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < span.start; i++) {
    if (src.charCodeAt(i) === 0x0a) {
      line++;
      lineStart = i;
    }
  }
  return {
    description: `${span.start - lineStart}-${span.end - lineStart}: ${message}`,
    location: `(capnp text input):${line}`,
  };
}

/**
 * Port of `capnp::compiler::ValueTranslator` for text input. Values are
 * compiled first, reporting errors in the order capnp reports them, then
 * written as capnp adopts them: a later assignment replaces an earlier one
 * and setting a union member does not clear the others.
 */
class TextTranslator {
  constructor(
    private readonly parser: TextParser,
    private readonly report: (error: TextInputError) => void,
  ) {}

  private error(node: object, message: string): void {
    const span = this.parser.spans.get(node) ?? { start: 0, end: 0 };
    this.report(locateTextError(this.parser.src, span, message));
  }

  compileStruct(schema: StructSchema, entries: readonly TextAstEntry[]): TextValue {
    return { kind: "struct", schema, fields: this.compileAssignments(schema, entries) };
  }

  private compileAssignments(
    schema: StructSchema,
    entries: readonly TextAstEntry[],
  ): TextAssignment[] {
    const out: TextAssignment[] = [];
    for (const entry of entries) {
      if (entry.name === null) {
        this.error(entry.value, "Missing field name.");
        continue;
      }
      const field = schema.findFieldByName(entry.name);
      if (field === null) {
        this.error(entry, `Struct has no field named '${entry.name}'.`);
        continue;
      }
      if (!field.isGroup()) {
        const value = this.compileValue(entry.value, field.getType());
        if (value !== null) out.push({ field, value });
        continue;
      }
      // capnp initializes the group before it looks at the value.
      const groupSchema = field.getType().asStruct();
      if (entry.value.kind === "tuple") {
        out.push({ field, group: this.compileAssignments(groupSchema, entry.value.entries) });
        continue;
      }
      const value = this.compileValueInner(entry.value, field.getType());
      const first = groupSchema.getFields()[0];
      if (value === null) {
        out.push({ field, group: [] });
        continue;
      }
      const matched = first === undefined ? null : this.matchType(entry.value, first.getType(), value);
      if (matched !== null) {
        out.push({ field, group: [{ field: first!, value: matched }] });
        continue;
      }
      this.error(entry.value, "Type mismatch; expected group.");
      out.push({ field, group: [] });
    }
    return out;
  }

  compileValue(ast: TextAst, type: Type): TextValue | null {
    if (type.isAnyPointer() && (type.getBrandParameter() !== null || type.getImplicitParameter() !== null)) {
      this.error(
        ast,
        "Cannot interpret value because the type is a generic type parameter which is not " +
          "yet bound. We don't know what type to expect here.",
      );
      return null;
    }
    const value = this.compileValueInner(ast, type);
    if (value === null) return null;
    const matched = this.matchType(ast, type, value);
    if (matched !== null) return matched;
    if (type.isStruct()) {
      // capnp tries the value as the struct's first field.
      const schema = type.asStruct();
      const first = schema.getFields()[0];
      if (first !== undefined) {
        const inner = this.matchType(ast, first.getType(), value);
        if (inner !== null) return { kind: "struct", schema, fields: [{ field: first, value: inner }] };
      }
    }
    this.error(ast, `Type mismatch; expected ${textTypeName(type)}.`);
    return null;
  }

  /** `matchesType`: the value if it fits `type`, clamping an out-of-range integer. */
  private matchType(ast: TextAst, type: Type, value: TextValue): TextValue | null {
    switch (value.kind) {
      case "void":
        return type.isVoid() ? value : null;
      case "bool":
        return type.whichCode === TypeKind.Bool ? value : null;
      case "int": {
        if (type.isFloat32() || type.isFloat64()) return value;
        const range = INT_RANGE[type.whichCode];
        if (range === undefined) return null;
        const [min, max] = range;
        if (value.value < min || value.value > max) {
          this.error(ast, "Integer value out of range.");
          return { ...value, value: value.value < min ? min : max };
        }
        return value;
      }
      case "float":
        return type.isFloat32() || type.isFloat64() ? value : null;
      case "text":
        return type.isText() ? value : null;
      case "data":
        return type.isData() ? value : null;
      case "list":
        return type.isList() && type.asList() === value.schema ? value : null;
      case "enum":
        return type.isEnum() && type.asEnum() === value.value.getSchema() ? value : null;
      case "struct":
        return type.isStruct() && type.asStruct() === value.schema ? value : null;
    }
  }

  private compileValueInner(ast: TextAst, type: Type): TextValue | null {
    switch (ast.kind) {
      case "ident": {
        if (type.isEnum()) {
          const enumerant = type.asEnum().findEnumerantByName(ast.name);
          if (enumerant !== null) {
            return { kind: "enum", value: DynamicEnum.fromEnumerant(enumerant) };
          }
        } else if (ast.name === "void") {
          return { kind: "void" };
        } else if (ast.name === "true" || ast.name === "false") {
          return { kind: "bool", value: ast.name === "true" };
        } else if (ast.name === "nan") {
          return { kind: "float", value: Number.NaN };
        } else if (ast.name === "inf") {
          return { kind: "float", value: Number.POSITIVE_INFINITY };
        }
        // capnp resolves any other name as a constant, which text input forbids.
        throw new CapnpError("TEXT", "External constants not allowed.");
      }
      case "external":
        throw new CapnpError("TEXT", "External constants not allowed.");
      case "int":
        if (ast.value < -0x8000_0000_0000_0000n) {
          this.error(ast, "Integer is too big to be negative.");
          return null;
        }
        return { kind: "int", value: ast.value };
      case "float":
        return { kind: "float", value: ast.value };
      case "bytes":
        if (ast.isHexBlob) {
          if (!type.isData()) {
            this.error(ast, `Type mismatch; expected ${textTypeName(type)}.`);
            return null;
          }
          return { kind: "data", bytes: ast.bytes };
        }
        return type.isData() ? { kind: "data", bytes: ast.bytes } : { kind: "text", bytes: ast.bytes };
      case "list": {
        if (!type.isList()) {
          this.error(ast, `Type mismatch; expected ${textTypeName(type)}.`);
          return null;
        }
        const schema = type.asList();
        const elementType = schema.getElementType();
        return { kind: "list", schema, items: ast.items.map((item) => this.compileValue(item, elementType)) };
      }
      case "tuple":
        if (!type.isStruct()) {
          this.error(ast, `Type mismatch; expected ${textTypeName(type)}.`);
          return null;
        }
        return this.compileStruct(type.asStruct(), ast.entries);
    }
  }
}

function scalarTextValue(value: TextValue, type: Type): DynamicValueReader {
  switch (value.kind) {
    case "void":
      return DynamicValueReader.VOID;
    case "bool":
      return DynamicValueReader.fromBool(value.value);
    case "int":
      if (type.isFloat32() || type.isFloat64()) {
        return DynamicValueReader.fromFloat(Number(value.value));
      }
      return value.value < 0n
        ? DynamicValueReader.fromInt(value.value)
        : DynamicValueReader.fromUInt(value.value);
    case "float":
      return DynamicValueReader.fromFloat(value.value);
    case "text":
      return DynamicValueReader.fromTextBytes(value.bytes);
    case "data":
      return DynamicValueReader.fromData(value.bytes);
    case "enum":
      return DynamicValueReader.fromEnum(value.value);
    default:
      throw new CapnpError("TEXT", `cannot write a ${value.kind} as a scalar`);
  }
}

function writeTextStruct(output: DynamicStructBuilder, fields: readonly TextAssignment[]): void {
  for (const assignment of fields) {
    const { field } = assignment;
    if ("group" in assignment) {
      writeTextStruct(output.init(field).asStruct(), assignment.group);
      continue;
    }
    const { value } = assignment;
    if (value.kind === "struct") {
      writeTextStruct(output.init(field).asStruct(), value.fields);
    } else if (value.kind === "list") {
      writeTextList(output.init(field, value.items.length).asList(), value.items);
    } else {
      output.set(field, scalarTextValue(value, field.getType()));
    }
  }
}

function writeTextList(output: DynamicListBuilder, items: readonly (TextValue | null)[]): void {
  const elementType = output.getSchema().getElementType();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === null || item === undefined) continue;
    if (item.kind === "struct") {
      writeTextStruct(output.get(i).asStruct(), item.fields);
    } else if (item.kind === "list") {
      writeTextList(output.init(i, item.items.length).asList(), item.items);
    } else {
      output.set(i, scalarTextValue(item, elementType));
    }
  }
}

function throwTextInputError(error: TextInputError): never {
  throw new CapnpError("TEXT", error.description);
}

/**
 * Translate a parsed message into `output`. Errors capnp recovers from go
 * to `report`; without one the first of them is thrown, as `capnp::TextCodec`
 * throws when nothing catches recoverable exceptions.
 */
function fillStructFromText(
  parser: TextParser,
  output: DynamicStructBuilder,
  ast: TextAst,
  report: (error: TextInputError) => void = throwTextInputError,
): void {
  if (ast.kind !== "tuple") {
    report({
      description: "expected expression.isTuple(); Input does not contain a struct.",
      location: "capnp/serialize-text.c++:134",
    });
    return;
  }
  const translator = new TextTranslator(parser, report);
  const value = translator.compileStruct(output.getSchema(), ast.entries);
  if (value.kind === "struct") writeTextStruct(output, value.fields);
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

  /**
   * Errors capnp recovers from go to `report`, and the rest of the message
   * is still translated; without `report` the first one is thrown.
   */
  decodeStruct(
    input: string,
    output: DynamicStructBuilder,
    report?: (error: TextInputError) => void,
  ): void {
    const parser = new TextParser(input);
    fillStructFromText(parser, output, parser.parseSingleExpression(), report);
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
    const parser = new TextParser(input);
    const ast = parser.parseSingleExpression();
    const value = new TextTranslator(parser, throwTextInputError).compileValue(ast, type)!;
    if (value.kind === "struct") {
      const root = initDynamicRoot(builder, value.schema);
      writeTextStruct(root, value.fields);
      return DynamicValueReader.fromStruct(root.asReader());
    }
    if (value.kind === "list") {
      const lb = DynamicListBuilder.allocateAtSlot(
        builder,
        builder.rootSlot(),
        value.schema,
        value.items.length,
      );
      writeTextList(lb, value.items);
      return DynamicValueReader.fromList(lb.asReader());
    }
    return scalarTextValue(value, type);
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
 * matching `readOneText` in the `capnp` CLI. Text before the first message and
 * after the last stays in the first and last slice, and input with no message
 * at all is one slice, so whitespace or comments alone fail to parse as in C++.
 */
export function splitTextMessages(input: string): string[] {
  const messages: string[] = [];
  let state:
    | "normal"
    | "comment"
    = "normal";
  let depth = 0;
  let sawClose = false;
  let start = 0;

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    switch (state) {
      case "normal":
        if (c === "#") {
          state = "comment";
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
    }
  }

  if (start < input.length) messages.push(input.slice(start));
  return messages;
}
