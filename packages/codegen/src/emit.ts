/**
 * TypeScript emitter for CodeGeneratorRequest ASTs (capnpc-ts v1).
 *
 * Emits one ESM module per requested schema file:
 *   - struct dataWordCount / pointerCount layout constants
 *   - typed field getters (Ptr methods) with schema-default XOR args
 *   - enums as const maps (no TypeScript `enum` keyword)
 *   - union which() + arm tag constants
 *   - UInt64/Int64 always via getU64 (bigint), never getU32
 *   - Float32 via getF32 (IEEE bit XOR); Float64 via getF64
 *
 * Scalar defaults come from Field.slot.defaultValue (zero when omitted in schema).
 */

import type {
  AppliedAnnotation,
  BrandAst,
  CgrAst,
  FieldAst,
  MethodAst,
  NodeAst,
  TypeAst,
  ValueAst,
} from "./cgr-walk.ts";
import { NO_DISCRIMINANT, formatType } from "./cgr-walk.ts";
import { basename, dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

export type EmitResult = {
  /** Paths written (absolute or cwd-relative as given to writeFileSync). */
  written: string[];
  /** Generated source when no file path was resolved (stdout fallback). */
  stdoutFallback?: string;
};

/** Map schema path `foo/bar.capnp` -> `bar.ts` (cwd of the plugin process). */
export function outputNameForSchema(schemaPath: string): string {
  const base = basename(schemaPath);
  const stem = base.endsWith(".capnp") ? base.slice(0, -".capnp".length) : base;
  return `${stem}.ts`;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Short type name from Node.displayName (`path:Person.PhoneNumber` -> `Person_PhoneNumber`). */
export function shortTypeName(displayName: string): string {
  const colon = displayName.lastIndexOf(":");
  const nested = colon >= 0 ? displayName.slice(colon + 1) : displayName;
  const bare = nested.includes("/")
    ? nested.slice(nested.lastIndexOf("/") + 1)
    : nested;
  // Cap'n nested dots are not valid TS identifiers; use underscores.
  return bare.replace(/\./g, "_").replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * File stem from `dir/other.capnp:Slot`. capnpc-c++ puts that file in its
 * own namespace so the name cannot collide with a type in this file.
 */
function schemaFileStem(displayName: string): string {
  const colon = displayName.lastIndexOf(":");
  const path = colon >= 0 ? displayName.slice(0, colon) : displayName;
  const base = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
  const stem = base.endsWith(".capnp") ? base.slice(0, -".capnp".length) : base;
  let safe = stem.replace(/[^A-Za-z0-9_]/g, "_");
  if (!safe || /^[0-9]/.test(safe)) safe = `_${safe}`;
  return safe || "external";
}

/** Safe identifier for a field / enumerant name (already schema identifiers). */
function ident(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name;
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Upper-snake layout constant prefix from short type name. */
function upperSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/_+/g, "_")
    .toUpperCase();
}

// ---------------------------------------------------------------------------
// Type / offset helpers
// ---------------------------------------------------------------------------

/** Cap'n slot offset → data-section byte offset (or bit for bool). */
function dataByteOffset(typeWhich: string, slotOffset: number): number {
  switch (typeWhich) {
    case "bool":
      return slotOffset; // bit index; caller uses getBool
    case "int8":
    case "uint8":
      return slotOffset;
    case "int16":
    case "uint16":
    case "enum":
      return slotOffset * 2;
    case "int32":
    case "uint32":
    case "float32":
      return slotOffset * 4;
    case "int64":
    case "uint64":
    case "float64":
      return slotOffset * 8;
    default:
      return slotOffset;
  }
}

/** JS literal for a number (finite / NaN / ±Infinity / -0). */
function jsNumberLiteral(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (n === Infinity) return "Infinity";
  if (n === -Infinity) return "-Infinity";
  if (Object.is(n, -0)) return "-0";
  return String(n);
}

/**
 * Schema default as a TypeScript default-parameter expression, or null when
 * the zero language default is enough (omit the `= …` only when value is the
 * type's zero; still fine to emit `= 0` — callers pass through to get*).
 */
function scalarDefaultExpr(
  typeWhich: string,
  dv: ValueAst | undefined,
): string {
  if (!dv) {
    if (typeWhich === "bool") return "false";
    if (typeWhich === "int64" || typeWhich === "uint64") return "0n";
    return "0";
  }
  switch (typeWhich) {
    case "bool":
      if (dv.which === "bool") return dv.value ? "true" : "false";
      return "false";
    case "int8":
    case "int16":
    case "int32":
      if (
        dv.which === "int8" ||
        dv.which === "int16" ||
        dv.which === "int32"
      ) {
        return jsNumberLiteral(dv.value);
      }
      return "0";
    case "uint8":
    case "uint16":
    case "uint32":
    case "enum":
      if (
        dv.which === "uint8" ||
        dv.which === "uint16" ||
        dv.which === "uint32" ||
        dv.which === "enum"
      ) {
        return jsNumberLiteral(dv.value >>> 0);
      }
      // Signed Value tags used for unsigned slots (defensive).
      if (
        dv.which === "int8" ||
        dv.which === "int16" ||
        dv.which === "int32"
      ) {
        return jsNumberLiteral(dv.value >>> 0);
      }
      return "0";
    case "int64":
      if (dv.which === "int64" || dv.which === "uint64") {
        return `${dv.value}n`;
      }
      return "0n";
    case "uint64":
      if (dv.which === "uint64" || dv.which === "int64") {
        // Emit as unsigned bigint literal (mask to 64 bits).
        const u = BigInt.asUintN(64, dv.value);
        return `${u}n`;
      }
      return "0n";
    case "float32":
    case "float64":
      if (dv.which === "float32" || dv.which === "float64") {
        // Generated C++ for Cap'n Proto 1.4.0 passes a mask to getDataField
        // and setDataField only when the float default compares unequal to
        // zero. -0.0 compares equal to zero, so the mask is 0 and the raw
        // bits stay on the wire.
        if (dv.value === 0) return "0";
        return jsNumberLiteral(dv.value);
      }
      return "0";
    default:
      return "0";
  }
}

// ---------------------------------------------------------------------------
// Node selection for a requested file
// ---------------------------------------------------------------------------

/** All node ids nested under a file id (scopeId chain). */
export function nodesForFile(ast: CgrAst, fileId: bigint): NodeAst[] {
  const ids = new Set<bigint>([fileId]);
  // Auto-generated Method$Params and Method$Results nodes have scopeId 0.
  // They still belong to the file named in displayName.
  const file = ast.nodes.find((n) => n.id === fileId);
  const prefix = file?.displayName ? `${file.displayName}:` : "";
  if (prefix) {
    for (const n of ast.nodes) {
      if (
        n.scopeId === 0n &&
        n.which !== "file" &&
        n.displayName.startsWith(prefix)
      ) {
        ids.add(n.id);
      }
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of ast.nodes) {
      if (ids.has(n.scopeId) && !ids.has(n.id)) {
        ids.add(n.id);
        grew = true;
      }
    }
  }
  return ast.nodes.filter((n) => ids.has(n.id) && n.which !== "file");
}

type ModuleEmitContext = {
  byId: Map<bigint, NodeAst>;
  ownerFileByNodeId: Map<bigint, bigint>;
  currentFileId: bigint;
  importAliases: Map<bigint, string>;
  /** Disambiguated stub name for a type whose file was not requested. */
  externalAliasNames: Map<bigint, string>;
};

function buildOwnerFileMap(ast: CgrAst, byId: Map<bigint, NodeAst>): Map<bigint, bigint> {
  const memo = new Map<bigint, bigint>();
  const resolve = (id: bigint): bigint => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const n = byId.get(id);
    if (!n) return 0n;
    if (n.which === "file") {
      memo.set(id, n.id);
      return n.id;
    }
    const owner = resolve(n.scopeId);
    memo.set(id, owner);
    return owner;
  };
  for (const n of ast.nodes) resolve(n.id);
  return memo;
}

function collectReferencedTypeIds(t: TypeAst, out: Set<bigint>): void {
  if (t.which === "list") {
    collectReferencedTypeIds(t.elementType, out);
    return;
  }
  if (t.which === "struct" || t.which === "interface" || t.which === "enum") {
    out.add(t.typeId);
    if (t.brand) {
      for (const scope of t.brand.scopes) {
        for (const b of scope.bind ?? []) {
          if (b) collectReferencedTypeIds(b, out);
        }
      }
    }
  }
}

function collectNodeTypeRefs(
  node: NodeAst,
  out: Set<bigint>,
  byId: Map<bigint, NodeAst>,
): void {
  if (node.struct) {
    for (const f of node.struct.fields) {
      if (f.slot) collectReferencedTypeIds(f.slot.type, out);
    }
  }
  if (node.const) {
    collectReferencedTypeIds(node.const.type, out);
  }
  for (const m of node.methods ?? []) {
    out.add(m.paramStructType);
    out.add(m.resultStructType);
    for (const brand of [m.paramBrand, m.resultBrand]) {
      for (const scope of brand?.scopes ?? []) {
        for (const b of scope.bind ?? []) {
          if (b) collectReferencedTypeIds(b, out);
        }
      }
    }
  }
  const seen = new Set<bigint>();
  const walk = (id: bigint): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.add(id);
    const n = byId.get(id);
    if (!n) return;
    for (const m of n.methods ?? []) {
      out.add(m.paramStructType);
      out.add(m.resultStructType);
    }
    for (const s of n.superclasses ?? []) walk(s.id);
  };
  for (const s of node.superclasses ?? []) walk(s.id);
}

