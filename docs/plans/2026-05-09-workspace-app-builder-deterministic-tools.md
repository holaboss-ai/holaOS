---
title: Workspace app builder deterministic tool surface
date: 2026-05-09
status: draft
related:
  - 2026-05-09-universal-block-package-architecture.md
  - 2026-04-09-desktop-install-app-design.md
  - 2026-03-31-composio-app-runtime-design.md
---

# Workspace app builder deterministic tool surface

## 0. Status & decision summary

This document proposes a deterministic tool layer for holaOS app-building agents.

The goal is not to replace vibe coding. The goal is to remove platform-critical guesswork from vibe coding.

### Decision in this draft

- keep app-specific UI, workflows, and domain logic model-driven
- extract workspace-contract operations into deterministic tools
- make the agent build **workspace apps**, not generic software projects
- optimize the first tool set around:
  - app scaffolding
  - registration
  - lifecycle control
  - readiness verification
  - workspace data inspection

---

## 1. Why this exists

holaOS app generation is not the same problem as generic app generation.

A generic app generator can stop at:

- files written
- dev server runs
- browser preview renders

A holaOS app builder cannot.

Success in holaOS means:

- the app is registered in the workspace
- the runtime recognizes it
- the managed app process starts successfully
- the app reports `ready: true`
- the app participates correctly in workspace data, MCP, integrations, and outputs when needed

That difference matters because the model is currently being asked to improvise platform glue that should be deterministic.

Examples of failure that come from leaving too much in freeform generation:

- app files are written but `workspace.yaml` is not updated
- the app works in a standalone preview but never becomes a managed workspace app
- the app code is modified but the running managed process is never restarted, so stale code is still served
- the agent invents a second integration instead of reusing existing installed-app data
- the agent guesses at shared DB usage instead of following the workspace contract

These are not creative failures. They are contract failures.

They are therefore good candidates for deterministic tools.

---

## 2. Design principle

The correct split is:

- **deterministic outside**
- **flexible inside**

Deterministic tools should own:

- workspace registration
- managed lifecycle control
- status and readiness checks
- shared data inspection
- integration declaration validation
- output publishing helpers

The model should still own:

- app concept and product shape
- page and UI design
- workflow and interaction design
- domain-specific business logic
- custom analytics logic
- code inside the app once the platform contract is satisfied

This preserves the creative strength of the model while reducing repeated platform mistakes.

---

## 3. Extraction criteria

Extract a behavior into a deterministic tool when it is:

1. Repetitive across most apps
2. Easy to do almost-right but costly to get wrong
3. Low in creative value
4. High in platform coupling
5. Easy to describe with a clear input/output contract

Do **not** extract a behavior into a deterministic tool when it is mainly:

- product design
- presentation design
- domain reasoning
- app-specific logic
- one-off composition

---

## 4. What should become tools

### 4.1 Workspace contract tools

These are the highest-value first tools.

| Tool | Purpose | Why it should be deterministic |
|---|---|---|
| `workspace.apps.scaffold` | Create the minimum valid holaOS app skeleton in `apps/<app_id>/` | Prevents the agent from reinventing file layout and boilerplate |
| `workspace.apps.register` | Add or update the app entry in `workspace.yaml` | Registration is mandatory and easy to forget |
| `workspace.apps.validate_manifest` | Validate `app.runtime.yaml` shape and key contract fields | Prevents invalid manifest drift |
| `workspace.apps.get_status` | Return install/build/run/ready status for one app | Lets the agent reason from system truth instead of assumptions |

### 4.2 Lifecycle tools

These remove the most expensive runtime mismatch errors.

| Tool | Purpose | Why it should be deterministic |
|---|---|---|
| `workspace.apps.ensure_running` | Ask the runtime to start all or selected workspace apps | Already exists conceptually in the runtime; should be first-class for agents |
| `workspace.apps.stop` | Stop a managed app | Needed before reliable restart in some flows |
| `workspace.apps.restart` | Restart a managed app | Critical when the agent edits an already-running app |
| `workspace.apps.wait_until_ready` | Poll until `ready: true` or return a structured failure | Turns vague “seems healthy” into a hard contract |
| `workspace.apps.get_ports` | Return runtime-managed HTTP and MCP ports | Lets the agent verify the managed app surface, not a preview port |

### 4.3 Workspace data inspection tools

These are the next highest-value tools after lifecycle.

| Tool | Purpose | Why it should be deterministic |
|---|---|---|
| `workspace_data.list_tables` | List available shared tables in the workspace DB | Helps the agent discover existing sources of truth |
| `workspace_data.describe_table` | Return columns and types for a table | Removes guessing about schema |
| `workspace_data.sample_rows` | Return a small sample from a table | Helps the agent shape queries and UI correctly |
| `workspace_data.table_exists` | Verify a specific table is present | Important for installed-app dependencies |

### 4.4 Integration and outputs tools

These are useful, but slightly later than lifecycle and data inspection.

