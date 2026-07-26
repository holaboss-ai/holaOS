// Coverage for the integration-proposal gate helper: scans the agent's
// propose_connect tool-call events, returns the slugs still missing an
// active user-pool connection, and exposes a sweep helper that resumes
// any input parked by the gate once OAuth completes.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";
import { seedWorkspaceRecord } from "./__test-helpers__/seed-workspace.js";

import {
  DECLINE_PROPOSALS_EVENT_TYPE,
  evaluatePendingIntegrationProposals,
  resumePendingIntegrationInputs,
} from "./integration-proposal-gate.js";

function makeStore(prefix: string): RuntimeStateStore {
  const root = mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
}

function seedSession(store: RuntimeStateStore) {
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-1",
    kind: "main",
    title: "Main",
    createdBy: "system",
  });
  return workspace;
}

function appendProposeConnectEvent(store: RuntimeStateStore, params: {
  workspaceId: string;
  sessionId: string;
  inputId: string;
  sequence: number;
  toolkitSlug: string;
}) {
  store.appendOutputEvent({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    inputId: params.inputId,
    sequence: params.sequence,
    eventType: "tool_call",
    payload: {
      tool_name: "holaboss_workspace_integrations_propose_connect",
      phase: "completed",
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              proposed_integration: { toolkit_slug: params.toolkitSlug },
            }),
          },
        ],
      },
    },
  });
}

// External harnesses (Claude Code, Codex, …) reach propose_connect over MCP:
// the tool name is namespaced `mcp__<server>__<tool>` and the result is
// DOUBLE-wrapped — the MCP content array's text is a JSON string of the
// runtime tool's own `{ content: [{ text: "<proposed_integration json>" }] }`
// envelope. This mirrors the exact on-disk payload observed from Claude Code.
function appendMcpProposeConnectEvent(store: RuntimeStateStore, params: {
  workspaceId: string;
  sessionId: string;
  inputId: string;
  sequence: number;
  toolkitSlug: string;
}) {
  const innerToolJson = JSON.stringify({
    proposed_integration: { toolkit_slug: params.toolkitSlug },
  });
  const mcpEnvelopeJson = JSON.stringify({
    content: [{ type: "text", text: innerToolJson }],
    details: { tool_id: "holaboss_workspace_integrations_propose_connect" },
  });
  store.appendOutputEvent({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    inputId: params.inputId,
    sequence: params.sequence,
    eventType: "tool_call",
    payload: {
      tool_name:
        "mcp__holaboss_runtime_tools__holaboss_workspace_integrations_propose_connect",
      phase: "completed",
      result: [{ type: "text", text: mcpEnvelopeJson }],
    },
  });
}

function appendDeclineEvent(store: RuntimeStateStore, params: {
  workspaceId: string;
  sessionId: string;
  inputId: string;
  sequence: number;
  slugs: string[];
}) {
  store.appendOutputEvent({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    inputId: params.inputId,
    sequence: params.sequence,
    eventType: DECLINE_PROPOSALS_EVENT_TYPE,
    payload: { declined_slugs: params.slugs },
  });
}

test("a declined slug no longer gates the session", async () => {
  const store = makeStore("hb-gate-declined");
  const workspace = seedSession(store);
  appendProposeConnectEvent(store, {
    workspaceId: workspace.id,
    sessionId: "session-1",
    inputId: "input-1",
    sequence: 1,
    toolkitSlug: "gmail",
  });
  appendProposeConnectEvent(store, {
    workspaceId: workspace.id,
    sessionId: "session-1",
    inputId: "input-1",
    sequence: 2,
    toolkitSlug: "instagram",
  });
  // User skips instagram — it should drop out of the gate entirely, leaving
  // only gmail proposed (and still blocking, since gmail isn't connected).
  appendDeclineEvent(store, {
    workspaceId: workspace.id,
    sessionId: "session-1",
    inputId: "input-1",
    sequence: 3,
    slugs: ["instagram"],
  });
  const gate = await evaluatePendingIntegrationProposals({
    store,
    workspaceId: workspace.id,
    sessionId: "session-1",
  });
  assert.deepEqual(gate.proposedSlugs, ["gmail"]);
  assert.deepEqual(gate.unresolvedSlugs, ["gmail"]);
  assert.equal(gate.blocked, true);
  store.close();
});

