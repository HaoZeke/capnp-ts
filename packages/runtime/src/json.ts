/**
 * Cap'n Proto JSON codec (models capnp/compat/json.h and json.capnp).
 *
 * Matches C++ JsonCodec defaults (primitive fields emitted under NON_NULL,
 * null pointers omitted, Int64/UInt64 as strings, NaN/Infinity/-Infinity as
 * strings, Data as byte arrays, enums as names, unknown JSON fields ignored
 * unless rejectUnknownFields is enabled) and supports $Json annotations via
 * handleByAnnotation().
 */

import { BuilderPointer, MessageBuilder } from "./builder.ts";
import {
  DynamicEnum,
  DynamicListBuilder,
  DynamicStructBuilder,
  DynamicStructReader,
  DynamicValueBuilder,
  DynamicValueReader,
  DynamicValueType,
  HasMode,
  initDynamicRoot,
} from "./dynamic.ts";
import { CapnpError, DEFAULT_DEPTH_LIMIT, PtrKind, assertCapnp } from "./kinds.ts";
import { Message, Ptr } from "./message.ts";
import {
  EnumSchema,
  ListSchema,
  Schema,
  StructField,
  StructSchema,
  Type,
  TypeKind,
} from "./schema.ts";
import { formatKjFloat64, type PrintableDynamic } from "./text.ts";
import { rawStringByteLength, rawStringToBytes, rawTextToString } from "./utf8.ts";

export const JSON_NAME_ANNOTATION_ID = 0xfa5b1fd61c2e7c3dn;
export const JSON_FLATTEN_ANNOTATION_ID = 0x82d3e852af0336bfn;
export const JSON_DISCRIMINATOR_ANNOTATION_ID = 0xcfa794e8d19a0162n;
export const JSON_BASE64_ANNOTATION_ID = 0xd7d879450a253e4bn;
export const JSON_HEX_ANNOTATION_ID = 0xf061e22f0ae5c7b5n;

const TEXT_DEC = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
const UTF8_ENC = new TextEncoder();

function bytesToByteString(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return out;
}

export type JsonAst =
  | { readonly which: "null" }
  | { readonly which: "boolean"; readonly value: boolean }
  | { readonly which: "number"; readonly value: number }
  | {
      readonly which: "string";
      readonly value: string;
      /** Bytes C++ would store for this string when it was parsed from JSON. */
      readonly bytes?: Uint8Array;
    }
  | { readonly which: "array"; readonly value: readonly JsonAst[] }
  | {
      readonly which: "object";
      readonly value: readonly { readonly name: string; readonly value: JsonAst }[];
    }
  | {
      readonly which: "call";
      readonly fn: string;
      readonly params: readonly JsonAst[];
    }
  | { readonly which: "raw"; readonly value: string };

export interface JsonCustomHandler {
  encode(codec: JsonCodec, input: DynamicValueReader, type: Type): JsonAst;
  decode?(
    codec: JsonCodec,
    input: JsonAst,
    type: Type,
    builder: MessageBuilder,
  ): DynamicValueReader;
  decodeStruct?(
    codec: JsonCodec,
    input: JsonAst,
    output: DynamicStructBuilder,
  ): void;
}

export interface JsonCodecOptions {
  prettyPrint?: boolean;
  hasMode?: HasMode;
  maxNestingDepth?: number;
  rejectUnknownFields?: boolean;
}

const HEX_CHARS = "0123456789abcdef";

/**
 * Quote `str` like C++ `JsonCodec::encodeString`. A lone surrogate becomes
 * U+FFFD, except byte sentinels when `keepByteSentinels` is set.
 */
function encodeJsonString(str: string, keepByteSentinels = false): string {
  let out = '"';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    switch (c) {
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      case 0x08:
        out += "\\b";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0d:
        out += "\\r";
        break;
      case 0x09:
        out += "\\t";
        break;
      default:
        if (c < 0x20) {
          out += `\\u00${HEX_CHARS[c >>> 4]}${HEX_CHARS[c & 0x0f]}`;
        } else if (c >= 0xd800 && c <= 0xdfff) {
          if (str.codePointAt(i)! > 0xffff) {
            out += str.slice(i, i + 2);
            i++;
          } else if (keepByteSentinels && c >= 0xdc00 && c <= 0xdcff) {
            out += str[i];
          } else {
            out += "\ufffd";
          }
        } else {
          out += str[i];
        }
    }
  }
  out += '"';
  return out;
}

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i + 2 < bytes.length) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      B64_ALPHABET[(n >>> 18) & 63]! +
      B64_ALPHABET[(n >>> 12) & 63]! +
      B64_ALPHABET[(n >>> 6) & 63]! +
      B64_ALPHABET[n & 63]!;
    i += 3;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += `${B64_ALPHABET[(n >>> 18) & 63]}${B64_ALPHABET[(n >>> 12) & 63]}==`;
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += `${B64_ALPHABET[(n >>> 18) & 63]}${B64_ALPHABET[(n >>> 12) & 63]}${B64_ALPHABET[(n >>> 6) & 63]}=`;
  }
  return out;
}

export function decodeBase64(input: string): Uint8Array {
  const clean = input.replace(/[\s\r\n\t]+/g, "");
  assertCapnp(clean.length % 4 === 0, "JSON", "invalid base64 length");
  if (clean.length === 0) return new Uint8Array(0);

  const sextet = (ch: string): number => {
    const c = ch.charCodeAt(0);
    if (c >= 0x41 && c <= 0x5a) return c - 0x41;
    if (c >= 0x61 && c <= 0x7a) return c - 0x61 + 26;
    if (c >= 0x30 && c <= 0x39) return c - 0x30 + 52;
    if (c === 0x2b || c === 0x2d) return 62;
    if (c === 0x2f || c === 0x5f) return 63;
    throw new CapnpError("JSON", `invalid base64 character '${ch}'`);
  };

  let pad = 0;
  if (clean.endsWith("==")) pad = 2;
  else if (clean.endsWith("=")) pad = 1;

  const outLen = (clean.length / 4) * 3 - pad;
  const out = new Uint8Array(outLen);
  let op = 0;

  for (let i = 0; i < clean.length; i += 4) {
    const s0 = sextet(clean[i]!);
    const s1 = sextet(clean[i + 1]!);
    const s2 = clean[i + 2] === "=" ? 0 : sextet(clean[i + 2]!);
    const s3 = clean[i + 3] === "=" ? 0 : sextet(clean[i + 3]!);
    const triple = (s0 << 18) | (s1 << 12) | (s2 << 6) | s3;
    if (op < outLen) out[op++] = (triple >>> 16) & 0xff;
    if (op < outLen) out[op++] = (triple >>> 8) & 0xff;
    if (op < outLen) out[op++] = triple & 0xff;
  }
  return out;
}

export function encodeHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX_CHARS[b >>> 4]! + HEX_CHARS[b & 0x0f]!;
  }
  return out;
}

