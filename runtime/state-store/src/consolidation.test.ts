import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import Database from "better-sqlite3";

import { MigrationRunner } from "./migrations.js";
import { migration as dropWorkspaceIdSessionTablesMigration } from "./migrations/028-drop-workspace-id-session-tables.js";
import { RuntimeStateStore } from "./store.js";

// Phase A (workspace-removal Piece 5) DORMANT machinery. These tests are the
// ONLY production-adjacent caller of rootRuntimeDb() /
// consolidateWorkspaceRuntimeDbsIntoRoot(); nothing in the runtime wires them
// into an open/init/session path yet (Phase B does that later). The asserts
// read the root data.db directly to avoid going back through workspaceRuntimeDb.

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

function makeStore(): RuntimeStateStore {
  const root = makeTempDir("hb-consolidation-");
  const dbPath = path.join(root, "state", "host-state.db");
  const controlPlaneDbPath = path.join(root, "state", "control-plane.db");
  const workspaceRoot = path.join(root, "workspaces");
  return new RuntimeStateStore({ dbPath, controlPlaneDbPath, workspaceRoot });
}

// The single-tenant flip routes every live workspace's writes to the root
// data.db, so the store can no longer create the per-workspace runtime.db files
// that consolidation folds in. To still exercise consolidation, seed those
// source files directly. Their schema is the canonical workspace-runtime schema
// — captured once from a throwaway store's freshly-created root db (which is
// built via the same `ensureWorkspaceRuntimeDbSchema` path) and replayed into
// each per-workspace file so the column-matched copy lines up exactly.
let cachedWorkspaceRuntimeSchemaDDL: string[] | null = null;

function workspaceRuntimeSchemaDDL(): string[] {
  if (cachedWorkspaceRuntimeSchemaDDL) {
    return cachedWorkspaceRuntimeSchemaDDL;
  }
  const reference = makeStore();
  try {
    // Any workspace-scoped write opens (and fully schematizes) the root db.
    reference.ensureSession({ workspaceId: "schema-probe", sessionId: "schema-probe" });
    const refDb = new Database(reference.rootRuntimeDbPath, { readonly: true });
    try {
      // Replay only the plain tables + their indexes — exactly what
      // consolidation reads from a source db. FTS5 virtual tables (and their
      // reserved `*_fts_*` shadow tables) and vec0 virtual tables (`*_vec*`,
      // module not loaded here) can't be — and don't need to be — recreated.
      cachedWorkspaceRuntimeSchemaDDL = (
        refDb
          .prepare(
            `SELECT sql, name FROM sqlite_master
             WHERE sql IS NOT NULL
               AND type IN ('table', 'index')
               AND name NOT LIKE 'sqlite_%'
               AND name NOT LIKE '%\\_fts%' ESCAPE '\\'
               AND name NOT LIKE '%\\_vec%' ESCAPE '\\'
               AND upper(trim(sql)) NOT LIKE 'CREATE VIRTUAL TABLE%'
             ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END`,
          )
          .all() as Array<{ sql: string; name: string }>
      ).map((row) => row.sql);
    } finally {
      refDb.close();
    }
  } finally {
    reference.close();
  }
  return cachedWorkspaceRuntimeSchemaDDL;
}

// Workspace-removal: the store no longer auto-creates the `workspaces` registry
// table (single-tenant synthetic root), but `createWorkspace` still writes the
// legacy registry row that consolidation reads (for project names) before folding
// + dropping it. Pre-create the table in BOTH the control-plane db and the
// host-state monolith (`store.dbPath`, which createWorkspace mirror-writes), since
// these tests pass distinct paths for each. Full column set = the schema the store
// writes. Idempotent (CREATE TABLE IF NOT EXISTS); call right before any
// createWorkspace, AFTER the warmup consolidate that would otherwise drop it.
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

function ensureWorkspacesTable(store: RuntimeStateStore): void {
  for (const file of new Set([store.controlPlaneDbPath, store.dbPath])) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    try {
      db.exec(WORKSPACES_TABLE_DDL);
    } finally {
      db.close();
    }
  }
}

