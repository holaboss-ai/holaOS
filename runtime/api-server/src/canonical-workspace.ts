import type { RuntimeStateStore } from "@holaboss/runtime-state-store";

/**
 * Single-tenant pin — workspace-removal Piece 1.
 *
 * The runtime hosts exactly one workspace. This resolves its id from the
 * control-plane registry so the *server* decides which workspace every request
 * targets — the client no longer does. It is the single source of truth behind
 * both ingress doorways:
 *   1. the REST capability surface (the `x-holaboss-workspace-id` header), and
 *   2. the oRPC / MCP surface (the `workspaceId` field on every input).
 *
 * Resolution:
 *   - 0 workspaces  → "" — matches the legacy "no id supplied" surface, so the
 *                     required-id paths still reject and `GET /workspaces`
 *                     remains free to auto-provision the first one.
 *   - 1 workspace   → its id (the steady state).
 *   - >1 workspaces → the most-recently-updated wins; `onAmbiguous` fires so the
 *                     collapse is logged, never silent.
 *
 * `listWorkspaces()` already excludes soft-deleted rows and orders by
 * `updated_at DESC, created_at DESC, id DESC`, so element 0 is the natural
 * survivor of a collapse.
 *
 * Removed in Piece 5, once `workspace_id` leaves the schema entirely.
 */
export function resolveCanonicalWorkspaceId(
  store: Pick<RuntimeStateStore, "listWorkspaces">,
  onAmbiguous?: (workspaceIds: string[]) => void,
): string {
  const workspaces = store.listWorkspaces({ includeDeleted: false });
  if (workspaces.length === 0) {
    return "";
  }
  if (workspaces.length > 1) {
    onAmbiguous?.(workspaces.map((workspace) => workspace.id));
  }
  return workspaces[0].id;
}

/**
 * Forces `workspaceId` to the canonical workspace on every service-method input
 * reachable from a Remote API context — the oRPC / MCP counterpart to the REST
 * `onRequest` header stamp. Service methods read `input.workspaceId`; this
 * rewrites it server-side so a caller cannot address a different workspace.
 *
 * Methods whose first argument is not a `workspaceId`-bearing object pass
 * through untouched, and inputs are shallow-copied rather than mutated in place.
 * A falsy canonical id (no workspace yet) is a no-op, preserving today's
 * behaviour until the first workspace exists.
 *
 * Part of the Piece 1 single-tenant pin; removed in Piece 3, when `workspaceId`
 * leaves the contract and the services read the canonical id directly.
 */
export function pinWorkspaceIdInContext<T>(context: T, canonicalWorkspaceId: string): T {
  if (!canonicalWorkspaceId) {
    return context;
  }
  return pinValue(context, canonicalWorkspaceId) as T;
}

function pinValue(value: unknown, canonicalWorkspaceId: string): unknown {
  if (typeof value === "function") {
    const method = value as (...args: unknown[]) => unknown;
    return (...args: unknown[]): unknown => {
      const [first, ...rest] = args;
      if (isPlainRecord(first) && "workspaceId" in first) {
        return method({ ...first, workspaceId: canonicalWorkspaceId }, ...rest);
      }
      return method(...args);
    };
  }
  if (isPlainRecord(value)) {
    const pinned: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      pinned[key] = pinValue(nested, canonicalWorkspaceId);
    }
    return pinned;
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