export function decodeHex(input: string): Uint8Array {
  assertCapnp(input.length % 2 === 0, "JSON", "hex string must have even length");
  const out = new Uint8Array(input.length / 2);
  const hv = (c: number): number => {
    if (c >= 0x30 && c <= 0x39) return c - 0x30;
    if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
    if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
    throw new CapnpError("JSON", "invalid hex digit");
  };
  for (let i = 0; i < out.length; i++) {
    out[i] =
      (hv(input.charCodeAt(i * 2)) << 4) | hv(input.charCodeAt(i * 2 + 1));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Strict JSON parser with depth cap (models Parser in json.c++)
// ---------------------------------------------------------------------------

const JSON_SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** UTF-8 bytes of one UTF-16 code unit, as C++ stores a `\uXXXX` escape. */
function utf8CodeUnit(u: number): number[] {
  if (u < 0x80) return [u];
  if (u < 0x800) return [0xc0 | (u >> 6), 0x80 | (u & 0x3f)];
  return [0xe0 | (u >> 12), 0x80 | ((u >> 6) & 0x3f), 0x80 | (u & 0x3f)];
}

class RawJsonParser {
  private readonly src: string;
  private readonly maxDepth: number;
  private pos = 0;
  private depth = 0;

  constructor(src: string, maxDepth: number) {
    this.src = src;
    this.maxDepth = maxDepth;
  }

  private fail(msg: string): never {
    throw new CapnpError("JSON", `${msg} at offset ${this.pos}`);
  }

  private skipWs(): void {
    while (this.pos < this.src.length) {
      const c = this.src.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) {
        this.pos++;
      } else {
        break;
      }
    }
  }

  parseRoot(): JsonAst {
    const v = this.parseValue();
    this.skipWs();
    if (this.pos < this.src.length && this.src.charCodeAt(this.pos) !== 0) {
      this.fail("unexpected trailing input after JSON value");
    }
    return v;
  }

  private parseValue(): JsonAst {
    this.skipWs();
    if (this.pos >= this.src.length) {
      this.fail("JSON message ends prematurely");
    }
    const ch = this.src[this.pos]!;
    switch (ch) {
      case "n":
        this.expectLiteral("null");
        return { which: "null" };
      case "f":
        this.expectLiteral("false");
        return { which: "boolean", value: false };
      case "t":
        this.expectLiteral("true");
        return { which: "boolean", value: true };
      case '"':
        return { which: "string", ...this.parseString() };
      case "[":
        return this.parseArray();
      case "{":
        return this.parseObject();
      default:
        if (ch === "-" || (ch >= "0" && ch <= "9")) {
          return { which: "number", value: this.parseNumber() };
        }
        this.fail(`unexpected character '${ch}' in JSON`);
    }
  }

  private expectLiteral(lit: string): void {
    if (!this.src.startsWith(lit, this.pos)) {
      this.fail(`expected '${lit}'`);
    }
    this.pos += lit.length;
  }

  private parseArray(): JsonAst {
    this.pos++; // '['
    if (++this.depth > this.maxDepth) {
      throw new CapnpError("DEPTH", "JSON message nested too deeply");
    }
    try {
      const items: JsonAst[] = [];
      this.skipWs();
      if (this.pos < this.src.length && this.src[this.pos] === "]") {
        this.pos++;
        return { which: "array", value: items };
      }
      for (;;) {
        items.push(this.parseValue());
        this.skipWs();
        if (this.pos >= this.src.length) this.fail("unterminated JSON array");
        if (this.src[this.pos] === "]") {
          this.pos++;
          return { which: "array", value: items };
        }
        if (this.src[this.pos] !== ",") {
          this.fail("expected ',' or ']' in JSON array");
        }
        this.pos++;
      }
    } finally {
      this.depth--;
    }
  }

  private parseObject(): JsonAst {
    this.pos++; // '{'
    if (++this.depth > this.maxDepth) {
      throw new CapnpError("DEPTH", "JSON message nested too deeply");
    }
    try {
      const fields: Array<{ name: string; value: JsonAst }> = [];
      this.skipWs();
      if (this.pos < this.src.length && this.src[this.pos] === "}") {
        this.pos++;
        return { which: "object", value: fields };
      }
      for (;;) {
        this.skipWs();
        if (this.pos >= this.src.length || this.src[this.pos] !== '"') {
          this.fail("expected quoted property name in JSON object");
        }
        const name = this.parseQuotedString();
        this.skipWs();
        if (this.pos >= this.src.length || this.src[this.pos] !== ":") {
          this.fail("expected ':' after property name in JSON object");
        }
        this.pos++;
        const value = this.parseValue();
        fields.push({ name, value });
        this.skipWs();
        if (this.pos >= this.src.length) this.fail("unterminated JSON object");
        if (this.src[this.pos] === "}") {
          this.pos++;
          return { which: "object", value: fields };
        }
        if (this.src[this.pos] !== ",") {
          this.fail("expected ',' or '}' in JSON object");
        }
        this.pos++;
      }
    } finally {
      this.depth--;
    }
  }

  private parseQuotedString(): string {
    return this.parseString().value;
  }

  /**
   * `src` holds one UTF-8 byte per code unit. Like C++ `JsonCodec`, raw bytes
   * are copied unchanged, raw control characters are allowed, and each
   * `\uXXXX` escape is UTF-8 encoded on its own, so a surrogate pair becomes
   * two three-byte sequences. `value` decodes the same input as JavaScript
   * does, joining surrogate pairs.
   */
  private parseString(): { value: string; bytes: Uint8Array } {
    this.pos++; // '"'
    const bytes: number[] = [];
    let value = "";
    let rawStart = 0;
    const flushRaw = () => {
      if (rawStart < bytes.length) {
        value += TEXT_DEC.decode(Uint8Array.from(bytes.slice(rawStart)));
      }
    };
    const pushEscape = (text: string, encoded: readonly number[]) => {
      flushRaw();
      value += text;
      bytes.push(...encoded);
      rawStart = bytes.length;
    };
    while (this.pos < this.src.length) {
      const code = this.src.charCodeAt(this.pos);
      if (code === 0x22) {
        this.pos++;
        flushRaw();
        return { value, bytes: Uint8Array.from(bytes) };
      }
      if (code === 0) break;
      if (code !== 0x5c) {
        bytes.push(code);
        this.pos++;
        continue;
      }
      this.pos++;
      if (this.pos >= this.src.length) this.fail("unterminated JSON string escape");
      const esc = this.src[this.pos]!;
      const simple = JSON_SIMPLE_ESCAPES[esc];
      if (simple !== undefined) {
        pushEscape(simple, [simple.charCodeAt(0)]);
        this.pos++;
        continue;
      }
      if (esc !== "u") this.fail(`invalid escape '\\${esc}' in JSON string`);
      this.pos++;
      const u1 = this.readHex4();
      if (
        u1 >= 0xd800 &&
        u1 <= 0xdbff &&
        this.pos + 5 < this.src.length &&
        this.src[this.pos] === "\\" &&
        this.src[this.pos + 1] === "u"
      ) {
        const saved = this.pos;
        this.pos += 2;
        const u2 = this.readHex4();
        if (u2 >= 0xdc00 && u2 <= 0xdfff) {
          pushEscape(String.fromCharCode(u1, u2), [...utf8CodeUnit(u1), ...utf8CodeUnit(u2)]);
          continue;
        }
        this.pos = saved;
      }
      pushEscape(String.fromCharCode(u1), utf8CodeUnit(u1));
    }
    this.fail("unterminated JSON string");
  }

  private readHex4(): number {
    if (this.pos + 4 > this.src.length) {
      this.fail("truncated \\uXXXX escape");
    }
    let val = 0;
    for (let i = 0; i < 4; i++) {
      const c = this.src.charCodeAt(this.pos++);
      val <<= 4;
      if (c >= 0x30 && c <= 0x39) val |= c - 0x30;
      else if (c >= 0x41 && c <= 0x46) val |= c - 0x41 + 10;
      else if (c >= 0x61 && c <= 0x66) val |= c - 0x61 + 10;
      else this.fail("invalid hex digit in \\uXXXX escape");
    }
    return val;
  }

  private parseNumber(): number {
    const start = this.pos;
    if (this.src[this.pos] === "-") this.pos++;
    if (this.pos >= this.src.length) this.fail("expected digit after '-'");
    if (this.src[this.pos] === "0") {
      this.pos++;
    } else if (this.src[this.pos]! >= "1" && this.src[this.pos]! <= "9") {
      this.pos++;
      while (
        this.pos < this.src.length &&
        this.src[this.pos]! >= "0" &&
        this.src[this.pos]! <= "9"
      ) {
        this.pos++;
      }
    } else {
      this.fail("invalid JSON number");
    }

    if (this.pos < this.src.length && this.src[this.pos] === ".") {
      this.pos++;
      const fracStart = this.pos;
      while (
        this.pos < this.src.length &&
        this.src[this.pos]! >= "0" &&
        this.src[this.pos]! <= "9"
      ) {
        this.pos++;
      }
      if (this.pos === fracStart) this.fail("expected fraction digits after '.'");
    }

    if (
      this.pos < this.src.length &&
      (this.src[this.pos] === "e" || this.src[this.pos] === "E")
    ) {
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
        this.src[this.pos]! >= "0" &&
        this.src[this.pos]! <= "9"
      ) {
        this.pos++;
      }
      if (this.pos === expStart) this.fail("expected exponent digits");
    }

    const raw = this.src.slice(start, this.pos);
    return Number(raw);
  }
}

