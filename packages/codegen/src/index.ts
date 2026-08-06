/** @haozeke/capnpc-ts - Cap'n Proto schema compiler plugin for TypeScript. */

export { main } from "./plugin.ts";
export {
  summarizeCgr,
  summarizeViaHandWalk,
  parseFramedSegments,
  walkCgr,
  summaryFromAst,
  formatCgrAst,
  formatNode,
  formatType,
  NO_DISCRIMINANT,
  type CgrSummary,
  type CgrAst,
  type NodeAst,
  type FieldAst,
  type TypeAst,
  type EnumerantAst,
  type StructNodeAst,
  type RequestedFileAst,
} from "./cgr-walk.ts";
export {
  emitFromAst,
  emitFromSummary,
  emitSourceString,
  emitStubModule,
  emitModuleSource,
  outputNameForSchema,
  nodesForFile,
  shortTypeName,
  type EmitResult,
} from "./emit.ts";
