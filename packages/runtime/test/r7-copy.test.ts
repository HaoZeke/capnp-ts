/**
 * List copy against capnp-C++ 1.4.0 `setListPointer`.
 */
import { describe, expect, test } from "bun:test";
import { ElemSize, Message, MessageBuilder, deepCopyPtr, wpMakeList } from "../src/index.ts";

function words(...ws: bigint[]): Uint8Array {
  const b = new Uint8Array(ws.length * 8);
  for (let i = 0; i < ws.length; i++) {
    const v = ws[i]!;
    const o = i * 8;
    for (let k = 0; k < 8; k++) b[o + k] = Number((v >> BigInt(k * 8)) & 0xffn);
  }
  return b;
}

describe("copy against capnp 1.4.0", () => {
  test("a copied bit list drops slack bits in the last byte", () => {
    const src = Message.fromSegments([words(wpMakeList(0, ElemSize.Bit, 3), 0xfdn)]);
    const dst = new MessageBuilder();
    deepCopyPtr(src.root(), dst, dst.rootSlot());
    const out = Message.fromFlat(dst.toFlat());
    expect(out.segments[0]![8]).toBe(0x05);
  });
});
