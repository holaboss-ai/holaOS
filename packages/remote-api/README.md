# @holaboss/remote-api

The public, transport-agnostic contract between the Holaboss desktop UI and the
runtime, built on [oRPC](https://orpc.dev). One canonical zod contract set, with
a server binding (mounted on the runtime's Fastify instance) and a typed client
(used directly from the desktop renderer and main process).

This supersedes the hand-maintained `@holaboss/runtime-client` — types are
derived from the contract, not synchronised by hand.

## Layout

| Export | Depends on | Use from |
|---|---|---|
| `@holaboss/remote-api/contract` | `@orpc/contract`, `zod` | anywhere (agents, MCP, forks) |
| `@holaboss/remote-api/server` | `@orpc/server` (+ `fastify` peer) | the runtime |
| `@holaboss/remote-api/client` | `@orpc/client` | desktop renderer / main |
| `@holaboss/remote-api` (root) | client + contract types | desktop |

## Server (runtime)

```ts
import { mountRemoteApi, type WorkspacesService } from "@holaboss/remote-api/server";

const workspaces: WorkspacesService = { list, get, update };
mountRemoteApi(app, { prefix: "/rpc", context: () => ({ workspaces }) });
```

Handlers delegate to the supplied `WorkspacesService`; throw
`WorkspacesServiceError` for known failures and the router maps them to typed
oRPC errors.

## Client (desktop)

```ts
import { createRemoteApiClient } from "@holaboss/remote-api/client";

const client = createRemoteApiClient({
  url: async () => `${(await window.electronAPI.runtime.getStatus()).url}/rpc`,
});

const { items } = await client.workspaces.list({});
await client.workspaces.update({ workspaceId, patch: { icon, icon_color } });
```

## Logging & tracing

Logging lives on the **server** (runtime). The client only attaches a correlation
id; it does not log.

- The client attaches an `x-request-id` header per call.
- The server honors that header (or generates one), echoes it in the response,
  and a middleware logs `remote_api.server.request` for every procedure with the
  `requestId`, `procedure`, `workspaceId`, `durationMs`, and error `code` — so a
  single grep on `requestId` ties a call's start/success/error lines together.

The server logger is pluggable (`RemoteApiLogger`): the runtime injects a pino
adapter; without one a structured-JSON console logger is used. Logs are IDs +
outcomes only — never request payloads.

```
remote_api.server.request  start    requestId=ab12  procedure=workspaces.update  workspaceId=ws_1
remote_api.server.request  success  requestId=ab12  procedure=workspaces.update  durationMs=2
```

Verify it: `bun packages/remote-api/scripts/logging-smoke.mjs`.

## Scope

Phase 1 vertical slice: the `workspaces` domain (`list`, `get`, `update`). The
runtime's existing REST routes remain mounted and unchanged; other domains and
operations (`create` / `delete` / `activate`, plus the eight other runtime-client
domains) migrate to this package incrementally following the same pattern.
