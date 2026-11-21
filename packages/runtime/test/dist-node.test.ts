import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = join(here, "..");

describe("Node publish build", () => {
  test("shares runtime classes between separate dist entry points", () => {
    const build = spawnSync(process.execPath, ["run", "build"], {
      cwd: runtimeRoot,
      encoding: "utf-8",
    });
    expect(build.status).toBe(0);

    const script = `
      import { readFileSync } from "node:fs";
      import { MessageBuilder } from "./dist/index.js";
      import { SchemaLoader } from "./dist/schema.js";
      import { DynamicStruct } from "./dist/dynamic.js";
      import { encodeText } from "./dist/text.js";

      const loader = SchemaLoader.fromCgr(
        new Uint8Array(readFileSync("./test/golden/dynamic-kitchen.cgr.bin")),
      );
      const sink = DynamicStruct.initRoot(
        new MessageBuilder(),
        loader.resolveStruct("KitchenSink"),
      );
      sink.set("title", "separate dist entries");
      process.stdout.write(encodeText(sink, { pretty: false }));
    `;
    const node = spawnSync("node", ["--input-type=module", "--eval", script], {
      cwd: runtimeRoot,
      encoding: "utf-8",
    });
    expect(node.status).toBe(0);
    expect(node.stdout).toContain('title = "separate dist entries"');
    expect(node.stdout).not.toContain("<external capability>");
  });
});
