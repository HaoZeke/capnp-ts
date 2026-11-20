/**
 * CLI implementation for `capnp-ts`: `encode`, `decode`, `convert`, and `eval`.
 *
 * Supports all seven `capnp convert` formats (`binary`, `packed`, `flat`,
 * `flat-packed`, `canonical`, `text`, `json`) in every direction, multi-message
 * streams, precompiled `.cgr.bin` schemas, and `.capnp` source schemas via
 * `capnp compile -o-`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MessageBuilder } from "./builder.ts";
import { canonicalize, messageFromRawSegment } from "./canonical.ts";
import { deepCopyPtrToSlot } from "./copy.ts";
import {
  DynamicStruct,
  DynamicStructReader,
  DynamicValue,
  DynamicValueReader,
  DynamicValueType,
  initDynamicRoot,
  setDynamicRoot,
} from "./dynamic.ts";
import { loadU32 } from "./endian.ts";
import { CapnpError, MAX_SEGMENTS, WORD_BYTES, assertCapnp } from "./kinds.ts";
import { decodeJson, encodeJsonBytes, splitJsonMessages } from "./json.ts";
import { Message } from "./message.ts";
import { pack, unpack } from "./packed.ts";
import { SchemaLoader, StructSchema, Type } from "./schema.ts";
import {
  encodeTextBytes,
  splitTextMessages,
  TextCodec,
  type TextInputError,
} from "./text.ts";

export type WireFormat =
  | "binary"
  | "packed"
  | "flat"
  | "flat-packed"
  | "canonical"
  | "text"
  | "json";

const VALID_FORMATS = new Set<string>([
  "binary",
  "packed",
  "flat",
  "flat-packed",
  "canonical",
  "text",
  "json",
]);

export function parseWireFormat(name: string): WireFormat | null {
  return VALID_FORMATS.has(name) ? (name as WireFormat) : null;
}

export function formatNeedsSchema(fmt: WireFormat): boolean {
  return fmt === "text" || fmt === "json";
}

const UTF8_ENC = new TextEncoder();
const UTF8_DEC = new TextDecoder("utf-8", { fatal: false });

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Split a concatenated stream of framed Cap'n Proto binary messages into
 * individual `Message` readers.
 */
export function splitFramedMessages(input: Uint8Array): Message[] {
  return Array.from(iterateFramedMessages(input));
}

/** Like `splitFramedMessages`, but each frame is checked only when it is reached. */
function* iterateFramedMessages(input: Uint8Array): Generator<Message> {
  let offset = 0;
  while (offset < input.byteLength) {
    assertCapnp(
      input.byteLength - offset >= 8,
      "FRAMING",
      "truncated message stream header",
    );
    const nsegs = loadU32(input, offset) + 1;
    assertCapnp(
      nsegs > 0 && nsegs <= MAX_SEGMENTS,
      "FRAMING",
      `bad segment count ${nsegs}`,
    );
    let tableBytes = 4 + 4 * nsegs;
    if (tableBytes % 8 !== 0) tableBytes += 4;
    assertCapnp(
      offset + tableBytes <= input.byteLength,
      "FRAMING",
      "truncated segment table in stream",
    );
    let bodyWords = 0;
    for (let i = 0; i < nsegs; i++) {
      bodyWords += loadU32(input, offset + 4 + 4 * i);
    }
    const frameBytes = tableBytes + bodyWords * WORD_BYTES;
    assertCapnp(
      offset + frameBytes <= input.byteLength,
      "FRAMING",
      "truncated segment body in stream",
    );
    yield Message.fromFlat(input.subarray(offset, offset + frameBytes), {
      traversalWords: 1_073_741_824,
      depthLimit: 256,
    });
    offset += frameBytes;
  }
}

/** Read zero or more messages from `input` in `from` format. */
export function readMessagesInFormat(
  input: Uint8Array,
  from: WireFormat,
  rootSchema?: StructSchema,
): Message[] {
  return Array.from(iterateMessagesInFormat(input, from, rootSchema), (m) => m.message);
}

/**
 * A message read from a stream. `error` is the first error capnp recovers
 * from while translating text input; capnp writes the message and then
 * reports it.
 */
interface StreamMessage {
  readonly message: Message;
  readonly error?: TextInputError;
}