function typeMentionsBrand(t: TypeAst): boolean {
  if (t.which === "list") return typeMentionsBrand(t.elementType);
  if (t.which === "struct" || t.which === "interface" || t.which === "enum") {
    return !!t.brand && t.brand.scopes.length > 0;
  }
  return false;
}

function nodeMentionsBrand(node: NodeAst): boolean {
  const types: TypeAst[] = [];
  for (const f of node.struct?.fields ?? []) {
    if (f.slot) types.push(f.slot.type);
  }
  if (node.const) types.push(node.const.type);
  return types.some(typeMentionsBrand);
}

function paramNames(node: NodeAst | undefined): string[] {
  return (node?.parameters ?? []).map((p, i) => ident(p) || `T${i}`);
}

/** `<T extends CapnpAnyPointer = CapnpAnyPointer, ...>` or empty. */
function ownerGenericClause(owner: NodeAst, extra?: string): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (clause: string): void => {
    const name = clause.split(/\s/)[0] ?? clause;
    if (seen.has(name)) return;
    seen.add(name);
    parts.push(clause);
  };
  for (const name of paramNames(owner)) {
    add(`${name} extends CapnpAnyPointer = CapnpAnyPointer`);
  }
  if (extra) add(extra);
  return parts.length === 0 ? "" : `<${parts.join(", ")}>`;
}

function ownerPtrReceiver(owner: NodeAst, typeName: string): string {
  const names = paramNames(owner);
  if (names.length === 0) return "ptr: Ptr";
  return `ptr: ${typeName}_Ptr<${names.join(", ")}>`;
}

function implicitMethodParamName(
  index: number,
  method?: MethodAst,
): string {
  const direct = method?.implicitParameters?.[index];
  if (direct !== undefined) return ident(direct) || `M${index}`;
  return `M${index}`;
}

/** TypeScript type of one brand binding. Pointer types stay in the Capnp* family. */
function tsBrandArg(
  t: TypeAst,
  ctx: ModuleEmitContext,
  owner: NodeAst,
  method?: MethodAst,
): string {
  switch (t.which) {
    case "text":
      return "CapnpText";
    case "data":
      return "CapnpData";
    case "list":
      return `CapnpList<${tsBrandArg(t.elementType, ctx, owner, method)}>`;
    case "struct":
      return ptrTypeForStruct(t.typeId, ctx, t.brand, owner, method);
    case "interface":
      return ptrTypeForInterface(t.typeId, ctx, t.brand, owner, method);
    case "anyPointer":
      if (t.constraint.which === "parameter") {
        const scopeNode = ctx.byId.get(t.constraint.scopeId);
        const raw =
          scopeNode?.parameters?.[t.constraint.parameterIndex] ??
          `T${t.constraint.parameterIndex}`;
        return ident(raw) || `T${t.constraint.parameterIndex}`;
      }
      if (t.constraint.which === "implicitMethodParameter") {
        return implicitMethodParamName(t.constraint.parameterIndex, method);
      }
      switch (t.constraint.anyKind) {
        case "struct":
          return "CapnpAnyStruct";
        case "list":
          return "CapnpAnyList";
        case "capability":
          return "CapnpCapability";
        default:
          return "CapnpAnyPointer";
      }
    default:
      return "CapnpAnyPointer";
  }
}

function brandArgList(
  typeId: bigint,
  brand: BrandAst | undefined,
  ctx: ModuleEmitContext,
  owner: NodeAst,
  method?: MethodAst,
): string {
  const n = ctx.byId.get(typeId);
  const params = n?.parameters;
  if (!params || params.length === 0 || !brand) return "";
  const scope = brand.scopes.find((s) => s.scopeId === typeId);
  if (!scope) return "";
  if (scope.which === "inherit") {
    const names = paramNames(n);
    const inScope = new Set(paramNames(owner));
    if (names.length > 0 && names.every((name) => inScope.has(name))) {
      return `<${names.join(", ")}>`;
    }
    return `<${names.map(() => "CapnpAnyPointer").join(", ")}>`;
  }
  const binds = scope.bind ?? [];
  const args = params.map((_, i) => {
    const b = binds[i];
    return b ? tsBrandArg(b, ctx, owner, method) : "CapnpAnyPointer";
  });
  return `<${args.join(", ")}>`;
}

function ptrTypeForStruct(
  typeId: bigint,
  ctx: ModuleEmitContext,
  brand?: BrandAst,
  owner?: NodeAst,
  method?: MethodAst,
): string {
  const n = ctx.byId.get(typeId);
  if (!n) return "Ptr";
  const args = owner ? brandArgList(typeId, brand, ctx, owner, method) : "";
  const external = ctx.externalAliasNames.get(typeId);
  if (external) return external + args;
  const base = `${shortTypeName(n.displayName)}_Ptr`;
  const fileId = ctx.ownerFileByNodeId.get(typeId) ?? ctx.currentFileId;
  if (fileId === ctx.currentFileId) return base + args;
  const alias = ctx.importAliases.get(fileId);
  return (alias ? `${alias}.${base}` : base) + args;
}

function ptrTypeForInterface(
  typeId: bigint,
  ctx: ModuleEmitContext,
  brand?: BrandAst,
  owner?: NodeAst,
  method?: MethodAst,
): string {
  const n = ctx.byId.get(typeId);
  if (!n) return "Ptr";
  const args = owner ? brandArgList(typeId, brand, ctx, owner, method) : "";
  const external = ctx.externalAliasNames.get(typeId);
  if (external) return external + args;
  const base = `${shortTypeName(n.displayName)}_Capability`;
  const fileId = ctx.ownerFileByNodeId.get(typeId) ?? ctx.currentFileId;
  if (fileId === ctx.currentFileId) return base + args;
  const alias = ctx.importAliases.get(fileId);
  return (alias ? `${alias}.${base}` : base) + args;
}

/**
 * Parameter names a generated struct should carry. The node itself wins.
 * Otherwise inherit them from the method brand or implicit parameters that
 * name this struct as its params or results type.
 */
function scopeParamNames(node: NodeAst, ctx: ModuleEmitContext): string[] {
  const out: string[] = [];
  const seen = new Set<bigint>();
  let scope = node.scopeId;
  while (scope !== 0n && !seen.has(scope)) {
    seen.add(scope);
    const parent = ctx.byId.get(scope);
    if (!parent) break;
    for (const name of paramNames(parent)) {
      if (name && !out.includes(name)) out.push(name);
    }
    scope = parent.scopeId;
  }
  return out;
}

function effectiveParamNames(node: NodeAst, ctx: ModuleEmitContext): string[] {
  const own = paramNames(node);
  const names: string[] = [];
  const add = (name: string): void => {
    if (name && !names.includes(name)) names.push(name);
  };
  // Enclosing scopes and the interface that generated this struct come
  // before the struct's own parameters (often a method's implicit ones).
  for (const name of scopeParamNames(node, ctx)) add(name);
  const implicit: string[] = [];
  for (const other of ctx.byId.values()) {
    for (const m of other.methods ?? []) {
      const isParam = m.paramStructType === node.id;
      const isResult = m.resultStructType === node.id;
      if (!isParam && !isResult) continue;
      for (const name of paramNames(other)) add(name);
      const brand = isParam ? m.paramBrand : m.resultBrand;
      for (const scope of brand?.scopes ?? []) {
        if (scope.which !== "inherit") continue;
        for (const name of paramNames(ctx.byId.get(scope.scopeId))) add(name);
      }
      for (const raw of m.implicitParameters ?? []) {
        const name = ident(raw) || raw;
        if (name && !implicit.includes(name)) implicit.push(name);
      }
    }
  }
  for (const name of own) add(name);
  for (const name of implicit) add(name);
  return names;
}

function nodeWithParams(node: NodeAst, names: string[]): NodeAst {
  const current = paramNames(node);
  if (
    current.length === names.length &&
    current.every((name, i) => name === names[i])
  ) {
    return node;
  }
  return { ...node, parameters: names };
}

