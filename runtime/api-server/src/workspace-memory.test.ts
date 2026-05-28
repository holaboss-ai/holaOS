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

function makeStoreFixture(root: string): RuntimeStateStore {
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
    lastContextFetchAttemptedAt: null,
    lastContextFetchCompletedAt: null,
    lastContextFetchStatus: null,
    authMode: "oauth",
    grantedScopes: [],
    status: "active",
    secretRef: null,
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-20T00:00:00.000Z",
  };
  const integrationTree: IntegrationTreeRecord = {
    treeId: "integration:gmail:acct-1",
    provider: "gmail",
    ownerUserId: "user-1",
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
    category: "interaction",
    treeId: interactionEntity.entityId,
    nodeId: "semantic:interaction:deploy:leaf-1",
    nodeClass: "leaf",
    nodeKind: "leaf",
    sourceLeafId: "leaf-1",
    path: "semantic/interaction/trees/workflow-deploy/leaf-1.md",
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
    workspaceId: null,
    category: "integration",
    treeId: integrationTree.treeId,
    nodeId: "semantic:integration:gmail:acct-1:thread:1",
    nodeClass: "leaf",
    nodeKind: "leaf",
    sourceLeafId: "leaf-thread-1",
    path: "semantic/integration/trees/gmail-ops-example-com-acct-1/thread-1.md",
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

  const interactionEmbeddings = [
    {
      workspaceId,
      nodeKind: "leaf",
      nodeId: interactionNode.nodeId,
      entityId: interactionEntity.entityId,
      embeddingModel: "text-embedding-3-small",
      contentFingerprint: "f1",
      dimensions: 2,
      vector: [0.9, 0.1],
      createdAt: "2026-05-21T00:00:00.000Z",
      updatedAt: "2026-05-21T00:00:00.000Z",
    },
  ];
  const integrationEmbeddings = [
    {
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
  const semanticNodes = new Map<string, SemanticMemoryNodeRecord>([
    [`interaction:${interactionEntity.entityId}:${interactionNode.nodeId}`, interactionNode],
    [`integration:${integrationTree.treeId}:${integrationNode.nodeId}`, integrationNode],
  ]);
  const semanticSearchDocs = [
    {
      workspaceId,
      category: "interaction" as const,
      treeId: interactionEntity.entityId,
      nodeId: interactionNode.nodeId,
      nodeClass: interactionNode.nodeClass,
      nodeKind: interactionNode.nodeKind,
      path: interactionNode.path,
      childCount: interactionNode.childCount,
      title: interactionNode.title,
      summary: interactionNode.summary,
      bodyText: "Deploy approver Maya owns release approvals.",
      excerpt: "Deploy approver Maya owns release approvals.",
      observedAt: interactionNode.observedAt,
      status: interactionNode.status,
      updatedAt: interactionNode.updatedAt,
    },
    {
      workspaceId: null,
      category: "integration" as const,
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
  ];
  const searchDocsFor = (params: {
    category: "interaction" | "integration";
    workspaceId?: string | null;
    treeId?: string | null;
    treeIds?: string[] | null;
    nodeIds?: string[] | null;
    nodeClass?: string | null;
    status?: string | null;
    matchQuery?: string | null;
  }) => {
    const normalizedTreeIds = params.treeIds
      ? new Set(params.treeIds.filter(Boolean))
      : null;
    const normalizedNodeIds = params.nodeIds
      ? new Set(params.nodeIds.filter(Boolean))
      : null;
    const query = (params.matchQuery ?? "").toLowerCase();
    return semanticSearchDocs
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
  };

  return {
    workspaceRoot,
    workspaceDir(targetWorkspaceId: string) {
      return path.join(workspaceRoot, targetWorkspaceId);
    },
    listInteractionEntities(params: { workspaceId: string }) {
      return params.workspaceId === workspaceId ? [interactionEntity] : [];
    },
    getInteractionEntity(params: { workspaceId: string; entityId: string }) {
      return params.workspaceId === workspaceId && params.entityId === interactionEntity.entityId
        ? interactionEntity
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
    listIntegrationNodeEmbeddings(params: { embeddingModel?: string | null; nodeIds?: string[] | null }) {
      const normalizedNodeIds = params.nodeIds ? new Set(params.nodeIds.filter(Boolean)) : null;
      return integrationEmbeddings.filter((record) =>
        params.embeddingModel == null || record.embeddingModel === params.embeddingModel
      ).filter((record) => !normalizedNodeIds || normalizedNodeIds.has(record.nodeId));
    },
    getSemanticMemoryNode(params: { category: "interaction" | "integration"; treeId: string; nodeId: string; workspaceId?: string | null }) {
      return semanticNodes.get(`${params.category}:${params.treeId}:${params.nodeId}`) ?? null;
    },
    listSemanticMemoryNodes(params: { category: "interaction" | "integration"; treeId: string }) {
      return [...semanticNodes.values()].filter((node) => node.category === params.category && node.treeId === params.treeId);
    },
    listSemanticMemorySearchDocs(params: {
      category: "interaction" | "integration";
      workspaceId?: string | null;
      treeId?: string | null;
      treeIds?: string[] | null;
      nodeIds?: string[] | null;
      nodeClass?: string | null;
      status?: string | null;
    }) {
      return searchDocsFor(params);
    },
    searchSemanticMemorySearchDocs(params: {
      category: "interaction" | "integration";
      workspaceId?: string | null;
      treeId?: string | null;
      treeIds?: string[] | null;
      nodeClass?: string | null;
      status?: string | null;
      matchQuery: string;
    }) {
      return searchDocsFor(params)
        .map((doc, index) => ({
          ...doc,
          bm25Score: index + 1,
        }));
    },
    listIntegrationConnections() {
      return [integrationConnection];
    },
    listWorkspaceIntegrationOverrides() {
      return [];
    },
    listIntegrationTrees(params: { provider?: string | null; ownerUserId?: string | null; status?: string | null }) {
      return [integrationTree].filter((tree) =>
        (params.provider == null || tree.provider === params.provider)
        && (params.ownerUserId == null || tree.ownerUserId === params.ownerUserId)
        && (params.status == null || tree.status === params.status)
      );
    },
    listSemanticMemoryChildren() {
      return [];
    },
    listSemanticMemoryRelations() {
      return [];
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
    categories: ["interaction", "integration"],
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