| Tool | Purpose | Why it should be deterministic |
|---|---|---|
| `workspace.apps.validate_integrations` | Check `integrations:` declarations against allowed manifest rules | Avoids malformed integration wiring |
| `workspace.outputs.create` | Publish a durable workspace output | Useful when the app must emit durable artifacts |
| `workspace.outputs.update` | Patch output state | Keeps output publication aligned with platform conventions |

### 4.5 Optional import helpers

These are useful if file-based dashboards and trackers become common.

| Tool | Purpose | Why it should be deterministic |
|---|---|---|
| `workspace.files.inspect_tabular_file` | Infer columns and basic structure for CSV/TSV | Avoids repeated parser guesswork |
| `workspace_data.import_tabular_file` | Import a local file into app-owned tables with a declared prefix | Useful when the app needs durable imported data |

---

## 5. Recommended v1 tool surface

If we only build a small first set, it should be:

1. `workspace.apps.scaffold`
2. `workspace.apps.register`
3. `workspace.apps.ensure_running`
4. `workspace.apps.restart`
5. `workspace.apps.wait_until_ready`
6. `workspace.apps.get_status`
7. `workspace.apps.get_ports`
8. `workspace_data.list_tables`
9. `workspace_data.describe_table`
10. `workspace_data.sample_rows`

This is the smallest set that removes the most painful contract failures while leaving product/UI generation flexible.

---

## 6. What should stay model-driven

The following should **not** become deterministic tools in v1:

- “design me a dashboard layout”
- “turn this into a clean KPI page”
- “build a better CSV visualizer”
- “choose the right workflow for team progress tracking”
- “write the analytics logic that matters for this domain”
- “decide whether this should be a tracker, dashboard, or hybrid tool”

These are exactly the places where the model adds value.

The tool layer should support that reasoning, not replace it.

---

## 7. Deterministic tool behavior rules

These tools should be workspace-grounded by default.

### 7.1 Scope rules

- Every tool must execute against the selected workspace.
- Tools must not silently operate against a different workspace root.
- Tools must return structured workspace ids and app ids in their result payloads.

### 7.2 Truth rules

- Status tools must report runtime truth, not inferred truth.
- Readiness must come from the managed runtime status, not from a browser preview.
- Data inspection must read the shared workspace DB, not app-local guesses.

### 7.3 Failure rules

- Fail loudly when the app is unregistered
- Fail loudly when the runtime cannot start the app
- Fail loudly when required tables are missing
- Do not silently “best-effort” platform-critical operations

### 7.4 Idempotency rules

Where reasonable:

- `scaffold` should be able to detect existing files and either refuse or update in a structured way
- `register` should be idempotent
- `ensure_running` should be safe to call repeatedly
- `wait_until_ready` should return the latest known structured status on timeout

---

## 8. Example agent split

### 8.1 What the model decides

User request:

> Build a dashboard for my Twitter posts using the installed Twitter app.

Model responsibilities:

- decide this should be a workspace app
- decide it should reuse installed Twitter data
- decide the first UI shape
- decide whether MCP tools are needed
- decide whether app-owned tables are needed for preferences or saved views

### 8.2 What deterministic tools do

Tool responsibilities:

1. `workspace_data.list_tables`
2. `workspace_data.describe_table("twitter_posts")`
3. `workspace.apps.scaffold("twitter-dashboard")`
4. model writes app-specific code
5. `workspace.apps.register("twitter-dashboard")`
6. `workspace.apps.ensure_running("twitter-dashboard")`
7. `workspace.apps.wait_until_ready("twitter-dashboard")`
8. `workspace.apps.get_ports("twitter-dashboard")`
9. model verifies the managed surface on the runtime-managed port

That is a much better split than asking the model to improvise every platform step itself.

---

## 9. Why this matters for reliability

This tool layer directly improves the app-building experience in three ways:

### 9.1 Fewer false-success completions

The agent can no longer stop at:

- files written
- preview works

It must verify:

- registered
- managed
- running
- ready

### 9.2 Better workspace grounding

The agent can reason from:

- actual installed apps
- actual workspace tables
- actual runtime app status

instead of from assumptions.

### 9.3 Less prompt burden

The skill no longer needs to teach every operational detail in prose.

The skill can focus on:

- decision rules
- when to use which tool
- what still requires model judgment

---

## 10. Suggested rollout order

### Phase 1

- `workspace.apps.scaffold`
- `workspace.apps.register`
- `workspace.apps.ensure_running`
- `workspace.apps.restart`
- `workspace.apps.wait_until_ready`
- `workspace.apps.get_status`
- `workspace.apps.get_ports`

### Phase 2

- `workspace_data.list_tables`
- `workspace_data.describe_table`
- `workspace_data.sample_rows`
- `workspace_data.table_exists`

### Phase 3

- `workspace.apps.validate_integrations`
- `workspace.outputs.create`
- `workspace.outputs.update`
- optional file import helpers

---

## 11. Recommendation

We should not treat holaOS app building as generic vibe coding.

We should treat it as:

- **model-driven app design**
- on top of
- **deterministic workspace operations**

The highest-value first extraction is:

- lifecycle
- registration
- readiness
- workspace data inspection

Everything else can remain flexible until the system proves where the next biggest reliability gaps are.

