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
import { markdownToDiscord } from "../format/discord.js";

const DISCORD_CAPABILITIES: ChannelCapabilities = {
  editMessages: false, // v1: buffer-final (edit-in-place streaming is a follow-up)
  finalizeByResend: false,
  reactions: true, // 👀 received / ✅ done / ❌ failed
  typing: true,
  typingRefreshMs: 8000, // a Discord typing indicator lasts ~10s; refresh under that
  markdown: "discord",
  maxMessageLength: 2000, // Discord's hard per-message limit
  lengthUnit: "codepoints",
  interactiveButtons: false,
  threads: true,
  media: { image: true, document: true, voice: true, video: true },
};

const DISCORD_ACK_EMOJIS = { received: "👀", done: "✅", failed: "❌" } as const;

const DISCORD_API_BASE = "https://discord.com/api/v10";

/**
 * Permissions bitfield for the one-click bot invite: View Channels (1<<10),
 * Send Messages (1<<11), Embed Links (1<<14), Attach Files (1<<15),
 * Read Message History (1<<16), Add Reactions (1<<6). Kept minimal so the
 * authorize screen reads as harmless.
 */
export const DISCORD_INVITE_PERMISSIONS = String(
  (1 << 10) | (1 << 11) | (1 << 14) | (1 << 15) | (1 << 16) | (1 << 6),
);

