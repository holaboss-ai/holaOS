import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";
import { seedWorkspaceRecord } from "./__test-helpers__/seed-workspace.js";

import { FilesystemMemoryService as MemoryService } from "./memory.js";
import { appendDurableMemoryRelatedSections } from "./memory-related-entities.js";
import {
  globalMemoryDirForWorkspaceRoot,
  workspaceMemoryDir,
} from "./workspace-bundle-paths.js";

const tempDirs: string[] = [];
const envNames = ["MEMORY_BACKEND", "MEMORY_ROOT_DIR"] as const;
const envSnapshot = new Map<string, string | undefined>();

for (const name of envNames) {
  envSnapshot.set(name, process.env[name]);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const name of envNames) {
    const value = envSnapshot.get(name);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function listMarkdownFiles(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  const stat = fs.statSync(root);
  if (stat.isFile() && path.extname(root).toLowerCase() === ".md") {
    return [root];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md") {
        files.push(fullPath);
      }
    }
  }
  return files.sort();
}

function snapshotMemoryFiles(params: {
  workspaceRoot: string;
  workspaceId: string;
  workspaceDir?: string;
}): Record<string, string> {
  const workspaceDir = params.workspaceDir ?? path.join(params.workspaceRoot, params.workspaceId);
  const workspaceRootDir = workspaceMemoryDir(workspaceDir);
  const globalRootDir = globalMemoryDirForWorkspaceRoot(params.workspaceRoot);
  const files: Record<string, string> = {};

  for (const filePath of listMarkdownFiles(workspaceRootDir)) {
    const relativePath = path.relative(workspaceRootDir, filePath).split(path.sep).join("/");
    files[`workspace/${params.workspaceId}/${relativePath}`] = fs.readFileSync(filePath, "utf8");
  }

  const rootIndexPath = path.join(globalRootDir, "MEMORY.md");
  if (fs.existsSync(rootIndexPath) && fs.statSync(rootIndexPath).isFile()) {
    files["MEMORY.md"] = fs.readFileSync(rootIndexPath, "utf8");
  }
  if (fs.existsSync(globalRootDir) && fs.statSync(globalRootDir).isDirectory()) {
    for (const entry of fs.readdirSync(globalRootDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name === "workspace") {
        continue;
      }
      for (const filePath of listMarkdownFiles(path.join(globalRootDir, entry.name))) {
        const relativePath = path.relative(globalRootDir, filePath).split(path.sep).join("/");
        files[relativePath] = fs.readFileSync(filePath, "utf8");
      }
    }
  }

  return files;
}

