import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const creatingViewPath = path.join(__dirname, "CreatingView.tsx");
const firstWorkspacePanePath = path.join(__dirname, "FirstWorkspacePane.tsx");
const onboardingShellPath = path.join(__dirname, "OnboardingShell.tsx");

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

test("first workspace pane runs the welcome → name → folder flow", async () => {
  const source = await readFile(firstWorkspacePanePath, "utf8");

  assert.match(source, /type SimpleStep = "welcome" \| "name" \| "folder";/);
  // Step index/total are variant-aware: full takeover = 3 (welcome→name→folder),
  // panel variant = 2 (name→folder, no Welcome).
  assert.match(source, /STEP_INDEX_FULL[\s\S]*welcome: 1,[\s\S]*name: 2,[\s\S]*folder: 3,/);
  assert.match(source, /STEP_INDEX_PANEL[\s\S]*name: 1,[\s\S]*folder: 2,/);
  assert.match(source, /const totalSteps = isPanelVariant \? 2 : 3;/);
  // Initial step is held in useState<SimpleStep> — Welcome is in the
  // possible state space. (Exact branch — full vs panel — is asserted via
  // STEP_INDEX_* + totalSteps below; allows local dev to flip the
  // initializer to force "welcome" while previewing.)
  assert.match(source, /useState<SimpleStep>/);
  // Three step titles.
  assert.match(source, /title="Welcome to holaOS"/);
  assert.match(source, /title="Name your workspace"/);
  assert.match(source, /title="Where should it live\?"/);
  assert.match(source, /title="Use the default folder"/);
  assert.match(source, /title="Choose a custom folder"/);
  assert.match(source, /chooseWorkspaceFolder/);
  // Welcome: brand-flavoured CTA "Connect holaOS" + plain "Skip" tertiary.
  assert.match(source, /label: "Connect holaOS"/);
  assert.match(source, /label: "Skip"/);
  assert.match(source, /window\.electronAPI\.auth\.requestAuth\(\)/);
  // Welcome step renders the brand hero above the title.
  assert.match(source, /aboveTitle=\{<WelcomeHero \/>\}/);
  // Three static halo rings fading outward, no motion.
  assert.match(source, /border-primary\/8/);
  assert.match(source, /border-primary\/16/);
  assert.match(source, /border-primary\/26/);
  assert.doesNotMatch(source, /holaboss-splash-halo/);
  // Three vertical FeatureCards with thin-stroked lucide icons.
  assert.match(source, /<FeatureCard[\s\S]*art=\{<Sparkles strokeWidth=\{1\.25\} \/>\}/);
  assert.match(source, /<FeatureCard[\s\S]*art=\{<Plug strokeWidth=\{1\.25\} \/>\}/);
  assert.match(source, /<FeatureCard[\s\S]*art=\{<Zap strokeWidth=\{1\.25\} \/>\}/);
  assert.match(source, /grid grid-cols-3/);
  // Plain "empty" — "empty_onboarding" triggers the ONBOARD.md chat takeover
  // which has nothing to run for a no-template workspace.
  assert.match(source, /setTemplateSourceMode\("empty"\)/);
  assert.doesNotMatch(source, /setTemplateSourceMode\("empty_onboarding"\)/);
  assert.match(source, /setBrowserBootstrapMode\("fresh"\)/);
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
});
