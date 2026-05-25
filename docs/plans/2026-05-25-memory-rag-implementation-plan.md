---
title: Memory RAG implementation plan
date: 2026-05-25
status: draft
related:
  - 2026-05-20-memory-redesign-prd.md
  - 2026-05-24-memory-architecture-redesign-implementation-plan.md
  - ../memory-arch/gmail.md
  - ../memory-arch/github.md
  - ../memory-arch/notion.md
---

# Memory RAG implementation plan

## Goal

Make the existing durable memory system behave like a true retrieval-augmented generation stack rather than a collection of searchable notes.

The target outcome is:

- memory retrieval is hybrid by default, not purely lexical or purely semantic
- the runtime retrieves evidence-bearing chunks, not only top-level summaries
- retrieval output is structured for reasoning, not dumped as flat hits
- the primary retrieval tool contract is optimized for agent reasoning rather than tree browsing
- the model can use memory to narrow follow-up verification and tool calls
- integration memory can answer high-signal briefing questions even when live MCP coverage is partial

This plan is intentionally incremental. It builds on the current memory substrate instead of replacing it.

## Current state

The repo already has the core ingredients for a RAG system:

- durable memory entries with freshness and governance in `runtime/api-server/src/memory-governance.ts`
- lexical recall ranking in `runtime/api-server/src/memory-recall-index.ts`
- entry-based recalled memory projection in `runtime/api-server/src/memory-recall.ts`
- two-stage recall planning with vector support in `runtime/api-server/src/memory-recall-manifest.ts`
- interaction and integration retrieval in:
  - `runtime/api-server/src/interaction-memory.ts`
  - `runtime/api-server/src/integration-memory.ts`
  - `runtime/api-server/src/workspace-memory.ts`
- agent-facing retrieval via `memory_retrieve` in `runtime/api-server/src/runtime-agent-tools.ts`

The main gaps are product and orchestration gaps, not raw storage gaps:

- retrieval does not consistently combine lexical, vector, and graph/entity expansion into one first-pass fetch and reranking pipeline
- results are returned as hits, not as a structured retrieval pack optimized for reasoning
- "what matters?" and "what should I know?" queries are not ranked by urgency, novelty, or actionability
- integration memory holds useful leaves, but not enough synthesized high-signal "shadow summaries"
- the prompt/runtime contract is only beginning to treat recalled memory as a planning substrate

## Desired end state

The durable memory system should behave like this:

`query -> intent classification -> hybrid first-pass fetch -> LLM rerank -> structured retrieval pack -> grounded reasoning -> targeted verification -> answer or action`

For the model, the important shift is:

- memory is not only a fact lookup tool
- memory is the first-pass planning substrate
- retrieval should narrow downstream verification instead of causing broad exploration

## Non-goals

This plan does not try to:

- replace the current durable memory ownership model
- redesign the semantic-node migration described in `2026-05-24-memory-architecture-redesign-implementation-plan.md`
- expand provider fetch coverage beyond current Gmail, GitHub, and Notion memory paths
- solve full long-context document RAG for arbitrary files in this phase
- make browser or MCP routing decisions inside the retrieval engine itself

## Design principles

### 1. Keep durable leaves as the evidence layer

Do not replace durable memory entries or provider-backed leaves with synthetic-only summaries.

The system should retrieve:

- leaf evidence where available
- summary nodes when they help with fast routing
- both when a user asks for a briefing or a plan

### 2. Hybrid retrieval should be the default

Every retrieval pass should be able to combine:

- lexical matches
- vector similarity
- metadata matches
- graph or entity-neighbor expansion

The exact mix can vary by query intent, but the pipeline should be shared.

### 3. Retrieval should return reasoning-friendly structure

The agent should not receive only a ranked list of hits.

It should receive a retrieval pack that explicitly separates:

- likely known facts
- recent high-signal items
- constraints and blockers
- open questions
- recommended next verification source
- evidence snippets

### 4. Freshness should shape behavior

Freshness should not sit only in metadata. It should affect:

- ranking
- whether an item can be used directly
- whether an item can only be used to aim verification
- how the model phrases confidence in the answer

### 5. Integration memory should be queryable as "shadow live state"

For Gmail, GitHub, and similar systems, memory should answer:

- "what important context do we already know?"
- "what changed since last time?"
- "what should I know before I verify live state?"

That is the right fallback when the live tool surface is partial.

### 6. Separate reasoning retrieval from tree browsing

The primary retrieval tool should not be shaped like a browser.

