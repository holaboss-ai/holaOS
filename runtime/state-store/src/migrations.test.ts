import test from "node:test";
import assert from "node:assert/strict";

import Database from "better-sqlite3";

import {
  MigrationRunner,
  type Migration,
  type MigrationLogEvent,
} from "./migrations.js";
import { migration as workspacePluginsMigration } from "./migrations/001-workspace-plugins.js";
import { migration as workflowRevisionsMigration } from "./migrations/002-workflow-revisions.js";
import { migration as baseObjectRecordWorkflowProvenanceMigration } from "./migrations/003-base-object-record-workflow-provenance.js";
import { migration as removeTeammateRuntimeReferencesMigration } from "./migrations/005-remove-teammate-runtime-references.js";
import { migration as workflowRunTokenTotalsMigration } from "./migrations/007-workflow-run-token-totals.js";
import { migration as relaxCronjobsTeammateNotNullMigration } from "./migrations/009-relax-cronjobs-teammate-not-null.js";
import { migration as renameAddonsToCapabilitiesMigration } from "./migrations/020-rename-addons-to-capabilities.js";

function readUserVersion(db: Database.Database): number {
  const row = db.pragma("user_version") as Array<{ user_version: number }>;
  return row[0]?.user_version ?? 0;
}

function recorder() {
  const events: MigrationLogEvent[] = [];
  return {
    log: (event: MigrationLogEvent) => events.push(event),
    events,
  };
}

test("applies all migrations on a fresh DB", () => {
  const db = new Database(":memory:");
  const m1: Migration = {
    id: 1,
    name: "create-foo",
    up: (d) => d.exec(`CREATE TABLE foo (id INTEGER PRIMARY KEY)`),
  };
  const m2: Migration = {
    id: 2,
    name: "create-bar",
    up: (d) => d.exec(`CREATE TABLE bar (id INTEGER PRIMARY KEY, foo_id INTEGER REFERENCES foo(id))`),
  };

  const rec = recorder();
  const applied = new MigrationRunner([m1, m2], { log: rec.log }).apply(db);

  assert.equal(applied, 2);
  assert.equal(readUserVersion(db), 2);
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
    [{ name: "bar" }, { name: "foo" }],
  );
  const events = rec.events.map((e) => e.event);
  assert.deepEqual(events, [
    "migrations.start",
    "migrations.apply",
    "migrations.applied",
    "migrations.apply",
    "migrations.applied",
    "migrations.complete",
  ]);
});

test("idempotent — second apply is a no-op", () => {
  const db = new Database(":memory:");
  const m1: Migration = {
    id: 1,
    name: "create-foo",
    up: (d) => d.exec(`CREATE TABLE foo (id INTEGER PRIMARY KEY)`),
  };

  const runner = new MigrationRunner([m1]);
  assert.equal(runner.apply(db), 1);
  assert.equal(runner.apply(db), 0);
  assert.equal(readUserVersion(db), 1);
});

test("applies only pending migrations when DB is partially up-to-date", () => {
  const db = new Database(":memory:");
  const m1: Migration = {
    id: 1,
    name: "create-foo",
    up: (d) => d.exec(`CREATE TABLE foo (id INTEGER PRIMARY KEY)`),
  };
  const m2: Migration = {
    id: 2,
    name: "create-bar",
    up: (d) => d.exec(`CREATE TABLE bar (id INTEGER PRIMARY KEY)`),
  };

  // Simulate a DB previously at version 1 — and the foo table existing
  db.exec(`CREATE TABLE foo (id INTEGER PRIMARY KEY)`);
  db.pragma("user_version = 1");

  const applied = new MigrationRunner([m1, m2]).apply(db);

  assert.equal(applied, 1);
  assert.equal(readUserVersion(db), 2);
  const barExists =
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bar'").get();
  assert.deepEqual(barExists, { name: "bar" });
});

