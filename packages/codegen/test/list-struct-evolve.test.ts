/**
 * Generated list helpers against capnp encode.
 * List(Struct) must upgrade primitive, text, and void elements.
 * List(List) must downgrade a composite list through pointer 0.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Message, PtrKind } from "../../runtime/src/index.ts";
import { walkCgr } from "../src/cgr-walk.ts";
import { emitModuleSource } from "../src/emit.ts";

function hasCapnp(): boolean {
  return spawnSync("capnp", ["--version"], { encoding: "utf8" }).status === 0;
}

function writeSchema(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

function encode(schema: string, text: string): Uint8Array {
  const r = spawnSync("capnp", ["encode", schema, "Root"], { input: text });
  expect(r.status).toBe(0);
  return new Uint8Array(r.stdout as Uint8Array);
}

async function emit(schema: string) {
  const r = spawnSync("capnp", ["compile", "-o-", schema]);
  expect(r.status).toBe(0);
  const ast = await walkCgr(new Uint8Array(r.stdout as Uint8Array));
  const file = ast.requestedFiles[0];
  const src = emitModuleSource(ast, file?.filename ?? schema, file?.id);
  const out = join(mkdtempSync(join(tmpdir(), "capnpc-list-")), "gen.ts");
  writeFileSync(out, src);
  return { src, mod: await import(out) };
}

describe.skipIf(!hasCapnp())("generated list evolution", () => {
  const dir = mkdtempSync(join(tmpdir(), "capnp-list-schema-"));

  test("List(Struct) upgrades primitive, text, and void lists from capnp encode", async () => {
    const oldNums = writeSchema(
      dir,
      "old-nums.capnp",
      "@0x91b2c3d4e5f60731;\nstruct Root { nums @0 :List(UInt32); }\n",
    );
    const oldNotes = writeSchema(
      dir,
      "old-notes.capnp",
      "@0x91b2c3d4e5f60732;\nstruct Root { notes @0 :List(Text); }\n",
    );
    const oldBlanks = writeSchema(
      dir,
      "old-blanks.capnp",
      "@0x91b2c3d4e5f60733;\nstruct Root { blanks @0 :List(Void); }\n",
    );
    const numsSchema = writeSchema(
      dir,
      "nums.capnp",
      "@0x91b2c3d4e5f60741;\nstruct Item { n @0 :UInt32; }\nstruct Root { nums @0 :List(Item); }\n",
    );
    const notesSchema = writeSchema(
      dir,
      "notes.capnp",
      "@0x91b2c3d4e5f60742;\nstruct Note { t @0 :Text; }\nstruct Root { notes @0 :List(Note); }\n",
    );
    const blanksSchema = writeSchema(
      dir,
      "blanks.capnp",
      "@0x91b2c3d4e5f60743;\nstruct Blank {}\nstruct Root { blanks @0 :List(Blank); }\n",
    );

    const nums = await emit(numsSchema);
    expect(nums.src).toContain("return Root_getNums(ptr).listGetStruct(index)");
    expect(nums.src).not.toContain("Root_getNums(ptr).listGetP(index)");
    const numsRoot = Message.fromFlat(encode(oldNums, "(nums = [7, 8])")).root();
    expect(nums.mod.Item_getN(nums.mod.Root_getNumsAt(numsRoot, 0))).toBe(7);
    expect(nums.mod.Item_getN(nums.mod.Root_getNumsAt(numsRoot, 1))).toBe(8);

    const notes = await emit(notesSchema);
    expect(notes.src).toContain("return Root_getNotes(ptr).listGetStruct(index)");
    const notesRoot = Message.fromFlat(
      encode(oldNotes, '(notes = ["hi", "yo"])'),
    ).root();
    expect(notes.mod.Note_getT(notes.mod.Root_getNotesAt(notesRoot, 0))).toBe("hi");
    expect(notes.mod.Note_getT(notes.mod.Root_getNotesAt(notesRoot, 1))).toBe("yo");

    const blanks = await emit(blanksSchema);
    expect(blanks.src).toContain("return Root_getBlanks(ptr).listGetStruct(index)");
    const blanksRoot = Message.fromFlat(
      encode(oldBlanks, "(blanks = [void, void, void])"),
    ).root();
    expect(blanks.mod.Root_getBlanks(blanksRoot).listLen()).toBe(3);
    const blank = blanks.mod.Root_getBlanksAt(blanksRoot, 2);
    expect(blank.kind).toBe(PtrKind.Struct);
    expect(blank.dwords).toBe(0);
    expect(blank.pwords).toBe(0);
  });

  test("List(List) downgrades a composite list and reads a pointer list", async () => {
    const wide = writeSchema(
      dir,
      "wide.capnp",
      "@0x91b2c3d4e5f60751;\nstruct Inner { item @0 :List(UInt16); }\nstruct Root { vals @0 :List(Inner); }\n",
    );
    const narrow = writeSchema(
      dir,
      "narrow.capnp",
      "@0x91b2c3d4e5f60752;\nstruct Root { vals @0 :List(List(UInt16)); }\n",
    );
    const iface = writeSchema(
      dir,
      "caps.capnp",
      "@0x91b2c3d4e5f60753;\ninterface Bar { ping @0 (); }\nstruct Root { caps @0 :List(Bar); }\n",
    );

    const gen = await emit(narrow);
    expect(gen.src).toContain(
      "return Root_getVals(ptr).listGetStruct(index).getP(0)",
    );
    const caps = await emit(iface);
    expect(caps.src).toContain(
      "return Root_getCaps(ptr).listGetStruct(index).getP(0)",
    );

    const down = Message.fromFlat(
      encode(wide, "(vals = [(item = [1, 2]), (item = [9])])"),
    ).root();
    const row0 = gen.mod.Root_getValsAt(down, 0);
    const row1 = gen.mod.Root_getValsAt(down, 1);
    expect(row0.listGetU16(0)).toBe(1);
    expect(row0.listGetU16(1)).toBe(2);
    expect(row1.listGetU16(0)).toBe(9);

    const plain = Message.fromFlat(
      encode(narrow, "(vals = [[4, 5], [6]])"),
    ).root();
    expect(gen.mod.Root_getValsAt(plain, 0).listGetU16(1)).toBe(5);
    expect(gen.mod.Root_getValsAt(plain, 1).listGetU16(0)).toBe(6);
  });
});
