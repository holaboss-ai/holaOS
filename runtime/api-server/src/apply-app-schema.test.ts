import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { parseDataSchema } from "./data-schema.js";
import { applyAppSchema, ApplySchemaError } from "./apply-app-schema.js";

function freshDbPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "tier2-"));
  return { path: path.join(dir, "data.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const TWITTER_V1_RAW = {
  version: 1,
  tables: {
    twitter_posts: {
      visibility: "user_facing",
      columns: {
        id: { type: "TEXT", primary_key: true },
        content: { type: "TEXT", not_null: true },
        status: { type: "TEXT", not_null: true, default: "'draft'" },
        created_at: { type: "TEXT", not_null: true, default: "(datetime('now'))" },
      },
      indexes: [{ name: "idx_twitter_posts_status", columns: ["status"] }],
    },
  },
};

test("applyAppSchema fresh install creates all tables + records the version", () => {
  const { path: dbPath, cleanup } = freshDbPath();
  try {
    const schema = parseDataSchema(TWITTER_V1_RAW, { appId: "twitter" });
    const result = applyAppSchema({ appId: "twitter", dataDbPath: dbPath, schema });
    assert.equal(result.kind, "fresh");
    if (result.kind !== "fresh") return;
    assert.deepEqual(result.tables, ["twitter_posts"]);

    const db = new Database(dbPath);
    const cols = db.prepare(`PRAGMA table_info("twitter_posts")`).all() as Array<{ name: string }>;
    assert.deepEqual(
      cols.map((c) => c.name).sort(),
      ["content", "created_at", "id", "status"],
    );
    const versions = db
      .prepare("SELECT app_id, version FROM _app_schema_versions WHERE app_id = ?")
      .get("twitter") as { app_id: string; version: number };
    assert.equal(versions.version, 1);
    db.close();
  } finally {
    cleanup();
  }
});

test("applyAppSchema is a no-op when version + sha match", () => {
  const { path: dbPath, cleanup } = freshDbPath();
  try {
    const schema = parseDataSchema(TWITTER_V1_RAW, { appId: "twitter" });
    applyAppSchema({ appId: "twitter", dataDbPath: dbPath, schema });
    const result = applyAppSchema({ appId: "twitter", dataDbPath: dbPath, schema });
    assert.equal(result.kind, "noop");
  } finally {
    cleanup();
  }
});

test("applyAppSchema adopts a pre-Tier-2 workspace whose tables already exist", () => {
  const { path: dbPath, cleanup } = freshDbPath();
  try {
    // Simulate a workspace where the app created its tables before Tier 2
    // shipped — DB has the table but no _app_schema_versions row.
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE twitter_posts (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.close();

    const schema = parseDataSchema(TWITTER_V1_RAW, { appId: "twitter" });
    const result = applyAppSchema({ appId: "twitter", dataDbPath: dbPath, schema });
    assert.equal(result.kind, "adopted");

    // The version row was recorded so future restarts see "noop".
    const second = applyAppSchema({ appId: "twitter", dataDbPath: dbPath, schema });
    assert.equal(second.kind, "noop");
  } finally {
    cleanup();
  }
});

test("applyAppSchema upgrade adds a new column on an existing table", () => {
  const { path: dbPath, cleanup } = freshDbPath();
  try {
    const v1 = parseDataSchema(TWITTER_V1_RAW, { appId: "twitter" });
    applyAppSchema({ appId: "twitter", dataDbPath: dbPath, schema: v1 });

    const v2Raw = {
      version: 2,
      tables: {
        twitter_posts: {
          ...TWITTER_V1_RAW.tables.twitter_posts,
          columns: {
            ...TWITTER_V1_RAW.tables.twitter_posts.columns,
            external_post_id: { type: "TEXT" },
          },
        },
      },
    };
    const v2 = parseDataSchema(v2Raw, { appId: "twitter" });
    const result = applyAppSchema({ appId: "twitter", dataDbPath: dbPath, schema: v2 });
    assert.equal(result.kind, "upgraded");
    if (result.kind !== "upgraded") return;
    assert.deepEqual(result.addedColumns, ["twitter_posts.external_post_id"]);

    const db = new Database(dbPath);
    const cols = db.prepare(`PRAGMA table_info("twitter_posts")`).all() as Array<{ name: string }>;
    assert.ok(cols.some((c) => c.name === "external_post_id"));
    db.close();
  } finally {
    cleanup();
  }
});

test("applyAppSchema upgrade adds a brand new table and its indexes", () => {
  const { path: dbPath, cleanup } = freshDbPath();
  try {
    const v1 = parseDataSchema(TWITTER_V1_RAW, { appId: "twitter" });
    applyAppSchema({ appId: "twitter", dataDbPath: dbPath, schema: v1 });

    const v2Raw = {
      version: 2,
      tables: {
        ...TWITTER_V1_RAW.tables,
        twitter_jobs: {
          visibility: "app_internal",
          columns: {
            id: { type: "TEXT", primary_key: true },
            status: { type: "TEXT", not_null: true, default: "'waiting'" },
          },
          indexes: [{ name: "idx_twitter_jobs_status", columns: ["status"] }],
        },
      },
    };
    const v2 = parseDataSchema(v2Raw, { appId: "twitter" });
    const result = applyAppSchema({ appId: "twitter", dataDbPath: dbPath, schema: v2 });
    assert.equal(result.kind, "upgraded");
    if (result.kind !== "upgraded") return;
    // addedIndexes only reports indexes added to *existing* tables;
    // indexes belonging to a brand-new table are implied by addedTables.
    assert.deepEqual(result.addedTables, ["twitter_jobs"]);
    assert.deepEqual(result.addedIndexes, []);

    // The index *was* created on disk, just not separately reported.
    const db = new Database(dbPath);
    const idx = db
      .prepare(`PRAGMA index_list("twitter_jobs")`)
      .all() as Array<{ name: string }>;
    assert.ok(idx.some((i) => i.name === "idx_twitter_jobs_status"));
    db.close();
  } finally {
    cleanup();
  }
});

test("applyAppSchema rejects adding a NOT NULL column without DEFAULT", () => {
  const { path: dbPath, cleanup } = freshDbPath();
  try {
    const v1 = parseDataSchema(TWITTER_V1_RAW, { appId: "twitter" });
    applyAppSchema({ appId: "twitter", dataDbPath: dbPath, schema: v1 });

    const v2Raw = {
      version: 2,
      tables: {
        twitter_posts: {
          ...TWITTER_V1_RAW.tables.twitter_posts,
          columns: {
            ...TWITTER_V1_RAW.tables.twitter_posts.columns,
            owner_id: { type: "TEXT", not_null: true }, // no default
          },
        },
      },
    };
    const v2 = parseDataSchema(v2Raw, { appId: "twitter" });
    assert.throws(
      () => applyAppSchema({ appId: "twitter", dataDbPath: dbPath, schema: v2 }),
      ApplySchemaError,
    );
  } finally {
    cleanup();
  }
});

test("applyAppSchema rejects a column type change", () => {
  const { path: dbPath, cleanup } = freshDbPath();
  try {
    const v1 = parseDataSchema(TWITTER_V1_RAW, { appId: "twitter" });
    applyAppSchema({ appId: "twitter", dataDbPath: dbPath, schema: v1 });

    const v2Raw = {
      version: 2,
      tables: {
        twitter_posts: {
          ...TWITTER_V1_RAW.tables.twitter_posts,
          columns: {
            ...TWITTER_V1_RAW.tables.twitter_posts.columns,
            content: { type: "INTEGER", not_null: true }, // was TEXT
          },
        },
      },
    };
    const v2 = parseDataSchema(v2Raw, { appId: "twitter" });
    assert.throws(
      () => applyAppSchema({ appId: "twitter", dataDbPath: dbPath, schema: v2 }),
      ApplySchemaError,
    );
  } finally {
    cleanup();
  }
});
