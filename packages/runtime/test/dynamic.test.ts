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
  Type,
  canonicalizeFlat,
  storeU32,
  deepCopyPtrToSlot,
  newDynamicListOrphan,
  newDynamicStructOrphan,
} from "../src/index.ts";
import { loadU32 } from "../src/endian.ts";

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

    // 4. Cross-width primitive list evolution in DynamicList.Reader
    const primEvoMsg = new MessageBuilder();
    const primRoot = primEvoMsg.initRoot(0, 3);
    primRoot.initPrimList(
      0,
      ElemSize.FourBytes,
      2,
      4,
      new Uint8Array([0x79, 0x56, 0x34, 0x12, 0x05, 0x00, 0x00, 0x00]),
    );
    primRoot.initPrimList(1, ElemSize.Byte, 2, 1, new Uint8Array([0xab, 0xcd]));
    primRoot.initPrimList(2, ElemSize.Bit, 2, 1, new Uint8Array([0b10]));
    const primParsed = Message.fromFlat(primEvoMsg.toFlat()).root();

    const u32AsU8 = new DynamicList.Reader(ListSchema.of(Type.UINT8), primParsed.getP(0));
    expect(u32AsU8.get(0).asUInt8()).toBe(0x79);
    expect(u32AsU8.get(1).asUInt8()).toBe(0x05);
    const u32AsU16 = new DynamicList.Reader(ListSchema.of(Type.UINT16), primParsed.getP(0));
    expect(u32AsU16.get(0).asUInt16()).toBe(0x5679);
    const u32AsBool = new DynamicList.Reader(ListSchema.of(Type.BOOL), primParsed.getP(0));
    expect(u32AsBool.get(0).asBool()).toBe(true);
    expect(u32AsBool.get(1).asBool()).toBe(false);
    const u32AsVoid = new DynamicList.Reader(ListSchema.of(Type.VOID), primParsed.getP(0));
    expect(u32AsVoid.get(0).asVoid()).toBeUndefined();

    const u8AsU32 = new DynamicList.Reader(ListSchema.of(Type.UINT32), primParsed.getP(1));
    expect(() => u8AsU32.get(0)).toThrow(CapnpError);
    const boolAsVoid = new DynamicList.Reader(ListSchema.of(Type.VOID), primParsed.getP(2));
    expect(() => boolAsVoid.get(0)).toThrow(CapnpError);

    // 5. DynamicStructBuilder in-place upgrades of smaller composite & non-composite struct lists + root
    const upgBuilder = new MessageBuilder();
    const upgRoot = DynamicStruct.upgradeRoot(
      upgBuilder,
      Message.fromFlat(oldBuilder.toFlat()),
      sinkSchema,
    );
    expect(upgRoot.asReader().get("flag").asBool()).toBe(true);
    upgRoot.set("i64", 123456n);
    expect(upgRoot.asReader().get("i64").asInt64()).toBe(123456n);

    // Smaller composite list (1 dword, 0 pwords) inside tags slot upgraded to Tag (1 dword, 1 pword)
    const oldListEl = upgRoot.sb.initCompositeList(tagsField.offset, 1, 1, 0);
    oldListEl.setU32(0, (77 ^ -42) >>> 0); // Tag.code default = -42
    const upgradedTagsB = upgRoot.get("tags").asList();
    upgradedTagsB.get(0).asStruct().set("key", "added-key");
    expect(upgRoot.asReader().get("tags").asList().get(0).asStruct().get("key").asText()).toBe("added-key");
    expect(upgRoot.asReader().get("tags").asList().get(0).asStruct().get("code").asInt32()).toBe(77);

    // Non-composite pointer list List(Text) upgraded in place to List(Tag)
    const textPtrSlots = upgRoot.sb.initPointerList(tagsField.offset, 1);
    deepCopyPtrToSlot(upgBuilder, textPtrSlots, tmpParsed.getP(0), 0);
    const upgradedFromPtrB = upgRoot.get("tags").asList();
    upgradedFromPtrB.get(0).asStruct().set("code", 321);
    expect(upgRoot.asReader().get("tags").asList().get(0).asStruct().get("key").asText()).toBe("upgraded-0");
    expect(upgRoot.asReader().get("tags").asList().get(0).asStruct().get("code").asInt32()).toBe(321);
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

    const compResult = await client.call("compute", (p) => {
      const inp = p.init("input").asStruct();
      inp.set("key", "job");
      inp.set("code", 9);
    });
    expect(compResult.get("output").asStruct().get("title").asText()).toBe("job#9");
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

