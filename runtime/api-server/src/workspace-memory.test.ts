import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import type {
  IntegrationConnectionRecord,
  IntegrationTreeRecord,
  InteractionEntityRecord,
  RuntimeStateStore,
  SemanticMemoryNodeRecord,
} from "@holaboss/runtime-state-store";

import {
  buildRecalledWorkspaceMemoryContext,
  buildWorkspaceVectorFirstPassHits,
  retrieveWorkspaceMemory,
} from "./workspace-memory.js";

const tempDirs: string[] = [];
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  HB_SANDBOX_ROOT: process.env.HB_SANDBOX_ROOT,
  HOLABOSS_RUNTIME_CONFIG_PATH: process.env.HOLABOSS_RUNTIME_CONFIG_PATH,
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_ENV.HB_SANDBOX_ROOT === undefined) {
    delete process.env.HB_SANDBOX_ROOT;
  } else {
    process.env.HB_SANDBOX_ROOT = ORIGINAL_ENV.HB_SANDBOX_ROOT;
  }
  if (ORIGINAL_ENV.HOLABOSS_RUNTIME_CONFIG_PATH === undefined) {
    delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  } else {
    process.env.HOLABOSS_RUNTIME_CONFIG_PATH = ORIGINAL_ENV.HOLABOSS_RUNTIME_CONFIG_PATH;
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeRuntimeConfig(root: string): void {
  const configPath = path.join(root, "state", "runtime-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      runtime: {
        default_provider: "openai_direct",
        default_model: "openai_direct/gpt-5.4",
        background_tasks: {
          provider: "openai_direct",
          model: "gpt-5.4-mini",
        },
      },
      providers: {
        openai_direct: {
          kind: "openai_compatible",
          base_url: "https://runtime.example/api/v1/model-proxy/openai/v1",
          api_key: "token-1",
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  process.env.HB_SANDBOX_ROOT = root;
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;
}

function makeStoreFixture(root: string, options: {
  includeIntegrationConnections?: boolean;
  includeIntegrationLeaves?: boolean;
  includeIntegrationSearchDocs?: boolean;
  interactionRelationType?: string;
  interactionRelationMetadata?: Record<string, unknown>;
  outputArtifactFixture?: {
    treeId: string;
    title: string;
    outputId: string;
    filePath?: string;
  } | null;
  toolResultArtifactFixture?: {
    treeId: string;
    title: string;
    providerId: string;
    accountNamespace: string;
    toolName: string;
    toolId?: string | null;
    callId?: string | null;
    outputEventId?: number | null;
  } | null;
  additionalResolverEntities?: InteractionEntityRecord[];
  additionalInteractionMemories?: Array<{
    entityId: string;
    canonicalName: string;
    entityType?: InteractionEntityRecord["entityType"];
    nodeId: string;
    title: string;
    summary: string;
    bodyText?: string;
    relationType?: string;
    relationMetadata?: Record<string, unknown>;
    observedAt?: string;
    updatedAt?: string;
    embeddingVector?: number[];
  }>;
  additionalSemanticRelations?: Array<{
    category?: "workspace";
    treeId: string;
    fromNodeId: string;
    toNodeId: string;
    relationType: string;
    metadata?: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
  }>;
} = {}): RuntimeStateStore {
  const workspaceId = "workspace-1";
  const workspaceRoot = path.join(root, "workspace");
  const workspaceDir = path.join(workspaceRoot, workspaceId);
  const interactionEntity: InteractionEntityRecord = {
    workspaceId,
    entityId: "interaction:workflow:deploy",
    entityType: "workflow",
    canonicalName: "Deploy workflow",
    slug: "workflow-deploy",
    summary: "Deploy workflow memory.",
    aliases: [],
    isSystem: false,
    status: "active",
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
  };
  const integrationConnection: IntegrationConnectionRecord = {
    connectionId: "gmail-1",
    providerId: "gmail",
    ownerUserId: "user-1",
    accountLabel: "Ops Gmail",
    accountHandle: "ops@example.com",
    accountEmail: "ops@example.com",
    accountExternalId: "acct-gmail-1",
    contextCronAutoFetchEnabled: true,
    authMode: "oauth",
    grantedScopes: [],
    status: "active",
    secretRef: null,
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
  };
  const integrationTree: IntegrationTreeRecord = {
    workspaceId,
    treeId: "integration:gmail:acct-1",
    provider: "gmail",
    ownerUserId: "user-1",
    accountNamespace: "ops@example.com",
    accountDisplayName: "Ops Gmail",
    accountKey: "ops@example.com",
    accountLabel: "Ops Gmail",
    slug: "gmail-ops-example-com-acct-1",
    summary: "Inbox memory.",
    status: "active",
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
  };
  const interactionNode: SemanticMemoryNodeRecord = {
    workspaceId,
    category: "workspace",
    treeId: interactionEntity.entityId,
    nodeId: "semantic:interaction:deploy:leaf-1",
    nodeClass: "leaf",
    nodeKind: "leaf",
    sourceLeafId: "leaf-1",
    path: "semantic/workspace/processes/workflow-deploy/leaf-1.md",
    title: "Deploy approver",
    summary: "Maya owns release approvals.",
    bodySha256: "sha-interaction",
    childCount: 0,
    observedAt: "2026-05-21T00:00:00.000Z",
    status: "active",
    isMaterialized: true,
    metadata: {},
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  };
  const integrationNode: SemanticMemoryNodeRecord = {
    workspaceId,
    category: "workspace",
    treeId: integrationTree.treeId,
    nodeId: "semantic:integration:gmail:acct-1:thread:1",
    nodeClass: "leaf",
    nodeKind: "leaf",
    sourceLeafId: "leaf-thread-1",
    path: "semantic/workspace/systems/integrations/gmail-ops-example-com-acct-1/thread-1.md",
    title: "Customer escalation waiting on reply",
    summary: "Customer thread is waiting on a reply before Friday.",
    bodySha256: "sha-integration",
    childCount: 0,
    observedAt: "2026-05-24T00:00:00.000Z",
    status: "active",
    isMaterialized: true,
    metadata: {},
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:00.000Z",
  };
  const integrationRootNode: SemanticMemoryNodeRecord = {
    workspaceId,
    category: "workspace",
    treeId: integrationTree.treeId,
    nodeId: "semantic:integration:gmail:acct-1:connection",
    nodeClass: "semantic",
    nodeKind: "connection",
    sourceLeafId: null,
    path: "semantic/workspace/systems/integrations/gmail-ops-example-com-acct-1/content.md",
    title: "Ops Gmail",
    summary: "Inbox memory.",
    bodySha256: "sha-integration-root",
    childCount: 1,
    observedAt: "2026-05-24T00:00:00.000Z",
    status: "active",
    isMaterialized: false,
    metadata: {
      provider: "gmail",
      account_namespace: "ops@example.com",
    },
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:00.000Z",
  };
  const integrationLeaf = {
    workspaceId,
    leafId: "leaf-thread-1",
    treeId: integrationTree.treeId,
    subjectKey: "thread:1",
    entityKey: "thread:1",
    entityLabel: "Customer escalation thread",
    branchKey: "threads",
    branchLabel: "Threads",
    path: "integration/accounts/gmail-ops-example-com-acct-1/leaves/leaf-thread-1.md",
    title: integrationNode.title,
    summary: integrationNode.summary,
    fingerprint: "integration-fingerprint",
    bodySha256: "integration-body-sha",
    tags: ["gmail"],
    sourceType: "gmail.thread",
    sourceEventId: "evt-1",
    sourceMessageId: "msg-1",
    externalObjectId: "thread-1",
    externalObjectType: "thread",
    admissionConfidence: 0.95,
    observedAt: integrationNode.observedAt,
    supersedesLeafId: null,
    supersededAt: null,
    status: "active" as const,
    createdAt: "2026-05-24T00:00:00.000Z",
    updatedAt: "2026-05-24T00:00:00.000Z",
  };

  const interactionMemories = [
    {
      entity: interactionEntity,
      node: interactionNode,
      bodyText: "Deploy approver Maya owns release approvals.",
      relationType: options.interactionRelationType ?? "mentions",
      relationMetadata: {
        entity_key: "person:ben-book",
        entity_label: "Ben Book",
        entity_type: "person",
        ...(options.interactionRelationMetadata ?? {}),
      },
      embeddingVector: [0.9, 0.1],
    },
    ...(options.additionalInteractionMemories ?? []).map((memory, index) => ({
      entity: {
        workspaceId,
        entityId: memory.entityId,
        entityType: memory.entityType ?? "workflow",
        canonicalName: memory.canonicalName,
        slug: `workflow-${index + 2}`,
        summary: `${memory.canonicalName} memory.`,
        aliases: [],
        isSystem: false,
        status: "active" as const,
        createdAt: memory.observedAt ?? "2026-05-22T00:00:00.000Z",
        updatedAt: memory.updatedAt ?? memory.observedAt ?? "2026-05-22T00:00:00.000Z",
      },
      node: {
        workspaceId,
        category: "workspace" as const,
        treeId: memory.entityId,
        nodeId: memory.nodeId,
        nodeClass: "leaf" as const,
        nodeKind: "leaf",
        sourceLeafId: `leaf-extra-${index + 1}`,
        path: `semantic/workspace/processes/workflow-${index + 2}/leaf-1.md`,
        title: memory.title,
        summary: memory.summary,
        bodySha256: `sha-interaction-extra-${index + 1}`,
        childCount: 0,
        observedAt: memory.observedAt ?? "2026-05-22T00:00:00.000Z",
        status: "active" as const,
        isMaterialized: true,
        metadata: {},
        createdAt: memory.observedAt ?? "2026-05-22T00:00:00.000Z",
        updatedAt: memory.updatedAt ?? memory.observedAt ?? "2026-05-22T00:00:00.000Z",
      } satisfies SemanticMemoryNodeRecord,
      bodyText: memory.bodyText ?? `${memory.title} ${memory.summary}`,
      relationType: memory.relationType ?? "mentions",
      relationMetadata: memory.relationMetadata ?? {
        entity_key: "person:ben-book",
        entity_label: "Ben Book",
        entity_type: "person",
      },
      embeddingVector: memory.embeddingVector ?? [0.88, 0.12],
    })),
  ];
  const interactionEmbeddings = interactionMemories.map((memory, index) => ({
    workspaceId,
    nodeKind: "leaf",
    nodeId: memory.node.nodeId,
    entityId: memory.entity.entityId,
    embeddingModel: "text-embedding-3-small",
    contentFingerprint: `f-interaction-${index + 1}`,
    dimensions: 2,
    vector: memory.embeddingVector,
    createdAt: memory.node.createdAt,
    updatedAt: memory.node.updatedAt,
  }));
  const integrationEmbeddings = [
    {
      workspaceId,
      nodeKind: "leaf",
      nodeId: integrationNode.nodeId,
      treeId: integrationTree.treeId,
      embeddingModel: "text-embedding-3-small",
      contentFingerprint: "f2",
      dimensions: 2,
      vector: [1, 0],
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    },
  ];
  const outputArtifactRootNode = options.outputArtifactFixture
    ? {
        workspaceId,
        category: "workspace" as const,
        treeId: options.outputArtifactFixture.treeId,
        nodeId: `${options.outputArtifactFixture.treeId}:root`,
        nodeClass: "semantic" as const,
        nodeKind: "output_document",
        sourceLeafId: null,
        path: `semantic/workspace/artifacts/outputs/${options.outputArtifactFixture.outputId}/content.md`,
        title: options.outputArtifactFixture.title,
        summary: `${options.outputArtifactFixture.title} artifact.`,
        bodySha256: `sha-output-root-${options.outputArtifactFixture.outputId}`,
        childCount: 1,
        observedAt: "2026-05-25T00:00:00.000Z",
        status: "active" as const,
        isMaterialized: true,
        metadata: {
          output_id: options.outputArtifactFixture.outputId,
          output_type: "document",
          file_path: options.outputArtifactFixture.filePath ?? options.outputArtifactFixture.title,
          source_turn_input_id: "turn-output-1",
        },
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z",
      } satisfies SemanticMemoryNodeRecord
    : null;
  const outputArtifactChunkNode = options.outputArtifactFixture
    ? {
        workspaceId,
        category: "workspace" as const,
        treeId: options.outputArtifactFixture.treeId,
        nodeId: `${options.outputArtifactFixture.treeId}:chunk:1`,
        nodeClass: "leaf" as const,
        nodeKind: "output_chunk",
        sourceLeafId: null,
        path: `semantic/workspace/artifacts/outputs/${options.outputArtifactFixture.outputId}/chunk-1.md`,
        title: `${options.outputArtifactFixture.title} chunk 1`,
        summary: "Artifact chunk.",
        bodySha256: `sha-output-chunk-${options.outputArtifactFixture.outputId}`,
        childCount: 0,
        observedAt: "2026-05-25T00:00:00.000Z",
        status: "active" as const,
        isMaterialized: true,
        metadata: {
          output_id: options.outputArtifactFixture.outputId,
          output_type: "document",
          file_path: options.outputArtifactFixture.filePath ?? options.outputArtifactFixture.title,
          source_turn_input_id: "turn-output-1",
        },
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z",
      } satisfies SemanticMemoryNodeRecord
    : null;
  const toolResultArtifactRootNode = options.toolResultArtifactFixture
    ? {
        workspaceId,
        category: "workspace" as const,
        treeId: options.toolResultArtifactFixture.treeId,
        nodeId: `${options.toolResultArtifactFixture.treeId}:root`,
        nodeClass: "semantic" as const,
        nodeKind: "tool_result_document",
        sourceLeafId: null,
        path: `semantic/workspace/artifacts/tool-results/${options.toolResultArtifactFixture.providerId}/${options.toolResultArtifactFixture.callId ?? "call-1"}/content.md`,
        title: options.toolResultArtifactFixture.title,
        summary: `${options.toolResultArtifactFixture.title} artifact.`,
        bodySha256: `sha-tool-result-root-${options.toolResultArtifactFixture.callId ?? "call-1"}`,
        childCount: 1,
        observedAt: "2026-05-25T00:00:00.000Z",
        status: "active" as const,
        isMaterialized: true,
        metadata: {
          provider_id: options.toolResultArtifactFixture.providerId,
          account_namespace: options.toolResultArtifactFixture.accountNamespace,
          tool_name: options.toolResultArtifactFixture.toolName,
          tool_id: options.toolResultArtifactFixture.toolId ?? null,
          call_id: options.toolResultArtifactFixture.callId ?? null,
          output_event_id: options.toolResultArtifactFixture.outputEventId ?? null,
          source_turn_input_id: "turn-output-1",
        },
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z",
      } satisfies SemanticMemoryNodeRecord
    : null;
  const toolResultArtifactChunkNode = options.toolResultArtifactFixture
    ? {
        workspaceId,
        category: "workspace" as const,
        treeId: options.toolResultArtifactFixture.treeId,
        nodeId: `${options.toolResultArtifactFixture.treeId}:chunk:1`,
        nodeClass: "leaf" as const,
        nodeKind: "tool_result_chunk",
        sourceLeafId: null,
        path: `semantic/workspace/artifacts/tool-results/${options.toolResultArtifactFixture.providerId}/${options.toolResultArtifactFixture.callId ?? "call-1"}/chunk-1.md`,
        title: `${options.toolResultArtifactFixture.title} chunk 1`,
        summary: "Tool result chunk.",
        bodySha256: `sha-tool-result-chunk-${options.toolResultArtifactFixture.callId ?? "call-1"}`,
        childCount: 0,
        observedAt: "2026-05-25T00:00:00.000Z",
        status: "active" as const,
        isMaterialized: true,
        metadata: {
          provider_id: options.toolResultArtifactFixture.providerId,
          account_namespace: options.toolResultArtifactFixture.accountNamespace,
          tool_name: options.toolResultArtifactFixture.toolName,
          tool_id: options.toolResultArtifactFixture.toolId ?? null,
          call_id: options.toolResultArtifactFixture.callId ?? null,
          output_event_id: options.toolResultArtifactFixture.outputEventId ?? null,
          source_turn_input_id: "turn-output-1",
        },
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z",
      } satisfies SemanticMemoryNodeRecord
    : null;
  const semanticNodes = new Map<string, SemanticMemoryNodeRecord>([
    ...interactionMemories.map((memory) => [
      `workspace:${memory.entity.entityId}:${memory.node.nodeId}`,
      memory.node,
    ] as const),
    [`workspace:${integrationTree.treeId}:${integrationRootNode.nodeId}`, integrationRootNode],
    [`workspace:${integrationTree.treeId}:${integrationNode.nodeId}`, integrationNode],
    ...(outputArtifactRootNode
      ? [[`workspace:${outputArtifactRootNode.treeId}:${outputArtifactRootNode.nodeId}`, outputArtifactRootNode] as const]
      : []),
    ...(outputArtifactChunkNode
      ? [[`workspace:${outputArtifactChunkNode.treeId}:${outputArtifactChunkNode.nodeId}`, outputArtifactChunkNode] as const]
      : []),
    ...(toolResultArtifactRootNode
      ? [[`workspace:${toolResultArtifactRootNode.treeId}:${toolResultArtifactRootNode.nodeId}`, toolResultArtifactRootNode] as const]
      : []),
    ...(toolResultArtifactChunkNode
      ? [[`workspace:${toolResultArtifactChunkNode.treeId}:${toolResultArtifactChunkNode.nodeId}`, toolResultArtifactChunkNode] as const]
      : []),
  ]);
  const semanticSearchDocs = [
    ...interactionMemories.map((memory) => ({
      workspaceId,
      category: "workspace" as const,
      treeId: memory.entity.entityId,
      nodeId: memory.node.nodeId,
      nodeClass: memory.node.nodeClass,
      nodeKind: memory.node.nodeKind,
      path: memory.node.path,
      childCount: memory.node.childCount,
      title: memory.node.title,
      summary: memory.node.summary,
      bodyText: memory.bodyText,
      excerpt: memory.bodyText,
      observedAt: memory.node.observedAt,
      status: memory.node.status,
      updatedAt: memory.node.updatedAt,
    })),
    {
      workspaceId,
      category: "workspace" as const,
      treeId: integrationTree.treeId,
      nodeId: integrationNode.nodeId,
      nodeClass: integrationNode.nodeClass,
      nodeKind: integrationNode.nodeKind,
      path: integrationNode.path,
      childCount: integrationNode.childCount,
      title: integrationNode.title,
      summary: integrationNode.summary,
      bodyText: "Customer escalation waiting on reply before Friday.",
      excerpt: "Customer escalation waiting on reply before Friday.",
      observedAt: integrationNode.observedAt,
      status: integrationNode.status,
      updatedAt: integrationNode.updatedAt,
    },
    ...(outputArtifactRootNode
      ? [{
          workspaceId,
          category: "workspace" as const,
          treeId: outputArtifactRootNode.treeId,
          nodeId: outputArtifactRootNode.nodeId,
          nodeClass: outputArtifactRootNode.nodeClass,
          nodeKind: outputArtifactRootNode.nodeKind,
          path: outputArtifactRootNode.path,
          childCount: outputArtifactRootNode.childCount,
          title: outputArtifactRootNode.title,
          summary: outputArtifactRootNode.summary,
          bodyText: `${outputArtifactRootNode.title} output artifact`,
          excerpt: `${outputArtifactRootNode.title} output artifact`,
          observedAt: outputArtifactRootNode.observedAt,
          status: outputArtifactRootNode.status,
          updatedAt: outputArtifactRootNode.updatedAt,
        }]
      : []),
    ...(outputArtifactChunkNode
      ? [{
          workspaceId,
          category: "workspace" as const,
          treeId: outputArtifactChunkNode.treeId,
          nodeId: outputArtifactChunkNode.nodeId,
          nodeClass: outputArtifactChunkNode.nodeClass,
          nodeKind: outputArtifactChunkNode.nodeKind,
          path: outputArtifactChunkNode.path,
          childCount: outputArtifactChunkNode.childCount,
          title: outputArtifactChunkNode.title,
          summary: outputArtifactChunkNode.summary,
          bodyText: `${options.outputArtifactFixture?.title} chunk text`,
          excerpt: `${options.outputArtifactFixture?.title} chunk text`,
          observedAt: outputArtifactChunkNode.observedAt,
          status: outputArtifactChunkNode.status,
          updatedAt: outputArtifactChunkNode.updatedAt,
        }]
      : []),
    ...(toolResultArtifactRootNode
      ? [{
          workspaceId,
          category: "workspace" as const,
          treeId: toolResultArtifactRootNode.treeId,
          nodeId: toolResultArtifactRootNode.nodeId,
          nodeClass: toolResultArtifactRootNode.nodeClass,
          nodeKind: toolResultArtifactRootNode.nodeKind,
          path: toolResultArtifactRootNode.path,
          childCount: toolResultArtifactRootNode.childCount,
          title: toolResultArtifactRootNode.title,
          summary: toolResultArtifactRootNode.summary,
          bodyText: `${toolResultArtifactRootNode.title} output artifact`,
          excerpt: `${toolResultArtifactRootNode.title} output artifact`,
          observedAt: toolResultArtifactRootNode.observedAt,
          status: toolResultArtifactRootNode.status,
          updatedAt: toolResultArtifactRootNode.updatedAt,
        }]
      : []),
    ...(toolResultArtifactChunkNode
      ? [{
          workspaceId,
          category: "workspace" as const,
          treeId: toolResultArtifactChunkNode.treeId,
          nodeId: toolResultArtifactChunkNode.nodeId,
          nodeClass: toolResultArtifactChunkNode.nodeClass,
          nodeKind: toolResultArtifactChunkNode.nodeKind,
          path: toolResultArtifactChunkNode.path,
          childCount: toolResultArtifactChunkNode.childCount,
          title: toolResultArtifactChunkNode.title,
          summary: toolResultArtifactChunkNode.summary,
          bodyText: `${options.toolResultArtifactFixture?.title} chunk text`,
          excerpt: `${options.toolResultArtifactFixture?.title} chunk text`,
          observedAt: toolResultArtifactChunkNode.observedAt,
          status: toolResultArtifactChunkNode.status,
          updatedAt: toolResultArtifactChunkNode.updatedAt,
        }]
      : []),
  ].filter((doc) =>
    doc.category !== "workspace" || options.includeIntegrationSearchDocs !== false
  );
  const semanticRelations = interactionMemories.map((memory) => ({
    workspaceId,
    category: "workspace" as const,
    treeId: memory.entity.entityId,
    fromNodeId: memory.node.nodeId,
    toNodeId: "semantic:related:person:ben-book",
    relationType: memory.relationType,
    metadata: memory.relationMetadata,
    createdAt: memory.node.createdAt,
    updatedAt: memory.node.updatedAt,
  })).concat((options.additionalSemanticRelations ?? []).map((relation) => ({
    workspaceId,
    category: relation.category ?? "workspace",
    treeId: relation.treeId,
    fromNodeId: relation.fromNodeId,
    toNodeId: relation.toNodeId,
    relationType: relation.relationType,
    metadata: relation.metadata ?? {},
    createdAt: relation.createdAt ?? "2026-05-25T00:00:00.000Z",
    updatedAt: relation.updatedAt ?? relation.createdAt ?? "2026-05-25T00:00:00.000Z",
  })));
  const searchDocsFor = (params: {
    category: "interaction" | "workspace";
    workspaceId?: string | null;
    treeId?: string | null;
    treeIds?: string[] | null;
    nodeIds?: string[] | null;
    nodeClass?: string | null;
    status?: string | null;
    matchQuery?: string | null;
    limit?: number | null;
    offset?: number | null;
  }) => {
    const normalizedTreeIds = params.treeIds
      ? new Set(params.treeIds.filter(Boolean))
      : null;
    const normalizedNodeIds = params.nodeIds
      ? new Set(params.nodeIds.filter(Boolean))
      : null;
    const query = (params.matchQuery ?? "").toLowerCase();
    const filtered = semanticSearchDocs
      .filter((doc) => doc.category === params.category)
      .filter((doc) => params.workspaceId === undefined || doc.workspaceId === params.workspaceId)
      .filter((doc) => params.treeId === undefined || doc.treeId === params.treeId)
      .filter((doc) => !normalizedTreeIds || normalizedTreeIds.has(doc.treeId))
      .filter((doc) => !normalizedNodeIds || normalizedNodeIds.has(doc.nodeId))
      .filter((doc) => params.nodeClass == null || doc.nodeClass === params.nodeClass)
      .filter((doc) => params.status == null || doc.status === params.status)
      .filter((doc) => !query
        || doc.title.toLowerCase().includes(query)
        || doc.summary.toLowerCase().includes(query)
        || doc.bodyText.toLowerCase().includes(query)
        || doc.excerpt?.toLowerCase().includes(query));
    const offset = Math.max(0, params.offset ?? 0);
    const limit = Math.max(0, params.limit ?? filtered.length);
    return filtered.slice(offset, offset + limit);
  };
  const workspaceRuntimeMetadata = new Map<string, string>();

  return {
    getWorkspaceRuntimeMetadata(args: { workspaceId: string; key: string }) {
      return args.workspaceId === workspaceId ? workspaceRuntimeMetadata.get(args.key) ?? null : null;
    },
    setWorkspaceRuntimeMetadata(args: { workspaceId: string; key: string; value: string }) {
      if (args.workspaceId === workspaceId) {
        workspaceRuntimeMetadata.set(args.key, args.value);
      }
    },
    workspaceRoot,
    workspaceDir(targetWorkspaceId: string) {
      return path.join(workspaceRoot, targetWorkspaceId);
    },
    listInteractionEntities(params: { workspaceId: string }) {
      return params.workspaceId === workspaceId
        ? [
            ...interactionMemories.map((memory) => memory.entity),
            ...(options.additionalResolverEntities ?? []),
          ]
        : [];
    },
    getInteractionEntity(params: { workspaceId: string; entityId: string }) {
      return params.workspaceId === workspaceId
        ? interactionMemories.find((memory) => memory.entity.entityId === params.entityId)?.entity
          ?? options.additionalResolverEntities?.find((entity) => entity.entityId === params.entityId)
          ?? null
        : null;
    },
    listInteractionNodeEmbeddings(params: { workspaceId: string; embeddingModel?: string | null; nodeIds?: string[] | null }) {
      const normalizedNodeIds = params.nodeIds ? new Set(params.nodeIds.filter(Boolean)) : null;
      return interactionEmbeddings.filter((record) =>
        record.workspaceId === params.workspaceId
        && (params.embeddingModel == null || record.embeddingModel === params.embeddingModel)
        && (!normalizedNodeIds || normalizedNodeIds.has(record.nodeId))
      );
    },
    listIntegrationNodeEmbeddings(params: {
      workspaceId?: string | null;
      embeddingModel?: string | null;
      nodeIds?: string[] | null;
    }) {
      const normalizedNodeIds = params.nodeIds ? new Set(params.nodeIds.filter(Boolean)) : null;
      return integrationEmbeddings.filter((record) =>
        (params.workspaceId == null || record.workspaceId === params.workspaceId)
        && (params.embeddingModel == null || record.embeddingModel === params.embeddingModel)
      ).filter((record) => !normalizedNodeIds || normalizedNodeIds.has(record.nodeId));
    },
    getSemanticMemoryNode(params: { category: "interaction" | "workspace"; treeId: string; nodeId: string; workspaceId?: string | null }) {
      return semanticNodes.get(`${params.category}:${params.treeId}:${params.nodeId}`) ?? null;
    },
    listSemanticMemoryNodes(params: {
      category: "interaction" | "workspace";
      workspaceId?: string | null;
      treeId?: string | null;
      nodeKind?: string | null;
      status?: string | null;
    }) {
      return [...semanticNodes.values()].filter((node) =>
        node.category === params.category
        && (params.workspaceId == null || node.workspaceId === params.workspaceId)
        && (params.treeId == null || node.treeId === params.treeId)
        && (params.nodeKind == null || node.nodeKind === params.nodeKind)
        && (params.status == null || node.status === params.status)
      );
    },
    listSemanticMemorySearchDocs(params: {
      category: "interaction" | "workspace";
      workspaceId?: string | null;
      treeId?: string | null;
      treeIds?: string[] | null;
      nodeIds?: string[] | null;
      nodeClass?: string | null;
      status?: string | null;
      limit?: number | null;
      offset?: number | null;
    }) {
      return searchDocsFor(params);
    },
    searchSemanticMemorySearchDocs(params: {
      category: "interaction" | "workspace";
      workspaceId?: string | null;
      treeId?: string | null;
      treeIds?: string[] | null;
      nodeClass?: string | null;
      status?: string | null;
      matchQuery: string;
      limit?: number | null;
      offset?: number | null;
    }) {
      return searchDocsFor(params)
        .map((doc: ReturnType<typeof searchDocsFor>[number], index: number) => ({
          ...doc,
          bm25Score: index + 1,
        }));
    },
    syncSemanticMemoryRelations() {},
    listIntegrationConnections() {
      return options.includeIntegrationConnections === false ? [] : [integrationConnection];
    },
    listIntegrationTrees(params: { provider?: string | null; ownerUserId?: string | null; status?: string | null }) {
      return [integrationTree].filter((tree) =>
        (params.provider == null || tree.provider === params.provider)
        && (params.ownerUserId == null || tree.ownerUserId === params.ownerUserId)
        && (params.status == null || tree.status === params.status)
      );
    },
    listIntegrationLeaves(params: { workspaceId?: string | null; treeId?: string | null; status?: string | null }) {
      const leaves = options.includeIntegrationLeaves === false ? [] : [integrationLeaf];
      return leaves.filter((leaf) =>
        (params.workspaceId == null || leaf.workspaceId === params.workspaceId)
        && (params.treeId == null || leaf.treeId === params.treeId)
        && (params.status == null || leaf.status === params.status)
      );
    },
    listSemanticMemoryChildren() {
      return [];
    },
    listSemanticMemoryRelations(params: {
      category: "interaction" | "workspace";
      treeId?: string | null;
      fromNodeId?: string | null;
    }) {
      return semanticRelations.filter((relation) =>
        relation.category === params.category
        && (params.treeId == null || relation.treeId === params.treeId)
        && (params.fromNodeId == null || relation.fromNodeId === params.fromNodeId)
      );
    },
    getWorkspace() {
      return {
        id: workspaceId,
        name: "Workspace 1",
        harness: "pi",
        status: "active",
      };
    },
  } as unknown as RuntimeStateStore;
}

test("buildWorkspaceVectorFirstPassHits returns a unified cross-category vector shortlist", async () => {
  const root = makeTempDir("hb-workspace-memory-vector-");
  writeRuntimeConfig(root);
  globalThis.fetch = (async (input) => {
    const url = String(input);
    assert.match(url, /\/embeddings$/);
    return new Response(
      JSON.stringify({
        data: [
          {
            embedding: [1, 0],
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const result = await buildWorkspaceVectorFirstPassHits({
    store: makeStoreFixture(root),
    workspaceId: "workspace-1",
    query: "important email context",
    categories: ["interaction", "workspace"],
    maxCandidates: 6,
    selectedModel: "openai_direct/gpt-5.4",
    sessionId: "session-1",
    inputId: "input-1",
  });

  assert.equal(result.modelId, "text-embedding-3-small");
  assert.equal(result.integrationHits[0]?.title, "Customer escalation waiting on reply");
  assert.equal(result.integrationHits[0]?.reasons[1], "vector_first_pass");
  assert.equal(result.interactionHits[0]?.title, "Deploy approver");
});

test("retrieveWorkspaceMemory carries vector-first-pass evidence into the public retrieval result", async () => {
  const root = makeTempDir("hb-workspace-memory-retrieve-");
  writeRuntimeConfig(root);
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/embeddings")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              embedding: [1, 0],
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                ranked_ids: [
                  "semantic:integration:gmail:acct-1:thread:1",
                  "semantic:interaction:deploy:leaf-1",
                ],
                assessments: [
                  {
                    id: "semantic:integration:gmail:acct-1:thread:1",
                    bucket: "high_signal",
                    requires_live_verification: true,
                    reason: "Recent inbox context should be verified live.",
                  },
                ],
                recommended_next_source: "gmail",
                needs_live_verification: true,
                verification_reason: "Email state may have changed.",
              }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const result = await retrieveWorkspaceMemory({
    store: makeStoreFixture(root),
    workspaceId: "workspace-1",
    query: "Any important emails recently that I should be aware of?",
    selectedModel: "openai_direct/gpt-5.4",
    sessionId: "session-1",
    inputId: "input-1",
  });

  assert.equal(result.evidence[0]?.title, "Customer escalation waiting on reply");
  assert.ok(result.evidence[0]?.reasons.includes("vector_first_pass"));
  assert.ok(result.evidence[0]?.reasons.includes("llm_rerank"));
  assert.equal(result.retrieval_pack.recommended_next_source, "gmail");
});

test("retrieveWorkspaceMemory can return fast lexical bootstrap context without embeddings or LLM rerank", async () => {
  const root = makeTempDir("hb-workspace-memory-bootstrap-");
  writeRuntimeConfig(root);
  globalThis.fetch = (async () => {
    throw new Error("bootstrap retrieval should not call remote model endpoints");
  }) as typeof fetch;

  const result = await retrieveWorkspaceMemory({
    store: makeStoreFixture(root),
    workspaceId: "workspace-1",
    query: "Any important emails recently that I should be aware of?",
    selectedModel: "openai_direct/gpt-5.4",
    sessionId: "session-1",
    inputId: "input-1",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });

  assert.equal(result.evidence[0]?.title, "Customer escalation waiting on reply");
  assert.ok(result.evidence[0]?.reasons.includes("lexical_match"));
  assert.equal(result.evidence[0]?.reasons.includes("llm_rerank"), false);
  assert.equal(result.coverage.used_vector, false);
});

test("retrieveWorkspaceMemory can recall an interaction memory through related-entity relations", async () => {
  const root = makeTempDir("hb-workspace-memory-relations-");
  writeRuntimeConfig(root);
  globalThis.fetch = (async () => {
    throw new Error("relation-aware lexical retrieval should not call remote model endpoints");
  }) as typeof fetch;

  const result = await retrieveWorkspaceMemory({
    store: makeStoreFixture(root),
    workspaceId: "workspace-1",
    query: "Ben Book",
    selectedModel: "openai_direct/gpt-5.4",
    sessionId: "session-1",
    inputId: "input-1",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });

  assert.equal(result.evidence[0]?.title, "Deploy approver");
  assert.ok(result.evidence[0]?.reasons.includes("relation_match"));
});

test("retrieveWorkspaceMemory can recall an interaction memory through custom relation-type text", async () => {
  const root = makeTempDir("hb-workspace-memory-custom-relation-query-");
  writeRuntimeConfig(root);
  globalThis.fetch = (async () => {
    throw new Error("custom relation lexical retrieval should not call remote model endpoints");
  }) as typeof fetch;

  const result = await retrieveWorkspaceMemory({
    store: makeStoreFixture(root, {
      interactionRelationType: "requires_escalation_owner_for",
    }),
    workspaceId: "workspace-1",
    query: "escalation owner",
    selectedModel: "openai_direct/gpt-5.4",
    sessionId: "session-1",
    inputId: "input-1",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });

  assert.equal(result.evidence[0]?.title, "Deploy approver");
  assert.ok(result.evidence[0]?.reasons.includes("relation_match"));
});

test("retrieveWorkspaceMemory prefers resolved relation hits over recoverable synthetic ones for relation queries", async () => {
  const root = makeTempDir("hb-workspace-memory-relation-resolution-ranking-");
  writeRuntimeConfig(root);
  globalThis.fetch = (async () => {
    throw new Error("relation-resolution lexical retrieval should not call remote model endpoints");
  }) as typeof fetch;

  const result = await retrieveWorkspaceMemory({
    store: makeStoreFixture(root, {
      interactionRelationMetadata: {
        resolved_target_kind: "synthetic",
      },
      additionalResolverEntities: [
        {
          workspaceId: "workspace-1",
          entityId: "interaction:person:ben-book",
          entityType: "person",
          canonicalName: "Ben Book",
          slug: "person-ben-book",
          summary: "Contact memory.",
          aliases: [],
          isSystem: false,
          status: "active",
          createdAt: "2026-05-20T00:00:00.000Z",
          updatedAt: "2026-05-20T00:00:00.000Z",
        },
      ],
      additionalInteractionMemories: [
        {
          entityId: "interaction:workflow:release",
          canonicalName: "Release workflow",
          nodeId: "semantic:interaction:release:leaf-1",
          title: "Release approver",
          summary: "Maya owns release approvals.",
          bodyText: "Release approver Maya owns release approvals.",
          relationMetadata: {
            entity_key: "person:ben-book",
            entity_label: "Ben Book",
            entity_type: "person",
            target_tree_id: "interaction:person:ben-book",
            target_node_id: "semantic:interaction:person:ben-book:tree",
            resolved_target_kind: "resolved",
          },
          embeddingVector: [0.88, 0.12],
        },
      ],
    }),
    workspaceId: "workspace-1",
    query: "Ben Book",
    selectedModel: "openai_direct/gpt-5.4",
    sessionId: "session-1",
    inputId: "input-1",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });

  assert.equal(result.evidence[0]?.title, "Release approver");
  assert.ok(result.evidence[0]?.reasons.includes("resolved_relation_boost"));
  const syntheticHit = result.evidence.find((item) => item.title === "Deploy approver");
  assert.ok(syntheticHit);
  assert.ok(syntheticHit?.reasons.includes("synthetic_relation_penalty"));
});

test("retrieveWorkspaceMemory applies synthetic relation penalty for legacy resolver-recoverable relations without explicit resolved_target_kind metadata", async () => {
  const root = makeTempDir("hb-workspace-memory-legacy-relation-resolution-");
  writeRuntimeConfig(root);
  globalThis.fetch = (async () => {
    throw new Error("legacy relation lexical retrieval should not call remote model endpoints");
  }) as typeof fetch;

  const result = await retrieveWorkspaceMemory({
    store: makeStoreFixture(root, {
      interactionRelationMetadata: {},
      additionalResolverEntities: [
        {
          workspaceId: "workspace-1",
          entityId: "interaction:person:ben-book",
          entityType: "person",
          canonicalName: "Ben Book",
          slug: "person-ben-book",
          summary: "Contact memory.",
          aliases: [],
          isSystem: false,
          status: "active",
          createdAt: "2026-05-20T00:00:00.000Z",
          updatedAt: "2026-05-20T00:00:00.000Z",
        },
      ],
    }),
    workspaceId: "workspace-1",
    query: "Ben Book",
    selectedModel: "openai_direct/gpt-5.4",
    sessionId: "session-1",
    inputId: "input-1",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });

  assert.equal(result.evidence[0]?.title, "Deploy approver");
  assert.ok(result.evidence[0]?.reasons.includes("relation_match"));
  assert.ok(result.evidence[0]?.reasons.includes("synthetic_relation_penalty"));
});

test("retrieveWorkspaceMemory prefers artifact documents for artifact-oriented filename queries", async () => {
  const root = makeTempDir("hb-workspace-memory-artifact-query-ranking-");
  writeRuntimeConfig(root);
  globalThis.fetch = (async () => {
    throw new Error("artifact-oriented lexical retrieval should not call remote model endpoints");
  }) as typeof fetch;

  const result = await retrieveWorkspaceMemory({
    store: makeStoreFixture(root, {
      outputArtifactFixture: {
        treeId: "output-artifact:report-1",
        title: "notion-related-pages.md",
        outputId: "output-report-1",
        filePath: "outputs/notion-related-pages.md",
      },
      additionalInteractionMemories: [
        {
          entityId: "interaction:project:builder-mode",
          canonicalName: "Builder Mode",
          entityType: "project",
          nodeId: "semantic:interaction:builder-mode:leaf-1",
          title: "Builder Mode references the notion-related-pages.md report",
          summary: "The project memory references notion-related-pages.md as the research deliverable.",
          bodyText: "Builder Mode references notion-related-pages.md as the research deliverable.",
          relationType: "mentions",
          relationMetadata: {
            entity_key: "artifact:output:output-report-1",
            entity_label: "notion-related-pages.md",
            entity_type: "artifact",
            resolved_target_kind: "resolved",
          },
          embeddingVector: [0.88, 0.12],
        },
      ],
    }),
    workspaceId: "workspace-1",
    query: "notion-related-pages.md",
    selectedModel: "openai_direct/gpt-5.4",
    sessionId: "session-1",
    inputId: "input-1",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });

  assert.equal(result.evidence[0]?.tree_id, "output-artifact:report-1");
  assert.equal(result.evidence[0]?.entity_type, "artifact");
  assert.ok(result.evidence[0]?.reasons.includes("artifact_query_boost"));
  const derivedMemoryHit = result.evidence.find((item) => item.tree_id === "interaction:project:builder-mode");
  assert.ok(derivedMemoryHit);
  assert.ok(derivedMemoryHit?.reasons.includes("artifact_query_penalty"));
});

test("retrieveWorkspaceMemory prefers artifact documents for non-ASCII artifact title queries without filename cues", async () => {
  const root = makeTempDir("hb-workspace-memory-non-ascii-artifact-query-ranking-");
  writeRuntimeConfig(root);
  globalThis.fetch = (async () => {
    throw new Error("non-ASCII artifact-title lexical retrieval should not call remote model endpoints");
  }) as typeof fetch;

  const result = await retrieveWorkspaceMemory({
    store: makeStoreFixture(root, {
      outputArtifactFixture: {
        treeId: "output-artifact:cn-report-1",
        title: "主叙事阶段",
        outputId: "output-cn-report-1",
        filePath: "outputs/main-narrative-stage.md",
      },
      additionalInteractionMemories: [
        {
          entityId: "interaction:project:gtm-rollout",
          canonicalName: "GTM rollout",
          entityType: "project",
          nodeId: "semantic:interaction:gtm-rollout:leaf-1",
          title: "GTM rollout references 主叙事阶段",
          summary: "The project memory references 主叙事阶段 as the deliverable for the current rollout step.",
          bodyText: "GTM rollout references 主叙事阶段 as the current deliverable.",
          relationType: "mentions",
          relationMetadata: {
            entity_key: "artifact:output:output-cn-report-1",
            entity_label: "主叙事阶段",
            entity_type: "artifact",
            resolved_target_kind: "resolved",
          },
          embeddingVector: [0.88, 0.12],
        },
      ],
    }),
    workspaceId: "workspace-1",
    query: "主叙事阶段",
    selectedModel: "openai_direct/gpt-5.4",
    sessionId: "session-1",
    inputId: "input-1",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });

  assert.equal(result.evidence[0]?.tree_id, "output-artifact:cn-report-1");
  assert.equal(result.evidence[0]?.entity_type, "artifact");
  assert.ok(result.evidence[0]?.reasons.includes("artifact_title_match_boost"));
});

test("retrieveWorkspaceMemory treats non-ASCII filename queries as artifact-oriented and prefers artifact documents", async () => {
  const root = makeTempDir("hb-workspace-memory-non-ascii-filename-query-ranking-");
  writeRuntimeConfig(root);
  globalThis.fetch = (async () => {
    throw new Error("non-ASCII filename lexical retrieval should not call remote model endpoints");
  }) as typeof fetch;

  const result = await retrieveWorkspaceMemory({
    store: makeStoreFixture(root, {
      outputArtifactFixture: {
        treeId: "output-artifact:cn-report-1",
        title: "主叙事阶段.md",
        outputId: "output-cn-report-1",
        filePath: "outputs/main-narrative-stage.md",
      },
      additionalInteractionMemories: [
        {
          entityId: "interaction:project:gtm-rollout",
          canonicalName: "GTM rollout",
          entityType: "project",
          nodeId: "semantic:interaction:gtm-rollout:leaf-1",
          title: "GTM rollout references 主叙事阶段.md",
          summary: "The project memory references 主叙事阶段.md as the deliverable for the current rollout step.",
          bodyText: "GTM rollout references 主叙事阶段.md as the current deliverable.",
          relationType: "mentions",
          relationMetadata: {
            entity_key: "artifact:output:output-cn-report-1",
            entity_label: "主叙事阶段.md",
            entity_type: "artifact",
            resolved_target_kind: "resolved",
          },
          embeddingVector: [0.88, 0.12],
        },
      ],
    }),
    workspaceId: "workspace-1",
    query: "主叙事阶段.md",
    selectedModel: "openai_direct/gpt-5.4",
    sessionId: "session-1",
    inputId: "input-1",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });

  assert.equal(result.evidence[0]?.tree_id, "output-artifact:cn-report-1");
  assert.equal(result.evidence[0]?.entity_type, "artifact");
  assert.ok(result.evidence[0]?.reasons.includes("artifact_query_boost"));
});

test("retrieveWorkspaceMemory finds older non-ASCII memories even when lexical FTS tokenization is unavailable", async () => {
  const root = makeTempDir("hb-workspace-memory-non-ascii-lexical-scan-");
  writeRuntimeConfig(root);
  globalThis.fetch = (async () => {
    throw new Error("non-ASCII lexical retrieval should not call remote model endpoints");
  }) as typeof fetch;

  const fillerMemories = Array.from({ length: 72 }, (_, index) => ({
    entityId: `interaction:workflow:filler-${index + 1}`,
    canonicalName: `Filler workflow ${index + 1}`,
    nodeId: `semantic:interaction:filler:${index + 1}:leaf-1`,
    title: `Filler memory ${index + 1}`,
    summary: `Unrelated filler summary ${index + 1}.`,
    bodyText: `Unrelated filler body ${index + 1}.`,
    observedAt: `2026-05-${String((index % 27) + 1).padStart(2, "0")}T00:00:00.000Z`,
    updatedAt: `2026-05-${String((index % 27) + 1).padStart(2, "0")}T00:00:00.000Z`,
  }));

  const result = await retrieveWorkspaceMemory({
    store: makeStoreFixture(root, {
      additionalInteractionMemories: [
        ...fillerMemories,
        {
          entityId: "interaction:topic:channel-design",
          canonicalName: "渠道设计",
          entityType: "topic",
          nodeId: "semantic:interaction:channel-design:leaf-1",
          title: "渠道设计决策",
          summary: "渠道设计方案已经确定。",
          bodyText: "渠道设计方案已经确定，并且需要保持这条 durable memory 可检索。",
          relationType: "about",
          relationMetadata: {
            entity_key: "topic:entity:interaction:topic:channel-design",
            entity_label: "渠道设计",
            entity_type: "topic",
            target_tree_id: "interaction:topic:channel-design",
            target_node_id: "semantic:interaction:topic:channel-design:tree",
            resolved_target_kind: "resolved",
          },
          observedAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
      ],
      additionalResolverEntities: [
        {
          workspaceId: "workspace-1",
          entityId: "interaction:topic:channel-design",
          entityType: "topic",
          canonicalName: "渠道设计",
          slug: "topic-channel-design",
          summary: "Channel design topic.",
          aliases: ["渠道设计方案"],
          isSystem: false,
          status: "active",
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
      ],
    }),
    workspaceId: "workspace-1",
    query: "渠道设计",
    selectedModel: "openai_direct/gpt-5.4",
    sessionId: "session-1",
    inputId: "input-1",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });

  assert.equal(result.evidence[0]?.title, "渠道设计决策");
  assert.ok(result.evidence[0]?.reasons.includes("lexical_match"));
  assert.ok(result.evidence[0]?.reasons.includes("relation_match"));
});

test("retrieveWorkspaceMemory finds non-ASCII memories from spaced token queries when the document stores the phrase contiguously", async () => {
  const root = makeTempDir("hb-workspace-memory-non-ascii-spaced-query-");
  writeRuntimeConfig(root);
  globalThis.fetch = (async () => {
    throw new Error("non-ASCII spaced lexical retrieval should not call remote model endpoints");
  }) as typeof fetch;

  const fillerMemories = Array.from({ length: 72 }, (_, index) => ({
    entityId: `interaction:workflow:filler-${index + 1}`,
    canonicalName: `Filler workflow ${index + 1}`,
    nodeId: `semantic:interaction:filler:${index + 1}:leaf-1`,
    title: `Filler memory ${index + 1}`,
    summary: `Unrelated filler summary ${index + 1}.`,
    bodyText: `Unrelated filler body ${index + 1}.`,
    observedAt: `2026-05-${String((index % 27) + 1).padStart(2, "0")}T00:00:00.000Z`,
    updatedAt: `2026-05-${String((index % 27) + 1).padStart(2, "0")}T00:00:00.000Z`,
  }));

  const result = await retrieveWorkspaceMemory({
    store: makeStoreFixture(root, {
      additionalInteractionMemories: [
        ...fillerMemories,
        {
          entityId: "interaction:topic:channel-design",
          canonicalName: "渠道设计",
          entityType: "topic",
          nodeId: "semantic:interaction:channel-design:leaf-1",
          title: "渠道设计决策",
          summary: "渠道设计方案已经确定。",
          bodyText: "渠道设计方案已经确定，并且需要保持这条 durable memory 可检索。",
          relationType: "about",
          relationMetadata: {
            entity_key: "topic:entity:interaction:topic:channel-design",
            entity_label: "渠道设计",
            entity_type: "topic",
            target_tree_id: "interaction:topic:channel-design",
            target_node_id: "semantic:interaction:topic:channel-design:tree",
            resolved_target_kind: "resolved",
          },
          observedAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
      ],
      additionalResolverEntities: [
        {
          workspaceId: "workspace-1",
          entityId: "interaction:topic:channel-design",
          entityType: "topic",
          canonicalName: "渠道设计",
          slug: "topic-channel-design",
          summary: "Channel design topic.",
          aliases: ["渠道设计方案"],
          isSystem: false,
          status: "active",
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
      ],
    }),
    workspaceId: "workspace-1",
    query: "渠道设计 方案",
    selectedModel: "openai_direct/gpt-5.4",
    sessionId: "session-1",
    inputId: "input-1",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });

  assert.equal(result.evidence[0]?.title, "渠道设计决策");
  assert.ok(result.evidence[0]?.reasons.includes("lexical_match"));
});

test("retrieveWorkspaceMemory prefers durable interaction memories for account queries routed through canonical artifact relations", async () => {
  const root = makeTempDir("hb-workspace-memory-account-query-ranking-");
  writeRuntimeConfig(root);
  globalThis.fetch = (async () => {
    throw new Error("account-query lexical retrieval should not call remote model endpoints");
  }) as typeof fetch;

  const result = await retrieveWorkspaceMemory({
    store: makeStoreFixture(root, {
      outputArtifactFixture: {
        treeId: "output-artifact:outreach-1",
        title: "outreach-delegated.md",
        outputId: "output-delegated-1",
        filePath: "outputs/outreach-delegated.md",
      },
      toolResultArtifactFixture: {
        treeId: "tool-result:gmail:call-1",
        title: "holaboss_composio.gmail_fetch_emails result",
        providerId: "gmail",
        accountNamespace: "ops@example.com",
        toolName: "holaboss_composio.gmail_fetch_emails",
        callId: "call-gmail-1",
      },
      additionalInteractionMemories: [
        {
          entityId: "interaction:topic:holaboss-personal-outreach",
          canonicalName: "holaboss personal outreach",
          entityType: "topic",
          nodeId: "semantic:interaction:holaboss-personal-outreach:leaf-1",
          title: "External individuals contacted the user personally about holaboss",
          summary: "A small set of external individuals reached out to the user personally about holaboss.",
          bodyText: "Ben Book at anyIP reached out to the user personally about holaboss.",
          relationType: "derived_from",
          relationMetadata: {
            entity_key: "artifact:output:output-delegated-1",
            entity_label: "outreach-delegated.md",
            entity_type: "artifact",
            resolved_target_kind: "resolved",
          },
          embeddingVector: [0.88, 0.12],
        },
      ],
      additionalSemanticRelations: [
        {
          treeId: "output-artifact:outreach-1",
          fromNodeId: "output-artifact:outreach-1:root",
          toNodeId: "semantic:related:artifact:tool-result:gmail:call-gmail-1",
          relationType: "derived_from",
          metadata: {
            entity_key: "artifact:tool-result:gmail:call-gmail-1",
            entity_label: "holaboss_composio.gmail_fetch_emails result",
            entity_type: "artifact",
            resolved_target_kind: "resolved",
          },
        },
      ],
    }),
    workspaceId: "workspace-1",
    query: "ops@example.com",
    selectedModel: "openai_direct/gpt-5.4",
    sessionId: "session-1",
    inputId: "input-1",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });

  assert.equal(result.evidence[0]?.title, "External individuals contacted the user personally about holaboss");
  assert.ok(result.evidence[0]?.reasons.includes("relation_match"));
  assert.ok(result.evidence[0]?.reasons.includes("provenance_match_boost"));
  const toolResultHit = result.evidence.find((item) => item.tree_id === "tool-result:gmail:call-1");
  assert.ok(toolResultHit);
  assert.equal(toolResultHit?.account_namespace, "ops@example.com");
});

test("retrieveWorkspaceMemory prefers durable interaction memories over raw tool-result chunks for mixed account and entity queries", async () => {
  const root = makeTempDir("hb-workspace-memory-mixed-account-entity-ranking-");
  writeRuntimeConfig(root);
  globalThis.fetch = (async () => {
    throw new Error("mixed account/entity lexical retrieval should not call remote model endpoints");
  }) as typeof fetch;

  const result = await retrieveWorkspaceMemory({
    store: makeStoreFixture(root, {
      toolResultArtifactFixture: {
        treeId: "tool-result:gmail:call-stale-1",
        title: "holaboss_composio.gmail_fetch_emails result",
        providerId: "gmail",
        accountNamespace: "ops@example.com",
        toolName: "holaboss_composio.gmail_fetch_emails",
        callId: "call-gmail-stale-1",
      },
      additionalResolverEntities: [
        {
          workspaceId: "workspace-1",
          entityId: "interaction:person:ben-book",
          entityType: "person",
          canonicalName: "Ben Book",
          slug: "person-ben-book",
          summary: "Contact memory.",
          aliases: [],
          isSystem: false,
          status: "active",
          createdAt: "2026-05-20T00:00:00.000Z",
          updatedAt: "2026-05-20T00:00:00.000Z",
        },
        {
          workspaceId: "workspace-1",
          entityId: "interaction:customer:anyip",
          entityType: "customer",
          canonicalName: "anyIP",
          slug: "customer-anyip",
          summary: "Organization memory.",
          aliases: [],
          isSystem: false,
          status: "active",
          createdAt: "2026-05-20T00:00:00.000Z",
          updatedAt: "2026-05-20T00:00:00.000Z",
        },
      ],
      additionalInteractionMemories: [
        {
          entityId: "interaction:topic:builder-mode-rollout",
          canonicalName: "Builder Mode rollout",
          entityType: "topic",
          nodeId: "semantic:interaction:builder-mode-rollout:leaf-1",
          title: "Builder Mode rollout Gmail contact captured in a legacy result",
          summary: "Builder Mode rollout Gmail contact details were documented in a legacy result.",
          bodyText: "Legacy result retained for durable rollout follow-up.",
          relationType: "about",
          relationMetadata: {
            entity_key: "topic:entity:interaction:topic:builder-mode-rollout",
            entity_label: "Builder Mode rollout",
            entity_type: "topic",
            target_tree_id: "interaction:topic:builder-mode-rollout",
            target_node_id: "semantic:interaction:builder-mode-rollout:tree",
            resolved_target_kind: "resolved",
          },
          embeddingVector: [0.88, 0.12],
        },
      ],
      additionalSemanticRelations: [
        {
          treeId: "interaction:topic:builder-mode-rollout",
          fromNodeId: "semantic:interaction:builder-mode-rollout:leaf-1",
          toNodeId: "semantic:interaction:person:ben-book:tree",
          relationType: "contacted_by",
          metadata: {
            entity_key: "person:entity:interaction:person:ben-book",
            entity_label: "Ben Book",
            entity_type: "person",
            target_tree_id: "interaction:person:ben-book",
            target_node_id: "semantic:interaction:person:ben-book:tree",
            resolved_target_kind: "resolved",
          },
        },
        {
          treeId: "interaction:topic:builder-mode-rollout",
          fromNodeId: "semantic:interaction:builder-mode-rollout:leaf-1",
          toNodeId: "semantic:interaction:customer:anyip:tree",
          relationType: "works_at",
          metadata: {
            entity_key: "organization:entity:interaction:customer:anyip",
            entity_label: "anyIP",
            entity_type: "organization",
            target_tree_id: "interaction:customer:anyip",
            target_node_id: "semantic:interaction:customer:anyip:tree",
            resolved_target_kind: "resolved",
          },
        },
        {
          treeId: "interaction:topic:builder-mode-rollout",
          fromNodeId: "semantic:interaction:builder-mode-rollout:leaf-1",
          toNodeId: "tool-result:gmail:call-stale-1:root",
          relationType: "derived_from",
          metadata: {
            entity_key: "artifact:tool-result:gmail:call-gmail-stale-1",
            entity_label: "holaboss_composio.gmail_fetch_emails result",
            entity_type: "artifact",
            target_tree_id: "tool-result:gmail:call-stale-1",
            target_node_id: "tool-result:gmail:call-stale-1:root",
            resolved_target_kind: "resolved",
          },
        },
      ],
    }),
    workspaceId: "workspace-1",
    query: "ops@example.com Ben Book anyIP builder mode rollout",
    selectedModel: "openai_direct/gpt-5.4",
    sessionId: "session-1",
    inputId: "input-1",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });

  assert.equal(
    result.evidence[0]?.title,
    "Builder Mode rollout Gmail contact captured in a legacy result",
  );
  assert.ok(result.evidence[0]?.reasons.includes("provenance_relation_priority_boost"));
  const toolResultChunkHit = result.evidence.find((item) => item.title === "holaboss_composio.gmail_fetch_emails result chunk 1");
  assert.ok(toolResultChunkHit);
  assert.ok(toolResultChunkHit?.reasons.includes("raw_tool_result_penalty"));
});

test("retrieveWorkspaceMemory still recalls workspace integration memory without active integration connections", async () => {
  const root = makeTempDir("hb-workspace-memory-no-active-connections-");
  writeRuntimeConfig(root);
  globalThis.fetch = (async () => {
    throw new Error("workspace-owned integration retrieval should not require live model calls in lexical mode");
  }) as typeof fetch;

  const result = await retrieveWorkspaceMemory({
    store: makeStoreFixture(root, { includeIntegrationConnections: false }),
    workspaceId: "workspace-1",
    query: "Any important emails recently that I should be aware of?",
    selectedModel: "openai_direct/gpt-5.4",
    sessionId: "session-1",
    inputId: "input-1",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });

  assert.equal(result.evidence[0]?.title, "Customer escalation waiting on reply");
  assert.ok(result.evidence.some((item) => item.category === "workspace"));
});

test("retrieveWorkspaceMemory falls back to semantic workspace leaf nodes when legacy integration leaves are absent", async () => {
  const root = makeTempDir("hb-workspace-memory-semantic-fallback-");
  writeRuntimeConfig(root);
  globalThis.fetch = (async () => {
    throw new Error("semantic fallback should not require live model calls in lexical mode");
  }) as typeof fetch;

  const result = await retrieveWorkspaceMemory({
    store: makeStoreFixture(root, {
      includeIntegrationConnections: false,
      includeIntegrationLeaves: false,
      includeIntegrationSearchDocs: false,
    }),
    workspaceId: "workspace-1",
    query: "",
    selectedModel: "openai_direct/gpt-5.4",
    sessionId: "session-1",
    inputId: "input-1",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });

  assert.equal(result.evidence[0]?.title, "Customer escalation waiting on reply");
  assert.ok(result.evidence.some((item) => item.category === "workspace"));
});

test("buildRecalledWorkspaceMemoryContext normalizes recalled evidence to the unified workspace category", async () => {
  const root = makeTempDir("hb-workspace-memory-recalled-context-");
  writeRuntimeConfig(root);
  globalThis.fetch = (async () => {
    throw new Error("recalled memory context should not require live model calls in lexical mode");
  }) as typeof fetch;

  const result = await buildRecalledWorkspaceMemoryContext({
    store: makeStoreFixture(root),
    workspaceId: "workspace-1",
    query: "how do I deploy?",
    selectedModel: "openai_direct/gpt-5.4",
    sessionId: "session-1",
    inputId: "input-1",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });

  assert.ok(result);
  assert.ok(result.evidence?.every((item) => item.category === "workspace"));
  assert.ok(result.retrieval_pack?.known_facts.every((item) => item.category === "workspace"));
  assert.match(result.evidence?.[0]?.freshness_note ?? "", /workspace|memory from/i);
});
