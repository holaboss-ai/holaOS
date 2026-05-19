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
    "electron/addressSuggestionsPopupPreload.ts"
  ],
  format: ["cjs"],
  outDir: "out/dist-electron",
  clean: false,
  splitting: false,
  platform: "node",
  external: ["electron", "better-sqlite3"],
  sourcemap: true,
  env: process.env.SENTRY_DSN ? { SENTRY_DSN: process.env.SENTRY_DSN } : {},
  outExtension() {
    return {
      js: ".cjs"
    };
  }
});
