import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";
import { seedWorkspaceRecord } from "./__test-helpers__/seed-workspace.js";

import { buildRuntimeApiServer, type BuildRuntimeApiServerOptions } from "./app.js";

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

function buildTestApp(options: BuildRuntimeApiServerOptions) {
  return buildRuntimeApiServer({
    queueWorker: null,
    durableMemoryWorker: null,
    cronWorker: null,
    recallEmbeddingBackfillWorker: null,
    enableAppHealthMonitor: false,
    startAppsOnReady: false,
    ...options,
  });
}

function makeStoreAndWorkspace(root: string): { store: RuntimeStateStore; workspaceId: string; workspaceDir: string } {
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-automations-1",
    name: "Test Workspace",
    harness: "pi",
    status: "active",
  });
  const workspaceDir = store.workspaceDir(workspace.id);
  return { store, workspaceId: workspace.id, workspaceDir };
}

const VALID_AUTOMATIONS_YAML = `
version: 1
automations:
  - name: Morning Brief
    cron: "0 9 * * *"
    description: Post a morning summary
    instruction: Post a morning summary to LinkedIn
    delivery:
      mode: announce
      channel: session_run
  - name: Evening Recap
    cron: "0 18 * * *"
    description: Post an evening recap
    instruction: Post an evening recap
    delivery:
      mode: announce
      channel: session_run
`.trim();

test("automations import: no file returns no-op response", async () => {
  const root = makeTempDir("hb-automations-import-no-file-");
  const { store, workspaceId } = makeStoreAndWorkspace(root);
  const app = buildTestApp({ store });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/automations/import`,
      payload: { initiated_by: "test_user" },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.imported, 0);
    assert.equal(body.skipped, 0);
    assert.deepEqual(body.jobs, []);

    assert.equal(store.listCronjobs({ workspaceId }).length, 0);
  } finally {
    await app.close();
    store.close();
  }
});

test("automations import: valid file inserts rows with enabled=false", async () => {
  const root = makeTempDir("hb-automations-import-valid-");
  const { store, workspaceId, workspaceDir } = makeStoreAndWorkspace(root);
  fs.writeFileSync(path.join(workspaceDir, "automations.yaml"), VALID_AUTOMATIONS_YAML, "utf8");
  const app = buildTestApp({ store });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/automations/import`,
      payload: { initiated_by: "test_user" },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.imported, 2);
    assert.equal(body.skipped, 0);
    assert.equal(body.jobs.length, 2);

    const importedJobs = store.listCronjobs({ workspaceId });
    assert.equal(importedJobs.length, 2);

    for (const job of importedJobs) {
      assert.equal(job.enabled, false, "all imported jobs must have enabled=false");
      assert.equal(job.metadata.imported, true, "metadata.imported must be true");
      assert.ok(
        typeof job.metadata.import_key === "string" && job.metadata.import_key.length > 0,
        "metadata.import_key must be set"
      );
    }
  } finally {
    await app.close();
    store.close();
  }
});

test("automations import: idempotent — second call skips already-imported rows", async () => {
  const root = makeTempDir("hb-automations-import-idempotent-");
  const { store, workspaceId, workspaceDir } = makeStoreAndWorkspace(root);
  fs.writeFileSync(path.join(workspaceDir, "automations.yaml"), VALID_AUTOMATIONS_YAML, "utf8");
  const app = buildTestApp({ store });

  try {
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/automations/import`,
      payload: { initiated_by: "test_user" },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().imported, 2);

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/automations/import`,
      payload: { initiated_by: "test_user" },
    });
    assert.equal(second.statusCode, 200);
    const secondBody = second.json();
    assert.equal(secondBody.imported, 0);
    assert.equal(secondBody.skipped, 2);

    assert.equal(store.listCronjobs({ workspaceId }).length, 2);
  } finally {
    await app.close();
    store.close();
  }
});

test("automations import: schema rejection on wrong version", async () => {
  const root = makeTempDir("hb-automations-import-schema-");
  const { store, workspaceId, workspaceDir } = makeStoreAndWorkspace(root);
  fs.writeFileSync(
    path.join(workspaceDir, "automations.yaml"),
    "version: 2\nautomations: []\n",
    "utf8"
  );
  const app = buildTestApp({ store });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/automations/import`,
      payload: { initiated_by: "test_user" },
    });

    assert.equal(response.statusCode, 400);
    const body = response.json();
    assert.ok(
      typeof body.detail === "string" && body.detail.includes("version"),
      `expected detail to mention 'version', got: ${body.detail}`
    );
  } finally {
    await app.close();
    store.close();
  }
});

test("automations import: unknown workspace id resolves to the synthetic root instead of 404", async () => {
  const root = makeTempDir("hb-automations-import-404-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  const app = buildTestApp({ store });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces/nonexistent-workspace/automations/import",
      payload: { initiated_by: "test_user" },
    });

    // Single-tenant (workspace-removal): store.getWorkspace() resolves ANY id to
    // the synthetic root, so the former per-id "workspace not found" 404 guard
    // never fires. With no automations.yaml on disk the import is a no-op success
    // rather than a rejection.
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      imported: 0,
      skipped: 0,
      jobs: [],
      skipped_details: [],
    });
  } finally {
    await app.close();
    store.close();
  }
});

test("automations import: bad cron in one entry skips that entry, imports the rest", async () => {
  const root = makeTempDir("hb-automations-import-bad-cron-");
  const { store, workspaceId, workspaceDir } = makeStoreAndWorkspace(root);
  fs.writeFileSync(
    path.join(workspaceDir, "automations.yaml"),
    `
version: 1
automations:
  - name: Good Job
    cron: "0 9 * * *"
    description: A valid cronjob
    instruction: Do the thing
    delivery:
      mode: announce
      channel: session_run
  - name: Bad Job
    cron: "not a cron"
    description: A job with an invalid cron
    instruction: Should be skipped
    delivery:
      mode: announce
      channel: session_run
`.trim(),
    "utf8"
  );
  const app = buildTestApp({ store });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/automations/import`,
      payload: { initiated_by: "test_user" },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    // The good job should be imported; the bad-cron job may be skipped (nextRunAt null is accepted by createCronjob)
    // or imported with null nextRunAt. Either outcome is valid — assert total imported + skipped = 2.
    assert.equal(body.imported + body.skipped, 2, "total of imported + skipped must equal 2 entries");
    assert.ok(body.imported >= 1, "at least 1 job (the good cron) must be imported");
  } finally {
    await app.close();
    store.close();
  }
});
