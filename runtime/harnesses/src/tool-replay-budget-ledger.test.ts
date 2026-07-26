import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeToolReplayBudget,
  resetToolReplayBudgetLedger,
} from "./tool-replay-budget-ledger.js";

test("tool replay budget ledger trims later calls when cumulative replay chars exceed the ledger cap", () => {
  resetToolReplayBudgetLedger();

  const first = consumeToolReplayBudget({
    ledgerKey: "run-1",
    replayChars: 14_000,
    limits: {
      maxReplayChars: 24_000,
      maxReplayItems: 8,
    },
  });
  const second = consumeToolReplayBudget({
    ledgerKey: "run-1",
    replayChars: 12_000,
    limits: {
      maxReplayChars: 24_000,
      maxReplayItems: 8,
    },
  });

  assert.equal(first.mode, "preview");
  assert.equal(first.trimmed, false);
  assert.equal(second.mode, "reference_only");
  assert.equal(second.trimmed, true);
  assert.equal(second.trimReason, "max_replay_chars");
  assert.equal(second.totalReplayChars, 24_000);
});

test("tool replay budget ledger trims later calls when replay item count exceeds the ledger cap", () => {
  resetToolReplayBudgetLedger();

  const first = consumeToolReplayBudget({
    ledgerKey: "run-2",
    replayChars: 100,
    limits: {
      maxReplayChars: 24_000,
      maxReplayItems: 1,
    },
  });
  const second = consumeToolReplayBudget({
    ledgerKey: "run-2",
    replayChars: 100,
    limits: {
      maxReplayChars: 24_000,
      maxReplayItems: 1,
    },
  });

  assert.equal(first.mode, "preview");
  assert.equal(second.mode, "reference_only");
  assert.equal(second.trimReason, "max_replay_items");
  assert.equal(second.totalReplayItems, 1);
});
