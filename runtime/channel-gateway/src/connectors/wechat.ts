import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
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

const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const ILINK_APP_ID = "bot";
const CHANNEL_VERSION = "2.2.0";
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0);

const EP_GET_UPDATES = "ilink/bot/getupdates";
const EP_SEND_MESSAGE = "ilink/bot/sendmessage";
const EP_GET_UPLOAD_URL = "ilink/bot/getuploadurl";

const SESSION_EXPIRED_ERRCODE = -14;
const RATE_LIMIT_ERRCODE = -2;

// item_list element types + message direction (from the iLink wire format).
const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;
const ITEM_VOICE = 3;
const ITEM_FILE = 4;
const ITEM_VIDEO = 5;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;

// Outbound media_type values for getuploadurl (image inline; everything else as
// a downloadable file — robust across formats).
const MEDIA_IMAGE = 1;
const MEDIA_FILE = 3;

// SSRF guard: only fetch media from known WeChat CDN hosts.
const CDN_ALLOWLIST = new Set([
  "novac2c.cdn.weixin.qq.com",
  "ilinkai.weixin.qq.com",
  "wx.qlogo.cn",
  "thirdwx.qlogo.cn",
  "res.wx.qq.com",
  "mmbiz.qpic.cn",
  "mmbiz.qlogo.cn",
]);

const WECHAT_CAPABILITIES: ChannelCapabilities = {
  editMessages: false,
  finalizeByResend: false,
  // iLink personal-WeChat bots have no reactions; typing needs a per-peer ticket
  // we skip in v1 → status is conveyed by `workingText`.
  reactions: false,
  typing: false,
  typingRefreshMs: 0,
  markdown: "none",
  maxMessageLength: 2000,
  lengthUnit: "codepoints",
  interactiveButtons: false,
  threads: false,
  media: { image: true, document: true, voice: true, video: true },
};

interface WechatConnectorOptions {
  config: ChannelConnectionConfig;
  logger?: LoggerLike;
}

interface IlinkMediaRef {
  encrypt_query_param?: string;
  aes_key?: string;
  full_url?: string;
}
interface IlinkItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: { media?: IlinkMediaRef; aeskey?: string };
  video_item?: { media?: IlinkMediaRef };
  file_item?: { media?: IlinkMediaRef; file_name?: string };
  voice_item?: { media?: IlinkMediaRef; text?: string };
}
interface IlinkMessage {
  from_user_id?: string;
  to_user_id?: string;
  room_id?: string;
  chat_room_id?: string;
  msg_type?: number;
  message_id?: string;
  context_token?: string;
  item_list?: IlinkItem[];
}
interface IlinkUpdates {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: IlinkMessage[];
  get_updates_buf?: string;
}

/**
 * Personal WeChat connector over Tencent's iLink bot protocol (long-poll
 * `getupdates`, `sendmessage`; ilinkai.weixin.qq.com). Bound via QR scan-to-login
 * ({@link beginWechatRegistration}). Replies must echo the per-peer
 * `context_token`. Media is downloaded from the WeChat CDN and AES-ECB-decrypted.
 *
 * Implements the iLink/WeChat bot flow. Caveats (surfaced in the UI): the iLink
 * bot identity often can't receive ordinary group messages; sessions expire and
 * need a re-scan; this is a semi-official protocol not validated e2e here.
 */
export class WeChatConnector implements ChannelConnector {
  readonly platform = "wechat" as const;
  readonly connectionId: string;
  readonly capabilities = WECHAT_CAPABILITIES;
  readonly workingText = "🤔 Working on it…";

  readonly #token: string;
  readonly #baseUrl: string;
  readonly #cdnBaseUrl: string;
  readonly #accountId: string;
  readonly #workspaceId: string | null;
  readonly #allowFrom: Set<string>;
  readonly #requireMention: boolean;
  readonly #logger?: LoggerLike;
  readonly #contextTokens = new Map<string, string>();
  readonly #seen = new Set<string>();

