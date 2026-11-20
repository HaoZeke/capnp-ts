/**
 * Differential cases checked against Cap'n Proto C++ 1.4.0.
 */

import { describe, expect, test } from "bun:test";
import {
  CapnpError,
  ElemSize,
  Message,
  PtrKind,
  canonicalize,
  isCanonical,
  storeU32,
  storeU64,
  unpack,
  wpMakeFar,
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

function chain(depth: number): Uint8Array {
  if (depth === 0) return words(wpMakeStruct(-1, 0, 0));
  const ws: bigint[] = [];
  for (let i = 0; i < depth; i++) ws.push(wpMakeStruct(0, 0, 1));
  ws.push(wpMakeStruct(-1, 0, 0));
  return words(...ws);
}

function walkChain(depthLimit: number, depth: number): void {
  const msg = Message.fromSegments([chain(depth)], { depthLimit });
  let p = msg.root();
  for (let i = 0; i < depth; i++) p = p.getP(0);
  expect(p.kind).toBe(PtrKind.Struct);
}

describe("pointer walks against capnp 1.4.0", () => {
  test("W-04 the nesting limit counts the root pointer", () => {
    expect(() => walkChain(0, 0)).toThrow(CapnpError);
    walkChain(1, 0);
    expect(() => walkChain(1, 1)).toThrow(CapnpError);
    walkChain(2, 1);
    expect(() => walkChain(2, 2)).toThrow(CapnpError);
    walkChain(64, 63);
    expect(() => walkChain(64, 64)).toThrow(CapnpError);
  });

  test("W-05 the root word is charged twice and lists amplify", () => {
    const two = words(
      wpMakeStruct(0, 0, 2),
      wpMakeStruct(1, 1, 0),
      wpMakeStruct(1, 1, 0),
      111n,
      222n,
    );
    const readTwo = (lim: number) => {
      const root = Message.fromSegments([two], { traversalWords: lim }).root();
      return [root.getP(0).getU64(0), root.getP(1).getU64(0)];
    };
    expect(() => readTwo(5)).toThrow(CapnpError);
    expect(readTwo(6)).toEqual([111n, 222n]);

    const voids = words(wpMakeList(0, ElemSize.Void, 100));
    expect(() => Message.fromSegments([voids], { traversalWords: 101 }).root()).toThrow(
      CapnpError,
    );
    expect(Message.fromSegments([voids], { traversalWords: 102 }).root().count).toBe(100);

    const empty = words(wpMakeList(0, ElemSize.Composite, 0), wpMakeStruct(100, 0, 0));
    expect(() => Message.fromSegments([empty], { traversalWords: 102 }).root()).toThrow(
      CapnpError,
    );
    expect(Message.fromSegments([empty], { traversalWords: 103 }).root().count).toBe(100);
  });

  test("F-01 a second single-far landing is a schema mismatch", () => {
    const chained = Message.fromSegments([
      words(wpMakeFar(false, 0, 1)),
      words(wpMakeFar(false, 0, 2)),
      words(wpMakeStruct(0, 1, 0), 0x5678n),
    ]);
    expect(() => chained.root()).toThrow(/non-struct pointer/);
    expect(() => Message.fromSegments([words(wpMakeFar(false, 0, 0))]).root()).toThrow(
      /non-struct pointer/,
    );
  });

  test("F-02 a far landing on a zero word is an empty struct", () => {
    const root = Message.fromSegments([words(wpMakeFar(false, 1, 0), 0n)]).root();
    expect(root.isNull).toBe(false);
    expect(root.kind).toBe(PtrKind.Struct);
    expect(root.dwords).toBe(0);
    expect(root.pwords).toBe(0);
  });

  test("F-03 far hops do not consume a nesting level", () => {
    const farRoot = Message.fromSegments(
      [words(wpMakeFar(false, 0, 1)), words(wpMakeStruct(0, 1, 0), 99n)],
      { depthLimit: 1 },
    );
    expect(farRoot.root().getU64(0)).toBe(99n);
    const child = [
      words(wpMakeStruct(0, 0, 1), wpMakeFar(false, 0, 1)),
      words(wpMakeStruct(0, 1, 0), 42n),
    ];
    expect(Message.fromSegments(child, { depthLimit: 2 }).root().getP(0).getU64(0)).toBe(42n);
    expect(() => Message.fromSegments(child, { depthLimit: 1 }).root().getP(0)).toThrow(
      CapnpError,
    );
  });

  test("F-04 a double-far pad may carry the double-far bit", () => {
    const msg = Message.fromSegments([
      words(wpMakeFar(true, 0, 1)),
      words(wpMakeFar(true, 0, 2), wpMakeStruct(0, 1, 0)),
      words(777n),
    ]);
    expect(msg.root().getU64(0)).toBe(777n);
  });
});

describe("packed streams against capnp 1.4.0", () => {
  test("P-01 a zero run may cross segments and stops at the table", () => {
    const crossSeg = unpack(new Uint8Array([0x11, 0x01, 0x02, 0x01, 0x02, 0x00, 0x03]));
    const msg = Message.fromFlat(crossSeg);
    expect(msg.segmentCount).toBe(2);
    expect(msg.segWords(1)).toBe(2);
    expect(() => unpack(new Uint8Array([0x11, 0x03, 0x01, 0x00, 0x02]))).toThrow(
      /segment boundary/,
    );
  });
});

describe("canonical form against capnp 1.4.0", () => {
  test("C-01 bool lists mask leftover high bits", () => {
    const dirty = words(
      wpMakeStruct(0, 0, 1),
      wpMakeList(0, ElemSize.Bit, 3),
      0xffn,
    );
    const src = Message.fromSegments([dirty]);
    expect(isCanonical(src)).toBe(false);
    const out = canonicalize(src);
    expect(out[16]).toBe(0x07);
    expect(isCanonical(Message.fromSegments([out]))).toBe(true);
  });

  test("C-02 isCanonical requires one preorder segment", () => {
    expect(isCanonical(Message.fromSegments([words(0n)]))).toBe(true);
    expect(isCanonical(Message.fromSegments([words(0n), words(0n)]))).toBe(false);
    const far = Message.fromSegments([
      words(wpMakeFar(false, 1, 0), wpMakeStruct(-1, 0, 0)),
    ]);
    expect(isCanonical(far)).toBe(false);
    expect(isCanonical(Message.fromSegments([words(wpMakeStruct(-1, 0, 0))]))).toBe(true);
  });

  test("C-03 a null root canonicalizes to the empty-struct pointer", () => {
    const out = canonicalize(Message.fromSegments([words(0n)]));
    expect(out).toEqual(words(wpMakeStruct(-1, 0, 0)));
  });
});
