import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import { RuntimeStateStore, utcNowIso } from "./store.js";

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

function workspaceRuntimeDbFile(workspaceRoot: string, workspaceId: string): string {
  return path.join(workspaceRoot, workspaceId, ".holaboss", "state", "runtime.db");
}

test("workspace registry round trip uses hidden identity file", () => {
  const root = makeTempDir("hb-state-store-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  const created = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Acme",
    harness: "pi",
    status: "active"
  });

  const identityPath = path.join(workspaceRoot, "workspace-1", ".holaboss", "state", "workspace_id");
  assert.equal(fs.readFileSync(identityPath, "utf-8").trim(), "workspace-1");
  assert.equal(created.id, "workspace-1");
  assert.deepEqual(store.getWorkspace("workspace-1"), created);
  assert.deepEqual(
    store.listWorkspaces().map((record) => record.id),
    ["workspace-1"]
  );

  const db = new Database(dbPath, { readonly: true });
  const tables = new Set<string>(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (row) => row.name
    )
  );
  const row = db.prepare<[string], { workspace_path: string }>("SELECT workspace_path FROM workspaces WHERE id = ?").get("workspace-1");
  db.close();

  assert.ok(row);
  assert.equal(tables.has("workspaces"), true);
  assert.equal(path.resolve(row.workspace_path), path.join(workspaceRoot, "workspace-1"));
  store.close();
});

test("workspace labs are hidden from normal workspace listing", () => {
  const root = makeTempDir("hb-state-store-lab-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const source = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Source",
    harness: "pi",
    status: "active"
  });
  const lab = store.createWorkspace({
    workspaceId: "lab-1",
    name: "Source Lab",
    harness: "pi",
    status: "active",
    workspaceRole: "draft_lab",
    sourceWorkspaceId: source.id,
    labPurpose: "workspace_onboarding",
    labStatus: "active"
  });

  assert.deepEqual(
    store.listWorkspaces().map((record) => record.id),
    [source.id]
  );
  assert.deepEqual(
    store.listWorkspaceLabs({ sourceWorkspaceId: source.id }).map((record) => record.id),
    [lab.id]
  );
  assert.equal(store.getActiveWorkspaceLab(source.id)?.id, lab.id);

  store.updateWorkspace(lab.id, { status: "archived", labStatus: "merged" });
  assert.equal(store.getActiveWorkspaceLab(source.id), null);
  assert.deepEqual(
    store.listWorkspaceLabs({ sourceWorkspaceId: source.id, activeOnly: true }),
    []
  );

  store.close();
});

test("control-plane metadata lives in control-plane.db while runtime.db keeps the mirrored workspace registry", () => {
  const root = makeTempDir("hb-state-store-");
  const dbPath = path.join(root, "runtime.db");
  const controlPlanePath = path.join(root, "control-plane.db");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Acme",
    harness: "pi",
    status: "active"
  });
  store.upsertRuntimeUserProfile({
    profileId: "default",
    name: "Jeffrey",
    nameSource: "manual"
  });
  store.upsertAppCatalogEntry({
    appId: "calendar",
    source: "marketplace",
    name: "Calendar",
    description: "Calendar app",
    icon: null,
    category: null,
    tags: ["productivity"],
    version: "1.0.0",
    archiveUrl: null,
    archivePath: null,
    target: "apps/calendar",
    cachedAt: "2026-05-06T00:00:00.000Z",
    providerId: null,
    credentialSource: null
  });
  store.close();

  const runtimeDb = new Database(dbPath, { readonly: true });
  const runtimeTables = new Set<string>(
    (runtimeDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (row) => row.name
    )
  );
  const runtimeWorkspace = runtimeDb
    .prepare<[string], { workspace_path: string }>("SELECT workspace_path FROM workspaces WHERE id = ? LIMIT 1")
    .get("workspace-1");
  runtimeDb.close();

  const controlPlaneDb = new Database(controlPlanePath, { readonly: true });
  const controlPlaneTables = new Set<string>(
    (controlPlaneDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (row) => row.name
    )
  );
  const profileRow = controlPlaneDb
    .prepare<[string], { name: string | null }>("SELECT name FROM runtime_user_profiles WHERE profile_id = ? LIMIT 1")
    .get("default");
  const appCatalogRow = controlPlaneDb
    .prepare<[string], { name: string }>("SELECT name FROM app_catalog WHERE app_id = ? LIMIT 1")
    .get("calendar");
  controlPlaneDb.close();

  assert.ok(runtimeWorkspace);
  assert.equal(runtimeTables.has("workspaces"), true);
  assert.equal(runtimeTables.has("runtime_user_profiles"), false);
  assert.equal(runtimeTables.has("app_catalog"), false);
  assert.equal(controlPlaneTables.has("workspaces"), true);
  assert.equal(controlPlaneTables.has("runtime_user_profiles"), true);
  assert.equal(controlPlaneTables.has("app_catalog"), true);
  assert.equal(profileRow?.name, "Jeffrey");
  assert.equal(appCatalogRow?.name, "Calendar");
});

test("opening the store migrates legacy runtime.db files into host-state.db by default", () => {
  const root = makeTempDir("hb-state-store-");
  const legacyPath = path.join(root, "state", "runtime.db");
  const hostStatePath = path.join(root, "state", "host-state.db");
  const workspaceRoot = path.join(root, "workspace");

  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  const legacyDb = new Database(legacyPath);
  legacyDb.exec("CREATE TABLE legacy_marker (value TEXT NOT NULL);");
  legacyDb.exec("INSERT INTO legacy_marker (value) VALUES ('migrated');");
  legacyDb.close();

  const store = new RuntimeStateStore({ workspaceRoot, sandboxRoot: root });
  store.listWorkspaces();
  store.close();

  assert.equal(fs.existsSync(hostStatePath), true);
  const migratedDb = new Database(hostStatePath, { readonly: true });
  const row = migratedDb
    .prepare<[], { value: string }>("SELECT value FROM legacy_marker LIMIT 1")
    .get();
  migratedDb.close();
  assert.equal(row?.value, "migrated");
});

