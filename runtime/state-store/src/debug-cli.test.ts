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

function seedStore(dbPath: string): RuntimeStateStore {
  const workspaceRoot = path.dirname(dbPath);
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  store.createWorkspace({
    workspaceId: "ws-1",
    name: "First",
    harness: "pi",
    status: "active",
    onboardingStatus: "complete",
  });
  store.createWorkspace({
    workspaceId: "ws-2",
    name: "Second",
    harness: "pi",
    status: "provisioning",
    onboardingStatus: "pending",
  });
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

test("migrations on a fresh DB shows current=0 and pending=[] (no migrations registered yet)", async () => {
  const dbPath = tmpDb("migrations");
  // Just open + close to create the DB
  seedStore(dbPath).close();

  const result = await runCli(["migrations"], dbPath);
  assert.equal(result.exitCode, 0);
  const json = result.json as {
    current: number;
    target: number;
    pending: unknown[];
    registered: unknown[];
  };
  // No migrations are registered today; legacy ensure-helpers ARE the baseline
  assert.equal(json.current, 0);
  assert.equal(json.target, 0);
  assert.deepEqual(json.pending, []);
  assert.deepEqual(json.registered, []);
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

test("jobs returns aggregated counts across queue/cron/post-run/evolve", async () => {
  const dbPath = tmpDb("jobs");
  seedStore(dbPath).close();

  const result = await runCli(["jobs"], dbPath);
  assert.equal(result.exitCode, 0);
  const json = result.json as Record<string, unknown>;
  assert.ok("queue" in json);
  assert.ok("cron" in json);
  assert.ok("post_run" in json);
  assert.ok("evolve_candidates" in json);
});

test("jobs merges workspace runtime DB counts with legacy host-state cron and evolve rows", async () => {
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
  store.createEvolveSkillCandidate({
    candidateId: "candidate-runtime",
    workspaceId: "ws-1",
    sessionId: "session-runtime",
    inputId: "input-runtime",
    kind: "skill_create",
    status: "draft",
    title: "Runtime DB candidate",
    summary: "Comes from workspace runtime db.",
    slug: "runtime-db-candidate",
    skillPath: "skills/runtime-db/SKILL.md",
    contentFingerprint: "fp-runtime",
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

      CREATE TABLE IF NOT EXISTS evolve_skill_candidates (
        candidate_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        input_id TEXT NOT NULL,
        task_proposal_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        slug TEXT NOT NULL,
        skill_path TEXT NOT NULL,
        content_fingerprint TEXT NOT NULL,
        confidence REAL,
        evaluation_notes TEXT,
        source_turn_input_ids TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        proposed_at TEXT,
        dismissed_at TEXT,
        accepted_at TEXT,
        promoted_at TEXT
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
    hostDb
      .prepare(`
        INSERT INTO evolve_skill_candidates (
          candidate_id,
          workspace_id,
          session_id,
          input_id,
          task_proposal_id,
          kind,
          status,
          title,
          summary,
          slug,
          skill_path,
          content_fingerprint,
          confidence,
          evaluation_notes,
          source_turn_input_ids,
          created_at,
          updated_at,
          proposed_at,
          dismissed_at,
          accepted_at,
          promoted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        "candidate-legacy",
        "ws-2",
        "session-legacy",
        "input-legacy",
        null,
        "skill_create",
        "proposed",
        "Legacy candidate",
        "Comes from host-state db.",
        "legacy-candidate",
        "skills/legacy/SKILL.md",
        "fp-legacy",
        null,
        null,
        JSON.stringify([]),
        "2026-05-07T00:00:00.000Z",
        "2026-05-07T00:00:00.000Z",
        null,
        null,
        null,
        null,
      );
  } finally {
    hostDb.close();
    store.close();
  }

  const result = await runCli(["jobs"], dbPath);
  assert.equal(result.exitCode, 0);
  const json = result.json as {
    cron: Array<{ enabled: number; count: number }>;
    evolve_candidates: Array<{ state: string; count: number }>;
  };
  assert.deepEqual(json.cron, [
    { enabled: 1, count: 1 },
    { enabled: 0, count: 1 },
  ]);
  assert.deepEqual(json.evolve_candidates, [
    { state: "draft", count: 1 },
    { state: "proposed", count: 1 },
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
