import type { RuntimeStateStore } from "@holaboss/runtime-state-store";

import {
  listWorkspaceAttachmentDocumentTrees,
  listWorkspaceImageUrlDocumentTrees,
  listWorkspaceOutputDocumentTrees,
  listWorkspaceToolResultDocumentTrees,
} from "./workspace-attachment-memory.js";
import { buildWorkspaceRelatedEntityResolver, type WorkspaceRelatedEntityResolver } from "./workspace-related-entity-resolver.js";

export function createWorkspaceRelatedEntityResolverFromStore(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): WorkspaceRelatedEntityResolver {
  const outputTargets = listWorkspaceOutputDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const existingOutputIds = new Set(outputTargets.map((descriptor) => descriptor.outputId));
  const unresolvedOutputTargets = typeof (params.store as { listOutputs?: unknown }).listOutputs === "function"
    ? params.store.listOutputs({
      workspaceId: params.workspaceId,
      limit: 10_000,
      offset: 0,
    })
      .filter((output) => output.status !== "deleted" && !existingOutputIds.has(output.id))
      .map((output) => ({
        treeId: null,
        rootNodeId: null,
        title: output.title || output.filePath || output.id,
        outputId: output.id,
        outputType: output.outputType,
        filePath: output.filePath,
        artifactId: output.artifactId,
        sourceTurnInputId: output.inputId,
        observedAt: output.updatedAt ?? output.createdAt ?? new Date(0).toISOString(),
      }))
    : [];
  return buildWorkspaceRelatedEntityResolver({
    interactionEntities: params.store.listInteractionEntities({
      workspaceId: params.workspaceId,
      status: "active",
      includeSystem: true,
      limit: 10_000,
      offset: 0,
    }),
    attachmentTargets: listWorkspaceAttachmentDocumentTrees({
      store: params.store,
      workspaceId: params.workspaceId,
    }),
    imageUrlTargets: listWorkspaceImageUrlDocumentTrees({
      store: params.store,
      workspaceId: params.workspaceId,
    }),
    toolResultTargets: listWorkspaceToolResultDocumentTrees({
      store: params.store,
      workspaceId: params.workspaceId,
    }),
    outputTargets: [
      ...outputTargets,
      ...unresolvedOutputTargets,
    ],
  });
}
