import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CapnpError,
  Message,
  NO_DISCRIMINANT,
  PtrKind,
  SchemaLoader,
  Type,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const goldenDir = join(here, "golden");
const hasCapnp = spawnSync("capnp", ["--version"]).status === 0;

function readGolden(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(goldenDir, name)));
}

describe("SchemaLoader and reflection model", () => {
  test("loads AddressBook CGR and resolves nested structs, unions, and enums", () => {
    const loader = SchemaLoader.fromCgr(readGolden("addressbook.cgr.bin"));
    expect(loader.requestedFiles().length).toBe(1);

    const book = loader.resolveStruct("AddressBook");
    expect(book.getShortDisplayName()).toBe("AddressBook");
    expect(book.dataWordCount).toBe(0);
    expect(book.pointerCount).toBe(1);
    expect(book.mayContainCapabilities()).toBe(false);

    const peopleField = book.getFieldByName("people");
    expect(peopleField.isSlot()).toBe(true);
    expect(peopleField.getType().isList()).toBe(true);

    const person = peopleField.getType().asList().getStructElementType();
    expect(person).toBe(loader.resolveStruct("Person"));
    expect(person.dataWordCount).toBe(1);
    expect(person.pointerCount).toBe(4);
    expect(person.getNonUnionFields().length).toBe(5);
    expect(person.getUnionFields().length).toBe(0);

    const employment = person.getFieldByName("employment");
    expect(employment.isGroup()).toBe(true);
    const empGroup = employment.getType().asStruct();
    expect(empGroup.isGroup).toBe(true);
    expect(empGroup.discriminantCount).toBe(4);
    expect(empGroup.getUnionFields().map((f) => f.name)).toEqual([
      "unemployed",
      "employer",
      "school",
      "selfEmployed",
    ]);
    expect(empGroup.getFieldByDiscriminant(2)?.name).toBe("school");
    expect(empGroup.getFieldByDiscriminant(99)).toBeNull();

    const phone = loader.resolveStruct("Person.PhoneNumber");
    const phoneType = loader.resolve("Person.PhoneNumber.Type").asEnum();
    expect(phone.getFieldByName("type").getType().asEnum()).toBe(phoneType);
    expect(phoneType.getEnumerants().map((e) => e.name)).toEqual([
      "mobile",
      "home",
      "work",
    ]);
    expect(phoneType.getEnumerantByName("work").getOrdinal()).toBe(2);
    expect(phoneType.findEnumerantByName("fax")).toBeNull();
  });

  test("loads individual schema Node pointers via loadNode", () => {
    const msg = Message.fromFlat(readGolden("addressbook.cgr.bin"));
    const nodes = msg.root().getP(0);
    expect(nodes.kind).toBe(PtrKind.List);

    const partial = new SchemaLoader();
    for (let i = 0; i < nodes.listLen(); i++) {
      partial.loadNode(nodes.listGetP(i));
    }
    const person = partial.resolveStruct("Person");
    expect(person.getFieldByName("email").getType().isText()).toBe(true);
  });

  test("resolves defaults, groups, generics, interfaces, constants, and annotations", () => {
    const loader = SchemaLoader.fromCgr(readGolden("dynamic-kitchen.cgr.bin"));
    const fileId = loader.requestedFiles()[0]!.id;
    const fileSchema = loader.get(fileId);

    const docTag = loader.get(loader.findRootSymbol("docTag", fileId)).asAnnotation();
    const weight = loader.get(loader.findRootSymbol("weight", fileId)).asAnnotation();
    expect(docTag.getType().isText()).toBe(true);
    expect(docTag.targets.struct).toBe(true);
    expect(docTag.targets.method).toBe(true);
    expect(docTag.targets.const).toBe(false);

    expect(fileSchema.getAnnotation(docTag).rawValue).toEqual({
      which: "text",
      value: "dynamic-kitchen-file",
      ptr: expect.anything(),
    });

    const tag = loader.resolveStruct("Tag");
    expect(tag.getAnnotation(docTag).getSchema()).toBe(docTag);
    expect(tag.getAnnotation(weight).rawValue).toEqual({
      which: "int32",
      value: 7,
    });
    expect(tag.getFieldByName("code").getAnnotation(weight).rawValue).toEqual({
      which: "int32",
      value: 3,
    });

    const prio = loader.resolve("Priority").asEnum();
    expect(prio.getAnnotation(docTag).rawValue).toMatchObject({
      which: "text",
      value: "priority-enum",
    });
    expect(
      prio.getEnumerantByName("normal").getAnnotation(docTag).rawValue,
    ).toMatchObject({
      which: "text",
      value: "default-priority",
    });

    const sink = loader.resolveStruct("KitchenSink");
    expect(sink.getFieldByName("i64").defaultValue).toEqual({
      which: "int64",
      value: -9007199254740993n,
    });
    expect(sink.getFieldByName("u64").defaultValue).toEqual({
      which: "uint64",
      value: 9007199254740995n,
    });
    expect(sink.getFieldByName("defaultTag").defaultValue.which).toBe("struct");
    expect(sink.getFieldByName("defaultNums").defaultValue.which).toBe("list");
    expect(sink.getFieldByName("nothing").discriminantValue).toBe(NO_DISCRIMINANT);
    expect(sink.getUnionFields().map((f) => f.name)).toEqual([
      "none",
      "note",
      "count",
      "detail",
    ]);

    // Generic brand substitution and nested inherit scope
    const genericEnvelope = loader.resolveStruct("Envelope");
    expect(genericEnvelope.isGeneric).toBe(true);
    expect(genericEnvelope.isBranded()).toBe(false);
    expect(genericEnvelope.getFieldByName("payload").getType().isAnyPointer()).toBe(
      true,
    );

    const strBox = sink.getFieldByName("stringBox").getType().asStruct();
    expect(strBox.isBranded()).toBe(true);
    expect(strBox.getGeneric()).toBe(genericEnvelope);
    expect(strBox).toBe(loader.resolveStruct("Envelope(Text)"));
    expect(strBox.getFieldByName("payload").getType()).toBe(Type.TEXT);
    const strEntry = strBox
      .getFieldByName("items")
      .getType()
      .asList()
      .getStructElementType();
    expect(strEntry.getFieldByName("value").getType()).toBe(Type.TEXT);

    const tagBox = sink.getFieldByName("tagBox").getType().asStruct();
    expect(tagBox).toBe(loader.resolveStruct("Envelope(Tag)"));
    expect(tagBox.getFieldByName("payload").getType().asStruct()).toBe(tag);
    const tagEntry = tagBox
      .getFieldByName("items")
      .getType()
      .asList()
      .getStructElementType();
    expect(tagEntry.getFieldByName("value").getType().asStruct()).toBe(tag);

    // Interface inheritance and method lookup
    const baseIface = loader.resolve("BaseService").asInterface();
    const subIface = loader.resolve("SubService").asInterface();
    expect(subIface.extends(baseIface)).toBe(true);
    expect(baseIface.extends(subIface)).toBe(false);
    expect(subIface.findSuperclass(baseIface.id)).toBe(baseIface);
    const ping = subIface.getMethodByName("ping");
    expect(ping.getContainingInterface()).toBe(baseIface);
    expect(ping.getAnnotation(docTag).rawValue).toMatchObject({
      which: "text",
      value: "ping-method",
    });
    expect(ping.getParamType().getFieldByName("msg").getType()).toBe(Type.TEXT);
    expect(ping.getResultType().getFieldByName("reply").getType()).toBe(Type.TEXT);

    // Constants
    const magic = loader.getConst(loader.findRootSymbol("magicAnswer", fileId));
    expect(magic.getType()).toBe(Type.INT64);
    expect(magic.rawValue).toEqual({
      which: "int64",
      value: 9223372036854775807n,
    });

    expect(() => sink.getFieldByName("nonexistent")).toThrow(CapnpError);
  });

  test.skipIf(!hasCapnp)(
    "live capnp compile CGR matches checked-in reflection metadata",
    () => {
      for (const [schemaRel, goldenName] of [
        ["schema/addressbook.capnp", "addressbook.cgr.bin"],
        ["schema/dynamic-kitchen.capnp", "dynamic-kitchen.cgr.bin"],
      ] as const) {
        const proc = spawnSync(
          "capnp",
          ["compile", "-o-", join(repoRoot, schemaRel)],
          { maxBuffer: 16 * 1024 * 1024 },
        );
        expect(proc.status).toBe(0);
        const live = SchemaLoader.fromCgr(new Uint8Array(proc.stdout));
        const offline = SchemaLoader.fromCgr(readGolden(goldenName));
        expect(live.allNodes().map((n) => n.id).sort()).toEqual(
          offline.allNodes().map((n) => n.id).sort(),
        );
        for (const node of offline.allNodes()) {
          const other = live.get(node.id);
          expect(other.which).toBe(node.which);
          if (node.which === "struct") {
            const s1 = node.asStruct();
            const s2 = other.asStruct();
            expect(s2.dataWordCount).toBe(s1.dataWordCount);
            expect(s2.pointerCount).toBe(s1.pointerCount);
            expect(s2.discriminantCount).toBe(s1.discriminantCount);
            expect(s2.discriminantOffset).toBe(s1.discriminantOffset);
          }
        }
      }
    },
  );
});
