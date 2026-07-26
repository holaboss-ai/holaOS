import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import Database from "better-sqlite3";

import { runDebugCli } from "./debug-cli.js";
import { RuntimeStateStore } from "./store.js";

interface CliResult {
  exitCode: number;
  stdout: string;
  json: unknown;
}

async function runCli(argv: string[], dbPath: string): Promise<CliResult> {
  const lines: string[] = [];
  const exitCode = await runDebugCli({
    argv: ["--db-path", dbPath, ...argv],
    out: (line) => lines.push(line),
  });
  const stdout = lines.join("\n");
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = undefined;
  }
  return { exitCode, stdout, json };
}

function tmpDb(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `holaboss-cli-${name}-`));
  return path.join(dir, "runtime.db");
}

// Workspace-removal: the store no longer auto-creates the `workspaces` registry
// table (single-tenant synthetic root). `createWorkspace` still writes the legacy
// registry row, so tests that register a workspace must pre-create the table in
// the control-plane db (and the mirrored host-state db, which the debug CLI reads
// via --db-path). Full column set = the schema the store writes.
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
// on-disk folder. The table is pre-created by seedWorkspacesRegistry.
function insertWorkspaceRow(
  store: RuntimeStateStore,
  params: { workspaceId: string; name: string; status: string; onboardingStatus: string },
): void {
  const workspacePath = path.join(store.workspaceRoot, params.workspaceId);
  fs.mkdirSync(workspacePath, { recursive: true });
  const now = "2026-01-01T00:00:00.000Z";
  for (const file of new Set([store.controlPlaneDbPath, store.dbPath])) {
    const db = new Database(file);
    try {
      db.prepare(
        `INSERT OR IGNORE INTO workspaces (
            id, workspace_path, name, status, harness, onboarding_status,
            created_at, updated_at, workspace_role
         ) VALUES (?, ?, ?, ?, 'pi', ?, ?, ?, 'source')`,
      ).run(params.workspaceId, workspacePath, params.name, params.status, params.onboardingStatus, now, now);
    } finally {
      db.close();
    }
  }
}

function seedStore(dbPath: string): RuntimeStateStore {
  const workspaceRoot = path.dirname(dbPath);
  seedWorkspacesRegistry(dbPath);
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  insertWorkspaceRow(store, {
    workspaceId: "ws-1",
    name: "First",
    status: "active",
    onboardingStatus: "complete",
  });
  insertWorkspaceRow(store, {
    workspaceId: "ws-2",
    name: "Second",
    status: "provisioning",
    onboardingStatus: "pending",
  });
  // createWorkspace used to open the host-state db (running the migration chain)
  // before writing the registry row; the debug CLI reads that db read-only via
  // --db-path and asserts its schema version, so trigger the same migration here.
  // listWorkspaces() opens db()+controlPlaneDb() but NOT rootRuntimeDb(), so it
  // never fires the consolidation that would drop the freshly-seeded workspaces
  // table. Migrations leave the workspaces table (and its rows) untouched.
  store.listWorkspaces();
  return store;
}

test("help prints usage and exits 0", async () => {
  const dbPath = tmpDb("help");
  const result = await runCli(["help"], dbPath);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /holaboss-runtime/);
  assert.match(result.stdout, /Commands:/);
});

test("unknown command prints usage and exits 2", async () => {
  const dbPath = tmpDb("unknown");
  const result = await runCli(["does-not-exist"], dbPath);
  assert.equal(result.exitCode, 2);
  assert.match(result.stdout, /unknown command/);
});

