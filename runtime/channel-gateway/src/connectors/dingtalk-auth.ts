/**
 * DingTalk "scan-to-create" device-code onboarding. The user scans a QR code with
 * their DingTalk mobile app and the platform auto-creates an app, handing back the
 * client_id (AppKey) + client_secret (AppSecret) — no developer console.
 *
 * Endpoint shape per DingTalk's open API (oapi.dingtalk.com/app/registration).
 */

const REGISTRATION_BASE_URL = "https://oapi.dingtalk.com";
const REGISTRATION_SOURCE = "holaos";

export interface DingtalkRegistrationOptions {
  /** Override the registration base URL (tests / self-hosted). */
  baseUrl?: string;
}

async function postRegistration(
  options: DingtalkRegistrationOptions,
  path: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const base = (options.baseUrl ?? REGISTRATION_BASE_URL).replace(/\/+$/, "");
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const data = (await response.json()) as Record<string, unknown>;
  const errcode = typeof data.errcode === "number" ? data.errcode : 0;
  if (errcode !== 0) {
    throw new Error(
      `dingtalk registration error: ${String(data.errmsg ?? "unknown")} (errcode=${errcode})`,
    );
  }
  return data;
}

export interface DingtalkDeviceAuthStart {
  deviceCode: string;
  /** verification_uri_complete — render this as a QR code for the user to scan. */
  qrUrl: string;
  intervalSec: number;
  expiresInSec: number;
}

export async function beginDingtalkRegistration(
  options: DingtalkRegistrationOptions = {},
): Promise<DingtalkDeviceAuthStart> {
  const init = await postRegistration(options, "/app/registration/init", {
    source: REGISTRATION_SOURCE,
  });
  const nonce = String(init.nonce ?? "").trim();
  if (!nonce) throw new Error("dingtalk registration init missing nonce");

  const begin = await postRegistration(options, "/app/registration/begin", { nonce });
  const deviceCode = String(begin.device_code ?? "").trim();
  const qrUrl = String(begin.verification_uri_complete ?? "").trim();
  if (!deviceCode || !qrUrl) {
    throw new Error("dingtalk registration begin missing device_code / verification_uri");
  }

  return {
    deviceCode,
    qrUrl,
    intervalSec: Math.max(Number(begin.interval) || 3, 2),
    expiresInSec: Number(begin.expires_in) || 7200,
  };
}

export type DingtalkPollStatus = "pending" | "success" | "denied" | "expired";

export interface DingtalkPollResult {
  status: DingtalkPollStatus;
  appId?: string;
  appSecret?: string;
}

export async function pollDingtalkRegistration(
  deviceCode: string,
  options: DingtalkRegistrationOptions = {},
): Promise<DingtalkPollResult> {
  const res = await postRegistration(options, "/app/registration/poll", { device_code: deviceCode });
  const status = String(res.status ?? "").trim().toUpperCase();
  const appId = String(res.client_id ?? "").trim();
  const appSecret = String(res.client_secret ?? "").trim();

  if (status === "SUCCESS" && appId && appSecret) {
    return { status: "success", appId, appSecret };
  }
  if (status === "FAIL") return { status: "denied" };
  if (status === "EXPIRED") return { status: "expired" };
  return { status: "pending" };
}
