import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ChannelConnectionConfig } from "../config.js";
import type {
  ChannelCapabilities,
  ChannelConnector,
  IncomingAttachment,
  IncomingMessage,
  IncomingMessageHandler,
  OutgoingMedia,
  OutgoingTarget,
  SendResult,
} from "../connector.js";
import type { LoggerLike } from "../egress.js";
import { markdownToTelegramHtml } from "../format/telegram-html.js";

const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  editMessages: true, // live edit-in-place token streaming via editMessageText
  finalizeByResend: false,
  reactions: true,
  typing: true,
  typingRefreshMs: 4000,
  markdown: "html",
  maxMessageLength: 4096,
  lengthUnit: "utf16", // Telegram counts UTF-16 code units
  interactiveButtons: false,
  threads: true,
  media: { image: true, document: true, voice: true, video: true },
};

interface TelegramConnectorOptions {
  config: ChannelConnectionConfig;
  logger?: LoggerLike;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}
interface TgMessage {
  message_id?: number;
  text?: string;
  caption?: string;
  message_thread_id?: number;
  chat?: TgChat;
  from?: TgUser;
  photo?: TgPhotoSize[];
  document?: TgFile;
  voice?: TgFile;
  video?: TgFile;
  audio?: TgFile;
}
interface TgPhotoSize {
  file_id: string;
  file_unique_id?: string;
}
interface TgFile {
  file_id: string;
  file_name?: string;
  mime_type?: string;
}
interface TgChat {
  id: number | string;
  type?: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}
interface TgUser {
  id?: number | string;
  username?: string;
}

/**
 * Telegram connector over the raw Bot API (long-polling `getUpdates`). Zero extra
 * runtime dependencies — uses global `fetch`. Buffer-final reply strategy; reactions
 * (👀/👍/👎) and a typing heartbeat are driven by the egress via the capability flags.
 */
export class TelegramConnector implements ChannelConnector {
  readonly platform = "telegram" as const;
  readonly connectionId: string;
  readonly capabilities = TELEGRAM_CAPABILITIES;
  readonly ackEmojis = { received: "👀", done: "👍", failed: "👎" };

  readonly #token: string;
  readonly #baseUrl: string;
  readonly #workspaceId: string | null;
  readonly #allowFrom: Set<string>;
  readonly #logger?: LoggerLike;

  #handler: IncomingMessageHandler | null = null;
  #stopped = false;
  #offset = 0;
  #loop: Promise<void> | null = null;
  #pollAbort: AbortController | null = null;

  constructor(options: TelegramConnectorOptions) {
    const { config } = options;
    if (!config.token) throw new Error("telegram connector requires a token");
    this.connectionId = config.connectionId;
    this.#token = config.token;
    this.#baseUrl = (config.apiBaseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.#workspaceId = config.workspaceId ?? null;
    this.#allowFrom = normalizeAllowlist(config.allowFrom ?? []);
    this.#logger = options.logger;
  }

  get key(): string {
    return `telegram:${this.#workspaceId ?? "?"}:${this.connectionId}`;
  }

