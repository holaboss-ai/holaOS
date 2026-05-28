import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { buildMemoryHybridRetrievalResult } from "./memory-hybrid-retrieval.js";
import {
  inferMemoryRetrievalIntent,
  normalizeMemoryRetrievalIntent,
} from "./memory-retrieval-intent.js";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

test("inferMemoryRetrievalIntent classifies common reasoning intents", () => {
  assert.equal(inferMemoryRetrievalIntent("Any important emails recently that I should be aware of?"), "briefing");
  assert.equal(inferMemoryRetrievalIntent("What changed in the release plan since last week?"), "delta");
  assert.equal(inferMemoryRetrievalIntent("How do I deploy this workspace?"), "procedure_lookup");
  assert.equal(inferMemoryRetrievalIntent("Who owns release PR 123?"), "fact_lookup");
  assert.equal(inferMemoryRetrievalIntent("Plan the rollout and identify blockers."), "planning");
  assert.equal(normalizeMemoryRetrievalIntent("BRIEFING"), "briefing");
  assert.equal(normalizeMemoryRetrievalIntent("unknown_intent"), null);
});

test("buildMemoryHybridRetrievalResult produces a reasoning-first briefing pack", async () => {
  const result = await buildMemoryHybridRetrievalResult({
    query: "Any important emails recently that I should be aware of?",
    categories: ["interaction", "integration"],
    interactionHits: [
      {
        node_kind: "leaf",
        node_id: "interaction-leaf-1",
        tree_id: "interaction:workflow:deploy",
        entity_id: "interaction:workflow:deploy",
        entity_name: "Deploy workflow",
        entity_type: "workflow",
        path: "interaction/entities/deploy/leaves/1.md",
        title: "Deploy owner",
        summary: "Maya owns deploy approvals for the release workflow.",
        excerpt: null,
        level: 2,
        child_count: 0,
        observed_at: "2026-05-22T00:00:00.000Z",
        updated_at: "2026-05-22T00:00:00.000Z",
        score: 2.2,
        reasons: ["lexical_match"],
      },
    ],
    integrationHits: [
      {
        category: "integration",
        node_kind: "leaf",
        node_id: "integration-leaf-1",
        tree_id: "integration:gmail:acct-1",
        provider: "gmail",
        owner_user_id: "user-1",
        account_key: "ops@example.com",
        account_label: "Ops Gmail",
        path: "integration/accounts/ops/leaves/1.md",
        title: "Customer waiting on reply",
        summary: "Customer escalation thread is waiting on a reply before Friday.",
        excerpt: null,
        level: 2,
        child_count: 0,
        observed_at: "2026-05-24T00:00:00.000Z",
        updated_at: "2026-05-24T00:00:00.000Z",
        score: 3.7,
        reasons: ["lexical_match", "embedding_similarity"],
      },
      {
        category: "integration",
        node_kind: "leaf",
        node_id: "integration-leaf-2",
        tree_id: "integration:gmail:acct-1",
        provider: "gmail",
        owner_user_id: "user-1",
        account_key: "ops@example.com",
        account_label: "Ops Gmail",
        path: "integration/accounts/ops/leaves/2.md",
        title: "Finance approval pending",
        summary: "Approval email for the release budget is still blocked on finance review.",
        excerpt: null,
        level: 2,
        child_count: 0,
        observed_at: "2026-05-24T00:00:00.000Z",
        updated_at: "2026-05-24T00:00:00.000Z",
        score: 3.5,
        reasons: ["lexical_match"],
      },
    ],
    retrievalPolicy: {
      max_evidence: 4,
      include_neighbors: true,
      freshness_bias: "high",
      prefer_high_signal: true,
    },
  });

  assert.equal(result.intent, "briefing");
  assert.deepEqual(result.categories, ["interaction", "integration"]);
  assert.equal(result.retrieval_pack.recommended_next_source, "gmail");
  assert.equal(result.retrieval_pack.recommended_next_step?.type, "verify_live_state");
  assert.ok(result.retrieval_pack.recent_high_signal_items.some((item) => item.title === "Customer waiting on reply"));
  assert.ok(result.retrieval_pack.known_facts.some((item) => item.category === "interaction"));
  assert.ok(result.gaps.length >= 1);
  assert.equal(result.coverage.used_lexical, true);
  assert.equal(result.coverage.used_vector, true);
  assert.equal(result.coverage.used_neighbors, true);
  assert.ok(result.evidence[0].score >= result.evidence[1].score);
});

test("buildMemoryHybridRetrievalResult honors allowed tree filters", async () => {
  const result = await buildMemoryHybridRetrievalResult({
    query: "What important email context is new?",
    requestedIntent: "briefing",
    categories: ["interaction", "integration"],
    interactionHits: [
      {
        node_kind: "leaf",
        node_id: "interaction-leaf-1",
        tree_id: "interaction:project:atlas",
        entity_id: "interaction:project:atlas",
        entity_name: "Atlas",
        entity_type: "project",
        path: "interaction/entities/atlas/leaves/1.md",
        title: "Atlas blocker",
        summary: "Atlas deploy is blocked pending approval.",
        excerpt: null,
        level: 2,
        child_count: 0,
        observed_at: "2026-05-20T00:00:00.000Z",
        updated_at: "2026-05-20T00:00:00.000Z",
        score: 4.2,
        reasons: ["lexical_match"],
      },
    ],
    integrationHits: [
      {
        category: "integration",
        node_kind: "leaf",
        node_id: "integration-leaf-1",
        tree_id: "integration:gmail:acct-2",
        provider: "gmail",
        owner_user_id: "user-1",
        account_key: "alerts@example.com",
        account_label: "Alerts Gmail",
        path: "integration/accounts/alerts/leaves/1.md",
        title: "Escalation notice",
        summary: "Customer escalation email needs triage.",
        excerpt: null,
        level: 2,
        child_count: 0,
        observed_at: "2026-05-25T00:00:00.000Z",
        updated_at: "2026-05-25T00:00:00.000Z",
        score: 4.7,
        reasons: ["lexical_match"],
      },
    ],
    allowedTreeIds: ["integration:gmail:acct-2"],
  });

  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0]?.tree_id, "integration:gmail:acct-2");
  assert.equal(result.evidence[0]?.category, "integration");
  assert.equal(result.retrieval_pack.recommended_next_source, "gmail");
});