function parseStrictBigIntString(raw: string, signed: boolean): bigint {
  const s = raw.trim();
  assertCapnp(s.length > 0 && s === raw, "JSON", `invalid integer string '${raw}'`);
  let neg = false;
  let body = s;
  if (body.startsWith("-") || body.startsWith("+")) {
    neg = body[0] === "-";
    body = body.slice(1);
  }
  if (!signed && neg) {
    throw new CapnpError("JSON", `negative value '${raw}' for unsigned integer`);
  }
  assertCapnp(body.length > 0, "JSON", `invalid integer string '${raw}'`);
  let mag: bigint;
  if (body.startsWith("0x") || body.startsWith("0X")) {
    assertCapnp(
      /^0[xX][0-9a-fA-F]+$/.test(body),
      "JSON",
      `invalid hex integer '${raw}'`,
    );
    mag = BigInt(body);
  } else {
    assertCapnp(
      /^[0-9]+$/.test(body),
      "JSON",
      `invalid decimal integer '${raw}'`,
    );
    mag = BigInt(body);
  }
  return neg ? -mag : mag;
}

const FLOAT64_BUF = new ArrayBuffer(8);
const FLOAT64_VIEW = new DataView(FLOAT64_BUF);

function float64FromBits(bits: bigint): number {
  FLOAT64_VIEW.setBigUint64(0, bits, true);
  return FLOAT64_VIEW.getFloat64(0, true);
}

/**
 * IEEE-754 binary64 conversion for a C99 hex float literal, bit-exact with
 * glibc `strtod()`, which C++ uses to parse JSON floats. There are no loops
 * over the exponent and no intermediate `Number` rounding.
 *
 * Normal results round to nearest, ties to even. For subnormal results
 * glibc first truncates to a 53-bit significand, then shifts it right and
 * rounds again. That second step takes its half bit from the 53-bit value
 * and folds only the bits below the first discarded one into the sticky
 * bit, so the first discarded bit itself is lost. This is not correctly
 * rounded: 0x20000000000003p-1076 is 3/4 ULP above 0x0008000000000000 but
 * parses to it.
 */
function parseHexFloat64(
  negative: boolean,
  intHex: string,
  fracHex: string,
  expStr: string | undefined,
): number {
  const intTrim = intHex.replace(/^0+/, "");
  const fracTrim = fracHex.replace(/0+$/, "");
  let sig: string;
  if (intTrim.length > 0) {
    sig = intTrim + fracTrim;
  } else {
    const fracLead = fracTrim.match(/^0+/)?.[0].length ?? 0;
    sig = fracTrim.slice(fracLead);
    if (sig.length === 0) return negative ? -0 : 0;
  }
  let binExp = -4n * BigInt(fracTrim.length);

  if (expStr !== undefined) {
    const expNeg = expStr.startsWith("-");
    const expDigits = expStr.replace(/^[+-]?0*/, "");
    if (expDigits.length > 15) {
      binExp += expNeg ? -1000000000000000n : 1000000000000000n;
    } else if (expDigits.length > 0) {
      const mag = BigInt(expDigits);
      binExp += expNeg ? -mag : mag;
    }
  }

  const leadingBits = Number.parseInt(sig[0]!, 16).toString(2).length;
  const significantBits = leadingBits + 4 * (sig.length - 1);
  let exponent = binExp + BigInt(significantBits - 1);
  const signBit = negative ? 1n << 63n : 0n;
  const infinity = negative ? -Infinity : Infinity;

  if (exponent > 1023n) return infinity;
  if (exponent < -1075n) return negative ? -0 : 0;

  // m53 holds the leading 53 bits; half is the next bit; sticky is any later one.
  let m53: bigint;
  let half = false;
  let sticky = false;
  if (significantBits <= 53) {
    m53 = BigInt(`0x${sig}`) << BigInt(53 - significantBits);
  } else {
    const prefix = BigInt(`0x${sig.slice(0, 16)}`);
    const below = BigInt(leadingBits + 4 * (Math.min(sig.length, 16) - 1) - 54);
    m53 = prefix >> (below + 1n);
    half = ((prefix >> below) & 1n) === 1n;
    sticky = (prefix & ((1n << below) - 1n)) !== 0n || /[1-9a-fA-F]/.test(sig.slice(16));
  }

  if (exponent >= -1022n) {
    if (half && (sticky || (m53 & 1n) === 1n)) {
      m53 += 1n;
      if (m53 === 1n << 53n) {
        m53 >>= 1n;
        exponent += 1n;
        if (exponent > 1023n) return infinity;
      }
    }
    return float64FromBits(signBit | ((exponent + 1023n) << 52n) | (m53 & ((1n << 52n) - 1n)));
  }

  const shift = -1022n - exponent;
  const q = m53 >> shift;
  const subHalf = ((m53 >> (shift - 1n)) & 1n) === 1n;
  const subSticky = (m53 & ((1n << (shift - 1n)) - 1n)) !== 0n || sticky;
  const rounded = subHalf && (subSticky || (q & 1n) === 1n) ? q + 1n : q;
  return float64FromBits(signBit | rounded);
}

/**
 * Parse a C `nan(tag)` payload like glibc `strtod()` (`strtoull(tag, &endp, 0)`):
 * accept decimal, `0x`/`0X` hex, or `0`-prefixed octal consuming the whole tag,
 * saturate at `UINT64_MAX`, and mask to the 51 quiet-NaN payload bits.
 */
function parseNanPayloadBits(tag: string): bigint {
  if (tag.length === 0) return 0n;
  let val: bigint;
  if (/^0[xX][0-9a-fA-F]+$/.test(tag)) {
    val = BigInt(tag);
  } else if (/^0[0-7]*$/.test(tag)) {
    val = BigInt(`0o${tag}`);
  } else if (/^[1-9][0-9]*$/.test(tag)) {
    val = BigInt(tag);
  } else {
    return 0n;
  }
  const u64Max = 0xffffffffffffffffn;
  return (val > u64Max ? u64Max : val) & 0x0007ffffffffffffn;
}

/**
 * Parse a JSON string holding a float the way kj's `parseAs<double>()`
 * does: C `strtod()` must consume the whole string. That accepts leading
 * whitespace, a sign, decimal and hex floats, case-insensitive `inf`,
 * `infinity`, and `nan` with an optional `(n-char-sequence)`.
 */
function parseStrictFloatString(raw: string): DynamicValueReader {
  const m =
    /^[ \t\n\v\f\r]*([+-]?)(?:(inf(?:inity)?)|(nan(?:\(([A-Za-z0-9_]*)\))?)|0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?[0-9]+))?|((?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?))$/i.exec(
      raw,
    );
  const hex = m !== null && m[5] !== undefined && (m[5] !== "" || (m[6] ?? "") !== "");
  assertCapnp(
    m !== null && (m[8] !== undefined || m[2] !== undefined || m[3] !== undefined || hex),
    "JSON",
    `invalid float string '${raw}'`,
  );
  const negative = m![1] === "-";
  if (m![3] !== undefined) {
    const signBit = negative ? 0x8000000000000000n : 0n;
    const payload = m![4] === undefined ? 0n : parseNanPayloadBits(m![4]);
    return DynamicValueReader.fromFloat64Bits(signBit | 0x7ff8000000000000n | payload);
  }
  if (m![2] !== undefined) {
    return DynamicValueReader.fromFloat(negative ? -Infinity : Infinity);
  }
  if (hex) {
    return DynamicValueReader.fromFloat(
      parseHexFloat64(negative, m![5]!, m![6] ?? "", m![7]),
    );
  }
  const value = Number(m![8]);
  return DynamicValueReader.fromFloat(negative ? -value : value);
}

// ---------------------------------------------------------------------------
// $Json annotation metadata & handlers (models AnnotatedHandler in json.c++)
// ---------------------------------------------------------------------------

