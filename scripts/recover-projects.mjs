#!/usr/bin/env node
/**
 * recover-projects.mjs
 *
 * Repairs a desktop sandbox-host whose Projects + their sessions "disappeared"
 * after the one-time host-state monolith -> root fold
 * (consolidateHostStateMonolithIntoRoot) ran on upgrade. That fold:
 *   1) inserted junk `projects` rows (name == id, empty project_path, empty
 *      created_at) for hard-deleted workspaces — which break the Projects list, and
 *   2) left every session's agent_sessions.project_id = NULL (its INSERT OR IGNORE
 *      never re-tags sessions already present in the root data.db).
 *
 * No data is ever lost — sessions/messages/outputs are intact; only the
 * session -> project GROUPING and a few project rows need rebuilding. This script
 * rebuilds them from ground truth OUTSIDE the broken column:
 *   Source A (primary): the on-disk project folders
 *     <root>/workspace/<project_id>/.holaboss/pi-sessions/*.jsonl
 *     — a session created in a project stored its pi-session file under that dir.
 *   Source B (fallback): the stale host-state.db monolith, which still holds the
 *     session -> workspace_id (== project_id) mapping for older sessions.
 *   Source C: subagent sessions inherit their parent session's project.
 *
 * DRY RUN by default — prints exactly what it would change. Pass --apply to write
 * (a timestamped backup of data.db is taken first). QUIT THE DESKTOP FIRST so the
 * DB is not hot.
 *
 * Usage:
 *   node scripts/recover-projects.mjs --root "/Users/<user>/Library/Application Support/holaboss-local/sandbox-host"
 *   node scripts/recover-projects.mjs --root "..." --apply
 * Optional overrides (auto-derived from --root if omitted):
 *   --data <data.db>  --host-state <host-state.db>  --workspace <workspace dir>
 *
 * Requires Node 22.5+ / 24 (built-in node:sqlite). If import fails, run with
 *   node --experimental-sqlite scripts/recover-projects.mjs ...
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

// ---- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const APPLY = argv.includes("--apply");
const root = flag("--root");
if (!root) {
  console.error("Missing --root <sandbox-host path>. See header for usage.");
  process.exit(1);
}
const firstExisting = (...candidates) => candidates.find((p) => p && fs.existsSync(p));
const dataDbPath =
  flag("--data") ||
  firstExisting(path.join(root, "state", "data.db"), path.join(root, "data.db"));
const hostStatePath =
  flag("--host-state") ||
  firstExisting(
    path.join(root, "state", "host-state.db"),
    path.join(root, "host-state.db"),
    path.join(path.dirname(root), "state", "host-state.db"),
    path.join(path.dirname(root), "host-state.db"),
  );
const workspaceDir = flag("--workspace") || path.join(root, "workspace");

if (!dataDbPath || !fs.existsSync(dataDbPath)) {
  console.error(`data.db not found (looked under ${root}/state). Pass --data <path>.`);
  process.exit(1);
}
console.log(`mode        : ${APPLY ? "APPLY (will write)" : "DRY RUN (no changes)"}`);
console.log(`data.db     : ${dataDbPath}`);
console.log(`host-state  : ${hostStatePath ?? "(not found — Source B skipped)"}`);
console.log(`workspace   : ${fs.existsSync(workspaceDir) ? workspaceDir : `${workspaceDir} (MISSING — Source A skipped)`}`);
console.log("");

// A well-formed timestamp for repairing rows that have an empty created_at.
const nowIso = new Date().toISOString();
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const dirMtimeIso = (p) => {
  try {
    return fs.statSync(p).mtime.toISOString();
  } catch {
    return nowIso;
  }
};

// ---- open DBs --------------------------------------------------------------
const db = new DatabaseSync(dataDbPath); // read-write; writes gated behind APPLY
const hostDb =
  hostStatePath && fs.existsSync(hostStatePath)
    ? new DatabaseSync(hostStatePath, { readOnly: true })
    : null;

// harness_session_id -> session_id (pi-session filenames carry harness_session_id)
const harnessToSession = new Map();
for (const row of db
  .prepare("SELECT session_id, harness_session_id FROM agent_runtime_sessions")
  .all()) {
  if (row.harness_session_id) harnessToSession.set(String(row.harness_session_id), String(row.session_id));
  // Some sessions use session_id AS harness_session_id — index that too.
  harnessToSession.set(String(row.session_id), String(row.session_id));
}

const allSessions = db
  .prepare("SELECT session_id, parent_session_id, project_id FROM agent_sessions")
  .all();
const sessionById = new Map(allSessions.map((s) => [String(s.session_id), s]));

// Planned assignment: session_id -> { projectId, source }
const assign = new Map();
const setAssign = (sessionId, projectId, source) => {
  if (!sessionId || !projectId) return;
  if (!sessionById.has(sessionId)) return; // only sessions that exist in root
  if (assign.has(sessionId)) return; // first (highest-priority) source wins
  assign.set(sessionId, { projectId, source });
};

// ---- Source A: each project dir's OWN backup runtime.db -------------------
// A per-project/workspace dir keeps its sessions in .holaboss/state/runtime.db —
// the untouched backup the consolidation left behind. Its agent_sessions rows tell
// us exactly which sessions belonged to that project (its dir name == project_id).
// This is the authoritative on-disk mapping (the June projects live only here).
const projectDirs = new Map(); // projectId -> { dir, backupDb }
if (fs.existsSync(workspaceDir)) {
  for (const entry of fs.readdirSync(workspaceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "root" || entry.name === "outputs") continue;
    const dir = path.join(workspaceDir, entry.name);
    const backupDb = path.join(dir, ".holaboss", "state", "runtime.db");
    if (!fs.existsSync(backupDb)) continue;
    projectDirs.set(entry.name, { dir, backupDb });
    let bdb;
    try {
      bdb = new DatabaseSync(backupDb, { readOnly: true });
      for (const r of bdb.prepare("SELECT session_id FROM agent_sessions").all()) {
        setAssign(String(r.session_id), entry.name, "backup-db");
      }
    } catch (e) {
      console.warn(`  (skip project ${entry.name}: ${e.message})`);
    } finally {
      bdb?.close();
    }
  }
}

// ---- Source B: host-state monolith (session_id -> workspace_id) ------------
if (hostDb) {
  try {
    const rows = hostDb
      .prepare(
        "SELECT session_id, workspace_id FROM agent_sessions WHERE workspace_id IS NOT NULL",
      )
      .all();
    for (const r of rows) setAssign(String(r.session_id), String(r.workspace_id), "monolith");
  } catch (e) {
    console.warn(`Source B skipped (host-state read failed): ${e.message}`);
  }
}

// ---- Source C: subagents inherit their parent's project -------------------
// Iterate to a fixed point (a subagent's parent may itself be a subagent).
for (let pass = 0; pass < 5; pass++) {
  let changed = false;
  for (const s of allSessions) {
    const id = String(s.session_id);
    if (assign.has(id) || !s.parent_session_id) continue;
    const parent = assign.get(String(s.parent_session_id));
    if (parent) {
      assign.set(id, { projectId: parent.projectId, source: "subagent" });
      changed = true;
    }
  }
  if (!changed) break;
}

// Only re-tag sessions that are currently NULL (never clobber an existing link).
const relink = [...assign.entries()].filter(([id]) => !sessionById.get(id)?.project_id);

// ---- Plan the projects table repair ---------------------------------------
const projectRows = db.prepare("SELECT * FROM projects").all();
const projectById = new Map(projectRows.map((p) => [String(p.project_id), p]));
const neededProjectIds = new Set([
  ...projectDirs.keys(), // every on-disk project dir must reappear as a row
  ...relink.map(([, v]) => v.projectId),
]);

const projectPlan = []; // { action, projectId, ...fields }
// (a) ensure a good row exists for every project we are assigning sessions to
for (const pid of neededProjectIds) {
  const existing = projectById.get(pid);
  const diskDir = path.join(workspaceDir, pid);
  const hasDir = fs.existsSync(diskDir);
  if (!existing) {
    projectPlan.push({
      action: "create",
      projectId: pid,
      name: monolithWorkspaceName(pid) ?? pid.slice(0, 8),
      project_path: hasDir ? diskDir : "",
      created_at: hasDir ? dirMtimeIso(diskDir) : nowIso,
      updated_at: hasDir ? dirMtimeIso(diskDir) : nowIso,
    });
  } else if (!existing.created_at || (!existing.project_path && hasDir)) {
    projectPlan.push({
      action: "repair",
      projectId: pid,
      name: existing.name && existing.name !== pid ? existing.name : monolithWorkspaceName(pid) ?? existing.name,
      project_path: existing.project_path || (hasDir ? diskDir : ""),
      created_at: existing.created_at || (hasDir ? dirMtimeIso(diskDir) : nowIso),
      updated_at: existing.updated_at || existing.created_at || (hasDir ? dirMtimeIso(diskDir) : nowIso),
    });
  }
}
// (b) repair any remaining row with an empty created_at (breaks the list render),
//     and delete true junk (empty path, name==id, no dir, no sessions).
for (const p of projectRows) {
  const pid = String(p.project_id);
  if (neededProjectIds.has(pid)) continue; // handled above
  const hasDir = fs.existsSync(path.join(workspaceDir, pid));
  const junk = !p.project_path && (p.name === pid || !p.name) && !hasDir;
  if (junk) {
    projectPlan.push({ action: "delete", projectId: pid });
  } else if (!p.created_at) {
    projectPlan.push({
      action: "repair",
      projectId: pid,
      name: p.name || pid.slice(0, 8),
      project_path: p.project_path || (hasDir ? path.join(workspaceDir, pid) : ""),
      created_at: hasDir ? dirMtimeIso(path.join(workspaceDir, pid)) : nowIso,
      updated_at: p.updated_at || (hasDir ? dirMtimeIso(path.join(workspaceDir, pid)) : nowIso),
    });
  }
}

function monolithWorkspaceName(workspaceId) {
  if (!hostDb) return undefined;
  try {
    const row = hostDb
      .prepare("SELECT name FROM workspaces WHERE id = ? OR workspace_id = ? LIMIT 1")
      .get(workspaceId, workspaceId);
    return row?.name && row.name !== workspaceId ? String(row.name) : undefined;
  } catch {
    return undefined;
  }
}

// ---- report ----------------------------------------------------------------
const bySource = relink.reduce((acc, [, v]) => ((acc[v.source] = (acc[v.source] || 0) + 1), acc), {});
console.log("=== PLAN ===");
console.log(`sessions to re-link : ${relink.length}  (${JSON.stringify(bySource)})`);
console.log(`sessions still NULL : ${allSessions.filter((s) => !s.project_id && !assign.has(String(s.session_id))).length}`);
console.log(`projects to create  : ${projectPlan.filter((p) => p.action === "create").length}`);
console.log(`projects to repair  : ${projectPlan.filter((p) => p.action === "repair").length}`);
console.log(`projects to delete  : ${projectPlan.filter((p) => p.action === "delete").length}  (junk stubs)`);
console.log("");

// Per-project relink counts — so you can see "he y" / "123" come back with N sessions.
const perProject = new Map();
for (const [, v] of relink) perProject.set(v.projectId, (perProject.get(v.projectId) || 0) + 1);
const nameFor = (pid) => {
  const existing = projectById.get(pid);
  if (existing?.name && existing.name !== pid) return existing.name;
  return monolithWorkspaceName(pid) ?? "(unnamed)";
};
if (perProject.size > 0) {
  console.log("sessions re-linked per project:");
  for (const [pid, n] of [...perProject.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${pid.slice(0, 8)}  "${nameFor(pid)}"`);
  }
  console.log("");
}

for (const p of projectPlan) {
  console.log(`  ${p.action.padEnd(6)} project ${p.projectId}${p.name ? `  name="${p.name}"` : ""}${p.project_path ? `  path set` : ""}`);
}

if (!APPLY) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply to commit (data.db is backed up first).");
  process.exit(0);
}

// ---- apply (transactional, with backup) -----------------------------------
const backup = `${dataDbPath}.bak-${nowIso.replace(/[:.]/g, "-")}`;
fs.copyFileSync(dataDbPath, backup);
console.log(`\nbackup written: ${backup}`);

const upsertProject = db.prepare(`
  INSERT INTO projects (project_id, name, project_path, icon, icon_color, created_at, updated_at)
  VALUES (?, ?, ?, NULL, NULL, ?, ?)
  ON CONFLICT(project_id) DO UPDATE SET
    name = excluded.name, project_path = excluded.project_path,
    created_at = excluded.created_at, updated_at = excluded.updated_at
`);
const deleteProject = db.prepare("DELETE FROM projects WHERE project_id = ?");
const setSessionProject = db.prepare(
  "UPDATE agent_sessions SET project_id = ? WHERE session_id = ? AND project_id IS NULL",
);

db.exec("BEGIN");
try {
  for (const p of projectPlan) {
    if (p.action === "delete") deleteProject.run(p.projectId);
    else upsertProject.run(p.projectId, p.name, p.project_path, p.created_at, p.updated_at);
  }
  let relinked = 0;
  for (const [sessionId, v] of relink) relinked += setSessionProject.run(v.projectId, sessionId).changes;
  db.exec("COMMIT");
  console.log(`\nAPPLIED: re-linked ${relinked} sessions; projects create/repair/delete done.`);
  console.log("Restart the desktop — Projects and their sessions should be back.");
} catch (e) {
  db.exec("ROLLBACK");
  console.error(`\nFAILED — rolled back, data.db unchanged: ${e.message}`);
  console.error(`(Your backup is at ${backup} if needed.)`);
  process.exit(1);
}
