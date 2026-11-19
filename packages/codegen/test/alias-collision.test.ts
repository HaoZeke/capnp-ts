/**
 * An unrequested import whose short name matches a local type must not
 * reuse that local alias. capnpc-c++ keeps the other file's name in its
 * own namespace; the stub declared here is qualified the same way.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_DISCRIMINANT, type CgrAst, type NodeAst } from "../src/cgr-walk.ts";
import { emitModuleSource } from "../src/emit.ts";

const OTHER = 0xa11ce000n;
const OTHER_SLOT = 0xa11ce001n;
const OTHER_BAR = 0xa11ce002n;
const HERE = 0xb0b000n;
const HERE_SLOT = 0xb0b001n;
const HERE_BAR = 0xb0b002n;
const HERE_WRAP = 0xb0b003n;

function fileNode(id: bigint, filename: string, nested: { name: string; id: bigint }[]): NodeAst {
  return {
    id,
    displayName: filename,
    displayNamePrefixLength: filename.length,
    scopeId: 0n,
    which: "file",
    whichTag: 0,
    nestedNodes: nested,
  };
}

function structNode(
  id: bigint,
  fileId: bigint,
  filename: string,
  name: string,
  fields: NodeAst["struct"] extends infer S ? (S extends { fields: infer F } ? F : never) : never,
): NodeAst {
  return {
    id,
    displayName: `${filename}:${name}`,
    displayNamePrefixLength: filename.length + 1,
    scopeId: fileId,
    which: "struct",
    whichTag: 1,
    nestedNodes: [],
    struct: {
      dataWordCount: 1,
      pointerCount: fields.some((f) => f.slot?.type.which !== "uint16") ? 1 : 0,
      isGroup: false,
      discriminantCount: 0,
      discriminantOffset: 0,
      fields,
    },
  };
}

function slotField(
  name: string,
  offset: number,
  type: NonNullable<NodeAst["struct"]>["fields"][number]["slot"] extends infer S
    ? S extends { type: infer T }
      ? T
      : never
    : never,
): NonNullable<NodeAst["struct"]>["fields"][number] {
  return {
    name,
    codeOrder: offset,
    discriminant: NO_DISCRIMINANT,
    slot: { offset, type },
  };
}

describe("unrequested external aliases", () => {
  test("a local type of the same short name keeps its own alias", () => {
    const ast: CgrAst = {
      requestedFiles: [{ id: HERE, filename: "here.capnp" }],
      nodes: [
        fileNode(OTHER, "other.capnp", [
          { name: "Slot", id: OTHER_SLOT },
          { name: "Bar", id: OTHER_BAR },
        ]),
        structNode(OTHER_SLOT, OTHER, "other.capnp", "Slot", [
          slotField("val", 0, { which: "uint32" }),
        ]),
        {
          id: OTHER_BAR,
          displayName: "other.capnp:Bar",
          displayNamePrefixLength: "other.capnp:".length,
          scopeId: OTHER,
          which: "interface",
          whichTag: 3,
          nestedNodes: [],
          methods: [],
        },
        fileNode(HERE, "here.capnp", [
          { name: "Slot", id: HERE_SLOT },
          { name: "Bar", id: HERE_BAR },
          { name: "Wrap", id: HERE_WRAP },
        ]),
        structNode(HERE_SLOT, HERE, "here.capnp", "Slot", [
          slotField("n", 0, { which: "uint16" }),
        ]),
        {
          id: HERE_BAR,
          displayName: "here.capnp:Bar",
          displayNamePrefixLength: "here.capnp:".length,
          scopeId: HERE,
          which: "interface",
          whichTag: 3,
          nestedNodes: [],
          methods: [],
        },
        structNode(HERE_WRAP, HERE, "here.capnp", "Wrap", [
          slotField("ext", 0, { which: "struct", typeId: OTHER_SLOT }),
          slotField("peer", 1, { which: "interface", typeId: OTHER_BAR }),
          slotField("own", 2, { which: "struct", typeId: HERE_SLOT }),
        ]),
      ],
    };

    const src = emitModuleSource(ast, "here.capnp", HERE);
    const aliases = src
      .split("\n")
      .filter((line) => line.startsWith("export type Slot_Ptr"));
    expect(aliases).toEqual(["export type Slot_Ptr = Ptr;"]);
    const barAliases = src
      .split("\n")
      .filter((line) => line.startsWith("export type Bar_Capability"));
    expect(barAliases).toEqual(["export type Bar_Capability = Ptr;"]);
    expect(src).toContain("export type other_Slot_Ptr = Ptr;");
    expect(src).toContain("export type other_Bar_Capability = Ptr;");
    expect(src).toContain("Wrap_getExt(ptr: Ptr): other_Slot_Ptr");
    expect(src).toContain("Wrap_getPeer(ptr: Ptr): other_Bar_Capability");
    expect(src).toContain("Wrap_getOwn(ptr: Ptr): Slot_Ptr");

    const dir = mkdtempSync(join(tmpdir(), "capnp-alias-"));
    writeFileSync(
      join(dir, "stub.ts"),
      `export class Ptr {
  kind = 0;
  getP(_index: number): Ptr { return this; }
  getU16(_byte: number, _dflt?: number): number { return 0; }
}
export class StructBuilder {
  setP(_index: number, _value: Ptr): void {}
  setU16(_byte: number, _value: number, _dflt?: number): void {}
  initStruct(_index: number, _dwords: number, _pwords: number): StructBuilder {
    return this;
  }
}
`,
    );
    writeFileSync(join(dir, "here.ts"), src);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
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
        files: ["here.ts"],
      }),
    );
    const checked = spawnSync(
      "bunx",
      ["tsc", "-p", join(dir, "tsconfig.json"), "--pretty", "false", "--noEmit"],
      { encoding: "utf8" },
    );
    const text = `${checked.stdout ?? ""}\n${checked.stderr ?? ""}`;
    expect(text).not.toContain("error TS");
    expect(checked.status).toBe(0);
  });
});