interface DiscriminatorSpec {
  readonly name: string | null;
  readonly valueName: string | null;
}

function readDiscriminatorPtr(p: Ptr): DiscriminatorSpec {
  if (p.kind !== PtrKind.Struct) {
    return { name: null, valueName: null };
  }
  const hasName = !p.getP(0).isNull;
  const hasValueName = !p.getP(1).isNull;
  return {
    name: hasName ? p.getText(0) : null,
    valueName: hasValueName ? p.getText(1) : null,
  };
}

interface FlattenedGatherEntry {
  readonly name: string;
  readonly field: StructField | null;
  readonly type: Type;
  readonly value: DynamicValueReader;
}

type FieldNameRoute =
  | { readonly kind: "normal"; readonly index: number }
  | {
      readonly kind: "flattened";
      readonly index: number;
      readonly prefixLength: number;
    }
  | { readonly kind: "unionTag" }
  | { readonly kind: "flattenedFromUnion"; readonly prefixLength: number }
  | { readonly kind: "unionValue" };

interface AnnotatedFieldMeta {
  name: string;
  nameForDiscriminant: string;
  prefix: string;
  flattenHandler: AnnotatedStructHandler | null;
}

class AnnotatedEnumHandler implements JsonCustomHandler {
  private readonly schema: EnumSchema;
  private readonly valueToName: string[] = [];
  private readonly nameToOrdinal = new Map<string, number>();

  constructor(schema: EnumSchema) {
    this.schema = schema;
    for (const e of schema.getEnumerants()) {
      let jsonName = e.name;
      const nameAnno = e.findAnnotation(JSON_NAME_ANNOTATION_ID);
      if (nameAnno && nameAnno.rawValue.which === "text") {
        jsonName = nameAnno.rawValue.value;
      }
      this.valueToName.push(jsonName);
      this.nameToOrdinal.set(jsonName, e.getOrdinal());
    }
  }

  encode(_codec: JsonCodec, input: DynamicValueReader): JsonAst {
    const ev = input.asEnum();
    const enumerant = ev.getEnumerant();
    if (enumerant) {
      return { which: "string", value: this.valueToName[enumerant.getIndex()]! };
    }
    return { which: "number", value: ev.getRaw() };
  }

  decode(_codec: JsonCodec, input: JsonAst): DynamicValueReader {
    if (input.which === "number") {
      assertCapnp(
        Number.isInteger(input.value) &&
          input.value >= 0 &&
          input.value <= 0xffff,
        "JSON",
        `invalid enum number ${input.value}`,
      );
      return DynamicValueReader.fromEnum(
        new DynamicEnum(this.schema, input.value),
      );
    }
    assertCapnp(input.which === "string", "JSON", "expected string or number for enum");
    const ord = this.nameToOrdinal.get(input.value);
    assertCapnp(
      ord !== undefined,
      "JSON",
      `invalid enum value '${input.value}' for ${this.schema.getShortDisplayName()}`,
    );
    return DynamicValueReader.fromEnum(new DynamicEnum(this.schema, ord));
  }
}

const BASE64_DATA_HANDLER: JsonCustomHandler = {
  encode(_codec, input) {
    return { which: "string", value: encodeBase64(input.asData()) };
  },
  decode(_codec, input) {
    assertCapnp(input.which === "string", "JSON", "expected base64 string for Data");
    return DynamicValueReader.fromData(decodeBase64(input.value));
  },
};

const HEX_DATA_HANDLER: JsonCustomHandler = {
  encode(_codec, input) {
    return { which: "string", value: encodeHex(input.asData()) };
  },
  decode(_codec, input) {
    assertCapnp(input.which === "string", "JSON", "expected hex string for Data");
    return DynamicValueReader.fromData(decodeHex(input.value));
  },
};

class AnnotatedStructHandler implements JsonCustomHandler {
  readonly schema: StructSchema;
  readonly fields: AnnotatedFieldMeta[] = [];
  readonly fieldsByName = new Map<string, FieldNameRoute>();
  readonly unionTagValues = new Map<string, StructField>();
  readonly unionTagName: string | null = null;
  readonly discriminantOffset: number;

  constructor(
    codec: JsonCodec,
    schema: StructSchema,
    discriminator: DiscriminatorSpec | null,
    unionDeclName: string | null,
    dependencies: Schema[],
  ) {
    this.schema = schema;
    this.discriminantOffset = schema.discriminantOffset;

    let discSpec = discriminator;
    if (!discSpec) {
      const structDisc = schema.findAnnotation(JSON_DISCRIMINATOR_ANNOTATION_ID);
      if (structDisc && structDisc.rawValue.which === "struct") {
        discSpec = readDiscriminatorPtr(structDisc.rawValue.ptr);
      }
    }

    if (discSpec) {
      // An unnamed discriminator uses the union's own name when the union
      // was flattened into its parent, and omits the tag otherwise.
      this.unionTagName = discSpec.name ?? unionDeclName;
      if (this.unionTagName !== null) {
        this.fieldsByName.set(this.unionTagName, { kind: "unionTag" });
      }
      if (discSpec.valueName !== null) {
        this.fieldsByName.set(discSpec.valueName, { kind: "unionValue" });
      }
    }

    for (const field of schema.getFields()) {
      const fType = field.getType();
      let fName = field.name;
      let prefix = "";
      let flattened = false;
      let subDisc: DiscriminatorSpec | null = null;

      for (const anno of field.getAnnotations()) {
        if (anno.id === JSON_NAME_ANNOTATION_ID && anno.rawValue.which === "text") {
          fName = anno.rawValue.value;
        } else if (anno.id === JSON_FLATTEN_ANNOTATION_ID) {
          assertCapnp(
            fType.isStruct(),
            "JSON",
            `only struct/group fields can carry $Json.flatten (${field.name})`,
          );
          flattened = true;
          if (anno.rawValue.which === "struct" && !anno.rawValue.ptr.isNull) {
            prefix = anno.rawValue.ptr.getText(0, "");
          }
        } else if (anno.id === JSON_DISCRIMINATOR_ANNOTATION_ID) {
          assertCapnp(
            field.isGroup(),
            "JSON",
            `only union/group fields can carry $Json.discriminator (${field.name})`,
          );
          if (anno.rawValue.which === "struct") {
            subDisc = readDiscriminatorPtr(anno.rawValue.ptr);
          }
        } else if (anno.id === JSON_BASE64_ANNOTATION_ID) {
          assertCapnp(fType.isData(), "JSON", "$Json.base64 requires Data field");
          codec.addFieldHandler(field, BASE64_DATA_HANDLER);
        } else if (anno.id === JSON_HEX_ANNOTATION_ID) {
          assertCapnp(fType.isData(), "JSON", "$Json.hex requires Data field");
          codec.addFieldHandler(field, HEX_DATA_HANDLER);
        }
      }

      let flattenHandler: AnnotatedStructHandler | null = null;
      if (field.isGroup()) {
        const subName = flattened ? field.name : null;
        const subH = codec._loadAnnotatedStructHandler(
          fType.asStruct(),
          subDisc,
          subName,
          dependencies,
        );
        if (flattened) flattenHandler = subH;
      } else if (fType.isStruct() && flattened) {
        flattenHandler = codec._loadAnnotatedStructHandler(
          fType.asStruct(),
          null,
          null,
          dependencies,
        );
      }

      const isUnion = field.isUnionMember;
      if (flattenHandler) {
        for (const childKey of flattenHandler.fieldsByName.keys()) {
          const flatKey = prefix.length > 0 ? `${prefix}${childKey}` : childKey;
          const existing = this.fieldsByName.get(flatKey);
          if (existing) {
            assertCapnp(
              existing.kind === "flattenedFromUnion" && isUnion,
              "JSON",
              `conflicting flattened field '${flatKey}'`,
            );
          } else {
            this.fieldsByName.set(
              flatKey,
              isUnion
                ? { kind: "flattenedFromUnion", prefixLength: prefix.length }
                : {
                    kind: "flattened",
                    index: field.index,
                    prefixLength: prefix.length,
                  },
            );
          }
        }
      }

      const nameForDiscriminant = fName;
      if (!flattened) {
        let usesSharedValueName = false;
        if (isUnion && discSpec && discSpec.valueName !== null) {
          fName = discSpec.valueName;
          usesSharedValueName = true;
        }
        if (!usesSharedValueName) {
          this.fieldsByName.set(fName, { kind: "normal", index: field.index });
        }
      }

      if (isUnion) {
        this.unionTagValues.set(nameForDiscriminant, field);
      }

      let leafType = fType;
      while (leafType.isList()) leafType = leafType.asList().getElementType();
      if (!codec._hasTypeHandler(leafType)) {
        if (leafType.isStruct()) dependencies.push(leafType.asStruct());
        else if (leafType.isEnum()) dependencies.push(leafType.asEnum());
        else if (leafType.isInterface()) dependencies.push(leafType.asInterface());
      }

      this.fields.push({
        name: fName,
        nameForDiscriminant,
        prefix,
        flattenHandler,
      });
    }
  }

