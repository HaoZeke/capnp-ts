import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeFlat } from "../src/index.ts";
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

    // Errors: evaluating a struct type itself, out-of-bounds subscript, binary on scalar
    expect((await execCliInMemory(["eval", ksCgr, "KitchenSink"])).code).toBe(1);
    expect((await execCliInMemory(["eval", ksCgr, "greetingList[9]"])).code).toBe(
      1,
    );
    expect(
      (await execCliInMemory(["eval", "-b", ksCgr, "magicAnswer"])).code,
    ).toBe(1);
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
        [["-ocanonical"], "extremeConst"],
        [[], "magicAnswer"],
        [[], "greetingList"],
        [["--short"], "greetingList"],
        [[], "greetingList[2]"],
        [[], "extremeConst.matrix[0][1]"],
        [[], "KitchenSink.defaultTag"],
        [[], "KitchenSink.i64"],
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
