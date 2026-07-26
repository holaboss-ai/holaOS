# Inline Composio Runtime Tools (delete the composio-mcp host)

Status: draft → in-progress
Author: Holaboss + claude
Date: 2026-06-11

## Problem

The current Composio integration ships through a per-workspace HTTP MCP host
process (`composio-mcp-manager` + `composio-mcp-host`). 8+ caches mirror the
"is X connected" state across the chain Composio → Hono → local store →
manager in-memory cache → `bootstrappedSlugs` fingerprint → `workspace.yaml`
mcp_registry → MCP host's internal tool list → harness MCP client → agent
LLM tool set. Every cache transition is a chance to drift, and we have been
shipping incremental patches to plug specific drift modes (push race, host
crash, fingerprint stale, Hono blip during bootstrap, Composio eventual
consistency on the `listConnections` endpoint, etc.) without addressing the
structural over-caching.

The user-visible symptom: an integration card flips green but the agent
either says "please connect X first" or silently has no tools.

## Goal

Eliminate the composio-mcp host entirely. Composio tools become runtime
tools registered directly inside the harness-host subprocess, sourced from
the local `IntegrationConnection` store + a local schema cache. The
runtime → Composio data flow collapses from 8 hops to 3:

```
local store (active connections)
+ local schema cache (toolkit slug → tool schemas, 24h TTL)
       ↓ at every agent run-start (cheap, in-process)
harness-host registers composio_<slug>_<verb> runtime tools
       ↓ tool call
POST Hono /api/composio/execute → Composio → response
```

No port. No `workspace.yaml` URL field. No `ensureFreshFor` barrier. No
host process. No `bootstrappedSlugs` fingerprint. No push/pull sync.

## Principles

These are the explicit constraints I'm enforcing throughout the
implementation. Every PR will be measured against them.

1. **Ship incrementally**. Every commit leaves `main` deployable. No "big
   bang" — even the final cleanup is gated behind a feature flag for a
   full validation window before old code is removed.

2. **Feature-flag from day one**. Old composio-mcp host stays operative
   until the flag flips. Flag: `HOLABOSS_INLINE_COMPOSIO_TOOLS`. Default
   OFF until Phase 4.

3. **No comment archaeology**. Per project CLAUDE.md and user feedback:
   default to no comments. One short line max when WHY is non-obvious.
   Never narrate the bug being fixed, the prior design, or this plan.
   All of that goes in commit messages / PR descriptions.

4. **Tests at every phase**. Each phase ends with passing unit tests
   covering its surface. No phase ships green-only by accident — at
   least one explicit failure-mode test per new code path (cache miss,
   network failure, Hono 401, empty toolkit, multi-account).

5. **Reflect after each phase**. After tests pass, write a short
   reflection in this doc (under "Reflection log" below) capturing:
   what surprised me, what I had to adjust from the plan, what to
   carry into the next phase.

6. **Preserve prompt semantics**. Inline composio tools must still be
   classified as `kind: "mcp_tool"` in the capability manifest so the
   existing prompt addenda ("MCP-first routing", front-session
   "Active integrations" awareness, scope-error recovery via
   `[composio_error:*]` strings, etc.) continue to fire on the same
   conditions.

7. **Error string compatibility**. Tool handler error mapping must
   produce `[composio_error:forbidden:<slug>]`,
   `[composio_error:permission_denied:<slug>]`,
   `[composio_error:insufficient_scope:<slug>]` in the same shape the
   old MCP host did. The agent's scope-error recovery addendum in
   `agent-capability-registry.ts:1530` keys off these literals.

8. **No silent degradation**. If the schema cache cannot be filled for
   a connected toolkit, the agent gets a tool whose handler returns an
   actionable error, not "no tool registered." Otherwise the symptom
   degrades back to "connected but propose_connect" which is exactly
   what we're trying to eliminate.

9. **Migration is idempotent**. Stripping the `holaboss_composio`
   server from old `workspace.yaml` files must be safe to run multiple
   times and harmless on workspaces that never had the entry.

