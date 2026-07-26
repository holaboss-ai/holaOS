import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    core: "src/core.ts",
    react: "src/react.ts",
    zod: "src/zod.ts",
    "clients/app": "src/clients/app.ts",
  },
  format: ["esm", "cjs"],
  outExtensions: ({ format }) => ({
    js: format === "cjs" ? ".cjs" : ".js",
    dts: format === "cjs" ? ".d.cts" : ".d.ts",
  }),
  dts: { resolve: true },
  clean: true,
  target: "es2022",
  external: [
    /^zod(\/.*)?$/,
    /^@tanstack\/react-query(\/.*)?$/,
    /^@tanstack\/query-core(\/.*)?$/,
  ],
});
