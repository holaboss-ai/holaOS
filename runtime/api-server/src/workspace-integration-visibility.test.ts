import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  IntegrationTreeRecord,
  RuntimeStateStore,
  SemanticMemoryNodeRecord,
} from "@holaboss/runtime-state-store";

import {
  ensureWorkspaceIntegrationRootsMigrated,
  visibleIntegrationTreesForWorkspace,
} from "./workspace-integration-visibility.js";

function makeTree(params: {
  treeId: string;
  provider: string;
  accountKey: string;
  accountLabel: string;
  status?: "active" | "archived";
}): IntegrationTreeRecord {
  return {
    workspaceId: "workspace-1",
    treeId: params.treeId,
    provider: params.provider,
    ownerUserId: "user-1",
    accountNamespace: params.accountKey,
    accountDisplayName: params.accountLabel,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    slug: `${params.provider}-${params.accountKey.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
    summary: `${params.accountLabel} memory.`,
    status: params.status ?? "active",
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
  };
}

function makeStore(params: {
  trees: IntegrationTreeRecord[];
  semanticNodes?: SemanticMemoryNodeRecord[];
}): RuntimeStateStore {
  const metadata = new Map<string, string>();
  const semanticNodes = [...(params.semanticNodes ?? [])];
  const findSemanticNode = (args: {
    category: "workspace" | "integration";
    treeId: string;
    nodeId: string;
  }) =>
    semanticNodes.find((node) =>
      node.category === args.category
      && node.treeId === args.treeId
      && node.nodeId === args.nodeId
    ) ?? null;
  const upsertSemanticNode = (args: {
    category: "workspace" | "integration";
    treeId: string;
    nodeId: string;
    nodeClass: "semantic" | "leaf";
    nodeKind: string;
    path: string;
    title: string;
    summary: string;
    bodySha256: string;
    childCount?: number;
    observedAt?: string | null;
    status?: "active" | "archived";
    isMaterialized?: boolean;
    metadata?: Record<string, unknown> | null;
    createdAt?: string;
    updatedAt?: string;
  }) => {
    const next: SemanticMemoryNodeRecord = {
      workspaceId: "workspace-1",
      category: args.category,
      treeId: args.treeId,
      nodeId: args.nodeId,
      nodeClass: args.nodeClass,
      nodeKind: args.nodeKind,
      sourceLeafId: null,
      path: args.path,
      title: args.title,
      summary: args.summary,
      bodySha256: args.bodySha256,
      childCount: args.childCount ?? 0,
      observedAt: args.observedAt ?? null,
      status: args.status ?? "active",
      isMaterialized: Boolean(args.isMaterialized),
      metadata: args.metadata ?? {},
      createdAt: args.createdAt ?? "2026-06-02T00:00:00.000Z",
      updatedAt: args.updatedAt ?? "2026-06-02T00:00:00.000Z",
    };
    const existingIndex = semanticNodes.findIndex((candidate) =>
      candidate.category === next.category
      && candidate.treeId === next.treeId
      && candidate.nodeId === next.nodeId
    );
    if (existingIndex >= 0) {
      semanticNodes.splice(existingIndex, 1, next);
    } else {
      semanticNodes.push(next);
    }
    return next;
  };
  return {
    getWorkspaceRuntimeMetadata(args: { workspaceId: string; key: string }) {
      assert.equal(args.workspaceId, "workspace-1");
      return metadata.get(args.key) ?? null;
    },
    setWorkspaceRuntimeMetadata(args: { workspaceId: string; key: string; value: string }) {
      assert.equal(args.workspaceId, "workspace-1");
      metadata.set(args.key, args.value);
    },
    listSemanticMemoryNodes(args: {
      category: "workspace" | "integration";
      workspaceId?: string | null;
      treeId?: string | null;
      nodeClass?: string | null;
      nodeKind?: string | null;
      status?: string | null;
    }) {
      assert.equal(args.workspaceId, "workspace-1");
      return semanticNodes.filter((node) => {
        if (args.treeId && node.treeId !== args.treeId) {
          return false;
        }
        if (args.category && node.category !== args.category) {
          return false;
        }
        if (args.nodeClass && node.nodeClass !== args.nodeClass) {
          return false;
        }
        if (args.nodeKind && node.nodeKind !== args.nodeKind) {
          return false;
        }
        if (args.status && node.status !== args.status) {
          return false;
        }
        return true;
      });
    },
    getSemanticMemoryNode(args: {
      category: "workspace" | "integration";
      workspaceId?: string | null;
      treeId: string;
      nodeId: string;
    }) {
      assert.equal(args.workspaceId, "workspace-1");
      return findSemanticNode(args);
    },
    upsertSemanticMemoryNode(args: {
      category: "workspace" | "integration";
      workspaceId?: string | null;
      treeId: string;
      nodeId: string;
      nodeClass: "semantic" | "leaf";
      nodeKind: string;
      path: string;
      title: string;
      summary: string;
      bodySha256: string;
      childCount?: number;
      observedAt?: string | null;
      status?: "active" | "archived";
      isMaterialized?: boolean;
      metadata?: Record<string, unknown> | null;
      createdAt?: string;
      updatedAt?: string;
    }) {
      assert.equal(args.workspaceId, "workspace-1");
      return upsertSemanticNode(args);
    },
    upsertSemanticMemorySearchDoc() {
      return null;
    },
    listIntegrationTrees(args: {
      workspaceId?: string | null;
      status?: string | null;
      limit?: number;
      offset?: number;
    }) {
      assert.equal(args.workspaceId, "workspace-1");
      assert.equal(args.status, "active");
      return params.trees.filter((tree) => tree.status === "active");
    },
  } as unknown as RuntimeStateStore;
}

function makeSemanticRootNode(params: {
  treeId: string;
  provider: string;
  accountNamespace: string;
  title: string;
  path: string;
  category?: "workspace" | "integration";
}): SemanticMemoryNodeRecord {
  return {
    workspaceId: "workspace-1",
    category: params.category ?? "workspace",
    treeId: params.treeId,
    nodeId: `semantic:integration:${params.treeId}:connection`,
    nodeClass: "semantic",
    nodeKind: "connection",
    sourceLeafId: null,
    path: params.path,
    title: params.title,
    summary: `${params.title} semantic memory tree.`,
    bodySha256: "sha256",
    childCount: 1,
    observedAt: "2026-06-02T00:00:00.000Z",
    status: "active",
    isMaterialized: true,
    metadata: {
      provider: params.provider,
      account_namespace: params.accountNamespace,
    },
    createdAt: "2026-06-02T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
  };
}

function ensureAndListVisibleTrees(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId?: string | null;
}): IntegrationTreeRecord[] {
  const initial = visibleIntegrationTreesForWorkspace(params);
  ensureWorkspaceIntegrationRootsMigrated({
    store: params.store,
    workspaceId: params.workspaceId,
    requestedTreeId: params.treeId ?? null,
    existingTreeIds: new Set(initial.map((tree) => tree.treeId)),
  });
  return visibleIntegrationTreesForWorkspace(params);
}

test("visibleIntegrationTreesForWorkspace keeps workspace trees even without matching active connections", () => {
  const trees = ensureAndListVisibleTrees({
    store: makeStore({
      trees: [
        makeTree({
          treeId: "integration:gmail:acct-old",
          provider: "gmail",
          accountKey: "old@example.com",
          accountLabel: "Old Gmail",
        }),
        makeTree({
          treeId: "integration:gmail:acct-new",
          provider: "gmail",
          accountKey: "new@example.com",
          accountLabel: "New Gmail",
        }),
      ],
    }),
    workspaceId: "workspace-1",
  });

  assert.deepEqual(
    trees.map((tree) => tree.treeId),
    ["integration:gmail:acct-old", "integration:gmail:acct-new"],
  );
});

test("visibleIntegrationTreesForWorkspace shows every account tree for a provider", () => {
  const trees = ensureAndListVisibleTrees({
    store: makeStore({
      trees: [
        makeTree({
          treeId: "integration:github:acct-a",
          provider: "github",
          accountKey: "acct-a",
          accountLabel: "Account A",
        }),
        makeTree({
          treeId: "integration:github:acct-b",
          provider: "github",
          accountKey: "acct-b",
          accountLabel: "Account B",
        }),
      ],
    }),
    workspaceId: "workspace-1",
  });

  assert.deepEqual(
    trees.map((tree) => tree.treeId),
    ["integration:github:acct-a", "integration:github:acct-b"],
  );
});

test("visibleIntegrationTreesForWorkspace prefers workspace semantic roots over legacy tree rows", () => {
  const trees = ensureAndListVisibleTrees({
    store: makeStore({
      trees: [
        makeTree({
          treeId: "integration:gmail:acct-1",
          provider: "gmail",
          accountKey: "legacy@example.com",
          accountLabel: "Legacy Gmail",
        }),
      ],
      semanticNodes: [
        makeSemanticRootNode({
          treeId: "integration:gmail:acct-1",
          provider: "gmail",
          accountNamespace: "ops@example.com",
          title: "Ops Gmail",
          path: "workspace/systems/integrations/gmail-ops-example-com-acct-1/content.md",
        }),
        makeSemanticRootNode({
          treeId: "integration:github:acct-1",
          provider: "github",
          accountNamespace: "octocat",
          title: "Octocat",
          path: "workspace/systems/integrations/github-octocat-acct-1/content.md",
          category: "integration",
        }),
      ],
    }),
    workspaceId: "workspace-1",
  });

  assert.deepEqual(
    trees.map((tree) => ({
      treeId: tree.treeId,
      accountNamespace: tree.accountNamespace,
      accountDisplayName: tree.accountDisplayName,
      slug: tree.slug,
    })),
    [
      {
        treeId: "integration:gmail:acct-1",
        accountNamespace: "ops@example.com",
        accountDisplayName: "Ops Gmail",
        slug: "gmail-ops-example-com-acct-1",
      },
      {
        treeId: "integration:github:acct-1",
        accountNamespace: "octocat",
        accountDisplayName: "Octocat",
        slug: "github-octocat-acct-1",
      },
    ],
  );
});

test("visibleIntegrationTreesForWorkspace backfills legacy roots once into workspace semantics", () => {
  const semanticNodes: SemanticMemoryNodeRecord[] = [];
  const metadata = new Map<string, string>();
  let legacyTreeReads = 0;
  const store = {
    getWorkspaceRuntimeMetadata(args: { workspaceId: string; key: string }) {
      assert.equal(args.workspaceId, "workspace-1");
      return metadata.get(args.key) ?? null;
    },
    setWorkspaceRuntimeMetadata(args: { workspaceId: string; key: string; value: string }) {
      assert.equal(args.workspaceId, "workspace-1");
      metadata.set(args.key, args.value);
    },
    listSemanticMemoryNodes(args: {
      category: "workspace" | "integration";
      workspaceId?: string | null;
      treeId?: string | null;
      nodeClass?: string | null;
      nodeKind?: string | null;
      status?: string | null;
    }) {
      assert.equal(args.workspaceId, "workspace-1");
      return semanticNodes.filter((node) => {
        if (args.category && node.category !== args.category) {
          return false;
        }
        if (args.treeId && node.treeId !== args.treeId) {
          return false;
        }
        if (args.nodeClass && node.nodeClass !== args.nodeClass) {
          return false;
        }
        if (args.nodeKind && node.nodeKind !== args.nodeKind) {
          return false;
        }
        if (args.status && node.status !== args.status) {
          return false;
        }
        return true;
      });
    },
    listIntegrationTrees(args: {
      workspaceId?: string | null;
      status?: string | null;
    }) {
      assert.equal(args.workspaceId, "workspace-1");
      assert.equal(args.status, "active");
      legacyTreeReads += 1;
      return [
        makeTree({
          treeId: "integration:gmail:acct-legacy",
          provider: "gmail",
          accountKey: "ops@example.com",
          accountLabel: "Ops Gmail",
        }),
      ];
    },
    getSemanticMemoryNode(args: {
      category: "workspace" | "integration";
      workspaceId?: string | null;
      treeId: string;
      nodeId: string;
    }) {
      assert.equal(args.workspaceId, "workspace-1");
      return semanticNodes.find((node) =>
        node.category === args.category
        && node.treeId === args.treeId
        && node.nodeId === args.nodeId
      ) ?? null;
    },
    upsertSemanticMemoryNode(args: {
      category: "workspace" | "integration";
      workspaceId?: string | null;
      treeId: string;
      nodeId: string;
      nodeClass: "semantic" | "leaf";
      nodeKind: string;
      path: string;
      title: string;
      summary: string;
      bodySha256: string;
      childCount?: number;
      observedAt?: string | null;
      status?: "active" | "archived";
      isMaterialized?: boolean;
      metadata?: Record<string, unknown> | null;
      createdAt?: string;
      updatedAt?: string;
    }) {
      assert.equal(args.workspaceId, "workspace-1");
      const next: SemanticMemoryNodeRecord = {
        workspaceId: "workspace-1",
        category: args.category,
        treeId: args.treeId,
        nodeId: args.nodeId,
        nodeClass: args.nodeClass,
        nodeKind: args.nodeKind,
        sourceLeafId: null,
        path: args.path,
        title: args.title,
        summary: args.summary,
        bodySha256: args.bodySha256,
        childCount: args.childCount ?? 0,
        observedAt: args.observedAt ?? null,
        status: args.status ?? "active",
        isMaterialized: Boolean(args.isMaterialized),
        metadata: args.metadata ?? {},
        createdAt: args.createdAt ?? "2026-06-02T00:00:00.000Z",
        updatedAt: args.updatedAt ?? "2026-06-02T00:00:00.000Z",
      };
      semanticNodes.splice(0, semanticNodes.length, next);
      return next;
    },
    upsertSemanticMemorySearchDoc() {
      return null;
    },
  } as unknown as RuntimeStateStore;

  ensureWorkspaceIntegrationRootsMigrated({
    store,
    workspaceId: "workspace-1",
    existingTreeIds: new Set(),
  });
  const first = visibleIntegrationTreesForWorkspace({
    store,
    workspaceId: "workspace-1",
  });
  const second = visibleIntegrationTreesForWorkspace({
    store,
    workspaceId: "workspace-1",
  });

  assert.equal(legacyTreeReads, 1);
  assert.equal(metadata.get("integration_semantic_root_backfill_v1_complete"), "true");
  assert.deepEqual(
    first.map((tree) => tree.treeId),
    ["integration:gmail:acct-legacy"],
  );
  assert.deepEqual(
    second.map((tree) => tree.treeId),
    ["integration:gmail:acct-legacy"],
  );
  assert.equal(semanticNodes.length, 1);
  assert.equal(semanticNodes[0]?.category, "workspace");
});

test("visibleIntegrationTreesForWorkspace can backfill a requested legacy tree after workspace-wide root migration completed", () => {
  const semanticNodes: SemanticMemoryNodeRecord[] = [];
  const metadata = new Map<string, string>([
    ["integration_semantic_root_backfill_v1_complete", "true"],
  ]);
  let legacyTreeReads = 0;
  const store = {
    getWorkspaceRuntimeMetadata(args: { workspaceId: string; key: string }) {
      assert.equal(args.workspaceId, "workspace-1");
      return metadata.get(args.key) ?? null;
    },
    setWorkspaceRuntimeMetadata(args: { workspaceId: string; key: string; value: string }) {
      assert.equal(args.workspaceId, "workspace-1");
      metadata.set(args.key, args.value);
    },
    listSemanticMemoryNodes(args: {
      category: "workspace" | "integration";
      workspaceId?: string | null;
      treeId?: string | null;
      nodeClass?: string | null;
      nodeKind?: string | null;
      status?: string | null;
    }) {
      assert.equal(args.workspaceId, "workspace-1");
      return semanticNodes.filter((node) => {
        if (args.category && node.category !== args.category) {
          return false;
        }
        if (args.treeId && node.treeId !== args.treeId) {
          return false;
        }
        if (args.nodeClass && node.nodeClass !== args.nodeClass) {
          return false;
        }
        if (args.nodeKind && node.nodeKind !== args.nodeKind) {
          return false;
        }
        if (args.status && node.status !== args.status) {
          return false;
        }
        return true;
      });
    },
    getSemanticMemoryNode(args: {
      category: "workspace" | "integration";
      workspaceId?: string | null;
      treeId: string;
      nodeId: string;
    }) {
      assert.equal(args.workspaceId, "workspace-1");
      return semanticNodes.find((node) =>
        node.category === args.category
        && node.treeId === args.treeId
        && node.nodeId === args.nodeId
      ) ?? null;
    },
    upsertSemanticMemoryNode(args: {
      category: "workspace" | "integration";
      workspaceId?: string | null;
      treeId: string;
      nodeId: string;
      nodeClass: "semantic" | "leaf";
      nodeKind: string;
      path: string;
      title: string;
      summary: string;
      bodySha256: string;
      childCount?: number;
      observedAt?: string | null;
      status?: "active" | "archived";
      isMaterialized?: boolean;
      metadata?: Record<string, unknown> | null;
      createdAt?: string;
      updatedAt?: string;
    }) {
      assert.equal(args.workspaceId, "workspace-1");
      const next: SemanticMemoryNodeRecord = {
        workspaceId: "workspace-1",
        category: args.category,
        treeId: args.treeId,
        nodeId: args.nodeId,
        nodeClass: args.nodeClass,
        nodeKind: args.nodeKind,
        sourceLeafId: null,
        path: args.path,
        title: args.title,
        summary: args.summary,
        bodySha256: args.bodySha256,
        childCount: args.childCount ?? 0,
        observedAt: args.observedAt ?? null,
        status: args.status ?? "active",
        isMaterialized: Boolean(args.isMaterialized),
        metadata: args.metadata ?? {},
        createdAt: args.createdAt ?? "2026-06-02T00:00:00.000Z",
        updatedAt: args.updatedAt ?? "2026-06-02T00:00:00.000Z",
      };
      semanticNodes.push(next);
      return next;
    },
    upsertSemanticMemorySearchDoc() {
      return null;
    },
    getIntegrationTree(args: {
      workspaceId?: string | null;
      treeId: string;
    }) {
      assert.equal(args.workspaceId, "workspace-1");
      assert.equal(args.treeId, "integration:gmail:acct-late");
      legacyTreeReads += 1;
      return makeTree({
        treeId: "integration:gmail:acct-late",
        provider: "gmail",
        accountKey: "late@example.com",
        accountLabel: "Late Gmail",
      });
    },
    listIntegrationTrees(args: {
      workspaceId?: string | null;
      status?: string | null;
      limit?: number;
      offset?: number;
    }) {
      assert.equal(args.workspaceId, "workspace-1");
      assert.equal(args.status, "active");
      throw new Error("requested tree backfill should use direct getIntegrationTree when available");
    },
  } as unknown as RuntimeStateStore;

  ensureWorkspaceIntegrationRootsMigrated({
    store,
    workspaceId: "workspace-1",
    requestedTreeId: "integration:gmail:acct-late",
    existingTreeIds: new Set(),
  });
  const trees = visibleIntegrationTreesForWorkspace({
    store,
    workspaceId: "workspace-1",
    treeId: "integration:gmail:acct-late",
  });

  assert.equal(legacyTreeReads, 1);
  assert.deepEqual(
    trees.map((tree) => tree.treeId),
    ["integration:gmail:acct-late"],
  );
  assert.equal(
    metadata.get("integration_semantic_root_backfill_v1:integration:gmail:acct-late"),
    "true",
  );
});
