/** @haozeke/capnpc-ts - Cap'n Proto schema compiler plugin for TypeScript. */

export { main } from "./plugin.ts";
export {
  summarizeCgr,
  summarizeViaHandWalk,
  parseFramedSegments,
  type CgrSummary,
} from "./cgr-walk.ts";
export {
  emitFromSummary,
  emitSourceString,
  emitStubModule,
  outputNameForSchema,
  type EmitResult,
} from "./emit.ts";
