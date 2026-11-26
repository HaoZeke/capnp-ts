import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CapnpError,
  Message,
  MessageBuilder,
  NO_DISCRIMINANT,
  SchemaLoader,
  TypeKind,
  type StructBuilder,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "golden", "schema-validate");

const NODE_DW = 6;
const NODE_PW = 6;
const FIELD_DW = 3;
const FIELD_PW = 4;
const TYPE_DW = 3;
const TYPE_PW = 1;
const VALUE_DW = 2;
const VALUE_PW = 1;
const METHOD_DW = 3;
const METHOD_PW = 5;

function flatNode(id: bigint, name: string, which: number): {
  builder: MessageBuilder;
  node: StructBuilder;
} {
  const builder = new MessageBuilder();
  const node = builder.initRoot(NODE_DW, NODE_PW);
  node.setU64(0, id);
  node.setText(0, name);
  node.setU16(12, which);
  return { builder, node };
}

function typeTag(kind: "void" | "u32" | "struct"): number {
  if (kind === "void") return TypeKind.Void;
  if (kind === "u32") return TypeKind.UInt32;
  return TypeKind.Struct;
}

function writeType(
  parent: StructBuilder,
  slot: number,
  kind: "void" | "u32" | "struct",
  structId: bigint,
  brandBool: boolean,
): void {
  const type = parent.initStruct(slot, TYPE_DW, TYPE_PW);
  type.setU16(0, typeTag(kind));
  if (kind !== "struct") return;
  type.setU64(8, structId);
  if (!brandBool) return;
  const brand = type.initStruct(0, 0, 1);
  const scope = brand.initList(0, 1, 2, 1);
  scope.setU64(0, 0x51n);
  scope.setU16(8, 0);
  const binding = scope.initList(0, 1, 1, 1);
  binding.setU16(0, 1);
  const bound = binding.initStruct(0, TYPE_DW, TYPE_PW);
  bound.setU16(0, TypeKind.Bool);
}

function writeValue(
  parent: StructBuilder,
  slot: number,
  kind: "void" | "u32" | "struct",
): void {
  const value = parent.initStruct(slot, VALUE_DW, VALUE_PW);
  value.setU16(0, typeTag(kind));
}

interface SlotSpec {
  name: string;
  codeOrder: number;
  offset?: number;
  disc?: number;
  ordinal?: number;
  kind?: "void" | "u32" | "struct";
  structId?: bigint;
  brandBool?: boolean;
}

function writeFields(node: StructBuilder, specs: readonly SlotSpec[]): void {
  if (specs.length === 0) return;
  let field = node.initList(3, specs.length, FIELD_DW, FIELD_PW);
  for (let i = 0; i < specs.length; i++) {
    if (i > 0) field = field.nextElement();
    const spec = specs[i]!;
    const kind = spec.kind ?? "void";
    field.setText(0, spec.name);
    field.setU16(0, spec.codeOrder);
    if (spec.disc !== undefined) field.setU16(2, spec.disc, NO_DISCRIMINANT);
    field.setU16(8, 0);
    field.setU32(4, spec.offset ?? 0);
    if (spec.ordinal !== undefined) {
      field.setU16(10, 1);
      field.setU16(12, spec.ordinal);
    }
    writeType(field, 2, kind, spec.structId ?? 0n, spec.brandBool ?? false);
    writeValue(field, 3, kind);
  }
}

function structNode(opts: {
  id: bigint;
  name: string;
  dataWords?: number;
  pointers?: number;
  discCount?: number;
  discOffset?: number;
  isGroup?: boolean;
  scopeId?: bigint;
  fields?: readonly SlotSpec[];
}): Uint8Array {
  const { builder, node } = flatNode(opts.id, opts.name, 1);
  node.setU16(14, opts.dataWords ?? 0);
  node.setU16(24, opts.pointers ?? 0);
  node.setU16(30, opts.discCount ?? 0);
  node.setU32(32, opts.discOffset ?? 0);
  if (opts.scopeId !== undefined) node.setU64(16, opts.scopeId);
  if (opts.isGroup) node.setBool(224, true);
  writeFields(node, opts.fields ?? []);
  return builder.toFlat();
}

function enumNode(id: bigint, name: string): Uint8Array {
  return flatNode(id, name, 2).builder.toFlat();
}

