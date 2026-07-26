import test from "node:test";
import assert from "node:assert/strict";

import {
  DISCORD_INVITE_PERMISSIONS,
  DiscordConnector,
  discordInviteUrl,
  validateDiscordToken,
} from "./discord.js";
import { markdownToDiscord } from "../format/discord.js";

test("markdownToDiscord flattens markdown links Discord won't render", () => {
  assert.equal(
    markdownToDiscord("see [the docs](https://example.com/docs) now"),
    "see the docs (https://example.com/docs) now",
  );
  // A link whose label IS the url collapses to the bare url.
  assert.equal(
    markdownToDiscord("[https://x.io](https://x.io)"),
    "https://x.io",
  );
  // Other markdown (Discord renders these natively) passes through untouched.
  assert.equal(markdownToDiscord("**bold** `code`"), "**bold** `code`");
});

test("discordInviteUrl embeds the client id, scope, and minimal permissions", () => {
  const url = discordInviteUrl("123456789");
  assert.match(url, /client_id=123456789/);
  assert.match(url, /scope=bot/);
  assert.match(url, new RegExp(`permissions=${DISCORD_INVITE_PERMISSIONS}`));
});

test("DiscordConnector exposes Discord capabilities + ack emojis", () => {
  const connector = new DiscordConnector({
    config: { platform: "discord", connectionId: "c1", enabled: true, token: "t", workspaceId: "w" },
  });
  assert.equal(connector.platform, "discord");
  assert.equal(connector.capabilities.maxMessageLength, 2000);
  assert.equal(connector.capabilities.markdown, "discord");
  assert.equal(connector.capabilities.reactions, true);
  assert.equal(connector.capabilities.typing, true);
  assert.deepEqual(connector.ackEmojis, { received: "👀", done: "✅", failed: "❌" });
});

test("DiscordConnector fingerprint changes when config changes", () => {
  const make = (token: string, allow: string[]) =>
    new DiscordConnector({
      config: {
        platform: "discord",
        connectionId: "c1",
        enabled: true,
        token,
        workspaceId: "w",
        allowFrom: allow,
      },
    }).fingerprint();
  assert.equal(make("t", []), make("t", []));
  assert.notEqual(make("t", []), make("t2", []));
  assert.notEqual(make("t", []), make("t", ["alice"]));
});

test("validateDiscordToken returns username + invite url on success", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ id: "987654321", username: "agentbot" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const result = await validateDiscordToken("good-token");
    assert.equal(result.ok, true);
    assert.equal(result.username, "agentbot");
    assert.equal(result.botId, "987654321");
    assert.match(result.inviteUrl ?? "", /client_id=987654321/);
  } finally {
    globalThis.fetch = original;
  }
});

test("validateDiscordToken reports an error on a rejected token", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 401 })) as typeof fetch;
  try {
    const result = await validateDiscordToken("bad-token");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /401/);
  } finally {
    globalThis.fetch = original;
  }
});
