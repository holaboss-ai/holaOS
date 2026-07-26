import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WecomConnector, validateWecomCredentials } from "./wecom.js";

const baseConfig = {
  platform: "wecom" as const,
  connectionId: "c1",
  enabled: true,
  workspaceId: "w",
  appId: "bot-123",
  appSecret: "secret-xyz",
};

test("WecomConnector exposes WeCom capabilities (markdown, no reactions/typing)", () => {
  const connector = new WecomConnector({ config: baseConfig });
  assert.equal(connector.platform, "wecom");
  assert.equal(connector.capabilities.markdown, "markdown");
  assert.equal(connector.capabilities.reactions, false);
  assert.equal(connector.capabilities.typing, false);
  assert.equal(connector.capabilities.media.image, true);
});

test("WecomConnector requires a BotID + Secret", () => {
  assert.throws(
    () =>
      new WecomConnector({
        config: { platform: "wecom", connectionId: "c1", enabled: true, workspaceId: "w", appId: "bot-123" },
      }),
    /BotID \+ Secret/,
  );
});

test("WecomConnector.format passes Markdown through unchanged", () => {
  const connector = new WecomConnector({ config: baseConfig });
  assert.equal(connector.format("**bold** [x](https://y.io)"), "**bold** [x](https://y.io)");
});

test("WecomConnector fingerprint changes with credentials", () => {
  const fp = (appId: string, appSecret: string) =>
    new WecomConnector({ config: { ...baseConfig, appId, appSecret } }).fingerprint();
  assert.equal(fp("a", "b"), fp("a", "b"));
  assert.notEqual(fp("a", "b"), fp("a", "c"));
  assert.notEqual(fp("a", "b"), fp("z", "b"));
});

test("validateWecomCredentials rejects empty input without connecting", async () => {
  const result = await validateWecomCredentials("", "");
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /required/i);
});

test("WecomConnector.sendText replies with the ORIGINAL frame (SDK reads frame.headers.req_id)", async () => {
  // Regression: sendText used to pass `frame.headers` instead of the whole frame, so the
  // SDK's replyStream(frame) computed `frame.headers.req_id` on a headers object → empty
  // req_id → WeCom rejected the reply with 846605 "invalid req_id" (inbound worked, the
  // agent's answer never reached WeCom). Assert the full frame is handed to replyStream.
  const replyCalls: Array<{
    frame: { headers?: { req_id?: string } };
    streamId: string;
    content: string;
    finish?: boolean;
  }> = [];
  const captured: { message: ((frame: unknown) => void) | null } = {
    message: null,
  };

  const fakeClient = {
    isConnected: true,
    connect() {
      return this;
    },
    disconnect() {},
    on(event: string, handler: (...args: unknown[]) => void) {
      if (event === "message") captured.message = handler as (frame: unknown) => void;
      return this;
    },
    async replyStream(frame: { headers?: { req_id?: string } }, streamId: string, content: string, finish?: boolean) {
      replyCalls.push({ frame, streamId, content, finish });
      return {};
    },
    async downloadFile() {
      return { buffer: Buffer.alloc(0) };
    },
  };
  const fakeSdk = {
    WSClient: function WSClient() {
      return fakeClient;
    },
  };

  const connector = new WecomConnector({
    config: baseConfig,
    sdk: fakeSdk,
  } as unknown as ConstructorParameters<typeof WecomConnector>[0]);
  connector.onMessage(async () => {});
  await connector.start();
  assert.ok(captured.message, "start() must register a message handler");

  // Simulate an inbound WeCom text-message callback frame (req_id in headers).
  captured.message({
    cmd: "aibot_msg_callback",
    headers: { req_id: "RID-123" },
    body: { msgid: "m1", chattype: "single", from: { userid: "U1" }, msgtype: "text", text: { content: "hi" } },
  });
  await new Promise((resolve) => setImmediate(resolve)); // flush the fire-and-forget #onMessage

  // Inbound opens the streamed reply immediately with a placeholder (finish=false).
  assert.equal(replyCalls.length, 1, "inbound should send an immediate ack frame");
  assert.equal(replyCalls[0].finish, false);
  assert.equal(replyCalls[0].frame.headers?.req_id, "RID-123");
  const ackStreamId = replyCalls[0].streamId;

  const res = await connector.sendText({ chatId: "U1" }, "the reply");
  assert.equal(res.ok, true, res.error);
  assert.equal(replyCalls.length, 2);
  // The answer FINISHES the same stream the ack opened — same streamId, whole frame
  // (so headers.req_id is reachable, not empty), finish=true.
  assert.equal(replyCalls[1].frame.headers?.req_id, "RID-123");
  assert.equal(replyCalls[1].streamId, ackStreamId, "answer must finish the ack's stream");
  assert.equal(replyCalls[1].content, "the reply");
  assert.equal(replyCalls[1].finish, true);
});

