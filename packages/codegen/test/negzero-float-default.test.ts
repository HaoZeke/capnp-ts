/**
 * Float32/Float64 default -0.0 keeps its sign bit in the XOR mask.
 * Cap'n Proto 1.4.0 `capnp decode` prints f32 = -0, f64 = -0 for a zero body.
 * DynamicStruct reads 0x80000000 and 0x8000000000000000.
 * Writing -0.0 stores zero bits. Writing +0.0 stores the sign bit.
 * scripts/negzero-float-probe.sh prints those bits again.
 * The schema language has no literal for a non-canonical NaN payload.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emitModuleSource, walkCgr } from "../src/index.ts";
import {
  bitsToF32,
  bitsToF64,
  f32ToBits,
  f64ToBits,
  Message,
  MessageBuilder,
} from "../../runtime/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures", "negzero-float.cgr.bin");

/** DynamicStruct unset read. scripts/negzero-float-probe.sh prints these. */
const UNSET_F32 = 0x80000000;
const UNSET_F64 = 0x8000000000000000n;
/**
 * Canonical quiet NaN bits from the 1.4.0 probe (`f32nan` / `f64nan`).
 * `nan(1)` and `-nan` are not schema literals. Bun canonicalizes every
 * NaN number to these bits, so a non-canonical payload has no JS value.
 */
const NAN_F32 = 0x7fc00000;
const NAN_F64 = 0x7ff8000000000000n;

type Gen = {
  Z_dataWordCount: number;
  Z_pointerCount: number;
  Z_getF32: (ptr: unknown, dflt?: number) => number;
  Z_getF64: (ptr: unknown, dflt?: number) => number;
  Z_getF32p: (ptr: unknown, dflt?: number) => number;
  Z_getF64p: (ptr: unknown, dflt?: number) => number;
  Z_getKeep: (ptr: unknown, dflt?: number) => number;
  Z_getWide: (ptr: unknown, dflt?: number) => number;
  Z_setF32: (ptr: unknown, value: number, dflt?: number) => void;
  Z_setF64: (ptr: unknown, value: number, dflt?: number) => void;
  Z_setF32p: (ptr: unknown, value: number, dflt?: number) => void;
  Z_setF64p: (ptr: unknown, value: number, dflt?: number) => void;
  Z_setKeep: (ptr: unknown, value: number, dflt?: number) => void;
  Z_setWide: (ptr: unknown, value: number, dflt?: number) => void;
};

async function loadGenerated(): Promise<{ src: string; gen: Gen }> {
  const bytes = new Uint8Array(readFileSync(fixturePath));
  const ast = await walkCgr(bytes);
  const z = ast.nodes.find(
    (n) => n.which === "struct" && n.displayName.endsWith(":Z"),
  );
  expect(z?.struct).toBeDefined();
  const fields = z!.struct!.fields;
  const expectDefault = (
    name: string,
    which: "float32" | "float64",
    negZero: boolean,
  ): void => {
    const field = fields.find((f) => f.name === name);
    const dv = field?.slot?.defaultValue;
    expect(field?.slot?.hadExplicitDefault).toBe(true);
    expect(dv?.which).toBe(which);
    if (dv && (dv.which === "float32" || dv.which === "float64")) {
      expect(Object.is(dv.value, -0)).toBe(negZero);
      expect(dv.value === 0).toBe(true);
    }
  };
  expectDefault("f32", "float32", true);
  expectDefault("f64", "float64", true);
  expectDefault("f32p", "float32", false);
  expectDefault("f64p", "float64", false);

  const fileId = ast.requestedFiles.find((f) => f.filename === "nz.capnp")?.id;
  const src = emitModuleSource(ast, "nz.capnp", fileId);
  const outDir = mkdtempSync(join(tmpdir(), "negzero-"));
  const outFile = join(outDir, "nz.ts");
  try {
    writeFileSync(outFile, src, "utf8");
    const gen = (await import(outFile)) as Gen;
    return { src, gen };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

function flatOf(gen: Gen, fill?: (z: unknown) => void): Uint8Array {
  const builder = new MessageBuilder();
  const z = builder.initRoot(gen.Z_dataWordCount, gen.Z_pointerCount);
  fill?.(z);
  return builder.toFlat();
}

/** Data section bytes of a single-segment struct message. */
function structData(flat: Uint8Array): Uint8Array {
  const view = new DataView(flat.buffer, flat.byteOffset, flat.byteLength);
  const nSegs = view.getUint32(0, true) + 1;
  let header = 4 * (1 + nSegs);
  if (header % 8 !== 0) header += 4;
  const ptr = view.getBigUint64(header, true);
  const raw = Number((ptr >> 2n) & 0x3fffffffn);
  const off = raw & 0x20000000 ? raw - 0x40000000 : raw;
  const dataWords = Number((ptr >> 32n) & 0xffffn);
  const start = header + 8 + off * 8;
  return flat.subarray(start, start + dataWords * 8);
}

function nonzeroBytes(data: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 0) out.push(i);
  }
  return out;
}

