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
import { ChannelEgress } from "./egress.js";
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

const WORKING_TEXT = "🤔 Working on it…";

class PlainConnector implements ChannelConnector {
  readonly platform = "wechat";
  readonly connectionId = "default";
  readonly key = "wechat:w1:default";
  readonly capabilities = PLAIN_CAPS;
  readonly workingText = WORKING_TEXT;

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

/** Completes with `finalText` after `slowPolls` empty non-terminal polls. */
class TimedPort implements ChannelRuntimePort {
  #polls = 0;
  constructor(
    private readonly slowPolls: number,
    private readonly finalText: string,
  ) {}
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
    this.#polls += 1;
    if (this.#polls <= this.slowPolls) {
      return { events: [], lastEventId: 0, terminal: null, finalText: null, error: null };
    }
    this.#polls = 0;
    return {
      events: [
        { id: 1, sequence: 1, eventType: "run_completed", payload: { output: this.finalText } },
      ],
      lastEventId: 1,
      terminal: "completed",
      finalText: this.finalText,
      error: null,
    };
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

test("working text is sent immediately, ahead of even a fast reply", async () => {
  const connector = new PlainConnector();
  const egress = new ChannelEgress({
    port: new TimedPort(0, "quick answer"),
    pollIntervalMs: 5,
  });

  await egress.watch({
    connector,
    message: makeMessage(),
    sessionId: "s1",
    inputId: "in-1",
  });

  // The instant ack always precedes the answer — even when the reply is fast.
  assert.deepEqual(
    connector.sends.map((s) => s.text),
    [WORKING_TEXT, "quick answer"],
  );
});

test("working text precedes a slow reply too, exactly once per turn", async () => {
  const connector = new PlainConnector();
  const egress = new ChannelEgress({
    port: new TimedPort(20, "slow answer"),
    pollIntervalMs: 10,
  });

  await egress.watch({
    connector,
    message: makeMessage(),
    sessionId: "s1",
    inputId: "in-1",
  });

  assert.deepEqual(
    connector.sends.map((s) => s.text),
    [WORKING_TEXT, "slow answer"],
  );
});

test("every turn gets its own immediate ack — no cross-turn cooldown", async () => {
  const connector = new PlainConnector();
  const egress = new ChannelEgress({
    port: new TimedPort(20, "slow answer"),
    pollIntervalMs: 10,
  });

  await egress.watch({
    connector,
    message: makeMessage(),
    sessionId: "s1",
    inputId: "in-1",
  });
  await egress.watch({
    connector,
    message: makeMessage(),
    sessionId: "s1",
    inputId: "in-1",
  });

  assert.deepEqual(
    connector.sends.map((s) => s.text),
    [WORKING_TEXT, "slow answer", WORKING_TEXT, "slow answer"],
    "each turn acks on its own — no cooldown suppresses later turns",
  );
});
