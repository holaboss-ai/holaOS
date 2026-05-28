import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import {
  countSummaryLikeSemanticIntegrationNodes,
  rebuildIntegrationTree,
  retrieveIntegrationMemory,
} from "./integration-memory.js";
import { globalMemoryDirForWorkspaceRoot } from "./workspace-bundle-paths.js";

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

test("rebuildIntegrationTree writes deterministic semantic summaries for integration roots", async () => {
  const root = makeTempDir("hb-integration-memory-summary-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.upsertIntegrationTree({
    treeId: "integration:github:acct-1",
    provider: "github",
    ownerUserId: "user-1",
    accountKey: "release-github",
    accountLabel: "Release GitHub",
    slug: "github-release-acct-1",
    summary: "Release GitHub memory.",
    status: "active",
  });

  for (let index = 1; index <= 3; index += 1) {
    const leafId = `leaf-${index}`;
    store.upsertIntegrationLeaf({
      leafId,
      treeId: "integration:github:acct-1",
      subjectKey: `repo:holaboss-ai/release:pr:${index}`,
      entityKey: "repo:holaboss-ai/release",
      entityLabel: "holaboss-ai/release",
      branchKey: "pull_requests",
      branchLabel: "Pull requests",
      path: `integration/accounts/github-release-acct-1/leaves/${leafId}.md`,
      title: `Release item ${index}`,
      summary: `Summary for release item ${index}.`,
      fingerprint: `fingerprint-${leafId}`,
      bodySha256: `sha-${leafId}`,
      tags: ["github", "release"],
      sourceType: "github.pull_request",
      sourceEventId: `evt-${index}`,
      sourceMessageId: null,
      externalObjectId: `${index}`,
      externalObjectType: "pull_request",
      admissionConfidence: 0.9,
      observedAt: `2026-05-20T00:0${index}:00.000Z`,
      supersedesLeafId: null,
      status: "active",
    });
    const absolutePath = path.join(
      globalMemoryDirForWorkspaceRoot(workspaceRoot),
      "integration",
      "accounts",
      "github-release-acct-1",
      "leaves",
      `${leafId}.md`,
    );
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(
      absolutePath,
      `# Release item ${index}\n\nSummary for release item ${index}.\n`,
      "utf8",
    );
  }

  try {
    await rebuildIntegrationTree({
      store,
      treeId: "integration:github:acct-1",
      embeddingClient: null,
    });

    const semanticNodes = store.listSemanticMemoryNodes({
      category: "integration",
      treeId: "integration:github:acct-1",
      status: "active",
      limit: 10_000,
      offset: 0,
    });
    const rootNode = semanticNodes.find((node) => node.nodeKind === "connection");

    assert.ok(rootNode);
    assert.equal(
      countSummaryLikeSemanticIntegrationNodes({
        store,
        treeId: "integration:github:acct-1",
      }),
      3,
    );
    assert.equal(rootNode.summary, "Release GitHub memory.");
    const rootPath = path.join(
      globalMemoryDirForWorkspaceRoot(workspaceRoot),
      "semantic",
      "integration",
      "trees",
      "github-release-acct-1",
      "content.md",
    );
    assert.match(fs.readFileSync(rootPath, "utf8"), /Release GitHub memory\./);
  } finally {
    store.close();
  }
});

