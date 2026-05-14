import fs from "node:fs";
import path from "node:path";

const HOLABOSS_RUNTIME_CONFIG_PATH_ENV = "HOLABOSS_RUNTIME_CONFIG_PATH";
const HB_SANDBOX_ROOT_ENV = "HB_SANDBOX_ROOT";

const OPENAI_CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_SKEW_MS = 60 * 1000;
const RECENT_REFRESH_DEDUPE_MS = 5 * 1000;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

type StringMap = Record<string, unknown>;

let inFlightRefresh: Promise<void> | null = null;
let lastRefreshAttemptMs = 0;

function runtimeConfigPath(): string {
  const explicit = (process.env[HOLABOSS_RUNTIME_CONFIG_PATH_ENV] ?? "").trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const sandboxRoot = (process.env[HB_SANDBOX_ROOT_ENV] ?? "").trim() || "/holaboss";
  return path.join(sandboxRoot, "state", "runtime-config.json");
}

function isRecord(value: unknown): value is StringMap {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): StringMap {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function expiryTimestampMs(value: unknown): number {
  const normalized = asString(value);
  if (!normalized) return 0;
  const ts = Date.parse(normalized);
  return Number.isFinite(ts) ? ts : 0;
}

function needsRefresh(expiresAt: unknown, skewMs: number): boolean {
  const ts = expiryTimestampMs(expiresAt);
  if (!ts) return true;
  return ts - Date.now() <= skewMs;
}

function accessTokenExpiresAtIso(expiresIn: unknown): string {
  const raw =
    typeof expiresIn === "number"
      ? expiresIn
      : typeof expiresIn === "string"
        ? Number.parseInt(expiresIn, 10)
        : NaN;
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EXPIRES_IN_SECONDS;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

interface CodexProviderEntry {
  providerKey: string;
  refreshToken: string;
  expiresAt: string;
  lastRefreshAt: string;
}

function collectCodexProviders(document: StringMap): CodexProviderEntry[] {
  const providers = asRecord(document.providers);
  const entries: CodexProviderEntry[] = [];
  for (const [key, raw] of Object.entries(providers)) {
    const provider = asRecord(raw);
    const options = asRecord(provider.options);
    const authMode = asString(provider.auth_mode) || asString(options.auth_mode);
    if (authMode !== "codex_oauth") continue;
    const refreshToken = asString(options.refresh_token);
    if (!refreshToken) continue;
    entries.push({
      providerKey: key,
      refreshToken,
      expiresAt: asString(options.access_token_expires_at),
      lastRefreshAt: asString(options.last_refresh_at),
    });
  }
  return entries;
}

async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OPENAI_CODEX_OAUTH_CLIENT_ID,
  });
  const response = await fetch(OPENAI_CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const detail = asString(payload.error_description) || asString(payload.error) || text;
    throw new Error(`Codex token refresh failed (${response.status}): ${detail}`);
  }
  const accessToken = asString(payload.access_token);
  const nextRefreshToken = asString(payload.refresh_token) || refreshToken;
  if (!accessToken) {
    throw new Error("Codex token refresh returned no access_token");
  }
  return {
    accessToken,
    refreshToken: nextRefreshToken,
    expiresAt: accessTokenExpiresAtIso(payload.expires_in),
  };
}

function applyRefreshToDocument(
  document: StringMap,
  providerKey: string,
  refreshed: { accessToken: string; refreshToken: string; expiresAt: string },
): StringMap {
  const providers = { ...asRecord(document.providers) };
  const provider = { ...asRecord(providers[providerKey]) };
  const options = { ...asRecord(provider.options) };
  provider.api_key = refreshed.accessToken;
  options.refresh_token = refreshed.refreshToken;
  options.access_token_expires_at = refreshed.expiresAt;
  options.last_refresh_at = new Date().toISOString();
  provider.options = options;
  providers[providerKey] = provider;
  return { ...document, providers };
}

function writeDocumentAtomically(document: StringMap, configPath: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.codex.tmp`;
  const nextText = `${JSON.stringify(document, null, 2)}\n`;
  fs.writeFileSync(tempPath, nextText, "utf8");
  try {
    fs.renameSync(tempPath, configPath);
  } catch {
    try {
      fs.rmSync(configPath, { force: true });
      fs.renameSync(tempPath, configPath);
    } finally {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // ignore
      }
    }
  }
}

function readDocument(configPath: string): StringMap | null {
  if (!fs.existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function runRefreshPass(skewMs: number): Promise<void> {
  const configPath = runtimeConfigPath();
  const document = readDocument(configPath);
  if (!document) return;

  const candidates = collectCodexProviders(document);
  if (candidates.length === 0) return;

  let nextDocument = document;
  let changed = false;

  for (const entry of candidates) {
    if (!needsRefresh(entry.expiresAt, skewMs)) continue;
    const lastRefreshTs = entry.lastRefreshAt ? Date.parse(entry.lastRefreshAt) : 0;
    if (
      Number.isFinite(lastRefreshTs) &&
      lastRefreshTs > 0 &&
      Date.now() - lastRefreshTs < RECENT_REFRESH_DEDUPE_MS
    ) {
      continue;
    }
    try {
      const refreshed = await refreshAccessToken(entry.refreshToken);
      nextDocument = applyRefreshToDocument(nextDocument, entry.providerKey, refreshed);
      changed = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[codex-refresh] ${entry.providerKey}: ${message}`);
    }
  }

  if (changed) {
    writeDocumentAtomically(nextDocument, configPath);
  }
}

export function hasCodexProviderConfigured(): boolean {
  const document = readDocument(runtimeConfigPath());
  if (!document) return false;
  return collectCodexProviders(document).length > 0;
}

export async function ensureCodexTokensFresh(skewMs: number = DEFAULT_SKEW_MS): Promise<void> {
  if (inFlightRefresh) {
    return inFlightRefresh;
  }
  if (Date.now() - lastRefreshAttemptMs < RECENT_REFRESH_DEDUPE_MS) {
    return;
  }
  lastRefreshAttemptMs = Date.now();
  inFlightRefresh = runRefreshPass(skewMs).finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}