  encode(codec: JsonCodec, input: DynamicValueReader): JsonAst {
    const gathered: FlattenedGatherEntry[] = [];
    this.gatherForEncode(codec, input.asStruct(), "", "", gathered);
    return {
      which: "object",
      value: gathered.map((entry) => ({
        name: entry.name,
        value: entry.field
          ? codec._encodeFieldAst(entry.field, entry.value)
          : codec._encodeValueAst(entry.value, entry.type),
      })),
    };
  }

  decode(
    codec: JsonCodec,
    input: JsonAst,
    type: Type,
    builder: MessageBuilder,
  ): DynamicValueReader {
    const st = type.asStruct();
    const slot = builder.allocWords(1);
    const sb = builder.initStructAt(
      new BuilderPointer(builder, slot.seg, slot.word),
      st.dataWordCount,
      st.pointerCount,
    );
    const out = new DynamicStructBuilder(st, sb);
    this.decodeStruct(codec, input, out);
    return DynamicValueReader.fromStruct(out.asReader());
  }

  decodeStruct(
    codec: JsonCodec,
    input: JsonAst,
    output: DynamicStructBuilder,
  ): void {
    assertCapnp(input.which === "object", "JSON", "expected JSON object");
    const unionsSeen = new Set<string>();
    let retries = [...input.value];

    let firstPass = true;
    while (retries.length > 0) {
      const pending: Array<{ name: string; value: JsonAst }> = [];
      for (const prop of retries) {
        if (
          !this.decodeProperty(
            codec,
            prop.name,
            prop.value,
            output,
            unionsSeen,
          )
        ) {
          pending.push(prop);
        }
      }
      if (!firstPass && pending.length === retries.length) {
        break;
      }
      firstPass = false;
      retries = pending;
    }
  }

  private gatherForEncode(
    codec: JsonCodec,
    reader: DynamicStructReader,
    prefix: string,
    morePrefix: string,
    out: FlattenedGatherEntry[],
  ): void {
    const combinedPrefix =
      morePrefix.length > 0 ? `${prefix}${morePrefix}` : prefix;
    const schema = reader.getSchema();

    for (const field of schema.getNonUnionFields()) {
      const info = this.fields[field.index]!;
      if (!reader.has(field, codec.getHasMode())) {
        continue;
      }
      if (info.flattenHandler) {
        info.flattenHandler.gatherForEncode(
          codec,
          reader.get(field).asStruct(),
          combinedPrefix,
          info.prefix,
          out,
        );
      } else {
        out.push({
          name: `${combinedPrefix}${info.name}`,
          field,
          type: field.getType(),
          value: reader.get(field),
        });
      }
    }

    const active = reader.which();
    if (active) {
      const info = this.fields[active.index]!;
      if (this.unionTagName !== null) {
        out.push({
          name: `${combinedPrefix}${this.unionTagName}`,
          field: null,
          type: Type.TEXT,
          value: DynamicValueReader.fromText(info.nameForDiscriminant),
        });
      }
      if (info.flattenHandler) {
        info.flattenHandler.gatherForEncode(
          codec,
          reader.get(active).asStruct(),
          combinedPrefix,
          info.prefix,
          out,
        );
      } else {
        const fType = active.getType();
        if (fType.isVoid() && this.unionTagName !== null) {
          // Explicit discriminator covers void union arms.
        } else {
          out.push({
            name: `${combinedPrefix}${info.name}`,
            field: active,
            type: fType,
            value: reader.get(active),
          });
        }
      }
    }
  }

  private unionInstanceKey(output: DynamicStructBuilder): string {
    return `${output.sb.seg}:${output.sb.word}:${this.discriminantOffset}`;
  }

