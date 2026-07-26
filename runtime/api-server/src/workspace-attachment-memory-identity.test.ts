import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactContextsForSourceTurnInput,
  resolveWorkspaceArtifactRelationIdentity,
  workspaceArtifactBackfillStateToken,
} from "./workspace-attachment-memory.js";
import { buildWorkspaceRelatedEntityResolver } from "./workspace-related-entity-resolver.js";
import { createWorkspaceRelatedEntityResolverFromStore } from "./workspace-related-entity-resolver-store.js";

test("resolveWorkspaceArtifactRelationIdentity returns canonical output identity for exact output targets", () => {
  const resolver = buildWorkspaceRelatedEntityResolver({
    interactionEntities: [],
    outputTargets: [],
  });

  const result = resolveWorkspaceArtifactRelationIdentity({
    relationType: "forwarded_from",
    resolver,
    artifact: {
      treeId: "output-artifact:report-1",
      nodeId: "output-artifact:report-1:root",
      title: "notion-related-pages.md",
      outputId: "output-report-1",
    },
  });

  assert.deepEqual(result, {
    entityKey: "artifact:output:output-report-1",
    resolvedTargetKind: "resolved",
  });
});

test("resolveWorkspaceArtifactRelationIdentity resolves title-only artifact targets through the resolver when they match the same tree", () => {
  const resolver = buildWorkspaceRelatedEntityResolver({
    interactionEntities: [],
    outputTargets: [
      {
        treeId: "output-artifact:report-1",
        rootNodeId: "output-artifact:report-1:root",
        title: "notion-related-pages.md",
        outputId: "output-report-1",
        outputType: "document",
        filePath: "outputs/notion-related-pages.md",
        artifactId: "artifact-1",
        sourceTurnInputId: "turn-1",
        observedAt: "2026-06-05T00:00:00.000Z",
      },
    ],
  });

  const result = resolveWorkspaceArtifactRelationIdentity({
    relationType: "derived_from",
    resolver,
    artifact: {
      treeId: "output-artifact:report-1",
      nodeId: "output-artifact:report-1:root",
      title: "notion-related-pages.md",
      sourceTurnInputId: "turn-1",
    },
  });

  assert.deepEqual(result, {
    entityKey: "artifact:output:output-report-1",
    resolvedTargetKind: "resolved",
  });
});

test("resolveWorkspaceArtifactRelationIdentity falls back to a synthetic title key when resolver alias matches a different artifact", () => {
  const resolver = buildWorkspaceRelatedEntityResolver({
    interactionEntities: [],
    outputTargets: [
      {
        treeId: "output-artifact:report-1",
        rootNodeId: "output-artifact:report-1:root",
        title: "notion-related-pages.md",
        outputId: "output-report-1",
        outputType: "document",
        filePath: "outputs/notion-related-pages.md",
        artifactId: "artifact-1",
        sourceTurnInputId: "turn-older",
        observedAt: "2026-06-05T00:00:00.000Z",
      },
    ],
  });

  const result = resolveWorkspaceArtifactRelationIdentity({
    relationType: "derived_from",
    resolver,
    artifact: {
      treeId: "output-artifact:report-2",
      nodeId: "output-artifact:report-2:root",
      title: "notion-related-pages.md",
      sourceTurnInputId: "turn-newer",
    },
  });

  assert.deepEqual(result, {
    entityKey: "artifact:notion-related-pages.md",
    resolvedTargetKind: "synthetic",
  });
});

test("buildWorkspaceRelatedEntityResolver prefers the earliest same-turn attachment when duplicate titles collide", () => {
  const resolver = buildWorkspaceRelatedEntityResolver({
    interactionEntities: [],
    attachmentTargets: [
      {
        treeId: "attachment-tree-2",
        rootNodeId: "attachment-root-2",
        title: "brief.txt",
        attachmentId: "att-2",
        workspacePath: ".holaboss/input-attachments/batch-1/team-a/brief.txt",
        sourceTurnInputId: "turn-1",
        sourceTurnInputPosition: 1,
        observedAt: "2026-06-05T00:00:00.000Z",
      },
      {
        treeId: "attachment-tree-1",
        rootNodeId: "attachment-root-1",
        title: "brief.txt",
        attachmentId: "att-1",
        workspacePath: ".holaboss/input-attachments/batch-1/team-b/brief.txt",
        sourceTurnInputId: "turn-1",
        sourceTurnInputPosition: 0,
        observedAt: "2026-06-05T00:00:00.000Z",
      },
    ],
  });

  const resolved = resolver.resolve({
    entityType: "artifact",
    label: "brief.txt",
    sourceTurnInputId: "turn-1",
  });

  assert.equal(resolved?.entityKey, "artifact:attachment:att-1");
  assert.equal(resolved?.targetTreeId, "attachment-tree-1");
});