`memory_retrieve` should become a reasoning-oriented context-resolution tool that returns:

- retrieval intent
- structured retrieval pack
- supporting evidence
- unresolved gaps
- recommended next source

If tree navigation remains useful for debugging, inspection, or a memory UI, it should live in a separate browse-oriented tool such as `memory_browse`.

## Phase 0: Lock the RAG contract

Files:

- `docs/plans/2026-05-25-memory-rag-implementation-plan.md`
- `docs/plans/2026-05-20-memory-redesign-prd.md`
- `docs/plans/2026-05-24-memory-architecture-redesign-implementation-plan.md`

Work:

- record that durable memory retrieval now targets a RAG pipeline, not only note lookup
- define the target retrieval stages:
  - intent classification
  - hybrid first-pass fetch
  - LLM reranking
  - retrieval pack synthesis
  - optional live verification
- define `memory_retrieve v2` as the primary agent retrieval boundary
- explicitly remove the requirement to preserve the current browse-shaped `memory_retrieve` schema
- lock the rule that leaf evidence remains the durable ground truth
- lock the distinction between:
  - raw durable leaves
  - summary nodes
  - synthesized high-signal integration summaries
- lock the split between:
  - reasoning retrieval via `memory_retrieve`
  - optional tree navigation via `memory_browse`

Exit criteria:

- the target retrieval contract is stable enough for runtime work
- downstream phases can implement against one agreed retrieval vocabulary

### Proposed `memory_retrieve v2` contract

The new retrieval contract should be optimized for agent reasoning and handoff.

Example request shape:

```json
{
  "query": "Any important emails recently that I should be aware of?",
  "intent": "briefing",
  "scope": {
    "categories": ["interaction", "integration"],
    "tree_ids": [],
    "node_ids": []
  },
  "retrieval_policy": {
    "hybrid": true,
    "include_neighbors": true,
    "freshness_bias": "high",
    "prefer_high_signal": true,
    "max_evidence": 12
  },
  "answer_goal": "build_working_context"
}
```

Example response shape:

```json
{
  "query": "Any important emails recently that I should be aware of?",
  "intent": "briefing",
  "retrieval_pack": {
    "known_facts": [],
    "recent_high_signal_items": [],
    "constraints": [],
    "blockers": [],
    "open_questions": [],
    "recommended_next_source": "gmail",
    "recommended_next_step": {
      "type": "verify_live_state",
      "source": "gmail",
      "reason": "top items are recent and email-specific"
    }
  },
  "evidence": [
    {
      "id": "memory-node-id",
      "kind": "leaf",
      "category": "integration",
      "title": "Finance approval pending",
      "summary": "Approver has not responded to the latest thread update.",
      "path": "workspace/<workspace-id>/integration/...",
      "freshness_state": "fresh",
      "score": 0.91,
      "reasons": ["vector_match", "novelty", "urgency"]
    }
  ],
  "gaps": [
    {
      "question": "Is the approval still unresolved?",
      "best_source": "gmail"
    }
  ],
  "coverage": {
    "used_lexical": true,
    "used_vector": true,
    "used_neighbors": true,
    "confidence": "medium"
  }
}
```

Notes:

- `intent` and most `retrieval_policy` flags can be inferred by the tool when omitted
- `mode`, `nodeId`, and `children` should no longer be part of the main agent retrieval interface
- if browse/debug behavior is still needed, expose it through a separate `memory_browse` contract
- the agent should resume reasoning from `retrieval_pack`, `evidence`, and `gaps`, not from raw hit lists

## Phase 1: Introduce a shared hybrid first-pass fetch pipeline

Files:

- `runtime/api-server/src/workspace-memory.ts`
- `runtime/api-server/src/interaction-memory.ts`
- `runtime/api-server/src/integration-memory.ts`
- `runtime/api-server/src/memory-recall-index.ts`
- `runtime/api-server/src/memory-recall.ts`
- `runtime/api-server/src/runtime-agent-tools.ts`
- `runtime/api-server/src/agent-runtime-prompt.ts`
- tests:
  - `runtime/api-server/src/memory-recall.test.ts`
  - `runtime/api-server/src/integration-memory.test.ts`
  - `runtime/api-server/src/interaction-memory.test.ts`
  - `runtime/api-server/src/app.test.ts`
  - `runtime/api-server/src/agent-runtime-prompt.test.ts`

Recommended new helper modules:

- `runtime/api-server/src/memory-retrieval-intent.ts`
- `runtime/api-server/src/memory-hybrid-retrieval.ts`

