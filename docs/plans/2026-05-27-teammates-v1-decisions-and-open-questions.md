# Teammates V1 Decisions And Open Questions

This note captures the current product decisions for `Teammates` v1 so implementation can start without waiting for every edge case to be resolved.

Source of truth for the original product direction:
- Notion `Teammate` page
- Notion `Feature Proposal`
- Notion `Teammate Implementation Details`

## Locked V1 Decisions

### Core model
- The `Workspace Manager` is separate from `Teammates`.
- The current `main_session` remains the `Workspace Manager`.
- `task_proposals` are obsolete and should be removed completely from the v1 product model.
- `Issue` is the only durable delegated-work object in v1.
- Dependencies are out of scope for v1.
- Parent/child or sub-issues are out of scope for v1.

### Teammates
- Every workspace has a fixed built-in `General` teammate.
- The built-in `General` teammate is backed by the current subagent execution path.
- The built-in `General` teammate is fixed and not user-editable in v1.
- Users can create additional custom teammates.
- Custom teammates have:
  - `name`
  - `instructions`
  - multiple freeform `SKILL.md` entries
- All teammates use the same underlying execution substrate as the current subagent path.
- Routing between `General` and custom teammates is decided from teammate `instructions` and `skills`, with no separate rule engine in v1.
- Teammates have only two lifecycle states in v1:
  - `active`
  - `archived`
- Archived teammates disappear from navigation.
- Archiving a teammate:
  - cancels any active assigned issue run
  - moves all of its assigned issues back to `Todo`
  - clears the assignee on those issues

### Issues
- Manual issue creation uses this v1 shape:
  - `title`
  - `assignee`
  - `description`
  - `status`
  - optional `priority`
  - optional attachments
- `description` is the only body field in v1.
- Manual issue creation does not require an opening chat message.
- Manual issue creation does not default the status; the user must choose it.
- Manual issue creation may leave `assignee` empty.
- The manual issue form may preselect `General`, but the user can clear the assignee and leave the issue unassigned.
- Manager-created issues:
  - are created directly, with no proposal stage and no confirmation gate
  - are always created in `Todo`
  - are always assigned to a teammate at creation time
  - pass structured fields and attachments only
  - do not seed a visible manager-authored message into the issue thread
- Manager-created issue handoff lives in structured issue fields, not in the issue chat thread.

### Issue lifecycle
- V1 issue states are:
  - `Backlog`
  - `Todo`
  - `In Progress`
  - `In Review`
  - `Done`
  - `Blocked`
- `Backlog` is a user-managed parked state.
- New manager-created issues always start in `Todo`.
- A `Todo` issue auto-dispatches when:
  - it has an assignee
  - it is not actively running
- A `Todo` issue with no assignee stays idle.
- Moving an issue into `Todo` should auto-start it if it has an assignee.
- Assigning a teammate to an idle `Todo` issue should auto-start it.
- An issue moves to `In Progress` only when the assigned teammate actually starts running.
- Successful completion may move an issue directly to `Done`.
- `In Review` is reserved for work that explicitly needs human review.
- Teammates may move issues into `Blocked` or `In Review`.
- Entering `Blocked` requires a blocker reason.
- Manually stopping an active issue run from the UI cancels the run and moves the issue to `Blocked`.
- Only one active run is allowed per issue.

### Issue continuity and chat
- Each issue owns a single persistent issue session/thread.
- The issue session persists across multiple runs over time.
- Reopening work does not create a brand-new issue thread.
- Replies on `Blocked`, `In Review`, or `Done` continue the same issue session.
- Teammates do not own continuity across issues; issues do.
- If an idle issue is reassigned, the issue keeps the same session history.
- The newly assigned teammate inherits the full issue thread history.
- Prior teammate messages remain visible in the issue thread after reassignment.
- Only the user and the currently assigned teammate should be able to post in the issue thread in v1.
- Custom teammates do not get standalone chat surfaces; users interact with them only through issue threads.
- The `Workspace Manager` does not post into issue threads in v1.
- The per-issue chat thread should reuse the current chat pane rather than introducing a distinct bespoke thread UI.

### Review and blocked flows
- If an issue is in `In Review` and the user replies with requested changes, it moves back to `Todo`, keeps the same assignee, and auto-starts again.
- If an issue is in `Blocked` and the user answers in the issue thread, it moves back to `Todo`, keeps the same assignee, and auto-starts again.
- If the user replies on a `Done` issue with more changes, the same issue reopens to `Todo` and auto-starts again.
- Users cannot reply in the issue thread while the issue has an active run; replies are blocked until the run reaches a non-running state.

