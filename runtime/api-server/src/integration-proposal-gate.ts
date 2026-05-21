// Gate logic for "agent proposed N integration Connect cards; user has
// only connected M of them; should agent's next input be dispatched?".
//
// Existing flow: when the agent emits one or more
// holaboss_workspace_integrations_propose_connect tool calls in a turn,
// the chat UI renders a Connect card per proposal. The next user message
// (or any followup input) used to claim and dispatch immediately even if
// some Connect cards were still red — the agent would then run with a
// partial integration pool and either fail mid-turn or quietly half-do
// the work.
//
// Source of truth:
//   - Proposed slugs: scan output_events for the propose_connect tool
//     call's completion payload (`details.tool_id` + content blob
//     containing `proposed_integration.toolkit_slug`).
//   - Resolved state: any provider_id with status="active" in the
//     workspace-visible connection pool is considered satisfied. propose
//     -connect routes to the user-level toolkit pool (no per-app
//     binding), so a single active connection per slug is enough.

import type { OutputEventRecord, RuntimeStateStore } from "@holaboss/runtime-state-store";

const PROPOSE_CONNECT_TOOL_ID = "holaboss_workspace_integrations_propose_connect";

export interface PendingIntegrationProposal {
  toolkit_slug: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractProposedSlugsFromContentBlock(part: unknown): string[] {
  if (!isRecord(part)) return [];
  if (part.type !== "text" || typeof part.text !== "string") return [];
  if (!part.text.includes("proposed_integration")) return [];
  try {
    const parsed = JSON.parse(part.text) as unknown;
    if (!isRecord(parsed)) return [];
    const proposed = parsed.proposed_integration;
    if (!isRecord(proposed)) return [];
    const slug = typeof proposed.toolkit_slug === "string" ? proposed.toolkit_slug.trim().toLowerCase() : "";
    return slug ? [slug] : [];
  } catch {
    return [];
  }
}

function proposedSlugsFromToolCallEvent(event: OutputEventRecord): string[] {
  if (event.eventType !== "tool_call") return [];
  const payload = isRecord(event.payload) ? event.payload : {};
  if (payload.tool_name !== PROPOSE_CONNECT_TOOL_ID) return [];
  if (payload.phase !== "completed" || payload.error === true) return [];
  const slugs: string[] = [];
  const result = isRecord(payload.result) ? payload.result : null;
  if (result) {
    // Newer wrapper shape: result.details may hold the raw JsonObject
    const details = isRecord(result.details) ? result.details : null;
    const raw = details ? (isRecord(details.raw) ? details.raw : null) : null;
    const direct = isRecord((raw ?? result).proposed_integration)
      ? ((raw ?? result).proposed_integration as Record<string, unknown>)
      : null;
    if (direct) {
      const slug = typeof direct.toolkit_slug === "string" ? direct.toolkit_slug.trim().toLowerCase() : "";
      if (slug) slugs.push(slug);
    }
    if (Array.isArray(result.content)) {
      for (const part of result.content) {
        for (const slug of extractProposedSlugsFromContentBlock(part)) {
          slugs.push(slug);
        }
      }
    }
  }
  return slugs;
}

export interface PendingIntegrationProposalGateResult {
  /** All toolkit slugs the agent has proposed in this session, deduped. */
  proposedSlugs: string[];
  /** Subset of proposedSlugs that lack an active user-pool connection. */
  unresolvedSlugs: string[];
  /** Whether the gate should currently block agent dispatch. */
  blocked: boolean;
}

export function evaluatePendingIntegrationProposals(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sessionId: string;
}): PendingIntegrationProposalGateResult {
  const events = params.store.listOutputEvents({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    includeHistory: true,
  });
  const proposed = new Set<string>();
  for (const event of events) {
    for (const slug of proposedSlugsFromToolCallEvent(event)) {
      proposed.add(slug);
    }
  }
  if (proposed.size === 0) {
    return { proposedSlugs: [], unresolvedSlugs: [], blocked: false };
  }
  const proposedSlugs = [...proposed].sort();
  const unresolved: string[] = [];
  for (const slug of proposedSlugs) {
    const matches = params.store.listIntegrationConnections({ providerId: slug });
    const hasActive = matches.some((connection) => connection.status.trim().toLowerCase() === "active");
    if (!hasActive) {
      unresolved.push(slug);
    }
  }
  return {
    proposedSlugs,
    unresolvedSlugs: unresolved,
    blocked: unresolved.length > 0,
  };
}

// Called by the api-server when a connection becomes active (OAuth
// finalize / status update). Walks every QUEUED+deferred input across
// runtime dbs, re-evaluates the proposal gate for its session, and
// promotes any input that's no longer blocked back to available so the
// next worker tick can claim it. Returns the number of inputs woken.
export function resumePendingIntegrationInputs(store: RuntimeStateStore): number {
  const nowIso = new Date().toISOString();
  const deferred = store.listDeferredQueuedInputs();
  let woken = 0;
  for (const input of deferred) {
    const gate = evaluatePendingIntegrationProposals({
      store,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
    });
    if (gate.blocked) continue;
    store.updateInput({
      workspaceId: input.workspaceId,
      inputId: input.inputId,
      fields: { availableAt: nowIso },
    });
    woken += 1;
  }
  return woken;
}
