# Memory Optimization Plan

Date: `2026-05-21`

## Purpose
This document captures the main optimization work implied by the recent live memory evaluation runs. It is intended to be the reference point for the next round of memory-quality, retrieval-quality, and scalability improvements.

## Evaluation Basis
The recommendations below come from a live evaluation run against `Mem1` using a clean interaction-memory store and a clean `AGENTS.md` baseline.

Evaluation summary:
- Scenarios run: `11`
- Passed: `6`
- Failed: `5`
- Direct retrieval accuracy: `26/28` = `92.9%`
- Agent recall accuracy: `26/28` = `92.9%`
- Reader routing:
  - `23/28` via `memory_retrieve`
  - `5/28` via likely pre-run recall
  - `0/28` via unrelated tools only
- Direct retrieval latency:
  - average: `1142.9ms`
  - p95: `1429ms`
- End-to-end reader answer latency:
  - average: `8732.3ms`
  - p95: `12175ms`

## Current State
### What is working
- Direct retrieval is usually accurate.
- End-to-end agent recall is much better than earlier versions.
- Similar-name entity separation is working in the evaluated customer cases.
- Mixed project/customer and dual-project sessions can produce usable trees.
- The system now usually uses `memory_retrieve` for contextual recall questions instead of ignoring memory completely.

### What is not working well
- Tree quality degrades in deeper or more interleaved sessions.
- Reader turns appear to be re-ingested as new memory in some scenarios.
- Some entity typing is unstable, especially for vendor-like or business-tool-like names.
- `AGENTS.md` leakage still happens in some project and customer cases.
- Most trees are still effectively flat: leaves plus one root summary.

## Observed Failure Patterns
### 1. Reader-turn re-ingestion
Evidence:
- `three_customer_triage_session`: each entity had `4` leaves instead of expected `3`
- `project_rdx_console_session`: `7` leaves instead of expected `6`
- `customer_orchid_holdings_session`: `8` leaves instead of expected `6`

Interpretation:
- The post-run writeback path is still learning from answers whose main purpose was recall, not new knowledge introduction.

### 2. Incomplete batch extraction
Evidence:
- `customer_silver_oak_deep_session` should have produced `9` leaves and at least `3` summaries
- actual result was `6` leaves and `1` summary

Interpretation:
- The tree-builder can support deeper layering, but the extractor is not consistently yielding all expected durable facts.
- The multi-layer tree problem is currently more of a leaf-yield problem than a summary-builder problem.

### 3. Entity typing / ownership drift
Evidence:
- `customer_mercury_payments_long_session` did not land under `interaction:customer:mercury-payments`
- retrieval surfaced `interaction:system:mercury-payments` instead

Interpretation:
- Existing entity resolution and type selection are still too loose for some business-oriented names.

### 4. AGENTS.md leakage
Evidence:
- `customer_mercury_payments_long_session`
- `project_rdx_console_session`
- `customer_orchid_holdings_session`

Interpretation:
- The prompt boundary between workspace-wide defaults and contextual memory is better than before, but still not consistently enforced.

### 5. Mostly flat trees
Observed shape:
- Across the evaluated workspace state, most entities had only one active summary node.
- Even the deeper `Silver Oak` case produced only one summary node.

Interpretation:
- The implementation supports multi-layer summaries, but live runs are still usually producing one-layer trees because enough clean leaves are not consistently reaching rebuild.

## Optimization Priorities
## 1. Stop reader-turn re-ingestion
Priority: `highest`

Why:
- This directly pollutes the tree.
- It inflates leaf counts.
- It makes evaluation noisy and can distort summary structure.

Changes to make:
- Add a writeback gate that asks whether the turn introduced new durable knowledge.
- Skip memory extraction when a turn is primarily answering from existing memory.
- Downweight or ignore assistant restatements of already retrieved knowledge.
- Prefer user-introduced durable facts over assistant-generated recap content.

Expected effect:
- Fewer duplicate leaves
- Cleaner entity trees
- More reliable evaluation metrics

## 2. Improve batch extraction completeness
Priority: `highest`

Why:
- Missing leaves are the main reason deep trees do not form.
- This is the core reason the current tree stays mostly flat in practice.

Changes to make:
- Strengthen the extraction prompt so it emits one candidate per atomic durable fact/procedure item.
- Explicitly instruct extraction to keep all durable contacts, owners, thresholds, channels, URLs, and procedures from the batch.
- Add a batch coverage metric:
  - expected items vs extracted items
- Consider internal sub-chunking when a batch is dense.

Expected effect:
- More complete leaf sets
- More reliable tree deepening
- Better recall on threshold-like facts such as windows, cutoffs, and URLs

## 3. Make entity resolution existing-entity-first
Priority: `high`

Why:
- The system already has evidence that lexical overlap is manageable.
- The remaining problem is type stability and over-fallback behavior.

Changes to make:
- Reuse existing entities aggressively when there is a close match.
- Add stronger backend priors:
  - customer/vendor/account/billing/renewal/contact -> `customer`
  - rollout/release/staging/dashboard/canary -> `project`
- Raise the threshold for creating a new entity type when a close existing entity is already present.
- Normalize business-oriented names more strongly before type selection.

Expected effect:
- Better tree ownership consistency
- Fewer `system` or fallback misclassifications
- Better retrieval precision

## 4. Tighten the AGENTS.md boundary
Priority: `high`