  fingerprint(): string {
    return createHash("sha256")
      .update(
        [
          this.platform,
          this.connectionId,
          this.#workspaceId ?? "",
          this.#token,
          [...this.#allowFrom].sort().join(","),
        ].join("|"),
      )
      .digest("hex");
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.#handler = handler;
  }

  format(text: string): string {
    return markdownToTelegramHtml(text);
  }

  async start(): Promise<void> {
    const me = (await this.#call("getMe", {})) as { username?: string };
    this.#logger?.info?.(`telegram: connected as @${me?.username ?? "unknown"} (${this.key})`);
    this.#stopped = false;
    this.#loop = this.#pollLoop();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#pollAbort?.abort();
    if (this.#loop) {
      await this.#loop.catch(() => {});
      this.#loop = null;
    }
  }

  async sendText(target: OutgoingTarget, text: string): Promise<SendResult> {
    const base: Record<string, unknown> = { chat_id: target.chatId, text };
    if (target.threadId) base.message_thread_id = Number(target.threadId);
    try {
      const res = (await this.#call("sendMessage", { ...base, parse_mode: "HTML" })) as {
        message_id?: number;
      };
      return { ok: true, messageId: res?.message_id != null ? String(res.message_id) : undefined };
    } catch (err) {
      // HTML parse-mode rejections → retry as plain text so the user still gets a reply.
      this.#logger?.warn?.("telegram: HTML send failed, retrying as plain text", err);
      try {
        const res = (await this.#call("sendMessage", base)) as { message_id?: number };
        return { ok: true, messageId: res?.message_id != null ? String(res.message_id) : undefined };
      } catch (err2) {
        return { ok: false, error: String(err2) };
      }
    }
  }

  async editText(
    target: OutgoingTarget,
    messageId: string,
    text: string,
    _options?: { finalize?: boolean },
  ): Promise<SendResult> {
    const base: Record<string, unknown> = {
      chat_id: target.chatId,
      message_id: Number(messageId),
      text,
    };
    try {
      const res = (await this.#call("editMessageText", {
        ...base,
        parse_mode: "HTML",
      })) as { message_id?: number };
      return {
        ok: true,
        messageId: res?.message_id != null ? String(res.message_id) : messageId,
      };
    } catch (err) {
      const detail = String(err);
      // Editing to identical content is a benign no-op — treat it as success so
      // the stream throttle doesn't back off on it.
      if (detail.includes("message is not modified")) return { ok: true, messageId };
      // HTML parse-mode rejection → retry as plain text so streaming still shows.
      this.#logger?.debug?.("telegram: HTML edit failed, retrying as plain text", err);
      try {
        const res = (await this.#call("editMessageText", base)) as { message_id?: number };
        return {
          ok: true,
          messageId: res?.message_id != null ? String(res.message_id) : messageId,
        };
      } catch (err2) {
        return { ok: false, error: String(err2) };
      }
    }
  }

  async sendMedia(
    target: OutgoingTarget,
    file: OutgoingMedia,
    caption?: string,
  ): Promise<SendResult> {
    const sendByKind: Record<
      OutgoingMedia["kind"],
      { method: string; field: string }
    > = {
      image: { method: "sendPhoto", field: "photo" },
      video: { method: "sendVideo", field: "video" },
      voice: { method: "sendVoice", field: "voice" },
      document: { method: "sendDocument", field: "document" },
    };
    const primary = sendByKind[file.kind] ?? sendByKind.document;
    const attempt = async (method: string, field: string): Promise<SendResult> => {
      const bytes = await fsp.readFile(file.path);
      const form = new FormData();
      form.set("chat_id", target.chatId);
      if (target.threadId) form.set("message_thread_id", target.threadId);
      if (caption && caption.trim()) form.set("caption", caption.slice(0, 1024));
      const blob = file.mimeType
        ? new Blob([bytes], { type: file.mimeType })
        : new Blob([bytes]);
      form.set(field, blob, file.name ?? path.basename(file.path));
      const res = (await this.#callForm(method, form)) as { message_id?: number };
      return {
        ok: true,
        messageId: res?.message_id != null ? String(res.message_id) : undefined,
      };
    };
    try {
      return await attempt(primary.method, primary.field);
    } catch (err) {
      // sendPhoto/sendVideo/sendVoice can reject (too large, unsupported type) —
      // fall back to a plain document so the user still receives the file.
      if (primary.method !== "sendDocument") {
        try {
          return await attempt("sendDocument", "document");
        } catch (err2) {
          return { ok: false, error: String(err2) };
        }
      }
      return { ok: false, error: String(err) };
    }
  }

  async sendTyping(chatId: string, threadId?: string): Promise<void> {
    const params: Record<string, unknown> = { chat_id: chatId, action: "typing" };
    if (threadId) params.message_thread_id = Number(threadId);
    await this.#call("sendChatAction", params).catch(() => {});
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    await this.#call("setMessageReaction", {
      chat_id: chatId,
      message_id: Number(messageId),
      reaction: [{ type: "emoji", emoji }],
    });
  }

  async unreact(chatId: string, messageId: string): Promise<void> {
    await this.#call("setMessageReaction", {
      chat_id: chatId,
      message_id: Number(messageId),
      reaction: [],
    });
  }

  async #pollLoop(): Promise<void> {
    let backoffMs = 1000;
    while (!this.#stopped) {
      this.#pollAbort = new AbortController();
      try {
        const updates = (await this.#call(
          "getUpdates",
          { offset: this.#offset, timeout: 25, allowed_updates: ["message"] },
          this.#pollAbort.signal,
          30000,
        )) as TgUpdate[] | null;
        backoffMs = 1000;
        for (const update of updates ?? []) {
          this.#offset = Math.max(this.#offset, update.update_id + 1);
          await this.#dispatch(update);
        }
      } catch (err) {
        if (this.#stopped) break;
        this.#logger?.warn?.(
          `telegram: getUpdates error (${this.key}); backing off ${backoffMs}ms`,
          err,
        );
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30000);
      }
    }
  }

  async #dispatch(update: TgUpdate): Promise<void> {
    const message = update.message;
    const handler = this.#handler;
    if (!message || !handler) return;

    const chat = message.chat;
    if (!chat) return;

    const from = message.from;
    const senderId = from?.id != null ? String(from.id) : "";
    const senderUsername = typeof from?.username === "string" ? from.username : "";
    if (!this.#isAllowed(senderId, senderUsername)) {
      this.#logger?.info?.(`telegram: dropping message from disallowed sender (${this.key})`);
      return;
    }

    // Bot commands (/start, /help, …) are Telegram chrome, not agent input — answer
    // them locally so the agent never sees "/start" and replies "not a skill".
    const directText = typeof message.text === "string" ? message.text.trim() : "";
    if (directText.startsWith("/")) {
      await this.#handleCommand(directText, message, chat);
      return;
    }

    // Photos/files carry their text in `caption`; media-only messages have neither.
    const text = directText || (typeof message.caption === "string" ? message.caption.trim() : "");
    let attachments: IncomingAttachment[] = [];
    try {
      attachments = await this.#downloadMedia(message);
    } catch (err) {
      this.#logger?.warn?.("telegram: media download failed", err);
    }
    if (!text && attachments.length === 0) return;

    const chatTitle =
      (chat.title ??
        chat.username ??
        [chat.first_name, chat.last_name].filter(Boolean).join(" ")) ||
      undefined;

    const incoming: IncomingMessage = {
      platform: "telegram",
      connectionId: this.connectionId,
      workspaceId: this.#workspaceId ?? "",
      chatId: String(chat.id),
      chatType: mapChatType(chat.type),
      threadId: message.message_thread_id != null ? String(message.message_thread_id) : undefined,
      chatTitle,
      userId: senderId,
      userName: senderUsername || undefined,
      text,
      messageId: message.message_id != null ? String(message.message_id) : undefined,
      updateId: update.update_id,
      attachments,
      raw: update,
    };

    try {
      await handler(incoming);
    } catch (err) {
      this.#logger?.error?.("telegram: inbound handler failed", err);
    }
  }

  async #handleCommand(text: string, message: TgMessage, chat: TgChat): Promise<void> {
    const command = text.split(/\s+/)[0]?.split("@")[0]?.toLowerCase() ?? "";
    const target: OutgoingTarget = {
      chatId: String(chat.id),
      threadId: message.message_thread_id != null ? String(message.message_thread_id) : undefined,
    };
    let reply: string;
    if (command === "/start") {
      reply =
        "👋 Hi! I'm your agent. Send me a message — a question, a task, a photo, or a file — and I'll help. Talk to me here like any chat; there are no commands to learn.";
    } else if (command === "/help") {
      reply =
        "Just send me a normal message and I'll help. You can also send photos and files — no special commands needed.";
    } else {
      reply = `I don't use the ${command} command — just send me a normal message and I'll help.`;
    }
    await this.sendText(target, reply).catch((err) => {
      this.#logger?.warn?.("telegram: failed to reply to command", err);
    });
  }

  async #downloadMedia(message: TgMessage): Promise<IncomingAttachment[]> {
    const specs: Array<{
      fileId: string;
      name: string;
      mime: string;
      kind: IncomingAttachment["kind"];
    }> = [];
    if (Array.isArray(message.photo) && message.photo.length > 0) {
      const largest = message.photo[message.photo.length - 1]!;
      specs.push({
        fileId: largest.file_id,
        name: `photo-${largest.file_unique_id ?? "image"}.jpg`,
        mime: "image/jpeg",
        kind: "image",
      });
    }
    if (message.document?.file_id) {
      specs.push({
        fileId: message.document.file_id,
        name: message.document.file_name ?? "file",
        mime: message.document.mime_type ?? "application/octet-stream",
        kind: "file",
      });
    }
    if (message.voice?.file_id) {
      specs.push({
        fileId: message.voice.file_id,
        name: "voice.ogg",
        mime: message.voice.mime_type ?? "audio/ogg",
        kind: "voice",
      });
    }
    if (message.video?.file_id) {
      specs.push({
        fileId: message.video.file_id,
        name: message.video.file_name ?? "video.mp4",
        mime: message.video.mime_type ?? "video/mp4",
        kind: "video",
      });
    }
    if (message.audio?.file_id) {
      specs.push({
        fileId: message.audio.file_id,
        name: message.audio.file_name ?? "audio.mp3",
        mime: message.audio.mime_type ?? "audio/mpeg",
        kind: "file",
      });
    }
    if (specs.length === 0) return [];

    const out: IncomingAttachment[] = [];
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hb-tg-"));
    for (const spec of specs) {
      try {
        const file = (await this.#call("getFile", { file_id: spec.fileId })) as {
          file_path?: string;
        };
        if (!file?.file_path) continue;
        const bytes = await this.#downloadFile(file.file_path);
        const safeName = spec.name.replace(/[^\w.-]+/g, "_") || "file";
        const dest = path.join(dir, `${out.length}-${safeName}`);
        await fsp.writeFile(dest, bytes);
        out.push({
          kind: spec.kind,
          sourcePath: dest,
          name: safeName,
          mimeType: spec.mime,
          sizeBytes: bytes.length,
        });
      } catch (err) {
        this.#logger?.warn?.(`telegram: failed to download ${spec.kind}`, err);
      }
    }
    return out;
  }

  async #downloadFile(filePath: string): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`${this.#baseUrl}/file/bot${this.#token}/${filePath}`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`telegram file download failed: ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }

  #isAllowed(senderId: string, senderUsername: string): boolean {
    if (this.#allowFrom.size === 0) return true;
    const id = senderId.trim().toLowerCase();
    const username = senderUsername.trim().replace(/^@/, "").toLowerCase();
    return (id !== "" && this.#allowFrom.has(id)) || (username !== "" && this.#allowFrom.has(username));
  }

  async #call(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 15000,
  ): Promise<unknown> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.#baseUrl}/bot${this.#token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      const data = (await response.json()) as {
        ok: boolean;
        result?: unknown;
        description?: string;
      };
      if (!data.ok) {
        throw new Error(`telegram ${method} failed: ${data.description ?? response.status}`);
      }
      return data.result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  // Multipart variant of #call for media uploads — fetch sets the multipart
  // content-type + boundary from the FormData body. Longer timeout for files.
  async #callForm(
    method: string,
    form: FormData,
    timeoutMs = 60000,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.#baseUrl}/bot${this.#token}/${method}`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      const data = (await response.json()) as {
        ok: boolean;
        result?: unknown;
        description?: string;
      };
      if (!data.ok) {
        throw new Error(
          `telegram ${method} failed: ${data.description ?? response.status}`,
        );
      }
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Validate a Telegram bot token by calling getMe. Returns the bot username on
 * success so the UI can confirm "Connected as @bot" the instant a token is pasted.
 */
export async function validateTelegramToken(
  token: string,
  apiBaseUrl?: string,
): Promise<{ ok: boolean; username?: string; error?: string }> {
  const base = (apiBaseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
  try {
    const response = await fetch(`${base}/bot${token}/getMe`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
    });
    const data = (await response.json()) as {
      ok: boolean;
      result?: { username?: string };
      description?: string;
    };
    if (!data.ok) return { ok: false, error: data.description ?? `HTTP ${response.status}` };
    return { ok: true, username: data.result?.username };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function normalizeAllowlist(values: string[]): Set<string> {
  const out = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized) continue;
    out.add(normalized.replace(/^@/, ""));
    out.add(normalized);
  }
  return out;
}

function mapChatType(type: string | undefined): IncomingMessage["chatType"] {
  switch (type) {
    case "private":
      return "dm";
    case "channel":
      return "channel";
    case "group":
    case "supergroup":
    default:
      return "group";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
