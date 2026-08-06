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
  listGetStruct,
  listGetText,
  listGetU32,
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

describe("list upgrade refused (Bool / Void)", () => {
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

  test("List(Void) cannot upgrade; length only", () => {
    const words = [
      wpMakeStruct(0, 0, 1),
      wpMakeList(0, ElemSize.Void, 42),
    ];
    const msg = msgFromWords(words);
    const list = msg.root().getP(0);
    expect(list.esize).toBe(ElemSize.Void);
    expect(list.listLen()).toBe(42);
    expect(() => list.listGetStruct(0)).toThrow(CapnpError);
    expect(list.listGetU32(0, 99)).toBe(99);
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
