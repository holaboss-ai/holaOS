import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { RuntimeStateStore } from "./store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// Workspace-removal: the store no longer auto-creates the `workspaces` registry
// table (single-tenant synthetic root). `createWorkspace` still writes the legacy
// registry row, so tests that register a workspace must pre-create the table in
// the control-plane db (and the mirrored host-state db). Full column set = the
// schema the store writes.
const WORKSPACES_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      harness TEXT,
      error_message TEXT,
      onboarding_status TEXT NOT NULL,
      onboarding_state TEXT,
      onboarding_session_id TEXT,
      onboarding_alignment_question TEXT,
      onboarding_alignment_report TEXT,
      onboarding_verification_report TEXT,
      onboarding_completed_at TEXT,
      onboarding_completion_summary TEXT,
      onboarding_requested_at TEXT,
      onboarding_requested_by TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at_utc TEXT,
      icon TEXT,
      icon_color TEXT,
      workspace_role TEXT NOT NULL DEFAULT 'source',
      source_workspace_id TEXT,
      lab_purpose TEXT,
      lab_status TEXT
  );
`;

function seedWorkspacesRegistry(dbPath: string): void {
  const controlPlaneDbPath = path.join(path.dirname(dbPath), "control-plane.db");
  for (const file of new Set([controlPlaneDbPath, dbPath])) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    try {
      db.exec(WORKSPACES_TABLE_DDL);
    } finally {
      db.close();
    }
  }
}

// Workspace-removal: createWorkspace was deleted. Replicate the registry row it
// wrote (mirrored into the control-plane db and the host-state monolith) plus the
// on-disk folder, so a workspace stays "registered" as test setup. The table is
// pre-created by seedWorkspacesRegistry.
function insertWorkspaceRow(store: RuntimeStateStore, workspaceId: string, name: string): void {
  const workspacePath = path.join(store.workspaceRoot, workspaceId);
  fs.mkdirSync(workspacePath, { recursive: true });
  const now = "2026-01-01T00:00:00.000Z";
  for (const file of new Set([store.controlPlaneDbPath, store.dbPath])) {
    const db = new Database(file);
    try {
      db.prepare(
        `INSERT OR IGNORE INTO workspaces (
            id, workspace_path, name, status, harness, onboarding_status,
            created_at, updated_at, workspace_role
         ) VALUES (?, ?, ?, 'active', 'pi', 'not_required', ?, ?, 'source')`,
      ).run(workspaceId, workspacePath, name, now, now);
    } finally {
      db.close();
    }
  }
}

function makeStore(): { store: RuntimeStateStore; workspaceId: string } {
  const root = makeTempDir("hb-capabilities-store-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");
  seedWorkspacesRegistry(dbPath);
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  const workspaceId = "workspace-1";
  insertWorkspaceRow(store, workspaceId, "Acme");
  return { store, workspaceId };
}

test("workspace capability create/get/list/setStatus/delete round trip", () => {
  const { store, workspaceId } = makeStore();

  const first = store.createWorkspaceCapability({
    workspaceId,
    capabilityId: "competitor-watch",
    version: "0.1.0",
    name: "Competitor Watch",
    description: "Weekly competitor analysis",
    icon: "📊",
    installedSkillIds: ["competitor-analysis", "market-research"],
    integrationStatus: { slack: "connected", notion: "needs_connection" },
    config: { cadence: "weekly", limit: 5, nested: { ok: true } },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  assert.equal(first.workspaceId, workspaceId);
  assert.equal(first.capabilityId, "competitor-watch");
  assert.equal(first.status, "active");
  assert.equal(first.version, "0.1.0");

  const fetched = store.getWorkspaceCapability({
    workspaceId,
    capabilityId: "competitor-watch",
  });
  assert.ok(fetched);
  assert.deepEqual(fetched.installedSkillIds, [
    "competitor-analysis",
    "market-research",
  ]);
  assert.deepEqual(fetched.integrationStatus, {
    slack: "connected",
    notion: "needs_connection",
  });
  assert.deepEqual(fetched.config, {
    cadence: "weekly",
    limit: 5,
    nested: { ok: true },
  });

  const second = store.createWorkspaceCapability({
    workspaceId,
    capabilityId: "brand-voice",
    name: "Brand Voice",
    createdAt: "2026-02-02T00:00:00.000Z",
    updatedAt: "2026-02-02T00:00:00.000Z",
  });
  assert.deepEqual(second.installedSkillIds, []);
  assert.deepEqual(second.integrationStatus, {});
  assert.deepEqual(second.config, {});

  const listed = store.listWorkspaceCapabilities({ workspaceId });
  assert.deepEqual(
    listed.map((record) => record.capabilityId),
    ["brand-voice", "competitor-watch"],
  );

  const disabled = store.setWorkspaceCapabilityStatus({
    workspaceId,
    capabilityId: "competitor-watch",
    status: "disabled",
  });
  assert.ok(disabled);
  assert.equal(disabled.status, "disabled");
  assert.equal(
    store.getWorkspaceCapability({ workspaceId, capabilityId: "competitor-watch" })
      ?.status,
    "disabled",
  );

  assert.equal(
    store.deleteWorkspaceCapability({ workspaceId, capabilityId: "competitor-watch" }),
    true,
  );
  assert.equal(
    store.getWorkspaceCapability({ workspaceId, capabilityId: "competitor-watch" }),
    null,
  );
  assert.deepEqual(
    store.listWorkspaceCapabilities({ workspaceId }).map((record) => record.capabilityId),
    ["brand-voice"],
  );
});

test("createWorkspaceCapability is idempotent and preserves createdAt on replace", () => {
  const { store, workspaceId } = makeStore();

  const created = store.createWorkspaceCapability({
    workspaceId,
    capabilityId: "competitor-watch",
    name: "Competitor Watch",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    config: { cadence: "weekly" },
  });
  assert.equal(created.createdAt, "2026-01-01T00:00:00.000Z");

  const replaced = store.createWorkspaceCapability({
    workspaceId,
    capabilityId: "competitor-watch",
    name: "Competitor Watch v2",
    updatedAt: "2026-02-02T00:00:00.000Z",
    config: { cadence: "daily" },
  });

  assert.equal(replaced.name, "Competitor Watch v2");
  assert.equal(replaced.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(replaced.updatedAt, "2026-02-02T00:00:00.000Z");
  assert.deepEqual(replaced.config, { cadence: "daily" });

  const listed = store.listWorkspaceCapabilities({ workspaceId });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].capabilityId, "competitor-watch");
});

test("setWorkspaceCapabilityStatus returns null for unknown capability", () => {
  const { store, workspaceId } = makeStore();
  assert.equal(
    store.setWorkspaceCapabilityStatus({
      workspaceId,
      capabilityId: "missing",
      status: "disabled",
    }),
    null,
  );
  assert.equal(
    store.deleteWorkspaceCapability({ workspaceId, capabilityId: "missing" }),
    false,
  );
});
