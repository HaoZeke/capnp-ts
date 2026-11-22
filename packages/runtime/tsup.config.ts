import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    packed: "src/packed.ts",
    canonical: "src/canonical.ts",
    schema: "src/schema.ts",
    dynamic: "src/dynamic.ts",
    text: "src/text.ts",
    json: "src/json.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  target: "es2022",
  outDir: "dist",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
});
