// Proves runtime-side log correlation: the client attaches an x-request-id, and
// the server emits structured start/success lines carrying that same id, so a
// single grep on the runtime logs reconstructs the call. The client does not log.
// Run: bun packages/remote-api/scripts/logging-smoke.mjs
import Fastify from "fastify";
import { mountRemoteApi } from "../dist/server.js";
import { createRemoteApiClient } from "../dist/client.js";

const record = {
  id: "ws_1",
  name: "Log WS",
  status: "ready",
  harness: null,
  error_message: null,
  onboarding_status: "not_required",
  onboarding_session_id: null,
  onboarding_completed_at: null,
  onboarding_completion_summary: null,
  onboarding_requested_at: null,
  onboarding_requested_by: null,
  created_at: null,
  updated_at: null,
  deleted_at_utc: null,
};

const serverLogs = [];
const serverLogger = {
  debug: (event, fields) => serverLogs.push({ level: "debug", event, ...fields }),
  info: (event, fields) => serverLogs.push({ level: "info", event, ...fields }),
  warn: (event, fields) => serverLogs.push({ level: "warn", event, ...fields }),
  error: (event, fields) => serverLogs.push({ level: "error", event, ...fields }),
};

let seenHeaderId;
const app = Fastify();
app.addHook("onRequest", async (req) => {
  if (req.url.startsWith("/rpc")) {
    seenHeaderId = req.headers["x-request-id"];
  }
});
mountRemoteApi(app, {
  logger: serverLogger,
  context: () => ({
    workspaces: {
      list: () => ({ items: [record], total: 1, limit: 50, offset: 0 }),
      get: () => ({ workspace: record }),
      update: ({ patch }) => ({ workspace: { ...record, icon: patch.icon } }),
    },
  }),
});
await app.listen({ port: 0, host: "127.0.0.1" });
const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
const client = createRemoteApiClient({ url: `${baseUrl}/rpc` });

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

try {
  await client.workspaces.update({ workspaceId: "ws_1", patch: { icon: "rocket", icon_color: "#F58419" } });

  const start = serverLogs.find((l) => l.outcome === "start");
  const done = serverLogs.find((l) => l.outcome === "success");

  check("client attached an x-request-id header", Boolean(seenHeaderId), seenHeaderId);
  check("server logged start with that requestId", start?.requestId === seenHeaderId);
  check("server start carries procedure + workspaceId", start?.procedure === "workspaces.update" && start?.workspaceId === "ws_1");
  check("server logged success + duration with same requestId", done?.requestId === seenHeaderId && typeof done?.durationMs === "number");

  console.log(`\nServer timeline (grep requestId=${seenHeaderId}):`);
  for (const l of serverLogs) {
    console.log(`  ${JSON.stringify(l)}`);
  }
} catch (error) {
  check("logging smoke run", false, error?.stack ?? String(error));
} finally {
  await app.close();
}

process.exit(failures === 0 ? 0 : 1);
