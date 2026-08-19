import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * A session created from the composer must appear in the sidebar immediately.
 *
 * The main-session lists are poll-driven at 5s. That is fine for change caused
 * elsewhere, but wrong for change this client just made: after sending the
 * first message of a new session, the session existed server-side and was
 * selected in the pane, while the sidebar had no row for it for up to a full
 * poll interval — the session the user had just started was on screen nowhere.
 *
 * Structural, in a `.test.ts` deliberately: `test:unit` globs `.test.ts` /
 * `.test.tsx`, so a guard written as `.mjs` under src/ would never run.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const listsSource = readFileSync(
  path.join(here, "useWorkspaceLists.ts"),
  "utf-8",
);
const chatPaneSource = readFileSync(
  path.join(here, "..", "..", "panes", "ChatPane", "index.tsx"),
  "utf-8",
);

test("the main-sessions hook refreshes on a broadcast, not only on its poll", () => {
  assert.match(
    listsSource,
    /export function notifyMainSessionsChanged\(\): void/,
    "the broadcast helper must exist and take no payload",
  );
  assert.match(
    listsSource,
    /addEventListener\(MAIN_SESSIONS_CHANGED/,
    "useWorkspaceMainSessions must subscribe to it",
  );
  assert.match(
    listsSource,
    /removeEventListener\(MAIN_SESSIONS_CHANGED/,
    "and unsubscribe on cleanup, or every remount leaks a listener that reloads forever",
  );
});

test("the broadcast carries no fabricated session row", () => {
  // createAgentSession returns an AgentSessionRecordPayload, which has no
  // is_active and so is not a MainSessionRecordPayload. Inserting it
  // optimistically would mean inventing that field — a row on screen whose
  // state was guessed. A reload is one local IPC, so the row still appears
  // immediately; it is just the server's row instead of ours.
  const helper =
    /export function notifyMainSessionsChanged\(\)[\s\S]*?\n}/.exec(listsSource)?.[0] ??
    "";
  assert.ok(helper.length > 0, "helper not found");
  assert.doesNotMatch(
    helper,
    /is_active/,
    "the signal must not carry a synthesized session record",
  );
});

test("ChatPane broadcasts from every path that can make a session listable", () => {
  // Three: the two creation paths, plus — critically — the point where the
  // input is queued.
  const calls = chatPaneSource.match(/notifyMainSessionsChanged\(\)/g) ?? [];
  assert.equal(
    calls.length,
    3,
    `expected creation paths plus the queue-accepted path, found ${calls.length}`,
  );
});

test("the queue-accepted broadcast is the one that makes the row appear", () => {
  // The sidebar hides titleless sessions (they are empty placeholders there),
  // and the title is derived server-side from the first user message by the
  // queue-input route. Broadcasting only at creation reloads a list in which
  // the session is still untitled and therefore still filtered out — the row
  // waits for the next 5s poll regardless. The broadcast has to happen after
  // the queue call returns.
  const afterAccept = /queueAccepted = true;[\s\S]{0,1200}?notifyMainSessionsChanged\(\)/.test(
    chatPaneSource,
  );
  assert.ok(
    afterAccept,
    "expected a broadcast shortly after queueAccepted = true",
  );
});
