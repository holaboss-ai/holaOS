import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  ChannelCapabilities,
  ChannelConnector,
  IncomingMessage,
  IncomingMessageHandler,
  OutgoingTarget,
  SendResult,
} from "./connector.js";
import { ChannelEgress, defaultEgressTimeoutMs } from "./egress.js";
import type {
  ChannelRuntimePort,
  FireMessageResult,
  PollOutputsResult,
} from "./ports.js";

const PLAIN_CAPS: ChannelCapabilities = {
  editMessages: false,
  finalizeByResend: false,
  reactions: false,
  typing: false,
  typingRefreshMs: 0,
  markdown: "none",
  maxMessageLength: 4096,
  lengthUnit: "codepoints",
  interactiveButtons: false,
  threads: false,
  media: { image: false, document: false, voice: false, video: false },
};

class PlainConnector implements ChannelConnector {
  readonly platform = "wechat";
  readonly connectionId = "default";
  readonly key = "wechat:w1:default";
  readonly capabilities = PLAIN_CAPS;
  readonly workingText = "🤔 Working on it…";

  sends: Array<{ text: string }> = [];
  #handler: IncomingMessageHandler | null = null;
  #counter = 0;

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
  async sendText(_target: OutgoingTarget, text: string): Promise<SendResult> {
    this.#counter += 1;
    this.sends.push({ text });
    return { ok: true, messageId: String(this.#counter) };
  }
  async react(): Promise<void> {}
  async unreact(): Promise<void> {}
  async emit(message: IncomingMessage): Promise<void> {
    await this.#handler?.(message);
  }
}

/** A run that is still going — never reports a terminal event. */
class NeverTerminalPort implements ChannelRuntimePort {
  resolveWorkspaceId(): string {
    return "w1";
  }
  fireMessage({ sessionId }: { sessionId: string }): FireMessageResult {
    return { sessionId, inputId: "in-1", created: true };
  }
  getTurnArtifacts(): [] {
    return [];
  }
  pollOutputs(): PollOutputsResult {
    return { events: [], lastEventId: 0, terminal: null, finalText: null, error: null };
  }
}

function makeMessage(): IncomingMessage {
  return {
    platform: "wechat",
    connectionId: "default",
    workspaceId: "w1",
    chatId: "123",
    chatType: "dm",
    userId: "u1",
    text: "hi",
    messageId: "10",
    updateId: 100,
    attachments: [],
  };
}

test("giving up on a reply tells the user instead of going quiet", async () => {
  const connector = new PlainConnector();
  const egress = new ChannelEgress({
    port: new NeverTerminalPort(),
    pollIntervalMs: 5,
    timeoutMs: 40,
  });

  await egress.watch({
    connector,
    message: makeMessage(),
    sessionId: "s1",
    inputId: "in-1",
  });

  // Previously the loop just fell through with a log line, so the user was
  // left on the "working" ack forever with no way to tell a slow run from a
  // lost one.
  const texts = connector.sends.map((s) => s.text);
  assert.ok(texts.length >= 2, `expected a timeout notice, saw ${JSON.stringify(texts)}`);
  assert.match(texts.at(-1) ?? "", /stopped waiting/i);
});

test("an aborted watch stays silent", async () => {
  const connector = new PlainConnector();
  const controller = new AbortController();
  const egress = new ChannelEgress({
    port: new NeverTerminalPort(),
    pollIntervalMs: 5,
    timeoutMs: 5_000,
  });

  const watching = egress.watch({
    connector,
    message: makeMessage(),
    sessionId: "s1",
    inputId: "in-1",
    signal: controller.signal,
  });
  controller.abort();
  await watching;

  // Shutdown is not a timeout: the run is not abandoned, so telling the user
  // it was would be wrong.
  const texts = connector.sends.map((s) => s.text);
  assert.ok(
    !texts.some((t) => /stopped waiting/i.test(t)),
    `abort must not deliver a timeout notice, saw ${JSON.stringify(texts)}`,
  );
});

test("the default deadline outlasts the runner's own run ceiling", () => {
  const original = process.env.SANDBOX_AGENT_RUN_TIMEOUT_S;
  try {
    // runner-worker.ts: DEFAULT_RUN_TIMEOUT_SECONDS = 1800. A shorter egress
    // deadline abandons a healthy long turn while it is still running, and the
    // reply is simply never delivered.
    delete process.env.SANDBOX_AGENT_RUN_TIMEOUT_S;
    assert.ok(
      defaultEgressTimeoutMs() > 1800 * 1000,
      `default ${defaultEgressTimeoutMs()}ms must exceed the 1800s run ceiling`,
    );

    // And it tracks the override rather than pinning a constant.
    process.env.SANDBOX_AGENT_RUN_TIMEOUT_S = "3600";
    assert.ok(defaultEgressTimeoutMs() > 3600 * 1000);

    // The helper existing is not the point — ChannelEgress has to actually
    // use it when no explicit timeout is supplied.
    delete process.env.SANDBOX_AGENT_RUN_TIMEOUT_S;
    const egress = new ChannelEgress({ port: new NeverTerminalPort() });
    assert.equal(egress.timeoutMs, defaultEgressTimeoutMs());
    assert.ok(egress.timeoutMs > 1800 * 1000);
  } finally {
    if (original === undefined) {
      delete process.env.SANDBOX_AGENT_RUN_TIMEOUT_S;
    } else {
      process.env.SANDBOX_AGENT_RUN_TIMEOUT_S = original;
    }
  }
});
