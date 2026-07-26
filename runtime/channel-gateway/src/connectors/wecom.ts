import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ChannelConnectionConfig } from "../config.js";
import type {
  ChannelCapabilities,
  ChannelConnector,
  ChatType,
  IncomingAttachment,
  IncomingMessage,
  IncomingMessageHandler,
  OutgoingMedia,
  OutgoingTarget,
  SendResult,
} from "../connector.js";
import type { LoggerLike } from "../egress.js";

const WECOM_CAPABILITIES: ChannelCapabilities = {
  editMessages: true, // token-by-token streaming: createStreamMessage + editText → replyStream
  finalizeByResend: false,
  // WeCom Smart Bots have no message reactions or typing indicator, and the passive
  // reply model is single-response per inbound callback (one req_id → one stream). We
  // acknowledge immediately by OPENING that stream with a placeholder frame (finish=
  // false) inside the connector, then finishing it with the answer (see #onMessage /
  // sendText). We deliberately leave `workingText` UNSET: the egress workingText path
  // sends via sendText (finish=true), which would close the one reply and block the
  // real answer.
  reactions: false,
  typing: false,
  typingRefreshMs: 0,
  markdown: "markdown", // replyStream renders Markdown
  maxMessageLength: 4000,
  lengthUnit: "codepoints",
  interactiveButtons: false,
  threads: false,
  media: { image: true, document: true, voice: true, video: true },
};

// Placeholder shown the instant WeCom delivers the inbound message — the first frame of
// the streamed reply (finish=false). The final answer finishes THAT stream, replacing
// this text in place (WeCom stream content is cumulative). Matches qq/wechat wording.
const WECOM_WORKING_TEXT = "🤔 Working on it…";

// Sent when a user first opens the bot chat (the enter_chat event), within WeCom's
// 5s welcome window. Plain text (WeCom welcome supports text or template_card).
const WECOM_WELCOME_TEXT =
  "👋 Hi, I'm your Hola assistant. Ask me anything — I can research, write, analyze, and generate images. Just send a message to get started.";

interface WecomConnectorOptions {
  config: ChannelConnectionConfig;
  logger?: LoggerLike;
  /** Injected SDK, for tests. Falls back to the lazily-imported real SDK. */
  sdk?: WecomSdk;
}

// ── Structural slices of @wecom/aibot-node-sdk (lazily imported) ─────────────
interface WsFrameHeaders {
  req_id: string;
  [key: string]: unknown;
}
interface WecomMediaRef {
  url: string;
  aeskey?: string;
}
interface WecomMessageBody {
  msgid: string;
  chatid?: string;
  chattype?: "single" | "group";
  from?: { userid?: string };
  msgtype?: string;
  text?: { content?: string };
  voice?: { content?: string };
  image?: WecomMediaRef;
  file?: WecomMediaRef;
  video?: WecomMediaRef;
  mixed?: { msg_item?: Array<{ msgtype?: string; text?: { content?: string }; image?: WecomMediaRef }> };
}
interface WsFrame<T = WecomMessageBody> {
  cmd?: string;
  headers: WsFrameHeaders;
  body?: T;
}
interface WSClientLike {
  isConnected: boolean;
  connect(): WSClientLike;
  disconnect(): void;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  replyStream(
    frame: WsFrame,
    streamId: string,
    content: string,
    finish?: boolean,
  ): Promise<unknown>;
  // Like replyStream but returns 'skipped' for an intermediate frame while a prior
  // same-req_id ack is still pending — avoids backing up the stream. finish=true
  // frames are always sent.
  replyStreamNonBlocking(
    frame: WsFrame,
    streamId: string,
    content: string,
    finish?: boolean,
  ): Promise<unknown>;
  // Passive welcome reply — must use the enter_chat event's frame, within 5s.
  replyWelcome(frame: WsFrame, body: unknown): Promise<unknown>;
  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }>;
  // Outbound media: 3-step chunked upload → media_id, then a proactive push by chatid.
  uploadMedia(
    fileBuffer: Buffer,
    options: { type: WecomMediaType; filename: string },
  ): Promise<{ media_id: string; type?: string }>;
  sendMediaMessage(chatid: string, mediaType: WecomMediaType, mediaId: string): Promise<unknown>;
}

// WeCom outbound media kinds. The runtime's artifact `kind` (image/document/voice/
// video) maps onto these; `document` → WeCom's "file".
type WecomMediaType = "image" | "file" | "voice" | "video";
const WECOM_MEDIA_TYPE: Record<OutgoingMedia["kind"], WecomMediaType> = {
  image: "image",
  document: "file",
  voice: "voice",
  video: "video",
};
interface WecomSdk {
  WSClient: new (opts: {
    botId: string;
    secret: string;
    maxReconnectAttempts?: number;
    maxAuthFailureAttempts?: number;
    logger?: unknown;
  }) => WSClientLike;
}

