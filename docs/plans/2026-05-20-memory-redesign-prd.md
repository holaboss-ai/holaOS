---
title: Memory redesign PRD
date: 2026-05-20
status: draft
related:
  - archive/2026-04-07-runtime-compaction-background-extraction-implementation-plan.md
---

# Memory redesign PRD

## Goal

Redesign holaOS durable memory around a tree-native backend with clear ownership, predictable retrieval, and no dependency on generated `MEMORY.md` indexes.

The new memory structure should:

- make durable memory a first-class backend instead of a file-path abstraction
- organize durable memory under explicit ownership categories
- keep every durable item in exactly one tree
- store all persisted node bodies as markdown
- separate durable memory from session continuity and scratchpad state

This document defines the target product and backend shape for durable memory. It does not define the final HTTP compatibility layer in detail.

## Product intent

The current memory model mixes several concerns:

- human-editable markdown files
- generated `MEMORY.md` indexes
- SQLite metadata tables
- prompt-oriented recall planning
- session continuity and scratchpad state stored nearby

That structure makes durable memory feel like adjacent mechanisms instead of one coherent system.

The redesigned system should feel like:

- one memory root
- explicit tree categories
- strict tree ownership for every durable item
- one retrieval layer that can search across categories without sharing leaves
- clear separation between durable memory and runtime/session state

## Scope

This redesign applies to **durable memory only**.

In scope:

- durable source leaves
- durable summary nodes
- interaction trees
- durable retrieval
- durable writeback / ingestion
- durable memory indexing and background jobs

Phase 1 implementation scope:

- interaction memory only
- interaction entity assignment
- interaction tree construction
- interaction retrieval tool
- summary generation by seal thresholds only
- no hotness subsystem in phase 1

Out of scope:

- session scratchpad
- session checkpoints
- session resume context
- `AGENTS.md` beyond its role as workspace instructions
- final public HTTP wire contract for `/api/v1/memory/*`
- daily-digest trees in v1
- integration-tree implementation in phase 1

## Design principles

### 1. One memory root

The backend has one durable memory root.

Under that root, trees are grouped by ownership category:

`memory root -> tree category -> tree`

For v1:

- `interaction`
- `integration`

The `memory root` and `tree category` layers are organizational containers, not summary nodes.

### 2. Categories are ownership domains

Categories define where a durable item comes from and which family of trees owns it.

- `interaction` contains durable memory derived from user or agent interaction with the workspace
- `integration` contains durable memory fetched or synced from external systems

Categories are not alternate views over the same leaf. They are ownership domains.

### 3. Trees are strict ownership hierarchies

Each durable leaf belongs to exactly one tree.

Leaves are not shared across trees. If the same concept should be reachable across multiple categories, the retrieval layer merges results from multiple trees instead of duplicating or multi-homing the leaf.

### 4. Markdown remains the body format

Every persisted node body is stored as markdown on disk.

There are only two persisted node classes:

- source leaves
- summary nodes

Source leaves are bottom-level canonical memory documents and have no children.

Summary nodes are markdown documents derived from child nodes. A summary node may summarize:

- source leaves
- lower-level summary nodes

The database is the index, topology, retrieval, and job-control plane. It is not the primary long-form body store.

### 5. Date is metadata, not ownership

Every persisted node carries date or time metadata.

Date supports recency filters, time-scoped retrieval, and future recap features. Date does not define a separate tree family in v1.

### 6. Durable memory is not session memory

Durable memory stores knowledge worth reusing across runs.

Scratchpad, compaction artifacts, checkpoints, and session resume material remain separate runtime concerns and should not be modeled as durable tree leaves.

### 7. Retrieval should be tree-native

Retrieval should not depend on generated `MEMORY.md` files.

The runtime should retrieve through tree-aware database queries and then hydrate full markdown bodies from disk when needed.

## Core model

### Memory root and tree categories

The durable memory backend has one root container.

Under that root, trees are grouped into tree categories.

For v1 the categories are:

- `interaction`
- `integration`

Examples:

- `interaction/interaction:response-style`
- `interaction/interaction:project-alpha`
- `integration/gmail:account-primary`
- `integration/github:repo-holaos-oss`

This hierarchy is organizational and should be understood separately from the summary hierarchy inside a tree.

### Tree structure

Each tree is documented top-down as:

- root summary node
- intermediate summary nodes
- source leaves

So the internal structure of a tree is:

`root summary node -> intermediate summary nodes -> source leaves`

Every materialized tree has at most one `L1` root summary node at its top. Lower summary levels may have many nodes.

### Event, chunk, and leaf distinction

