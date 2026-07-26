# Proposals + Evolution — Implementation Status

Tracks what's shipped in the current goal-command session vs what remains.
Companion to `docs/proposals.md` and `docs/evolution.md`.

## What shipped (this session)

All three packages (`runtime/state-store`, `runtime/api-server`,
`apps/desktop`) typecheck cleanly after every change below.

### Schema (migrations + interfaces + CRUD) — complete

| File | What it does |
|---|---|
| `runtime/state-store/src/migrations/014-record-feedback-review-columns.ts` | Extends `record_feedback` with `attempt_idx`, `review_session_id`, `review_node_id`, `batch_id` + indexes; `source` TEXT can take new enum values. |
| `runtime/state-store/src/migrations/015-evolution-proposals.ts` | New `evolution_proposals` table per the Evolution PRD shape (provenance, diff fields, evidence JSON, status, decline reason, accepted-revision linkback). |
| `runtime/state-store/src/migrations/016-plugin-kind-and-evolution-counter.ts` | Adds `workspace_plugins.kind` (default `'user'`, new `'proposal'`) + new `evolution_decision_counters` table. |
| `runtime/state-store/src/migrations/017-agent-session-review-record.ts` | Adds `agent_sessions.review_record_id` for per-record chat session scoping. |
| `runtime/state-store/src/migrations/index.ts` | Registers all four. |
| `runtime/state-store/src/store.ts` | Interfaces: extended `RecordFeedbackRecord`, new `RecordFeedbackSource` enum values (`review_decision`, `review_revision_request`), `WorkspacePluginKind` (+ `WorkspacePluginRecord.kind`), `EvolutionDecisionCounterRecord`, `EvolutionProposalRecord`, `EvolutionProposalStatus`. `WorkflowNodeType` now includes `"review"`. CRUD: extended `createRecordFeedback` + `rowToRecordFeedback`, full Evolution proposal CRUD (`createEvolutionProposal`, `getEvolutionProposal`, `listEvolutionProposals`, `acceptEvolutionProposal`, `declineEvolutionProposal`), counter ops (`incrementEvolutionDecisionCounter`, `resetEvolutionDecisionCounter`, `getEvolutionDecisionCounter`). |

### Workflow grammar validation — complete

| File | What it does |
|---|---|
| `runtime/api-server/src/workflow-graph.ts` | Trigger validator now accepts `"invokable"` as a third trigger kind. New `"review"` node validation: must declare `target_base`, must be preceded by an `agent` node. |

### Canonical agent specs — complete

| File | What it does |
|---|---|
| `runtime/state-store/src/agents/review-companion.ts` | System prompt + tool list + JSON-schema tool descriptors for `capture_decision`, `capture_revision_request`, `retry_post_approval`. |
| `runtime/state-store/src/agents/evolution-agent.ts` | System prompt + tool list + JSON-schema for `propose_evolution`. Exports `EVOLUTION_BATCH_THRESHOLD = 5`. |
| `runtime/state-store/src/agents/index.ts` | Barrel export. |

### UI surfaces — partial

| File | What it does |
|---|---|
| `apps/desktop/src/components/layout/shell/state/ui.ts` | `WorkspaceOverlay` union extended with `"evolution"`. |
| `apps/desktop/src/components/layout/shell/Sidebar.tsx` | Evolution entry added alongside Proposals with the same dot-badge pattern. `BrainCircuit` icon. |
| `apps/desktop/src/components/layout/shell/EvolutionOverlay.tsx` | New full-screen overlay: list view (pending + decided history) + detail view (rationale + side-by-side diff + evidence rows + accept / decline-with-reason). Phase 1 mock data; backend integration point is `useEvolutionProposalsState`. |
| `apps/desktop/src/components/layout/shell/AppShell.tsx` | Routes `workspaceOverlay === "evolution"` to the new component; `setWorkspaceOverlay` wired for the overlay's close button. |

The Proposals overlay (sidebar entry, list pane, detail with Review/Workflow
sub-tabs, review pane with comment composer, mention picker, decision
buttons) was already scaffolded with Phase 1 mock data in this branch
before this session — no changes were made to that scaffolding in this
session. The shape there predates our PRD pivot to chat-driven review
(per the latest `docs/proposals.md`), so the eventual swap to a
review-companion chat in the detail pane is a planned UI replacement,
not a fresh build.

## What remains

Each item below is a substantive integration effort that requires deep
edits in code paths that the schema/spec work above does NOT touch.
Sized in rough rank order.

### Runtime layer

**Task 7 — object-status-change → workflow resume hook.**
Today's workflow runtime parks on `approveWorkflowRunNodeExecution` (a
direct approval call). New: a listener that watches base-record
`review_status` field updates and resumes any node runs keyed to
`(recordId, expected_status)`. Edits land primarily in
`runtime/state-store/src/workflow-runtime.ts` (~3000 lines) around the
existing approval-pending paths (lines ~504 and ~2942 per earlier
exploration). Estimated: 1–2 days.

