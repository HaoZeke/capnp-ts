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

describe("generic emit and cross-module type wiring", () => {
  test("box emit carries generic anypointer wrappers and brand metadata", async () => {
    const ast = await loadFixture("box");
    const src = emitSourceString(ast);
    expect(src).toContain("export type CapnpAnyPointer = Ptr;");
    expect(src).toContain("export type CapnpAnyStruct = Ptr;");
    expect(src).toContain("export type CapnpAnyList = Ptr;");
    expect(src).toContain("export type Box_Ptr = Ptr;");
    expect(src).toContain('export const Box_typeParameters = ["T"] as const;');
    expect(src).toContain(
      "export function Box_getValue<T extends CapnpAnyPointer = CapnpAnyPointer>(ptr: Ptr): T {",
    );
    expect(src).toContain(
      "export function Box_setValue<T extends CapnpAnyPointer = CapnpAnyPointer>(ptr: StructBuilder, value: T): void {",
    );
    expect(src).toContain("export const BOX_USE_TEXT_BOX_TYPE = ");
    expect(src).toContain("brand{scope(");
  });

  test("kitchen emit imports sibling module pointer aliases for shared structs", async () => {
    const ast = await loadFixture("kitchen");
    const kitchen = ast.requestedFiles.find(
      (rf) => rf.filename === "schema/kitchen.capnp",
    );
    const common = ast.requestedFiles.find(
      (rf) => rf.filename === "schema/common.capnp",
    );
    expect(kitchen).toBeDefined();
    expect(common).toBeDefined();

    const kitchenSrc = emitModuleSource(
      ast,
      kitchen?.filename ?? "schema/kitchen.capnp",
      kitchen?.id,
    );
    expect(kitchenSrc).toContain('import type * as __capnp_');
    expect(kitchenSrc).toContain('from "./common.ts";');
    expect(kitchenSrc).toContain(
      "export function Sink_getOrigin(ptr: Ptr): __capnp_",
    );
    expect(kitchenSrc).toContain(
      "export function Sink_getSpotsAt(ptr: Ptr, index: number): __capnp_",
    );

    const commonSrc = emitModuleSource(
      ast,
      common?.filename ?? "schema/common.capnp",
      common?.id,
    );
    expect(commonSrc).toContain("export type Vec3_Ptr = Ptr;");
  });
});
