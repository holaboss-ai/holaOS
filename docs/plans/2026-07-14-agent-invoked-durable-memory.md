# Agent-invoked durable memory (retire the per-turn extraction model call)

**Status:** proposal · **Date:** 2026-07-14 · **Area:** desktop runtime memory
(`runtime/api-server`, `runtime/harnesses`)

## Motivation

Every desktop turn issues background LLM calls on the configured `background_tasks`
model (`gpt-5.4`), separate from the main brain (e.g. `claude-sonnet-5`). Observed
per turn in billing (`quota_transactions`, category `llm`):

- `claude-sonnet-5` — the main brain (large input, the actual reply).
- `gpt-5.4` ×N — auxiliary calls: durable-memory candidate extraction + artifact
  related-info/vision extraction.

Two problems:

1. **Cost / always-on.** The durable-extraction pass runs regardless of whether the
   turn contained anything worth remembering. Most turns don't.
2. **Harness asymmetry + the bring-your-own-agent frontier.** The *read* path is
   already an agent tool — `memory_retrieve` is surfaced to the brain (with
   "memory-first routing" guidance) and exposed to **all** harnesses over MCP
   (`runtime-tools-mcp.ts`). The *write* path is the odd one out: a pi-specific
   background pass that an external CLI harness (Claude Code, ACP) **cannot run**.
   So durable capture silently doesn't happen for external harnesses — matching the
   "memory writeback dormant on external harnesses" observation.

The fix: make durable **write** an agent-invoked tool (`remember`), mirroring
`memory_retrieve`, and retire the automatic per-turn extraction model call. Keep the
deterministic consolidation server-side, and keep interaction indexing automatic.

## Two subsystems — don't conflate them

| | **durable memory** | **interaction memory (the index)** |
|---|---|---|
| what | distilled facts/preferences ("user prefers X", "project Y uses Z") | summarized, categorized record of past turns |
| built by | `turn-memory-writeback` LLM extraction (gpt-5.4) | `interaction-memory` (semantic tree: leaves → 8-way tree by category, entities, embeddings) |
| retrieval | injected as standing context | `memory_retrieve` hybrid search (FTS + vector + recency) |
| nature | **judgment** — what deserves elevating | **bookkeeping** — index everything for later recall |
| change | → agent-invoked `remember()` tool | → **unchanged** (stays automatic; tune cost separately) |

Only durable memory is a judgment call that belongs to the brain. Interaction
indexing is bookkeeping and must stay automatic (you don't want the agent deciding
"should I index this turn?" on every message).

## Current anatomy (the clean seam)

`writeTurnDurableMemory` (`runtime/api-server/src/turn-memory-writeback.ts:1095`)
already separates the two concerns:

- **Embedding-based document/artifact indexing** (lines ~1105–1146):
  `persistTurnInputAttachmentsAsDocuments`, `persistTurnReferencedImageUrlsAsDocuments`,
  `persistTurnOutputArtifactsAsDocuments`, all via `createRecallEmbeddingModelClient`.
  Cheap, part of the recall substrate. **Keep.**
- **LLM-based durable-candidate extraction** (gated on `modelContext.modelClient`,
  line ~1147+, batched by `TURN_BATCH_SIZE`, lease-guarded): runs
  `extractDurableMemoryCandidatesFromModel` → `consolidateDurableCandidates`
  (`:250`, deterministic Jaccard/specificity dedup) → `persistDurableMemoryCandidate`
  (`:963`). **This is the gpt-5.4 work that moves to the tool.**

The deterministic consolidation + persist (`consolidateDurableCandidates`,
`persistDurableMemoryCandidate`) is the valuable, reusable part — the tool handler
calls it directly, so memory *quality* is unchanged; only the *trigger* moves from
an extraction model to the brain's judgment.

## Per-turn flow

### Today
```
user → recall inject → MAIN BRAIN [claude-sonnet-5]
                          ├─ artifact indexing        [embeddings]      keep
                          └─ durable extract → consolidate → persist  [gpt-5.4]  ALWAYS
```

### Proposed
```
user → recall inject → MAIN BRAIN [claude-sonnet-5]
                          ├─ memory_retrieve()   (recall — already a tool)
                          ├─ remember(fact)      (NEW write tool)  ── only when salient
                          │        └─ handler (NO LLM): consolidateDurableCandidates
                          │                              → persistDurableMemoryCandidate
                          └─ artifact/interaction indexing  [embeddings]   keep
```

Typical turn with nothing memorable: **zero** gpt-5.4 durable calls. Memorable turn:
one inline `remember()` by the brain, then deterministic consolidation.

## Concrete edit-point map

