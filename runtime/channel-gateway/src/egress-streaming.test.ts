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
import { ChannelIngress } from "./ingress.js";
import type {
  ChannelRuntimePort,
  FireMessageResult,
  PollOutputsResult,
} from "./ports.js";

const STREAM_CAPS: ChannelCapabilities = {
  editMessages: true,
  finalizeByResend: false,
  reactions: true,
  typing: false,
  typingRefreshMs: 0,
  markdown: "none",
  maxMessageLength: 4096,
  lengthUnit: "codepoints",
  interactiveButtons: false,
  threads: false,
  media: { image: false, document: false, voice: false, video: false },
};

/** Records sendText (message creates) and editText (in-place edits) separately so a
 *  test can assert the stream-create-then-finalize-by-edit shape. */
class StreamingConnector implements ChannelConnector {
  readonly platform = "telegram";
  readonly connectionId = "default";
  readonly key = "telegram:w1:default";
  readonly capabilities: ChannelCapabilities;
  readonly ackEmojis = { received: "👀", done: "👍", failed: "👎" };

  creates: Array<{ text: string }> = [];
  edits: Array<{ messageId: string; text: string; finalize: boolean }> = [];
  #handler: IncomingMessageHandler | null = null;
  #counter = 0;

  constructor(caps: ChannelCapabilities = STREAM_CAPS) {
    this.capabilities = caps;
  }
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
    this.creates.push({ text });
    return { ok: true, messageId: String(this.#counter) };
  }
  async editText(
    _target: OutgoingTarget,
    messageId: string,
    text: string,
    options?: { finalize?: boolean },
  ): Promise<SendResult> {
    this.edits.push({ messageId, text, finalize: Boolean(options?.finalize) });
    return { ok: true, messageId };
  }
  async react(): Promise<void> {}
  async unreact(): Promise<void> {}
  async emit(message: IncomingMessage): Promise<void> {
    await this.#handler?.(message);
  }
}

/** One non-terminal delta poll, then a terminal completed poll. */
class TwoStepPort implements ChannelRuntimePort {
  readonly #polls = new Map<string, number>();
  constructor(
    private readonly delta: string,
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
  pollOutputs({ inputId }: { inputId: string }): PollOutputsResult {
    const seen = (this.#polls.get(inputId) ?? 0) + 1;
    this.#polls.set(inputId, seen);
    if (seen === 1) {
      return {
        events: [{ id: 1, sequence: 1, eventType: "output_delta", payload: { delta: this.delta } }],
        lastEventId: 1,
        terminal: null,
        finalText: null,
        error: null,
      };
    }
    return {
      events: [
        { id: 2, sequence: 2, eventType: "run_completed", payload: { output: this.finalText } },
      ],
      lastEventId: 2,
      terminal: "completed",
      finalText: this.finalText,
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

test("editMessages connector streams: one message created, then finalized by edit", async () => {
  const port = new TwoStepPort("Hello ", "Hello world");
  const egress = new ChannelEgress({ port, pollIntervalMs: 5 });
  const ingress = new ChannelIngress({ port, egress });
  const connector = new StreamingConnector();

  await ingress.handle({ connector, message: makeMessage() });
  await waitFor(() => connector.edits.some((edit) => edit.finalize));

  // Interim: exactly one message created from the first delta (not a fresh
  // message per tick, and not a separate final send).
  assert.equal(connector.creates.length, 1);
  assert.equal(connector.creates[0]!.text, "Hello ");
  // Final: the SAME message edited to the full answer, with the finalize flag.
  const finalEdit = connector.edits.at(-1)!;
  assert.equal(finalEdit.messageId, "1");
  assert.equal(finalEdit.text, "Hello world");
  assert.equal(finalEdit.finalize, true);
});

test("streaming finalize splits overflow into continuation messages within the limit", async () => {
  const caps: ChannelCapabilities = { ...STREAM_CAPS, maxMessageLength: 12 };
  const longFinal = "AAAAAAAA BBBBBBBB CCCCCCCC"; // 26 chars → must split at 12
  const port = new TwoStepPort("start", longFinal);
  const egress = new ChannelEgress({ port, pollIntervalMs: 5 });
  const ingress = new ChannelIngress({ port, egress });
  const connector = new StreamingConnector(caps);

  await ingress.handle({ connector, message: makeMessage() });
  await waitFor(() => connector.edits.some((edit) => edit.finalize));

  // The finalized head edits the streamed message; the rest arrive as continuations.
  assert.ok(connector.edits.some((edit) => edit.finalize), "a finalize edit occurred");
  assert.ok(connector.creates.length >= 2, "overflow produced continuation messages");
  // Every delivered part (interim create, finalize edit, continuations) stays within
  // the platform limit — the whole point of split-on-finalize.
  for (const part of [...connector.creates.map((c) => c.text), ...connector.edits.map((e) => e.text)]) {
    assert.ok([...part].length <= caps.maxMessageLength, `part within limit: ${JSON.stringify(part)}`);
  }
});
