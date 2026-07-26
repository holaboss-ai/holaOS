# Customize & Addons — Design (reconciled with codebase)

**Date:** 2026-06-20
**Status:** In implementation (worktree `feat/customize-addons`, base = `fix/drop-tools-invalid-schema-keys`)
**Owner repo:** holaOS (runtime + desktop). Python backend only proxies for the web product later.

## 1. What we're building

A **Customize** surface (desktop) that unifies **Skills**, **Integrations**, and a new
mid-weight bundle called an **Addon**. An Addon = *skill(s) + the integrations they need*,
installed into an existing workspace. Mirrors Claude Cowork's `Customize ⊃ Plugins ⊃
{Skills, Connectors}`, renamed so it doesn't collide with holaOS's existing "plugin".

## 2. Reconciliation with the real codebase (corrects earlier assumptions)

| Earlier assumption | Reality in holaOS | Consequence |
|---|---|---|
| No existing bundle concept | holaOS **"plugin"** already exists = a workflow/object/dashboard container from a `plugin-template` (`workspace_plugins` table, `RuntimeStateStore.*WorkspacePlugin*`). | "Addon" is genuinely new; **do not** build on plugins. Name "Addon" avoids the collision. |
| Skills live in a `workspace_skills` DB table with install/toggle API | Runtime skills are **file-based, disk-discovered**: `{workspaceDir}/skills/{id}/SKILL.md` resolved by `resolveWorkspaceSkills` in `runtime/harnesses/src/workspace-skills.ts`. No DB, no toggle API. Frontmatter uses `holaboss.granted_tools` / `granted_commands`. | "Install a skill" = **write the SKILL.md file**. "Toggle/uninstall" = our `workspace_addons` row + remove the dir. The Supabase `workspace_skills` table is a *backend/web* layer, not the runtime. |
| Integrations = module apps to materialize | Integrations are a **catalog + connection + binding** model (`integration-catalog.ts`, `IntegrationConnectionRecord`, `IntegrationBindingRecord`). Apps (`workspace-apps.ts`) are a *separate* spawned-MCP concept. | An Addon's "needs Slack" = check/declare an **integration binding/connection**, NOT spawn an app. Simplifies MVP — no app materialization in v1. |
| State in Supabase | Runtime state = **per-workspace SQLite** `runtime.db` via `RuntimeStateStore`; schema via numbered migrations in `runtime/state-store/src/migrations/` (next id = **018**). | `workspace_addons` is a SQLite migration + store methods. |
| Tests = pytest / vitest | `node:test` + `node:assert/strict`; run via `bun --filter=@holaboss/runtime-state-store run test` (and `…runtime-api-server…`). | TDD with node:test. |

## 3. Architecture (corrected, holaOS-centric)

```
Desktop Customize UI ──(oRPC remoteApi)──▶ Runtime API (Fastify, app.ts)
                                              │  /api/v1/addons*
                                              ▼
                                   workspace-addons.ts  (registry + orchestrator)
                                      ├─ loadAddonCatalog()         ← bundled manifests in repo
                                      ├─ installAddon(...)          ← writes SKILL.md, checks bindings
                                      ├─ uninstallAddon(...)        ← refcount-aware file removal
                                      └─ RuntimeStateStore addon methods (SQLite, migration 018)
