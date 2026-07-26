// Precedence for which harness a claimed run executes under. The critical
// invariant: an explicit (non-default) session harness always wins over the
// binding — a claude-code session must never silently run on Hola because the
// binding holds a `pi` row (created from the workspace default at
// session-create, or left by a pi checkpoint/compaction run).

import assert from "node:assert/strict";
import test from "node:test";

import { resolveClaimedRunHarness } from "./claimed-input-executor.js";

test("explicit non-default session harness wins over a pi binding (desktop bug)", () => {
  assert.equal(
    resolveClaimedRunHarness({
      sessionHarnessId: "claude-code",
      bindingHarness: "pi",
      workspaceHarness: "pi",
      envHarness: "pi",
    }),
    "claude-code",
  );
});

test("binding wins when the session harness is the pi default (channel switch)", () => {
  // Channel sessions are created without a harness → session.harnessId defaults
  // to pi; the connection's real choice lives on the binding.
  assert.equal(
    resolveClaimedRunHarness({
      sessionHarnessId: "pi",
      bindingHarness: "claude-code",
      workspaceHarness: "pi",
      envHarness: "pi",
    }),
    "claude-code",
  );
  // No session harness at all → same fallback to the binding.
  assert.equal(
    resolveClaimedRunHarness({
      sessionHarnessId: null,
      bindingHarness: "codex",
      workspaceHarness: "pi",
      envHarness: "pi",
    }),
    "codex",
  );
});

test("falls through to workspace default, then env, then pi", () => {
  assert.equal(
    resolveClaimedRunHarness({
      sessionHarnessId: null,
      bindingHarness: null,
      workspaceHarness: "claude-code",
      envHarness: "pi",
    }),
    "claude-code",
  );
  assert.equal(
    resolveClaimedRunHarness({
      sessionHarnessId: null,
      bindingHarness: null,
      workspaceHarness: null,
      envHarness: "codex",
    }),
    "codex",
  );
  assert.equal(
    resolveClaimedRunHarness({
      sessionHarnessId: null,
      bindingHarness: null,
      workspaceHarness: null,
      envHarness: "pi",
    }),
    "pi",
  );
});

test("an explicit session harness is not overridden by a divergent binding", () => {
  // Even a claude-code binding must not override an explicit codex session.
  assert.equal(
    resolveClaimedRunHarness({
      sessionHarnessId: "codex",
      bindingHarness: "claude-code",
      workspaceHarness: "pi",
      envHarness: "pi",
    }),
    "codex",
  );
});
