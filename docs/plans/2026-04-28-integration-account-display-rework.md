# Integration Account Display Rework

**Status:** Phase 1 (frontend cache) shipping with this branch. Phase 2 + 3 require backend coordination — open as separate work items.

**Goal:** Make integration account labels (handle / email / avatar) display *consistently and accurately* across every UI surface that renders them, without each surface re-fetching whoami or showing fallback shimmer.

---

## Background — what's broken today

Three desktop surfaces display "this is the X account this app/workspace is using":

| Surface | File | Picker shape |
|---|---|---|
| Settings → Integrations | `src/components/panes/IntegrationsPane.tsx` | Card list of all connected accounts |
| App detail toolbar | `src/components/panes/AppSurfacePane.tsx` | Compact `<Select>` pill |
| Add apps dialog | `src/components/marketplace/AppCatalogCard.tsx` | Inline `<Select>` on the install card |

Each one independently:
1. Calls `listIntegrationConnections()` to read raw connection rows.
2. Calls `composioAccountStatus(account_external_id)` *per connection* to enrich with whoami metadata (handle, email, displayName, avatarUrl).
3. Picks a display label from a precedence chain that differs subtly between surfaces.

**Symptoms users see:**

- **First-render shimmer.** Every consumer mounts with empty meta → renders "Account 1 / Account 2" with letter avatars → re-renders 200-800ms later when whoami resolves.
- **Cross-surface inconsistency.** Three different `pickAccountLabel` / `connectionPrimary` / `accountDisplayLabel` functions with three different fallback orders. AppCatalogCard preferred admin-supplied `account_label` first; AppSurfacePane preferred raw handle. Same account, different label depending on where you opened it.
- **Stale duplicates.** Each Composio re-auth mints a fresh `connected_account_id`. Pre-fix rows had no handle/email persisted; multiple connections resolve to the same identity. Only IntegrationsPane runs the dedupe-on-render reconciliation. Other surfaces show duplicates until the user opens Settings.
- **Avatar dependency on whoami.** Composio CDN failure or offline → no avatar anywhere; `connection` table doesn't persist `avatar_url`.
- **`(Managed)` / `ca_…` label noise.** Auto-generated labels from the connect flow leak into UIs unless every consumer remembers to filter them out.

**Root cause:** identity resolution happens on the *read side* — each consumer stitches `connection` + whoami at render time. The connection record itself isn't authoritative.

---

## Phase 1 — App-level metadata cache (this branch)

**Scope:** frontend-only. No API changes. Lands today.

### What ships

1. `src/lib/integrationAccountStore.ts` — module-level singleton:
   - `useIntegrationAccountMetadata(connections)` — `useSyncExternalStore`-backed hook returning a `Map<connection_id, ComposioAccountStatus>`.
   - Dedupes inflight fetches by `account_external_id` (multiple connection rows can share one Composio account post-merge; one HTTP call covers all).
   - Append-only on success; transient failures don't blank existing data.
   - `invalidateIntegrationAccountCache(connectionIds?)` — drop entries after dedupe-merge or disconnect.

2. `src/lib/integrationDisplay.ts`:
   - `accountDisplayLabel(conn, meta, index)` — single canonical precedence chain: `meta.handle` → `conn.account_handle` → `meta.email` → `conn.account_email` → `meta.displayName` → filtered `conn.account_label` → `Account N`. The fallback to persisted connection fields is what makes the UI sensible when whoami hasn't resolved (or never resolves).
   - `accountAvatarFallbackChar(label)` — letter-avatar fallback.
   - `useEnrichedConnections` — thin alias of `useIntegrationAccountMetadata`, kept as the public surface for display callers.

3. Three call sites migrated:
   - `IntegrationsPane.tsx` — local `accountMetadata` state + parallel-fetch effect deleted; reads from store.
   - `AppSurfacePane.tsx` — toolbar picker reads from store; trigger and items render avatar from `meta.avatarUrl`.
   - `AppCatalogCard.tsx` — install picker reads from store; same avatar treatment.

