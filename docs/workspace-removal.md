# Workspace removal — end-to-end spec

**Branch:** `feat/workspace-refactor`
**Status:** Pieces 1–2 done + pushed; Pieces 3–5 specified below, ready to execute.

## 1. Target model (locked)

There is **no workspace**. The product is single-tenant: one user, one runtime.

- **Runtime root** — the single context. Holds:
  - **General sessions** — sessions bound directly to the root (no project).
  - **Runtime-global features** — memory, cronjobs, issues, integrations,
    capabilities, notifications, apps. These survive as *features*; they are
    simply scoped to the runtime now instead of to a workspace.
- **Project** — a lightweight grouping: **a folder + its files + the sessions
  bound to it.** Nothing else (no per-project memory/cron/etc.). It is today's
  project minus the workspace baggage.
- **Session** — carries an optional `project_id`. `null` = a general session at
  the runtime root; non-null = bound to that project's folder.

`workspace_id` used to do two jobs: a multi-tenant key (killed in Piece 1 —
single runtime) and a work-context shard for sessions/files. The second job
becomes the **optional, nullable `project_id` on sessions**. Everything else
that was workspace-scoped becomes runtime-global.

**The clean framing: `$HB_SANDBOX_ROOT` _is_ the one-and-only workspace.** The
per-workspace store (the `data.db` schema and its tables) survives exactly once —
as the root's store; `workspace_id` drops because only one workspace is left (the
root); `workspace_projects` survives as the project sub-grouping. **Every past
workspace — including the Piece-1 canonical one — folds into the root as a
project.** So the canonical pin is purely transitional (it keeps reads working
while we peel the layers); by Piece 5 even that workspace becomes a project, and
the root itself is the single surviving workspace.

### Where the runtime root lives (physical)

The runtime root **already exists** — it is `HB_SANDBOX_ROOT` (the sandbox root
the desktop points at a persistent app-data dir; falls back to
`os.tmpdir()/sandbox` in dev/tests). **Data and files are cleanly separated:**
all *data* in one centralized DB, *files* in plain folders.

```
$HB_SANDBOX_ROOT/state/
├── data.db          # THE root store (dedicated): ALL session data — general +
│                    #   every project's — plus memory, cron, and the projects
│                    #   registry. One centralized DB, like a single workspace's
│                    #   data.db was, but now the only one.
└── host-state.db    # host/runtime state

~/Holaboss/Projects/<project-name>/   # files ONLY, no DB — the agent's working
└── <user files>                      #   files for sessions bound to this project
```

Deliberate simplification vs today's per-workspace sharding:

- **One dedicated root `data.db`** holds *all* session data — general (root)
  sessions and every project's sessions alike — plus the global features
  (memory/cron/…) and the `projects` registry. **Projects do NOT get their own
  DB** (today each *workspace* had its own `data.db`; that sharding is removed).
- **A project is just a registry row `{id, name, path}` + a folder of files**,
  default `~/Holaboss/Projects/<name>/`. The folder stores *only* files; the
  session data lives in the root `data.db`, linked by `project_id`.
- **General (root) sessions** keep their files at the runtime-root working dir
  and their data in the same root `data.db` (`project_id` null).

So the new physical work is: **centralize all session data into the one root
`data.db`**, and reduce project folders to plain file directories under
`~/Holaboss/Projects/`. The per-workspace `data.db` sharding goes away entirely.

## 2. Scope

**In scope:** remove the workspace concept from UI (done), API, runtime, and
schema; introduce `project_id` as a nullable session attribute; rename the
existing `workspace_projects` table to `projects`; migrate legacy workspace
data into projects.

**Out of scope (separate follow-on goal):** building a *projects UX* (a
switcher/dashboard/creation flow for projects). Projects are surfaced only
through existing project surfaces for now. We just deleted the workspace
switcher — we are **not** rebuilding it for projects in this goal.

**Dropped:** the backend `POST /workspaces` mint-guard (the UI can no longer
create workspaces; the Piece-1 resolver tolerates stray multiples; the endpoint
disappears in Piece 5 anyway).

## 3. Data model — what's project-scoped vs runtime-global

Default rule: **work-in-a-folder → project (via the session); everything else →
runtime-global.**

| Today (workspace-scoped) | Becomes |
| --- | --- |
| `agent_sessions` | runtime-global, **+ nullable `project_id`** (the one new column) |
| session descendants (`session_messages`, `turn_results`, `session_runtime_state`, `session_output_events`, `terminal_sessions`, `subagent_runs`, `outputs`, `output_folders`, `interaction_*`, …) | runtime-global; reachable via `session_id` — just **drop `workspace_id`**, no `project_id` needed (project is inherited from the session) |
| `workspace_projects` | **rename → `projects`**, drop `workspace_id` (projects attach to the runtime); `{id, path, name, …}` |
| memory, cronjobs, issues, integrations (trees/leaves/bindings), capabilities, notifications, app_builds/app_ports | runtime-global — **drop `workspace_id`**, single namespace; features unchanged |
| `workspaces` table | **dropped** |
| `draft_lab` / lab workspaces (`workspace_role`, `source_workspace_id`, `lab_*`) | **dropped** (labs die) |

