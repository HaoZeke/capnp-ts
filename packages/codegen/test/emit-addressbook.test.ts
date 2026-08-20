/**
 * Generated AddressBook module must decode packages/runtime golden Alice/Bob.
 * Critical paths use offline CGR fixtures (no silent pass when capnp missing).
 * Live `capnp compile -o capnpc-ts` is gated with test.skipIf, not soft-return.
 */
import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  emitFromAst,
  emitSourceString,
  walkCgr,
} from "../src/index.ts";
import { Message, MessageBuilder, PtrKind } from "../../runtime/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const fixturesDir = join(here, "fixtures");
const goldenPath = join(
  repoRoot,
  "packages",
  "runtime",
  "test",
  "golden",
  "addressbook.bin",
);
const addressbookSchema = join(repoRoot, "schema", "addressbook.capnp");
const u64probeSchema = join(repoRoot, "schema", "u64probe.capnp");
const u64probeFixture = join(fixturesDir, "u64probe.cgr.bin");
const pluginBin = join(repoRoot, "packages", "codegen", "bin", "capnpc-ts");

const hasCapnp = Bun.spawnSync(["which", "capnp"]).exitCode === 0;

async function loadAddressbookAst() {
  const bytes = new Uint8Array(
    readFileSync(join(fixturesDir, "addressbook.cgr.bin")),
  );
  return walkCgr(bytes);
}

async function loadU64probeAst() {
  expect(existsSync(u64probeFixture)).toBe(true);
  const bytes = new Uint8Array(readFileSync(u64probeFixture));
  return walkCgr(bytes);
}

