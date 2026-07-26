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

const QQ_CAPABILITIES: ChannelCapabilities = {
  editMessages: false,
  finalizeByResend: false,
  // QQ's official group/C2C bots support neither message reactions nor a typing
  // indicator — in-progress state is conveyed via `workingText` (see below).
  reactions: false,
  typing: false,
  typingRefreshMs: 0,
  // Group/C2C messages render as plain text (markdown needs approved templates).
  markdown: "none",
  maxMessageLength: 2000,
  lengthUnit: "codepoints",
  interactiveButtons: false,
  threads: false,
  media: { image: true, document: true, voice: true, video: true },
};

interface QQConnectorOptions {
  config: ChannelConnectionConfig;
  logger?: LoggerLike;
}

// ── Structural slices of qq-official-bot (lazily imported) ───────────────────
interface QQQuotable {
  id?: string;
  event_id?: string;
}
interface QQAttachment {
  content_type?: string;
  url?: string;
  filename?: string;
  size?: number;
}
interface QQMessageEvent {
  id: string;
  message_id: string;
  user_id: string;
  raw_message: string;
  sender?: { user_id?: string; user_name?: string };
  group_id?: string;
  group_name?: string;
  guild_id?: string;
  guild_name?: string;
  channel_id?: string;
  channel_name?: string;
  attachments?: QQAttachment[];
}
/** An image message segment; the SDK's file-processor uploads the Buffer to QQ's
 *  RichMedia store before sending. */
type QQImageSegment = { type: "image"; data: { file: Buffer } };
type QQSendable = string | QQImageSegment;
interface QQBotLike {
  on(event: "message", handler: (e: QQMessageEvent) => void | Promise<void>): unknown;
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  sendGroupMessage(groupId: string, message: QQSendable, source?: QQQuotable): Promise<{ id?: string }>;
  sendPrivateMessage(userId: string, message: QQSendable, source?: QQQuotable): Promise<{ id?: string }>;
  sendGuildMessage(channelId: string, message: QQSendable, source?: QQQuotable): Promise<{ id?: string }>;
}
interface QQSdk {
  Bot: new (config: {
    appid: string;
    secret: string;
    mode: string;
    intents?: string[];
    logLevel?: string;
    removeAt?: boolean;
    sandbox?: boolean;
  }) => QQBotLike;
}

type QQRouteKind = "group" | "guild" | "private";
interface QQRoute {
  kind: QQRouteKind;
  /** Quotable source so replies reference the user's message (passive reply). */
  source: QQQuotable;
}

/**
 * Classify an inbound QQ event into a send route. Group messages reply via the
 * group id, guild channel messages via the channel id, everything else (C2C
 * friend / guild direct) via the user id. Exported for unit testing.
 */
export function qqRouteFor(event: {
  group_id?: string;
  channel_id?: string;
  user_id: string;
}): { kind: QQRouteKind; chatId: string } {
  if (event.group_id) return { kind: "group", chatId: event.group_id };
  if (event.channel_id) return { kind: "guild", chatId: event.channel_id };
  return { kind: "private", chatId: event.user_id };
}

/**
 * QQ connector over the official QQ Bot open platform via the maintained
 * `qq-official-bot` SDK (WebSocket gateway + OAuth2 app token). The SDK is
 * dynamically imported so it only loads when a QQ connection exists. QQ replies
 * are *passive* — they must quote the user's message — so we remember a per-chat
 * route + message id on inbound and quote it when sending. Buffer-final text.
 */
export class QQConnector implements ChannelConnector {
  readonly platform = "qq" as const;
  readonly connectionId: string;
  readonly capabilities = QQ_CAPABILITIES;
  // QQ has no reactions/typing → a short text ack is the only in-progress signal.
  readonly workingText = "🤔 Working on it…";

  readonly #appId: string;
  readonly #appSecret: string;
  readonly #workspaceId: string | null;
  readonly #allowFrom: Set<string>;
  readonly #logger?: LoggerLike;
  // chatId → how to address replies for that chat (bounded to cap memory).
  readonly #routes = new Map<string, QQRoute>();

