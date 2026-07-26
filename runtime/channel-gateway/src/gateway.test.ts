import { test } from "node:test";
import assert from "node:assert/strict";

import type {
  ChannelCapabilities,
  ChannelConnector,
  IncomingMessage,
  IncomingMessageHandler,
  OutgoingTarget,
  SendResult,
} from "./connector.js";
import { ChannelEgress } from "./egress.js";
import { ChannelIngress } from "./ingress.js";
import type { ChannelRuntimePort, FireMessageResult, PollOutputsResult } from "./ports.js";

const CAPS: ChannelCapabilities = {
  editMessages: false,
  finalizeByResend: false,
  reactions: true,
  typing: true,
  typingRefreshMs: 50,
  markdown: "none",
  maxMessageLength: 4096,
  lengthUnit: "codepoints",
  interactiveButtons: false,
  threads: false,
  media: { image: false, document: false, voice: false, video: false },
};

class FakeConnector implements ChannelConnector {
  readonly platform = "telegram";
  readonly connectionId = "default";
  readonly key = "telegram:w1:default";
  readonly capabilities = CAPS;
  readonly ackEmojis = { received: "👀", done: "👍", failed: "👎" };

  sent: Array<{ target: OutgoingTarget; text: string }> = [];
  reactions: Array<{ emoji: string; kind: "react" | "unreact" }> = [];
  typingCount = 0;
  #handler: IncomingMessageHandler | null = null;

  fingerprint(): string {
    return "fp";
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onMessage(handler: IncomingMessageHandler): void {
    this.#handler = handler;
  }
  format(text: string): string {
    return text;
  }
  async sendText(target: OutgoingTarget, text: string): Promise<SendResult> {
    this.sent.push({ target, text });
    return { ok: true, messageId: String(this.sent.length) };
  }
  async sendTyping(): Promise<void> {
    this.typingCount += 1;
  }
  async react(_chatId: string, _messageId: string, emoji: string): Promise<void> {
    this.reactions.push({ emoji, kind: "react" });
  }
  async unreact(_chatId: string, _messageId: string, emoji: string): Promise<void> {
    this.reactions.push({ emoji, kind: "unreact" });
  }
  async emit(message: IncomingMessage): Promise<void> {
    await this.#handler?.(message);
  }
}

class FakePort implements ChannelRuntimePort {
  fired: Array<{ sessionId: string; idempotencyKey: string | null }> = [];
  readonly #seen = new Set<string>();
  readonly #polls = new Map<string, number>();

