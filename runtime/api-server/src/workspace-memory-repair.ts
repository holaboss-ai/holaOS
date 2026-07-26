import type { RuntimeStateStore } from "@holaboss/runtime-state-store";

import {
  ensureWorkspaceInteractionLeafQualityRepaired,
  ensureWorkspaceInteractionUncategorizedLeavesReclassified,
} from "./interaction-memory.js";
import { ensureWorkspaceArtifactRelationsBackfilled } from "./workspace-attachment-memory.js";

const workspaceMemoryReadModelRepairOperations = new Map<string, Promise<void>>();

function workspaceMemoryReadModelRepairKey(params: {
  workspaceId: string;
  selectedModel?: string | null;
}): string {
  const selectedModel = (params.selectedModel ?? "").trim();
  return `${params.workspaceId}\u0000${selectedModel}`;
}

export async function withWorkspaceMemoryReadModelRepairOperation(
  params: {
    workspaceId: string;
    selectedModel?: string | null;
  },
  operation: () => Promise<void>,
): Promise<void> {
  const key = workspaceMemoryReadModelRepairKey(params);
  const inFlight = workspaceMemoryReadModelRepairOperations.get(key);
  if (inFlight) {
    return await inFlight;
  }
  const promise = (async () => await operation())();
  workspaceMemoryReadModelRepairOperations.set(key, promise);
  try {
    return await promise;
  } finally {
    if (workspaceMemoryReadModelRepairOperations.get(key) === promise) {
      workspaceMemoryReadModelRepairOperations.delete(key);
    }
  }
}

export async function ensureWorkspaceMemoryReadModelRepaired(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  selectedModel?: string | null;
}): Promise<void> {
  await withWorkspaceMemoryReadModelRepairOperation(
    {
      workspaceId: params.workspaceId,
      selectedModel: params.selectedModel ?? null,
    },
    async () => {
      ensureWorkspaceArtifactRelationsBackfilled({
        store: params.store,
        workspaceId: params.workspaceId,
      });
      await ensureWorkspaceInteractionUncategorizedLeavesReclassified({
        store: params.store,
        workspaceId: params.workspaceId,
      });
      await ensureWorkspaceInteractionLeafQualityRepaired({
        store: params.store,
        workspaceId: params.workspaceId,
        selectedModel: params.selectedModel ?? null,
      });
    },
  );
}
