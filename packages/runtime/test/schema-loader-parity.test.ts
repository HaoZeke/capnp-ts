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
}): Uint8Array {
  const node = flatNode(opts.id, opts.name);
  node.setU16(12, opts.which ?? SchemaNodeKind.Struct);
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
  field.setU16(8, 0);
  field.setU32(4, spec.offset ?? 0);
  field.setU16(10, 1);
  field.setU16(12, spec.ordinal ?? index);
  if (spec.disc !== undefined) field.setU16(2, spec.disc, NO_DISCRIMINANT);
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
});
