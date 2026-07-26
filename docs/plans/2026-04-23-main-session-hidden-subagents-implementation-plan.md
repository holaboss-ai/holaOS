# Main Session + Hidden Subagents — Implementation Plan

## Goal

Move each workspace to a single user-facing `main session` per conversation surface while allowing the agent to keep long-running or parallelizable work going in the background via hidden subagents.

The user should feel like they are talking to one persistent workspace agent, not switching between multiple worker chats or internal task threads.

The main session should remain conversational and chat-like, while subagents act as task executors behind the scenes.

This interaction model should make the product feel like the user is interacting with one consistent person-like counterpart, similar to working with a trusted employee or teammate, rather than juggling multiple worker threads or agent identities.

## Decision Summary

### Chosen direction

- Keep exactly one user-facing `main session` per workspace conversation surface.
- Let the main session either handle work inline or delegate it to hidden subagents.
- Implement subagents first as an internal runtime primitive.
- Build the user-facing background-work UX on top of that substrate.
- Share task, memory, and background-work state at workspace scope, even when the workspace later has multiple channel-specific main sessions.
- Represent channel-local main sessions through `conversation_bindings` rather than a single `workspace.main_session_id`.

### Explicit non-goals for the first pass

- Do not build user-visible child chat threads.
- Do not expose subagent sessions in the normal session picker.
- Do not tackle proactive follow-ups in this phase.
- Do not force every task into background execution; inline handling remains valid.

---

## Core Principles

- The `main session` is the only session the user chats with directly.
- The `main session` owns conversation, clarification, tone, and user relationship.
- Subagents are execution workers, not conversation peers.
- Subagents are task executors, not user-facing chat participants.
- The main session remains the only voice speaking to the user.
- The user never interacts with a background task directly; all user input flows through the main session.
- Inline execution remains the default for quick work.
- Background execution is an escalation path for longer, blocking, or parallelizable work.
- Child results route back into the main session as structured updates.
- Workspace state is shared across channel-specific main sessions; transcripts and transport metadata remain session-local.

---

## Desired User Experience

### Main chat behavior

- The user opens a workspace and sees one main chat.
- The user can continue chatting even while background work is running.
- The main session should continue to feel like a normal conversation, not a task dashboard pretending to be a chat.
- The main session can answer small requests immediately without creating visible background tasks.
- The main session is responsible for clarifying intent, handling conversational follow-ups, and responding to new unrelated requests while subagents continue executing older work.
- When the main session delegates work, it gives a concise status update in the same chat.
- After delegating normal background work, the main session should not synchronously wait for the child result in the same turn.
- Fast-path exception: if the delegated task finishes within roughly 1-2 seconds during the same conversational turn, the main session may collapse delegation plus result into one reply instead of forcing a separate acknowledgement and follow-up.
- When the main session needs task status, it should inspect persisted task state rather than using a blocking wait primitive.
- When background work finishes, blocks, or fails, the main session posts a compact update in the same chat.

### Background work behavior

- Background work appears as `tasks`, not `sessions`.
- A task can be `queued`, `running`, `waiting_on_user`, `completed`, `failed`, or `cancelled`.
- Background task state may be visible, but it is not a conversational or interactive surface.
- If a task needs cancellation, retry, or clarification, the user still asks the main session to do that.
- Subagents never speak directly to the user in first person.
- Subagents do not own conversational turns; they return execution state and results to the main session.

### Inline versus background behavior

- Quick lookups, short CLI checks, and tightly interactive work stay inline.
- Longer or multi-step tasks move to background work.
- Work can begin inline and later escalate into background execution if it grows in scope or duration.

First-pass escalation rule:

- keep work inline when it is short read/edit/reasoning work and likely to complete quickly
- delegate to a subagent when the task needs `browser`, `bash`, multiple independent subtasks, or is likely to take longer than a brief moment
- the main session may start inline and hand off later if scope expands

---

## Why Subagents First

The runtime already supports parallel work across different session ids, but not multiple simultaneous runs inside one session.

That means:

- one session can only have one active run at a time
- true background work already maps naturally to separate hidden child sessions
- the main chat can only remain free if delegated work runs outside the main session

So the first implementation step should be the hidden subagent substrate, not the final UX shell.

---

## Current State

### Useful building blocks that already exist

- The runtime queue already processes work in parallel across distinct sessions.
- Sessions already support `parent_session_id`.
- The runtime already persists `turn_results` for completed child work.
- The current `task_proposal` accept flow already proves that scoped child work can be created and queued, even though proposal state and execution state are still conflated.

### Gaps relative to the target model

- The desktop still exposes a flat session list.
- Child sessions are still modeled as normal sessions from the UI perspective.
- There is no general agent-callable `delegate_task` / `wait` / `cancel` surface.
- There is no normalized parent-facing child result record.
- Tool and model scoping are not yet child-specific.
- Browser tool access is still tied to `workspace_session` instead of the delegated task capability profile.
- The main chat does not yet act as the single feed for background updates.

---

## Target Architecture

## 1. Main Session Model

Each workspace has one canonical user-facing `main session` per conversation surface, backed by shared workspace state.

Desired contract:

- one visible `main session` per workspace surface such as desktop or a future external channel
- this is the default chat surface when the workspace opens
- the user does not need to choose among multiple task-specific sessions
- each main session acts as the conversational orchestrator for workspace work from that surface
- different main sessions on the same workspace should still feel like the same counterpart because they share the same workspace state

Behavioral contract:

- the main session keeps a natural conversational tone
- the main session handles clarification, planning, and user-visible updates
- the main session can continue chatting while delegated work runs elsewhere
- delegated work should not force the main session into a non-conversational execution state
- the main session is the only place where the user can answer questions, request retries, or redirect work
- any main session on the same workspace can inspect and act on shared task state

Shared-state contract:

- memory, preferences, open loops, task proposals, subagent runs, blocker state, artifacts, and integration/auth state are workspace-scoped
- message ids, thread ids, read state, and channel-specific formatting are main-session-local
- every `subagent_run` stores immutable `origin_main_session_id` provenance plus mutable `owner_main_session_id` delivery ownership
- automatic task updates should route to `owner_main_session_id`
- if another main session asks about, cancels, retries, or answers a blocker for a task, ownership transfers to that main session
- when ownership transfers, any queued unsent background updates move to the new owner
- if a task is already `waiting_on_user`, the blocker should be re-asked from the new owner only when that session reaches a natural pause

Prompt contract:

- the `main session` should use a distinct prompt optimized for conversation, orchestration, clarification, and translating task outcomes back to the user
- subagents should use a distinct prompt optimized for execution, scoped task completion, artifact production, and structured result return
- do not rely on a single executor-oriented base prompt plus light session-kind branches as the long-term design
- the current prompt shape is closer to a task-executor prompt than a main-session conversational prompt

Persistence shape:

- introduce `conversation_bindings` as the canonical mapping from a workspace conversation surface to its front-of-house `main session`
- each binding should point at exactly one `session_id`
- multiple bindings on the same workspace may point at different channel-local main sessions while still sharing workspace-scoped state
- do not overload the existing harness/session binding table for this; user-facing conversation bindings are a separate concept from runtime harness bindings

Recommended `conversation_bindings` fields:

- `id`
- `workspace_id`
- `channel`
- `conversation_key`
- `session_id`
- `role`
- `is_active`
- `metadata`
- `last_active_at`
- timestamps

Recommended usage:

- desktop workspace chat gets a `conversation_binding` with `channel=desktop`
- future external channels such as Telegram get their own bindings and their own `session_id`
- `conversation_key` should be a required channel-local identifier, not nullable; for desktop it can be a synthetic stable key such as `workspace-main`
- for external channels, `conversation_key` can mirror the chat/thread/conversation id from that provider
- `role=main` identifies the binding as the user-facing orchestrator conversation for that surface
- subagent routing should use `origin_main_session_id` and `owner_main_session_id` on the run record, while bindings answer how channel-local conversations map into those sessions

Recommended constraints and indexes:

- `PRIMARY KEY (id)`
- `UNIQUE (workspace_id, channel, conversation_key, role)`
- `UNIQUE (session_id)` for main bindings in the first pass
- index on `(workspace_id, role, is_active, updated_at DESC)`
- index on `(channel, conversation_key, is_active)`

Recommended runtime rule:

- keep `agent_sessions.kind` broad for front-of-house conversations in the first pass
- let `conversation_bindings` decide which session is the user-facing main session for a given surface
- add `kind=subagent` for hidden task executors rather than introducing a second special main-session session kind immediately

## 2. Hidden Subagent Runtime Substrate

Add first-class hidden delegated work using child sessions plus a normalized run record.

Behavioral role:

- subagents execute bounded tasks
- subagents gather results, produce artifacts, and surface blockers
- subagents do not manage the user relationship directly
- subagents hand control and communication back to the main session
- subagents should own execution-heavy browser work when a delegated task requires browser automation

Recommended runtime surface:

- `delegate_task`
- `get_subagent`
- `list_background_tasks`
- `cancel_subagent`
- `resume_subagent`

Important orchestration rule:

- the main session should never call `wait_subagents`
- delegation should return control to the conversation promptly
- status checks should read persisted run state through `get_subagent` or `list_background_tasks`

Recommended `delegate_task` shape:

```json
{
  "tasks": [
    {
      "title": "Research competitors",
      "goal": "Find the top competing proactive agent products this week",
      "context": "Focus on Product Hunt, HN, and GitHub",
      "tools": ["web"],
      "model": "openai/gpt-5.4"
    }
  ]
}
```

Singleton shorthand can be supported, but `tasks[]` should be the canonical internal shape.

## 2a. Prompt Split

The runtime should separate prompt roles instead of treating main sessions and subagents as the same agent with minor session-kind variations.

Recommended split:

- `main session prompt`
  - optimized for natural conversation
  - handles clarification, delegation, ownership transfer, and lifecycle-update phrasing
  - prefers staying chat-like, concise, and user-facing
  - knows that background workers exist but does not speak like one
- `subagent prompt`
  - optimized for execution
  - stays tightly scoped to the delegated task
  - produces structured results, blocker payloads, milestone updates, and deliverables
  - does not manage the user relationship directly

Recommended implementation direction:

- keep shared prompt-building primitives where useful
- but compose different top-level prompt policies for `main session` versus `subagent`
- treat `task_proposal` and future `subagent` execution prompts as executor-facing, not as the basis for the main-session prompt

## 3. Task Proposal Mapping

`task proposal` should remain a suggestion or intent object, not become the execution primitive itself.

Recommended distinction:

- `task proposal` answers: should this work be started?
- `subagent run` answers: what is the lifecycle and result of the work that is now executing?

Recommended proposal states:

- `pending`
- `accepted`
- `dismissed`
- `expired`

Recommended execution states:

- `queued`
- `running`
- `waiting_on_user`
- `completed`
- `failed`
- `cancelled`

Recommended behavior on proposal accept:

1. keep the proposal record for provenance and UX
2. create a `subagent_run` linked to the accepted proposal
3. create a hidden child session with kind `subagent`
4. enqueue the delegated work on that child session
5. route status and completion updates back into the main chat

Recommended behavior on proposal dismiss:

- keep the proposal as dismissed
- do not create a `subagent_run`
- do not create a child execution session

Target design rule:

- accepted proposals should usually become background work
- proposal acceptance should not open a separate child conversation
- proposal provenance should be preserved, but execution should happen through the normal hidden-subagent path

Important implementation note:

- keep `task_proposal` as the source/origin object
- accepted proposals should execute through hidden `subagent` sessions plus `subagent_runs`
- proposal acceptance should record `proposal_id` provenance on the spawned subagent run

## 4. Cronjob Mapping

Cronjobs should follow the same single-main-session interaction model.

Recommended distinction:

- the scheduler decides when work should fire
- hidden execution units do the work
- the main session remains the only user-facing voice

### Notification-style cronjobs

Notification-style cronjobs are for lightweight reminders, nudges, or status surfacing where the primary outcome is a short user-visible message rather than a larger execution task.

Recommended behavior:

- the scheduler should emit a structured cron-notification event
- that event should target the main-session surface for delivery
- the final user-visible phrasing should appear in the main session voice
- the user should not receive a separate cronjob conversation or background-task interaction surface

Preferred implementation:

- do not open a dedicated cronjob chat session
- do not require the user to click into a cronjob run to understand the reminder
- keep the notification payload structured so the main-session layer can phrase it consistently

Implementation note:

- notification-style cronjobs should always use the lightweight template/event path
- they should not consume a full main-session model turn

### Task-execution cronjobs

Task-execution cronjobs are for scheduled agent work such as monitoring, analysis, browsing, synchronization, or writing.

Recommended behavior:

