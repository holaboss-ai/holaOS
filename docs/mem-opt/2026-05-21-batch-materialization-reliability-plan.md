# Batch And Materialization Reliability Plan

Date: `2026-05-21`

## Purpose
This document captures the next reliability pass for interaction-memory writeback. The target is the current non-overlapping 3-turn writeback batch per session, including extraction, leaf persistence, summary rebuilds, and batch-cursor advancement.

The plan is specifically driven by the clean-baseline live eval after the prompt-only `AGENTS.md` tightening:
- direct retrieval accuracy: `28/28`
- reader answer accuracy: `26/28`
- `AGENTS.md` leakage: resolved in the evaluated run
- remaining failures: batch completion timing, cross-batch leaf hygiene, and evaluator-strictness edge cases

## Observed Problems
### 1. Batch timeouts are often slow completions, not permanent stalls
The failing heavy scenarios eventually reached the expected batch cursor, but only after the eval timeout budget expired.

Examples:
- `customer_silver_oak_deep_session`
  - report observed cursor `3`
  - workspace DB later showed cursor `9`
  - cursor reached `9` about `56s` after the last writer turn
- `three_customer_triage_session`
  - report observed cursor `3`
  - workspace DB later showed cursor `9`
  - cursor reached `9` about `67s` after the last writer turn

Interpretation:
- the current `45s` eval wait budget is lower than the actual worst-case synchronous writeback path

### 2. The write path is expensive per batch
The current batch path does all of the following synchronously:
- one extraction model call
- one entity-assignment model call per persisted candidate
- one embedding call per leaf
- one full-tree summary rebuild for every touched entity
- one summary model call per summary node
- one embedding call per summary node

Interpretation:
- heavier sessions pay this cost three times across three consecutive 3-turn batches
- cursor advancement currently waits for the entire chain to complete

### 3. Cross-batch dedupe is too literal
The triage scenario still produces semantically duplicate active leaves across later batches.

Examples:
- `Redwood Care account manager`
- `Redwood Care account manager is Paul Reed`
- duplicate `Juniper Supply escalation contact`

Interpretation:
- exact fingerprint and exact `entity + subject_key` checks are not enough once the extractor paraphrases the same fact differently in a later batch

### 4. Extraction-stage model failure is the highest-risk reliability hole
If the extraction model returns a non-OK response or request failure, the current code path can treat the batch as empty and still advance the batch cursor.

Interpretation:
- extraction failure, including a possible context-length failure, can silently drop memory
- this is more serious than slow completion or evaluator strictness

### 5. Most trees are flat mainly because the branch factor is high
Current branch factor: `8`

Implication:
- `<= 8` leaves naturally produce one `L1` summary only
- `9+` leaves are required before a tree deepens

The `Silver Oak` case confirms that the multi-layer builder works when enough leaves land:
- `9` leaves
- `L2: 2`
- `L1: 1`

So the flat-tree issue is partly expected and should not be treated as a rebuild bug by default.

## Plan
### 1. Add explicit batch-state tracking
Add a real batch record instead of treating the cursor as the only state.

Proposed fields:
- `batch_id`
- `session_id`
- `turn_start_index`
- `turn_end_index`
- `status`
  - `pending`
  - `running`
  - `completed`
  - `completed_no_candidates`
  - `failed`
- `extraction_ms`
- `persist_ms`
- `rebuild_ms`
- `candidate_count`
- `persisted_leaf_count`
- `touched_entities`
- `failure_reason`
- `attempt_count`

This should let us distinguish:
- slow batch
- empty but successful batch
- failed extraction
- failed rebuild
- repeated retries

### 2. Stop advancing the cursor on extraction failure
Batch completion semantics should change:
- advance cursor only on `completed` or `completed_no_candidates`
- if extraction fails, mark the batch `failed`
- keep it retryable
- do not silently convert failure into “no candidates”

This is the highest-priority correctness fix.

