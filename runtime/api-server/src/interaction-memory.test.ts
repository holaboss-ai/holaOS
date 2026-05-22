import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import { persistInteractionCandidate, rebuildInteractionEntityTree } from "./interaction-memory.js";
import { workspaceMemoryDir } from "./workspace-bundle-paths.js";

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
  store.createWorkspace({
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

    const summaries = store.listInteractionSummaryNodes({
      workspaceId: "workspace-1",
      entityId: "interaction:workflow:deploy-procedure",
      status: "active",
      limit: 10_000,
      offset: 0,
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.model, "gpt-4.1-mini");
    assert.equal(summaries.length, 1);
    assert.equal(
      summaries[0]?.summary,
      "Deployment memory emphasizes validating the release flow before rollout and keeping the procedure consistent.",
    );
    const summaryPath = path.join(
      workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
      "interaction",
      "entities",
      "workflow-deploy-procedure",
      "summaries",
      "L1",
      `${summaries[0]?.nodeId}.md`,
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

test("persistInteractionCandidate no-ops when semantic dedupe classifies a candidate as the same memory", async () => {
  const root = makeTempDir("hb-interaction-memory-dedupe-same-");
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
        assert.equal(requests.length, 2);
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

test("persistInteractionCandidate supersedes an older active leaf when semantic dedupe identifies a richer replacement", async () => {
  const root = makeTempDir("hb-interaction-memory-dedupe-supersede-");
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
  store.createWorkspace({
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
  store.createWorkspace({
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
