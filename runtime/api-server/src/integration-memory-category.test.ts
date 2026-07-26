import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { RuntimeStateStore } from "@holaboss/runtime-state-store";

import {
  listActiveIntegrationLeafView,
  migrateLegacyWorkspaceIntegrationMemory,
  persistIntegrationCandidate,
  readableIntegrationSemanticCategory,
} from "./integration-memory.js";

test("readableIntegrationSemanticCategory migrates legacy workspace integration semantics on first read", () => {
  const calls: Array<{
    category: "integration" | "workspace";
    workspaceId?: string | null;
    treeId: string;
  }> = [];
  let migrated = false;
  const store = {
    listSemanticMemoryNodes(params: {
      category: "integration" | "workspace";
      workspaceId?: string | null;
      treeId: string;
      limit?: number;
      offset?: number;
    }) {
      calls.push({
        category: params.category,
        workspaceId: params.workspaceId ?? null,
        treeId: params.treeId,
      });
      if (params.category === "workspace" && migrated) {
        return [{ nodeId: "semantic:workspace:tree-1:node-1" }];
      }
      return [];
    },
    migrateSemanticMemoryTreeCategory(params: {
      workspaceId: string;
      treeId: string;
      fromCategory: "integration" | "workspace";
      toCategory: "integration" | "workspace";
    }) {
      assert.deepEqual(params, {
        workspaceId: "workspace-1",
        treeId: "tree-1",
        fromCategory: "integration",
        toCategory: "workspace",
      });
      migrated = true;
      return true;
    },
  } as unknown as RuntimeStateStore;

  const cache = new Map<string, "integration" | "workspace">();
  const category = readableIntegrationSemanticCategory({
    store,
    workspaceId: "workspace-1",
    treeId: "tree-1",
    cache,
  });

  assert.equal(category, "workspace");
  assert.deepEqual(calls, [
    {
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: "tree-1",
    },
  ]);
  assert.equal(cache.get("workspace-1:tree-1"), "workspace");
});

test("readableIntegrationSemanticCategory keeps legacy control-plane reads on integration", () => {
  const store = {
    listSemanticMemoryNodes() {
      throw new Error("control-plane reads should not probe workspace semantics");
    },
    migrateSemanticMemoryTreeCategory() {
      throw new Error("control-plane reads should not migrate workspace semantics");
    },
  } as unknown as RuntimeStateStore;

  const category = readableIntegrationSemanticCategory({
    store,
    workspaceId: null,
    treeId: "tree-1",
  });

  assert.equal(category, "integration");
});

