import assert from "node:assert/strict";
import test from "node:test";

import type { MemoryEntryRecord } from "@holaboss/runtime-state-store";

import { recalledMemoryContextFromEntries } from "./memory-recall.js";

function makeMemoryEntry(overrides: Partial<MemoryEntryRecord> & Pick<MemoryEntryRecord, "memoryId" | "scope" | "memoryType" | "path" | "title" | "summary">): MemoryEntryRecord {
  return {
    memoryId: overrides.memoryId,
    workspaceId: overrides.workspaceId === undefined ? "workspace-1" : overrides.workspaceId,
    sessionId: overrides.sessionId ?? "session-1",
    scope: overrides.scope,
    memoryType: overrides.memoryType,
    subjectKey: overrides.subjectKey ?? overrides.memoryId,
    path: overrides.path,
    title: overrides.title,
    summary: overrides.summary,
    tags: overrides.tags ?? [],
    verificationPolicy: overrides.verificationPolicy ?? "check_before_use",
    stalenessPolicy: overrides.stalenessPolicy ?? "workspace_sensitive",
    staleAfterSeconds: overrides.staleAfterSeconds ?? 14 * 24 * 60 * 60,
    sourceTurnInputId: overrides.sourceTurnInputId ?? null,
    sourceMessageId: overrides.sourceMessageId ?? null,
    sourceType: overrides.sourceType ?? "turn_result",
    observedAt: overrides.observedAt ?? overrides.updatedAt ?? "2026-04-01T00:00:00.000Z",
    lastVerifiedAt: overrides.lastVerifiedAt ?? overrides.updatedAt ?? "2026-04-01T00:00:00.000Z",
    confidence: overrides.confidence ?? 0.9,
    fingerprint: overrides.fingerprint ?? "f".repeat(64),
    status: overrides.status ?? "active",
    supersededAt: overrides.supersededAt ?? null,
    createdAt: overrides.createdAt ?? "2026-04-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-01T00:00:00.000Z",
  };
}

test("recalledMemoryContextFromEntries applies freshness governance and prefers stable or fresh entries", () => {
  const context = recalledMemoryContextFromEntries({
    query: "deploy after policy fix",
    nowIso: "2026-04-15T00:00:00.000Z",
    entries: [
      makeMemoryEntry({
        memoryId: "user-preference:response-style",
        workspaceId: null,
        scope: "user",
        memoryType: "preference",
        path: "preference/response-style.md",
        title: "User response style",
        summary: "User prefers concise responses.",
        verificationPolicy: "none",
        stalenessPolicy: "stable",
        staleAfterSeconds: null,
        updatedAt: "2026-04-01T00:00:00.000Z",
      }),
      makeMemoryEntry({
        memoryId: "workspace-blocker:deploy",
        scope: "workspace",
        memoryType: "blocker",
        path: "workspace/workspace-1/knowledge/blockers/deploy.md",
        title: "Deploy permission blocker",
        summary: "Deploy calls may be denied by workspace policy.",
        verificationPolicy: "check_before_use",
        stalenessPolicy: "workspace_sensitive",
        staleAfterSeconds: 30 * 24 * 60 * 60,
        updatedAt: "2026-04-10T00:00:00.000Z",
      }),
      makeMemoryEntry({
        memoryId: "workspace-reference:deploy-dashboard",
        scope: "workspace",
        memoryType: "reference",
        path: "workspace/workspace-1/knowledge/references/deploy-dashboard.md",
        title: "Deploy dashboard",
        summary: "Check the deploy dashboard before rolling out changes.",
        verificationPolicy: "must_reconfirm",
        stalenessPolicy: "time_sensitive",
        staleAfterSeconds: 24 * 60 * 60,
        updatedAt: "2026-04-01T00:00:00.000Z",
      }),
    ],
    maxEntries: 5,
  });

  assert.ok(context);
  assert.deepEqual(
    context.entries?.map((entry) => ({
      title: entry.title,
      freshness_state: entry.freshness_state,
      verification_policy: entry.verification_policy,
      staleness_policy: entry.staleness_policy,
    })),
    [
      {
        title: "User response style",
        freshness_state: "stable",
        verification_policy: "none",
        staleness_policy: "stable",
      },
      {
        title: "Deploy permission blocker",
        freshness_state: "fresh",
        verification_policy: "check_before_use",
        staleness_policy: "workspace_sensitive",
      },
    ]
  );
  assert.match(String(context.entries?.[0]?.freshness_note ?? ""), /stable unless explicitly changed/i);
  assert.match(String(context.entries?.[1]?.freshness_note ?? ""), /current workspace state/i);
  assert.equal(context.entries?.[0]?.source_type, "turn_result");
  assert.equal(context.entries?.[1]?.source_type, "turn_result");
  assert.ok(Array.isArray(context.selection_trace));
  assert.equal(context.selection_trace?.[0]?.memory_id, "user-preference:response-style");
  assert.match(String(context.selection_trace?.[0]?.reasons?.join(" ")), /user_scope_priority/);
});