### Running-state edit restrictions
- While an issue is actively running, the following should be blocked:
  - issue replies
  - reassignment
  - `title` edits
  - `description` edits
  - attachment edits
  - any issue field mutation that would materially alter execution

### Priority
- Priority is part of the v1 issue model.
- Priority is optional.
- Priority values are:
  - `Critical`
  - `High`
  - `Medium`
  - `Low`

### Dashboard and navigation
- Leave `Inbox` present for now but empty after proposal removal.
- V1 should include an aggregated workspace homepage dashboard, not only issue-detail observability.
- Desired dashboard direction includes:
  - teammate counts / enabled counts
  - tasks in progress
  - cost or spend summary
  - issue status rollups
  - run activity
  - recent activity
  - recent tasks

### Attachments
- Issue attachments are in scope for v1.
- The `Workspace Manager` must be able to pass attachments through when creating an issue from the main chat.

## Implementation Assumptions

These are the practical engineering assumptions implied by the current decisions.

### Existing runtime substrate to preserve
- Keep the current `main_session` model as the `Workspace Manager`.
- Keep the existing subagent execution substrate.
- Keep `subagent_runs`, `turn_results`, session history, and streamed output events as the runtime truth.
- Build the v1 product model on top of the runtime substrate rather than replacing the orchestration layer.

### Product model migration direction
- Remove `task_proposals` from product-facing flows.
- New delegated work should create `Issue` records directly.
- New issue execution should attach runtime execution to:
  - `issue_id`
  - `teammate_id`
- Historical proposal-era and background-task-era records do not need backfill for v1.
- Legacy runs may remain unlinked.

### Issue execution model
- Each issue should map to one persistent issue session.
- Runs are execution attempts within that persistent issue session.
- Reassignment changes which teammate is responsible for the next run, not the underlying issue session identity.

### Observability
- V1 needs issue-level trace, model, and token observability.
- The runtime already stores token usage in `turn_results`.
- The runtime already exposes session output streaming.
- Desktop productization still needs issue-oriented read models and surfaced views.

## Remaining Questions

These questions were intentionally deferred so implementation can start.

### Data model and persistence
- Should archived teammates remain queryable in backend read models for historical issue rendering, even though they disappear from navigation?
- Should teammate archival preserve a snapshot of teammate name and instructions on the issue/run records for historical display?
- Should attachments be stored only at the issue level, or also at the per-message level in the issue thread when users upload them during later turns?
- Should issue creation require a non-empty `description`, or is `title` alone enough?

### Issue execution behavior
- When a user edits an idle issue's `description`, should the next run automatically see the entire updated description as canonical issue context, or should diffs be surfaced explicitly in-thread?
- If an issue is reassigned while idle, should a visible system activity entry be added, even though the new teammate inherits the full thread?
- If a teammate moves an issue to `In Review`, should it be expected to include an explicit human-review request or checklist in the final assistant turn?
- If a teammate moves an issue to `Blocked`, what exact blocker payload shape should be stored beyond the required visible reason?

### Teammate authoring
- What is the exact UX for authoring multiple freeform teammate `SKILL.md` entries?
- Should custom teammate `instructions` and `skills` be editable while that teammate owns idle issues, or should edits require an explicit save-and-apply acknowledgment for future runs only?
- Should custom teammates support attachments or files as part of their durable authored profile in v1, or is text-only profile authoring enough?

### Dashboard and analytics
- Which dashboard cards are required for the first shipping slice versus safe follow-up work?
- Do workspace-level charts need real historical aggregation in v1, or are lightweight recent-window summaries sufficient?
- Should cost/spend on the dashboard be exact billing-backed data or a runtime-token-derived estimate for the first slice?

### Removal and compatibility
- How aggressive should the first pass be in removing `task_proposals`?
- Is it acceptable for old proposal-related codepaths and tables to remain temporarily unused behind the scenes during the migration, as long as the UI and runtime no longer rely on them?

## Suggested First Implementation Order

1. Introduce durable `teammates` and `issues` persistence models.
2. Attach new issue execution to `issue_id` and `teammate_id`.
3. Remove proposal-driven product flows and replace manager delegation with direct issue creation.
4. Reuse the existing chat pane for issue-thread rendering.
5. Add issue lifecycle transitions and auto-dispatch rules.
6. Add teammate archive behavior and issue reassignment restrictions.
7. Surface issue-level trace, model, and token observability.
8. Build the aggregated dashboard and empty inbox state.