/**
 * WeCom (企业微信) Smart Bot connector over the official `@wecom/aibot-node-sdk`
 * WebSocket long-connection (`wss://openws.work.weixin.qq.com`) — no public URL.
 * The SDK is dynamically imported so it only loads when a WeCom connection
 * exists. Replies are passive (respond to the inbound callback) via `replyStream`
 * (Markdown). Inbound images/files/videos are downloaded + AES-256-CBC-decrypted
 * by the SDK; voice arrives pre-transcribed. Reaches WeCom (enterprise) users.
 */
export class WecomConnector implements ChannelConnector {
  readonly platform = "wecom" as const;
  readonly connectionId: string;
  readonly capabilities = WECOM_CAPABILITIES;

  readonly #botId: string;
  readonly #secret: string;
  readonly #workspaceId: string | null;
  readonly #allowFrom: Set<string>;
  readonly #logger?: LoggerLike;
  // chatId → the inbound FRAME needed to reply to that conversation. The SDK's
  // replyStream(frame, …) reads frame.headers.req_id, so we must keep the whole
  // frame — passing headers alone sends an empty req_id (WeCom 846605 invalid req_id).
  readonly #replyTo = new Map<string, WsFrame>();
  // chatId → streamId of the in-flight streamed reply (opened by the immediate-ack
  // frame), so the final answer FINISHES that same stream instead of opening a second
  // one (WeCom allows a single reply per req_id).
  readonly #activeStream = new Map<string, string>();
  #seq = 0;

  #handler: IncomingMessageHandler | null = null;
  #client: WSClientLike | null = null;
  readonly #sdk?: WecomSdk;

  constructor(options: WecomConnectorOptions) {
    const { config } = options;
    // WeCom binds with BotID + Secret, carried in the generic app id/secret slots.
    if (!config.appId || !config.appSecret) {
      throw new Error("wecom connector requires a BotID + Secret");
    }
    this.connectionId = config.connectionId;
    this.#botId = config.appId;
    this.#secret = config.appSecret;
    this.#workspaceId = config.workspaceId ?? null;
    this.#allowFrom = normalizeAllowlist(config.allowFrom ?? []);
    this.#logger = options.logger;
    this.#sdk = options.sdk;
  }

  get key(): string {
    return `wecom:${this.#workspaceId ?? "?"}:${this.connectionId}`;
  }