/**
 * Read messages one at a time, as `capnp` converts each before it reads the
 * next. Errors capnp recovers from are thrown unless `recover` is set.
 */
function* iterateMessagesInFormat(
  input: Uint8Array,
  from: WireFormat,
  rootSchema?: StructSchema,
  opts?: { recover?: boolean },
): Generator<StreamMessage> {
  if (input.byteLength === 0) return;
  const wrap = function* (messages: Iterable<Message>): Generator<StreamMessage> {
    for (const message of messages) yield { message };
  };

  switch (from) {
    case "binary":
      return yield* wrap(iterateFramedMessages(input));
    case "packed":
      return yield* wrap(iterateFramedMessages(unpack(input, { maxWords: 1_073_741_824 })));
    case "flat": {
      const wordBytes = (input.byteLength >>> 3) * WORD_BYTES;
      assertCapnp(wordBytes > 0, "FRAMING", "flat input shorter than one word");
      yield {
        message: Message.fromSegments([input.subarray(0, wordBytes)], {
          traversalWords: 1_073_741_824,
          depthLimit: 256,
        }),
      };
      return;
    }
    case "flat-packed": {
      const raw = unpack(input, { maxWords: 1_073_741_824 });
      yield { message: messageFromRawSegment(raw) };
      return;
    }
    case "canonical": {
      const wordBytes = (input.byteLength >>> 3) * WORD_BYTES;
      assertCapnp(
        wordBytes > 0 && wordBytes === input.byteLength,
        "CANONICAL",
        "canonical input must be non-empty and word-aligned",
      );
      const msg = Message.fromSegments([input], {
        traversalWords: 1_073_741_824,
        depthLimit: 256,
      });
      const recanon = canonicalize(msg);
      assertCapnp(
        bytesEqual(recanon, input),
        "CANONICAL",
        "input message is not in canonical form",
      );
      yield { message: msg };
      return;
    }
    case "text": {
      assertCapnp(
        rootSchema !== undefined,
        "ARG",
        "text format requires <schema> and <type>",
      );
      const source = Array.from(input, (byte) => String.fromCharCode(byte)).join("");
      for (const slice of splitTextMessages(source)) {
        const builder = new MessageBuilder();
        const root = initDynamicRoot(builder, rootSchema);
        let error: TextInputError | undefined;
        new TextCodec().decodeStructBytes(
          slice,
          root,
          opts?.recover ? (e) => { error ??= e; } : undefined,
        );
        yield { message: Message.fromFlat(builder.toFlat()), error };
      }
      return;
    }
    case "json": {
      assertCapnp(
        rootSchema !== undefined,
        "ARG",
        "json format requires <schema> and <type>",
      );
      for (const slice of splitJsonMessages(UTF8_DEC.decode(input))) {
        yield { message: decodeJson(slice, rootSchema) };
      }
      return;
    }
  }
}

export interface WriteFormatOptions {
  short?: boolean;
  segmentSize?: number;
  /**
   * Apply `$Json` annotations. `capnp convert` compiles and applies them.
   * `capnp eval` drops annotations, so eval passes false.
   */
  annotations?: boolean;
}

function rebuildMessageRoot(msg: Message, segmentSize = 0): MessageBuilder {
  const b =
    segmentSize > 0
      ? new MessageBuilder({
          firstWords: segmentSize,
          fixedSegmentGrowth: true,
        })
      : new MessageBuilder();
  const slot = b.rootSlot();
  deepCopyPtrToSlot(b, slot, msg.root(), 0);
  return b;
}

function buildFlatSingleSegment(msg: Message): Uint8Array {
  const b = new MessageBuilder({ forceSingle: true });
  const slot = b.rootSlot();
  deepCopyPtrToSlot(b, slot, msg.root(), 0);
  return b.segmentData(0).slice();
}

