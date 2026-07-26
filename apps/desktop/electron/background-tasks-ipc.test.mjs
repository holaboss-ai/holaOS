import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_PATH = new URL("./main.ts", import.meta.url);
const PRELOAD_PATH = new URL("./preload.ts", import.meta.url);
const TYPES_PATH = new URL("../src/types/electron.d.ts", import.meta.url);

test("desktop background tasks bridge exposes typed IPC on main and preload", async () => {
  const [mainSource, preloadSource, typesSource] = await Promise.all([
    readFile(MAIN_PATH, "utf8"),
    readFile(PRELOAD_PATH, "utf8"),
    readFile(TYPES_PATH, "utf8"),
  ]);

  assert.match(mainSource, /interface BackgroundTaskRecordPayload \{/);
  assert.match(mainSource, /async function listBackgroundTasks\(\s*payload: BackgroundTaskListRequestPayload,/);
  assert.match(mainSource, /path: "\/api\/v1\/background-tasks"/);
  assert.match(mainSource, /"workspace:listBackgroundTasks"/);
  assert.match(mainSource, /async function archiveBackgroundTask\(\s*payload: ArchiveBackgroundTaskPayload,/);
  assert.match(mainSource, /path: `\/api\/v1\/background-tasks\/\$\{encodeURIComponent\(payload\.subagentId\)\}\/archive`/);
  assert.match(mainSource, /"workspace:archiveBackgroundTask"/);
  assert.match(preloadSource, /listBackgroundTasks: \(payload: BackgroundTaskListRequestPayload\) =>/);
  assert.match(preloadSource, /ipcRenderer\.invoke\("workspace:listBackgroundTasks", payload\)/);
  assert.match(preloadSource, /archiveBackgroundTask: \(payload: ArchiveBackgroundTaskPayload\) =>/);
  assert.match(preloadSource, /ipcRenderer\.invoke\("workspace:archiveBackgroundTask", payload\)/);
  assert.match(typesSource, /interface BackgroundTaskRecordPayload \{/);
  assert.match(typesSource, /listBackgroundTasks: \(\s*payload: BackgroundTaskListRequestPayload\s*\) => Promise<BackgroundTaskListResponsePayload>;/);
  assert.match(typesSource, /interface ArchiveBackgroundTaskPayload \{/);
  assert.match(typesSource, /archiveBackgroundTask: \(\s*payload: ArchiveBackgroundTaskPayload\s*\) => Promise<ArchiveBackgroundTaskResponsePayload>;/);
});
