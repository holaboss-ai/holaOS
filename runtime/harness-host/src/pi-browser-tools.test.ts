import http from "node:http";
import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { DESKTOP_BROWSER_TOOL_IDS } from "../../harnesses/src/desktop-browser-tools.js";
import { BROWSER_PROFILE_TOOL_NAMES } from "../../harnesses/src/browser-capability-tools.js";
import { resolvePiDesktopBrowserToolDefinitions } from "./pi-browser-tools.js";

test("resolvePiDesktopBrowserToolDefinitions returns an empty tool list when runtime api url is unavailable", async () => {
  const tools = await resolvePiDesktopBrowserToolDefinitions({
    runtimeApiBaseUrl: "",
  });

  assert.deepEqual(tools, []);
});

test("resolvePiDesktopBrowserToolDefinitions returns an empty tool list when browser capability is unavailable", async () => {
  const tools = await resolvePiDesktopBrowserToolDefinitions({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    fetchImpl: async () =>
      new Response(JSON.stringify({ available: false }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
  });

  assert.deepEqual(tools, []);
});

test("Pi desktop browser tools execute through the runtime capability API", async () => {
  const requests: Array<{
    method: string;
    url: string;
    workspaceId: string;
    sessionId: string;
    browserSpace: string;
    body: string;
  }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/capabilities/browser")) {
      return new Response(JSON.stringify({ available: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const body = init?.body ? String(init.body) : "";
    requests.push({
      method: String(init?.method ?? "GET"),
      url,
      workspaceId: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-workspace-id"] ?? ""),
      sessionId: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-session-id"] ?? ""),
      browserSpace: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-browser-space"] ?? ""),
      body,
    });
    if (url.endsWith("/api/v1/capabilities/browser/tools/browser_get_state")) {
      return new Response(JSON.stringify({
        ok: true,
        title: "Example",
        browser_usage: {
          tool_id: "browser_get_state",
          detail: "compact",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const tools = await resolvePiDesktopBrowserToolDefinitions({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    space: "agent",
    fetchImpl,
  });

  assert.deepEqual(
    tools.map((tool) => tool.name),
    [...DESKTOP_BROWSER_TOOL_IDS, ...BROWSER_PROFILE_TOOL_NAMES]
  );

  const getStateTool = tools.find((tool) => tool.name === "browser_get_state");
  assert.ok(getStateTool);
  assert.match(getStateTool.description ?? "", /DOM-first browser inspection tool for actions and structured extraction/i);
  assert.match(getStateTool.description ?? "", /visible media such as images/i);
  assert.match(getStateTool.description ?? "", /include_screenshot=true/i);
  assert.match(getStateTool.description ?? "", /include_page_text=true/i);
  assert.match(
    String((getStateTool.parameters as { properties?: { include_page_text?: { description?: string } } }).properties?.include_page_text?.description ?? ""),
    /Leave false for cheaper action-focused state checks/i
  );
  assert.match(
    String((getStateTool.parameters as { properties?: { include_screenshot?: { description?: string } } }).properties?.include_screenshot?.description ?? ""),
    /visual appearance, layout, overlays, charts, PDFs, or user-visible confirmation/i
  );
  assert.deepEqual(
    (
      (getStateTool.parameters as { properties?: { mode?: { anyOf?: Array<{ const?: string }> } } })
        .properties?.mode?.anyOf ?? []
    ).map((entry) => entry.const),
    ["state", "text", "structured", "visual"],
  );
  assert.deepEqual(
    (
      (getStateTool.parameters as { properties?: { scope?: { anyOf?: Array<{ const?: string }> } } })
        .properties?.scope?.anyOf ?? []
    ).map((entry) => entry.const),
    ["main", "viewport", "focused", "dialog", "active_dialog", "modal"],
  );
  assert.deepEqual(
    (
      (getStateTool.parameters as { properties?: { detail?: { anyOf?: Array<{ const?: string }> } } })
        .properties?.detail?.anyOf ?? []
    ).map((entry) => entry.const),
    ["compact", "standard"],
  );
  assert.equal(
    (getStateTool.parameters as { properties?: { max_nodes?: { minimum?: number } } }).properties?.max_nodes?.minimum,
    1,
  );
  assert.equal(
    (getStateTool.parameters as { properties?: { since_revision?: { minLength?: number } } }).properties?.since_revision?.minLength,
    1,
  );
  assert.ok(
    (getStateTool.parameters as { properties?: Record<string, unknown> }).properties?.changed_only,
  );
  const findTool = tools.find((tool) => tool.name === "browser_find");
  assert.ok(findTool);
  assert.match(findTool.description ?? "", /Search is independent of browser_get_state max_nodes/i);
  assert.deepEqual(
    (
      (findTool.parameters as { properties?: { scope?: { anyOf?: Array<{ const?: string }> } } })
        .properties?.scope?.anyOf ?? []
    ).map((entry) => entry.const),
    ["main", "viewport", "focused", "dialog", "active_dialog", "modal"],
  );
  const actTool = tools.find((tool) => tool.name === "browser_act");
  assert.ok(actTool);
  assert.deepEqual(
    (
      (actTool.parameters as { properties?: { action?: { anyOf?: Array<{ const?: string }> } } })
        .properties?.action?.anyOf ?? []
    ).map((entry) => entry.const),
    ["click", "double_click", "hover", "focus", "fill", "type", "press", "select", "check", "uncheck", "scroll_into_view"],
  );
  assert.ok((actTool.parameters as { properties?: Record<string, unknown> }).properties?.wait_for);
  assert.ok((actTool.parameters as { properties?: Record<string, unknown> }).properties?.post_state);
  const waitTool = tools.find((tool) => tool.name === "browser_wait");
  assert.ok(waitTool);
  assert.ok(
    (
      (waitTool.parameters as { properties?: { condition?: { anyOf?: Array<{ const?: string }> } } })
        .properties?.condition?.anyOf ?? []
    ).some((entry) => entry.const === "download_completed"),
  );
  assert.ok(
    (waitTool.parameters as { properties?: Record<string, unknown> }).properties?.filename,
  );
  const selectTabTool = tools.find((tool) => tool.name === "browser_select_tab");
  assert.ok(selectTabTool);
  assert.equal(
    (selectTabTool.parameters as { properties?: { tab_id?: { minLength?: number } } }).properties?.tab_id?.minLength,
    1,
  );
  const listDownloadsTool = tools.find((tool) => tool.name === "browser_list_downloads");
  assert.ok(listDownloadsTool);
  const consoleTool = tools.find((tool) => tool.name === "browser_get_console");
  assert.ok(consoleTool);
  assert.equal(
    (consoleTool.parameters as { properties?: { limit?: { maximum?: number } } }).properties?.limit?.maximum,
    100,
  );
  const errorsTool = tools.find((tool) => tool.name === "browser_get_errors");
  assert.ok(errorsTool);
  assert.ok(
    (errorsTool.parameters as { properties?: Record<string, unknown> }).properties?.source,
  );
  const listRequestsTool = tools.find((tool) => tool.name === "browser_list_requests");
  assert.ok(listRequestsTool);
  assert.ok(
    (listRequestsTool.parameters as { properties?: Record<string, unknown> }).properties?.failures_only,
  );
  const getRequestTool = tools.find((tool) => tool.name === "browser_get_request");
  assert.ok(getRequestTool);
  assert.equal(
    (getRequestTool.parameters as { properties?: { request_id?: { minLength?: number } } }).properties?.request_id?.minLength,
    1,
  );
  const storageGetTool = tools.find((tool) => tool.name === "browser_storage_get");
  assert.ok(storageGetTool);
  assert.equal(
    (storageGetTool.parameters as { properties?: { max_entries?: { maximum?: number } } }).properties?.max_entries?.maximum,
    100,
  );
  const storageSetTool = tools.find((tool) => tool.name === "browser_storage_set");
  assert.ok(storageSetTool);
  assert.ok(
    (storageSetTool.parameters as { properties?: Record<string, unknown> }).properties?.delete,
  );
  const cookiesGetTool = tools.find((tool) => tool.name === "browser_cookies_get");
  assert.ok(cookiesGetTool);
  assert.ok(
    (cookiesGetTool.parameters as { properties?: Record<string, unknown> }).properties?.names,
  );
  const cookiesSetTool = tools.find((tool) => tool.name === "browser_cookies_set");
  assert.ok(cookiesSetTool);
  assert.ok(
    (cookiesSetTool.parameters as { properties?: Record<string, unknown> }).properties?.same_site,
  );
  const result = await getStateTool.execute("call-1", { include_screenshot: true }, undefined, undefined, {} as never);

  assert.deepEqual(requests, [
      {
        method: "POST",
        url: "http://127.0.0.1:5060/api/v1/capabilities/browser/tools/browser_get_state",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        browserSpace: "agent",
        body: JSON.stringify({ include_screenshot: true }),
      },
  ]);
  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[0]?.text, JSON.stringify({ ok: true, title: "Example" }, null, 2));
  assert.deepEqual(result.details, {
    tool_id: "browser_get_state",
    browser_usage: {
      tool_id: "browser_get_state",
      detail: "compact",
    },
  });
});

test("Pi desktop browser tools compact large capability results and preserve raw details", async () => {
  const largeSnapshot = "x".repeat(40000);
  const payload = { ok: true, title: "Large page", snapshot: largeSnapshot };
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/v1/capabilities/browser")) {
      return new Response(JSON.stringify({ available: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (url.endsWith("/api/v1/capabilities/browser/tools/browser_get_state")) {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const tools = await resolvePiDesktopBrowserToolDefinitions({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    fetchImpl,
  });
  const getStateTool = tools.find((tool) => tool.name === "browser_get_state");
  assert.ok(getStateTool);

  const result = await getStateTool.execute("call-1", {}, undefined, undefined, {} as never);
  assert.equal(result.content[0]?.type, "text");
  assert.ok((result.content[0]?.text.length ?? 0) < largeSnapshot.length);

  const envelope = JSON.parse(String(result.content[0]?.text ?? "")) as {
    tool_result_format?: string;
    status?: string;
    ok?: boolean;
    serialized_bytes?: number;
    preview?: string;
    raw_result?: { stored_in?: string };
  };
  assert.equal(envelope.tool_result_format, "compact_envelope");
  assert.equal(envelope.status, "truncated");
  assert.equal(envelope.ok, true);
  assert.equal(envelope.raw_result?.stored_in, "tool_result.details.raw");
  assert.equal(typeof envelope.serialized_bytes, "number");
  assert.ok((envelope.serialized_bytes ?? 0) > 32768);
  assert.ok(String(envelope.preview ?? "").length < largeSnapshot.length);

  const details = result.details as {
    tool_id?: string;
    raw?: unknown;
    raw_result_bytes?: number;
    model_result_bytes?: number;
  };
  assert.equal(details.tool_id, "browser_get_state");
  assert.deepEqual(details.raw, payload);
  assert.equal(details.raw_result_bytes, envelope.serialized_bytes);
  assert.equal(details.model_result_bytes, new TextEncoder().encode(result.content[0]?.text ?? "").length);
});

test("Pi desktop browser tools fall back to node http when no fetch implementation is provided", async () => {
  const requests: Array<{ method: string; url: string; workspaceId: string; sessionId: string; body: string }> = [];
  const server = http.createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url === "/api/v1/capabilities/browser") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ available: true }));
      return;
    }

    if (request.method === "POST" && url === "/api/v1/capabilities/browser/tools/browser_get_state") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push({
          method: request.method ?? "GET",
          url,
          workspaceId: String(request.headers["x-holaboss-workspace-id"] ?? ""),
          sessionId: String(request.headers["x-holaboss-session-id"] ?? ""),
          body,
        });
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: true, title: "Example via http" }));
      });
      return;
    }

    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ detail: "not found" }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const runtimeApiBaseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const tools = await resolvePiDesktopBrowserToolDefinitions({
      runtimeApiBaseUrl,
      workspaceId: "workspace-1",
      sessionId: "session-1",
    });

    const getStateTool = tools.find((tool) => tool.name === "browser_get_state");
    assert.ok(getStateTool);
    assert.match(getStateTool.description ?? "", /DOM-first browser inspection tool for actions and structured extraction/i);
    assert.match(getStateTool.description ?? "", /visible media such as images/i);
    assert.match(getStateTool.description ?? "", /include_page_text=true/i);
    const result = await getStateTool.execute("call-1", { include_screenshot: false }, undefined, undefined, {} as never);

    assert.deepEqual(requests, [
      {
        method: "POST",
        url: "/api/v1/capabilities/browser/tools/browser_get_state",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        body: JSON.stringify({ include_screenshot: false }),
      },
    ]);
    assert.equal(result.content[0]?.type, "text");
    assert.equal(result.content[0]?.text, JSON.stringify({ ok: true, title: "Example via http" }, null, 2));
    assert.deepEqual(result.details, { tool_id: "browser_get_state" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("Pi desktop browser context-click tool forwards media targeting parameters", async () => {
  const requests: Array<{ method: string; url: string; workspaceId: string; sessionId: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/capabilities/browser")) {
      return new Response(JSON.stringify({ available: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const body = init?.body ? String(init.body) : "";
    requests.push({
      method: String(init?.method ?? "GET"),
      url,
      workspaceId: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-workspace-id"] ?? ""),
      sessionId: String((init?.headers as Record<string, string> | undefined)?.["x-holaboss-session-id"] ?? ""),
      body,
    });
    if (url.endsWith("/api/v1/capabilities/browser/tools/browser_context_click")) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const tools = await resolvePiDesktopBrowserToolDefinitions({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    fetchImpl,
  });

  const contextClickTool = tools.find((tool) => tool.name === "browser_context_click");
  assert.ok(contextClickTool);
  assert.deepEqual(
    (
      (contextClickTool.parameters as { properties?: { target?: { anyOf?: Array<{ const?: string }> } } })
        .properties?.target?.anyOf ?? []
    ).map((entry) => entry.const),
    ["element", "media"],
  );

  const result = await contextClickTool.execute(
    "call-1",
    { target: "media", index: 2 },
    undefined,
    undefined,
    {} as never
  );

  assert.deepEqual(requests, [
    {
      method: "POST",
      url: "http://127.0.0.1:5060/api/v1/capabilities/browser/tools/browser_context_click",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      body: JSON.stringify({ target: "media", index: 2 }),
    },
  ]);
  assert.equal(result.content[0]?.type, "text");
  assert.equal(result.content[0]?.text, JSON.stringify({ ok: true }, null, 2));
  assert.deepEqual(result.details, { tool_id: "browser_context_click" });
});

test("browser_navigate offers an optional browser_profile, resolves it by name, strips it from the body", async () => {
  const json = (data: unknown) =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  const requests: Array<{ url: string; profileHeader: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/capabilities/browser")) {
      return json({ available: true });
    }
    if (url.endsWith("/api/v1/capabilities/browser/profiles")) {
      return json({
        profiles: [
          { id: "bprofile_default", name: "Default" },
          { id: "bprofile_asd", name: "asd" },
        ],
      });
    }
    requests.push({
      url,
      profileHeader: String(
        (init?.headers as Record<string, string> | undefined)?.[
          "x-holaboss-browser-profile-id"
        ] ?? "",
      ),
      body: init?.body ? String(init.body) : "",
    });
    if (url.endsWith("/api/v1/capabilities/browser/tools/browser_navigate")) {
      return json({ ok: true });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const tools = await resolvePiDesktopBrowserToolDefinitions({
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    space: "agent",
    fetchImpl,
  });
  const navigate = tools.find((tool) => tool.name === "browser_navigate");
  assert.ok(navigate);
  // browser_profile is offered but optional — omitting it drives the pinned default.
  const navParams = navigate.parameters as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  assert.ok(navParams.properties?.browser_profile);
  assert.ok(!navParams.required?.includes("browser_profile"));

  // "asd" resolves by name → forwarded with that profile's header, and the
  // harness-only browser_profile is stripped from the desktop request body.
  await navigate.execute(
    "call-1",
    { browser_profile: "asd", url: "https://reddit.com" },
    undefined,
    undefined,
    {} as never,
  );
  const navReq = requests.find((r) => r.url.endsWith("/browser_navigate"));
  assert.ok(navReq);
  assert.equal(navReq.profileHeader, "bprofile_asd");
  assert.equal(navReq.body, JSON.stringify({ url: "https://reddit.com" }));

  // A non-matching profile → an error result; it does NOT silently drive Default.
  const before = requests.length;
  const result = (await navigate.execute(
    "call-2",
    { browser_profile: "nope", url: "https://reddit.com" },
    undefined,
    undefined,
    {} as never,
  )) as { content: { text: string }[] };
  assert.equal(requests.length, before);
  assert.match(result.content[0]?.text ?? "", /No browser profile matches "nope"/);
});
