import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const creatingViewPath = path.join(__dirname, "CreatingView.tsx");
const firstWorkspacePanePath = path.join(__dirname, "FirstWorkspacePane.tsx");

test("creating view uses the publish-flow shell DNA: rounded card on bg-fg-2 canvas with subtle shadow", async () => {
  const source = await readFile(creatingViewPath, "utf8");

  // Card: rounded-2xl bg-background with shadow-xs — matches PublishScreen.
  assert.match(source, /rounded-2xl bg-background[\s\S]*shadow-xs/);
  // No more theme-shell with hard borders.
  assert.doesNotMatch(source, /theme-shell/);
  assert.doesNotMatch(source, /border border-border\/45/);
  // Halo spinner wrapper survives the redesign.
  assert.match(source, /bg-primary\/10/);
});

test("first workspace pane passes panel variant through to the creating view", async () => {
  const source = await readFile(firstWorkspacePanePath, "utf8");

  assert.match(source, /<CreatingView[\s\S]*panelVariant=\{isPanelVariant\}/);
});

test("first workspace onboarding splits configure and browser profile into staged flow", async () => {
  const source = await readFile(firstWorkspacePanePath, "utf8");

  assert.match(source, /type OnboardingStep =[\s\S]*\| "browser_profile"/);
  assert.match(source, /onContinue=\{\(\) => setStep\("browser_profile"\)\}/);
  assert.match(
    source,
    /<BrowserProfileStep[\s\S]*onBack=\{\(\) => setStep\("configure"\)\}/,
  );
  assert.match(source, /listImportBrowserProfiles\(browserImportSource\)/);
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

test("first workspace pane wraps the flow in the bg-fg-2 full-screen canvas", async () => {
  const source = await readFile(firstWorkspacePanePath, "utf8");

  // Both variants ride on the same tinted canvas — matches PublishScreen.
  assert.match(source, /bg-fg-2/);
  // macOS draggable region is preserved.
  assert.match(source, /titlebar-drag-region/);
});
