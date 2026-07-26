import type { Migration } from "../migrations.js";

/**
 * Adds `workflow_run_id` to `agent_sessions` and `subagent_runs` so every
 * turn_results row can be traced back to its originating workflow run.
 *
 * Why: migration 007 introduced token aggregation on workflow_runs but the
 * aggregator joined `turn_results.session_id = 'workflow:' + runId` — only
 * the in-runtime LLM condition-router uses that prefix, and it doesn't
 * write turn_results at all. All actual agent-node work runs under
 * `issue-<uuid>` sessions, so the new token columns were always 0/0/0/{}.
 *
 * This migration:
 *   1. Adds the column + index to agent_sessions and subagent_runs.
 *   2. Backfills agent_sessions.workflow_run_id by walking
 *      workflow_node_runs.result JSON for {session_id, child_session_id}
 *      and propagating to descendants via parent_session_id chains
 *      (fixed-point loop, max 16 rounds — handles typical delegation
 *      depths without unbounded recursion).
 *   3. Recomputes tokens_input / tokens_output / tokens_cached_input /
 *      tokens_by_model for each already-terminal workflow_runs row, using
 *      the same extractors the runtime uses.
 */

const TERMINAL_STATUSES = new Set([
  "completed",
  "passed",
  "failed",
  "cancelled",
]);

const SESSION_ID_KEYS = ["session_id", "child_session_id"] as const;

export const migration: Migration = {
  id: 8,
  name: "workflow-run-id-on-sessions",
  up: (db) => {
    const tableNames = new Set<string>(
      (
        db.prepare(`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
        `).all() as Array<{ name: string }>
      ).map((row) => row.name),
    );

    if (tableNames.has("agent_sessions")) {
      ensureColumn(db, "agent_sessions", "workflow_run_id", "TEXT");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_agent_sessions_workflow_run
            ON agent_sessions (workflow_run_id);
      `);
    }
    if (tableNames.has("subagent_runs")) {
      ensureColumn(db, "subagent_runs", "workflow_run_id", "TEXT");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_subagent_runs_workflow_run
            ON subagent_runs (workflow_run_id);
      `);
    }

    if (
      !tableNames.has("agent_sessions") ||
      !tableNames.has("workflow_node_runs") ||
      !tableNames.has("workflow_runs")
    ) {
      return;
    }

    backfillSessionsFromNodeRuns(db);
    if (tableNames.has("turn_results")) {
      recomputeTerminalWorkflowRunTokens(db);
    }
  },
};

