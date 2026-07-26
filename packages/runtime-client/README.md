# @holaboss/runtime-client

TypeScript client for the in-sandbox Holaboss runtime API server (Fastify, port 8080
inside sandboxes / dynamic port on desktop).

## Status

Foundation in progress. F1: skeleton only. The real client lands in F2.

## Why this exists

`holaOS/desktop/electron/main.ts` has 59 inline `requestRuntimeJson(...)` calls plus
hand-rolled retry/timeout/error parsing. This SDK extracts that machinery so:

- Main process imports typed methods instead of writing fetch boilerplate.
- A future `runtime:rpc` IPC channel can let the renderer use the same SDK by
  swapping the transport — paving the way for renderer-direct runtime access.
- The Python `sandbox-runtime` and the desktop both speak the same protocol;
  making the contract explicit on the TS side reduces drift.

## Scope

- `request<T>(opts)` — generic request with retry/timeout/error parsing
- `createRuntimeClient({ getBaseURL })` — factory wiring transport + typed
  domain methods (workspaces, apps, sessions, integrations, cronjobs, memory,
  notifications, task-proposals, outputs)

## Not in scope

- Code generation from OpenAPI (runtime-api-server has no Zod schemas yet —
  separate effort)
- Renderer transport (handled by the future `runtime:rpc` IPC channel)
- Python client (separate effort, contract-aligned only)
