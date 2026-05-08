import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const MAIN_PATH = new URL("./main.ts", import.meta.url);

test("workspace runtime requests ensure the embedded runtime is ready before reusing a local session", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(
    source,
    /async function ensureLocalWorkspaceRuntimeSessionReady\(\s*session: WorkspaceRuntimeSessionPayload,\s*\): Promise<WorkspaceRuntimeSessionPayload> \{/,
  );
  assert.match(
    source,
    /if \(session\.location !== "local"\) \{\s*return session;\s*\}/,
  );
  assert.match(
    source,
    /if \(runtimeStatus\.status === "running" && session\.runtime_base_url\.trim\(\)\) \{\s*return session;\s*\}/,
  );
  assert.match(source, /const status = await ensureRuntimeReady\(\);/);
  assert.match(
    source,
    /return cacheWorkspaceRuntimeSession\(\{\s*\.\.\.session,\s*runtime_base_url: status\.url \?\? runtimeBaseUrl\(\),\s*\}\);/,
  );
  assert.match(
    source,
    /const session = await ensureLocalWorkspaceRuntimeSessionReady\(\s*await resolveWorkspaceRuntimeSession\(safeWorkspaceId,\s*\{\s*refresh: attempt > 1,\s*\}\),\s*\);/,
  );
});
