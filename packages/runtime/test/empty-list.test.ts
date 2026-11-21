import { describe, expect, test } from "bun:test";
import {
  ElemSize,
  Message,
  MessageBuilder,
  StructBuilder,
  deepCopyPtrToSlot,
} from "../src/index.ts";

// Struct Z { a :UInt64; lv :List(Void); lb :List(Bool); l8 :List(UInt8);
//   l16 :List(UInt16); l32 :List(UInt32); l64 :List(UInt64); lp :List(Text);
//   lc :List(E); d :Data; le :List(EE); s :EE } with E { x :UInt8 } and
// EE {}. Expected bytes are `capnp encode` output from Cap'n Proto 1.4.0.
const Z_DWORDS = 1;
const Z_PWORDS = 11;

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function build(fill: (root: StructBuilder) => void): Uint8Array {
  const b = new MessageBuilder();
  fill(b.initRoot(Z_DWORDS, Z_PWORDS));
  return b.toFlat();
}

const HEADER = "000000000d0000000000000001000b000000000000000000";
const ZERO_WORD = "0000000000000000";

/** Expected message with one pointer slot set and the rest null. */
function onePointer(slot: number, word: string, trailer = ""): string {
  const words = Array.from({ length: Z_PWORDS }, (_, i) => (i === slot ? word : ZERO_WORD));
  const header = trailer ? HEADER.replace("0d000000", "0e000000") : HEADER;
  return header + words.join("") + trailer;
}

describe("zero-length list pointers match capnp 1.4.0", () => {
  test("List(Void) points at the segment end", () => {
    expect(hex(build((r) => r.initPrimList(0, ElemSize.Void, 0, 0)))).toBe(
      onePointer(0, "2900000000000000"),
    );
  });

  test("List(Void) with elements still has no body and points at the segment end", () => {
    expect(hex(build((r) => r.initPrimList(0, ElemSize.Void, 3, 0)))).toBe(
      onePointer(0, "2900000018000000"),
    );
  });

  test("List(Bool) points at the segment end", () => {
    expect(hex(build((r) => r.initPrimList(1, ElemSize.Bit, 0, 0)))).toBe(
      onePointer(1, "2500000001000000"),
    );
  });

  test("List(UInt8) points at the segment end", () => {
    expect(hex(build((r) => r.initPrimList(2, ElemSize.Byte, 0, 1)))).toBe(
      onePointer(2, "2100000002000000"),
    );
  });

  test("List(UInt16) points at the segment end", () => {
    expect(hex(build((r) => r.initPrimList(3, ElemSize.TwoBytes, 0, 2)))).toBe(
      onePointer(3, "1d00000003000000"),
    );
  });

  test("List(UInt32) points at the segment end", () => {
    expect(hex(build((r) => r.initPrimList(4, ElemSize.FourBytes, 0, 4)))).toBe(
      onePointer(4, "1900000004000000"),
    );
  });

  test("List(UInt64) points at the segment end", () => {
    expect(hex(build((r) => r.initPrimList(5, ElemSize.EightBytes, 0, 8)))).toBe(
      onePointer(5, "1500000005000000"),
    );
  });

  test("List(Text) points at the segment end", () => {
    expect(hex(build((r) => r.initPointerList(6, 0)))).toBe(onePointer(6, "1100000006000000"));
  });

  test("empty Data points at the segment end", () => {
    expect(hex(build((r) => r.setData(8, new Uint8Array(0))))).toBe(
      onePointer(8, "0900000002000000"),
    );
  });

  test("empty inline composite lists put their tag at the word an earlier empty list points at", () => {
    // An empty composite list still allocates its tag, at the same word an
    // earlier empty list already points at.
    expect(
      hex(
        build((r) => {
          r.initPrimList(2, ElemSize.Byte, 0, 1);
          r.initCompositeList(7, 0, 1, 0);
        }),
      ),
    ).toBe(
      HEADER.replace("0d000000", "0e000000") +
        ZERO_WORD.repeat(2) +
        "2100000002000000" +
        ZERO_WORD.repeat(4) +
        "0d00000007000000" +
        ZERO_WORD.repeat(3) +
        "0000000001000000",
    );
    expect(
      hex(
        build((r) => {
          r.initPointerList(6, 0);
          r.initCompositeList(9, 0, 0, 0);
        }),
      ),
    ).toBe(
      HEADER.replace("0d000000", "0e000000") +
        ZERO_WORD.repeat(6) +
        "1100000006000000" +
        ZERO_WORD.repeat(2) +
        "0500000007000000" +
        ZERO_WORD.repeat(2),
    );
  });

  test("an empty list after an allocation points at the new segment end", () => {
    const got = build((r) => {
      r.initPrimList(2, ElemSize.Byte, 2, 1, Uint8Array.of(1, 2));
      r.initPrimList(3, ElemSize.TwoBytes, 0, 2);
    });
    expect(hex(got)).toBe(
      "000000000e0000000000000001000b000000000000000000" +
        ZERO_WORD.repeat(2) +
        "2100000012000000" +
        "2100000003000000" +
        ZERO_WORD.repeat(7) +
        "0102000000000000",
    );
  });

  test("every element size together, and a deep copy, match capnp encode", () => {
    const expected = [
      "000000000f000000",
      "0000000001000b00",
      ZERO_WORD,
      "2900000000000000",
      "2500000001000000",
      "2100000002000000",
      "1d00000003000000",
      "1900000004000000",
      "1500000005000000",
      "1100000006000000",
      "0d00000007000000",
      "0d00000002000000",
      "0900000007000000",
      ZERO_WORD,
      "0000000001000000",
      ZERO_WORD,
    ].join("");
    const got = build((r) => {
      r.initPrimList(0, ElemSize.Void, 0, 0);
      r.initPrimList(1, ElemSize.Bit, 0, 0);
      r.initPrimList(2, ElemSize.Byte, 0, 1);
      r.initPrimList(3, ElemSize.TwoBytes, 0, 2);
      r.initPrimList(4, ElemSize.FourBytes, 0, 4);
      r.initPrimList(5, ElemSize.EightBytes, 0, 8);
      r.initPointerList(6, 0);
      r.initCompositeList(7, 0, 1, 0);
      r.setData(8, new Uint8Array(0));
      r.initCompositeList(9, 0, 0, 0);
    });
    expect(hex(got)).toBe(expected);

    const copy = new MessageBuilder();
    deepCopyPtrToSlot(copy, copy.rootSlot(), Message.fromFlat(got).root());
    expect(hex(copy.toFlat())).toBe(expected);
  });
});
