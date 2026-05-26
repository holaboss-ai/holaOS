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
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && "message" in error) {
    const m = (error as { message?: unknown }).message;
    return typeof m === "string" ? m : String(m ?? "");
  }
  return String(error);
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