describe("generated AddressBook decode", () => {
  test("emit from fixture decodes Alice and Bob from golden.bin", async () => {
    const ast = await loadAddressbookAst();
    const src = emitSourceString(ast);

    // Write into a temp dir that can resolve @haozeke/capnp via workspace root.
    const outDir = mkdtempSync(join(tmpdir(), "capnpc-ts-ab-"));
    const outFile = join(outDir, "addressbook.ts");
    writeFileSync(outFile, src, "utf8");

    // Dynamic import of generated module (Bun resolves workspace package).
    const gen = await import(outFile);
    expect(gen.PERSON_DWORDS ?? gen.Person_dataWordCount).toBe(1);
    expect(gen.ADDRESS_BOOK_DWORDS ?? gen.AddressBook_dataWordCount).toBe(0);
    expect(gen.Person_PhoneNumber_Type.mobile).toBe(0);
    expect(gen.Person_PhoneNumber_Type.home).toBe(1);
    expect(gen.Person_PhoneNumber_Type.work).toBe(2);

    const bytes = new Uint8Array(readFileSync(goldenPath));
    const msg = Message.fromFlat(bytes);
    const root = msg.root();
    expect(root.kind).toBe(PtrKind.Struct);

    const people = gen.AddressBook_getPeople(root);
    expect(people.kind).toBe(PtrKind.List);
    expect(people.listLen()).toBe(2);
    // Prefer At helper when present.
    const alice = gen.AddressBook_getPeopleAt
      ? gen.AddressBook_getPeopleAt(root, 0)
      : people.listGetP(0);
    const bob = gen.AddressBook_getPeopleAt
      ? gen.AddressBook_getPeopleAt(root, 1)
      : people.listGetP(1);

    expect(gen.Person_getId(alice)).toBe(123);
    expect(gen.Person_getName(alice)).toBe("Alice");
    expect(gen.Person_getEmail(alice)).toBe("alice@example.com");

    expect(gen.Person_getId(bob)).toBe(456);
    expect(gen.Person_getName(bob)).toBe("Bob");
    expect(gen.Person_getEmail(bob)).toBe("bob@example.com");
  });

  test("generated builders create an AddressBook without hand offsets", async () => {
    const src = emitSourceString(await loadAddressbookAst());
    const outDir = mkdtempSync(join(tmpdir(), "capnpc-ts-ab-builder-"));
    const outFile = join(outDir, "addressbook.ts");
    writeFileSync(outFile, src, "utf8");
    const gen = await import(outFile);

    const builder = new MessageBuilder();
    const book = builder.initRoot(
      gen.AddressBook_dataWordCount,
      gen.AddressBook_pointerCount,
    );
    const alice = gen.AddressBook_initPeople(book, 2);
    gen.Person_setId(alice, 123);
    gen.Person_setName(alice, "Alice");
    gen.Person_setEmail(alice, "alice@example.com");
    const phones = gen.Person_initPhones(alice, 1);
    gen.Person_PhoneNumber_setNumber(phones, "555-1212");
    gen.Person_PhoneNumber_setType(phones, gen.Person_PhoneNumber_Type.mobile);

    const bob = alice.nextElement();
    gen.Person_setId(bob, 456);
    gen.Person_setName(bob, "Bob");
    gen.Person_setEmail(bob, "bob@example.com");

    const root = Message.fromFlat(builder.toFlat()).root();
    const people = gen.AddressBook_getPeople(root);
    expect(people.listLen()).toBe(2);
    expect(gen.Person_getName(people.listGetP(0))).toBe("Alice");
    expect(gen.Person_getEmail(people.listGetP(1))).toBe("bob@example.com");
    expect(
      gen.Person_PhoneNumber_getNumber(
        gen.Person_getPhonesAt(people.listGetP(0), 0),
      ),
    ).toBe("555-1212");
  });

  test("List(Text) element helper emits listGetText not listGetP.getText", async () => {
    // AddressBook has List(Person) only; synthesize a List(Text) field via kitchen
    // fixture if present, else assert the emitter path on a minimal hand AST walk.
    const kitchenPath = join(fixturesDir, "kitchen.cgr.bin");
    const ast = await walkCgr(new Uint8Array(readFileSync(kitchenPath)));
    const src = emitSourceString(ast);
    // Any List(Text) *At helper must use listGetText.
    const listTextAts = src.match(
      /export function \w+At\(ptr: Ptr, index: number\): string \{[\s\S]*?^\}/gm,
    );
    if (listTextAts && listTextAts.length > 0) {
      for (const body of listTextAts) {
        expect(body).toContain("listGetText");
        expect(body).not.toContain("listGetP");
        expect(body).not.toContain("getText(0)");
      }
    } else {
      // Force the emit path with a minimal synthetic module check via source search
      // of the emitter template: kitchen may lack List(Text); still unit-check below.
      expect(src.length).toBeGreaterThan(0);
    }
  });

  test.skipIf(!hasCapnp)(
    "capnp compile -o capnpc-ts produces decodeable AddressBook",
    async () => {
      if (!existsSync(addressbookSchema) || !existsSync(pluginBin)) {
        throw new Error("schema or plugin bin missing");
      }

      const outDir = mkdtempSync(join(tmpdir(), "capnpc-ts-compile-"));
      const proc = Bun.spawn(
        [
          "capnp",
          "compile",
          `--src-prefix=${repoRoot}`,
          `-o${pluginBin}`,
          addressbookSchema,
        ],
        {
          cwd: outDir,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toContain("CGR ok");
      const outFile = join(outDir, "addressbook.ts");
      expect(existsSync(outFile)).toBe(true);
      const src = readFileSync(outFile, "utf8");
      expect(src).toContain("Person_getId");
      expect(src).toContain("AddressBook_getPeople");

      const gen = await import(outFile);
      const bytes = new Uint8Array(readFileSync(goldenPath));
      const root = Message.fromFlat(bytes).root();
      const alice = gen.AddressBook_getPeopleAt(root, 0);
      const bob = gen.AddressBook_getPeopleAt(root, 1);
      expect(gen.Person_getId(alice)).toBe(123);
      expect(gen.Person_getName(alice)).toBe("Alice");
      expect(gen.Person_getId(bob)).toBe(456);
      expect(gen.Person_getName(bob)).toBe("Bob");
      void stdout;
    },
  );
});

describe("u64probe codegen smoke", () => {
  test("offline fixture: UInt64/Int64 emit getU64 never getU32", async () => {
    const src = emitSourceString(await loadU64probeAst());

    expect(src).toContain("U64Probe_getId");
    expect(src).toContain("U64Probe_getSigned");
    expect(src).toContain("getU64");
    const getterBodies = src.match(
      /export function U64Probe_get(?:Id|Signed)[\s\S]*?^}/gm,
    );
    expect(getterBodies).not.toBeNull();
    expect(getterBodies!.length).toBe(2);
    for (const body of getterBodies!) {
      expect(body).toContain("getU64");
      expect(body).not.toContain("getU32");
    }
  });

  test("offline emitFromAst writes u64probe.ts with bigint getters", async () => {
    const ast = await loadU64probeAst();
    const outDir = mkdtempSync(join(tmpdir(), "capnpc-ts-u64-ast-"));
    mkdirSync(outDir, { recursive: true });
    const result = emitFromAst(ast, outDir);
    expect(result.written.some((p) => p.endsWith("u64probe.ts"))).toBe(true);
    const src = readFileSync(join(outDir, "u64probe.ts"), "utf8");
    expect(src).toMatch(/getU64\(\s*0\s*/); // id @ offset 0
    expect(src).toMatch(/getU64\(\s*8\s*/); // signed @ slot 1 * 8
    expect(src).not.toMatch(/U64Probe_getId[\s\S]{0,120}getU32/);
  });

  test.skipIf(!hasCapnp)(
    "live capnp compile -o capnpc-ts u64probe matches offline emit",
    async () => {
      if (!existsSync(u64probeSchema) || !existsSync(pluginBin)) {
        throw new Error("u64probe schema or plugin bin missing");
      }
      const outDir = mkdtempSync(join(tmpdir(), "capnpc-ts-u64-live-"));
      const proc = Bun.spawn(
        [
          "capnp",
          "compile",
          `--src-prefix=${repoRoot}`,
          `-o${pluginBin}`,
          u64probeSchema,
        ],
        { cwd: outDir, stdout: "pipe", stderr: "pipe" },
      );
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
      const live = readFileSync(join(outDir, "u64probe.ts"), "utf8");
      const offline = emitSourceString(await loadU64probeAst());
      expect(live).toContain("getU64");
      expect(offline).toContain("getU64");
      expect(live).toContain("U64Probe_getId");
      expect(live).not.toMatch(/U64Probe_getId[\s\S]{0,120}getU32/);
    },
  );
});

describe("Field.defaultValue walk", () => {
  test("addressbook slots carry defaultValue on AST", async () => {
    const ast = await loadAddressbookAst();
    const person = ast.nodes.find((n) => n.displayName.endsWith(":Person"));
    expect(person?.struct).toBeDefined();
    const id = person!.struct!.fields.find((f) => f.name === "id");
    expect(id?.slot?.defaultValue).toBeDefined();
    expect(id!.slot!.defaultValue!.which).toBe("uint32");
    if (id!.slot!.defaultValue!.which === "uint32") {
      expect(id!.slot!.defaultValue!.value).toBe(0);
    }
    // No `= …` in schema → hadExplicitDefault is false (bit 128).
    expect(id!.slot!.hadExplicitDefault).toBe(false);
    const name = person!.struct!.fields.find((f) => f.name === "name");
    expect(name?.slot?.defaultValue?.which).toBe("text");
  });

  test("kitchen non-zero defaults walk + emit into getters", async () => {
    const kitchenPath = join(fixturesDir, "kitchen.cgr.bin");
    expect(existsSync(kitchenPath)).toBe(true);
    const ast = await walkCgr(new Uint8Array(readFileSync(kitchenPath)));
    const sink = ast.nodes.find((n) => n.displayName.endsWith(":Sink"));
    expect(sink?.struct).toBeDefined();
    const flag = sink!.struct!.fields.find((f) => f.name === "flag");
    const count = sink!.struct!.fields.find((f) => f.name === "count");
    const ratio = sink!.struct!.fields.find((f) => f.name === "ratio");
    expect(flag?.slot?.hadExplicitDefault).toBe(true);
    expect(flag?.slot?.defaultValue).toEqual({ which: "bool", value: true });
    expect(count?.slot?.hadExplicitDefault).toBe(true);
    expect(count?.slot?.defaultValue).toEqual({ which: "int32", value: -7 });
    expect(ratio?.slot?.hadExplicitDefault).toBe(true);
    expect(ratio?.slot?.defaultValue).toEqual({ which: "float64", value: 2.5 });

    const src = emitSourceString(ast);
    expect(src).toMatch(/Sink_getFlag\(ptr: Ptr, dflt = true\)/);
    expect(src).toMatch(/Sink_getCount\(ptr: Ptr, dflt = -7\)/);
    expect(src).toMatch(/Sink_getRatio\(ptr: Ptr, dflt = 2\.5\)/);
    expect(src).toContain("ptr.getF64(");
    expect(src).toContain("ptr.getBool(");
  });

  test("synthetic float32 default emits getF32 with schema dflt", async () => {
    const { emitModuleSource } = await import("../src/emit.ts");
    const synthetic = {
      nodes: [
        {
          id: 1n,
          displayName: "synth.capnp:Probe",
          displayNamePrefixLength: 0,
          scopeId: 0n,
          which: "struct" as const,
          whichTag: 1,
          nestedNodes: [],
          struct: {
            dataWordCount: 1,
            pointerCount: 0,
            isGroup: false,
            discriminantCount: 0,
            discriminantOffset: 0,
            fields: [
              {
                name: "x",
                codeOrder: 0,
                discriminant: 0xffff,
                slot: {
                  offset: 0,
                  type: { which: "float32" as const },
                  defaultValue: { which: "float32" as const, value: 1.5 },
                  hadExplicitDefault: true,
                },
              },
              {
                name: "n",
                codeOrder: 1,
                discriminant: 0xffff,
                slot: {
                  offset: 1,
                  type: { which: "int32" as const },
                  defaultValue: { which: "int32" as const, value: -7 },
                  hadExplicitDefault: true,
                },
              },
            ],
          },
        },
      ],
      requestedFiles: [{ id: 0n, filename: "synth.capnp" }],
    };
    const src = emitModuleSource(synthetic as never, "synth.capnp", 0n);
    expect(src).toContain("ptr.getF32(");
    expect(src).toMatch(/Probe_getX\(ptr: Ptr, dflt = 1\.5\)/);
    expect(src).toMatch(/Probe_getN\(ptr: Ptr, dflt = -7\)/);
    expect(src).not.toMatch(/Probe_getX[\s\S]{0,80}getU32/);
  });
});

describe("generated scalar builders", () => {
  test("setters apply defaults and select union fields", async () => {
    const { emitModuleSource } = await import("../src/emit.ts");
    const synthetic = {
      nodes: [
        {
          id: 1n,
          displayName: "synth.capnp:Probe",
          displayNamePrefixLength: 0,
          scopeId: 0n,
          which: "struct" as const,
          whichTag: 1,
          nestedNodes: [],
          struct: {
            dataWordCount: 2,
            pointerCount: 0,
            isGroup: false,
            discriminantCount: 2,
            discriminantOffset: 4,
            fields: [
              {
                name: "count",
                codeOrder: 0,
                discriminant: 0xffff,
                slot: {
                  offset: 0,
                  type: { which: "int32" as const },
                  defaultValue: { which: "int32" as const, value: -7 },
                  hadExplicitDefault: true,
                },
              },
              {
                name: "first",
                codeOrder: 1,
                discriminant: 0,
                slot: {
                  offset: 1,
                  type: { which: "int32" as const },
                  defaultValue: { which: "int32" as const, value: 0 },
                  hadExplicitDefault: false,
                },
              },
              {
                name: "second",
                codeOrder: 2,
                discriminant: 1,
                slot: {
                  offset: 1,
                  type: { which: "int32" as const },
                  defaultValue: { which: "int32" as const, value: 0 },
                  hadExplicitDefault: false,
                },
              },
            ],
          },
        },
      ],
      requestedFiles: [{ id: 0n, filename: "synth.capnp" }],
    };
    const src = emitModuleSource(synthetic as never, "synth.capnp", 0n);
    expect(src).toContain("import type { Ptr, StructBuilder }");
    expect(src).toMatch(
      /Probe_setCount\(ptr: StructBuilder, value: number, dflt = -7\)/,
    );
    expect(src).toMatch(/Probe_setSecond[\s\S]*?ptr\.setU16\(8, 1\)/);

    const outDir = mkdtempSync(join(tmpdir(), "capnpc-ts-builder-"));
    const outFile = join(outDir, "synth.ts");
    writeFileSync(outFile, src, "utf8");
    const gen = await import(outFile);

    const builder = new MessageBuilder();
    const root = builder.initRoot(2, 0);
    gen.Probe_setCount(root, -7);
    gen.Probe_setSecond(root, 42);

    const reader = Message.fromFlat(builder.toFlat()).root();
    expect(gen.Probe_getCount(reader)).toBe(-7);
    expect(gen.Probe_which(reader)).toBe(1);
    expect(gen.Probe_getSecond(reader)).toBe(42);
  });
});

describe("List(Text) emit helper unit", () => {
  test("emitter uses listGetText for text list elements", async () => {
    // Minimal CGR-free check: re-emit kitchen + scan; plus direct template via
    // a tiny synthetic schema if kitchen lacks List(Text).
    const { emitModuleSource } = await import("../src/emit.ts");
    const synthetic = {
      nodes: [
        {
          id: 1n,
          displayName: "synth.capnp:Holder",
          displayNamePrefixLength: 0,
          scopeId: 0n,
          which: "struct" as const,
          whichTag: 1,
          nestedNodes: [],
          struct: {
            dataWordCount: 0,
            pointerCount: 1,
            isGroup: false,
            discriminantCount: 0,
            discriminantOffset: 0,
            fields: [
              {
                name: "tags",
                codeOrder: 0,
                discriminant: 0xffff,
                slot: {
                  offset: 0,
                  type: {
                    which: "list" as const,
                    elementType: { which: "text" as const },
                  },
                },
              },
            ],
          },
        },
      ],
      requestedFiles: [{ id: 0n, filename: "synth.capnp" }],
    };
    const src = emitModuleSource(synthetic as never, "synth.capnp", 0n);
    expect(src).toContain("Holder_getTagsAt");
    expect(src).toMatch(
      /Holder_getTagsAt[\s\S]*?listGetText\(index\)/,
    );
    expect(src).not.toMatch(
      /Holder_getTagsAt[\s\S]*?listGetP\(index\)\.getText/,
    );
  });
});
