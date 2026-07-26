# PRD — Proposals

## Summary

**Proposals** are a new full-screen workspace overlay — a peer to Automations, Skills, and Projects, all of which open full-screen from the sidebar — where each Proposal wraps **exactly one workflow** plus a dedicated review page for that workflow's outputs. The workflow is exposed as a tool (`workflow.run`) — registered at the workspace tool surface and callable by any agent (the workspace's main chat, other workflows' agent nodes, automations).

**Invocation** is explicit: from the workspace's main chat session, the user types a slash command (`/run`) that opens a typed picker — pick a workflow, fill its payload fields, optionally pick a count, submit. Each invocation produces one reviewable record.

**Review** is conversational: clicking a record in the Review tab opens its detail pane, where the artifact sits above a chat session with a canonical **review companion** agent. The user discusses the artifact in natural language; the agent uses a curated tool surface (`read_record`, `read_attachments`, `read_workflow_provenance`, `search_records`) to answer and probe — including resolving natural-language record references like "the Q2 launch recap brief" — and calls structured-capture tools (`capture_decision`, `capture_revision_request`, `retry_post_approval`) to distill what was said into Evolution-ready signal. All decisions and feedback flow through tool calls in Phase 1 — no shortcut buttons that bypass the agent.

Proposals is the first product surface designed end-to-end around the **review → feedback → workflow-evolution** learning loop. The primitives are shared across plugin-based systems — any plugin's workflows can plug into the same loop once they exist.

## The bigger picture — Proposals + Evolution

These two features are designed and built in parallel. They split cleanly across the loop:

| | Proposals | Evolution |
|---|---|---|
| **Role** | Signal *source* — captures reviewer feedback | Signal *consumer* — proposes workflow edits |
| **UI surface** | Review + Workflow, scoped to one Proposal. Invocation lives in the workspace's main chat via `/run`. | Workspace-level hub: proposed evolutions, version diffs, evidence trail, accept/decline |
| **What it writes** | Per-record chat sessions (raw) + structured decisions and feedback notes produced by the review companion's tool calls (distilled) | New workflow revisions (only after user accepts) |
| **What it reads** | Workflow definitions, base records, attachments | Aggregated feedback on records produced by a workflow + that workflow's revision history |
| **Sidebar entry** | New | New |

**Trigger model for Evolution:** signal is captured after *each* review decision; proposals are generated in *batches* (to resist overfit on a single piece of feedback). Each proposed evolution is a candidate new workflow revision the user reviews before adoption.

**Scope of evolutions (v1):** edits to existing node config — instructions, prompts, decision options. **No topology changes** in v1 (no adding/removing nodes or edges). Lower blast radius, simpler diffs.

**Instance, not template.** Evolution operates on the user's workflow instance. No upstream template merges, no cross-user propagation. Each workspace's workflows learn from that workspace's feedback.

**Implication for Proposals Phase 1:** the feedback we capture must be structured well enough for Evolution to consume. Proposals and Evolution ship together (see `docs/evolution.md`); the schemas below are the contract between them.

## Why now

- The workflow runtime already supports the foundational primitives: event-driven pause/resume (`runtime/state-store/src/workflow-runtime.ts:504, :2942`), object writes (`tool_kind: "object_write"`), a builder agent toolset (`runtime-agent-tools.ts:2715`), **workflow revision versioning** (`WorkflowRevisionRecord`, `store.ts:1467`), and **base record → workflow-revision provenance** (`store.ts:449`, migration `003-base-object-record-workflow-provenance.ts`).
- `review_status` and `attachment` are already system fields on every base (`store.ts:965, :976`), so the review data model is largely *already* present.
- The provenance link from a record back to the revision that produced it means Evolution can attribute feedback to a specific revision with zero new schema. The data foundation for the learning loop is already there; we just need to surface it.

## What we're shipping

A Proposal has exactly two tabs in v1, with **Review** as the default landing tab. The Proposal page does **not** embed the workspace main chat — only the two tabs render.

1. **Review** (default) — new. Two-pane: a list of records in `review_status = needs_review` produced by this Proposal's workflow, and a detail view (artifact + per-record chat with the review companion) for the selected record.
2. **Workflow** (singular) — reused from the plugin SDK as-is. The editor for the Proposal's one workflow definition. Same editor, same builder-agent affordances.

Invocation happens from the **workspace's main chat** (the existing chat surface from "+ New chat" in the sidebar), not inside the Proposal. A new `/run` slash command opens a typed picker: pick workflow → fill payload fields → optionally pick count → submit. Run status, failures, and links to created records surface in that same chat session.

Plus the underlying primitives:

