import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import { rebuildIntegrationTree, retrieveIntegrationMemory } from "./integration-memory.js";
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

test("rebuildIntegrationTree uses LLM-authored summaries when a summary model client is available", async () => {
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
      subjectKey: `release-item:${index}`,
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
                  summary: "The GitHub account memory highlights the current release artifacts and ownership details needed for follow-up.",
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
    await rebuildIntegrationTree({
      store,
      workspaceId: "workspace-1",
      treeId: "integration:github:acct-1",
      summaryModelClient: {
        baseUrl: `http://127.0.0.1:${address.port}/openai/v1`,
        apiKey: "test-key",
        modelId: "openai/gpt-4.1-mini",
      },
      embeddingClient: null,
    });

    const summaries = store.listIntegrationSummaryNodes({
      treeId: "integration:github:acct-1",
      status: "active",
      limit: 10_000,
      offset: 0,
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.model, "gpt-4.1-mini");
    assert.equal(summaries.length, 1);
    assert.equal(
      summaries[0]?.summary,
      "The GitHub account memory highlights the current release artifacts and ownership details needed for follow-up.",
    );
    const summaryPath = path.join(
      globalMemoryDirForWorkspaceRoot(workspaceRoot),
      "integration",
      "trees",
      "github-release-acct-1",
      "branches",
      `L${summaries[0]?.level ?? 1}-${summaries[0]?.nodeId.slice(-6)}`,
      "content.md",
    );
    assert.match(
      fs.readFileSync(summaryPath, "utf8"),
      /The GitHub account memory highlights the current release artifacts and ownership details needed for follow-up\./,
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

    const visible = await retrieveIntegrationMemory({
      store,
      workspaceId: "workspace-1",
      query: "Who approves invoices above $5000?",
      mode: "mixed",
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
      workspaceId: "workspace-1",
      treeId: "integration:gmail:acct-1",
      summaryModelClient: null,
      embeddingClient: null,
    });

    const result = await retrieveIntegrationMemory({
      store,
      workspaceId: "workspace-1",
      query: "alice@example.com",
      mode: "mixed",
      maxResults: 10,
    });
    assert.ok(
      result.hits.some((hit) => hit.node_kind === "entity" && hit.title === "alice@example.com"),
    );

    const children = await retrieveIntegrationMemory({
      store,
      workspaceId: "workspace-1",
      query: "launch",
      mode: "mixed",
      nodeId: "entity:integration:integration:gmail:acct-1:contact:alice@example.com",
      maxResults: 10,
    });
    assert.ok(
      (children.children ?? []).some((hit) => hit.node_kind === "entity" && hit.title === "Launch thread"),
    );
  } finally {
    store.close();
  }
});
