import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const requiredArtifacts = [
  join(repoRoot, "packages", "runtime", "dist", "index.js"),
  join(repoRoot, "packages", "runtime", "dist", "cli.js"),
  join(repoRoot, "packages", "codegen", "dist", "index.js"),
  join(repoRoot, "packages", "rpc", "dist", "index.js"),
];

if (requiredArtifacts.some((artifact) => !existsSync(artifact))) {
  const result = spawnSync(process.execPath, ["run", "build"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(
      `bun run build failed in test preload (exit ${result.status ?? "null"})`,
    );
  }
}
