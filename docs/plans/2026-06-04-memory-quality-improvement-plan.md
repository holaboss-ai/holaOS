---
title: Memory quality improvement plan
date: 2026-06-04
status: draft
related:
  - 2026-06-02-single-workspace-memory-implementation-plan.md
  - 2026-06-04-memory-quality-rubric.md
  - 2026-05-24-memory-architecture-redesign-note.md
---

# Memory quality improvement plan

## Goal

Make the current MD-backed workspace memory system reliably meet the quality bar in [2026-06-04-memory-quality-rubric.md](./2026-06-04-memory-quality-rubric.md).

The highest-priority gaps are:

- relation quality
- relation consistency
- artifact backing parity
- multi-angle retrieval
- concrete detail retention

This is not a new memory architecture. It is a concrete hardening plan for the current runtime and desktop code.

## Scope

This plan assumes the following stay true:

- Markdown remains the canonical durable memory artifact.
- Semantic nodes, search docs, evidence refs, and relations remain derived DB state.
- The workspace graph remains the only product-facing durable memory graph.
- Artifact documents remain first-class semantic trees under the workspace graph.

This plan does not assume:

- a separate observation-store product surface
- a graph database replacing markdown
- a full memory rewrite before quality improvements ship

## Current code-grounded diagnosis

The current system already has the right major pieces:

- artifact persistence in [workspace-attachment-memory.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/workspace-attachment-memory.ts)
- turn writeback orchestration in [turn-memory-writeback.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/turn-memory-writeback.ts)
- owner assignment and semantic rebuild in [interaction-memory.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/interaction-memory.ts)
- retrieval and relation-aware scoring in [workspace-memory.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/workspace-memory.ts)
- markdown relation round-trip in [memory-related-entities.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/memory-related-entities.ts)

The biggest remaining problems are not missing subsystems. They are mismatches between those subsystems.

### 1. Identity is generated too early and from labels

In [memory-related-entities.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/memory-related-entities.ts), both `normalizeRelatedEntities(...)` and `normalizeRelations(...)` currently call `stableRelatedEntityKey(...)` directly on free-form labels.

That is where keys like these come from:

- `artifact:.-notion-related-pages.md`
- `artifact:artifact`
- `topic:topic`

The same problem exists in [interaction-memory.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/interaction-memory.ts), where `workspaceArtifactSemanticTargets(...)` derives artifact relation targets by calling `stableRelatedEntityKey("artifact", title)`.

So the relation system is treating identity as a label-normalization problem when the runtime already has stronger IDs for:

- outputs
- attachments
- image URLs
- tool results
- interaction owner trees

### 2. Artifact trees are real, but memory-to-artifact resolution is still probabilistic

The runtime already persists first-class artifact trees for:

- attachments
- referenced image URLs
- tool results
- outputs

That all happens in [workspace-attachment-memory.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/workspace-attachment-memory.ts).

But relation rebuild in [interaction-memory.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/interaction-memory.ts) still tries to resolve artifact targets by matching those title-derived keys.

This is why sibling memories about the same output can diverge:

- one memory resolves to the real output artifact root
- another memory ends up with a synthetic placeholder relation

The plumbing exists. Identity is what is inconsistent.

### 3. Writeback still compresses structured artifact evidence too aggressively

[turn-memory-writeback.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/turn-memory-writeback.ts) persists artifact docs before extraction, which is correct.

But `loadTurnWritebackBatchContext(...)` still flattens chunk evidence back into a single assistant-text block via:

- `attachmentArtifactEvidenceFromTurnDocuments(...)`
- `toolResultArtifactEvidenceFromTurnDocuments(...)`
- `outputArtifactEvidenceFromTurnDocuments(...)`
- `imageUrlArtifactEvidenceFromTurnDocuments(...)`
- `mergeAssistantTextWithSupportingEvidence(...)`

That is adequate for small turns. It is the wrong abstraction for:

- one-turn teammate sessions
- large tool results
- long deliverables
- consistent relation extraction

The structured artifact documents already exist. The extractor should consume them as structured sources, not only as flattened bullet text.

### 4. Current backfill only repairs artifact graph wiring, not memory quality

[workspace-attachment-memory.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/workspace-attachment-memory.ts) has `ensureWorkspaceArtifactRelationsBackfilled(...)`, which is useful.

