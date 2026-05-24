---
title: Memory architecture redesign note
date: 2026-05-24
status: draft
related:
  - 2026-05-20-memory-redesign-prd.md
  - ../memory-arch/gmail.md
  - ../memory-arch/github.md
  - ../memory-arch/notion.md
---

# Memory architecture redesign note

## Goal

Define a cleaner canonical memory model that keeps the tree itself semantic, treats summaries as node properties instead of node types, and leaves fanout-management layers as an optional optimization instead of core ontology.

This note is a target architecture note. It does not describe the current implementation.

## Problem

The current model is carrying too much structure in implementation-specific concepts:

- `entity` and `branch` are acting like fixed ontology instead of just semantic layers
- `summary` is implemented as a node type instead of a property of a parent node
- the system currently maintains both a canonical containment tree and a separate summary-child tree
- path shape is doing too much work in determining parentage

That makes provider-specific structures like Notion feel flatter than they should, and it makes the conceptual model harder to explain than it needs to be.

## Design principles

### 1. The canonical tree should be semantic

From the tree root down to the source leaves, the canonical structure should represent semantic grouping only.

The base shape is:

```text
tree
- node
  - node
    - leaf
```

Where:

- `tree` is the ownership boundary
- `node` is a semantic grouping or semantic object
- `leaf` is the actual durable source-backed content

### 2. Summary is a property, not a node type

Every non-leaf node may have a summary that describes its immediate children.

That summary is part of the node's metadata and retrieval surface. It is not a separate structural node in the canonical tree.

### 3. Leaves are the durable evidence layer

Leaves remain the actual durable content items:

- one GitHub issue snapshot
- one Gmail message snapshot
- one Notion page overview snapshot
- one interaction memory fact or procedure leaf

Leaves have no children.

### 4. Relations are separate from containment

Cross-links should be represented as relation edges, not forced into the containment tree.

Examples:

- a Notion page belongs to a database
- a Gmail thread has participants
- a GitHub PR references an issue

### 5. Optimization layers are not canonical ontology

If a node grows too large, the system may later create partition or materialization nodes to keep retrieval and browsing efficient.

Those nodes are an optimization layer, not the semantic source of truth.

This matters more for interaction trees than for integration trees.

## Canonical model

### Tree categories

Keep the top-level split already established in the PRD:

- `interaction`
- `integration`

Each tree belongs to exactly one category.

### Tree ownership

Ownership stays strict:

- one interaction tree per interaction owner
- one integration tree per integration connection

For integration, keeping one tree per connection remains the right boundary even when the upstream system has additional internal scopes such as workspaces, repos, channels, or mail threads.

### Node model

A canonical internal node should just be a semantic node with fields along these lines:

- `node_id`
- `tree_id`
- `parent_node_id`
- `node_kind`
- `title`
- `summary`
- `metadata`
- `position`
- `observed_at`
- `updated_at`

Important constraints:

- `node_kind` should describe the semantic role of the node, not a storage hack
- `summary` belongs on the node itself
- parentage should come from explicit parent references, not inferred path shape

`node_kind` can stay lightweight and provider-specific where useful:

- `workspace`
- `repo`
- `page`
- `database`
- `thread`
- `facet`
- `section`

The important part is not the exact enum. The important part is that all non-leaf canonical nodes are semantic.

### Leaf model

Leaves should keep the durable source/provenance fields we already care about:

- source identity
- subject key
- upstream object id and type
- timestamps
- dedupe and supersession metadata
- markdown body

What changes is only the surrounding canonical structure, not the idea of a durable source leaf.

### Summary model

Each non-leaf node summarizes the nodes one level below it.

Examples:

- a repo node summarizes its child nodes `overview`, `readme`, `issues`, and `pull requests`
- an `issues` node summarizes its issue leaves
- a Notion workspace node summarizes its child `pages` and `databases` nodes

This keeps the user-facing tree simple:

```text
repo
- overview
- readme
- issues
- pull requests
```

instead of requiring extra explicit summary nodes beside those semantic nodes.

## Integration guidance

Integration trees should start with fixed semantic layers defined by the provider.

That means the first pass does not need dynamic fanout-management layers for most providers.

### GitHub

```text
github connection
- repo: holaboss-ai/holaOS
  - overview
    - leaf: repository overview
  - readme
    - leaf: README
  - issues
    - leaf: issue #101
    - leaf: issue #102
  - pull requests
    - leaf: PR #412
  - notifications
    - leaf: review requested
```

### Gmail

One valid shape would be:

```text
gmail connection
- mailbox
  - profile
    - leaf: mailbox profile
  - threads
    - thread: launch planning
      - messages
        - leaf: message A
        - leaf: message B
```

The exact Gmail layers can still be tuned, but the important point is that they should be semantic and fixed up front.

### Notion

```text
notion connection
- workspace: Product
  - pages
    - page: Roadmap
      - overview
        - leaf: page overview
      - content
        - leaf: page content
  - databases
    - database: Tasks
      - overview
        - leaf: database overview
      - rows
        - leaf: row A
        - leaf: row B
```

This makes the workspace explicit while keeping one tree per connection.

## Interaction guidance

Interaction trees are more likely to need optional fanout-management later because their growth is less predictable.

The canonical interaction tree should still stay semantic first. But if one node accumulates too many children, the system may later materialize partition nodes such as:

- `slice 1`
- `slice 2`
- `recent`
- `historical`

Those nodes should be treated as optimization artifacts, not the core semantic meaning of the tree.

This is more likely to matter for interaction than for integration.

## Optimization layer

The system should allow an optional materialization layer for scale:

- partition nodes for high fanout
- retrieval-only indexes
- cached rollups
- alternate browse projections

But these should not change the canonical semantic model.

In other words:

- canonical tree = semantic truth
- summaries = properties on canonical nodes
- materialization = optimization

## Retrieval implications

This model keeps retrieval simple:

- broad queries can score internal-node summaries first
- drill-down queries can descend into child nodes
- exact evidence still comes from leaves
- relation edges can expand laterally without polluting the containment tree

This also removes the current conceptual split where a separate summary tree has to be mentally combined with the browseable containment tree.

## Migration direction

The migration from the current model should conceptually look like this:

1. Keep `interaction` and `integration` as the top-level categories.
2. Keep one integration tree per connection.
3. Replace `entity` and `branch` as hardcoded ontology with generic semantic nodes.
4. Move summary content onto the parent semantic node instead of persisting separate summary nodes as first-class structure.
5. Preserve relations as explicit graph edges.
6. Add partition/materialization only where fanout actually requires it.

## Main decision

The main architectural decision is:

- the canonical memory tree should be semantic
- summaries should be node properties
- optimization layers should be optional and secondary

That gives integration a clean fixed-shape model now, while still leaving room for interaction trees to scale later without distorting the core memory ontology.
