import type { Migration } from "../migrations.js";

/**
 * workspace-removal Piece 5.7: make the integration knowledge graph
 * (`integration_trees`, `integration_leaves`, `integration_node_embeddings`)
 * control-plane-ONLY. These tables are account-global; the per-workspace variant
 * — created historically by `ensureWorkspaceRuntimeDbSchema` with a `workspace_id`
 * in its composite PKs plus an extra redundant `account_id` column — is a
 * now-single-tenant leftover and is removed here from per-workspace / root DBs.
 *
 * Per-DB behaviour (the same migration chain runs on every DB the store opens):
 *
 *   - CONTROL-PLANE DB (`control-plane.db`) and the LEGACY host-state monolith
 *     (`this.db()`): NO-OP. Both carry a `workspaces` registry table (the
 *     control-plane DB via `ensureWorkspacesTableSchema` /
 *     `backfillControlPlaneDbFromLegacyRuntimeDb`; the monolith via
 *     `ensureRuntimeDbSchema`). The control-plane DB is the new permanent home of
 *     this graph, so its tables MUST be kept. We detect these DBs by the presence
 *     of the `workspaces` table — never created in a per-workspace DB or the root
 *     `data.db` — and return early, exactly mirroring the guard in migrations 028
 *     and 029.
 *
 *   - PER-WORKSPACE / ROOT DB (`data.db` and any historical per-workspace
 *     `runtime.db` / draft-lab / soft-deleted DB): DROP the three integration
 *     tables (their indexes are dropped with them by SQLite; we also drop them
 *     explicitly to match the codebase's explicit style). Reads/writes for these
 *     tables now route to the control-plane DB (`integrationDbForWorkspace`,
 *     `listReadableIntegrationDbs`, `resolveSemanticMemoryScope`), so the
 *     per-workspace/root copies are dead shadow tables.
 *
 * NO DATA MIGRATION — this is a deliberate CLEAN DROP. The per-workspace
 * integration knowledge graph / semantic memory is derived, rebuildable state (the
 * AI re-learns it from the live integrations), so it does NOT need to be preserved.
 * We intentionally discard these stale per-workspace/root rows rather than fold
 * them into the control-plane copy: there is no consolidation step, no cross-DB
 * copy, and the divergent per-workspace schema is simply dropped.
 *
 * Idempotent: gated on each table actually existing, so it is a no-op once the
 * tables are gone (re-run, or fresh per-workspace/root DBs whose
 * `ensureWorkspaceRuntimeDbSchema` no longer creates them).
 */

const INTEGRATION_GRAPH_TABLES = [
  "integration_trees",
  "integration_leaves",
  "integration_node_embeddings",
] as const;

export const migration: Migration = {
  id: 30,
  name: "integration-tables-control-plane-only",
  up: (db) => {
    const existingTables = listTableNames(db);
    // NO-OP on the control-plane DB and the legacy host-state monolith: both have
    // a `workspaces` table, and the control-plane DB is the permanent home of the
    // integration graph (it must keep these tables). Per-workspace DBs and the
    // root `data.db` never have a `workspaces` table.
    if (existingTables.has("workspaces")) {
      return;
    }
    for (const table of INTEGRATION_GRAPH_TABLES) {
      if (!existingTables.has(table)) {
        // Already gone (fresh per-workspace/root DB whose schema no longer creates
        // it, or a prior run of this migration). Nothing to drop.
        continue;
      }
      // Drop this table's indexes first (explicit; SQLite would also drop them
      // with the table), then the table itself.
      for (const indexName of tableIndexNames(db, table)) {
        db.exec(`DROP INDEX IF EXISTS "${indexName}";`);
      }
      db.exec(`DROP TABLE IF EXISTS "${table}";`);
    }
    // Also drop the vec0 shadow of integration_node_embeddings (the embedding
    // similarity index). DROP TABLE on a vec0 virtual table removes all of its
    // backing shadow tables (`*_vec_*`). The integration embedding index lives only
    // in the control-plane DB now; this per-workspace/root shadow is discarded with
    // the rest of the graph. `interaction_node_embedding_vec` is left intact —
    // interaction embeddings remain workspace-scoped.
    if (existingTables.has("integration_node_embedding_vec")) {
      db.exec(`DROP TABLE IF EXISTS "integration_node_embedding_vec";`);
    }
  },
};

function listTableNames(db: Parameters<Migration["up"]>[0]): Set<string> {
  return new Set<string>(
    (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
}

function tableIndexNames(
  db: Parameters<Migration["up"]>[0],
  table: string,
): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%'`,
      )
      .all(table) as Array<{ name: string }>
  ).map((row) => row.name);
}
