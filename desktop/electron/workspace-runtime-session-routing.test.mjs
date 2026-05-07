import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_PATH = new URL("./main.ts", import.meta.url);

test("workspace-scoped proposals, background tasks, memory, notifications, cronjobs, and outputs route through workspace runtime sessions", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(
    source,
    /async function listTaskProposals\([\s\S]*?requestWorkspaceRuntimeJson<TaskProposalListResponsePayload>\(\s*workspaceId,[\s\S]*?path: "\/api\/v1\/task-proposals\/unreviewed"/,
  );
  assert.match(
    source,
    /async function acceptTaskProposal\([\s\S]*?requestWorkspaceRuntimeJson<TaskProposalAcceptResponsePayload>\(\s*payload\.workspace_id,[\s\S]*?path: `\/api\/v1\/task-proposals\/\$\{encodeURIComponent\(payload\.proposal_id\)\}\/accept`/,
  );
  assert.match(
    source,
    /async function listBackgroundTasks\([\s\S]*?requestWorkspaceRuntimeJson<BackgroundTaskListResponsePayload>\(\s*payload\.workspaceId,[\s\S]*?path: "\/api\/v1\/background-tasks"/,
  );
  assert.match(
    source,
    /async function archiveBackgroundTask\([\s\S]*?requestWorkspaceRuntimeJson<ArchiveBackgroundTaskResponsePayload>\(\s*payload\.workspaceId,[\s\S]*?archive`/,
  );
  assert.match(
    source,
    /async function listMemoryUpdateProposals\([\s\S]*?requestWorkspaceRuntimeJson<MemoryUpdateProposalListResponsePayload>\(\s*payload\.workspaceId,[\s\S]*?path: "\/api\/v1\/memory-update-proposals"/,
  );
  assert.match(
    source,
    /async function acceptMemoryUpdateProposal\([\s\S]*?requestWorkspaceRuntimeJson<MemoryUpdateProposalAcceptResponsePayload>\(\s*payload\.workspaceId,[\s\S]*?accept`/,
  );
  assert.match(
    source,
    /async function dismissMemoryUpdateProposal\([\s\S]*?requestWorkspaceRuntimeJson<MemoryUpdateProposalDismissResponsePayload>\(\s*workspaceId,[\s\S]*?dismiss`/,
  );
  assert.match(
    source,
    /async function listNotifications\([\s\S]*?workspaceId\?\.trim\(\)\s*\?\s*await requestWorkspaceRuntimeJson<RuntimeNotificationListResponsePayload>\(/,
  );
  assert.match(
    source,
    /async function updateNotification\([\s\S]*?requestWorkspaceRuntimeJson<RuntimeNotificationRecordPayload>\(\s*workspaceId,[\s\S]*?notifications\/\$\{encodeURIComponent\(notificationId\)\}`/,
  );
  assert.match(
    source,
    /async function listCronjobs\([\s\S]*?requestWorkspaceRuntimeJson<CronjobListResponsePayload>\(\s*workspaceId,[\s\S]*?path: "\/api\/v1\/cronjobs"/,
  );
  assert.match(
    source,
    /async function createCronjob\([\s\S]*?requestWorkspaceRuntimeJson<CronjobRecordPayload>\(\s*payload\.workspace_id,[\s\S]*?path: "\/api\/v1\/cronjobs"/,
  );
  assert.match(
    source,
    /async function listOutputs\([\s\S]*?requestWorkspaceRuntimeJson<WorkspaceOutputListResponsePayload>\(\s*requestPayload\.workspaceId,[\s\S]*?path: "\/api\/v1\/outputs"/,
  );
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
  assert.match(
    source,
    /requestWorkspaceRuntimeJson<InstallAppFromCatalogResponse>\(\s*params\.workspaceId,[\s\S]*?path: "\/api\/v1\/apps\/install-archive"/,
  );
  assert.match(
    source,
    /requestWorkspaceRuntimeJson<InstallAppFromCatalogResponse>\(\s*workspaceId,[\s\S]*?path: "\/api\/v1\/apps\/install-archive"/,
  );
  assert.match(
    source,
    /requestWorkspaceRuntimeJson<ProactiveContextCaptureResponsePayload>\(\s*workspaceId,[\s\S]*?path: "\/api\/v1\/proactive\/context\/capture"/,
  );
});

test("workspace-scoped session lifecycle and IO APIs route through workspace runtime sessions", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(
    source,
    /requestWorkspaceRuntimeJson<EnqueueSessionInputResponsePayload>\(\s*workspaceId,[\s\S]*?Start workspace onboarding now\./,
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
    /async function ensureWorkspaceMainSession\([\s\S]*?requestWorkspaceRuntimeJson<EnsureWorkspaceMainSessionResponsePayload>\(\s*workspaceId,[\s\S]*?ensure-main-session/,
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
  assert.match(source, /workspace_root: localWorkspaceRootFromSession\(session\),/);
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
