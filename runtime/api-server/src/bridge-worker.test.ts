import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import { FilesystemMemoryService } from "./memory.js";
import {
  RuntimeRemoteBridgeWorker,
  bridgeEnabled,
  bridgeMaxItems,
  bridgePollIntervalMs,
  executeBridgeJobNatively,
  proactiveBridgeBaseUrl,
  proactiveBridgeHeaders,
  tsBridgeWorkerEnabled
} from "./bridge-worker.js";
import type { RuntimeSentryCaptureOptions } from "./runtime-sentry.js";

test("ts bridge worker is enabled by default when remote bridge is enabled and only disables on explicit opt-out", () => {
  const previousBridge = process.env.PROACTIVE_ENABLE_REMOTE_BRIDGE;
  const previousTs = process.env.HOLABOSS_RUNTIME_USE_TS_BRIDGE_WORKER;

  process.env.PROACTIVE_ENABLE_REMOTE_BRIDGE = "1";
  delete process.env.HOLABOSS_RUNTIME_USE_TS_BRIDGE_WORKER;
  assert.equal(bridgeEnabled(), true);
  assert.equal(tsBridgeWorkerEnabled(), true);

  process.env.HOLABOSS_RUNTIME_USE_TS_BRIDGE_WORKER = "off";
  assert.equal(tsBridgeWorkerEnabled(), false);

  if (previousBridge === undefined) {
    delete process.env.PROACTIVE_ENABLE_REMOTE_BRIDGE;
  } else {
    process.env.PROACTIVE_ENABLE_REMOTE_BRIDGE = previousBridge;
  }
  if (previousTs === undefined) {
    delete process.env.HOLABOSS_RUNTIME_USE_TS_BRIDGE_WORKER;
  } else {
    process.env.HOLABOSS_RUNTIME_USE_TS_BRIDGE_WORKER = previousTs;
  }
});

test("bridge helpers read headers and env settings", () => {
  const previousConfigPath = process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  const previousAuth = process.env.HOLABOSS_SANDBOX_AUTH_TOKEN;
  const previousUser = process.env.HOLABOSS_USER_ID;
  const previousPoll = process.env.PROACTIVE_BRIDGE_POLL_INTERVAL_SECONDS;
  const previousMax = process.env.PROACTIVE_BRIDGE_MAX_ITEMS;
  const previousBridgeBase = process.env.PROACTIVE_BRIDGE_BASE_URL;
  const previousBackendBase = process.env.HOLABOSS_BACKEND_BASE_URL;

  delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  process.env.HOLABOSS_SANDBOX_AUTH_TOKEN = "token-1";
  process.env.HOLABOSS_USER_ID = "user-1";
  process.env.PROACTIVE_BRIDGE_POLL_INTERVAL_SECONDS = "0.1";
  process.env.PROACTIVE_BRIDGE_MAX_ITEMS = "200";
  delete process.env.PROACTIVE_BRIDGE_BASE_URL;
  process.env.HOLABOSS_BACKEND_BASE_URL = "https://backend.example/";

  assert.deepEqual(proactiveBridgeHeaders(), {
    "X-API-Key": "token-1",
    "X-Holaboss-User-Id": "user-1"
  });
  assert.equal(proactiveBridgeBaseUrl(), "https://backend.example:3032");
  assert.equal(bridgePollIntervalMs(), 500);
  assert.equal(bridgeMaxItems(), 100);

  if (previousConfigPath === undefined) {
    delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  } else {
    process.env.HOLABOSS_RUNTIME_CONFIG_PATH = previousConfigPath;
  }
  if (previousAuth === undefined) {
    delete process.env.HOLABOSS_SANDBOX_AUTH_TOKEN;
  } else {
    process.env.HOLABOSS_SANDBOX_AUTH_TOKEN = previousAuth;
  }
  if (previousUser === undefined) {
    delete process.env.HOLABOSS_USER_ID;
  } else {
    process.env.HOLABOSS_USER_ID = previousUser;
  }
  if (previousPoll === undefined) {
    delete process.env.PROACTIVE_BRIDGE_POLL_INTERVAL_SECONDS;
  } else {
    process.env.PROACTIVE_BRIDGE_POLL_INTERVAL_SECONDS = previousPoll;
  }
  if (previousMax === undefined) {
    delete process.env.PROACTIVE_BRIDGE_MAX_ITEMS;
  } else {
    process.env.PROACTIVE_BRIDGE_MAX_ITEMS = previousMax;
  }
  if (previousBridgeBase === undefined) {
    delete process.env.PROACTIVE_BRIDGE_BASE_URL;
  } else {
    process.env.PROACTIVE_BRIDGE_BASE_URL = previousBridgeBase;
  }
  if (previousBackendBase === undefined) {
    delete process.env.HOLABOSS_BACKEND_BASE_URL;
  } else {
    process.env.HOLABOSS_BACKEND_BASE_URL = previousBackendBase;
  }
});

