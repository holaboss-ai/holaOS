---
title: Memory architecture redesign implementation plan
date: 2026-05-24
status: draft
related:
  - 2026-05-24-memory-architecture-redesign-note.md
  - 2026-05-20-memory-redesign-prd.md
  - ../memory-arch/gmail.md
  - ../memory-arch/github.md
  - ../memory-arch/notion.md
---

# Memory architecture redesign implementation plan

## Goal

Implement the semantic-node memory architecture described in `2026-05-24-memory-architecture-redesign-note.md` without a risky big-bang rewrite.

The target outcome is:

- canonical memory trees are semantic
- summaries live on semantic nodes instead of being separate node types
- integration trees keep fixed provider-defined layers
- interaction trees can add partition/materialization only when fanout requires it

## Rollout strategy

Use a strangler migration rather than replacing the whole memory stack in one pass.

The practical rules should be:

- keep current tree ownership boundaries
- treat existing leaves as the durable source of truth
- rebuild new semantic-node structure from trees plus leaves rather than migrating summary nodes directly
- dual-write or dual-read where needed until retrieval and browser parity is proven
- delete legacy `entity` / `branch` / summary-tree machinery only after both interaction and integration paths run on the new substrate

The important constraint is that this redesign should change the canonical structure first, not leaf admission, provider fetch coverage, or retrieval product scope.

The retrieval boundary should also be kept separate from storage shape:

- the semantic tree is the durable substrate
- the primary agent retrieval contract should be reasoning-first
- explicit tree navigation, if still needed, should remain a separate browse concern rather than shaping `memory_retrieve`

## Scope

This plan covers:

- state-store schema changes for the new semantic-node model
- runtime materialization changes for interaction and integration memory
- retrieval and memory-browser migration to the new model
- staged deprecation of current summary-node and `entityKey` / `branchKey` assumptions

This plan does not try to:

- redesign interaction leaf extraction
- expand provider fetch coverage beyond current Gmail, GitHub, and Notion paths
- finalize a richer cross-tree graph product beyond the current relation-edge model

## Recommended implementation shape

### Keep current ownership tables initially

Do not start by collapsing all current tree and leaf tables into one giant generic memory schema.

First pass should keep:

- interaction tree ownership as it is now
- integration tree ownership as it is now
- current durable leaf records as the source-backed evidence layer

The first structural migration should focus on the internal node layer.

### Add one shared semantic-node layer

Introduce one shared canonical node model for both categories.

The first-pass shared node table should represent:

- semantic internal nodes
- source leaves as children in the same containment graph

Each non-leaf node should carry:

- title
- summary
- metadata
- explicit parent reference
- ordering metadata
- optional materialization flags

This gives us one canonical containment graph instead of the current split between:

- category-specific canonical tree projections
- separate summary-child trees

### Rebuild summaries, do not migrate them

Old summary nodes should not be migrated as first-class objects.

They are derived artifacts. When a tree is rebuilt under the new model:

- keep the existing leaves
- recreate semantic internal nodes
- recompute summary text onto those semantic nodes

That keeps the migration simpler and avoids preserving the current conceptual split in the new schema.

## Phase 0: Lock the contract

Files:

- `docs/plans/2026-05-24-memory-architecture-redesign-note.md`
- `docs/plans/2026-05-24-memory-architecture-redesign-implementation-plan.md`
- `docs/implementation_notes/memory-structure-implementation-notes.html`

Work:

- explicitly record that the new canonical model is `tree -> semantic node -> leaf`
- record that `summary` is now a property of a semantic node, not a node kind
- record that partition/materialization nodes are optional optimization artifacts
- lock the migration rule that summaries are rebuilt from leaves rather than migrated
- record that parentage is database-native and should no longer depend on path inference
- record that the semantic tree model serves a reasoning-first retrieval contract rather than a browse-shaped tool contract
- record the split between:
  - `memory_retrieve` for reasoning and context resolution
  - `memory_browse` for explicit tree navigation, inspection, or UI needs

Exit criteria:

- product and backend agree on the canonical model
- product and backend agree that storage shape and retrieval contract are intentionally decoupled
- the note and implementation plan are sufficient for schema work to begin

## Phase 1: Add the shared semantic-node substrate

Files:

- `runtime/state-store/src/store.ts`
- `runtime/state-store/src/migrations.ts`
- `runtime/state-store/src/store.test.ts`
- `runtime/state-store/src/migrations.test.ts`

Work:

- add shared durable tables for the new canonical node layer
- add explicit parent-child edges keyed by node id rather than path shape
- add fields for:
  - `tree_id`
  - `node_id`
  - `parent_node_id`
  - `node_kind`
  - `title`
  - `summary`
  - `metadata`
  - `position`
  - `observed_at`
  - `updated_at`
  - `is_materialized`
- add support for leaves participating in the same containment graph as semantic nodes
- add helper APIs to:
  - upsert canonical semantic nodes
  - replace node containment edges
  - list children by parent
  - read nodes by tree, path, or id

Recommendation:

- keep existing `interaction_*` and `integration_*` leaf tables in this phase
- do not try to unify leaf storage yet

Exit criteria:

- the state store can persist one generic semantic-node containment graph
- no runtime read path depends on it yet

## Phase 2: Add shared runtime builders and adapters

Files:

- `runtime/api-server/src/interaction-memory.ts`
- `runtime/api-server/src/integration-memory.ts`
- `runtime/api-server/src/memory.ts`
- `runtime/api-server/src/workspace-memory.ts`
- `runtime/api-server/src/memory-recall.ts`
- `runtime/api-server/src/memory-browser.ts`

Recommended new helper module:

- `runtime/api-server/src/memory-tree-model.ts`

Work:

- introduce one shared runtime representation for:
  - semantic internal nodes
  - leaves
  - relations
- centralize markdown-body generation for internal semantic nodes
- centralize summary refresh logic so parent summaries are computed from immediate children
- add adapters that can project current interaction/integration trees into the new shared structure
- keep the old runtime output available until browser and retrieval can be switched safely

Important constraint:

- this phase should remove `entity` and `branch` from the shared runtime vocabulary
- provider and interaction-specific code can still use those concepts internally during migration, but the shared model should only speak in semantic nodes and leaves

Exit criteria:

- runtime code can build the new semantic-node graph from existing tree and leaf sources
- old and new structures can coexist in one process

## Phase 3: Move read paths to the new model

Files:

- `runtime/api-server/src/memory-browser.ts`
- `runtime/api-server/src/memory-recall.ts`
- `runtime/api-server/src/memory-recall-index.ts`
- `runtime/api-server/src/memory-embedding-index.ts`
- `runtime/api-server/src/workspace-memory.ts`
- `runtime/api-server/src/runtime-agent-tools.ts`
- `runtime/api-server/src/app.ts`
- `runtime/api-server/src/memory.test.ts`
- `runtime/api-server/src/memory-recall.test.ts`

Work:

- make the memory browser render generic semantic nodes instead of category-specific `entity` / `branch` assumptions
- make retrieval rank semantic node summaries directly
- make drill-down traversal follow explicit parent-child containment
- keep leaves as the final evidence layer
- stop requiring a separate summary-node tree for recall planning

Recommended rollout:

- dual-read behind a runtime flag first
- compare retrieval and browser outputs between old and new models
- switch default reads only after parity on existing fixtures and live trees

Exit criteria:

- the browser and `memory_retrieve` can read from the new canonical model
- the old summary-tree read path is no longer required for user-facing retrieval

## Phase 4: Migrate interaction writeback

Files:

- `runtime/api-server/src/turn-memory-writeback.ts`
- `runtime/api-server/src/memory-writeback-extractor.ts`
- `runtime/api-server/src/interaction-memory.ts`
- `runtime/api-server/src/interaction-memory.test.ts`
- `runtime/api-server/src/turn-memory-writeback.test.ts`

Work:

- keep current interaction owner assignment and durable leaf admission logic
- replace interaction summary-node materialization with semantic parent-node summary refresh
- initially keep interaction tree shape shallow unless there is a clear semantic grouping worth introducing
- when fanout grows too large, allow optional partition/materialization nodes such as:
  - `recent`
  - `historical`
  - `slice 1`
  - `slice 2`

Important constraint:

- those partition nodes should be marked as materialized optimization nodes
- they should not become the conceptual meaning of the interaction tree

Recommendation:

