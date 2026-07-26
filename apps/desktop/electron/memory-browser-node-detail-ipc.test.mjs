import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_PATH = new URL("./main.ts", import.meta.url);
const PRELOAD_PATH = new URL("./preload.ts", import.meta.url);
const TYPES_PATH = new URL("../src/types/electron.d.ts", import.meta.url);

test("desktop memory browser node-detail bridge exposes typed IPC on main and preload", async () => {
  const [mainSource, preloadSource, typesSource] = await Promise.all([
    readFile(MAIN_PATH, "utf8"),
    readFile(PRELOAD_PATH, "utf8"),
    readFile(TYPES_PATH, "utf8"),
  ]);

  assert.match(mainSource, /const MEMORY_BROWSER_RUNTIME_TIMEOUT_MS = 120_000;/);
  assert.match(
    mainSource,
    /async function listMemoryBrowserTree\([\s\S]*timeoutMs: MEMORY_BROWSER_RUNTIME_TIMEOUT_MS,/,
  );
  assert.match(
    mainSource,
    /async function readMemoryBrowserFile\([\s\S]*timeoutMs: MEMORY_BROWSER_RUNTIME_TIMEOUT_MS,/,
  );
  assert.match(mainSource, /async function readMemoryBrowserNodeDetail\(/);
  assert.match(
    mainSource,
    /Promise<MemoryBrowserNodeDetailResponse>/,
  );
  assert.match(mainSource, /path: "\/api\/v1\/memory\/browser\/node-detail"/);
  assert.match(
    mainSource,
    /async function readMemoryBrowserNodeDetail\([\s\S]*timeoutMs: MEMORY_BROWSER_RUNTIME_TIMEOUT_MS,/,
  );
  assert.match(
    mainSource,
    /async function listMemoryBrowserGraph\([\s\S]*timeoutMs: MEMORY_BROWSER_RUNTIME_TIMEOUT_MS,/,
  );
  assert.match(mainSource, /"workspace:readMemoryBrowserNodeDetail"/);

  assert.match(preloadSource, /readMemoryBrowserNodeDetail: \(/);
  assert.match(
    preloadSource,
    /readMemoryBrowserNodeDetail:[\s\S]*ipcRenderer\.invoke\([\s\S]*"workspace:readMemoryBrowserNodeDetail"[\s\S]*workspaceId[\s\S]*params/,
  );

  assert.match(typesSource, /interface MemoryBrowserNodeDetailResponsePayload \{/);
  assert.match(typesSource, /interface MemoryBrowserNodeEvidenceRefPayload \{/);
  assert.match(typesSource, /interface MemoryBrowserNodeRelationPayload \{/);
  assert.match(typesSource, /target_resolution_kind: "resolved" \| "synthetic" \| "missing";/);
  assert.match(
    typesSource,
    /readMemoryBrowserNodeDetail: \(\s*workspaceId: string,\s*params: \{ nodeId: string; treeId\?: string \| null \}\s*\) => Promise<MemoryBrowserNodeDetailResponsePayload>;/,
  );
});