- when due, the cronjob should spawn a hidden background `subagent_run`
- that run should carry `source=cronjob` provenance
- execution should not occur in a separate user-facing cronjob chat
- lifecycle outcomes should be routed back through the main session
- lifecycle outcomes should be delivered through a real main-session model turn

Recommended user-facing behavior:

- started: the main session can surface a compact status update when useful
- blocked: the main session asks the user in chat if input is needed
- completed: the main session summarizes the result in chat
- failed: the main session explains the failure in chat

Target design rule:

- `system_notification` cronjobs should surface as main-session notifications
- `session_run` cronjobs should become hidden background execution, not a separate chat surface
- both delivery styles should preserve one consistent conversational relationship with the user

Why this matters:

- it keeps scheduled work aligned with the same UX model as delegated task execution
- it avoids teaching users two different interaction patterns
- it preserves one consistent counterpart identity, because scheduled work, delegated work, and conversational replies all flow through the same main-session voice

## 5. Child Session and Result Model

Introduce a first-class hidden `subagent` session kind plus a durable parent-facing run record.

Recommended records:

- child session record in `agent_sessions`
- `subagent_runs` table for lifecycle and parent-facing result state

Recommended `subagent_runs` fields:

- `subagent_id`
- `workspace_id`
- `parent_session_id`
- `parent_input_id`
- `origin_main_session_id`
- `owner_main_session_id`
- `child_session_id`
- `initial_child_input_id`
- `current_child_input_id`
- `latest_child_input_id`
- `title`
- `goal`
- `context`
- `source_type`
- `source_id`
- `proposal_id`
- `cronjob_id`
- `retry_of_subagent_id`
- `tool_profile`
- `requested_model`
- `effective_model`
- `status`
- `summary`
- `latest_progress_payload`
- `blocking_payload`
- `result_payload`
- `error_payload`
- `last_event_at`
- `owner_transferred_at`
- timestamps for create/start/complete/update/cancel

Why the input fields are split:

- a subagent run may be resumed after `waiting_on_user`
- that means one logical run can span multiple child inputs over the same hidden child session
- `initial_child_input_id` captures the original spawn
- `current_child_input_id` points at the active queued/running child input, if any
- `latest_child_input_id` points at the newest child input associated with the run

Recommended constraints and indexes:

- `PRIMARY KEY (subagent_id)`
- `UNIQUE (workspace_id, child_session_id)` in the first pass if each hidden child session owns exactly one logical run
- optional `UNIQUE (proposal_id)` when a proposal can only spawn one active run
- index on `(workspace_id, status, updated_at DESC)`
- index on `(owner_main_session_id, status, updated_at DESC)`
- index on `(origin_main_session_id, created_at DESC)`
- index on `(retry_of_subagent_id, created_at DESC)`

Structured result contract:

- `completed` runs should return a full structured result payload
- `waiting_on_user` runs should return a blocker payload
- `failed` and `cancelled` runs only need minimal terminal metadata, with optional partial summaries or deliverables if they exist
- successful result payloads should include a concise summary plus any relevant final deliverables that the main session may forward
- deliverables should be first-class objects rather than buried inside transcript text

Recommended payload shape:

- `status`
- `goal`
- `summary`
- `key_findings`
- `blocking_question`
- `error`
- `artifacts`
- `forwardable_deliverables`

Recommended `forwardable_deliverables` fields:

- `type`
- `title`
- `uri` or file reference
- `mime_type`
- `description`
- `safe_to_forward`
- optional `suggested_intro`

Important distinction:

- `turn_results` remain the raw per-input execution record
- `subagent_runs` become the normalized parent-consumable delegation record
- raw child transcripts and tool traces remain on the hidden child session for debug and DB inspection, but should not be part of normal user interaction

Recommended runtime behavior:

- a resumed blocked run should append a new child input on the same hidden child session and update `current_child_input_id` plus `latest_child_input_id`
- retries should create a new `subagent_run` and usually a new hidden child session, linked by `retry_of_subagent_id`
- `source_type` should distinguish direct delegation, accepted proposal, cronjob, and future system-created work

## 6. Tool and Model Scoping

Main sessions need a much narrower capability profile than subagents.

Required behavior:

- the `main session` should keep a curated front-of-house tool belt:
  - `delegate_task`
  - `get_subagent`
  - `list_background_tasks`
  - `cancel_subagent`
  - `resume_subagent`
  - `read`
  - `edit`
  - `grep`
  - `glob`
  - `list`
- the `main session` should not get broad execution tools such as general `bash` or broad browser automation in the first pass
- the `main session` should not receive `web_search`; public-web research should route through delegated subagents
- subagents should get the full execution tool surface, including browser and heavier integration/action tools
- subagents should not receive orchestration tools, so only the `main session` can spawn or manage child work
- per-task model overrides should be allowed

Important policy:

- browser access should no longer be inferred purely from session kind
- subagents should be browser-eligible execution workers
- the `main session` should not need broad browser tools by default just to support delegated browser work
- if `delegate_task(... tools=[...])` remains in the API, treat it as intent or future narrowing metadata rather than the first-pass enforcement mechanism

Recommended model precedence:

1. per-task `model`
2. dedicated subagent provider/model setting in model-provider settings UI
3. parent selected model fallback

Provider settings decision:

- the product should expose an additional provider/model setting specifically for subagents
- this setting should be separate from the main session's chat model selection
- subagent runs should resolve their model/provider from that dedicated subagent setting unless a per-task override is supplied
- queued main-session follow-up turns should continue to use the owner main session's own model selection path, not the subagent setting
- queued main-session follow-up turns should use the owner main session's current explicit chat model and thinking selection when available
- if the owner main session has no explicit selection, queued follow-up turns should fall back to the workspace/runtime default chat model path

## 7. Parent-Visible Event Routing

Child work should report back into the main session as structured updates, not separate chats.

Recommended event types:

- `delegation_progress`
- `delegation_waiting_on_user`
- `delegation_completed`
- `delegation_failed`
- `delegation_cancelled`

Delivery contract:

- subagent lifecycle updates should enqueue a real model turn on `owner_main_session_id`, not a fixed template reply
- the main session should receive a structured summary/result payload, not the raw child transcript
- the main session may forward relevant final deliverables when useful
- user-authored turns always preempt queued background-event turns

Progress contract:

- phase 1 now suppresses user-facing progress updates entirely
- subagent progress may still exist internally for debugging or future use, but it should not generate conversational updates or task-card copy in the main session UX

Important UX rule:

