/**
 * capnpc-ts entry: read framed CodeGeneratorRequest from stdin or a file arg,
 * walk full CGR AST (Message.fromFlat), emit typed TypeScript modules.
 *
 * Usage (from repo root or any cwd):
 *   capnp compile -o./packages/codegen/bin/capnpc-ts schema.capnp
 *
 * Offline:
 *   capnp compile -o- schema.capnp > req.cgr.bin
 *   ./packages/codegen/bin/capnpc-ts req.cgr.bin
 */

import { readFileSync } from "node:fs";
import {
  walkCgr,
  summaryFromAst,
  type CgrAst,
} from "./cgr-walk.ts";
import { emitFromAst, emitSourceString } from "./emit.ts";

async function readInput(argv: string[]): Promise<Uint8Array> {
  const fileArg = argv.find((a) => a !== "--stdout" && a !== "-");
  if (fileArg) {
    return new Uint8Array(readFileSync(fileArg));
  }
  const { stdin } = process;
  if (stdin.isTTY) {
    throw new Error(
      "capnpc-ts: no file argument and stdin is a TTY.\n" +
        "  Pass a framed CodeGeneratorRequest file, or pipe from capnp:\n" +
        "    capnp compile -o./packages/codegen/bin/capnpc-ts schema.capnp\n" +
        "    capnp compile -o- schema.capnp > req.cgr.bin && capnpc-ts req.cgr.bin",
    );
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Open CGR via Message.fromFlat walk. On total failure, dump byte length and exit 1.
 */
async function openCgr(bytes: Uint8Array): Promise<CgrAst> {
  let hasMessage = false;
  try {
    const capnp = await import("@haozeke/capnp");
    hasMessage = typeof (capnp as { Message?: unknown }).Message === "function";
  } catch {
    hasMessage = false;
  }

  try {
    return await walkCgr(bytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `capnpc-ts: cannot open CodeGeneratorRequest (${bytes.length} bytes).`,
    );
    console.error(`  ${msg}`);
    if (!hasMessage) {
      console.error(
        "  @haozeke/capnp Message/fromFlat is not importable; CGR walk failed.",
      );
    } else {
      console.error("  Message.fromFlat CGR walk failed on this buffer.");
    }
    console.error(
      "  Usage: capnp compile -o./packages/codegen/bin/capnpc-ts schema.capnp",
    );
    process.exitCode = 1;
    throw err;
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let bytes: Uint8Array;
  try {
    bytes = await readInput(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
    return;
  }

  if (bytes.length === 0) {
    console.error(
      "capnpc-ts: empty input (0 bytes). Expected framed CodeGeneratorRequest.",
    );
    console.error(
      "  Usage: capnp compile -o./packages/codegen/bin/capnpc-ts schema.capnp",
    );
    process.exitCode = 1;
    return;
  }

  let ast: CgrAst;
  try {
    ast = await openCgr(bytes);
  } catch {
    console.error(`capnpc-ts: input byte length = ${bytes.length}`);
    return;
  }

  const summary = summaryFromAst(ast);
  console.error(
    `capnpc-ts: CGR ok - nodes=${summary.nodeCount}, requestedFiles=${summary.requestedFileCount}` +
      (summary.requestedFilenames.length
        ? ` (${summary.requestedFilenames.join(", ")})`
        : ""),
  );

  const dry = argv.includes("--stdout");
  if (dry) {
    process.stdout.write(emitSourceString(ast));
    return;
  }

  const result = emitFromAst(ast, process.cwd());
  for (const p of result.written) {
    console.error(`capnpc-ts: wrote ${p}`);
  }
}

if (import.meta.main) {
  await main();
}