But that backfill only restores artifact relation rows from stored artifact markdown and output provenance. It does not:

- create missing artifact trees for older outputs
- repair relationless durable memories
- rewrite clipped memories
- delete request-shaped junk memories
- re-resolve placeholder related entities to real nodes

That is why older workspaces can still have:

- valid artifact/output rows
- rehomed semantic trees
- but poor relation quality and missing artifact backing on the memory side

## Concrete target behavior

Every new non-trivial durable memory should satisfy all of these:

1. It has one sensible primary owner.
2. It has at least one real provenance source.
3. It has at least one real relation target when one exists in the workspace.
4. If it is artifact-derived, it has a real `derived_from` edge to an artifact tree.
5. Sibling memories that refer to the same artifact resolve to the same artifact node.
6. It is retrievable by fact wording, related entities, provider/account, and artifact name when those are relevant.

Every active workspace repair pass should move older memories toward the same standard.

## Design decisions

### 1. Do not start with new tables

The first implementation slice should not start by adding new store tables.

The current runtime already has enough material to build a canonical resolver from:

- active interaction entities
- active artifact root nodes
- output rows
- current semantic relation metadata

That is lower-risk than introducing a new persistence model before proving the quality gain.

If performance or alias durability later requires persisted resolver state, add it after the derived resolver is working.

### 2. Canonical keys should be source-based when the source is known

The key rule should be:

- use source-based stable keys for resolved targets
- use label-slug keys only as unresolved fallback

Canonical resolved key shapes:

- interaction owner tree:
  - `project:entity:<entity-id>`
  - `system:entity:<entity-id>`
  - `person:entity:<entity-id>`
  - `topic:entity:<entity-id>`
- output artifact:
  - `artifact:output:<output-id>`
- attachment artifact:
  - `artifact:attachment:<attachment-id>`
- tool result artifact:
  - `artifact:tool-result:<provider>:<call-id-or-output-event-id>`
- referenced image artifact:
  - `artifact:image-url:<content-hash>`

Unresolved fallback shapes stay as today:

- `person:ben-book`
- `topic:product-strategy`
- `artifact:notion-related-pages-md`

This keeps markdown compatible with the current parser because the first token remains the entity type.

### 3. Resolution should happen before markdown is finalized

The current pipeline writes related entities first and resolves later.

The hardened pipeline should:

1. extract related labels and relation types
2. resolve them through workspace-aware resolver logic
3. persist canonical keys into markdown
4. sync semantic relations from those canonical keys

That makes markdown the canonical semantic artifact while still preventing low-quality synthetic keys from being written when a real target already exists.

### 4. Minimum relation contract must be enforced in writeback

Non-trivial new memories should not be allowed to persist with zero useful relations.

Minimum contract:

- if any same-turn artifact document exists, add at least one `derived_from` relation to it
- if extraction yields no useful semantic relation, add one `about` relation to the primary owner entity
- if extracted related entities are all generic placeholders, retry one narrower repair extraction before persistence

This keeps the system from producing relationless durable leaves when the runtime already knows the provenance and owner.

## Concrete design

## A. Add a derived workspace related-entity resolver

Create a new runtime module:

- [workspace-related-entity-resolver.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/workspace-related-entity-resolver.ts)

This module should build a workspace-scoped resolver from existing runtime state.

### Inputs

From [interaction-memory.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/interaction-memory.ts):

- `store.listInteractionEntities(...)`

From [workspace-attachment-memory.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/workspace-attachment-memory.ts):

- `listWorkspaceAttachmentDocumentTrees(...)`
- `listWorkspaceImageUrlDocumentTrees(...)`
- `listWorkspaceToolResultDocumentTrees(...)`
- `listWorkspaceOutputDocumentTrees(...)`

From output rows when artifact trees are not materialized yet:

- `store.listOutputs(...)`

### API

The first API surface should be:

```ts
type ResolvedWorkspaceRelatedEntity = {
  entityType: DurableMemoryRelatedEntityType;
  entityKey: string;
  label: string;
  resolutionKind: "interaction_entity" | "output_artifact" | "attachment" | "tool_result" | "image_url" | "synthetic";
  targetTreeId: string | null;
  targetNodeId: string | null;
  aliasTexts: string[];
};

type WorkspaceRelatedEntityResolver = {
  resolve(params: {
    entityType: DurableMemoryRelatedEntityType;
    label: string;
    sourceTurnInputId?: string | null;
    provider?: string | null;
    accountNamespace?: string | null;
  }): ResolvedWorkspaceRelatedEntity | null;
  artifactTargetsForTurnInput(inputId: string): ResolvedWorkspaceRelatedEntity[];
  ownerTargetForInteractionEntity(entityId: string): ResolvedWorkspaceRelatedEntity | null;
};
```

### Resolution rules

Artifact resolution should use stronger identifiers first:

1. output id
2. attachment id
3. tool call id or output event id
4. image URL content hash
5. normalized file path
6. normalized title

Interaction owner resolution should use:

1. exact entity id when already known
2. exact canonical name plus type
3. normalized canonical name alias plus type

### Generic-label rejection

The resolver should explicitly reject unresolved labels that normalize to placeholders unless they already matched a real target:

- `topic`
- `artifact`
- `document`
- `page`
- `report`
- `issue`
- `system`

That directly blocks `topic:topic` and `artifact:artifact`.

## B. Update related-entity extraction to persist canonical keys

Change [memory-related-entities.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/memory-related-entities.ts).

### New internal shape

Keep markdown as:

- `## Related Entities`
- `## Relations`

But extend the in-memory related entity shape:

```ts
type DurableMemoryResolvedTarget = {
  resolutionKind: "interaction_entity" | "output_artifact" | "attachment" | "tool_result" | "image_url" | "synthetic";
  targetTreeId: string | null;
  targetNodeId: string | null;
};

type DurableMemoryRelatedEntity = {
  entityType: DurableMemoryRelatedEntityType;
  entityKey: string;
  label: string;
  resolved: DurableMemoryResolvedTarget | null;
};
```

### Hook points

Change these stages:

1. `normalizeRelatedEntities(...)`
2. `normalizeRelations(...)`
3. `extractDurableMemoryRelatedInfo(...)`
4. `appendDurableMemoryRelatedSections(...)`

The new flow should be:

1. model returns raw labels and relation types
2. resolver canonicalizes them
3. canonical keys are written into markdown
4. unresolved fallback keys are only used when no real target exists

### Validation

Add:

- `validateDurableMemoryRelatedInfo(...)`
- `repairDurableMemoryRelatedInfo(...)`

Validation rules:

1. reject generic placeholders unless resolved
2. ensure `derived_from` exists for artifact-derived memories
3. ensure at least one semantic relation beyond pure mentions when the memory is non-trivial

## C. Make interaction rebuild resolve canonical keys first

Change [interaction-memory.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/interaction-memory.ts).

### Current weakness

`workspaceArtifactSemanticTargets(...)` and `resolvedSemanticTargetForRelatedEntity(...)` currently depend too much on title-derived artifact keys.

### New behavior

`resolvedSemanticTargetForRelatedEntity(...)` should:

1. inspect canonical key format first
2. resolve directly by artifact or entity id when encoded in the key
3. fall back to resolver alias matching only when the key is unresolved
4. emit a synthetic target only when neither direct nor alias resolution works

### Required changes

- replace direct `stableRelatedEntityKey("artifact", title)` matching in artifact target builders
- build artifact targets with source-based canonical keys
- preserve current metadata fields:
  - `entity_key`
  - `entity_label`
  - `target_tree_id`
  - `target_node_id`
- add `resolved_target_kind` metadata:
  - `resolved`
  - `synthetic`
  - `missing`

This keeps browser and retrieval logic simple and inspectable.

## D. Replace flattened artifact evidence with structured artifact context

Change [turn-memory-writeback.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/turn-memory-writeback.ts) and [memory-writeback-extractor.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/memory-writeback-extractor.ts).

### Current issue

`loadTurnWritebackBatchContext(...)` already has access to artifact docs but collapses them into `Supporting evidence:` strings.

### New batch shape

Add:

```ts
type DurableMemoryArtifactContext = {
  sourceKind: "attachment" | "image_url" | "tool_result" | "output_artifact";
  treeId: string;
  title: string;
  provider: string | null;
  accountNamespace: string | null;
  excerpts: string[];
  canonicalEntityKey: string | null;
};
```

`loadTurnWritebackBatchContext(...)` should return:

