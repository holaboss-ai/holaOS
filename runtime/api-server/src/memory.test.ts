import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { FilesystemMemoryService as MemoryService } from "./memory.js";
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

test("filesystem memory service preserves search/get/upsert/status/sync payload shape", async () => {
  const root = makeTempDir("hb-memory-");
  const workspaceRoot = path.join(root, "workspace");
  const legacyMemoryRoot = globalMemoryDirForWorkspaceRoot(workspaceRoot);
  fs.mkdirSync(path.join(legacyMemoryRoot, "workspace", "workspace-1"), { recursive: true });
  fs.mkdirSync(path.join(legacyMemoryRoot, "preference"), { recursive: true });
  fs.writeFileSync(
    path.join(legacyMemoryRoot, "workspace", "workspace-1", "notes.md"),
    "# Notes\ncoffee preference\nsecond line\n",
    "utf8"
  );
  fs.writeFileSync(path.join(legacyMemoryRoot, "preference", "profile.md"), "coffee and tea\n", "utf8");

  const service = new MemoryService({ workspaceRoot });

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
  const captured = await service.capture({ workspace_id: "workspace-1" });
  const capturedFiles = captured.files as Record<string, string>;

  assert.equal(Array.isArray(searched.results), true);
  assert.equal((searched.results as Array<Record<string, unknown>>).length >= 1, true);
  assert.equal((searched.status as Record<string, unknown>).provider, "filesystem");
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
    status
  });
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
  const captured = await service.capture({ workspace_id: "workspace-custom" });
  const capturedFiles = captured.files as Record<string, string>;

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
