/**
 * Zero-size list amplification and list-init limits, matched to capnproto 1.4.0.
 *
 * A composite tag stores its element count in 29 bits. A zero-size element
 * still costs one traversal word, so a 72-byte message cannot expand into a
 * multi-gigabyte encode. `init` rejects counts of 2^29 or more.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CapnpError,
  ElemSize,
  Message,
  MessageBuilder,
  SchemaLoader,
  bytesToWords,
  encodeJson,
  encodeText,
  initDynamicRoot,
  primitiveBodySize,
  readDynamicRoot,
  storeU64,
  wpMakeList,
  wpMakeStruct,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, "golden");
const MAX_ELEMS = 2 ** 29 - 1;
const CLI_TRAVERSAL_WORDS = 2 ** 30;

function frameWords(words: bigint[]): Uint8Array {
  const buf = new Uint8Array(8 + words.length * 8);
  buf[4] = words.length & 0xff;
  buf[5] = (words.length >>> 8) & 0xff;
  buf[6] = (words.length >>> 16) & 0xff;
  buf[7] = (words.length >>> 24) & 0xff;
  for (let i = 0; i < words.length; i++) {
    storeU64(buf, 8 + i * 8, words[i]!);
  }
  return buf;
}

/** AddressBook root whose `people` list is a zero-size composite of `count`. */
function addressBookBomb(count: number): Uint8Array {
  const words = new Array<bigint>(8).fill(0n);
  words[0] = wpMakeStruct(0, 0, 1);
  words[1] = wpMakeList(0, ElemSize.Composite, 0);
  words[2] = wpMakeStruct(count, 0, 0);
  return frameWords(words);
}

function emptyPeopleTextAndJson(): { text: string; json: string } {
  const loader = SchemaLoader.fromCgr(
    new Uint8Array(readFileSync(join(goldenDir, "addressbook.cgr.bin"))),
  );
  const schema = loader.resolveStruct("AddressBook");
  const builder = new MessageBuilder();
  const root = initDynamicRoot(builder, schema);
  root.init("people", 0);
  const reader = readDynamicRoot(Message.fromFlat(builder.toFlat()), schema);
  return {
    text: encodeText(reader, { pretty: false }),
    json: encodeJson(reader),
  };
}

function runBomb(mode: string): void {
  const loader = SchemaLoader.fromCgr(
    new Uint8Array(readFileSync(join(goldenDir, "addressbook.cgr.bin"))),
  );
  const schema = loader.resolveStruct("AddressBook");
  const count = mode === "amp" ? MAX_ELEMS : 2 ** 29;
  const opts =
    mode === "hib" ? { traversalWords: CLI_TRAVERSAL_WORDS } : undefined;
  const bytes = addressBookBomb(count);
  if (bytes.byteLength !== 72) {
    console.error(`bomb is ${bytes.byteLength} bytes`);
    process.exit(2);
  }
  const expected = mode === "hib" ? emptyPeopleTextAndJson() : null;
  const t0 = Date.now();
  const heap0 = process.memoryUsage().heapUsed;

  const read = (data: Uint8Array) =>
    readDynamicRoot(Message.fromFlat(data, opts), schema);

  if (mode === "amp") {
    for (const encode of [
      () => encodeText(read(bytes), { pretty: false }),
      () => encodeJson(read(bytes)),
    ]) {
      try {
        encode();
        console.error("expected TRAVERSAL");
        process.exit(3);
      } catch (err) {
        if (!(err instanceof CapnpError) || err.code !== "TRAVERSAL") {
          console.error(err);
          process.exit(4);
        }
      }
    }
  } else {
    let text: string;
    let json: string;
    try {
      const reader = read(bytes);
      text = encodeText(reader, { pretty: false });
      json = encodeJson(read(bytes));
    } catch (err) {
      console.error(err);
      process.exit(5);
    }
    if (text !== expected!.text || json !== expected!.json) {
      console.error(JSON.stringify({ text, json, expected }));
      process.exit(6);
    }
    if (text !== "(people = [])") {
      console.error(JSON.stringify(text));
      process.exit(7);
    }
  }

  const elapsed = Date.now() - t0;
  const heap = process.memoryUsage().heapUsed - heap0;
  if (elapsed > 1000) {
    console.error(`elapsed ${elapsed}`);
    process.exit(8);
  }
  if (heap > 64 * 1024 * 1024) {
    console.error(`heap ${heap}`);
    process.exit(9);
  }
  process.stdout.write(`ok heap ${heap} ms ${elapsed}\n`);
}

