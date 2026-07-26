import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRelatedTargetResolution,
  findGraphNodeForPath,
  isNavigableMemoryRelationTarget,
  parseMemoryRelatedSections,
  resolveParsedRelatedEntities,
  resolveParsedRelatedRelations,
  resolveRelatedGraphTarget,
  resolveRelatedGraphNodeId,
} from "./memoryPaneModel";

function makeGraphNode(
  overrides: Partial<MemoryBrowserGraphNodePayload> & {
    id: string;
    label: string;
  },
): MemoryBrowserGraphNodePayload {
  return {
    id: overrides.id,
    kind: overrides.kind ?? "node",
    category: "workspace",
    tree_id: overrides.tree_id ?? null,
    label: overrides.label,
    subtitle: overrides.subtitle ?? null,
    status: overrides.status ?? null,
    level: overrides.level ?? null,
    child_count: overrides.child_count ?? null,
    path: overrides.path ?? null,
  };
}

function makeRelation(
  overrides: Partial<MemoryBrowserNodeRelationPayload> & {
    relation_type: string;
    source_node_id: string;
    target_node_id: string;
  },
): MemoryBrowserNodeRelationPayload {
  return {
    relation_type: overrides.relation_type,
    source_node_id: overrides.source_node_id,
    source_label: overrides.source_label ?? null,
    source_tree_id: overrides.source_tree_id ?? null,
    target_node_id: overrides.target_node_id,
    target_label: overrides.target_label ?? null,
    target_tree_id: overrides.target_tree_id ?? null,
    target_entity_key: overrides.target_entity_key ?? null,
    target_resolution_kind: overrides.target_resolution_kind ?? "synthetic",
    metadata: overrides.metadata ?? {},
  };
}

test("parseMemoryRelatedSections extracts structured related entity and relation blocks", () => {
  const parsed = parseMemoryRelatedSections(`# Memory

## Summary

Something useful.

## Related Entities

- \`person:ben-book\` | Ben Book
- \`organization:anyip\` | anyIP

## Relations

- \`contacted_by\` -> \`person:ben-book\` | Ben Book
- \`works_at\` -> \`organization:anyip\` | anyIP
`);

  assert.deepEqual(parsed.entities, [
    { entityKey: "person:ben-book", label: "Ben Book" },
    { entityKey: "organization:anyip", label: "anyIP" },
  ]);
  assert.deepEqual(parsed.relations, [
    {
      relationType: "contacted_by",
      entityKey: "person:ben-book",
      label: "Ben Book",
    },
    {
      relationType: "works_at",
      entityKey: "organization:anyip",
      label: "anyIP",
    },
  ]);
});

test("buildRelatedTargetResolution and resolveRelatedGraphNodeId prefer relation-specific targets before generic fallbacks", () => {
  const graphNodes = [
    makeGraphNode({
      id: "node:artifact",
      label: "outreach-delegated.md",
      path: "workspace/artifacts/outreach-delegated.md",
    }),
    makeGraphNode({
      id: "node:person-fallback",
      label: "Ben Book",
    }),
    makeGraphNode({
      id: "node:graph-only",
      label: "Operations Inbox",
    }),
  ];
  const outgoingRelations = [
    makeRelation({
      relation_type: "derived_from",
      source_node_id: "memory:1",
      target_node_id: "node:artifact",
      target_label: "outreach-delegated.md",
      target_entity_key: "artifact:outreach-delegated.md",
    }),
    makeRelation({
      relation_type: "contacted_by",
      source_node_id: "memory:1",
      target_node_id: "node:person-specific",
      target_label: "Ben Book",
      target_entity_key: "person:ben-book",
    }),
  ];

  const resolution = buildRelatedTargetResolution({
    graphNodes,
    outgoingRelations,
  });

  assert.equal(
    resolveRelatedGraphNodeId(
      resolution,
      "person:ben-book",
      "Ben Book",
      "contacted_by",
    ),
    "node:person-specific",
  );
  assert.equal(
    resolveRelatedGraphNodeId(
      resolution,
      "artifact:outreach-delegated.md",
      "outreach-delegated.md",
      "derived_from",
    ),
    "node:artifact",
  );
  assert.equal(
    resolveRelatedGraphNodeId(
      resolution,
      "unknown:anyip",
      "Ben Book",
    ),
    "node:person-specific",
  );
  assert.equal(
    resolveRelatedGraphNodeId(
      resolution,
      "unknown:graph-only",
      "Operations Inbox",
    ),
    "node:graph-only",
  );
  assert.equal(
    resolveRelatedGraphNodeId(
      resolution,
      "unknown:missing",
      "Missing",
    ),
    null,
  );
  assert.deepEqual(
    resolveRelatedGraphTarget(
      resolution,
      "unknown:graph-only",
      "Operations Inbox",
    ),
    {
      nodeId: "node:graph-only",
      targetResolutionKind: "synthetic",
    },
  );
});

