import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";
import { seedWorkspaceRecord } from "./__test-helpers__/seed-workspace.js";

import { persistInteractionCandidate, rebuildInteractionEntityTree, retrieveInteractionMemory } from "./interaction-memory.js";
import {
  appendDurableMemoryRelatedSections,
  parseDurableMemoryRelatedInfo,
} from "./memory-related-entities.js";
import { workspaceMemoryDir } from "./workspace-bundle-paths.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_RUNTIME_CONFIG_PATH = process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
const tempDirs: string[] = [];

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_RUNTIME_CONFIG_PATH === undefined) {
    delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  } else {
    process.env.HOLABOSS_RUNTIME_CONFIG_PATH = ORIGINAL_RUNTIME_CONFIG_PATH;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeRecallEmbeddingRuntimeConfig(root: string): string {
  const configPath = path.join(root, "runtime-config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        runtime: {
          sandbox_id: "sandbox-test",
        },
        providers: {
          openai_direct: {
            kind: "openai_compatible",
            base_url: "https://api.openai.com/v1",
            api_key: "sk-test-openai",
          },
        },
        integrations: {
          holaboss: {
            auth_token: "hbmk.test-token",
            sandbox_id: "sandbox-test",
            user_id: "user-1",
          },
        },
        holaboss: {
          auth_token: "hbmk.test-token",
          sandbox_id: "sandbox-test",
          user_id: "user-1",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;
  return configPath;
}

async function withJsonResponseServer(params: {
  responses: Array<Record<string, unknown>>;
  run: (baseUrl: string, requests: Array<Record<string, unknown>>) => Promise<void>;
}): Promise<void> {
  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/openai/v1/chat/completions") {
      response.statusCode = 404;
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      const payload = params.responses[Math.min(requests.length - 1, params.responses.length - 1)] ?? {};
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await params.run(`http://127.0.0.1:${address.port}/openai/v1`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

test("rebuildInteractionEntityTree uses LLM-authored summaries when a summary model client is available", async () => {
  const root = makeTempDir("hb-interaction-memory-summary-");
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
    entityId: "interaction:workflow:deploy-procedure",
    entityType: "workflow",
    canonicalName: "Deploy procedure",
    slug: "workflow-deploy-procedure",
    summary: "Deployment procedure memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });

  for (let index = 1; index <= 3; index += 1) {
    const leafId = `leaf-${index}`;
    const relativePath = `workspace/workspace-1/interaction/entities/workflow-deploy-procedure/leaves/${leafId}.md`;
    store.upsertInteractionLeaf({
      workspaceId: "workspace-1",
      leafId,
      entityId: "interaction:workflow:deploy-procedure",
      subjectKey: `procedure:deploy:${index}`,
      path: relativePath,
      title: `Deploy step ${index}`,
      summary: `Summary for deploy step ${index}.`,
      fingerprint: `fingerprint-${leafId}`,
      bodySha256: `sha-${leafId}`,
      tags: ["deploy"],
      secondaryEntityIds: [],
      sourceType: "manual",
      sourceEventId: null,
      sourceMessageId: null,
      sourceTurnInputId: "input-seed",
      admissionConfidence: 0.9,
      entityConfidence: 0.9,
      observedAt: `2026-05-20T00:0${index}:00.000Z`,
      supersedesLeafId: null,
      status: "active",
    });
    const absolutePath = path.join(
      workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
      "interaction",
      "entities",
      "workflow-deploy-procedure",
      "leaves",
      `${leafId}.md`,
    );
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(
      absolutePath,
      `# Deploy step ${index}\n\nSummary for deploy step ${index}.\n`,
      "utf8",
    );
  }

  const requests: Array<Record<string, unknown>> = [];
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/openai/v1/chat/completions") {
      response.statusCode = 404;
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "Deployment memory emphasizes validating the release flow before rollout and keeping the procedure consistent.",
                }),
              },
            },
          ],
        }),
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await rebuildInteractionEntityTree({
      store,
      workspaceId: "workspace-1",
      entityId: "interaction:workflow:deploy-procedure",
      summaryModelClient: {
        baseUrl: `http://127.0.0.1:${address.port}/openai/v1`,
        apiKey: "test-key",
        modelId: "openai/gpt-4.1-mini",
      },
      embeddingClient: null,
    });

    const semanticNodes = store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: "interaction:workflow:deploy-procedure",
      status: "active",
      limit: 10_000,
      offset: 0,
    });
    const rootNode = semanticNodes.find((node) => node.nodeKind === "tree");

    assert.ok(requests.length >= 1);
    assert.ok(requests.every((request) => request.model === "gpt-4.1-mini"));
    assert.ok(rootNode);
    assert.equal(
      rootNode?.summary,
      "Deployment memory emphasizes validating the release flow before rollout and keeping the procedure consistent.",
    );
    const summaryPath = path.join(
      workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
      "semantic",
      "workspace",
      "processes",
      "workflow-deploy-procedure",
      "content.md",
    );
    assert.match(
      fs.readFileSync(summaryPath, "utf8"),
      /Deployment memory emphasizes validating the release flow before rollout and keeping the procedure consistent\./,
    );
  } finally {
    store.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});

test("rebuildInteractionEntityTree preserves long semantic summaries and stores summary chunks instead of clipping", async () => {
  const root = makeTempDir("hb-interaction-memory-long-summary-");
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
    entityId: "interaction:project:builder-mode",
    entityType: "project",
    canonicalName: "Builder Mode",
    slug: "project-builder-mode",
    summary: "Builder Mode project memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });

  for (let index = 1; index <= 3; index += 1) {
    const leafId = `leaf-${index}`;
    const relativePath = `workspace/workspace-1/interaction/entities/project-builder-mode/leaves/${leafId}.md`;
    store.upsertInteractionLeaf({
      workspaceId: "workspace-1",
      leafId,
      entityId: "interaction:project:builder-mode",
      subjectKey: `project:builder-mode:${index}`,
      path: relativePath,
      title: `Builder Mode detail ${index}`,
      summary: `Builder Mode detail ${index} is durable and should remain discoverable.`,
      fingerprint: `fingerprint-${leafId}`,
      bodySha256: `sha-${leafId}`,
      tags: ["builder-mode"],
      secondaryEntityIds: [],
      sourceType: "manual",
      sourceEventId: null,
      sourceMessageId: null,
      sourceTurnInputId: "input-seed",
      admissionConfidence: 0.9,
      entityConfidence: 0.9,
      observedAt: `2026-06-03T15:0${index}:00.000Z`,
      supersedesLeafId: null,
      status: "active",
    });
    const absolutePath = path.join(
      workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
      "interaction",
      "entities",
      "project-builder-mode",
      "leaves",
      `${leafId}.md`,
    );
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(
      absolutePath,
      `# Builder Mode detail ${index}\n\nBuilder Mode detail ${index} is durable and should remain discoverable.\n`,
      "utf8",
    );
  }

  const longSummary = [
    "Builder Mode's latest authoritative framing lives in the V2 product-shape work, which positions the product as build something that runs for someone else rather than a marketplace-first shell.",
    "The surface combines a Building Agent chat with an Agentic Workspace artifact view, keeps the community-first distribution motion ahead of a later marketplace layer, and makes the route away from the V1 Shopify-style marketplace explicit enough to guide future product and GTM discussions.",
    "The memory should preserve the product framing, the distribution sequencing, the relationship to the older V1 document, and the practical implication that the team should not treat marketplace-first assumptions as current truth when summarizing Builder Mode again.",
    "That durable summary is intentionally long because the strategy change, the workspace surface, and the deprecation context all matter together and should remain queryable without being collapsed into an ellipsis.",
    "A later reader should still be able to recover that the authoritative source was the newer Builder Mode V2 framing and that community-first sequencing replaced marketplace-first planning in the relevant materials.",
  ].join(" ");

  await withJsonResponseServer({
    responses: [
      {
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: longSummary,
              }),
            },
          },
        ],
      },
    ],
    run: async (baseUrl) => {
      await rebuildInteractionEntityTree({
        store,
        workspaceId: "workspace-1",
        entityId: "interaction:project:builder-mode",
        summaryModelClient: {
          baseUrl,
          apiKey: "test-key",
          modelId: "openai/gpt-4.1-mini",
        },
        embeddingClient: null,
      });
    },
  });

  try {
    const semanticNodes = store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: "interaction:project:builder-mode",
      status: "active",
      limit: 10_000,
      offset: 0,
    });
    const rootNode = semanticNodes.find((node) => node.nodeKind === "tree");
    const summaryChunkNodes = semanticNodes.filter((node) => node.nodeKind === "summary_chunk");

    assert.ok(rootNode);
    assert.equal(rootNode?.summary, longSummary);
    assert.doesNotMatch(rootNode?.summary ?? "", /\.\.\./);
    assert.equal(summaryChunkNodes.length >= 2, true);

    const rootChildren = store.listSemanticMemoryChildren({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: "interaction:project:builder-mode",
      parentNodeId: rootNode!.nodeId,
    });
    assert.equal(rootChildren.some((child) => summaryChunkNodes.some((node) => node.nodeId === child.childNodeId)), true);

    const semanticRootPath = path.join(
      workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
      "semantic",
      "workspace",
      "projects",
      "project-builder-mode",
      "content.md",
    );
    const semanticRootBody = fs.readFileSync(semanticRootPath, "utf8");
    assert.match(semanticRootBody, /community-first distribution motion ahead of a later marketplace layer/);
    assert.doesNotMatch(semanticRootBody, /\.\.\./);

    const firstChunkPath = path.join(
      workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
      "semantic",
      "workspace",
      "projects",
      "project-builder-mode",
      "chunks",
      "chunk-001",
      "content.md",
    );
    const secondChunkPath = path.join(
      workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
      "semantic",
      "workspace",
      "projects",
      "project-builder-mode",
      "chunks",
      "chunk-002",
      "content.md",
    );
    assert.equal(fs.existsSync(firstChunkPath), true);
    assert.equal(fs.existsSync(secondChunkPath), true);
    assert.match(fs.readFileSync(firstChunkPath, "utf8"), /## Summary/);
  } finally {
    store.close();
  }
});

