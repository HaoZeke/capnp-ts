import { describe, expect, test } from "bun:test";
import {
  ElemSize,
  Message,
  MessageBuilder,
  PtrKind,
  WireKind,
  loadU64,
  wpFarTwo,
  wpKind,
} from "../src/index.ts";

const PERSON_D = 1;
const PERSON_P = 4;
const PHONE_D = 1;
const PHONE_P = 1;

const EMP_UNEMPLOYED = 0;
const EMP_SCHOOL = 2;
const PHONE_MOBILE = 0;
const PHONE_HOME = 1;
const PHONE_WORK = 2;

function buildAliceBob(): Uint8Array {
  const b = new MessageBuilder();
  const book = b.initRoot(0, 1);
  const people0 = book.initList(0, 2, PERSON_D, PERSON_P);

  people0.setU32(0, 123);
  people0.setU16(4, EMP_SCHOOL);
  people0.setText(0, "Alice");
  people0.setText(1, "alice@example.com");
  people0.setText(3, "MIT");
  const phones0 = people0.initList(2, 1, PHONE_D, PHONE_P);
  phones0.setU16(0, PHONE_MOBILE);
  phones0.setText(0, "555-1212");

  const bob = people0.nextElement();
  bob.setU32(0, 456);
  bob.setU16(4, EMP_UNEMPLOYED);
  bob.setText(0, "Bob");
  bob.setText(1, "bob@example.com");
  const phones1 = bob.initList(2, 2, PHONE_D, PHONE_P);
  phones1.setU16(0, PHONE_HOME);
  phones1.setText(0, "555-4567");
  const p1 = phones1.nextElement();
  p1.setU16(0, PHONE_WORK);
  p1.setText(0, "555-7654");

  return b.toFlat();
}

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
  expect(aPhones.listGetP(0).getU16(0)).toBe(PHONE_MOBILE);
  expect(aPhones.listGetP(0).getText(0)).toBe("555-1212");

  const bob = people.listGetP(1);
  expect(bob.getU32(0)).toBe(456);
  expect(bob.getU16(4)).toBe(EMP_UNEMPLOYED);
  expect(bob.getText(0)).toBe("Bob");
  expect(bob.getText(1)).toBe("bob@example.com");
  const bPhones = bob.getP(2);
  expect(bPhones.listLen()).toBe(2);
  expect(bPhones.listGetP(0).getText(0)).toBe("555-4567");
  expect(bPhones.listGetP(1).getText(0)).toBe("555-7654");
  expect(bPhones.listGetP(0).getU16(0)).toBe(PHONE_HOME);
  expect(bPhones.listGetP(1).getU16(0)).toBe(PHONE_WORK);
}

describe("MessageBuilder", () => {
  test("AddressBook Alice/Bob build → serialize → decode", () => {
    const flat = buildAliceBob();
    const msg = Message.fromFlat(flat);
    verifyAliceBob(msg.root());
  });

  test("far pointer when object spills to next segment", () => {
    const b = new MessageBuilder({ firstWords: 3 });
    const body = b.initRoot(0, 1);
    const kidSlot = body.slot(0);
    const kid = b.initStructAt(kidSlot, 2, 0);
    expect(b.segmentCount).toBeGreaterThanOrEqual(2);
    expect(body.seg).not.toBe(kid.seg);
    kid.setU64(0, 111n);
    kid.setU64(8, 222n);

    const slotW = loadU64(b.segmentData(kidSlot.seg), kidSlot.word * 8);
    expect(wpKind(slotW)).toBe(WireKind.Far);
    expect(wpFarTwo(slotW)).toBe(false);

    const msg = Message.fromFlat(b.toFlat());
    expect(msg.segmentCount).toBeGreaterThanOrEqual(2);
    const k = msg.root().getP(0);
    expect(k.kind).toBe(PtrKind.Struct);
    expect(k.getU64(0)).toBe(111n);
    expect(k.getU64(8)).toBe(222n);
  });

  test("far text across segments", () => {
    const longtxt = "x".repeat(199);
    const b = new MessageBuilder({ firstWords: 4 });
    const body = b.initRoot(0, 1);
    body.setText(0, longtxt);
    expect(b.segmentCount).toBeGreaterThanOrEqual(2);
    const msg = Message.fromFlat(b.toFlat());
    expect(msg.root().getText(0)).toBe(longtxt);
  });

  test("double-far when pad cannot join object segment", () => {
    const b = new MessageBuilder({ firstWords: 3 });
    const body = b.initRoot(0, 1);
    const slot = body.slot(0);

    const spill = b.initStructAt(slot, 2, 0);
    expect(spill.seg).not.toBe(slot.seg);

    b.segBytes(slot.seg).fill(0, slot.word * 8, slot.word * 8 + 8);
    b.maxSegWords = 1;
    const obj = b.initStructAt(slot, 1, 0);
    expect(obj.seg).not.toBe(slot.seg);
    obj.setU64(0, 4242n);

    const w = loadU64(b.segmentData(slot.seg), slot.word * 8);
    expect(wpKind(w)).toBe(WireKind.Far);
    expect(wpFarTwo(w)).toBe(true);

    const msg = Message.fromFlat(b.toFlat());
    expect(msg.root().getP(0).getU64(0)).toBe(4242n);
  });

  test("setData round-trip", () => {
    const b = new MessageBuilder();
    const root = b.initRoot(0, 1);
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    root.setData(0, payload);
    const msg = Message.fromFlat(b.toFlat());
    expect([...msg.root().getData(0)]).toEqual([1, 2, 3, 4, 5]);
  });
});
