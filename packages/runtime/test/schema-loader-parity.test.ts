import { describe, expect, test } from "bun:test";
import {
  CapnpError,
  Message,
  MessageBuilder,
  NO_DISCRIMINANT,
  SchemaLoader,
  SchemaNodeKind,
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

interface U32Field {
  name: string;
  offset: number;
  def: number;
}

function u32Struct(id: bigint, name: string, fields: readonly U32Field[]): Uint8Array {
  const node = flatNode(id, name);
  node.setU16(14, 1);
  node.setU16(24, 0);
  let field = node.initList(3, fields.length, FIELD_DW, FIELD_PW);
  for (let i = 0; i < fields.length; i++) {
    if (i > 0) field = field.nextElement();
    const spec = fields[i]!;
    field.setText(0, spec.name);
    field.setU16(0, i);
    field.setU16(8, 0);
    field.setU32(4, spec.offset);
    field.setU16(10, 1);
    field.setU16(12, i);
    const type = field.initStruct(2, TYPE_DW, TYPE_PW);
    type.setU16(0, TypeKind.UInt32);
    const value = field.initStruct(3, VALUE_DW, VALUE_PW);
    value.setU16(0, TypeKind.UInt32);
    value.setU32(4, spec.def);
  }
  return finish(node);
}

function loadFlat(loader: SchemaLoader, bytes: Uint8Array): void {
  loader.loadNode(Message.fromFlat(bytes).root());
}

describe("SchemaLoader group parent size", () => {
  test("a truncated struct node grows to fit a wider group", () => {
    const loader = new SchemaLoader();
    const parent = 0xc200n;
    loadFlat(loader, shortStruct(parent, "Outer"));
    expect(loader.get(parent).getProto().dwords).toBe(2);
    loadFlat(
      loader,
      declNode({
        id: 0xc201n,
        name: "G",
        scopeId: parent,
        isGroup: true,
        dataWords: 3,
        pointers: 2,
      }),
    );
    const grown = loader.get(parent).asStruct();
    expect(grown.dataWordCount).toBe(3);
    expect(grown.pointerCount).toBe(2);
    expect(grown.getProto().getU16(14)).toBe(3);
    expect(grown.getProto().getU16(24)).toBe(2);
  });

  test("a group larger than its parent grows the parent", () => {
    const loader = loadBoth(true);
    const parent = loader.get(0x2222n).asStruct();
    expect(parent.dataWordCount).toBe(1);
    expect(parent.pointerCount).toBe(0);
    expect(parent.getProto().getU16(14)).toBe(1);
    expect(parent.getProto().getU16(24)).toBe(0);
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
    expect(parent.getProto().getU16(14)).toBe(1);
    expect(parent.getProto().getU16(24)).toBe(0);
  });
});

describe("SchemaLoader schema reload", () => {
  test("an incompatible default change throws and keeps the first node", () => {
    const loader = new SchemaLoader();
    loadFlat(loader, u32Struct(0x7777n, "V1", [{ name: "x", offset: 0, def: 7 }]));
    let thrown: unknown;
    try {
      loadFlat(loader, u32Struct(0x7777n, "V2", [{ name: "x", offset: 0, def: 9 }]));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CapnpError);
    expect((thrown as CapnpError).code).toBe("SCHEMA");
    expect((thrown as CapnpError).message).toContain("default value changed");
    const field = loader.get(0x7777n).asStruct().getFields()[0]!;
    expect(field.defaultValue).toEqual({ which: "uint32", value: 7 });
    expect(loader.get(0x7777n).displayName).toBe("V1");
  });

  test("a second load with a new field replaces the node", () => {
    const loader = new SchemaLoader();
    loadFlat(loader, u32Struct(0x7777n, "V1", [{ name: "x", offset: 0, def: 7 }]));
    loadFlat(
      loader,
      u32Struct(0x7777n, "V2", [
        { name: "x", offset: 0, def: 7 },
        { name: "y", offset: 1, def: 0 },
      ]),
    );
    const st = loader.get(0x7777n).asStruct();
    expect(st.getFields().map((f) => f.name)).toEqual(["x", "y"]);
    expect(st.displayName).toBe("V2");
  });

  test("a second load that drops a field keeps the first node", () => {
    const loader = new SchemaLoader();
    loadFlat(
      loader,
      u32Struct(0x7777n, "V1", [
        { name: "x", offset: 0, def: 7 },
        { name: "y", offset: 1, def: 0 },
      ]),
    );
    loadFlat(loader, u32Struct(0x7777n, "V2", [{ name: "x", offset: 0, def: 7 }]));
    const st = loader.get(0x7777n).asStruct();
    expect(st.getFields().map((f) => f.name)).toEqual(["x", "y"]);
    expect(st.displayName).toBe("V1");
  });

  test("reloading an equivalent node keeps the first name", () => {
    const loader = new SchemaLoader();
    loadFlat(loader, u32Struct(0x7777n, "V1", [{ name: "x", offset: 0, def: 7 }]));
    loadFlat(loader, u32Struct(0x7777n, "Renamed", [{ name: "z", offset: 0, def: 7 }]));
    const st = loader.get(0x7777n).asStruct();
    expect(st.displayName).toBe("V1");
    expect(st.getFields()[0]!.name).toBe("x");
    expect(st.getFields()[0]!.defaultValue).toEqual({ which: "uint32", value: 7 });
  });

  test("an identical NaN float default reloads", () => {
    const loader = new SchemaLoader();
    const nan32 = 0x7fc00000;
    const nan64 = 0x7ff8000000000000n;
    loadFlat(
      loader,
      declNode({
        id: 0x7771n,
        name: "F32",
        dataWords: 1,
        fields: [{ name: "x", type: TypeKind.Float32, def: nan32 }],
      }),
    );
    loadFlat(
      loader,
      declNode({
        id: 0x7771n,
        name: "F32b",
        dataWords: 1,
        fields: [{ name: "x", type: TypeKind.Float32, def: nan32 }],
      }),
    );
    expect(loader.get(0x7771n).displayName).toBe("F32");
    expect(loader.get(0x7771n).asStruct().getFields()[0]!.defaultValue).toMatchObject({
      which: "float32",
      rawBits: nan32,
    });
    loadFlat(
      loader,
      declNode({
        id: 0x7773n,
        name: "F64",
        dataWords: 1,
        fields: [{ name: "x", type: TypeKind.Float64, def: nan64 }],
      }),
    );
    loadFlat(
      loader,
      declNode({
        id: 0x7773n,
        name: "F64b",
        dataWords: 1,
        fields: [{ name: "x", type: TypeKind.Float64, def: nan64 }],
      }),
    );
    expect(loader.get(0x7773n).displayName).toBe("F64");
    expect(loader.get(0x7773n).asStruct().getFields()[0]!.defaultValue).toMatchObject({
      which: "float64",
      rawBits: nan64,
    });
  });

  test("negative zero and positive zero float defaults differ", () => {
    const loader = new SchemaLoader();
    const neg32 = 0x80000000;
    const neg64 = 0x8000000000000000n;
    loadFlat(
      loader,
      declNode({
        id: 0x7772n,
        name: "Z32",
        dataWords: 1,
        fields: [{ name: "x", type: TypeKind.Float32, def: neg32 }],
      }),
    );
    const thrown32 = capture(() => {
      loadFlat(
        loader,
        declNode({
          id: 0x7772n,
          name: "Z32b",
          dataWords: 1,
          fields: [{ name: "x", type: TypeKind.Float32, def: 0 }],
        }),
      );
    });
    expect(thrown32).toBeInstanceOf(CapnpError);
    expect((thrown32 as CapnpError).message).toContain("default value changed");
    expect(loader.get(0x7772n).asStruct().getFields()[0]!.defaultValue).toMatchObject({
      which: "float32",
      rawBits: neg32,
    });
    loadFlat(
      loader,
      declNode({
        id: 0x7774n,
        name: "Z64",
        dataWords: 1,
        fields: [{ name: "x", type: TypeKind.Float64, def: neg64 }],
      }),
    );
    const thrown64 = capture(() => {
      loadFlat(
        loader,
        declNode({
          id: 0x7774n,
          name: "Z64b",
          dataWords: 1,
          fields: [{ name: "x", type: TypeKind.Float64, def: 0n }],
        }),
      );
    });
    expect(thrown64).toBeInstanceOf(CapnpError);
    expect((thrown64 as CapnpError).message).toContain("default value changed");
    expect(loader.get(0x7774n).asStruct().getFields()[0]!.defaultValue).toMatchObject({
      which: "float64",
      rawBits: neg64,
    });
  });

  test("NaN defaults with different payloads do not reload", () => {
    const loader = new SchemaLoader();
    const nan32 = 0x7fc00000;
    const other32 = 0x7fc00001;
    const nan64 = 0x7ff8000000000000n;
    const other64 = 0x7ff8000000000001n;
    loadFlat(
      loader,
      declNode({
        id: 0x7775n,
        name: "F32",
        dataWords: 1,
        fields: [{ name: "x", type: TypeKind.Float32, def: nan32 }],
      }),
    );
    const thrown32 = capture(() => {
      loadFlat(
        loader,
        declNode({
          id: 0x7775n,
          name: "F32b",
          dataWords: 1,
          fields: [{ name: "x", type: TypeKind.Float32, def: other32 }],
        }),
      );
    });
    expect(thrown32).toBeInstanceOf(CapnpError);
    expect((thrown32 as CapnpError).message).toContain("default value changed");
    expect(loader.get(0x7775n).displayName).toBe("F32");
    expect(loader.get(0x7775n).asStruct().getFields()[0]!.defaultValue).toMatchObject({
      which: "float32",
      rawBits: nan32,
    });
    loadFlat(
      loader,
      declNode({
        id: 0x7776n,
        name: "F64",
        dataWords: 1,
        fields: [{ name: "x", type: TypeKind.Float64, def: nan64 }],
      }),
    );
    const thrown64 = capture(() => {
      loadFlat(
        loader,
        declNode({
          id: 0x7776n,
          name: "F64b",
          dataWords: 1,
          fields: [{ name: "x", type: TypeKind.Float64, def: other64 }],
        }),
      );
    });
    expect(thrown64).toBeInstanceOf(CapnpError);
    expect((thrown64 as CapnpError).message).toContain("default value changed");
    expect(loader.get(0x7776n).displayName).toBe("F64");
    expect(loader.get(0x7776n).asStruct().getFields()[0]!.defaultValue).toMatchObject({
      which: "float64",
      rawBits: nan64,
    });
  });

  test("a const type cache follows a newer reload", () => {
    const loader = new SchemaLoader();
    loadFlat(
      loader,
      declNode({
        id: 0x8890n,
        name: "Pi",
        which: SchemaNodeKind.Const,
        constType: TypeKind.UInt32,
      }),
    );
    const fetched = loader.get(0x8890n).asConst();
    expect(fetched.getType().which).toBe("uint32");
    loadFlat(
      loader,
      declNode({
        id: 0x8890n,
        name: "Pi",
        which: SchemaNodeKind.Const,
        constType: TypeKind.Text,
        generic: true,
        params: ["T"],
      }),
    );
    expect(fetched.getType().which).toBe("text");
  });

  test("two brands of a generic const and annotation keep their own types", () => {
    const loader = new SchemaLoader();
    const constId = 0xc100n;
    const annId = 0xc101n;
    loadFlat(loader, genericParamDecl(constId, "Box", SchemaNodeKind.Const));
    loadFlat(loader, genericParamDecl(annId, "Tag", SchemaNodeKind.Annotation));
    const textConst = loader.get(constId, brandFor(constId, TypeKind.Text)).asConst();
    const dataConst = loader.get(constId, brandFor(constId, TypeKind.Data)).asConst();
    expect(textConst.getType().which).toBe("text");
    expect(dataConst.getType().which).toBe("data");
    expect(textConst.getType().which).toBe("text");
    const textAnn = loader.get(annId, brandFor(annId, TypeKind.Text)).asAnnotation();
    const dataAnn = loader.get(annId, brandFor(annId, TypeKind.Data)).asAnnotation();
    expect(textAnn.getType().which).toBe("text");
    expect(dataAnn.getType().which).toBe("data");
    expect(textAnn.getType().which).toBe("text");
  });

  test("a fetched schema sees a newer field list", () => {
    const loader = new SchemaLoader();
    loadFlat(loader, u32Struct(0x7777n, "V1", [{ name: "x", offset: 0, def: 7 }]));
    const fetched = loader.get(0x7777n).asStruct();
    expect(fetched.getFields().map((f) => f.name)).toEqual(["x"]);
    loadFlat(
      loader,
      u32Struct(0x7777n, "V2", [
        { name: "x", offset: 0, def: 7 },
        { name: "y", offset: 1, def: 0 },
      ]),
    );
    expect(fetched.getFields().map((f) => f.name)).toEqual(["x", "y"]);
    expect(fetched.displayName).toBe("V2");
    expect(loader.get(0x7777n).asStruct().getFields().map((f) => f.name)).toEqual(["x", "y"]);
  });
});

interface FieldSpec {
  name: string;
  type: number;
  offset?: number;
  ordinal?: number;
  disc?: number;
  def?: number | bigint;
  typeId?: bigint;
  element?: number;
  elementId?: bigint;
  groupId?: bigint;
}

function declNode(opts: {
  id: bigint;
  name: string;
  which?: number;
  dataWords?: number;
  pointers?: number;
  discCount?: number;
  discOffset?: number;
  fields?: readonly FieldSpec[];
  enumerants?: readonly string[];
  methods?: readonly { name: string; param: bigint; result: bigint }[];
  supers?: readonly bigint[];
  scopeId?: bigint;
  isGroup?: boolean;
  constType?: number;
  generic?: boolean;
  params?: readonly string[];
}): Uint8Array {
  const node = flatNode(opts.id, opts.name);
  node.setU16(12, opts.which ?? SchemaNodeKind.Struct);
  if (opts.scopeId !== undefined) node.setU64(16, opts.scopeId);
  if (opts.isGroup) node.setBool(224, true);
  if (opts.generic) node.setBool(288, true);
  node.setU16(14, opts.dataWords ?? 0);
  node.setU16(24, opts.pointers ?? 0);
  node.setU16(30, opts.discCount ?? 0);
  node.setU32(32, opts.discOffset ?? 0);
  const fields = opts.fields ?? [];
  if (fields.length > 0) {
    let field = node.initList(3, fields.length, FIELD_DW, FIELD_PW);
    for (let i = 0; i < fields.length; i++) {
      if (i > 0) field = field.nextElement();
      writeField(field, fields[i]!, i);
    }
  }
  const enumerants = opts.enumerants ?? [];
  if (enumerants.length > 0) {
    let enumerant = node.initList(3, enumerants.length, 1, 2);
    for (let i = 0; i < enumerants.length; i++) {
      if (i > 0) enumerant = enumerant.nextElement();
      enumerant.setText(0, enumerants[i]!);
      enumerant.setU16(0, i);
    }
  }
  const methods = opts.methods ?? [];
  if (methods.length > 0) {
    let method = node.initList(3, methods.length, 3, 5);
    for (let i = 0; i < methods.length; i++) {
      if (i > 0) method = method.nextElement();
      const spec = methods[i]!;
      method.setText(0, spec.name);
      method.setU16(0, i);
      method.setU64(8, spec.param);
      method.setU64(16, spec.result);
    }
  }
  if (opts.constType !== undefined) {
    node.initStruct(3, TYPE_DW, TYPE_PW).setU16(0, opts.constType);
    node.initStruct(4, VALUE_DW, VALUE_PW).setU16(0, opts.constType);
  }
  const params = opts.params ?? [];
  if (params.length > 0) {
    let param = node.initList(5, params.length, 0, 1);
    for (let i = 0; i < params.length; i++) {
      if (i > 0) param = param.nextElement();
      param.setText(0, params[i]!);
    }
  }
  const supers = opts.supers ?? [];
  if (supers.length > 0) {
    let sc = node.initList(4, supers.length, 1, 1);
    for (let i = 0; i < supers.length; i++) {
      if (i > 0) sc = sc.nextElement();
      sc.setU64(0, supers[i]!);
    }
  }
  return finish(node);
}

function writeField(field: StructBuilder, spec: FieldSpec, index: number): void {
  field.setText(0, spec.name);
  field.setU16(0, index);
  field.setU16(8, spec.groupId !== undefined ? 1 : 0);
  field.setU32(4, spec.offset ?? 0);
  field.setU16(10, 1);
  field.setU16(12, spec.ordinal ?? index);
  if (spec.disc !== undefined) field.setU16(2, spec.disc, NO_DISCRIMINANT);
  if (spec.groupId !== undefined) {
    field.setU64(16, spec.groupId);
    return;
  }
  const type = field.initStruct(2, TYPE_DW, TYPE_PW);
  type.setU16(0, spec.type);
  if (spec.typeId !== undefined) type.setU64(8, spec.typeId);
  if (spec.element !== undefined) {
    const element = type.initStruct(0, TYPE_DW, TYPE_PW);
    element.setU16(0, spec.element);
    if (spec.elementId !== undefined) element.setU64(8, spec.elementId);
  }
  const value = field.initStruct(3, VALUE_DW, VALUE_PW);
  value.setU16(0, spec.type);
  if (typeof spec.def === "number") value.setU32(4, spec.def);
  else if (typeof spec.def === "bigint") value.setU64(8, spec.def);
}

function groupNode(id: bigint, name: string, groupId: bigint, dataWords: number): Uint8Array {
  const node = flatNode(id, name);
  node.setU16(14, dataWords);
  node.setU16(24, 0);
  const field = node.initList(3, 1, FIELD_DW, FIELD_PW);
  field.setText(0, "g");
  field.setU16(0, 0);
  field.setU16(8, 1);
  field.setU16(10, 1);
  field.setU16(12, 0);
  field.setU64(16, groupId);
  return finish(node);
}

function capture(fn: () => void): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

function genericParamDecl(id: bigint, name: string, which: number): Uint8Array {
  const node = flatNode(id, name);
  node.setU16(12, which);
  node.setBool(288, true);
  node.initList(5, 1, 0, 1).setText(0, "T");
  const type = node.initStruct(3, TYPE_DW, TYPE_PW);
  type.setU16(0, TypeKind.AnyPointer);
  type.setU16(8, 1);
  type.setU16(10, 0);
  type.setU64(16, id);
  if (which === SchemaNodeKind.Const) {
    node.initStruct(4, VALUE_DW, VALUE_PW).setU16(0, TypeKind.AnyPointer);
  }
  return finish(node);
}

function brandFor(scopeId: bigint, typeTag: number, typeId?: bigint) {
  const builder = new MessageBuilder();
  const brand = builder.initRoot(0, 1);
  const scope = brand.initList(0, 1, 2, 1);
  scope.setU64(0, scopeId);
  const binding = scope.initList(0, 1, 1, 1);
  binding.setU16(0, 1);
  const type = binding.initStruct(0, TYPE_DW, TYPE_PW);
  type.setU16(0, typeTag);
  if (typeId !== undefined) type.setU64(8, typeId);
  return Message.fromFlat(builder.toFlat()).root();
}

function shortStruct(id: bigint, name: string): Uint8Array {
  const builder = new MessageBuilder();
  const node = builder.initRoot(2, 1);
  node.setU64(0, id);
  node.setText(0, name);
  node.setU16(12, SchemaNodeKind.Struct);
  return finish(node);
}

describe("SchemaLoader upgrade bookkeeping", () => {
  test("a generated placeholder stays hidden until a real node is loaded", () => {
    const loader = new SchemaLoader();
    const target = 0x8101n;
    loadFlat(
      loader,
      declNode({
        id: 0x8100n,
        name: "Box",
        pointers: 1,
        fields: [{ name: "items", type: TypeKind.List, element: TypeKind.UInt32 }],
      }),
    );
    loadFlat(
      loader,
      declNode({
        id: 0x8100n,
        name: "Box2",
        pointers: 1,
        fields: [
          {
            name: "items",
            type: TypeKind.List,
            element: TypeKind.Struct,
            elementId: target,
          },
        ],
      }),
    );
    expect(loader.get(0x8100n).displayName).toBe("Box2");
    expect(loader.has(target)).toBe(false);
    expect(loader.allNodes().map((n) => n.id)).not.toContain(target);
    expect(capture(() => loader.get(target))).toBeInstanceOf(CapnpError);
    loadFlat(
      loader,
      declNode({
        id: target,
        name: "RealTarget",
        dataWords: 1,
        fields: [
          { name: "member0", type: TypeKind.UInt32, def: 0 },
          { name: "extra", type: TypeKind.UInt32, offset: 1, def: 0 },
        ],
      }),
    );
    expect(loader.has(target)).toBe(true);
    expect(loader.get(target).displayName).toBe("RealTarget");
    expect(loader.get(target).asStruct().getFields().map((f) => f.name)).toEqual([
      "member0",
      "extra",
    ]);
  });

  test("an upgrade constraint does not hide a loaded node", () => {
    const loader = new SchemaLoader();
    const groupId = 0x8201n;
    loadFlat(loader, declNode({ id: groupId, name: "Real", fields: [] }));
    const fetched = loader.get(groupId).asStruct();
    expect(fetched.getFields()).toHaveLength(0);
    loadFlat(
      loader,
      declNode({
        id: 0x8200n,
        name: "Parent",
        dataWords: 1,
        fields: [{ name: "x", type: TypeKind.UInt64, def: 0n }],
      }),
    );
    loadFlat(loader, groupNode(0x8200n, "Parent", groupId, 1));
    expect(loader.get(0x8200n).asStruct().getFields()[0]!.kind).toBe("group");
    expect(loader.has(groupId)).toBe(true);
    expect(loader.allNodes().map((n) => n.id)).toContain(groupId);
    expect(fetched.displayName).toBe("(unknown type used in Parent)");
    expect(fetched.getFields()).toHaveLength(1);
    expect(loader.get(groupId).displayName).toBe(fetched.displayName);
    loadFlat(
      loader,
      declNode({
        id: groupId,
        name: "Second",
        dataWords: 1,
        fields: [{ name: "z", type: TypeKind.UInt64, def: 0n }],
      }),
    );
    expect(loader.get(groupId).displayName).toBe("(unknown type used in Parent)");
    expect(fetched.getFields()).toHaveLength(1);
  });

  test("a placeholder stays hidden when brand resolution throws", () => {
    const loader = new SchemaLoader();
    const target = 0xc321n;
    loadFlat(
      loader,
      declNode({
        id: 0xc320n,
        name: "Box",
        pointers: 1,
        fields: [{ name: "items", type: TypeKind.List, element: TypeKind.UInt32 }],
      }),
    );
    loadFlat(
      loader,
      declNode({
        id: 0xc320n,
        name: "Box2",
        pointers: 1,
        fields: [
          {
            name: "items",
            type: TypeKind.List,
            element: TypeKind.Struct,
            elementId: target,
          },
        ],
      }),
    );
    expect(loader.has(target)).toBe(false);
    const thrown = capture(() => {
      loader.dependency(target, brandFor(target, TypeKind.Struct, 0xc322n), new Map());
    });
    expect(thrown).toBeInstanceOf(CapnpError);
    expect(loader.has(target)).toBe(false);
    loader.dependency(target, null, new Map());
    expect(loader.has(target)).toBe(true);
  });

  test("a slot upgrade mixed with a dropped field throws", () => {
    const loader = new SchemaLoader();
    loadFlat(
      loader,
      declNode({
        id: 0x8210n,
        name: "Parent",
        dataWords: 2,
        fields: [
          { name: "x", type: TypeKind.UInt64, def: 0n },
          { name: "y", type: TypeKind.UInt64, offset: 1, def: 0n },
        ],
      }),
    );
    const thrown = capture(() => {
      loadFlat(loader, groupNode(0x8210n, "Parent2", 0x8211n, 2));
    });
    expect(thrown).toBeInstanceOf(CapnpError);
    expect((thrown as CapnpError).message).toContain("upgrades and some");
    expect(loader.get(0x8210n).displayName).toBe("Parent");
    expect(loader.get(0x8210n).asStruct().getFields()).toHaveLength(2);
  });

  test("a group field downgraded to a slot keeps the group", () => {
    const loader = new SchemaLoader();
    const groupId = 0x8231n;
    loadFlat(
      loader,
      declNode({
        id: groupId,
        name: "G",
        dataWords: 1,
        fields: [{ name: "x", type: TypeKind.UInt64, def: 1n }],
      }),
    );
    loadFlat(loader, groupNode(0x8230n, "V1", groupId, 1));
    loadFlat(
      loader,
      declNode({
        id: 0x8230n,
        name: "V2",
        dataWords: 1,
        fields: [{ name: "x", type: TypeKind.UInt64, def: 1n }],
      }),
    );
    expect(loader.get(0x8230n).displayName).toBe("V1");
    expect(loader.get(0x8230n).asStruct().getFields()[0]!.kind).toBe("group");
  });

  test("mixed upgrade and downgrade throws and keeps the first node", () => {
    const loader = new SchemaLoader();
    loadFlat(
      loader,
      u32Struct(0x8300n, "V1", [
        { name: "x", offset: 0, def: 1 },
        { name: "y", offset: 1, def: 2 },
      ]),
    );
    const thrown = capture(() => {
      loadFlat(
        loader,
        declNode({
          id: 0x8300n,
          name: "V2",
          dataWords: 2,
          fields: [{ name: "x", type: TypeKind.UInt32, def: 1 }],
        }),
      );
    });
    expect(thrown).toBeInstanceOf(CapnpError);
    expect((thrown as CapnpError).message).toContain("upgrades and some");
    expect(loader.get(0x8300n).displayName).toBe("V1");
    expect(loader.get(0x8300n).asStruct().getFields()).toHaveLength(2);
  });

  test("a data word upgrade mixed with a pointer downgrade throws", () => {
    const loader = new SchemaLoader();
    loadFlat(
      loader,
      declNode({
        id: 0x8310n,
        name: "V1",
        dataWords: 1,
        pointers: 2,
        fields: [{ name: "x", type: TypeKind.UInt32, def: 1 }],
      }),
    );
    const thrown = capture(() => {
      loadFlat(
        loader,
        declNode({
          id: 0x8310n,
          name: "V2",
          dataWords: 2,
          pointers: 1,
          fields: [{ name: "x", type: TypeKind.UInt32, def: 1 }],
        }),
      );
    });
    expect(thrown).toBeInstanceOf(CapnpError);
    expect((thrown as CapnpError).message).toContain("upgrades and some");
    expect(loader.get(0x8310n).displayName).toBe("V1");
    expect(loader.get(0x8310n).asStruct().dataWordCount).toBe(1);
    expect(loader.get(0x8310n).asStruct().pointerCount).toBe(2);
  });

  test("a fetched interface sees added methods and superclasses", () => {
    const loader = new SchemaLoader();
    const param = 0x8402n;
    const result = 0x8403n;
    loadFlat(loader, declNode({ id: param, name: "Param", fields: [] }));
    loadFlat(loader, declNode({ id: result, name: "Result", fields: [] }));
    loadFlat(loader, declNode({ id: 0x8401n, name: "Base", which: SchemaNodeKind.Interface }));
    loadFlat(
      loader,
      declNode({
        id: 0x8400n,
        name: "Api",
        which: SchemaNodeKind.Interface,
        methods: [{ name: "ping", param, result }],
      }),
    );
    const fetched = loader.get(0x8400n).asInterface();
    expect(fetched.getMethods().map((m) => m.name)).toEqual(["ping"]);
    loadFlat(
      loader,
      declNode({
        id: 0x8400n,
        name: "Api",
        which: SchemaNodeKind.Interface,
        methods: [
          { name: "ping", param, result },
          { name: "pong", param, result },
        ],
        supers: [0x8401n],
      }),
    );
    expect(fetched.getMethods().map((m) => m.name)).toEqual(["ping", "pong"]);
    expect(fetched.getSuperclasses().map((sc) => sc.id)).toEqual([0x8401n]);
  });

  test("an interface parameter change throws and keeps the first method", () => {
    const loader = new SchemaLoader();
    loadFlat(
      loader,
      declNode({
        id: 0x8410n,
        name: "Api",
        which: SchemaNodeKind.Interface,
        methods: [{ name: "ping", param: 0x8411n, result: 0x8412n }],
      }),
    );
    const thrown = capture(() => {
      loadFlat(
        loader,
        declNode({
          id: 0x8410n,
          name: "Api2",
          which: SchemaNodeKind.Interface,
          methods: [{ name: "ping", param: 0x8413n, result: 0x8412n }],
        }),
      );
    });
    expect(thrown).toBeInstanceOf(CapnpError);
    expect((thrown as CapnpError).message).toContain("different parameters");
    expect(loader.get(0x8410n).displayName).toBe("Api");
    expect(loader.get(0x8410n).asInterface().getMethods()[0]!.name).toBe("ping");
  });

  test("a fetched enum sees an added enumerant", () => {
    const loader = new SchemaLoader();
    loadFlat(
      loader,
      declNode({
        id: 0x8500n,
        name: "Color",
        which: SchemaNodeKind.Enum,
        enumerants: ["red"],
      }),
    );
    const fetched = loader.get(0x8500n).asEnum();
    expect(fetched.getEnumerants().map((e) => e.name)).toEqual(["red"]);
    loadFlat(
      loader,
      declNode({
        id: 0x8500n,
        name: "Color",
        which: SchemaNodeKind.Enum,
        enumerants: ["red", "blue"],
      }),
    );
    expect(fetched.getEnumerants().map((e) => e.name)).toEqual(["red", "blue"]);
    expect(loader.get(0x8500n).asEnum().getEnumerants()).toHaveLength(2);
  });

  test("a fetched struct sees a union added in the newer schema", () => {
    const loader = new SchemaLoader();
    loadFlat(
      loader,
      declNode({
        id: 0x8600n,
        name: "Pair",
        fields: [
          { name: "a", type: TypeKind.Void },
          { name: "b", type: TypeKind.Void },
        ],
      }),
    );
    const fetched = loader.get(0x8600n).asStruct();
    expect(fetched.discriminantCount).toBe(0);
    expect(fetched.getFields()).toHaveLength(2);
    loadFlat(
      loader,
      declNode({
        id: 0x8600n,
        name: "Pair",
        dataWords: 1,
        discCount: 2,
        fields: [
          { name: "a", type: TypeKind.Void },
          { name: "b", type: TypeKind.Void },
          { name: "c", type: TypeKind.Void, disc: 0 },
          { name: "d", type: TypeKind.Void, disc: 1 },
        ],
      }),
    );
    expect(fetched.discriminantCount).toBe(2);
    expect(fetched.getFields().map((f) => f.name)).toEqual(["a", "b", "c", "d"]);
    expect(fetched.getUnionFields().map((f) => f.name)).toEqual(["c", "d"]);
  });

  test("moving the union discriminant throws", () => {
    const loader = new SchemaLoader();
    loadFlat(
      loader,
      declNode({
        id: 0x8610n,
        name: "U",
        dataWords: 1,
        discCount: 2,
        discOffset: 0,
        fields: [
          { name: "a", type: TypeKind.Void, disc: 0 },
          { name: "b", type: TypeKind.Void, disc: 1 },
        ],
      }),
    );
    const thrown = capture(() => {
      loadFlat(
        loader,
        declNode({
          id: 0x8610n,
          name: "U2",
          dataWords: 1,
          discCount: 2,
          discOffset: 1,
          fields: [
            { name: "a", type: TypeKind.Void, disc: 0 },
            { name: "b", type: TypeKind.Void, disc: 1 },
          ],
        }),
      );
    });
    expect(thrown).toBeInstanceOf(CapnpError);
    expect((thrown as CapnpError).message).toContain("union discriminant position changed");
    expect(loader.get(0x8610n).asStruct().discriminantOffset).toBe(0);
  });

  test("Text to Data is rejected when the default value tag differs", () => {
    const loader = new SchemaLoader();
    loadFlat(
      loader,
      declNode({
        id: 0x8700n,
        name: "Blob",
        pointers: 1,
        fields: [{ name: "t", type: TypeKind.Text }],
      }),
    );
    const fetched = loader.get(0x8700n).asStruct();
    const thrown = capture(() => {
      loadFlat(
        loader,
        declNode({
          id: 0x8700n,
          name: "Blob",
          pointers: 1,
          fields: [{ name: "t", type: TypeKind.Data }],
        }),
      );
    });
    expect(thrown).toBeInstanceOf(CapnpError);
    expect((thrown as CapnpError).message).toContain("default value changed");
    expect(fetched.getFields()[0]!.getType().which).toBe("text");
  });

  test("a list of bytes to Data is rejected when the default value tag differs", () => {
    const loader = new SchemaLoader();
    loadFlat(
      loader,
      declNode({
        id: 0x8710n,
        name: "Bytes",
        pointers: 1,
        fields: [{ name: "b", type: TypeKind.List, element: TypeKind.UInt8 }],
      }),
    );
    const thrown = capture(() => {
      loadFlat(
        loader,
        declNode({
          id: 0x8710n,
          name: "Bytes",
          pointers: 1,
          fields: [{ name: "b", type: TypeKind.Data }],
        }),
      );
    });
    expect(thrown).toBeInstanceOf(CapnpError);
    expect((thrown as CapnpError).message).toContain("default value changed");
    expect(loader.get(0x8710n).asStruct().getFields()[0]!.getType().which).toBe("list");
  });

  test("a list of Int16 does not upgrade to Data", () => {
    const loader = new SchemaLoader();
    loadFlat(
      loader,
      declNode({
        id: 0x8720n,
        name: "Words",
        pointers: 1,
        fields: [{ name: "w", type: TypeKind.List, element: TypeKind.Int16 }],
      }),
    );
    const thrown = capture(() => {
      loadFlat(
        loader,
        declNode({
          id: 0x8720n,
          name: "Words",
          pointers: 1,
          fields: [{ name: "w", type: TypeKind.Data }],
        }),
      );
    });
    expect(thrown).toBeInstanceOf(CapnpError);
    expect((thrown as CapnpError).message).toContain("a type was changed");
    expect(loader.get(0x8720n).asStruct().getFields()[0]!.getType().which).toBe("list");
  });

  test("Text to AnyPointer is rejected when the default value tag differs", () => {
    const loader = new SchemaLoader();
    loadFlat(
      loader,
      declNode({
        id: 0x8730n,
        name: "Ptr",
        pointers: 1,
        fields: [{ name: "p", type: TypeKind.Text }],
      }),
    );
    const fetched = loader.get(0x8730n).asStruct();
    const thrown = capture(() => {
      loadFlat(
        loader,
        declNode({
          id: 0x8730n,
          name: "Ptr",
          pointers: 1,
          fields: [{ name: "p", type: TypeKind.AnyPointer }],
        }),
      );
    });
    expect(thrown).toBeInstanceOf(CapnpError);
    expect((thrown as CapnpError).message).toContain("default value changed");
    expect(fetched.getFields()[0]!.getType().which).toBe("text");
  });

  test("a struct field type change throws", () => {
    const loader = new SchemaLoader();
    loadFlat(
      loader,
      declNode({
        id: 0x8740n,
        name: "Slot",
        dataWords: 1,
        pointers: 1,
        fields: [{ name: "n", type: TypeKind.UInt32, def: 3 }],
      }),
    );
    const thrown = capture(() => {
      loadFlat(
        loader,
        declNode({
          id: 0x8740n,
          name: "Slot",
          dataWords: 1,
          pointers: 1,
          fields: [{ name: "n", type: TypeKind.Struct, typeId: 0x8741n }],
        }),
      );
    });
    expect(thrown).toBeInstanceOf(CapnpError);
    expect((thrown as CapnpError).message).toContain("a type was changed");
    expect(loader.get(0x8740n).asStruct().getFields()[0]!.getType().which).toBe("uint32");
    expect(loader.has(0x8741n)).toBe(false);
    loadFlat(
      loader,
      declNode({
        id: 0x8741n,
        name: "Color",
        which: SchemaNodeKind.Enum,
        enumerants: ["red"],
      }),
    );
    expect(loader.get(0x8741n).asEnum().getEnumerants().map((e) => e.name)).toEqual(["red"]);
  });

  test("a rejected group reload does not grow the parent", () => {
    const loader = new SchemaLoader();
    const parent = 0x8760n;
    const group = 0x8761n;
    loadFlat(loader, declNode({ id: parent, name: "Outer" }));
    loadFlat(
      loader,
      declNode({
        id: group,
        name: "Outer.g",
        scopeId: parent,
        isGroup: true,
        dataWords: 1,
        fields: [{ name: "x", type: TypeKind.UInt32, def: 1 }],
      }),
    );
    expect(loader.get(parent).asStruct().dataWordCount).toBe(1);
    const thrown = capture(() => {
      loadFlat(
        loader,
        declNode({
          id: group,
          name: "Outer.g2",
          scopeId: parent,
          isGroup: true,
          dataWords: 4,
          fields: [{ name: "x", type: TypeKind.UInt32, def: 2 }],
        }),
      );
    });
    expect(thrown).toBeInstanceOf(CapnpError);
    expect((thrown as CapnpError).message).toContain("default value changed");
    expect(loader.get(parent).asStruct().dataWordCount).toBe(1);
    expect(loader.get(parent).getProto().getU16(14)).toBe(1);
    expect(loader.get(group).displayName).toBe("Outer.g");
  });

  test("a list element upgraded to a struct stays out of allNodes", () => {
    const loader = new SchemaLoader();
    const target = 0x8751n;
    loadFlat(
      loader,
      declNode({
        id: 0x8750n,
        name: "Box",
        pointers: 1,
        fields: [{ name: "items", type: TypeKind.List, element: TypeKind.UInt32 }],
      }),
    );
    const fetched = loader.get(0x8750n).asStruct();
    loadFlat(
      loader,
      declNode({
        id: 0x8750n,
        name: "Box2",
        pointers: 1,
        fields: [
          {
            name: "items",
            type: TypeKind.List,
            element: TypeKind.Struct,
            elementId: target,
          },
        ],
      }),
    );
    expect(fetched.displayName).toBe("Box2");
    expect(loader.has(target)).toBe(false);
    expect(loader.allNodes().map((n) => n.id)).not.toContain(target);
    const element = fetched.getFields()[0]!.getType().asList().getElementType();
    expect(element.which).toBe("struct");
    expect(element.asStruct().getFields()).toHaveLength(1);
    expect(loader.has(target)).toBe(true);
  });

  test("a list struct upgrade mixed with a dropped field throws", () => {
    const loader = new SchemaLoader();
    loadFlat(
      loader,
      declNode({
        id: 0x8752n,
        name: "Box",
        dataWords: 1,
        pointers: 1,
        fields: [
          { name: "items", type: TypeKind.List, element: TypeKind.UInt32 },
          { name: "n", type: TypeKind.UInt32, def: 1 },
        ],
      }),
    );
    const thrown = capture(() => {
      loadFlat(
        loader,
        declNode({
          id: 0x8752n,
          name: "Box2",
          pointers: 1,
          fields: [
            {
              name: "items",
              type: TypeKind.List,
              element: TypeKind.Struct,
              elementId: 0x8753n,
            },
          ],
        }),
      );
    });
    expect(thrown).toBeInstanceOf(CapnpError);
    expect((thrown as CapnpError).message).toContain("upgrades and some");
    expect(loader.get(0x8752n).displayName).toBe("Box");
    expect(loader.get(0x8752n).asStruct().getFields()).toHaveLength(2);
  });

  test("a list struct downgraded to a scalar keeps the struct list", () => {
    const loader = new SchemaLoader();
    const target = 0x8755n;
    loadFlat(
      loader,
      declNode({
        id: target,
        name: "Item",
        dataWords: 1,
        fields: [{ name: "member0", type: TypeKind.UInt32, def: 0 }],
      }),
    );
    loadFlat(
      loader,
      declNode({
        id: 0x8754n,
        name: "Box",
        pointers: 1,
        fields: [
          {
            name: "items",
            type: TypeKind.List,
            element: TypeKind.Struct,
            elementId: target,
          },
        ],
      }),
    );
    loadFlat(
      loader,
      declNode({
        id: 0x8754n,
        name: "BoxOld",
        pointers: 1,
        fields: [{ name: "items", type: TypeKind.List, element: TypeKind.UInt32 }],
      }),
    );
    expect(loader.get(0x8754n).displayName).toBe("Box");
    expect(
      loader.get(0x8754n).asStruct().getFields()[0]!.getType().asList().getElementType().which,
    ).toBe("struct");
  });

  test("an equivalent real node replaces a placeholder that was already read", () => {
    const cases: ReadonlyArray<{
      id: bigint;
      target: bigint;
      name: string;
      type: number;
      targetWhich: number;
      dataWords: number;
      pointers: number;
      read: (loader: SchemaLoader, id: bigint) => { displayName: string };
    }> = [
      {
        id: 0x8800n,
        target: 0x8801n,
        name: "Box",
        type: TypeKind.Struct,
        targetWhich: SchemaNodeKind.Struct,
        dataWords: 0,
        pointers: 1,
        read: (loader, id) => loader.get(id).asStruct().getFields()[0]!.getType().asStruct(),
      },
      {
        id: 0x8810n,
        target: 0x8811n,
        name: "Hue",
        type: TypeKind.Enum,
        targetWhich: SchemaNodeKind.Enum,
        dataWords: 1,
        pointers: 0,
        read: (loader, id) => loader.get(id).asStruct().getFields()[0]!.getType().asEnum(),
      },
      {
        id: 0x8820n,
        target: 0x8821n,
        name: "Api",
        type: TypeKind.Interface,
        targetWhich: SchemaNodeKind.Interface,
        dataWords: 0,
        pointers: 1,
        read: (loader, id) => loader.get(id).asStruct().getFields()[0]!.getType().asInterface(),
      },
    ];
    for (const spec of cases) {
      const loader = new SchemaLoader();
      loadFlat(
        loader,
        declNode({
          id: spec.id,
          name: spec.name,
          dataWords: spec.dataWords,
          pointers: spec.pointers,
          fields: [{ name: "item", type: spec.type, typeId: spec.target }],
        }),
      );
      expect(loader.has(spec.target)).toBe(false);
      const seen = spec.read(loader, spec.id);
      expect(loader.has(spec.target)).toBe(true);
      expect(seen.displayName).toBe(`(unknown type used by ${spec.name})`);
      loadFlat(
        loader,
        declNode({ id: spec.target, name: "Real", which: spec.targetWhich }),
      );
      expect(seen.displayName).toBe("Real");
      expect(loader.get(spec.target).displayName).toBe("Real");
    }
  });

  test("slot and group fields upgrade in both directions", () => {
    const slotFirst = new SchemaLoader();
    const groupId = 0xac01n;
    loadFlat(
      slotFirst,
      declNode({
        id: 0xac00n,
        name: "V1",
        dataWords: 1,
        fields: [{ name: "x", type: TypeKind.UInt64, def: 4n }],
      }),
    );
    loadFlat(slotFirst, groupNode(0xac00n, "V2", groupId, 1));
    const upgraded = slotFirst.get(0xac00n).asStruct();
    expect(upgraded.displayName).toBe("V2");
    expect(upgraded.getFields()[0]!.kind).toBe("group");
    const placeholder = upgraded.getFields()[0]!.getType().asStruct();
    expect(placeholder.id).toBe(groupId);
    expect(placeholder.getFields()[0]!.name).toBe("member0");
    expect(placeholder.getFields()[0]!.getType().which).toBe("uint64");

    const groupFirst = new SchemaLoader();
    const kept = 0xac11n;
    loadFlat(
      groupFirst,
      declNode({
        id: kept,
        name: "G",
        dataWords: 1,
        fields: [{ name: "x", type: TypeKind.UInt64, def: 4n }],
      }),
    );
    loadFlat(groupFirst, groupNode(0xac10n, "V1", kept, 1));
    loadFlat(
      groupFirst,
      declNode({
        id: 0xac10n,
        name: "V2",
        dataWords: 1,
        fields: [{ name: "x", type: TypeKind.UInt64, def: 4n }],
      }),
    );
    expect(groupFirst.get(0xac10n).displayName).toBe("V1");
    expect(groupFirst.get(0xac10n).asStruct().getFields()[0]!.kind).toBe("group");
  });

  test("a group id change is rejected", () => {
    const loader = new SchemaLoader();
    const parent = 0xaa00n;
    const first = 0xaa01n;
    const second = 0xaa02n;
    loadFlat(
      loader,
      declNode({
        id: parent,
        name: "V1",
        fields: [{ name: "g", type: TypeKind.Void, groupId: first }],
      }),
    );
    const thrown = capture(() => {
      loadFlat(
        loader,
        declNode({
          id: parent,
          name: "V2",
          fields: [{ name: "g", type: TypeKind.Void, groupId: second }],
        }),
      );
    });
    expect(thrown).toBeInstanceOf(CapnpError);
    expect((thrown as CapnpError).message).toContain("group id changed");
    expect(loader.get(parent).displayName).toBe("V1");
    expect(loader.has(second)).toBe(false);
    expect(loader.get(parent).asStruct().getFields()[0]!.getType().asStruct().id).toBe(first);
  });

  test("a group scope change is rejected", () => {
    const loader = new SchemaLoader();
    const group = 0xaa10n;
    const scope1 = 0xaa11n;
    const scope2 = 0xaa12n;
    loadFlat(loader, declNode({ id: scope1, name: "S1" }));
    loadFlat(loader, declNode({ id: scope2, name: "S2" }));
    loadFlat(
      loader,
      declNode({
        id: group,
        name: "G1",
        scopeId: scope1,
        isGroup: true,
        dataWords: 2,
      }),
    );
    expect(loader.get(scope1).asStruct().dataWordCount).toBe(2);
    const thrown = capture(() => {
      loadFlat(
        loader,
        declNode({
          id: group,
          name: "G2",
          scopeId: scope2,
          isGroup: true,
          dataWords: 4,
        }),
      );
    });
    expect(thrown).toBeInstanceOf(CapnpError);
    expect((thrown as CapnpError).message).toContain("group node's scope changed");
    expect(loader.get(group).displayName).toBe("G1");
    expect(loader.get(group).scopeId).toBe(scope1);
    expect(loader.get(group).asStruct().dataWordCount).toBe(2);
    expect(loader.get(scope1).asStruct().dataWordCount).toBe(2);
    expect(loader.get(scope2).asStruct().dataWordCount).toBe(0);
  });

  test("interface superclass branches follow one direction", () => {
    const b1 = 0xab01n;
    const b2 = 0xab02n;
    const b3 = 0xab03n;
    const api = 0xab00n;
    const bases = [b1, b2, b3];

    function fresh(name: string, supers: readonly bigint[]): SchemaLoader {
      const loader = new SchemaLoader();
      for (const id of bases) {
        loadFlat(
          loader,
          declNode({
            id,
            name: `Base${id.toString(16)}`,
            which: SchemaNodeKind.Interface,
          }),
        );
      }
      loadFlat(
        loader,
        declNode({ id: api, name, which: SchemaNodeKind.Interface, supers }),
      );
      return loader;
    }

    function reload(loader: SchemaLoader, name: string, supers: readonly bigint[]): void {
      loadFlat(
        loader,
        declNode({ id: api, name, which: SchemaNodeKind.Interface, supers }),
      );
    }

    const added = fresh("V1", [b1]);
    reload(added, "V2", [b1, b2]);
    expect(added.get(api).displayName).toBe("V2");
    expect(added.get(api).asInterface().getSuperclasses().map((sc) => sc.id)).toEqual([b1, b2]);

    const dropped = fresh("V1", [b1, b2]);
    reload(dropped, "V2", [b1]);
    expect(dropped.get(api).displayName).toBe("V1");
    expect(dropped.get(api).asInterface().getSuperclasses().map((sc) => sc.id)).toEqual([
      b1,
      b2,
    ]);

    const lowerNew = fresh("V1", [b2, b3]);
    reload(lowerNew, "V2", [b1, b2, b3]);
    expect(lowerNew.get(api).displayName).toBe("V2");
    expect(lowerNew.get(api).asInterface().getSuperclasses().map((sc) => sc.id)).toEqual([
      b1,
      b2,
      b3,
    ]);

    const lowerGone = fresh("V1", [b1, b3]);
    reload(lowerGone, "V2", [b3]);
    expect(lowerGone.get(api).displayName).toBe("V1");
    expect(lowerGone.get(api).asInterface().getSuperclasses().map((sc) => sc.id)).toEqual([
      b1,
      b3,
    ]);

    const swapped = fresh("V1", [b1]);
    const thrown = capture(() => {
      reload(swapped, "V2", [b2]);
    });
    expect(thrown).toBeInstanceOf(CapnpError);
    expect((thrown as CapnpError).message).toContain("upgrades and some");
    expect(swapped.get(api).displayName).toBe("V1");
    expect(swapped.get(api).asInterface().getSuperclasses().map((sc) => sc.id)).toEqual([b1]);
  });

  test("enum struct and interface ids must match", () => {
    const cases: ReadonlyArray<{
      id: bigint;
      left: bigint;
      right: bigint;
      type: number;
      which: number;
      dataWords: number;
      pointers: number;
      message: string;
      read: (loader: SchemaLoader, id: bigint) => bigint;
    }> = [
      {
        id: 0xae00n,
        left: 0xae01n,
        right: 0xae02n,
        type: TypeKind.Enum,
        which: SchemaNodeKind.Enum,
        dataWords: 1,
        pointers: 0,
        message: "type changed enum type",
        read: (loader, id) =>
          loader.get(id).asStruct().getFields()[0]!.getType().asEnum().id,
      },
      {
        id: 0xae10n,
        left: 0xae11n,
        right: 0xae12n,
        type: TypeKind.Struct,
        which: SchemaNodeKind.Struct,
        dataWords: 0,
        pointers: 1,
        message: "type changed to incompatible struct type",
        read: (loader, id) =>
          loader.get(id).asStruct().getFields()[0]!.getType().asStruct().id,
      },
      {
        id: 0xae20n,
        left: 0xae21n,
        right: 0xae22n,
        type: TypeKind.Interface,
        which: SchemaNodeKind.Interface,
        dataWords: 0,
        pointers: 1,
        message: "type changed to incompatible interface type",
        read: (loader, id) =>
          loader.get(id).asStruct().getFields()[0]!.getType().asInterface().id,
      },
    ];
    for (const spec of cases) {
      const loader = new SchemaLoader();
      loadFlat(
        loader,
        declNode({
          id: spec.left,
          name: "Left",
          which: spec.which,
          enumerants: spec.which === SchemaNodeKind.Enum ? ["a"] : [],
        }),
      );
      loadFlat(
        loader,
        declNode({
          id: spec.right,
          name: "Right",
          which: spec.which,
          enumerants: spec.which === SchemaNodeKind.Enum ? ["b"] : [],
        }),
      );
      loadFlat(
        loader,
        declNode({
          id: spec.id,
          name: "V1",
          dataWords: spec.dataWords,
          pointers: spec.pointers,
          fields: [{ name: "item", type: spec.type, typeId: spec.left }],
        }),
      );
      const thrown = capture(() => {
        loadFlat(
          loader,
          declNode({
            id: spec.id,
            name: "V2",
            dataWords: spec.dataWords,
            pointers: spec.pointers,
            fields: [{ name: "item", type: spec.type, typeId: spec.right }],
          }),
        );
      });
      expect(thrown).toBeInstanceOf(CapnpError);
      expect((thrown as CapnpError).message).toContain(spec.message);
      expect(loader.get(spec.id).displayName).toBe("V1");
      expect(spec.read(loader, spec.id)).toBe(spec.left);
    }
  });

  test("an older Data or AnyPointer list element stays in place", () => {
    const cases: ReadonlyArray<{
      id: bigint;
      older: number;
      elementId?: bigint;
      which: "data" | "anyPointer";
    }> = [
      { id: 0xaf00n, older: TypeKind.Text, which: "data" },
      { id: 0xaf20n, older: TypeKind.Text, which: "anyPointer" },
      { id: 0xaf30n, older: TypeKind.Data, which: "anyPointer" },
      { id: 0xaf40n, older: TypeKind.Struct, elementId: 0xaf41n, which: "anyPointer" },
    ];
    for (const spec of cases) {
      const loader = new SchemaLoader();
      const element = spec.which === "data" ? TypeKind.Data : TypeKind.AnyPointer;
      loadFlat(
        loader,
        declNode({
          id: spec.id,
          name: "V1",
          pointers: 1,
          fields: [{ name: "b", type: TypeKind.List, element }],
        }),
      );
      loadFlat(
        loader,
        declNode({
          id: spec.id,
          name: "V2",
          pointers: 1,
          fields: [
            {
              name: "b",
              type: TypeKind.List,
              element: spec.older,
              elementId: spec.elementId,
            },
          ],
        }),
      );
      expect(loader.get(spec.id).displayName).toBe("V1");
      expect(
        loader.get(spec.id).asStruct().getFields()[0]!.getType().asList().getElementType().which,
      ).toBe(spec.which);
    }
  });

  test("a reverse list element upgrade keeps the struct list", () => {
    const loader = new SchemaLoader();
    const target = 0xb001n;
    loadFlat(
      loader,
      declNode({
        id: 0xb000n,
        name: "Box",
        pointers: 1,
        fields: [
          {
            name: "items",
            type: TypeKind.List,
            element: TypeKind.Struct,
            elementId: target,
          },
        ],
      }),
    );
    expect(loader.has(target)).toBe(false);
    loadFlat(
      loader,
      declNode({
        id: 0xb000n,
        name: "BoxOld",
        pointers: 1,
        fields: [{ name: "items", type: TypeKind.List, element: TypeKind.UInt32 }],
      }),
    );
    expect(loader.get(0xb000n).displayName).toBe("Box");
    expect(loader.has(target)).toBe(false);
    const element = loader
      .get(0xb000n)
      .asStruct()
      .getFields()[0]!
      .getType()
      .asList()
      .getElementType();
    expect(element.which).toBe("struct");
    expect(element.asStruct().dataWordCount).toBe(1);
    expect(element.asStruct().pointerCount).toBe(0);
    expect(element.asStruct().getFields()[0]!.name).toBe("member0");
    expect(element.asStruct().getFields()[0]!.getType().which).toBe("uint32");
  });

  test("struct size requirements keep the earlier maximum", () => {
    const parent = 0xad00n;
    const loader = new SchemaLoader();
    loadFlat(loader, declNode({ id: parent, name: "Outer" }));
    loadFlat(
      loader,
      declNode({
        id: 0xad01n,
        name: "G1",
        scopeId: parent,
        isGroup: true,
        dataWords: 2,
      }),
    );
    expect(loader.get(parent).asStruct().dataWordCount).toBe(2);
    expect(loader.get(parent).asStruct().pointerCount).toBe(0);
    loadFlat(
      loader,
      declNode({
        id: 0xad02n,
        name: "G2",
        scopeId: parent,
        isGroup: true,
        pointers: 3,
      }),
    );
    expect(loader.get(parent).asStruct().dataWordCount).toBe(2);
    expect(loader.get(parent).asStruct().pointerCount).toBe(3);
    expect(loader.get(parent).getProto().getU16(14)).toBe(2);
    expect(loader.get(parent).getProto().getU16(24)).toBe(3);
    loadFlat(
      loader,
      declNode({
        id: 0xad03n,
        name: "G3",
        scopeId: parent,
        isGroup: true,
        dataWords: 1,
        pointers: 1,
      }),
    );
    expect(loader.get(parent).asStruct().dataWordCount).toBe(2);
    expect(loader.get(parent).asStruct().pointerCount).toBe(3);
    expect(loader.get(parent).getProto().getU16(14)).toBe(2);
    expect(loader.get(parent).getProto().getU16(24)).toBe(3);

    const later = new SchemaLoader();
    const parent2 = 0xad10n;
    loadFlat(
      later,
      declNode({
        id: 0xad11n,
        name: "H1",
        scopeId: parent2,
        isGroup: true,
        dataWords: 4,
        pointers: 1,
      }),
    );
    loadFlat(
      later,
      declNode({
        id: 0xad12n,
        name: "H2",
        scopeId: parent2,
        isGroup: true,
        dataWords: 2,
        pointers: 5,
      }),
    );
    loadFlat(later, declNode({ id: parent2, name: "Outer2", dataWords: 1 }));
    const applied = later.get(parent2).asStruct();
    expect(applied.displayName).toBe("Outer2");
    expect(applied.dataWordCount).toBe(4);
    expect(applied.pointerCount).toBe(5);
    expect(applied.getProto().getU16(14)).toBe(4);
    expect(applied.getProto().getU16(24)).toBe(5);
    loadFlat(
      later,
      declNode({
        id: 0xad13n,
        name: "H3",
        scopeId: parent2,
        isGroup: true,
        dataWords: 1,
        pointers: 1,
      }),
    );
    expect(later.get(parent2).asStruct().dataWordCount).toBe(4);
    expect(later.get(parent2).asStruct().pointerCount).toBe(5);
  });

  test("a void list element upgrades to a zero size struct", () => {
    const loader = new SchemaLoader();
    const target = 0xb101n;
    loadFlat(
      loader,
      declNode({
        id: 0xb100n,
        name: "V1",
        pointers: 1,
        fields: [{ name: "items", type: TypeKind.List, element: TypeKind.Void }],
      }),
    );
    loadFlat(
      loader,
      declNode({
        id: 0xb100n,
        name: "V2",
        pointers: 1,
        fields: [
          {
            name: "items",
            type: TypeKind.List,
            element: TypeKind.Struct,
            elementId: target,
          },
        ],
      }),
    );
    expect(loader.get(0xb100n).displayName).toBe("V2");
    const element = loader
      .get(0xb100n)
      .asStruct()
      .getFields()[0]!
      .getType()
      .asList()
      .getElementType()
      .asStruct();
    expect(element.dataWordCount).toBe(0);
    expect(element.pointerCount).toBe(0);
    expect(element.getFields()).toHaveLength(1);
    expect(element.getFields()[0]!.name).toBe("member0");
    expect(element.getFields()[0]!.getType().which).toBe("void");
  });
});