test("migrations on a fresh DB shows the registered runtime migrations", async () => {
  const dbPath = tmpDb("migrations");
  // Just open + close to create the DB
  seedStore(dbPath).close();

  const result = await runCli(["migrations"], dbPath);
  assert.equal(result.exitCode, 0);
  const json = result.json as {
    current: number;
    target: number;
    seedVersion: number;
    pending: unknown[];
    registered: unknown[];
  };
  assert.equal(json.current, 33);
  assert.equal(json.target, 33);
  assert.equal(json.seedVersion, 0);
  assert.deepEqual(json.pending, []);
  assert.deepEqual(json.registered, [
    { id: 1, name: "workspace-plugins" },
    { id: 2, name: "workflow-revisions" },
    { id: 3, name: "base-object-record-workflow-provenance" },
    { id: 4, name: "workspace-plugin-templates" },
    { id: 5, name: "remove-teammate-runtime-references" },
    { id: 6, name: "rename-assignee-teammate-id" },
    { id: 7, name: "workflow-run-token-totals" },
    { id: 8, name: "workflow-run-id-on-sessions" },
    { id: 9, name: "relax-cronjobs-teammate-not-null" },
    { id: 10, name: "record-field-writes" },
    { id: 11, name: "record-feedback" },
    { id: 12, name: "workspace-projects" },
    { id: 13, name: "output-project-id" },
    { id: 14, name: "record-feedback-review-columns" },
    { id: 15, name: "evolution-proposals" },
    { id: 16, name: "plugin-kind-and-evolution-counter" },
    { id: 17, name: "agent-session-review-record" },
    { id: 18, name: "session-harness-id" },
    { id: 19, name: "workspace-addons" },
    { id: 20, name: "rename-addons-to-capabilities" },
    { id: 21, name: "ensure-session-harness-id" },
    { id: 22, name: "drop-workspace-integration-overrides" },
    { id: 23, name: "drop-evolve-tables" },
    { id: 24, name: "drop-plugin-base-workflow-tables" },
    { id: 25, name: "channel-connections" },
    { id: 26, name: "channel-connection-config" },
    { id: 27, name: "rename-workspace-projects-to-projects" },
    { id: 28, name: "drop-workspace-id-session-tables" },
    { id: 29, name: "drop-workspace-id-remaining-tables" },
    { id: 30, name: "integration-tables-control-plane-only" },
    { id: 31, name: "drop-local-composio-connections" },
    { id: 32, name: "session-owning-app-id" },
    { id: 33, name: "session-org-id" },
  ]);
});

test("tables lists known runtime tables with row counts", async () => {
  const dbPath = tmpDb("tables");
  seedStore(dbPath).close();

  const result = await runCli(["tables"], dbPath);
  assert.equal(result.exitCode, 0);
  const rows = result.json as Array<{ table: string; rows: number }>;
  const workspaces = rows.find((r) => r.table === "workspaces");
  assert.ok(workspaces, "workspaces table should be present");
  assert.equal(workspaces?.rows, 2);
});

test("dump <table> returns rows up to limit", async () => {
  const dbPath = tmpDb("dump");
  seedStore(dbPath).close();

  const result = await runCli(["dump", "workspaces"], dbPath);
  assert.equal(result.exitCode, 0);
  const rows = result.json as Array<{ id: string; name: string }>;
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.id).sort(),
    ["ws-1", "ws-2"],
  );
});

test("dump --limit N caps result count", async () => {
  const dbPath = tmpDb("dump-limit");
  seedStore(dbPath).close();

  const result = await runCli(["dump", "workspaces", "--limit", "1"], dbPath);
  assert.equal(result.exitCode, 0);
  const rows = result.json as unknown[];
  assert.equal(rows.length, 1);
});

test("dump --where col=val filters rows", async () => {
  const dbPath = tmpDb("dump-where");
  seedStore(dbPath).close();

  const result = await runCli(
    ["dump", "workspaces", "--where", "status=active"],
    dbPath,
  );
  assert.equal(result.exitCode, 0);
  const rows = result.json as Array<{ id: string; status: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "active");
});

test("dump rejects unsafe table names", async () => {
  const dbPath = tmpDb("dump-unsafe");
  seedStore(dbPath).close();

  const result = await runCli(["dump", "workspaces; DROP TABLE workspaces"], dbPath);
  assert.equal(result.exitCode, 2);
  assert.match(result.stdout, /unsafe/);
});

test("dump rejects negative limit", async () => {
  const dbPath = tmpDb("dump-neg");
  seedStore(dbPath).close();

  const result = await runCli(
    ["dump", "workspaces", "--limit", "-5"],
    dbPath,
  );
  assert.equal(result.exitCode, 2);
});

