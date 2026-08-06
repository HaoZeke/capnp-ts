import { describe, expect, test } from "bun:test";
import {
  BuilderPointer,
  deepCopyPtrToSlot,
  ElemSize,
  Message,
  MessageBuilder,
  PtrKind,
  StructBuilder,
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

/** Write List(Text) element i via a 0-data / 1-pointer slot view. */
function setListText(
  b: MessageBuilder,
  listStart: BuilderPointer,
  index: number,
  text: string,
): void {
  const view = new StructBuilder(
    b,
    listStart.seg,
    listStart.word + index,
    0,
    1,
  );
  view.setText(0, text);
}

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

  test("nested structs across segments", () => {
    // Small first segment so each child spills: root(1p) → A(1d1p) → B(1d1p) → C(2d).
    const b = new MessageBuilder({ firstWords: 2 });
    const root = b.initRoot(0, 1);
    const a = root.initStruct(0, 1, 1);
    a.setU64(0, 0xa1n);
    const bNode = a.initStruct(0, 1, 1);
    bNode.setU64(0, 0xb2n);
    const c = bNode.initStruct(0, 2, 0);
    c.setU64(0, 0xc3n);
    c.setU64(8, 0xc4n);

    expect(b.segmentCount).toBeGreaterThanOrEqual(3);
    expect(new Set([root.seg, a.seg, bNode.seg, c.seg]).size).toBeGreaterThan(
      1,
    );

    // Far landing pads wherever parent and child segments diverge.
    if (root.seg !== a.seg) {
      const w = loadU64(b.segmentData(root.seg), root.slot(0).word * 8);
      expect(wpKind(w)).toBe(WireKind.Far);
    }
    if (a.seg !== bNode.seg) {
      const w = loadU64(b.segmentData(a.seg), a.slot(0).word * 8);
      expect(wpKind(w)).toBe(WireKind.Far);
    }
    if (bNode.seg !== c.seg) {
      const w = loadU64(b.segmentData(bNode.seg), bNode.slot(0).word * 8);
      expect(wpKind(w)).toBe(WireKind.Far);
    }

    const msg = Message.fromFlat(b.toFlat());
    expect(msg.segmentCount).toBeGreaterThanOrEqual(3);
    const ra = msg.root().getP(0);
    expect(ra.getU64(0)).toBe(0xa1n);
    const rb = ra.getP(0);
    expect(rb.getU64(0)).toBe(0xb2n);
    const rc = rb.getP(0);
    expect(rc.getU64(0)).toBe(0xc3n);
    expect(rc.getU64(8)).toBe(0xc4n);
  });

  test("List(Text) far across segments", () => {
    const labels = [
      "alpha",
      "x".repeat(80),
      "beta-with-suffix",
      "y".repeat(120),
      "gamma",
      "",
      "z".repeat(40),
    ];
    // firstWords tiny: list body and each text payload spill.
    const b = new MessageBuilder({ firstWords: 3 });
    const root = b.initRoot(0, 1);
    const listStart = root.initPointerList(0, labels.length);
    for (let i = 0; i < labels.length; i++) {
      setListText(b, listStart, i, labels[i]!);
    }
    expect(b.segmentCount).toBeGreaterThanOrEqual(2);

    // At least one text slot should be a far pointer when payload left the list seg.
    let farTextSlots = 0;
    for (let i = 0; i < labels.length; i++) {
      const w = loadU64(
        b.segmentData(listStart.seg),
        (listStart.word + i) * 8,
      );
      if (wpKind(w) === WireKind.Far) farTextSlots++;
    }
    expect(farTextSlots).toBeGreaterThan(0);

    const msg = Message.fromFlat(b.toFlat());
    const list = msg.root().getP(0);
    expect(list.kind).toBe(PtrKind.List);
    expect(list.esize).toBe(ElemSize.Pointer);
    expect(list.listLen()).toBe(labels.length);
    for (let i = 0; i < labels.length; i++) {
      expect(list.listGetText(i)).toBe(labels[i]!);
      expect(list.listGetStruct(i).getText(0)).toBe(labels[i]!);
    }
  });

  test("multi-segment far stress graph", () => {
    // Root: 0d 3p
    //   p0: composite list of nodes (1d 2p each): id + name(Text) + tags(List(Text))
    //   p1: nested chain A→B→leaf text
    //   p2: long blob List(Text) of varying sizes
    const b = new MessageBuilder({ firstWords: 4 });
    const root = b.initRoot(0, 3);

    const NODE_D = 1;
    const NODE_P = 2;
    const nNodes = 5;
    let node = root.initList(0, nNodes, NODE_D, NODE_P);
    const nodeNames: string[] = [];
    const nodeTags: string[][] = [];
    for (let i = 0; i < nNodes; i++) {
      if (i > 0) node = node.nextElement();
      const id = 1000 + i;
      node.setU32(0, id);
      const name = `node-${i}-${"n".repeat(10 + i * 7)}`;
      nodeNames.push(name);
      node.setText(0, name);
      const tags = [`t${i}a`, "x".repeat(30 + i * 11), `t${i}c`];
      nodeTags.push(tags);
      const tagList = node.initPointerList(1, tags.length);
      for (let t = 0; t < tags.length; t++) {
        setListText(b, tagList, t, tags[t]!);
      }
    }

    const chain = root.initStruct(1, 1, 1);
    chain.setU64(0, 0xdeadn);
    const mid = chain.initStruct(0, 0, 1);
    mid.setText(0, "mid-".repeat(25));

    const blobCount = 6;
    const blobs: string[] = [];
    const blobList = root.initPointerList(2, blobCount);
    for (let i = 0; i < blobCount; i++) {
      const s = `blob${i}:` + "p".repeat(15 + i * 17);
      blobs.push(s);
      setListText(b, blobList, i, s);
    }

    expect(b.segmentCount).toBeGreaterThanOrEqual(3);

    // Spot-check: list pointer from root is far if composite body left seg 0.
    const peopleSlotW = loadU64(b.segmentData(root.seg), root.slot(0).word * 8);
    if (root.seg !== node.seg) {
      expect(wpKind(peopleSlotW)).toBe(WireKind.Far);
    }

    const flat = b.toFlat();
    const msg = Message.fromFlat(flat);
    expect(msg.segmentCount).toBe(b.segmentCount);

    const r = msg.root();
    const nodes = r.getP(0);
    expect(nodes.listLen()).toBe(nNodes);
    expect(nodes.esize).toBe(ElemSize.Composite);
    for (let i = 0; i < nNodes; i++) {
      const el = nodes.listGetP(i);
      expect(el.getU32(0)).toBe(1000 + i);
      expect(el.getText(0)).toBe(nodeNames[i]!);
      const tags = el.getP(1);
      expect(tags.listLen()).toBe(nodeTags[i]!.length);
      for (let t = 0; t < nodeTags[i]!.length; t++) {
        expect(tags.listGetText(t)).toBe(nodeTags[i]![t]!);
      }
    }

    const rChain = r.getP(1);
    expect(rChain.getU64(0)).toBe(0xdeadn);
    expect(rChain.getP(0).getText(0)).toBe("mid-".repeat(25));

    const rBlobs = r.getP(2);
    expect(rBlobs.listLen()).toBe(blobCount);
    for (let i = 0; i < blobCount; i++) {
      expect(rBlobs.listGetText(i)).toBe(blobs[i]!);
    }

    // Re-frame and read again (reader multi-seg path).
    const again = Message.fromFlat(msg.copyFlat());
    expect(again.root().getP(0).listGetP(3).getText(0)).toBe(nodeNames[3]!);
    expect(again.root().getP(2).listGetText(blobCount - 1)).toBe(
      blobs[blobCount - 1]!,
    );
  });

  test("double-far chain with List(Text) leaf", () => {
    const b = new MessageBuilder({ firstWords: 3 });
    const root = b.initRoot(0, 1);
    const slot = root.slot(0);

    // First spill establishes a second segment.
    const spill = b.initStructAt(slot, 2, 0);
    expect(spill.seg).not.toBe(slot.seg);
    b.segBytes(slot.seg).fill(0, slot.word * 8, slot.word * 8 + 8);

    // Force double-far for a 0d/1p holder (pad cannot join object seg).
    b.maxSegWords = 1;
    const holder = b.initStructAt(slot, 0, 1);
    expect(wpFarTwo(loadU64(b.segmentData(slot.seg), slot.word * 8))).toBe(
      true,
    );

    // Lift cap so List(Text) + text payloads can allocate (new segs allowed).
    b.maxSegWords = 0;
    const texts = ["df-a", "q".repeat(64), "df-c"];
    const listStart = holder.initPointerList(0, texts.length);
    for (let i = 0; i < texts.length; i++) {
      setListText(b, listStart, i, texts[i]!);
    }

    const msg = Message.fromFlat(b.toFlat());
    expect(msg.segmentCount).toBeGreaterThanOrEqual(3);
    const list = msg.root().getP(0).getP(0);
    expect(list.listLen()).toBe(texts.length);
    for (let i = 0; i < texts.length; i++) {
      expect(list.listGetText(i)).toBe(texts[i]!);
    }
  });

  test("setData round-trip", () => {
    const b = new MessageBuilder();
    const root = b.initRoot(0, 1);
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    root.setData(0, payload);
    const msg = Message.fromFlat(b.toFlat());
    expect([...msg.root().getData(0)]).toEqual([1, 2, 3, 4, 5]);
  });

  test("deep-copy setP: nested AddressBook across messages", () => {
    const src = Message.fromFlat(buildAliceBob());
    verifyAliceBob(src.root());

    // New message; deep-copy people list into AddressBook-shaped root.
    const dest = new MessageBuilder();
    const book = dest.initRoot(0, 1);
    book.setP(0, src.root().getP(0));

    const copied = Message.fromFlat(dest.toFlat());
    verifyAliceBob(copied.root());
    // Source message is independent and still intact.
    verifyAliceBob(src.root());
  });

  test("deep-copy deepCopyPtrToSlot: whole AddressBook root into empty builder", () => {
    const src = Message.fromFlat(buildAliceBob());
    const dest = new MessageBuilder();
    deepCopyPtrToSlot(dest, dest.rootSlot(), src.root());
    const msg = Message.fromFlat(dest.toFlat());
    verifyAliceBob(msg.root());
  });

  test("orphan: disown text, null after disown, re-adopt elsewhere", () => {
    const b = new MessageBuilder();
    const root = b.initRoot(0, 2);
    root.setText(0, "hello-orphan");

    const orphan = root.disown(0);
    expect(orphan.isNull).toBe(false);
    expect(orphan.kind).toBe(PtrKind.List);
    expect(orphan.esize).toBe(ElemSize.Byte);

    // Original slot is cleared (null on the wire).
    const afterDisown = Message.fromFlat(b.toFlat());
    expect(afterDisown.root().getP(0).kind).toBe(PtrKind.Null);
    expect(afterDisown.root().getP(1).kind).toBe(PtrKind.Null);
    expect(afterDisown.root().getText(0)).toBe("");

    // Adopt into a different slot without copying content.
    root.adopt(1, orphan);
    const afterAdopt = Message.fromFlat(b.toFlat());
    expect(afterAdopt.root().getP(0).kind).toBe(PtrKind.Null);
    expect(afterAdopt.root().getText(1)).toBe("hello-orphan");
  });

  test("orphan: disown struct, adopt into sibling slot (parity)", () => {
    const b = new MessageBuilder();
    const root = b.initRoot(0, 2);
    const kid = root.initStruct(0, 1, 0);
    kid.setU64(0, 555n);

    const orphan = root.disown(0);
    expect(orphan.isNull).toBe(false);
    expect(orphan.kind).toBe(PtrKind.Struct);

    const cleared = Message.fromFlat(b.toFlat());
    expect(cleared.root().getP(0).kind).toBe(PtrKind.Null);

    root.adopt(1, orphan);
    const msg = Message.fromFlat(b.toFlat());
    expect(msg.root().getP(0).kind).toBe(PtrKind.Null);
    expect(msg.root().getP(1).kind).toBe(PtrKind.Struct);
    expect(msg.root().getP(1).getU64(0)).toBe(555n);
  });

  test("orphan: disown null yields null orphan", () => {
    const b = new MessageBuilder();
    const root = b.initRoot(0, 1);
    const orphan = root.disown(0);
    expect(orphan.isNull).toBe(true);
    root.adopt(0, orphan);
    expect(Message.fromFlat(b.toFlat()).root().getP(0).kind).toBe(PtrKind.Null);
  });
});