test("declining every proposed slug unblocks the gate", async () => {
  const store = makeStore("hb-gate-declined-all");
  const workspace = seedSession(store);
  appendProposeConnectEvent(store, {
    workspaceId: workspace.id,
    sessionId: "session-1",
    inputId: "input-1",
    sequence: 1,
    toolkitSlug: "instagram",
  });
  appendDeclineEvent(store, {
    workspaceId: workspace.id,
    sessionId: "session-1",
    inputId: "input-1",
    sequence: 2,
    slugs: ["instagram"],
  });
  const gate = await evaluatePendingIntegrationProposals({
    store,
    workspaceId: workspace.id,
    sessionId: "session-1",
  });
  assert.deepEqual(gate, {
    proposedSlugs: [],
    unresolvedSlugs: [],
    blocked: false,
  });
  store.close();
});

test("resumePendingIntegrationInputs wakes a deferred input after the user skips its proposals", async () => {
  const store = makeStore("hb-gate-resume-skip");
  const workspace = seedSession(store);
  appendProposeConnectEvent(store, {
    workspaceId: workspace.id,
    sessionId: "session-1",
    inputId: "ignored",
    sequence: 1,
    toolkitSlug: "instagram",
  });
  const deferred = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-1",
    payload: { text: "follow-up", model: "openai/gpt-5" },
  });
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  store.updateInput({
    workspaceId: workspace.id,
    inputId: deferred.inputId,
    fields: { availableAt: future },
  });

  // Still blocked → resume is a no-op.
  assert.equal(await resumePendingIntegrationInputs(store), 0);

  // User skips instagram → the deferred input should be promoted.
  appendDeclineEvent(store, {
    workspaceId: workspace.id,
    sessionId: "session-1",
    inputId: "ignored",
    sequence: 2,
    slugs: ["instagram"],
  });
  assert.equal(await resumePendingIntegrationInputs(store), 1);
  const afterSkip = store.getInput({
    workspaceId: workspace.id,
    inputId: deferred.inputId,
  });
  assert.notEqual(afterSkip?.availableAt, future);
  store.close();
});

test("gate matches an MCP-namespaced propose_connect with a double-wrapped content-array result", async () => {
  const store = makeStore("hb-gate-mcp");
  const workspace = seedSession(store);
  appendMcpProposeConnectEvent(store, {
    workspaceId: workspace.id,
    sessionId: "session-1",
    inputId: "input-1",
    sequence: 1,
    toolkitSlug: "gmail",
  });
  const gate = await evaluatePendingIntegrationProposals({
    store,
    workspaceId: workspace.id,
    sessionId: "session-1",
  });
  assert.deepEqual(gate.proposedSlugs, ["gmail"]);
  assert.deepEqual(gate.unresolvedSlugs, ["gmail"]);
  assert.equal(gate.blocked, true);
  store.close();
});

test("gate reports no proposals when the session never called propose_connect", async () => {
  const store = makeStore("hb-gate-no-proposal");
  const workspace = seedSession(store);
  const gate = await evaluatePendingIntegrationProposals({
    store,
    workspaceId: workspace.id,
    sessionId: "session-1",
  });
  assert.deepEqual(gate, {
    proposedSlugs: [],
    unresolvedSlugs: [],
    blocked: false,
  });
  store.close();
});

test("gate flags every proposed slug that lacks an active user-pool connection", async () => {
  const store = makeStore("hb-gate-unresolved");
  const workspace = seedSession(store);
  appendProposeConnectEvent(store, {
    workspaceId: workspace.id,
    sessionId: "session-1",
    inputId: "input-1",
    sequence: 1,
    toolkitSlug: "gmail",
  });
  appendProposeConnectEvent(store, {
    workspaceId: workspace.id,
    sessionId: "session-1",
    inputId: "input-1",
    sequence: 2,
    toolkitSlug: "twitter",
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-gmail",
    providerId: "gmail",
    ownerUserId: "user-1",
    accountLabel: "user@example.com",
    authMode: "managed",
    grantedScopes: [],
    status: "active",
    secretRef: "tok",
  });

  const gate = await evaluatePendingIntegrationProposals({
    store,
    workspaceId: workspace.id,
    sessionId: "session-1",
  });
  assert.deepEqual(gate.proposedSlugs, ["gmail", "twitter"]);
  assert.deepEqual(gate.unresolvedSlugs, ["twitter"]);
  assert.equal(gate.blocked, true);
  store.close();
});