Work:

- add a query-intent classifier for at least:
  - `fact_lookup`
  - `procedure_lookup`
  - `briefing`
  - `planning`
  - `delta`
- move current category retrieval into a shared hybrid first-pass fetch pipeline
- merge lexical, vector, and metadata candidates into one candidate set
- add optional neighbor expansion keyed by:
  - shared `entity_key`
  - `subject_key`
  - provider-specific object grouping
- make `retrieveWorkspaceMemory` route through this shared first-pass fetch pipeline instead of only sorting per-category hits and concatenating them
- redesign `memory_retrieve` around `retrieval_pack + evidence + gaps + recommended_next_source`
- remove browse-oriented fields from the main retrieval tool contract:
  - `mode`
  - `nodeId`
  - `children`
- if needed, introduce `memory_browse` for explicit tree inspection instead of overloading `memory_retrieve`
- update prompt/runtime consumers so the agent picks reasoning back up from the retrieval pack rather than a raw hit list

Exit criteria:

- retrieval is hybrid by default
- `memory_retrieve v2` returns reasoning-ready context rather than legacy search hits
- the agent can continue planning directly from the retrieval result without bespoke post-processing

## Phase 2: Add an LLM-based RAG-grade reranker

Files:

- `runtime/api-server/src/memory-recall-index.ts`
- `runtime/api-server/src/workspace-memory.ts`
- tests:
  - `runtime/api-server/src/memory-recall.test.ts`
  - `runtime/api-server/src/app.test.ts`

Recommended new helper module:

- `runtime/api-server/src/memory-reranker.ts`

Work:

- keep current keyword/metadata/freshness scoring only as a coarse shortlist baseline
- rerank the shortlist with the model by default rather than making LLM reranking optional
- keep the model rerank bounded to a small shortlisted candidate set rather than the full fetched pool
- add intent-aware reranking features:
  - urgency
  - novelty
  - actionability
  - contradiction risk
  - freshness risk
  - direct-user-impact
- add distinct ranking policy for `briefing` and `delta` intents so they do not collapse into pure similarity search
- add category balancing so one noisy category does not drown out the other

Examples:

- `fact_lookup` should prefer exact and high-confidence items
- `procedure_lookup` should prefer procedure memories and command-bearing facts
- `briefing` should prefer important recent items, blockers, and unresolved loops
- `delta` should prefer changed or newly observed items over old static facts

Exit criteria:

- "what should I know?" and "anything important?" behave differently from simple fact lookup
- retrieval quality improvements can be shown in deterministic tests

## Phase 3: Return structured retrieval packs

Files:

- `runtime/api-server/src/workspace-memory.ts`
- `runtime/api-server/src/memory-recall.ts`
- `runtime/api-server/src/memory-recall-manifest.ts`
- `runtime/api-server/src/agent-runtime-prompt.ts`
- `runtime/api-server/src/ts-runner.ts`
- tests:
  - `runtime/api-server/src/memory-recall-manifest.test.ts`
  - `runtime/api-server/src/ts-runner.test.ts`
  - `runtime/api-server/src/agent-runtime-prompt.test.ts`

Recommended new helper module:

- `runtime/api-server/src/memory-retrieval-pack.ts`

Work:

- define a structured retrieval-pack type with sections such as:
  - `known_facts`
  - `recent_high_signal_items`
  - `constraints`
  - `blockers`
  - `open_questions`
  - `recommended_next_source`
  - `evidence`
- keep raw hit-level evidence attached with provenance and freshness
- extend recalled-memory context generation so the model receives the retrieval pack as the primary structure
- remove dependence on legacy flat `entries` / `selection_trace` shaping in prompt consumers once the new path is live

Important constraint:

- do not explode prompt size
- design the pack for compact high-signal prompt projection, not for full memory serialization

Exit criteria:

- the model receives retrieval context in a reasoning-friendly structure
- prompt consumers can distinguish evidence from inference
- the runtime no longer depends on the legacy browse-shaped `memory_retrieve` schema

## Phase 4: Add integration "shadow summaries"

Files:

- `runtime/api-server/src/integration-memory.ts`
- `runtime/api-server/src/integration-memory.test.ts`
- `runtime/api-server/src/turn-memory-writeback.ts`
- `runtime/api-server/src/turn-memory-writeback.test.ts`
- provider-specific architecture notes under `docs/memory-arch/`

Work:

- generate synthesized high-signal integration leaves or semantic nodes for noisy systems
- start with Gmail and GitHub

Examples for Gmail:

- `customer waiting on reply`
- `finance approval pending`
- `thread escalated by sender`
- `email contradicts prior decision`

Examples for GitHub:

- `release PR blocked`
- `review owner changed`
- `incident-related PR merged`

Important constraints:

- keep the synthesized summary linked back to durable leaf evidence
- never make synthesized summaries the only source of truth
- store enough provenance to rehydrate the underlying leaves

Exit criteria:

- briefing-style queries over Gmail and GitHub can succeed from memory even when live MCP coverage is partial
- retrieval quality improves for "important recent" and "what changed" queries

## Phase 5: Query-mode-specific live verification

Files:

- `runtime/api-server/src/agent-runtime-prompt.ts`
- `runtime/api-server/src/workspace-memory.ts`
- `runtime/api-server/src/runtime-agent-tools.ts`
- tests:
  - `runtime/api-server/src/agent-runtime-prompt.test.ts`
  - `runtime/api-server/src/ts-runner.test.ts`

Work:

- make retrieval packs recommend the cheapest next authoritative verification source
- use memory to narrow downstream live checks

Examples:

- memory identifies likely Gmail thread or sender -> Gmail tool checks only that slice
- memory identifies likely repo and PR owner -> GitHub tool checks only that repo/PR
- stale blocker memory -> verify only the blocker, not the whole workspace

This is where the system becomes properly RAG-like in behavior:

- retrieved memory shapes the live follow-up
- live verification closes only the highest-value uncertainties

Exit criteria:

- live verification becomes narrower and cheaper after memory recall
- prompts and tool traces show memory narrowing downstream retrieval

## Phase 6: Evaluation and telemetry

Files:

- `runtime/api-server/src/workspace-memory.ts`
- `runtime/api-server/src/runtime-agent-tools.ts`
- `runtime/api-server/src/claimed-input-executor.ts`
- tests:
  - `runtime/api-server/src/app.test.ts`
  - `runtime/api-server/src/claimed-input-executor.test.ts`

Work:

- add retrieval telemetry for:
  - candidate counts by source
  - rerank reasons
  - selected intent
  - evidence count
  - freshness distribution
  - follow-up tool narrowing success
- add offline evaluation fixtures for:
  - fact lookup
  - procedure lookup
  - briefing
  - delta
  - contradiction

Success metrics:

- recall@k on curated memory questions
- precision of top results for briefing prompts
- stale-memory usage rate
- wrong-memory citation rate
- browser/tool avoidance rate when memory should have sufficed
- reduction in broad follow-up tool calls after memory recall

Exit criteria:

- the team can measure whether retrieval quality and downstream reasoning actually improved

## Recommended rollout order

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 5 for narrow verification
6. Phase 4 for richer synthesized integration summaries
7. Phase 6 hardening and telemetry

Reasoning:

- first make retrieval hybrid and rankable
- then make the output consumable by the model
- then use that output to narrow verification
- then invest more in synthesized integration memory once the retrieval pipeline can exploit it

## Phase 1 acceptance test set

Before moving beyond phase 1, add deterministic fixtures for:

- a fact query that should prefer an interaction leaf over an older integration summary
- a procedure query that should prefer a procedure memory over a generic fact
- a briefing query that should surface a blocker plus one recent integration item
- a query where vector candidates and keyword candidates disagree
- a query where stale reference memory should not outrank fresh factual memory

## Risks

### Prompt bloat

If retrieval packs are too verbose, the model will get more grounded but less agile.

Mitigation:

- keep packs compact
- separate high-signal pack fields from optional deep evidence

### Summary drift

Synthesized integration summaries can become more trusted than their leaves.

Mitigation:

- always keep provenance
- always preserve leaf evidence
- rerank with freshness penalties

### Overfitting briefing heuristics

If "important" is hardcoded too narrowly, briefing queries will regress for new domains.

Mitigation:

- treat urgency, novelty, and actionability as weighted signals
- evaluate with fixtures across Gmail, GitHub, and interaction memory

### Category imbalance

Noisy integration memory may dominate interaction memory.

Mitigation:

- apply intent-aware balancing in the reranker
- preserve cross-category diversity budgets

## Concrete first milestone

If only one milestone ships in the near term, it should be:

- phase 1 hybrid retrieval
- phase 2 intent-aware reranking
- a thin version of phase 3 retrieval packs

That combination delivers the largest product lift without requiring a full memory architecture rewrite.
