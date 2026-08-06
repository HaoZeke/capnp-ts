import { describe, expect, test } from "bun:test";
import {
  CapnpError,
  ErrorCode,
  WireKind,
  ListElementSize,
  CAPNP_WORD_BYTES,
  DEFAULT_TRAVERSAL_WORDS,
  DEFAULT_DEPTH_LIMIT,
  MAX_SEGMENTS,
  listStepBits,
} from "../src/kinds.ts";
import {
  loadU8,
  storeU8,
  loadU16,
  storeU16,
  loadU32,
  storeU32,
  loadU64,
  storeU64,
  loadI32,
  storeI32,
  loadI64,
  storeI64,
  loadF64,
  storeF64,
} from "../src/endian.ts";
import {
  kindOf,
  offsetOf,
  structDataWords,
  structPointerWords,
  listElementSize,
  listElementCount,
  farIsDouble,
  farPadOffset,
  farSegmentId,
  capIndex,
  makeStruct,
  makeList,
  makeFar,
  makeCap,
} from "../src/pointer.ts";

describe("kinds constants", () => {
  test("word / traversal / depth / segment caps", () => {
    expect(CAPNP_WORD_BYTES).toBe(8);
    expect(DEFAULT_TRAVERSAL_WORDS).toBe(8_388_608);
    expect(DEFAULT_DEPTH_LIMIT).toBe(64);
    expect(MAX_SEGMENTS).toBe(512);
  });

  test("listStepBits", () => {
    expect(listStepBits(ListElementSize.VOID)).toBe(0);
    expect(listStepBits(ListElementSize.BIT)).toBe(1);
    expect(listStepBits(ListElementSize.BYTE)).toBe(8);
    expect(listStepBits(ListElementSize.TWO)).toBe(16);
    expect(listStepBits(ListElementSize.FOUR)).toBe(32);
    expect(listStepBits(ListElementSize.EIGHT)).toBe(64);
    expect(listStepBits(ListElementSize.PTR)).toBe(64);
    expect(listStepBits(ListElementSize.COMPOSITE)).toBe(-1);
  });

  test("CapnpError carries .code string", () => {
    const err = new CapnpError(ErrorCode.BOUNDS, "out of segment");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CapnpError);
    expect(err.code).toBe("BOUNDS");
    expect(err.message).toBe("out of segment");
  });
});

describe("endian LE DataView", () => {
  test("u8 / u16 / u32 / u64 roundtrip", () => {
    const buf = new Uint8Array(16);
    storeU8(buf, 0, 0xab);
    expect(loadU8(buf, 0)).toBe(0xab);

    storeU16(buf, 0, 0x1234);
    expect(buf[0]).toBe(0x34);
    expect(buf[1]).toBe(0x12);
    expect(loadU16(buf, 0)).toBe(0x1234);

    storeU32(buf, 0, 0x12345678);
    expect([...buf.subarray(0, 4)]).toEqual([0x78, 0x56, 0x34, 0x12]);
    expect(loadU32(buf, 0)).toBe(0x12345678);

    storeU64(buf, 0, 0x0102030405060708n);
    expect([...buf.subarray(0, 8)]).toEqual([
      0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,
    ]);
    expect(loadU64(buf, 0)).toBe(0x0102030405060708n);
  });

  test("i32 / i64 / f64 roundtrip", () => {
    const buf = new Uint8Array(16);
    storeI32(buf, 0, -2);
    expect(loadI32(buf, 0)).toBe(-2);

    storeI64(buf, 0, -42n);
    expect(loadI64(buf, 0)).toBe(-42n);

    storeF64(buf, 0, Math.PI);
    expect(loadF64(buf, 0)).toBeCloseTo(Math.PI, 15);
  });

  test("works on ArrayBuffer and subarray views", () => {
    const ab = new ArrayBuffer(8);
    storeU32(ab, 4, 0xaabbccdd);
    expect(loadU32(ab, 4)).toBe(0xaabbccdd);

    const full = new Uint8Array(16);
    const slice = full.subarray(4, 12);
    storeU64(slice, 0, 0xffffffff00000001n);
    expect(loadU64(slice, 0)).toBe(0xffffffff00000001n);
    expect(loadU64(full, 4)).toBe(0xffffffff00000001n);
  });
});

describe("pointer encode/decode", () => {
  test("struct C=1 D=0 golden word", () => {
    // Fortran: wp_make_struct(0, 1, 0) == 0x0000000100000000
    const w = makeStruct(0, 1, 0);
    expect(w).toBe(0x0000_0001_0000_0000n);
    expect(kindOf(w)).toBe(WireKind.STRUCT);
    expect(offsetOf(w)).toBe(0);
    expect(structDataWords(w)).toBe(1);
    expect(structPointerWords(w)).toBe(0);
  });

  test("struct negative offset roundtrip", () => {
    const w = makeStruct(-2, 3, 4);
    expect(kindOf(w)).toBe(WireKind.STRUCT);
    expect(offsetOf(w)).toBe(-2);
    expect(structDataWords(w)).toBe(3);
    expect(structPointerWords(w)).toBe(4);
  });

  test("list roundtrip", () => {
    const w = makeList(5, ListElementSize.FOUR, 7);
    expect(kindOf(w)).toBe(WireKind.LIST);
    expect(offsetOf(w)).toBe(5);
    expect(listElementSize(w)).toBe(ListElementSize.FOUR);
    expect(listElementCount(w)).toBe(7);
  });

  test("far single and double", () => {
    const single = makeFar(false, 3, 1);
    expect(kindOf(single)).toBe(WireKind.FAR);
    expect(farIsDouble(single)).toBe(false);
    expect(farPadOffset(single)).toBe(3);
    expect(farSegmentId(single)).toBe(1);

    const dbl = makeFar(true, 0, 2);
    expect(kindOf(dbl)).toBe(WireKind.FAR);
    expect(farIsDouble(dbl)).toBe(true);
    expect(farPadOffset(dbl)).toBe(0);
    expect(farSegmentId(dbl)).toBe(2);
  });

  test("cap index roundtrip", () => {
    const w = makeCap(9);
    expect(kindOf(w)).toBe(WireKind.CAP);
    expect(capIndex(w)).toBe(9);
  });

  test("pointer word is 64 bits and roundtrips through LE buffer", () => {
    const w = makeStruct(-2, 3, 4);
    const buf = new Uint8Array(8);
    storeU64(buf, 0, w);
    const back = loadU64(buf, 0);
    expect(back).toBe(w);
    expect(offsetOf(back)).toBe(-2);
    expect(structDataWords(back)).toBe(3);
    expect(structPointerWords(back)).toBe(4);
  });
});
