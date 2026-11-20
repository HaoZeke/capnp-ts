/**
 * Differential cases checked against Cap'n Proto C++ 1.4.0.
 */

import { describe, expect, test } from "bun:test";
import {
  CapnpError,
  ElemSize,
  Message,
  storeU32,
  storeU64,
  wpMakeList,
  wpMakeStruct,
} from "../src/index.ts";

function words(...ws: bigint[]): Uint8Array {
  const b = new Uint8Array(ws.length * 8);
  for (let i = 0; i < ws.length; i++) storeU64(b, i * 8, ws[i]!);
  return b;
}

describe("text NUL against capnp 1.4.0", () => {
  test("W-01 text requires a trailing NUL", () => {
    const missing = words(
      wpMakeStruct(0, 0, 1),
      wpMakeList(0, ElemSize.Byte, 3),
      0x636261n,
    );
    expect(() => Message.fromSegments([missing]).root().getText(0)).toThrow(CapnpError);
    const zero = words(wpMakeStruct(0, 0, 1), wpMakeList(0, ElemSize.Byte, 0));
    expect(() => Message.fromSegments([zero]).root().getText(0)).toThrow(
      /not NUL-terminated/,
    );
    const ok = words(
      wpMakeStruct(0, 0, 1),
      wpMakeList(0, ElemSize.Byte, 4),
      0x00636261n,
    );
    expect(Message.fromSegments([ok]).root().getText(0)).toBe("abc");
  });
});

describe("stream framing against capnp 1.4.0", () => {
  test("W-02 a stream accepts 511 segments and rejects 512", () => {
    const one = (nsegs: number): Uint8Array => {
      const sizes = new Array<number>(nsegs).fill(0);
      sizes[0] = 1;
      let table = 4 + 4 * nsegs;
      if (table % 8 !== 0) table += 4;
      const out = new Uint8Array(table + 8);
      storeU32(out, 0, nsegs - 1);
      for (let i = 0; i < nsegs; i++) storeU32(out, 4 + 4 * i, sizes[i]!);
      return out;
    };
    expect(Message.fromFlat(one(511)).segmentCount).toBe(511);
    expect(() => Message.fromFlat(one(512))).toThrow(/too many segments/);
  });

  test("W-03 stream framing checks total words against the traversal limit", () => {
    const body = new Uint8Array(20 * 8);
    storeU64(body, 0, wpMakeStruct(0, 1, 0));
    let table = 8;
    const flat = new Uint8Array(table + body.byteLength);
    storeU32(flat, 0, 0);
    storeU32(flat, 4, 20);
    flat.set(body, table);
    expect(() => Message.fromFlat(flat, { traversalWords: 4 })).toThrow(/too large/);
    expect(Message.fromFlat(flat, { traversalWords: 20 }).segmentCount).toBe(1);
  });
});
