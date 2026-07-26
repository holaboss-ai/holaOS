import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import Database from "better-sqlite3";

import { RuntimeStateStore } from "./index.js";

// Workspace-removal: the store no longer auto-creates the `workspaces` registry
// table (single-tenant synthetic root). `createWorkspace` still writes the legacy
// registry row, so tests that register a workspace must pre-create the table in
// the control-plane db (and the mirrored host-state db). Mirrors the fixture
// helper in store.test.ts. Full column set = the schema the store writes.
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

function makeStore(): { store: RuntimeStateStore; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-channel-conn-"));
  const dbPath = path.join(root, "runtime.db");
  seedWorkspacesRegistry(dbPath);
  const store = new RuntimeStateStore({
    dbPath,
    workspaceRoot: path.join(root, "workspace"),
  });
  insertWorkspaceRow(store, "w1", "Test");
  return { store, cleanup: () => { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("channel connection round-trips with parsed allowFrom + flags", () => {
  const { store, cleanup } = makeStore();
  try {
    const created = store.upsertChannelConnection({
      workspaceId: "w1",
      platform: "telegram",
      token: "123:abc",
      botUsername: "mybot",
      allowFrom: ["@alice", "42"],
      requireMention: true,
      status: "connected",
    });
    assert.ok(created.connectionId);
    assert.equal(created.platform, "telegram");
    assert.equal(created.token, "123:abc");
    assert.equal(created.botUsername, "mybot");
    assert.deepEqual(created.allowFrom, ["@alice", "42"]);
    assert.equal(created.requireMention, true);
    assert.equal(created.enabled, true);
    assert.equal(created.status, "connected");

    const fetched = store.getChannelConnection({ workspaceId: "w1", connectionId: created.connectionId });
    assert.deepEqual(fetched, created);
  } finally {
    cleanup();
  }
});

test("partial upsert preserves unspecified fields; status update keeps token", () => {
  const { store, cleanup } = makeStore();
  try {
    const created = store.upsertChannelConnection({
      workspaceId: "w1",
      platform: "telegram",
      token: "tok",
      allowFrom: ["@a"],
    });
    const updated = store.setChannelConnectionStatus({
      workspaceId: "w1",
      connectionId: created.connectionId,
      status: "error",
      statusDetail: "bad token",
    });
    assert.equal(updated!.status, "error");
    assert.equal(updated!.statusDetail, "bad token");
    assert.equal(updated!.token, "tok", "token preserved across status update");
    assert.deepEqual(updated!.allowFrom, ["@a"], "allowlist preserved");
    assert.equal(updated!.createdAt, created.createdAt, "createdAt preserved");
  } finally {
    cleanup();
  }
});

test("list (enabledOnly) and delete", () => {
  const { store, cleanup } = makeStore();
  try {
    const a = store.upsertChannelConnection({ workspaceId: "w1", platform: "telegram", token: "t1" });
    store.upsertChannelConnection({ workspaceId: "w1", platform: "telegram", token: "t2", enabled: false });
    assert.equal(store.listChannelConnections({ workspaceId: "w1" }).length, 2);
    assert.equal(store.listChannelConnections({ workspaceId: "w1", enabledOnly: true }).length, 1);
    assert.equal(store.deleteChannelConnection({ workspaceId: "w1", connectionId: a.connectionId }), true);
    assert.equal(store.listChannelConnections({ workspaceId: "w1" }).length, 1);
  } finally {
    cleanup();
  }
});