  fingerprint(): string {
    return createHash("sha256")
      .update(
        [
          this.platform,
          this.connectionId,
          this.#workspaceId ?? "",
          this.#botId,
          this.#secret,
          [...this.#allowFrom].sort().join(","),
        ].join("|"),
      )
      .digest("hex");
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.#handler = handler;
  }

  format(text: string): string {
    return text; // WeCom replyStream renders Markdown natively
  }

  async start(): Promise<void> {
    const sdk = this.#sdk ?? ((await import("@wecom/aibot-node-sdk")) as unknown as WecomSdk);
    const client = new sdk.WSClient({ botId: this.#botId, secret: this.#secret });
    client.on("message", (...args: unknown[]) => {
      void this.#onMessage(args[0] as WsFrame);
    });
    // Greet the user the moment they open the bot chat (enter_chat event → welcome,
    // within WeCom's 5s window). The SDK emits `event.<eventtype>` per event.
    client.on("event.enter_chat", (...args: unknown[]) => {
      void this.#onEnterChat(args[0] as WsFrame);
    });
    client.on("authenticated", () => this.#logger?.info?.(`wecom: authenticated (${this.key})`));
    client.on("error", (...args: unknown[]) =>
      this.#logger?.warn?.(`wecom: client error (${this.key})`, args[0]),
    );
    client.connect();
    this.#client = client;
    this.#logger?.info?.(`wecom: connecting (${this.key})`);
  }

  async stop(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#replyTo.clear();
    this.#activeStream.clear();
    if (client) {
      try {
        client.disconnect();
      } catch {
        // ignore
      }
    }
  }

  async sendText(target: OutgoingTarget, text: string): Promise<SendResult> {
    const client = this.#client;
    const frame = this.#replyTo.get(target.chatId);
    if (!client || !frame) return { ok: false, error: "wecom: no active reply context" };
    try {
      // Finish the stream the immediate-ack frame opened (so the answer replaces the
      // placeholder in place); else open a fresh single-frame stream.
      const streamId = this.#activeStream.get(target.chatId) ?? `${frame.headers?.req_id ?? "s"}-${(this.#seq += 1)}`;
      this.#activeStream.delete(target.chatId);
      // replyStream needs the ORIGINAL frame (it reads frame.headers.req_id); passing
      // headers alone sends an empty req_id → WeCom rejects with 846605 invalid req_id.
      await client.replyStream(frame, streamId, text, true);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Streaming (editMessages path) ──────────────────────────────────────────
  // Egress drives token-by-token streaming here: createStreamMessage opens the reply
  // stream (reusing the immediate-ack frame's streamId so the placeholder becomes the
  // answer in place), editText pushes CUMULATIVE content (WeCom stream content is
  // cumulative — each frame is the full text so far), and the finalize edit sends the
  // finish=true frame. Intermediate frames are non-blocking (self-skip while an ack is
  // pending) so a fast token stream never backs up.
  async createStreamMessage(target: OutgoingTarget, text: string): Promise<SendResult> {
    const client = this.#client;
    const frame = this.#replyTo.get(target.chatId);
    if (!client || !frame) return { ok: false, error: "wecom: no active reply context" };
    try {
      const streamId =
        this.#activeStream.get(target.chatId) ?? `${frame.headers?.req_id ?? "s"}-${(this.#seq += 1)}`;
      this.#activeStream.set(target.chatId, streamId);
      await client.replyStreamNonBlocking(frame, streamId, text, false);
      return { ok: true, messageId: streamId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async editText(
    target: OutgoingTarget,
    messageId: string,
    text: string,
    options?: { finalize?: boolean },
  ): Promise<SendResult> {
    const client = this.#client;
    const frame = this.#replyTo.get(target.chatId);
    if (!client || !frame) return { ok: false, error: "wecom: no active reply context" };
    try {
      if (options?.finalize === true) {
        this.#activeStream.delete(target.chatId);
        await client.replyStream(frame, messageId, text, true);
      } else {
        await client.replyStreamNonBlocking(frame, messageId, text, false);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendMedia(target: OutgoingTarget, file: OutgoingMedia, caption?: string): Promise<SendResult> {
    const client = this.#client;
    if (!client) return { ok: false, error: "wecom: not connected" };
    try {
      const buffer = await fsp.readFile(file.path);
      const mediaType = WECOM_MEDIA_TYPE[file.kind];
      const filename = file.name ?? path.basename(file.path);
      // 3-step chunked upload → temp-material media_id.
      const { media_id: mediaId } = await client.uploadMedia(buffer, { type: mediaType, filename });
      if (!mediaId) return { ok: false, error: "wecom: uploadMedia returned no media_id" };
      // Captions ride as a preceding text message (media items carry none).
      if (caption?.trim()) await this.sendText(target, caption).catch(() => {});
      // The passive reply (text answer) is already finished by the time artifacts
      // deliver, so push the media PROACTIVELY by chatId (aibot_send_msg) rather than
      // via the spent inbound frame. chatId = userid (DM) or group chatid.
      await client.sendMediaMessage(target.chatId, mediaType, mediaId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async #onEnterChat(frame: WsFrame): Promise<void> {
    const client = this.#client;
    if (!client || !frame?.headers) return;
    // Respect the allowlist (a group/user gate) if the event carries a sender.
    const senderId = (frame.body as { from?: { userid?: string } } | undefined)?.from?.userid ?? "";
    if (senderId && !this.#isAllowed(senderId)) return;
    try {
      await client.replyWelcome(frame, { msgtype: "text", text: { content: WECOM_WELCOME_TEXT } });
    } catch (err) {
      this.#logger?.warn?.("wecom: welcome reply failed", err);
    }
  }

  async #onMessage(frame: WsFrame): Promise<void> {
    const handler = this.#handler;
    const body = frame?.body;
    if (!handler || !body) return;

    const senderId = body.from?.userid ?? "";
    if (!this.#isAllowed(senderId)) {
      this.#logger?.info?.(`wecom: dropping disallowed sender (${this.key})`);
      return;
    }

    const isGroup = body.chattype === "group";
    const chatId = isGroup ? (body.chatid ?? "") : senderId;
    if (!chatId) return;
    // Remember how to reply to this chat (passive reply needs the inbound frame).
    if (this.#replyTo.size >= 2048) {
      const oldest = this.#replyTo.keys().next().value;
      if (oldest !== undefined) this.#replyTo.delete(oldest);
    }
    this.#replyTo.set(chatId, frame);

    const text = extractText(body);
    let attachments: IncomingAttachment[] = [];
    try {
      attachments = await this.#downloadMedia(body);
    } catch (err) {
      this.#logger?.warn?.("wecom: media download failed", err);
    }
    if (!text && attachments.length === 0) return;

    // Immediate ack: open the streamed reply now (finish=false) so the user sees a
    // placeholder within WeCom's passive-reply window and the stream stays alive during
    // the agent's turn. The final answer (sendText) finishes THIS stream in place.
    const client = this.#client;
    if (client) {
      const streamId = `${frame.headers?.req_id ?? "s"}-${(this.#seq += 1)}`;
      this.#activeStream.set(chatId, streamId);
      void client.replyStream(frame, streamId, WECOM_WORKING_TEXT, false).catch((err) => {
        this.#logger?.warn?.("wecom: working-ack failed", err);
      });
    }

    const chatType: ChatType = isGroup ? "group" : "dm";
    const incoming: IncomingMessage = {
      platform: "wecom",
      connectionId: this.connectionId,
      workspaceId: this.#workspaceId ?? "",
      chatId,
      chatType,
      userId: senderId,
      text,
      messageId: body.msgid,
      updateId: body.msgid, // WeCom has no update_id; the msgid keys idempotency
      attachments,
      raw: frame,
    };
    try {
      await handler(incoming);
    } catch (err) {
      this.#logger?.error?.("wecom: inbound handler failed", err);
    }
  }

  async #downloadMedia(body: WecomMessageBody): Promise<IncomingAttachment[]> {
    const client = this.#client;
    if (!client) return [];
    const refs: { ref: WecomMediaRef; kind: IncomingAttachment["kind"] }[] = [];
    if (body.image?.url) refs.push({ ref: body.image, kind: "image" });
    if (body.file?.url) refs.push({ ref: body.file, kind: "file" });
    if (body.video?.url) refs.push({ ref: body.video, kind: "video" });
    for (const item of body.mixed?.msg_item ?? []) {
      if (item.image?.url) refs.push({ ref: item.image, kind: "image" });
    }
    if (refs.length === 0) return [];

    const out: IncomingAttachment[] = [];
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hb-wecom-"));
    for (const { ref, kind } of refs) {
      try {
        const { buffer, filename } = await client.downloadFile(ref.url, ref.aeskey);
        const safeName = (filename ?? `${kind}-${out.length}`).replace(/[^\w.-]+/g, "_") || "file";
        const dest = path.join(dir, `${out.length}-${safeName}`);
        await fsp.writeFile(dest, buffer);
        out.push({
          kind,
          sourcePath: dest,
          name: safeName,
          mimeType: guessMime(kind, safeName),
          sizeBytes: buffer.length,
        });
      } catch (err) {
        this.#logger?.warn?.(`wecom: failed to download ${kind} (${this.key})`, err);
      }
    }
    return out;
  }

  #isAllowed(senderId: string): boolean {
    if (this.#allowFrom.size === 0) return true;
    return this.#allowFrom.has(senderId.trim().toLowerCase());
  }
}

/** Extract the user-facing text from a WeCom message body (text / voice STT / mixed). */
function extractText(body: WecomMessageBody): string {
  if (typeof body.text?.content === "string") return body.text.content.trim();
  if (typeof body.voice?.content === "string") return body.voice.content.trim();
  const mixed = (body.mixed?.msg_item ?? [])
    .map((item) => (typeof item.text?.content === "string" ? item.text.content : ""))
    .join("")
    .trim();
  return mixed;
}

function guessMime(kind: IncomingAttachment["kind"], name: string): string {
  if (kind === "image") return name.endsWith(".png") ? "image/png" : "image/jpeg";
  if (kind === "video") return "video/mp4";
  if (kind === "voice") return "audio/amr";
  return "application/octet-stream";
}

/**
 * Validate WeCom credentials by opening a short-lived WebSocket and waiting for
 * the SDK's `authenticated` event. A successful auth proves the BotID + Secret
 * pair before we persist + run the connection.
 */
export async function validateWecomCredentials(
  botId: string,
  secret: string,
): Promise<{ ok: boolean; error?: string }> {
  const id = botId.trim();
  const key = secret.trim();
  if (!id || !key) return { ok: false, error: "A BotID and Secret are required." };
  let sdk: WecomSdk;
  try {
    sdk = (await import("@wecom/aibot-node-sdk")) as unknown as WecomSdk;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return new Promise((resolve) => {
    const client = new sdk.WSClient({
      botId: id,
      secret: key,
      maxReconnectAttempts: 0,
      maxAuthFailureAttempts: 0,
    });
    let settled = false;
    const finish = (result: { ok: boolean; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.disconnect();
      } catch {
        // ignore
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "Timed out connecting to WeCom." }), 12000);
    client.on("authenticated", () => finish({ ok: true }));
    client.on("error", (...args: unknown[]) => {
      const err = args[0];
      finish({ ok: false, error: err instanceof Error ? err.message : "WeCom rejected the credentials." });
    });
    try {
      client.connect();
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

function normalizeAllowlist(values: string[]): Set<string> {
  const out = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (normalized) out.add(normalized);
  }
  return out;
}
