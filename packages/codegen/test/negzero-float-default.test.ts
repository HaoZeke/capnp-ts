/**
 * Explicit Float32/Float64 default -0.0 emits mask 0.
 * Generated C++ from Cap'n Proto 1.4.0 (8b892a8) passes a mask to
 * getDataField and setDataField only when the default compares unequal to 0.
 * Flat hex below is that builder output for negzero-float.capnp.
 */
import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emitModuleSource, walkCgr } from "../src/index.ts";
import {
  f32ToBits,
  f64ToBits,
  Message,
  MessageBuilder,
} from "../../runtime/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const fixturePath = join(here, "fixtures", "negzero-float.cgr.bin");

/** Generated C++ 1.4.0 unset root. Body is zero. */
const CPP_UNSET =
  "0000000006000000000000000500000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
/** Generated C++ 1.4.0 setF32/setF64/setF32p/setF64p(1.25). keep and wide stay unset. */
const CPP_SET125 =
  "000000000600000000000000050000000000a03f0000a03f000000000000f43f000000000000f43f00000000000000000000000000000000";
/** Same sets, plus setKeep/setWide(1.25), so nonzero masks stay on the wire. */
const CPP_SETALL =
  "000000000600000000000000050000000000a03f0000a03f000000000000f43f000000000000f43f0000600000000000000000000000f6ff";
/** Generated C++ 1.4.0 with every field set to -0.0. */
const CPP_NEG0 =
  "000000000600000000000000050000000000008000000080000000000000008000000000000000800000c0bf000000000000000000000240";
/** Generated C++ 1.4.0 with every field set to +0.0. */
const CPP_POS0 =
  "000000000600000000000000050000000000000000000000000000000000000000000000000000000000c03f0000000000000000000002c0";

const F32_125 = 0x3fa00000;
const F64_125 = 0x3ff4000000000000n;
const F32_1_5 = 0x3fc00000;
const F64_NEG_2_25 = 0xc002000000000000n;
const F32_NEG0 = 0x80000000;
const F64_NEG0 = 0x8000000000000000n;

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