- do not overdesign interaction substructure in the first cut
- start with tree-level semantic grouping plus optional fanout partitions only when thresholds require it

Exit criteria:

- interaction writeback produces the new canonical semantic-node graph directly
- interaction retrieval no longer depends on summary-node tables

## Phase 5: Migrate integration materialization provider by provider

Files:

- `runtime/api-server/src/integration-context-fetch.ts`
- `runtime/api-server/src/integration-memory.ts`
- `runtime/api-server/src/integration-context-fetch.test.ts`
- `runtime/api-server/src/integration-memory.test.ts`

Work:

- stop treating `entityKey` and `branchKey` as the canonical structure
- use provider-specific semantic hierarchies to build the canonical graph
- keep one tree per connection

### GitHub

Target shape:

```text
github connection
- repo
  - overview
    - leaf
  - readme
    - leaf
  - issues
    - leaf
  - pull requests
    - leaf
  - notifications
    - leaf
```

### Notion

Target shape:

```text
notion connection
- workspace
  - pages
    - page
      - overview
        - leaf
      - content
        - leaf
  - databases
    - database
      - overview
        - leaf
      - rows
        - leaf
```

This phase should explicitly fix the current missing `workspace -> pages/databases` containment.

### Gmail

Before migrating Gmail, lock the fixed semantic hierarchy the product wants.

One likely direction is:

```text
gmail connection
- mailbox
  - profile
    - leaf
  - threads
    - thread
      - messages
        - leaf
```

But the hierarchy should be approved before code lands, because Gmail currently has the weakest fixed-shape definition of the three providers.

Exit criteria:

- GitHub, Notion, and Gmail all materialize provider-shaped semantic trees
- integration retrieval and browser views no longer depend on `entityKey` / `branchKey` for structure

## Phase 6: Remove legacy summary-tree and hardcoded entity/branch machinery

Files:

- `runtime/state-store/src/store.ts`
- `runtime/state-store/src/migrations.ts`
- `runtime/api-server/src/interaction-memory.ts`
- `runtime/api-server/src/integration-memory.ts`
- `runtime/api-server/src/memory-browser.ts`
- `runtime/api-server/src/memory-recall.ts`
- `docs/implementation_notes/memory-structure-implementation-notes.html`

Work:

- stop writing legacy summary-node tables
- stop rebuilding category-specific canonical node projections that only exist to mirror `entity` / `branch` grouping
- remove path-derived canonical parent inference from runtime materialization
- remove now-dead summary-tree read helpers and tests
- update documentation to describe only the new model

Exit criteria:

- one canonical semantic-node graph remains
- summary nodes are no longer part of the durable ontology
- `entity` and `branch` are no longer required in shared memory code

## Validation

At minimum, validate each migration stage with:

- `bun --filter=@holaboss/runtime-state-store run typecheck`
- `bun --filter=@holaboss/runtime-api-server run typecheck`
- `cd runtime/state-store && ./node_modules/.bin/tsx --test --test-force-exit src/store.test.ts src/migrations.test.ts`
- `cd runtime/api-server && ./node_modules/.bin/tsx --test --test-force-exit src/interaction-memory.test.ts src/integration-memory.test.ts src/integration-context-fetch.test.ts src/memory-recall.test.ts src/memory.test.ts src/turn-memory-writeback.test.ts`

Also run live parity checks in the Memory browser for:

- one interaction-heavy workspace
- one Gmail tree
- one GitHub tree
- one Notion tree

## Risks

- migrating browser and retrieval before provider shapes are stable could create churn in user-facing tree semantics
- trying to unify leaf storage too early would make this rewrite much riskier than necessary
- interaction tree structure can easily become overdesigned if semantic grouping and optimization grouping are not kept separate
- Gmail needs one explicit target hierarchy before implementation to avoid another weak abstraction layer

## Recommended order

If this is implemented incrementally, the best order is:

1. lock the contract and migration rules
2. add the shared semantic-node substrate
3. move browser and retrieval onto the new read model
4. migrate interaction writeback
5. migrate GitHub and Notion
6. migrate Gmail once its fixed hierarchy is approved
7. remove legacy summary-tree and `entity` / `branch` machinery

That order keeps the conceptual rewrite clear while still minimizing operational risk.
