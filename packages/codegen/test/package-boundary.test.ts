/**
 * The published compiler plugin must depend on the runtime package.
 * A relative import of ../../runtime breaks once src/ is packed alone.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("capnpc-ts package boundary", () => {
  test("published sources import @haozeke/capnp, not a relative runtime path", () => {
    const srcDir = join(import.meta.dir, "../src");
    const files = readdirSync(srcDir).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const sources = files.map((name) =>
      readFileSync(join(srcDir, name), "utf8"),
    );
    const joined = sources.join("\n");
    expect(joined).not.toContain("../../runtime");
    expect(joined).toContain('from "@haozeke/capnp"');
  });
});
