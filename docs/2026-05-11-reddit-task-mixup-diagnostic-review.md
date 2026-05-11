# Reddit Task Mix-Up and Context Overflow Diagnostic Review

Date: 2026-05-11

Reviewed bundle:

- `~/Desktop/holaboss-diagnostics-reddit-2026-05-10T17-05-04Z.zip`

Primary workspace in bundle:

- Workspace id: `aa6359b2-bf27-4d5c-abc1-3da7c842f811`
- Workspace name: `Reddit 内容撰写`
- Main desktop binding: `workspace-main -> 2c6c4eab-6283-4af8-9765-3ba2fcbd289c`

## Scope

This review covers two user-reported symptoms:

1. Task mixing on May 10, 2026
2. A later `context_length_exceeded` error shown in the desktop UI

The findings below distinguish between:

- what is directly proven by the exported bundle
- what is strongly implied by the bundle plus code
- what remains unconfirmed because the exact failed turn was not persisted in this export

## Executive Summary

The bundle shows two different problems.

First, fresh-task intent is not a hard routing boundary for normal user turns. On May 10, the user explicitly asked for a fresh subagent task, but the live main session continued answering from prior session context until the user repeated the reset more forcefully. The actual fresh child session only started on the second reset.

Second, the long-lived main session was already very large and session checkpoints were not reducing it. The runtime repeatedly decided that a checkpoint should run, queued it, and then the compaction path recorded `not_compacted` with reason `not_needed`. That left the main session growing across many turns. A session that survives under the `gpt-5.4` Codex budget can still later fail under `gpt-5.5` if the effective context window is smaller.

The bundle does show the follow-up branching path being used for a later background update, but that path did not apply to the problematic fresh-task user turns. It also reanchors the generated assistant message back onto the live session after generation, so it does not by itself create a durable semantic separation.

## Timeline

All timestamps below are UTC as stored in the bundle.

### Main session before the reset request

- `2026-05-10T11:35:29Z`
  User asks: `去看Ling的背景信息，拆分Ling的卖点，列出来给我`
- `2026-05-10T11:53:26Z`
  User asks why `ring` and `ling` were mixed.
- `2026-05-10T11:54:24Z`
  User asks: `按 Ling-2.6-1T 重写`
- `2026-05-10T11:59:20Z`
  User clarifies that they wanted the value points re-split, not direct writing.
- `2026-05-10T12:10:33Z`
  User explicitly says this is a new task and locks the source to `campaigns/ling-2.6-1t/...`
- `2026-05-10T12:18:14Z`
  User gives the large 8-value-point Reddit post task.

### Fresh-task request that did not create a fresh child run

- `2026-05-10T12:20:36Z`
  User says: `全新任务，新开一个sub agent来做`
- `2026-05-10T12:23:48Z`
  User repeats the same request, more explicitly, for a fully new post-writing task.
- `2026-05-10T12:26:13Z`
  Assistant replies by pointing to an existing May 9 artifact:
  `campaigns/ling-2.6-1t/drafts/posts/2026-05-09_ling-2.6-1t-open-source-reddit-launch-posts-10.md`

This is the clearest persisted example of the task-mix behavior. The user asked for a fresh subagent task, but the system still answered from the existing main-session thread and reused prior deliverables.

### Second reset request that did create a fresh child run

- `2026-05-10T12:35:34Z`
  User says: `我让你重新跑一遍任务，这是一个全新的任务`
- `2026-05-10T12:36:31Z`
  New child session starts:
  `subagent-0b0bb1b9-24d4-45fb-b9bd-5f92a1655560`
- `2026-05-10T12:52:49Z`
  Subagent completes and writes report artifacts.
- `2026-05-10T12:52:54Z`
  Main session receives a `[Holaboss Main Session Event Batch v1]` follow-up input summarizing the completed background work.

## Diagnosed Issues

### 1. Fresh-task user intent is not a hard routing boundary

Status: proven

The workspace routes primary chat through a single desktop `workspace-main` binding. The preferred session selection logic in `runtime/api-server/src/app.ts` first checks the active `desktop/workspace-main` binding and reuses it when present.

Relevant code:

- `runtime/api-server/src/app.ts:1321-1363`
- `runtime/api-server/src/app.ts:1614-1623`

Impact:

- A user message like `全新任务`, `重新跑一遍`, or `新开一个sub agent来做` does not itself force a new session or a new branch.
- The message still runs in the live main session unless the model chooses to delegate.

Observed evidence:

- On `2026-05-10T12:23:48Z`, the user explicitly requested a fresh subagent task.
- The next assistant reply at `2026-05-10T12:26:13Z` still answered from old context and reused a prior artifact instead of creating a fresh child run.

### 2. Subagent creation depends on model behavior, not on an enforced product boundary

Status: proven

