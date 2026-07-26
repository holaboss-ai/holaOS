/**
 * Feishu / Lark "scan-to-create" device-code onboarding. The user scans a QR code
 * with their Feishu/Lark mobile app and the platform auto-creates a pre-configured
 * `PersonalAgent` app (scopes + long-connection baked in), handing back the
 * app_id + app_secret. No developer console, no scopes, no admin approval.
 *
 * Endpoint shape per Feishu's open API
 * (accounts.feishu.cn / accounts.larksuite.com  /oauth/v1/app/registration).
 */

const ACCOUNTS_BASE_URLS: Record<string, string> = {
  feishu: "https://accounts.feishu.cn",
  lark: "https://accounts.larksuite.com",
};
const REGISTRATION_PATH = "/oauth/v1/app/registration";

export type FeishuDomain = "feishu" | "lark";

export interface FeishuRegistrationOptions {
  domain?: FeishuDomain;
  /** Override the accounts base URL (tests / self-hosted). */
  baseUrl?: string;
}

function accountsBaseUrl(options: FeishuRegistrationOptions): string {
  if (options.baseUrl) return options.baseUrl.replace(/\/+$/, "");
  return ACCOUNTS_BASE_URLS[options.domain ?? "feishu"] ?? ACCOUNTS_BASE_URLS.feishu;
}

/**
 * Concise, secret-redacted one-line summary of a registration response — enough
 * to diagnose an onboarding hang (which keys came back, the error/code, whether
 * credentials are present and where) without leaking client_secret into the log.
 */
function describeRegistrationResponse(res: Record<string, unknown>): string {
  const info: Record<string, unknown> = { keys: Object.keys(res) };
  if (res.error !== undefined) info.error = res.error;
  if (res.code !== undefined) info.code = res.code;
  if (res.error_description) info.error_description = res.error_description;
  if (res.message) info.message = res.message;
  if (res.client_id) info.client_id = `${String(res.client_id).slice(0, 6)}…`;
  info.has_client_secret = Boolean(res.client_secret);
  if (res.data && typeof res.data === "object") info.data_keys = Object.keys(res.data as object);
  if (res.user_info && typeof res.user_info === "object") {
    const ui = res.user_info as Record<string, unknown>;
    info.user_info_keys = Object.keys(ui);
    if (ui.tenant_brand !== undefined) info.tenant_brand = ui.tenant_brand;
  }
  return JSON.stringify(info);
}

