# Org-scoping desktop resources (Projects, Automations, Channels, Browsers)

**Status:** proposal · **Date:** 2026-07-16 · **Area:** desktop runtime
(`runtime/state-store`, `runtime/api-server`) + renderer list/read paths

## Context

Holaboss desktop is single-user / single-machine / single-root. "Org" here is the
**active tenancy + billing context** the user acts as (Personal vs a team org).
Switching the active org re-scopes backend calls and bills that org.

Today **only sessions are org-scoped**. `agent_sessions.org_id` (migration
`033-session-org-id`) is stamped with the active org at creation; the runtime bills
each run by reading `org_id` **off the session**, not off live runtime-config, so
switching org mid-work — or running two sessions across two orgs — attributes spend
correctly. `NULL` = unattributed/legacy (falls back to live runtime-config org).

Everything else is global per install:

| Feature | Backing store | `org_id`? |
|---|---|---|
| Sessions | `agent_sessions` | ✅ |
| Projects | `projects` | ❌ |
| Automations | `cronjobs` | ❌ |
| Channels | `channel_connections` | ❌ |
| Browsers | `browser-profiles/index.json` (file, not the DB) | ❌ |

## The distinction that decides each case

Scoping matters for two independent reasons:

- **(A) Billing correctness** — *who pays for the agent work this thing triggers.*
  Only load-bearing when the work runs **unattended**: there is no UI open at fire
  time, so "current active org" is meaningless. These need an org stamped at
  creation and read **off the record** at fire time — the exact lesson of 033.
- **(B) Tenancy coherence / visibility** — *which org sees / owns this in the UI.*
  Matters for containers and assets even when they never bill on their own.

Interactive agent work already bills correctly via the **session's** `org_id`. So
the question per feature is: *does it fire billable work with no human in the loop,
or is it just a container / asset?*

## The bug that motivates this

`cronjob-runtime.ts` creates a scheduled run's session **without** an `orgId`:

```ts
store.ensureSession({
  workspaceId: workspace.id,
  sessionId,
  kind: "main_session",
  title: cronjob.name.trim() || cronjob.description.trim() || "Scheduled run",
  createdBy: "cronjob",
  projectId,
});
```

So every automation run is org-`NULL` → falls back to the **live runtime-config
org** at fire time. An automation created while acting as iMerch, firing at 3am,
bills whatever org the UI last switched to — not iMerch. Same class as the
gateway/session billing leaks already fixed in this project.

## Verdicts

### Automations — YES · must-scope (correctness) · **P0**
Unattended by definition. Today's runs mis-attribute (above). Add `cronjobs.org_id`,
stamp `currentActiveOrgId()` at create, and — the non-negotiable part — have
`cronjob-runtime` pass that `org_id` into `ensureSession` so every fire bills the
creating org regardless of live config. Filter the Automations list by active org.

### Channels — YES · must-scope (correctness) · **P0**
Same shape: an inbound Slack/Discord message triggers an agent run with no UI
context. Needs a stable billing owner stamped at connect-time; the inbound-run path
reads `org_id` off the connection. Aligns with the backend, which **already** models
channel connectors as org-owned (HolaEmployee connector org-model). Add
`channel_connections.org_id`; scope every read/list/status/disconnect (not just
connect) — see the cross-org Slack leak lesson.

### Projects — YES · coherence, not billing · **P1**
A project only runs work *interactively* (you open a session in it while acting as
an org), so billing is already correct via the session. But a project **groups**
org-scoped sessions — leave it global and the same project shows N sessions in one
org and 0 in another, reading as empty/broken. Scoping it is the consistency fix.
Add `projects.org_id`; filter the projects list by active org.

### Browsers — NO (lean) · leave global · defer
Browser profiles are device-local cookie / fingerprint / login stores: they don't
sync, they're bound to the physical machine, and agent browser runs already bill via
the **driving session's** org. "Org-scoping cookies" mostly means re-logging-in per
org — friction, not tenancy. Revisit only if a team explicitly wants isolated login
sets per org.

## Summary

| Feature | Scope? | Why | Priority |
|---|---|---|---|
| Automations | ✅ | unattended billing (fixes a live leak) | P0 |
| Channels | ✅ | unattended billing + backend already org-owns connectors | P0 |
| Projects | ✅ | coherence with org-scoped sessions | P1 |
| Browsers | ❌ | device-local asset; billed via the session | defer |

## Implementation pattern (uniform — mirror migration 033)

For each scoped table:

1. **Migration:** add nullable `org_id TEXT`; index `(org_id, updated_at DESC)`
   where `org_id IS NOT NULL`. No backfill — pre-existing rows stay `NULL`
   (personal/legacy). Gate on the table existing (no-op on fresh installs).
2. **Create path:** stamp `orgId: currentActiveOrgId()`.
3. **List/read paths:** filter by active org — team → strict `org_id = ?`;
   Personal → `org_id IS NULL` (personal + legacy). Same `orgId` /
   `onlyUnattributedOrg` shape as `listSessions`.
4. **Unattended runners only (cron, channels):** read `org_id` **off the record**
   at fire time and pass it into the spawned `ensureSession` — never off live
   runtime-config.

`NULL` semantics stay identical to sessions, so Personal and pre-migration data
behave consistently across all four surfaces.

## Open questions

- **Automations bound to a project** (`cronjob.project_id`): if projects become
  org-scoped, a cronjob's org should agree with its project's org — validate on
  create, decide behavior if they diverge (reject vs. project wins).
- **Migration ordering vs. the org rollout** on prod (Supabase/Dokploy) — sequence
  with the frontend org gateway wiring already in flight.
- **Browsers**, if ever scoped: whether to scope the profile *record* or only its
  agent-driving binding (the latter is lighter and keeps cookies device-global).