test("rolls back on failure and leaves user_version untouched", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE foo (id INTEGER PRIMARY KEY)`);

  const broken: Migration = {
    id: 1,
    name: "broken",
    up: (d) => {
      d.exec(`CREATE TABLE bar (id INTEGER PRIMARY KEY)`);
      // Force failure mid-transaction
      d.exec(`THIS_IS_NOT_VALID_SQL`);
    },
  };

  const rec = recorder();
  assert.throws(() => new MigrationRunner([broken], { log: rec.log }).apply(db));

  // user_version did not advance
  assert.equal(readUserVersion(db), 0);
  // bar was not created (transaction rolled back)
  const barExists =
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bar'").get();
  assert.equal(barExists, undefined);
  // failure was logged
  assert.ok(rec.events.some((e) => e.event === "migrations.failed"));
});

test("legacy DB fast-forward: jumps user_version to seed when DB has tables but version=0", () => {
  const db = new Database(":memory:");
  // Simulate legacy state — tables exist but user_version is 0
  db.exec(`CREATE TABLE legacy_table (id INTEGER PRIMARY KEY)`);
  assert.equal(readUserVersion(db), 0);

  const m1: Migration = {
    id: 1,
    name: "below-seed",
    up: () => {
      throw new Error("should not run on legacy DB at seed=2");
    },
  };
  const m2: Migration = {
    id: 2,
    name: "at-seed",
    up: () => {
      throw new Error("should not run on legacy DB at seed=2");
    },
  };
  const m3: Migration = {
    id: 3,
    name: "above-seed",
    up: (d) => d.exec(`CREATE TABLE post_seed (id INTEGER PRIMARY KEY)`),
  };

  const rec = recorder();
  const applied = new MigrationRunner([m1, m2, m3], {
    log: rec.log,
    latestSeedVersion: 2,
  }).apply(db);

  assert.equal(applied, 1);
  assert.equal(readUserVersion(db), 3);
  const postSeedExists =
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='post_seed'").get();
  assert.deepEqual(postSeedExists, { name: "post_seed" });
  assert.ok(rec.events.some((e) => e.event === "migrations.skip_to_seed"));
});

test("fresh DB (no tables) ignores latestSeedVersion and runs all", () => {
  const db = new Database(":memory:");
  // No tables at all → not legacy → runner applies everything from 0
  const m1: Migration = {
    id: 1,
    name: "first",
    up: (d) => d.exec(`CREATE TABLE one (id INTEGER PRIMARY KEY)`),
  };
  const m2: Migration = {
    id: 2,
    name: "second",
    up: (d) => d.exec(`CREATE TABLE two (id INTEGER PRIMARY KEY)`),
  };

  const applied = new MigrationRunner([m1, m2], { latestSeedVersion: 1 }).apply(db);
  assert.equal(applied, 2);
  assert.equal(readUserVersion(db), 2);
});

test("rejects duplicate migration ids", () => {
  assert.throws(
    () =>
      new MigrationRunner([
        { id: 1, name: "a", up: () => {} },
        { id: 1, name: "b", up: () => {} },
      ]),
    /Duplicate migration id 1/,
  );
});

test("rejects non-positive integer ids", () => {
  assert.throws(
    () => new MigrationRunner([{ id: 0, name: "zero", up: () => {} }]),
    /must be a positive integer/,
  );
  assert.throws(
    () => new MigrationRunner([{ id: -1, name: "neg", up: () => {} }]),
    /must be a positive integer/,
  );
  assert.throws(
    () => new MigrationRunner([{ id: 1.5, name: "frac", up: () => {} }]),
    /must be a positive integer/,
  );
});

test("normalizes input order — accepts unsorted migrations", () => {
  const db = new Database(":memory:");
  const m1: Migration = {
    id: 1,
    name: "first",
    up: (d) => d.exec(`CREATE TABLE one (id INTEGER PRIMARY KEY)`),
  };
  const m2: Migration = {
    id: 2,
    name: "second",
    up: (d) =>
      d.exec(
        `CREATE TABLE two (id INTEGER PRIMARY KEY, one_id INTEGER REFERENCES one(id))`,
      ),
  };

  const applied = new MigrationRunner([m2, m1]).apply(db);
  assert.equal(applied, 2);
  assert.equal(readUserVersion(db), 2);
});

test("empty migration list is a no-op", () => {
  const db = new Database(":memory:");
  const applied = new MigrationRunner([]).apply(db);
  assert.equal(applied, 0);
  assert.equal(readUserVersion(db), 0);
});

test("workspace plugin migration no-ops on a control-plane-only schema", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL
    );
  `);

  const applied = new MigrationRunner([workspacePluginsMigration]).apply(db);

  assert.equal(applied, 1);
  assert.equal(readUserVersion(db), 1);
  const workspacePluginsTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_plugins'")
    .get();
  assert.equal(workspacePluginsTable, undefined);
});