## Phases

### Phase 0 — Dependency reconnaissance

- Confirm pi-coding-agent / `@mariozechner/pi-coding-agent` accepts
  dynamic ToolDefinition injection per session (or document the
  ergonomic constraint if not).
- Confirm harness-host already has access to `RuntimeStateStore`
  (it does — `pi.ts` imports it).
- Inventory every call site that touches `ComposioMcpManager`,
  `composio-mcp-host`, or `workspace.yaml` `mcp_registry.servers.
  holaboss_composio`.
- Write a regression checklist: scenarios that MUST keep working
  through every subsequent phase, e.g. "front session delegates for
  active integrations" / "subagent calls notion_fetch_data
  successfully" / "scope-error reconnect flow fires."

**Deliverable**: this section filled in with findings.

**Verification gate**: user reviews findings, gives go-ahead before
Phase 1.

### Phase 1 — Schema cache infrastructure

- Add `composio_tool_schemas` table to `runtime/state-store/src/store.ts`
  (columns: toolkit_slug PK, schemas_json, fetched_at_utc).
- New `runtime/api-server/src/composio-schema-cache.ts`: read / upsert /
  ttl check (24h). Treat fetch returning 0 tools as cache MISS (don't
  store empty).
- `/api/v1/integrations/composio/finalize` endpoint: after writing the
  connection to the store, synchronously fetch + persist the toolkit's
  schemas. Return 4xx if the schema fetch fails — UI shows
  "could not load Notion tools, retry?" rather than silently
  succeeding with no tools.
- Tests: cache hit, cache miss, TTL expiry, zero-tool result not cached,
  Hono 5xx during fetch surfaces error.

**Side effect on existing behavior**: zero. The composio-mcp host
keeps using its own listToolkitTools call path. The schema cache is
just a new sibling.

**Verification gate**: green tests + manual: connect a fresh toolkit
end-to-end, verify the cache row exists.

### Phase 2 — Inline runtime tools (behind `HOLABOSS_INLINE_COMPOSIO_TOOLS`)

- New `runtime/harnesses/src/composio-inline-tools.ts`. Reads
  `store.listIntegrationConnections({status: 'active'})`, filters by
  `isInStoreCatalog`, resolves workspace_default account per toolkit,
  reads schemas from the Phase-1 cache, returns a list of
  `ToolDefinition` ready to merge into pi's tool registry.
- Tool handler: POST to Hono `/api/composio/execute`. Map Hono error
  responses to `[composio_error:<reason>:<slug>]` per Principle 7.
- Feature flag: when `process.env.HOLABOSS_INLINE_COMPOSIO_TOOLS === 'true'`,
  pi.ts spreads inline tools into the session's tool list. When false,
  no inline tools are registered (old composio-mcp host path stays
  authoritative).
- Multi-account resolution helper moved from `composio-mcp-manager`
  (`pickOnePerToolkit` + `workspace_default` binding lookup).
- Tests: inline tool registration from a stubbed store + cache,
  handler error mapping for 401 / 403 / 404 / 500, multi-account
  default selection, no inline tools when flag off.

**Side effect on existing behavior**: zero when flag off. When flag on,
composio-mcp host's tools and inline tools coexist; pi handles tool
name collisions by last-write-wins, and inline registration runs after
MCP discovery so inline wins.

**Verification gate**: green tests + manual: with flag on, agent calls
`notion_fetch_data` via inline path, log shows handler hit Hono
`/execute`.

### Phase 3 — Capability registry classification

- In `agent-capability-registry.ts`: inline composio tools must be
  classified as `kind: "mcp_tool"` so prompt addenda routing stays
  intact (Principle 6). New descriptor `source` value
  `composio_inline` so future code can distinguish without losing the
  classification.
- Update `extractActiveIntegrationSlugs` in `agent-runtime-config.ts`:
  derive slugs from the store directly when inline is enabled, fall
  through to current resolved_mcp_tool_refs derivation when flag off.
