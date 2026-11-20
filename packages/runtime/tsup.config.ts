import { defineConfig } from "tsup";

/**
 * Optional publish build for Node / non-Bun consumers.
 * Bun resolves the package "bun" export condition to src/ directly.
 */
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
