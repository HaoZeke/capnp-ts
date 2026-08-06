import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ElemSize,
  Message,
  PtrKind,
  serializeToFlat,
  storeU64,
  wpMakeFar,
  wpMakeList,
  wpMakeStruct,
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
  const people = book.getP(0);
  expect(people.kind).toBe(PtrKind.List);
  expect(people.esize).toBe(ElemSize.Composite);
  expect(people.listLen()).toBe(2);

  const alice = people.listGetP(0);
  expect(alice.getU32(0)).toBe(123);
  expect(alice.getU16(4)).toBe(EMP_SCHOOL);
  expect(alice.getText(0)).toBe("Alice");
  expect(alice.getText(1)).toBe("alice@example.com");
  expect(alice.getText(3)).toBe("MIT");
  const aPhones = alice.getP(2);
  expect(aPhones.listLen()).toBe(1);
  const ap0 = aPhones.listGetP(0);
  expect(ap0.getU16(0)).toBe(PHONE_MOBILE);
  expect(ap0.getText(0)).toBe("555-1212");

  const bob = people.listGetP(1);
  expect(bob.getU32(0)).toBe(456);
  expect(bob.getU16(4)).toBe(EMP_UNEMPLOYED);
  expect(bob.getText(0)).toBe("Bob");
  expect(bob.getText(1)).toBe("bob@example.com");
  const bPhones = bob.getP(2);
  expect(bPhones.listLen()).toBe(2);
  expect(bPhones.listGetP(0).getU16(0)).toBe(PHONE_HOME);
  expect(bPhones.listGetP(0).getText(0)).toBe("555-4567");
  expect(bPhones.listGetP(1).getU16(0)).toBe(PHONE_WORK);
  expect(bPhones.listGetP(1).getText(0)).toBe("555-7654");
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
    storeU64(seg0, 0, wpMakeFar(true, 0, 1));
    storeU64(seg1, 0, wpMakeFar(false, 0, 2));
    storeU64(seg1, 8, wpMakeStruct(0, 1, 0));
    storeU64(seg2, 0, 4242n);

    const msg = Message.fromSegments([
      { data: seg0, words: 1 },
      { data: seg1, words: 2 },
      { data: seg2, words: 1 },
    ]);
    const r = msg.root();
    expect(r.kind).toBe(PtrKind.Struct);
    expect(r.getU64(0)).toBe(4242n);

    const framed = serializeToFlat(msg);
    const again = Message.fromFlat(framed);
    expect(again.segmentCount).toBe(3);
    expect(again.root().getU64(0)).toBe(4242n);
  });

  test("double-far nested struct and List(Text) fixture", () => {
    // seg0: double-far → pad in seg1
    // seg1 pad: far → body in seg2; tag struct 0d 2p
    // seg2: body [p0 far→nested in seg3][p1 far→List(Text) in seg3]
    // seg3: nested struct 1d0p = 0xbeef; List(Text) landing + content; texts
    const seg0 = new Uint8Array(8);
    const seg1 = new Uint8Array(16);
    const seg2 = new Uint8Array(16);
    const seg3 = new Uint8Array(8 * 10);

    storeU64(seg0, 0, wpMakeFar(true, 0, 1));
    storeU64(seg1, 0, wpMakeFar(false, 0, 2));
    storeU64(seg1, 8, wpMakeStruct(0, 0, 2));

    // Root body in seg2: two far single pads into seg3.
    storeU64(seg2, 0, wpMakeFar(false, 1, 3)); // pad at seg3 word 1 → nested
    storeU64(seg2, 8, wpMakeFar(false, 3, 3)); // pad at seg3 word 3 → List(Text)

    // seg3 layout:
    // 0: nested data word 0xbeef
    // 1: landing pad struct(0, 1, 0) offset -2 → word 0
    // 2: reserved / list content starts later
    // 3: landing pad list(pointer, 2) offset 0 → word 4
    // 4-5: List(Text) elements → text at 6 and 8
    // 6-7: "hi\0"
    // 8-9: "far\0"
    storeU64(seg3, 0, 0xbeefn);
    storeU64(seg3, 8, wpMakeStruct(-2, 1, 0));
    storeU64(seg3, 24, wpMakeList(0, ElemSize.Pointer, 2));
    storeU64(seg3, 32, wpMakeList(1, ElemSize.Byte, 3)); // word 4 → word 6, "hi\0"
    storeU64(seg3, 40, wpMakeList(2, ElemSize.Byte, 4)); // word 5 → word 8, "far\0"
    // text bytes
    seg3[48] = 0x68; // h
    seg3[49] = 0x69; // i
    seg3[50] = 0;
    seg3[64] = 0x66; // f
    seg3[65] = 0x61; // a
    seg3[66] = 0x72; // r
    seg3[67] = 0;

    const msg = Message.fromSegments([
      { data: seg0, words: 1 },
      { data: seg1, words: 2 },
      { data: seg2, words: 2 },
      { data: seg3, words: 10 },
    ]);
    const root = msg.root();
    expect(root.kind).toBe(PtrKind.Struct);
    expect(root.pwords).toBe(2);
    expect(root.getP(0).getU64(0)).toBe(0xbeefn);
    const texts = root.getP(1);
    expect(texts.kind).toBe(PtrKind.List);
    expect(texts.esize).toBe(ElemSize.Pointer);
    expect(texts.listLen()).toBe(2);
    expect(texts.listGetText(0)).toBe("hi");
    expect(texts.listGetText(1)).toBe("far");

    const again = Message.fromFlat(serializeToFlat(msg));
    expect(again.segmentCount).toBe(4);
    expect(again.root().getP(0).getU64(0)).toBe(0xbeefn);
    expect(again.root().getP(1).listGetText(1)).toBe("far");
  });
});
