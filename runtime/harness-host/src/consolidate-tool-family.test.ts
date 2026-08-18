import assert from "node:assert/strict";
import { test } from "node:test";

import { consolidateRuntimeToolFamilies } from "./consolidate-tool-family.js";

function mk(
  name: string,
  parameters: Record<string, unknown> = {},
): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  // pi's real signature is (toolCallId, toolParams, signal) — which is what
  // consolidateOne forwards. Declaring only two here made the dispatcher's own
  // call shape a type error in this file.
  execute: (
    id: string,
    p: unknown,
    signal?: AbortSignal,
  ) => Promise<{ called: string; params: unknown }>;
} {
  return {
    name,
    description: `${name} does a thing. A second sentence that should be dropped.`,
    parameters,
    execute: async (_id, p) => ({ called: name, params: p }),
  };
}

test("collapses cronjobs_* into one op-dispatched tool", async () => {
  const tools = [
    mk("cronjobs_list", { properties: { enabled_only: { type: "boolean" } } }),
    mk("cronjobs_get", { properties: { job_id: { type: "string" } }, required: ["job_id"] }),
    mk("cronjobs_create", {
      properties: { cron: { type: "string" }, instruction: { type: "string" } },
      required: ["cron", "instruction"],
    }),
    mk("cronjobs_update", { properties: { job_id: { type: "string" }, cron: { type: "string" } }, required: ["job_id"] }),
    mk("cronjobs_delete", { properties: { job_id: { type: "string" } }, required: ["job_id"] }),
    mk("cronjobs_run_now", { properties: { job_id: { type: "string" } }, required: ["job_id"] }),
    mk("bash", {}),
  ];
  const out = consolidateRuntimeToolFamilies(tools);
  assert.deepEqual(
    out.map((t) => t.name).sort(),
    ["bash", "cronjobs"],
  );
  const cron = out.find((t) => t.name === "cronjobs");
  assert.ok(cron);
  const params = cron.parameters as { required: string[]; properties: Record<string, any> };
  assert.deepEqual(params.required, ["op"]);
  assert.deepEqual(
    [...params.properties.op.enum].sort(),
    ["create", "delete", "get", "list", "run_now", "update"],
  );
  // merged fields from all ops are present exactly once
  for (const f of ["cron", "job_id", "instruction", "enabled_only"]) {
    assert.ok(params.properties[f], `missing merged field ${f}`);
  }
  // dispatch strips op and routes to the right original handler
  const res: any = await cron.execute("call-1", { op: "create", cron: "0 10 * * *", instruction: "hi" }, undefined);
  assert.equal(res.called, "cronjobs_create");
  assert.deepEqual(res.params, { cron: "0 10 * * *", instruction: "hi" });
  // unknown op → error result, not a throw
  const bad: any = await cron.execute("call-2", { op: "nope" }, undefined);
  assert.equal(bad.is_error, true);
});

test("collapses terminal_session(s)_* incl. the terminal_sessions_list oddball", async () => {
  const tools = [
    mk("terminal_session_start"),
    mk("terminal_session_read"),
    mk("terminal_session_wait"),
    mk("terminal_session_send_input"),
    mk("terminal_session_signal"),
    mk("terminal_session_get"),
    mk("terminal_session_close"),
    mk("terminal_sessions_list"),
  ];
  const out = consolidateRuntimeToolFamilies(tools);
  assert.deepEqual(out.map((t) => t.name), ["terminal_session"]);
  const ts = out[0];
  const ops = [...(ts.parameters as any).properties.op.enum].sort();
  assert.deepEqual(ops, ["close", "get", "list", "read", "send_input", "signal", "start", "wait"]);
  const r: any = await ts.execute("c", { op: "list" }, undefined);
  assert.equal(r.called, "terminal_sessions_list"); // op "list" routes back to the oddball
});

test("a single-member family is left untouched (no wrapping)", () => {
  const tools = [mk("cronjobs_list"), mk("bash")];
  const out = consolidateRuntimeToolFamilies(tools);
  assert.deepEqual(out.map((t) => t.name).sort(), ["bash", "cronjobs_list"]);
});
