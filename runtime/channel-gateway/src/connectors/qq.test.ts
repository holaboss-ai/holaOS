import test from "node:test";
import assert from "node:assert/strict";

import { QQConnector, qqRouteFor, validateQQCredentials } from "./qq.js";

test("qqRouteFor classifies group / guild / private chats", () => {
  assert.deepEqual(qqRouteFor({ group_id: "g1", user_id: "u1" }), { kind: "group", chatId: "g1" });
  assert.deepEqual(qqRouteFor({ channel_id: "c1", user_id: "u1" }), { kind: "guild", chatId: "c1" });
  assert.deepEqual(qqRouteFor({ user_id: "u1" }), { kind: "private", chatId: "u1" });
  // Group takes precedence over a channel id when both are present.
  assert.deepEqual(qqRouteFor({ group_id: "g1", channel_id: "c1", user_id: "u1" }), {
    kind: "group",
    chatId: "g1",
  });
});

test("QQConnector has no reactions/typing but provides a working-text ack", () => {
  const connector = new QQConnector({
    config: {
      platform: "qq",
      connectionId: "c1",
      enabled: true,
      appId: "1234",
      appSecret: "secret",
      workspaceId: "w",
    },
  });
  assert.equal(connector.platform, "qq");
  assert.equal(connector.capabilities.reactions, false);
  assert.equal(connector.capabilities.typing, false);
  assert.equal(connector.capabilities.markdown, "none");
  assert.equal(typeof connector.workingText, "string");
  assert.ok((connector.workingText ?? "").length > 0);
});

test("QQConnector requires appId + appSecret", () => {
  assert.throws(
    () =>
      new QQConnector({
        config: { platform: "qq", connectionId: "c1", enabled: true, appId: "1234", workspaceId: "w" },
      }),
    /appId \+ appSecret/,
  );
});

test("validateQQCredentials succeeds when an access token is granted", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ access_token: "tok", expires_in: 7200 }), {
      status: 200,
    })) as typeof fetch;
  try {
    const result = await validateQQCredentials("1234", "secret");
    assert.equal(result.ok, true);
  } finally {
    globalThis.fetch = original;
  }
});

test("validateQQCredentials reports the platform error message", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ code: 100007, message: "appid invalid" }), {
      status: 200,
    })) as typeof fetch;
  try {
    const result = await validateQQCredentials("bad", "secret");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /appid invalid/);
  } finally {
    globalThis.fetch = original;
  }
});
