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
  assert.match(mainSource, /async function listIssues\(\s*workspaceId: string,/);
  assert.match(mainSource, /path: "\/api\/v1\/issues"/);
  assert.match(mainSource, /"workspace:listIssues"/);

  assert.match(preloadSource, /listTeammates: \(workspaceId: string, includeArchived = false\) =>/);
  assert.match(preloadSource, /ipcRenderer\.invoke\("workspace:listTeammates", workspaceId, includeArchived\)/);
  assert.match(preloadSource, /listIssues: \(workspaceId: string\) =>/);
  assert.match(preloadSource, /ipcRenderer\.invoke\("workspace:listIssues", workspaceId\)/);

  assert.match(typesSource, /interface TeammateRecordPayload \{/);
  assert.match(typesSource, /interface IssueRecordPayload \{/);
  assert.match(typesSource, /interface IssueListResponsePayload \{/);
  assert.match(typesSource, /listTeammates: \(\s*workspaceId: string,\s*includeArchived\?: boolean\s*\) => Promise<TeammateListResponsePayload>;/);
  assert.match(typesSource, /listIssues: \(workspaceId: string\) => Promise<IssueListResponsePayload>;/);
  assert.match(
    typesSource,
    /interface TaskProposalAcceptResponsePayload \{[\s\S]*issue: IssueRecordPayload;/,
  );
});