The backend should distinguish clearly between three different units:

- `event`
- `chunk`
- `source leaf`

An `event` is the raw incoming memory signal before durable normalization.

Examples:

- one user message
- one assistant turn
- one fetched integration record
- one imported document revision
- one periodic sync result item

An event is not yet part of the durable tree. It is the ingress unit.

A `chunk` is a normalized ingestion-stage unit derived from one event or from part of one event.

Examples:

- one paragraph group from a long document
- one logical section of a long runtime interaction
- one normalized record body from an integration payload

A chunk may or may not become durable. Chunks are the units evaluated for durable admission.

A `source leaf` is the durable bottom-level markdown document created when an admitted chunk is persisted into a tree.

So the relationship is:

`event -> chunk(s) -> admitted source leaf/leaves`

Not every event creates a leaf, and not every chunk becomes durable.

### Source leaves

A source leaf is the atomic canonical durable memory item.

A source leaf is always:

- a markdown document
- a bottom-level node
- a node with no children
- owned by exactly one tree
- treated as immutable after admission

Each source leaf stores:

- `leaf_id`
- `workspace_id`
- `tree_category`
- `tree_id`
- `origin_kind`
- `title`
- `summary`
- `body_path`
- `body_sha256`
- `observed_at`
- `created_at`
- `updated_at`
- `confidence`
- `verification_policy`
- `staleness_policy`
- `status`
- `supersedes_leaf_id`
- extracted labels and entities

### Summary nodes

Summary nodes are internal tree nodes owned by exactly one tree.

They are not canonical durable items, but they are persisted markdown documents.

A summary node always has child nodes, and those children may be:

- source leaves
- lower-level summary nodes

Each summary node stores:

- `summary_id`
- `workspace_id`
- `tree_category`
- `tree_id`
- `level`
- `parent_id`
- `child_ids`
- `body_path`
- `body_sha256`
- `observed_at`
- `time_range_start`
- `time_range_end`
- `created_at`
- `sealed_at`
- synthesized labels for retrieval

### Interaction trees

An interaction tree stores durable memory that originates from user or agent interaction with the workspace.

This includes durable memory derived from:

- runtime-derived workspace knowledge
- accepted user preference memory
- accepted user identity memory

Rules:

- each interaction leaf belongs to exactly one interaction tree
- interaction tree assignment is based on the leaf's primary interaction subject
- secondary concepts remain metadata for retrieval, not extra tree memberships
- an interaction tree contains one internal root summary node, optional intermediate summary nodes, and source leaves at the bottom
- in phase 1, an interaction entity becomes a tree as soon as the first admitted leaf is assigned to it
- in phase 1, summary layers are governed only by structural seal thresholds, not by hotness

### Interaction entity assignment in v1

For v1, interaction entity assignment may be primarily LLM-driven.

The intended flow is:

1. the backend provides the model with:
   - the chunk text
   - chunk metadata
   - allowed entity types
   - a shortlist of existing candidate entities when available
2. the model returns structured output indicating:
   - whether the chunk fits an existing entity
   - whether a new entity should be created
   - exactly one primary entity choice
   - optional secondary entities
   - confidence
3. the backend validates and canonicalizes that result
4. the resulting primary entity becomes the owner of the admitted interaction leaf

The model should help decide:

- does this chunk belong under an existing entity
- does it need a new entity
- what is the primary interaction entity

The backend should still retain the following guardrails:

- exactly one primary entity per admitted interaction leaf
- if the model selects an existing entity, it must be from the provided shortlist
- if the model requests a new entity, backend code generates the canonical entity id and slug
- if confidence is too low, the backend should route the leaf to a fallback interaction bucket rather than creating an unstable new entity

### Interaction entity decision matrix in v1

The backend should treat memory admission and entity assignment as separate decisions.

There are three distinct confidence questions:

- admission confidence:
  - should this chunk become durable memory at all
- existing-entity match confidence:
  - if admitted, does it belong to one known entity
- new-entity creation confidence:
  - if it does not fit a known entity, is there enough evidence to mint a new stable entity

The v1 decision matrix should be:

1. low admission confidence
   - do not create a source leaf
   - do not assign an entity
2. high admission confidence and high existing-entity match confidence
   - create the source leaf
   - assign it to that existing entity
3. high admission confidence, low existing-entity match confidence, and high new-entity creation confidence
   - create the source leaf
   - create a new entity
   - assign the leaf to that new entity
4. high admission confidence, but neither existing-match nor new-entity confidence is high
   - create the source leaf
   - assign it to a fallback interaction bucket such as `interaction:uncategorized`