/** Write one `Message` in `to` format. */
export function writeMessageInFormat(
  msg: Message,
  to: WireFormat,
  rootSchema?: StructSchema,
  opts?: WriteFormatOptions,
): Uint8Array {
  const pretty = !(opts?.short ?? false);
  const segSize = opts?.segmentSize ?? 0;

  switch (to) {
    case "binary":
      return rebuildMessageRoot(msg, segSize).toFlat();
    case "packed":
      return pack(rebuildMessageRoot(msg, segSize).toFlat(), {
        compactFramed: segSize === 0,
      });
    case "flat":
      return buildFlatSingleSegment(msg);
    case "flat-packed":
      return pack(buildFlatSingleSegment(msg));
    case "canonical":
      return canonicalize(msg);
    case "text": {
      assertCapnp(
        rootSchema !== undefined,
        "ARG",
        "text format requires <schema> and <type>",
      );
      const fresh = Message.fromSegments(msg.segments, {
        traversalWords: 1_073_741_824,
        depthLimit: 256,
      });
      const reader = DynamicStruct.fromMessage(fresh, rootSchema);
      const text = encodeTextBytes(reader, { pretty });
      const out = new Uint8Array(text.byteLength + 1);
      out.set(text);
      out[text.byteLength] = 0x0a;
      return out;
    }
    case "json": {
      assertCapnp(
        rootSchema !== undefined,
        "ARG",
        "json format requires <schema> and <type>",
      );
      const fresh = Message.fromSegments(msg.segments, {
        traversalWords: 1_073_741_824,
        depthLimit: 256,
      });
      const reader = DynamicStruct.fromMessage(fresh, rootSchema);
      const json = encodeJsonBytes(reader, {
        pretty,
        annotations: opts?.annotations ?? true,
      });
      const out = new Uint8Array(json.byteLength + 1);
      out.set(json);
      out[json.byteLength] = 0x0a;
      return out;
    }
  }
}

/**
 * Convert a stream as `capnp convert` does, writing each message before the
 * next is read. An error capnp recovers from is reported after the message
 * it belongs to and makes the result 1. Other errors are thrown, after the
 * messages before them were written.
 */
function writeConvertedStream(
  input: Uint8Array,
  from: WireFormat,
  to: WireFormat,
  rootSchema: StructSchema | undefined,
  opts: WriteFormatOptions,
  writeOut: (chunk: Uint8Array) => void,
  writeErr: (message: string) => void,
): number {
  let status = 0;
  for (const { message, error } of iterateMessagesInFormat(input, from, rootSchema, {
    recover: true,
  })) {
    writeOut(writeMessageInFormat(message, to, rootSchema, opts));
    if (error !== undefined) {
      writeErr(
        "*** ERROR CONVERTING PREVIOUS MESSAGE ***\n" +
          "The following error occurred while converting the message above.\n" +
          "This probably means the input data is invalid/corrupted.\n" +
          `Exception description: ${error.description}\n` +
          `Code location: ${error.location}\n` +
          "*** END ERROR ***",
      );
      status = 1;
    }
  }
  return status;
}

/** Convert a stream buffer from `from` format to `to` format. */
export function convertStream(
  input: Uint8Array,
  from: WireFormat,
  to: WireFormat,
  rootSchema?: StructSchema,
  opts?: WriteFormatOptions,
): Uint8Array {
  const messages = readMessagesInFormat(input, from, rootSchema);
  // capnp writes one flat or canonical message after another. A multi-message
  // stream is the concatenation of those single-segment bodies.
  const chunks = messages.map((m) =>
    writeMessageInFormat(m, to, rootSchema, opts),
  );
  return concatBytes(chunks);
}

// ---------------------------------------------------------------------------
// Schema file compilation / CGR loading
// ---------------------------------------------------------------------------

export interface SchemaLoadOptions {
  importPaths?: readonly string[];
  noStandardImport?: boolean;
  cgr?: boolean;
}

function findCapnpStandardInclude(): string | null {
  const whichProc = spawnSync("which", ["capnp"], { encoding: "utf-8" });
  if (whichProc.status !== 0 || !whichProc.stdout) return null;
  const binPath = whichProc.stdout.trim();
  if (!binPath) return null;
  const candidate = resolve(dirname(binPath), "..", "include");
  return existsSync(joinPath(candidate, "capnp", "schema.capnp"))
    ? candidate
    : null;
}

function joinPath(...parts: string[]): string {
  return resolve(...parts);
}

