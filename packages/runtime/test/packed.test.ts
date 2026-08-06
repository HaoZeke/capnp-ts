import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
});