// Workspace-removal: createWorkspace was deleted, so replicate the one effect
// consolidation depends on — a registry row (mirrored into BOTH the control-plane
// db and the host-state monolith, since consolidation reads from both) plus the
// on-disk workspace folder. The per-workspace runtime.db source file is still
// seeded separately (seedWorkspaceRuntimeDbFile). Requires the workspaces table to
// already exist (ensureWorkspacesTable), exactly as createWorkspace did.
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

function seedWorkspace(
  store: RuntimeStateStore,
  workspaceId: string,
  name: string,
): { sessionIds: string[]; outputId: string } {
  ensureWorkspacesTable(store);
  insertWorkspaceRow(store, workspaceId, name);

  const sessionA = `${workspaceId}-sess-a`;
  const sessionB = `${workspaceId}-sess-b`;
  const outputId = `${workspaceId}-output`;

  // Write the per-workspace runtime.db source file directly (the store now
  // writes to root, not here). Sessions stay UNTAGGED (project_id NULL) so
  // consolidation is what assigns them to the workspace's project.
  seedWorkspaceRuntimeDbFile(store.workspaceRoot, workspaceId, (db) => {
    const insertSession = db.prepare(`
      INSERT INTO agent_sessions (session_id, kind, title, project_id, created_at, updated_at)
      VALUES (?, 'main_session', ?, NULL, ?, ?)
    `);
    insertSession.run(sessionA, `${name} A`, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    insertSession.run(sessionB, `${name} B`, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    db.prepare(`
      INSERT INTO outputs (id, output_type, title, status, html_content, session_id, created_at, updated_at)
      VALUES (?, 'document', ?, 'ready', ?, ?, ?, ?)
    `).run(
      outputId,
      `${name} output`,
      `<p>${name} body</p>`,
      sessionA,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
  });

  return { sessionIds: [sessionA, sessionB], outputId };
}

function seedWorkspaceRuntimeDbFile(
  workspaceRoot: string,
  workspaceId: string,
  seed: (db: Database.Database) => void,
): void {
  const file = workspaceRuntimeDbFile(workspaceRoot, workspaceId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.pragma("foreign_keys = ON");
    for (const ddl of workspaceRuntimeSchemaDDL()) {
      db.exec(ddl);
    }
    seed(db);
  } finally {
    db.close();
  }
}

function workspaceRuntimeDbFile(workspaceRoot: string, workspaceId: string): string {
  return path.join(workspaceRoot, workspaceId, ".holaboss", "state", "runtime.db");
}

test("consolidateWorkspaceRuntimeDbsIntoRoot folds workspaces into the root data.db", () => {
  const store = makeStore();

  // Open the root db once while there is nothing to fold. This latches the
  // one-time auto-consolidation that now fires on first root open (a no-op
  // here), so the explicit call below — not a hidden re-entrant auto-run — is
  // the run that actually folds the workspaces seeded afterwards, keeping the
  // returned counts observable.
  const warmup = store.consolidateWorkspaceRuntimeDbsIntoRoot();
  assert.equal(warmup.workspacesConsolidated, 0);
  assert.equal(warmup.sessionsCopied, 0);

  const ws1 = seedWorkspace(store, "ws-one", "One");
  const ws2 = seedWorkspace(store, "ws-two", "Two");

  const result = store.consolidateWorkspaceRuntimeDbsIntoRoot();
  assert.equal(result.workspacesConsolidated, 2);
  assert.equal(result.sessionsCopied, 4);

  // Root data.db must live next to control-plane.db.
  assert.equal(
    path.basename(store.rootRuntimeDbPath),
    "data.db",
  );
  assert.equal(
    path.dirname(store.rootRuntimeDbPath),
    path.dirname(store.controlPlaneDbPath),
  );
  assert.ok(fs.existsSync(store.rootRuntimeDbPath));

  store.close();

  // Read the root DB directly and assert sessions + projects landed correctly.
  const root = new Database(store.rootRuntimeDbPath, { readonly: true });
  try {
    const sessionRows = root
      .prepare(
        "SELECT session_id, project_id FROM agent_sessions ORDER BY session_id",
      )
      .all() as Array<{ session_id: string; project_id: string | null }>;
    const byId = new Map(sessionRows.map((row) => [row.session_id, row.project_id]));

    for (const sessionId of [...ws1.sessionIds]) {
      assert.equal(byId.get(sessionId), "ws-one", `${sessionId} tagged to ws-one`);
    }
    for (const sessionId of [...ws2.sessionIds]) {
      assert.equal(byId.get(sessionId), "ws-two", `${sessionId} tagged to ws-two`);
    }
    assert.equal(sessionRows.length, 4);

    const projectRows = root
      .prepare("SELECT project_id, name FROM projects ORDER BY project_id")
      .all() as Array<{ project_id: string; name: string }>;
    assert.deepEqual(
      projectRows,
      [
        { project_id: "ws-one", name: "One" },
        { project_id: "ws-two", name: "Two" },
      ],
    );

    // Session-descendant rows came across too (outputs).
    const outputRows = root
      .prepare("SELECT id FROM outputs ORDER BY id")
      .all() as Array<{ id: string }>;
    const outputIds = new Set(outputRows.map((row) => row.id));
    assert.ok(outputIds.has(ws1.outputId), "ws-one output copied");
    assert.ok(outputIds.has(ws2.outputId), "ws-two output copied");
  } finally {
    root.close();
  }
});

test("consolidate is idempotent and leaves per-workspace DBs intact as backup", () => {
  const store = makeStore();

  // Latch the on-first-open auto-consolidation with nothing to fold (see the
  // fold test) so the explicit `first` run below is the one that does the work.
  store.consolidateWorkspaceRuntimeDbsIntoRoot();

  seedWorkspace(store, "ws-a", "Alpha");
  seedWorkspace(store, "ws-b", "Beta");

  const first = store.consolidateWorkspaceRuntimeDbsIntoRoot();
  assert.equal(first.workspacesConsolidated, 2);
  assert.equal(first.sessionsCopied, 4);

  // Second run: no new work, no throw, no duplicates.
  const second = store.consolidateWorkspaceRuntimeDbsIntoRoot();
  assert.equal(second.workspacesConsolidated, 0);
  assert.equal(second.sessionsCopied, 0);

  const workspaceRoot = store.workspaceRoot;
  const rootPath = store.rootRuntimeDbPath;
  store.close();

  // Root has exactly one row per session per project — no duplication.
  const root = new Database(rootPath, { readonly: true });
  try {
    const sessionCount = (
      root.prepare("SELECT COUNT(*) AS c FROM agent_sessions").get() as {
        c: number;
      }
    ).c;
    assert.equal(sessionCount, 4);
    const projectCount = (
      root.prepare("SELECT COUNT(*) AS c FROM projects").get() as { c: number }
    ).c;
    assert.equal(projectCount, 2);
  } finally {
    root.close();
  }

  // Backup intact: original per-workspace runtime.db files still exist and
  // still carry their sessions (consolidation copies, never moves/deletes).
  for (const [workspaceId, sessionIds] of [
    ["ws-a", ["ws-a-sess-a", "ws-a-sess-b"]],
    ["ws-b", ["ws-b-sess-a", "ws-b-sess-b"]],
  ] as Array<[string, string[]]>) {
    const file = workspaceRuntimeDbFile(workspaceRoot, workspaceId);
    assert.ok(fs.existsSync(file), `${workspaceId} runtime.db still present`);
    const wsDb = new Database(file, { readonly: true });
    try {
      const rows = wsDb
        .prepare("SELECT session_id FROM agent_sessions ORDER BY session_id")
        .all() as Array<{ session_id: string }>;
      assert.deepEqual(
        rows.map((row) => row.session_id),
        sessionIds,
        `${workspaceId} backup sessions intact`,
      );
    } finally {
      wsDb.close();
    }
  }
});

test("consolidate preserves a pre-existing non-null project_id on a session", () => {
  const store = makeStore();

  // Latch the on-first-open auto-consolidation (nothing to fold yet).
  store.consolidateWorkspaceRuntimeDbsIntoRoot();

  ensureWorkspacesTable(store);
  insertWorkspaceRow(store, "ws-proj", "WithProject");
  // Seed the per-workspace source file directly: a session that already belongs
  // to an inner project (non-null project_id) keeps it; a plain session
  // (project_id NULL) gets tagged to the workspace by consolidation.
  seedWorkspaceRuntimeDbFile(store.workspaceRoot, "ws-proj", (db) => {
    const insertSession = db.prepare(`
      INSERT INTO agent_sessions (session_id, kind, project_id, created_at, updated_at)
      VALUES (?, 'main_session', ?, ?, ?)
    `);
    insertSession.run("inner", "inner-project", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    insertSession.run("plain", null, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  });

  store.consolidateWorkspaceRuntimeDbsIntoRoot();
  const rootPath = store.rootRuntimeDbPath;
  store.close();

  const root = new Database(rootPath, { readonly: true });
  try {
    const rows = root
      .prepare("SELECT session_id, project_id FROM agent_sessions")
      .all() as Array<{ session_id: string; project_id: string | null }>;
    const byId = new Map(rows.map((row) => [row.session_id, row.project_id]));
    assert.equal(byId.get("inner"), "inner-project", "inner project preserved");
    assert.equal(byId.get("plain"), "ws-proj", "plain session tagged to workspace");
  } finally {
    root.close();
  }
});

// ---------------------------------------------------------------------------
// Piece 5.6: the legacy host-state monolith fold.
//
// A deployment whose runtime data still lives in the legacy host-state monolith
// (`store.dbPath`, opened by `db()`) — sessions/outputs/etc. tagged with a
// `workspace_id` discriminator — must also be folded into the root data.db, or
// that data is invisible after the single-tenant flip. We seed the monolith file
// directly with the legacy session/output tables (WITH a `workspace_id` column),
// then let consolidation fold it in.
// ---------------------------------------------------------------------------

/**
 * Write the legacy host-state monolith db at `store.dbPath` directly, seeding
 * `agent_sessions` + `outputs` tables that carry the historical `workspace_id`
 * discriminator. `user_version` is pinned to a high number so when `db()` later
 * opens this file it treats it as already-migrated (mirroring a real upgraded
 * deployment) and does NOT run the migration chain — only `ensureRuntimeDbSchema`
 * runs, adding the `workspaces` table. The seeded `workspace_id` columns survive,
 * exactly as in production (where migration 028/029's `workspaces`-guard no-ops).
 */
function seedHostStateMonolith(
  store: RuntimeStateStore,
  seed: (db: Database.Database) => void,
): void {
  fs.mkdirSync(path.dirname(store.dbPath), { recursive: true });
  const db = new Database(store.dbPath);
  try {
    // Legacy monolith shape: the session/runtime tables carried a workspace_id
    // discriminator (they predate the per-workspace-DB schema split). Mirror the
    // columns the modern root tables have, plus workspace_id + project_id.
    db.exec(`
      CREATE TABLE agent_sessions (
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'main_session',
          title TEXT,
          parent_session_id TEXT,
          source_proposal_id TEXT,
          created_by TEXT,
          workflow_run_id TEXT,
          project_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          active_user_question TEXT,
          PRIMARY KEY (workspace_id, session_id)
      );
      CREATE TABLE outputs (
          workspace_id TEXT NOT NULL,
          id TEXT NOT NULL,
          project_id TEXT,
          output_type TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft',
          module_id TEXT,
          module_resource_id TEXT,
          file_path TEXT,
          html_content TEXT,
          session_id TEXT,
          input_id TEXT,
          artifact_id TEXT,
          folder_id TEXT,
          platform TEXT,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (workspace_id, id)
      );
    `);
    // Pin to "already fully migrated" so db() skips the migration chain on open.
    db.pragma("user_version = 1000");
    seed(db);
  } finally {
    db.close();
  }
}

test("consolidation folds the legacy host-state monolith into the root, mapping workspace_id → project_id", () => {
  const store = makeStore();

  // Latch the on-first-open auto-consolidation while there is NOTHING to fold
  // (no monolith file yet, so its fold no-ops without opening db()). This makes
  // the explicit call below — not a hidden re-entrant auto-run — the run whose
  // returned count is observable. Seeding the monolith only AFTER this keeps the
  // monolith's db() handle from being opened/cached during the latch.
  store.consolidateWorkspaceRuntimeDbsIntoRoot();

  // Seed the monolith BEFORE db() is first opened (the createWorkspace below is
  // what opens + caches it). Two distinct workspace ids: "mono-one" is a
  // registered workspace (nice project name); "mono-gone" is a HARD-DELETED
  // workspace (no registry row) — its rows must still be folded, falling back to
  // the id as the project name.
  seedHostStateMonolith(store, (db) => {
    const insertSession = db.prepare(`
      INSERT INTO agent_sessions (workspace_id, session_id, kind, title, project_id, created_at, updated_at)
      VALUES (?, ?, 'main_session', ?, NULL, ?, ?)
    `);
    insertSession.run("mono-one", "mono-one-sess", "One session", "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
    insertSession.run("mono-gone", "mono-gone-sess", "Gone session", "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
    // An output tagged by workspace_id, tied to the mono-one session.
    db.prepare(`
      INSERT INTO outputs (workspace_id, id, output_type, title, status, html_content, session_id, created_at, updated_at)
      VALUES (?, ?, 'document', ?, 'ready', ?, ?, ?, ?)
    `).run("mono-one", "mono-one-output", "One output", "<p>one</p>", "mono-one-sess", "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
  });

  // Register only "mono-one" so it gets a friendly project name; "mono-gone"
  // stays unregistered (hard-deleted) and must still fold.
  ensureWorkspacesTable(store);
  insertWorkspaceRow(store, "mono-one", "Mono One");

  const result = store.consolidateWorkspaceRuntimeDbsIntoRoot();
  // Both monolith sessions were copied (no per-workspace files exist here).
  assert.equal(result.sessionsCopied, 2);

  const rootPath = store.rootRuntimeDbPath;
  store.close();

  const root = new Database(rootPath, { readonly: true });
  try {
    const sessionRows = root
      .prepare("SELECT session_id, project_id FROM agent_sessions ORDER BY session_id")
      .all() as Array<{ session_id: string; project_id: string | null }>;
    const byId = new Map(sessionRows.map((row) => [row.session_id, row.project_id]));
    assert.equal(byId.get("mono-one-sess"), "mono-one", "registered workspace session tagged to its project");
    assert.equal(byId.get("mono-gone-sess"), "mono-gone", "hard-deleted workspace session still folded + tagged");

    // A projects row exists per DISTINCT workspace_id present in the monolith.
    const projectRows = root
      .prepare("SELECT project_id, name FROM projects ORDER BY project_id")
      .all() as Array<{ project_id: string; name: string }>;
    const projectsById = new Map(projectRows.map((row) => [row.project_id, row.name]));
    assert.equal(projectsById.get("mono-one"), "Mono One", "registered project uses registry name");
    assert.equal(projectsById.get("mono-gone"), "mono-gone", "hard-deleted project falls back to id as name");

    // The workspace_id-tagged output came across too (workspace_id dropped).
    const outputRows = root
      .prepare("SELECT id FROM outputs ORDER BY id")
      .all() as Array<{ id: string }>;
    assert.ok(new Set(outputRows.map((row) => row.id)).has("mono-one-output"), "monolith output copied");
    // Root outputs has no workspace_id column — confirm the copy dropped it.
    const outputColumns = (root.prepare("PRAGMA table_info(outputs)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.equal(outputColumns.includes("workspace_id"), false, "root outputs never gains a workspace_id column");
  } finally {
    root.close();
  }
});

test("monolith fold re-tags a session ALREADY in root that has a NULL project_id (regression: INSERT OR IGNORE orphaned sessions)", () => {
  const store = makeStore();

  // Latch the auto-consolidation with nothing to fold: root schema now exists and
  // the monolith fold has NOT run (no file yet, marker unset).
  store.consolidateWorkspaceRuntimeDbsIntoRoot();

  // A session that ALREADY lives in the root data.db with a NULL project_id —
  // exactly the row INSERT OR IGNORE skips, which used to leave it orphaned.
  const rootSeed = new Database(store.rootRuntimeDbPath);
  rootSeed.pragma("busy_timeout = 5000");
  try {
    rootSeed
      .prepare(
        `INSERT INTO agent_sessions (session_id, kind, project_id, created_at, updated_at)
         VALUES (?, 'main_session', NULL, ?, ?)`,
      )
      .run("dup-sess", "2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z");
  } finally {
    rootSeed.close();
  }

  // The monolith carries the SAME session id under a workspace_id (its project).
  seedHostStateMonolith(store, (db) => {
    db.prepare(
      `INSERT INTO agent_sessions (workspace_id, session_id, kind, project_id, created_at, updated_at)
       VALUES (?, ?, 'main_session', NULL, ?, ?)`,
    ).run("dup-ws", "dup-sess", "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
  });
  ensureWorkspacesTable(store);
  insertWorkspaceRow(store, "dup-ws", "Dup Workspace");

  store.consolidateWorkspaceRuntimeDbsIntoRoot();

  const rootPath = store.rootRuntimeDbPath;
  store.close();

  const root = new Database(rootPath, { readonly: true });
  try {
    const projectId = (
      root
        .prepare("SELECT project_id FROM agent_sessions WHERE session_id = ?")
        .get("dup-sess") as { project_id: string | null }
    ).project_id;
    assert.equal(
      projectId,
      "dup-ws",
      "pre-existing NULL root session is re-tagged to its monolith workspace's project",
    );
  } finally {
    root.close();
  }
});

test("host-state monolith fold is idempotent — a re-run copies 0 rows and creates no duplicates", () => {
  const store = makeStore();

  // Latch the auto-consolidation with nothing to fold (see the fold test).
  store.consolidateWorkspaceRuntimeDbsIntoRoot();

  seedHostStateMonolith(store, (db) => {
    db.prepare(`
      INSERT INTO agent_sessions (workspace_id, session_id, kind, project_id, created_at, updated_at)
      VALUES (?, ?, 'main_session', NULL, ?, ?)
    `).run("mono-x", "mono-x-sess", "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
  });
  ensureWorkspacesTable(store);
  insertWorkspaceRow(store, "mono-x", "Mono X");

  const first = store.consolidateWorkspaceRuntimeDbsIntoRoot();
  assert.equal(first.sessionsCopied, 1);

  // Re-run: INSERT OR IGNORE everywhere → no new rows, no throw, no dups.
  const second = store.consolidateWorkspaceRuntimeDbsIntoRoot();
  assert.equal(second.sessionsCopied, 0);

  const rootPath = store.rootRuntimeDbPath;
  store.close();

  const root = new Database(rootPath, { readonly: true });
  try {
    const sessionCount = (root.prepare("SELECT COUNT(*) AS c FROM agent_sessions").get() as { c: number }).c;
    assert.equal(sessionCount, 1, "exactly one session row — no duplication");
    const projectCount = (root.prepare("SELECT COUNT(*) AS c FROM projects WHERE project_id = 'mono-x'").get() as { c: number }).c;
    assert.equal(projectCount, 1, "exactly one projects row for the monolith workspace");
  } finally {
    root.close();
  }
});

test("a project deleted after the monolith fold is NOT resurrected on the next launch", () => {
  // The reported bug: a release folded legacy workspaces into `projects`, the user
  // deleted some of those projects, and installing a LATER release re-ran the fold
  // — INSERT OR IGNORE re-created every deleted project, because the monolith backup
  // file is kept on disk forever. The persisted `host_state_monolith_folded` marker
  // must make the monolith fold strictly one-time, so a delete after the first fold
  // stays deleted across restarts / release installs.
  const store = makeStore();

  // Latch the auto-consolidation with nothing to fold (no monolith file yet).
  store.consolidateWorkspaceRuntimeDbsIntoRoot();

  // A legacy workspace whose runtime data lives only in the host-state monolith.
  seedHostStateMonolith(store, (db) => {
    db.prepare(`
      INSERT INTO agent_sessions (workspace_id, session_id, kind, project_id, created_at, updated_at)
      VALUES (?, ?, 'main_session', NULL, ?, ?)
    `).run("ws-deleted", "ws-deleted-sess", "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
  });
  ensureWorkspacesTable(store);
  insertWorkspaceRow(store, "ws-deleted", "Old Workspace");

  // First fold: creates the `projects` row for the legacy workspace + marks done.
  const first = store.consolidateWorkspaceRuntimeDbsIntoRoot();
  assert.equal(first.sessionsCopied, 1);

  // The user deletes that project (exactly as they would from the desktop UI).
  store.deleteWorkspaceProject({
    workspaceId: "ws-deleted",
    projectId: "ws-deleted",
  });
  const afterDelete = new Database(store.rootRuntimeDbPath, { readonly: true });
  try {
    const c = (
      afterDelete
        .prepare("SELECT COUNT(*) AS c FROM projects WHERE project_id = 'ws-deleted'")
        .get() as { c: number }
    ).c;
    assert.equal(c, 0, "project is gone right after the user deletes it");
  } finally {
    afterDelete.close();
  }

  // Simulate the next release install / app restart: a FRESH store over the SAME
  // files (fresh in-memory #rootConsolidated latch + root handle). The monolith file
  // is still on disk. WITHOUT the persisted marker, this fold would re-create the
  // deleted "ws-deleted" project — the exact bug being fixed here.
  const paths = {
    dbPath: store.dbPath,
    controlPlaneDbPath: store.controlPlaneDbPath,
    workspaceRoot: store.workspaceRoot,
  };
  store.close();

  const reopened = new RuntimeStateStore(paths);
  const second = reopened.consolidateWorkspaceRuntimeDbsIntoRoot();
  // The monolith fold is skipped by the marker — nothing re-copied.
  assert.equal(second.sessionsCopied, 0, "monolith fold is skipped on the restart");

  const rootPath = reopened.rootRuntimeDbPath;
  reopened.close();

  const root = new Database(rootPath, { readonly: true });
  try {
    const resurrected = (
      root
        .prepare("SELECT COUNT(*) AS c FROM projects WHERE project_id = 'ws-deleted'")
        .get() as { c: number }
    ).c;
    assert.equal(resurrected, 0, "deleted project is NOT resurrected after the release install");
  } finally {
    root.close();
  }
});

test("per-workspace runtime.db rows win over the host-state monolith on PK collisions", () => {
  const store = makeStore();

  // Latch the on-first-open auto-consolidation with nothing to fold.
  store.consolidateWorkspaceRuntimeDbsIntoRoot();

  // Same workspace id + session id exist in BOTH a per-workspace runtime.db FILE
  // and the monolith, but with different titles. The per-workspace file is folded
  // FIRST (before the monolith), so its row must win the INSERT OR IGNORE.
  const sharedWorkspaceId = "ws-collide";
  const sharedSessionId = "ws-collide-sess-a"; // matches seedWorkspace's naming

  // Seed the monolith FIRST (before db() is opened/cached by seedWorkspace's
  // createWorkspace): same session id, but a DIFFERENT title, tagged via
  // workspace_id. It must LOSE the PK collision to the per-workspace file row.
  seedHostStateMonolith(store, (db) => {
    db.prepare(`
      INSERT INTO agent_sessions (workspace_id, session_id, kind, title, project_id, created_at, updated_at)
      VALUES (?, ?, 'main_session', ?, NULL, ?, ?)
    `).run(sharedWorkspaceId, sharedSessionId, "MONOLITH TITLE (should lose)", "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
  });

  // Per-workspace file: seedWorkspace registers the workspace AND writes sessions
  // "<ws>-sess-a"/"-sess-b" into its runtime.db file. This row is folded FIRST.
  const ws = seedWorkspace(store, sharedWorkspaceId, "Collide");
  assert.ok(ws.sessionIds.includes(sharedSessionId));

  store.consolidateWorkspaceRuntimeDbsIntoRoot();
  const rootPath = store.rootRuntimeDbPath;
  store.close();

  const root = new Database(rootPath, { readonly: true });
  try {
    const row = root
      .prepare("SELECT title, project_id FROM agent_sessions WHERE session_id = ?")
      .get(sharedSessionId) as { title: string | null; project_id: string | null };
    // The per-workspace file's row (folded first) wins — its title is "Collide A".
    assert.equal(row.title, "Collide A", "per-workspace file row wins the PK collision");
    assert.equal(row.project_id, sharedWorkspaceId, "still tagged to the workspace's project");
    // Exactly one row for that session id — the monolith's duplicate was ignored.
    const count = (root.prepare("SELECT COUNT(*) AS c FROM agent_sessions WHERE session_id = ?").get(sharedSessionId) as { c: number }).c;
    assert.equal(count, 1, "no duplicate session row");
  } finally {
    root.close();
  }
});

test("migration 028 no-ops on a workspaces-bearing db, preserving agent_sessions.workspace_id", () => {
  // The host-state monolith / control-plane DB carries the `workspaces` registry
  // and uses workspace_id as the multi-workspace discriminator the monolith fold
  // depends on. Migration 028 must NOT strip it there (mirrors migration 029).
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          workspace_path TEXT NOT NULL,
          name TEXT NOT NULL
      );
      CREATE TABLE agent_sessions (
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'main_session',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (workspace_id, session_id)
      );
      INSERT INTO agent_sessions (workspace_id, session_id, created_at, updated_at)
      VALUES ('ws-1', 'sess-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);

    const applied = new MigrationRunner([dropWorkspaceIdSessionTablesMigration]).apply(db);
    assert.equal(applied, 1, "migration ran (and no-op'd internally)");

    const columns = (db.prepare("PRAGMA table_info(agent_sessions)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.equal(columns.includes("workspace_id"), true, "workspace_id preserved on a workspaces-bearing db");
    const row = db.prepare("SELECT workspace_id FROM agent_sessions WHERE session_id = 'sess-1'").get() as { workspace_id: string };
    assert.equal(row.workspace_id, "ws-1", "the discriminator value is intact");
  } finally {
    db.close();
  }
});

test("migration 028 still strips workspace_id on a per-workspace db (no workspaces table)", () => {
  // The root data.db / per-workspace DBs have NO `workspaces` table, so 028 must
  // still run there as before — Part 1's guard must not regress that path.
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE agent_sessions (
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'main_session',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (workspace_id, session_id)
      );
      INSERT INTO agent_sessions (workspace_id, session_id, created_at, updated_at)
      VALUES ('ws-1', 'sess-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);

    new MigrationRunner([dropWorkspaceIdSessionTablesMigration]).apply(db);

    const columns = (db.prepare("PRAGMA table_info(agent_sessions)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.equal(columns.includes("workspace_id"), false, "workspace_id stripped on a per-workspace db");
    const row = db.prepare("SELECT session_id FROM agent_sessions WHERE session_id = 'sess-1'").get() as { session_id: string };
    assert.equal(row.session_id, "sess-1", "the row itself survives the rebuild");
  } finally {
    db.close();
  }
});
