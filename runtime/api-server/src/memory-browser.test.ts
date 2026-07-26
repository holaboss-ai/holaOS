import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  RuntimeStateStore,
  type
  IntegrationConnectionRecord,
  IntegrationTreeRecord,
  InteractionEntityRecord,
  SemanticMemoryNodeRecord,
} from "@holaboss/runtime-state-store";
import { seedWorkspaceRecord } from "./__test-helpers__/seed-workspace.js";

import {
  buildMemoryBrowserGraph,
  buildMemoryBrowserTree,
  readMemoryBrowserNodeDetail,
  readMemoryBrowserFile,
} from "./memory-browser.js";
import { globalMemoryDirForWorkspaceRoot } from "./workspace-bundle-paths.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test("memory browser exposes semantic integration trees under workspace/systems/integrations and matches any stable connection identity", async () => {
  const root = makeTempDir("hb-memory-browser-integration-");
  const workspaceRoot = path.join(root, "workspace");
  const workspace = {
    id: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
    errorMessage: null,
    onboardingStatus: "idle",
    onboardingState: null,
    onboardingSessionId: null,
    onboardingAlignmentQuestion: null,
    onboardingAlignmentReport: null,
    onboardingVerificationReport: null,
    onboardingCompletedAt: null,
    onboardingCompletionSummary: null,
    onboardingRequestedAt: null,
    onboardingRequestedBy: null,
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:00.000Z",
    deletedAtUtc: null,
    icon: null,
    iconColor: null,
    workspaceRole: "owner",
    sourceWorkspaceId: null,
  };
  const connection: IntegrationConnectionRecord = {
    connectionId: "gmail-1",
    providerId: "gmail",
    ownerUserId: "user-1",
    accountLabel: "Ops Gmail",
    accountHandle: "ops-handle",
    accountEmail: "ops@example.com",
    accountExternalId: "ca_gmail_1",
    contextCronAutoFetchEnabled: true,
    authMode: "composio",
    grantedScopes: [],
    status: "active",
    secretRef: null,
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:00.000Z",
  };
  const treeRecord: IntegrationTreeRecord = {
    treeId: "integration:gmail:acct-1",
    provider: "gmail",
    ownerUserId: "user-1",
    accountNamespace: "ops@example.com",
    accountDisplayName: "Ops Gmail",
    accountKey: "ops@example.com",
    accountLabel: "Ops Gmail",
    slug: "gmail-ops-example-com-acct-1",
    summary: "Gmail account memory.",
    status: "active",
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:00.000Z",
  };
  const semanticNodes: SemanticMemoryNodeRecord[] = [
    {
      workspaceId: "workspace-1",
      category: "workspace",
      treeId: "integration:gmail:acct-1",
      nodeId: "semantic:integration:integration:gmail:acct-1:connection",
      nodeClass: "semantic",
      nodeKind: "connection",
      sourceLeafId: null,
      path: "semantic/workspace/systems/integrations/gmail-ops-example-com-acct-1/content.md",
      title: "Ops Gmail",
      summary: "Gmail account memory.",
      bodySha256: "sha-root",
      childCount: 0,
      observedAt: "2026-05-24T00:00:00.000Z",
      status: "active",
      isMaterialized: false,
      metadata: {
        provider: "gmail",
        account_namespace: "ops@example.com",
      },
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    },
  ];
  const store = {
    workspaceRoot,
    getWorkspaceRuntimeMetadata() {
      return null;
    },
    setWorkspaceRuntimeMetadata() {
      return undefined;
    },
    workspaceDir(workspaceId: string) {
      return path.join(workspaceRoot, workspaceId);
    },
    getWorkspace(workspaceId: string) {
      return workspaceId === workspace.id ? workspace : null;
    },
    listInteractionEntities() {
      return [];
    },
    listSemanticMemoryNodes(params: {
      category: "interaction" | "workspace";
      treeId?: string | null;
    }) {
      if (
        params.category === "workspace"
        && (params.treeId == null || params.treeId === treeRecord.treeId)
      ) {
        return semanticNodes;
      }
      return [];
    },
    listIntegrationConnections() {
      return [connection];
    },
    listIntegrationTrees(params: {
      provider?: string | null;
      ownerUserId?: string | null;
      status?: string | null;
    }) {
      return [treeRecord].filter((candidate) =>
        (params.provider == null || candidate.provider === params.provider)
        && (params.ownerUserId == null || candidate.ownerUserId === params.ownerUserId)
        && (params.status == null || candidate.status === params.status)
      );
    },
    listSemanticMemoryChildren() {
      return [];
    },
    listSemanticMemoryRelations() {
      return [];
    },
  } as unknown as RuntimeStateStore;

  try {
    const semanticFilePath = path.join(
      globalMemoryDirForWorkspaceRoot(workspaceRoot),
      "semantic",
      "workspace",
      "systems",
      "integrations",
      "gmail-ops-example-com-acct-1",
      "content.md",
    );
    fs.mkdirSync(path.dirname(semanticFilePath), { recursive: true });
    fs.writeFileSync(
      semanticFilePath,
      "# Ops Gmail\n\nGmail account memory.\n",
      "utf8",
    );

    const tree = await buildMemoryBrowserTree({
      store,
      workspaceId: "workspace-1",
    });
    assert.deepEqual(
      (tree.root.children ?? []).map((child) => child.name),
      ["workspace"],
    );
    const workspaceDirectory = (tree.root.children ?? []).find((child) => child.name === "workspace");
    assert.ok(workspaceDirectory && workspaceDirectory.kind === "directory");
    const systemsDirectory = (workspaceDirectory.children ?? []).find((child) => child.name === "systems");
    assert.ok(systemsDirectory && systemsDirectory.kind === "directory");
    const integrationsDirectory = (systemsDirectory.children ?? []).find((child) => child.name === "integrations");
    assert.ok(integrationsDirectory && integrationsDirectory.kind === "directory");
    const gmailDirectory = (integrationsDirectory.children ?? []).find((child) => child.name === "gmail-ops-example-com-acct-1");
    assert.ok(gmailDirectory && gmailDirectory.kind === "directory");
    const contentFile = (gmailDirectory.children ?? []).find((child) => child.name === "content.md");
    assert.ok(contentFile && contentFile.kind === "file");
    assert.equal(contentFile.path, "workspace/systems/integrations/gmail-ops-example-com-acct-1/content.md");

    const file = await readMemoryBrowserFile({
      store,
      workspaceId: "workspace-1",
      targetPath: "workspace/systems/integrations/gmail-ops-example-com-acct-1/content.md",
    });
    assert.match(file.content, /Gmail account memory\./);

    const workspaceGraph = await buildMemoryBrowserGraph({
      store,
      workspaceId: "workspace-1",
      forest: "workspace",
    });
    assert.equal(workspaceGraph.forest, "workspace");
    assert.ok(
      workspaceGraph.nodes.some(
        (node) =>
          node.category === "workspace"
          && node.tree_id === "integration:gmail:acct-1"
          && node.kind === "tree",
      ),
    );
    const systemsSection = workspaceGraph.nodes.find(
      (node) =>
        node.kind === "section"
        && node.category === "workspace"
        && node.label === "Systems",
    );
    assert.ok(systemsSection);
    assert.ok(
      workspaceGraph.edges.some(
        (edge) =>
          edge.kind === "contains"
          && edge.to === systemsSection.id,
      ),
    );
    assert.ok(
      workspaceGraph.edges.some(
        (edge) =>
          edge.kind === "contains"
          && edge.from === systemsSection.id
          && edge.to === "semantic:integration:integration:gmail:acct-1:connection",
      ),
    );
  } finally {
    // no-op
  }
});