3. **`Proposal`** — a synthetic plugin behind the scenes (`kind: "proposal"` flag), surfaced as a new sidebar entry alongside Automations, Skills, Projects, each of which opens its own full-screen workspace overlay. Wraps exactly one workflow plus the bases that workflow writes into. Detail navigation (list → individual Proposal) stays *inside* the overlay with a back arrow rather than spawning a tab.
4. **`review` node type** in workflows — writes a record to a target base with `review_status = needs_review`, attaches the upstream artifact, parks the run.
5. **Workflow-as-tool API** — `workflow.run({ workflowId, payload, batch_id? }) → { workflowRunId, recordId }`. Workspace-level tool surface populated by every invokable workflow (Proposals' workflows + any other plugin that exposes one). Each call creates one workflow run that produces one record.
6. **`/run` slash command** in the workspace's main chat. Opens a small form: workflow picker → payload fields (auto-derived from the trigger's typed schema) → count (default 1) → submit. Submitting fires N `workflow.run` calls with a shared `batch_id`. The chat acknowledges with "N runs started" and does not stream per-run progress; the user notices completion via the sidebar badge on the Proposal.
7. **Per-record review session** — a chat session scoped to a record, with the **review companion** agent. Opens when the user selects a record in the Review tab. The session is record-scoped (not per-attempt — one rolling thread across attempts). The agent's tool surface:
   - **Read tools**: `read_record(id)`, `read_attachments(recordId)`, `read_workflow_provenance(recordId)`, `search_records({ baseId?, query })` — the last one resolves natural-language record references ("the Q2 launch recap brief") to concrete records the agent can then read.
   - **Structured-capture tools**: `capture_decision({ outcome })`, `capture_revision_request({ whatToChange, exemplarRefs })`, `retry_post_approval(recordId)`.
8. **Structured feedback capture** — written exclusively by the review companion's tool calls. Decisions, distilled revision requests, exemplar references identified by the agent from conversation, plus implicit signal, all recorded against `(workflowRevisionId, nodeId, runId, recordId, attemptIdx, batchId?)`. See schemas below.
9. **Builder-agent extension** — `plugin_workflow_add_review_node` tool so NL prompts can produce workflows with reviews.

## User flow

1. User creates Proposal "Launch brief pipeline" from the sidebar. A fresh Proposal opens on the **Workflow** tab so the user can build the workflow; once a workflow exists, subsequent opens land on **Review** (the default).
2. User on the **Workflow** tab: *"Write a launch brief, I'll review it."* Builder agent constructs the Proposal's one workflow:
   ```
   trigger(invokable, payload: { topic: string, angle?: string })
     → agent(write_brief)
     → review(target_base=Briefs)
        ↑                │
        └─ revise_requested (loops back; auto-wired)
   ```
   The trigger declares a typed payload schema in its config (just like a tool node). Callers of `workflow.run` for this workflow must supply matching fields. Review-decision outcomes are fixed in v1 (`approve | revise_requested | rejected`); the workflow author doesn't configure them per node.
3. User opens the workspace's main chat ("+ New chat" in the sidebar), types `/run`. The picker shows their workflows including "Launch brief pipeline." Selects it → form appears with the trigger's typed fields (`topic`, `angle`) and a count input. Enters `topic: "Q3 launch"`, leaves `angle` blank, sets count to **10**, submits.
4. The main chat agent fires `workflow.run` ten times in parallel, stamping all with `batch_id: "b_01"`. The chat acknowledges with "10 runs started" and returns. Each run spins up, executes `write_brief`, reaches the `review` node, creates a `Briefs` record at `review_status = needs_review`, parks. The dot badge appears on the Proposal's sidebar entry as records become ready.
5. User switches to the Proposal's **Review** tab. The list shows 10 records from `batch b_01`. Clicks record #3 → detail pane opens with the artifact on top and a chat session below it (the review companion agent).
6. User in the per-record chat: *"This tone is too formal for our brand. Look at the Q2 launch recap brief — match that voice instead."* The agent calls `read_record` to inspect Q2 launch recap (identified from natural language, no `@` picker), reads its content, replies with a summary of the difference, then calls `capture_revision_request({ what_to_change: "tone — match Q2 launch recap brand voice", exemplar_refs: [Q2-launch-recap.id] })`. The user replies *"yes, do it."* The agent calls `capture_decision({ outcome: "revise_requested" })`.
7. `write_brief` re-runs **within record #3's existing workflow run** with `revision_context` (the captured revision request + dereferenced exemplar record) injected into its `SubagentRunRecord.context`. New attachment appended to the same record; status flips back to `needs_review`. The other 9 records are unaffected. Attempts = the attachment list. The per-record chat session continues across attempts — the user can see prior conversation when attempt 2 lands.
8. User reviews more records: in some, the conversation is short (*"this is good, approve"* → agent calls `capture_decision({ outcome: "approve" })`); in others, longer. Eventually 8 records are `approved`. *Or* — user returns to the main chat and types `/run` again, fills `topic: "Q3 launch"` and `angle: "emerging markets"`, count 2 — fires two fresh runs to produce alternatives. Two new records appear in the Proposal's **Review** tab.
9. Approved records live as normal `Briefs` records; downstream workflows or other Proposals (or other agents calling `workflow.run` for a different workflow) can read them as input.
10. *(Later, in Evolution's surface — not part of this PRD's UI scope)* — after several such cycles, Evolution proposes: "Update `write_brief` instruction to match the voice of recently-cited example briefs." User reviews diff + evidence (the actual feedback events that triggered the proposal), accepts → new workflow revision is committed.

> **Two revision pathways.** The user has both: (a) **per-record revise**, which re-fires the workflow's upstream agent in the same run (same record, new attachment); and (b) **fresh invocation**, where the user fires another `/run` from chat that produces new records. (a) preserves attempt history on the same record; (b) discards the rejected one and generates a replacement. Both are valid; the user picks based on whether they want to iterate on an artifact or start over.

