import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAddColumnDDL,
  buildCreateIndexDDL,
  buildCreateTableDDL,
  DataSchemaError,
  parseDataSchema,
} from "./data-schema.js";

const APP = { appId: "twitter" };

test("parseDataSchema accepts a minimal valid manifest", () => {
  const schema = parseDataSchema(
    {
      version: 1,
      tables: {
        twitter_posts: {
          visibility: "user_facing",
          columns: {
            id: { type: "TEXT", primary_key: true },
            content: { type: "TEXT", not_null: true },
          },
        },
      },
    },
    APP,
  );
  assert.equal(schema.version, 1);
  assert.equal(schema.tables.length, 1);
  assert.equal(schema.tables[0].name, "twitter_posts");
  assert.equal(schema.tables[0].visibility, "user_facing");
  assert.equal(schema.tables[0].columns[0].primaryKey, true);
  assert.match(schema.sha, /^[0-9a-f]{64}$/);
});

test("parseDataSchema rejects table names without app prefix", () => {
  assert.throws(
    () =>
      parseDataSchema(
        {
          version: 1,
          tables: { posts: { columns: { id: { type: "TEXT", primary_key: true } } } },
        },
        APP,
      ),
    (e: unknown) => e instanceof DataSchemaError && e.path.includes("posts"),
  );
});

test("parseDataSchema rejects underscore-prefixed table names", () => {
  assert.throws(
    () =>
      parseDataSchema(
        {
          version: 1,
          tables: {
            _twitter_posts: { columns: { id: { type: "TEXT", primary_key: true } } },
          },
        },
        APP,
      ),
    DataSchemaError,
  );
});

test("parseDataSchema rejects non-integer / non-positive versions", () => {
  for (const bad of [0, -1, 1.5, "1", null, undefined]) {
    assert.throws(
      () =>
        parseDataSchema(
          { version: bad, tables: { twitter_x: { columns: { id: { type: "TEXT", primary_key: true } } } } },
          APP,
        ),
      DataSchemaError,
    );
  }
});

test("parseDataSchema rejects mixing column-level and table-level primary_key", () => {
  assert.throws(
    () =>
      parseDataSchema(
        {
          version: 1,
          tables: {
            twitter_posts: {
              columns: {
                id: { type: "TEXT", primary_key: true },
                kind: { type: "TEXT" },
              },
              primary_key: ["id", "kind"],
            },
          },
        },
        APP,
      ),
    DataSchemaError,
  );
});

test("parseDataSchema computes a stable SHA across re-parses of the same input", () => {
  const input = {
    version: 2,
    tables: {
      twitter_posts: {
        columns: { id: { type: "TEXT", primary_key: true }, content: { type: "TEXT", not_null: true } },
      },
    },
  };
  const a = parseDataSchema(input, APP);
  const b = parseDataSchema(input, APP);
  assert.equal(a.sha, b.sha);
});

test("buildCreateTableDDL with composite primary key emits the table-level constraint", () => {
  const schema = parseDataSchema(
    {
      version: 1,
      tables: {
        twitter_post_metrics: {
          columns: {
            post_id: { type: "TEXT", not_null: true },
            captured_at: { type: "TEXT", not_null: true },
            likes: { type: "INTEGER" },
          },
          primary_key: ["post_id", "captured_at"],
        },
      },
    },
    APP,
  );
  const ddl = buildCreateTableDDL(schema.tables[0]);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS "twitter_post_metrics"/);
  assert.match(ddl, /PRIMARY KEY \("post_id", "captured_at"\)/);
  // No per-column PRIMARY KEY when table-level composite is set.
  assert.doesNotMatch(ddl, /"post_id" TEXT NOT NULL PRIMARY KEY/);
});

test("buildCreateTableDDL emits per-column PRIMARY KEY when no composite is set", () => {
  const schema = parseDataSchema(
    { version: 1, tables: { twitter_posts: { columns: { id: { type: "TEXT", primary_key: true } } } } },
    APP,
  );
  const ddl = buildCreateTableDDL(schema.tables[0]);
  assert.match(ddl, /"id" TEXT PRIMARY KEY/);
});

test("buildCreateIndexDDL emits partial-index WHERE clause", () => {
  const ddl = buildCreateIndexDDL("twitter_posts", {
    name: "idx_twitter_posts_published_at",
    columns: ["published_at"],
    where: "status = 'published' AND deleted_at IS NULL",
    unique: false,
  });
  assert.match(
    ddl,
    /CREATE INDEX IF NOT EXISTS "idx_twitter_posts_published_at" ON "twitter_posts" \("published_at"\) WHERE status = 'published' AND deleted_at IS NULL;/,
  );
});

test("buildAddColumnDDL preserves type + nullability + default", () => {
  const ddl = buildAddColumnDDL("twitter_posts", {
    name: "deleted_at",
    type: "TEXT",
    primaryKey: false,
    notNull: false,
    default: null,
  });
  assert.equal(ddl, 'ALTER TABLE "twitter_posts" ADD COLUMN "deleted_at" TEXT;');
});
