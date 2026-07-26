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

const FEISHU_CAPABILITIES: ChannelCapabilities = {
  editMessages: false, // v1: buffer-final (the SDK's stream()/updateCard enable edit-in-place later)
  finalizeByResend: false,
  reactions: true, // emoji reaction acks on the user's message (in-progress / done / failed)
  typing: false,
  typingRefreshMs: 0,
  markdown: "feishu",
  maxMessageLength: 10000,
  lengthUnit: "codepoints",
  interactiveButtons: false,
  threads: true,
  media: { image: true, document: true, voice: true, video: true },
};

// Feishu reaction emoji_type keys (a server-validated string set, not Unicode).
// "Typing"/"CrossMark" are the documented Feishu reaction keys.
const FEISHU_ACK_EMOJIS = { received: "Typing", done: "DONE", failed: "CrossMark" } as const;

interface FeishuConnectorOptions {
  config: ChannelConnectionConfig;
  logger?: LoggerLike;
}

// Structural slices of the lazily-imported @larksuiteoapi/node-sdk we use. Kept
// local so the package needs no compile-time dependency on the SDK's huge d.ts.
interface LarkResourceRef {
  type: string; // "image" | "file" | "audio" | "video" | "sticker"
  fileKey: string;
  fileName?: string;
}
interface LarkNormalizedMessage {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string;
  senderName?: string;
  content: string;
  rawContentType?: string;
  mentionedBot: boolean;
  threadId?: string;
  resources?: LarkResourceRef[];
}
interface LarkChannelLike {
  botIdentity?: { name?: string; openId?: string };
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on(name: "message", handler: (msg: LarkNormalizedMessage) => void | Promise<void>): unknown;
  send(
    to: string,
    input:
      | { markdown: string }
      | { image: { source: Buffer } }
      | { file: { source: Buffer; fileName: string } },
  ): Promise<{ messageId: string }>;
}
interface LarkReactionResponse {
  data?: { reaction_id?: string };
}
/** The SDK's binary-download response wrapper (writes the body to disk). */
interface LarkDownload {
  writeFile(filePath: string): Promise<void>;
}
interface LarkClientLike {
  im: {
    messageReaction: {
      create(req: {
        path: { message_id: string };
        data: { reaction_type: { emoji_type: string } };
      }): Promise<LarkReactionResponse | undefined>;
      delete(req: { path: { message_id: string; reaction_id: string } }): Promise<unknown>;
    };
    messageResource: {
      get(req: {
        path: { message_id: string; file_key: string };
        params: { type: "image" | "file" };
      }): Promise<LarkDownload>;
    };
  };
}
interface LarkSdk {
  createLarkChannel(opts: Record<string, unknown>): LarkChannelLike;
  Client: new (opts: Record<string, unknown>) => LarkClientLike;
  Domain: Record<string, unknown>;
}

/**
 * Feishu / Lark connector over the official SDK's WebSocket long-connection
 * (`createLarkChannel`, transport "websocket") — no public URL. The SDK is
 * dynamically imported so it only loads when a Feishu connection exists. Buffer-
 * final replies (markdown); group messages are gated on @mention by default.
 */
export class FeishuConnector implements ChannelConnector {
  readonly platform = "feishu" as const;
  readonly connectionId: string;
  readonly capabilities = FEISHU_CAPABILITIES;
  readonly ackEmojis = FEISHU_ACK_EMOJIS;

  readonly #appId: string;
  readonly #appSecret: string;
  readonly #domain: "feishu" | "lark";
  readonly #workspaceId: string | null;
  readonly #allowFrom: Set<string>;
  readonly #requireMention: boolean;
  readonly #logger?: LoggerLike;
  // (messageId:emoji) → reaction_id, so an ack can be removed later. Feishu's
  // delete API needs the id returned at create time. Bounded to cap memory.
  readonly #reactionIds = new Map<string, string>();

  #handler: IncomingMessageHandler | null = null;
  #channel: LarkChannelLike | null = null;
  #client: LarkClientLike | null = null;
  #botOpenId = "";

  constructor(options: FeishuConnectorOptions) {
    const { config } = options;
    if (!config.appId || !config.appSecret) {
      throw new Error("feishu connector requires appId + appSecret");
    }
    this.connectionId = config.connectionId;
    this.#appId = config.appId;
    this.#appSecret = config.appSecret;
    this.#domain = config.domain === "lark" ? "lark" : "feishu";
    this.#workspaceId = config.workspaceId ?? null;
    this.#allowFrom = normalizeAllowlist(config.allowFrom ?? []);
    // Groups respond only when the bot is @mentioned, unless explicitly disabled.
    this.#requireMention = config.requireMention ?? true;
    this.#logger = options.logger;
  }

