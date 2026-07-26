import type { DesktopBrowserToolId } from "./desktop-browser-tools.js";
import {
  formatCapabilityToolResultForModel,
  isRecord,
  normalizeRuntimeApiBaseUrl,
  requestCapabilityJson,
  toolRequestSignal,
} from "./capability-http.js";

const BROWSER_CAPABILITY_STATUS_PATH = "/api/v1/capabilities/browser";
const BROWSER_CAPABILITY_TOOL_PATH = "/api/v1/capabilities/browser/tools";
const DEFAULT_BROWSER_TOOL_TIMEOUT_MS = 30000;

export interface BrowserCapabilityClientOptions {
  runtimeApiBaseUrl: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
  space?: "agent" | null;
  // First-class browser profile to drive. This is the primary browser selector
  // (a single root workspace exists, so workspace drops out of addressing).
  browserProfileId?: string | null;
  fetchImpl?: typeof fetch;
}

function capabilityStatusUrl(runtimeApiBaseUrl: string): string {
  return `${runtimeApiBaseUrl}${BROWSER_CAPABILITY_STATUS_PATH}`;
}

function capabilityToolUrl(runtimeApiBaseUrl: string, toolId: DesktopBrowserToolId): string {
  return `${runtimeApiBaseUrl}${BROWSER_CAPABILITY_TOOL_PATH}/${toolId}`;
}

export function browserCapabilityHeaders(
  workspaceId?: string | null,
  sessionId?: string | null,
  inputId?: string | null,
  space?: "agent" | null,
  browserProfileId?: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const normalizedWorkspaceId = typeof workspaceId === "string" ? workspaceId.trim() : "";
  if (normalizedWorkspaceId) {
    headers["x-holaboss-workspace-id"] = normalizedWorkspaceId;
  }
  const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  if (normalizedSessionId) {
    headers["x-holaboss-session-id"] = normalizedSessionId;
  }
  const normalizedInputId = typeof inputId === "string" ? inputId.trim() : "";
  if (normalizedInputId) {
    headers["x-holaboss-input-id"] = normalizedInputId;
  }
  if (space === "agent") {
    headers["x-holaboss-browser-space"] = space;
  }
  const normalizedProfileId = typeof browserProfileId === "string" ? browserProfileId.trim() : "";
  if (normalizedProfileId) {
    headers["x-holaboss-browser-profile-id"] = normalizedProfileId;
  }
  return headers;
}

export function resolveBrowserCapabilityBaseUrl(value: unknown): string {
  return normalizeRuntimeApiBaseUrl(value);
}

export async function browserCapabilityAvailable(
  options: BrowserCapabilityClientOptions,
): Promise<boolean> {
  try {
    const response = await requestCapabilityJson({
      url: capabilityStatusUrl(options.runtimeApiBaseUrl),
      method: "GET",
      headers: browserCapabilityHeaders(options.workspaceId, options.sessionId, options.inputId, options.space, options.browserProfileId),
      signal: AbortSignal.timeout(2000),
      fetchImpl: options.fetchImpl,
    });
    return response.ok && isRecord(response.payload) && response.payload.available === true;
  } catch {
    return false;
  }
}

export async function executeBrowserCapabilityTool(params: BrowserCapabilityClientOptions & {
  toolId: DesktopBrowserToolId;
  toolParams: unknown;
  signal?: AbortSignal;
}): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: {
    tool_id: DesktopBrowserToolId;
    browser_usage?: Record<string, unknown>;
    raw?: unknown;
    raw_result_bytes?: number;
    model_result_bytes?: number;
  };
}> {
  const response = await requestCapabilityJson({
    url: capabilityToolUrl(params.runtimeApiBaseUrl, params.toolId),
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...browserCapabilityHeaders(params.workspaceId, params.sessionId, params.inputId, params.space, params.browserProfileId),
    },
    body: JSON.stringify(isRecord(params.toolParams) ? params.toolParams : {}),
    signal: toolRequestSignal(params.signal, DEFAULT_BROWSER_TOOL_TIMEOUT_MS),
    fetchImpl: params.fetchImpl,
  });
  if (!response.ok) {
    const message = isRecord(response.payload)
      ? String(response.payload.detail ?? response.payload.error ?? `Holaboss browser tool '${params.toolId}' failed.`)
      : `Holaboss browser tool '${params.toolId}' failed.`;
    throw new Error(message);
  }
  const payloadRecord = isRecord(response.payload) ? response.payload : null;
  const browserUsage = isRecord(payloadRecord?.browser_usage)
    ? (payloadRecord?.browser_usage as Record<string, unknown>)
    : null;
  const modelPayload =
    payloadRecord && browserUsage
      ? Object.fromEntries(
          Object.entries(payloadRecord).filter(([key]) => key !== "browser_usage"),
        )
      : response.payload;
  const formatted = formatCapabilityToolResultForModel(modelPayload);
  return {
    content: [{ type: "text", text: formatted.text }],
    details: {
      tool_id: params.toolId,
      ...(browserUsage ? { browser_usage: browserUsage } : {}),
      ...(formatted.compacted
        ? {
            raw: response.payload,
            raw_result_bytes: formatted.serializedBytes,
            model_result_bytes: formatted.modelTextBytes,
          }
        : {}),
    },
  };
}

