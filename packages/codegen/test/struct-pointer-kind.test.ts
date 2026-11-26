/**
 * Struct pointer getters pass the wire kind to getP.
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

describe.skipIf(!hasCapnp())("struct pointer kind", () => {
  test("struct field getter passes the struct kind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capnp-struct-kind-"));
    const schema = join(dir, "root.capnp");
    writeFileSync(
      schema,
      "@0x8a7b6c5d4e3f2011;\nstruct Item { n @0 :UInt32; }\nstruct Root { item @0 :Item; }\n",
    );
    const r = spawnSync("capnp", ["compile", "-o-", schema]);
    expect(r.status).toBe(0);
    const ast = await walkCgr(new Uint8Array(r.stdout as Uint8Array));
    const file = ast.requestedFiles[0];
    const src = emitModuleSource(ast, file?.filename ?? schema, file?.id);
    expect(src).toContain('return ptr.getP(0, "struct")');
  });
});