> **Cross-call context (dedup).** The user passes "avoid duplicates" hints by typing them into the slash command's payload (`angle: "different from approved Q3 briefs"`) or by referencing approved records in their prompt. The runtime does not auto-inject sibling outputs across separate `/run` invocations — Phase 1 keeps invocations independent. Phase 2 can add an "avoid these approved records" payload field if it bites.

## Wireframes

### Sidebar — Proposals + Evolution entries with dot badges

```
┌─────────────────────────┐
│  + New chat             │
│                         │
│  ⚙  Automations         │
│  🧩 Skills              │
│  📁 Projects            │
│  📋 Proposals      •    │  ← dot when any record in needs_review
│  🧬 Evolution      •    │  ← dot when any EvolutionProposal pending
└─────────────────────────┘
```

Dot is a single indicator (no count), per the notification decision.

### Proposal — Workflow tab (fresh, empty canvas + NL builder)

```
┌──────────────────────────────────────────────────────────────┐
│  ← Proposals    Launch brief pipeline                  ⋯ ✕  │
├──────────────────────────────────────────────────────────────┤
│  [ Review ]   [ Workflow ]  ← active                         │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   (empty canvas — builder is the primary entry)              │
│                                                              │
│   ┌────────────── Builder agent ────────────────────┐        │
│   │ What workflow do you want to build?             │        │
│   │                                                 │        │
│   │ ┌─────────────────────────────────────────────┐ │        │
│   │ │ Write a launch brief, I'll review it_       │ │        │
│   │ └─────────────────────────────────────────────┘ │        │
│   │                                              ⏎  │        │
│   └─────────────────────────────────────────────────┘        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Proposal — Workflow tab (populated, after builder produces graph)

```
┌──────────────────────────────────────────────────────────────┐
│  ← Proposals    Launch brief pipeline               [Run...] │
├──────────────────────────────────────────────────────────────┤
│  [ Review ]   [ Workflow ]                                   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   ◯ trigger(invokable)                                       │
│     payload: { topic: string, angle?: string }               │
│        │                                                     │
│        ▼                                                     │
│   ▢ agent: write_brief         ◀╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐          │
│        │                                          ┊          │
│        ▼                                          ┊          │
│   ◆ review                                        ┊          │
│   target_base: Briefs                             ┊          │
│   outcomes: approve / revise_requested / rejected ┊          │
│        │                                          ┊          │
│        └── revise_requested ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘          │
│        └── approve ── ✓ (workflow complete)                  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

The `Run...` button in the top-right reuses the `/run` form with this workflow pre-selected and count locked to 1.

### `/run` from the workspace main chat

Step 1 — picker after typing `/run`:

```
┌──────────────────────────────────────────────────────────────┐
│  Workspace main chat                                         │
├──────────────────────────────────────────────────────────────┤
│  You: /run                                                   │
│                                                              │
│  ┌─── /run ────────────────────────────────────────┐         │
│  │ Search workflows...                              │         │
│  │ ────────────────────────────────────────────    │         │
│  │ 📋 Launch brief pipeline       Proposals        │         │
│  │ 📋 Weekly market scan          Proposals        │         │
│  │ ⚙  Daily standup digest         Automations     │         │
│  │ ⚙  Slack channel summary        Automations     │         │
│  └─────────────────────────────────────────────────┘         │
└──────────────────────────────────────────────────────────────┘
```

Flat list across all invokable workflows, fuzzy-searchable.

Step 2 — typed payload form (auto-derived from trigger schema):

```
┌─── Launch brief pipeline ────────────────────────┐
│  topic *                                         │
│  ┌────────────────────────────────────────────┐ │
│  │ Q3 launch                                  │ │
│  └────────────────────────────────────────────┘ │
│                                                  │
│  angle                                           │
│  ┌────────────────────────────────────────────┐ │
│  │                                            │ │
│  └────────────────────────────────────────────┘ │
│                                                  │
│  count                                           │
│  ┌────────┐                                      │
│  │   10   │                                      │
│  └────────┘                                      │
│                                                  │
│           [ Cancel ]    [ Run 10 times ]         │
└──────────────────────────────────────────────────┘
```

Step 3 — single acknowledgment (no streaming):

```
┌──────────────────────────────────────────────────────────────┐
│  System: 10 runs of "Launch brief pipeline" started.        │
│          batch: b_01 — check Proposals when ready ↗          │
└──────────────────────────────────────────────────────────────┘
```

### Proposal — Review tab list state

```
┌──────────────────────────────────────────────────────────────┐
│  ← Proposals    Launch brief pipeline                        │
├──────────────────────────────────────────────────────────────┤
│  [ Review ] ← active   [ Workflow ]                          │
├─────────────────────────┬────────────────────────────────────┤
│  Needs review (8)       │                                    │
│  ─────────────────────  │                                    │
│  📄 Q3 launch #1        │      Select a record to review     │
│     attempt 1 · 5m ago  │                                    │
│  📄 Q3 launch #2        │                                    │
│     attempt 1 · 5m ago  │                                    │
│  📄 Q3 launch #3        │                                    │
│     attempt 1 · 5m ago  │                                    │
│  📄 Q3 launch #4 ⚠     │   ← post_approval_failed flag      │
│     attempt 1 · 8m ago  │                                    │
│  📄 Q3 launch #5        │                                    │
│  …                      │                                    │
│                         │                                    │
└─────────────────────────┴────────────────────────────────────┘
```

