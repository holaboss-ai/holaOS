// Pins the `mcp_refresh` runtime tool's wiring: it must be a registered base
// definition (so every downstream registration site can reference it) AND the
// capability client must route it to POST the workspace MCP-refresh endpoint
// with an empty body. These two ends are the pieces most likely to silently
// drift; the curated MCP surface + object schema are covered by
// runtime-tools-mcp-integration.test.ts.

import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNTIME_AGENT_TOOL_DEFINITIONS,
  RUNTIME_AGENT_TOOL_IDS,
} from "./runtime-agent-tools.js";
import { executeRuntimeToolCapability } from "./runtime-tool-capability-client.js";

test("mcp_refresh is a registered runtime tool base definition (mutate policy)", () => {
  assert.ok(
    RUNTIME_AGENT_TOOL_IDS.includes("mcp_refresh"),
    "mcp_refresh missing from RUNTIME_AGENT_TOOL_IDS",
  );
  const def = RUNTIME_AGENT_TOOL_DEFINITIONS.find((t) => t.id === "mcp_refresh");
  assert.ok(def, "mcp_refresh base definition not found");
  assert.equal(def.policy, "mutate", "mcp_refresh must be a mutate-policy tool");
});

test("the capability client routes mcp_refresh to POST the workspace refresh endpoint with an empty body", async () => {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      body: init?.body,
    });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ refreshed: true, cache_cleared: true, servers: [] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  await executeRuntimeToolCapability({
    runtimeApiBaseUrl: "http://127.0.0.1:9999",
    workspaceId: "ws_test",
    toolId: "mcp_refresh",
    toolParams: {},
    fetchImpl,
  });

  assert.equal(calls.length, 1, "exactly one HTTP call");
  assert.equal(calls[0].method, "POST");
  assert.ok(
    calls[0].url.endsWith("/api/v1/capabilities/runtime-tools/mcp/refresh"),
    `unexpected URL: ${calls[0].url}`,
  );
  // No arguments → empty JSON object body.
  assert.equal(calls[0].body, "{}");
});
