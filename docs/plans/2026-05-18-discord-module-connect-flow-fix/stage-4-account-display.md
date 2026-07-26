# Stage 4 — Account display: graceful fallback + per-yaml whoami (架构清算)

> Symptom: most toolkits the agent builds today render in the Connect card
> as just a short hex hash (e.g. `a1b2c3d4`) because `PROVIDER_WHOAMI` in
> Hono only knew about 6 well-known providers. Stage 3 explicitly deferred
> this — same architectural smell as `PROVIDER_TO_TOOLKIT` but it lives in
> the profile-fetch path, not the connect path.

Stage 4 is split into two tiers. **Tier 1** ships a defensive UI fallback
(no architectural changes); **Tier 2** removes the Hono-side constant
entirely and routes whoami config through the same yaml → runtime →
chat → Hono channel that Stages 1–3 built.

Land them together; Tier 1 alone leaves the constant in place, Tier 2
alone regresses already-shipped 6 toolkits.

## Tier 1 — Smarter fallback label

`IntegrationConnectCard.accountLabelFor()` used to walk
`[handle, email, label, external_id]` and fall back to
`connection_id.slice(0, 8)` — a meaningless hex blob. Updated fallback:

```ts
const id = connection.connection_id;
const suffix = id.length > 6 ? id.slice(-6) : id;
return `${toolkitDisplayName} · ${suffix}`;
```

`toolkitDisplayName` is the Composio toolkit name (`Discord`, `Notion`,
`Stripe` …) that the UI already pulls from `composioToolkitsByProvider`,
so this works for every toolkit Composio knows about — no per-toolkit
configuration required.

Net effect: any connection that lacks rich identity now renders as
"Discord · a1b2c3" instead of "a1b2c3d4". With multiple accounts of the
same toolkit the suffix disambiguates without revealing the full id.

Files changed:

- `desktop/src/components/panes/ChatPane/AssistantTurn/IntegrationConnectCard.tsx` —
  `accountLabelFor` takes a `toolkitDisplayName` arg, four call sites
  updated.

## Tier 2 — Per-yaml whoami (delete `PROVIDER_WHOAMI`)

`PROVIDER_WHOAMI` was a `Record<string, ProviderWhoami>` in Hono
mapping six toolkits to their `/me` endpoint + dot-paths. Same wrong
shape as `PROVIDER_TO_TOOLKIT` (Stage 3): adding a new toolkit required
a Hono code change.

### Design

```
app.runtime.yaml
  integrations[].whoami: { endpoint, fallback_endpoints?, fields }
        ↓ parseIntegrationRequirement
ResolvedIntegrationRequirement.whoami
        ↓ pendingIntegrationsFromAppManifests
pending_integrations[].whoami
        ↓ parseSubagentPendingIntegrationsFromText / parsePendingIntegrationsList
ChatPendingIntegration / AssistantTurnPendingIntegration.whoami
        ↓ connectIntegrationProvider({ provider, whoami })
        ↓ window.electronAPI.workspace.composioConnect({ provider, whoami })
        ↓ POST /api/composio/connect body.whoami
Hono /connect:
  if body.whoami: stash in KV under composio:whoami:${connected_account_id}
        ↓ at /api/composio/account/:id read time:
loadWhoamiConfig(KV, id)  →  fetchAccountProfile(baseUrl, apiKey, whoami, id)
```

The stash key is the Composio connection id, set the moment the link is
generated — so the very first poll for ACTIVE status already has its
whoami available. On disconnect we delete the stash entry; TTL on the KV
write is 1 year so abandoned entries reap themselves.

### Field syntax (lives in SKILL.md too)

```yaml
whoami:
  endpoint: https://discord.com/api/v10/users/@me
  fallback_endpoints:                                # optional
    - https://discord.com/api/v9/users/@me
  fields:
    handle: username                                 # bare dot-path
    display_name: global_name
    email: email
    avatar_url: https://cdn.discordapp.com/avatars/{id}/{avatar}.png
    #                                                ^^^ URL template
```

Three value shapes:

- **Bare path** (`"login"`, `"data.profile.name"`) — pick from the /me
  response body. Returns null if missing or empty.
- **Array of paths** (`["data.username", "username"]`) — first
  non-empty wins; absorbs shape drift between API versions without
  forcing schema-version logic in Hono.
- **URL template** (any value containing `{path}` placeholders) — each
  `{...}` is replaced by the value at that dot-path. If any placeholder
  resolves to null, the whole template yields null (so we never render
  half-built URLs like `cdn.discordapp.com/avatars//null.png`).

The template form is what makes Discord avatars work — they're not a
single field, they're an assembly of `id` + `avatar_hash`. Without
templates per-yaml whoami would have to drop avatar support entirely
for several providers.

### What's removed

