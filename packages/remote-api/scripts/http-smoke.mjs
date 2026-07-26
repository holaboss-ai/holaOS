// Verifies the Fastify mount + real HTTP transport end-to-end against the
// actual client. Stubs the WorkspacesService so no runtime/sqlite is needed.
// Run: bun packages/remote-api/scripts/http-smoke.mjs
import Fastify from "fastify";
import { mountRemoteApi, WorkspacesServiceError } from "../dist/server.js";
import { createRemoteApiClient } from "../dist/client.js";

const record = {
  id: "ws_1",
  name: "Smoke WS",
  status: "ready",
  harness: null,
  error_message: null,
  onboarding_status: "not_required",
  onboarding_session_id: null,
  onboarding_completed_at: null,
  onboarding_completion_summary: null,
  onboarding_requested_at: null,
  onboarding_requested_by: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  deleted_at_utc: null,
  icon: null,
  icon_color: null,
  folder_state: "healthy",
  workspace_path: "/tmp/ws_1",
  implementation_activity: { runs: 3 },
};

const workspaces = {
  list: () => ({ items: [record], total: 1, limit: 50, offset: 0 }),
  get: ({ workspaceId }) => {
    if (workspaceId !== record.id) throw new WorkspacesServiceError("NOT_FOUND");
    return { workspace: record };
  },
  update: ({ workspaceId, patch }) => {
    if (workspaceId !== record.id) throw new WorkspacesServiceError("NOT_FOUND");
    return { workspace: { ...record, icon: patch.icon, icon_color: patch.icon_color } };
  },
};

const app = Fastify();
mountRemoteApi(app, { context: () => ({ workspaces }) });
await app.listen({ port: 0, host: "127.0.0.1" });
const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
const client = createRemoteApiClient({ url: `${baseUrl}/rpc` });

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

try {
  const listed = await client.workspaces.list({ limit: 100 });
  check("list over HTTP", listed.total === 1 && listed.items[0].id === "ws_1");
  check("catchall field preserved", listed.items[0].implementation_activity?.runs === 3);

  const got = await client.workspaces.get({ workspaceId: "ws_1" });
  check("get over HTTP", got.workspace.name === "Smoke WS");

  const updated = await client.workspaces.update({
    workspaceId: "ws_1",
    patch: { icon: "rocket", icon_color: "#F58419" },
  });
  check("update over HTTP", updated.workspace.icon === "rocket" && updated.workspace.icon_color === "#F58419");

  let code = "";
  try {
    await client.workspaces.get({ workspaceId: "nope" });
  } catch (error) {
    code = error?.code ?? "";
  }
  check("typed NOT_FOUND over HTTP", code === "NOT_FOUND", code);
} catch (error) {
  check("smoke run", false, error?.stack ?? String(error));
} finally {
  await app.close();
}

process.exit(failures === 0 ? 0 : 1);
