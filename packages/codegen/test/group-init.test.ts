import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { walkCgr } from "../src/cgr-walk.ts";
import { emitModuleSource, emitSourceString } from "../src/emit.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");

async function loadFixture(name: string) {
  return walkCgr(
    new Uint8Array(readFileSync(join(fixturesDir, `${name}.cgr.bin`))),
  );
}

describe("group init wrappers", () => {
  test("dual fixture emits group init wrappers for parent group fields", async () => {
    const ast = await loadFixture("dual");
    const src = emitSourceString(ast);
    expect(src).toContain(
      "export function Dual_initPrimary(ptr: StructBuilder): StructBuilder {",
    );
    expect(src).toContain(
      "export function Dual_initSecondary(ptr: StructBuilder): StructBuilder {",
    );
    expect(src).toContain("  return ptr;");
  });

  test("group init wrapper sets parent discriminant for union group arms", async () => {
    const synthetic = {
      nodes: [
        {
          id: 0x10n,
          displayName: "synth.capnp:Root",
          displayNamePrefixLength: 0,
          scopeId: 0n,
          which: "struct" as const,
          whichTag: 1,
          nestedNodes: [],
          struct: {
            dataWordCount: 1,
            pointerCount: 0,
            isGroup: false,
            discriminantCount: 2,
            discriminantOffset: 1,
            fields: [
              {
                name: "pick",
                codeOrder: 0,
                discriminant: 3,
                group: { typeId: 0x11n },
              },
            ],
          },
        },
        {
          id: 0x11n,
          displayName: "synth.capnp:Root.pick",
          displayNamePrefixLength: 0,
          scopeId: 0x10n,
          which: "struct" as const,
          whichTag: 1,
          nestedNodes: [],
          struct: {
            dataWordCount: 1,
            pointerCount: 0,
            isGroup: true,
            discriminantCount: 0,
            discriminantOffset: 0,
            fields: [],
          },
        },
      ],
      requestedFiles: [{ id: 0n, filename: "synth.capnp" }],
    };
    const src = emitModuleSource(synthetic as never, "synth.capnp", 0n);
    expect(src).toContain(
      "export function Root_initPick(ptr: StructBuilder): StructBuilder {",
    );
    expect(src).toContain("  ptr.setU16(2, 3);");
    expect(src).toContain("  return ptr;");
  });
});