4. Cache invalidation:
   - After `mergeIntegrationConnections(...)` in IntegrationsPane's reconciler, removed `connection_id`s are evicted.
   - After `deleteIntegrationConnection(...)` in `handleDisconnect`, the disconnected `connection_id` is evicted.

### Acceptance

- Open AppSurfacePane → toolbar picker shows real `@handle` / email and avatar (not "Account N").
- Open Add apps dialog after IntegrationsPane has loaded → picker is populated instantly with no fetch (cache hit).
- Disconnect an account in Settings → its row disappears from the AppSurfacePane picker without a hard reload.
- Composio offline → labels fall back to persisted `account_handle`/`account_email`; never show `Account N` for connections that were created with handle/email persisted.

### What Phase 1 does NOT solve

- Connections created **before whoami enrichment shipped** still have `account_handle = null`. They'll show `Account N` until something repopulates them.
- The IntegrationsPane dedupe reconciler still runs on the client and only when that pane is open. Other surfaces still see duplicates until then.
- Avatars still vanish if Composio is unreachable.

---

## Phase 2 — Server-side account enrichment

Phase 2 splits into two slices because the size and risk profile differ.

### Phase 2 / Slice 1 — Per-provider whoami extraction + on-demand refresh (this branch)

**Why split:** Slice 1 fixes the immediate "Twitter shows Account 1" symptom without any schema changes, so it's safe to ship behind the same branch as Phase 1. Slice 2 (avatar persistence + periodic refresh) needs schema migration and is sequenced after Slice 1 lands.

**What ships:**

1. `extractComposioIdentity(providerId, status)` in `desktop/electron/main.ts` — normalises Composio whoami into `{ handle, email, displayName, avatarUrl }`, with per-provider extraction from `status.data` for toolkits where Composio doesn't populate top-level identity. Today's table covers Twitter/X (`username`, `screen_name`, `profile_image_url`), GitHub (`login`, `avatar_url`), Reddit (`name`, `icon_img`), LinkedIn (`given_name`/`family_name`/`picture`), and Google variants (`email`/`name`/`picture`). Generic fallback probes the most common field names so unknown providers still get partial enrichment.
2. `composioFinalize` and the legacy-row backfill loop both switch to `extractComposioIdentity` — new connections + dedupe-on-finalize backfill see the same logic.
3. New IPC `workspace:composioRefreshConnection(connectionId)` — re-runs the extractor against an existing connection's `account_external_id` and writes any newly-resolved handle/email back via `updateIntegrationConnection`. Partial probes (handle resolved, email still missing) preserve persisted data.
4. IntegrationsPane account row gains a Refresh icon button (next to Disconnect) wired to the new IPC. Triggers `loadData()` on success and invalidates the Phase 1 cache so other surfaces re-probe with the fresh identity.

**Acceptance:**

- New Twitter connection: finalize completes with `account_handle = "@alice"` persisted to DB (rather than NULL).
- Existing Twitter connection: user clicks Refresh → row updates from "Account 1" → "@alice"; AppSurfacePane picker reflects the change next time it mounts.
- GitHub / other providers that already worked don't regress.

**Caveats / unverified:**

- The `data` field structure assumed for each provider is **best-effort**. Composio may package the response differently per toolkit version. If Twitter's `data` is empty (rather than carrying the X v2 response), this slice doesn't help — we'd need to extend `composioFetch` to call `/api/composio/proxy` with a provider-side endpoint (e.g. `https://api.twitter.com/2/users/me`) and parse that. That fallback is roughly 50 lines and gated on Slice 1 telemetry showing the current path doesn't resolve.
- Avatars still come from the Phase 1 `useIntegrationAccountMetadata` cache — no schema column yet, so a cold app start with Composio offline shows the lettered fallback.

### Phase 2 / Slice 2 — Persistent enrichment + periodic refresh

**Scope:** runtime API + connection schema. ~1-2 days backend.

**Idea:** make connection rows self-describing. Frontend never has to call `composioAccountStatus()` again for display purposes.

### Schema additions to `integration_connections`

