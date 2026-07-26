# Runtime Self-Contained Operations — Archived Plan

This document is preserved as historical context.

Status:
- Superseded on 2026-03-26 by the TypeScript-contained runtime.
- The old pre-TS runtime tree and legacy validation path have been removed.

What this plan originally described:
- moving workspace/file/app lifecycle operations into the runtime
- removing backend shell orchestration
- making runtime packaging self-contained

What shipped instead:
- runtime API, runner orchestration, workspace MCP hosting, and bundle packaging moved to TypeScript under:
  - `runtime/api-server/`
  - `runtime/harness-host/`
  - `runtime/state-store/`
  - `runtime/deploy/`
- runtime validation now runs through the TypeScript package tests via `npm run runtime:test`
- packaged runtime bundles no longer carry Python source or Python dependency payloads

Current authoritative runtime entrypoints:
- `runtime/api-server/src/app.ts`
- `runtime/api-server/src/runner-worker.ts`
- `runtime/api-server/src/ts-runner.ts`
- `runtime/api-server/src/workspace-mcp-host.ts`
- `runtime/harness-host/src/index.ts`
- `runtime/deploy/build_runtime_root.sh`

Archive note:
- The original task-by-task instructions in this file targeted a Python/FastAPI runtime layout that no longer exists in the repository.
- If more historical detail is needed, recover an earlier revision from git history rather than using the deleted paths in this archived document as implementation guidance.
