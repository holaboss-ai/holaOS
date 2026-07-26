import assert from "node:assert/strict";
import test from "node:test";

import { resolveComposioInlineTools } from "./composio-inline-tools.js";

test("resolveComposioInlineTools fetches the list endpoint and builds executable tool definitions", async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body as string | undefined });
    if (method === "GET" && url.includes("/composio-inline-tools")) {
      return new Response(
        JSON.stringify({
          workspace_id: "ws1",
          tools: [
            {
              name: "notion_fetch_data",
              description: "Read Notion pages and databases",
              toolkit_slug: "notion",
              tool_slug: "NOTION_FETCH_DATA",
              connected_account_id: "ca_notion",
              input_schema: { type: "object", properties: { query: { type: "string" } } },
              annotations: { readOnlyHint: true },
            },
          ],
          unavailable: [{ toolkit_slug: "slack", reason: "schema fetch failed" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (method === "POST" && url.includes("/composio-execute")) {
      return new Response(
        JSON.stringify({ ok: true, data: { rows: [{ id: 1 }] }, log_id: "log-1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not mocked", { status: 599 });
  };

  const { tools, unavailable } = await resolveComposioInlineTools({
    runtimeApiBaseUrl: "http://127.0.0.1:1",
    workspaceId: "ws1",
    sessionId: "s1",
    inputId: "i1",
    selectedModel: "openai/gpt-5",
    fetchImpl,
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, "notion_fetch_data");
  assert.deepEqual(unavailable, [{ toolkit_slug: "slack", reason: "schema fetch failed" }]);

  const execResult = await tools[0]!.execute("call_1", { query: "hi" }, undefined);
  assert.ok(Array.isArray(execResult.content), "execute must return content array — pi-agent-core requires it");
  assert.equal(execResult.content[0]!.type, "text");
  assert.equal(typeof execResult.content[0]!.text, "string");
  assert.deepEqual(JSON.parse(execResult.content[0]!.text), { rows: [{ id: 1 }] });
  assert.equal(execResult.details.ok, true);
  assert.equal(execResult.details.toolkit_slug, "notion");
  assert.deepEqual(execResult.details.raw, { rows: [{ id: 1 }] });
  const execCall = calls.find((entry) => entry.method === "POST")!;
  const body = JSON.parse(execCall.body!) as Record<string, unknown>;
  assert.equal(body.toolkit_slug, "notion");
  assert.equal(body.tool_slug, "NOTION_FETCH_DATA");
  assert.equal(body.connected_account_id, "ca_notion");
});

test("resolveComposioInlineTools returns empty when the list endpoint is unreachable", async () => {
  const result = await resolveComposioInlineTools({
    runtimeApiBaseUrl: "http://127.0.0.1:1",
    workspaceId: "ws1",
    sessionId: "s1",
    inputId: "i1",
    selectedModel: null,
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  assert.deepEqual(result, { tools: [], unavailable: [] });
});

test("resolveComposioInlineTools surfaces composio_error markers when execute returns a failure", async () => {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    if (url.includes("/composio-inline-tools")) {
      return new Response(
        JSON.stringify({
          workspace_id: "ws1",
          tools: [
            {
              name: "gmail_fetch_emails",
              description: "Read Gmail",
              toolkit_slug: "gmail",
              tool_slug: "GMAIL_FETCH_EMAILS",
              connected_account_id: "ca_gm",
              input_schema: { type: "object", properties: {} },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        ok: false,
        error: { code: "forbidden", message: "missing scope", toolkit_slug: "gmail", http_status: 403 },
        error_marker: "[composio_error:forbidden:gmail] missing scope",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const { tools } = await resolveComposioInlineTools({
    runtimeApiBaseUrl: "http://127.0.0.1:1",
    workspaceId: "ws1",
    sessionId: "s1",
    inputId: "i1",
    selectedModel: null,
    fetchImpl,
  });
  const result = await tools[0]!.execute("call_1", {}, undefined);
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content[0]!.text, "[composio_error:forbidden:gmail] missing scope");
  assert.equal(result.details.ok, false);
  assert.equal(result.details.error_marker, "[composio_error:forbidden:gmail] missing scope");
  assert.equal(result.details.error?.code, "forbidden");
});
