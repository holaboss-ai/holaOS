import assert from "node:assert/strict";
import test from "node:test";

import type { CronjobRecord } from "../../state-store/src/store.js";
import {
  RUNTIME_AGENT_TOOL_DEFINITIONS as HARNESS_DEFS,
  RUNTIME_AGENT_TOOL_IDS,
} from "../../harnesses/src/runtime-agent-tools.js";
import { buildAgentCapabilityManifest } from "./agent-capability-registry.js";
import {
  cronjobListPayload,
  cronjobPayload,
  withCronjobAgentTimeHints,
  RUNTIME_AGENT_TOOL_DEFINITIONS as ROUTE_DEFS,
} from "./runtime-agent-tools.js";

function makeCronjobRecord(overrides: Partial<CronjobRecord> = {}): CronjobRecord {
  return {
    id: "cron_1",
    workspaceId: "ws_1",
    initiatedBy: "user",
    name: "Nightly digest",
    cron: "0 9 * * *",
    description: "Summarize the day",
    instruction: "short instruction",
    enabled: true,
    delivery: {},
    metadata: {},
    lastRunAt: null,
    nextRunAt: null,
    runCount: 0,
    lastStatus: null,
    lastError: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

const CRONJOB_TOOL_IDS = [
  "cronjobs_list",
  "cronjobs_get",
  "cronjobs_create",
  "cronjobs_update",
  "cronjobs_delete",
  "cronjobs_run_now",
] as const;

const EXPECTED_TOOLS = [
  { id: "cronjobs_list", method: "GET", path: "/api/v1/capabilities/runtime-tools/cronjobs", policy: "inspect" },
  { id: "cronjobs_get", method: "GET", path: "/api/v1/capabilities/runtime-tools/cronjobs/:jobId", policy: "inspect" },
  { id: "cronjobs_create", method: "POST", path: "/api/v1/capabilities/runtime-tools/cronjobs", policy: "mutate" },
  { id: "cronjobs_update", method: "PATCH", path: "/api/v1/capabilities/runtime-tools/cronjobs/:jobId", policy: "mutate" },
  { id: "cronjobs_delete", method: "DELETE", path: "/api/v1/capabilities/runtime-tools/cronjobs/:jobId", policy: "mutate" },
  { id: "cronjobs_run_now", method: "POST", path: "/api/v1/capabilities/runtime-tools/cronjobs/:jobId/run", policy: "mutate" },
] as const;

test("cronjob lifecycle tools are registered with correct routes and policies", () => {
  for (const expected of EXPECTED_TOOLS) {
    const harnessEntry = HARNESS_DEFS.find((tool) => tool.id === expected.id);
    assert.ok(harnessEntry, `harness definition for ${expected.id} should exist`);
    assert.equal(harnessEntry?.policy, expected.policy, `${expected.id} policy`);
    assert.ok(
      (harnessEntry?.description ?? "").length > 20,
      `${expected.id} should have a non-trivial description for the model`,
    );

    const routeEntry = ROUTE_DEFS.find((tool) => tool.id === expected.id);
    assert.ok(routeEntry, `route registration for ${expected.id} should exist`);
    assert.equal(routeEntry?.method, expected.method, `${expected.id} method`);
    assert.equal(routeEntry?.path, expected.path, `${expected.id} path`);
  }
});

// Proves the cronjob tools surface to the main session's capability manifest.
// In production, ts-runner's `projectExtraToolIdsForSession` filters
// extra_tools against `MAIN_SESSION_RUNTIME_TOOL_IDS` before the manifest
// is built — so this test simulates that projection by passing the cronjob
// ids through `extraTools`. If a future change drops cronjob_* from that
// allow-list, `MAIN_SESSION_RUNTIME_TOOL_IDS` membership is asserted below
// by `MAIN_SESSION_RUNTIME_TOOL_IDS allow-lists every cronjob lifecycle tool`.
test("main_session manifest surfaces every cronjob lifecycle tool", () => {
  const manifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "main_session",
    runtimeToolIds: [...RUNTIME_AGENT_TOOL_IDS],
    defaultTools: ["read"],
    extraTools: [...CRONJOB_TOOL_IDS],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
  });

  // Presence in manifest.runtime_tools already implies visible_to_model
  // (projectAgentCapabilityManifest filters by that flag before projecting),
  // and a non-null callable_name confirms the model can actually invoke it.
  const byId = new Map(manifest.runtime_tools.map((tool) => [tool.id, tool]));
  for (const toolId of CRONJOB_TOOL_IDS) {
    const tool = byId.get(toolId);
    assert.ok(tool, `${toolId} should be surfaced to main_session`);
    assert.equal(tool?.callable_name, toolId, `${toolId} should be callable`);
  }
});

