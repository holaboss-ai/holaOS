import type Database from "better-sqlite3";

/**
 * Schema migration system for the runtime state store.
 *
 * Why: until now the schema was maintained as a chain of `ensureXxxTableSchema`
 * methods on RuntimeStateStore that all use `CREATE TABLE IF NOT EXISTS`. That
 * works for new installs and for adding tables, but it cannot:
 *   1. Reliably add columns to existing tables (SQLite has no ALTER TABLE ADD
 *      COLUMN IF NOT EXISTS — every `ensure*` helper has to run a manual
 *      `PRAGMA table_info()` check before each ALTER, which is verbose and
 *      easy to forget)
 *   2. Run data migrations (rewrite values, drop+rebuild rows, etc.)
 *   3. Tell us what version of the schema a deployed DB is on
 *
 * Approach: SQLite's built-in `PRAGMA user_version` gives us a 32-bit version
 * counter we can read/write. We treat it as the migration cursor:
 *
 *   user_version = 0          → never migrated; baseline `ensureRuntimeDbSchema`
 *                                runs (idempotent), then we set user_version to
 *                                the highest registered migration id and stop.
 *   user_version = N          → apply migrations N+1..latest in order, each in
 *                                its own transaction with PRAGMA bumped only on
 *                                success.
 *
 * `ensureRuntimeDbSchema` stays as the baseline for fresh installs and for
 * existing pre-migration DBs (the legacy `CREATE TABLE IF NOT EXISTS` chain
 * is idempotent and harmless). New schema changes go in a numbered migration
 * file, NOT in `ensureRuntimeDbSchema`.
 *
 * Backward-compat: this is purely additive. DBs that opened the store before
 * this change are at user_version=0; on the first open after upgrade we mark
 * them as "current" without running anything destructive — the assumption is
 * that the legacy ensure-helpers brought them to baseline. New migrations only
 * affect DBs created/opened after they land.
 */

export type MigrationId = number;

export type MigrationDirection = "up";

export interface Migration {
  /** Strictly increasing positive integer. Use file ordering to keep this sane. */
  id: MigrationId;
  /** Short human-readable label, used in logs. */
  name: string;
  /**
   * Apply the schema/data change. Receives the open `better-sqlite3` Database
   * already wrapped in a transaction by the runner — implementations should
   * NOT begin/commit a transaction themselves.
   */
  up: (db: Database.Database) => void;
}

export interface MigrationRunnerOptions {
  /**
   * Optional structured logger. Receives `{event, migrationId?, name?, durationMs?}`
   * shapes. Wire to pino/Sentry in the api-server; unit tests pass a recorder.
   */
  log?: (event: MigrationLogEvent) => void;
  /**
   * For DBs that existed before this migration system was introduced (i.e.
   * `user_version === 0`), the runner does NOT run any migration up to
   * `latestSeedVersion` — it assumes the legacy `ensureRuntimeDbSchema` got
   * the DB to that point. Migrations strictly above this version always run.
   *
   * Set to the migration id of the LAST migration that overlaps with
   * `ensureRuntimeDbSchema`'s idempotent baseline. Migrations above this id
   * are always applied even on legacy DBs.
   */
  latestSeedVersion?: MigrationId;
}

export type MigrationLogEvent =
  | { event: "migrations.start"; current: MigrationId; target: MigrationId }
  | {
      event: "migrations.skip_to_seed";
      from: MigrationId;
      to: MigrationId;
      reason: "legacy_db_assumed_at_baseline";
    }
  | {
      event: "migrations.apply";
      id: MigrationId;
      name: string;
    }
  | {
      event: "migrations.applied";
      id: MigrationId;
      name: string;
      durationMs: number;
    }
  | {
      event: "migrations.failed";
      id: MigrationId;
      name: string;
      error: string;
    }
  | { event: "migrations.complete"; current: MigrationId; applied: number };

export class MigrationRunner {
  private readonly migrations: ReadonlyArray<Migration>;
  private readonly options: MigrationRunnerOptions;

  constructor(migrations: Iterable<Migration>, options: MigrationRunnerOptions = {}) {
    const ordered = [...migrations].sort((a, b) => a.id - b.id);
    assertStrictlyIncreasing(ordered);
    assertPositiveIds(ordered);
    this.migrations = ordered;
    this.options = options;
  }

  /**
   * Apply any pending migrations. Idempotent — calling twice without new
   * migrations is a no-op. Returns the number of migrations applied.
   */
  apply(db: Database.Database): number {
    const log = this.options.log ?? noopLog;
    const target = this.latestId();
    const initial = readUserVersion(db);

    log({ event: "migrations.start", current: initial, target });

    let current = initial;

    // Legacy-DB fast-forward: if user_version is still 0 but the DB clearly
    // already has tables (the legacy ensureRuntimeDbSchema ran), jump the
    // cursor to `latestSeedVersion` so we don't try to re-run baseline
    // migrations against a DB that already has those tables.
    if (current === 0) {
      const seed = this.options.latestSeedVersion ?? 0;
      const isLegacyPopulatedDb = seed > 0 && hasAnyUserTable(db);
      if (isLegacyPopulatedDb) {
        log({
          event: "migrations.skip_to_seed",
          from: 0,
          to: seed,
          reason: "legacy_db_assumed_at_baseline",
        });
        writeUserVersion(db, seed);
        current = seed;
      }
    }

    let applied = 0;
    for (const migration of this.migrations) {
      if (migration.id <= current) {
        continue;
      }
      log({ event: "migrations.apply", id: migration.id, name: migration.name });
      const startedAt = Date.now();

      const tx = db.transaction(() => {
        migration.up(db);
        writeUserVersion(db, migration.id);
      });
      try {
        tx();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log({
          event: "migrations.failed",
          id: migration.id,
          name: migration.name,
          error: message,
        });
        throw error;
      }

      const durationMs = Date.now() - startedAt;
      log({
        event: "migrations.applied",
        id: migration.id,
        name: migration.name,
        durationMs,
      });
      applied += 1;
      current = migration.id;
    }

    log({ event: "migrations.complete", current, applied });
    return applied;
  }

  private latestId(): MigrationId {
    if (this.migrations.length === 0) {
      return this.options.latestSeedVersion ?? 0;
    }
    return this.migrations[this.migrations.length - 1]!.id;
  }
}

function assertStrictlyIncreasing(migrations: ReadonlyArray<Migration>): void {
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i]!.id === migrations[i - 1]!.id) {
      throw new Error(
        `Duplicate migration id ${migrations[i]!.id} (${migrations[i - 1]!.name} vs ${migrations[i]!.name})`,
      );
    }
  }
}

function assertPositiveIds(migrations: ReadonlyArray<Migration>): void {
  for (const m of migrations) {
    if (!Number.isInteger(m.id) || m.id <= 0) {
      throw new Error(`Migration id must be a positive integer (got ${m.id} for "${m.name}")`);
    }
  }
}

function readUserVersion(db: Database.Database): MigrationId {
  const row = db.pragma("user_version") as Array<{ user_version: number }>;
  return row[0]?.user_version ?? 0;
}

function writeUserVersion(db: Database.Database, version: MigrationId): void {
  // PRAGMA user_version doesn't accept parameter binding — interpolation is
  // safe here because `version` is a constrained integer (asserted above).
  db.pragma(`user_version = ${version}`);
}

function hasAnyUserTable(db: Database.Database): boolean {
  const row = db
    .prepare<unknown[], { count: number }>(
      `SELECT COUNT(*) AS count FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .get();
  return (row?.count ?? 0) > 0;
}

function noopLog(_event: MigrationLogEvent): void {
  /* no-op */
}