The important rule is:

- failing to match an existing entity is not enough to justify creating a new entity

Creating a new entity should require positive confidence that the chunk is about a clear, stable, reusable subject. Otherwise the leaf should remain durable but live under the fallback interaction bucket until later reclassification.

This keeps v1 entity assignment simple while preserving backend control over canonical ids and ownership semantics.

### Integration trees

An integration tree stores durable memory that originates from external systems.

This includes durable memory derived from:

- periodic sync jobs
- integration fetches
- imported external records

Rules:

- each integration leaf belongs to exactly one integration tree
- integration tree assignment is based on source lineage
- an integration tree contains one internal root summary node, optional intermediate summary nodes, and source leaves at the bottom

Integration trees remain part of the target architecture, but integration-tree implementation is deferred until after phase 1.

## Tree construction

### Lifecycle model

The durable pipeline should be understood as:

`event -> chunk -> source leaf -> summary node`

This should be treated as a lifecycle distinction, not just naming.

- events are ingress-only units
- chunks are normalization and admission units
- source leaves are durable canonical bottom nodes
- summary nodes are durable derived internal nodes

### Chunk lifecycle

The chunk lifecycle is:

1. receive an event
2. normalize it into one or more chunks
3. score or evaluate each chunk for durable admission
4. discard non-durable chunks from the durable tree path
5. promote admitted chunks into source leaves

Chunks are therefore ingestion-stage objects. They are not the long-lived tree abstraction unless they are promoted into leaves.

### Source leaf lifecycle

The source leaf lifecycle is:

1. create a source leaf from an admitted chunk
2. assign it exactly one category and exactly one owning tree
3. persist it as one markdown body plus one metadata row
4. place it at the bottom of its tree
5. include it in future summary sealing as the tree grows upward

Leaves remain leaves for their entire lifetime. A leaf does not turn into a summary node.

When new durable information refines, corrects, or replaces an existing leaf, the system should prefer creating a new leaf and marking the older leaf as `superseded` or `inactive` in metadata rather than mutating the old leaf body in place.

### Summary node lifecycle

The summary node lifecycle is:

1. accumulate enough child nodes to meet sealing thresholds
2. synthesize one summary node over those children
3. persist the summary node as markdown plus metadata
4. repeat upward as higher levels become sealable

Summary nodes summarize their immediate children while representing the whole subtree beneath them.

Summary nodes should be treated as derived sealed artifacts. Once sealed, they should not be manually edited in place. If the subtree changes, the backend should create replacement summary nodes and update tree pointers or parent links accordingly.

### Interaction leaf admission

Durable writeback should produce candidate interaction leaves from user or agent interaction with the workspace.

Each admitted interaction leaf is:

1. classified into the `interaction` category
2. assigned exactly one primary interaction entity
3. assigned exactly one owning tree based on that entity
4. persisted as one markdown body plus one metadata row

### Integration leaf admission

Integration ingestion should produce candidate integration leaves from external systems.

Each admitted integration leaf is:

1. classified into the `integration` category
2. assigned exactly one owning tree based on integration lineage
3. persisted as one markdown body plus one metadata row

### Date handling

Every admitted node carries date or time metadata.

For leaves, `observed_at` is required.

For summary nodes, the backend records the time range covered by the summarized subtree.

### Tree sealing

In phase 1, interaction trees use the following mechanics:

- append leaves into low-level buffers
- produce higher-level summaries when seal thresholds are met
- continue upward until the tree root can be refreshed

The structural model, read top-down, is:

`root summary node -> intermediate summary nodes -> source leaves`

Each summary node summarizes its immediate children while semantically representing the full subtree beneath it.

Phase 1 does not include hotness-based tree creation or hotness-based summary materialization. The first admitted interaction leaf creates the tree, and only seal thresholds control when summaries appear.

## Retrieval model

The retrieval system chooses among tree categories based on query intent and available filters.

In phase 1, retrieval implementation is interaction-only even though the target architecture reserves room for integration retrieval later.

Durable memory retrieval should be exposed to the agent as a tool, not as raw file access and not as blind tree traversal inside the prompt.

The tree backend should remain the retrieval implementation. The agent should interact with a retrieval tool that returns bounded, already-ranked memory results.

### Agent retrieval tool

The primary agent access path to durable memory should be a retrieval tool, for example `memory.retrieve`.

The tool should support inputs such as:

- `query`
- `category` or `categories`
- `tree_id` when the agent already knows the owning tree
- `time_range`
- `mode` such as `broad_summary` or `exact_evidence`
- `max_results`
- `include_leaves`

