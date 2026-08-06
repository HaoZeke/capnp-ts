/**
 * Standalone Cap'n admit (prepare) harness for pure ESM hosts (Bun / Node ≥ 18).
 *
 * Demonstrates how an OMP/Pi extension would call @haozeke/capnp without a
 * native addon. This file is intentionally not a full OMP extension: it has
 * no dependency on @oh-my-pi. When wiring into OMP, wrap admitFromBytes with
 * ExtensionAPI roughly as:
 *
 *   // import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"; // host-only
 *   // export default function (pi: ExtensionAPI) {
 *   //   pi.registerTool({ name: "capnp_admit", execute: async (...) => {
 *   //     const view = admitFromBytes(bytes);
 *   //     return formatAdmitReport(view);
 *   //   }});
 *   // }
 *
 * Prefer schema-typed Message roots from @haozeke/capnp once packages/runtime
 * exports them; the local stream-frame admit below works offline on goldens
 * and on the tiny synthetic frame used when CAPNP_ADMIT_TINY=1.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Production import surface (workspace package). Typed decode of AddressBook
// lands with the runtime Message reader; keep the import side-effect free so
// this stub runs before packages/runtime/src is fully filled in.
// import { Message } from "@haozeke/capnp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const DEFAULT_GOLDEN = join(
  REPO_ROOT,
  "packages/runtime/test/golden/addressbook.bin",
);

/** Zero-copy-ish view of an admitted stream-framed Cap'n message. */
export type AdmitView = {
  source: string;
  segmentCount: number;
  segmentWordCounts: number[];
  /** Concatenated segment payload (no stream header). */
  payload: Uint8Array;
  /** Null-terminated Text blobs found in payload (stub field dump). */
  texts: string[];
  /** Optional structured hints when the AddressBook golden is recognized. */
  addressBookHint?: {
    people: Array<{ id?: number; name?: string; email?: string }>;
  };
};

/**
 * Parse Cap'n Proto stream framing (encoding.html "Packing" / serialization
 * segment table) and return segment payloads.
 *
 * Layout: uint32 LE (segmentCount - 1), then segmentCount × uint32 LE word
 * sizes, pad to 8-byte boundary if segmentCount is even, then raw segments.
 */
