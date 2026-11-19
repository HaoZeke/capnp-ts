/**
 * Annotation target flags come from Node.annotation bits 112..123,
 * not from displayNamePrefixLength (byte offset 8).
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { walkCgr } from "../src/cgr-walk.ts";
import { emitModuleSource } from "../src/emit.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures/ann-targets.cgr.bin");
const schema = join(here, "fixtures/ann-targets.capnp");

function hasCapnp(): boolean {
  return spawnSync("capnp", ["--version"], { encoding: "utf8" }).status === 0;
}

async function masksOf(bytes: Uint8Array): Promise<Record<string, number>> {
  const ast = await walkCgr(bytes);
  const out: Record<string, number> = {};
  for (const n of ast.nodes) {
    if (n.which !== "annotation" || !n.annotation) continue;
    const name = n.displayName.slice(n.displayNamePrefixLength);
    out[name] = n.annotation.targetsMask;
  }
  return out;
}

describe("annotation targetsMask", () => {
  test("fixture decodes struct, file+field, and star masks", async () => {
    const masks = await masksOf(new Uint8Array(readFileSync(fixture)));
    // targetsFile is bit 0, targetsStruct is bit 4, targetsField is bit 5.
    expect(masks.foo).toBe(0x10);
    expect(masks.bar).toBe(0x21);
    expect(masks.many).toBe(0xfff);
    const ast = await walkCgr(new Uint8Array(readFileSync(fixture)));
    const src = emitModuleSource(ast, "ann-targets.capnp", ast.requestedFiles[0]?.id);
    expect(src).toContain("FOO_ANNOTATION_TARGETS_MASK = 16");
    expect(src).toContain("BAR_ANNOTATION_TARGETS_MASK = 33");
    expect(src).toContain("MANY_ANNOTATION_TARGETS_MASK = 4095");
    // The old decoder reused displayNamePrefixLength, which is 18 for all three.
    expect(src).not.toContain("ANNOTATION_TARGETS_MASK = 18");
  });

  test.skipIf(!hasCapnp())("capnp compile matches the checked-in request", async () => {
    const r = spawnSync("capnp", ["compile", "-o-", schema]);
    expect(r.status).toBe(0);
    const live = await masksOf(new Uint8Array(r.stdout as Uint8Array));
    const stored = await masksOf(new Uint8Array(readFileSync(fixture)));
    expect(live).toEqual(stored);
  });
});
