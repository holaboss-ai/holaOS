# PRD — Sessions, Projects, and the General bucket

**Status:** Draft · discussion-stage
**Owner:** Sam
**Wireframe:** [`docs/sidebar-wireframe.txt`](./sidebar-wireframe.txt)
**Date:** 2026-06-16
**Branch context:** `feat/ux-rebuild`

---

## 1. Summary

Today the sidebar's personal block shows pinned files/outputs and recents — it never surfaces chat **sessions**. Sessions are only reachable via a flat dropdown in `MainSessionPicker.tsx`. We want to make sessions the centerpiece of the sidebar, and introduce **Projects** as a first-class entity so a session can be either:

- **General** — workspace-scoped, no project (`project_id IS NULL`); the agent's cwd is the **workspace path**.
- **Project-scoped** — bound to a project (`project_id = …`); the agent's cwd is the **project's own path**.

The sidebar lists every project as its own collapsible section plus a General section. The wireframe in `docs/sidebar-wireframe.txt` is the visual source of truth.

## 1a. Intermediate phase (this iteration)

This PRD is sliced into two phases. The **intermediate phase** lands the entity, the page, and the cwd-binding without the full sidebar-IA rewrite. Locked decisions:

- **Project entity** ships: table, IPC, Projects index page, project landing page, `[▢] Projects` row in the workspace nav.
- **`agent_sessions.project_id`** column ships and drives cwd resolution. `project_id` is **set at create time only** — no `moveSession` IPC, no move UI, no drag-to-section in this phase.
- **Project name is decoupled from `project_path`.** The user-facing name is just a label; the directory on disk is independent and can be renamed, moved, or recreated without affecting the project name.
- **`project_path` accepts any directory** — no emptiness check, no "already a project" check. Two projects pointing at the same directory is allowed.
- **Project landing page is the only entry point for creating project-scoped sessions in intermediate.** Clicking a project card opens a page titled with the project name, containing a chat composer with placeholder "What would you like to work on in this project?". The composer has **no project selector** and **no "Ask" affordance** — only the model selector. Submitting one user message creates a new `agent_session` with `project_id` set to that project, and routes into the existing chat pane. Until that submit happens, no session row is created. The right-side panels in the reference screenshot (Instructions, Scheduled, Context) are **out of scope** for intermediate.
- **Project view is an overlay, not an internal tab.** Both the Projects index and the project landing page render as a full overlay that covers the entire central pane (chat + right side). The sidebar stays visible. There is no `projects_index` or `project_landing` internal tab kind — instead a single `projectViewAtom` with values `null | { mode: "index" } | { mode: "landing"; projectId }` drives the overlay. Submitting the first message on a landing page clears `projectViewAtom` and selects the newly created session, after which the chat pane takes the full central size with the middle composer pane collapsed.
- **Reopening behavior:** clicking the same project card again while the landing is open is a no-op. Switching workspaces or opening a sidebar nav row clears `projectViewAtom`. Composer text on a landing page that's never submitted is **ephemeral** — discarded on view-close, no draft persistence.
- **Create-project flow is a two-step modal** (see wireframe Scene 4). Step 1 offers two options: `Start from scratch` and `Use an existing folder`. The third option `Import a project` from the reference screenshot is **out of scope**. Step 2 is a unified form with Name (required) + Location (path display with a "Choose folder…" affordance). `Start from scratch` defaults the location to `~/Holaboss/Projects/<Name>` (live-updating as the user types Name) and creates the directory on submit if it doesn't exist. `Use an existing folder` requires the path to already exist. The reference screenshot's `Instructions` field and `Add files` block are **out of scope** for intermediate.
- **Default project icon** mirrors workspace behavior: name's first letter, deterministic color rotation. The create modal does not show an icon picker; icon is set later via the card's `⋮ → Change icon` action (reusing `WorkspaceIconPicker`).
- **Project outputs** live in the project's own outputs folder (under `project_path`). Outputs from General sessions continue to live under the workspace path.
- **Recents section is removed from the sidebar.** `SidebarRecentsSection`, `RecentFileRow`, `RecentOutputRow`, the helper type `RecentItem`, and the recents read in `SidebarPersonalDivider` are all deleted. The underlying state files (`state/recentFiles.ts`, `state/recentOutputs.ts`) and their callers in `Center.tsx`, `ChatPane/index.tsx` (`@`-mention suggestions), `TopChrome.tsx`, `FilePreviewPane.tsx`, and `useOpenWorkspaceOutput.ts` are intentionally left as-is in this phase — fully ripping them out is a follow-up since other surfaces still consume them.
- **Favorites stay workspace-keyed** as today — no `project_id` on favorites.
- **Workspace switcher popover loses two actions:** `Publish to Store` and `Create new workspace`. Users can no longer create new workspaces from the UI in this phase. Workspaces become provisioned-only.
- **Project deletion → sessions transition to General.** `ON DELETE SET NULL` on the FK, open chat tabs auto-relabel to reflect the General association.
- **`project_path` is immutable after creation**, matching workspace parity. Repairing a missing folder requires delete + recreate.
- **Same-directory projects are allowed** — no uniqueness constraint on `project_path` within or across workspaces.
- **No backfill** — every existing session stays General; no auto-created default project per workspace.

