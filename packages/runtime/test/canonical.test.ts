import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  canonicalizeFlat,
  messageFromRawSegment,
} from "../src/canonical.ts";
import { storeU32, storeU64 } from "../src/endian.ts";
import { Message } from "../src/message.ts";
import { wpMakeStruct } from "../src/pointer.ts";

const goldenDir = join(dirname(fileURLToPath(import.meta.url)), "golden");

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

describe("capnp canonical form", () => {
  test("canonicalizeFlat(addressbook.bin) equals addressbook.canonical.bin", () => {
    const bin = new Uint8Array(
      readFileSync(join(goldenDir, "addressbook.bin")),
    );
    const golden = new Uint8Array(
      readFileSync(join(goldenDir, "addressbook.canonical.bin")),
    );
    const out = canonicalizeFlat(bin);
    expect(hex(out)).toBe(hex(golden));
    expect(out).toEqual(golden);
  });

  test("canonicalize(Message) matches flat path and golden", () => {
    const bin = new Uint8Array(
      readFileSync(join(goldenDir, "addressbook.bin")),
    );
    const golden = new Uint8Array(
      readFileSync(join(goldenDir, "addressbook.canonical.bin")),
    );
    const msg = Message.fromFlat(bin);
    const out = canonicalize(msg);
    expect(out).toEqual(golden);
  });

  test("idempotent: re-canonicalize of raw segment is stable", () => {
    const bin = new Uint8Array(
      readFileSync(join(goldenDir, "addressbook.bin")),
    );
    const c1 = canonicalizeFlat(bin);
    const c2 = canonicalize(messageFromRawSegment(c1));
    expect(c2).toEqual(c1);
    const c3 = canonicalize(messageFromRawSegment(c2));
    expect(c3).toEqual(c1);
  });

  test("empty struct root encodes as offset -1", () => {
    // Framed: 1 segment of 1 word = empty struct pointer (offset -1).
    const framed = new Uint8Array(16);
    storeU32(framed, 0, 0); // segmentCountMinusOne
    storeU32(framed, 4, 1); // size words
    storeU64(framed, 8, wpMakeStruct(-1, 0, 0));
    const out = canonicalizeFlat(framed);
    expect(out.length).toBe(8);
    expect(out).toEqual(framed.subarray(8, 16));
  });
});
