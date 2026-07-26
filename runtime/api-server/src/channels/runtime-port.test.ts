import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { IncomingMessage } from "@holaboss/runtime-channel-gateway";
import { RuntimeStateStore } from "@holaboss/runtime-state-store";
import { seedWorkspaceRecord } from "../__test-helpers__/seed-workspace.js";

import { createChannelRuntimePort } from "./runtime-port.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hb-channel-port-"));
}

function makeStore(root: string): RuntimeStateStore {
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  seedWorkspaceRecord(store, { workspaceId: "w1", name: "Test", harness: "pi", status: "active" });
  return store;
}

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platform: "telegram",
    connectionId: "default",
    workspaceId: "w1",
    chatId: "123",
    chatType: "dm",
    chatTitle: "Acme DM",
    userId: "u1",
    userName: "alice",
    text: "hello agent",
    messageId: "10",
    updateId: 100,
    attachments: [],
    ...overrides,
  };
}

test("fireMessage creates session + binding + conversation binding + queued input", () => {
  const root = makeTempDir();
  const store = makeStore(root);
  const port = createChannelRuntimePort(store);
  try {
    assert.equal(
      port.resolveWorkspaceId({ platform: "telegram", connectionId: "default" }),
      "root",
      "single-tenant canonical root fallback",
    );

    const message = makeMessage();
    const sessionId = "im:telegram:dm:123";
    const fired = port.fireMessage({ message, sessionId, idempotencyKey: "k1" });
    assert.equal(fired.created, true);
    assert.equal(fired.sessionId, sessionId);
    assert.ok(fired.inputId);

    const session = store.getSession({ workspaceId: "w1", sessionId });
    assert.ok(session, "session row exists");
    assert.equal(session!.createdBy, "im:telegram");
    assert.equal(session!.kind, "main_session");

    const binding = store.getBinding({ workspaceId: "w1", sessionId });
    assert.equal(binding!.harness, "pi");

    const convo = store.getConversationBindingByConversation({
      workspaceId: "w1",
      channel: "telegram",
      conversationKey: "123",
    });
    assert.ok(convo, "conversation binding exists");
    assert.equal(convo!.sessionId, sessionId);
    assert.equal(convo!.metadata.chat_id, "123");

    const queued = store.getInputByIdempotencyKey({ workspaceId: "w1", idempotencyKey: "k1" });
    assert.ok(queued, "input enqueued");
    // The persisted user message stays exactly what the user typed — channel
    // surface guidance is folded into the run INSTRUCTION by the executor's
    // platform hint, never into the visible transcript.
    assert.equal(queued!.payload.text, "hello agent");
    const context = queued!.payload.context as Record<string, unknown>;
    assert.equal(context.source, "im:telegram");
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fireMessage binds a new conversation to the connection's configured harness", () => {
  const root = makeTempDir();
  const store = makeStore(root);
  const port = createChannelRuntimePort(store);
  try {
    // Connections are keyed by the canonical (single-tenant root) workspace id,
    // which is what fireMessage → resolveChannelHarness looks them up under.
    const canonicalWorkspaceId = store.getWorkspace("w1")!.id;
    // Channel configured to run Claude Code (not the workspace default "pi").
    store.upsertChannelConnection({
      workspaceId: canonicalWorkspaceId,
      connectionId: "default",
      platform: "telegram",
      config: { harness: "claude-code" },
    });

    const sessionId = "im:telegram:dm:123";
    port.fireMessage({ message: makeMessage(), sessionId, idempotencyKey: "k1" });

    const binding = store.getBinding({ workspaceId: "w1", sessionId });
    assert.equal(binding!.harness, "claude-code");
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fireMessage stamps the connection's configured model onto the queued input (null when unset)", () => {
  const root = makeTempDir();
  const store = makeStore(root);
  const port = createChannelRuntimePort(store);
  try {
    const canonicalWorkspaceId = store.getWorkspace("w1")!.id;

    // No per-channel model → the queued input inherits the harness/workspace
    // default (model: null), which the claimed-input executor resolves downstream.
    port.fireMessage({
      message: makeMessage(),
      sessionId: "im:telegram:dm:1",
      idempotencyKey: "k0",
    });
    const inherited = store.getInputByIdempotencyKey({ workspaceId: "w1", idempotencyKey: "k0" });
    assert.equal(inherited!.payload.model, null, "no override → inherit the default");

    // Pin a model on the connection (as the desktop model picker does).
    store.upsertChannelConnection({
      workspaceId: canonicalWorkspaceId,
      connectionId: "default",
      platform: "telegram",
      config: { model: "anthropic/claude-opus-4-8" },
    });
    port.fireMessage({
      message: makeMessage({ chatId: "456", messageId: "11" }),
      sessionId: "im:telegram:dm:2",
      idempotencyKey: "k1",
    });
    const pinned = store.getInputByIdempotencyKey({ workspaceId: "w1", idempotencyKey: "k1" });
    assert.equal(
      pinned!.payload.model,
      "anthropic/claude-opus-4-8",
      "the per-channel model override flows into the run payload",
    );
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("switching a connection's harness rebinds the existing conversation on the next message", () => {
  const root = makeTempDir();
  const store = makeStore(root);
  const port = createChannelRuntimePort(store);
  try {
    const sessionId = "im:telegram:dm:123";

    // Conversation starts on Hola (no connection override → workspace default "pi").
    port.fireMessage({ message: makeMessage(), sessionId, idempotencyKey: "k1" });
    assert.equal(
      store.getBinding({ workspaceId: "w1", sessionId })!.harness,
      "pi",
    );

    // User switches the channel to Claude Code from the desktop. Connections
    // are keyed by the canonical (single-tenant root) workspace id.
    store.upsertChannelConnection({
      workspaceId: store.getWorkspace("w1")!.id,
      connectionId: "default",
      platform: "telegram",
      config: { harness: "claude-code" },
    });

    // The next inbound message re-binds the SAME conversation to the new
    // harness — the switch takes effect without a fresh chat.
    port.fireMessage({
      message: makeMessage({ messageId: "11" }),
      sessionId,
      idempotencyKey: "k2",
    });
    assert.equal(
      store.getBinding({ workspaceId: "w1", sessionId })!.harness,
      "claude-code",
    );

    // The session row's harness_id is immutable; the binding is the live
    // source of truth the claimed-input executor reads to pick the harness.
    assert.equal(
      store.getSession({ workspaceId: "w1", sessionId })!.harnessId,
      "pi",
    );
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fireMessage is idempotent on the idempotency key", () => {
  const root = makeTempDir();
  const store = makeStore(root);
  const port = createChannelRuntimePort(store);
  try {
    const message = makeMessage();
    const sessionId = "im:telegram:dm:123";
    const first = port.fireMessage({ message, sessionId, idempotencyKey: "dup" });
    const second = port.fireMessage({ message, sessionId, idempotencyKey: "dup" });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.inputId, second.inputId);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pollOutputs surfaces deltas then a completed terminal with finalText", () => {
  const root = makeTempDir();
  const store = makeStore(root);
  const port = createChannelRuntimePort(store);
  try {
    const message = makeMessage();
    const sessionId = "im:telegram:dm:123";
    const fired = port.fireMessage({ message, sessionId, idempotencyKey: "k1" });

    store.appendOutputEvent({
      workspaceId: "w1",
      sessionId,
      inputId: fired.inputId,
      sequence: 1,
      eventType: "output_delta",
      payload: { delta: "Hi " },
    });
    store.appendOutputEvent({
      workspaceId: "w1",
      sessionId,
      inputId: fired.inputId,
      sequence: 2,
      eventType: "run_completed",
      payload: { output: "Hi there" },
    });

    const poll = port.pollOutputs({
      workspaceId: "w1",
      sessionId,
      inputId: fired.inputId,
      afterEventId: 0,
    });
    assert.equal(poll.terminal, "completed");
    assert.equal(poll.finalText, "Hi there");
    assert.ok(poll.lastEventId > 0);
    assert.equal(poll.events.length, 2);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("attachments: image → image_urls data-uri, file → workspace, temp cleaned up", () => {
  const root = makeTempDir();
  const store = makeStore(root);
  const port = createChannelRuntimePort(store);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hb-att-src-"));
  try {
    const imgPath = path.join(tmp, "pic.jpg");
    fs.writeFileSync(imgPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
    const docPath = path.join(tmp, "notes.txt");
    fs.writeFileSync(docPath, "hello doc");

    const message = makeMessage({
      text: "look at these",
      attachments: [
        { kind: "image", sourcePath: imgPath, name: "pic.jpg", mimeType: "image/jpeg", sizeBytes: 8 },
        { kind: "file", sourcePath: docPath, name: "notes.txt", mimeType: "text/plain", sizeBytes: 9 },
      ],
    });

    port.fireMessage({ message, sessionId: "im:telegram:dm:123", idempotencyKey: "att" });
    const input = store.getInputByIdempotencyKey({ workspaceId: "w1", idempotencyKey: "att" });
    const payload = input!.payload as {
      image_urls: string[];
      attachments: Array<Record<string, unknown>>;
    };

    assert.equal(payload.image_urls.length, 1);
    assert.match(payload.image_urls[0]!, /^data:image\/jpeg;base64,/);

    assert.equal(payload.attachments.length, 1);
    const att = payload.attachments[0]!;
    assert.equal(att.name, "notes.txt");
    assert.match(String(att.workspace_path), /^attachments[/\\]telegram[/\\]/);
    const abs = path.join(store.workspaceDir("w1"), String(att.workspace_path));
    assert.equal(fs.readFileSync(abs, "utf8"), "hello doc");

    assert.equal(fs.existsSync(imgPath), false, "image temp removed");
    assert.equal(fs.existsSync(docPath), false, "file temp removed");
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
