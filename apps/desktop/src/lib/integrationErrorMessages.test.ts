import assert from "node:assert/strict";
import test from "node:test";

import { resolveIntegrationError } from "./integrationErrorMessages.js";

test("recognises IntegrationConnectCancelled as silent", () => {
  const err = Object.assign(new Error("Integration connect cancelled by user"), {
    name: "IntegrationConnectCancelled",
  });
  const copy = resolveIntegrationError({ provider: "Gmail", error: err });
  assert.equal(copy.action, "silent");
  assert.equal(copy.headline, "");
});

test("timeout maps to retry with provider in copy", () => {
  const copy = resolveIntegrationError({
    provider: "Gmail",
    error: new Error("Connection to gmail timed out after 300s. Please try again."),
  });
  assert.equal(copy.action, "retry");
  assert.match(copy.headline, /Gmail/);
});

test("composio marker code overrides text heuristics", () => {
  const copy = resolveIntegrationError({
    provider: "Gmail",
    error: new Error(
      "[composio_error:connection_expired:gmail] Connected account is no longer authorized",
    ),
  });
  assert.equal(copy.action, "reconnect");
  assert.match(copy.headline, /Gmail session expired/);
});

test("rate-limit phrase maps to retry", () => {
  const copy = resolveIntegrationError({
    provider: "Twitter",
    error: new Error("Twitter rate limit exceeded — try later."),
  });
  assert.equal(copy.action, "retry");
  assert.match(copy.headline, /Twitter is busy/);
});

test("unknown error returns a generic but provider-aware retry copy", () => {
  const copy = resolveIntegrationError({
    provider: "Notion",
    error: new Error("eldritch failure"),
  });
  assert.equal(copy.action, "retry");
  assert.match(copy.detail, /eldritch failure/);
});

test("explicit code wins over inference", () => {
  const copy = resolveIntegrationError({
    provider: "Gmail",
    code: "popup_blocked",
    error: new Error("anything"),
  });
  assert.equal(copy.action, "reopen");
});

test("Composio API 500 maps to server_error with retry", () => {
  const copy = resolveIntegrationError({
    provider: "Gmail",
    error: new Error("Composio API error (500): Internal Server Error"),
  });
  assert.equal(copy.action, "retry");
  assert.match(copy.headline, /Couldn't reach Gmail/);
  // The raw status line must not leak into the user-facing copy.
  assert.doesNotMatch(copy.detail, /Internal Server Error/);
  assert.doesNotMatch(copy.detail, /500/);
});

test("plain 502 / 503 / 504 messages also map to server_error", () => {
  for (const message of [
    "502 Bad Gateway",
    "503 Service Unavailable",
    "504 Gateway Timeout",
  ]) {
    const copy = resolveIntegrationError({
      provider: "Notion",
      error: new Error(message),
    });
    assert.equal(copy.action, "retry", `expected retry for: ${message}`);
    assert.match(copy.headline, /Notion/);
  }
});

test("strips Electron IPC wrapper from underlying error", () => {
  const copy = resolveIntegrationError({
    provider: "Gmail",
    error: new Error(
      "Error invoking remote method 'workspace:composioConnect': Error: Composio API error (500): Internal Server Error",
    ),
  });
  // Should classify as server_error via the unwrapped inner message.
  assert.equal(copy.action, "retry");
  assert.match(copy.headline, /Couldn't reach Gmail/);
  // The IPC plumbing prefix must not leak into the copy.
  assert.doesNotMatch(copy.detail, /Error invoking remote method/);
  assert.doesNotMatch(copy.detail, /workspace:composioConnect/);
});

test("IPC wrapper around unknown inner error preserves the inner text", () => {
  const copy = resolveIntegrationError({
    provider: "Notion",
    error: new Error(
      "Error invoking remote method 'workspace:foo': Error: eldritch failure",
    ),
  });
  assert.equal(copy.action, "retry");
  assert.match(copy.detail, /eldritch failure/);
  assert.doesNotMatch(copy.detail, /Error invoking remote method/);
});

test("a toolkit with no Composio-managed auth asks for the user's own key", () => {
  const copy = resolveIntegrationError({
    provider: "Pinecone",
    error: new Error(
      'Composio API error (400): {"error":{"message":"Default auth config not found for toolkit \\"pinecone\\". Composio does not have managed credentials for this toolkit.","code":306,"slug":"Auth_Config_DefaultAuthConfigNotFound","status":400}}',
    ),
  });
  assert.equal(copy.action, "reconnect");
  assert.match(copy.headline, /Pinecone needs your own API key/);
  // The raw Composio payload must not leak into the user-facing copy.
  assert.doesNotMatch(copy.detail, /auth_config/i);
  assert.doesNotMatch(copy.detail, /Auth_Config_DefaultAuthConfigNotFound/);
});
