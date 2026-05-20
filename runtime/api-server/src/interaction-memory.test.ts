import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import { rebuildInteractionEntityTree } from "./interaction-memory.js";
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