function methodTypeParamClause(
  m: MethodAst,
  iface: NodeAst,
  ctx: ModuleEmitContext,
): string {
  const names: string[] = [];
  const add = (name: string): void => {
    if (name && !names.includes(name)) names.push(name);
  };
  for (const id of [m.paramStructType, m.resultStructType]) {
    const n = ctx.byId.get(id);
    if (n) for (const name of effectiveParamNames(n, ctx)) add(name);
  }
  for (const name of paramNames(iface)) add(name);
  for (const raw of m.implicitParameters ?? []) add(ident(raw) || raw);
  if (names.length === 0) return "";
  return `<${names
    .map((name) => `${name} extends CapnpAnyPointer = CapnpAnyPointer`)
    .join(", ")}>`;
}

function structAliasType(
  id: bigint,
  brand: BrandAst | undefined,
  ctx: ModuleEmitContext,
  owner: NodeAst,
  method?: MethodAst,
): string {
  const n = ctx.byId.get(id);
  if (!n || n.which !== "struct") return "Ptr";
  const rendered = ptrTypeForStruct(id, ctx, brand, owner, method);
  if (rendered.includes("<")) return rendered;
  const names = effectiveParamNames(n, ctx);
  if (names.length === 0) return rendered;
  return `${rendered}<${names.join(", ")}>`;
}

function brandLiteral(brand: BrandAst | undefined): string {
  if (!brand || brand.scopes.length === 0) return "[]";
  const scopes = brand.scopes
    .map((scope) => {
      if (scope.which === "inherit") {
        return `{ scopeId: 0x${scope.scopeId.toString(16)}n, which: "inherit" }`;
      }
      const bind = (scope.bind ?? [])
        .map((b) => (b ? JSON.stringify(formatType(b)) : "null"))
        .join(", ");
      return (
        `{ scopeId: 0x${scope.scopeId.toString(16)}n, which: "bind", ` +
        `bind: [${bind}] }`
      );
    })
    .join(", ");
  return `[${scopes}]`;
}

function anyPointerTsType(
  t: TypeAst & { which: "anyPointer" },
  owner: NodeAst,
  byId: Map<bigint, NodeAst>,
): { typeName: string; genericParam?: string } {
  if (t.constraint.which === "parameter") {
    const scopeNode = byId.get(t.constraint.scopeId);
    const rawName =
      scopeNode?.parameters?.[t.constraint.parameterIndex] ??
      `T${t.constraint.parameterIndex}`;
    const paramName = ident(rawName) || `T${t.constraint.parameterIndex}`;
    return {
      typeName: paramName,
      genericParam: `${paramName} extends CapnpAnyPointer = CapnpAnyPointer`,
    };
  }
  if (t.constraint.which === "implicitMethodParameter") {
    const paramName = `M${t.constraint.parameterIndex}`;
    return {
      typeName: paramName,
      genericParam: `${paramName} extends CapnpAnyPointer = CapnpAnyPointer`,
    };
  }
  switch (t.constraint.anyKind) {
    case "struct":
      return { typeName: "CapnpAnyStruct" };
    case "list":
      return { typeName: "CapnpAnyList" };
    case "capability":
      return { typeName: "CapnpCapability" };
    default:
      return { typeName: "CapnpAnyPointer" };
  }
}

// ---------------------------------------------------------------------------
// Emit one module
// ---------------------------------------------------------------------------

function emitEnum(node: NodeAst, lines: string[]): void {
  const name = shortTypeName(node.displayName);
  const enumerants = node.enumerants ?? [];
  lines.push(`/** Enum ${node.displayName} (const map; no TS enum keyword). */`);
  lines.push(`export const ${name} = {`);
  for (let i = 0; i < enumerants.length; i++) {
    const e = enumerants[i]!;
    lines.push(`  ${ident(e.name)}: ${i},`);
  }
  lines.push(`} as const;`);
  lines.push(
    `export type ${name} = (typeof ${name})[keyof typeof ${name}];`,
  );
  lines.push(``);
  emitApplied(upperSnake(name), node.appliedAnnotations, lines);
  for (const e of enumerants) {
    emitApplied(`${upperSnake(name)}_${upperSnake(ident(e.name))}`, e.appliedAnnotations, lines);
  }
}

function isPointerValue(v: ValueAst): boolean {
  return (
    v.which === "list" ||
    v.which === "struct" ||
    v.which === "interface" ||
    v.which === "anyPointer"
  );
}

function fieldPointerDefaultBytes(field: FieldAst): number[] | undefined {
  const slot = field.slot;
  if (!slot || !slot.hadExplicitDefault) return undefined;
  const dv = slot.defaultValue;
  if (!dv) return undefined;
  if (
    dv.which === "list" ||
    dv.which === "struct" ||
    dv.which === "interface" ||
    dv.which === "anyPointer"
  ) {
    return dv.pointerBytes && dv.pointerBytes.length > 0 ? dv.pointerBytes : undefined;
  }
  return undefined;
}

/** `as const` is rejected on these expressions (TS1355). */
function constAssertion(expr: string): string {
  if (
    expr === "undefined" ||
    expr === "NaN" ||
    expr === "Infinity" ||
    expr === "-Infinity"
  ) {
    return "";
  }
  return " as const";
}

function annotationValueLiteral(v: ValueAst): string | undefined {
  switch (v.which) {
    case "void":
      return undefined;
    case "bool":
      return v.value ? "true" : "false";
    case "int8":
    case "int16":
    case "int32":
    case "uint8":
    case "uint16":
    case "uint32":
    case "float32":
    case "float64":
      return jsNumberLiteral(v.value);
    case "int64":
    case "uint64":
      return `${v.value}n`;
    case "text":
      return JSON.stringify(v.value);
    case "data":
      return `new Uint8Array([${Array.from(v.value).join(", ")}])`;
    case "enum":
      return String(v.value);
    case "list":
    case "struct":
    case "interface":
    case "anyPointer": {
      const bytes = v.pointerBytes;
      if (!bytes || bytes.length === 0) return undefined;
      return `new Uint8Array([${bytes.join(", ")}])`;
    }
    default:
      return undefined;
  }
}

function emitApplied(
  name: string,
  applied: AppliedAnnotation[] | undefined,
  lines: string[],
): void {
  if (!applied || applied.length === 0) return;
  const body = applied
    .map((a) => {
      const id = `0x${a.id.toString(16)}n`;
      const value = annotationValueLiteral(a.value);
      return value === undefined ? `{ id: ${id} }` : `{ id: ${id}, value: ${value} }`;
    })
    .join(", ");
  lines.push(`export const ${name}_APPLIED_ANNOTATIONS = [${body}] as const;`, ``);
}

function emitConst(node: NodeAst, lines: string[]): void {
  const c = node.const;
  if (!c) return;
  const name = ident(shortTypeName(node.displayName));
  const v = c.value;
  lines.push(
    `/** Const ${node.displayName}: ${formatType(c.type)}. */`,
  );
  switch (v.which) {
    case "void": {
      const expr = "undefined";
      lines.push(`export const ${name} = ${expr}${constAssertion(expr)};`, ``);
      emitApplied(upperSnake(name), node.appliedAnnotations, lines);
      return;
    }
    case "bool": {
      const expr = v.value ? "true" : "false";
      lines.push(`export const ${name} = ${expr}${constAssertion(expr)};`, ``);
      emitApplied(upperSnake(name), node.appliedAnnotations, lines);
      return;
    }
    case "int8":
    case "int16":
    case "int32":
    case "uint8":
    case "uint16":
    case "uint32":
    case "enum": {
      const expr = jsNumberLiteral(v.value);
      lines.push(`export const ${name} = ${expr}${constAssertion(expr)};`, ``);
      emitApplied(upperSnake(name), node.appliedAnnotations, lines);
      return;
    }
    case "int64":
    case "uint64": {
      const expr = `${v.value}n`;
      lines.push(`export const ${name} = ${expr}${constAssertion(expr)};`, ``);
      emitApplied(upperSnake(name), node.appliedAnnotations, lines);
      return;
    }
    case "float32":
    case "float64": {
      const expr = jsNumberLiteral(v.value);
      lines.push(`export const ${name} = ${expr}${constAssertion(expr)};`, ``);
      emitApplied(upperSnake(name), node.appliedAnnotations, lines);
      return;
    }
    case "text": {
      const expr = JSON.stringify(v.value);
      lines.push(`export const ${name} = ${expr}${constAssertion(expr)};`, ``);
      emitApplied(upperSnake(name), node.appliedAnnotations, lines);
      return;
    }
    case "data":
      lines.push(
        `export const ${name} = new Uint8Array([${Array.from(v.value).join(", ")}]);`,
        ``,
      );
      emitApplied(upperSnake(name), node.appliedAnnotations, lines);
      return;
    case "list":
    case "struct":
    case "interface":
    case "anyPointer": {
      if (!v.pointerBytes || v.pointerBytes.length === 0) {
        lines.push(`export const ${name} = null as const;`, ``);
        emitApplied(upperSnake(name), node.appliedAnnotations, lines);
        return;
      }
      const base = upperSnake(name);
      lines.push(
        `const ${base}_BYTES = new Uint8Array([${v.pointerBytes.join(", ")}]);`,
        `const ${base}_PTR = CapnpMessage.fromFlat(${base}_BYTES).root();`,
        `export const ${name}: Ptr = ${base}_PTR;`,
        ``,
      );
      emitApplied(upperSnake(name), node.appliedAnnotations, lines);
      return;
    }
    default:
      return;
  }
}

