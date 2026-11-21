import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DynamicStruct,
  Message,
  SchemaLoader,
  TextCodec,
  canonicalizeFlat,
  loadU32,
  unpack,
} from "../src/index.ts";
import {
  type WireFormat,
  formatNeedsSchema,
  runCli,
} from "../src/cli.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const goldenDir = join(here, "golden");
const cliBin = join(here, "..", "bin", "capnp-ts");
const hasCapnp = spawnSync("capnp", ["--version"]).status === 0;
const hasNode = spawnSync("node", ["--version"]).status === 0;

function readGolden(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(goldenDir, name)));
}

async function execCliInMemory(
  argv: string[],
  stdin: Uint8Array = new Uint8Array(0),
): Promise<{ code: number; stdout: Uint8Array; stderr: string }> {
  const chunks: Uint8Array[] = [];
  const errs: string[] = [];
  const code = await runCli(argv, {
    stdin,
    stdout: (c) => chunks.push(c),
    stderr: (m) => errs.push(m),
  });
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return { code, stdout: out, stderr: errs.join("\n") };
}

function execCapnp(
  argv: string[],
  stdin: Uint8Array = new Uint8Array(0),
): { code: number; stdout: Uint8Array; stderr: string } {
  const proc = spawnSync("capnp", argv, { input: Buffer.from(stdin) });
  return {
    code: proc.status ?? 1,
    stdout: new Uint8Array(proc.stdout ?? Buffer.alloc(0)),
    stderr: (proc.stderr ?? Buffer.alloc(0)).toString("utf8"),
  };
}

const ALL_FORMATS: readonly WireFormat[] = [
  "binary",
  "packed",
  "flat",
  "flat-packed",
  "canonical",
  "text",
  "json",
];

