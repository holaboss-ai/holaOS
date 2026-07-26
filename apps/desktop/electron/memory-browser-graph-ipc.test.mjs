import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_PATH = new URL("./main.ts", import.meta.url);
const PRELOAD_PATH = new URL("./preload.ts", import.meta.url);
const TYPES_PATH = new URL("../src/types/electron.d.ts", import.meta.url);

test("desktop memory browser graph bridge exposes only the unified workspace forest", async () => {
  const [mainSource, preloadSource, typesSource] = await Promise.all([
    readFile(MAIN_PATH, "utf8"),
    readFile(PRELOAD_PATH, "utf8"),
    readFile(TYPES_PATH, "utf8"),
  ]);

  assert.match(mainSource, /type MemoryBrowserGraphForest = "workspace";/);
  assert.match(mainSource, /async function listMemoryBrowserGraph\(/);
  assert.match(mainSource, /path: "\/api\/v1\/memory\/browser\/graph"/);
  assert.match(mainSource, /listMemoryBrowserGraph: forest must be workspace/);
  assert.doesNotMatch(mainSource, /listMemoryBrowserGraph: forest must be workspace or integrations/);

  assert.match(preloadSource, /listMemoryBrowserGraph: \(/);
  assert.match(
    preloadSource,
    /params: \{[\s\S]*forest: MemoryBrowserGraphForestPayload;[\s\S]*treeId\?: string \| null;[\s\S]*maxLayers\?: number \| null;[\s\S]*maxNodes\?: number \| null;[\s\S]*\}/,
  );
  assert.match(
    preloadSource,
    /listMemoryBrowserGraph:[\s\S]*ipcRenderer\.invoke\([\s\S]*"workspace:listMemoryBrowserGraph"[\s\S]*workspaceId[\s\S]*params/,
  );
  assert.match(mainSource, /max_layers: params\.maxLayers \?\? undefined/);
  assert.match(mainSource, /max_nodes: params\.maxNodes \?\? undefined/);

  assert.match(typesSource, /type MemoryBrowserGraphForestPayload = "workspace";/);
  assert.match(
    typesSource,
    /listMemoryBrowserGraph: \(\s*workspaceId: string,\s*params: \{[\s\S]*forest: MemoryBrowserGraphForestPayload;[\s\S]*treeId\?: string \| null;[\s\S]*maxLayers\?: number \| null;[\s\S]*maxNodes\?: number \| null;[\s\S]*\}\s*\) => Promise<MemoryBrowserGraphResponsePayload>;/,
  );
});