function emitAnnotation(node: NodeAst, lines: string[]): void {
  const a = node.annotation;
  if (!a) return;
  const base = upperSnake(ident(shortTypeName(node.displayName)));
  lines.push(
    `/** Annotation ${node.displayName}. */`,
    `export const ${base}_ANNOTATION_ID = 0x${node.id.toString(16)}n;`,
    `export const ${base}_ANNOTATION_TARGETS_MASK = ${a.targetsMask};`,
    `export const ${base}_ANNOTATION_TYPE = ${JSON.stringify(formatType(a.type))} as const;`,
    ``,
  );
  emitApplied(base, node.appliedAnnotations, lines);
}

function emitFieldGetter(
  owner: NodeAst,
  typeName: string,
  field: FieldAst,
  ctx: ModuleEmitContext,
  lines: string[],
): void {
  if (!field.slot) return;
  const fname = ident(field.name);
  const fn = `${typeName}_get${fname[0]!.toUpperCase()}${fname.slice(1)}`;
  const t = field.slot.type;
  const off = field.slot.offset;
  const dv = field.slot.defaultValue;
  const dfltExpr = scalarDefaultExpr(t.which, dv);
  const byteOff = dataByteOffset(t.which, off);
  const ptrDefaultBytes = fieldPointerDefaultBytes(field);
  const typeFmt = formatType(t);
  if (
    typeFmt.includes("brand{") ||
    typeFmt.startsWith("AnyPointer(parameter") ||
    typeFmt.startsWith("AnyPointer(implicitMethodParameter")
  ) {
    lines.push(
      `export const ${upperSnake(typeName)}_${upperSnake(fname)}_TYPE = ${JSON.stringify(typeFmt)} as const;`,
      ``,
    );
  }

  let generic = ownerGenericClause(owner);
  const recv = ownerPtrReceiver(owner, typeName);

  switch (t.which) {
    case "void":
      // No payload; union arms use which() only.
      return;
    case "bool":
      lines.push(
        `export function ${fn}${generic}(${recv}, dflt = ${dfltExpr}): boolean {`,
        `  return ptr.getBool(${off}, dflt);`,
        `}`,
        ``,
      );
      return;
    case "int8":
      // Signed: XOR bits via getU8, then sign-extend to int8.
      lines.push(
        `export function ${fn}${generic}(${recv}, dflt = ${dfltExpr}): number {`,
        `  return (ptr.getU8(${byteOff}, dflt & 0xff) << 24) >> 24;`,
        `}`,
        ``,
      );
      return;
    case "uint8":
      lines.push(
        `export function ${fn}${generic}(${recv}, dflt = ${dfltExpr}): number {`,
        `  return ptr.getU8(${byteOff}, dflt);`,
        `}`,
        ``,
      );
      return;
    case "int16":
      lines.push(
        `export function ${fn}${generic}(${recv}, dflt = ${dfltExpr}): number {`,
        `  return (ptr.getU16(${byteOff}, dflt & 0xffff) << 16) >> 16;`,
        `}`,
        ``,
      );
      return;
    case "uint16":
    case "enum":
      lines.push(
        `export function ${fn}${generic}(${recv}, dflt = ${dfltExpr}): number {`,
        `  return ptr.getU16(${byteOff}, dflt);`,
        `}`,
        ``,
      );
      return;
    case "int32":
      lines.push(
        `export function ${fn}${generic}(${recv}, dflt = ${dfltExpr}): number {`,
        `  return ptr.getU32(${byteOff}, dflt | 0) | 0;`,
        `}`,
        ``,
      );
      return;
    case "uint32":
      lines.push(
        `export function ${fn}${generic}(${recv}, dflt = ${dfltExpr}): number {`,
        `  return ptr.getU32(${byteOff}, dflt);`,
        `}`,
        ``,
      );
      return;
    case "int64":
      // CRITICAL: full u64 path (bigint). Never getU32 for 64-bit fields.
      lines.push(
        `export function ${fn}${generic}(${recv}, dflt: bigint = ${dfltExpr}): bigint {`,
        `  return BigInt.asIntN(64, ptr.getU64(${byteOff}, dflt));`,
        `}`,
        ``,
      );
      return;
    case "uint64":
      lines.push(
        `export function ${fn}${generic}(${recv}, dflt: bigint = ${dfltExpr}): bigint {`,
        `  return ptr.getU64(${byteOff}, dflt);`,
        `}`,
        ``,
      );
      return;
    case "float32":
      lines.push(
        `export function ${fn}${generic}(${recv}, dflt = ${dfltExpr}): number {`,
        `  return ptr.getF32(${byteOff}, dflt);`,
        `}`,
        ``,
      );
      return;
    case "float64":
      lines.push(
        `export function ${fn}${generic}(${recv}, dflt = ${dfltExpr}): number {`,
        `  return ptr.getF64(${byteOff}, dflt);`,
        `}`,
        ``,
      );
      return;
    case "text":
      if (field.slot.hadExplicitDefault && dv?.which === "text") {
        const dflt = `${upperSnake(typeName)}_${upperSnake(fname)}_DEFAULT`;
        lines.push(
          `const ${dflt} = ${JSON.stringify(dv.value)};`,
          `export function ${fn}${generic}(${recv}): string {`,
          `  return ptr.getText(${off}, ${dflt});`,
          `}`,
          ``,
        );
      } else {
        lines.push(
          `export function ${fn}${generic}(${recv}): string {`,
          `  return ptr.getText(${off});`,
          `}`,
          ``,
        );
      }
      return;
    case "data":
      if (field.slot.hadExplicitDefault && dv?.which === "data") {
        const dflt = `${upperSnake(typeName)}_${upperSnake(fname)}_DEFAULT`;
        lines.push(
          `const ${dflt} = new Uint8Array([${Array.from(dv.value).join(", ")}]);`,
          `export function ${fn}${generic}(${recv}): Uint8Array {`,
          `  return ptr.getData(${off}, ${dflt});`,
          `}`,
          ``,
        );
      } else {
        lines.push(
          `export function ${fn}${generic}(${recv}): Uint8Array {`,
          `  return ptr.getData(${off});`,
          `}`,
          ``,
        );
      }
      return;
    case "list":
    case "struct":
    case "interface":
    case "anyPointer": {
      let retType = "Ptr";
      if (t.which === "struct") {
        retType = ptrTypeForStruct(t.typeId, ctx, t.brand, owner);
      } else if (t.which === "interface") {
        retType = ptrTypeForInterface(t.typeId, ctx, t.brand, owner);
      } else if (t.which === "anyPointer") {
        const anyTy = anyPointerTsType(t, owner, ctx.byId);
        retType = anyTy.typeName;
        generic = ownerGenericClause(owner, anyTy.genericParam);
      }
      if (ptrDefaultBytes && ptrDefaultBytes.length > 0) {
        const dflt = `${upperSnake(typeName)}_${upperSnake(fname)}_DEFAULT`;
        lines.push(
          `const ${dflt}_BYTES = new Uint8Array([${ptrDefaultBytes.join(", ")}]);`,
          `const ${dflt}_PTR = CapnpMessage.fromFlat(${dflt}_BYTES).root();`,
          `export function ${fn}${generic}(${recv}): ${retType} {`,
          `  const p = ptr.getP(${off});`,
          `  return (p.kind === PtrKind.Null ? ${dflt}_PTR : p) as ${retType};`,
          `}`,
          ``,
        );
      } else {
        lines.push(
          `export function ${fn}${generic}(${recv}): ${retType} {`,
          `  return ptr.getP(${off}) as ${retType};`,
          `}`,
          ``,
        );
      }
      if (t.which === "list") {
        // Element access helpers for List(Struct|Text|Data).
        const elem = t.elementType;
        if (
          elem.which === "struct" ||
          elem.which === "list" ||
          elem.which === "interface"
        ) {
          const elemType =
            elem.which === "struct"
              ? ptrTypeForStruct(elem.typeId, ctx, elem.brand, owner)
              : elem.which === "interface"
                ? ptrTypeForInterface(elem.typeId, ctx, elem.brand, owner)
                : "Ptr";
          // Struct elements upgrade from primitive, text, and void lists.
          // List and interface elements are pointer 0 of that struct, which
          // is also how a composite list downgrades to a pointer list.
          const read =
            elem.which === "struct"
              ? `listGetStruct(index) as ${elemType}`
              : `listGetStruct(index).getP(0) as ${elemType}`;
          lines.push(
            `export function ${fn}Len${generic}(${recv}): number {`,
            `  return ${fn}(ptr).listLen();`,
            `}`,
            ``,
            `export function ${fn}At${generic}(${recv}, index: number): ${elemType} {`,
            `  return ${fn}(ptr).${read};`,
            `}`,
            ``,
          );
        } else if (elem.which === "text") {
          // listGetText handles List(Text) pointer elements and composite
          // downgrade (list evolution); never listGetP(i).getText(0).
          lines.push(
            `export function ${fn}Len${generic}(${recv}): number {`,
            `  return ${fn}(ptr).listLen();`,
            `}`,
            ``,
            `export function ${fn}At${generic}(${recv}, index: number): string {`,
            `  return ${fn}(ptr).listGetText(index);`,
            `}`,
            ``,
          );
        }
      }
      return;
    }
    default:
      return;
  }
}