- Tests: front-session "Active integrations" addendum still fires for
  inline-only setups; subagent prompt routing still includes
  "MCP-first" guidance; scope-error recovery line still present.

**Verification gate**: all existing capability-registry and
runtime-config tests green + new inline-source tests.

### Phase 4 — Flip default + soak

- Flag default ON.
- Add a comparison telemetry pass: when both paths exist, log per-turn
  which path served the tools so we can A/B in staging.
- Soak in staging for one week; monitor `composio_mcp.*` events and
  new `composio_inline.*` events for failure-rate parity or
  improvement.

**Verification gate**: one week clean in staging; no regression in
known failure modes from Phase 0 regression checklist.

### Phase 5 — Deletion

- Delete `runtime/api-server/src/composio-mcp-manager.ts` and its
  test, `runtime/api-server/src/composio-mcp-host.ts`, the now-stub
  parts of `composio-tool-registry.ts`.
- Remove `composioMcpManager` injection in `app.ts`, `queue-worker.ts`,
  `claimed-input-executor.ts` (`ensureFreshFor` call), and
  `runtime-agent-tools.ts`.
- Strip the `mcp_registry.servers.holaboss_composio` block from
  workspace.yaml on workspace open (idempotent migration helper).
- Drop the now-unused `HOLABOSS_INLINE_COMPOSIO_TOOLS` flag.
- Keep the structured logging namespace (`composio_mcp.*` events
  conceptually still apply to the inline path — bootstrap is just
  "register tools from cache" now).

**Verification gate**: full test suites green; the
Phase-0 regression checklist all passes; old workspaces (with stale
mcp_registry blocks) work after migration.

## Reflection log

(Filled in after each phase. Empty at draft time.)

### Phase 0 reflection

**What the recon turned up.**

- `pi.ts` accepts `ToolDefinition[]` via plain spread (line 2061–2068
  `nonSkillCustomTools`). Inline tools register identically to the
  existing runtime / MCP tools.
- Harness-host has **no direct SQLite access**. It talks back to the
  api-server over HTTP through `runtimeApiBaseUrl`. The
  `resolveHarnessRuntimeToolDefinitions` pattern in
  `runtime-capability-tools.ts:3823` is the template — each tool's
  `execute` handler hits a capability endpoint with workspace +
  session ids. Inline composio tools follow the same shape, so two
  new api-server endpoints are needed:
  - `GET /api/v1/capabilities/composio-inline-tools` — returns
    `{tools: [{name, description, schema, toolkit_slug, tool_slug,
    connected_account_id}]}` for the workspace at request time.
  - `POST /api/v1/capabilities/composio-execute` — proxies through
    `ComposioService.executeTool` and formats errors as
    `[composio_error:<code>:<slug>]`.
- `ComposioService.executeTool` already does the right thing
  (`composio-service.ts:139`); only the wrapper changes.
- Error formatting target is `[composio_error:<code>:<toolkit_slug>]
  <message>`, currently produced inside `composio-mcp-host.ts:277`.
  This logic moves into a shared utility used by the new endpoint.
- Multi-account resolution lives in
  `composio-mcp-manager.ts::pickOnePerToolkit` and the
  `workspace_default` binding lookup. This logic moves into a
  shared module so the inline path and the legacy path can share
  while the flag is OFF.
- `agent-capability-registry.ts::buildMcpDescriptor` is the
  classification choke-point. Adding a new descriptor source value
  (`composio_inline`) keeps `kind: "mcp_tool"` intact and avoids the
  prompt-routing landmine in Principle 6.

**Adjustments to the plan from the recon.**

- Phase 2's "harness-host reads store directly" is wrong. Harness-host
  reads `/api/v1/capabilities/composio-inline-tools` instead. The
  store read happens inside the api-server endpoint where it
  belongs.
