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

// Workspace-removal (single-tenant synthetic root): the store no longer
// auto-creates the `workspaces` registry table — `ensureRuntimeDbSchema` /
// `ensureControlPlaneDbSchema` stopped emitting the CREATE TABLE. The write path
// (createWorkspace/updateWorkspace/deleteWorkspace/relocateWorkspace) still reads
// + writes the real registry row, so tests that exercise it must pre-create the
// table. It lives in the control-plane db and is mirrored into the host-state db
// (createWorkspace writes both when the paths differ). This column set is the
// exact pre-refactor production DDL (what `upsertWorkspaceRowInDb` writes), so the
// 25-column INSERT succeeds — the slimmer legacy shape would throw "no column
// named onboarding_state".
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

// Workspace-removal: createWorkspace was deleted, but kept-method tests still need
// a registered workspace as setup. Replicate the persistent effects createWorkspace
// had: the registry row (written to the control-plane db and mirrored into the
// host-state db when they differ) plus the on-disk folder and its hidden identity
// file (so workspaceDir's rename recovery can still rediscover the folder). The
// `workspaces` table itself is pre-created by seedWorkspacesRegistry.
function registerWorkspaceRow(
  store: RuntimeStateStore,
  params: {
    workspaceId: string;
    name: string;
    status?: string;
    harness?: string;
    onboardingStatus?: string;
    workspacePath?: string;
  },
): void {
  const now = utcNowIso();
  const workspacePath =
    params.workspacePath ?? path.join(store.workspaceRoot, params.workspaceId);
  const stateDir = path.join(workspacePath, ".holaboss", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "workspace_id"), `${params.workspaceId}\n`, "utf-8");
  for (const file of new Set([store.controlPlaneDbPath, store.dbPath])) {
    const db = new Database(file);
    try {
      db.prepare(
        `INSERT OR IGNORE INTO workspaces (
            id, workspace_path, name, status, harness, onboarding_status,
            created_at, updated_at, workspace_role
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'source')`,
      ).run(
        params.workspaceId,
        workspacePath,
        params.name,
        params.status ?? "active",
        params.harness ?? "pi",
        params.onboardingStatus ?? "not_required",
        now,
        now,
      );
    } finally {
      db.close();
    }
  }
}

