# Composio App Runtime Design

Date: 2026-03-31
Status: Draft
Owner: Holaboss desktop/runtime

## Goal

Define the long-term integration architecture for Holaboss apps when OAuth and connected-account lifecycle are backed by Composio.

This design is optimized for the future state where Holaboss apps may be developed by third-party developers, not only by the core team.

The design must satisfy four requirements:

- developers can build provider-based apps without implementing OAuth
- apps do not receive long-lived provider credentials by default
- workspace and app binding remain a Holaboss concern
- the app-facing contract stays stable even if the auth backend changes later

## Decision Summary

Holaboss should adopt the following model:

- Composio is the source of truth for OAuth, refresh, and connected-account lifecycle
- Holaboss is the source of truth for workspace/app binding, readiness, policy, and app runtime delivery
- apps do not call Composio directly
- apps do not receive long-lived provider access tokens or refresh tokens
- apps call a Holaboss-owned runtime bridge API through a small app SDK
- the bridge exposes two primary primitives:
  - `execute` for high-level provider actions
  - `proxy` for provider-native HTTP access without exposing credentials

This means the app-facing contract is a Holaboss platform contract, not a Composio contract.

## Naming

The app-facing SDK should not be named `holaboss-sdk`.

Recommended name:

- product term: `HB Bridge`
- package name: `@holaboss/bridge`

Why this name:

- it is shorter and easier to type
- it does not couple the SDK name to Composio
- it describes the actual role of the package: the bridge between an app and Holaboss runtime capabilities
- it leaves room for future non-integration capabilities under the same package

Example imports:

```ts
import { createIntegrationClient } from "@holaboss/bridge";
```

## Why This Is The Right Shape

### Why not direct token delivery to apps

If apps receive raw provider tokens:

- app code can exfiltrate them
- auditing becomes weak
- revocation boundaries are poor
- refresh semantics leak into every app
- opening the app ecosystem later becomes much riskier

This is a poor default for a marketplace-oriented platform.

### Why not make apps call Composio directly

If apps call Composio directly:

- the Composio API key must be exposed or re-proxied anyway
- workspace/app binding logic leaks outside Holaboss
- error handling becomes vendor-specific
- moving away from Composio later becomes much harder

Composio should be an implementation detail behind Holaboss runtime.

### Why `proxy` is required in addition to `execute`

If the platform only exposes high-level `execute` actions, developers will immediately hit capability gaps on large APIs such as Gmail, Drive, GitHub, Slack, and Notion.

The correct balance is:

- `execute` for common, typed, high-value actions
- `proxy` for provider-native flexibility without exposing credentials

This keeps the platform safe without making the developer experience too constrained.

## Target Architecture

The architecture has five layers.

### 1. Connect Layer

User clicks `Connect` in Holaboss.

Holaboss runtime:

- maps `provider_id` to a Composio auth config
- creates a Composio connected-account link
- opens the returned OAuth URL
- receives completion via callback or follow-up polling
- stores the resulting connected account in the local runtime state

Holaboss continues to own:

- connection records
- binding records
- readiness checks
- app refresh after binding changes

### 2. Connection Layer

Holaboss stores one local `integration_connection` record per connected account.

For Composio-backed connections:

- `auth_mode = "composio"`
- `provider_id = "google" | "github" | ...`
- `account_external_id = <connected_account_id>`
- `secret_ref = null`

The critical point is that Holaboss stores a reference to the remote credential, not the credential itself.

### 3. Binding Layer

Bindings remain unchanged conceptually.

They answer:

- which Google account does this workspace use
- which app overrides the workspace default
- which account should be selected when multiple accounts exist

This must remain a Holaboss concern because it is application runtime policy, not OAuth policy.

### 4. Runtime Bridge Layer

Apps receive only:

- `HOLABOSS_INTEGRATION_BROKER_URL`
- `HOLABOSS_APP_GRANT`
- optional non-secret metadata such as selected connection id

Apps then call the Holaboss bridge.

The bridge:

- validates app grants
- resolves bindings
- checks readiness and status
- resolves the connected account reference
- calls Composio using server-side credentials
- returns normalized results and errors

### 5. App SDK Layer

Apps import a small developer-facing SDK from `@holaboss/bridge`.

The SDK should hide runtime transport details and expose a clean API.