The full sidebar-IA rewrite (per-project sections, General as a first-class section header, `[+] New chat` defaulting to General, `●`/selected semantics, Scheduled section) follows in a later phase and is documented below for context but is out of scope for the intermediate PR.

## 2. Goals

- Make every chat session discoverable from the sidebar without a dropdown.
- Let users group work by directory-bound project without losing the existing single-workspace context.
- Preserve the property that a session can be reassigned between General and any project at any time.
- Add a dedicated Projects management page (cards, sort, search, create).

## 3. Non-goals (this iteration)

- No sort control on the per-section session lists (wireframe shows `⌄` only; sort comes later).
- No multi-workspace cross-listing — General is per-workspace.
- No removal of the existing `WorkspaceSwitcher` or top-level workspace concept.
- No automation/cronjob redesign — the Scheduled section just reuses existing session fields.
- No "currently focused project" mode that filters the sidebar — every project is always visible.

## 4. Concepts

### 4.1 Workspace (unchanged)

Today's `WorkspaceRecord`: `id`, `name`, `workspace_path`, `icon`, `iconColor`, `folder_state`. Stays as the outer container in the top-left switcher.

### 4.2 Project (new)

A first-class entity with the same creation flow as a workspace.

```ts
type ProjectRecord = {
  workspace_id: string;
  project_id: string;
  name: string;
  project_path: string;      // OWN directory, NOT nested under workspace_path
  icon: string | null;
  icon_color: string | null;
  folder_state: "present" | "missing";
  created_at: string;
  updated_at: string;
};
```

- One workspace contains many projects. Projects are listed under their workspace; switching workspace switches the visible project list.
- `project_path` is independent. The picker is the same dir picker the workspace creation flow already uses.
- Rename, change icon, reveal-in-Finder, and delete mirror the existing workspace affordances.

### 4.3 Session (extended)

Existing `agent_sessions` row gets one new column:

```sql
ALTER TABLE agent_sessions ADD COLUMN project_id TEXT NULL
  REFERENCES workspace_projects(project_id) ON DELETE SET NULL;
```

- `project_id IS NULL` → **General**.
- `project_id = X` → bound to project X. Agent cwd = `projects[X].project_path`.
- All other session fields (`is_active`, `parent_session_id`, `cronjob_id`, `workflow_trigger_kind`, …) keep their current meaning.
- The Scheduled section in the sidebar is a filtered view: sessions where `cronjob_id IS NOT NULL` OR `workflow_trigger_kind = 'cron'` (exact filter TBD — see Open Questions).

## 5. Information architecture (see wireframe Scene 1)

Personal block, top to bottom:

1. **Scheduled** — only rendered if non-empty. Workspace-wide; one row per scheduled session with a `Manual / Cron` chip.
2. **General** — workspace-scoped sessions with `project_id IS NULL`. Always shown (even if empty, since `[+] New chat` defaults here).
3. **One section per project**, in `updated_at DESC` order (matching the Projects page sort default). Each section has a `[+]` to create a session inside that project.
4. **+ New project** row at the bottom — opens the directory picker.

