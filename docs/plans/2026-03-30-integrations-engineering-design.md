# Integrations Engineering Design

Date: 2026-03-30
Status: Draft
Owner: Holaboss desktop/runtime

## Goal

Define a unified integration architecture for Holaboss that supports:

- OSS self-managed integrations
- managed-hosted integrations
- workspace and app-level account binding
- safe runtime delivery of integration capability into apps and tools

The design replaces direct dependence on `PLATFORM_INTEGRATION_TOKEN` with a structured broker model.

## Current State

The current repo already contains useful pieces, but they are not connected end to end.

### What exists

- app modules declare `integration` and `env_contract` in `app.runtime.yaml`
- modules such as Gmail and Sheets expect `PLATFORM_INTEGRATION_TOKEN` and related metadata
- the runtime parses `env_contract`
- the runtime can inject `HOLABOSS_USER_ID`

### What is missing

- `integration` metadata is not parsed into runtime models
- provider connection state is not modeled centrally
- workspace/app binding is not modeled
- app lifecycle execution does not inject provider integration data
- there is no dedicated credential broker contract

## Design Principles

### 1. Apps declare capabilities, not secrets

Apps should describe which provider capability they need. They should not rely on a provider token env variable as the primary integration contract.

### 2. Runtime owns binding resolution

The runtime should resolve:

- which provider account is selected
- whether the binding is valid
- whether the account has the needed scopes

### 3. Secrets should not live in workspace config

Secrets must not be stored in `workspace.yaml`, `app.runtime.yaml`, or prompt context.

### 4. Use short-lived execution grants where possible

Apps should preferably receive a short-lived app grant or call into a broker, not hold a long-lived provider token.

## Target Architecture

The architecture has four layers.

### 1. Integration Catalog

Catalog metadata for each provider:

- `provider_id`
- `display_name`
- `category`
- `supported_auth_modes`
- `supports_oss`
- `supports_managed`
- `default_scopes`
- `docs_url`

This can live in desktop config or runtime metadata and be rendered by the `Discover` UI.

### 2. Connection Store

A connection represents one external account connected by one Holaboss user.

Suggested shape:

```ts
interface IntegrationConnection {
  connection_id: string;
  provider_id: string;
  owner_user_id: string;
  account_label: string;
  account_external_id: string | null;
  auth_mode: "managed" | "oauth_app" | "manual_token";
  granted_scopes: string[];
  status: "active" | "expired" | "revoked" | "needs_reauth";
  secret_ref: string | null;
  created_at: string;
  updated_at: string;
}
```

In OSS, `secret_ref` can point to a local secure store entry.
In managed mode, it can point to control-plane-managed secrets.

### 3. Binding Store

A binding maps a workspace or app to a connection.

```ts
interface IntegrationBinding {
  binding_id: string;
  workspace_id: string;
  target_type: "workspace" | "app" | "agent";
  target_id: string;
  integration_key: string;
  connection_id: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}
```

This supports:

- workspace default bindings
- app overrides
- future agent overrides

### 4. Integration Broker

The broker is the execution boundary between apps and provider credentials.

Responsibilities:

- validate app grant
- resolve workspace/app binding
- refresh or retrieve provider token
- optionally proxy provider API calls
- emit typed auth and capability errors

## App Contract

### App manifest

Replace the current single `integration:` shape with a list-based declaration:

```yaml
integrations:
  - key: primary_google
    provider: google
    capability: gmail
    scopes:
      - gmail.send
      - gmail.readonly
    required: true
```

The runtime parser should include this in `ResolvedApplicationRuntime`.

### Runtime-injected environment

Preferred injected values:

- `HOLABOSS_APP_ID`
- `HOLABOSS_WORKSPACE_ID`
- `HOLABOSS_INTEGRATION_BROKER_URL`
- `HOLABOSS_APP_GRANT`

Optional compatibility values during migration:

- `WORKSPACE_GOOGLE_INTEGRATION_ID`
- `WORKSPACE_GITHUB_INTEGRATION_ID`
- `PLATFORM_INTEGRATION_TOKEN`

`PLATFORM_INTEGRATION_TOKEN` should become legacy compatibility only.

### Preferred execution model

Apps should call the local broker API rather than external providers directly.

Example:

```http
POST /api/v1/integrations/google/gmail/send
Authorization: Bearer <HOLABOSS_APP_GRANT>
```

This lets the broker keep provider tokens out of app processes.

## OSS And Managed Backends

### OSS backend

Components:

- local connection store
- local binding store
- local broker
- optional custom OAuth app config
- optional manual token import

Secrets can be stored in:

- macOS Keychain on desktop
- encrypted local file with a keychain-wrapped master key

### Managed backend

Components:

- control-plane-managed connection store
- hosted OAuth app registry
- hosted refresh flow
- policy and audit support

The runtime still talks to the same logical broker API. The difference is whether the broker resolves secrets locally or via the control plane.

## Runtime Changes Required

### 1. Parse integration metadata

Update runtime app parsing so `integration` / `integrations` become part of:

- workspace runtime planning
- installed app runtime parsing
- app lifecycle execution inputs

### 2. Build integration resolution step before app start

Before starting an app:

1. inspect its declared integration requirements
2. resolve matching bindings for the workspace/app
3. validate connection status and scopes
4. create an app execution grant
5. inject broker URL and grant into the app process

