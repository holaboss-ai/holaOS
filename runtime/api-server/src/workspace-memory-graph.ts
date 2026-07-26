import type { RuntimeStateStore } from "@holaboss/runtime-state-store";

import {
  accessibleIntegrationTreesForWorkspace,
  rebuildAllIntegrationTrees,
} from "./integration-memory.js";
import {
  ensureWorkspaceInteractionSemanticTreesMigrated,
  rebuildAllInteractionTrees,
} from "./interaction-memory.js";
import {
  ensureWorkspaceArtifactRelationsBackfilled,
  listWorkspaceAttachmentDocumentTrees,
  listWorkspaceImageUrlDocumentTrees,
  listWorkspaceOutputDocumentTrees,
  syncWorkspaceArtifactRelations,
  listWorkspaceToolResultDocumentTrees,
} from "./workspace-attachment-memory.js";
import { ensureWorkspaceMemoryReadModelRepaired } from "./workspace-memory-repair.js";

type WorkspaceGraphTreeDescriptor = {
  treeId: string;
  semanticCategory: "workspace";
  sourceKind: "interaction" | "integration" | "attachment" | "image_url" | "tool_result" | "output_artifact";
};

export interface WorkspaceMemoryGraphStats {
  roots: number;
  leaves: number;
  semanticNodes: number;
  semanticInternalNodes: number;
  semanticEdges: number;
  semanticRelations: number;
}

export interface RebuiltWorkspaceMemoryGraph {
  roots: number;
  summaries: number;
}

function listWorkspaceGraphTreeDescriptors(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): WorkspaceGraphTreeDescriptor[] {
  ensureWorkspaceInteractionSemanticTreesMigrated({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  ensureWorkspaceArtifactRelationsBackfilled({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const interactionDescriptors: WorkspaceGraphTreeDescriptor[] = params.store
    .listInteractionEntities({
      workspaceId: params.workspaceId,
      status: "active",
      includeSystem: true,
      limit: 10_000,
      offset: 0,
    })
    .map((entity) => ({
      treeId: entity.entityId,
      semanticCategory: "workspace" as const,
      sourceKind: "interaction" as const,
    }));
  const integrationDescriptors: WorkspaceGraphTreeDescriptor[] = accessibleIntegrationTreesForWorkspace({
    store: params.store,
    workspaceId: params.workspaceId,
  }).map((tree) => ({
    treeId: tree.treeId,
    semanticCategory: "workspace" as const,
    sourceKind: "integration" as const,
  }));
  const attachmentDescriptors: WorkspaceGraphTreeDescriptor[] = listWorkspaceAttachmentDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  }).map((attachment) => ({
    treeId: attachment.treeId,
    semanticCategory: "workspace" as const,
    sourceKind: "attachment" as const,
  }));
  const imageUrlDescriptors: WorkspaceGraphTreeDescriptor[] = listWorkspaceImageUrlDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  }).map((imageUrlArtifact) => ({
    treeId: imageUrlArtifact.treeId,
    semanticCategory: "workspace" as const,
    sourceKind: "image_url" as const,
  }));
  const toolResultDescriptors: WorkspaceGraphTreeDescriptor[] = listWorkspaceToolResultDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  }).map((toolResult) => ({
    treeId: toolResult.treeId,
    semanticCategory: "workspace" as const,
    sourceKind: "tool_result" as const,
  }));
  const outputArtifactDescriptors: WorkspaceGraphTreeDescriptor[] = listWorkspaceOutputDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  }).map((outputArtifact) => ({
    treeId: outputArtifact.treeId,
    semanticCategory: "workspace" as const,
    sourceKind: "output_artifact" as const,
  }));
  return [
    ...interactionDescriptors,
    ...integrationDescriptors,
    ...attachmentDescriptors,
    ...imageUrlDescriptors,
    ...toolResultDescriptors,
    ...outputArtifactDescriptors,
  ];
}

