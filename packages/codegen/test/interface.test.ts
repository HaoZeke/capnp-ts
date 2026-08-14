/**
 * Typed interface stubs.
 *
 * The dimensions in the method table are the thing worth pinning: a
 * parameter struct sized wrong silently drops arguments past the end,
 * which stays invisible until a real peer answers with the wrong number.
 */
import { describe, expect, test } from "bun:test";

import type { CgrAst, NodeAst } from "../src/cgr-walk.ts";
import { emitModuleSource } from "../src/emit.ts";

function structNode(id: bigint, name: string, dw: number, pw: number): NodeAst {
  return {
    id,
    displayName: name,
    displayNamePrefixLength: 0,
    scopeId: 0n,
    which: "struct",
    whichTag: 1,
    nestedNodes: [],
    struct: {
      dataWordCount: dw,
      pointerCount: pw,
      isGroup: false,
      discriminantCount: 0,
      discriminantOffset: 0,
      fields: [],
    },
  };
}

/** Adder.add(a :Int64, b :Int64) -> (sum :Int64). */
function adderAst(): CgrAst {
  const iface: NodeAst = {
    id: 0xea01e10cbc414411n,
    displayName: "adder.capnp:Adder",
    displayNamePrefixLength: 12,
    scopeId: 0xbf5e831ac9f0d2a1n,
    which: "interface",
    whichTag: 3,
    nestedNodes: [],
    methods: [
      {
        name: "add",
        ordinal: 0,
        paramStructType: 0x1111n,
        resultStructType: 0x2222n,
      },
    ],
  };
  const file: NodeAst = {
    id: 0xbf5e831ac9f0d2a1n,
    displayName: "adder.capnp",
    displayNamePrefixLength: 0,
    scopeId: 0n,
    which: "file",
    whichTag: 0,
    nestedNodes: [{ name: "Adder", id: iface.id }],
  };
  return {
    nodes: [
      file,
      iface,
      structNode(0x1111n, "adder.capnp:Adder.add$Params", 2, 0),
      structNode(0x2222n, "adder.capnp:Adder.add$Results", 1, 0),
    ],
    requestedFiles: [{ id: file.id, filename: "adder.capnp" }],
  };
}

describe("interface stubs", () => {
  const src = emitModuleSource(adderAst(), "adder.capnp");

  test("the interface id is emitted as a bigint literal", () => {
    expect(src).toContain(
      "export const ADDER_INTERFACE_ID = 0xea01e10cbc414411n;",
    );
  });

  test("the method table carries the ordinal and both struct shapes", () => {
    // Two Int64 arguments are two data words; one word would drop the
    // second argument on the wire without complaint.
    expect(src).toContain(
      "add: { ordinal: 0, paramsDwords: 2, paramsPwords: 0, resultsDwords: 1, resultsPwords: 0 }",
    );
  });

  test("a client and a server base are emitted", () => {
    expect(src).toContain("export class AdderClient");
    expect(src).toContain("export abstract class AdderServer");
    expect(src).toContain(
      "abstract add(params: Ptr, results: StructBuilder): void;",
    );
  });

  test("the client passes the schema's dimensions to sendCall", () => {
    expect(src).toContain("m.paramsDwords");
    expect(src).toContain("m.paramsPwords");
  });

  test("the wrong-interface message is a literal, not an interpolation", () => {
    // `${Adder}` would name a variable that does not exist, and the
    // generated module would not compile.
    expect(src).toContain("`Adder: wrong interface ${interfaceId}`");
    expect(src).not.toContain("${Adder}");
  });

  test("StructBuilder is imported only because an interface needs it", () => {
    expect(src).toContain(
      'import type { Ptr, StructBuilder } from "@haozeke/capnp";',
    );
    const ast = adderAst();
    const noIface: CgrAst = {
      ...ast,
      nodes: ast.nodes.filter((n) => n.which !== "interface"),
    };
    expect(emitModuleSource(noIface, "adder.capnp")).toContain(
      'import type { Ptr } from "@haozeke/capnp";',
    );
  });
});
