import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore, type MemoryEntryRecord } from "@holaboss/runtime-state-store";

import { recalledMemoryContextFromManifest } from "./memory-recall-manifest.js";
import {
  globalMemoryDirForWorkspaceRoot,
  workspaceMemoryDir,
} from "./workspace-bundle-paths.js";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function writeMemoryFile(workspaceRoot: string, relPath: string, content: string): void {
  const normalized = relPath.replaceAll("\\", "/").replace(/^\/+/, "");
  const match = /^workspace\/([^/]+)\/(.+)$/.exec(normalized);
  const absPath = match
    ? path.join(workspaceMemoryDir(path.join(workspaceRoot, match[1])), match[2])
    : path.join(globalMemoryDirForWorkspaceRoot(workspaceRoot), ...normalized.split("/"));
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, "utf8");
}

function makeMemoryEntry(
  overrides: Partial<MemoryEntryRecord> &
    Pick<MemoryEntryRecord, "memoryId" | "scope" | "memoryType" | "path" | "title" | "summary">
): MemoryEntryRecord {
  return {
    memoryId: overrides.memoryId,
    workspaceId: overrides.workspaceId === undefined ? "workspace-1" : overrides.workspaceId,
    sessionId: overrides.sessionId ?? "session-1",
    scope: overrides.scope,
    memoryType: overrides.memoryType,
    subjectKey: overrides.subjectKey ?? overrides.memoryId,
    path: overrides.path,
    title: overrides.title,
    summary: overrides.summary,
    tags: overrides.tags ?? [],
    verificationPolicy: overrides.verificationPolicy ?? "check_before_use",
    stalenessPolicy: overrides.stalenessPolicy ?? "workspace_sensitive",
    staleAfterSeconds: overrides.staleAfterSeconds ?? 14 * 24 * 60 * 60,
    sourceTurnInputId: overrides.sourceTurnInputId ?? null,
    sourceMessageId: overrides.sourceMessageId ?? null,
    sourceType: overrides.sourceType ?? "turn_result",
    observedAt: overrides.observedAt ?? overrides.updatedAt ?? "2026-04-01T00:00:00.000Z",
    lastVerifiedAt: overrides.lastVerifiedAt ?? overrides.updatedAt ?? "2026-04-01T00:00:00.000Z",
    confidence: overrides.confidence ?? 0.9,
    fingerprint: overrides.fingerprint ?? "f".repeat(64),
    status: overrides.status ?? "active",
    supersededAt: overrides.supersededAt ?? null,
    createdAt: overrides.createdAt ?? "2026-04-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-01T00:00:00.000Z",
  };
}

function installMockResponses(responses: Array<Record<string, unknown>>): void {
  let callIndex = 0;
  globalThis.fetch = (async () => {
    const payload = responses[Math.min(callIndex, responses.length - 1)] ?? {};
    callIndex += 1;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify(payload),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  }) as typeof fetch;
}

