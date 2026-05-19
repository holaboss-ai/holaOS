import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const WORKSPACES_METHODS_PATH = new URL(
  "../../sdk/runtime-client/src/methods/workspaces.ts",
  import.meta.url,
);

test("workspace activation opts runtime ensure-running into transient retry handling", async () => {
  const source = await readFile(WORKSPACES_METHODS_PATH, "utf8");

  assert.match(
    source,
    /ensureAppsRunning\(workspaceId\) \{\s*return request<Record<string, unknown>>\(\{\s*method: "POST",\s*path: "\/api\/v1\/apps\/ensure-running",\s*payload: \{ workspace_id: workspaceId \},\s*timeoutMs: 300000,\s*retryTransientErrors: true,\s*\}\);?\s*\}/,
  );
});
