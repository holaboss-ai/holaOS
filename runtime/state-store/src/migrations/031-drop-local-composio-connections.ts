import type { Migration } from "../migrations.js";

/**
 * Integration consolidation: Composio connections are now sourced solely from
 * the remote Hono API (the single source of truth, keyed by the signed-in
 * user). The local `integration_connections` mirror had accumulated Composio
 * rows across several past login identities; those rows no longer match the
 * current account's remote set and are never read anymore (the agent's toolkit
 * enumeration, the integrations UI, and default-account resolution all resolve
 * Composio remotely). They are pure divergence-generating cruft.
 *
 * Clean delete of every `auth_mode = 'composio'` row. Bot-token / manual
 * connections keep their local rows — those hold real local credentials and
 * have no remote copy. No data migration: the authoritative Composio copy lives
 * upstream. Idempotent — gated on the table, and a no-op once no composio rows
 * remain (this migration also runs on DBs that never had the table).
 *
 * `integration_bindings.connection_id` references `integration_connections`
 * with `ON DELETE RESTRICT`, so on an upgraded DB that still has Composio
 * bindings the connection delete would fail with "FOREIGN KEY constraint
 * failed" — which rolls the whole migration back and wedges every subsequent DB
 * access in a retry loop (app stuck at "loading sessions"). Composio bindings
 * are resolved remotely now too, so drop the bindings that point at Composio
 * connections FIRST, then the connections.
 */
export const migration: Migration = {
  id: 31,
  name: "drop-local-composio-connections",
  up: (db) => {
    const hasConnections = db
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'integration_connections'`,
      )
      .get();
    if (!hasConnections) {
      return;
    }
    const hasBindings = db
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'integration_bindings'`,
      )
      .get();
    if (hasBindings) {
      db.exec(
        `DELETE FROM integration_bindings
           WHERE connection_id IN (
             SELECT connection_id FROM integration_connections
             WHERE lower(trim(auth_mode)) = 'composio'
           );`,
      );
    }
    db.exec(
      `DELETE FROM integration_connections WHERE lower(trim(auth_mode)) = 'composio';`,
    );
  },
};
