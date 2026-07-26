import type { Migration } from "../migrations.js";

/**
 * Evolution: append-only proposals channel.
 *
 * The evolution agent fires after every 5 `review_decision` feedback rows
 * for a workflow (see migration 016 for the counter) and proposes edits to
 * a single agent node's instruction text. Each row is one proposal.
 *
 *   - target_workflow_id        : the workflow being evolved
 *   - base_workflow_revision_id : the revision this proposal was generated
 *                                 against; the diff is computed relative to
 *                                 this revision's snapshot of the target
 *                                 agent node's instruction
 *   - target_agent_node_id      : which agent node's instruction is changing
 *   - old_instruction           : snapshot at base_workflow_revision_id
 *   - new_instruction           : proposed text
 *   - rationale                 : short text the evolution agent generated
 *   - evidence_json             : JSON-encoded array of
 *                                 { feedbackId, snippet } pointing into
 *                                 record_feedback rows that informed this
 *   - status                    : "pending" | "accepted" | "declined"
 *   - decline_reason            : optional, becomes signal for future runs
 *
 * Indices target the read paths the evolution agent and UI both use:
 *   - list pending per workspace
 *   - list declined recent per workflow (for the agent's
 *     `list_declined_proposals` tool — don't re-propose the same thing)
 *
 * Gated on `workflow_revisions` existing (migration 002) so the
 * control-plane DB skips this entirely.
 */
export const migration: Migration = {
  id: 15,
  name: "evolution-proposals",
  up: (db) => {
    const tableNames = listTableNames(db);
    if (!tableNames.has("workflow_revisions")) {
      return;
    }
    if (tableNames.has("evolution_proposals")) {
      return;
    }
    db.exec(`
      CREATE TABLE evolution_proposals (
          proposal_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          target_workflow_id TEXT NOT NULL,
          base_workflow_revision_id TEXT NOT NULL,
          target_agent_node_id TEXT NOT NULL,
          old_instruction TEXT NOT NULL,
          new_instruction TEXT NOT NULL,
          rationale TEXT NOT NULL,
          evidence_json TEXT NOT NULL,
          status TEXT NOT NULL,
          decided_at TEXT,
          decided_by TEXT,
          decline_reason TEXT,
          accepted_revision_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_evolution_proposals_pending_created
          ON evolution_proposals (workspace_id, status, created_at DESC, proposal_id DESC);
      CREATE INDEX IF NOT EXISTS idx_evolution_proposals_workflow_status_created
          ON evolution_proposals (workspace_id, target_workflow_id, status, created_at DESC, proposal_id DESC);
    `);
  },
};

function listTableNames(
  db: Parameters<Migration["up"]>[0],
): Set<string> {
  return new Set<string>(
    (
      db.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
      `).all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
}
