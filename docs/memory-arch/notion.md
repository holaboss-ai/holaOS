# Notion Memory Architecture

## What exists today

Notion integration memory is implemented as one global integration tree per connected Notion account. The tree is keyed by `provider + owner_user_id + account_key`.

Unlike Gmail and GitHub, the current Notion fetch path does not resolve a fresher upstream identity from the provider response. It uses the connection identity already stored on the integration connection, choosing:

1. `accountHandle`
2. `accountEmail`
3. `accountExternalId`
4. `connectionId`

The semantic tree is stored under the global memory root:

```text
memory/semantic/integration/trees/<tree-slug>/
```

Leaf evidence files are still persisted separately under:

```text
memory/integration/trees/<tree-slug>/
```

It becomes visible to a workspace through the shared active-connection and workspace-override visibility rules.

## Fetch entrypoints

The Notion memory path is started by the shared integration fetch machinery:

1. connection activation
2. `POST /api/v1/integrations/context-fetch`
3. scheduled autofetch when the connection is active and due

Fetch status is tracked by `integration-context-fetch-manager.ts` and surfaced through `GET /api/v1/integrations/context-fetch`.

## Ingestion pipeline

The current Notion fetch is a search-window snapshot, not a full workspace export:

1. Call `NOTION_SEARCH_NOTION_PAGE` with:
   - empty query
   - `fetch_type = all`
   - `page_size = 30`
2. Split the results into pages and databases.
3. Persist one workspace snapshot leaf with page and database counts.
4. For each discovered page:
   - persist a page overview leaf
   - try `NOTION_GET_PAGE_MARKDOWN`
   - persist a page content leaf when markdown is available
5. For each discovered database:
   - call `NOTION_FETCH_DATABASE`
   - persist a database overview leaf
   - call `NOTION_QUERY_DATABASE` with `page_size = 15`
   - persist one row leaf per returned row
6. Retire page entities and database entities that are no longer in the latest search result set.
7. Rebuild the semantic integration tree.

As with the other provider fetch paths, the live Notion fetch rebuilds with no embedding model, so the immediate result is deterministic semantic-node summaries plus semantic containment.

## Leaf model

### Workspace snapshot leaf

- `subject_key`: `workspace_snapshot`
- `branch_key`: `workspace`
- `branch_label`: `Workspace`
- `source_type`: `notion.workspace`
- `external_object_type`: `notion_workspace`

This is the account-level anchor leaf for the current search window.

### Page overview leaf

- `subject_key`: `page:<page-id>`
- `entity_key`: `page:<page-id>`
- `branch_key`: `overview`
- `branch_label`: `Overview`
- `source_type`: `notion.page`

### Page markdown leaf

- `subject_key`: `page_markdown:<page-id>`
- `entity_key`: `page:<page-id>`
- `branch_key`: `content`
- `branch_label`: `Content`
- `source_type`: `notion.page_markdown`

The markdown body is clipped before persistence and stored as a content snapshot.

### Database overview leaf

- `subject_key`: `database:<database-id>`
- `entity_key`: `database:<database-id>`
- `branch_key`: `overview`
- `branch_label`: `Overview`
- `source_type`: `notion.database`

This stores database metadata plus the first set of property labels.

### Database row leaf

- `subject_key`: `row:<database-id>:<row-id>`
- `entity_key`: `database:<database-id>`
- `branch_key`: `rows`
- `branch_label`: `Rows`
- `source_type`: `notion.database_row`

Each row leaf stores up to twelve normalized property lines.

## Logical tree shape

The logical shape for one Notion account looks like this:

```text
<notion connection>
- Workspace
  - Overview
    - Notion workspace for <account>
  - Pages
    - <page title>
      - Overview
        - <page title>
      - Content
        - <page title> content
  - Databases
    - <database title>
      - Overview
        - <database title>
      - Rows
        - <database title>: <row title>
```

In the current semantic tree, pages and databases are explicit children under a workspace node, and row leaves remain attached under their database node.

## Persistence and reconciliation behavior

The shared integration-memory layer still provides duplicate detection and supersession:

- exact fingerprint duplicate: no new leaf
- same `subject_key` with changed content: new leaf supersedes the previous active one
- leaf bodies are persisted as markdown evidence files
- semantic nodes, containment edges, and semantic relations are rebuilt after the fetch

Notion adds partial entity reconciliation:

- active `page:*` entities not in the current search results are retired
- active `database:*` entities not in the current search results are retired

One important nuance: row leaves are not reconciled independently. A row leaf stays active as long as its parent database entity remains active, even if that row falls out of the latest `NOTION_QUERY_DATABASE` top-15 result window.

## Retrieval and visibility

After rebuild, Notion memory is exposed through:

- the visible integration-tree set for a workspace
- Memory browser tree and graph
- `semantic_memory_nodes`, `semantic_memory_edges`, and `semantic_memory_relations`
- `memory_retrieve` through the combined workspace memory retrieval layer

Like Gmail and GitHub, initial retrieval is lexical/structural because the live fetch path does not write embeddings.

## Current limits and gaps

- search window: max 30 combined pages + databases from `NOTION_SEARCH_NOTION_PAGE`
- row window: max 15 rows per discovered database
- page markdown is best-effort; missing page markdown does not fail the fetch
- row reconciliation is incomplete because rows are not retired individually
- this is a search snapshot, not an incremental sync with a saved cursor or pagination across the whole workspace
- the fetch path does not currently backfill a stronger account identity from Notion itself

## Key source files

- `runtime/api-server/src/integration-context-fetch.ts`
- `runtime/api-server/src/integration-memory.ts`
- `runtime/api-server/src/integration-context-fetch-manager.ts`
- `runtime/api-server/src/integration-context-autofetch-worker.ts`
- `runtime/api-server/src/workspace-integration-visibility.ts`
- `runtime/state-store/src/store.ts`