test("recalledMemoryContextFromManifest uses two-stage LLM recall with one expansion pass", async () => {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hb-memory-recall-manifest-"));
  const workspaceRoot = path.join(sandboxRoot, "workspace");

  writeMemoryFile(
    workspaceRoot,
    "MEMORY.md",
    [
      "# Memory Index",
      "",
      "- [Workspace workspace-1](workspace/workspace-1/MEMORY.md) - 2 durable workspace memories.",
      "- [Preferences](preference/MEMORY.md) - 1 durable preference memories.",
      "- [Identity](identity/MEMORY.md) - 0 durable identity memories.",
      "",
    ].join("\n")
  );
  writeMemoryFile(
    workspaceRoot,
    "workspace/workspace-1/MEMORY.md",
    [
      "# Workspace Durable Memory Index",
      "",
      "- [Deploy permission blocker](knowledge/blockers/deploy.md) [blocker] [verify: check_before_use] - Deploy calls may be denied by workspace policy.",
      "- [Release procedure](knowledge/procedures/release-procedure.md) [procedure] [verify: check_before_use] - Release procedure for this workspace.",
      "",
    ].join("\n")
  );
  writeMemoryFile(
    workspaceRoot,
    "preference/MEMORY.md",
    [
      "# Preference Memory Index",
      "",
      "- [User response style](response-style.md) [preference] [verify: none] - User prefers concise responses.",
      "",
    ].join("\n")
  );
  writeMemoryFile(workspaceRoot, "identity/MEMORY.md", "# Identity Memory Index\n\nNo durable identity memories indexed yet.\n");
  writeMemoryFile(
    workspaceRoot,
    "workspace/workspace-1/knowledge/blockers/deploy.md",
    "# Deploy permission blocker\n\nDeploy calls may be denied by workspace policy. Confirm before running deploy.\n"
  );
  writeMemoryFile(
    workspaceRoot,
    "workspace/workspace-1/knowledge/procedures/release-procedure.md",
    "# Release procedure\n\n1. Run npm test. 2. Run npm build. 3. Publish.\n"
  );
  writeMemoryFile(
    workspaceRoot,
    "preference/response-style.md",
    "# User response style\n\nUser prefers concise responses.\n"
  );

  installMockResponses([
    {
      should_recall: true,
      rewritten_query: "deploy blockers and relevant user preference",
      scopes: ["workspace", "preference"],
      memory_types: ["blocker", "preference"],
      reason: "Need deployment blocker context and response preference.",
      primary_paths: ["workspace/workspace-1/knowledge/blockers/deploy.md"],
      reserve_paths: ["preference/response-style.md"],
      reason_by_path: {
        "workspace/workspace-1/knowledge/blockers/deploy.md": "Direct blocker for deploy request.",
        "preference/response-style.md": "Useful preference once the blocker is known.",
      },
    },
    {
      status: "expand_once",
      final_paths: ["workspace/workspace-1/knowledge/blockers/deploy.md"],
      expansion_paths: ["preference/response-style.md"],
      reason_by_path: {
        "workspace/workspace-1/knowledge/blockers/deploy.md": "Opened blocker is necessary but not sufficient.",
        "preference/response-style.md": "Open the preference before finalizing the answer.",
      },
    },
    {
      status: "sufficient",
      final_paths: [
        "workspace/workspace-1/knowledge/blockers/deploy.md",
        "preference/response-style.md",
      ],
      expansion_paths: [],
      reason_by_path: {
        "workspace/workspace-1/knowledge/blockers/deploy.md": "Contains the deploy constraint.",
        "preference/response-style.md": "Contains the user's preferred response style.",
      },
    },
  ]);

  const result = await recalledMemoryContextFromManifest({
    query: "Please deploy after fixing permissions.",
    workspaceRoot,
    workspaceId: "workspace-1",
    entries: [
      makeMemoryEntry({
        memoryId: "workspace-blocker:deploy",
        scope: "workspace",
        memoryType: "blocker",
        path: "workspace/workspace-1/knowledge/blockers/deploy.md",
        title: "Deploy permission blocker",
        summary: "Deploy calls may be denied by workspace policy.",
        tags: ["deploy", "permission"],
        verificationPolicy: "check_before_use",
        updatedAt: "2026-04-10T00:00:00.000Z",
      }),
      makeMemoryEntry({
        memoryId: "user-preference:response-style",
        workspaceId: null,
        scope: "user",
        memoryType: "preference",
        path: "preference/response-style.md",
        title: "User response style",
        summary: "User prefers concise responses.",
        tags: ["concise"],
        verificationPolicy: "none",
        stalenessPolicy: "stable",
        staleAfterSeconds: null,
        updatedAt: "2026-04-11T00:00:00.000Z",
      }),
      makeMemoryEntry({
        memoryId: "workspace-procedure:release",
        scope: "workspace",
        memoryType: "procedure",
        path: "workspace/workspace-1/knowledge/procedures/release-procedure.md",
        title: "Release procedure",
        summary: "Release procedure for this workspace.",
        tags: ["release"],
        updatedAt: "2026-04-09T00:00:00.000Z",
      }),
    ],
    maxEntries: 5,
    nowIso: "2026-04-15T00:00:00.000Z",
    modelClient: {
      baseUrl: "http://127.0.0.1:4999/openai/v1",
      apiKey: "test-token",
      modelId: "openai/gpt-5.4-mini",
    },
  });

  assert.ok(result);
  assert.deepEqual(result.entries?.map((entry) => entry.path), [
    "workspace/workspace-1/knowledge/blockers/deploy.md",
    "preference/response-style.md",
  ]);
  assert.equal(result.entries?.[0]?.memory_type, "blocker");
  assert.equal(result.entries?.[1]?.memory_type, "preference");
  assert.match(String(result.entries?.[0]?.excerpt ?? ""), /Confirm before running deploy/i);
  assert.match(String(result.selection_trace?.[0]?.reasons?.join(" ") ?? ""), /plan:/);
  assert.match(String(result.selection_trace?.[0]?.reasons?.join(" ") ?? ""), /candidate:/);
  assert.match(String(result.selection_trace?.[0]?.reasons?.join(" ") ?? ""), /final:/);
  assert.equal(result.selection_trace?.length, 2);
});