function countLegacyLeavesForTree(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  descriptor: WorkspaceGraphTreeDescriptor;
}): number {
  if (params.descriptor.sourceKind === "interaction") {
    return params.store.listInteractionLeaves({
      workspaceId: params.workspaceId,
      entityId: params.descriptor.treeId,
      status: "active",
      limit: 10_000,
      offset: 0,
    }).length;
  }
  if (
    params.descriptor.sourceKind === "attachment"
    || params.descriptor.sourceKind === "image_url"
    || params.descriptor.sourceKind === "tool_result"
    || params.descriptor.sourceKind === "output_artifact"
  ) {
    return 0;
  }
  // workspace-removal Piece 5.7: the integration graph is control-plane-only; the
  // store ignores any workspaceId, so it is not threaded.
  return params.store.listIntegrationLeaves({
    treeId: params.descriptor.treeId,
    status: "active",
    limit: 10_000,
    offset: 0,
  }).length;
}

function countSemanticEdgesForTree(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId: string;
  semanticCategory: "workspace";
}): number {
  return params.store.listSemanticMemoryNodes({
    category: params.semanticCategory,
    workspaceId: params.workspaceId,
    treeId: params.treeId,
    nodeClass: "semantic",
    status: "active",
    limit: 10_000,
    offset: 0,
  }).reduce(
    (count, node) =>
      count + params.store.listSemanticMemoryChildren({
        category: params.semanticCategory,
        workspaceId: params.workspaceId,
        treeId: params.treeId,
        parentNodeId: node.nodeId,
      }).length,
    0,
  );
}

export function summarizeWorkspaceMemoryGraph(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): WorkspaceMemoryGraphStats {
  const descriptors = listWorkspaceGraphTreeDescriptors(params);
  let semanticNodes = 0;
  let semanticInternalNodes = 0;
  let semanticEdges = 0;
  let semanticRelations = 0;
  let leaves = 0;

  for (const descriptor of descriptors) {
    const nodes = params.store.listSemanticMemoryNodes({
      category: descriptor.semanticCategory,
      workspaceId: params.workspaceId,
      treeId: descriptor.treeId,
      status: "active",
      limit: 10_000,
      offset: 0,
    });
    const semanticLeafCount = nodes.filter((node) => node.nodeClass === "leaf").length;
    semanticNodes += nodes.length;
    leaves += Math.max(
      semanticLeafCount,
      countLegacyLeavesForTree({
        store: params.store,
        workspaceId: params.workspaceId,
        descriptor,
      }),
    );
    semanticInternalNodes += nodes.filter((node) => node.nodeClass === "semantic").length;
    semanticEdges += countSemanticEdgesForTree({
      store: params.store,
      workspaceId: params.workspaceId,
      treeId: descriptor.treeId,
      semanticCategory: descriptor.semanticCategory,
    });
    semanticRelations += params.store.listSemanticMemoryRelations({
      category: descriptor.semanticCategory,
      workspaceId: params.workspaceId,
      treeId: descriptor.treeId,
      limit: 10_000,
    }).length;
  }

  return {
    roots: descriptors.length,
    leaves,
    semanticNodes,
    semanticInternalNodes,
    semanticEdges,
    semanticRelations,
  };
}

export async function rebuildWorkspaceMemoryGraph(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  selectedModel?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
}): Promise<RebuiltWorkspaceMemoryGraph> {
  await ensureWorkspaceMemoryReadModelRepaired({
    store: params.store,
    workspaceId: params.workspaceId,
    selectedModel: params.selectedModel ?? null,
  });
  const interaction = await rebuildAllInteractionTrees({
    store: params.store,
    workspaceId: params.workspaceId,
    selectedModel: params.selectedModel ?? null,
    sessionId: params.sessionId ?? null,
    inputId: params.inputId ?? null,
  });
  const integration = await rebuildAllIntegrationTrees({
    store: params.store,
    workspaceId: params.workspaceId,
    selectedModel: params.selectedModel ?? null,
    sessionId: params.sessionId ?? null,
    inputId: params.inputId ?? null,
  });
  syncWorkspaceArtifactRelations({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const attachments = listWorkspaceAttachmentDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const imageUrls = listWorkspaceImageUrlDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const toolResults = listWorkspaceToolResultDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const outputArtifacts = listWorkspaceOutputDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  return {
    roots: interaction.entities + integration.trees + attachments.length + imageUrls.length + toolResults.length + outputArtifacts.length,
    summaries: interaction.summaries + integration.summaries,
  };
}
