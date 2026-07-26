> Archived historical plan.
>
> Superseded on `2026-04-22`. This document describes a compaction-boundary-based continuity design that has since been removed.
>
> Current runtime continuity uses:
> - persisted harness session history
> - runtime-managed session-memory excerpts
> - bounded recalled durable memory

# Runtime Compaction + Background Durable Extraction — Implementation Plan

**Goal:** Smooth the end-of-turn user experience by removing synchronous post-turn memory writeback from the foreground run path, while preserving continuity via existing session history and moving durable extraction to a separate periodic worker.

**Core Principle:** `session_messages`, `turn_results`, and the persisted harness session remain the source of truth. Derived artifacts become asynchronous and eventually consistent.

---

## Desired Behavior

### Foreground run path

- Persist normal runner events, assistant session messages, and final `TurnResultRecord`.
- Emit the terminal event immediately after the final turn result is committed.
- Do not block `run_completed` or `run_failed` on:
  - runtime memory projection file writes
  - compaction boundary persistence
  - model-backed durable extraction
  - durable memory index refreshes

### Continuity model

- Before any auto-compaction, resume relies on:
  - persisted PI harness session state
  - `turn_results`
  - `session_messages`
- After auto-compaction, a compaction artifact is still persisted, but off the critical path.
- No new per-turn continuity cache is introduced.

### Durable memory model

- Durable extraction runs in a separate periodic worker.
- Extraction is not coupled to foreground completion and is not required for correctness.
- Auto-compaction does not directly invoke extraction, but compaction-affected turns should be prioritized by the background worker because they benefit most from a persisted compaction boundary.

---

## Current Problems

The current executor path writes turn memory synchronously after every turn:

- `processClaimedInput(...)` persists the assistant message and turn result, then waits on `writeTurnMemoryWithLifecycleEvents(...)` before appending the deferred terminal event.
- `writeTurnMemory(...)` currently does all of the following on every terminal turn:
  - computes a compacted turn summary
  - writes runtime projection files via `memoryService`
  - runs heuristic durable-memory candidate generation
  - optionally runs model-backed durable extraction
  - rewrites durable indexes
  - persists an `executor_post_turn` compaction boundary

This creates avoidable tail latency after the agent has already finished outputting text.

Relevant files:

- `runtime/api-server/src/claimed-input-executor.ts`
- `runtime/api-server/src/turn-memory-writeback.ts`
- `runtime/api-server/src/turn-result-summary.ts`
- `runtime/api-server/src/ts-runner.ts`
- `desktop/src/components/panes/ChatPane.tsx`

---

## Target Architecture

## 1. Source Of Truth Stays The Same

- Keep persisting:
  - `session_messages`
  - `turn_results`
  - output events
  - harness session id / harness session state
- Keep `ts-runner` history fallback behavior when no compaction boundary exists.
- Treat runtime projection files and durable memory as optional derived state.

## 2. Auto-Compaction Becomes Metadata, Not A Foreground Writeback Trigger

- Capture successful `auto_compaction_end` metadata during runner event handling.
- Store that metadata on the turn result so later workers do not need to rescan output events to detect compaction.
- A successful auto-compaction should mean:
  - `aborted !== true`
  - no `error_message`
  - optional payload retained for diagnostics and prioritization

Recommended stored payload shape:

```json
{
  "removed_messages": 6,
  "summary": "Compacted older context.",
  "tokens_before": 12345,
  "source": "pi"
}
```

## 3. Compaction Artifact Persistence Moves Off The Critical Path

- Stop writing `executor_post_turn` boundaries for every terminal turn.
- Introduce an async boundary persistence step for turns that actually experienced auto-compaction.
- Reuse `buildCompactionBoundaryArtifacts(...)`, but persist those boundaries as:
  - `boundary_type = "harness_auto_compaction"`

The boundary should be built from the final settled turn plus recent history, not from an in-flight partial state.

## 4. Durable Extraction Becomes Periodic Background Work

- Add a dedicated periodic worker in the runtime API server process.
- The worker scans eligible finalized turns and performs:
  1. compaction artifact persistence for compaction-affected turns missing a boundary
  2. runtime projection refreshes, if still needed
  3. durable extraction and memory index refreshes

- The worker should be:
  - idempotent
  - lease/claim based
  - bounded per tick
  - safe to wake eagerly but also able to poll periodically

---

## Implementation Tasks

## Task 1: Extend Turn Result State For Async Post-Processing

