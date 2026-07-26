import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";
import { seedWorkspaceRecord } from "./__test-helpers__/seed-workspace.js";

import { buildRuntimeApiServer } from "./app.js";

function makeStore(): { store: RuntimeStateStore; workspaceRoot: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-capability-routes-"));
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
  fs.mkdirSync(path.join(workspaceRoot, "workspace-1"), { recursive: true });
  return {
    store,
    workspaceRoot,
    cleanup: () => {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function buildServer(store: RuntimeStateStore) {
  return buildRuntimeApiServer({
    store,
    queueWorker: null,
    durableMemoryWorker: null,
    cronWorker: null,
    recallEmbeddingBackfillWorker: null,
    enableAppHealthMonitor: false,
    startAppsOnReady: false,
  });
}

test("capability routes: catalog → install → list → toggle → uninstall", async () => {
  const { store, cleanup } = makeStore();
  const app = buildServer(store);
  try {
    const catalog = await app.inject({ method: "GET", url: "/api/v1/capabilities" });
    assert.equal(catalog.statusCode, 200);
    const catalogBody = catalog.json();
    assert.ok(Array.isArray(catalogBody.capabilities));
    assert.ok(catalogBody.capabilities.length >= 2);
    assert.ok(catalogBody.capabilities.every((capability: Record<string, unknown>) => !("sourceDir" in capability)));

    const install = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/install",
      payload: { workspaceId: "workspace-1", capabilityId: "competitor-watch" },
    });
    assert.equal(install.statusCode, 200);
    const installBody = install.json();
    assert.equal(installBody.record.capabilityId, "competitor-watch");

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/workspaces/workspace-1/capabilities",
    });
    assert.equal(list.statusCode, 200);
    const listBody = list.json();
    assert.equal(listBody.capabilities.length, 1);
    assert.equal(listBody.capabilities[0].capabilityId, "competitor-watch");

    const toggle = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/toggle",
      payload: { workspaceId: "workspace-1", capabilityId: "competitor-watch", enabled: false },
    });
    assert.equal(toggle.statusCode, 200);
    assert.equal(toggle.json().status, "disabled");

    const uninstall = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/uninstall",
      payload: { workspaceId: "workspace-1", capabilityId: "competitor-watch" },
    });
    assert.equal(uninstall.statusCode, 200);
    assert.deepEqual(uninstall.json(), { removed: true });

    const listAfter = await app.inject({
      method: "GET",
      url: "/api/v1/workspaces/workspace-1/capabilities",
    });
    assert.equal(listAfter.statusCode, 200);
    assert.equal(listAfter.json().capabilities.length, 0);

    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/install",
      payload: { workspaceId: "workspace-1", capabilityId: "does-not-exist" },
    });
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(missing.json(), { error: "capability not found" });
  } finally {
    await app.close();
    cleanup();
  }
});