describe("dynamic list builder storage", () => {
  test("Data init returns a view of the message bytes", () => {
    const { builder: list } = newDynamicListOrphan(
      new MessageBuilder(),
      ListSchema.of(Type.DATA),
      1,
    );
    const view = list.init(0, 4).asData();
    view[0] = 9;
    view[1] = 8;
    view[2] = 7;
    view[3] = 6;
    expect([...list.get(0).asData()]).toEqual([9, 8, 7, 6]);
  });

  test("a primitive write on a composite list uses each struct data section", () => {
    const b = new MessageBuilder();
    const root = b.initRoot(0, 1);
    const first = root.initCompositeList(0, 2, 2, 0);
    first.setU32(0, 0x11111111);
    first.setU32(4, 0xaaaaaaaa);
    const second = first.nextElement();
    second.setU32(0, 0x33333333);
    second.setU32(4, 0xbbbbbbbb);

    const list = DynamicList.Builder.fromResolvedOrphan(
      b,
      ListSchema.of(Type.UINT32),
      b.resolveSlot(root.slot(0)),
    );
    list.set(1, 0x22222222);

    const bytes = b.segBytes(list.seg);
    const base = list.word * 8;
    expect(loadU32(bytes, base)).toBe(0x11111111);
    expect(loadU32(bytes, base + 4)).toBe(0xaaaaaaaa);
    expect(loadU32(bytes, base + 16)).toBe(0x22222222);
    expect(loadU32(bytes, base + 20)).toBe(0xbbbbbbbb);
    expect(list.asReader().get(0).asUInt32()).toBe(0x11111111);
    expect(list.asReader().get(1).asUInt32()).toBe(0x22222222);
  });

  test("a primitive write uses the wire element stride", () => {
    const b = new MessageBuilder();
    const root = b.initRoot(0, 1);
    const payload = new Uint8Array(8);
    new DataView(payload.buffer).setUint32(0, 0xaaaabbbb, true);
    new DataView(payload.buffer).setUint32(4, 0xccccdddd, true);
    root.initPrimList(0, ElemSize.FourBytes, 2, 4, payload);

    const list = DynamicList.Builder.fromResolvedOrphan(
      b,
      ListSchema.of(Type.UINT16),
      b.resolveSlot(root.slot(0)),
    );
    list.set(1, 0x1234);

    const bytes = b.segBytes(list.seg);
    const base = list.word * 8;
    expect(loadU32(bytes, base)).toBe(0xaaaabbbb);
    expect(loadU32(bytes, base + 4)).toBe(0xcccc1234);
    expect(list.asReader().get(1).asUInt16()).toBe(0x1234);
  });

  test("set and init check composite element size, including primitive upgrades", () => {
    const loader = SchemaLoader.fromCgr(readGolden("dynamic-kitchen.cgr.bin"));
    const tag = loader.resolveStruct("Tag");
    // Tag is one data word plus one pointer. Upgrading a data primitive
    // yields one data word and no pointers; upgrading a pointer list yields
    // no data words and one pointer. Neither fits Tag.
    expect(tag.dataWordCount).toBe(1);
    expect(tag.pointerCount).toBe(1);

    function expectSchema(fn: () => void): void {
      try {
        fn();
        throw new Error("expected SCHEMA");
      } catch (e) {
        if (e instanceof Error && e.message === "expected SCHEMA") throw e;
        expect(e).toBeInstanceOf(CapnpError);
        expect((e as CapnpError).code).toBe("SCHEMA");
      }
    }

    const small = new MessageBuilder();
    const smallRoot = small.initRoot(0, 1);
    const dataOnly = smallRoot.initCompositeList(0, 2, 1, 0);
    dataOnly.setU32(0, 0x11111111);
    dataOnly.nextElement().setU32(0, 0x22222222);
    const tags = DynamicList.Builder.fromResolvedOrphan(
      small,
      ListSchema.of(tag.asType()),
      small.resolveSlot(smallRoot.slot(0)),
    );
    const srcMsg = new MessageBuilder();
    const src = DynamicStruct.initRoot(srcMsg, tag);
    src.set("key", "spill");
    src.set("code", 7);
    expectSchema(() => tags.set(0, src));
    const smallBytes = small.segBytes(tags.seg);
    const smallBase = tags.word * 8;
    expect(loadU32(smallBytes, smallBase)).toBe(0x11111111);
    expect(loadU32(smallBytes, smallBase + 8)).toBe(0x22222222);

    const blobs = DynamicList.Builder.fromResolvedOrphan(
      small,
      ListSchema.of(Type.DATA),
      small.resolveSlot(smallRoot.slot(0)),
    );
    expectSchema(() => blobs.init(0, 4));
    expectSchema(() => blobs.set(0, new Uint8Array([1, 2, 3, 4])));
    expect(loadU32(smallBytes, smallBase)).toBe(0x11111111);
    expect(loadU32(smallBytes, smallBase + 8)).toBe(0x22222222);

    const pointers = new MessageBuilder();
    const pointerRoot = pointers.initRoot(0, 1);
    pointerRoot.initCompositeList(0, 2, 0, 1);
    const nums = DynamicList.Builder.fromResolvedOrphan(
      pointers,
      ListSchema.of(Type.UINT32),
      pointers.resolveSlot(pointerRoot.slot(0)),
    );
    expectSchema(() => nums.set(0, 0x12345678));
    const pointerTags = DynamicList.Builder.fromResolvedOrphan(
      pointers,
      ListSchema.of(tag.asType()),
      pointers.resolveSlot(pointerRoot.slot(0)),
    );
    expectSchema(() => pointerTags.set(0, src));

    // A data primitive upgraded far enough to keep a pointer: init and set
    // write the pointer section and leave the data word alone.
    const wide = new MessageBuilder();
    const wideRoot = wide.initRoot(0, 1);
    const wideEl = wideRoot.initCompositeList(0, 2, 1, 1);
    wideEl.setU32(0, 0xabcdef01);
    wideEl.nextElement().setU32(0, 0x22222222);
    const dataList = DynamicList.Builder.fromResolvedOrphan(
      wide,
      ListSchema.of(Type.DATA),
      wide.resolveSlot(wideRoot.slot(0)),
    );
    const view = dataList.init(0, 4).asData();
    view[0] = 9;
    view[1] = 8;
    view[2] = 7;
    view[3] = 6;
    dataList.set(1, new Uint8Array([1, 2, 3, 4]));
    const wideBytes = wide.segBytes(dataList.seg);
    const wideBase = dataList.word * 8;
    expect(loadU32(wideBytes, wideBase)).toBe(0xabcdef01);
    expect(loadU32(wideBytes, wideBase + 16)).toBe(0x22222222);
    expect([...dataList.get(0).asData()]).toEqual([9, 8, 7, 6]);
    expect([...dataList.get(1).asData()]).toEqual([1, 2, 3, 4]);
  });

  test("bool set rejects pointer and void lists without writing", () => {
    const b = new MessageBuilder();
    const root = b.initRoot(0, 2);
    const pointers = root.initPointerList(0, 1);
    b.storeW(pointers.seg, pointers.word, 0xdeadbeef12345678n);
    const boolOnPtr = DynamicList.Builder.fromResolvedOrphan(
      b,
      ListSchema.of(Type.BOOL),
      b.resolveSlot(root.slot(0)),
    );
    const ptrBefore = b.loadW(pointers.seg, pointers.word);
    expect(() => boolOnPtr.set(0, true)).toThrow(CapnpError);
    try {
      boolOnPtr.set(0, true);
    } catch (e) {
      expect(e).toBeInstanceOf(CapnpError);
      expect((e as CapnpError).code).toBe("SCHEMA");
    }
    expect(b.loadW(pointers.seg, pointers.word)).toBe(ptrBefore);

    root.initPrimList(1, ElemSize.Void, 4, 0);
    const boolOnVoid = DynamicList.Builder.fromResolvedOrphan(
      b,
      ListSchema.of(Type.BOOL),
      b.resolveSlot(root.slot(1)),
    );
    const segBefore = b.segBytes(0).slice();
    expect(() => boolOnVoid.set(0, true)).toThrow(CapnpError);
    try {
      boolOnVoid.set(0, true);
    } catch (e) {
      expect((e as CapnpError).code).toBe("SCHEMA");
    }
    expect([...b.segBytes(0)]).toEqual([...segBefore]);

    const bits = new MessageBuilder();
    const bitRoot = bits.initRoot(0, 1);
    const bitList = DynamicList.Builder.allocateAtSlot(
      bits,
      bitRoot.slot(0),
      ListSchema.of(Type.BOOL),
      3,
    );
    bitList.set(0, true);
    expect(bitList.get(0).asBool()).toBe(true);
    expect(bitList.get(1).asBool()).toBe(false);
  });

  test("List(List(Struct)) get upgrades an older inner struct list", () => {
    const loader = SchemaLoader.fromCgr(readGolden("dynamic-kitchen.cgr.bin"));
    const tag = loader.resolveStruct("Tag");
    const innerSchema = ListSchema.of(tag.asType());
    const outerSchema = ListSchema.of(innerSchema.asType());
    const wireCode = (77 ^ -42) >>> 0;

    const small = new MessageBuilder();
    const smallRoot = small.initRoot(0, 1);
    const smallRows = smallRoot.initPointerList(0, 1);
    const smallInner = DynamicList.Builder.allocateCompositeAtSlot(
      small,
      smallRows,
      innerSchema,
      1,
      1,
      0,
    );
    storeU32(small.segBytes(smallInner.seg), smallInner.word * 8, wireCode);
    const smallOuter = DynamicList.Builder.fromResolvedOrphan(
      small,
      outerSchema,
      small.resolveSlot(smallRoot.slot(0)),
    );
    const smallRow = smallOuter.get(0).asList();
    smallRow.get(0).asStruct().set("key", "added-key");
    expect(smallRow.get(0).asStruct().get("key").asText()).toBe("added-key");
    expect(smallRow.get(0).asStruct().get("code").asInt32()).toBe(77);

    const prim = new MessageBuilder();
    const primRoot = prim.initRoot(0, 1);
    const primRows = primRoot.initPointerList(0, 1);
    const u32 = DynamicList.Builder.allocateAtSlot(
      prim,
      primRows,
      ListSchema.of(Type.UINT32),
      1,
    );
    u32.set(0, wireCode);
    const primOuter = DynamicList.Builder.fromResolvedOrphan(
      prim,
      outerSchema,
      prim.resolveSlot(primRoot.slot(0)),
    );
    const primRow = primOuter.get(0).asList();
    primRow.get(0).asStruct().set("key", "from-prim");
    expect(primRow.get(0).asStruct().get("key").asText()).toBe("from-prim");
    expect(primRow.get(0).asStruct().get("code").asInt32()).toBe(77);
  });
});