test("listActiveIntegrationLeafView preserves semantic fingerprint metadata", () => {
  let legacyFallbackCalls = 0;
  const metadata = new Map<string, string>();
  const store = {
    getWorkspaceRuntimeMetadata(args: { workspaceId: string; key: string }) {
      assert.equal(args.workspaceId, "workspace-1");
      return metadata.get(args.key) ?? null;
    },
    setWorkspaceRuntimeMetadata(args: { workspaceId: string; key: string; value: string }) {
      assert.equal(args.workspaceId, "workspace-1");
      metadata.set(args.key, args.value);
    },
    listSemanticMemoryNodes(params: {
      category: "integration" | "workspace";
      workspaceId?: string | null;
      treeId?: string | null;
      nodeClass?: string | null;
      status?: string | null;
      limit?: number;
      offset?: number;
    }) {
      if (params.category === "workspace") {
        return [
          {
            workspaceId: "workspace-1",
            category: "workspace",
            treeId: "tree-1",
            nodeId: "semantic:integration:tree-1:leaf:leaf-1",
            nodeClass: "leaf",
            nodeKind: "leaf",
            sourceLeafId: "leaf-1",
            path: "semantic/workspace/systems/integrations/gmail-ops/leaves/leaf-1/content.md",
            title: "Launch follow-up",
            summary: "Customer thread is waiting on a follow-up.",
            bodySha256: "body-sha",
            childCount: 0,
            observedAt: "2026-06-02T00:00:00.000Z",
            status: "active",
            isMaterialized: false,
            metadata: {
              subject_key: "thread:launch-1",
              evidence_path: "integration/accounts/gmail-ops/leaves/leaf-1.md",
            },
            createdAt: "2026-06-02T00:00:00.000Z",
            updatedAt: "2026-06-02T00:00:00.000Z",
          },
        ];
      }
      return [];
    },
    migrateSemanticMemoryTreeCategory() {
      return false;
    },
    listSemanticMemoryEvidenceRefs() {
      return [
        {
          workspaceId: "workspace-1",
          category: "workspace",
          treeId: "tree-1",
          nodeId: "semantic:integration:tree-1:leaf:leaf-1",
          refId: "leaf-1",
          provider: "gmail",
          accountNamespace: "ops@example.com",
          connectionId: null,
          externalObjectId: "thread-1",
          externalObjectType: "thread",
          sourceType: "gmail.thread",
          sourceEventId: "evt-1",
          sourceMessageId: "msg-1",
          sourceTurnInputId: null,
          observedAt: "2026-06-02T00:00:00.000Z",
          metadata: {
            path: "integration/accounts/gmail-ops/leaves/leaf-1.md",
            title: "Launch follow-up",
            subject_key: "thread:launch-1",
            branch_key: "threads",
            branch_label: "Threads",
            fingerprint: "content-fingerprint",
            body_sha256: "body-sha",
            tags: ["gmail"],
          },
          createdAt: "2026-06-02T00:00:00.000Z",
          updatedAt: "2026-06-02T00:00:00.000Z",
        },
      ];
    },
    listIntegrationLeaves() {
      legacyFallbackCalls += 1;
      return [];
    },
  } as unknown as RuntimeStateStore;

  const leaves = listActiveIntegrationLeafView({
    store,
    workspaceId: "workspace-1",
    tree: {
      workspaceId: "workspace-1",
      treeId: "tree-1",
      provider: "gmail",
      ownerUserId: "",
      accountNamespace: "ops@example.com",
      accountDisplayName: "Ops Gmail",
      accountKey: "ops@example.com",
      accountLabel: "Ops Gmail",
      slug: "gmail-ops",
      summary: "Ops Gmail memory.",
      status: "active",
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z",
    },
  });

  assert.equal(legacyFallbackCalls, 0);
  assert.equal(leaves.length, 1);
  assert.equal(leaves[0]?.fingerprint, "content-fingerprint");
  assert.equal(leaves[0]?.bodySha256, "body-sha");
  assert.equal(leaves[0]?.path, "integration/accounts/gmail-ops/leaves/leaf-1.md");
});