describe("capnp-ts CLI (encode, decode, convert, eval)", () => {
  test("converts AddressBook and KitchenSink across all 49 format pairs offline via CGR", async () => {
    const abCgr = join(goldenDir, "addressbook.cgr.bin");
    const abBin = readGolden("addressbook.bin");
    const abCanon = readGolden("addressbook.canonical.bin");

    // Precompute AddressBook in every format
    const byFormat = new Map<WireFormat, Uint8Array>();
    for (const fmt of ALL_FORMATS) {
      const res = await execCliInMemory(
        ["convert", `binary:${fmt}`, abCgr, "AddressBook"],
        abBin,
      );
      expect(res.code).toBe(0);
      byFormat.set(fmt, res.stdout);
    }

    expect(byFormat.get("canonical")).toEqual(abCanon);
    expect(byFormat.get("packed")).toEqual(readGolden("addressbook.packed.bin"));

    // Convert every format -> every other format and verify canonical equivalence
    for (const from of ALL_FORMATS) {
      for (const to of ALL_FORMATS) {
        const args = ["convert", `${from}:${to}`];
        if (formatNeedsSchema(from) || formatNeedsSchema(to)) {
          args.push(abCgr, "AddressBook");
        }
        const src = byFormat.get(from)!;
        const step = await execCliInMemory(args, src);
        expect(step.code).toBe(0);

        // Normalize `step.stdout` back to canonical to assert lossless round-trip
        const toCanonArgs = ["convert", `${to}:canonical`];
        if (formatNeedsSchema(to)) {
          toCanonArgs.push(abCgr, "AddressBook");
        }
        const check = await execCliInMemory(toCanonArgs, step.stdout);
        expect(check.code).toBe(0);
        expect(check.stdout).toEqual(abCanon);
      }
    }

    // Multi-segment --segment-size=8 round-trip on KitchenSink extreme
    const ksCgr = join(goldenDir, "dynamic-kitchen.cgr.bin");
    const ksBin = readGolden("dynamic-kitchen-extreme.bin");
    const ksCanon = canonicalizeFlat(ksBin);
    const multiSeg = await execCliInMemory(
      ["convert", "--segment-size=8", "binary:packed", ksCgr, "KitchenSink"],
      ksBin,
    );
    expect(multiSeg.code).toBe(0);
    const backToCanon = await execCliInMemory(
      ["convert", "packed:canonical"],
      multiSeg.stdout,
    );
    expect(backToCanon.code).toBe(0);
    expect(backToCanon.stdout).toEqual(ksCanon);

    // Reject non-canonical bytes when input format is canonical
    const nonCanon = new Uint8Array(16); // root null ptr + trailing unused zero word
    const badCanon = await execCliInMemory(
      ["convert", "canonical:binary"],
      nonCanon,
    );
    expect(badCanon.code).toBe(1);
  });

  test("evaluates constants, nested subscripts, and struct field defaults offline", async () => {
    const ksCgr = join(goldenDir, "dynamic-kitchen.cgr.bin");

    const magic = await execCliInMemory(["eval", ksCgr, "magicAnswer"]);
    expect(magic.code).toBe(0);
    expect(new TextDecoder().decode(magic.stdout)).toBe("9223372036854775807\n");

    const greet1 = await execCliInMemory(["eval", ksCgr, "greetingList[1]"]);
    expect(greet1.code).toBe(0);
    expect(new TextDecoder().decode(greet1.stdout)).toBe('"shalom"\n');

    const matElem = await execCliInMemory([
      "eval",
      ksCgr,
      "extremeConst.matrix[2][1]",
    ]);
    expect(matElem.code).toBe(0);
    expect(new TextDecoder().decode(matElem.stdout)).toBe("-2147483648\n");

    const fieldDefault = await execCliInMemory([
      "eval",
      "--short",
      ksCgr,
      "KitchenSink.defaultTag",
    ]);
    expect(fieldDefault.code).toBe(0);
    expect(new TextDecoder().decode(fieldDefault.stdout)).toBe(
      '(key = "preset", code = 99)\n',
    );

    const extCanon = await execCliInMemory([
      "eval",
      "-ocanonical",
      ksCgr,
      "extremeConst",
    ]);
    expect(extCanon.code).toBe(0);
    expect(extCanon.stdout).toEqual(
      canonicalizeFlat(readGolden("dynamic-kitchen-extreme.bin")),
    );

    // Errors: evaluating a struct type itself, out-of-bounds subscript, binary on scalar, invalid command flags
    expect((await execCliInMemory(["eval", ksCgr, "KitchenSink"])).code).toBe(1);
    expect((await execCliInMemory(["eval", ksCgr, "greetingList[9]"])).code).toBe(
      1,
    );
    expect(
      (await execCliInMemory(["eval", "-b", ksCgr, "magicAnswer"])).code,
    ).toBe(1);
    for (const badArgv of [
      ["encode", "--short", ksCgr, "KitchenSink"],
      ["encode", "--quiet", ksCgr, "KitchenSink"],
      ["encode", "--binary", ksCgr, "KitchenSink"],
      ["encode", "--flat", "--segment-size=4", ksCgr, "KitchenSink"],
      ["decode", "--segment-size=4", ksCgr, "KitchenSink"],
      ["decode", "--binary", ksCgr, "KitchenSink"],
      ["convert", "--packed", "binary:text", ksCgr, "KitchenSink"],
      ["convert", "--flat", "binary:text", ksCgr, "KitchenSink"],
      ["convert", "--binary", "binary:text", ksCgr, "KitchenSink"],
      ["eval", "--segment-size=4", ksCgr, "magicAnswer"],
      ["eval", "--quiet", ksCgr, "magicAnswer"],
      ["eval", "-b", "-p", ksCgr, "extremeConst"],
    ]) {
      expect((await execCliInMemory(badArgv)).code).toBe(1);
    }

    // --segment-size <n> uses fixed segment growth and preserves multi-segment packed framing
    const ksBin = readGolden("dynamic-kitchen-extreme.bin");
    const ksCanon = canonicalizeFlat(ksBin);
    const fixedSegBin = await execCliInMemory(
      ["convert", "--segment-size", "4", "binary:binary", ksCgr, "KitchenSink"],
      ksBin,
    );
    expect(fixedSegBin.code).toBe(0);
    const nSegs = loadU32(fixedSegBin.stdout, 0) + 1;
    expect(nSegs).toBeGreaterThan(4);
    const fixedSegPacked = await execCliInMemory(
      ["convert", "--segment-size", "4", "binary:packed", ksCgr, "KitchenSink"],
      ksBin,
    );
    expect(fixedSegPacked.code).toBe(0);
    const unpackedMulti = unpack(fixedSegPacked.stdout, { maxWords: 1_073_741_824 });
    expect(loadU32(unpackedMulti, 0) + 1).toBe(nSegs);
    expect(canonicalizeFlat(unpackedMulti)).toEqual(ksCanon);
  });

  test("handles multi-message encode/decode/convert streams and runs under Bun and Node", async () => {
    const ksCgr = join(goldenDir, "dynamic-kitchen.cgr.bin");
    const twoText = new TextEncoder().encode(
      '# first\n(title = "one", i32 = 10)\n# second\n(title = "two", i32 = 20)\n',
    );

    const encPacked = await execCliInMemory(
      ["encode", "--packed", ksCgr, "KitchenSink"],
      twoText,
    );
    expect(encPacked.code).toBe(0);

    const toJson = await execCliInMemory(
      ["convert", "--short", "packed:json", ksCgr, "KitchenSink"],
      encPacked.stdout,
    );
    expect(toJson.code).toBe(0);
    const jsonLines = new TextDecoder()
      .decode(toJson.stdout)
      .trim()
      .split("\n");
    expect(jsonLines.length).toBe(2);
    expect(jsonLines[0]).toContain('"title":"one"');
    expect(jsonLines[1]).toContain('"title":"two"');

    const backText = await execCliInMemory(
      ["convert", "--short", "json:text", ksCgr, "KitchenSink"],
      toJson.stdout,
    );
    expect(backText.code).toBe(0);
    const textLines = new TextDecoder()
      .decode(backText.stdout)
      .trim()
      .split("\n");
    expect(textLines.length).toBe(2);

    // Subprocess smoke under Bun
    const bunProc = spawnSync(
      "bun",
      [cliBin, "decode", "--short", join(goldenDir, "addressbook.cgr.bin"), "AddressBook"],
      { input: readGolden("addressbook.bin") },
    );
    expect(bunProc.status).toBe(0);
    expect(bunProc.stdout.toString("utf-8")).toContain('name = "Alice"');

    // Subprocess smoke under Node (when dist/cli.js is built)
    if (hasNode) {
      const buildRes = spawnSync("bun", ["run", "--filter", "@haozeke/capnp", "build"], {
        cwd: repoRoot,
      });
      expect(buildRes.status).toBe(0);
      const nodeProc = spawnSync(
        "node",
        [cliBin, "decode", "--short", join(goldenDir, "addressbook.cgr.bin"), "AddressBook"],
        { input: readGolden("addressbook.bin") },
      );
      expect(nodeProc.status).toBe(0);
      expect(nodeProc.stdout.toString("utf-8")).toBe(
        bunProc.stdout.toString("utf-8"),
      );
    }
  }, 60_000); // `capnp`, `bun`, and `node` exceed Bun's 5000 ms default on a slow CI runner.

  test.skipIf(!hasCapnp)(
    "text and JSON input are checked for plausibility like capnp unless convert --quiet",
    async () => {
      const schema = join(repoRoot, "schema/dynamic-kitchen.capnp");
      const latin1 = (text: string) => new Uint8Array(Buffer.from(text, "latin1"));
      const textCases: Array<[string, boolean]> = [
        ['\f(title = "a")', false],
        ['  \f# c\n(title = "a")', false],
        ['(\x01title = "a")', false],
        ['(title\x7f = "a")', false],
        ['(i32 = 1, \ftitle = "a")', false],
        ['(\ftitle = "a")', false],
        ['\xef\xbb\xbf(title = "a")', false],
        ["x", false],
        ['# \x80\n(title = "a")', true],
        ['\v\r\t\n(title = "a")', true],
        ['(title = "a\x01b", i32 = 1, \f)', true],
        [`(${" ".repeat(8191)}\x01title = "a")`, true],
      ];
      const jsonCases: Array<[string, boolean]> = [
        ['\f{"title":"a"}', false],
        ['\xef\xbb\xbf{"title":"a"}', false],
        ['\x00{"title":"a"}', false],
        ['{\x01"title":"a"}', false],
        ['{\x7f"title":"a"}', false],
        ['{\f"title":"a"}', false],
        ["x", false],
        ['{\x00"title":"a"}', true],
        ['\v{"title":"a"}', true],
        ['# c\n// d\n{"title":"a"}', true],
        ['/ x\n{"title":"a"}', true],
        ['{"title":"a\x01"}', true],
        [' \t\r\n{"title":"a"}', true],
        [`{${" ".repeat(8191)}\x01"title":"a"}`, true],
      ];
      const runs: Array<[string[], Array<[string, boolean]>, string, boolean]> = [
        [["encode", schema, "KitchenSink"], textCases, "text", true],
        [["convert", "text:binary", schema, "KitchenSink"], textCases, "text", true],
        [["convert", "--quiet", "text:binary", schema, "KitchenSink"], textCases, "text", false],
        [["convert", "json:binary", schema, "KitchenSink"], jsonCases, "json", true],
        [["convert", "--quiet", "json:binary", schema, "KitchenSink"], jsonCases, "json", false],
      ];
      for (const [args, cases, format, checked] of runs) {
        const sniff = `not in "${format}" format`;
        for (const [text, plausible] of cases) {
          const cpp = execCapnp(args, latin1(text));
          const ts = await execCliInMemory(args, latin1(text));
          const where = `${args.slice(0, -2).join(" ")} ${JSON.stringify(text)}`;
          expect([where, cpp.stderr.includes(sniff)]).toEqual([where, checked && !plausible]);
          expect([where, ts.stderr.includes(sniff)]).toEqual([where, checked && !plausible]);
          expect([where, ts.code]).toEqual([where, cpp.code]);
          expect([where, Buffer.from(ts.stdout).toString("hex")]).toEqual([
            where,
            Buffer.from(cpp.stdout).toString("hex"),
          ]);
        }
      }
    },
  );

  test.skipIf(!hasCapnp)(
    "text stdin preserves valid UTF-8 and raw invalid bytes",
    async () => {
      const schema = join(repoRoot, "schema/dynamic-kitchen.capnp");
      for (const bytes of [Uint8Array.of(0xc3, 0xa9), Uint8Array.of(0xff, 0x80, 0x61)]) {
        const input = new Uint8Array(12 + bytes.length);
        input.set(new TextEncoder().encode('(title = "'));
        input.set(bytes, 10);
        input.set(new TextEncoder().encode('")'), 10 + bytes.length);
        const args = ["encode", "--flat", schema, "KitchenSink"];
        const cpp = execCapnp(args, input);
        const ts = await execCliInMemory(args, input);
        expect(cpp.code).toBe(0);
        expect(ts.code).toBe(0);
        expect(ts.stdout).toEqual(cpp.stdout);
      }
    },
  );

  test.skipIf(!hasCapnp)("decode, convert and eval write raw Text bytes like capnp", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "capnp-cli-rawtext-"));
    try {
      const schema = join(tmpDir, "raw.capnp");
      writeFileSync(
        schema,
        [
          "@0xb1c2d3e4f5a69788;",
          "struct R { t @0 :Text; l @1 :List(Text); }",
          'const c :Text = "\\377\\200a";',
          'const s :R = (t = "\\377", l = ["\\300\\257", "ok", "\\357\\273\\277"]);',
        ].join("\n"),
      );
      for (const args of [
        ["eval", schema, "c"],
        ["eval", schema, "s"],
        ["eval", "--short", schema, "s"],
      ]) {
        const cpp = execCapnp(args);
        expect(cpp.code).toBe(0);
        expect(Buffer.from((await execCliInMemory(args)).stdout).toString("hex")).toBe(
          Buffer.from(cpp.stdout).toString("hex"),
        );
      }
      const bin = execCapnp(
        ["encode", schema, "R"],
        new TextEncoder().encode('(t = "a\\377b", l = ["\\355\\240\\200", "\\303\\251"])'),
      );
      expect(bin.code).toBe(0);
      for (const args of [
        ["decode", schema, "R"],
        ["decode", "--short", schema, "R"],
        ["convert", "binary:text", schema, "R"],
      ]) {
        const cpp = execCapnp(args, bin.stdout);
        expect(cpp.code).toBe(0);
        expect(Buffer.from((await execCliInMemory(args, bin.stdout)).stdout).toString("hex")).toBe(
          Buffer.from(cpp.stdout).toString("hex"),
        );
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test.skipIf(!hasCapnp)(
    "differential parity against official capnp encode, decode, convert, and eval",
    async () => {
      const abSchemaPath = join(repoRoot, "schema/addressbook.capnp");
      const ksSchemaPath = join(repoRoot, "schema/dynamic-kitchen.capnp");
      const abBin = readGolden("addressbook.bin");

      // 1. decode (pretty, --short, --packed, --flat) against capnp decode
      for (const extraFlags of [[], ["--short"]] as const) {
        const ref = spawnSync(
          "capnp",
          ["decode", ...extraFlags, abSchemaPath, "AddressBook"],
          { input: abBin },
        );
        const ours = await execCliInMemory(
          ["decode", ...extraFlags, abSchemaPath, "AddressBook"],
          abBin,
        );
        expect(ours.code).toBe(0);
        expect(new TextDecoder().decode(ours.stdout)).toBe(
          ref.stdout.toString("utf-8"),
        );
      }

      // 2. encode (binary, --packed, --flat) byte-for-byte against capnp encode on AddressBook
      const abText = spawnSync("capnp", ["decode", abSchemaPath, "AddressBook"], {
        input: abBin,
      }).stdout;
      for (const flag of [[], ["--packed"], ["--flat"]] as const) {
        const ref = spawnSync(
          "capnp",
          ["encode", ...flag, abSchemaPath, "AddressBook"],
          { input: abText },
        );
        const ours = await execCliInMemory(
          ["encode", ...flag, abSchemaPath, "AddressBook"],
          new Uint8Array(abText),
        );
        expect(ours.code).toBe(0);
        expect(ours.stdout).toEqual(new Uint8Array(ref.stdout));
      }

      // 3. convert text/json/packed/canonical/flat differential matrix on KitchenSink & JsonCustom
      for (const [typeName, textLiteral] of [
        [
          "KitchenSink",
          '(flag = true, i64 = -9223372036854775808, u64 = 18446744073709551615, f32 = nan, f64 = -inf, title = "cli", raw = 0x"007fff", priority = critical, matrix = [[1, -2], [], [3]], meta = (author = "Grace", nested = (ok = false, score = inf)), detail = (detailId = 5, detailName = "d"))',
        ],
        [
          "JsonCustom",
          '(renamedField = "rf", hexBlob = 0x"deadbeef", b64Blob = "hello", flatTag = (key = "tk", code = -8), prio = critical, flatVariant = (key = "vk", code = 4), boxedUnion = (num = 9007199254740993))',
        ],
      ] as const) {
        const txtBytes = new TextEncoder().encode(textLiteral);

        for (const outFmt of [
          "canonical",
          "text",
          "json",
        ] as const) {
          const ref = spawnSync(
            "capnp",
            ["convert", `text:${outFmt}`, ksSchemaPath, typeName],
            { input: txtBytes },
          );
          expect(ref.status).toBe(0);
          const ours = await execCliInMemory(
            ["convert", `text:${outFmt}`, ksSchemaPath, typeName],
            txtBytes,
          );
          expect(ours.code).toBe(0);
          expect(ours.stdout).toEqual(new Uint8Array(ref.stdout));
        }

        // JSON -> canonical byte-exact parity
        const jsonBytes = (
          await execCliInMemory(
            ["convert", "text:json", ksSchemaPath, typeName],
            txtBytes,
          )
        ).stdout;
        const refJsonCanon = spawnSync(
          "capnp",
          ["convert", "json:canonical", ksSchemaPath, typeName],
          { input: jsonBytes },
        );
        expect(refJsonCanon.status).toBe(0);
        const oursJsonCanon = await execCliInMemory(
          ["convert", "json:canonical", ksSchemaPath, typeName],
          jsonBytes,
        );
        expect(oursJsonCanon.code).toBe(0);
        expect(oursJsonCanon.stdout).toEqual(new Uint8Array(refJsonCanon.stdout));
      }

      // 4. Multi-message packed stream parity
      const multiText = new TextEncoder().encode(
        '(people = [(id = 1, name = "A")])\n(people = [(id = 2, name = "B")])\n',
      );
      const refMultiPacked = spawnSync(
        "capnp",
        ["convert", "text:packed", abSchemaPath, "AddressBook"],
        { input: multiText },
      );
      const oursMultiPacked = await execCliInMemory(
        ["convert", "text:packed", abSchemaPath, "AddressBook"],
        multiText,
      );
      expect(oursMultiPacked.code).toBe(0);
      expect(oursMultiPacked.stdout).toEqual(new Uint8Array(refMultiPacked.stdout));

      const refMultiJson = spawnSync(
        "capnp",
        ["convert", "--short", "packed:json", abSchemaPath, "AddressBook"],
        { input: oursMultiPacked.stdout },
      );
      const oursMultiJson = await execCliInMemory(
        ["convert", "--short", "packed:json", abSchemaPath, "AddressBook"],
        oursMultiPacked.stdout,
      );
      expect(oursMultiJson.code).toBe(0);
      expect(new TextDecoder().decode(oursMultiJson.stdout)).toBe(
        refMultiJson.stdout.toString("utf-8"),
      );

      // 5. eval differential parity across expressions and output formats
      for (const [extraFlags, expr] of [
        [[], "extremeConst"],
        [["--short"], "extremeConst"],
        [["-ojson"], "extremeConst"],
        [["--short", "-ojson"], "extremeConst"],
        [["-ocanonical"], "extremeConst"],
        [[], "magicAnswer"],
        [[], "greetingList"],
        [["--short"], "greetingList"],
        [[], "greetingList[2]"],
        [[], "extremeConst.matrix[0][1]"],
        [[], "KitchenSink.defaultTag"],
        [[], "KitchenSink.i64"],
        [[], "KitchenSink.meta"],
        [[], "KitchenSink.meta.author"],
        [[], "KitchenSink.meta.nested.score"],
        [[], "KitchenSink.none"],
      ] as const) {
        const ref = spawnSync(
          "capnp",
          ["eval", ...extraFlags, ksSchemaPath, expr],
          { encoding: null },
        );
        expect(ref.status).toBe(0);
        const ours = await execCliInMemory([
          "eval",
          ...extraFlags,
          ksSchemaPath,
          expr,
        ]);
        expect(ours.code).toBe(0);
        expect(ours.stdout).toEqual(new Uint8Array(ref.stdout));
      }
    },
  );
});

describe("CLI empty input, multi-message flat, and eval annotations", () => {
  const abSchemaPath = join(repoRoot, "schema/addressbook.capnp");

  test.skipIf(!hasCapnp)(
    "empty stdin is Premature EOF unless --quiet",
    async () => {
      const cases: string[][] = [
        ["encode", abSchemaPath, "AddressBook"],
        ["decode", abSchemaPath, "AddressBook"],
        ["convert", "binary:flat", abSchemaPath, "AddressBook"],
        ["convert", "text:canonical", abSchemaPath, "AddressBook"],
      ];
      for (const args of cases) {
        const ref = execCapnp(args);
        const ours = await execCliInMemory(args);
        expect(ref.code).toBe(1);
        expect(ours.code).toBe(ref.code);
        expect(ours.stdout).toEqual(ref.stdout);
        expect(ref.stderr).toContain("Premature EOF");
        expect(ours.stderr).toContain("Premature EOF");
      }

      for (const args of [
        ["decode", "--quiet", abSchemaPath, "AddressBook"],
        ["convert", "--quiet", "binary:flat", abSchemaPath, "AddressBook"],
        ["convert", "--quiet", "text:json", abSchemaPath, "AddressBook"],
      ]) {
        const ref = execCapnp(args);
        const ours = await execCliInMemory(args);
        expect(ref.code).toBe(0);
        expect(ours.code).toBe(0);
        expect(ours.stdout).toEqual(ref.stdout);
        expect(ours.stdout.byteLength).toBe(0);
      }
    },
  );

  test.skipIf(!hasCapnp)(
    "stdin with only whitespace or comments fails like capnp, even with --quiet",
    async () => {
      const text = [" ", "\n", " \r\n\t\v", "# c\n", " # c\n # d", "#"];
      const json = [...text, "// c\n", " // c", "# a\n// b\n"];
      const cases: Array<[string[], string[]]> = [
        [["encode", abSchemaPath, "AddressBook"], text],
        [["convert", "text:binary", abSchemaPath, "AddressBook"], text],
        [["convert", "--quiet", "text:binary", abSchemaPath, "AddressBook"], text],
        [["convert", "json:binary", abSchemaPath, "AddressBook"], json],
        [["convert", "--quiet", "json:binary", abSchemaPath, "AddressBook"], json],
      ];
      for (const [args, inputs] of cases) {
        for (const input of inputs) {
          const stdin = new TextEncoder().encode(input);
          const ref = execCapnp(args, stdin);
          const ours = await execCliInMemory(args, stdin);
          expect({ input, args, code: ref.code, out: ref.stdout.byteLength }).toEqual({
            input,
            args,
            code: 1,
            out: 0,
          });
          expect({ input, args, code: ours.code, out: ours.stdout.byteLength }).toEqual({
            input,
            args,
            code: 1,
            out: 0,
          });
        }
      }
    },
  );

  test.skipIf(!hasCapnp)(
    "multi-message flat, canonical, and flat-packed streams match capnp",
    async () => {
      const one = readGolden("addressbook.bin");
      const two = new Uint8Array(one.byteLength * 2);
      two.set(one, 0);
      two.set(one, one.byteLength);
      for (const spec of ["binary:flat", "binary:canonical", "binary:flat-packed", "text:flat"]) {
        const input =
          spec === "text:flat"
            ? (() => {
                const text = execCapnp(
                  ["convert", "binary:text", abSchemaPath, "AddressBook"],
                  one,
                );
                expect(text.code).toBe(0);
                const both = new Uint8Array(text.stdout.byteLength * 2);
                both.set(text.stdout, 0);
                both.set(text.stdout, text.stdout.byteLength);
                return both;
              })()
            : two;
        const from = spec === "text:flat" ? "text:flat" : spec;
        const args = ["convert", from, abSchemaPath, "AddressBook"];
        const ref = execCapnp(args, input);
        const ours = await execCliInMemory(args, input);
        expect(ref.code).toBe(0);
        expect(ours.code).toBe(0);
        expect(ours.stdout).toEqual(ref.stdout);
        expect(ours.stdout.byteLength).toBeGreaterThan(one.byteLength);
      }
    },
  );

  test.skipIf(!hasCapnp)(
    "eval -ojson drops annotations and convert applies them",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "capnp-ann-"));
      const importRoot = join(dir, "imports");
      mkdirSync(join(importRoot, "capnp", "compat"), { recursive: true });
      // Distro capnproto 1.1.0 ships no standard schemas. `capnp eval` drops
      // annotations and still exits 0, but `capnp compile` and `capnp convert`
      // need /capnp/compat/json.capnp. This CLI compiles. Give both tools the
      // same import root, with the annotation ids the JSON codec looks up, so
      // the comparison does not depend on the distro layout.
      writeFileSync(
        join(importRoot, "capnp", "c++.capnp"),
        `@0xbdf87d7bb8304e81;
annotation namespace(file): Text;
`,
      );
      writeFileSync(
        join(importRoot, "capnp", "compat", "json.capnp"),
        `@0x8ef99297a43a5e34;
$import "/capnp/c++.capnp".namespace("capnp::json");
annotation name @0xfa5b1fd61c2e7c3d (field, enumerant, method, group, union) :Text;
annotation hex @0xf061e22f0ae5c7b5 (field) :Void;
`,
      );
      const schemaPath = join(dir, "ann.capnp");
      writeFileSync(
        schemaPath,
        `@0x8a1b2c3d4e5f6071;
using Json = import "/capnp/compat/json.capnp";
struct Box {
  renamed @0 :Text $Json.name("renamed_field");
  blob @1 :Data $Json.hex;
}
const sample :Box = (renamed = "hi", blob = 0x"dead");
`,
      );
      const withImport = (args: string[]): string[] => [`-I${importRoot}`, ...args];
      try {
        const text = new TextEncoder().encode(
          '(renamed = "hi", blob = 0x"dead")\n',
        );
        const cases: { args: string[]; stdin?: Uint8Array }[] = [
          { args: withImport(["eval", "-ojson", schemaPath, "sample"]) },
          { args: withImport(["eval", "--short", "-ojson", schemaPath, "sample"]) },
          {
            args: withImport(["convert", "text:json", schemaPath, "Box"]),
            stdin: text,
          },
          {
            args: withImport(["convert", "--short", "text:json", schemaPath, "Box"]),
            stdin: text,
          },
        ];
        for (const c of cases) {
          const ref = execCapnp(c.args, c.stdin);
          const ours = await execCliInMemory(c.args, c.stdin);
          expect(ref.code).toBe(0);
          expect(ours.code).toBe(0);
          expect(ours.stdout).toEqual(ref.stdout);
        }
        const evalJson = new TextDecoder().decode(
          (await execCliInMemory(withImport(["eval", "-ojson", schemaPath, "sample"])))
            .stdout,
        );
        const convertJson = new TextDecoder().decode(
          (
            await execCliInMemory(
              withImport(["convert", "text:json", schemaPath, "Box"]),
              text,
            )
          ).stdout,
        );
        expect(evalJson).toContain('"renamed"');
        expect(evalJson).not.toContain("renamed_field");
        expect(convertJson).toContain("renamed_field");
        expect(convertJson).toContain('"dead"');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("CLI options and invalid text input follow capnp", () => {
  const usage = (program: string, message: string) =>
    `${program}: ${message}\nTry '${program} --help' for more information.`;
  const kitchen = join(repoRoot, "schema/dynamic-kitchen.capnp");

  test("rejects -h, -q, -v and other bad options with capnp's usage errors", async () => {
    const cases: Array<[string[], string]> = [
      [["-h"], usage("capnp-ts", "-h: unrecognized option")],
      [["-q"], usage("capnp-ts", "-q: unrecognized option")],
      [["-v"], usage("capnp-ts", "-v: unrecognized option")],
      [["-hqv"], usage("capnp-ts", "-h: unrecognized option")],
      [["-qv", "encode", kitchen, "KitchenSink"], usage("capnp-ts", "-q: unrecognized option")],
      [["encode", "-h", kitchen, "KitchenSink"], usage("capnp-ts encode", "-h: unrecognized option")],
      [["encode", "-q", kitchen, "KitchenSink"], usage("capnp-ts encode", "-q: unrecognized option")],
      [["decode", "-v", kitchen, "KitchenSink"], usage("capnp-ts decode", "-v: unrecognized option")],
      [["decode", "-pq", kitchen, "KitchenSink"], usage("capnp-ts decode", "-q: unrecognized option")],
      [["convert", "binary:text", "-h"], usage("capnp-ts convert", "-h: unrecognized option")],
      [["eval", "-v", kitchen, "magicAnswer"], usage("capnp-ts eval", "-v: unrecognized option")],
      [["--flat", "encode", kitchen, "KitchenSink"], usage("capnp-ts", "--flat: unrecognized option")],
      [["encode", "--help=1"], usage("capnp-ts encode", "--help: unrecognized option")],
      [["encode", "--flat=1"], usage("capnp-ts encode", "--flat: option does not accept an argument")],
      [["encode", "-I"], usage("capnp-ts encode", "-I: missing argument")],
      [["eval", "-bo"], usage("capnp-ts eval", "-o: missing argument")],
      [["eval", "-oxx"], usage("capnp-ts eval", "-o xx: unknown format: xx")],
      [["eval", "-p", "-b"], usage("capnp-ts eval", "-b: cannot be used with --packed")],
      [
        ["encode", "--flat", "--segment-size", "4"],
        usage("capnp-ts encode", "--segment-size=4: cannot be used with --flat"),
      ],
      [["convert", "--segment-size=08"], usage("capnp-ts convert", "--segment-size=08: not an integer")],
      [[], usage("capnp-ts", "missing command")],
      [["foo"], usage("capnp-ts", "foo: unknown command")],
      [["encode", kitchen], usage("capnp-ts encode", "missing argument <type>")],
      [["decode", kitchen, "KitchenSink", "x"], usage("capnp-ts decode", "x: too many arguments")],
    ];
    for (const [argv, stderr] of cases) {
      const ts = await execCliInMemory(argv);
      expect([argv, ts.code, ts.stdout.byteLength, ts.stderr]).toEqual([argv, 1, 0, stderr]);
      if (hasCapnp) {
        const cpp = execCapnp(argv);
        expect([argv, cpp.code, cpp.stdout.byteLength, cpp.stderr]).toEqual([
          argv,
          1,
          0,
          `${stderr.replaceAll("capnp-ts", "capnp")}\n`,
        ]);
      }
    }

    const text = new TextEncoder().encode("(i8 = 5)");
    for (const argv of [
      ["encode", "--segment-size=4", "--flat", kitchen, "KitchenSink"],
      ["encode", "--segment-size=0x400", kitchen, "KitchenSink"],
      ["--verbose", "encode", "--verbose", kitchen, "KitchenSink"],
      ["encode", "-pI", repoRoot, kitchen, "KitchenSink"],
    ]) {
      const ts = await execCliInMemory(argv, text);
      expect([argv, ts.code, ts.stderr]).toEqual([argv, 0, ""]);
      if (hasCapnp) {
        const cpp = execCapnp(argv, text);
        expect([argv, cpp.code]).toEqual([argv, 0]);
        expect([argv, Buffer.from(ts.stdout).toString("hex")]).toEqual([
          argv,
          Buffer.from(cpp.stdout).toString("hex"),
        ]);
      }
    }
  });

  test("writes each text message and then capnp's error block for a bad value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capnp-ts-text-errors-"));
    try {
      const schema = join(dir, "v.capnp");
      writeFileSync(schema, "@0xe1a2b3c4d5e6f701;\nstruct V { values @0 :List(Void); }\n");
      const block = (description: string) =>
        [
          "*** ERROR CONVERTING PREVIOUS MESSAGE ***",
          "The following error occurred while converting the message above.",
          "This probably means the input data is invalid/corrupted.",
          `Exception description: ${description}`,
          "Code location: (capnp text input):1",
          "*** END ERROR ***",
        ].join("\n");
      const cases: Array<[string, string, string]> = [
        [
          "(values = [void, 1, void])",
          "00000000000001000100000018000000",
          block("17-18: Type mismatch; expected Void."),
        ],
        [
          "(values = [1])\n(values = [void])",
          "0000000000000100010000000800000000000000000001000100000008000000",
          block("11-12: Type mismatch; expected Void."),
        ],
      ];
      for (const [input, hex, stderr] of cases) {
        const argv = ["encode", "--flat", schema, "V"];
        const stdin = new TextEncoder().encode(input);
        const ts = await execCliInMemory(argv, stdin);
        expect([input, ts.code, Buffer.from(ts.stdout).toString("hex"), ts.stderr]).toEqual([
          input,
          1,
          hex,
          stderr,
        ]);
        if (hasCapnp) {
          const cpp = execCapnp(argv, stdin);
          expect([input, cpp.code, Buffer.from(cpp.stdout).toString("hex"), cpp.stderr]).toEqual([
            input,
            1,
            hex,
            `${stderr}\n`,
          ]);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!hasCapnp)(
    "keeps converting after a bad text value, with the bytes and errors of capnp",
    async () => {
      const recoverable = [
        "(meta = 3)",
        "(meta = (revision = 2, nested = 1))",
        "(source = 1)",
        "(i8 = 999)",
        "(u8 = -1)",
        "(i64 = -9223372036854775809)",
        "(u64 = 18446744073709551617)",
        "(f64 = -0)",
        "(voids = [void, 1, void])",
        "(tags = [5, (key = \"k\")])",
        "(matrix = [[1], 2, [3]])",
        "(flags = [true, 1])",
        "(priorities = [high, 1])",
        "(nope = 1, i8 = 2)",
        "(5, i8 = 2)",
        "(none = void, note = \"both\")",
        "(i8 = 1)(i8 = 999)(i8 = 3)",
        "(i8 = 1)\n(nope = 1)\n(i8 = 3)",
      ];
      const fatal = ["(i8 = 1)(priority = blue)(i8 = 3)", "(i8 = 1)(i8 = 2) junk"];
      const args = ["encode", kitchen, "KitchenSink"];
      for (const input of [...recoverable, ...fatal]) {
        const stdin = new TextEncoder().encode(input);
        const cpp = execCapnp(args, stdin);
        const ts = await execCliInMemory(args, stdin);
        expect([input, ts.code, Buffer.from(ts.stdout).toString("hex")]).toEqual([
          input,
          cpp.code,
          Buffer.from(cpp.stdout).toString("hex"),
        ]);
        // A fatal error makes capnp print a stack trace, so only compare the rest.
        if (recoverable.includes(input)) {
          expect([input, ts.stderr === "" ? "" : `${ts.stderr}\n`]).toEqual([input, cpp.stderr]);
        }
      }
    },
  );
});

describe("eval -o json goldens from capnp 1.4.0", () => {
  const unionCgr = join(goldenDir, "eval-unions.cgr.bin");
  const ksCgr = join(goldenDir, "dynamic-kitchen.cgr.bin");
  const cases: [string, string][] = [
    [ksCgr, "extremeConst"],
    ...[
      "emptyDefault",
      "unsetArms",
      "numArm",
      "tagArm",
      "groupArm",
      "voidArm",
      "nested",
      "custom",
      "customFlat",
      "customEmpty",
    ].map((c): [string, string] => [unionCgr, c]),
  ];

  for (const [cgr, name] of cases) {
    for (const short of [false, true]) {
      test(`${name}${short ? " --short" : ""} matches byte for byte`, async () => {
        const argv = ["eval", ...(short ? ["--short"] : []), "-ojson", cgr, name];
        const ours = await execCliInMemory(argv);
        expect(ours.code).toBe(0);
        const golden = readGolden(`eval-json/${name}${short ? ".short" : ""}.json`);
        expect(new TextDecoder().decode(ours.stdout)).toBe(new TextDecoder().decode(golden));
        expect(ours.stdout).toEqual(golden);
      });
    }
  }
});

describe("input plausibility like capnp 1.4.0", () => {
  const abCgr = join(goldenDir, "addressbook.cgr.bin");
  const bytes = (...b: number[]) => Uint8Array.from(b);
  const emptyRoot = bytes(0, 0, 0, 0, 1, 0, 0, 0, 0xfc, 0xff, 0xff, 0xff, 0, 0, 0, 0);
  const wrongTypeFlat = bytes(0, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  const typeWarning =
    "*** WARNING ***\n" +
    "The input data does not appear to be the type that you specified.  I'll try\n" +
    "to parse it anyway, but if it doesn't look right, please verify that you\n" +
    "have the right type.  Use --quiet to suppress this warning.\n" +
    "*** END WARNING ***";

  test("rejects a binary empty-struct root and suggests flat", async () => {
    const r = await execCliInMemory(["convert", "binary:json", abCgr, "AddressBook"], emptyRoot);
    expect(r.code).toBe(1);
    expect(r.stdout.byteLength).toBe(0);
    expect(r.stderr).toBe(
      `capnp-ts convert: The input is not in "binary" format. It looks like it is in "flat" format. Try that instead.\nTry 'capnp-ts convert --help' for more information.`,
    );
  });

  test("--quiet skips the check", async () => {
    const r = await execCliInMemory(["decode", "--quiet", abCgr, "AddressBook"], emptyRoot);
    expect(r.code).toBe(0);
    expect(new TextDecoder().decode(r.stdout)).toBe("()\n");
  });

  test("text input names the format it resembles", async () => {
    const r = await execCliInMemory(
      ["convert", "text:binary", abCgr, "AddressBook"],
      new TextEncoder().encode("hello"),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      `capnp-ts convert: The input is not in "text" format. It looks like it is in "binary" format. Try that instead.\nTry 'capnp-ts convert --help' for more information.`,
    );
  });

  test("a zero byte literal in packed input is impossible", async () => {
    const r = await execCliInMemory(
      ["convert", "flat-packed:text", abCgr, "AddressBook"],
      bytes(1, 0, 0, 0, 0, 0, 0, 0),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      `capnp-ts convert: The input is not in "flat-packed" format. It looks like it is in "binary" format. Try that instead.\nTry 'capnp-ts convert --help' for more information.`,
    );
  });

  test("a root of the wrong size warns and still converts", async () => {
    const r = await execCliInMemory(["convert", "flat:text", abCgr, "AddressBook"], wrongTypeFlat);
    expect(r.code).toBe(0);
    expect(new TextDecoder().decode(r.stdout)).toBe("()\n");
    expect(r.stderr).toBe(typeWarning);
  });

  test("an implausible flat root warns before the read fails", async () => {
    const r = await execCliInMemory(
      ["convert", "flat:json", abCgr, "AddressBook"],
      bytes(0, 0, 0, 0, 0, 8, 1, 0),
    );
    expect(r.code).toBe(1);
    expect(r.stderr.split("\n").slice(0, 6).join("\n")).toBe(
      "*** WARNING ***\n" +
        'The input data does not appear to be in "flat" format. It\n' +
        'looks like it may be in "binary" format. I\'ll try to parse\n' +
        'it in "flat" format as you requested, but if it doesn\'t work,\n' +
        'try "flat" instead. Use --quiet to suppress this warning.\n' +
        "*** END WARNING ***",
    );
  });

  test.skipIf(!hasCapnp)("matches live capnp on stdout and exit code", async () => {
    const schemaPath = join(repoRoot, "schema", "addressbook.capnp");
    const cases: [string[], Uint8Array][] = [
      [["convert", "binary:json"], emptyRoot],
      [["decode", "--quiet"], emptyRoot],
      [["convert", "flat:text"], wrongTypeFlat],
      [["convert", "text:binary"], new TextEncoder().encode("hello")],
      [["convert", "flat-packed:text"], bytes(1, 0, 0, 0, 0, 0, 0, 0)],
    ];
    for (const [args, input] of cases) {
      const live = execCapnp([...args, schemaPath, "AddressBook"], input);
      const ours = await execCliInMemory([...args, abCgr, "AddressBook"], input);
      expect({ args, code: ours.code, stdout: [...ours.stdout] }).toEqual({
        args,
        code: live.code,
        stdout: [...live.stdout],
      });
    }
  });
});

describe("text output of corrupt AnyPointer fields", () => {
  const ksCgr = join(goldenDir, "dynamic-kitchen.cgr.bin");
  // `Envelope.payload` points 320 words past the segment and the second
  // `items` entry claims 768 pointers.
  const input = Uint8Array.from([
    0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0,
    1, 0, 0, 0, 0x17, 0, 0, 0, 8, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3,
  ]);
  const expected =
    "( payload = <opaque pointer>,\n" +
    "  items = [\n" +
    "    (),\n" +
    "    (value = <opaque pointer>) ] )\n";

  test("prints <opaque pointer> without following the pointer", async () => {
    const r = await execCliInMemory(["decode", ksCgr, "Envelope"], input);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(new TextDecoder().decode(r.stdout)).toBe(expected);
  });

  test.skipIf(!hasCapnp)("matches live capnp", () => {
    const live = execCapnp(
      ["decode", join(repoRoot, "schema", "dynamic-kitchen.capnp"), "Envelope"],
      input,
    );
    expect(live.code).toBe(0);
    expect(new TextDecoder().decode(live.stdout)).toBe(expected);
  });
});

describe("pointer null checks like capnp 1.4.0", () => {
  const ksCgr = join(goldenDir, "dynamic-kitchen.cgr.bin");
  const outOfBounds =
    "This usually indicates that the input data was corrupted, used a different encoding " +
    "than specified (e.g. packed vs. non-packed), or was not a Cap'n Proto message to begin " +
    "with. Note that this error is NOT due to a schema mismatch; the input is invalid " +
    "regardless of schema.";

  // An `Envelope` root whose `payload` pointer word is `payload`; word 4 can
  // serve as a far pointer landing pad.
  function envelope(payload: bigint, pad = 0n): Uint8Array {
    const words = [0x0003000000000000n, 0n, payload, 0n, pad, 0n];
    const out = new Uint8Array(8 + words.length * 8);
    const view = new DataView(out.buffer);
    view.setUint32(4, words.length, true);
    words.forEach((w, i) => view.setBigUint64(8 + i * 8, w, true));
    return out;
  }

  const recovered: [string, Uint8Array, string, number][] = [
    [
      "an unknown other pointer",
      envelope(0x67n),
      "expected ptr->isCapability(); unknown pointer type",
      2779,
    ],
    [
      "a far pointer to an unknown segment",
      envelope(0x500000002n),
      "expected segment != nullptr [0 != nullptr]; Message contains far pointer to unknown segment.",
      580,
    ],
    [
      "an out-of-bounds far pointer",
      envelope(0x1f42n),
      `expected boundsCheck(segment, ptr, padWords); Message contains out-of-bounds far pointer. ${outOfBounds}`,
      587,
    ],
    [
      "a double-far pad in an unknown segment",
      envelope(0x26n, 0x500000002n),
      "expected newSegment != nullptr [0 != nullptr]; Message contains double-far pointer to unknown segment.",
      606,
    ],
    [
      "a double-far pad that is no far pointer",
      envelope(0x26n),
      "expected pad->kind() == WirePointer::FAR [0 == 2]; Second word of double-far pad must be far pointer.",
      610,
    ],
    ["a far pointer landing on a far pointer", envelope(0x12n), "far pointer not followed?", 2773],
  ];

  for (const [name, input, description, line] of recovered) {
    test(`${name} prints as null, then reports the error`, async () => {
      const r = await execCliInMemory(["convert", "binary:text", ksCgr, "Envelope"], input);
      expect(r.code).toBe(1);
      expect(new TextDecoder().decode(r.stdout)).toBe("()\n");
      expect(r.stderr).toBe(
        "*** ERROR CONVERTING PREVIOUS MESSAGE ***\n" +
          "The following error occurred while converting the message above.\n" +
          "This probably means the input data is invalid/corrupted.\n" +
          `Exception description: ${description}\n` +
          `Code location: capnp/layout.c++:${line}\n` +
          "*** END ERROR ***",
      );
    });
  }

  for (const [name, input] of [
    ["a capability", envelope(3n)],
    ["a far pointer landing on a zero word", envelope(0x22n)],
  ] as [string, Uint8Array][]) {
    test(`${name} is not null`, async () => {
      const r = await execCliInMemory(["convert", "binary:text", ksCgr, "Envelope"], input);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(new TextDecoder().decode(r.stdout)).toBe("( payload = <opaque pointer> )\n");
    });
  }

  test("a reader without a handler throws", () => {
    const msg = Message.fromFlat(envelope(0x67n));
    expect(() => msg.root().isNullP(1)).toThrow("unknown pointer type");
  });

  test.skipIf(!hasCapnp)("matches live capnp", async () => {
    const schemaPath = join(repoRoot, "schema", "dynamic-kitchen.capnp");
    const inputs = [...recovered.map((c) => c[1]), envelope(3n), envelope(0x22n)];
    for (const to of ["text", "json"]) {
      for (const input of inputs) {
        const live = execCapnp(["convert", `binary:${to}`, schemaPath, "Envelope"], input);
        const ours = await execCliInMemory(["convert", `binary:${to}`, ksCgr, "Envelope"], input);
        expect({ to, code: ours.code, stdout: [...ours.stdout] }).toEqual({
          to,
          code: live.code,
          stdout: [...live.stdout],
        });
        if (live.stderr.startsWith("*** ERROR CONVERTING")) {
          expect(`${ours.stderr}\n`).toBe(live.stderr);
        }
      }
    }
  });
});

describe("capabilities without a capability context like capnp 1.4.0", () => {
  const capCgr = join(goldenDir, "capability-fields.cgr.bin");
  const noContext =
    "capnp-ts: expected brokenCapFactory != nullptr [0 != nullptr]; Trying to read capabilities " +
    "without ever having created a capability context.  To read capabilities from a message, " +
    "you must imbue it with CapReaderContext, or use the Cap'n Proto RPC system.";

  // A `CapHolder` root with the given pointer words; word 5 is spare.
  function holder(ptrs: bigint[], spare = 0n): Uint8Array {
    const words = [0x0004000000000000n, ...ptrs, spare];
    const out = new Uint8Array(8 + words.length * 8);
    const view = new DataView(out.buffer);
    view.setUint32(4, words.length, true);
    words.forEach((w, i) => view.setBigUint64(8 + i * 8, w, true));
    return out;
  }
  const capField = holder([0n, 3n, 0n, 0n]);
  const capList = holder([0n, 0n, 0x0000000e00000005n, 0n], 3n);
  const capabilityField = holder([0n, 0n, 0n, 3n]);

  for (const [name, input] of [
    ["an interface field", capField],
    ["a list of interfaces", capList],
  ] as [string, Uint8Array][]) {
    test(`decode fails on ${name}`, async () => {
      const r = await execCliInMemory(["decode", capCgr, "CapHolder"], input);
      expect(r.code).toBe(1);
      expect(r.stdout.byteLength).toBe(0);
      expect(r.stderr).toBe(noContext);
    });
  }

  test("a `Capability` field still prints as an opaque pointer", async () => {
    const r = await execCliInMemory(["decode", capCgr, "CapHolder"], capabilityField);
    expect(r.code).toBe(0);
    expect(new TextDecoder().decode(r.stdout)).toBe("(any = <opaque pointer>)\n");
  });

  test("eval of an interface field fails", async () => {
    for (const short of [[], ["--short"]]) {
      const r = await execCliInMemory(["eval", ...short, capCgr, "CapHolder.ping"]);
      expect(r.code).toBe(1);
      expect(r.stdout.byteLength).toBe(0);
      expect(r.stderr).toBe(noContext);
    }
  });

  test("TextCodec prints capabilities by default", () => {
    const schema = SchemaLoader.fromCgr(readGolden("capability-fields.cgr.bin")).resolveStruct("CapHolder");
    const reader = DynamicStruct.fromMessage(Message.fromFlat(capField), schema);
    expect(new TextCodec().encode(reader)).toBe("(ping = <external capability>)");
  });

  test.skipIf(!hasCapnp)("matches live capnp", async () => {
    const schemaPath = join(repoRoot, "schema", "capability-fields.capnp");
    for (const input of [capField, capList, capabilityField]) {
      const live = execCapnp(["decode", schemaPath, "CapHolder"], input);
      const ours = await execCliInMemory(["decode", capCgr, "CapHolder"], input);
      expect({ code: ours.code, stdout: [...ours.stdout] }).toEqual({
        code: live.code,
        stdout: [...live.stdout],
      });
    }
    const live = execCapnp(["eval", schemaPath, "CapHolder.ping"]);
    expect(live.code).toBe(1);
    expect(live.stderr).toContain(noContext.slice("capnp-ts: ".length));
  });
});

describe("read limits lifted like the capnp tool", () => {
  const ksCgr = join(goldenDir, "dynamic-kitchen.cgr.bin");
  const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

  // `KitchenSink.voids` claims 400 million elements in a 10-word message.
  async function amplifiedVoids(): Promise<Uint8Array> {
    const enc = await execCliInMemory(
      ["encode", ksCgr, "KitchenSink"],
      new TextEncoder().encode("(voids = [void])"),
    );
    const msg = enc.stdout.slice();
    const view = new DataView(msg.buffer);
    for (let at = 8; at + 8 <= msg.byteLength; at += 8) {
      if ((view.getUint32(at, true) & 3) === 1 && view.getUint32(at + 4, true) === 1 << 3) {
        view.setUint32(at + 4, (400_000_000 << 3) >>> 0, true);
      }
    }
    return msg;
  }

  // `Envelope.payload` holds a chain of 300 single-pointer structs.
  function deepEnvelope(): Uint8Array {
    const words = [0x0003000000000000n, 0n, 0x0001000000000004n, 0n];
    for (let i = 0; i < 300; i++) words.push(i < 299 ? 0x0001000000000000n : 0n);
    const out = new Uint8Array(8 + words.length * 8);
    const view = new DataView(out.buffer);
    view.setUint32(4, words.length, true);
    words.forEach((w, i) => view.setBigUint64(8 + i * 8, w, true));
    return out;
  }

  const cases: [string, () => Promise<Uint8Array> | Uint8Array, string, string, string][] = [
    ["amplified List(Void)", amplifiedVoids, "KitchenSink", "canonical", "38668259e8b36651451cfb5a6c1206d6b477b3cc064b9c089dddd097d3550a6f"],
    ["amplified List(Void)", amplifiedVoids, "KitchenSink", "flat", "c14d72acd808e8b0a20de8f487858b8bf2709c812ef39f6f59cc6f48ccdc9641"],
    ["300-level nesting", deepEnvelope, "Envelope", "canonical", "0aabe8c9cd1ce081327c4e9010c066ee0d083879a630cf049076dd5ac409c6d0"],
    ["300-level nesting", deepEnvelope, "Envelope", "flat", "fe25555763090c8c6913c871a58c18696e57d76d1210a47bd84accae1fc25cab"],
    ["300-level nesting", deepEnvelope, "Envelope", "binary", "455cb8367961c7e17ae3c542b64225db1f15267c4f96e045879f61448c86b611"],
    ["300-level nesting", deepEnvelope, "Envelope", "text", "f47cb8241e8f38828db086379153fe9cdaaa5e37831fb18903cdda2d2fbad48a"],
  ];

  for (const [name, input, type, to, digest] of cases) {
    test(`${name} converts to ${to} as capnp writes it`, async () => {
      const r = await execCliInMemory(["convert", `binary:${to}`, ksCgr, type], await input());
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(sha256(r.stdout)).toBe(digest);
    });
  }

  test.skipIf(!hasCapnp)("digests match live capnp", async () => {
    const schemaPath = join(repoRoot, "schema", "dynamic-kitchen.capnp");
    for (const [, input, type, to, digest] of cases) {
      const live = execCapnp(["convert", `binary:${to}`, schemaPath, type], await input());
      expect({ to, code: live.code, digest: sha256(live.stdout) }).toEqual({ to, code: 0, digest });
    }
  });

  // Deepest `Expression` chain `capnp` 1.4.0 accepts as JSON (codec nesting
  // 64). `KitchenSink.voids` of 8Mi+1 nulls is a List(Void) whose read passes
  // the default 8Mi traversal budget only when the CLI lifts it.
  function expressionChain(levels: number): Uint8Array {
    let body = '{"literal":1.5}';
    for (let i = 0; i < levels; i++) body = `{"op":"add","params":[${body}]}`;
    return new TextEncoder().encode(body);
  }

  function amplifiedVoidJson(): Uint8Array {
    const count = 8 * 1024 * 1024 + 1;
    const chunks: string[] = ['{"voids":['];
    const block = "null,".repeat(100_000);
    let left = count;
    while (left > 1) {
      const take = Math.min(100_000, left - 1);
      chunks.push(take === 100_000 ? block : "null,".repeat(take));
      left -= take;
    }
    chunks.push("null]}");
    return new TextEncoder().encode(chunks.join(""));
  }

  const jsonInputs: {
    name: string;
    tsSchema: string;
    cppSchema: string;
    type: string;
    input: () => Uint8Array;
    digests: { flat: string; binary: string };
  }[] = [
    {
      name: "31-level struct chain",
      tsSchema: join(repoRoot, "schema", "calculator.capnp"),
      cppSchema: join(repoRoot, "schema", "calculator.capnp"),
      type: "Expression",
      input: () => expressionChain(31),
      digests: {
        flat: "85b7815b61808d717438a5a71314e14c3b7b80744c19e6a9f701b6349fb8a1a6",
        binary: "95c299b163278d5972f92c5698b7413379b8db11ca5a2c1bbb99cdca17d72e45",
      },
    },
    {
      name: "amplified List(Void)",
      tsSchema: ksCgr,
      cppSchema: join(repoRoot, "schema", "dynamic-kitchen.capnp"),
      type: "KitchenSink",
      input: amplifiedVoidJson,
      digests: {
        flat: "d77e360f32d07807581e0cfab5de07e822f7a81b59e338f0773ed7f75fc6c728",
        binary: "b1da323db5dea1b90b05ecee4552dece93911ec0852419ad5142d72bce726ea1",
      },
    },
  ];

  for (const spec of jsonInputs) {
    for (const to of ["flat", "binary"] as const) {
      test(`${spec.name} json input converts to ${to} as capnp writes it`, async () => {
        const stdin = spec.input();
        const r = await execCliInMemory(
          ["convert", `json:${to}`, spec.tsSchema, spec.type],
          stdin,
        );
        expect(r.stderr).toBe("");
        expect(r.code).toBe(0);
        expect(sha256(r.stdout)).toBe(spec.digests[to]);
        if (hasCapnp) {
          const live = execCapnp(
            ["convert", `json:${to}`, spec.cppSchema, spec.type],
            stdin,
          );
          expect(live.code).toBe(0);
          expect(Buffer.from(r.stdout)).toEqual(Buffer.from(live.stdout));
        }
      }, 60_000);
    }
  }
});

describe("bit list copies like capnp 1.4.0", () => {
  const ksCgr = join(goldenDir, "dynamic-kitchen.cgr.bin");
  const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

  // `KitchenSink.flags` is `[true, false, true]` with the five unused bits of its byte set.
  async function dirtyFlags(): Promise<Uint8Array> {
    const enc = await execCliInMemory(
      ["encode", ksCgr, "KitchenSink"],
      new TextEncoder().encode("(flags = [true, false, true])"),
    );
    expect(enc.code).toBe(0);
    const msg = enc.stdout.slice();
    const view = new DataView(msg.buffer);
    let hits = 0;
    for (let at = 8; at + 8 <= msg.byteLength; at += 8) {
      if ((view.getUint32(at, true) & 3) === 1 && view.getUint32(at + 4, true) === ((3 << 3) | 1)) {
        const body = at + 8 + (view.getInt32(at, true) >> 2) * 8;
        expect(msg[body]).toBe(0x05);
        msg[body]! |= 0xf8;
        hits++;
      }
    }
    expect(hits).toBe(1);
    return msg;
  }

  const cases: [string, string][] = [
    ["binary", "fa109b17d0a3d3973cf8d0f4756e73216e9a2f2dcccad09b594cc6a3bd94e587"],
    ["canonical", "e26c86611341c116c98b4341f67dec722886c05fa3802f117901ae6aa6e385e1"],
    ["flat", "d9b65b28dd0d6c3d60efb24fd152f1e8483125dcdb26c50b5ce5c9e6fb8a62d3"],
    ["packed", "fc93b1d1b207b665a3a9acbc5e07e682e5ce58b1e1529b144568d2ea4096bc63"],
    ["flat-packed", "ee8664d6b56fd6a8cfc75aee5e85cc144c8bb006d656b36ddde16466ad88e2e2"],
  ];

  for (const [to, digest] of cases) {
    test(`converting to ${to} clears the unused bits`, async () => {
      const r = await execCliInMemory(["convert", `binary:${to}`, ksCgr, "KitchenSink"], await dirtyFlags());
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(sha256(r.stdout)).toBe(digest);
    });
  }

  test.skipIf(!hasCapnp)("digests match live capnp", async () => {
    const schemaPath = join(repoRoot, "schema", "dynamic-kitchen.capnp");
    for (const [to, digest] of cases) {
      const live = execCapnp(["convert", `binary:${to}`, schemaPath, "KitchenSink"], await dirtyFlags());
      expect({ to, code: live.code, digest: sha256(live.stdout) }).toEqual({ to, code: 0, digest });
    }
  });
});

describe("malformed text input like capnp 1.4.0", () => {
  const cgr = (type: string) => join(goldenDir, type === "Person" ? "addressbook.cgr.bin" : "dynamic-kitchen.cgr.bin");
  const schemaPath = (type: string) =>
    join(repoRoot, "schema", type === "Person" ? "addressbook.capnp" : "dynamic-kitchen.capnp");
  const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

  // stdout, stderr and status from `capnp convert text:json`, with the `stack:` line of an
  // uncaught exception left out and the program name changed.
  const cases: [string, string, string, number, string, string][] = [
    ["empty-value-second", "Person", "(id = 1, name = \"a\")\n(id = 2, name = )", 1, "{\"id\": 1, \"name\": \"a\", \"employment\": {\"unemployed\": null}}\n{\"id\": 2, \"employment\": {\"unemployed\": null}}\n", "*** ERROR CONVERTING PREVIOUS MESSAGE ***\nThe following error occurred while converting the message above.\nThis probably means the input data is invalid/corrupted.\nException description: 9-15: Parse error.\nCode location: (capnp text input):1\n*** END ERROR ***"],
    ["unterminated", "Person", "(id = 1, name = \"a\"", 1, "", "*** Uncaught exception ***\ncapnp/serialize-text.c++:107: failed: Failed to read input."],
    ["bad-first-item", "Person", "(id = , name = \"b\")", 1, "{\"id\": 0, \"name\": \"b\", \"employment\": {\"unemployed\": null}}\n", "*** ERROR CONVERTING PREVIOUS MESSAGE ***\nThe following error occurred while converting the message above.\nThis probably means the input data is invalid/corrupted.\nException description: 1-5: Parse error.\nCode location: (capnp text input):1\n*** END ERROR ***"],
    ["empty-item", "Person", "(id = 1,, name = \"b\")", 1, "{\"id\": 1, \"name\": \"b\", \"employment\": {\"unemployed\": null}}\n", "*** ERROR CONVERTING PREVIOUS MESSAGE ***\nThe following error occurred while converting the message above.\nThis probably means the input data is invalid/corrupted.\nException description: 0-21: Parse error: Empty list item.\nCode location: (capnp text input):1\n*** END ERROR ***"],
    ["operator-run", "Person", "(id =-1, name = \"c\")", 1, "{\"id\": 0, \"name\": \"c\", \"employment\": {\"unemployed\": null}}\n", "*** ERROR CONVERTING PREVIOUS MESSAGE ***\nThe following error occurred while converting the message above.\nThis probably means the input data is invalid/corrupted.\nException description: 6-7: Parse error.\nCode location: (capnp text input):1\n*** END ERROR ***"],
    ["two-values", "Person", "(id = 1 2, name = \"d\")", 1, "{\"id\": 0, \"name\": \"d\", \"employment\": {\"unemployed\": null}}\n", "*** ERROR CONVERTING PREVIOUS MESSAGE ***\nThe following error occurred while converting the message above.\nThis probably means the input data is invalid/corrupted.\nException description: 1-9: Parse error.\nCode location: (capnp text input):1\n*** END ERROR ***"],
    ["bad-list-element", "Person", "(name = \"x\", phones = [(number = \"1\"), (number = ), (number = \"3\")])", 1, "{ \"id\": 0,\n  \"name\": \"x\",\n  \"phones\": [{\"number\": \"1\", \"type\": \"mobile\"}, {\"type\": \"mobile\"}, {\"number\": \"3\", \"type\": \"mobile\"}],\n  \"employment\": {\"unemployed\": null} }\n", "*** ERROR CONVERTING PREVIOUS MESSAGE ***\nThe following error occurred while converting the message above.\nThis probably means the input data is invalid/corrupted.\nException description: 40-48: Parse error.\nCode location: (capnp text input):1\n*** END ERROR ***"],
    ["empty-list-element", "Person", "(phones = [ , (number = \"2\")])", 1, "{ \"id\": 0,\n  \"phones\": [{\"type\": \"mobile\"}, {\"number\": \"2\", \"type\": \"mobile\"}],\n  \"employment\": {\"unemployed\": null} }\n", "*** ERROR CONVERTING PREVIOUS MESSAGE ***\nThe following error occurred while converting the message above.\nThis probably means the input data is invalid/corrupted.\nException description: 10-29: Parse error: Empty list item.\nCode location: (capnp text input):1\n*** END ERROR ***"],
    ["float-no-exponent", "KitchenSink", "(f64 = 1e, i8 = 3)", 1, "{ \"nothing\": null,\n  \"flag\": false,\n  \"flagDefaultTrue\": true,\n  \"i8\": 3,\n  \"i16\": -3000,\n  \"i32\": -100000,\n  \"i64\": \"-9007199254740993\",\n  \"u8\": 200,\n  \"u16\": 50000,\n  \"u32\": 3000000000,\n  \"u64\": \"9007199254740995\",\n  \"f32\": 1.5,\n  \"f64\": 0,\n  \"priority\": \"normal\",\n  \"meta\": {\"revision\": 1, \"nested\": {\"ok\": true, \"score\": 0.5}},\n  \"source\": {\"unset\": null},\n  \"none\": null }\n", "*** ERROR CONVERTING PREVIOUS MESSAGE ***\nThe following error occurred while converting the message above.\nThis probably means the input data is invalid/corrupted.\nException description: expected endPtr == s.end() [e == ]; String does not contain valid floating number; s = 1e\nCode location: kj/string.c++:595\n*** END ERROR ***"],
    ["second-unterminated", "Person", "(id = 1)(id = 2", 1, "{\"id\": 1, \"employment\": {\"unemployed\": null}}\n", "*** Uncaught exception ***\ncapnp/serialize-text.c++:107: failed: Failed to read input."],
    ["extra-tokens", "Person", "(id = 1) junk", 1, "", "*** Uncaught exception ***\ncapnp/serialize-text.c++:95: failed: expected parserInput.getPosition() == tokens.end() [(can't stringify) == (can't stringify)]; Extra tokens in input."],
    ["import", "Person", "(id = import \"x\")", 1, "", "*** Uncaught exception ***\ncapnp/serialize-text.c++:69: failed: External constants not allowed."],
    ["embed", "Person", "(name = embed \"x\")", 1, "", "*** Uncaught exception ***\ncapnp/serialize-text.c++:74: failed: External embeds not allowed."],
    ["constant", "Person", "(id = foo)", 1, "", "*** Uncaught exception ***\ncapnp/serialize-text.c++:69: failed: External constants not allowed."],
    ["multiline", "Person", "(id = 1,\n  name = )", 1, "{\"id\": 1, \"employment\": {\"unemployed\": null}}\n", "*** ERROR CONVERTING PREVIOUS MESSAGE ***\nThe following error occurred while converting the message above.\nThis probably means the input data is invalid/corrupted.\nException description: 3-9: Parse error.\nCode location: (capnp text input):2\n*** END ERROR ***"],
    ["octal-nine", "Person", "(id = 09)", 1, "{\"id\": 0, \"employment\": {\"unemployed\": null}}\n", "*** ERROR CONVERTING PREVIOUS MESSAGE ***\nThe following error occurred while converting the message above.\nThis probably means the input data is invalid/corrupted.\nException description: 1-8: Parse error.\nCode location: (capnp text input):1\n*** END ERROR ***"],
    ["nested-bad", "Person", "(employment = (employer = ), id = 6)", 1, "{\"id\": 6, \"employment\": {\"unemployed\": null}}\n", "*** ERROR CONVERTING PREVIOUS MESSAGE ***\nThe following error occurred while converting the message above.\nThis probably means the input data is invalid/corrupted.\nException description: 15-25: Parse error.\nCode location: (capnp text input):1\n*** END ERROR ***"],
    ["leading-comma", "Person", "(, id = 5)", 1, "{\"id\": 5, \"employment\": {\"unemployed\": null}}\n", "*** ERROR CONVERTING PREVIOUS MESSAGE ***\nThe following error occurred while converting the message above.\nThis probably means the input data is invalid/corrupted.\nException description: 0-10: Parse error: Empty list item.\nCode location: (capnp text input):1\n*** END ERROR ***"],
    ["bad-escape", "Person", "(name = \"a\\q\")", 1, "", "*** Uncaught exception ***\ncapnp/serialize-text.c++:107: failed: Failed to read input."],
    ["not-a-struct", "Person", "(5)", 1, "{\"id\": 0, \"employment\": {\"unemployed\": null}}\n", "*** ERROR CONVERTING PREVIOUS MESSAGE ***\nThe following error occurred while converting the message above.\nThis probably means the input data is invalid/corrupted.\nException description: expected expression.isTuple(); Input does not contain a struct.\nCode location: capnp/serialize-text.c++:134\n*** END ERROR ***"],
  ];

  for (const [name, type, input, code, stdout, stderr] of cases) {
    test(`${name} converts as capnp does`, async () => {
      const r = await execCliInMemory(["convert", "text:json", cgr(type), type], latin1(input));
      expect({ code: r.code, stdout: Buffer.from(r.stdout).toString("latin1"), stderr: r.stderr }).toEqual({
        code,
        stdout,
        stderr,
      });
    });
  }

  test.skipIf(!hasCapnp)("expectations match live capnp", () => {
    for (const [name, type, input, code, stdout, stderr] of cases) {
      const live = execCapnp(["convert", "text:json", schemaPath(type), type], latin1(input));
      const liveErr = live.stderr
        .replace(/^stack: .*\n/m, "")
        .replace(/capnp convert/g, "capnp-ts convert")
        .replace(/\n$/, "");
      expect({ name, code: live.code, stdout: Buffer.from(live.stdout).toString("latin1"), stderr: liveErr }).toEqual({
        name,
        code,
        stdout,
        stderr,
      });
    }
  });
});

describe("JSON array size limit like capnp 1.4.0", () => {
  const ksCgr = join(goldenDir, "dynamic-kitchen.cgr.bin");

  async function amplifiedVoids(count: number): Promise<Uint8Array> {
    const enc = await execCliInMemory(
      ["encode", ksCgr, "KitchenSink"],
      new TextEncoder().encode("(voids = [void])"),
    );
    expect(enc.code).toBe(0);
    const msg = enc.stdout.slice();
    const view = new DataView(msg.buffer);
    let patched = 0;
    for (let at = 8; at + 8 <= msg.byteLength; at += 8) {
      if ((view.getUint32(at, true) & 3) === 1 && view.getUint32(at + 4, true) === 1 << 3) {
        view.setUint32(at + 4, count << 3, true);
        patched++;
      }
    }
    expect(patched).toBe(1);
    return msg;
  }

  for (const [count, message] of [
    [178956971, "total size of struct list is larger than max segment size"],
    [178956970, "requested object size exceeds maximum segment size"],
    [348127232, "total size of struct list is larger than max segment size"],
  ] as [number, string][]) {
    test(`List(Void) of ${count} elements fails before building the array`, async () => {
      const r = await execCliInMemory(
        ["convert", "binary:json", ksCgr, "KitchenSink"],
        await amplifiedVoids(count),
      );
      expect(r.code).toBe(1);
      expect(r.stdout.byteLength).toBe(0);
      expect(r.stderr).toBe(`capnp-ts: ${message}`);
    });
  }
});

describe("eval of an unset struct field", () => {
  const unionCgr = join(goldenDir, "eval-unions.cgr.bin");
  const expected: [string, number[]][] = [
    ["binary", [0, 0, 0, 0, 1, 0, 0, 0, 0xfc, 0xff, 0xff, 0xff, 0, 0, 0, 0]],
    ["flat", [0xfc, 0xff, 0xff, 0xff, 0, 0, 0, 0]],
    ["packed", [0x10, 0x01, 0x0f, 0xfc, 0xff, 0xff, 0xff]],
    ["canonical", [0xfc, 0xff, 0xff, 0xff, 0, 0, 0, 0]],
    ["flat-packed", [0x0f, 0xfc, 0xff, 0xff, 0xff]],
  ];
  for (const [format, bytes] of expected) {
    test(`-o${format} writes a zero-sized root struct like capnp 1.4.0`, async () => {
      const ours = await execCliInMemory(["eval", `-o${format}`, unionCgr, "customEmpty.flatTag"]);
      expect(ours.code).toBe(0);
      expect([...ours.stdout]).toEqual(bytes);
    });
  }
});