test("buildRelatedTargetResolution blocks missing relation targets instead of reviving them through entity or label fallbacks", () => {
  const graphNodes = [
    makeGraphNode({
      id: "node:ben-book",
      label: "Ben Book",
    }),
  ];
  const outgoingRelations = [
    makeRelation({
      relation_type: "contacted_by",
      source_node_id: "memory:1",
      target_node_id: "semantic:related:person:ben-book",
      target_label: "Ben Book",
      target_entity_key: "person:ben-book",
      target_resolution_kind: "missing",
    }),
  ];

  const resolution = buildRelatedTargetResolution({
    graphNodes,
    outgoingRelations,
  });

  assert.equal(
    resolveRelatedGraphNodeId(
      resolution,
      "person:ben-book",
      "Ben Book",
      "contacted_by",
    ),
    null,
  );
  assert.equal(
    resolveRelatedGraphNodeId(
      resolution,
      "person:ben-book",
      "Ben Book",
    ),
    null,
  );
  assert.deepEqual(
    resolveRelatedGraphTarget(
      resolution,
      "person:ben-book",
      "Ben Book",
      "contacted_by",
    ),
    {
      nodeId: null,
      targetResolutionKind: "missing",
    },
  );
});

test("resolveParsedRelatedEntities marks resolved, synthetic, and missing file related entities consistently", () => {
  const graphNodes = [
    makeGraphNode({
      id: "node:resolved",
      label: "Builder Mode",
    }),
    makeGraphNode({
      id: "node:synthetic",
      label: "Operations Inbox",
    }),
    makeGraphNode({
      id: "node:missing-fallback",
      label: "Ben Book",
    }),
  ];
  const outgoingRelations = [
    makeRelation({
      relation_type: "about",
      source_node_id: "memory:1",
      target_node_id: "node:resolved",
      target_label: "Builder Mode",
      target_entity_key: "project:entity:builder-mode",
      target_resolution_kind: "resolved",
    }),
    makeRelation({
      relation_type: "contacted_by",
      source_node_id: "memory:1",
      target_node_id: "semantic:related:person:ben-book",
      target_label: "Ben Book",
      target_entity_key: "person:ben-book",
      target_resolution_kind: "missing",
    }),
  ];

  const resolution = buildRelatedTargetResolution({
    graphNodes,
    outgoingRelations,
  });

  const entities = resolveParsedRelatedEntities(resolution, [
    { entityKey: "project:entity:builder-mode", label: "Builder Mode" },
    { entityKey: "mailbox:ops", label: "Operations Inbox" },
    { entityKey: "person:ben-book", label: "Ben Book" },
  ]);

  assert.deepEqual(entities, [
    {
      entityKey: "project:entity:builder-mode",
      label: "Builder Mode",
      nodeId: "node:resolved",
      targetResolutionKind: "resolved",
      navigable: true,
      stableKey: "project:entity:builder-mode",
    },
    {
      entityKey: "mailbox:ops",
      label: "Operations Inbox",
      nodeId: "node:synthetic",
      targetResolutionKind: "synthetic",
      navigable: true,
      stableKey: "mailbox:ops",
    },
    {
      entityKey: "person:ben-book",
      label: "Ben Book",
      nodeId: null,
      targetResolutionKind: "missing",
      navigable: false,
      stableKey: "person:ben-book",
    },
  ]);
});