/**
 * List the browser profiles the desktop exposes. Used by the `browser_list_profiles`
 * tool so the agent can discover ids to pass to `browser_use_profile`. Each profile
 * carries a 1-based `index` (its position in the list, matching the number shown in
 * the desktop Profiles page) so the user can say "use profile #1".
 */
export async function listBrowserCapabilityProfiles(
  options: BrowserCapabilityClientOptions & { signal?: AbortSignal },
): Promise<
  Array<{
    id: string;
    name: string;
    index: number;
    running: boolean;
    isDefault: boolean;
  }>
> {
  const response = await requestCapabilityJson({
    url: `${options.runtimeApiBaseUrl}/api/v1/capabilities/browser/profiles`,
    method: "GET",
    headers: browserCapabilityHeaders(
      options.workspaceId,
      options.sessionId,
      options.inputId,
      options.space,
      options.browserProfileId,
    ),
    signal: options.signal ?? AbortSignal.timeout(5000),
    fetchImpl: options.fetchImpl,
  });
  const payload = isRecord(response.payload) ? response.payload : null;
  const rawProfiles = Array.isArray(payload?.profiles) ? payload.profiles : [];
  return rawProfiles
    .filter(
      (entry): entry is { id: string; name: string } =>
        isRecord(entry) &&
        typeof entry.id === "string" &&
        typeof entry.name === "string",
    )
    .map((entry, position) => ({
      id: entry.id,
      name: entry.name,
      index: position + 1,
      running: (entry as { running?: unknown }).running === true,
      isDefault: (entry as { isDefault?: unknown }).isDefault === true,
    }));
}

/**
 * Open (launch) or close a profile's native browser window. The target profile
 * is carried in the x-holaboss-browser-profile-id header via `browserProfileId`.
 */
async function postBrowserCapabilityProfileAction(
  action: "launch" | "close",
  options: BrowserCapabilityClientOptions & { signal?: AbortSignal },
): Promise<{ ok: boolean; error?: string }> {
  const response = await requestCapabilityJson({
    url: `${options.runtimeApiBaseUrl}/api/v1/capabilities/browser/profiles/${action}`,
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...browserCapabilityHeaders(
        options.workspaceId,
        options.sessionId,
        options.inputId,
        options.space,
        options.browserProfileId,
      ),
    },
    body: "{}",
    signal: options.signal ?? AbortSignal.timeout(15000),
    fetchImpl: options.fetchImpl,
  });
  const payload = isRecord(response.payload) ? response.payload : null;
  if (!response.ok || payload?.ok === false) {
    const error =
      (payload && typeof payload.error === "string" && payload.error) ||
      (payload && typeof payload.detail === "string" && payload.detail) ||
      `Could not ${action} the browser profile.`;
    return { ok: false, error };
  }
  return { ok: true };
}

export function launchBrowserCapabilityProfile(
  options: BrowserCapabilityClientOptions & { signal?: AbortSignal },
): Promise<{ ok: boolean; error?: string }> {
  return postBrowserCapabilityProfileAction("launch", options);
}

export function closeBrowserCapabilityProfile(
  options: BrowserCapabilityClientOptions & { signal?: AbortSignal },
): Promise<{ ok: boolean; error?: string }> {
  return postBrowserCapabilityProfileAction("close", options);
}