  #handler: IncomingMessageHandler | null = null;
  #stopped = false;
  #buf = "";
  #loop: Promise<void> | null = null;
  #pollAbort: AbortController | null = null;

  constructor(options: WechatConnectorOptions) {
    const { config } = options;
    if (!config.token) throw new Error("wechat connector requires a session token");
    this.connectionId = config.connectionId;
    this.#token = config.token;
    this.#baseUrl = (config.apiBaseUrl ?? ILINK_BASE_URL).replace(/\/+$/, "");
    const extra = (config.extra ?? {}) as Record<string, unknown>;
    this.#cdnBaseUrl = typeof extra.cdnBaseUrl === "string" ? extra.cdnBaseUrl : WEIXIN_CDN_BASE_URL;
    this.#accountId = typeof extra.accountId === "string" ? extra.accountId : "";
    this.#workspaceId = config.workspaceId ?? null;
    this.#allowFrom = normalizeAllowlist(config.allowFrom ?? []);
    this.#requireMention = config.requireMention ?? true;
    this.#logger = options.logger;
  }

  get key(): string {
    return `wechat:${this.#workspaceId ?? "?"}:${this.connectionId}`;
  }

  fingerprint(): string {
    return createHash("sha256")
      .update(
        [
          this.platform,
          this.connectionId,
          this.#workspaceId ?? "",
          this.#token,
          this.#baseUrl,
          [...this.#allowFrom].sort().join(","),
        ].join("|"),
      )
      .digest("hex");
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.#handler = handler;
  }

  format(text: string): string {
    return text; // iLink renders plain text
  }

  async start(): Promise<void> {
    this.#stopped = false;
    this.#loop = this.#pollLoop();
    this.#logger?.info?.(`wechat: polling started (${this.key})`);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#pollAbort?.abort();
    if (this.#loop) {
      await this.#loop.catch(() => {});
      this.#loop = null;
    }
    this.#contextTokens.clear();
  }

  async sendText(target: OutgoingTarget, text: string): Promise<SendResult> {
    const msg: Record<string, unknown> = {
      from_user_id: "",
      to_user_id: target.chatId,
      client_id: randomUUID(),
      message_type: MSG_TYPE_BOT,
      message_state: MSG_STATE_FINISH,
      item_list: [{ type: ITEM_TEXT, text_item: { text } }],
    };
    const context = this.#contextTokens.get(target.chatId);
    if (context) msg.context_token = context;
    try {
      const res = (await this.#post(EP_SEND_MESSAGE, { msg })) as {
        ret?: number;
        errcode?: number;
      };
      if (res?.errcode && res.errcode !== 0) {
        return { ok: false, error: `iLink sendmessage errcode ${res.errcode}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Send a local file to WeChat over the iLink CDN media protocol: generate a
   * per-file AES-128 key, register the upload (getuploadurl), PKCS7-encrypt the
   * bytes and POST them to the CDN, then send a message referencing the uploaded
   * media. Images go inline; everything else goes as a downloadable file. On any
   * failure this returns ok:false, so the egress falls back to a text note.
   */
  async sendMedia(
    target: OutgoingTarget,
    file: OutgoingMedia,
    caption?: string,
  ): Promise<SendResult> {
    try {
      const plaintext = await fsp.readFile(file.path);
      const isImage = file.kind === "image";
      const filekey = randomBytes(16).toString("hex");
      const aesKey = randomBytes(16);
      const rawsize = plaintext.length;
      const rawfilemd5 = createHash("md5").update(plaintext).digest("hex");

      const uploadInfo = (await this.#post(EP_GET_UPLOAD_URL, {
        filekey,
        media_type: isImage ? MEDIA_IMAGE : MEDIA_FILE,
        to_user_id: target.chatId,
        rawsize,
        rawfilemd5,
        filesize: aesPaddedSize(rawsize),
        no_need_thumb: true,
        aeskey: aesKey.toString("hex"),
      })) as {
        upload_param?: string;
        upload_full_url?: string;
        errcode?: number;
        ret?: number;
      };
      const upErr = uploadInfo.errcode ?? uploadInfo.ret ?? 0;
      if (upErr !== 0) {
        this.#logger?.warn?.(
          `wechat: getuploadurl errcode ${upErr} for ${isImage ? "image" : "file"} "${file.name ?? ""}" ${rawsize}B (${this.key})`,
        );
        return { ok: false, error: `iLink getuploadurl errcode ${upErr}` };
      }

      const ciphertext = aesEcbEncrypt(plaintext, aesKey);
      const uploadUrl =
        uploadInfo.upload_full_url ||
        (uploadInfo.upload_param
          ? cdnUploadUrl(this.#cdnBaseUrl, uploadInfo.upload_param, filekey)
          : "");
      if (!uploadUrl) return { ok: false, error: "iLink getuploadurl returned no upload url" };
      const encryptedQueryParam = await uploadCiphertext(uploadUrl, ciphertext);

      // iLink expects aes_key as base64(hex-string), NOT base64(raw-bytes): the
      // latter renders as grey boxes because the receiver's decrypt key mismatches.
      const media = {
        encrypt_query_param: encryptedQueryParam,
        aes_key: Buffer.from(aesKey.toString("hex"), "ascii").toString("base64"),
        encrypt_type: 1,
      };
      const name = file.name ?? path.basename(file.path);
      const item = isImage
        ? { type: ITEM_IMAGE, image_item: { media, mid_size: ciphertext.length } }
        : { type: ITEM_FILE, file_item: { media, file_name: name, len: String(rawsize) } };

      // Captions ride as a preceding text message (media items carry no caption).
      if (caption && caption.trim()) await this.sendText(target, caption).catch(() => {});

      const msg: Record<string, unknown> = {
        from_user_id: "",
        to_user_id: target.chatId,
        client_id: randomUUID(),
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [item],
      };
      const context = this.#contextTokens.get(target.chatId);
      if (context) msg.context_token = context;
      const res = (await this.#post(EP_SEND_MESSAGE, { msg })) as { errcode?: number };
      if (res?.errcode && res.errcode !== 0) {
        this.#logger?.warn?.(
          `wechat: sendmessage errcode ${res.errcode} for ${isImage ? "image" : "file"} "${name}" ${rawsize}B (${this.key})`,
        );
        return { ok: false, error: `iLink sendmessage errcode ${res.errcode}` };
      }
      this.#logger?.info?.(
        `wechat: sent ${isImage ? "image" : "file"} "${name}" ${rawsize}B (${this.key})`,
      );
      return { ok: true };
    } catch (err) {
      this.#logger?.warn?.(`wechat: sendMedia failed (${this.key})`, err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async #pollLoop(): Promise<void> {
    let backoffMs = 2000;
    while (!this.#stopped) {
      this.#pollAbort = new AbortController();
      try {
        const res = (await this.#post(
          EP_GET_UPDATES,
          { get_updates_buf: this.#buf },
          this.#pollAbort.signal,
          40000,
        )) as IlinkUpdates;
        const errcode = res.errcode ?? res.ret ?? 0;
        if (errcode === SESSION_EXPIRED_ERRCODE) {
          this.#logger?.warn?.(`wechat: session expired — re-scan required (${this.key})`);
          return;
        }
        if (errcode === RATE_LIMIT_ERRCODE) {
          await sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, 30000);
          continue;
        }
        if (typeof res.get_updates_buf === "string") this.#buf = res.get_updates_buf;
        backoffMs = 2000;
        for (const message of res.msgs ?? []) {
          await this.#processMessage(message);
        }
      } catch (err) {
        if (this.#stopped) break;
        this.#logger?.warn?.(`wechat: getupdates error (${this.key}); backing off ${backoffMs}ms`, err);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30000);
      }
    }
  }

  async #processMessage(message: IlinkMessage): Promise<void> {
    const handler = this.#handler;
    if (!handler) return;
    const senderId = String(message.from_user_id ?? "").trim();
    if (!senderId || senderId === this.#accountId) return; // skip empty + self

    const messageId = String(message.message_id ?? "").trim();
    if (messageId) {
      if (this.#seen.has(messageId)) return;
      if (this.#seen.size >= 1000) {
        const oldest = this.#seen.values().next().value;
        if (oldest !== undefined) this.#seen.delete(oldest);
      }
      this.#seen.add(messageId);
    }

    const roomId = String(message.room_id ?? message.chat_room_id ?? "").trim();
    const toUserId = String(message.to_user_id ?? "").trim();
    const isGroup = Boolean(roomId) || (toUserId !== "" && toUserId !== this.#accountId && message.msg_type === 1);
    const chatId = isGroup ? roomId || toUserId || senderId : senderId;

    if (isGroup) {
      if (this.#requireMention) return; // iLink rarely flags group @mentions reliably
    } else if (!this.#isAllowed(senderId)) {
      return;
    }

    const context = String(message.context_token ?? "").trim();
    if (context) this.#contextTokens.set(chatId, context);

    const items = message.item_list ?? [];
    const itemTypes = items.map((it) => it.type ?? "?").join(",") || "none";
    const text = extractText(items);
    let attachments: IncomingAttachment[] = [];
    try {
      attachments = await this.#downloadMedia(items);
    } catch (err) {
      this.#logger?.warn?.("wechat: media download failed", err);
    }
    // Inbound observability: the poll loop is otherwise silent on receipt, which
    // made a dropped image (below) impossible to diagnose in the field.
    this.#logger?.info?.(
      `wechat: inbound ${messageId || "(no id)"} from ${senderId} chat=${chatId} group=${isGroup} types=[${itemTypes}] textLen=${text.length} attachments=${attachments.length} (${this.key})`,
    );
    if (!text && attachments.length === 0) {
      // An item arrived but yielded neither text nor a downloadable attachment —
      // e.g. an unrecognized item type, or a media ref we couldn't resolve/decrypt.
      // Was a silent return; now surfaced so it's visible why no ack went out.
      this.#logger?.warn?.(
        `wechat: dropped ${messageId || "(no id)"} — no text and no usable media (item types [${itemTypes}]); raw=${JSON.stringify(items).slice(0, 800)} (${this.key})`,
      );
      return;
    }

    const chatType: ChatType = isGroup ? "group" : "dm";
    const incoming: IncomingMessage = {
      platform: "wechat",
      connectionId: this.connectionId,
      workspaceId: this.#workspaceId ?? "",
      chatId,
      chatType,
      userId: senderId,
      text,
      messageId: messageId || undefined,
      updateId: messageId || undefined,
      attachments,
      raw: message,
    };
    try {
      await handler(incoming);
    } catch (err) {
      this.#logger?.error?.("wechat: inbound handler failed", err);
    }
  }

  async #downloadMedia(items: IlinkItem[]): Promise<IncomingAttachment[]> {
    const specs: { media?: IlinkMediaRef; aesKey?: string; kind: IncomingAttachment["kind"]; name: string }[] = [];
    for (const item of items) {
      if (item.type === ITEM_IMAGE && item.image_item) {
        specs.push({ media: item.image_item.media, aesKey: item.image_item.aeskey ?? item.image_item.media?.aes_key, kind: "image", name: "image.jpg" });
      } else if (item.type === ITEM_VIDEO && item.video_item) {
        specs.push({ media: item.video_item.media, aesKey: item.video_item.media?.aes_key, kind: "video", name: "video.mp4" });
      } else if (item.type === ITEM_FILE && item.file_item) {
        specs.push({ media: item.file_item.media, aesKey: item.file_item.media?.aes_key, kind: "file", name: item.file_item.file_name ?? "file.bin" });
      } else if (item.type === ITEM_VOICE && item.voice_item && !item.voice_item.text) {
        specs.push({ media: item.voice_item.media, aesKey: item.voice_item.media?.aes_key, kind: "voice", name: "voice.silk" });
      }
    }
    if (specs.length === 0) return [];

    const out: IncomingAttachment[] = [];
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "hb-wechat-"));
    for (const spec of specs) {
      const url = mediaUrl(spec.media, this.#cdnBaseUrl);
      if (!url) {
        // Surface the drop: a media item with no resolvable URL (unknown ref shape).
        const refKeys = spec.media ? Object.keys(spec.media).join(",") || "empty" : "none";
        this.#logger?.warn?.(`wechat: skipped ${spec.kind} — no media URL (ref keys: ${refKeys}) (${this.key})`);
        continue;
      }
      try {
        let bytes = await downloadBytes(url);
        if (spec.aesKey) bytes = aesEcbDecrypt(bytes, parseAesKey(spec.aesKey));
        const safeName = spec.name.replace(/[^\w.-]+/g, "_") || "file";
        const dest = path.join(dir, `${out.length}-${safeName}`);
        await fsp.writeFile(dest, bytes);
        out.push({
          kind: spec.kind,
          sourcePath: dest,
          name: safeName,
          mimeType: guessMime(spec.kind, safeName),
          sizeBytes: bytes.length,
        });
      } catch (err) {
        // Put the real cause IN the message: our LoggerLike is pino-shaped `warn(obj,
        // msg)`, so a 2nd-arg Error is silently dropped (which is why this failed
        // invisibly). Include the endpoint (origin+path, no signed query) and whether
        // an AES key was present, to tell a download HTTP error from a decrypt error.
        const detail = err instanceof Error ? err.message : String(err);
        let endpoint = "?";
        try {
          const parsed = new URL(url);
          endpoint = parsed.origin + parsed.pathname;
        } catch {
          /* leave ? */
        }
        this.#logger?.warn?.(
          `wechat: failed to download ${spec.kind} (endpoint=${endpoint}, aesKey=${spec.aesKey ? "yes" : "no"}): ${detail} (${this.key})`,
        );
      }
    }
    return out;
  }

  #isAllowed(senderId: string): boolean {
    if (this.#allowFrom.size === 0) return true;
    return this.#allowFrom.has(senderId.trim().toLowerCase());
  }

  async #post(
    endpoint: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 15000,
  ): Promise<unknown> {
    const body = JSON.stringify({ ...payload, base_info: { channel_version: CHANNEL_VERSION } });
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.#baseUrl}/${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          AuthorizationType: "ilink_bot_token",
          Authorization: `Bearer ${this.#token}`,
          "X-WECHAT-UIN": randomWechatUin(),
          "iLink-App-Id": ILINK_APP_ID,
          "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
        },
        body,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`iLink ${endpoint} HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function extractText(items: IlinkItem[]): string {
  return items
    .map((item) => {
      if (item.type === ITEM_TEXT) return item.text_item?.text ?? "";
      if (item.type === ITEM_VOICE) return item.voice_item?.text ?? ""; // speech-to-text
      return "";
    })
    .join("")
    .trim();
}

export function mediaUrl(media: IlinkMediaRef | undefined, cdnBase: string): string | null {
  if (!media) return null;
  // Download endpoint is `{cdnBase}/download?encrypted_query_param=<url-encoded param>`
  // (mirrors the `/upload` path). Hitting the CDN root with the raw param 400s — the
  // path AND the `encrypted_query_param=` key + encoding are both required.
  if (media.encrypt_query_param) {
    return `${cdnBase.replace(/\/+$/, "")}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
  }
  if (media.full_url && isAllowedCdnUrl(media.full_url)) return media.full_url;
  return null;
}

function isAllowedCdnUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      CDN_ALLOWLIST.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}

async function downloadBytes(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`wechat media download HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

const HEX_RE = /^[0-9a-fA-F]+$/;
const KEY_HEX_LENGTHS = new Set([32, 48, 64]); // 16/24/32-byte keys as hex
const KEY_BYTE_LENGTHS = new Set([16, 24, 32]);

/**
 * Parse an iLink media AES key into raw key bytes. The key can arrive as: raw hex
 * (image_item.aeskey), base64 of an ASCII hex string (iLink's media aes_key), or
 * plain base64 of the raw key. Check pure-hex first — a hex string is *also* valid
 * base64 (decoding to a wrong length), so base64-first would mis-parse it.
 */
export function parseAesKey(value: string): Buffer {
  const v = value.trim();
  if (HEX_RE.test(v) && KEY_HEX_LENGTHS.has(v.length)) return Buffer.from(v, "hex");
  const decoded = Buffer.from(v, "base64");
  const asText = decoded.toString("ascii");
  if (HEX_RE.test(asText) && KEY_HEX_LENGTHS.has(asText.length)) return Buffer.from(asText, "hex");
  if (KEY_BYTE_LENGTHS.has(decoded.length)) return decoded;
  throw new Error(`unexpected aes key format (${value.length} chars)`);
}

/** PKCS7-padded ciphertext length for a `size`-byte plaintext (matches iLink's
 *  filesize field — always adds 1..16 bytes of padding). */
function aesPaddedSize(size: number): number {
  return (Math.floor(size / 16) + 1) * 16;
}

/** AES-ECB encrypt with PKCS7 padding (the inverse of aesEcbDecrypt). */
export function aesEcbEncrypt(buf: Buffer, key: Buffer): Buffer {
  const algo = key.length === 32 ? "aes-256-ecb" : key.length === 24 ? "aes-192-ecb" : "aes-128-ecb";
  const cipher = createCipheriv(algo, key, null); // Node applies PKCS7 by default
  return Buffer.concat([cipher.update(buf), cipher.final()]);
}

/** Build the WeChat CDN upload URL from getuploadurl's upload_param + filekey. */
function cdnUploadUrl(cdnBase: string, uploadParam: string, filekey: string): string {
  return (
    `${cdnBase.replace(/\/+$/, "")}/upload` +
    `?encrypted_query_param=${encodeURIComponent(uploadParam)}` +
    `&filekey=${encodeURIComponent(filekey)}`
  );
}

/** POST encrypted media bytes to the WeChat CDN; returns the x-encrypted-param
 *  header the send message then references. */
async function uploadCiphertext(url: string, ciphertext: Buffer): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      // Fresh Uint8Array (not the Buffer) so the body type matches fetch's
      // BodyInit under TS's Uint8Array<ArrayBuffer> generic.
      body: Uint8Array.from(ciphertext),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`iLink CDN upload HTTP ${res.status}`);
    const param = res.headers.get("x-encrypted-param");
    if (!param) throw new Error("iLink CDN upload missing x-encrypted-param header");
    return param;
  } finally {
    clearTimeout(timer);
  }
}

/** AES-ECB decrypt with manual PKCS7 stripping (tolerates unpadded payloads). */
export function aesEcbDecrypt(buf: Buffer, key: Buffer): Buffer {
  if (buf.length === 0 || buf.length % 16 !== 0) return buf;
  const algo = key.length === 32 ? "aes-256-ecb" : key.length === 24 ? "aes-192-ecb" : "aes-128-ecb";
  const decipher = createDecipheriv(algo, key, null);
  decipher.setAutoPadding(false);
  const out = Buffer.concat([decipher.update(buf), decipher.final()]);
  const pad = out.length > 0 ? out[out.length - 1]! : 0;
  if (pad >= 1 && pad <= 16 && out.length >= pad) {
    const tail = out.subarray(out.length - pad);
    if (tail.every((b) => b === pad)) return out.subarray(0, out.length - pad);
  }
  return out;
}

function randomWechatUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString("base64");
}

function guessMime(kind: IncomingAttachment["kind"], name: string): string {
  if (kind === "image") return name.endsWith(".png") ? "image/png" : "image/jpeg";
  if (kind === "video") return "video/mp4";
  if (kind === "voice") return "audio/silk";
  return "application/octet-stream";
}

function normalizeAllowlist(values: string[]): Set<string> {
  const out = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (normalized) out.add(normalized);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
