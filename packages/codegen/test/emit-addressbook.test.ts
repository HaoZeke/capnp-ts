/**
 * Generated AddressBook module must decode packages/runtime golden Alice/Bob.
 * Also: live `capnp compile -o capnpc-ts` when CLI is available; u64probe
 * must never emit getU32 for UInt64/Int64 fields.
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
import { Message, PtrKind } from "../../runtime/src/index.ts";

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
const pluginBin = join(repoRoot, "packages", "codegen", "bin", "capnpc-ts");

async function loadAddressbookAst() {
  const bytes = new Uint8Array(
    readFileSync(join(fixturesDir, "addressbook.cgr.bin")),
  );
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

  test("capnp compile -o capnpc-ts produces decodeable AddressBook", async () => {
    // Requires capnp CLI 1.4.x on PATH (pixi env or system).
    const which = Bun.spawnSync(["which", "capnp"]);
    if (which.exitCode !== 0) {
      console.warn("skip: capnp CLI not on PATH");
      return;
    }
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
    // Silence unused when capnp prints paths on stdout.
    void stdout;
  });
});

describe("u64probe codegen smoke", () => {
  test("UInt64/Int64 emit getU64 never getU32", async () => {
    // Prefer live compile; fall back to offline CGR if capnp missing.
    let src: string;
    const which = Bun.spawnSync(["which", "capnp"]);
    if (which.exitCode === 0 && existsSync(u64probeSchema)) {
      const outDir = mkdtempSync(join(tmpdir(), "capnpc-ts-u64-"));
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
      src = readFileSync(join(outDir, "u64probe.ts"), "utf8");
    } else {
      // Offline: build CGR via capnp -o- if available, else skip.
      if (which.exitCode !== 0) {
        console.warn("skip: capnp CLI not on PATH for u64probe");
        return;
      }
      const cgr = Bun.spawnSync(
        [
          "capnp",
          "compile",
          `--src-prefix=${repoRoot}`,
          "-o-",
          u64probeSchema,
        ],
        { cwd: repoRoot },
      );
      expect(cgr.exitCode).toBe(0);
      const ast = await walkCgr(new Uint8Array(cgr.stdout));
      src = emitSourceString(ast);
    }

    expect(src).toContain("U64Probe_getId");
    expect(src).toContain("U64Probe_getSigned");
    expect(src).toContain("getU64");
    // Field getters for id/signed must not use getU32.
    const idLine = src
      .split("\n")
      .filter((l) => l.includes("getU64") || l.includes("getU32"));
    const getterBodies = src.match(
      /export function U64Probe_get(?:Id|Signed)[\s\S]*?^}/gm,
    );
    expect(getterBodies).not.toBeNull();
    for (const body of getterBodies!) {
      expect(body).toContain("getU64");
      expect(body).not.toContain("getU32");
    }
    void idLine;
  });

  test("offline emitFromAst writes u64probe.ts with bigint getters", async () => {
    const which = Bun.spawnSync(["which", "capnp"]);
    if (which.exitCode !== 0) {
      console.warn("skip: capnp CLI not on PATH");
      return;
    }
    const cgr = Bun.spawnSync(
      [
        "capnp",
        "compile",
        `--src-prefix=${repoRoot}`,
        "-o-",
        u64probeSchema,
      ],
      { cwd: repoRoot },
    );
    expect(cgr.exitCode).toBe(0);
    const ast = await walkCgr(new Uint8Array(cgr.stdout));
    const outDir = mkdtempSync(join(tmpdir(), "capnpc-ts-u64-ast-"));
    mkdirSync(outDir, { recursive: true });
    const result = emitFromAst(ast, outDir);
    expect(result.written.some((p) => p.endsWith("u64probe.ts"))).toBe(true);
    const src = readFileSync(join(outDir, "u64probe.ts"), "utf8");
    expect(src).toMatch(/getU64\(\s*0\s*/); // id @ offset 0
    expect(src).toMatch(/getU64\(\s*8\s*/); // signed @ slot 1 * 8
    expect(src).not.toMatch(/U64Probe_getId[\s\S]{0,120}getU32/);
  });
});
