/**
 * Text and Data edge cases: empty values, trailing-NUL rules, length
 * boundaries, and nested List(List(Text)) via pointer lists.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BuilderPointer,
  CapnpError,
  DynamicStruct,
  SchemaLoader,
  ElemSize,
  Message,
  MessageBuilder,
  PtrKind,
  StructBuilder,
  storeU64,
  storeU8,
  wpMakeList,
  wpMakeStruct,
} from "../src/index.ts";

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

/** Init List(Text) at pointer slot index of a 0d/1p view over a pointer word. */
function initPointerListAt(
  b: MessageBuilder,
  listStart: BuilderPointer,
  index: number,
  count: number,
): BuilderPointer {
  const view = new StructBuilder(
    b,
    listStart.seg,
    listStart.word + index,
    0,
    1,
  );
  return view.initPointerList(0, count);
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const hasCapnp = spawnSync("capnp", ["--version"]).status === 0;

function msgFromWords(words: bigint[]): Message {
  const buf = new Uint8Array(words.length * 8);
  for (let i = 0; i < words.length; i++) {
    storeU64(buf, i * 8, words[i]!);
  }
  return Message.fromSegments([buf]);
}

describe("text and data edge cases", () => {
  test("empty text: builder emits count=1 (NUL only); getText is empty", () => {
    const b = new MessageBuilder();
    const root = b.initRoot(0, 1);
    root.setText(0, "");
    const msg = Message.fromFlat(b.toFlat());
    const r = msg.root();
    expect(r.getText(0)).toBe("");
    const tl = r.getP(0);
    expect(tl.kind).toBe(PtrKind.List);
    expect(tl.esize).toBe(ElemSize.Byte);
    // Cap'n Proto Text wire count includes the trailing NUL.
    expect(tl.listLen()).toBe(1);
  });

  test("null / absent text pointer reads as empty string", () => {
    const b = new MessageBuilder();
    // Two pointer slots; only slot 0 is filled.
    const root = b.initRoot(0, 2);
    root.setText(0, "present");
    const msg = Message.fromFlat(b.toFlat());
    expect(msg.root().getText(0)).toBe("present");
    expect(msg.root().getText(1)).toBe("");
    expect(msg.root().getText(1, "schema default")).toBe("schema default");
    expect(msg.root().getP(1).kind).toBe(PtrKind.Null);
  });

  test("empty data: zero-length blob round-trip", () => {
    const b = new MessageBuilder();
    const root = b.initRoot(0, 1);
    root.setData(0, new Uint8Array(0));
    const msg = Message.fromFlat(b.toFlat());
    const d = msg.root().getData(0);
    expect(d.length).toBe(0);
    const dl = msg.root().getP(0);
    expect(dl.kind).toBe(PtrKind.List);
    expect(dl.esize).toBe(ElemSize.Byte);
    expect(dl.listLen()).toBe(0);
  });

  test("null / absent data pointer reads as empty Uint8Array", () => {
    const b = new MessageBuilder();
    const root = b.initRoot(0, 2);
    root.setData(0, new Uint8Array([0xde, 0xad]));
    const msg = Message.fromFlat(b.toFlat());
    expect([...msg.root().getData(0)]).toEqual([0xde, 0xad]);
    expect(msg.root().getData(1).length).toBe(0);
    const dflt = new Uint8Array([0xca, 0xfe]);
    expect(msg.root().getData(1, dflt)).toBe(dflt);
  });

  test("text with trailing NUL: count includes NUL; getText strips it", () => {
    const b = new MessageBuilder();
    const root = b.initRoot(0, 1);
    root.setText(0, "Hello, Cap'n Proto!");
    const msg = Message.fromFlat(b.toFlat());
    const r = msg.root();
    expect(r.getText(0)).toBe("Hello, Cap'n Proto!");
    const tl = r.getP(0);
    // 19 chars + NUL
    expect(tl.listLen()).toBe(20);
  });

  test("text without a trailing NUL on the wire is rejected", () => {
    // Hand-crafted: List(UInt8) of "abcd" with no trailing 0 byte.
    // Cap'n Proto rejects a non-null Text pointer that lacks its terminator.
    const words = [
      wpMakeStruct(0, 0, 1),
      wpMakeList(0, ElemSize.Byte, 4),
      0n,
    ];
    const msg = msgFromWords(words);
    const seg = msg.segments[0]!;
    storeU8(seg, 16, 0x61); // a
    storeU8(seg, 17, 0x62); // b
    storeU8(seg, 18, 0x63); // c
    storeU8(seg, 19, 0x64); // d
    expect(() => msg.root().getText(0)).toThrow(CapnpError);
  });

  test("a 0-byte text pointer is rejected even when the byte before it is 0", () => {
    // C++ layout.c++:2480 requires size > 0 so the terminator exists. The
    // pointer word's top byte (the byte before the body) is 0 here.
    const words = [wpMakeStruct(0, 0, 1), wpMakeList(0, ElemSize.Byte, 0), 0n];
    const msg = msgFromWords(words);
    expect(() => msg.root().getText(0)).toThrow(CapnpError);

    const loader = SchemaLoader.fromCgr(
      new Uint8Array(readFileSync(join(here, "golden", "addressbook.cgr.bin"))),
    );
    const person = DynamicStruct.fromMessage(msg, loader.resolveStruct("Person"));
    expect(() => person.get("name").asText()).toThrow(CapnpError);
  });

  test.skipIf(!hasCapnp)("capnp-ts decode rejects a 0-byte text pointer like capnp decode", () => {
    const words = [wpMakeStruct(0, 0, 1), wpMakeList(0, ElemSize.Byte, 0), 0n];
    const buf = new Uint8Array(8 + words.length * 8);
    new DataView(buf.buffer).setUint32(4, words.length, true);
    words.forEach((w, i) => storeU64(buf, 8 + i * 8, w));
    const args = ["decode", join(repoRoot, "schema/addressbook.capnp"), "Person"];
    const cli = spawnSync("capnp", args, { input: buf, encoding: "utf8" });
    expect(cli.status).not.toBe(0);
    expect(cli.stderr).toContain("not NUL-terminated");
    const ts = spawnSync(
      process.execPath,
      [join(repoRoot, "packages/runtime/bin/capnp-ts.mjs"), ...args],
      { input: buf, encoding: "utf8" },
    );
    expect(ts.stdout).toBe("");
    expect(ts.status).not.toBe(0);
  });

  test("text length boundaries (word padding + max-ish)", () => {
    // Content lengths that cross 8-byte word edges (plus builder's +1 NUL).
    const lengths = [0, 1, 7, 8, 15, 16, 63, 64, 255, 256, 1023, 1024, 4095];
    for (const n of lengths) {
      const s = "é".repeat(n); // multi-byte UTF-8 stress
      const b = new MessageBuilder();
      const root = b.initRoot(0, 1);
      root.setText(0, s);
      const msg = Message.fromFlat(b.toFlat());
      expect(msg.root().getText(0)).toBe(s);
      const tl = msg.root().getP(0);
      const encBytes = new TextEncoder().encode(s).length;
      expect(tl.listLen()).toBe(encBytes + 1);
    }
  });

  test("data length boundaries and binary content", () => {
    const cases = [
      new Uint8Array(0),
      new Uint8Array([0]),
      new Uint8Array([0, 1, 2, 3, 4, 5, 6]),
      new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
      new Uint8Array(17).map((_, i) => i & 0xff),
      new Uint8Array(256).map((_, i) => (255 - i) & 0xff),
    ];
    for (const payload of cases) {
      const b = new MessageBuilder();
      const root = b.initRoot(0, 1);
      root.setData(0, payload);
      const msg = Message.fromFlat(b.toFlat());
      expect([...msg.root().getData(0)]).toEqual([...payload]);
      expect(msg.root().getP(0).listLen()).toBe(payload.length);
    }
  });

  test("List(Text) via initPointerList", () => {
    const b = new MessageBuilder();
    const root = b.initRoot(0, 1);
    const list = root.initPointerList(0, 3);
    setListText(b, list, 0, "");
    setListText(b, list, 1, "mid");
    setListText(b, list, 2, "z".repeat(40));

    const msg = Message.fromFlat(b.toFlat());
    const lt = msg.root().getP(0);
    expect(lt.kind).toBe(PtrKind.List);
    expect(lt.esize).toBe(ElemSize.Pointer);
    expect(lt.listLen()).toBe(3);
    expect(lt.listGetText(0)).toBe("");
    expect(lt.listGetText(1)).toBe("mid");
    expect(lt.listGetText(2)).toBe("z".repeat(40));
  });

  test("nested List(List(Text))", () => {
    // outer @0 :List(List(Text))
    //   [0] = ["alpha", "beta"]
    //   [1] = [""]
    //   [2] = []  (empty inner list)
    const b = new MessageBuilder();
    const root = b.initRoot(0, 1);
    const outer = root.initPointerList(0, 3);

    const inner0 = initPointerListAt(b, outer, 0, 2);
    setListText(b, inner0, 0, "alpha");
    setListText(b, inner0, 1, "beta");

    const inner1 = initPointerListAt(b, outer, 1, 1);
    setListText(b, inner1, 0, "");

    initPointerListAt(b, outer, 2, 0);

    const msg = Message.fromFlat(b.toFlat());
    const o = msg.root().getP(0);
    expect(o.listLen()).toBe(3);

    const row0 = o.listGetP(0);
    expect(row0.kind).toBe(PtrKind.List);
    expect(row0.esize).toBe(ElemSize.Pointer);
    expect(row0.listLen()).toBe(2);
    expect(row0.listGetText(0)).toBe("alpha");
    expect(row0.listGetText(1)).toBe("beta");

    const row1 = o.listGetP(1);
    expect(row1.listLen()).toBe(1);
    expect(row1.listGetText(0)).toBe("");

    const row2 = o.listGetP(2);
    expect(row2.kind).toBe(PtrKind.List);
    expect(row2.esize).toBe(ElemSize.Pointer);
    expect(row2.listLen()).toBe(0);
  });

  const kitchen = () =>
    SchemaLoader.fromCgr(
      new Uint8Array(readFileSync(join(here, "golden", "dynamic-kitchen.cgr.bin"))),
    ).resolveStruct("KitchenSink");

  function expectBomTextReads(msg: Message): void {
    const sink = DynamicStruct.fromMessage(msg, kitchen());
    const title = sink.get("title");
    expect(title.asText()).toBe("\ufeffa");
    expect([...title.asTextBytes()]).toEqual([0xef, 0xbb, 0xbf, 0x61]);
    const row = sink.get("wordGrid").asList().get(0).asList();
    expect(row.get(0).asText()).toBe("\ufeffb");
    expect([...row.get(0).asTextBytes()]).toEqual([0xef, 0xbb, 0xbf, 0x62]);
    expect(row.get(1).asText()).toBe("c");
  }

  test("dynamic Text field and List(Text) reads keep a leading BOM", () => {
    const b = new MessageBuilder();
    const sink = DynamicStruct.initRoot(b, kitchen());
    sink.set("title", "\ufeffa");
    const row = sink.init("wordGrid", 1).asList().init(0, 2).asList();
    row.set(0, "\ufeffb");
    row.set(1, "c");
    expectBomTextReads(Message.fromFlat(b.toFlat()));
  });

  test.skipIf(!hasCapnp)("dynamic reads keep a leading BOM in Text that capnp encode writes", () => {
    const cli = spawnSync(
      "capnp",
      ["encode", join(repoRoot, "schema/dynamic-kitchen.capnp"), "KitchenSink"],
      { input: '(title = "\\xef\\xbb\\xbfa", wordGrid = [["\\xef\\xbb\\xbfb", "c"]])' },
    );
    expect(cli.status).toBe(0);
    expectBomTextReads(Message.fromFlat(new Uint8Array(cli.stdout)));
  });
});