**Files:**

- Modify: `runtime/state-store/src/store.ts`
- Modify: `runtime/state-store/src/index.ts`
- Modify: `runtime/state-store/src/store.test.ts`

### Add new `turn_results` columns

- [ ] Add `auto_compaction_payload TEXT`
- [ ] Add `durable_extraction_state TEXT NOT NULL DEFAULT 'pending'`
- [ ] Add `durable_extraction_attempt_count INTEGER NOT NULL DEFAULT 0`
- [ ] Add `durable_extraction_started_at TEXT`
- [ ] Add `durable_extraction_completed_at TEXT`
- [ ] Add `durable_extraction_claimed_by TEXT`
- [ ] Add `durable_extraction_claimed_until TEXT`
- [ ] Add `durable_extraction_last_error TEXT`

### Add indexes

- [ ] Add an index supporting background scans, for example:
  - `(durable_extraction_state, durable_extraction_claimed_until, completed_at)`

### Add store methods

- [ ] Extend `TurnResultRecord` and `upsertTurnResult(...)`.
- [ ] Add methods to claim globally eligible turn results for background extraction.
- [ ] Add methods to mark extraction `processing`, `completed`, and `failed`.
- [ ] Ensure expired extraction claims can be recovered similarly to queue-worker input leases.

**Notes:**

- This uses `turn_results` itself as the durable work queue instead of introducing a second job table.
- That keeps the source turn and extraction state co-located.

---

## Task 2: Remove Synchronous Turn Memory Writeback From The Executor

**Files:**

- Modify: `runtime/api-server/src/claimed-input-executor.ts`
- Modify: `runtime/api-server/src/claimed-input-executor.test.ts`

### Event capture changes

- [ ] Track successful `auto_compaction_end` events while consuming runner output.
- [ ] Normalize the captured payload into a small `auto_compaction_payload` object to persist on the final turn result.

### Completion-path changes

- [ ] Remove the unconditional `writeTurnMemoryWithLifecycleEvents(...)` call from the successful completion path.
- [ ] Remove the synchronous `writeTurnMemoryIfAvailable(...)` fallback from the executor error path.
- [ ] Persist the final turn result with:
  - `compactedSummary` if still desired locally
  - `autoCompactionPayload`
  - `durableExtractionState = 'pending'`

### Terminal-event ordering

- [ ] Append the deferred `run_completed` / `run_failed` event immediately after the final turn result commit.
- [ ] Wake the new durable extraction worker after the turn is finalized.

### Test updates

- [ ] Update executor success tests so they no longer expect:
  - `compaction_start`
  - `compaction_boundary_written`
  - `compaction_end`
  on every successful turn.
- [ ] Add tests proving `auto_compaction_end` payload is captured and persisted.

---

## Task 3: Split Boundary Persistence From Durable Extraction

**Files:**

- Modify: `runtime/api-server/src/turn-memory-writeback.ts`
- Modify: `runtime/api-server/src/turn-result-summary.ts`
- Modify: `runtime/api-server/src/turn-memory-writeback.test.ts`

### Refactor the current monolithic path

- [ ] Split `writeTurnMemory(...)` into smaller primitives, for example:
  - `persistCompactionBoundaryForTurn(...)`
  - `refreshRuntimeProjectionFilesForTurn(...)`
  - `extractDurableMemoryForTurn(...)`

### Boundary persistence changes

- [ ] Add a helper that persists a `harness_auto_compaction` boundary using final turn data and existing `buildCompactionBoundaryArtifacts(...)`.
- [ ] Ensure the turn result’s `compactionBoundaryId` is updated when the async worker persists that boundary.

### Durable extraction changes

- [ ] Preserve the existing durable extraction logic, but call it only from the worker path.
- [ ] Preserve best-effort semantics: extraction failure must not corrupt the turn result or session history.

### Runtime projection files

- [ ] Move writes for:
  - `runtime/session-state/...`
  - `runtime/blockers/...`
  - `runtime/latest-turn.md`
  - `runtime/recent-turns/...`
  - `runtime/session-memory/...`
  out of the foreground executor path.
- [ ] Decide whether the periodic worker should continue refreshing these files.

**Recommended:** keep projection refreshes in the worker for compatibility with existing capture/debug surfaces, but explicitly document them as eventually consistent.

---

## Task 4: Add A Periodic Durable Extraction Worker

**Files:**

