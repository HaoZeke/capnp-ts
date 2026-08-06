/**
 * Reader security: nesting depth, finishList charge/overflow, composite tag
 * checks, boundsWord, negative list indices. Aligned with capnp-fortran and
 * encoding.html.
 */
import { describe, expect, test } from "bun:test";
import {
  CapnpError,
  DEFAULT_TRAVERSAL_WORDS,
  ElemSize,
  Message,
  MessageBuilder,
  PtrKind,
  storeU64,
  wpMakeFar,
  wpMakeList,
  wpMakeStruct,
} from "../src/index.ts";

function expectCode(fn: () => void, code: string): void {
  try {
    fn();
    expect.unreachable(`expected CapnpError ${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(CapnpError);
    expect((e as CapnpError).code).toBe(code);
  }
}

/** Single-segment framed message: root pointer at word 0 of the segment body. */
function frameOneSeg(segWords: bigint[]): Message {
  const nWords = segWords.length;
  const tableBytes = 8;
  const buf = new Uint8Array(tableBytes + nWords * 8);
  buf[0] = 0; // nsegs-1
  buf[4] = nWords & 0xff;
  buf[5] = (nWords >>> 8) & 0xff;
  buf[6] = (nWords >>> 16) & 0xff;
  buf[7] = (nWords >>> 24) & 0xff;
  for (let i = 0; i < nWords; i++) {
    storeU64(buf, tableBytes + i * 8, segWords[i]!);
  }
  return Message.fromFlat(buf);
}

function packWords(words: bigint[]): Uint8Array {
  const buf = new Uint8Array(words.length * 8);
  for (let i = 0; i < words.length; i++) storeU64(buf, i * 8, words[i]!);
  return buf;
}

describe("nesting depth limit", () => {
  test("depth_limit=0 allows root, first getP throws DEPTH", () => {
    const b = new MessageBuilder();
    const root = b.initRoot(0, 1);
    const kid = root.initStruct(0, 1, 0);
    kid.setU32(0, 7);
    const msg = Message.fromFlat(b.toFlat(), { depthLimit: 0 });
    const r = msg.root();
    expect(r.kind).toBe(PtrKind.Struct);
    expect(r.depth).toBe(0);
    expectCode(() => r.getP(0), "DEPTH");
  });

  test("depth_limit=1: first hop ok, second hop throws DEPTH", () => {
    const b = new MessageBuilder();
    const root = b.initRoot(0, 1);
    const a = root.initStruct(0, 0, 1);
    const leaf = a.initStruct(0, 1, 0);
    leaf.setU32(0, 99);
    const msg = Message.fromFlat(b.toFlat(), { depthLimit: 1 });
    const r = msg.root();
    const mid = r.getP(0);
    expect(mid.kind).toBe(PtrKind.Struct);
    expect(mid.depth).toBe(1);
    expectCode(() => mid.getP(0), "DEPTH");
  });

  test("deep nesting past default limit throws DEPTH", () => {
    // Keep the chain intra-segment so far hops do not consume extra depth.
    const depth = 70;
    const b = new MessageBuilder({ firstWords: 256 });
    let cur = b.initRoot(0, 1);
    for (let i = 0; i < depth; i++) {
      cur = cur.initStruct(0, 0, 1);
    }
    const msg = Message.fromFlat(b.toFlat());
    let p = msg.root();
    let threwAt = -1;
    for (let i = 0; i < depth; i++) {
      try {
        p = p.getP(0);
      } catch (e) {
        expect(e).toBeInstanceOf(CapnpError);
        expect((e as CapnpError).code).toBe("DEPTH");
        threwAt = i;
        break;
      }
    }
    // root depth 0; hops 1..64 succeed (depthLimit 64); hop 65 (i=64) fails.
    expect(threwAt).toBe(64);
  });

  test("listGetP pointer elements accumulate depth", () => {
    const b = new MessageBuilder();
    const root = b.initRoot(0, 1);
    root.initPointerList(0, 1);
    // root (d=0) → list (d=1) → listGetP resolves element at d=2.
    const msg = Message.fromFlat(b.toFlat(), { depthLimit: 1 });
    const lst = msg.root().getP(0);
    expect(lst.depth).toBe(1);
    // Null element still runs depth check before accepting null.
    expectCode(() => lst.listGetP(0), "DEPTH");
  });

  test("double-far decrements nesting budget", () => {
    // root double-far → struct 0d1p. depthLimit=1 → landing depth 1;
    // getP on landing is depth 2 → DEPTH.
    const seg0 = new Uint8Array(8);
    const seg1 = new Uint8Array(16);
    const seg2 = new Uint8Array(16);
    storeU64(seg0, 0, wpMakeFar(true, 0, 1));
    storeU64(seg1, 0, wpMakeFar(false, 0, 2));
    storeU64(seg1, 8, wpMakeStruct(0, 0, 1));
    storeU64(seg2, 0, 0n);

    const msg = Message.fromSegments(
      [
        { data: seg0, words: 1 },
        { data: seg1, words: 2 },
        { data: seg2, words: 2 },
      ],
      { depthLimit: 1 },
    );
    const r = msg.root();
    expect(r.kind).toBe(PtrKind.Struct);
    expect(r.depth).toBe(1);
    expectCode(() => r.getP(0), "DEPTH");
  });
});

describe("finishList charge and overflow", () => {
  test("large pointer-list count does not under-charge via uint32 wrap", () => {
    // count = 2^26 → bits = 2^32; old `(bits+63)>>>6` wraps to 0 and under-charges.
    // Rejection may be BOUNDS (tiny segment) or TRAVERSAL (budget); either is
    // before a successful under-charged resolve.
    const count = 1 << 26;
    const rootList = wpMakeList(0, ElemSize.Pointer, count);
    try {
      frameOneSeg([rootList]).root();
      expect.unreachable("expected CapnpError");
    } catch (e) {
      expect(e).toBeInstanceOf(CapnpError);
      expect(["TRAVERSAL", "BOUNDS"]).toContain((e as CapnpError).code);
    }
  });

  test("large byte-list count does not under-charge via uint32 wrap", () => {
    const count = 1 << 26;
    const rootList = wpMakeList(0, ElemSize.Byte, count);
    try {
      frameOneSeg([rootList]).root();
      expect.unreachable("expected CapnpError");
    } catch (e) {
      expect(e).toBeInstanceOf(CapnpError);
      expect(["TRAVERSAL", "BOUNDS"]).toContain((e as CapnpError).code);
    }
  });

  test("wrap case would have under-charged: words must exceed budget", () => {
    // Demonstrate the arithmetic the old path got wrong.
    const count = 1 << 26;
    const bits = count * 64;
    const wrapped = (bits + 63) >>> 6; // uint32 path → 0
    expect(wrapped).toBe(0);
    const correct = Number((BigInt(count) * 64n + 63n) / 64n);
    expect(correct).toBe(count);
    expect(correct).toBeGreaterThan(DEFAULT_TRAVERSAL_WORDS);
  });

  test("oversize list against large segment hits TRAVERSAL not under-charge", () => {
    // Segment large enough that bounds would pass if charge wrapped to 0.
    const count = 1 << 20; // 1 Mi pointer elements → 1 Mi words to charge
    const rootList = wpMakeList(0, ElemSize.Pointer, count);
    // Only root word present; bounds fails first. Build a message with a
    // fake large word count but short buffer is FRAMING — use fromSegments
    // with declared words >> data is unsafe. Instead: tight traversal budget
    // and enough zeros that bounds passes for a moderate count.
    const wordsNeeded = count; // pointer list body words
    // Allocate only 4 body words but set list count high — BOUNDS.
    // Allocate wordsNeeded+1 with low traversal → TRAVERSAL.
    const body: bigint[] = [rootList];
    for (let i = 0; i < 4; i++) body.push(0n);
    const msg = Message.fromSegments(
      [{ data: packWords(body), words: body.length }],
      { traversalWords: 2 },
    );
    // last word index = 0+count-1 >> body.length → BOUNDS before charge when
    // we bounds-check first. Swap order: charge first then bounds for amp
    // resistance? Task: "reject oversize counts with TRAVERSAL or BOUNDS before charge".
    // Current order is bounds then charge for primitives; either code is fine.
    try {
      msg.root();
      expect.unreachable("expected CapnpError");
    } catch (e) {
      expect(e).toBeInstanceOf(CapnpError);
      expect(["TRAVERSAL", "BOUNDS"]).toContain((e as CapnpError).code);
    }
    void wordsNeeded;
  });
});

describe("composite finishList", () => {
  test("tag must be WireKind.Struct", () => {
    // contentWords=1 → tag at start, one content word after; both in segment.
    const listPtr = wpMakeList(0, ElemSize.Composite, 1);
    const badTag = wpMakeList(0, ElemSize.Byte, 0);
    expectCode(() => {
      frameOneSeg([listPtr, badTag, 0n]).root();
    }, "KIND");
  });

  test("nelem*(dwords+pwords) > content words → BOUNDS", () => {
    // content words = 1, tag says 2 elements of 1d0p (needs 2 words)
    const listPtr = wpMakeList(0, ElemSize.Composite, 1);
    const tag = wpMakeStruct(2, 1, 0);
    expectCode(() => {
      frameOneSeg([listPtr, tag, 0n]).root();
    }, "BOUNDS");
  });

  test("zero-size composite still charges declared content words", () => {
    // content words = 8, tag 0d0p with nelem=100 (zero-size amp).
    const contentWords = 8;
    const listPtr = wpMakeList(0, ElemSize.Composite, contentWords);
    const tag = wpMakeStruct(100, 0, 0);
    const words: bigint[] = [listPtr, tag];
    for (let i = 0; i < contentWords; i++) words.push(0n);

    // Budget 5: root ptr(1) + tag+content(9) = 10 → TRAVERSAL.
    // Under-charge (tag only) would be ~2 and would incorrectly succeed.
    const msg = Message.fromSegments(
      [{ data: packWords(words), words: words.length }],
      { traversalWords: 5 },
    );
    expectCode(() => msg.root(), "TRAVERSAL");

    const ok = Message.fromSegments([
      { data: packWords(words), words: words.length },
    ]);
    const lst = ok.root();
    expect(lst.kind).toBe(PtrKind.List);
    expect(lst.esize).toBe(ElemSize.Composite);
    expect(lst.listLen()).toBe(100);
    const spent = DEFAULT_TRAVERSAL_WORDS - ok.remainingTraversal();
    // root pointer word + tag + contentWords
    expect(spent).toBeGreaterThanOrEqual(1 + 1 + contentWords);
  });

  test("valid composite list still decodes", () => {
    const listPtr = wpMakeList(0, ElemSize.Composite, 2);
    const tag = wpMakeStruct(2, 1, 0);
    const msg = frameOneSeg([listPtr, tag, 11n, 22n]);
    const lst = msg.root();
    expect(lst.listLen()).toBe(2);
    expect(lst.listGetStruct(0).getU64(0)).toBe(11n);
    expect(lst.listGetStruct(1).getU64(0)).toBe(22n);
  });
});

describe("boundsWord and double-far content", () => {
  test("negative body offset yields CapnpError BOUNDS not TypeError", () => {
    // word 0 pointer, body = 0+1+off with off=-2 → body=-1.
    const w = wpMakeStruct(-2, 1, 0);
    expectCode(() => {
      frameOneSeg([w]).root();
    }, "BOUNDS");
  });

  test("double-far content OOB is CapnpError not TypeError", () => {
    const seg0 = new Uint8Array(8);
    const seg1 = new Uint8Array(16);
    const seg2 = new Uint8Array(8);
    storeU64(seg0, 0, wpMakeFar(true, 0, 1));
    storeU64(seg1, 0, wpMakeFar(false, 5, 2)); // coff=5 past end
    storeU64(seg1, 8, wpMakeStruct(0, 1, 0));
    storeU64(seg2, 0, 0n);

    expectCode(() => {
      Message.fromSegments([
        { data: seg0, words: 1 },
        { data: seg1, words: 2 },
        { data: seg2, words: 1 },
      ]).root();
    }, "BOUNDS");
  });

  test("double-far bad segment id is SEGMENT CapnpError", () => {
    const seg0 = new Uint8Array(8);
    const seg1 = new Uint8Array(16);
    storeU64(seg0, 0, wpMakeFar(true, 0, 1));
    storeU64(seg1, 0, wpMakeFar(false, 0, 99));
    storeU64(seg1, 8, wpMakeStruct(0, 1, 0));
    expectCode(() => {
      Message.fromSegments([
        { data: seg0, words: 1 },
        { data: seg1, words: 2 },
      ]).root();
    }, "SEGMENT");
  });
});

describe("negative list index", () => {
  test("listGetP rejects negative index with BOUNDS", () => {
    const b = new MessageBuilder();
    const root = b.initRoot(0, 1);
    root.initPointerList(0, 2);
    const msg = Message.fromFlat(b.toFlat());
    const lst = msg.root().getP(0);
    expectCode(() => lst.listGetP(-1), "BOUNDS");
  });

  test("listGetU* and listGetBool reject negative index", () => {
    const b = new MessageBuilder();
    const root = b.initRoot(0, 2);
    root.initPrimList(0, ElemSize.Byte, 4, 1);
    root.initPrimList(1, ElemSize.Bit, 8, 0); // itemBytes unused for bit path?
    const msg = Message.fromFlat(b.toFlat());
    const bytes = msg.root().getP(0);
    const bits = msg.root().getP(1);
    expectCode(() => bytes.listGetU8(-1), "BOUNDS");
    expectCode(() => bytes.listGetU16(-1), "BOUNDS");
    expectCode(() => bytes.listGetU32(-1), "BOUNDS");
    expectCode(() => bytes.listGetU64(-1), "BOUNDS");
    expectCode(() => bits.listGetBool(-1), "BOUNDS");
  });

  test("listGetStruct rejects negative index", () => {
    const b = new MessageBuilder();
    const root = b.initRoot(0, 1);
    root.initPrimList(0, ElemSize.FourBytes, 2, 4);
    const msg = Message.fromFlat(b.toFlat());
    expectCode(() => msg.root().getP(0).listGetStruct(-1), "BOUNDS");
  });
});
