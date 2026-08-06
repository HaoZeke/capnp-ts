import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CapnpError } from "../src/kinds.ts";
import { pack, unpack } from "../src/packed.ts";

const golden = (name: string) =>
  new Uint8Array(readFileSync(join(import.meta.dir, "golden", name)));

describe("packed codec", () => {
  test("spec vector from encoding.html", () => {
    const unpacked = Uint8Array.from([
      0x08, 0x00, 0x00, 0x00, 0x03, 0x00, 0x02, 0x00, 0x19, 0x00, 0x00, 0x00, 0xaa, 0x01, 0x00,
      0x00,
    ]);
    const expected = Uint8Array.from([0x51, 0x08, 0x03, 0x02, 0x31, 0x19, 0xaa, 0x01]);
    expect([...pack(unpacked)]).toEqual([...expected]);
    expect([...unpack(expected)]).toEqual([...unpacked]);
  });

  test("AddressBook pack byte-identical to CLI golden", () => {
    const bin = golden("addressbook.bin");
    const packed = golden("addressbook.packed.bin");
    expect([...pack(bin)]).toEqual([...packed]);
  });

  test("AddressBook unpack packed golden", () => {
    const bin = golden("addressbook.bin");
    const packed = golden("addressbook.packed.bin");
    expect([...unpack(packed)]).toEqual([...bin]);
  });

  test("unpack rejects packed amplification bomb with PACKED", () => {
    // Each 0x00 0xff expands to 256 zero words (tag word + 255 more).
    // With a tight maxWords, a short packed stream must not allocate huge.
    const bomb = new Uint8Array(64);
    for (let i = 0; i < bomb.length; i += 2) {
      bomb[i] = 0x00;
      bomb[i + 1] = 0xff;
    }
    try {
      unpack(bomb, { maxWords: 16 });
      expect.unreachable("expected CapnpError PACKED");
    } catch (e) {
      expect(e).toBeInstanceOf(CapnpError);
      expect((e as CapnpError).code).toBe("PACKED");
    }
  });
});
