import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ElementSize,
  Message,
  PtrKind,
  makeFar,
  makeStruct,
  storeU64,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const golden = join(here, "golden", "addressbook.bin");

const EMP_UNEMPLOYED = 0;
const EMP_SCHOOL = 2;
const PHONE_MOBILE = 0;
const PHONE_HOME = 1;
const PHONE_WORK = 2;

function verifyAliceBob(book: ReturnType<Message["root"]>): void {
  expect(book.kind).toBe(PtrKind.Struct);
  const people = book.getp(0);
  expect(people.kind).toBe(PtrKind.List);
  expect(people.esize).toBe(ElementSize.Composite);
  expect(people.listLen()).toBe(2);

  const alice = people.listGetp(0);
  expect(alice.getU32(0)).toBe(123);
  expect(alice.getU16(4)).toBe(EMP_SCHOOL);
  expect(alice.getText(0)).toBe("Alice");
  expect(alice.getText(1)).toBe("alice@example.com");
  expect(alice.getText(3)).toBe("MIT");
  const aPhones = alice.getp(2);
  expect(aPhones.listLen()).toBe(1);
  const ap0 = aPhones.listGetp(0);
  expect(ap0.getU16(0)).toBe(PHONE_MOBILE);
  expect(ap0.getText(0)).toBe("555-1212");

  const bob = people.listGetp(1);
  expect(bob.getU32(0)).toBe(456);
  expect(bob.getU16(4)).toBe(EMP_UNEMPLOYED);
  expect(bob.getText(0)).toBe("Bob");
  expect(bob.getText(1)).toBe("bob@example.com");
  const bPhones = bob.getp(2);
  expect(bPhones.listLen()).toBe(2);
  expect(bPhones.listGetp(0).getU16(0)).toBe(PHONE_HOME);
  expect(bPhones.listGetp(0).getText(0)).toBe("555-4567");
  expect(bPhones.listGetp(1).getU16(0)).toBe(PHONE_WORK);
  expect(bPhones.listGetp(1).getText(0)).toBe("555-7654");
}

describe("Message reader", () => {
  test("decode addressbook.bin golden Alice/Bob", () => {
    const bin = readFileSync(golden);
    const msg = Message.fromFlat(new Uint8Array(bin));
    verifyAliceBob(msg.root());
  });

  test("viewFlat zero-copy matches fromFlat", () => {
    const bin = new Uint8Array(readFileSync(golden));
    const msg = Message.viewFlat(bin);
    verifyAliceBob(msg.root());
  });

  test("double-far fixture root", () => {
    const seg0 = new Uint8Array(8);
    const seg1 = new Uint8Array(16);
    const seg2 = new Uint8Array(8);
    storeU64(seg0, 0, makeFar(true, 0, 1));
    storeU64(seg1, 0, makeFar(false, 0, 2));
    storeU64(seg1, 8, makeStruct(0, 1, 0));
    storeU64(seg2, 0, 4242n);

    const msg = Message.fromSegments([
      { data: seg0, words: 1 },
      { data: seg1, words: 2 },
      { data: seg2, words: 1 },
    ]);
    const r = msg.root();
    expect(r.kind).toBe(PtrKind.Struct);
    expect(r.getU64(0)).toBe(4242n);

    const framed = msg.copyFlat();
    const again = Message.fromFlat(framed);
    expect(again.segmentCount).toBe(3);
    expect(again.root().getU64(0)).toBe(4242n);
  });
});
