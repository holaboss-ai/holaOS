import assert from "node:assert/strict";
import test from "node:test";

import { createHarnessRuntimeToolDefinition } from "./runtime-capability-tools.js";
import { RUNTIME_AGENT_TOOL_DEFINITIONS } from "./runtime-agent-tools.js";
import { executeRuntimeToolCapability } from "./runtime-tool-capability-client.js";

function recordingFetch(calls: Array<{ url: string; method?: string; body?: unknown }>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ endpoints: [], errors: [] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

test("local model tools are registered with inspect/mutate policies", () => {
  const discover = RUNTIME_AGENT_TOOL_DEFINITIONS.find((tool) => tool.id === "local_models_discover");
  const register = RUNTIME_AGENT_TOOL_DEFINITIONS.find((tool) => tool.id === "local_models_register");
  assert.equal(discover?.policy, "inspect");
  assert.equal(register?.policy, "mutate");
  assert.match(discover?.description ?? "", /already running/i);
  assert.match(register?.description ?? "", /model picker/);
});

test("register schema requires base_url", () => {
  const tool = createHarnessRuntimeToolDefinition("local_models_register", "x", {
    runtimeApiBaseUrl: "http://127.0.0.1:9999",
  });
  assert.deepEqual((tool.parameters as { required?: string[] }).required, ["base_url"]);
});

test("local_models_discover is a GET with an optional base_url query", async () => {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  await executeRuntimeToolCapability({
    runtimeApiBaseUrl: "http://127.0.0.1:9999",
    toolId: "local_models_discover",
    toolParams: {},
    fetchImpl: recordingFetch(calls),
  });
  await executeRuntimeToolCapability({
    runtimeApiBaseUrl: "http://127.0.0.1:9999",
    toolId: "local_models_discover",
    toolParams: { base_url: "http://127.0.0.1:9000/v1" },
    fetchImpl: recordingFetch(calls),
  });
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, "http://127.0.0.1:9999/api/v1/local-models/discover");
  assert.equal(calls[0].body, undefined);
  assert.equal(
    calls[1].url,
    "http://127.0.0.1:9999/api/v1/local-models/discover?base_url=http%3A%2F%2F127.0.0.1%3A9000%2Fv1",
  );
});

test("local_models_register POSTs base_url, models, and engine", async () => {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  await executeRuntimeToolCapability({
    runtimeApiBaseUrl: "http://127.0.0.1:9999",
    toolId: "local_models_register",
    toolParams: { base_url: "http://127.0.0.1:1234/v1", models: ["qwen/qwen3-8b", ""], engine: "lmstudio" },
    fetchImpl: recordingFetch(calls),
  });
  assert.equal(calls[0].method, "POST");
  assert.ok(calls[0].url.endsWith("/api/v1/local-models/register"));
  assert.deepEqual(JSON.parse(String(calls[0].body)), {
    base_url: "http://127.0.0.1:1234/v1",
    models: ["qwen/qwen3-8b"],
    engine: "lmstudio",
  });

  await assert.rejects(
    executeRuntimeToolCapability({
      runtimeApiBaseUrl: "http://127.0.0.1:9999",
      toolId: "local_models_register",
      toolParams: {},
      fetchImpl: recordingFetch(calls),
    }),
    /base_url is required/,
  );
});