test("rebuildInteractionEntityTree writes semantic interaction trees and retrieval drills into materialized partitions", async () => {
  const root = makeTempDir("hb-interaction-memory-semantic-");
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
    entityId: "interaction:workflow:deploy-procedure",
    entityType: "workflow",
    canonicalName: "Deploy procedure",
    slug: "workflow-deploy-procedure",
    summary: "Deployment procedure memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });

  for (let index = 1; index <= 10; index += 1) {
    const leafId = `leaf-${index}`;
    const relativePath = `workspace/workspace-1/interaction/entities/workflow-deploy-procedure/leaves/${leafId}.md`;
    store.upsertInteractionLeaf({
      workspaceId: "workspace-1",
      leafId,
      entityId: "interaction:workflow:deploy-procedure",
      subjectKey: `procedure:deploy:${index}`,
      path: relativePath,
      title: `Deploy step ${index}`,
      summary: `Summary for deploy step ${index}.`,
      fingerprint: `fingerprint-${leafId}`,
      bodySha256: `sha-${leafId}`,
      tags: ["deploy"],
      secondaryEntityIds: [],
      sourceType: "manual",
      sourceEventId: null,
      sourceMessageId: null,
      sourceTurnInputId: "input-seed",
      admissionConfidence: 0.9,
      entityConfidence: 0.9,
      observedAt: `2026-05-20T00:${String(index).padStart(2, "0")}:00.000Z`,
      supersedesLeafId: null,
      status: "active",
    });
    const absolutePath = path.join(
      workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
      "interaction",
      "entities",
      "workflow-deploy-procedure",
      "leaves",
      `${leafId}.md`,
    );
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(
      absolutePath,
      `# Deploy step ${index}\n\nSummary for deploy step ${index}.\n`,
      "utf8",
    );
  }

  try {
    await rebuildInteractionEntityTree({
      store,
      workspaceId: "workspace-1",
      entityId: "interaction:workflow:deploy-procedure",
      summaryModelClient: null,
      embeddingClient: null,
    });

    const semanticNodes = store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: "interaction:workflow:deploy-procedure",
      status: "active",
      limit: 10_000,
      offset: 0,
    });
    const rootNode = semanticNodes.find((node) => node.nodeKind === "tree");
    const partitionNodes = semanticNodes.filter((node) => node.nodeKind === "partition");
    const leafNodes = semanticNodes.filter((node) => node.nodeClass === "leaf");

    assert.ok(rootNode);
    assert.equal(partitionNodes.length, 2);
    assert.equal(leafNodes.length, 10);

    const rootChildren = store.listSemanticMemoryChildren({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: "interaction:workflow:deploy-procedure",
      parentNodeId: rootNode!.nodeId,
    });
    assert.equal(rootChildren.length, 2);

    const firstPartition = partitionNodes.find((node) => node.title === "Slice 1") ?? partitionNodes[0];
    assert.ok(firstPartition);
    const firstPartitionChildren = store.listSemanticMemoryChildren({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: "interaction:workflow:deploy-procedure",
      parentNodeId: firstPartition!.nodeId,
    });
    assert.equal(firstPartitionChildren.length, 8);

    const semanticRootPath = path.join(
      workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
      "semantic",
      "workspace",
      "processes",
      "workflow-deploy-procedure",
      "content.md",
    );
    assert.match(fs.readFileSync(semanticRootPath, "utf8"), /## Summary/);

    const summaryResult = await retrieveInteractionMemory({
      store,
      workspaceId: "workspace-1",
      query: "deploy procedure",
      mode: "summaries",
      treeId: "interaction:workflow:deploy-procedure",
      maxResults: 5,
    });
    assert.ok(summaryResult.hits.some((hit) => hit.node_id === rootNode!.nodeId && hit.node_kind === "summary"));

    const partitionResult = await retrieveInteractionMemory({
      store,
      workspaceId: "workspace-1",
      query: "deploy step",
      treeId: "interaction:workflow:deploy-procedure",
      nodeId: rootNode!.nodeId,
      maxResults: 10,
    });
    assert.equal(partitionResult.children?.length, 2);
    assert.ok(partitionResult.children?.every((hit) => hit.node_kind === "summary"));

    const leafResult = await retrieveInteractionMemory({
      store,
      workspaceId: "workspace-1",
      query: "deploy step",
      treeId: "interaction:workflow:deploy-procedure",
      nodeId: firstPartition!.nodeId,
      maxResults: 10,
    });
    assert.equal(leafResult.children?.length, 8);
    assert.ok(leafResult.children?.every((hit) => hit.node_kind === "leaf"));
  } finally {
    store.close();
  }
});