function emitFieldSetter(
  owner: NodeAst,
  typeName: string,
  field: FieldAst,
  discriminantByte: number | undefined,
  ctx: ModuleEmitContext,
  lines: string[],
): void {
  if (!field.slot) return;
  const fname = ident(field.name);
  const fn = `${typeName}_set${fname[0]!.toUpperCase()}${fname.slice(1)}`;
  const t = field.slot.type;
  const off = field.slot.offset;
  const dfltExpr = scalarDefaultExpr(t.which, field.slot.defaultValue);
  const byteOff = dataByteOffset(t.which, off);
  const initFn = `${typeName}_init${fname[0]!.toUpperCase()}${fname.slice(1)}`;
  const select =
    discriminantByte !== undefined && field.discriminant !== NO_DISCRIMINANT
      ? [`  ptr.setU16(${discriminantByte}, ${field.discriminant});`]
      : [];

  const emit = (signature: string, write: string | undefined): void => {
    lines.push(`export function ${fn}(${signature}): void {`, ...select);
    if (write) lines.push(`  ${write}`);
    lines.push(`}`, ``);
  };

  switch (t.which) {
    case "void":
      if (select.length > 0) emit("ptr: StructBuilder", undefined);
      return;
    case "bool":
      emit(
        `ptr: StructBuilder, value: boolean, dflt = ${dfltExpr}`,
        `ptr.setBool(${off}, value, dflt);`,
      );
      return;
    case "int8":
    case "uint8":
      emit(
        `ptr: StructBuilder, value: number, dflt = ${dfltExpr}`,
        `ptr.setU8(${byteOff}, value, dflt);`,
      );
      return;
    case "int16":
    case "uint16":
    case "enum":
      emit(
        `ptr: StructBuilder, value: number, dflt = ${dfltExpr}`,
        `ptr.setU16(${byteOff}, value, dflt);`,
      );
      return;
    case "int32":
    case "uint32":
      emit(
        `ptr: StructBuilder, value: number, dflt = ${dfltExpr}`,
        `ptr.setU32(${byteOff}, value, dflt);`,
      );
      return;
    case "int64":
    case "uint64":
      emit(
        `ptr: StructBuilder, value: bigint, dflt: bigint = ${dfltExpr}`,
        `ptr.setU64(${byteOff}, value, dflt);`,
      );
      return;
    case "float32":
      emit(
        `ptr: StructBuilder, value: number, dflt = ${dfltExpr}`,
        `ptr.setF32(${byteOff}, value, dflt);`,
      );
      return;
    case "float64":
      emit(
        `ptr: StructBuilder, value: number, dflt = ${dfltExpr}`,
        `ptr.setF64(${byteOff}, value, dflt);`,
      );
      return;
    case "text":
      emit(
        `ptr: StructBuilder, value: string`,
        `ptr.setText(${off}, value);`,
      );
      return;
    case "data":
      emit(
        `ptr: StructBuilder, value: Uint8Array`,
        `ptr.setData(${off}, value);`,
      );
      return;
    case "struct": {
      const valueType = ptrTypeForStruct(t.typeId, ctx, t.brand, owner);
      const g = ownerGenericClause(owner);
      lines.push(
        `export function ${fn}${g}(ptr: StructBuilder, value: ${valueType}): void {`,
        ...select,
        `  ptr.setP(${off}, value);`,
        `}`,
        ``,
      );
      const target = ctx.byId.get(t.typeId)?.struct;
      if (target) {
        lines.push(
          `export function ${initFn}(ptr: StructBuilder): StructBuilder {`,
          ...select,
          `  return ptr.initStruct(${off}, ${target.dataWordCount}, ${target.pointerCount});`,
          `}`,
          ``,
        );
      }
      return;
    }
    case "list": {
      emit(`ptr: StructBuilder, value: Ptr`, `ptr.setP(${off}, value);`);
      const elem = t.elementType;
      const target =
        elem.which === "struct" ? ctx.byId.get(elem.typeId)?.struct : undefined;
      if (target) {
        lines.push(
          `export function ${initFn}(ptr: StructBuilder, count: number): StructBuilder {`,
          ...select,
          `  return ptr.initList(${off}, count, ${target.dataWordCount}, ${target.pointerCount});`,
          `}`,
          ``,
        );
      }
      return;
    }
    case "interface": {
      const valueType = ptrTypeForInterface(t.typeId, ctx, t.brand, owner);
      const g = ownerGenericClause(owner);
      lines.push(
        `export function ${fn}${g}(ptr: StructBuilder, value: ${valueType}): void {`,
        ...select,
        `  ptr.setP(${off}, value);`,
        `}`,
        ``,
      );
      return;
    }
    case "anyPointer": {
      const anyTy = anyPointerTsType(t, owner, ctx.byId);
      const generic = ownerGenericClause(owner, anyTy.genericParam);
      lines.push(
        `export function ${fn}${generic}(ptr: StructBuilder, value: ${anyTy.typeName}): void {`,
        ...select,
        `  ptr.setP(${off}, value);`,
        `}`,
        ``,
      );
      return;
    }
    default:
      return;
  }
}


/**
 * Typed stubs for an interface.
 *
 * A client wraps an imported capability so a call reads as
 * `adder.add(...)` rather than a raw interfaceId and methodId, and a
 * server base turns an incoming Call back into a named method. The
 * parameter and result structs are ordinary generated structs, found by
 * id, so the stub only has to carry their dimensions.
 */
/** Every superclass, direct ones first, then each of their ancestors. */
function ancestorInterfaces(node: NodeAst, ctx: ModuleEmitContext): NodeAst[] {
  const out: NodeAst[] = [];
  const seen = new Set<bigint>();
  const walk = (n: NodeAst): void => {
    for (const s of n.superclasses ?? []) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      const iface = ctx.byId.get(s.id);
      if (!iface) continue;
      out.push(iface);
      walk(iface);
    }
  };
  walk(node);
  return out;
}

/** A name from `node`'s module, qualified when that module is imported. */
function importedName(node: NodeAst, local: string, ctx: ModuleEmitContext): string {
  const fileId = ctx.ownerFileByNodeId.get(node.id);
  if (fileId === undefined || fileId === ctx.currentFileId) return local;
  const alias = ctx.importAliases.get(fileId);
  return alias ? `${alias}.${local}` : local;
}