1. **Add the `remember` tool alongside `memory_retrieve`** (mirror every place
   `memory_retrieve` is wired):
   - `runtime/harnesses/src/runtime-agent-tools.ts` (~:121) — tool definition +
     schema (`fact`/`content`, optional `subject`/`category`/`evidenceRefs`).
   - `runtime/harnesses/src/runtime-capability-tools.ts` (~:432, ~:1413) — capability
     entry + usage guidance.
   - `runtime/harnesses/src/runtime-tool-capability-client.ts` (~:817) — request-body
     builder for the tool.
   - `runtime/api-server/src/runtime-tools-mcp.ts` (~:48) — expose over MCP so
     external harnesses get it too.
   - **Handler:** POST endpoint (next to the `memory_retrieve` handler in `app.ts`)
     that builds a `DurableMemoryCandidate` from the tool args and calls
     `consolidateDurableCandidates` → `persistDurableMemoryCandidate`. No model call.
2. **Gate off the automatic extraction:** at
   `claimed-input-executor.ts:5306` (the `writeTurnMemory({ modelContext })` call),
   pass `modelContext: null` when the tool-write path is enabled. Per the code, a
   null `modelContext.modelClient` short-circuits the extraction (line ~1147) while
   **still running** the embedding-based artifact indexing above. So flipping the
   flag cleanly disables only the LLM extraction.
3. **Prompt guidance:** add "record durable user facts / preferences / project state
   as you learn them" to `agent-capability-registry.ts` (~:1522, next to the
   memory-first routing block), so writes are as reliably invoked as reads.
4. **Keep the cheap heuristic backstop:** `detectExplicitResponseStylePreference`
   (`turn-memory-writeback.ts:320`) — a zero-cost non-LLM capture for explicit
   high-value signals — stays wired regardless of the flag.

## Reliability

The counterargument is "the agent forgets to write." Mitigations:
- We already rely on this exact model for **reads** (`memory_retrieve` + memory-first
  routing) and it works. Mirror the guidance for writes.
- Keep the heuristic backstop (#4) for explicit signals.
- Optional later: a lightweight **end-of-session** (not per-turn) consolidation as a
  safety net — cheaper than per-turn, and only if telemetry shows under-capture.

## Rollout (as shipped — no operational flag)

Decided against an operational/env flag (`AGENT_MEMORY_TOOL_WRITE`): a flag only
buys a no-redeploy kill switch, and this is desktop code we deploy on the release
line where `git revert` is the rollback. It would just be dead config plus a second
code path. Instead:

1. **Ship the tool** (commit 1) — additive, harmless while extraction still ran.
2. **Verify on the real runtime** — a `remember` call hit the endpoint (200) and
   persisted a durable node in `semantic_memory_nodes` + rebuilt the tree, with no
   model extraction. (`memory_entries` is a legacy/unused table; durable memory
   actually lives in `semantic_memory_nodes`.)
3. **Retire the extraction** (commit 2) — first gated off behind a `const false`
   while the tool was validated, then **fully removed** (commit 4). The per-turn
   extraction batch loop, its lease/cursor/retry/batch-state machinery, all
   extraction-only helpers, and the entire `memory-writeback-extractor.ts` module
   are gone (`writeTurnDurableMemory` shrank 1514→599 lines). `writeTurnDurableMemory`
   now only indexes turn artifacts/documents. Restore path = git revert.
4. **Nudge the brain to write** (commit 3) — write-side routing guidance in
   `agent-capability-registry.ts`, symmetric to the existing memory-first read
   routing, so agent-invoked writes are triggered as reliably as reads.

Tests: the extraction test suite (which asserted the removed behavior) was pruned;
`turn-memory-writeback.test.ts` keeps the tool-only-default regression test, the
artifact-indexing test, and the `refreshMemoryIndexes` tests (4 total, green). No
new failures elsewhere (the pre-existing env-bound failures in app/claimed-input
tests are unchanged from baseline).

Remaining optional net: the heuristic backstop (`detectExplicitResponseStylePreference`,
still wired) — extend only if telemetry shows under-capture.

## Alignment / prior art

This converges with **`employee-persistent-memory`** (HolaEmployee, Phase 1 shipped
to dev behind `EMPLOYEE_MEMORY_ENABLED`): Claude-Code-style, agent-curated file
memory (a `MEMORY.md` index + curated files). The desktop durable-write path adopts
the same agent-invoked model rather than inventing a new one — and unifies desktop +
employee + external harnesses on one memory-write surface.

## Follow-ups (out of scope here)

- Interaction-index cost tuning (the *other* gpt-5.4 spend): batch/lazy summarization,
  or a smaller model for leaf summaries — separate from this change.
- Artifact "related-info"/vision extraction currently rides `modelContext.modelClient`
  in the indexing calls; decide whether it stays (indexing) or also gets cheaper.
- `quota.consume` user↔org membership validation (tracked separately, billing).