- Create: `runtime/api-server/src/durable-memory-worker.ts`
- Create: `runtime/api-server/src/durable-memory-worker.test.ts`
- Modify: `runtime/api-server/src/app.ts`

### Worker behavior

- [ ] Poll periodically for eligible turn results.
- [ ] Support an explicit `wake()` so the executor can nudge the worker after finalizing a turn.
- [ ] Process turns in a priority order such as:
  1. compaction-affected turns without a persisted boundary
  2. newest completed turns pending extraction

### Processing steps per claimed turn

- [ ] Load the final turn result plus recent turns and session messages.
- [ ] If `auto_compaction_payload` exists and `compactionBoundaryId` is still null:
  - persist a `harness_auto_compaction` boundary
  - update the turn result’s `compactionBoundaryId`
- [ ] Refresh runtime projection files, if retained.
- [ ] Run durable extraction and index refreshes.
- [ ] Mark extraction success or failure on the turn result record.

### Worker configuration

- [ ] Add environment-backed knobs, for example:
  - `HB_DURABLE_MEMORY_WORKER_INTERVAL_MS`
  - `HB_DURABLE_MEMORY_WORKER_BATCH_SIZE`
  - `HB_DURABLE_MEMORY_WORKER_LEASE_SECONDS`

### App wiring

- [ ] Add `resolveDurableMemoryWorker(...)` in `app.ts`.
- [ ] Start the worker in `onReady`.
- [ ] Close the worker in `onClose`.

---

## Task 5: Keep Resume Correctness History-First

**Files:**

- Modify: `runtime/api-server/src/ts-runner.ts`
- Modify: `runtime/api-server/src/ts-runner.test.ts`

### Behavior requirements

- [ ] Keep current history fallback logic as the correctness path when no compaction boundary exists.
- [ ] Continue loading `recent runtime context` and `session resume context` from raw history when the worker has not yet materialized a boundary.
- [ ] Treat runtime projection files and `session-memory` excerpts as optional accelerators only.

### Tests

- [ ] Add/adjust tests proving:
  - immediate next-turn resume still works with only raw history
  - `compaction_restored` is emitted only after an async boundary is actually persisted

---

## Task 6: Remove The Always-On “Finalizing Run Context” UX

**Files:**

- Modify: `desktop/src/components/panes/ChatPane.tsx`
- Modify: `desktop/src/components/panes/ChatPane.test.mjs`

### UX changes

- [ ] Stop showing `Finalizing run context` after every run.
- [ ] Keep `auto_compaction_*` as the visible compaction UX.
- [ ] If we later surface worker activity, it should be a distinct background status, not a blocking terminal phase.

**Expected outcome:** normal turns end as soon as the assistant is done, without a fake post-turn “finalization” phase.

---

## Design Constraints

- No new per-turn continuity cache.
- No synchronous durable extraction in the foreground executor path.
- No correctness dependency on runtime projection files.
- No correctness dependency on a compaction boundary existing immediately after a compaction-affected turn.
- History remains the canonical recovery path; boundaries and extracted memories are eventually consistent enhancements.

---

## Migration Notes

- Existing `executor_post_turn` boundaries should continue to load correctly.
- New worker-generated boundaries should use `boundary_type = "harness_auto_compaction"` when sourced from runner auto-compaction metadata.
- Existing APIs that expose `compaction_boundary_id` must tolerate it being null for normal turns.
- Existing APIs that read runtime projection files must tolerate those files lagging behind the latest completed turn.

---

## Validation

- [ ] `npm run runtime:state-store:test`
- [ ] `npm run runtime:state-store:typecheck`
- [ ] `npm run runtime:api-server:test`
- [ ] `npm run runtime:api-server:typecheck`
- [ ] Targeted regression focus:
  - `runtime/api-server/src/claimed-input-executor.test.ts`
  - `runtime/api-server/src/turn-memory-writeback.test.ts`
  - `runtime/api-server/src/ts-runner.test.ts`
  - `runtime/api-server/src/app.test.ts`
  - `runtime/api-server/src/durable-memory-worker.test.ts`
  - `runtime/state-store/src/store.test.ts`

---

## Expected Outcome

After this plan lands:

- ordinary turns complete without synchronous memory finalization latency
- history-based resume remains correct immediately
- compaction-affected turns eventually gain persisted boundaries
- durable memory extraction runs independently on a periodic worker
- UI no longer implies that every run is doing a foreground “finalizing run context” phase