test("buildWorkspaceRelatedEntityResolver prefers the earliest same-turn referenced image when duplicate titles collide", () => {
  const resolver = buildWorkspaceRelatedEntityResolver({
    interactionEntities: [],
    imageUrlTargets: [
      {
        treeId: "image-tree-2",
        rootNodeId: "image-root-2",
        title: "reference.png",
        imageUrl: "file:///tmp/b/reference.png",
        sourceTurnInputId: "turn-1",
        sourceTurnInputPosition: 1,
        observedAt: "2026-06-05T00:00:00.000Z",
      },
      {
        treeId: "image-tree-1",
        rootNodeId: "image-root-1",
        title: "reference.png",
        imageUrl: "file:///tmp/a/reference.png",
        sourceTurnInputId: "turn-1",
        sourceTurnInputPosition: 0,
        observedAt: "2026-06-05T00:00:00.000Z",
      },
    ],
  });

  const resolved = resolver.resolve({
    entityType: "artifact",
    label: "reference.png",
    sourceTurnInputId: "turn-1",
  });

  assert.match(resolved?.entityKey ?? "", /^artifact:image-url:[0-9a-f]{24}$/);
  assert.equal(resolved?.targetTreeId, "image-tree-1");
});

test("workspaceArtifactBackfillStateToken reflects the current per-source backfill markers", () => {
  const metadata = new Map<string, string>([
    ["workspace_artifact_relation_backfill_v1_complete", "true"],
    ["workspace_artifact_relation_backfill_v2_complete", "true"],
    ["workspace_artifact_source_turn_input_position_backfill_v1_complete", "false"],
    ["workspace_tool_result_artifact_tree_backfill_v1_complete", "false"],
    ["workspace_attachment_artifact_tree_backfill_v1_complete", "true"],
    ["workspace_image_url_artifact_tree_backfill_v1_complete", "false"],
    ["workspace_output_artifact_tree_backfill_v1_complete", "true"],
  ]);
  const store = {
    getWorkspaceRuntimeMetadata(params: { workspaceId: string; key: string }) {
      assert.equal(params.workspaceId, "workspace-1");
      return metadata.get(params.key) ?? null;
    },
  };

  assert.equal(
    workspaceArtifactBackfillStateToken({
      store: store as never,
      workspaceId: "workspace-1",
    }),
    "relations:1|source_positions:0|tool_results:0|attachments:1|image_urls:0|outputs:1",
  );
});