**Task 8 — review node execution.**
New node type's runtime behavior:
1. Pick up the upstream agent's output (text + mime hint).
2. Runtime-write the artifact to a conventional path
   (`/records/{recordId}/attempt-{N}.{ext}`).
3. `object_write` a record in `target_base` with `review_status =
   needs_review` and the attachment populated via the generalized
   attachment pipeline (task 18).
4. Park the node run keyed to `(recordId, "needs_review" exit)`.
5. On `review_status = revise_requested`, inject the latest revision
   request into `SubagentRunRecord.context.revision_context` and
   re-activate the segment's upstream agent (new attempt). Append the
   new attachment to the same record on completion.
6. On `review_status = approved`, advance the run.
7. On `review_status = rejected`, terminate the run.

Touches `workflow-runtime.ts` and probably new helper modules in
`runtime/state-store/src/` for attachment-writing. Estimated: 2–3 days.

**Task 9 — post-approval failure handling.**
When a tool node downstream of the last review errors, set
`review_status = post_approval_failed` on the record and mark the
run as failed (record stays approved). Implement the `retry_post_approval`
tool surface to re-fire the post-approval block. Estimated: ½ day on top
of task 8.

### API + slash command

**Task 10 — `workflow.run` tool + `/run` slash command.**
Two layers:
- **Backend:** Auto-register every workflow with an `invokable` trigger
  at the workspace tool surface as a callable. New HTTP endpoint
  `POST /api/v1/workflows/{workflowId}/run` taking `{ payload, batch_id?
  }`, validating against the trigger's payload schema, creating one
  `workflow_run` per call.
- **Frontend:** New `/run` slash command in the main workspace chat
  composer. Picker (fuzzy across all invokable workflows in the
  workspace) → typed payload form (rendered from the trigger's
  field-list config) → count input → submit fires N parallel calls
  with a shared `batch_id`. Chat acknowledges once, no streaming.

Touches `runtime/api-server/src/runtime-agent-tools.ts` (tool registration),
new file for the HTTP route, and the desktop ChatPane composer +
mention/slash systems. Estimated: 2 days.

### Agent runtime binding

**Task 11 — bind review companion to the per-record chat session.**
The spec file `runtime/state-store/src/agents/review-companion.ts` defines
the system prompt + tool list + JSON schemas. Remaining: an agent
runtime path that activates this agent when a chat session has
`review_record_id` set, with its tool calls actually persisting
`RecordFeedbackRecord` rows (`source = review_decision` or
`review_revision_request`) + flipping `review_status` on the target
record. The `capture_decision` tool also needs to increment
`evolution_decision_counters` and trigger the Evolution agent at
threshold. Estimated: 1–2 days.

**Task 12 — bind Evolution agent to the batch trigger.**
When `incrementEvolutionDecisionCounter` returns a count ≥ 5
(`EVOLUTION_BATCH_THRESHOLD`), schedule an Evolution agent run for that
workflow. The agent reads via `list_recent_feedback`, etc., and on
`propose_evolution` tool call calls `store.createEvolutionProposal`.
Counter resets after the agent run regardless of whether a proposal
emits. Estimated: 1 day.

### Builder + editor

**Task 13 — `plugin_workflow_add_review_node` builder tool.**
Extends the existing `plugin_workflow_*` toolset (in
`runtime/api-server/src/runtime-agent-tools.ts`) so the NL builder agent
can construct workflows with review nodes. Validates the produced graph
against the syntax. Estimated: ½ day.

**Task 17 — Trigger node typed-payload config UI + editor Run button.**
Adds the typed field list editor to the trigger node config side panel
when `trigger_kind === "invokable"` (reuse the existing tool-node
typed-field-list pattern). Editor's Run button opens the same `/run`
form with workflow pre-selected and count=1. Estimated: 1 day.

### Platform

**Task 18 — generalize attachment pipeline off issues.**
Today's upload/retrieval is wired only for `IssueAttachmentRecord` on
issues. Generalize so any base record can carry the same shape via the
existing system `attachment` field. Touches storage paths, upload
handlers, and `app.ts` issue-specific helpers. Required by task 8.
Estimated: 1–2 days.

## Summary

Roughly **8–14 engineer-days** of integration work remain to ship the
full Proposals + Evolution loop end-to-end as designed. The schema
foundation, validation, canonical agent specs, and the Evolution
overlay UI shell are in place; the runtime hooks (review node
execution, status-change resume, post-approval failure, `/run` slash
command, agent dispatch bindings) and the attachment-pipeline
generalization are the remaining shape-of-work that this session did
not complete.

Every file edit in this session was scoped to additions and small
extensions of existing patterns. No existing behavior was changed; old
plugins still default to `kind = 'user'`, all existing trigger kinds
still validate, and all existing `RecordFeedbackRecord` rows continue
to parse.
