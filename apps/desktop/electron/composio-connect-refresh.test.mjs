import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_PATH = new URL("./main.ts", import.meta.url);

/**
 * The post-connect hook has to target a capability the runtime actually serves.
 *
 * `/api/v1/composio-mcp/ensure-running` was removed when Composio tools moved
 * inline (the runtime now deletes the legacy `holaboss_composio` registry
 * entry), but the desktop kept POSTing to it. Every call 404'd into the callers'
 * `catch {}`, so the only step that made a just-connected integration's tools
 * reachable silently did nothing — the runtime went on serving its cached tool
 * listing and the agent reported the publish tool as "still loading" turn after
 * turn.
 *
 * A dead endpoint fails silently by construction, so pin the live one.
 */
test("the post-connect hook refreshes tools instead of calling the deleted composio-mcp host", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(
    source,
    /async function composioMcpEnsureRunning\(workspaceId: string\): Promise<unknown> \{\s*return refreshWorkspaceMcpTools\(workspaceId\);\s*\}/,
    "composioMcpEnsureRunning must delegate to refreshWorkspaceMcpTools",
  );
});

test("nothing in the main process posts to the deleted composio-mcp route", async () => {
  const source = await readFile(MAIN_PATH, "utf8");
  const offending = source
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(
      ({ line }) =>
        line.includes("composio-mcp/ensure-running") && !line.trimStart().startsWith("*"),
    )
    .map(({ number }) => `main.ts:${number}`);

  assert.deepEqual(
    offending,
    [],
    `these call a route the api-server does not register, so they 404 silently:\n${offending.join("\n")}`,
  );
});

/**
 * The refresh helper is what makes the hook above worth calling: it drops the
 * workspace's MCP tool cache AND the cached Composio listing. If it ever stops
 * pointing at that capability, the hook goes quiet again.
 */
test("refreshWorkspaceMcpTools targets the runtime-tools refresh capability", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(
    source,
    /async function refreshWorkspaceMcpTools\([\s\S]*?path: "\/api\/v1\/capabilities\/runtime-tools\/mcp\/refresh"/,
  );
});
