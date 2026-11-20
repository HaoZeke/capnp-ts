import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CapnpError,
  DynamicCapability,
  DynamicEnum,
  DynamicStruct,
  Message,
  MessageBuilder,
  SchemaLoader,
  TextCodec,
  type TextInputError,
  canonicalize,
  canonicalizeFlat,
  decodeText,
  encodeText,
  formatKjFloat32,
  initDynamicRoot,
  prettyPrint,
  splitTextMessages,
  stringify,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const goldenDir = join(here, "golden");
const hasCapnp = spawnSync("capnp", ["--version"]).status === 0;

function readGolden(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(goldenDir, name)));
}

describe("Cap'n Proto text-format encoder and decoder", () => {
  test("matches exact AddressBook pretty and short text and round-trips to canonical bytes", () => {
    const loader = SchemaLoader.fromCgr(readGolden("addressbook.cgr.bin"));
    const bookSchema = loader.resolveStruct("AddressBook");
    const book = DynamicStruct.fromMessage(
      Message.fromFlat(readGolden("addressbook.bin")),
      bookSchema,
    );

    const expectedPretty = [
      "( people = [",
      "    ( id = 123,",
      '      name = "Alice",',
      '      email = "alice@example.com",',
      "      phones = [",
      '        (number = "555-1212", type = mobile) ],',
      '      employment = (school = "MIT") ),',
      "    ( id = 456,",
      '      name = "Bob",',
      '      email = "bob@example.com",',
      "      phones = [",
      '        (number = "555-4567", type = home),',
      '        (number = "555-7654", type = work) ],',
      "      employment = (unemployed = void) ) ] )",
    ].join("\n");

    const expectedShort =
      '(people = [(id = 123, name = "Alice", email = "alice@example.com", phones = [(number = "555-1212", type = mobile)], employment = (school = "MIT")), (id = 456, name = "Bob", email = "bob@example.com", phones = [(number = "555-4567", type = home), (number = "555-7654", type = work)], employment = (unemployed = void))])';

    expect(prettyPrint(book)).toBe(expectedPretty);
    expect(stringify(book)).toBe(expectedShort);

    const decodedFromPretty = decodeText(expectedPretty, bookSchema);
    const decodedFromShort = decodeText(expectedShort, bookSchema);
    const canonGolden = readGolden("addressbook.canonical.bin");
    expect(canonicalize(decodedFromPretty)).toEqual(canonGolden);
    expect(canonicalize(decodedFromShort)).toEqual(canonGolden);
  });

  test("round-trips KitchenSink extremes, escapes, comments, hex/octal literals, and unknown enums", () => {
    const loader = SchemaLoader.fromCgr(readGolden("dynamic-kitchen.cgr.bin"));
    const sinkSchema = loader.resolveStruct("KitchenSink");
    const prioSchema = loader.resolve("Priority").asEnum();

    const extremeBytes = readGolden("dynamic-kitchen-extreme.bin");
    const extremeReader = DynamicStruct.fromMessage(
      Message.fromFlat(extremeBytes),
      sinkSchema,
    );
    const pretty = encodeText(extremeReader, { pretty: true });
    const short = encodeText(extremeReader, { pretty: false });

    expect(canonicalize(decodeText(pretty, sinkSchema))).toEqual(
      canonicalizeFlat(extremeBytes),
    );
    expect(canonicalize(decodeText(short, sinkSchema))).toEqual(
      canonicalizeFlat(extremeBytes),
    );

    // Rich literal syntax: comments, hex ints, octal ints, string chains, backtick, 0x"..." with spaces
    const richText = `
      # Leading comment
      (
        flag = true,
        i32 = -0x20,
        u16 = 0755,
        f32 = -0.0,
        f64 = inf,
        title = "part1-" "part2-" \`raw line
        ,
        raw = 0x"de ad\nbe ef",
        matrix = [[1, 2,], [],],
      ) # trailing comment
    `;
    const msg = decodeText(richText, sinkSchema);
    const parsed = DynamicStruct.fromMessage(msg, sinkSchema);
    expect(parsed.get("i32").asInt32()).toBe(-32);
    expect(parsed.get("u16").asUInt16()).toBe(0o755);
    expect(Object.is(parsed.get("f32").asFloat32(), -0)).toBe(true);
    expect(parsed.get("f64").asFloat64()).toBe(Infinity);
    expect(parsed.get("title").asText()).toBe("part1-part2-raw line\n");
    expect(parsed.get("raw").asData()).toEqual(
      new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    );
    expect(stringify(new DynamicEnum(prioSchema, 77))).toBe("(77)");
    // capnp prints an unknown enumerant as `(77)` but cannot parse it back.
    expect(() => decodeText("(priority = (77))", sinkSchema)).toThrow(CapnpError);

    // Stream splitting with comments and parens inside strings
    const stream = `
      # msg 1
      (title = "(not a new message)")
      # msg 2
      (title = "second", i32 = 9)
    `;
    const parts = splitTextMessages(stream);
    expect(parts.length).toBe(2);
    expect(
      DynamicStruct.fromMessage(decodeText(parts[0]!, sinkSchema), sinkSchema)
        .get("title")
        .asText(),
    ).toBe("(not a new message)");
    expect(
      DynamicStruct.fromMessage(decodeText(parts[1]!, sinkSchema), sinkSchema)
        .get("i32")
        .asInt32(),
    ).toBe(9);

    // Rejections matching capnp encode
    expect(() => decodeText("(unknownField = 1)", sinkSchema)).toThrow(
      CapnpError,
    );
    // capnp encode lets a later union member or a repeated field win.
    const lastWins = (src: string) =>
      DynamicStruct.fromMessage(decodeText(src, sinkSchema), sinkSchema);
    expect(lastWins('(none = void, note = "both")').which()?.name).toBe("note");
    expect(lastWins('(none = void, note = "both")').get("note").asText()).toBe("both");
    expect(lastWins('(note = "both", none = void)').which()?.name).toBe("none");
    expect(lastWins("(i8 = 1, i8 = 2)").get("i8").asInt8()).toBe(2);
    expect(() => decodeText("(i8 = 999)", sinkSchema)).toThrow(CapnpError);
    for (const badText of [
      "(i8 = +1)",
      "(f64 = +1.5)",
      "(f64 = +inf)",
      "(f64 = +nan)",
      "(f64 = -nan)",
      "(f64 = .5)",
      "(f64 = -.5)",
    ]) {
      expect(() => decodeText(badText, sinkSchema)).toThrow(CapnpError);
    }

    const invalidUtf8 = DynamicStruct.fromMessage(
      decodeText('(title = "\\377")', sinkSchema),
      sinkSchema,
    );
    expect(invalidUtf8.get("title").asText()).toBe("\ufffd");
    expect(formatKjFloat32(1.401298464324817e-45)).toBe("1.4012985e-45");
  });


  test.skipIf(!hasCapnp)("a parenthesized value is that value, like capnp convert text", () => {
    const schemaPath = join(repoRoot, "schema/dynamic-kitchen.capnp");
    const ks = SchemaLoader.fromCgr(readGolden("dynamic-kitchen.cgr.bin")).resolveStruct("KitchenSink");
    const mismatches: string[] = [];
    for (const input of [
      '((title = "a"))',
      '(((title = "a")))',
      '(title = ("a"))',
      "(i32 = (5), f64 = ((inf)))",
      "(i32 = (-5))",
      "(matrix = ([[1, (2)], ([])]))",
      "(priority = (high))",
      "(())",
      "()",
      "(priority = (77))",
      "(i32 = (5, 6))",
      '((title = "a"), (title = "b"))',
      '((title = "a") (title = "b"))',
      "(5)",
    ]) {
      const cpp = spawnSync(
        "capnp",
        ["convert", "--quiet", "text:canonical", schemaPath, "KitchenSink"],
        { input },
      );
      let ts: Uint8Array | null;
      try {
        ts = canonicalize(decodeText(input, ks));
      } catch {
        ts = null;
      }
      if ((cpp.status === 0) !== (ts !== null)) {
        mismatches.push(`${input}: cpp_ok=${cpp.status === 0} ts_ok=${ts !== null}`);
      } else if (ts !== null && Buffer.compare(Buffer.from(ts), Buffer.from(cpp.stdout)) !== 0) {
        mismatches.push(`${input}: bytes differ`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  test.skipIf(!hasCapnp)("text streams with no message fail like capnp convert text", () => {
    const schemaPath = join(repoRoot, "schema/addressbook.capnp");
    const person = SchemaLoader.fromCgr(readGolden("addressbook.cgr.bin")).resolveStruct("Person");
    const mismatches: string[] = [];
    for (const input of [
      " ",
      "\n\n",
      "#c\n",
      " # c\n # d",
      '(name = "a")\n# trailing\n',
      '# lead\n(name = "a") (name = "b")\n\n',
    ]) {
      const cpp = spawnSync(
        "capnp",
        ["convert", "--quiet", "text:canonical", schemaPath, "Person"],
        { input },
      );
      let ts: Uint8Array | null;
      try {
        ts = Buffer.concat(
          splitTextMessages(input).map((s) => canonicalize(decodeText(s, person))),
        );
      } catch {
        ts = null;
      }
      if ((cpp.status === 0) !== (ts !== null)) {
        mismatches.push(`${JSON.stringify(input)}: cpp_ok=${cpp.status === 0} ts_ok=${ts !== null}`);
      } else if (ts !== null && Buffer.compare(Buffer.from(ts), Buffer.from(cpp.stdout)) !== 0) {
        mismatches.push(`${JSON.stringify(input)}: bytes differ`);
      }
    }
    expect(mismatches).toEqual([]);
  });
  test.skipIf(!hasCapnp)(
    "differential text-exact and byte-exact parity against capnp decode and encode",
    () => {
      const abLoader = SchemaLoader.fromCgr(readGolden("addressbook.cgr.bin"));
      const abSchema = abLoader.resolveStruct("AddressBook");
      const abFile = join(repoRoot, "schema/addressbook.capnp");
      const abBin = readGolden("addressbook.bin");

      const cliAbPretty = spawnSync("capnp", ["decode", abFile, "AddressBook"], {
        input: abBin,
      });
      const cliAbShort = spawnSync(
        "capnp",
        ["decode", "--short", abFile, "AddressBook"],
        { input: abBin },
      );
      expect(cliAbPretty.status).toBe(0);
      expect(cliAbShort.status).toBe(0);

      const abReader = DynamicStruct.fromMessage(
        Message.fromFlat(abBin),
        abSchema,
      );
      expect(`${encodeText(abReader, { pretty: true })}\n`).toBe(
        cliAbPretty.stdout.toString("utf-8"),
      );
      expect(`${encodeText(abReader, { pretty: false })}\n`).toBe(
        cliAbShort.stdout.toString("utf-8"),
      );

      // KitchenSink differential matrix
      const ksLoader = SchemaLoader.fromCgr(
        readGolden("dynamic-kitchen.cgr.bin"),
      );
      const ksSchema = ksLoader.resolveStruct("KitchenSink");
      const ksFile = join(repoRoot, "schema/dynamic-kitchen.capnp");
      const codecPretty = new TextCodec({ prettyPrint: true });
      const codecShort = new TextCodec({ prettyPrint: false });

      const textSamples = [
        "()",
        '(flag = true, f32 = -0.0, f64 = -0.0, title = "café 🚀", raw = 0x"000708090a0b0c0d1f2022275c7f80ff")',
        "(f32 = 1e-5, f64 = 1e-5)",
        "(f32 = 1e-4, f64 = 1e-4)",
        "(f32 = 1e6, f64 = 1e15)",
        "(f32 = 3.14159265, f64 = 3.141592653589793)",
        "(f32 = nan, f64 = inf, i64 = -9223372036854775808, u64 = 18446744073709551615)",
        '(note = "", source = (uri = ""))',
        '(detail = (detailId = 7, detailName = "x"), meta = (author = "Bob", nested = (ok = false, score = -inf)))',
      ];

      for (const sample of textSamples) {
        const cliEnc = spawnSync("capnp", ["encode", ksFile, "KitchenSink"], {
          input: Buffer.from(sample, "utf-8"),
        });
        expect(cliEnc.status).toBe(0);
        const cliBin = new Uint8Array(cliEnc.stdout);

        const tsMsg = decodeText(sample, ksSchema);
        expect(canonicalize(tsMsg)).toEqual(canonicalizeFlat(cliBin));

        const cliPretty = spawnSync("capnp", ["decode", ksFile, "KitchenSink"], {
          input: cliBin,
        });
        const cliShort = spawnSync(
          "capnp",
          ["decode", "--short", ksFile, "KitchenSink"],
          { input: cliBin },
        );
        expect(cliPretty.status).toBe(0);
        expect(cliShort.status).toBe(0);

        const reader = DynamicStruct.fromMessage(
          Message.fromFlat(cliBin),
          ksSchema,
        );
        expect(`${codecPretty.encode(reader)}\n`).toBe(
          cliPretty.stdout.toString("utf-8"),
        );
        expect(`${codecShort.encode(reader)}\n`).toBe(
          cliShort.stdout.toString("utf-8"),
        );
      }

      // Also check extremeConst binary golden character-for-character against capnp decode
      const extBin = readGolden("dynamic-kitchen-extreme.bin");
      const extCliPretty = spawnSync("capnp", ["decode", ksFile, "KitchenSink"], {
        input: extBin,
      });
      const extCliShort = spawnSync(
        "capnp",
        ["decode", "--short", ksFile, "KitchenSink"],
        { input: extBin },
      );
      const extReader = DynamicStruct.fromMessage(
        Message.fromFlat(extBin),
        ksSchema,
      );
      expect(`${codecPretty.encode(extReader)}\n`).toBe(
        extCliPretty.stdout.toString("utf-8"),
      );
      expect(`${codecShort.encode(extReader)}\n`).toBe(
        extCliShort.stdout.toString("utf-8"),
      );

      // Unknown enum formatting differential check
      const unkBuilder = new MessageBuilder();
      const unkRoot = DynamicStruct.initRoot(unkBuilder, ksSchema);
      unkRoot.set(
        "priority",
        new DynamicEnum(ksLoader.resolve("Priority").asEnum(), 123),
      );
      const unkFlat = unkBuilder.toFlat();
      const unkCliShort = spawnSync(
        "capnp",
        ["decode", "--short", ksFile, "KitchenSink"],
        { input: unkFlat },
      );
      expect(`${codecShort.encode(unkRoot.asReader())}\n`).toBe(
        unkCliShort.stdout.toString("utf-8"),
      );

      // AnyPointer, AnyStruct, AnyList, Capability, List(Interface), and union disc-0 edges
      const tmpDir = mkdtempSync(join(tmpdir(), "capnp-text-edge-"));
      try {
        const edgePath = join(tmpDir, "edge.capnp");
        writeFileSync(
          edgePath,
          [
            "@0xabcdef0123456791;",
            "interface MyCap { ping @0 () -> (); }",
            "struct Sub { a @0 :Int32 = 5; b @1 :Text = \"hi\"; }",
            "struct Edge {",
            "  anyP @0 :AnyPointer;",
            "  anyS @1 :AnyStruct;",
            "  anyL @2 :AnyList;",
            "  cap @3 :MyCap;",
            "  anyCap @4 :Capability;",
            "  listCap @5 :List(MyCap);",
            "  uGrp :union { g :group { x @6 :Int32; } v @7 :Void; }",
            "  uVal :union { dflt @8 :Int32 = 42; other @9 :Text; }",
            "  uPtr :union { t @10 :Text = \"dflt\"; n @11 :Int32; }",
            "}",
          ].join("\n"),
        );
        const cgr = spawnSync("capnp", ["compile", "-o-", edgePath]);
        expect(cgr.status).toBe(0);
        const eLoader = SchemaLoader.fromCgr(new Uint8Array(cgr.stdout));
        const edgeSchema = eLoader.resolveStruct("Edge");
        const subSchema = eLoader.resolveStruct("Sub");
        const capSchema = eLoader.resolve("MyCap").asInterface();

        const b = new MessageBuilder();
        const r = DynamicStruct.initRoot(b, edgeSchema);
        const subMsg = new MessageBuilder();
        DynamicStruct.initRoot(subMsg, subSchema).set("a", 99);
        r.set("anyP", DynamicStruct.fromMessage(Message.fromFlat(subMsg.toFlat()), subSchema));
        r.set("anyS", DynamicStruct.fromMessage(Message.fromFlat(subMsg.toFlat()), subSchema));
        const listMsg = new MessageBuilder();
        const listRoot = listMsg.initRoot(0, 1);
        listRoot.initPrimList(0, 4, 2, 4, new Uint8Array([1, 0, 0, 0, 2, 0, 0, 0]));
        r.set("anyL", Message.fromFlat(listMsg.toFlat()).root().getP(0));
        r.init("listCap", 0);

        const edgeFlat = b.toFlat();
        const cliEdgePretty = spawnSync("capnp", ["decode", edgePath, "Edge"], {
          input: edgeFlat,
        });
        const cliEdgeShort = spawnSync("capnp", ["decode", "--short", edgePath, "Edge"], {
          input: edgeFlat,
        });
        expect(cliEdgePretty.status).toBe(0);
        expect(cliEdgeShort.status).toBe(0);

        const dynEdge = DynamicStruct.fromMessage(Message.fromFlat(edgeFlat), edgeSchema);
        expect(`${codecPretty.encode(dynEdge)}\n`).toBe(
          cliEdgePretty.stdout.toString("utf-8"),
        );
        expect(`${codecShort.encode(dynEdge)}\n`).toBe(
          cliEdgeShort.stdout.toString("utf-8"),
        );

        // Capability and List(MyCap) with non-null caps match C++ prettyPrint output
        r.set("cap", new DynamicCapability.Client(capSchema, 0));
        r.set("anyCap", new DynamicCapability.Client(capSchema, 1));
        const lc = r.init("listCap", 2).asList();
        lc.set(0, new DynamicCapability.Client(capSchema, 2));
        expect(codecShort.encode(r)).toBe(
          "(anyP = <opaque pointer>, anyS = <opaque pointer>, anyL = <opaque pointer>, cap = <external capability>, anyCap = <opaque pointer>, listCap = [<external capability>, <external capability>], uGrp = (g = (x = 0)), uVal = (dflt = 42), uPtr = ())",
        );
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});

describe("text input values follow capnp encode", () => {
  test("reports bad values, keeps going, and coerces a value to a struct's first field", () => {
    const loader = SchemaLoader.fromCgr(readGolden("dynamic-kitchen.cgr.bin"));
    const sinkSchema = loader.resolveStruct("KitchenSink");
    const decode = (src: string) => {
      const errors: TextInputError[] = [];
      const b = new MessageBuilder();
      const root = initDynamicRoot(b, sinkSchema);
      new TextCodec().decodeStruct(src, root, (e) => {
        errors.push(e);
      });
      const reader = DynamicStruct.fromMessage(Message.fromFlat(b.toFlat()), sinkSchema);
      return { text: stringify(reader), errors };
    };
    const defaults =
      "i32 = -100000, i64 = -9007199254740993, u8 = 200, u16 = 50000, u32 = 3000000000, " +
      "u64 = 9007199254740995, f32 = 1.5, f64 = -2.25, priority = normal";
    const groups = "meta = (revision = 1, nested = (ok = true, score = 0.5))";

    // Expected texts are `capnp encode | capnp decode --short` output.
    expect(decode('(i8 = 999, voids = [void, 1, void], tags = [5, (key = "k")], i16 = 7)')).toEqual({
      text:
        `(nothing = void, flag = false, flagDefaultTrue = true, i8 = 127, i16 = 7, ${defaults}, ` +
        `tags = [(code = -42), (key = "k", code = -42)], voids = [void, void, void], ${groups}, ` +
        "none = void, source = (unset = void))",
      errors: [
        { description: "6-9: Integer value out of range.", location: "(capnp text input):1" },
        { description: "26-27: Type mismatch; expected Void.", location: "(capnp text input):1" },
        { description: "44-45: Type mismatch; expected Tag.", location: "(capnp text input):1" },
      ],
    });
    expect(decode('(defaultTag = "x", tags = ["y"])')).toEqual({
      text:
        `(nothing = void, flag = false, flagDefaultTrue = true, i8 = -12, i16 = -3000, ${defaults}, ` +
        `defaultTag = (key = "x", code = -42), tags = [(key = "y", code = -42)], ${groups}, ` +
        "none = void, source = (unset = void))",
      errors: [],
    });
    expect(decode("(meta = 3,\n  nope = 1)").errors).toEqual([
      { description: "8-9: Type mismatch; expected group.", location: "(capnp text input):1" },
      { description: "3-7: Struct has no field named 'nope'.", location: "(capnp text input):2" },
    ]);
  });
});
