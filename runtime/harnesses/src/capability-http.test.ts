import assert from "node:assert/strict";
import test from "node:test";

import { executeBrowserCapabilityTool } from "./browser-capability-client.js";
import { executeRuntimeToolCapability } from "./runtime-tool-capability-client.js";
import { resetToolReplayBudgetLedger } from "./tool-replay-budget-ledger.js";

test("browser and runtime capability clients share a per-turn replay ledger keyed by input id", async () => {
  resetToolReplayBudgetLedger();

  const largePayload = {
    text: "x".repeat(18_000),
    _preview: {
      spillover_paths: ["workspace/tool-results/full.json"],
    },
  };

  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/v1/capabilities/runtime-tools/web-search")) {
      return new Response(JSON.stringify(largePayload), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    if (url.endsWith("/api/v1/capabilities/browser/tools/browser_get_state")) {
      return new Response(JSON.stringify(largePayload), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const runtimeResult = await executeRuntimeToolCapability({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    selectedModel: "openai/gpt-5.4",
    toolId: "web_search",
    toolParams: { query: "tariffs 2026" },
    fetchImpl,
  });

  assert.match(String(runtimeResult.content[0]?.text ?? ""), /"text":\s*"x{100}/);
  assert.deepEqual(runtimeResult.details, { tool_id: "web_search" });

  const browserResult = await executeBrowserCapabilityTool({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    toolId: "browser_get_state",
    toolParams: { include_page_text: true },
    fetchImpl,
  });

  const clippedPayload = JSON.parse(String(browserResult.content[0]?.text ?? "{}")) as {
    note?: string;
    spillover_paths?: string[];
    _replay_budget?: { mode?: string; trimmed?: boolean; trim_reason?: string };
  };
  assert.equal(
    clippedPayload.note,
    "Inline replay omitted because the per-turn replay budget was exhausted.",
  );
  assert.deepEqual(clippedPayload.spillover_paths, ["workspace/tool-results/full.json"]);
  assert.equal(clippedPayload._replay_budget?.mode, "reference_only");
  assert.equal(clippedPayload._replay_budget?.trimmed, true);
  assert.equal(clippedPayload._replay_budget?.trim_reason, "max_replay_chars");
  assert.equal(browserResult.details.tool_id, "browser_get_state");
  assert.equal(browserResult.details.replay_budget?.mode, "reference_only");
  assert.equal(browserResult.details.replay_budget?.trimmed, true);
  assert.equal(browserResult.details.replay_budget?.trim_reason, "max_replay_chars");
  assert.equal(browserResult.details.replay_budget?.total_replay_chars, 24000);
  assert.equal(browserResult.details.replay_budget?.max_replay_chars, 24000);
  assert.equal(browserResult.details.replay_budget?.total_replay_items, 2);
  assert.equal(browserResult.details.replay_budget?.max_replay_items, 8);
  assert.ok(
    typeof browserResult.details.replay_budget?.replay_chars === "number" &&
      browserResult.details.replay_budget.replay_chars > 18000,
  );
});

test("runtime delegate-task client forwards use_user_browser_surface when explicitly requested", async () => {
  let capturedBody: Record<string, unknown> | null = null;

  const fetchImpl: typeof fetch = async (_input, init) => {
    capturedBody =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null;
    return new Response(JSON.stringify({ tasks: [], count: 0 }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };

  await executeRuntimeToolCapability({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    selectedModel: "openai/gpt-5.4",
    toolId: "delegate_task",
    toolParams: {
      goal: "Inspect the current tab",
      tools: ["browser"],
      use_user_browser_surface: true,
    },
    fetchImpl,
  });

  assert.deepEqual(capturedBody, {
    tasks: [
      {
        goal: "Inspect the current tab",
        tools: ["browser"],
        use_user_browser_surface: true,
      },
    ],
  });
});

test("runtime workspace-instructions client preserves explicit empty replacement content", async () => {
  let capturedBody: Record<string, unknown> | null = null;

  const fetchImpl: typeof fetch = async (_input, init) => {
    capturedBody =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null;
    return new Response(JSON.stringify({ changed: true }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };

  await executeRuntimeToolCapability({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    selectedModel: "openai/gpt-5.4",
    toolId: "update_workspace_instructions",
    toolParams: {
      op: "replace_managed_section",
      content: "",
    },
    fetchImpl,
  });

  assert.deepEqual(capturedBody, {
    op: "replace_managed_section",
    content: "",
  });
});

test("runtime memory-retrieve client posts to the memory retrieval capability route", async () => {
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> | null = null;

  const fetchImpl: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedBody =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null;
    return new Response(JSON.stringify({ tool_id: "memory_retrieve", hits: [] }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  };

  await executeRuntimeToolCapability({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    selectedModel: "openai/gpt-5.4",
    toolId: "memory_retrieve",
    toolParams: {
      query: "Who is the Orchid customer escalation contact?",
      mode: "mixed",
      tree_id: "interaction:customer:orchid",
      max_results: 5,
    },
    fetchImpl,
  });

  assert.equal(capturedUrl, "http://127.0.0.1:5060/api/v1/capabilities/runtime-tools/memory/retrieve");
  assert.deepEqual(capturedBody, {
    query: "Who is the Orchid customer escalation contact?",
    mode: "mixed",
    tree_id: "interaction:customer:orchid",
    max_results: 5,
  });
});