test("workspaces lists all workspaces sorted by recency", async () => {
  const dbPath = tmpDb("ws");
  seedStore(dbPath).close();

  const result = await runCli(["workspaces"], dbPath);
  assert.equal(result.exitCode, 0);
  const rows = result.json as Array<{ id: string; status: string }>;
  assert.equal(rows.length, 2);
});

test("sessions <workspace> requires workspace id", async () => {
  const dbPath = tmpDb("sess-noarg");
  seedStore(dbPath).close();

  const result = await runCli(["sessions"], dbPath);
  assert.equal(result.exitCode, 2);
  assert.match(result.stdout, /usage:/);
});

test("sessions <workspace> returns rows for a workspace with no sessions", async () => {
  const dbPath = tmpDb("sess-empty");
  seedStore(dbPath).close();

  const result = await runCli(["sessions", "ws-1"], dbPath);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.json, []);
});

test("jobs returns aggregated counts across queue/cron/post-run", async () => {
  const dbPath = tmpDb("jobs");
  seedStore(dbPath).close();

  const result = await runCli(["jobs"], dbPath);
  assert.equal(result.exitCode, 0);
  const json = result.json as Record<string, unknown>;
  assert.ok("queue" in json);
  assert.ok("cron" in json);
  assert.ok("post_run" in json);
});

test("jobs merges workspace runtime DB counts with legacy host-state cron rows", async () => {
  const dbPath = tmpDb("jobs-legacy-fallback");
  const store = seedStore(dbPath);

  store.createCronjob({
    workspaceId: "ws-1",
    initiatedBy: "workspace_agent",
    cron: "0 9 * * *",
    description: "Runtime DB cron",
    instruction: "Runtime DB cron",
    delivery: { mode: "announce", channel: "session_run", to: null },
    enabled: true,
    jobId: "cron-runtime",
  });

  const hostDb = new Database(dbPath);
  try {
    hostDb.exec(`
      CREATE TABLE IF NOT EXISTS cronjobs (
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
    hostDb
      .prepare(`
        INSERT INTO cronjobs (
          id, workspace_id, initiated_by, name, cron, description, instruction, enabled, delivery, metadata,
          last_run_at, next_run_at, run_count, last_status, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, NULL, ?, ?)
      `)
      .run(
        "cron-legacy",
        "ws-2",
        "workspace_agent",
        "",
        "0 10 * * *",
        "Legacy cron",
        "Legacy cron",
        0,
        JSON.stringify({ mode: "announce", channel: "session_run", to: null }),
        JSON.stringify({}),
        "2026-05-07T00:00:00.000Z",
        "2026-05-07T00:00:00.000Z",
      );
  } finally {
    hostDb.close();
    store.close();
  }

  const result = await runCli(["jobs"], dbPath);
  assert.equal(result.exitCode, 0);
  const json = result.json as {
    cron: Array<{ enabled: number; count: number }>;
  };
  assert.deepEqual(json.cron, [
    { enabled: 1, count: 1 },
    { enabled: 0, count: 1 },
  ]);
});

test("health on a real DB returns ok=true", async () => {
  const dbPath = tmpDb("health-ok");
  seedStore(dbPath).close();

  const result = await runCli(["health"], dbPath);
  assert.equal(result.exitCode, 0);
  const json = result.json as { ok: boolean; tableCount: number };
  assert.equal(json.ok, true);
  assert.ok(json.tableCount > 0);
});

test("health on a non-existent DB returns ok=false and exits non-zero", async () => {
  const fakePath = path.join(
    os.tmpdir(),
    `holaboss-cli-${Date.now()}-missing.db`,
  );
  // Use a custom openDb that simulates failure (real `new Database(path, {readonly:true})`
  // on a missing file throws — the CLI catches and surfaces as ok=false).
  const lines: string[] = [];
  const exit = await runDebugCli({
    argv: ["--db-path", fakePath, "health"],
    out: (l) => lines.push(l),
    openDb: () => {
      throw new Error("SQLITE_CANTOPEN: unable to open database file");
    },
  });
  assert.equal(exit, 1);
  const json = JSON.parse(lines.join("\n")) as { ok: boolean; errors: string[] };
  assert.equal(json.ok, false);
  assert.ok(json.errors.length > 0);
});
