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
import { markdownToSlack } from "../format/slack.js";

const SLACK_CAPABILITIES: ChannelCapabilities = {
  editMessages: false, // v1: buffer-final
  finalizeByResend: false,
  reactions: true, // 👀 received / ✅ done / ❌ failed (Slack reaction names)
  typing: false, // Slack has no bot typing indicator — status is conveyed via reactions
  typingRefreshMs: 0,
  markdown: "mrkdwn",
  maxMessageLength: 39000, // Slack's 40k hard limit with headroom
  lengthUnit: "codepoints",
  interactiveButtons: false,
  threads: true,
  media: { image: true, document: true, voice: true, video: true },
};

// Slack reaction *names* (no surrounding colons), not Unicode.
const SLACK_ACK_EMOJIS = { received: "eyes", done: "white_check_mark", failed: "x" } as const;

const SLACK_API_BASE = "https://slack.com/api";

interface SlackConnectorOptions {
  config: ChannelConnectionConfig;
  logger?: LoggerLike;
}

// ── Structural slices of @slack/web-api + @slack/socket-mode (lazily imported) ─
interface SlackWebClientLike {
  auth: { test(): Promise<{ user_id?: string; user?: string; team?: string }> };
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
      mrkdwn?: boolean;
      thread_ts?: string;
    }): Promise<{ ts?: string }>;
  };
  reactions: {
    add(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
    remove(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
  };
  files: {
    uploadV2(args: {
      channel_id: string;
      file: Buffer;
      filename: string;
      initial_comment?: string;
      thread_ts?: string;
    }): Promise<unknown>;
  };
}
interface SlackSocketClientLike {
  on(event: string, handler: (envelope: SlackEnvelope) => void | Promise<void>): unknown;
  start(): Promise<unknown>;
  disconnect(): Promise<unknown>;
}
interface SlackFile {
  id?: string;
  name?: string;
  mimetype?: string;
  url_private_download?: string;
  url_private?: string;
  size?: number;
}
interface SlackMessageEvent {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  files?: SlackFile[];
}
interface SlackEnvelope {
  ack: () => Promise<void>;
  event?: SlackMessageEvent;
}
interface SlackWebApiSdk {
  WebClient: new (token: string) => SlackWebClientLike;
}
interface SlackSocketModeSdk {
  SocketModeClient: new (opts: { appToken: string }) => SlackSocketClientLike;
}

/**
 * Slack connector over Socket Mode (no public URL). The bot token (`xoxb-…`)
 * drives the Web API for sends/reactions/downloads; the app-level token
 * (`xapp-…`) drives the Socket Mode WebSocket for inbound events. Both SDKs are
 * dynamically imported so they only load when a Slack connection exists. Buffer-
 * final replies; channels respond only when the bot is @mentioned (default).
 */
export class SlackConnector implements ChannelConnector {
  readonly platform = "slack" as const;
  readonly connectionId: string;
  readonly capabilities = SLACK_CAPABILITIES;
  readonly ackEmojis = SLACK_ACK_EMOJIS;

  readonly #botToken: string;
  readonly #appToken: string;
  readonly #workspaceId: string | null;
  readonly #allowFrom: Set<string>;
  readonly #requireMention: boolean;
  readonly #logger?: LoggerLike;

  #handler: IncomingMessageHandler | null = null;
  #web: SlackWebClientLike | null = null;
  #socket: SlackSocketClientLike | null = null;
  #botUserId = "";

  constructor(options: SlackConnectorOptions) {
    const { config } = options;
    if (!config.token) throw new Error("slack connector requires a bot token");
    if (!config.appToken) throw new Error("slack connector requires an app-level token");
    this.connectionId = config.connectionId;
    this.#botToken = config.token;
    this.#appToken = config.appToken;
    this.#workspaceId = config.workspaceId ?? null;
    this.#allowFrom = normalizeAllowlist(config.allowFrom ?? []);
    this.#requireMention = config.requireMention ?? true;
    this.#logger = options.logger;
  }

  get key(): string {
    return `slack:${this.#workspaceId ?? "?"}:${this.connectionId}`;
  }

  fingerprint(): string {
    return createHash("sha256")
      .update(
        [
          this.platform,
          this.connectionId,
          this.#workspaceId ?? "",
          this.#botToken,
          this.#appToken,
          String(this.#requireMention),
          [...this.#allowFrom].sort().join(","),
        ].join("|"),
      )
      .digest("hex");
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.#handler = handler;
  }

  format(text: string): string {
    return markdownToSlack(text);
  }

  async start(): Promise<void> {
    const webApi = (await import("@slack/web-api")) as unknown as SlackWebApiSdk;
    const socketMode = (await import("@slack/socket-mode")) as unknown as SlackSocketModeSdk;
    const web = new webApi.WebClient(this.#botToken);
    const identity = await web.auth.test();
    this.#botUserId = identity.user_id ?? "";

    const socket = new socketMode.SocketModeClient({ appToken: this.#appToken });
    socket.on("message", (envelope) => this.#onEnvelope(envelope));
    await socket.start();

    this.#web = web;
    this.#socket = socket;
    this.#logger?.info?.(
      `slack: connected as ${identity.user ?? "bot"} on ${identity.team ?? "workspace"} (${this.key})`,
    );
  }

  async stop(): Promise<void> {
    const socket = this.#socket;
    this.#socket = null;
    this.#web = null;
    this.#botUserId = "";
    if (socket) {
      try {
        await socket.disconnect();
      } catch {
        // ignore
      }
    }
  }

  async sendText(target: OutgoingTarget, text: string): Promise<SendResult> {
    const web = this.#web;
    if (!web) return { ok: false, error: "slack not connected" };
    try {
      const res = await web.chat.postMessage({
        channel: target.chatId,
        text,
        mrkdwn: true,
        ...(target.threadId ? { thread_ts: target.threadId } : {}),
      });
      return { ok: true, messageId: res.ts };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Upload a local file to the channel via files.uploadV2 (the caption rides as
   *  the file's initial_comment). Works for any file type Slack accepts. */
  async sendMedia(
    target: OutgoingTarget,
    file: OutgoingMedia,
    caption?: string,
  ): Promise<SendResult> {
    const web = this.#web;
    if (!web) return { ok: false, error: "slack not connected" };
    try {
      const bytes = await fsp.readFile(file.path);
      await web.files.uploadV2({
        channel_id: target.chatId,
        file: bytes,
        filename: file.name ?? path.basename(file.path),
        ...(caption && caption.trim() ? { initial_comment: caption } : {}),
        ...(target.threadId ? { thread_ts: target.threadId } : {}),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    try {
      await this.#web?.reactions.add({ channel: chatId, timestamp: messageId, name: emoji });
    } catch (err) {
      this.#logger?.debug?.(`slack: react '${emoji}' failed (${this.key})`, err);
    }
  }

  async unreact(chatId: string, messageId: string, emoji: string): Promise<void> {
    try {
      await this.#web?.reactions.remove({ channel: chatId, timestamp: messageId, name: emoji });
    } catch (err) {
      this.#logger?.debug?.(`slack: unreact '${emoji}' failed (${this.key})`, err);
    }
  }

  async #onEnvelope(envelope: SlackEnvelope): Promise<void> {
    // Socket Mode requires acknowledging every event promptly, before any work.
    try {
      await envelope.ack();
    } catch {
      // ignore — Slack will redeliver if needed; idempotency is keyed on ts
    }
    const event = envelope.event;
    const handler = this.#handler;
    if (!event || !handler) return;
    // Ignore bot messages (incl. our own) and edits/joins/etc (subtype set).
    if (event.bot_id || event.subtype || (event.user && event.user === this.#botUserId)) return;

    const senderId = event.user ?? "";
    if (!this.#isAllowed(senderId)) {
      this.#logger?.info?.(`slack: dropping disallowed sender (${this.key})`);
      return;
    }

    const isDm = event.channel_type === "im";
    const rawText = event.text ?? "";
    if (!isDm && this.#requireMention && !mentions(rawText, this.#botUserId)) return;

    const text = stripMention(rawText, this.#botUserId).trim();
    let attachments: IncomingAttachment[] = [];
    try {
      attachments = await this.#downloadFiles(event.files ?? []);
    } catch (err) {
      this.#logger?.warn?.("slack: file download failed", err);
    }
    if (!text && attachments.length === 0) return;
    if (!event.channel || !event.ts) return;

    const incoming: IncomingMessage = {
      platform: "slack",
      connectionId: this.connectionId,
      workspaceId: this.#workspaceId ?? "",
      chatId: event.channel,
      chatType: isDm ? "dm" : "group",
      threadId: event.thread_ts,
      userId: senderId,
      text,
      messageId: event.ts,
      updateId: event.ts, // Slack has no update_id; the message ts keys idempotency
      attachments,
      raw: event,
    };
    try {
      await handler(incoming);
    } catch (err) {
      this.#logger?.error?.("slack: inbound handler failed", err);
    }
  }

  async #downloadFiles(files: SlackFile[]): Promise<IncomingAttachment[]> {
    if (files.length === 0) return [];
    const out: IncomingAttachment[] = [];
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hb-slack-"));
    for (const file of files) {
      const url = file.url_private_download ?? file.url_private;
      if (!url) continue;
      try {
        // Private file URLs require the bot token as a bearer header.
        const bytes = await downloadAuthed(url, this.#botToken);
        const safeName = (file.name ?? "file").replace(/[^\w.-]+/g, "_") || "file";
        const dest = path.join(dir, `${out.length}-${safeName}`);
        await fsp.writeFile(dest, bytes);
        const mime = file.mimetype ?? "application/octet-stream";
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
          sizeBytes: file.size ?? bytes.length,
        });
      } catch (err) {
        this.#logger?.warn?.(`slack: failed to download file (${this.key})`, err);
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
 * Validate a Slack connection before persisting it: the bot token via auth.test
 * and the app-level token via apps.connections.open (the Socket Mode handshake).
 * Returns the bot + workspace names so the UI can confirm "Connected as <bot>".
 */
export async function validateSlackTokens(
  botToken: string,
  appToken: string,
): Promise<{ ok: boolean; botName?: string; teamName?: string; error?: string }> {
  try {
    const auth = await slackPost("auth.test", botToken);
    if (!auth.ok) {
      return { ok: false, error: `Bot token rejected: ${auth.error ?? "auth.test failed"}` };
    }
    const conn = await slackPost("apps.connections.open", appToken);
    if (!conn.ok) {
      return {
        ok: false,
        error: `App-level token rejected: ${conn.error ?? "apps.connections.open failed"}`,
      };
    }
    return {
      ok: true,
      botName: typeof auth.user === "string" ? auth.user : undefined,
      teamName: typeof auth.team === "string" ? auth.team : undefined,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function slackPost(
  method: string,
  token: string,
): Promise<{ ok: boolean; error?: string; user?: unknown; team?: unknown }> {
  const response = await fetch(`${SLACK_API_BASE}/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token.trim()}`, "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(10000),
  });
  return (await response.json()) as { ok: boolean; error?: string; user?: unknown; team?: unknown };
}

async function downloadAuthed(url: string, token: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`slack download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** Does the text contain a Slack `<@USERID>` mention of the bot? */
function mentions(text: string, botUserId: string): boolean {
  if (!botUserId) return false;
  return text.includes(`<@${botUserId}>`);
}

/** Strip a `<@USERID>` bot mention from the message text. */
function stripMention(text: string, botUserId: string): string {
  if (!botUserId) return text;
  return text.replace(new RegExp(`<@${botUserId}>`, "g"), "");
}

function normalizeAllowlist(values: string[]): Set<string> {
  const out = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (normalized) out.add(normalized);
  }
  return out;
}