test("filesystem memory service preserves search/get/upsert/status/sync payload shape", async () => {
  const root = makeTempDir("hb-memory-");
  const workspaceRoot = path.join(root, "workspace");
  const legacyMemoryRoot = globalMemoryDirForWorkspaceRoot(workspaceRoot);
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  fs.mkdirSync(path.join(legacyMemoryRoot, "workspace", "workspace-1"), { recursive: true });
  fs.mkdirSync(path.join(legacyMemoryRoot, "preference"), { recursive: true });
  fs.writeFileSync(
    path.join(legacyMemoryRoot, "workspace", "workspace-1", "notes.md"),
    "# Notes\ncoffee preference\nsecond line\n",
    "utf8"
  );
  fs.writeFileSync(path.join(legacyMemoryRoot, "preference", "profile.md"), "coffee and tea\n", "utf8");

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
    leafId: "leaf-seed",
    entityId: "interaction:uncategorized",
    subjectKey: "fact:seed",
    path: "workspace/workspace-1/interaction/entities/uncategorized/leaves/leaf-seed.md",
    title: "Seed memory",
    summary: "Seed summary.",
    fingerprint: "seed-fingerprint",
    bodySha256: "seed-sha",
    tags: ["seed"],
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

  const service = new MemoryService({ workspaceRoot, store });

  const searched = await service.search({
    workspace_id: "workspace-1",
    query: "coffee preference",
    max_results: 5,
    min_score: 0.1
  });
  const fetched = await service.get({
    workspace_id: "workspace-1",
    path: "workspace/workspace-1/notes.md"
  });
  const missing = await service.get({
    workspace_id: "workspace-1",
    path: "workspace/workspace-1/missing.md"
  });
  const upserted = await service.upsert({
    workspace_id: "workspace-1",
    path: "workspace/workspace-1/new.md",
    content: "hello",
    append: false
  });
  const status = await service.status({ workspace_id: "workspace-1" });
  const synced = await service.sync({ workspace_id: "workspace-1", reason: "manual", force: true });
  const rootIndex = await service.upsert({
    workspace_id: "workspace-1",
    path: "MEMORY.md",
    content: "# Memory Index\n",
    append: false
  });
  const fetchedRootIndex = await service.get({
    workspace_id: "workspace-1",
    path: "MEMORY.md"
  });
  const capturedFiles = snapshotMemoryFiles({ workspaceRoot, workspaceId: "workspace-1" });

  assert.equal(Array.isArray(searched.results), true);
  assert.equal((searched.results as Array<Record<string, unknown>>).length >= 1, true);
  assert.equal((searched.status as Record<string, unknown>).provider, "workspace_graph");
  assert.deepEqual(fetched, {
    path: "workspace/workspace-1/notes.md",
    text: "# Notes\ncoffee preference\nsecond line\n"
  });
  assert.deepEqual(missing, {
    path: "workspace/workspace-1/missing.md",
    text: ""
  });
  assert.deepEqual(upserted, {
    path: "workspace/workspace-1/new.md",
    text: "hello"
  });
  assert.deepEqual(rootIndex, {
    path: "MEMORY.md",
    text: "# Memory Index\n"
  });
  assert.deepEqual(fetchedRootIndex, {
    path: "MEMORY.md",
    text: "# Memory Index\n"
  });
  assert.equal(capturedFiles["workspace/workspace-1/notes.md"], "# Notes\ncoffee preference\nsecond line\n");
  assert.equal(capturedFiles["workspace/workspace-1/new.md"], "hello");
  assert.equal(capturedFiles["MEMORY.md"], "# Memory Index\n");
  assert.equal(status.backend, "builtin");
  assert.equal(status.provider, "workspace_graph");
  const custom = status.custom as Record<string, unknown>;
  assert.equal(custom.workspace_graph_roots, 1);
  assert.equal(custom.workspace_graph_leaves, 1);
  assert.equal(custom.workspace_graph_semantic_nodes, 2);
  assert.equal(custom.workspace_graph_semantic_internal_nodes, 1);
  assert.equal(custom.workspace_graph_semantic_edges, 1);
  assert.equal(Number(custom.workspace_graph_semantic_relations) > 0, true);
  assert.equal(typeof custom.workspace_memory_root_dir, "string");
  assert.equal(typeof custom.global_memory_root_dir, "string");
  assert.equal(custom.workspace_scope, "workspace/workspace-1");
  assert.equal(custom.migrated_workspace_memory, false);
  assert.equal(
    fs.existsSync(path.join(workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")), "notes.md")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(legacyMemoryRoot, "workspace", "workspace-1", "notes.md")),
    false,
  );
  assert.deepEqual(synced, {
    success: true,
    rebuilt: {
      workspace: {
        roots: 1,
        summaries: 0,
      },
    },
    status: {
      ...status,
      files: 6,
      chunks: 6,
      custom: {
        ...custom,
        workspace_graph_semantic_nodes: 2,
        workspace_graph_semantic_internal_nodes: 1,
        workspace_graph_semantic_edges: 1,
      },
    },
  });

  store.close();
});

test("filesystem memory service resolves workspace-local bundles from the registered custom workspace path", async () => {
  const root = makeTempDir("hb-memory-custom-");
  const workspaceRoot = path.join(root, "workspace");
  const customWorkspaceDir = path.join(root, "custom-workspace");
  const service = new MemoryService({
    workspaceRoot,
    resolveWorkspaceDir(workspaceId) {
      assert.equal(workspaceId, "workspace-custom");
      return customWorkspaceDir;
    },
  });

  await service.upsert({
    workspace_id: "workspace-custom",
    path: "workspace/workspace-custom/notes.md",
    content: "custom workspace memory\n",
    append: false,
  });

  const fetched = await service.get({
    workspace_id: "workspace-custom",
    path: "workspace/workspace-custom/notes.md",
  });
  const capturedFiles = snapshotMemoryFiles({
    workspaceRoot,
    workspaceId: "workspace-custom",
    workspaceDir: customWorkspaceDir,
  });

  assert.deepEqual(fetched, {
    path: "workspace/workspace-custom/notes.md",
    text: "custom workspace memory\n",
  });
  assert.equal(
    fs.existsSync(path.join(workspaceMemoryDir(customWorkspaceDir), "notes.md")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(workspaceRoot, "workspace-custom", ".holaboss", "memory", "notes.md")),
    false,
  );
  assert.equal(capturedFiles["workspace/workspace-custom/notes.md"], "custom workspace memory\n");
});

test("filesystem memory service counts and syncs mixed interaction and integration memory through one workspace graph", async () => {
  const root = makeTempDir("hb-memory-mixed-workspace-graph-");
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

  const service = new MemoryService({ workspaceRoot, store });

  const before = await service.status({ workspace_id: "workspace-1" });
  const beforeCustom = before.custom as Record<string, unknown>;
  assert.equal(before.provider, "workspace_graph");
  assert.equal(beforeCustom.workspace_graph_roots, 2);
  assert.equal(beforeCustom.workspace_graph_leaves, 2);
  assert.equal(Number(beforeCustom.workspace_graph_semantic_nodes) >= 2, true);
  assert.equal(Number(beforeCustom.workspace_graph_semantic_internal_nodes) >= 1, true);

  const synced = await service.sync({ workspace_id: "workspace-1", reason: "manual", force: true });
  const rebuilt = synced.rebuilt as Record<string, unknown>;
  const rebuiltWorkspace = rebuilt.workspace as Record<string, unknown>;
  const afterStatus = synced.status as Record<string, unknown>;
  const afterCustom = afterStatus.custom as Record<string, unknown>;

  assert.equal(rebuiltWorkspace.roots, 2);
  assert.equal(typeof rebuiltWorkspace.summaries, "number");
  assert.equal(afterStatus.provider, "workspace_graph");
  assert.equal(afterCustom.workspace_graph_roots, 2);
  assert.equal(afterCustom.workspace_graph_leaves, 2);
  assert.equal(Number(afterCustom.workspace_graph_semantic_nodes) >= Number(beforeCustom.workspace_graph_semantic_nodes), true);
  assert.equal(Number(afterCustom.workspace_graph_semantic_edges) >= Number(beforeCustom.workspace_graph_semantic_edges ?? 0), true);

  store.close();
});

test("filesystem memory service status repairs legacy related keys before summarizing the workspace graph", async () => {
  const root = makeTempDir("hb-memory-status-repair-");
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
      workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
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

    const service = new MemoryService({ workspaceRoot, store });

    const status = await service.status({ workspace_id: "workspace-1" });
    const custom = status.custom as Record<string, unknown>;
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
        workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
        repairedLeafRelativePath,
      ),
      "utf8",
    );

    assert.match(
      repairedBody,
      /organization:entity:interaction:customer:anyip/,
    );
    assert.equal(status.provider, "workspace_graph");
    assert.equal(Number(custom.workspace_graph_semantic_nodes) > 0, true);
    assert.equal(Number(custom.workspace_graph_semantic_relations) > 0, true);
  } finally {
    store.close();
  }
});

