/**
 * Differential cases checked against Cap'n Proto C++ 1.4.0.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CapnpError,
  DynamicStruct,
  ElemSize,
  JsonCodec,
  Message,
  PtrKind,
  SchemaLoader,
  canonicalize,
  decodeText,
  isCanonical,
  pack,
  storeU32,
  storeU64,
  unpack,
  wpMakeFar,
  wpMakeList,
  wpMakeStruct,
} from "../src/index.ts";

const goldenDir = join(dirname(fileURLToPath(import.meta.url)), "golden");
const kitchen = SchemaLoader.fromCgr(
  new Uint8Array(readFileSync(join(goldenDir, "dynamic-kitchen.cgr.bin"))),
);
const sink = kitchen.resolveStruct("KitchenSink");
const custom = kitchen.resolveStruct("JsonCustom");

function readText(src: string) {
  return DynamicStruct.fromMessage(decodeText(src, sink), sink);
}

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

describe("text format against capnp 1.4.0", () => {
  test("T-01 a single unnamed parenthesized value unwraps", () => {
    expect(readText("(i32 = (5))").get("i32").asInt32()).toBe(5);
    expect(readText("(i32 = ((5)))").get("i32").asInt32()).toBe(5);
    expect(readText("((i8 = 1))").get("i8").asInt8()).toBe(1);
    expect(readText("((i8 = 1),)").get("i8").asInt8()).toBe(1);
    const nums = readText("(defaultNums = [(1), (2)])").get("defaultNums").asList();
    expect(nums.get(0).asInt32()).toBe(1);
    expect(nums.get(1).asInt32()).toBe(2);
    expect(readText('(title = ("hi"))').get("title").asText()).toBe("hi");
    expect(readText("(priority = (high))").get("priority").asEnum().getRaw()).toBe(2);
    expect(readText("(flag = (true))").get("flag").asBool()).toBe(true);
  });

  test("T-02 later field and union assignments win", () => {
    expect(readText("(i32 = 1, i32 = 2)").get("i32").asInt32()).toBe(2);
    const u = readText('(none = void, note = "both")');
    expect(u.which()?.name).toBe("note");
    expect(u.get("note").asText()).toBe("both");
  });

  test("T-03 a non-tuple group value fills the first field", () => {
    expect(readText('(meta = "ada")').get("meta").asStruct().get("author").asText()).toBe("ada");
    expect(() => readText("(meta = 42)")).toThrow(/expected group/);
  });

  test("T-04 a parenthesized integer is a type mismatch for an enum", () => {
    expect(() => readText("(priority = (77))")).toThrow(/Type mismatch/);
    expect(() => readText("(priority = 77)")).toThrow(/Type mismatch/);
  });

  test("T-05 single quotes are a parse error and backticks stay", () => {
    expect(() => readText("(title = 'abc')")).toThrow(/Parse error/);
    expect(() => readText("(raw = 0x'dead')")).toThrow(/Parse error/);
    expect(readText("(title = `hello\n)").get("title").asText()).toBe("hello\n");
  });
});

describe("json codec against capnp 1.4.0", () => {
  test("J-01 each unicode escape is one WTF-8 code unit", () => {
    const codec = new JsonCodec();
    const readTitle = (json: string): number[] => {
      const decoded = codec.decode(json, sink);
      const p = decoded.ptr.getP(sink.getFieldByName("title").offset);
      const raw = p.msg.segs[p.seg]!.data.subarray(p.word * 8, p.word * 8 + p.count - 1);
      return [...raw];
    };
    expect(readTitle('{"title":"\\uD83D\\uDE00"}')).toEqual([
      0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80,
    ]);
    expect(readTitle('{"title":"\\uD800"}')).toEqual([0xed, 0xa0, 0x80]);
    expect(readTitle('{"title":"\\uDC00"}')).toEqual([0xed, 0xb0, 0x80]);
    expect(readTitle('{"title":"\\u00e9"}')).toEqual([0xc3, 0xa9]);
    expect(readTitle('{"title":"😀"}')).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });

  test("J-02 a flattened field on another arm throws", () => {
    const codec = new JsonCodec();
    codec.handleByAnnotation(custom);
    expect(() => codec.decode('{"kind":"empty","v_key":"x"}', custom)).toThrow(CapnpError);
  });

  test("J-03 an unknown discriminator is ignored", () => {
    const codec = new JsonCodec({ rejectUnknownFields: true });
    codec.handleByAnnotation(custom);
    expect(codec.decode('{"kind":"bogus"}', custom).which()?.name).toBe("emptyVariant");
  });

  test("J-04 raw control characters in strings are kept", () => {
    const codec = new JsonCodec();
    expect(codec.decode('{"title":"a\tb"}', sink).get("title").asText()).toBe("a\tb");
    expect(codec.decode('{"title":"a\u0001b"}', sink).get("title").asText()).toBe("a\u0001b");
  });

  test("J-05 a trailing decimal point is a number", () => {
    expect(new JsonCodec().decode('{"f64":1.}', sink).get("f64").asFloat64()).toBe(1);
  });

  test("J-06 annotated enum numbers truncate to uint16", () => {
    const codec = new JsonCodec();
    codec.handleByAnnotation(custom);
    expect(codec.decode('{"prio":70000}', custom).get("prio").asEnum().getRaw()).toBe(4464);
    expect(codec.decode('{"prio":1.5}', custom).get("prio").asEnum().getRaw()).toBe(1);
  });
});

describe("nesting limit against capnp 1.4.0 pointer reads", () => {
  test("a null pointer is read before the nesting limit is consulted", () => {
    const msg = Message.fromSegments([words(wpMakeStruct(0, 0, 1), 0n)], { depthLimit: 1 });
    expect(msg.root().getP(0).kind).toBe(PtrKind.Null);
    const chained = Message.fromSegments([words(wpMakeStruct(0, 0, 1), wpMakeStruct(-1, 0, 0))], {
      depthLimit: 1,
    });
    expect(() => chained.root().getP(0)).toThrow(CapnpError);
  });

  test("composite list elements use one nesting level", () => {
    const listed = words(
      wpMakeStruct(0, 0, 1),
      wpMakeList(0, ElemSize.Composite, 2),
      wpMakeStruct(2, 0, 1),
      wpMakeStruct(-1, 0, 0),
      0n,
    );
    const open = (limit: number) => Message.fromSegments([listed], { depthLimit: limit }).root();
    expect(() => open(2).getP(0).listGetStruct(0)).toThrow(/DEPTH|nest/i);
    const element = open(3).getP(0).listGetStruct(0);
    expect(element.depth).toBe(2);
    expect(() => element.getP(0)).toThrow(CapnpError);
    expect(open(3).getP(0).listGetStruct(1).getP(0).kind).toBe(PtrKind.Null);
    expect(() => open(3).getP(0).listGetP(0)).not.toThrow(CapnpError);
  });

  test("a double-far landing in an unknown or empty segment is rejected", () => {
    const zeroSized = (landing: Uint8Array, landingWords: number) =>
      Message.fromSegments([
        { data: words(wpMakeFar(true, 0, 1)), words: 1 },
        { data: words(wpMakeFar(false, 0, 2), wpMakeStruct(0, 0, 0)), words: 2 },
        { data: landing, words: landingWords },
      ]);
    expect(() => zeroSized(new Uint8Array(0), 0).root()).toThrow(/unknown segment/);
    expect(zeroSized(words(0n), 1).root().kind).toBe(PtrKind.Struct);
    const absent = Message.fromSegments([
      words(wpMakeFar(true, 0, 1)),
      words(wpMakeFar(false, 0, 9), wpMakeStruct(0, 0, 0)),
    ]);
    expect(() => absent.root()).toThrow(/unknown segment/);
  });
});

function oneSegmentFrame(...body: bigint[]): Uint8Array {
  const table = new Uint8Array(8);
  storeU32(table, 4, body.length);
  const out = new Uint8Array(8 + body.length * 8);
  out.set(table);
  out.set(words(...body), 8);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe("packed round trips against capnp 1.4.0", () => {
  test("unpack returns raw word buffers that pack produced", () => {
    const zeros = new Uint8Array(48);
    expect(unpack(pack(zeros))).toEqual(zeros);
    const dense = new Uint8Array(40).fill(7);
    expect(unpack(pack(dense))).toEqual(dense);
    expect(unpack(new Uint8Array([0x00, 0x05]))).toEqual(zeros);
  });

  test("concatenated frames pack and unpack piece by piece", () => {
    const a = oneSegmentFrame(wpMakeStruct(0, 1, 0), 0x0102n);
    const b = oneSegmentFrame(wpMakeStruct(0, 1, 0), 0x0304n);
    const both = concat(a, b);
    expect(pack(both)).toEqual(concat(pack(a), pack(b)));
    expect(unpack(pack(both))).toEqual(both);
  });

  test("unpack validates the first message and leaves later bytes alone", () => {
    const a = oneSegmentFrame(wpMakeStruct(0, 1, 0), 0x0102n);
    const trailing = concat(pack(a), new Uint8Array([0x00, 0x05]));
    expect(unpack(trailing)).toEqual(concat(a, new Uint8Array(48)));
    const straddle = concat(new Uint8Array([0x11, 0x03, 0x01, 0x00, 0x02]), pack(a));
    expect(() => unpack(straddle)).toThrow(/segment boundary/);
  });
});