async function postRegistration(
  options: FeishuRegistrationOptions,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = `${accountsBaseUrl(options)}${REGISTRATION_PATH}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15000),
  });
  // The endpoint returns JSON even on 4xx (e.g. authorization_pending as 400).
  let parsed: Record<string, unknown>;
  try {
    parsed = (await response.json()) as Record<string, unknown>;
  } catch {
    console.warn(`[feishu-onboard] action=${body.action} HTTP ${response.status} non-JSON body url=${url}`);
    throw new Error(`feishu registration request failed: HTTP ${response.status}`);
  }
  // `init` is a noisy capability probe; log the meaningful begin/poll calls so a
  // stuck onboarding leaves a breadcrumb trail in runtime.log (grep feishu-onboard).
  if (body.action !== "init") {
    console.warn(
      `[feishu-onboard] action=${body.action} domain=${options.domain ?? "feishu"} http=${response.status} ${describeRegistrationResponse(parsed)}`,
    );
  }
  return parsed;
}

export interface FeishuDeviceAuthStart {
  deviceCode: string;
  /** verification_uri_complete — render this as a QR code for the user to scan. */
  qrUrl: string;
  userCode: string;
  intervalSec: number;
  expiresInSec: number;
}

export async function beginFeishuRegistration(
  options: FeishuRegistrationOptions = {},
): Promise<FeishuDeviceAuthStart> {
  // Best-effort capability probe; the begin call surfaces real failures.
  try {
    const init = await postRegistration(options, { action: "init" });
    const methods = Array.isArray(init.supported_auth_methods) ? init.supported_auth_methods : [];
    if (methods.length > 0 && !methods.includes("client_secret")) {
      throw new Error(`feishu registration does not support client_secret auth (${JSON.stringify(methods)})`);
    }
  } catch {
    // non-fatal — proceed to begin
  }

  const res = await postRegistration(options, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  });
  const deviceCode = String(res.device_code ?? "").trim();
  let qrUrl = String(res.verification_uri_complete ?? "").trim();
  if (!deviceCode || !qrUrl) {
    throw new Error("feishu registration did not return a device_code / verification_uri");
  }
  qrUrl += (qrUrl.includes("?") ? "&" : "?") + "from=holaos&tp=holaos";

  return {
    deviceCode,
    qrUrl,
    userCode: String(res.user_code ?? ""),
    intervalSec: Math.max(Number(res.interval) || 5, 2),
    // The live endpoint returns `expires_in` (OAuth-style); older docs say
    // `expire_in`. Accept both so the poll window isn't silently clamped to 600s.
    expiresInSec: Number(res.expires_in ?? res.expire_in) || 600,
  };
}

export type FeishuPollStatus = "pending" | "success" | "denied" | "expired";

export interface FeishuPollResult {
  status: FeishuPollStatus;
  appId?: string;
  appSecret?: string;
  domain?: FeishuDomain;
  openId?: string;
}

/** A single poll round-trip against one accounts domain. */
async function pollRegistrationOnce(
  deviceCode: string,
  options: FeishuRegistrationOptions,
): Promise<FeishuPollResult & { tenantBrand?: string }> {
  const res = await postRegistration(options, {
    action: "poll",
    device_code: deviceCode,
    tp: "ob_app",
  });

  // Credentials are top-level on the live endpoint, but defensively also accept a
  // `data` envelope in case a domain/version wraps them — and source user_info
  // from wherever the creds came from.
  const data =
    res.data && typeof res.data === "object" ? (res.data as Record<string, unknown>) : {};
  const appId = String(res.client_id ?? data.client_id ?? "").trim();
  const appSecret = String(res.client_secret ?? data.client_secret ?? "").trim();
  const rawUserInfo = res.user_info ?? data.user_info;
  const userInfo =
    rawUserInfo && typeof rawUserInfo === "object"
      ? (rawUserInfo as Record<string, unknown>)
      : {};
  const tenantBrand = typeof userInfo.tenant_brand === "string" ? userInfo.tenant_brand : undefined;

  if (appId && appSecret) {
    const resolvedDomain: FeishuDomain = tenantBrand === "lark" ? "lark" : options.domain ?? "feishu";
    return {
      status: "success",
      appId,
      appSecret,
      domain: resolvedDomain,
      openId: typeof userInfo.open_id === "string" ? userInfo.open_id : undefined,
      tenantBrand,
    };
  }

  const error = String(res.error ?? "").trim();
  if (error === "access_denied") return { status: "denied", tenantBrand };
  if (error === "expired_token") return { status: "expired", tenantBrand };
  return { status: "pending", tenantBrand };
}

/**
 * Poll a registration to completion-or-pending. We always poll the Feishu hub
 * (`accounts.feishu.cn`) because it serves BOTH Feishu (China) and Lark
 * (international) tenants and reports the real one via `user_info.tenant_brand`.
 * That removes the feishu-vs-lark guess from onboarding entirely: the user just
 * scans with whichever app they have. When the hub reports a Lark tenant but the
 * credentials are provisioned on the Lark endpoint, we re-poll there with the
 * same device code (a mid-loop domain switch).
 *
 * A `baseUrl` override pins a single endpoint (tests / self-hosted) and disables
 * the cross-domain fallback.
 */
export async function pollFeishuRegistration(
  deviceCode: string,
  options: FeishuRegistrationOptions = {},
): Promise<FeishuPollResult> {
  const hubDomain: FeishuDomain = options.domain ?? "feishu";
  const primary = await pollRegistrationOnce(deviceCode, { ...options, domain: hubDomain });
  if (primary.status !== "pending") return primary;

  if (primary.tenantBrand === "lark" && hubDomain !== "lark" && !options.baseUrl) {
    const lark = await pollRegistrationOnce(deviceCode, { domain: "lark" });
    if (lark.status !== "pending") return lark;
  }
  return { status: "pending" };
}
