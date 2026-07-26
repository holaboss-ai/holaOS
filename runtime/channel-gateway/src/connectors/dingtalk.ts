import { createHash, randomUUID } from "node:crypto";
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
  OutgoingTarget,
  SendResult,
} from "../connector.js";
import type { LoggerLike } from "../egress.js";

const DINGTALK_CAPABILITIES: ChannelCapabilities = {
  editMessages: false,
  finalizeByResend: false,
  reactions: true, // type-2 text-emotion acks on the user's message (Thinking → Done)
  typing: false,
  typingRefreshMs: 0,
  markdown: "dingtalk",
  maxMessageLength: 8000,
  lengthUnit: "codepoints",
  interactiveButtons: false,
  threads: false,
  media: { image: true, document: true, voice: true, video: true },
};

// DingTalk "text emotion" reactions (emotionType 2). The names are free text shown
// on the message; the fixed emotionId/backgroundId are known-good values.
const DINGTALK_ACK_EMOJIS = { received: "🤔Thinking", done: "🥳Done", failed: "❌Failed" } as const;
const DINGTALK_EMOTION_ID = "2659900";
const DINGTALK_EMOTION_BACKGROUND_ID = "im_bg_1";

const TOPIC_ROBOT = "/v1.0/im/bot/messages/get";

interface DingtalkConnectorOptions {
  config: ChannelConnectionConfig;
  logger?: LoggerLike;
}

// Structural slices of the lazily-imported dingtalk-stream-sdk-nodejs.
interface DingtalkDownStream {
  headers: { messageId: string; topic: string };
  data: string;
}
interface DingtalkClient {
  registerCallbackListener(eventId: string, cb: (v: DingtalkDownStream) => void): DingtalkClient;
  connect(): Promise<void>;
  disconnect(): void;
}
interface DingtalkSdk {
  DWClient: new (opts: { clientId: string; clientSecret: string; ua?: string }) => DingtalkClient;
  TOPIC_ROBOT?: string;
}
interface DingtalkRobotMessage {
  conversationId: string;
  conversationType?: string;
  senderStaffId?: string;
  senderId?: string;
  senderNick?: string;
  sessionWebhook: string;
  sessionWebhookExpiredTime?: number;
  robotCode?: string;
  msgtype: string;
  text?: { content?: string };
  // Media messages (picture/file/audio/video/richText) carry a per-resource
  // `downloadCode` exchanged for a temp URL via the robot messageFiles API.
  content?: Record<string, unknown>;
  msgId?: string;
}

/** A resource extracted from a media message, pre-download. */
interface DingtalkResourceRef {
  downloadCode: string;
  kind: IncomingAttachment["kind"];
  name: string;
  mime: string;
}

/**
 * DingTalk connector over the official SDK's Stream Mode (a long-lived WebSocket —
 * no public URL). The SDK is dynamically imported so it only loads when a DingTalk
 * connection exists. Replies go to the per-message `sessionWebhook`. Buffer-final
 * markdown; DingTalk only pushes @-mentioned messages to a group bot, so no extra
 * mention gating is needed.
 */
export class DingTalkConnector implements ChannelConnector {
  readonly platform = "dingtalk" as const;
  readonly connectionId: string;
  readonly capabilities: ChannelCapabilities;
  readonly ackEmojis = DINGTALK_ACK_EMOJIS;

  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #workspaceId: string | null;
  readonly #allowFrom: Set<string>;
  /** AI Card template id. Present → live streaming cards (editMessages); absent →
   *  buffer-final markdown to the per-message session webhook. */
  readonly #cardTemplateId: string | null;
  readonly #logger?: LoggerLike;

  #handler: IncomingMessageHandler | null = null;
  #client: DingtalkClient | null = null;
  readonly #webhooks = new Map<string, { url: string; expiresAt: number }>();
  /** Per-chat delivery context captured from the last inbound frame — a card's
   *  create/deliver needs the conversation type, DM recipient, and robot code,
   *  which the outbound target (chatId only) doesn't carry. */
  readonly #chatContext = new Map<
    string,
    { conversationType: string; senderStaffId: string; robotCode: string }
  >();
  #accessToken: string | null = null;
  #accessTokenExpiresAt = 0;
  #robotCode = ""; // bot identity for the emotion/download APIs (from inbound msg)