test("control-plane memory vector backfill migrates legacy user-scoped vec rows", () => {
  const root = makeTempDir("hb-state-store-control-plane-vec-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");

  const legacyDb = new Database(dbPath);
  sqliteVec.load(legacyDb);
  legacyDb.exec(`
    CREATE TABLE memory_embedding_index (
      vec_rowid INTEGER PRIMARY KEY,
      memory_id TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL UNIQUE,
      workspace_id TEXT,
      scope_bucket TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      content_fingerprint TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      embedding_dim INTEGER NOT NULL,
      indexed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE memory_recall_vec USING vec0(
      vec_rowid INTEGER PRIMARY KEY,
      embedding float[1536],
      scope_bucket TEXT,
      workspace_id TEXT,
      memory_type TEXT
    );
  `);
  legacyDb
    .prepare(`
      INSERT INTO memory_embedding_index (
        vec_rowid,
        memory_id,
        path,
        workspace_id,
        scope_bucket,
        memory_type,
        content_fingerprint,
        embedding_model,
        embedding_dim,
        indexed_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      14,
      "user-preference:style",
      "preference/response-style.md",
      null,
      "preference",
      "preference",
      "b".repeat(64),
      "text-embedding-3-small",
      1536,
      "2026-05-06T00:00:00.000Z",
      "2026-05-06T00:00:00.000Z",
    );
  const embedding = new Float32Array(1536);
  embedding[1] = 1;
  legacyDb
    .prepare(`
      INSERT INTO memory_recall_vec (vec_rowid, embedding, scope_bucket, workspace_id, memory_type)
      VALUES (CAST(? AS INTEGER), ?, ?, ?, ?)
    `)
    .run(14, embedding, "preference", "", "preference");
  legacyDb.close();

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  assert.equal(store.supportsVectorIndex(), true);

  const results = store.searchUserMemoryRecallVectors({
    embedding,
    limit: 5,
  });

  assert.equal(results[0]?.memoryId, "user-preference:style");
  assert.equal(results[0]?.path, "preference/response-style.md");
  store.close();
});

test("control-plane memory vector backfill is idempotent when a prior retry already inserted the vec row", () => {
  const root = makeTempDir("hb-state-store-control-plane-vec-retry-");
  const dbPath = path.join(root, "runtime.db");
  const controlPlanePath = path.join(root, "control-plane.db");
  const workspaceRoot = path.join(root, "workspace");

  const embedding = new Float32Array(1536);
  embedding[1] = 1;

  const legacyDb = new Database(dbPath);
  sqliteVec.load(legacyDb);
  legacyDb.exec(`
    CREATE TABLE memory_embedding_index (
      vec_rowid INTEGER PRIMARY KEY,
      memory_id TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL UNIQUE,
      workspace_id TEXT,
      scope_bucket TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      content_fingerprint TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      embedding_dim INTEGER NOT NULL,
      indexed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE memory_recall_vec USING vec0(
      vec_rowid INTEGER PRIMARY KEY,
      embedding float[1536],
      scope_bucket TEXT,
      workspace_id TEXT,
      memory_type TEXT
    );
  `);
  legacyDb
    .prepare(`
      INSERT INTO memory_embedding_index (
        vec_rowid,
        memory_id,
        path,
        workspace_id,
        scope_bucket,
        memory_type,
        content_fingerprint,
        embedding_model,
        embedding_dim,
        indexed_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      14,
      "user-preference:style",
      "preference/response-style.md",
      null,
      "preference",
      "preference",
      "b".repeat(64),
      "text-embedding-3-small",
      1536,
      "2026-05-06T00:00:00.000Z",
      "2026-05-06T00:00:00.000Z",
    );
  legacyDb
    .prepare(`
      INSERT INTO memory_recall_vec (vec_rowid, embedding, scope_bucket, workspace_id, memory_type)
      VALUES (CAST(? AS INTEGER), ?, ?, ?, ?)
    `)
    .run(14, embedding, "preference", "", "preference");
  legacyDb.close();

  const controlPlaneDb = new Database(controlPlanePath);
  sqliteVec.load(controlPlaneDb);
  controlPlaneDb.exec(`
    CREATE TABLE memory_embedding_index (
      vec_rowid INTEGER PRIMARY KEY,
      memory_id TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL UNIQUE,
      workspace_id TEXT,
      scope_bucket TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      content_fingerprint TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      embedding_dim INTEGER NOT NULL,
      indexed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE memory_recall_vec USING vec0(
      vec_rowid INTEGER PRIMARY KEY,
      embedding float[1536],
      scope_bucket TEXT,
      workspace_id TEXT,
      memory_type TEXT
    );
  `);
  controlPlaneDb
    .prepare(`
      INSERT INTO memory_embedding_index (
        vec_rowid,
        memory_id,
        path,
        workspace_id,
        scope_bucket,
        memory_type,
        content_fingerprint,
        embedding_model,
        embedding_dim,
        indexed_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      14,
      "user-preference:style",
      "preference/response-style.md",
      null,
      "preference",
      "preference",
      "b".repeat(64),
      "text-embedding-3-small",
      1536,
      "2026-05-06T00:00:00.000Z",
      "2026-05-06T00:00:00.000Z",
    );
  controlPlaneDb
    .prepare(`
      INSERT INTO memory_recall_vec (vec_rowid, embedding, scope_bucket, workspace_id, memory_type)
      VALUES (CAST(? AS INTEGER), ?, ?, ?, ?)
    `)
    .run(14, embedding, "preference", "", "preference");
  controlPlaneDb.close();

  const store = new RuntimeStateStore({ dbPath, controlPlaneDbPath: controlPlanePath, workspaceRoot });
  store.listWorkspaces();
  store.close();

  const verifyDb = new Database(controlPlanePath, { readonly: true });
  sqliteVec.load(verifyDb);
  const countRow = verifyDb
    .prepare<[], { total: number }>("SELECT COUNT(*) AS total FROM memory_recall_vec WHERE vec_rowid = 14")
    .get();
  verifyDb.close();

  assert.equal(countRow?.total, 1);
});

test("createWorkspace honors explicit workspacePath and registers it", () => {
  const root = makeTempDir("hb-state-store-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");
  const customRoot = makeTempDir("hb-custom-ws-");
  const customPath = path.join(customRoot, "my-workspace");
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  const created = store.createWorkspace({
    workspaceId: "ws-custom",
    name: "Custom",
    harness: "pi",
    workspacePath: customPath
  });

  assert.equal(created.id, "ws-custom");
  assert.equal(fs.existsSync(customPath), true);
  const identityPath = path.join(customPath, ".holaboss", "state", "workspace_id");
  assert.equal(fs.readFileSync(identityPath, "utf-8").trim(), "ws-custom");
  assert.equal(path.resolve(store.workspaceDir("ws-custom")), path.resolve(customPath));
  // Default workspaceRoot was not touched.
  assert.equal(fs.existsSync(path.join(workspaceRoot, "ws-custom")), false);
  store.close();
});

test("createWorkspace rejects non-absolute workspacePath", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  assert.throws(
    () =>
      store.createWorkspace({
        workspaceId: "ws-rel",
        name: "Rel",
        harness: "pi",
        workspacePath: "relative/dir"
      }),
    /must be absolute/
  );
  store.close();
});

test("createWorkspace rejects workspacePath that is a non-empty directory", () => {
  const root = makeTempDir("hb-state-store-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");
  const customRoot = makeTempDir("hb-custom-ws-");
  const customPath = path.join(customRoot, "not-empty");
  fs.mkdirSync(customPath, { recursive: true });
  fs.writeFileSync(path.join(customPath, "leftover.txt"), "hello");
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  assert.throws(
    () =>
      store.createWorkspace({
        workspaceId: "ws-nonempty",
        name: "NE",
        harness: "pi",
        workspacePath: customPath
      }),
    /must be empty/
  );
  store.close();
});

test("createWorkspace rejects workspacePath that overlaps an existing workspace", () => {
  const root = makeTempDir("hb-state-store-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");
  const customRoot = makeTempDir("hb-custom-ws-");
  const parent = path.join(customRoot, "parent");
  const child = path.join(parent, "child");
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  store.createWorkspace({
    workspaceId: "ws-parent",
    name: "Parent",
    harness: "pi",
    workspacePath: parent
  });

  assert.throws(
    () =>
      store.createWorkspace({
        workspaceId: "ws-child",
        name: "Child",
        harness: "pi",
        workspacePath: child
      }),
    /overlaps/
  );
  store.close();
});

test("workspaceFolderState returns healthy when the folder exists", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  store.createWorkspace({ workspaceId: "ws-h", name: "H", harness: "pi" });
  assert.equal(store.workspaceFolderState("ws-h"), "healthy");
  store.close();
});

test("workspaceFolderState reports missing when a custom folder is deleted", () => {
  const root = makeTempDir("hb-state-store-");
  const customRoot = makeTempDir("hb-custom-ws-");
  const customPath = path.join(customRoot, "ws");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  store.createWorkspace({
    workspaceId: "ws-custom",
    name: "C",
    harness: "pi",
    workspacePath: customPath
  });
  assert.equal(store.workspaceFolderState("ws-custom"), "healthy");

  fs.rmSync(customPath, { recursive: true, force: true });

  assert.equal(store.workspaceFolderState("ws-custom"), "missing");
  // Registered path must NOT be rewritten to the managed default.
  assert.equal(path.resolve(store.workspaceDir("ws-custom")), path.resolve(customPath));
  store.close();
});

test("assertWorkspaceFolderHealthy throws a structured error when missing", () => {
  const root = makeTempDir("hb-state-store-");
  const customRoot = makeTempDir("hb-custom-ws-");
  const customPath = path.join(customRoot, "ws");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  store.createWorkspace({
    workspaceId: "ws-custom",
    name: "C",
    harness: "pi",
    workspacePath: customPath
  });
  fs.rmSync(customPath, { recursive: true, force: true });

  let caught: unknown;
  try {
    store.assertWorkspaceFolderHealthy("ws-custom");
  } catch (e) {
    caught = e;
  }
  const err = caught as Error & { code?: string; workspacePath?: string };
  assert.ok(err instanceof Error);
  assert.equal(err.code, "workspace_folder_missing");
  assert.equal(path.resolve(err.workspacePath ?? ""), path.resolve(customPath));
  store.close();
});

test("updateWorkspace throws a structured error and does not recreate a missing managed folder", () => {
  const root = makeTempDir("hb-state-store-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  store.createWorkspace({
    workspaceId: "ws-managed",
    name: "Managed",
    harness: "pi"
  });
  const workspaceDir = path.join(workspaceRoot, "ws-managed");
  fs.rmSync(workspaceDir, { recursive: true, force: true });

  let caught: unknown;
  try {
    store.updateWorkspace("ws-managed", {
      onboardingRequestedBy: "workspace_agent"
    });
  } catch (error) {
    caught = error;
  }

  const err = caught as Error & { code?: string; workspacePath?: string };
  assert.ok(err instanceof Error);
  assert.equal(err.code, "workspace_folder_missing");
  assert.equal(path.resolve(err.workspacePath ?? ""), path.resolve(workspaceDir));
  assert.equal(fs.existsSync(workspaceDir), false);
  assert.equal(store.getWorkspace("ws-managed")?.onboardingRequestedBy ?? null, null);
  store.close();
});

test("updateWorkspace clears a stale managed identity write lock before persisting identity", () => {
  const root = makeTempDir("hb-state-store-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  store.createWorkspace({
    workspaceId: "ws-managed",
    name: "Managed",
    harness: "pi"
  });
  const workspaceDir = path.join(workspaceRoot, "ws-managed");
  const stateDir = path.join(workspaceDir, ".holaboss", "state");
  const lockPath = path.join(stateDir, "workspace_id.lock");
  fs.writeFileSync(lockPath, "stale-lock\n", "utf-8");
  const staleAt = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, staleAt, staleAt);

  const updated = store.updateWorkspace("ws-managed", {
    onboardingRequestedBy: "workspace_agent"
  });

  assert.equal(updated.onboardingRequestedBy, "workspace_agent");
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(
    fs.readFileSync(path.join(stateDir, "workspace_id"), "utf-8").trim(),
    "ws-managed",
  );
  store.close();
});

test("deleteWorkspace still succeeds when a managed folder is already missing", () => {
  const root = makeTempDir("hb-state-store-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  store.createWorkspace({
    workspaceId: "ws-managed",
    name: "Managed",
    harness: "pi"
  });
  fs.rmSync(path.join(workspaceRoot, "ws-managed"), { recursive: true, force: true });

  const deleted = store.deleteWorkspace("ws-managed");

  assert.ok(deleted.deletedAtUtc);
  assert.equal(
    store.getWorkspace("ws-managed", { includeDeleted: true })?.deletedAtUtc,
    deleted.deletedAtUtc,
  );
  store.close();
});

test("createWorkspace rejects the managed workspace root as a custom path", () => {
  const root = makeTempDir("hb-state-store-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  assert.throws(
    () =>
      store.createWorkspace({
        workspaceId: "ws-root",
        name: "R",
        harness: "pi",
        workspacePath: workspaceRoot
      }),
    /cannot be the runtime's managed workspace root/
  );
  store.close();
});

test("createWorkspace rejects a parent of the managed workspace root as a custom path", () => {
  const root = makeTempDir("hb-state-store-");
  const workspaceRoot = path.join(root, "nested", "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  assert.throws(
    () =>
      store.createWorkspace({
        workspaceId: "ws-parent",
        name: "P",
        harness: "pi",
        workspacePath: path.join(root, "nested")
      }),
    /cannot contain the runtime's managed workspace root/
  );
  store.close();
});

test("createWorkspace allows reusing a soft-deleted workspace's former path", () => {
  const root = makeTempDir("hb-state-store-");
  const customRoot = makeTempDir("hb-custom-ws-");
  const customPath = path.join(customRoot, "shared-folder");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  store.createWorkspace({
    workspaceId: "ws-first",
    name: "First",
    harness: "pi",
    workspacePath: customPath
  });
  store.deleteWorkspace("ws-first");
  // Clean up the directory as the DELETE endpoint would (with keep_files=false).
  fs.rmSync(customPath, { recursive: true, force: true });

  // Same path should now be reusable for a fresh workspace — the prior
  // record is soft-deleted and its path claim is released.
  const reclaimed = store.createWorkspace({
    workspaceId: "ws-second",
    name: "Second",
    harness: "pi",
    workspacePath: customPath
  });
  assert.equal(reclaimed.id, "ws-second");
  assert.equal(path.resolve(store.workspaceDir("ws-second")), path.resolve(customPath));
  store.close();
});

test("createWorkspace revives a deleted workspace when the preserved folder still has its identity bundle", () => {
  const root = makeTempDir("hb-state-store-");
  const customRoot = makeTempDir("hb-custom-ws-");
  const customPath = path.join(customRoot, "revive-folder");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const created = store.createWorkspace({
    workspaceId: "ws-revive",
    name: "Revive Me",
    harness: "pi",
    workspacePath: customPath
  });
  fs.writeFileSync(path.join(customPath, "AGENTS.md"), "preserved\n");
  store.deleteWorkspace(created.id);

  const revived = store.createWorkspace({
    name: "Ignored New Name",
    harness: "pi",
    workspacePath: customPath
  });

  assert.equal(revived.id, created.id);
  assert.equal(revived.deletedAtUtc, null);
  assert.equal(revived.name, "Revive Me");
  assert.equal(path.resolve(store.workspaceDir(created.id)), path.resolve(customPath));
  assert.equal(fs.readFileSync(path.join(customPath, "AGENTS.md"), "utf8"), "preserved\n");
  store.close();
});

test("relocateWorkspace accepts an empty directory and re-registers", () => {
  const root = makeTempDir("hb-state-store-");
  const customRoot = makeTempDir("hb-custom-ws-");
  const newPath = path.join(customRoot, "new-home");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  store.createWorkspace({ workspaceId: "ws-r", name: "R", harness: "pi" });

  const updated = store.relocateWorkspace("ws-r", newPath);

  assert.equal(updated.id, "ws-r");
  assert.equal(path.resolve(store.workspaceDir("ws-r")), path.resolve(newPath));
  const identity = fs
    .readFileSync(path.join(newPath, ".holaboss", "state", "workspace_id"), "utf-8")
    .trim();
  assert.equal(identity, "ws-r");
  store.close();
});

test("relocateWorkspace accepts a directory that already has a matching identity file", () => {
  const root = makeTempDir("hb-state-store-");
  const customRoot = makeTempDir("hb-custom-ws-");
  const movedPath = path.join(customRoot, "moved");
  // Pre-seed the folder as if the user moved a workspace dir here.
  fs.mkdirSync(path.join(movedPath, ".holaboss", "state"), { recursive: true });
  fs.writeFileSync(path.join(movedPath, ".holaboss", "state", "workspace_id"), "ws-moved");
  fs.writeFileSync(path.join(movedPath, "AGENTS.md"), "preserved");

  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  store.createWorkspace({ workspaceId: "ws-moved", name: "M", harness: "pi" });

  store.relocateWorkspace("ws-moved", movedPath);

  // Pre-existing content is preserved (we don't wipe).
  assert.equal(fs.readFileSync(path.join(movedPath, "AGENTS.md"), "utf-8"), "preserved");
  assert.equal(path.resolve(store.workspaceDir("ws-moved")), path.resolve(movedPath));
  store.close();
});

test("relocateWorkspace still accepts a directory with the legacy identity file path", () => {
  const root = makeTempDir("hb-state-store-");
  const customRoot = makeTempDir("hb-custom-ws-");
  const movedPath = path.join(customRoot, "moved-legacy");
  fs.mkdirSync(path.join(movedPath, ".holaboss"), { recursive: true });
  fs.writeFileSync(path.join(movedPath, ".holaboss", "workspace_id"), "ws-moved");

  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  store.createWorkspace({ workspaceId: "ws-moved", name: "M", harness: "pi" });

  store.relocateWorkspace("ws-moved", movedPath);

  assert.equal(
    fs.readFileSync(path.join(movedPath, ".holaboss", "state", "workspace_id"), "utf-8").trim(),
    "ws-moved",
  );
  store.close();
});

test("relocateWorkspace rejects a non-empty directory without matching identity", () => {
  const root = makeTempDir("hb-state-store-");
  const customRoot = makeTempDir("hb-custom-ws-");
  const dirtyPath = path.join(customRoot, "dirty");
  fs.mkdirSync(dirtyPath, { recursive: true });
  fs.writeFileSync(path.join(dirtyPath, "someone-elses-file.txt"), "not mine");

  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  store.createWorkspace({ workspaceId: "ws-x", name: "X", harness: "pi" });

  assert.throws(
    () => store.relocateWorkspace("ws-x", dirtyPath),
    /must be empty/
  );
  store.close();
});

test("relocateWorkspace rejects a path that overlaps another workspace", () => {
  const root = makeTempDir("hb-state-store-");
  const customRoot = makeTempDir("hb-custom-ws-");
  const usedPath = path.join(customRoot, "used");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  store.createWorkspace({
    workspaceId: "ws-a",
    name: "A",
    harness: "pi",
    workspacePath: usedPath
  });
  store.createWorkspace({ workspaceId: "ws-b", name: "B", harness: "pi" });

  assert.throws(
    () => store.relocateWorkspace("ws-b", usedPath),
    /already registered/
  );
  store.close();
});

test("runtime schema migrates workspace rows to registry and identity file", () => {
  const root = makeTempDir("hb-state-store-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        harness TEXT,
        main_session_id TEXT,
        error_message TEXT,
        onboarding_status TEXT NOT NULL,
        onboarding_session_id TEXT,
        onboarding_completed_at TEXT,
        onboarding_completion_summary TEXT,
        onboarding_requested_at TEXT,
        onboarding_requested_by TEXT,
        created_at TEXT,
        updated_at TEXT,
        deleted_at_utc TEXT
    );
  `);
  db.prepare(`
    INSERT INTO workspaces (
        id, name, status, harness, main_session_id, error_message,
        onboarding_status, onboarding_session_id, onboarding_completed_at,
        onboarding_completion_summary, onboarding_requested_at, onboarding_requested_by,
        created_at, updated_at, deleted_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "workspace-legacy",
    "Legacy",
    "active",
    "pi",
    "session-1",
    null,
    "not_required",
    null,
    null,
    null,
    null,
    null,
    "2026-01-01T00:00:00+00:00",
    "2026-01-02T00:00:00+00:00",
    null
  );
  db.close();

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  const rows = store.listWorkspaces();

  assert.deepEqual(rows.map((record) => record.id), ["workspace-legacy"]);
  const identityPath = path.join(workspaceRoot, "workspace-legacy", ".holaboss", "state", "workspace_id");
  assert.equal(fs.readFileSync(identityPath, "utf-8").trim(), "workspace-legacy");

  const dbAfter = new Database(dbPath, { readonly: true });
  const tables = new Set<string>(
    (dbAfter.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (row) => row.name
    )
  );
  const row = dbAfter
    .prepare<[string], { workspace_path: string }>("SELECT workspace_path FROM workspaces WHERE id = ?")
    .get("workspace-legacy");
  dbAfter.close();

  assert.ok(row);
  assert.equal(tables.has("workspaces"), true);
  assert.equal(path.resolve(row.workspace_path), path.join(workspaceRoot, "workspace-legacy"));
  store.close();
});

test("legacy owner-table migration preserves explicit custom workspace_path", () => {
  const root = makeTempDir("hb-state-store-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");
  const customRoot = makeTempDir("hb-custom-ws-");
  const customPath = path.join(customRoot, "workspace-custom");
  fs.mkdirSync(customPath, { recursive: true });
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE workspaces_legacy_with_owner (
        id TEXT PRIMARY KEY,
        workspace_path TEXT,
        holaboss_user_id TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        harness TEXT,
        error_message TEXT,
        onboarding_status TEXT NOT NULL,
        onboarding_session_id TEXT,
        onboarding_completed_at TEXT,
        onboarding_completion_summary TEXT,
        onboarding_requested_at TEXT,
        onboarding_requested_by TEXT,
        created_at TEXT,
        updated_at TEXT,
        deleted_at_utc TEXT
    );

    CREATE INDEX idx_workspaces_user_updated
      ON workspaces_legacy_with_owner (holaboss_user_id, updated_at DESC);
  `);
  db.prepare(`
    INSERT INTO workspaces_legacy_with_owner (
        id, workspace_path, holaboss_user_id, name, status, harness, error_message,
        onboarding_status, onboarding_session_id, onboarding_completed_at,
        onboarding_completion_summary, onboarding_requested_at, onboarding_requested_by,
        created_at, updated_at, deleted_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "workspace-custom",
    customPath,
    "user-1",
    "Custom",
    "active",
    "pi",
    null,
    "not_required",
    null,
    null,
    null,
    null,
    null,
    "2026-01-01T00:00:00+00:00",
    "2026-01-02T00:00:00+00:00",
    null
  );
  db.close();

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  assert.equal(path.resolve(store.workspaceDir("workspace-custom")), path.resolve(customPath));
  const identityPath = path.join(customPath, ".holaboss", "state", "workspace_id");
  assert.equal(fs.readFileSync(identityPath, "utf-8").trim(), "workspace-custom");

  const dbAfter = new Database(dbPath, { readonly: true });
  const tables = new Set<string>(
    (dbAfter.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (row) => row.name
    )
  );
  const row = dbAfter
    .prepare<[string], { workspace_path: string }>("SELECT workspace_path FROM workspaces WHERE id = ?")
    .get("workspace-custom");
  dbAfter.close();

  assert.ok(row);
  assert.equal(tables.has("workspaces_legacy_with_owner"), false);
  assert.equal(path.resolve(row.workspace_path), path.resolve(customPath));
  store.close();
});

test("legacy owner-table migration falls back when workspace_path points at a stale managed folder", () => {
  const root = makeTempDir("hb-state-store-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");
  const originalPath = path.join(workspaceRoot, "workspace-stale");
  const renamedPath = path.join(workspaceRoot, "workspace-renamed");
  fs.mkdirSync(path.join(renamedPath, ".holaboss", "state"), { recursive: true });
  fs.writeFileSync(
    path.join(renamedPath, ".holaboss", "state", "workspace_id"),
    "workspace-stale\n",
    "utf-8",
  );
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE workspaces_legacy_with_owner (
        id TEXT PRIMARY KEY,
        workspace_path TEXT,
        holaboss_user_id TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        harness TEXT,
        error_message TEXT,
        onboarding_status TEXT NOT NULL,
        onboarding_session_id TEXT,
        onboarding_completed_at TEXT,
        onboarding_completion_summary TEXT,
        onboarding_requested_at TEXT,
        onboarding_requested_by TEXT,
        created_at TEXT,
        updated_at TEXT,
        deleted_at_utc TEXT
    );

    CREATE INDEX idx_workspaces_user_updated
      ON workspaces_legacy_with_owner (holaboss_user_id, updated_at DESC);
  `);
  db.prepare(`
    INSERT INTO workspaces_legacy_with_owner (
        id, workspace_path, holaboss_user_id, name, status, harness, error_message,
        onboarding_status, onboarding_session_id, onboarding_completed_at,
        onboarding_completion_summary, onboarding_requested_at, onboarding_requested_by,
        created_at, updated_at, deleted_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "workspace-stale",
    originalPath,
    "user-1",
    "Stale",
    "active",
    "pi",
    null,
    "not_required",
    null,
    null,
    null,
    null,
    null,
    "2026-01-01T00:00:00+00:00",
    "2026-01-02T00:00:00+00:00",
    null
  );
  db.close();

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  assert.equal(path.resolve(store.workspaceDir("workspace-stale")), path.resolve(renamedPath));
  assert.equal(fs.existsSync(originalPath), false);

  const dbAfter = new Database(dbPath, { readonly: true });
  const row = dbAfter
    .prepare<[string], { workspace_path: string }>("SELECT workspace_path FROM workspaces WHERE id = ?")
    .get("workspace-stale");
  dbAfter.close();

  assert.ok(row);
  assert.equal(path.resolve(row.workspace_path), path.resolve(renamedPath));
  store.close();
});

test("workspaceDir recovers when folder is renamed", () => {
  const root = makeTempDir("hb-state-store-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Acme",
    harness: "pi",
    status: "active"
  });
  const originalPath = path.join(workspaceRoot, "workspace-1");
  const renamedPath = path.join(workspaceRoot, "workspace-renamed");
  fs.renameSync(originalPath, renamedPath);

  const resolved = store.workspaceDir("workspace-1");

  assert.equal(resolved, renamedPath);
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare<[string], { workspace_path: string }>("SELECT workspace_path FROM workspaces WHERE id = ?").get("workspace-1");
  db.close();
  assert.ok(row);
  assert.equal(path.resolve(row.workspace_path), renamedPath);
  store.close();
});

test("getWorkspace recovers missing row from identity file", () => {
  const root = makeTempDir("hb-state-store-");
  const dbPath = path.join(root, "runtime.db");
  const controlPlanePath = path.join(root, "control-plane.db");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath,
    workspaceRoot,
    sandboxAgentHarness: "pi"
  });

  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Acme",
    harness: "pi",
    status: "active"
  });
  const controlPlaneDb = new Database(controlPlanePath);
  controlPlaneDb.prepare("DELETE FROM workspaces WHERE id = ?").run("workspace-1");
  controlPlaneDb.close();
  const runtimeDb = new Database(dbPath);
  runtimeDb.prepare("DELETE FROM workspaces WHERE id = ?").run("workspace-1");
  runtimeDb.close();

  const recovered = store.getWorkspace("workspace-1");

  assert.ok(recovered);
  assert.equal(recovered.id, "workspace-1");
  assert.equal(recovered.name, "workspace-1");
  assert.equal(recovered.harness, "pi");
  assert.equal(recovered.status, "active");

  const dbAfter = new Database(dbPath, { readonly: true });
  const row = dbAfter
    .prepare<[string], { id: string; workspace_path: string; harness: string; status: string }>(
      "SELECT id, workspace_path, harness, status FROM workspaces WHERE id = ?"
    )
    .get("workspace-1");
  dbAfter.close();

  assert.ok(row);
  assert.equal(row.id, "workspace-1");
  assert.equal(path.resolve(row.workspace_path), path.join(workspaceRoot, "workspace-1"));
  assert.equal(row.harness, "pi");
  assert.equal(row.status, "active");
  store.close();
});

test("binding round trip upserts and reloads persisted session binding", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const created = store.upsertBinding({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    harness: "pi",
    harnessSessionId: "harness-1"
  });
  const updated = store.upsertBinding({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    harness: "pi",
    harnessSessionId: "harness-2"
  });

  assert.equal(created.workspaceId, "workspace-1");
  assert.equal(updated.harnessSessionId, "harness-2");
  const session = store.getSession({ workspaceId: "workspace-1", sessionId: "session-main" });
  assert.ok(session);
  assert.equal(session.kind, "main_session");
  assert.equal(session.title, null);
  assert.equal(session.parentSessionId, null);
  assert.equal(session.sourceProposalId, null);
  assert.equal(session.createdBy, null);
  assert.equal(session.archivedAt, null);
  assert.deepEqual(
    store.getBinding({ workspaceId: "workspace-1", sessionId: "session-main" }),
    updated
  );
  store.close();
});

test("binding transfer reassigns an existing harness session to a different session in the same workspace", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  store.upsertBinding({
    workspaceId: "workspace-1",
    sessionId: "session-old",
    harness: "pi",
    harnessSessionId: "harness-shared"
  });
  const transferred = store.upsertBinding({
    workspaceId: "workspace-1",
    sessionId: "session-new",
    harness: "pi",
    harnessSessionId: "harness-shared"
  });

  assert.equal(transferred.sessionId, "session-new");
  assert.equal(transferred.harnessSessionId, "harness-shared");
  assert.equal(
    store.getBinding({ workspaceId: "workspace-1", sessionId: "session-old" }),
    null
  );
  assert.deepEqual(
    store.getBindingByHarnessSessionId({
      workspaceId: "workspace-1",
      harness: "pi",
      harnessSessionId: "harness-shared"
    }),
    transferred
  );
  store.close();
});

test("conversation bindings round trip across channels and session ownership", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const desktop = store.upsertConversationBinding({
    workspaceId: "workspace-1",
    channel: "desktop",
    conversationKey: "main_session",
    sessionId: "session-desktop-main",
    role: "main_session",
    metadata: { surface: "desktop" }
  });
  const telegram = store.upsertConversationBinding({
    workspaceId: "workspace-1",
    channel: "telegram",
    conversationKey: "chat-123",
    sessionId: "session-telegram-main",
    role: "main_session",
    metadata: { chat_id: "chat-123" }
  });
  const touched = store.touchConversationBinding({
    workspaceId: "workspace-1",
    bindingId: desktop.bindingId,
    lastActiveAt: "2026-04-24T12:00:00.000Z"
  });
  const inactive = store.setConversationBindingActive({
    workspaceId: "workspace-1",
    bindingId: telegram.bindingId,
    isActive: false
  });

  assert.ok(touched);
  assert.ok(inactive);
  assert.equal(desktop.role, "main_session");
  assert.equal(telegram.channel, "telegram");
  assert.equal(touched?.lastActiveAt, "2026-04-24T12:00:00.000Z");
  assert.equal(inactive?.isActive, false);
  assert.deepEqual(
    store.getConversationBindingByConversation({
      workspaceId: "workspace-1",
      channel: "desktop",
      conversationKey: "main_session",
      role: "main_session"
    }),
    touched
  );
  assert.deepEqual(
    store.getConversationBindingBySession({
      workspaceId: "workspace-1",
      sessionId: "session-telegram-main",
      role: "main_session"
    }),
    inactive
  );
  assert.deepEqual(
    store.listConversationBindings({ workspaceId: "workspace-1" }).map((record) => record.bindingId).sort(),
    [desktop.bindingId, telegram.bindingId].sort()
  );

  store.close();
});

test("subagent runs round trip and support waiting-user resume metadata", () => {
  const root = makeTempDir("hb-state-store-subagents-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const created = store.createSubagentRun({
    workspaceId: "workspace-1",
    parentSessionId: "session-main",
    parentInputId: "parent-input-1",
    originMainSessionId: "session-main",
    childSessionId: "session-subagent-1",
    initialChildInputId: "child-input-1",
    title: "Research competitors",
    goal: "Find recent proactive agent products",
    toolProfile: { tools: ["web"] },
    status: "running"
  });
  const updated = store.updateSubagentRun({
    workspaceId: "workspace-1",
    subagentId: created.subagentId,
    fields: {
      status: "waiting_on_user",
      currentChildInputId: "child-input-2",
      latestChildInputId: "child-input-2",
      blockingPayload: { question: "Which repo should I inspect?" },
      lastEventAt: "2026-04-24T12:10:00.000Z"
    }
  });

  assert.ok(updated);
  assert.equal(created.childSessionId, "session-subagent-1");
  assert.equal(updated?.status, "waiting_on_user");
  assert.equal(updated?.currentChildInputId, "child-input-2");
  assert.equal(updated?.latestChildInputId, "child-input-2");
  assert.deepEqual(updated?.blockingPayload, { question: "Which repo should I inspect?" });
  assert.deepEqual(
    store.getSubagentRunByChildSession({
      workspaceId: "workspace-1",
      childSessionId: "session-subagent-1"
    }),
    updated
  );
  assert.deepEqual(
    store.listSubagentRunsByOwner({ workspaceId: "workspace-1", ownerMainSessionId: "session-main" }).map(
      (record) => record.subagentId
    ),
    [created.subagentId]
  );
  assert.deepEqual(
    store.listWaitingSubagentRuns({ workspaceId: "workspace-1", ownerMainSessionId: "session-main" }).map(
      (record) => record.subagentId
    ),
    [created.subagentId]
  );
  assert.deepEqual(
    store.listIncompleteSubagentRuns({ workspaceId: "workspace-1" }).map((record) => record.subagentId),
    [created.subagentId]
  );

  store.close();
});

test("transferring subagent ownership also moves pending queued main-session events", () => {
  const root = makeTempDir("hb-state-store-subagents-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const run = store.createSubagentRun({
    workspaceId: "workspace-1",
    parentSessionId: "session-main-desktop",
    originMainSessionId: "session-main-desktop",
    childSessionId: "session-subagent-1",
    goal: "Debug the failing tests",
    status: "running"
  });
  const pending = store.enqueueMainSessionEvent({
    workspaceId: "workspace-1",
    ownerMainSessionId: "session-main-desktop",
    originMainSessionId: "session-main-desktop",
    subagentId: run.subagentId,
    eventType: "progress",
    deliveryBucket: "background_update",
    payload: { summary: "Tests reproduced locally." }
  });
  const delivered = store.enqueueMainSessionEvent({
    workspaceId: "workspace-1",
    ownerMainSessionId: "session-main-desktop",
    originMainSessionId: "session-main-desktop",
    subagentId: run.subagentId,
    eventType: "completed",
    deliveryBucket: "background_update",
    status: "delivered",
    deliveredAt: "2026-04-24T12:20:00.000Z",
    payload: { summary: "Fixed." }
  });

  const transferred = store.transferSubagentOwnership({
    workspaceId: "workspace-1",
    subagentId: run.subagentId,
    ownerMainSessionId: "session-main-telegram",
    ownerTransferredAt: "2026-04-24T12:21:00.000Z"
  });

  assert.ok(transferred);
  assert.equal(transferred?.ownerMainSessionId, "session-main-telegram");
  assert.equal(transferred?.ownerTransferredAt, "2026-04-24T12:21:00.000Z");
  assert.equal(store.getMainSessionEvent({ workspaceId: "workspace-1", eventId: pending.eventId })?.ownerMainSessionId, "session-main-telegram");
  assert.equal(store.getMainSessionEvent({ workspaceId: "workspace-1", eventId: delivered.eventId })?.ownerMainSessionId, "session-main-desktop");

  store.close();
});

test("main session event queue supports materialize deliver supersede lifecycle", () => {
  const root = makeTempDir("hb-state-store-events-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const first = store.enqueueMainSessionEvent({
    workspaceId: "workspace-1",
    ownerMainSessionId: "session-main",
    originMainSessionId: "session-main",
    eventType: "completed",
    deliveryBucket: "background_update",
    payload: { summary: "Research is done." }
  });
  const second = store.enqueueMainSessionEvent({
    workspaceId: "workspace-1",
    ownerMainSessionId: "session-main",
    originMainSessionId: "session-main",
    eventType: "waiting_on_user",
    deliveryBucket: "waiting_on_user",
    payload: { question: "Create a new GCP project?" }
  });

  const pending = store.listPendingMainSessionEvents({ workspaceId: "workspace-1", ownerMainSessionId: "session-main" });
  const materialized = store.markMainSessionEventsMaterialized({
    workspaceId: "workspace-1",
    eventIds: [first.eventId],
    materializedInputId: "main-input-1"
  });
  const delivered = store.markMainSessionEventsDelivered({
    workspaceId: "workspace-1",
    eventIds: [first.eventId],
    deliveredAt: "2026-04-24T12:30:00.000Z"
  });
  const superseded = store.markMainSessionEventsSuperseded({
    workspaceId: "workspace-1",
    eventIds: [second.eventId],
    supersededAt: "2026-04-24T12:31:00.000Z"
  });

  assert.equal(pending.length, 2);
  assert.equal(materialized[0]?.status, "materialized");
  assert.equal(materialized[0]?.materializedInputId, "main-input-1");
  assert.equal(delivered[0]?.status, "delivered");
  assert.equal(delivered[0]?.deliveredAt, "2026-04-24T12:30:00.000Z");
  assert.equal(superseded[0]?.status, "superseded");
  assert.equal(superseded[0]?.supersededAt, "2026-04-24T12:31:00.000Z");
  assert.equal(store.listPendingMainSessionEvents({ workspaceId: "workspace-1", ownerMainSessionId: "session-main" }).length, 0);

  store.close();
});

test("main session pending selectors exclude materialized events", () => {
  const root = makeTempDir("hb-state-store-pending-events-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const pending = store.enqueueMainSessionEvent({
    workspaceId: "workspace-1",
    ownerMainSessionId: "session-main",
    originMainSessionId: "session-main",
    eventType: "completed",
    deliveryBucket: "background_update",
    payload: { summary: "Pending follow-up." }
  });
  const materialized = store.enqueueMainSessionEvent({
    workspaceId: "workspace-1",
    ownerMainSessionId: "session-main",
    originMainSessionId: "session-main",
    eventType: "completed",
    deliveryBucket: "background_update",
    payload: { summary: "Already queued." }
  });

  store.markMainSessionEventsMaterialized({
    workspaceId: "workspace-1",
    eventIds: [materialized.eventId],
    materializedInputId: "main-input-1"
  });

  assert.deepEqual(
    store
      .listPendingMainSessionEvents({ workspaceId: "workspace-1", ownerMainSessionId: "session-main" })
      .map((event) => event.eventId),
    [pending.eventId]
  );
  assert.deepEqual(
    store
      .listPendingMainSessionEventsByWorkspace({ workspaceId: "workspace-1" })
      .map((event) => event.eventId),
    [pending.eventId]
  );

  store.close();
});

test("runtime user profile round trip preserves manual value and auth fallback only fills when empty", () => {
  const root = makeTempDir("hb-state-store-profile-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const fallback = store.applyRuntimeUserProfileAuthFallback({
    name: "Jeffrey",
  });
  const updated = store.upsertRuntimeUserProfile({
    name: "Jeff",
    nameSource: "manual",
  });
  const preserved = store.applyRuntimeUserProfileAuthFallback({
    name: "Ignored Auth Name",
  });

  assert.equal(fallback?.name, "Jeffrey");
  assert.equal(fallback?.nameSource, "auth_fallback");
  assert.equal(updated.name, "Jeff");
  assert.equal(updated.nameSource, "manual");
  assert.equal(preserved?.name, "Jeff");
  assert.equal(preserved?.nameSource, "manual");
  assert.deepEqual(store.getRuntimeUserProfile(), preserved);

  store.close();
});

test("integration connections round trip create list and reload persisted records", () => {
  const root = makeTempDir("hb-state-store-integrations-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const created = store.upsertIntegrationConnection({
    connectionId: "conn-google-1",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "joshua@holaboss.ai",
    accountExternalId: "google-account-1",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send", "gmail.readonly"],
    status: "active",
    secretRef: "secret/google/1"
  });
  const updated = store.upsertIntegrationConnection({
    connectionId: "conn-google-1",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "joshua@holaboss.ai",
    accountExternalId: "google-account-1",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send"],
    status: "needs_reauth",
    secretRef: "secret/google/1"
  });

  assert.equal(created.connectionId, "conn-google-1");
  assert.equal(updated.status, "needs_reauth");
  assert.deepEqual(store.getIntegrationConnection("conn-google-1"), updated);
  assert.deepEqual(store.listIntegrationConnections().map((record) => record.connectionId), ["conn-google-1"]);

  store.close();

  const reopened = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  assert.deepEqual(reopened.getIntegrationConnection("conn-google-1"), updated);
  assert.deepEqual(reopened.listIntegrationConnections().map((record) => record.connectionId), ["conn-google-1"]);
  reopened.close();
});

test("integration connection identity columns persist + null when not provided", () => {
  const root = makeTempDir("hb-state-store-conn-identity-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  // With identity provided
  const withIdentity = store.upsertIntegrationConnection({
    connectionId: "conn-tw-1",
    providerId: "twitter",
    ownerUserId: "user-1",
    accountLabel: "@joshua",
    accountExternalId: "ca_abc123",
    accountHandle: "joshua",
    accountEmail: null,
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null
  });
  assert.equal(withIdentity.accountHandle, "joshua");
  assert.equal(withIdentity.accountEmail, null);

  // Without identity (legacy callers) — both null
  const withoutIdentity = store.upsertIntegrationConnection({
    connectionId: "conn-tw-2",
    providerId: "twitter",
    ownerUserId: "user-1",
    accountLabel: "@unknown",
    accountExternalId: "ca_def456",
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null
  });
  assert.equal(withoutIdentity.accountHandle, null);
  assert.equal(withoutIdentity.accountEmail, null);

  // Empty / whitespace strings normalise to null
  const blankIdentity = store.upsertIntegrationConnection({
    connectionId: "conn-tw-3",
    providerId: "twitter",
    ownerUserId: "user-1",
    accountLabel: "@blank",
    accountExternalId: "ca_ghi789",
    accountHandle: "  ",
    accountEmail: "",
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null
  });
  assert.equal(blankIdentity.accountHandle, null);
  assert.equal(blankIdentity.accountEmail, null);

  store.close();
});

test("findActiveIntegrationConnectionByIdentity matches by handle or email, scoped per provider+owner, ignores inactive", () => {
  const root = makeTempDir("hb-state-store-conn-identity-find-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  // Two providers for the same user, same handle string — must not cross-match
  store.upsertIntegrationConnection({
    connectionId: "conn-tw-personal",
    providerId: "twitter",
    ownerUserId: "user-1",
    accountLabel: "@joshua",
    accountExternalId: "ca_tw_v1",
    accountHandle: "joshua",
    accountEmail: null,
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-gh-joshua",
    providerId: "github",
    ownerUserId: "user-1",
    accountLabel: "joshua",
    accountExternalId: "ca_gh_v1",
    accountHandle: "joshua",
    accountEmail: null,
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null
  });

  // Twitter handle hit (case-insensitive)
  const tw = store.findActiveIntegrationConnectionByIdentity({
    providerId: "twitter",
    ownerUserId: "user-1",
    accountHandle: "JOSHUA"
  });
  assert.equal(tw?.connectionId, "conn-tw-personal");

  // Different owner — no match
  const otherOwner = store.findActiveIntegrationConnectionByIdentity({
    providerId: "twitter",
    ownerUserId: "user-2",
    accountHandle: "joshua"
  });
  assert.equal(otherOwner, null);

  // No identity supplied → caller falls back to insert
  const noIdentity = store.findActiveIntegrationConnectionByIdentity({
    providerId: "twitter",
    ownerUserId: "user-1"
  });
  assert.equal(noIdentity, null);

  // Inactive rows are skipped
  store.upsertIntegrationConnection({
    connectionId: "conn-gmail-revoked",
    providerId: "gmail",
    ownerUserId: "user-1",
    accountLabel: "j@example.com",
    accountExternalId: "ca_gm_old",
    accountHandle: null,
    accountEmail: "j@example.com",
    authMode: "composio",
    grantedScopes: [],
    status: "revoked",
    secretRef: null
  });
  const skipsRevoked = store.findActiveIntegrationConnectionByIdentity({
    providerId: "gmail",
    ownerUserId: "user-1",
    accountEmail: "j@example.com"
  });
  assert.equal(skipsRevoked, null);

  // When both handle & email supplied → either match wins (most recent)
  store.upsertIntegrationConnection({
    connectionId: "conn-gmail-active",
    providerId: "gmail",
    ownerUserId: "user-1",
    accountLabel: "j@example.com",
    accountExternalId: "ca_gm_new",
    accountHandle: null,
    accountEmail: "j@example.com",
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null
  });
  const emailHit = store.findActiveIntegrationConnectionByIdentity({
    providerId: "gmail",
    ownerUserId: "user-1",
    accountHandle: "anything",
    accountEmail: "J@Example.com"
  });
  assert.equal(emailHit?.connectionId, "conn-gmail-active");

  store.close();
});

test("integration bindings round trip upsert list filter and delete by workspace", () => {
  const root = makeTempDir("hb-state-store-integrations-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  store.upsertIntegrationConnection({
    connectionId: "conn-google-1",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "joshua@holaboss.ai",
    accountExternalId: "google-account-1",
    authMode: "platform",
    grantedScopes: ["gmail.send"],
    status: "active"
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-github-1",
    providerId: "github",
    ownerUserId: "user-1",
    accountLabel: "holaboss-bot",
    accountExternalId: "github-account-1",
    authMode: "managed",
    grantedScopes: ["repo:read"],
    status: "active"
  });

  const first = store.upsertIntegrationBinding({
    bindingId: "bind-google-default",
    workspaceId: "ws-1",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: "conn-google-1",
    isDefault: true
  });
  const second = store.upsertIntegrationBinding({
    bindingId: "bind-google-app",
    workspaceId: "ws-1",
    targetType: "app",
    targetId: "gmail",
    integrationKey: "google",
    connectionId: "conn-google-1",
    isDefault: false
  });
  const otherWorkspace = store.upsertIntegrationBinding({
    bindingId: "bind-github-default",
    workspaceId: "ws-2",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "github",
    connectionId: "conn-github-1",
    isDefault: true
  });

  assert.equal(first.bindingId, "bind-google-default");
  assert.equal(second.targetType, "app");
  assert.equal(otherWorkspace.workspaceId, "ws-2");
  assert.deepEqual(
    store.listIntegrationBindings({ workspaceId: "ws-1" }).map((record) => record.bindingId),
    ["bind-google-default", "bind-google-app"]
  );
  assert.deepEqual(store.getIntegrationBinding("bind-google-app"), second);

  assert.equal(store.deleteIntegrationBinding("bind-google-default"), true);
  assert.equal(store.getIntegrationBinding("bind-google-default"), null);
  assert.deepEqual(
    store.listIntegrationBindings({ workspaceId: "ws-1" }).map((record) => record.bindingId),
    ["bind-google-app"]
  );
  assert.deepEqual(
    store.listIntegrationBindings({ workspaceId: "ws-2" }).map((record) => record.bindingId),
    ["bind-github-default"]
  );

  store.close();

  const reopened = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  assert.deepEqual(
    reopened.listIntegrationBindings({ workspaceId: "ws-1" }).map((record) => record.bindingId),
    ["bind-google-app"]
  );
  assert.deepEqual(reopened.getIntegrationBinding("bind-google-app"), second);
  reopened.close();
});

test("integration binding upsert replaces the same logical target even with a different binding id", () => {
  const root = makeTempDir("hb-state-store-integrations-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  store.upsertIntegrationConnection({
    connectionId: "conn-google-1",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "joshua@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send"],
    status: "active"
  });

  const original = store.upsertIntegrationBinding({
    bindingId: "bind-google-original",
    workspaceId: "ws-1",
    targetType: "app",
    targetId: "gmail",
    integrationKey: "google",
    connectionId: "conn-google-1",
    isDefault: false
  });
  const rebound = store.upsertIntegrationBinding({
    bindingId: "bind-google-rebound",
    workspaceId: "ws-1",
    targetType: "app",
    targetId: "gmail",
    integrationKey: "google",
    connectionId: "conn-google-1",
    isDefault: true
  });

  assert.equal(original.bindingId, "bind-google-original");
  assert.equal(rebound.bindingId, "bind-google-rebound");
  assert.equal(store.getIntegrationBinding("bind-google-original"), null);
  assert.deepEqual(
    store.getIntegrationBindingByTarget({
      workspaceId: "ws-1",
      targetType: "app",
      targetId: "gmail",
      integrationKey: "google"
    }),
    rebound
  );
  assert.deepEqual(
    store.listIntegrationBindings({ workspaceId: "ws-1" }).map((record) => record.bindingId),
    ["bind-google-rebound"]
  );
  store.close();
});

test("integration binding write rejects dangling connection ids", () => {
  const root = makeTempDir("hb-state-store-integrations-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  assert.throws(
    () =>
      store.upsertIntegrationBinding({
        bindingId: "bind-missing-connection",
        workspaceId: "ws-1",
        targetType: "workspace",
        targetId: "default",
        integrationKey: "google",
        connectionId: "conn-missing",
        isDefault: true
      }),
    /integration connection/i
  );
  store.close();
});

test("integration lookup methods support target lookup and provider owner filters", () => {
  const root = makeTempDir("hb-state-store-integrations-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const googleOne = store.upsertIntegrationConnection({
    connectionId: "conn-google-1",
    providerId: "google",
    ownerUserId: "user-1",
    accountLabel: "joshua@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send"],
    status: "active"
  });
  const googleTwo = store.upsertIntegrationConnection({
    connectionId: "conn-google-2",
    providerId: "google",
    ownerUserId: "user-2",
    accountLabel: "joshua+alt@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send"],
    status: "active"
  });
  const github = store.upsertIntegrationConnection({
    connectionId: "conn-github-1",
    providerId: "github",
    ownerUserId: "user-1",
    accountLabel: "holaboss-bot",
    authMode: "managed",
    grantedScopes: ["repo:read"],
    status: "active"
  });

  const binding = store.upsertIntegrationBinding({
    bindingId: "bind-google-default",
    workspaceId: "ws-1",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "google",
    connectionId: "conn-google-1",
    isDefault: true
  });
  const appBinding = store.upsertIntegrationBinding({
    bindingId: "bind-google-app",
    workspaceId: "ws-1",
    targetType: "app",
    targetId: "gmail",
    integrationKey: "google",
    connectionId: "conn-google-2",
    isDefault: false
  });
  store.upsertIntegrationBinding({
    bindingId: "bind-github-default",
    workspaceId: "ws-2",
    targetType: "workspace",
    targetId: "default",
    integrationKey: "github",
    connectionId: "conn-github-1",
    isDefault: true
  });

  assert.deepEqual(
    store.getIntegrationBindingByTarget({
      workspaceId: "ws-1",
      targetType: "workspace",
      targetId: "default",
      integrationKey: "google"
    }),
    binding
  );
  assert.deepEqual(
    store.getIntegrationBindingByTarget({
      workspaceId: "ws-1",
      targetType: "app",
      targetId: "gmail",
      integrationKey: "google"
    }),
    appBinding
  );
  assert.deepEqual(
    store.listIntegrationConnections({ providerId: "google", ownerUserId: "user-1" }).map((record) => record.connectionId),
    ["conn-google-1"]
  );
  assert.deepEqual(
    store.listIntegrationConnections({ providerId: "google" }).map((record) => record.connectionId),
    ["conn-google-1", "conn-google-2"]
  );
  assert.deepEqual(
    store.listIntegrationConnections({ ownerUserId: "user-1" }).map((record) => record.connectionId).sort(),
    ["conn-github-1", "conn-google-1"]
  );
  assert.deepEqual(googleOne, store.getIntegrationConnection("conn-google-1"));
  assert.deepEqual(googleTwo, store.getIntegrationConnection("conn-google-2"));
  assert.deepEqual(github, store.getIntegrationConnection("conn-github-1"));
  store.close();
});

test("input queue supports idempotent enqueue, update, and claiming by priority", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const first = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: { text: "hello" },
    priority: 1,
    idempotencyKey: "idem-1"
  });
  const deduped = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: { text: "ignored" },
    priority: 99,
    idempotencyKey: "idem-1"
  });
  const second = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: { text: "urgent" },
    priority: 5
  });

  assert.equal(deduped.inputId, first.inputId);
  assert.equal(store.hasAvailableInputsForSession({ sessionId: "session-main", workspaceId: "workspace-1" }), true);

  const updated = store.updateInput({
    workspaceId: "workspace-1",
    inputId: first.inputId,
    fields: {
      status: "QUEUED",
      claimedBy: "worker-old",
      payload: { text: "hello-updated" }
    }
  });
  assert.ok(updated);
  assert.deepEqual(updated.payload, { text: "hello-updated" });

  const claimed = store.claimInputs({ limit: 2, claimedBy: "worker-1", leaseSeconds: 60 });
  assert.equal(claimed.length, 2);
  assert.equal(claimed[0].inputId, second.inputId);
  assert.equal(claimed[0].status, "CLAIMED");
  assert.equal(claimed[0].claimedBy, "worker-1");
  assert.equal(claimed[1].inputId, first.inputId);
  assert.equal(store.hasAvailableInputsForSession({ sessionId: "session-main", workspaceId: "workspace-1" }), false);
  store.close();
});

test("claimInputs can select at most one queued input per session", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const sessionOneFirst = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-one",
    payload: { text: "session-one-first" },
    priority: 5
  });
  store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-one",
    payload: { text: "session-one-second" },
    priority: 4
  });
  const sessionTwo = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-two",
    payload: { text: "session-two" },
    priority: 3
  });

  const claimed = store.claimInputs({
    limit: 2,
    claimedBy: "worker-1",
    leaseSeconds: 60,
    distinctSessions: true
  });

  assert.equal(claimed.length, 2);
  assert.deepEqual(
    claimed.map((record) => record.inputId),
    [sessionOneFirst.inputId, sessionTwo.inputId]
  );
  assert.deepEqual(
    claimed.map((record) => record.sessionId),
    ["session-one", "session-two"]
  );
  store.close();
});

test("claimInputs skips queued work for sessions that already have a live claimed input", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const active = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-one",
    payload: { text: "session-one-active" },
    priority: 5
  });
  const blocked = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-one",
    payload: { text: "session-one-blocked" },
    priority: 4
  });
  const available = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-two",
    payload: { text: "session-two" },
    priority: 3
  });

  const firstClaim = store.claimInputs({
    limit: 1,
    claimedBy: "worker-1",
    leaseSeconds: 300
  });
  assert.equal(firstClaim.length, 1);
  assert.equal(firstClaim[0]?.inputId, active.inputId);

  const secondClaim = store.claimInputs({
    limit: 2,
    claimedBy: "worker-2",
    leaseSeconds: 300
  });
  assert.deepEqual(
    secondClaim.map((record) => record.inputId),
    [available.inputId]
  );
  assert.equal(store.getInput({ workspaceId: "workspace-1", inputId: blocked.inputId })?.status, "QUEUED");

  store.close();
});

test("post-run job queue supports idempotent enqueue, update, and claiming by priority", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const first = store.enqueuePostRunJob({
    jobType: "durable_memory_writeback",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    payload: { instruction: "hello" },
    priority: 1,
    idempotencyKey: "post-run-idem-1"
  });
  const deduped = store.enqueuePostRunJob({
    jobType: "durable_memory_writeback",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    payload: { instruction: "ignored" },
    priority: 99,
    idempotencyKey: "post-run-idem-1"
  });
  const second = store.enqueuePostRunJob({
    jobType: "durable_memory_writeback",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-2",
    payload: { instruction: "urgent" },
    priority: 5
  });

  assert.equal(deduped.jobId, first.jobId);

  const updated = store.updatePostRunJob({
    workspaceId: "workspace-1",
    jobId: first.jobId,
    fields: {
      status: "QUEUED",
      claimedBy: "worker-old",
      payload: { instruction: "hello-updated" }
    }
  });
  assert.ok(updated);
  assert.deepEqual(updated.payload, { instruction: "hello-updated" });

  const claimed = store.claimPostRunJobs({ limit: 2, claimedBy: "worker-1", leaseSeconds: 60 });
  assert.equal(claimed.length, 2);
  assert.equal(claimed[0].jobId, second.jobId);
  assert.equal(claimed[0].status, "CLAIMED");
  assert.equal(claimed[0].claimedBy, "worker-1");
  assert.equal(claimed[1].jobId, first.jobId);
  store.close();
});

test("state store lists expired claimed post-run jobs", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  store.enqueuePostRunJob({
    jobType: "durable_memory_writeback",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-queued",
    payload: {}
  });
  const stale = store.enqueuePostRunJob({
    jobType: "durable_memory_writeback",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-stale",
    payload: {}
  });
  const active = store.enqueuePostRunJob({
    jobType: "durable_memory_writeback",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-active",
    payload: {}
  });

  store.updatePostRunJob({
    workspaceId: "workspace-1",
    jobId: stale.jobId,
    fields: {
      status: "CLAIMED",
      claimedBy: "worker-old",
      claimedUntil: "2000-01-01T00:00:00.000Z"
    }
  });
  store.updatePostRunJob({
    workspaceId: "workspace-1",
    jobId: active.jobId,
    fields: {
      status: "CLAIMED",
      claimedBy: "worker-new",
      claimedUntil: "2999-01-01T00:00:00.000Z"
    }
  });

  const expired = store.listExpiredClaimedPostRunJobs("2026-01-01T00:00:00.000Z");

  assert.deepEqual(expired.map((record) => record.jobId), [stale.jobId]);
  store.close();
});

test("runtime state round trip supports ensure, update, list, and lookup", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const ensured = store.ensureRuntimeState({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    status: "QUEUED",
    currentInputId: "input-1"
  });
  const updated = store.updateRuntimeState({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    status: "WAITING_USER",
    currentInputId: "input-1",
    currentWorkerId: "worker-1",
    leaseUntil: "2026-01-02T00:00:00+00:00",
    heartbeatAt: "2026-01-01T00:00:00+00:00",
    lastError: { message: "blocked" }
  });

  assert.equal(ensured.status, "QUEUED");
  assert.equal(updated.status, "WAITING_USER");
  assert.deepEqual(updated.lastError, { message: "blocked" });
  assert.deepEqual(store.getRuntimeState({ sessionId: "session-main", workspaceId: "workspace-1" }), updated);
  assert.deepEqual(store.listRuntimeStates("workspace-1"), [updated]);
  store.close();
});

test("runtime state migration expands the status check constraint to include paused", () => {
  const root = makeTempDir("hb-state-store-paused-runtime-state-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureRuntimeState({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    status: "QUEUED",
    currentInputId: "input-1",
  });
  store.close();

  const workspaceDbPath = workspaceRuntimeDbFile(workspaceRoot, "workspace-1");
  const db = new Database(workspaceDbPath);
  db.exec(`
    ALTER TABLE session_runtime_state RENAME TO session_runtime_state_current;

    CREATE TABLE session_runtime_state (
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('IDLE', 'BUSY', 'WAITING_USER', 'ERROR', 'QUEUED')),
        current_input_id TEXT,
        current_worker_id TEXT,
        lease_until TEXT,
        heartbeat_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, session_id)
    );

    INSERT INTO session_runtime_state
    SELECT * FROM session_runtime_state_current;

    DROP TABLE session_runtime_state_current;
  `);
  db.close();

  const reopened = new RuntimeStateStore({ dbPath, workspaceRoot });
  const updated = reopened.updateRuntimeState({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    status: "PAUSED",
    currentInputId: null,
    currentWorkerId: null,
    leaseUntil: null,
    heartbeatAt: "2026-01-01T00:00:00.000Z",
    lastError: null,
  });

  assert.equal(updated.status, "PAUSED");
  reopened.close();
});

test("state store lists expired claimed inputs", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: { text: "queued" }
  });
  const stale = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: { text: "stale" }
  });
  const active = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: { text: "active" }
  });

  store.updateInput({
    workspaceId: "workspace-1",
    inputId: stale.inputId,
    fields: {
      status: "CLAIMED",
      claimedBy: "worker-old",
      claimedUntil: "2000-01-01T00:00:00.000Z"
    }
  });
  store.updateInput({
    workspaceId: "workspace-1",
    inputId: active.inputId,
    fields: {
      status: "CLAIMED",
      claimedBy: "worker-new",
      claimedUntil: "2999-01-01T00:00:00.000Z"
    }
  });

  const expired = store.listExpiredClaimedInputs("2026-01-01T00:00:00.000Z");

  assert.deepEqual(expired.map((record) => record.inputId), [stale.inputId]);
  store.close();
});

test("session messages preserve ascending order and round trip metadata", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    role: "user",
    text: "hello",
    metadata: {
      attachments: [
        {
          id: "attachment-1",
          kind: "file",
          name: "report.html",
          mime_type: "text/html",
          size_bytes: 123,
          workspace_path: ".holaboss/input-attachments/report.html",
        },
      ],
    },
    messageId: "m-1",
    createdAt: "2026-01-01T00:00:00+00:00"
  });
  store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    role: "assistant",
    text: "hi",
    metadata: { source: "test" },
    messageId: "m-2",
    createdAt: "2026-01-01T00:00:01+00:00"
  });

  assert.deepEqual(store.listSessionMessages({ workspaceId: "workspace-1", sessionId: "session-main" }), [
    {
      id: "m-1",
      role: "user",
      text: "hello",
      createdAt: "2026-01-01T00:00:00+00:00",
      metadata: {
        attachments: [
          {
            id: "attachment-1",
            kind: "file",
            name: "report.html",
            mime_type: "text/html",
            size_bytes: 123,
            workspace_path: ".holaboss/input-attachments/report.html",
          },
        ],
      }
    },
    {
      id: "m-2",
      role: "assistant",
      text: "hi",
      createdAt: "2026-01-01T00:00:01+00:00",
      metadata: { source: "test" }
    }
  ]);
  assert.equal(
    store.countSessionMessages({
      workspaceId: "workspace-1",
      sessionId: "session-main",
    }),
    2,
  );
  assert.deepEqual(
    store.listSessionMessages({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      role: "user",
      order: "desc",
      limit: 1,
    }),
    [
      {
        id: "m-1",
        role: "user",
        text: "hello",
        createdAt: "2026-01-01T00:00:00+00:00",
        metadata: {
          attachments: [
            {
              id: "attachment-1",
              kind: "file",
              name: "report.html",
              mime_type: "text/html",
              size_bytes: 123,
              workspace_path: ".holaboss/input-attachments/report.html",
            },
          ],
        }
      }
    ]
  );
  assert.deepEqual(
    store.listSessionMessages({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      order: "desc",
      limit: 1,
      offset: 1,
    }),
    [
      {
        id: "m-1",
        role: "user",
        text: "hello",
        createdAt: "2026-01-01T00:00:00+00:00",
        metadata: {
          attachments: [
            {
              id: "attachment-1",
              kind: "file",
              name: "report.html",
              mime_type: "text/html",
              size_bytes: 123,
              workspace_path: ".holaboss/input-attachments/report.html",
            },
          ],
        }
      }
    ],
  );
  store.close();
});

test("session messages preserve sub-second ordering within the same second", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    role: "user",
    text: "first",
    messageId: "m-user",
    createdAt: "2026-01-01T00:00:00.100Z"
  });
  store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    role: "assistant",
    text: "second",
    messageId: "m-assistant",
    createdAt: "2026-01-01T00:00:00.200Z"
  });

  assert.deepEqual(
    store
      .listSessionMessages({
        workspaceId: "workspace-1",
        sessionId: "session-main",
      })
      .map((message) => message.id),
    ["m-user", "m-assistant"],
  );

  store.close();
});

test("output events support latest id, incremental listing, and tail mode", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  store.appendOutputEvent({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    sequence: 1,
    eventType: "run_started",
    payload: { instruction_preview: "hello" }
  });
  store.appendOutputEvent({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    sequence: 2,
    eventType: "output_delta",
    payload: { delta: "hi" }
  });

  const latest = store.latestOutputEventId({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
  });
  const incremental = store.listOutputEvents({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    afterEventId: 1
  });
  const tail = store.listOutputEvents({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    includeHistory: false
  });

  assert.equal(latest, 2);
  assert.equal(incremental.length, 1);
  assert.equal(incremental[0].eventType, "output_delta");
  assert.deepEqual(incremental[0].payload, { delta: "hi" });
  assert.deepEqual(tail, []);
  store.close();
});

test("terminal sessions support create update event append and list", () => {
  const root = makeTempDir("hb-state-store-terminal-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const created = store.createTerminalSession({
    terminalId: "term-1",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    title: "Dev Server",
    backend: "node_pty",
    owner: "agent",
    status: "starting",
    cwd: "/tmp/workspace-1",
    shell: "/bin/bash",
    command: "npm run dev",
    metadata: { source: "test" },
  });

  const outputEvent = store.appendTerminalSessionEvent({
    workspaceId: "workspace-1",
    terminalId: "term-1",
    eventType: "output",
    payload: { data: "ready\n" },
    status: "running",
  });
  const exitEvent = store.appendTerminalSessionEvent({
    workspaceId: "workspace-1",
    terminalId: "term-1",
    eventType: "exit",
    payload: { exit_code: 0 },
    status: "exited",
    exitCode: 0,
    endedAt: "2026-01-01T00:00:10.000Z",
  });
  const updated = store.updateTerminalSession({
    workspaceId: "workspace-1",
    terminalId: "term-1",
    title: "Dev Server Ready",
    metadata: { source: "test", ready: true },
  });
  const listed = store.listTerminalSessions({
    workspaceId: "workspace-1",
    statuses: ["exited"],
  });
  const events = store.listTerminalSessionEvents({
    workspaceId: "workspace-1",
    terminalId: "term-1",
  });

  assert.equal(created.terminalId, "term-1");
  assert.equal(created.status, "starting");
  assert.equal(outputEvent.sequence, 1);
  assert.equal(exitEvent.sequence, 2);
  assert.equal(updated.status, "exited");
  assert.equal(updated.exitCode, 0);
  assert.equal(updated.lastEventSeq, 2);
  assert.equal(updated.title, "Dev Server Ready");
  assert.deepEqual(updated.metadata, { source: "test", ready: true });
  assert.deepEqual(listed.map((record) => record.terminalId), ["term-1"]);
  assert.deepEqual(events.map((event) => event.eventType), ["output", "exit"]);
  assert.deepEqual(events[0]?.payload, { data: "ready\n" });
  assert.deepEqual(
    store.listTerminalSessionEvents({ workspaceId: "workspace-1", terminalId: "term-1", afterSequence: 1 }).map(
      (event) => event.sequence
    ),
    [2]
  );

  store.close();
});

test("turn results support upsert, lookup, count, and listing", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "done",
    toolUsageSummary: {
      total_calls: 1,
      completed_calls: 1,
      failed_calls: 0,
      tool_names: ["read"],
      tool_ids: []
    },
    permissionDenials: [],
    promptSectionIds: ["runtime_core", "execution_policy"],
    capabilityManifestFingerprint: "abc123",
    requestSnapshotFingerprint: "snap-1",
    promptCacheProfile: {
      cacheable_section_ids: ["runtime_core"],
      volatile_section_ids: ["execution_policy"],
    },
    contextBudgetDecisions: {
      pressure_stage: "normal",
      lane_decisions: [],
      prompt_cache_stable_candidate: true,
      tool_replay_trimmed: false,
      retrieval_clipped: false,
      checkpoint_queued: false,
    },
    tokenUsage: { input_tokens: 10, output_tokens: 20 },
  });
  const updated = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:06.000Z",
    status: "waiting_user",
    stopReason: "waiting_user",
    assistantText: "need confirmation",
    toolUsageSummary: {
      total_calls: 2,
      completed_calls: 2,
      failed_calls: 0,
      tool_names: ["question", "read"],
      tool_ids: []
    },
    permissionDenials: [{ tool_name: "deploy", tool_id: null, reason: "permission denied" }],
    promptSectionIds: ["runtime_core", "session_policy"],
    capabilityManifestFingerprint: "def456",
    requestSnapshotFingerprint: "snap-2",
    promptCacheProfile: {
      cacheable_section_ids: ["runtime_core"],
      volatile_section_ids: ["session_policy"],
    },
    contextBudgetDecisions: {
      pressure_stage: "trim_replay",
      lane_decisions: [],
      prompt_cache_stable_candidate: true,
      tool_replay_trimmed: true,
      retrieval_clipped: false,
      checkpoint_queued: false,
    },
    tokenUsage: { input_tokens: 11, output_tokens: 21 },
  });

  assert.equal(updated.status, "waiting_user");
  assert.equal(updated.stopReason, "waiting_user");
  assert.equal(updated.assistantText, "need confirmation");
  assert.deepEqual(updated.promptSectionIds, ["runtime_core", "session_policy"]);
  assert.equal(updated.requestSnapshotFingerprint, "snap-2");
  assert.deepEqual(updated.promptCacheProfile, {
    cacheable_section_ids: ["runtime_core"],
    volatile_section_ids: ["session_policy"],
  });
  assert.deepEqual(updated.contextBudgetDecisions, {
    pressure_stage: "trim_replay",
    lane_decisions: [],
    prompt_cache_stable_candidate: true,
    tool_replay_trimmed: true,
    retrieval_clipped: false,
    checkpoint_queued: false,
  });
  assert.deepEqual(updated.permissionDenials, [
    { tool_name: "deploy", tool_id: null, reason: "permission denied" }
  ]);
  assert.deepEqual(store.getTurnResult({ workspaceId: "workspace-1", inputId: "input-1" }), updated);
  assert.equal(store.countTurnResults({ workspaceId: "workspace-1", sessionId: "session-main" }), 1);
  assert.equal(store.countTurnResults({ workspaceId: "workspace-1", sessionId: "session-main", status: "completed" }), 0);
  assert.equal(store.countTurnResults({ workspaceId: "workspace-1", sessionId: "session-main", status: "waiting_user" }), 1);
  assert.deepEqual(store.listTurnResults({ workspaceId: "workspace-1", sessionId: "session-main" }), [updated]);
  assert.deepEqual(store.listTurnResults({ workspaceId: "workspace-1", sessionId: "session-main", status: "waiting_user" }), [updated]);
  const telemetryOnlyUpdate = store.updateTurnResultContextBudgetDecisions({
    workspaceId: "workspace-1",
    inputId: "input-1",
    contextBudgetDecisions: {
      mode: "observability_only",
      checkpoint_queued: true,
    },
  });
  assert.deepEqual(telemetryOnlyUpdate?.contextBudgetDecisions, {
    mode: "observability_only",
    checkpoint_queued: true,
  });
  store.close();
});

test("turn request snapshots round trip", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const snapshot = store.upsertTurnRequestSnapshot({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    snapshotKind: "harness_host_request",
    fingerprint: "f".repeat(64),
    payload: {
      provider_id: "openai",
      model_id: "gpt-5.4",
      system_prompt: "You are concise.",
    },
  });

  assert.deepEqual(
    store.getTurnRequestSnapshot({ workspaceId: "workspace-1", inputId: "input-1" }),
    snapshot
  );
  assert.deepEqual(store.listTurnRequestSnapshots({ workspaceId: "workspace-1", sessionId: "session-main" }), [snapshot]);
  store.close();
});

test("memory entries round trip and filter by workspace or scope", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const preference = store.upsertMemoryEntry({
    memoryId: "user-preference:response-style",
    workspaceId: null,
    sessionId: "session-main",
    scope: "user",
    memoryType: "preference",
    subjectKey: "response-style",
    path: "preference/response-style.md",
    title: "User response style",
    summary: "User prefers concise responses.",
    tags: ["concise", "response-style"],
    verificationPolicy: "none",
    stalenessPolicy: "stable",
    staleAfterSeconds: null,
    sourceTurnInputId: "input-1",
    sourceMessageId: "user-1",
    sourceType: "session_message",
    observedAt: "2026-04-02T12:00:00.000Z",
    lastVerifiedAt: "2026-04-02T12:00:00.000Z",
    confidence: 0.99,
    fingerprint: "p".repeat(64),
  });
  const blocker = store.upsertMemoryEntry({
    memoryId: "workspace-blocker:workspace-1:deploy",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    scope: "workspace",
    memoryType: "blocker",
    subjectKey: "permission:deploy",
    path: "workspace/workspace-1/knowledge/blockers/deploy.md",
    title: "Deploy permission blocker",
    summary: "Deploy calls may be denied by policy.",
    tags: ["deploy", "permission", "blocker"],
    verificationPolicy: "check_before_use",
    stalenessPolicy: "workspace_sensitive",
    staleAfterSeconds: 14 * 24 * 60 * 60,
    sourceTurnInputId: "input-2",
    sourceMessageId: null,
    sourceType: "permission_denial",
    observedAt: "2026-04-02T12:05:00.000Z",
    lastVerifiedAt: "2026-04-02T12:05:00.000Z",
    confidence: 0.92,
    fingerprint: "b".repeat(64),
  });

  assert.deepEqual(store.getMemoryEntry({ memoryId: "user-preference:response-style" }), preference);
  assert.deepEqual(store.listMemoryEntries({ scope: "user", status: "active" }), [preference]);
  assert.deepEqual(
    store.listMemoryEntries({ scope: "user", memoryType: "preference", status: "active" }),
    [preference]
  );
  assert.deepEqual(store.listMemoryEntries({ workspaceId: "workspace-1", status: "active" }), [blocker]);
  assert.deepEqual(store.listWorkspaceMemoryEntryCounts({ status: "active" }), [
    { workspaceId: "workspace-1", count: 1 }
  ]);
  assert.deepEqual(
    store.listMemoryEntries({ status: "active" }).map((entry) => entry.memoryId),
    [blocker.memoryId, preference.memoryId]
  );

  const controlPlaneDb = new Database(store.controlPlaneDbPath, { readonly: true });
  const workspaceDb = new Database(workspaceRuntimeDbFile(store.workspaceRoot, "workspace-1"), { readonly: true });
  assert.equal(
    Number((controlPlaneDb.prepare("SELECT COUNT(*) AS count FROM memory_entries").get() as { count: number }).count),
    1,
  );
  assert.equal(
    Number((workspaceDb.prepare("SELECT COUNT(*) AS count FROM memory_entries").get() as { count: number }).count),
    1,
  );
  controlPlaneDb.close();
  workspaceDb.close();
  store.close();
});

test("memory embedding index supports vector replacement, search, and delete", () => {
  const root = makeTempDir("hb-state-store-vec-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  assert.equal(store.supportsVectorIndex(), true);

  const workspaceVector = new Float32Array(1536).fill(0);
  workspaceVector[0] = 1;
  const preferenceVector = new Float32Array(1536).fill(0);
  preferenceVector[1] = 1;

  const workspaceIndex = store.upsertMemoryEmbeddingIndex({
    memoryId: "workspace-fact:workspace-1:deploy",
    path: "workspace/workspace-1/knowledge/facts/deploy.md",
    workspaceId: "workspace-1",
    scopeBucket: "workspace",
    memoryType: "fact",
    contentFingerprint: "a".repeat(64),
    embeddingModel: "text-embedding-3-small",
    embeddingDim: 1536,
  });
  store.replaceMemoryRecallVector({
    vecRowid: workspaceIndex.vecRowid,
    embedding: workspaceVector,
    scopeBucket: "workspace",
    workspaceId: "workspace-1",
    memoryType: "fact",
  });

  const preferenceIndex = store.upsertMemoryEmbeddingIndex({
    memoryId: "user-preference:style",
    path: "preference/response-style.md",
    workspaceId: null,
    scopeBucket: "preference",
    memoryType: "preference",
    contentFingerprint: "b".repeat(64),
    embeddingModel: "text-embedding-3-small",
    embeddingDim: 1536,
  });
  store.replaceMemoryRecallVector({
    vecRowid: preferenceIndex.vecRowid,
    embedding: preferenceVector,
    scopeBucket: "preference",
    workspaceId: null,
    memoryType: "preference",
  });

  const workspaceResults = store.searchWorkspaceMemoryRecallVectors({
    workspaceId: "workspace-1",
    embedding: workspaceVector,
    limit: 5,
  });
  const userResults = store.searchUserMemoryRecallVectors({
    embedding: preferenceVector,
    limit: 5,
  });

  assert.equal(workspaceResults[0]?.path, "workspace/workspace-1/knowledge/facts/deploy.md");
  assert.equal(userResults[0]?.path, "preference/response-style.md");

  store.deleteMemoryEmbeddingIndex("workspace-fact:workspace-1:deploy");

  assert.equal(store.getMemoryEmbeddingIndexByMemoryId({ memoryId: "workspace-fact:workspace-1:deploy" }), null);
  assert.equal(
    store.searchWorkspaceMemoryRecallVectors({
      workspaceId: "workspace-1",
      embedding: workspaceVector,
      limit: 5,
    }).length,
    0
  );
  store.close();
});

test("node embedding vector indexes support interaction and integration top-k search", () => {
  const root = makeTempDir("hb-state-store-node-vec-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });

  assert.equal(store.supportsVectorIndex(), true);
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });

  const primaryVector = new Float32Array(1536).fill(0);
  primaryVector[0] = 1;
  const secondaryVector = new Float32Array(1536).fill(0);
  secondaryVector[1] = 1;

  store.upsertInteractionNodeEmbedding({
    workspaceId: "workspace-1",
    nodeKind: "summary",
    nodeId: "semantic:interaction:vector-primary",
    entityId: "interaction:workflow:vector-primary",
    embeddingModel: "text-embedding-3-small",
    contentFingerprint: "c".repeat(64),
    dimensions: 1536,
    vector: Array.from(primaryVector),
  });
  store.upsertInteractionNodeEmbedding({
    workspaceId: "workspace-1",
    nodeKind: "summary",
    nodeId: "semantic:interaction:vector-secondary",
    entityId: "interaction:workflow:vector-primary",
    embeddingModel: "text-embedding-3-small",
    contentFingerprint: "d".repeat(64),
    dimensions: 1536,
    vector: Array.from(secondaryVector),
  });

  const interactionResults = store.searchInteractionNodeEmbeddingsByVector({
    workspaceId: "workspace-1",
    embedding: primaryVector,
    embeddingModel: "text-embedding-3-small",
    limit: 2,
    entityIds: ["interaction:workflow:vector-primary"],
    nodeKinds: ["summary"],
  });
  assert.equal(interactionResults[0]?.nodeId, "semantic:interaction:vector-primary");

  const treeId = "integration:github:vector-primary";
  store.upsertIntegrationTree({
    treeId,
    provider: "github",
    ownerUserId: "user-1",
    accountKey: "vector-github",
    accountLabel: "Vector GitHub",
    slug: "github-vector-primary",
    summary: "Vector GitHub memory.",
    status: "active",
  });
  store.upsertIntegrationNodeEmbedding({
    nodeKind: "summary",
    nodeId: "semantic:integration:vector-primary",
    treeId,
    embeddingModel: "text-embedding-3-small",
    contentFingerprint: "e".repeat(64),
    dimensions: 1536,
    vector: Array.from(primaryVector),
  });
  store.upsertIntegrationNodeEmbedding({
    nodeKind: "summary",
    nodeId: "semantic:integration:vector-secondary",
    treeId,
    embeddingModel: "text-embedding-3-small",
    contentFingerprint: "f".repeat(64),
    dimensions: 1536,
    vector: Array.from(secondaryVector),
  });

  const integrationResults = store.searchIntegrationNodeEmbeddingsByVector({
    embedding: primaryVector,
    embeddingModel: "text-embedding-3-small",
    limit: 2,
    treeIds: [treeId],
    nodeKinds: ["summary"],
  });
  assert.equal(integrationResults[0]?.nodeId, "semantic:integration:vector-primary");

  const vecRowid = integrationResults[0]?.vecRowid ?? null;
  store.deleteIntegrationTreeMemory({ treeId });
  assert.equal(
    store.searchIntegrationNodeEmbeddingsByVector({
      embedding: primaryVector,
      embeddingModel: "text-embedding-3-small",
      limit: 2,
      treeIds: [treeId],
      nodeKinds: ["summary"],
    }).length,
    0,
  );
  if (vecRowid !== null) {
    const db = new Database(store.controlPlaneDbPath, { readonly: true });
    sqliteVec.load(db as unknown as { loadExtension(file: string, entrypoint?: string | undefined): void });
    const remaining = Number(
      (
        db.prepare<[number], { count: number }>("SELECT COUNT(*) AS count FROM integration_node_embedding_vec WHERE vec_rowid = ?")
          .get(vecRowid) as { count: number }
      ).count,
    );
    db.close();
    assert.equal(remaining, 0);
  }

  store.close();
});

test("app build status round trip supports upsert, lookup, and delete", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const building = store.upsertAppBuild({
    workspaceId: "workspace-1",
    appId: "app-a",
    status: "building"
  });
  const failed = store.upsertAppBuild({
    workspaceId: "workspace-1",
    appId: "app-a",
    status: "failed",
    error: "boom"
  });
  const completed = store.upsertAppBuild({
    workspaceId: "workspace-1",
    appId: "app-a",
    status: "completed"
  });
  const fetched = store.getAppBuild({
    workspaceId: "workspace-1",
    appId: "app-a"
  });
  const deleted = store.deleteAppBuild({
    workspaceId: "workspace-1",
    appId: "app-a"
  });

  assert.equal(building.status, "building");
  assert.ok(building.startedAt);
  assert.equal(building.completedAt, null);
  assert.equal(building.error, null);
  assert.equal(failed.status, "failed");
  assert.ok(failed.completedAt);
  assert.equal(failed.error, "boom");
  assert.equal(completed.status, "completed");
  assert.ok(completed.completedAt);
  assert.equal(completed.error, null);
  assert.ok(fetched);
  assert.equal(fetched.status, "completed");
  assert.equal(deleted, true);
  assert.equal(
    store.getAppBuild({
      workspaceId: "workspace-1",
      appId: "app-a"
    }),
    null
  );
  store.close();
});

test("workspace-scoped runtime tables persist inside the workspace bundle and mirror runtime.db", () => {
  const root = makeTempDir("hb-state-store-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath,
    workspaceRoot
  });

  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Acme",
    harness: "pi",
    status: "active"
  });
  store.ensureSession({
    workspaceId: "workspace-1",
    sessionId: "session-1"
  });
  store.createOutput({
    workspaceId: "workspace-1",
    outputType: "report",
    title: "Daily note"
  });
  store.upsertAppBuild({
    workspaceId: "workspace-1",
    appId: "app-a",
    status: "building"
  });
  store.allocateAppPort({
    workspaceId: "workspace-1",
    appId: "app-a"
  });
  const cronjob = store.createCronjob({
    workspaceId: "workspace-1",
    initiatedBy: "workspace_agent",
    teammateId: "general",
    cron: "0 9 * * *",
    description: "Daily check",
    instruction: "Say hello",
    delivery: { mode: "announce", channel: "session_run", to: null }
  });
  store.createRuntimeNotification({
    workspaceId: "workspace-1",
    cronjobId: cronjob.id,
    sourceType: "cronjob",
    title: "Hydrate",
    message: "Drink water."
  });
  store.createTaskProposal({
    proposalId: "proposal-1",
    workspaceId: "workspace-1",
    taskName: "Daily summary",
    taskPrompt: "Summarize the day.",
    taskGenerationRationale: "Keep the team aligned.",
    createdAt: "2026-05-06T00:00:00.000Z"
  });
  store.createEvolveSkillCandidate({
    candidateId: "candidate-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    inputId: "input-1",
    kind: "skill_create",
    title: "Daily summary helper",
    summary: "Creates a short summary skill.",
    slug: "daily-summary-helper",
    skillPath: "skills/daily-summary-helper/SKILL.md",
    contentFingerprint: "fp-1"
  });
  store.createMemoryUpdateProposal({
    proposalId: "memory-proposal-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    inputId: "input-1",
    proposalKind: "preference",
    targetKey: "workspace/daily-summary",
    title: "Remember summary preference",
    summary: "Store that daily summaries should stay short.",
  });
  store.close();

  const workspaceDbPath = workspaceRuntimeDbFile(workspaceRoot, "workspace-1");
  assert.equal(fs.existsSync(workspaceDbPath), true);

  const workspaceDb = new Database(workspaceDbPath, { readonly: true });
  const workspaceCounts = {
    outputs: Number((workspaceDb.prepare("SELECT COUNT(*) AS count FROM outputs").get() as { count: number }).count),
    appBuilds: Number((workspaceDb.prepare("SELECT COUNT(*) AS count FROM app_builds").get() as { count: number }).count),
    appPorts: Number((workspaceDb.prepare("SELECT COUNT(*) AS count FROM app_ports").get() as { count: number }).count),
    cronjobs: Number((workspaceDb.prepare("SELECT COUNT(*) AS count FROM cronjobs").get() as { count: number }).count),
    notifications: Number((workspaceDb.prepare("SELECT COUNT(*) AS count FROM runtime_notifications").get() as { count: number }).count),
    taskProposals: Number((workspaceDb.prepare("SELECT COUNT(*) AS count FROM task_proposals").get() as { count: number }).count),
    evolveCandidates: Number((workspaceDb.prepare("SELECT COUNT(*) AS count FROM evolve_skill_candidates").get() as { count: number }).count),
    memoryUpdateProposals: Number((workspaceDb.prepare("SELECT COUNT(*) AS count FROM memory_update_proposals").get() as { count: number }).count),
  };
  workspaceDb.close();

  const runtimeDb = new Database(dbPath, { readonly: true });
  const runtimeTables = new Set<string>(
    (runtimeDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  runtimeDb.close();

  assert.deepEqual(workspaceCounts, {
    outputs: 1,
    appBuilds: 1,
    appPorts: 1,
    cronjobs: 1,
    notifications: 1,
    taskProposals: 1,
    evolveCandidates: 1,
    memoryUpdateProposals: 1,
  });
  assert.equal(runtimeTables.has("outputs"), false);
  assert.equal(runtimeTables.has("app_builds"), false);
  assert.equal(runtimeTables.has("app_ports"), false);
  assert.equal(runtimeTables.has("cronjobs"), false);
  assert.equal(runtimeTables.has("runtime_notifications"), false);
  assert.equal(runtimeTables.has("task_proposals"), false);
  assert.equal(runtimeTables.has("evolve_skill_candidates"), false);
  assert.equal(runtimeTables.has("memory_update_proposals"), false);
});

test("cronjobs round trip supports create, list, update, get, and delete", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const job = store.createCronjob({
    workspaceId: "workspace-1",
    initiatedBy: "workspace_agent",
    teammateId: "general",
    cron: "0 9 * * *",
    description: "Daily check",
    instruction: "Say hello",
    delivery: { mode: "announce", channel: "session_run", to: null }
  });
  const listed = store.listCronjobs({ workspaceId: "workspace-1" });
  const fetched = store.getCronjob({ workspaceId: "workspace-1", jobId: job.id });
  const updated = store.updateCronjob({
    workspaceId: "workspace-1",
    jobId: job.id,
    description: "Updated check",
    instruction: "Say hello loudly"
  });
  const deleted = store.deleteCronjob({ workspaceId: "workspace-1", jobId: job.id });

  assert.equal(listed.length, 1);
  assert.ok(fetched);
  assert.equal(fetched.teammateId, "general");
  assert.equal(fetched.instruction, "Say hello");
  assert.ok(updated);
  assert.equal(updated.description, "Updated check");
  assert.equal(updated.instruction, "Say hello loudly");
  assert.equal(deleted, true);
  store.close();
});

test("cronjob schema migration backfills instruction from legacy description", () => {
  const root = makeTempDir("hb-state-store-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE cronjobs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        initiated_by TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        cron TEXT NOT NULL,
        description TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        delivery TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        last_run_at TEXT,
        next_run_at TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        last_status TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO cronjobs (
      id, workspace_id, initiated_by, name, cron, description, enabled, delivery, metadata,
      last_run_at, next_run_at, run_count, last_status, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "job-1",
    "workspace-1",
    "workspace_agent",
    "Greeting",
    "*/5 * * * *",
    "Say hello every 5 minutes.",
    1,
    JSON.stringify({ channel: "session_run" }),
    "{}",
    null,
    null,
    0,
    null,
    null,
    "2026-01-01T00:00:00+00:00",
    "2026-01-01T00:00:00+00:00"
  );
  db.close();

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  const migrated = store.getCronjob({ workspaceId: "workspace-1", jobId: "job-1" });

  assert.ok(migrated);
  assert.equal(migrated.teammateId, "general");
  assert.equal(migrated.instruction, "Say hello every 5 minutes.");
  store.close();
});

test("workspace-scoped runtime db backfills legacy cronjobs from runtime.db on first access", () => {
  const root = makeTempDir("hb-state-store-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");
  const initialStore = new RuntimeStateStore({ dbPath, workspaceRoot });

  initialStore.createWorkspace({
    workspaceId: "workspace-1",
    name: "Legacy",
    harness: "pi",
    status: "active"
  });
  initialStore.close();

  const workspaceDbPath = workspaceRuntimeDbFile(workspaceRoot, "workspace-1");
  assert.equal(fs.existsSync(workspaceDbPath), false);

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE cronjobs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        initiated_by TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        cron TEXT NOT NULL,
        description TEXT NOT NULL,
        instruction TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        delivery TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        last_run_at TEXT,
        next_run_at TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        last_status TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO cronjobs (
      id, workspace_id, initiated_by, name, cron, description, instruction, enabled, delivery, metadata,
      last_run_at, next_run_at, run_count, last_status, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "job-legacy",
    "workspace-1",
    "workspace_agent",
    "Greeting",
    "*/5 * * * *",
    "Say hello every 5 minutes.",
    "Say hello every 5 minutes.",
    1,
    JSON.stringify({ channel: "session_run" }),
    "{}",
    null,
    null,
    0,
    null,
    null,
    "2026-01-01T00:00:00+00:00",
    "2026-01-01T00:00:00+00:00"
  );
  db.close();

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  const listed = store.listCronjobs({ workspaceId: "workspace-1" });
  store.close();

  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, "job-legacy");
  assert.equal(listed[0]?.teammateId, "general");
  assert.equal(fs.existsSync(workspaceDbPath), true);

  const workspaceDb = new Database(workspaceDbPath, { readonly: true });
  const mirrored = workspaceDb
    .prepare<[string], { id: string }>("SELECT id FROM cronjobs WHERE id = ? LIMIT 1")
    .get("job-legacy");
  workspaceDb.close();

  assert.equal(mirrored?.id, "job-legacy");
});

test("workspace runtime DB skips repeated legacy backfill once it already has data", () => {
  const root = makeTempDir("hb-state-store-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");

  const initialStore = new RuntimeStateStore({ dbPath, workspaceRoot });
  initialStore.createWorkspace({
    workspaceId: "workspace-1",
    name: "Legacy",
    harness: "pi",
    status: "active"
  });
  initialStore.close();

  const legacyDb = new Database(dbPath);
  legacyDb.exec(`
    CREATE TABLE cronjobs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        initiated_by TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        cron TEXT NOT NULL,
        description TEXT NOT NULL,
        instruction TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        delivery TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        last_run_at TEXT,
        next_run_at TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        last_status TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
  `);
  legacyDb.prepare(`
    INSERT INTO cronjobs (
      id, workspace_id, initiated_by, name, cron, description, instruction, enabled, delivery, metadata,
      last_run_at, next_run_at, run_count, last_status, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "job-legacy",
    "workspace-1",
    "workspace_agent",
    "Greeting",
    "*/5 * * * *",
    "Say hello every 5 minutes.",
    "Say hello every 5 minutes.",
    1,
    JSON.stringify({ channel: "session_run" }),
    "{}",
    null,
    null,
    0,
    null,
    null,
    "2026-01-01T00:00:00+00:00",
    "2026-01-01T00:00:00+00:00"
  );
  legacyDb.close();

  const firstOpen = new RuntimeStateStore({ dbPath, workspaceRoot });
  let firstBackfillCalls = 0;
  const firstOpenInternals = firstOpen as unknown as {
    backfillWorkspaceRuntimeDbFromLegacyRuntimeDb: (
      db: Database.Database,
      legacy: Database.Database,
      workspaceId: string,
    ) => void;
  };
  const originalFirstBackfill = firstOpenInternals.backfillWorkspaceRuntimeDbFromLegacyRuntimeDb.bind(firstOpen);
  firstOpenInternals.backfillWorkspaceRuntimeDbFromLegacyRuntimeDb = (db, legacy, workspaceId) => {
    firstBackfillCalls += 1;
    return originalFirstBackfill(db, legacy, workspaceId);
  };
  const firstListed = firstOpen.listCronjobs({ workspaceId: "workspace-1" });
  firstOpen.close();

  assert.equal(firstListed.length, 1);
  assert.equal(firstBackfillCalls, 1);

  const reopened = new RuntimeStateStore({ dbPath, workspaceRoot });
  let repeatedBackfillCalls = 0;
  const reopenedInternals = reopened as unknown as {
    backfillWorkspaceRuntimeDbFromLegacyRuntimeDb: (
      db: Database.Database,
      legacy: Database.Database,
      workspaceId: string,
    ) => void;
  };
  const originalRepeatedBackfill = reopenedInternals.backfillWorkspaceRuntimeDbFromLegacyRuntimeDb.bind(reopened);
  reopenedInternals.backfillWorkspaceRuntimeDbFromLegacyRuntimeDb = (db, legacy, workspaceId) => {
    repeatedBackfillCalls += 1;
    return originalRepeatedBackfill(db, legacy, workspaceId);
  };
  const secondListed = reopened.listCronjobs({ workspaceId: "workspace-1" });
  reopened.close();

  assert.equal(secondListed.length, 1);
  assert.equal(repeatedBackfillCalls, 0);
});

test("workspace runtime DB reruns legacy backfill for populated pre-marker databases", () => {
  const root = makeTempDir("hb-state-store-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");

  const initialStore = new RuntimeStateStore({ dbPath, workspaceRoot });
  initialStore.createWorkspace({
    workspaceId: "workspace-1",
    name: "Legacy",
    harness: "pi",
    status: "active"
  });
  initialStore.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-1",
    role: "user",
    text: "hello",
    createdAt: "2026-01-01T00:00:00+00:00"
  });
  initialStore.close();

  const workspaceDbPath = workspaceRuntimeDbFile(workspaceRoot, "workspace-1");
  const workspaceDb = new Database(workspaceDbPath);
  workspaceDb
    .prepare("DELETE FROM workspace_runtime_metadata WHERE key = ?")
    .run("legacy_workspace_backfill_v1_complete");
  workspaceDb.close();

  const legacyDb = new Database(dbPath);
  legacyDb.exec(`
    CREATE TABLE task_proposals (
        proposal_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        task_name TEXT NOT NULL,
        task_prompt TEXT NOT NULL,
        task_generation_rationale TEXT NOT NULL,
        proposal_source TEXT NOT NULL DEFAULT 'proactive',
        source_event_ids TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'not_reviewed',
        accepted_session_id TEXT,
        accepted_input_id TEXT,
        accepted_at TEXT
    );
  `);
  legacyDb.prepare(`
    INSERT INTO task_proposals (
      proposal_id,
      workspace_id,
      task_name,
      task_prompt,
      task_generation_rationale,
      proposal_source,
      source_event_ids,
      created_at,
      state,
      accepted_session_id,
      accepted_input_id,
      accepted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "proposal-legacy",
    "workspace-1",
    "Legacy follow-up",
    "Continue the pending task.",
    "Recovered from the legacy runtime database.",
    "proactive",
    "[]",
    "2026-01-01T00:00:00+00:00",
    "not_reviewed",
    null,
    null,
    null
  );
  legacyDb.close();

  const reopened = new RuntimeStateStore({ dbPath, workspaceRoot });
  let backfillCalls = 0;
  const reopenedInternals = reopened as unknown as {
    backfillWorkspaceRuntimeDbFromLegacyRuntimeDb: (
      db: Database.Database,
      legacy: Database.Database,
      workspaceId: string,
    ) => void;
  };
  const originalBackfill =
    reopenedInternals.backfillWorkspaceRuntimeDbFromLegacyRuntimeDb.bind(
      reopened,
    );
  reopenedInternals.backfillWorkspaceRuntimeDbFromLegacyRuntimeDb = (
    db,
    legacy,
    workspaceId,
  ) => {
    backfillCalls += 1;
    return originalBackfill(db, legacy, workspaceId);
  };
  const proposals = reopened.listTaskProposals({ workspaceId: "workspace-1" });
  reopened.close();

  assert.equal(backfillCalls, 1);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0]?.proposalId, "proposal-legacy");

  const verifiedWorkspaceDb = new Database(workspaceDbPath, { readonly: true });
  const marker = verifiedWorkspaceDb
    .prepare<[string], { value?: string }>(
      "SELECT value FROM workspace_runtime_metadata WHERE key = ? LIMIT 1",
    )
    .get("legacy_workspace_backfill_v1_complete");
  const mirroredProposal = verifiedWorkspaceDb
    .prepare<[string], { proposal_id?: string }>(
      "SELECT proposal_id FROM task_proposals WHERE proposal_id = ? LIMIT 1",
    )
    .get("proposal-legacy");
  verifiedWorkspaceDb.close();

  assert.equal(marker?.value, "complete");
  assert.equal(mirroredProposal?.proposal_id, "proposal-legacy");
});

test("runtime notifications round trip supports create, list, update, get, and dismiss", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const created = store.createRuntimeNotification({
    workspaceId: "workspace-1",
    cronjobId: "cronjob-1",
    sourceType: "cronjob",
    sourceLabel: "Workspace 1",
    title: "Drink Water",
    message: "Time to drink water.",
    level: "info",
    priority: "high"
  });
  const listed = store.listRuntimeNotifications({ workspaceId: "workspace-1" });
  const fetched = store.getRuntimeNotification({ workspaceId: "workspace-1", notificationId: created.id });
  const updated = store.updateRuntimeNotification({
    workspaceId: "workspace-1",
    notificationId: created.id,
    state: "read"
  });
  const dismissed = store.updateRuntimeNotification({
    workspaceId: "workspace-1",
    notificationId: created.id,
    state: "dismissed"
  });
  const listedWithoutDismissed = store.listRuntimeNotifications({
    workspaceId: "workspace-1"
  });
  const listedIncludingDismissed = store.listRuntimeNotifications({
    workspaceId: "workspace-1",
    includeDismissed: true
  });

  assert.equal(listed.length, 1);
  assert.ok(fetched);
  assert.equal(fetched.priority, "high");
  assert.ok(updated);
  assert.equal(updated.state, "read");
  assert.ok(updated.readAt);
  assert.ok(dismissed);
  assert.equal(dismissed.state, "dismissed");
  assert.ok(dismissed.dismissedAt);
  assert.equal(listedWithoutDismissed.length, 0);
  assert.equal(listedIncludingDismissed.length, 1);
  store.close();
});

test("runtime notifications sort by priority before recency", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  store.createRuntimeNotification({
    workspaceId: "workspace-1",
    title: "Normal",
    message: "Normal priority",
    priority: "normal",
    createdAt: "2026-01-01T10:00:00.000Z"
  });
  store.createRuntimeNotification({
    workspaceId: "workspace-1",
    title: "Critical",
    message: "Critical priority",
    priority: "critical",
    createdAt: "2026-01-01T09:00:00.000Z"
  });
  store.createRuntimeNotification({
    workspaceId: "workspace-1",
    title: "High",
    message: "High priority",
    priority: "high",
    createdAt: "2026-01-01T11:00:00.000Z"
  });

  const listed = store.listRuntimeNotifications({ workspaceId: "workspace-1" });

  assert.deepEqual(
    listed.map((item) => item.title),
    ["Critical", "High", "Normal"]
  );
  assert.deepEqual(
    listed.map((item) => item.priority),
    ["critical", "high", "normal"]
  );
  store.close();
});

test("task proposals round trip supports create, list, unreviewed, get, and state update", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const proposal = store.createTaskProposal({
    proposalId: "proposal-1",
    workspaceId: "workspace-1",
    taskName: "Follow up",
    taskPrompt: "Write a follow-up message",
    taskGenerationRationale: "User has not replied",
    sourceEventIds: ["evt-1"],
    createdAt: "2026-01-01T00:00:00+00:00"
  });
  const listed = store.listTaskProposals({ workspaceId: "workspace-1" });
  const unreviewed = store.listUnreviewedTaskProposals({ workspaceId: "workspace-1" });
  const fetched = store.getTaskProposal({ workspaceId: "workspace-1", proposalId: "proposal-1" });
  const updated = store.updateTaskProposalState({
    workspaceId: "workspace-1",
    proposalId: "proposal-1",
    state: "accepted"
  });

  assert.equal(proposal.proposalId, "proposal-1");
  assert.equal(proposal.proposalSource, "proactive");
  assert.equal(listed.length, 1);
  assert.equal(unreviewed.length, 1);
  assert.ok(fetched);
  assert.equal(fetched?.proposalSource, "proactive");
  assert.ok(updated);
  assert.equal(updated.state, "accepted");
  store.close();
});

test("task proposal acceptance fields and child session metadata round trip", () => {
  const root = makeTempDir("hb-state-store-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });

  const session = store.ensureSession({
    workspaceId: "workspace-1",
    sessionId: "proposal-session-1",
    kind: "task_proposal",
    title: "Follow up",
    parentSessionId: "session-main",
    sourceProposalId: "proposal-1",
    createdBy: "workspace_user"
  });
  store.createTaskProposal({
    proposalId: "proposal-1",
    workspaceId: "workspace-1",
    taskName: "Follow up",
    taskPrompt: "Write a follow-up message",
    taskGenerationRationale: "User has not replied",
    sourceEventIds: ["evt-1"],
    createdAt: "2026-01-01T00:00:00+00:00"
  });

  const sessions = store.listSessions({ workspaceId: "workspace-1" });
  const updated = store.updateTaskProposal({
    workspaceId: "workspace-1",
    proposalId: "proposal-1",
    fields: {
      state: "accepted",
      acceptedSessionId: session.sessionId,
      acceptedInputId: "input-1",
      acceptedAt: "2026-01-01T01:00:00+00:00"
    }
  });

  assert.equal(session.kind, "subagent");
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.kind, "subagent");
  assert.equal(sessions[0]?.parentSessionId, "session-main");
  assert.equal(sessions[0]?.sourceProposalId, "proposal-1");
  assert.ok(updated);
  assert.equal(updated.acceptedSessionId, "proposal-session-1");
  assert.equal(updated.acceptedInputId, "input-1");
  assert.equal(updated.acceptedAt, "2026-01-01T01:00:00+00:00");
  store.close();

  const legacyDb = new Database(workspaceRuntimeDbFile(workspaceRoot, "workspace-1"));
  legacyDb
    .prepare("UPDATE agent_sessions SET kind = ? WHERE workspace_id = ? AND session_id = ?")
    .run("task_proposal", "workspace-1", "proposal-session-1");
  legacyDb.close();

  const reopened = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  const migratedSession = reopened.getSession({
    workspaceId: "workspace-1",
    sessionId: "proposal-session-1"
  });
  const migratedDb = new Database(workspaceRuntimeDbFile(workspaceRoot, "workspace-1"), { readonly: true });
  const storedKind = migratedDb
    .prepare("SELECT kind FROM agent_sessions WHERE workspace_id = ? AND session_id = ? LIMIT 1")
    .get("workspace-1", "proposal-session-1") as { kind: string };

  assert.equal(migratedSession?.kind, "subagent");
  assert.equal(storedKind.kind, "subagent");
  migratedDb.close();
  reopened.close();
});

test("issues round trip creates persistent sessions with a workspace-derived prefix", () => {
  const root = makeTempDir("hb-state-store-issues-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Issue Workspace",
    harness: "pi",
    status: "active",
  });

  const general = store.ensureGeneralTeammate("workspace-1");
  const first = store.createIssue({
    workspaceId: "workspace-1",
    title: "Implement dashboard",
    description: "Build the initial dashboard surface.",
    status: "todo",
    priority: "high",
    assigneeTeammateId: general.teammateId,
    attachments: [
      {
        id: "attachment-1",
        kind: "file",
        name: "brief.md",
        mimeType: "text/markdown",
        sizeBytes: 128,
        workspacePath: "docs/brief.md",
      },
    ],
  });
  const second = store.createIssue({
    workspaceId: "workspace-1",
    title: "Instrument homepage metrics",
    status: "backlog",
  });
  const listed = store.listIssues({ workspaceId: "workspace-1" });
  const fetchedBySession = store.getIssueBySessionId({
    workspaceId: "workspace-1",
    sessionId: first.sessionId,
  });
  const updated = store.updateIssue({
    workspaceId: "workspace-1",
    issueId: first.issueId,
    fields: {
      title: "Implement workspace dashboard",
      status: "done",
      priority: "critical",
    }
  });
  const updatedSession = store.getSession({
    workspaceId: "workspace-1",
    sessionId: first.sessionId,
  });

  assert.equal(first.issueId, "ISS-1");
  assert.equal(first.issueNumber, 1);
  assert.equal(first.status, "todo");
  assert.equal(first.priority, "high");
  assert.equal(first.attachments.length, 1);
  assert.equal(second.issueId, "ISS-2");
  assert.equal(second.issueNumber, 2);
  assert.equal(listed.length, 2);
  assert.equal(fetchedBySession?.issueId, first.issueId);
  assert.equal(updated?.status, "done");
  assert.equal(updated?.priority, "critical");
  assert.ok(updated?.completedAt);
  assert.equal(updatedSession?.title, "Implement workspace dashboard");
  store.close();
});

test("archiving a custom teammate unassigns issues and cancels linked runs", () => {
  const root = makeTempDir("hb-state-store-teammates-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Teammate Workspace",
    harness: "pi",
    status: "active",
  });

  const custom = store.createTeammate({
    workspaceId: "workspace-1",
    name: "Coder",
    instructions: "Own implementation tickets.",
  });
  const issue = store.createIssue({
    workspaceId: "workspace-1",
    title: "Ship issue board",
    status: "in_progress",
    assigneeTeammateId: custom.teammateId,
    activeSubagentId: "run-1",
  });
  store.createSubagentRun({
    subagentId: "run-1",
    workspaceId: "workspace-1",
    originMainSessionId: issue.sessionId,
    ownerMainSessionId: issue.sessionId,
    childSessionId: "subagent-session-1",
    goal: "Ship issue board",
    status: "running",
    issueId: issue.issueId,
    teammateId: custom.teammateId,
  });

  const archived = store.archiveTeammate({
    workspaceId: "workspace-1",
    teammateId: custom.teammateId,
  });
  const updatedIssue = store.getIssue({
    workspaceId: "workspace-1",
    issueId: issue.issueId,
  });
  const updatedRun = store.getSubagentRun({
    workspaceId: "workspace-1",
    subagentId: "run-1",
  });
  const visibleTeammates = store.listTeammates({ workspaceId: "workspace-1" });

  assert.equal(archived?.status, "archived");
  assert.ok(archived?.archivedAt);
  assert.equal(updatedIssue?.status, "todo");
  assert.equal(updatedIssue?.assigneeTeammateId, null);
  assert.equal(updatedIssue?.activeSubagentId, null);
  assert.equal(updatedRun?.status, "cancelled");
  assert.equal(visibleTeammates.some((record) => record.teammateId === custom.teammateId), false);
  assert.equal(visibleTeammates[0]?.teammateId, "general");
  store.close();
});

test("teammate capability profiles persist and update cleanly", () => {
  const root = makeTempDir("hb-state-store-teammate-capabilities-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Teammate Capability Workspace",
    harness: "pi",
    status: "active",
  });

  const general = store.ensureGeneralTeammate("workspace-1");
  const teammate = store.createTeammate({
    workspaceId: "workspace-1",
    name: "Research",
    instructions: "Own research, latest-info, and vendor comparison tasks.",
    capabilityProfile: {
      summary: "Best for live research, comparisons, and vendor analysis.",
      capabilities: ["research", "comparison", "vendors"],
      preferredTools: ["web_search", "browser_get_state"],
    },
  });
  const updated = store.updateTeammate({
    workspaceId: "workspace-1",
    teammateId: teammate.teammateId,
    fields: {
      capabilityProfile: {
        summary: "Best for live research, vendor analysis, and sourcing.",
        capabilities: ["research", "vendors", "sourcing"],
        preferredTools: ["web_search"],
      },
    },
  });

  assert.match(general.capabilityProfile.summary ?? "", /Fallback executor/i);
  assert.match(
    general.instructions ?? "",
    /produce a report artifact instead of packing the full findings into the final session message/i,
  );
  assert.deepEqual(general.capabilityProfile.capabilities, [
    "generalist",
    "implementation",
    "research",
    "triage",
    "fallback",
  ]);
  assert.deepEqual(teammate.capabilityProfile.capabilities, [
    "research",
    "comparison",
    "vendors",
  ]);
  assert.deepEqual(teammate.capabilityProfile.preferredTools, [
    "web_search",
    "browser_get_state",
  ]);
  assert.equal(
    updated?.capabilityProfile.summary,
    "Best for live research, vendor analysis, and sourcing.",
  );
  assert.deepEqual(updated?.capabilityProfile.capabilities, [
    "research",
    "vendors",
    "sourcing",
  ]);
  assert.deepEqual(updated?.capabilityProfile.preferredTools, ["web_search"]);
  store.close();
});

test("legacy teammate tables migrate missing kind and status columns", () => {
  const root = makeTempDir("hb-state-store-teammate-legacy-schema-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Legacy Teammates Workspace",
    harness: "pi",
    status: "active",
  });
  store.close();

  const runtimeDbPath = workspaceRuntimeDbFile(workspaceRoot, "workspace-1");
  fs.rmSync(runtimeDbPath, { force: true });

  const legacyDb = new Database(runtimeDbPath);
  legacyDb.exec(`
    CREATE TABLE teammates (
      teammate_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      instructions TEXT,
      skills_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const createdAt = utcNowIso();
  legacyDb
    .prepare(`
      INSERT INTO teammates (
        teammate_id,
        workspace_id,
        name,
        instructions,
        skills_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      "general",
      "workspace-1",
      "General",
      "Legacy fallback executor.",
      "[]",
      createdAt,
      createdAt,
    );
  legacyDb
    .prepare(`
      INSERT INTO teammates (
        teammate_id,
        workspace_id,
        name,
        instructions,
        skills_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      "teammate-1",
      "workspace-1",
      "Coder",
      "Own implementation tasks.",
      "[]",
      createdAt,
      createdAt,
    );
  legacyDb.close();

  const reopened = new RuntimeStateStore({ dbPath, workspaceRoot });
  const teammates = reopened.listTeammates({
    workspaceId: "workspace-1",
    includeArchived: true,
  });

  assert.equal(teammates.length, 2);
  assert.equal(teammates[0]?.teammateId, "general");
  assert.equal(teammates[0]?.kind, "system");
  assert.equal(teammates[0]?.status, "active");
  assert.deepEqual(
    teammates[0]?.capabilityProfile.preferredTools,
    [],
  );
  assert.equal(teammates[1]?.teammateId, "teammate-1");
  assert.equal(teammates[1]?.kind, "custom");
  assert.equal(teammates[1]?.status, "active");

  const migratedDb = new Database(runtimeDbPath, { readonly: true });
  const teammateColumns = new Set<string>(
    (migratedDb.prepare("PRAGMA table_info(teammates)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  const generalRow = migratedDb
    .prepare<[string], { kind: string; status: string; capability_profile_json: string }>(`
      SELECT kind, status, capability_profile_json
      FROM teammates
      WHERE teammate_id = ?
      LIMIT 1
    `)
    .get("general");
  migratedDb.close();

  assert.equal(teammateColumns.has("kind"), true);
  assert.equal(teammateColumns.has("status"), true);
  assert.equal(teammateColumns.has("archived_at"), true);
  assert.equal(teammateColumns.has("capability_profile_json"), true);
  assert.ok(generalRow);
  assert.equal(generalRow.kind, "system");
  assert.equal(generalRow.status, "active");
  assert.match(generalRow.capability_profile_json, /preferredTools/i);
  reopened.close();
});

test("workspace runtime schema upgrades legacy tables before creating late indexes", () => {
  const root = makeTempDir("hb-state-store-legacy-runtime-indexes-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Legacy Runtime Workspace",
    harness: "pi",
    status: "active",
  });
  store.close();

  const runtimeDbPath = workspaceRuntimeDbFile(workspaceRoot, "workspace-1");
  fs.rmSync(runtimeDbPath, { force: true });

  const legacyDb = new Database(runtimeDbPath);
  legacyDb.exec(`
    CREATE TABLE conversation_bindings (
      binding_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'main_session',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE main_session_event_queue (
      event_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      owner_main_session_id TEXT NOT NULL,
      origin_main_session_id TEXT NOT NULL,
      subagent_id TEXT,
      event_type TEXT NOT NULL,
      delivery_bucket TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload TEXT NOT NULL DEFAULT '{}',
      earliest_deliver_at TEXT,
      latest_deliver_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE subagent_runs (
      subagent_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      parent_session_id TEXT,
      parent_input_id TEXT,
      origin_main_session_id TEXT NOT NULL,
      owner_main_session_id TEXT NOT NULL,
      child_session_id TEXT NOT NULL,
      title TEXT,
      goal TEXT NOT NULL,
      context TEXT,
      source_type TEXT,
      source_id TEXT,
      proposal_id TEXT,
      cronjob_id TEXT,
      retry_of_subagent_id TEXT,
      tool_profile TEXT NOT NULL DEFAULT '{}',
      requested_model TEXT,
      effective_model TEXT,
      status TEXT NOT NULL,
      summary TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, child_session_id)
    );
    CREATE TABLE outputs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      output_type TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      module_id TEXT,
      module_resource_id TEXT,
      file_path TEXT,
      html_content TEXT,
      session_id TEXT,
      artifact_id TEXT,
      folder_id TEXT,
      platform TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE evolve_skill_candidates (
      candidate_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      input_id TEXT NOT NULL
    );
    CREATE TABLE memory_update_proposals (
      proposal_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      input_id TEXT NOT NULL,
      proposal_kind TEXT NOT NULL,
      target_key TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  legacyDb.close();

  const reopened = new RuntimeStateStore({ dbPath, workspaceRoot });
  const teammates = reopened.listTeammates({ workspaceId: "workspace-1" });
  assert.equal(teammates[0]?.teammateId, "general");
  reopened.close();

  const migratedDb = new Database(runtimeDbPath, { readonly: true });
  const subagentRunColumns = new Set<string>(
    (migratedDb.prepare("PRAGMA table_info(subagent_runs)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  const outputColumns = new Set<string>(
    (migratedDb.prepare("PRAGMA table_info(outputs)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  const evolveColumns = new Set<string>(
    (migratedDb.prepare("PRAGMA table_info(evolve_skill_candidates)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  const memoryUpdateColumns = new Set<string>(
    (migratedDb.prepare("PRAGMA table_info(memory_update_proposals)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  const subagentRunIndexes = new Set<string>(
    (migratedDb.prepare("PRAGMA index_list(subagent_runs)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  const outputIndexes = new Set<string>(
    (migratedDb.prepare("PRAGMA index_list(outputs)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  const evolveIndexes = new Set<string>(
    (migratedDb.prepare("PRAGMA index_list(evolve_skill_candidates)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  const memoryUpdateIndexes = new Set<string>(
    (migratedDb.prepare("PRAGMA index_list(memory_update_proposals)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  migratedDb.close();

  assert.equal(subagentRunColumns.has("issue_id"), true);
  assert.equal(subagentRunColumns.has("teammate_id"), true);
  assert.equal(outputColumns.has("input_id"), true);
  assert.equal(evolveColumns.has("task_proposal_id"), true);
  assert.equal(evolveColumns.has("status"), true);
  assert.equal(evolveColumns.has("created_at"), true);
  assert.equal(memoryUpdateColumns.has("state"), true);
  assert.equal(memoryUpdateColumns.has("updated_at"), true);
  assert.equal(subagentRunIndexes.has("idx_subagent_runs_issue_created"), true);
  assert.equal(subagentRunIndexes.has("idx_subagent_runs_teammate_status_updated"), true);
  assert.equal(outputIndexes.has("idx_outputs_session_input_created"), true);
  assert.equal(evolveIndexes.has("idx_evolve_skill_candidates_workspace_status_created"), true);
  assert.equal(evolveIndexes.has("idx_evolve_skill_candidates_task_proposal"), true);
  assert.equal(memoryUpdateIndexes.has("idx_memory_update_proposals_workspace_state_created"), true);
});

test("listSessions preserves millisecond ordering for latest session selection", async () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  store.ensureSession({
    workspaceId: "workspace-1",
    sessionId: "session-older",
    kind: "main_session",
    title: "Older"
  });
  await sleep(5);
  store.ensureSession({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    kind: "main_session",
    title: "Main"
  });

  const sessions = store.listSessions({ workspaceId: "workspace-1" });

  assert.equal(sessions[0]?.sessionId, "session-main");
  assert.equal(sessions[1]?.sessionId, "session-older");
  store.close();
});

test("task proposal round trip preserves explicit evolve source", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const proposal = store.createTaskProposal({
    proposalId: "proposal-evolve-1",
    workspaceId: "workspace-1",
    taskName: "Review generated skill patch",
    taskPrompt: "Inspect the queued evolve skill patch.",
    taskGenerationRationale: "Evolve flagged a risky patch for review",
    proposalSource: "evolve",
    createdAt: "2026-01-01T00:00:00+00:00"
  });

  assert.equal(proposal.proposalSource, "evolve");
  assert.equal(
    store.getTaskProposal({ workspaceId: "workspace-1", proposalId: "proposal-evolve-1" })?.proposalSource,
    "evolve"
  );
  store.close();
});

test("evolve skill candidates round trip supports create, list, lookup, and update", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  store.ensureSession({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    kind: "main_session",
    title: "Main"
  });

  const created = store.createEvolveSkillCandidate({
    candidateId: "candidate-1",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    kind: "skill_create",
    status: "draft",
    title: "Release verification skill",
    summary: "Reusable release verification workflow.",
    slug: "release-verification",
    skillPath: "workspace/workspace-1/evolve/skills/candidate-1/SKILL.md",
    contentFingerprint: "fp-1",
    confidence: 0.91,
    evaluationNotes: "Looks reusable.",
    sourceTurnInputIds: ["input-1"],
  });

  const patchCandidate = store.createEvolveSkillCandidate({
    candidateId: "candidate-2",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-2",
    kind: "skill_patch",
    status: "draft",
    title: "Release verification patch",
    summary: "Update the release verification skill with a build step.",
    slug: "release-verification",
    skillPath: "workspace/workspace-1/evolve/skills/candidate-2/SKILL.md",
    contentFingerprint: "fp-2",
    confidence: 0.88,
    evaluationNotes: "Existing skill is stale.",
    sourceTurnInputIds: ["input-2"],
  });
  const fetched = store.getEvolveSkillCandidate({ workspaceId: "workspace-1", candidateId: "candidate-1" });
  const listed = store.listEvolveSkillCandidates({ workspaceId: "workspace-1" });
  const updated = store.updateEvolveSkillCandidate({
    workspaceId: "workspace-1",
    candidateId: "candidate-1",
    fields: {
      taskProposalId: "proposal-1",
      status: "proposed",
      proposedAt: "2026-04-10T00:00:00.000Z",
    }
  });

  assert.equal(created.kind, "skill_create");
  assert.equal(created.status, "draft");
  assert.equal(created.slug, "release-verification");
  assert.equal(patchCandidate.kind, "skill_patch");
  assert.equal(fetched?.candidateId, "candidate-1");
  assert.equal(fetched?.evaluationNotes, "Looks reusable.");
  assert.equal(listed.length, 2);
  assert.equal(updated?.taskProposalId, "proposal-1");
  assert.equal(updated?.status, "proposed");
  assert.equal(
    store.getEvolveSkillCandidateByTaskProposalId({
      workspaceId: "workspace-1",
      proposalId: "proposal-1"
    })?.candidateId,
    "candidate-1"
  );
  store.close();
});

test("memory update proposals round trip supports create list filter get and accept metadata", () => {
  const root = makeTempDir("hb-state-store-memory-proposals-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  store.ensureSession({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    kind: "main_session",
    title: "Main"
  });
  const created = store.createMemoryUpdateProposal({
    proposalId: "memory-proposal-1",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    proposalKind: "preference",
    targetKey: "response-style",
    title: "Response style preference",
    summary: "Prefer concise responses.",
    payload: {
      preference_type: "response_style",
      style: "concise",
    },
    evidence: "Please keep your responses concise.",
    confidence: 0.99,
    sourceMessageId: "user-input-1",
    createdAt: "2026-04-03T10:00:00.000Z"
  });

  const listed = store.listMemoryUpdateProposals({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    limit: 10,
    offset: 0
  });
  const fetched = store.getMemoryUpdateProposal({
    workspaceId: "workspace-1",
    proposalId: "memory-proposal-1"
  });
  const accepted = store.updateMemoryUpdateProposal({
    workspaceId: "workspace-1",
    proposalId: "memory-proposal-1",
    fields: {
      summary: "Prefer concise responses.",
      state: "accepted",
      persistedMemoryId: "user-preference:response-style",
      acceptedAt: "2026-04-03T10:01:00.000Z",
      dismissedAt: null
    }
  });

  assert.equal(created.state, "pending");
  assert.equal(listed.length, 1);
  assert.ok(fetched);
  assert.deepEqual(fetched?.payload, {
    preference_type: "response_style",
    style: "concise",
  });
  assert.equal(accepted?.state, "accepted");
  assert.equal(accepted?.persistedMemoryId, "user-preference:response-style");
  assert.equal(accepted?.acceptedAt, "2026-04-03T10:01:00.000Z");
  assert.deepEqual(
    store.listMemoryUpdateProposals({
      workspaceId: "workspace-1",
      state: "accepted",
      limit: 10,
      offset: 0
    }).map((proposal) => proposal.proposalId),
    ["memory-proposal-1"]
  );

  store.close();
});

test("allocateAppPort assigns sequential ports starting from 38080", () => {
  const root = makeTempDir("hb-store-ports-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "test.db"),
    workspaceRoot: path.join(root, "workspace"),
    portInUseProbe: () => false,
  });

  const p1 = store.allocateAppPort({ workspaceId: "ws-1", appId: "gmail" });
  const p2 = store.allocateAppPort({ workspaceId: "ws-1", appId: "sheets" });

  assert.equal(p1.port, 38080);
  assert.equal(p2.port, 38081);
  assert.equal(p1.appId, "gmail");
  assert.equal(p2.appId, "sheets");

  store.close();
});

test("allocateAppPort reuses existing port for same app", () => {
  const root = makeTempDir("hb-store-ports-reuse-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "test.db"),
    workspaceRoot: path.join(root, "workspace"),
    portInUseProbe: () => false,
  });

  const p1 = store.allocateAppPort({ workspaceId: "ws-1", appId: "gmail" });
  const p2 = store.allocateAppPort({ workspaceId: "ws-1", appId: "gmail" });

  assert.equal(p1.port, p2.port);

  store.close();
});

test("listAppPorts returns all ports for workspace", () => {
  const root = makeTempDir("hb-store-ports-list-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "test.db"),
    workspaceRoot: path.join(root, "workspace"),
    portInUseProbe: () => false,
  });

  store.allocateAppPort({ workspaceId: "ws-1", appId: "gmail" });
  store.allocateAppPort({ workspaceId: "ws-1", appId: "sheets" });
  store.allocateAppPort({ workspaceId: "ws-2", appId: "github" });

  const ws1Ports = store.listAppPorts({ workspaceId: "ws-1" });
  assert.equal(ws1Ports.length, 2);

  const ws2Ports = store.listAppPorts({ workspaceId: "ws-2" });
  assert.equal(ws2Ports.length, 1);

  store.close();
});

test("deleteAppPort removes port and frees it for reuse", () => {
  const root = makeTempDir("hb-store-ports-delete-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "test.db"),
    workspaceRoot: path.join(root, "workspace"),
    portInUseProbe: () => false,
  });

  const p1 = store.allocateAppPort({ workspaceId: "ws-1", appId: "gmail" });
  store.deleteAppPort({ workspaceId: "ws-1", appId: "gmail" });

  const deleted = store.getAppPort({ workspaceId: "ws-1", appId: "gmail" });
  assert.equal(deleted, null);

  // Port should be available again
  const p2 = store.allocateAppPort({ workspaceId: "ws-1", appId: "twitter" });
  assert.equal(p2.port, p1.port);

  store.close();
});

test("listAllAppPorts keeps preserved deleted workspace ports visible after restart", () => {
  const root = makeTempDir("hb-store-ports-deleted-");
  const customRoot = makeTempDir("hb-store-ports-deleted-custom-");
  const customPath = path.join(customRoot, "kept-workspace");
  const dbPath = path.join(root, "test.db");
  const workspaceRoot = path.join(root, "workspace");

  const store = new RuntimeStateStore({ dbPath, workspaceRoot, portInUseProbe: () => false });
  store.createWorkspace({
    workspaceId: "ws-deleted",
    name: "Deleted",
    harness: "pi",
    workspacePath: customPath,
  });
  const deletedPort = store.allocateAppPort({
    workspaceId: "ws-deleted",
    appId: "gmail",
  });
  store.deleteWorkspace("ws-deleted");
  store.close();

  const reopened = new RuntimeStateStore({ dbPath, workspaceRoot, portInUseProbe: () => false });
  const preservedPorts = reopened.listAllAppPorts();
  assert.deepEqual(
    preservedPorts.map((record) => ({
      workspaceId: record.workspaceId,
      appId: record.appId,
      port: record.port,
    })),
    [
      {
        workspaceId: "ws-deleted",
        appId: "gmail",
        port: deletedPort.port,
      },
    ],
  );

  reopened.createWorkspace({
    workspaceId: "ws-new",
    name: "New",
    harness: "pi",
  });
  const nextPort = reopened.allocateAppPort({
    workspaceId: "ws-new",
    appId: "twitter",
  });
  assert.equal(nextPort.port, deletedPort.port + 1);
  reopened.close();
});

test("allocateAppPort skips ports that are already listening according to the probe", () => {
  const root = makeTempDir("hb-store-ports-skip-listening-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "test.db"),
    workspaceRoot: path.join(root, "workspace"),
    portInUseProbe: (port) => port === 38080,
  });

  const first = store.allocateAppPort({ workspaceId: "ws-1", appId: "gmail" });
  const second = store.allocateAppPort({ workspaceId: "ws-1", appId: "sheets" });

  assert.equal(first.port, 38081);
  assert.equal(second.port, 38082);

  store.close();
});

test("app_catalog upserts and lists entries for a given source", () => {
  const root = makeTempDir("hb-store-catalog-upsert-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "test.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  store.upsertAppCatalogEntry({
    appId: "twitter",
    source: "marketplace",
    name: "Twitter / X",
    description: "Post tweets",
    icon: "https://example.test/twitter.svg",
    category: "social",
    tags: ["social media"],
    version: "v0.1.0",
    archiveUrl: "https://example.test/twitter-module-darwin-arm64.tar.gz",
    archivePath: null,
    target: "darwin-arm64",
    cachedAt: "2026-04-09T00:00:00Z",
    providerId: "twitter",
    credentialSource: "platform",
  });

  const entries = store.listAppCatalogEntries({ source: "marketplace" });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].appId, "twitter");
  assert.equal(entries[0].source, "marketplace");
  assert.deepEqual(entries[0].tags, ["social media"]);
  assert.equal(entries[0].archiveUrl, "https://example.test/twitter-module-darwin-arm64.tar.gz");

  store.close();
});

test("app_catalog clearAppCatalogSource wipes only the given source", () => {
  const root = makeTempDir("hb-store-catalog-clear-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "test.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const base = {
    name: "Sample",
    description: null,
    icon: null,
    category: null,
    tags: [] as string[],
    version: null,
    target: "darwin-arm64",
    cachedAt: "2026-04-09T00:00:00Z",
    providerId: null,
    credentialSource: null,
  };
  store.upsertAppCatalogEntry({
    ...base, appId: "twitter", source: "marketplace",
    archiveUrl: "https://a.test/x.tar.gz", archivePath: null,
  });
  store.upsertAppCatalogEntry({
    ...base, appId: "twitter", source: "local",
    archiveUrl: null, archivePath: "/tmp/x.tar.gz",
  });

  const cleared = store.clearAppCatalogSource("marketplace");
  assert.equal(cleared, 1);
  const remaining = store.listAppCatalogEntries();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].source, "local");

  store.close();
});

test("app_catalog deleteAppCatalogEntry removes a single row", () => {
  const root = makeTempDir("hb-store-catalog-delete-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "test.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  store.upsertAppCatalogEntry({
    appId: "twitter", source: "marketplace", name: "X",
    description: null, icon: null, category: null, tags: [],
    version: "v0.1.0", archiveUrl: "https://a.test", archivePath: null,
    target: "darwin-arm64", cachedAt: "2026-04-09T00:00:00Z",
    providerId: null, credentialSource: null,
  });
  const deleted = store.deleteAppCatalogEntry({ source: "marketplace", appId: "twitter" });
  assert.equal(deleted, true);
  assert.equal(store.listAppCatalogEntries().length, 0);

  store.close();
});

test("app_catalog composite PK allows same appId in both sources", () => {
  const root = makeTempDir("hb-store-catalog-pk-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "test.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  const base = {
    appId: "twitter",
    name: "X",
    description: null,
    icon: null,
    category: null,
    tags: [] as string[],
    version: null,
    target: "darwin-arm64",
    cachedAt: "2026-04-09T00:00:00Z",
    providerId: null,
    credentialSource: null,
  };
  store.upsertAppCatalogEntry({
    ...base, source: "marketplace",
    archiveUrl: "https://a.test/x.tar.gz", archivePath: null,
  });
  store.upsertAppCatalogEntry({
    ...base, source: "local",
    archiveUrl: null, archivePath: "/tmp/x.tar.gz",
  });
  const all = store.listAppCatalogEntries();
  assert.equal(all.length, 2);

  store.close();
});

test("migrateRevertIntegrationConnectionsWorkspace materializes legacy workspace_id rows into bindings then drops the column", () => {
  const root = makeTempDir("hb-state-store-revert-conn-ws-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");

  // Reproduce the on-disk shape from the feat/composio-workspace-scoped-accounts
  // branch: integration_connections has a workspace_id column with data, and
  // the leftover index pointing at it.
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE integration_connections (
      connection_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      workspace_id TEXT,
      account_label TEXT NOT NULL,
      account_external_id TEXT,
      auth_mode TEXT NOT NULL,
      granted_scopes TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      secret_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_integration_connections_workspace_provider
      ON integration_connections (workspace_id, provider_id, updated_at DESC, created_at DESC);
    CREATE TABLE integration_bindings (
      binding_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      integration_key TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, target_type, target_id, integration_key),
      FOREIGN KEY (connection_id) REFERENCES integration_connections(connection_id) ON DELETE RESTRICT
    );
  `);
  const insertConn = legacy.prepare(
    "INSERT INTO integration_connections (connection_id, provider_id, owner_user_id, workspace_id, account_label, account_external_id, auth_mode, granted_scopes, status, secret_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  // (a) bound to ws-A, no pre-existing binding → migration creates one
  insertConn.run("conn-needs-binding", "google", "user-1", "ws-A", "josh@personal.com", null, "oauth_app", "[]", "active", null, "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z");
  // (b) bound to ws-B, but a workspace-default binding already exists → migration must not duplicate
  insertConn.run("conn-already-bound", "github", "user-1", "ws-B", "joshwork", null, "oauth_app", "[]", "active", null, "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z");
  legacy
    .prepare(
      "INSERT INTO integration_bindings (binding_id, workspace_id, target_type, target_id, integration_key, connection_id, is_default, created_at, updated_at) VALUES (?, 'ws-B', 'workspace', 'default', 'github', 'conn-already-bound', 1, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')"
    )
    .run("pre-existing-binding");
  // (c) workspace_id is NULL → migration leaves it alone (no binding needed)
  insertConn.run("conn-already-global", "reddit", "user-1", null, "rd-acct", null, "manual_token", "[]", "active", null, "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z");
  legacy.close();

  const reopened = new RuntimeStateStore({ dbPath, workspaceRoot });

  // Column gone
  const remaining = reopened.listIntegrationConnections().map((r) => r.connectionId).sort();
  assert.deepEqual(remaining, ["conn-already-bound", "conn-already-global", "conn-needs-binding"]);
  for (const id of remaining) {
    const conn = reopened.getIntegrationConnection(id);
    assert.equal(conn !== null, true);
    // workspaceId is no longer on the record type
    assert.equal((conn as unknown as { workspaceId?: string }).workspaceId, undefined);
  }

  // (a) got a fresh default binding for ws-A
  const bindingsA = reopened.listIntegrationBindings({ workspaceId: "ws-A" });
  assert.equal(bindingsA.length, 1);
  assert.equal(bindingsA[0].connectionId, "conn-needs-binding");
  assert.equal(bindingsA[0].integrationKey, "google");
  assert.equal(bindingsA[0].isDefault, true);

  // (b) pre-existing binding preserved, no duplicate
  const bindingsB = reopened.listIntegrationBindings({ workspaceId: "ws-B" });
  assert.equal(bindingsB.length, 1);
  assert.equal(bindingsB[0].bindingId, "pre-existing-binding");

  // Verify the column really is gone at the SQL level
  reopened.close();
  const peek = new Database(dbPath, { readonly: true });
  const cols = (peek.prepare("PRAGMA table_info(integration_connections)").all() as Array<{ name: string }>).map(
    (r) => r.name
  );
  assert.equal(cols.includes("workspace_id"), false, "workspace_id column should be dropped");
  peek.close();
});

test("migrateRevertIntegrationConnectionsWorkspace is a no-op on a fresh DB", () => {
  const root = makeTempDir("hb-state-store-revert-conn-fresh-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");

  // Fresh boot — schema starts without workspace_id, migration must not error.
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  void store.supportsVectorIndex();
  store.close();

  // Reopen — migration runs again on the existing schema, must still no-op.
  const reopened = new RuntimeStateStore({ dbPath, workspaceRoot });
  void reopened.supportsVectorIndex();
  reopened.close();

  const peek = new Database(dbPath, { readonly: true });
  const cols = (peek.prepare("PRAGMA table_info(integration_connections)").all() as Array<{ name: string }>).map(
    (r) => r.name
  );
  assert.equal(cols.includes("workspace_id"), false);
  peek.close();
});

test("semantic memory substrate round trips for interaction and integration categories", () => {
  const root = makeTempDir("hb-state-store-semantic-memory-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Acme",
    harness: "pi",
    status: "active",
  });

  store.replaceSemanticMemoryTree({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:deploy-procedure",
    nodes: [
      {
        nodeId: "interaction-root",
        nodeClass: "semantic",
        nodeKind: "workflow",
        path: "memory/interaction/deploy-procedure/content.md",
        title: "Deploy procedure",
        summary: "Deployment workflow memory.",
        bodySha256: "sha-root",
        childCount: 2,
        metadata: { owner: "ops" },
      },
      {
        nodeId: "interaction-steps",
        nodeClass: "semantic",
        nodeKind: "section",
        path: "memory/interaction/deploy-procedure/steps/content.md",
        title: "Steps",
        summary: "Ordered deployment steps.",
        bodySha256: "sha-steps",
        childCount: 1,
        isMaterialized: true,
        metadata: { partition: "recent" },
      },
      {
        nodeId: "interaction-leaf-1",
        nodeClass: "leaf",
        nodeKind: "leaf",
        sourceLeafId: "leaf-deploy-1",
        path: "memory/interaction/deploy-procedure/steps/step-1.md",
        title: "Run database migration",
        summary: "Apply the production migration before restarting workers.",
        bodySha256: "sha-leaf-1",
        observedAt: "2026-05-24T10:00:00.000Z",
        metadata: { source: "interaction_leaf" },
      },
    ],
    edges: [
      { parentNodeId: "interaction-root", childNodeId: "interaction-steps", position: 1 },
      { parentNodeId: "interaction-steps", childNodeId: "interaction-leaf-1", position: 1 },
    ],
  });
  store.replaceSemanticMemoryRelations({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:deploy-procedure",
    relations: [
      {
        fromNodeId: "interaction-root",
        toNodeId: "interaction-leaf-1",
        relationType: "references",
        metadata: { note: "workflow root references the critical step" },
      },
    ],
  });

  store.replaceSemanticMemoryTree({
    category: "integration",
    treeId: "integration:github:conn-1",
    nodes: [
      {
        nodeId: "integration-root",
        nodeClass: "semantic",
        nodeKind: "repo",
        path: "memory/integration/github/holaboss-ai-holaOS/content.md",
        title: "holaboss-ai/holaOS",
        summary: "Repository memory.",
        bodySha256: "sha-integration-root",
        childCount: 2,
        metadata: { provider: "github" },
      },
      {
        nodeId: "integration-issues",
        nodeClass: "semantic",
        nodeKind: "facet",
        path: "memory/integration/github/holaboss-ai-holaOS/issues/content.md",
        title: "Issues",
        summary: "Open issue snapshots.",
        bodySha256: "sha-integration-issues",
        childCount: 1,
      },
      {
        nodeId: "integration-leaf-1",
        nodeClass: "leaf",
        nodeKind: "leaf",
        sourceLeafId: "issue-101",
        path: "memory/integration/github/holaboss-ai-holaOS/issues/101.md",
        title: "Issue #101",
        summary: "Fix memory browser layout mismatch.",
        bodySha256: "sha-integration-leaf-1",
        observedAt: "2026-05-24T10:30:00.000Z",
        metadata: { source: "integration_leaf" },
      },
    ],
    edges: [
      { parentNodeId: "integration-root", childNodeId: "integration-issues", position: 1 },
      { parentNodeId: "integration-issues", childNodeId: "integration-leaf-1", position: 1 },
    ],
  });
  store.replaceSemanticMemoryRelations({
    category: "integration",
    treeId: "integration:github:conn-1",
    relations: [
      {
        fromNodeId: "integration-root",
        toNodeId: "integration-issues",
        relationType: "tracks",
        metadata: { provider: "github" },
      },
    ],
  });

  const interactionRoot = store.getSemanticMemoryNode({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:deploy-procedure",
    nodeId: "interaction-root",
  });
  assert.ok(interactionRoot);
  assert.equal(interactionRoot.workspaceId, "workspace-1");
  assert.equal(interactionRoot.nodeClass, "semantic");
  assert.equal(interactionRoot.nodeKind, "workflow");
  assert.equal(interactionRoot.childCount, 2);

  const interactionStepChildren = store.listSemanticMemoryChildren({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:deploy-procedure",
    parentNodeId: "interaction-steps",
  });
  assert.deepEqual(
    interactionStepChildren.map((edge) => edge.childNodeId),
    ["interaction-leaf-1"],
  );
  const interactionRelations = store.listSemanticMemoryRelations({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:deploy-procedure",
    fromNodeId: "interaction-root",
  });
  assert.deepEqual(
    interactionRelations.map((relation) => ({
      toNodeId: relation.toNodeId,
      relationType: relation.relationType,
    })),
    [{ toNodeId: "interaction-leaf-1", relationType: "references" }],
  );

  const integrationLeaf = store.getSemanticMemoryNodeByPath({
    category: "integration",
    path: "memory/integration/github/holaboss-ai-holaOS/issues/101.md",
  });
  assert.ok(integrationLeaf);
  assert.equal(integrationLeaf.workspaceId, null);
  assert.equal(integrationLeaf.sourceLeafId, "issue-101");

  const integrationSemanticNodes = store.listSemanticMemoryNodes({
    category: "integration",
    treeId: "integration:github:conn-1",
    nodeClass: "semantic",
  });
  assert.deepEqual(
    integrationSemanticNodes.map((node) => node.nodeId),
    ["integration-root", "integration-issues"],
  );

  store.close();

  const reopened = new RuntimeStateStore({ dbPath, workspaceRoot });
  const reopenedInteractionLeaf = reopened.getSemanticMemoryNode({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:deploy-procedure",
    nodeId: "interaction-leaf-1",
  });
  assert.ok(reopenedInteractionLeaf);
  assert.equal(reopenedInteractionLeaf.sourceLeafId, "leaf-deploy-1");

  const reopenedIntegrationChildren = reopened.listSemanticMemoryChildren({
    category: "integration",
    treeId: "integration:github:conn-1",
    parentNodeId: "integration-root",
  });
  assert.deepEqual(
    reopenedIntegrationChildren.map((edge) => edge.childNodeId),
    ["integration-issues"],
  );
  const reopenedIntegrationRelations = reopened.listSemanticMemoryRelations({
    category: "integration",
    treeId: "integration:github:conn-1",
    fromNodeId: "integration-root",
  });
  assert.deepEqual(
    reopenedIntegrationRelations.map((relation) => ({
      toNodeId: relation.toNodeId,
      relationType: relation.relationType,
      provider: relation.metadata.provider,
    })),
    [{ toNodeId: "integration-issues", relationType: "tracks", provider: "github" }],
  );
  reopened.close();
});

test("sync semantic memory substrate patches interaction scope without rewriting unchanged rows", () => {
  const root = makeTempDir("hb-state-store-semantic-sync-interaction-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Acme",
    harness: "pi",
    status: "active",
  });

  store.replaceSemanticMemoryTree({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:release-playbook",
    nodes: [
      {
        nodeId: "interaction-root",
        nodeClass: "semantic",
        nodeKind: "workflow",
        path: "memory/interaction/release-playbook/content.md",
        title: "Release playbook",
        summary: "Root release workflow.",
        bodySha256: "sha-root-v1",
        childCount: 1,
        metadata: { owner: "ops" },
        createdAt: "2026-05-24T10:00:00.000Z",
        updatedAt: "2026-05-24T10:00:00.000Z",
      },
      {
        nodeId: "interaction-section",
        nodeClass: "semantic",
        nodeKind: "section",
        path: "memory/interaction/release-playbook/checklist/content.md",
        title: "Checklist",
        summary: "Release checklist.",
        bodySha256: "sha-section-v1",
        childCount: 1,
        isMaterialized: true,
        metadata: { partition: "current" },
        createdAt: "2026-05-24T10:01:00.000Z",
        updatedAt: "2026-05-24T10:01:00.000Z",
      },
      {
        nodeId: "interaction-leaf-1",
        nodeClass: "leaf",
        nodeKind: "leaf",
        sourceLeafId: "leaf-release-1",
        path: "memory/interaction/release-playbook/checklist/step-1.md",
        title: "Run migration",
        summary: "Apply the migration before restarting workers.",
        bodySha256: "sha-leaf-1",
        observedAt: "2026-05-24T09:59:00.000Z",
        metadata: { source: "interaction_leaf" },
        createdAt: "2026-05-24T10:02:00.000Z",
        updatedAt: "2026-05-24T10:02:00.000Z",
      },
    ],
    edges: [
      {
        parentNodeId: "interaction-root",
        childNodeId: "interaction-section",
        position: 1,
        createdAt: "2026-05-24T10:03:00.000Z",
      },
      {
        parentNodeId: "interaction-section",
        childNodeId: "interaction-leaf-1",
        position: 1,
        createdAt: "2026-05-24T10:04:00.000Z",
      },
    ],
  });
  store.replaceSemanticMemorySearchDocs({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:release-playbook",
    docs: [
      {
        nodeId: "interaction-root",
        nodeClass: "semantic",
        nodeKind: "workflow",
        path: "memory/interaction/release-playbook/content.md",
        childCount: 1,
        title: "Release playbook",
        summary: "Root release workflow.",
        bodyText: "Release playbook root body.",
        excerpt: "Release playbook root body.",
        updatedAt: "2026-05-24T10:05:00.000Z",
      },
      {
        nodeId: "interaction-section",
        nodeClass: "semantic",
        nodeKind: "section",
        path: "memory/interaction/release-playbook/checklist/content.md",
        childCount: 1,
        title: "Checklist",
        summary: "Release checklist.",
        bodyText: "Checklist body covering migration sequencing.",
        excerpt: "Checklist body covering migration sequencing.",
        updatedAt: "2026-05-24T10:06:00.000Z",
      },
      {
        nodeId: "interaction-leaf-1",
        nodeClass: "leaf",
        nodeKind: "leaf",
        path: "memory/interaction/release-playbook/checklist/step-1.md",
        title: "Run migration",
        summary: "Apply the migration before restarting workers.",
        bodyText: "Run the migration and restart the workers after it finishes.",
        excerpt: "Run the migration and restart the workers.",
        observedAt: "2026-05-24T09:59:00.000Z",
        updatedAt: "2026-05-24T10:07:00.000Z",
      },
    ],
  });
  store.replaceSemanticMemoryRelations({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:release-playbook",
    relations: [
      {
        fromNodeId: "interaction-root",
        toNodeId: "interaction-leaf-1",
        relationType: "references",
        metadata: { note: "original critical step" },
        createdAt: "2026-05-24T10:08:00.000Z",
        updatedAt: "2026-05-24T10:08:00.000Z",
      },
    ],
  });

  const rootBefore = store.getSemanticMemoryNode({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:release-playbook",
    nodeId: "interaction-root",
  });
  const sectionBefore = store.getSemanticMemoryNode({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:release-playbook",
    nodeId: "interaction-section",
  });
  const rootDocBefore = store.getSemanticMemorySearchDoc({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:release-playbook",
    nodeId: "interaction-root",
  });
  const rootEdgeBefore = store.listSemanticMemoryChildren({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:release-playbook",
    parentNodeId: "interaction-root",
  })[0];

  assert.ok(rootBefore);
  assert.ok(sectionBefore);
  assert.ok(rootDocBefore);
  assert.ok(rootEdgeBefore);

  store.syncSemanticMemoryTree({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:release-playbook",
    nodes: [
      {
        nodeId: "interaction-root",
        nodeClass: "semantic",
        nodeKind: "workflow",
        path: "memory/interaction/release-playbook/content.md",
        title: "Release playbook",
        summary: "Root release workflow.",
        bodySha256: "sha-root-v1",
        childCount: 1,
        metadata: { owner: "ops" },
        createdAt: "2099-01-01T00:00:00.000Z",
        updatedAt: "2099-01-01T00:00:00.000Z",
      },
      {
        nodeId: "interaction-section",
        nodeClass: "semantic",
        nodeKind: "section",
        path: "memory/interaction/release-playbook/checklist/content.md",
        title: "Checklist",
        summary: "Release checklist and restart order.",
        bodySha256: "sha-section-v2",
        childCount: 1,
        isMaterialized: true,
        metadata: { partition: "current", owner: "release-eng" },
        createdAt: "2099-01-01T00:00:00.000Z",
        updatedAt: "2026-05-25T10:01:00.000Z",
      },
      {
        nodeId: "interaction-leaf-2",
        nodeClass: "leaf",
        nodeKind: "leaf",
        sourceLeafId: "leaf-release-2",
        path: "memory/interaction/release-playbook/checklist/step-2.md",
        title: "Warm caches",
        summary: "Warm the cache after the rollout finishes.",
        bodySha256: "sha-leaf-2",
        observedAt: "2026-05-25T09:59:00.000Z",
        metadata: { source: "interaction_leaf" },
        createdAt: "2026-05-25T10:02:00.000Z",
        updatedAt: "2026-05-25T10:02:00.000Z",
      },
    ],
    edges: [
      {
        parentNodeId: "interaction-root",
        childNodeId: "interaction-section",
        position: 1,
        createdAt: "2099-01-01T00:00:00.000Z",
      },
      {
        parentNodeId: "interaction-section",
        childNodeId: "interaction-leaf-2",
        position: 1,
        createdAt: "2026-05-25T10:03:00.000Z",
      },
    ],
  });
  store.syncSemanticMemorySearchDocs({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:release-playbook",
    docs: [
      {
        nodeId: "interaction-root",
        nodeClass: "semantic",
        nodeKind: "workflow",
        path: "memory/interaction/release-playbook/content.md",
        childCount: 1,
        title: "Release playbook",
        summary: "Root release workflow.",
        bodyText: "Release playbook root body.",
        excerpt: "Release playbook root body.",
        updatedAt: "2099-01-01T00:00:00.000Z",
      },
      {
        nodeId: "interaction-section",
        nodeClass: "semantic",
        nodeKind: "section",
        path: "memory/interaction/release-playbook/checklist/content.md",
        childCount: 1,
        title: "Checklist",
        summary: "Release checklist and restart order.",
        bodyText: "Checklist body covering restart sequencing and cache warmup.",
        excerpt: "Checklist body covering restart sequencing.",
        updatedAt: "2026-05-25T10:04:00.000Z",
      },
      {
        nodeId: "interaction-leaf-2",
        nodeClass: "leaf",
        nodeKind: "leaf",
        path: "memory/interaction/release-playbook/checklist/step-2.md",
        title: "Warm caches",
        summary: "Warm the cache after the rollout finishes.",
        bodyText: "Run the runbook cache warmer after the rollout settles.",
        excerpt: "Run the runbook cache warmer.",
        observedAt: "2026-05-25T09:59:00.000Z",
        updatedAt: "2026-05-25T10:05:00.000Z",
      },
    ],
  });
  store.syncSemanticMemoryRelations({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:release-playbook",
    relations: [
      {
        fromNodeId: "interaction-root",
        toNodeId: "interaction-leaf-2",
        relationType: "references",
        metadata: { note: "updated critical step" },
        createdAt: "2026-05-25T10:06:00.000Z",
        updatedAt: "2026-05-25T10:06:00.000Z",
      },
    ],
  });

  const rootAfter = store.getSemanticMemoryNode({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:release-playbook",
    nodeId: "interaction-root",
  });
  const sectionAfter = store.getSemanticMemoryNode({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:release-playbook",
    nodeId: "interaction-section",
  });
  const leaf1After = store.getSemanticMemoryNode({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:release-playbook",
    nodeId: "interaction-leaf-1",
  });
  const leaf2After = store.getSemanticMemoryNode({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:release-playbook",
    nodeId: "interaction-leaf-2",
  });
  const rootDocAfter = store.getSemanticMemorySearchDoc({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:release-playbook",
    nodeId: "interaction-root",
  });
  const sectionDocAfter = store.getSemanticMemorySearchDoc({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:release-playbook",
    nodeId: "interaction-section",
  });
  const leaf1DocAfter = store.getSemanticMemorySearchDoc({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:release-playbook",
    nodeId: "interaction-leaf-1",
  });
  const leaf2DocAfter = store.getSemanticMemorySearchDoc({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:release-playbook",
    nodeId: "interaction-leaf-2",
  });
  const rootEdgeAfter = store.listSemanticMemoryChildren({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:release-playbook",
    parentNodeId: "interaction-root",
  });
  const sectionEdgeAfter = store.listSemanticMemoryChildren({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:release-playbook",
    parentNodeId: "interaction-section",
  });
  const relationsAfter = store.listSemanticMemoryRelations({
    category: "interaction",
    workspaceId: "workspace-1",
    treeId: "interaction:release-playbook",
    fromNodeId: "interaction-root",
  });

  assert.ok(rootAfter);
  assert.ok(sectionAfter);
  assert.equal(leaf1After, null);
  assert.ok(leaf2After);
  assert.ok(rootDocAfter);
  assert.ok(sectionDocAfter);
  assert.equal(leaf1DocAfter, null);
  assert.ok(leaf2DocAfter);
  assert.equal(rootAfter.createdAt, rootBefore.createdAt);
  assert.equal(rootAfter.updatedAt, rootBefore.updatedAt);
  assert.equal(sectionAfter.createdAt, sectionBefore.createdAt);
  assert.equal(sectionAfter.updatedAt, "2026-05-25T10:01:00.000Z");
  assert.equal(sectionAfter.summary, "Release checklist and restart order.");
  assert.deepEqual(sectionAfter.metadata, { partition: "current", owner: "release-eng" });
  assert.equal(leaf2After.createdAt, "2026-05-25T10:02:00.000Z");
  assert.equal(rootDocAfter.updatedAt, rootDocBefore.updatedAt);
  assert.equal(sectionDocAfter.updatedAt, "2026-05-25T10:04:00.000Z");
  assert.equal(leaf2DocAfter.updatedAt, "2026-05-25T10:05:00.000Z");
  assert.equal(rootEdgeAfter.length, 1);
  assert.equal(rootEdgeAfter[0]?.childNodeId, "interaction-section");
  assert.equal(rootEdgeAfter[0]?.createdAt, rootEdgeBefore.createdAt);
  assert.deepEqual(
    sectionEdgeAfter.map((edge) => ({
      childNodeId: edge.childNodeId,
      createdAt: edge.createdAt,
    })),
    [{ childNodeId: "interaction-leaf-2", createdAt: "2026-05-25T10:03:00.000Z" }],
  );
  assert.deepEqual(
    relationsAfter.map((relation) => ({
      toNodeId: relation.toNodeId,
      relationType: relation.relationType,
      note: relation.metadata.note,
      createdAt: relation.createdAt,
    })),
    [{
      toNodeId: "interaction-leaf-2",
      relationType: "references",
      note: "updated critical step",
      createdAt: "2026-05-25T10:06:00.000Z",
    }],
  );
  assert.deepEqual(
    store.searchSemanticMemorySearchDocs({
      category: "interaction",
      workspaceId: "workspace-1",
      treeId: "interaction:release-playbook",
      matchQuery: "runbook",
    }).map((hit) => hit.nodeId),
    ["interaction-leaf-2"],
  );
  assert.equal(
    store.searchSemanticMemorySearchDocs({
      category: "interaction",
      workspaceId: "workspace-1",
      treeId: "interaction:release-playbook",
      matchQuery: "migration",
    }).some((hit) => hit.nodeId === "interaction-leaf-1"),
    false,
  );

  store.close();
});

test("sync semantic memory substrate patches integration scope without rewriting unchanged rows", () => {
  const root = makeTempDir("hb-state-store-semantic-sync-integration-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  store.replaceSemanticMemoryTree({
    category: "integration",
    treeId: "integration:github:conn-1",
    nodes: [
      {
        nodeId: "integration-root",
        nodeClass: "semantic",
        nodeKind: "repo",
        path: "memory/integration/github/holaboss-ai-holaOS/content.md",
        title: "holaboss-ai/holaOS",
        summary: "Repository memory.",
        bodySha256: "sha-integration-root-v1",
        childCount: 1,
        metadata: { provider: "github" },
        createdAt: "2026-05-24T11:00:00.000Z",
        updatedAt: "2026-05-24T11:00:00.000Z",
      },
      {
        nodeId: "integration-issues",
        nodeClass: "semantic",
        nodeKind: "facet",
        path: "memory/integration/github/holaboss-ai-holaOS/issues/content.md",
        title: "Issues",
        summary: "Open issues.",
        bodySha256: "sha-integration-issues-v1",
        childCount: 1,
        createdAt: "2026-05-24T11:01:00.000Z",
        updatedAt: "2026-05-24T11:01:00.000Z",
      },
      {
        nodeId: "integration-issue-101",
        nodeClass: "leaf",
        nodeKind: "leaf",
        sourceLeafId: "issue-101",
        path: "memory/integration/github/holaboss-ai-holaOS/issues/101.md",
        title: "Issue #101",
        summary: "Fix layout mismatch.",
        bodySha256: "sha-integration-leaf-101",
        observedAt: "2026-05-24T10:59:00.000Z",
        metadata: { source: "integration_leaf" },
        createdAt: "2026-05-24T11:02:00.000Z",
        updatedAt: "2026-05-24T11:02:00.000Z",
      },
    ],
    edges: [
      {
        parentNodeId: "integration-root",
        childNodeId: "integration-issues",
        position: 1,
        createdAt: "2026-05-24T11:03:00.000Z",
      },
      {
        parentNodeId: "integration-issues",
        childNodeId: "integration-issue-101",
        position: 1,
        createdAt: "2026-05-24T11:04:00.000Z",
      },
    ],
  });
  store.replaceSemanticMemorySearchDocs({
    category: "integration",
    treeId: "integration:github:conn-1",
    docs: [
      {
        nodeId: "integration-root",
        nodeClass: "semantic",
        nodeKind: "repo",
        path: "memory/integration/github/holaboss-ai-holaOS/content.md",
        childCount: 1,
        title: "holaboss-ai/holaOS",
        summary: "Repository memory.",
        bodyText: "Repository memory root body.",
        excerpt: "Repository memory root body.",
        updatedAt: "2026-05-24T11:05:00.000Z",
      },
      {
        nodeId: "integration-issues",
        nodeClass: "semantic",
        nodeKind: "facet",
        path: "memory/integration/github/holaboss-ai-holaOS/issues/content.md",
        childCount: 1,
        title: "Issues",
        summary: "Open issues.",
        bodyText: "Issue list body for layout bugs.",
        excerpt: "Issue list body for layout bugs.",
        updatedAt: "2026-05-24T11:06:00.000Z",
      },
      {
        nodeId: "integration-issue-101",
        nodeClass: "leaf",
        nodeKind: "leaf",
        path: "memory/integration/github/holaboss-ai-holaOS/issues/101.md",
        title: "Issue #101",
        summary: "Fix layout mismatch.",
        bodyText: "Layout mismatch appears in the memory browser.",
        excerpt: "Layout mismatch appears in the memory browser.",
        observedAt: "2026-05-24T10:59:00.000Z",
        updatedAt: "2026-05-24T11:07:00.000Z",
      },
    ],
  });
  store.replaceSemanticMemoryRelations({
    category: "integration",
    treeId: "integration:github:conn-1",
    relations: [
      {
        fromNodeId: "integration-root",
        toNodeId: "integration-issue-101",
        relationType: "tracks",
        metadata: { priority: "medium" },
        createdAt: "2026-05-24T11:08:00.000Z",
        updatedAt: "2026-05-24T11:08:00.000Z",
      },
    ],
  });

  const issuesBefore = store.getSemanticMemoryNode({
    category: "integration",
    treeId: "integration:github:conn-1",
    nodeId: "integration-issues",
  });
  const issuesDocBefore = store.getSemanticMemorySearchDoc({
    category: "integration",
    treeId: "integration:github:conn-1",
    nodeId: "integration-issues",
  });
  const rootEdgeBefore = store.listSemanticMemoryChildren({
    category: "integration",
    treeId: "integration:github:conn-1",
    parentNodeId: "integration-root",
  })[0];

  assert.ok(issuesBefore);
  assert.ok(issuesDocBefore);
  assert.ok(rootEdgeBefore);

  store.syncSemanticMemoryTree({
    category: "integration",
    treeId: "integration:github:conn-1",
    nodes: [
      {
        nodeId: "integration-root",
        nodeClass: "semantic",
        nodeKind: "repo",
        path: "memory/integration/github/holaboss-ai-holaOS/content.md",
        title: "holaboss-ai/holaOS",
        summary: "Repository memory with release issues.",
        bodySha256: "sha-integration-root-v2",
        childCount: 1,
        metadata: { provider: "github", owner: "holaboss-ai" },
        createdAt: "2099-01-01T00:00:00.000Z",
        updatedAt: "2026-05-25T11:00:00.000Z",
      },
      {
        nodeId: "integration-issues",
        nodeClass: "semantic",
        nodeKind: "facet",
        path: "memory/integration/github/holaboss-ai-holaOS/issues/content.md",
        title: "Issues",
        summary: "Open issues.",
        bodySha256: "sha-integration-issues-v1",
        childCount: 1,
        createdAt: "2099-01-01T00:00:00.000Z",
        updatedAt: "2099-01-01T00:00:00.000Z",
      },
      {
        nodeId: "integration-issue-202",
        nodeClass: "leaf",
        nodeKind: "leaf",
        sourceLeafId: "issue-202",
        path: "memory/integration/github/holaboss-ai-holaOS/issues/202.md",
        title: "Issue #202",
        summary: "Backfill release metrics after rollout.",
        bodySha256: "sha-integration-leaf-202",
        observedAt: "2026-05-25T10:59:00.000Z",
        metadata: { source: "integration_leaf" },
        createdAt: "2026-05-25T11:01:00.000Z",
        updatedAt: "2026-05-25T11:01:00.000Z",
      },
    ],
    edges: [
      {
        parentNodeId: "integration-root",
        childNodeId: "integration-issues",
        position: 1,
        createdAt: "2099-01-01T00:00:00.000Z",
      },
      {
        parentNodeId: "integration-issues",
        childNodeId: "integration-issue-202",
        position: 1,
        createdAt: "2026-05-25T11:02:00.000Z",
      },
    ],
  });
  store.syncSemanticMemorySearchDocs({
    category: "integration",
    treeId: "integration:github:conn-1",
    docs: [
      {
        nodeId: "integration-root",
        nodeClass: "semantic",
        nodeKind: "repo",
        path: "memory/integration/github/holaboss-ai-holaOS/content.md",
        childCount: 1,
        title: "holaboss-ai/holaOS",
        summary: "Repository memory with release issues.",
        bodyText: "Repository memory root body with release issues.",
        excerpt: "Repository memory root body with release issues.",
        updatedAt: "2026-05-25T11:03:00.000Z",
      },
      {
        nodeId: "integration-issues",
        nodeClass: "semantic",
        nodeKind: "facet",
        path: "memory/integration/github/holaboss-ai-holaOS/issues/content.md",
        childCount: 1,
        title: "Issues",
        summary: "Open issues.",
        bodyText: "Issue list body for layout bugs.",
        excerpt: "Issue list body for layout bugs.",
        updatedAt: "2099-01-01T00:00:00.000Z",
      },
      {
        nodeId: "integration-issue-202",
        nodeClass: "leaf",
        nodeKind: "leaf",
        path: "memory/integration/github/holaboss-ai-holaOS/issues/202.md",
        title: "Issue #202",
        summary: "Backfill release metrics after rollout.",
        bodyText: "Release metrics backfill should start after the rollout settles.",
        excerpt: "Release metrics backfill should start after the rollout settles.",
        observedAt: "2026-05-25T10:59:00.000Z",
        updatedAt: "2026-05-25T11:04:00.000Z",
      },
    ],
  });
  store.syncSemanticMemoryRelations({
    category: "integration",
    treeId: "integration:github:conn-1",
    relations: [
      {
        fromNodeId: "integration-root",
        toNodeId: "integration-issue-202",
        relationType: "tracks",
        metadata: { priority: "high" },
        createdAt: "2026-05-25T11:05:00.000Z",
        updatedAt: "2026-05-25T11:05:00.000Z",
      },
    ],
  });

  const rootAfter = store.getSemanticMemoryNode({
    category: "integration",
    treeId: "integration:github:conn-1",
    nodeId: "integration-root",
  });
  const issuesAfter = store.getSemanticMemoryNode({
    category: "integration",
    treeId: "integration:github:conn-1",
    nodeId: "integration-issues",
  });
  const issue101After = store.getSemanticMemoryNode({
    category: "integration",
    treeId: "integration:github:conn-1",
    nodeId: "integration-issue-101",
  });
  const issue202After = store.getSemanticMemoryNode({
    category: "integration",
    treeId: "integration:github:conn-1",
    nodeId: "integration-issue-202",
  });
  const rootDocAfter = store.getSemanticMemorySearchDoc({
    category: "integration",
    treeId: "integration:github:conn-1",
    nodeId: "integration-root",
  });
  const issuesDocAfter = store.getSemanticMemorySearchDoc({
    category: "integration",
    treeId: "integration:github:conn-1",
    nodeId: "integration-issues",
  });
  const issue101DocAfter = store.getSemanticMemorySearchDoc({
    category: "integration",
    treeId: "integration:github:conn-1",
    nodeId: "integration-issue-101",
  });
  const issue202DocAfter = store.getSemanticMemorySearchDoc({
    category: "integration",
    treeId: "integration:github:conn-1",
    nodeId: "integration-issue-202",
  });
  const rootEdgeAfter = store.listSemanticMemoryChildren({
    category: "integration",
    treeId: "integration:github:conn-1",
    parentNodeId: "integration-root",
  });
  const issueEdgesAfter = store.listSemanticMemoryChildren({
    category: "integration",
    treeId: "integration:github:conn-1",
    parentNodeId: "integration-issues",
  });
  const relationsAfter = store.listSemanticMemoryRelations({
    category: "integration",
    treeId: "integration:github:conn-1",
    fromNodeId: "integration-root",
  });

  assert.ok(rootAfter);
  assert.ok(issuesAfter);
  assert.equal(issue101After, null);
  assert.ok(issue202After);
  assert.ok(rootDocAfter);
  assert.ok(issuesDocAfter);
  assert.equal(issue101DocAfter, null);
  assert.ok(issue202DocAfter);
  assert.equal(rootAfter.createdAt, "2026-05-24T11:00:00.000Z");
  assert.equal(rootAfter.updatedAt, "2026-05-25T11:00:00.000Z");
  assert.equal(issuesAfter.createdAt, issuesBefore.createdAt);
  assert.equal(issuesAfter.updatedAt, issuesBefore.updatedAt);
  assert.deepEqual(rootAfter.metadata, { provider: "github", owner: "holaboss-ai" });
  assert.equal(issue202After.createdAt, "2026-05-25T11:01:00.000Z");
  assert.equal(rootDocAfter.updatedAt, "2026-05-25T11:03:00.000Z");
  assert.equal(issuesDocAfter.updatedAt, issuesDocBefore.updatedAt);
  assert.equal(issue202DocAfter.updatedAt, "2026-05-25T11:04:00.000Z");
  assert.equal(rootEdgeAfter[0]?.createdAt, rootEdgeBefore.createdAt);
  assert.deepEqual(
    issueEdgesAfter.map((edge) => ({
      childNodeId: edge.childNodeId,
      createdAt: edge.createdAt,
    })),
    [{ childNodeId: "integration-issue-202", createdAt: "2026-05-25T11:02:00.000Z" }],
  );
  assert.deepEqual(
    relationsAfter.map((relation) => ({
      toNodeId: relation.toNodeId,
      relationType: relation.relationType,
      priority: relation.metadata.priority,
      createdAt: relation.createdAt,
    })),
    [{
      toNodeId: "integration-issue-202",
      relationType: "tracks",
      priority: "high",
      createdAt: "2026-05-25T11:05:00.000Z",
    }],
  );
  assert.deepEqual(
    store.searchSemanticMemorySearchDocs({
      category: "integration",
      treeId: "integration:github:conn-1",
      matchQuery: "backfill",
    }).map((hit) => hit.nodeId),
    ["integration-issue-202"],
  );
  assert.equal(
    store.searchSemanticMemorySearchDocs({
      category: "integration",
      treeId: "integration:github:conn-1",
      matchQuery: "mismatch",
    }).some((hit) => hit.nodeId === "integration-issue-101"),
    false,
  );

  store.close();
});
