import type { Migration } from "../migrations.js";

/**
 * Removes the EVOLVE data model. The evolution/proposal surfaces — agent
 * tools, API routes, store methods, and these tables — are retired. The
 * "task proposals" and "evolve skill candidates" tables backed the
 * background evolve phase; "evolution_proposals" and
 * "evolution_decision_counters" backed the workflow-evolution agent.
 * Workflows themselves are out of scope and untouched.
 *
 * Runs against both the runtime and control-plane DBs; the control-plane
 * DB never had these tables, so this no-ops there.
 */
export const migration: Migration = {
  id: 23,
  name: "drop-evolve-tables",
  up: (db) => {
    db.exec(`DROP TABLE IF EXISTS evolution_proposals;`);
    db.exec(`DROP TABLE IF EXISTS evolution_decision_counters;`);
    db.exec(`DROP TABLE IF EXISTS evolve_skill_candidates;`);
    db.exec(`DROP TABLE IF EXISTS task_proposals;`);
  },
};