test("buildMemoryHybridRetrievalResult uses phase 2 reranking for delta queries", async () => {
  const result = await buildMemoryHybridRetrievalResult({
    query: "What changed since last time?",
    categories: ["interaction", "integration"],
    interactionHits: [
      {
        node_kind: "leaf",
        node_id: "interaction-static",
        tree_id: "interaction:project:atlas",
        entity_id: "interaction:project:atlas",
        entity_name: "Atlas",
        entity_type: "project",
        path: "interaction/entities/atlas/leaves/static.md",
        title: "Release owner",
        summary: "Maya owns the release process.",
        excerpt: null,
        level: 2,
        child_count: 0,
        observed_at: "2026-03-01T00:00:00.000Z",
        updated_at: "2026-03-01T00:00:00.000Z",
        score: 4.5,
        reasons: ["lexical_match"],
      },
    ],
    integrationHits: [
      {
        category: "integration",
        node_kind: "leaf",
        node_id: "integration-changed",
        tree_id: "integration:github:acct-1",
        provider: "github",
        owner_user_id: "user-1",
        account_key: "ops",
        account_label: "Ops GitHub",
        path: "integration/accounts/ops/leaves/changed.md",
        title: "Release owner changed",
        summary: "Release owner changed to Alex after the escalation.",
        excerpt: null,
        level: 2,
        child_count: 0,
        observed_at: "2026-05-25T00:00:00.000Z",
        updated_at: "2026-05-25T00:00:00.000Z",
        score: 3.8,
        reasons: ["lexical_match"],
      },
    ],
    retrievalPolicy: {
      max_evidence: 4,
      include_neighbors: true,
      freshness_bias: "high",
      prefer_high_signal: true,
    },
  });

  assert.equal(result.intent, "delta");
  assert.equal(result.evidence[0]?.id, "integration-changed");
  assert.ok(result.evidence[0]?.reasons.includes("intent_delta"));
  assert.ok(result.evidence[0]?.reasons.includes("novelty"));
});

test("buildMemoryHybridRetrievalResult applies LLM reranking over the shortlist", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                ranked_ids: ["integration-priority", "interaction-fact"],
                assessments: [
                  {
                    id: "integration-priority",
                    bucket: "high_signal",
                    requires_live_verification: true,
                    reason: "This is the most time-sensitive recent item.",
                  },
                  {
                    id: "interaction-fact",
                    bucket: "known_fact",
                    requires_live_verification: false,
                    reason: "This is durable supporting context.",
                  },
                ],
                recommended_next_source: "gmail",
                needs_live_verification: true,
                verification_reason: "Recent inbox state may have changed.",
              }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )) as typeof fetch;

  const result = await buildMemoryHybridRetrievalResult({
    query: "Any important emails recently that I should be aware of?",
    categories: ["interaction", "integration"],
    interactionHits: [
      {
        node_kind: "leaf",
        node_id: "interaction-fact",
        tree_id: "interaction:workflow:deploy",
        entity_id: "interaction:workflow:deploy",
        entity_name: "Deploy workflow",
        entity_type: "workflow",
        path: "interaction/entities/deploy/leaves/1.md",
        title: "Release approver",
        summary: "Maya is the durable release approver for deploys.",
        excerpt: null,
        level: 2,
        child_count: 0,
        observed_at: "2026-05-22T00:00:00.000Z",
        updated_at: "2026-05-22T00:00:00.000Z",
        score: 4.7,
        reasons: ["lexical_match"],
      },
    ],
    integrationHits: [
      {
        category: "integration",
        node_kind: "leaf",
        node_id: "integration-priority",
        tree_id: "integration:gmail:acct-1",
        provider: "gmail",
        owner_user_id: "user-1",
        account_key: "ops@example.com",
        account_label: "Ops Gmail",
        path: "integration/accounts/ops/leaves/1.md",
        title: "Customer escalation waiting on reply",
        summary: "Customer escalation thread is waiting on a reply before Friday.",
        excerpt: null,
        level: 2,
        child_count: 0,
        observed_at: "2026-05-24T00:00:00.000Z",
        updated_at: "2026-05-24T00:00:00.000Z",
        score: 4.2,
        reasons: ["lexical_match"],
      },
    ],
    retrievalPolicy: {
      max_evidence: 4,
      include_neighbors: true,
      freshness_bias: "high",
      prefer_high_signal: true,
    },
    modelClient: {
      baseUrl: "https://runtime.example/api/v1/model-proxy/openai/v1",
      apiKey: "token-1",
      modelId: "gpt-5.4-mini",
      apiStyle: "openai_compatible",
    },
  });

  assert.equal(result.evidence[0]?.id, "integration-priority");
  assert.equal(result.evidence[0]?.llm_bucket, "high_signal");
  assert.equal(result.evidence[0]?.needs_live_verification, true);
  assert.equal(result.retrieval_pack.recommended_next_source, "gmail");
  assert.ok(result.evidence[0]?.reasons.includes("llm_rerank"));
});
