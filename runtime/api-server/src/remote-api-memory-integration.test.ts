import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { createRemoteApiClient } from "@holaboss/remote-api/client";

import { buildRuntimeApiServer } from "./app.js";

// Drives the memory agent surface over oRPC against the real runtime + real
// FilesystemMemoryService, proving the wire reaches the actual implementation.
test("remote-api memory round-trips against the real runtime over HTTP", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "remote-api-memory-it-"));
  const app = buildRuntimeApiServer({
    workspaceRoot: path.join(root, "workspace"),
    dbPath: path.join(root, "runtime.db"),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  after(() => app.close());

  const client = createRemoteApiClient({ url: `${baseUrl}/rpc` });

  // Single-tenant runtime: workspace CRUD was removed; the server exposes one
  // synthetic root workspace. Resolve its id instead of creating one.
  const listedWorkspaces = await fetch(`${baseUrl}/api/v1/workspaces`).then(
    (response) => response.json(),
  );
  const workspaceId = listedWorkspaces.items[0]?.id as string;
  assert.ok(workspaceId);

  const memoryPath = "preference/remote-api-it.md";
  const content = "remote-api memory round-trip works";

  await client.memory.upsert({
    path: memoryPath,
    content,
  });

  const read = await client.memory.get({ workspaceId, path: memoryPath });
  assert.equal(read.path, memoryPath);
  assert.ok(String(read.text).includes(content));

  const status = await client.memory.status({});
  assert.equal(typeof status, "object");

  // Memory Browser read surface (the renderer-direct surface). readFile takes a
  // tree-relative browser path, so it's exercised by the desktop against real
  // tree nodes rather than the raw agent upsert path used above.
  const tree = await client.memory.browseTree({});
  assert.ok(tree.root && typeof tree.root === "object");

  const graph = await client.memory.browseGraph({
    forest: "workspace",
  });
  assert.ok(Array.isArray(graph.nodes));
});