- raw child execution logs should not replace the main session’s conversational voice
- the main session should translate child outcomes into concise, natural chat updates
- if a child is blocked on user input, the main session should ask that question in chat rather than exposing the child as an interactive surface

Waiting-on-user contract:

- when a subagent blocks, it moves to first-class `waiting_on_user`
- blocked subagents stop progressing until resumed
- blocker events for the same owner should be coalesced over a short window and surfaced as one main-session message when possible
- combined blocker messages should explicitly separate questions, for example with numbered items
- underlying blockers remain separate even when phrased together
- when the user replies, the main session should do best-effort high-confidence matching against waiting subagents
- matched blockers resume the same paused `subagent_run`, not a new run
- unmatched blockers remain in `waiting_on_user`
- if no blocker can be matched confidently, the main session should ask a clarification instead of guessing

Completion and failure delivery contract:

- completed and failed events for the same owner should be coalesced over a short window
- if the child result is already available by the time the main session is about to send a normal conversational reply, that result should be folded directly into that same reply
- by default delegated work should still be treated as asynchronous, but if the child result becomes available within roughly 1-2 seconds during the same conversational turn, the main session may still collapse delegation plus result into one reply as a fast-path
- if the user is actively chatting, these updates should wait for a natural pause rather than interrupt
- queued follow-up turns are strictly forbidden from materializing while the originating main-session turn is still active; they may only materialize after that turn has fully finished and the session has reached a real pause
- after a background result completes, it should first wait through a short merge window so the next normal main-session reply can absorb it naturally
- when relevant, the main session should fold queued background updates into its next normal reply, including replies to unrelated conversational questions
- if no new user message arrives before that short merge window expires, the main session should send the queued update on its own after roughly 5 seconds of idle time
- delayed updates should still sound like a normal conversational follow-up, not a system notification
- merged or autonomous background updates are supplement-only: they should never repeat or re-answer a direct conversational reply the main session already gave
- failed or cancelled runs may still surface partial summaries or partial deliverables if useful

## 7a. Queued Main-Session Event Records

Do not enqueue synthetic main-session model turns directly from every subagent event. Persist undelivered user-facing events first, then let a coalescer materialize them into main-session inputs when batching, natural-pause, and idle-timeout rules allow. That coalescer must not materialize a queued follow-up while the originating main-session turn is still active.

Recommended record:

- `main_session_event_queue`

Recommended fields:

- `event_id`
- `workspace_id`
- `owner_main_session_id`
- `origin_main_session_id`
- `subagent_id`
- `event_type`
- `delivery_bucket`
- `status`
- `payload`
- `coalesce_key`
- `earliest_deliver_at`
- `latest_deliver_at`
- `materialized_input_id`
- `superseded_by_event_id`
- `delivered_at`
- `superseded_at`
- timestamps

Field intent:

- `event_type` should capture concrete source events such as `progress`, `waiting_on_user`, `completed`, `failed`, and `cancelled`
- `delivery_bucket` should group delivery behavior such as `waiting_on_user` versus `background_update`
- `status` should distinguish `pending`, `materialized`, `delivered`, and `superseded`
- `payload` stores the structured summary, blocker, or result packet that the main session will read
- `coalesce_key` gives the dispatcher a stable grouping key for batching near-simultaneous events
- `earliest_deliver_at` supports the short coalescing window
- `latest_deliver_at` supports the eventual idle-timeout follow-up behavior
- `materialized_input_id` links the queued event record to the actual `agent_session_inputs` row once a real main-session model turn is created

Recommended constraints and indexes:

- `PRIMARY KEY (event_id)`
- index on `(owner_main_session_id, status, earliest_deliver_at, created_at ASC)`
- index on `(workspace_id, status, created_at ASC)`
- index on `(subagent_id, created_at ASC)`
- index on `(materialized_input_id)`

Recommended runtime behavior:

- new user-authored turns should always win over pending queued background events
- ownership transfer should update `owner_main_session_id` on all undelivered queued events for that task
- batching should happen by reading pending events with the same owner and compatible `delivery_bucket`
- once a batch becomes a real main-session turn, the dispatcher should create one `agent_session_inputs` row and stamp its `input_id` back onto the contributing queued events
- delivered queued events should remain as audit/history rows rather than being deleted immediately

## 7b. `store.ts` Implementation Checklist

Translate the schema sketch into explicit `runtime/state-store/src/store.ts` work so Phase 1 has a clear persistence plan.

### New interfaces and naming

- add `ConversationBindingRecord`
- add `ConversationBindingCreateFields` and `ConversationBindingUpdateFields`
- add `SubagentRunRecord`
- add `SubagentRunCreateFields` and `SubagentRunUpdateFields`
- add `MainSessionEventQueueRecord`
- add `MainSessionEventQueueCreateFields` and `MainSessionEventQueueUpdateFields`
- avoid naming collisions with the existing runtime harness binding type already called `SessionBindingRecord`
- either keep the current harness type name and use `ConversationBindingRecord` for the new table, or rename the current harness type to something more explicit like `AgentRuntimeSessionBindingRecord`

### Table DDL

- add `conversation_bindings` DDL inside the main schema bootstrap next to `agent_sessions` and `agent_runtime_sessions`
- add `subagent_runs` DDL near `turn_results` and other session-execution persistence tables
- add `main_session_event_queue` DDL near `agent_session_inputs` and `runtime_notifications`
- store complex payload fields as JSON text, following existing `turn_results`, `runtime_notifications`, and `memory_entries` patterns
- use text timestamps consistently with the existing store style

### `conversation_bindings` store methods

- `upsertConversationBinding(...)`
- `getConversationBinding({ bindingId })`
- `getConversationBindingByConversation({ workspaceId, channel, conversationKey, role? })`
- `getConversationBindingBySession({ workspaceId, sessionId, role? })`
- `listConversationBindings({ workspaceId, role?, channel?, isActive? })`
- `setConversationBindingActive({ bindingId, isActive })`
- `touchConversationBinding({ bindingId, lastActiveAt? })`
- `transferConversationBindingSession({ bindingId, sessionId })` if needed later

### `subagent_runs` store methods

