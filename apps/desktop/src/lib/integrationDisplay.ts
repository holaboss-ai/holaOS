import { useIntegrationAccountMetadata } from "./integrationAccountStore";

/**
 * Resolve a human-readable account label from the freshest source available.
 * Whoami-derived metadata wins over persisted connection fields because the
 * latter can be stale or admin-supplied — but each tier falls back to the
 * persisted column so a missed whoami fetch (offline, Composio hiccup, or
 * a connection minted before whoami enrichment shipped) still surfaces a
 * recognisable identity instead of a generic "Account N". Auto-generated
 * `<provider> (Managed)` labels and raw `ca_…` Composio IDs fall through.
 */
export function accountDisplayLabel(
  conn: IntegrationConnectionPayload,
  meta: ComposioAccountStatus | undefined,
  index: number,
): string {
  const handle = (meta?.handle ?? conn.account_handle ?? "").trim();
  if (handle) {
    return handle.startsWith("@") ? handle : `@${handle}`;
  }
  const email = (meta?.email ?? conn.account_email ?? "").trim();
  if (email) return email;
  const displayName = meta?.displayName?.trim();
  if (displayName) return displayName;
  // Auto-generated `<provider> (Managed)` and raw `ca_…` Composio IDs
  // are noisy — but they still tell the user "this is the foo provider"
  // better than a generic index. Keep them as a last-resort label;
  // they only lose to real identity above, not to the index fallback.
  const label = (conn.account_label ?? "").trim();
  if (label) return label;
  return `Account ${index + 1}`;
}

/** First letter for the lettered-avatar fallback (strips a leading `@`). */
export function accountAvatarFallbackChar(label: string): string {
  return label.replace(/^@/, "").charAt(0).toUpperCase() || "?";
}

/**
 * Fetch Composio whoami metadata for the given connections, sharing a
 * single app-level cache across all consumers. Thin re-export of the
 * store hook so call sites can stay on the display module's surface.
 */
export const useEnrichedConnections = useIntegrationAccountMetadata;