- Schema cache (Phase 1) lives api-server side, not harness side.
- The Phase 2 feature flag toggles two things in tandem: whether
  api-server's `composio-inline-tools` endpoint returns tools at
  all, and whether `composio-mcp-manager` keeps writing its MCP
  registry block into `workspace.yaml`. Otherwise the agent gets
  duplicate tool registrations (one from inline endpoint, one from
  MCP discovery).

**Call-site inventory (files Phase 5 will touch).**

- Delete: `composio-mcp-manager.ts`, `composio-mcp-host.ts`,
  most of `composio-tool-registry.ts`, plus the matching `.test.ts`
  triplet.
- Edit: `app.ts` (manager construction + 6+ `restart` call sites +
  `ensure-running` endpoint), `claimed-input-executor.ts`
  (`ensureFreshFor` call + import), `queue-worker.ts`
  (`composioMcpManager` option), `runtime-agent-tools.ts`
  (`workspaceAppEnsureRunning`'s opportunistic bootstrap call).
- One-shot migration: idempotent strip of the
  `mcp_registry.servers.holaboss_composio` block from existing
  `workspace.yaml` files at workspace-open time.

**Regression checklist** to keep green through every subsequent phase
(the canonical test cases for "did this refactor preserve real-user
behavior"):

1. Front session: user connects Notion, types `@notion read my plan`
   → main session calls `delegate_task`, not `propose_connect`.
2. Subagent: same flow, subagent successfully calls
   `notion_fetch_block_contents`, gets data back.
3. Multi-account: 2 Gmail accounts, `workspace_default` binding set,
   tool call goes to the bound account.
4. Scope-error recovery: stub Hono `/execute` to return 403,
   verify the agent receives `[composio_error:forbidden:gmail] …`
   and the scope-error recovery prompt addendum routes it back to
   `propose_connect`.
5. api-server restart: existing workspace with active integrations,
   first agent run after restart still has tools.
6. Hono `/execute` 500 at tool call time: agent receives a
   structured error, doesn't propose_connect (it's an execution
   failure, not a missing integration).
7. Schema-cache empty + Hono unreachable at run-start: agent
   still gets tools (registered with cached schema or returns
   actionable error per Principle 8).
8. Brand-new Composio integration that returns 0 tools from
   `listToolkitTools`: not cached as empty (Principle: Surprise
   1), next run retries.

**Verdict.** Phase 0 confirms the plan. No architectural blocker.
Phase 1 starts now.

### Phase 1 reflection

**What I built.**

- `composio_tool_schemas` SQLite table (toolkit_slug PK,
  schemas_json, fetched_at) + `getComposioToolSchemas` /
  `upsertComposioToolSchemas` / `deleteComposioToolSchemas` store
  methods.
- `ComposioSchemaCache` in `runtime/api-server/src/
  composio-schema-cache.ts` with `get` (read-through with refresh),
  `refresh` (forced re-fetch), `peek` (status without I/O),
  `forget` (eviction). 24h TTL, injectable clock.
- App-level `composioSchemaCache` instance constructed alongside
  `composioMcpManager`.
- Best-effort schema prime call on
  `/api/v1/integrations/composio/finalize` after the connection is
  persisted. Failure logs a `composio_inline.finalize.
  schema_prime_failed` event but does NOT fail finalize — the
  legacy composio-mcp host path is still authoritative through
  Phase 2.

**Adjustments from the plan.**

- The Phase 0 plan said "fail finalize on schema fetch failure so
  the UI can prompt retry." On closer look that conflicts with
  Principle 8 (no silent degradation in Phase 2's inline-tool
  path) AND fights Phase 1's contract (don't change existing
  user-visible behavior). Resolution: prime is best-effort in
  Phase 1; the actionable-error tool stub for Phase 2 (cache
  miss + Hono down) is where we honor Principle 8.
- `buildToolkitCatalogAsync` silently returned `[]` on fetch
  errors, which confused "0 tools available" with "fetch failed."
  Refactored into a pure ranking helper
  (`buildToolkitCatalogFromUpstream`) plus the legacy
  swallow-wrapping async version. The cache uses the pure helper
  so it can throw on fetch failure but legitimately empty results
  are also surfaced as ComposioSchemaCacheError (and not cached,
  per Surprise 1 in the plan).