// The ts-runner allow-list is the actual gate that decides whether a tool
// reaches the main session's extra_tools (and thus its capability manifest).
// Source-grep the allow-list directly so accidental removal is caught here
// rather than only in the integration test above. Also assert the
// SUBAGENT_BLOCKED set so cronjob tools stay off of backstage executors —
// persistent workspace state belongs to front-of-house controllers, not
// short-lived subagents.
test("ts-runner gates cronjob tools to front-of-house controllers", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("./ts-runner.ts", import.meta.url),
    "utf8",
  );
  const allowListMatch = source.match(
    /const MAIN_SESSION_RUNTIME_TOOL_IDS = new Set\(\[([\s\S]*?)\]\);/,
  );
  assert.ok(allowListMatch, "could not find MAIN_SESSION_RUNTIME_TOOL_IDS");
  const allowList = allowListMatch[1];
  for (const toolId of CRONJOB_TOOL_IDS) {
    assert.ok(
      allowList.includes(`"${toolId}"`),
      `${toolId} should be allow-listed for the main session in ts-runner.ts`,
    );
  }

  const subagentOnlyBlockedMatch = source.match(
    /const SUBAGENT_ONLY_BLOCKED_RUNTIME_TOOL_IDS = new Set\(\[([\s\S]*?)\]\);/,
  );
  assert.ok(
    subagentOnlyBlockedMatch,
    "could not find SUBAGENT_ONLY_BLOCKED_RUNTIME_TOOL_IDS",
  );
  const subagentOnlyBlocked = subagentOnlyBlockedMatch[1];
  for (const toolId of CRONJOB_TOOL_IDS) {
    assert.ok(
      subagentOnlyBlocked.includes(`"${toolId}"`),
      `${toolId} should be in SUBAGENT_ONLY_BLOCKED_RUNTIME_TOOL_IDS so subagents cannot mint or change cronjobs while main_session retains them`,
    );
  }

  // Belt-and-braces: cronjobs must NOT be in the shared SUBAGENT_BLOCKED
  // set, since the main_session filter also applies SUBAGENT_BLOCKED.
  const subagentBlockedMatch = source.match(
    /const SUBAGENT_BLOCKED_RUNTIME_TOOL_IDS = new Set\(\[([\s\S]*?)\]\);/,
  );
  assert.ok(subagentBlockedMatch, "could not find SUBAGENT_BLOCKED_RUNTIME_TOOL_IDS");
  const subagentBlocked = subagentBlockedMatch[1];
  for (const toolId of CRONJOB_TOOL_IDS) {
    assert.ok(
      !subagentBlocked.includes(`"${toolId}"`),
      `${toolId} must NOT be in SUBAGENT_BLOCKED_RUNTIME_TOOL_IDS — that set is applied to main_session and would strip cronjobs from the controller`,
    );
  }
});


test("cronjobListPayload keeps a short instruction in full and always reports its length", () => {
  const short = "do the thing";
  const payload = cronjobListPayload(makeCronjobRecord({ instruction: short }));

  // Under the preview threshold: the full instruction stays put, no preview /
  // truncation markers, and instruction_chars reports the true length.
  assert.equal(payload.instruction, short);
  assert.equal(payload.instruction_chars, short.length);
  assert.equal(payload.instruction_preview, undefined);
  assert.equal(payload.instruction_truncated, undefined);
});

test("cronjobListPayload trims a long instruction to a preview and drops the full text", () => {
  const long = "x".repeat(1000);
  const payload = cronjobListPayload(makeCronjobRecord({ instruction: long }));

  // Over the threshold: the token-heavy full instruction is withheld entirely
  // (so a truncated value can't be mistaken for the whole prompt); the caller
  // gets a bounded preview, a truncation flag, and the true character count.
  assert.equal(payload.instruction, undefined);
  assert.equal(payload.instruction_truncated, true);
  assert.equal(payload.instruction_chars, 1000);
  assert.equal(typeof payload.instruction_preview, "string");
  const preview = payload.instruction_preview as string;
  // Bounded well under the raw instruction (preview + single ellipsis).
  assert.ok(preview.length < long.length);
  assert.ok(preview.endsWith("…"));

  // cronjobs_get (the single-read path) still returns the whole instruction.
  const full = cronjobPayload(makeCronjobRecord({ instruction: long }));
  assert.equal(full.instruction, long);
});

