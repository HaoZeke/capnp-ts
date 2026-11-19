/**
 * Schema-evolution list upgrade/downgrade views.
 *
 * Shapes match capnp-janet test_list_evolution.c and capnp-fortran
 * t_list_upgrade_views / t_list_downgrade_views (encoding.html list upgrades).
 *
 * Hand-crafted wire words; no builder required.
 */

import { describe, expect, test } from "bun:test";
import {
  CapnpError,
  ElemSize,
  Message,
  PtrKind,
  listGetBool,
  listGetF64,
  listGetStruct,
  listGetText,
  listGetU16,
  listGetU64,
  listGetU8,
  listGetU32,
  storeU16,
  storeU32,
  storeU64,
  storeU8,
  wpMakeList,
  wpMakeStruct,
} from "../src/index.ts";

/** Build a single-segment message from raw content words (root at word 0). */
function msgFromWords(words: bigint[]): Message {
  const buf = new Uint8Array(words.length * 8);
  for (let i = 0; i < words.length; i++) {
    storeU64(buf, i * 8, words[i]!);
  }
  return Message.fromSegments([buf]);
}

function putText(seg: Uint8Array, word: number, s: string): void {
  const bytes = new TextEncoder().encode(s + "\0");
  for (let i = 0; i < bytes.length; i++) {
    storeU8(seg, word * 8 + i, bytes[i]!);
  }
}

describe("list upgrade views (prim/pointer -> struct field @0)", () => {
  test("List(UInt32) upgrades to struct; dataBits limits oversize reads", () => {
    // Root: struct 0d 1p at word 1
    // Word 1: List(UInt32) count=2, content at word 2
    // Word 2: [100, 200] as two u32s
    const words = [
      wpMakeStruct(0, 0, 1),
      wpMakeList(0, ElemSize.FourBytes, 2),
      0n,
    ];
    const msg = msgFromWords(words);
    const seg = msg.segments[0]!;
    storeU32(seg, 16, 100);
    storeU32(seg, 20, 200);

    const list = msg.root().getP(0);
    expect(list.kind).toBe(PtrKind.List);
    expect(list.esize).toBe(ElemSize.FourBytes);
    expect(list.listLen()).toBe(2);

    const el1 = listGetStruct(list, 1);
    expect(el1.kind).toBe(PtrKind.Struct);
    expect(el1.dataBits).toBe(32);
    expect(el1.getU32(0)).toBe(200);
    // Wider than element width -> default, never neighbour (100)
    expect(el1.getU64(0, 5n)).toBe(5n);

    const el0 = listGetStruct(list, 0);
    expect(el0.getU32(0)).toBe(100);
    expect(el0.getU16(0)).toBe(100); // LE low half
  });

  test("List(UInt8) upgrade: field @0 and oversize default", () => {
    const words = [
      wpMakeStruct(0, 0, 1),
      wpMakeList(0, ElemSize.Byte, 5),
      0n,
    ];
    const msg = msgFromWords(words);
    const seg = msg.segments[0]!;
    for (let i = 0; i < 5; i++) storeU8(seg, 16 + i, i + 1);

    const list = msg.root().getP(0);
    const el = list.listGetStruct(3);
    expect(el.kind).toBe(PtrKind.Struct);
    expect(el.dataBits).toBe(8);
    expect(el.getU8(0)).toBe(4);
    expect(el.getU16(0, 0xabcd)).toBe(0xabcd);
    expect(el.bodyByte).toBe(3);
  });

  test("List(pointer)/List(Text) upgrades to 0-data 1-pointer struct", () => {
    // Word 0: root struct 0d 1p
    // Word 1: List(ptr) count=1, content word 2
    // Word 2: pointer to Text at word 3
    // Word 3: "elem\0" (5 bytes)
    const words = [
      wpMakeStruct(0, 0, 1),
      wpMakeList(0, ElemSize.Pointer, 1),
      wpMakeList(0, ElemSize.Byte, 5),
      0n,
    ];
    const msg = msgFromWords(words);
    putText(msg.segments[0]!, 3, "elem");

    const list = msg.root().getP(0);
    expect(list.esize).toBe(ElemSize.Pointer);

    const el = list.listGetStruct(0);
    expect(el.kind).toBe(PtrKind.Struct);
    expect(el.dwords).toBe(0);
    expect(el.pwords).toBe(1);
    expect(el.getText(0)).toBe("elem");
  });
});