test("memory browser graph caps visible layers and nodes to keep the workspace graph bounded", async () => {
  const root = makeTempDir("hb-memory-browser-graph-limits-");
  const workspaceRoot = path.join(root, "workspace");
  const workspace = {
    id: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
    errorMessage: null,
    onboardingStatus: "idle",
    onboardingState: null,
    onboardingSessionId: null,
    onboardingAlignmentQuestion: null,
    onboardingAlignmentReport: null,
    onboardingVerificationReport: null,
    onboardingCompletedAt: null,
    onboardingCompletionSummary: null,
    onboardingRequestedAt: null,
    onboardingRequestedBy: null,
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:00.000Z",
    deletedAtUtc: null,
    icon: null,
    iconColor: null,
    workspaceRole: "owner",
    sourceWorkspaceId: null,
  };
  const interactionEntity: InteractionEntityRecord = {
    workspaceId: workspace.id,
    entityId: "interaction:project-alpha",
    entityType: "project",
    canonicalName: "Project Alpha",
    slug: "project-alpha",
    summary: "Alpha project memory.",
    aliases: [],
    isSystem: false,
    status: "active",
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:00.000Z",
  };
  const semanticNodes: SemanticMemoryNodeRecord[] = [
    {
      workspaceId: workspace.id,
      category: "workspace",
      treeId: interactionEntity.entityId,
      nodeId: "semantic:workspace:project-alpha:tree",
      nodeClass: "semantic",
      nodeKind: "tree",
      sourceLeafId: null,
      path: "semantic/workspace/projects/project-alpha/content.md",
      title: "Project Alpha",
      summary: "Alpha project memory.",
      bodySha256: "sha-tree",
      childCount: 3,
      observedAt: "2026-05-24T00:00:00.000Z",
      status: "active",
      isMaterialized: false,
      metadata: {},
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    },
    {
      workspaceId: workspace.id,
      category: "workspace",
      treeId: interactionEntity.entityId,
      nodeId: "semantic:workspace:project-alpha:overview",
      nodeClass: "semantic",
      nodeKind: "topic",
      sourceLeafId: null,
      path: "semantic/workspace/projects/project-alpha/overview/content.md",
      title: "Overview",
      summary: "Overview summary.",
      bodySha256: "sha-overview",
      childCount: 1,
      observedAt: "2026-05-24T00:00:00.000Z",
      status: "active",
      isMaterialized: false,
      metadata: {},
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    },
    {
      workspaceId: workspace.id,
      category: "workspace",
      treeId: interactionEntity.entityId,
      nodeId: "semantic:workspace:project-alpha:risks",
      nodeClass: "semantic",
      nodeKind: "topic",
      sourceLeafId: null,
      path: "semantic/workspace/projects/project-alpha/risks/content.md",
      title: "Risks",
      summary: "Risk summary.",
      bodySha256: "sha-risks",
      childCount: 0,
      observedAt: "2026-05-24T00:00:00.000Z",
      status: "active",
      isMaterialized: false,
      metadata: {},
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    },
    {
      workspaceId: workspace.id,
      category: "workspace",
      treeId: interactionEntity.entityId,
      nodeId: "semantic:workspace:project-alpha:timeline",
      nodeClass: "semantic",
      nodeKind: "topic",
      sourceLeafId: null,
      path: "semantic/workspace/projects/project-alpha/timeline/content.md",
      title: "Timeline",
      summary: "Timeline summary.",
      bodySha256: "sha-timeline",
      childCount: 0,
      observedAt: "2026-05-24T00:00:00.000Z",
      status: "active",
      isMaterialized: false,
      metadata: {},
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    },
    {
      workspaceId: workspace.id,
      category: "workspace",
      treeId: interactionEntity.entityId,
      nodeId: "semantic:workspace:project-alpha:context",
      nodeClass: "semantic",
      nodeKind: "topic",
      sourceLeafId: null,
      path: "semantic/workspace/projects/project-alpha/overview/context/content.md",
      title: "Context",
      summary: "Context summary.",
      bodySha256: "sha-context",
      childCount: 1,
      observedAt: "2026-05-24T00:00:00.000Z",
      status: "active",
      isMaterialized: false,
      metadata: {},
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    },
    {
      workspaceId: workspace.id,
      category: "workspace",
      treeId: interactionEntity.entityId,
      nodeId: "semantic:workspace:project-alpha:metrics",
      nodeClass: "semantic",
      nodeKind: "topic",
      sourceLeafId: null,
      path: "semantic/workspace/projects/project-alpha/overview/context/metrics/content.md",
      title: "Metrics",
      summary: "Metrics summary.",
      bodySha256: "sha-metrics",
      childCount: 1,
      observedAt: "2026-05-24T00:00:00.000Z",
      status: "active",
      isMaterialized: false,
      metadata: {},
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    },
    {
      workspaceId: workspace.id,
      category: "workspace",
      treeId: interactionEntity.entityId,
      nodeId: "semantic:workspace:project-alpha:details",
      nodeClass: "semantic",
      nodeKind: "topic",
      sourceLeafId: null,
      path: "semantic/workspace/projects/project-alpha/overview/context/metrics/details/content.md",
      title: "Details",
      summary: "Deep details summary.",
      bodySha256: "sha-details",
      childCount: 0,
      observedAt: "2026-05-24T00:00:00.000Z",
      status: "active",
      isMaterialized: false,
      metadata: {},
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    },
  ];
  const semanticEdges = [
    {
      parentNodeId: "semantic:workspace:project-alpha:tree",
      childNodeId: "semantic:workspace:project-alpha:overview",
    },
    {
      parentNodeId: "semantic:workspace:project-alpha:tree",
      childNodeId: "semantic:workspace:project-alpha:risks",
    },
    {
      parentNodeId: "semantic:workspace:project-alpha:tree",
      childNodeId: "semantic:workspace:project-alpha:timeline",
    },
    {
      parentNodeId: "semantic:workspace:project-alpha:overview",
      childNodeId: "semantic:workspace:project-alpha:context",
    },
    {
      parentNodeId: "semantic:workspace:project-alpha:context",
      childNodeId: "semantic:workspace:project-alpha:metrics",
    },
    {
      parentNodeId: "semantic:workspace:project-alpha:metrics",
      childNodeId: "semantic:workspace:project-alpha:details",
    },
  ];
  const store = {
    workspaceRoot,
    getWorkspaceRuntimeMetadata() {
      return null;
    },
    setWorkspaceRuntimeMetadata() {
      return undefined;
    },
    workspaceDir(workspaceId: string) {
      return path.join(workspaceRoot, workspaceId);
    },
    getWorkspace(workspaceId: string) {
      return workspaceId === workspace.id ? workspace : null;
    },
    listInteractionEntities() {
      return [interactionEntity];
    },
    listSemanticMemoryNodes(params: {
      category: "interaction" | "workspace";
      treeId?: string | null;
    }) {
      if (
        params.category === "workspace"
        && (params.treeId == null || params.treeId === interactionEntity.entityId)
      ) {
        return semanticNodes;
      }
      return [];
    },
    listIntegrationConnections() {
      return [];
    },
    listIntegrationTrees() {
      return [];
    },
    listSemanticMemoryChildren(params: {
      parentNodeId?: string | null;
    }) {
      return semanticEdges.filter(
        (edge) => edge.parentNodeId === params.parentNodeId,
      );
    },
    listSemanticMemoryRelations() {
      return [];
    },
  } as unknown as RuntimeStateStore;

  const graph = await buildMemoryBrowserGraph({
    store,
    workspaceId: workspace.id,
    forest: "workspace",
    maxLayers: 5,
    maxNodes: 5,
  });

  assert.equal(graph.limits.max_layers, 5);
  assert.equal(graph.limits.max_nodes, 5);
  assert.equal(graph.limits.displayed_nodes, graph.nodes.length);
  assert.equal(graph.limits.displayed_edges, graph.edges.length);
  assert.equal(graph.limits.truncated_by_layers, true);
  assert.equal(graph.limits.truncated_by_nodes, true);
  assert.equal(graph.nodes.length, 5);
  assert.ok(graph.limits.total_nodes > graph.nodes.length);
  assert.ok(graph.nodes.every((node) => node.level == null || node.level < 5));
  const visibleNodeIds = new Set(graph.nodes.map((node) => node.id));
  assert.ok(
    graph.edges.every(
      (edge) =>
        visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to),
    ),
  );
  assert.equal(
    graph.nodes.some((node) => node.id === "semantic:workspace:project-alpha:metrics"),
    false,
  );
  assert.equal(
    graph.nodes.some((node) => node.id === "semantic:workspace:project-alpha:details"),
    false,
  );
});

