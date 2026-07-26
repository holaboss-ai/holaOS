# Stage 3 — Remove Hono toolkit mapping + add `auth_config` upsert (Bug 2)

> Symptom: user clicks Connect Discord for the first time and Hono returns
> a 502 "Composio error". Retrying succeeds. This stranded the entire
> connect flow on the very first attempt for every new toolkit.

This stage lives in `frontend/apps/server/src/api/composio.ts`. The
deployment target is the staging Hono worker; tests pass locally but the
end-to-end Discord flow requires `bun run deploy:staging` to exercise.

## Root cause

Two independent issues that together explain the "first time fails,
retry works" pattern.

### Issue A — Central provider→toolkit mapping was incomplete and wrong-shaped

`composio.ts` carried a hardcoded table:

```ts
const PROVIDER_TO_TOOLKIT: Record<string, string> = {
  gmail: "gmail",
  googlesheets: "googlesheets",
  google: "gmail",
  github: "github",
  reddit: "reddit",
  twitter: "twitter",
  linkedin: "linkedin",
};
const toolkitSlug = PROVIDER_TO_TOOLKIT[provider] ?? provider;
```

Adding a new app required a Hono code change. New apps the desktop agent
builds (Discord, Notion, etc.) silently fell through to the bare
`provider` string. In Discord's case that happened to work because the
yaml's `integration.destination` is already `"discordbot"`, but the
architecture was a landmine for any future toolkit whose slug doesn't
match its identifier.

The correct shape: the **app's `app.runtime.yaml` owns the Composio
toolkit slug** (in the `integrations[].provider` field). The runtime
forwards it through `pending_integrations` to the chat UI, which sends
it back unchanged on `/api/composio/connect`. Hono just uses what the
client sends.

### Issue B — `auth_configs` create was not idempotent

The connect flow:

1. `GET /api/v3/auth_configs?toolkit_slug=<slug>` — find an enabled config.
2. If none, `POST /api/v3/auth_configs` to create a managed one.
3. `POST /api/v3/connected_accounts/link` with that auth-config id.

Step 2 races. Whenever Composio's read replica lags behind a recent
write — or two `/connect` calls happen back-to-back, even from the same
user — the second create attempt can return a 4xx "already exists"
response. The old code returned that as a 502 to the desktop and the
user saw "Composio error". The next attempt (after Composio's index
caught up) read the existing config via step 1 and succeeded — which
explains the "second time works" behavior precisely.

There was also no structured logger output around these failures, so
the only signal was the user's 502 toast.

## Fix

### A — delete the central mapping

```ts
// Was:
const toolkitSlug = PROVIDER_TO_TOOLKIT[provider] ?? provider;

// Now:
const toolkitSlug = body.provider;
```

Plus the `PROVIDER_TO_TOOLKIT` declaration is removed entirely. A new
toolkit is connectable as soon as an app declares it in `app.runtime.yaml`
— no Hono code change, no redeploy.

### B — upsert on create conflict

Extract `listAuthConfig()` and call it twice when needed:

```text
listAuthConfig()
  ├── found?            → use it
  └── not found
        ├── POST /auth_configs
        │     ├── 2xx?  → use the new id
        │     └── 4xx?  → listAuthConfig() again
        │                  ├── found this time? → use it (race resolved)
        │                  └── still not?       → return 502 with body
```

The retry never loops more than once: either the race resolves on the
second list, or the toolkit slug is genuinely wrong and we propagate the
original Composio error body to the user.

### C — structured logger calls

Three warn/error events keyed by `event: "composio.connect.*"`:

- `composio.connect.list_failed` — initial list 4xx/5xx.
- `composio.connect.create_conflict_retry` — create non-2xx, retrying.
- `composio.connect.create_failed` — retry also yielded nothing.
- `composio.connect.no_auth_config_id` — create succeeded but returned
  empty id.

Each carries `toolkitSlug` and the upstream HTTP status. Searching
Loki/Cloudflare logs for any of these instantly answers "why did
Discord fail on the first try?".

## Files changed

- `frontend/apps/server/src/api/composio.ts` — `PROVIDER_TO_TOOLKIT`
  deleted; `/connect` handler reworked around `listAuthConfig` helper +
  retry-on-conflict + structured logs.

## Deliberately NOT changed in this stage

- `PROVIDER_WHOAMI` (the per-toolkit profile-fetch table). It's the same
  architectural smell as `PROVIDER_TO_TOOLKIT` — a central table that
  needs updating for every new provider — but it only affects profile
  display labels in `IntegrationConnectCard`, not the connect path
  itself. Discord without a `PROVIDER_WHOAMI` entry falls back to
  `provider`-as-label, which is acceptable. A follow-up should move
  this to a per-yaml `integrations[].whoami` block plumbed through
  `pending_integrations`, but it's not blocking either of the three
  reported bugs.

## Verification

1. Deploy:
   ```bash
   cd frontend
   bun run deploy:staging
   ```
2. From the desktop (Stages 1 + 2 already shipped), create a fresh
   Discord module.
3. Click Connect Discord the moment the card appears. Expectation:
   - the OAuth window opens within a couple of seconds — no 502
   - logs show `composio.connect.create_conflict_retry` at most once,
     and no `composio.connect.create_failed`.
4. Disconnect the toolkit in Composio, repeat. Should still be a
   first-shot success.
5. (Coverage) Repeat for an entirely-new toolkit that Hono has never
   seen (e.g. `notion`, `klaviyo`). Same single-shot success — confirms
   the mapping table really was the only piece making certain toolkits
   "special".

## Out of scope (handled in other stages)

- Stages 1 + 2 must be live first. Without Stage 1 the user can't even
  see the Connect button; without Stage 2 the OAuth completes but the
  Discord app doesn't pick up the new grant.
