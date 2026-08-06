/**
 * Decode Cap'n calculator Expression goldens (serialization subset).
 *
 * Expression layout (capnp compile -ocapnp): 16 data bytes, 1 ptr
 *   union tag bits [64, 80) = u16 at byte 8
 *   tag 0 literal: f64 @byte0
 *   tag 1 parameter: u32 @byte0
 *   tag 2 call: op enum u16 @byte0, params List(Expression) @ptr0
 *
 * EvaluateRequest: expression @0 :Expression — ptr[0]
 * EvaluateResponse: value @0 :Float64 — data byte 0
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ElemSize, Message, PtrKind, serializeToFlat } from "../src/index.ts";
import type { Ptr } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, "golden");

const EXPR_LITERAL = 0;
const EXPR_PARAMETER = 1;
const EXPR_CALL = 2;

const OP_ADD = 0;
const OP_SUB = 1;
const OP_MUL = 2;
const OP_DIV = 3;

function loadGolden(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(goldenDir, name)));
}

/** In-process eval of Expression trees (mirrors janet/fortran sample tests). */
function evalExpr(e: Ptr): number {
  const tag = e.getU16(8, 0xffff);
  if (tag === EXPR_LITERAL) return e.getF64(0);
  if (tag === EXPR_PARAMETER) {
    throw new Error("parameter not valid in free eval");
  }
  if (tag !== EXPR_CALL) throw new Error(`bad Expression tag ${tag}`);

  const op = e.getU16(0, 0xffff);
  const params = e.getP(0);
  expect(params.kind).toBe(PtrKind.List);
  const n = params.listLen();
  if (n === 0) throw new Error("empty call params");

  let acc = 0;
  for (let i = 0; i < n; i++) {
    const v = evalExpr(params.listGetP(i));
    if (i === 0) {
      acc = v;
      continue;
    }
    switch (op) {
      case OP_ADD:
        acc += v;
        break;
      case OP_SUB:
        acc -= v;
        break;
      case OP_MUL:
        acc *= v;
        break;
      case OP_DIV:
        if (v === 0) throw new Error("div by zero");
        acc /= v;
        break;
      default:
        throw new Error(`bad Operator ${op}`);
    }
  }
  return acc;
}

function rootExpression(bytes: Uint8Array): Ptr {
  const msg = Message.fromFlat(bytes);
  const root = msg.root();
  expect(root.kind).toBe(PtrKind.Struct);
  // EvaluateRequest.expression @0
  const expr = root.getP(0);
  expect(expr.kind).toBe(PtrKind.Struct);
  return expr;
}

describe("calculator_add_2_3.bin", () => {
  test("decode call(add, [literal 2, literal 3])", () => {
    const expr = rootExpression(loadGolden("calculator_add_2_3.bin"));

    expect(expr.getU16(8)).toBe(EXPR_CALL);
    expect(expr.getU16(0)).toBe(OP_ADD);

    const params = expr.getP(0);
    expect(params.kind).toBe(PtrKind.List);
    expect(params.esize).toBe(ElemSize.Composite);
    expect(params.listLen()).toBe(2);

    const a = params.listGetP(0);
    expect(a.getU16(8)).toBe(EXPR_LITERAL);
    expect(a.getF64(0)).toBe(2.0);

    const b = params.listGetP(1);
    expect(b.getU16(8)).toBe(EXPR_LITERAL);
    expect(b.getF64(0)).toBe(3.0);
  });

  test("eval → 5", () => {
    const expr = rootExpression(loadGolden("calculator_add_2_3.bin"));
    expect(evalExpr(expr)).toBe(5.0);
  });

  test("serializeToFlat round-trip preserves tree", () => {
    const bytes = loadGolden("calculator_add_2_3.bin");
    const flat = serializeToFlat(Message.fromFlat(bytes));
    const expr = rootExpression(flat);
    expect(expr.getU16(0)).toBe(OP_ADD);
    expect(evalExpr(expr)).toBe(5.0);
  });
});

describe("calculator_mul_add.bin", () => {
  test("decode multiply(add(2,3), 4)", () => {
    const expr = rootExpression(loadGolden("calculator_mul_add.bin"));

    expect(expr.getU16(8)).toBe(EXPR_CALL);
    expect(expr.getU16(0)).toBe(OP_MUL);

    const outer = expr.getP(0);
    expect(outer.kind).toBe(PtrKind.List);
    expect(outer.esize).toBe(ElemSize.Composite);
    expect(outer.listLen()).toBe(2);

    // params[0] = call(add, [2, 3])
    const inner = outer.listGetP(0);
    expect(inner.getU16(8)).toBe(EXPR_CALL);
    expect(inner.getU16(0)).toBe(OP_ADD);
    const ip = inner.getP(0);
    expect(ip.listLen()).toBe(2);
    expect(ip.listGetP(0).getU16(8)).toBe(EXPR_LITERAL);
    expect(ip.listGetP(0).getF64(0)).toBe(2.0);
    expect(ip.listGetP(1).getU16(8)).toBe(EXPR_LITERAL);
    expect(ip.listGetP(1).getF64(0)).toBe(3.0);

    // params[1] = literal 4
    const lit4 = outer.listGetP(1);
    expect(lit4.getU16(8)).toBe(EXPR_LITERAL);
    expect(lit4.getF64(0)).toBe(4.0);
  });

  test("eval → 20", () => {
    const expr = rootExpression(loadGolden("calculator_mul_add.bin"));
    expect(evalExpr(expr)).toBe(20.0);
  });

  test("viewFlat zero-copy matches fromFlat", () => {
    const bytes = loadGolden("calculator_mul_add.bin");
    const view = Message.viewFlat(bytes);
    const expr = view.root().getP(0);
    expect(expr.getU16(0)).toBe(OP_MUL);
    expect(evalExpr(expr)).toBe(20.0);
  });
});

describe("calculator_value_5.bin", () => {
  test("EvaluateResponse value is 5.0", () => {
    const msg = Message.fromFlat(loadGolden("calculator_value_5.bin"));
    const root = msg.root();
    expect(root.kind).toBe(PtrKind.Struct);
    expect(root.getF64(0)).toBe(5.0);
  });
});
