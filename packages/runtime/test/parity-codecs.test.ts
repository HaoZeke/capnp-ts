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
  TextCodec,
  canonicalize,
  canonicalizeFlat,
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
    expect(Message.fromFlat(one(512)).segmentCount).toBe(512);
    expect(Message.fromFlat(one(513)).segmentCount).toBe(513);
    expect(() => unpack(pack(one(512)))).toThrow(/too many segments/);
    expect(() => unpack(pack(one(513)))).toThrow(/\[512 < 511\]/);
    expect(() => unpack(pack(one(600)))).toThrow(/too many segments/);
    expect(() => canonicalizeFlat(one(513))).not.toThrow();
  });

  test("W-03 a flat read accepts a message past the traversal limit", () => {
    const body = new Uint8Array(20 * 8);
    storeU64(body, 0, wpMakeStruct(0, 1, 0));
    let table = 8;
    const flat = new Uint8Array(table + body.byteLength);
    storeU32(flat, 0, 0);
    storeU32(flat, 4, 20);
    flat.set(body, table);
    expect(Message.fromFlat(flat, { traversalWords: 4 }).segmentCount).toBe(1);
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

  test("isCanonical charges the root, structs, and list bodies", () => {
    const at = (w: bigint[], lim: number) => () =>
      isCanonical(Message.fromSegments([words(...w)], { traversalWords: lim }));
    const st = [wpMakeStruct(0, 9, 0), ...new Array<bigint>(8).fill(0n), 1n];
    expect(at(st, 10)()).toBe(true);
    expect(at(st, 9)).toThrow(/traversal limit/);
    const pl = [
      wpMakeStruct(0, 0, 1),
      wpMakeList(0, ElemSize.Pointer, 3),
      wpMakeStruct(2, 1, 0),
      wpMakeStruct(2, 1, 0),
      wpMakeStruct(2, 1, 0),
      1n,
      2n,
      3n,
    ];
    expect(at(pl, 8)()).toBe(true);
    expect(at(pl, 7)).toThrow(/traversal limit/);
    const il = [wpMakeStruct(0, 0, 1), wpMakeList(0, ElemSize.FourBytes, 6), 1n, 2n, 3n];
    expect(at(il, 5)()).toBe(true);
    expect(at(il, 4)).toThrow(/traversal limit/);
    const cl = [
      wpMakeStruct(0, 0, 1),
      wpMakeList(0, ElemSize.Composite, 2),
      wpMakeStruct(2, 1, 0),
      1n,
      2n,
    ];
    expect(at(cl, 5)()).toBe(true);
    expect(at(cl, 4)).toThrow(/traversal limit/);
  });

  test("isCanonical charges zero-size composite elements before layout checks", () => {
    const at = (w: bigint[], lim?: number) => () =>
      isCanonical(Message.fromSegments([words(...w)], lim ? { traversalWords: lim } : {}));
    const moved = [
      wpMakeStruct(0, 0, 1),
      wpMakeList(1, ElemSize.Composite, 0),
      0n,
      wpMakeStruct(10_000_000, 0, 0),
    ];
    expect(at(moved)).toThrow(/traversal limit/);
    const padded = [wpMakeStruct(0, 0, 1), wpMakeList(0, ElemSize.Composite, 1), wpMakeStruct(3, 0, 0), 0n];
    expect(at(padded, 7)()).toBe(false);
    expect(at(padded, 6)).toThrow(/traversal limit/);
  });

  test("a list root is not a struct to canonicalize", () => {
    const list = words(wpMakeList(0, ElemSize.Byte, 2), 0x6162n);
    expect(() => canonicalize(Message.fromSegments([list]))).toThrow(/pointerwas expected/);
  });

  test("an amplified void list hits the traversal limit", () => {
    const amp = words(wpMakeStruct(0, 0, 1), wpMakeList(0, ElemSize.Void, 10_000_000));
    expect(() => isCanonical(Message.fromSegments([amp]))).toThrow(/traversal limit/);
  });

  test("C-03 a null root canonicalizes to the empty-struct pointer", () => {
    const out = canonicalize(Message.fromSegments([words(0n)]));
    expect(out).toEqual(words(wpMakeStruct(-1, 0, 0)));
  });
});

