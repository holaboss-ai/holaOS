import { test } from "node:test";
import assert from "node:assert/strict";

import type { IncomingMessage } from "./connector.js";
import { deriveSessionId, sessionIdForMessage } from "./session-key.js";

test("dm key omits the thread suffix", () => {
  assert.equal(
    deriveSessionId({ platform: "telegram", chatType: "dm", chatId: "12345" }),
    "im:telegram:dm:12345",
  );
});

test("group key is shared per chat — no per-user segment", () => {
  assert.equal(
    deriveSessionId({ platform: "telegram", chatType: "group", chatId: "-1001" }),
    "im:telegram:group:-1001",
  );
});

test("thread id isolates a thread into its own session", () => {
  assert.equal(
    deriveSessionId({ platform: "telegram", chatType: "group", chatId: "-1001", threadId: "7" }),
    "im:telegram:group:-1001:thread:7",
  );
});

test("blank thread id is ignored", () => {
  assert.equal(
    deriveSessionId({ platform: "slack", chatType: "channel", chatId: "C1", threadId: "   " }),
    "im:slack:channel:C1",
  );
});

test("derivation is deterministic for the same conversation", () => {
  const parts = { platform: "discord" as const, chatType: "dm" as const, chatId: "9" };
  assert.equal(deriveSessionId(parts), deriveSessionId(parts));
});

test("sessionIdForMessage matches deriveSessionId", () => {
  const msg: IncomingMessage = {
    platform: "telegram",
    connectionId: "default",
    workspaceId: "w1",
    chatId: "12345",
    chatType: "dm",
    userId: "u1",
    text: "hi",
    attachments: [],
  };
  assert.equal(sessionIdForMessage(msg), "im:telegram:dm:12345");
});
