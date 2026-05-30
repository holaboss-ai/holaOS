import assert from "node:assert/strict";
import test from "node:test";

import type { TurnResultRecord } from "@holaboss/runtime-state-store";

import { compactTurnSummary } from "./turn-result-summary.js";

function makeTurnResult(overrides: Partial<TurnResultRecord> = {}): TurnResultRecord {
  return {
    workspaceId: "workspace-1",
    sessionId: "session-1",
    inputId: "input-1",
    startedAt: "2026-04-29T00:00:00.000Z",
    completedAt: "2026-04-29T00:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "",
    toolUsageSummary: {
      total_calls: 0,
      completed_calls: 0,
      failed_calls: 0,
      tool_names: [],
      tool_ids: [],
    },
    permissionDenials: [],
    promptSectionIds: [],
    capabilityManifestFingerprint: null,
    requestSnapshotFingerprint: null,
    promptCacheProfile: null,
    tokenUsage: null,
    contextBudgetDecisions: null,
    createdAt: "2026-04-29T00:00:05.000Z",
    updatedAt: "2026-04-29T00:00:05.000Z",
    ...overrides,
  };
}

test("compactTurnSummary prefers assistant output when present", () => {
  const summary = compactTurnSummary(
    makeTurnResult({
      assistantText: "Implemented the browser wait improvements.\nVerified the runtime tests.",
    }),
  );
  assert.equal(summary, "Implemented the browser wait improvements. Verified the runtime tests.");
});

test("compactTurnSummary falls back to browser-heavy summaries when assistant text is empty", () => {
  const summary = compactTurnSummary(
    makeTurnResult({
      toolUsageSummary: {
        total_calls: 3,
        completed_calls: 3,
        failed_calls: 0,
        tool_names: ["browser_get_state", "browser_type", "browser_wait"],
        tool_ids: ["browser_get_state", "browser_type", "browser_wait"],
        browser: {
          total_calls: 3,
          state_reads: 2,
          compact_state_reads: 2,
          standard_state_reads: 0,
          truncated_state_reads: 1,
          action_calls: 1,
          wait_calls: 1,
          find_calls: 0,
          screenshot_calls: 0,
          page_text_chars: 120,
        },
      },
    }),
  );
  assert.equal(
    summary,
    "Browser-heavy run completed after 3 browser calls, 2 state reads, 1 action, 1 wait, 2 compact snapshots, 1 truncated snapshot with stop reason ok.",
  );
});

test("compactTurnSummary includes failed browser-heavy runs when no assistant text is available", () => {
  const summary = compactTurnSummary(
    makeTurnResult({
      status: "failed",
      stopReason: "timeout",
      toolUsageSummary: {
        total_calls: 1,
        completed_calls: 0,
        failed_calls: 1,
        tool_names: ["browser_wait"],
        tool_ids: ["browser_wait"],
        browser: {
          total_calls: 1,
          state_reads: 0,
          compact_state_reads: 0,
          standard_state_reads: 0,
          truncated_state_reads: 0,
          action_calls: 0,
          wait_calls: 1,
          find_calls: 0,
          screenshot_calls: 0,
          page_text_chars: 0,
        },
      },
    }),
  );
  assert.equal(
    summary,
    "Browser-heavy run failed after 1 browser call, 1 wait with stop reason timeout.",
  );
});

test("compactTurnSummary surfaces edited files when a run completed without assistant text", () => {
  const summary = compactTurnSummary(
    makeTurnResult({
      toolUsageSummary: {
        total_calls: 1,
        completed_calls: 1,
        failed_calls: 0,
        tool_names: ["edit"],
        tool_ids: ["edit"],
        edited_files: ["apps/desktop/src/App.tsx"],
      },
    }),
  );
  assert.equal(summary, "Updated apps/desktop/src/App.tsx.");
});