- `createSubagentRun(...)`
- `updateSubagentRun({ subagentId, fields })`
- `getSubagentRun({ subagentId })`
- `getSubagentRunByChildSession({ workspaceId, childSessionId })`
- `listSubagentRunsByWorkspace({ workspaceId, status?, ownerMainSessionId?, limit?, offset? })`
- `listSubagentRunsByOwner({ ownerMainSessionId, status?, limit?, offset? })`
- `listSubagentRunsByOrigin({ originMainSessionId, status?, limit?, offset? })`
- `listWaitingSubagentRuns({ workspaceId?, ownerMainSessionId? })`
- `listIncompleteSubagentRuns({ workspaceId?, ownerMainSessionId? })`
- `transferSubagentOwnership({ subagentId, ownerMainSessionId, ownerTransferredAt })`
- `appendSubagentProgress(...)` only if you want a helper that updates `latest_progress_payload` plus `last_event_at` together

### `main_session_event_queue` store methods

- `enqueueMainSessionEvent(...)`
- `updateMainSessionEvent({ eventId, fields })`
- `getMainSessionEvent({ eventId })`
- `listPendingMainSessionEvents({ ownerMainSessionId, deliveryBucket?, before?, limit? })`
- `listPendingMainSessionEventsByWorkspace({ workspaceId, before?, limit? })`
- `markMainSessionEventsMaterialized({ eventIds, materializedInputId })`
- `markMainSessionEventsDelivered({ eventIds, deliveredAt })`
- `markMainSessionEventsSuperseded({ eventIds, supersededByEventId?, supersededAt })`
- `transferQueuedMainSessionEvents({ subagentId, ownerMainSessionId })`
- `deleteMainSessionEventsForTests(...)` if existing test helpers expect cleanup helpers

### Schema migration hooks

- add `ensureConversationBindingsTableSchema(db)`
- add `ensureSubagentRunsTableSchema(db)`
- add `ensureMainSessionEventQueueTableSchema(db)`
- call them from the constructor/bootstrap path alongside other `ensure*Schema` helpers
- for the first pass, prefer additive migrations over rebuilds unless a table needs a shape reset
- if you rename the current `SessionBindingRecord` type, keep the underlying `agent_runtime_sessions` table stable and only change TypeScript names first

### Row conversion and JSON parsing

- add `rowToConversationBinding(...)`
- add `rowToSubagentRun(...)`
- add `rowToMainSessionEventQueue(...)`
- parse `metadata`, `tool_profile`, `latest_progress_payload`, `blocking_payload`, `result_payload`, `error_payload`, and queue `payload` through the same defensive JSON parsing style already used elsewhere in `store.ts`
- normalize nullable text fields consistently with the existing helper methods

### Ownership and resume helpers

- add a transaction helper for ownership transfer that updates both `subagent_runs.owner_main_session_id` and all undelivered `main_session_event_queue.owner_main_session_id` rows together
- add a transaction helper for blocked-run resume that updates `current_child_input_id`, `latest_child_input_id`, status, and `last_event_at` together
- add a transaction helper for retry creation that creates a new run linked by `retry_of_subagent_id`

### Query/index expectations

- optimize for the reads the runtime will do most:
- find the main session binding for a channel conversation
- list running/waiting tasks for a workspace
- list pending queued events for one owner session
- transfer queued events on ownership change
- resolve a run from a hidden child session
- verify indexes with those exact queries rather than only by schema symmetry

### Test coverage in `store.test.ts`

- create and look up a desktop `conversation_binding`
- create separate bindings for the same workspace across different channels
- create a `subagent_run`, update status, and fetch by owner and by child session
- resume a blocked run by changing `current_child_input_id` and `latest_child_input_id`
- transfer ownership and confirm queued events move with it
- enqueue multiple pending main-session events and mark them materialized/delivered/superseded
- ensure JSON payload round-tripping for result payloads, blocker payloads, deliverables, and queue payloads

## 7c. Runtime API and Executor Checklist

Wire the Phase 1 substrate through the existing runtime tool stack end to end: tool manifest, schema, capability client, API routes, service methods, runner policy, and executor writeback.

### Agent-facing runtime tools

Add main-session orchestration tools to the runtime tool manifest in `runtime/harnesses/src/runtime-agent-tools.ts`.

Recommended tool ids:

- `holaboss_delegate_task`
- `holaboss_get_subagent`
- `holaboss_list_background_tasks`
- `holaboss_cancel_subagent`
- `holaboss_resume_subagent`

Why `resume_subagent` is required:

- the agreed UX is that user answers to a blocker resume the same paused run
- the main session needs a first-class runtime action for that, not a fresh `delegate_task`

Recommended first-pass inspection APIs:

- keep `listSubagentRuns` and `getSubagentRun` as normal app/server APIs for the desktop `Background Tasks` panel
- also expose corresponding main-session runtime inspection tools as `list_background_tasks` and `get_subagent`
- those inspection tools should read persisted run state only; they should not block waiting for a child run to change
- `list_background_tasks` should return a compact card-oriented view suitable for quick status checks:
  - `subagent_id`
  - `title`
  - `status`
  - `summary`
  - `latest_progress_summary`
  - `blocking_question`
  - `updated_at`
  - `created_at`
  - `owner_main_session_id`
  - `source_type`
  - `deliverable_count`
  - optional `has_partial_results`
- `get_subagent` should return a richer structured detail view:
  - the compact fields above
  - `goal`
  - `context`
  - `result_summary`
  - `result_payload`
  - `partial_deliverables`
  - `final_deliverables`
  - `error_payload`
  - `latest_progress_payload`
  - `proposal_id`
  - `cronjob_id`
  - `retry_of_subagent_id`
  - `child_session_id` for debug/inspection only
- neither inspection path should return raw child transcript by default; raw transcript remains DB/debug-only

### Tool schemas and prompt guidance

In `runtime/harnesses/src/runtime-capability-tools.ts`:

- add JSON schemas for the five new runtime tools
- keep `delegate_task` canonical on `tasks[]`
- support singleton sugar at the schema/normalization layer:
  - `goal`
  - `title`
  - `context`
  - `tools`
  - `model`
- make `get_subagent` require:
  - `subagent_id`
- make `list_background_tasks` accept:
  - optional status filters
  - optional owner/source filters
  - optional result limits
- make `cancel_subagent` require:
  - `subagent_id`
  - optional `reason`
- make `resume_subagent` require:
  - `subagent_id`
  - `answer`
  - optional `context`
- add prompt guidance that:
  - only the `main session` should use orchestration tools
  - `resume_subagent` is for answering a paused worker, not for retrying from scratch
  - `delegate_task` should be preferred for execution-heavy work, not for trivial inline replies
  - the main session should never call `wait_subagents`
  - status questions should use `get_subagent` or `list_background_tasks`, not a blocking wait primitive

