import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import { seedWorkspaceRecord } from "./__test-helpers__/seed-workspace.js";
import { RuntimeAgentToolsService, RuntimeAgentToolsServiceError } from "./runtime-agent-tools.js";

const WORKSPACE_ID = "workspace-1";

async function makeService() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-capability-catalog-"));
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({ dbPath: path.join(root, "runtime.db"), workspaceRoot });
  seedWorkspaceRecord(store, { workspaceId: WORKSPACE_ID, name: "Workspace 1", harness: "pi", status: "active" });
  const service = new RuntimeAgentToolsService(store, { workspaceRoot });
  return {
    store,
    service,
    workspaceDir: store.workspaceDir(WORKSPACE_ID),
    cleanup: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("capability_install falls back to the built-in catalog and copies skill helper files", async () => {
  const { store, service, workspaceDir, cleanup } = await makeService();
  try {
    await service.installCapability({ workspaceId: WORKSPACE_ID, capabilityId: "local-model-review" });
    const skillDir = path.join(workspaceDir, "skills", "run-model-eval");
    assert.ok(fs.existsSync(path.join(skillDir, "SKILL.md")));
    assert.ok(fs.existsSync(path.join(skillDir, "holaeval.py")));
    assert.ok(fs.existsSync(path.join(skillDir, "packs", "general-v1.json")));
    assert.ok(fs.existsSync(path.join(workspaceDir, "skills", "draft-review-posts", "SKILL.md")));
    const row = store.getWorkspaceCapability({ workspaceId: WORKSPACE_ID, capabilityId: "local-model-review" });
    assert.deepEqual(row?.installedSkillIds, ["run-model-eval", "write-conclusion-pack", "draft-review-posts"]);
  } finally {
    await cleanup();
  }
});

test("capability_install prefers a workspace-authored capability with the same id", async () => {
  const { store, service, workspaceDir, cleanup } = await makeService();
  try {
    const capDir = path.join(workspaceDir, "capabilities", "local-model-review");
    fs.mkdirSync(capDir, { recursive: true });
    fs.writeFileSync(
      path.join(capDir, "capability.yaml"),
      ["id: local-model-review", "name: Mine", "description: Authored", "skills:", "  - ref: my-eval"].join("\n"),
      "utf8",
    );
    await service.installCapability({ workspaceId: WORKSPACE_ID, capabilityId: "local-model-review" });
    const row = store.getWorkspaceCapability({ workspaceId: WORKSPACE_ID, capabilityId: "local-model-review" });
    assert.deepEqual(row?.installedSkillIds, ["my-eval"]);
  } finally {
    await cleanup();
  }
});

test("capability_install rejects an unknown id with 404", async () => {
  const { service, cleanup } = await makeService();
  try {
    await assert.rejects(
      service.installCapability({ workspaceId: WORKSPACE_ID, capabilityId: "no-such-capability" }),
      (error: unknown) => error instanceof RuntimeAgentToolsServiceError && error.statusCode === 404,
    );
  } finally {
    await cleanup();
  }
});
