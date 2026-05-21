import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCallToolHandler,
  decodeComposioMcpHostCliRequest,
  decodeComposioMcpToolCatalog,
  type ComposioMcpToolEntry,
} from "./composio-mcp-host.js";
import {
  ComposioService,
  ComposioToolExecutionError,
} from "./composio-service.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

function toBase64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

const SAMPLE_GMAIL_TOOL: ComposioMcpToolEntry = {
  name: "composio_gmail_get_profile",
  description: "Fetch the authenticated Gmail user's profile.",
  toolkit_slug: "gmail",
  tool_slug: "GMAIL_GET_PROFILE",
  connected_account_id: "ca_4vYjam9qHD46",
  input_schema: {
    type: "object",
    title: "GmailGetProfileRequest",
    properties: {
      user_id: { type: "string", default: "me" },
    },
  },
};

test("decodeComposioMcpHostCliRequest parses a well-formed base64 payload", () => {
  const encoded = Buffer.from(
    JSON.stringify({
      host: "127.0.0.1",
      port: 13150,
      server_name: "holaboss_composio",
      hono_base_url: "https://app.holaboss.test",
      auth_cookie: "hb_session=abc",
      tools_json_base64: toBase64([]),
    }),
    "utf8",
  ).toString("base64");

  const decoded = decodeComposioMcpHostCliRequest(encoded);
  assert.equal(decoded.host, "127.0.0.1");
  assert.equal(decoded.port, 13150);
  assert.equal(decoded.server_name, "holaboss_composio");
});

test("decodeComposioMcpHostCliRequest rejects missing required fields", () => {
  const encoded = Buffer.from(
    JSON.stringify({ host: "127.0.0.1", port: 13150 }),
    "utf8",
  ).toString("base64");
  assert.throws(() => decodeComposioMcpHostCliRequest(encoded), /hono_base_url is required/);
});

test("decodeComposioMcpToolCatalog returns [] for an empty payload", () => {
  assert.deepEqual(decodeComposioMcpToolCatalog(""), []);
});

test("decodeComposioMcpToolCatalog hydrates a one-tool catalog", () => {
  const catalog = decodeComposioMcpToolCatalog(toBase64([SAMPLE_GMAIL_TOOL]));
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]?.name, "composio_gmail_get_profile");
  assert.equal(catalog[0]?.tool_slug, "GMAIL_GET_PROFILE");
});

test("buildCallToolHandler routes a known tool to ComposioService.executeTool with peeled result", async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return jsonResponse({
      ok: true,
      data: { emailAddress: "tommy@holaboss.ai", messagesTotal: 626 },
      log_id: "log_-Ttzl7Tql0Y3",
    });
  };
  const composio = new ComposioService({
    honoBaseUrl: "https://app.holaboss.test",
    authCookie: "hb_session=abc",
    fetchImpl,
  });
  const handle = buildCallToolHandler([SAMPLE_GMAIL_TOOL], composio);

  const result = (await handle("composio_gmail_get_profile", {})) as {
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
    isError?: boolean;
  };

  assert.equal(result.isError ?? false, false);
  assert.equal(result.content[0]?.type, "text");
  assert.match(result.content[0]?.text ?? "", /tommy@holaboss.ai/);
  assert.equal(
    (result.structuredContent as { emailAddress?: string })?.emailAddress,
    "tommy@holaboss.ai",
  );
  assert.equal(result._meta?.composio_log_id, "log_-Ttzl7Tql0Y3");

  assert.equal(calls.length, 1);
  const body = JSON.parse(String(calls[0]?.init?.body));
  assert.deepEqual(body, {
    tool_slug: "GMAIL_GET_PROFILE",
    connected_account_id: "ca_4vYjam9qHD46",
    arguments: {},
  });
});

test("buildCallToolHandler surfaces unknown tool as isError result, not throw", async () => {
  const composio = new ComposioService({
    honoBaseUrl: "https://app.holaboss.test",
    authCookie: "hb_session=abc",
    fetchImpl: async () => {
      throw new Error("should not be called");
    },
  });
  const handle = buildCallToolHandler([SAMPLE_GMAIL_TOOL], composio);

  const result = (await handle("composio_unknown_tool", {})) as {
    content: Array<{ type: string; text: string }>;
    isError: boolean;
  };
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /Unknown Composio tool/);
});

test("buildCallToolHandler maps ComposioToolExecutionError to structured isError + user_action", async () => {
  const fetchImpl: typeof fetch = async () =>
    jsonResponse(
      {
        ok: false,
        error: {
          code: "connection_expired",
          message: "Connected account is no longer authorized",
          slug: "CONNECTED_ACCOUNT_NOT_ACTIVE",
          connected_account_id: "ca_4vYjam9qHD46",
          user_action: "reconnect",
        },
      },
      { status: 401 },
    );
  const composio = new ComposioService({
    honoBaseUrl: "https://app.holaboss.test",
    authCookie: "hb_session=abc",
    fetchImpl,
  });
  const handle = buildCallToolHandler([SAMPLE_GMAIL_TOOL], composio);

  const result = (await handle("composio_gmail_get_profile", {})) as {
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError: boolean;
  };
  assert.equal(result.isError, true);
  const structured = result.structuredContent as {
    error?: { code?: string; user_action?: string };
    http_status?: number;
  };
  assert.equal(structured.error?.code, "connection_expired");
  assert.equal(structured.error?.user_action, "reconnect");
  assert.equal(structured.http_status, 401);
});

test("buildCallToolHandler forwards tool arguments to ComposioService", async () => {
  let captured: Record<string, unknown> | null = null;
  const fetchImpl: typeof fetch = async (_input, init) => {
    captured = JSON.parse(String(init?.body));
    return jsonResponse({ ok: true, data: { items: [] }, log_id: "log_1" });
  };
  const composio = new ComposioService({
    honoBaseUrl: "https://app.holaboss.test",
    authCookie: "hb_session=abc",
    fetchImpl,
  });
  const handle = buildCallToolHandler(
    [{ ...SAMPLE_GMAIL_TOOL, tool_slug: "GMAIL_FETCH_EMAILS", name: "composio_gmail_fetch_emails" }],
    composio,
  );

  await handle("composio_gmail_fetch_emails", { max_results: 3, query: "is:unread" });

  assert.deepEqual(captured, {
    tool_slug: "GMAIL_FETCH_EMAILS",
    connected_account_id: "ca_4vYjam9qHD46",
    arguments: { max_results: 3, query: "is:unread" },
  });
});

// Use the imported error class to keep type-only imports from being flagged
void ComposioToolExecutionError;