### 3. Standardize errors

The broker and runtime should emit typed errors:

- `integration_missing`
- `integration_not_bound`
- `integration_expired`
- `integration_scope_insufficient`
- `integration_unavailable_in_oss`

These should map cleanly to desktop UI states and actions.

## Broker API Outline

### Catalog and state

- `GET /api/v1/integrations/catalog`
- `GET /api/v1/integrations/connections`
- `GET /api/v1/integrations/bindings?workspace_id=...`

### Connection management

- `POST /api/v1/integrations/:provider/connect`
- `POST /api/v1/integrations/:provider/import-token`
- `POST /api/v1/integrations/connections/:connection_id/reconnect`
- `DELETE /api/v1/integrations/connections/:connection_id`

### Binding management

- `PUT /api/v1/integrations/bindings/:workspace_id/:target_type/:target_id/:integration_key`
- `DELETE /api/v1/integrations/bindings/:binding_id`

### Runtime execution

- `POST /api/v1/integrations/grants`
- `POST /api/v1/integrations/google/gmail/send`
- `POST /api/v1/integrations/github/repos/list`

The exact provider proxy routes can evolve, but the important decision is that app execution should go through broker-controlled capability endpoints.

## Security Model

### Must have

- no provider refresh tokens in workspace config
- no provider tokens in agent prompts
- short-lived app grants
- grant scoped to workspace, app, and provider capability
- redacted logs

### Strongly recommended

- OS keychain-backed local secret storage in OSS desktop
- broker-side token refresh only
- provider tokens never written to plain-text process logs

## Composio As Managed Auth Backend

Composio provides hosted OAuth lifecycle management as an alternative to self-managed OAuth apps. See `2026-03-31-composio-app-runtime-design.md` for the full design.

### Auth mode: `composio`

When a connection uses `auth_mode: "composio"`:

- `accountExternalId` stores the Composio `connected_account_id`
- `secretRef` is `null` — Holaboss does not store raw provider tokens
- the broker resolves tokens at request time by calling Composio's API
- token refresh is handled entirely by Composio

This is the third auth mode alongside `manual_token` and `oauth_app`.

### Connection flow

1. runtime calls Composio to create a managed connect link
2. user completes OAuth in a popup
3. runtime polls Composio until the connected account becomes `ACTIVE`
4. runtime stores a local `IntegrationConnection` with `auth_mode: "composio"` and `accountExternalId` set to the Composio connected account ID

### Broker token resolution

When the broker encounters a `composio` connection during `exchangeToken`:

- it calls `GET /api/v3/connected_accounts/{id}` to verify the account is still active
- it calls `POST /api/v3/tools/execute/proxy` or a dedicated token endpoint to obtain a short-lived provider access token
- it returns that token to the app, same as any other auth mode

This keeps the app-facing contract unchanged — modules still call `POST /api/v1/integrations/broker/token` regardless of the auth backend.

### Future: HB Bridge (`execute` / `proxy`)

The long-term model replaces raw token delivery with a bridge layer where apps never receive provider tokens. See the Composio design doc for the `@holaboss/bridge` SDK and the `execute`/`proxy` primitives. This is a future phase, not part of the initial Composio integration.

### Feasibility verification

The Composio API integration has been verified end-to-end:

- `POST /api/v3/auth_configs` — create managed auth config
- `POST /api/v3/connected_accounts/link` — create OAuth redirect link
- `GET /api/v3/connected_accounts/{id}` — poll account status
- `POST /api/v3/tools/execute/proxy` — proxy provider API calls

Test code: `runtime/api-server/src/composio-minimal-example.ts` and `composio-test-server.ts`.

## Migration Strategy

### Phase 1: Compatibility bridge (done)

- parse integration metadata
- add connection and binding models
- keep current apps mostly unchanged
- continue supporting `PLATFORM_INTEGRATION_TOKEN`
- inject token and integration metadata from the resolved binding

### Phase 2: Broker-first modules (done)

- add local broker endpoints
- migrate Gmail/GitHub/Sheets modules to call broker clients
- stop requiring direct provider token envs for those modules

### Phase 3: Connection lifecycle and remaining modules (done)

- add connection CRUD endpoints
- deprecate `PLATFORM_INTEGRATION_TOKEN`
- move remaining modules to broker-based access

### Phase 4: Composio managed auth

- add Composio service for managed OAuth connect flow
- extend broker to resolve tokens from Composio connections
- add managed connect UI in desktop
- wire connect flow into existing Integrations pane

## Recommended First Provider Set

The first provider set should balance usefulness and implementation friction.

Recommended order:

1. GitHub
2. Google
   - Gmail
   - Sheets
3. Reddit

Providers such as Twitter/X and LinkedIn can use the same architecture, but they are better candidates for managed-first support because of provider complexity and maintenance burden.

## Decision Summary

- Treat integrations as a platform subsystem, not per-app auth hacks.
- Introduce catalog, connections, bindings, and broker as first-class runtime concepts.
- Keep OSS and managed on the same app/runtime contract.
- Use self-managed secrets in OSS and hosted secret management in business mode.
- Migrate away from `PLATFORM_INTEGRATION_TOKEN` toward broker-backed execution and short-lived app grants.
