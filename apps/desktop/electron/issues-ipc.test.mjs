import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_PATH = new URL("./main.ts", import.meta.url);
const PRELOAD_PATH = new URL("./preload.ts", import.meta.url);
const TYPES_PATH = new URL("../src/types/electron.d.ts", import.meta.url);

test("desktop issues bridge exposes typed IPC on main and preload", async () => {
  const [mainSource, preloadSource, typesSource] = await Promise.all([
    readFile(MAIN_PATH, "utf8"),
    readFile(PRELOAD_PATH, "utf8"),
    readFile(TYPES_PATH, "utf8"),
  ]);

  assert.match(mainSource, /async function listIssues\(\s*workspaceId: string,/);
  assert.match(mainSource, /path: "\/api\/v1\/issues"/);
  assert.match(mainSource, /"workspace:listIssues"/);
  assert.match(mainSource, /async function createIssue\(\s*payload: CreateIssuePayload,/);
  assert.match(mainSource, /"workspace:createIssue"/);
  assert.match(mainSource, /async function updateIssue\(\s*workspaceId: string,\s*issueId: string,\s*payload: UpdateIssuePayload,/);
  assert.match(mainSource, /"workspace:updateIssue"/);
  assert.match(mainSource, /attachments: payload\.attachments \?\? undefined,/);
  assert.match(mainSource, /async function stopIssueRun\(\s*workspaceId: string,\s*issueId: string,/);
  assert.match(mainSource, /"workspace:stopIssueRun"/);
  // The workflow IPC surface was removed with the plugin/base/workflow bundle.
  assert.doesNotMatch(mainSource, /"workspace:listWorkflows"/);
  assert.doesNotMatch(mainSource, /"workspace:createWorkflow"/);
  assert.doesNotMatch(mainSource, /"workspace:listWorkflowRuns"/);

  assert.match(preloadSource, /listIssues: \(workspaceId: string\) =>/);
  assert.match(preloadSource, /ipcRenderer\.invoke\("workspace:listIssues", workspaceId\)/);
  assert.match(preloadSource, /createIssue: \(payload: CreateIssuePayload\) =>/);
  assert.match(preloadSource, /ipcRenderer\.invoke\("workspace:createIssue", payload\)/);
  assert.match(preloadSource, /updateIssue: \(\s*workspaceId: string,\s*issueId: string,\s*payload: UpdateIssuePayload,\s*\) =>/);
  assert.match(preloadSource, /ipcRenderer\.invoke\("workspace:updateIssue", workspaceId, issueId, payload\)/);
  assert.match(preloadSource, /stopIssueRun: \(workspaceId: string, issueId: string\) =>/);
  assert.match(preloadSource, /ipcRenderer\.invoke\("workspace:stopIssueRun", workspaceId, issueId\)/);
  assert.doesNotMatch(preloadSource, /"workspace:listWorkflows"/);
  assert.doesNotMatch(preloadSource, /"workspace:createWorkflow"/);

  assert.match(typesSource, /interface IssueRecordPayload \{/);
  assert.match(typesSource, /interface IssueListResponsePayload \{/);
  assert.match(typesSource, /interface CreateIssuePayload \{/);
  assert.match(typesSource, /interface CreateIssueResponsePayload \{/);
  assert.match(typesSource, /interface UpdateIssuePayload \{/);
  assert.match(typesSource, /attachments\?: SessionInputAttachmentPayload\[\] \| null;/);
  assert.match(typesSource, /interface UpdateIssueResponsePayload \{/);
  assert.match(typesSource, /interface StopIssueRunResponsePayload \{/);
  assert.match(typesSource, /listIssues: \(workspaceId: string\) => Promise<IssueListResponsePayload>;/);
  assert.match(typesSource, /createIssue: \(payload: CreateIssuePayload\) => Promise<CreateIssueResponsePayload>;/);
  assert.match(typesSource, /updateIssue: \(\s*workspaceId: string,\s*issueId: string,\s*payload: UpdateIssuePayload\s*\) => Promise<UpdateIssueResponsePayload>;/);
  assert.match(typesSource, /stopIssueRun: \(\s*workspaceId: string,\s*issueId: string\s*\) => Promise<StopIssueRunResponsePayload>;/);
  // Workflow type decls + bridges were removed alongside the bundle.
  assert.doesNotMatch(typesSource, /interface WorkflowRecordPayload \{/);
  assert.doesNotMatch(typesSource, /interface CreateWorkflowPayload \{/);
});