test("recalledMemoryContextFromManifest uses vector candidates plus one finalization call when embeddings are complete", async () => {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hb-memory-recall-manifest-vector-"));
  const workspaceRoot = path.join(sandboxRoot, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(sandboxRoot, "runtime.db"),
    workspaceRoot,
  });
  assert.equal(store.supportsVectorIndex(), true);

  writeMemoryFile(
    workspaceRoot,
    "workspace/workspace-1/knowledge/blockers/deploy.md",
    "# Deploy permission blocker\n\nDeploy calls may be denied by workspace policy. Confirm before running deploy.\n"
  );
  writeMemoryFile(
    workspaceRoot,
    "preference/response-style.md",
    "# User response style\n\nUser prefers concise responses.\n"
  );

  const entries = [
    makeMemoryEntry({
      memoryId: "workspace-blocker:deploy",
      scope: "workspace",
      memoryType: "blocker",
      path: "workspace/workspace-1/knowledge/blockers/deploy.md",
      title: "Deploy permission blocker",
      summary: "Deploy calls may be denied by workspace policy.",
      tags: ["deploy", "permission"],
      verificationPolicy: "check_before_use",
      updatedAt: "2026-04-10T00:00:00.000Z",
    }),
    makeMemoryEntry({
      memoryId: "user-preference:response-style",
      workspaceId: null,
      scope: "user",
      memoryType: "preference",
      path: "preference/response-style.md",
      title: "User response style",
      summary: "User prefers concise responses.",
      tags: ["concise"],
      verificationPolicy: "none",
      stalenessPolicy: "stable",
      staleAfterSeconds: null,
      updatedAt: "2026-04-11T00:00:00.000Z",
    }),
  ];

  const workspaceVector = new Float32Array(1536).fill(0);
  workspaceVector[0] = 1;
  const preferenceVector = new Float32Array(1536).fill(0);
  preferenceVector[0] = 0.95;
  preferenceVector[1] = 0.05;

  const workspaceIndex = store.upsertMemoryEmbeddingIndex({
    memoryId: entries[0].memoryId,
    path: entries[0].path,
    workspaceId: entries[0].workspaceId,
    scopeBucket: "workspace",
    memoryType: entries[0].memoryType,
    contentFingerprint: "a".repeat(64),
    embeddingModel: "text-embedding-3-small",
    embeddingDim: 1536,
  });
  store.replaceMemoryRecallVector({
    vecRowid: workspaceIndex.vecRowid,
    embedding: workspaceVector,
    scopeBucket: "workspace",
    workspaceId: entries[0].workspaceId,
    memoryType: entries[0].memoryType,
  });
  const preferenceIndex = store.upsertMemoryEmbeddingIndex({
    memoryId: entries[1].memoryId,
    path: entries[1].path,
    workspaceId: entries[1].workspaceId,
    scopeBucket: "preference",
    memoryType: entries[1].memoryType,
    contentFingerprint: "b".repeat(64),
    embeddingModel: "text-embedding-3-small",
    embeddingDim: 1536,
  });
  store.replaceMemoryRecallVector({
    vecRowid: preferenceIndex.vecRowid,
    embedding: preferenceVector,
    scopeBucket: "preference",
    workspaceId: entries[1].workspaceId,
    memoryType: entries[1].memoryType,
  });

  const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    requests.push({ url, body });
    if (url.endsWith("/embeddings")) {
      return new Response(
        JSON.stringify({
          data: [{ embedding: [...workspaceVector] }],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                status: "sufficient",
                final_paths: [
                  "workspace/workspace-1/knowledge/blockers/deploy.md",
                  "preference/response-style.md",
                ],
                expansion_paths: [],
                reason_by_path: {
                  "workspace/workspace-1/knowledge/blockers/deploy.md": "Contains the deploy blocker.",
                  "preference/response-style.md": "Contains the user's preferred response style.",
                },
              }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  }) as typeof fetch;

  const result = await recalledMemoryContextFromManifest({
    query: "Please deploy after fixing permissions.",
    workspaceRoot,
    workspaceId: "workspace-1",
    entries,
    store,
    maxEntries: 5,
    nowIso: "2026-04-15T00:00:00.000Z",
    modelClient: {
      baseUrl: "http://127.0.0.1:4999/openai/v1",
      apiKey: "test-token",
      modelId: "openai/gpt-5.4-mini",
    },
    embeddingClient: {
      baseUrl: "http://127.0.0.1:4999/openai/v1",
      apiKey: "test-token",
      modelId: "text-embedding-3-small",
      apiStyle: "openai_compatible",
    },
  });

  assert.ok(result);
  assert.deepEqual(result.entries?.map((entry) => entry.path), [
    "workspace/workspace-1/knowledge/blockers/deploy.md",
    "preference/response-style.md",
  ]);
  assert.equal(requests.filter((request) => request.url.endsWith("/embeddings")).length, 1);
  assert.equal(requests.filter((request) => request.url.endsWith("/chat/completions")).length, 1);
  assert.match(String(result.selection_trace?.[0]?.reasons?.join(" ") ?? ""), /plan:vector_candidate_retrieval/);

  store.close();
});

