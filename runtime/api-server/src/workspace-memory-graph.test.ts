import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RuntimeStateStore, type RuntimeStateStore as RuntimeStateStoreType } from "@holaboss/runtime-state-store";
import { seedWorkspaceRecord } from "./__test-helpers__/seed-workspace.js";

import { appendDurableMemoryRelatedSections } from "./memory-related-entities.js";
import {
  listWorkspaceOutputDocumentTrees,
  listWorkspaceToolResultDocumentTrees,
  persistTurnIntegrationToolResultsAsDocuments,
  persistTurnOutputArtifactsAsDocuments,
} from "./workspace-attachment-memory.js";
import {
  rebuildWorkspaceMemoryGraph,
  summarizeWorkspaceMemoryGraph,
} from "./workspace-memory-graph.js";
import { workspaceMemoryDir } from "./workspace-bundle-paths.js";

test("summarizeWorkspaceMemoryGraph counts semantic integration leaves without legacy integration leaf rows", () => {
  const store = {
    listInteractionEntities() {
      return [];
    },
    listInteractionLeaves() {
      return [];
    },
    getWorkspaceRuntimeMetadata(args: { key: string }) {
      if (args.key === "integration_semantic_root_backfill_v1_complete") {
        return "true";
      }
      if (args.key === "integration_semantic_leaf_backfill_v1:integration:gmail:ops") {
        return "true";
      }
      return null;
    },
    listSemanticMemoryNodes(params: {
      category: "interaction" | "workspace";
      treeId?: string;
      nodeClass?: string | null;
      nodeKind?: string | null;
      status?: string | null;
    }) {
      const nodes = [
        {
          workspaceId: "workspace-1",
          category: "workspace",
          treeId: "integration:gmail:ops",
          nodeId: "semantic:integration:integration:gmail:ops:connection",
          nodeClass: "semantic",
          nodeKind: "connection",
          sourceLeafId: null,
          path: "semantic/workspace/systems/integrations/gmail-ops/content.md",
          title: "Ops Gmail",
          summary: "Ops inbox memory.",
          bodySha256: "sha-root",
          childCount: 1,
          observedAt: "2026-06-03T00:00:00.000Z",
          status: "active",
          isMaterialized: false,
          metadata: {
            provider: "gmail",
            account_namespace: "ops@example.com",
          },
          createdAt: "2026-06-03T00:00:00.000Z",
          updatedAt: "2026-06-03T00:00:00.000Z",
        },
        {
          workspaceId: "workspace-1",
          category: "workspace",
          treeId: "integration:gmail:ops",
          nodeId: "semantic:integration:integration:gmail:ops:leaf:thread-1",
          nodeClass: "leaf",
          nodeKind: "leaf",
          sourceLeafId: "leaf-thread-1",
          path: "semantic/workspace/systems/integrations/gmail-ops/thread-1/content.md",
          title: "Customer escalation",
          summary: "Customer escalation thread",
          bodySha256: "sha-leaf",
          childCount: 0,
          observedAt: "2026-06-03T00:00:00.000Z",
          status: "active",
          isMaterialized: false,
          metadata: {
            provider: "gmail",
            account_namespace: "ops@example.com",
          },
          createdAt: "2026-06-03T00:00:00.000Z",
          updatedAt: "2026-06-03T00:00:00.000Z",
        },
      ];
      return nodes.filter((node) => {
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
    listSemanticMemoryChildren(params: {
      parentNodeId: string;
    }) {
      if (params.parentNodeId === "semantic:integration:integration:gmail:ops:connection") {
        return [
          {
            childNodeId: "semantic:integration:integration:gmail:ops:leaf:thread-1",
          },
        ];
      }
      return [];
    },
    listSemanticMemoryRelations() {
      return [];
    },
    listIntegrationLeaves() {
      return [];
    },
  } as unknown as RuntimeStateStoreType;

  const summary = summarizeWorkspaceMemoryGraph({
    store,
    workspaceId: "workspace-1",
  });

  assert.deepEqual(summary, {
    roots: 1,
    leaves: 1,
    semanticNodes: 2,
    semanticInternalNodes: 1,
    semanticEdges: 1,
    semanticRelations: 0,
  });
});

test("summarizeWorkspaceMemoryGraph falls back to legacy leaves when semantic projections are incomplete", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-workspace-memory-graph-"));
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });

  try {
    seedWorkspaceRecord(store, {
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.upsertInteractionEntity({
      workspaceId: "workspace-1",
      entityId: "interaction:workflow:deploy",
      entityType: "workflow",
      canonicalName: "Deploy workflow",
      slug: "workflow-deploy",
      summary: "Deploy workflow memory.",
      aliases: [],
      isSystem: false,
      status: "active",
    });
    store.upsertInteractionLeaf({
      workspaceId: "workspace-1",
      leafId: "leaf-deploy",
      entityId: "interaction:workflow:deploy",
      subjectKey: "deploy:owner",
      path: "workspace/workspace-1/interaction/entities/workflow-deploy/leaves/leaf-deploy.md",
      title: "Deploy owner",
      summary: "Maya owns deploy approvals.",
      fingerprint: "deploy-owner-fingerprint",
      bodySha256: "deploy-owner-sha",
      tags: ["deploy"],
      secondaryEntityIds: [],
      sourceType: "manual",
      sourceEventId: null,
      sourceMessageId: null,
      sourceTurnInputId: "input-seed",
      admissionConfidence: 0.9,
      entityConfidence: 0.9,
      observedAt: "2026-04-09T10:00:00.000Z",
      supersedesLeafId: null,
      status: "active",
    });
    store.upsertIntegrationTree({
      workspaceId: "workspace-1",
      treeId: "integration:gmail:ops",
      provider: "gmail",
      ownerUserId: "user-1",
      accountNamespace: "ops@example.com",
      accountDisplayName: "Ops Gmail",
      accountKey: "ops@example.com",
      accountLabel: "Ops Gmail",
      slug: "gmail-ops-example-com",
      summary: "Ops inbox memory.",
      status: "active",
    });
    store.upsertIntegrationLeaf({
      workspaceId: "workspace-1",
      leafId: "leaf-gmail-1",
      treeId: "integration:gmail:ops",
      subjectKey: "thread:customer-escalation",
      entityKey: "thread:customer-escalation",
      entityLabel: "Customer escalation thread",
      branchKey: "threads",
      branchLabel: "Threads",
      path: "integration/accounts/gmail-ops-example-com/leaves/leaf-gmail-1.md",
      title: "Customer escalation",
      summary: "Customer escalation thread needs a reply before Friday.",
      fingerprint: "gmail-thread-fingerprint",
      bodySha256: "gmail-thread-sha",
      tags: ["gmail"],
      sourceType: "gmail.thread",
      sourceEventId: "evt-gmail-1",
      sourceMessageId: "msg-gmail-1",
      externalObjectId: "thread-1",
      externalObjectType: "thread",
      admissionConfidence: 0.95,
      observedAt: "2026-04-10T10:00:00.000Z",
      supersedesLeafId: null,
      status: "active",
    });

    const summary = summarizeWorkspaceMemoryGraph({
      store,
      workspaceId: "workspace-1",
    });

    assert.deepEqual(summary, {
      roots: 2,
      leaves: 2,
      semanticNodes: 2,
      semanticInternalNodes: 1,
      semanticEdges: 0,
      semanticRelations: 0,
    });
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rebuildWorkspaceMemoryGraph re-syncs forwarded output artifact relations from stored event provenance", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-workspace-memory-graph-rebuild-"));
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });

  try {
    seedWorkspaceRecord(store, {
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });

    const reportRelativePath = "outputs/reports/build-fix-report.md";
    const reportAbsolutePath = path.join(root, "workspace", "workspace-1", reportRelativePath);
    fs.mkdirSync(path.dirname(reportAbsolutePath), { recursive: true });
    fs.writeFileSync(
      reportAbsolutePath,
      [
        "# Build Fix Report",
        "",
        "Ben Book at anyIP reached out to the user personally about holaboss.",
      ].join("\n"),
      "utf8",
    );

    store.createSubagentRun({
      subagentId: "subagent-1",
      workspaceId: "workspace-1",
      parentSessionId: "session-main",
      parentInputId: "parent-input-1",
      originMainSessionId: "session-main",
      ownerMainSessionId: "session-main",
      childSessionId: "subagent-1",
      initialChildInputId: "input-subagent",
      currentChildInputId: "input-subagent",
      latestChildInputId: "input-subagent",
      title: "Delegated build fix",
      goal: "Investigate the build fix and return a deliverable.",
      status: "completed",
    });

    const subagentInput = store.enqueueInput({
      workspaceId: "workspace-1",
      sessionId: "subagent-1",
      payload: {
        text: "Investigate the build fix and return a deliverable.",
      },
    });
    const subagentTurn = store.upsertTurnResult({
      workspaceId: "workspace-1",
      sessionId: "subagent-1",
      inputId: subagentInput.inputId,
      startedAt: "2026-06-04T07:00:00.000Z",
      completedAt: "2026-06-04T07:00:05.000Z",
      status: "completed",
      stopReason: "ok",
      assistantText: "I prepared the subagent deliverable.",
    });
    store.createOutput({
      workspaceId: "workspace-1",
      outputId: "output-subagent",
      outputType: "document",
      title: "build-fix-report.md",
      status: "completed",
      filePath: reportRelativePath,
      sessionId: "subagent-1",
      inputId: subagentInput.inputId,
      artifactId: "artifact-1",
      metadata: {
        origin_type: "subagent_output",
      },
    });
    store.appendOutputEvent({
      workspaceId: "workspace-1",
      sessionId: "subagent-1",
      inputId: subagentInput.inputId,
      sequence: 1,
      eventType: "tool_call",
      payload: {
        phase: "completed",
        tool_name: "holaboss_composio.gmail_fetch_emails",
        tool_id: "holaboss_composio.gmail_fetch_emails",
        call_id: "call-gmail-rebuild-1",
        error: false,
        result: {
          content: [
            {
              type: "text",
              text: "Ben Book at anyIP reached out to the user personally about holaboss.",
            },
          ],
          details: {
            raw: {
              _meta: {
                holaboss_integration_account: {
                  provider_id: "gmail",
                  connected_account_id: "ca_gmail_primary",
                  account_namespace: "ops@example.com",
                  connection_id: "conn_gmail_primary",
                },
              },
            },
          },
        },
      },
      createdAt: "2026-06-04T11:10:02.000Z",
    });
    await persistTurnIntegrationToolResultsAsDocuments({
      store,
      turnResult: subagentTurn,
      embeddingClient: null,
    });
    await persistTurnOutputArtifactsAsDocuments({
      store,
      turnResult: subagentTurn,
      embeddingClient: null,
    });

    const mainInput = store.enqueueInput({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      payload: {
        text: "What came back from the subagent?",
      },
    });
    const mainTurn = store.upsertTurnResult({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      inputId: mainInput.inputId,
      startedAt: "2026-06-04T07:01:00.000Z",
      completedAt: "2026-06-04T07:01:05.000Z",
      status: "completed",
      stopReason: "ok",
      assistantText: "I attached the forwarded subagent deliverable.",
    });
    const forwardedEvent = store.enqueueMainSessionEvent({
      eventId: "event-1",
      workspaceId: "workspace-1",
      ownerMainSessionId: "session-main",
      originMainSessionId: "session-main",
      subagentId: "subagent-1",
      eventType: "completed",
      deliveryBucket: "background_update",
      payload: {
        summary: "The subagent delivered the build fix report.",
      },
    });
    store.createOutput({
      workspaceId: "workspace-1",
      outputId: "output-main",
      outputType: "document",
      title: "build-fix-report.md",
      status: "completed",
      filePath: reportRelativePath,
      sessionId: "session-main",
      inputId: mainInput.inputId,
      artifactId: "artifact-1",
      metadata: {
        origin_type: "forwarded_subagent",
        forwarded_output_id: "output-subagent",
        source_event_id: forwardedEvent.eventId,
      },
    });
    await persistTurnOutputArtifactsAsDocuments({
      store,
      turnResult: mainTurn,
      embeddingClient: null,
    });

    const outputTrees = listWorkspaceOutputDocumentTrees({
      store,
      workspaceId: "workspace-1",
    });
    const originalTree = outputTrees.find((item) => item.outputId === "output-subagent");
    const forwardedTree = outputTrees.find((item) => item.outputId === "output-main");
    assert.ok(originalTree);
    assert.ok(forwardedTree);
    const toolResultTree = listWorkspaceToolResultDocumentTrees({
      store,
      workspaceId: "workspace-1",
    })[0];
    assert.ok(toolResultTree);

    store.syncSemanticMemoryRelations({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: originalTree!.treeId,
      relations: [],
    });
    store.syncSemanticMemoryRelations({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: forwardedTree!.treeId,
      relations: [],
    });

    await rebuildWorkspaceMemoryGraph({
      store,
      workspaceId: "workspace-1",
      selectedModel: null,
      sessionId: "session-main",
      inputId: mainInput.inputId,
    });

    const rebuiltForwardedRelations = store.listSemanticMemoryRelations({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: forwardedTree!.treeId,
      limit: 20,
      offset: 0,
    });
    const rebuiltOriginalRelations = store.listSemanticMemoryRelations({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: originalTree!.treeId,
      limit: 20,
      offset: 0,
    });

    assert.ok(rebuiltForwardedRelations.some((relation) =>
      relation.relationType === "forwarded_from"
      && relation.metadata.target_tree_id === originalTree!.treeId
      && relation.metadata.source_subagent_id === "subagent-1",
    ));
    assert.ok(rebuiltOriginalRelations.some((relation) =>
      relation.relationType === "derived_from"
      && relation.metadata.target_tree_id === toolResultTree!.treeId,
    ));
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rebuildWorkspaceMemoryGraph repairs legacy related keys before rebuilding interaction trees", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-workspace-memory-graph-repair-"));
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });

  try {
    seedWorkspaceRecord(store, {
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.upsertInteractionEntity({
      workspaceId: "workspace-1",
      entityId: "interaction:topic:holaboss-outreach",
      entityType: "topic",
      canonicalName: "Holaboss outreach",
      slug: "topic-holaboss-outreach",
      summary: "Holaboss outreach memory.",
      aliases: [],
      isSystem: false,
      status: "active",
    });
    store.upsertInteractionEntity({
      workspaceId: "workspace-1",
      entityId: "interaction:customer:anyip",
      entityType: "customer",
      canonicalName: "anyIP",
      slug: "customer-anyip",
      summary: "anyIP customer memory.",
      aliases: [],
      isSystem: false,
      status: "active",
    });
    store.upsertInteractionLeaf({
      workspaceId: "workspace-1",
      leafId: "leaf-outreach",
      entityId: "interaction:topic:holaboss-outreach",
      subjectKey: "holaboss:outreach:anyip",
      path: "leaves/holaboss-outreach.md",
      title: "Holaboss outreach note",
      summary: "Ben Book at anyIP reached out to the user personally about holaboss.",
      fingerprint: "holaboss-outreach-anyip",
      bodySha256: "holaboss-outreach-anyip-sha",
      tags: ["outreach"],
      secondaryEntityIds: [],
      sourceType: "manual",
      sourceEventId: null,
      sourceMessageId: null,
      sourceTurnInputId: null,
      admissionConfidence: 0.93,
      entityConfidence: 0.91,
      observedAt: "2026-06-05T09:00:00.000Z",
      supersedesLeafId: null,
      status: "active",
    });

    const leafAbsolutePath = path.join(
      workspaceMemoryDir(path.join(root, "workspace", "workspace-1")),
      "leaves/holaboss-outreach.md",
    );
    fs.mkdirSync(path.dirname(leafAbsolutePath), { recursive: true });
    fs.writeFileSync(
      leafAbsolutePath,
      appendDurableMemoryRelatedSections(
        [
          "# Holaboss outreach note",
          "",
          "## Summary",
          "",
          "Ben Book at anyIP reached out to the user personally about holaboss.",
          "",
          "## Evidence",
          "",
          "Ben Book at anyIP reached out to the user personally about holaboss.",
        ].join("\n"),
        {
          relatedEntities: [
            {
              entityType: "organization",
              entityKey: "organization:anyip",
              label: "anyIP",
            },
          ],
          relations: [
            {
              relationType: "works_at",
              entityKey: "organization:anyip",
            },
          ],
        },
      ),
      "utf8",
    );

    await rebuildWorkspaceMemoryGraph({
      store,
      workspaceId: "workspace-1",
      selectedModel: null,
    });

    const repairedLeaf = store.listInteractionLeaves({
      workspaceId: "workspace-1",
      status: "active",
      limit: 10,
      offset: 0,
    }).find((leaf) => leaf.leafId === "leaf-outreach");
    assert.ok(repairedLeaf);
    const repairedLeafRelativePath = repairedLeaf.path.startsWith("workspace/")
      ? repairedLeaf.path.split("/").slice(2).join("/")
      : repairedLeaf.path;
    const repairedBody = fs.readFileSync(
      path.join(
        workspaceMemoryDir(path.join(root, "workspace", "workspace-1")),
        repairedLeafRelativePath,
      ),
      "utf8",
    );
    const relations = store.listSemanticMemoryRelations({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: "interaction:topic:holaboss-outreach",
      limit: 50,
      offset: 0,
    });

    assert.match(
      repairedBody,
      /organization:entity:interaction:customer:anyip/,
    );
    assert.ok(relations.some((relation) =>
      relation.relationType === "works_at"
      && relation.metadata.entity_key === "organization:entity:interaction:customer:anyip",
      ),
    );
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
