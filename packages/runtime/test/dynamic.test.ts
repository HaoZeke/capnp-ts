import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CapnpError,
  DynamicCapability,
  DynamicCapabilityServer,
  DynamicEnum,
  DynamicList,
  DynamicStruct,
  DynamicValue,
  ElemSize,
  HasMode,
  type InterfaceMethod,
  ListSchema,
  Message,
  MessageBuilder,
  SchemaLoader,
  canonicalizeFlat,
  deepCopyPtrToSlot,
  newDynamicStructOrphan,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const goldenDir = join(here, "golden");
const hasCapnp = spawnSync("capnp", ["--version"]).status === 0;

function readGolden(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(goldenDir, name)));
}

describe("DynamicStruct / DynamicList / DynamicEnum / DynamicCapability", () => {
  test("decodes AddressBook golden and builds canonical byte-identical message", () => {
    const loader = SchemaLoader.fromCgr(readGolden("addressbook.cgr.bin"));
    const bookSchema = loader.resolveStruct("AddressBook");
    const msg = Message.fromFlat(readGolden("addressbook.bin"));
    const book = DynamicStruct.fromMessage(msg, bookSchema);

    const people = book.get("people").asList();
    expect(people.size()).toBe(2);

    const alice = people.get(0).asStruct();
    expect(alice.get("id").asUInt32()).toBe(123);
    expect(alice.get("name").asText()).toBe("Alice");
    expect(alice.get("email").asText()).toBe("alice@example.com");
    const alicePhones = alice.get("phones").asList();
    expect(alicePhones.size()).toBe(1);
    expect(alicePhones.get(0).asStruct().get("number").asText()).toBe("555-1212");
    expect(alicePhones.get(0).asStruct().get("type").asEnum().getName()).toBe(
      "mobile",
    );
    const aliceEmp = alice.get("employment").asStruct();
    expect(aliceEmp.which()?.name).toBe("school");
    expect(aliceEmp.get("school").asText()).toBe("MIT");
    expect(() => aliceEmp.get("employer")).toThrow(CapnpError);

    const bob = people.get(1).asStruct();
    expect(bob.get("id").asUInt32()).toBe(456);
    const bobEmp = bob.get("employment").asStruct();
    expect(bobEmp.which()?.name).toBe("unemployed");
    expect(bobEmp.has("unemployed", HasMode.NON_NULL)).toBe(true);
    expect(bobEmp.has("unemployed", HasMode.NON_DEFAULT)).toBe(false);

    // Build the exact same AddressBook dynamically and verify canonical parity
    const b = new MessageBuilder();
    const outBook = DynamicStruct.initRoot(b, bookSchema);
    const outPeople = outBook.init("people", 2).asList();

    const outAlice = outPeople.get(0).asStruct();
    outAlice.set("id", 123);
    outAlice.set("name", "Alice");
    outAlice.set("email", "alice@example.com");
    const outAlicePhones = outAlice.init("phones", 1).asList();
    outAlicePhones.get(0).asStruct().set("number", "555-1212");
    outAlicePhones.get(0).asStruct().set("type", "mobile");
    outAlice.get("employment").asStruct().set("school", "MIT");

    const outBob = outPeople.get(1).asStruct();
    outBob.set("id", 456);
    outBob.set("name", "Bob");
    outBob.set("email", "bob@example.com");
    const outBobPhones = outBob.init("phones", 2).asList();
    outBobPhones.get(0).asStruct().set("number", "555-4567");
    outBobPhones.get(0).asStruct().set("type", "home");
    outBobPhones.get(1).asStruct().set("number", "555-7654");
    outBobPhones.get(1).asStruct().set("type", "work");
    outBob.get("employment").asStruct().set("unemployed", null);

    expect(canonicalizeFlat(b.toFlat())).toEqual(
      readGolden("addressbook.canonical.bin"),
    );
  });

  test("reads KitchenSink extremes, nested lists, groups, unions, generics, and consts", () => {
    const loader = SchemaLoader.fromCgr(readGolden("dynamic-kitchen.cgr.bin"));
    const fileId = loader.requestedFiles()[0]!.id;
    const sinkSchema = loader.resolveStruct("KitchenSink");

    const fromGolden = DynamicStruct.fromMessage(
      Message.fromFlat(readGolden("dynamic-kitchen-extreme.bin")),
      sinkSchema,
    );
    const fromConst = DynamicValue.fromConst(
      loader.getConst(loader.findRootSymbol("extremeConst", fileId)),
    ).asStruct();

    for (const sink of [fromGolden, fromConst]) {
      expect(sink.get("flag").asBool()).toBe(true);
      expect(sink.get("flagDefaultTrue").asBool()).toBe(false);
      expect(sink.get("i8").asInt8()).toBe(-128);
      expect(sink.get("i16").asInt16()).toBe(32767);
      expect(sink.get("i32").asInt32()).toBe(-2147483648);
      expect(sink.get("i64").asInt64()).toBe(-9223372036854775808n);
      expect(sink.get("u8").asUInt8()).toBe(255);
      expect(sink.get("u16").asUInt16()).toBe(65535);
      expect(sink.get("u32").asUInt32()).toBe(4294967295);
      expect(sink.get("u64").asUInt64()).toBe(18446744073709551615n);
      expect(Number.isNaN(sink.get("f32").asFloat32())).toBe(true);
      expect(sink.get("f64").asFloat64()).toBe(-Infinity);
      expect(sink.get("title").asText()).toBe('Hello\n"Cap\'n"\tProto');
      expect(sink.get("raw").asData()).toEqual(
        new Uint8Array([
          0x00, 0x01, 0x02, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1f,
          0x20, 0x7f, 0x80, 0xfe, 0xff,
        ]),
      );
      expect(sink.get("priority").asEnum().getName()).toBe("critical");

      const matrix = sink.get("matrix").asList();
      expect(matrix.size()).toBe(3);
      expect(matrix.get(0).asList().toArray().map((x) => x.asInt32())).toEqual([
        1, -2, 3,
      ]);
      expect(matrix.get(1).asList().size()).toBe(0);
      expect(matrix.get(2).asList().toArray().map((x) => x.asInt32())).toEqual([
        2147483647, -2147483648,
      ]);

      const flags = sink.get("flags").asList();
      expect(flags.toArray().map((x) => x.asBool())).toEqual([
        true,
        false,
        true,
        true,
        false,
        false,
        true,
        false,
        true,
      ]);
      expect(sink.get("voids").asList().size()).toBe(3);

      const meta = sink.get("meta").asStruct();
      expect(meta.get("author").asText()).toBe("Grace");
      expect(meta.get("revision").asUInt32()).toBe(7);
      expect(meta.get("nested").asStruct().get("ok").asBool()).toBe(false);
      expect(meta.get("nested").asStruct().get("score").asFloat64()).toBe(
        Infinity,
      );

      expect(sink.which()?.name).toBe("detail");
      const detail = sink.get("detail").asStruct();
      expect(detail.get("detailId").asUInt32()).toBe(404);
      expect(detail.get("detailName").asText()).toBe("missing");

      const source = sink.get("source").asStruct();
      expect(source.which()?.name).toBe("inlineData");
      expect(source.get("inlineData").asData()).toEqual(
        new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      );

      const strBox = sink.get("stringBox").asStruct();
      expect(strBox.get("label").asText()).toBe("str-env");
      expect(strBox.get("payload").asText()).toBe("inside");
      expect(
        strBox
          .get("items")
          .asList()
          .toArray()
          .map((e) => e.asStruct().get("value").asText()),
      ).toEqual(["one", "two"]);

      const tagBox = sink.get("tagBox").asStruct();
      expect(tagBox.get("payload").asStruct().get("key").asText()).toBe("inner");
      expect(tagBox.get("payload").asStruct().get("code").asInt32()).toBe(11);
    }

    const greetings = DynamicValue.fromConst(
      loader.getConst(loader.findRootSymbol("greetingList", fileId)),
    ).asList();
    expect(greetings.toArray().map((x) => x.asText())).toEqual([
      "ni hao",
      "shalom",
      "hello",
    ]);
  });

  test("honors scalar and pointer schema defaults, clear, HasMode, and annotations", () => {
    const loader = SchemaLoader.fromCgr(readGolden("dynamic-kitchen.cgr.bin"));
    const sinkSchema = loader.resolveStruct("KitchenSink");
    const tagSchema = loader.resolveStruct("Tag");
    const fileId = loader.requestedFiles()[0]!.id;
    const docTag = loader.getAnnotation(loader.findRootSymbol("docTag", fileId));
    const weight = loader.getAnnotation(loader.findRootSymbol("weight", fileId));

    expect(DynamicValue.fromAnnotation(tagSchema.getAnnotation(docTag)).asText()).toBe(
      "tag-struct",
    );
    expect(DynamicValue.fromAnnotation(tagSchema.getAnnotation(weight)).asInt32()).toBe(
      7,
    );

    const b = new MessageBuilder();
    const sink = DynamicStruct.initRoot(b, sinkSchema);
    const reader = sink.asReader();

    expect(reader.get("flagDefaultTrue").asBool()).toBe(true);
    expect(reader.has("flagDefaultTrue", HasMode.NON_NULL)).toBe(true);
    expect(reader.has("flagDefaultTrue", HasMode.NON_DEFAULT)).toBe(false);
    expect(reader.get("i32").asInt32()).toBe(-100000);
    expect(reader.get("i64").asInt64()).toBe(-9007199254740993n);
    expect(reader.get("u64").asUInt64()).toBe(9007199254740995n);
    expect(reader.get("f32").asFloat32()).toBe(1.5);
    expect(reader.get("f64").asFloat64()).toBe(-2.25);
    expect(reader.get("priority").asEnum().getName()).toBe("normal");
    expect(reader.get("title").asText()).toBe("untitled");
    expect(reader.get("raw").asData()).toEqual(new Uint8Array([0xca, 0xfe]));
    expect(reader.has("defaultTag")).toBe(false);
    expect(reader.get("defaultTag").asStruct().get("key").asText()).toBe("preset");
    expect(reader.get("defaultTag").asStruct().get("code").asInt32()).toBe(99);
    expect(
      reader
        .get("defaultNums")
        .asList()
        .toArray()
        .map((x) => x.asInt32()),
    ).toEqual([10, -20, 30]);

    // Builder.get on unset struct field copies schema default into arena
    const mutableDefaultTag = sink.get("defaultTag").asStruct();
    expect(sink.has("defaultTag")).toBe(true);
    expect(mutableDefaultTag.get("key").asText()).toBe("preset");
    mutableDefaultTag.set("code", 500);
    expect(sink.asReader().get("defaultTag").asStruct().get("code").asInt32()).toBe(
      500,
    );

    sink.set("i32", 42);
    expect(sink.has("i32", HasMode.NON_DEFAULT)).toBe(true);
    sink.clear("i32");
    expect(sink.has("i32", HasMode.NON_DEFAULT)).toBe(false);
    expect(sink.get("i32").asInt32()).toBe(-100000);

    sink.clear("defaultTag");
    expect(sink.has("defaultTag")).toBe(false);
  });

  test("handles schema evolution: truncated structs, unknown union/enum, and list up/downgrade", () => {
    const loader = SchemaLoader.fromCgr(readGolden("dynamic-kitchen.cgr.bin"));
    const sinkSchema = loader.resolveStruct("KitchenSink");
    const tagSchema = loader.resolveStruct("Tag");
    const prioSchema = loader.resolve("Priority").asEnum();

    // 1. Older writer wrote a 1-data, 0-pointer struct; KitchenSink reads defaults past end
    const oldBuilder = new MessageBuilder();
    const oldRoot = oldBuilder.initRoot(1, 0);
    oldRoot.setBool(8, true); // flag @1 is bit 8 (Wait: nothing @0 Void, flag @1 bit 0)
    oldRoot.setBool(0, true);
    const evolved = DynamicStruct.fromMessage(
      Message.fromFlat(oldBuilder.toFlat()),
      sinkSchema,
    );
    expect(evolved.get("flag").asBool()).toBe(true);
    expect(evolved.get("i64").asInt64()).toBe(-9007199254740993n);
    expect(evolved.get("defaultTag").asStruct().get("key").asText()).toBe("preset");

    // 2. Newer writer set an unknown union discriminant and unknown enum ordinal
    const futureBuilder = new MessageBuilder();
    const futureSink = DynamicStruct.initRoot(futureBuilder, sinkSchema);
    futureSink.sb.setU16(sinkSchema.discriminantOffset * 2, 99);
    futureSink.set("priority", new DynamicEnum(prioSchema, 77));
    const futureReader = DynamicStruct.fromMessage(
      Message.fromFlat(futureBuilder.toFlat()),
      sinkSchema,
    );
    expect(futureReader.which()).toBeNull();
    expect(futureReader.has("none")).toBe(false);
    expect(futureReader.has("note")).toBe(false);
    expect(futureReader.get("priority").asEnum().getEnumerant()).toBeNull();
    expect(futureReader.get("priority").asEnum().getRaw()).toBe(77);

    // 3. List upgrades and downgrades through DynamicList
    const listTagSchema = ListSchema.of(tagSchema.asType());
    const listTextSchema = sinkSchema.getFieldByName("wordGrid").getType().asList().getListElementType();

    // Pointer list List(Text) upgraded to List(Tag) (key @0 is ptr 0, code @1 gets default -42)
    const lbMsg = new MessageBuilder();
    const rootSb = lbMsg.initRoot(0, 3);
    const ptrSlots = rootSb.initPointerList(0, 2);
    // Write two texts into pointer list slots
    const tmpTextMsg = new MessageBuilder();
    const tmpSb = tmpTextMsg.initRoot(0, 2);
    tmpSb.setText(0, "upgraded-0");
    tmpSb.setText(1, "upgraded-1");
    const tmpParsed = Message.fromFlat(tmpTextMsg.toFlat()).root();
    deepCopyPtrToSlot(lbMsg, ptrSlots.add(0), tmpParsed.getP(0), 0);
    deepCopyPtrToSlot(lbMsg, ptrSlots.add(1), tmpParsed.getP(1), 0);

    // Void list at ptr 1, Bool list at ptr 2
    lbMsg.writeListPtr(rootSb.seg, rootSb.word + 1, rootSb.seg, rootSb.word + 2, ElemSize.Void, 3);
    rootSb.initPrimList(2, ElemSize.Bit, 4, 1, new Uint8Array([0b1010]));

    const upParsed = Message.fromFlat(lbMsg.toFlat()).root();
    const upgradedTags = new DynamicList.Reader(listTagSchema, upParsed.getP(0));
    expect(upgradedTags.size()).toBe(2);
    expect(upgradedTags.get(0).asStruct().get("key").asText()).toBe("upgraded-0");
    expect(upgradedTags.get(0).asStruct().get("code").asInt32()).toBe(-42);
    expect(upgradedTags.get(1).asStruct().get("key").asText()).toBe("upgraded-1");

    const upgradedVoids = new DynamicList.Reader(listTagSchema, upParsed.getP(1));
    expect(upgradedVoids.size()).toBe(3);
    expect(upgradedVoids.get(0).asStruct().get("key").asText()).toBe("default-key");
    expect(upgradedVoids.get(0).asStruct().get("code").asInt32()).toBe(-42);

    const boolAsStructList = new DynamicList.Reader(listTagSchema, upParsed.getP(2));
    expect(() => boolAsStructList.get(0)).toThrow(CapnpError);

    // Composite List(Tag) downgraded to List(Text) reads field @0 (key)
    const compMsg = new MessageBuilder();
    const compSink = DynamicStruct.initRoot(compMsg, sinkSchema);
    const tagsBuilder = compSink.init("tags", 2).asList();
    tagsBuilder.get(0).asStruct().set("key", "k0");
    tagsBuilder.get(1).asStruct().set("key", "k1");
    const compRoot = Message.fromFlat(compMsg.toFlat()).root();
    const tagsField = sinkSchema.getFieldByName("tags");
    const downgradedTexts = new DynamicList.Reader(
      listTextSchema,
      compRoot.getP(tagsField.offset),
    );
    expect(downgradedTexts.toArray().map((x) => x.asText())).toEqual(["k0", "k1"]);
  });

  test("supports disown/adopt orphans and DynamicCapability client/server", async () => {
    const loader = SchemaLoader.fromCgr(readGolden("dynamic-kitchen.cgr.bin"));
    const sinkSchema = loader.resolveStruct("KitchenSink");
    const tagSchema = loader.resolveStruct("Tag");
    const baseIface = loader.resolve("BaseService").asInterface();
    const subIface = loader.resolve("SubService").asInterface();

    const b = new MessageBuilder();
    const sink = DynamicStruct.initRoot(b, sinkSchema);
    const { orphan, builder: detachedTag } = newDynamicStructOrphan(b, tagSchema);
    detachedTag.set("key", "orphan-key");
    detachedTag.set("code", 777);
    sink.adopt("defaultTag", orphan);
    expect(() => sink.adopt("defaultTag", orphan)).toThrow(CapnpError);
    expect(sink.asReader().get("defaultTag").asStruct().get("key").asText()).toBe(
      "orphan-key",
    );

    const moved = sink.disown("defaultTag");
    expect(sink.has("defaultTag")).toBe(false);
    expect(moved.getReader().asStruct().get("code").asInt32()).toBe(777);
    sink.adopt("defaultTag", moved);
    expect(sink.has("defaultTag")).toBe(true);

    class ImplServer extends DynamicCapabilityServer {
      override call(
        method: InterfaceMethod,
        params: DynamicStruct.Reader,
        results: DynamicStruct.Builder,
      ): void {
        if (method.name === "ping") {
          results.set("reply", `pong:${params.get("msg").asText()}`);
        } else if (method.name === "compute") {
          const inp = params.get("input").asStruct();
          const out = results.init("output").asStruct();
          out.set("title", `${inp.get("key").asText()}#${inp.get("code").asInt32()}`);
        }
      }
    }

    const client = new DynamicCapability.Client(subIface, new ImplServer(subIface));
    const upcasted = client.upcast(baseIface);
    const pingRes = await upcasted.call("ping", (p) => p.set("msg", "hi"));
    expect(pingRes.get("reply").asText()).toBe("pong:hi");

    const compRes = await client.call("compute", (p) => {
      const inp = p.init("input").asStruct();
      inp.set("key", "job");
      inp.set("code", 9);
    });
    expect(compRes.get("output").asStruct().get("title").asText()).toBe("job#9");
  });

  test.skipIf(!hasCapnp)(
    "differential canonical parity with capnp encode on KitchenSink",
    () => {
      const loader = SchemaLoader.fromCgr(readGolden("dynamic-kitchen.cgr.bin"));
      const sinkSchema = loader.resolveStruct("KitchenSink");

      const b = new MessageBuilder();
      const s = DynamicStruct.initRoot(b, sinkSchema);
      s.set("flag", true);
      s.set("i64", -9223372036854775808n);
      s.set("u64", 18446744073709551615n);
      s.set("f32", NaN);
      s.set("f64", -Infinity);
      s.set("title", "diff");
      s.set("raw", new Uint8Array([0, 255, 16]));
      s.set("priority", "high");
      s.set("matrix", [[4, -5], [6]]);
      s.get("meta").asStruct().set("author", "Ada");
      const d = s.init("detail").asStruct();
      d.set("detailId", 12);
      d.set("detailName", "ok");
      s.get("source").asStruct().set("uri", "https://capnproto.org");

      const tsCanonical = canonicalizeFlat(b.toFlat());

      const textInput = `(
        flag = true,
        i64 = -9223372036854775808,
        u64 = 18446744073709551615,
        f32 = nan,
        f64 = -inf,
        title = "diff",
        raw = 0x"00ff10",
        priority = high,
        matrix = [[4, -5], [6]],
        meta = (author = "Ada"),
        detail = (detailId = 12, detailName = "ok"),
        source = (uri = "https://capnproto.org")
      )`;
      const enc = spawnSync(
        "capnp",
        ["encode", join(repoRoot, "schema/dynamic-kitchen.capnp"), "KitchenSink"],
        { input: Buffer.from(textInput, "utf-8") },
      );
      expect(enc.status).toBe(0);
      const canon = spawnSync(
        "capnp",
        ["convert", "binary:canonical"],
        { input: enc.stdout },
      );
      expect(canon.status).toBe(0);

      expect(tsCanonical).toEqual(new Uint8Array(canon.stdout));
    },
  );
});