Selection vs activity:

- **Selected session** = the row whose tab is open in the chat pane → background fill.
- **Active session** = `is_active = true` (running) → blue dot `●`. Multiple sessions can be active at once; selection is orthogonal.

## 6. Projects page (see wireframe Scene 2)

Opened from the `[▢] Projects` workspace-nav row. Internal tab, not a new route.

- Header: title + `Sort by Last updated ⌄` + `New project` button.
- Search field below header.
- Grid of cards: name + `Updated N ago` + folder-missing dot.
- Card click → focuses the project (scrolls its sidebar section into view; no separate route).
- Card hover → `⋮` menu: Rename · Change icon · Reveal in Finder · Delete.
- `New project` → directory picker → record insert → card appears.

## 7. Behavior

### 7.1 Cwd resolution (load-bearing)

When the renderer starts a session run, the runtime needs to resolve the cwd:

| `project_id` | cwd resolution |
|---|---|
| `NULL` (General) | user's `$HOME` directory |
| `X` | `projects[X].project_path` |

General sessions are no longer pinned to the workspace path — they run from the user's home so a General chat can help with anything on the machine. Project chats keep their explicit per-project directory. If the project's path is missing (e.g. deleted between scheduling and execution), the run still proceeds with HOME as the fallback.

### 7.2 Creating a session

| Trigger | `project_id` of new session |
|---|---|
| Top-of-sidebar `[+] New chat` | `NULL` (General) |
| `[+]` next to a project section header | that project |
| `[+]` next to General | `NULL` |
| Composer prefill / NewTaskDialog (existing) | inherits from currently-selected session, falling back to General |

### 7.3 Moving a session

- **Right-click → "Move to project ▸"** submenu lists every project + General. Mirrors the existing Pinned `Move to group` pattern in `Sidebar.tsx:511-538`.
- **Drag a session row onto another section header** reassigns `project_id`. Mirrors the existing Pinned drag pattern in `Sidebar.tsx:2186-2208`.
- A move never changes `session_id`. The chat content, history, and `parent_session_id` chain are unchanged. The only side effect is that subsequent runs use the new cwd.

### 7.4 Project deletion

When a project is deleted (from card menu or sidebar):

- Sessions with `project_id = X` get `project_id` set to `NULL` (cascade via `ON DELETE SET NULL`). They appear in General afterwards.
- Open chat tabs for those sessions stay open and keep working — they just resolve cwd to the workspace path on the next run.
- Confirmation dialog mirrors workspace delete: `Delete project 'X'? Sessions move to General. The folder on disk is untouched.`

### 7.5 Folder-missing state

Identical to workspace: amber dot on the section header, amber dot on the Projects-page card. Runs fail with the existing error. User repairs by reveal-in-Finder + restore, or by editing `project_path` (project rename flow already covers this — TBD whether path is editable post-creation; see Open Questions).

## 8. Data model & IPC

### 8.1 New table

```sql
CREATE TABLE workspace_projects (
  workspace_id TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  project_path TEXT NOT NULL,
  icon         TEXT,
  icon_color   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, project_id)
);
CREATE INDEX idx_workspace_projects_workspace ON workspace_projects(workspace_id);
```

`folder_state` is derived at read time from `fs.pathExists(project_path)`, matching how the workspace switcher already does it.

### 8.2 Migration

Add one migration to `runtime/state-store/src/store.ts`:

1. `CREATE TABLE workspace_projects …`
2. `ALTER TABLE agent_sessions ADD COLUMN project_id TEXT NULL`

No backfill — every existing session has `project_id = NULL` (General), which is the desired default.

### 8.3 IPC surface (renderer-side names)

Intermediate phase ships everything **except** `moveSession`:

```ts
window.electronAPI.workspace.listProjects(workspaceId): Promise<ProjectRecord[]>
window.electronAPI.workspace.createProject({ workspaceId, name, projectPath, icon?, iconColor? })
window.electronAPI.workspace.renameProject({ workspaceId, projectId, name })
window.electronAPI.workspace.updateProjectAppearance({ workspaceId, projectId, icon, iconColor })
window.electronAPI.workspace.deleteProject({ workspaceId, projectId })

// Session creation gains an optional projectId argument (default = null = General).
// `project_id` is set at create time and is immutable in intermediate phase.
// listMainSessions response gains `project_id` field per row.

// LATER (sidebar-IA phase):
// window.electronAPI.workspace.moveSession({ workspaceId, sessionId, projectId: string | null })
```

