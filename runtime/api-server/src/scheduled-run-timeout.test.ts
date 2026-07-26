import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SCHEDULED_RUN_TIMEOUT_SECONDS,
  effectiveHarnessRunTimeoutSeconds,
  resolveHarnessTimeoutSecondsForRun,
} from "./scheduled-run-timeout.js";

test("scheduled (cronjob) runs get the 2h ceiling instead of the 30-min cap", () => {
  assert.equal(
    resolveHarnessTimeoutSecondsForRun({
      baseTimeoutSeconds: 1800,
      createdBy: "cronjob",
    }),
    SCHEDULED_RUN_TIMEOUT_SECONDS,
  );
  // Case-insensitive / trimmed.
  assert.equal(
    resolveHarnessTimeoutSecondsForRun({
      baseTimeoutSeconds: 1800,
      createdBy: " Cronjob ",
    }),
    SCHEDULED_RUN_TIMEOUT_SECONDS,
  );
});

test("non-scheduled runs keep the harness-computed timeout unchanged", () => {
  assert.equal(
    resolveHarnessTimeoutSecondsForRun({
      baseTimeoutSeconds: 1800,
      createdBy: "workspace_user",
    }),
    1800,
  );
  assert.equal(
    resolveHarnessTimeoutSecondsForRun({
      baseTimeoutSeconds: null,
      createdBy: null,
    }),
    null,
  );
});

test("an already-longer base timeout is preserved (never shortened)", () => {
  // e.g. a subagent-style base already above the scheduled ceiling.
  assert.equal(
    resolveHarnessTimeoutSecondsForRun({
      baseTimeoutSeconds: 9000,
      createdBy: "cronjob",
    }),
    9000,
  );
});

test("effectiveHarnessRunTimeoutSeconds raises pi's abort timer to the request ceiling", () => {
  // The bug this fixes: a cronjob main-session run carried harness_timeout_seconds
  // 7200 on the request, but ts-runner used only the plugin default (1800), so pi
  // self-aborted at 30 min. The override must win when larger.
  assert.equal(
    effectiveHarnessRunTimeoutSeconds({
      pluginTimeoutSeconds: 1800,
      requestOverrideSeconds: 7200,
    }),
    7200,
  );
});

test("effectiveHarnessRunTimeoutSeconds falls back to the plugin default when no override", () => {
  // Direct/legacy callers that never set harness_timeout_seconds → parsed as 0.
  assert.equal(
    effectiveHarnessRunTimeoutSeconds({ pluginTimeoutSeconds: 1800, requestOverrideSeconds: 0 }),
    1800,
  );
  assert.equal(
    effectiveHarnessRunTimeoutSeconds({ pluginTimeoutSeconds: 1800, requestOverrideSeconds: null }),
    1800,
  );
  assert.equal(
    effectiveHarnessRunTimeoutSeconds({
      pluginTimeoutSeconds: 1800,
      requestOverrideSeconds: undefined,
    }),
    1800,
  );
});

test("effectiveHarnessRunTimeoutSeconds never shortens a larger plugin default (subagents)", () => {
  // Subagent plugin default is already 7200; a smaller/zero override must not cut it.
  assert.equal(
    effectiveHarnessRunTimeoutSeconds({ pluginTimeoutSeconds: 7200, requestOverrideSeconds: 1800 }),
    7200,
  );
});
