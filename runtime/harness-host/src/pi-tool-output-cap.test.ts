import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createToolOutputCapState, wrapToolWithOutputCap } from "./pi.js";

function textTool(bytes: number) {
  return {
    name: "read",
    execute: async (..._args: unknown[]) => ({
      content: [{ type: "text", text: "z".repeat(bytes) }],
    }),
  };
}

function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = prev;
  }
}

test("wrapToolWithOutputCap tightens once the run's inlined tool output crosses the session budget", async () => {
  const prev = {
    max: process.env.HOLABOSS_MAX_TOOL_OUTPUT_BYTES,
    budget: process.env.HOLABOSS_SESSION_TOOL_OUTPUT_BUDGET_BYTES,
    tight: process.env.HOLABOSS_TOOL_OUTPUT_TIGHTENED_BYTES,
  };
  process.env.HOLABOSS_MAX_TOOL_OUTPUT_BYTES = String(50 * 1024);
  process.env.HOLABOSS_SESSION_TOOL_OUTPUT_BUDGET_BYTES = String(40 * 1024);
  process.env.HOLABOSS_TOOL_OUTPUT_TIGHTENED_BYTES = String(8 * 1024);
  const root = mkdtempSync(join(tmpdir(), "hb-tool-cap-"));
  try {
    // One shared accumulator across every wrapped tool — like a runPi.
    const state = createToolOutputCapState();
    const call = (bytes: number) =>
      wrapToolWithOutputCap(textTool(bytes), root, state).execute("call", {});

    // Under the 50KB per-call cap AND under the 40KB session budget → inlined.
    const r1 = await call(20 * 1024);
    assert.equal(r1.content[0].text.length, 20 * 1024);
    // Still under budget when this call starts (20KB inlined) → inlined; now 45KB total.
    const r2 = await call(25 * 1024);
    assert.equal(r2.content[0].text.length, 25 * 1024);
    // Cumulative inlined (45KB) has crossed the 40KB budget → cap tightens to
    // 8KB → this 20KB result is offloaded (stubbed), not inlined.
    const r3 = await call(20 * 1024);
    assert.match(r3.content[0].text, /Tool output truncated/);
    assert.ok(r3.content[0].text.length < 20 * 1024, "offloaded result should be a short stub");
    // A small (4KB) result still passes even after the budget is spent.
    const r4 = await call(4 * 1024);
    assert.equal(r4.content[0].text.length, 4 * 1024);
  } finally {
    restoreEnv("HOLABOSS_MAX_TOOL_OUTPUT_BYTES", prev.max);
    restoreEnv("HOLABOSS_SESSION_TOOL_OUTPUT_BUDGET_BYTES", prev.budget);
    restoreEnv("HOLABOSS_TOOL_OUTPUT_TIGHTENED_BYTES", prev.tight);
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrapToolWithOutputCap without a shared accumulator applies only the per-call cap", async () => {
  const prevMax = process.env.HOLABOSS_MAX_TOOL_OUTPUT_BYTES;
  process.env.HOLABOSS_MAX_TOOL_OUTPUT_BYTES = String(50 * 1024);
  const root = mkdtempSync(join(tmpdir(), "hb-tool-cap-"));
  try {
    // No shared state → each wrapper accumulates independently; a 20KB result
    // (under the 50KB per-call cap) always inlines, no matter how many times.
    for (let i = 0; i < 10; i += 1) {
      const r = await wrapToolWithOutputCap(textTool(20 * 1024), root).execute("c", {});
      assert.equal(r.content[0].text.length, 20 * 1024, `call ${i} should inline`);
    }
  } finally {
    restoreEnv("HOLABOSS_MAX_TOOL_OUTPUT_BYTES", prevMax);
    rmSync(root, { recursive: true, force: true });
  }
});
