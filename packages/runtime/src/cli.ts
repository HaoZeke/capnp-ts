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
import { canonicalize, isCanonical, messageFromRawSegment } from "./canonical.ts";
import { deepCopyPtrToSlot } from "./copy.ts";
import {
  DynamicStruct,
  DynamicStructReader,
  DynamicValue,
  DynamicValueReader,
  DynamicValueType,
  setDynamicRoot,
} from "./dynamic.ts";
import { loadU32 } from "./endian.ts";
import { CapnpError, MAX_SEGMENTS, WORD_BYTES, assertCapnp } from "./kinds.ts";
import { decodeJson, encodeJson, splitJsonMessages } from "./json.ts";
import { Message } from "./message.ts";
import { pack, unpack } from "./packed.ts";
import { SchemaLoader, StructSchema, Type } from "./schema.ts";
import {
  decodeText,
  encodeText,
  prettyPrint,
  splitTextMessages,
  stringify,
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

/**
 * Split a concatenated stream of framed Cap'n Proto binary messages into
 * individual `Message` readers.
 */
export function splitFramedMessages(input: Uint8Array): Message[] {
  const out: Message[] = [];
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
    out.push(
      Message.fromFlat(input.subarray(offset, offset + frameBytes), {
        traversalWords: 1_073_741_824,
        depthLimit: 256,
      }),
    );
    offset += frameBytes;
  }
  return out;
}

