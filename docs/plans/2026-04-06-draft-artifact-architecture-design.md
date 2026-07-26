# Draft Artifact Architecture Design

**Problem:** Module apps can create successful local drafts, but the desktop chat only renders artifact chips when the draft is persisted as a session-bound app artifact on the current assistant turn. Today the architecture exposes two competing write paths: generic workspace outputs and session artifacts. Apps have adopted the generic path unevenly, which creates inconsistent behavior and weakens the contract for all future modules.

## Goals

- Make draft artifact persistence a first-class runtime capability, not app-by-app glue code.
- Ensure every successful draft tool call can attach an app-origin artifact to the active assistant turn.
- Preserve stable app routing so clicking an artifact always reopens the correct module surface.
- Give future apps a single SDK-level way to publish draft-like artifacts.

## Non-goals

- Redesign the desktop artifact UI.
- Replace the `outputs` table immediately.
- Introduce app-specific routing logic into the desktop.

## Current Architectural Split

### Path A: Generic workspace outputs

Apps currently have a bridge helper that writes to `/api/v1/outputs`.

Pros:
- generic
- already documented
- supports later patch/update flows

Cons:
- does not naturally bind to the current assistant turn
- requires the app to know `session_id/input_id` explicitly
- easy for app authors to use incorrectly for chat artifacts

### Path B: Session artifact persistence

The runtime already exposes `/api/v1/agent-sessions/:sessionId/artifacts`.

Pros:
- resolves `input_id` from session runtime state
- writes an app-origin output row
- matches how desktop chat expects bottom-of-turn artifacts

Cons:
- not exposed as the primary app SDK contract today
- current app execution path does not consistently propagate turn context to module MCP handlers

## Recommended Architecture

### 1. Canonical model

Use the `outputs` table as the single persisted storage model, with app-origin chat artifacts represented as output rows carrying:

- `session_id`
- `input_id`
- `module_id`
- `module_resource_id`
- `platform`
- metadata including:
  - `origin_type: "app"`
  - `artifact_type`
  - `external_id`
  - `presentation`

The session artifacts endpoint remains the canonical write API for turn-bound app artifacts. It is not a separate storage model; it is the correct scoped writer into the outputs model.

### 2. Context propagation

The runtime must propagate active execution context from the claimed input executor into every module-app MCP request:

- `X-Holaboss-Workspace-Id`
- `X-Holaboss-Session-Id`
- `X-Holaboss-Input-Id`

This turns session artifact publishing into a capability the app can use without bespoke plumbing.

### 3. SDK contract

Add an SDK/bridge-level helper for module apps:

- `publishSessionArtifact(...)`

This helper should:
- detect workspace execution context from incoming request headers
- require session scope for chat artifacts
- call the session artifacts endpoint
- normalize request shape
- no-op in local dev when Holaboss workspace context is absent

App authors should not choose between `/outputs` and `/artifacts` for draft tools. The SDK should choose the correct path.

### 4. Artifact routing contract

Every app artifact must carry metadata presentation:

```json
{
  "presentation": {
    "kind": "app_resource",
    "view": "drafts|posts|threads|contacts",
    "path": "/app-route/<id>"
  }
}
```

The desktop should remain generic and route entirely from `module_id + metadata.presentation`.

## Write-path rules

### Use session artifact publishing when

- a tool created or surfaced something that should appear under the assistant turn
- the result belongs to a conversation turn
- the artifact should be clickable from chat

Examples:
- Gmail draft creation
- Twitter/LinkedIn/Reddit post draft creation
- future CRM open-thread or contact-open tools surfaced in chat

### Use generic outputs when

- the write is not inherently tied to the current assistant turn
- the app is publishing background or non-chat operational state
- the output is created outside an agent tool invocation

## App-level API shape

Every draft-publishing helper should accept a normalized payload:

- `artifactType`
- `externalId`
- `title`
- `moduleId`
- `moduleResourceId`
- `platform`
- `metadata`

For draft tools:
- `externalId` should usually be the local draft/post id
- `moduleResourceId` should be the same stable app-local object id

## Migration plan

### Phase 1: Functional unification

- propagate turn headers into app MCP requests
- add session artifact SDK helper
- migrate Gmail/Twitter/LinkedIn/Reddit draft creation tools

### Phase 2: Contract hardening

- update app development docs to make session artifact publishing the default for chat-visible app results
- add shared helper tests
- add app contract tests covering one successful draft path per module family

### Phase 3: Compatibility cleanup

- mark `createAppOutput()` as not for chat-turn draft artifacts
- optionally rename it to clarify workspace/global scope
- keep compatibility for existing non-chat output flows

## Why this is the right long-term design

- It removes the ambiguous choice from app authors.
- It aligns the SDK contract with the desktop rendering contract.
- It keeps the desktop generic instead of encoding app-specific rules.
- It scales to future apps because the invariant becomes: “chat-visible app result => publish session artifact.”
- It avoids introducing another storage abstraction, because outputs already are the durable model.

## Success criteria

- Any successful draft tool call creates a chat-visible app artifact under the current assistant turn.
- Clicking the artifact opens the correct app route.
- Future apps can follow one documented SDK path without knowing internal chat rendering rules.
