/**
 * Registered migrations, applied in `id` order. Each migration MUST:
 *   - Have a unique, strictly-increasing `id` (use natural numbers, not gaps)
 *   - Be idempotent on a transaction-rollback (no side effects outside `up`)
 *   - Not begin/commit transactions itself — the runner wraps each migration
 *
 * Adding a new migration:
 *   1. Create `runtime/state-store/src/migrations/NNN-short-name.ts`
 *   2. `export const migration: Migration = { id: NNN, name: "...", up: ... }`
 *   3. Append `import { migration as mNNN } from "./NNN-short-name.js"` here
 *   4. Append `mNNN` to the array below
 *   5. Bump `LATEST_SEED_VERSION` only if the migration touches a table that
 *      `ensureRuntimeDbSchema` also tries to create (i.e. legacy DBs already
 *      have it)
 *
 * `LATEST_SEED_VERSION` represents the highest id whose schema overlaps with
 * the legacy `ensureRuntimeDbSchema` baseline. Migrations above this id are
 * applied to legacy DBs; migrations at or below are assumed already applied.
 *
 * Today: 13 migrations are registered. `LATEST_SEED_VERSION` remains 0 because
 * fresh installs still rely on the migration chain for tables/columns that the
 * legacy ensure-helpers do not create, such as `workspace_plugins`.
 */
import type { Migration, MigrationId } from "../migrations.js";
import { migration as m001 } from "./001-workspace-plugins.js";
import { migration as m002 } from "./002-workflow-revisions.js";
import { migration as m003 } from "./003-base-object-record-workflow-provenance.js";
import { migration as m004 } from "./004-workspace-plugin-templates.js";
import { migration as m005 } from "./005-remove-teammate-runtime-references.js";
import { migration as m006 } from "./006-rename-assignee-teammate-id.js";
import { migration as m007 } from "./007-workflow-run-token-totals.js";
import { migration as m008 } from "./008-workflow-run-id-on-sessions.js";
import { migration as m009 } from "./009-relax-cronjobs-teammate-not-null.js";
import { migration as m010 } from "./010-record-field-writes.js";
import { migration as m011 } from "./011-record-feedback.js";
import { migration as m012 } from "./012-workspace-projects.js";
import { migration as m013 } from "./013-output-project-id.js";
import { migration as m014 } from "./014-record-feedback-review-columns.js";
import { migration as m015 } from "./015-evolution-proposals.js";
import { migration as m016 } from "./016-plugin-kind-and-evolution-counter.js";
import { migration as m017 } from "./017-agent-session-review-record.js";
import { migration as m018 } from "./018-session-harness-id.js";
import { migration as m019 } from "./019-workspace-addons.js";
import { migration as m020 } from "./020-rename-addons-to-capabilities.js";
import { migration as m021 } from "./021-ensure-session-harness-id.js";
import { migration as m022 } from "./022-drop-workspace-integration-overrides.js";
import { migration as m023 } from "./023-drop-evolve-tables.js";
import { migration as m024 } from "./024-drop-plugin-base-workflow-tables.js";
import { migration as m025 } from "./025-channel-connections.js";
import { migration as m026 } from "./026-channel-connection-config.js";
import { migration as m027 } from "./027-rename-workspace-projects-to-projects.js";
import { migration as m028 } from "./028-drop-workspace-id-session-tables.js";
import { migration as m029 } from "./029-drop-workspace-id-remaining-tables.js";
import { migration as m030 } from "./030-integration-tables-control-plane-only.js";
import { migration as m031 } from "./031-drop-local-composio-connections.js";
import { migration as m032 } from "./032-session-owning-app-id.js";
import { migration as m033 } from "./033-session-org-id.js";

export const RUNTIME_DB_MIGRATIONS: ReadonlyArray<Migration> = [
  m001,
  m002,
  m003,
  m004,
  m005,
  m006,
  m007,
  m008,
  m009,
  m010,
  m011,
  m012,
  m013,
  m014,
  m015,
  m016,
  m017,
  m018,
  m019,
  m020,
  m021,
  m022,
  m023,
  m024,
  m025,
  m026,
  m027,
  m028,
  m029,
  m030,
  m031,
  m032,
  m033,
];

export const LATEST_SEED_VERSION: MigrationId = 0;