| Column | Purpose |
|---|---|
| `account_display_name` | `meta.displayName` from whoami; for users with no handle (e.g. Gmail accounts). |
| `account_avatar_url` | `meta.avatarUrl` snapshot. Re-resolved periodically. |
| `account_enriched_at` | Timestamp of last whoami sync; lets the runtime decide when to re-poll. |

### Write paths that fill them

- **At connection finalization.** `composioFinalize(...)` already runs after OAuth completes. Extend it to call `composioAccountStatus()` synchronously and persist the four identity columns (`handle`, `email`, `display_name`, `avatar_url`) before returning.
- **Periodic refresh.** A runtime background task: every connection with `enriched_at < now() - 24h` gets re-polled. Cheap because it only hits Composio for stale rows.
- **On-demand refresh.** A new `refreshIntegrationConnection(connectionId)` API for the "Refresh" button users can click in Settings (post-Phase 2 UX).

### Frontend simplification after Phase 2

- `useIntegrationAccountMetadata` *might* still exist for opportunistic refresh, but no consumer needs to wait on it — the connection row already carries display data.
- `accountDisplayLabel` collapses to a 3-line function: take `account_handle`, fall back to `account_email`, fall back to `account_display_name`. No filtering, no index fallback.
- `composioAccountStatus()` becomes a refresh-only API; not on the hot path.

### Migration

Backfill task: iterate every existing connection with `account_external_id IS NOT NULL`, hit `composioAccountStatus`, write the four columns. One-shot script; no downtime.

---

## Phase 3 — Server-side dedupe (close the loop)

**Scope:** Composio connect flow. ~half day backend once Phase 2 has shipped.

**Idea:** the dedupe reconciliation that lives in `IntegrationsPane.tsx` (lines 286-414) shouldn't be a frontend concern at all.

### Design

After `composioFinalize(...)` enriches a new connection (Phase 2 prerequisite), it has `account_handle` / `account_email` populated *before* the row is inserted. The finalize flow then:

1. Looks up existing rows for `(provider_id, account_handle)` (or `account_email` if no handle).
2. If a match exists: **don't insert.** Update the existing row's `account_external_id` (Composio gave us a new one) and re-emit the existing `connection_id` to the caller.
3. If no match: insert as new.

### Frontend simplification after Phase 3

- The dedupe `useEffect` in `IntegrationsPane.tsx` (~130 lines) deletes wholesale.
- `mergeIntegrationConnections(...)` API can be removed (no caller).
- `updateIntegrationConnection({ account_handle, account_email })` becomes Settings-only (manual edit), no longer load-bearing.
- AppSurfacePane / AppCatalogCard pickers permanently stop showing duplicates.

---

## Phase comparison

| | Phase 1 (now) | Phase 2 (backend enrich) | Phase 3 (backend dedupe) |
|---|---|---|---|
| First-render shimmer | Reduced (cache hit after first surface mounts) | Eliminated (data on connection row) | Eliminated |
| Cross-surface consistency | ✓ | ✓ | ✓ |
| Duplicates outside Settings | Still present until Settings opens | Still present | Eliminated |
| Avatar without whoami fetch | ✗ | ✓ (snapshot URL persisted) | ✓ |
| Lines of frontend code | -1 useEffect copy, +1 store, net ~+30 LOC | `accountDisplayLabel` shrinks ~70%, drop manual filter | Drop ~130 LOC dedupe block + `mergeIntegrationConnections` API |
| Backend changes | None | 4 columns + 1 background task + 1 API | 1 finalize-flow change |

---

## Open questions (for backend planning)

1. **Stale handles.** A user changes their X handle. Periodic refresh catches it eventually; do we also want a "Refresh now" button per connection in Settings?
2. **Avatar refresh cadence.** 24h might be too rare for users who change profile pictures often, too aggressive if Composio rate-limits us. Start at 24h, instrument, tune.
3. **Privacy of `account_email`.** It's already persisted today. Phase 2 doesn't change that surface; flagging for security review just in case.
4. **Backfill timing.** Phase 2 ships → backfill script runs → Phase 3 can ship. Don't ship Phase 3 before backfill completes (would otherwise dedupe wrongly against rows missing handle/email).