test("recalledMemoryContextFromManifest returns null without a model client and does not fall back", async () => {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hb-memory-recall-manifest-no-model-"));
  const workspaceRoot = path.join(sandboxRoot, "workspace");

  writeMemoryFile(
    workspaceRoot,
    "workspace/workspace-1/MEMORY.md",
    "# Workspace Durable Memory Index\n\n- [Deploy permission blocker](knowledge/blockers/deploy.md) - Deploy calls may be denied by workspace policy.\n"
  );
  writeMemoryFile(
    workspaceRoot,
    "workspace/workspace-1/knowledge/blockers/deploy.md",
    "# Deploy permission blocker\n\nDeploy calls may be denied by workspace policy.\n"
  );

  const result = await recalledMemoryContextFromManifest({
    query: "Please deploy after fixing permissions.",
    workspaceRoot,
    workspaceId: "workspace-1",
    entries: [
      makeMemoryEntry({
        memoryId: "workspace-blocker:deploy",
        scope: "workspace",
        memoryType: "blocker",
        path: "workspace/workspace-1/knowledge/blockers/deploy.md",
        title: "Deploy permission blocker",
        summary: "Deploy calls may be denied by workspace policy.",
      }),
    ],
    maxEntries: 5,
  });

  assert.equal(result, null);
});