  constructor(options: DingtalkConnectorOptions) {
    const { config } = options;
    if (!config.appId || !config.appSecret) {
      throw new Error("dingtalk connector requires appId (clientId) + appSecret (clientSecret)");
    }
    this.connectionId = config.connectionId;
    this.#clientId = config.appId;
    this.#clientSecret = config.appSecret;
    this.#workspaceId = config.workspaceId ?? null;
    this.#allowFrom = normalizeAllowlist(config.allowFrom ?? []);
    const templateId = config.extra?.cardTemplateId;
    this.#cardTemplateId =
      typeof templateId === "string" && templateId.trim() ? templateId.trim() : null;
    // Streaming (editMessages) is only possible with a configured AI Card
    // template; without one, keep the buffer-final webhook-markdown path.
    this.capabilities = {
      ...DINGTALK_CAPABILITIES,
      editMessages: this.#cardTemplateId !== null,
    };
    this.#logger = options.logger;
  }

  get key(): string {
    return `dingtalk:${this.#workspaceId ?? "?"}:${this.connectionId}`;
  }

  fingerprint(): string {
    return createHash("sha256")
      .update(
        [
          this.platform,
          this.connectionId,
          this.#workspaceId ?? "",
          this.#clientId,
          this.#clientSecret,
          this.#cardTemplateId ?? "",
          [...this.#allowFrom].sort().join(","),
        ].join("|"),
      )
      .digest("hex");
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.#handler = handler;
  }

  format(text: string): string {
    return text; // DingTalk renders markdown
  }

  async start(): Promise<void> {
    const sdk = (await import("dingtalk-stream-sdk-nodejs")) as unknown as DingtalkSdk;
    const client = new sdk.DWClient({
      clientId: this.#clientId,
      clientSecret: this.#clientSecret,
      ua: "holaos",
    });
    client.registerCallbackListener(sdk.TOPIC_ROBOT ?? TOPIC_ROBOT, (v) => this.#onFrame(v));
    await client.connect();
    this.#client = client;
    this.#logger?.info?.(`dingtalk: connected (${this.key})`);
  }

  async stop(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#accessToken = null;
    this.#accessTokenExpiresAt = 0;
    this.#webhooks.clear();
    if (client) {
      try {
        client.disconnect();
      } catch {
        // ignore
      }
    }
  }

  async sendText(target: OutgoingTarget, text: string): Promise<SendResult> {
    const webhook = this.#webhooks.get(target.chatId);
    if (!webhook) return { ok: false, error: "dingtalk: no active reply webhook for this chat" };
    if (webhook.expiresAt && Date.now() > webhook.expiresAt) {
      this.#webhooks.delete(target.chatId);
      return { ok: false, error: "dingtalk: reply window expired" };
    }
    try {
      const response = await fetch(webhook.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ msgtype: "markdown", markdown: { title: "Reply", text } }),
        signal: AbortSignal.timeout(15000),
      });
      const data = (await response.json()) as { errcode?: number; errmsg?: string };
      if (data.errcode && data.errcode !== 0) {
        return { ok: false, error: data.errmsg ?? `errcode ${data.errcode}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Create + deliver a streaming AI Card, then push the initial content. Returns
   * the card's out_track_id as the message id that subsequent editText calls
   * update. Returns ok:false (→ egress falls back to the buffer-final webhook
   * path) when no template is configured or we lack the delivery context.
   */
  async createStreamMessage(target: OutgoingTarget, text: string): Promise<SendResult> {
    const templateId = this.#cardTemplateId;
    if (!templateId) return { ok: false, error: "dingtalk: no AI Card template configured" };
    const ctx = this.#chatContext.get(target.chatId);
    if (!ctx) return { ok: false, error: "dingtalk: no delivery context for card" };
    try {
      const token = await this.#getAccessToken();
      const outTrackId = `hb-${randomUUID()}`;
      const isGroup = ctx.conversationType === "2";

      // 1) Create the card instance in STREAM callback mode.
      await this.#cardApi("/v1.0/card/instances", "POST", token, {
        cardTemplateId: templateId,
        outTrackId,
        cardData: { cardParamMap: { content: "" } },
        callbackType: "STREAM",
        imGroupOpenSpaceModel: { supportForward: true },
        imRobotOpenSpaceModel: { supportForward: true },
      });

      // 2) Deliver it to the group (IM_GROUP.<conversationId>) or DM
      //    (IM_ROBOT.<staffId>).
      const deliver: Record<string, unknown> = {
        outTrackId,
        userIdType: 1,
        openSpaceId: isGroup
          ? `dtv1.card//IM_GROUP.${target.chatId}`
          : `dtv1.card//IM_ROBOT.${ctx.senderStaffId}`,
      };
      if (isGroup) {
        deliver.imGroupOpenDeliverModel = { robotCode: ctx.robotCode || this.#clientId };
      } else {
        deliver.imRobotOpenDeliverModel = { spaceType: "IM_ROBOT" };
      }
      await this.#cardApi("/v1.0/card/instances/deliver", "POST", token, deliver);

      // 3) Stream the first content (non-final).
      await this.#streamCard(outTrackId, token, text, false);
      this.#logger?.info?.(`dingtalk: streaming card created ${outTrackId} (${this.key})`);
      return { ok: true, messageId: outTrackId };
    } catch (err) {
      this.#logger?.warn?.(
        `dingtalk: card create failed (${this.key}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Stream an update to an existing AI Card (message id = out_track_id). */
  async editText(
    _target: OutgoingTarget,
    messageId: string,
    text: string,
    options?: { finalize?: boolean },
  ): Promise<SendResult> {
    if (!messageId) return { ok: false, error: "dingtalk: editText requires a card out_track_id" };
    try {
      const token = await this.#getAccessToken();
      await this.#streamCard(messageId, token, text, Boolean(options?.finalize));
      return { ok: true, messageId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** AI Card streaming update: full-content replace, optionally finalizing (which
   *  closes the streaming indicator). */
  async #streamCard(
    outTrackId: string,
    token: string,
    content: string,
    finalize: boolean,
  ): Promise<void> {
    const res = await fetch("https://api.dingtalk.com/v1.0/card/streaming", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": token },
      body: JSON.stringify({
        outTrackId,
        guid: randomUUID(),
        key: "content",
        content: content.slice(0, this.capabilities.maxMessageLength),
        isFull: true,
        isFinalize: finalize,
        isError: false,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`streaming HTTP ${res.status} ${detail.slice(0, 160)}`);
    }
  }

  /** POST/PUT a card-instance API (create / deliver) and surface a non-success. */
  async #cardApi(
    pathname: string,
    method: "POST" | "PUT",
    token: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`https://api.dingtalk.com${pathname}`, {
      method,
      headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data.success === false) {
      throw new Error(
        `dingtalk ${pathname} failed: HTTP ${res.status} ${JSON.stringify(data).slice(0, 200)}`,
      );
    }
    return data;
  }

  #onFrame(frame: DingtalkDownStream): void {
    if (!this.#handler) return;
    let msg: DingtalkRobotMessage;
    try {
      msg = JSON.parse(frame.data) as DingtalkRobotMessage;
    } catch {
      return;
    }
    if (!msg.conversationId || !msg.sessionWebhook) return;

    // Remember the reply webhook for this conversation (used by sendText).
    this.#webhooks.set(msg.conversationId, {
      url: msg.sessionWebhook,
      expiresAt:
        typeof msg.sessionWebhookExpiredTime === "number"
          ? msg.sessionWebhookExpiredTime
          : Date.now() + 90_000,
    });
    this.#robotCode = (msg.robotCode || this.#clientId).trim();

