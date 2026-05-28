import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_PATH = new URL("./main.ts", import.meta.url);
const PRELOAD_PATH = new URL("./preload.ts", import.meta.url);
const TYPES_PATH = new URL("../src/types/electron.d.ts", import.meta.url);

test("desktop issues and teammates bridge exposes typed IPC on main and preload", async () => {
  const [mainSource, preloadSource, typesSource] = await Promise.all([
    readFile(MAIN_PATH, "utf8"),
    readFile(PRELOAD_PATH, "utf8"),
    readFile(TYPES_PATH, "utf8"),
  ]);

  assert.match(mainSource, /async function listTeammates\(\s*workspaceId: string,/);
  assert.match(mainSource, /path: "\/api\/v1\/teammates"/);
  assert.match(mainSource, /"workspace:listTeammates"/);
  assert.match(mainSource, /async function createTeammate\(\s*payload: CreateTeammatePayload,/);
  assert.match(mainSource, /"workspace:createTeammate"/);
  assert.match(mainSource, /async function updateTeammate\(\s*workspaceId: string,\s*teammateId: string,\s*payload: UpdateTeammatePayload,/);
  assert.match(mainSource, /"workspace:updateTeammate"/);
  assert.match(mainSource, /async function createTeammateSkill\(\s*workspaceId: string,\s*teammateId: string,\s*payload: CreateTeammateSkillPayload,/);
  assert.match(mainSource, /"workspace:createTeammateSkill"/);
  assert.match(mainSource, /async function deleteTeammateSkill\(\s*workspaceId: string,\s*teammateId: string,\s*skillId: string,/);
  assert.match(mainSource, /"workspace:deleteTeammateSkill"/);
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

  assert.match(preloadSource, /listTeammates: \(workspaceId: string, includeArchived = false\) =>/);
  assert.match(preloadSource, /ipcRenderer\.invoke\("workspace:listTeammates", workspaceId, includeArchived\)/);
  assert.match(preloadSource, /createTeammate: \(payload: CreateTeammatePayload\) =>/);
  assert.match(preloadSource, /ipcRenderer\.invoke\("workspace:createTeammate", payload\)/);
  assert.match(preloadSource, /updateTeammate: \(\s*workspaceId: string,\s*teammateId: string,\s*payload: UpdateTeammatePayload,\s*\) =>/);
  assert.match(preloadSource, /ipcRenderer\.invoke\("workspace:updateTeammate", workspaceId, teammateId, payload\)/);
  assert.match(preloadSource, /createTeammateSkill: \(\s*workspaceId: string,\s*teammateId: string,\s*payload: CreateTeammateSkillPayload,\s*\) =>/);
  assert.match(preloadSource, /ipcRenderer\.invoke\("workspace:createTeammateSkill", workspaceId, teammateId, payload\)/);
  assert.match(preloadSource, /deleteTeammateSkill: \(\s*workspaceId: string,\s*teammateId: string,\s*skillId: string,\s*\) =>/);
  assert.match(preloadSource, /ipcRenderer\.invoke\("workspace:deleteTeammateSkill", workspaceId, teammateId, skillId\)/);
  assert.match(preloadSource, /listIssues: \(workspaceId: string\) =>/);
  assert.match(preloadSource, /ipcRenderer\.invoke\("workspace:listIssues", workspaceId\)/);
  assert.match(preloadSource, /createIssue: \(payload: CreateIssuePayload\) =>/);
  assert.match(preloadSource, /ipcRenderer\.invoke\("workspace:createIssue", payload\)/);
  assert.match(preloadSource, /updateIssue: \(\s*workspaceId: string,\s*issueId: string,\s*payload: UpdateIssuePayload,\s*\) =>/);
  assert.match(preloadSource, /ipcRenderer\.invoke\("workspace:updateIssue", workspaceId, issueId, payload\)/);
  assert.match(preloadSource, /stopIssueRun: \(workspaceId: string, issueId: string\) =>/);
  assert.match(preloadSource, /ipcRenderer\.invoke\("workspace:stopIssueRun", workspaceId, issueId\)/);

  assert.match(typesSource, /interface TeammateRecordPayload \{/);
  assert.match(typesSource, /interface CreateTeammatePayload \{/);
  assert.match(typesSource, /interface CreateTeammateResponsePayload \{/);
  assert.match(typesSource, /interface UpdateTeammatePayload \{/);
  assert.match(typesSource, /interface UpdateTeammateResponsePayload \{/);
  assert.match(typesSource, /interface CreateTeammateSkillPayload \{/);
  assert.match(typesSource, /interface CreateTeammateSkillResponsePayload \{/);
  assert.match(typesSource, /interface DeleteTeammateSkillResponsePayload \{/);
  assert.match(typesSource, /interface IssueRecordPayload \{/);
  assert.match(typesSource, /interface IssueListResponsePayload \{/);
  assert.match(typesSource, /interface CreateIssuePayload \{/);
  assert.match(typesSource, /interface CreateIssueResponsePayload \{/);
  assert.match(typesSource, /interface UpdateIssuePayload \{/);
  assert.match(typesSource, /attachments\?: SessionInputAttachmentPayload\[\] \| null;/);
  assert.match(typesSource, /interface UpdateIssueResponsePayload \{/);
  assert.match(typesSource, /interface StopIssueRunResponsePayload \{/);
  assert.match(typesSource, /listTeammates: \(\s*workspaceId: string,\s*includeArchived\?: boolean\s*\) => Promise<TeammateListResponsePayload>;/);
  assert.match(typesSource, /createTeammate: \(\s*payload: CreateTeammatePayload\s*\) => Promise<CreateTeammateResponsePayload>;/);
  assert.match(typesSource, /updateTeammate: \(\s*workspaceId: string,\s*teammateId: string,\s*payload: UpdateTeammatePayload\s*\) => Promise<UpdateTeammateResponsePayload>;/);
  assert.match(typesSource, /createTeammateSkill: \(\s*workspaceId: string,\s*teammateId: string,\s*payload: CreateTeammateSkillPayload\s*\) => Promise<CreateTeammateSkillResponsePayload>;/);
  assert.match(typesSource, /deleteTeammateSkill: \(\s*workspaceId: string,\s*teammateId: string,\s*skillId: string\s*\) => Promise<DeleteTeammateSkillResponsePayload>;/);
  assert.match(typesSource, /listIssues: \(workspaceId: string\) => Promise<IssueListResponsePayload>;/);
  assert.match(typesSource, /createIssue: \(payload: CreateIssuePayload\) => Promise<CreateIssueResponsePayload>;/);
  assert.match(typesSource, /updateIssue: \(\s*workspaceId: string,\s*issueId: string,\s*payload: UpdateIssuePayload\s*\) => Promise<UpdateIssueResponsePayload>;/);
  assert.match(typesSource, /stopIssueRun: \(\s*workspaceId: string,\s*issueId: string\s*\) => Promise<StopIssueRunResponsePayload>;/);
  assert.match(
    typesSource,
    /interface TaskProposalAcceptResponsePayload \{[\s\S]*issue: IssueRecordPayload;/,
  );
});