describe("list upgrade: Void allowed, Bool refused", () => {
  test("List(Bool) cannot upgrade", () => {
    const words = [
      wpMakeStruct(0, 0, 1),
      wpMakeList(0, ElemSize.Bit, 3),
      0n,
    ];
    const msg = msgFromWords(words);
    storeU8(msg.segments[0]!, 16, 0b101);

    const list = msg.root().getP(0);
    expect(list.esize).toBe(ElemSize.Bit);
    expect(list.listGetBool(0)).toBe(true);
    expect(list.listGetBool(1)).toBe(false);
    expect(list.listGetBool(2)).toBe(true);

    expect(() => list.listGetStruct(0)).toThrow(CapnpError);
    try {
      list.listGetStruct(0);
    } catch (e) {
      expect((e as CapnpError).code).toBe("KIND");
    }
  });

  test("List(Void) upgrades to zero-size struct (encoding.html)", () => {
    // encoding.html: any element size except bit may decode as struct list.
    const words = [
      wpMakeStruct(0, 0, 1),
      wpMakeList(0, ElemSize.Void, 42),
    ];
    const msg = msgFromWords(words);
    const list = msg.root().getP(0);
    expect(list.esize).toBe(ElemSize.Void);
    expect(list.listLen()).toBe(42);

    const el = list.listGetStruct(0);
    expect(el.kind).toBe(PtrKind.Struct);
    expect(el.dwords).toBe(0);
    expect(el.pwords).toBe(0);
    // Zero-size: field reads yield caller defaults.
    expect(el.getU32(0, 99)).toBe(99);
    expect(el.getU64(0, 7n)).toBe(7n);
    expect(list.listGetStruct(41).kind).toBe(PtrKind.Struct);
    expect(list.listGetU32(0, 99)).toBe(99);
  });
});

