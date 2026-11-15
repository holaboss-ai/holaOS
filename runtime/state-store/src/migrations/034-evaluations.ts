import type { Migration } from "../migrations.js";

export const migration: Migration = {
  id: 34,
  name: "evaluations",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS evaluations (
          eval_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          question_type TEXT NOT NULL,
          question TEXT NOT NULL,
          status TEXT NOT NULL,
          plan_json TEXT,
          brain_model TEXT,
          session_id TEXT,
          opinion_md TEXT NOT NULL DEFAULT '',
          opinion_updated_at TEXT,
          distribution_json TEXT,
          report_url TEXT,
          include_raw_data INTEGER NOT NULL DEFAULT 1,
          parent_eval_id TEXT,
          relation TEXT,
          source_json TEXT,
          snapshot_json TEXT,
          published_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_evaluations_updated
          ON evaluations (updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_evaluations_session
          ON evaluations (session_id)
       WHERE session_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS evaluation_runs (
          run_id TEXT PRIMARY KEY,
          eval_id TEXT NOT NULL,
          run_key TEXT NOT NULL,
          kind TEXT NOT NULL,
          label TEXT NOT NULL,
          spec_json TEXT NOT NULL,
          status TEXT NOT NULL,
          progress_json TEXT,
          summary_json TEXT,
          error TEXT,
          proposal_id TEXT,
          started_at TEXT,
          finished_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_evaluation_runs_eval
          ON evaluation_runs (eval_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_evaluation_runs_status
          ON evaluation_runs (status, created_at);

      CREATE TABLE IF NOT EXISTS evaluation_proposals (
          proposal_id TEXT PRIMARY KEY,
          eval_id TEXT NOT NULL,
          title TEXT NOT NULL,
          rationale TEXT NOT NULL,
          evidence_json TEXT NOT NULL DEFAULT '[]',
          runs_json TEXT NOT NULL DEFAULT '[]',
          estimate_minutes INTEGER,
          status TEXT NOT NULL,
          created_by TEXT NOT NULL,
          decided_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_evaluation_proposals_eval
          ON evaluation_proposals (eval_id, created_at);

      CREATE TABLE IF NOT EXISTS evaluation_revisions (
          revision_id TEXT PRIMARY KEY,
          eval_id TEXT NOT NULL,
          opinion_md TEXT NOT NULL,
          author TEXT NOT NULL,
          created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_evaluation_revisions_eval
          ON evaluation_revisions (eval_id, created_at DESC);
    `);
  },
};