## Proposed App-Facing SDK

The minimum app-facing interface should be:

```ts
type IntegrationClient = {
  execute<TInput extends Record<string, unknown>, TOutput = unknown>(
    operation: string,
    input: TInput
  ): Promise<TOutput>;
  proxy<TOutput = unknown>(request: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    query?: Record<string, string | number | boolean | null | undefined>;
    headers?: Record<string, string>;
    body?: unknown;
  }): Promise<TOutput>;
};

declare function createIntegrationClient(provider: string): IntegrationClient;
```

Example for a Gmail-based app:

```ts
import { createIntegrationClient } from "@holaboss/bridge";

const gmail = createIntegrationClient("google");

export async function sendMessage(raw: string) {
  return gmail.proxy({
    method: "POST",
    path: "/gmail/v1/users/me/messages/send",
    body: { raw }
  });
}
```

Example for a typed helper:

```ts
await gmail.execute("gmail.send_email", {
  to: "owner@holaboss.ai",
  subject: "Hello",
  body: "Hi"
});
```

## Proposed Runtime Bridge API

The runtime bridge should start with two endpoints:

### 1. Execute

```http
POST /api/v1/integrations/broker/execute
```

Request body:

```json
{
  "grant": "grant:workspace:app:nonce",
  "provider": "google",
  "operation": "gmail.send_email",
  "input": {
    "to": "owner@holaboss.ai",
    "subject": "Hello",
    "body": "Hi"
  }
}
```

### 2. Proxy

```http
POST /api/v1/integrations/broker/proxy
```

Request body:

```json
{
  "grant": "grant:workspace:app:nonce",
  "provider": "google",
  "request": {
    "method": "GET",
    "path": "/gmail/v1/users/me/messages",
    "query": {
      "maxResults": 10
    }
  }
}
```

Bridge responses should be normalized and must never return provider credentials.

## What A Gmail-Based App Looks Like

For a developer building a Gmail-based app, the required work should be:

1. declare the Google integration in `app.runtime.yaml`
2. import `createIntegrationClient("google")`
3. call `execute` for common actions
4. call `proxy` for Gmail endpoints not yet wrapped by the platform

The developer should not have to:

- implement OAuth
- manage refresh tokens
- store access tokens
- understand Composio connected-account lifecycle
- decide which workspace account to use

That complexity belongs to the platform.

## Manifest And Capability Model

The app manifest should continue to declare integration requirements, but the declaration should become the basis for enforcement.

Suggested shape:

```yaml
integrations:
  - key: google
    provider: google
    required: true
    scopes:
      - gmail.readonly
      - gmail.send
    access:
      - execute
      - proxy
```

Important implications:

- readiness is based on declared requirements, not app runtime failures
- bindings are resolved against declared integration keys
- the bridge can reject calls that exceed the declared access mode or scopes

## Additional Considerations That Must Be Designed Up Front

### 1. Scope enforcement

This is one of the most important missing pieces in the current model.

The bridge should not only check whether a connection exists. It should also check:

- whether the bound connection is active
- whether the app requested the necessary scopes
- whether the connected account actually has those scopes

If an app declares only `gmail.readonly`, it should not be able to send mail through `proxy`.

This requires a provider-aware scope policy layer in the bridge.

### 2. Error normalization

Apps must not be forced to understand raw Composio or raw provider error shapes.

The bridge should normalize failures into a small platform error taxonomy, such as:

- `integration_not_bound`
- `integration_needs_reauth`
- `integration_scope_denied`
- `integration_operation_not_allowed`
- `provider_rate_limited`
- `provider_invalid_request`
- `provider_unavailable`

This is critical for both developer experience and product UX.

### 3. Audit and redaction

The platform should log:

- app id
- workspace id
- provider
- operation or endpoint
- status code
- latency
- selected connection id

The platform should not log:

- access tokens
- refresh tokens
- full provider payloads by default
- full message contents unless explicitly enabled for debugging

This matters immediately for email, chat, CRM, and support integrations that may carry sensitive user data.

### 4. Proxy boundaries

`proxy` must not become a generic SSRF tunnel.

Rules for `proxy` should include:

- apps provide provider-relative paths, not full URLs
- the bridge decides the upstream base URL
- auth headers cannot be overridden by the app
- dangerous headers should be blocked or normalized
- body size limits should be enforced
- provider-specific allowlists may be added later if needed

