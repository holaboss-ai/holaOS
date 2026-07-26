import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  outDir: "dist",
  clean: true,
  splitting: false,
  platform: "node",
  target: "node20",
  sourcemap: true,
  dts: true,
  esbuildOptions(options) {
    options.banner = options.banner ?? {};
    options.banner.js = [
      'import { createRequire as __holabossCreateRequire } from "node:module";',
      "const require = __holabossCreateRequire(import.meta.url);",
      options.banner.js ?? "",
    ]
      .filter((part) => part.length > 0)
      .join("\n");
  },
  outExtension() {
    return {
      js: ".mjs"
    };
  }
});