function ensureColumn(
  db: Parameters<Migration["up"]>[0],
  tableName: string,
  columnName: string,
  columnDefinition: string,
): void {
  const columns = new Set<string>(
    (
      db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
        name: string;
      }>
    ).map((row) => row.name),
  );
  if (columns.has(columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition};`);
}

function backfillSessionsFromNodeRuns(
  db: Parameters<Migration["up"]>[0],
): void {
  // `agent_sessions.workspace_id` was dropped in migration 028 (redundant inside
  // a per-workspace runtime DB). On a fresh DB the table is already
  // workspace_id-free when this old migration runs, so the workspace_id scoping
  // predicates must be omitted there; on a legacy multi-workspace DB the column
  // still exists and scoping must be preserved.
  const hasWorkspaceId = agentSessionsHasWorkspaceId(db);

  // Seed: tag every session referenced directly from a node_run's result JSON
  // (session_id and child_session_id keys cover both agent-node and subagent
  // dispatches).
  const nodeRunRows = db
    .prepare<unknown[], { workspace_id: string; run_id: string; result: string | null }>(
      "SELECT workspace_id, run_id, result FROM workflow_node_runs",
    )
    .all() as Array<{ workspace_id: string; run_id: string; result: string | null }>;

  const updateSession = db.prepare(
    hasWorkspaceId
      ? `UPDATE agent_sessions
         SET workflow_run_id = ?
         WHERE workspace_id = ? AND session_id = ?
           AND workflow_run_id IS NULL`
      : `UPDATE agent_sessions
         SET workflow_run_id = ?
         WHERE session_id = ?
           AND workflow_run_id IS NULL`,
  );

  for (const nr of nodeRunRows) {
    if (!nr.result) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(nr.result);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const record = parsed as Record<string, unknown>;
    for (const key of SESSION_ID_KEYS) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        if (hasWorkspaceId) {
          updateSession.run(nr.run_id, nr.workspace_id, value.trim());
        } else {
          updateSession.run(nr.run_id, value.trim());
        }
      }
    }
  }

  // Propagate down parent_session_id chains: child sessions inherit
  // workflow_run_id from their parent. Fixed-point; in practice 1-2 rounds
  // suffice but we cap at 16 to avoid pathological cycles.
  const parentMatch = hasWorkspaceId
    ? "parent.workspace_id = child.workspace_id AND parent.session_id = child.parent_session_id"
    : "parent.session_id = child.parent_session_id";
  const propagate = db.prepare(
    `UPDATE agent_sessions AS child
     SET workflow_run_id = (
       SELECT parent.workflow_run_id
       FROM agent_sessions AS parent
       WHERE ${parentMatch}
       LIMIT 1
     )
     WHERE child.workflow_run_id IS NULL
       AND child.parent_session_id IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM agent_sessions AS parent
         WHERE ${parentMatch}
           AND parent.workflow_run_id IS NOT NULL
       )`,
  );
  for (let i = 0; i < 16; i++) {
    const info = propagate.run();
    if (info.changes === 0) {
      break;
    }
  }
}

function agentSessionsHasWorkspaceId(
  db: Parameters<Migration["up"]>[0],
): boolean {
  return tableHasWorkspaceId(db, "agent_sessions");
}

function tableHasWorkspaceId(
  db: Parameters<Migration["up"]>[0],
  table: string,
): boolean {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>
  ).some((row) => row.name === "workspace_id");
}

function recomputeTerminalWorkflowRunTokens(
  db: Parameters<Migration["up"]>[0],
): void {
  const runs = db
    .prepare<unknown[], { run_id: string; workspace_id: string; status: string }>(
      "SELECT run_id, workspace_id, status FROM workflow_runs",
    )
    .all() as Array<{ run_id: string; workspace_id: string; status: string }>;

  // `agent_sessions` lost its `workspace_id` column in migration 028 and
  // `turn_results` lost its own in migration 029 (both redundant inside a
  // per-workspace runtime DB). On a fresh DB those columns are already gone when
  // this older migration runs, so each workspace predicate is included only when
  // the corresponding column still exists; on a legacy DB the columns survive
  // and the original scoped joins are preserved.
  const sessionsHasWorkspaceId = agentSessionsHasWorkspaceId(db);
  const turnResultsHasWorkspaceId = tableHasWorkspaceId(db, "turn_results");
  const sessionJoinPredicate =
    sessionsHasWorkspaceId && turnResultsHasWorkspaceId
      ? "s.workspace_id = t.workspace_id AND s.session_id = t.session_id"
      : "s.session_id = t.session_id";
  const turnWorkspaceFilter = turnResultsHasWorkspaceId
    ? "t.workspace_id = ? AND "
    : "";
  const selectTurns = db.prepare<
    string[],
    { token_usage: string | null; payload: string | null }
  >(
    `SELECT t.token_usage AS token_usage, i.payload AS payload
     FROM turn_results t
     JOIN agent_sessions s
       ON ${sessionJoinPredicate}
     LEFT JOIN agent_session_inputs i
       ON i.input_id = t.input_id
     WHERE ${turnWorkspaceFilter}s.workflow_run_id = ?
       AND t.token_usage IS NOT NULL`,
  );

  const writeTokens = db.prepare(
    `UPDATE workflow_runs
     SET tokens_input = ?,
         tokens_output = ?,
         tokens_cached_input = ?,
         tokens_by_model = ?
     WHERE run_id = ?`,
  );

  for (const run of runs) {
    if (!TERMINAL_STATUSES.has(run.status)) continue;
    const selectArgs = turnResultsHasWorkspaceId
      ? [run.workspace_id, run.run_id]
      : [run.run_id];
    const rows = selectTurns.all(...selectArgs) as Array<{
      token_usage: string | null;
      payload: string | null;
    }>;
    let input = 0;
    let output = 0;
    let cached = 0;
    const byModel: Record<
      string,
      { input: number; output: number; cachedInput: number }
    > = {};
    for (const row of rows) {
      const usage = safeParseRecord(row.token_usage);
      if (!usage) continue;
      const i = extractInputTokens(usage);
      const o = extractOutputTokens(usage);
      const c = extractCachedInputTokens(usage);
      input += i;
      output += o;
      cached += c;
      const model =
        extractModel(usage) ??
        extractModelFromPayload(safeParseRecord(row.payload)) ??
        "unknown";
      const bucket =
        byModel[model] ?? { input: 0, output: 0, cachedInput: 0 };
      bucket.input += i;
      bucket.output += o;
      bucket.cachedInput += c;
      byModel[model] = bucket;
    }
    writeTokens.run(
      input,
      output,
      cached,
      JSON.stringify(byModel),
      run.run_id,
    );
  }
}

function safeParseRecord(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function pickFirstNumber(
  usage: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): number {
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, value);
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return Math.max(0, parsed);
      }
    }
  }
  return 0;
}

function pickNumberFromNested(
  usage: Record<string, unknown>,
  parentKeys: ReadonlyArray<string>,
  childKeys: ReadonlyArray<string>,
): number {
  for (const parent of parentKeys) {
    const child = usage[parent];
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const found = pickFirstNumber(
        child as Record<string, unknown>,
        childKeys,
      );
      if (found > 0) return found;
    }
  }
  return 0;
}

function extractInputTokens(usage: Record<string, unknown>): number {
  return pickFirstNumber(usage, ["input_tokens", "prompt_tokens"]);
}

function extractOutputTokens(usage: Record<string, unknown>): number {
  return pickFirstNumber(usage, ["output_tokens", "completion_tokens"]);
}

function extractCachedInputTokens(usage: Record<string, unknown>): number {
  const nested = pickNumberFromNested(
    usage,
    ["input_tokens_details", "prompt_tokens_details"],
    ["cached_tokens"],
  );
  if (nested > 0) return nested;
  return pickFirstNumber(usage, [
    "cache_read_input_tokens",
    "cached_input_tokens",
  ]);
}

function extractModel(usage: Record<string, unknown>): string | null {
  for (const key of ["model", "model_id"]) {
    const value = usage[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function extractModelFromPayload(
  payload: Record<string, unknown> | null,
): string | null {
  if (!payload) return null;
  for (const key of ["selected_model", "model", "model_id"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}