```

- **Registry**: curated `addon.yaml` + bundled `skills/*/SKILL.md`, shipped in the repo and
  discovered by directory scan (mirrors `embedded-skills`). Location:
  `runtime/api-server/src/embedded-addons/<id>/`.
- **Install orchestration** lives in a new `workspace-addons.ts` runtime module. It composes
  existing primitives: write skill files into the workspace skills dir; resolve integration
  requirements against the integration catalog/bindings; record a `workspace_addons` row.
- **Persistence**: `workspace_addons` in the per-workspace `runtime.db`.

## 4. `addon.yaml` manifest

```yaml
id: competitor-watch
name: Competitor Watch
description: Weekly competitor analysis, posted to Slack
version: 0.1.0
category: research
icon: 📊
skills:
  - path: ./skills/competitor-analysis/SKILL.md   # inlined new content (the "hard skill" path)
  - ref: market-research                            # or reference an existing skill id
integrations:
  - provider: slack            # provider_id from the integration catalog
    required: true
    reason: Posts the weekly digest
agent_prompt: |   # optional; appended to AGENTS.md guidance
  When asked about competitors, run the competitor-analysis skill and post via slack_*.
```

## 5. Data model — `workspace_addons` (migration 018)

```
workspace_addons(
  workspace_id TEXT NOT NULL,
  addon_id     TEXT NOT NULL,
  version      TEXT,
  name         TEXT NOT NULL,
  description  TEXT,
  icon         TEXT,
  status       TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'disabled'
  installed_skill_ids TEXT,    -- JSON array: skills this addon wrote (for refcount/uninstall)
  integration_status  TEXT,    -- JSON: { [provider]: 'connected' | 'needs_connection' }
  config_json  TEXT,           -- JSON blob (settings)
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, addon_id)
)
```

Store methods (mirror `*WorkspacePlugin*`): `createWorkspaceAddon`, `getWorkspaceAddon`,
`listWorkspaceAddons`, `setWorkspaceAddonStatus`, `deleteWorkspaceAddon`,
private `rowToWorkspaceAddon`.

## 6. Acceptance criteria

### Layer A — state-store (foundation)
- **A1** Migration `018-workspace-addons.ts` creates the table + index, registered in
  `migrations/index.ts`. Applying migrations on a fresh db yields the table.
- **A2** `RuntimeStateStore` gains `createWorkspaceAddon` / `getWorkspaceAddon` /
  `listWorkspaceAddons` / `setWorkspaceAddonStatus` / `deleteWorkspaceAddon`, with
  `WorkspaceAddonRecord` + `WorkspaceAddonStatus` exported from the package index.
- **A3** Round-trip test passes: create → get → list (newest first) → setStatus('disabled') →
  delete → get returns null. JSON fields (`installed_skill_ids`, `integration_status`,
  `config`) survive serialization.
- **A4** `bun --filter=@holaboss/runtime-state-store run test` and `typecheck` are green.

### Layer B — registry + orchestrator (`workspace-addons.ts`)
- **B1** `loadAddonCatalog()` parses bundled `embedded-addons/*/addon.yaml` into validated
  `AddonDefinition[]`; malformed manifests are rejected with a clear error.
- **B2** `installAddon({store, workspaceId, workspaceDir, addonId})`: writes each inlined skill
  to `{workspaceDir}/skills/{skillId}/SKILL.md`; computes `integration_status` per required
  provider; records a `workspace_addons` row; returns the record. Idempotent re-install does
  not duplicate files or rows.
- **B3** `uninstallAddon(...)`: removes skill dirs **this addon created** unless another
  installed addon also lists that skill (refcount); deletes the row.
- **B4** `setAddonEnabled(...)` flips status without touching files.
- **B5** Unit tests cover B1–B4 against a temp workspace dir + temp store; all green.

### Layer C — runtime HTTP routes
- **C1** `GET /api/v1/addons` (catalog), `GET /api/v1/workspaces/:id/addons` (installed),
  `POST /api/v1/addons/install`, `/uninstall`, `/toggle` registered in `app.ts`, delegating to
  Layer B. **C2** A route-level test exercises install→list→toggle→uninstall. **C3** api-server
  `typecheck` + `test` green.

### Layer D — desktop Customize surface
- **D1** A `Customize` entry opens a panel with **Addons | Skills | Integrations** tabs and the
  three-card empty state (Connect apps / Create skills / Browse addons). **D2** Addon list +
  detail (reusing `MarketplaceGallery`/card components) showing inner skills + integration
  connect-state. **D3** Wired to the runtime via the oRPC `remoteApi` contract
  (`@/lib/remoteApiQuery`). **D4** Desktop `typecheck`/lint green; verified by running the app.

### Global
- **G** No regressions: existing `runtime:test` suites stay green. Design rules honored in UI
  (solid cards, subtle borders, no gradients/lift). Work committed on `feat/customize-addons`.

## 7. Build order (loop)

A → B → C → D, each verified green before the next. Layers A–C are pure runtime/TS and fully
unit-testable headless. Layer D requires running the desktop app to verify (per desktop CLAUDE.md,
source-snapshot tests don't cover data-flow).

## 8. Out of scope (MVP+1)

Addon authoring UI (the `+`), "Customize this Addon" agent task, git-packaged third-party
addons, app (MCP-process) bundling inside an addon, web frontend surface, Supabase mirroring.
