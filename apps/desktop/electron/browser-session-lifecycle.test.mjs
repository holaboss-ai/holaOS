import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("desktop browser can suspend and rehydrate session-owned agent browser surfaces", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /type BrowserSurfaceLifecycleState = "active" \| "suspended";/);
  assert.match(source, /persistedTabs: BrowserWorkspaceTabPersistencePayload\[\];/);
  assert.match(source, /lifecycleState: BrowserSurfaceLifecycleState;/);
  assert.match(source, /suspendTimer: ReturnType<typeof setTimeout> \| null;/);
  assert.match(source, /function browserTabSpacePersistencePayload\(/);
  assert.match(source, /function browserTabSpaceStates\(/);
  assert.match(source, /function hydrateAgentSessionBrowserSpace\(/);
  assert.match(source, /function suspendAgentSessionBrowserSpace\(/);
  assert.match(source, /function scheduleAgentSessionBrowserLifecycleCheck\(/);
  assert.match(source, /function reconcileAgentSessionBrowserSpace\(/);
  assert.match(source, /status === "WAITING_USER" \|\| status === "PAUSED"/);
  assert.match(source, /SESSION_BROWSER_WARM_TTL_MS/);
  assert.match(source, /SESSION_BROWSER_COMPLETED_GRACE_MS/);
  assert.match(source, /agentTabSpace\.persistedTabs = persistedTabs;/);
  assert.match(source, /agentTabSpace\.lifecycleState =\s*persistedTabs\.length > 0 \? "suspended" : "active";/);
  assert.match(source, /hydrateAgentSessionBrowserSpace\(normalizedWorkspaceId, normalizedSessionId\);/);
  assert.match(source, /scheduleAgentSessionBrowserLifecycleCheck\(workspaceId, normalizedSessionId\);/);
});