    const senderId = (msg.senderStaffId || msg.senderId || "").trim();
    // Capture what an AI Card's create/deliver needs (group vs DM, DM recipient,
    // robot code) — the outbound path has only the chatId (conversationId).
    this.#chatContext.set(msg.conversationId, {
      conversationType: (msg.conversationType ?? "1").trim(),
      senderStaffId: senderId,
      robotCode: this.#robotCode,
    });
    if (!this.#isAllowed(senderId)) {
      this.#logger?.info?.(`dingtalk: dropping disallowed sender (${this.key})`);
      return;
    }

    // Resource download is async; hand off so the WS callback returns promptly.
    void this.#dispatch(msg, frame, senderId).catch((err) =>
      this.#logger?.error?.("dingtalk: inbound handler failed", err),
    );
  }

  async #dispatch(
    msg: DingtalkRobotMessage,
    frame: DingtalkDownStream,
    senderId: string,
  ): Promise<void> {
    const handler = this.#handler;
    if (!handler) return;

    const text = this.#extractText(msg);
    const attachments = await this.#downloadAttachments(msg);
    this.#logger?.info?.(
      `dingtalk: inbound msgtype=${msg.msgtype} textLen=${text.length} attachments=${attachments.length} (${this.key})`,
    );
    if (!text && attachments.length === 0) return; // nothing to forward

    const incoming: IncomingMessage = {
      platform: "dingtalk",
      connectionId: this.connectionId,
      workspaceId: this.#workspaceId ?? "",
      chatId: msg.conversationId,
      chatType: msg.conversationType === "2" ? "group" : "dm",
      userId: senderId,
      userName: msg.senderNick,
      text,
      messageId: msg.msgId ?? frame.headers.messageId,
      updateId: msg.msgId ?? frame.headers.messageId,
      attachments,
      raw: msg,
    };
    await handler(incoming);
  }

  #extractText(msg: DingtalkRobotMessage): string {
    if (msg.msgtype === "text") return (msg.text?.content ?? "").trim();
    if (msg.msgtype === "richText") {
      const rich = msg.content?.richText;
      if (Array.isArray(rich)) {
        return (rich as Array<Record<string, unknown>>)
          .map((el) => (typeof el.text === "string" ? el.text : ""))
          .join("")
          .trim();
      }
    }
    return "";
  }

  /** Pull downloadable resources out of a media message by its msgtype. */
  #extractResources(msg: DingtalkRobotMessage): DingtalkResourceRef[] {
    const content = msg.content ?? {};
    const code = (v: unknown): string => (typeof v === "string" ? v : "");
    const out: DingtalkResourceRef[] = [];
    switch (msg.msgtype) {
      case "picture": {
        const dc = code(content.downloadCode);
        if (dc) out.push({ downloadCode: dc, kind: "image", name: "image.jpg", mime: "image/jpeg" });
        break;
      }
      case "file": {
        const dc = code(content.downloadCode);
        if (dc)
          out.push({
            downloadCode: dc,
            kind: "file",
            name: typeof content.fileName === "string" ? content.fileName : "file",
            mime: "application/octet-stream",
          });
        break;
      }
      case "audio":
      case "voice": {
        const dc = code(content.downloadCode);
        if (dc) out.push({ downloadCode: dc, kind: "voice", name: "audio.mp3", mime: "audio/mpeg" });
        break;
      }
      case "video": {
        const dc = code(content.downloadCode);
        if (dc) out.push({ downloadCode: dc, kind: "video", name: "video.mp4", mime: "video/mp4" });
        break;
      }
      case "richText": {
        const rich = content.richText;
        if (Array.isArray(rich)) {
          for (const el of rich as Array<Record<string, unknown>>) {
            const dc = code(el.downloadCode);
            if (dc) out.push({ downloadCode: dc, kind: "image", name: "image.jpg", mime: "image/jpeg" });
          }
        }
        break;
      }
    }
    return out;
  }

  /**
   * Download a media message's resources into temp files for the runtime port
   * (images → vision data-URIs, files → workspace). Best-effort per resource.
   */
  async #downloadAttachments(msg: DingtalkRobotMessage): Promise<IncomingAttachment[]> {
    const resources = this.#extractResources(msg);
    if (resources.length === 0) return [];
    const robotCode = (msg.robotCode || this.#clientId).trim();
    const out: IncomingAttachment[] = [];
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hb-dingtalk-"));
    for (const res of resources) {
      try {
        const bytes = await this.#downloadByCode(res.downloadCode, robotCode);
        if (bytes.length === 0) {
          this.#logger?.warn?.(`dingtalk: ${res.kind} downloaded 0 bytes (${this.key})`);
          continue;
        }
        const detected = res.kind === "image" ? detectImageType(bytes) : null;
        const safeName = res.name.replace(/[^\w.-]+/g, "_") || `${res.kind}-${out.length}`;
        const dest = path.join(dir, `${out.length}-${safeName}`);
        await fsp.writeFile(dest, bytes);
        out.push({
          kind: res.kind,
          sourcePath: dest,
          name: safeName,
          mimeType: detected?.mime ?? res.mime,
          sizeBytes: bytes.length,
        });
        this.#logger?.info?.(`dingtalk: downloaded ${res.kind} ${bytes.length}B (${this.key})`);
      } catch (err) {
        this.#logger?.warn?.(
          `dingtalk: download ${res.kind} failed (${this.key}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return out;
  }

  /** Cached robot access token (appKey/appSecret → accessToken). */
  async #getAccessToken(): Promise<string> {
    if (this.#accessToken && Date.now() < this.#accessTokenExpiresAt) return this.#accessToken;
    const res = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appKey: this.#clientId, appSecret: this.#clientSecret }),
      signal: AbortSignal.timeout(15000),
    });
    const data = (await res.json()) as { accessToken?: string; expireIn?: number };
    if (!data.accessToken) throw new Error(`no accessToken (HTTP ${res.status})`);
    this.#accessToken = data.accessToken;
    // Refresh ~2 min early to avoid edge expiry.
    this.#accessTokenExpiresAt = Date.now() + Math.max(60, (data.expireIn ?? 7200) - 120) * 1000;
    return data.accessToken;
  }

  /** Exchange a resource downloadCode for a temp URL, then fetch the bytes. */
  async #downloadByCode(downloadCode: string, robotCode: string): Promise<Buffer> {
    const token = await this.#getAccessToken();
    const res = await fetch("https://api.dingtalk.com/v1.0/robot/messageFiles/download", {
      method: "POST",
      headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": token },
      body: JSON.stringify({ downloadCode, robotCode }),
      signal: AbortSignal.timeout(20000),
    });
    const data = (await res.json()) as { downloadUrl?: string };
    if (!data.downloadUrl) throw new Error(`no downloadUrl (HTTP ${res.status})`);
    const fileRes = await fetch(data.downloadUrl, { signal: AbortSignal.timeout(30000) });
    if (!fileRes.ok) throw new Error(`file fetch HTTP ${fileRes.status}`);
    return Buffer.from(await fileRes.arrayBuffer());
  }

  /** Add a text-emotion reaction (Thinking/Done/Failed) to the user's message. */
  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    await this.#emotion("reply", messageId, chatId, emoji);
  }

  /** Remove a previously-added reaction from the user's message. */
  async unreact(chatId: string, messageId: string, emoji: string): Promise<void> {
    await this.#emotion("recall", messageId, chatId, emoji);
  }

  async #emotion(
    action: "reply" | "recall",
    openMsgId: string,
    openConversationId: string,
    emotionName: string,
  ): Promise<void> {
    if (!openMsgId || !openConversationId) return;
    try {
      const token = await this.#getAccessToken();
      const res = await fetch(`https://api.dingtalk.com/v1.0/robot/emotion/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": token },
        body: JSON.stringify({
          robotCode: this.#robotCode || this.#clientId,
          openMsgId,
          openConversationId,
          emotionType: 2,
          emotionName,
          textEmotion: {
            emotionId: DINGTALK_EMOTION_ID,
            emotionName,
            text: emotionName,
            backgroundId: DINGTALK_EMOTION_BACKGROUND_ID,
          },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        this.#logger?.warn?.(
          `dingtalk: emotion ${action} '${emotionName}' HTTP ${res.status} ${detail.slice(0, 160)} (${this.key})`,
        );
      }
    } catch (err) {
      this.#logger?.warn?.(
        `dingtalk: emotion ${action} '${emotionName}' failed (${this.key}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