/** Build the one-click "add the bot to your server" OAuth2 URL from the app id. */
export function discordInviteUrl(clientId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&permissions=${DISCORD_INVITE_PERMISSIONS}&scope=bot`;
}

interface DiscordConnectorOptions {
  config: ChannelConnectionConfig;
  logger?: LoggerLike;
}

// ── Structural slices of discord.js (lazily imported) ────────────────────────
// Kept local so the gateway package needs no compile-time dependency on the
// SDK's large type surface (mirrors the Feishu connector's approach).
interface DiscordAttachmentLike {
  name: string | null;
  url: string;
  contentType?: string | null;
  size?: number;
}
interface DiscordUserLike {
  id: string;
  username?: string;
  bot?: boolean;
}
interface DiscordReactionUsersLike {
  remove(userId: string): Promise<unknown>;
}
interface DiscordMessageReactionsLike {
  resolve(emoji: string): { users: DiscordReactionUsersLike } | null;
}
interface DiscordMessageLike {
  id: string;
  content: string;
  author: DiscordUserLike;
  channelId: string;
  guildId?: string | null;
  attachments: { values(): IterableIterator<DiscordAttachmentLike> };
  mentions: { has(user: DiscordUserLike): boolean };
  react(emoji: string): Promise<unknown>;
  reactions: DiscordMessageReactionsLike;
  channel?: { name?: string };
}
interface DiscordSendOptions {
  content: string;
  allowedMentions?: { repliedUser?: boolean; parse?: string[] };
  files?: Array<{ attachment: Buffer; name: string }>;
}
interface DiscordChannelLike {
  id: string;
  send(options: DiscordSendOptions): Promise<{ id: string }>;
  sendTyping(): Promise<void>;
  messages: { fetch(id: string): Promise<DiscordMessageLike> };
}
interface DiscordClientLike {
  user: DiscordUserLike | null;
  login(token: string): Promise<string>;
  destroy(): Promise<void> | void;
  once(event: string, handler: (...args: unknown[]) => void): unknown;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  channels: { fetch(id: string): Promise<DiscordChannelLike | null> };
}
interface DiscordSdk {
  Client: new (opts: { intents: number[]; partials?: number[] }) => DiscordClientLike;
  GatewayIntentBits: Record<string, number>;
  Partials: Record<string, number>;
  Events: Record<string, string>;
}

/**
 * Discord connector over discord.js's Gateway WebSocket. The SDK is dynamically
 * imported so it only loads when a Discord connection is configured. Buffer-final
 * replies; reactions (👀/✅/❌) and a typing heartbeat are driven by the egress via
 * the capability flags. Group channels respond only when the bot is @mentioned
 * (default); DMs always respond.
 */
export class DiscordConnector implements ChannelConnector {
  readonly platform = "discord" as const;
  readonly connectionId: string;
  readonly capabilities = DISCORD_CAPABILITIES;
  readonly ackEmojis = DISCORD_ACK_EMOJIS;

  readonly #token: string;
  readonly #workspaceId: string | null;
  readonly #allowFrom: Set<string>;
  readonly #requireMention: boolean;
  readonly #logger?: LoggerLike;

  #handler: IncomingMessageHandler | null = null;
  #client: DiscordClientLike | null = null;
  #botId = "";

  constructor(options: DiscordConnectorOptions) {
    const { config } = options;
    if (!config.token) throw new Error("discord connector requires a bot token");
    this.connectionId = config.connectionId;
    this.#token = config.token;
    this.#workspaceId = config.workspaceId ?? null;
    this.#allowFrom = normalizeAllowlist(config.allowFrom ?? []);
    // Server channels respond only when the bot is @mentioned, unless disabled.
    this.#requireMention = config.requireMention ?? true;
    this.#logger = options.logger;
  }

  get key(): string {
    return `discord:${this.#workspaceId ?? "?"}:${this.connectionId}`;
  }

  fingerprint(): string {
    return createHash("sha256")
      .update(
        [
          this.platform,
          this.connectionId,
          this.#workspaceId ?? "",
          this.#token,
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
    return markdownToDiscord(text);
  }

  async start(): Promise<void> {
    const discord = (await import("discord.js")) as unknown as DiscordSdk;
    const { GatewayIntentBits: Intents, Partials, Events } = discord;
    const client = new discord.Client({
      intents: [
        Intents.Guilds,
        Intents.GuildMessages,
        // No MessageContent (privileged) intent: Discord still delivers content +
        // attachments for DMs, @mentions of the bot, and the bot's own messages —
        // which is exactly what this connector acts on (guild messages are gated
        // on @mention). Skipping it removes the privileged-intent toggle + the
        // 100-server verification gate from onboarding. (Setting requireMention
        // false to answer ALL channel messages would require enabling it.)
        Intents.DirectMessages,
        Intents.GuildMessageReactions,
        Intents.DirectMessageReactions,
      ],
      // Partials let us receive DM and uncached message/reaction events.
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });

    const ready = new Promise<void>((resolve) => {
      // discord.js v14 emits ClientReady; tolerate the older "ready" string too.
      client.once(Events.ClientReady ?? "ready", () => resolve());
    });
    client.on(Events.MessageCreate ?? "messageCreate", (...args: unknown[]) => {
      void this.#onMessage(args[0] as DiscordMessageLike);
    });
    client.on(Events.Error ?? "error", (...args: unknown[]) => {
      this.#logger?.warn?.(`discord: client error (${this.key})`, args[0]);
    });

    await client.login(this.#token);
    await ready;
    this.#client = client;
    this.#botId = client.user?.id ?? "";
    this.#logger?.info?.(
      `discord: connected as ${client.user?.username ?? "bot"} (${this.key})`,
    );
  }

  async stop(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#botId = "";
    if (client) {
      try {
        await client.destroy();
      } catch {
        // ignore
      }
    }
  }

  async sendText(target: OutgoingTarget, text: string): Promise<SendResult> {
    const channel = await this.#channel(target.chatId);
    if (!channel) return { ok: false, error: "discord channel not found" };
    try {
      const sent = await channel.send({
        content: text,
        // Never ping @everyone/@here or roles from agent output.
        allowedMentions: { repliedUser: false, parse: [] },
      });
      return { ok: true, messageId: sent.id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Send a local file as a native Discord attachment (images render inline). */
  async sendMedia(
    target: OutgoingTarget,
    file: OutgoingMedia,
    caption?: string,
  ): Promise<SendResult> {
    const channel = await this.#channel(target.chatId);
    if (!channel) return { ok: false, error: "discord channel not found" };
    try {
      const bytes = await fsp.readFile(file.path);
      const sent = await channel.send({
        content: caption && caption.trim() ? caption : "",
        files: [{ attachment: bytes, name: file.name ?? path.basename(file.path) }],
        allowedMentions: { repliedUser: false, parse: [] },
      });
      return { ok: true, messageId: sent.id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    const channel = await this.#channel(chatId);
    await channel?.sendTyping().catch(() => {});
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    try {
      const message = await this.#message(chatId, messageId);
      await message?.react(emoji);
    } catch (err) {
      this.#logger?.debug?.(`discord: react '${emoji}' failed (${this.key})`, err);
    }
  }

  async unreact(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.#botId) return;
    try {
      const message = await this.#message(chatId, messageId);
      await message?.reactions.resolve(emoji)?.users.remove(this.#botId);
    } catch (err) {
      this.#logger?.debug?.(`discord: unreact '${emoji}' failed (${this.key})`, err);
    }
  }

  async #channel(chatId: string): Promise<DiscordChannelLike | null> {
    const client = this.#client;
    if (!client) return null;
    try {
      return await client.channels.fetch(chatId);
    } catch (err) {
      this.#logger?.warn?.(`discord: channel fetch failed (${this.key})`, err);
      return null;
    }
  }

  async #message(chatId: string, messageId: string): Promise<DiscordMessageLike | null> {
    const channel = await this.#channel(chatId);
    if (!channel) return null;
    return channel.messages.fetch(messageId);
  }

  async #onMessage(message: DiscordMessageLike): Promise<void> {
    const handler = this.#handler;
    const client = this.#client;
    if (!handler || !client?.user) return;
    if (message.author.bot || message.author.id === this.#botId) return; // ignore bots + self

    const senderId = message.author.id;
    const senderName = message.author.username ?? "";
    if (!this.#isAllowed(senderId, senderName)) {
      this.#logger?.info?.(`discord: dropping message from disallowed sender (${this.key})`);
      return;
    }

    const isDm = !message.guildId;
    if (!isDm && this.#requireMention && !message.mentions.has(client.user)) return;

    // Strip a leading bot @mention so the agent gets a clean prompt, not "<@id> hi".
    const text = stripMention(message.content ?? "", this.#botId).trim();
    let attachments: IncomingAttachment[] = [];
    try {
      attachments = await this.#downloadMedia(message);
    } catch (err) {
      this.#logger?.warn?.("discord: media download failed", err);
    }
    if (!text && attachments.length === 0) {
      if (!isDm) return;
      // In a DM with no text + no attachment there's nothing to do; but an empty
      // content in a *guild* usually means the Message Content intent is off.
      return;
    }

    const incoming: IncomingMessage = {
      platform: "discord",
      connectionId: this.connectionId,
      workspaceId: this.#workspaceId ?? "",
      chatId: message.channelId,
      chatType: isDm ? "dm" : "group",
      chatTitle: message.channel?.name,
      userId: senderId,
      userName: senderName || undefined,
      text,
      messageId: message.id,
      updateId: message.id, // Discord has no update_id; message id keys idempotency
      attachments,
      raw: message,
    };
    try {
      await handler(incoming);
    } catch (err) {
      this.#logger?.error?.("discord: inbound handler failed", err);
    }
  }

  async #downloadMedia(message: DiscordMessageLike): Promise<IncomingAttachment[]> {
    const specs = [...message.attachments.values()];
    if (specs.length === 0) return [];
    const out: IncomingAttachment[] = [];
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hb-discord-"));
    for (const att of specs) {
      try {
        const bytes = await downloadUrl(att.url);
        const safeName = (att.name ?? "file").replace(/[^\w.-]+/g, "_") || "file";
        const dest = path.join(dir, `${out.length}-${safeName}`);
        await fsp.writeFile(dest, bytes);
        const mime = att.contentType ?? "application/octet-stream";
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
        this.#logger?.warn?.(`discord: failed to download attachment (${this.key})`, err);
      }
    }
    return out;
  }

  #isAllowed(senderId: string, senderName: string): boolean {
    if (this.#allowFrom.size === 0) return true;
    const id = senderId.trim().toLowerCase();
    const name = senderName.trim().replace(/^@/, "").toLowerCase();
    return (id !== "" && this.#allowFrom.has(id)) || (name !== "" && this.#allowFrom.has(name));
  }
}

/**
 * Validate a Discord bot token by calling /users/@me. Returns the bot username +
 * the application/client id (a bot's user id equals its application id) so the UI
 * can confirm "Connected as <bot>" and build the one-click invite URL.
 */
export async function validateDiscordToken(
  token: string,
): Promise<{ ok: boolean; username?: string; botId?: string; inviteUrl?: string; error?: string }> {
  try {
    const response = await fetch(`${DISCORD_API_BASE}/users/@me`, {
      headers: { authorization: `Bot ${token.trim()}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const data = (await response.json()) as { id?: string; username?: string };
    if (!data?.id) return { ok: false, error: "Discord did not return a bot identity." };
    return {
      ok: true,
      username: data.username,
      botId: data.id,
      inviteUrl: discordInviteUrl(data.id),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function downloadUrl(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`discord download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** Remove a leading `<@id>` / `<@!id>` bot mention from message content. */
function stripMention(content: string, botId: string): string {
  if (!botId) return content;
  return content.replace(new RegExp(`<@!?${botId}>`, "g"), "");
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