  get key(): string {
    return `feishu:${this.#workspaceId ?? "?"}:${this.connectionId}`;
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
          this.#domain,
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
    // Feishu renders markdown natively; pass through.
    return text;
  }

  async start(): Promise<void> {
    const lark = (await import("@larksuiteoapi/node-sdk")) as unknown as LarkSdk;
    const channel = lark.createLarkChannel({
      appId: this.#appId,
      appSecret: this.#appSecret,
      transport: "websocket",
      domain: this.#domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
      source: "holaos",
      handshakeTimeoutMs: 20000,
    });
    channel.on("message", (msg) => this.#onMessage(msg));
    await channel.connect();
    this.#channel = channel;
    // A plain REST client (shares app creds) for reaction acks — the channel
    // wrapper only exposes connect/send, not the messageReaction endpoints.
    this.#client = new lark.Client({
      appId: this.#appId,
      appSecret: this.#appSecret,
      domain: this.#domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
    });
    this.#botOpenId = channel.botIdentity?.openId ?? "";
    this.#logger?.info?.(
      `feishu: connected as ${channel.botIdentity?.name ?? "bot"} (${this.key})`,
    );
  }

  async stop(): Promise<void> {
    const channel = this.#channel;
    this.#channel = null;
    this.#client = null;
    this.#reactionIds.clear();
    if (channel) {
      try {
        await channel.disconnect();
      } catch {
        // ignore
      }
    }
  }

  /** Add an emoji reaction to the user's message and remember its id for removal. */
  async react(_chatId: string, messageId: string, emoji: string): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      const res = await client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      });
      const reactionId = res?.data?.reaction_id;
      if (!reactionId) return;
      if (this.#reactionIds.size >= 1024) {
        const oldest = this.#reactionIds.keys().next().value;
        if (oldest !== undefined) this.#reactionIds.delete(oldest);
      }
      this.#reactionIds.set(`${messageId}:${emoji}`, reactionId);
    } catch (err) {
      // Best-effort: a missing reaction scope or bad emoji key must never block a
      // reply. Surfaced at warn (not debug) so onboarding issues are diagnosable.
      this.#logger?.warn?.(
        `feishu: react '${emoji}' failed (${this.key}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Remove a previously-added reaction (looked up by message + emoji). */
  async unreact(_chatId: string, messageId: string, emoji: string): Promise<void> {
    const client = this.#client;
    const key = `${messageId}:${emoji}`;
    const reactionId = this.#reactionIds.get(key);
    if (!client || !reactionId) return;
    this.#reactionIds.delete(key);
    try {
      await client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch (err) {
      this.#logger?.warn?.(
        `feishu: unreact '${emoji}' failed (${this.key}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async sendText(target: OutgoingTarget, text: string): Promise<SendResult> {
    if (!this.#channel) return { ok: false, error: "feishu not connected" };
    try {
      const result = await this.#channel.send(target.chatId, { markdown: text });
      return { ok: true, messageId: result.messageId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Send a local file as a native attachment via the SDK channel wrapper (which
   * handles the upload → image_key/file_key → message internally). Images render
   * inline; documents/voice/video go as a downloadable file — robust across
   * formats (Feishu's native audio/video need opus/mp4 + a duration we don't have).
   */
  async sendMedia(
    target: OutgoingTarget,
    file: OutgoingMedia,
    caption?: string,
  ): Promise<SendResult> {
    const channel = this.#channel;
    if (!channel) return { ok: false, error: "feishu not connected" };
    try {
      const bytes = await fsp.readFile(file.path);
      const name = file.name ?? path.basename(file.path);
      const input =
        file.kind === "image"
          ? ({ image: { source: bytes } } as const)
          : ({ file: { source: bytes, fileName: name } } as const);
      const result = await channel.send(target.chatId, input);
      // Feishu image/file messages carry no caption — send it as a follow-up.
      if (caption && caption.trim()) {
        await channel.send(target.chatId, { markdown: caption }).catch(() => {});
      }
      return { ok: true, messageId: result.messageId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async #onMessage(msg: LarkNormalizedMessage): Promise<void> {
    const handler = this.#handler;
    if (!handler) return;
    if (this.#botOpenId && msg.senderId === this.#botOpenId) return; // never reply to self
    if (!this.#isAllowed(msg.senderId)) {
      this.#logger?.info?.(`feishu: dropping disallowed sender (${this.key})`);
      return;
    }
    const isGroup = msg.chatType === "group";
    if (isGroup && this.#requireMention && !msg.mentionedBot) return; // @mention gating in groups

    // Strip the SDK's inline resource placeholders (![image](key), <file key=…/>) —
    // the real bytes are downloaded into `attachments`, so leaving the markers in
    // would feed the agent a confusing pseudo-reference instead of the image.
    const text = (msg.content ?? "")
      .replace(/!\[image\]\([^)]*\)/g, "")
      .replace(/<file key="[^"]*"\s*\/>/g, "")
      .trim();
    // Diagnostic: surface what the SDK actually delivered (type + resources), so a
    // dropped/!responding image is traceable without a debugger.
    this.#logger?.info?.(
      `feishu: inbound type=${msg.rawContentType ?? "?"} contentLen=${(msg.content ?? "").length} resources=[${(msg.resources ?? []).map((r) => r.type).join(",") || "none"}] (${this.key})`,
    );
    const attachments = await this.#downloadResources(msg.messageId, msg.resources ?? []);
    if (!text && attachments.length === 0) return; // nothing to forward

    const incoming: IncomingMessage = {
      platform: "feishu",
      connectionId: this.connectionId,
      workspaceId: this.#workspaceId ?? "",
      chatId: msg.chatId,
      chatType: isGroup ? "group" : "dm",
      threadId: msg.threadId,
      userId: msg.senderId,
      userName: msg.senderName,
      text,
      messageId: msg.messageId,
      updateId: msg.messageId, // Feishu has no update_id; message id keys idempotency
      attachments,
      raw: msg,
    };
    try {
      await handler(incoming);
    } catch (err) {
      this.#logger?.error?.("feishu: inbound handler failed", err);
    }
  }

  /**
   * Download a message's image/file resources into temp files for the runtime
   * port (which turns images into vision data-URIs and files into workspace
   * copies, then deletes these temps). Best-effort: a single failed resource is
   * skipped rather than dropping the whole message.
   */
  async #downloadResources(
    messageId: string,
    resources: LarkResourceRef[],
  ): Promise<IncomingAttachment[]> {
    const client = this.#client;
    if (!client || resources.length === 0) return [];
    const out: IncomingAttachment[] = [];
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hb-feishu-"));
    for (const res of resources) {
      const isImage = res.type === "image" || res.type === "sticker";
      try {
        // Message attachments must be fetched from the *message* endpoint
        // (type-scoped), not im.image.get by key — the latter returns nothing for
        // images the bot merely received, which silently dropped image messages.
        const dl = await client.im.messageResource.get({
          path: { message_id: messageId, file_key: res.fileKey },
          params: { type: isImage ? "image" : "file" },
        });
        const dest = path.join(dir, `${out.length}-${res.fileKey.replace(/[^\w.-]+/g, "_").slice(-32)}`);
        await dl.writeFile(dest);

        let sizeBytes: number;
        let mimeType = "application/octet-stream";
        let extDefault = "bin";
        if (isImage) {
          const head = await fsp.readFile(dest); // images are small; need bytes for mime sniff
          sizeBytes = head.length;
          const detected = detectImageType(head);
          mimeType = detected.mime;
          extDefault = detected.ext;
        } else {
          sizeBytes = (await fsp.stat(dest)).size; // avoid loading large files into memory
        }
        if (sizeBytes === 0) {
          this.#logger?.warn?.(`feishu: ${res.type} resource ${res.fileKey} downloaded 0 bytes (${this.key})`);
          continue;
        }
        out.push({
          kind: isImage ? "image" : "file",
          sourcePath: dest,
          name:
            res.fileName?.replace(/[^\w.-]+/g, "_") ||
            `${isImage ? "image" : "file"}-${out.length}.${extDefault}`,
          mimeType,
          sizeBytes,
        });
        this.#logger?.info?.(`feishu: downloaded ${res.type} resource ${sizeBytes}B (${this.key})`);
      } catch (err) {
        this.#logger?.warn?.(
          `feishu: download ${res.type} resource failed (${this.key}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return out;
  }

  #isAllowed(senderId: string): boolean {
    if (this.#allowFrom.size === 0) return true;
    return this.#allowFrom.has(senderId.trim().toLowerCase());
  }
}

/** Sniff a common image mime from magic bytes; defaults to JPEG. */
function detectImageType(buf: Buffer): { mime: string; ext: string } {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return { mime: "image/png", ext: "png" };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return { mime: "image/jpeg", ext: "jpg" };
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)
    return { mime: "image/gif", ext: "gif" };
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  )
    return { mime: "image/webp", ext: "webp" };
  return { mime: "image/jpeg", ext: "jpg" };
}

function normalizeAllowlist(values: string[]): Set<string> {
  const out = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (normalized) out.add(normalized);
  }
  return out;
}
