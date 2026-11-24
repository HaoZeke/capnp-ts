import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CgrAst, formatType, walkCgr } from "../src/cgr-walk.ts";
import { emitModuleSource } from "../src/emit.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");

async function loadFixture(name: string) {
  return walkCgr(
    new Uint8Array(readFileSync(join(fixturesDir, `${name}.cgr.bin`))),
  );
}

describe("generic parameters and brands", () => {
  test("box fixture decodes node parameters and parameterized AnyPointer", async () => {
    const ast = await loadFixture("box");
    const box = ast.nodes.find((n) => n.displayName.endsWith(":Box"));
    expect(box).toBeDefined();
    expect(box?.parameters).toEqual(["T"]);
    const value = box?.struct?.fields.find((f) => f.name === "value")?.slot?.type;
    expect(value?.which).toBe("anyPointer");
    if (!value || value.which !== "anyPointer") {
      throw new Error("expected Box.value to decode as AnyPointer");
    }
    expect(value.constraint.which).toBe("parameter");
    if (value.constraint.which !== "parameter") {
      throw new Error("expected AnyPointer parameter constraint");
    }
    expect(value.constraint.scopeId).toBe(box?.id ?? 0n);
    expect(value.constraint.parameterIndex).toBe(0);
  });

  test("box fixture decodes brand bindings on generic struct uses", async () => {
    const ast = await loadFixture("box");
    const box = ast.nodes.find((n) => n.displayName.endsWith(":Box"));
    const nest = ast.nodes.find((n) => n.displayName.endsWith(":Nest"));
    const boxUse = ast.nodes.find((n) => n.displayName.endsWith(":BoxUse"));
    expect(box).toBeDefined();
    expect(nest).toBeDefined();
    expect(boxUse).toBeDefined();

    const textBoxType = boxUse?.struct?.fields.find((f) => f.name === "textBox")
      ?.slot?.type;
    expect(textBoxType?.which).toBe("struct");
    if (!textBoxType || textBoxType.which !== "struct") {
      throw new Error("expected BoxUse.textBox to be a struct type");
    }
    const textScope = textBoxType.brand?.scopes[0];
    expect(textScope?.scopeId).toBe(box?.id ?? 0n);
    expect(textScope?.which).toBe("bind");
    expect(textScope?.bind?.length).toBe(1);
    expect(textScope?.bind?.[0] && formatType(textScope.bind[0])).toBe("text");

    const listBoxType = boxUse?.struct?.fields.find((f) => f.name === "listBox")
      ?.slot?.type;
    expect(listBoxType?.which).toBe("struct");
    if (!listBoxType || listBoxType.which !== "struct") {
      throw new Error("expected BoxUse.listBox to be a struct type");
    }
    const listScope = listBoxType.brand?.scopes[0];
    expect(listScope?.bind?.[0] && formatType(listScope.bind[0])).toBe(
      "List(text)",
    );

    const innerType = nest?.struct?.fields.find((f) => f.name === "inner")?.slot
      ?.type;
    expect(innerType?.which).toBe("struct");
    if (!innerType || innerType.which !== "struct") {
      throw new Error("expected Nest.inner to be a struct type");
    }
    const innerScope = innerType.brand?.scopes[0];
    expect(innerScope?.scopeId).toBe(box?.id ?? 0n);
    const bound = innerScope?.bind?.[0];
    expect(bound?.which).toBe("anyPointer");
    if (!bound || bound.which !== "anyPointer") {
      throw new Error("expected Nest.inner brand bind to be AnyPointer");
    }
    expect(bound.constraint.which).toBe("parameter");
    if (bound.constraint.which !== "parameter") {
      throw new Error("expected parameter bind for Nest.inner");
    }
    expect(bound.constraint.scopeId).toBe(nest?.id ?? 0n);
    expect(bound.constraint.parameterIndex).toBe(0);
  });

  test("kitchen fixture decodes unconstrained AnyPointer kind", async () => {
    const ast = await loadFixture("kitchen");
    const sink = ast.nodes.find((n) => n.displayName.endsWith(":Sink"));
    const stuff = sink?.struct?.fields.find((f) => f.name === "stuff")?.slot?.type;
    expect(stuff?.which).toBe("anyPointer");
    if (!stuff || stuff.which !== "anyPointer") {
      throw new Error("expected Sink.stuff to be AnyPointer");
    }
    expect(stuff.constraint.which).toBe("unconstrained");
    if (stuff.constraint.which !== "unconstrained") {
      throw new Error("expected unconstrained AnyPointer in kitchen fixture");
    }
    expect(stuff.constraint.anyKind).toBe("anyPointer");
  });

  test("method brands use declared implicit parameter names through direct and nested Box", () => {
    const ast = {
      nodes: [
        {
          id: 1n,
          displayName: "test.capnp:Box",
          displayNamePrefixLength: 12,
          scopeId: 0n,
          which: "struct",
          whichTag: 1,
          nestedNodes: [],
          parameters: ["T"],
          struct: {
            dataWordCount: 0,
            pointerCount: 0,
            isGroup: false,
            discriminantCount: 0,
            discriminantOffset: 0,
            fields: [],
          },
        },
        {
          id: 2n,
          displayName: "test.capnp:Service",
          displayNamePrefixLength: 12,
          scopeId: 0n,
          which: "interface",
          whichTag: 3,
          nestedNodes: [],
          methods: [
            {
              name: "call",
              ordinal: 0,
              paramStructType: 1n,
              resultStructType: 3n,
              paramBrand: {
                scopes: [
                  {
                    scopeId: 1n,
                    which: "bind",
                    bind: [
                      {
                        which: "struct",
                        typeId: 1n,
                        brand: {
                          scopes: [
                            {
                              scopeId: 1n,
                              which: "bind",
                              bind: [
                                {
                                  which: "anyPointer",
                                  constraint: {
                                    which: "implicitMethodParameter",
                                    parameterIndex: 0,
                                  },
                                },
                              ],
                            },
                          ],
                        },
                      },
                    ],
                  },
                ],
              },
              implicitParameters: ["Value"],
            },
          ],
        },
        {
          id: 3n,
          displayName: "test.capnp:Service.call$results",
          displayNamePrefixLength: 12,
          scopeId: 2n,
          which: "struct",
          whichTag: 1,
          nestedNodes: [],
          struct: {
            dataWordCount: 0,
            pointerCount: 0,
            isGroup: false,
            discriminantCount: 0,
            discriminantOffset: 0,
            fields: [],
          },
        },
      ],
      requestedFiles: [],
    } as CgrAst;

    const source = emitModuleSource(ast, "test.capnp");
    expect(source).toContain("params: Box_Ptr<Box_Ptr<Value>>");
    expect(source).not.toContain("Box_Ptr<Box_Ptr<M0>>");

    const singleLevelAst = structuredClone(ast);
    const singleLevelBind = (
      singleLevelAst as unknown as {
        nodes: Array<{
          methods: Array<{
            paramBrand: { scopes: Array<{ bind: unknown[] }> };
          }>;
        }>;
      }
    ).nodes[1].methods[0].paramBrand.scopes[0].bind;
    singleLevelBind[0] = {
      which: "anyPointer",
      constraint: {
        which: "implicitMethodParameter",
        parameterIndex: 0,
      },
    };
    const singleLevelSource = emitModuleSource(singleLevelAst, "test.capnp");
    expect(singleLevelSource).toContain("params: Box_Ptr<Value>");
    expect(singleLevelSource).not.toContain("Box_Ptr<M0>");
  });
});
