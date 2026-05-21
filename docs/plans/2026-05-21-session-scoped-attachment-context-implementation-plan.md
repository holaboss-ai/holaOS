# Session-Scoped Attachment Context Implementation Plan

## Goal

Make attachments behave like session-scoped conversational artifacts without faking a "reattach everything every turn" mechanism.

## Implementation shape

### 1. Persist attachment provenance on the session timeline

Files:

- `runtime/state-store/src/store.ts`
- `runtime/state-store/src/store.test.ts`

Work:

- add `metadata` storage to `session_messages`
- persist `attachments` into `session_messages.metadata` on user turns
- migrate older workspace runtime databases so the new metadata column exists
- add test coverage for metadata round-tripping and message ordering

### 2. Write attachment metadata when a turn starts

Files:

- `runtime/api-server/src/claimed-input-executor.ts`
- `runtime/api-server/src/claimed-input-executor.test.ts`

Work:

- when the runtime inserts the user session message for a claimed input, copy the current turn's attachments into the new message metadata

### 3. Prefer timeline metadata in session history

Files:

- `runtime/api-server/src/app.ts`
- `runtime/api-server/src/app.test.ts`

Work:

- serialize attachment metadata from `session_messages.metadata` for new histories
- keep a compatibility fallback to `agent_session_inputs.payload.attachments` for legacy message rows that predate the metadata change

### 4. Project prior attachment turns into runtime context

Files:

- `runtime/api-server/src/ts-runner.ts`
- `runtime/api-server/src/agent-runtime-prompt.ts`
- `runtime/api-server/src/agent-runtime-config.ts`
- `runtime/harnesses/src/types.ts`
- `runtime/api-server/src/agent-runtime-config.test.ts`
- `runtime/api-server/src/ts-runner.test.ts`

Work:

- load earlier user turns with attachments from session history
- exclude the current input's just-written user message from the historical block
- build a bounded session-attachment timeline context with:
  - message id
  - timestamp
  - a short text preview
  - attachment metadata and staged workspace paths
- inject that context into the runtime prompt/config pipeline

### 5. Document the interpretation

Files:

- `docs/implementation_notes/session-scoped-attachment-context-implementation-notes.html`

Work:

- record the design decision to use append-only timeline provenance
- note the deliberate omission of explicit remove/replace semantics in this pass
- capture the tradeoff that earlier attachments are preserved as session context instead of being replayed as current-turn attachments

## Behavioral expectations after this change

- Turn 1 can attach a file and mention it.
- Turn 2 can refer to that file without reattaching it.
- Turn 2 can also attach a new file without dropping the earlier one from session context.
- Reattaching the same file on a later turn creates another attachment event in history, just like repeating text on a later turn creates another message.

## Validation

- `bun --filter=@holaboss/runtime-state-store run typecheck`
- `bun --filter=@holaboss/runtime-api-server run typecheck`
- `cd runtime/state-store && ./node_modules/.bin/tsx --test --test-force-exit src/store.test.ts`
- `cd runtime/api-server && ./node_modules/.bin/tsx --test --test-force-exit src/agent-runtime-config.test.ts src/claimed-input-executor.test.ts src/ts-runner.test.ts src/app.test.ts`

## Known follow-up work

- explicit detach or replace semantics are still undefined
- prompt projection is intentionally bounded, so very old attachment turns may be summarized only through truncated context