test("recalledMemoryContextFromEntries prefers procedures and facts when the query asks for them", () => {
  const context = recalledMemoryContextFromEntries({
    query: "How do I release this workspace and what command should I run to verify it first?",
    nowIso: "2026-04-15T00:00:00.000Z",
    entries: [
      makeMemoryEntry({
        memoryId: "workspace-procedure:release",
        scope: "workspace",
        memoryType: "procedure",
        subjectKey: "procedure:release",
        path: "workspace/workspace-1/knowledge/procedures/release-procedure.md",
        title: "Release procedure",
        summary: "Release procedure for this workspace.",
        tags: ["procedure", "release"],
        verificationPolicy: "check_before_use",
        stalenessPolicy: "workspace_sensitive",
        staleAfterSeconds: 14 * 24 * 60 * 60,
        updatedAt: "2026-04-10T00:00:00.000Z",
      }),
      makeMemoryEntry({
        memoryId: "workspace-fact:verification-command",
        scope: "workspace",
        memoryType: "fact",
        subjectKey: "command:verification",
        path: "workspace/workspace-1/knowledge/facts/verification-command.md",
        title: "Verification command",
        summary: "Use `npm run test` for verification in this workspace.",
        tags: ["command", "verification", "test"],
        verificationPolicy: "check_before_use",
        stalenessPolicy: "workspace_sensitive",
        staleAfterSeconds: 30 * 24 * 60 * 60,
        updatedAt: "2026-04-11T00:00:00.000Z",
      }),
      makeMemoryEntry({
        memoryId: "workspace-blocker:deploy",
        scope: "workspace",
        memoryType: "blocker",
        subjectKey: "permission:deploy",
        path: "workspace/workspace-1/knowledge/blockers/deploy.md",
        title: "Deploy permission blocker",
        summary: "Deploy calls may be denied by workspace policy.",
        tags: ["deploy", "permission", "blocker"],
        verificationPolicy: "check_before_use",
        stalenessPolicy: "workspace_sensitive",
        staleAfterSeconds: 14 * 24 * 60 * 60,
        updatedAt: "2026-04-12T00:00:00.000Z",
      }),
    ],
    maxEntries: 3,
  });

  assert.ok(context);
  assert.deepEqual(
    context.entries?.map((entry) => entry.title),
    ["Release procedure", "Verification command", "Deploy permission blocker"]
  );
  assert.equal(context.selection_trace?.[0]?.memory_id, "workspace-procedure:release");
  assert.match(String(context.selection_trace?.[0]?.reasons?.join(" ")), /query_intent_boost/);
});