test("artifactContextsForSourceTurnInput returns output artifact contexts from backfilled trees without needing a turn result row", () => {
  const store = {
    listSemanticMemoryNodes(params: {
      category: "workspace";
      workspaceId: string;
      nodeKind?: string;
      status?: string;
      limit?: number;
      offset?: number;
    }) {
      assert.equal(params.category, "workspace");
      assert.equal(params.workspaceId, "workspace-1");
      if (params.nodeKind !== "output_document") {
        return [];
      }
      return [
        {
          workspaceId: "workspace-1",
          category: "workspace",
          treeId: "output-tree-1",
          nodeId: "output-root-1",
          nodeClass: "semantic",
          nodeKind: "output_document",
          sourceLeafId: null,
          path: "semantic/workspace/artifacts/outputs/legacy-handoff-output-1/content.md",
          title: "legacy-handoff.md",
          summary: "Legacy handoff output artifact.",
          bodySha256: "sha-output-root",
          childCount: 1,
          observedAt: "2026-06-05T00:00:00.000Z",
          status: "active",
          isMaterialized: false,
          metadata: {
            output_id: "output-legacy-handoff-1",
            output_type: "document",
            file_path: "outputs/reports/legacy-handoff.md",
            artifact_id: "artifact-legacy-handoff-1",
            source_turn_input_id: "input-legacy-output-1",
          },
          createdAt: "2026-06-05T00:00:00.000Z",
          updatedAt: "2026-06-05T00:00:00.000Z",
        },
      ];
    },
    listSemanticMemorySearchDocs(params: {
      category: "workspace";
      workspaceId: string;
      treeId?: string;
      nodeClass?: string;
      status?: string;
      limit?: number;
      offset?: number;
    }) {
      assert.equal(params.category, "workspace");
      assert.equal(params.workspaceId, "workspace-1");
      assert.equal(params.treeId, "output-tree-1");
      return [
        {
          workspaceId: "workspace-1",
          category: "workspace",
          treeId: "output-tree-1",
          nodeId: "output-root-1:chunk-1",
          nodeClass: "leaf",
          nodeKind: "output_chunk",
          path: "semantic/workspace/artifacts/outputs/legacy-handoff-output-1/chunks/chunk-001/content.md",
          title: "legacy-handoff.md chunk 1",
          summary: "Chunk 1",
          bodyText: "Builder Mode rollout owner is Nina Patel. Approval contact is Dana Moss.",
          excerpt: "Builder Mode rollout owner is Nina Patel.",
          observedAt: "2026-06-05T00:00:00.000Z",
          status: "active",
          updatedAt: "2026-06-05T00:00:00.000Z",
        },
      ];
    },
  };

  const contexts = artifactContextsForSourceTurnInput({
    store: store as never,
    workspaceId: "workspace-1",
    sourceTurnInputId: "input-legacy-output-1",
  });

  assert.deepEqual(contexts, [
    {
      sourceKind: "output_artifact",
      treeId: "output-tree-1",
      title: "legacy-handoff.md",
      provider: null,
      accountNamespace: null,
      canonicalEntityKey: "artifact:output:output-legacy-handoff-1",
      excerpts: [
        "Builder Mode rollout owner is Nina Patel. Approval contact is Dana Moss.",
      ],
    },
  ]);
});

test("createWorkspaceRelatedEntityResolverFromStore resolves output rows even before an output artifact tree exists", () => {
  const store = {
    listInteractionEntities() {
      return [];
    },
    listSemanticMemoryNodes(params: {
      category: "workspace";
      workspaceId: string;
      nodeKind?: string;
      status?: string;
      limit?: number;
      offset?: number;
    }) {
      assert.equal(params.category, "workspace");
      assert.equal(params.workspaceId, "workspace-1");
      return [];
    },
    listOutputs(params: {
      workspaceId: string;
      limit?: number;
      offset?: number;
    }) {
      assert.equal(params.workspaceId, "workspace-1");
      return [
        {
          id: "output-unmaterialized-1",
          workspaceId: "workspace-1",
          outputType: "document",
          title: "legacy-handoff.md",
          status: "completed",
          filePath: "outputs/reports/legacy-handoff.md",
          artifactId: "artifact-legacy-handoff-1",
          inputId: "input-legacy-output-1",
          sessionId: "session-main",
          createdAt: "2026-06-05T00:00:00.000Z",
          updatedAt: "2026-06-05T00:00:00.000Z",
        },
      ];
    },
  };

  const resolver = createWorkspaceRelatedEntityResolverFromStore({
    store: store as never,
    workspaceId: "workspace-1",
  });

  const resolved = resolver.resolve({
    entityType: "artifact",
    label: "legacy-handoff.md",
    sourceTurnInputId: "input-legacy-output-1",
  });

  assert.deepEqual(resolved, {
    entityType: "artifact",
    entityKey: "artifact:output:output-unmaterialized-1",
    label: "legacy-handoff.md",
    resolutionKind: "output_artifact",
    targetTreeId: null,
    targetNodeId: null,
    sourceTurnInputId: "input-legacy-output-1",
    sourceTurnInputPosition: null,
    aliasTexts: [
      "legacy-handoff.md",
      "outputs/reports/legacy-handoff.md",
      "artifact-legacy-handoff-1",
      "output-unmaterialized-1",
      "artifact:legacy-handoff.md",
    ],
    observedAt: "2026-06-05T00:00:00.000Z",
  });
});
