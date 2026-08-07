/**
 * Bidirectional wire interop with pycapnp (official Cap'n Python bindings).
 *
 * - Fixtures under golden/pycapnp/ are produced by scripts/pycapnp_interop.py
 * - CLI goldens under golden/ must decode with pycapnp (spawn)
 * - TS builder frames must decode with pycapnp
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Message,
  MessageBuilder,
  pack,
  unpack,
  canonicalizeFlat,
} from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const goldenDir = join(here, "golden");
const pyDir = join(goldenDir, "pycapnp");
const py = join(repoRoot, ".venv-pycapnp/bin/python");
const script = join(repoRoot, "scripts/pycapnp_interop.py");

function load(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(goldenDir, name)));
}

function loadPy(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(pyDir, name)));
}

function hasPycapnp(): boolean {
  return existsSync(py) && existsSync(script);
}

function pycapnpReadAb(path: string): {
  people: Array<{
    id: number;
    name: string;
    email: string;
    employment: string;
    school: string | null;
  }>;
} {
  const r = spawnSync(py, [script, "read-ab", path], { encoding: "utf8" });
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout) as ReturnType<typeof pycapnpReadAb>;
}

function pycapnpReadCalc(path: string): {
  expression: {
    call?: { op: string; params: Array<{ literal?: number; call?: unknown }> };
    literal?: number;
  };
} {
  const r = spawnSync(py, [script, "read-calc", path], { encoding: "utf8" });
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout);
}

function pycapnpReadResp(path: string): { value: number } {
  const r = spawnSync(py, [script, "read-resp", path], { encoding: "utf8" });
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout) as { value: number };
}

function decodeAbWithTs(bytes: Uint8Array) {
  const root = Message.fromFlat(bytes).root();
  const people = root.getP(0);
  const n = people.listLen();
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = people.listGetP(i);
    out.push({
      id: p.getU32(0),
      name: p.getText(0),
      email: p.getText(1),
    });
  }
  return out;
}

describe("pycapnp interop", () => {
  test("venv and fixtures present", () => {
    expect(hasPycapnp()).toBe(true);
    expect(existsSync(join(pyDir, "addressbook_pycapnp.bin"))).toBe(true);
    expect(existsSync(join(pyDir, "calculator_add_2_3_pycapnp.bin"))).toBe(true);
  });

  test("TS decodes pycapnp AddressBook Alice/Bob", () => {
    const people = decodeAbWithTs(loadPy("addressbook_pycapnp.bin"));
    expect(people.length).toBe(2);
    expect(people[0]).toMatchObject({ id: 123, name: "Alice", email: "alice@example.com" });
    expect(people[1]).toMatchObject({ id: 456, name: "Bob", email: "bob@example.com" });
  });

  test("pycapnp decodes CLI AddressBook golden", () => {
    const ab = pycapnpReadAb(join(goldenDir, "addressbook.bin"));
    expect(ab.people.length).toBe(2);
    expect(ab.people[0]!.name).toBe("Alice");
    expect(ab.people[1]!.name).toBe("Bob");
    expect(ab.people[0]!.employment).toBe("school");
    expect(ab.people[0]!.school).toBe("MIT");
  });

  test("TS decodes pycapnp calculator add(2,3) and eval path matches", () => {
    const bytes = loadPy("calculator_add_2_3_pycapnp.bin");
    const root = Message.fromFlat(bytes).root();
    const expr = root.getP(0);
    expect(expr.getU16(8)).toBe(2); // call
    expect(expr.getU16(0)).toBe(0); // add
    const params = expr.getP(0);
    expect(params.listLen()).toBe(2);
    expect(params.listGetP(0).getF64(0)).toBe(2);
    expect(params.listGetP(1).getF64(0)).toBe(3);
  });

  test("pycapnp decodes CLI calculator goldens", () => {
    const add = pycapnpReadCalc(join(goldenDir, "calculator_add_2_3.bin"));
    expect(add.expression.call?.op).toBe("add");
    expect(add.expression.call?.params[0]?.literal).toBe(2);
    expect(add.expression.call?.params[1]?.literal).toBe(3);

    const mul = pycapnpReadCalc(join(goldenDir, "calculator_mul_add.bin"));
    expect(mul.expression.call?.op).toBe("multiply");

    const resp = pycapnpReadResp(join(goldenDir, "calculator_value_5.bin"));
    expect(resp.value).toBe(5);
  });

  test("TS builder AddressBook is readable by pycapnp", () => {
    // Person: 1 data word, 4 ptrs (id, name, email, phones, employment)
    // Employment school = which 2, text in employment pointer
    const b = new MessageBuilder();
    const book = b.initRoot(0, 1);
    // two people composite list: Person dwords=1 pwords=4
    const first = book.initList(0, 2, 1, 4);
    first.setU32(0, 123);
    first.setU16(4, 2); // school
    first.setText(0, "Alice");
    first.setText(1, "alice@example.com");
    // phones list of PhoneNumber: 1 dword? type u16, number text -> 1 data word 1 ptr typically
    // PhoneNumber: number@0 Text, type@1 enum -> 1 data word (u16), 1 ptr
    const phones0 = first.initList(2, 1, 1, 1);
    phones0.setU16(0, 0); // mobile
    phones0.setText(0, "555-1212");
    first.setText(3, "MIT");

    const second = first.nextElement();
    second.setU32(0, 456);
    second.setU16(4, 0); // unemployed
    second.setText(0, "Bob");
    second.setText(1, "bob@example.com");
    const phones1 = second.initList(2, 2, 1, 1);
    phones1.setU16(0, 1);
    phones1.setText(0, "555-4567");
    const p1b = phones1.nextElement();
    p1b.setU16(0, 2);
    p1b.setText(0, "555-7654");

    const flat = b.toFlat();
    const tmp = join(pyDir, "addressbook_ts_builder.bin");
    mkdirSync(pyDir, { recursive: true });
    writeFileSync(tmp, flat);

    const ab = pycapnpReadAb(tmp);
    expect(ab.people.length).toBe(2);
    expect(ab.people[0]!.name).toBe("Alice");
    expect(ab.people[0]!.id).toBe(123);
    expect(ab.people[1]!.name).toBe("Bob");
  });

  test("pack/unpack preserve pycapnp AddressBook for TS decode", () => {
    const raw = loadPy("addressbook_pycapnp.bin");
    const packed = pack(raw);
    const unpacked = unpack(packed);
    expect([...unpacked]).toEqual([...raw]);
    const people = decodeAbWithTs(unpacked);
    expect(people[0]!.name).toBe("Alice");
  });

  test("canonical form of pycapnp AddressBook is stable under TS", () => {
    const raw = loadPy("addressbook_pycapnp.bin");
    // canonicalizeFlat expects framed stream; output is raw single-segment.
    const c1 = canonicalizeFlat(raw);
    // Re-enter via Message.fromFlat requires a frame; use CLI golden path parity:
    // canonical of framed message should match CLI canonical golden when content matches.
    const cliCanon = load("addressbook.canonical.bin");
    // pycapnp Alice/Bob is same as CLI encode → same canonical bytes
    expect([...c1]).toEqual([...cliCanon]);
  });

  test("TS builder calculator EvaluateRequest is readable by pycapnp", () => {
    // EvaluateRequest: 0 data, 1 ptr → Expression
    // Expression: 2 data words (16 bytes: f64 + tag u16 + op), 1 ptr for call params
    // call tag=2 at byte 8, op add=0 at byte 0, params list of 2 literals
    const b = new MessageBuilder();
    const req = b.initRoot(0, 1);
    const expr = req.initStruct(0, 2, 1);
    expr.setU16(8, 2); // call
    expr.setU16(0, 0); // add
    // List(Expression) composite: element 2 dwords + 1 ptr
    const first = expr.initList(0, 2, 2, 1);
    first.setU16(8, 0); // literal
    first.setF64(0, 2.0);
    const second = first.nextElement();
    second.setU16(8, 0);
    second.setF64(0, 3.0);
    const flat = b.toFlat();
    const tmp = join(pyDir, "calculator_add_ts_builder.bin");
    writeFileSync(tmp, flat);
    const calc = pycapnpReadCalc(tmp);
    expect(calc.expression.call?.op).toBe("add");
    expect(calc.expression.call?.params[0]?.literal).toBe(2);
    expect(calc.expression.call?.params[1]?.literal).toBe(3);
  });
});