- `assistantText`
- `artifactContexts[]`
- legacy flattened evidence only as a temporary fallback

### Prompt rendering

`extractDurableMemoryCandidatesFromModel(...)` should render grouped sections:

- assistant response
- input attachments
- referenced images
- tool results
- forwarded outputs

That gives the model a stable source structure for teammate flows and artifact-heavy turns.

### Relation extraction

The related-entity extraction pass should receive the same `artifactContexts[]`, not only the finalized markdown body. That lets it choose real artifact targets directly.

## E. Backfill missing artifact trees before repairing memory leaves

Change [workspace-attachment-memory.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/workspace-attachment-memory.ts).

### New repair entrypoints

Add:

- `backfillWorkspaceOutputArtifactTrees(...)`
- `backfillWorkspaceToolResultArtifactTrees(...)`
- `backfillWorkspaceAttachmentArtifactTrees(...)`

The first slice only needs to guarantee output backfill. That is the most obvious gap in `mem-test-1`.

### Behavior

For active workspace rows:

- if an output row exists and no corresponding output artifact tree exists, materialize the tree
- if a tree exists but relation sync metadata is stale, rerun artifact relation sync

### Runtime gates

Use versioned workspace metadata:

- `workspace_artifact_tree_backfill_v2`
- `workspace_related_entity_repair_v2`

Trigger them on:

- `memory_retrieve`
- memory browser tree/graph/node-detail
- explicit refresh/rebuild paths

The current code already uses this pattern for artifact relation backfill, so this extends an existing mechanism rather than inventing a new one.

## F. Add a targeted memory quality repair pass

Create:

- [workspace-memory-repair.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/workspace-memory-repair.ts)

This should repair active durable leaves after artifact backfill.

### Selection criteria

Prioritize active leaves where:

- `parseDurableMemoryRelatedInfo(...)` yields zero relations
- markdown contains `...`
- title looks request-shaped
- evidence refs imply artifact or tool provenance but there is no artifact relation
- related keys match known placeholder patterns

### Repairs

1. soft-delete request-shaped junk memories
2. rerun related-entity extraction with resolver support
3. synthesize missing `derived_from` when source artifacts exist
4. rewrite clipped markdown from source artifact or output content when available
5. resync semantic relations and search docs after repair

### Important constraint

Do not repair by free-form paraphrasing when source evidence no longer exists. If the original evidence is gone, leave the memory untouched rather than inventing detail.

## G. Make retrieval consume canonical resolver aliases

Change [workspace-memory.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/workspace-memory.ts).

### Current issue

`semanticRelationContext(...)` already reads:

- `relation_type`
- `entity_key`
- `entity_label`
- target node traversal
- provider/account evidence

But relation text quality still depends too much on whatever label happened to be written into markdown.

### New behavior

For each hit candidate, hydrate scoring text from:

- canonical key
- canonical label
- resolver alias texts
- artifact filename/path aliases
- provider/account aliases

Scoring buckets should remain separate:

- artifact-style queries prefer artifact docs
- entity-style queries prefer durable memories with real semantic relations
- provider/account queries prefer durable memories that have artifact-backed provenance, not just raw tool-result chunks

### Penalty

If a relation remains synthetic while a real resolver target exists, apply a ranking penalty. That will make stale unresolved memories visibly worse until repair runs.

## H. Expose relation quality explicitly in the browser

Change [memory-browser.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/memory-browser.ts) and [MemoryPane.tsx](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/apps/desktop/src/components/panes/MemoryPane.tsx).

### New payload field

For outgoing and incoming relations, include:

- `resolved_target_kind: "resolved" | "synthetic" | "missing"`

### UI behavior

The pane should:

- render resolved targets as normal links
- render synthetic targets as degraded links with explicit unresolved status
- render missing targets as provenance text only

This makes relation quality inspectable in the product instead of only inferable from raw markdown or DB inspection.

## End-to-end flow after the change

For a one-turn teammate run:

1. tool results persist as first-class artifact trees
2. forwarded deliverable persists as first-class output artifact tree
3. writeback builds structured artifact contexts from those trees
4. durable memory extraction reads the structured contexts
5. related-entity extraction resolves canonical artifact/entity keys before markdown is written
6. durable memory leaf persists with:
   - sensible owner
   - `derived_from` artifact link
   - resolved related entities
