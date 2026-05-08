import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["react", "react-dom"],
  loader: { ".css": "copy" },
  publicDir: false,
  onSuccess: "cp src/styles.css dist/styles.css",
});
