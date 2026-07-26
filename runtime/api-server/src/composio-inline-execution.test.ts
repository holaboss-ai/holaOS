import assert from "node:assert/strict";
import test from "node:test";

import { ComposioToolExecutionError, ComposioService } from "./composio-service.js";
import {
  executeComposioInlineTool,
  isComposioAuthFailure,
} from "./composio-inline-execution.js";

function makeComposio(fetchImpl: typeof fetch): ComposioService {
  return new ComposioService({
    honoBaseUrl: "https://app.holaboss.test",
    authCookie: "hb_session=abc",
    fetchImpl,
  });
}

test("executeComposioInlineTool returns ok=true with data on a successful response", async () => {
  const composio = makeComposio(async () =>
    new Response(JSON.stringify({ ok: true, data: { hello: "world" }, log_id: "log-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const result = await executeComposioInlineTool({
    composio,
    toolkitSlug: "notion",
    toolSlug: "NOTION_FETCH_DATA",
    connectedAccountId: "ca_user",
    arguments: { query: "test" },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { hello: "world" });
  assert.equal(result.log_id, "log-1");
});

test("executeComposioInlineTool wraps ComposioToolExecutionError into the [composio_error:...] marker", async () => {
  const composio = makeComposio(async () =>
    new Response(
      JSON.stringify({
        ok: false,
        error: { code: "forbidden", message: "Missing scope X" },
      }),
      {
        status: 403,
        headers: { "content-type": "application/json" },
      },
    ),
  );
  const result = await executeComposioInlineTool({
    composio,
    toolkitSlug: "gmail",
    toolSlug: "GMAIL_FETCH_EMAILS",
    connectedAccountId: "ca_user",
    arguments: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "forbidden");
  assert.equal(result.error?.http_status, 403);
  assert.equal(
    result.error_marker,
    "[composio_error:forbidden:gmail] Missing scope X",
  );
});

test("executeComposioInlineTool captures the raw body of a non-JSON gateway 502", async () => {
  const composio = makeComposio(async () =>
    new Response("<html><body>502 Bad Gateway</body></html>", {
      status: 502,
      headers: {
        "content-type": "text/html",
        "cf-ray": "8f2a1b3c4d5e6f70-SJC",
        server: "cloudflare",
      },
    }),
  );
  const result = await executeComposioInlineTool({
    composio,
    toolkitSlug: "linkedin",
    toolSlug: "LINKEDIN_CREATE_LINKED_IN_POST",
    connectedAccountId: "ca_user",
    arguments: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "unknown_error");
  assert.equal(result.error?.http_status, 502);
  assert.equal(result.error?.message, "HTTP 502");
  // The raw gateway body + cf-ray/server are kept for the failure log so the
  // Cloudflare edge failure can be correlated (agent marker stays clean).
  assert.match(result.error?.response_body ?? "", /502 Bad Gateway/);
  assert.equal(result.error?.cf_ray, "8f2a1b3c4d5e6f70-SJC");
  assert.equal(result.error?.origin_server, "cloudflare");
  assert.equal(
    result.error_marker,
    "[composio_error:unknown_error:linkedin] HTTP 502",
  );
});

test("executeComposioInlineTool flags transport-level failures with unknown_error marker", async () => {
  const composio = makeComposio(async () => {
    throw new Error("network blew up");
  });
  const result = await executeComposioInlineTool({
    composio,
    toolkitSlug: "twitter",
    toolSlug: "TWITTER_FETCH_TWEETS",
    connectedAccountId: "ca_user",
    arguments: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "unknown_error");
  assert.match(result.error_marker ?? "", /\[composio_error:unknown_error:twitter\] network blew up/);
});

test("ComposioToolExecutionError default code falls through to unknown_error", async () => {
  const error = new ComposioToolExecutionError(500, {
    code: "",
    message: "boom",
  });
  assert.equal(error.detail.code, "");
  assert.equal(error.detail.message, "boom");
});

test("isComposioAuthFailure catches the auth-failure cases and ignores transient / scope errors", () => {
  assert.equal(isComposioAuthFailure(401, "unauthorized"), true);
  assert.equal(isComposioAuthFailure(403, "forbidden"), true);
  assert.equal(isComposioAuthFailure(403, "FORBIDDEN"), true);
  assert.equal(isComposioAuthFailure(403, "auth_expired"), true);
  assert.equal(isComposioAuthFailure(403, "token_expired"), true);
  assert.equal(isComposioAuthFailure(403, "invalid_credentials"), true);
  assert.equal(isComposioAuthFailure(403, "expired_credentials"), true);
  // Scope errors don't imply revoked credentials.
  assert.equal(isComposioAuthFailure(403, "insufficient_scope"), false);
  // Generic 4xx not in the auth-failure set.
  assert.equal(isComposioAuthFailure(400, "bad_request"), false);
  assert.equal(isComposioAuthFailure(404, "not_found"), false);
  // Transient infra errors are never an auth failure.
  assert.equal(isComposioAuthFailure(500, "internal_error"), false);
  assert.equal(isComposioAuthFailure(502, "bad_gateway"), false);
  assert.equal(isComposioAuthFailure(503, "service_unavailable"), false);
});

test("executeComposioInlineTool flags auth_failure on a revoked/expired credential — without mutating any local state", async () => {
  const composio = makeComposio(async () =>
    new Response(
      JSON.stringify({
        ok: false,
        error: { code: "forbidden", message: "Notion auth revoked" },
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    ),
  );
  const result = await executeComposioInlineTool({
    composio,
    toolkitSlug: "notion",
    toolSlug: "NOTION_FETCH_DATA",
    connectedAccountId: "ca_user_stale",
    arguments: {},
  });
  assert.equal(result.ok, false);
  // Composio (remote) owns connection status — we only REPORT the auth failure
  // so the caller can invalidate caches / surface reconnect, never write status.
  assert.equal(result.auth_failure, true);
  assert.equal("marked_expired" in result, false);
});

test("executeComposioInlineTool does NOT flag auth_failure on a generic 500 error", async () => {
  const composio = makeComposio(async () =>
    new Response(
      JSON.stringify({
        ok: false,
        error: { code: "internal_error", message: "Composio is sad" },
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    ),
  );
  const result = await executeComposioInlineTool({
    composio,
    toolkitSlug: "notion",
    toolSlug: "NOTION_FETCH_DATA",
    connectedAccountId: "ca_user_fine",
    arguments: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.auth_failure, false);
});