The actual child session creation path lives in `runtime/api-server/src/runtime-agent-tools.ts`. A fresh delegated task only exists if the model invokes that runtime tool path and a new child session id `subagent-...` is created.

Relevant code:

- `runtime/api-server/src/runtime-agent-tools.ts:1732-1805`

Impact:

- The product currently treats delegation as a model decision rather than a guaranteed routing behavior when the user declares a fresh task boundary.
- If the model decides to continue the current thread instead of delegating, the user's task boundary is ignored.

Observed evidence:

- The real child session did not start until `2026-05-10T12:36:31Z`, after the second reset request.

### 3. The main session was already very large on May 10

Status: proven

The `turn_results` table shows that the same main session `2c6c4eab-...` was operating with very high recorded context usage throughout the May 10 sequence.

Observed context usage from `turn_results.context_budget_decisions`:

- `2026-05-10T11:35:29Z`: `760,370 / 1,000,000`
- `2026-05-10T12:10:33Z`: `792,508 / 1,000,000`
- `2026-05-10T12:23:50Z`: `807,941 / 1,000,000`
- `2026-05-10T12:35:34Z`: `815,369 / 1,000,000`
- `2026-05-10T12:52:54Z`: `822,052 / 1,000,000`

Impact:

- Even when the session still fits under the current model budget, it is already in a fragile range.
- Any later provider/model path with a smaller true context window can fail.


### 7. Even when follow-up branching is used, the generated assistant message is reanchored back into the live session

Status: proven

For `main_session_event_batch` follow-ups, execution runs from a snapshot/ephemeral branch, but on successful completion the assistant message is appended back onto the live session leaf and the binding can be updated.

Relevant code:

- Snapshot follow-up run metadata: `runtime/api-server/src/claimed-input-executor.ts:3485-3491`
- Event sanitation during ephemeral execution: `runtime/api-server/src/claimed-input-executor.ts:3750-3814`
- Reanchor into live session: `runtime/api-server/src/claimed-input-executor.ts:4270-4318`

Impact:

- The feature reduces interference during the synthetic follow-up generation itself.
- It does not create a durable semantic separation afterward.
- The main session still accumulates the generated assistant continuations.

### 9. This continuity load likely amplifies task mixing

Status: strongly implied

The event-batch prompts explicitly instruct the model to act as a supplemental continuation rather than a fresh answer. That is appropriate for a follow-up update, but it reinforces the notion that the same live main session is one continuous conversation.

Relevant code:

- `runtime/api-server/src/main-session-event-worker.ts:89-103`

Impact:

- If the same session is later reused for unrelated or "fresh" user turns, the model is operating inside a conversation history that has already been shaped as one long continuous thread.
- This does not prove the exact May 10 mix-up by itself, but it is consistent with it.

### 10. A model-window mismatch can explain why a session that survives under `gpt-5.4` later fails under `gpt-5.5`

Status: strongly implied

In Codex responses routing, the known budgets differ by model:

- `gpt-5.4`: `1,000,000`
- `gpt-5.5`: `400,000`

Relevant code:

- `runtime/harnesses/src/model-routing.ts:389-400`

Impact:

- A session that remains below `gpt-5.4`'s effective limit can still exceed the limit if reused under `gpt-5.5`.
- That aligns with the screenshoted error text, which explicitly mentions `openai_codex/gpt-5.5`.

## What the Bundle Proves About the May 10 Mix-Up

The strongest proven behavioral sequence is:

1. User explicitly asks for a fresh subagent task
2. System continues in the same live main session anyway
3. Assistant reuses prior task artifacts instead of creating a new child run
4. User repeats the reset more forcefully
5. Only then does a true child session start

That is enough to say that the product did not reliably honor fresh-task intent on the first request.

## What the Bundle Proves About Context Management

The strongest proven context-management sequence is:

1. Main session context usage repeatedly exceeded the checkpoint threshold
2. A checkpoint job was queued after each large turn
3. Every checkpoint returned `not_compacted / not_needed`
4. Main session context usage continued rising turn after turn

That is enough to say that the checkpoint path was not giving the main session any effective size relief in this workspace during this period.

## Open Questions

These questions remain open because the exact failing UI turn is not in the export:

1. Was the screenshoted `gpt-5.5` failure in this same session, or in a later attempt after the export snapshot?
2. Did the failure happen on a UI/host-side path that never committed a normal turn record?
3. Was the screenshoted run using the same bundle workspace, or another workspace/session not exported here?

## Bottom Line

The bundle supports the following conclusions:

1. There is a real task-boundary bug.
   A user-declared fresh task is not guaranteed to route to a fresh child context.

2. There is a real context-management bug.
   The main session checkpoint path is being triggered but is not compacting the session in practice.

3. Follow-up branching exists and was used here, but it is not the mechanism that protects ordinary fresh-task user turns.

4. Even when follow-up branching is used, it still writes the generated assistant continuation back into the live session afterward, so it does not solve semantic carryover by itself.