test("explicit proactive bridge base url overrides backend base url", () => {
  const previousBridgeBase = process.env.PROACTIVE_BRIDGE_BASE_URL;
  const previousBackendBase = process.env.HOLABOSS_BACKEND_BASE_URL;

  process.env.PROACTIVE_BRIDGE_BASE_URL = "https://proactive.example/";
  process.env.HOLABOSS_BACKEND_BASE_URL = "https://backend.example/";

  assert.equal(proactiveBridgeBaseUrl(), "https://proactive.example");

  if (previousBridgeBase === undefined) {
    delete process.env.PROACTIVE_BRIDGE_BASE_URL;
  } else {
    process.env.PROACTIVE_BRIDGE_BASE_URL = previousBridgeBase;
  }
  if (previousBackendBase === undefined) {
    delete process.env.HOLABOSS_BACKEND_BASE_URL;
  } else {
    process.env.HOLABOSS_BACKEND_BASE_URL = previousBackendBase;
  }
});

test("runtime remote bridge worker polls jobs and reports results", async () => {
  const previousBaseUrl = process.env.PROACTIVE_BRIDGE_BASE_URL;
  const previousAuth = process.env.HOLABOSS_SANDBOX_AUTH_TOKEN;
  process.env.PROACTIVE_BRIDGE_BASE_URL = "http://127.0.0.1:3069";
  process.env.HOLABOSS_SANDBOX_AUTH_TOKEN = "token-1";

  const fetchCalls: Array<{ url: string; method: string; body?: string }> = [];
  const worker = new RuntimeRemoteBridgeWorker({
    fetchImpl: (async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      fetchCalls.push({
        url,
        method,
        body: typeof init?.body === "string" ? init.body : undefined
      });
      if (url.endsWith("/jobs?limit=10")) {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                job_id: "job-1",
                job_type: "task_proposal.create",
                workspace_id: "workspace-1",
                payload: { workspace_id: "workspace-1" }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("", { status: 204 });
    }) as typeof fetch,
    executeJob: async (job) => ({
      job_id: job.job_id,
      status: "succeeded",
      workspace_id: job.workspace_id,
      job_type: job.job_type,
      output: { ok: true }
    })
  });

  const processed = await worker.pollOnce();

  assert.equal(processed, 1);
  assert.equal(fetchCalls[0].method, "GET");
  assert.equal(fetchCalls[1].method, "POST");
  assert.match(fetchCalls[1].body ?? "", /"job_id":"job-1"/);

  if (previousBaseUrl === undefined) {
    delete process.env.PROACTIVE_BRIDGE_BASE_URL;
  } else {
    process.env.PROACTIVE_BRIDGE_BASE_URL = previousBaseUrl;
  }
  if (previousAuth === undefined) {
    delete process.env.HOLABOSS_SANDBOX_AUTH_TOKEN;
  } else {
    process.env.HOLABOSS_SANDBOX_AUTH_TOKEN = previousAuth;
  }
});

