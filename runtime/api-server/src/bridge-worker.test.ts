import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

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
    store
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
