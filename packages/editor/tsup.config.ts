import { defineConfig } from "tsup";
import { cpSync } from "node:fs";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["react", "react-dom"],
  loader: { ".css": "copy" },
  publicDir: false,
  onSuccess: async () => {
    cpSync("src/styles.css", "dist/styles.css");
  },
});
