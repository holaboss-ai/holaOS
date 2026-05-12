import assert from "node:assert/strict";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import {
  DesktopBrowserToolService,
  DesktopBrowserToolServiceError
} from "./desktop-browser-tools.js";

async function startBrowserServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/api/v1/browser`,
    close: async () => {
      server.close();
      await once(server, "close");
    }
  };
}

test("desktop browser tool service reports unavailable when runtime lacks browser config", async () => {
  const service = new DesktopBrowserToolService({
    resolveConfig: () => ({
      authToken: "",
      userId: "",
      sandboxId: "",
      modelProxyBaseUrl: "",
      defaultModel: "openai/gpt-5.4",
      runtimeMode: "oss",
      defaultProvider: "",
      holabossEnabled: false,
      desktopBrowserEnabled: false,
      desktopBrowserUrl: "",
      desktopBrowserAuthToken: "",
      configPath: "/tmp/runtime-config.json",
      loadedFromFile: false
    })
  });

  const status = await service.getStatus();
  assert.deepEqual(status, {
    available: false,
    configured: false,
    reachable: false,
    backend: null,
    tools: status.tools
  });
  assert.equal(Array.isArray(status.tools), true);
});

test("desktop browser tool service forwards workspace and session context to the desktop browser service", async () => {
  const requests: Array<{ path: string; token: string; workspaceId: string; sessionId: string; body: string }> = [];
  const browserServer = await startBrowserServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      path: request.url ?? "",
      token: String(request.headers["x-holaboss-desktop-token"] ?? ""),
      workspaceId: String(request.headers["x-holaboss-workspace-id"] ?? ""),
      sessionId: String(request.headers["x-holaboss-session-id"] ?? ""),
      body
    });
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/api/v1/browser/health") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === "/api/v1/browser/page") {
      response.end(JSON.stringify({ tabId: "tab-1", url: "https://example.com", title: "Example" }));
      return;
    }
    if (request.url === "/api/v1/browser/evaluate") {
      response.end(
        JSON.stringify({
          tabId: "tab-1",
          result: {
            url: "https://example.com",
            title: "Example",
            viewport: { width: 1280, height: 720 },
            scroll: { x: 0, y: 0 },
            elements: [{ index: 1, tag_name: "a", label: "More information", text: "More information" }],
            media: [{
              index: 1,
              media_type: "image",
              tag_name: "img",
              label: "Hero image",
              alt: "Hero image",
              text: "",
              src: "/hero.png",
              current_src: "https://example.com/hero.png",
              link_href: "",
              bounding_box: { x: 24, y: 48, width: 320, height: 180 }
            }]
          }
        })
      );
      return;
    }
    if (request.url === "/api/v1/browser/screenshot") {
      response.end(
        JSON.stringify({
          tabId: "tab-1",
          mimeType: "image/png",
          width: 1280,
          height: 720,
          base64: "cG5n"
        })
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  try {
    const service = new DesktopBrowserToolService({
      resolveConfig: () => ({
        authToken: "",
        userId: "",
        sandboxId: "",
        modelProxyBaseUrl: "",
        defaultModel: "openai/gpt-5.4",
        runtimeMode: "oss",
        defaultProvider: "",
        holabossEnabled: false,
        desktopBrowserEnabled: true,
        desktopBrowserUrl: browserServer.url,
        desktopBrowserAuthToken: "browser-token",
        configPath: "/tmp/runtime-config.json",
        loadedFromFile: true
      })
    });

    const result = await service.execute(
      "browser_get_state",
      { include_screenshot: true },
      { workspaceId: "workspace-1", sessionId: "session-1" }
    );
    const { browser_usage: browserUsage, ...visibleResult } = result;
    const state = visibleResult.state as Record<string, unknown>;
    const revision = state.revision;
    delete state.revision;
    assert.deepEqual(visibleResult, {
      ok: true,
      page: { tabId: "tab-1", url: "https://example.com", title: "Example" },
      state,
      screenshot: {
        tabId: "tab-1",
        mimeType: "image/png",
        width: 1280,
        height: 720,
        base64: "cG5n"
      }
    });
    assert.equal(typeof revision, "string");
    assert.deepEqual(state, {
        url: "https://example.com",
        title: "Example",
        viewport: { width: 1280, height: 720 },
        scroll: { x: 0, y: 0 },
        elements: [{ index: 1, tag_name: "a", label: "More information", text: "More information" }],
        media: [{
          index: 1,
          media_type: "image",
          tag_name: "img",
          label: "Hero image",
          alt: "Hero image",
          text: "",
          src: "/hero.png",
          current_src: "https://example.com/hero.png",
          link_href: "",
          bounding_box: { x: 24, y: 48, width: 320, height: 180 }
        }]
    });
    assert.equal((browserUsage as { tool_id?: string }).tool_id, "browser_get_state");
    assert.equal((browserUsage as { detail?: string }).detail, "compact");
    assert.equal((browserUsage as { include_screenshot?: boolean }).include_screenshot, true);
    assert.deepEqual(
      requests.map((entry) => [entry.path, entry.token, entry.workspaceId, entry.sessionId]),
      [
        ["/api/v1/browser/page", "browser-token", "workspace-1", "session-1"],
        ["/api/v1/browser/evaluate", "browser-token", "workspace-1", "session-1"],
        ["/api/v1/browser/screenshot", "browser-token", "workspace-1", "session-1"]
      ]
    );
  } finally {
    await browserServer.close();
  }
});

test("desktop browser tool service stores screenshots as output artifacts when available", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-browser-screenshot-artifacts-"));
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });

  const browserServer = await startBrowserServer(async (request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/api/v1/browser/page") {
      response.end(JSON.stringify({ tabId: "tab-1", url: "https://example.com", title: "Example" }));
      return;
    }
    if (request.url === "/api/v1/browser/evaluate") {
      response.end(
        JSON.stringify({
          tabId: "tab-1",
          result: {
            url: "https://example.com",
            title: "Example",
            viewport: { width: 1280, height: 720 },
            scroll: { x: 0, y: 0 },
            elements: [],
            media: [],
          },
        })
      );
      return;
    }
    if (request.url === "/api/v1/browser/screenshot") {
      response.end(
        JSON.stringify({
          tabId: "tab-1",
          mimeType: "image/png",
          width: 1280,
          height: 720,
          base64: "cG5n",
        })
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  try {
    const service = new DesktopBrowserToolService({
      artifactStore: store,
      resolveConfig: () => ({
        authToken: "",
        userId: "",
        sandboxId: "",
        modelProxyBaseUrl: "",
        defaultModel: "openai/gpt-5.4",
        runtimeMode: "oss",
        defaultProvider: "",
        holabossEnabled: false,
        desktopBrowserEnabled: true,
        desktopBrowserUrl: browserServer.url,
        desktopBrowserAuthToken: "browser-token",
        configPath: "/tmp/runtime-config.json",
        loadedFromFile: true
      })
    });

    const result = await service.execute(
      "browser_get_state",
      { include_screenshot: true },
      { workspaceId: "workspace-1", sessionId: "session-1", inputId: "input-1" }
    );
    const screenshot = result.screenshot as {
      artifact_id?: string;
      output_id?: string;
      file_path?: string;
      mime_type?: string;
      size_bytes?: number;
      width?: number;
      height?: number;
      inline_base64?: boolean;
      base64?: string;
    };

    assert.equal(screenshot.base64, undefined);
    assert.equal(screenshot.inline_base64, false);
    assert.equal(screenshot.mime_type, "image/png");
    assert.equal(screenshot.size_bytes, 3);
    assert.equal(screenshot.width, 1280);
    assert.equal(screenshot.height, 720);
    assert.ok(typeof screenshot.artifact_id === "string" && screenshot.artifact_id.length > 0);
    assert.ok(typeof screenshot.output_id === "string" && screenshot.output_id.length > 0);
    assert.match(String(screenshot.file_path ?? ""), /^outputs\/browser-screenshots\/session-1\//);
    assert.equal(
      fs.readFileSync(path.join(workspaceRoot, "workspace-1", screenshot.file_path ?? ""), "utf8"),
      "png",
    );

    const outputs = store.listOutputs({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      inputId: "input-1",
      limit: 20,
      offset: 0,
    });
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].id, screenshot.output_id);
    assert.equal(outputs[0].artifactId, screenshot.artifact_id);
    assert.equal(outputs[0].filePath, screenshot.file_path);
    assert.equal(outputs[0].metadata.artifact_type, "browser_screenshot");
    assert.equal(outputs[0].metadata.origin_type, "browser_tool");
    assert.equal(outputs[0].metadata.tool_id, "browser_get_state");
    assert.equal(outputs[0].metadata.inline_base64, false);
  } finally {
    await browserServer.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("desktop browser tool service retries browser_get_state when the first snapshot is still loading or 0x0", async () => {
  const requests: string[] = [];
  let pageCalls = 0;
  let evaluateCalls = 0;
  let screenshotCalls = 0;
  const browserServer = await startBrowserServer(async (request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/api/v1/browser/page") {
      pageCalls += 1;
      response.end(
        JSON.stringify(
          pageCalls === 1
            ? {
                tabId: "tab-1",
                url: "https://example.com",
                title: "Example",
                loading: true,
                initialized: false,
              }
            : {
                tabId: "tab-1",
                url: "https://example.com",
                title: "Example",
                loading: false,
                initialized: true,
              },
        ),
      );
      return;
    }
    if (request.url === "/api/v1/browser/evaluate") {
      evaluateCalls += 1;
      response.end(
        JSON.stringify({
          tabId: "tab-1",
          result:
            evaluateCalls === 1
              ? {
                  url: "https://example.com",
                  title: "Example",
                  viewport: { width: 0, height: 0 },
                  scroll: { x: 0, y: 0 },
                  elements: [],
                  media: [],
                }
              : {
                  url: "https://example.com",
                  title: "Example",
                  viewport: { width: 1280, height: 720 },
                  scroll: { x: 0, y: 0 },
                  elements: [],
                  media: [
                    {
                      index: 1,
                      media_type: "image",
                      tag_name: "img",
                      label: "Hero image",
                      alt: "Hero image",
                      text: "",
                      src: "/hero.png",
                      current_src: "https://example.com/hero.png",
                      link_href: "",
                      bounding_box: { x: 24, y: 48, width: 320, height: 180 },
                    },
                  ],
                },
        }),
      );
      return;
    }
    if (request.url === "/api/v1/browser/screenshot") {
      screenshotCalls += 1;
      response.end(
        JSON.stringify(
          screenshotCalls === 1
            ? {
                tabId: "tab-1",
                mimeType: "image/png",
                width: 0,
                height: 0,
                base64: "",
              }
            : {
                tabId: "tab-1",
                mimeType: "image/png",
                width: 1280,
                height: 720,
                base64: "cG5n",
              },
        ),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  try {
    const service = new DesktopBrowserToolService({
      resolveConfig: () => ({
        authToken: "",
        userId: "",
        sandboxId: "",
        modelProxyBaseUrl: "",
        defaultModel: "openai/gpt-5.4",
        runtimeMode: "oss",
        defaultProvider: "",
        holabossEnabled: false,
        desktopBrowserEnabled: true,
        desktopBrowserUrl: browserServer.url,
        desktopBrowserAuthToken: "browser-token",
        configPath: "/tmp/runtime-config.json",
        loadedFromFile: true,
      }),
    });

    const result = await service.execute(
      "browser_get_state",
      { include_screenshot: true },
      { workspaceId: "workspace-1", sessionId: "session-1" },
    );

    assert.deepEqual((result.page as { loading?: boolean; initialized?: boolean }), {
      tabId: "tab-1",
      url: "https://example.com",
      title: "Example",
      loading: false,
      initialized: true,
    });
    assert.deepEqual((result.state as { viewport?: unknown; media?: unknown[] }).viewport, {
      width: 1280,
      height: 720,
    });
    assert.equal(
      ((result.state as { media?: Array<{ current_src?: string }> }).media ?? [])[0]?.current_src,
      "https://example.com/hero.png",
    );
    assert.deepEqual((result.screenshot as { width?: number; height?: number }), {
      tabId: "tab-1",
      mimeType: "image/png",
      width: 1280,
      height: 720,
      base64: "cG5n",
    });
    assert.equal("warnings" in result, false);
    assert.deepEqual(requests, [
      "/api/v1/browser/page",
      "/api/v1/browser/evaluate",
      "/api/v1/browser/screenshot",
      "/api/v1/browser/page",
      "/api/v1/browser/evaluate",
      "/api/v1/browser/screenshot",
    ]);
  } finally {
    await browserServer.close();
  }
});

test("desktop browser tool service opens a native context menu for media targets", async () => {
  const requests: Array<{ path: string; body: string }> = [];
  const browserServer = await startBrowserServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    requests.push({
      path: request.url ?? "",
      body: Buffer.concat(chunks).toString("utf8"),
    });
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/api/v1/browser/evaluate") {
      response.end(
        JSON.stringify({
          tabId: "tab-1",
          result: {
            ok: true,
            target_kind: "media",
            index: 1,
            x: 184,
            y: 138,
            tag_name: "img",
            label: "Hero image",
            text: "",
          },
        })
      );
      return;
    }
    if (request.url === "/api/v1/browser/context-click") {
      response.end(JSON.stringify({ ok: true, tabId: "tab-1", x: 184, y: 138 }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  try {
    const service = new DesktopBrowserToolService({
      resolveConfig: () => ({
        authToken: "",
        userId: "",
        sandboxId: "",
        modelProxyBaseUrl: "",
        defaultModel: "openai/gpt-5.4",
        runtimeMode: "oss",
        defaultProvider: "",
        holabossEnabled: false,
        desktopBrowserEnabled: true,
        desktopBrowserUrl: browserServer.url,
        desktopBrowserAuthToken: "browser-token",
        configPath: "/tmp/runtime-config.json",
        loadedFromFile: true
      })
    });

    const result = await service.execute(
      "browser_context_click",
      { target: "media", index: 1 },
      { workspaceId: "workspace-1", sessionId: "session-1" }
    );

    const { browser_usage: contextBrowserUsage, ...visibleContextResult } = result;
    assert.deepEqual(visibleContextResult, {
      ok: true,
      action: {
        ok: true,
        target_kind: "media",
        index: 1,
        x: 184,
        y: 138,
        tag_name: "img",
        label: "Hero image",
        text: "",
      },
      context_menu: {
        ok: true,
        tabId: "tab-1",
        x: 184,
        y: 138,
      }
    });
    assert.equal((contextBrowserUsage as { tool_id?: string }).tool_id, "browser_context_click");
    assert.deepEqual(
      requests.map((entry) => entry.path),
      ["/api/v1/browser/evaluate", "/api/v1/browser/context-click"],
    );
    assert.equal(requests[1]?.body, JSON.stringify({ x: 184, y: 138 }));
    assert.match(requests[0]?.body ?? "", /mediaSelector/);
    assert.match(requests[0]?.body ?? "", /const targetKind = \\"media\\";/);
  } finally {
    await browserServer.close();
  }
});

test("desktop browser tool service includes page text only when explicitly requested", async () => {
  const browserServer = await startBrowserServer(async (request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/api/v1/browser/page") {
      response.end(JSON.stringify({ tabId: "tab-1", url: "https://example.com", title: "Example" }));
      return;
    }
    if (request.url === "/api/v1/browser/evaluate") {
      response.end(
        JSON.stringify({
          tabId: "tab-1",
          result: {
            url: "https://example.com",
            title: "Example",
            text: "Example Domain",
            viewport: { width: 1280, height: 720 },
            scroll: { x: 0, y: 0 },
            elements: [{ index: 1, tag_name: "a", label: "More information", text: "More information" }]
          }
        })
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  try {
    const service = new DesktopBrowserToolService({
      resolveConfig: () => ({
        authToken: "",
        userId: "",
        sandboxId: "",
        modelProxyBaseUrl: "",
        defaultModel: "openai/gpt-5.4",
        runtimeMode: "oss",
        defaultProvider: "",
        holabossEnabled: false,
        desktopBrowserEnabled: true,
        desktopBrowserUrl: browserServer.url,
        desktopBrowserAuthToken: "browser-token",
        configPath: "/tmp/runtime-config.json",
        loadedFromFile: true
      })
    });

    const result = await service.execute(
      "browser_get_state",
      { include_page_text: true },
      { workspaceId: "workspace-1", sessionId: "session-1" }
    );

    assert.equal((result.state as { text?: string }).text, "Example Domain");
  } finally {
    await browserServer.close();
  }
});

test("desktop browser tool service accepts scoped browser_get_state controls", async () => {
  const evaluateBodies: string[] = [];
  const browserServer = await startBrowserServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/api/v1/browser/page") {
      response.end(JSON.stringify({ tabId: "tab-1", url: "https://example.com", title: "Example" }));
      return;
    }
    if (request.url === "/api/v1/browser/evaluate") {
      evaluateBodies.push(Buffer.concat(chunks).toString("utf8"));
      response.end(
        JSON.stringify({
          tabId: "tab-1",
          result: {
            url: "https://example.com",
            title: "Example",
            text: "Visible viewport text",
            viewport: { width: 1280, height: 720 },
            scroll: { x: 0, y: 0 },
            elements: [],
            media: [],
            metadata: {
              schema_version: 2,
              mode: "text",
              detail: "compact",
              scope: "dialog",
              max_nodes: 2,
              include_page_text: true,
              include_screenshot: false,
              lists_included: false,
              returned: { elements: 0, media: 0 },
              totals: { elements: 4, media: 1 },
              full_page_totals: { elements: 10, media: 2 },
              truncated: false,
            },
          },
        })
      );
      return;
    }
    if (request.url === "/api/v1/browser/screenshot") {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: "screenshot should not be requested" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  try {
    const service = new DesktopBrowserToolService({
      resolveConfig: () => ({
        authToken: "",
        userId: "",
        sandboxId: "",
        modelProxyBaseUrl: "",
        defaultModel: "openai/gpt-5.4",
        runtimeMode: "oss",
        defaultProvider: "",
        holabossEnabled: false,
        desktopBrowserEnabled: true,
        desktopBrowserUrl: browserServer.url,
        desktopBrowserAuthToken: "browser-token",
        configPath: "/tmp/runtime-config.json",
        loadedFromFile: true
      })
    });

    const result = await service.execute(
      "browser_get_state",
      { mode: "text", scope: "active_dialog", max_nodes: 2 },
      { workspaceId: "workspace-1", sessionId: "session-1" }
    );

    assert.equal((result.state as { text?: string }).text, "Visible viewport text");
    assert.deepEqual((result.state as { metadata?: unknown }).metadata, {
      schema_version: 2,
      mode: "text",
      detail: "compact",
      scope: "dialog",
      max_nodes: 2,
      include_page_text: true,
      include_screenshot: false,
      lists_included: false,
      returned: { elements: 0, media: 0 },
      totals: { elements: 4, media: 1 },
      full_page_totals: { elements: 10, media: 2 },
      truncated: false,
    });
    assert.equal("screenshot" in result, false);
    assert.equal(evaluateBodies.length, 1);
    assert.match(evaluateBodies[0] ?? "", /const mode = \\"text\\";/);
    assert.match(evaluateBodies[0] ?? "", /const detail = \\"compact\\";/);
    assert.match(evaluateBodies[0] ?? "", /const scope = \\"dialog\\";/);
    assert.match(evaluateBodies[0] ?? "", /const maxNodes = 2;/);
    assert.match(evaluateBodies[0] ?? "", /const includeMetadata = true;/);
    assert.equal((result.browser_usage as { detail?: string }).detail, "compact");
  } finally {
    await browserServer.close();
  }
});

test("desktop browser tool service supports revision-aware browser_get_state deltas", async () => {
  const browserServer = await startBrowserServer(async (request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/api/v1/browser/page") {
      response.end(
        JSON.stringify({
          tabId: "tab-1",
          url: "https://example.com/dashboard",
          title: "Dashboard",
          loading: false,
          initialized: true,
        }),
      );
      return;
    }
    if (request.url === "/api/v1/browser/evaluate") {
      response.end(
        JSON.stringify({
          tabId: "tab-1",
          result: {
            url: "https://example.com/dashboard",
            title: "Dashboard",
            viewport: { width: 1280, height: 720 },
            scroll: { x: 0, y: 120 },
            elements: [
              { index: 1, tag_name: "button", role: "button", text: "Refresh", label: "Refresh" },
            ],
            media: [],
            metadata: {
              schema_version: 2,
              mode: "state",
              detail: "compact",
              scope: "main",
              max_nodes: 30,
              include_page_text: false,
              include_screenshot: false,
              lists_included: true,
              returned: { elements: 1, media: 0 },
              totals: { elements: 1, media: 0 },
              full_page_totals: null,
              truncated: false,
            },
          },
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  try {
    const service = new DesktopBrowserToolService({
      resolveConfig: () => ({
        authToken: "",
        userId: "",
        sandboxId: "",
        modelProxyBaseUrl: "",
        defaultModel: "openai/gpt-5.4",
        runtimeMode: "oss",
        defaultProvider: "",
        holabossEnabled: false,
        desktopBrowserEnabled: true,
        desktopBrowserUrl: browserServer.url,
        desktopBrowserAuthToken: "browser-token",
        configPath: "/tmp/runtime-config.json",
        loadedFromFile: true,
      }),
    });

    const initial = await service.execute(
      "browser_get_state",
      {},
      { workspaceId: "workspace-1", sessionId: "session-1" },
    );
    const initialState = initial.state as Record<string, unknown>;
    const revision = String(initialState.revision ?? "");
    assert.ok(revision.length > 0);

    const delta = await service.execute(
      "browser_get_state",
      {
        since_revision: revision,
        changed_only: true,
      },
      { workspaceId: "workspace-1", sessionId: "session-1" },
    );

    assert.deepEqual(delta.page, {
      tabId: "tab-1",
      url: "https://example.com/dashboard",
      title: "Dashboard",
      loading: false,
      initialized: true,
    });
    assert.deepEqual(delta.state, {
      revision,
      changed: false,
    });
    assert.equal(
      (delta.browser_usage as { changed?: boolean | null }).changed,
      false,
    );
    assert.equal(
      (delta.browser_usage as { since_revision?: string | null }).since_revision,
      revision,
    );
  } finally {
    await browserServer.close();
  }
});

test("desktop browser tool service exposes general find, act, wait, evaluate, and debug primitives", async () => {
  const evaluateBodies: string[] = [];
  const mouseBodies: string[] = [];
  const keyboardBodies: string[] = [];
  let waitPredicateCalls = 0;
  const browserServer = await startBrowserServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString("utf8");
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/api/v1/browser/page") {
      response.end(JSON.stringify({ tabId: "tab-1", url: "https://example.com/app", title: "Example App" }));
      return;
    }
    if (request.url === "/api/v1/browser/mouse") {
      mouseBodies.push(body);
      response.end(
        JSON.stringify({
          ok: true,
          tabId: "tab-1",
          action: "click",
          x: 370,
          y: 104,
          resolved_action: {
            ok: true,
            action: "click",
            target: { ref: "css:#new-button", text: "New" },
            result: { x: 370, y: 104 },
          },
        }),
      );
      return;
    }
    if (request.url === "/api/v1/browser/keyboard") {
      keyboardBodies.push(body);
      response.end(
        JSON.stringify({
          ok: true,
          tabId: "tab-1",
          action: "insert_text",
          text_length: 14,
          clear: true,
          submit: false,
          resolved_action: {
            ok: true,
            action: "fill",
            target: { ref: "css:#editor", text: "" },
            action_target: { ref: "css:#editor", role: "textbox", editable: true },
            result: { focused: true },
          },
        }),
      );
      return;
    }
    if (request.url === "/api/v1/browser/evaluate") {
      evaluateBodies.push(body);
      const expression = String((JSON.parse(body) as { expression?: string }).expression ?? "");
      if (expression.includes("const maxResults = 10")) {
        response.end(
          JSON.stringify({
            tabId: "tab-1",
            result: {
              ok: true,
              count: 1,
              truncated: false,
              matches: [
                {
                  ref: "css:#new-button",
                  action_ref: "css:#new-button",
                  tag_name: "div",
                  role: "button",
                  text: "New",
                  label: "New",
                  visible: true,
                  bounding_box: { x: 292, y: 72, width: 156, height: 64 },
                },
              ],
            },
          }),
        );
        return;
      }
      if (expression.includes('const action = "check"')) {
        response.end(
          JSON.stringify({
            tabId: "tab-1",
            result: {
              ok: true,
              action: "check",
              target: { ref: "css:#newsletter-row", text: "Newsletter" },
              action_target: { ref: "css:#newsletter", role: "checkbox" },
              result: { checked: true, changed: true },
            },
          }),
        );
        return;
      }
      if (expression.includes('const condition = "element"')) {
        waitPredicateCalls += 1;
        response.end(
          JSON.stringify({
            tabId: "tab-1",
            result: {
              ok: true,
              matched: waitPredicateCalls >= 2,
              condition: "element",
              match_count: waitPredicateCalls >= 2 ? 1 : 0,
            },
          }),
        );
        return;
      }
      if (expression.includes('const condition = "dom_change"')) {
        response.end(
          JSON.stringify({
            tabId: "tab-1",
            result: {
              ok: true,
              matched: true,
              condition: "dom_change",
              match_count: null,
            },
          }),
        );
        return;
      }
      if (expression.includes("element_count: document.querySelectorAll")) {
        response.end(
          JSON.stringify({
            tabId: "tab-1",
            result: {
              url: "https://example.com/app",
              title: "Example App",
              ready_state: "complete",
              text_length: 12,
              element_count: 4,
              active_tag: "body",
            },
          }),
        );
        return;
      }
      if (expression.includes("elementFromPoint")) {
        response.end(
          JSON.stringify({
            tabId: "tab-1",
            result: {
              ok: true,
              url: "https://example.com/app",
              title: "Example App",
              ready_state: "complete",
              hit_test: { x: 20, y: 30, element: { tag_name: "button", text: "New" } },
            },
          }),
        );
        return;
      }
      if (expression.includes("document.title")) {
        response.end(JSON.stringify({ tabId: "tab-1", result: { ok: true, result: "Example App" } }));
        return;
      }
      response.statusCode = 500;
      response.end(JSON.stringify({ error: "unexpected expression" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  try {
    const service = new DesktopBrowserToolService({
      resolveConfig: () => ({
        authToken: "",
        userId: "",
        sandboxId: "",
        modelProxyBaseUrl: "",
        defaultModel: "openai/gpt-5.4",
        runtimeMode: "oss",
        defaultProvider: "",
        holabossEnabled: false,
        desktopBrowserEnabled: true,
        desktopBrowserUrl: browserServer.url,
        desktopBrowserAuthToken: "browser-token",
        configPath: "/tmp/runtime-config.json",
        loadedFromFile: true
      })
    });

    const findResult = await service.execute("browser_find", {
      text: "New",
      role: "button",
      scope: "viewport",
      max_results: 10,
    });
    assert.equal((findResult.find as { count?: number }).count, 1);
    assert.equal(
      (((findResult.find as { matches?: Array<{ ref?: string }> }).matches ?? [])[0]?.ref),
      "css:#new-button",
    );

    const actResult = await service.execute("browser_act", {
      action: "click",
      text: "New",
      role: "button",
      exact: true,
    });
    assert.equal((actResult.action as { action?: string }).action, "click");
    const nativeInput =
      ((actResult.action as { result?: Record<string, unknown> }).result ?? {}).native_input;
    assert.deepEqual(
      nativeInput,
      { ok: true, tabId: "tab-1", action: "click", x: 370, y: 104 },
    );
    assert.deepEqual(actResult.page, { tabId: "tab-1", url: "https://example.com/app", title: "Example App" });
    assert.equal((actResult.browser_usage as { tool_id?: string }).tool_id, "browser_act");
    assert.equal(mouseBodies.length, 1);
    const clickMouseBody = JSON.parse(mouseBodies[0]) as Record<string, unknown>;
    assert.equal(clickMouseBody.action, "click");
    assert.equal(typeof clickMouseBody.expression, "string");
    assert.match(String(clickMouseBody.expression), /const action = "click"/);

    const fillResult = await service.execute("browser_act", {
      action: "fill",
      selector: "#editor",
      value: "Robotics notes",
      clear: true,
    });
    assert.equal((fillResult.action as { action?: string }).action, "fill");
    assert.deepEqual(
      (((fillResult.action as { result?: Record<string, unknown> }).result ?? {}).native_input),
      { ok: true, tabId: "tab-1", action: "insert_text", text_length: 14, clear: true, submit: false },
    );
    assert.equal((fillResult.browser_usage as { tool_id?: string }).tool_id, "browser_act");
    assert.equal(keyboardBodies.length, 1);
    const fillKeyboardBody = JSON.parse(keyboardBodies[0]) as Record<string, unknown>;
    assert.equal(fillKeyboardBody.action, "insert_text");
    assert.equal(fillKeyboardBody.text, "Robotics notes");
    assert.equal(fillKeyboardBody.clear, true);
    assert.equal(fillKeyboardBody.submit, false);
    assert.equal(typeof fillKeyboardBody.expression, "string");
    assert.match(String(fillKeyboardBody.expression), /const action = "fill"/);

    const checkResult = await service.execute("browser_act", {
      action: "check",
      label: "Newsletter",
      role: "checkbox",
    });
    assert.equal((checkResult.action as { action?: string }).action, "check");
    assert.deepEqual(
      ((checkResult.action as { result?: Record<string, unknown> }).result ?? {}),
      { checked: true, changed: true },
    );
    assert.equal((checkResult.browser_usage as { tool_id?: string }).tool_id, "browser_act");

    const waitResult = await service.execute("browser_wait", {
      condition: "element",
      text: "Created",
      timeout_ms: 1000,
    });
    assert.equal((waitResult.wait as { matched?: boolean }).matched, true);
    assert.equal((waitResult.wait as { attempts?: number }).attempts, 2);
    assert.equal((waitResult.browser_usage as { tool_id?: string }).tool_id, "browser_wait");

    const changeWaitResult = await service.execute("browser_wait", {
      condition: "change",
      timeout_ms: 1000,
    });
    assert.equal((changeWaitResult.wait as { matched?: boolean }).matched, true);
    assert.equal((changeWaitResult.wait as { condition?: string }).condition, "dom_change");

    const evaluateResult = await service.execute("browser_evaluate", {
      expression: "document.title",
      timeout_ms: 1000,
    });
    assert.equal((evaluateResult.evaluation as { result?: string }).result, "Example App");

    const debugResult = await service.execute("browser_debug", { x: 20, y: 30 });
    assert.deepEqual(debugResult.page, { tabId: "tab-1", url: "https://example.com/app", title: "Example App" });
    assert.equal((debugResult.debug as { ready_state?: string }).ready_state, "complete");

    const expressions = evaluateBodies.map((body) => String((JSON.parse(body) as { expression?: string }).expression ?? ""));
    const findExpression = expressions.find((expression) => expression.includes('"text":"New"')) ?? "";
    assert.match(findExpression, /"role":"button"/);
    assert.ok(expressions.some((expression) => /const action = "check"/.test(expression)));
    assert.ok(expressions.some((expression) => /const condition = "element"/.test(expression)));
  } finally {
    await browserServer.close();
  }
});

test("desktop browser tool service supports load_state and function browser_wait conditions", async () => {
  const evaluateBodies: string[] = [];
  const browserServer = await startBrowserServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/api/v1/browser/evaluate") {
      const body = Buffer.concat(chunks).toString("utf8");
      evaluateBodies.push(body);
      const expression = String((JSON.parse(body) as { expression?: string }).expression ?? "");
      if (expression.includes('const condition = "load"')) {
        response.end(
          JSON.stringify({
            tabId: "tab-1",
            result: {
              ok: true,
              matched: true,
              condition: "load",
              load_state: "interactive",
              current: {
                ready_state: "interactive",
              },
            },
          }),
        );
        return;
      }
      if (expression.includes('const condition = "function"')) {
        response.end(
          JSON.stringify({
            tabId: "tab-1",
            result: {
              ok: true,
              matched: true,
              condition: "function",
              function_result: { ready: true },
            },
          }),
        );
        return;
      }
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  try {
    const service = new DesktopBrowserToolService({
      resolveConfig: () => ({
        authToken: "",
        userId: "",
        sandboxId: "",
        modelProxyBaseUrl: "",
        defaultModel: "openai/gpt-5.4",
        runtimeMode: "oss",
        defaultProvider: "",
        holabossEnabled: false,
        desktopBrowserEnabled: true,
        desktopBrowserUrl: browserServer.url,
        desktopBrowserAuthToken: "browser-token",
        configPath: "/tmp/runtime-config.json",
        loadedFromFile: true,
      }),
    });

    const loadWait = await service.execute("browser_wait", {
      load_state: "domcontentloaded",
      timeout_ms: 1000,
    });
    assert.equal((loadWait.wait as { matched?: boolean }).matched, true);
    assert.equal((loadWait.wait as { load_state?: string }).load_state, "interactive");

    const functionWait = await service.execute("browser_wait", {
      condition: "function",
      expression: "() => ({ ready: true })",
      timeout_ms: 1000,
    });
    assert.equal((functionWait.wait as { matched?: boolean }).matched, true);
    assert.deepEqual(
      (((functionWait.wait as { result?: Record<string, unknown> }).result ?? {}).function_result),
      { ready: true },
    );

    const expressions = evaluateBodies.map((body) => String((JSON.parse(body) as { expression?: string }).expression ?? ""));
    assert.ok(expressions.some((expression) => /const loadState = "interactive"/.test(expression)));
    assert.ok(expressions.some((expression) => /const functionSource = "\(\) => \(\{ ready: true \}\)"/.test(expression)));
  } finally {
    await browserServer.close();
  }
});

test("desktop browser tool service waits for browser downloads to start and complete", async () => {
  let downloadRequestCount = 0;
  const browserServer = await startBrowserServer(async (request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/api/v1/browser/downloads") {
      downloadRequestCount += 1;
      const payload =
        downloadRequestCount <= 2
          ? { downloads: [] }
          : downloadRequestCount <= 4
            ? {
                downloads: [
                  {
                    id: "download-1",
                    url: "https://example.com/report.csv",
                    filename: "report.csv",
                    targetPath: "/tmp/report.csv",
                    status: "progressing",
                    receivedBytes: 128,
                    totalBytes: 512,
                    createdAt: "2026-04-29T12:00:00.000Z",
                    completedAt: null,
                  },
                ],
              }
            : {
                downloads: [
                  {
                    id: "download-1",
                    url: "https://example.com/report.csv",
                    filename: "report.csv",
                    targetPath: "/tmp/report.csv",
                    status: "completed",
                    receivedBytes: 512,
                    totalBytes: 512,
                    createdAt: "2026-04-29T12:00:00.000Z",
                    completedAt: "2026-04-29T12:00:01.000Z",
                  },
                ],
              };
      response.end(JSON.stringify(payload));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  try {
    const service = new DesktopBrowserToolService({
      resolveConfig: () => ({
        authToken: "",
        userId: "",
        sandboxId: "",
        modelProxyBaseUrl: "",
        defaultModel: "openai/gpt-5.4",
        runtimeMode: "oss",
        defaultProvider: "",
        holabossEnabled: false,
        desktopBrowserEnabled: true,
        desktopBrowserUrl: browserServer.url,
        desktopBrowserAuthToken: "browser-token",
        configPath: "/tmp/runtime-config.json",
        loadedFromFile: true,
      }),
    });

    const startWait = await service.execute("browser_wait", {
      condition: "download_started",
      timeout_ms: 1000,
    });
    assert.equal((startWait.wait as { matched?: boolean }).matched, true);
    assert.equal((startWait.wait as { condition?: string }).condition, "download_started");
    assert.deepEqual(
      ((startWait.wait as { download?: Record<string, unknown> }).download ?? {}),
      {
        id: "download-1",
        url: "https://example.com/report.csv",
        filename: "report.csv",
        targetPath: "/tmp/report.csv",
        status: "progressing",
        receivedBytes: 128,
        totalBytes: 512,
        createdAt: "2026-04-29T12:00:00.000Z",
        completedAt: null,
      },
    );

    const completeWait = await service.execute("browser_wait", {
      condition: "download_completed",
      filename: "report.csv",
      timeout_ms: 1000,
    });
    assert.equal((completeWait.wait as { matched?: boolean }).matched, true);
    assert.equal((completeWait.wait as { filename?: string }).filename, "report.csv");
    assert.deepEqual(
      ((completeWait.wait as { download?: Record<string, unknown> }).download ?? {}),
      {
        id: "download-1",
        url: "https://example.com/report.csv",
        filename: "report.csv",
        targetPath: "/tmp/report.csv",
        status: "completed",
        receivedBytes: 512,
        totalBytes: 512,
        createdAt: "2026-04-29T12:00:00.000Z",
        completedAt: "2026-04-29T12:00:01.000Z",
      },
    );
    assert.equal(
      (completeWait.browser_usage as { condition?: string }).condition,
      "download_completed",
    );
    assert.equal(
      (completeWait.browser_usage as { filename?: string }).filename,
      "report.csv",
    );
  } finally {
    await browserServer.close();
  }
});

test("desktop browser tool service supports inline wait_for and post_state on browser_type", async () => {
  const requests: string[] = [];
  const bodies: string[] = [];
  const browserServer = await startBrowserServer(async (request, response) => {
    requests.push(request.url ?? "");
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString("utf8");
    bodies.push(body);
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/api/v1/browser/page") {
      response.end(
        JSON.stringify({ tabId: "tab-1", url: "https://example.com/search", title: "Search" }),
      );
      return;
    }
    if (request.url === "/api/v1/browser/evaluate") {
      const expression = String((JSON.parse(body) as { expression?: string }).expression ?? "");
      if (expression.includes('const condition = "function"')) {
        response.end(
          JSON.stringify({
            tabId: "tab-1",
            result: {
              ok: true,
              matched: true,
              condition: "function",
              function_result: true,
            },
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          tabId: "tab-1",
          result: {
            url: "https://example.com/search",
            title: "Search",
            viewport: { width: 1280, height: 720 },
            scroll: { x: 0, y: 0 },
            elements: [{ index: 1, tag_name: "a", role: "link", text: "Result", label: "Result" }],
            media: [],
            metadata: {
              schema_version: 2,
              mode: "state",
              detail: "compact",
              scope: "main",
              max_nodes: 12,
              include_page_text: false,
              include_screenshot: false,
              lists_included: true,
              returned: { elements: 1, media: 0 },
              totals: { elements: 1, media: 0 },
              full_page_totals: null,
              truncated: false,
            },
          },
        }),
      );
      return;
    }
    if (request.url === "/api/v1/browser/keyboard") {
      response.end(
        JSON.stringify({
          ok: true,
          tabId: "tab-1",
          action: "insert_text",
          index: 1,
          tag_name: "input",
          role: "textbox",
          editable: true,
          text_length: 12,
          clear: true,
          submit: false,
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  try {
    const service = new DesktopBrowserToolService({
      resolveConfig: () => ({
        authToken: "",
        userId: "",
        sandboxId: "",
        modelProxyBaseUrl: "",
        defaultModel: "openai/gpt-5.4",
        runtimeMode: "oss",
        defaultProvider: "",
        holabossEnabled: false,
        desktopBrowserEnabled: true,
        desktopBrowserUrl: browserServer.url,
        desktopBrowserAuthToken: "browser-token",
        configPath: "/tmp/runtime-config.json",
        loadedFromFile: true,
      }),
    });

    const result = await service.execute(
      "browser_type",
      {
        index: 1,
        text: "search terms",
        wait_for: { condition: "function", expression: "() => true" },
        wait_timeout_ms: 1000,
        post_state: "state",
      },
      { workspaceId: "workspace-1", sessionId: "session-1" },
    );

    assert.equal((result.wait as { matched?: boolean }).matched, true);
    assert.deepEqual(result.page, {
      tabId: "tab-1",
      url: "https://example.com/search",
      title: "Search",
    });
    const postState = result.state as Record<string, unknown>;
    assert.equal(typeof postState.revision, "string");
    delete postState.revision;
    assert.deepEqual(postState, {
      url: "https://example.com/search",
      title: "Search",
      viewport: { width: 1280, height: 720 },
      scroll: { x: 0, y: 0 },
      elements: [{ index: 1, tag_name: "a", role: "link", text: "Result", label: "Result" }],
      media: [],
    });
    assert.equal((result.browser_usage as { tool_id?: string }).tool_id, "browser_type");
    assert.equal((result.browser_usage as { post_state?: string }).post_state, "state");
    assert.equal((result.browser_usage as { wait_condition?: string }).wait_condition, "function");
    assert.equal((result.browser_usage as { detail?: string }).detail, "compact");
    assert.deepEqual(requests, [
      "/api/v1/browser/keyboard",
      "/api/v1/browser/evaluate",
      "/api/v1/browser/page",
      "/api/v1/browser/evaluate",
    ]);
    const expressions = bodies
      .filter((body) => body.includes("\"expression\""))
      .map((body) => String((JSON.parse(body) as { expression?: string }).expression ?? ""));
    assert.ok(expressions.some((expression) => /const condition = "function"/.test(expression)));
    assert.ok(expressions.some((expression) => /const maxNodes = 12;/.test(expression)));
  } finally {
    await browserServer.close();
  }
});

test("desktop browser tool service avoids refetching page summaries for browser_type", async () => {
  const requests: string[] = [];
  const bodies: string[] = [];
  const browserServer = await startBrowserServer(async (request, response) => {
    requests.push(request.url ?? "");
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    bodies.push(Buffer.concat(chunks).toString("utf8"));
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/api/v1/browser/keyboard") {
      response.end(
        JSON.stringify({
          ok: true,
          tabId: "tab-1",
          action: "insert_text",
          index: 1,
          tag_name: "div",
          role: "textbox",
          editable: true,
          text_length: 12,
          clear: true,
          submit: false,
        })
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  try {
    const service = new DesktopBrowserToolService({
      resolveConfig: () => ({
        authToken: "",
        userId: "",
        sandboxId: "",
        modelProxyBaseUrl: "",
        defaultModel: "openai/gpt-5.4",
        runtimeMode: "oss",
        defaultProvider: "",
        holabossEnabled: false,
        desktopBrowserEnabled: true,
        desktopBrowserUrl: browserServer.url,
        desktopBrowserAuthToken: "browser-token",
        configPath: "/tmp/runtime-config.json",
        loadedFromFile: true
      })
    });

    const result = await service.execute(
      "browser_type",
      { index: 1, text: "search terms" },
      { workspaceId: "workspace-1", sessionId: "session-1" }
    );

    const { browser_usage: typeBrowserUsage, ...visibleTypeResult } = result;
    assert.deepEqual(visibleTypeResult, {
      ok: true,
      action: {
        ok: true,
        index: 1,
        tag_name: "div",
        role: "textbox",
        editable: true,
        result: {
          value: "search terms",
          native_input: {
            ok: true,
            tabId: "tab-1",
            action: "insert_text",
            text_length: 12,
            clear: true,
            submit: false,
          },
        },
      }
    });
    assert.equal((typeBrowserUsage as { tool_id?: string }).tool_id, "browser_type");
    assert.deepEqual(requests, ["/api/v1/browser/keyboard"]);
    assert.equal(
      bodies[0],
      JSON.stringify({ action: "insert_text", index: 1, text: "search terms", clear: true, submit: false }),
    );
  } finally {
    await browserServer.close();
  }
});

test("desktop browser tool service executes browser_open_tab against the desktop browser service", async () => {
  const requests: Array<{ path: string; token: string; workspaceId: string; sessionId: string; body: string }> = [];
  const browserServer = await startBrowserServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      path: request.url ?? "",
      token: String(request.headers["x-holaboss-desktop-token"] ?? ""),
      workspaceId: String(request.headers["x-holaboss-workspace-id"] ?? ""),
      sessionId: String(request.headers["x-holaboss-session-id"] ?? ""),
      body
    });
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/api/v1/browser/tabs") {
      response.end(
        JSON.stringify({
          activeTabId: "tab-2",
          tabs: [
            { id: "tab-1", url: "https://example.com", title: "Example" },
            { id: "tab-2", url: "https://example.org", title: "Example Org" }
          ]
        })
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  try {
    const service = new DesktopBrowserToolService({
      resolveConfig: () => ({
        authToken: "",
        userId: "",
        sandboxId: "",
        modelProxyBaseUrl: "",
        defaultModel: "openai/gpt-5.4",
        runtimeMode: "oss",
        defaultProvider: "",
        holabossEnabled: false,
        desktopBrowserEnabled: true,
        desktopBrowserUrl: browserServer.url,
        desktopBrowserAuthToken: "browser-token",
        configPath: "/tmp/runtime-config.json",
        loadedFromFile: true
      })
    });

    const result = await service.execute(
      "browser_open_tab",
      { url: "https://example.org", background: true },
      { workspaceId: "workspace-1" }
    );
    const { browser_usage: openTabBrowserUsage, ...visibleOpenTabResult } = result;
    assert.deepEqual(visibleOpenTabResult, {
      ok: true,
      tabs: {
        activeTabId: "tab-2",
        tabs: [
          { id: "tab-1", url: "https://example.com", title: "Example" },
          { id: "tab-2", url: "https://example.org", title: "Example Org" }
        ]
      }
    });
    assert.equal((openTabBrowserUsage as { tool_id?: string }).tool_id, "browser_open_tab");
    assert.deepEqual(requests, [
      {
        path: "/api/v1/browser/tabs",
        token: "browser-token",
        workspaceId: "workspace-1",
        sessionId: "",
        body: JSON.stringify({ url: "https://example.org", background: true })
      }
    ]);
  } finally {
    await browserServer.close();
  }
});

test("desktop browser tool service executes browser_select_tab and browser_close_tab against the desktop browser service", async () => {
  const requests: Array<{
    path: string;
    token: string;
    workspaceId: string;
    sessionId: string;
    browserSpace: string;
    body: string;
  }> = [];
  const browserServer = await startBrowserServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      path: request.url ?? "",
      token: String(request.headers["x-holaboss-desktop-token"] ?? ""),
      workspaceId: String(request.headers["x-holaboss-workspace-id"] ?? ""),
      sessionId: String(request.headers["x-holaboss-session-id"] ?? ""),
      browserSpace: String(request.headers["x-holaboss-browser-space"] ?? ""),
      body,
    });
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/api/v1/browser/tabs/select") {
      response.end(
        JSON.stringify({
          activeTabId: "tab-2",
          tabs: [
            { id: "tab-1", url: "https://example.com", title: "Example" },
            { id: "tab-2", url: "https://example.org", title: "Example Org" },
          ],
        }),
      );
      return;
    }
    if (request.url === "/api/v1/browser/tabs/close") {
      response.end(
        JSON.stringify({
          activeTabId: "tab-1",
          tabs: [{ id: "tab-1", url: "https://example.com", title: "Example" }],
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  try {
    const service = new DesktopBrowserToolService({
      resolveConfig: () => ({
        authToken: "",
        userId: "",
        sandboxId: "",
        modelProxyBaseUrl: "",
        defaultModel: "openai/gpt-5.4",
        runtimeMode: "oss",
        defaultProvider: "",
        holabossEnabled: false,
        desktopBrowserEnabled: true,
        desktopBrowserUrl: browserServer.url,
        desktopBrowserAuthToken: "browser-token",
        configPath: "/tmp/runtime-config.json",
        loadedFromFile: true,
      }),
    });

    const selection = await service.execute(
      "browser_select_tab",
      { tab_id: "tab-2" },
      { workspaceId: "workspace-1", sessionId: "session-7", space: "agent" },
    );
    const { browser_usage: selectTabBrowserUsage, ...visibleSelection } = selection;
    assert.deepEqual(visibleSelection, {
      ok: true,
      tabs: {
        activeTabId: "tab-2",
        tabs: [
          { id: "tab-1", url: "https://example.com", title: "Example" },
          { id: "tab-2", url: "https://example.org", title: "Example Org" },
        ],
      },
    });
    assert.equal(
      (selectTabBrowserUsage as { tool_id?: string }).tool_id,
      "browser_select_tab",
    );

    const close = await service.execute(
      "browser_close_tab",
      { tab_id: "tab-2" },
      { workspaceId: "workspace-1", sessionId: "session-7", space: "agent" },
    );
    const { browser_usage: closeTabBrowserUsage, ...visibleClose } = close;
    assert.deepEqual(visibleClose, {
      ok: true,
      tabs: {
        activeTabId: "tab-1",
        tabs: [{ id: "tab-1", url: "https://example.com", title: "Example" }],
      },
    });
    assert.equal(
      (closeTabBrowserUsage as { tool_id?: string }).tool_id,
      "browser_close_tab",
    );

    assert.deepEqual(requests, [
      {
        path: "/api/v1/browser/tabs/select",
        token: "browser-token",
        workspaceId: "workspace-1",
        sessionId: "session-7",
        browserSpace: "agent",
        body: JSON.stringify({ tab_id: "tab-2" }),
      },
      {
        path: "/api/v1/browser/tabs/close",
        token: "browser-token",
        workspaceId: "workspace-1",
        sessionId: "session-7",
        browserSpace: "agent",
        body: JSON.stringify({ tab_id: "tab-2" }),
      },
    ]);
  } finally {
    await browserServer.close();
  }
});

test("desktop browser tool service executes browser_list_downloads against the desktop browser service", async () => {
  const requests: Array<{
    path: string;
    token: string;
    workspaceId: string;
    sessionId: string;
    browserSpace: string;
  }> = [];
  const browserServer = await startBrowserServer(async (request, response) => {
    requests.push({
      path: request.url ?? "",
      token: String(request.headers["x-holaboss-desktop-token"] ?? ""),
      workspaceId: String(request.headers["x-holaboss-workspace-id"] ?? ""),
      sessionId: String(request.headers["x-holaboss-session-id"] ?? ""),
      browserSpace: String(request.headers["x-holaboss-browser-space"] ?? ""),
    });
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/api/v1/browser/downloads") {
      response.end(
        JSON.stringify({
          downloads: [
            {
              id: "download-1",
              url: "https://example.com/report.csv",
              filename: "report.csv",
              targetPath: "/tmp/report.csv",
              status: "completed",
              receivedBytes: 512,
              totalBytes: 512,
              createdAt: "2026-04-29T12:00:00.000Z",
              completedAt: "2026-04-29T12:00:01.000Z",
            },
          ],
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  try {
    const service = new DesktopBrowserToolService({
      resolveConfig: () => ({
        authToken: "",
        userId: "",
        sandboxId: "",
        modelProxyBaseUrl: "",
        defaultModel: "openai/gpt-5.4",
        runtimeMode: "oss",
        defaultProvider: "",
        holabossEnabled: false,
        desktopBrowserEnabled: true,
        desktopBrowserUrl: browserServer.url,
        desktopBrowserAuthToken: "browser-token",
        configPath: "/tmp/runtime-config.json",
        loadedFromFile: true,
      }),
    });

    const result = await service.execute(
      "browser_list_downloads",
      {},
      { workspaceId: "workspace-1", sessionId: "session-9", space: "user" },
    );
    const { browser_usage: listDownloadsBrowserUsage, ...visibleResult } = result;
    assert.deepEqual(visibleResult, {
      ok: true,
      downloads: [
        {
          id: "download-1",
          url: "https://example.com/report.csv",
          filename: "report.csv",
          targetPath: "/tmp/report.csv",
          status: "completed",
          receivedBytes: 512,
          totalBytes: 512,
          createdAt: "2026-04-29T12:00:00.000Z",
          completedAt: "2026-04-29T12:00:01.000Z",
        },
      ],
    });
    assert.equal(
      (listDownloadsBrowserUsage as { tool_id?: string }).tool_id,
      "browser_list_downloads",
    );
    assert.deepEqual(requests, [
      {
        path: "/api/v1/browser/downloads",
        token: "browser-token",
        workspaceId: "workspace-1",
        sessionId: "session-9",
        browserSpace: "user",
      },
    ]);
  } finally {
    await browserServer.close();
  }
});

test("desktop browser tool service supports compact console, error, and request observability tools", async () => {
  const requests: Array<{ path: string; body: string }> = [];
  const browserServer = await startBrowserServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({
      path: request.url ?? "",
      body,
    });
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/api/v1/browser/console?limit=5&level=warning") {
      response.end(
        JSON.stringify({
          entries: [
            {
              id: "console-1",
              level: "error",
              message: "Unhandled error",
              sourceId: "https://example.com/app.js",
              lineNumber: 18,
              timestamp: "2026-04-29T12:00:00.000Z",
              frameUrl: "https://example.com/app",
            },
          ],
          total: 1,
          truncated: false,
        }),
      );
      return;
    }
    if (request.url === "/api/v1/browser/errors?limit=3&source=network") {
      response.end(
        JSON.stringify({
          errors: [
            {
              id: "network-1",
              source: "network",
              kind: "request_error",
              level: "error",
              message: "net::ERR_CONNECTION_REFUSED",
              timestamp: "2026-04-29T12:00:01.000Z",
              url: "https://example.com/api",
              requestId: "84",
              resourceType: "xhr",
            },
          ],
          total: 1,
          truncated: false,
        }),
      );
      return;
    }
    if (request.url === "/api/v1/browser/requests?limit=4&resource_type=xhr&failures_only=true") {
      response.end(
        JSON.stringify({
          requests: [
            {
              id: "84",
              url: "https://example.com/api",
              method: "GET",
              resourceType: "xhr",
              startedAt: "2026-04-29T12:00:00.000Z",
              completedAt: "2026-04-29T12:00:01.000Z",
              durationMs: 1000,
              fromCache: false,
              statusCode: 500,
              statusLine: "HTTP/1.1 500 Internal Server Error",
              error: "",
            },
          ],
          total: 1,
          truncated: false,
        }),
      );
      return;
    }
    if (request.url === "/api/v1/browser/requests/84") {
      response.end(
        JSON.stringify({
          request: {
            id: "84",
            url: "https://example.com/api",
            method: "POST",
            resourceType: "xhr",
            referrer: "https://example.com/app",
            startedAt: "2026-04-29T12:00:00.000Z",
            completedAt: "2026-04-29T12:00:01.000Z",
            durationMs: 1000,
            fromCache: false,
            statusCode: 500,
            statusLine: "HTTP/1.1 500 Internal Server Error",
            error: "",
            requestHeaders: {
              "content-type": ["application/json"],
            },
            responseHeaders: {
              "content-type": ["application/json"],
              "content-length": ["128"],
            },
            requestBody: {
              entryCount: 1,
              byteLength: 42,
              fileCount: 0,
              types: ["bytes"],
            },
            responseBody: {
              contentType: "application/json",
              contentLength: 128,
            },
          },
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  try {
    const service = new DesktopBrowserToolService({
      resolveConfig: () => ({
        authToken: "",
        userId: "",
        sandboxId: "",
        modelProxyBaseUrl: "",
        defaultModel: "openai/gpt-5.4",
        runtimeMode: "oss",
        defaultProvider: "",
        holabossEnabled: false,
        desktopBrowserEnabled: true,
        desktopBrowserUrl: browserServer.url,
        desktopBrowserAuthToken: "browser-token",
        configPath: "/tmp/runtime-config.json",
        loadedFromFile: true,
      }),
    });

    const consoleResult = await service.execute("browser_get_console", {
      limit: 5,
      level: "warning",
    });
    assert.equal((consoleResult.entries as unknown[]).length, 1);
    assert.equal(
      (consoleResult.browser_usage as { tool_id?: string }).tool_id,
      "browser_get_console",
    );

    const errorsResult = await service.execute("browser_get_errors", {
      limit: 3,
      source: "network",
    });
    assert.equal((errorsResult.errors as unknown[]).length, 1);
    assert.equal(
      (errorsResult.browser_usage as { tool_id?: string }).tool_id,
      "browser_get_errors",
    );

    const requestsResult = await service.execute("browser_list_requests", {
      limit: 4,
      resource_type: "xhr",
      failures_only: true,
    });
    assert.equal((requestsResult.requests as unknown[]).length, 1);
    assert.equal(
      (requestsResult.browser_usage as { tool_id?: string }).tool_id,
      "browser_list_requests",
    );

    const requestResult = await service.execute("browser_get_request", {
      request_id: "84",
    });
    assert.equal(
      ((requestResult.request as { id?: string }).id),
      "84",
    );
    assert.equal(
      (requestResult.browser_usage as { tool_id?: string }).tool_id,
      "browser_get_request",
    );

    assert.deepEqual(
      requests.map((entry) => entry.path),
      [
        "/api/v1/browser/console?limit=5&level=warning",
        "/api/v1/browser/errors?limit=3&source=network",
        "/api/v1/browser/requests?limit=4&resource_type=xhr&failures_only=true",
        "/api/v1/browser/requests/84",
      ],
    );
  } finally {
    await browserServer.close();
  }
});

test("desktop browser tool service supports browser storage and cookie helpers", async () => {
  const evaluateBodies: string[] = [];
  const cookieRequests: Array<{ method: string; path: string; body: string }> = [];
  const browserServer = await startBrowserServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString("utf8");
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/api/v1/browser/evaluate") {
      evaluateBodies.push(body);
      const expression = String((JSON.parse(body) as { expression?: string }).expression ?? "");
      if (expression.includes("targetStorage.setItem")) {
        response.end(
          JSON.stringify({
            tabId: "tab-1",
            result: {
              ok: true,
              storage: "session",
              key: "auth-token",
              deleted: false,
              existed: false,
              previous_value: null,
              value: "secret",
            },
          }),
        );
        return;
      }
      if (expression.includes("const targetStorage = storageKind === \"session\"")) {
        response.end(
          JSON.stringify({
            tabId: "tab-1",
            result: {
              ok: true,
              storage: "session",
              key: null,
              prefix: "auth:",
              count: 1,
              truncated: false,
              entries: [{ key: "auth-token", value: "secret" }],
              value: null,
              available_keys: 1,
            },
          }),
        );
        return;
      }
    }
    if ((request.url ?? "").startsWith("/api/v1/browser/cookies")) {
      cookieRequests.push({
        method: request.method ?? "GET",
        path: request.url ?? "",
        body,
      });
      if (request.method === "GET") {
        response.end(
          JSON.stringify({
            cookies: [
              {
                name: "sid",
                value: "one",
                domain: ".example.com",
                path: "/",
                secure: true,
                httpOnly: true,
                session: false,
                sameSite: "lax",
                expirationDate: 1800000000,
              },
              {
                name: "prefs",
                value: "two",
                domain: ".example.com",
                path: "/",
                secure: false,
                httpOnly: false,
                session: true,
                sameSite: "unspecified",
                expirationDate: null,
              },
            ],
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          ok: true,
          cookie: {
            name: "sid",
            value: "fresh",
            domain: ".example.com",
            path: "/",
            secure: true,
            httpOnly: true,
            session: false,
            sameSite: "lax",
            expirationDate: 1800000000,
          },
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  try {
    const service = new DesktopBrowserToolService({
      resolveConfig: () => ({
        authToken: "",
        userId: "",
        sandboxId: "",
        modelProxyBaseUrl: "",
        defaultModel: "openai/gpt-5.4",
        runtimeMode: "oss",
        defaultProvider: "",
        holabossEnabled: false,
        desktopBrowserEnabled: true,
        desktopBrowserUrl: browserServer.url,
        desktopBrowserAuthToken: "browser-token",
        configPath: "/tmp/runtime-config.json",
        loadedFromFile: true,
      }),
    });

    const storageSet = await service.execute("browser_storage_set", {
      storage: "session",
      key: "auth-token",
      value: "secret",
    });
    assert.equal(
      ((storageSet.storage as { value?: string }).value),
      "secret",
    );
    assert.equal(
      (storageSet.browser_usage as { tool_id?: string }).tool_id,
      "browser_storage_set",
    );

    const storageGet = await service.execute("browser_storage_get", {
      storage: "session",
      prefix: "auth:",
    });
    assert.deepEqual(storageGet.storage, {
      ok: true,
      storage: "session",
      key: null,
      prefix: "auth:",
      count: 1,
      truncated: false,
      entries: [{ key: "auth-token", value: "secret" }],
      value: null,
      available_keys: 1,
    });
    assert.equal(
      (storageGet.browser_usage as { tool_id?: string }).tool_id,
      "browser_storage_get",
    );

    const cookiesGet = await service.execute("browser_cookies_get", {
      url: "https://example.com/account",
      names: ["sid"],
      max_results: 10,
    });
    assert.deepEqual(cookiesGet.cookies, [
      {
        name: "sid",
        value: "one",
        domain: ".example.com",
        path: "/",
        secure: true,
        httpOnly: true,
        session: false,
        sameSite: "lax",
        expirationDate: 1800000000,
      },
    ]);

    const cookiesSet = await service.execute("browser_cookies_set", {
      url: "https://example.com/account",
      name: "sid",
      value: "fresh",
      secure: true,
      http_only: true,
      same_site: "lax",
      expiration_date: 1800000000,
    });
    assert.deepEqual(cookiesSet.cookie, {
      name: "sid",
      value: "fresh",
      domain: ".example.com",
      path: "/",
      secure: true,
      httpOnly: true,
      session: false,
      sameSite: "lax",
      expirationDate: 1800000000,
    });

    const expressions = evaluateBodies.map((entry) =>
      String((JSON.parse(entry) as { expression?: string }).expression ?? ""),
    );
    assert.ok(
      expressions.some((expression) => /targetStorage\.setItem/.test(expression)),
    );
    assert.ok(
      expressions.some((expression) => /const storageKind = "session"/.test(expression)),
    );
    assert.deepEqual(cookieRequests, [
      {
        method: "GET",
        path: "/api/v1/browser/cookies?url=https%3A%2F%2Fexample.com%2Faccount",
        body: "",
      },
      {
        method: "POST",
        path: "/api/v1/browser/cookies",
        body: JSON.stringify({
          url: "https://example.com/account",
          name: "sid",
          value: "fresh",
          secure: true,
          http_only: true,
          same_site: "lax",
          expiration_date: 1800000000,
        }),
      },
    ]);
  } finally {
    await browserServer.close();
  }
});

test("desktop browser tool service rejects unknown tools", async () => {
  const service = new DesktopBrowserToolService({
    resolveConfig: () => ({
      authToken: "",
      userId: "",
      sandboxId: "",
      modelProxyBaseUrl: "",
      defaultModel: "openai/gpt-5.4",
      runtimeMode: "oss",
      defaultProvider: "",
      holabossEnabled: false,
      desktopBrowserEnabled: true,
      desktopBrowserUrl: "http://127.0.0.1:9/api/v1/browser",
      desktopBrowserAuthToken: "browser-token",
      configPath: "/tmp/runtime-config.json",
      loadedFromFile: true
    })
  });

  await assert.rejects(
    service.execute("browser_not_real", {}),
    (error: unknown) =>
      error instanceof DesktopBrowserToolServiceError &&
      error.statusCode === 404 &&
      error.code === "browser_tool_unknown"
  );
});
