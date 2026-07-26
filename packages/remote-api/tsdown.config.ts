import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    contract: "src/contract/index.ts",
    server: "src/server/index.ts",
    client: "src/client/index.ts",
    mcp: "src/mcp/index.ts",
  },
  format: ["esm", "cjs"],
  outExtensions: ({ format }) => ({
    js: format === "cjs" ? ".cjs" : ".js",
    dts: format === "cjs" ? ".d.cts" : ".d.ts",
  }),
  dts: { resolve: true },
  clean: true,
  target: "es2022",
});
