import type { RuntimeStateStore } from "@holaboss/runtime-state-store";

import {
  type IntegrationLeafCandidate,
  persistIntegrationCandidate,
  rebuildIntegrationTree,
} from "./integration-memory.js";
import {
  type InteractionLeafCandidate,
  persistInteractionCandidate,
  rebuildInteractionEntityTree,
} from "./interaction-memory.js";
import type { MemoryModelClientConfig } from "./memory-model-client.js";

const WORKSPACE_TREE_REBUILD_DEBOUNCE_MS = 75;
export type WorkspaceMemoryTreeSourceKind = "interaction" | "integration";

interface PendingWorkspaceMemoryTreeRebuild {
  key: string;
  store: RuntimeStateStore;
  workspaceId: string;
  treeId: string;
  treeSourceKind: WorkspaceMemoryTreeSourceKind;
  summaryModelClient: MemoryModelClientConfig | null;
  embeddingClient: MemoryModelClientConfig | null;
  debounceMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  dirty: boolean;
  settled: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const pendingWorkspaceMemoryTreeRebuilds = new Map<string, PendingWorkspaceMemoryTreeRebuild>();

export interface PersistedWorkspaceMemoryCandidateResult {
  outcome: "noop_duplicate" | "created" | "superseding";
  treeId: string;
  path: string;
  changed: boolean;
}

function workspaceMemoryTreeRebuildKey(
  workspaceId: string,
  treeSourceKind: WorkspaceMemoryTreeSourceKind,
  treeId: string,
): string {
  return `${workspaceId}::${treeSourceKind}::${treeId}`;
}

type PersistInteractionWorkspaceMemoryCandidateParams = {
  store: RuntimeStateStore;
  workspaceId: string;
  sourceKind?: "interaction";
  candidate: InteractionLeafCandidate;
  modelClient?: MemoryModelClientConfig | null;
  embeddingClient?: MemoryModelClientConfig | null;
};

type PersistIntegrationWorkspaceMemoryCandidateParams = {
  store: RuntimeStateStore;
  workspaceId: string;
  sourceKind: "integration";
  candidate: IntegrationLeafCandidate;
  embeddingClient?: MemoryModelClientConfig | null;
};

export async function persistWorkspaceMemoryCandidate(
  params: PersistInteractionWorkspaceMemoryCandidateParams | PersistIntegrationWorkspaceMemoryCandidateParams,
): Promise<PersistedWorkspaceMemoryCandidateResult> {
  if (params.sourceKind === "integration") {
    const persisted = await persistIntegrationCandidate({
      store: params.store,
      workspaceId: params.workspaceId,
      candidate: params.candidate,
      embeddingClient: params.embeddingClient ?? null,
    });
    return {
      outcome: persisted.outcome,
      treeId: persisted.tree.treeId,
      path: persisted.leaf.path,
      changed: persisted.outcome !== "noop_duplicate",
    };
  }
  const persisted = await persistInteractionCandidate({
    store: params.store,
    workspaceId: params.workspaceId,
    candidate: params.candidate,
    modelClient: params.modelClient ?? null,
    embeddingClient: params.embeddingClient ?? null,
  });
  return {
    outcome: persisted.outcome,
    treeId: persisted.entity.entityId,
    path: persisted.leaf.path,
    changed: persisted.changed,
  };
}

type QueueInteractionWorkspaceMemoryTreeRebuildParams = {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId: string;
  treeSourceKind?: "interaction";
  summaryModelClient?: MemoryModelClientConfig | null;
  embeddingClient?: MemoryModelClientConfig | null;
  debounceMs?: number;
};

type QueueIntegrationWorkspaceMemoryTreeRebuildParams = {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId: string;
  treeSourceKind: "integration";
  summaryModelClient?: MemoryModelClientConfig | null;
  embeddingClient?: MemoryModelClientConfig | null;
  debounceMs?: number;
};

export function queueWorkspaceMemoryTreeRebuild(
  params: QueueInteractionWorkspaceMemoryTreeRebuildParams | QueueIntegrationWorkspaceMemoryTreeRebuildParams,
): Promise<void> {
  const treeSourceKind = params.treeSourceKind ?? "interaction";
  const key = workspaceMemoryTreeRebuildKey(params.workspaceId, treeSourceKind, params.treeId);
  let pending = pendingWorkspaceMemoryTreeRebuilds.get(key) ?? null;
  if (!pending) {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const settled = new Promise<void>((innerResolve, innerReject) => {
      resolve = innerResolve;
      reject = innerReject;
    });
    pending = {
      key,
      store: params.store,
      workspaceId: params.workspaceId,
      treeId: params.treeId,
      treeSourceKind,
      summaryModelClient: params.summaryModelClient ?? null,
      embeddingClient: params.embeddingClient ?? null,
      debounceMs: Math.max(0, params.debounceMs ?? WORKSPACE_TREE_REBUILD_DEBOUNCE_MS),
      timer: null,
      running: false,
      dirty: true,
      settled,
      resolve,
      reject,
    };
    void settled.catch(() => undefined);
    pendingWorkspaceMemoryTreeRebuilds.set(key, pending);
  } else {
    pending.store = params.store;
    pending.treeSourceKind = treeSourceKind;
    pending.summaryModelClient = params.summaryModelClient ?? pending.summaryModelClient ?? null;
    pending.embeddingClient = params.embeddingClient ?? pending.embeddingClient ?? null;
    pending.debounceMs = Math.max(0, params.debounceMs ?? pending.debounceMs);
    pending.dirty = true;
  }

  if (!pending.running) {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    pending.timer = setTimeout(() => {
      pending!.timer = null;
      void runQueuedWorkspaceMemoryTreeRebuild(pending!);
    }, pending.debounceMs);
  }
  return pending.settled;
}

async function runQueuedWorkspaceMemoryTreeRebuild(
  pending: PendingWorkspaceMemoryTreeRebuild,
): Promise<void> {
  if (pending.running) {
    return;
  }
  pending.running = true;
  try {
    while (pending.dirty) {
      pending.dirty = false;
      if (pending.treeSourceKind === "integration") {
        await rebuildIntegrationTree({
          store: pending.store,
          workspaceId: pending.workspaceId,
          treeId: pending.treeId,
          embeddingClient: pending.embeddingClient,
        });
      } else {
        await rebuildInteractionEntityTree({
          store: pending.store,
          workspaceId: pending.workspaceId,
          entityId: pending.treeId,
          summaryModelClient: pending.summaryModelClient,
          embeddingClient: pending.embeddingClient,
        });
      }
    }
    pending.resolve();
  } catch (error) {
    pending.reject(error);
  } finally {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    pending.running = false;
    pendingWorkspaceMemoryTreeRebuilds.delete(pending.key);
  }
}

export async function waitForPendingWorkspaceMemoryTreeRebuilds(params?: {
  workspaceId?: string | null;
  treeIds?: string[] | null;
  treeSourceKind?: WorkspaceMemoryTreeSourceKind | null;
}): Promise<void> {
  const normalizedTreeIds = params?.treeIds
    ? new Set(params.treeIds.map((value) => value.trim()).filter(Boolean))
    : null;
  while (true) {
    const pending = [...pendingWorkspaceMemoryTreeRebuilds.values()].filter((candidate) => {
      if (params?.workspaceId && candidate.workspaceId !== params.workspaceId) {
        return false;
      }
      if (normalizedTreeIds && !normalizedTreeIds.has(candidate.treeId)) {
        return false;
      }
      if (params?.treeSourceKind && candidate.treeSourceKind !== params.treeSourceKind) {
        return false;
      }
      return true;
    });
    if (pending.length === 0) {
      return;
    }
    await Promise.all(pending.map((candidate) => candidate.settled));
  }
}