test("workflow revision migration backfills revisions and assigns legacy runs", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE workflows (
      workflow_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      plugin_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_by TEXT,
      nodes TEXT NOT NULL DEFAULT '[]',
      edges TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      last_test_run_id TEXT,
      last_test_status TEXT,
      last_test_summary TEXT,
      last_test_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE TABLE workflow_runs (
      run_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'test',
      status TEXT NOT NULL DEFAULT 'needs_attention',
      summary TEXT NOT NULL,
      triggered_by TEXT,
      result TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.exec(`
    INSERT INTO workflows (
      workflow_id, workspace_id, plugin_id, name, description, status, created_by, nodes, edges, metadata, created_at, updated_at, archived_at
    ) VALUES (
      'workflow-1', 'workspace-1', 'core', 'Legacy workflow', 'Before revisions', 'active', 'desktop', '[]', '[]', '{}', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', NULL
    );
    INSERT INTO workflow_runs (
      run_id, workflow_id, workspace_id, mode, status, summary, triggered_by, result, started_at, completed_at, created_at, updated_at
    ) VALUES (
      'run-1', 'workflow-1', 'workspace-1', 'live', 'completed', 'Legacy run', 'desktop', '{}', '2026-01-02T00:00:00.000Z', '2026-01-02T00:05:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-02T00:05:00.000Z'
    );
  `);

  const applied = new MigrationRunner([workflowRevisionsMigration]).apply(db);

  assert.equal(applied, 1);
  assert.equal(readUserVersion(db), 2);
  const revision = db.prepare(`
    SELECT workflow_id, workspace_id, plugin_id, revision_number, name
    FROM workflow_revisions
    LIMIT 1
  `).get() as Record<string, unknown> | undefined;
  assert.deepEqual(revision, {
    workflow_id: "workflow-1",
    workspace_id: "workspace-1",
    plugin_id: "core",
    revision_number: 1,
    name: "Legacy workflow",
  });
  const runRow = db.prepare(`
    SELECT workflow_revision_id
    FROM workflow_runs
    WHERE run_id = 'run-1'
  `).get() as { workflow_revision_id: string | null } | undefined;
  assert.ok(runRow?.workflow_revision_id);
});

test("base object record workflow provenance migration adds retrace columns", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE base_object_records (
      record_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      base_id TEXT NOT NULL,
      object_id TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}',
      created_by TEXT,
      updated_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );
  `);
  db.exec(`
    INSERT INTO base_object_records (
      record_id, workspace_id, base_id, object_id, data_json, created_by, updated_by, created_at, updated_at, archived_at
    ) VALUES (
      'record-1', 'workspace-1', 'base-1', 'object-1', '{}', 'desktop', 'desktop', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    );
  `);

  const applied = new MigrationRunner([baseObjectRecordWorkflowProvenanceMigration]).apply(db);

  assert.equal(applied, 1);
  assert.equal(readUserVersion(db), 3);
  const columns = (
    db.prepare("PRAGMA table_info(base_object_records)").all() as Array<{ name: string }>
  ).map((row) => row.name);
  assert.ok(columns.includes("created_by_workflow_id"));
  assert.ok(columns.includes("created_by_workflow_revision_id"));
  assert.ok(columns.includes("created_by_workflow_run_id"));
  assert.ok(columns.includes("created_by_workflow_node_run_id"));
  const row = db.prepare(`
    SELECT
      created_by_workflow_id,
      created_by_workflow_revision_id,
      created_by_workflow_run_id,
      created_by_workflow_node_run_id
    FROM base_object_records
    WHERE record_id = 'record-1'
  `).get() as Record<string, unknown> | undefined;
  assert.deepEqual(row, {
    created_by_workflow_id: null,
    created_by_workflow_revision_id: null,
    created_by_workflow_run_id: null,
    created_by_workflow_node_run_id: null,
  });
});

test("workflow run token totals migration adds token columns idempotently", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE workflow_runs (
      run_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'test',
      status TEXT NOT NULL DEFAULT 'needs_attention',
      summary TEXT NOT NULL,
      triggered_by TEXT,
      result TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO workflow_runs (
      run_id, workflow_id, workspace_id, mode, status, summary, triggered_by,
      result, started_at, completed_at, created_at, updated_at
    ) VALUES (
      'run-pre', 'wf-1', 'ws-1', 'live', 'completed', 'pre-migration run', 'desktop',
      '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z'
    );
  `);

  const applied = new MigrationRunner([workflowRunTokenTotalsMigration]).apply(db);
  assert.equal(applied, 1);

  const columns = new Set<string>(
    (
      db.prepare("PRAGMA table_info(workflow_runs)").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name),
  );
  for (const name of [
    "tokens_input",
    "tokens_output",
    "tokens_cached_input",
    "tokens_by_model",
  ]) {
    assert.ok(columns.has(name), `expected column ${name}`);
  }

  const row = db
    .prepare(
      "SELECT tokens_input, tokens_output, tokens_cached_input, tokens_by_model FROM workflow_runs WHERE run_id = ?",
    )
    .get("run-pre") as Record<string, unknown> | undefined;
  assert.deepEqual(row, {
    tokens_input: 0,
    tokens_output: 0,
    tokens_cached_input: 0,
    tokens_by_model: "{}",
  });

  // Re-running is a no-op.
  const reApplied = new MigrationRunner([
    workflowRunTokenTotalsMigration,
  ]).apply(db);
  assert.equal(reApplied, 0);
});

