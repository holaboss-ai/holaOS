---
title: Pages & Databases — Notion-style block editor + database engine
date: 2026-05-06
status: draft
supersedes:
  - 2026-04-28-dashboard-file-type-design.md
  - 2026-04-30-dashboard-panels-v2.md
  - 2026-04-30-dashboard-panels-v2-frozen.md (informally)
deprecates:
  - .dashboard YAML format (planned removal end of Phase 4)
related:
  - 2026-04-30-workspace-data-layer-tier2.md
  - 2026-05-02-workspace-control-center-spec.md
---

# Pages & Databases — Notion-style block editor + database engine

## 0. Status & decision summary

This document is the **frozen v1 design** for replacing `.dashboard` YAML files with a Notion-style block editor + database engine living inside the holaOS sandbox runtime. It covers data model, runtime API, agent MCP surface, editor architecture, migration of existing `.dashboard` files, and the phased rollout plan.

Decisions already made (do not reopen during implementation; raise a follow-up doc if circumstances change):

| Decision | Choice | Reason |
|---|---|---|
| Replace or extend `.dashboard`? | **Replace** | YAML is read-only, cannot host UI editing of data or schema. |
| Edit data from UI? | **Yes — first-class** | Inline cell edits, schema edits, row CRUD must be a UI action. |
| Schema source | **Two-tier**: user-owned databases (UI-editable) + module-owned tables (read-only, query-backed blocks) | Lets users build their own DBs without losing access to module data (twitter_posts, reddit_posts, ...). |
| Agent authoring format | **Block JSON via MCP tools**, not a DSL | Lossless round-trip; no DSL→tree conversion layer. |
| Real-time collaboration | **Not in v1**, but data model and mutation API designed to migrate to Yjs without rewriting storage | Single-sandbox deployment today; multi-user is a foreseeable next step. |
| Editor framework | **Tiptap (DIY, no Pro template)** on top of ProseMirror | Decided 2026-05-06 after a reversal — see §22 for the full audit. Initial pick was Lexical based on architectural fit; the reversal was driven by **OSS production-footprint asymmetry** — Tiptap has named blue-chip OSS users (LinkedIn, GitLab, Anthropic, Twenty CRM, CopilotKit, Hyprnote, Hyperion, ...) plus 10+ years of ProseMirror battle-testing under Atlassian / NYT / Outline; Lexical's named OSS-product adoption is essentially Meta-internal (closed) + Payload CMS + a long tail of <100★ demos. Smaller community = fewer Stack Overflow answers, more issues open longer, more "Meta prioritises FB/IG hot path, not ours" risk. The user's "wrapper, not the framework" answer (a) leaves Tiptap acceptable as long as we do not reuse `@holaboss/editor`'s code. We will **not** purchase Tiptap Pro; the Notion-style UX is built on the open-source core, with `steven-tey/novel` and BlockNote's source as code references (no runtime dependency on either). Eliminated: BlockNote (custom blocks cannot nest — blocks `database_inline` inside columns/toggles), Plate (Slate-based collab story is the weakest), Lexical (architecturally clean but OSS adoption too thin to be the load-bearing dependency). Validated in Phase 0 POC. |
| Data store | **Sandbox-local SQLite, normalized** (block per row, property_value per row) | Required for future CRDT mapping; per-workspace isolation matches existing model. |
| File-system surface | **JSON file per page, written by runtime as side-effect** | Keeps File Explorer / git-style backup / agent file watch ergonomics; SQLite is the source of truth. |

