import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CapnpError,
  DynamicEnum,
  DynamicStruct,
  Message,
  MessageBuilder,
  SchemaLoader,
  TextCodec,
  canonicalize,
  canonicalizeFlat,
  decodeText,
  encodeText,
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
        f64 = +inf,
        title = "part1-" "part2-" \`raw line
        ,
        raw = 0x"de ad\nbe ef",
        priority = (77),
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
    expect(parsed.get("priority").asEnum().getRaw()).toBe(77);
    expect(parsed.get("priority").asEnum().getEnumerant()).toBeNull();
    expect(stringify(new DynamicEnum(prioSchema, 77))).toBe("(77)");

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

    // Rejections
    expect(() => decodeText("(unknownField = 1)", sinkSchema)).toThrow(
      CapnpError,
    );
    expect(() => decodeText("(none = void, note = \"both\")", sinkSchema)).toThrow(
      CapnpError,
    );
    expect(() => decodeText("(i8 = 999)", sinkSchema)).toThrow(CapnpError);
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
    },
  );
});