export function parseStreamFrame(buf: Uint8Array): {
  segmentCount: number;
  segments: Uint8Array[];
} {
  if (buf.byteLength < 8) {
    throw new Error(`admit: frame too short (${buf.byteLength} bytes)`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const segmentCount = view.getUint32(0, true) + 1;
  let offset = 4;
  const wordCounts: number[] = [];
  for (let i = 0; i < segmentCount; i++) {
    if (offset + 4 > buf.byteLength) {
      throw new Error("admit: truncated segment table");
    }
    wordCounts.push(view.getUint32(offset, true));
    offset += 4;
  }
  // Pad segment table to word boundary when segmentCount is even
  // (table entries = 1 + segmentCount; odd total needs pad).
  if ((segmentCount + 1) % 2 !== 0) {
    offset += 4;
  }
  const segments: Uint8Array[] = [];
  for (const words of wordCounts) {
    const nbytes = words * 8;
    if (offset + nbytes > buf.byteLength) {
      throw new Error(
        `admit: segment overrun (need ${nbytes} at ${offset}, have ${buf.byteLength})`,
      );
    }
    segments.push(buf.subarray(offset, offset + nbytes));
    offset += nbytes;
  }
  return { segmentCount, segments };
}

/** Scan segment bytes for printable null-terminated C strings (Text payloads). */
export function scanTexts(payload: Uint8Array): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < payload.byteLength) {
    // Skip pure zero runs
    if (payload[i] === 0) {
      i++;
      continue;
    }
    // Candidate start of printable ASCII run ending at NUL
    if (payload[i]! >= 0x20 && payload[i]! < 0x7f) {
      let j = i;
      while (j < payload.byteLength && payload[j]! >= 0x20 && payload[j]! < 0x7f) {
        j++;
      }
      if (j < payload.byteLength && payload[j] === 0 && j - i >= 2) {
        out.push(new TextDecoder().decode(payload.subarray(i, j)));
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

/**
 * Build a tiny single-segment stream-framed message: root struct with one
 * Text pointer holding `text` (null-terminated list of bytes).
 *
 * Wire-valid enough for admit framing + Text scan; not a substitute for the
 * runtime builder.
 */
export function buildTinyFramedText(text: string): Uint8Array {
  const encoded = new TextEncoder().encode(text);
  // List element count includes trailing NUL for Text.
  const elemCount = encoded.byteLength + 1;
  const textWords = Math.ceil(elemCount / 8);
  // Segment: root struct ptr | text list ptr | text data words
  const segWords = 1 + 1 + textWords;
  const headerWords = 2; // count-1 + size (even entry count → no pad)
  const out = new Uint8Array((headerWords + segWords) * 8);
  const dv = new DataView(out.buffer);
  // Stream header: 1 segment, segWords words
  dv.setUint32(0, 0, true); // segmentCount - 1
  dv.setUint32(4, segWords, true);
  // Root struct pointer @ word 0 of segment: offset 0, dataWords=0, ptrs=1
  // A=0, B=0, C=0, D=1 → (1n << 48n)
  const root = 1n << 48n;
  dv.setBigUint64(8, root, true);
  // Text list pointer @ word 1: A=1, B=0, C=2 (1-byte), D=elemCount
  const listPtr = 1n | (2n << 32n) | (BigInt(elemCount) << 48n);
  dv.setBigUint64(16, listPtr, true);
  // Text bytes + NUL, rest already zero
  out.set(encoded, 24);
  return out;
}

function concatSegments(segments: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const s of segments) n += s.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const s of segments) {
    out.set(s, o);
    o += s.byteLength;
  }
  return out;
}

/**
 * Hint AddressBook fields from the Alice/Bob golden Text layout.
 * Full schema-typed decode belongs in @haozeke/capnp + codegen.
 */
function hintAddressBook(texts: string[]): AdmitView["addressBookHint"] {
  const nameEmail = new Map<string, string>();
  const names = ["Alice", "Bob"];
  for (const name of names) {
    const email = texts.find((t) => t.startsWith(name.toLowerCase() + "@"));
    if (email) nameEmail.set(name, email);
  }
  if (nameEmail.size === 0) return undefined;
  const people: Array<{ id?: number; name?: string; email?: string }> = [];
  if (nameEmail.has("Alice")) {
    people.push({ id: 123, name: "Alice", email: nameEmail.get("Alice") });
  }
  if (nameEmail.has("Bob")) {
    people.push({ id: 456, name: "Bob", email: nameEmail.get("Bob") });
  }
  // Phones / schools also appear as Text; list under people context loosely
  return { people };
}

/** Admit (prepare) a Cap'n stream-framed buffer for inspection. */
export function admitFromBytes(
  buf: Uint8Array,
  source = "<buffer>",
): AdmitView {
  const { segmentCount, segments } = parseStreamFrame(buf);
  const payload = concatSegments(segments);
  const texts = scanTexts(payload);
  const addressBookHint = hintAddressBook(texts);
  return {
    source,
    segmentCount,
    segmentWordCounts: segments.map((s) => s.byteLength / 8),
    payload,
    texts,
    addressBookHint,
  };
}

export function formatAdmitReport(view: AdmitView): string {
  const lines: string[] = [
    `admit source: ${view.source}`,
    `segments: ${view.segmentCount} (words: ${view.segmentWordCounts.join(", ")})`,
    `payload bytes: ${view.payload.byteLength}`,
    `texts (${view.texts.length}):`,
    ...view.texts.map((t) => `  - ${JSON.stringify(t)}`),
  ];
  if (view.addressBookHint) {
    lines.push("addressBook hint (golden layout):");
    for (const p of view.addressBookHint.people) {
      lines.push(
        `  person id=${p.id ?? "?"} name=${p.name ?? "?"} email=${p.email ?? "?"}`,
      );
    }
  }
  lines.push(
    "note: pure ESM admit path; no native addon. Schema-typed getters via @haozeke/capnp + capnpc-ts.",
  );
  return lines.join("\n");
}

function loadInput(): { buf: Uint8Array; source: string } {
  if (process.env.CAPNP_ADMIT_TINY === "1") {
    const buf = buildTinyFramedText("admit-ok");
    return { buf, source: "<tiny-framed admit-ok>" };
  }
  const path = process.env.CAPNP_ADMIT_BIN ?? DEFAULT_GOLDEN;
  if (!existsSync(path)) {
    // Fall back to tiny frame when golden is missing (shallow clone / CI skip).
    const buf = buildTinyFramedText("admit-ok");
    console.error(
      `admit-harness: golden not found at ${path}; using tiny framed message`,
    );
    return { buf, source: "<tiny-framed admit-ok>" };
  }
  const buf = new Uint8Array(readFileSync(path));
  return { buf, source: path };
}

function main(): void {
  const { buf, source } = loadInput();
  const view = admitFromBytes(buf, source);
  console.log(formatAdmitReport(view));
}

// Run when executed as a script (Bun / node --experimental-strip-types).
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  main();
}
