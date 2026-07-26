import type { Migration } from "../migrations.js";

/**
 * Removes the PLUGIN + BASE + WORKFLOW data model. The plugin/base/workflow
 * bundle — desktop UI, API routes, agent tools, store methods, and these
 * tables — is fully retired. `workspace_plugins` backed the legacy
 * base+workflow plugin container; `bases` and the `base_*` tables backed the
 * structured-data model; the `workflow*` tables backed the workflow engine;
 * `record_feedback` / `record_field_writes` backed record provenance/feedback.
 *
 * Note: `workspace_plugin_templates` never existed as a table — migration 004
 * added template columns to `workspace_plugins`, so dropping that parent
 * removes them too.
 *
 * Order matters: migrations run with `PRAGMA foreign_keys = ON` (set when the
 * store opens the DB; pragma toggles are no-ops inside the per-migration
 * transaction). `base_teammate_bindings` — a leftover from the now-removed
 * teammate model that earlier prune passes did not drop — has
 * `FOREIGN KEY (object_id) REFERENCES base_objects` and
 * `FOREIGN KEY (base_id) REFERENCES bases`. If it survives, dropping
 * `base_objects`/`bases` leaves it dangling and SQLite aborts the whole
 * migration with `no such table: main.base_objects`, which (pre-fix) crashed
 * the runtime on every boot. So drop the FK-holding child tables first.
 *
 * Runs against both the runtime and control-plane DBs; the control-plane DB
 * never had these tables, so this no-ops there. Idempotent.
 */
export const migration: Migration = {
  id: 24,
  name: "drop-plugin-base-workflow-tables",
  up: (db) => {
    // Child tables that FK into base_objects/bases must go before their
    // parents while foreign_keys is ON.
    db.exec(`DROP TABLE IF EXISTS base_teammate_bindings;`);
    db.exec(`DROP TABLE IF EXISTS base_publications;`);
    db.exec(`DROP TABLE IF EXISTS base_permissions;`);
    db.exec(`DROP TABLE IF EXISTS base_integration_bindings;`);
    db.exec(`DROP TABLE IF EXISTS base_trigger_runs;`);
    db.exec(`DROP TABLE IF EXISTS base_action_runs;`);
    db.exec(`DROP TABLE IF EXISTS base_triggers;`);
    db.exec(`DROP TABLE IF EXISTS base_automations;`);
    db.exec(`DROP TABLE IF EXISTS base_actions;`);
    db.exec(`DROP TABLE IF EXISTS base_object_records;`);
    db.exec(`DROP TABLE IF EXISTS base_dashboards;`);
    db.exec(`DROP TABLE IF EXISTS base_projections;`);
    db.exec(`DROP TABLE IF EXISTS base_relations;`);
    db.exec(`DROP TABLE IF EXISTS base_fields;`);
    db.exec(`DROP TABLE IF EXISTS base_objects;`);
    db.exec(`DROP TABLE IF EXISTS bases;`);
    db.exec(`DROP TABLE IF EXISTS workflow_node_runs;`);
    db.exec(`DROP TABLE IF EXISTS workflow_runs;`);
    db.exec(`DROP TABLE IF EXISTS workflow_revisions;`);
    db.exec(`DROP TABLE IF EXISTS workflows;`);
    db.exec(`DROP TABLE IF EXISTS record_feedback;`);
    db.exec(`DROP TABLE IF EXISTS record_field_writes;`);
    db.exec(`DROP TABLE IF EXISTS workspace_plugins;`);
  },
};