  private decodeProperty(
    codec: JsonCodec,
    name: string,
    value: JsonAst,
    output: DynamicStructBuilder,
    unionsSeen: Set<string>,
  ): boolean {
    const route = this.fieldsByName.get(name);
    if (!route) {
      assertCapnp(
        !codec.getRejectUnknownFields(),
        "JSON",
        `unknown JSON field '${name}'`,
      );
      return true;
    }

    const fields = output.getSchema().getFields();
    switch (route.kind) {
      case "normal": {
        const field = fields[route.index]!;
        codec._decodeFieldAst(field, value, output);
        return true;
      }
      case "flattened": {
        const field = fields[route.index]!;
        const subBuilder = output.get(field).asStruct();
        const subHandler = this.fields[route.index]!.flattenHandler!;
        return subHandler.decodeProperty(
          codec,
          name.slice(route.prefixLength),
          value,
          subBuilder,
          unionsSeen,
        );
      }
      case "unionTag": {
        assertCapnp(
          value.which === "string",
          "JSON",
          "expected string value for union discriminator",
        );
        const key = this.unionInstanceKey(output);
        const targetField = this.unionTagValues.get(value.value);
        if (targetField) {
          output.clear(targetField);
          unionsSeen.add(key);
        } else {
          assertCapnp(
            !codec.getRejectUnknownFields(),
            "JSON",
            `unknown union tag '${value.value}'`,
          );
        }
        return true;
      }
      case "flattenedFromUnion": {
        const key = this.unionInstanceKey(output);
        if (!unionsSeen.has(key)) return false;
        const variant = output.which();
        if (!variant) return true;
        const subHandler = this.fields[variant.index]!.flattenHandler;
        if (!subHandler) return true;
        return subHandler.decodeProperty(
          codec,
          name.slice(route.prefixLength),
          value,
          output.get(variant).asStruct(),
          unionsSeen,
        );
      }
      case "unionValue": {
        const key = this.unionInstanceKey(output);
        if (!unionsSeen.has(key)) return false;
        const variant = output.which();
        if (!variant) return true;
        codec._decodeFieldAst(variant, value, output);
        return true;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public JsonCodec class
// ---------------------------------------------------------------------------

export class JsonCodec {
  private prettyPrint: boolean;
  private hasMode: HasMode;
  private maxNestingDepth: number;
  private rejectUnknownFields: boolean;
  private rawText = false;

  private readonly typeHandlers = new Map<string, JsonCustomHandler>();
  private readonly fieldHandlers = new WeakMap<StructField, JsonCustomHandler>();
  private readonly annotatedStructs = new Map<
    string,
    AnnotatedStructHandler | "loading"
  >();
  private readonly annotatedEnums = new Set<string>();

  constructor(opts?: JsonCodecOptions) {
    this.prettyPrint = opts?.prettyPrint ?? false;
    this.hasMode = opts?.hasMode ?? HasMode.NON_NULL;
    this.maxNestingDepth = opts?.maxNestingDepth ?? DEFAULT_DEPTH_LIMIT;
    this.rejectUnknownFields = opts?.rejectUnknownFields ?? false;
  }

  setPrettyPrint(enabled: boolean): void {
    this.prettyPrint = enabled;
  }

  setHasMode(mode: HasMode): void {
    this.hasMode = mode;
  }

  getHasMode(): HasMode {
    return this.hasMode;
  }

  setMaxNestingDepth(depth: number): void {
    this.maxNestingDepth = depth;
  }

  setRejectUnknownFields(enabled: boolean): void {
    this.rejectUnknownFields = enabled;
  }

  getRejectUnknownFields(): boolean {
    return this.rejectUnknownFields;
  }

  addTypeHandler(
    typeOrSchema: Type | StructSchema | EnumSchema | ListSchema,
    handler: JsonCustomHandler,
  ): void {
    const t =
      typeOrSchema instanceof Type ? typeOrSchema : typeOrSchema.asType();
    const key = t.canonicalKey();
    const existing = this.typeHandlers.get(key);
    assertCapnp(
      !existing || existing === handler,
      "ARG",
      `type ${key} already has a different JSON handler`,
    );
    this.typeHandlers.set(key, handler);
  }

  addFieldHandler(field: StructField, handler: JsonCustomHandler): void {
    const existing = this.fieldHandlers.get(field);
    assertCapnp(
      !existing || existing === handler,
      "ARG",
      `field ${field.name} already has a different JSON handler`,
    );
    this.fieldHandlers.set(field, handler);
  }

  /** @internal */
  _hasTypeHandler(type: Type): boolean {
    return this.typeHandlers.has(type.canonicalKey());
  }

  /** @internal */
  _loadAnnotatedStructHandler(
    schema: StructSchema,
    discriminator: DiscriminatorSpec | null,
    unionDeclName: string | null,
    dependencies: Schema[],
  ): AnnotatedStructHandler {
    const key = schema.brandKey;
    const state = this.annotatedStructs.get(key);
    if (state === "loading") {
      throw new CapnpError(
        "JSON",
        `cyclic $Json.flatten detected on ${schema.displayName}`,
      );
    }
    if (state) return state;

    this.annotatedStructs.set(key, "loading");
    const handler = new AnnotatedStructHandler(
      this,
      schema,
      discriminator,
      unionDeclName,
      dependencies,
    );
    this.annotatedStructs.set(key, handler);
    this.addTypeHandler(schema, handler);
    return handler;
  }

  /**
   * Inspect `schema` and all transitive field dependencies for `$Json`
   * annotations (`name`, `flatten`, `discriminator`, `base64`, `hex`).
   */
  handleByAnnotation(schema: Schema): void {
    if (schema.which === "struct") {
      const deps: Schema[] = [];
      this._loadAnnotatedStructHandler(schema.asStruct(), null, null, deps);
      for (const dep of deps) {
        this.handleByAnnotation(dep);
      }
    } else if (schema.which === "enum") {
      const es = schema.asEnum();
      if (!this.annotatedEnums.has(es.brandKey)) {
        this.annotatedEnums.add(es.brandKey);
        this.addTypeHandler(es, new AnnotatedEnumHandler(es));
      }
    }
  }

  encodeRaw(value: JsonAst): string {
    return this.renderAst(value, 0, false).text;
  }

  /** Parse JSON text, or its UTF-8 bytes; a string is UTF-8 encoded first. */
  decodeRaw(input: string | Uint8Array): JsonAst {
    const bytes = typeof input === "string" ? UTF8_ENC.encode(input) : input;
    return new RawJsonParser(bytesToByteString(bytes), this.maxNestingDepth).parseRoot();
  }

  /**
   * The `encodeBytes` output decoded as UTF-8, so invalid bytes in Text
   * become U+FFFD only after line breaks are chosen on the raw bytes.
   */
  encode(value: PrintableDynamic, type?: Type): string {
    return TEXT_DEC.decode(this.encodeBytes(value, type));
  }

  /**
   * Encode to UTF-8 bytes with Text written byte for byte, as C++ does, so
   * invalid UTF-8 is kept. A lone surrogate U+DC00 + b that a custom
   * handler puts in a string is written as the byte b.
   */
  encodeBytes(value: PrintableDynamic, type?: Type): Uint8Array {
    const saved = this.rawText;
    this.rawText = true;
    try {
      const { reader, resolvedType } = coerceInputAndType(value, type);
      return rawStringToBytes(this.encodeRaw(this._encodeValueAst(reader, resolvedType)));
    } finally {
      this.rawText = saved;
    }
  }

  decodeStruct(input: string | Uint8Array | JsonAst, output: DynamicStructBuilder): void {
    const ast =
      typeof input === "string" || input instanceof Uint8Array ? this.decodeRaw(input) : input;
    const stType = output.getSchema().asType();
    const handler = this.typeHandlers.get(stType.canonicalKey());
    if (handler?.decodeStruct) {
      handler.decodeStruct(this, ast, output);
      return;
    }
    this.decodeObjectIntoStruct(ast, output);
  }

  decode(
    input: string | JsonAst,
    schema: StructSchema,
    builder: MessageBuilder = new MessageBuilder(),
  ): DynamicStructReader {
    const root = initDynamicRoot(builder, schema);
    this.decodeStruct(input, root);
    return root.asReader();
  }

  decodeValue(
    input: string | JsonAst,
    type: Type,
    builder: MessageBuilder = new MessageBuilder(),
  ): DynamicValueReader {
    const ast = typeof input === "string" ? this.decodeRaw(input) : input;
    return this._decodeValueAst(ast, type, builder);
  }

  /** @internal */
  _encodeFieldAst(field: StructField, value: DynamicValueReader): JsonAst {
    const fh = this.fieldHandlers.get(field);
    if (fh) {
      return fh.encode(this, value, field.getType());
    }
    return this._encodeValueAst(value, field.getType());
  }

  /** @internal */
  _encodeValueAst(input: DynamicValueReader, type: Type): JsonAst {
    const th = this.typeHandlers.get(type.canonicalKey());
    if (th) {
      return th.encode(this, input, type);
    }

    switch (type.whichCode) {
      case TypeKind.Void:
        return { which: "null" };
      case TypeKind.Bool:
        return { which: "boolean", value: input.asBool() };
      case TypeKind.Int8:
      case TypeKind.Int16:
      case TypeKind.Int32:
      case TypeKind.UInt8:
      case TypeKind.UInt16:
      case TypeKind.UInt32:
        return { which: "number", value: input.asNumber() };
      case TypeKind.Float32:
      case TypeKind.Float64: {
        const v = type.isFloat32() ? input.asFloat32() : input.asFloat64();
        if (v === Infinity) return { which: "string", value: "Infinity" };
        if (v === -Infinity) return { which: "string", value: "-Infinity" };
        if (Number.isNaN(v)) return { which: "string", value: "NaN" };
        return { which: "number", value: v };
      }
      case TypeKind.Int64:
        return { which: "string", value: input.asInt64().toString(10) };
      case TypeKind.UInt64:
        return { which: "string", value: input.asUInt64().toString(10) };
      case TypeKind.Text:
        return {
          which: "string",
          value: this.rawText
            ? rawTextToString(input.asTextBytes())
            : TEXT_DEC.decode(input.asTextBytes()),
        };
      case TypeKind.Data: {
        const bytes = input.asData();
        const items: JsonAst[] = new Array(bytes.length);
        for (let i = 0; i < bytes.length; i++) {
          items[i] = { which: "number", value: bytes[i]! };
        }
        return { which: "array", value: items };
      }
      case TypeKind.List: {
        const list = input.asList();
        const elemType = type.asList().getElementType();
        const items: JsonAst[] = new Array(list.size());
        for (let i = 0; i < list.size(); i++) {
          items[i] = this._encodeValueAst(list.get(i), elemType);
        }
        return { which: "array", value: items };
      }
      case TypeKind.Enum: {
        const ev = input.asEnum();
        const enumerant = ev.getEnumerant();
        if (enumerant) return { which: "string", value: enumerant.name };
        return { which: "number", value: ev.getRaw() };
      }
      case TypeKind.Struct: {
        const st = input.asStruct();
        const nonUnion = st.getSchema().getNonUnionFields();
        const outFields: Array<{ name: string; value: JsonAst }> = [];

        let active = st.which();
        let unionIsNull = false;
        if (active) {
          unionIsNull = !st.has(active, this.hasMode);
          if (active.discriminantValue === 0 && unionIsNull) {
            active = null;
          }
        }

        for (const field of nonUnion) {
          if (active && active.index < field.index) {
            outFields.push({
              name: active.name,
              value: unionIsNull
                ? { which: "null" }
                : this._encodeFieldAst(active, st.get(active)),
            });
            active = null;
          }
          if (st.has(field, this.hasMode)) {
            outFields.push({
              name: field.name,
              value: this._encodeFieldAst(field, st.get(field)),
            });
          }
        }

        if (active) {
          outFields.push({
            name: active.name,
            value: unionIsNull
              ? { which: "null" }
              : this._encodeFieldAst(active, st.get(active)),
          });
        }

        return { which: "object", value: outFields };
      }
      case TypeKind.Interface:
        throw new CapnpError(
          "UNSUPPORTED",
          "cannot JSON-encode capabilities without a registered handler",
        );
      case TypeKind.AnyPointer:
        throw new CapnpError(
          "UNSUPPORTED",
          "cannot JSON-encode AnyPointer without a registered handler",
        );
      default:
        throw new CapnpError("KIND", `unhandled JSON type ${type.which}`);
    }
  }

  private decodeObjectIntoStruct(
    input: JsonAst,
    output: DynamicStructBuilder,
  ): void {
    assertCapnp(input.which === "object", "JSON", "expected JSON object");
    const schema = output.getSchema();
    for (const prop of input.value) {
      const field = schema.findFieldByName(prop.name);
      if (field) {
        this._decodeFieldAst(field, prop.value, output);
      } else {
        assertCapnp(
          !this.rejectUnknownFields,
          "JSON",
          `unknown JSON field '${prop.name}'`,
        );
      }
    }
  }

  /** @internal */
  _decodeFieldAst(
    field: StructField,
    value: JsonAst,
    output: DynamicStructBuilder,
  ): void {
    const fType = field.getType();
    const fh = this.fieldHandlers.get(field);
    if (fh) {
      assertCapnp(!!fh.decode, "JSON", `field handler on ${field.name} lacks decode()`);
      output.set(field, fh.decode(this, value, fType, output.sb.builder));
      return;
    }

    if (field.isGroup()) {
      const grp = output.init(field).asStruct();
      this.decodeStruct(value, grp);
      return;
    }

    if (fType.isStruct()) {
      const th = this.typeHandlers.get(fType.canonicalKey());
      if (th && th.decode && !th.decodeStruct) {
        output.set(field, th.decode(this, value, fType, output.sb.builder));
        return;
      }
      const sub = output.init(field).asStruct();
      this.decodeStruct(value, sub);
      return;
    }

    if (fType.isList()) {
      const th = this.typeHandlers.get(fType.canonicalKey());
      if (th?.decode) {
        output.set(field, th.decode(this, value, fType, output.sb.builder));
        return;
      }
      assertCapnp(value.which === "array", "JSON", `expected array for '${field.name}'`);
      const lb = output.init(field, value.value.length).asList();
      this.decodeArrayIntoList(value.value, lb);
      return;
    }

    output.set(field, this._decodeValueAst(value, fType, output.sb.builder));
  }

  private decodeArrayIntoList(
    items: readonly JsonAst[],
    lb: DynamicListBuilder,
  ): void {
    const elemType = lb.getSchema().getElementType();
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (elemType.isStruct()) {
        this.decodeStruct(item, lb.get(i).asStruct());
      } else if (elemType.isList()) {
        assertCapnp(item.which === "array", "JSON", "expected nested JSON array");
        const sub = lb.init(i, item.value.length).asList();
        this.decodeArrayIntoList(item.value, sub);
      } else {
        lb.set(i, this._decodeValueAst(item, elemType, lb.builder));
      }
    }
  }

  /** @internal */
  _decodeValueAst(
    input: JsonAst,
    type: Type,
    builder: MessageBuilder,
  ): DynamicValueReader {
    const th = this.typeHandlers.get(type.canonicalKey());
    if (th) {
      if (th.decode) return th.decode(this, input, type, builder);
      if (th.decodeStruct && type.isStruct()) {
        const tmp = new MessageBuilder();
        const root = initDynamicRoot(tmp, type.asStruct());
        th.decodeStruct(this, input, root);
        return DynamicValueReader.fromStruct(root.asReader());
      }
    }

    switch (type.whichCode) {
      case TypeKind.Void:
        return DynamicValueReader.VOID;
      case TypeKind.Bool:
        assertCapnp(input.which === "boolean", "JSON", "expected boolean value");
        return DynamicValueReader.fromBool(input.value);
      case TypeKind.Int8:
      case TypeKind.Int16:
      case TypeKind.Int32:
      case TypeKind.Int64: {
        let r: DynamicValueReader;
        if (input.which === "number") {
          r = DynamicValueReader.fromFloat(input.value);
        } else if (input.which === "string") {
          r = DynamicValueReader.fromInt(parseStrictBigIntString(input.value, true));
        } else {
          throw new CapnpError("JSON", "expected integer value");
        }
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
        let r: DynamicValueReader;
        if (input.which === "number") {
          r = DynamicValueReader.fromFloat(input.value);
        } else if (input.which === "string") {
          r = DynamicValueReader.fromUInt(parseStrictBigIntString(input.value, false));
        } else {
          throw new CapnpError("JSON", "expected unsigned integer value");
        }
        if (type.whichCode === TypeKind.UInt8) r.asUInt8();
        else if (type.whichCode === TypeKind.UInt16) r.asUInt16();
        else if (type.whichCode === TypeKind.UInt32) r.asUInt32();
        else r.asUInt64();
        return r;
      }
      case TypeKind.Float32:
      case TypeKind.Float64: {
        if (input.which === "null") return DynamicValueReader.fromFloat(NaN);
        if (input.which === "number") {
          return DynamicValueReader.fromFloat(input.value);
        }
        if (input.which === "string") {
          return parseStrictFloatString(input.value);
        }
        throw new CapnpError("JSON", "expected float value");
      }
      case TypeKind.Text:
        assertCapnp(input.which === "string", "JSON", "expected text string");
        return input.bytes
          ? DynamicValueReader.fromTextBytes(input.bytes)
          : DynamicValueReader.fromText(input.value);
      case TypeKind.Data: {
        assertCapnp(input.which === "array", "JSON", "expected byte array for Data");
        const bytes = new Uint8Array(input.value.length);
        for (let i = 0; i < input.value.length; i++) {
          const item = input.value[i]!;
          assertCapnp(
            item.which === "number" &&
              Number.isInteger(item.value) &&
              item.value >= 0 &&
              item.value <= 255,
            "JSON",
            "number in Data byte array is not an integer in [0, 255]",
          );
          bytes[i] = item.value;
        }
        return DynamicValueReader.fromData(bytes);
      }
      case TypeKind.List: {
        assertCapnp(input.which === "array", "JSON", "expected array for list");
        const tmp = new MessageBuilder();
        const slot = tmp.rootSlot();
        const lb = DynamicListBuilder.allocateAtSlot(
          tmp,
          slot,
          type.asList(),
          input.value.length,
        );
        this.decodeArrayIntoList(input.value, lb);
        return DynamicValueReader.fromList(lb.asReader());
      }
      case TypeKind.Enum: {
        assertCapnp(input.which === "string", "JSON", "expected string for enum");
        return DynamicValueReader.fromEnum(
          DynamicEnum.fromEnumerant(type.asEnum().getEnumerantByName(input.value)),
        );
      }
      case TypeKind.Struct: {
        const tmp = new MessageBuilder();
        const root = initDynamicRoot(tmp, type.asStruct());
        this.decodeObjectIntoStruct(input, root);
        return DynamicValueReader.fromStruct(root.asReader());
      }
      case TypeKind.Interface:
        throw new CapnpError(
          "UNSUPPORTED",
          "cannot JSON-decode capabilities without a registered handler",
        );
      case TypeKind.AnyPointer:
        throw new CapnpError(
          "UNSUPPORTED",
          "cannot JSON-decode AnyPointer without a registered handler",
        );
      default:
        throw new CapnpError("KIND", `unhandled JSON decode type ${type.which}`);
    }
  }

  private renderAst(
    value: JsonAst,
    indent: number,
    hasPrefix: boolean,
  ): { text: string; multiline: boolean } {
    switch (value.which) {
      case "null":
        return { text: "null", multiline: false };
      case "boolean":
        return { text: value.value ? "true" : "false", multiline: false };
      case "number":
        return { text: formatKjFloat64(value.value), multiline: false };
      case "string":
        return { text: encodeJsonString(value.value, this.rawText), multiline: false };
      case "raw":
        return { text: value.value, multiline: value.value.includes("\n") };
      case "array": {
        const subIndent = indent + (value.value.length > 1 ? 1 : 0);
        let childMultiline = false;
        const elems = value.value.map((el) => {
          const r = this.renderAst(el, subIndent, false);
          if (r.multiline) childMultiline = true;
          return r.text;
        });
        const joined = this.renderList(
          elems,
          childMultiline,
          indent,
          hasPrefix,
        );
        return { text: `[${joined.text}]`, multiline: joined.multiline };
      }
      case "object": {
        const subIndent = indent + (value.value.length > 1 ? 1 : 0);
        let childMultiline = false;
        const colon = this.prettyPrint ? ": " : ":";
        const elems = value.value.map((f) => {
          const r = this.renderAst(f.value, subIndent, true);
          if (r.multiline) childMultiline = true;
          return `${encodeJsonString(f.name)}${colon}${r.text}`;
        });
        const joined = this.renderList(
          elems,
          childMultiline,
          indent,
          hasPrefix,
        );
        return { text: `{${joined.text}}`, multiline: joined.multiline };
      }
      case "call": {
        const subIndent = indent + (value.params.length > 1 ? 1 : 0);
        let childMultiline = false;
        const elems = value.params.map((p) => {
          const r = this.renderAst(p, subIndent, false);
          if (r.multiline) childMultiline = true;
          return r.text;
        });
        const joined = this.renderList(elems, childMultiline, indent, true);
        return {
          text: `${value.fn}(${joined.text})`,
          multiline: joined.multiline,
        };
      }
    }
  }

  private renderList(
    elements: readonly string[],
    hasMultilineElement: boolean,
    indent: number,
    hasPrefix: boolean,
  ): { text: string; multiline: boolean } {
    let maxChildSize = 0;
    for (const e of elements) {
      const sz = rawStringByteLength(e);
      if (sz > maxChildSize) maxChildSize = sz;
    }

    if (!this.prettyPrint) {
      return { text: elements.join(","), multiline: false };
    }
    if (elements.length > 1 && (hasMultilineElement || maxChildSize > 50)) {
      const indentSpace = " ".repeat((indent + 1) * 2);
      const delim = `,\n${indentSpace}`;
      const prefix = hasPrefix ? `\n${indentSpace}` : " ";
      return {
        text: `${prefix}${elements.join(delim)} `,
        multiline: true,
      };
    }
    return {
      text: elements.join(", "),
      multiline: hasMultilineElement,
    };
  }
}

function coerceInputAndType(
  value: PrintableDynamic,
  explicitType?: Type,
): { reader: DynamicValueReader; resolvedType: Type } {
  if (value instanceof DynamicStructReader) {
    return {
      reader: DynamicValueReader.fromStruct(value),
      resolvedType: explicitType ?? value.getSchema().asType(),
    };
  }
  if (value instanceof DynamicStructBuilder) {
    const r = value.asReader();
    return {
      reader: DynamicValueReader.fromStruct(r),
      resolvedType: explicitType ?? r.getSchema().asType(),
    };
  }
  if (value instanceof DynamicEnum) {
    return {
      reader: DynamicValueReader.fromEnum(value),
      resolvedType: explicitType ?? value.getSchema().asType(),
    };
  }
  if ("getSchema" in value && "size" in value) {
    const r =
      value instanceof DynamicListBuilder ? value.asReader() : value;
    return {
      reader: DynamicValueReader.fromList(r),
      resolvedType: explicitType ?? r.getSchema().asType(),
    };
  }
  if (value instanceof DynamicValueReader) {
    assertCapnp(
      explicitType !== undefined,
      "ARG",
      "JsonCodec.encode(DynamicValueReader) requires an explicit Type",
    );
    return { reader: value, resolvedType: explicitType };
  }
  if (value instanceof DynamicValueBuilder) {
    assertCapnp(
      explicitType !== undefined,
      "ARG",
      "JsonCodec.encode(DynamicValueBuilder) requires an explicit Type",
    );
    return { reader: value.asReader(), resolvedType: explicitType };
  }
  assertCapnp(
    explicitType !== undefined,
    "ARG",
    "JsonCodec.encode requires an explicit Type for capability values",
  );
  return {
    reader: DynamicValueReader.fromCapability(value),
    resolvedType: explicitType,
  };
}

/**
 * Encode a DynamicStruct to JSON (defaults: `pretty = false`, `annotations = true`
 * matching `capnp convert binary:json`).
 */
export function encodeJson(
  value: DynamicStructReader | DynamicStructBuilder,
  opts?: {
    pretty?: boolean;
    hasMode?: HasMode;
    annotations?: boolean;
  },
): string {
  const codec = new JsonCodec({
    prettyPrint: opts?.pretty ?? false,
    hasMode: opts?.hasMode ?? HasMode.NON_NULL,
  });
  if (opts?.annotations ?? true) {
    codec.handleByAnnotation(value.getSchema());
  }
  return codec.encode(value);
}

/**
 * Like `encodeJson`, but returns UTF-8 bytes with Text copied byte for byte,
 * matching `capnp convert binary:json` on Text that is not valid UTF-8.
 */
export function encodeJsonBytes(
  value: DynamicStructReader | DynamicStructBuilder,
  opts?: {
    pretty?: boolean;
    hasMode?: HasMode;
    annotations?: boolean;
  },
): Uint8Array {
  const codec = new JsonCodec({
    prettyPrint: opts?.pretty ?? false,
    hasMode: opts?.hasMode ?? HasMode.NON_NULL,
  });
  if (opts?.annotations ?? true) {
    codec.handleByAnnotation(value.getSchema());
  }
  return codec.encodeBytes(value);
}

/**
 * Decode a JSON object, given as a string or as UTF-8 bytes, into a
 * stream-framed `Message` (defaults:
 * `annotations = true`, `rejectUnknownFields = false`, matching `capnp convert json:binary`).
 */
export function decodeJson(
  input: string | Uint8Array,
  schema: StructSchema,
  opts?: {
    annotations?: boolean;
    rejectUnknownFields?: boolean;
    maxNestingDepth?: number;
  },
): Message {
  const codec = new JsonCodec({
    rejectUnknownFields: opts?.rejectUnknownFields ?? false,
    maxNestingDepth: opts?.maxNestingDepth ?? DEFAULT_DEPTH_LIMIT,
  });
  if (opts?.annotations ?? true) {
    codec.handleByAnnotation(schema);
  }
  const builder = new MessageBuilder();
  const root = initDynamicRoot(builder, schema);
  codec.decodeStruct(input, root);
  return Message.fromFlat(builder.toFlat());
}

/**
 * Split a multi-message JSON stream the way `readOneJson` in the `capnp` CLI
 * does. Braces count everywhere, even inside strings, except in a `#` or
 * `//` comment up to the end of the line. After a `/` the splitter stays in
 * that state, so any later `/` also starts a comment. A message ends at the
 * `{` that follows a closed top-level object. Slices are returned raw, with
 * comments and whitespace left for the JSON parser to reject.
 */
export function splitJsonMessages(input: string): string[] {
  const messages: string[] = [];
  let state: "normal" | "slash" | "comment" = "normal";
  let depth = 0;
  let sawClose = false;
  let start = 0;

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (state === "comment") {
      if (c === "\n") state = "normal";
      continue;
    }
    if (state === "slash" && c === "/") {
      state = "comment";
      continue;
    }
    if (c === "#") {
      state = "comment";
    } else if (c === "/") {
      state = "slash";
    } else if (c === "{") {
      if (depth === 0 && sawClose) {
        messages.push(input.slice(start, i));
        start = i;
        state = "normal";
        sawClose = false;
      }
      depth++;
    } else if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0) sawClose = true;
    }
  }

  if (start < input.length) messages.push(input.slice(start));
  return messages;
}