test("runtime remote bridge worker reports poll failures to Sentry", async () => {
  const previousBaseUrl = process.env.PROACTIVE_BRIDGE_BASE_URL;
  const previousAuth = process.env.HOLABOSS_SANDBOX_AUTH_TOKEN;
  process.env.PROACTIVE_BRIDGE_BASE_URL = "http://127.0.0.1:3069";
  process.env.HOLABOSS_SANDBOX_AUTH_TOKEN = "token-1";

  const sentryCaptures: RuntimeSentryCaptureOptions[] = [];
  const worker = new RuntimeRemoteBridgeWorker({
    captureRuntimeException: (capture) => {
      sentryCaptures.push(capture);
    },
    fetchImpl: (async () =>
      new Response("Invalid or missing API key", {
        status: 401,
        headers: { "Content-Type": "text/plain" }
      })) as typeof fetch,
  });

  await assert.rejects(worker.pollOnce(), /receive_jobs with status 401/);

  assert.equal(sentryCaptures.length, 1);
  assert.equal(sentryCaptures[0]?.tags?.surface, "proactive_bridge");
  assert.equal(sentryCaptures[0]?.tags?.failure_kind, "poll_failure");
  assert.equal(sentryCaptures[0]?.tags?.bridge_phase, "receive_jobs");
  assert.equal(sentryCaptures[0]?.tags?.http_status, 401);
  assert.equal(
    sentryCaptures[0]?.contexts?.proactive_bridge?.endpoint,
    "http://127.0.0.1:3069/api/v1/proactive/bridge/jobs?limit=10"
  );
  assert.equal(
    sentryCaptures[0]?.extras?.response_body,
    "Invalid or missing API key"
  );
  assert.equal(
    sentryCaptures[0]?.extras?.response_content_type,
    "text/plain"
  );

  if (previousBaseUrl === undefined) {
    delete process.env.PROACTIVE_BRIDGE_BASE_URL;
  } else {
    process.env.PROACTIVE_BRIDGE_BASE_URL = previousBaseUrl;
  }
  if (previousAuth === undefined) {
    delete process.env.HOLABOSS_SANDBOX_AUTH_TOKEN;
  } else {
    process.env.HOLABOSS_SANDBOX_AUTH_TOKEN = previousAuth;
  }
});

test("runtime remote bridge worker reports result delivery failures to Sentry", async () => {
  const previousBaseUrl = process.env.PROACTIVE_BRIDGE_BASE_URL;
  const previousAuth = process.env.HOLABOSS_SANDBOX_AUTH_TOKEN;
  process.env.PROACTIVE_BRIDGE_BASE_URL = "http://127.0.0.1:3069";
  process.env.HOLABOSS_SANDBOX_AUTH_TOKEN = "token-1";

  const sentryCaptures: RuntimeSentryCaptureOptions[] = [];
  const worker = new RuntimeRemoteBridgeWorker({
    captureRuntimeException: (capture) => {
      sentryCaptures.push(capture);
    },
    fetchImpl: (async (input, init) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                job_id: "job-1",
                job_type: "task_proposal.create",
                workspace_id: "workspace-1",
                payload: {
                  workspace_id: "workspace-1",
                  task_name: "Review workspace",
                  task_prompt: "Review the current workspace.",
                  task_generation_rationale: "Bridge test"
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      assert.equal(url, "http://127.0.0.1:3069/api/v1/proactive/bridge/results");
      return new Response("gateway unavailable", {
        status: 503,
        headers: { "Content-Type": "text/plain" }
      });
    }) as typeof fetch,
    executeJob: async (job) => ({
      job_id: job.job_id,
      status: "succeeded",
      workspace_id: job.workspace_id,
      job_type: job.job_type,
      output: { ok: true }
    })
  });

  const processed = await worker.pollOnce();

  assert.equal(processed, 1);
  assert.equal(sentryCaptures.length, 1);
  assert.equal(sentryCaptures[0]?.tags?.surface, "proactive_bridge");
  assert.equal(sentryCaptures[0]?.tags?.failure_kind, "job_failure");
  assert.equal(sentryCaptures[0]?.tags?.bridge_phase, "report_result");
  assert.equal(sentryCaptures[0]?.tags?.job_type, "task_proposal.create");
  assert.equal(sentryCaptures[0]?.tags?.http_status, 503);
  assert.equal(
    sentryCaptures[0]?.contexts?.proactive_bridge_job?.job_id,
    "job-1"
  );
  assert.equal(
    sentryCaptures[0]?.extras?.response_body,
    "gateway unavailable"
  );
  assert.deepEqual(sentryCaptures[0]?.extras?.reported_result, {
    status: "succeeded",
    error_code: null,
    error_message: null,
    completed_at: null,
    has_output: true
  });

  if (previousBaseUrl === undefined) {
    delete process.env.PROACTIVE_BRIDGE_BASE_URL;
  } else {
    process.env.PROACTIVE_BRIDGE_BASE_URL = previousBaseUrl;
  }
  if (previousAuth === undefined) {
    delete process.env.HOLABOSS_SANDBOX_AUTH_TOKEN;
  } else {
    process.env.HOLABOSS_SANDBOX_AUTH_TOKEN = previousAuth;
  }
});

