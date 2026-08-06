import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pack, unpack } from "../src/packed.ts";

const goldenDir = join(dirname(fileURLToPath(import.meta.url)), "golden");

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

describe("capnp packed codec", () => {
  test("spec vector: two words pack to documented bytes", () => {
    const unpacked = Uint8Array.from([
      0x08, 0x00, 0x00, 0x00, 0x03, 0x00, 0x02, 0x00, 0x19, 0x00, 0x00, 0x00,
      0xaa, 0x01, 0x00, 0x00,
    ]);
    const expected = Uint8Array.from([
      0x51, 0x08, 0x03, 0x02, 0x31, 0x19, 0xaa, 0x01,
    ]);
    const packed = pack(unpacked);
    expect(hex(packed)).toBe(hex(expected));
    expect(pack(unpacked)).toEqual(expected);
    expect(unpack(packed)).toEqual(unpacked);
  });

  test("roundtrip addressbook.bin pack equals addressbook.packed.bin", () => {
    const bin = new Uint8Array(
      readFileSync(join(goldenDir, "addressbook.bin")),
    );
    const packedGolden = new Uint8Array(
      readFileSync(join(goldenDir, "addressbook.packed.bin")),
    );
    const packed = pack(bin);
    expect(hex(packed)).toBe(hex(packedGolden));
    expect(packed).toEqual(packedGolden);
  });

  test("unpack(addressbook.packed.bin) equals addressbook.bin", () => {
    const bin = new Uint8Array(
      readFileSync(join(goldenDir, "addressbook.bin")),
    );
    const packedGolden = new Uint8Array(
      readFileSync(join(goldenDir, "addressbook.packed.bin")),
    );
    const unpacked = unpack(packedGolden);
    expect(unpacked).toEqual(bin);
  });
});