function interfaceNode(id: bigint, name: string, codeOrder: number): Uint8Array {
  const { builder, node } = flatNode(id, name, 3);
  const method = node.initList(3, 1, METHOD_DW, METHOD_PW);
  method.setText(0, "call");
  method.setU16(0, codeOrder);
  return builder.toFlat();
}

interface EncodedCase {
  name: string;
  parts: Uint8Array[];
  accept: boolean;
  message: string;
}

const ENUM_ID = 0x1009n;
const STRUCT_KIND_ID = 0x100an;

function encodedCases(): EncodedCase[] {
  return [
    {
      name: "wrapped-u32-offset",
      accept: true,
      message: "",
      parts: [
        structNode({
          id: 0x1001n,
          name: "wrap.capnp:Wrap",
          dataWords: 1,
          fields: [
            {
              name: "n",
              codeOrder: 0,
              offset: 0x08000000,
              kind: "u32",
              ordinal: 0,
            },
          ],
        }),
      ],
    },
    {
      name: "zero-discriminant-count",
      accept: true,
      message: "",
      parts: [
        structNode({
          id: 0x1002n,
          name: "zero.capnp:Zero",
          dataWords: 1,
          discCount: 0,
          discOffset: 100,
          fields: [
            { name: "n", codeOrder: 0, offset: 0, kind: "u32", ordinal: 0 },
          ],
        }),
      ],
    },
    {
      name: "discriminant-out-of-range",
      accept: false,
      message: "invalid discriminantValue",
      parts: [
        structNode({
          id: 0x1003n,
          name: "range.capnp:Range",
          dataWords: 1,
          discCount: 2,
          fields: [
            { name: "a", codeOrder: 0, disc: 2, ordinal: 0 },
            { name: "b", codeOrder: 1, ordinal: 1 },
          ],
        }),
      ],
    },
    {
      name: "discriminant-duplicate",
      accept: false,
      message: "invalid discriminantValue",
      parts: [
        structNode({
          id: 0x1004n,
          name: "dup.capnp:Dup",
          dataWords: 1,
          discCount: 2,
          fields: [
            { name: "a", codeOrder: 0, disc: 0, ordinal: 0 },
            { name: "b", codeOrder: 1, disc: 0, ordinal: 1 },
          ],
        }),
      ],
    },
    {
      name: "discriminant-count-mismatch",
      accept: false,
      message: "discriminantCount did not match fields",
      parts: [
        structNode({
          id: 0x1005n,
          name: "mismatch.capnp:Mismatch",
          dataWords: 1,
          discCount: 2,
          fields: [
            { name: "a", codeOrder: 0, ordinal: 0 },
            { name: "b", codeOrder: 1, ordinal: 1 },
          ],
        }),
      ],
    },
    {
      name: "ordinal-out-of-order",
      accept: false,
      message: "fields were not ordered by ordinal",
      parts: [
        structNode({
          id: 0x1006n,
          name: "ord.capnp:Ord",
          fields: [
            { name: "a", codeOrder: 0, ordinal: 1 },
            { name: "b", codeOrder: 1, ordinal: 0 },
          ],
        }),
      ],
    },
    {
      name: "method-code-order",
      accept: false,
      message: "invalid codeOrder",
      parts: [interfaceNode(0x1007n, "iface.capnp:Iface", 1)],
    },
    {
      name: "group-missing-scope",
      accept: false,
      message: "group node missing scopeId",
      parts: [
        structNode({
          id: 0x1008n,
          name: "group.capnp:Group",
          isGroup: true,
        }),
      ],
    },
    {
      name: "type-id-kind",
      accept: false,
      message: "expected a different kind of node for this ID",
      parts: [
        enumNode(ENUM_ID, "kind.capnp:Color"),
        structNode({
          id: STRUCT_KIND_ID,
          name: "kind.capnp:Box",
          pointers: 1,
          fields: [
            {
              name: "r",
              codeOrder: 0,
              kind: "struct",
              structId: ENUM_ID,
              ordinal: 0,
            },
          ],
        }),
      ],
    },
    {
      name: "brand-non-pointer",
      accept: false,
      message: "generic type parameter must be a pointer type",
      parts: [
        structNode({
          id: 0x100bn,
          name: "brand.capnp:Brand",
          pointers: 1,
          fields: [
            {
              name: "r",
              codeOrder: 0,
              kind: "struct",
              structId: 0xabcdefn,
              brandBool: true,
              ordinal: 0,
            },
          ],
        }),
      ],
    },
  ];
}