function emitInterface(
  node: NodeAst,
  ctx: ModuleEmitContext,
  lines: string[],
): void {
  const methods = node.methods;
  if (!methods) return;
  const typeName = shortTypeName(node.displayName);
  const upper = upperSnake(typeName);

  lines.push(
    `/** Interface ${node.displayName}. */`,
    `export const ${upper}_INTERFACE_ID = 0x${node.id.toString(16)}n;`,
    paramNames(node).length > 0
      ? `export type ${typeName}_Capability<${paramNames(node)
          .map((name) => `${name} extends CapnpAnyPointer = CapnpAnyPointer`)
          .join(", ")}> = Ptr & CapnpBranded<[${paramNames(node).join(", ")}]>;`
      : `export type ${typeName}_Capability = Ptr;`,
    ``,
  );
  if (node.parameters && node.parameters.length > 0) {
    const params = node.parameters.map((p) => JSON.stringify(p)).join(", ");
    lines.push(`export const ${typeName}_typeParameters = [${params}] as const;`, ``);
  }

  // Method table: ordinal, and the shape of each struct the call moves.
  const dims = (id: bigint): { dw: number; pw: number } => {
    const n = ctx.byId.get(id);
    return {
      dw: n?.struct?.dataWordCount ?? 0,
      pw: n?.struct?.pointerCount ?? 0,
    };
  };

  lines.push(`export const ${typeName}_methods = {`);
  for (const m of methods) {
    const p = dims(m.paramStructType);
    const r = dims(m.resultStructType);
    lines.push(
      `  ${m.name}: { ordinal: ${m.ordinal},` +
        ` paramsDwords: ${p.dw}, paramsPwords: ${p.pw},` +
        ` resultsDwords: ${r.dw}, resultsPwords: ${r.pw},` +
        ` paramBrand: ${brandLiteral(m.paramBrand)},` +
        ` resultBrand: ${brandLiteral(m.resultBrand)},` +
        ` implicitParameters: [${(m.implicitParameters ?? [])
          .map((name) => JSON.stringify(name))
          .join(", ")}],` +
        ` streaming: ${m.streaming === true || m.resultStructType === 0x995f9a3377c0b16en} },`,
    );
  }
  lines.push(`} as const;`, ``);
  for (const m of methods) {
    emitApplied(`${upper}_${upperSnake(ident(m.name))}`, m.appliedAnnotations, lines);
  }
  emitApplied(upper, node.appliedAnnotations, lines);

  // Client: one method per schema method, sending on a connection.
  lines.push(
    `/** Calls ${typeName} methods on an imported capability. */`,
    `export class ${typeName}Client {`,
    `  constructor(`,
    `    private readonly conn: {`,
    `      sendCall(`,
    `        importedCapId: number,`,
    `        interfaceId: bigint,`,
    `        methodId: number,`,
    `        fillParams?: (params: StructBuilder) => void,`,
    `        paramsDwords?: number,`,
    `        paramsPwords?: number,`,
    `      ): number;`,
    `    },`,
    `    private readonly importedCapId: number,`,
    `  ) {}`,
    ``,
  );
  const ancestors = ancestorInterfaces(node, ctx);
  const ownNames = new Set(methods.map((m) => m.name));
  const seenInherited = new Set<string>(ownNames);
  const inherited: Array<{ iface: NodeAst; method: MethodAst }> = [];
  for (const iface of ancestors) {
    for (const method of iface.methods ?? []) {
      if (seenInherited.has(method.name)) continue;
      seenInherited.add(method.name);
      inherited.push({ iface, method });
    }
  }
  const emitCall = (
    ownerName: string,
    methodsRef: string,
    idRef: string,
    methodName: string,
  ): void => {
    lines.push(
      `  /** Send ${ownerName}.${methodName}; returns the questionId. */`,
      `  ${methodName}(fillParams?: (params: StructBuilder) => void): number {`,
      `    const m = ${methodsRef}.${methodName};`,
      `    return this.conn.sendCall(`,
      `      this.importedCapId,`,
      `      ${idRef},`,
      `      m.ordinal,`,
      `      fillParams,`,
      `      m.paramsDwords,`,
      `      m.paramsPwords,`,
      `    );`,
      `  }`,
      ``,
    );
  };
  for (const m of methods) {
    emitCall(typeName, `${typeName}_methods`, `${upper}_INTERFACE_ID`, m.name);
  }
  for (const { iface, method } of inherited) {
    const ownerName = shortTypeName(iface.displayName);
    emitCall(
      ownerName,
      importedName(iface, `${ownerName}_methods`, ctx),
      importedName(iface, `${upperSnake(ownerName)}_INTERFACE_ID`, ctx),
      method.name,
    );
  }
  lines.push(`}`, ``);

  const directSupers = (node.superclasses ?? [])
    .map((s) => ctx.byId.get(s.id))
    .filter((n): n is NodeAst => n !== undefined);
  const singleNode = directSupers.length === 1 ? directSupers[0] : undefined;
  const extendsClause = singleNode
    ? ` extends ${importedName(singleNode, `${shortTypeName(singleNode.displayName)}Server`, ctx)}`
    : "";

  // Server: dispatch an incoming Call to a named method.
  lines.push(
    `/** Implement ${typeName} by extending this and overriding its methods. */`,
    `export abstract class ${typeName}Server${extendsClause} {`,
  );
  const declareMethod = (m: MethodAst, owner: NodeAst): void => {
    const clause = methodTypeParamClause(m, owner, ctx);
    const paramsType = structAliasType(m.paramStructType, m.paramBrand, ctx, owner, m);
    lines.push(
      `  abstract ${m.name}${clause}(params: ${paramsType}, results: StructBuilder): void;`,
    );
  };
  for (const m of methods) declareMethod(m, node);
  if (!singleNode) {
    for (const { iface, method } of inherited) declareMethod(method, iface);
  }
  lines.push(
    ``,
    `  /** Route one Call. Throws when the id or ordinal is not ours. */`,
    `  dispatch(`,
    `    interfaceId: bigint,`,
    `    methodId: number,`,
    `    params: Ptr,`,
    `    results: StructBuilder,`,
    `  ): void {`,
    `    if (interfaceId === ${upper}_INTERFACE_ID) {`,
    `      switch (methodId) {`,
  );
  for (const m of methods) {
    lines.push(
      `        case ${m.ordinal}:`,
      `          this.${m.name}(params, results);`,
      `          return;`,
    );
  }
  lines.push(
    `        default:`,
    unimplementedMethod(node),
    `      }`,
    `    }`,
  );
  if (singleNode) {
    const checks = ancestors
      .map((iface) => {
        const ownerName = shortTypeName(iface.displayName);
        const idRef = importedName(iface, `${upperSnake(ownerName)}_INTERFACE_ID`, ctx);
        return `interfaceId === ${idRef}`;
      })
      .join(" || ");
    if (checks.length > 0) {
      lines.push(
        `    if (${checks}) {`,
        `      super.dispatch(interfaceId, methodId, params, results);`,
        `      return;`,
        `    }`,
      );
    }
    lines.push(
      "    throw Object.assign(new Error(" +
        JSON.stringify(
          "Requested interface not implemented.; actualInterfaceName = " +
            node.displayName +
            "; requestedTypeId = ",
        ) +
        " + interfaceId), { type: \"unimplemented\" });",
    );
  } else {
    for (const iface of ancestors) {
      const ownerName = shortTypeName(iface.displayName);
      const idRef = importedName(iface, `${upperSnake(ownerName)}_INTERFACE_ID`, ctx);
      const mine = iface.methods ?? [];
      lines.push(
        `    if (interfaceId === ${idRef}) {`,
        `      switch (methodId) {`,
      );
      for (const m of mine) {
        lines.push(
          `        case ${m.ordinal}:`,
          `          this.${m.name}(params, results);`,
          `          return;`,
        );
      }
      lines.push(
        `        default:`,
        unimplementedMethod(iface),
        `      }`,
        `    }`,
      );
    }
    lines.push(
      "    throw Object.assign(new Error(" +
        JSON.stringify(
          "Requested interface not implemented.; actualInterfaceName = " + node.displayName + "; requestedTypeId = ",
        ) +
        " + interfaceId), { type: \"unimplemented\" });",
    );
  }
  lines.push(`  }`, `}`, ``);
}

/** Unknown method, naming the interface the call addressed. */
function unimplementedMethod(node: NodeAst): string {
  const prefix = JSON.stringify(
    "Method not implemented.; interfaceName = " +
      node.displayName +
      "; typeId = " +
      node.id.toString() +
      "; methodId = ",
  );
  return (
    "          throw Object.assign(new Error(" +
    prefix +
    " + methodId), { type: \"unimplemented\" });"
  );
}

/** Zero a group's slots so a union switch does not keep the previous arm. */
function groupZeroLines(typeId: bigint, ctx: ModuleEmitContext): string[] {
  const struct = ctx.byId.get(typeId)?.struct;
  const fields = struct?.fields ?? [];
  const lines: string[] = [];
  // A nested union's discriminant lives in the parent struct. Zero it with the group.
  if (struct !== undefined && struct.discriminantCount > 0) {
    lines.push(`  ptr.setU16(${struct.discriminantOffset * 2}, 0);`);
  }
  for (const field of fields) {
    if (field.group) {
      lines.push(...groupZeroLines(field.group.typeId, ctx));
      continue;
    }
    const slot = field.slot;
    if (!slot) continue;
    const which = slot.type.which;
    const byte = dataByteOffset(which, slot.offset);
    switch (which) {
      case "void":
        break;
      case "bool":
        lines.push(`  ptr.setBool(${slot.offset}, false, false);`);
        break;
      case "int8":
      case "uint8":
        lines.push(`  ptr.setU8(${byte}, 0);`);
        break;
      case "int16":
      case "uint16":
      case "enum":
        lines.push(`  ptr.setU16(${byte}, 0);`);
        break;
      case "int32":
      case "uint32":
        lines.push(`  ptr.setU32(${byte}, 0);`);
        break;
      case "float32":
        lines.push(`  ptr.setF32(${byte}, 0);`);
        break;
      case "int64":
      case "uint64":
        lines.push(`  ptr.setU64(${byte}, 0n);`);
        break;
      case "float64":
        lines.push(`  ptr.setF64(${byte}, 0);`);
        break;
      default:
        lines.push(`  ptr.clearPointer(${slot.offset});`);
        break;
    }
  }
  return lines;
}