export function loadSchemaFromFile(
  schemaPath: string,
  opts?: SchemaLoadOptions,
): { loader: SchemaLoader; fileId: bigint | undefined } {
  const useCgr =
    (opts?.cgr ?? false) ||
    schemaPath.endsWith(".cgr.bin") ||
    schemaPath.endsWith(".cgr");

  if (useCgr) {
    const bytes = new Uint8Array(readFileSync(schemaPath));
    const loader = SchemaLoader.fromCgr(bytes);
    return { loader, fileId: loader.requestedFiles()[0]?.id };
  }

  const args: string[] = ["compile", "-o-"];
  if (opts?.noStandardImport) {
    args.push("--no-standard-import");
  }
  for (const dir of opts?.importPaths ?? []) {
    args.push(`-I${dir}`);
  }
  if (!opts?.noStandardImport) {
    const envInc = findCapnpStandardInclude();
    if (envInc) {
      args.push(`-I${envInc}`);
    }
  }
  args.push(schemaPath);

  const proc = spawnSync("capnp", args, {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.error) {
    throw new CapnpError(
      "UNSUPPORTED",
      `failed to execute 'capnp compile': ${proc.error.message}`,
    );
  }
  if (proc.status !== 0) {
    const errText = proc.stderr ? proc.stderr.toString("utf-8").trim() : "";
    throw new CapnpError(
      "ARG",
      errText || `capnp compile exited with status ${proc.status}`,
    );
  }

  const loader = SchemaLoader.fromCgr(new Uint8Array(proc.stdout));
  return { loader, fileId: loader.requestedFiles()[0]?.id };
}

// ---------------------------------------------------------------------------
// `eval` expression evaluation (models CompilerMain::evalConst)
// ---------------------------------------------------------------------------

interface EvalNamePart {
  readonly ident: string;
  readonly subscripts: readonly number[];
}

function parseEvalPath(expr: string): EvalNamePart[] {
  const trimmed = expr.trim();
  assertCapnp(
    trimmed.length > 0 && !trimmed.endsWith("."),
    "ARG",
    "invalid eval syntax",
  );
  const rawSegments = trimmed.split(".");
  const parts: EvalNamePart[] = [];

  for (const seg of rawSegments) {
    assertCapnp(seg.length > 0, "ARG", "invalid eval syntax");
    const m = /^([A-Za-z_][A-Za-z0-9_]*)((?:\[[0-9]+\])*)$/.exec(seg);
    assertCapnp(m !== null, "ARG", `invalid eval syntax in '${seg}'`);
    const ident = m[1]!;
    const subsRaw = m[2]!;
    const subscripts: number[] = [];
    if (subsRaw.length > 0) {
      const re = /\[([0-9]+)\]/g;
      let sm: RegExpExecArray | null;
      while ((sm = re.exec(subsRaw)) !== null) {
        subscripts.push(Number.parseInt(sm[1]!, 10));
      }
    }
    parts.push({ ident, subscripts });
  }
  return parts;
}

export function evaluateSchemaPath(
  loader: SchemaLoader,
  expr: string,
  fileId?: bigint,
): { value: DynamicValueReader; type: Type } {
  const parts = parseEvalPath(expr);
  assertCapnp(parts.length > 0, "ARG", "invalid eval syntax");

  let scopeId =
    fileId ??
    loader.requestedFiles()[0]?.id ??
    loader.allNodes().find((n) => n.which === "file")?.id;
  assertCapnp(scopeId !== undefined, "ARG", "no file scope loaded for eval");

  let pos = 0;
  let stoppedAtSubscript = false;
  for (; pos < parts.length; pos++) {
    const childId = loader.lookupChild(scopeId, parts[pos]!.ident);
    if (childId !== null) {
      scopeId = childId;
      if (parts[pos]!.subscripts.length > 0) {
        stoppedAtSubscript = true;
        break;
      }
    } else {
      break;
    }
  }

  const declSchema = loader.get(scopeId);
  let value: DynamicValueReader;
  let valueType: Type;

  if (declSchema.which === "const") {
    const c = declSchema.asConst();
    value = DynamicValue.fromConst(c);
    valueType = c.getType();
  } else if (declSchema.which === "struct") {
    if (pos === parts.length) {
      throw new CapnpError(
        "ARG",
        `'${declSchema.getShortDisplayName()}' cannot be evaluated.`,
      );
    }
    const st = declSchema.asStruct();
    value = DynamicValueReader.fromStruct(DynamicStruct.empty(st));
    valueType = st.asType();
  } else {
    if (stoppedAtSubscript) {
      throw new CapnpError(
        "ARG",
        `'${declSchema.getShortDisplayName()}' is not a list.`,
      );
    }
    if (pos < parts.length) {
      throw new CapnpError("ARG", `'${parts[pos]!.ident}' is not defined.`);
    }
    throw new CapnpError(
      "ARG",
      `'${declSchema.getShortDisplayName()}' cannot be evaluated.`,
    );
  }

  for (; pos < parts.length; pos++) {
    const part = parts[pos]!;
    if (!stoppedAtSubscript) {
      const prevName = pos > 0 ? parts[pos - 1]!.ident : declSchema.getShortDisplayName();
      assertCapnp(
        value.getType() === DynamicValueType.STRUCT,
        "ARG",
        `'${prevName}' is not a struct.`,
      );
      const st = value.asStruct();
      const field = st.getSchema().findFieldByName(part.ident);
      assertCapnp(
        field !== null,
        "ARG",
        `'${prevName}' has no member '${part.ident}'.`,
      );
      value = st.get(field);
      valueType = field.getType();
    }

    for (let i = 0; i < part.subscripts.length; i++) {
      const sub = part.subscripts[i]!;
      assertCapnp(
        value.getType() === DynamicValueType.LIST,
        "ARG",
        `'${part.ident}' is not a list.`,
      );
      const lv = value.asList();
      assertCapnp(
        sub >= 0 && sub < lv.size(),
        "BOUNDS",
        `'${part.ident}[${part.subscripts.slice(0, i + 1).join("][")}]' is out-of-bounds.`,
      );
      value = lv.get(sub);
      valueType = valueType.asList().getElementType();
    }

    stoppedAtSubscript = false;
  }

  return { value, type: valueType };
}

export function formatEvaluatedValue(
  value: DynamicValueReader,
  type: Type,
  format: WireFormat,
  opts?: WriteFormatOptions,
): Uint8Array {
  const pretty = !(opts?.short ?? false);
  if (format === "text") {
    const codec = new TextCodec({ prettyPrint: pretty });
    const text = codec.encodeBytes(value, type);
    const out = new Uint8Array(text.byteLength + 1);
    out.set(text);
    out[text.byteLength] = 0x0a;
    return out;
  }

  assertCapnp(
    value.getType() === DynamicValueType.STRUCT,
    "ARG",
    `not a struct; '${format}' output is only available on structs`,
  );
  const st: DynamicStructReader = value.asStruct();
  const b = new MessageBuilder();
  setDynamicRoot(b, st);
  const msg = Message.fromFlat(b.toFlat(), {
    traversalWords: 1_073_741_824,
    depthLimit: 256,
  });
  return writeMessageInFormat(msg, format, st.getSchema(), opts);
}

// ---------------------------------------------------------------------------
// CLI Argument Parser & Entry Point
// ---------------------------------------------------------------------------

export interface CliIo {
  stdin?: Uint8Array;
  stdout?: (chunk: Uint8Array) => void;
  stderr?: (message: string) => void;
}

const HELP_TEXT = `Usage: capnp-ts <command> [<option>...] [<arg>...]

Commands:
  encode   Encode text-format Cap'n Proto messages from stdin to binary.
  decode   Decode binary Cap'n Proto messages from stdin to text format.
  convert  Convert messages between binary, packed, flat, flat-packed, canonical, text, and json.
  eval     Evaluate a const or field default expression from a schema.

Options (the commands that accept each one are in brackets):
  -I<dir>, --import-path=<dir>   Add import search directory for .capnp files
  --no-standard-import           Disable default import search paths
  --cgr                          Treat <schema> as a precompiled CodeGeneratorRequest
  -p, --packed                   Use packed framing [encode, decode, eval]
  --flat                         Use single-segment unframed format [encode, decode, eval]
  -b, --binary                   Output standard binary format [eval]
  -o<fmt>, --output=<fmt>        Output format [eval] (default: text)
  --short                        Single-line compact output for text or json [decode, convert, eval]
  --segment-size=<n>             Max words per builder segment [encode, convert]
  --quiet                        Skip the input format plausibility check [decode, convert]
  --verbose                      Accepted for compatibility; has no effect
  --help                         Show help
  --version                      Show version
`;

type CliCommand = "encode" | "decode" | "convert" | "eval";

interface ParsedCliFlags {
  command: CliCommand | null;
  importPaths: string[];
  noStandardImport: boolean;
  cgr: boolean;
  packed: boolean;
  binary: boolean;
  flat: boolean;
  short: boolean;
  quiet: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
  outputFormat: WireFormat | null;
  segmentSize: number;
  positionals: string[];
}

/** A usage error, which capnp reports through kj's `MainBuilder`. */
class CliUsageError extends Error {
  constructor(
    readonly program: string,
    message: string,
  ) {
    super(message);
  }

  render(): string {
    return `${this.program}: ${this.message}\nTry '${this.program} --help' for more information.`;
  }
}

interface CliOption {
  readonly long: string;
  readonly short?: string;
  readonly commands: readonly (CliCommand | null)[] | "all";
  /** Returns an error, as a kj `Validity` would, or null. */
  readonly apply: (res: ParsedCliFlags, arg: string) => string | null;
  readonly takesArg?: boolean;
}

/** strtol(s, &end, 0) with the whole string consumed. */
function parseCInteger(s: string): number | null {
  const m = /^[\t\n\v\f\r ]*([+-]?)(?:0[xX]([0-9a-fA-F]+)|(0[0-7]*)|([1-9][0-9]*))$/.exec(s);
  if (m === null) return null;
  const mag =
    m[2] !== undefined
      ? Number.parseInt(m[2], 16)
      : m[3] !== undefined
        ? Number.parseInt(m[3], 8)
        : Number.parseInt(m[4]!, 10);
  return m[1] === "-" ? -mag : mag;
}

// The option tables of `capnp` 1.4.0 and its subcommands.
const CLI_OPTIONS: readonly CliOption[] = [
  { long: "verbose", commands: "all", apply: (r) => ((r.verbose = true), null) },
  { long: "version", commands: "all", apply: (r) => ((r.version = true), null) },
  {
    long: "import-path",
    short: "I",
    commands: "all",
    takesArg: true,
    apply: (r, dir) => (r.importPaths.push(dir), null),
  },
  {
    long: "no-standard-import",
    commands: "all",
    apply: (r) => ((r.noStandardImport = true), null),
  },
  { long: "cgr", commands: "all", apply: (r) => ((r.cgr = true), null) },
  {
    long: "flat",
    commands: ["encode", "decode", "eval"],
    apply: (r) => {
      if (r.binary) return "cannot be used with --binary";
      r.flat = true;
      return null;
    },
  },
  {
    long: "packed",
    short: "p",
    commands: ["encode", "decode", "eval"],
    apply: (r) => {
      if (r.binary) return "cannot be used with --binary";
      r.packed = true;
      return null;
    },
  },
  {
    long: "binary",
    short: "b",
    commands: ["eval"],
    apply: (r) => {
      if (r.packed) return "cannot be used with --packed";
      if (r.flat) return "cannot be used with --flat";
      r.binary = true;
      return null;
    },
  },
  {
    long: "short",
    commands: ["decode", "convert", "eval"],
    apply: (r) => ((r.short = true), null),
  },
  {
    long: "quiet",
    commands: ["decode", "convert"],
    apply: (r) => ((r.quiet = true), null),
  },
  {
    long: "segment-size",
    commands: ["encode", "convert"],
    takesArg: true,
    apply: (r, raw) => {
      if (r.flat) return "cannot be used with --flat";
      const n = parseCInteger(raw);
      if (n === null) return "not an integer";
      // capnp stores the size in an unsigned int; capnp-ts refuses sizes that would wrap.
      if (n < 0 || n > 0xffffffff) return "out of range";
      r.segmentSize = n;
      return null;
    },
  },
  {
    long: "output",
    short: "o",
    commands: ["eval"],
    takesArg: true,
    apply: (r, name) => {
      const f = parseWireFormat(name);
      if (f === null) return `unknown format: ${name}`;
      r.outputFormat = f;
      return null;
    },
  },
];

const CLI_COMMANDS: readonly CliCommand[] = ["encode", "decode", "convert", "eval"];

/**
 * Parses argv the way kj's `MainBuilder` does: options run in order, each
 * command level has its own option table, and `--help` or `--version` stops
 * parsing at once.
 */
function parseFlags(argv: readonly string[]): ParsedCliFlags {
  const res: ParsedCliFlags = {
    command: null,
    importPaths: [],
    noStandardImport: false,
    cgr: false,
    packed: false,
    binary: false,
    flat: false,
    short: false,
    quiet: false,
    verbose: false,
    help: false,
    version: false,
    outputFormat: null,
    segmentSize: 0,
    positionals: [],
  };
  let program = "capnp-ts";
  const options = () =>
    CLI_OPTIONS.filter((o) => o.commands === "all" || o.commands.includes(res.command));
  const fail = (message: string): never => {
    throw new CliUsageError(program, message);
  };
  const isOptionLike = (s: string) => s.startsWith("-") && s.length > 1;

  for (let i = 0; i < argv.length; i++) {
    const param = argv[i]!;
    if (param === "--") {
      res.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (param.startsWith("--")) {
      const eq = param.indexOf("=");
      const name = eq < 0 ? param.slice(2) : param.slice(2, eq);
      const option = options().find((o) => o.long === name);
      if (option === undefined) {
        if (param === "--help") {
          res.help = true;
          return res;
        }
        fail(`--${name}: unrecognized option`);
      } else if (option.takesArg) {
        let error: string | null;
        if (eq >= 0) {
          error = option.apply(res, param.slice(eq + 1));
          if (error !== null) fail(`${param}: ${error}`);
        } else if (i + 1 < argv.length && !isOptionLike(argv[i + 1]!)) {
          const arg = argv[++i]!;
          error = option.apply(res, arg);
          if (error !== null) fail(`${param}=${arg}: ${error}`);
        } else {
          fail(`--${name}: missing argument`);
        }
      } else if (eq >= 0) {
        fail(`--${name}: option does not accept an argument`);
      } else {
        const error = option.apply(res, "");
        if (error !== null) fail(`${param}: ${error}`);
      }
      if (res.version) return res;
    } else if (isOptionLike(param)) {
      for (let j = 1; j < param.length; j++) {
        const c = param[j]!;
        const option = options().find((o) => o.short === c);
        if (option === undefined) fail(`-${c}: unrecognized option`);
        else if (option.takesArg) {
          let arg: string;
          if (j + 1 < param.length) arg = param.slice(j + 1);
          else if (i + 1 < argv.length && !isOptionLike(argv[i + 1]!)) arg = argv[++i]!;
          else fail(`-${c}: missing argument`);
          const error = option.apply(res, arg!);
          if (error !== null) fail(`-${c} ${arg!}: ${error}`);
          break;
        } else {
          const error = option.apply(res, "");
          if (error !== null) fail(`-${c}: ${error}`);
        }
      }
    } else if (res.command === null) {
      const cmd = CLI_COMMANDS.find((c) => c === param);
      if (cmd !== undefined) {
        res.command = cmd;
        program = `capnp-ts ${cmd}`;
      } else if (param === "help") {
        const topic = argv[i + 1];
        if (topic !== undefined && !CLI_COMMANDS.some((c) => c === topic)) {
          fail(`${topic}: unknown command`);
        }
        res.help = true;
        return res;
      } else {
        fail(`${param}: unknown command`);
      }
    } else {
      res.positionals.push(param);
    }
  }

  if (res.command === null) fail("missing command");
  const titles =
    res.command === "eval"
      ? ["<schema-file>", "<name>"]
      : res.command === "convert"
        ? ["<from>:<to>"]
        : ["<schema-file>", "<type>"];
  const maxArgs = res.command === "convert" ? 3 : 2;
  if (res.positionals.length < titles.length) {
    fail(`missing argument ${titles[res.positionals.length]}`);
  }
  if (res.positionals.length > maxArgs) {
    fail(`${res.positionals[maxArgs]}: too many arguments`);
  }
  return res;
}

function deprecatedFormat(flags: ParsedCliFlags, fallback: WireFormat): WireFormat {
  if (flags.binary) return "binary";
  if (flags.flat && flags.packed) return "flat-packed";
  if (flags.flat) return "flat";
  if (flags.packed) return "packed";
  return fallback;
}

function readStdinSync(): Uint8Array {
  return new Uint8Array(readFileSync(0));
}

/**
 * `capnp` calls `BufferedInputStream::getReadBuffer()` before converting.
 * An empty stream throws "Premature EOF" unless `--quiet` skipped that check.
 */
function assertStdinPresent(input: Uint8Array, quiet: boolean): void {
  if (input.byteLength === 0 && !quiet) {
    throw new CapnpError("FRAMING", "Premature EOF");
  }
}

export async function runCli(
  argv: readonly string[],
  io?: CliIo,
): Promise<number> {
  const writeOut =
    io?.stdout ?? ((chunk: Uint8Array) => process.stdout.write(chunk));
  const writeErr =
    io?.stderr ?? ((msg: string) => process.stderr.write(`${msg}\n`));

  try {
    const flags = parseFlags(argv);
    if (flags.help) {
      writeOut(UTF8_ENC.encode(HELP_TEXT));
      return 0;
    }
    if (flags.version) {
      writeOut(UTF8_ENC.encode("capnp-ts 0.1.0-dev\n"));
      return 0;
    }

    const cmd = flags.command;
    const args = flags.positionals;

    if (cmd === "encode") {
      const to = deprecatedFormat(flags, "binary");
      const { loader, fileId } = loadSchemaFromFile(args[0]!, flags);
      const rootSchema = loader.resolveStruct(args[1]!, fileId);
      const input = io?.stdin ?? readStdinSync();
      assertStdinPresent(input, false);
      return writeConvertedStream(
        input,
        "text",
        to,
        rootSchema,
        { segmentSize: flags.segmentSize },
        writeOut,
        writeErr,
      );
    }

    if (cmd === "decode") {
      const from = deprecatedFormat(flags, "binary");
      const { loader, fileId } = loadSchemaFromFile(args[0]!, flags);
      const rootSchema = loader.resolveStruct(args[1]!, fileId);
      const input = io?.stdin ?? readStdinSync();
      assertStdinPresent(input, flags.quiet);
      return writeConvertedStream(
        input,
        from,
        "text",
        rootSchema,
        { short: flags.short },
        writeOut,
        writeErr,
      );
    }

    if (cmd === "convert") {
      assertCapnp(
        args.length !== 2,
        "ARG",
        "usage: capnp-ts convert [<option>...] <from>:<to> [<schema-file> <type>]",
      );
      const spec = args[0]!;
      const colon = spec.indexOf(":");
      assertCapnp(
        colon > 0 && colon < spec.length - 1,
        "ARG",
        "invalid conversion spec; expected <from>:<to>",
      );
      const from = parseWireFormat(spec.slice(0, colon));
      const to = parseWireFormat(spec.slice(colon + 1));
      assertCapnp(from !== null, "ARG", `unknown format '${spec.slice(0, colon)}'`);
      assertCapnp(to !== null, "ARG", `unknown format '${spec.slice(colon + 1)}'`);

      let rootSchema: StructSchema | undefined;
      if (formatNeedsSchema(from) || formatNeedsSchema(to)) {
        assertCapnp(
          args.length === 3,
          "ARG",
          `conversion '${spec}' requires <schema-file> and <type>`,
        );
        const { loader, fileId } = loadSchemaFromFile(args[1]!, flags);
        rootSchema = loader.resolveStruct(args[2]!, fileId);
      } else if (args.length === 3) {
        const { loader, fileId } = loadSchemaFromFile(args[1]!, flags);
        rootSchema = loader.resolveStruct(args[2]!, fileId);
      }

      const input = io?.stdin ?? readStdinSync();
      assertStdinPresent(input, flags.quiet);
      return writeConvertedStream(
        input,
        from,
        to,
        rootSchema,
        { short: flags.short, segmentSize: flags.segmentSize },
        writeOut,
        writeErr,
      );
    }

    if (cmd === "eval") {
      const outFmt = flags.outputFormat ?? deprecatedFormat(flags, "text");

      const { loader, fileId } = loadSchemaFromFile(args[0]!, flags);
      const { value, type } = evaluateSchemaPath(loader, args[1]!, fileId);
      const out = formatEvaluatedValue(value, type, outFmt, {
        short: flags.short,
        segmentSize: flags.segmentSize,
        // eval drops annotations; convert is what applies $Json names.
        annotations: false,
      });
      writeOut(out);
      return 0;
    }
    throw new Error(`unhandled command '${cmd}'`);
  } catch (err) {
    if (err instanceof CliUsageError) {
      writeErr(err.render());
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    writeErr(`capnp-ts: ${msg}`);
    return 1;
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  return runCli(argv);
}
