import type {
  ChannelConnector,
  IncomingMessage,
  OutgoingTarget,
  SendResult,
} from "./connector.js";
import { splitMessage } from "./format/split.js";
import type {
  ChannelArtifact,
  ChannelRuntimePort,
  PollOutputsResult,
} from "./ports.js";

/**
 * Edit-in-place streaming throttle. The stream message is edited at most every
 * STREAM_MIN_EDIT_MS; a failed edit (e.g. a platform rate-limit) backs the
 * interval off toward STREAM_MAX_EDIT_MS. Uses an adaptive edit interval.
 */
const STREAM_MIN_EDIT_MS = 900;
const STREAM_MAX_EDIT_MS = 5000;

export interface LoggerLike {
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
  debug?(...args: unknown[]): void;
}

export interface ChannelEgressOptions {
  port: ChannelRuntimePort;
  logger?: LoggerLike;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Watches one turn's output stream and delivers the agent's reply back to the IM
 * platform. v1 strategy is **buffer-final**: acknowledge immediately (reaction +
 * typing), then on `run_completed` send the assembled reply (formatted + split).
 * This is the proven buffer-final path; live edit-in-place
 * streaming is a future enhancement gated on `capabilities.editMessages`.
 */
export class ChannelEgress {
  readonly #port: ChannelRuntimePort;
  readonly #logger?: LoggerLike;
  readonly #pollIntervalMs: number;
  readonly #timeoutMs: number;

  constructor(options: ChannelEgressOptions) {
    this.#port = options.port;
    this.#logger = options.logger;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.#timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  }

  async watch(params: {
    connector: ChannelConnector;
    message: IncomingMessage;
    sessionId: string;
    inputId: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const { connector, message, sessionId, inputId, signal } = params;
    const target: OutgoingTarget = {
      chatId: message.chatId,
      threadId: message.threadId,
      replyToMessageId: message.messageId,
    };

    // Ack immediately, every turn. Reaction platforms get a subtle 👀 reaction
    // (non-cluttering). Platforms without reactions/typing (WeChat/QQ/WeCom) get
    // a one-line "working" text sent right away — a guaranteed "received" signal.
    // This text used to be delayed 8s (and cooldowned) to avoid littering fast
    // turns, but that made slow turns (image analysis) land the placeholder right
    // on top of the answer, and left the user unsure their message even arrived.
    // On these no-edit platforms an instant ack is the better trade. It's sent
    // exactly once here, so a message never gets two acks.
    await this.#ack(connector, message, "received");
    if (!connector.capabilities.reactions && connector.workingText) {
      await connector.sendText(target, connector.workingText).catch((err) => {
        this.#logger?.debug?.("channel egress: working-text ack failed", err);
      });
    }
    const typing = connector.capabilities.typing
      ? this.#startTyping(connector, message, signal)
      : null;

    let afterEventId = 0;
    const deadline = Date.now() + this.#timeoutMs;

    // A turn is delivered as one message PER assistant segment. `tool_call` events
    // delimit the agent's separate conversational messages, so we flush the buffer
    // at each boundary — otherwise the whole turn (all the interim commentary plus
    // the final answer) collapses into a single blob. Streaming platforms edit the
    // current segment's message in place until it's flushed (Strategy A); buffer-
    // final platforms send each segment once (Strategy B).
    const streaming =
      connector.capabilities.editMessages && typeof connector.editText === "function";
    let segment: string[] = [];
    let flushedSegments = 0;
    const stream = {
      messageId: undefined as string | undefined,
      lastRender: "",
      lastEditAt: 0,
      intervalMs: STREAM_MIN_EDIT_MS,
    };

    // Deliver the current segment (finalize the streamed message, or send once for
    // buffer-final), then reset segment + stream state for the next one.
    const flushSegment = async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (streaming && stream.messageId && !connector.capabilities.finalizeByResend) {
        await this.#finalizeStream(connector, target, stream.messageId, trimmed);
      } else {
        await this.#deliver(connector, target, trimmed);
      }
      flushedSegments += 1;
      segment = [];
      stream.messageId = undefined;
      stream.lastRender = "";
      stream.lastEditAt = 0;
      stream.intervalMs = STREAM_MIN_EDIT_MS;
    };

    try {
      while (!signal?.aborted && Date.now() < deadline) {
        let result: PollOutputsResult | null = null;
        try {
          result = this.#port.pollOutputs({
            workspaceId: message.workspaceId,
            sessionId,
            inputId,
            afterEventId,
          });
        } catch (err) {
          this.#logger?.error?.("channel egress: pollOutputs failed", err);
        }
        if (!result) {
          await sleep(this.#pollIntervalMs, signal);
          continue;
        }

        afterEventId = result.lastEventId;
        for (const event of result.events) {
          if (event.eventType === "output_delta") {
            const delta = event.payload.delta;
            if (typeof delta === "string") segment.push(delta);
          } else if (event.eventType === "tool_call") {
            // Assistant message boundary: flush the segment so each conversational
            // message is its own chat message, delivered as the agent produces it.
            await flushSegment(segment.join(""));
          }
        }

        // Interim streaming edit (throttled) — shows the current segment growing.
        if (
          streaming &&
          result.terminal === null &&
          Date.now() - stream.lastEditAt >= stream.intervalMs
        ) {
          const preview = this.#streamPreview(connector, segment.join(""));
          if (preview && preview !== stream.lastRender) {
            const rendered = await this.#renderStream(connector, target, stream.messageId, preview);
            stream.messageId ??= rendered.messageId;
            stream.lastRender = preview;
            stream.lastEditAt = Date.now();
            stream.intervalMs = rendered.ok
              ? STREAM_MIN_EDIT_MS
              : Math.min(stream.intervalMs * 2, STREAM_MAX_EDIT_MS);
          }
        }

        if (result.terminal === "completed") {
          // Final segment. Prefer the authoritative finalText ONLY for a
          // single-segment turn (no tool_calls); a multi-segment turn already
          // delivered its earlier segments, so finalText (the whole-turn
          // concatenation) must not be reused — send just this segment's deltas.
          const finalSegment = segment.join("").trim();
          const text =
            flushedSegments === 0
              ? (result.finalText && result.finalText.trim()) || finalSegment
              : finalSegment;
          if (text) {
            await flushSegment(text);
          } else if (flushedSegments === 0) {
            await this.#deliver(connector, target, "(the agent finished without a text reply)");
          }
          await this.#deliverArtifacts(connector, target, {
            workspaceId: message.workspaceId,
            sessionId,
            inputId,
          });
          await this.#ack(connector, message, "done");
          return;
        }
        if (result.terminal === "failed") {
          await this.#deliver(
            connector,
            target,
            `⚠️ ${result.error?.trim() || "the agent run failed"}`,
          );
          await this.#ack(connector, message, "failed");
          return;
        }

