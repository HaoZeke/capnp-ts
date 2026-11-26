/**
 * A schema struct named Message must not collide with the runtime import
 * that materializes pointer defaults.
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
  kind = 0;
  getU16(_offset: number, _dflt?: number): number { return 0; }
  getU32(_offset: number, _dflt?: number): number { return 0; }
  getP(_index: number, _expected?: "struct" | "text" | "data" | "copy" | "list"): Ptr { return this; }
}
export const PtrKind = { Null: 0, Struct: 1, List: 2, Cap: 3 };
export class StructBuilder {
  setU16(_offset: number, _value: number, _dflt?: number): void {}
  setU32(_offset: number, _value: number, _dflt?: number): void {}
  setP(_index: number, _value: Ptr): void {}
  initStruct(_index: number, _dwords: number, _pwords: number): StructBuilder {
    return this;
  }
}
export class Message {
  static fromFlat(_bytes: Uint8Array): { root(): Ptr } {
    return { root: () => new Ptr() };
  }
}
`;

describe.skipIf(!hasCapnp())("struct named Message", () => {
  test("aliases the runtime Message import so a union struct can share the name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capnp-message-name-"));
    const schema = join(dir, "msg.capnp");
    writeFileSync(
      schema,
      `@0x91b2c3d4e5f60799;
struct Inner { n @0 :UInt32; }
struct Message {
  union {
    a @0 :UInt16;
    b @1 :UInt16;
  }
  inner @2 :Inner = (n = 1);
}
`,
    );
    const cgr = spawnSync("capnp", ["compile", "-o-", "-I", dir, schema]);
    expect(cgr.status).toBe(0);
    const ast = await walkCgr(new Uint8Array(cgr.stdout as Uint8Array));
    const file = ast.requestedFiles[0]!;
    const src = emitModuleSource(ast, file.filename, file.id);

    expect(src).toContain("export const Message = {");
    expect(src).toContain(
      'import { Message as CapnpMessage, PtrKind } from "@haozeke/capnp";',
    );
    expect(src).toContain("CapnpMessage.fromFlat(");
    expect(src).not.toContain("\nimport { Message }");
    expect(src).not.toMatch(/(?<!Capnp)Message\.fromFlat\(/);

    const outDir = mkdtempSync(join(tmpdir(), "capnp-message-name-tsc-"));
    writeFileSync(join(outDir, "stub.ts"), STUB);
    writeFileSync(join(outDir, "msg.ts"), src);
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
          files: ["msg.ts"],
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
