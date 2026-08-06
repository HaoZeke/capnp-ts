/**
 * capnpc-ts entry: read framed CodeGeneratorRequest from stdin or a file arg,
 * open CGR (Message.fromFlat when available, else hand-offset walk), emit stubs.
 *
 * Usage (from repo root or any cwd):
 *   capnp compile -o./packages/codegen/bin/capnpc-ts schema.capnp
 *
 * Offline:
 *   capnp compile -o- schema.capnp > req.cgr.bin
 *   ./packages/codegen/bin/capnpc-ts req.cgr.bin
 */

import { readFileSync } from "node:fs";
import { summarizeCgr, type CgrSummary } from "./cgr-walk.ts";
import { emitFromSummary, emitSourceString } from "./emit.ts";

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
 * Open CGR: try @haozeke/capnp Message.fromFlat, then hand walk.
 * On total failure, dump byte length and exit 1 with a helpful message.
 */
async function openCgr(bytes: Uint8Array): Promise<CgrSummary> {
  // Probe Message availability (for diagnostics); summarizeCgr already prefers it.
  let hasMessage = false;
  try {
    const capnp = await import("@haozeke/capnp");
    hasMessage = typeof (capnp as { Message?: unknown }).Message === "function";
  } catch {
    hasMessage = false;
  }

  try {
    return await summarizeCgr(bytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `capnpc-ts: cannot open CodeGeneratorRequest (${bytes.length} bytes).`,
    );
    console.error(`  ${msg}`);
    if (!hasMessage) {
      console.error(
        "  @haozeke/capnp Message/fromFlat is not importable; hand walk also failed.",
      );
    } else {
      console.error(
        "  Message.fromFlat and hand-offset walk both failed on this buffer.",
      );
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

  let summary: CgrSummary;
  try {
    summary = await openCgr(bytes);
  } catch {
    console.error(`capnpc-ts: input byte length = ${bytes.length}`);
    return;
  }

  console.error(
    `capnpc-ts: CGR ok - nodes=${summary.nodeCount}, requestedFiles=${summary.requestedFileCount}` +
      (summary.requestedFilenames.length
        ? ` (${summary.requestedFilenames.join(", ")})`
        : ""),
  );

  const dry = argv.includes("--stdout");
  if (dry) {
    process.stdout.write(emitSourceString(summary));
    return;
  }

  const result = emitFromSummary(summary, process.cwd());
  for (const p of result.written) {
    console.error(`capnpc-ts: wrote ${p}`);
  }
}

if (import.meta.main) {
  await main();
}
