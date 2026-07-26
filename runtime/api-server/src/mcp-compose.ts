import type { ResolvedMcpServerConfig, ResolvedMcpToolRef } from "./workspace-runtime-plan.js";

/**
 * One slice of the resolved MCP set, already namespaced by its source. Every
 * MCP origin (workspace.yaml registry, capabilities, composio, apps, the
 * harness runtime server) is expected to project itself into this shape so the
 * composer can fold them all through a single precedence + dedup pass instead
 * of the ad-hoc merge sites scattered across the runner.
 */
export type McpContribution = {
  /** Origin label — kept on each kept entry so "who contributed this tool?" is answerable. */
  source: string;
  servers: ResolvedMcpServerConfig[];
  toolRefs: ResolvedMcpToolRef[];
};

/**
 * A source adapter that resolves its MCP contribution. Sources differ in
 * timing (workspace.yaml is pure/compile-time, capabilities read the store,
 * composio is an async runtime fetch), so `contribute` is async; the composer
 * itself stays pure and operates on the already-resolved {@link McpContribution}s.
 *
 * Not yet wired — declared here so step 2 (lifting composio/app/runtime into
 * adapters) has a stable seam to implement against.
 */
export type McpContributor<Ctx = unknown> = {
  source: string;
  contribute(ctx: Ctx): Promise<McpContribution> | McpContribution;
};

export type ComposedMcp = {
  servers: ResolvedMcpServerConfig[];
  toolRefs: ResolvedMcpToolRef[];
  /** Every kept tool_id, in resolved order — feeds `mcp_tool_allowlist`. */
  allowlist: string[];
  /** server_id -> contributing source. */
  serverSourceById: Map<string, string>;
  /** tool_id -> contributing source. */
  toolSourceById: Map<string, string>;
};

export type KeyedEntry<T> = { key: string; value: T; source: string };

/**
 * Precedence policy for {@link foldKeyed}.
 * - `first-wins`: the first entry for a key holds the slot; later collisions are
 *   dropped (additive — nothing already resolved is displaced). Used by the
 *   static IR tier (workspace + capabilities).
 * - `last-wins`: a later entry for a key takes the slot (kept at the original
 *   first-seen position); when `merge` is supplied the kept value is
 *   `merge(incumbent, challenger)`. Used by the runtime payload tier, where
 *   apps deliberately override base servers and carry a force-refresh flag.
 */
export type FoldPolicy<T> = {
  mode: "first-wins" | "last-wins";
  merge?: (incumbent: T, challenger: T) => T;
};

/**
 * The one precedence + dedup core shared by both MCP tiers. Folds keyed entries
 * in order into a stable, first-seen-ordered list, resolving same-key
 * collisions per {@link FoldPolicy} and tracking which source owns each key.
 * Slot position is fixed at first sight; only the value/source it holds can
 * change (on `last-wins`). This is the single place merge semantics live — the
 * static and runtime tiers differ only by the policy they pass.
 */
export function foldKeyed<T>(
  entries: Iterable<KeyedEntry<T>>,
  policy: FoldPolicy<T>,
): { values: T[]; sourceByKey: Map<string, string> } {
  const slotByKey = new Map<string, number>();
  const values: T[] = [];
  const sourceByKey = new Map<string, string>();

  for (const { key, value, source } of entries) {
    const slot = slotByKey.get(key);
    if (slot === undefined) {
      slotByKey.set(key, values.length);
      values.push(value);
      sourceByKey.set(key, source);
      continue;
    }
    if (policy.mode === "last-wins") {
      values[slot] = policy.merge ? policy.merge(values[slot], value) : value;
      sourceByKey.set(key, source);
    }
    // first-wins: incumbent holds the slot — the challenger is dropped.
  }

  return { values, sourceByKey };
}

/**
 * The single merge point for the static MCP tier. Contributions are folded in
 * the order given, so **earlier sources win**: a later contribution that
 * re-declares an already-seen `server_id` or `tool_id` is dropped (first-wins,
 * purely additive — nothing already resolved is ever displaced or mutated).
 *
 * Precedence and dedup live in {@link foldKeyed}; this just projects each
 * contribution into keyed entries. Adding a new IR-level MCP origin means
 * slotting one more {@link McpContribution} into the ordered list — not opening
 * a new merge site. Each contribution namespaces its own ids (e.g. capabilities
 * prefix `<capabilityId>__`), which keeps cross-source collisions structural
 * rather than accidental.
 */
export function composeMcp(contributions: McpContribution[]): ComposedMcp {
  const serverFold = foldKeyed<ResolvedMcpServerConfig>(
    contributions.flatMap((c) => c.servers.map((server) => ({ key: server.server_id, value: server, source: c.source }))),
    { mode: "first-wins" },
  );
  const toolFold = foldKeyed<ResolvedMcpToolRef>(
    contributions.flatMap((c) => c.toolRefs.map((toolRef) => ({ key: toolRef.tool_id, value: toolRef, source: c.source }))),
    { mode: "first-wins" },
  );

  return {
    servers: serverFold.values,
    toolRefs: toolFold.values,
    allowlist: toolFold.values.map((toolRef) => toolRef.tool_id),
    serverSourceById: serverFold.sourceByKey,
    toolSourceById: toolFold.sourceByKey,
  };
}