### Capability client

In `runtime/harnesses/src/runtime-tool-capability-client.ts`:

- add path constants for:
  - `POST /api/v1/capabilities/runtime-tools/subagents`
  - `GET /api/v1/capabilities/runtime-tools/subagents/:subagentId`
  - `GET /api/v1/capabilities/runtime-tools/background-tasks`
  - `POST /api/v1/capabilities/runtime-tools/subagents/:subagentId/cancel`
  - `POST /api/v1/capabilities/runtime-tools/subagents/:subagentId/resume`
- add body builders for:
  - delegate-task normalization from singleton input to `tasks[]`
  - get-subagent query/path payload
  - list-background-tasks query payload
  - cancel payload
  - resume payload
- continue using capability headers for:
  - `workspaceId`
  - `sessionId`
  - `inputId`
  - `selectedModel`
- keep parent-session provenance out of model-authored payloads; derive it from the capability context instead

### Runtime service layer

In `runtime/api-server/src/runtime-agent-tools.ts`:

- add parameter interfaces for:
  - `RuntimeAgentToolsDelegateTaskParams`
  - `RuntimeAgentToolsGetBackgroundTaskParams`
  - `RuntimeAgentToolsListBackgroundTasksParams`
  - `RuntimeAgentToolsCancelSubagentParams`
  - `RuntimeAgentToolsResumeSubagentParams`
- add runtime tool definitions and paths to `RUNTIME_AGENT_TOOL_DEFINITIONS`
- implement service methods:
  - `delegateTask(...)`
  - `getBackgroundTask(...)`
  - `listBackgroundTasks(...)`
  - `cancelSubagent(...)`
  - `resumeSubagent(...)`
  - optional `listSubagentRuns(...)` and `getSubagentRun(...)` for desktop/server APIs

`delegateTask(...)` responsibilities:

- validate workspace and originating main session context
- resolve or verify the current `conversation_binding` when relevant
- create one `subagent_run` per normalized task
- create hidden child `agent_sessions` with `kind=subagent`
- create the initial child `agent_session_inputs` rows
- initialize ownership:
  - `origin_main_session_id = current main session`
  - `owner_main_session_id = current main session`
- return compact run metadata suitable for the main session to reference later

`getBackgroundTask(...)` and `listBackgroundTasks(...)` responsibilities:

- read run state from `subagent_runs`
- return structured status summaries rather than raw child transcript
- never block waiting for background work to progress
- optionally validate that the requesting session is a front-of-house session when called through capability routes

`cancelSubagent(...)` responsibilities:

- validate workspace ownership
- mark the run cancelled when possible
- cancel or invalidate any active child input
- enqueue a queued main-session event if the cancellation should be surfaced back to the user

`resumeSubagent(...)` responsibilities:

- validate that the run is in `waiting_on_user`
- transfer ownership to the session that is answering, if needed
- append a new child input on the same hidden child session
- update:
  - `current_child_input_id`
  - `latest_child_input_id`
  - `status`
  - `blocking_payload`
  - `last_event_at`
- supersede any stale queued blocker events for that run

### API routes in `app.ts`

In `runtime/api-server/src/app.ts`:

- add capability routes for the five agent-facing tools:
  - `POST /api/v1/capabilities/runtime-tools/subagents`
  - `GET /api/v1/capabilities/runtime-tools/subagents/:subagentId`
  - `GET /api/v1/capabilities/runtime-tools/background-tasks`
  - `POST /api/v1/capabilities/runtime-tools/subagents/:subagentId/cancel`
  - `POST /api/v1/capabilities/runtime-tools/subagents/:subagentId/resume`
- parse capability headers with the same helpers already used by cronjob and onboarding runtime tools
- keep validation at the route boundary narrow and typed; push orchestration rules into the service layer

Recommended read-only app/server routes for desktop:

- `GET /api/v1/workspaces/:workspaceId/background-tasks`
- `GET /api/v1/workspaces/:workspaceId/background-tasks/:subagentId`

These routes should:

- query `subagent_runs`
- return compact read models for the `Background Tasks` panel
- avoid exposing raw child transcript or tool trace in the first-pass UI payload

### Runner and tool-scope enforcement

In `runtime/api-server/src/ts-runner.ts`:

- project different default tool sets for `main session` versus `subagent`
- keep orchestration tools only on main sessions
- keep execution-heavy tools on subagents
- pass prompt-role or session-role information clearly into prompt composition

In `runtime/api-server/src/harness-registry.ts`:

- stop gating browser tools solely on `workspace_session`
- allow browser tools for `subagent`
- keep broad browser automation off the main session in the first pass
- move toward capability-profile-based browser staging rather than kind-only staging

### Prompt composition wiring

In `runtime/api-server/src/agent-runtime-prompt.ts`:

- split main-session and subagent top-level prompt composition
- keep shared prompt-section utilities where useful
- add a dedicated `subagent` session-kind policy branch
- make the main-session branch explicitly front-of-house and conversational

### Claimed-input executor writeback

In `runtime/api-server/src/claimed-input-executor.ts`:

- add helper(s) to detect whether the current input belongs to a `subagent_run`
- after `persistTurnResult(...)`, update the matching `subagent_runs` row on:
  - `completed`
  - `failed`
  - `waiting_user`
  - `paused`
- emit queued main-session events rather than directly injecting synthetic assistant messages
- add milestone-progress handling so meaningful runner progress can update:
  - `latest_progress_payload`
  - `last_event_at`
  - queued main-session event records when appropriate
- replace cronjob completion notifications for execution cronjobs with:
  - subagent run updates
  - queued main-session events
- keep lightweight `system_notification` cronjobs on the templated notification path

Recommended helper shape:

- `maybeLinkSubagentRunFromInput(...)`
- `updateSubagentRunFromTurnResult(...)`
- `enqueueMainSessionEventForSubagentLifecycle(...)`
- `enqueueMainSessionEventForSubagentProgress(...)`
- `transferQueuedEventsOnOwnershipChange(...)`

### Cronjob runtime path

In `runtime/api-server/src/cron-worker.ts`:

- keep lightweight notification cronjobs on the template-only path
- change execution cronjobs so they spawn hidden `subagent_runs` rather than user-facing `cronjob` chat work
- set `source_type=cronjob` and `cronjob_id` on spawned runs
- point automatic delivery ownership at the intended main session binding for that workspace/surface

### Tests

Add or update coverage in:

- `runtime/harnesses/src/runtime-capability-tools.test.ts` or nearby harness-host runtime tool tests
- `runtime/api-server/src/runtime-agent-tools.test.ts` if present, otherwise `app.test.ts`
- `runtime/api-server/src/app.test.ts`
- `runtime/api-server/src/claimed-input-executor.test.ts`
- `runtime/api-server/src/ts-runner.test.ts`
- `runtime/api-server/src/harness-registry.test.ts`
- `runtime/api-server/src/cron-worker.test.ts`

Recommended assertions:

- singleton `delegate_task` input normalizes into `tasks[]`
- only main sessions can call orchestration tools
- subagents do not receive orchestration tools
- `resume_subagent` appends a new child input on the same child session
- ownership transfer updates undelivered queued events
- execution cronjobs create hidden subagent runs instead of user-facing cronjob sessions
- notification cronjobs remain lightweight and do not consume a model turn

## 8. Desktop UX

Once the substrate exists, reshape the chat experience around one visible main conversation.

Recommended UX:

- keep the main chat as the center surface
- replace session-centric task visibility with a read-only inline `Background Tasks` section in the main chat
- make the background-work surface informational, not interactive
- for the first pass, reusing the old todo slot as a hard-coded inline `Background Tasks` section is sufficient
- each task card shows:
  - title
  - status
  - origin or owner main session
  - latest update
  - duration or started time

Interaction rule:

- do not put reply boxes, task-local confirmations, or direct task controls on background task cards
- if the user wants to cancel, retry, or redirect a task, they say so in the main chat
- any task details shown in the UI should be read-only status/worklog views, not a separate interaction channel

Recommended non-goal:

- do not expose child session ids, raw child conversations, or child session switching in the normal chat flow
- do not let the user interact with background tasks as if they were separate agents

## 8a. Existing Session Migration

Rollout should be additive. Do not rewrite or delete historical sessions just to introduce `conversation_bindings` and hidden subagents.

Migration goals:

- preserve all existing session transcripts
- introduce `conversation_bindings` without breaking current workspaces
- pick one canonical desktop `main session` per workspace for the new UX
- remove the legacy desktop session selector so desktop only shows one chat surface
- export legacy desktop front-chat sessions into `.holaboss/legacy-session-histories`
- archive those legacy front-chat sessions in the runtime DB after export
- leave raw worker-style sessions accessible for debug or legacy inspection
- start `subagent_runs` and `main_session_event_queue` from rollout forward rather than trying to fully reconstruct them from old transcripts

Recommended migration strategy:

- add the new tables first:
  - `conversation_bindings`
  - `subagent_runs`
  - `main_session_event_queue`
- do not mutate or delete any existing `agent_sessions` rows during schema migration
- do not attempt to retroactively convert old `task_proposal` or `cronjob` sessions into live `subagent_runs`
- do not backfill `main_session_event_queue`; the queue should start empty at rollout time

Desktop main-session binding migration:

- for each workspace, create or resolve the desktop `conversation_binding` with:
  - `channel=desktop`
  - `conversation_key=workspace-main`
  - `role=main`
- bind it to a chosen legacy front-of-house session instead of creating a new session when a good candidate already exists
- if no suitable front-chat session exists, create a fresh `main` session and bind desktop to it

Recommended main-session selection order for legacy workspaces:

1. an existing active `conversation_binding`, if one was already created earlier
2. otherwise the latest non-archived user-facing session in that workspace, preferring:
   - `workspace_session`
   - `main`
   - `onboarding`
3. otherwise create a fresh front-of-house session and bind desktop to that

Legacy-session handling rules:

- archive and export legacy desktop front-chat sessions that are not selected as the bound desktop `main session`
- write both `.json` and `.md` exports under `.holaboss/legacy-session-histories/`
- maintain an `index.json` manifest in that folder so old histories remain discoverable
- historical `task_proposal`, `cronjob`, and similar worker sessions remain as transcript history only
- they should not appear as live background tasks unless a new `subagent_run` is created from rollout-forward activity
- in-flight legacy queued or claimed work should stay attached to its original session; do not try to re-home active inputs during the migration itself
- future accepted task proposals should execute as hidden `subagent` sessions with `subagent_runs`, not as new `task_proposal` execution sessions

UX handling after migration:

- desktop should open the bound desktop `main session` by default
- the normal user-facing flow should stop exposing legacy session switching entirely on desktop
- exported legacy front-chat histories remain available under `.holaboss` for later context lookup if needed
- archived legacy sessions may still remain queryable for debugging, support, or developer tooling
- the read-only `Background Tasks` panel should only show runs backed by real `subagent_runs`

Implementation note:

- the safest rollout path is lazy binding creation:
  - when a workspace opens, resolve or create the desktop `conversation_binding`
  - export and archive any remaining legacy desktop front-chat sessions at that point
  - only create a new front-of-house session if no suitable legacy session exists
- if needed later, a one-shot backfill job can pre-create bindings for all workspaces using the same selection rules, but the runtime should not depend on that job existing before the feature works

---

## Implementation Sequence

## Phase 1 — Hidden Subagent Substrate

Build the runtime and persistence layer first.

Primary files:

- `runtime/harnesses/src/runtime-agent-tools.ts`
- `runtime/harnesses/src/runtime-capability-tools.ts`
- `runtime/harnesses/src/runtime-tool-capability-client.ts`
- `runtime/api-server/src/runtime-agent-tools.ts`
- `runtime/api-server/src/app.ts`
- `runtime/api-server/src/ts-runner.ts`
- `runtime/api-server/src/agent-runtime-config.ts`
- `runtime/api-server/src/agent-runtime-prompt.ts`
- `runtime/api-server/src/harness-registry.ts`
- `runtime/api-server/src/claimed-input-executor.ts`
- `runtime/state-store/src/store.ts`

Deliverables:

- new `delegate_task` / `get_subagent` / `list_background_tasks` / `cancel_subagent` surface
- `resume_subagent` surface for paused-run continuation
- hidden `subagent` child sessions
- `subagent_runs` persistence
- explicit main-session-versus-subagent tool split
- explicit main-session-versus-subagent prompt split
- browser-capable child workers without exposing broad browser automation on the main session
- parent-facing result updates
- cronjob delivery mapped into main-session notifications or hidden background execution rather than separate user-facing cronjob chats

Recommended implementation order:

1. Persistence substrate in `runtime/state-store/src/store.ts`
   - add `conversation_bindings`
   - add `subagent_runs`
   - add `main_session_event_queue`
   - add indexes, row converters, store methods, and `store.test.ts` coverage
