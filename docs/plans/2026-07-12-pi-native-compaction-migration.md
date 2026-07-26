# Migrate to pi-native compaction — remove the runtime's custom async compaction layer

**Status:** implemented (Option A — keep `providerTerminationRecovery`) · **Branch:**
`refactor/pi-native-compaction` (off `release/2026.706`)

Net ~3,800 lines removed across 8 files. Source typechecks clean (api-server +
harness-host); `pi.test.ts` 87/87; api-server compaction tests pass (the 2
remaining executor-test failures — completion notification, workspace-file dedup —
pre-exist on `release/2026.706` and are unrelated). Kept the synchronous
`forceCompactSessionWithSnapshotMerge` primitive for `providerTerminationRecovery`;
removed the async `session_checkpoint` job, the pre-run estimate gate, and the
runtime overflow recovery; un-suppressed pi's native post-run compaction.

## Goal

Delete the runtime-owned async compaction machinery (pre-run estimate gate, the
async `session_checkpoint` job, snapshot-merge, and our forked overflow recovery)
and rely on **pi's native compaction** (threshold + overflow-retry), which runs on
**real model token counts**.

## Why

pi `@mariozechner/pi-coding-agent@0.66` already does everything our layer does, on
better inputs:

| Capability | pi native | our layer |
|---|---|---|
| Threshold compaction | `calculateContextTokens(usage)` — real `totalTokens` | byte/2 estimate of the whole session |
| Overflow recovery + 1 retry, then graceful "switch to a larger model" | native (`_checkCompaction` case 1) | reimplemented (commit `0763d24b`) |
| Model up/down-shift | `sameModel` + `this.model.contextWindow` | "model-aware pre-run detector" |
| Post-compaction staleness guard | native | reimplemented |

Our layer is a duplicate on **worse inputs**, and its estimate gate runs in the
poller **before pi is invoked**, so it *preempts* pi's real-count check. That is
the root of the tester's false `session_reset_required` (session was ~167k real /
1M, estimated at ~4.8M because of base64 images). The image fix (`af5186b6`)
stopped the acute bleeding; this removes the whole failure class.

## De-risked facts (verified 2026-07-12)

- **pi compaction is already enabled.** `DEFAULT_COMPACTION_SETTINGS.enabled=true`;
  we set `reserveTokens = contextWindow - floor(contextWindow*0.7)` (30% reserve) →
  pi compacts at ~70% usage, our intended threshold. We only suppress pi's
  *post-run* path (`suppressPiPostRunAutoCompaction`) and keep its pre-prompt check.
