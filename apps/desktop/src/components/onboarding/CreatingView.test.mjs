import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const creatingViewPath = path.join(__dirname, "CreatingView.tsx");
const onboardingShellPath = path.join(__dirname, "OnboardingShell.tsx");
const baseCssPath = path.join(__dirname, "../../styles/base.css");

test("creating view uses the publish-flow shell DNA: rounded card on bg-fg-2 canvas with subtle shadow", async () => {
  const source = await readFile(creatingViewPath, "utf8");

  assert.match(source, /rounded-2xl bg-background[\s\S]*shadow-xs/);
  assert.doesNotMatch(source, /theme-shell/);
  assert.doesNotMatch(source, /border border-border\/45/);
  assert.match(source, /bg-primary\/10/);
});

test("creating view adapts progress text for copy/import browser bootstrap modes", async () => {
  const source = await readFile(creatingViewPath, "utf8");

  assert.match(
    source,
    /browserBootstrapMode\?: "fresh" \| "copy_workspace" \| "import_browser";/,
  );
  assert.match(source, /workspaceCreatePhase\?:/);
  assert.match(source, /"Copying browser profile"/);
  assert.match(source, /"Importing browser data"/);
});

test("onboarding title bar drag class maps to Electron drag regions", async () => {
  const source = await readFile(baseCssPath, "utf8");

  assert.match(
    source,
    /\.window-drag,\s*\.titlebar-drag-region \{\s*app-region: drag;\s*-webkit-app-region: drag;/,
  );
});