2. Runtime service and route surface
   - add `holaboss_delegate_task`, `holaboss_get_subagent`, `holaboss_list_background_tasks`, `holaboss_cancel_subagent`, and `holaboss_resume_subagent`
   - add capability-client normalization and `app.ts` routes
   - add read-only background-task APIs for the desktop panel
3. Subagent execution writeback
   - update `claimed-input-executor.ts` to persist subagent lifecycle changes
   - enqueue main-session events into `main_session_event_queue`
   - wire blocked-run resume and ownership transfer
4. Prompt and tool split
   - separate main-session and subagent prompt policies
   - enforce orchestration tools on main sessions only
   - allow browser-capable execution on subagents
5. Cronjob remap
   - keep notification cronjobs on the lightweight template path
   - route execution cronjobs through hidden `subagent_runs`
6. Minimal desktop surface
   - replace the old in-chat todo slot with a read-only inline `Background Tasks` section backed by `subagent_runs`
   - keep all task interaction routed through the main session

Recommended stop points:

- after step 1, persistence is ready for runtime wiring
- after step 3, the hidden-subagent substrate is functionally real even without desktop UX
- after step 6, the v1 end-to-end experience is usable

## Phase 1 Tracker

Use this as the living checklist for what is already aligned versus what still needs implementation cleanup.

Phase 1 exit decision:

- the hidden-subagent substrate is now functionally complete enough to move into Phase 2
- the remaining unchecked items below are now treated as good-to-have hardening, polish, or verification work rather than blockers for Phase 2

### Runtime substrate and routing

- [x] `conversation_bindings` exist and are used to resolve the desktop main session
- [x] hidden `subagent` child sessions plus `subagent_runs` exist
- [x] `main_session_event_queue` exists for queued background delivery
- [x] accepted task proposals execute through hidden subagents rather than `task_proposal` execution sessions
- [x] main-session and subagent prompt paths are split
- [x] main-session and subagent tool surfaces are split
- [x] child workers can receive browser tools through delegated capability buckets
- [x] legacy desktop front-chat sessions are exported to `.holaboss/legacy-session-histories` and archived out of the normal UI flow
- [ ] expose a dedicated provider/model setting for subagents in the model-provider settings UI
- [x] remove `wait_subagents` from the main-session runtime surface entirely
- [x] add main-session inspection tools for both `get_subagent` and `list_background_tasks`
- [x] update prompt/tool guidance so the main session never uses a blocking wait primitive

### Background delivery correctness

- [x] background completion/failure/blocker events are persisted as queued main-session events
- [x] background updates can be folded into the next user reply path
- [x] delayed background follow-ups are intended to be phrased by a real main-session model turn, not a template
- [x] ensure synthetic queued background-event turns inherit the owner main session's selected model and thinking configuration
- [x] ensure natural-pause gating prevents queued background-event turns from materializing while the originating user turn is still active
- [x] keep delegated work asynchronous by default instead of `delegate -> wait -> answer`
- [ ] tighten folded background-update relevance so the next reply only absorbs queued background updates that are meaningfully relevant or still fresh enough to mention; unrelated queued updates should keep waiting for their own later follow-up instead of being appended automatically

### Background task UX

- [x] the desktop no longer relies on the old session selector for the main chat path
- [x] background tasks render inline in chat instead of using the old todo rail
- [x] the inline background-task surface can open a read-only child session for inspection
- [x] the inline panel no longer shows the extra explanatory description block
- [x] progress updates are not surfaced in main-session delivery or background-task cards

### Good-to-have hardening and follow-through

- [ ] ownership transfer should be exercised and verified across multiple channel-local main sessions so incomplete subagent runs and queued background events follow the current owner cleanly without disappearing, duplicating, or attaching to the wrong chat
- [ ] blocker batching and resume routing should be verified end-to-end in the live product so multiple `waiting_on_user` tasks can be grouped clearly, mapped back to the right paused run, and resumed on the same child session when the user answers
- [ ] idle-time autonomous follow-up delivery should be verified end-to-end so completed background containers wait through the short merge window, merge naturally into a nearby reply when possible, and otherwise speak up on their own after timeout without re-answering the earlier conversational turn
- [ ] update this checklist as any of these good-to-have items land

## Phase 2 — Main Session UX Polish

The one-main-session shell already exists. Phase 2 is about making that shell feel clean, readable, and naturally conversational under real mixed foreground-plus-background usage.

Primary files:

- `desktop/src/components/panes/ChatPane.tsx`
- `desktop/src/components/layout/AppShell.tsx`
- `desktop/src/components/panes/BackgroundTasksPane.tsx`
- any supporting desktop IPC/type files needed for background-task data

Deliverables:

- clearer separation between direct foreground replies and delayed background-update containers
- stronger per-message artifact ownership so files, reports, and attachments stay attached to the right reply or background-update container
- more readable merged replies when foreground conversation and background completions land near each other
- smoother continuity when the user asks follow-up questions about recently completed background work
- front-of-house tone and presentation polish so the main session feels human and conversational rather than mechanical
- accepted task proposals continuing to behave like normal background work instead of separate user-facing chats

## Phase 3 — Inline vs Background Escalation Policy

Refine when the main session keeps work inline versus offloading it.

Deliverables:

- default inline behavior for short tasks
- escalation into background work for long or parallelizable tasks
- smooth transition messaging when inline work becomes background work

This phase should happen after the runtime substrate exists, because otherwise the UX policy would not have a real execution model behind it.

---

## Success Criteria

- A workspace opens into one obvious main chat.
- The user can continue chatting while delegated work is still running.
- Long-running work no longer blocks the main conversation surface.
- Background work is visible as tasks, not extra chat sessions.
- The user never has to reply to, open, or manage a background task as a separate conversation.
- Child outputs are understandable from the main chat without opening separate threads.
- Quick tasks can still stay inline without forcing unnecessary background cards.
- Accepted task proposals become normal background work rather than a distinct user-facing execution mode.
- Notification cronjobs and execution cronjobs both preserve the same one-main-session interaction model.

---

## Deferred Work

- proactive follow-up questions and reminders
- richer prioritization and scheduling across many subagents
- speculative or autonomous background task creation
- more advanced background-work summarization heuristics

---

## Open Questions

- No major product-model questions remain blocking the Phase 1 runtime substrate.
- Remaining work is primarily implementation detail in store schema, migrations, dispatcher logic, prompt wiring, and UI wiring.
