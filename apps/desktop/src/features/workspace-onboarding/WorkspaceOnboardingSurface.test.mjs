import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const WORKSPACE_ONBOARDING_SURFACE_PATH = new URL(
  "./WorkspaceOnboardingSurface.tsx",
  import.meta.url,
);

test("workspace onboarding surface routes deterministic and agentic engines separately", async () => {
  const source = await readFile(WORKSPACE_ONBOARDING_SURFACE_PATH, "utf8");

  assert.match(
    source,
    /const \{ onboardingEngine, skipWorkspaceOnboarding \} = useWorkspaceDesktop\(\);/,
  );
  assert.match(
    source,
    /async function handleSkipOnboarding\(\) \{[\s\S]*await skipWorkspaceOnboarding\(\);[\s\S]*\}/,
  );
  assert.match(
    source,
    /aria-label="Skip onboarding"/,
  );
  assert.match(
    source,
    /onboardingEngine === "agentic" \? \(\s*<div className="pointer-events-none absolute top-4 right-4 z-20 sm:top-6 sm:right-6">[\s\S]*aria-label="Skip onboarding"[\s\S]*<\/div>\s*\) : null/,
  );
  assert.doesNotMatch(
    source,
    /\{isSkipping \? "Skipping\.\.\." : "Skip"\}/,
  );
  assert.match(
    source,
    /onboardingEngine === "agentic" \? \(\s*<AgenticWorkspaceOnboardingSurface[\s\S]*onOpenOutput=\{onOpenOutput\}[\s\S]*onSyncFileDisplayFromAgentOperation=\{[\s\S]*onSyncFileDisplayFromAgentOperation[\s\S]*focusRequestKey=\{focusRequestKey\}[\s\S]*\/>\s*\) : \(\s*<DeterministicWorkspaceOnboardingSurface \/>\s*\)/,
  );
  assert.match(
    source,
    /if \(!onboardingEngine\) \{\s*return null;\s*\}/,
  );
});
