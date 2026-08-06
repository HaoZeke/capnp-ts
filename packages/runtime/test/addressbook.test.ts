/**
 * Decode the standard Cap'n Proto addressbook golden fixture.
 *
 * Person layout (addressbook.capnp):
 *   id @0 :UInt32          — data byte 0
 *   name @1 :Text          — pointer 0
 *   email @2 :Text         — pointer 1
 *   phones @3 :List(...)   — pointer 2
 *   employment union @4    — discriminant at data byte 4; text at pointer 3
 *
 * AddressBook: people @0 :List(Person) — composite list at pointer 0.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Message, PtrKind, serializeToFlat } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = join(here, "golden", "addressbook.bin");

function loadGolden(): Uint8Array {
  return new Uint8Array(readFileSync(goldenPath));
}

describe("addressbook.bin", () => {
  test("fromFlat: people length 2, Alice and Bob fields", () => {
    const bytes = loadGolden();
    const msg = Message.fromFlat(bytes);
    const root = msg.root();
    expect(root.kind).toBe(PtrKind.Struct);

    // AddressBook.people @0
    const people = root.getP(0);
    expect(people.kind).toBe(PtrKind.List);
    expect(people.listLen()).toBe(2);

    // Person[0] Alice
    const alice = people.listGetP(0);
    expect(alice.kind).toBe(PtrKind.Struct);
    expect(alice.getU32(0)).toBe(123);
    expect(alice.getText(0)).toBe("Alice");
    expect(alice.getText(1)).toBe("alice@example.com");

    // Person[1] Bob
    const bob = people.listGetP(1);
    expect(bob.kind).toBe(PtrKind.Struct);
    expect(bob.getU32(0)).toBe(456);
    expect(bob.getText(0)).toBe("Bob");
    expect(bob.getText(1)).toBe("bob@example.com");
  });

  test("viewFlat zero-copy matches fromFlat", () => {
    const bytes = loadGolden();
    const view = Message.viewFlat(bytes);
    const root = view.root();
    const people = root.getP(0);
    expect(people.listLen()).toBe(2);
    expect(people.listGetP(0).getText(0)).toBe("Alice");
    expect(people.listGetP(1).getU32(0)).toBe(456);
  });

  test("serializeToFlat round-trip preserves decode", () => {
    const bytes = loadGolden();
    const msg = Message.fromFlat(bytes);
    const flat = serializeToFlat(msg);
    const again = Message.fromFlat(flat);
    const people = again.root().getP(0);
    expect(people.listLen()).toBe(2);
    expect(people.listGetP(0).getU32(0)).toBe(123);
    expect(people.listGetP(0).getText(0)).toBe("Alice");
    expect(people.listGetP(1).getU32(0)).toBe(456);
  });
});