test("rebuildInteractionEntityTree reuses unchanged semantic partitions and only recomputes affected subtrees", async () => {
  const root = makeTempDir("hb-interaction-memory-incremental-");
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
    entityId: "interaction:workflow:incremental-playbook",
    entityType: "workflow",
    canonicalName: "Incremental playbook",
    slug: "workflow-incremental-playbook",
    summary: "Incremental rebuild memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });

  const leafIds = Array.from({ length: 10 }, (_, index) => `leaf-${index + 1}`);
  for (const [index, leafId] of leafIds.entries()) {
    const relativePath = `workspace/workspace-1/interaction/entities/workflow-incremental-playbook/leaves/${leafId}.md`;
    store.upsertInteractionLeaf({
      workspaceId: "workspace-1",
      leafId,
      entityId: "interaction:workflow:incremental-playbook",
      subjectKey: `procedure:incremental:${index + 1}`,
      path: relativePath,
      title: `Incremental step ${index + 1}`,
      summary: `Summary for incremental step ${index + 1}.`,
      fingerprint: `fingerprint-${leafId}`,
      bodySha256: `sha-${leafId}`,
      tags: ["incremental"],
      secondaryEntityIds: [],
      sourceType: "manual",
      sourceEventId: null,
      sourceMessageId: null,
      sourceTurnInputId: "input-seed",
      admissionConfidence: 0.9,
      entityConfidence: 0.9,
      observedAt: `2026-05-20T00:${String(index + 1).padStart(2, "0")}:00.000Z`,
      supersedesLeafId: null,
      status: "active",
    });
    const absolutePath = path.join(
      workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
      "interaction",
      "entities",
      "workflow-incremental-playbook",
      "leaves",
      `${leafId}.md`,
    );
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(
      absolutePath,
      `# Incremental step ${index + 1}\n\nSummary for incremental step ${index + 1}.\n`,
      "utf8",
    );
  }

  try {
    await withJsonResponseServer({
      responses: Array.from({ length: 8 }, (_, index) => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: `Incremental summary ${index + 1}.`,
              }),
            },
          },
        ],
      })),
      run: async (baseUrl, requests) => {
        const summaryModelClient = {
          baseUrl,
          apiKey: "test-key",
          modelId: "openai/gpt-4.1-mini",
        };

        await rebuildInteractionEntityTree({
          store,
          workspaceId: "workspace-1",
          entityId: "interaction:workflow:incremental-playbook",
          summaryModelClient,
          embeddingClient: null,
        });
        const firstRebuildRequestCount = requests.length;
        assert.ok(firstRebuildRequestCount >= 3);

        await rebuildInteractionEntityTree({
          store,
          workspaceId: "workspace-1",
          entityId: "interaction:workflow:incremental-playbook",
          summaryModelClient,
          embeddingClient: null,
        });
        assert.equal(requests.length, firstRebuildRequestCount);

        const updatedLeafPath = path.join(
          workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
          "interaction",
          "entities",
          "workflow-incremental-playbook",
          "leaves",
          "leaf-1.md",
        );
        fs.writeFileSync(
          updatedLeafPath,
          "# Incremental step 1\n\nSummary for incremental step 1 with a revised approval gate.\n",
          "utf8",
        );
        store.upsertInteractionLeaf({
          workspaceId: "workspace-1",
          leafId: "leaf-1",
          entityId: "interaction:workflow:incremental-playbook",
          subjectKey: "procedure:incremental:1",
          path: "workspace/workspace-1/interaction/entities/workflow-incremental-playbook/leaves/leaf-1.md",
          title: "Incremental step 1",
          summary: "Summary for incremental step 1 with a revised approval gate.",
          fingerprint: "fingerprint-leaf-1-revised",
          bodySha256: "sha-leaf-1-revised",
          tags: ["incremental"],
          secondaryEntityIds: [],
          sourceType: "manual",
          sourceEventId: null,
          sourceMessageId: null,
          sourceTurnInputId: "input-seed",
          admissionConfidence: 0.9,
          entityConfidence: 0.9,
          observedAt: "2026-05-20T00:01:00.000Z",
          supersedesLeafId: null,
          status: "active",
        });

        await rebuildInteractionEntityTree({
          store,
          workspaceId: "workspace-1",
          entityId: "interaction:workflow:incremental-playbook",
          summaryModelClient,
          embeddingClient: null,
        });
        assert.ok(requests.length > firstRebuildRequestCount);
      },
    });
  } finally {
    store.close();
  }
});

test("retrieveInteractionMemory recalls deep-body leaf terms through the semantic search index", async () => {
  const root = makeTempDir("hb-interaction-memory-fts-");
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
    entityId: "interaction:workflow:escalation-playbook",
    entityType: "workflow",
    canonicalName: "Escalation playbook",
    slug: "workflow-escalation-playbook",
    summary: "Escalation workflow memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });

  const leafId = "leaf-deep-body";
  const relativePath = `workspace/workspace-1/interaction/entities/workflow-escalation-playbook/leaves/${leafId}.md`;
  const buriedToken = "zephyrchecksum42";
  store.upsertInteractionLeaf({
    workspaceId: "workspace-1",
    leafId,
    entityId: "interaction:workflow:escalation-playbook",
    subjectKey: "procedure:escalation:timer",
    path: relativePath,
    title: "Escalation timer detail",
    summary: "Escalations require a staging checksum before release approval.",
    fingerprint: `fingerprint-${leafId}`,
    bodySha256: `sha-${leafId}`,
    tags: ["escalation", "release"],
    secondaryEntityIds: [],
    sourceType: "manual",
    sourceEventId: null,
    sourceMessageId: null,
    sourceTurnInputId: "input-seed",
    admissionConfidence: 0.9,
    entityConfidence: 0.9,
    observedAt: "2026-05-22T08:00:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  const absolutePath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
    "interaction",
    "entities",
    "workflow-escalation-playbook",
    "leaves",
    `${leafId}.md`,
  );
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(
    absolutePath,
    `# Escalation timer detail\n\n${"filler ".repeat(90)}${buriedToken} must match before approval.\n`,
    "utf8",
  );

  try {
    await rebuildInteractionEntityTree({
      store,
      workspaceId: "workspace-1",
      entityId: "interaction:workflow:escalation-playbook",
      summaryModelClient: null,
      embeddingClient: null,
    });

    const leafNode = store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: "interaction:workflow:escalation-playbook",
      nodeClass: "leaf",
      status: "active",
      limit: 10_000,
      offset: 0,
    })[0];
    assert.ok(leafNode);

    const indexedDoc = store.getSemanticMemorySearchDoc({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: "interaction:workflow:escalation-playbook",
      nodeId: leafNode!.nodeId,
    });
    assert.ok(indexedDoc);
    assert.equal(indexedDoc?.bodyText.includes(buriedToken), true);
    assert.equal(indexedDoc?.excerpt?.includes(buriedToken) ?? false, false);

    const result = await retrieveInteractionMemory({
      store,
      workspaceId: "workspace-1",
      query: buriedToken,
      mode: "leaves",
      treeId: "interaction:workflow:escalation-playbook",
      maxResults: 5,
    });
    assert.ok(result.hits.some((hit) => hit.title === "Escalation timer detail"));
  } finally {
    store.close();
  }
});

test("retrieveInteractionMemory falls back to leaf summaries without reading markdown files", async () => {
  const root = makeTempDir("hb-interaction-memory-leaf-fallback-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
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
      entityId: "interaction:uncategorized",
      entityType: "misc",
      canonicalName: "Uncategorized",
      slug: "uncategorized",
      summary: "Fallback interaction tree.",
      aliases: [],
      isSystem: true,
      status: "active",
    });
    store.upsertInteractionLeaf({
      workspaceId: "workspace-1",
      leafId: "leaf-summary-fallback",
      entityId: "interaction:uncategorized",
      subjectKey: "verification:summary-fallback",
      path: "workspace/workspace-1/interaction/entities/uncategorized/leaves/leaf-summary-fallback.md",
      title: "Verification command",
      summary: "Use nebula verify to validate release bundles before shipping.",
      fingerprint: "fingerprint-leaf-summary-fallback",
      bodySha256: "sha-leaf-summary-fallback",
      tags: ["verification"],
      secondaryEntityIds: [],
      sourceType: "manual",
      sourceEventId: null,
      sourceMessageId: null,
      sourceTurnInputId: "input-seed",
      admissionConfidence: 0.9,
      entityConfidence: 0.9,
      observedAt: "2026-05-22T10:00:00.000Z",
      supersedesLeafId: null,
      status: "active",
    });

    const result = await retrieveInteractionMemory({
      store,
      workspaceId: "workspace-1",
      query: "nebula verify",
      mode: "leaves",
      treeId: "interaction:uncategorized",
      maxResults: 5,
    });

    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0]?.title, "Verification command");
    assert.match(result.hits[0]?.excerpt ?? "", /nebula verify/i);
  } finally {
    store.close();
  }
});

