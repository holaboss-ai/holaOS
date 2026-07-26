/**
 * User-facing error copy for integration connect / tool failures.
 *
 * Pulls structured codes from two sources:
 *   1. ComposioToolExecutionError.detail.code (surfaced to chat via the
 *      [composio_error:CODE:SLUG] marker the runtime prepends in
 *      composio-mcp-host.ts).
 *   2. Errors thrown by the desktop's connectIntegrationProvider polling
 *      loop (timeout, FAILED/EXPIRED/INACTIVE Composio account states,
 *      IntegrationConnectCancelled).
 *
 * The single source of truth so IntegrationProposalCard, IntegrationConnectCard,
 * and IntegrationErrorBanner can render the same vocabulary.
 */

export type IntegrationErrorAction = "retry" | "reconnect" | "reopen" | "contact" | "silent";

export interface IntegrationErrorCopy {
  headline: string;
  detail: string;
  action: IntegrationErrorAction;
}

interface ResolveOptions {
  provider?: string;
  /** Raw exception thrown by the OAuth poll loop or a tool call. */
  error?: unknown;
  /** Explicit code, if the caller already extracted one. */
  code?: string;
}

const PROVIDER_FALLBACK = "this integration";

export function resolveIntegrationError(opts: ResolveOptions): IntegrationErrorCopy {
  const provider = opts.provider?.trim() || PROVIDER_FALLBACK;
  const message = errorToMessage(opts.error);
  const code = opts.code ?? inferCode(message, opts.error);

  switch (code) {
    case "user_cancelled":
      return { headline: "", detail: "", action: "silent" };
    case "connection_expired":
    case "connection_not_authorized":
      return {
        headline: `${provider} session expired`,
        detail: `Reconnect to keep using ${provider}.`,
        action: "reconnect",
      };
    case "forbidden":
    case "permission_denied":
    case "insufficient_scope":
      return {
        headline: `${provider} access is incomplete`,
        detail: `Reconnect and make sure to grant all permissions on the consent screen.`,
        action: "reconnect",
      };
    case "rate_limited":
      return {
        headline: `${provider} is busy`,
        detail: "Try again in a minute.",
        action: "retry",
      };
    case "server_error":
      return {
        headline: `Couldn't reach ${provider}`,
        detail:
          "Our integrations service had a hiccup. Wait a moment and try again — if it keeps failing, let us know.",
        action: "retry",
      };
    case "popup_blocked":
      return {
        headline: "Authorization window blocked",
        detail: "Allow popups for the desktop app, then click Reopen.",
        action: "reopen",
      };
    case "network_error":
      return {
        headline: `Couldn't reach ${provider}`,
        detail: "Check your connection and try again.",
        action: "retry",
      };
    case "timeout":
      return {
        headline: `${provider} authorization timed out`,
        detail: "The OAuth window stayed open for too long.",
        action: "retry",
      };
    case "auth_failed":
      return {
        headline: `${provider} authorization failed`,
        detail: "Try connecting again — make sure you grant the requested access.",
        action: "retry",
      };
    case "needs_own_credentials":
      return {
        headline: `${provider} needs your own API key`,
        detail: `holaOS has no shared sign-in for ${provider} — connect it again and paste your key when asked.`,
        action: "reconnect",
      };
    case "not_configured":
      return {
        headline: `${provider} isn't set up yet`,
        detail: "Open the Integrations tab to connect it first.",
        action: "reconnect",
      };
    case "not_found":
      return {
        headline: `${provider} couldn't find that`,
        detail: "The item may have been moved or deleted.",
        action: "retry",
      };
    case "no_workspace":
      return {
        headline: "Open a workspace first",
        detail: "Connecting only works inside a workspace.",
        action: "silent",
      };
    case "tool_failed":
      return {
        headline: `${provider} returned an error`,
        detail: message || "See technical details for the raw response.",
        action: "retry",
      };
    default:
      return {
        headline: "Something went wrong",
        detail: message || `Couldn't reach ${provider}. Try again in a moment.`,
        action: "retry",
      };
  }
}

function errorToMessage(error: unknown): string {
  if (!error) return "";
  let raw: string;
  if (typeof error === "string") {
    raw = error;
  } else if (error instanceof Error) {
    raw = error.message;
  } else if (typeof error === "object" && "message" in error) {
    const m = (error as { message?: unknown }).message;
    raw = typeof m === "string" ? m : String(m ?? "");
  } else {
    raw = String(error);
  }
  return stripIpcWrapper(raw);
}

// Electron's ipcMain.handle rewraps thrown errors with a noisy prefix
// ("Error invoking remote method 'workspace:composioConnect': Error: …")
// that leaks into the UI when we render the raw message. Peel it off so
// the user sees the underlying error verbatim instead of the IPC plumbing.
// Idempotent — safe to apply twice.
function stripIpcWrapper(message: string): string {
  if (!message) return message;
  const match =
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?(.+)$/s.exec(
      message,
    );
  return match?.[1]?.trim() ?? message;
}

function inferCode(message: string, error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "name" in error &&
    (error as { name?: string }).name === "IntegrationConnectCancelled"
  ) {
    return "user_cancelled";
  }
  const lower = message.toLowerCase();
  // Composio holds no managed credentials for this toolkit, so the OAuth path
  // can never succeed for it — retrying is pointless, the user has to supply a
  // key. Checked before the 5xx sweep so the status code can't swallow it.
  if (
    lower.includes("auth_config_defaultauthconfignotfound") ||
    lower.includes("does not have managed credentials")
  ) {
    return "needs_own_credentials";
  }
  if (lower.includes("timed out") || lower.includes("timeout")) return "timeout";
  if (lower.includes("popup") && lower.includes("block")) return "popup_blocked";
  if (
    lower.includes("network") ||
    lower.includes("fetch failed") ||
    lower.includes("failed to fetch")
  ) {
    return "network_error";
  }
  if (lower.includes("expired") || lower.includes("not authorized")) {
    return "connection_expired";
  }
  if (lower.includes("rate") && lower.includes("limit")) return "rate_limited";
  // Backend 5xx — typically surfaces as either the composioFetch-built
  // "Composio API error (500): …" or a bare "500 Internal Server Error".
  // Treat all 5xx the same: it's transient, the user should retry, and
  // they shouldn't see the raw status line.
  if (
    /\bcomposio api error\s*\(5\d\d\)/i.test(message) ||
    /\b5\d\d\b/.test(lower) ||
    lower.includes("internal server error") ||
    lower.includes("bad gateway") ||
    lower.includes("service unavailable") ||
    lower.includes("gateway timeout")
  ) {
    return "server_error";
  }
  if (
    lower.includes("authorization for") &&
    (lower.includes("failed") || lower.includes("expired") || lower.includes("inactive"))
  ) {
    return "auth_failed";
  }
  // Pull the marker emitted by composio-mcp-host (composio-mcp-host.ts).
  const marker = /\[composio_error:([a-z_]+)/i.exec(message);
  if (marker?.[1]) return marker[1].toLowerCase();
  // Fallback: raw "forbidden" / 403 messages from upstream that didn't
  // make it through the marker. Treat as scope/permission issue so the
  // UI offers Reconnect instead of a generic "try again".
  if (
    /\bforbidden\b/.test(lower) ||
    /\b403\b/.test(lower) ||
    lower.includes("insufficient scope") ||
    lower.includes("permission denied")
  ) {
    return "forbidden";
  }
  return "unknown";
}
