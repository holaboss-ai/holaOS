# Integration-Backed Apps

Use this reference when an app depends on a third-party provider, user OAuth, API credentials managed by the platform, or bridge-mediated provider calls.

## Provider Discovery First
- Do not infer provider ids from brand names or product names.
- If `workspace_integrations_list_catalog` is available, call it before writing the manifest or bridge client.
- Use the exact canonical `provider_id` everywhere:
  - `integrations[].key`
  - `integrations[].provider`
  - `createIntegrationClient("<provider_id>")`
  - any connection-status helper or provider-specific config

## Required App Structure
For apps whose behavior depends on provider authorization, keep these pieces separate:
- a provider client wrapper around `createIntegrationClient(...)`
- a cheap connection-status probe that checks current authorization with a low-cost identity endpoint such as `/me`, `/account`, or equivalent
- a UI/API surface that exposes current connection status
- app tools that call the provider client only after the current status is known

Do not scatter raw provider proxy calls across unrelated files. Keep provider calls and status/error mapping centralized in the client wrapper.

## Connection Status Contract
When the app needs current authorization state, expose a live status helper instead of relying on cached local flags.

Recommended states:
- `connected`
- `not_connected`
- `pending_authorization`
- `needs_reauth`
- `rate_limited`
- `validation_failed`
- `upstream_error`
- `not_found` when the provider or resource lookup itself is missing

Recommended return shape:

```ts
type ConnectionStatus = {
  connected: boolean;
  state:
    | "connected"
    | "not_connected"
    | "pending_authorization"
    | "needs_reauth"
    | "rate_limited"
    | "validation_failed"
    | "upstream_error"
    | "not_found";
  message: string;
  identity?: Record<string, unknown>;
  retryAfterSeconds?: number;
  nextAction?: "connect" | "wait" | "reauth" | "retry";
};
```

## Status and Error Mapping
Map provider responses into stable app-level states:
- `200-299` from the probe endpoint: `connected`
- `401` or `403`, or a bridge/provider error that clearly means no bound integration: `not_connected`
- explicit upstream lifecycle signals such as `INITIATED`, pending OAuth, or unfinished authorization: `pending_authorization`
- revoked, expired, or re-consent-required signals: `needs_reauth`
- `429`: `rate_limited` and include retry guidance if available
- other `4xx`: `validation_failed`
- `5xx`, transport failures, or unknown bridge/provider failures: `upstream_error`

Do not collapse `pending_authorization` into `not_connected` when the provider or bridge gives you enough information to distinguish them.

## Tool and UI Expectations
- If the app exposes MCP tools and any tool behavior depends on current authorization, add a mandatory `<prefix>_get_connection_status` tool.
- Put the status tool first in the app's MCP tool list when any downstream MCP tool depends on provider connectivity.
- If the app has a UI, expose a `/api/connection-status` style route and have the UI poll or refresh it when needed.
- Before telling the user to reconnect, re-run the live status helper.

## Persistence Rules
- Persist connection observations only as telemetry or diagnostics.
- Cached values such as `connected`, `needs_connection`, or the last refresh result are not authoritative truth.
- Do not use persisted local state as the sole input for user messaging, readiness checks, or tool gating.

## Messaging Rules
- If the live status is `pending_authorization`, tell the user authorization is still pending and give the shortest next step.
- If the live status is `needs_reauth`, ask for reauthorization explicitly.
- If the live status is `not_connected`, only then tell the user to connect the account.
- Do not tell the user to reconnect based only on a stale cached app-local row.
