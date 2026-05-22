import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const creatingViewPath = path.join(__dirname, "CreatingView.tsx");
const firstWorkspacePanePath = path.join(__dirname, "FirstWorkspacePane.tsx");
const onboardingShellPath = path.join(__dirname, "OnboardingShell.tsx");
const workspaceDesktopPath = path.join(__dirname, "../../lib/workspaceDesktop.tsx");
const baseCssPath = path.join(__dirname, "../../styles/base.css");

test("creating view uses the publish-flow shell DNA: rounded card on bg-fg-2 canvas with subtle shadow", async () => {
  const source = await readFile(creatingViewPath, "utf8");

  assert.match(source, /rounded-2xl bg-background[\s\S]*shadow-xs/);
  assert.doesNotMatch(source, /theme-shell/);
  assert.doesNotMatch(source, /border border-border\/45/);
  assert.match(source, /bg-primary\/10/);
});

test("first workspace pane passes panel variant through to the creating view", async () => {
  const source = await readFile(firstWorkspacePanePath, "utf8");

  assert.match(source, /<CreatingView[\s\S]*panelVariant=\{isPanelVariant\}/);
});

test("panel create flow resets to the first panel step on every open", async () => {
  const source = await readFile(firstWorkspacePanePath, "utf8");

  assert.match(source, /import \{ useEffect, useLayoutEffect, useState \} from "react";/);
  assert.match(
    source,
    /useLayoutEffect\(\(\) => \{\s*if \(!isPanelVariant\) \{\s*return;\s*\}\s*setFirstWorkspaceStep\("name"\);\s*\}, \[isPanelVariant, setFirstWorkspaceStep\]\);/,
  );
});

test("first workspace pane runs the name → folder flow with sign-in gated upstream", async () => {
  const source = await readFile(firstWorkspacePanePath, "utf8");
  const workspaceDesktopSource = await readFile(workspaceDesktopPath, "utf8");

  // Step union dropped the "welcome" entry — RequireAuth handles sign-in.
  assert.match(
    workspaceDesktopSource,
    /export type FirstWorkspaceStep = "name" \| "folder";/,
  );
  // Provider defaults to "name" — the welcome step no longer exists.
  assert.match(workspaceDesktopSource, /useState<FirstWorkspaceStep>\("name"\)/);

  // Single shared step index map, two steps total for both variants.
  assert.match(source, /const STEP_INDEX: Record<SimpleStep, number> = \{\s*name: 1,\s*folder: 2,\s*\};/);
  assert.match(source, /const TOTAL_STEPS = 2;/);

  // Step titles + folder choice CTAs preserved.
  assert.match(source, /title="Name your workspace"/);
  assert.match(source, /title="Where should it live\?"/);
  assert.match(source, /title="Use the default folder"/);
  assert.match(source, /title="Choose a custom folder"/);
  assert.match(source, /chooseWorkspaceFolder/);

  // No auth gating lives in this pane anymore.
  assert.doesNotMatch(source, /useDesktopAuthSession/);
  assert.doesNotMatch(source, /"Connect holaOS"/);
  assert.doesNotMatch(source, /isAuthContinuationPending/);
  assert.doesNotMatch(source, /authGateBusy/);
  assert.doesNotMatch(source, /title="Welcome to holaOS"/);

  // Workspace creation defaults stay pinned for the empty template.
  assert.match(source, /setTemplateSourceMode\("empty"\)/);
  assert.doesNotMatch(source, /setTemplateSourceMode\("empty_onboarding"\)/);
  assert.match(source, /setBrowserBootstrapMode\("fresh"\)/);
  assert.match(
    source,
    /void createWorkspace\(\{ workspaceOnboardingMode: "start" \}\)\.then\(\(\) => \{/,
  );
  assert.doesNotMatch(source, /workspaceOnboardingMode: "skip"/);

  // The simplified flow no longer reaches into browser-profile bootstrapping
  // or marketplace template browsing.
  assert.doesNotMatch(source, /BrowserProfileStep/);
  assert.doesNotMatch(source, /MarketplaceGallery/);
  assert.doesNotMatch(source, /KitDetail/);
  assert.doesNotMatch(source, /SelectAppsStep/);
  assert.doesNotMatch(source, /ConnectIntegrationsStep/);
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

test("first workspace pane wraps the flow in the bg-fg-2 full-screen canvas via OnboardingShell", async () => {
  const paneSource = await readFile(firstWorkspacePanePath, "utf8");
  const shellSource = await readFile(onboardingShellPath, "utf8");

  // Pane keeps the fixed-position takeover; panel variant adds a scrim.
  assert.match(paneSource, /fixed inset-0 z-30/);
  assert.match(paneSource, /fixed inset-0 z-40/);
  assert.match(paneSource, /bg-scrim backdrop-blur-sm/);
  // Canvas chrome (bg-fg-2 + macOS draggable region) lives inside the shell.
  assert.match(shellSource, /bg-fg-2/);
  assert.match(shellSource, /titlebar-drag-region/);
  assert.doesNotMatch(shellSource, /titlebar-drag-region pointer-events-none/);
  assert.match(shellSource, /<header className="window-drag /);
});

test("onboarding title bar drag class maps to Electron drag regions", async () => {
  const source = await readFile(baseCssPath, "utf8");

  assert.match(
    source,
    /\.window-drag,\s*\.titlebar-drag-region \{\s*app-region: drag;\s*-webkit-app-region: drag;/,
  );
});