test("WecomConnector.sendMedia uploads the file then pushes it proactively by chatId", async () => {
  const uploads: Array<{ size: number; type: string; filename: string }> = [];
  const sends: Array<{ chatid: string; mediaType: string; mediaId: string }> = [];

  const fakeClient = {
    isConnected: true,
    connect() {
      return this;
    },
    disconnect() {},
    on() {
      return this;
    },
    async replyStream() {
      return {};
    },
    async downloadFile() {
      return { buffer: Buffer.alloc(0) };
    },
    async uploadMedia(buffer: Buffer, options: { type: string; filename: string }) {
      uploads.push({ size: buffer.length, type: options.type, filename: options.filename });
      return { media_id: "MID-9" };
    },
    async sendMediaMessage(chatid: string, mediaType: string, mediaId: string) {
      sends.push({ chatid, mediaType, mediaId });
      return {};
    },
  };
  const fakeSdk = {
    WSClient: function WSClient() {
      return fakeClient;
    },
  };

  const connector = new WecomConnector({
    config: baseConfig,
    sdk: fakeSdk,
  } as unknown as ConstructorParameters<typeof WecomConnector>[0]);
  connector.onMessage(async () => {});
  await connector.start();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-wecom-media-"));
  const filePath = path.join(dir, "cat.png");
  fs.writeFileSync(filePath, Buffer.from([1, 2, 3, 4]));
  try {
    const res = await connector.sendMedia({ chatId: "U1" }, { kind: "image", path: filePath, name: "cat.png" });
    assert.equal(res.ok, true, res.error);
    // Uploaded the exact bytes as an "image" temp material…
    assert.deepEqual(uploads, [{ size: 4, type: "image", filename: "cat.png" }]);
    // …then pushed it proactively to the chat by id (not via the spent inbound frame).
    assert.deepEqual(sends, [{ chatid: "U1", mediaType: "image", mediaId: "MID-9" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("WecomConnector streaming: createStreamMessage/editText drive ONE cumulative stream, finalized", async () => {
  const frames: Array<{ blocking: boolean; streamId: string; content: string; finish?: boolean }> = [];
  const captured: { message: ((frame: unknown) => void) | null } = {
    message: null,
  };

  const fakeClient = {
    isConnected: true,
    connect() {
      return this;
    },
    disconnect() {},
    on(event: string, handler: (...args: unknown[]) => void) {
      if (event === "message") captured.message = handler as (frame: unknown) => void;
      return this;
    },
    async replyStream(_f: unknown, streamId: string, content: string, finish?: boolean) {
      frames.push({ blocking: true, streamId, content, finish });
      return {};
    },
    async replyStreamNonBlocking(_f: unknown, streamId: string, content: string, finish?: boolean) {
      frames.push({ blocking: false, streamId, content, finish });
      return {};
    },
    async downloadFile() {
      return { buffer: Buffer.alloc(0) };
    },
  };
  const fakeSdk = {
    WSClient: function WSClient() {
      return fakeClient;
    },
  };

  const connector = new WecomConnector({
    config: baseConfig,
    sdk: fakeSdk,
  } as unknown as ConstructorParameters<typeof WecomConnector>[0]);
  connector.onMessage(async () => {});
  await connector.start();
  captured.message?.({
    cmd: "aibot_msg_callback",
    headers: { req_id: "RID-7" },
    body: { msgid: "m1", chattype: "single", from: { userid: "U1" }, msgtype: "text", text: { content: "hi" } },
  });
  await new Promise((resolve) => setImmediate(resolve)); // flush the immediate-ack frame

  // Egress opens the stream (reusing the ack's streamId), streams cumulative text, finalizes.
  const opened = await connector.createStreamMessage?.({ chatId: "U1" }, "Hel");
  assert.equal(opened?.ok, true);
  const streamId = opened?.messageId;
  assert.ok(streamId, "createStreamMessage returns the streamId");
  await connector.editText?.({ chatId: "U1" }, streamId as string, "Hello");
  await connector.editText?.({ chatId: "U1" }, streamId as string, "Hello world", { finalize: true });

  // Every frame shares one streamId (== the ack's), so WeCom sees a single reply.
  const ids = new Set(frames.map((f) => f.streamId));
  assert.equal(ids.size, 1, `all frames share one streamId, got ${[...ids].join(",")}`);
  assert.equal([...ids][0], streamId);
  // Intermediate edits are non-blocking (self-skip); the final frame is blocking + finish=true.
  const last = frames.at(-1);
  assert.equal(last?.blocking, true);
  assert.equal(last?.finish, true);
  assert.equal(last?.content, "Hello world");
  assert.ok(
    frames.slice(1, -1).every((f) => f.blocking === false && f.finish === false),
    "intermediate content frames are non-blocking, finish=false",
  );
});

test("WecomConnector welcomes on enter_chat (event.enter_chat → replyWelcome)", async () => {
  const welcomeCalls: Array<{ body: { msgtype?: string; text?: { content?: string } } }> = [];
  const handlers = new Map<string, (frame: unknown) => void>();

  const fakeClient = {
    isConnected: true,
    connect() {
      return this;
    },
    disconnect() {},
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, handler as (frame: unknown) => void);
      return this;
    },
    async replyStream() {
      return {};
    },
    async replyStreamNonBlocking() {
      return {};
    },
    async replyWelcome(_frame: unknown, body: { msgtype?: string; text?: { content?: string } }) {
      welcomeCalls.push({ body });
      return {};
    },
    async downloadFile() {
      return { buffer: Buffer.alloc(0) };
    },
  };
  const fakeSdk = {
    WSClient: function WSClient() {
      return fakeClient;
    },
  };

  const connector = new WecomConnector({
    config: baseConfig,
    sdk: fakeSdk,
  } as unknown as ConstructorParameters<typeof WecomConnector>[0]);
  connector.onMessage(async () => {});
  await connector.start();

  const enter = handlers.get("event.enter_chat");
  assert.ok(enter, "start() must register an enter_chat handler");
  enter?.({ headers: { req_id: "E1" }, body: { from: { userid: "U1" } } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(welcomeCalls.length, 1);
  assert.equal(welcomeCalls[0].body.msgtype, "text");
  assert.match(welcomeCalls[0].body.text?.content ?? "", /Hola assistant/);
});