test("recalledMemoryContextFromEntries prefers durable business facts for schedule and approval queries", () => {
  const context = recalledMemoryContextFromEntries({
    query: "Who approves invoices over $5000 and when is the weekly sales review?",
    nowIso: "2026-04-15T00:00:00.000Z",
    entries: [
      makeMemoryEntry({
        memoryId: "workspace-fact:sales-review-cadence",
        scope: "workspace",
        memoryType: "fact",
        subjectKey: "fact:sales-review-cadence",
        path: "workspace/workspace-1/knowledge/facts/sales-review-cadence.md",
        title: "Sales review cadence",
        summary: "Weekly sales review is every Monday at 9am.",
        tags: ["cadence", "weekly", "sales", "review"],
        verificationPolicy: "check_before_use",
        stalenessPolicy: "workspace_sensitive",
        staleAfterSeconds: 30 * 24 * 60 * 60,
        updatedAt: "2026-04-12T00:00:00.000Z",
      }),
      makeMemoryEntry({
        memoryId: "workspace-fact:invoice-approval",
        scope: "workspace",
        memoryType: "fact",
        subjectKey: "fact:invoices-over-5000-approval-rule",
        path: "workspace/workspace-1/knowledge/facts/invoices-over-5000-approval-rule.md",
        title: "Finance approval rule",
        summary: "Invoices over $5000 require finance approval in this workspace.",
        tags: ["approval", "finance", "invoice", "invoices"],
        verificationPolicy: "check_before_use",
        stalenessPolicy: "workspace_sensitive",
        staleAfterSeconds: 30 * 24 * 60 * 60,
        updatedAt: "2026-04-13T00:00:00.000Z",
      }),
      makeMemoryEntry({
        memoryId: "workspace-procedure:follow-up",
        scope: "workspace",
        memoryType: "procedure",
        subjectKey: "procedure:follow-up",
        path: "workspace/workspace-1/knowledge/procedures/follow-up-procedure.md",
        title: "Follow-up procedure",
        summary: "Follow-up procedure for this workspace.",
        tags: ["procedure", "follow-up"],
        verificationPolicy: "check_before_use",
        stalenessPolicy: "workspace_sensitive",
        staleAfterSeconds: 14 * 24 * 60 * 60,
        updatedAt: "2026-04-11T00:00:00.000Z",
      }),
    ],
    maxEntries: 3,
  });

  assert.ok(context);
  assert.deepEqual(context.entries?.map((entry) => entry.title), [
    "Sales review cadence",
    "Finance approval rule",
    "Follow-up procedure",
  ]);
  assert.equal(context.entries?.[0]?.memory_type, "fact");
  assert.equal(context.entries?.[1]?.memory_type, "fact");
  assert.equal(context.selection_trace?.some((entry) => entry.memory_id === "workspace-fact:invoice-approval"), true);
  assert.equal(context.selection_trace?.some((entry) => entry.memory_id === "workspace-fact:sales-review-cadence"), true);
  assert.match(String(context.selection_trace?.[0]?.reasons?.join(" ")), /query_intent_boost/);
  assert.match(String(context.selection_trace?.[1]?.reasons?.join(" ")), /query_intent_boost/);
});

