import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/debug-cli.ts"],
  format: ["esm"],
  outDir: "dist",
  clean: true,
  splitting: false,
  platform: "node",
  target: "node20",
  sourcemap: true,
  dts: true,
  outExtension() {
    return {
      js: ".mjs"
    };
  }
});