describe("explicit -0.0 float defaults", () => {
  test("emits dflt = -0 for a negative zero and leaves other defaults", async () => {
    const { src } = await loadGenerated();
    expect(src).toContain("export function Z_getF32(ptr: Ptr, dflt = -0): number");
    expect(src).toContain(
      "export function Z_setF32(ptr: StructBuilder, value: number, dflt = -0): void",
    );
    expect(src).toContain("export function Z_getF64(ptr: Ptr, dflt = -0): number");
    expect(src).toContain(
      "export function Z_setF64(ptr: StructBuilder, value: number, dflt = -0): void",
    );
    expect(src).toContain("export function Z_getF32p(ptr: Ptr, dflt = 0): number");
    expect(src).toContain(
      "export function Z_setF32p(ptr: StructBuilder, value: number, dflt = 0): void",
    );
    expect(src).toContain("export function Z_getF64p(ptr: Ptr, dflt = 0): number");
    expect(src).toContain(
      "export function Z_setF64p(ptr: StructBuilder, value: number, dflt = 0): void",
    );
    expect(src).toContain("export function Z_getKeep(ptr: Ptr, dflt = 1.5): number");
    expect(src).toContain(
      "export function Z_getWide(ptr: Ptr, dflt = -2.25): number",
    );
  });

  test("unset reads -0 and the wire distinguishes -0 from +0", async () => {
    const { gen } = await loadGenerated();
    const unsetFlat = flatOf(gen);
    const unsetRoot = Message.fromFlat(unsetFlat).root();
    expect(Object.is(gen.Z_getF32(unsetRoot), -0)).toBe(true);
    expect(f32ToBits(gen.Z_getF32(unsetRoot))).toBe(UNSET_F32);
    expect(Object.is(gen.Z_getF64(unsetRoot), -0)).toBe(true);
    expect(f64ToBits(gen.Z_getF64(unsetRoot))).toBe(UNSET_F64);
    expect(Object.is(gen.Z_getF32p(unsetRoot), 0)).toBe(true);
    expect(f32ToBits(gen.Z_getF32p(unsetRoot))).toBe(0);
    expect(Object.is(gen.Z_getF64p(unsetRoot), 0)).toBe(true);
    expect(f64ToBits(gen.Z_getF64p(unsetRoot))).toBe(0n);
    expect(gen.Z_getKeep(unsetRoot)).toBe(1.5);
    expect(gen.Z_getWide(unsetRoot)).toBe(-2.25);
    expect(nonzeroBytes(structData(unsetFlat))).toEqual([]);

    const negFlat = flatOf(gen, (z) => {
      gen.Z_setF32(z, -0);
      gen.Z_setF64(z, -0);
    });
    expect(nonzeroBytes(structData(negFlat))).toEqual([]);
    const negRoot = Message.fromFlat(negFlat).root();
    expect(f32ToBits(gen.Z_getF32(negRoot, 0))).toBe(0);
    expect(f64ToBits(gen.Z_getF64(negRoot, 0))).toBe(0n);
    expect(Object.is(gen.Z_getF32(negRoot), -0)).toBe(true);
    expect(Object.is(gen.Z_getF64(negRoot), -0)).toBe(true);

    const pos32 = flatOf(gen, (z) => {
      gen.Z_setF32(z, 0);
    });
    const pos32Bytes = nonzeroBytes(structData(pos32));
    expect(pos32Bytes.length).toBe(1);
    expect(structData(pos32)[pos32Bytes[0]!]).toBe(0x80);
    expect(pos32Bytes[0]! % 4).toBe(3);
    const pos32Root = Message.fromFlat(pos32).root();
    expect(f32ToBits(gen.Z_getF32(pos32Root, 0))).toBe(UNSET_F32);
    expect(Object.is(gen.Z_getF32(pos32Root), 0)).toBe(true);

    const pos64 = flatOf(gen, (z) => {
      gen.Z_setF64(z, 0);
    });
    const pos64Bytes = nonzeroBytes(structData(pos64));
    expect(pos64Bytes.length).toBe(1);
    expect(structData(pos64)[pos64Bytes[0]!]).toBe(0x80);
    expect(pos64Bytes[0]! % 8).toBe(7);
    const pos64Root = Message.fromFlat(pos64).root();
    expect(f64ToBits(gen.Z_getF64(pos64Root, 0))).toBe(UNSET_F64);
    expect(Object.is(gen.Z_getF64(pos64Root), 0)).toBe(true);
  });

  test("a NaN payload default round-trips bit-exact", () => {
    const nan32 = bitsToF32(NAN_F32);
    const nan64 = bitsToF64(NAN_F64);
    expect(f32ToBits(nan32)).toBe(NAN_F32);
    expect(f64ToBits(nan64)).toBe(NAN_F64);
    const builder = new MessageBuilder();
    const blank = builder.initRoot(2, 0);
    const blankFlat = builder.toFlat();
    const blankRoot = Message.fromFlat(blankFlat).root();
    expect(f32ToBits(blankRoot.getF32(0, nan32))).toBe(NAN_F32);
    expect(f64ToBits(blankRoot.getF64(8, nan64))).toBe(NAN_F64);
    expect(nonzeroBytes(structData(blankFlat))).toEqual([]);

    blank.setF32(0, nan32, nan32);
    blank.setF64(8, nan64, nan64);
    const sameFlat = builder.toFlat();
    expect(nonzeroBytes(structData(sameFlat))).toEqual([]);
    const sameRoot = Message.fromFlat(sameFlat).root();
    expect(f32ToBits(sameRoot.getF32(0, nan32))).toBe(NAN_F32);
    expect(f64ToBits(sameRoot.getF64(8, nan64))).toBe(NAN_F64);

    const pos = new MessageBuilder();
    const w = pos.initRoot(2, 0);
    w.setF32(0, 0, nan32);
    w.setF64(8, 0, nan64);
    const posFlat = pos.toFlat();
    const raw = Message.fromFlat(posFlat).root();
    expect(f32ToBits(raw.getF32(0, 0))).toBe(NAN_F32);
    expect(f64ToBits(raw.getF64(8, 0))).toBe(NAN_F64);
    expect(Object.is(raw.getF32(0, nan32), 0)).toBe(true);
    expect(Object.is(raw.getF64(8, nan64), 0)).toBe(true);
  });
});
