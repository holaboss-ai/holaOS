import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const OPERATIONS_DRAWER_PATH = new URL("./OperationsDrawer.tsx", import.meta.url);

test("operations drawer inbox keeps proposal feedback after proactive controls are removed", async () => {
  const source = await readFile(OPERATIONS_DRAWER_PATH, "utf8");

  assert.match(source, /proposalStatusMessage \?/);
  assert.match(source, /label="Sessions"/);
  assert.match(source, />\s*New Session\s*</);
  assert.doesNotMatch(source, /showProactiveControls/);
  assert.doesNotMatch(source, /ProactiveLifecyclePanel/);
  assert.doesNotMatch(source, /Backend proposals require sign-in/);
  assert.doesNotMatch(source, /Sign in for synced proactive controls\./);
  assert.doesNotMatch(source, /label="Running"/);
  assert.doesNotMatch(source, /InboxHeaderActions/);
});

test("operations drawer shows proposal source lane and rationale copy", async () => {
  const source = await readFile(OPERATIONS_DRAWER_PATH, "utf8");

  assert.match(
    source,
    /function proposalSourceLabel\(\s*source: TaskProposalRecordPayload\["proposal_source"\],\s*\): string/,
  );
  assert.match(source, /proposalSourceLabel\(proposal\.proposal_source\)/);
  assert.match(
    source,
    /const rationale =\s*proposal\.task_generation_rationale\.trim\(\)\s*\|\|\s*"No generation rationale was recorded\."/,
  );
});

test("operations drawer can open a centered proposal details dialog from the proposal row", async () => {
  const source = await readFile(OPERATIONS_DRAWER_PATH, "utf8");

  assert.match(source, /function ProposalDetailsDialog\(/);
  assert.match(source, /setExpandedProposalId\(proposal\.proposal_id\)/);
  assert.match(source, /className="-mx-1 flex min-w-0 flex-1 flex-col gap-0\.5 rounded-md px-1 text-left transition-colors hover:bg-fg-2"/);
  assert.match(source, /aria-label="Proposal details"/);
  assert.match(source, /Why This Was Proposed/);
  assert.match(source, /return createPortal\(modalContent, document\.body\);/);
  assert.match(source, /onAcceptProposal=\{onAcceptProposal\}/);
  assert.match(source, /onDismissProposal=\{onDismissProposal\}/);
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