test("resolveParsedRelatedRelations preserves display labels and blocks missing relation targets", () => {
  const graphNodes = [
    makeGraphNode({
      id: "node:artifact",
      label: "notion-related-pages.md",
    }),
    makeGraphNode({
      id: "node:anyip",
      label: "anyIP",
    }),
  ];
  const outgoingRelations = [
    makeRelation({
      relation_type: "derived_from",
      source_node_id: "memory:1",
      target_node_id: "node:artifact",
      target_label: "notion-related-pages.md",
      target_entity_key: "artifact:output:output-1",
      target_resolution_kind: "resolved",
    }),
    makeRelation({
      relation_type: "works_at",
      source_node_id: "memory:1",
      target_node_id: "node:anyip",
      target_label: "anyIP",
      target_entity_key: "organization:anyip",
      target_resolution_kind: "synthetic",
    }),
    makeRelation({
      relation_type: "contacted_by",
      source_node_id: "memory:1",
      target_node_id: "semantic:related:person:ben-book",
      target_label: "Ben Book",
      target_entity_key: "person:ben-book",
      target_resolution_kind: "missing",
    }),
  ];

  const resolution = buildRelatedTargetResolution({
    graphNodes,
    outgoingRelations,
  });

  const relations = resolveParsedRelatedRelations(resolution, [
    {
      relationType: "derived_from",
      entityKey: "artifact:output:output-1",
      label: "notion-related-pages.md",
    },
    {
      relationType: "works_at",
      entityKey: "organization:anyip",
      label: null,
    },
    {
      relationType: "contacted_by",
      entityKey: "person:ben-book",
      label: "Ben Book",
    },
  ]);

  assert.deepEqual(relations, [
    {
      relationType: "derived_from",
      entityKey: "artifact:output:output-1",
      label: "notion-related-pages.md",
      nodeId: "node:artifact",
      targetResolutionKind: "resolved",
      displayLabel: "notion-related-pages.md",
      navigable: true,
      stableKey: "derived_from:artifact:output:output-1",
    },
    {
      relationType: "works_at",
      entityKey: "organization:anyip",
      label: null,
      nodeId: "node:anyip",
      targetResolutionKind: "synthetic",
      displayLabel: "organization:anyip",
      navigable: true,
      stableKey: "works_at:organization:anyip",
    },
    {
      relationType: "contacted_by",
      entityKey: "person:ben-book",
      label: "Ben Book",
      nodeId: null,
      targetResolutionKind: "missing",
      displayLabel: "Ben Book",
      navigable: false,
      stableKey: "contacted_by:person:ben-book",
    },
  ]);
});

test("resolveParsedRelatedRelations keeps same-tree resolved owner targets navigable", () => {
  const graphNodes = [
    makeGraphNode({
      id: "semantic:interaction:topic:label-590dab003920:tree",
      tree_id: "interaction:topic:label-590dab003920",
      kind: "tree",
      label: "渠道设计阶段",
      path: "workspace/knowledge/topic-label-590dab003920/content.md",
    }),
  ];
  const outgoingRelations = [
    makeRelation({
      relation_type: "about",
      source_node_id: "memory:1",
      target_node_id: "semantic:interaction:topic:label-590dab003920:tree",
      target_label: "渠道设计阶段",
      target_tree_id: "interaction:topic:label-590dab003920",
      target_entity_key: "topic:entity:interaction:topic:label-590dab003920",
      target_resolution_kind: "resolved",
    }),
  ];

  const resolution = buildRelatedTargetResolution({
    graphNodes,
    outgoingRelations,
  });

  const relations = resolveParsedRelatedRelations(resolution, [
    {
      relationType: "about",
      entityKey: "topic:entity:interaction:topic:label-590dab003920",
      label: "渠道设计阶段",
    },
  ]);
  const entities = resolveParsedRelatedEntities(resolution, [
    {
      entityKey: "topic:entity:interaction:topic:label-590dab003920",
      label: "渠道设计阶段",
    },
  ]);

  assert.deepEqual(relations, [
    {
      relationType: "about",
      entityKey: "topic:entity:interaction:topic:label-590dab003920",
      label: "渠道设计阶段",
      nodeId: "semantic:interaction:topic:label-590dab003920:tree",
      targetResolutionKind: "resolved",
      displayLabel: "渠道设计阶段",
      navigable: true,
      stableKey: "about:topic:entity:interaction:topic:label-590dab003920",
    },
  ]);
  assert.deepEqual(entities, [
    {
      entityKey: "topic:entity:interaction:topic:label-590dab003920",
      label: "渠道设计阶段",
      nodeId: "semantic:interaction:topic:label-590dab003920:tree",
      targetResolutionKind: "resolved",
      navigable: true,
      stableKey: "topic:entity:interaction:topic:label-590dab003920",
    },
  ]);
});

test("findGraphNodeForPath resolves the matching loaded graph node for a file path", () => {
  const graphNodes = [
    makeGraphNode({
      id: "node:1",
      label: "Root",
      path: null,
    }),
    makeGraphNode({
      id: "node:2",
      label: "AWS budget alert",
      path: "workspace/systems/aws-budget-alert/content.md",
    }),
  ];

  assert.equal(
    findGraphNodeForPath(
      graphNodes,
      "workspace/systems/aws-budget-alert/content.md",
    )?.id,
    "node:2",
  );
  assert.equal(findGraphNodeForPath(graphNodes, "workspace/missing.md"), null);
});

test("isNavigableMemoryRelationTarget only allows navigation for resolved and synthetic targets", () => {
  assert.equal(isNavigableMemoryRelationTarget("resolved"), true);
  assert.equal(isNavigableMemoryRelationTarget("synthetic"), true);
  assert.equal(isNavigableMemoryRelationTarget("missing"), false);
  assert.equal(isNavigableMemoryRelationTarget(null), false);
});