describe("cross-width primitive list demotion matrix", () => {
  function oneElemList(esize: number): Message {
    const words = [wpMakeStruct(0, 0, 1), wpMakeList(0, esize, 1), 0n];
    return msgFromWords(words);
  }

  test("numeric getters match field@0 struct-view semantics across 1/2/4/8-byte lists", () => {
    const dfltU8 = 0x11;
    const dfltU16 = 0x2222;
    const dfltU32 = 0x33333333;
    const dfltU64 = 0x4444444444444444n;
    const dfltF64 = 9.25;

    const m8 = oneElemList(ElemSize.Byte);
    storeU8(m8.segments[0]!, 16, 0xab);
    const l8 = m8.root().getP(0);
    expect(listGetU8(l8, 0, dfltU8)).toBe(0xab);
    expect(listGetU16(l8, 0, dfltU16)).toBe(dfltU16);
    expect(listGetU32(l8, 0, dfltU32)).toBe(dfltU32);
    expect(listGetU64(l8, 0, dfltU64)).toBe(dfltU64);
    expect(listGetF64(l8, 0, dfltF64)).toBe(dfltF64);

    const m16 = oneElemList(ElemSize.TwoBytes);
    storeU16(m16.segments[0]!, 16, 0xcdef);
    const l16 = m16.root().getP(0);
    expect(listGetU8(l16, 0, dfltU8)).toBe(0xef);
    expect(listGetU16(l16, 0, dfltU16)).toBe(0xcdef);
    expect(listGetU32(l16, 0, dfltU32)).toBe(dfltU32);
    expect(listGetU64(l16, 0, dfltU64)).toBe(dfltU64);
    expect(listGetF64(l16, 0, dfltF64)).toBe(dfltF64);

    const m32 = oneElemList(ElemSize.FourBytes);
    storeU32(m32.segments[0]!, 16, 0x89abcdef);
    const l32 = m32.root().getP(0);
    expect(listGetU8(l32, 0, dfltU8)).toBe(0xef);
    expect(listGetU16(l32, 0, dfltU16)).toBe(0xcdef);
    expect(listGetU32(l32, 0, dfltU32)).toBe(0x89abcdef >>> 0);
    expect(listGetU64(l32, 0, dfltU64)).toBe(dfltU64);
    expect(listGetF64(l32, 0, dfltF64)).toBe(dfltF64);

    const m64 = oneElemList(ElemSize.EightBytes);
    const piBits = 0x400921fb54442d18n;
    storeU64(m64.segments[0]!, 16, piBits);
    const l64 = m64.root().getP(0);
    expect(listGetU8(l64, 0, dfltU8)).toBe(0x18);
    expect(listGetU16(l64, 0, dfltU16)).toBe(0x2d18);
    expect(listGetU32(l64, 0, dfltU32)).toBe(0x54442d18);
    expect(listGetU64(l64, 0, dfltU64)).toBe(piBits);
    expect(listGetF64(l64, 0, dfltF64)).toBeCloseTo(Math.PI);
  });

  test("C++-compatible List(Bool) view accepts a non-bit data list", () => {
    const msg = msgFromWords([
      wpMakeStruct(0, 0, 1),
      wpMakeList(0, ElemSize.Byte, 3),
      0n,
    ]);
    // C++ ListReader<bool> ignores the source element step. It views the
    // first `listLen()` bits of the data area as packed Bool elements.
    storeU8(msg.segments[0]!, 16, 0b0000_0101);
    const list = msg.root().getP(0);

    expect(listGetBool(list, 0)).toBe(true);
    expect(listGetBool(list, 1)).toBe(false);
    expect(listGetBool(list, 2)).toBe(true);
  });
});

describe("list downgrade views (composite -> prim/Text field @0)", () => {
  test("List(Struct) downgrades to List(u32) and List(Text) at field @0", () => {
    // 0: root struct 0d 1p
    // 1: composite list, offset 0, word-count = 4 (2 elems * 2 words)
    // 2: tag: nelem=2, dwords=1, pwords=1
    // 3-4: elem0 data=1000, ptr -> text at 7
    // 5-6: elem1 data=1001, ptr -> text at 8
    // 7,8: "hello\0"
    const words = new Array<bigint>(9).fill(0n);
    words[0] = wpMakeStruct(0, 0, 1);
    words[1] = wpMakeList(0, ElemSize.Composite, 4);
    words[2] = wpMakeStruct(2, 1, 1);
    words[4] = wpMakeList(2, ElemSize.Byte, 6); // from word 4 -> word 7
    words[6] = wpMakeList(1, ElemSize.Byte, 6); // from word 6 -> word 8

    const msg = msgFromWords(words);
    const seg = msg.segments[0]!;
    storeU32(seg, 3 * 8, 1000);
    storeU32(seg, 5 * 8, 1001);
    putText(seg, 7, "hello");
    putText(seg, 8, "hello");

    const list = msg.root().getP(0);
    expect(list.kind).toBe(PtrKind.List);
    expect(list.esize).toBe(ElemSize.Composite);
    expect(list.listLen()).toBe(2);
    expect(list.dwords).toBe(1);
    expect(list.pwords).toBe(1);

    expect(listGetU32(list, 1)).toBe(1001);
    expect(listGetU32(list, 0)).toBe(1000);

    const el0 = listGetStruct(list, 0);
    expect(el0.kind).toBe(PtrKind.Struct);
    expect(el0.getU32(0)).toBe(1000);

    const q = el0.getP(0);
    expect(q.kind).toBe(PtrKind.List);
    expect(q.esize).toBe(ElemSize.Byte);

    expect(listGetText(list, 0)).toBe("hello");
    expect(listGetText(list, 1)).toBe("hello");
  });
});