The tool should return:

- ranked summary hits
- ranked leaf hits
- node ids and tree ids
- citations or source paths
- enough metadata to support follow-up drill-down requests

The tool should hide the internal tree traversal mechanics from the agent. The agent asks for relevant memory; the backend decides how to traverse and rank.

### Interaction retrieval

Use interaction trees when the query is primarily about workspace behavior, user preferences, identity, or knowledge derived from interaction history.

Examples:

- communication preferences
- project-specific operating conventions
- facts learned through prior user interaction

### Integration retrieval

Use integration trees when the query is primarily about externally sourced information.

Examples:

- recent synced customer records
- imported repository context
- fetched email or calendar information

### Cross-category retrieval

The runtime may combine hits from both categories when a query spans both kinds of memory.

Cross-category retrieval happens in the query layer. It does not require shared leaves.

### Time-scoped retrieval

The runtime may restrict or rank results by date using node metadata.

Examples:

- what did we learn this week
- what changed on 2026-05-20
- what recent integration data mentions project alpha

### Retrieval algorithm

All retrieval should follow this pattern:

1. classify the query into `interaction`, `integration`, or both
2. apply explicit filters first:
   - category
   - tree id
   - time range
   - labels or entities when available
3. query the database for candidate trees and candidate nodes
4. rank high-level and intermediate summary nodes first
5. choose the most promising branches
6. drill down only into selected branches
7. rank leaves inside those branches when exact evidence is needed
8. hydrate the selected markdown bodies from disk
9. assemble a bounded result set for the agent

The retrieval system should prefer summary-first traversal for broad questions and leaf-first evidence only when the query requires exact detail.

### Summary-first traversal

For broad or ambiguous questions, retrieval should begin with summary nodes:

- query candidate `L1`, `L2`, and other intermediate summary nodes
- rank them using metadata, embeddings, and lexical/entity matches
- select a small number of promising branches
- drill down only when needed

This keeps the number of file reads and token volume bounded even when the memory corpus grows large.

### Leaf drill-down

For exact questions, retrieval should still use the tree to narrow scope first, then retrieve leaves:

- use summary nodes to choose branches
- search leaves within those branches
- return exact leaf bodies only for the small set of top candidates

This avoids global leaf scans across the entire workspace memory corpus.

### Embedding strategy

The backend should embed both:

- source leaves
- sealed summary nodes, including intermediate summary nodes

Intermediate summary node embeddings are useful and should be part of the design.

They help because:

- they provide coarse semantic routing at the branch level
- they let retrieval shortlist relevant subtrees without reading all descendant leaves
- they reduce the need for global leaf-level semantic search on every query

Leaves should still be embedded because leaf embeddings are better for exact evidence retrieval and precise factual matches.

The intended split is:

- summary-node embeddings for branch selection
- leaf embeddings for evidence selection

Summary embeddings should be generated only for sealed summary nodes. If a subtree changes and a summary node is replaced, the replacement summary should receive a fresh embedding and the old one should be retired with its node.

## Storage model

### On disk

The filesystem stores:

- source-leaf markdown bodies
- summary-node markdown bodies

The tree backend owns the disk layout. Generated `MEMORY.md` indexes are not part of the new model.

One concrete v1 layout is:

```text
<workspace>/.holaboss/memory/
  interaction/
    <tree_id>/
      leaves/
        <leaf_id>.md
      summaries/
        L1/
          <summary_id>.md
        L2/
          <summary_id>.md
          <summary_id>.md
        L3/
          <summary_id>.md

  integration/
    <tree_id>/
      leaves/
        <leaf_id>.md
      summaries/
        L1/
          <summary_id>.md
        L2/
          <summary_id>.md
```

In this model:

- leaves live inside the tree that owns them
- there is no shared leaf store
- `L1` has at most one file per tree
- deeper levels may have many summary files

### In the database

The database stores:

- source-leaf metadata
- summary-node metadata
- tree definitions
- parent-child relationships
- root-summary pointers
- leaf embeddings
- summary-node embeddings
- label and entity indexes
- background jobs
- integrity metadata such as content hashes

The database is authoritative for:

- what leaves exist
- what trees exist
- which tree owns a leaf
- which summary nodes belong to which trees
- what retrieval candidates should be considered

Markdown files remain authoritative for long-form body content.

## Write and job flow

The durable write path should be:

1. extract or accept a durable memory item
2. classify it as `interaction`
3. choose or create the owning interaction tree from the assigned primary entity
4. persist the leaf markdown body
5. persist the leaf metadata row
6. extract labels, entities, and time metadata
7. append the leaf into its owning tree
8. run sealing and summary generation as background work when structural thresholds are met
9. compute and persist embeddings for leaves and summaries