Why:
- If contextual facts keep leaking into `AGENTS.md`, the memory system becomes harder to trust and harder to evaluate.

Changes to make:
- Strengthen prompt language so named project/customer facts default to memory, not `AGENTS.md`.
- Add a backend or tool-level safeguard around `update_workspace_instructions`.
- Reject or warn when the payload looks like contextual named facts rather than workspace-wide defaults.
- Keep eval scenarios failing hard on new `AGENTS.md` leakage.

Expected effect:
- Cleaner separation between control-plane instructions and recall memory
- Better signal on whether the memory system is actually working

## 5. Make tree deepening more predictable
Priority: `medium`

Why:
- The current system nominally supports multi-layer trees, but that is not materializing reliably.

Changes to make:
- Keep the current branch-factor logic for now, but add tree-plan diagnostics:
  - active leaf count
  - expected summary nodes by level
  - actual summary nodes created
- Add targeted evals for:
  - `9` leaves
  - `17` leaves
  - `33` leaves
- Confirm that once leaf yield is fixed:
  - `9` leaves produces more than one summary node

Expected effect:
- Easier diagnosis of tree-builder behavior
- More confidence that deeper summaries are actually reachable

## 6. Strengthen retrieval provenance discipline
Priority: `medium`

Why:
- Agent recall is now usually good, but the system still splits between explicit retrieval and pre-run recall.
- That is acceptable, but it should be more observable and more deliberate.

Changes to make:
- Keep retrieval agentic.
- Improve provenance guidance so internal contextual facts probe memory first.
- If pre-run recall is absent and the question looks like workspace memory, prefer `memory_retrieve` before anything else.
- Keep reporting whether the answer came from:
  - explicit retrieval
  - likely pre-run recall
  - mixed path

Expected effect:
- More predictable memory usage
- Easier evaluation and debugging

## 7. Relax evaluator strictness only where semantically safe
Priority: `medium`

Why:
- Some failures are meaningful; some are only formatting noise.

Example:
- expected `4pm Eastern`
- answer `4:00 PM Eastern`

Changes to make:
- Normalize obvious time/number/casing variants in answer checks.
- Keep semantic checks strict.
- Do not relax fact-identity checks or entity-ownership checks.

Expected effect:
- Cleaner signal from the evaluation suite

## Scalability Risks
## 1. Retrieval scans too much
Current concern:
- Retrieval still iterates broadly across active trees and nodes in scope.

Risk:
- This will not scale well as the number of trees and leaves grows.

Optimization direction:
- shortlist trees first
- shortlist nodes second
- hydrate bodies late

## 2. Embedding lookup is still too broad
Current concern:
- Retrieval currently builds embedding maps across all relevant active nodes for the selected embedding model.

Risk:
- memory and latency will grow badly with scale

Optimization direction:
- scope embedding queries by category/tree
- later add ANN/vector indexing instead of table-wide scans

## 3. Retrieval still reads too much from disk
Current concern:
- Candidate building reads markdown bodies to generate excerpts.

Risk:
- I/O cost grows with candidate count

Optimization direction:
- persist excerpt/snippet text in the DB
- only read full markdown for top hits

## 4. Summary rebuild is full-tree replacement
Current concern:
- Rebuild currently replaces the full summary tree for an entity.

Risk:
- this becomes expensive for large trees

Optimization direction:
- incremental sealing
- localized subtree rebuilds
- append-oriented summary maintenance

## 5. Batch extraction is still naive
Current concern:
- The current `3`-turn batching reduces noise, but it still batches by count, not by knowledge quality.

Risk:
- reader turns still get mixed in
- semantic boundaries are weak

Optimization direction:
- batch only writeback-eligible turns
- maintain an extraction cursor plus eligibility classification

## Evaluation Isolation Caveat
### What was cleared before the eval
- `interaction_entities`
- `interaction_leaves`
- `interaction_summary_nodes`
- `interaction_tree_edges`
- `interaction_node_embeddings`
- interaction batch cursor metadata
- `.holaboss/memory/interaction`
- `AGENTS.md` reset to a clean baseline

### What was not cleared
- session records
- turn results
- session messages
- scratchpads
- broader runtime history

### Practical impact
- Old session history was not fully purged.
- However, fresh unique writer/reader session ids were used for the eval.
- The memory backend itself was reset, so old interaction-memory leaves and summaries should not have leaked directly into the evaluated memory trees.

Assessment:
- It is unlikely that old session history was the main cause of the observed memory failures.
- The evaluation harness is still not perfectly isolated.

## Eval Harness Hardening
Recommended next steps:
- Best: run each eval on a fresh temporary workspace cloned from a baseline
- Good: extend cleanup to also purge eval-generated session/turn/message rows
- Minimum: namespace eval sessions and delete them after each run

## Recommended Execution Order
1. Stop reader-turn re-ingestion
2. Improve batch extraction completeness
3. Stabilize entity typing and reuse
4. Tighten `AGENTS.md` boundary
5. Add tree-plan diagnostics and multi-layer eval cases
6. Reduce retrieval scan and hydration cost
7. Harden eval isolation

## Summary
The current memory system is already useful, but the next bottleneck is quality hygiene, not basic existence.

The highest-value work is:
- prevent writeback pollution
- increase extracted leaf completeness
- stabilize entity ownership
- protect the `AGENTS.md` boundary

Once those are fixed, the multi-layer tree should become much more real in practice, and the scalability work will be easier to prioritize with cleaner data.