/** Read zero or more messages from `input` in `from` format. */
export function readMessagesInFormat(
  input: Uint8Array,
  from: WireFormat,
  rootSchema?: StructSchema,
): Message[] {
  if (input.byteLength === 0) return [];

  switch (from) {
    case "binary":
      return splitFramedMessages(input);
    case "packed":
      return splitFramedMessages(unpack(input, { maxWords: 1_073_741_824 }));
    case "flat": {
      const wordBytes = (input.byteLength >>> 3) * WORD_BYTES;
      assertCapnp(wordBytes > 0, "FRAMING", "flat input shorter than one word");
      return [
        Message.fromSegments([input.subarray(0, wordBytes)], {
          traversalWords: 1_073_741_824,
          depthLimit: 256,
        }),
      ];
    }
    case "flat-packed": {
      const raw = unpack(input, { maxWords: 1_073_741_824 });
      return [messageFromRawSegment(raw)];
    }
    case "canonical": {
      const wordBytes = (input.byteLength >>> 3) * WORD_BYTES;
      assertCapnp(
        wordBytes > 0 && wordBytes === input.byteLength,
        "CANONICAL",
        "canonical input must be non-empty and word-aligned",
      );
      const msg = Message.fromSegments([input.subarray(0, wordBytes)], {
        traversalWords: 1_073_741_824,
        depthLimit: 256,
      });
      assertCapnp(
        isCanonical(msg),
        "CANONICAL",
        "input message is not in canonical form",
      );
      return [msg];
    }
    case "text": {
      assertCapnp(
        rootSchema !== undefined,
        "ARG",
        "text format requires <schema> and <type>",
      );
      const slices = splitTextMessages(UTF8_DEC.decode(input));
      return slices.map((s) => decodeText(s, rootSchema));
    }
    case "json": {
      assertCapnp(
        rootSchema !== undefined,
        "ARG",
        "json format requires <schema> and <type>",
      );
      const slices = splitJsonMessages(UTF8_DEC.decode(input));
      return slices.map((s) => decodeJson(s, rootSchema));
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
      return UTF8_ENC.encode(`${encodeText(reader, { pretty })}\n`);
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
      return UTF8_ENC.encode(
        `${encodeJson(reader, {
          pretty,
          annotations: opts?.annotations ?? true,
        })}\n`,
      );
    }
  }
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
    if (pretty && value.getType() === DynamicValueType.STRUCT) {
      return UTF8_ENC.encode(`${prettyPrint(value.asStruct())}\n`);
    }
    if (pretty && value.getType() === DynamicValueType.LIST) {
      return UTF8_ENC.encode(`${prettyPrint(value.asList())}\n`);
    }
    return UTF8_ENC.encode(`${stringify(value, type)}\n`);
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

Common options:
  -I<dir>, --import-path=<dir>   Add import search directory for .capnp files
  --no-standard-import           Disable default import search paths
  --cgr                          Treat <schema> as a precompiled CodeGeneratorRequest
  -p, --packed                   Use packed framing (encode, decode, eval)
  -b, --binary                   Output standard binary format (eval)
  --flat                         Use single-segment unframed format (encode, decode, eval)
  -o<fmt>, --output=<fmt>        Output format for eval (default: text)
  --short                        Single-line compact output for text or json
  --segment-size=<n>             Max words per builder segment for binary/packed output
  -q, --quiet                    Suppress format warnings
  -v, --verbose                  Verbose diagnostics
  -h, --help                     Show help
  --version                      Show version
`;

interface ParsedCliFlags {
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
  outputFormat: string | null;
  segmentSize: number;
  segmentSizeSet: boolean;
  positionals: string[];
}

function parseFlags(argv: readonly string[]): ParsedCliFlags {
  const res: ParsedCliFlags = {
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
    segmentSizeSet: false,
    positionals: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      res.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h" || arg === "--help") {
      res.help = true;
    } else if (arg === "--version") {
      res.version = true;
    } else if (arg === "-p" || arg === "--packed") {
      res.packed = true;
    } else if (arg === "-b" || arg === "--binary") {
      res.binary = true;
    } else if (arg === "--flat") {
      res.flat = true;
    } else if (arg === "--short") {
      res.short = true;
    } else if (arg === "-q" || arg === "--quiet") {
      res.quiet = true;
    } else if (arg === "-v" || arg === "--verbose") {
      res.verbose = true;
    } else if (arg === "--cgr") {
      res.cgr = true;
    } else if (arg === "--no-standard-import") {
      res.noStandardImport = true;
    } else if (arg.startsWith("-I")) {
      const val = arg.length > 2 ? arg.slice(2) : argv[++i];
      assertCapnp(!!val, "ARG", "missing directory for -I");
      res.importPaths.push(val);
    } else if (arg.startsWith("--import-path=")) {
      res.importPaths.push(arg.slice("--import-path=".length));
    } else if (arg === "--import-path") {
      const val = argv[++i];
      assertCapnp(!!val, "ARG", "missing directory for --import-path");
      res.importPaths.push(val);
    } else if (arg.startsWith("-o")) {
      const val = arg.length > 2 ? arg.slice(2) : argv[++i];
      assertCapnp(!!val, "ARG", "missing format for -o");
      res.outputFormat = val;
    } else if (arg.startsWith("--output=")) {
      res.outputFormat = arg.slice("--output=".length);
    } else if (arg === "--output") {
      const val = argv[++i];
      assertCapnp(!!val, "ARG", "missing format for --output");
      res.outputFormat = val;
    } else if (arg.startsWith("--segment-size=") || arg === "--segment-size") {
      const raw =
        arg === "--segment-size"
          ? argv[++i]
          : arg.slice("--segment-size=".length);
      assertCapnp(raw !== undefined, "ARG", "missing value for --segment-size");
      const n = Number.parseInt(raw, 10);
      assertCapnp(
        Number.isInteger(n) && n >= 0 && String(n) === raw,
        "ARG",
        `invalid --segment-size '${raw}'`,
      );
      res.segmentSize = n;
      res.segmentSizeSet = true;
    } else if (arg.startsWith("-")) {
      throw new CapnpError("ARG", `unknown flag '${arg}'`);
    } else {
      res.positionals.push(arg);
    }
  }

  return res;
}

function resolveDeprecatedFormat(
  flags: ParsedCliFlags,
  fallback: WireFormat,
): WireFormat {
  if (flags.binary && (flags.packed || flags.flat)) {
    throw new CapnpError("ARG", "--binary cannot be combined with --packed or --flat");
  }
  if (flags.flat && flags.segmentSizeSet) {
    throw new CapnpError("ARG", "--segment-size cannot be combined with --flat");
  }
  if (flags.binary) return "binary";
  if (flags.flat && flags.packed) return "flat-packed";
  if (flags.flat) return "flat";
  if (flags.packed) return "packed";
  return fallback;
}

function rejectUnsupportedFlags(
  cmd: string,
  checks: ReadonlyArray<readonly [boolean, string]>,
): void {
  for (const [present, flag] of checks) {
    assertCapnp(!present, "ARG", `${cmd}: ${flag}: unrecognized option`);
  }
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
    if (flags.help || (flags.positionals.length === 0 && !flags.version)) {
      writeOut(UTF8_ENC.encode(HELP_TEXT));
      return flags.help ? 0 : 1;
    }
    if (flags.version) {
      writeOut(UTF8_ENC.encode("capnp-ts 0.1.0-dev\n"));
      return 0;
    }

    const cmd = flags.positionals[0]!;
    const args = flags.positionals.slice(1);

    if (cmd === "help") {
      writeOut(UTF8_ENC.encode(HELP_TEXT));
      return 0;
    }

    if (cmd === "encode") {
      rejectUnsupportedFlags("encode", [
        [flags.short, "--short"],
        [flags.quiet, "--quiet"],
        [flags.binary, "--binary"],
        [flags.outputFormat !== null, "--output"],
      ]);
      assertCapnp(
        args.length === 2,
        "ARG",
        "usage: capnp-ts encode [<option>...] <schema-file> <type>",
      );
      const to = resolveDeprecatedFormat(flags, "binary");
      const { loader, fileId } = loadSchemaFromFile(args[0]!, flags);
      const rootSchema = loader.resolveStruct(args[1]!, fileId);
      const input = io?.stdin ?? readStdinSync();
      assertStdinPresent(input, false);
      const out = convertStream(input, "text", to, rootSchema, {
        segmentSize: flags.segmentSize,
      });
      writeOut(out);
      return 0;
    }

    if (cmd === "decode") {
      rejectUnsupportedFlags("decode", [
        [flags.segmentSizeSet, "--segment-size"],
        [flags.binary, "--binary"],
        [flags.outputFormat !== null, "--output"],
      ]);
      assertCapnp(
        args.length === 2,
        "ARG",
        "usage: capnp-ts decode [<option>...] <schema-file> <type>",
      );
      const from = resolveDeprecatedFormat(flags, "binary");
      const { loader, fileId } = loadSchemaFromFile(args[0]!, flags);
      const rootSchema = loader.resolveStruct(args[1]!, fileId);
      const input = io?.stdin ?? readStdinSync();
      assertStdinPresent(input, flags.quiet);
      const out = convertStream(input, from, "text", rootSchema, {
        short: flags.short,
      });
      writeOut(out);
      return 0;
    }

    if (cmd === "convert") {
      rejectUnsupportedFlags("convert", [
        [flags.packed, "--packed"],
        [flags.flat, "--flat"],
        [flags.binary, "--binary"],
        [flags.outputFormat !== null, "--output"],
      ]);
      assertCapnp(
        args.length === 1 || args.length === 3,
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
      const out = convertStream(input, from, to, rootSchema, {
        short: flags.short,
        segmentSize: flags.segmentSize,
      });
      writeOut(out);
      return 0;
    }

    if (cmd === "eval") {
      rejectUnsupportedFlags("eval", [
        [flags.segmentSizeSet, "--segment-size"],
        [flags.quiet, "--quiet"],
      ]);
      assertCapnp(
        args.length === 2,
        "ARG",
        "usage: capnp-ts eval [<option>...] <schema-file> <name>",
      );
      let outFmt: WireFormat = "text";
      if (flags.outputFormat !== null) {
        const parsed = parseWireFormat(flags.outputFormat);
        assertCapnp(
          parsed !== null,
          "ARG",
          `unknown output format '${flags.outputFormat}'`,
        );
        outFmt = parsed;
      } else {
        outFmt = resolveDeprecatedFormat(flags, "text");
      }

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

    writeErr(`capnp-ts: unknown command '${cmd}'`);
    return 1;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeErr(`capnp-ts: ${msg}`);
    return 1;
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  return runCli(argv);
}
