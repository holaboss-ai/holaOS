import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_PATH = new URL("./main.ts", import.meta.url);

test("workspace-scoped background tasks, notifications, cronjobs, and outputs route through workspace runtime sessions", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(
    source,
    /async function listBackgroundTasks\([\s\S]*?requestWorkspaceRuntimeJson<BackgroundTaskListResponsePayload>\(\s*payload\.workspaceId,[\s\S]*?path: "\/api\/v1\/background-tasks"/,
  );
  assert.match(
    source,
    /async function archiveBackgroundTask\([\s\S]*?requestWorkspaceRuntimeJson<ArchiveBackgroundTaskResponsePayload>\(\s*payload\.workspaceId,[\s\S]*?archive`/,
  );
  assert.doesNotMatch(source, /async function listMemoryUpdateProposals\(/);
  assert.doesNotMatch(source, /async function acceptMemoryUpdateProposal\(/);
  assert.doesNotMatch(source, /async function dismissMemoryUpdateProposal\(/);
  assert.doesNotMatch(source, /\/api\/v1\/memory-update-proposals/);
  // The workflow IPC + impls were removed with the plugin/base/workflow
  // bundle, so main.ts no longer defines workflow runtime-session helpers.
  assert.doesNotMatch(source, /async function listWorkflows\(/);
  assert.doesNotMatch(source, /async function createWorkflow\(/);
  assert.doesNotMatch(source, /async function testWorkflow\(/);
  assert.match(
    source,
    /async function listIntegrationBindings\([\s\S]*?requestWorkspaceRuntimeJson<IntegrationBindingListResponsePayload>\(\s*workspaceId,[\s\S]*?path: "\/api\/v1\/integrations\/bindings"/,
  );
  assert.match(
    source,
    /async function upsertIntegrationBinding\([\s\S]*?requestWorkspaceRuntimeJson<IntegrationBindingPayload>\(\s*workspaceId,[\s\S]*?integrations\/bindings\/\$\{encodeURIComponent\(workspaceId\)\}/,
  );
  assert.match(
    source,
    /async function deleteIntegrationBinding\([\s\S]*?requestWorkspaceRuntimeJson<\{ deleted: boolean \}>\(\s*workspaceId,[\s\S]*?integrations\/bindings\/\$\{encodeURIComponent\(bindingId\)\}`/,
  );
  assert.doesNotMatch(source, /path: "\/api\/v1\/proactive\/context\/capture"/);
});

test("workspace-scoped session lifecycle and IO APIs route through workspace runtime sessions", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(
    source,
    /requestWorkspaceRuntimeJson<EnqueueSessionInputResponsePayload>\(\s*workspaceId,[\s\S]*?Start workspace onboarding now\./,
  );
  assert.doesNotMatch(
    source,
    /Start workspace onboarding in the lab\. Converse with the user/,
  );
  assert.match(
    source,
    /async function listRuntimeStates\([\s\S]*?requestWorkspaceRuntimeJson<SessionRuntimeStateListResponsePayload>\(\s*workspaceId,[\s\S]*?runtime-states/,
  );
  assert.match(
    source,
    /async function listAgentSessions\([\s\S]*?requestWorkspaceRuntimeJson<AgentSessionListResponsePayload>\(\s*requestPayload\.workspaceId,[\s\S]*?path: "\/api\/v1\/agent-sessions"/,
  );
  assert.match(
    source,
    /async function ensureWorkspaceMainSession\([\s\S]*?requestWorkspaceRuntimeJson<EnsureWorkspaceMainSessionResponsePayload>\(\s*workspaceId,[\s\S]*?ensure-main-session[\s\S]*?retryTransientErrors: true,/,
  );
  assert.match(
    source,
    /async function createAgentSession\([\s\S]*?requestWorkspaceRuntimeJson<CreateAgentSessionResponsePayload>\(\s*payload\.workspace_id,[\s\S]*?path: "\/api\/v1\/agent-sessions"/,
  );
  assert.match(
    source,
    /async function getSessionHistory\([\s\S]*?requestWorkspaceRuntimeJson<SessionHistoryResponsePayload>\(\s*payload\.workspaceId,[\s\S]*?history/,
  );
  assert.match(
    source,
    /async function getSessionOutputEvents\([\s\S]*?requestWorkspaceRuntimeJson<SessionOutputEventListResponsePayload>\(\s*payload\.workspaceId,[\s\S]*?outputs\/events/,
  );
  assert.match(
    source,
    /async function queueSessionInput\([\s\S]*?requestWorkspaceRuntimeJson<EnqueueSessionInputResponsePayload>\(\s*payload\.workspace_id,[\s\S]*?path: "\/api\/v1\/agent-sessions\/queue"/,
  );
  assert.match(
    source,
    /async function pauseSessionRun\([\s\S]*?requestWorkspaceRuntimeJson<PauseSessionRunResponsePayload>\(\s*payload\.workspace_id,[\s\S]*?pause/,
  );
  assert.match(
    source,
    /async function updateQueuedSessionInput\([\s\S]*?requestWorkspaceRuntimeJson<UpdateQueuedSessionInputResponsePayload>\(\s*payload\.workspace_id,[\s\S]*?inputs\/\$\{encodeURIComponent\(payload\.input_id\)\}`/,
  );
});

test("local filesystem access goes through explicit local workspace-root helpers", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(source, /function resolveLocalWorkspaceRootPath\(rawWorkspaceRoot: string\)/);
  assert.match(
    source,
    /function localWorkspaceRootFromSession\([\s\S]*?session\.location !== "local"/,
  );
  assert.match(
    source,
    /const workspaceRoot = location === "local"\s*\?\s*localWorkspaceRootFromSession\(session\)/,
  );
  assert.match(source, /workspace_root: workspaceRoot,/);
  assert.match(
    source,
    /workspace_root: resolveLocalWorkspaceRootPath\(\s*await resolveWorkspaceDir\(safeWorkspaceId\),/,
  );
  assert.match(
    source,
    /const workspaceRoot = await resolveLocalWorkspaceRoot\(normalizedWorkspaceId\);/,
  );
  assert.match(
    source,
    /async \(_event, workspaceId: string\) =>\s*resolveLocalWorkspaceRoot\(workspaceId\),/,
  );
  assert.doesNotMatch(source, /path\.resolve\(workspaceSession\.workspace_root\)/);
});

test("workspace-scoped runtime domains no longer call the singleton runtime client directly", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.doesNotMatch(
    source,
    /runtimeClient\.(taskProposals|sessions|memory|cronjobs|outputs|notifications)\./,
  );
  assert.doesNotMatch(
    source,
    /runtimeClient\.integrations\.(listBindings|upsertBinding|deleteBinding)\./,
  );
  assert.doesNotMatch(source, /runtimeClient\.apps\.installArchive\(/);
});