List filter: `review_status ∈ { needs_review, post_approval_failed }`. The ⚠ icon marks the failure state.

### Proposal — Review detail with per-record chat

```
┌─────────────────────────┬────────────────────────────────────┐
│  Needs review (8)       │  📄 Q3 launch #3                   │
│  ─────────────────────  │  Provenance: write_brief · run a3 │
│  ▶ Q3 launch #3         │  · attempt 1 · 5m ago              │
│  📄 Q3 launch #1        │                                    │
│  📄 Q3 launch #2        │  ┌──── Artifact ─────────────┐    │
│  📄 Q3 launch #4 ⚠     │  │ Preview: attempt-1.md      │    │
│  …                      │  │                            │    │
│                         │  │ Q3 launch is shaping up... │    │
│                         │  │ [⬇ download / open]        │    │
│                         │  └────────────────────────────┘    │
│                         │                                    │
│                         │  ┌──── Review companion ─────┐    │
│                         │  │                            │    │
│                         │  │  Agent: How does this look?│    │
│                         │  │  Anything to change?       │    │
│                         │  │                            │    │
│                         │  │  You: Tone is too formal — │    │
│                         │  │  match the Q2 launch recap │    │
│                         │  │                            │    │
│                         │  │  Agent (search_records,    │    │
│                         │  │  read_record)              │    │
│                         │  │  Got it — Q2 recap reads   │    │
│                         │  │  much more conversational. │    │
│                         │  │  Request revision with     │    │
│                         │  │  that as the exemplar?     │    │
│                         │  │                            │    │
│                         │  │  You: yes                  │    │
│                         │  │                            │    │
│                         │  │  Agent (capture_revision_  │    │
│                         │  │  request, capture_decision)│    │
│                         │  │  Done. write_brief will    │    │
│                         │  │  re-run with the feedback. │    │
│                         │  │                            │    │
│                         │  │ ┌────────────────────────┐ │    │
│                         │  │ │ Type a message...      │ │    │
│                         │  │ └────────────────────────┘ │    │
│                         │  └────────────────────────────┘    │
└─────────────────────────┴────────────────────────────────────┘
```

The chat shows agent tool calls inline as a small badge so the user sees what was distilled. No shortcut "approve/revise" buttons — every decision flows through the agent.

### Review detail — attempt 2 after revision

```
┌─────────────────────────┬────────────────────────────────────┐
│  Needs review (8)       │  📄 Q3 launch #3                   │
│                         │                                    │
│  ▶ Q3 launch #3         │  ▸ Attempt 1   ✗ revise · 9m ago   │ ← collapsed
│                         │     artifact · 12 messages         │
│                         │                                    │
│                         │  ▼ Attempt 2   ⏳ needs review     │ ← active
│                         │                                    │
│                         │  ┌──── Artifact ─────────────┐    │
│                         │  │ attempt-2.md               │    │
│                         │  │ Q3 launch is gonna be huge │    │
│                         │  └────────────────────────────┘    │
│                         │                                    │
│                         │  ┌──── Review companion ─────┐    │
│                         │  │ (chat session continues —  │    │
│                         │  │  scrollback shows attempt  │    │
│                         │  │  1 history)                │    │
│                         │  └────────────────────────────┘    │
└─────────────────────────┴────────────────────────────────────┘
```

One chat session per record, rolling across attempts — the user sees prior conversation when attempt 2 lands.

## Architecture decisions