function emitStruct(
  node: NodeAst,
  ctx: ModuleEmitContext,
  lines: string[],
): void {
  const s = node.struct;
  if (!s) return;
  const typeName = shortTypeName(node.displayName);
  const upper = upperSnake(typeName);

  lines.push(
    `/** Struct ${node.displayName}` +
      (s.isGroup ? " (group / union overlay)" : "") +
      `. */`,
  );
  lines.push(`export const ${upper}_DWORDS = ${s.dataWordCount};`);
  lines.push(`export const ${upper}_PWORDS = ${s.pointerCount};`);
  lines.push(`export const ${typeName}_dataWordCount = ${s.dataWordCount};`);
  lines.push(`export const ${typeName}_pointerCount = ${s.pointerCount};`);
  const names = effectiveParamNames(node, ctx);
  const owner = nodeWithParams(node, names);
  if (names.length > 0) {
    const clause = names
      .map((name) => `${name} extends CapnpAnyPointer = CapnpAnyPointer`)
      .join(", ");
    lines.push(
      `export type ${typeName}_Ptr<${clause}> = Ptr & CapnpBranded<[${names.join(", ")}]>;`,
    );
  } else {
    lines.push(`export type ${typeName}_Ptr = Ptr;`);
  }
  if (names.length > 0) {
    const params = names.map((p) => JSON.stringify(p)).join(", ");
    lines.push(`export const ${typeName}_typeParameters = [${params}] as const;`);
  }

  let discriminantByte: number | undefined;
  if (s.discriminantCount > 0) {
    // discriminantOffset is in 16-bit units → byte offset * 2.
    const discByte = (s.discriminantOffset * 2) >>> 0;
    discriminantByte = discByte;
    lines.push(
      `/** Union discriminant byte offset (u16). */`,
      `export const ${typeName}_discriminantOffset = ${discByte};`,
      `export function ${typeName}_which${ownerGenericClause(owner)}(ptr: ${
        names.length > 0 ? `${typeName}_Ptr<${names.join(", ")}>` : "Ptr"
      }): number {`,
      `  return ptr.getU16(${discByte});`,
      `}`,
    );
    // Arm tag constants from fields that carry a discriminant.
    const tags: { name: string; tag: number }[] = [];
    for (const f of s.fields) {
      if (f.discriminant !== NO_DISCRIMINANT) {
        tags.push({ name: ident(f.name), tag: f.discriminant });
      }
    }
    if (tags.length > 0) {
      lines.push(`export const ${typeName} = {`);
      for (const t of tags) {
        lines.push(`  ${t.name}: ${t.tag},`);
      }
      lines.push(`} as const;`);
      lines.push(
        `export type ${typeName} = (typeof ${typeName})[keyof typeof ${typeName}];`,
      );
    }
    lines.push(``);
  } else {
    lines.push(``);
  }

  for (const f of s.fields) {
    if (f.group) {
      // Group field: same Ptr as parent; which/getters live on the group node.
      const gName = ident(f.name);
      const initFn = `${typeName}_init${gName[0]!.toUpperCase()}${gName.slice(1)}`;
      const selectGroup =
        discriminantByte !== undefined && f.discriminant !== NO_DISCRIMINANT
          ? [`  ptr.setU16(${discriminantByte}, ${f.discriminant});`]
          : [];
      const recvType =
        names.length > 0 ? `${typeName}_Ptr<${names.join(", ")}>` : "Ptr";
      const cleared = groupZeroLines(f.group.typeId, ctx);
      lines.push(
        `/** Group field \`${f.name}\` — same wire Ptr as parent; see group node helpers. */`,
        `export function ${typeName}_get${gName[0]!.toUpperCase()}${gName.slice(1)}${ownerGenericClause(owner)}(ptr: ${recvType}): ${recvType} {`,
        `  return ptr;`,
        `}`,
        ``,
        `export function ${initFn}(ptr: StructBuilder): StructBuilder {`,
        ...cleared,
        ...selectGroup,
        `  return ptr;`,
        `}`,
        ``,
      );
      continue;
    }
    emitFieldGetter(owner, typeName, f, ctx, lines);
    emitFieldSetter(owner, typeName, f, discriminantByte, ctx, lines);
    emitApplied(`${upper}_${upperSnake(ident(f.name))}`, f.appliedAnnotations, lines);
  }
  for (const f of s.fields) {
    if (!f.group) continue;
    emitApplied(`${upper}_${upperSnake(ident(f.name))}`, f.appliedAnnotations, lines);
  }
  emitApplied(upper, node.appliedAnnotations, lines);
}

/**
 * Files that own a superclass of an emitted interface, including ancestors.
 * Those modules export the server class, method table, and interface id.
 */
function superclassOwnerFiles(
  nodes: NodeAst[],
  byId: Map<bigint, NodeAst>,
  ownerFileByNodeId: Map<bigint, bigint>,
  currentFileId: bigint,
): Set<bigint> {
  const owners = new Set<bigint>();
  const seen = new Set<bigint>();
  const walk = (id: bigint): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const owner = ownerFileByNodeId.get(id);
    if (owner !== undefined && owner !== 0n && owner !== currentFileId) owners.add(owner);
    const iface = byId.get(id);
    if (!iface) return;
    for (const s of iface.superclasses ?? []) walk(s.id);
  };
  for (const n of nodes) {
    for (const s of n.superclasses ?? []) walk(s.id);
  }
  return owners;
}

/**
 * Emit one TypeScript module source for a requested schema file.
 */
