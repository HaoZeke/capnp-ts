/**
 * Struct pointer getters pass the wire kind to getP.
 *
 * The CI test job installs Cap'n Proto 1.4.0 before bun test, so a missing
 * CLI fails this file. Other suites may skip live capnp checks.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkCgr } from "../src/cgr-walk.ts";
import { emitModuleSource } from "../src/emit.ts";

const capnpProbe = spawnSync("capnp", ["--version"], { encoding: "utf8" });
if (capnpProbe.status !== 0) {
  throw new Error("struct-pointer-kind: no capnp CLI on PATH");
}

async function emit(source: string, stem: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `capnp-struct-kind-${stem}-`));
  const schema = join(dir, "root.capnp");
  writeFileSync(schema, source);
  const r = spawnSync("capnp", ["compile", "-o-", schema]);
  expect(r.status).toBe(0);
  const ast = await walkCgr(new Uint8Array(r.stdout as Uint8Array));
  const file = ast.requestedFiles[0];
  return emitModuleSource(ast, file?.filename ?? schema, file?.id);
}

describe("struct pointer kind", () => {
  test("struct field getter passes the struct kind", async () => {
    const src = await emit(
      "@0x8a7b6c5d4e3f2011;\nstruct Item { n @0 :UInt32; }\nstruct Root { item @0 :Item; }\n",
      "plain",
    );
    expect(src).toContain('return ptr.getP(0, "struct")');
  });

  test("default-bytes struct getter passes the struct kind", async () => {
    const src = await emit(
      "@0x8a7b6c5d4e3f2011;\nstruct Item { n @0 :UInt32; }\nstruct Root { primed @0 :Item = (n = 9); }\n",
      "dflt",
    );
    expect(src).toContain("const ROOT_PRIMED_DEFAULT_BYTES = new Uint8Array([");
    expect(src).toContain('const p = ptr.getP(0, "struct")');
    expect(src).toContain(
      "return (p.kind === PtrKind.Null ? ROOT_PRIMED_DEFAULT_PTR : p) as Item_Ptr;",
    );
  });

  test("branded struct getter passes the struct kind", async () => {
    const src = await emit(
      "@0x8a7b6c5d4e3f2011;\nstruct Item { n @0 :UInt32; }\nstruct Box(T) { value @0 :T; }\nstruct Root { branded @0 :Box(Item); }\n",
      "brand",
    );
    expect(src).toContain(
      'return ptr.getP(0, "struct") as Box_Ptr<Item_Ptr>;',
    );
    expect(src).toContain("return ptr.getP(0) as T;");
  });

  test("list, interface, and anyPointer getters match base codegen", async () => {
    const src = await emit(
      "@0x8a7b6c5d4e3f2011;\ninterface Calc { eval @0 (x :Int32) -> (y :Int32); }\nstruct Root { nums @0 :List(UInt32); calc @1 :Calc; raw @2 :AnyPointer; }\n",
      "rest",
    );
    expect(src).toContain("export function Root_getNums(ptr: Ptr): Ptr {\n  return ptr.getP(0) as Ptr;\n}");
    expect(src).toContain(
      "export function Root_getCalc(ptr: Ptr): Calc_Capability {\n  return ptr.getP(1) as Calc_Capability;\n}",
    );
    expect(src).toContain(
      "export function Root_getRaw(ptr: Ptr): CapnpAnyPointer {\n  return ptr.getP(2) as CapnpAnyPointer;\n}",
    );
  });
});
