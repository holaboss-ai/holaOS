import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_PATH = new URL("./main.ts", import.meta.url);

/**
 * The body of a top-level function, from its signature to the next one.
 *
 * Matching with an unbounded `[\s\S]*?` across a 30k-line file is not a guard:
 * it happily spans unrelated code, so a function repointed at a dead route still
 * "passes" as long as the live path is mentioned ANYWHERE later in the file.
 * That was demonstrated against the first version of this test.
 */
async function functionBody(name) {
  const lines = (await readFile(MAIN_PATH, "utf8")).split("\n");
  const signature = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function ${name}\\b`);
  const start = lines.findIndex((line) => signature.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^(?:export\s+)?(?:async\s+)?function [\w$]+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

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

  const body = await functionBody("composioMcpEnsureRunning");
  assert.ok(body, "composioMcpEnsureRunning not found — did the signature change?");
  // Pin the DELEGATION, not the signature: tightening the return type is a
  // behaviour-preserving improvement and must not fail this guard.
  assert.ok(
    body.includes("return refreshWorkspaceMcpTools(workspaceId);"),
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
  const body = await functionBody("refreshWorkspaceMcpTools");

  assert.ok(body, "refreshWorkspaceMcpTools not found — did the signature change?");
  assert.ok(
    body.includes('path: "/api/v1/capabilities/runtime-tools/mcp/refresh"'),
    "the refresh helper no longer posts the live capability, so the post-connect hook is inert again",
  );
});
