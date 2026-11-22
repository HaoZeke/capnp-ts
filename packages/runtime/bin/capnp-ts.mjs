#!/usr/bin/env node
import { existsSync } from "node:fs";

const entry = new URL("../dist/cli.js", import.meta.url);
if (!existsSync(entry)) {
  process.stderr.write(
    "capnp-ts: dist/cli.js is missing; run `bun run build` first.\n",
  );
  process.exit(1);
}

let mod;
try {
  mod = await import(entry.href);
} catch (err) {
  const missingModule =
    err?.code === "ERR_MODULE_NOT_FOUND" ||
    /Cannot find module|Cannot resolve/.test(String(err));
  if (missingModule && existsSync(new URL("../src", import.meta.url))) {
    process.stderr.write(
      "capnp-ts: workspace dist is missing; run `bun run build` first.\n",
    );
    process.exit(1);
  }
  throw err;
}

process.exitCode = await mod.main(process.argv.slice(2));