### 3. Add oversize-aware extraction fallback
The current batch size is only `3` turns and the prompts are clipped, but extraction overflow or request-size failure is still possible and must be handled explicitly.

#### 3a. Preflight size estimation
Before extraction, estimate prompt size against a safe budget.

First pass:
- use character count as a cheap guardrail
- add token estimation later if needed

If within budget:
- run normal 3-turn extraction

If above budget:
- do not send the whole batch as one prompt

#### 3b. Sub-batch extraction fallback
When the full 3-turn batch is too large:
1. split into smaller extraction units
   - first try `2 turns + 1 turn`
   - if still too large, fall back to `1 turn each`
2. run extraction for each sub-batch
3. merge extracted candidates
4. dedupe merged candidates
5. persist the merged result as the output of the original batch

This preserves the 3-turn batch abstraction while avoiding dropped memory.

#### 3c. Retry on explicit model context failure
If the extraction model reports input-too-large or an equivalent request failure:
- catch it as a typed extraction failure
- retry automatically with smaller sub-batches
- only mark the batch failed if all sub-batch attempts fail

#### 3d. Failure behavior if all attempts fail
If normal extraction and all fallback extractions fail:
- mark the batch `failed`
- record the failure reason
- do not advance the cursor

### 4. Add retry-safe per-session lease ownership
Only one active processor should own writeback for a session at a time.

Requirements:
- acquire lease for the session
- process the next uncompleted batch
- release lease
- retry safely if prior attempt failed

Retry behavior must be idempotent:
- rerunning a failed batch must not create duplicate leaves

### 5. Separate leaf persistence timing from summary rebuild timing
Treat the pipeline as two major stages:

Stage A:
- extraction
- entity assignment
- leaf persistence

Stage B:
- summary rebuild for touched entities

Keep both timings separately so we can tell whether a slow batch is dominated by:
- extraction/model calls
- leaf persistence/embedding
- or summary rebuild/model calls

For now, cursor advancement can still remain after rebuild completion. The point of this step is observability first.

### 6. Strengthen semantic cross-batch dedupe
Keep the current exact dedupe checks, but add a second semantic dedupe layer before persistence.

Candidate should be considered the same memory item when all are true:
- same entity
- same memory type
- strong normalized similarity across:
  - title
  - summary
  - subject key
- overlapping named/value spans

Decision:
- if equivalent, no-op
- if the new candidate is clearly richer or more specific, supersede the older leaf

This is the main fix for triage-style leaf inflation.

### 7. Make tree-shape validation explicit
Do not treat “flat tree” as failure by default. Instead, validate expected shape from leaf count.

Examples:
- `<= 8` leaves -> one `L1` summary is expected
- `9+` leaves -> deeper tree expected

Per rebuild, record:
- active leaf count
- expected summary count by level
- actual summary count by level

This will separate:
- expected flat trees
- from real rebuild/materialization failures

### 8. Upgrade the eval harness
Extend the evaluator to report:
- batch statuses
- batch completion time
- extraction duration
- persistence duration
- rebuild duration
- overflow fallback usage
- retry count
- exact leaf inflation/deflation per entity

Failures should be classified more precisely:
- timeout-budget only
- extraction failure
- context-overflow fallback used
- duplicate-leaf hygiene
- missing-memory extraction
- rebuild/materialization mismatch
- answer-normalization only

## Suggested Implementation Order
1. Batch state + stage timing
2. Stop cursor advancement on extraction failure
3. Oversize-aware extraction fallback
4. Per-session lease ownership and retry safety
5. Semantic cross-batch dedupe
6. Eval/reporting upgrades
7. Clean-baseline live rerun

## Expected Outcome
After this pass:
- batches will no longer silently disappear on extraction failure
- context-size problems will fall back to smaller extraction units instead of losing memory
- slow completion will be measurable instead of looking like a generic timeout
- interleaved sessions should stop inflating active leaf counts as often
- deeper trees will appear whenever leaf count actually exceeds the branch threshold