Out of v1 (deferred, listed so they don't creep in):

- Real-time multi-user collaboration (presence, awareness, CRDT sync)
- Permissions / sharing / ACLs (single sandbox = single user)
- Page templates marketplace
- Page-level history / versioning UI (writes are journaled, but UI lands later)
- Mobile-optimised editor
- Inline embeds (PDF, Figma, video) — only image/file/url for v1
- AI-rewrite / summary built into editor (agents do this externally)

---

## 1. Goals & non-goals

### 1.1 Goals

1. **Full Notion-style block editor**: paragraph, headings, lists, code, quote, callout, toggle, divider, image, file, embed, plus database blocks. Slash menu, drag handles, block-level menu, keyboard-first authoring.
2. **First-class typed databases**: text / number / checkbox / select / multi-select / date / url / person / file / relation / rollup / formula / created_time / last_edited_time properties, all editable from the UI.
3. **Multiple views per database**: table / board / list / gallery / calendar / timeline. View configs (filter / sort / group / hidden / frozen) persist.
4. **Row pages**: every row is a page that can be opened to edit its properties + author its own block tree.
5. **Linked databases**: one database can be embedded in many pages with independent view config.
6. **Query-backed blocks** for legacy/module data: KPI, chart, sql_table read from arbitrary SQL against `data.db` and module SQLite stores.
7. **Agent ergonomics**: agents author block trees and database content via a small set of MCP tools that map 1:1 to user actions.
8. **Migration path** from existing `.dashboard` YAML files (one-shot importer, transparent).
9. **Collab-ready**: every primitive (block, row, property, property_value) has a stable ID, mutations are op-based, no array-index identity.

### 1.2 Non-goals

- Replacing `data.db` query semantics — module apps keep writing to their own tables. We do not migrate module data into the new database engine.
- Hosting binary assets — files/images upload to a workspace `attachments/` folder and the block stores a relative path. Cloud blob storage is a separate concern.
- Building a full formula language — v1 ships a subset (arithmetic, string concat, basic if/and/or, property refs, rollup helpers). No JS sandbox.
- Schema-on-write enforcement at the SQLite level — types are enforced at the API boundary, not by column types. (Trade-off discussed in §6.4.)

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Workspace** | A user-isolated sandbox. Holds one runtime SQLite DB and zero or more pages/databases. Same as today's `workspace/<id>/`. |
| **Page** | A document with a title, optional icon/cover, and an ordered tree of blocks. The unit a user opens. |
| **Block** | A node in a page's content tree. Has a stable ID, type, content payload, and optional children. |
| **Database** | A typed collection of rows. Has a schema (properties) and one or more views. Lives independently from pages and is referenced by `database_inline` / `database_linked` blocks. |
| **Row** | An entry in a database. Has property values and is itself a page. |
| **Property** | A typed column on a database. |
| **Property value** | A row's value for one property. |
| **View** | A named saved query+layout on a database. |
| **Query-backed block** | A block (KPI, chart, sql_table) whose data comes from a raw SQL query against the workspace `data.db`, not from a user database. |
| **Module data** | Tables owned by hola-boss-apps modules (`twitter_posts`, `reddit_posts`, `*_metrics_runs`, ...). Read-only from the user's perspective. |
| **User database** | A database created by the user or agent inside the runtime. Read-write through the editor. |
| **Runtime** | The in-sandbox Fastify server (`holaOS/runtime/api-server`, port 8080). Owner of all page/database state. |
| **Editor** | The Tiptap/ProseMirror-based React frontend that opens pages. Lives in `holaOS/desktop/`. |

---

## 3. Architecture overview

```
┌─────────────────────── Sandbox ───────────────────────┐
│                                                       │
│  ┌────────── Editor (renderer process) ──────────┐    │
│  │  Tiptap / ProseMirror core                     │    │
│  │  ├── Standard nodes (paragraph, heading, ...)  │    │
│  │  └── NodeViews (custom React subtrees)         │    │
│  │       ├── DatabaseInlineNode  → DatabaseView   │    │
│  │       ├── DatabaseLinkedNode  → DatabaseView   │    │
│  │       ├── KpiBlockNode        → KpiBlock       │    │
│  │       ├── ChartBlockNode      → ChartBlock     │    │
│  │       └── SqlTableBlockNode   → SqlTableBlock  │    │
│  │                                                │    │
│  │  Mutation queue (op-based, optimistic)         │    │
│  │  ├─ apply locally → Zustand store              │    │
│  │  └─ POST /api/v1/pages/.../mutations           │    │
│  └────────────────────────────────────────────────┘    │
│                       ▲                                │
│                       │ JSON-RPC + SSE                 │
│                       ▼                                │
│  ┌──────── Runtime API (Fastify, :8080) ─────────┐    │
│  │  /pages, /blocks, /databases, /properties,     │    │
│  │  /rows, /property_values, /views, /query       │    │
│  │                                                │    │
│  │  PagesService ──┐                              │    │
│  │  BlocksService  ├─→ SQLite (pages.db)          │    │
│  │  DatabasesSvc   │                              │    │
│  │  RowsService ───┘                              │    │
│  │                                                │    │
│  │  QueryService ─────→ data.db (read-only)       │    │
│  │                                                │    │
│  │  EventBus ─────────→ SSE stream per page       │    │
│  └────────────────────────────────────────────────┘    │
│                       │                                │
│                       ▼                                │
│  ┌────── MCP server (agent tools, :13xxx) ────────┐    │
│  │  pages.* / blocks.* / databases.* / query.run  │    │
│  └────────────────────────────────────────────────┘    │
│                                                        │
└────────────────────────────────────────────────────────┘
```

**Two SQLite databases inside the sandbox:**

- `state/pages.db` — owned by the page/database engine. New file. Contains pages, blocks, databases, properties, rows, property_values, views, relations, journal.
- `state/data.db` — existing workspace shared SQLite. Owned by module apps. Read by query-backed blocks and the existing dashboard query path. Untouched by this design.

**Why two**: domain isolation. `pages.db` schema migrations are owned by the runtime; `data.db` migrations are owned by modules. Mixing them creates lock contention and makes module install/uninstall messy.

---

## 4. Block JSON specification

Every block has the same envelope:

```ts
interface Block {
  id: string;            // UUIDv7 — see §10.1
  page_id: string;
  parent_block_id: string | null;
  position: string;      // fractional index — see §10.2
  type: BlockType;
  content: BlockContent; // type-specific payload
  created_at: string;    // ISO-8601
  updated_at: string;    // ISO-8601
}
```

`children` is **not** stored in `content` — it is implicit via `parent_block_id`. Reading a page does an `ORDER BY parent_block_id, position` walk; the runtime returns a flat list and the editor reconstructs the tree.

### 4.1 Standard blocks

```ts
type BlockType =
  | "paragraph"
  | "heading_1" | "heading_2" | "heading_3"
  | "bulleted_list_item" | "numbered_list_item"
  | "to_do"
  | "toggle"
  | "quote"
  | "callout"
  | "code"
  | "divider"
  | "image"
  | "file"
  | "video"
  | "embed"
  | "bookmark"
  | "table_of_contents"
  | "column_list" | "column"     // multi-column layout
  // Database / data blocks
  | "database_inline"
  | "database_linked"
  | "kpi"
  | "chart"
  | "sql_table";
```

#### Rich text blocks (paragraph, headings, list items, quote, callout, toggle, code, to_do)

```ts
type RichText =
  | { type: "text"; text: string; annotations: Annotations; link?: string }
  | { type: "mention"; mention: Mention; annotations: Annotations }
  | { type: "equation"; expression: string; annotations: Annotations };

interface Annotations {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  color?: ColorToken;
  background?: ColorToken;
}

type Mention =
  | { kind: "page"; page_id: string }
  | { kind: "database"; database_id: string }
  | { kind: "row"; row_id: string }
  | { kind: "user"; user_id: string }
  | { kind: "date"; date: string };
```

```jsonc
// paragraph
{ "type": "paragraph", "content": { "rich_text": [/* RichText */] } }

// heading_1 / heading_2 / heading_3
{ "type": "heading_2", "content": { "rich_text": [/* ... */], "is_toggleable": false } }

// bulleted_list_item / numbered_list_item
{ "type": "bulleted_list_item", "content": { "rich_text": [/* ... */] } }

// to_do
{ "type": "to_do", "content": { "rich_text": [/* ... */], "checked": false } }

// toggle
{ "type": "toggle", "content": { "rich_text": [/* ... */] } }
// children stored as separate blocks with parent_block_id pointing here

// quote
{ "type": "quote", "content": { "rich_text": [/* ... */] } }

// callout
{
  "type": "callout",
  "content": {
    "rich_text": [/* ... */],
    "icon": { "kind": "emoji", "value": "💡" },  // or { kind: "url", value: "https://..." }
    "color": "blue"
  }
}

// code
{
  "type": "code",
  "content": {
    "rich_text": [/* plain text only */],
    "language": "typescript",
    "caption": [/* RichText */]
  }
}

// divider
{ "type": "divider", "content": {} }
```

#### Media blocks

```jsonc
// image
{
  "type": "image",
  "content": {
    "source": { "kind": "external", "url": "https://..." },
    // OR { "kind": "internal", "path": "attachments/<uuid>.png" }
    "caption": [/* RichText */],
    "width": 800   // optional, in px
  }
}

// file
{
  "type": "file",
  "content": {
    "source": { "kind": "internal", "path": "attachments/<uuid>.pdf" },
    "name": "spec.pdf",
    "size": 124032,
    "caption": [/* RichText */]
  }
}

// video, embed, bookmark — same shape as image with different rendering
```

#### Layout blocks

```jsonc
// column_list — purely structural, holds N column children
{ "type": "column_list", "content": {} }

// column — child of column_list, holds blocks
{ "type": "column", "content": { "ratio": 0.5 } }
```

### 4.2 Database blocks

```jsonc
// database_inline: a database that lives only on this page
{
  "type": "database_inline",
  "content": {
    "database_id": "db_01HX...",
    "default_view_id": "view_01HX..."
  }
}

// database_linked: references a database that lives on another page
{
  "type": "database_linked",
  "content": {
    "database_id": "db_01HX...",
    "view_id": "view_01HX...",       // linked DBs always pick a specific view
    "view_overrides": {              // optional ad-hoc overrides w/o creating a saved view
      "filter": { ... },
      "sort": [ ... ]
    }
  }
}
```

`database_inline` vs `database_linked`:

- `database_inline`: deleting the block deletes the database. The database is "owned" by this block's page.
- `database_linked`: deleting the block does not delete the database. The database has a different owner page.

Every database must have exactly one owner page. When a `database_inline` block is deleted, the database is moved to trash (soft delete), not hard-deleted, so accidental deletes can be recovered for 30 days.

### 4.3 Query-backed blocks

These blocks read from arbitrary SQL against the workspace `data.db`. They are read-only and exist primarily for backward compatibility with `.dashboard` content and for surfacing module data.

```jsonc
// kpi
{
  "type": "kpi",
  "content": {
    "title": "Posts published",
    "description": "Last 7 days",
    "query": "SELECT COUNT(*) AS value FROM ...",
    "format": "integer",
    "currency": null,
    "delta_query": "SELECT ... AS value FROM ...",
    "target": 50,
    "empty_state": "No posts yet."
  }
}

// chart
{
  "type": "chart",
  "content": {
    "title": "Twitter activity",
    "description": "Last 14 days",
    "query": "SELECT date(...) AS day, ... FROM ...",
    "chart": {
      "kind": "line",                       // line | bar | area | pie | donut
      "x": "day",
      "y": ["refreshed", "skipped"],
      "x_format": "date",
      "y_format": "integer",
      "stacked": false,
      "legend": true
    },
    "empty_state": "No activity."
  }
}

// sql_table — replaces the existing data_view panel for query-driven cases
{
  "type": "sql_table",
  "content": {
    "title": "All published content",
    "description": null,
    "query": "SELECT ... FROM ... LIMIT 50",
    "views": [
      {
        "id": "v_01HX...",
        "type": "table",
        "name": "Table",
        "columns": [
          { "name": "platform", "label": "Platform",
            "format": "tag",
            "colors": { "twitter": "blue", "reddit": "orange" } },
          { "name": "content", "label": "Post" },
          { "name": "status", "format": "tag",
            "colors": { "published": "green", "draft": "gray" } },
          { "name": "published_at", "format": "datetime", "width": 170 }
        ]
      },
      {
        "id": "v_01HX...",
        "type": "board",
        "name": "By platform",
        "group_by": "platform",
        "card_title": "content",
        "card_subtitle": "status",
        "card_meta": "published_at"
      }
    ],
    "default_view_id": "v_01HX..."
  }
}
```

Query-backed blocks **cannot** be edited inline (no cell editing). They re-run their query when the page opens, when the page receives an explicit refresh, or on the configured `refresh_interval_s`.

### 4.4 Block content storage in SQLite

```sql
CREATE TABLE blocks (
  id              TEXT PRIMARY KEY,
  page_id         TEXT NOT NULL,
  parent_block_id TEXT,
  position        TEXT NOT NULL,           -- fractional index
  type            TEXT NOT NULL,
  content_json    TEXT NOT NULL,           -- JSON of BlockContent
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT,                    -- soft delete; nullable
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE INDEX idx_blocks_page ON blocks(page_id, parent_block_id, position) WHERE deleted_at IS NULL;
```

`content_json` is opaque JSON. We do not split into per-type columns; the type discriminator + JSON is sufficient and avoids a multi-table join on every page load.

---

## 5. Property type system

A database has one or more **properties**. Each property has a stable ID, a name (mutable, unique within DB), a type, and a type-specific config. Property values for each row are stored as JSON in `property_values`.

### 5.1 Property types

| Type | Stored value (JSON) | Config | Editable | Notes |
|---|---|---|---|---|
| `text` | `{ "rich_text": RichText[] }` | — | yes | Inline rich text in cells |
| `number` | `{ "value": number \| null }` | `{ format: "plain"\|"percent"\|"currency"\|"integer", currency?: string, decimals?: number }` | yes | |
| `checkbox` | `{ "checked": boolean }` | — | yes | |
| `select` | `{ "option_id": string \| null }` | `{ options: SelectOption[] }` | yes | Single-pick |
| `multi_select` | `{ "option_ids": string[] }` | `{ options: SelectOption[] }` | yes | |
| `date` | `{ "start": string, "end"?: string, "include_time": boolean, "tz"?: string }` | — | yes | ISO-8601 |
| `url` | `{ "url": string \| null }` | — | yes | |
| `email` | `{ "email": string \| null }` | — | yes | |
| `phone` | `{ "phone": string \| null }` | — | yes | |
| `person` | `{ "user_ids": string[] }` | — | yes | Multi-user. v1 only "self" since single-user. |
| `file` | `{ "files": FileRef[] }` | — | yes | FileRef = `{ kind: "internal" \| "external", path/url, name, size }` |
| `relation` | `{ "row_ids": string[] }` | `{ database_id: string, single: boolean, two_way?: { property_id: string } }` | yes | Two-way handled in §5.4 |
| `rollup` | (computed) | `{ relation_property_id: string, target_property_id: string, function: RollupFn }` | no | See §5.5 |
| `formula` | (computed) | `{ expression: string }` | no | See §5.6 |
| `created_time` | (computed) | — | no | Equals row.created_at |
| `created_by` | (computed) | — | no | v1: always self |
| `last_edited_time` | (computed) | — | no | Updated on any property_value or row content change |
| `last_edited_by` | (computed) | — | no | v1: always self |

```ts
interface SelectOption {
  id: string;          // stable, never reused; renaming the option keeps id
  name: string;
  color: ColorToken;
  position: string;    // fractional index for reorder
}

type RollupFn =
  | "count" | "count_unique" | "count_empty" | "count_not_empty"
  | "sum" | "average" | "min" | "max" | "median" | "range"
  | "earliest" | "latest" | "date_range"
  | "show_original" | "show_unique";

type ColorToken =
  | "default"
  | "gray" | "brown" | "orange" | "yellow" | "green"
  | "blue" | "purple" | "pink" | "red";
```

### 5.2 Property storage

```sql
CREATE TABLE properties (
  id           TEXT PRIMARY KEY,
  database_id  TEXT NOT NULL,
  position     TEXT NOT NULL,           -- fractional index
  name         TEXT NOT NULL,
  type         TEXT NOT NULL,
  config_json  TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  UNIQUE (database_id, name) ON CONFLICT FAIL
    WHERE deleted_at IS NULL,
  FOREIGN KEY (database_id) REFERENCES databases(id) ON DELETE CASCADE
);

CREATE TABLE property_values (
  row_id       TEXT NOT NULL,
  property_id  TEXT NOT NULL,
  value_json   TEXT NOT NULL,
  PRIMARY KEY (row_id, property_id),
  FOREIGN KEY (row_id) REFERENCES rows(id) ON DELETE CASCADE,
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
);

-- Expression indexes on hot value paths to speed up filters/sorts.
CREATE INDEX idx_pv_text ON property_values(property_id, json_extract(value_json, '$.value'));
```

Why JSON per value rather than typed columns:

- Schema evolves frequently (rename, retype, add). Typed-per-property would require ALTER on every property change.
- SQLite's `json_extract` indexed expressions give us indexed lookups when needed.
- Type changes (§5.3) become a JSON rewrite per row, which is bounded and journaled.

The cost: cross-property numeric filters go through `json_extract` casts. For the row counts we expect (≤ 100k rows per DB in v1), this is fine. If a database grows past that we add a typed shadow column on the hot property; document this as an internal optimisation, not a user-visible feature.

### 5.3 Type migration rules

When `databases.update_property` changes a property's type:

| From → To | Behaviour |
|---|---|
| `text` → `number` | Parse; on parse failure, value becomes `null` and the failure is logged to `journal` with the original value preserved. |
| `text` → `select` | Treat the text as the option name; create option if missing; on multi-line text, trim and use first line. |
| `text` → `multi_select` | Split by `, `. |
| `select` → `multi_select` | Wrap option_id in array. |
| `multi_select` → `select` | Take first option_id; warn. |
| `select` → `text` | Render option name. |
| `number` → `text` | Render with current format. |
| `date` → `text` | ISO-8601 string. |
| `url` ↔ `text` | String passthrough. |
| Anything → `relation` | Drop value (set to empty). User must re-link. |
| `relation` → anything | Drop value. |
| Anything → `formula`/`rollup`/`created_*`/`last_edited_*` | Drop value (these are computed). |
| `formula`/`rollup` → editable | Convert current computed value to a literal of the new type. |

Migrations are atomic at the property level: if any row's value cannot be migrated and the rule says "fail", the whole change rolls back. The default behaviour above is "best-effort with journal", not "fail".

### 5.4 Two-way relations

A relation property can be **one-way** (default) or **two-way** (creates a paired property on the other database).

Storage:

```sql
CREATE TABLE relations (
  from_row_id     TEXT NOT NULL,
  to_row_id       TEXT NOT NULL,
  property_id     TEXT NOT NULL,         -- the property on the FROM side
  PRIMARY KEY (from_row_id, property_id, to_row_id),
  FOREIGN KEY (from_row_id) REFERENCES rows(id) ON DELETE CASCADE,
  FOREIGN KEY (to_row_id) REFERENCES rows(id) ON DELETE CASCADE,
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
);

CREATE INDEX idx_relations_to ON relations(to_row_id, property_id);
```

Two-way: changing the relation on either side writes a single `relations` row. The "paired property" on the other database is just a stored property with `config.two_way.property_id` pointing back. Reads on either side are symmetric.

When a two-way property is **deleted**, the paired property is also deleted; the rows themselves are not affected.

### 5.5 Rollups

A rollup property requires:

- `relation_property_id`: a relation property on the same database
- `target_property_id`: a property on the related database
- `function`: a RollupFn

Rollups are **computed on read**, not stored. The query engine resolves them in `databases.query`. To keep this efficient:

- Each row keeps a cached `rollup_cache` JSON in `rows.cache_json` invalidated on related-property writes.
- Cache invalidation: when row R is mutated, the runtime walks `relations` to find all rows pointing to R via any property, and invalidates their `rollup_cache`. This is `O(in-degree)` per write, acceptable for normal workloads.

### 5.6 Formulas

Formula DSL — small, documented subset, no JS sandbox:

```
expression  := atom (binop atom)*
atom        := literal | property_ref | function_call | "(" expression ")"
property_ref := "prop" "(" string_literal ")"
function_call := identifier "(" expression ("," expression)* ")"
binop       := "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | ">" | "<=" | ">="
             | "and" | "or"
literal     := number | string | "true" | "false" | "null"
```

Functions for v1:

- Math: `abs`, `floor`, `ceil`, `round`, `min`, `max`, `pow`, `sqrt`
- String: `concat`, `length`, `slice`, `replace`, `lower`, `upper`, `contains`, `starts_with`, `ends_with`
- Date: `now`, `date`, `add_days`, `format_date`, `date_between`, `date_year`, `date_month`, `date_day`
- Logic: `if(cond, a, b)`, `not`, `empty`, `not_empty`
- Type: `to_string`, `to_number`, `to_bool`

Parser + evaluator lives in `runtime/formula/`. Outputs are typed (number / string / bool / date) and the formula's own "result type" is stored in `config.result_type` for view rendering.

Formulas are computed on read and cached in `rows.cache_json` keyed by property_id. Cache invalidation is property-graph-based: when property P is referenced by formula F, writes to P invalidate F's cache for the affected rows.

---

## 6. View system

### 6.1 View types and config

```ts
type ViewType = "table" | "board" | "list" | "gallery" | "calendar" | "timeline";

interface ViewBase {
  id: string;
  database_id: string;
  type: ViewType;
  name: string;
  position: string;
  filter: Filter | null;          // see §6.2
  sort: Sort[];                   // see §6.2
  hidden_property_ids: string[];
  search_query?: string;          // optional persisted text search
}

interface TableViewConfig extends ViewBase {
  type: "table";
  frozen_property_ids: string[];  // pinned to left
  property_widths: Record<string, number>;  // px; missing = auto
  wrap: boolean;                  // wrap cell content
}

interface BoardViewConfig extends ViewBase {
  type: "board";
  group_by_property_id: string;   // must be select / multi_select / status / person / checkbox
  group_visibility: Record<string, boolean>;     // option_id → shown
  group_order: string[];          // option_ids
  card_property_ids: string[];    // which properties to show on cards
  card_size: "small" | "medium" | "large";
  cover_property_id?: string;     // file/image property
  cover_fit: "cover" | "contain";
}

interface ListViewConfig extends ViewBase {
  type: "list";
  primary_property_id: string;
  secondary_property_id?: string;
  meta_property_ids: string[];
}

interface GalleryViewConfig extends ViewBase {
  type: "gallery";
  cover_property_id?: string;
  cover_fit: "cover" | "contain";
  card_property_ids: string[];
  card_size: "small" | "medium" | "large";
}

interface CalendarViewConfig extends ViewBase {
  type: "calendar";
  date_property_id: string;
  end_date_property_id?: string;       // for spans
  card_property_ids: string[];
  default_zoom: "month" | "week" | "day";
}

interface TimelineViewConfig extends ViewBase {
  type: "timeline";
  start_property_id: string;
  end_property_id: string;
  group_by_property_id?: string;
  bar_property_ids: string[];          // shown on bar
  default_zoom: "year" | "quarter" | "month" | "week" | "day";
}
```

### 6.2 Filter & sort DSL

```ts
type Filter =
  | { kind: "and"; filters: Filter[] }
  | { kind: "or"; filters: Filter[] }
  | { kind: "leaf"; property_id: string; condition: Condition };

type Condition =
  // string-y (text, url, email, phone)
  | { op: "equals" | "not_equals" | "contains" | "not_contains"
        | "starts_with" | "ends_with"; value: string }
  | { op: "is_empty" | "is_not_empty" }
  // number / rollup-numeric
  | { op: "gt" | "gte" | "lt" | "lte" | "eq" | "neq"; value: number }
  // checkbox
  | { op: "is_checked" | "is_unchecked" }
  // select
  | { op: "is" | "is_not"; value: string /* option_id */ }
  // multi_select
  | { op: "contains_any" | "contains_all" | "contains_none";
      value: string[] /* option_ids */ }
  // date
  | { op: "date_eq" | "date_before" | "date_after"
        | "date_on_or_before" | "date_on_or_after";
      value: string /* ISO date */ }
  | { op: "date_within"; preset: DatePreset }
  // relation
  | { op: "relation_contains" | "relation_not_contains";
      value: string /* row_id */ };

type DatePreset =
  | "today" | "tomorrow" | "yesterday"
  | "this_week" | "last_week" | "next_week"
  | "this_month" | "last_month" | "next_month"
  | "this_year" | "last_year"
  | { kind: "past"; days: number }
  | { kind: "future"; days: number };

interface Sort {
  property_id: string;
  direction: "asc" | "desc";
}
```

The runtime translates filters to SQL with parameterised queries. A small recursive walker emits `WHERE` fragments; nothing is interpolated as text.

### 6.3 View storage

```sql
CREATE TABLE views (
  id           TEXT PRIMARY KEY,
  database_id  TEXT NOT NULL,
  position     TEXT NOT NULL,
  type         TEXT NOT NULL,
  name         TEXT NOT NULL,
  config_json  TEXT NOT NULL,          -- the union above
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  FOREIGN KEY (database_id) REFERENCES databases(id) ON DELETE CASCADE
);
```

Every database has at least one view (auto-created table view). Deleting the last view fails with `LAST_VIEW_REQUIRED`.

### 6.4 Query execution: rows + view config → result

`databases.query({ database_id, view_id?, filter?, sort?, limit, cursor })` resolves to:

1. Load view config (if `view_id` given) and merge with explicit overrides — explicit wins.
2. Build the SQL: `SELECT ... FROM rows JOIN property_values ... WHERE filter AND deleted_at IS NULL ORDER BY sort LIMIT ...`.
3. Execute. Return `{ rows, total, next_cursor }`.

Pagination uses cursor-based scrolling (`(position, id)` tuple) for stable ordering across mutations.

For board view: the runtime returns rows pre-grouped (`{ groups: [{ key, rows[], count }] }`) when called with `group_by_property_id`, to save the editor a regroup pass.

---

## 7. SQLite DDL — full schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO meta(key, value) VALUES ('schema_version', '1');

-- Pages: a page is the unit a user opens
CREATE TABLE pages (
  id              TEXT PRIMARY KEY,
  parent_page_id  TEXT,                       -- page hierarchy / nesting
  database_id     TEXT,                       -- non-null when this page is a row
  row_id          TEXT,                       -- rows.id when database_id is set
  title           TEXT NOT NULL DEFAULT '',
  icon_json       TEXT,                       -- { kind: "emoji"|"url", value }
  cover_json      TEXT,                       -- { kind, source, position }
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT,
  FOREIGN KEY (parent_page_id) REFERENCES pages(id) ON DELETE CASCADE
);
CREATE INDEX idx_pages_parent ON pages(parent_page_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_pages_row ON pages(row_id) WHERE row_id IS NOT NULL;

-- Blocks: nodes inside a page's content tree
CREATE TABLE blocks (
  id              TEXT PRIMARY KEY,
  page_id         TEXT NOT NULL,
  parent_block_id TEXT,
  position        TEXT NOT NULL,
  type            TEXT NOT NULL,
  content_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT,
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);
CREATE INDEX idx_blocks_page ON blocks(page_id, parent_block_id, position) WHERE deleted_at IS NULL;

-- Databases
CREATE TABLE databases (
  id            TEXT PRIMARY KEY,
  owner_page_id TEXT NOT NULL,                -- page where the inline block lives
  owner_block_id TEXT NOT NULL,
  name          TEXT NOT NULL,
  icon_json     TEXT,
  description   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  FOREIGN KEY (owner_page_id) REFERENCES pages(id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_block_id) REFERENCES blocks(id) ON DELETE RESTRICT
);

-- Properties
CREATE TABLE properties (
  id           TEXT PRIMARY KEY,
  database_id  TEXT NOT NULL,
  position     TEXT NOT NULL,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL,
  config_json  TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  FOREIGN KEY (database_id) REFERENCES databases(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX uniq_properties_name ON properties(database_id, name) WHERE deleted_at IS NULL;

-- Rows
CREATE TABLE rows (
  id           TEXT PRIMARY KEY,
  database_id  TEXT NOT NULL,
  page_id      TEXT NOT NULL,                 -- the row's page
  position     TEXT NOT NULL,
  cache_json   TEXT NOT NULL DEFAULT '{}',    -- formula/rollup cache
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  FOREIGN KEY (database_id) REFERENCES databases(id) ON DELETE CASCADE,
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);
CREATE INDEX idx_rows_database ON rows(database_id, position) WHERE deleted_at IS NULL;

-- Property values
CREATE TABLE property_values (
  row_id       TEXT NOT NULL,
  property_id  TEXT NOT NULL,
  value_json   TEXT NOT NULL,
  PRIMARY KEY (row_id, property_id),
  FOREIGN KEY (row_id) REFERENCES rows(id) ON DELETE CASCADE,
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
);
CREATE INDEX idx_pv_value_text ON property_values(property_id, json_extract(value_json, '$.value'));

-- Views
CREATE TABLE views (
  id           TEXT PRIMARY KEY,
  database_id  TEXT NOT NULL,
  position     TEXT NOT NULL,
  type         TEXT NOT NULL,
  name         TEXT NOT NULL,
  config_json  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  FOREIGN KEY (database_id) REFERENCES databases(id) ON DELETE CASCADE
);

-- Relations (two-way, indexable both directions)
CREATE TABLE relations (
  from_row_id  TEXT NOT NULL,
  to_row_id    TEXT NOT NULL,
  property_id  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (from_row_id, property_id, to_row_id),
  FOREIGN KEY (from_row_id) REFERENCES rows(id) ON DELETE CASCADE,
  FOREIGN KEY (to_row_id) REFERENCES rows(id) ON DELETE CASCADE,
  FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
);
CREATE INDEX idx_relations_to ON relations(to_row_id, property_id);

-- Mutation journal (for ops, undo, future CRDT)
CREATE TABLE journal (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  actor        TEXT NOT NULL,                 -- "user" | "agent:<name>" | "system"
  page_id      TEXT,                          -- nullable: cross-page ops set NULL
  op_kind      TEXT NOT NULL,                 -- e.g. "block.update"
  op_json      TEXT NOT NULL,                 -- the op payload
  inverse_json TEXT NOT NULL                  -- inverse op for undo
);
CREATE INDEX idx_journal_page ON journal(page_id, seq);

-- Trash (soft-deleted resources, 30-day TTL, swept by background job)
CREATE TABLE trash (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,                 -- "page"|"database"|"block"|"row"|...
  payload_json TEXT NOT NULL,
  deleted_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
```

---

## 8. Runtime API surface

All endpoints are hosted by the in-sandbox runtime (`holaOS/runtime/api-server`) under `/api/v1/workspaces/:workspace_id/...`.

JSON-RPC-flavoured. Every mutation returns `{ ok: true, result, op: { id, inverse } }` so the client can keep an undo stack and reconcile journal entries.

### 8.1 Pages

```
GET    /pages                              ?parent_page_id&include_archived
POST   /pages                              { parent_page_id?, title, icon? }
GET    /pages/:id                          → { page, blocks[] }
PATCH  /pages/:id                          { title?, icon?, cover?, archived? }
DELETE /pages/:id                          → soft delete; cascade pages, blocks, dbs (if owner)
POST   /pages/:id/restore
POST   /pages/:id/duplicate                { include_children?: boolean }
POST   /pages/:id/move                     { new_parent_page_id, position? }
GET    /pages/:id/breadcrumbs              → ancestor list
GET    /pages/:id/events                   (SSE stream — see §8.7)
```

### 8.2 Blocks

```
POST   /pages/:page_id/blocks              { parent_block_id?, position, type, content }
PATCH  /blocks/:id                         { position?, content?, type? }
   -- type changes restricted to compatible groups (paragraph ↔ heading_x ↔ list_*)
DELETE /blocks/:id                         → soft delete
POST   /blocks/:id/restore
POST   /blocks/:id/move                    { new_parent_block_id?, new_page_id?, position }
POST   /blocks/:id/duplicate
POST   /pages/:page_id/blocks/batch        { ops: BlockOp[] }
   -- atomic batch: insert, update, move, delete in one transaction.
   -- Tiptap/ProseMirror commits multi-step transactions as one op batch.
```

### 8.3 Databases

```
POST   /databases                          { owner_page_id, owner_block_id, name, properties? }
GET    /databases/:id                      → { database, properties[], views[], stats }
PATCH  /databases/:id                      { name?, icon?, description? }
DELETE /databases/:id                      → soft delete (cascade rows, properties, views)
POST   /databases/:id/restore
GET    /databases/:id/schema               → { properties[] }
```

### 8.4 Properties

```
POST   /databases/:db/properties           { name, type, config?, position? }
PATCH  /properties/:id                     { name?, config?, position? }
PATCH  /properties/:id/type                { type, config?, migration_options? }
DELETE /properties/:id
POST   /properties/:id/options             { name, color }    -- select/multi_select option add
PATCH  /options/:id                        { name?, color?, position? }
DELETE /options/:id                        -- removes option_id from all property_values
```

### 8.5 Rows

```
GET    /databases/:db/rows                 ?view_id&filter&sort&limit&cursor
                                           → { rows[], total, next_cursor }
POST   /databases/:db/rows                 { values?: { [property_id]: value }, position? }
GET    /rows/:id                           → { row, property_values, page, blocks }
PATCH  /rows/:id                           { values?: {...}, position? }
DELETE /rows/:id                           → cascade delete row's page
POST   /rows/:id/restore
POST   /rows/batch                         { ops: RowOp[] }
```

### 8.6 Views

```
POST   /databases/:db/views                { type, name, config }
PATCH  /views/:id                          { name?, config?, position? }
DELETE /views/:id
```

### 8.7 Events (SSE)

```
GET /pages/:id/events
   → text/event-stream
```

Event types:

```
event: block.created      data: { block }
event: block.updated      data: { id, patch }
event: block.deleted      data: { id }
event: block.moved        data: { id, new_parent_block_id, new_position }
event: page.updated       data: { id, patch }
event: database.changed   data: { database_id, kind: "schema"|"row"|"view" }
event: row.changed        data: { database_id, row_id, kind: "values"|"position"|"deleted" }
```

Subscribers join per-page; one stream covers everything that affects rendering for that page (including the embedded databases and their visible rows).

### 8.8 Query (legacy / module data)

```
POST /query                                { sql }
   → { ok, columns[], rows[][], elapsed_ms }
```

This is the existing `runDashboardQuery` endpoint, renamed. Used by `kpi`, `chart`, `sql_table` blocks. Read-only — runtime opens `data.db` with `mode=ro`.

### 8.9 Search

```
GET /search                                ?q=...&kind=page|database&limit
   → { results: [ { kind, id, title, snippet, page_path } ] }
```

Index: SQLite FTS5 on `pages.title`, all rich-text block content, and database/property names. Index updated synchronously on writes; full reindex available via runtime job.

### 8.10 Attachments

```
POST   /attachments                        multipart/form-data → { path, name, size, mime }
GET    /attachments/*                      stream file
DELETE /attachments/:path
```

Files stored under `workspace/<id>/attachments/<uuid>.<ext>`. Block content references `path: "attachments/..."` — relative to workspace root.

### 8.11 Trash

```
GET    /trash                              ?kind&before
POST   /trash/:id/restore
DELETE /trash/:id                          → permanent delete
```

Background job sweeps trash older than 30 days nightly.

### 8.12 Undo / redo

```
POST /pages/:id/undo                       → applies inverse of most recent journal entry
POST /pages/:id/redo
```

Undo is per-page locally. The journal records inverse ops at write time so undo is `O(1)`. Cross-page undo (e.g. moved a block to another page) is bounded — the inverse op moves it back.

---

## 9. Agent MCP tool surface

These are the tools an agent calls. Each maps 1:1 to a runtime API endpoint, with input/output sized to fit a typical LLM tool call (no oversized blobs in responses).

### 9.1 Page tools

```
pages.create({ parent_page_id?, title, icon? })
   → { page_id }

pages.get({ page_id, include_blocks?: boolean = true })
   → { page, blocks?[] }
   -- when include_blocks=true and the page is large (> 200 blocks),
      response is paginated; agent must call pages.get_blocks for more.

pages.get_blocks({ page_id, after_block_id?, limit?: number = 100 })
   → { blocks[], next_after_block_id? }

pages.update({ page_id, title?, icon?, cover?, archived? })
   → { ok }

pages.delete({ page_id })
   → { ok }

pages.move({ page_id, new_parent_page_id, position? })
   → { ok }

pages.list({ parent_page_id?, query?, limit?: number = 50, cursor? })
   → { pages: [{ id, title, icon, parent_page_id, updated_at }], next_cursor? }
```

### 9.2 Block tools

```
blocks.append({ page_id, parent_block_id?, blocks: BlockSpec[] })
   → { block_ids[] }
   -- BlockSpec is the partial block: { type, content, children? }
   -- children supported recursively for convenience; runtime flattens.

blocks.insert({ page_id, after_block_id?, before_block_id?, blocks: BlockSpec[] })
   → { block_ids[] }

blocks.update({ block_id, content?: PartialContent, type? })
   → { ok }

blocks.delete({ block_id })
   → { ok }

blocks.move({ block_id, new_parent_block_id?, new_page_id?, position })
   → { ok }
```

### 9.3 Database tools

```
databases.create({
  owner_page_id,
  name,
  properties: PropertySpec[],     // schema
  initial_view?: ViewSpec
})
   → { database_id, owner_block_id, default_view_id }
   -- The runtime creates the database_inline block automatically and returns its id.

databases.get({ database_id })
   → { database, properties[], views[], stats: { row_count } }

databases.update({ database_id, name?, icon?, description? })

databases.add_property({
  database_id,
  property: PropertySpec
})
   → { property_id }

databases.update_property({
  property_id,
  name?, config?, position?
})

databases.change_property_type({
  property_id,
  new_type,
  new_config?,
  on_failure?: "drop_value" | "abort"
})
   → { migrated: number, dropped: number }

databases.delete_property({ property_id })

databases.add_row({
  database_id,
  values?: { [property_name]: any },
  // Names accepted as ergonomic shortcut; resolved server-side.
  // For agents that have property_ids, also accept value_ids.
  values_by_id?: { [property_id]: any },
  position?: "first" | "last" | { after_row_id: string }
})
   → { row_id, page_id }

databases.update_row({
  row_id,
  values?: { ... },
  values_by_id?: { ... }
})

databases.delete_row({ row_id })

databases.query({
  database_id,
  filter?, sort?, group_by_property_id?,
  property_ids?: string[],         // projection — return only these
  limit?: number = 50,
  cursor?
})
   → { rows[], total, next_cursor? }
   -- rows are { id, page_id, values: { [property_id]: { name, type, value } } }

databases.create_view({
  database_id,
  type, name, config
})
   → { view_id }

databases.update_view({ view_id, name?, config? })
databases.delete_view({ view_id })
```

### 9.4 Query-backed block tools (legacy / module data)

```
query.run({ sql, parameters? })
   → { columns[], rows[][], elapsed_ms }

blocks.append_kpi({ page_id, parent_block_id?, title, query, format?, ... })
blocks.append_chart({ page_id, parent_block_id?, title, query, chart })
blocks.append_sql_table({ page_id, parent_block_id?, title, query, views })
   -- thin sugar over blocks.append for agents that come from the .dashboard world.
```

### 9.5 Tool naming / namespacing

All tools live under the `pages.*` / `blocks.*` / `databases.*` / `query.*` MCP namespaces, exposed by the **runtime's MCP server** alongside existing module MCP servers. The MCP discriminator is the prefix `pages_create`, `databases_add_row`, etc. (underscore separator, matching existing module convention `twitter_create_post`).

---

## 10. Cross-cutting concerns

### 10.1 IDs

UUIDv7 everywhere. Time-prefixed so:
- Default ordering is meaningful (newest at end without an extra `position`).
- ID is unique across actors without coordination — important for offline edits and agent writes.

Format: `{kind_prefix}_{uuidv7-base32}`. E.g. `page_01HX7K…`, `block_01HX7K…`, `db_01HX7K…`.

### 10.2 Fractional indexing

`position` columns use **string fractional indices** (`a0`, `a0V`, `a1`, ...) not floats. Floats lose precision on N-th midpoint insertions; strings are stable forever.

Library: `fractional-indexing` (BSD). Algorithm: "between(a, b)" returns a string strictly between a and b. Initial positions are spaced; rebalance is rare.

Reorder operations write only the moved item's position. Conflict resolution under future CRDT collapses naturally (Y.Map of position strings + LWW per ID).

### 10.3 Mutation operations and journal

Every mutation is internally an **op**:

```ts
type Op =
  | { kind: "block.create"; block: Block }
  | { kind: "block.update"; id: string; patch: Partial<Block> }
  | { kind: "block.delete"; id: string }
  | { kind: "block.move"; id: string; from: Loc; to: Loc }
  | { kind: "row.create"; row: Row; property_values: PropertyValue[] }
  | { kind: "row.update_value"; row_id: string; property_id: string; value: any }
  | { kind: "property.create" | "property.update" | "property.delete"; ... }
  | ...
```

Each op has a deterministic inverse, written to `journal.inverse_json` at the same time. Undo replays the inverse. This is also the **CRDT seam**: when we move to Yjs, ops translate to Y.Doc transactions and we stop journaling locally (the Y.Doc is the journal). The op shapes do not change.

### 10.4 Optimistic updates

Frontend mutation flow (Tiptap → store → API):

1. User edit produces a ProseMirror transaction (via Tiptap command).
2. Command handler builds an op, applies it to local Zustand store, returns immediately so the editor re-renders.
3. Op is queued in a per-page mutation queue (FIFO).
4. Queue worker POSTs to runtime; on success, marks op committed.
5. On failure: roll back the op locally, surface a toast.

The queue is per-page so blocking ops do not stall other pages. Each op has a client-generated ID matched server-side (idempotent).

### 10.5 Rate limits & batching

- Editor batches block-level mutations within a 50ms window into one `blocks/batch` request. Typing a paragraph rarely sends more than one HTTP request per second.
- Agent tool calls are **not** rate-limited at the runtime layer — agents typically issue tens of ops, not thousands. If we see runaway tool calls in practice, add a per-session quota.

### 10.6 File system materialization

Source of truth: SQLite. But the runtime keeps a **rendered JSON mirror** on disk so agents and File Explorer can see pages as files:

```
workspace/<id>/pages/<page_id>.page.json           — page + blocks
workspace/<id>/databases/<database_id>.database.json — db + properties + views
workspace/<id>/attachments/<uuid>.<ext>
```

Mirror is rewritten by a debounced job (250ms) after writes. **Files are read-only from the user's perspective**: editing the JSON file doesn't sync back to SQLite. They exist for backup / git inspection / agent diff. (Agents should mutate via tools, not by writing files.)

If a user *really* wants to edit JSON manually, they can — the runtime accepts a `POST /pages/:id/import` that reads the on-disk JSON and replays it as ops. This is a power-user / recovery feature, not a primary path.

`.dashboard` files in `dashboards/` are deprecated but remain readable through Phase 4 by a compat shim that loads them, runs the migrator (§12), and exposes the resulting page IDs. Phase 4 ends with the directory deleted.

### 10.7 Permissions

Single-sandbox / single-user — no permissions in v1. Document the intent: when collab arrives, every page/database carries `permissions: { read[], write[] }` in `meta_json`, default to `[*]` for backwards compat.

### 10.8 Error model

```
4xx errors:
   { error: { code: "VALIDATION" | "NOT_FOUND" | "CONFLICT"
                    | "TYPE_MIGRATION_FAILED" | "LAST_VIEW_REQUIRED"
                    | "RELATION_TARGET_MISSING" | ...,
              message, details? } }
5xx: { error: { code: "INTERNAL", message, request_id } }
```

Validation errors include a path (e.g. `properties[2].config.options[0].color`) so the editor can highlight the offending field.

### 10.9 Logging & observability

- Runtime emits structured logs (existing pino setup). Every mutation logs `{ event: "page.block.update", outcome: "success", page_id, block_id, op_kind, duration_ms }`.
- Slow-query log: any `databases.query` over 250ms logs the SQL plan.
- Counters: page open count, ops/sec, undo invocations, query durations. Surface in `/api/v1/runtime/status`.

---

## 11. Editor architecture

### 11.1 Stack

- **Tiptap v3** (`@tiptap/core`, `@tiptap/react`, `@tiptap/pm` ProseMirror peer)
- **ProseMirror** (transitively, exposed when we need direct schema/transform access)
- **y-prosemirror** (deferred — installed at Phase 7, not before)
- **Zustand** (per-workspace global state — pages list, active page, mutation queue)
- **React 19** (existing desktop app)
- **Tailwind v4** (existing tokens)
- **@dnd-kit/core** (drag handles, board reorder, column reorder)
- **@tanstack/react-table** (table view inside `database_inline` — purely presentational; we own state)
- **fractional-indexing** (the npm package)
- **uuidv7**

No reuse of `@holaboss/editor` source — that package is a separate Tiptap wrapper the user judged not fit for purpose. New package: `holaOS/desktop/src/lib/editor/` (not a workspace package — purely local for now; promote to a package if frontend wants to consume). Reference projects (read, do **not** depend on): `steven-tey/novel`, `TypeCellOS/BlockNote` source, `ueberdosis/tiptap-templates`.

### 11.2 ProseMirror schema / Tiptap node taxonomy

Standard / extended Tiptap nodes for most blocks:

| Block | Tiptap extension |
|---|---|
| paragraph | `@tiptap/extension-paragraph` |
| heading_* | `@tiptap/extension-heading` (levels 1–3) |
| bulleted_list_item | `@tiptap/extension-bullet-list` + `@tiptap/extension-list-item` |
| numbered_list_item | `@tiptap/extension-ordered-list` + list-item |
| to_do | `@tiptap/extension-task-list` + `@tiptap/extension-task-item` |
| toggle | custom `ToggleNode` extending `Node` (ProseMirror `Node`, content `block+`) |
| quote | `@tiptap/extension-blockquote` |
| callout | custom `CalloutNode` (block+, attrs: `icon`, `color`) |
| code | `@tiptap/extension-code-block` (+ Shiki for highlighting) |
| divider | `@tiptap/extension-horizontal-rule` |

NodeView-rendered (custom React subtree, atomic from ProseMirror's POV):

| Block | Tiptap node | React component |
|---|---|---|
| image / file / video / embed / bookmark | custom `MediaNode` (atom, attrs: `source`, `caption`, `width`) | `<MediaBlock>` via `ReactNodeViewRenderer` |
| database_inline | `DatabaseInlineNode` (atom) | `<DatabaseInlineBlock>` |
| database_linked | `DatabaseLinkedNode` (atom) | `<DatabaseLinkedBlock>` |
| kpi | `KpiNode` (atom) | `<KpiBlock>` |
| chart | `ChartNode` (atom) | `<ChartBlock>` |
| sql_table | `SqlTableNode` (atom) | `<SqlTableBlock>` |
| column_list / column | structural nodes (ProseMirror block container) | — |

NodeView pattern: each custom node declares `addNodeView(() => ReactNodeViewRenderer(<Component>))`. The React component receives `node`, `updateAttributes`, `selected`, and is rendered by ProseMirror in a stable DOM slot. For our use case all custom blocks are `atom: true` — ProseMirror does not descend into them — which means the inner database/cell editors are owned entirely by our React tree, not by ProseMirror's transaction system. Cell edits don't go through Tiptap commands; they go through the same op queue described in §10.3.

Each NodeView serializes its content payload via `parseHTML` / `renderHTML` for HTML I/O, and `addAttributes` for JSON I/O. Round-trip with our runtime block format is via `editor.getJSON()` / `editor.commands.setContent(json)` plus a thin layer that maps Tiptap's `{ type, attrs, content }` shape to our block envelope. The mapping is bidirectional and total for the standard set.

### 11.3 Extensions

Tiptap extensions to ship in Phase 1, ordered by criticality:

1. **PersistenceExtension** — registers a transaction handler (`editor.on('transaction')`) that diffs `editor.state.doc` against the previous doc, derives the minimum op set, and pushes to the mutation queue. The diff algorithm walks ProseMirror's step list (`tr.steps`) — each `Step` (`ReplaceStep`, `AddMarkStep`, `RemoveMarkStep`, `AttrStep`) maps to one or more ops. This avoids re-implementing diff from scratch.
2. **SlashCommandExtension** — `/` triggers menu (use `@tiptap/suggestion` infrastructure; same suggestion API powers mentions and emoji).
3. **DragHandleExtension** — left-margin handle for drag-to-reorder + "+" affordance. Reference: `tiptap-extension-global-drag-handle`. We may fork rather than depend, since the package is small and we want stable behaviour.
4. **BlockMenuExtension** — per-block context menu (turn-into, duplicate, copy link, color, delete). Built on `BubbleMenu`/`FloatingMenu` Tiptap primitives.
5. **MarkdownShortcutsExtension** — bundled inputRules for `# `, `## `, `- `, `> `, "```", `[]`. Tiptap's `@tiptap/extension-input-rule` is the base.
6. **MentionExtension** — `@tiptap/extension-mention` extended for our four mention kinds (page/database/row/user).
7. **AutoLinkExtension** — `@tiptap/extension-link` + paste handler that decides bookmark vs inline link based on cursor context.
8. **TableOfContentsExtension** — outline derived from heading nodes; Tiptap ships `@tiptap/extension-table-of-contents` (Pro) but the OSS pattern is straightforward — implement directly.
9. **EmojiPickerExtension** — `:` triggers picker, same `@tiptap/suggestion` infrastructure.
10. **LinkExtension** — Cmd-K link editing UI (`@tiptap/extension-link` + custom bubble UI).
11. **CodeHighlightExtension** — `@tiptap/extension-code-block-lowlight` with Shiki. Existing desktop already uses Shiki (`apps/electron/src/renderer/components/shiki/ShikiCodeEditor.tsx` in craft-agents-oss is one reference, though the runtime is separate).

Inline marks: `@tiptap/extension-bold`, `italic`, `underline`, `strike`, `code`, `text-color`, `highlight`. Standard.

Forbidden / explicitly NOT used: `@tiptap/pro/*` (paid; we DIY equivalents). `@holaboss/editor` (existing wrapper; do not import).

### 11.4 Database block — internal architecture

`<DatabaseInlineBlock>` is a self-contained React subtree:

```
<DatabaseInlineBlock database_id view_id>
  <DatabaseToolbar>
    <ViewTabs views[] active />
    <DatabaseTitle editable />
    <ToolbarButtons>
      <FilterMenu />
      <SortMenu />
      <PropertyMenu />
      <NewRowButton />
    </ToolbarButtons>
  </DatabaseToolbar>
  <DatabaseView>
    {viewType === "table"     && <TableView />}
    {viewType === "board"     && <BoardView />}
    {viewType === "list"      && <ListView />}
    {viewType === "gallery"   && <GalleryView />}
    {viewType === "calendar"  && <CalendarView />}
    {viewType === "timeline"  && <TimelineView />}
  </DatabaseView>
</DatabaseInlineBlock>
```

State: each open database mounts a `useDatabase(database_id, view_id)` hook that:

1. Fetches `databases.get` once.
2. Subscribes to the page's SSE stream for `database.changed` / `row.changed` events filtered by this database_id.
3. Maintains rows in a paginated cache keyed by view config + cursor.
4. Exposes mutation helpers (`addRow`, `updateValue`, `addProperty`, ...) that go through the same op queue as the editor.

Cell editors are property-type-keyed:

```
const CELL_EDITORS = {
  text: TextCell,
  number: NumberCell,
  checkbox: CheckboxCell,
  select: SelectCell,
  multi_select: MultiSelectCell,
  date: DateCell,
  url: UrlCell,
  ...
};
```

Each cell editor has shape `{ value, onChange, property, row }`. Inline editing mounts the editor in-place; clicking out commits.

### 11.5 Row page

Opening a row (clicking the row's first cell or the "open" affordance) navigates to the row's page. The row page renders:

```
<RowPage page_id row_id>
  <PageHeader>
    <Cover />
    <Icon />
    <Title editable />
    <PropertiesPanel>
      <PropertyRow property=... value=... onChange=... />
      ...
      <AddPropertyButton />
    </PropertiesPanel>
  </PageHeader>
  <PageContent>
    <PageEditor blocks={page.blocks} />   {/* Tiptap EditorContent under the hood */}
  </PageContent>
</RowPage>
```

The properties panel is the same set of cell editors used in the table view — they are reused.

### 11.6 Routing

Existing `holaOS/desktop` is Electron; the app shell mounts an `InternalSurfacePane` which today picks renderers by file extension. We replace that branch with a "page surface" that takes a `page_id`:

```
<InternalSurfacePane>
  preview.kind === "page" → <PageSurface page_id />
  preview.kind === "file" + ext === ".dashboard" → <LegacyDashboardRenderer /> (compat, Phases 0-4)
  preview.kind === "file" → <FileRenderer />
</InternalSurfacePane>
```

`PageSurface` mounts the editor with the page's blocks, the breadcrumb header, and the SSE subscription. Tabs in the AppShell can hold multiple `PageSurface` instances (multi-tab editing).

### 11.7 Theming

Use existing `holaOS/desktop` Tailwind tokens. New tokens added:
- `--page-max-width` (default 720px, "wide" 1200px toggleable per page)
- `--page-cover-height` (220px)
- `--block-handle-size` (24px)
- Property type colours map to existing OKLch palette (`green`, `blue`, ...) — no new tokens.

Density: editor follows the same dense / craft-quality direction as Cursor. No giant whitespace, no pill-y buttons in the editor surface.

### 11.8 Accessibility

- All cell editors are keyboard-navigable (Tab / arrow / Enter / Esc).
- Block menu has keyboard equivalent (Cmd-/ on macOS).
- Slash menu trapped focus; Esc closes.
- ARIA: each block has `role="article"` or `role="row"` as appropriate; database tables use `role="grid"`.
- Reduced motion: respect `prefers-reduced-motion` for any block reorder transitions.

---

## 12. Migration from `.dashboard`

### 12.1 One-shot migrator

A runtime job `migrators.dashboard_to_page` runs on startup if `meta.dashboard_migrated_at` is unset.

For each `*.dashboard` file in `workspace/<id>/files/dashboards/`:

1. Parse YAML using existing `dashboardSchema.ts`.
2. Create a new page: title from YAML `title`, description converted to a paragraph block right under the title, parent_page = a new top-level "Migrated dashboards" page.
3. Walk panels in order, emit blocks:
   - `text` → markdown blocks (markdown→Tiptap via `@tiptap/extension-markdown` import; or our own thin converter if the extension doesn't cover all our blocks).
   - `kpi` → `kpi` block (preserve `query`, `delta_query`, `target`, `format`, `currency`, `empty_state`).
   - `stat_grid` → a `column_list` containing `column` children, each with one `kpi` block.
   - `chart` → `chart` block (preserve `query`, `chart` config).
   - `data_view` → `sql_table` block, with all views preserved as `sql_table.views`.
4. Apply `width: half/third` by wrapping adjacent narrow blocks in `column_list`.
5. Store original YAML in `pages.meta_json.legacy_dashboard_yaml` for one release cycle (reversibility).
6. Move the original file to `workspace/<id>/files/dashboards.archive/`.

Migrator emits a report: `{ migrated: N, failed: M, skipped: K }` to `journal` and `runtime.log`.

### 12.2 Reverse migration (escape hatch)

For one release after Phase 4 ships, `migrators.page_to_dashboard` can convert simple pages back to `.dashboard` YAML — only if the page contains nothing but query-backed blocks and text. Used by users who must export to YAML for some reason. Drop this hatch in the next release.

### 12.3 Module-shipped dashboards

Some modules (twitter, linkedin, reddit) ship `.dashboard` files in their `dashboards/` directory. These get migrated on app install:

1. App install lifecycle adds a hook: after `lifecycle.setup`, run migrator on the app's `dashboards/` directory.
2. Each migrated dashboard becomes a page under the app's namespace page (e.g. "Twitter / Twitter metrics").
3. The app no longer ships `.dashboard` files in v2 — the install hook accepts JSON page exports (`*.page.json`).
4. Apps already shipping `.dashboard` keep working until Phase 4 ships; after that, modules must convert.

Affected modules: `twitter`, `linkedin`, `reddit` (per current repo). Owners of those modules sign off on the migration via PR review.

### 12.4 Acceptance check

Migration success criteria for a `.dashboard` file:

- All panels appear as blocks in the same order.
- KPI / chart / sql_table blocks render data identical to the legacy renderer (visual parity tested via screenshot diff in Storybook).
- Width hints (`full`/`half`/`third`) preserved through `column_list` layout.
- `description`, `empty_state`, `refresh_interval_s` preserved.

Anything we cannot represent (none today, but future-proof) logs a warning and falls back to a paragraph block with the YAML excerpt.

---

## 13. Sandbox runtime integration

### 13.1 Code layout

```
holaOS/runtime/api-server/src/
├── index.ts                 # Fastify bootstrap (existing)
├── pages/                   # NEW
│   ├── routes.ts            # /pages, /blocks
│   ├── service.ts           # PagesService
│   ├── persistence.ts       # SQLite read/write for pages, blocks
│   ├── events.ts            # SSE bus
│   ├── ops.ts               # Op type + inverse computation
│   ├── materializer.ts      # On-disk JSON mirror writer
│   └── migrator/
│       └── dashboard.ts     # .dashboard → page conversion
├── databases/               # NEW
│   ├── routes.ts
│   ├── service.ts
│   ├── properties.ts
│   ├── values.ts
│   ├── views.ts
│   ├── filter-sql.ts        # Filter DSL → SQL
│   ├── relations.ts
│   ├── rollups.ts
│   └── formula/
│       ├── parser.ts
│       └── evaluator.ts
├── attachments/             # NEW
├── search/                  # NEW (FTS5 wrapper)
├── trash/                   # NEW
├── workspace-apps.ts        # existing — module app lifecycle
└── workspaces.ts            # existing — file CRUD (will not host pages)
```

Existing `runDashboardQuery` IPC stays in place, exposed as `POST /query` (renamed in Phase 4).

### 13.2 SQLite migrations

`pages.db` is a separate file from `data.db`. Migrations live in `runtime/api-server/src/pages/migrations/` and run on runtime startup:

- `0001_initial.sql` — full schema from §7
- Future migrations append; never edit committed migrations
- `meta.schema_version` tracks the current schema
- Backwards compatibility: a runtime upgrade with a higher `schema_version` than the DB triggers migrations; downgrades refuse to start (log error, exit non-zero — same convention as data.db migrations).

### 13.3 IPC and contracts

Frontend talks to runtime over the existing Electron IPC (`window.electronAPI.workspace.*`). Add:

```ts
window.electronAPI.workspace = {
  ...existing,
  pages: {
    list, get, create, update, delete, move, restore, duplicate, breadcrumbs,
    blocks: { append, insert, update, delete, move, batch },
    events: (page_id) => EventSource,
  },
  databases: {
    create, get, update, delete,
    properties: { add, update, changeType, delete, addOption, updateOption, deleteOption },
    rows: { list, get, create, update, delete, batch },
    views: { create, update, delete },
    query: ( ... ),
  },
  attachments: { upload, delete },
  search: ( ... ),
  trash: { list, restore, purge },
  undo, redo,
};
```

Each method is a wrapper that POSTs to runtime via the existing privileged HTTP channel.

### 13.4 Backwards compatibility windows

| Feature | Available through | Removed in |
|---|---|---|
| `.dashboard` YAML files (read) | Phase 4 | Phase 5 |
| `.dashboard` YAML files (write by agent) | Phase 1 | Phase 2 |
| `runDashboardQuery` IPC name | Phase 4 | Phase 5 |
| Existing `dashboardSchema.ts` | Phase 4 (used by migrator) | Phase 5 |

---

## 14. Phased rollout

Each phase is a deployable increment. No phase ships partial — internal feature flags hide WIP. Estimates assume one engineer full-time.

### Phase 0 — Foundation (1–2 weeks)

**Goal**: prove the editor + persistence shape with a minimal end-to-end slice **and de-risk the four research-flagged Tiptap/ProseMirror concerns** before committing the entire design to it.

- [ ] Tiptap scaffolding in `holaOS/desktop/src/lib/editor/`. Render paragraph + heading.
- [ ] Define block JSON schema (TypeScript types, Zod validators) + the bidirectional mapping `OurBlock ↔ Tiptap JSON`.
- [ ] Add `pages.db` to runtime; ship `0001_initial.sql`.
- [ ] Implement `POST /pages`, `GET /pages/:id`, `POST /blocks`, `PATCH /blocks/:id`, `DELETE /blocks/:id`.
- [ ] Implement op + inverse + journal.
- [ ] PersistenceExtension: ProseMirror transaction → op → POST.
- [ ] PageSurface mounts editor; loads page on file extension `.page` (provisional UX).
- [ ] Mutation queue with optimistic update + rollback.

**Risk-burn-down checklist** (each must pass before Phase 1 start; failing any one triggers a hard reconsideration of the editor choice):

- [ ] **R1 — NodeView hosts a self-contained React island.** Build a throwaway `DatabaseInlineNode` (`atom: true`, NodeView-rendered) that renders a React subtree containing a contenteditable cell editor; verify (a) cursor on the parent paragraph is preserved when clicking into / out of the island, (b) the cell editor's own selection works independently of ProseMirror's, (c) typing in the cell does **not** trigger a ProseMirror transaction on the parent doc, (d) `selected` prop reaches the React component when the island is selected as a whole. Reference: Tiptap NodeView docs + BlockNote source for atom-with-React-island patterns.
- [ ] **R2 — ProseMirror transaction → op minimal-diff algorithm.** Walk `tr.steps` (ReplaceStep / AddMarkStep / RemoveMarkStep / AttrStep) and emit one or more ops per step. Property-based test: fuzz 1000 random op sequences, apply via `editor.commands`, derive diff from each transaction, replay diff to a fresh editor, assert `editor.getJSON()` equality. Target: zero divergence in 1000 runs.
- [ ] **R3 — Performance baseline.** 5000-block paragraph document, p95 keystroke latency < 50ms on M-series Mac. **This is the riskiest item** — Tiptap has documented slowness past 1500 nodes (issues #4491, #3340). Mitigation toolkit if R3 fails: (a) virtualised rendering (mount only viewport + buffer), (b) ProseMirror `view.update()` throttling, (c) smaller schema (fewer marks per text node). If none of these clear < 50ms p95, this is a fork in the road — see fallback below.
- [ ] **R4 — Tiptap JSON ↔ our block JSON round-trip.** All 9 standard block types parse from our block envelope into Tiptap JSON and back, byte-equivalent. Includes attribute preservation through `editor.getJSON()` and `editor.commands.setContent()`.
- [ ] **R5 — Pin Tiptap version.** Pin `@tiptap/core@^3.x` and `@tiptap/pm@^3.x` (current stable at Phase 0 start). Lockfile committed. Bump policy: minor bumps reviewed monthly; majors only at phase boundaries.

Exit criteria:
1. R1–R5 all pass.
2. Open a new page, type paragraphs and headings, close + reopen — content persists.
3. Two windows of the same page each see the other's edits via SSE within 200ms.

Fallback: if R3 fails irreparably (5000 blocks always > 100ms p95 even with virtualisation), re-evaluate Lexical for performance specifically — its immutable reconciler scales further. The rest of the design (data model, API, agent surface, block JSON spec) is editor-agnostic and survives the swap unchanged. R1, R2, R4 are unlikely to fail given Tiptap's maturity; if they do, the cause is most likely our schema design, not the framework.

### Phase 1 — Page MVP (3 weeks)

**Goal**: usable rich editor for plain pages.

- [ ] Block types: paragraph, heading_1/2/3, bulleted/numbered list, to_do, toggle, quote, callout, code, divider.
- [ ] Slash menu (CommandsPlugin).
- [ ] Drag handle (DragHandlePlugin).
- [ ] Block menu (BlockMenuPlugin).
- [ ] Markdown shortcuts.
- [ ] Mentions (page references).
- [ ] Inline formatting (bold, italic, underline, strikethrough, code, color, link).
- [ ] Undo/redo.
- [ ] File explorer integration: pages appear as `.page` items; double-click opens.
- [ ] Page hierarchy: parent pages, breadcrumbs, sidebar tree.
- [ ] Search: pages by title.
- [ ] Image / file upload via attachments.
- [ ] On-disk JSON mirror.

Exit criteria: a user can write a long-form Notion-style page with all standard blocks and feel it is "a real editor".

### Phase 2 — Database MVP (3–4 weeks)

**Goal**: inline databases with the most useful property types and the table view.

- [ ] Database creation (slash → "/database").
- [ ] DatabaseInlineNode + DatabaseInlineBlock React component.
- [ ] Properties: text, number, checkbox, select, multi_select, date, url.
- [ ] Inline cell editing.
- [ ] Add / remove / rename / reorder properties.
- [ ] Add / delete rows.
- [ ] Table view with column resize, reorder, freeze.
- [ ] Filter DSL + UI (one filter group: AND).
- [ ] Sort UI (single + multi-key).
- [ ] Hidden properties.
- [ ] Pagination / virtual scroll (>1000 rows).

Exit criteria: a user can `slash → database`, build a simple tracker (e.g. "tasks" with text, status select, date), filter by status, sort by date.

### Phase 3 — Multiple views + linked databases (3 weeks)

**Goal**: Notion-feature parity on view system.

- [ ] Board view (group_by select / multi_select).
- [ ] List view.
- [ ] Gallery view (with image cover).
- [ ] Calendar view (month/week/day).
- [ ] Timeline view.
- [ ] Multiple views per database, view tabs UI.
- [ ] OR filter groups.
- [ ] DatabaseLinkedNode (`database_linked` block).
- [ ] "Open as full page" — every database has a dedicated route showing the database surface.

Exit criteria: a user can switch views on a tracker, drag rows between board columns, link the same database from another page with a different filter.

### Phase 4 — Query-backed blocks + `.dashboard` migration (2 weeks)

**Goal**: legacy parity. After this phase, `.dashboard` is gone.

- [ ] `kpi`, `chart`, `sql_table` blocks.
- [ ] One-shot migrator (§12).
- [ ] Module install hook integration.
- [ ] Storybook visual diff harness for migrated pages.
- [ ] Deprecate `.dashboard` write path; agents that try get an error pointing at the new tools.

Exit criteria: every existing `.dashboard` file in the showcase workspace renders as a page with no visual regressions.

### Phase 5 — Row pages + relations + rollups (3 weeks)

- [ ] Row pages (open row → full page editor).
- [ ] Relation property + property picker.
- [ ] Two-way relations.
- [ ] Rollup property + inline picker.
- [ ] Rollup cache invalidation.
- [ ] Search includes row content (FTS5).

Exit criteria: a user can build a "projects + tasks" two-database setup with a relation and a rollup that shows the count of open tasks per project.

### Phase 6 — Formula + advanced properties (2 weeks)

- [ ] Formula DSL + evaluator (§5.6).
- [ ] Formula cache invalidation graph.
- [ ] `created_time`, `created_by`, `last_edited_time`, `last_edited_by` (the last two are no-ops while single-user).
- [ ] `person` property scaffold (kept dormant until collab phase).
- [ ] `file` property type.

### Phase 7 — Collaboration (4–6 weeks, deferred)

- [ ] Wrap blocks/rows in Y.Map. Map every op to a Y.Doc transaction.
- [ ] Provider integration (decision deferred — partykit / liveblocks / self-host with WebSocket).
- [ ] Presence (cursors, selection, who's editing).
- [ ] Awareness (typing indicators).
- [ ] Conflict UX for property type changes.
- [ ] Offline mode: local-only ops queue → sync on reconnect.
- [ ] Backfill: existing pages get a Y.Doc snapshot built from their SQLite state on first multi-user open.

This phase is deliberately not scheduled here. The data model and op shape are designed so Phase 7 is additive, not a rewrite.

---

## 15. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Tiptap transaction → op translation has subtle bugs (lost edits) | High initially | High | Property-based test (random op sequences → fuzz; assert SQLite ↔ Tiptap JSON round-trip equivalence). Explicit op types per ProseMirror Step kind. |
| Database query perf degrades past 100k rows | Medium | Medium | Indexed json_extract; documented limit; fallback to typed shadow column on hot properties (per-DB internal, opaque to users). |
| Type migration loses data | Medium | High | Journal preserves original; UI confirmation dialog lists impact ("12 rows will become null"). |
| File-system mirror diverges from SQLite | Medium | Low | Mirror is debounced and idempotent; runtime treats SQLite as truth, never reads the mirror back during writes. Periodic reconciler (every 5 min) detects drift and rewrites. |
| Migration of existing `.dashboard` produces wrong layouts | Medium | Low | Visual-diff harness in Phase 4. Deprecation window — keep originals in `dashboards.archive/` for two releases. |
| Tiptap performance fails R3 at 5000 blocks | Medium | High | Phase 0 specifically validates this; fallback toolkit listed inline (virtualisation, transaction throttling, schema slimming). Last-resort fallback is Lexical; the data model and API survive the swap unchanged. |
| Tiptap maintainer pivots toward paid Pro features | Low | Medium | We avoid all `@tiptap/pro/*` packages. Even if Pro-only extensions multiply, OSS core is healthy — ProseMirror itself is independent and 10+ years stable underneath. |
| Yjs migration in Phase 7 is harder than expected | Low | High | Op shape is the seam; CRDT migration constraints (§10.3, §10.2, §10.1) are enforced from Phase 0. Property-based tests run for both local-store and Yjs backends in Phase 7. |
| Module apps can't migrate their `.dashboard` files in time | Medium | Medium | Phase 4 migrator runs on app install; modules can ship JSON exports going forward. Compat shim through Phase 5 if needed. |
| Agents flood the runtime with tool calls | Low | Low | Per-session quota added if observed. Tool schemas are tight (small inputs, paginated outputs). |
| Single-DB SQLite contention under heavy editing | Low | Medium | WAL mode, single-writer pattern, batched ops. If observed, split journal to its own file. |

---

## 16. Open questions

These are decisions that block specific phases but not the overall design. Surface and resolve before the relevant phase starts.

1. **Sidebar / page tree UX** — does the desktop app's sidebar host the page tree, or does it stay in the file explorer surface? *(Resolve before Phase 1.)*
2. **Workspace-scoped or sandbox-scoped page tree?** Confirmed sandbox-scoped (per-workspace, per-user) above; revisit only if a multi-workspace shared page surface becomes a product requirement.
3. **Cover image source** — only attachments and external URLs in v1, or also Unsplash integration? *(Resolve before Phase 1.)*
4. **Search scope** — does cross-page search index module data (twitter_posts content)? Probably no in v1 (keeps the index small and avoids exposing content the user might consider "system" data). *(Resolve before Phase 5.)*
5. **Agent author identity** — `journal.actor = "agent:<name>"`. How are agent names assigned? Suggest using the agent's session_id / agent_run_id from the existing harness. *(Resolve before Phase 1.)*
6. **Templates** — out of v1, but where do they live (page-tree / a special folder / a marketplace)? *(Plan in v2.)*
7. **Exports** — Markdown / PDF / CSV. Out of v1. CSV from a database view makes sense in Phase 3+; defer.
8. **Tiptap version pin** — Tiptap v3 is stable. We pin `@tiptap/core@^3.x` per phase and bump deliberately at phase boundaries. *(Set the pin in Phase 0.)*

---

## 17. Appendix A — Concrete payload examples

### 17.1 Create a page with an inline database

```jsonc
// 1. Create the page
POST /api/v1/workspaces/W/pages
{ "title": "Tasks" }
→ { "page_id": "page_01HX..." }

// 2. Add a database_inline block
POST /api/v1/workspaces/W/pages/page_01HX/blocks
{
  "position": "a0",
  "type": "database_inline",
  "content": { "database_id": null }   // runtime fills after databases.create
}

// 3. Create the database, owned by that block
POST /api/v1/workspaces/W/databases
{
  "owner_page_id": "page_01HX...",
  "owner_block_id": "block_01HX...",
  "name": "Tasks",
  "properties": [
    { "name": "Title",  "type": "text", "position": "a0" },
    { "name": "Status", "type": "select", "position": "a1",
      "config": { "options": [
        { "id": "opt_01", "name": "todo",     "color": "gray",   "position": "a0" },
        { "id": "opt_02", "name": "doing",    "color": "blue",   "position": "a1" },
        { "id": "opt_03", "name": "done",     "color": "green",  "position": "a2" }
      ] } },
    { "name": "Due", "type": "date", "position": "a2" }
  ],
  "initial_view": {
    "type": "table",
    "name": "All",
    "config": {
      "frozen_property_ids": [],
      "property_widths": {},
      "wrap": false,
      "filter": null,
      "sort": [],
      "hidden_property_ids": []
    }
  }
}
→ { "database_id": "db_01HX...", "default_view_id": "view_01HX..." }
```

### 17.2 Add a row

```jsonc
POST /api/v1/workspaces/W/databases/db_01HX/rows
{
  "values": {
    "Title":  { "rich_text": [{ "type": "text", "text": "Ship pages MVP" }] },
    "Status": { "option_id": "opt_02" },
    "Due":    { "start": "2026-05-20", "include_time": false }
  }
}
→ { "row_id": "row_01HX...", "page_id": "page_01HX..." }
```

### 17.3 Filter+sort query

```jsonc
POST /api/v1/workspaces/W/databases/db_01HX/rows:query
{
  "filter": {
    "kind": "and",
    "filters": [
      { "kind": "leaf", "property_id": "prop_status",
        "condition": { "op": "is_not", "value": "opt_03" } },
      { "kind": "leaf", "property_id": "prop_due",
        "condition": { "op": "date_within", "preset": "this_week" } }
    ]
  },
  "sort": [{ "property_id": "prop_due", "direction": "asc" }],
  "limit": 50
}
→ {
    "rows": [...],
    "total": 7,
    "next_cursor": null
  }
```

### 17.4 Agent: append a heading and a database

```jsonc
// Agent tool call
{
  "name": "blocks.append",
  "arguments": {
    "page_id": "page_01HX...",
    "blocks": [
      { "type": "heading_2", "content": { "rich_text": [
          { "type": "text", "text": "This week's tasks" }
        ] } },
      { "type": "database_inline",
        "content": { "database_id": "db_01HX..." } }
    ]
  }
}
```

---

## 18. Appendix B — Initial SQLite seed

```sql
-- Inserted on first runtime start for each workspace.
INSERT INTO meta(key, value) VALUES
  ('schema_version', '1'),
  ('created_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- A "Welcome" page seeded so the user lands on something.
INSERT INTO pages(id, parent_page_id, title, created_at, updated_at)
VALUES (
  'page_welcome', NULL, 'Welcome',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
INSERT INTO blocks(id, page_id, parent_block_id, position, type, content_json, created_at, updated_at)
VALUES (
  'block_welcome_p1', 'page_welcome', NULL, 'a0', 'paragraph',
  '{"rich_text":[{"type":"text","text":"Welcome to your workspace."}]}',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
```

---

## 19. Appendix C — File-system layout after migration

```
workspace/<id>/
├── workspace.json           — workspace metadata (existing)
├── workspace.yaml           — runtime config (existing)
├── apps/                    — module apps (existing, unchanged)
├── pages/                   — NEW: page JSON mirror, one file per page
│   ├── page_01HX....page.json
│   └── page_01HY....page.json
├── databases/               — NEW: database JSON mirror
│   └── db_01HX....database.json
├── attachments/             — NEW: image/file uploads
│   ├── 01HX....png
│   └── 01HY....pdf
└── dashboards.archive/      — NEW (post-Phase-4): legacy .dashboard files
    └── charts-showcase.dashboard
```

State (SQLite) lives at `state/pages.db` (new) alongside existing `state/runtime.db` and `state/data.db`.

---

## 20. Appendix D — Testing strategy

| Layer | Tests |
|---|---|
| Block JSON schema | Zod parse round-trip; reject malformed payloads with detailed error path. |
| Op + inverse | Property-based: random op sequences → apply → apply inverses in reverse → state equal initial. |
| SQLite persistence | Integration: every API endpoint exercised; assert on resulting tables. |
| Editor (Tiptap) | Component tests with `@tiptap/react`'s test helpers + ProseMirror's test runner: type, slash command, drag-reorder; verify generated ops match expectation. |
| Filter DSL → SQL | Snapshot tests over a fixture grid of (filter, expected SQL). |
| Migrator | Each `.dashboard` fixture → page → screenshot diff against legacy renderer. |
| Type migration | Matrix test: every (from, to) pair exercised on a fixture row. |
| End-to-end | Playwright: open new page → type → add database → add row → reload → assert content. |
| Performance | Bench: 10k-row database table view scroll; cell edit latency p95 < 100ms; page open p95 < 200ms. |

CI: tests run on every PR. The fuzz suite runs nightly with a fixed seed; regressions block release.

---

## 21. Appendix E — Glossary mapping (old → new)

| Old (`.dashboard`) | New (page + block) |
|---|---|
| `.dashboard` file | `.page.json` mirror; primary representation is in SQLite |
| `panel` | `block` |
| `panel.type = kpi` | `block.type = kpi` (query-backed) |
| `panel.type = chart` | `block.type = chart` (query-backed) |
| `panel.type = data_view` | `block.type = sql_table` (query-backed) OR `database_inline` (native) |
| `panel.type = text` | rich-text blocks (paragraph / heading / list / ...) |
| `panel.type = stat_grid` | `column_list` of `kpi` blocks |
| `panel.width = full/half/third` | `column_list` with `column.ratio` |
| `views` inside `data_view` | `views` table on database (or `sql_table.views` for query-backed) |
| `query` (SQL) | `query` field on query-backed blocks; replaced by structured filter for native databases |
| `default_view` | `default_view_id` |
| `colors` map | property-level select option color, or table column color config |

---

---

## 22. Appendix F — Editor framework research (2026-05-06)

Recorded so the editor decision is auditable; do not edit unless re-running the research.

### 22.0 Decision history

| Date | Decision | Reason |
|---|---|---|
| 2026-05-06 (am) | **Lexical** | Architectural fit: clean node model, `@lexical/yjs` for collab, NodeState for typed block JSON, performance scaling. |
| 2026-05-06 (pm) | **Reversed → Tiptap (DIY, no Pro)** | OSS production-footprint asymmetry: Tiptap has named blue-chip OSS users (LinkedIn, GitLab, Anthropic, Twenty CRM, CopilotKit, Hyprnote, Hyperion) plus 10+ years of ProseMirror battle-testing under Atlassian / NYT / Outline. Lexical's named OSS-product adoption is essentially Meta-internal (closed) + Payload CMS + a long tail of <100★ demos. The architectural-fit advantage doesn't outweigh the community / longevity risk for a small team. The user's clarification (a) — "the wrapper is at fault, not Tiptap-the-framework" — removes the previous coupling concern as long as we don't import `@holaboss/editor`. |

### 22.1 Candidates evaluated

| Framework | Underlying | Status | License |
|---|---|---|---|
| Lexical | Custom (Meta) | v0.44.x, pre-1.0 since 2022 | MIT |
| Tiptap (DIY, no Pro) | ProseMirror | v3, stable | MIT |
| BlockNote | Tiptap → ProseMirror | v0.x, active | MPL-2.0 |
| Plate | Slate | active | MIT |
| BlockSuite (AFFiNE) | Custom (Yjs-native) | active, tied to AFFiNE | MIT |

### 22.2 Eliminated

- **BlockNote**: custom blocks cannot nest (TypeCellOS/BlockNote#1540, open). Our `database_inline` must live inside `column_list` / `toggle` / `callout`. Custom blocks render in a separate React root, breaking Context. At least one team migrated off citing "rigid schema structure".
- **Plate (Slate)**: Slate's collaboration story is the weakest of the four; persistent slate / slate-react / slate-dom dependency conflicts in 2025; Slate normalisation perf issues require chunking workarounds.
- **BlockSuite**: AFFiNE-coupled, framework abstraction comparable to ProseMirror — would re-do the work AFFiNE's team did. Not realistic for our headcount.

### 22.3 Lexical vs Tiptap final comparison (post-reversal)

| Dimension | Lexical | Tiptap (DIY) | Notes |
|---|---|---|---|
| Named OSS production users | 🟡 Meta-internal (closed) + Payload CMS + long tail <100★ | ✅ LinkedIn, GitLab, Anthropic, Twenty CRM, CopilotKit, Hyprnote, Hyperion, AppSmith… | **The deciding factor.** |
| Underlying-engine track record | 🟡 5 yrs (Lexical, 2021) | ✅ 10+ yrs (ProseMirror, 2015) at Atlassian / NYT / Outline scale | ProseMirror is a fundamentally older, more battle-tested core. |
| Agent block-JSON authoring | ✅ NodeState + import/exportJSON | ✅ Tiptap JSON `{ type, attrs, content }` is also clean | Both are tractable. Tiptap's schema-bound JSON is widely documented. |
| Yjs collab integration | ✅ `@lexical/yjs` | ✅ `y-prosemirror` (older, more production cases) | y-prosemirror has more known-good deployments. |
| Database React island | ✅ DecoratorNode | ✅ `ReactNodeViewRenderer` on `atom: true` node | Both work. NodeView pattern has more public examples (BlockNote source). |
| Large-document perf | ✅ Immutable reconciler | 🟡 Issues #4491, #3340 (1500+ nodes ⇒ slow) | **Real Tiptap risk.** Phase 0 R3 specifically validates; fallback toolkit listed in §14 Phase 0. |
| Time-to-Notion-feel | 🟡 Build everything ourselves; few public references | ✅ DIY from Novel + BlockNote source as code references | Tiptap reference material is much denser. |
| API stability | 🟡 v0.44.x, pre-1.0 since 2022 | ✅ v3 stable | |
| Ecosystem / extensions | 🟡 LexKit, Luthor — both <1k★, both 2025 | ✅ ~50+ official + large community | |
| Coupling with `@holaboss/editor` | None (different family) | Same family but **different wrapper** | User clarified (a): framework fine, wrapper not. We do not import the wrapper's source. |
| Stack Overflow / GitHub answer density | 🟡 Thinner — fewer questions, slower issue close | ✅ Much denser | Material when stuck. |

### 22.4 Why we reversed

The original Lexical pick was made on architectural fit. The reversal is on **production-evidence weight**.

Architectural fit advantages of Lexical (clean DecoratorNode, NodeState, immutable reconciler) are real but **theoretical for our scale**. We are a small team building a new product on a young framework — what matters most is:

1. **When stuck, can we find an answer fast?** Tiptap wins by 10×.
2. **When the maintainer makes a tough trade-off, is our use case represented?** Tiptap's commercial OSS-native maintainership (ueberdosis) cares about a broad customer base. Lexical's maintainer (Meta) prioritises FB/IG/WhatsApp internals. Our needs are not on Meta's roadmap.
3. **If the framework dies tomorrow, who picks it up?** ProseMirror has a decade of independent contributors. Lexical's core contributors are concentrated at Meta.

Tiptap's two real downsides:
- **Performance past 1500 nodes** — the only material risk. Phase 0 R3 measures it on our actual block shape; we have a fallback toolkit (virtualisation + transaction throttling + schema slimming) before Lexical re-evaluation becomes the answer.
- **Pro-tier creep** — Tiptap monetises advanced templates / extensions. We commit explicitly to OSS core only and DIY everything Pro covers.

Both are manageable. The OSS-adoption asymmetry is harder to fix.

### 22.5 Sources consulted

Round 1 (architectural-fit comparison, led to Lexical pick):
- Liveblocks, "Which rich text editor framework should you choose in 2025?" — comparison + Lexical Yjs root-node note.
- PkgPulse, "Tiptap vs Lexical vs Slate vs Quill 2026".
- BuildPilot, "Tiptap vs Lexical vs Plate 2026".
- Velt, "Best Rich Text Editors in 2026".
- facebook/lexical Releases (v0.44.0, 2026), Wiki Roadmap, Discussion #5011.
- Lexical Collaboration FAQ, Discussion #3161 (decorator selection), Issue #6613 (custom node children).
- ueberdosis/tiptap Issue #4491 (large content slow), Issue #3340 (incremental input slow), Discussion #4746 (Notion-style impl).
- TypeCellOS/BlockNote Issue #1540 (custom blocks cannot nest), Issue #1360 (decorator request).
- udecode/plate Issue #4599 (Slate version conflict), Plate Troubleshooting docs.
- toeverything/blocksuite (AFFiNE editor framework) — architecture docs.
- DEV.to "Why I chose Lexical over Tiptap" (codeideal).
- steven-tey/novel — DIY Tiptap Notion-style reference.
- Tiptap pricing page (Pro Notion-like template = Start plan ≥ $149/mo).

Round 2 (OSS adoption audit, led to reversal):
- Tiptap "open-source-to-platform" page — named OSS production users.
- openalternative.co/stacks/tiptap — 10+ OSS apps using Tiptap (Twenty CRM, CopilotKit, Hyprnote, Hyperion, AppSmith, Whop, ...).
- gitnux Lexical statistics 2026 — adoption breakdown ("1234 companies via npm trends"; named OSS = Payload CMS + Vercel templates + 4 unspecified enterprise SaaS).
- npm `@payloadcms/richtext-lexical` — confirmed Payload's official Lexical adapter (v3.84.0, 2026).
- GitHub topic `lexical-editor` — long tail inspection: highest-starred non-official repos under 200★, most are demos.
- Eddyter "Most Popular WYSIWYG Editor 2026" — share-of-downloads.

End of research record.

---

End of v1 design.