export function emitModuleSource(
  ast: CgrAst,
  schemaPath: string,
  fileId?: bigint,
): string {
  const resolvedId =
    fileId ??
    ast.requestedFiles.find((f) => f.filename === schemaPath)?.id ??
    ast.requestedFiles[0]?.id ??
    0n;

  const nodes =
    resolvedId === 0n
      ? ast.nodes.filter((n) => n.which !== "file")
      : nodesForFile(ast, resolvedId);
  // Every node, not just emitted ones: field and method types can refer to
  // imported nodes whose dimensions or aliases are still needed.
  const byId = new Map(ast.nodes.map((n) => [n.id, n]));
  const ownerFileByNodeId = buildOwnerFileMap(ast, byId);
  const requestedById = new Map(ast.requestedFiles.map((rf) => [rf.id, rf.filename]));
  const currentRequest = ast.requestedFiles.find((rf) => rf.id === resolvedId);
  const importNameById = new Map<bigint, string>();
  for (const imp of currentRequest?.imports ?? []) {
    if (!importNameById.has(imp.id)) importNameById.set(imp.id, imp.name);
  }
  const fileNameById = new Map<bigint, string>();
  for (const n of ast.nodes) {
    if (n.which === "file" && n.displayName) fileNameById.set(n.id, n.displayName);
  }
  const superclassOwners = superclassOwnerFiles(nodes, byId, ownerFileByNodeId, resolvedId);

  const referencedTypeIds = new Set<bigint>();
  for (const n of nodes) collectNodeTypeRefs(n, referencedTypeIds, byId);

  const valueImportOwners = new Set<bigint>();
  for (const typeId of referencedTypeIds) {
    const n = byId.get(typeId);
    if (n?.which !== "interface") continue;
    const owner = ownerFileByNodeId.get(typeId);
    if (owner !== undefined && owner !== resolvedId) valueImportOwners.add(owner);
  }

  const externalImports: Array<{ schemaPath: string; alias: string; fileId: bigint }> = [];
  const importAliases = new Map<bigint, string>();
  for (const typeId of referencedTypeIds) {
    const owner = ownerFileByNodeId.get(typeId);
    if (!owner || owner === 0n || owner === resolvedId) continue;
    if (importAliases.has(owner)) continue;
    let importSchema = requestedById.get(owner);
    if (importSchema === undefined && superclassOwners.has(owner)) {
      // capnpc-c++ includes RequestedFile.imports whose id was used.
      // An ancestor file that this file did not import still has a
      // display name, and the generated server names that file's bindings.
      importSchema = importNameById.get(owner) ?? fileNameById.get(owner);
    }
    if (!importSchema) continue;
    const alias = `__capnp_${owner.toString(16)}`;
    importAliases.set(owner, alias);
    externalImports.push({ schemaPath: importSchema, alias, fileId: owner });
  }

  // A type from a file that was not requested has no module to import.
  // Declare the pointer alias here so the reference type-checks. The short
  // name is the one capnpc-c++ would use inside that file's namespace. If
  // this file already has that name, qualify with the other file's stem,
  // then append "_" until the identifier is free (the keyword rename).
  const localExternalAliases: string[] = [];
  const externalAliasNames = new Map<bigint, string>();
  const usedAliasNames = new Set<string>();
  for (const n of nodes) {
    const short = shortTypeName(n.displayName);
    if (!short) continue;
    usedAliasNames.add(short);
    usedAliasNames.add(`${short}_Ptr`);
    usedAliasNames.add(`${short}_Capability`);
    usedAliasNames.add(`${short}Client`);
    usedAliasNames.add(`${short}Server`);
  }
  const emittedIds = new Set(nodes.map((n) => n.id));
  let needsLocalGenericAlias = false;
  for (const typeId of referencedTypeIds) {
    const n = byId.get(typeId);
    if (!n || (n.which !== "struct" && n.which !== "interface")) continue;
    if (emittedIds.has(typeId)) continue;
    const owner = ownerFileByNodeId.get(typeId) ?? 0n;
    if (owner === resolvedId) continue;
    if (owner !== 0n && importAliases.has(owner)) continue;
    const suffix = n.which === "interface" ? "_Capability" : "_Ptr";
    const short = shortTypeName(n.displayName);
    let key = `${short}${suffix}`;
    if (usedAliasNames.has(key)) {
      key = `${schemaFileStem(n.displayName)}_${key}`;
      while (usedAliasNames.has(key)) key = `${key}_`;
    }
    usedAliasNames.add(key);
    externalAliasNames.set(typeId, key);
    const names = paramNames(n);
    if (names.length > 0) {
      needsLocalGenericAlias = true;
      const clause = names
        .map((name) => `${name} extends CapnpAnyPointer = CapnpAnyPointer`)
        .join(", ");
      localExternalAliases.push(
        `export type ${key}<${clause}> = Ptr & CapnpBranded<[${names.join(", ")}]>;`,
      );
    } else {
      localExternalAliases.push(`export type ${key} = Ptr;`);
    }
  }
  externalImports.sort((a, b) => a.schemaPath.localeCompare(b.schemaPath));

  const ctx: ModuleEmitContext = {
    byId,
    ownerFileByNodeId,
    currentFileId: resolvedId,
    importAliases,
    externalAliasNames,
  };

  const hasPointerFieldDefaults = nodes.some(
    (n) =>
      n.which === "struct" &&
      (n.struct?.fields ?? []).some((f) => !!fieldPointerDefaultBytes(f)),
  );
  const needsMessageImport =
    hasPointerFieldDefaults ||
    nodes.some(
      (n) => n.which === "const" && !!n.const && isPointerValue(n.const.value),
    );
  const needsPtrKindImport = hasPointerFieldDefaults;
  const needsAnyPointerWrappers = nodes.some(
    (n) =>
      n.which === "struct" &&
      (n.struct?.fields ?? []).some(
        (f) => f.slot?.type.which === "anyPointer",
      ),
  );

  const lines: string[] = [];
  lines.push(`/**`);
  lines.push(` * Generated by @haozeke/capnpc-ts. Do not hand-edit.`);
  lines.push(` *`);
  lines.push(` * Source schema: ${schemaPath}`);
  lines.push(
    ` * CodeGeneratorRequest: nodes=${ast.nodes.length}, requestedFiles=${ast.requestedFiles.length}`,
  );
  lines.push(
    ` * File id: 0x${resolvedId.toString(16)} (emitted ${nodes.length} nested nodes)`,
  );
  lines.push(` *`);
  lines.push(
    ` * Enums are const maps (Bun strip-safe). UInt64/Int64 use getU64/bigint.`,
  );
  lines.push(` */`);
  lines.push(``);
  // StructBuilder is referenced by generated setters and interface stubs.
  // Keep enum-only modules free of an unused type import.
  const hasInterface = nodes.some((n) => n.which === "interface");
  const hasStruct = nodes.some((n) => n.which === "struct");
  lines.push(
    hasInterface || hasStruct
      ? `import type { Ptr, StructBuilder } from "@haozeke/capnp";`
      : `import type { Ptr } from "@haozeke/capnp";`,
  );
  const runtimeValueImports: string[] = [];
  if (needsMessageImport) runtimeValueImports.push("Message as CapnpMessage");
  if (needsPtrKindImport) runtimeValueImports.push("PtrKind");
  if (runtimeValueImports.length > 0) {
    lines.push(
      `import { ${runtimeValueImports.join(", ")} } from "@haozeke/capnp";`,
    );
  }
  for (const imp of externalImports) {
    const kind = valueImportOwners.has(imp.fileId) ? "import" : "import type";
    lines.push(
      `${kind} * as ${imp.alias} from ${JSON.stringify(`./${outputNameForSchema(imp.schemaPath)}`)};`,
    );
  }
  lines.push(``);
  lines.push(
    `export const __capnpcTsMeta = {`,
    `  schemaPath: ${JSON.stringify(schemaPath)},`,
    `  nodeCount: ${ast.nodes.length},`,
    `  requestedFileCount: ${ast.requestedFiles.length},`,
    `  fileId: 0x${resolvedId.toString(16)}n,`,
    `  emittedNodes: ${nodes.length},`,
    `} as const;`,
    ``,
  );
  const fileNode = ast.nodes.find((n) => n.id === resolvedId && n.which === "file");
  emitApplied("FILE", fileNode?.appliedAnnotations, lines);
  const needsBrandHelpers =
    needsLocalGenericAlias ||
    nodes.some((n) => (n.parameters?.length ?? 0) > 0 || nodeMentionsBrand(n));
  if (needsAnyPointerWrappers || needsBrandHelpers) {
    lines.push(
      `export type CapnpAnyPointer = Ptr;`,
      `export type CapnpAnyStruct = Ptr;`,
      `export type CapnpAnyList = Ptr;`,
      `export type CapnpCapability = Ptr;`,
    );
    if (needsBrandHelpers) {
      lines.push(
        `export type CapnpBranded<T> = { readonly __capnpBrand?: T };`,
        `export type CapnpText = Ptr;`,
        `export type CapnpData = Ptr;`,
        `export type CapnpList<T = CapnpAnyPointer> = Ptr & CapnpBranded<[T]>;`,
      );
    }
    lines.push(``);
  }
  if (localExternalAliases.length > 0) {
    lines.push(...localExternalAliases, ``);
  }

  // Enums first (referenced by struct field comments / types).
  for (const n of nodes) {
    if (n.which === "enum") emitEnum(n, lines);
  }
  for (const n of nodes) {
    if (n.which === "const") emitConst(n, lines);
  }
  for (const n of nodes) {
    if (n.which === "annotation") emitAnnotation(n, lines);
  }
  for (const n of nodes) {
    if (n.which === "struct") emitStruct(n, ctx, lines);
  }

  for (const n of nodes) {
    if (n.which === "interface") emitInterface(n, ctx, lines);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public write API
// ---------------------------------------------------------------------------

/**
 * Write typed modules for each requested file under `outDir` (default cwd).
 */
export function emitFromAst(
  ast: CgrAst,
  outDir: string = process.cwd(),
): EmitResult {
  const written: string[] = [];
  const files =
    ast.requestedFiles.length > 0
      ? ast.requestedFiles
      : [{ id: 0n, filename: "codegen-request.capnp" }];

  for (const rf of files) {
    const schemaPath = rf.filename || "codegen-request.capnp";
    const name = outputNameForSchema(schemaPath);
    const dest = join(outDir, name);
    const src = emitModuleSource(ast, schemaPath, rf.id);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, src, "utf8");
    written.push(dest);
  }

  return { written };
}

/**
 * Single-module string emit (tests / dry-run). Prefers first requested filename.
 */
export function emitSourceString(ast: CgrAst): string {
  const schemaPath =
    ast.requestedFiles[0]?.filename ?? "codegen-request.capnp";
  const fileId = ast.requestedFiles[0]?.id;
  return emitModuleSource(ast, schemaPath, fileId);
}

// ---------------------------------------------------------------------------
// Backward-compat aliases (summary-only callers during migration)
// ---------------------------------------------------------------------------

import type { CgrSummary } from "./cgr-walk.ts";

/**
 * @deprecated Prefer emitFromAst(walkCgr(...)). Summary-only path cannot emit
 * typed getters; writes a minimal meta module for smoke continuity.
 */
export function emitStubModule(
  summary: CgrSummary,
  schemaPath: string,
): string {
  const out = outputNameForSchema(schemaPath);
  return [
    `/**`,
    ` * Generated by @haozeke/capnpc-ts (meta-only; no AST). Do not hand-edit.`,
    ` *`,
    ` * Source schema: ${schemaPath}`,
    ` * CodeGeneratorRequest: nodes=${summary.nodeCount}, requestedFiles=${summary.requestedFileCount}`,
    ` *`,
    ` * Call emitFromAst with a full CGR walk for typed struct/enum emit.`,
    ` */`,
    ``,
    `// Output target: ${out}`,
    `export const __capnpcTsMeta = {`,
    `  schemaPath: ${JSON.stringify(schemaPath)},`,
    `  nodeCount: ${summary.nodeCount},`,
    `  requestedFileCount: ${summary.requestedFileCount},`,
    `} as const;`,
    ``,
  ].join("\n");
}

/** @deprecated Prefer emitFromAst. */
export function emitFromSummary(
  summary: CgrSummary,
  outDir: string = process.cwd(),
): EmitResult {
  const written: string[] = [];
  const paths =
    summary.requestedFilenames.length > 0
      ? summary.requestedFilenames
      : ["codegen-request.capnp"];

  for (const schemaPath of paths) {
    const name = outputNameForSchema(schemaPath || "codegen-request.capnp");
    const dest = join(outDir, name);
    const src = emitStubModule(summary, schemaPath || "(unknown)");
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, src, "utf8");
    written.push(dest);
  }

  return { written };
}
