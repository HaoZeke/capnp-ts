/**
 * `isCanonical` cases checked against capnp-C++ 1.4.0.
 */
import { describe, expect, test } from "bun:test";
import { Message, isCanonical, wpMakeFar, wpMakeStruct } from "../src/index.ts";

function words(...ws: bigint[]): Uint8Array {
  const b = new Uint8Array(ws.length * 8);
  for (let i = 0; i < ws.length; i++) {
    const v = ws[i]!;
    const o = i * 8;
    b[o] = Number(v & 0xffn);
    b[o + 1] = Number((v >> 8n) & 0xffn);
    b[o + 2] = Number((v >> 16n) & 0xffn);
    b[o + 3] = Number((v >> 24n) & 0xffn);
    b[o + 4] = Number((v >> 32n) & 0xffn);
    b[o + 5] = Number((v >> 40n) & 0xffn);
    b[o + 6] = Number((v >> 48n) & 0xffn);
    b[o + 7] = Number((v >> 56n) & 0xffn);
  }
  return b;
}

describe("isCanonical against capnp 1.4.0", () => {
  test("a zero-sized list with a wild offset is canonical at the segment end", () => {
    const frame = new Uint8Array([
      0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x80, 0x00, 0x00, 0x03, 0x00, 0x00,
      0x00,
    ]);
    expect(isCanonical(Message.fromFlat(frame))).toBe(true);
  });

  test("a corrupt last pointer throws the capnp 1.4.0 text", () => {
    const struct = (second: bigint): Message =>
      Message.fromSegments([words(wpMakeStruct(0, 0, 1), second)]);
    expect(() => isCanonical(struct(wpMakeFar(false, 0, 5)))).toThrow(
      /far pointer to unknown segment/,
    );
    expect(() => isCanonical(struct(7n))).toThrow(
      "expected ptr->isCapability(); unknown pointer type",
    );
    expect(() => isCanonical(struct(wpMakeFar(true, 0, 0)))).toThrow(
      /double-far pointer to unknown segment/,
    );
    const landed = Message.fromSegments([
      words(wpMakeStruct(0, 0, 1), wpMakeFar(false, 2, 0), 2n),
    ]);
    expect(() => isCanonical(landed)).toThrow("far pointer not followed?");
  });
});