test("migrateLegacyWorkspaceIntegrationMemory materializes legacy workspace leaves into workspace semantics", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hb-integration-leaf-view-"));
  const semanticNodes: Array<Record<string, unknown>> = [];
  const evidenceRefs: Array<Record<string, unknown>> = [];
  const migrationCalls: Array<{ fromCategory: string; toCategory: string }> = [];
  const metadata = new Map<string, string>();
  let legacyLeafReads = 0;
  try {
    const store = {
      workspaceRoot,
      getWorkspaceRuntimeMetadata(args: { workspaceId: string; key: string }) {
        assert.equal(args.workspaceId, "workspace-1");
        return metadata.get(args.key) ?? null;
      },
      setWorkspaceRuntimeMetadata(args: { workspaceId: string; key: string; value: string }) {
        assert.equal(args.workspaceId, "workspace-1");
        metadata.set(args.key, args.value);
      },
      listSemanticMemoryNodes(params: {
        category: "integration" | "workspace";
        workspaceId?: string | null;
        treeId?: string | null;
        nodeClass?: string | null;
        status?: string | null;
      }) {
        return semanticNodes.filter((node) => {
          if (params.category && node.category !== params.category) {
            return false;
          }
          if (params.treeId && node.treeId !== params.treeId) {
            return false;
          }
          if (params.nodeClass && node.nodeClass !== params.nodeClass) {
            return false;
          }
          if (params.status && node.status !== params.status) {
            return false;
          }
          return true;
        });
      },
      migrateSemanticMemoryTreeCategory(params: {
        workspaceId: string;
        treeId: string;
        fromCategory: "integration" | "workspace";
        toCategory: "integration" | "workspace";
      }) {
        migrationCalls.push({
          fromCategory: params.fromCategory,
          toCategory: params.toCategory,
        });
        return false;
      },
      listSemanticMemoryEvidenceRefs(params: {
        category: "integration" | "workspace";
        treeId?: string | null;
        nodeId?: string | null;
      }) {
        return evidenceRefs.filter((ref) => {
          if (params.category && ref.category !== params.category) {
            return false;
          }
          if (params.treeId && ref.treeId !== params.treeId) {
            return false;
          }
          if (params.nodeId && ref.nodeId !== params.nodeId) {
            return false;
          }
          return true;
        });
      },
      listIntegrationLeaves() {
        legacyLeafReads += 1;
        return [
          {
            workspaceId: "workspace-1",
            leafId: "leaf-legacy-1",
            treeId: "tree-legacy-1",
            subjectKey: "thread:launch-legacy",
            entityKey: "thread:launch-legacy",
            entityLabel: "Launch thread",
            branchKey: "threads",
            branchLabel: "Threads",
            path: "integration/accounts/gmail-ops/leaves/leaf-legacy-1.md",
            title: "Legacy launch follow-up",
            summary: "Legacy workspace leaf before semantic rebuild.",
            fingerprint: "legacy-fingerprint",
            bodySha256: "legacy-body-sha",
            tags: ["gmail"],
            sourceType: "gmail.thread",
            sourceEventId: "evt-legacy",
            sourceMessageId: "msg-legacy",
            externalObjectId: "thread-legacy-1",
            externalObjectType: "thread",
            admissionConfidence: 0.9,
            observedAt: "2026-06-02T00:00:00.000Z",
            supersedesLeafId: null,
            supersededAt: null,
            status: "active",
            createdAt: "2026-06-02T00:00:00.000Z",
            updatedAt: "2026-06-02T00:00:00.000Z",
          },
        ];
      },
      getSemanticMemoryNode(params: {
        category: "integration" | "workspace";
        treeId: string;
        nodeId: string;
      }) {
        return semanticNodes.find((node) =>
          node.category === params.category
          && node.treeId === params.treeId
          && node.nodeId === params.nodeId
        ) ?? null;
      },
      upsertSemanticMemoryNode(params: Record<string, unknown>) {
        const existingIndex = semanticNodes.findIndex((node) =>
          node.category === params.category
          && node.treeId === params.treeId
          && node.nodeId === params.nodeId
        );
        const next = {
          workspaceId: params.workspaceId,
          category: params.category,
          treeId: params.treeId,
          nodeId: params.nodeId,
          nodeClass: params.nodeClass,
          nodeKind: params.nodeKind,
          sourceLeafId: params.sourceLeafId ?? null,
          path: params.path,
          title: params.title,
          summary: params.summary,
          bodySha256: params.bodySha256,
          childCount: params.childCount ?? 0,
          observedAt: params.observedAt ?? null,
          status: params.status ?? "active",
          isMaterialized: Boolean(params.isMaterialized),
          metadata: params.metadata ?? {},
          createdAt: params.createdAt ?? "2026-06-02T00:00:00.000Z",
          updatedAt: params.updatedAt ?? "2026-06-02T00:00:00.000Z",
        };
        if (existingIndex >= 0) {
          semanticNodes.splice(existingIndex, 1, next);
        } else {
          semanticNodes.push(next);
        }
        return next;
      },
      upsertSemanticMemorySearchDoc() {
        return null;
      },
      upsertSemanticMemoryEvidenceRef(params: Record<string, unknown>) {
        const existingIndex = evidenceRefs.findIndex((ref) =>
          ref.category === params.category
          && ref.treeId === params.treeId
          && ref.nodeId === params.nodeId
          && ref.refId === params.refId
        );
        const next = {
          workspaceId: params.workspaceId,
          category: params.category,
          treeId: params.treeId,
          nodeId: params.nodeId,
          refId: params.refId,
          provider: params.provider ?? null,
          accountNamespace: params.accountNamespace ?? null,
          connectionId: params.connectionId ?? null,
          externalObjectId: params.externalObjectId ?? null,
          externalObjectType: params.externalObjectType ?? null,
          sourceType: params.sourceType ?? null,
          sourceEventId: params.sourceEventId ?? null,
          sourceMessageId: params.sourceMessageId ?? null,
          sourceTurnInputId: params.sourceTurnInputId ?? null,
          observedAt: params.observedAt ?? null,
          metadata: params.metadata ?? {},
          createdAt: params.createdAt ?? "2026-06-02T00:00:00.000Z",
          updatedAt: params.updatedAt ?? "2026-06-02T00:00:00.000Z",
        };
        if (existingIndex >= 0) {
          evidenceRefs.splice(existingIndex, 1, next);
        } else {
          evidenceRefs.push(next);
        }
        return next;
      },
    } as unknown as RuntimeStateStore;

    const tree = {
      workspaceId: "workspace-1",
      treeId: "tree-legacy-1",
      provider: "gmail",
      ownerUserId: "",
      accountNamespace: "ops@example.com",
      accountDisplayName: "Ops Gmail",
      accountKey: "ops@example.com",
      accountLabel: "Ops Gmail",
      slug: "gmail-ops",
      summary: "Ops Gmail memory.",
      status: "active",
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z",
    } as const;

    migrateLegacyWorkspaceIntegrationMemory({
      store,
      workspaceId: "workspace-1",
      treeId: tree.treeId,
      tree,
      includeRoot: false,
    });

    const leaves = listActiveIntegrationLeafView({
      store,
      workspaceId: "workspace-1",
      tree,
    });
    const secondLeaves = listActiveIntegrationLeafView({
      store,
      workspaceId: "workspace-1",
      tree,
    });

    assert.equal(leaves.length, 1);
    assert.equal(secondLeaves.length, 1);
    assert.equal(leaves[0]?.fingerprint, "legacy-fingerprint");
    assert.equal(leaves[0]?.bodySha256, "legacy-body-sha");
    assert.equal(legacyLeafReads, 1);
    assert.equal(semanticNodes.length, 1);
    assert.equal(semanticNodes[0]?.category, "workspace");
    assert.equal(evidenceRefs.length, 1);
    assert.equal(evidenceRefs[0]?.category, "workspace");
    assert.equal(metadata.get("integration_semantic_leaf_backfill_v1:tree-legacy-1"), "true");
    assert.equal(migrationCalls.length, 1);
    assert.deepEqual(
      migrationCalls.map((call) => ({
        fromCategory: call.fromCategory,
        toCategory: call.toCategory,
      })),
      [
        {
          fromCategory: "integration",
          toCategory: "workspace",
        },
      ],
    );
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("persistIntegrationCandidate writes workspace semantic memory without legacy tree/leaf row writes", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hb-integration-persist-"));
  const semanticNodes: Array<Record<string, unknown>> = [];
  const evidenceRefs: Array<Record<string, unknown>> = [];
  const metadata = new Map<string, string>();
  let legacyLeafReads = 0;
  let legacyTreeReads = 0;
  try {
    const store = {
      workspaceRoot,
      getWorkspaceRuntimeMetadata(args: { workspaceId: string; key: string }) {
        assert.equal(args.workspaceId, "workspace-1");
        return metadata.get(args.key) ?? null;
      },
      setWorkspaceRuntimeMetadata(args: { workspaceId: string; key: string; value: string }) {
        assert.equal(args.workspaceId, "workspace-1");
        metadata.set(args.key, args.value);
      },
      listSemanticMemoryNodes(params: {
        category: "integration" | "workspace";
        workspaceId?: string | null;
        treeId?: string | null;
        nodeClass?: string | null;
        nodeKind?: string | null;
        status?: string | null;
      }) {
        return semanticNodes.filter((node) => {
          if (params.category && node.category !== params.category) {
            return false;
          }
          if (params.treeId && node.treeId !== params.treeId) {
            return false;
          }
          if (params.nodeClass && node.nodeClass !== params.nodeClass) {
            return false;
          }
          if (params.nodeKind && node.nodeKind !== params.nodeKind) {
            return false;
          }
          if (params.status && node.status !== params.status) {
            return false;
          }
          return true;
        });
      },
      getSemanticMemoryNode(params: {
        category: "integration" | "workspace";
        treeId: string;
        nodeId: string;
      }) {
        return semanticNodes.find((node) =>
          node.category === params.category
          && node.treeId === params.treeId
          && node.nodeId === params.nodeId
        ) ?? null;
      },
      upsertSemanticMemoryNode(params: Record<string, unknown>) {
        const next = {
          workspaceId: params.workspaceId,
          category: params.category,
          treeId: params.treeId,
          nodeId: params.nodeId,
          nodeClass: params.nodeClass,
          nodeKind: params.nodeKind,
          sourceLeafId: params.sourceLeafId ?? null,
          path: params.path,
          title: params.title,
          summary: params.summary,
          bodySha256: params.bodySha256,
          childCount: params.childCount ?? 0,
          observedAt: params.observedAt ?? null,
          status: params.status ?? "active",
          isMaterialized: Boolean(params.isMaterialized),
          metadata: params.metadata ?? {},
          createdAt: params.createdAt ?? "2026-06-02T00:00:00.000Z",
          updatedAt: params.updatedAt ?? "2026-06-02T00:00:00.000Z",
        };
        const existingIndex = semanticNodes.findIndex((node) =>
          node.category === next.category
          && node.treeId === next.treeId
          && node.nodeId === next.nodeId
        );
        if (existingIndex >= 0) {
          semanticNodes.splice(existingIndex, 1, next);
        } else {
          semanticNodes.push(next);
        }
        return next;
      },
      upsertSemanticMemorySearchDoc() {
        return null;
      },
      listSemanticMemoryEvidenceRefs(params: {
        category: "integration" | "workspace";
        treeId?: string | null;
        nodeId?: string | null;
      }) {
        return evidenceRefs.filter((ref) => {
          if (params.category && ref.category !== params.category) {
            return false;
          }
          if (params.treeId && ref.treeId !== params.treeId) {
            return false;
          }
          if (params.nodeId && ref.nodeId !== params.nodeId) {
            return false;
          }
          return true;
        });
      },
      upsertSemanticMemoryEvidenceRef(params: Record<string, unknown>) {
        const next = {
          workspaceId: params.workspaceId,
          category: params.category,
          treeId: params.treeId,
          nodeId: params.nodeId,
          refId: params.refId,
          provider: params.provider ?? null,
          accountNamespace: params.accountNamespace ?? null,
          connectionId: params.connectionId ?? null,
          externalObjectId: params.externalObjectId ?? null,
          externalObjectType: params.externalObjectType ?? null,
          sourceType: params.sourceType ?? null,
          sourceEventId: params.sourceEventId ?? null,
          sourceMessageId: params.sourceMessageId ?? null,
          sourceTurnInputId: params.sourceTurnInputId ?? null,
          observedAt: params.observedAt ?? null,
          metadata: params.metadata ?? {},
          createdAt: params.createdAt ?? "2026-06-02T00:00:00.000Z",
          updatedAt: params.updatedAt ?? "2026-06-02T00:00:00.000Z",
        };
        const existingIndex = evidenceRefs.findIndex((ref) =>
          ref.category === next.category
          && ref.treeId === next.treeId
          && ref.nodeId === next.nodeId
          && ref.refId === next.refId
        );
        if (existingIndex >= 0) {
          evidenceRefs.splice(existingIndex, 1, next);
        } else {
          evidenceRefs.push(next);
        }
        return next;
      },
      migrateSemanticMemoryTreeCategory() {
        return false;
      },
      listIntegrationTrees() {
        legacyTreeReads += 1;
        return [];
      },
      getIntegrationTreeByAccountIdentity() {
        return null;
      },
      getIntegrationTreeBySlug() {
        return null;
      },
      listIntegrationLeaves() {
        legacyLeafReads += 1;
        return [];
      },
      upsertIntegrationTree() {
        throw new Error("workspace persistence should not write legacy integration trees");
      },
      upsertIntegrationLeaf() {
        throw new Error("workspace persistence should not write legacy integration leaves");
      },
      updateIntegrationLeafStatus() {
        throw new Error("workspace persistence should not update legacy integration leaves");
      },
    } as unknown as RuntimeStateStore;

    const result = await persistIntegrationCandidate({
      store,
      workspaceId: "workspace-1",
      candidate: {
        provider: "gmail",
        accountNamespace: "ops@example.com",
        accountDisplayName: "Ops Gmail",
        subjectKey: "thread:launch-1",
        entityKey: "thread:launch-1",
        entityLabel: "Launch thread",
        branchKey: "threads",
        branchLabel: "Threads",
        title: "Launch follow-up",
        summary: "Customer thread is waiting on a follow-up.",
        content: "Customer thread is waiting on a follow-up before Friday.",
        tags: ["gmail"],
        sourceType: "gmail.thread",
        sourceEventId: "evt-1",
        sourceMessageId: "msg-1",
        externalObjectId: "thread-1",
        externalObjectType: "thread",
        confidence: 0.93,
        observedAt: "2026-06-02T00:00:00.000Z",
      },
      embeddingClient: null,
    });

    assert.equal(result.outcome, "created");
    assert.equal(result.tree.workspaceId, "workspace-1");
    assert.equal(result.tree.accountNamespace, "ops@example.com");
    assert.equal(result.leaf.subjectKey, "thread:launch-1");
    assert.equal(legacyTreeReads, 1);
    assert.equal(legacyLeafReads, 0);
    assert.equal(
      semanticNodes.filter((node) => node.category === "workspace" && node.treeId === result.tree.treeId).length,
      2,
    );
    assert.equal(evidenceRefs.length, 1);
    assert.equal(metadata.get(`integration_semantic_root_backfill_v1:${result.tree.treeId}`), "true");
    assert.equal(metadata.get(`integration_semantic_leaf_backfill_v1:${result.tree.treeId}`), "true");
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("migrateLegacyWorkspaceIntegrationMemory backfills legacy workspace rows into semantic workspace memory", () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hb-integration-migrate-"));
  const semanticNodes: Array<Record<string, unknown>> = [];
  const evidenceRefs: Array<Record<string, unknown>> = [];
  const metadata = new Map<string, string>();
  try {
    const store = {
      workspaceRoot,
      getWorkspaceRuntimeMetadata(args: { workspaceId: string; key: string }) {
        assert.equal(args.workspaceId, "workspace-1");
        return metadata.get(args.key) ?? null;
      },
      setWorkspaceRuntimeMetadata(args: { workspaceId: string; key: string; value: string }) {
        assert.equal(args.workspaceId, "workspace-1");
        metadata.set(args.key, args.value);
      },
      listSemanticMemoryNodes(params: {
        category: "integration" | "workspace";
        workspaceId?: string | null;
        treeId?: string | null;
        nodeClass?: string | null;
        status?: string | null;
      }) {
        return semanticNodes.filter((node) => {
          if (params.category && node.category !== params.category) {
            return false;
          }
          if (params.treeId && node.treeId !== params.treeId) {
            return false;
          }
          if (params.nodeClass && node.nodeClass !== params.nodeClass) {
            return false;
          }
          if (params.status && node.status !== params.status) {
            return false;
          }
          return true;
        });
      },
      getSemanticMemoryNode(params: {
        category: "integration" | "workspace";
        treeId: string;
        nodeId: string;
      }) {
        return semanticNodes.find((node) =>
          node.category === params.category
          && node.treeId === params.treeId
          && node.nodeId === params.nodeId
        ) ?? null;
      },
      upsertSemanticMemoryNode(params: Record<string, unknown>) {
        const next = {
          workspaceId: params.workspaceId,
          category: params.category,
          treeId: params.treeId,
          nodeId: params.nodeId,
          nodeClass: params.nodeClass,
          nodeKind: params.nodeKind,
          sourceLeafId: params.sourceLeafId ?? null,
          path: params.path,
          title: params.title,
          summary: params.summary,
          bodySha256: params.bodySha256,
          childCount: params.childCount ?? 0,
          observedAt: params.observedAt ?? null,
          status: params.status ?? "active",
          isMaterialized: Boolean(params.isMaterialized),
          metadata: params.metadata ?? {},
          createdAt: params.createdAt ?? "2026-06-02T00:00:00.000Z",
          updatedAt: params.updatedAt ?? "2026-06-02T00:00:00.000Z",
        };
        const existingIndex = semanticNodes.findIndex((node) =>
          node.category === next.category
          && node.treeId === next.treeId
          && node.nodeId === next.nodeId
        );
        if (existingIndex >= 0) {
          semanticNodes.splice(existingIndex, 1, next);
        } else {
          semanticNodes.push(next);
        }
        return next;
      },
      upsertSemanticMemorySearchDoc() {
        return null;
      },
      listSemanticMemoryEvidenceRefs(params: {
        category: "integration" | "workspace";
        treeId?: string | null;
        nodeId?: string | null;
      }) {
        return evidenceRefs.filter((ref) => {
          if (params.category && ref.category !== params.category) {
            return false;
          }
          if (params.treeId && ref.treeId !== params.treeId) {
            return false;
          }
          if (params.nodeId && ref.nodeId !== params.nodeId) {
            return false;
          }
          return true;
        });
      },
      upsertSemanticMemoryEvidenceRef(params: Record<string, unknown>) {
        const next = {
          workspaceId: params.workspaceId,
          category: params.category,
          treeId: params.treeId,
          nodeId: params.nodeId,
          refId: params.refId,
          provider: params.provider ?? null,
          accountNamespace: params.accountNamespace ?? null,
          connectionId: params.connectionId ?? null,
          externalObjectId: params.externalObjectId ?? null,
          externalObjectType: params.externalObjectType ?? null,
          sourceType: params.sourceType ?? null,
          sourceEventId: params.sourceEventId ?? null,
          sourceMessageId: params.sourceMessageId ?? null,
          sourceTurnInputId: params.sourceTurnInputId ?? null,
          observedAt: params.observedAt ?? null,
          metadata: params.metadata ?? {},
          createdAt: params.createdAt ?? "2026-06-02T00:00:00.000Z",
          updatedAt: params.updatedAt ?? "2026-06-02T00:00:00.000Z",
        };
        evidenceRefs.push(next);
        return next;
      },
      migrateSemanticMemoryTreeCategory() {
        return false;
      },
      listIntegrationTrees() {
        return [
          {
            workspaceId: "workspace-1",
            treeId: "integration:gmail:acct-legacy",
            provider: "gmail",
            ownerUserId: "",
            accountNamespace: "ops@example.com",
            accountDisplayName: "Ops Gmail",
            accountKey: "ops@example.com",
            accountLabel: "Ops Gmail",
            slug: "gmail-ops-example-com-acct-legacy",
            summary: "Legacy inbox memory.",
            status: "active",
            createdAt: "2026-06-02T00:00:00.000Z",
            updatedAt: "2026-06-02T00:00:00.000Z",
          },
        ];
      },
      listIntegrationLeaves() {
        return [
          {
            workspaceId: "workspace-1",
            leafId: "leaf-legacy-1",
            treeId: "integration:gmail:acct-legacy",
            subjectKey: "thread:legacy-1",
            entityKey: "thread:legacy-1",
            entityLabel: "Legacy thread",
            branchKey: "threads",
            branchLabel: "Threads",
            path: "integration/accounts/gmail-ops-example-com-acct-legacy/leaves/leaf-legacy-1.md",
            title: "Legacy follow-up",
            summary: "Legacy workspace leaf before migration.",
            fingerprint: "legacy-fingerprint",
            bodySha256: "legacy-body-sha",
            tags: ["gmail"],
            sourceType: "gmail.thread",
            sourceEventId: "evt-legacy",
            sourceMessageId: "msg-legacy",
            externalObjectId: "thread-legacy-1",
            externalObjectType: "thread",
            admissionConfidence: 0.9,
            observedAt: "2026-06-02T00:00:00.000Z",
            supersedesLeafId: null,
            supersededAt: null,
            status: "active",
            createdAt: "2026-06-02T00:00:00.000Z",
            updatedAt: "2026-06-02T00:00:00.000Z",
          },
        ];
      },
      getIntegrationTree(args: { workspaceId?: string | null; treeId: string }) {
        assert.equal(args.workspaceId, "workspace-1");
        assert.equal(args.treeId, "integration:gmail:acct-legacy");
        return {
          workspaceId: "workspace-1",
          treeId: "integration:gmail:acct-legacy",
          provider: "gmail",
          ownerUserId: "",
          accountNamespace: "ops@example.com",
          accountDisplayName: "Ops Gmail",
          accountKey: "ops@example.com",
          accountLabel: "Ops Gmail",
          slug: "gmail-ops-example-com-acct-legacy",
          summary: "Legacy inbox memory.",
          status: "active",
          createdAt: "2026-06-02T00:00:00.000Z",
          updatedAt: "2026-06-02T00:00:00.000Z",
        };
      },
    } as unknown as RuntimeStateStore;

    const migrated = migrateLegacyWorkspaceIntegrationMemory({
      store,
      workspaceId: "workspace-1",
    });

    assert.deepEqual(migrated, {
      treesMigrated: 1,
      leavesMigrated: 1,
    });
    assert.equal(metadata.get("integration_semantic_root_backfill_v1_complete"), "true");
    assert.equal(metadata.get("integration_semantic_root_backfill_v1:integration:gmail:acct-legacy"), "true");
    assert.equal(metadata.get("integration_semantic_leaf_backfill_v1:integration:gmail:acct-legacy"), "true");
    assert.equal(
      semanticNodes.filter((node) => node.category === "workspace" && node.treeId === "integration:gmail:acct-legacy").length,
      2,
    );
    assert.equal(evidenceRefs.length, 1);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
