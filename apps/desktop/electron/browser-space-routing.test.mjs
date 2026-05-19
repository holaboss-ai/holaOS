import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("desktop browser tracks separate user and agent browser spaces and routes tool traffic to the agent space", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /const BROWSER_SPACE_IDS = \["user", "agent"\] as const;/);
  assert.match(source, /let activeBrowserSpaceId: BrowserSpaceId = "user";/);
  assert.match(source, /let activeBrowserSessionId = "";/);
  assert.match(source, /spaces: \{\s*user: createBrowserTabSpaceState\(\),\s*agent: createBrowserTabSpaceState\(\),\s*\}/);
  assert.match(source, /activeAgentSessionId: null,/);
  assert.match(source, /agentSessionSpaces: new Map<string, BrowserTabSpaceState>\(\),/);
  assert.match(source, /function browserAgentSessionSpaceState\(/);
  assert.match(source, /function seedVisibleAgentBrowserSession\(/);
  assert.match(source, /function desktopBrowserSpaceFromRequest\(/);
  assert.match(source, /function oppositeBrowserSpaceId\(space: BrowserSpaceId\): BrowserSpaceId \{/);
  assert.match(source, /function hydrateAgentSessionBrowserSpace\(/);
  assert.match(source, /function suspendAgentSessionBrowserSpace\(/);
  assert.match(source, /function reconcileAgentSessionBrowserSpace\(/);
  assert.match(source, /function initialBrowserTabSeed\(\s*workspaceId: string,\s*space: BrowserSpaceId,\s*sessionId\?: string \| null,\s*\): \{/);
  assert.match(
    source,
    /const sourceSpaceId = oppositeBrowserSpaceId\(space\);[\s\S]*const sourceSpace = browserTabSpaceState\(/,
  );
  assert.match(
    source,
    /skipInitialHistoryRecord: true,/,
  );
  assert.match(
    source,
    /const seed = initialBrowserTabSeed\(workspaceId, space, normalizedSessionId\);[\s\S]*createBrowserTab\(workspaceId, \{[\s\S]*browserSpace: space,[\s\S]*sessionId: normalizedSessionId,/,
  );
  assert.match(
    source,
    /if \(space === "agent" && normalizedSessionId\) \{\s*seedVisibleAgentBrowserSession\(workspace, normalizedSessionId\);\s*\}/,
  );
  assert.match(source, /const requestedSessionId = desktopBrowserSessionIdFromRequest\(request\);/);
  assert.match(source, /const targetSpace = desktopBrowserSpaceFromRequest\(request\);/);
  assert.match(
    source,
    /if \(browserSpace === "agent" && normalizedSessionId\) \{[\s\S]*seedVisibleAgentBrowserSession\(existing, normalizedSessionId\);[\s\S]*touchAgentSessionBrowserSpace\(normalizedWorkspaceId, normalizedSessionId\);[\s\S]*return existing;/,
  );
  assert.match(
    source,
    /else if \(requestedSessionId\) \{\s*touchAgentSessionBrowserSpace\(targetWorkspaceId, requestedSessionId\);\s*\}/,
  );
  assert.doesNotMatch(
    source,
    /else if \(requestedSessionId\) \{[\s\S]*setVisibleAgentBrowserSession\(workspace, requestedSessionId\)/,
  );
  assert.match(source, /emitWorkbenchOpenBrowser\(\{\s*workspaceId: targetWorkspaceId,\s*url: targetUrl,\s*space: targetSpace,\s*sessionId: requestedSessionId \|\| null,\s*\}\);/);
  assert.match(source, /browserWorkspaceSnapshot\(targetWorkspaceId, targetSpace, ensuredSessionId,/);
});
