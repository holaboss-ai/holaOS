import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import { seedWorkspaceRecord } from "./__test-helpers__/seed-workspace.js";
import { buildRuntimeApiServer } from "./app.js";
import {
  listWorkspaceMcpRegistryServers,
  upsertWorkspaceMcpServerEntry,
} from "./workspace-apps.js";

test("DELETE mcp-servers removes a connected server from the registry", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "hb-mcp-servers-route-"));
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  const workspace = seedWorkspaceRecord(store);
  // The routes canonicalize the requested workspace via getWorkspace before
  // resolving its directory — seed the registry through the same resolution.
  const canonicalId = store.getWorkspace(workspace.id)?.id ?? workspace.id;
  const workspaceDir = store.workspaceDir(canonicalId);
  upsertWorkspaceMcpServerEntry(workspaceDir, {
    serverId: "notion",
    transport: "local",
    command: ["npx", "-y", "@notionhq/notion-mcp-server"],
  });

  const app = buildRuntimeApiServer({ store, queueWorker: null, cronWorker: null });
  try {
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspace.id}/mcp-servers/notion`,
    });
    assert.equal(removed.statusCode, 200);
    assert.equal(removed.json().removed, true);
    assert.equal(listWorkspaceMcpRegistryServers(workspaceDir).length, 0);

    const missing = await app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspace.id}/mcp-servers/notion`,
    });
    assert.equal(missing.statusCode, 404);

    const reserved = await app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspace.id}/mcp-servers/workspace`,
    });
    assert.equal(reserved.statusCode, 400);
  } finally {
    await app.close();
    store.close();
  }
});