describe("canonical form with empty trailing segments", () => {
  test("only a non-empty second segment makes a message non-canonical", () => {
    const root = words(wpMakeStruct(-1, 0, 0));
    const empty = { data: new Uint8Array(0), words: 0 };
    const one = { data: root, words: 1 };
    expect(isCanonical(Message.fromSegments([one, empty]))).toBe(true);
    expect(isCanonical(Message.fromSegments([one, empty, one]))).toBe(true);
    expect(isCanonical(Message.fromSegments([one, one]))).toBe(false);
  });

  test("zero-width composite lists require a zero content word count", () => {
    const valid = Message.fromSegments([
      words(wpMakeList(0, ElemSize.Composite, 0), wpMakeStruct(3, 0, 0)),
    ]);
    expect(isCanonical(valid)).toBe(true);
    const bad = Message.fromSegments([
      words(wpMakeList(0, ElemSize.Composite, 1), wpMakeStruct(3, 0, 0), 0n),
    ]);
    expect(isCanonical(bad)).toBe(false);
    // In-bounds: list claims 1 content word, tag has 0-word elements, next field uses word 4.
    const inBoundsBad = Message.fromSegments([
      words(
        wpMakeStruct(0, 0, 2),
        wpMakeList(1, ElemSize.Composite, 1),
        wpMakeStruct(1, 1, 0),
        wpMakeStruct(3, 0, 0),
        1n,
      ),
    ]);
    expect(isCanonical(inBoundsBad)).toBe(false);
  });

  test("isCanonical enforces the message depthLimit like capnp 1.4.0", () => {
    expect(isCanonical(Message.fromSegments([words(0n)], { depthLimit: 0 }))).toBe(true);
    expect(() =>
      isCanonical(Message.fromSegments([words(wpMakeStruct(-1, 0, 0))], { depthLimit: 0 })),
    ).toThrow(CapnpError);
    const nested = words(wpMakeStruct(0, 0, 1), wpMakeStruct(0, 1, 0), 1n);
    expect(() => isCanonical(Message.fromSegments([nested], { depthLimit: 1 }))).toThrow(
      CapnpError,
    );
    expect(isCanonical(Message.fromSegments([nested], { depthLimit: 2 }))).toBe(true);
    const comp = words(wpMakeList(0, ElemSize.Composite, 1), wpMakeStruct(1, 1, 0), 1n);
    expect(() => isCanonical(Message.fromSegments([comp], { depthLimit: 1 }))).toThrow(CapnpError);
    expect(isCanonical(Message.fromSegments([comp], { depthLimit: 2 }))).toBe(true);
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

  test("T-03 a non-tuple struct or list element value fills the first field", () => {
    expect(readText('(defaultTag = "k")').get("defaultTag").asStruct().get("key").asText()).toBe("k");
    expect(readText('(defaultTag = ("k"))').get("defaultTag").asStruct().get("key").asText()).toBe(
      "k",
    );
    const tags = readText('(tags = ["a", (key = "b", code = 2), "c"])').get("tags").asList();
    expect(tags.get(0).asStruct().get("key").asText()).toBe("a");
    expect(tags.get(1).asStruct().get("code").asInt32()).toBe(2);
    expect(tags.get(2).asStruct().get("key").asText()).toBe("c");
    expect(() => readText("(defaultTag = 5)")).toThrow(/Type mismatch; expected/);
    expect(() => readText('(defaultTag = 0x"ff")')).toThrow(CapnpError);
    expect(() => readText("(defaultTag = [1])")).toThrow(CapnpError);
    expect(() => readText("(tags = [5])")).toThrow(/Type mismatch/);
    const tagType = sink.getFieldByName("defaultTag").getType();
    const codec = new TextCodec();
    expect(codec.decodeValue('"k"', tagType).asStruct().get("key").asText()).toBe("k");
    expect(codec.decodeValue('("k")', tagType).asStruct().get("key").asText()).toBe("k");
    expect(() => codec.decodeValue("5", tagType)).toThrow(/Type mismatch/);
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

  test("T-06 integer literals wrap modulo 2^64 before the range check", () => {
    expect(readText("(u64 = 18446744073709551616)").get("u64").asUInt64()).toBe(0n);
    expect(readText("(i64 = 99999999999999999999999)").get("i64").asInt64()).toBe(200376420520689663n);
    expect(readText("(i64 = -18446744073709551617)").get("i64").asInt64()).toBe(-1n);
    expect(readText("(u64 = 0x10000000000000000)").get("u64").asUInt64()).toBe(0n);
    expect(readText("(u64 = 02000000000000000000000)").get("u64").asUInt64()).toBe(0n);
    expect(readText("(u32 = 18446744073709551617)").get("u32").asUInt32()).toBe(1);
    expect(readText("(f64 = 18446744073709551616)").get("f64").asFloat64()).toBe(0);
    expect(() => readText("(u8 = 18446744073709551872)")).toThrow(CapnpError);
    expect(() => readText("(i64 = 9223372036854775808)")).toThrow(CapnpError);
    expect(() => readText("(i8 = -18446744073709551488)")).toThrow(/too big to be negative/);
  });

  test("T-07 a negated integer zero is a positive float zero", () => {
    expect(Object.is(readText("(f64 = -0)").get("f64").asFloat64(), 0)).toBe(true);
    expect(Object.is(readText("(f32 = -0x0)").get("f32").asFloat32(), 0)).toBe(true);
    expect(Object.is(readText("(f64 = -0.0)").get("f64").asFloat64(), -0)).toBe(true);
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

  test("J-07 float strings follow strtod", () => {
    const codec = new JsonCodec();
    const f64 = (s: string) =>
      codec.decode(`{"f64":${JSON.stringify(s)}}`, sink).get("f64").asFloat64();
    expect(f64(" 12")).toBe(12);
    expect(f64("\t\n\v\f\r-3")).toBe(-3);
    expect(f64("0x10")).toBe(16);
    expect(f64("0X1P3")).toBe(8);
    expect(f64("-0x1.8p-1")).toBe(-0.75);
    expect(f64("0x.8")).toBe(0.5);
    expect(f64("0x1p-1074")).toBe(5e-324);
    expect(f64("0x1p-1075")).toBe(0);
    expect(f64("0x3p-1076")).toBe(5e-324);
    expect(f64("0x1.fffffffffffff8p1023")).toBe(Infinity);
    expect(f64("Inf")).toBe(Infinity);
    expect(f64("-INFINITY")).toBe(-Infinity);
    expect(f64("nan()")).toBeNaN();
    const f32 = codec.decode('{"f32":"0x1.0000018p0"}', sink).get("f32").asFloat32();
    expect(f32).toBe(Math.fround(1 + 2 ** -23));
    for (const bad of ["0x", "0x1p", "12 ", "infin", "nan(-)", " ", "1e"]) {
      expect(() => f64(bad)).toThrow(CapnpError);
    }
  });

  test("hex float exponents are scaled before range checks", () => {
    const codec = new JsonCodec();
    const f64 = (s: string) =>
      codec.decode(`{"f64":${JSON.stringify(s)}}`, sink).get("f64").asFloat64();
    const zeros = "0".repeat(260000);
    expect(f64(`0x0.${zeros}1p1040004`)).toBe(1);
    expect(f64(`0x1${zeros}p-1040000`)).toBe(1);
    expect(f64(`0x0.${zeros}1p1038930`)).toBe(5e-324);
    expect(f64("0x1p-99999999999999999999")).toBe(0);
    expect(f64("0x1p99999999999999999999")).toBe(Infinity);
  });

  test("a non-number in a Data array decodes as a zero byte", () => {
    const codec = new JsonCodec();
    const raw = (json: string) => codec.decode(`{"raw":${json}}`, sink).get("raw").asData();
    expect(raw('["x"]')).toEqual(new Uint8Array([0]));
    expect(raw("[null,{}]")).toEqual(new Uint8Array([0, 0]));
    expect(raw('[1,"x",2,[3],{"a":4},true,255]')).toEqual(new Uint8Array([1, 0, 2, 0, 0, 0, 255]));
    for (const bad of ["[1.5]", "[256]", "[-1]"]) expect(() => raw(bad)).toThrow(CapnpError);
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
    const dense = new Uint8Array(40).fill(7);
    expect(unpack(pack(dense))).toEqual(dense);
    // Segment 0 has no words, so this is a raw buffer. The message-reader
    // error stays on frames whose first segment has a word.
    expect(unpack(new Uint8Array([0x00, 0x05]))).toEqual(new Uint8Array(48));
    expect(unpack(new Uint8Array([0x00, 0x84]))).toEqual(new Uint8Array(1064));
    expect(unpack(pack(new Uint8Array(48)))).toEqual(new Uint8Array(48));
    // Segment 0 is empty and a later segment has a word. The framed read
    // hits a segment boundary; the raw words are still the result.
    const later = unpack(new Uint8Array([0x01, 0x01, 0x01, 0x01, 0x00, 0x05]));
    expect(later.length).toBe(64);
    expect(later[0]).toBe(1);
    expect(later[8]).toBe(1);
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

describe("composite list bounds against capnp 1.4.0", () => {
  test("an out of bounds composite list names the tag word", () => {
    const msg = Message.fromSegments([
      words(wpMakeStruct(0, 0, 1), wpMakeList(0, ElemSize.Composite, 4)),
    ]);
    expect(() => msg.root().getP(0)).toThrow(
      "boundsCheck(segment, ptr, wordCount + POINTER_SIZE_IN_WORDS)",
    );
  });
});

describe("reader sentences against capnp 1.4.0", () => {
  test("non-NUL text uses the raw code unit on both sides", () => {
    const msg = Message.fromSegments([
      words(wpMakeStruct(0, 0, 1), wpMakeList(0, ElemSize.Byte, 1), 0x41n),
    ]);
    let message = "";
    try {
      msg.root().getText(0);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain(`[A == ${String.fromCharCode(0)}]`);

    const control = Message.fromSegments([
      words(wpMakeStruct(0, 0, 1), wpMakeList(0, ElemSize.Byte, 1), 0x01n),
    ]);
    try {
      control.root().getText(0);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain(`[${String.fromCharCode(1)} == ${String.fromCharCode(0)}]`);
  });

  test("a double-far landing on a far pointer is Unexpected FAR pointer", () => {
    const flat = new Uint8Array([
      0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01,
      0x00, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0e, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00,
    ]);
    const root = Message.fromFlat(flat).root();
    expect(() => root.getP(0, "copy")).toThrow("Unexpected FAR pointer.");
  });
});

describe("isCanonical throws where capnp 1.4.0 throws", () => {
  function raw(hex: string): Message {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return Message.fromSegments([{ data: bytes, words: bytes.length / 8 }]);
  }

  test("composite overrun, non-struct tag, and pointer-list OOB throw", () => {
    expect(() =>
      isCanonical(raw("0000000000000100010000000f00000028000000010000000000000000000000")),
    ).toThrow(/elements overrun its word count/);
    expect(() =>
      isCanonical(raw("0000000000000100010000000f000000010000000a0000000000000000000000")),
    ).toThrow(/lists of non-STRUCT type are not supported/);
    expect(() => isCanonical(raw("0000000000000100010000002e0000000000000000000000"))).toThrow(
      /boundsCheck\(segment, ptr, wordCount\)/,
    );
  });
});