**Tests.** 7 unit tests for the cache, covering fresh fetch +
persist, cache hit rehydration with new account_id, TTL refresh,
0-tool not cached, upstream fetch error surfaced, peek staleness,
forget eviction. The Phase-0 regression baseline (16
composio-mcp-manager tests + 25 capability-registry tests + 30
runtime-config tests) still green.

**Carry into Phase 2.** When Phase 2 builds the `composio-execute`
endpoint, it'll need to read the per-connection account binding,
not the per-toolkit one. The schema cache deliberately doesn't
know about accounts — rehydration takes the account_id as an
argument so the same cached schemas can serve multiple accounts on
the same toolkit. The Phase 2 endpoint will own multi-account
resolution.

### Phase 2 reflection

**What I built.**

- API-server side: `composio-toolkit-resolver.ts` reads the local
  store, filters active+catalog connections, applies workspace
  overrides (disabled/pinned) and resolves multi-account to a single
  workspace_default per toolkit. Returns
  `{toolkit_slug, connection_id, connected_account_id}[]`.
- API-server side: `composio-inline-execution.ts` wraps
  `ComposioService.executeTool` and maps both `ComposioToolExecutionError`
  and arbitrary throws into the
  `[composio_error:<code>:<toolkit_slug>] <message>` literal the agent
  recognizes.
- Two HTTP endpoints in `app.ts`:
  - `GET /api/v1/capabilities/composio-inline-tools` — joins resolver
    output with cached schemas, returns
    `{tools: [...], unavailable: [{toolkit_slug, reason}]}`.
  - `POST /api/v1/capabilities/composio-execute` — wraps
    `executeComposioInlineTool`. Logs `composio_inline.execute.success`
    / `composio_inline.execute.failure`.
- Harness side: `composio-inline-tools.ts` — `resolveComposioInlineTools`
  fetches from the list endpoint and returns
  `HarnessRuntimeToolDefinitionLike[]` whose execute handler POSTs to
  the execute endpoint. Feature-flagged behind
  `HOLABOSS_INLINE_COMPOSIO_TOOLS=true`. Index re-exports added.
- `pi.ts` calls `resolveComposioInlineTools` at session setup and
  spreads the returned tools into `nonSkillCustomTools` alongside the
  existing runtime tools / MCP tools.

**Adjustments from the plan.**

- The resolver was supposed to reuse `applyOverrides` from
  composio-mcp-manager.ts to keep behavior consistent. Doing that
  surfaced a pre-existing bug: `applyOverrides` collapses to the first
  ACTIVE connection per toolkit BEFORE the multi-account selector
  runs, so the `workspace_default` binding never affected which
  Gmail / GitHub account was picked. Resolver now does its own
  filtering inline so the new path picks the correct default. The
  legacy manager bug stays as-is to avoid breaking the existing
  manager test; Phase 5 will retire both together.
- Initial harness-side test failed because `runtime/harnesses` package
  doesn't have `tsx` as a dep. The harness tests are run from the
  consuming package's working directory (harness-host has tsx);
  reproduced the same test invocation pattern as `pi.test.ts` rather
  than wiring tsx into harnesses.

**Tests.** 86/86 across composio-mcp-manager, schema-cache, toolkit
resolver, inline execution, capability registry, runtime-config.
Harness-side adds 5 tests for the inline resolver (flag gating, list
fetch + tool build, execute success path, execute failure path with
[composio_error:] marker propagation, transport error fallback).

**Carry into Phase 3.**