`PROVIDER_WHOAMI` const, `ProviderWhoami` interface, and the
toolkit-specific `upgradeTwitterAvatar` post-process are all deleted.
Existing connections (made before this change) won't get their profile
re-fetched on refresh until the user reconnects — locally-cached
`account_handle/email/label` from the original finalize call still
display, so this only affects subsequent identity drift (e.g. a Twitter
user changing their handle). Acceptable trade-off for cutting the
architectural smell.

## Files changed

Runtime (`holaOS/runtime/api-server/src/`):

- `integration-types.ts` — `WhoamiConfig` type, optional `whoami` on
  `ResolvedIntegrationRequirement`, `parseWhoamiConfig` parser.
- `runtime-agent-tools.ts` — `pendingIntegrationsFromAppManifests`
  forwards whoami to chat.
- `claimed-input-executor.ts` — `SubagentPendingIntegration` type +
  parser pass through whoami.

Desktop (`holaOS/desktop/`):

- `src/types/electron.d.ts` — `PendingIntegrationWhoami` ambient type,
  `composioConnect` payload accepts `whoami?`.
- `electron/preload.ts` — bridge forwards whoami.
- `electron/main.ts` — IPC handler signature + `composioConnect` HTTP
  request shape.
- `src/lib/workspaceDesktop.tsx` — `connectIntegrationProvider`
  accepts whoami; passed through to `composioConnect` IPC.
- `src/components/panes/ChatPane/types.ts` — `ChatPendingIntegration`
  gains optional whoami.
- `src/components/panes/ChatPane/index.tsx` —
  `parsePendingIntegrationWhoami` validator,
  `parsePendingIntegrationsList` carries whoami through.
- `src/components/panes/ChatPane/AssistantTurn/IntegrationConnectCard.tsx` —
  `AssistantTurnPendingIntegration.whoami`, forwarded in
  `connectIntegrationProvider` call.

Hono (`frontend/apps/server/src/api/composio.ts`):

- `WhoamiConfig` interface + `pickPath` + `resolveField` (template
  support) + `pickFirst`.
- `stashWhoamiConfig` / `loadWhoamiConfig` KV helpers
  (`composio:whoami:${id}` key, 1y TTL).
- `connectBodySchema` adds `whoami` (zod-validated).
- `/connect` stashes whoami after a successful link creation.
- `/account/:id` loads stashed whoami at fetch time.
- `/connections/:id` DELETE cleans up the KV entry.
- `fetchAccountProfile` signature: `(baseUrl, apiKey, whoami, accountId)`.
- `PROVIDER_WHOAMI` const, `ProviderWhoami` interface, and
  `upgradeTwitterAvatar` removed.

Skill (`holaOS/runtime/harnesses/src/embedded-skills/app-builder/SKILL.md`):

- Integration Manifest Pattern section gains an explicit note that
  `provider` must be the Composio toolkit slug.
- New "Whoami (Optional)" subsection with full example + rules covering
  the three field-value shapes.

## Verification

1. **Tier 1 alone** is verifiable on the spot — rebuild desktop, open
   any existing workspace, and any toolkit without whoami in the local
   DB should now render as "Toolkit Name · last6" in the Connect card
   and Integrations pane.

2. **Tier 2** end-to-end requires the Hono change deployed to staging
   (`cd frontend && bun run deploy:staging`):
   1. Have the agent build a new Discord module that declares whoami
      in its `app.runtime.yaml` (see SKILL.md example).
   2. Click Connect Discord, complete OAuth.
   3. The card must transition to showing the user's real Discord
      handle (e.g. `@alice`) and avatar URL on the next poll, not the
      Tier-1 fallback.
   4. Delete the connection — confirm the KV entry
      `composio:whoami:${connected_account_id}` is removed (visible via
      Cloudflare KV dashboard, or by re-creating with the same id and
      seeing no stale whoami leak).

3. Have the agent build a toolkit-backed app **without** a whoami
   block. The Connect flow must still succeed end-to-end; the card
   shows the Tier-1 fallback ("Toolkit · last6"). This confirms whoami
   is genuinely optional.

## What's deliberately NOT done

- We don't backfill stash entries for users who already have
  connections without whoami stashed. They keep their currently-cached
  identity strings; refresh becomes a no-op until they reconnect.
- We don't add a "well-known whoami fallback" registry as a transition
  aid. Doing so would re-introduce the same coupling we just removed —
  `PROVIDER_TO_TOOLKIT` started life as exactly that kind of fallback.
- Twitter avatar size upgrade (`_normal` → `_400x400`) is removed.
  The smaller variant is still recognizably a profile photo; adding a
  yaml-side `transform` block to express it isn't worth the complexity
  for a 350px display.
- Existing handle/email/label fields on `IntegrationConnectionPayload`
  stay as-is; we deliberately don't add `account_avatar_url` because
  the Connect card doesn't render an avatar today. If the Integrations
  pane wants to start rendering avatars at scale, that's a separate
  change with its own DB schema impact.
