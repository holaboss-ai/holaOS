# Dynamic MCP Port Allocation Implementation Plan

> **Execution Note:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace hardcoded `13100 + index` MCP port allocation with persistent dynamic allocation via the existing state-store `allocateAppPort()` infrastructure.

**Architecture:** The state-store already has an `app_ports` SQLite table with UNIQUE constraint on port and (workspace_id, app_id) primary key. Port range is 38080-38979 (dynamic allocation gated by `HOLABOSS_EMBEDDED_RUNTIME=1` for desktop; static fallback 18080+i/13100+i for container deployments). Remote's `portsForWorkspaceApp` helper and `mergePreparedMcpServerPayloads` superseded the original local plan.

**Tech Stack:** TypeScript, Node.js, SQLite (better-sqlite3), node:test

---

### Task 1: Fix state-store port range

**Files:**
- Modify: `runtime/state-store/src/store.ts:1335-1352`
- Modify: `runtime/state-store/src/store.test.ts:517-533`

### Task 2: Bootstrap uses store for port allocation

**Files:**
- Modify: `runtime/api-server/src/resolved-app-bootstrap-shared.ts:14-15,223-230`

### Task 3: workspace-apps.ts supports store-based port lookup

**Files:**
- Modify: `runtime/api-server/src/workspace-apps.ts:6-7,76-81,254-264`

### Task 4: ts-runner merges bootstrap MCP servers instead of concatenating

**Files:**
- Modify: `runtime/api-server/src/ts-runner.ts:749-757`

### Task 5: app.ts /api/v1/apps/ports uses store

**Files:**
- Modify: `runtime/api-server/src/app.ts:64,1669-1691`
