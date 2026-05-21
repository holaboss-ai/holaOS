# Session-Scoped Attachment Context Design

## Problem

The runtime previously treated attachments primarily as fields on the current queued input. That worked for the turn that introduced the file, but it did not make the file a first-class part of the session's conversational context. Text continuity already behaves like session state, so attachment continuity should follow the same model.

## Product model

- A user turn can introduce one or more attachments.
- Those attachments become part of the session's conversational timeline.
- Later turns in the same session can refer back to them without reattaching.
- Reattaching the same file later is a new timeline event, not a replacement of the earlier one.
- Omission of attachments on a later turn means "no new attachments on this turn," not "drop prior session files."

This should hold for any session kind, not just the main session path.

## Chosen design

Implement attachment continuity as append-only conversation history:

- Persist attachment metadata directly on `session_messages.metadata.attachments`.
- Keep each user turn as its own provenance record.
- Resolve earlier attachment context for later runs from prior session messages.
- Project that context into runtime prompt state as a session attachment timeline, instead of pretending earlier files are current-turn attachments.

This preserves both:

- timeline structure: which turn introduced which files
- later availability: future turns can still refer to earlier files

## Why this model

It matches how users already think about text turns:

- Turn 1 says something.
- Turn 2 can refer back to it naturally.

Attachments should behave the same way:

- Turn 1 introduces `report.html`.
- Turn 2 can refer to "that report" without reattaching it.

The key distinction is that we are not reattaching files on every turn. We are treating them as conversation artifacts that remain part of session context after introduction.

## First-pass scope

- Add attachment metadata to new `session_messages` rows.
- Migrate older `session_messages` tables to include the metadata column.
- Prefer message-stored attachment metadata in history responses.
- Fall back to legacy `agent_session_inputs.payload.attachments` lookups for older rows.
- Build a bounded session-attachment context block from earlier user turns with attachments.

## Non-goals

- No explicit remove or replace semantics in this pass.
- No change to desktop staging behavior.
- No attempt to inline every historical file into every prompt.
- No special-case fix that only applies to main sessions or only to subagents.

## Tradeoffs

- This keeps attachment continuity aligned with the conversation timeline, which is the right product abstraction.
- It avoids the wrong "reuse as current-turn attachments" behavior.
- It does mean older files are represented in prompt context through timeline metadata and staged paths, not through unconditional reinjection as fresh attachments on each turn.

## Open questions

- Whether a later phase should add explicit detach or replace semantics.
- Whether some workflows will eventually need a richer runtime path for selectively reopening prior files beyond the current timeline-context projection.