test("executeBridgeJobNatively creates task proposals in the TS state store", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-bridge-worker-"));
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace One",
    harness: "pi",
    status: "active"
  });
  const memoryService = new FilesystemMemoryService({ workspaceRoot });

  const result = await executeBridgeJobNatively({
    job: {
      job_id: "job-1",
      job_type: "task_proposal.create",
      workspace_id: "workspace-1",
      payload: {
        workspace_id: "workspace-1",
        task_name: "Review workspace",
        task_prompt: "Review the current workspace.",
        task_generation_rationale: "Bridge test"
      }
    },
    store,
    memoryService
  });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.output, { proposal_id: "job-1" });
  assert.equal(
    store.getTaskProposal({ workspaceId: "workspace-1", proposalId: "job-1" })?.taskName,
    "Review workspace"
  );
  assert.equal(
    store.getTaskProposal({ workspaceId: "workspace-1", proposalId: "job-1" })?.proposalSource,
    "proactive"
  );
  store.close();
});

test("executeBridgeJobNatively supports memory operations", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-bridge-memory-"));
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace One",
    harness: "pi",
    status: "active"
  });
  const memoryService = new FilesystemMemoryService({ workspaceRoot });

  const upsert = await executeBridgeJobNatively({
    job: {
      job_id: "job-upsert",
      job_type: "workspace.memory.upsert",
      workspace_id: "workspace-1",
      payload: {
        workspace_id: "workspace-1",
        path: "workspace/workspace-1/notes.md",
        content: "campaign plan",
        append: false
      }
    },
    store,
    memoryService
  });
  const search = await executeBridgeJobNatively({
    job: {
      job_id: "job-search",
      job_type: "workspace.memory.search",
      workspace_id: "workspace-1",
      payload: {
        workspace_id: "workspace-1",
        query: "campaign",
        max_results: 5,
        min_score: 0
      }
    },
    store,
    memoryService
  });
  const refresh = await executeBridgeJobNatively({
    job: {
      job_id: "job-refresh",
      job_type: "workspace.memory.refresh",
      workspace_id: "workspace-1",
      payload: {
        workspace_id: "workspace-1",
        reason: "bridge_refresh",
        force: true
      }
    },
    store,
    memoryService
  });

  assert.equal(upsert.status, "succeeded");
  assert.equal(upsert.output?.path, "workspace/workspace-1/notes.md");
  assert.equal(search.status, "succeeded");
  assert.ok(Array.isArray(search.output?.results));
  assert.equal(refresh.status, "succeeded");
  assert.equal(refresh.output?.alias, "workspace.memory.sync");
  store.close();
});

