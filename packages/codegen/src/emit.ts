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
  CgrAst,
  FieldAst,
  NodeAst,
  TypeAst,
  ValueAst,
} from "./cgr-walk.ts";
import { NO_DISCRIMINANT } from "./cgr-walk.ts";
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
}

function emitFieldGetter(
  typeName: string,
  field: FieldAst,
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

  switch (t.which) {
    case "void":
      // No payload; union arms use which() only.
      return;
    case "bool":
      lines.push(
        `export function ${fn}(ptr: Ptr, dflt = ${dfltExpr}): boolean {`,
        `  return ptr.getBool(${off}, dflt);`,
        `}`,
        ``,
      );
      return;
    case "int8":
      // Signed: XOR bits via getU8, then sign-extend to int8.
      lines.push(
        `export function ${fn}(ptr: Ptr, dflt = ${dfltExpr}): number {`,
        `  return (ptr.getU8(${byteOff}, dflt & 0xff) << 24) >> 24;`,
        `}`,
        ``,
      );
      return;
    case "uint8":
      lines.push(
        `export function ${fn}(ptr: Ptr, dflt = ${dfltExpr}): number {`,
        `  return ptr.getU8(${byteOff}, dflt);`,
        `}`,
        ``,
      );
      return;
    case "int16":
      lines.push(
        `export function ${fn}(ptr: Ptr, dflt = ${dfltExpr}): number {`,
        `  return (ptr.getU16(${byteOff}, dflt & 0xffff) << 16) >> 16;`,
        `}`,
        ``,
      );
      return;
    case "uint16":
    case "enum":
      lines.push(
        `export function ${fn}(ptr: Ptr, dflt = ${dfltExpr}): number {`,
        `  return ptr.getU16(${byteOff}, dflt);`,
        `}`,
        ``,
      );
      return;
    case "int32":
      lines.push(
        `export function ${fn}(ptr: Ptr, dflt = ${dfltExpr}): number {`,
        `  return ptr.getU32(${byteOff}, dflt | 0) | 0;`,
        `}`,
        ``,
      );
      return;
    case "uint32":
      lines.push(
        `export function ${fn}(ptr: Ptr, dflt = ${dfltExpr}): number {`,
        `  return ptr.getU32(${byteOff}, dflt);`,
        `}`,
        ``,
      );
      return;
    case "int64":
      // CRITICAL: full u64 path (bigint). Never getU32 for 64-bit fields.
      lines.push(
        `export function ${fn}(ptr: Ptr, dflt: bigint = ${dfltExpr}): bigint {`,
        `  return BigInt.asIntN(64, ptr.getU64(${byteOff}, dflt));`,
        `}`,
        ``,
      );
      return;
    case "uint64":
      lines.push(
        `export function ${fn}(ptr: Ptr, dflt: bigint = ${dfltExpr}): bigint {`,
        `  return ptr.getU64(${byteOff}, dflt);`,
        `}`,
        ``,
      );
      return;
    case "float32":
      lines.push(
        `export function ${fn}(ptr: Ptr, dflt = ${dfltExpr}): number {`,
        `  return ptr.getF32(${byteOff}, dflt);`,
        `}`,
        ``,
      );
      return;
    case "float64":
      lines.push(
        `export function ${fn}(ptr: Ptr, dflt = ${dfltExpr}): number {`,
        `  return ptr.getF64(${byteOff}, dflt);`,
        `}`,
        ``,
      );
      return;
    case "text":
      lines.push(
        `export function ${fn}(ptr: Ptr): string {`,
        `  return ptr.getText(${off});`,
        `}`,
        ``,
      );
      return;
    case "data":
      lines.push(
        `export function ${fn}(ptr: Ptr): Uint8Array {`,
        `  return ptr.getData(${off});`,
        `}`,
        ``,
      );
      return;
    case "list":
    case "struct":
    case "interface":
    case "anyPointer":
      lines.push(
        `export function ${fn}(ptr: Ptr): Ptr {`,
        `  return ptr.getP(${off});`,
        `}`,
        ``,
      );
      if (t.which === "list") {
        // Element access helpers for List(Struct|Text|Data).
        const elem = t.elementType;
        if (elem.which === "struct" || elem.which === "list") {
          lines.push(
            `export function ${fn}Len(ptr: Ptr): number {`,
            `  return ptr.getP(${off}).listLen();`,
            `}`,
            ``,
            `export function ${fn}At(ptr: Ptr, index: number): Ptr {`,
            `  return ptr.getP(${off}).listGetP(index);`,
            `}`,
            ``,
          );
        } else if (elem.which === "text") {
          // listGetText handles List(Text) pointer elements and composite
          // downgrade (list evolution); never listGetP(i).getText(0).
          lines.push(
            `export function ${fn}Len(ptr: Ptr): number {`,
            `  return ptr.getP(${off}).listLen();`,
            `}`,
            ``,
            `export function ${fn}At(ptr: Ptr, index: number): string {`,
            `  return ptr.getP(${off}).listGetText(index);`,
            `}`,
            ``,
          );
        }
      }
      return;
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
function emitInterface(
  node: NodeAst,
  byId: Map<bigint, NodeAst>,
  lines: string[],
): void {
  const methods = node.methods;
  if (!methods) return;
  const typeName = shortTypeName(node.displayName);
  const upper = upperSnake(typeName);

  lines.push(
    `/** Interface ${node.displayName}. */`,
    `export const ${upper}_INTERFACE_ID = 0x${node.id.toString(16)}n;`,
    ``,
  );

  // Method table: ordinal, and the shape of each struct the call moves.
  const dims = (id: bigint): { dw: number; pw: number } => {
    const n = byId.get(id);
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
        ` resultsDwords: ${r.dw}, resultsPwords: ${r.pw} },`,
    );
  }
  lines.push(`} as const;`, ``);

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
  for (const m of methods) {
    lines.push(
      `  /** Send ${typeName}.${m.name}; returns the questionId. */`,
      `  ${m.name}(fillParams?: (params: StructBuilder) => void): number {`,
      `    const m = ${typeName}_methods.${m.name};`,
      `    return this.conn.sendCall(`,
      `      this.importedCapId,`,
      `      ${upper}_INTERFACE_ID,`,
      `      m.ordinal,`,
      `      fillParams,`,
      `      m.paramsDwords,`,
      `      m.paramsPwords,`,
      `    );`,
      `  }`,
      ``,
    );
  }
  lines.push(`}`, ``);

  // Server: dispatch an incoming Call to a named method.
  lines.push(
    `/** Implement ${typeName} by extending this and overriding its methods. */`,
    `export abstract class ${typeName}Server {`,
  );
  for (const m of methods) {
    lines.push(
      `  abstract ${m.name}(params: Ptr, results: StructBuilder): void;`,
    );
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
    `    if (interfaceId !== ${upper}_INTERFACE_ID) {`,
    '      throw new Error(`' + typeName + ': wrong interface ${interfaceId}`);',
    `    }`,
    `    switch (methodId) {`,
  );
  for (const m of methods) {
    lines.push(
      `      case ${m.ordinal}:`,
      `        this.${m.name}(params, results);`,
      `        return;`,
    );
  }
  lines.push(
    `      default:`,
    '        throw new Error(`' + typeName + ': no method ${methodId}`);',
    `    }`,
    `  }`,
    `}`,
    ``,
  );
}

function emitStruct(node: NodeAst, lines: string[]): void {
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

  if (s.discriminantCount > 0) {
    // discriminantOffset is in 16-bit units → byte offset * 2.
    const discByte = (s.discriminantOffset * 2) >>> 0;
    lines.push(
      `/** Union discriminant byte offset (u16). */`,
      `export const ${typeName}_discriminantOffset = ${discByte};`,
      `export function ${typeName}_which(ptr: Ptr): number {`,
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
      lines.push(
        `/** Group field \`${f.name}\` — same wire Ptr as parent; see group node helpers. */`,
        `export function ${typeName}_get${gName[0]!.toUpperCase()}${gName.slice(1)}(ptr: Ptr): Ptr {`,
        `  return ptr;`,
        `}`,
        ``,
      );
      continue;
    }
    emitFieldGetter(typeName, f, lines);
  }
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
  // StructBuilder is only referenced by interface stubs, so it is only
  // imported when the file has one; an unused type import would trip a
  // consumer's lint.
  const hasInterface = nodes.some((n) => n.which === "interface");
  lines.push(
    hasInterface
      ? `import type { Ptr, StructBuilder } from "@haozeke/capnp";`
      : `import type { Ptr } from "@haozeke/capnp";`,
  );
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

  // Enums first (referenced by struct field comments / types).
  for (const n of nodes) {
    if (n.which === "enum") emitEnum(n, lines);
  }
  for (const n of nodes) {
    if (n.which === "struct") emitStruct(n, lines);
  }

  // Every node, not just the emitted ones: a method's parameter struct is
  // an implicit node that the file filter drops, and its dimensions are
  // exactly what the stub needs.
  const byId = new Map(ast.nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    if (n.which === "interface") emitInterface(n, byId, lines);
  }

  // Consts and annotations are not emitted.
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