- **Proposal = synthetic plugin** (`createWorkspacePlugin` with `kind: "proposal"` flag). Reuses all workflow/storage/object infra. Defer a real container refactor until product validates.
- **Review = node type, not new graph primitive.** Internally: `object_write` + a parked node run keyed to `(recordId, expected_status)`. New runtime hook resumes parked runs on `review_status` change.
- **Revision = same record, new attachment.** Not a graph cycle, not a new "attempt" schema. The attachment list is the attempt history; the comments list is the thread.
- **No dedicated `Proposal` base.** The review node targets *any* base the workflow author picks. The user's domain stays in the user's bases (Briefs, Designs, Queries…), not a generic bucket.
- **Feedback is first-class structured data, not free text.** Even though Phase 1 doesn't interpret `@record` refs or aggregate signal, the storage shapes are Evolution-ready (see below).
- **Linear workflows only in v1.** No parallel branches inside a single run, no diamond fan-in. Power-user fan-out is unblocked by the runtime but not first-class in the Proposal UX; the editor and NL builder assume linear chains.
- **Cardinality is explicit at invocation, not structural.** A workflow run produces exactly one record. Multi-record cases ("generate 10") are handled by the `/run` slash command's count field firing the workflow tool N times, not by adding lanes or batch primitives to the workflow itself. This keeps the workflow syntax single-record-clean and pushes batching/dedup decisions up to the caller.
- **Workflow = a tool.** `workflow.run` is registered as a workspace-level tool surface, populated by every invokable workflow in the workspace. Any agent that has permission can call it. The workspace's main chat agent is the primary caller via `/run`, but composition (other workflows calling it, automations, chat agents in other plugins) is enabled from day one.
- **No main-chat pane embedded on the Proposal page.** Invocation lives in the workspace's existing main chat, accessed separately via "+ New chat" in the sidebar. The Proposal page renders only the Review and Workflow tabs.
- **Per-record chat is the only feedback channel in Phase 1.** When the user opens a record in the Review tab, they see the artifact plus a chat session with the review companion. All decisions, comments, and feedback flow through the agent's structured-capture tool calls — there are no shortcut "approve" or "reject" buttons that bypass the chat in v1. (Buttons could land in Phase 2 as UX polish; they would call the same tools the agent calls.)
- **Per-record chat is scoped to the record, not per-attempt.** One rolling session across all attempts on a record. The user sees prior conversation when a new attempt lands.
- **Review companion is canonical in v1.** A single fixed system prompt across all Proposals. Customizable per Proposal can come in Phase 2.
- **No `@record` mention picker in Proposals.** The user describes records in natural language ("the Q2 launch recap brief"); the review companion's `read_record` / search tools resolve the reference and inject the content. No structured `@` insertion UI in v1.
- **`batch_id` is caller-supplied.** When the `/run` slash command fires N calls in one submission, it stamps them with the same `batch_id`. This lets Evolution analyze approve/reject patterns within a single intent ("user asked for 10, approved 8, what made the 2 different?") without forcing the runtime to invent batch semantics.
- **Two revision pathways coexist.** Per-record revise (in-run, same record, attempt history preserved, chat session continues) and fresh invocation (new `/run` from main chat, new run, new record). Same machinery; the user picks based on whether they want to iterate or replace.
- **Trigger payload schema = typed field list in the trigger node's config UI.** Same UX pattern as tool node configs. The `/run` slash command auto-renders these fields as a form. Callers (whether the main chat agent, other workflows, or automations) must satisfy the schema.
- **Editor "Run" button reuses the `/run` form.** When the user clicks Run inside the workflow editor, the same typed-payload form opens with the workflow pre-selected and count locked to 1. Same backend code path, same validation, same `invokedBy.kind = "chat_slash"` (or a sibling `"editor_run"` value — minor). One mental model: there's only one way to fire a workflow, just two entry points.
- **Agent output → attachment is runtime-written.** The agent returns content + a mime hint; the runtime writes it to a conventional workspace path (`/records/{recordId}/attempt-{N}.{ext}`) and creates an `IssueAttachmentRecord`-shaped row on the base record's existing system `attachment` field (`store.ts:976`). The artifact can be any file type — the attachment record is just a path + metadata. No schema change to the attachment record itself; the platform work is generalizing the existing issue-only pipeline to any base record.
- **No cap on `/run count = N`.** The slash command accepts any positive integer. Identical-payload bulk fires (the `/run` form path) are fine for retries and cron-like workloads.
- **Diversity across multiple `workflow.run` calls is the caller's responsibility.** The workflow itself treats every call as independent. When the user wants varied outputs across a batch ("10 distinct brief angles"), they go through the main chat agent — which uses its tools (`read_records` to see what's already in the base, the workflow's trigger schema, `workflow.run` to fire each call) to construct N distinct payloads and fire them with a shared `batch_id`. The `/run` form path is for cases where identical payloads are fine; anything that needs variation goes through chat. This keeps the workflow syntax single-record-clean and pushes domain-aware diversity reasoning up to an agent that can think.
- **Post-approval tool failure flips the record to an error state.** When a post-approval tool errors after the user approved, the runtime sets `review_status = post_approval_failed` on the record. This pulls the record back into the Review tab list (filter widens to `needs_review` ∪ `post_approval_failed`). The detail pane surfaces which tool errored and the error message; the per-record chat session continues, so the user can ask the review companion to retry the post-approval block (`retry_post_approval` tool call) or revert the decision (`capture_decision({ outcome: "revise_requested" })` to start over). Approval is *not* silently lost — the user must explicitly retry or re-decide.
- **Review-decision outcomes are a fixed enum in v1: `approve | revise_requested | rejected`.** The review companion's `capture_decision` tool accepts only these values. Review nodes don't configure custom outcomes per node. Workflow-author-defined outcomes is a Phase 2 candidate if real use cases appear; keeping it fixed in v1 simplifies the agent's tool spec and Evolution's signal aggregation.
- **Notifications: sidebar badge only.** When records are in `needs_review` (or `post_approval_failed`) for a Proposal, a dot indicator appears on that Proposal's sidebar entry (no count). The main chat returns immediately after `/run` submission ("10 runs started") and does *not* stream per-run completion. The user notices pending work via the sidebar; opens the Proposal to triage. Keeps the chat surface uncluttered when firing batches in the background.
- **Per-record chat session is cascade-deleted with the record.** If the user deletes a `Briefs` record, its review session (and any structured-capture `RecordFeedbackRecord` rows tied to it) goes with it. No orphaned sessions. The `RecordFeedbackRecord` rows are reference data for Evolution; once the record is gone, those rows refer to non-existent provenance and should be pruned alongside it.
- **`kind: "proposal"` plugins render only Review + Workflow tabs.** The default plugin UI chrome — Bases tab, default plugin home, any other surfaces a regular plugin might show — is suppressed when `plugin.kind = "proposal"`. The synthetic plugin should look like a Proposal, not a plugin with extras peeking through.
- **Fresh Proposal opens with an empty workflow canvas; NL builder is the primary entry.** No pre-seeded `trigger → agent → review` skeleton. The user describes the workflow in natural language and the builder agent constructs it. **The only hard requirement: anything the builder produces must conform to the workflow syntax** defined below (linear `trigger → tool* → (agent → tool* → review)+ → postApproval?`). The builder agent must validate against the grammar; the editor must reject saving an invalid graph. Direct hand-editing in the editor is still possible after creation, also subject to the same validation.