function loadFlat(bytes: Uint8Array, loader = new SchemaLoader()): {
  loader: SchemaLoader;
  rootId: bigint;
  root: ReturnType<Message["root"]>;
} {
  const root = Message.fromFlat(bytes).root();
  return { loader, rootId: root.getU64(0), root };
}

function loadFixture(name: string): {
  loader: SchemaLoader;
  rootId: bigint;
  root: ReturnType<Message["root"]>;
} {
  const msg = Message.fromFlat(new Uint8Array(readFileSync(join(fixtureDir, name))));
  const root = msg.root();
  return { loader: new SchemaLoader(), rootId: root.getU64(0), root };
}

const rejected: readonly { file: string; message: string }[] = [
  { file: "probe-disc1.bin", message: "union must have at least two members" },
  { file: "probe-discoff.bin", message: "union discriminant is out-of-bounds" },
  { file: "probe-dupname.bin", message: "duplicate name; name = voidf" },
  { file: "probe-badoff.bin", message: "field offset out-of-bounds" },
  { file: "color-dupcode.bin", message: "invalid codeOrder" },
  { file: "box-nongeneric.bin", message: "isGeneric must be true" },
  { file: "pi-badvalue.bin", message: "Value did not match type" },
];

const dumpDir = process.env.DUMP_SCHEMA_FIXTURES;
if (dumpDir) {
  mkdirSync(dumpDir, { recursive: true });
  for (const item of encodedCases()) {
    item.parts.forEach((part, index) => {
      const suffix = item.parts.length > 1 ? `-${index}` : "";
      writeFileSync(join(dumpDir, `${item.name}${suffix}.bin`), part);
    });
  }
}

describe("SchemaLoader.loadNode validation", () => {
  test("probe-ok loads Probe with the C++ field counts", () => {
    const { loader, rootId, root } = loadFixture("probe-ok.bin");
    const schema = loader.loadNode(root);
    expect(schema.which).toBe("struct");
    expect(schema.displayName).toBe("gap.capnp:Probe");
    const st = schema.asStruct();
    expect(st.getFields().length).toBe(34);
    expect(st.dataWordCount).toBe(9);
    expect(st.pointerCount).toBe(16);
    expect(st.discriminantCount).toBe(4);
    expect(loader.has(rootId)).toBe(true);
  });

  for (const probe of rejected) {
    test(`${probe.file} is rejected and not kept`, () => {
      const { loader, rootId, root } = loadFixture(probe.file);
      let thrown: unknown;
      try {
        loader.loadNode(root);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(CapnpError);
      const err = thrown as CapnpError;
      expect(err.code).toBe("SCHEMA");
      expect(err.message).toContain(probe.message);
      expect(loader.has(rootId)).toBe(false);
    });
  }

  for (const item of encodedCases()) {
    test(`${item.name} ${item.accept ? "loads" : "is rejected"}`, () => {
      const loader = new SchemaLoader();
      for (const part of item.parts.slice(0, -1)) {
        const prior = Message.fromFlat(part).root();
        loader.loadNode(prior);
      }
      const { rootId, root } = loadFlat(item.parts[item.parts.length - 1]!, loader);
      if (item.accept) {
        const schema = loader.loadNode(root);
        expect(schema.which).toBe("struct");
        expect(loader.has(rootId)).toBe(true);
        const st = schema.asStruct();
        if (item.name === "wrapped-u32-offset") {
          expect(st.getFields()[0]!.offset).toBe(0x08000000);
          expect(st.dataWordCount).toBe(1);
        }
        if (item.name === "zero-discriminant-count") {
          expect(st.discriminantCount).toBe(0);
          expect(st.discriminantOffset).toBe(100);
          expect(st.getFields().length).toBe(1);
        }
        return;
      }
      let thrown: unknown;
      try {
        loader.loadNode(root);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(CapnpError);
      const err = thrown as CapnpError;
      expect(err.code).toBe("SCHEMA");
      expect(err.message).toContain(item.message);
      expect(loader.has(rootId)).toBe(false);
      if (item.name === "type-id-kind") expect(loader.has(ENUM_ID)).toBe(true);
    });
  }
});