const bombMode = process.env.CAPNP_BOMB_MODE;
if (bombMode) {
  runBomb(bombMode);
  process.exit(0);
}

function runBoundedBomb(mode: string): string {
  const proc = spawnSync(
    "bash",
    [
      "-c",
      'ulimit -v 1048576; exec "$0" "$1"',
      process.execPath,
      fileURLToPath(import.meta.url),
    ],
    {
      timeout: 4000,
      encoding: "utf8",
      env: { ...process.env, CAPNP_BOMB_MODE: mode },
    },
  );
  if (proc.status !== 0) {
    throw new Error(
      `bomb ${mode} status=${proc.status} signal=${proc.signal} stdout=${proc.stdout} stderr=${proc.stderr}`,
    );
  }
  return proc.stdout;
}

describe("zero-size list amplification", () => {
  test("72-byte composite list is rejected inside the time and memory bound", () => {
    const out = runBoundedBomb("amp");
    expect(out.startsWith("ok ")).toBe(true);
  });

  test("composite count bit 29 is not an element, matching an empty list", () => {
    const out = runBoundedBomb("hib");
    expect(out.startsWith("ok ")).toBe(true);
  });

  test("List(Void) of 2^29-1 elements is charged one word each", () => {
    const buf = frameWords([wpMakeList(0, ElemSize.Void, MAX_ELEMS)]);
    const t0 = Date.now();
    const heap0 = process.memoryUsage().heapUsed;
    expect(() => Message.fromFlat(buf).root()).toThrow(CapnpError);
    try {
      Message.fromFlat(buf).root();
    } catch (err) {
      expect(err).toBeInstanceOf(CapnpError);
      expect((err as CapnpError).code).toBe("TRAVERSAL");
    }
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(process.memoryUsage().heapUsed - heap0).toBeLessThan(64 * 1024 * 1024);
  });
});

describe("list and blob init limits", () => {
  test("init rejects a list of 2^29 elements and still accepts 2^29-1 voids", () => {
    const loader = SchemaLoader.fromCgr(
      new Uint8Array(readFileSync(join(goldenDir, "dynamic-kitchen.cgr.bin"))),
    );
    const sink = loader.resolveStruct("KitchenSink");
    const root = initDynamicRoot(new MessageBuilder(), sink);
    expect(() => root.init("voids", 2 ** 29)).toThrow(
      "tried to allocate list with too many elements",
    );
    expect(root.init("voids", MAX_ELEMS).asList().size()).toBe(MAX_ELEMS);

    const raw = new MessageBuilder().initRoot(0, 1);
    expect(() => raw.initPrimList(0, ElemSize.Byte, 2 ** 29, 1)).toThrow(
      "tried to allocate list with too many elements",
    );
    expect(() => raw.initPointerList(0, 2 ** 29)).toThrow(
      "tried to allocate list with too many elements",
    );
    expect(() => raw.initCompositeList(0, 2 ** 29, 0, 0)).toThrow(
      "tried to allocate list with too many elements",
    );
    const tooWide = Math.floor(((1 << 29) - 2) / 5) + 1;
    expect(tooWide).toBeLessThanOrEqual(MAX_ELEMS);
    expect(() => raw.initCompositeList(0, tooWide, 1, 4)).toThrow(
      "total size of struct list is larger than max segment size",
    );
  });

  test("text and data init reject sizes past the C++ blob caps", () => {
    const loader = SchemaLoader.fromCgr(
      new Uint8Array(readFileSync(join(goldenDir, "dynamic-kitchen.cgr.bin"))),
    );
    const sink = loader.resolveStruct("KitchenSink");
    const root = initDynamicRoot(new MessageBuilder(), sink);
    expect(() => root.init("title", 2 ** 29 - 1)).toThrow("integer overflow");
    expect(() => root.init("raw", 2 ** 29)).toThrow("integer overflow");
    root.init("title", 0);
    root.init("raw", 0);
  });

  test("primitive body size does not wrap through a 32-bit shift", () => {
    const twoByte = primitiveBodySize(2 ** 28, 16);
    expect(twoByte.nbytes).toBe(2 ** 29);
    expect(twoByte.nwords).toBe(2 ** 26);
    expect(bytesToWords(2 ** 31)).toBe(2 ** 28);
  });
});
