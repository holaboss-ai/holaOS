import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_PATH = new URL("./main.ts", import.meta.url);

test("empty workspace onboarding start uses deterministic onboarding state", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(
    source,
    /const wantsDeterministicWorkspaceOnboarding =[\s\S]*requestedWorkspaceOnboardingEngine === "deterministic";/,
  );
  assert.match(
    source,
    /if \(wantsDeterministicWorkspaceOnboarding\) \{[\s\S]*onboardingStatus = "PENDING";[\s\S]*onboardingState = "deterministic_intro";[\s\S]*onboardingSessionId = null;[\s\S]*\}/,
  );
});

test("deterministic onboarding continue is exposed over electron ipc", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(
    source,
    /async function continueDeterministicOnboarding\([\s\S]*currentState === "deterministic_intro"[\s\S]*onboarding_status: "in_progress"[\s\S]*onboarding_state: "deterministic_context_fetching"[\s\S]*onboarding_status: "completed"[\s\S]*onboarding_completion_summary: "Deterministic onboarding completed"/,
  );
  assert.match(source, /"workspace:continueDeterministicOnboarding"/);
});

test("workspace onboarding skip is exposed over electron ipc for deterministic and agentic flows", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(
    source,
    /async function skipWorkspaceOnboarding\([\s\S]*\/api\/v1\/workspace-labs\/\$\{encodeURIComponent\(labWorkspaceId\)\}\/abandon[\s\S]*onboarding_completion_summary: "Workspace onboarding skipped"/,
  );
  assert.match(source, /"workspace:skipWorkspaceOnboarding"/);
});

test("agentic onboarding alignment answers preserve selected model context", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(
    source,
    /async function answerOnboardingAlignmentQuestion\([\s\S]*model\?: string \| null;[\s\S]*thinkingValue\?: string \| null;[\s\S]*payload:\s*\{[\s\S]*model: payload\.model \?\? undefined,[\s\S]*thinking_value: payload\.thinkingValue \?\? undefined,/,
  );
});

test("agentic onboarding is still available when explicitly requested", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(
    source,
    /payload\.workspace_onboarding_engine === "agentic"/,
  );
  assert.match(
    source,
    /if \(wantsAgenticWorkspaceOnboarding\) \{[\s\S]*\/api\/v1\/workspaces\/\$\{encodeURIComponent\(workspaceId\)\}\/labs[\s\S]*\}/,
  );
});
