/**
 * GitHub Actions must be pinned to a full commit, not a moving tag.
 * A retag of actions/cache@v4 would otherwise run code nobody reviewed.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workflows = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".github", "workflows");

const ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/;
const VERSION = /^v[0-9]/;

describe("workflow action pins", () => {
  test("every uses: line is a 40-character SHA with a version comment", () => {
    const files = readdirSync(workflows).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const name of files) {
      const text = readFileSync(join(workflows, name), "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const match = line.match(/^(\s*-?\s*uses:\s*)(\S+)(?:\s+#\s*(\S+))?\s*$/);
        if (!match) continue;
        const ref = match[2]!;
        const comment = match[3];
        if (!ACTION.test(ref) || comment === undefined || !VERSION.test(comment)) {
          offenders.push(`${name}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
