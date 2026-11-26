/**
 * A schema that imports types from a file which is not in requestedFiles
 * must still type-check. Those names are declared in the importing module.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkCgr } from "../src/cgr-walk.ts";
import { emitModuleSource } from "../src/emit.ts";

function hasCapnp(): boolean {
  return spawnSync("capnp", ["--version"], { encoding: "utf8" }).status === 0;
}

const STUB = `
export class Ptr {
  getP(_index: number, _expected?: "struct" | "text" | "data" | "copy" | "list"): Ptr { return this; }
  listLen(): number { return 0; }
  listGetStruct(_index: number): Ptr { return this; }
  listGetP(_index: number): Ptr { return this; }
}
export class StructBuilder {
  setP(_index: number, _value: Ptr): void {}
  initStruct(_index: number, _dwords: number, _pwords: number): StructBuilder {
    return this;
  }
}
`;

function typecheck(dir: string, file: string): { status: number | null; text: string } {
  const r = spawnSync(
    "bunx",
    ["tsc", "-p", join(dir, "tsconfig.json"), "--pretty", "false", "--noEmit"],
    { encoding: "utf8" },
  );
  return { status: r.status, text: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

describe.skipIf(!hasCapnp())("imports outside requestedFiles", () => {
  test("two-file schema type-checks when the import is not requested", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capnp-import-"));
    writeFileSync(
      join(dir, "defs.capnp"),
      `@0x8a1b2c3d4e5f6011;
struct Vec { x @0 :Float64; y @1 :Float64; z @2 :Float64; }
interface Bar { ping @0 (); }
`,
    );
    const user = join(dir, "user.capnp");
    writeFileSync(
      user,
      `@0x8a1b2c3d4e5f6012;
using Defs = import "defs.capnp";
struct Holder {
  v @0 :Defs.Vec;
  b @1 :Defs.Bar;
}
`,
    );
    const cgr = spawnSync("capnp", ["compile", "-o-", "-I", dir, user]);
    expect(cgr.status).toBe(0);
    const ast = await walkCgr(new Uint8Array(cgr.stdout as Uint8Array));
    const requested = ast.requestedFiles.map((rf) => rf.filename);
    expect(requested.some((name) => name.endsWith("user.capnp"))).toBe(true);
    expect(requested.some((name) => name.endsWith("defs.capnp"))).toBe(false);

    const file = ast.requestedFiles[0]!;
    const src = emitModuleSource(ast, file.filename, file.id);
    expect(src).toContain("export type Vec_Ptr = Ptr;");
    expect(src).toContain("export type Bar_Capability = Ptr;");
    expect(src).toContain("Holder_getV(ptr: Ptr): Vec_Ptr");
    expect(src).toContain("Holder_getB(ptr: Ptr): Bar_Capability");

    const outDir = mkdtempSync(join(tmpdir(), "capnp-import-tsc-"));
    writeFileSync(join(outDir, "stub.ts"), STUB);
    writeFileSync(join(outDir, "user.ts"), src);
    writeFileSync(
      join(outDir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            baseUrl: ".",
            paths: { "@haozeke/capnp": ["stub.ts"] },
          },
          files: ["user.ts"],
        },
        null,
        2,
      ),
    );
    const checked = typecheck(outDir, "user.ts");
    expect(checked.status).toBe(0);
    expect(checked.text).not.toContain("TS2304");
  }, 60_000); // `bunx tsc` exceeds Bun's 5000 ms default on a slow CI runner.
});