So the schema change is overwhelmingly **"delete a column,"** with `project_id`
*added* in exactly one place (`agent_sessions`).

> Implementation note to verify: how do sessions link to projects *today*
> (a `project_id` column on `agent_sessions`, a cwd match against `project_path`,
> or a separate map)? Reuse the existing linkage for `project_id` if present.

## 4. Legacy migration (runs in Piece 5)

- **Every workspace → a project, uniformly — including the Piece-1 canonical
  one.** Create a project row (`id` = old `workspace_id`, `path` =
  `~/Holaboss/Projects/<name>/`), **fold its sessions into the root `data.db`**
  tagged with that `project_id`, and move its files into the project folder.
  Every install does an N→1 consolidation of all workspace `data.db`s into the
  single root `data.db`.
- **The root starts with no general sessions.** General (`project_id` null)
  sessions are net-new going forward; the migration seeds none — all migrated
  work lands under its project.
- **`project_id` = the former `workspace_id`** so re-tagging is a rename and
  references stay valid.
- **Nested projects flatten** — a workspace that already contained projects:
  those become top-level peer projects, not nested.
- **Do NOT carry over** per-workspace memory / cron / issues / integration
  bindings / capabilities. The features live on at the root; their legacy
  per-workspace rows are dropped, not merged.
- **Skip** soft-deleted workspaces (`deleted_at_utc`) and `draft_lab`/lab rows.

**Legacy memory/cron — resolved (drop):** since every workspace (canonical
included) becomes a project, there is no privileged "root" workspace whose
memory/cron to carry forward. Per-workspace memory / cron / issues / bindings /
capabilities rows are simply **dropped**; the features start fresh at the root
and re-accumulate from there. No open decisions remain.

## 5. Execution plan (strangle top-down; each piece ships working)

- **Piece 1 — Pin the key. ✅ DONE** (`f32f3db4`). Server, not client, decides
  the workspace. `runtime/api-server/src/canonical-workspace.ts`
  (`resolveCanonicalWorkspaceId` = `listWorkspaces()[0]`, `pinWorkspaceIdInContext`);
  an `onRequest` header stamp + a wrapped oRPC/MCP context. Transitional — the
  "canonical workspace" distinction dissolves in Piece 5.
- **Piece 2 — Collapse the desktop UI. ✅ DONE** (`e8835341`, `d0651d32`,
  `ca881a5e`, `16b94ed5`, `e9262281`; ~5,900 lines). Control Center, switcher
  (Sidebar + dead TopTabsBar), creation UI, switch-navigation (⌘1-9 + entity
  switch-calls), orphaned components. Dormant selection-provider internals left
  in place; they dissolve when `workspaceId` leaves the API (Piece 3).
- **Piece 3 — Remote API contract.** Drop `workspaceId` from `workspaceScoped`
  (`packages/remote-api/src/contract/shared.ts:11`) and remove the
  `x-holaboss-workspace-id` header. Session procedures key by `session_id`;
  add an optional `project_id` filter to list-sessions; projects get light CRUD.
  Delete the Piece-1 pins (`canonical-workspace.ts` usage). Remove the now-truly-
  dead desktop selection-provider internals here.
- **Piece 4 — Un-thread the runtime.** Stop threading `workspaceId` through
  context / session-routing / queue / **channel-gateway** (inbound IM lands in a
  runtime-root general session by default; a channel may optionally bind to a
  project). Flatten the filesystem (`workspaceDir*`, `.holaboss/state/<ws>` →
  runtime root + per-project folders).
- **Piece 5 — Schema + migration.** Drop `workspace_id` from all tables, add
  nullable `project_id` to `agent_sessions`, rename `workspace_projects` →
  `projects`, drop the `workspaces` table; run the §4 migration. SQLite ⇒
  table rebuilds, but mechanical. Last.

## 6. Verification

- Desktop: `turbo run typecheck --filter=holaboss-local` (deps build first).
- API server: `turbo run typecheck --filter=@holaboss/runtime-api-server`, plus
  `node --import tsx --test --test-force-exit` over `src/**/*.test.ts`
  (enumerate via `find`; the bun glob doesn't expand `**`).
- Note: the brittle `*.test.mjs` source-snapshot tests are NOT in the
  `*.test.ts` runner glob; several are already stale/failing — safe to delete
  when their target changes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