Without these rules, `proxy` becomes a security hole rather than a safe flexibility layer.

### 5. Binary and multipart support

Many real integrations need uploads or downloads:

- Gmail attachments
- Drive uploads
- Slack file posts
- GitHub release assets

The initial `proxy` design should explicitly decide whether v1 supports:

- JSON only
- JSON plus multipart form-data
- streaming upload/download

If this is not decided now, the SDK shape may need to break later.

### 6. Rate limiting and retries

The bridge should become the central place for:

- retry policy
- transient error handling
- provider-specific backoff
- request deduplication for sensitive writes

This is especially important for send/reply/create operations.

Typed `execute` operations should prefer idempotency keys where possible.

### 7. Local development and testing

If apps are expected to be built by external developers later, local developer experience matters now.

The platform should support:

- a local mock bridge mode
- fixture-based provider responses for unit tests
- integration tests against the runtime bridge without real OAuth when possible

Developers should be able to test app logic without connecting a live Google account for every change.

### 8. Vendor abstraction

Even if Composio is the chosen backend now, the app-facing contract must not mention Composio.

The bridge should depend on an internal provider-auth driver interface so that Holaboss can later support:

- Composio-backed auth for some providers
- native Holaboss-managed auth for others
- manual tokens for special cases

The app contract should remain unchanged across those backend choices.

### 9. Token lease as an explicit non-default escape hatch

V1 should not expose raw provider tokens to apps.

However, the architecture should leave room for a future optional capability:

- short-lived token leases
- non-refreshable
- narrowly scoped
- auditable
- only for reviewed app classes

This should be designed as an exception path, not the default developer model.

### 10. Marketplace review and permissions

Because the long-term goal is developer-built apps, the manifest must become reviewable policy.

That means the platform should eventually be able to answer:

- which provider does this app access
- does it need read-only or write access
- does it need `proxy`, `execute`, or both
- does it need attachment upload support

Without a structured permissions model, opening the platform later will be messy.

## Recommended V1 Boundaries

To keep implementation focused, V1 should include:

- Composio-backed `Connect`
- local connection records that store `connected_account_id`
- existing binding model
- bridge `execute`
- bridge `proxy`
- normalized error taxonomy
- no raw token delivery
- no direct Composio usage from apps

V1 should explicitly exclude:

- public token lease support
- fully typed wrappers for every provider endpoint
- generic arbitrary outbound proxying
- multi-provider workflow composition inside the bridge

## Concrete Guidance For Gmail Apps

For Gmail-based apps, the preferred internal development pattern should be:

1. create one Google integration client per request or module
2. use `execute` for common business operations:
   - send message
   - create draft
   - reply
   - search threads
3. use `proxy` for edge cases not yet wrapped:
   - labels
   - history
   - thread metadata
   - advanced search parameters
4. keep message formatting and business logic inside the app
5. keep OAuth, account selection, refresh, and transport policy in the platform

This gives developers real power without making each app an auth client.

## Open Questions

These questions still need explicit product and engineering decisions:

- should `proxy` be available to every app by default, or only to trusted apps
- should `execute` operations be globally named like `gmail.send_email` or namespaced per provider client
- should v1 support multipart uploads

### Resolved

- **`proxy` response format**: Composio returns a normalized envelope `{ data, status, headers }` — the bridge should pass this through rather than unwrapping. Verified 2026-03-31.
- **scope validation timing**: call-time validation is sufficient for V1. Readiness checks validate connection existence and status, not scopes. Scope enforcement can be added to the bridge layer later.

## Recommendation

Adopt `HB Bridge` as the app-facing runtime contract and keep Composio strictly behind the bridge.

This gives Holaboss the right long-term platform properties:

- safe by default
- flexible enough for real apps
- stable for external developers
- decoupled from any single auth vendor

It is the best fit for a future ecosystem where developers build provider-powered apps without becoming OAuth experts.

## References

- https://docs.composio.dev/docs/authentication
- https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsLink
- https://docs.composio.dev/docs/auth-configuration/connected-accounts
- https://docs.composio.dev/rest-api/tools/post-tools-execute-by-tool-slug
- https://docs.composio.dev/rest-api/tools/post-tools-execute-proxy
