import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChannelConnectionConfig } from "../config.js";
import { DingTalkConnector } from "./dingtalk.js";

function makeConfig(extra?: Record<string, unknown>): ChannelConnectionConfig {
  return {
    platform: "dingtalk",
    connectionId: "default",
    enabled: true,
    workspaceId: "w1",
    appId: "clientId",
    appSecret: "secret",
    extra,
  };
}

test("dingtalk: editMessages gates on a configured AI Card template", () => {
  const withCard = new DingTalkConnector({ config: makeConfig({ cardTemplateId: "tmpl-1" }) });
  assert.equal(withCard.capabilities.editMessages, true);

  const withoutCard = new DingTalkConnector({ config: makeConfig() });
  assert.equal(withoutCard.capabilities.editMessages, false);
});

test("dingtalk: editText streams a finalize update to the card streaming API", async () => {
  const connector = new DingTalkConnector({ config: makeConfig({ cardTemplateId: "tmpl-1" }) });
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> | undefined }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body });
    if (url.includes("/oauth2/accessToken")) {
      return new Response(JSON.stringify({ accessToken: "tok", expireIn: 7200 }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch;

  try {
    const res = await connector.editText({ chatId: "c1" }, "otid-9", "final answer", {
      finalize: true,
    });
    assert.equal(res.ok, true);

    const stream = calls.find((c) => c.url.includes("/v1.0/card/streaming"));
    assert.ok(stream, "the streaming endpoint was called");
    assert.equal(stream!.method, "PUT");
    assert.equal(stream!.body?.outTrackId, "otid-9");
    assert.equal(stream!.body?.content, "final answer");
    assert.equal(stream!.body?.key, "content");
    assert.equal(stream!.body?.isFull, true);
    assert.equal(stream!.body?.isFinalize, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("dingtalk: createStreamMessage without inbound delivery context falls back", async () => {
  const connector = new DingTalkConnector({ config: makeConfig({ cardTemplateId: "tmpl-1" }) });
  // No inbound frame has been seen, so there is no chat context for "c1" — the
  // connector must report failure so egress can use the buffer-final path.
  const res = await connector.createStreamMessage({ chatId: "c1" }, "hi");
  assert.equal(res.ok, false);
});