- **Overflow detection reaches pi through our proxy.** Our
  `CONTEXT_OVERFLOW_PATTERNS` is a near-verbatim fork of pi's `OVERFLOW_PATTERNS`
  and works in production → the proxy passes upstream overflow text in the exact
  form pi's native `isContextOverflow` matches. pi also has a `usage.input >
  contextWindow` fallback for silent-overflow providers. (We carry one extra
  pattern, `/input is too long for requested model/i`, worth upstreaming.)
- **Resume does not depend on our compaction boundaries.** `ts-runner.ts` has zero
  references to `compaction_boundary` / `harness_auto_compaction` — resume is
  harness-session + history based.
- **Blast radius is contained.** The custom layer is imported only by
  `claimed-input-executor.ts` and `app.ts`.

## CRITICAL: pi auto-compaction does NOT fire in our per-turn model — drive it explicitly

Live-driving a real **856k/1M (81.6%)** text+image session via `hola` revealed pi's
**auto-compaction never fired** despite correct config. Root cause: pi runs
`_checkCompaction` inside `_processAgentEvent`, dispatched on a **detached,
un-awaited promise queue** (`_agentEventQueue`, `.catch(()=>{})`). Our runtime
spawns `run-pi` **per turn** and `process.exit()`s right after `sendUserMessage`
resolves — the queued post-turn compaction (itself a summarization model call)
never runs. This is *why the original async layer existed*: it drove pi's
compaction algorithm deterministically from the persistent api-server.

**SDK-preferred fix (implemented in `pi.ts`):** don't rely on the fire-and-forget
path. After the turn settles, call pi's public **`session.compact()`** explicitly,
gated on pi's own real-count `getContextUsage()` vs. our `shouldCompact` threshold
(`tokens > contextWindow - reserveTokens`). `maybeCompactSessionOverThreshold()`
runs on success before `runPi` returns, so the compacted branch persists before the
per-turn process exits. Best-effort (a compaction failure never fails the turn).

**Verified live:** 856k session → `compact()` fires (`compaction_start/end`), writes
a `CompactionEntry` (`tokensBefore: 856305`, structured summary covering the text
chunks *and* the 3 screenshots), next turn resumes at **231k (~22%)** and the agent
still answers correctly from the summary. This is the exact image-heavy failure mode
that broke the old byte-estimate gate — now handled on pi's real token counts.

## What we lose

Only **latency placement**: pi's compaction is a synchronous summarization call.
Chosen default — **un-suppress pi's post-run compaction** so it fires at end-of-turn
AND recovers overflow *in-turn* (user never sees the error). Only triggers near the
70% threshold (rare). Alternative (keep post-run suppressed, lean on pi's pre-prompt
check) moves the pause to next-turn-start but degrades overflow UX; not chosen.

## Changes (sequenced)

1. **`runtime/harness-host/src/pi.ts`** — remove `suppressPiPostRunAutoCompaction`
   (call at ~3311 + fn 3279-3298) and the custom snapshot post-run compaction driver
   (`suppressSnapshotCompactionContinuation` ~1309, `_checkCompaction` snapshot path
   ~1326-1336) if part of the async layer. **Keep** `piCompactionReserveTokens` +
   the `SettingsManager` compaction settings (these configure pi native).
2. **`runtime/api-server/src/claimed-input-executor.ts`** — remove the
   `evaluatePreRunSessionCompaction` block (~4560-4690) and both
   `SessionResetRequiredError` throws; remove the forked overflow recovery
   (`CONTEXT_OVERFLOW_PATTERNS`, `isContextOverflowFailurePayload`, recovery+reset
   ~5269-5292); remove post-run checkpoint enqueue. **Keep** per-turn `context_usage`
   capture/persist (still record pi's real usage in `turn_results`).
3. **`runtime/api-server/src/queue-worker.ts`** — remove the
   `waitingForSessionCheckpoint` wait (~417-450) and `SESSION_CHECKPOINT_JOB_TYPE`.
4. **`runtime/api-server/src/app.ts`** — remove the `processSessionCheckpointJob`
   dispatch (~308-309) + import.
5. **`runtime/api-server/src/session-checkpoint.ts`** — delete, except any helpers
   still needed for telemetry (`normalizePiContextUsage`, `PiContextUsage`,
   `effectiveSessionTokens*`) — relocate the minimal keep-set into a small
   `context-usage.ts` if the executor still uses them.
6. **Tests** — delete `session-checkpoint.test.ts` / `session-checkpoint-retry.test.ts`;
   drop compaction-gate/overflow-recovery cases from `claimed-input-executor.test.ts`;
   add a test that a `SessionResetRequiredError` is no longer thrown from an
   image-heavy session.
7. **state-store** — leave `post_run_jobs` schema (used by other job types) but stop
   enqueuing checkpoints. Leave `turn_results.context_budget_decisions` column;
   just stop writing `pre_run_compaction`.

## Verification

- `typecheck` + `test` (api-server, harness-host, state-store).
- **Live (hola/desktop):** run a session past 70% usage → confirm pi emits
  `auto_compaction_start/end` and the next turn succeeds with no
  `session_reset_required`.
- **Resume:** resume a natively-compacted session → history intact, no re-compaction
  loop.
- **Overflow (optional):** force an overflow → confirm pi compact+retry in-turn.

## Rollout

Reviewable branch / PR off `release/2026.706` — **not** a direct merge (large
behavioral change). Ship behind a quick tester smoke on a long session.
