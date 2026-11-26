import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CapnpError, Message, SchemaLoader } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "golden", "schema-validate");

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
});
