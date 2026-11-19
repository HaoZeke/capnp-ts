import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MessageBuilder } from "../src/builder.ts";
import {
  canonicalize,
  canonicalizeFlat,
  messageFromRawSegment,
} from "../src/canonical.ts";
import { deepCopyPtrToSlot } from "../src/copy.ts";
import { storeU32, storeU64 } from "../src/endian.ts";
import { ElemSize } from "../src/kinds.ts";
import { Message } from "../src/message.ts";
import { wpMakeStruct } from "../src/pointer.ts";

const goldenDir = join(dirname(fileURLToPath(import.meta.url)), "golden");
const hasCapnp = spawnSync("capnp", ["--version"]).status === 0;

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

  test("zero-word nested lists point at the preorder segment cursor", () => {
    const tmp = new MessageBuilder();
    const holder = tmp.initRoot(0, 3);
    holder.initPrimList(0, ElemSize.FourBytes, 2, 4, new Uint8Array([1, 0, 0, 0, 2, 0, 0, 0]));
    holder.initPrimList(1, ElemSize.FourBytes, 0, 4);
    holder.initPrimList(2, ElemSize.FourBytes, 1, 4, new Uint8Array([3, 0, 0, 0]));
    const srcRoot = Message.fromFlat(tmp.toFlat()).root();

    const b2 = new MessageBuilder();
    const r2 = b2.initRoot(0, 1);
    const slots = r2.initPointerList(0, 3);
    deepCopyPtrToSlot(b2, slots.add(0), srcRoot.getP(0), 0);
    deepCopyPtrToSlot(b2, slots.add(1), srcRoot.getP(1), 0);
    deepCopyPtrToSlot(b2, slots.add(2), srcRoot.getP(2), 0);

    const canon = canonicalizeFlat(b2.toFlat());
    // Middle empty list slot sits at word 3; after [1,2] allocates word 5, cursor is 6 -> offset = 6 - 3 - 1 = 2 (byte0 = 9)
    expect(canon[3 * 8]).toBe(9);

    if (hasCapnp) {
      const cli = spawnSync("capnp", ["convert", "binary:canonical"], {
        input: b2.toFlat(),
      });
      expect(cli.status).toBe(0);
      expect(canon).toEqual(new Uint8Array(cli.stdout));
      const checkValid = spawnSync("capnp", ["convert", "canonical:binary"], {
        input: canon,
      });
      expect(checkValid.status).toBe(0);
    }
  });
});
