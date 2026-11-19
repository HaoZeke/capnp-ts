import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CapnpError,
  DynamicEnum,
  DynamicStruct,
  HasMode,
  JsonCodec,
  Message,
  MessageBuilder,
  SchemaLoader,
  canonicalize,
  canonicalizeFlat,
  decodeJson,
  decodeText,
  encodeJson,
  splitJsonMessages,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const goldenDir = join(here, "golden");
const hasCapnp = spawnSync("capnp", ["--version"]).status === 0;

function readGolden(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(goldenDir, name)));
}

describe("Cap'n Proto compat JSON codec", () => {
  test("matches exact AddressBook pretty and short JSON and round-trips to canonical bytes", () => {
    const loader = SchemaLoader.fromCgr(readGolden("addressbook.cgr.bin"));
    const bookSchema = loader.resolveStruct("AddressBook");
    const book = DynamicStruct.fromMessage(
      Message.fromFlat(readGolden("addressbook.bin")),
      bookSchema,
    );

    const expectedPretty = [
      '{"people": [',
      '  { "id": 123,',
      '    "name": "Alice",',
      '    "email": "alice@example.com",',
      '    "phones": [{"number": "555-1212", "type": "mobile"}],',
      '    "employment": {"school": "MIT"} },',
      '  { "id": 456,',
      '    "name": "Bob",',
      '    "email": "bob@example.com",',
      '    "phones": [{"number": "555-4567", "type": "home"}, {"number": "555-7654", "type": "work"}],',
      '    "employment": {"unemployed": null} } ]}',
    ].join("\n");

    const expectedShort =
      '{"people":[{"id":123,"name":"Alice","email":"alice@example.com","phones":[{"number":"555-1212","type":"mobile"}],"employment":{"school":"MIT"}},{"id":456,"name":"Bob","email":"bob@example.com","phones":[{"number":"555-4567","type":"home"},{"number":"555-7654","type":"work"}],"employment":{"unemployed":null}}]}';

    expect(encodeJson(book, { pretty: true })).toBe(expectedPretty);
    expect(encodeJson(book, { pretty: false })).toBe(expectedShort);

    const canonGolden = readGolden("addressbook.canonical.bin");
    expect(canonicalize(decodeJson(expectedPretty, bookSchema))).toEqual(
      canonGolden,
    );
    expect(canonicalize(decodeJson(expectedShort, bookSchema))).toEqual(
      canonGolden,
    );
  });

  test("enforces JsonCodec defaults: Int64 strings, Data byte arrays, NaN/Inf, HasMode, unknown fields, and depth", () => {
    const loader = SchemaLoader.fromCgr(readGolden("dynamic-kitchen.cgr.bin"));
    const sinkSchema = loader.resolveStruct("KitchenSink");
    const prioSchema = loader.resolve("Priority").asEnum();

    // Unannotated default JsonCodec (capnp/compat/json.h without handleByAnnotation)
    const rawCodec = new JsonCodec();
    const b = new MessageBuilder();
    const sink = DynamicStruct.initRoot(b, sinkSchema);
    sink.set("i64", -9223372036854775808n);
    sink.set("u64", 18446744073709551615n);
    sink.set("f32", NaN);
    sink.set("f64", -Infinity);
    sink.set("raw", new Uint8Array([0, 127, 255]));
    sink.set("priority", "critical");

    const rawEncoded = rawCodec.encode(sink);
    expect(rawEncoded).toContain('"-9223372036854775808"');
    expect(rawEncoded).toContain('"18446744073709551615"');
    expect(rawEncoded).toContain('"f32":"NaN"');
    expect(rawEncoded).toContain('"f64":"-Infinity"');
    expect(rawEncoded).toContain('"raw":[0,127,255]');
    // Without handleByAnnotation, critical uses its Cap'n Proto name "critical"
    expect(rawEncoded).toContain('"priority":"critical"');

    // HasMode.NON_DEFAULT omits default-valued scalars
    const nonDefaultCodec = new JsonCodec({ hasMode: HasMode.NON_DEFAULT });
    const minimalBuilder = new MessageBuilder();
    const minimalSink = DynamicStruct.initRoot(minimalBuilder, sinkSchema);
    minimalSink.set("flag", true);
    expect(nonDefaultCodec.encode(minimalSink)).toBe(
      '{"flag":true,"meta":{"nested":{}},"source":{}}',
    );

    // Decode numeric and string integers, null->NaN floats, unicode surrogates, and unknown fields
    const decoded = rawCodec.decode(
      '{"i32":"-55","i64":-12,"u64":42,"f32":null,"f64":"Infinity","title":"\\uD83D\\uDE80","extraIgnored":{"x":1}}',
      sinkSchema,
    );
    expect(decoded.get("i32").asInt32()).toBe(-55);
    expect(decoded.get("i64").asInt64()).toBe(-12n);
    expect(decoded.get("u64").asUInt64()).toBe(42n);
    expect(Number.isNaN(decoded.get("f32").asFloat32())).toBe(true);
    expect(decoded.get("f64").asFloat64()).toBe(Infinity);
    expect(decoded.get("title").asText()).toBe("🚀");

    // Unknown enum ordinal encodes as number
    const unkB = new MessageBuilder();
    const unkS = DynamicStruct.initRoot(unkB, sinkSchema);
    unkS.set("priority", new DynamicEnum(prioSchema, 88));
    expect(rawCodec.encode(unkS)).toContain('"priority":88');

    // Reject unknown fields when enabled
    const strictCodec = new JsonCodec({ rejectUnknownFields: true });
    expect(() => strictCodec.decode('{"unknownKey":1}', sinkSchema)).toThrow(
      CapnpError,
    );

    // Reject out-of-range Data byte and excessive nesting depth
    expect(() => rawCodec.decode('{"raw":[256]}', sinkSchema)).toThrow(
      CapnpError,
    );
    const shallowCodec = new JsonCodec({ maxNestingDepth: 3 });
    expect(() =>
      shallowCodec.decode('{"a":{"b":{"c":{"d":1}}}}', sinkSchema),
    ).toThrow(CapnpError);

    // Multi-message stream splitter
    const parts = splitJsonMessages(
      '# first\n{"title":"{brace}"}\n// second\n{"title":"two"}\n',
    );
    expect(parts).toEqual(['{"title":"{brace}"}', '{"title":"two"}']);
  });

  test("supports $Json.name, $Json.hex, $Json.base64, $Json.flatten, and $Json.discriminator with out-of-order keys", () => {
    const loader = SchemaLoader.fromCgr(readGolden("dynamic-kitchen.cgr.bin"));
    const customSchema = loader.resolveStruct("JsonCustom");

    const b = new MessageBuilder();
    const c = DynamicStruct.initRoot(b, customSchema);
    c.set("renamedField", "hello");
    c.set("hexBlob", new Uint8Array([0xca, 0xfe]));
    c.set("b64Blob", new TextEncoder().encode("hi"));
    const ft = c.init("flatTag").asStruct();
    ft.set("key", "k");
    ft.set("code", 5);
    c.set("prio", "critical");
    const fv = c.init("flatVariant").asStruct();
    fv.set("key", "vk");
    fv.set("code", 9);
    c.get("boxedUnion").asStruct().set("num", 12345n);

    const encoded = encodeJson(c, { pretty: false });
    expect(encoded).toBe(
      '{"renamed_field":"hello","hexBlob":"cafe","b64Blob":"aGk=","tag_key":"k","tag_code":5,"prio":"CRITICAL","boxedUnion":{"boxType":"num","boxValue":"12345"},"kind":"tag_val","v_key":"vk","v_code":9}',
    );

    // Decode when flattened union fields and unionValue precede their discriminator keys
    const reordered =
      '{"v_code":9,"v_key":"vk","kind":"tag_val","boxedUnion":{"boxValue":"12345","boxType":"num"},"tag_code":5,"tag_key":"k","prio":"CRITICAL","b64Blob":"aGk=","hexBlob":"CAFE","renamed_field":"hello"}';
    const roundTripped = decodeJson(reordered, customSchema);
    expect(canonicalize(roundTripped)).toEqual(canonicalizeFlat(b.toFlat()));
  });

  test.skipIf(!hasCapnp)(
    "differential text-exact and canonical-byte-exact parity with capnp convert json",
    () => {
      const abLoader = SchemaLoader.fromCgr(readGolden("addressbook.cgr.bin"));
      const abSchema = abLoader.resolveStruct("AddressBook");
      const abFile = join(repoRoot, "schema/addressbook.capnp");
      const abBin = readGolden("addressbook.bin");

      const cliAbPretty = spawnSync(
        "capnp",
        ["convert", "binary:json", abFile, "AddressBook"],
        { input: abBin },
      );
      const cliAbShort = spawnSync(
        "capnp",
        ["convert", "binary:json", "--short", abFile, "AddressBook"],
        { input: abBin },
      );
      expect(cliAbPretty.status).toBe(0);
      expect(cliAbShort.status).toBe(0);

      const abReader = DynamicStruct.fromMessage(
        Message.fromFlat(abBin),
        abSchema,
      );
      expect(`${encodeJson(abReader, { pretty: true })}\n`).toBe(
        cliAbPretty.stdout.toString("utf-8"),
      );
      expect(`${encodeJson(abReader, { pretty: false })}\n`).toBe(
        cliAbShort.stdout.toString("utf-8"),
      );

      // KitchenSink differential matrix
      const ksLoader = SchemaLoader.fromCgr(
        readGolden("dynamic-kitchen.cgr.bin"),
      );
      const ksSchema = ksLoader.resolveStruct("KitchenSink");
      const jcSchema = ksLoader.resolveStruct("JsonCustom");
      const ksFile = join(repoRoot, "schema/dynamic-kitchen.capnp");

      const ksSamples = [
        "()",
        '(flag = true, f32 = 0.1, f64 = -0.0, title = "a\\nb\\tc\\"d\'e\\\\f\\x01\\x7f café 🚀", raw = 0x"00017f80ff")',
        "(f32 = nan, f64 = -inf, i64 = -9223372036854775808, u64 = 18446744073709551615, priority = critical)",
        '(matrix = [[1, 2], [], [3]], tags = [(key = "a", code = 1), (key = "b", code = 2)], detail = (detailId = 9, detailName = "ok"))',
      ];

      for (const sample of ksSamples) {
        const msg = decodeText(sample, ksSchema);
        const flat = msg.copyFlat();

        const cliPretty = spawnSync(
          "capnp",
          ["convert", "binary:json", ksFile, "KitchenSink"],
          { input: flat },
        );
        const cliShort = spawnSync(
          "capnp",
          ["convert", "binary:json", "--short", ksFile, "KitchenSink"],
          { input: flat },
        );
        expect(cliPretty.status).toBe(0);
        expect(cliShort.status).toBe(0);

        const reader = DynamicStruct.fromMessage(msg, ksSchema);
        const tsPretty = encodeJson(reader, { pretty: true });
        const tsShort = encodeJson(reader, { pretty: false });
        expect(`${tsPretty}\n`).toBe(cliPretty.stdout.toString("utf-8"));
        expect(`${tsShort}\n`).toBe(cliShort.stdout.toString("utf-8"));

        const cliFromJson = spawnSync(
          "capnp",
          ["convert", "json:canonical", ksFile, "KitchenSink"],
          { input: Buffer.from(tsPretty, "utf-8") },
        );
        expect(cliFromJson.status).toBe(0);
        expect(canonicalize(decodeJson(tsPretty, ksSchema))).toEqual(
          new Uint8Array(cliFromJson.stdout),
        );
      }

      // Extreme binary golden differential check
      const extBin = readGolden("dynamic-kitchen-extreme.bin");
      // Strip generic fields that hold AnyPointer in generic unbranded form? No, stringBox/tagBox are branded structs!
      const extPrettyCli = spawnSync(
        "capnp",
        ["convert", "binary:json", ksFile, "KitchenSink"],
        { input: extBin },
      );
      const extShortCli = spawnSync(
        "capnp",
        ["convert", "binary:json", "--short", ksFile, "KitchenSink"],
        { input: extBin },
      );
      expect(extPrettyCli.status).toBe(0);
      expect(extShortCli.status).toBe(0);
      const extReader = DynamicStruct.fromMessage(
        Message.fromFlat(extBin),
        ksSchema,
      );
      expect(`${encodeJson(extReader, { pretty: true })}\n`).toBe(
        extPrettyCli.stdout.toString("utf-8"),
      );
      expect(`${encodeJson(extReader, { pretty: false })}\n`).toBe(
        extShortCli.stdout.toString("utf-8"),
      );

      // JsonCustom annotated variants differential check
      for (const jcText of [
        "(emptyVariant = void)",
        '(renamedField = "r", hexBlob = 0x"01ab", b64Blob = "xyz", textVariant = "tv", boxedUnion = (label = "lbl"))',
        '(flatTag = (key = "fk", code = -3), flatVariant = (key = "vk", code = 8), prio = critical, boxedUnion = (num = -999))',
      ]) {
        const msg = decodeText(jcText, jcSchema);
        const flat = msg.copyFlat();
        const cliPretty = spawnSync(
          "capnp",
          ["convert", "binary:json", ksFile, "JsonCustom"],
          { input: flat },
        );
        const cliShort = spawnSync(
          "capnp",
          ["convert", "binary:json", "--short", ksFile, "JsonCustom"],
          { input: flat },
        );
        expect(cliPretty.status).toBe(0);
        expect(cliShort.status).toBe(0);

        const reader = DynamicStruct.fromMessage(msg, jcSchema);
        const tsPretty = encodeJson(reader, { pretty: true });
        const tsShort = encodeJson(reader, { pretty: false });
        expect(`${tsPretty}\n`).toBe(cliPretty.stdout.toString("utf-8"));
        expect(`${tsShort}\n`).toBe(cliShort.stdout.toString("utf-8"));

        const cliCanon = spawnSync(
          "capnp",
          ["convert", "json:canonical", ksFile, "JsonCustom"],
          { input: Buffer.from(tsPretty, "utf-8") },
        );
        expect(cliCanon.status).toBe(0);
        expect(canonicalize(decodeJson(tsPretty, jcSchema))).toEqual(
          new Uint8Array(cliCanon.stdout),
        );
      }
    },
  );
});
