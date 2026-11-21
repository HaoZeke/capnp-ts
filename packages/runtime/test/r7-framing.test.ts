/**
 * Reader checks against capnp-C++ 1.4.0: short frames, bounds order, list kind.
 */
import { describe, expect, test } from "bun:test";
import { ElemSize, Message, isCanonical, wpMakeList, wpMakeStruct } from "../src/index.ts";

function words(...ws: bigint[]): Uint8Array {
  const b = new Uint8Array(ws.length * 8);
  for (let i = 0; i < ws.length; i++) {
    const v = ws[i]!;
    const o = i * 8;
    for (let k = 0; k < 8; k++) b[o + k] = Number((v >> BigInt(k * 8)) & 0xffn);
  }
  return b;
}

describe("reader edges against capnp 1.4.0", () => {
  test("fewer than 8 bytes is an empty message", () => {
    expect(isCanonical(Message.fromFlat(new Uint8Array(0)))).toBe(false);
    expect(isCanonical(Message.fromFlat(new Uint8Array([1, 2, 3, 4, 5, 6, 7])))).toBe(false);
    expect(() => Message.fromFlat(new Uint8Array([1, 2, 3])).root()).toThrow(
      "expected segment != nullptr && segment->checkObject(segment->getStartPtr(), ONE * WORDS); Message did not contain a root pointer.",
    );
  });

  test("a truncated huge segment ends prematurely before the size check", () => {
    const buf = new Uint8Array(8);
    const sz = 9_000_000;
    buf[4] = sz & 0xff;
    buf[5] = (sz >>> 8) & 0xff;
    buf[6] = (sz >>> 16) & 0xff;
    buf[7] = (sz >>> 24) & 0xff;
    expect(() => Message.fromFlat(buf)).toThrow(/ends prematurely in first segment/);
  });

  test("an inline composite whose elements overrun reports that sentence", () => {
    const msg = Message.fromSegments([
      words(wpMakeList(0, ElemSize.Composite, 2), wpMakeStruct(9, 2, 0), 0n, 0n),
    ]);
    expect(() => msg.root()).toThrow(/INLINE_COMPOSITE list's elements overrun its word count/);
  });

  test("an out-of-bounds list reports bounds before the traversal limit", () => {
    const msg = Message.fromSegments([words(wpMakeList(0, ElemSize.Byte, 100_000_000))]);
    expect(() => msg.root()).toThrow(/out-of-bounds list pointer/);
  });

  test("a non-list root read as a list names the list mismatch before bounds", () => {
    const huge = Message.fromSegments([words(0x1000n << 32n)]);
    expect(() => huge.root("list")).toThrow(/non-list pointer where list pointer was expected/);
  });
});