test("retrieveIntegrationMemory recalls deep-body integration leaf terms through the semantic search index", async () => {
  const root = makeTempDir("hb-integration-memory-fts-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  try {
    store.createWorkspace({
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.upsertIntegrationConnection({
      connectionId: "github-1",
      providerId: "github",
      ownerUserId: "user-1",
      accountLabel: "Release GitHub",
      accountHandle: "release-github",
      authMode: "composio",
      grantedScopes: [],
      status: "active",
    });
    store.upsertIntegrationTree({
      treeId: "integration:github:acct-fts",
      provider: "github",
      ownerUserId: "user-1",
      accountKey: "release-github",
      accountLabel: "Release GitHub",
      slug: "github-release-fts",
      summary: "Release GitHub memory.",
      status: "active",
    });

    const buriedToken = "orbitalfreeze88";
    const leafId = "leaf-deep-body";
    store.upsertIntegrationLeaf({
      leafId,
      treeId: "integration:github:acct-fts",
      subjectKey: "repo:holaboss-ai/release:pr:fts",
      entityKey: "repo:holaboss-ai/release",
      entityLabel: "holaboss-ai/release",
      branchKey: "pull_requests",
      branchLabel: "Pull requests",
      path: `integration/accounts/github-release-fts/leaves/${leafId}.md`,
      title: "Release checksum gate",
      summary: "Release approval depends on a checksum gate deep in the body.",
      fingerprint: `fingerprint-${leafId}`,
      bodySha256: `sha-${leafId}`,
      tags: ["github", "release"],
      sourceType: "github.pull_request",
      sourceEventId: "evt-fts",
      sourceMessageId: null,
      externalObjectId: "9001",
      externalObjectType: "pull_request",
      admissionConfidence: 0.9,
      observedAt: "2026-05-22T09:00:00.000Z",
      supersedesLeafId: null,
      status: "active",
    });

    const absolutePath = path.join(
      globalMemoryDirForWorkspaceRoot(workspaceRoot),
      "integration",
      "accounts",
      "github-release-fts",
      "leaves",
      `${leafId}.md`,
    );
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(
      absolutePath,
      `# Release checksum gate\n\n${"filler ".repeat(90)}${buriedToken} must be green before merge.\n`,
      "utf8",
    );

    await rebuildIntegrationTree({
      store,
      treeId: "integration:github:acct-fts",
      embeddingClient: null,
    });

    const leafNode = store.listSemanticMemoryNodes({
      category: "integration",
      treeId: "integration:github:acct-fts",
      nodeClass: "leaf",
      status: "active",
      limit: 10_000,
      offset: 0,
    })[0];
    assert.ok(leafNode);

    const indexedDoc = store.getSemanticMemorySearchDoc({
      category: "integration",
      treeId: "integration:github:acct-fts",
      nodeId: leafNode!.nodeId,
    });
    assert.ok(indexedDoc);
    assert.equal(indexedDoc?.bodyText.includes(buriedToken), true);
    assert.equal(indexedDoc?.excerpt?.includes(buriedToken) ?? false, false);

    const result = await retrieveIntegrationMemory({
      store,
      workspaceId: "workspace-1",
      query: buriedToken,
      mode: "leaves",
      treeId: "integration:github:acct-fts",
      maxResults: 5,
    });
    assert.ok(result.hits.some((hit) => hit.title === "Release checksum gate"));
  } finally {
    store.close();
  }
});

test("retrieveIntegrationMemory falls back to leaf summaries without reading markdown files", async () => {
  const root = makeTempDir("hb-integration-memory-leaf-fallback-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  try {
    store.createWorkspace({
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.upsertIntegrationConnection({
      connectionId: "github-1",
      providerId: "github",
      ownerUserId: "user-1",
      accountLabel: "Release GitHub",
      accountHandle: "release-github",
      authMode: "composio",
      grantedScopes: [],
      status: "active",
    });
    store.upsertIntegrationTree({
      treeId: "integration:github:acct-fallback",
      provider: "github",
      ownerUserId: "user-1",
      accountKey: "release-github",
      accountLabel: "Release GitHub",
      slug: "github-release-fallback",
      summary: "Release GitHub memory.",
      status: "active",
    });
    store.upsertIntegrationLeaf({
      leafId: "leaf-summary-fallback",
      treeId: "integration:github:acct-fallback",
      subjectKey: "repo:holaboss-ai/release:issue:summary-fallback",
      entityKey: "repo:holaboss-ai/release",
      entityLabel: "holaboss-ai/release",
      branchKey: "issues",
      branchLabel: "Issues",
      path: "integration/accounts/github-release-fallback/leaves/leaf-summary-fallback.md",
      title: "Release metrics backfill",
      summary: "Backfill heliograph metrics after the rollout stabilizes.",
      fingerprint: "fingerprint-leaf-summary-fallback",
      bodySha256: "sha-leaf-summary-fallback",
      tags: ["github", "release"],
      sourceType: "github.issue",
      sourceEventId: "evt-fallback",
      sourceMessageId: null,
      externalObjectId: "202",
      externalObjectType: "issue",
      admissionConfidence: 0.9,
      observedAt: "2026-05-22T10:00:00.000Z",
      supersedesLeafId: null,
      status: "active",
    });

    const result = await retrieveIntegrationMemory({
      store,
      workspaceId: "workspace-1",
      query: "heliograph metrics",
      mode: "leaves",
      treeId: "integration:github:acct-fallback",
      maxResults: 5,
    });

    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0]?.title, "Release metrics backfill");
    assert.match(result.hits[0]?.excerpt ?? "", /heliograph metrics/i);
  } finally {
    store.close();
  }
});

test("retrieveIntegrationMemory adds vector-only semantic candidates that fall outside the recent doc window", async () => {
  const root = makeTempDir("hb-integration-memory-vector-topk-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  try {
    assert.equal(store.supportsVectorIndex(), true);
    writeRecallEmbeddingRuntimeConfig(root);
    store.createWorkspace({
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.upsertIntegrationConnection({
      connectionId: "github-vector",
      providerId: "github",
      ownerUserId: "user-1",
      accountLabel: "Vector GitHub",
      accountHandle: "vector-github",
      authMode: "composio",
      grantedScopes: [],
      status: "active",
    });
    store.upsertIntegrationTree({
      treeId: "integration:github:vector-topk",
      provider: "github",
      ownerUserId: "user-1",
      accountKey: "vector-github",
      accountLabel: "Vector GitHub",
      slug: "github-vector-topk",
      summary: "Vector GitHub memory.",
      status: "active",
    });

    const relevantNodeId = "semantic:integration:integration:github:vector-topk:repo:archive-ledger";
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
      category: "integration",
      treeId: "integration:github:vector-topk",
      docs: [
        ...Array.from({ length: 170 }, (_, index) => ({
          nodeId: index === 169
            ? relevantNodeId
            : `semantic:integration:integration:github:vector-topk:filler-${index + 1}`,
          nodeClass: "semantic" as const,
          nodeKind: index === 169 ? "repo" : "overview",
          path: index === 169
            ? "semantic/integration/trees/github-vector-topk/repo-archive-ledger/content.md"
            : `semantic/integration/trees/github-vector-topk/filler-${index + 1}/content.md`,
          childCount: 0,
          title: index === 169 ? "Archive ledger" : `Filler summary ${index + 1}`,
          summary: index === 169
            ? "Legacy rollout approvals are organized in the archive ledger."
            : `Filler semantic summary ${index + 1}.`,
          bodyText: index === 169
            ? "Legacy rollout approvals are organized in the archive ledger."
            : `Filler semantic summary ${index + 1}.`,
          excerpt: index === 169 ? "Legacy rollout approvals are organized in the archive ledger." : null,
          observedAt: `2026-05-20T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
          status: "active" as const,
          updatedAt: index === 169 ? "2026-01-01T00:00:00.000Z" : "2026-05-31T00:00:00.000Z",
        })),
      ],
    });
    store.upsertIntegrationNodeEmbedding({
      nodeKind: "summary",
      nodeId: relevantNodeId,
      treeId: "integration:github:vector-topk",
      embeddingModel: "text-embedding-3-small",
      contentFingerprint: "v".repeat(64),
      dimensions: 1536,
      vector: relevantVector,
    });

    const result = await retrieveIntegrationMemory({
      store,
      workspaceId: "workspace-1",
      query: "silentorbitvector42",
      mode: "summaries",
      maxResults: 5,
    });
    assert.ok(result.hits.some((hit) => hit.node_id === relevantNodeId && hit.title === "Archive ledger"));
  } finally {
    store.close();
  }
});

test("retrieveIntegrationMemory recalls matches across multiple visible integration trees", async () => {
  const root = makeTempDir("hb-integration-memory-multi-tree-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  try {
    store.createWorkspace({
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    for (const account of [
      { connectionId: "github-1", treeId: "integration:github:acct-a", slug: "github-acct-a", label: "Account A" },
      { connectionId: "github-2", treeId: "integration:github:acct-b", slug: "github-acct-b", label: "Account B" },
    ]) {
      store.upsertIntegrationConnection({
        connectionId: account.connectionId,
        providerId: "github",
        ownerUserId: "user-1",
        accountLabel: account.label,
        accountHandle: account.slug,
        authMode: "composio",
        grantedScopes: [],
        status: "active",
      });
      store.upsertIntegrationTree({
        treeId: account.treeId,
        provider: "github",
        ownerUserId: "user-1",
        accountKey: account.slug,
        accountLabel: account.label,
        slug: account.slug,
        summary: `${account.label} memory.`,
        status: "active",
      });
    }

    const buriedToken = "multitreeorbit77";
    const seedLeaf = (params: {
      treeId: string;
      slug: string;
      leafId: string;
      title: string;
      body: string;
    }) => {
      store.upsertIntegrationLeaf({
        leafId: params.leafId,
        treeId: params.treeId,
        subjectKey: `repo:${params.slug}:${params.leafId}`,
        entityKey: `repo:${params.slug}`,
        entityLabel: params.slug,
        branchKey: "pull_requests",
        branchLabel: "Pull requests",
        path: `integration/accounts/${params.slug}/leaves/${params.leafId}.md`,
        title: params.title,
        summary: `${params.title} summary.`,
        fingerprint: `fingerprint-${params.leafId}`,
        bodySha256: `sha-${params.leafId}`,
        tags: ["github"],
        sourceType: "github.pull_request",
        sourceEventId: `evt-${params.leafId}`,
        sourceMessageId: null,
        externalObjectId: params.leafId,
        externalObjectType: "pull_request",
        admissionConfidence: 0.9,
        observedAt: "2026-05-22T09:00:00.000Z",
        supersedesLeafId: null,
        status: "active",
      });
      const absolutePath = path.join(
        globalMemoryDirForWorkspaceRoot(workspaceRoot),
        "integration",
        "accounts",
        params.slug,
        "leaves",
        `${params.leafId}.md`,
      );
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, params.body, "utf8");
    };

    seedLeaf({
      treeId: "integration:github:acct-a",
      slug: "github-acct-a",
      leafId: "leaf-a",
      title: "General release note",
      body: "# General release note\n\nNormal release work.\n",
    });
    seedLeaf({
      treeId: "integration:github:acct-b",
      slug: "github-acct-b",
      leafId: "leaf-b",
      title: "Checksum gate",
      body: `# Checksum gate\n\n${"filler ".repeat(90)}${buriedToken} must pass before merge.\n`,
    });

    await rebuildIntegrationTree({
      store,
      treeId: "integration:github:acct-a",
      embeddingClient: null,
    });
    await rebuildIntegrationTree({
      store,
      treeId: "integration:github:acct-b",
      embeddingClient: null,
    });

    const result = await retrieveIntegrationMemory({
      store,
      workspaceId: "workspace-1",
      query: buriedToken,
      mode: "leaves",
      maxResults: 5,
    });
    assert.ok(result.hits.some((hit) => hit.tree_id === "integration:github:acct-b" && hit.title === "Checksum gate"));
  } finally {
    store.close();
  }
});

test("retrieveIntegrationMemory follows workspace override visibility without requiring integration bindings", async () => {
  const root = makeTempDir("hb-integration-memory-visibility-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  try {
    store.createWorkspace({
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.upsertIntegrationConnection({
      connectionId: "gmail-1",
      providerId: "gmail",
      ownerUserId: "user-1",
      accountLabel: "ops@example.com",
      accountEmail: "ops@example.com",
      authMode: "composio",
      grantedScopes: [],
      status: "active",
    });
    store.upsertIntegrationTree({
      treeId: "integration:gmail:acct-1",
      provider: "gmail",
      ownerUserId: "user-1",
      accountKey: "ops@example.com",
      accountLabel: "ops@example.com",
      slug: "gmail-ops-example-com-acct-1",
      summary: "Gmail account memory.",
      status: "active",
    });
    store.upsertIntegrationLeaf({
      leafId: "leaf-1",
      treeId: "integration:gmail:acct-1",
      subjectKey: "message:1",
      entityKey: "thread:thread-1",
      entityLabel: "Invoice approval thread",
      branchKey: "messages",
      branchLabel: "Messages",
      path: "integration/accounts/gmail-ops-example-com-acct-1/leaves/leaf-1.md",
      title: "Invoice approval thread",
      summary: "Invoices above $5000 require finance approval.",
      fingerprint: "fingerprint-leaf-1",
      bodySha256: "sha-leaf-1",
      tags: ["gmail", "approval"],
      sourceType: "gmail_message",
      sourceEventId: "evt-1",
      sourceMessageId: "msg-1",
      externalObjectId: "msg-1",
      externalObjectType: "message",
      admissionConfidence: 0.9,
      observedAt: "2026-05-22T00:00:00.000Z",
      supersedesLeafId: null,
      status: "active",
    });

    const leafPath = path.join(
      globalMemoryDirForWorkspaceRoot(workspaceRoot),
      "integration",
      "accounts",
      "gmail-ops-example-com-acct-1",
      "leaves",
      "leaf-1.md",
    );
    fs.mkdirSync(path.dirname(leafPath), { recursive: true });
    fs.writeFileSync(
      leafPath,
      "# Invoice approval thread\n\nInvoices above $5000 require finance approval.\n",
      "utf8",
    );
    await rebuildIntegrationTree({
      store,
      treeId: "integration:gmail:acct-1",
      embeddingClient: null,
    });

    const visible = await retrieveIntegrationMemory({
      store,
      workspaceId: "workspace-1",
      query: "Who approves invoices above $5000?",
      mode: "leaves",
      maxResults: 5,
    });
    assert.equal(visible.hits.length, 1);
    assert.equal(visible.hits[0]?.tree_id, "integration:gmail:acct-1");
    assert.equal(visible.hits[0]?.title, "Invoice approval thread");

    store.upsertWorkspaceIntegrationOverride({
      workspaceId: "workspace-1",
      toolkitSlug: "gmail",
      state: "disabled",
      pinnedConnectionId: null,
    });
    const disabled = await retrieveIntegrationMemory({
      store,
      workspaceId: "workspace-1",
      query: "Who approves invoices above $5000?",
      mode: "mixed",
      maxResults: 5,
    });
    assert.equal(disabled.hits.length, 0);
  } finally {
    store.close();
  }
});

test("retrieveIntegrationMemory surfaces Gmail contact nodes and contact-thread drilldown", async () => {
  const root = makeTempDir("hb-integration-memory-gmail-contacts-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  try {
    store.createWorkspace({
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.upsertIntegrationConnection({
      connectionId: "gmail-1",
      providerId: "gmail",
      ownerUserId: "user-1",
      accountLabel: "ops@example.com",
      accountEmail: "ops@example.com",
      authMode: "composio",
      grantedScopes: [],
      status: "active",
    });
    store.upsertIntegrationTree({
      treeId: "integration:gmail:acct-1",
      provider: "gmail",
      ownerUserId: "user-1",
      accountKey: "ops@example.com",
      accountLabel: "ops@example.com",
      slug: "gmail-ops-example-com-acct-1",
      summary: "Gmail account memory.",
      status: "active",
    });
    store.upsertIntegrationLeaf({
      leafId: "leaf-1",
      treeId: "integration:gmail:acct-1",
      subjectKey: "message:msg-1",
      entityKey: "thread:launch-1",
      entityLabel: "Launch thread",
      branchKey: "messages",
      branchLabel: "Messages",
      path: "integration/accounts/gmail-ops-example-com-acct-1/leaves/leaf-1.md",
      title: "Launch thread message",
      summary: "Alice confirmed the launch checklist.",
      fingerprint: "fingerprint-leaf-1",
      bodySha256: "sha-leaf-1",
      tags: ["gmail", "launch"],
      sourceType: "gmail_message",
      sourceEventId: "evt-1",
      sourceMessageId: "msg-1",
      externalObjectId: "msg-1",
      externalObjectType: "message",
      admissionConfidence: 0.9,
      observedAt: "2026-05-22T00:00:00.000Z",
      supersedesLeafId: null,
      status: "active",
    });
    const legacyLeafPath = path.join(
      globalMemoryDirForWorkspaceRoot(workspaceRoot),
      "integration",
      "accounts",
      "gmail-ops-example-com-acct-1",
      "leaves",
      "leaf-1.md",
    );
    fs.mkdirSync(path.dirname(legacyLeafPath), { recursive: true });
    fs.writeFileSync(
      legacyLeafPath,
      [
        "# Launch thread message",
        "",
        "- From: Alice <alice@example.com>",
        "- To: Ops <ops@example.com>",
        "- Cc: Bob <bob@example.com>",
        "",
        "Alice confirmed the launch checklist.",
        "",
      ].join("\n"),
      "utf8",
    );

    await rebuildIntegrationTree({
      store,
      treeId: "integration:gmail:acct-1",
      embeddingClient: null,
    });

    const result = await retrieveIntegrationMemory({
      store,
      workspaceId: "workspace-1",
      query: "alice@example.com",
      mode: "mixed",
      maxResults: 10,
    });
    const contactHit = result.hits.find((hit) => hit.node_kind === "entity" && hit.title === "alice@example.com");
    assert.ok(contactHit);

    const semanticContacts = store.listSemanticMemoryNodes({
      category: "integration",
      treeId: "integration:gmail:acct-1",
      nodeKind: "contact",
      status: "active",
      limit: 20,
      offset: 0,
    });
    assert.equal(semanticContacts.length, 3);
    const semanticRelations = store.listSemanticMemoryRelations({
      category: "integration",
      treeId: "integration:gmail:acct-1",
      relationType: "participant",
      limit: 20,
      offset: 0,
    });
    assert.ok(
      semanticRelations.some((relation) =>
        relation.fromNodeId === contactHit.node_id
        && relation.metadata.thread_entity_key === "thread:launch-1"
      ),
    );

    const children = await retrieveIntegrationMemory({
      store,
      workspaceId: "workspace-1",
      query: "launch",
      mode: "mixed",
      nodeId: contactHit.node_id,
      maxResults: 10,
    });
    assert.ok(
      (children.children ?? []).some((hit) => hit.node_kind === "entity" && hit.title === "Launch thread"),
    );
  } finally {
    store.close();
  }
});

test("rebuildIntegrationTree writes the Slack semantic memory hierarchy", async () => {
  const root = makeTempDir("hb-integration-memory-slack-semantic-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const treeId = "integration:slack:acct-1";
  const treeSlug = "slack-holaboss-acct-1";

  const writeLeafFile = (relativePath: string, content: string): void => {
    const absolutePath = path.join(globalMemoryDirForWorkspaceRoot(workspaceRoot), relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf8");
  };

  const childNodes = (parentNodeId: string) =>
    store.listSemanticMemoryChildren({
      category: "integration",
      treeId,
      parentNodeId,
    }).map((edge) => {
      const node = store.getSemanticMemoryNode({
        category: "integration",
        treeId,
        nodeId: edge.childNodeId,
      });
      assert.ok(node);
      return node;
    });

  try {
    store.createWorkspace({
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.upsertIntegrationConnection({
      connectionId: "slack-1",
      providerId: "slack",
      ownerUserId: "user-1",
      accountLabel: "Holaboss",
      accountHandle: "holaboss",
      accountExternalId: "T123",
      authMode: "composio",
      grantedScopes: [],
      status: "active",
    });
    store.upsertIntegrationTree({
      treeId,
      provider: "slack",
      ownerUserId: "user-1",
      accountKey: "T123",
      accountLabel: "Holaboss",
      slug: treeSlug,
      summary: "Slack workspace memory.",
      status: "active",
    });

    const leaves = [
      {
        leafId: "leaf-profile",
        subjectKey: "profile",
        entityKey: null,
        entityLabel: null,
        branchKey: "profile",
        branchLabel: "Profile",
        title: "Slack workspace Holaboss",
        summary: "Slack workspace for product and operations coordination.",
        path: "integration/accounts/slack-holaboss-acct-1/leaves/leaf-profile.md",
        sourceType: "slack.profile",
        externalObjectId: "T123",
        externalObjectType: "slack_workspace",
        observedAt: "2026-05-24T00:00:00.000Z",
      },
      {
        leafId: "leaf-channel",
        subjectKey: "channel:C111",
        entityKey: "channel:C111",
        entityLabel: "general",
        branchKey: "overview",
        branchLabel: "Overview",
        title: "general",
        summary: "Primary workspace coordination channel.",
        path: "integration/accounts/slack-holaboss-acct-1/leaves/leaf-channel.md",
        sourceType: "slack.channel",
        externalObjectId: "C111",
        externalObjectType: "slack_channel",
        observedAt: "2026-05-24T00:01:00.000Z",
      },
      {
        leafId: "leaf-message",
        subjectKey: "message:C111:1716412800.000100",
        entityKey: "channel:C111",
        entityLabel: "general",
        branchKey: "messages",
        branchLabel: "Messages",
        title: "Captured the latest memory tree screenshots.",
        summary: "Captured the latest memory tree screenshots.",
        path: "integration/accounts/slack-holaboss-acct-1/leaves/leaf-message.md",
        sourceType: "slack.message",
        externalObjectId: "1716412800.000100",
        externalObjectType: "slack_message",
        observedAt: "2026-05-24T00:02:00.000Z",
      },
      {
        leafId: "leaf-thread",
        subjectKey: "thread:C111:1716412810.000300",
        entityKey: "channel:C111",
        entityLabel: "general",
        branchKey: "threads",
        branchLabel: "Threads",
        title: "Shared the follow-up note in the thread.",
        summary: "Shared the follow-up note in the thread.",
        path: "integration/accounts/slack-holaboss-acct-1/leaves/leaf-thread.md",
        sourceType: "slack.thread-reply",
        externalObjectId: "1716412810.000300",
        externalObjectType: "slack_thread_reply",
        observedAt: "2026-05-24T00:03:00.000Z",
      },
      {
        leafId: "leaf-user",
        subjectKey: "user:U456",
        entityKey: null,
        entityLabel: null,
        branchKey: "directory",
        branchLabel: "Directory",
        title: "Ada Lovelace",
        summary: "Slack workspace member ada@example.com.",
        path: "integration/accounts/slack-holaboss-acct-1/leaves/leaf-user.md",
        sourceType: "slack.user",
        externalObjectId: "U456",
        externalObjectType: "slack_user",
        observedAt: "2026-05-24T00:04:00.000Z",
      },
    ] as const;

    for (const leaf of leaves) {
      store.upsertIntegrationLeaf({
        ...leaf,
        treeId,
        fingerprint: `fingerprint-${leaf.leafId}`,
        bodySha256: `sha-${leaf.leafId}`,
        tags: ["slack"],
        sourceEventId: `evt-${leaf.leafId}`,
        sourceMessageId: null,
        admissionConfidence: 0.9,
        supersedesLeafId: null,
        status: "active",
      });
      writeLeafFile(leaf.path, `# ${leaf.title}\n\n${leaf.summary}\n`);
    }

    await rebuildIntegrationTree({
      store,
      treeId,
      embeddingClient: null,
    });

    const rootNode = store.getSemanticMemoryNodeByPath({
      category: "integration",
      path: `semantic/integration/trees/${treeSlug}/content.md`,
    });
    assert.ok(rootNode);
    assert.equal(rootNode.title, "Holaboss Slack connection");

    const rootChildren = childNodes(rootNode.nodeId);
    assert.deepEqual(rootChildren.map((node) => node.nodeKind), ["profile", "channels", "directory"]);

    const channelsNode = rootChildren[1]!;
    const channelNode = childNodes(channelsNode.nodeId)[0]!;
    assert.equal(channelNode.nodeKind, "channel");
    assert.equal(channelNode.title, "general");

    const channelChildren = childNodes(channelNode.nodeId);
    assert.deepEqual(
      channelChildren.map((node) => ({ kind: node.nodeKind, title: node.title })),
      [
        { kind: "overview", title: "Overview" },
        { kind: "messages", title: "Messages" },
        { kind: "threads", title: "Threads" },
      ],
    );

    const directoryNode = rootChildren[2]!;
    const directoryChildren = childNodes(directoryNode.nodeId);
    assert.ok(directoryChildren.some((node) => node.nodeClass === "leaf" && node.title === "Ada Lovelace"));

    const channelChildrenResult = await retrieveIntegrationMemory({
      store,
      workspaceId: "workspace-1",
      query: "thread",
      mode: "mixed",
      nodeId: channelNode.nodeId,
      maxResults: 10,
    });
    assert.ok(
      (channelChildrenResult.children ?? []).some((hit) => hit.node_kind === "branch" && hit.title === "Threads"),
    );
  } finally {
    store.close();
  }
});

test("rebuildIntegrationTree writes the GitHub semantic memory hierarchy", async () => {
  const root = makeTempDir("hb-integration-memory-github-semantic-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const treeId = "integration:github:acct-1";
  const treeSlug = "github-octocat-acct-1";

  const writeLeafFile = (relativePath: string, content: string): void => {
    const absolutePath = path.join(globalMemoryDirForWorkspaceRoot(workspaceRoot), relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf8");
  };

  const childNodes = (parentNodeId: string) =>
    store.listSemanticMemoryChildren({
      category: "integration",
      treeId,
      parentNodeId,
    }).map((edge) => {
      const node = store.getSemanticMemoryNode({
        category: "integration",
        treeId,
        nodeId: edge.childNodeId,
      });
      assert.ok(node);
      return node;
    });

  try {
    store.createWorkspace({
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.upsertIntegrationConnection({
      connectionId: "github-1",
      providerId: "github",
      ownerUserId: "user-1",
      accountLabel: "The Octocat",
      accountHandle: "octocat",
      authMode: "composio",
      grantedScopes: [],
      status: "active",
    });
    store.upsertIntegrationTree({
      treeId,
      provider: "github",
      ownerUserId: "user-1",
      accountKey: "octocat",
      accountLabel: "The Octocat",
      slug: treeSlug,
      summary: "GitHub repository memory.",
      status: "active",
    });

    const leaves = [
      {
        leafId: "leaf-profile",
        subjectKey: "profile",
        entityKey: null,
        entityLabel: null,
        branchKey: "profile",
        branchLabel: "Profile",
        title: "GitHub profile for The Octocat",
        summary: "The Octocat maintains several public repositories.",
        path: "integration/accounts/github-octocat-acct-1/leaves/leaf-profile.md",
        sourceType: "github.profile",
        externalObjectId: "octocat",
        externalObjectType: "github_profile",
        observedAt: "2026-05-24T00:00:00.000Z",
      },
      {
        leafId: "leaf-overview",
        subjectKey: "repository:holaboss-ai/holaOS",
        entityKey: "repo:holaboss-ai/holaOS",
        entityLabel: "holaboss-ai/holaOS",
        branchKey: "overview",
        branchLabel: "Overview",
        title: "holaboss-ai/holaOS",
        summary: "Desktop runtime for agentic workflows.",
        path: "integration/accounts/github-octocat-acct-1/leaves/leaf-overview.md",
        sourceType: "github.repository",
        externalObjectId: "holaboss-ai/holaOS",
        externalObjectType: "github_repository",
        observedAt: "2026-05-24T00:01:00.000Z",
      },
      {
        leafId: "leaf-readme",
        subjectKey: "readme:holaboss-ai/holaOS",
        entityKey: "repo:holaboss-ai/holaOS",
        entityLabel: "holaboss-ai/holaOS",
        branchKey: "readme",
        branchLabel: "README",
        title: "holaboss-ai/holaOS README",
        summary: "README for holaboss-ai/holaOS: agent runtime and desktop shell.",
        path: "integration/accounts/github-octocat-acct-1/leaves/leaf-readme.md",
        sourceType: "github.readme",
        externalObjectId: "holaboss-ai/holaOS",
        externalObjectType: "github_readme",
        observedAt: "2026-05-24T00:02:00.000Z",
      },
      {
        leafId: "leaf-issue",
        subjectKey: "issue:holaboss-ai/holaOS:128",
        entityKey: "repo:holaboss-ai/holaOS",
        entityLabel: "holaboss-ai/holaOS",
        branchKey: "issues",
        branchLabel: "Issues",
        title: "holaboss-ai/holaOS #128: Stabilize memory retrieval routing",
        summary: "Issue in holaboss-ai/holaOS #128 Stabilize memory retrieval routing",
        path: "integration/accounts/github-octocat-acct-1/leaves/leaf-issue.md",
        sourceType: "github.issue",
        externalObjectId: "holaboss-ai/holaOS#128",
        externalObjectType: "github_issue",
        observedAt: "2026-05-24T00:03:00.000Z",
      },
      {
        leafId: "leaf-pr",
        subjectKey: "pull:holaboss-ai/holaOS:412",
        entityKey: "repo:holaboss-ai/holaOS",
        entityLabel: "holaboss-ai/holaOS",
        branchKey: "pull_requests",
        branchLabel: "Pull requests",
        title: "holaboss-ai/holaOS #412: Expand integration context fetch",
        summary: "Pull request in holaboss-ai/holaOS #412 Expand integration context fetch",
        path: "integration/accounts/github-octocat-acct-1/leaves/leaf-pr.md",
        sourceType: "github.pull_request",
        externalObjectId: "holaboss-ai/holaOS#412",
        externalObjectType: "github_pull_request",
        observedAt: "2026-05-24T00:04:00.000Z",
      },
      {
        leafId: "leaf-notification",
        subjectKey: "notification:notif-1",
        entityKey: "repo:holaboss-ai/holaOS",
        entityLabel: "holaboss-ai/holaOS",
        branchKey: "notifications",
        branchLabel: "Notifications",
        title: "Review rollout checklist",
        summary: "Notification in holaboss-ai/holaOS Review rollout checklist because mention",
        path: "integration/accounts/github-octocat-acct-1/leaves/leaf-notification.md",
        sourceType: "github.notification",
        externalObjectId: "notif-1",
        externalObjectType: "github_notification",
        observedAt: "2026-05-24T00:05:00.000Z",
      },
    ] as const;

    for (const leaf of leaves) {
      store.upsertIntegrationLeaf({
        ...leaf,
        treeId,
        fingerprint: `fingerprint-${leaf.leafId}`,
        bodySha256: `sha-${leaf.leafId}`,
        tags: ["github"],
        sourceEventId: `evt-${leaf.leafId}`,
        sourceMessageId: null,
        admissionConfidence: 0.9,
        supersedesLeafId: null,
        status: "active",
      });
      writeLeafFile(leaf.path, `# ${leaf.title}\n\n${leaf.summary}\n`);
    }

    await rebuildIntegrationTree({
      store,
      treeId,
      embeddingClient: null,
    });

    const rootNode = store.getSemanticMemoryNodeByPath({
      category: "integration",
      path: `semantic/integration/trees/${treeSlug}/content.md`,
    });
    assert.ok(rootNode);
    assert.equal(rootNode.title, "The Octocat GitHub connection");

    const rootChildren = childNodes(rootNode.nodeId);
    assert.deepEqual(rootChildren.map((node) => node.nodeKind), ["profile", "repositories"]);

    const repositoriesNode = rootChildren[1]!;
    const repoNode = childNodes(repositoriesNode.nodeId)[0]!;
    assert.equal(repoNode.nodeKind, "repo");
    assert.equal(repoNode.title, "holaboss-ai/holaOS");

    const repoChildren = childNodes(repoNode.nodeId);
    assert.deepEqual(
      repoChildren.map((node) => ({ kind: node.nodeKind, title: node.title })),
      [
        { kind: "overview", title: "Overview" },
        { kind: "readme", title: "README" },
        { kind: "issues", title: "Issues" },
        { kind: "pull_requests", title: "Pull requests" },
        { kind: "notifications", title: "Notifications" },
      ],
    );

    const repoChildrenResult = await retrieveIntegrationMemory({
      store,
      workspaceId: "workspace-1",
      query: "issues",
      mode: "mixed",
      nodeId: repoNode.nodeId,
      maxResults: 5,
    });
    assert.ok(
      (repoChildrenResult.children ?? []).some((hit) => hit.node_kind === "branch" && hit.title === "Issues"),
    );
  } finally {
    store.close();
  }
});

test("rebuildIntegrationTree writes the Notion semantic memory hierarchy", async () => {
  const root = makeTempDir("hb-integration-memory-notion-semantic-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const treeId = "integration:notion:acct-1";
  const treeSlug = "notion-product-ops-acct-1";

  const writeLeafFile = (relativePath: string, content: string): void => {
    const absolutePath = path.join(globalMemoryDirForWorkspaceRoot(workspaceRoot), relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf8");
  };

  const requireNode = (nodeId: string) => {
    const node = store.getSemanticMemoryNode({
      category: "integration",
      treeId,
      nodeId,
    });
    assert.ok(node, `expected semantic node ${nodeId}`);
    return node;
  };

  const childNodes = (parentNodeId: string) =>
    store.listSemanticMemoryChildren({
      category: "integration",
      treeId,
      parentNodeId,
    }).map((edge) => requireNode(edge.childNodeId));

  try {
    store.createWorkspace({
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.upsertIntegrationConnection({
      connectionId: "notion-1",
      providerId: "notion",
      ownerUserId: "user-1",
      accountLabel: "Product Ops",
      accountExternalId: "workspace-123",
      authMode: "composio",
      grantedScopes: [],
      status: "active",
    });
    store.upsertIntegrationTree({
      treeId,
      provider: "notion",
      ownerUserId: "user-1",
      accountKey: "workspace-123",
      accountLabel: "Product Ops",
      slug: treeSlug,
      summary: "Notion product workspace memory.",
      status: "active",
    });

    store.upsertIntegrationLeaf({
      leafId: "leaf-workspace",
      treeId,
      subjectKey: "workspace_snapshot",
      entityKey: null,
      entityLabel: null,
      branchKey: "workspace",
      branchLabel: "Workspace",
      path: "integration/accounts/notion-product-ops-acct-1/leaves/leaf-workspace.md",
      title: "Notion workspace for Product Ops",
      summary: "Product Ops workspace snapshot with roadmap pages and task databases.",
      fingerprint: "fingerprint-workspace",
      bodySha256: "sha-workspace",
      tags: ["notion", "workspace"],
      sourceType: "notion.workspace",
      sourceEventId: "evt-workspace",
      sourceMessageId: null,
      externalObjectId: "workspace-123",
      externalObjectType: "notion_workspace",
      admissionConfidence: 0.95,
      observedAt: "2026-05-24T00:00:00.000Z",
      supersedesLeafId: null,
      status: "active",
    });
    writeLeafFile(
      "integration/accounts/notion-product-ops-acct-1/leaves/leaf-workspace.md",
      "# Notion workspace for Product Ops\n\nWorkspace snapshot.\n",
    );

    store.upsertIntegrationLeaf({
      leafId: "leaf-page-overview",
      treeId,
      subjectKey: "page:page-1",
      entityKey: "page:page-1",
      entityLabel: "Roadmap",
      branchKey: "overview",
      branchLabel: "Overview",
      path: "integration/accounts/notion-product-ops-acct-1/leaves/leaf-page-overview.md",
      title: "Roadmap",
      summary: "Roadmap page covers milestones for launch and hiring.",
      fingerprint: "fingerprint-page-overview",
      bodySha256: "sha-page-overview",
      tags: ["notion", "page"],
      sourceType: "notion.page",
      sourceEventId: "evt-page-overview",
      sourceMessageId: null,
      externalObjectId: "page-1",
      externalObjectType: "page",
      admissionConfidence: 0.9,
      observedAt: "2026-05-24T00:01:00.000Z",
      supersedesLeafId: null,
      status: "active",
    });
    writeLeafFile(
      "integration/accounts/notion-product-ops-acct-1/leaves/leaf-page-overview.md",
      "# Roadmap\n\nOverview of the roadmap page.\n",
    );

    store.upsertIntegrationLeaf({
      leafId: "leaf-page-content",
      treeId,
      subjectKey: "page_content:page-1",
      entityKey: "page:page-1",
      entityLabel: "Roadmap",
      branchKey: "content",
      branchLabel: "Content",
      path: "integration/accounts/notion-product-ops-acct-1/leaves/leaf-page-content.md",
      title: "Roadmap content",
      summary: "Launch is scheduled for June and hiring closes in July.",
      fingerprint: "fingerprint-page-content",
      bodySha256: "sha-page-content",
      tags: ["notion", "page", "content"],
      sourceType: "notion.page_markdown",
      sourceEventId: "evt-page-content",
      sourceMessageId: null,
      externalObjectId: "page-1",
      externalObjectType: "page",
      admissionConfidence: 0.9,
      observedAt: "2026-05-24T00:02:00.000Z",
      supersedesLeafId: null,
      status: "active",
    });
    writeLeafFile(
      "integration/accounts/notion-product-ops-acct-1/leaves/leaf-page-content.md",
      "# Roadmap content\n\nJune launch and July hiring timeline.\n",
    );

    store.upsertIntegrationLeaf({
      leafId: "leaf-database-overview",
      treeId,
      subjectKey: "database:db-1",
      entityKey: "database:db-1",
      entityLabel: "Launch Tasks",
      branchKey: "overview",
      branchLabel: "Overview",
      path: "integration/accounts/notion-product-ops-acct-1/leaves/leaf-database-overview.md",
      title: "Launch Tasks",
      summary: "Launch Tasks database tracks owners, deadlines, and status.",
      fingerprint: "fingerprint-database-overview",
      bodySha256: "sha-database-overview",
      tags: ["notion", "database"],
      sourceType: "notion.database",
      sourceEventId: "evt-database-overview",
      sourceMessageId: null,
      externalObjectId: "db-1",
      externalObjectType: "database",
      admissionConfidence: 0.9,
      observedAt: "2026-05-24T00:03:00.000Z",
      supersedesLeafId: null,
      status: "active",
    });
    writeLeafFile(
      "integration/accounts/notion-product-ops-acct-1/leaves/leaf-database-overview.md",
      "# Launch Tasks\n\nDatabase overview.\n",
    );

    store.upsertIntegrationLeaf({
      leafId: "leaf-row-1",
      treeId,
      subjectKey: "database_row:row-1",
      entityKey: "database:db-1",
      entityLabel: "Launch Tasks",
      branchKey: "rows",
      branchLabel: "Rows",
      path: "integration/accounts/notion-product-ops-acct-1/leaves/leaf-row-1.md",
      title: "Task row: Announce launch",
      summary: "Announcement task is owned by marketing and due May 31.",
      fingerprint: "fingerprint-row-1",
      bodySha256: "sha-row-1",
      tags: ["notion", "database", "row"],
      sourceType: "notion.database_row",
      sourceEventId: "evt-row-1",
      sourceMessageId: null,
      externalObjectId: "row-1",
      externalObjectType: "database_row",
      admissionConfidence: 0.9,
      observedAt: "2026-05-24T00:04:00.000Z",
      supersedesLeafId: null,
      status: "active",
    });
    writeLeafFile(
      "integration/accounts/notion-product-ops-acct-1/leaves/leaf-row-1.md",
      "# Task row: Announce launch\n\nOwned by marketing.\n",
    );

    await rebuildIntegrationTree({
      store,
      treeId,
      embeddingClient: null,
    });

    const rootNode = store.getSemanticMemoryNodeByPath({
      category: "integration",
      path: "semantic/integration/trees/notion-product-ops-acct-1/content.md",
    });
    assert.ok(rootNode);
    assert.equal(rootNode.nodeKind, "connection");
    assert.equal(rootNode.title, "Product Ops Notion connection");

    const rootChildren = childNodes(rootNode.nodeId);
    assert.deepEqual(rootChildren.map((node) => node.nodeKind), ["workspace"]);

    const workspaceNode = rootChildren[0]!;
    assert.equal(workspaceNode.title, "Notion workspace for Product Ops");

    const roadmapNode = store.listSemanticMemoryNodes({
      category: "integration",
      treeId,
      nodeKind: "page",
      status: "active",
      limit: 10,
      offset: 0,
    }).find((node) => node.title === "Roadmap");
    assert.ok(roadmapNode);
    const roadmapChildren = await retrieveIntegrationMemory({
      store,
      workspaceId: "workspace-1",
      query: "launch",
      mode: "mixed",
      nodeId: roadmapNode.nodeId,
      maxResults: 10,
    });
    assert.ok(
      (roadmapChildren.children ?? []).some((hit) => hit.node_kind === "branch" && hit.title === "Content"),
    );

    const workspaceChildren = childNodes(workspaceNode.nodeId);
    assert.deepEqual(
      workspaceChildren.map((node) => node.nodeKind),
      ["overview", "pages", "databases"],
    );

    const workspaceOverview = workspaceChildren[0]!;
    const workspaceOverviewChildren = childNodes(workspaceOverview.nodeId);
    assert.deepEqual(
      workspaceOverviewChildren.map((node) => ({ nodeClass: node.nodeClass, title: node.title })),
      [{ nodeClass: "leaf", title: "Notion workspace for Product Ops" }],
    );

    const pagesNode = workspaceChildren[1]!;
    const pagesChildren = childNodes(pagesNode.nodeId);
    assert.deepEqual(
      pagesChildren.map((node) => ({ kind: node.nodeKind, title: node.title })),
      [{ kind: "page", title: "Roadmap" }],
    );

    const pageNode = pagesChildren[0]!;
    const pageChildren = childNodes(pageNode.nodeId);
    assert.deepEqual(
      pageChildren.map((node) => ({ kind: node.nodeKind, title: node.title })),
      [
        { kind: "overview", title: "Overview" },
        { kind: "content", title: "Content" },
      ],
    );
    assert.deepEqual(
      childNodes(pageChildren[0]!.nodeId).map((node) => node.title),
      ["Roadmap"],
    );
    assert.deepEqual(
      childNodes(pageChildren[1]!.nodeId).map((node) => node.title),
      ["Roadmap content"],
    );

    const databasesNode = workspaceChildren[2]!;
    const databaseChildren = childNodes(databasesNode.nodeId);
    assert.deepEqual(
      databaseChildren.map((node) => ({ kind: node.nodeKind, title: node.title })),
      [{ kind: "database", title: "Launch Tasks" }],
    );

    const databaseNode = databaseChildren[0]!;
    const databaseFacetChildren = childNodes(databaseNode.nodeId);
    assert.deepEqual(
      databaseFacetChildren.map((node) => ({ kind: node.nodeKind, title: node.title })),
      [
        { kind: "overview", title: "Overview" },
        { kind: "rows", title: "Rows" },
      ],
    );
    assert.deepEqual(
      childNodes(databaseFacetChildren[0]!.nodeId).map((node) => node.title),
      ["Launch Tasks"],
    );
    assert.deepEqual(
      childNodes(databaseFacetChildren[1]!.nodeId).map((node) => node.title),
      ["Task row: Announce launch"],
    );

    const pageNodeFile = path.join(
      globalMemoryDirForWorkspaceRoot(workspaceRoot),
      "semantic",
      "integration",
      "trees",
      treeSlug,
      "workspace-workspace-123",
      "pages",
      "page-page-1",
      "content.md",
    );
    assert.match(fs.readFileSync(pageNodeFile, "utf8"), /# Roadmap/);

    assert.ok(
      store.listSemanticMemoryNodes({
        category: "integration",
        treeId,
        limit: 100,
      }).length > 0,
    );
    store.deleteIntegrationTreeMemory({ treeId });
    assert.equal(
      store.listSemanticMemoryNodes({
        category: "integration",
        treeId,
        limit: 100,
      }).length,
      0,
    );
  } finally {
    store.close();
  }
});

test("rebuildIntegrationTree writes the Google Drive semantic memory hierarchy", async () => {
  const root = makeTempDir("hb-integration-memory-googledrive-semantic-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const treeId = "integration:googledrive:acct-1";
  const treeSlug = "googledrive-product-ops-acct-1";

  const writeLeafFile = (relativePath: string, content: string): void => {
    const absolutePath = path.join(globalMemoryDirForWorkspaceRoot(workspaceRoot), relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf8");
  };

  const requireNode = (nodeId: string) => {
    const node = store.getSemanticMemoryNode({
      category: "integration",
      treeId,
      nodeId,
    });
    assert.ok(node, `expected semantic node ${nodeId}`);
    return node;
  };

  const childNodes = (parentNodeId: string) =>
    store.listSemanticMemoryChildren({
      category: "integration",
      treeId,
      parentNodeId,
    }).map((edge) => requireNode(edge.childNodeId));

  try {
    store.createWorkspace({
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.upsertIntegrationConnection({
      connectionId: "googledrive-1",
      providerId: "googledrive",
      ownerUserId: "user-1",
      accountLabel: "Product Ops",
      accountEmail: "ops@example.com",
      authMode: "composio",
      grantedScopes: [],
      status: "active",
    });
    store.upsertIntegrationTree({
      treeId,
      provider: "googledrive",
      ownerUserId: "user-1",
      accountKey: "ops@example.com",
      accountLabel: "Product Ops",
      slug: treeSlug,
      summary: "Google Drive product workspace memory.",
      status: "active",
    });

    store.upsertIntegrationLeaf({
      leafId: "leaf-profile",
      treeId,
      subjectKey: "profile",
      entityKey: null,
      entityLabel: null,
      branchKey: "profile",
      branchLabel: "Profile",
      path: "integration/accounts/googledrive-product-ops-acct-1/leaves/leaf-profile.md",
      title: "Google Drive profile for Product Ops",
      summary: "Product Ops Google Drive profile snapshot.",
      fingerprint: "fingerprint-profile",
      bodySha256: "sha-profile",
      tags: ["googledrive", "profile"],
      sourceType: "googledrive.profile",
      sourceEventId: "evt-profile",
      sourceMessageId: null,
      externalObjectId: "ops@example.com",
      externalObjectType: "google_drive_profile",
      admissionConfidence: 0.95,
      observedAt: "2026-05-24T00:00:00.000Z",
      supersedesLeafId: null,
      status: "active",
    });
    writeLeafFile(
      "integration/accounts/googledrive-product-ops-acct-1/leaves/leaf-profile.md",
      "# Google Drive profile for Product Ops\n\nProfile snapshot.\n",
    );

    store.upsertIntegrationLeaf({
      leafId: "leaf-file-overview",
      treeId,
      subjectKey: "file:file-1",
      entityKey: "file:file-1",
      entityLabel: "Q2 Plan",
      branchKey: "overview",
      branchLabel: "Overview",
      path: "integration/accounts/googledrive-product-ops-acct-1/leaves/leaf-file-overview.md",
      title: "Q2 Plan",
      summary: "Q2 planning notes for the launch roadmap.",
      fingerprint: "fingerprint-file-overview",
      bodySha256: "sha-file-overview",
      tags: ["googledrive", "file"],
      sourceType: "googledrive.file",
      sourceEventId: "evt-file-overview",
      sourceMessageId: null,
      externalObjectId: "file-1",
      externalObjectType: "google_drive_file",
      admissionConfidence: 0.9,
      observedAt: "2026-05-24T00:01:00.000Z",
      supersedesLeafId: null,
      status: "active",
    });
    writeLeafFile(
      "integration/accounts/googledrive-product-ops-acct-1/leaves/leaf-file-overview.md",
      "# Q2 Plan\n\nOverview of the Q2 planning doc.\n",
    );

    store.upsertIntegrationLeaf({
      leafId: "leaf-folder-overview",
      treeId,
      subjectKey: "file:folder-1",
      entityKey: "file:folder-1",
      entityLabel: "Launch Assets",
      branchKey: "overview",
      branchLabel: "Overview",
      path: "integration/accounts/googledrive-product-ops-acct-1/leaves/leaf-folder-overview.md",
      title: "Launch Assets",
      summary: "Shared folder for launch creative and supporting docs.",
      fingerprint: "fingerprint-folder-overview",
      bodySha256: "sha-folder-overview",
      tags: ["googledrive", "folder"],
      sourceType: "googledrive.folder",
      sourceEventId: "evt-folder-overview",
      sourceMessageId: null,
      externalObjectId: "folder-1",
      externalObjectType: "google_drive_folder",
      admissionConfidence: 0.9,
      observedAt: "2026-05-24T00:02:00.000Z",
      supersedesLeafId: null,
      status: "active",
    });
    writeLeafFile(
      "integration/accounts/googledrive-product-ops-acct-1/leaves/leaf-folder-overview.md",
      "# Launch Assets\n\nShared folder for launch assets.\n",
    );

    await rebuildIntegrationTree({
      store,
      treeId,
      embeddingClient: null,
    });

    const rootNode = store.getSemanticMemoryNodeByPath({
      category: "integration",
      path: `semantic/integration/trees/${treeSlug}/content.md`,
    });
    assert.ok(rootNode);
    assert.equal(rootNode.title, "Product Ops Google Drive connection");

    const rootChildren = childNodes(rootNode.nodeId);
    assert.deepEqual(rootChildren.map((node) => node.nodeKind), ["profile", "files"]);

    const filesNode = rootChildren[1]!;
    const filesChildren = childNodes(filesNode.nodeId);
    assert.deepEqual(
      filesChildren.map((node) => ({ kind: node.nodeKind, title: node.title })),
      [
        { kind: "folder", title: "Launch Assets" },
        { kind: "file", title: "Q2 Plan" },
      ],
    );

    const folderNode = filesChildren[0]!;
    const folderChildren = childNodes(folderNode.nodeId);
    assert.deepEqual(
      folderChildren.map((node) => ({ kind: node.nodeKind, title: node.title })),
      [{ kind: "overview", title: "Overview" }],
    );
    assert.deepEqual(childNodes(folderChildren[0]!.nodeId).map((node) => node.title), ["Launch Assets"]);

    const fileNode = filesChildren[1]!;
    const fileResult = await retrieveIntegrationMemory({
      store,
      workspaceId: "workspace-1",
      query: "planning",
      mode: "mixed",
      nodeId: fileNode.nodeId,
      maxResults: 5,
    });
    assert.ok(
      (fileResult.children ?? []).some((hit) => hit.node_kind === "branch" && hit.title === "Overview"),
    );

    const fileNodePath = path.join(
      globalMemoryDirForWorkspaceRoot(workspaceRoot),
      "semantic",
      "integration",
      "trees",
      treeSlug,
      "files",
      "file-file-1",
      "content.md",
    );
    assert.match(fs.readFileSync(fileNodePath, "utf8"), /# Q2 Plan/);
  } finally {
    store.close();
  }
});

test("rebuildIntegrationTree writes the Twitter semantic memory hierarchy", async () => {
  const root = makeTempDir("hb-integration-memory-twitter-semantic-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const treeId = "integration:twitter:acct-1";
  const treeSlug = "twitter-holabossai-acct-1";

  const writeLeafFile = (relativePath: string, content: string): void => {
    const absolutePath = path.join(globalMemoryDirForWorkspaceRoot(workspaceRoot), relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf8");
  };

  const requireNode = (nodeId: string) => {
    const node = store.getSemanticMemoryNode({
      category: "integration",
      treeId,
      nodeId,
    });
    assert.ok(node, `expected semantic node ${nodeId}`);
    return node;
  };

  const childNodes = (parentNodeId: string) =>
    store.listSemanticMemoryChildren({
      category: "integration",
      treeId,
      parentNodeId,
    }).map((edge) => requireNode(edge.childNodeId));

  try {
    store.createWorkspace({
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.upsertIntegrationConnection({
      connectionId: "twitter-1",
      providerId: "twitter",
      ownerUserId: "user-1",
      accountLabel: "HolaBoss (@holabossai)",
      accountHandle: "holabossai",
      authMode: "composio",
      grantedScopes: [],
      status: "active",
    });
    store.upsertIntegrationTree({
      treeId,
      provider: "twitter",
      ownerUserId: "user-1",
      accountKey: "holabossai",
      accountLabel: "HolaBoss (@holabossai)",
      slug: treeSlug,
      summary: "Twitter account memory.",
      status: "active",
    });

    store.upsertIntegrationLeaf({
      leafId: "leaf-profile",
      treeId,
      subjectKey: "profile",
      entityKey: null,
      entityLabel: null,
      branchKey: "profile",
      branchLabel: "Profile",
      path: "integration/accounts/twitter-holabossai-acct-1/leaves/leaf-profile.md",
      title: "Twitter profile for HolaBoss (@holabossai)",
      summary: "Twitter profile snapshot for HolaBoss.",
      fingerprint: "fingerprint-profile",
      bodySha256: "sha-profile",
      tags: ["twitter", "profile"],
      sourceType: "twitter.profile",
      sourceEventId: "evt-profile",
      sourceMessageId: null,
      externalObjectId: "user-42",
      externalObjectType: "twitter_profile",
      admissionConfidence: 0.95,
      observedAt: "2026-05-24T00:00:00.000Z",
      supersedesLeafId: null,
      status: "active",
    });
    writeLeafFile(
      "integration/accounts/twitter-holabossai-acct-1/leaves/leaf-profile.md",
      "# Twitter profile for HolaBoss (@holabossai)\n\nProfile snapshot.\n",
    );

    store.upsertIntegrationLeaf({
      leafId: "leaf-post-1",
      treeId,
      subjectKey: "post:post-1",
      entityKey: "post:post-1",
      entityLabel: "Shipped semantic memory trees for Gmail, GitHub, and Notion.",
      branchKey: "overview",
      branchLabel: "Overview",
      path: "integration/accounts/twitter-holabossai-acct-1/leaves/leaf-post-1.md",
      title: "Shipped semantic memory trees for Gmail, GitHub, and Notion.",
      summary: "@holabossai: shipped semantic memory trees for Gmail, GitHub, and Notion.",
      fingerprint: "fingerprint-post-1",
      bodySha256: "sha-post-1",
      tags: ["twitter", "post"],
      sourceType: "twitter.post",
      sourceEventId: "evt-post-1",
      sourceMessageId: null,
      externalObjectId: "post-1",
      externalObjectType: "twitter_post",
      admissionConfidence: 0.88,
      observedAt: "2026-05-24T00:01:00.000Z",
      supersedesLeafId: null,
      status: "active",
    });
    writeLeafFile(
      "integration/accounts/twitter-holabossai-acct-1/leaves/leaf-post-1.md",
      "# Post 1\n\nShipped semantic memory trees for Gmail, GitHub, and Notion.\n",
    );

    store.upsertIntegrationLeaf({
      leafId: "leaf-post-2",
      treeId,
      subjectKey: "post:post-2",
      entityKey: "post:post-2",
      entityLabel: "Next up is wiring Google Drive and Twitter into context fetch.",
      branchKey: "overview",
      branchLabel: "Overview",
      path: "integration/accounts/twitter-holabossai-acct-1/leaves/leaf-post-2.md",
      title: "Next up is wiring Google Drive and Twitter into context fetch.",
      summary: "@holabossai: next up is wiring Google Drive and Twitter into context fetch.",
      fingerprint: "fingerprint-post-2",
      bodySha256: "sha-post-2",
      tags: ["twitter", "post"],
      sourceType: "twitter.post",
      sourceEventId: "evt-post-2",
      sourceMessageId: null,
      externalObjectId: "post-2",
      externalObjectType: "twitter_post",
      admissionConfidence: 0.88,
      observedAt: "2026-05-24T00:02:00.000Z",
      supersedesLeafId: null,
      status: "active",
    });
    writeLeafFile(
      "integration/accounts/twitter-holabossai-acct-1/leaves/leaf-post-2.md",
      "# Post 2\n\nNext up is wiring Google Drive and Twitter into context fetch.\n",
    );

    await rebuildIntegrationTree({
      store,
      treeId,
      embeddingClient: null,
    });

    const rootNode = store.getSemanticMemoryNodeByPath({
      category: "integration",
      path: `semantic/integration/trees/${treeSlug}/content.md`,
    });
    assert.ok(rootNode);
    assert.equal(rootNode.title, "HolaBoss (@holabossai) Twitter connection");

    const rootChildren = childNodes(rootNode.nodeId);
    assert.deepEqual(rootChildren.map((node) => node.nodeKind), ["profile", "timeline"]);

    const timelineNode = rootChildren[1]!;
    const timelineChildren = childNodes(timelineNode.nodeId);
    assert.deepEqual(
      timelineChildren.map((node) => ({ kind: node.nodeKind, title: node.title })),
      [
        { kind: "post", title: "Next up is wiring Google Drive and Twitter into context fetch." },
        { kind: "post", title: "Shipped semantic memory trees for Gmail, GitHub, and Notion." },
      ],
    );

    const newestPostNode = timelineChildren[0]!;
    const newestPostChildren = childNodes(newestPostNode.nodeId);
    assert.deepEqual(
      newestPostChildren.map((node) => ({ kind: node.nodeKind, title: node.title })),
      [{ kind: "overview", title: "Overview" }],
    );
    assert.deepEqual(
      childNodes(newestPostChildren[0]!.nodeId).map((node) => node.title),
      ["Next up is wiring Google Drive and Twitter into context fetch."],
    );

    const timelineResult = await retrieveIntegrationMemory({
      store,
      workspaceId: "workspace-1",
      query: "Google Drive",
      mode: "mixed",
      nodeId: timelineNode.nodeId,
      maxResults: 5,
    });
    assert.ok(
      (timelineResult.children ?? []).some((hit) => hit.node_kind === "entity" && hit.title.includes("Google Drive")),
    );

    const latestPostNodePath = path.join(
      globalMemoryDirForWorkspaceRoot(workspaceRoot),
      "semantic",
      "integration",
      "trees",
      treeSlug,
      "timeline",
      "post-post-2",
      "content.md",
    );
    assert.match(fs.readFileSync(latestPostNodePath, "utf8"), /# Next up is wiring Google Drive and Twitter into context fetch\./);
  } finally {
    store.close();
  }
});

test("rebuildIntegrationTree writes the Google Calendar semantic memory hierarchy", async () => {
  const root = makeTempDir("hb-integration-memory-googlecalendar-semantic-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const treeId = "integration:googlecalendar:acct-1";
  const treeSlug = "googlecalendar-product-ops-acct-1";

  const writeLeafFile = (relativePath: string, content: string): void => {
    const absolutePath = path.join(globalMemoryDirForWorkspaceRoot(workspaceRoot), relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf8");
  };

  const requireNode = (nodeId: string) => {
    const node = store.getSemanticMemoryNode({
      category: "integration",
      treeId,
      nodeId,
    });
    assert.ok(node, `expected semantic node ${nodeId}`);
    return node;
  };

  const childNodes = (parentNodeId: string) =>
    store.listSemanticMemoryChildren({
      category: "integration",
      treeId,
      parentNodeId,
    }).map((edge) => requireNode(edge.childNodeId));

  try {
    store.createWorkspace({
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.upsertIntegrationConnection({
      connectionId: "googlecalendar-1",
      providerId: "googlecalendar",
      ownerUserId: "user-1",
      accountLabel: "Product Ops",
      accountEmail: "ops@example.com",
      authMode: "composio",
      grantedScopes: [],
      status: "active",
    });
    store.upsertIntegrationTree({
      treeId,
      provider: "googlecalendar",
      ownerUserId: "user-1",
      accountKey: "ops@example.com",
      accountLabel: "Product Ops",
      slug: treeSlug,
      summary: "Google Calendar operating memory.",
      status: "active",
    });

    const leaves = [
      {
        leafId: "leaf-profile",
        subjectKey: "profile",
        entityKey: null,
        entityLabel: null,
        branchKey: "profile",
        branchLabel: "Profile",
        title: "Google Calendar profile for Product Ops",
        summary: "Product Ops Google Calendar snapshot across 2 calendars.",
        path: "integration/accounts/googlecalendar-product-ops-acct-1/leaves/leaf-profile.md",
        sourceType: "googlecalendar.profile",
        externalObjectId: "ops@example.com",
        externalObjectType: "google_calendar_profile",
        observedAt: "2026-05-24T00:00:00.000Z",
      },
      {
        leafId: "leaf-calendar-ops",
        subjectKey: "calendar:ops@example.com",
        entityKey: "calendar:ops@example.com",
        entityLabel: "Product Ops",
        branchKey: "overview",
        branchLabel: "Overview",
        title: "Product Ops",
        summary: "Primary operating calendar.",
        path: "integration/accounts/googlecalendar-product-ops-acct-1/leaves/leaf-calendar-ops.md",
        sourceType: "googlecalendar.calendar",
        externalObjectId: "ops@example.com",
        externalObjectType: "google_calendar",
        observedAt: "2026-05-24T00:01:00.000Z",
      },
      {
        leafId: "leaf-event-ops",
        subjectKey: "event:ops@example.com:event-1",
        entityKey: "calendar:ops@example.com",
        entityLabel: "Product Ops",
        branchKey: "events",
        branchLabel: "Events",
        title: "Launch sync",
        summary: "Launch sync (2026-05-24T08:00:00.000Z -> 2026-05-24T08:30:00.000Z).",
        path: "integration/accounts/googlecalendar-product-ops-acct-1/leaves/leaf-event-ops.md",
        sourceType: "googlecalendar.event",
        externalObjectId: "event-1",
        externalObjectType: "google_calendar_event",
        observedAt: "2026-05-24T08:00:00.000Z",
      },
      {
        leafId: "leaf-calendar-team",
        subjectKey: "calendar:team@example.com",
        entityKey: "calendar:team@example.com",
        entityLabel: "Team Calendar",
        branchKey: "overview",
        branchLabel: "Overview",
        title: "Team Calendar",
        summary: "Cross-functional planning calendar.",
        path: "integration/accounts/googlecalendar-product-ops-acct-1/leaves/leaf-calendar-team.md",
        sourceType: "googlecalendar.calendar",
        externalObjectId: "team@example.com",
        externalObjectType: "google_calendar",
        observedAt: "2026-05-24T00:02:00.000Z",
      },
    ] as const;

    for (const leaf of leaves) {
      store.upsertIntegrationLeaf({
        ...leaf,
        treeId,
        fingerprint: `fingerprint-${leaf.leafId}`,
        bodySha256: `sha-${leaf.leafId}`,
        tags: ["googlecalendar"],
        sourceEventId: `evt-${leaf.leafId}`,
        sourceMessageId: null,
        admissionConfidence: 0.9,
        supersedesLeafId: null,
        status: "active",
      });
      writeLeafFile(leaf.path, `# ${leaf.title}\n\n${leaf.summary}\n`);
    }

    await rebuildIntegrationTree({
      store,
      treeId,
      embeddingClient: null,
    });

    const rootNode = store.getSemanticMemoryNodeByPath({
      category: "integration",
      path: `semantic/integration/trees/${treeSlug}/content.md`,
    });
    assert.ok(rootNode);
    assert.equal(rootNode.title, "Product Ops Google Calendar connection");

    const rootChildren = childNodes(rootNode.nodeId);
    assert.deepEqual(rootChildren.map((node) => node.nodeKind), ["profile", "calendars"]);

    const calendarsNode = rootChildren[1]!;
    const calendarChildren = childNodes(calendarsNode.nodeId);
    assert.deepEqual(
      calendarChildren.map((node) => ({ kind: node.nodeKind, title: node.title })),
      [
        { kind: "calendar", title: "Product Ops" },
        { kind: "calendar", title: "Team Calendar" },
      ],
    );

    const productOpsNode = calendarChildren[0]!;
    const productOpsChildren = childNodes(productOpsNode.nodeId);
    assert.deepEqual(
      productOpsChildren.map((node) => ({ kind: node.nodeKind, title: node.title })),
      [
        { kind: "overview", title: "Overview" },
        { kind: "events", title: "Events" },
      ],
    );
    assert.deepEqual(
      childNodes(productOpsChildren[0]!.nodeId).map((node) => node.title),
      ["Product Ops"],
    );
    assert.deepEqual(
      childNodes(productOpsChildren[1]!.nodeId).map((node) => node.title),
      ["Launch sync"],
    );

    const calendarResult = await retrieveIntegrationMemory({
      store,
      workspaceId: "workspace-1",
      query: "launch",
      mode: "mixed",
      nodeId: productOpsNode.nodeId,
      maxResults: 5,
    });
    assert.ok(
      (calendarResult.children ?? []).some((hit) => hit.node_kind === "branch" && hit.title === "Events"),
    );

    const calendarNodePath = path.join(
      globalMemoryDirForWorkspaceRoot(workspaceRoot),
      "semantic",
      "integration",
      "trees",
      treeSlug,
      "calendars",
      "calendar-ops-example.com",
      "content.md",
    );
    assert.match(fs.readFileSync(calendarNodePath, "utf8"), /# Product Ops/);
  } finally {
    store.close();
  }
});

test("rebuildIntegrationTree writes the LinkedIn semantic memory hierarchy", async () => {
  const root = makeTempDir("hb-integration-memory-linkedin-semantic-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const treeId = "integration:linkedin:acct-1";
  const treeSlug = "linkedin-ada-example-com-acct-1";

  const writeLeafFile = (relativePath: string, content: string): void => {
    const absolutePath = path.join(globalMemoryDirForWorkspaceRoot(workspaceRoot), relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf8");
  };

  const requireNode = (nodeId: string) => {
    const node = store.getSemanticMemoryNode({
      category: "integration",
      treeId,
      nodeId,
    });
    assert.ok(node, `expected semantic node ${nodeId}`);
    return node;
  };

  const childNodes = (parentNodeId: string) =>
    store.listSemanticMemoryChildren({
      category: "integration",
      treeId,
      parentNodeId,
    }).map((edge) => requireNode(edge.childNodeId));

  try {
    store.createWorkspace({
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.upsertIntegrationConnection({
      connectionId: "linkedin-1",
      providerId: "linkedin",
      ownerUserId: "user-1",
      accountLabel: "Ada Lovelace",
      accountEmail: "ada@example.com",
      authMode: "composio",
      grantedScopes: [],
      status: "active",
    });
    store.upsertIntegrationTree({
      treeId,
      provider: "linkedin",
      ownerUserId: "user-1",
      accountKey: "ada@example.com",
      accountLabel: "Ada Lovelace",
      slug: treeSlug,
      summary: "LinkedIn profile memory.",
      status: "active",
    });

    const leaves = [
      {
        leafId: "leaf-profile",
        subjectKey: "profile",
        entityKey: null,
        entityLabel: null,
        branchKey: "profile",
        branchLabel: "Profile",
        title: "LinkedIn profile for Ada Lovelace",
        summary: "Ada Lovelace LinkedIn profile snapshot.",
        path: "integration/accounts/linkedin-ada-example-com-acct-1/leaves/leaf-profile.md",
        sourceType: "linkedin.profile",
        externalObjectId: "person-1",
        externalObjectType: "linkedin_profile",
        observedAt: "2026-05-24T00:00:00.000Z",
      },
    ] as const;

    for (const leaf of leaves) {
      store.upsertIntegrationLeaf({
        ...leaf,
        treeId,
        fingerprint: `fingerprint-${leaf.leafId}`,
        bodySha256: `sha-${leaf.leafId}`,
        tags: ["linkedin"],
        sourceEventId: `evt-${leaf.leafId}`,
        sourceMessageId: null,
        admissionConfidence: 0.9,
        supersedesLeafId: null,
        status: "active",
      });
      writeLeafFile(leaf.path, `# ${leaf.title}\n\n${leaf.summary}\n`);
    }

    await rebuildIntegrationTree({
      store,
      treeId,
      embeddingClient: null,
    });

    const rootNode = store.getSemanticMemoryNodeByPath({
      category: "integration",
      path: `semantic/integration/trees/${treeSlug}/content.md`,
    });
    assert.ok(rootNode);
    assert.equal(rootNode.title, "Ada Lovelace LinkedIn connection");

    const rootChildren = childNodes(rootNode.nodeId);
    assert.deepEqual(rootChildren.map((node) => node.nodeKind), ["profile"]);

    const profileNode = rootChildren[0]!;
    const profileChildren = childNodes(profileNode.nodeId);
    assert.deepEqual(
      profileChildren.map((node) => ({ kind: node.nodeKind, title: node.title })),
      [{ kind: "leaf", title: "LinkedIn profile for Ada Lovelace" }],
    );

    const profileResult = await retrieveIntegrationMemory({
      store,
      workspaceId: "workspace-1",
      query: "Ada",
      mode: "mixed",
      nodeId: profileNode.nodeId,
      maxResults: 5,
    });
    assert.ok(
      (profileResult.children ?? []).some((hit) => hit.node_kind === "leaf" && hit.title === "LinkedIn profile for Ada Lovelace"),
    );

    const profileNodePath = path.join(
      globalMemoryDirForWorkspaceRoot(workspaceRoot),
      "semantic",
      "integration",
      "trees",
      treeSlug,
      "profile",
      "content.md",
    );
    assert.match(fs.readFileSync(profileNodePath, "utf8"), /# Profile/);
  } finally {
    store.close();
  }
});