test("filesystem memory service reports generic fallback metadata for unsupported backends", async () => {
  const root = makeTempDir("hb-memory-");
  process.env.MEMORY_BACKEND = "sqlite";
  const service = new MemoryService({ workspaceRoot: path.join(root, "workspace") });

  const status = await service.status({ workspace_id: "workspace-1" });

  assert.equal(status.backend, "builtin");
  assert.equal(status.requested_provider, "sqlite");
  assert.deepEqual(status.fallback, {
    from: "sqlite",
    reason: "ts runtime only supports the builtin filesystem memory backend"
  });
});

test("filesystem memory service enforces strict memory path scopes", async () => {
  const root = makeTempDir("hb-memory-");
  const service = new MemoryService({ workspaceRoot: path.join(root, "workspace") });

  await service.upsert({
    workspace_id: "workspace-1",
    path: "MEMORY.md",
    content: "# Root Memory\n",
    append: false
  });
  await service.upsert({
    workspace_id: "workspace-1",
    path: "workspace/workspace-1/runtime/session-state/main.md",
    content: "# Runtime Session Snapshot\n",
    append: false
  });
  await service.upsert({
    workspace_id: "workspace-1",
    path: "preference/profile.md",
    content: "# Preference\n",
    append: false
  });
  await service.upsert({
    workspace_id: "workspace-1",
    path: "identity/user-name.md",
    content: "# Identity\n",
    append: false
  });

  await assert.rejects(
    service.upsert({
      workspace_id: "workspace-1",
      path: "workspace/workspace-2/runtime/session-state/main.md",
      content: "# Other workspace\n",
      append: false
    }),
    /allowed memory paths/
  );
  await assert.rejects(
    service.upsert({
      workspace_id: "workspace-1",
      path: "knowledge/facts/example.md",
      content: "# Invalid scope\n",
      append: false
    }),
    /allowed memory paths/
  );
  await assert.rejects(
    service.get({
      workspace_id: "workspace-1",
      path: "knowledge/facts/example.md"
    }),
    /allowed memory paths/
  );
});