        await sleep(this.#pollIntervalMs, signal);
      }
      if (!signal?.aborted) {
        this.#logger?.warn?.(
          `channel egress: timed out waiting for reply session=${sessionId} input=${inputId}`,
        );
      }
    } finally {
      typing?.stop();
    }
  }

  /**
   * Format agent text into platform-ready parts, each within the message limit.
   * Splits the raw text first (headroom for formatting expansion like HTML
   * escaping), formats each piece, then re-splits the formatted output as a hard
   * safety net so no single message can exceed the platform limit.
   */
  #formatAndSplit(connector: ChannelConnector, text: string): string[] {
    const cap = connector.capabilities;
    const rawLimit = Math.max(256, cap.maxMessageLength - 256);
    const parts: string[] = [];
    for (const raw of splitMessage(text, rawLimit, "codepoints")) {
      const formatted = connector.format(raw);
      for (const part of splitMessage(formatted, cap.maxMessageLength, cap.lengthUnit)) {
        if (part.trim().length === 0) continue;
        parts.push(part);
      }
    }
    return parts;
  }

  async #deliver(
    connector: ChannelConnector,
    target: OutgoingTarget,
    text: string,
  ): Promise<void> {
    for (const part of this.#formatAndSplit(connector, text)) {
      try {
        // Surface a soft failure: connectors that return { ok: false } (e.g. WeCom's
        // replyStream) instead of throwing would otherwise be dropped silently.
        const result = await connector.sendText(target, part);
        if (result && !result.ok) {
          this.#logger?.warn?.(`channel egress: sendText not ok (${connector.platform}): ${result.error ?? "unknown"}`);
        }
      } catch (err) {
        this.#logger?.error?.("channel egress: sendText failed", err);
      }
    }
  }

  /**
   * The single message shown while streaming: the first (head) formatted part of
   * everything accumulated so far. As the answer grows it fills up to the platform
   * limit and then holds — the remainder is delivered as continuation messages on
   * finalize, so we never split mid-stream. Null when there's nothing to show yet.
   */
  #streamPreview(connector: ChannelConnector, accumulated: string): string | null {
    if (accumulated.trim().length === 0) return null;
    return this.#formatAndSplit(connector, accumulated)[0] ?? null;
  }

  /** Create the stream message on the first render, then edit it in place after.
   *  The create path uses the connector's `createStreamMessage` when present (a
   *  DingTalk AI Card), else a plain `sendText` (Telegram). */
  async #renderStream(
    connector: ChannelConnector,
    target: OutgoingTarget,
    messageId: string | undefined,
    text: string,
  ): Promise<SendResult> {
    try {
      if (!messageId) {
        return connector.createStreamMessage
          ? await connector.createStreamMessage(target, text)
          : await connector.sendText(target, text);
      }
      if (!connector.editText) return { ok: false };
      return await connector.editText(target, messageId, text);
    } catch (err) {
      this.#logger?.debug?.("channel egress: stream render failed", err);
      return { ok: false };
    }
  }

  /**
   * Finalize a streamed message: edit it to the final head chunk (with the
   * `finalize` flag, which card-style platforms use to close their streaming
   * indicator), then send any overflow as continuation messages.
   */
  async #finalizeStream(
    connector: ChannelConnector,
    target: OutgoingTarget,
    messageId: string,
    fullText: string,
  ): Promise<void> {
    if (!connector.editText) {
      await this.#deliver(connector, target, fullText);
      return;
    }
    const parts = this.#formatAndSplit(connector, fullText);
    const head = parts[0] ?? "(the agent finished without a text reply)";
    try {
      await connector.editText(target, messageId, head, { finalize: true });
    } catch (err) {
      this.#logger?.error?.("channel egress: finalize edit failed", err);
    }
    for (const part of parts.slice(1)) {
      try {
        await connector.sendText(target, part);
      } catch (err) {
        this.#logger?.error?.("channel egress: continuation send failed", err);
      }
    }
  }

  // Send the turn's deliverable file artifacts (e.g. a screenshot the agent saved
  // under outputs/) as native attachments — the outbound mirror of inbound media.
  // Skipped silently when the connector can't send media. Uses the native kind
  // when the platform supports it, else falls back to a document send.
  async #deliverArtifacts(
    connector: ChannelConnector,
    target: OutgoingTarget,
    ref: { workspaceId: string; sessionId: string; inputId: string },
  ): Promise<void> {
    let artifacts: ChannelArtifact[];
    try {
      artifacts = this.#port.getTurnArtifacts(ref);
    } catch (err) {
      this.#logger?.debug?.("channel egress: getTurnArtifacts failed", err);
      return;
    }
    if (artifacts.length === 0) return;

    const sendMedia = connector.sendMedia;
    const media = connector.capabilities.media;
    const undelivered: string[] = [];
    for (const artifact of artifacts) {
      const kind: ChannelArtifact["kind"] | null = media[artifact.kind]
        ? artifact.kind
        : media.document
          ? "document"
          : null;
      if (!sendMedia || !kind) {
        undelivered.push(artifact.name);
        continue;
      }
      try {
        const res = await sendMedia.call(connector, target, {
          kind,
          path: artifact.path,
          name: artifact.name,
          mimeType: artifact.mimeType,
        });
        if (!res.ok) undelivered.push(artifact.name);
      } catch (err) {
        this.#logger?.error?.("channel egress: sendMedia failed", err);
        undelivered.push(artifact.name);
      }
    }

    // Never silently drop a file the agent produced (and likely told the user it
    // "sent"). Until a connector implements native media send, surface the
    // attachment as text so the reply stays honest.
    if (undelivered.length > 0) {
      const names = undelivered.map((name) => `\`${name}\``).join(", ");
      const note =
        undelivered.length === 1
          ? `📎 Generated ${names} — this channel can't attach files yet, so it's saved in your workspace.`
          : `📎 Generated ${undelivered.length} files (${names}) — this channel can't attach files yet, so they're saved in your workspace.`;
      try {
        await connector.sendText(target, note);
      } catch (err) {
        this.#logger?.debug?.("channel egress: artifact-fallback note failed", err);
      }
    }
  }

  async #ack(
    connector: ChannelConnector,
    message: IncomingMessage,
    kind: "received" | "done" | "failed",
  ): Promise<void> {
    const { capabilities, ackEmojis } = connector;
    if (!capabilities.reactions || !ackEmojis || !message.messageId || !connector.react) {
      return;
    }
    try {
      if (kind !== "received" && connector.unreact) {
        await connector.unreact(message.chatId, message.messageId, ackEmojis.received);
      }
      await connector.react(message.chatId, message.messageId, ackEmojis[kind]);
    } catch (err) {
      this.#logger?.debug?.("channel egress: reaction failed", err);
    }
  }

  #startTyping(
    connector: ChannelConnector,
    message: IncomingMessage,
    signal?: AbortSignal,
  ): { stop: () => void } {
    let stopped = false;
    const intervalMs = Math.max(1000, connector.capabilities.typingRefreshMs || 4000);
    const tick = async (): Promise<void> => {
      while (!stopped && !signal?.aborted) {
        try {
          await connector.sendTyping?.(message.chatId, message.threadId);
        } catch {
          // best-effort; typing failures never block a reply
        }
        await sleep(intervalMs, signal);
      }
    };
    void tick();
    return {
      stop: () => {
        stopped = true;
      },
    };
  }
}
