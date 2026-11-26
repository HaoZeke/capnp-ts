import { describe, expect, test } from "bun:test";
import {
  Message,
  MessageBuilder,
  SchemaLoader,
  TypeKind,
  initDynamicRoot,
  type StructBuilder,
} from "../src/index.ts";

const NODE_DW = 6;
const NODE_PW = 6;
const FIELD_DW = 3;
const FIELD_PW = 4;
const TYPE_DW = 3;
const TYPE_PW = 1;
const VALUE_DW = 2;
const VALUE_PW = 1;

function flatNode(id: bigint, name: string): StructBuilder {
  const builder = new MessageBuilder();
  const node = builder.initRoot(NODE_DW, NODE_PW);
  node.setU64(0, id);
  node.setText(0, name);
  node.setU16(12, 1);
  return node;
}

function finish(node: StructBuilder): Uint8Array {
  return node.builder.toFlat();
}

function parentBytes(): Uint8Array {
  const node = flatNode(0x2222n, "Parent");
  node.setU16(14, 0);
  node.setU16(24, 0);
  const field = node.initList(3, 1, FIELD_DW, FIELD_PW);
  field.setText(0, "g");
  field.setU16(0, 0);
  field.setU16(8, 1);
  field.setU64(16, 0x3333n);
  return finish(node);
}

function groupBytes(): Uint8Array {
  const node = flatNode(0x3333n, "Parent.g");
  node.setU64(16, 0x2222n);
  node.setBool(224, true);
  node.setU16(14, 1);
  node.setU16(24, 0);
  const field = node.initList(3, 1, FIELD_DW, FIELD_PW);
  field.setText(0, "x");
  field.setU16(0, 0);
  field.setU16(8, 0);
  field.setU32(4, 0);
  const type = field.initStruct(2, TYPE_DW, TYPE_PW);
  type.setU16(0, TypeKind.UInt64);
  const value = field.initStruct(3, VALUE_DW, VALUE_PW);
  value.setU16(0, TypeKind.UInt64);
  return finish(node);
}

function loadBoth(parentFirst: boolean): SchemaLoader {
  const loader = new SchemaLoader();
  const parent = Message.fromFlat(parentBytes()).root();
  const group = Message.fromFlat(groupBytes()).root();
  if (parentFirst) {
    loader.loadNode(parent);
    loader.loadNode(group);
  } else {
    loader.loadNode(group);
    loader.loadNode(parent);
  }
  return loader;
}

describe("SchemaLoader group parent size", () => {
  test("a group larger than its parent grows the parent", () => {
    const loader = loadBoth(true);
    const parent = loader.get(0x2222n).asStruct();
    expect(parent.dataWordCount).toBe(1);
    expect(parent.pointerCount).toBe(0);
    const builder = new MessageBuilder();
    const root = initDynamicRoot(builder, parent);
    root.init("g").asStruct().set("x", 0x1122334455667788n);
    const back = root.asReader().get("g").asStruct().get("x").asUInt64();
    expect(back).toBe(0x1122334455667788n);
  });

  test("loading the group first still grows the parent", () => {
    const loader = loadBoth(false);
    const parent = loader.get(0x2222n).asStruct();
    expect(parent.dataWordCount).toBe(1);
    expect(parent.pointerCount).toBe(0);
  });
});
