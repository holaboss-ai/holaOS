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

import { listConnectionsMerged } from "./integration-connections-merged.js";

const PROPOSE_CONNECT_TOOL_ID = "holaboss_workspace_integrations_propose_connect";

// Marker event the user's "Skip" action appends to stop the gate blocking a
// session on integrations they've chosen not to connect. Any slug named here is
// dropped from the proposed set, so the deferred input resumes and future
// messages in the session are no longer re-deferred.
export const DECLINE_PROPOSALS_EVENT_TYPE = "integration_proposals_declined";

export interface PendingIntegrationProposal {
  toolkit_slug: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The bare runtime-tool id, with MCP namespacing stripped. The in-process pi
 * harness emits the bare tool id, but external harnesses (Claude Code, Codex,
 * …) reach the same tool over MCP, which names it `mcp__<server>__<tool>`.
 * Normalize so the gate matches propose_connect regardless of harness.
 */
function bareRuntimeToolName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed.startsWith("mcp__")) return trimmed;
  const afterPrefix = trimmed.slice("mcp__".length);
  const separator = afterPrefix.indexOf("__");
  return separator === -1 ? afterPrefix : afterPrefix.slice(separator + 2);
}

/**
 * Collect every proposed toolkit slug anywhere in a tool-call result.
 *
 * The propose_connect payload lands at varying depths: the in-process path
 * returns the tool's object directly; an MCP harness wraps it as a content
 * array whose `text` is the JSON string, and the runtime tool's own
 * `{ content: [...] }` envelope means that parsed JSON holds ANOTHER
 * stringified `{ content: [...] }` before the real object. Walk the structure
 * (descending arrays/objects and JSON.parse-ing any string that still contains
 * "proposed_integration") and push a slug for each `proposed_integration`
 * object found. Bounded depth guards against pathological nesting.
 */
function collectProposedSlugsDeep(
  value: unknown,
  out: string[],
  depth = 0,
): void {
  if (depth > 8 || value == null) return;
  if (typeof value === "string") {
    if (!value.includes("proposed_integration")) return;
    try {
      collectProposedSlugsDeep(JSON.parse(value), out, depth + 1);
    } catch {
      // not JSON — nothing to descend into
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectProposedSlugsDeep(item, out, depth + 1);
    return;
  }
  if (isRecord(value)) {
    const proposed = value.proposed_integration;
    if (isRecord(proposed)) {
      const slug =
        typeof proposed.toolkit_slug === "string"
          ? proposed.toolkit_slug.trim().toLowerCase()
          : "";
      if (slug) out.push(slug);
    }
    for (const nested of Object.values(value)) {
      collectProposedSlugsDeep(nested, out, depth + 1);
    }
  }
}

function proposedSlugsFromToolCallEvent(event: OutputEventRecord): string[] {
  if (event.eventType !== "tool_call") return [];
  const payload = isRecord(event.payload) ? event.payload : {};
  const toolName = bareRuntimeToolName(
    typeof payload.tool_name === "string" ? payload.tool_name : "",
  );
  if (toolName !== PROPOSE_CONNECT_TOOL_ID) return [];
  if (payload.phase !== "completed" || payload.error === true) return [];
  const slugs: string[] = [];
  collectProposedSlugsDeep(payload.result, slugs);
  return slugs;
}

function declinedSlugsFromEvent(event: OutputEventRecord): string[] {
  if (event.eventType !== DECLINE_PROPOSALS_EVENT_TYPE) return [];
  const payload = isRecord(event.payload) ? event.payload : {};
  const raw = payload.declined_slugs;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (slug): slug is string =>
        typeof slug === "string" && slug.trim().length > 0,
    )
    .map((slug) => slug.trim().toLowerCase());
}

export interface PendingIntegrationProposalGateResult {
  /** All toolkit slugs the agent has proposed in this session, deduped. */
  proposedSlugs: string[];
  /** Subset of proposedSlugs that lack an active user-pool connection. */
  unresolvedSlugs: string[];
  /** Whether the gate should currently block agent dispatch. */
  blocked: boolean;
}

export async function evaluatePendingIntegrationProposals(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sessionId: string;
}): Promise<PendingIntegrationProposalGateResult> {
  const events = params.store.listOutputEvents({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    includeHistory: true,
  });
  const proposed = new Set<string>();
  const declined = new Set<string>();
  for (const event of events) {
    for (const slug of proposedSlugsFromToolCallEvent(event)) {
      proposed.add(slug);
    }
    for (const slug of declinedSlugsFromEvent(event)) {
      declined.add(slug);
    }
  }
  // A slug the user skipped no longer gates the session.
  for (const slug of declined) {
    proposed.delete(slug);
  }
  if (proposed.size === 0) {
    return { proposedSlugs: [], unresolvedSlugs: [], blocked: false };
  }
  const proposedSlugs = [...proposed].sort();
  const unresolved: string[] = [];
  for (const slug of proposedSlugs) {
    const matches = await listConnectionsMerged(params.store, {
      providerId: slug,
    });
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
export async function resumePendingIntegrationInputs(
  store: RuntimeStateStore,
): Promise<number> {
  const nowIso = new Date().toISOString();
  const deferred = store.listDeferredQueuedInputs();
  let woken = 0;
  for (const input of deferred) {
    const gate = await evaluatePendingIntegrationProposals({
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