The backend should treat ingestion and summarization as asynchronous work wherever possible so user-visible runtime latency stays bounded.

### Phase 1 interaction upsert algorithm

Phase 1 should implement one deterministic upsert path for interaction memory.

The algorithm should be:

1. receive one interaction event
   - examples:
     - user message
     - assistant turn
     - accepted preference or identity memory
2. normalize the event into one or more chunks
   - normalize text
   - attach workspace, session, and timestamp metadata
   - compute a stable chunk fingerprint
3. evaluate admission for each chunk
   - if admission confidence is below threshold:
     - stop for that chunk
     - do not create a leaf
4. build the entity-assignment prompt input
   - chunk text
   - chunk metadata
   - allowed entity types
   - shortlist of existing candidate entities
5. run LLM entity assignment for the admitted chunk
   - choose one of:
     - match existing entity
     - create new entity
     - fallback
   - produce exactly one primary entity decision
6. validate the LLM result in backend code
   - reject invalid existing-entity ids not present in the shortlist
   - generate canonical id and slug for any approved new entity
   - if neither existing-match nor new-entity confidence is sufficient:
     - use `interaction:uncategorized`
7. resolve dedup or supersession
   - if an active leaf already exists with the same chunk fingerprint and same owner:
     - no-op
   - if an active leaf for the same durable subject exists but the new chunk materially updates it:
     - create a new leaf
     - set `supersedes_leaf_id`
     - mark the older leaf `superseded`
   - otherwise:
     - create a new active leaf
8. ensure the owning interaction tree exists
   - in phase 1, creating the first admitted leaf for an entity creates that entity tree immediately
9. persist the leaf
   - write markdown body to the tree-owned leaf path
   - insert DB metadata row
   - insert entity linkage and retrieval metadata
10. update tree structure
   - attach the leaf at the bottom of its owning tree
   - invalidate any affected unsealed buffers or parent summary lineage
11. enqueue background work
   - sealing
   - summary generation
   - summary replacement where needed
   - leaf embedding
   - summary embedding after sealing
12. return an upsert result
   - leaf id
   - owner tree id
   - entity decision
   - whether the operation was:
     - `noop_duplicate`
     - `created`
     - `superseding`

### Phase 1 dedup and supersession rules

The first implementation should use simple deterministic rules:

- exact chunk fingerprint match under the same owner tree:
  - no-op
- same durable subject, same owner tree, but materially different body:
  - create a superseding leaf
- different owner tree:
  - treat as a distinct leaf unless a later reclassification flow is added

Phase 1 should prefer a conservative duplicate policy over aggressive merging.

### Phase 1 summary invalidation and rebuild

When a new leaf is created or a prior leaf is superseded:

- affected leaf buffers become dirty
- any parent summary chain above the changed branch becomes stale
- stale summaries remain readable until replacement summaries are sealed
- once replacement summaries are ready, root pointers and parent links are updated atomically in the database

This allows retrieval to remain available while summary regeneration runs in the background.

## Public interface impact

The existing durable memory backend should be replaced underneath the current memory surface.

For now, the redesign assumes:

- the current `/api/v1/memory/search|get|upsert|status|sync` routes remain compatibility surfaces to be adapted later
- durable agent access should converge on a memory retrieval tool backed by the tree query engine
- removed proposal and bridge memory APIs do not return
- the backend is the primary design target before the final API shape is revisited

## Non-goals for v1

The first redesign does not need:

- shared leaves across trees
- multi-tree membership for one leaf
- daily-digest trees as a first-class tree family
- a separate memory proposal review surface
- manual file-path semantics as the core durable abstraction
- session-derived state and durable memory in one store
- migration of legacy `MEMORY.md` index behavior into the new backend

## Success criteria

The redesign is successful when:

- durable memory has one backend root with categorized trees under it
- `interaction` is implemented as the first ownership category, with `integration` reserved for a later phase
- every source leaf belongs to exactly one tree
- every persisted node body is markdown
- runtime durable recall no longer depends on generated `MEMORY.md` indexes
- cross-category retrieval works without shared leaves
- session continuity remains functional without being part of the durable tree model

## Open product decisions intentionally deferred

These are left for later technical design, not for this PRD:

- exact tree seal thresholds per level
- exact rule for choosing a primary interaction tree
- exact granularity for integration trees once that phase begins
- exact embedding model and reranking policy
- final HTTP request and response schemas for the memory APIs
- legacy data migration versus cold restart during backend cutover