## Workflow syntax (v1)

A Proposal's workflow must conform to this grammar:

```
workflow     := trigger(invokable | cron)  tool*  segment+  postApproval?
segment      := agent  tool*  review
postApproval := tool+              // optional; runs in parallel on the `approve` branch of the LAST review
```

Trigger kinds:
- **`invokable`** — fired by `workflow.run` calls from any agent or via the `/run` slash command. The trigger config UI exposes a typed field list (same pattern as tool node configs); callers must supply values matching that schema.
- **`cron`** — fires itself on a schedule, no caller required.

**Rules:**
- **No consecutive agent nodes.** Every agent's output is checkpointed by exactly one review immediately after it (tool nodes between agent and review are allowed, but no second agent).
- **Tool nodes are plumbing, allowed anywhere except in a review's slot.** Pre-processing tools can sit between the trigger and the first agent; side-effect tools can sit between an agent and its review; post-approval tools can sit after the final review.
- **Condition nodes** are allowed *between segments* (after a review, before the next segment's agent) to express branching on review outcomes. They cannot sit inside a segment.
- **Post-approval tools fan out**, they do not chain into more agents. Once approved, the workflow finishes the parallel post-approval block and the run completes.
- **No graph cycles** except the implicit revise-edge that loops a review back to its own segment's agent.

**Implications that previously needed explicit config:**
- `artifact_source` is implicit — it's the segment's agent.
- `revise_target` is implicit — same agent. The revise edge is auto-wired by the editor; the author never picks it.
- The cascade rule for revisions reduces to "re-fire the one agent in this segment." No multi-node cascade.

**What this syntax deliberately can't model (accepted trade-offs in v1):**
- *Mechanical agent transforms that don't deserve review* (translate, format, summarize) — must be composed into a single richer agent instruction.
- *Parallel candidate generation* (3 drafts → pick one).
- *Agent-self-loops not driven by revision* (iterate until N) — belongs in a different surface.
- *Pure decision gates with no artifact* — must precede with a no-op or skip Proposals.

A `skipReview: true` per-agent escape valve is an explicit Phase 2 candidate if the mechanical-transform case bites in real usage. Not in v1 — keeping the syntax strict makes Evolution's per-agent attribution clean.

## Feedback signal shape (Phase 1 must capture)

Two channels are produced from each per-record review session: **raw conversation** (the chat session itself, for human auditability) and **distilled structured events** (written by the review companion's tool calls — what Evolution consumes). Phase 1 ships both. Both distilled event types share one storage channel: **`RecordFeedbackRecord`**.

**Why one channel.** `RecordFeedbackRecord` (`store.ts:488`) already carries the provenance keys we need (`recordId`, `workflowId`, `workflowRevisionId`, `workflowRunId`, `workflowNodeRunId`, `submittedBy`, timestamps). Extending it keeps all record-targeted feedback queryable from one table — consistent with the foundation framing of "any plugin's records can carry this signal," and lets Evolution join on a single source.

**Review session** — one per record, persisted as a chat session attached to the record using existing chat-session storage:
```
session {
  sessionId,
  recordId,
  startedAt,
  messages: [...]   // user + agent + agent tool-call messages; reuses workspace chat-session schema
}
```

**`RecordFeedbackRecord` extensions needed:**
- New columns: `attemptIdx`, `reviewSessionId`, `reviewNodeId`, `batchId` (all nullable on rows from other sources)
- `source` enum gains values: `"review_decision"`, `"review_revision_request"`

**Decision event** — written by the review companion's `capture_decision` tool call. Stored as a `RecordFeedbackRecord` row:
```
RecordFeedbackRecord {
  source: "review_decision",
  recordId, workflowRevisionId, workflowRunId, workflowNodeRunId,   // existing provenance
  reviewNodeId, reviewSessionId, attemptIdx, batchId,                // new columns
  rating: "approved" | "revise_requested" | "rejected",              // the outcome
  note: "<rationale>",                                                // short text the agent extracted from conversation
  submittedBy, createdAt,
}
```

The `fromStatus` / `toStatus` framing isn't stored explicitly — `fromStatus` is always `needs_review` for review_decision rows, `toStatus` is `rating`. Recoverable cleanly without an extra column.

**Revision request** — written by `capture_revision_request`. Stored as a `RecordFeedbackRecord` row with structured detail in `correction`:
```
RecordFeedbackRecord {
  source: "review_revision_request",
  recordId, workflowRevisionId, workflowRunId, workflowNodeRunId,
  reviewNodeId, reviewSessionId, attemptIdx, batchId,
  note: "<whatToChange>",                                             // agent's distillation
  correction: {                                                       // existing JSON column
    exemplarRefs: [
      { baseId, recordId, polarity: "positive" | "negative", reason }
    ]
  },
  submittedBy, createdAt,
}
```

A revision request and the decision that triggered it (`rating: "revise_requested"`) are two separate rows authored close in time with the same `reviewSessionId` + `attemptIdx`. Evolution joins them when needed.

`SubagentRunRecord.context.revision_context` reads the latest revision request for `(recordId, attemptIdx)` and injects it when the segment's agent re-runs.

**Implicit signal** — derived from existing state, no new writes needed:
- `timeToDecision` per attempt = `RecordFeedbackRecord.createdAt − run-parked timestamp`
- `attemptCount` per `(runId, reviewNodeId)` — already on `WorkflowNodeRunRecord` state
- `cleanApproval` boolean = approved on first attempt with no revision request rows
- `revisionRatio` across runs of the same revision
- `sessionLength` = message count in the per-record chat session (proxy for "how much discussion did this take")

**Provenance** — already on records via migration `003`. Every record produced by a workflow knows which `workflowRevisionId` made it. Evolution joins on this.

## Reuse vs net-new

| Concern | Today | Action |
|---|---|---|
| `review_status` field | System field on every base, options `["pending","approved"]` (`store.ts:965`) | Extend per-base options to `["pending","needs_review","approved","revise_requested","rejected","post_approval_failed"]` via `config.options` |
| `attachment` field | System field on every base (`store.ts:976`); upload pipeline issue-only | **Net-new:** generalize upload/retrieval pipeline off issues |
| Workflow pause/resume | Approval-pending state exists | **Net-new (small):** object-status-change → resume hook |
| `object_write` tool node | Exists (`store.ts:111`) | Reuse |
| Workflow versioning | `WorkflowRevisionRecord` + revisions API exists (`store.ts:1467`) | **Reuse.** Evolution will mint new revisions through the same API. |
| Record → workflow-revision provenance | Exists (migration `003`, `store.ts:449`) | **Reuse.** Lets Evolution attribute feedback to a specific revision. |
| Builder agent tools | `plugin_workflow_*` exist | **Net-new:** `plugin_workflow_add_review_node` |
| Synthetic plugin creation | `createWorkspacePlugin` (`app.ts:15669`) | Reuse with a `kind: "proposal"` flag |
| `RecordFeedbackRecord` | Exists today (`store.ts:488`) with provenance keys (recordId, workflowRevisionId, workflowRunId, workflowNodeRunId, submittedBy, timestamps) and `rating`/`note`/`correction`/`source` fields | **Extend.** Add `attemptIdx`, `reviewSessionId`, `reviewNodeId`, `batchId` columns. Expand `source` enum with `review_decision` and `review_revision_request`. Single channel for both event types Evolution consumes. |
| Plugin workflow editor | Exists as-is | **Reuse** — the Proposal's Workflow tab mounts the same editor, scoped to the single workflow inside this Proposal's synthetic plugin |
| Review tab list | None | **Net-new (small).** Saved query on `review_status = needs_review` scoped to this Proposal's bases. |
| Review detail pane (artifact + per-record chat) | None | **Net-new — biggest UX investment for Proposals.** Artifact viewer on top + chat session with the review companion below. |
| Per-record chat session storage | Existing chat-session infrastructure for the workspace main chat | **Reuse.** Each record gets its own session record using the same storage. Link from record → session. |
| Review companion agent | None | **Net-new:** canonical system prompt + curated tool surface (`read_record`, `read_attachments`, `read_workflow_provenance`, `search_records`, `capture_decision`, `capture_revision_request`, `retry_post_approval`). |
| Structured-capture tools | None | **Net-new:** the agent-callable tools that distill the chat into decision events and revision requests. |
| Workspace main chat | Exists today (`+ New chat` in sidebar) | **Reuse.** No per-Proposal chat surface needed; main chat is the only place `/run` lives. |
| `/run` slash command | Slash command infrastructure may exist for other commands; no `/run` today | **Net-new:** the `/run` flow (workflow picker → typed payload form → count → submit) wired to fire `workflow.run` calls. |
| Workflow-as-tool API | Workflows are runnable from the editor/triggers, not registered as tools | **Net-new (small):** every workflow with an `invokable` trigger auto-registers as a callable in the workspace tool surface. Tool schema is derived from the trigger's typed field list. |
| Agent tool surface generally | Agent tool-calling infrastructure exists | **Reuse.** Workflow-as-tool plugs into the same surface today's agents use to call HTTP tools. |
| Trigger node typed-payload config UI | Tool nodes already have a typed field list config UI | **Reuse pattern, new on triggers.** Add the same typed-field-list UI to the trigger node when its kind is `invokable`. |

## Phasing

### Phase 1 — Minimum loop, Evolution-ready signal capture

- Proposal (synthetic plugin wrapping exactly one workflow) with two tabs: Review (default) + Workflow
- Sidebar entry alongside Automations / Skills / Projects (full-screen overlay pattern)
- `review` node type wired to existing `object_write` + parked-run + status-change resume
- **`invokable` trigger kind** with typed-field-list payload config on the trigger node (reuses tool-node config pattern)
- **`workflow.run` tool surface** at the workspace level, auto-populated by every invokable workflow
- **`/run` slash command** in the workspace main chat: workflow picker → payload form → count → fires N calls with shared `batch_id`. Chat acknowledges "N runs started" and does not stream completion.
- Review tab list: `needs_review` records scoped to this Proposal's bases
- Review detail pane: artifact viewer + per-record chat session
- **Review companion agent** with canonical system prompt and tool surface: `read_record`, `read_attachments`, `read_workflow_provenance`, `search_records`, `capture_decision`, `capture_revision_request`, `retry_post_approval`
- All decisions and feedback flow through the review companion's tool calls — no shortcut buttons in v1
- Structured-capture tool outputs (decision events, revision requests) stored against `(workflowRevisionId, nodeId, runId, recordId, attemptIdx, sessionId, batchId?)` per the schemas above
- Both revision pathways work: per-record revise (in-run, same record, chat session continues) and fresh invocation (new `/run` from main chat)
- NL builder agent extended with `add_review_node` tool so users can build the workflow from the Workflow tab in NL

### Phase 2 — Make it pleasant

- Shortcut decision affordances (quick approve/reject buttons) that call the same `capture_decision` tool the agent uses
- Cross-Proposal inbox at the workspace level (rollup of `needs_review` across all Proposals)
- `/run` payload field for "avoid these approved records" so dedup hints get plumbed into trigger payloads natively
- Customizable review companion (per-Proposal system prompt override)
- `skipReview: true` per-agent escape valve for mechanical transforms, if usage demands it

### Phase 3 — Scale

- Multi-reviewer per record, role assignment
- External share links
- Topology-changing evolutions (would land in Evolution, but Proposals provides the signal)
- Workflow-as-tool exposed beyond agents (HTTP API, public endpoints)

## Open questions

1. ~~Does a Proposal itself have a status~~ **Resolved: no.** A Proposal is just the wrapper around one workflow; status lives on records and workflow runs, never on the Proposal itself.
2. ~~One workflow or many per Proposal in v1?~~ **Resolved: exactly one workflow per Proposal.** The "Proposal" abstraction is "a reviewable workflow," not a container of workflows.
3. ~~Proposal ownership~~ **Resolved: workspace-scoped.** There is no user-ownership concept in the system; workflows (and therefore Proposals) live at the workspace level. `submittedBy` on feedback rows is authorship, not ownership.
4. ~~Attachment pipeline scope~~ **Resolved: generalize fully off issues.** Ship the proper platform-level extension so any base record can carry attachments end-to-end. No Proposal-only shortcut.
5. ~~Decision-option vocabulary~~ **Resolved: fixed set in v1 — `approve | revise_requested | rejected`.** Workflow-author-defined per-node outcomes is a Phase 2 candidate.
6. ~~Where decision events live~~ **Resolved: extend `RecordFeedbackRecord`.** Decisions and revision requests are both rows there, distinguished by `source` enum. New columns: `attemptIdx`, `reviewSessionId`, `reviewNodeId`, `batchId`. Revision-request detail lives in the existing `correction` JSON column.
7. ~~Proposal ↔ Evolution surface boundary~~ **Resolved: Evolution is entirely its own destination.** Evolution is a peer sidebar entry to Proposals, opens its own full-screen overlay. Proposals does not surface Evolution events (no banners, no version pills, no "last evolved" timestamps) — users go to the Evolution surface to see what changed. The seam is clean: Proposals is purely review-side; Evolution owns all workflow-change history and proposal/accept/decline UI.
8. ~~Editor "Run" button~~ **Resolved: reuses the `/run` form with the workflow pre-selected and count locked to 1.** Same backend, same validation, two entry points.
9. ~~Agent-output → attachment mapping~~ **Resolved: runtime writes the agent's output to `/records/{recordId}/attempt-{N}.{ext}` and creates an `IssueAttachmentRecord`-shaped row on the base record's system `attachment` field.** Artifact can be any file type; `kind/mimeType/sizeBytes` set from output. No schema change to the attachment record.
10. ~~Concurrency cap on `/run count = N`~~ **Resolved: no cap.** Identical-payload bulk fires are fine. Diversity across calls is the caller's (chat agent's) responsibility, not the runtime's.
11. ~~Post-approval tool failure semantics~~ **Resolved: record flips to `post_approval_failed`** and re-appears in the Review list with error context. Review companion gains a `retry_post_approval` tool. User can retry or revert the decision; approval is never silently lost.
12. ~~Workflow-as-tool permissioning~~ **Resolved: workspace-scoped, no per-user gates.** Anyone in the workspace can call `workflow.run` on any invokable workflow. Run provenance is captured in `invokedBy.id` for audit, not authorization.
13. ~~`/run` discovery~~ **Resolved: picker only.** No separate "what can I run?" listing in Phase 1. Discovery affordances can come later if usage demands.
14. ~~Notification shape for batch runs~~ **Resolved: sidebar badge only** (dot indicator, no count, no chat stream).
15. ~~Cross-Proposal `/run` UX~~ **Resolved: flat list with fuzzy search.** All invokable workflows in one picker, ranked by recency or frequency. No grouping by Proposal in Phase 1.
16. ~~Per-record chat session lifecycle on record deletion~~ **Resolved: cascade delete.** Session + structured-capture rows tied to the record are pruned with it.
17. ~~Review companion's record-resolution surface~~ **Resolved: include `search_records({ baseId?, query })`.** Agent can resolve natural-language record references ("the Q2 launch recap brief") into concrete records to read.

## Out of scope (now)

- **Evolution itself.** Sibling feature shipped in the same goal command — see `docs/evolution.md`. This doc covers Proposals only; Evolution covers consumption of the feedback signal and the proposal/accept/decline UI.
- Multi-reviewer / role-based review nodes
- External share links / anonymous reviewers
- Live co-editing of artifacts on the review page
- Topology-changing evolutions
- Cross-instance / template-level evolution (we ship instance evolution only)
- A first-class non-plugin container (the real architectural refactor we deferred — see path #2/#3 in the design discussion)
