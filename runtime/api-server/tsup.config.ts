import { cpSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));

// Asset trees read at runtime relative to the compiled module (MODULE_DIR
// resolves to dist/), so they must ride along into dist/. tsup only bundles
// imported modules — never sibling asset directories — so copy them here.
const EMBEDDED_ASSET_DIRS = ["embedded-capabilities"];

function copyEmbeddedAssets() {
  for (const dir of EMBEDDED_ASSET_DIRS) {
    const from = path.join(PKG_DIR, "src", dir);
    if (existsSync(from)) {
      cpSync(from, path.join(PKG_DIR, "dist", dir), { recursive: true });
    }
  }
}

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/app.ts",
    "src/runtime-config-cli.ts",
    "src/workspace-runtime-plan.ts",
    "src/workspace-mcp-host.ts",
    "src/workspace-mcp-sidecar.ts",
    "src/ts-runner.ts"
  ],
  format: ["esm"],
  outDir: "dist",
  clean: true,
  splitting: false,
  platform: "node",
  target: "node20",
  sourcemap: true,
  dts: true,
  // Bundle the (pure-JS, no-native-deps) channel gateway into the api-server
  // output so it ships without a separate vendored node_modules copy and so its
  // edits hot-reload through the api-server's own dist sync in dev.
  noExternal: ["@holaboss/runtime-channel-gateway"],
  async onSuccess() {
    copyEmbeddedAssets();
  },
  outExtension() {
    return {
      js: ".mjs"
    };
  }
});
