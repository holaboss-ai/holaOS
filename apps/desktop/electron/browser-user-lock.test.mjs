import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("desktop browser protects shared and session-owned browser control with a confirmed interrupt flow", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /const USER_BROWSER_LOCK_TIMEOUT_MS = 15_000;/);
  assert.match(source, /interface BrowserUserLockState \{/);
  assert.match(source, /userBrowserLock: BrowserUserLockState \| null;/);
  assert.match(source, /const sessionRuntimeStateCache = new Map<\s*string,\s*Map<string, SessionRuntimeRecordPayload>\s*>\(\);/);
  assert.match(source, /function ensureUserBrowserLock\(/);
  assert.match(source, /function releaseUserBrowserLock\(/);
  assert.match(source, /function cacheRuntimeStateRecords\(/);
  assert.match(source, /function upsertCachedRuntimeStateRecord\(/);
  assert.match(source, /function getCachedRuntimeStateRecord\(/);
  assert.match(source, /function confirmBrowserInterrupt\(/);
  assert.match(source, /buttons: \["Let agent continue", "Interrupt and take over"\]/);
  assert.match(source, /The agent is currently controlling this browser\./);
  assert.match(source, /await pauseSessionRun\(\{\s*workspace_id: workspaceId,\s*session_id: sessionId,\s*\}\);/);
  assert.match(source, /const items = cacheRuntimeStateRecords\(workspaceId, response\.items \?\? \[\]\);/);
  assert.match(source, /upsertCachedRuntimeStateRecord\(\{\s*workspace_id: payload\.workspace_id,\s*session_id: response\.session_id,/s);
  assert.match(source, /upsertCachedRuntimeStateRecord\(\{\s*workspace_id: payload\.workspace_id,\s*session_id: response\.session_id \|\| payload\.session_id,/s);
  assert.match(source, /browserSessionId\(sessionId\)\s*\|\|\s*browserSessionId\(browserWorkspaceFromMap\(workspaceId\)\?\.activeAgentSessionId\)/);
  assert.match(source, /return status === "BUSY" \|\| status === "QUEUED" \|\| status === "PAUSING";/);
  assert.match(source, /const programmaticBrowserInputDepth = new WeakMap<WebContents, number>\(\);/);
  assert.match(source, /function isProgrammaticBrowserInput\(webContents: WebContents\): boolean \{/);
  assert.match(source, /async function withProgrammaticBrowserInput<T>\(/);
  assert.match(source, /view\.webContents\.on\("before-input-event", \(event, input\) => \{/);
  assert.match(source, /if \(isProgrammaticBrowserInput\(view\.webContents\)\) \{\s*return;\s*\}/);
  assert.match(source, /view\.webContents\.on\("before-mouse-event", \(event, mouse\) => \{/);
  assert.match(source, /maybePromptBrowserInterrupt\(\s*workspaceId,\s*browserSpace,\s*normalizedSessionId,\s*\)/);
  assert.match(source, /await withProgrammaticBrowserInput\(activeTab\.view\.webContents, async \(\) => \{/);
  assert.match(source, /const targetSpace = desktopBrowserSpaceFromRequest\(request\);/);
  assert.match(source, /Header 'x-holaboss-session-id' is required when targeting the user browser\./);
  assert.match(source, /code: "user_browser_locked"/);
  assert.match(source, /maybePromptBrowserInterrupt\(\s*activeBrowserWorkspaceId,\s*activeBrowserSpaceId,\s*activeBrowserSpaceId === "agent" \? activeBrowserSessionId : null,\s*\)/);
  assert.doesNotMatch(source, /maybePromptUserBrowserInterrupt/);
});