test("workflow run token totals migration no-ops when workflow_runs is absent", () => {
  const db = new Database(":memory:");
  const applied = new MigrationRunner([workflowRunTokenTotalsMigration]).apply(db);
  assert.equal(applied, 1); // user_version still advances
  const exists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_runs'",
    )
    .get();
  assert.equal(exists, undefined);
});

// Reproduces the crash in the Research-workspace diagnostic where the runtime
// looped on `NOT NULL constraint failed: cronjobs.teammate_id` during cron
// worker startup. Legacy DBs declared `teammate_id TEXT NOT NULL DEFAULT
// 'general'` inline at table creation; migration 005's UPDATE-to-NULL then
// crashed on any row carrying that default value.
test("cronjobs migration tolerates legacy NOT NULL teammate_id and relax-migration drops the constraint", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE cronjobs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      initiated_by TEXT NOT NULL,
      teammate_id TEXT NOT NULL DEFAULT 'general',
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
    INSERT INTO cronjobs (
      id, workspace_id, initiated_by, teammate_id, cron, description,
      delivery, created_at, updated_at
    ) VALUES (
      'job-1', 'ws-1', 'user', 'general', '* * * * *', 'legacy cron',
      '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
  `);

  // Migration 005 used to throw here on the SET-to-NULL — confirm it now
  // completes by writing '' instead, and that subsequent code can still read
  // the row.
  const applied5 = new MigrationRunner([
    removeTeammateRuntimeReferencesMigration,
  ]).apply(db);
  assert.equal(applied5, 1);
  assert.equal(
    (db.prepare("SELECT teammate_id FROM cronjobs WHERE id = ?").get("job-1") as {
      teammate_id: string;
    }).teammate_id,
    "",
  );

  // Migration 009 then rebuilds the table so the NOT NULL constraint is
  // permanently relaxed.
  const applied9 = new MigrationRunner([
    relaxCronjobsTeammateNotNullMigration,
  ]).apply(db);
  assert.equal(applied9, 1);
  const info = db.prepare("PRAGMA table_info(cronjobs)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  const teammate = info.find((row) => row.name === "teammate_id");
  assert.ok(teammate);
  assert.equal(teammate!.notnull, 0);
  // Empty-string-cleared values are normalized to NULL by the rebuild.
  const reread = db
    .prepare("SELECT teammate_id FROM cronjobs WHERE id = ?")
    .get("job-1") as { teammate_id: string | null };
  assert.equal(reread.teammate_id, null);
  // And future SET-to-NULL is now safe.
  db.exec("UPDATE cronjobs SET teammate_id = NULL");
  // Re-running migration 009 is a no-op.
  const applied9Again = new MigrationRunner([
    relaxCronjobsTeammateNotNullMigration,
  ]).apply(db);
  assert.equal(applied9Again, 0);
});

test("migration 009 is a no-op when cronjobs.teammate_id is already nullable", () => {
  const db = new Database(":memory:");
  // Mirrors a fresh-install DB where migration 005's ensureColumn added the
  // column nullable.
  db.exec(`
    CREATE TABLE cronjobs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      initiated_by TEXT NOT NULL,
      teammate_id TEXT,
      cron TEXT NOT NULL,
      description TEXT NOT NULL,
      delivery TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const applied = new MigrationRunner([
    relaxCronjobsTeammateNotNullMigration,
  ]).apply(db);
  assert.equal(applied, 1); // user_version still advances
  const info = db.prepare("PRAGMA table_info(cronjobs)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  const teammate = info.find((row) => row.name === "teammate_id");
  assert.ok(teammate);
  assert.equal(teammate!.notnull, 0);
});

test("migration 009 is a no-op when cronjobs table is absent", () => {
  const db = new Database(":memory:");
  const applied = new MigrationRunner([
    relaxCronjobsTeammateNotNullMigration,
  ]).apply(db);
  assert.equal(applied, 1); // user_version still advances
  const exists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cronjobs'",
    )
    .get();
  assert.equal(exists, undefined);
});