  #handler: IncomingMessageHandler | null = null;
  #bot: QQBotLike | null = null;

  constructor(options: QQConnectorOptions) {
    const { config } = options;
    if (!config.appId || !config.appSecret) {
      throw new Error("qq connector requires appId + appSecret");
    }
    this.connectionId = config.connectionId;
    this.#appId = config.appId;
    this.#appSecret = config.appSecret;
    this.#workspaceId = config.workspaceId ?? null;
    this.#allowFrom = normalizeAllowlist(config.allowFrom ?? []);
    this.#logger = options.logger;
  }

  get key(): string {
    return `qq:${this.#workspaceId ?? "?"}:${this.connectionId}`;
  }

  fingerprint(): string {
    return createHash("sha256")
      .update(
        [
          this.platform,
          this.connectionId,
          this.#workspaceId ?? "",
          this.#appId,
          this.#appSecret,
          [...this.#allowFrom].sort().join(","),
        ].join("|"),
      )
      .digest("hex");
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.#handler = handler;
  }

  format(text: string): string {
    // QQ group/C2C renders plain text; pass through unchanged.
    return text;
  }

  async start(): Promise<void> {
    const qq = (await import("qq-official-bot")) as unknown as QQSdk;
    const bot = new qq.Bot({
      appid: this.#appId,
      secret: this.#appSecret,
      mode: "websocket",
      // Group + C2C (private) messages, plus public guild messages.
      intents: ["GROUP_AND_C2C_EVENT", "PUBLIC_GUILD_MESSAGES", "DIRECT_MESSAGE"],
      logLevel: "warn",
      removeAt: true, // strip the leading @bot mention from group messages
    });
    bot.on("message", (e) => this.#onMessage(e));
    await bot.start();
    this.#bot = bot;
    this.#logger?.info?.(`qq: connected (${this.key})`);
  }

  async stop(): Promise<void> {
    const bot = this.#bot;
    this.#bot = null;
    this.#routes.clear();
    if (bot) {
      try {
        await bot.stop();
      } catch {
        // ignore
      }
    }
  }

  async sendText(target: OutgoingTarget, text: string): Promise<SendResult> {
    const bot = this.#bot;
    if (!bot) return { ok: false, error: "qq not connected" };
    const route = this.#routes.get(target.chatId);
    const source = route?.source;
    try {
      let res: { id?: string };
      if (route?.kind === "group") {
        res = await bot.sendGroupMessage(target.chatId, text, source);
      } else if (route?.kind === "guild") {
        res = await bot.sendGuildMessage(target.chatId, text, source);
      } else {
        res = await bot.sendPrivateMessage(target.chatId, text, source);
      }
      return { ok: true, messageId: res?.id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Send an image as a native QQ RichMedia attachment (the SDK uploads the buffer
   * internally). QQ only supports image/video/audio RichMedia, not arbitrary
   * documents, so non-images return ok:false and fall back to the egress note.
   */
  async sendMedia(
    target: OutgoingTarget,
    file: OutgoingMedia,
    caption?: string,
  ): Promise<SendResult> {
    const bot = this.#bot;
    if (!bot) return { ok: false, error: "qq not connected" };
    if (file.kind !== "image") {
      return { ok: false, error: "qq: only images can be sent as attachments" };
    }
    const route = this.#routes.get(target.chatId);
    const source = route?.source;
    try {
      const bytes = await fsp.readFile(file.path);
      const image: QQSendable = { type: "image", data: { file: bytes } };
      let res: { id?: string };
      if (route?.kind === "group") {
        res = await bot.sendGroupMessage(target.chatId, image, source);
      } else if (route?.kind === "guild") {
        res = await bot.sendGuildMessage(target.chatId, image, source);
      } else {
        res = await bot.sendPrivateMessage(target.chatId, image, source);
      }
      if (caption && caption.trim()) await this.sendText(target, caption).catch(() => {});
      return { ok: true, messageId: res?.id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async #onMessage(event: QQMessageEvent): Promise<void> {
    const handler = this.#handler;
    if (!handler) return;
    const senderId = event.sender?.user_id ?? event.user_id ?? "";
    if (!this.#isAllowed(senderId)) {
      this.#logger?.info?.(`qq: dropping disallowed sender (${this.key})`);
      return;
    }

    const { kind, chatId } = qqRouteFor(event);
    // Remember how to reply to this chat (passive reply quotes the message id).
    if (this.#routes.size >= 2048) {
      const oldest = this.#routes.keys().next().value;
      if (oldest !== undefined) this.#routes.delete(oldest);
    }
    this.#routes.set(chatId, { kind, source: { id: event.id } });

    const text = (event.raw_message ?? "").trim();
    let attachments: IncomingAttachment[] = [];
    try {
      attachments = await this.#downloadAttachments(event.attachments ?? []);
    } catch (err) {
      this.#logger?.warn?.("qq: attachment download failed", err);
    }
    if (!text && attachments.length === 0) return;

    const chatType: ChatType = kind === "group" ? "group" : kind === "guild" ? "channel" : "dm";
    const incoming: IncomingMessage = {
      platform: "qq",
      connectionId: this.connectionId,
      workspaceId: this.#workspaceId ?? "",
      chatId,
      chatType,
      chatTitle: event.group_name ?? event.channel_name ?? event.guild_name,
      userId: senderId,
      userName: event.sender?.user_name,
      text,
      messageId: event.id,
      updateId: event.id, // QQ has no update_id; the message id keys idempotency
      attachments,
      raw: event,
    };
    try {
      await handler(incoming);
    } catch (err) {
      this.#logger?.error?.("qq: inbound handler failed", err);
    }
  }

  async #downloadAttachments(attachments: QQAttachment[]): Promise<IncomingAttachment[]> {
    if (attachments.length === 0) return [];
    const out: IncomingAttachment[] = [];
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hb-qq-"));
    for (const att of attachments) {
      let url = att.url;
      if (!url) continue;
      // QQ media urls sometimes omit the scheme.
      if (url.startsWith("//")) url = `https:${url}`;
      else if (!/^https?:\/\//.test(url)) url = `https://${url}`;
      try {
        const bytes = await downloadUrl(url);
        const safeName = (att.filename ?? "file").replace(/[^\w.-]+/g, "_") || "file";
        const dest = path.join(dir, `${out.length}-${safeName}`);
        await fsp.writeFile(dest, bytes);
        const mime = att.content_type ?? "application/octet-stream";
        out.push({
          kind: mime.startsWith("image/")
            ? "image"
            : mime.startsWith("video/")
              ? "video"
              : mime.startsWith("audio/")
                ? "voice"
                : "file",
          sourcePath: dest,
          name: safeName,
          mimeType: mime,
          sizeBytes: att.size ?? bytes.length,
        });
      } catch (err) {
        this.#logger?.warn?.(`qq: failed to download attachment (${this.key})`, err);
      }
    }
    return out;
  }

  #isAllowed(senderId: string): boolean {
    if (this.#allowFrom.size === 0) return true;
    return this.#allowFrom.has(senderId.trim().toLowerCase());
  }
}

/**
 * Validate QQ bot credentials by fetching an app access token. A successful token
 * grant proves the appId + appSecret pair is valid before we persist + connect.
 */
export async function validateQQCredentials(
  appId: string,
  appSecret: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch("https://bots.qq.com/app/getAppAccessToken", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: appId.trim(), clientSecret: appSecret.trim() }),
      signal: AbortSignal.timeout(10000),
    });
    const data = (await response.json()) as {
      access_token?: string;
      code?: number;
      message?: string;
    };
    if (data.access_token) return { ok: true };
    return { ok: false, error: data.message ?? `HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function downloadUrl(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`qq download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function normalizeAllowlist(values: string[]): Set<string> {
  const out = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (normalized) out.add(normalized);
  }
  return out;
}
