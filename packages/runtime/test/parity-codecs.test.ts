/**
 * Differential cases checked against Cap'n Proto C++ 1.4.0.
 */

import { describe, expect, test } from "bun:test";
import {
  CapnpError,
  ElemSize,
  Message,
  storeU64,
  wpMakeList,
  wpMakeStruct,
} from "../src/index.ts";

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