  resolveWorkspaceId(): string | null {
    return "w1";
  }
  fireMessage(params: {
    message: IncomingMessage;
    sessionId: string;
    idempotencyKey: string | null;
  }): FireMessageResult {
    const { sessionId, idempotencyKey } = params;
    const created = !idempotencyKey || !this.#seen.has(idempotencyKey);
    if (idempotencyKey) this.#seen.add(idempotencyKey);
    this.fired.push({ sessionId, idempotencyKey });
    return { sessionId, inputId: `in-${this.fired.length}`, created };
  }
  getTurnArtifacts() {
    return [];
  }
  pollOutputs(params: {
    workspaceId: string;
    sessionId: string;
    inputId: string;
    afterEventId: number;
  }): PollOutputsResult {
    const seen = (this.#polls.get(params.inputId) ?? 0) + 1;
    this.#polls.set(params.inputId, seen);
    if (seen === 1) {
      return {
        events: [{ id: 1, sequence: 1, eventType: "output_delta", payload: { delta: "Hello " } }],
        lastEventId: 1,
        terminal: null,
        finalText: null,
        error: null,
      };
    }
    return {
      events: [{ id: 2, sequence: 2, eventType: "run_completed", payload: { output: "Hello world" } }],
      lastEventId: 2,
      terminal: "completed",
      finalText: "Hello world",
      error: null,
    };
  }
}

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platform: "telegram",
    connectionId: "default",
    workspaceId: "",
    chatId: "123",
    chatType: "dm",
    userId: "u1",
    text: "hi",
    messageId: "10",
    updateId: 100,
    attachments: [],
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitFor timed out");
}

test("inbound message → headless turn → buffer-final reply with reaction acks", async () => {
  const port = new FakePort();
  const egress = new ChannelEgress({ port, pollIntervalMs: 5 });
  const ingress = new ChannelIngress({ port, egress });
  const connector = new FakeConnector();

  await ingress.handle({ connector, message: makeMessage() });
  await waitFor(() => connector.sent.length > 0);

  assert.equal(connector.sent[0]!.text, "Hello world");
  assert.equal(connector.reactions[0]!.emoji, "👀"); // acknowledged on receipt
  assert.ok(connector.reactions.some((r) => r.emoji === "👍")); // done on completion
  assert.ok(connector.typingCount >= 1);
  assert.equal(port.fired.length, 1);
});

test("a duplicate update id is idempotent — no second reply", async () => {
  const port = new FakePort();
  const egress = new ChannelEgress({ port, pollIntervalMs: 5 });
  const ingress = new ChannelIngress({ port, egress });
  const connector = new FakeConnector();

  await ingress.handle({ connector, message: makeMessage() });
  await waitFor(() => connector.sent.length > 0);
  const delivered = connector.sent.length;

  await ingress.handle({ connector, message: makeMessage() }); // same updateId
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(connector.sent.length, delivered);
  assert.equal(port.fired.length, 2); // fired (looked up) twice, but only one turn ran
});

test("a multi-segment turn delivers one message per segment, not one concatenated blob", async () => {
  // A turn where the agent narrates, calls a tool, then answers: two assistant
  // segments split by a tool_call. Each must arrive as its own message.
  let poll = 0;
  const port: ChannelRuntimePort = {
    resolveWorkspaceId: () => "w1",
    fireMessage: ({ sessionId }) => ({ sessionId, inputId: "in-1", created: true }),
    getTurnArtifacts: () => [],
    pollOutputs: () => {
      poll += 1;
      if (poll === 1) {
        return {
          events: [
            { id: 1, sequence: 1, eventType: "output_delta", payload: { delta: "Let me search." } },
            { id: 2, sequence: 2, eventType: "tool_call", payload: { name: "search" } },
          ],
          lastEventId: 2,
          terminal: null,
          finalText: null,
          error: null,
        };
      }
      return {
        events: [
          { id: 3, sequence: 3, eventType: "output_delta", payload: { delta: "Found it — here you go." } },
          { id: 4, sequence: 4, eventType: "run_completed", payload: { output: "Let me search.Found it — here you go." } },
        ],
        lastEventId: 4,
        terminal: "completed",
        finalText: "Let me search.Found it — here you go.",
        error: null,
      };
    },
  };
  const egress = new ChannelEgress({ port, pollIntervalMs: 5 });
  const ingress = new ChannelIngress({ port, egress });
  const connector = new FakeConnector();

  await ingress.handle({ connector, message: makeMessage() });
  await waitFor(() => connector.sent.length >= 2);

  assert.deepEqual(
    connector.sent.map((s) => s.text),
    ["Let me search.", "Found it — here you go."],
  );
});

test("an undelivered artifact is surfaced as text, not silently dropped", async () => {
  // The agent produced a file, but this connector can't send media (no sendMedia).
  // The user must still learn the file exists instead of the agent appearing to lie.
  const port: ChannelRuntimePort = {
    resolveWorkspaceId: () => "w1",
    fireMessage: ({ sessionId }) => ({ sessionId, inputId: "in-1", created: true }),
    getTurnArtifacts: () => [
      { kind: "document", path: "/tmp/runtime.log", name: "runtime.log", mimeType: "text/plain" },
    ],
    pollOutputs: () => ({
      events: [{ id: 1, sequence: 1, eventType: "run_completed", payload: { output: "Sent the log." } }],
      lastEventId: 1,
      terminal: "completed",
      finalText: "Sent the log.",
      error: null,
    }),
  };
  const egress = new ChannelEgress({ port, pollIntervalMs: 5 });
  const ingress = new ChannelIngress({ port, egress });
  const connector = new FakeConnector(); // no sendMedia, media caps all false

  await ingress.handle({ connector, message: makeMessage() });
  await waitFor(() => connector.sent.some((s) => s.text.includes("runtime.log")));

  assert.ok(
    connector.sent.some((s) => s.text.includes("runtime.log")),
    "the undelivered file is surfaced as text",
  );
});

test("a run_failed terminal delivers an error reply and a fail reaction", async () => {
  const port: ChannelRuntimePort = {
    resolveWorkspaceId: () => "w1",
    fireMessage: ({ sessionId }) => ({ sessionId, inputId: "in-1", created: true }),
    pollOutputs: () => ({
      events: [{ id: 1, sequence: 1, eventType: "run_failed", payload: { error: "boom" } }],
      lastEventId: 1,
      terminal: "failed",
      finalText: null,
      error: "boom",
    }),
    getTurnArtifacts: () => [],
  };
  const egress = new ChannelEgress({ port, pollIntervalMs: 5 });
  const ingress = new ChannelIngress({ port, egress });
  const connector = new FakeConnector();

  await ingress.handle({ connector, message: makeMessage() });
  await waitFor(() => connector.sent.length > 0);

  assert.match(connector.sent[0]!.text, /boom/);
  assert.ok(connector.reactions.some((r) => r.emoji === "👎"));
});