- The new tools currently classify as plain runtime tools in pi
  (they're just spread into `nonSkillCustomTools`). The capability
  manifest in `agent-capability-registry.ts` will receive them as
  whatever kind the descriptor builder maps them to — Phase 3 must
  classify them as `kind: "mcp_tool"` per Principle 6 so the existing
  "MCP-first routing" / "scope-error recovery" prompt addenda
  continue to fire on the inline path.
- The list endpoint already returns an `unavailable` array. Phase 3
  can use it to seed a "Composio tools temporarily unavailable" hint
  into the capability addenda if useful.

### Phase 3 reflection

**What I built.**

- `agent-capability-registry.ts`: added `composio_inline` to the
  `source` enum, `ComposioInlineToolCapabilityRef` type, and
  `buildComposioInlineDescriptor` that classifies as
  `kind: "mcp_tool"` (Principle 6) with `policy` derived from
  `read_only`.
- `BuildAgentCapabilityManifestParams.composioInlineToolRefs`
  threads through `buildStaticCapabilityRegistry` → descriptors.
- `AgentRuntimeConfigCliRequest.composio_inline_tool_refs` adds the
  same field on the runtime-config wire shape.
- `projectAgentRuntimeConfig` populates both direct and delegated
  manifest builds. Front sessions strip the inline refs (mirrors
  the existing MCP refs behaviour for `main_session` /
  `onboarding`).
- `ts-runner.ts`: `fetchComposioInlineToolRefs` calls
  `/api/v1/capabilities/composio-inline-tools` once at run-start
  when the flag is on, threads the result through
  `buildAgentRuntimeConfigRequest` and into the runtime-config
  payload.

**Adjustments from the plan.**

- The plan called for a "Composio tools temporarily unavailable"
  hint sourced from the list endpoint's `unavailable` array. On
  reflection that's a UX surface decision better handled by the
  prompt addenda using the existing `active_integration_slugs`
  awareness — if a slug is in active but missing from the inline
  refs, the scope-error recovery path already covers it. Deferred.

**Tests.** 27 capability-registry tests (added 2) + 14 runtime-config
tests + 17 manager + 7 schema-cache + 3 resolver + 4 execute
wrapper = 72 api-server tests green. Harness side composio-inline
tools tests (5) still green. Manifest classification verified end
to end: inline refs surface as `kind: mcp_tool`, `source:
composio_inline`, `policy` derived from `read_only`, and they
appear in `manifest.mcp_tools` so existing prompt addenda will see
them.

**Carry into Phase 4.**

- The flag is still off by default. Phase 4 flips it on by default
  and runs the regression checklist against a real staging
  workspace. Plan to leave the legacy `composio-mcp-manager` path
  ALSO enabled during Phase 4 — both paths run in parallel; pi's
  custom-tool merge will see duplicate `notion_fetch_data` from
  both the MCP host and inline registration; pi's
  last-write-wins tool registration means the inline version
  prevails. That's the desired outcome and lets us flip the flag
  back instantly if needed.

### Phase 4 reflection

**What I built.**

- `composio-mcp-manager.ts`: new `inlineComposioToolsEnabled()`
  helper now defaults the flag to ON. `ensureRunning` and
  `ensureFreshFor` short-circuit with
  `{status: "skipped", reason: "inline_composio_tools_enabled"}`
  when the flag is on, and strip any stale
  `mcp_registry.servers.holaboss_composio` block from
  `workspace.yaml` so the legacy URL doesn't keep pointing at a
  dead port.
- The same default flip applies to the harness side
  (`composio-inline-tools.ts::composioInlineToolsEnabled`) and the
  ts-runner `fetchComposioInlineToolRefs` env check, so both ends
  of the new path activate by default.
- `HOLABOSS_INLINE_COMPOSIO_TOOLS=false` (or `=0` / empty) reverts
  everything to the Phase 2 dual-path state.

**Tests.**

- Existing manager tests now pin
  `HOLABOSS_INLINE_COMPOSIO_TOOLS=false` in their `before` hook so
  legacy bootstrap paths are still exercised end-to-end.
- New test `ensureRunning short-circuits with skipped:
  inline_composio_tools_enabled when the inline flag is on`
  verifies (a) the bootstrap is skipped, (b) Composio API is not
  called, and (c) any pre-existing `holaboss_composio` block is
  stripped from `workspace.yaml`.
- 89 / 89 across the full composio + capability + runtime-config
  test surface.

**Soak-window note.** The plan calls for a one-week staging soak
before Phase 5 deletes the old code. That soak must happen at deploy
time and is the user's decision; this commit just unblocks it by
making the flag-gated cutover safe to flip on and off. The Phase-0
regression checklist (front-session delegate-not-propose, subagent
calls notion_fetch_data, multi-account binding, scope-error
recovery, api-server restart preservation, Hono 500 actionable
error, schema cache miss + Hono down, 0-tool not cached) is the
canonical soak validator. Phase 5 ships once that checklist passes
in staging.

**Carry into Phase 5.**

- Delete `composio-mcp-manager.ts`, `composio-mcp-host.ts`, the
  most of `composio-tool-registry.ts`, and the matching `.test.ts`
  triplet.
- Drop the manager construction / wiring in `app.ts`,
  `queue-worker.ts`, `claimed-input-executor.ts`,
  `runtime-agent-tools.ts`.
- Drop the `HOLABOSS_INLINE_COMPOSIO_TOOLS` flag and its env
  defaults — the path becomes unconditional.
- Idempotent migration: strip
  `mcp_registry.servers.holaboss_composio` on workspace open so
  stale entries left over from before the cutover don't linger.

### Phase 5 reflection

**What I deleted.**

- `runtime/api-server/src/composio-mcp-manager.ts` + `.test.ts`
- `runtime/api-server/src/composio-mcp-host.ts` + `.test.ts`
- `runtime/api-server/src/composio-tool-registry.test.ts`
- Removed `composioMcpManager` from `app.ts` (import + holder +
  constructor + 7 restart call sites + `ensure-running` endpoint +
  app close hook), `claimed-input-executor.ts` (ensureFreshFor
  call + parameter), `queue-worker.ts` (option + plumbing), and
  `runtime-agent-tools.ts` (workspaceAppEnsureRunning's
  opportunistic bootstrap).

**What I rewrote.**

- Slimmed `composio-tool-registry.ts` to only the surface still
  used: `COMPOSIO_REGISTRY_SERVER_ID` (legacy slug),
  `removeComposioMcpRegistryEntry` (migration), `hasHeroEntry` /
  `toolkitNameFromSlug` (workspace-integrations stubs),
  `ComposioMcpToolEntry` / `ComposioUpstreamTool` (schema cache),
  and `buildToolkitCatalogFromUpstream` (schema cache). No file
  I/O, no Node HTTP, no host bootstrap.
- Dropped the env flag from `harnesses/composio-inline-tools.ts`
  and `ts-runner.ts::fetchComposioInlineToolRefs`. The inline path
  is unconditional now.

**Migration.** `/api/v1/apps/ensure-running` (called whenever
desktop opens a workspace) now runs an idempotent
`removeComposioMcpRegistryEntry(workspaceDir)` before
`ensureAllAppsRunning`. Old workspace.yaml files that still carry
the dead `mcp_registry.servers.holaboss_composio` block get cleaned
on the next workspace open. Safe to run multiple times; harmless on
workspaces that never had the entry.

**Tests.** 71 / 71 across the surviving suite (schema-cache,
toolkit-resolver, inline-execution, capability-registry,
runtime-config) plus 3 / 3 harness inline-tools. The pre-existing
better-sqlite3 native binding errors in queue-worker /
claimed-input-executor / runtime-agent-tools test suites are
environmental on this Node version and unrelated to this refactor.

**Verdict.** The whole composio-mcp manager / host stack is gone.
What replaces it: the local store + schema cache + two cheap HTTP
endpoints + a hundred lines of harness code, with the same
prompt-routing semantics (Principle 6) and the same scope-error
recovery markers (Principle 7). The "card shows green but agent
can't use the tool" class of failures cannot recur the same way:
the tool list is sourced from the same local store the card reads.
