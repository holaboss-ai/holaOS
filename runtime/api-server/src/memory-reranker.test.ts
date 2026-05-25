import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  highSignalScore,
  rerankMemoryCandidates,
  rerankMemoryCandidatesWithLlm,
  type BaseMemoryRerankerEvidence,
  type MemoryRerankerCandidate,
} from "./memory-reranker.js";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function makeCandidate(
  overrides: Partial<BaseMemoryRerankerEvidence> & Pick<BaseMemoryRerankerEvidence, "id" | "category" | "title" | "summary">,
  extras?: Partial<MemoryRerankerCandidate<BaseMemoryRerankerEvidence>>,
): MemoryRerankerCandidate<BaseMemoryRerankerEvidence> {
  const evidence: BaseMemoryRerankerEvidence = {
    id: overrides.id,
    category: overrides.category,
    kind: overrides.kind ?? "leaf",
    title: overrides.title,
    summary: overrides.summary,
    freshness_state: overrides.freshness_state ?? "fresh",
    score: overrides.score ?? 3,
    reasons: overrides.reasons ?? ["lexical_match"],
    observed_at: overrides.observed_at ?? "2026-05-24T00:00:00.000Z",
    updated_at: overrides.updated_at ?? overrides.observed_at ?? "2026-05-24T00:00:00.000Z",
    provider: overrides.provider ?? null,
    entity_type: overrides.entity_type ?? null,
  };
  return {
    evidence,
    baseScore: extras?.baseScore ?? evidence.score,
    tokenKey: extras?.tokenKey ?? `${evidence.title} ${evidence.summary}`.toLowerCase().replace(/[^a-z0-9]+/g, "|"),
    relationKey: extras?.relationKey ?? `${evidence.category}:${evidence.id}`,
    signalScore: extras?.signalScore ?? highSignalScore(`${evidence.title}\n${evidence.summary}`),
  };
}

test("rerankMemoryCandidates balances briefing results across categories", () => {
  const candidates = [
    makeCandidate({
      id: "integration-1",
      category: "integration",
      title: "Customer escalation waiting on reply",
      summary: "Customer thread is waiting on a reply before Friday.",
      score: 4.9,
      provider: "gmail",
    }, {
      relationKey: "integration:gmail:acct-1",
    }),
    makeCandidate({
      id: "integration-2",
      category: "integration",
      title: "Finance approval pending",
      summary: "Finance approval for the budget is still blocked.",
      score: 4.7,
      provider: "gmail",
    }, {
      relationKey: "integration:gmail:acct-1",
    }),
    makeCandidate({
      id: "interaction-1",
      category: "interaction",
      title: "Release approver waiting on signoff",
      summary: "Maya is the release approver and the workflow is waiting on her signoff.",
      score: 4.15,
      entity_type: "workflow",
    }),
  ];

  const ranked = rerankMemoryCandidates({
    query: "Any important emails recently that I should be aware of?",
    intent: "briefing",
    candidates,
    policy: {
      freshness_bias: "high",
      include_neighbors: true,
      prefer_high_signal: true,
    },
  });

  assert.equal(ranked.length, 3);
  assert.ok(ranked.slice(0, 2).some((item) => item.category === "interaction"));
  assert.ok(ranked.some((item) => item.reasons.includes("intent_briefing")));
});

test("rerankMemoryCandidates prefers changed recent items for delta queries", () => {
  const ranked = rerankMemoryCandidates({
    query: "What changed since last time?",
    intent: "delta",
    candidates: [
      makeCandidate({
        id: "static-fact",
        category: "interaction",
        title: "Release owner",
        summary: "Maya owns the release process.",
        score: 4.4,
        updated_at: "2026-03-01T00:00:00.000Z",
      }),
      makeCandidate({
        id: "changed-item",
        category: "integration",
        title: "Release owner changed",
        summary: "Release owner changed to Alex after the escalation.",
        score: 3.8,
        provider: "github",
        updated_at: "2026-05-25T00:00:00.000Z",
      }),
    ],
    policy: {
      freshness_bias: "high",
      include_neighbors: true,
      prefer_high_signal: true,
    },
  });

  assert.equal(ranked[0]?.id, "changed-item");
  assert.ok(ranked[0]?.reasons.includes("intent_delta"));
  assert.ok(ranked[0]?.reasons.includes("novelty"));
});

test("rerankMemoryCandidates boosts blockers and dependencies for planning queries", () => {
  const ranked = rerankMemoryCandidates({
    query: "Plan the rollout and identify blockers",
    intent: "planning",
    candidates: [
      makeCandidate({
        id: "reference",
        category: "interaction",
        title: "Release notes location",
        summary: "Release notes live in the docs folder.",
        score: 4,
        kind: "summary",
      }),
      makeCandidate({
        id: "blocker",
        category: "interaction",
        title: "Deploy approval blocker",
        summary: "Deployment is blocked pending finance approval and policy review.",
        score: 3.2,
      }),
    ],
    policy: {
      freshness_bias: "medium",
      include_neighbors: true,
      prefer_high_signal: true,
    },
  });

  assert.equal(ranked[0]?.id, "blocker");
  assert.ok(ranked[0]?.reasons.includes("intent_planning"));
});

test("rerankMemoryCandidatesWithLlm uses model ranking and attaches assessment hints", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                ranked_ids: ["b", "a"],
                assessments: [
                  {
                    id: "b",
                    bucket: "blocker",
                    requires_live_verification: true,
                    reason: "This item is an active blocker.",
                  },
                ],
                recommended_next_source: "github",
                needs_live_verification: true,
                verification_reason: "The issue may have changed.",
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

  const result = await rerankMemoryCandidatesWithLlm({
    query: "What changed in the release blockers?",
    intent: "delta",
    candidates: [
      makeCandidate({
        id: "a",
        category: "interaction",
        title: "Release owner",
        summary: "Maya owns the release process.",
        score: 4.3,
      }),
      makeCandidate({
        id: "b",
        category: "integration",
        title: "Release blocker changed",
        summary: "The release blocker moved back to review after a new incident.",
        score: 3.7,
        provider: "github",
      }),
    ],
    policy: {
      freshness_bias: "high",
      include_neighbors: true,
      prefer_high_signal: true,
    },
    modelClient: {
      baseUrl: "https://runtime.example/api/v1/model-proxy/openai/v1",
      apiKey: "token-1",
      modelId: "gpt-5.4-mini",
      apiStyle: "openai_compatible",
    },
  });

  assert.equal(result.usedLlm, true);
  assert.equal(result.rankedEvidence[0]?.id, "b");
  assert.equal(result.rankedEvidence[0]?.llm_bucket, "blocker");
  assert.equal(result.rankedEvidence[0]?.needs_live_verification, true);
  assert.equal(result.recommendedNextSource, "github");
  assert.equal(result.needsLiveVerification, true);
});