test("memory browser graph exposes related entity references as synthetic nodes", async () => {
  const root = makeTempDir("hb-memory-browser-relations-");
  const workspaceRoot = path.join(root, "workspace");
  const workspace = {
    id: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
    errorMessage: null,
    onboardingStatus: "idle",
    onboardingState: null,
    onboardingSessionId: null,
    onboardingAlignmentQuestion: null,
    onboardingAlignmentReport: null,
    onboardingVerificationReport: null,
    onboardingCompletedAt: null,
    onboardingCompletionSummary: null,
    onboardingRequestedAt: null,
    onboardingRequestedBy: null,
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    deletedAtUtc: null,
    icon: null,
    iconColor: null,
    workspaceRole: "owner",
    sourceWorkspaceId: null,
  };
  const entity: InteractionEntityRecord = {
    workspaceId: "workspace-1",
    entityId: "interaction:topic:holaboss-personal-outreach",
    entityType: "topic",
    canonicalName: "Holaboss personal outreach",
    slug: "topic-holaboss-personal-outreach",
    summary: "External outreach memory.",
    aliases: [],
    isSystem: false,
    status: "active",
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
  const rootNode: SemanticMemoryNodeRecord = {
    workspaceId: "workspace-1",
    category: "workspace",
    treeId: entity.entityId,
    nodeId: "semantic:interaction:interaction:topic:holaboss-personal-outreach:tree",
    nodeClass: "semantic",
    nodeKind: "tree",
    sourceLeafId: null,
    path: "semantic/workspace/knowledge/topic-holaboss-personal-outreach/content.md",
    title: entity.canonicalName,
    summary: entity.summary ?? "External outreach memory.",
    bodySha256: "sha-tree",
    childCount: 1,
    observedAt: "2026-06-03T00:00:00.000Z",
    status: "active",
    isMaterialized: false,
    metadata: {},
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
  const leafNode: SemanticMemoryNodeRecord = {
    workspaceId: "workspace-1",
    category: "workspace",
    treeId: entity.entityId,
    nodeId: "semantic:interaction:interaction:topic:holaboss-personal-outreach:leaf:leaf-1",
    nodeClass: "leaf",
    nodeKind: "leaf",
    sourceLeafId: "leaf-1",
    path: "semantic/workspace/knowledge/topic-holaboss-personal-outreach/leaf-1.md",
    title: "External individuals have emailed the user personally about holaboss",
    summary: "Personal outreach memory.",
    bodySha256: "sha-leaf",
    childCount: 0,
    observedAt: "2026-06-03T00:00:00.000Z",
    status: "active",
    isMaterialized: false,
    metadata: {},
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
  const store = {
    workspaceRoot,
    getWorkspaceRuntimeMetadata() {
      return null;
    },
    setWorkspaceRuntimeMetadata() {
      return undefined;
    },
    workspaceDir(workspaceId: string) {
      return path.join(workspaceRoot, workspaceId);
    },
    getWorkspace(workspaceId: string) {
      return workspaceId === workspace.id ? workspace : null;
    },
    listInteractionEntities() {
      return [entity];
    },
    getInteractionEntity(params: { workspaceId: string; entityId: string }) {
      return params.workspaceId === workspace.id && params.entityId === entity.entityId ? entity : null;
    },
    listSemanticMemoryNodes(params: {
      category: "interaction" | "workspace";
      treeId?: string | null;
    }) {
      if (params.category !== "workspace") {
        return [];
      }
      return [rootNode, leafNode].filter((node) => params.treeId == null || node.treeId === params.treeId);
    },
    listIntegrationConnections() {
      return [];
    },
    listIntegrationTrees() {
      return [];
    },
    listSemanticMemoryChildren(params: {
      treeId?: string | null;
      parentNodeId?: string | null;
    }) {
      if (params.treeId === entity.entityId && params.parentNodeId === rootNode.nodeId) {
        return [
          {
            workspaceId: "workspace-1",
            category: "workspace",
            treeId: entity.entityId,
            parentNodeId: rootNode.nodeId,
            childNodeId: leafNode.nodeId,
            position: 1,
            createdAt: "2026-06-03T00:00:00.000Z",
          },
        ];
      }
      return [];
    },
    listSemanticMemoryRelations(params: {
      category: "interaction" | "workspace";
      treeId?: string | null;
    }) {
      if (params.category !== "workspace" || params.treeId !== entity.entityId) {
        return [];
      }
      return [
        {
          workspaceId: "workspace-1",
          category: "workspace",
          treeId: entity.entityId,
          fromNodeId: leafNode.nodeId,
          toNodeId: "semantic:related:person:ben-book",
          relationType: "contacted_by",
          metadata: {
            entity_key: "person:ben-book",
            entity_label: "Ben Book",
            entity_type: "person",
          },
          createdAt: "2026-06-03T00:00:00.000Z",
          updatedAt: "2026-06-03T00:00:00.000Z",
        },
      ];
    },
  } as unknown as RuntimeStateStore;

  const graph = await buildMemoryBrowserGraph({
    store,
    workspaceId: "workspace-1",
    forest: "workspace",
    maxLayers: 8,
    maxNodes: 100,
  });

  const relatedNode = graph.nodes.find((node) => node.id === "semantic:related:person:ben-book");
  assert.ok(relatedNode);
  assert.equal(relatedNode.label, "Ben Book");
  assert.equal(relatedNode.kind, "node");
  assert.ok(
    graph.edges.some((edge) =>
      edge.kind === "reference"
      && edge.from === leafNode.nodeId
      && edge.to === "semantic:related:person:ben-book"
    ),
  );
});

test("readMemoryBrowserNodeDetail returns evidence refs and relations for a selected node", async () => {
  const root = makeTempDir("hb-memory-browser-node-detail-");
  const workspaceRoot = path.join(root, "workspace");
  const workspace = {
    id: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
    errorMessage: null,
    onboardingStatus: "idle",
    onboardingState: null,
    onboardingSessionId: null,
    onboardingAlignmentQuestion: null,
    onboardingAlignmentReport: null,
    onboardingVerificationReport: null,
    onboardingCompletedAt: null,
    onboardingCompletionSummary: null,
    onboardingRequestedAt: null,
    onboardingRequestedBy: null,
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    deletedAtUtc: null,
    icon: null,
    iconColor: null,
    workspaceRole: "owner",
    sourceWorkspaceId: null,
  };
  const entity: InteractionEntityRecord = {
    workspaceId: "workspace-1",
    entityId: "interaction:topic:holaboss-personal-outreach",
    entityType: "topic",
    canonicalName: "Holaboss personal outreach",
    slug: "topic-holaboss-personal-outreach",
    summary: "External outreach memory.",
    aliases: [],
    isSystem: false,
    status: "active",
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
  const leafNode: SemanticMemoryNodeRecord = {
    workspaceId: "workspace-1",
    category: "workspace",
    treeId: entity.entityId,
    nodeId: "semantic:interaction:interaction:topic:holaboss-personal-outreach:leaf:leaf-1",
    nodeClass: "leaf",
    nodeKind: "leaf",
    sourceLeafId: "leaf-1",
    path: "semantic/workspace/knowledge/topic-holaboss-personal-outreach/leaf-1.md",
    title: "External individuals have emailed the user personally about holaboss",
    summary: "Personal outreach memory.",
    bodySha256: "sha-leaf",
    childCount: 0,
    observedAt: "2026-06-03T00:00:00.000Z",
    status: "active",
    isMaterialized: false,
    metadata: {},
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
  const store = {
    workspaceRoot,
    getWorkspaceRuntimeMetadata() {
      return null;
    },
    setWorkspaceRuntimeMetadata() {
      return undefined;
    },
    workspaceDir(workspaceId: string) {
      return path.join(workspaceRoot, workspaceId);
    },
    getWorkspace(workspaceId: string) {
      return workspaceId === workspace.id ? workspace : null;
    },
    listInteractionEntities() {
      return [entity];
    },
    listIntegrationConnections() {
      return [];
    },
    listIntegrationTrees() {
      return [];
    },
    listSemanticMemoryNodes() {
      return [];
    },
    getSemanticMemoryNode(params: { category: "interaction" | "workspace"; treeId: string; nodeId: string }) {
      return params.category === "workspace" && params.treeId === entity.entityId && params.nodeId === leafNode.nodeId
        ? leafNode
        : null;
    },
    listSemanticMemoryRelations(params: { category: "interaction" | "workspace"; treeId?: string | null }) {
      if (params.category !== "workspace" || params.treeId !== entity.entityId) {
        return [];
      }
      return [
        {
          workspaceId: "workspace-1",
          category: "workspace",
          treeId: entity.entityId,
          fromNodeId: leafNode.nodeId,
          toNodeId: "semantic:related:person:ben-book",
          relationType: "contacted_by",
          metadata: {
            entity_key: "person:ben-book",
            entity_label: "Ben Book",
            entity_type: "person",
          },
          createdAt: "2026-06-03T00:00:00.000Z",
          updatedAt: "2026-06-03T00:00:00.000Z",
        },
      ];
    },
    listSemanticMemoryEvidenceRefs(params: {
      category: "interaction" | "workspace";
      treeId?: string | null;
      nodeId?: string | null;
    }) {
      if (
        params.category !== "workspace"
        || params.treeId !== entity.entityId
        || params.nodeId !== leafNode.nodeId
      ) {
        return [];
      }
      return [
        {
          workspaceId: "workspace-1",
          category: "workspace",
          treeId: entity.entityId,
          nodeId: leafNode.nodeId,
          refId: "turn:input-7:tool:call-1",
          provider: "gmail",
          accountNamespace: "ops@example.com",
          connectionId: "conn-gmail",
          externalObjectId: "thread-1",
          externalObjectType: "gmail_thread",
          sourceType: "tool_call",
          sourceEventId: "call-1",
          sourceMessageId: null,
          sourceTurnInputId: "input-7",
          observedAt: "2026-06-03T00:00:00.000Z",
          metadata: {
            tool_name: "gmail.fetch_emails",
          },
          createdAt: "2026-06-03T00:00:00.000Z",
          updatedAt: "2026-06-03T00:00:00.000Z",
        },
      ];
    },
  } as unknown as RuntimeStateStore;

  const detail = await readMemoryBrowserNodeDetail({
    store,
    workspaceId: "workspace-1",
    nodeId: leafNode.nodeId,
    treeId: entity.entityId,
  });

  assert.equal(detail.evidence_refs[0]?.provider, "gmail");
  assert.equal(detail.evidence_refs[0]?.account_namespace, "ops@example.com");
  assert.equal(detail.outgoing_relations[0]?.target_label, "Ben Book");
  assert.equal(detail.outgoing_relations[0]?.relation_type, "contacted_by");
  assert.equal(detail.outgoing_relations[0]?.target_resolution_kind, "synthetic");

  const relatedDetail = await readMemoryBrowserNodeDetail({
    store,
    workspaceId: "workspace-1",
    nodeId: "semantic:related:person:ben-book",
  });

  assert.equal(relatedDetail.kind, "node");
  assert.equal(relatedDetail.label, "Ben Book");
  assert.equal(relatedDetail.subtitle, "synthetic related person");
  assert.equal(relatedDetail.incoming_relations[0]?.source_node_id, leafNode.nodeId);
  assert.equal(relatedDetail.incoming_relations[0]?.target_resolution_kind, "synthetic");
});

test("readMemoryBrowserNodeDetail preserves mixed synthetic and missing incoming relation states for a synthetic related node", async () => {
  const root = makeTempDir("hb-memory-browser-mixed-synthetic-related-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.upsertInteractionEntity({
    workspaceId: "workspace-1",
    entityId: "interaction:topic:outreach",
    entityType: "topic",
    canonicalName: "Outreach",
    slug: "topic-outreach",
    summary: "Outreach memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  const rootNode: SemanticMemoryNodeRecord = {
    workspaceId: "workspace-1",
    category: "workspace",
    treeId: "interaction:topic:outreach",
    nodeId: "semantic:interaction:interaction:topic:outreach:tree",
    nodeClass: "semantic",
    nodeKind: "tree",
    sourceLeafId: null,
    path: "semantic/workspace/knowledge/topic-outreach/content.md",
    title: "Outreach",
    summary: "Outreach memory.",
    bodySha256: "sha-tree",
    childCount: 2,
    observedAt: "2026-06-03T00:00:00.000Z",
    status: "active",
    isMaterialized: false,
    metadata: {},
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
  const leafOneNode: SemanticMemoryNodeRecord = {
    workspaceId: "workspace-1",
    category: "workspace",
    treeId: "interaction:topic:outreach",
    nodeId: "semantic:interaction:interaction:topic:outreach:leaf:leaf-1",
    nodeClass: "leaf",
    nodeKind: "leaf",
    sourceLeafId: "leaf-1",
    path: "semantic/workspace/knowledge/topic-outreach/leaf-1.md",
    title: "Synthetic outreach mention",
    summary: "Synthetic relation memory.",
    bodySha256: "sha-leaf-1",
    childCount: 0,
    observedAt: "2026-06-03T00:00:00.000Z",
    status: "active",
    isMaterialized: false,
    metadata: {},
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
  const leafTwoNode: SemanticMemoryNodeRecord = {
    ...leafOneNode,
    nodeId: "semantic:interaction:interaction:topic:outreach:leaf:leaf-2",
    sourceLeafId: "leaf-2",
    path: "semantic/workspace/knowledge/topic-outreach/leaf-2.md",
    title: "Missing outreach mention",
    bodySha256: "sha-leaf-2",
  };
  store.syncSemanticMemoryTree({
    category: "workspace",
    workspaceId: "workspace-1",
    treeId: "interaction:topic:outreach",
    nodes: [rootNode, leafOneNode, leafTwoNode],
    edges: [
      {
        parentNodeId: rootNode.nodeId,
        childNodeId: leafOneNode.nodeId,
        position: 1,
      },
      {
        parentNodeId: rootNode.nodeId,
        childNodeId: leafTwoNode.nodeId,
        position: 2,
      },
    ],
  });
  store.replaceSemanticMemoryRelations({
    category: "workspace",
    workspaceId: "workspace-1",
    treeId: "interaction:topic:outreach",
    relations: [
      {
        fromNodeId: leafOneNode.nodeId,
        toNodeId: "semantic:related:person:ben-book",
        relationType: "contacted_by",
        metadata: {
          entity_key: "person:ben-book",
          entity_label: "Ben Book",
          entity_type: "person",
        },
      },
      {
        fromNodeId: leafTwoNode.nodeId,
        toNodeId: "semantic:related:person:ben-book",
        relationType: "contacted_by",
        metadata: {
          entity_key: "person:ben-book",
          entity_label: "Ben Book",
          entity_type: "person",
          target_tree_id: "interaction:person:ben-book",
          target_node_id: "semantic:interaction:interaction:person:ben-book:tree",
        },
      },
    ],
  });

  try {
    const relatedDetail = await readMemoryBrowserNodeDetail({
      store,
      workspaceId: "workspace-1",
      nodeId: "semantic:related:person:ben-book",
    });

    assert.equal(relatedDetail.kind, "node");
    assert.equal(relatedDetail.label, "Ben Book");
    assert.equal(relatedDetail.subtitle, "synthetic related person");
    assert.deepEqual(
      relatedDetail.incoming_relations.map((relation) => relation.target_resolution_kind).sort(),
      ["missing", "synthetic"],
    );
  } finally {
    store.close();
  }
});

test("readMemoryBrowserNodeDetail preserves custom relation types on selected nodes", async () => {
  const root = makeTempDir("hb-memory-browser-custom-relation-detail-");
  const workspaceRoot = path.join(root, "workspace");
  const workspace = {
    id: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
    errorMessage: null,
    onboardingStatus: "idle",
    onboardingState: null,
    onboardingSessionId: null,
    onboardingAlignmentQuestion: null,
    onboardingAlignmentReport: null,
    onboardingVerificationReport: null,
    onboardingCompletedAt: null,
    onboardingCompletionSummary: null,
    onboardingRequestedAt: null,
    onboardingRequestedBy: null,
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    deletedAtUtc: null,
    icon: null,
    iconColor: null,
    workspaceRole: "owner",
    sourceWorkspaceId: null,
  };
  const entity: InteractionEntityRecord = {
    workspaceId: "workspace-1",
    entityId: "interaction:topic:vendor-approval-policy",
    entityType: "topic",
    canonicalName: "Vendor approval policy",
    slug: "topic-vendor-approval-policy",
    summary: "Vendor policy memory.",
    aliases: [],
    isSystem: false,
    status: "active",
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
  const leafNode: SemanticMemoryNodeRecord = {
    workspaceId: "workspace-1",
    category: "workspace",
    treeId: entity.entityId,
    nodeId: "semantic:interaction:interaction:topic:vendor-approval-policy:leaf:leaf-1",
    nodeClass: "leaf",
    nodeKind: "leaf",
    sourceLeafId: "leaf-1",
    path: "semantic/workspace/knowledge/topic-vendor-approval-policy/leaf-1.md",
    title: "Vendor approval policy",
    summary: "Vendor changes require finance approval from Dana Moss.",
    bodySha256: "sha-leaf",
    childCount: 0,
    observedAt: "2026-06-03T00:00:00.000Z",
    status: "active",
    isMaterialized: false,
    metadata: {},
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
  const targetNode: SemanticMemoryNodeRecord = {
    workspaceId: "workspace-1",
    category: "workspace",
    treeId: "interaction:person:dana-moss",
    nodeId: "semantic:interaction:interaction:person:dana-moss:root",
    nodeClass: "semantic",
    nodeKind: "tree",
    sourceLeafId: null,
    path: "semantic/workspace/people/person-dana-moss/content.md",
    title: "Dana Moss",
    summary: "Finance approver.",
    bodySha256: "sha-dana",
    childCount: 0,
    observedAt: "2026-06-03T00:00:00.000Z",
    status: "active",
    isMaterialized: false,
    metadata: {},
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
  const store = {
    workspaceRoot,
    getWorkspaceRuntimeMetadata() {
      return null;
    },
    setWorkspaceRuntimeMetadata() {
      return undefined;
    },
    workspaceDir(workspaceId: string) {
      return path.join(workspaceRoot, workspaceId);
    },
    getWorkspace(workspaceId: string) {
      return workspaceId === workspace.id ? workspace : null;
    },
    listInteractionEntities() {
      return [entity];
    },
    listIntegrationConnections() {
      return [];
    },
    listIntegrationTrees() {
      return [];
    },
    listSemanticMemoryNodes() {
      return [];
    },
    getSemanticMemoryNode(params: { category: "interaction" | "workspace"; treeId: string; nodeId: string }) {
      if (params.category !== "workspace") {
        return null;
      }
      if (params.treeId === entity.entityId && params.nodeId === leafNode.nodeId) {
        return leafNode;
      }
      if (params.treeId === targetNode.treeId && params.nodeId === targetNode.nodeId) {
        return targetNode;
      }
      return null;
    },
    listSemanticMemoryRelations(params: { category: "interaction" | "workspace"; treeId?: string | null }) {
      if (params.category !== "workspace" || params.treeId !== entity.entityId) {
        return [];
      }
      return [
        {
          workspaceId: "workspace-1",
          category: "workspace",
          treeId: entity.entityId,
          fromNodeId: leafNode.nodeId,
          toNodeId: "semantic:related:person:dana-moss",
          relationType: "requires_approval_from",
          metadata: {
            entity_key: "person:dana-moss",
            entity_label: "Dana Moss",
            entity_type: "person",
            target_tree_id: targetNode.treeId,
            target_node_id: targetNode.nodeId,
            resolved_target_kind: "resolved",
          },
          createdAt: "2026-06-03T00:00:00.000Z",
          updatedAt: "2026-06-03T00:00:00.000Z",
        },
      ];
    },
    listSemanticMemoryEvidenceRefs() {
      return [];
    },
  } as unknown as RuntimeStateStore;

  const detail = await readMemoryBrowserNodeDetail({
    store,
    workspaceId: "workspace-1",
    nodeId: leafNode.nodeId,
    treeId: entity.entityId,
  });

  assert.equal(detail.outgoing_relations[0]?.target_label, "Dana Moss");
  assert.equal(detail.outgoing_relations[0]?.relation_type, "requires_approval_from");
  assert.equal(detail.outgoing_relations[0]?.target_resolution_kind, "resolved");
});

test("memory browser attaches interaction trees under workspace sections in the unified graph", async () => {
  const root = makeTempDir("hb-memory-browser-interaction-");
  const workspaceRoot = path.join(root, "workspace");
  const workspace = {
    id: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
    errorMessage: null,
    onboardingStatus: "idle",
    onboardingState: null,
    onboardingSessionId: null,
    onboardingAlignmentQuestion: null,
    onboardingAlignmentReport: null,
    onboardingVerificationReport: null,
    onboardingCompletedAt: null,
    onboardingCompletionSummary: null,
    onboardingRequestedAt: null,
    onboardingRequestedBy: null,
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:00.000Z",
    deletedAtUtc: null,
    icon: null,
    iconColor: null,
    workspaceRole: "owner",
    sourceWorkspaceId: null,
  };
  const entity: InteractionEntityRecord = {
    workspaceId: "workspace-1",
    entityId: "entity-project-1",
    entityType: "project",
    canonicalName: "Apollo",
    slug: "apollo",
    summary: "Core launch project.",
    aliases: [],
    isSystem: false,
    status: "active",
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:00.000Z",
  };
  const semanticNodes: SemanticMemoryNodeRecord[] = [
    {
      workspaceId: "workspace-1",
      category: "workspace",
      treeId: "entity-project-1",
      nodeId: "semantic:interaction:entity-project-1:tree",
      nodeClass: "semantic",
      nodeKind: "tree",
      sourceLeafId: null,
      path: "semantic/workspace/projects/apollo/content.md",
      title: "Apollo",
      summary: "Core launch project.",
      bodySha256: "sha-tree",
      childCount: 0,
      observedAt: "2026-05-24T00:00:00.000Z",
      status: "active",
      isMaterialized: false,
      metadata: {},
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    },
  ];
  const semanticFilePath = path.join(
    workspaceRoot,
    "workspace-1",
    "semantic",
    "workspace",
    "projects",
    "apollo",
    "content.md",
  );
  fs.mkdirSync(path.dirname(semanticFilePath), { recursive: true });
  fs.writeFileSync(
    semanticFilePath,
    "# Apollo\n\nCore launch project.\n",
    "utf8",
  );
  const store = {
    workspaceRoot,
    getWorkspaceRuntimeMetadata() {
      return null;
    },
    setWorkspaceRuntimeMetadata() {
      return undefined;
    },
    workspaceDir(workspaceId: string) {
      return path.join(workspaceRoot, workspaceId);
    },
    getWorkspace(workspaceId: string) {
      return workspaceId === workspace.id ? workspace : null;
    },
    getInteractionEntity(params: { workspaceId: string; entityId: string }) {
      return params.workspaceId === entity.workspaceId && params.entityId === entity.entityId
        ? entity
        : null;
    },
    listInteractionEntities() {
      return [entity];
    },
    listSemanticMemoryNodes(params: {
      category: "interaction" | "workspace";
      treeId?: string | null;
    }) {
      if (
        params.category === "workspace"
        && (params.treeId == null || params.treeId === entity.entityId)
      ) {
        return semanticNodes;
      }
      return [];
    },
    listIntegrationConnections() {
      return [];
    },
    listIntegrationTrees() {
      return [];
    },
    listSemanticMemoryChildren() {
      return [];
    },
    listSemanticMemoryRelations() {
      return [];
    },
  } as unknown as RuntimeStateStore;

  const tree = await buildMemoryBrowserTree({
    store,
    workspaceId: "workspace-1",
  });
  assert.deepEqual(
    (tree.root.children ?? []).map((child) => child.name),
    ["workspace"],
  );
  const workspaceDirectory = (tree.root.children ?? []).find((child) => child.name === "workspace");
  assert.ok(workspaceDirectory && workspaceDirectory.kind === "directory");
  const projectsDirectory = (workspaceDirectory.children ?? []).find((child) => child.name === "projects");
  assert.ok(projectsDirectory && projectsDirectory.kind === "directory");
  const apolloDirectory = (projectsDirectory.children ?? []).find((child) => child.name === "apollo");
  assert.ok(apolloDirectory && apolloDirectory.kind === "directory");
  const contentFile = (apolloDirectory.children ?? []).find((child) => child.name === "content.md");
  assert.ok(contentFile && contentFile.kind === "file");
  assert.equal(contentFile.path, "workspace/projects/apollo/content.md");

  const file = await readMemoryBrowserFile({
    store,
    workspaceId: "workspace-1",
    targetPath: "workspace/projects/apollo/content.md",
  });
  assert.match(file.content, /Core launch project\./);

  const workspaceGraph = await buildMemoryBrowserGraph({
    store,
    workspaceId: "workspace-1",
    forest: "workspace",
  });
  assert.equal(workspaceGraph.forest, "workspace");

  const projectsSection = workspaceGraph.nodes.find(
    (node) =>
      node.kind === "section"
      && node.category === "workspace"
      && node.label === "Projects",
  );
  assert.ok(projectsSection);
  assert.ok(
    workspaceGraph.nodes.some(
      (node) =>
        node.category === "workspace"
        && node.tree_id === entity.entityId
        && node.kind === "tree"
        && node.path === "workspace/projects/apollo/content.md",
    ),
  );
  assert.ok(
    workspaceGraph.edges.some(
      (edge) =>
        edge.kind === "contains"
        && edge.to === projectsSection.id,
    ),
  );
  assert.ok(
    workspaceGraph.edges.some(
      (edge) =>
        edge.kind === "contains"
        && edge.from === projectsSection.id
        && edge.to === "semantic:interaction:entity-project-1:tree",
    ),
  );
});
