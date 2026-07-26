import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { createRemoteApiClient } from "@holaboss/remote-api/client";

import { buildRuntimeApiServer } from "./app.js";

// Drives the cronjobs domain over oRPC against the real runtime + store.
test("remote-api cronjobs round-trips against the real runtime over HTTP", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "remote-api-cronjobs-it-"));
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

  // Fresh workspace → no cronjobs.
  const empty = await client.cronjobs.list({});
  assert.deepEqual(empty.jobs, []);
  assert.equal(empty.count, 0);

  // Create → list → update → delete round-trip.
  const job = await client.cronjobs.create({
    initiatedBy: "integration-test",
    cron: "0 9 * * *",
    description: "Daily digest",
    delivery: { mode: "deliver", channel: "session_run", to: null },
  });
  assert.ok(job.id);
  assert.equal(job.cron, "0 9 * * *");
  assert.equal(job.enabled, true);

  const listed = await client.cronjobs.list({});
  assert.equal(listed.count, 1);
  assert.equal(listed.jobs[0]?.id, job.id);

  const updated = await client.cronjobs.update({
    jobId: job.id as string,
    enabled: false,
  });
  assert.equal(updated.enabled, false);

  const removed = await client.cronjobs.delete({
    jobId: job.id as string,
  });
  assert.equal(removed.success, true);

  const afterDelete = await client.cronjobs.list({});
  assert.equal(afterDelete.count, 0);

  // Unknown ids surface the typed NOT_FOUND error (runNow + delete paths).
  await assert.rejects(
    () => client.cronjobs.runNow({ jobId: "does-not-exist" }),
    (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
  );
  await assert.rejects(
    () => client.cronjobs.delete({ jobId: "does-not-exist" }),
    (error: unknown) => (error as { code?: string }).code === "NOT_FOUND",
  );
});