test("executeBridgeJobNatively captures bundled proactive workspace context", async () => {
  const previousUser = process.env.HOLABOSS_USER_ID;
  process.env.HOLABOSS_USER_ID = "user-1";

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-bridge-context-"));
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace One",
    harness: "pi",
    status: "active"
  });
  const workspaceDir = store.workspaceDir("workspace-1");
  fs.mkdirSync(path.join(workspaceDir, "apps", "twitter"), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, "workspace.yaml"),
    `
agents:
  id: workspace.general
  model: openai/gpt-5
applications:
  - app_id: twitter
    config_path: apps/twitter/app.runtime.yaml
mcp_registry:
  allowlist:
    tool_ids:
      - twitter.performance
  servers:
    twitter:
      type: remote
      url: "http://localhost:3099/mcp"
      enabled: true
`.trim(),
    "utf8"
  );
  fs.writeFileSync(
    path.join(workspaceDir, "apps", "twitter", "app.runtime.yaml"),
    `
app_id: twitter
healthchecks:
  mcp:
    path: /health
    timeout_s: 30
    interval_s: 5
mcp:
  transport: http-sse
  port: 3099
  path: /mcp
env_contract:
  - HOLABOSS_USER_ID
`.trim(),
    "utf8"
  );
  const memoryService = new FilesystemMemoryService({ workspaceRoot });
  await memoryService.upsert({
    workspace_id: "workspace-1",
    path: "workspace/workspace-1/state.md",
    content: "Past tweet performance favors concise growth hooks.",
    append: false
  });
  await memoryService.upsert({
    workspace_id: "workspace-1",
    path: "workspace/workspace-1/runtime/latest-turn.md",
    content: "Latest runtime turn summary.",
    append: false
  });
  await memoryService.upsert({
    workspace_id: "workspace-1",
    path: "workspace/workspace-1/runtime/recent-turns/session-main.md",
    content: "Recent runtime turn history.",
    append: false
  });
  await memoryService.upsert({
    workspace_id: "workspace-1",
    path: "workspace/workspace-1/runtime/permission-blockers/deploy.md",
    content: "Deploy is blocked by policy.",
    append: false
  });
  await memoryService.upsert({
    workspace_id: "workspace-1",
    path: "workspace/workspace-1/knowledge/blockers/permission-deploy.md",
    content: "# Recurring Blocker\n\nDeploy is blocked by policy.",
    append: false
  });
  await memoryService.upsert({
    workspace_id: "workspace-1",
    path: "workspace/workspace-1/MEMORY.md",
    content: "# Workspace Memory Index\n\n- [permission-deploy.md](knowledge/blockers/permission-deploy.md)",
    append: false
  });
  await memoryService.upsert({
    workspace_id: "workspace-1",
    path: "preference/response-style.md",
    content: "Respond concisely.",
    append: false
  });
  await memoryService.upsert({
    workspace_id: "workspace-1",
    path: "preference/MEMORY.md",
    content: "# Preference Memory Index\n\n- [response-style.md](response-style.md)",
    append: false
  });
  await memoryService.upsert({
    workspace_id: "workspace-1",
    path: "MEMORY.md",
    content: "# Memory Index\n\n- [Workspace workspace-1](workspace/workspace-1/MEMORY.md)",
    append: false
  });
  store.upsertMemoryEntry({
    memoryId: "workspace-blocker:deploy",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    scope: "workspace",
    memoryType: "blocker",
    subjectKey: "deploy",
    path: "workspace/workspace-1/knowledge/blockers/permission-deploy.md",
    title: "Recurring deploy blocker",
    summary: "Deploy is blocked by policy.",
    tags: ["deploy", "policy"],
    verificationPolicy: "check_before_use",
    stalenessPolicy: "workspace_sensitive",
    staleAfterSeconds: 1209600,
    fingerprint: "fingerprint-workspace-blocker",
  });
  store.upsertMemoryEntry({
    memoryId: "user-preference:response-style",
    workspaceId: null,
    sessionId: "session-main",
    scope: "user",
    memoryType: "preference",
    subjectKey: "response-style",
    path: "preference/response-style.md",
    title: "Response style",
    summary: "Respond concisely.",
    tags: ["style"],
    verificationPolicy: "none",
    stalenessPolicy: "stable",
    staleAfterSeconds: null,
    fingerprint: "fingerprint-response-style",
  });

  const result = await executeBridgeJobNatively({
    job: {
      job_id: "job-context",
      job_type: "workspace.context.capture",
      workspace_id: "workspace-1",
      payload: {
        workspace_id: "workspace-1",
        reason: "remote_proactive_analysis"
      }
    },
    store,
    memoryService
  });

  assert.equal(result.status, "succeeded");
  const context = result.output?.context as Record<string, unknown>;
  const snapshot = context.snapshot as Record<string, unknown>;
  const memory = context.memory as Record<string, unknown>;
  const runtimeProjections = memory.runtime_projections as Record<string, unknown>;
  const durableIndexes = memory.durable_indexes as Record<string, unknown>;
  const durableFiles = memory.durable_files as Record<string, unknown>;
  const durableCatalog = memory.durable_catalog as Record<string, unknown>;
  const debugFiles = memory.debug_files as Record<string, unknown>;
  const derivedRuntime = memory.derived_runtime as Record<string, unknown>;
  const toolManifest = context.tool_manifest as Record<string, unknown>;
  assert.equal((context.workspace as Record<string, unknown>).holaboss_user_id, "user-1");
  assert.deepEqual(snapshot.applications, ["twitter"]);
  assert.deepEqual(snapshot.mcp_tool_ids, ["twitter.performance"]);
  assert.equal((memory.files as Record<string, unknown>)["workspace/workspace-1/state.md"], "Past tweet performance favors concise growth hooks.");
  assert.deepEqual(derivedRuntime.priority_file_paths, [
    "workspace/workspace-1/runtime/latest-turn.md",
    "workspace/workspace-1/runtime/permission-blockers/deploy.md",
    "workspace/workspace-1/runtime/recent-turns/session-main.md",
  ]);
  assert.deepEqual(runtimeProjections.priority_file_paths, derivedRuntime.priority_file_paths);
  assert.equal(
    ((derivedRuntime.latest_turn as Record<string, unknown>)?.text as string),
    "Latest runtime turn summary."
  );
  assert.equal(
    (
      (derivedRuntime.permission_blockers as Record<string, unknown>)[
        "workspace/workspace-1/runtime/permission-blockers/deploy.md"
      ] as string
    ),
    "Deploy is blocked by policy."
  );
  assert.equal(
    (
      (derivedRuntime.recent_turns as Record<string, unknown>)[
        "workspace/workspace-1/runtime/recent-turns/session-main.md"
      ] as string
    ),
    "Recent runtime turn history."
  );
  assert.equal(
    ((derivedRuntime.response_style_preference as Record<string, unknown>)?.text as string),
    "Respond concisely."
  );
  assert.equal(
    ((durableIndexes.root as Record<string, unknown>)?.text as string),
    "# Memory Index\n\n- [Workspace workspace-1](workspace/workspace-1/MEMORY.md)"
  );
  assert.equal(
    (
      (durableFiles.workspace_knowledge as Record<string, unknown>)[
        "workspace/workspace-1/knowledge/blockers/permission-deploy.md"
      ] as string
    ),
    "# Recurring Blocker\n\nDeploy is blocked by policy."
  );
  assert.equal(
    ((durableFiles.user_scopes as Record<string, unknown>)["preference/response-style.md"] as string),
    "Respond concisely."
  );
  assert.equal(durableCatalog.total_entries, 2);
  assert.deepEqual(durableCatalog.counts_by_scope, { user: 1, workspace: 1 });
  assert.deepEqual(durableCatalog.counts_by_type, { blocker: 1, preference: 1 });
  assert.deepEqual(debugFiles.uncategorized_paths, ["workspace/workspace-1/state.md"]);
  assert.ok(Array.isArray(toolManifest.tools));
  assert.equal((toolManifest.tools as Array<Record<string, unknown>>)[0]?.tool_id, "twitter.performance");

  store.close();
  if (previousUser === undefined) {
    delete process.env.HOLABOSS_USER_ID;
  } else {
    process.env.HOLABOSS_USER_ID = previousUser;
  }
});