test.skip("retrieveInteractionMemory adds vector-only candidates that fall outside the recent semantic doc window", async () => {
  const root = makeTempDir("hb-interaction-memory-vector-topk-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  try {
    assert.equal(store.supportsVectorIndex(), true);
    writeRecallEmbeddingRuntimeConfig(root);
    seedWorkspaceRecord(store, {
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.upsertInteractionEntity({
      workspaceId: "workspace-1",
      entityId: "interaction:workflow:vector-playbook",
      entityType: "workflow",
      canonicalName: "Vector playbook",
      slug: "workflow-vector-playbook",
      summary: "Vector retrieval memory.",
      aliases: [],
      isSystem: false,
      status: "active",
    });

    const relevantNodeId = "semantic:interaction:interaction:workflow:vector-playbook:archival-ledger";
    const relevantVector = new Array<number>(1536).fill(0);
    relevantVector[0] = 1;
    globalThis.fetch = (async (input) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      assert.match(url, /\/embeddings$/);
      return new Response(
        JSON.stringify({
          data: [{ embedding: relevantVector }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    store.replaceSemanticMemorySearchDocs({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: "interaction:workflow:vector-playbook",
      docs: [
        ...Array.from({ length: 170 }, (_, index) => ({
          nodeId: index === 169
            ? relevantNodeId
            : `semantic:interaction:interaction:workflow:vector-playbook:filler-${index + 1}`,
          nodeClass: "semantic" as const,
          nodeKind: "overview",
          path: index === 169
            ? "semantic/workspace/processes/workflow-vector-playbook/archive-ledger/content.md"
            : `semantic/workspace/processes/workflow-vector-playbook/filler-${index + 1}/content.md`,
          childCount: 0,
          title: index === 169 ? "Archival ledger" : `Filler summary ${index + 1}`,
          summary: index === 169
            ? "Legacy shipment approvals are tracked in the archival ledger."
            : `Filler summary body ${index + 1}.`,
          bodyText: index === 169
            ? "Legacy shipment approvals are tracked in the archival ledger."
            : `Filler summary body ${index + 1}.`,
          excerpt: index === 169 ? "Legacy shipment approvals are tracked in the archival ledger." : null,
          observedAt: `2026-05-20T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
          status: "active" as const,
          updatedAt: index === 169 ? "2026-01-01T00:00:00.000Z" : "2026-05-31T00:00:00.000Z",
        })),
      ],
    });
    store.upsertInteractionNodeEmbedding({
      workspaceId: "workspace-1",
      nodeKind: "summary",
      nodeId: relevantNodeId,
      entityId: "interaction:workflow:vector-playbook",
      embeddingModel: "text-embedding-3-small",
      contentFingerprint: "v".repeat(64),
      dimensions: 1536,
      vector: relevantVector,
    });

    const result = await retrieveInteractionMemory({
      store,
      workspaceId: "workspace-1",
      query: "silentorbitvector42",
      mode: "summaries",
      maxResults: 5,
    });
    assert.ok(result.hits.some((hit) => hit.node_id === relevantNodeId && hit.title === "Archival ledger"));
  } finally {
    store.close();
  }
});

test("persistInteractionCandidate no-ops when semantic dedupe classifies a candidate as the same memory", async () => {
  const root = makeTempDir("hb-interaction-memory-dedupe-same-");
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
    entityId: "interaction:customer:redwood-care",
    entityType: "customer",
    canonicalName: "Redwood Care",
    slug: "customer-redwood-care",
    summary: "Customer memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  const relativePath = "workspace/workspace-1/interaction/entities/customer-redwood-care/leaves/leaf-existing.md";
  store.upsertInteractionLeaf({
    workspaceId: "workspace-1",
    leafId: "leaf-existing",
    entityId: "interaction:customer:redwood-care",
    subjectKey: "redwood_care_account_manager",
    path: relativePath,
    title: "Redwood Care account manager is Paul Reed",
    summary: "The Redwood Care account manager is Paul Reed.",
    fingerprint: "fingerprint-existing",
    bodySha256: "sha-existing",
    tags: ["customer", "contact"],
    secondaryEntityIds: [],
    sourceType: "assistant_turn",
    sourceEventId: null,
    sourceMessageId: null,
    sourceTurnInputId: "input-1",
    admissionConfidence: 0.9,
    entityConfidence: 0.9,
    observedAt: "2026-05-21T00:00:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  const absolutePath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
    "interaction",
    "entities",
    "customer-redwood-care",
    "leaves",
    "leaf-existing.md",
  );
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, "# Redwood Care account manager\n\nPaul Reed owns the Redwood Care account relationship.\n", "utf8");

  try {
    await withJsonResponseServer({
      responses: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "match_existing",
                  existing_entity_id: "interaction:customer:redwood-care",
                  new_entity_type: null,
                  new_entity_name: null,
                  secondary_entity_ids: [],
                  confidence: 0.97,
                  rationale: "The memory clearly belongs to the existing Redwood Care customer entity.",
                }),
              },
            },
          ],
        },
        {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "same_memory",
                  existing_leaf_id: "leaf-existing",
                  rationale: "Both memories capture the same account-manager fact.",
                }),
              },
            },
          ],
        },
      ],
      run: async (baseUrl, requests) => {
        const result = await persistInteractionCandidate({
          store,
          workspaceId: "workspace-1",
          candidate: {
            subjectKey: "redwood_care_account_manager:paul_reed",
            title: "Redwood Care account manager",
            summary: "Redwood Care's account manager is Paul Reed.",
            content: "# Redwood Care account manager\n\nThe Redwood Care account manager is Paul Reed.\n",
            tags: ["customer", "contact"],
            memoryType: "fact",
            confidence: 0.96,
            observedAt: "2026-05-21T00:05:00.000Z",
          },
          modelClient: {
            baseUrl,
            apiKey: "test-key",
            modelId: "openai/gpt-4.1-mini",
          },
        });

        assert.equal(result.outcome, "noop_duplicate");
        assert.equal(result.leaf.leafId, "leaf-existing");
        assert.equal(result.changed, true);
        assert.equal(requests.length, 2);

        const refreshedBody = fs.readFileSync(absolutePath, "utf8");
        const relatedInfo = parseDurableMemoryRelatedInfo(refreshedBody);
        assert.deepEqual(
          relatedInfo.relatedEntities.map((entry) => entry.entityKey),
          ["organization:entity:interaction:customer:redwood-care"],
        );
        assert.deepEqual(
          relatedInfo.relations.map((entry) => `${entry.relationType}|${entry.entityKey}`),
          ["about|organization:entity:interaction:customer:redwood-care"],
        );
      },
    });

    const activeLeaves = store.listInteractionLeaves({
      workspaceId: "workspace-1",
      entityId: "interaction:customer:redwood-care",
      status: "active",
      limit: 10,
      offset: 0,
    });
    assert.equal(activeLeaves.length, 1);
    assert.equal(activeLeaves[0]?.leafId, "leaf-existing");
  } finally {
    store.close();
  }
});

test("persistInteractionCandidate refreshes an existing duplicate when the later mention adds related entities", async () => {
  const root = makeTempDir("hb-interaction-memory-dedupe-refresh-");
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
    entityId: "interaction:customer:redwood-care",
    entityType: "customer",
    canonicalName: "Redwood Care",
    slug: "customer-redwood-care",
    summary: "Customer memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  const relativePath = "workspace/workspace-1/interaction/entities/customer-redwood-care/leaves/leaf-existing.md";
  store.upsertInteractionLeaf({
    workspaceId: "workspace-1",
    leafId: "leaf-existing",
    entityId: "interaction:customer:redwood-care",
    subjectKey: "redwood_care_account_manager",
    path: relativePath,
    title: "Redwood Care account manager is Paul Reed",
    summary: "The Redwood Care account manager is Paul Reed.",
    fingerprint: "fingerprint-existing",
    bodySha256: "sha-existing",
    tags: ["customer", "contact"],
    secondaryEntityIds: [],
    sourceType: "assistant_turn",
    sourceEventId: null,
    sourceMessageId: null,
    sourceTurnInputId: "input-1",
    admissionConfidence: 0.9,
    entityConfidence: 0.9,
    observedAt: "2026-05-21T00:00:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  const absolutePath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
    "interaction",
    "entities",
    "customer-redwood-care",
    "leaves",
    "leaf-existing.md",
  );
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, "# Redwood Care account manager\n\nPaul Reed owns the Redwood Care account relationship.\n", "utf8");

  try {
    await withJsonResponseServer({
      responses: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "match_existing",
                  existing_entity_id: "interaction:customer:redwood-care",
                  new_entity_type: null,
                  new_entity_name: null,
                  secondary_entity_ids: [],
                  confidence: 0.97,
                  rationale: "The memory clearly belongs to the existing Redwood Care customer entity.",
                }),
              },
            },
          ],
        },
        {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "same_memory",
                  existing_leaf_id: "leaf-existing",
                  rationale: "Both memories capture the same account-manager fact.",
                }),
              },
            },
          ],
        },
      ],
      run: async (baseUrl, requests) => {
        const result = await persistInteractionCandidate({
          store,
          workspaceId: "workspace-1",
          candidate: {
            subjectKey: "redwood_care_account_manager:paul_reed",
            title: "Redwood Care account manager",
            summary: "Redwood Care's account manager is Paul Reed.",
            content: appendDurableMemoryRelatedSections(
              "# Redwood Care account manager\n\nThe Redwood Care account manager is Paul Reed.\n",
              {
                relatedEntities: [
                  {
                    entityType: "person",
                    entityKey: "person:paul-reed",
                    label: "Paul Reed",
                  },
                  {
                    entityType: "organization",
                    entityKey: "organization:redwood-care",
                    label: "Redwood Care",
                  },
                ],
                relations: [
                  { relationType: "mentions", entityKey: "person:paul-reed" },
                ],
              },
            ),
            tags: ["customer", "contact"],
            memoryType: "fact",
            confidence: 0.96,
            observedAt: "2026-05-21T00:05:00.000Z",
          },
          modelClient: {
            baseUrl,
            apiKey: "test-key",
            modelId: "openai/gpt-4.1-mini",
          },
        });

        assert.equal(result.outcome, "noop_duplicate");
        assert.equal(result.leaf.leafId, "leaf-existing");
        assert.equal(result.changed, true);
        assert.equal(requests.length, 2);

        const refreshedBody = fs.readFileSync(absolutePath, "utf8");
        const relatedInfo = parseDurableMemoryRelatedInfo(refreshedBody);
        assert.deepEqual(
          relatedInfo.relatedEntities.map((entry) => entry.entityKey),
          ["organization:entity:interaction:customer:redwood-care", "person:paul-reed"],
        );
        assert.deepEqual(
          relatedInfo.relations.map((entry) => entry.relationType),
          ["about", "mentions"],
        );
      },
    });
  } finally {
    store.close();
  }
});

test("persistInteractionCandidate refreshes an existing non-ASCII duplicate when the later mention adds detail", async () => {
  const root = makeTempDir("hb-interaction-memory-non-ascii-dedupe-refresh-");
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

  try {
    const initialResult = await persistInteractionCandidate({
      store,
      workspaceId: "workspace-1",
      candidate: {
        subjectKey: "渠道设计阶段-代理优先-v1",
        title: "渠道设计阶段优先代理策略",
        summary: "渠道设计阶段优先代理策略，先跑代理渠道。",
        content:
          "# 渠道设计阶段优先代理策略\n\n渠道设计阶段优先代理策略，先跑代理渠道。\n",
        tags: ["渠道设计", "策略"],
        memoryType: "reference",
        confidence: 0.92,
        observedAt: "2026-06-05T09:00:00.000Z",
      },
      modelClient: null,
    });

    await withJsonResponseServer({
      responses: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "match_existing",
                  existing_entity_id: initialResult.entity.entityId,
                  new_entity_type: null,
                  new_entity_name: null,
                  secondary_entity_ids: [],
                  confidence: 0.96,
                  rationale: "The updated memory belongs to the same 渠道设计 topic tree.",
                }),
              },
            },
          ],
        },
        {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "same_memory",
                  existing_leaf_id: initialResult.leaf.leafId,
                  rationale: "Both memories describe the same 渠道设计 strategy, but the later one is more complete.",
                }),
              },
            },
          ],
        },
      ],
      run: async (baseUrl, requests) => {
        const result = await persistInteractionCandidate({
          store,
          workspaceId: "workspace-1",
          candidate: {
            subjectKey: "渠道设计阶段-代理优先-v2",
            title: "渠道设计阶段优先代理策略并保留直营验证",
            summary: "渠道设计阶段优先代理策略，并保留直营验证和回访节奏。",
            content:
              "# 渠道设计阶段优先代理策略并保留直营验证\n\n渠道设计阶段优先代理策略，并保留直营验证和回访节奏。\n",
            tags: ["渠道设计", "策略", "直营验证"],
            memoryType: "reference",
            confidence: 0.95,
            observedAt: "2026-06-05T09:10:00.000Z",
          },
          modelClient: {
            baseUrl,
            apiKey: "test-key",
            modelId: "openai/gpt-4.1-mini",
          },
        });

        assert.equal(result.outcome, "noop_duplicate");
        assert.equal(result.leaf.leafId, initialResult.leaf.leafId);
        assert.equal(result.changed, true);
        assert.equal(requests.length, 2);

        const refreshedLeaf = store.getInteractionLeaf({
          workspaceId: "workspace-1",
          leafId: initialResult.leaf.leafId,
        });
        assert.equal(
          refreshedLeaf?.title,
          "渠道设计阶段优先代理策略并保留直营验证",
        );
      },
    });

    const activeLeaves = store.listInteractionLeaves({
      workspaceId: "workspace-1",
      entityId: initialResult.entity.entityId,
      status: "active",
      limit: 10,
      offset: 0,
    });
    assert.equal(activeLeaves.length, 1);
    assert.equal(activeLeaves[0]?.leafId, initialResult.leaf.leafId);
  } finally {
    store.close();
  }
});

test("rebuildInteractionEntityTree preserves custom related relation types in semantic relations", async () => {
  const root = makeTempDir("hb-interaction-memory-custom-relations-");
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
    entityId: "interaction:topic:vendor-approval-policy",
    entityType: "topic",
    canonicalName: "Vendor approval policy",
    slug: "topic-vendor-approval-policy",
    summary: "Vendor approval rules.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  const relativePath =
    "workspace/workspace-1/interaction/entities/topic-vendor-approval-policy/leaves/leaf-policy.md";
  store.upsertInteractionLeaf({
    workspaceId: "workspace-1",
    leafId: "leaf-policy",
    entityId: "interaction:topic:vendor-approval-policy",
    subjectKey: "vendor_approval_policy",
    path: relativePath,
    title: "Vendor approval policy",
    summary: "Vendor changes require finance approval from Dana Moss.",
    fingerprint: "fingerprint-policy",
    bodySha256: "sha-policy",
    tags: ["policy", "vendor"],
    secondaryEntityIds: [],
    sourceType: "assistant_turn",
    sourceEventId: null,
    sourceMessageId: null,
    sourceTurnInputId: "input-policy",
    admissionConfidence: 0.95,
    entityConfidence: 0.95,
    observedAt: "2026-06-04T00:00:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  const absolutePath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
    "interaction",
    "entities",
    "topic-vendor-approval-policy",
    "leaves",
    "leaf-policy.md",
  );
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(
    absolutePath,
    appendDurableMemoryRelatedSections(
      "# Vendor approval policy\n\nVendor changes require finance approval from Dana Moss.\n",
      {
        relatedEntities: [
          {
            entityType: "person",
            entityKey: "person:dana-moss",
            label: "Dana Moss",
          },
        ],
        relations: [
          {
            relationType: "requires_approval_from",
            entityKey: "person:dana-moss",
          },
        ],
      },
    ),
    "utf8",
  );

  try {
    await rebuildInteractionEntityTree({
      store,
      workspaceId: "workspace-1",
      entityId: "interaction:topic:vendor-approval-policy",
    });

    const relations = store.listSemanticMemoryRelations({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: "interaction:topic:vendor-approval-policy",
      limit: 100,
      offset: 0,
    });
    assert.equal(relations.some((relation) => relation.relationType === "requires_approval_from"), true);
  } finally {
    store.close();
  }
});

test("rebuildInteractionEntityTree resolves sibling artifact placeholders to the same output artifact node", async () => {
  const root = makeTempDir("hb-interaction-memory-output-artifact-resolution-");
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
  store.syncSemanticMemoryTree({
    category: "workspace",
    workspaceId: "workspace-1",
    treeId: "output-tree-1",
    nodes: [
      {
        nodeId: "output-root-1",
        nodeClass: "semantic",
        nodeKind: "output_document",
        path: "semantic/workspace/artifacts/outputs/notion-related-pages-output-1/content.md",
        title: "notion-related-pages.md",
        summary: "Output artifact root.",
        bodySha256: "sha-output-root",
        childCount: 0,
        observedAt: "2026-06-05T00:00:00.000Z",
        status: "active",
        isMaterialized: false,
        metadata: {
          output_id: "output-1",
          output_type: "markdown",
          file_path: "outputs/notion-related-pages.md",
          source_turn_input_id: "turn-output-1",
          source_session_id: "session-1",
        },
      },
    ],
    edges: [],
  });
  store.upsertInteractionEntity({
    workspaceId: "workspace-1",
    entityId: "interaction:project:builder-mode",
    entityType: "project",
    canonicalName: "Builder Mode",
    slug: "project-builder-mode",
    summary: "Builder Mode project memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  const leafSpecs = [
    {
      leafId: "leaf-output-a",
      title: "Builder Mode research output",
      summary: "The Builder Mode research output lives in notion-related-pages.md.",
      body: appendDurableMemoryRelatedSections(
        "# Builder Mode research output\n\nThe Builder Mode research output lives in notion-related-pages.md.\n",
        {
          relatedEntities: [
            {
              entityType: "artifact",
              entityKey: "artifact:notion-related-pages-md",
              label: "notion-related-pages.md",
            },
          ],
          relations: [
            {
              relationType: "about",
              entityKey: "artifact:notion-related-pages-md",
            },
          ],
        },
      ),
    },
    {
      leafId: "leaf-output-b",
      title: "Notion page index output",
      summary: "The Notion page index was exported to notion-related-pages.md.",
      body: appendDurableMemoryRelatedSections(
        "# Notion page index output\n\nThe Notion page index was exported to notion-related-pages.md.\n",
        {
          relatedEntities: [
            {
              entityType: "artifact",
              entityKey: "artifact:.-notion-related-pages.md",
              label: "./notion-related-pages.md",
            },
          ],
          relations: [
            {
              relationType: "mentions",
              entityKey: "artifact:.-notion-related-pages.md",
            },
          ],
        },
      ),
    },
  ] as const;

  for (const spec of leafSpecs) {
    const relativePath = `workspace/workspace-1/interaction/entities/project-builder-mode/leaves/${spec.leafId}.md`;
    store.upsertInteractionLeaf({
      workspaceId: "workspace-1",
      leafId: spec.leafId,
      entityId: "interaction:project:builder-mode",
      subjectKey: spec.leafId,
      path: relativePath,
      title: spec.title,
      summary: spec.summary,
      fingerprint: `fingerprint-${spec.leafId}`,
      bodySha256: `sha-${spec.leafId}`,
      tags: ["builder-mode", "artifact"],
      secondaryEntityIds: [],
      sourceType: "assistant_turn",
      sourceEventId: null,
      sourceMessageId: null,
      sourceTurnInputId: "turn-output-1",
      admissionConfidence: 0.95,
      entityConfidence: 0.95,
      observedAt: "2026-06-05T00:00:00.000Z",
      supersedesLeafId: null,
      status: "active",
    });
    const absolutePath = path.join(
      workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
      "interaction",
      "entities",
      "project-builder-mode",
      "leaves",
      `${spec.leafId}.md`,
    );
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, spec.body, "utf8");
  }

  try {
    await rebuildInteractionEntityTree({
      store,
      workspaceId: "workspace-1",
      entityId: "interaction:project:builder-mode",
    });

    const relations = store.listSemanticMemoryRelations({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: "interaction:project:builder-mode",
      limit: 100,
      offset: 0,
    }).filter((relation) => relation.toNodeId === "output-root-1");

    assert.equal(
      new Set(relations.map((relation) => relation.fromNodeId)).size,
      2,
    );
    assert.deepEqual(
      [...new Set(relations.map((relation) => relation.metadata?.entity_key))],
      ["artifact:output:output-1"],
    );
  } finally {
    store.close();
  }
});

test("persistInteractionCandidate supersedes an older active leaf when semantic dedupe identifies a richer replacement", async () => {
  const root = makeTempDir("hb-interaction-memory-dedupe-supersede-");
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
    entityId: "interaction:workflow:silver-oak-refund-review",
    entityType: "workflow",
    canonicalName: "Silver Oak refund review",
    slug: "workflow-silver-oak-refund-review",
    summary: "Workflow memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  const relativePath = "workspace/workspace-1/interaction/entities/workflow-silver-oak-refund-review/leaves/leaf-existing.md";
  store.upsertInteractionLeaf({
    workspaceId: "workspace-1",
    leafId: "leaf-existing",
    entityId: "interaction:workflow:silver-oak-refund-review",
    subjectKey: "silver_oak_refund_review_meeting",
    path: relativePath,
    title: "Silver Oak refund review meeting",
    summary: "The refund review meeting happens every Tuesday.",
    fingerprint: "fingerprint-existing",
    bodySha256: "sha-existing",
    tags: ["workflow", "meeting"],
    secondaryEntityIds: [],
    sourceType: "assistant_turn",
    sourceEventId: null,
    sourceMessageId: null,
    sourceTurnInputId: "input-1",
    admissionConfidence: 0.9,
    entityConfidence: 0.9,
    observedAt: "2026-05-21T00:00:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  const absolutePath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
    "interaction",
    "entities",
    "workflow-silver-oak-refund-review",
    "leaves",
    "leaf-existing.md",
  );
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, "# Refund review meeting\n\nThe Silver Oak refund review meeting happens every Tuesday.\n", "utf8");

  try {
    await withJsonResponseServer({
      responses: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "match_existing",
                  existing_entity_id: "interaction:workflow:silver-oak-refund-review",
                  new_entity_type: null,
                  new_entity_name: null,
                  secondary_entity_ids: [],
                  confidence: 0.97,
                  rationale: "The memory clearly belongs to the existing workflow entity.",
                }),
              },
            },
          ],
        },
        {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "supersedes_existing",
                  existing_leaf_id: "leaf-existing",
                  rationale: "The candidate adds the missing 4 PM Eastern detail and supersedes the generic meeting fact.",
                }),
              },
            },
          ],
        },
      ],
      run: async (baseUrl, requests) => {
        const result = await persistInteractionCandidate({
          store,
          workspaceId: "workspace-1",
          candidate: {
            subjectKey: "silver_oak_refund_review_meeting:tuesday_4pm_eastern",
            title: "Silver Oak refund review meeting at 4 PM Eastern",
            summary: "The Silver Oak refund review meeting happens every Tuesday at 4 PM Eastern.",
            content: "# Silver Oak refund review meeting\n\nThe Silver Oak refund review meeting happens every Tuesday at 4 PM Eastern.\n",
            tags: ["workflow", "meeting"],
            memoryType: "procedure",
            confidence: 0.96,
            observedAt: "2026-05-21T00:05:00.000Z",
          },
          modelClient: {
            baseUrl,
            apiKey: "test-key",
            modelId: "openai/gpt-4.1-mini",
          },
        });

        assert.equal(result.outcome, "superseding");
        assert.notEqual(result.leaf.leafId, "leaf-existing");
        assert.equal(requests.length, 2);
      },
    });

    const activeLeaves = store.listInteractionLeaves({
      workspaceId: "workspace-1",
      entityId: "interaction:workflow:silver-oak-refund-review",
      status: "active",
      limit: 10,
      offset: 0,
    });
    const supersededLeaves = store.listInteractionLeaves({
      workspaceId: "workspace-1",
      entityId: "interaction:workflow:silver-oak-refund-review",
      status: "superseded",
      limit: 10,
      offset: 0,
    });
    assert.equal(activeLeaves.length, 1);
    assert.equal(activeLeaves[0]?.supersedesLeafId, "leaf-existing");
    assert.match(activeLeaves[0]?.summary ?? "", /4 PM Eastern/);
    assert.equal(supersededLeaves.length, 1);
    assert.equal(supersededLeaves[0]?.leafId, "leaf-existing");
  } finally {
    store.close();
  }
});

test("persistInteractionCandidate prefers stable named subjects over workflow ownership for project-like operational memories", async () => {
  const root = makeTempDir("hb-interaction-memory-project-owner-");
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

  try {
    await withJsonResponseServer({
      responses: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "create_new",
                  existing_entity_id: null,
                  new_entity_type: "workflow",
                  new_entity_name: "Atlas Service rollout",
                  secondary_entity_ids: [],
                  confidence: 0.94,
                  rationale: "This looks like rollout workflow knowledge.",
                }),
              },
            },
          ],
        },
      ],
      run: async (baseUrl, requests) => {
        const result = await persistInteractionCandidate({
          store,
          workspaceId: "workspace-1",
          candidate: {
            subjectKey: "atlas_service_rollout_approver:is-casey-ng",
            title: "Atlas Service rollout approver is Casey Ng",
            summary: "Casey Ng is the final Atlas Service rollout approver after staging smoke tests and canary metrics are attached.",
            content: "# Atlas Service rollout approver\n\nCasey Ng is the final Atlas Service rollout approver after staging smoke tests and canary metrics are attached.\n",
            tags: ["release", "approver"],
            memoryType: "fact",
            confidence: 0.96,
            observedAt: "2026-05-21T00:05:00.000Z",
          },
          modelClient: {
            baseUrl,
            apiKey: "test-key",
            modelId: "openai/gpt-4.1-mini",
          },
        });

        assert.equal(result.entity.entityType, "project");
        assert.equal(result.entity.canonicalName, "Atlas Service");
        assert.equal(result.entity.entityId, "interaction:project:atlas-service");
        assert.equal(result.outcome, "created");
        assert.equal(requests.length, 1);
      },
    });
  } finally {
    store.close();
  }
});

test("persistInteractionCandidate keeps generic runbook subjects under workflow when no larger stable owner is present", async () => {
  const root = makeTempDir("hb-interaction-memory-workflow-owner-");
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

  try {
    const result = await persistInteractionCandidate({
      store,
      workspaceId: "workspace-1",
      candidate: {
        subjectKey: "invoice_correction_runbook",
        title: "Invoice correction runbook",
        summary: "For invoice corrections: reopen the ledger case, attach the corrected invoice, then page finance operations.",
        content: "# Invoice correction runbook\n\n1. Reopen the ledger case.\n2. Attach the corrected invoice.\n3. Page finance operations.\n",
        tags: ["workflow", "invoice"],
        memoryType: "procedure",
        confidence: 0.9,
        observedAt: "2026-05-21T00:05:00.000Z",
      },
      modelClient: null,
    });

    assert.equal(result.entity.entityType, "workflow");
    assert.equal(result.entity.canonicalName, "Invoice correction runbook");
    assert.equal(result.outcome, "created");
  } finally {
    store.close();
  }
});

test("persistInteractionCandidate files durable reference topics under a named topic tree instead of uncategorized", async () => {
  const root = makeTempDir("hb-interaction-memory-topic-owner-");
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

  try {
    const result = await persistInteractionCandidate({
      store,
      workspaceId: "workspace-1",
      candidate: {
        subjectKey:
          "holaboss_personal_outreach_external_contacts:individuals-have-emailed-the-user-personally",
        title:
          "External individuals have emailed the user personally about holaboss",
        summary:
          "At least two external individuals reached out to the user specifically about holaboss as a direct personal contact.",
        content:
          "# External individuals have emailed the user personally about holaboss\n\nAt least two external individuals reached out to the user specifically about holaboss as a direct personal contact.\n",
        tags: ["outreach", "contacts"],
        memoryType: "reference",
        confidence: 0.92,
        observedAt: "2026-06-03T08:57:55.231Z",
      },
      modelClient: null,
    });

    assert.equal(result.entity.entityType, "topic");
    assert.equal(
      result.entity.canonicalName,
      "External individuals have emailed the user personally about holaboss",
    );
    assert.equal(
      result.entity.entityId,
      "interaction:topic:external-individuals-have-emailed-the-user-personally-about-holaboss",
    );
    assert.equal(result.outcome, "created");
  } finally {
    store.close();
  }
});

test("persistInteractionCandidate files durable non-ASCII reference topics under a stable named topic tree", async () => {
  const root = makeTempDir("hb-interaction-memory-non-ascii-topic-owner-");
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

  try {
    const result = await persistInteractionCandidate({
      store,
      workspaceId: "workspace-1",
      candidate: {
        subjectKey: "渠道设计阶段决策",
        title: "渠道设计阶段",
        summary: "渠道设计阶段的主叙事和优先级决策。",
        content:
          "# 渠道设计阶段\n\n渠道设计阶段的主叙事和优先级决策。\n",
        tags: ["渠道设计", "阶段"],
        memoryType: "reference",
        confidence: 0.9,
        observedAt: "2026-06-05T08:57:55.231Z",
      },
      modelClient: null,
    });

    assert.equal(result.entity.entityType, "topic");
    assert.equal(result.entity.canonicalName, "渠道设计阶段");
    assert.match(result.entity.entityId, /^interaction:topic:label-[0-9a-f]{12}$/);
    assert.match(result.entity.slug, /^topic-label-[0-9a-f]{12}$/);
    assert.equal(result.outcome, "created");
  } finally {
    store.close();
  }
});

test("persistInteractionCandidate resolves placeholder related labels to the newly created non-ASCII owner entity on first write", async () => {
  const root = makeTempDir("hb-interaction-memory-non-ascii-owner-relation-");
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

  try {
    const result = await persistInteractionCandidate({
      store,
      workspaceId: "workspace-1",
      candidate: {
        subjectKey: "渠道设计阶段决策",
        title: "渠道设计阶段",
        summary: "渠道设计阶段的主叙事和优先级决策。",
        content: appendDurableMemoryRelatedSections(
          "# 渠道设计阶段\n\n渠道设计阶段的主叙事和优先级决策。\n",
          {
            relatedEntities: [
              {
                entityType: "topic",
                entityKey: "topic:topic",
                label: "渠道设计阶段",
              },
            ],
            relations: [
              {
                relationType: "about",
                entityKey: "topic:topic",
              },
            ],
          },
        ),
        tags: ["渠道设计", "阶段"],
        memoryType: "reference",
        confidence: 0.9,
        observedAt: "2026-06-05T08:57:55.231Z",
      },
      modelClient: null,
    });

    const absolutePath = path.join(
      workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
      "interaction",
      "entities",
      result.entity.slug,
      "leaves",
      `${result.leaf.leafId}.md`,
    );
    const body = fs.readFileSync(absolutePath, "utf8");
    const relatedInfo = parseDurableMemoryRelatedInfo(body);

    assert.deepEqual(
      relatedInfo.relatedEntities.map((entry) => entry.entityKey),
      [`topic:entity:${result.entity.entityId}`],
    );
    assert.deepEqual(
      relatedInfo.relations.map((entry) => `${entry.relationType}|${entry.entityKey}`),
      [`about|topic:entity:${result.entity.entityId}`],
    );
    assert.doesNotMatch(body, /`topic:topic`/);
    assert.doesNotMatch(body, /`topic:label-[0-9a-f]{12}`/);

    await rebuildInteractionEntityTree({
      store,
      workspaceId: "workspace-1",
      entityId: result.entity.entityId,
      summaryModelClient: null,
      embeddingClient: null,
    });

    const leafNode = store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: result.entity.entityId,
      status: "active",
      limit: 10_000,
      offset: 0,
    }).find((node) => node.nodeClass === "leaf" && node.title === "渠道设计阶段");
    assert.ok(leafNode);

    const aboutRelation = store.listSemanticMemoryRelations({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: result.entity.entityId,
      limit: 10_000,
      offset: 0,
    }).find((relation) =>
      relation.fromNodeId === leafNode!.nodeId
      && relation.relationType === "about",
    );
    assert.ok(aboutRelation);
    assert.equal(
      aboutRelation?.toNodeId,
      `semantic:interaction:${result.entity.entityId}:tree`,
    );
    assert.equal(
      aboutRelation?.metadata?.target_tree_id,
      result.entity.entityId,
    );
    assert.equal(
      aboutRelation?.metadata?.resolved_target_kind,
      "resolved",
    );
  } finally {
    store.close();
  }
});

test("persistInteractionCandidate treats model-proposed misc owners as deterministic preference owners for rule-like facts", async () => {
  const root = makeTempDir("hb-interaction-memory-preference-owner-");
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

  try {
    await withJsonResponseServer({
      responses: [
        {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: "create_new",
                  existing_entity_id: null,
                  new_entity_type: "misc",
                  new_entity_name: "Uncategorized",
                  secondary_entity_ids: [],
                  confidence: 0.94,
                  rationale: "Generic rule-like fact.",
                }),
              },
            },
          ],
        },
      ],
      run: async (baseUrl) => {
        const result = await persistInteractionCandidate({
          store,
          workspaceId: "workspace-1",
          candidate: {
            subjectKey: "finance-approval-rule",
            title: "Finance approval rule",
            summary: "Invoices over $5000 require finance approval before sending.",
            content: "# Finance approval rule\n\nInvoices over $5000 require finance approval before sending.\n",
            tags: ["finance", "approval"],
            memoryType: "fact",
            confidence: 0.96,
            observedAt: "2026-06-04T00:05:00.000Z",
          },
          modelClient: {
            baseUrl,
            apiKey: "test-key",
            modelId: "openai/gpt-4.1-mini",
          },
        });

        assert.equal(result.entity.entityType, "preference");
        assert.equal(result.entity.canonicalName, "Finance approval rule");
        assert.equal(result.entity.entityId, "interaction:preference:finance-approval-rule");
        assert.equal(result.outcome, "created");
      },
    });
  } finally {
    store.close();
  }
});

test("rebuildInteractionEntityTree reclassifies uncategorized topic-like leaves into a named topic tree", async () => {
  const root = makeTempDir("hb-interaction-memory-reclassify-topic-");
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
    entityId: "interaction:uncategorized",
    entityType: "misc",
    canonicalName: "Uncategorized",
    slug: "uncategorized",
    summary: "Fallback interaction tree.",
    aliases: [],
    isSystem: true,
    status: "active",
  });
  store.upsertInteractionLeaf({
    workspaceId: "workspace-1",
    leafId: "leaf-outreach",
    entityId: "interaction:uncategorized",
    subjectKey:
      "holaboss_personal_outreach_external_contacts:individuals-have-emailed-the-user-personally",
    path: "workspace/workspace-1/interaction/entities/uncategorized/leaves/leaf-outreach.md",
    title: "External individuals have emailed the user personally about holaboss",
    summary:
      "At least two external individuals reached out to the user specifically about holaboss as a direct personal contact.",
    fingerprint: "fingerprint-leaf-outreach",
    bodySha256: "sha-leaf-outreach",
    tags: ["outreach", "contacts"],
    secondaryEntityIds: [],
    sourceType: "assistant_turn",
    sourceEventId: "input-1",
    sourceMessageId: null,
    sourceTurnInputId: "input-1",
    admissionConfidence: 0.92,
    entityConfidence: null,
    observedAt: "2026-06-03T08:57:55.231Z",
    supersedesLeafId: null,
    status: "active",
  });
  const originalLeafPath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
    "interaction",
    "entities",
    "uncategorized",
    "leaves",
    "leaf-outreach.md",
  );
  fs.mkdirSync(path.dirname(originalLeafPath), { recursive: true });
  fs.writeFileSync(
    originalLeafPath,
    "# External individuals have emailed the user personally about holaboss\n\nAt least two external individuals reached out to the user specifically about holaboss as a direct personal contact.\n",
    "utf8",
  );

  try {
    await rebuildInteractionEntityTree({
      store,
      workspaceId: "workspace-1",
      entityId: "interaction:uncategorized",
      summaryModelClient: null,
    });

    const leaf = store.getInteractionLeaf({
      workspaceId: "workspace-1",
      leafId: "leaf-outreach",
    });
    const topicEntity = store.getInteractionEntity({
      workspaceId: "workspace-1",
      entityId:
        "interaction:topic:external-individuals-have-emailed-the-user-personally-about-holaboss",
    });

    assert.ok(leaf);
    assert.equal(leaf?.entityId, topicEntity?.entityId);
    assert.match(
      leaf?.path ?? "",
      /interaction\/entities\/topic-external-individuals-have-emailed-the-user-personally-about-holaboss\/leaves\/leaf-outreach\.md$/,
    );
    assert.ok(topicEntity);
    assert.equal(topicEntity?.entityType, "topic");
    assert.equal(fs.existsSync(originalLeafPath), false);
  } finally {
    store.close();
  }
});
