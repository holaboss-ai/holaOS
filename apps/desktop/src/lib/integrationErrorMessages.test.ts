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
