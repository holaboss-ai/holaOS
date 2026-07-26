import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { createRemoteApiClient } from "@holaboss/remote-api/client";

import { buildRuntimeApiServer } from "./app.js";

// Drives the notifications domain over oRPC against the real runtime + store.
test("remote-api notifications round-trips against the real runtime over HTTP", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "remote-api-notifications-it-"));
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

  // Global list (no workspaceId) — the shell uses this path.
  const globalList = await client.notifications.list({ includeCronjobSource: true });
  assert.ok(Array.isArray(globalList.items));
  assert.equal(typeof globalList.count, "number");

  // Workspace-scoped list — fresh workspace has none.
  const scopedList = await client.notifications.list({});
  assert.deepEqual(scopedList.items, []);
  assert.equal(scopedList.count, 0);

  // Updating an unknown notification surfaces the typed NOT_FOUND error.
  await assert.rejects(
    () =>
      client.notifications.update({
        notificationId: "does-not-exist",
        state: "read",
      }),
    (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
  );
});
