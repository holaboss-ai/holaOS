import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { createRemoteApiClient } from "@holaboss/remote-api/client";

import { buildRuntimeApiServer } from "./app.js";

// Drives the outputs domain over oRPC against the real runtime + real store.
test("remote-api outputs.list round-trips against the real runtime over HTTP", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "remote-api-outputs-it-"));
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

  // Fresh workspace → empty, but the handler + store.listOutputs path must run.
  const listed = await client.outputs.list({});
  assert.ok(Array.isArray(listed.items));
  assert.equal(listed.items.length, 0);

  // Filters pass through without error.
  const filtered = await client.outputs.list({
    sessionId: "does-not-exist",
    limit: 10,
  });
  assert.deepEqual(filtered.items, []);
});
