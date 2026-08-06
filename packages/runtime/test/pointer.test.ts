import { describe, expect, test } from "bun:test";
import {
  makeFar,
  makeList,
  makeStruct,
  wpFarOff,
  wpFarSeg,
  wpFarTwo,
  wpKind,
  wpListCount,
  wpListEsize,
  wpOffset,
  wpStructDwords,
  wpStructPwords,
  ElementSize,
  WireKind,
} from "../src/index.ts";

describe("pointer words", () => {
  test("struct encode/decode", () => {
    const w = makeStruct(5, 1, 4);
    expect(wpKind(w)).toBe(WireKind.Struct);
    expect(wpOffset(w)).toBe(5);
    expect(wpStructDwords(w)).toBe(1);
    expect(wpStructPwords(w)).toBe(4);
  });

  test("negative offset sign-extends 30-bit", () => {
    const w = makeStruct(-1, 0, 0);
    expect(wpOffset(w)).toBe(-1);
  });

  test("list encode/decode", () => {
    const w = makeList(3, ElementSize.Byte, 18);
    expect(wpKind(w)).toBe(WireKind.List);
    expect(wpOffset(w)).toBe(3);
    expect(wpListEsize(w)).toBe(ElementSize.Byte);
    expect(wpListCount(w)).toBe(18);
  });

  test("far single and double", () => {
    const s = makeFar(false, 7, 2);
    expect(wpKind(s)).toBe(WireKind.Far);
    expect(wpFarTwo(s)).toBe(false);
    expect(wpFarOff(s)).toBe(7);
    expect(wpFarSeg(s)).toBe(2);

    const d = makeFar(true, 0, 1);
    expect(wpFarTwo(d)).toBe(true);
    expect(wpFarOff(d)).toBe(0);
    expect(wpFarSeg(d)).toBe(1);
  });
});