test("gate reports unblocked when every proposed slug has an active connection", async () => {
  const store = makeStore("hb-gate-resolved");
  const workspace = seedSession(store);
  appendProposeConnectEvent(store, {
    workspaceId: workspace.id,
    sessionId: "session-1",
    inputId: "input-1",
    sequence: 1,
    toolkitSlug: "gmail",
  });
  appendProposeConnectEvent(store, {
    workspaceId: workspace.id,
    sessionId: "session-1",
    inputId: "input-1",
    sequence: 2,
    toolkitSlug: "twitter",
  });
  for (const provider of ["gmail", "twitter"]) {
    store.upsertIntegrationConnection({
      connectionId: `conn-${provider}`,
      providerId: provider,
      ownerUserId: "user-1",
      accountLabel: `${provider}@example.com`,
      authMode: "managed",
      grantedScopes: [],
      status: "active",
      secretRef: "tok",
    });
  }

  const gate = await evaluatePendingIntegrationProposals({
    store,
    workspaceId: workspace.id,
    sessionId: "session-1",
  });
  assert.deepEqual(gate.unresolvedSlugs, []);
  assert.equal(gate.blocked, false);
  store.close();
});

test("inactive connections don't satisfy the gate", async () => {
  const store = makeStore("hb-gate-inactive");
  const workspace = seedSession(store);
  appendProposeConnectEvent(store, {
    workspaceId: workspace.id,
    sessionId: "session-1",
    inputId: "input-1",
    sequence: 1,
    toolkitSlug: "gmail",
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-gmail",
    providerId: "gmail",
    ownerUserId: "user-1",
    accountLabel: "user@example.com",
    authMode: "managed",
    grantedScopes: [],
    status: "expired",
    secretRef: "tok",
  });
  const gate = await evaluatePendingIntegrationProposals({
    store,
    workspaceId: workspace.id,
    sessionId: "session-1",
  });
  assert.deepEqual(gate.unresolvedSlugs, ["gmail"]);
  assert.equal(gate.blocked, true);
  store.close();
});

test("resumePendingIntegrationInputs wakes deferred inputs after their proposals resolve", async () => {
  const store = makeStore("hb-gate-resume");
  const workspace = seedSession(store);
  appendProposeConnectEvent(store, {
    workspaceId: workspace.id,
    sessionId: "session-1",
    inputId: "ignored",
    sequence: 1,
    toolkitSlug: "gmail",
  });

  // Park an input in the future (gate would have done this).
  const deferred = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-1",
    payload: { text: "follow-up", model: "openai/gpt-5" },
  });
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  store.updateInput({
    workspaceId: workspace.id,
    inputId: deferred.inputId,
    fields: { availableAt: future },
  });

  // Still blocked → resume is a no-op.
  assert.equal(await resumePendingIntegrationInputs(store), 0);
  const afterStillBlocked = store.getInput({
    workspaceId: workspace.id,
    inputId: deferred.inputId,
  });
  assert.equal(afterStillBlocked?.availableAt, future);

  // User finishes OAuth → connection active → sweep should promote.
  store.upsertIntegrationConnection({
    connectionId: "conn-gmail",
    providerId: "gmail",
    ownerUserId: "user-1",
    accountLabel: "user@example.com",
    authMode: "managed",
    grantedScopes: [],
    status: "active",
    secretRef: "tok",
  });
  const woken = await resumePendingIntegrationInputs(store);
  assert.equal(woken, 1);
  const afterResolved = store.getInput({
    workspaceId: workspace.id,
    inputId: deferred.inputId,
  });
  assert.notEqual(afterResolved?.availableAt, future);
  store.close();
});
