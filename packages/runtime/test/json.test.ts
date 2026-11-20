import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/**
 * Canonical bytes of `decodeJson(text, struct)` for each text, computed in a
 * child Bun process that is killed after 8 s. A parser stuck in a synchronous
 * loop never yields to the test runner, so `--timeout` alone cannot stop it.
 */
function decodeJsonCanonicalBounded(
  cgr: Uint8Array,
  structName: string,
  texts: string[],
): Uint8Array[] {
  const dir = mkdtempSync(join(tmpdir(), "capnp-json-bounded-"));
  try {
    writeFileSync(join(dir, "schema.cgr"), cgr);
    writeFileSync(join(dir, "texts.json"), JSON.stringify(texts));
    const script = [
      `import { readFileSync } from "node:fs";`,
      `import { SchemaLoader, canonicalize, decodeJson } from ${JSON.stringify(join(here, "..", "src", "index.ts"))};`,
      `const dir = ${JSON.stringify(dir)};`,
      `const schema = SchemaLoader.fromCgr(new Uint8Array(readFileSync(dir + "/schema.cgr"))).resolveStruct(${JSON.stringify(structName)});`,
      `const texts = JSON.parse(readFileSync(dir + "/texts.json", "utf8"));`,
      `process.stdout.write(JSON.stringify(texts.map((t) => Buffer.from(canonicalize(decodeJson(t, schema))).toString("base64"))));`,
    ].join("\n");
    const r = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      timeout: 8000,
      killSignal: "SIGKILL",
      maxBuffer: 1 << 28,
    });
    if (r.error || r.status !== 0) {
      throw new Error(
        `decodeJson child failed (${r.error?.message ?? `exit ${r.status}`}): ${r.stderr}`,
      );
    }
    return (JSON.parse(r.stdout) as string[]).map(
      (b) => new Uint8Array(Buffer.from(b, "base64")),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    expect(
      Number.isNaN(
        rawCodec.decode('{"f32":"-NaN"}', sinkSchema).get("f32").asFloat32(),
      ),
    ).toBe(true);

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
    expect(parts).toEqual([
      '# first\n{"title":"{brace}"}\n// second\n',
      '{"title":"two"}\n',
    ]);
  });

  test.skipIf(!hasCapnp)("JSON streams split and parse like capnp convert json", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "capnp-json-split-"));
    try {
      const schemaPath = join(tmpDir, "split.capnp");
      writeFileSync(schemaPath, "@0x8123456789abcde5;\nstruct T { t @0 :Text; }\n");
      const cgr = spawnSync("capnp", ["compile", "-o-", schemaPath]);
      expect(cgr.status).toBe(0);
      const schema = SchemaLoader.fromCgr(new Uint8Array(cgr.stdout)).resolveStruct("T");
      const inputs = [
        '\v{"t":"a"}',
        '\f{"t":"a"}',
        '// c\n{"t":"a"}',
        '# c\n{"t":"a"}',
        '{"t":"}{"} {"t":"c"}',
        '\xef\xbb\xbf{"t":"a"}',
        "  \n",
        '{"t":"a"}\v',
        '{"t":"a"} x {"t":"b"}',
        '{"t":"a"}/x/{"t":"b"}',
        '{"t":"a"} // c\n {"t":"b"}',
        '{"t":"a"}\n',
        ' \t\r\n{"t":"a"} \t\r\n',
        '{"t":"a"}{"t":"b"}',
        '{"t":"a"}}{"t":"b"}',
        '{"t":"{"}',
        '{"t":"a # b"}\n{"t":"c"}',
        '{"t":"a"}\n# c {\n{"t":"b"}',
      ];
      const mismatches: string[] = [];
      for (const input of inputs) {
        const cpp = spawnSync("capnp", ["convert", "--quiet", "json:canonical", schemaPath, "T"], {
          input: Buffer.from(input, "latin1"),
        });
        let ts: Uint8Array | null;
        try {
          const parts = splitJsonMessages(input).map((s) => canonicalize(decodeJson(s, schema)));
          ts = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
          let off = 0;
          for (const p of parts) {
            ts.set(p, off);
            off += p.byteLength;
          }
        } catch {
          ts = null;
        }
        const cppOk = cpp.status === 0;
        if (cppOk !== (ts !== null)) {
          mismatches.push(`${JSON.stringify(input)}: cpp_ok=${cppOk} ts_ok=${ts !== null}`);
        } else if (ts !== null && Buffer.compare(Buffer.from(ts), Buffer.from(cpp.stdout)) !== 0) {
          mismatches.push(`${JSON.stringify(input)}: bytes differ`);
        }
      }
      expect(mismatches).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
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
        "(boxedUnion = (none = void))",
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

      // $Json.discriminator without explicit name omits the tag field, matching C++
      const tmpDir = mkdtempSync(join(tmpdir(), "capnp-json-edge-"));
      try {
        const edgePath = join(tmpDir, "json_edge.capnp");
        writeFileSync(
          edgePath,
          [
            "@0x8123456789abcde1;",
            "annotation jsonFlatten @0x82d3e852af0336bf (field, group, union) :JsonFlattenOptions;",
            "annotation jsonDiscriminator @0xcfa794e8d19a0162 (struct, union) :JsonDiscriminatorOptions;",
            "struct JsonFlattenOptions { prefix @0 :Text = \"\"; }",
            "struct JsonDiscriminatorOptions { name @0 :Text; valueName @1 :Text; }",
            "struct Inner { x @0 :Int32; }",
            "struct Edge {",
            "  flatNull @0 :Inner $jsonFlatten();",
            "  u :union $jsonDiscriminator() {",
            "    ua @1 :Void;",
            "    ub @2 :Inner $jsonFlatten(prefix = \"p_\");",
            "  }",
            "  v :union $jsonDiscriminator(valueName = \"val\") {",
            "    va @3 :Void;",
            "    vb @4 :Text;",
            "  }",
            "}",
          ].join("\n"),
        );
        const cgr = spawnSync("capnp", ["compile", "-o-", edgePath]);
        expect(cgr.status).toBe(0);
        const eLoader = SchemaLoader.fromCgr(new Uint8Array(cgr.stdout));
        const edgeSchema = eLoader.resolveStruct("Edge");

        for (const edgeText of [
          "(u = (ua = void), v = (va = void))",
          '(u = (ub = (x = 77)), v = (vb = "hi"))',
        ]) {
          const cliBin = new Uint8Array(
            spawnSync("capnp", ["encode", edgePath, "Edge"], {
              input: edgeText,
            }).stdout,
          );
          const cliShort = spawnSync(
            "capnp",
            ["convert", "binary:json", "--short", edgePath, "Edge"],
            { input: cliBin },
          );
          expect(cliShort.status).toBe(0);
          const reader = DynamicStruct.fromMessage(
            Message.fromFlat(cliBin),
            edgeSchema,
          );
          expect(`${encodeJson(reader, { pretty: false })}\n`).toBe(
            cliShort.stdout.toString("utf-8"),
          );
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!hasCapnp)(
    "flattened unnamed discriminator matches capnp 1.4.0",
    () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "capnp-json-flat-"));
      try {
        const edgePath = join(tmpDir, "json_flat.capnp");
        writeFileSync(
          edgePath,
          [
            "@0x8123456789abcde2;",
            "annotation jsonFlatten @0x82d3e852af0336bf (field, group, union) :JsonFlattenOptions;",
            "annotation jsonDiscriminator @0xcfa794e8d19a0162 (struct, union) :JsonDiscriminatorOptions;",
            "struct JsonFlattenOptions { prefix @0 :Text = \"\"; }",
            "struct JsonDiscriminatorOptions { name @0 :Text; valueName @1 :Text; }",
            "struct Inner { x @0 :Int32; }",
            "struct Flat {",
            "  kind :union $jsonFlatten() $jsonDiscriminator() {",
            "    empty @0 :Void;",
            "    inner @1 :Inner;",
            "  }",
            "}",
          ].join("\n"),
        );
        const cgr = spawnSync("capnp", ["compile", "-o-", edgePath]);
        expect(cgr.status).toBe(0);
        const loader = SchemaLoader.fromCgr(new Uint8Array(cgr.stdout));
        const schema = loader.resolveStruct("Flat");
        for (const text of ["(kind = (empty = void))", "(kind = (inner = (x = 42)))"]) {
          const cliBin = new Uint8Array(
            spawnSync("capnp", ["encode", edgePath, "Flat"], { input: text }).stdout,
          );
          const cliShort = spawnSync(
            "capnp",
            ["convert", "binary:json", "--short", edgePath, "Flat"],
            { input: cliBin },
          );
          expect(cliShort.status).toBe(0);
          const reader = DynamicStruct.fromMessage(Message.fromFlat(cliBin), schema);
          const tsShort = encodeJson(reader, { pretty: false });
          expect(`${tsShort}\n`).toBe(cliShort.stdout.toString("utf-8"));
          const cliCanon = spawnSync(
            "capnp",
            ["convert", "json:canonical", edgePath, "Flat"],
            { input: Buffer.from(`${tsShort}\n`, "utf-8") },
          );
          expect(cliCanon.status).toBe(0);
          expect(canonicalize(decodeJson(tsShort, schema))).toEqual(new Uint8Array(cliCanon.stdout));
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  const floatStrings: Array<[string, number | "nan" | "error"]> = [
    ["NaN", "nan"],
    ["NAN", "nan"],
    ["-NAN", "nan"],
    ["+NAN", "nan"],
    ["nAn", "nan"],
    ["nan(1)", "nan"],
    ["NAN(abc_1)", "nan"],
    ["nan()", "nan"],
    ["INF", Infinity],
    ["Inf", Infinity],
    ["+Inf", Infinity],
    ["-Inf", -Infinity],
    ["-INF", -Infinity],
    ["Infinity", Infinity],
    ["INFINITY", Infinity],
    ["-infinity", -Infinity],
    [" 1.5", 1.5],
    ["\t2", 2],
    ["0x10", 16],
    ["0x1p3", 8],
    ["0X1.8P1", 3],
    ["-0x.8p1", -1],
    ["1.e3", 1000],
    ["+.5", 0.5],
    ["nan(", "error"],
    ["nan(!)", "error"],
    ["infin", "error"],
    ["infinityx", "error"],
    ["nanx", "error"],
    ["1.5 ", "error"],
    ["", "error"],
    ["+", "error"],
    [".", "error"],
    ["1e", "error"],
    ["0x", "error"],
    ["0xg", "error"],
    ["- 1", "error"],
  ];

  test("float strings follow strtod like kj parseAs<double>", () => {
    const loader = SchemaLoader.fromCgr(readGolden("dynamic-kitchen.cgr.bin"));
    const schema = loader.resolveStruct("KitchenSink");
    for (const [text, want] of floatStrings) {
      for (const field of ["f64", "f32"]) {
        const json = JSON.stringify({ [field]: text });
        if (want === "error") {
          expect(() => decodeJson(json, schema)).toThrow(CapnpError);
          continue;
        }
        const v = DynamicStruct.fromMessage(decodeJson(json, schema), schema).get(field).asFloat64();
        if (want === "nan") expect(Number.isNaN(v)).toBe(true);
        else expect(v).toBe(want);
      }
    }
  });

  test.skipIf(!hasCapnp)("float strings are accepted and rejected like capnp convert json:text", () => {
    const loader = SchemaLoader.fromCgr(readGolden("dynamic-kitchen.cgr.bin"));
    const schema = loader.resolveStruct("KitchenSink");
    const file = join(repoRoot, "schema/dynamic-kitchen.capnp");
    const mismatches: string[] = [];
    for (const [text, want] of floatStrings) {
      const json = JSON.stringify({ f64: text });
      const cli = spawnSync("capnp", ["convert", "json:text", file, "KitchenSink"], {
        input: json,
        encoding: "utf8",
      });
      expect(cli.status === 0).toBe(want !== "error");
      let tsAccepts = true;
      try {
        decodeJson(json, schema);
      } catch {
        tsAccepts = false;
      }
      if (tsAccepts !== (cli.status === 0)) mismatches.push(text);
    }
    expect(mismatches).toEqual([]);
  });

  test("hex float strings round like strtod without hanging or double-rounding", () => {
    const loader = SchemaLoader.fromCgr(readGolden("dynamic-kitchen.cgr.bin"));
    const schema = loader.resolveStruct("KitchenSink");
    const f64Bits = (n: number): bigint => {
      const b = new ArrayBuffer(8);
      const v = new DataView(b);
      v.setFloat64(0, n, true);
      return v.getBigUint64(0, true);
    };
    const cases: Array<[string, bigint]> = [
      [`0x1${"0".repeat(300)}p-1200`, f64Bits(1)],
      [`0x1.${"0".repeat(260)}1p0`, f64Bits(1)],
      ["0x2000000000000bp-1077", 0x0004000000000001n],
      ["0x0p100000000000000000000", 0x0000000000000000n],
      ["-0x0p100000000000000000000", 0x8000000000000000n],
      ["0x0.000p-100000000000000000000", 0x0000000000000000n],
      ["0x1p+999999999999999999999", f64Bits(Infinity)],
      ["-0x1p+999999999999999999999", f64Bits(-Infinity)],
      ["0x1p-999999999999999999999", 0x0000000000000000n],
      ["-0x1p-999999999999999999999", 0x8000000000000000n],
      ["0x1p-1075", 0x0000000000000000n],
      ["0x1.00000000000001p-1075", 0x0000000000000001n],
      ["0x1p-1074", 0x0000000000000001n],
      ["0x0.fffffffffffff8p-1022", 0x0010000000000000n],
      ["0x1.fffffffffffff8p1023", f64Bits(Infinity)],
      ["0x1.fffffffffffff7ffffffffp1023", f64Bits(Number.MAX_VALUE)],
      // Real `capnp convert json:flat` output from C++ 1.4.0 / glibc strtod.
      ["0x20000000000003p-1076", 0x0008000000000000n],
      ["0x20000000000005p-1077", 0x0004000000000000n],
      ["0x20000000000009p-1078", 0x0002000000000000n],
      ["0x2000000000000bp-1076", 0x0008000000000002n],
      ["0x20000000000011p-1079", 0x0001000000000000n],
      ["0x20000000000013p-1076", 0x0008000000000004n],
      ["0x20000000000015p-1077", 0x0004000000000002n],
      ["0x2000000000001bp-1076", 0x0008000000000006n],
      ["0x1.9Dedacc99f24A8p-1024", 0x000677b6b3267c92n],
      ["0x7.ffffffffffff5p-1025", 0x000fffffffffffffn],
      // glibc drops the first bit below the 53-bit significand before the
      // subnormal shift, so these differ from correct rounding.
      ["0x7fffffffffffe60p-1081", 0x000ffffffffffffcn],
      ["-0x581fab38b420f6P-1077", 0x800b03f56716841en],
      ["0x1fff.fffffffffd4P-1035", 0x000fffffffffffffn],
      ["-0xffffffffffffee0p-1082", 0x800fffffffffffffn],
      ["0x7FFF.FFFFFFFFF5p-1037", 0x000fffffffffffffn],
      ["0x1FFFFFFFFFFFF94P-1079", 0x000ffffffffffffdn],
      ["0x1.00000000000008p-1075", 0x0000000000000000n],
      ["0x1.fffffffffffff7ffffp1023", 0x7fefffffffffffffn],
      ["0x1.fffffffffffff8p1023", 0x7ff0000000000000n],
    ];
    const canon = decodeJsonCanonicalBounded(
      readGolden("dynamic-kitchen.cgr.bin"),
      "KitchenSink",
      cases.map(([text]) => JSON.stringify({ f64: text })),
    );
    expect(canon.length).toBe(cases.length);
    cases.forEach(([, wantBits], i) => {
      const msg = Message.fromSegments([canon[i]!]);
      const got = DynamicStruct.fromMessage(msg, schema).get("f64").asFloat64();
      expect(f64Bits(got)).toBe(wantBits);
    });
  });

  test.skipIf(!hasCapnp)(
    "5000+ hex and decimal float strings match capnp convert json:flat bit-for-bit",
    () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "capnp-json-floats-"));
      try {
        const schemaPath = join(tmpDir, "floats.capnp");
        writeFileSync(
          schemaPath,
          [
            "@0x8123456789abcde3;",
            "struct FloatVec {",
            "  f64s @0 :List(Float64);",
            "  f32s @1 :List(Float32);",
            "}",
          ].join("\n"),
        );
        const cgr = spawnSync("capnp", ["compile", "-o-", schemaPath]);
        expect(cgr.status).toBe(0);

        const inputs: string[] = [
          "0",
          "-0",
          "+0",
          "0x0",
          "-0x0",
          "0x0p0",
          "0x0p100000000000000000000",
          "-0x0p100000000000000000000",
          "0x0.0000p-99999999999999999999",
          `0x1${"0".repeat(300)}p-1200`,
          `0x1.${"0".repeat(260)}1p0`,
          `0x0.${"0".repeat(260)}1p1044`,
          "0x2000000000000bp-1077",
          "-0x2000000000000bp-1077",
          "0x1p-1075",
          "0x1.00000000000001p-1075",
          "0x1.000000000000000000001p-1075",
          "0x3p-1075",
          "0x1p-1074",
          "0x1.8p-1074",
          "0x0.fffffffffffff4p-1022",
          "0x0.fffffffffffff8p-1022",
          "0x0.fffffffffffffcp-1022",
          "0x1.00000000000008p0",
          "0x1.00000000000018p0",
          "0x1.fffffffffffff8p1023",
          "0x1.fffffffffffff7ffffffffp1023",
          "0x1p1024",
          "-0x1p1024",
          "0x1p+99999999999999999999",
          "0x1p-99999999999999999999",
          "inf",
          "-inf",
          "+INFINITY",
          "1e309",
          "-1e309",
          "1e-325",
          "-1e-325",
          "5e-324",
          "2.225073858507201e-308",
          "2.2250738585072014e-308",
          "1.7976931348623157e+308",
        ];

        // Deterministic PRNG (xorshift32) for reproducible differential fuzzing
        let state = 0x5eed1234;
        const nextU32 = (): number => {
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          return state >>> 0;
        };
        const hexChars = "0123456789abcdefABCDEF";
        const randHex = (len: number): string => {
          let s = "";
          for (let i = 0; i < len; i++) s += hexChars[nextU32() % hexChars.length]!;
          return s;
        };
        const randDec = (len: number): string => {
          let s = "";
          for (let i = 0; i < len; i++) s += String(nextU32() % 10);
          return s;
        };

        // 2500 random hex floats covering normal, subnormal, tie, overflow, underflow
        const expBands: Array<[number, number]> = [
          [-1100, -1010],
          [-160, -110],
          [-50, 50],
          [110, 140],
          [1000, 1040],
          [-2000, 2000],
        ];
        for (let i = 0; i < 2500; i++) {
          const sign = nextU32() & 1 ? "-" : nextU32() & 3 ? "" : "+";
          const prefix = nextU32() & 1 ? "0x" : "0X";
          const pChar = nextU32() & 1 ? "p" : "P";
          const kind = i % 6;
          const [lo, hi] = expBands[i % expBands.length]!;
          const exp = lo + (nextU32() % (hi - lo + 1));
          const expSign = exp < 0 ? "" : nextU32() & 1 ? "+" : "";
          if (kind === 0) {
            // Exact half-way / near-tie 14-18 hex digit mantissa
            inputs.push(`${sign}${prefix}1.${randHex(12)}${hexChars[nextU32() % 16]}${pChar}${expSign}${exp}`);
          } else if (kind === 1) {
            // Long hex integer + compensating exponent
            const zeros = 1 + (nextU32() % 20);
            inputs.push(`${sign}${prefix}${randHex(1 + (nextU32() % 18))}${"0".repeat(zeros)}${pChar}${exp - 4 * zeros}`);
          } else if (kind === 2) {
            // Leading fractional zeros + sticky tail
            const lead = nextU32() % 10;
            const tail = nextU32() % 15;
            inputs.push(`${sign}${prefix}0.${"0".repeat(lead)}${randHex(1 + (nextU32() % 16))}${"0".repeat(tail)}${nextU32() & 1 ? "1" : ""}${pChar}${exp + 4 * lead}`);
          } else if (kind === 3) {
            // No dot
            inputs.push(`${sign}${prefix}${randHex(1 + (nextU32() % 20))}${pChar}${expSign}${exp}`);
          } else if (kind === 4) {
            // No int part
            inputs.push(`${sign}${prefix}.${randHex(1 + (nextU32() % 18))}${pChar}${expSign}${exp}`);
          } else {
            // No p-exponent
            inputs.push(`${sign}${prefix}${randHex(1 + (nextU32() % 16))}.${randHex(nextU32() % 16)}`);
          }
        }

        // 2500 random decimal floats across normal, subnormal, boundary, overflow.
        for (let i = 0; i < 2500; i++) {
          const sign = nextU32() & 1 ? "-" : nextU32() & 3 ? "" : "+";
          const eChar = nextU32() & 1 ? "e" : "E";
          const decExp =
            i % 4 === 0
              ? -330 + (nextU32() % 35)
              : i % 4 === 1
                ? 295 + (nextU32() % 25)
                : -50 + (nextU32() % 100);
          const intLen = 1 + (nextU32() % 6);
          const fracLen = nextU32() % 22;
          const mant = fracLen === 0 ? randDec(intLen) : `${randDec(intLen)}.${randDec(fracLen)}`;
          inputs.push(`${sign}${mant}${eChar}${decExp >= 0 && (nextU32() & 1) ? "+" : ""}${decExp}`);
        }

        expect(inputs.length).toBeGreaterThanOrEqual(5000);
        const json = JSON.stringify({ f64s: inputs, f32s: inputs });
        const cli = spawnSync("capnp", ["convert", "json:flat", schemaPath, "FloatVec"], {
          input: json,
        });
        expect(cli.status).toBe(0);
        const cppFlat = new Uint8Array(cli.stdout);
        const [tsCanon] = decodeJsonCanonicalBounded(new Uint8Array(cgr.stdout), "FloatVec", [json]);
        expect(tsCanon).toEqual(canonicalize(Message.fromSegments([cppFlat])));
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test("JSON NaN spellings keep sign and payload bits on the wire", () => {
    const loader = SchemaLoader.fromCgr(readGolden("dynamic-kitchen.cgr.bin"));
    const schema = loader.resolveStruct("KitchenSink");
    const cases: Array<[string, bigint, number]> = [
      ["nan", 0x7ff8000000000000n, 0x7fc00000],
      ["-NAN", 0xfff8000000000000n, 0xffc00000],
      ["nan(1)", 0x7ff8000000000001n, 0x7fc00000],
      ["-nan(1)", 0xfff8000000000001n, 0xffc00000],
      ["nan(0x123456789abcd)", 0x7ff923456789abcdn, 0x7fc91a2b],
      ["nan(010)", 0x7ff8000000000008n, 0x7fc00000],
      ["nan(42)", 0x7ff800000000002an, 0x7fc00000],
      ["nan(0x0007ffffffffffff)", 0x7fffffffffffffffn, 0x7fffffff],
      ["nan(0x10000000000000000)", 0x7fffffffffffffffn, 0x7fffffff],
      ["nan(08)", 0x7ff8000000000000n, 0x7fc00000],
      ["nan(abc_1)", 0x7ff8000000000000n, 0x7fc00000],
    ];
    for (const [text, wantF64, wantF32] of cases) {
      const msg = decodeJson(JSON.stringify({ f64: text, f32: text }), schema);
      const reader = DynamicStruct.fromMessage(msg, schema);
      expect(reader.get("f64").asFloat64Bits()).toBe(wantF64);
      expect(reader.get("f32").asFloat32Bits()).toBe(wantF32);
      expect(Number.isNaN(reader.get("f64").asFloat64())).toBe(true);
      expect(Number.isNaN(reader.get("f32").asFloat32())).toBe(true);
    }
  });

  test.skipIf(!hasCapnp)(
    "JSON NaN sign and payload wire bits match capnp convert json:flat",
    () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "capnp-json-nan-"));
      try {
        const schemaPath = join(tmpDir, "nans.capnp");
        writeFileSync(
          schemaPath,
          [
            "@0x8123456789abcde8;",
            "struct NanVec {",
            "  f64s @0 :List(Float64);",
            "  f32s @1 :List(Float32);",
            "  f64Def @2 :Float64 = -2.25;",
            "  f32Def @3 :Float32 = 1.5;",
            "}",
          ].join("\n"),
        );
        const cgr = spawnSync("capnp", ["compile", "-o-", schemaPath]);
        expect(cgr.status).toBe(0);
        const schema = SchemaLoader.fromCgr(new Uint8Array(cgr.stdout)).resolveStruct("NanVec");
        const spellings = [
          "nan",
          "NaN",
          "+nan",
          "-nan",
          "-NAN",
          "nan()",
          "-nan()",
          "nan(0)",
          "nan(1)",
          "-nan(1)",
          "nan(0x1)",
          "nan(0x1234)",
          "nan(0x123456789abcd)",
          "nan(0x4000000000000)",
          "nan(0x8000000000000)",
          "nan(0x0007ffffffffffff)",
          "nan(0xffffffffffffffff)",
          "nan(0x10000000000000000)",
          "nan(999999999999999999999999999999)",
          "nan(010)",
          "nan(42)",
          "nan(08)",
          "nan(0x)",
          "nan(abc_1)",
        ];
        const json = JSON.stringify({
          f64s: [...spellings, null],
          f32s: [...spellings, null],
          f64Def: "-nan(1)",
          f32Def: "-NAN",
        });
        const cli = spawnSync("capnp", ["convert", "json:flat", schemaPath, "NanVec"], {
          input: json,
        });
        expect(cli.status).toBe(0);
        const cppFlat = new Uint8Array(cli.stdout);
        const tsMsg = decodeJson(json, schema);
        expect(canonicalize(tsMsg)).toEqual(
          canonicalize(Message.fromSegments([cppFlat])),
        );
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
