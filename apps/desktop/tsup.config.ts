import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "electron/main.ts",
    "electron/preload.ts",
    "electron/browserPopupPreload.ts",
    "electron/authPopupPreload.ts",
    "electron/downloadsPopupPreload.ts",
    "electron/historyPopupPreload.ts",
    "electron/overflowPopupPreload.ts",
    "electron/addressSuggestionsPopupPreload.ts",
    "electron/appSurfacePreload.ts"
  ],
  format: ["cjs"],
  outDir: "out/dist-electron",
  clean: false,
  splitting: false,
  platform: "node",
  external: [
    "electron",
    "better-sqlite3",
    "sharp",
    "node-mac-permissions",
    // Resolved at runtime from node_modules; drives spawned profile Chromiums
    // over CDP (see electron/profile-cdp.ts). Never bundled into main.cjs.
    "playwright",
    "playwright-core",
  ],
  sourcemap: true,
  outExtension() {
    return {
      js: ".cjs"
    };
  }
});
