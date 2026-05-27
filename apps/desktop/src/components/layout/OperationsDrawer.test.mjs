import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const OPERATIONS_DRAWER_PATH = new URL("./OperationsDrawer.tsx", import.meta.url);

test("operations drawer inbox stays empty in issue-first v1", async () => {
  const source = await readFile(OPERATIONS_DRAWER_PATH, "utf8");

  assert.match(source, /title=\{hasWorkspace \? "Inbox is empty for now" : "Choose a workspace"\}/);
  assert.match(source, /Issue-first v1 does not surface proposal review here\./);
  assert.match(source, /label="Sessions"/);
  assert.match(source, />\s*New Session\s*</);
  assert.doesNotMatch(source, /showProactiveControls/);
  assert.doesNotMatch(source, /ProactiveLifecyclePanel/);
  assert.doesNotMatch(source, /Backend proposals require sign-in/);
  assert.doesNotMatch(source, /Sign in for synced proactive controls\./);
  assert.doesNotMatch(source, /label="Running"/);
  assert.doesNotMatch(source, /InboxHeaderActions/);
});

test("operations drawer inbox uses the shared empty-state component", async () => {
  const source = await readFile(OPERATIONS_DRAWER_PATH, "utf8");

  assert.match(source, /export function OperationsInboxPane\(\{/);
  assert.match(source, /<EmptyState/);
  assert.match(source, /icon=\{InboxIcon\}/);
});

test("operations drawer keeps running sessions available beside the empty inbox", async () => {
  const source = await readFile(OPERATIONS_DRAWER_PATH, "utf8");

  assert.match(source, /activeTab === "running" \? \(/);
  assert.match(source, /function defaultSessionTitle\(/);
  assert.match(source, /if \(normalizedKind === "subagent"\) \{\s*return "Subagent run";\s*\}/);
});

test("operations drawer no longer carries the deprecated proactive sign-in notice", async () => {
  const source = await readFile(OPERATIONS_DRAWER_PATH, "utf8");

  assert.doesNotMatch(source, /Backend proposals require sign-in/);
  assert.doesNotMatch(source, /Sign in for synced proactive controls\./);
  assert.doesNotMatch(source, /size="xs"/);
  assert.doesNotMatch(source, /useDesktopAuthSession/);
  assert.doesNotMatch(source, /LogIn size=\{12\}/);
});

test("operations drawer session rows expose pointer cursor affordance", async () => {
  const source = await readFile(OPERATIONS_DRAWER_PATH, "utf8");

  assert.match(
    source,
    /aria-label=\{`Open session \$\{session\.title\}`\}[\s\S]*className=\{`w-full cursor-pointer px-3 py-3 text-left transition-colors/,
  );
});

test("operations drawer can badge the inbox tab for unread proposals", async () => {
  const source = await readFile(OPERATIONS_DRAWER_PATH, "utf8");

  assert.match(source, /unreadProposalCount: number;/);
  assert.match(source, /showIndicator=\{unreadProposalCount > 0\}/);
  assert.match(source, /showIndicator = false,/);
  assert.match(source, /className="absolute -right-0\.5 -top-0\.5"/);
});

test("operations drawer derives a completed status from the last turn result when runtime is idle", async () => {
  const source = await readFile(OPERATIONS_DRAWER_PATH, "utf8");

  assert.match(source, /function runningSessionState\(entry:/);
  assert.match(source, /const lastTurnStatus = normalizeTurnResultStatus\(entry\.last_turn_status\);/);
  assert.match(source, /if \(lastTurnStatus === "completed"\) \{\s*return "COMPLETED";\s*\}/);
  assert.match(source, /stateTimestamp: runningSessionStateTimestamp\(state\),/);
  assert.match(source, /stateDetail: runningSessionStateDetail\(stateLabel\),/);
  assert.match(source, /\{session\.stateDetail\}[\s\S]*relativeTime\(session\.stateTimestamp\)/);
});

test("operations drawer refreshes running session state frequently while visible", async () => {
  const source = await readFile(OPERATIONS_DRAWER_PATH, "utf8");

  assert.match(source, /const RUNNING_SESSIONS_POLL_INTERVAL_MS = 1000;/);
  assert.match(source, /window\.addEventListener\("focus", refreshRunningSessions\);/);
  assert.match(source, /document\.addEventListener\(\s*"visibilitychange",\s*refreshVisibleRunningSessions,/);
  assert.match(source, /if \(requestInFlight\) \{\s*return;\s*\}/);
});

test("operations drawer uses centered icon indicators for session status", async () => {
  const source = await readFile(OPERATIONS_DRAWER_PATH, "utf8");

  assert.match(source, /function runningSessionStatusIndicator\(/);
  assert.match(source, /const statusIndicator = runningSessionStatusIndicator\(/);
  assert.match(source, /className="flex items-center gap-3"/);
  assert.match(source, /role="img"/);
  assert.match(source, /title=\{statusIndicator\.label\}/);
  assert.doesNotMatch(source, /<Badge/);
});