test("withCronjobAgentTimeHints spells out the pinned timezone and local next-run", () => {
  // `0 8 * * *` pinned to Asia/Shanghai fires at 08:00 Shanghai = 00:00 UTC.
  const record = makeCronjobRecord({
    cron: "0 8 * * *",
    metadata: { timezone: "Asia/Shanghai" },
    nextRunAt: "2026-07-10T00:00:00.000Z",
  });
  const hinted = withCronjobAgentTimeHints(cronjobPayload(record));

  assert.equal(hinted.runs_in_timezone, "Asia/Shanghai");
  const local = hinted.next_run_local as string;
  assert.equal(typeof local, "string");
  // The whole point: it must render 08:00 (local wall-clock), NOT the 00:00 UTC
  // instant, and name the timezone so the model can't mislabel it.
  assert.ok(local.includes("08:00"), `expected 08:00 in "${local}"`);
  assert.ok(local.includes("Asia/Shanghai"), `expected tz label in "${local}"`);
  assert.ok(!local.includes("00:00"), `must not leak the UTC 00:00 in "${local}"`);
});

test("withCronjobAgentTimeHints stays null-safe for disabled or timezone-less jobs", () => {
  // Disabled job: no next_run_at → no local render, but tz still reported.
  const disabled = withCronjobAgentTimeHints(
    cronjobPayload(
      makeCronjobRecord({
        enabled: false,
        nextRunAt: null,
        metadata: { timezone: "Asia/Shanghai" },
      }),
    ),
  );
  assert.equal(disabled.runs_in_timezone, "Asia/Shanghai");
  assert.equal(disabled.next_run_local, null);

  // No pinned timezone → both hint fields null (never a bogus conversion).
  const noTz = withCronjobAgentTimeHints(
    cronjobPayload(
      makeCronjobRecord({ metadata: {}, nextRunAt: "2026-07-10T00:00:00.000Z" }),
    ),
  );
  assert.equal(noTz.runs_in_timezone, null);
  assert.equal(noTz.next_run_local, null);
});

test("the timezone hints are agent-only — cronjobPayload (desktop oRPC shape) omits them", () => {
  // The desktop RemoteCronjobRecord schema rejects unknown keys, so the base
  // payload must NOT carry the hint fields; only the agent boundary adds them.
  const base = cronjobPayload(
    makeCronjobRecord({ metadata: { timezone: "Asia/Shanghai" } }),
  );
  assert.equal("runs_in_timezone" in base, false);
  assert.equal("next_run_local" in base, false);

  // cronjobs_list (agent path) DOES carry them.
  const listed = cronjobListPayload(
    makeCronjobRecord({
      metadata: { timezone: "Asia/Shanghai" },
      nextRunAt: "2026-07-10T00:00:00.000Z",
    }),
  );
  assert.equal(listed.runs_in_timezone, "Asia/Shanghai");
  assert.equal(typeof listed.next_run_local, "string");
});

test("subagent manifest does NOT surface cronjob lifecycle tools", () => {
  // The subagent capability path applies the SUBAGENT_BLOCKED filter via
  // ts-runner before buildAgentCapabilityManifest. To prove the end-to-end
  // outcome we have to simulate that filter here; once the manifest is
  // built off filtered ids, cronjob tools should not appear.
  const surfacedExtraTools = [...RUNTIME_AGENT_TOOL_IDS].filter(
    (toolId) => !CRONJOB_TOOL_IDS.includes(toolId as (typeof CRONJOB_TOOL_IDS)[number]),
  );
  const manifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "subagent",
    runtimeToolIds: surfacedExtraTools,
    defaultTools: ["read"],
    extraTools: surfacedExtraTools,
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
  });

  const surfacedIds = new Set(manifest.runtime_tools.map((tool) => tool.id));
  for (const toolId of CRONJOB_TOOL_IDS) {
    assert.ok(
      !surfacedIds.has(toolId),
      `${toolId} should NOT be surfaced to subagents`,
    );
  }
});