test("control-plane metadata lives in control-plane.db while runtime.db keeps the mirrored workspace registry", () => {
  const root = makeTempDir("hb-state-store-");
  seedWorkspacesRegistry(path.join(root, "runtime.db"));
  const dbPath = path.join(root, "runtime.db");
  const controlPlanePath = path.join(root, "control-plane.db");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  registerWorkspaceRow(store, {
    workspaceId: "workspace-1",
    name: "Acme",
    harness: "pi",
    status: "active"
  });
  store.upsertRuntimeUserProfile({
    profileId: "default",
    name: "Sam",
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
  assert.equal(profileRow?.name, "Sam");
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

test("assertWorkspaceFolderHealthy throws a structured error when missing", () => {
  const root = makeTempDir("hb-state-store-");
  seedWorkspacesRegistry(path.join(root, "runtime.db"));
  const customRoot = makeTempDir("hb-custom-ws-");
  const customPath = path.join(customRoot, "ws");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  registerWorkspaceRow(store, {
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

// Workspace-removal cleanup: four tests were removed here because the production
// code they exercised was deleted by the single-tenant refactor:
//   - "runtime schema migrates workspace rows to registry and identity file"
//   - "legacy owner-table migration preserves explicit custom workspace_path"
//   - "legacy owner-table migration falls back when workspace_path points at a
//      stale managed folder"
//     (all three tested ensureWorkspacesTableSchema / migrateWorkspacesTable, the
//      on-open legacy `workspaces` / `workspaces_legacy_with_owner` migration —
//      now gone; the store reads the registry from the control-plane db and never
//      rebuilds/migrates a legacy table. The surviving identity-file *discovery*
//      recovery is still covered by "workspaceDir recovers when folder is renamed".)
//   - "getWorkspace recovers missing row from identity file"
//     (tested recoverMissingWorkspaceRecord, removed; getWorkspace is now the
//      synthetic root for any id.)

test("workspaceDir recovers when folder is renamed", () => {
  const root = makeTempDir("hb-state-store-");
  seedWorkspacesRegistry(path.join(root, "runtime.db"));
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  registerWorkspaceRow(store, {
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
  assert.equal(session.createdBy, null);
  assert.equal(session.archivedAt, null);
  assert.deepEqual(
    store.getBinding({ workspaceId: "workspace-1", sessionId: "session-main" }),
    updated
  );
  store.close();
});

test("waitForOutputEvent resolves on append for the matching session and times out otherwise", async () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  try {
    // Wakes as soon as a matching-session event is appended (well before the
    // generous fallback timeout).
    const woke = store.waitForOutputEvent({ sessionId: "s1", timeoutMs: 5000 });
    let resolvedEarly = false;
    void woke.then(() => {
      resolvedEarly = true;
    });
    store.appendOutputEvent({
      workspaceId: "workspace-1",
      sessionId: "s1",
      inputId: "i1",
      sequence: 1,
      eventType: "output_delta",
      payload: { delta: "hi" },
    });
    await woke;
    assert.equal(resolvedEarly, true);

    // An append for a DIFFERENT session doesn't wake this waiter — it falls
    // through to the timeout.
    const start = Date.now();
    const other = store.waitForOutputEvent({ sessionId: "s2", timeoutMs: 60 });
    store.appendOutputEvent({
      workspaceId: "workspace-1",
      sessionId: "s1",
      inputId: "i1",
      sequence: 2,
      eventType: "output_delta",
      payload: { delta: "again" },
    });
    await other;
    assert.ok(
      Date.now() - start >= 55,
      "waiter for a different session should time out, not wake on s1",
    );
  } finally {
    store.close();
  }
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
    name: "Sam",
    timezone: "America/Los_Angeles",
  });
  const updated = store.upsertRuntimeUserProfile({
    name: "Jeff",
    timezone: "America/New_York",
    nameSource: "manual",
  });
  const preserved = store.applyRuntimeUserProfileAuthFallback({
    name: "Ignored Auth Name",
    timezone: "Europe/London",
  });

  assert.equal(fallback?.name, "Sam");
  assert.equal(fallback?.timezone, "America/Los_Angeles");
  assert.equal(fallback?.nameSource, "auth_fallback");
  assert.equal(updated.name, "Jeff");
  assert.equal(updated.timezone, "America/New_York");
  assert.equal(updated.nameSource, "manual");
  assert.equal(preserved?.name, "Jeff");
  assert.equal(preserved?.timezone, "America/New_York");
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
    accountLabel: "owner@holaboss.ai",
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
    accountLabel: "owner@holaboss.ai",
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

test("markIntegrationConnectionExpired flips active rows to expired and is idempotent on already-expired rows", () => {
  const root = makeTempDir("hb-state-store-conn-expire-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });

  store.upsertIntegrationConnection({
    connectionId: "conn-notion-old",
    providerId: "notion",
    ownerUserId: "user-1",
    accountLabel: "Notion",
    accountExternalId: "ca_old",
    authMode: "oauth_app",
    grantedScopes: [],
    status: "active",
  });

  const firstFlip = store.markIntegrationConnectionExpired("conn-notion-old");
  assert.equal(firstFlip, true);
  assert.equal(store.getIntegrationConnection("conn-notion-old")?.status, "expired");

  const secondFlip = store.markIntegrationConnectionExpired("conn-notion-old");
  assert.equal(secondFlip, false, "calling twice is a no-op");

  const missing = store.markIntegrationConnectionExpired("conn-does-not-exist");
  assert.equal(missing, false);

  store.close();
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
    accountLabel: "@alice",
    accountExternalId: "ca_abc123",
    accountHandle: "alice",
    accountEmail: null,
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null
  });
  assert.equal(withIdentity.accountHandle, "alice");
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
    accountLabel: "@alice",
    accountExternalId: "ca_tw_v1",
    accountHandle: "alice",
    accountEmail: null,
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-gh-alice",
    providerId: "github",
    ownerUserId: "user-1",
    accountLabel: "alice",
    accountExternalId: "ca_gh_v1",
    accountHandle: "alice",
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
    accountHandle: "ALICE"
  });
  assert.equal(tw?.connectionId, "conn-tw-personal");

  // Different owner — no match
  const otherOwner = store.findActiveIntegrationConnectionByIdentity({
    providerId: "twitter",
    ownerUserId: "user-2",
    accountHandle: "alice"
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
    accountLabel: "owner@holaboss.ai",
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
    accountLabel: "owner@holaboss.ai",
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
    accountLabel: "owner@holaboss.ai",
    authMode: "oauth_app",
    grantedScopes: ["gmail.send"],
    status: "active"
  });
  const googleTwo = store.upsertIntegrationConnection({
    connectionId: "conn-google-2",
    providerId: "google",
    ownerUserId: "user-2",
    accountLabel: "owner+alt@holaboss.ai",
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

test("integration trees are control-plane-global and preserve owner provenance regardless of workspace scope", () => {
  // workspace-removal Piece 5.7: the integration knowledge graph is account-global
  // and control-plane-only. A passed workspaceId is ignored — every integration
  // tree read/write routes to the single control-plane DB, which keeps the
  // control-plane owner provenance (it is no longer cleared like the old
  // per-workspace variant did).
  const root = makeTempDir("hb-state-store-workspace-integration-trees-");
  seedWorkspacesRegistry(path.join(root, "runtime.db"));
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });

  registerWorkspaceRow(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });

  store.upsertIntegrationTree({
    workspaceId: "workspace-1",
    treeId: "integration:gmail:acct-1",
    provider: "gmail",
    ownerUserId: "user-1",
    accountKey: "ops@example.com",
    accountLabel: "Ops Gmail",
    slug: "gmail-ops-example-com-acct-1",
    summary: "Ops Gmail memory.",
    status: "active",
  });

  // The passed workspaceId is ignored; the tree is read back from the
  // control-plane DB with its owner provenance preserved.
  const direct = store.getIntegrationTree({
    workspaceId: "workspace-1",
    treeId: "integration:gmail:acct-1",
  });
  assert.equal(direct?.ownerUserId, "user-1");

  // The same tree is reachable with workspaceId omitted entirely (control-plane).
  const controlPlaneDirect = store.getIntegrationTree({
    workspaceId: null,
    treeId: "integration:gmail:acct-1",
  });
  assert.equal(controlPlaneDirect?.treeId, "integration:gmail:acct-1");
  assert.equal(controlPlaneDirect?.ownerUserId, "user-1");

  // account-identity lookup matches on the real owner provenance now.
  const byAccountIdentity = store.getIntegrationTreeByAccountIdentity({
    workspaceId: "workspace-1",
    provider: "gmail",
    ownerUserId: "user-1",
    accountKey: "ops@example.com",
  });
  assert.equal(byAccountIdentity?.treeId, "integration:gmail:acct-1");
  assert.equal(byAccountIdentity?.ownerUserId, "user-1");

  const filtered = store.listIntegrationTrees({
    workspaceId: "workspace-1",
    ownerUserId: "user-1",
    status: "active",
    limit: 100,
    offset: 0,
  });
  assert.deepEqual(filtered.map((tree) => tree.treeId), ["integration:gmail:acct-1"]);
  assert.equal(filtered[0]?.ownerUserId, "user-1");

  store.close();
});

test("a root data.db that fails integrity after an unclean shutdown is quarantined and reset", () => {
  const root = makeTempDir("hb-state-store-corrupt-");
  const opts = {
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  };

  // First session: open the root DB (writes the dirty marker), seed a row, close
  // cleanly (which clears the marker).
  const store1 = new RuntimeStateStore(opts);
  store1.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: { text: "hello" },
    idempotencyKey: "idem-1",
  });
  const dataDbPath = store1.rootRuntimeDbPath;
  const markerPath = `${dataDbPath}.open`;
  store1.close();
  assert.ok(fs.existsSync(dataDbPath), "data.db exists after the first session");
  assert.ok(!fs.existsSync(markerPath), "a clean close clears the dirty marker");

  // Simulate a crash that left the file malformed: drop stale sidecars, scribble
  // over every page after the header, and restore the dirty marker.
  for (const suffix of ["-wal", "-shm"]) {
    fs.rmSync(`${dataDbPath}${suffix}`, { force: true });
  }
  const size = fs.statSync(dataDbPath).size;
  assert.ok(size > 4096, "seeded db spans more than the header page");
  const fd = fs.openSync(dataDbPath, "r+");
  try {
    fs.writeSync(fd, Buffer.alloc(size - 4096, 0xff), 0, size - 4096, 4096);
  } finally {
    fs.closeSync(fd);
  }
  fs.writeFileSync(markerPath, ""); // prior run "crashed" — unclean shutdown

  // Second session: the guard detects corruption, quarantines the bad file, and
  // comes up on a fresh DB instead of wedging the queue worker.
  const store2 = new RuntimeStateStore(opts);
  const recovered = store2.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: { text: "after reset" },
    idempotencyKey: "idem-2",
  });
  assert.ok(recovered?.inputId, "the store works on the fresh DB");

  const quarantined = fs
    .readdirSync(path.dirname(dataDbPath))
    .filter((f) => f.startsWith("data.db.corrupt-"));
  assert.equal(
    quarantined.length,
    1,
    "the corrupt data.db was quarantined (kept for recovery), not deleted",
  );
  assert.ok(fs.existsSync(dataDbPath), "a fresh data.db replaced the corrupt one");
  store2.close();
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
  seedWorkspacesRegistry(path.join(root, "runtime.db"));
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  registerWorkspaceRow(store, {
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
  // Single-root end-state: runtime state lands in the shared root data.db, so
  // downgrade the constraint there (not in a per-workspace runtime.db file) to
  // exercise the on-open schema upgrade that re-adds 'PAUSED'.
  const rootRuntimeDbPath = store.rootRuntimeDbPath;
  store.close();

  const db = new Database(rootRuntimeDbPath);
  db.exec(`
    ALTER TABLE session_runtime_state RENAME TO session_runtime_state_current;

    CREATE TABLE session_runtime_state (
        session_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('IDLE', 'BUSY', 'WAITING_USER', 'ERROR', 'QUEUED')),
        current_input_id TEXT,
        current_worker_id TEXT,
        lease_until TEXT,
        heartbeat_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id)
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

  // Single-root end-state: the user-scoped entry persists in control-plane.db,
  // and the workspace-scoped entry now lands in the shared root data.db (not a
  // per-workspace runtime.db file, which is no longer opened).
  const controlPlaneDb = new Database(store.controlPlaneDbPath, { readonly: true });
  const rootDb = new Database(store.rootRuntimeDbPath, { readonly: true });
  assert.equal(
    Number((controlPlaneDb.prepare("SELECT COUNT(*) AS count FROM memory_entries").get() as { count: number }).count),
    1,
  );
  assert.equal(
    Number((rootDb.prepare("SELECT COUNT(*) AS count FROM memory_entries").get() as { count: number }).count),
    1,
  );
  controlPlaneDb.close();
  rootDb.close();
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
  seedWorkspacesRegistry(path.join(root, "runtime.db"));
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });

  assert.equal(store.supportsVectorIndex(), true);
  registerWorkspaceRow(store, {
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
    workspaceId: null,
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
    workspaceId: null,
    nodeKind: "summary",
    nodeId: "semantic:integration:vector-primary",
    treeId,
    embeddingModel: "text-embedding-3-small",
    contentFingerprint: "e".repeat(64),
    dimensions: 1536,
    vector: Array.from(primaryVector),
  });
  store.upsertIntegrationNodeEmbedding({
    workspaceId: null,
    nodeKind: "summary",
    nodeId: "semantic:integration:vector-secondary",
    treeId,
    embeddingModel: "text-embedding-3-small",
    contentFingerprint: "f".repeat(64),
    dimensions: 1536,
    vector: Array.from(secondaryVector),
  });

  const integrationResults = store.searchIntegrationNodeEmbeddingsByVector({
    workspaceId: null,
    embedding: primaryVector,
    embeddingModel: "text-embedding-3-small",
    limit: 2,
    treeIds: [treeId],
    nodeKinds: ["summary"],
  });
  assert.equal(integrationResults[0]?.nodeId, "semantic:integration:vector-primary");

  const vecRowid = integrationResults[0]?.vecRowid ?? null;
  store.deleteIntegrationTreeMemory({ workspaceId: null, treeId });
  assert.equal(
    store.searchIntegrationNodeEmbeddingsByVector({
      workspaceId: null,
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

test("workspace-scoped runtime tables persist inside the shared root data.db, not legacy runtime.db", () => {
  const root = makeTempDir("hb-state-store-");
  seedWorkspacesRegistry(path.join(root, "runtime.db"));
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath,
    workspaceRoot
  });

  registerWorkspaceRow(store, {
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
  const rootRuntimeDbPath = store.rootRuntimeDbPath;
  store.close();

  // Single-root end-state: every live workspace's runtime rows land in the
  // shared root data.db. The per-workspace runtime.db file is no longer opened
  // or written (kept only as a backup), so it must NOT exist for this fresh store.
  assert.equal(fs.existsSync(workspaceRuntimeDbFile(workspaceRoot, "workspace-1")), false);

  const rootDb = new Database(rootRuntimeDbPath, { readonly: true });
  const rootCounts = {
    outputs: Number((rootDb.prepare("SELECT COUNT(*) AS count FROM outputs").get() as { count: number }).count),
    appBuilds: Number((rootDb.prepare("SELECT COUNT(*) AS count FROM app_builds").get() as { count: number }).count),
    appPorts: Number((rootDb.prepare("SELECT COUNT(*) AS count FROM app_ports").get() as { count: number }).count),
    cronjobs: Number((rootDb.prepare("SELECT COUNT(*) AS count FROM cronjobs").get() as { count: number }).count),
    notifications: Number((rootDb.prepare("SELECT COUNT(*) AS count FROM runtime_notifications").get() as { count: number }).count),
    memoryUpdateProposals: Number((rootDb.prepare("SELECT COUNT(*) AS count FROM memory_update_proposals").get() as { count: number }).count),
  };
  rootDb.close();

  const runtimeDb = new Database(dbPath, { readonly: true });
  const runtimeTables = new Set<string>(
    (runtimeDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  runtimeDb.close();

  assert.deepEqual(rootCounts, {
    outputs: 1,
    appBuilds: 1,
    appPorts: 1,
    cronjobs: 1,
    notifications: 1,
    memoryUpdateProposals: 1,
  });
  assert.equal(runtimeTables.has("outputs"), false);
  assert.equal(runtimeTables.has("app_builds"), false);
  assert.equal(runtimeTables.has("app_ports"), false);
  assert.equal(runtimeTables.has("cronjobs"), false);
  assert.equal(runtimeTables.has("workflows"), false);
  assert.equal(runtimeTables.has("workflow_runs"), false);
  assert.equal(runtimeTables.has("runtime_notifications"), false);
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
  assert.equal(fetched.instruction, "Say hello");
  assert.ok(updated);
  assert.equal(updated.description, "Updated check");
  assert.equal(updated.instruction, "Say hello loudly");
  assert.equal(deleted, true);
  store.close();
});

test("cronjob schema migration backfills instruction from legacy description", () => {
  // Single-root end-state: live workspaces share the root data.db, so the
  // legacy `instruction`-less cronjobs schema now lives there (not the legacy
  // host-state runtime.db). Seed a pre-`instruction` root db, then open the
  // store and confirm the schema upgrade adds the column + backfills it from
  // `description`. (Root cronjobs carry no workspace_id; getCronjob keys by id.)
  const root = makeTempDir("hb-state-store-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");

  // Constructor only resolves paths; it does not open the root db yet.
  const pathProbe = new RuntimeStateStore({ dbPath, workspaceRoot });
  const rootRuntimeDbPath = pathProbe.rootRuntimeDbPath;
  pathProbe.close();

  fs.mkdirSync(path.dirname(rootRuntimeDbPath), { recursive: true });
  const db = new Database(rootRuntimeDbPath);
  db.exec(`
    CREATE TABLE cronjobs (
        id TEXT PRIMARY KEY,
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
      id, initiated_by, name, cron, description, enabled, delivery, metadata,
      last_run_at, next_run_at, run_count, last_status, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "job-1",
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
  assert.equal(migrated.instruction, "Say hello every 5 minutes.");
  store.close();
});

// REMOVED (workspace-removal Piece 5, Phase B): three tests that exercised the
// legacy host-state runtime.db -> per-workspace runtime.db backfill
// (`backfillWorkspaceRuntimeDbFromLegacyRuntimeDb`, the per-file
// `legacy_workspace_backfill_v1_complete` marker, and creation of per-workspace
// runtime.db files). Live workspaces now share the root data.db and
// `workspaceRuntimeDb` no longer opens per-workspace files or runs that
// backfill, so the machinery they assert is unreachable; the code is retained
// only as a backup. There is no single-root analogue (the root db deliberately
// has no legacy backfill), so they are dropped rather than rewritten. See the
// Phase B report for the per-test justification and the host-state upgrade-path note.
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

test("agent_sessions owning_app_id scopes app sessions and is immutable", () => {
  const root = makeTempDir("hb-state-store-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });

  store.ensureSession({ workspaceId: "w1", sessionId: "ws-1", kind: "main_session", createdBy: "user" });
  store.ensureSession({ workspaceId: "w1", sessionId: "ws-2", kind: "main_session", createdBy: "user" });
  const app = store.ensureSession({
    workspaceId: "w1",
    sessionId: "app-drawio-1",
    kind: "main_session",
    createdBy: "user",
    owningAppId: "drawio",
  });
  store.ensureSession({
    workspaceId: "w1",
    sessionId: "app-notion-1",
    kind: "main_session",
    createdBy: "user",
    owningAppId: "notion",
  });

  // Column round-trips (set on app session, null on a workspace session).
  assert.equal(app.owningAppId, "drawio");
  assert.equal(store.getSession({ workspaceId: "w1", sessionId: "ws-1" })?.owningAppId, null);

  // Unfiltered list has all four.
  assert.equal(store.listSessions({ workspaceId: "w1" }).length, 4);

  // The workspace/sidebar list excludes app-owned sessions.
  assert.deepEqual(
    store
      .listSessions({ workspaceId: "w1", excludeAppOwned: true })
      .map((s) => s.sessionId)
      .sort(),
    ["ws-1", "ws-2"],
  );

  // The app dropdown list returns only that app's sessions.
  assert.deepEqual(
    store.listSessions({ workspaceId: "w1", owningAppId: "drawio" }).map((s) => s.sessionId),
    ["app-drawio-1"],
  );

  // owning_app_id is bound at creation only — a later ensureSession update must
  // not reassign it.
  store.ensureSession({ workspaceId: "w1", sessionId: "app-drawio-1", title: "renamed", owningAppId: "hijack" });
  assert.equal(
    store.getSession({ workspaceId: "w1", sessionId: "app-drawio-1" })?.owningAppId,
    "drawio",
  );

  store.close();
});

test("legacy task_proposal session kind migrates to subagent on reopen", () => {
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
    createdBy: "workspace_user"
  });

  const sessions = store.listSessions({ workspaceId: "workspace-1" });
  assert.equal(session.kind, "subagent");
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.kind, "subagent");
  assert.equal(sessions[0]?.parentSessionId, "session-main");
  // Single-root end-state: sessions live in the shared root data.db, so plant
  // the legacy `task_proposal` kind there (not a per-workspace runtime.db file)
  // to exercise the on-reopen migration that rewrites it to `subagent`.
  const rootRuntimeDbPath = store.rootRuntimeDbPath;
  store.close();

  const legacyDb = new Database(rootRuntimeDbPath);
  legacyDb
    .prepare("UPDATE agent_sessions SET kind = ? WHERE session_id = ?")
    .run("task_proposal", "proposal-session-1");
  legacyDb.close();

  const reopened = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  const migratedSession = reopened.getSession({
    workspaceId: "workspace-1",
    sessionId: "proposal-session-1"
  });
  const migratedDb = new Database(rootRuntimeDbPath, { readonly: true });
  const storedKind = migratedDb
    .prepare("SELECT kind FROM agent_sessions WHERE session_id = ? LIMIT 1")
    .get("proposal-session-1") as { kind: string };

  assert.equal(migratedSession?.kind, "subagent");
  assert.equal(storedKind.kind, "subagent");
  migratedDb.close();
  reopened.close();
});

test("issues persist blocked-by workflow edges and reject cycles", () => {
  const root = makeTempDir("hb-state-store-issue-blocked-by-");
  seedWorkspacesRegistry(path.join(root, "runtime.db"));
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  registerWorkspaceRow(store, {
    workspaceId: "workspace-1",
    name: "Dependency Workspace",
    harness: "pi",
    status: "active",
  });
  const blocker = store.createIssue({
    workspaceId: "workspace-1",
    issueId: "TASK-1",
    title: "Build API",
    status: "todo",
  });
  const issue = store.createIssue({
    workspaceId: "workspace-1",
    issueId: "TASK-2",
    title: "Wire UI",
    status: "todo",
    blockedBy: [
      {
        taskId: blocker.issueId,
        relation: "input",
        instruction: "Use the API contract as input.",
      },
    ],
  });
  const fetched = store.getIssue({
    workspaceId: "workspace-1",
    issueId: issue.issueId,
  });
  const updated = store.updateIssue({
    workspaceId: "workspace-1",
    issueId: issue.issueId,
    fields: {
      blockedBy: [
        {
          taskId: blocker.issueId,
          relation: "handoff",
          instruction: null,
        },
      ],
    },
  });

  assert.deepEqual(fetched?.blockedBy, [
    {
      taskId: blocker.issueId,
      relation: "input",
      instruction: "Use the API contract as input.",
    },
  ]);
  assert.deepEqual(updated?.blockedBy, [
    {
      taskId: blocker.issueId,
      relation: "handoff",
      instruction: null,
    },
  ]);
  assert.throws(
    () =>
      store.updateIssue({
        workspaceId: "workspace-1",
        issueId: blocker.issueId,
        fields: {
          blockedBy: [{ taskId: issue.issueId, relation: "input", instruction: null }],
        },
      }),
    /cycles/,
  );
  assert.throws(
    () =>
      store.updateIssue({
        workspaceId: "workspace-1",
        issueId: issue.issueId,
        fields: {
          blockedBy: [{ taskId: "missing-task", relation: "input", instruction: null }],
        },
      }),
    /blocking issue missing-task not found/,
  );
  assert.throws(
    () =>
      store.updateIssue({
        workspaceId: "workspace-1",
        issueId: issue.issueId,
        fields: {
          blockedBy: [{ taskId: blocker.issueId, relation: "review" as never, instruction: null }],
        },
      }),
    /unsupported issue blocked_by relation "review"/,
  );
  store.close();
});

test("workspace runtime schema upgrades legacy tables before creating late indexes", () => {
  // Single-root end-state: live workspaces share the root data.db, so the
  // legacy-shaped runtime tables now live there (not a per-workspace runtime.db
  // file). Seed legacy tables in the root db, then open the store and confirm
  // the on-open schema upgrade adds late columns + indexes on the root.
  const root = makeTempDir("hb-state-store-legacy-runtime-indexes-");
  seedWorkspacesRegistry(path.join(root, "runtime.db"));
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  registerWorkspaceRow(store, {
    workspaceId: "workspace-1",
    name: "Legacy Runtime Workspace",
    harness: "pi",
    status: "active",
  });
  const runtimeDbPath = store.rootRuntimeDbPath;
  store.close();

  fs.rmSync(runtimeDbPath, { force: true });
  fs.mkdirSync(path.dirname(runtimeDbPath), { recursive: true });

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
  // Trigger workspace-runtime-db schema setup (only happens on first access).
  reopened.listSessions({ workspaceId: "workspace-1" });
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
  const memoryUpdateIndexes = new Set<string>(
    (migratedDb.prepare("PRAGMA index_list(memory_update_proposals)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  migratedDb.close();

  assert.equal(subagentRunColumns.has("issue_id"), true);
  assert.equal(outputColumns.has("input_id"), true);
  assert.equal(memoryUpdateColumns.has("state"), true);
  assert.equal(memoryUpdateColumns.has("updated_at"), true);
  assert.equal(subagentRunIndexes.has("idx_subagent_runs_issue_created"), true);
  assert.equal(outputIndexes.has("idx_outputs_session_input_created"), true);
  assert.equal(memoryUpdateIndexes.has("idx_memory_update_proposals_workspace_state_created"), true);
});

test("migrateLegacySessionKinds collapses duplicate main bindings per channel without violating UNIQUE", () => {
  // Regression: the workspace-removal fold merges every former workspace's main
  // conversation binding into the single root data.db. Normalizing them all onto
  // the canonical (channel, 'main_session', 'main_session') tuple used to collide
  // on UNIQUE(channel, conversation_key, role), throw inside schema setup, and
  // crash-loop the runtime on a blank loading screen. The migration must instead
  // keep one authoritative main binding per channel and drop the redundant rest.
  const root = makeTempDir("hb-state-store-dupe-main-bindings-");
  seedWorkspacesRegistry(path.join(root, "runtime.db"));
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  registerWorkspaceRow(store, {
    workspaceId: "workspace-1",
    name: "Dup Main Bindings",
    harness: "pi",
    status: "active",
  });
  // First access creates the canonical conversation_bindings schema (with the
  // UNIQUE constraint) in the root data.db.
  store.listSessions({ workspaceId: "workspace-1" });
  const runtimeDbPath = store.rootRuntimeDbPath;
  store.close();

  const seed = new Database(runtimeDbPath);
  const insert = seed.prepare(
    `INSERT INTO conversation_bindings (
        binding_id, channel, conversation_key, session_id, role, is_active,
        metadata, last_active_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
  );
  // Channel CA: an already-canonical binding plus two legacy 'main' duplicates.
  // The canonical one must win even though a legacy duplicate is more recent.
  insert.run("b-canon", "slack:CA", "main_session", "s-canon", "main_session", 1, "2026-06-20T00:00:00.000Z", "2026-06-20T00:00:00.000Z", "2026-06-20T00:00:00.000Z");
  insert.run("b-legacy-recent", "slack:CA", "dm:bob", "s-bob", "main", 1, "2026-06-27T00:00:00.000Z", "2026-06-01T00:00:00.000Z", "2026-06-27T00:00:00.000Z");
  insert.run("b-legacy-old", "slack:CA", "dm:carol", "s-carol", "main", 0, "2026-06-10T00:00:00.000Z", "2026-06-01T00:00:00.000Z", "2026-06-10T00:00:00.000Z");
  // A non-main binding on the same channel must survive untouched.
  insert.run("b-thread", "slack:CA", "dm:gary", "s-gary", "main_session", 1, "2026-06-22T00:00:00.000Z", "2026-06-22T00:00:00.000Z", "2026-06-22T00:00:00.000Z");
  // Channel CB: two legacy 'main' duplicates, no canonical row — the most recent
  // active one wins.
  insert.run("b-dave", "slack:CB", "dm:dave", "s-dave", "main", 1, "2026-06-15T00:00:00.000Z", "2026-06-01T00:00:00.000Z", "2026-06-15T00:00:00.000Z");
  insert.run("b-erin", "slack:CB", "dm:erin", "s-erin", "main", 1, "2026-06-26T00:00:00.000Z", "2026-06-01T00:00:00.000Z", "2026-06-26T00:00:00.000Z");
  seed.close();

  // Reopening triggers migrateLegacySessionKinds against the populated table; it
  // must dedupe rather than throw on the UNIQUE constraint.
  const reopened = new RuntimeStateStore({ dbPath, workspaceRoot });
  assert.doesNotThrow(() => {
    reopened.listSessions({ workspaceId: "workspace-1" });
  });
  reopened.close();

  const migrated = new Database(runtimeDbPath, { readonly: true });
  const mainBindings = migrated
    .prepare(
      `SELECT channel, session_id FROM conversation_bindings
       WHERE role = 'main_session' AND conversation_key = 'main_session'
       ORDER BY channel`,
    )
    .all() as Array<{ channel: string; session_id: string }>;
  const threadBinding = migrated
    .prepare(
      "SELECT role, conversation_key FROM conversation_bindings WHERE binding_id = 'b-thread'",
    )
    .get() as { role: string; conversation_key: string } | undefined;
  const remainingLegacyMain = migrated
    .prepare("SELECT COUNT(*) AS n FROM conversation_bindings WHERE lower(role) = 'main'")
    .get() as { n: number };
  migrated.close();

  // Exactly one canonical main binding survives per channel — the authoritative one.
  assert.deepEqual(mainBindings, [
    { channel: "slack:CA", session_id: "s-canon" },
    { channel: "slack:CB", session_id: "s-erin" },
  ]);
  // No leftover legacy 'main' rows remain.
  assert.equal(remainingLegacyMain.n, 0);
  // The unrelated thread binding is preserved unchanged.
  assert.equal(threadBinding?.role, "main_session");
  assert.equal(threadBinding?.conversation_key, "dm:gary");
});

test("a failing legacy data migration is non-fatal and never crash-loops schema setup", () => {
  // Resilience: a thrown legacy data-normalization migration must not abort
  // schema setup and take down the whole runtime (which previously left the
  // desktop app stuck on a blank loading screen with diagnostics export dead).
  // It must be caught, logged, and the store must still open and be usable.
  const root = makeTempDir("hb-state-store-migration-resilience-");
  seedWorkspacesRegistry(path.join(root, "runtime.db"));
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  registerWorkspaceRow(store, {
    workspaceId: "workspace-1",
    name: "Migration Resilience",
    harness: "pi",
    status: "active",
  });
  store.listSessions({ workspaceId: "workspace-1" });
  const runtimeDbPath = store.rootRuntimeDbPath;
  store.close();

  const seed = new Database(runtimeDbPath);
  seed
    .prepare(
      `INSERT INTO conversation_bindings (
          binding_id, channel, conversation_key, session_id, role, is_active,
          metadata, last_active_at, created_at, updated_at
       ) VALUES ('b-legacy', 'desktop', 'workspace-main', 's-legacy', 'main', 1,
                 '{}', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
    )
    .run();
  // Force migrateLegacySessionKinds's normalize UPDATE to throw, mimicking an
  // unforeseen real-world failure inside the wrapped data migration.
  seed.exec(`
    CREATE TRIGGER block_legacy_main_normalize
    BEFORE UPDATE OF role, conversation_key ON conversation_bindings
    WHEN OLD.role = 'main'
    BEGIN
      SELECT RAISE(ABORT, 'injected migration failure');
    END;
  `);
  seed.close();

  // Reopening runs the failing migration; the store must still open + be usable.
  const reopened = new RuntimeStateStore({ dbPath, workspaceRoot });
  let sessions: unknown;
  assert.doesNotThrow(() => {
    sessions = reopened.listSessions({ workspaceId: "workspace-1" });
  });
  assert.ok(Array.isArray(sessions));
  reopened.close();

  // The migration rolled back (row left un-normalized), but schema setup survived.
  const after = new Database(runtimeDbPath, { readonly: true });
  const row = after
    .prepare("SELECT role FROM conversation_bindings WHERE binding_id = 'b-legacy'")
    .get() as { role: string } | undefined;
  after.close();
  assert.equal(row?.role, "main");
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

test("listAppPorts returns all allocated ports", () => {
  // Single-root end-state: app_ports has no workspace_id column and every live
  // workspace shares the one root data.db, so listAppPorts returns the full set
  // of allocated ports (per-workspace partitioning of app_ports no longer
  // exists — the runtime hosts a single workspace).
  const root = makeTempDir("hb-store-ports-list-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "test.db"),
    workspaceRoot: path.join(root, "workspace"),
    portInUseProbe: () => false,
  });

  store.allocateAppPort({ workspaceId: "workspace-1", appId: "gmail" });
  store.allocateAppPort({ workspaceId: "workspace-1", appId: "sheets" });

  const ports = store.listAppPorts({ workspaceId: "workspace-1" });
  assert.equal(ports.length, 2);
  assert.deepEqual(
    ports.map((record) => record.appId).sort(),
    ["gmail", "sheets"],
  );

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
  insertConn.run("conn-needs-binding", "google", "user-1", "ws-A", "user@personal.com", null, "oauth_app", "[]", "active", null, "2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z");
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
  seedWorkspacesRegistry(path.join(root, "runtime.db"));
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  registerWorkspaceRow(store, {
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
    workspaceId: null,
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
    workspaceId: null,
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
    workspaceId: null,
    path: "memory/integration/github/holaboss-ai-holaOS/issues/101.md",
  });
  assert.ok(integrationLeaf);
  assert.equal(integrationLeaf.workspaceId, null);
  assert.equal(integrationLeaf.sourceLeafId, "issue-101");

  const integrationSemanticNodes = store.listSemanticMemoryNodes({
    category: "integration",
    workspaceId: null,
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
    workspaceId: null,
    treeId: "integration:github:conn-1",
    parentNodeId: "integration-root",
  });
  assert.deepEqual(
    reopenedIntegrationChildren.map((edge) => edge.childNodeId),
    ["integration-issues"],
  );
  const reopenedIntegrationRelations = reopened.listSemanticMemoryRelations({
    category: "integration",
    workspaceId: null,
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

test("semantic integration memory defaults to the control-plane scope", () => {
  // workspace-removal Piece 5.7: integration semantic memory is account-global and
  // control-plane-only. Omitting workspaceId (or passing any value) no longer
  // throws — it resolves to the control-plane DB. This previously required an
  // explicit workspaceId; the requirement was dropped with the per-workspace
  // integration variant.
  const root = makeTempDir("hb-state-store-semantic-integration-scope-");
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  // Reading with no workspaceId now succeeds (control-plane) and is empty.
  assert.deepEqual(
    store.listSemanticMemoryNodes({
      category: "integration",
      treeId: "integration:github:conn-1",
    }),
    [],
  );

  // Writing with no workspaceId now succeeds against the control-plane DB.
  store.replaceSemanticMemoryTree({
    category: "integration",
    treeId: "integration:github:conn-1",
    nodes: [
      {
        nodeId: "integration-root",
        nodeClass: "semantic",
        nodeKind: "workflow",
        path: "memory/integration/github/conn-1/content.md",
        title: "GitHub root",
        summary: "Root integration node.",
        bodySha256: "sha-integration-root",
        childCount: 0,
        metadata: { provider: "github" },
        createdAt: "2026-05-24T10:00:00.000Z",
        updatedAt: "2026-05-24T10:00:00.000Z",
      },
    ],
    edges: [],
  });

  // The node is readable back from the control-plane scope (workspaceId omitted
  // and workspaceId: null are equivalent here).
  const implicitScope = store.listSemanticMemoryNodes({
    category: "integration",
    treeId: "integration:github:conn-1",
  });
  assert.deepEqual(implicitScope.map((node) => node.nodeId), ["integration-root"]);
  assert.equal(implicitScope[0]?.workspaceId, null);

  const controlPlaneScope = store.listSemanticMemoryNodes({
    category: "integration",
    workspaceId: null,
    treeId: "integration:github:conn-1",
  });
  assert.deepEqual(controlPlaneScope.map((node) => node.nodeId), ["integration-root"]);

  store.close();
});

test("sync semantic memory substrate patches interaction scope without rewriting unchanged rows", () => {
  const root = makeTempDir("hb-state-store-semantic-sync-interaction-");
  seedWorkspacesRegistry(path.join(root, "runtime.db"));
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  registerWorkspaceRow(store, {
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
    workspaceId: null,
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
    workspaceId: null,
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
    workspaceId: null,
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
    workspaceId: null,
    treeId: "integration:github:conn-1",
    nodeId: "integration-issues",
  });
  const issuesDocBefore = store.getSemanticMemorySearchDoc({
    category: "integration",
    workspaceId: null,
    treeId: "integration:github:conn-1",
    nodeId: "integration-issues",
  });
  const rootEdgeBefore = store.listSemanticMemoryChildren({
    category: "integration",
    workspaceId: null,
    treeId: "integration:github:conn-1",
    parentNodeId: "integration-root",
  })[0];

  assert.ok(issuesBefore);
  assert.ok(issuesDocBefore);
  assert.ok(rootEdgeBefore);

  store.syncSemanticMemoryTree({
    category: "integration",
    workspaceId: null,
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
    workspaceId: null,
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
    workspaceId: null,
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
    workspaceId: null,
    treeId: "integration:github:conn-1",
    nodeId: "integration-root",
  });
  const issuesAfter = store.getSemanticMemoryNode({
    category: "integration",
    workspaceId: null,
    treeId: "integration:github:conn-1",
    nodeId: "integration-issues",
  });
  const issue101After = store.getSemanticMemoryNode({
    category: "integration",
    workspaceId: null,
    treeId: "integration:github:conn-1",
    nodeId: "integration-issue-101",
  });
  const issue202After = store.getSemanticMemoryNode({
    category: "integration",
    workspaceId: null,
    treeId: "integration:github:conn-1",
    nodeId: "integration-issue-202",
  });
  const rootDocAfter = store.getSemanticMemorySearchDoc({
    category: "integration",
    workspaceId: null,
    treeId: "integration:github:conn-1",
    nodeId: "integration-root",
  });
  const issuesDocAfter = store.getSemanticMemorySearchDoc({
    category: "integration",
    workspaceId: null,
    treeId: "integration:github:conn-1",
    nodeId: "integration-issues",
  });
  const issue101DocAfter = store.getSemanticMemorySearchDoc({
    category: "integration",
    workspaceId: null,
    treeId: "integration:github:conn-1",
    nodeId: "integration-issue-101",
  });
  const issue202DocAfter = store.getSemanticMemorySearchDoc({
    category: "integration",
    workspaceId: null,
    treeId: "integration:github:conn-1",
    nodeId: "integration-issue-202",
  });
  const rootEdgeAfter = store.listSemanticMemoryChildren({
    category: "integration",
    workspaceId: null,
    treeId: "integration:github:conn-1",
    parentNodeId: "integration-root",
  });
  const issueEdgesAfter = store.listSemanticMemoryChildren({
    category: "integration",
    workspaceId: null,
    treeId: "integration:github:conn-1",
    parentNodeId: "integration-issues",
  });
  const relationsAfter = store.listSemanticMemoryRelations({
    category: "integration",
    workspaceId: null,
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
      workspaceId: null,
      treeId: "integration:github:conn-1",
      matchQuery: "backfill",
    }).map((hit) => hit.nodeId),
    ["integration-issue-202"],
  );
  assert.equal(
    store.searchSemanticMemorySearchDocs({
      category: "integration",
      workspaceId: null,
      treeId: "integration:github:conn-1",
      matchQuery: "mismatch",
    }).some((hit) => hit.nodeId === "integration-issue-101"),
    false,
  );

  store.close();
});

test("searchOutputs indexes title/body and honors producer + date filters", () => {
  const root = makeTempDir("hb-state-store-");
  seedWorkspacesRegistry(path.join(root, "runtime.db"));
  const dbPath = path.join(root, "runtime.db");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  registerWorkspaceRow(store, {
    workspaceId: "ws-search",
    name: "Search WS",
    harness: "pi",
    status: "active",
  });

  const budgetReport = store.createOutput({
    workspaceId: "ws-search",
    outputType: "report",
    title: "Q3 budget review",
    htmlContent: "Revenue overshot by twelve percent. Forecast is conservative.",
    metadata: { produced_by_teammate_id: "alice" },
    createdAt: "2026-06-08T10:00:00.000Z",
  });
  const meetingNotes = store.createOutput({
    workspaceId: "ws-search",
    outputType: "note",
    title: "Team sync notes",
    htmlContent: "Discussed shipping the Q3 budget changes next week.",
    metadata: { produced_by_teammate_id: "bob" },
    createdAt: "2026-06-09T10:00:00.000Z",
  });
  const oldDoc = store.createOutput({
    workspaceId: "ws-search",
    outputType: "doc",
    title: "Legacy budget plan",
    htmlContent: "Old budget content from last year.",
    metadata: { produced_by_teammate_id: "alice" },
    createdAt: "2025-12-01T10:00:00.000Z",
  });

  // Empty query short-circuits cleanly.
  const empty = store.searchOutputs({ workspaceId: "ws-search", query: "" });
  assert.deepEqual(empty, { results: [], total: 0 });

  // "budget" matches all three rows — two title hits plus one body hit.
  // Ordering depends on bm25 weights so assert by set, not by position.
  const titleHits = store.searchOutputs({
    workspaceId: "ws-search",
    query: "budget",
  });
  assert.equal(titleHits.total, 3);
  const titleIds = new Set(titleHits.results.map((r) => r.output.id));
  assert.ok(titleIds.has(budgetReport.id));
  assert.ok(titleIds.has(meetingNotes.id));
  assert.ok(titleIds.has(oldDoc.id));

  // Body-text hit: meeting notes mentions "shipping" only in the body.
  const bodyHit = store.searchOutputs({
    workspaceId: "ws-search",
    query: "shipping",
  });
  assert.equal(bodyHit.total, 1);
  assert.equal(bodyHit.results[0]?.output.id, meetingNotes.id);

  // Producer filter restricts to alice's outputs only.
  const aliceHits = store.searchOutputs({
    workspaceId: "ws-search",
    query: "budget",
    producerId: "alice",
  });
  const aliceIds = aliceHits.results.map((r) => r.output.id).sort();
  assert.deepEqual(aliceIds, [oldDoc.id, budgetReport.id].sort());

  // Date range clips out the 2025 legacy doc.
  const recent = store.searchOutputs({
    workspaceId: "ws-search",
    query: "budget",
    dateRangeStart: "2026-01-01T00:00:00.000Z",
    dateRangeEnd: "2026-12-31T23:59:59.999Z",
  });
  const recentIds = recent.results.map((r) => r.output.id).sort();
  assert.deepEqual(recentIds, [budgetReport.id, meetingNotes.id].sort());

  // After an update, the FTS row reflects the new title.
  store.updateOutput({
    workspaceId: "ws-search",
    outputId: meetingNotes.id,
    title: "Pricing decision recap",
  });
  const afterRename = store.searchOutputs({
    workspaceId: "ws-search",
    query: "pricing",
  });
  assert.equal(afterRename.total, 1);
  assert.equal(afterRename.results[0]?.output.id, meetingNotes.id);
  const staleByOldTitle = store.searchOutputs({
    workspaceId: "ws-search",
    query: "sync",
  });
  assert.equal(staleByOldTitle.total, 0);

  // Delete drops the row from the FTS index.
  store.deleteOutput({ workspaceId: "ws-search", outputId: budgetReport.id });
  const afterDelete = store.searchOutputs({
    workspaceId: "ws-search",
    query: "review",
  });
  assert.equal(afterDelete.total, 0);

  store.close();
});

test("an integrity check that was killed mid-run is not retried on the next boot", () => {
  // The livelock this guards: quick_check is unbounded (it walks every page —
  // ~80s on a 2GB data.db) while the desktop gives the runtime ~30s to answer
  // /healthz before killing and respawning it. The kill leaves the dirty marker,
  // which re-arms the check, which is killed again. The app never starts and
  // nothing logs an error. Observed in the field on a 1.9GB data.db that was in
  // fact healthy — quick_check returned "ok" when run to completion by hand.
  const root = makeTempDir("hb-state-store-check-livelock-");
  const opts = {
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  };

  const store1 = new RuntimeStateStore(opts);
  store1.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: { text: "hello" },
    idempotencyKey: "idem-1",
  });
  const dataDbPath = store1.rootRuntimeDbPath;
  const markerPath = `${dataDbPath}.open`;
  store1.close();

  // The DB is intact — as it was in the field. Only the marker says a previous
  // boot died while checking.
  fs.writeFileSync(markerPath, "checking");

  // A small healthy DB passes quick_check in milliseconds, so behaviour alone
  // cannot distinguish "skipped" from "ran and passed" — and the bug is that it
  // RUNS. Observe which path was taken.
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  let store2: RuntimeStateStore;
  let recovered: ReturnType<RuntimeStateStore["enqueueInput"]>;
  try {
    store2 = new RuntimeStateStore(opts);
    recovered = store2.enqueueInput({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      payload: { text: "after skipped check" },
      idempotencyKey: "idem-2",
    });
  } finally {
    console.warn = realWarn;
  }
  assert.ok(
    warnings.some((line) => line.includes("skipping the integrity check")),
    `expected the check to be skipped after a killed run, saw: ${JSON.stringify(warnings)}`,
  );
  assert.ok(
    !warnings.some((line) => line.includes("verifying")),
    "the check was re-run after having been killed once — that is the livelock",
  );
  assert.ok(recovered?.inputId, "the store boots instead of looping on the check");
  assert.equal(
    fs.readFileSync(markerPath, "utf8"),
    "open",
    "the marker resets to the open state so a later crash re-arms the check",
  );
  // Nothing was quarantined: a healthy DB must not be thrown away just because
  // the check could not be completed in time.
  assert.deepEqual(
    fs.readdirSync(path.dirname(dataDbPath)).filter((f) => f.startsWith("data.db.corrupt-")),
    [],
    "a healthy DB must survive a skipped check",
  );
  store2.close();

  // And the data is still there — this is the whole point of not resetting.
  const store3 = new RuntimeStateStore(opts);
  for (const key of ["idem-1", "idem-2"]) {
    assert.ok(
      store3.getInputByIdempotencyKey({ workspaceId: "workspace-1", idempotencyKey: key }),
      `${key} survived the skipped check`,
    );
  }
  store3.close();
});

test("a legacy empty marker still triggers the integrity check", () => {
  // Markers written before the marker carried a state are empty strings. They
  // must keep meaning "crashed while open", or an upgrade would silently drop
  // the corruption guard for every user mid-crash.
  const root = makeTempDir("hb-state-store-legacy-marker-");
  const opts = {
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  };
  const store1 = new RuntimeStateStore(opts);
  store1.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: { text: "hello" },
    idempotencyKey: "idem-1",
  });
  const dataDbPath = store1.rootRuntimeDbPath;
  store1.close();

  for (const suffix of ["-wal", "-shm"]) {
    fs.rmSync(`${dataDbPath}${suffix}`, { force: true });
  }
  const size = fs.statSync(dataDbPath).size;
  const fd = fs.openSync(dataDbPath, "r+");
  try {
    fs.writeSync(fd, Buffer.alloc(size - 4096, 0xff), 0, size - 4096, 4096);
  } finally {
    fs.closeSync(fd);
  }
  fs.writeFileSync(`${dataDbPath}.open`, ""); // legacy format

  const store2 = new RuntimeStateStore(opts);
  store2.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: { text: "after reset" },
    idempotencyKey: "idem-2",
  });
  const quarantined = fs
    .readdirSync(path.dirname(dataDbPath))
    .filter((f) => f.startsWith("data.db.corrupt-"));
  assert.equal(quarantined.length, 1, "a legacy marker must still run the check");
  store2.close();
});
