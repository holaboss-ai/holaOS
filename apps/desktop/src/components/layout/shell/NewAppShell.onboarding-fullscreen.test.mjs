import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SOURCE_PATH = new URL("./AppShell.tsx", import.meta.url);

test("experimental onboarding takeover hides the shell sidebar so onboarding uses the full shell width", async () => {
  const source = await readFile(SOURCE_PATH, "utf8");

  assert.match(
    source,
    /const showSidebar = !showControlCenter && !onboardingModeActive;/,
  );
  assert.match(source, /\{showSidebar \? <Sidebar \/> : null\}/);
  assert.match(
    source,
    /\{onboardingModeActive \? \(\s*<div className="flex min-w-0 flex-1 flex-col bg-background">\s*<ExperimentalWorkspaceOnboardingTakeover \/>\s*<\/div>/,
  );
});