type Root = {
  f32: number;
  f64: number;
  f32p: number;
  f64p: number;
  keep: number;
  wide: number;
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
  const scratch = join(repoRoot, ".tmp-codegen-tests");
  mkdirSync(scratch, { recursive: true });
  const outDir = mkdtempSync(join(scratch, "negzero-"));
  const outFile = join(outDir, "nz.ts");
  try {
    writeFileSync(outFile, src, "utf8");
    const gen = (await import(outFile)) as Gen;
    return { src, gen };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

type Mode = "unset" | "set125" | "setall" | "setNeg" | "setPos";

function buildFlat(gen: Gen, mode: Mode): Uint8Array {
  const builder = new MessageBuilder();
  const z = builder.initRoot(gen.Z_dataWordCount, gen.Z_pointerCount);
  if (mode === "set125" || mode === "setall") {
    gen.Z_setF32(z, 1.25);
    gen.Z_setF64(z, 1.25);
    gen.Z_setF32p(z, 1.25);
    gen.Z_setF64p(z, 1.25);
  }
  if (mode === "setall") {
    gen.Z_setKeep(z, 1.25);
    gen.Z_setWide(z, 1.25);
  }
  if (mode === "setNeg") {
    gen.Z_setF32(z, -0);
    gen.Z_setF64(z, -0);
    gen.Z_setF32p(z, -0);
    gen.Z_setF64p(z, -0);
    gen.Z_setKeep(z, -0);
    gen.Z_setWide(z, -0);
  }
  if (mode === "setPos") {
    gen.Z_setF32(z, 0);
    gen.Z_setF64(z, 0);
    gen.Z_setF32p(z, 0);
    gen.Z_setF64p(z, 0);
    gen.Z_setKeep(z, 0);
    gen.Z_setWide(z, 0);
  }
  return builder.toFlat();
}

function readRoot(gen: Gen, bytes: Uint8Array): Root {
  const root = Message.fromFlat(bytes).root();
  return {
    f32: gen.Z_getF32(root),
    f64: gen.Z_getF64(root),
    f32p: gen.Z_getF32p(root),
    f64p: gen.Z_getF64p(root),
    keep: gen.Z_getKeep(root),
    wide: gen.Z_getWide(root),
  };
}

describe("explicit -0.0 float defaults", () => {
  test("emits dflt = 0 and leaves +0 and nonzero defaults in place", async () => {
    const { src } = await loadGenerated();
    expect(src).toContain("export function Z_getF32(ptr: Ptr, dflt = 0): number");
    expect(src).toContain(
      "export function Z_setF32(ptr: StructBuilder, value: number, dflt = 0): void",
    );
    expect(src).toContain("export function Z_getF64(ptr: Ptr, dflt = 0): number");
    expect(src).toContain(
      "export function Z_setF64(ptr: StructBuilder, value: number, dflt = 0): void",
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
      "export function Z_setKeep(ptr: StructBuilder, value: number, dflt = 1.5): void",
    );
    expect(src).toContain(
      "export function Z_getWide(ptr: Ptr, dflt = -2.25): number",
    );
    expect(src).toContain(
      "export function Z_setWide(ptr: StructBuilder, value: number, dflt = -2.25): void",
    );
    expect(src).not.toContain("dflt = -0");
    expect(src).toContain("export const Z_dataWordCount = 5;");
    expect(src).toContain("export const Z_pointerCount = 0;");
  });

  test("unset getter bits are +0 and set(1.25) cross-reads on both sides", async () => {
    const { gen } = await loadGenerated();
    expect(gen.Z_dataWordCount).toBe(5);
    expect(gen.Z_pointerCount).toBe(0);

    const unset = readRoot(gen, Buffer.from(CPP_UNSET, "hex"));
    expect(Object.is(unset.f32, 0)).toBe(true);
    expect(f32ToBits(unset.f32)).toBe(0);
    expect(Object.is(unset.f64, 0)).toBe(true);
    expect(f64ToBits(unset.f64)).toBe(0n);
    expect(Object.is(unset.f32p, 0)).toBe(true);
    expect(f32ToBits(unset.f32p)).toBe(0);
    expect(Object.is(unset.f64p, 0)).toBe(true);
    expect(f64ToBits(unset.f64p)).toBe(0n);
    expect(unset.keep).toBe(1.5);
    expect(f32ToBits(unset.keep)).toBe(F32_1_5);
    expect(unset.wide).toBe(-2.25);
    expect(f64ToBits(unset.wide)).toBe(F64_NEG_2_25);

    const set125 = readRoot(gen, Buffer.from(CPP_SET125, "hex"));
    expect(set125.f32).toBe(1.25);
    expect(f32ToBits(set125.f32)).toBe(F32_125);
    expect(set125.f64).toBe(1.25);
    expect(f64ToBits(set125.f64)).toBe(F64_125);
    expect(set125.f32p).toBe(1.25);
    expect(f32ToBits(set125.f32p)).toBe(F32_125);
    expect(set125.f64p).toBe(1.25);
    expect(f64ToBits(set125.f64p)).toBe(F64_125);
    expect(set125.keep).toBe(1.5);
    expect(f32ToBits(set125.keep)).toBe(F32_1_5);
    expect(set125.wide).toBe(-2.25);
    expect(f64ToBits(set125.wide)).toBe(F64_NEG_2_25);

    const setall = readRoot(gen, Buffer.from(CPP_SETALL, "hex"));
    expect(setall.f32).toBe(1.25);
    expect(f32ToBits(setall.f32)).toBe(F32_125);
    expect(setall.f64).toBe(1.25);
    expect(f64ToBits(setall.f64)).toBe(F64_125);
    expect(setall.f32p).toBe(1.25);
    expect(setall.f64p).toBe(1.25);
    expect(setall.keep).toBe(1.25);
    expect(f32ToBits(setall.keep)).toBe(F32_125);
    expect(setall.wide).toBe(1.25);
    expect(f64ToBits(setall.wide)).toBe(F64_125);

    expect(Buffer.from(buildFlat(gen, "unset")).toString("hex")).toBe(CPP_UNSET);
    expect(Buffer.from(buildFlat(gen, "set125")).toString("hex")).toBe(CPP_SET125);
    expect(Buffer.from(buildFlat(gen, "setall")).toString("hex")).toBe(CPP_SETALL);
  });

  test("set(-0.0) flat hex matches generated C++ 1.4.0", async () => {
    const { gen } = await loadGenerated();
    expect(Buffer.from(buildFlat(gen, "setNeg")).toString("hex")).toBe(CPP_NEG0);
  });

  test("set(+0.0) flat hex matches generated C++ 1.4.0", async () => {
    const { gen } = await loadGenerated();
    expect(Buffer.from(buildFlat(gen, "setPos")).toString("hex")).toBe(CPP_POS0);
  });

  test("C++ -0.0 bytes cross-read on every field", async () => {
    const { gen } = await loadGenerated();
    const neg = readRoot(gen, Buffer.from(CPP_NEG0, "hex"));
    expect(Object.is(neg.f32, -0)).toBe(true);
    expect(f32ToBits(neg.f32)).toBe(F32_NEG0);
    expect(Object.is(neg.f64, -0)).toBe(true);
    expect(f64ToBits(neg.f64)).toBe(F64_NEG0);
    expect(Object.is(neg.f32p, -0)).toBe(true);
    expect(f32ToBits(neg.f32p)).toBe(F32_NEG0);
    expect(Object.is(neg.f64p, -0)).toBe(true);
    expect(f64ToBits(neg.f64p)).toBe(F64_NEG0);
    expect(Object.is(neg.keep, -0)).toBe(true);
    expect(f32ToBits(neg.keep)).toBe(F32_NEG0);
    expect(Object.is(neg.wide, -0)).toBe(true);
    expect(f64ToBits(neg.wide)).toBe(F64_NEG0);
  });

  test("C++ +0.0 bytes cross-read on every field", async () => {
    const { gen } = await loadGenerated();
    const pos = readRoot(gen, Buffer.from(CPP_POS0, "hex"));
    expect(Object.is(pos.f32, 0)).toBe(true);
    expect(f32ToBits(pos.f32)).toBe(0);
    expect(Object.is(pos.f64, 0)).toBe(true);
    expect(f64ToBits(pos.f64)).toBe(0n);
    expect(Object.is(pos.f32p, 0)).toBe(true);
    expect(f32ToBits(pos.f32p)).toBe(0);
    expect(Object.is(pos.f64p, 0)).toBe(true);
    expect(f64ToBits(pos.f64p)).toBe(0n);
    expect(Object.is(pos.keep, 0)).toBe(true);
    expect(f32ToBits(pos.keep)).toBe(0);
    expect(Object.is(pos.wide, 0)).toBe(true);
    expect(f64ToBits(pos.wide)).toBe(0n);
  });
});
