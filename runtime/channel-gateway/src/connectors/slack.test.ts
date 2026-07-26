import test from "node:test";
import assert from "node:assert/strict";

import { SlackConnector, validateSlackTokens } from "./slack.js";
import { markdownToSlack } from "../format/slack.js";

test("markdownToSlack converts to mrkdwn (bold/italic/links/headings)", () => {
  assert.equal(markdownToSlack("**bold**"), "*bold*");
  assert.equal(markdownToSlack("*italic*"), "_italic_");
  assert.equal(markdownToSlack("__also bold__"), "*also bold*");
  assert.equal(
    markdownToSlack("[Holaboss](https://holaboss.ai)"),
    "<https://holaboss.ai|Holaboss>",
  );
  assert.equal(markdownToSlack("# Heading"), "*Heading*");
  assert.equal(markdownToSlack("~~gone~~"), "~gone~");
});

test("markdownToSlack leaves code spans and fences untouched", () => {
  // The * inside the code span must NOT become italic.
  assert.equal(markdownToSlack("use `a*b*c` here"), "use `a*b*c` here");
  assert.equal(markdownToSlack("```\n**not bold**\n```"), "```\n**not bold**\n```");
});

test("markdownToSlack handles bold and italic together without corruption", () => {
  assert.equal(markdownToSlack("**b** and *i*"), "*b* and _i_");
});

test("SlackConnector exposes Slack capabilities + reaction names", () => {
  const connector = new SlackConnector({
    config: {
      platform: "slack",
      connectionId: "c1",
      enabled: true,
      token: "xoxb-1",
      appToken: "xapp-1",
      workspaceId: "w",
    },
  });
  assert.equal(connector.platform, "slack");
  assert.equal(connector.capabilities.markdown, "mrkdwn");
  assert.equal(connector.capabilities.typing, false);
  assert.equal(connector.capabilities.reactions, true);
  assert.deepEqual(connector.ackEmojis, {
    received: "eyes",
    done: "white_check_mark",
    failed: "x",
  });
});

test("SlackConnector requires both a bot token and an app token", () => {
  assert.throws(
    () =>
      new SlackConnector({
        config: { platform: "slack", connectionId: "c1", enabled: true, token: "xoxb-1", workspaceId: "w" },
      }),
    /app-level token/,
  );
});

test("validateSlackTokens succeeds only when both tokens are accepted", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/auth.test")) {
      return new Response(JSON.stringify({ ok: true, user: "agent", team: "Acme" }), { status: 200 });
    }
    // apps.connections.open
    return new Response(JSON.stringify({ ok: true, url: "wss://x" }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await validateSlackTokens("xoxb-good", "xapp-good");
    assert.equal(result.ok, true);
    assert.equal(result.botName, "agent");
    assert.equal(result.teamName, "Acme");
  } finally {
    globalThis.fetch = original;
  }
});

test("validateSlackTokens reports which token was rejected", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/auth.test")) return new Response(JSON.stringify({ ok: true, user: "a" }), { status: 200 });
    return new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await validateSlackTokens("xoxb-good", "xapp-bad");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /App-level token rejected/);
  } finally {
    globalThis.fetch = original;
  }
});
