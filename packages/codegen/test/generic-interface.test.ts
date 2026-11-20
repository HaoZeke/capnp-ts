/**
 * Generic interfaces: method brands, implicit parameters, and the
 * compiler-generated params and results structs (scopeId 0).
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
  getU16(_offset: number): number { return 0; }
  getU32(_offset: number): number { return 0; }
  getU64(_offset: number): bigint { return 0n; }
  getText(_index: number): string { return ""; }
  getP(_index: number): Ptr { return this; }
  listLen(): number { return 0; }
  listGetStruct(_index: number): Ptr { return this; }
  listGetP(_index: number): Ptr { return this; }
  listGetText(_index: number): string { return ""; }
}
export class StructBuilder {
  setP(_index: number, _value: Ptr): void {}
  setText(_index: number, _value: string): void {}
  initStruct(_index: number, _dwords: number, _pwords: number): StructBuilder {
    return this;
  }
}
`;

describe.skipIf(!hasCapnp())("generic interface emit", () => {
  test("decodes brands and emits scopeId-0 param structs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capnp-generic-iface-"));
    const schema = join(dir, "box.capnp");
    writeFileSync(
      schema,
      `@0x8123456789abcdef;
interface Box(T) {
  get @0 () -> (item :T);
}
struct Holder {
  textBox @0 :Box(Text);
}
interface Use {
  call @0 [U] (item :U) -> (out :Text);
  boxed @1 () -> (item :Box(Text));
}
`,
    );
    const cgr = spawnSync("capnp", ["compile", "-o-", "-I", dir, schema]);
    expect(cgr.status).toBe(0);
    const ast = await walkCgr(new Uint8Array(cgr.stdout as Uint8Array));
    const file = ast.requestedFiles[0]!;
    const src = emitModuleSource(ast, file.filename, file.id);

    expect(src).toContain("export type Box_get_Params_Ptr");
    expect(src).toContain("export type Box_get_Results_Ptr");
    expect(src).toContain(
      "export type Box_get_Results_Ptr<T extends CapnpAnyPointer = CapnpAnyPointer> = Ptr & CapnpBranded<[T]>;",
    );
    expect(src).toContain(
      "export type Use_call_Params_Ptr<U extends CapnpAnyPointer = CapnpAnyPointer> = Ptr & CapnpBranded<[U]>;",
    );
    expect(src).toContain('which: "inherit"');
    expect(src).toContain('implicitParameters: ["U"]');
    expect(src).toContain(
      "abstract get<T extends CapnpAnyPointer = CapnpAnyPointer>(params: Box_get_Params_Ptr<T>, results: StructBuilder): void;",
    );
    expect(src).toContain(
      "abstract call<U extends CapnpAnyPointer = CapnpAnyPointer>(params: Use_call_Params_Ptr<U>, results: StructBuilder): void;",
    );
    expect(src).toContain("Holder_getTextBox(ptr: Ptr): Box_Capability<CapnpText>");

    const outDir = mkdtempSync(join(tmpdir(), "capnp-generic-iface-tsc-"));
    writeFileSync(join(outDir, "stub.ts"), STUB);
    writeFileSync(join(outDir, "box.ts"), src);
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
          files: ["box.ts"],
        },
        null,
        2,
      ),
    );
    const checked = spawnSync(
      "bunx",
      ["tsc", "-p", join(outDir, "tsconfig.json"), "--pretty", "false", "--noEmit"],
      { encoding: "utf8" },
    );
    expect(`${checked.stdout ?? ""}\n${checked.stderr ?? ""}`).not.toContain("error TS");
    expect(checked.status).toBe(0);
  }, 60_000); // `bunx tsc` exceeds Bun's 5000 ms default on a slow CI runner.
});
