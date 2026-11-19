/**
 * List-element reads checked against `capnp` 1.4.0 encode/decode.
 * Promotions and Bool-to-data cells are schema mismatches there.
 * Demotions, struct upgrades, and Bool views of data lists succeed.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapnpError } from "../src/kinds.ts";
import { Message } from "../src/message.ts";

function hasCapnp(): boolean {
  return spawnSync("capnp", ["--version"], { encoding: "utf8" }).status === 0;
}

const dir = mkdtempSync(join(tmpdir(), "capnp-listev-"));

const FILE_IDS: Record<string, string> = {
  u8: "0x81b2c3d4e5f60711",
  u16: "0x81b2c3d4e5f60712",
  u32: "0x81b2c3d4e5f60713",
  u64: "0x81b2c3d4e5f60714",
  f64: "0x81b2c3d4e5f60715",
  bool: "0x81b2c3d4e5f60716",
  text: "0x81b2c3d4e5f60717",
  void: "0x81b2c3d4e5f60718",
  s8: "0x81b2c3d4e5f60719",
  sp: "0x81b2c3d4e5f6071a",
};

function schema(name: string, body: string): string {
  const path = join(dir, `${name}.capnp`);
  writeFileSync(path, `@${FILE_IDS[name]};\n${body}\n`);
  return path;
}

const schemas: Record<string, string> = {
  u8: schema("u8", "struct Root { nums @0 :List(UInt8); }"),
  u16: schema("u16", "struct Root { nums @0 :List(UInt16); }"),
  u32: schema("u32", "struct Root { nums @0 :List(UInt32); }"),
  u64: schema("u64", "struct Root { nums @0 :List(UInt64); }"),
  f64: schema("f64", "struct Root { nums @0 :List(Float64); }"),
  bool: schema("bool", "struct Root { nums @0 :List(Bool); }"),
  text: schema("text", "struct Root { nums @0 :List(Text); }"),
  void: schema("void", "struct Root { nums @0 :List(Void); }"),
  s8: schema("s8", "struct S { v @0 :UInt8; }\nstruct Root { nums @0 :List(S); }"),
  sp: schema("sp", "struct S { v @0 :Text; }\nstruct Root { nums @0 :List(S); }"),
};

function encode(which: string, text: string): Uint8Array {
  const r = spawnSync("capnp", ["encode", schemas[which]!, "Root"], {
    input: text,
  });
  expect(r.status).toBe(0);
  return new Uint8Array(r.stdout as Uint8Array);
}

function decode(which: string, bytes: Uint8Array): { ok: boolean; text: string } {
  const r = spawnSync("capnp", ["decode", schemas[which]!, "Root"], {
    input: bytes,
    encoding: "utf8",
  });
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  return { ok: r.status === 0, text };
}

function rootList(bytes: Uint8Array) {
  return Message.fromFlat(bytes).root().getP(0);
}

function expectSchema(fn: () => unknown): void {
  try {
    fn();
    throw new Error("expected SCHEMA");
  } catch (e) {
    expect(e).toBeInstanceOf(CapnpError);
    expect((e as CapnpError).code).toBe("SCHEMA");
  }
}

describe.skipIf(!hasCapnp())("list evolution against capnp 1.4.0", () => {
  test("promotions and bool-to-data fail; demotions and data-to-bool succeed", () => {
    const u8 = encode("u8", "(nums = [1, 2, 5])");
    expect(decode("u16", u8).ok).toBe(false);
    expect(decode("u32", u8).ok).toBe(false);
    expect(decode("text", u8).ok).toBe(false);
    expectSchema(() => rootList(u8).listGetU16(0));
    expectSchema(() => rootList(u8).listGetU32(0));
    expectSchema(() => rootList(u8).listGetText(0));

    const asBool = decode("bool", u8);
    expect(asBool.ok).toBe(true);
    expect(asBool.text).toContain("true");
    const bits = rootList(u8);
    expect(bits.listGetBool(0)).toBe(true);
    expect(bits.listGetBool(1)).toBe(false);
    expect(bits.listGetBool(2)).toBe(false);

    const u16 = encode("u16", "(nums = [0xcdef, 0x1234])");
    const demoted = decode("u8", u16);
    expect(demoted.ok).toBe(true);
    expect(demoted.text).toContain("239");
    expect(rootList(u16).listGetU8(0)).toBe(0xef);
    expect(rootList(u16).listGetU8(1)).toBe(0x34);
    expect(decode("u32", u16).ok).toBe(false);
    expect(decode("u64", u16).ok).toBe(false);
    expectSchema(() => rootList(u16).listGetU32(0));
    expectSchema(() => rootList(u16).listGetF64(0));

    const flags = encode("bool", "(nums = [true, false, true, true])");
    expect(decode("bool", flags).ok).toBe(true);
    expect(decode("u8", flags).ok).toBe(false);
    expect(decode("void", flags).ok).toBe(false);
    expect(decode("s8", flags).ok).toBe(false);
    expectSchema(() => rootList(flags).listGetU8(0));
    expectSchema(() => rootList(flags).listGetU64(0));
    expectSchema(() => rootList(flags).listGetText(0));
    expect(rootList(flags).listGetBool(2)).toBe(true);

    const wide = encode("u32", "(nums = [0x89abcdef, 1])");
    expect(decode("u8", wide).ok).toBe(true);
    expect(decode("u64", wide).ok).toBe(false);
    expect(decode("bool", wide).ok).toBe(true);
    expect(rootList(wide).listGetU16(0)).toBe(0xcdef);
    expectSchema(() => rootList(wide).listGetU64(0));
    expect(rootList(wide).listGetBool(0)).toBe(true);

    const words = encode("text", '(nums = ["foo", "bar"])');
    expect(decode("text", words).ok).toBe(true);
    expect(decode("u8", words).ok).toBe(false);
    expect(decode("bool", words).ok).toBe(false);
    expect(rootList(words).listGetText(0)).toBe("foo");
    expectSchema(() => rootList(words).listGetU8(0));
    expectSchema(() => rootList(words).listGetBool(0));

    const blanks = encode("void", "(nums = [void, void, void])");
    expect(decode("u8", blanks).ok).toBe(false);
    expect(decode("bool", blanks).ok).toBe(false);
    expect(decode("s8", blanks).ok).toBe(true);
    expectSchema(() => rootList(blanks).listGetU8(0));
    expectSchema(() => rootList(blanks).listGetBool(0));
    expect(rootList(blanks).listGetStruct(1).getU8(0, 7)).toBe(7);
  });

  test("struct lists match capnp primitive and pointer downgrades", () => {
    const s8 = encode("s8", "(nums = [(v = 1), (v = 2)])");
    expect(decode("u8", s8).ok).toBe(true);
    expect(decode("u16", s8).ok).toBe(true);
    expect(decode("u64", s8).ok).toBe(true);
    expect(decode("bool", s8).ok).toBe(false);
    expect(decode("text", s8).ok).toBe(false);
    expect(rootList(s8).listGetU8(0)).toBe(1);
    expect(rootList(s8).listGetU16(1)).toBe(2);
    expect(rootList(s8).listGetU64(0)).toBe(1n);
    expectSchema(() => rootList(s8).listGetBool(0));
    expectSchema(() => rootList(s8).listGetText(0));

    const sp = encode("sp", '(nums = [(v = "hi"), (v = "yo")])');
    expect(decode("text", sp).ok).toBe(true);
    expect(decode("u8", sp).ok).toBe(false);
    expect(decode("bool", sp).ok).toBe(false);
    expect(rootList(sp).listGetText(0)).toBe("hi");
    expect(rootList(sp).listGetText(1)).toBe("yo");
    expectSchema(() => rootList(sp).listGetU32(0));
    expectSchema(() => rootList(sp).listGetBool(0));

    const pi = encode("f64", "(nums = [3.5, -1])");
    expect(decode("f64", pi).ok).toBe(true);
    expect(decode("u32", pi).ok).toBe(true);
    expect(decode("u16", pi).ok).toBe(true);
    expect(rootList(pi).listGetF64(0)).toBeCloseTo(3.5);
    expect(rootList(pi).listGetF64(1)).toBeCloseTo(-1);
    // 3.5 and -1.0 are 8-byte values whose low halves are zero.
    expect(rootList(pi).listGetU32(0)).toBe(0);
    expect(rootList(pi).listGetU16(1)).toBe(0);
    const narrow = encode("u32", "(nums = [1, 2])");
    expect(decode("f64", narrow).ok).toBe(false);
    expectSchema(() => rootList(narrow).listGetF64(0));
  });
});