test("recalledMemoryContextFromEntries applies scope and type budget guardrails before filling results", () => {
  const context = recalledMemoryContextFromEntries({
    query: "How should I release this workspace and what should I check first?",
    nowIso: "2026-04-15T00:00:00.000Z",
    entries: [
      makeMemoryEntry({
        memoryId: "user-preference:format",
        workspaceId: null,
        scope: "user",
        memoryType: "preference",
        subjectKey: "response:format",
        path: "preference/response-format.md",
        title: "Response format",
        summary: "User prefers concise bullet responses.",
        tags: ["preference", "response"],
        verificationPolicy: "none",
        stalenessPolicy: "stable",
        staleAfterSeconds: null,
      }),
      makeMemoryEntry({
        memoryId: "user-preference:tone",
        workspaceId: null,
        scope: "user",
        memoryType: "preference",
        subjectKey: "response:tone",
        path: "preference/response-tone.md",
        title: "Response tone",
        summary: "User prefers direct and factual communication.",
        tags: ["preference", "tone"],
        verificationPolicy: "none",
        stalenessPolicy: "stable",
        staleAfterSeconds: null,
      }),
      makeMemoryEntry({
        memoryId: "user-preference:language",
        workspaceId: null,
        scope: "user",
        memoryType: "preference",
        subjectKey: "response:language",
        path: "preference/response-language.md",
        title: "Response language",
        summary: "User prefers English for technical work.",
        tags: ["preference", "language"],
        verificationPolicy: "none",
        stalenessPolicy: "stable",
        staleAfterSeconds: null,
      }),
      makeMemoryEntry({
        memoryId: "workspace-procedure:release",
        scope: "workspace",
        memoryType: "procedure",
        subjectKey: "procedure:release",
        path: "workspace/workspace-1/knowledge/procedures/release-procedure.md",
        title: "Release procedure",
        summary: "Run tests, then build, then deploy with approval.",
        tags: ["procedure", "release", "workflow"],
      }),
      makeMemoryEntry({
        memoryId: "workspace-fact:release-check",
        scope: "workspace",
        memoryType: "fact",
        subjectKey: "fact:release-check",
        path: "workspace/workspace-1/knowledge/facts/release-check.md",
        title: "Release check command",
        summary: "Run `npm run test` before release.",
        tags: ["command", "release", "test"],
      }),
    ],
    maxEntries: 3,
  });

  assert.ok(context);
  assert.equal(context.entries?.length, 3);
  const userCount = context.entries?.filter((entry) => entry.scope === "user").length ?? 0;
  assert.equal(userCount <= 2, true);
  assert.equal(context.entries?.some((entry) => entry.scope === "workspace"), true);
});

test("recalledMemoryContextFromEntries deduplicates semantically equivalent memories by subject", () => {
  const context = recalledMemoryContextFromEntries({
    query: "Who approves invoices and what is the process?",
    nowIso: "2026-04-15T00:00:00.000Z",
    entries: [
      makeMemoryEntry({
        memoryId: "workspace-fact:invoice-approval-v1",
        scope: "workspace",
        memoryType: "fact",
        subjectKey: "fact:invoice-approval-rule",
        path: "workspace/workspace-1/knowledge/facts/invoice-approval-rule-v1.md",
        title: "Finance approval rule (old)",
        summary: "Invoices over $5000 require finance approval.",
        tags: ["approval", "invoice"],
        updatedAt: "2026-04-10T00:00:00.000Z",
      }),
      makeMemoryEntry({
        memoryId: "workspace-fact:invoice-approval-v2",
        scope: "workspace",
        memoryType: "fact",
        subjectKey: "fact:invoice-approval-rule",
        path: "workspace/workspace-1/knowledge/facts/invoice-approval-rule-v2.md",
        title: "Finance approval rule",
        summary: "Invoices over $5000 require director finance approval.",
        tags: ["approval", "invoice"],
        updatedAt: "2026-04-14T00:00:00.000Z",
      }),
      makeMemoryEntry({
        memoryId: "workspace-procedure:invoice-follow-up",
        scope: "workspace",
        memoryType: "procedure",
        subjectKey: "procedure:invoice-follow-up",
        path: "workspace/workspace-1/knowledge/procedures/invoice-follow-up.md",
        title: "Invoice follow-up procedure",
        summary: "Escalate pending approvals after one business day.",
        tags: ["procedure", "invoice"],
        updatedAt: "2026-04-13T00:00:00.000Z",
      }),
    ],
    maxEntries: 3,
  });

  assert.ok(context);
  const approvalEntries =
    context.entries?.filter((entry) => entry.memory_type === "fact" && entry.title.toLowerCase().includes("approval")) ?? [];
  assert.equal(approvalEntries.length, 1);
  assert.equal(approvalEntries[0]?.title, "Finance approval rule");
  assert.equal(
    context.selection_trace?.some((entry) => entry.memory_id === "workspace-fact:invoice-approval-v2"),
    true
  );
});