7. rebuild syncs semantic relations from canonical keys
8. retrieval can find:
   - the durable memory by person/org/provider/account
   - the artifact document by filename/title
9. browser/node-detail shows whether all relation targets are fully resolved

That is the baseline workflow this plan is optimizing for.

## Implementation phases

### Phase 1: Derived resolver and canonical artifact keys

Files:

- new [workspace-related-entity-resolver.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/workspace-related-entity-resolver.ts)
- [workspace-attachment-memory.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/workspace-attachment-memory.ts)
- [interaction-memory.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/interaction-memory.ts)

Exit criteria:

- new artifact relations use source-based canonical keys
- sibling memories about the same output resolve to the same artifact node
- placeholder artifact keys stop being generated for new writes

### Phase 2: Relation validation and structured writeback context

Files:

- [memory-related-entities.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/memory-related-entities.ts)
- [turn-memory-writeback.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/turn-memory-writeback.ts)
- [memory-writeback-extractor.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/memory-writeback-extractor.ts)

Exit criteria:

- non-trivial new memories no longer persist with zero useful relations
- artifact-derived memories always get `derived_from`
- teammate/output-heavy turns use structured artifact contexts

### Phase 3: Artifact tree backfill and workspace repair

Files:

- [workspace-attachment-memory.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/workspace-attachment-memory.ts)
- new [workspace-memory-repair.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/workspace-memory-repair.ts)
- [workspace-memory.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/workspace-memory.ts)
- [memory-browser.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/memory-browser.ts)

Exit criteria:

- missing output artifact trees can be materialized for active workspaces
- relationless active leaves can be repaired
- request-shaped junk can be removed
- clipped active memories can be rewritten only when source evidence exists

### Phase 4: Retrieval and UI quality surfacing

Files:

- [workspace-memory.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/workspace-memory.ts)
- [memory-browser.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/memory-browser.ts)
- [MemoryPane.tsx](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/apps/desktop/src/components/panes/MemoryPane.tsx)
- [memoryPaneModel.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/apps/desktop/src/components/panes/memoryPaneModel.ts)

Exit criteria:

- entity/provider/account queries reliably rank the durable memory first
- artifact queries reliably rank the artifact doc first
- unresolved relation quality is visible in the pane

## Validation plan

The plan is only complete when it passes the rubric in [2026-06-04-memory-quality-rubric.md](./2026-06-04-memory-quality-rubric.md), especially:

- `Relation Quality`
- `Relation Consistency`
- `Artifact Backing`
- `Retrieval Coverage`
- `Content Fidelity`

### Required runtime tests

Extend:

- [memory-related-entities.test.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/memory-related-entities.test.ts)
- [interaction-memory.test.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/interaction-memory.test.ts)
- [workspace-attachment-memory.test.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/workspace-attachment-memory.test.ts)
- [turn-memory-writeback.test.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/turn-memory-writeback.test.ts)
- [workspace-memory.test.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/workspace-memory.test.ts)
- [memory-browser.test.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/memory-browser.test.ts)
- [app.test.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/runtime/api-server/src/app.test.ts)

Required scenarios:

1. main-session chat with attachments
2. one-turn teammate run using integrations and returning a deliverable
3. repeat mention of the same fact across turns
4. sibling memories about the same artifact
5. stale workspace repair of old relationless or artifactless memories

### Required desktop tests

Extend:

- [MemoryPane.test.mjs](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/apps/desktop/src/components/panes/MemoryPane.test.mjs)
- [memoryPaneModel.test.ts](/Users/you/Desktop/holaboss/holaOS-perf-mem-v1/apps/desktop/src/components/panes/memoryPaneModel.test.ts)

Required scenarios:

1. resolved relation links navigate to real nodes
2. synthetic relation links render as degraded or unresolved
3. node detail preserves provenance after selecting a file from the tree

## Immediate next step

The first implementation slice should be:

1. add `workspace-related-entity-resolver.ts`
2. teach artifact persistence to emit canonical artifact keys
3. update interaction rebuild to resolve those canonical keys directly
4. add a regression proving two sibling memories about the same output both resolve to the same real artifact node

That is the smallest slice that directly attacks the current highest-value weakness: relation inconsistency despite otherwise decent artifact-backed memory plumbing.
