import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const preloadSourcePath = path.join(__dirname, "browserPopupPreload.ts");
const mainSourcePath = path.join(__dirname, "main.ts");
const tsupConfigPath = path.join(__dirname, "..", "tsup.config.ts");

test("desktop browser popups use a preload bridge that renders a loading overlay", async () => {
  const preloadSource = await readFile(preloadSourcePath, "utf8");

  assert.match(
    preloadSource,
    /const OVERLAY_ID = "holaboss-browser-popup-loading-overlay";/,
  );
  assert.match(
    preloadSource,
    /overlay\.innerHTML =[\s\S]*class="panel"[\s\S]*class="spinner"/,
  );
});

test("desktop browser popup preload injects and dismisses the loading shell around page loads", async () => {
  const preloadSource = await readFile(preloadSourcePath, "utf8");

  assert.match(preloadSource, /Loading page\.\.\./);
  assert.match(preloadSource, /animation: holaboss-browser-popup-spin 720ms linear infinite;/);
  assert.match(preloadSource, /window\.addEventListener\("DOMContentLoaded", ensureOverlay, \{ once: true \}\);/);
  assert.match(preloadSource, /window\.addEventListener\("beforeunload", ensureOverlay\);/);
  assert.match(preloadSource, /window\.addEventListener\("load", hideOverlay, \{ once: true \}\);/);
  assert.match(preloadSource, /document\.addEventListener\("readystatechange", \(\) => \{/);
});

test("desktop browser popup window policy wires the popup preload into auth-style popup windows", async () => {
  const mainSource = await readFile(mainSourcePath, "utf8");
  const tsupConfigSource = await readFile(tsupConfigPath, "utf8");

  assert.match(tsupConfigSource, /"electron\/browserPopupPreload\.ts",/);
  assert.match(
    mainSource,
    /overrideBrowserWindowOptions: \{[\s\S]*webPreferences: \{[\s\S]*preload: path\.join\(__dirname, "browserPopupPreload\.cjs"\),/,
  );
});