### 8.4 Renderer atoms (new)

```ts
projectsAtom                  // ProjectRecord[] for the active workspace
collapsedProjectSectionsAtom  // string[] (project_id) – persisted in app state
selectedSessionIdAtom         // mirrors what ChatPane already holds in a ref
                              // — promoted to an atom so the sidebar can subscribe
```

The existing `activeSessionIdRef` inside `ChatPane` becomes `selectedSessionIdAtom`. Active (running) state is read from each session's `is_active` field, not from a separate atom.

## 9. Migration / rollout

- **Schema** ships first; no UI changes yet. Existing sessions are all General by default — zero behavior change.
- **Projects page + sidebar list** ships behind a feature flag (`SIDEBAR_SESSIONS_V2` or equivalent), gated for internal dogfooding.
- **MainSessionPicker** keeps working in parallel until the sidebar list is the default; then it's removed.
- No data migration is needed because the default state is the correct state.

## 10. Open questions

Intermediate-phase scoping resolved questions 1, 2 (deferred), 3 (deferred), 5, 6 (deferred), and the project-specific lifecycle questions. Remaining items for the **later sidebar-IA phase**:

1. **Multi-active confirmation.** Is `●` strictly `is_active = true` (running), independent of which row is selected? Wireframe shows two `●` rows in the same section, which only makes sense if so.
2. **Scheduled section filter.** Is "Scheduled" defined as `cronjob_id IS NOT NULL`, `workflow_trigger_kind IN ('cron', 'manual')`, or some other predicate? Affects whether the "Manual" chip in the wireframe is a cronjob with a manual trigger or a different category.
3. **Project ordering in the sidebar.** Default `updated_at DESC` matches the Projects page; should the user be able to drag-reorder, or is it strictly recency-based?
4. **Project section count cap.** If a workspace has 20+ projects, does the sidebar render them all expanded by default, or does it collapse all but the most-recently-used N?
5. **Cascade vs. orphan on workspace delete.** Today workspace delete is destructive. Do projects (and their session associations) get the same treatment, or do we ask first?
6. **`[⇅]` sort control in original wireframe.** Deferred — leaving here for future iteration.

**Resolved during scoping:**

- Movable sessions → not in intermediate; revisit when the sidebar IA ships.
- Project outputs storage → own folder under `project_path`.
- Recents → removed from the sidebar entirely.
- Favorites → workspace-keyed, unchanged.
- Projects nav entry → ships in intermediate via `[▢] Projects` row.
- Project deletion → sessions become General; open tabs auto-relabel.
- `project_path` mutability → immutable, matching workspace.
- Same-directory projects → allowed.
- Backfill → none.
- Workspace creation UI → removed (`Publish to Store` and `Create new workspace` actions deleted from the switcher popover).

## 11. Acceptance criteria (for the eventual implementation PR)

- Creating a session from the top-of-sidebar `[+]` button writes a row with `project_id IS NULL` and the agent run uses the workspace path as cwd.
- Creating a project via the Projects page writes a `workspace_projects` row and an empty section appears in the sidebar within one re-render.
- Moving a session via the right-click menu OR drag onto a section header updates `project_id` and the next run uses the new cwd.
- Deleting a project moves its sessions to General (no orphans, no FK errors) and surfaces a confirmation that describes the move.
- A session marked `is_active = true` shows `●` regardless of whether its row is the selected one.
- Closing and reopening the app preserves: project list, collapsed/expanded state per section, and the selected session.

## 12. Out of scope (tracked for future)

- Per-section sort UI (`⌄` only for now).
- Drag-reordering projects.
- Multi-workspace session views.
- Project-level settings (env vars, custom skills, …) — could land later once the section IA settles.
- "Focused project" mode that filters the sidebar to one project at a time.
