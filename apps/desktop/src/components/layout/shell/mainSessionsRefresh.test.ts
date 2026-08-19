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

test("both session-creation paths in ChatPane broadcast", () => {
  // Two places create a session: createWorkspaceSession (the composer's first
  // send) and the app/main-session path. Missing either leaves the original
  // 5s gap on that route.
  const calls = chatPaneSource.match(/notifyMainSessionsChanged\(\)/g) ?? [];
  assert.equal(
    calls.length,
    2,
    `expected both creation paths to broadcast, found ${calls.length}`,
  );
});