test("migration 020 renames workspace_addons → workspace_capabilities preserving rows", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE workspace_addons (
      workspace_id TEXT NOT NULL, addon_id TEXT NOT NULL, version TEXT,
      name TEXT NOT NULL, description TEXT, icon TEXT,
      status TEXT NOT NULL DEFAULT 'active', installed_skill_ids TEXT,
      integration_status TEXT, config_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, addon_id)
    );
    INSERT INTO workspace_addons (workspace_id, addon_id, name, status, created_at, updated_at)
    VALUES ('ws-1', 'competitor-watch', 'Competitor Watch', 'active',
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  const applied = new MigrationRunner([renameAddonsToCapabilitiesMigration]).apply(db);
  assert.equal(applied, 1);
  const oldGone = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_addons'",
  ).get();
  assert.equal(oldGone, undefined);
  const row = db.prepare(
    "SELECT capability_id, name FROM workspace_capabilities WHERE workspace_id='ws-1'",
  ).get() as { capability_id: string; name: string };
  assert.equal(row.capability_id, "competitor-watch");
  assert.equal(row.name, "Competitor Watch");
  // Re-run is a no-op.
  assert.equal(new MigrationRunner([renameAddonsToCapabilitiesMigration]).apply(db), 0);
});

import { migration as ensureSessionHarnessIdMigration } from "./migrations/021-ensure-session-harness-id.js";

test("migration 021 adds missing agent_sessions.harness_id and backfills 'pi'", () => {
  const db = new Database(":memory:");
  // Simulate a DB that skipped migration 018: agent_sessions without harness_id.
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
    VALUES ('ws-1', 'main-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  const before = db
    .prepare("PRAGMA table_info(agent_sessions)")
    .all() as Array<{ name: string }>;
  assert.equal(before.some((c) => c.name === "harness_id"), false);

  const applied = new MigrationRunner([ensureSessionHarnessIdMigration]).apply(db);
  assert.equal(applied, 1);

  const after = db
    .prepare("PRAGMA table_info(agent_sessions)")
    .all() as Array<{ name: string }>;
  assert.equal(after.some((c) => c.name === "harness_id"), true);
  assert.equal(
    (db.prepare("SELECT harness_id FROM agent_sessions WHERE session_id='main-1'").get() as { harness_id: string }).harness_id,
    "pi",
  );
  // Re-run is a no-op (column already present).
  assert.equal(new MigrationRunner([ensureSessionHarnessIdMigration]).apply(db), 0);
});

test("migration 021 is a no-op when harness_id already exists", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE agent_sessions (
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      harness_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, session_id)
    );
  `);
  const applied = new MigrationRunner([ensureSessionHarnessIdMigration]).apply(db);
  assert.equal(applied, 1);
  const cols = db.prepare("PRAGMA table_info(agent_sessions)").all() as Array<{ name: string }>;
  assert.equal(cols.filter((c) => c.name === "harness_id").length, 1);
});
