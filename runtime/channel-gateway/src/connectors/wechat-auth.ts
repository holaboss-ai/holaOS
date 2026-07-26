/**
 * Personal WeChat (iLink) QR scan-to-login device flow.
 *
 * Mirrors the Feishu/DingTalk device-flow shape so it plugs into the existing
 * `channels.startDeviceAuth` / `pollDeviceAuth` oRPC + the QR dialog: begin →
 * fetch a QR; poll → until the user scans + confirms in the WeChat app, then
 * iLink returns the bot session credentials
 * (Tencent's iLink "微信 ClawBot" protocol at ilinkai.weixin.qq.com).
 *
 * NOTE: semi-official, reverse-engineered protocol — endpoints could change, and
 * this has not been validated end-to-end here (needs a real WeChat account).
 */

const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const ILINK_APP_ID = "bot";
// (2 << 16) | (2 << 8) | 0 — iLink client version 2.2.0
const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0);
const EP_GET_BOT_QR = "ilink/bot/get_bot_qrcode";
const EP_GET_QR_STATUS = "ilink/bot/get_qrcode_status";

export interface WechatDeviceAuthStart {
  deviceCode: string;
  qrUrl: string;
  intervalSec: number;
  expiresInSec: number;
}

export interface WechatPollResult {
  status: "pending" | "success" | "denied" | "expired";
  /** iLink bot identity (account id), present on success. */
  botId?: string;
  /** Bot session token, present on success. */
  token?: string;
  /** Per-account API base URL iLink assigns, present on success. */
  baseUrl?: string;
  /** The logged-in user's iLink id, present on success. */
  userId?: string;
}

interface WechatAuthOptions {
  /** Override the iLink base (tests). */
  baseUrl?: string;
}

// iLink may redirect polling to a per-session host (`scaned_but_redirect`). The
// poll call is otherwise stateless, so remember the host per device code here so
// subsequent polls hit the right server. Single-process api-server → a module
// map is sufficient.
const redirectBase = new Map<string, string>();

async function ilinkGet(base: string, endpoint: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base.replace(/\/+$/, "")}/${endpoint}`, {
    headers: {
      "iLink-App-Id": ILINK_APP_ID,
      "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`iLink GET ${endpoint} HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Begin the QR login: fetch a scannable QR and a device code to poll. */
export async function beginWechatRegistration(
  options: WechatAuthOptions = {},
): Promise<WechatDeviceAuthStart> {
  const base = options.baseUrl ?? ILINK_BASE_URL;
  const res = await ilinkGet(base, `${EP_GET_BOT_QR}?bot_type=3`);
  const deviceCode = String(res.qrcode ?? "");
  const qrUrl = String(res.qrcode_img_content ?? "");
  if (!deviceCode) throw new Error("WeChat QR response missing qrcode");
  redirectBase.set(deviceCode, base);
  // The scannable payload is the full liteapp URL when present, else the token.
  return { deviceCode, qrUrl: qrUrl || deviceCode, intervalSec: 2, expiresInSec: 480 };
}

/** Poll the QR status once. Returns success (with credentials) when confirmed. */
export async function pollWechatRegistration(
  deviceCode: string,
  options: WechatAuthOptions = {},
): Promise<WechatPollResult> {
  const base = options.baseUrl ?? redirectBase.get(deviceCode) ?? ILINK_BASE_URL;
  let res: Record<string, unknown>;
  try {
    res = await ilinkGet(base, `${EP_GET_QR_STATUS}?qrcode=${encodeURIComponent(deviceCode)}`);
  } catch {
    return { status: "pending" }; // transient — keep polling
  }
  const status = String(res.status ?? "wait");
  if (status === "wait" || status === "scaned") return { status: "pending" };
  if (status === "scaned_but_redirect") {
    const host = String(res.redirect_host ?? "").trim();
    if (host) redirectBase.set(deviceCode, `https://${host}`);
    return { status: "pending" };
  }
  if (status === "expired") {
    redirectBase.delete(deviceCode);
    return { status: "expired" };
  }
  if (status === "confirmed") {
    redirectBase.delete(deviceCode);
    const botId = String(res.ilink_bot_id ?? "");
    const token = String(res.bot_token ?? "");
    if (!botId || !token) return { status: "denied" };
    return {
      status: "success",
      botId,
      token,
      baseUrl: String(res.baseurl ?? ILINK_BASE_URL),
      userId: String(res.ilink_user_id ?? ""),
    };
  }
  return { status: "pending" };
}
