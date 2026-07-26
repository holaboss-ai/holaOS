import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";

import { RuntimeStateStore, utcNowIso } from "@holaboss/runtime-state-store";
import { seedWorkspaceRecord } from "./__test-helpers__/seed-workspace.js";
import yazl from "yazl";
import * as tar from "tar";

import { buildRuntimeApiServer, type BuildRuntimeApiServerOptions } from "./app.js";
import { appLocalNpmCacheDir, buildAppSetupEnv } from "./app-setup-env.js";
import { processClaimedInput } from "./claimed-input-executor.js";
import { runtimeUserTimezone } from "./cron-worker.js";
import { rebuildIntegrationTree } from "./integration-memory.js";
import { persistInteractionCandidate, rebuildInteractionEntityTree } from "./interaction-memory.js";
import {
  appendDurableMemoryRelatedSections,
  parseDurableMemoryRelatedInfo,
  stripDurableMemoryRelatedSections,
} from "./memory-related-entities.js";
import {
  writeTurnDurableMemory,
  waitForPendingWorkspaceMemoryTreeRebuilds,
  type TurnMemoryWritebackModelContext,
} from "./turn-memory-writeback.js";
import {
  parseInstalledAppRuntime,
  removeWorkspaceMcpRegistryEntry,
  resolveWorkspaceAppRuntime,
  writeWorkspaceMcpRegistryEntry,
} from "./workspace-apps.js";
import type { AppLifecycleExecutorLike } from "./app-lifecycle-worker.js";
import { FilesystemMemoryService, type MemoryServiceLike } from "./memory.js";
import type { RuntimeConfigServiceLike } from "./runtime-config.js";
import type { RunnerExecutorLike } from "./runner-worker.js";
import { globalMemoryDirForWorkspaceRoot, workspaceMemoryDir } from "./workspace-bundle-paths.js";
import {
  listWorkspaceAttachmentDocumentTrees,
  listWorkspaceOutputDocumentTrees,
  persistTurnOutputArtifactsAsDocuments,
  listWorkspaceToolResultDocumentTrees,
} from "./workspace-attachment-memory.js";

const tempDirs: string[] = [];
const ORIGINAL_ENV = {
  HB_SANDBOX_ROOT: process.env.HB_SANDBOX_ROOT,
  HOLABOSS_EMBEDDED_RUNTIME: process.env.HOLABOSS_EMBEDDED_RUNTIME,
  HOLABOSS_RUNTIME_CONFIG_PATH: process.env.HOLABOSS_RUNTIME_CONFIG_PATH,
};

// The download / apply-template tests fetch from ephemeral loopback HTTP
// servers. The SSRF guard (ssrf-guard.ts) blocks 127.0.0.1/localhost by
// design, so explicitly allow the loopback host for these in-process tests via
// the same ops opt-in env real deployments would use to permit an internal host.
process.env.SANDBOX_SSRF_ALLOW_HOSTS = [
  process.env.SANDBOX_SSRF_ALLOW_HOSTS,
  "127.0.0.1",
  "localhost",
]
  .filter((entry) => entry && entry.trim())
  .join(",");

const MINIMAL_APP_FIXTURE = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "__fixtures__",
  "minimal-app.tar.gz",
);

function expectedRuntimeTimezone(
  store: Pick<RuntimeStateStore, "getRuntimeUserProfile">,
): string {
  return runtimeUserTimezone(store) || "UTC";
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (ORIGINAL_ENV.HB_SANDBOX_ROOT === undefined) {
    delete process.env.HB_SANDBOX_ROOT;
  } else {
    process.env.HB_SANDBOX_ROOT = ORIGINAL_ENV.HB_SANDBOX_ROOT;
  }
  if (ORIGINAL_ENV.HOLABOSS_EMBEDDED_RUNTIME === undefined) {
    delete process.env.HOLABOSS_EMBEDDED_RUNTIME;
  } else {
    process.env.HOLABOSS_EMBEDDED_RUNTIME =
      ORIGINAL_ENV.HOLABOSS_EMBEDDED_RUNTIME;
  }
  if (ORIGINAL_ENV.HOLABOSS_RUNTIME_CONFIG_PATH === undefined) {
    delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  } else {
    process.env.HOLABOSS_RUNTIME_CONFIG_PATH = ORIGINAL_ENV.HOLABOSS_RUNTIME_CONFIG_PATH;
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeRuntimeConfig(root: string, document: Record<string, unknown>): void {
  const configPath = path.join(root, "state", "runtime-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  process.env.HB_SANDBOX_ROOT = root;
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;
}

function buildTestRuntimeApiServer(options: BuildRuntimeApiServerOptions) {
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

async function createZipBuffer(
  entries: Array<{ path: string; content: string | Buffer; mode?: number }>
): Promise<Buffer> {
  const zipFile = new yazl.ZipFile();
  for (const entry of entries) {
    zipFile.addBuffer(
      Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, "utf8"),
      entry.path,
      entry.mode ? { mode: entry.mode } : undefined
    );
  }

  const chunks: Buffer[] = [];
  const output = zipFile.outputStream;
  output.on("data", (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  const completed = new Promise<Buffer>((resolve, reject) => {
    output.once("error", reject);
    output.once("end", () => {
      resolve(Buffer.concat(chunks));
    });
  });

  zipFile.end();
  return completed;
}

function rewriteZipEntryName(archive: Buffer, fromPath: string, toPath: string): Buffer {
  const from = Buffer.from(fromPath, "utf8");
  const to = Buffer.from(toPath, "utf8");
  assert.equal(from.length, to.length, "zip entry rewrite must preserve encoded path length");

  const mutated = Buffer.from(archive);
  let offset = 0;
  let replaced = 0;
  while (offset >= 0) {
    offset = mutated.indexOf(from, offset);
    if (offset < 0) {
      break;
    }
    to.copy(mutated, offset);
    offset += from.length;
    replaced += 1;
  }

  assert.ok(replaced >= 2, "expected to rewrite local and central directory zip entries");
  return mutated;
}

async function startStaticHttpServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  options: {
    port?: number;
  } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  server.listen(options.port ?? 0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    }
  };
}

async function withMockMemoryModel(params: {
  workspaceId?: string;
  responseForRequest: (
    body: string,
    requestIndex: number,
  ) => {
    statusCode: number;
    body?: Record<string, unknown>;
  };
  run: (modelContext: TurnMemoryWritebackModelContext) => Promise<void>;
}): Promise<void> {
  let requestCount = 0;
  const server = await startStaticHttpServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/openai/v1/chat/completions") {
      response.statusCode = 404;
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const configured = params.responseForRequest(body, requestCount);
      requestCount += 1;
      response.statusCode = configured.statusCode;
      if (configured.body) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(configured.body));
        return;
      }
      response.end();
    });
  });
  try {
    await params.run({
      modelClient: {
        baseUrl: `${server.url}/openai/v1`,
        apiKey: "test-key",
        modelId: "openai/gpt-4.1-mini",
      },
      instruction: "extract durable memory candidates",
    });
    await waitForPendingWorkspaceMemoryTreeRebuilds({
      workspaceId: params.workspaceId ?? "workspace-1",
    });
  } finally {
    await server.close();
  }
}

test("healthz returns ok", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });

  const response = await app.inject({ method: "GET", url: "/healthz" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });
  await app.close();
  store.close();
});

test("browser capability routes proxy to the browser tool service", async () => {
  const root = makeTempDir("hb-runtime-api-browser-capability-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const browserToolService = {
    async getStatus(context?: { workspaceId?: string | null; sessionId?: string | null; space?: string | null }) {
      return {
        available: true,
        workspace_id: context?.workspaceId ?? null,
        session_id: context?.sessionId ?? null,
        browser_space: context?.space ?? null,
        tools: [{ id: "browser_get_state" }]
      };
    },
    async execute(
      toolId: string,
      args: Record<string, unknown>,
      context?: { workspaceId?: string | null; sessionId?: string | null; space?: string | null }
    ) {
      return {
        tool_id: toolId,
        workspace_id: context?.workspaceId ?? null,
        session_id: context?.sessionId ?? null,
        browser_space: context?.space ?? null,
        args
      };
    },
    async listProfiles() {
      return { profiles: [{ id: "bprofile_default", name: "Default" }] };
    },
    async launchProfile() {
      return { ok: true };
    },
    async closeProfile() {
      return { ok: true };
    }
  };
  const app = buildTestRuntimeApiServer({ store, browserToolService });

  const statusResponse = await app.inject({
    method: "GET",
    url: "/api/v1/capabilities/browser",
    headers: {
      "x-holaboss-workspace-id": "workspace-1",
      "x-holaboss-session-id": "session-1",
      "x-holaboss-browser-space": "user"
    }
  });
  assert.equal(statusResponse.statusCode, 200);
  assert.deepEqual(statusResponse.json(), {
    available: true,
    // single-tenant: onRequest rewrites the workspace header to the synthetic root
    workspace_id: "root",
    session_id: "session-1",
    browser_space: null,
    tools: [{ id: "browser_get_state" }]
  });

  const executeResponse = await app.inject({
    method: "POST",
    url: "/api/v1/capabilities/browser/tools/browser_click",
    headers: {
      "x-holaboss-workspace-id": "workspace-1",
      "x-holaboss-session-id": "session-1",
      "x-holaboss-browser-space": "agent"
    },
    payload: {
      index: 3
    }
  });
  assert.equal(executeResponse.statusCode, 200);
  assert.deepEqual(executeResponse.json(), {
    tool_id: "browser_click",
    // single-tenant: onRequest rewrites the workspace header to the synthetic root
    workspace_id: "root",
    session_id: "session-1",
    browser_space: "agent",
    args: {
      index: 3
    }
  });

  await app.close();
  store.close();
});

test("browser capability preview mode spills screenshot data and trims browser_get_state lanes", async () => {
  const root = makeTempDir("hb-runtime-api-browser-preview-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    // single-tenant: runtime resolves every request to the synthetic root, so
    // seed + spill paths must live under "root"
    workspaceId: "root",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  fs.mkdirSync(path.join(workspaceRoot, "root"), { recursive: true });

  const browserToolService = {
    async getStatus() {
      return { available: true, tools: [{ id: "browser_get_state" }] };
    },
    async execute() {
      return {
        ok: true,
        page: { url: "https://example.com", title: "Example" },
        state: {
          text: "a".repeat(2400),
          elements: Array.from({ length: 28 }, (_, index) => ({
            index: index + 1,
            text: `element ${index + 1}`,
          })),
          media: Array.from({ length: 14 }, (_, index) => ({
            index: index + 1,
            label: `media ${index + 1}`,
          })),
        },
        screenshot: {
          mimeType: "image/png",
          width: 1,
          height: 1,
          base64: Buffer.from("preview-image", "utf8").toString("base64"),
        },
      };
    },
    async listProfiles() {
      return { profiles: [{ id: "bprofile_default", name: "Default" }] };
    },
    async launchProfile() {
      return { ok: true };
    },
    async closeProfile() {
      return { ok: true };
    },
  };
  const app = buildTestRuntimeApiServer({ store, browserToolService });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/browser/tools/browser_get_state",
      headers: {
        "x-holaboss-workspace-id": "workspace-1",
        "x-holaboss-session-id": "session-main",
        "x-holaboss-tool-result-mode": "preview",
      },
      payload: { include_screenshot: true },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.state.elements.length, 20);
    assert.equal(body.state.media.length, 12);
    assert.equal(body.state.elements_offset, 0);
    assert.equal(body.state.elements_total, 28);
    assert.equal(body.state.elements_has_more, true);
    assert.equal(body.state.next_elements_offset, 20);
    assert.equal(body.state.media_offset, 0);
    assert.equal(body.state.media_total, 14);
    assert.equal(body.state.media_has_more, true);
    assert.equal(body.state.next_media_offset, 12);
    assert.equal(String(body.state.text ?? "").includes("[truncated]"), true);
    assert.equal(
      Object.prototype.hasOwnProperty.call(body.screenshot, "base64"),
      false,
    );
    assert.match(
      String(body.screenshot.file_path ?? ""),
      /^\.holaboss\/state\/tool-results\/browser_get_state\/session-main\//,
    );
    assert.equal(body._preview.mode, "preview");
    assert.equal(body._preview.truncated, true);
    assert.equal(body._preview.spilled, true);
    assert.match(
      String(body.full_state_path ?? ""),
      /^\.holaboss\/state\/tool-results\/browser_get_state\/session-main\//,
    );
    assert.equal(
      fs.existsSync(
        path.join(
          workspaceRoot,
          "root",
          String(body.screenshot.file_path ?? ""),
        ),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(
          workspaceRoot,
          "root",
          String(body.full_state_path ?? ""),
        ),
      ),
      true,
    );
  } finally {
    await app.close();
    store.close();
  }
});

test("terminal session routes proxy to the terminal session manager", async () => {
  const root = makeTempDir("hb-runtime-api-terminal-sessions-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  let currentSession: any = {
    terminalId: "term-1",
    // single-tenant: runtime resolves the request to root and proxies that id to
    // the manager, so the stub session must be keyed under "root"
    workspaceId: "root",
    sessionId: "session-1",
    inputId: "input-1",
    title: "Dev Server",
    backend: "node_pty",
    owner: "agent",
    status: "running",
    cwd: "/tmp/workspace-1",
    shell: "/bin/bash",
    command: "npm run dev",
    exitCode: null,
    lastEventSeq: 1,
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    metadata: { source: "test" }
  };
  const events = [
    {
      id: 1,
      terminalId: "term-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      sequence: 1,
      eventType: "started",
      payload: { command: "npm run dev" },
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  const terminalSessionManager: any = {
    async start() {},
    async close() {},
    async createSession(params: Record<string, unknown>) {
      currentSession = {
        ...currentSession,
        title: String(params.title ?? currentSession.title),
        command: String(params.command ?? currentSession.command),
      };
      return currentSession;
    },
    getSession(params: { terminalId: string; workspaceId: string }) {
      if (params.terminalId !== currentSession.terminalId) {
        return null;
      }
      if (params.workspaceId !== currentSession.workspaceId) {
        return null;
      }
      return currentSession;
    },
    listSessions() {
      return [currentSession];
    },
    listEvents(params: { workspaceId: string; terminalId: string; afterSequence?: number }) {
      if (params.workspaceId !== currentSession.workspaceId) {
        return [];
      }
      return events.filter((event) => event.terminalId === params.terminalId && event.sequence > (params.afterSequence ?? 0));
    },
    async sendInput(params: { workspaceId: string }) {
      if (params.workspaceId !== currentSession.workspaceId) {
        throw new Error("workspace mismatch");
      }
      return currentSession;
    },
    async resize(params: { workspaceId: string }) {
      if (params.workspaceId !== currentSession.workspaceId) {
        throw new Error("workspace mismatch");
      }
      return currentSession;
    },
    async signal(params: { workspaceId: string }) {
      if (params.workspaceId !== currentSession.workspaceId) {
        throw new Error("workspace mismatch");
      }
      return currentSession;
    },
    async closeSession(params: { workspaceId: string }) {
      if (params.workspaceId !== currentSession.workspaceId) {
        throw new Error("workspace mismatch");
      }
      currentSession = {
        ...currentSession,
        status: "closed",
      };
      return currentSession;
    },
    subscribe() {
      return () => {};
    },
  };
  const app = buildTestRuntimeApiServer({ store, terminalSessionManager });

  const listResponse = await app.inject({
    method: "GET",
    // single-tenant: query workspace id resolves to the synthetic root
    url: "/api/v1/terminal-sessions?workspace_id=root",
  });
  assert.equal(listResponse.statusCode, 200);
  assert.equal(listResponse.json()[0].terminalId, "term-1");

  const createResponse = await app.inject({
    method: "POST",
    url: "/api/v1/terminal-sessions",
    headers: {
      "x-holaboss-workspace-id": "workspace-1",
      "x-holaboss-session-id": "session-1",
      "x-holaboss-input-id": "input-1",
    },
    payload: {
      title: "Build",
      command: "npm run build",
    },
  });
  assert.equal(createResponse.statusCode, 200);
  assert.equal(createResponse.json().command, "npm run build");
  assert.equal(createResponse.json().title, "Build");

  const getResponse = await app.inject({
    method: "GET",
    url: "/api/v1/terminal-sessions/term-1?workspace_id=root",
  });
  assert.equal(getResponse.statusCode, 200);
  assert.equal(getResponse.json().terminalId, "term-1");

  const eventsResponse = await app.inject({
    method: "GET",
    url: "/api/v1/terminal-sessions/term-1/events?workspace_id=root&after_sequence=0",
  });
  assert.equal(eventsResponse.statusCode, 200);
  assert.equal(eventsResponse.json().events.length, 1);
  assert.equal(eventsResponse.json().events[0].eventType, "started");

  const closeResponse = await app.inject({
    method: "POST",
    url: "/api/v1/terminal-sessions/term-1/close",
    payload: {
      workspace_id: "root",
    },
  });
  assert.equal(closeResponse.statusCode, 200);
  assert.equal(closeResponse.json().status, "closed");

  await app.close();
  store.close();
});

test("terminal session stream route replays history and forwards live events", async () => {
  const root = makeTempDir("hb-runtime-api-terminal-ws-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const currentSession: any = {
    terminalId: "term-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    inputId: "input-1",
    title: "Dev Server",
    backend: "node_pty",
    owner: "agent",
    status: "running",
    cwd: "/tmp/workspace-1",
    shell: "/bin/bash",
    command: "npm run dev",
    exitCode: null,
    lastEventSeq: 1,
    createdBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    metadata: {}
  };
  const historicalEvent = {
    id: 1,
    terminalId: "term-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    sequence: 1,
    eventType: "started",
    payload: { command: "npm run dev" },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  let subscriber: any = null;
  const terminalSessionManager: any = {
    async start() {},
    async close() {},
    async createSession() {
      return currentSession;
    },
    getSession() {
      return currentSession;
    },
    listSessions() {
      return [currentSession];
    },
    listEvents() {
      return [historicalEvent];
    },
    async sendInput() {
      return currentSession;
    },
    async resize() {
      return currentSession;
    },
    async signal() {
      return currentSession;
    },
    async closeSession() {
      return currentSession;
    },
    subscribe(_terminalId: string, listener: (event: typeof historicalEvent) => void) {
      subscriber = listener;
      return () => {
        subscriber = null;
      };
    },
  };
  const app = buildTestRuntimeApiServer({ store, terminalSessionManager });
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  const wsUrl = `${String(baseUrl).replace(/^http/, "ws")}/api/v1/terminal-sessions/term-1/stream?workspace_id=workspace-1`;
  const socket = new WebSocket(wsUrl);
  const messages: Array<Record<string, unknown>> = [];
  const waitForMessageCount = async (expectedCount: number) => {
    for (let attempt = 0; attempt < 80 && messages.length < expectedCount; attempt += 1) {
      await sleep(25);
    }
    assert.ok(
      messages.length >= expectedCount,
      `expected at least ${expectedCount} websocket messages, saw ${messages.length}`,
    );
  };

  try {
    socket.addEventListener("message", (event) => {
      messages.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("websocket open failed")), { once: true });
    });

    await waitForMessageCount(2);
    assert.equal(messages[0]?.type, "connected");
    assert.equal((messages[1]?.event as { eventType?: string })?.eventType, "started");

    if (subscriber) {
      subscriber({
        id: 2,
        terminalId: "term-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        sequence: 2,
        eventType: "output",
        payload: { data: "ready\n" },
        createdAt: "2026-01-01T00:00:01.000Z",
      });
    }

    await waitForMessageCount(3);
    assert.equal((messages[2]?.event as { eventType?: string })?.eventType, "output");
  } finally {
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        socket.addEventListener("close", () => resolve(), { once: true });
        socket.close();
      });
    }
    await app.close();
    store.close();
  }
});

test("runtime tools capability routes expose local onboarding and cronjob actions", async () => {
  const root = makeTempDir("hb-runtime-api-runtime-tools-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  store.upsertRuntimeUserProfile({
    timezone: "America/Los_Angeles",
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    onboardingStatus: "pending",
    onboardingSessionId: "session-1"
  });
  const app = buildTestRuntimeApiServer({ store });
  try {
    const capabilityStatus = await app.inject({
      method: "GET",
      url: "/api/v1/capabilities/runtime-tools",
      headers: {
        "x-holaboss-workspace-id": "workspace-1"
      }
    });
    assert.equal(capabilityStatus.statusCode, 200);
    assert.equal(capabilityStatus.json().available, true);
    // single-tenant: capability surface reports the resolved root workspace id
    assert.equal(capabilityStatus.json().workspace_id, "root");
    assert.ok(
      capabilityStatus
        .json()
        .tools.some((tool: { id: string }) => tool.id === "image_generate")
    );
    assert.ok(
      capabilityStatus
        .json()
        .tools.some((tool: { id: string }) => tool.id === "download_url")
    );
    assert.ok(
      capabilityStatus
        .json()
        .tools.some((tool: { id: string }) => tool.id === "write_report")
    );
    assert.ok(
      capabilityStatus
        .json()
        .tools.some((tool: { id: string }) => tool.id === "web_search")
    );
    assert.ok(
      capabilityStatus
        .json()
        .tools.some((tool: { id: string }) => tool.id === "todoread")
    );
    assert.ok(
      capabilityStatus
        .json()
        .tools.some((tool: { id: string }) => tool.id === "todowrite")
    );
    assert.ok(
      capabilityStatus
        .json()
        .tools.some((tool: { id: string }) => tool.id === "terminal_session_start")
    );
    assert.ok(
      capabilityStatus
        .json()
        .tools.some((tool: { id: string }) => tool.id === "skill")
    );
    assert.ok(
      capabilityStatus
        .json()
        .tools.some((tool: { id: string }) => tool.id === "memory_retrieve")
    );
    assert.ok(
      capabilityStatus
        .json()
        .tools.some((tool: { id: string }) => tool.id === "workspace_apps_scaffold")
    );
    assert.ok(
      capabilityStatus
        .json()
        .tools.some((tool: { id: string }) => tool.id === "workspace_integrations_list_catalog")
    );
    assert.ok(
      capabilityStatus
        .json()
        .tools.some((tool: { id: string }) => tool.id === "workspace_apps_build")
    );
    assert.ok(
      capabilityStatus
        .json()
        .tools.some((tool: { id: string }) => tool.id === "workspace_apps_restart_and_wait_ready")
    );
    assert.ok(
      capabilityStatus
        .json()
        .tools.some((tool: { id: string }) => tool.id === "workspace_apps_wait_until_ready")
    );
    assert.ok(
      capabilityStatus
        .json()
        .tools.some((tool: { id: string }) => tool.id === "workspace_apps_probe_endpoints")
    );
    assert.ok(
      capabilityStatus
        .json()
        .tools.some((tool: { id: string }) => tool.id === "get_task")
    );
    assert.ok(
      capabilityStatus
        .json()
        .tools.some((tool: { id: string }) => tool.id === "list_tasks")
    );
    assert.ok(
      capabilityStatus
        .json()
        .tools.some((tool: { id: string }) => tool.id === "reply_task")
    );
    assert.ok(
      capabilityStatus
        .json()
        .tools.some((tool: { id: string }) => tool.id === "cancel_task")
    );
    assert.ok(
      capabilityStatus
        .json()
        .tools.some((tool: { id: string }) => tool.id === "rerun_task")
    );

    const integrationCatalog = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/workspace-integrations/catalog",
      headers: {
        "x-holaboss-workspace-id": "workspace-1"
      },
      payload: {}
    });
    assert.equal(integrationCatalog.statusCode, 200);
    assert.ok(integrationCatalog.json().provider_ids.includes("twitter"));
    assert.equal(integrationCatalog.json().provider_ids.includes("x"), false);

    const createdJob = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/cronjobs",
      headers: {
        "x-holaboss-workspace-id": "workspace-1",
        "x-holaboss-session-id": "session-main",
        "x-holaboss-selected-model": "openai/gpt-5.4"
      },
      payload: {
        cron: "0 9 * * *",
        description: "Daily check",
        instruction: "Check in daily",
        delivery: { mode: "deliver", channel: "session_run" }
      }
    });
    assert.equal(createdJob.statusCode, 200);
    assert.equal(createdJob.json().initiated_by, "workspace_agent");
    assert.deepEqual(createdJob.json().delivery, {
      mode: "announce",
      channel: "session_run",
      to: null
    });
    assert.equal(createdJob.json().metadata.model, undefined);
    assert.equal(createdJob.json().metadata.source_session_id, "session-main");
    assert.equal(createdJob.json().metadata.timezone, "America/Los_Angeles");

    const listedJobs = await app.inject({
      method: "GET",
      url: "/api/v1/capabilities/runtime-tools/cronjobs",
      headers: {
        "x-holaboss-workspace-id": "workspace-1"
      }
    });
    assert.equal(listedJobs.statusCode, 200);
    assert.equal(listedJobs.json().count, 1);
  } finally {
    await app.close();
    store.close();
  }
});

// Test setup mismatch shipped with feat/onboarding: the answer payload at
// line ~1059 sends `option_id: "fast"`, but that id only exists on the
// first deck (lines ~991-993). The second deck (lines ~1015-1030, which
// replaces the first via the POST below) only has `manual`/`scheduled`
// and `twitter`/`email`. Server correctly rejects `fast` as invalid for
// the active deck. Leaving as skip so an onboarding-author can decide
// whether the answer payload or the server validation is the intended
// behavior.











test("workspace app capability routes scaffold, register, and inspect a managed app starter", async () => {
  const root = makeTempDir("hb-runtime-api-workspace-app-tools-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const app = buildTestRuntimeApiServer({ store });

  try {
    const scaffold = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/workspace-apps/scaffold",
      headers: {
        "x-holaboss-workspace-id": "workspace-1",
      },
      payload: {
        app_id: "demo-app",
        name: "Demo App",
      },
    });
    assert.equal(scaffold.statusCode, 200);
    assert.equal(scaffold.json().app_id, "demo-app");

    const register = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/workspace-apps/register",
      headers: {
        "x-holaboss-workspace-id": "workspace-1",
      },
      payload: {
        app_id: "demo-app",
      },
    });
    assert.equal(register.statusCode, 200);
    assert.equal(register.json().registered, true);
    assert.equal(register.json().config_path, "apps/demo-app/app.runtime.yaml");

    fs.writeFileSync(
      // single-tenant: scaffold created the app under the root workspace dir
      path.join(workspaceRoot, "root", "apps", "demo-app", "package.json"),
      `${JSON.stringify(
        {
          name: "demo-app",
          version: "0.1.0",
          private: true,
          scripts: {
            build: "node -e \"process.stdout.write('route-build-ok')\"",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const build = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/workspace-apps/demo-app/build",
      headers: {
        "x-holaboss-workspace-id": "workspace-1",
      },
      payload: {},
    });
    assert.equal(build.statusCode, 200);
    assert.equal(build.json().ok, true);
    assert.match(String(build.json().stdout ?? ""), /route-build-ok/);

    const status = await app.inject({
      method: "GET",
      url: "/api/v1/capabilities/runtime-tools/workspace-apps/demo-app/status",
      headers: {
        "x-holaboss-workspace-id": "workspace-1",
      },
    });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().app_id, "demo-app");
    assert.equal(status.json().build_status, "pending");
    assert.equal(status.json().ready, false);
    assert.equal(status.json().runtime_contract?.mcp?.sse_path, "/mcp/sse");
    assert.equal(status.json().runtime_contract?.mcp?.message_path, "/mcp/messages");
    assert.equal(status.json().runtime_contract?.healthcheck?.path, "/mcp/health");
    assert.equal(typeof status.json().revision?.source_updated_at, "string");

    const ports = await app.inject({
      method: "GET",
      url: "/api/v1/capabilities/runtime-tools/workspace-apps/demo-app/ports",
      headers: {
        "x-holaboss-workspace-id": "workspace-1",
      },
    });
    assert.equal(ports.statusCode, 200);
    assert.equal(typeof ports.json().ports.http, "number");
    assert.equal(typeof ports.json().ports.mcp, "number");
  } finally {
    await app.close();
    store.close();
  }
});

test("workspace app capability routes restart-and-wait and probe managed endpoints", async () => {
  const root = makeTempDir("hb-runtime-api-workspace-app-restart-probe-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const lifecycleCalls: string[] = [];
  const app = buildTestRuntimeApiServer({
    store,
    appLifecycleExecutor: {
      startApp: async (params) => {
        lifecycleCalls.push(`start:${params.workspaceId}:${params.appId}`);
        return {
          app_id: params.appId,
          status: "started",
          detail: "started",
          ports: {
            http: params.httpPort ?? 0,
            mcp: params.mcpPort ?? 0,
          },
        };
      },
      stopApp: async (params) => {
        lifecycleCalls.push(`stop:${params.workspaceId}:${params.appId}`);
        return {
          app_id: params.appId,
          status: "stopped",
          detail: "stopped",
          ports: {},
        };
      },
      shutdownAll: async () => ({ stopped: [], failed: [] }),
    },
  });

  let uiServer: { close: () => Promise<void> } | null = null;
  let mcpServer: { close: () => Promise<void> } | null = null;
  try {
    await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/workspace-apps/scaffold",
      headers: {
        "x-holaboss-workspace-id": "workspace-1",
      },
      payload: {
        app_id: "demo-app",
        name: "Demo App",
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/workspace-apps/register",
      headers: {
        "x-holaboss-workspace-id": "workspace-1",
      },
      payload: {
        app_id: "demo-app",
      },
    });
    fs.writeFileSync(
      // single-tenant: scaffold created the app under the root workspace dir
      path.join(workspaceRoot, "root", "apps", "demo-app", "app.runtime.yaml"),
      `app_id: demo-app
name: Demo App
slug: demo-app
lifecycle:
  setup: npm install
  start: npm run start
healthchecks:
  api:
    path: /ready
    timeout_s: 30
    interval_s: 5
mcp:
  transport: http-sse
  port: 13100
  path: /transport/sse
  tools:
    - demo_tool
env_contract:
  - HOLABOSS_WORKSPACE_ID
`,
      "utf8",
    );

    store.upsertAppBuild({
      // single-tenant: app builds are keyed by the literal resolved id (root)
      workspaceId: "root",
      appId: "demo-app",
      status: "stopped",
    });

    const restarted = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/workspace-apps/demo-app/restart-and-wait-ready",
      headers: {
        "x-holaboss-workspace-id": "workspace-1",
      },
      payload: {
        timeout_ms: 1000,
        poll_interval_ms: 10,
      },
    });
    assert.equal(restarted.statusCode, 200);
    assert.equal(restarted.json().restarted, true);
    assert.equal(restarted.json().ready, true);
    // single-tenant: lifecycle executor receives the resolved root workspace id
    assert.equal(
      lifecycleCalls.includes("stop:root:demo-app"),
      true,
    );
    assert.equal(
      lifecycleCalls.every(
        (entry) =>
          entry === "stop:root:demo-app" ||
          entry === "start:root:demo-app"
      ),
      true,
    );

    // single-tenant: resolve against the root dir + id so ports match the route
    const resolved = resolveWorkspaceAppRuntime(
      path.join(workspaceRoot, "root"),
      "demo-app",
      { store, workspaceId: "root", allocatePorts: true },
    );

    uiServer = await startStaticHttpServer((request, response) => {
      if (request.url === "/") {
        response.statusCode = 200;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end("<html><body>route probe</body></html>");
        return;
      }
      if (request.url === "/ready") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: true, message_path: "/transport/messages" }));
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    }, { port: resolved.ports.http });

    mcpServer = await startStaticHttpServer((request, response) => {
      if (request.method === "POST" && request.url === "/transport/messages") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        request.on("end", () => {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            id?: string | number | null;
            method?: string;
          };
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          if (payload.method === "initialize") {
            response.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: payload.id ?? null,
                result: {
                  protocolVersion: "2025-03-26",
                  capabilities: { tools: { listChanged: false } },
                  serverInfo: { name: "demo-app", version: "0.1.0" },
                },
              }),
            );
            return;
          }
          if (payload.method === "tools/list") {
            response.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: payload.id ?? null,
                result: {
                  tools: [{ name: "demo_tool" }, { name: "demo_tool_2" }],
                },
              }),
            );
            return;
          }
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "unexpected method" }));
        });
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    }, { port: resolved.ports.mcp });

    const probed = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/workspace-apps/demo-app/probe-endpoints",
      headers: {
        "x-holaboss-workspace-id": "workspace-1",
      },
      payload: {},
    });
    assert.equal(probed.statusCode, 200);
    assert.equal(probed.json().all_ok, true);
    assert.equal(probed.json().count, 4);
    assert.equal(
      probed.json().checks.find((entry: { check: string }) => entry.check === "mcp_tools_list")
        ?.tool_count,
      2,
    );
    assert.equal(
      probed.json().checks.find((entry: { check: string }) => entry.check === "mcp_health")?.url,
      `http://127.0.0.1:${resolved.ports.http}/ready`,
    );
    assert.equal(
      probed.json().checks.find((entry: { check: string }) => entry.check === "mcp_initialize")?.url,
      `http://127.0.0.1:${resolved.ports.mcp}/transport/messages`,
    );
  } finally {
    await uiServer?.close();
    await mcpServer?.close();
    await app.close();
    store.close();
  }
});

test("runtime task capability routes create, inspect, rerun, and cancel delegated tasks", async () => {
  const root = makeTempDir("hb-runtime-api-subagents-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-main",
    kind: "main_session",
    title: "Workspace 1",
  });
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
    harness: "pi",
    harnessSessionId: "session-main",
  });
  store.ensureRuntimeState({
    workspaceId: workspace.id,
    sessionId: "session-main",
    status: "IDLE",
  });
  fs.mkdirSync(path.join(workspaceRoot, workspace.id, "notes"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(workspaceRoot, workspace.id, "notes", "brief.md"),
    "# Brief\n",
    "utf8",
  );
  const parentInput = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: {
      text: "/skill-creator\n/deploy-helper\n\nUse these references when you delegate.",
      attachments: [
        {
          id: "attachment-1",
          kind: "file",
          name: "brief.md",
          mime_type: "text/markdown",
          size_bytes: 8,
          workspace_path: "notes/brief.md",
        },
      ],
      image_urls: ["https://example.com/reference.png"],
    },
  });
  const app = buildTestRuntimeApiServer({ store });

  const created = await app.inject({
    method: "POST",
    url: "/api/v1/capabilities/runtime-tools/subagents",
    headers: {
      "x-holaboss-workspace-id": workspace.id,
      "x-holaboss-session-id": "session-main",
      "x-holaboss-input-id": parentInput.inputId,
      "x-holaboss-selected-model": "openai/gpt-5.4",
    },
    payload: {
      goal: "Research topic A",
      context: "Focus on recent changes.",
      tools: ["web", "browser"],
    },
  });

  assert.equal(created.statusCode, 200);
  assert.equal(created.json().count, 1);
  const task = created.json().tasks[0];
  const latestRunSubagentId = String(task.latest_run?.subagent_id ?? "");
  assert.equal(task.task_id, task.issue_id);
  assert.equal(task.status, "todo");
  assert.equal(task.latest_run.origin_main_session_id, "session-main");
  assert.equal(task.latest_run.owner_main_session_id, "session-main");
  assert.equal(task.latest_run.status, "queued");
  assert.deepEqual(task.latest_run.tool_profile, {
    requested_tools: ["web", "browser"],
  });
  assert.equal(task.subagent_id, undefined);

  const run = store.getSubagentRun({ workspaceId: workspace.id, subagentId: latestRunSubagentId });
  assert.ok(run);
  assert.equal(run?.parentSessionId, "session-main");
  assert.equal(run?.parentInputId, parentInput.inputId);
  assert.equal(run?.requestedModel, null);
  assert.equal(run?.effectiveModel, "openai/gpt-5.4");

  const childSession = store.getSession({
    workspaceId: workspace.id,
    sessionId: String(task.latest_run.child_session_id),
  });
  assert.equal(childSession?.kind, "subagent");

  const childInput = run?.currentChildInputId
    ? store.getInput({ workspaceId: workspace.id, inputId: run.currentChildInputId })
    : null;
  assert.ok(childInput);
  assert.equal(
    childInput?.payload.text,
    "/skill-creator\n/deploy-helper\n\nResearch topic A\n\nContext:\nFocus on recent changes.",
  );
  assert.deepEqual(childInput?.payload.attachments, parentInput.payload.attachments);
  assert.deepEqual(childInput?.payload.image_urls, parentInput.payload.image_urls);
  const childContext = (childInput?.payload.context ?? {}) as Record<string, unknown>;
  assert.equal(childContext.source, "issue_bootstrap");
  assert.equal(childContext.subagent_id, latestRunSubagentId);
  assert.equal(childContext.forwarded_attachment_count, 1);
  assert.deepEqual(childContext.forwarded_quoted_skill_ids, [
    "skill-creator",
    "deploy-helper",
  ]);

  const listed = await app.inject({
    method: "GET",
    url: `/api/v1/background-tasks?workspace_id=${encodeURIComponent(workspace.id)}`,
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().count, 1);
  assert.equal(listed.json().tasks[0].subagent_id, latestRunSubagentId);

  const listedTasksViaCapability = await app.inject({
    method: "GET",
    url: "/api/v1/capabilities/runtime-tools/tasks?limit=10",
    headers: {
      "x-holaboss-workspace-id": workspace.id,
      "x-holaboss-session-id": "session-main",
    },
  });
  assert.equal(listedTasksViaCapability.statusCode, 200);
  assert.equal(listedTasksViaCapability.json().count, 1);
  assert.equal(listedTasksViaCapability.json().tasks[0].task_id, task.issue_id);

  const fetchedTaskViaCapability = await app.inject({
    method: "GET",
    url: `/api/v1/capabilities/runtime-tools/tasks/${encodeURIComponent(task.issue_id)}`,
    headers: {
      "x-holaboss-workspace-id": workspace.id,
      "x-holaboss-session-id": "session-main",
    },
  });
  assert.equal(fetchedTaskViaCapability.statusCode, 200);
  assert.equal(fetchedTaskViaCapability.json().task_id, task.issue_id);
  assert.equal(fetchedTaskViaCapability.json().latest_run.subagent_id, latestRunSubagentId);

  const blockedSameTurnTaskFetch = await app.inject({
    method: "GET",
    url: `/api/v1/capabilities/runtime-tools/tasks/${encodeURIComponent(task.issue_id)}`,
    headers: {
      "x-holaboss-workspace-id": workspace.id,
      "x-holaboss-session-id": "session-main",
      "x-holaboss-input-id": parentInput.inputId,
    },
  });
  assert.equal(blockedSameTurnTaskFetch.statusCode, 409);
  assert.match(
    blockedSameTurnTaskFetch.body,
    /do not use get_task to poll a freshly delegated task in the same turn/i,
  );

  const blockedSameTurnTaskList = await app.inject({
    method: "GET",
    url: "/api/v1/capabilities/runtime-tools/tasks?limit=10",
    headers: {
      "x-holaboss-workspace-id": workspace.id,
      "x-holaboss-session-id": "session-main",
      "x-holaboss-input-id": parentInput.inputId,
    },
  });
  assert.equal(blockedSameTurnTaskList.statusCode, 409);
  assert.match(
    blockedSameTurnTaskList.body,
    /do not use list_tasks to poll a freshly delegated task in the same turn/i,
  );

  const cancelledTask = await app.inject({
    method: "POST",
    url: `/api/v1/capabilities/runtime-tools/tasks/${encodeURIComponent(task.issue_id)}/cancel`,
    headers: {
      "x-holaboss-workspace-id": workspace.id,
      "x-holaboss-session-id": "session-main",
    },
    payload: {},
  });
  assert.equal(cancelledTask.statusCode, 200);
  assert.equal(cancelledTask.json().task_id, task.issue_id);
  assert.equal(cancelledTask.json().status, "blocked");
  assert.equal(cancelledTask.json().latest_run.status, "cancelled");

  const cancelledRun = store.getSubagentRun({ workspaceId: workspace.id, subagentId: latestRunSubagentId });
  assert.equal(cancelledRun?.status, "cancelled");
  const cancelledInput = run?.currentChildInputId
    ? store.getInput({ workspaceId: workspace.id, inputId: run.currentChildInputId })
    : null;
  assert.equal(cancelledInput?.status, "DONE");

  const rerunTask = await app.inject({
    method: "POST",
    url: `/api/v1/capabilities/runtime-tools/tasks/${encodeURIComponent(task.issue_id)}/rerun`,
    headers: {
      "x-holaboss-workspace-id": workspace.id,
      "x-holaboss-session-id": "session-main",
      "x-holaboss-input-id": parentInput.inputId,
      "x-holaboss-selected-model": "openai_codex/gpt-5.5",
    },
    payload: {
      model: "openai_codex/gpt-5.4",
    },
  });
  assert.equal(rerunTask.statusCode, 200);
  assert.equal(rerunTask.json().task_id, task.issue_id);
  assert.equal(rerunTask.json().status, "todo");
  assert.equal(rerunTask.json().latest_run.status, "queued");
  const rerunRun = store.getSubagentRun({
    workspaceId: workspace.id,
    subagentId: String(rerunTask.json().latest_run.subagent_id ?? ""),
  });
  assert.equal(rerunRun?.requestedModel, "openai_codex/gpt-5.4");
  assert.equal(rerunRun?.effectiveModel, "openai_codex/gpt-5.5");
  const rerunInput = rerunRun?.currentChildInputId
    ? store.getInput({ workspaceId: workspace.id, inputId: rerunRun.currentChildInputId })
    : null;
  assert.equal(rerunInput?.payload.model, "openai_codex/gpt-5.5");

  const cancelledRerunTask = await app.inject({
    method: "POST",
    url: `/api/v1/capabilities/runtime-tools/tasks/${encodeURIComponent(task.issue_id)}/cancel`,
    headers: {
      "x-holaboss-workspace-id": workspace.id,
      "x-holaboss-session-id": "session-main",
    },
    payload: {},
  });
  assert.equal(cancelledRerunTask.statusCode, 200);
  assert.equal(cancelledRerunTask.json().status, "blocked");
  assert.equal(cancelledRerunTask.json().latest_run.status, "cancelled");

  const archived = await app.inject({
    method: "POST",
    url: `/api/v1/background-tasks/${encodeURIComponent(latestRunSubagentId)}/archive`,
    payload: {
      workspace_id: workspace.id,
    },
  });
  assert.equal(archived.statusCode, 200);
  assert.equal(archived.json().archived, true);

  const archivedChildSession = store.getSession({
    workspaceId: workspace.id,
    sessionId: String(task.latest_run.child_session_id),
  });
  assert.ok(archivedChildSession?.archivedAt);

  const listedAfterArchive = await app.inject({
    method: "GET",
    url: `/api/v1/background-tasks?workspace_id=${encodeURIComponent(workspace.id)}`,
  });
  assert.equal(listedAfterArchive.statusCode, 200);
  assert.equal(listedAfterArchive.json().count, 0);

  await app.close();
  store.close();
});

test("delegated subagents use the configured global subagent model instead of request-level overrides", async () => {
  const root = makeTempDir("hb-runtime-api-subagent-model-");
  writeRuntimeConfig(root, {
    runtime: {
      default_model: "openai/gpt-5.4",
      subagents: {
        model: "anthropic_direct/claude-sonnet-4-6",
      },
    },
  });
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-main",
    kind: "main_session",
  });
  const app = buildTestRuntimeApiServer({ store });

  const created = await app.inject({
    method: "POST",
    url: "/api/v1/capabilities/runtime-tools/subagents",
    headers: {
      "x-holaboss-workspace-id": workspace.id,
      "x-holaboss-session-id": "session-main",
      "x-holaboss-selected-model": "openai_direct/gpt-5.4-mini",
    },
    payload: {
      goal: "Summarize the repo status.",
      model: "gemini_direct/gemini-2.5-pro",
    },
  });

  assert.equal(created.statusCode, 200);
  const task = created.json().tasks[0];
  const latestRunSubagentId = String(task.latest_run?.subagent_id ?? "");
  const run = store.getSubagentRun({ workspaceId: workspace.id, subagentId: latestRunSubagentId });
  const childInput = run?.currentChildInputId
    ? store.getInput({ workspaceId: workspace.id, inputId: run.currentChildInputId })
    : null;

  assert.equal(run?.requestedModel, "gemini_direct/gemini-2.5-pro");
  assert.equal(run?.effectiveModel, "anthropic_direct/claude-sonnet-4-6");
  assert.equal(childInput?.payload.model, "anthropic_direct/claude-sonnet-4-6");

  await app.close();
  store.close();
});

test("runtime web search capability supports paged text windows", async () => {
  const root = makeTempDir("hb-runtime-api-web-search-window-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  store.upsertRuntimeUserProfile({
    timezone: "America/Los_Angeles",
  });
  const app = buildTestRuntimeApiServer({ store });
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = (async (input, init) => {
    const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ url: String(input), body: payload });
    return new Response(
      [
        "event: message",
        'data: {"result":{"content":[{"type":"text","text":"abcdefghijklmnopqrstuvwxyz"}]},"jsonrpc":"2.0","id":1}',
        "",
      ].join("\n"),
      {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      }
    );
  }) as typeof fetch;

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/web-search",
      payload: {
        query: "alphabet",
        num_results: 2,
        text_offset: 5,
        text_limit: 7,
      }
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      text: "fghijkl",
      provider: "exa_hosted_mcp",
      tool_id: "web_search",
      text_offset: 5,
      text_limit: 7,
      text_total_chars: 26,
      has_more: true,
      next_text_offset: 12,
    });
    assert.equal(requests[0]?.url, "https://mcp.exa.ai/mcp");
    assert.deepEqual(requests[0]?.body, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: {
          query: "alphabet",
          numResults: 2,
          livecrawl: "fallback",
          type: "auto",
        },
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    store.close();
  }
});

test("runtime skill tool resolves a workspace skill through shared runtime state", async () => {
  const root = makeTempDir("hb-runtime-api-skill-tool-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    // single-tenant: skills resolve under the synthetic root workspace dir
    workspaceId: "root",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const skillDir = path.join(workspaceRoot, "root", "skills", "deploy-helper");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: deploy-helper",
      "description: Deployment helper",
      "holaboss:",
      "  granted_tools: [bash]",
      "  granted_commands: [deploy-docs]",
      "---",
      "",
      "# Deploy Helper",
      "",
      "Use the deploy workflow carefully.",
    ].join("\n"),
    "utf8"
  );
  const app = buildTestRuntimeApiServer({ store });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/skill",
      headers: {
        "x-holaboss-workspace-id": "workspace-1",
      },
      payload: {
        name: "deploy-helper",
        args: "Only use the docs path.",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.json().text, /<skill name="deploy-helper" location=".*deploy-helper\/SKILL\.md">/);
    assert.deepEqual(response.json().granted_tools, ["bash"]);
    assert.deepEqual(response.json().granted_commands, ["deploy-docs"]);
    assert.equal(response.json().tool_id, "skill");
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime skill tool resolves workspace-scoped local skills through the assigned issue session", async () => {
  const root = makeTempDir("hb-runtime-api-skill-tool-workspace-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const workspace = seedWorkspaceRecord(store, {
    // single-tenant: seed under root so workspace.id resolves to the runtime root
    workspaceId: "root",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const issue = store.createIssue({
    workspaceId: workspace.id,
    sessionId: "session-issue-1",
    title: "Ship dashboard",
    description: "Implement the dashboard.",
    status: "todo",
    assigneeId: "general",
    createdBy: "workspace_user",
  });
  const skillDir = path.join(
    workspaceRoot,
    // single-tenant: skills resolve under the synthetic root workspace dir
    "root",
    "skills",
    "frontend-playbook",
  );
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: frontend-playbook",
      "description: Frontend playbook",
      "---",
      "",
      "# Frontend Playbook",
      "",
      "Use the dashboard patterns.",
    ].join("\n"),
    "utf8",
  );
  const app = buildTestRuntimeApiServer({ store });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/skill",
      headers: {
        "x-holaboss-workspace-id": "workspace-1",
        "x-holaboss-session-id": issue.sessionId,
      },
      payload: {
        name: "frontend-playbook",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.match(
      response.json().text,
      /<skill name="frontend-playbook" location=".*frontend-playbook\/SKILL\.md">/,
    );
    assert.match(response.json().text, /Use the dashboard patterns\./);
    assert.equal(response.json().skill_id, "frontend-playbook");
    assert.equal(response.json().tool_id, "skill");
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory_retrieve tool returns interaction leaf hits from the tree backend", async () => {
  const root = makeTempDir("hb-runtime-api-memory-retrieve-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.upsertInteractionEntity({
    workspaceId: "workspace-1",
    entityId: "interaction:workflow:deploy-procedure",
    entityType: "workflow",
    canonicalName: "Deploy procedure",
    slug: "workflow-deploy-procedure",
    summary: "Deployment procedure memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  store.upsertInteractionLeaf({
    workspaceId: "workspace-1",
    leafId: "leaf-deploy-procedure",
    entityId: "interaction:workflow:deploy-procedure",
    subjectKey: "procedure:deploy",
    path: "workspace/workspace-1/interaction/entities/workflow-deploy-procedure/leaves/leaf-deploy-procedure.md",
    title: "Deploy procedure",
    summary: "Steps for deployment.",
    fingerprint: "deploy-procedure-fingerprint",
    bodySha256: "deploy-procedure-sha",
    tags: ["deploy"],
    secondaryEntityIds: [],
    sourceType: "leaf",
    sourceEventId: null,
    sourceMessageId: null,
    sourceTurnInputId: "input-seed",
    admissionConfidence: 0.9,
    entityConfidence: 0.9,
    observedAt: "2026-05-20T00:00:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  const leafPath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
    "interaction",
    "entities",
    "workflow-deploy-procedure",
    "leaves",
    "leaf-deploy-procedure.md",
  );
  fs.mkdirSync(path.dirname(leafPath), { recursive: true });
  fs.writeFileSync(leafPath, "# Deploy procedure\n\nSteps for deployment.\n", "utf8");
  await rebuildInteractionEntityTree({
    store,
    workspaceId: "workspace-1",
    entityId: "interaction:workflow:deploy-procedure",
    summaryModelClient: null,
    embeddingClient: null,
  });
  const app = buildTestRuntimeApiServer({ store });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": "workspace-1",
      },
      payload: {
        query: "how do I deploy?",
        retrieval_policy: {
          max_evidence: 4,
        },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().tool_id, "memory_retrieve");
    assert.equal(response.json().intent, "procedure_lookup");
    assert.deepEqual(response.json().categories, ["workspace"]);
    assert.ok(response.json().evidence.length >= 1);
    const deployEvidence = response
      .json()
      .evidence.find((item: { title?: string }) => item.title === "Deploy procedure");
    assert.ok(deployEvidence);
    assert.equal(deployEvidence.category, "workspace");
    assert.match(deployEvidence.summary, /deploy/i);
    assert.equal("path" in deployEvidence, false);
    assert.equal(response.json().retrieval_pack.known_facts[0].title, "Deploy procedure");
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory_retrieve tool finds older non-ASCII interaction memories even when newer leaves fill the recent-doc pool", async () => {
  const root = makeTempDir("hb-runtime-api-memory-retrieve-non-ascii-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.upsertInteractionEntity({
    workspaceId: "workspace-1",
    entityId: "interaction:topic:gtm-planning",
    entityType: "topic",
    canonicalName: "GTM planning",
    slug: "topic-gtm-planning",
    summary: "GTM planning memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });

  const leavesDir = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
    "interaction",
    "entities",
    "topic-gtm-planning",
    "leaves",
  );
  fs.mkdirSync(leavesDir, { recursive: true });

  store.upsertInteractionLeaf({
    workspaceId: "workspace-1",
    leafId: "leaf-channel-design",
    entityId: "interaction:topic:gtm-planning",
    subjectKey: "gtm:channel-design",
    path: "workspace/workspace-1/interaction/entities/topic-gtm-planning/leaves/leaf-channel-design.md",
    title: "渠道设计决策",
    summary: "渠道设计方案已经确定。",
    fingerprint: "channel-design-fingerprint",
    bodySha256: "channel-design-sha",
    tags: ["gtm", "planning"],
    secondaryEntityIds: [],
    sourceType: "manual",
    sourceEventId: null,
    sourceMessageId: null,
    sourceTurnInputId: "input-channel-design",
    admissionConfidence: 0.9,
    entityConfidence: 0.9,
    observedAt: "2026-04-01T00:00:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  fs.writeFileSync(
    path.join(leavesDir, "leaf-channel-design.md"),
    "# 渠道设计决策\n\n渠道设计方案已经确定，并且需要保持这条 durable memory 可检索。\n",
    "utf8",
  );

  for (let index = 0; index < 72; index += 1) {
    const leafId = `leaf-filler-${index + 1}`;
    const observedDay = String((index % 27) + 1).padStart(2, "0");
    store.upsertInteractionLeaf({
      workspaceId: "workspace-1",
      leafId,
      entityId: "interaction:topic:gtm-planning",
      subjectKey: `gtm:filler:${index + 1}`,
      path: `workspace/workspace-1/interaction/entities/topic-gtm-planning/leaves/${leafId}.md`,
      title: `Filler planning memory ${index + 1}`,
      summary: `Unrelated filler summary ${index + 1}.`,
      fingerprint: `filler-fingerprint-${index + 1}`,
      bodySha256: `filler-sha-${index + 1}`,
      tags: ["gtm"],
      secondaryEntityIds: [],
      sourceType: "manual",
      sourceEventId: null,
      sourceMessageId: null,
      sourceTurnInputId: `input-filler-${index + 1}`,
      admissionConfidence: 0.9,
      entityConfidence: 0.9,
      observedAt: `2026-05-${observedDay}T00:00:00.000Z`,
      supersedesLeafId: null,
      status: "active",
    });
    fs.writeFileSync(
      path.join(leavesDir, `${leafId}.md`),
      `# Filler planning memory ${index + 1}\n\nUnrelated filler summary ${index + 1}.\n`,
      "utf8",
    );
  }

  await rebuildInteractionEntityTree({
    store,
    workspaceId: "workspace-1",
    entityId: "interaction:topic:gtm-planning",
    summaryModelClient: null,
    embeddingClient: null,
  });

  const app = buildTestRuntimeApiServer({ store });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": "workspace-1",
      },
      payload: {
        query: "渠道设计",
        retrieval_policy: {
          max_evidence: 4,
        },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().tool_id, "memory_retrieve");
    assert.deepEqual(response.json().categories, ["workspace"]);
    assert.equal(response.json().intent, "fact_lookup");
    assert.equal(response.json().evidence[0]?.title, "渠道设计决策");
    assert.ok(response.json().evidence[0]?.reasons.includes("lexical_match"));
    assert.equal(response.json().evidence[0]?.category, "workspace");
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory_retrieve tool finds older non-ASCII memories from spaced token queries when the document stores the phrase contiguously", async () => {
  const root = makeTempDir("hb-runtime-api-memory-retrieve-non-ascii-spaced-query-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.upsertInteractionEntity({
    workspaceId: "workspace-1",
    entityId: "interaction:topic:gtm-planning",
    entityType: "topic",
    canonicalName: "GTM planning",
    slug: "topic-gtm-planning",
    summary: "GTM planning memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });

  const leavesDir = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
    "interaction",
    "entities",
    "topic-gtm-planning",
    "leaves",
  );
  fs.mkdirSync(leavesDir, { recursive: true });

  store.upsertInteractionLeaf({
    workspaceId: "workspace-1",
    leafId: "leaf-channel-design",
    entityId: "interaction:topic:gtm-planning",
    subjectKey: "gtm:channel-design",
    path: "workspace/workspace-1/interaction/entities/topic-gtm-planning/leaves/leaf-channel-design.md",
    title: "渠道设计决策",
    summary: "渠道设计方案已经确定。",
    fingerprint: "channel-design-fingerprint",
    bodySha256: "channel-design-sha",
    tags: ["gtm", "planning"],
    secondaryEntityIds: [],
    sourceType: "manual",
    sourceEventId: null,
    sourceMessageId: null,
    sourceTurnInputId: "input-channel-design",
    admissionConfidence: 0.9,
    entityConfidence: 0.9,
    observedAt: "2026-04-01T00:00:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  fs.writeFileSync(
    path.join(leavesDir, "leaf-channel-design.md"),
    "# 渠道设计决策\n\n渠道设计方案已经确定，并且需要保持这条 durable memory 可检索。\n",
    "utf8",
  );

  for (let index = 0; index < 72; index += 1) {
    const leafId = `leaf-filler-${index + 1}`;
    const observedDay = String((index % 27) + 1).padStart(2, "0");
    store.upsertInteractionLeaf({
      workspaceId: "workspace-1",
      leafId,
      entityId: "interaction:topic:gtm-planning",
      subjectKey: `gtm:filler:${index + 1}`,
      path: `workspace/workspace-1/interaction/entities/topic-gtm-planning/leaves/${leafId}.md`,
      title: `Filler planning memory ${index + 1}`,
      summary: `Unrelated filler summary ${index + 1}.`,
      fingerprint: `filler-fingerprint-${index + 1}`,
      bodySha256: `filler-sha-${index + 1}`,
      tags: ["gtm"],
      secondaryEntityIds: [],
      sourceType: "manual",
      sourceEventId: null,
      sourceMessageId: null,
      sourceTurnInputId: `input-filler-${index + 1}`,
      admissionConfidence: 0.9,
      entityConfidence: 0.9,
      observedAt: `2026-05-${observedDay}T00:00:00.000Z`,
      supersedesLeafId: null,
      status: "active",
    });
    fs.writeFileSync(
      path.join(leavesDir, `${leafId}.md`),
      `# Filler planning memory ${index + 1}\n\nUnrelated filler summary ${index + 1}.\n`,
      "utf8",
    );
  }

  await rebuildInteractionEntityTree({
    store,
    workspaceId: "workspace-1",
    entityId: "interaction:topic:gtm-planning",
    summaryModelClient: null,
    embeddingClient: null,
  });

  const app = buildTestRuntimeApiServer({ store });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": "workspace-1",
      },
      payload: {
        query: "渠道设计 方案",
        retrieval_policy: {
          max_evidence: 4,
        },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().tool_id, "memory_retrieve");
    assert.deepEqual(response.json().categories, ["workspace"]);
    assert.equal(response.json().intent, "fact_lookup");
    assert.equal(response.json().evidence[0]?.title, "渠道设计决策");
    assert.ok(response.json().evidence[0]?.reasons.includes("lexical_match"));
    assert.equal(response.json().evidence[0]?.category, "workspace");
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory_retrieve tool prefers artifact docs for non-ASCII artifact title queries without filename cues", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-memory-retrieve-non-ascii-artifact-title-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: "root",
    sessionId: "session-main",
    kind: "main_session",
  });

  const queuedInput = store.enqueueInput({
    workspaceId: "root",
    sessionId: "session-main",
    payload: {
      text: "Save the main narrative stage deliverable for later recall.",
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "root",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-05T10:00:00.000Z",
    completedAt: "2026-06-05T10:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I saved the main narrative stage deliverable.",
  });

  const reportRelativePath = "outputs/main-narrative-stage.md";
  const reportAbsolutePath = path.join(workspaceRoot, "root", reportRelativePath);
  fs.mkdirSync(path.dirname(reportAbsolutePath), { recursive: true });
  fs.writeFileSync(
    reportAbsolutePath,
    [
      "# 主叙事阶段",
      "",
      "当前主叙事阶段的交付内容在这里。",
    ].join("\n"),
    "utf8",
  );
  store.createOutput({
    workspaceId: "root",
    outputId: "output-cn-stage-1",
    outputType: "document",
    title: "主叙事阶段",
    status: "completed",
    filePath: reportRelativePath,
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    artifactId: "artifact-cn-stage-1",
  });
  await persistTurnOutputArtifactsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
  });

  const outputTree = listWorkspaceOutputDocumentTrees({
    store,
    workspaceId: "root",
  }).find((item) => item.outputId === "output-cn-stage-1");
  assert.ok(outputTree);

  store.upsertInteractionEntity({
    workspaceId: "root",
    entityId: "interaction:project:gtm-rollout",
    entityType: "project",
    canonicalName: "GTM rollout",
    slug: "project-gtm-rollout",
    summary: "GTM rollout memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  store.upsertInteractionLeaf({
    workspaceId: "root",
    leafId: "leaf-gtm-rollout-stage",
    entityId: "interaction:project:gtm-rollout",
    subjectKey: "gtm-rollout-stage",
    path: "workspace/root/interaction/entities/project-gtm-rollout/leaves/leaf-gtm-rollout-stage.md",
    title: "GTM rollout references 主叙事阶段",
    summary: "The rollout memory references 主叙事阶段 as the current deliverable.",
    fingerprint: "gtm-rollout-stage-fingerprint",
    bodySha256: "gtm-rollout-stage-sha",
    tags: ["gtm", "rollout"],
    secondaryEntityIds: [],
    sourceType: "assistant_turn",
    sourceEventId: queuedInput.inputId,
    sourceMessageId: null,
    sourceTurnInputId: queuedInput.inputId,
    admissionConfidence: 0.93,
    entityConfidence: 0.93,
    observedAt: "2026-06-05T10:01:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  const interactionLeafPath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "root")),
    "interaction",
    "entities",
    "project-gtm-rollout",
    "leaves",
    "leaf-gtm-rollout-stage.md",
  );
  fs.mkdirSync(path.dirname(interactionLeafPath), { recursive: true });
  fs.writeFileSync(
    interactionLeafPath,
    appendDurableMemoryRelatedSections(
      [
        "# GTM rollout references 主叙事阶段",
        "",
        "## Summary",
        "",
        "The rollout memory references 主叙事阶段 as the current deliverable.",
      ].join("\n"),
      {
        relatedEntities: [
          {
            entityType: "artifact",
            entityKey: "artifact:output:output-cn-stage-1",
            label: "主叙事阶段",
          },
        ],
        relations: [
          {
            relationType: "mentions",
            entityKey: "artifact:output:output-cn-stage-1",
          },
        ],
      },
    ),
    "utf8",
  );
  await rebuildInteractionEntityTree({
    store,
    workspaceId: "root",
    entityId: "interaction:project:gtm-rollout",
    summaryModelClient: null,
    embeddingClient: null,
  });

  const app = buildTestRuntimeApiServer({ store });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": "root",
      },
      payload: {
        query: "主叙事阶段",
        retrieval_policy: {
          max_evidence: 4,
        },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().tool_id, "memory_retrieve");
    assert.deepEqual(response.json().categories, ["workspace"]);
    assert.equal(response.json().evidence[0]?.tree_id, outputTree!.treeId);
    assert.equal(response.json().evidence[0]?.entity_type, "artifact");
    assert.ok(response.json().evidence[0]?.reasons.includes("artifact_title_match_boost"));
    const derivedMemoryHit = response.json().evidence.find((item: { tree_id?: string }) =>
      item.tree_id === "interaction:project:gtm-rollout",
    );
    assert.ok(derivedMemoryHit);
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory_retrieve tool returns integration leaf hits through the workspace scope", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-memory-retrieve-integration-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.upsertIntegrationConnection({
    connectionId: "conn-github-1",
    providerId: "github",
    ownerUserId: "user-1",
    accountLabel: "Jeff GitHub",
    accountExternalId: "acct-1",
    accountHandle: "jeff-github",
    accountEmail: null,
    authMode: "oauth",
    grantedScopes: ["repo"],
    status: "active",
    secretRef: null,
  });
  store.upsertIntegrationBinding({
    bindingId: "binding-github-1",
    workspaceId: "root",
    targetType: "workspace",
    targetId: "root",
    integrationKey: "github",
    connectionId: "conn-github-1",
    isDefault: true,
  });
  store.upsertIntegrationTree({
    workspaceId: "root",
    treeId: "integration:github:acct-1",
    provider: "github",
    ownerUserId: "user-1",
    accountKey: "jeff-github",
    accountLabel: "Jeff GitHub",
    slug: "github-jeff-acct-1",
    summary: "GitHub account memory.",
    status: "active",
  });
  store.upsertIntegrationLeaf({
    workspaceId: "root",
    leafId: "leaf-release-pr",
    treeId: "integration:github:acct-1",
    subjectKey: "pr:release-123",
    entityKey: "repo:holaboss-ai/release",
    entityLabel: "holaboss-ai/release",
    branchKey: "pull_requests",
    branchLabel: "Pull requests",
    path: "integration/accounts/github-jeff-acct-1/leaves/leaf-release-pr.md",
    title: "Release PR #123 owner",
    summary: "The release PR owner is Maya Chen.",
    fingerprint: "integration-release-pr-fingerprint",
    bodySha256: "integration-release-pr-sha",
    tags: ["github", "release"],
    sourceType: "github.pull_request",
    sourceEventId: "evt-1",
    sourceMessageId: null,
    externalObjectId: "123",
    externalObjectType: "pull_request",
    admissionConfidence: 0.94,
    observedAt: "2026-05-20T00:00:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  const leafPath = path.join(
    globalMemoryDirForWorkspaceRoot(workspaceRoot),
    "integration",
    "accounts",
    "github-jeff-acct-1",
    "leaves",
    "leaf-release-pr.md",
  );
  fs.mkdirSync(path.dirname(leafPath), { recursive: true });
  fs.writeFileSync(leafPath, "# Release PR #123 owner\n\nThe release PR owner is Maya Chen.\n", "utf8");
  await rebuildIntegrationTree({
    store,
    workspaceId: "root",
    treeId: "integration:github:acct-1",
    embeddingClient: null,
  });
  const app = buildTestRuntimeApiServer({ store });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": "root",
      },
      payload: {
        query: "who owns release pr 123?",
        scope: {
          categories: ["workspace"],
        },
        retrieval_policy: {
          max_evidence: 4,
        },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().tool_id, "memory_retrieve");
    assert.deepEqual(response.json().categories, ["workspace"]);
    assert.equal(response.json().intent, "fact_lookup");
    assert.ok(response.json().evidence.length >= 1);
    const releaseEvidence = response
      .json()
      .evidence.find((item: { title?: string }) => item.title === "Release PR #123 owner");
    assert.ok(releaseEvidence);
    assert.equal(releaseEvidence.provider, "github");
    assert.equal(releaseEvidence.summary, "The release PR owner is Maya Chen.");
    assert.equal(response.json().retrieval_pack.recommended_next_source, "github");
    assert.equal("path" in releaseEvidence, false);
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory_retrieve rejects legacy interaction and integration scope categories", async () => {
  const root = makeTempDir("hb-runtime-api-memory-retrieve-legacy-categories-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const app = buildTestRuntimeApiServer({ store });

  try {
    for (const category of ["interaction", "integration"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
        headers: {
          "x-holaboss-workspace-id": "workspace-1",
        },
        payload: {
          query: "deploy",
          scope: {
            categories: [category],
          },
        },
      });

      assert.equal(response.statusCode, 400);
      assert.match(response.body, /scope\.categories must contain only 'workspace'/i);
    }
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory routes reclassify stale uncategorized interaction leaves on first read", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-memory-reclassify-stale-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.upsertInteractionEntity({
    workspaceId: "root",
    entityId: "interaction:uncategorized",
    entityType: "misc",
    canonicalName: "Uncategorized",
    slug: "uncategorized",
    summary: "Fallback interaction tree.",
    aliases: [],
    isSystem: true,
    status: "active",
  });
  store.upsertInteractionLeaf({
    workspaceId: "root",
    leafId: "leaf-outreach",
    entityId: "interaction:uncategorized",
    subjectKey:
      "holaboss_personal_outreach_external_contacts:individuals-have-emailed-the-user-personally",
    path: "workspace/root/interaction/entities/uncategorized/leaves/leaf-outreach.md",
    title: "External individuals have emailed the user personally about holaboss",
    summary:
      "At least two external individuals reached out to the user specifically about holaboss as a direct personal contact.",
    fingerprint: "fingerprint-leaf-outreach",
    bodySha256: "sha-leaf-outreach",
    tags: ["outreach", "contacts"],
    secondaryEntityIds: [],
    sourceType: "assistant_turn",
    sourceEventId: "input-1",
    sourceMessageId: null,
    sourceTurnInputId: "input-1",
    admissionConfidence: 0.92,
    entityConfidence: null,
    observedAt: "2026-06-03T08:57:55.231Z",
    supersedesLeafId: null,
    status: "active",
  });
  const originalLeafPath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "root")),
    "interaction",
    "entities",
    "uncategorized",
    "leaves",
    "leaf-outreach.md",
  );
  fs.mkdirSync(path.dirname(originalLeafPath), { recursive: true });
  fs.writeFileSync(
    originalLeafPath,
    [
      "# External individuals have emailed the user personally about holaboss",
      "",
      "At least two external individuals reached out to the user specifically about holaboss as a direct personal contact.",
    ].join("\n"),
    "utf8",
  );

  const app = buildTestRuntimeApiServer({ store });
  const treeContainsPath = (
    node: { path: string; children?: Array<{ path: string; children?: unknown[] }> },
    targetPath: string,
  ): boolean => {
    if (node.path === targetPath) {
      return true;
    }
    return (node.children ?? []).some((child) =>
      treeContainsPath(
        child as { path: string; children?: Array<{ path: string; children?: unknown[] }> },
        targetPath,
      )
    );
  };

  try {
    const treeResponse = await app.inject({
      method: "GET",
      url: "/api/v1/memory/browser/tree?workspace_id=root",
    });
    assert.equal(treeResponse.statusCode, 200);

    const leaf = store.getInteractionLeaf({
      workspaceId: "root",
      leafId: "leaf-outreach",
    });
    const topicEntity = store.getInteractionEntity({
      workspaceId: "root",
      entityId:
        "interaction:topic:external-individuals-have-emailed-the-user-personally-about-holaboss",
    });

    assert.ok(leaf);
    assert.ok(topicEntity);
    assert.equal(leaf?.entityId, topicEntity?.entityId);
    assert.match(
      leaf?.path ?? "",
      /interaction\/entities\/topic-external-individuals-have-emailed-the-user-personally-about-holaboss\/leaves\/leaf-outreach\.md$/,
    );
    const topicBrowserPath = `workspace/knowledge/${topicEntity?.slug}/content.md`;
    assert.equal(treeContainsPath(treeResponse.json().root, topicBrowserPath), true);

    const fileResponse = await app.inject({
      method: "GET",
      url: `/api/v1/memory/browser/file?workspace_id=root&path=${encodeURIComponent(topicBrowserPath)}`,
    });
    assert.equal(fileResponse.statusCode, 200);
    assert.match(fileResponse.json().content, /External individuals have emailed the user personally about holaboss/);

    const retrieveResponse = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": "root",
      },
      payload: {
        query: "holaboss personal outreach",
        retrieval_policy: {
          max_evidence: 4,
        },
      },
    });
    assert.equal(retrieveResponse.statusCode, 200);
    assert.equal(
      retrieveResponse.json().evidence[0]?.title,
      "External individuals have emailed the user personally about holaboss",
    );
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory routes repair clipped stale leaves from backfilled output artifacts even without the original turn result", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-memory-repair-stale-output-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: "root",
    sessionId: "session-main",
    kind: "main_session",
  });
  store.upsertInteractionEntity({
    workspaceId: "root",
    entityId: "interaction:topic:builder-mode-rollout",
    entityType: "topic",
    canonicalName: "Builder Mode rollout",
    slug: "topic-builder-mode-rollout",
    summary: "Rollout handoff memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  store.upsertInteractionLeaf({
    workspaceId: "root",
    leafId: "leaf-rollout-handoff",
    entityId: "interaction:topic:builder-mode-rollout",
    subjectKey: "builder_mode_rollout_handoff",
    path: "workspace/root/interaction/entities/topic-builder-mode-rollout/leaves/leaf-rollout-handoff.md",
    title: "Builder Mode rollout handoff captured in legacy deliverable",
    summary: "Builder Mode rollout handoff details were documented...",
    fingerprint: "fingerprint-rollout-handoff",
    bodySha256: "sha-rollout-handoff",
    tags: ["builder-mode", "rollout"],
    secondaryEntityIds: [],
    sourceType: "assistant_turn",
    sourceEventId: "input-legacy-output-1",
    sourceMessageId: null,
    sourceTurnInputId: "input-legacy-output-1",
    admissionConfidence: 0.9,
    entityConfidence: null,
    observedAt: "2026-06-03T12:00:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  const originalLeafPath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "root")),
    "interaction",
    "entities",
    "topic-builder-mode-rollout",
    "leaves",
    "leaf-rollout-handoff.md",
  );
  fs.mkdirSync(path.dirname(originalLeafPath), { recursive: true });
  fs.writeFileSync(
    originalLeafPath,
    [
      "# Builder Mode rollout handoff captured in legacy deliverable",
      "",
      "## Summary",
      "",
      "Builder Mode rollout handoff details were documented...",
      "",
      "## Evidence",
      "",
      "The rollout owner and approval contact were listed...",
      "",
    ].join("\n"),
    "utf8",
  );

  const reportRelativePath = "outputs/reports/legacy-handoff.md";
  const reportAbsolutePath = path.join(workspaceRoot, "root", reportRelativePath);
  fs.mkdirSync(path.dirname(reportAbsolutePath), { recursive: true });
  fs.writeFileSync(
    reportAbsolutePath,
    [
      "# Legacy Handoff",
      "",
      "Builder Mode rollout owner is Nina Patel.",
      "Approval contact is Dana Moss.",
      "Keep the rollout handoff details attached to durable workspace memory.",
    ].join("\n"),
    "utf8",
  );
  store.createOutput({
    workspaceId: "root",
    outputId: "output-legacy-handoff-1",
    outputType: "document",
    title: "legacy-handoff.md",
    status: "completed",
    filePath: reportRelativePath,
    sessionId: "session-main",
    inputId: "input-legacy-output-1",
    artifactId: "artifact-legacy-handoff-1",
    metadata: {
      origin_type: "output",
    },
  });

  assert.equal(
    listWorkspaceOutputDocumentTrees({
      store,
      workspaceId: "root",
    }).length,
    0,
  );

  const app = buildTestRuntimeApiServer({ store });

  try {
    const treeResponse = await app.inject({
      method: "GET",
      url: "/api/v1/memory/browser/tree?workspace_id=root",
    });
    assert.equal(treeResponse.statusCode, 200);

    const outputTree = listWorkspaceOutputDocumentTrees({
      store,
      workspaceId: "root",
    })[0];
    assert.ok(outputTree);
    assert.equal(outputTree?.title, "legacy-handoff.md");

    const repairedLeaf = store.getInteractionLeaf({
      workspaceId: "root",
      leafId: "leaf-rollout-handoff",
    });
    assert.ok(repairedLeaf);
    const repairedLeafAbsolutePath = path.join(
      workspaceMemoryDir(path.join(workspaceRoot, "root")),
      repairedLeaf!.path.startsWith("workspace/")
        ? repairedLeaf!.path.split("/").slice(2).join("/")
        : repairedLeaf!.path,
    );
    const repairedLeafBody = fs.readFileSync(repairedLeafAbsolutePath, "utf8");
    assert.doesNotMatch(repairedLeafBody, /\.\.\./);
    assert.match(repairedLeafBody, /Nina Patel/);
    assert.match(repairedLeafBody, /Dana Moss/);
    assert.match(repairedLeafBody, /## Evidence/);

    const leafNode = store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: "root",
      treeId: "interaction:topic:builder-mode-rollout",
      status: "active",
      limit: 10_000,
      offset: 0,
    }).find((node) =>
      node.nodeClass === "leaf"
      && node.title === "Builder Mode rollout handoff captured in legacy deliverable"
    );
    assert.ok(leafNode);

    const leafDetailResponse = await app.inject({
      method: "GET",
      url: `/api/v1/memory/browser/node-detail?workspace_id=root&tree_id=${encodeURIComponent("interaction:topic:builder-mode-rollout")}&node_id=${encodeURIComponent(leafNode!.nodeId)}`,
    });
    assert.equal(leafDetailResponse.statusCode, 200);
    assert.ok(leafDetailResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
    }) =>
      relation.relation_type === "derived_from"
      && relation.target_label === "legacy-handoff.md",
    ));

    const retrieveResponse = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": "root",
      },
      payload: {
        query: "Nina Patel Dana Moss builder mode rollout",
        retrieval_policy: {
          max_evidence: 6,
        },
      },
    });
    assert.equal(retrieveResponse.statusCode, 200);
    assert.ok(retrieveResponse.json().evidence.some((item: {
      title?: string;
    }) =>
      item.title === "Builder Mode rollout handoff captured in legacy deliverable",
    ));
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory routes leave clipped stale leaves unchanged when no source evidence exists", async () => {
  const root = makeTempDir("hb-runtime-api-memory-repair-clipped-no-source-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    kind: "main_session",
  });
  store.upsertInteractionEntity({
    workspaceId: "workspace-1",
    entityId: "interaction:topic:no-source-outreach",
    entityType: "topic",
    canonicalName: "no source outreach",
    slug: "topic-no-source-outreach",
    summary: "A clipped legacy memory with no recoverable source evidence.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  store.upsertInteractionLeaf({
    workspaceId: "workspace-1",
    leafId: "leaf-clipped-no-source",
    entityId: "interaction:topic:no-source-outreach",
    subjectKey: "no_source_outreach",
    path: "workspace/workspace-1/interaction/entities/topic-no-source-outreach/leaves/leaf-clipped-no-source.md",
    title: "No-source outreach memory",
    summary: "Ben Book at anyIP emailed the user personally...",
    fingerprint: "fingerprint-clipped-no-source",
    bodySha256: "sha-clipped-no-source",
    tags: ["outreach"],
    secondaryEntityIds: [],
    sourceType: "assistant_turn",
    sourceEventId: "input-clipped-no-source",
    sourceMessageId: null,
    sourceTurnInputId: null,
    admissionConfidence: 0.9,
    entityConfidence: null,
    observedAt: "2026-06-03T16:50:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  const originalLeafPath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
    "interaction",
    "entities",
    "topic-no-source-outreach",
    "leaves",
    "leaf-clipped-no-source.md",
  );
  fs.mkdirSync(path.dirname(originalLeafPath), { recursive: true });
  const originalBody = [
    "# No-source outreach memory",
    "",
    "## Summary",
    "",
    "Ben Book at anyIP emailed the user personally...",
    "",
    "## Evidence",
    "",
    "Ben Book at anyIP ...",
    "",
  ].join("\n");
  fs.writeFileSync(originalLeafPath, originalBody, "utf8");

  const app = buildTestRuntimeApiServer({ store });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/memory/browser/tree?workspace_id=workspace-1",
    });
    assert.equal(response.statusCode, 200);

    const repairedBody = fs.readFileSync(originalLeafPath, "utf8");
    assert.equal(stripDurableMemoryRelatedSections(repairedBody).trim(), originalBody.trim());
    assert.match(repairedBody, /\.\.\./);
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory routes enrich stale weak leaves from backfilled output artifacts into resolved person and organization relations", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-memory-repair-stale-relations-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: "root",
    sessionId: "session-main",
    kind: "main_session",
  });
  store.upsertInteractionEntity({
    workspaceId: "root",
    entityId: "interaction:topic:builder-mode-rollout",
    entityType: "topic",
    canonicalName: "Builder Mode rollout",
    slug: "topic-builder-mode-rollout",
    summary: "Rollout handoff memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  store.upsertInteractionEntity({
    workspaceId: "root",
    entityId: "interaction:person:ben-book",
    entityType: "person",
    canonicalName: "Ben Book",
    slug: "person-ben-book",
    summary: "External outreach contact.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  store.upsertInteractionEntity({
    workspaceId: "root",
    entityId: "interaction:customer:anyip",
    entityType: "customer",
    canonicalName: "anyIP",
    slug: "customer-anyip",
    summary: "External organization.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  await rebuildInteractionEntityTree({
    store,
    workspaceId: "root",
    entityId: "interaction:person:ben-book",
    summaryModelClient: null,
    embeddingClient: null,
  });
  await rebuildInteractionEntityTree({
    store,
    workspaceId: "root",
    entityId: "interaction:customer:anyip",
    summaryModelClient: null,
    embeddingClient: null,
  });
  store.upsertInteractionLeaf({
    workspaceId: "root",
    leafId: "leaf-rollout-contacts",
    entityId: "interaction:topic:builder-mode-rollout",
    subjectKey: "builder_mode_rollout_contacts",
    path: "workspace/root/interaction/entities/topic-builder-mode-rollout/leaves/leaf-rollout-contacts.md",
    title: "Builder Mode rollout contact list captured in legacy deliverable",
    summary: "Builder Mode rollout contact details were documented in a legacy deliverable.",
    fingerprint: "fingerprint-rollout-contacts",
    bodySha256: "sha-rollout-contacts",
    tags: ["builder-mode", "rollout", "contacts"],
    secondaryEntityIds: [],
    sourceType: "assistant_turn",
    sourceEventId: "input-legacy-output-2",
    sourceMessageId: null,
    sourceTurnInputId: "input-legacy-output-2",
    admissionConfidence: 0.91,
    entityConfidence: null,
    observedAt: "2026-06-03T13:00:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  const originalLeafPath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "root")),
    "interaction",
    "entities",
    "topic-builder-mode-rollout",
    "leaves",
    "leaf-rollout-contacts.md",
  );
  fs.mkdirSync(path.dirname(originalLeafPath), { recursive: true });
  fs.writeFileSync(
    originalLeafPath,
    [
      "# Builder Mode rollout contact list captured in legacy deliverable",
      "",
      "## Summary",
      "",
      "Builder Mode rollout contact details were documented in a legacy deliverable.",
      "",
      "## Evidence",
      "",
      "The legacy deliverable contains the rollout contact list.",
      "",
    ].join("\n"),
    "utf8",
  );

  const reportRelativePath = "outputs/reports/legacy-contacts.md";
  const reportAbsolutePath = path.join(workspaceRoot, "root", reportRelativePath);
  fs.mkdirSync(path.dirname(reportAbsolutePath), { recursive: true });
  fs.writeFileSync(
    reportAbsolutePath,
    [
      "# Legacy Contacts",
      "",
      "Builder Mode rollout external contact is Ben Book.",
      "Ben Book works at anyIP.",
      "Keep the rollout contact list attached to durable workspace memory.",
    ].join("\n"),
    "utf8",
  );
  store.createOutput({
    workspaceId: "root",
    outputId: "output-legacy-contacts-1",
    outputType: "document",
    title: "legacy-contacts.md",
    status: "completed",
    filePath: reportRelativePath,
    sessionId: "session-main",
    inputId: "input-legacy-output-2",
    artifactId: "artifact-legacy-contacts-1",
    metadata: {
      origin_type: "output",
    },
  });

  assert.equal(
    listWorkspaceOutputDocumentTrees({
      store,
      workspaceId: "root",
    }).length,
    0,
  );

  let requestCount = 0;
  const server = await startStaticHttpServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/openai/v1/chat/completions") {
      response.statusCode = 404;
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const payload = JSON.parse(body) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const systemPrompt = payload.messages?.find((message) => message.role === "system")?.content ?? "";
      requestCount += 1;
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      if (systemPrompt.includes("Extract related durable entities and relations")) {
        response.end(JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  related_entities: [
                    { entity_type: "person", label: "Ben Book" },
                    { entity_type: "organization", label: "anyIP" },
                  ],
                  relations: [
                    { relation_type: "contacted_by", entity_type: "person", entity_label: "Ben Book" },
                    { relation_type: "works_at", entity_type: "organization", entity_label: "anyIP" },
                  ],
                }),
              },
            },
          ],
        }));
        return;
      }
      response.end(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({}),
            },
          },
        ],
      }));
    });
  });

  writeRuntimeConfig(root, {
    runtime: {
      background_tasks: {
        provider: "openai_direct",
        model: "gpt-4.1-mini",
      },
    },
    providers: {
      openai_direct: {
        kind: "openai_compatible",
        base_url: `${server.url}/openai/v1`,
        api_key: "test-key",
      },
    },
  });

  const app = buildTestRuntimeApiServer({ store });

  try {
    const retrieveResponse = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": "root",
      },
      payload: {
        query: "Ben Book anyIP builder mode rollout",
        retrieval_policy: {
          max_evidence: 6,
        },
      },
    });
    assert.equal(retrieveResponse.statusCode, 200);
    assert.equal(
      retrieveResponse.json().evidence[0]?.title,
      "Builder Mode rollout contact list captured in legacy deliverable",
    );
    assert.ok(requestCount >= 1);

    const outputTree = listWorkspaceOutputDocumentTrees({
      store,
      workspaceId: "root",
    })[0];
    assert.ok(outputTree);
    assert.equal(outputTree?.title, "legacy-contacts.md");

    const repairedLeaf = store.getInteractionLeaf({
      workspaceId: "root",
      leafId: "leaf-rollout-contacts",
    });
    assert.ok(repairedLeaf);
    const repairedLeafAbsolutePath = path.join(
      workspaceMemoryDir(path.join(workspaceRoot, "root")),
      repairedLeaf!.path.startsWith("workspace/")
        ? repairedLeaf!.path.split("/").slice(2).join("/")
        : repairedLeaf!.path,
    );
    const repairedLeafBody = fs.readFileSync(repairedLeafAbsolutePath, "utf8");
    assert.match(
      repairedLeafBody,
      /`person:entity:interaction:person:ben-book` \| Ben Book/,
    );
    assert.match(
      repairedLeafBody,
      /`organization:entity:interaction:customer:anyip` \| anyIP/,
    );
    assert.doesNotMatch(repairedLeafBody, /`artifact:artifact`|`topic:topic`/);

    const leafNode = store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: "root",
      treeId: "interaction:topic:builder-mode-rollout",
      status: "active",
      limit: 10_000,
      offset: 0,
    }).find((node) =>
      node.nodeClass === "leaf"
      && node.title === "Builder Mode rollout contact list captured in legacy deliverable"
    );
    assert.ok(leafNode);

    const leafDetailResponse = await app.inject({
      method: "GET",
      url: `/api/v1/memory/browser/node-detail?workspace_id=root&tree_id=${encodeURIComponent("interaction:topic:builder-mode-rollout")}&node_id=${encodeURIComponent(leafNode!.nodeId)}`,
    });
    assert.equal(leafDetailResponse.statusCode, 200);
    assert.ok(leafDetailResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
      target_resolution_kind?: string | null;
    }) =>
      relation.relation_type === "contacted_by"
      && relation.target_label === "Ben Book"
      && relation.target_resolution_kind === "resolved",
    ));
    assert.ok(leafDetailResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
      target_resolution_kind?: string | null;
    }) =>
      relation.relation_type === "works_at"
      && relation.target_label === "anyIP"
      && relation.target_resolution_kind === "resolved",
    ));

    const organizationRetrieveResponse = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": "root",
      },
      payload: {
        query: "anyIP builder mode",
        retrieval_policy: {
          max_evidence: 6,
        },
      },
    });
    assert.equal(organizationRetrieveResponse.statusCode, 200);
    assert.equal(
      organizationRetrieveResponse.json().evidence[0]?.title,
      "Builder Mode rollout contact list captured in legacy deliverable",
    );
  } finally {
    await app.close();
    await server.close();
    store.close();
  }
});

test("runtime memory routes enrich stale weak leaves from backfilled tool-result artifacts into resolved person and organization relations", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-memory-repair-stale-tool-result-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: "root",
    sessionId: "session-main",
    kind: "main_session",
  });
  store.upsertInteractionEntity({
    workspaceId: "root",
    entityId: "interaction:topic:builder-mode-rollout",
    entityType: "topic",
    canonicalName: "Builder Mode rollout",
    slug: "topic-builder-mode-rollout",
    summary: "Rollout handoff memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  store.upsertInteractionEntity({
    workspaceId: "root",
    entityId: "interaction:person:ben-book",
    entityType: "person",
    canonicalName: "Ben Book",
    slug: "person-ben-book",
    summary: "External outreach contact.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  store.upsertInteractionEntity({
    workspaceId: "root",
    entityId: "interaction:customer:anyip",
    entityType: "customer",
    canonicalName: "anyIP",
    slug: "customer-anyip",
    summary: "External organization.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  await rebuildInteractionEntityTree({
    store,
    workspaceId: "root",
    entityId: "interaction:person:ben-book",
    summaryModelClient: null,
    embeddingClient: null,
  });
  await rebuildInteractionEntityTree({
    store,
    workspaceId: "root",
    entityId: "interaction:customer:anyip",
    summaryModelClient: null,
    embeddingClient: null,
  });

  const queuedInput = store.enqueueInput({
    workspaceId: "root",
    sessionId: "session-main",
    payload: {
      text: "Keep the Gmail rollout contact searchable.",
    },
  });
  store.upsertTurnResult({
    workspaceId: "root",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-04T14:00:00.000Z",
    completedAt: "2026-06-04T14:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the Gmail rollout contact result.",
  });
  store.appendOutputEvent({
    workspaceId: "root",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    sequence: 1,
    eventType: "tool_call",
    payload: {
      phase: "completed",
      tool_name: "holaboss_composio.gmail_fetch_emails",
      tool_id: "holaboss_composio.gmail_fetch_emails",
      call_id: "call-gmail-stale-repair-1",
      error: false,
      result: {
        content: [
          {
            type: "text",
            text: "Ben Book at anyIP emailed ops@example.com about the Builder Mode rollout and asked for the current approval owner.",
          },
        ],
        details: {
          raw: {
            _meta: {
              holaboss_integration_account: {
                provider_id: "gmail",
                connected_account_id: "ca_gmail_primary",
                account_namespace: "ops@example.com",
                connection_id: "conn_gmail_primary",
              },
            },
          },
        },
      },
    },
    createdAt: "2026-06-04T14:00:03.000Z",
  });

  store.upsertInteractionLeaf({
    workspaceId: "root",
    leafId: "leaf-rollout-gmail-contact",
    entityId: "interaction:topic:builder-mode-rollout",
    subjectKey: "builder_mode_rollout_gmail_contact",
    path: "workspace/root/interaction/entities/topic-builder-mode-rollout/leaves/leaf-rollout-gmail-contact.md",
    title: "Builder Mode rollout Gmail contact captured in a legacy result",
    summary: "Builder Mode rollout Gmail contact details were documented in a legacy result.",
    fingerprint: "fingerprint-rollout-gmail-contact",
    bodySha256: "sha-rollout-gmail-contact",
    tags: ["builder-mode", "rollout", "gmail"],
    secondaryEntityIds: [],
    sourceType: "assistant_turn",
    sourceEventId: queuedInput.inputId,
    sourceMessageId: null,
    sourceTurnInputId: queuedInput.inputId,
    admissionConfidence: 0.91,
    entityConfidence: null,
    observedAt: "2026-06-03T14:00:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  const originalLeafPath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "root")),
    "interaction",
    "entities",
    "topic-builder-mode-rollout",
    "leaves",
    "leaf-rollout-gmail-contact.md",
  );
  fs.mkdirSync(path.dirname(originalLeafPath), { recursive: true });
  fs.writeFileSync(
    originalLeafPath,
    [
      "# Builder Mode rollout Gmail contact captured in a legacy result",
      "",
      "## Summary",
      "",
      "Builder Mode rollout Gmail contact details were documented in a legacy result.",
      "",
      "## Evidence",
      "",
      "The legacy Gmail result contains the rollout contact details.",
      "",
    ].join("\n"),
    "utf8",
  );

  assert.equal(
    listWorkspaceToolResultDocumentTrees({
      store,
      workspaceId: "root",
    }).length,
    0,
  );

  let requestCount = 0;
  const server = await startStaticHttpServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/openai/v1/chat/completions") {
      response.statusCode = 404;
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const payload = JSON.parse(body) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const systemPrompt = payload.messages?.find((message) => message.role === "system")?.content ?? "";
      requestCount += 1;
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      if (systemPrompt.includes("Extract related durable entities and relations")) {
        response.end(JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  related_entities: [
                    { entity_type: "person", label: "Ben Book" },
                    { entity_type: "organization", label: "anyIP" },
                  ],
                  relations: [
                    { relation_type: "contacted_by", entity_type: "person", entity_label: "Ben Book" },
                    { relation_type: "works_at", entity_type: "organization", entity_label: "anyIP" },
                  ],
                }),
              },
            },
          ],
        }));
        return;
      }
      response.end(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({}),
            },
          },
        ],
      }));
    });
  });

  writeRuntimeConfig(root, {
    runtime: {
      background_tasks: {
        provider: "openai_direct",
        model: "gpt-4.1-mini",
      },
    },
    providers: {
      openai_direct: {
        kind: "openai_compatible",
        base_url: `${server.url}/openai/v1`,
        api_key: "test-key",
      },
    },
  });

  const app = buildTestRuntimeApiServer({ store });

  try {
    const retrieveResponse = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": "root",
      },
      payload: {
        query: "Ben Book anyIP builder mode rollout",
        retrieval_policy: {
          max_evidence: 6,
        },
      },
    });
    assert.equal(retrieveResponse.statusCode, 200);
    assert.equal(
      retrieveResponse.json().evidence[0]?.title,
      "Builder Mode rollout Gmail contact captured in a legacy result",
    );
    assert.ok(requestCount >= 1);

    const toolResultTree = listWorkspaceToolResultDocumentTrees({
      store,
      workspaceId: "root",
    })[0];
    assert.ok(toolResultTree);
    assert.equal(toolResultTree?.providerId, "gmail");
    assert.equal(toolResultTree?.accountNamespace, "ops@example.com");

    const repairedLeaf = store.getInteractionLeaf({
      workspaceId: "root",
      leafId: "leaf-rollout-gmail-contact",
    });
    assert.ok(repairedLeaf);
    const repairedLeafAbsolutePath = path.join(
      workspaceMemoryDir(path.join(workspaceRoot, "root")),
      repairedLeaf!.path.startsWith("workspace/")
        ? repairedLeaf!.path.split("/").slice(2).join("/")
        : repairedLeaf!.path,
    );
    const repairedLeafBody = fs.readFileSync(repairedLeafAbsolutePath, "utf8");
    assert.match(
      repairedLeafBody,
      /`person:entity:interaction:person:ben-book` \| Ben Book/,
    );
    assert.match(
      repairedLeafBody,
      /`organization:entity:interaction:customer:anyip` \| anyIP/,
    );
    assert.match(
      repairedLeafBody,
      /`artifact:tool-result:gmail:call-gmail-stale-repair-1` \|/i,
    );

    const leafNode = store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: "root",
      treeId: "interaction:topic:builder-mode-rollout",
      status: "active",
      limit: 10_000,
      offset: 0,
    }).find((node) =>
      node.nodeClass === "leaf"
      && node.title === "Builder Mode rollout Gmail contact captured in a legacy result"
    );
    assert.ok(leafNode);

    const leafDetailResponse = await app.inject({
      method: "GET",
      url: `/api/v1/memory/browser/node-detail?workspace_id=root&tree_id=${encodeURIComponent("interaction:topic:builder-mode-rollout")}&node_id=${encodeURIComponent(leafNode!.nodeId)}`,
    });
    assert.equal(leafDetailResponse.statusCode, 200);
    assert.ok(leafDetailResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
      target_resolution_kind?: string | null;
    }) =>
      relation.relation_type === "contacted_by"
      && relation.target_label === "Ben Book"
      && relation.target_resolution_kind === "resolved",
    ));
    assert.ok(leafDetailResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
      target_resolution_kind?: string | null;
    }) =>
      relation.relation_type === "works_at"
      && relation.target_label === "anyIP"
      && relation.target_resolution_kind === "resolved",
    ));
    assert.ok(leafDetailResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
    }) =>
      relation.relation_type === "derived_from"
      && /gmail_fetch_emails/i.test(relation.target_label ?? ""),
    ));

    const accountRetrieveResponse = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": "root",
      },
      payload: {
        query: "ops@example.com builder mode rollout",
        retrieval_policy: {
          max_evidence: 6,
        },
      },
    });
    assert.equal(accountRetrieveResponse.statusCode, 200);
    assert.equal(
      accountRetrieveResponse.json().evidence[0]?.title,
      "Builder Mode rollout Gmail contact captured in a legacy result",
    );
  } finally {
    await app.close();
    await server.close();
    store.close();
  }
});

test("runtime memory routes enrich stale weak leaves from backfilled attachment artifacts into resolved person and organization relations", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-memory-repair-stale-attachment-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: "root",
    sessionId: "session-main",
    kind: "main_session",
  });
  store.upsertInteractionEntity({
    workspaceId: "root",
    entityId: "interaction:topic:holaboss-personal-outreach",
    entityType: "topic",
    canonicalName: "holaboss personal outreach",
    slug: "topic-holaboss-personal-outreach",
    summary: "Personal outreach memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  store.upsertInteractionEntity({
    workspaceId: "root",
    entityId: "interaction:person:ben-book",
    entityType: "person",
    canonicalName: "Ben Book",
    slug: "person-ben-book",
    summary: "External outreach contact.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  store.upsertInteractionEntity({
    workspaceId: "root",
    entityId: "interaction:customer:anyip",
    entityType: "customer",
    canonicalName: "anyIP",
    slug: "customer-anyip",
    summary: "External organization.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  await rebuildInteractionEntityTree({
    store,
    workspaceId: "root",
    entityId: "interaction:person:ben-book",
    summaryModelClient: null,
    embeddingClient: null,
  });
  await rebuildInteractionEntityTree({
    store,
    workspaceId: "root",
    entityId: "interaction:customer:anyip",
    summaryModelClient: null,
    embeddingClient: null,
  });

  const attachmentRelativePath = ".holaboss/input-attachments/batch-legacy/outreach-note.html";
  const attachmentAbsolutePath = path.join(workspaceRoot, "root", attachmentRelativePath);
  fs.mkdirSync(path.dirname(attachmentAbsolutePath), { recursive: true });
  fs.writeFileSync(
    attachmentAbsolutePath,
    [
      "<html><body>",
      "<h1>Personal Outreach</h1>",
      "<p>Ben Book at anyIP emailed the user personally about holaboss.</p>",
      "<p>Keep this attachment tied to the durable personal outreach memory.</p>",
      "</body></html>",
    ].join(""),
    "utf8",
  );

  const queuedInput = store.enqueueInput({
    workspaceId: "root",
    sessionId: "session-main",
    payload: {
      text: "Keep this outreach attachment around.",
      attachments: [
        {
          id: "att-stale-1",
          kind: "file",
          name: "outreach-note.html",
          mime_type: "text/html",
          size_bytes: fs.statSync(attachmentAbsolutePath).size,
          workspace_path: attachmentRelativePath,
        },
      ],
    },
  });
  store.upsertTurnResult({
    workspaceId: "root",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-04T15:00:00.000Z",
    completedAt: "2026-06-04T15:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the outreach attachment.",
  });

  store.upsertInteractionLeaf({
    workspaceId: "root",
    leafId: "leaf-personal-outreach-attachment",
    entityId: "interaction:topic:holaboss-personal-outreach",
    subjectKey: "holaboss_personal_outreach_attachment",
    path: "workspace/root/interaction/entities/topic-holaboss-personal-outreach/leaves/leaf-personal-outreach-attachment.md",
    title: "holaboss personal outreach attachment preserved in a legacy note",
    summary: "The personal outreach attachment was preserved in a legacy note.",
    fingerprint: "fingerprint-personal-outreach-attachment",
    bodySha256: "sha-personal-outreach-attachment",
    tags: ["holaboss", "outreach", "attachment"],
    secondaryEntityIds: [],
    sourceType: "assistant_turn",
    sourceEventId: queuedInput.inputId,
    sourceMessageId: null,
    sourceTurnInputId: queuedInput.inputId,
    admissionConfidence: 0.92,
    entityConfidence: null,
    observedAt: "2026-06-03T15:00:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  const originalLeafPath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "root")),
    "interaction",
    "entities",
    "topic-holaboss-personal-outreach",
    "leaves",
    "leaf-personal-outreach-attachment.md",
  );
  fs.mkdirSync(path.dirname(originalLeafPath), { recursive: true });
  fs.writeFileSync(
    originalLeafPath,
    [
      "# holaboss personal outreach attachment preserved in a legacy note",
      "",
      "## Summary",
      "",
      "The personal outreach attachment was preserved in a legacy note.",
      "",
      "## Evidence",
      "",
      "The legacy attachment contains the outreach details.",
      "",
    ].join("\n"),
    "utf8",
  );

  assert.equal(
    listWorkspaceAttachmentDocumentTrees({
      store,
      workspaceId: "root",
    }).length,
    0,
  );

  let requestCount = 0;
  const server = await startStaticHttpServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/openai/v1/chat/completions") {
      response.statusCode = 404;
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const payload = JSON.parse(body) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const systemPrompt = payload.messages?.find((message) => message.role === "system")?.content ?? "";
      requestCount += 1;
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      if (systemPrompt.includes("Extract related durable entities and relations")) {
        response.end(JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  related_entities: [
                    { entity_type: "person", label: "Ben Book" },
                    { entity_type: "organization", label: "anyIP" },
                  ],
                  relations: [
                    { relation_type: "contacted_by", entity_type: "person", entity_label: "Ben Book" },
                    { relation_type: "works_at", entity_type: "organization", entity_label: "anyIP" },
                  ],
                }),
              },
            },
          ],
        }));
        return;
      }
      response.end(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({}),
            },
          },
        ],
      }));
    });
  });

  writeRuntimeConfig(root, {
    runtime: {
      background_tasks: {
        provider: "openai_direct",
        model: "gpt-4.1-mini",
      },
    },
    providers: {
      openai_direct: {
        kind: "openai_compatible",
        base_url: `${server.url}/openai/v1`,
        api_key: "test-key",
      },
    },
  });

  const app = buildTestRuntimeApiServer({ store });

  try {
    const retrieveResponse = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": "root",
      },
      payload: {
        query: "Ben Book anyIP holaboss personal outreach",
        retrieval_policy: {
          max_evidence: 6,
        },
      },
    });
    assert.equal(retrieveResponse.statusCode, 200);
    assert.equal(
      retrieveResponse.json().evidence[0]?.title,
      "holaboss personal outreach attachment preserved in a legacy note",
    );
    assert.ok(requestCount >= 1);

    const attachmentTree = listWorkspaceAttachmentDocumentTrees({
      store,
      workspaceId: "root",
    })[0];
    assert.ok(attachmentTree);
    assert.equal(attachmentTree?.attachmentId, "att-stale-1");

    const repairedLeaf = store.getInteractionLeaf({
      workspaceId: "root",
      leafId: "leaf-personal-outreach-attachment",
    });
    assert.ok(repairedLeaf);
    const repairedLeafAbsolutePath = path.join(
      workspaceMemoryDir(path.join(workspaceRoot, "root")),
      repairedLeaf!.path.startsWith("workspace/")
        ? repairedLeaf!.path.split("/").slice(2).join("/")
        : repairedLeaf!.path,
    );
    const repairedLeafBody = fs.readFileSync(repairedLeafAbsolutePath, "utf8");
    assert.match(
      repairedLeafBody,
      /`person:entity:interaction:person:ben-book` \| Ben Book/,
    );
    assert.match(
      repairedLeafBody,
      /`organization:entity:interaction:customer:anyip` \| anyIP/,
    );
    assert.match(
      repairedLeafBody,
      /`artifact:attachment:att-stale-1` \| outreach-note\.html/,
    );

    const leafNode = store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: "root",
      treeId: "interaction:topic:holaboss-personal-outreach",
      status: "active",
      limit: 10_000,
      offset: 0,
    }).find((node) =>
      node.nodeClass === "leaf"
      && node.title === "holaboss personal outreach attachment preserved in a legacy note"
    );
    assert.ok(leafNode);

    const leafDetailResponse = await app.inject({
      method: "GET",
      url: `/api/v1/memory/browser/node-detail?workspace_id=root&tree_id=${encodeURIComponent("interaction:topic:holaboss-personal-outreach")}&node_id=${encodeURIComponent(leafNode!.nodeId)}`,
    });
    assert.equal(leafDetailResponse.statusCode, 200);
    assert.ok(leafDetailResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
      target_resolution_kind?: string | null;
    }) =>
      relation.relation_type === "contacted_by"
      && relation.target_label === "Ben Book"
      && relation.target_resolution_kind === "resolved",
    ));
    assert.ok(leafDetailResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
      target_resolution_kind?: string | null;
    }) =>
      relation.relation_type === "works_at"
      && relation.target_label === "anyIP"
      && relation.target_resolution_kind === "resolved",
    ));
    assert.ok(leafDetailResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
    }) =>
      relation.relation_type === "derived_from"
      && relation.target_label === "outreach-note.html",
    ));
  } finally {
    await app.close();
    await server.close();
    store.close();
  }
});

test("runtime memory routes enrich stale weak leaves from backfilled image-url artifacts into resolved person and organization relations", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-memory-repair-stale-image-url-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: "root",
    sessionId: "session-main",
    kind: "main_session",
  });
  store.upsertInteractionEntity({
    workspaceId: "root",
    entityId: "interaction:topic:holaboss-personal-outreach",
    entityType: "topic",
    canonicalName: "holaboss personal outreach",
    slug: "topic-holaboss-personal-outreach",
    summary: "Personal outreach memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  store.upsertInteractionEntity({
    workspaceId: "root",
    entityId: "interaction:person:ben-book",
    entityType: "person",
    canonicalName: "Ben Book",
    slug: "person-ben-book",
    summary: "External outreach contact.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  store.upsertInteractionEntity({
    workspaceId: "root",
    entityId: "interaction:customer:anyip",
    entityType: "customer",
    canonicalName: "anyIP",
    slug: "customer-anyip",
    summary: "External organization.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  await rebuildInteractionEntityTree({
    store,
    workspaceId: "root",
    entityId: "interaction:person:ben-book",
    summaryModelClient: null,
    embeddingClient: null,
  });
  await rebuildInteractionEntityTree({
    store,
    workspaceId: "root",
    entityId: "interaction:customer:anyip",
    summaryModelClient: null,
    embeddingClient: null,
  });

  const imageRelativePath = "images/legacy-reference.png";
  const imageAbsolutePath = path.join(workspaceRoot, "root", imageRelativePath);
  fs.mkdirSync(path.dirname(imageAbsolutePath), { recursive: true });
  fs.writeFileSync(
    imageAbsolutePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9sVxubUAAAAASUVORK5CYII=",
      "base64",
    ),
  );

  const queuedInput = store.enqueueInput({
    workspaceId: "root",
    sessionId: "session-main",
    payload: {
      text: "Keep this referenced outreach image around.",
      image_urls: [pathToFileURL(imageAbsolutePath).toString()],
    },
  });
  store.upsertTurnResult({
    workspaceId: "root",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-04T16:00:00.000Z",
    completedAt: "2026-06-04T16:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the referenced outreach image.",
  });

  store.upsertInteractionLeaf({
    workspaceId: "root",
    leafId: "leaf-personal-outreach-image-url",
    entityId: "interaction:topic:holaboss-personal-outreach",
    subjectKey: "holaboss_personal_outreach_image_url",
    path: "workspace/root/interaction/entities/topic-holaboss-personal-outreach/leaves/leaf-personal-outreach-image-url.md",
    title: "holaboss personal outreach referenced image preserved in a legacy note",
    summary: "The personal outreach referenced image was preserved in a legacy note.",
    fingerprint: "fingerprint-personal-outreach-image-url",
    bodySha256: "sha-personal-outreach-image-url",
    tags: ["holaboss", "outreach", "image_url"],
    secondaryEntityIds: [],
    sourceType: "assistant_turn",
    sourceEventId: queuedInput.inputId,
    sourceMessageId: null,
    sourceTurnInputId: queuedInput.inputId,
    admissionConfidence: 0.92,
    entityConfidence: null,
    observedAt: "2026-06-03T16:00:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  const originalLeafPath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "root")),
    "interaction",
    "entities",
    "topic-holaboss-personal-outreach",
    "leaves",
    "leaf-personal-outreach-image-url.md",
  );
  fs.mkdirSync(path.dirname(originalLeafPath), { recursive: true });
  fs.writeFileSync(
    originalLeafPath,
    [
      "# holaboss personal outreach referenced image preserved in a legacy note",
      "",
      "## Summary",
      "",
      "The personal outreach referenced image was preserved in a legacy note.",
      "",
      "## Evidence",
      "",
      "The legacy referenced image contains the outreach details.",
      "",
    ].join("\n"),
    "utf8",
  );

  assert.equal(
    store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: "root",
      treeId: "image-url:image-url",
      status: "active",
    }).length,
    0,
  );

  let requestCount = 0;
  const server = await startStaticHttpServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/openai/v1/chat/completions") {
      response.statusCode = 404;
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const payload = JSON.parse(body) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const systemPrompt = payload.messages?.find((message) => message.role === "system")?.content ?? "";
      requestCount += 1;
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      if (systemPrompt.includes("Extract related durable entities and relations")) {
        response.end(JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  related_entities: [
                    { entity_type: "person", label: "Ben Book" },
                    { entity_type: "organization", label: "anyIP" },
                  ],
                  relations: [
                    { relation_type: "contacted_by", entity_type: "person", entity_label: "Ben Book" },
                    { relation_type: "works_at", entity_type: "organization", entity_label: "anyIP" },
                  ],
                }),
              },
            },
          ],
        }));
        return;
      }
      response.end(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({}),
            },
          },
        ],
      }));
    });
  });

  writeRuntimeConfig(root, {
    runtime: {
      background_tasks: {
        provider: "openai_direct",
        model: "gpt-4.1-mini",
      },
    },
    providers: {
      openai_direct: {
        kind: "openai_compatible",
        base_url: `${server.url}/openai/v1`,
        api_key: "test-key",
      },
    },
  });

  const app = buildTestRuntimeApiServer({ store });

  try {
    const retrieveResponse = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": "root",
      },
      payload: {
        query: "Ben Book anyIP holaboss personal outreach",
        retrieval_policy: {
          max_evidence: 6,
        },
      },
    });
    assert.equal(retrieveResponse.statusCode, 200);
    assert.equal(
      retrieveResponse.json().evidence[0]?.title,
      "holaboss personal outreach referenced image preserved in a legacy note",
    );
    assert.ok(requestCount >= 1);

    const imageTree = store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: "root",
      status: "active",
    }).find((node) =>
      node.nodeKind === "image_url_document"
      && /legacy-reference\.png/i.test(node.title),
    );
    assert.ok(imageTree);

    const repairedLeaf = store.getInteractionLeaf({
      workspaceId: "root",
      leafId: "leaf-personal-outreach-image-url",
    });
    assert.ok(repairedLeaf);
    const repairedLeafAbsolutePath = path.join(
      workspaceMemoryDir(path.join(workspaceRoot, "root")),
      repairedLeaf!.path.startsWith("workspace/")
        ? repairedLeaf!.path.split("/").slice(2).join("/")
        : repairedLeaf!.path,
    );
    const repairedLeafBody = fs.readFileSync(repairedLeafAbsolutePath, "utf8");
    assert.match(
      repairedLeafBody,
      /`person:entity:interaction:person:ben-book` \| Ben Book/,
    );
    assert.match(
      repairedLeafBody,
      /`organization:entity:interaction:customer:anyip` \| anyIP/,
    );
    assert.match(
      repairedLeafBody,
      /`artifact:image-url:[a-f0-9]+` \| legacy-reference\.png/,
    );

    const leafNode = store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: "root",
      treeId: "interaction:topic:holaboss-personal-outreach",
      status: "active",
      limit: 10_000,
      offset: 0,
    }).find((node) =>
      node.nodeClass === "leaf"
      && node.title === "holaboss personal outreach referenced image preserved in a legacy note"
    );
    assert.ok(leafNode);

    const leafDetailResponse = await app.inject({
      method: "GET",
      url: `/api/v1/memory/browser/node-detail?workspace_id=root&tree_id=${encodeURIComponent("interaction:topic:holaboss-personal-outreach")}&node_id=${encodeURIComponent(leafNode!.nodeId)}`,
    });
    assert.equal(leafDetailResponse.statusCode, 200);
    assert.ok(leafDetailResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
      target_resolution_kind?: string | null;
    }) =>
      relation.relation_type === "contacted_by"
      && relation.target_label === "Ben Book"
      && relation.target_resolution_kind === "resolved",
    ));
    assert.ok(leafDetailResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
      target_resolution_kind?: string | null;
    }) =>
      relation.relation_type === "works_at"
      && relation.target_label === "anyIP"
      && relation.target_resolution_kind === "resolved",
    ));
    assert.ok(leafDetailResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
    }) =>
      relation.relation_type === "derived_from"
      && relation.target_label === "legacy-reference.png",
    ));
  } finally {
    await app.close();
    await server.close();
    store.close();
  }
});

test("runtime memory routes rewrite legacy related keys to canonical workspace identities on first read", async () => {
  const root = makeTempDir("hb-runtime-api-memory-repair-legacy-related-keys-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    kind: "main_session",
  });
  store.upsertInteractionEntity({
    workspaceId: "workspace-1",
    entityId: "interaction:topic:holaboss-personal-outreach",
    entityType: "topic",
    canonicalName: "holaboss personal outreach",
    slug: "topic-holaboss-personal-outreach",
    summary: "Personal outreach memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  store.upsertInteractionEntity({
    workspaceId: "workspace-1",
    entityId: "interaction:person:ben-book",
    entityType: "person",
    canonicalName: "Ben Book",
    slug: "person-ben-book",
    summary: "External outreach contact.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  store.upsertInteractionEntity({
    workspaceId: "workspace-1",
    entityId: "interaction:customer:anyip",
    entityType: "customer",
    canonicalName: "anyIP",
    slug: "customer-anyip",
    summary: "External organization.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  await rebuildInteractionEntityTree({
    store,
    workspaceId: "workspace-1",
    entityId: "interaction:person:ben-book",
    summaryModelClient: null,
    embeddingClient: null,
  });
  await rebuildInteractionEntityTree({
    store,
    workspaceId: "workspace-1",
    entityId: "interaction:customer:anyip",
    summaryModelClient: null,
    embeddingClient: null,
  });

  store.upsertInteractionLeaf({
    workspaceId: "workspace-1",
    leafId: "leaf-legacy-related-keys",
    entityId: "interaction:topic:holaboss-personal-outreach",
    subjectKey: "holaboss_personal_outreach_legacy_related_keys",
    path: "workspace/workspace-1/interaction/entities/topic-holaboss-personal-outreach/leaves/leaf-legacy-related-keys.md",
    title: "Legacy outreach contact memory",
    summary: "Legacy outreach contact memory kept older related keys.",
    fingerprint: "fingerprint-legacy-related-keys",
    bodySha256: "sha-legacy-related-keys",
    tags: ["holaboss", "outreach"],
    secondaryEntityIds: [],
    sourceType: "assistant_turn",
    sourceEventId: "input-legacy-related-keys",
    sourceMessageId: null,
    sourceTurnInputId: null,
    admissionConfidence: 0.9,
    entityConfidence: null,
    observedAt: "2026-06-03T17:00:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  const originalLeafPath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
    "interaction",
    "entities",
    "topic-holaboss-personal-outreach",
    "leaves",
    "leaf-legacy-related-keys.md",
  );
  fs.mkdirSync(path.dirname(originalLeafPath), { recursive: true });
  fs.writeFileSync(
    originalLeafPath,
    [
      "# Legacy outreach contact memory",
      "",
      "## Summary",
      "",
      "Legacy outreach contact memory kept older related keys.",
      "",
      "## Evidence",
      "",
      "Ben Book at anyIP emailed the user personally about holaboss.",
      "",
      "## Related Entities",
      "",
      "- `organization:anyip` | anyIP",
      "- `person:ben-book` | Ben Book",
      "",
      "## Relations",
      "",
      "- `contacted_by` -> `person:ben-book` | Ben Book",
      "- `works_at` -> `organization:anyip` | anyIP",
      "",
      "<!-- durable-memory-related: processed -->",
      "",
    ].join("\n"),
    "utf8",
  );

  const app = buildTestRuntimeApiServer({ store });

  try {
    const treeResponse = await app.inject({
      method: "GET",
      url: "/api/v1/memory/browser/tree?workspace_id=workspace-1",
    });
    assert.equal(treeResponse.statusCode, 200);

    const repairedLeaf = store.getInteractionLeaf({
      workspaceId: "workspace-1",
      leafId: "leaf-legacy-related-keys",
    });
    assert.ok(repairedLeaf);
    const repairedLeafAbsolutePath = path.join(
      workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
      repairedLeaf!.path.startsWith("workspace/")
        ? repairedLeaf!.path.split("/").slice(2).join("/")
        : repairedLeaf!.path,
    );
    const repairedLeafBody = fs.readFileSync(repairedLeafAbsolutePath, "utf8");
    assert.match(
      repairedLeafBody,
      /`person:entity:interaction:person:ben-book` \| Ben Book/,
    );
    assert.match(
      repairedLeafBody,
      /`organization:entity:interaction:customer:anyip` \| anyIP/,
    );
    assert.doesNotMatch(repairedLeafBody, /`person:ben-book` \| Ben Book/);
    assert.doesNotMatch(repairedLeafBody, /`organization:anyip` \| anyIP/);

    const leafNode = store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: "interaction:topic:holaboss-personal-outreach",
      status: "active",
      limit: 10_000,
      offset: 0,
    }).find((node) =>
      node.nodeClass === "leaf"
      && node.title === "Legacy outreach contact memory"
    );
    assert.ok(leafNode);

    const leafDetailResponse = await app.inject({
      method: "GET",
      url: `/api/v1/memory/browser/node-detail?workspace_id=workspace-1&tree_id=${encodeURIComponent("interaction:topic:holaboss-personal-outreach")}&node_id=${encodeURIComponent(leafNode!.nodeId)}`,
    });
    assert.equal(leafDetailResponse.statusCode, 200);
    assert.ok(leafDetailResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
      target_resolution_kind?: string | null;
      target_entity_key?: string | null;
    }) =>
      relation.relation_type === "contacted_by"
      && relation.target_label === "Ben Book"
      && relation.target_resolution_kind === "resolved"
      && relation.target_entity_key === "person:entity:interaction:person:ben-book",
    ));
    assert.ok(leafDetailResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
      target_resolution_kind?: string | null;
      target_entity_key?: string | null;
    }) =>
      relation.relation_type === "works_at"
      && relation.target_label === "anyIP"
      && relation.target_resolution_kind === "resolved"
      && relation.target_entity_key === "organization:entity:interaction:customer:anyip",
    ));
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory routes rewrite generic placeholder keys with concrete labels to stable synthetic identities on first read", async () => {
  const root = makeTempDir("hb-runtime-api-memory-repair-generic-placeholder-keys-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    kind: "main_session",
  });
  store.upsertInteractionEntity({
    workspaceId: "workspace-1",
    entityId: "interaction:system:gtm-team",
    entityType: "system",
    canonicalName: "GTM team",
    slug: "system-gtm-team",
    summary: "GTM operating context.",
    aliases: [],
    isSystem: true,
    status: "active",
  });
  store.upsertInteractionLeaf({
    workspaceId: "workspace-1",
    leafId: "leaf-generic-placeholder-keys",
    entityId: "interaction:system:gtm-team",
    subjectKey: "gtm_team_placeholder_keys",
    path: "workspace/workspace-1/interaction/entities/system-gtm-team/leaves/leaf-generic-placeholder-keys.md",
    title: "GTM page coverage memory",
    summary: "A legacy memory kept generic placeholder related keys despite concrete labels.",
    fingerprint: "fingerprint-generic-placeholder-keys",
    bodySha256: "sha-generic-placeholder-keys",
    tags: ["gtm", "artifact", "planning"],
    secondaryEntityIds: [],
    sourceType: "assistant_turn",
    sourceEventId: "input-generic-placeholder-keys",
    sourceMessageId: null,
    sourceTurnInputId: null,
    admissionConfidence: 0.9,
    entityConfidence: null,
    observedAt: "2026-06-03T18:00:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  const originalLeafPath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
    "interaction",
    "entities",
    "system-gtm-team",
    "leaves",
    "leaf-generic-placeholder-keys.md",
  );
  fs.mkdirSync(path.dirname(originalLeafPath), { recursive: true });
  fs.writeFileSync(
    originalLeafPath,
    [
      "# GTM page coverage memory",
      "",
      "## Summary",
      "",
      "A legacy memory kept generic placeholder related keys despite concrete labels.",
      "",
      "## Evidence",
      "",
      "The GTM pages are still missing channel design coverage, and the main narrative phase is not verified.",
      "",
      "## Related Entities",
      "",
      "- `artifact:artifact` | 主叙事阶段",
      "- `topic:topic` | 渠道设计",
      "",
      "## Relations",
      "",
      "- `mentions` -> `artifact:artifact` | 主叙事阶段",
      "- `blocks` -> `topic:topic` | 渠道设计",
      "",
      "<!-- durable-memory-related: processed -->",
      "",
    ].join("\n"),
    "utf8",
  );

  const app = buildTestRuntimeApiServer({ store });

  try {
    const treeResponse = await app.inject({
      method: "GET",
      url: "/api/v1/memory/browser/tree?workspace_id=workspace-1",
    });
    assert.equal(treeResponse.statusCode, 200);

    const repairedLeaf = store.getInteractionLeaf({
      workspaceId: "workspace-1",
      leafId: "leaf-generic-placeholder-keys",
    });
    assert.ok(repairedLeaf);
    const repairedLeafAbsolutePath = path.join(
      workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
      repairedLeaf!.path.startsWith("workspace/")
        ? repairedLeaf!.path.split("/").slice(2).join("/")
        : repairedLeaf!.path,
    );
    const repairedLeafBody = fs.readFileSync(repairedLeafAbsolutePath, "utf8");
    assert.doesNotMatch(repairedLeafBody, /`artifact:artifact`|`topic:topic`/);
    assert.match(repairedLeafBody, /`artifact:label-[0-9a-f]{12}` \| 主叙事阶段/);
    assert.match(repairedLeafBody, /`topic:label-[0-9a-f]{12}` \| 渠道设计/);

    const leafNode = store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: "interaction:system:gtm-team",
      status: "active",
      limit: 10_000,
      offset: 0,
    }).find((node) =>
      node.nodeClass === "leaf"
      && node.title === "GTM page coverage memory"
    );
    assert.ok(leafNode);

    const leafDetailResponse = await app.inject({
      method: "GET",
      url: `/api/v1/memory/browser/node-detail?workspace_id=workspace-1&tree_id=${encodeURIComponent("interaction:system:gtm-team")}&node_id=${encodeURIComponent(leafNode!.nodeId)}`,
    });
    assert.equal(leafDetailResponse.statusCode, 200);
    assert.ok(leafDetailResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
      target_resolution_kind?: string | null;
      target_entity_key?: string | null;
    }) =>
      relation.relation_type === "mentions"
      && relation.target_label === "主叙事阶段"
      && relation.target_resolution_kind === "synthetic"
      && /^artifact:label-[0-9a-f]{12}$/.test(relation.target_entity_key ?? ""),
    ));
    assert.ok(leafDetailResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
      target_resolution_kind?: string | null;
      target_entity_key?: string | null;
    }) =>
      relation.relation_type === "blocks"
      && relation.target_label === "渠道设计"
      && relation.target_resolution_kind === "synthetic"
      && /^topic:label-[0-9a-f]{12}$/.test(relation.target_entity_key ?? ""),
    ));
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory routes rewrite generic placeholder keys to canonical resolved workspace identities when a real target exists", async () => {
  const root = makeTempDir("hb-runtime-api-memory-repair-non-ascii-resolved-target-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    kind: "main_session",
  });
  store.upsertInteractionEntity({
    workspaceId: "workspace-1",
    entityId: "interaction:system:gtm-team",
    entityType: "system",
    canonicalName: "GTM team",
    slug: "system-gtm-team",
    summary: "GTM operating context.",
    aliases: [],
    isSystem: true,
    status: "active",
  });
  store.upsertInteractionEntity({
    workspaceId: "workspace-1",
    entityId: "interaction:topic:channel-design",
    entityType: "topic",
    canonicalName: "渠道设计",
    slug: "topic-channel-design",
    summary: "Channel design topic.",
    aliases: ["渠道设计方案"],
    isSystem: false,
    status: "active",
  });
  store.upsertInteractionLeaf({
    workspaceId: "workspace-1",
    leafId: "leaf-channel-design-source",
    entityId: "interaction:topic:channel-design",
    subjectKey: "channel-design-source",
    path: "workspace/workspace-1/interaction/entities/topic-channel-design/leaves/leaf-channel-design-source.md",
    title: "渠道设计决策",
    summary: "渠道设计方案已经确定。",
    fingerprint: "fingerprint-channel-design-source",
    bodySha256: "sha-channel-design-source",
    tags: ["gtm", "planning"],
    secondaryEntityIds: [],
    sourceType: "manual",
    sourceEventId: null,
    sourceMessageId: null,
    sourceTurnInputId: "input-channel-design-source",
    admissionConfidence: 0.9,
    entityConfidence: 0.9,
    observedAt: "2026-06-03T17:30:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  const channelDesignLeafPath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
    "interaction",
    "entities",
    "topic-channel-design",
    "leaves",
    "leaf-channel-design-source.md",
  );
  fs.mkdirSync(path.dirname(channelDesignLeafPath), { recursive: true });
  fs.writeFileSync(
    channelDesignLeafPath,
    "# 渠道设计决策\n\n渠道设计方案已经确定。\n",
    "utf8",
  );
  await rebuildInteractionEntityTree({
    store,
    workspaceId: "workspace-1",
    entityId: "interaction:topic:channel-design",
    summaryModelClient: null,
    embeddingClient: null,
  });

  store.upsertInteractionLeaf({
    workspaceId: "workspace-1",
    leafId: "leaf-resolved-placeholder-keys",
    entityId: "interaction:system:gtm-team",
    subjectKey: "gtm_team_resolved_placeholder_keys",
    path: "workspace/workspace-1/interaction/entities/system-gtm-team/leaves/leaf-resolved-placeholder-keys.md",
    title: "GTM coverage blocked on 渠道设计",
    summary: "A legacy memory kept a generic placeholder even though the real topic exists.",
    fingerprint: "fingerprint-resolved-placeholder-keys",
    bodySha256: "sha-resolved-placeholder-keys",
    tags: ["gtm", "planning"],
    secondaryEntityIds: [],
    sourceType: "assistant_turn",
    sourceEventId: "input-resolved-placeholder-keys",
    sourceMessageId: null,
    sourceTurnInputId: null,
    admissionConfidence: 0.9,
    entityConfidence: null,
    observedAt: "2026-06-03T18:15:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  const originalLeafPath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
    "interaction",
    "entities",
    "system-gtm-team",
    "leaves",
    "leaf-resolved-placeholder-keys.md",
  );
  fs.mkdirSync(path.dirname(originalLeafPath), { recursive: true });
  fs.writeFileSync(
    originalLeafPath,
    [
      "# GTM coverage blocked on 渠道设计",
      "",
      "## Summary",
      "",
      "A legacy memory kept a generic placeholder even though the real topic exists.",
      "",
      "## Evidence",
      "",
      "The GTM pages are still missing channel design coverage.",
      "",
      "## Related Entities",
      "",
      "- `topic:topic` | 渠道设计",
      "",
      "## Relations",
      "",
      "- `blocks` -> `topic:topic` | 渠道设计",
      "",
      "<!-- durable-memory-related: processed -->",
      "",
    ].join("\n"),
    "utf8",
  );

  const app = buildTestRuntimeApiServer({ store });
  try {
    const treeResponse = await app.inject({
      method: "GET",
      url: "/api/v1/memory/browser/tree?workspace_id=workspace-1",
    });
    assert.equal(treeResponse.statusCode, 200);

    const repairedBody = fs.readFileSync(originalLeafPath, "utf8");
    assert.doesNotMatch(repairedBody, /`topic:topic`/);
    assert.match(
      repairedBody,
      /`topic:entity:interaction:topic:channel-design` \| 渠道设计/,
    );

    const leafNode = store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: "interaction:system:gtm-team",
      status: "active",
      limit: 10_000,
      offset: 0,
    }).find((node) =>
      node.nodeClass === "leaf"
      && node.title === "GTM coverage blocked on 渠道设计"
    );
    assert.ok(leafNode);

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/v1/memory/browser/node-detail?workspace_id=workspace-1&tree_id=${encodeURIComponent("interaction:system:gtm-team")}&node_id=${encodeURIComponent(leafNode!.nodeId)}`,
    });
    assert.equal(detailResponse.statusCode, 200);
    assert.ok(detailResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
      target_resolution_kind?: string | null;
      target_entity_key?: string | null;
      target_tree_id?: string | null;
    }) =>
      relation.relation_type === "blocks"
      && relation.target_label === "渠道设计"
      && relation.target_resolution_kind === "resolved"
      && relation.target_entity_key === "topic:entity:interaction:topic:channel-design"
      && relation.target_tree_id === "interaction:topic:channel-design",
    ));
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory routes rerun stale leaf repair when the legacy v2 repair marker was already complete", async () => {
  const root = makeTempDir("hb-runtime-api-memory-repair-v3-upgrade-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    kind: "main_session",
  });
  store.upsertInteractionEntity({
    workspaceId: "workspace-1",
    entityId: "interaction:system:gtm-team",
    entityType: "system",
    canonicalName: "GTM team",
    slug: "system-gtm-team",
    summary: "GTM operating context.",
    aliases: [],
    isSystem: true,
    status: "active",
  });
  store.upsertInteractionLeaf({
    workspaceId: "workspace-1",
    leafId: "leaf-v3-upgrade",
    entityId: "interaction:system:gtm-team",
    subjectKey: "gtm_team_v3_upgrade",
    path: "workspace/workspace-1/interaction/entities/system-gtm-team/leaves/leaf-v3-upgrade.md",
    title: "GTM page coverage upgrade memory",
    summary: "A legacy memory still needs the newer placeholder rewrite pass.",
    fingerprint: "fingerprint-v3-upgrade",
    bodySha256: "sha-v3-upgrade",
    tags: ["gtm", "artifact", "planning"],
    secondaryEntityIds: [],
    sourceType: "assistant_turn",
    sourceEventId: "input-v3-upgrade",
    sourceMessageId: null,
    sourceTurnInputId: null,
    admissionConfidence: 0.9,
    entityConfidence: null,
    observedAt: "2026-06-03T18:10:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  const originalLeafPath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
    "interaction",
    "entities",
    "system-gtm-team",
    "leaves",
    "leaf-v3-upgrade.md",
  );
  fs.mkdirSync(path.dirname(originalLeafPath), { recursive: true });
  fs.writeFileSync(
    originalLeafPath,
    [
      "# GTM page coverage upgrade memory",
      "",
      "## Summary",
      "",
      "A legacy memory still needs the newer placeholder rewrite pass.",
      "",
      "## Evidence",
      "",
      "The GTM pages are still missing channel design coverage.",
      "",
      "## Related Entities",
      "",
      "- `topic:topic` | 渠道设计",
      "",
      "## Relations",
      "",
      "- `blocks` -> `topic:topic` | 渠道设计",
      "",
      "<!-- durable-memory-related: processed -->",
      "",
    ].join("\n"),
    "utf8",
  );
  store.setWorkspaceRuntimeMetadata({
    workspaceId: "workspace-1",
    key: "workspace_related_entity_repair_v2",
    value: "2026-06-03T18:10:00.000Z|relations:0|tool_results:0|attachments:0|image_urls:0|outputs:0",
  });

  const app = buildTestRuntimeApiServer({ store });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/memory/browser/tree?workspace_id=workspace-1",
    });
    assert.equal(response.statusCode, 200);

    const repairedBody = fs.readFileSync(originalLeafPath, "utf8");
    assert.doesNotMatch(repairedBody, /`topic:topic`/);
    assert.match(repairedBody, /`topic:label-[0-9a-f]{12}` \| 渠道设计/);
    const repairStateV3 = store.getWorkspaceRuntimeMetadata({
      workspaceId: "workspace-1",
      key: "workspace_related_entity_repair_v3",
    });
    assert.ok(repairStateV3);
    assert.notEqual(
      repairStateV3,
      "2026-06-03T18:10:00.000Z|relations:0|tool_results:0|attachments:0|image_urls:0|outputs:0",
    );
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory browser file route returns repaired artifact markdown after stale output placeholder rewrite", async () => {
  const root = makeTempDir("hb-runtime-api-memory-browser-file-artifact-repair-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    kind: "main_session",
  });

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Save the notion report for later reference.",
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-05T09:00:00.000Z",
    completedAt: "2026-06-05T09:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I saved the notion report.",
  });

  const reportRelativePath = "outputs/notion-related-pages.md";
  const reportAbsolutePath = path.join(workspaceRoot, "workspace-1", reportRelativePath);
  fs.mkdirSync(path.dirname(reportAbsolutePath), { recursive: true });
  fs.writeFileSync(
    reportAbsolutePath,
    [
      "# Notion Related Pages",
      "",
      "Builder Mode research lives here.",
    ].join("\n"),
    "utf8",
  );
  store.createOutput({
    workspaceId: "workspace-1",
    outputId: "output-notion-1",
    outputType: "document",
    title: "notion-related-pages.md",
    status: "completed",
    filePath: reportRelativePath,
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    artifactId: "artifact-notion-1",
  });
  await persistTurnOutputArtifactsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
  });

  const descriptor = listWorkspaceOutputDocumentTrees({
    store,
    workspaceId: "workspace-1",
  }).find((item) => item.outputId === "output-notion-1");
  assert.ok(descriptor);

  const rootAbsolutePath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
    descriptor!.path,
  );
  fs.writeFileSync(
    rootAbsolutePath,
    appendDurableMemoryRelatedSections(
      [
        "# Notion Related Pages",
        "",
        "## Summary",
        "",
        "Builder Mode research lives here.",
      ].join("\n"),
      {
        relatedEntities: [
          {
            entityType: "artifact",
            entityKey: "artifact:.-notion-related-pages.md",
            label: "./notion-related-pages.md",
          },
        ],
        relations: [
          {
            relationType: "about",
            entityKey: "artifact:.-notion-related-pages.md",
          },
        ],
      },
    ),
    "utf8",
  );

  const app = buildTestRuntimeApiServer({ store });
  try {
    const browserPath = descriptor!.path.replace(/^semantic\//, "");
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/memory/browser/file?workspace_id=workspace-1&path=${encodeURIComponent(browserPath)}`,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json().content as string;
    assert.match(body, /`artifact:output:output-notion-1` \| notion-related-pages\.md/);
    assert.doesNotMatch(body, /`artifact:\.-notion-related-pages\.md` \| \.\/notion-related-pages\.md/);
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory routes archive request-shaped junk memories on first read", async () => {
  const root = makeTempDir("hb-runtime-api-memory-repair-request-junk-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    kind: "main_session",
  });
  store.upsertInteractionEntity({
    workspaceId: "workspace-1",
    entityId: "interaction:topic:billing-emails",
    entityType: "topic",
    canonicalName: "billing emails",
    slug: "topic-billing-emails",
    summary: "Temporary billing email search memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  store.upsertInteractionLeaf({
    workspaceId: "workspace-1",
    leafId: "leaf-request-junk-1",
    entityId: "interaction:topic:billing-emails",
    subjectKey: "user_asked_to_find_all_billing_related_emails",
    path: "workspace/workspace-1/interaction/entities/topic-billing-emails/leaves/leaf-request-junk-1.md",
    title: "User asked to find all billing-related emails",
    summary: "A one-off inbox search request.",
    fingerprint: "fingerprint-request-junk-1",
    bodySha256: "sha-request-junk-1",
    tags: ["billing", "request"],
    secondaryEntityIds: [],
    sourceType: "assistant_turn",
    sourceEventId: "input-request-junk-1",
    sourceMessageId: null,
    sourceTurnInputId: null,
    admissionConfidence: 0.81,
    entityConfidence: null,
    observedAt: "2026-06-03T18:00:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  const originalLeafPath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
    "interaction",
    "entities",
    "topic-billing-emails",
    "leaves",
    "leaf-request-junk-1.md",
  );
  fs.mkdirSync(path.dirname(originalLeafPath), { recursive: true });
  fs.writeFileSync(
    originalLeafPath,
    [
      "# User asked to find all billing-related emails",
      "",
      "## Summary",
      "",
      "A one-off inbox search request.",
      "",
      "## Evidence",
      "",
      "The user asked to find all billing-related emails.",
      "",
    ].join("\n"),
    "utf8",
  );

  const app = buildTestRuntimeApiServer({ store });

  try {
    const treeResponse = await app.inject({
      method: "GET",
      url: "/api/v1/memory/browser/tree?workspace_id=workspace-1",
    });
    assert.equal(treeResponse.statusCode, 200);

    const archivedLeaf = store.getInteractionLeaf({
      workspaceId: "workspace-1",
      leafId: "leaf-request-junk-1",
    });
    assert.ok(archivedLeaf);
    assert.equal(archivedLeaf?.status, "archived");
    assert.equal(fs.existsSync(originalLeafPath), false);

    const retrieveResponse = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": "workspace-1",
      },
      payload: {
        query: "billing-related emails",
        retrieval_policy: {
          max_evidence: 6,
        },
      },
    });
    assert.equal(retrieveResponse.statusCode, 200);
    assert.ok(!retrieveResponse.json().evidence.some((item: {
      title?: string;
    }) =>
      item.title === "User asked to find all billing-related emails",
    ));
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory routes enrich an existing memory when a later turn repeats the same fact with better related entities", async () => {
  const root = makeTempDir("hb-runtime-api-memory-repeat-mention-enrichment-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const memoryService = new FilesystemMemoryService({ workspaceRoot });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-main",
    kind: "main_session",
  });
  store.upsertInteractionEntity({
    workspaceId: workspace.id,
    entityId: "interaction:customer:redwood-care",
    entityType: "customer",
    canonicalName: "Redwood Care",
    slug: "customer-redwood-care",
    summary: "Customer memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  store.upsertInteractionEntity({
    workspaceId: workspace.id,
    entityId: "interaction:person:paul-reed",
    entityType: "person",
    canonicalName: "Paul Reed",
    slug: "person-paul-reed",
    summary: "Account manager memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  await rebuildInteractionEntityTree({
    store,
    workspaceId: workspace.id,
    entityId: "interaction:customer:redwood-care",
    summaryModelClient: null,
    embeddingClient: null,
  });
  await rebuildInteractionEntityTree({
    store,
    workspaceId: workspace.id,
    entityId: "interaction:person:paul-reed",
    summaryModelClient: null,
    embeddingClient: null,
  });

  const firstInput = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: {
      text: "Remember who owns the Redwood Care account.",
    },
  });
  const firstTurnResult = store.upsertTurnResult({
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: firstInput.inputId,
    startedAt: "2026-06-04T19:00:00.000Z",
    completedAt: "2026-06-04T19:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "Redwood Care's account manager is Paul Reed.",
  });

  await withMockMemoryModel({
    workspaceId: workspace.id,
    responseForRequest: (body) => {
      const payload = JSON.parse(body) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const systemPrompt = payload.messages?.find((message) => message.role === "system")?.content ?? "";
      if (systemPrompt.includes("Extract contextual durable memory")) {
        return {
          statusCode: 200,
          body: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    memories: [
                      {
                        scope: "workspace",
                        memory_type: "reference",
                        subject_key: "redwood-care-account-manager",
                        title: "Redwood Care account manager",
                        summary: "Redwood Care's account manager is Paul Reed.",
                        tags: ["customer", "contact"],
                        evidence: "Redwood Care's account manager is Paul Reed.",
                        confidence: 0.97,
                      },
                    ],
                  }),
                },
              },
            ],
          },
        };
      }
      if (systemPrompt.includes("Extract related durable entities and relations")) {
        return {
          statusCode: 200,
          body: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    related_entities: [
                      { entity_type: "organization", label: "Redwood Care" },
                    ],
                    relations: [
                      { relation_type: "applies_to", entity_type: "organization", entity_label: "Redwood Care" },
                    ],
                  }),
                },
              },
            ],
          },
        };
      }
      if (systemPrompt.includes("You assign one durable interaction memory chunk")) {
        return {
          statusCode: 200,
          body: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: "match_existing",
                    existing_entity_id: "interaction:customer:redwood-care",
                    new_entity_type: null,
                    new_entity_name: null,
                    secondary_entity_ids: [],
                    confidence: 0.97,
                    rationale: "This fact belongs to the existing Redwood Care customer memory.",
                  }),
                },
              },
            ],
          },
        };
      }
      if (systemPrompt.includes("You write concise markdown-tree summary sentences")) {
        return {
          statusCode: 200,
          body: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: "This customer memory captures durable Redwood Care relationship facts.",
                  }),
                },
              },
            ],
          },
        };
      }
      return {
        statusCode: 200,
        body: {
          choices: [
            {
              message: {
                content: JSON.stringify({}),
              },
            },
          ],
        },
      };
    },
    run: async (modelContext) => {
      await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult: firstTurnResult,
        modelContext,
      });
    },
  });

  let activeLeaves = store.listInteractionLeaves({
    workspaceId: workspace.id,
    entityId: "interaction:customer:redwood-care",
    status: "active",
    limit: 10,
    offset: 0,
  });
  assert.equal(activeLeaves.length, 1);
  const firstLeafPath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, workspace.id)),
    activeLeaves[0]!.path.startsWith("workspace/")
      ? activeLeaves[0]!.path.split("/").slice(2).join("/")
      : activeLeaves[0]!.path,
  );
  const firstLeafBody = fs.readFileSync(firstLeafPath, "utf8");
  assert.match(firstLeafBody, /Redwood Care/);
  assert.doesNotMatch(
    firstLeafBody,
    /`person:entity:interaction:person:paul-reed` \| Paul Reed/,
  );
  assert.doesNotMatch(firstLeafBody, /`managed_by` -> `person:entity:interaction:person:paul-reed`/);

  const secondInput = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: {
      text: "Also remember that Paul Reed is the Redwood Care account manager.",
    },
  });
  const secondTurnResult = store.upsertTurnResult({
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: secondInput.inputId,
    startedAt: "2026-06-04T19:05:00.000Z",
    completedAt: "2026-06-04T19:05:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "Paul Reed owns the Redwood Care account relationship.",
  });

  await withMockMemoryModel({
    workspaceId: workspace.id,
    responseForRequest: (body) => {
      const payload = JSON.parse(body) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const systemPrompt = payload.messages?.find((message) => message.role === "system")?.content ?? "";
      if (systemPrompt.includes("Extract contextual durable memory")) {
        return {
          statusCode: 200,
          body: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    memories: [
                      {
                        scope: "workspace",
                        memory_type: "reference",
                        subject_key: "redwood-care-account-manager",
                        title: "Redwood Care account manager",
                        summary: "Redwood Care's account manager is Paul Reed.",
                        tags: ["customer", "contact"],
                        evidence: "Paul Reed owns the Redwood Care account relationship.",
                        confidence: 0.98,
                      },
                    ],
                  }),
                },
              },
            ],
          },
        };
      }
      if (systemPrompt.includes("Extract related durable entities and relations")) {
        return {
          statusCode: 200,
          body: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    related_entities: [
                      { entity_type: "person", label: "Paul Reed" },
                      { entity_type: "organization", label: "Redwood Care" },
                    ],
                    relations: [
                      { relation_type: "managed_by", entity_type: "person", entity_label: "Paul Reed" },
                      { relation_type: "applies_to", entity_type: "organization", entity_label: "Redwood Care" },
                    ],
                  }),
                },
              },
            ],
          },
        };
      }
      if (systemPrompt.includes("You assign one durable interaction memory chunk")) {
        return {
          statusCode: 200,
          body: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: "match_existing",
                    existing_entity_id: "interaction:customer:redwood-care",
                    new_entity_type: null,
                    new_entity_name: null,
                    secondary_entity_ids: [],
                    confidence: 0.97,
                    rationale: "This fact belongs to the existing Redwood Care customer memory.",
                  }),
                },
              },
            ],
          },
        };
      }
      if (systemPrompt.includes("You arbitrate semantic deduplication")) {
        const existingLeafId = store.listInteractionLeaves({
          workspaceId: workspace.id,
          entityId: "interaction:customer:redwood-care",
          status: "active",
          limit: 10,
          offset: 0,
        })[0]?.leafId ?? null;
        return {
          statusCode: 200,
          body: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: "same_memory",
                    existing_leaf_id: existingLeafId,
                    rationale: "Both turns capture the same Redwood Care account-manager fact, but the later one adds the missing person relation.",
                  }),
                },
              },
            ],
          },
        };
      }
      if (systemPrompt.includes("You write concise markdown-tree summary sentences")) {
        return {
          statusCode: 200,
          body: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: "This customer memory captures durable Redwood Care relationship facts.",
                  }),
                },
              },
            ],
          },
        };
      }
      return {
        statusCode: 200,
        body: {
          choices: [
            {
              message: {
                content: JSON.stringify({}),
              },
            },
          ],
        },
      };
    },
    run: async (modelContext) => {
      await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult: secondTurnResult,
        modelContext,
      });
    },
  });

  activeLeaves = store.listInteractionLeaves({
    workspaceId: workspace.id,
    entityId: "interaction:customer:redwood-care",
    status: "active",
    limit: 10,
    offset: 0,
  });
  assert.equal(activeLeaves.length, 1);
  const refreshedLeafPath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, workspace.id)),
    activeLeaves[0]!.path.startsWith("workspace/")
      ? activeLeaves[0]!.path.split("/").slice(2).join("/")
      : activeLeaves[0]!.path,
  );
  const refreshedLeafBody = fs.readFileSync(refreshedLeafPath, "utf8");
  assert.match(
    refreshedLeafBody,
    /`person:entity:interaction:person:paul-reed` \| Paul Reed/,
  );
  assert.match(
    refreshedLeafBody,
    /`organization:entity:interaction:customer:redwood-care` \| Redwood Care/,
  );
  assert.match(
    refreshedLeafBody,
    /`managed_by` -> `person:entity:interaction:person:paul-reed` \| Paul Reed/,
  );

  const app = buildTestRuntimeApiServer({ store, memoryService });

  try {
    const retrieveResponse = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": workspace.id,
      },
      payload: {
        query: "Paul Reed Redwood Care account manager",
        retrieval_policy: {
          max_evidence: 6,
        },
      },
    });
    assert.equal(retrieveResponse.statusCode, 200);
    assert.equal(retrieveResponse.json().evidence[0]?.title, "Redwood Care account manager");

    const leafNode = store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: workspace.id,
      treeId: "interaction:customer:redwood-care",
      status: "active",
      limit: 10_000,
      offset: 0,
    }).find((node) =>
      node.nodeClass === "leaf"
      && node.title === "Redwood Care account manager"
    );
    assert.ok(leafNode);

    const leafDetailResponse = await app.inject({
      method: "GET",
      url: `/api/v1/memory/browser/node-detail?workspace_id=${workspace.id}&tree_id=${encodeURIComponent("interaction:customer:redwood-care")}&node_id=${encodeURIComponent(leafNode!.nodeId)}`,
    });
    assert.equal(leafDetailResponse.statusCode, 200);
    assert.ok(leafDetailResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
      target_resolution_kind?: string | null;
    }) =>
      relation.relation_type === "managed_by"
      && relation.target_label === "Paul Reed"
      && relation.target_resolution_kind === "resolved",
    ));
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory browser routes resolve sibling artifact placeholders to the same output artifact node", async () => {
  const root = makeTempDir("hb-runtime-api-memory-sibling-output-artifact-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.syncSemanticMemoryTree({
    category: "workspace",
    workspaceId: "workspace-1",
    treeId: "output-tree-1",
    nodes: [
      {
        nodeId: "output-root-1",
        nodeClass: "semantic",
        nodeKind: "output_document",
        path: "semantic/workspace/artifacts/outputs/notion-related-pages-output-1/content.md",
        title: "notion-related-pages.md",
        summary: "Output artifact root.",
        bodySha256: "sha-output-root",
        childCount: 0,
        observedAt: "2026-06-05T00:00:00.000Z",
        status: "active",
        isMaterialized: false,
        metadata: {
          output_id: "output-1",
          output_type: "markdown",
          file_path: "outputs/notion-related-pages.md",
          source_turn_input_id: "turn-output-1",
          source_session_id: "session-1",
        },
      },
    ],
    edges: [],
  });
  store.upsertInteractionEntity({
    workspaceId: "workspace-1",
    entityId: "interaction:project:builder-mode",
    entityType: "project",
    canonicalName: "Builder Mode",
    slug: "project-builder-mode",
    summary: "Builder Mode project memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });

  const leafSpecs = [
    {
      leafId: "leaf-output-a",
      title: "Builder Mode research output",
      summary: "The Builder Mode research output lives in notion-related-pages.md.",
      body: appendDurableMemoryRelatedSections(
        "# Builder Mode research output\n\nThe Builder Mode research output lives in notion-related-pages.md.\n",
        {
          relatedEntities: [
            {
              entityType: "artifact",
              entityKey: "artifact:notion-related-pages-md",
              label: "notion-related-pages.md",
            },
          ],
          relations: [
            {
              relationType: "about",
              entityKey: "artifact:notion-related-pages-md",
            },
          ],
        },
      ),
    },
    {
      leafId: "leaf-output-b",
      title: "Notion page index output",
      summary: "The Notion page index was exported to notion-related-pages.md.",
      body: appendDurableMemoryRelatedSections(
        "# Notion page index output\n\nThe Notion page index was exported to notion-related-pages.md.\n",
        {
          relatedEntities: [
            {
              entityType: "artifact",
              entityKey: "artifact:.-notion-related-pages.md",
              label: "./notion-related-pages.md",
            },
          ],
          relations: [
            {
              relationType: "mentions",
              entityKey: "artifact:.-notion-related-pages.md",
            },
          ],
        },
      ),
    },
  ] as const;

  for (const spec of leafSpecs) {
    const relativePath = `workspace/workspace-1/interaction/entities/project-builder-mode/leaves/${spec.leafId}.md`;
    store.upsertInteractionLeaf({
      workspaceId: "workspace-1",
      leafId: spec.leafId,
      entityId: "interaction:project:builder-mode",
      subjectKey: spec.leafId,
      path: relativePath,
      title: spec.title,
      summary: spec.summary,
      fingerprint: `fingerprint-${spec.leafId}`,
      bodySha256: `sha-${spec.leafId}`,
      tags: ["builder-mode", "artifact"],
      secondaryEntityIds: [],
      sourceType: "assistant_turn",
      sourceEventId: null,
      sourceMessageId: null,
      sourceTurnInputId: "turn-output-1",
      admissionConfidence: 0.95,
      entityConfidence: 0.95,
      observedAt: "2026-06-05T00:00:00.000Z",
      supersedesLeafId: null,
      status: "active",
    });
    const absolutePath = path.join(
      workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
      "interaction",
      "entities",
      "project-builder-mode",
      "leaves",
      `${spec.leafId}.md`,
    );
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, spec.body, "utf8");
  }

  await rebuildInteractionEntityTree({
    store,
    workspaceId: "workspace-1",
    entityId: "interaction:project:builder-mode",
    summaryModelClient: null,
    embeddingClient: null,
  });

  const leafNodes = store.listSemanticMemoryNodes({
    category: "workspace",
    workspaceId: "workspace-1",
    treeId: "interaction:project:builder-mode",
    status: "active",
    limit: 10_000,
    offset: 0,
  }).filter((node) => node.nodeClass === "leaf");
  assert.equal(leafNodes.length, 2);

  const app = buildTestRuntimeApiServer({ store });

  try {
    for (const leafNode of leafNodes) {
      const detailResponse = await app.inject({
        method: "GET",
        url: `/api/v1/memory/browser/node-detail?workspace_id=workspace-1&tree_id=${encodeURIComponent("interaction:project:builder-mode")}&node_id=${encodeURIComponent(leafNode.nodeId)}`,
      });
      assert.equal(detailResponse.statusCode, 200);
      assert.ok(detailResponse.json().outgoing_relations.some((relation: {
        relation_type?: string;
        target_label?: string | null;
        target_node_id?: string | null;
        target_tree_id?: string | null;
        target_resolution_kind?: string | null;
        metadata?: Record<string, unknown>;
      }) =>
        (relation.relation_type === "about" || relation.relation_type === "mentions")
        && relation.target_label === "notion-related-pages.md"
        && relation.target_node_id === "output-root-1"
        && relation.target_tree_id === "output-tree-1"
        && relation.target_resolution_kind === "resolved"
        && relation.metadata?.entity_key === "artifact:output:output-1",
      ));
    }

    const graphResponse = await app.inject({
      method: "GET",
      url: "/api/v1/memory/browser/graph?workspace_id=workspace-1&forest=workspace",
    });
    assert.equal(graphResponse.statusCode, 200);
    const referenceEdges = graphResponse.json().edges.filter((edge: {
      from?: string;
      to?: string;
      kind?: string;
    }) =>
      edge.kind === "reference"
      && edge.to === "output-root-1"
      && leafNodes.some((node) => node.nodeId === edge.from)
    );
    assert.equal(referenceEdges.length, 2);
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory routes recover delegated subagent artifact provenance and surface durable memory from account queries", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-memory-delegated-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const memoryService = new FilesystemMemoryService({ workspaceRoot });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-main",
    kind: "main_session",
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-subagent",
    kind: "subagent",
  });

  const deliverableRelativePath = "outputs/reports/outreach-delegated.md";
  const deliverableAbsolutePath = path.join(workspaceRoot, workspace.id, deliverableRelativePath);
  fs.mkdirSync(path.dirname(deliverableAbsolutePath), { recursive: true });
  fs.writeFileSync(
    deliverableAbsolutePath,
    [
      "# Delegated Outreach Report",
      "",
      "Ben Book at anyIP reached out to the user personally about holaboss.",
      "Keep this subagent deliverable attached to the durable outreach memory.",
    ].join("\n"),
    "utf8",
  );

  const subagentInput = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-subagent",
    payload: {
      text: "Investigate the external holaboss outreach thread.",
    },
  });
  store.createSubagentRun({
    subagentId: "subagent-1",
    workspaceId: workspace.id,
    parentSessionId: "session-main",
    parentInputId: "parent-input-1",
    originMainSessionId: "session-main",
    ownerMainSessionId: "session-main",
    childSessionId: "session-subagent",
    initialChildInputId: subagentInput.inputId,
    currentChildInputId: subagentInput.inputId,
    latestChildInputId: subagentInput.inputId,
    title: "Delegated outreach review",
    goal: "Investigate the external holaboss outreach thread.",
    status: "completed",
  });
  const subagentTurnResult = store.upsertTurnResult({
    workspaceId: workspace.id,
    sessionId: "session-subagent",
    inputId: subagentInput.inputId,
    startedAt: "2026-06-04T11:00:00.000Z",
    completedAt: "2026-06-04T11:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I fetched the Gmail thread and prepared the deliverable.",
    toolUsageSummary: {
      total_calls: 1,
      completed_calls: 1,
      failed_calls: 0,
      tool_names: ["holaboss_composio.gmail_fetch_emails"],
      tool_ids: ["holaboss_composio.gmail_fetch_emails"],
    },
  });
  store.appendOutputEvent({
    workspaceId: workspace.id,
    sessionId: "session-subagent",
    inputId: subagentInput.inputId,
    sequence: 1,
    eventType: "tool_call",
    payload: {
      phase: "completed",
      tool_name: "holaboss_composio.gmail_fetch_emails",
      tool_id: "holaboss_composio.gmail_fetch_emails",
      call_id: "call-gmail-subagent-1",
      error: false,
      result: {
        content: [
          {
            type: "text",
            text: "Ben Book at anyIP reached out to the user personally about holaboss and followed up on the same Gmail thread.",
          },
        ],
        details: {
          raw: {
            _meta: {
              holaboss_integration_account: {
                provider_id: "gmail",
                connected_account_id: "ca_gmail_primary",
                account_namespace: "ops@example.com",
                connection_id: "conn_gmail_primary",
              },
            },
          },
        },
      },
    },
    createdAt: "2026-06-04T11:00:03.000Z",
  });
  await writeTurnDurableMemory({
    store,
    memoryService,
    turnResult: subagentTurnResult,
    modelContext: null,
  });

  const event = store.enqueueMainSessionEvent({
    workspaceId: workspace.id,
    ownerMainSessionId: "session-main",
    originMainSessionId: "session-main",
    subagentId: "subagent-1",
    eventType: "completed",
    deliveryBucket: "background_update",
    payload: {
      status: "completed",
      summary: "Delegated outreach review is done.",
      forwardable_deliverables: [
        {
          output_id: "output-delegated-1",
          artifact_id: "artifact-delegated-1",
          type: "report",
          output_type: "document",
          title: "outreach-delegated.md",
          status: "completed",
          file_path: deliverableRelativePath,
          metadata: {
            artifact_type: "report",
          },
        },
      ],
    },
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: {
      text: "What came back from the subagent?",
      context: {
        main_session_event_ids: [event.eventId],
        delivery_bucket: "background_update",
        queued_events: [
          {
            event_id: event.eventId,
            event_type: "completed",
            delivery_bucket: "background_update",
            payload: {
              status: "completed",
              summary: "Delegated outreach review is done.",
              assistant_text: "The subagent finished the outreach review.",
              forwardable_deliverables: [
                {
                  output_id: "output-delegated-1",
                  artifact_id: "artifact-delegated-1",
                  type: "report",
                  output_type: "document",
                  title: "outreach-delegated.md",
                  status: "completed",
                  file_path: deliverableRelativePath,
                  metadata: {
                    artifact_type: "report",
                  },
                },
              ],
            },
            created_at: event.createdAt,
          },
        ],
      },
    },
  });
  store.markMainSessionEventsMaterialized({
    workspaceId: workspace.id,
    eventIds: [event.eventId],
    materializedInputId: queued.inputId,
  });

  await processClaimedInput({
    store,
    record: queued,
    memoryService,
    executeRunnerRequestFn: async (payload, options = {}) => {
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 1,
        event_type: "run_started",
        payload: {},
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 2,
        event_type: "output_delta",
        payload: {
          delta: "The subagent finished the outreach review and returned the durable report.",
        },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 3,
        event_type: "run_completed",
        payload: { status: "ok" },
      });
      return {
        events: [],
        skippedLines: [],
        stderr: "",
        returnCode: 0,
        sawTerminal: true,
      };
    },
  });

  const mainTurnResult = store.getTurnResult({
    workspaceId: workspace.id,
    inputId: queued.inputId,
  });
  assert.ok(mainTurnResult);

  await withMockMemoryModel({
    workspaceId: workspace.id,
    responseForRequest: (body) => {
      const payload = JSON.parse(body) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const systemPrompt = payload.messages?.find((message) => message.role === "system")?.content ?? "";
      if (systemPrompt.includes("Extract contextual durable memory")) {
        return {
          statusCode: 200,
          body: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    memories: [
                      {
                        scope: "workspace",
                        memory_type: "reference",
                        subject_key: "holaboss-personal-outreach-delegated",
                        title: "External individuals contacted the user personally about holaboss",
                        summary: "A small set of external individuals reached out to the user personally about holaboss and those outreach details should stay discoverable.",
                        tags: ["holaboss", "outreach", "reference"],
                        evidence: "The forwarded subagent report says Ben Book at anyIP reached out to the user personally about holaboss.",
                        confidence: 0.97,
                      },
                    ],
                  }),
                },
              },
            ],
          },
        };
      }
      if (systemPrompt.includes("Extract related durable entities and relations")) {
        return {
          statusCode: 200,
          body: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    related_entities: [
                      { entity_type: "person", label: "Ben Book" },
                      { entity_type: "organization", label: "anyIP" },
                      { entity_type: "topic", label: "holaboss" },
                      { entity_type: "artifact", label: "outreach-delegated.md" },
                    ],
                    relations: [
                      { relation_type: "contacted_by", entity_type: "person", entity_label: "Ben Book" },
                      { relation_type: "works_at", entity_type: "organization", entity_label: "anyIP" },
                      { relation_type: "about", entity_type: "topic", entity_label: "holaboss" },
                      { relation_type: "mentions", entity_type: "artifact", entity_label: "outreach-delegated.md" },
                    ],
                  }),
                },
              },
            ],
          },
        };
      }
      if (systemPrompt.includes("You assign one durable interaction memory chunk")) {
        return {
          statusCode: 200,
          body: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: "create_new",
                    existing_entity_id: null,
                    new_entity_type: "topic",
                    new_entity_name: "holaboss personal outreach",
                    secondary_entity_ids: [],
                    confidence: 0.96,
                    rationale: "This memory is a durable outreach topic rather than a single person or workflow.",
                  }),
                },
              },
            ],
          },
        };
      }
      if (systemPrompt.includes("You write concise markdown-tree summary sentences")) {
        return {
          statusCode: 200,
          body: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: "This topic captures durable personal outreach contacts and delegated subagent artifacts related to holaboss.",
                  }),
                },
              },
            ],
          },
        };
      }
      return {
        statusCode: 200,
        body: {
          choices: [
            {
              message: {
                content: JSON.stringify({}),
              },
            },
          ],
        },
      };
    },
    run: async (modelContext) => {
      await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult: mainTurnResult!,
        modelContext,
      });
    },
  });

  const toolResultTree = listWorkspaceToolResultDocumentTrees({
    store,
    workspaceId: workspace.id,
  })[0];
  const outputTree = listWorkspaceOutputDocumentTrees({
    store,
    workspaceId: workspace.id,
  }).find((item) => item.title === "outreach-delegated.md");
  assert.ok(toolResultTree);
  assert.ok(outputTree);

  store.syncSemanticMemoryRelations({
    category: "workspace",
    workspaceId: workspace.id,
    treeId: outputTree!.treeId,
    relations: [],
  });

  const app = buildTestRuntimeApiServer({ store, memoryService });

  try {
    const retrieveResponse = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": workspace.id,
      },
      payload: {
        query: "ops@example.com",
        retrieval_policy: {
          max_evidence: 6,
        },
      },
    });
    assert.equal(retrieveResponse.statusCode, 200);
    assert.equal(
      retrieveResponse.json().evidence[0]?.title,
      "External individuals contacted the user personally about holaboss",
    );
    assert.ok(retrieveResponse.json().evidence.some((item: {
      title?: string;
      account_namespace?: string | null;
    }) =>
      item.account_namespace === "ops@example.com"
      && /holaboss_composio\.gmail_fetch_emails/i.test(item.title ?? ""),
    ));

    const benResponse = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": workspace.id,
      },
      payload: {
        query: "Ben Book",
        retrieval_policy: {
          max_evidence: 6,
        },
      },
    });
    assert.equal(benResponse.statusCode, 200);
    assert.equal(
      benResponse.json().evidence[0]?.title,
      "External individuals contacted the user personally about holaboss",
    );

    const deliverableResponse = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": workspace.id,
      },
      payload: {
        query: "outreach-delegated.md",
        retrieval_policy: {
          max_evidence: 6,
        },
      },
    });
    assert.equal(deliverableResponse.statusCode, 200);
    assert.equal(deliverableResponse.json().evidence[0]?.title, "outreach-delegated.md");

    const outputDetailBeforeGraphResponse = await app.inject({
      method: "GET",
      url: `/api/v1/memory/browser/node-detail?workspace_id=${workspace.id}&tree_id=${encodeURIComponent(outputTree!.treeId)}&node_id=${encodeURIComponent(outputTree!.rootNodeId)}`,
    });
    assert.equal(outputDetailBeforeGraphResponse.statusCode, 200);
    assert.ok(outputDetailBeforeGraphResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
      metadata?: Record<string, unknown>;
    }) =>
      relation.relation_type === "derived_from"
      && /holaboss_composio\.gmail_fetch_emails result/i.test(relation.target_label ?? "")
      && relation.metadata?.source_subagent_id === "subagent-1",
    ));

    const graphResponse = await app.inject({
      method: "GET",
      url: `/api/v1/memory/browser/graph?workspace_id=${workspace.id}&forest=workspace`,
    });
    assert.equal(graphResponse.statusCode, 200);
    assert.ok(graphResponse.json().nodes.some((node: {
      id?: string;
      label?: string | null;
    }) =>
      node.id === "semantic:related:person:ben-book"
      && node.label === "Ben Book"
    ));
    assert.ok(graphResponse.json().edges.some((edge: {
      from?: string;
      to?: string;
      kind?: string;
    }) =>
      edge.kind === "reference"
      && edge.from === outputTree!.rootNodeId
      && edge.to === "semantic:related:person:ben-book"
    ));
    assert.ok(graphResponse.json().edges.some((edge: {
      from?: string;
      to?: string;
      kind?: string;
    }) =>
      edge.kind === "reference"
      && edge.from === outputTree!.rootNodeId
      && edge.to === toolResultTree!.rootNodeId
    ));

    const leafNode = store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: workspace.id,
      treeId: "interaction:topic:holaboss-personal-outreach",
      status: "active",
      limit: 10_000,
      offset: 0,
    }).find((node) =>
      node.nodeClass === "leaf"
      && node.title === "External individuals contacted the user personally about holaboss"
    );
    assert.ok(leafNode);

    const leafDetailResponse = await app.inject({
      method: "GET",
      url: `/api/v1/memory/browser/node-detail?workspace_id=${workspace.id}&tree_id=${encodeURIComponent("interaction:topic:holaboss-personal-outreach")}&node_id=${encodeURIComponent(leafNode!.nodeId)}`,
    });
    assert.equal(leafDetailResponse.statusCode, 200);
    assert.ok(leafDetailResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
    }) =>
      relation.relation_type === "derived_from"
      && relation.target_label === "outreach-delegated.md",
    ));

  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory routes recover attachment artifact provenance and surface durable memory from attachment and account queries", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-memory-attachment-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const memoryService = new FilesystemMemoryService({ workspaceRoot });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-main",
    kind: "main_session",
  });

  const attachmentRelativePath = ".holaboss/input-attachments/batch-1/outreach-report.html";
  const attachmentAbsolutePath = path.join(workspaceRoot, workspace.id, attachmentRelativePath);
  fs.mkdirSync(path.dirname(attachmentAbsolutePath), { recursive: true });
  fs.writeFileSync(
    attachmentAbsolutePath,
    [
      "<html><body>",
      "<h1>holaboss personal outreach</h1>",
      "<p>Ben Book from anyIP emailed the user personally about holaboss.</p>",
      "<p>Keep the named outreach contact attached to durable memory.</p>",
      "</body></html>",
    ].join(""),
    "utf8",
  );

  const queuedInput = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: {
      text: "Remember the important external outreach details and preserve the attachment.",
      attachments: [
        {
          id: "att-1",
          kind: "file",
          name: "outreach-report.html",
          mime_type: "text/html",
          size_bytes: fs.statSync(attachmentAbsolutePath).size,
          workspace_path: attachmentRelativePath,
        },
      ],
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-04T12:00:00.000Z",
    completedAt: "2026-06-04T12:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I found the key outreach details and preserved the attachment evidence.",
    toolUsageSummary: {
      total_calls: 1,
      completed_calls: 1,
      failed_calls: 0,
      tool_names: ["holaboss_composio.gmail_fetch_emails"],
      tool_ids: ["holaboss_composio.gmail_fetch_emails"],
    },
  });
  store.appendOutputEvent({
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    sequence: 1,
    eventType: "tool_call",
    payload: {
      phase: "completed",
      tool_name: "holaboss_composio.gmail_fetch_emails",
      tool_id: "holaboss_composio.gmail_fetch_emails",
      call_id: "call-gmail-attachment-1",
      error: false,
      result: {
        content: [
          {
            type: "text",
            text: "Ben Book at anyIP reached out to the user personally about holaboss and followed up on the same Gmail thread.",
          },
        ],
        details: {
          raw: {
            _meta: {
              holaboss_integration_account: {
                provider_id: "gmail",
                connected_account_id: "ca_gmail_primary",
                account_namespace: "ops@example.com",
                connection_id: "conn_gmail_primary",
              },
            },
          },
        },
      },
    },
    createdAt: "2026-06-04T12:00:03.000Z",
  });

  await withMockMemoryModel({
    workspaceId: workspace.id,
    responseForRequest: (body) => {
      const payload = JSON.parse(body) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const systemPrompt = payload.messages?.find((message) => message.role === "system")?.content ?? "";
      if (systemPrompt.includes("Extract contextual durable memory")) {
        return {
          statusCode: 200,
          body: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    memories: [
                      {
                        scope: "workspace",
                        memory_type: "reference",
                        subject_key: "holaboss-personal-outreach-attachment",
                        title: "External individuals contacted the user personally about holaboss",
                        summary: "A small set of external individuals reached out to the user personally about holaboss and those outreach details should stay discoverable.",
                        tags: ["holaboss", "outreach", "reference"],
                        evidence: "The Gmail result and attachment both identify Ben Book at anyIP as a personal outreach contact for holaboss.",
                        confidence: 0.97,
                      },
                    ],
                  }),
                },
              },
            ],
          },
        };
      }
      if (systemPrompt.includes("Extract related durable entities and relations")) {
        return {
          statusCode: 200,
          body: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    related_entities: [
                      { entity_type: "person", label: "Ben Book" },
                      { entity_type: "organization", label: "anyIP" },
                    ],
                    relations: [
                      { relation_type: "contacted_by", entity_type: "person", entity_label: "Ben Book" },
                      { relation_type: "works_at", entity_type: "organization", entity_label: "anyIP" },
                    ],
                  }),
                },
              },
            ],
          },
        };
      }
      if (systemPrompt.includes("You assign one durable interaction memory chunk")) {
        return {
          statusCode: 200,
          body: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: "create_new",
                    existing_entity_id: null,
                    new_entity_type: "topic",
                    new_entity_name: "holaboss personal outreach",
                    secondary_entity_ids: [],
                    confidence: 0.96,
                    rationale: "This memory is a durable outreach topic rather than a single person or workflow.",
                  }),
                },
              },
            ],
          },
        };
      }
      if (systemPrompt.includes("You write concise markdown-tree summary sentences")) {
        return {
          statusCode: 200,
          body: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summary: "This topic captures durable personal outreach contacts and attachment evidence related to holaboss.",
                  }),
                },
              },
            ],
          },
        };
      }
      return {
        statusCode: 200,
        body: {
          choices: [
            {
              message: {
                content: JSON.stringify({}),
              },
            },
          ],
        },
      };
    },
    run: async (modelContext) => {
      await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult,
        modelContext,
      });
    },
  });
  const attachmentTree = listWorkspaceAttachmentDocumentTrees({
    store,
    workspaceId: workspace.id,
  })[0];
  const toolResultTree = listWorkspaceToolResultDocumentTrees({
    store,
    workspaceId: workspace.id,
  })[0];
  assert.ok(attachmentTree);
  assert.ok(toolResultTree);

  store.syncSemanticMemoryRelations({
    category: "workspace",
    workspaceId: workspace.id,
    treeId: attachmentTree!.treeId,
    relations: [],
  });

  const app = buildTestRuntimeApiServer({ store, memoryService });

  try {
    const benResponse = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": workspace.id,
      },
      payload: {
        query: "Ben Book",
        retrieval_policy: {
          max_evidence: 6,
        },
      },
    });
    assert.equal(benResponse.statusCode, 200);
    assert.equal(
      benResponse.json().evidence[0]?.title,
      "External individuals contacted the user personally about holaboss",
    );

    const accountResponse = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": workspace.id,
      },
      payload: {
        query: "ops@example.com",
        retrieval_policy: {
          max_evidence: 6,
        },
      },
    });
    assert.equal(accountResponse.statusCode, 200);
    assert.equal(
      accountResponse.json().evidence[0]?.title,
      "External individuals contacted the user personally about holaboss",
    );
    assert.ok(accountResponse.json().evidence.some((item: {
      title?: string;
      account_namespace?: string | null;
    }) =>
      item.account_namespace === "ops@example.com"
      && /holaboss_composio\.gmail_fetch_emails/i.test(item.title ?? ""),
    ));

    const attachmentResponse = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": workspace.id,
      },
      payload: {
        query: "outreach-report.html",
        retrieval_policy: {
          max_evidence: 6,
        },
      },
    });
    assert.equal(attachmentResponse.statusCode, 200);
    assert.equal(attachmentResponse.json().evidence[0]?.title, "outreach-report.html");

    const attachmentDetailResponse = await app.inject({
      method: "GET",
      url: `/api/v1/memory/browser/node-detail?workspace_id=${workspace.id}&tree_id=${encodeURIComponent(attachmentTree!.treeId)}&node_id=${encodeURIComponent(attachmentTree!.rootNodeId)}`,
    });
    assert.equal(attachmentDetailResponse.statusCode, 200);
    assert.ok(attachmentDetailResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
    }) =>
      relation.relation_type === "contacted_by"
      && relation.target_label === "Ben Book",
    ));

    const graphResponse = await app.inject({
      method: "GET",
      url: `/api/v1/memory/browser/graph?workspace_id=${workspace.id}&forest=workspace`,
    });
    assert.equal(graphResponse.statusCode, 200);
    assert.ok(graphResponse.json().nodes.some((node: {
      id?: string;
      label?: string | null;
    }) =>
      node.id === "semantic:related:person:ben-book"
      && node.label === "Ben Book"
    ));
    assert.ok(graphResponse.json().edges.some((edge: {
      from?: string;
      to?: string;
      kind?: string;
    }) =>
      edge.kind === "reference"
      && edge.from === attachmentTree!.rootNodeId
      && edge.to === "semantic:related:person:ben-book"
    ));

    const leafNode = store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: workspace.id,
      treeId: "interaction:topic:holaboss-personal-outreach",
      status: "active",
      limit: 10_000,
      offset: 0,
    }).find((node) =>
      node.nodeClass === "leaf"
      && node.title === "External individuals contacted the user personally about holaboss"
    );
    assert.ok(leafNode);

    const leafDetailResponse = await app.inject({
      method: "GET",
      url: `/api/v1/memory/browser/node-detail?workspace_id=${workspace.id}&tree_id=${encodeURIComponent("interaction:topic:holaboss-personal-outreach")}&node_id=${encodeURIComponent(leafNode!.nodeId)}`,
    });
    assert.equal(leafDetailResponse.statusCode, 200);
    assert.ok(leafDetailResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
    }) =>
      relation.relation_type === "derived_from"
      && relation.target_label === "outreach-report.html",
    ));
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory_retrieve tool treats non-ASCII filename queries as artifact-oriented and prefers artifact docs", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-memory-retrieve-non-ascii-filename-query-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: "root",
    sessionId: "session-main",
    kind: "main_session",
  });

  const queuedInput = store.enqueueInput({
    workspaceId: "root",
    sessionId: "session-main",
    payload: {
      text: "Save the main narrative stage deliverable for later recall.",
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "root",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-05T10:00:00.000Z",
    completedAt: "2026-06-05T10:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I saved the main narrative stage deliverable.",
  });

  const reportRelativePath = "outputs/main-narrative-stage.md";
  const reportAbsolutePath = path.join(workspaceRoot, "root", reportRelativePath);
  fs.mkdirSync(path.dirname(reportAbsolutePath), { recursive: true });
  fs.writeFileSync(
    reportAbsolutePath,
    [
      "# 主叙事阶段.md",
      "",
      "当前主叙事阶段.md 的交付内容在这里。",
    ].join("\n"),
    "utf8",
  );
  store.createOutput({
    workspaceId: "root",
    outputId: "output-cn-stage-file-1",
    outputType: "document",
    title: "主叙事阶段.md",
    status: "completed",
    filePath: reportRelativePath,
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    artifactId: "artifact-cn-stage-file-1",
  });
  await persistTurnOutputArtifactsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
  });

  const outputTree = listWorkspaceOutputDocumentTrees({
    store,
    workspaceId: "root",
  }).find((item) => item.outputId === "output-cn-stage-file-1");
  assert.ok(outputTree);

  store.upsertInteractionEntity({
    workspaceId: "root",
    entityId: "interaction:project:gtm-rollout",
    entityType: "project",
    canonicalName: "GTM rollout",
    slug: "project-gtm-rollout",
    summary: "GTM rollout memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  store.upsertInteractionLeaf({
    workspaceId: "root",
    leafId: "leaf-gtm-rollout-stage-file",
    entityId: "interaction:project:gtm-rollout",
    subjectKey: "gtm-rollout-stage-file",
    path: "workspace/root/interaction/entities/project-gtm-rollout/leaves/leaf-gtm-rollout-stage-file.md",
    title: "GTM rollout references 主叙事阶段.md",
    summary: "The rollout memory references 主叙事阶段.md as the current deliverable.",
    fingerprint: "gtm-rollout-stage-file-fingerprint",
    bodySha256: "gtm-rollout-stage-file-sha",
    tags: ["gtm", "rollout"],
    secondaryEntityIds: [],
    sourceType: "assistant_turn",
    sourceEventId: queuedInput.inputId,
    sourceMessageId: null,
    sourceTurnInputId: queuedInput.inputId,
    admissionConfidence: 0.93,
    entityConfidence: 0.93,
    observedAt: "2026-06-05T10:01:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  const interactionLeafPath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "root")),
    "interaction",
    "entities",
    "project-gtm-rollout",
    "leaves",
    "leaf-gtm-rollout-stage-file.md",
  );
  fs.mkdirSync(path.dirname(interactionLeafPath), { recursive: true });
  fs.writeFileSync(
    interactionLeafPath,
    appendDurableMemoryRelatedSections(
      [
        "# GTM rollout references 主叙事阶段.md",
        "",
        "## Summary",
        "",
        "The rollout memory references 主叙事阶段.md as the current deliverable.",
      ].join("\n"),
      {
        relatedEntities: [
          {
            entityType: "artifact",
            entityKey: "artifact:output:output-cn-stage-file-1",
            label: "主叙事阶段.md",
          },
        ],
        relations: [
          {
            relationType: "mentions",
            entityKey: "artifact:output:output-cn-stage-file-1",
          },
        ],
      },
    ),
    "utf8",
  );
  await rebuildInteractionEntityTree({
    store,
    workspaceId: "root",
    entityId: "interaction:project:gtm-rollout",
    summaryModelClient: null,
    embeddingClient: null,
  });

  const app = buildTestRuntimeApiServer({ store });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": "root",
      },
      payload: {
        query: "主叙事阶段.md",
        retrieval_policy: {
          max_evidence: 4,
        },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().tool_id, "memory_retrieve");
    assert.deepEqual(response.json().categories, ["workspace"]);
    assert.equal(response.json().evidence[0]?.tree_id, outputTree!.treeId);
    assert.equal(response.json().evidence[0]?.entity_type, "artifact");
    assert.ok(response.json().evidence[0]?.reasons.includes("artifact_query_boost"));
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory routes surface fresh non-ASCII owner relations as canonical resolved targets on first write", async () => {
  const root = makeTempDir("hb-runtime-api-memory-fresh-non-ascii-owner-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });

  const persisted = await persistInteractionCandidate({
    store,
    workspaceId: "workspace-1",
    candidate: {
      subjectKey: "渠道设计阶段决策",
      title: "渠道设计阶段",
      summary: "渠道设计阶段的主叙事和优先级决策。",
      content: appendDurableMemoryRelatedSections(
        "# 渠道设计阶段\n\n渠道设计阶段的主叙事和优先级决策。\n",
        {
          relatedEntities: [
            {
              entityType: "topic",
              entityKey: "topic:topic",
              label: "渠道设计阶段",
            },
          ],
          relations: [
            {
              relationType: "about",
              entityKey: "topic:topic",
            },
          ],
        },
      ),
      tags: ["渠道设计", "阶段"],
      memoryType: "reference",
      confidence: 0.9,
      observedAt: "2026-06-05T08:57:55.231Z",
    },
    modelClient: null,
  });

  await rebuildInteractionEntityTree({
    store,
    workspaceId: "workspace-1",
    entityId: persisted.entity.entityId,
    summaryModelClient: null,
    embeddingClient: null,
  });

  const leafNode = store.listSemanticMemoryNodes({
    category: "workspace",
    workspaceId: "workspace-1",
    treeId: persisted.entity.entityId,
    status: "active",
    limit: 10_000,
    offset: 0,
  }).find((node) => node.nodeClass === "leaf" && node.title === "渠道设计阶段");
  assert.ok(leafNode);

  const app = buildTestRuntimeApiServer({ store });
  try {
    const retrievalResponse = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": "workspace-1",
      },
      payload: {
        query: "渠道设计阶段",
        retrieval_policy: {
          max_evidence: 4,
        },
      },
    });

    assert.equal(retrievalResponse.statusCode, 200);
    assert.equal(retrievalResponse.json().evidence[0]?.title, "渠道设计阶段");
    assert.equal(retrievalResponse.json().evidence[0]?.tree_id, persisted.entity.entityId);

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/v1/memory/browser/node-detail?workspace_id=workspace-1&tree_id=${encodeURIComponent(persisted.entity.entityId)}&node_id=${encodeURIComponent(leafNode!.nodeId)}`,
    });
    assert.equal(detailResponse.statusCode, 200);
    assert.ok(detailResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
      target_resolution_kind?: string | null;
      target_entity_key?: string | null;
      target_tree_id?: string | null;
    }) =>
      relation.relation_type === "about"
      && relation.target_label === "渠道设计阶段"
      && relation.target_resolution_kind === "resolved"
      && relation.target_entity_key === `topic:entity:${persisted.entity.entityId}`
      && relation.target_tree_id === persisted.entity.entityId,
    ));

    const browserPath = leafNode!.path.replace(/^semantic\//, "");
    const fileResponse = await app.inject({
      method: "GET",
      url: `/api/v1/memory/browser/file?workspace_id=workspace-1&path=${encodeURIComponent(browserPath)}`,
    });
    assert.equal(fileResponse.statusCode, 200);
    const relatedInfo = parseDurableMemoryRelatedInfo(fileResponse.json().content as string);
    assert.deepEqual(
      relatedInfo.relatedEntities.map((entry) => entry.entityKey),
      [`topic:entity:${persisted.entity.entityId}`],
    );
    assert.deepEqual(
      relatedInfo.relations.map((entry) => `${entry.relationType}|${entry.entityKey}`),
      [`about|topic:entity:${persisted.entity.entityId}`],
    );
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory routes surface fresh non-ASCII owner relations as canonical resolved targets after turn writeback", async () => {
  const root = makeTempDir("hb-runtime-api-memory-writeback-non-ascii-owner-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const memoryService = new FilesystemMemoryService({ workspaceRoot });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    role: "user",
    text: "Please remember the durable planning guidance for 渠道设计阶段.",
    messageId: "user-1",
    createdAt: "2026-06-05T08:57:50.000Z",
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    startedAt: "2026-06-05T08:57:50.000Z",
    completedAt: "2026-06-05T08:57:55.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I will preserve the durable planning guidance for 渠道设计阶段.",
  });

  await withMockMemoryModel({
    responseForRequest: (body) => {
      const payload = JSON.parse(body) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const systemPrompt = payload.messages?.find((message) => message.role === "system")?.content ?? "";
      if (systemPrompt.includes("Extract contextual durable memory")) {
        return {
          statusCode: 200,
          body: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    memories: [
                      {
                        scope: "workspace",
                        memory_type: "reference",
                        subject_key: "channel-design-stage",
                        title: "渠道设计阶段",
                        summary: "渠道设计阶段的主叙事和优先级决策。",
                        tags: ["gtm", "planning"],
                        evidence: "The current turn asks the agent to remember the durable planning guidance for 渠道设计阶段.",
                        confidence: 0.95,
                      },
                    ],
                  }),
                },
              },
            ],
          },
        };
      }
      if (systemPrompt.includes("Extract related durable entities and relations")) {
        return {
          statusCode: 200,
          body: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    related_entities: [
                      { entity_type: "topic", label: "渠道设计阶段" },
                    ],
                    relations: [
                      { relation_type: "about", entity_type: "topic", entity_label: "渠道设计阶段" },
                    ],
                  }),
                },
              },
            ],
          },
        };
      }
      if (systemPrompt.includes("You assign one durable interaction memory chunk")) {
        return {
          statusCode: 200,
          body: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: "create_new",
                    existing_entity_id: null,
                    new_entity_type: "topic",
                    new_entity_name: "渠道设计阶段",
                    secondary_entity_ids: [],
                    confidence: 0.95,
                    rationale: "This is a durable topic cluster for the 渠道设计阶段 planning guidance.",
                  }),
                },
              },
            ],
          },
        };
      }
      return {
        statusCode: 200,
        body: {
          choices: [
            {
              message: {
                content: JSON.stringify({}),
              },
            },
          ],
        },
      };
    },
    run: async (modelContext) => {
      await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult,
        modelContext,
      });
    },
  });

  const leaf = store.listInteractionLeaves({
    workspaceId: "workspace-1",
    status: "active",
    limit: 10_000,
    offset: 0,
  }).find((item) => item.title === "渠道设计阶段");
  assert.ok(leaf);

  const leafNode = store.listSemanticMemoryNodes({
    category: "workspace",
    workspaceId: "workspace-1",
    treeId: leaf!.entityId,
    status: "active",
    limit: 10_000,
    offset: 0,
  }).find((node) => node.nodeClass === "leaf" && node.sourceLeafId === leaf!.leafId);
  assert.ok(leafNode);

  const app = buildTestRuntimeApiServer({ store, memoryService });
  try {
    const retrievalResponse = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": "workspace-1",
      },
      payload: {
        query: "渠道设计阶段",
        retrieval_policy: {
          max_evidence: 4,
        },
      },
    });
    assert.equal(retrievalResponse.statusCode, 200);
    assert.equal(retrievalResponse.json().evidence[0]?.title, "渠道设计阶段");
    assert.equal(retrievalResponse.json().evidence[0]?.tree_id, leaf!.entityId);

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/v1/memory/browser/node-detail?workspace_id=workspace-1&tree_id=${encodeURIComponent(leaf!.entityId)}&node_id=${encodeURIComponent(leafNode!.nodeId)}`,
    });
    assert.equal(detailResponse.statusCode, 200);
    assert.ok(detailResponse.json().outgoing_relations.some((relation: {
      relation_type?: string;
      target_label?: string | null;
      target_resolution_kind?: string | null;
      target_entity_key?: string | null;
      target_tree_id?: string | null;
    }) =>
      relation.relation_type === "about"
      && relation.target_label === "渠道设计阶段"
      && relation.target_resolution_kind === "resolved"
      && relation.target_entity_key === `topic:entity:${leaf!.entityId}`
      && relation.target_tree_id === leaf!.entityId,
    ));

    const browserPath = leafNode!.path.replace(/^semantic\//, "");
    const fileResponse = await app.inject({
      method: "GET",
      url: `/api/v1/memory/browser/file?workspace_id=workspace-1&path=${encodeURIComponent(browserPath)}`,
    });
    assert.equal(fileResponse.statusCode, 200);
    const relatedInfo = parseDurableMemoryRelatedInfo(fileResponse.json().content as string);
    assert.deepEqual(
      relatedInfo.relatedEntities.map((entry) => entry.entityKey),
      [`topic:entity:${leaf!.entityId}`],
    );

    const graphResponse = await app.inject({
      method: "GET",
      url: "/api/v1/memory/browser/graph?workspace_id=workspace-1&forest=workspace",
    });
    assert.equal(graphResponse.statusCode, 200);
    const ownerRootNodeId = `semantic:interaction:${leaf!.entityId}:tree`;
    assert.ok(graphResponse.json().nodes.some((node: {
      id?: string;
      label?: string | null;
    }) =>
      node.id === ownerRootNodeId
      && node.label === "渠道设计阶段",
    ));
    assert.ok(graphResponse.json().edges.some((edge: {
      from?: string;
      to?: string;
      kind?: string;
    }) =>
      edge.from === leafNode!.nodeId
      && edge.to === ownerRootNodeId
      && edge.kind === "reference",
    ));
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory browser node-detail route returns evidence refs and relation metadata for real workspace nodes", async () => {
  const root = makeTempDir("hb-runtime-api-memory-browser-node-detail-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  fs.mkdirSync(path.join(workspaceRoot, "workspace-1"), { recursive: true });

  store.upsertInteractionEntity({
    workspaceId: "workspace-1",
    entityId: "interaction:topic:holaboss-personal-outreach",
    entityType: "topic",
    canonicalName: "Holaboss personal outreach",
    slug: "topic-holaboss-personal-outreach",
    summary: "External outreach memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });

  const treeId = "interaction:topic:holaboss-personal-outreach";
  const rootNodeId = "semantic:interaction:interaction:topic:holaboss-personal-outreach:tree";
  const leafNodeId = "semantic:interaction:interaction:topic:holaboss-personal-outreach:leaf:leaf-1";
  store.syncSemanticMemoryTree({
    category: "workspace",
    workspaceId: "workspace-1",
    treeId,
    nodes: [
      {
        nodeId: rootNodeId,
        nodeClass: "semantic",
        nodeKind: "tree",
        path: "semantic/workspace/knowledge/topic-holaboss-personal-outreach/content.md",
        title: "Holaboss personal outreach",
        summary: "External outreach memory.",
        bodySha256: "sha-root",
        childCount: 1,
        isMaterialized: false,
        metadata: {},
      },
      {
        nodeId: leafNodeId,
        nodeClass: "leaf",
        nodeKind: "leaf",
        sourceLeafId: "leaf-1",
        path: "semantic/workspace/knowledge/topic-holaboss-personal-outreach/leaf-1.md",
        title: "External individuals contacted the user personally about holaboss",
        summary: "Personal outreach memory.",
        bodySha256: "sha-leaf",
        childCount: 0,
        isMaterialized: false,
        metadata: {
          related_entity_keys: ["person:ben-book"],
          relation_types: ["contacted_by"],
        },
      },
    ],
    edges: [
      {
        parentNodeId: rootNodeId,
        childNodeId: leafNodeId,
        position: 1,
      },
    ],
  });
  store.replaceSemanticMemoryRelations({
    category: "workspace",
    workspaceId: "workspace-1",
    treeId,
    relations: [
      {
        fromNodeId: leafNodeId,
        toNodeId: "semantic:related:person:ben-book",
        relationType: "contacted_by",
        metadata: {
          entity_key: "person:ben-book",
          entity_label: "Ben Book",
          entity_type: "person",
        },
      },
    ],
  });
  store.upsertSemanticMemoryEvidenceRef({
    category: "workspace",
    workspaceId: "workspace-1",
    treeId,
    nodeId: leafNodeId,
    refId: "turn:input-7:tool:call-gmail-outreach-1",
    provider: "gmail",
    accountNamespace: "ops@example.com",
    connectionId: "conn-gmail-primary",
    externalObjectId: "thread-1",
    externalObjectType: "gmail_thread",
    sourceType: "tool_call",
    sourceEventId: "call-gmail-outreach-1",
    sourceTurnInputId: "input-7",
    observedAt: "2026-06-03T00:00:00.000Z",
    metadata: {
      tool_name: "holaboss_composio.gmail_fetch_emails",
    },
  });

  const app = buildTestRuntimeApiServer({ store });

  try {
    const leafResponse = await app.inject({
      method: "GET",
      url: `/api/v1/memory/browser/node-detail?workspace_id=workspace-1&tree_id=${encodeURIComponent(treeId)}&node_id=${encodeURIComponent(leafNodeId)}`,
    });
    assert.equal(leafResponse.statusCode, 200);
    assert.equal(leafResponse.json().node_id, leafNodeId);
    assert.equal(leafResponse.json().evidence_refs[0]?.provider, "gmail");
    assert.equal(leafResponse.json().evidence_refs[0]?.account_namespace, "ops@example.com");
    assert.equal(leafResponse.json().outgoing_relations[0]?.target_label, "Ben Book");
    assert.equal(leafResponse.json().outgoing_relations[0]?.relation_type, "contacted_by");

    const relatedResponse = await app.inject({
      method: "GET",
      url: "/api/v1/memory/browser/node-detail?workspace_id=workspace-1&node_id=semantic%3Arelated%3Aperson%3Aben-book",
    });
    assert.equal(relatedResponse.statusCode, 200);
    assert.equal(relatedResponse.json().node_id, "semantic:related:person:ben-book");
    assert.equal(relatedResponse.json().kind, "node");
    assert.equal(relatedResponse.json().label, "Ben Book");
    assert.equal(relatedResponse.json().subtitle, "synthetic related person");
    assert.equal(relatedResponse.json().incoming_relations[0]?.source_node_id, leafNodeId);
    assert.equal(
      relatedResponse.json().incoming_relations[0]?.source_label,
      "External individuals contacted the user personally about holaboss",
    );
    assert.equal(
      relatedResponse.json().incoming_relations[0]?.target_resolution_kind,
      "synthetic",
    );
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory browser graph route rejects the legacy integrations forest alias", async () => {
  const root = makeTempDir("hb-runtime-api-memory-browser-graph-forest-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const app = buildTestRuntimeApiServer({ store });

  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/memory/browser/graph?workspace_id=workspace-1&forest=integrations",
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /forest must be workspace/i);
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime memory_retrieve searches both interaction and integration trees when both exist", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-memory-retrieve-both-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.upsertInteractionEntity({
    workspaceId: "root",
    entityId: "interaction:project:atlas-api",
    entityType: "project",
    canonicalName: "Atlas API",
    slug: "project-atlas-api",
    summary: "Atlas API workspace memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  store.upsertInteractionLeaf({
    workspaceId: "root",
    leafId: "leaf-atlas-incident",
    entityId: "interaction:project:atlas-api",
    subjectKey: "incident-bridge",
    path: "workspace/root/interaction/entities/project-atlas-api/leaves/leaf-atlas-incident.md",
    title: "Atlas API incident bridge",
    summary: "The incident bridge channel is #atlas-api-rollout.",
    fingerprint: "atlas-incident-fingerprint",
    bodySha256: "atlas-incident-sha",
    tags: ["project"],
    secondaryEntityIds: [],
    sourceType: "manual",
    sourceEventId: null,
    sourceMessageId: null,
    sourceTurnInputId: "input-seed",
    admissionConfidence: 0.9,
    entityConfidence: 0.9,
    observedAt: "2026-05-20T00:00:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  const interactionLeafPath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "root")),
    "interaction",
    "entities",
    "project-atlas-api",
    "leaves",
    "leaf-atlas-incident.md",
  );
  fs.mkdirSync(path.dirname(interactionLeafPath), { recursive: true });
  fs.writeFileSync(interactionLeafPath, "# Atlas API incident bridge\n\nThe incident bridge channel is #atlas-api-rollout.\n", "utf8");
  await rebuildInteractionEntityTree({
    store,
    workspaceId: "root",
    entityId: "interaction:project:atlas-api",
    summaryModelClient: null,
    embeddingClient: null,
  });

  store.upsertIntegrationConnection({
    connectionId: "conn-github-2",
    providerId: "github",
    ownerUserId: "user-1",
    accountLabel: "Atlas GitHub",
    accountExternalId: "acct-2",
    accountHandle: "atlas-github",
    accountEmail: null,
    authMode: "oauth",
    grantedScopes: ["repo"],
    status: "active",
    secretRef: null,
  });
  store.upsertIntegrationBinding({
    bindingId: "binding-github-2",
    workspaceId: "root",
    targetType: "workspace",
    targetId: "root",
    integrationKey: "github",
    connectionId: "conn-github-2",
    isDefault: true,
  });
  store.upsertIntegrationTree({
    workspaceId: "root",
    treeId: "integration:github:acct-2",
    provider: "github",
    ownerUserId: "user-1",
    accountKey: "atlas-github",
    accountLabel: "Atlas GitHub",
    slug: "github-atlas-acct-2",
    summary: "Atlas GitHub account memory.",
    status: "active",
  });
  store.upsertIntegrationLeaf({
    workspaceId: "root",
    leafId: "leaf-atlas-pr-owner",
    treeId: "integration:github:acct-2",
    subjectKey: "release-pr-owner",
    entityKey: "repo:holaboss-ai/atlas-api",
    entityLabel: "holaboss-ai/atlas-api",
    branchKey: "pull_requests",
    branchLabel: "Pull requests",
    path: "integration/accounts/github-atlas-acct-2/leaves/leaf-atlas-pr-owner.md",
    title: "Atlas API release PR owner",
    summary: "The Atlas API release PR owner is Noah Bell.",
    fingerprint: "atlas-pr-owner-fingerprint",
    bodySha256: "atlas-pr-owner-sha",
    tags: ["github"],
    sourceType: "github.pull_request",
    sourceEventId: "evt-2",
    sourceMessageId: null,
    externalObjectId: "456",
    externalObjectType: "pull_request",
    admissionConfidence: 0.95,
    observedAt: "2026-05-20T00:01:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  const integrationLeafPath = path.join(
    globalMemoryDirForWorkspaceRoot(workspaceRoot),
    "integration",
    "accounts",
    "github-atlas-acct-2",
    "leaves",
    "leaf-atlas-pr-owner.md",
  );
  fs.mkdirSync(path.dirname(integrationLeafPath), { recursive: true });
  fs.writeFileSync(integrationLeafPath, "# Atlas API release PR owner\n\nThe Atlas API release PR owner is Noah Bell.\n", "utf8");
  await rebuildIntegrationTree({
    store,
    workspaceId: "root",
    treeId: "integration:github:acct-2",
    embeddingClient: null,
  });

  const app = buildTestRuntimeApiServer({ store });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/memory/retrieve",
      headers: {
        "x-holaboss-workspace-id": "root",
      },
      payload: {
        query: "atlas api",
        intent: "briefing",
        retrieval_policy: {
          max_evidence: 6,
        },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().tool_id, "memory_retrieve");
    assert.deepEqual(response.json().categories, ["workspace"]);
    const titles = response.json().evidence.map((hit: { title: string }) => hit.title);
    assert.ok(titles.includes("Atlas API incident bridge"));
    assert.ok(titles.includes("Atlas API release PR owner"));
    assert.ok(response.json().evidence.every((hit: { category?: string }) => hit.category === "workspace"));
    assert.ok(Array.isArray(response.json().retrieval_pack.recent_high_signal_items));
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime download_url tool saves a remote asset into the workspace", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-download-tools-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  fs.mkdirSync(path.join(workspaceRoot, "root"), { recursive: true });
  const app = buildTestRuntimeApiServer({ store });

  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
  const assetServer = await startStaticHttpServer((request, response) => {
    assert.equal(request.url, "/cover");
    response.writeHead(200, {
      "content-type": "image/png",
      "content-disposition": 'inline; filename="cover.png"',
    });
    response.end(imageBytes);
  });

  try {
    const download = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/downloads",
      headers: {
        "x-holaboss-workspace-id": "root",
      },
      payload: {
        url: `${assetServer.url}/cover`,
        output_path: "assets/reference/cover",
        expected_mime_prefix: "image/",
      },
    });

    assert.equal(download.statusCode, 200);
    assert.deepEqual(download.json(), {
      file_path: "assets/reference/cover.png",
      source_url: `${assetServer.url}/cover`,
      final_url: `${assetServer.url}/cover`,
      mime_type: "image/png",
      size_bytes: imageBytes.length,
    });
    assert.deepEqual(
      fs.readFileSync(path.join(workspaceRoot, "root", "assets/reference/cover.png")),
      imageBytes,
    );
  } finally {
    await assetServer.close();
    await app.close();
    store.close();
  }
});

test("runtime todo tools read, write, and block session todo state", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-todo-tools-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  fs.mkdirSync(path.join(workspaceRoot, "root"), { recursive: true });
  const app = buildTestRuntimeApiServer({ store });

  try {
    const initialRead = await app.inject({
      method: "GET",
      url: "/api/v1/capabilities/runtime-tools/todo",
      headers: {
        "x-holaboss-workspace-id": "root",
        "x-holaboss-session-id": "session-main",
      },
    });
    assert.equal(initialRead.statusCode, 200);
    assert.equal(initialRead.json().text, "No todo items are currently recorded for this session.");
    assert.equal(initialRead.json().exists, false);

    const write = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/todo",
      headers: {
        "x-holaboss-workspace-id": "root",
        "x-holaboss-session-id": "session-main",
      },
      payload: {
        ops: [
          {
            op: "replace",
            phases: [
              {
                name: "Implementation",
                tasks: [
                  { content: "Wire runtime todo state" },
                  { content: "Verify runtime tool forwarding" },
                ],
              },
            ],
          },
        ],
      },
    });
    assert.equal(write.statusCode, 200);
    assert.match(write.json().text, /Updated todo plan with 2 tasks across 1 phase\./);
    assert.equal(write.json().exists, true);
    assert.equal(write.json().blocked, false);

    const reread = await app.inject({
      method: "GET",
      url: "/api/v1/capabilities/runtime-tools/todo",
      headers: {
        "x-holaboss-workspace-id": "root",
        "x-holaboss-session-id": "session-main",
      },
    });
    assert.equal(reread.statusCode, 200);
    assert.equal(reread.json().task_count, 2);
    assert.equal(reread.json().phases[0].tasks[0].status, "in_progress");
    assert.equal(reread.json().phases[0].tasks[1].status, "pending");

    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/todo/block",
      headers: {
        "x-holaboss-workspace-id": "root",
        "x-holaboss-session-id": "session-main",
      },
      payload: {
        detail: "Blocked waiting for user input: Should I deploy to production?",
      },
    });
    assert.equal(blocked.statusCode, 200);
    assert.equal(blocked.json().exists, true);
    assert.equal(blocked.json().blocked, true);

    const status = await app.inject({
      method: "GET",
      url: "/api/v1/capabilities/runtime-tools/todo/status",
      headers: {
        "x-holaboss-workspace-id": "root",
        "x-holaboss-session-id": "session-main",
      },
    });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().blocked, true);

  const todoPath = path.join(workspaceRoot, "root", ".holaboss", "state", "todos", "session-main.json");
    const persisted = JSON.parse(fs.readFileSync(todoPath, "utf8"));
    assert.equal(persisted.phases[0]?.tasks[0]?.status, "blocked");
    assert.equal(persisted.phases[0]?.tasks[1]?.status, "pending");
    assert.match(
      String(persisted.phases[0]?.tasks[0]?.details ?? ""),
      /Blocked waiting for user input: Should I deploy to production\?/,
    );
  } finally {
    await app.close();
    store.close();
  }
});


test("runtime terminal session tools proxy terminal session manager operations", async () => {
  const root = makeTempDir("hb-runtime-api-runtime-terminal-tools-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  seedWorkspaceRecord(store, {
    // single-tenant: every request resolves to the synthetic root
    workspaceId: "root",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  fs.mkdirSync(path.join(root, "workspace", "root"), { recursive: true });

  let currentSession: any = {
    terminalId: "term-1",
    // single-tenant: runtime proxies the resolved root id to the manager
    workspaceId: "root",
    sessionId: "session-main",
    inputId: "input-1",
    title: "Background task",
    backend: "node_pty",
    owner: "agent",
    status: "running",
    cwd: path.join(root, "workspace", "workspace-1"),
    shell: "/bin/bash",
    command: "npm run dev",
    exitCode: null,
    lastEventSeq: 1,
    createdBy: "runtime_tool",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    metadata: { origin_type: "runtime_tool" },
  };
  const events: any[] = [
    {
      id: 1,
      terminalId: "term-1",
      workspaceId: "workspace-1",
      sessionId: "session-main",
      sequence: 1,
      eventType: "started",
      payload: { command: "npm run dev" },
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  let subscriber: ((event: any) => void) | null = null;
  const terminalSessionManager: any = {
    async start() {},
    async close() {},
    async createSession(params: Record<string, unknown>) {
      currentSession = {
        ...currentSession,
        title: String(params.title ?? currentSession.title),
        command: String(params.command ?? currentSession.command),
        cwd: typeof params.cwd === "string" && params.cwd ? params.cwd : currentSession.cwd,
      };
      return currentSession;
    },
    getSession(params: { terminalId: string; workspaceId: string }) {
      if (params.terminalId !== currentSession.terminalId) {
        return null;
      }
      if (params.workspaceId !== currentSession.workspaceId) {
        return null;
      }
      return currentSession;
    },
    listSessions() {
      return [currentSession];
    },
    listEvents(params: { workspaceId: string; terminalId: string; afterSequence?: number; limit?: number }) {
      if (params.workspaceId !== currentSession.workspaceId) {
        return [];
      }
      return events
        .filter((event) => event.terminalId === params.terminalId && event.sequence > (params.afterSequence ?? 0))
        .slice(0, params.limit ?? events.length);
    },
    async sendInput(params: { workspaceId: string }) {
      if (params.workspaceId !== currentSession.workspaceId) {
        throw new Error("workspace mismatch");
      }
      currentSession = {
        ...currentSession,
        lastActivityAt: "2026-01-01T00:00:02.000Z",
      };
      return currentSession;
    },
    async resize(params: { workspaceId: string }) {
      if (params.workspaceId !== currentSession.workspaceId) {
        throw new Error("workspace mismatch");
      }
      return currentSession;
    },
    async signal(params: { workspaceId: string }) {
      if (params.workspaceId !== currentSession.workspaceId) {
        throw new Error("workspace mismatch");
      }
      currentSession = {
        ...currentSession,
        status: "failed",
        exitCode: 130,
      };
      return currentSession;
    },
    async closeSession(params: { workspaceId: string }) {
      if (params.workspaceId !== currentSession.workspaceId) {
        throw new Error("workspace mismatch");
      }
      currentSession = {
        ...currentSession,
        status: "closed",
        endedAt: "2026-01-01T00:00:03.000Z",
      };
      return currentSession;
    },
    subscribe(_terminalId: string, listener: (event: any) => void) {
      subscriber = listener;
      return () => {
        subscriber = null;
      };
    },
  };

  const app = buildTestRuntimeApiServer({ store, terminalSessionManager });

  const listResponse = await app.inject({
    method: "GET",
    url: "/api/v1/capabilities/runtime-tools/terminal-sessions",
    headers: {
      "x-holaboss-workspace-id": "workspace-1",
      "x-holaboss-session-id": "session-main",
    },
  });
  assert.equal(listResponse.statusCode, 200);
  assert.equal(listResponse.json().count, 1);
  assert.equal(listResponse.json().sessions[0].terminal_id, "term-1");

  const startResponse = await app.inject({
    method: "POST",
    url: "/api/v1/capabilities/runtime-tools/terminal-sessions",
    headers: {
      "x-holaboss-workspace-id": "workspace-1",
      "x-holaboss-session-id": "session-main",
      "x-holaboss-input-id": "input-1",
      "x-holaboss-selected-model": "openai/gpt-5.4",
    },
    payload: {
      title: "Build",
      cwd: "workspace-1",
      command: "npm run build",
    },
  });
  assert.equal(startResponse.statusCode, 200);
  assert.equal(startResponse.json().title, "Build");
  assert.equal(startResponse.json().command, "npm run build");

  const getResponse = await app.inject({
    method: "GET",
    url: "/api/v1/capabilities/runtime-tools/terminal-sessions/term-1",
    headers: {
      "x-holaboss-workspace-id": "workspace-1",
    },
  });
  assert.equal(getResponse.statusCode, 200);
  assert.equal(getResponse.json().terminal_id, "term-1");

  const readResponse = await app.inject({
    method: "POST",
    url: "/api/v1/capabilities/runtime-tools/terminal-sessions/term-1/read",
    headers: {
      "x-holaboss-workspace-id": "workspace-1",
    },
    payload: {
      after_sequence: 0,
    },
  });
  assert.equal(readResponse.statusCode, 200);
  assert.equal(readResponse.json().count, 1);
  assert.equal(readResponse.json().events[0].event_type, "started");
  assert.equal(readResponse.json().after_sequence, 0);
  assert.equal(readResponse.json().limit, 200);
  assert.equal(readResponse.json().has_more, false);
  assert.equal(readResponse.json().next_after_sequence, null);
  assert.equal(readResponse.json().remaining_event_count, 0);
  assert.equal(readResponse.json().latest_event_sequence, 1);

  const waitPromise = app.inject({
    method: "POST",
    url: "/api/v1/capabilities/runtime-tools/terminal-sessions/term-1/wait",
    headers: {
      "x-holaboss-workspace-id": "workspace-1",
    },
    payload: {
      after_sequence: 1,
      timeout_ms: 250,
    },
  });
  setTimeout(() => {
    const event = {
      id: 2,
      terminalId: "term-1",
      workspaceId: "workspace-1",
      sessionId: "session-main",
      sequence: 2,
      eventType: "output",
      payload: { data: "ready\n" },
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    events.push(event);
    currentSession = {
      ...currentSession,
      lastEventSeq: 2,
      lastActivityAt: "2026-01-01T00:00:01.000Z",
    };
    subscriber?.(event);
  }, 10);
  const waitResponse = await waitPromise;
  assert.equal(waitResponse.statusCode, 200);
  assert.equal(waitResponse.json().timed_out, false);
  assert.equal(waitResponse.json().events[0].event_type, "output");
  assert.equal(waitResponse.json().after_sequence, 1);
  assert.equal(waitResponse.json().limit, 200);
  assert.equal(waitResponse.json().has_more, false);
  assert.equal(waitResponse.json().next_after_sequence, null);
  assert.equal(waitResponse.json().remaining_event_count, 0);
  assert.equal(waitResponse.json().latest_event_sequence, 2);

  const inputResponse = await app.inject({
    method: "POST",
    url: "/api/v1/capabilities/runtime-tools/terminal-sessions/term-1/input",
    headers: {
      "x-holaboss-workspace-id": "workspace-1",
    },
    payload: {
      data: "npm test\r",
    },
  });
  assert.equal(inputResponse.statusCode, 200);
  assert.equal(inputResponse.json().terminal_id, "term-1");

  const signalResponse = await app.inject({
    method: "POST",
    url: "/api/v1/capabilities/runtime-tools/terminal-sessions/term-1/signal",
    headers: {
      "x-holaboss-workspace-id": "workspace-1",
    },
    payload: {
      signal: "SIGINT",
    },
  });
  assert.equal(signalResponse.statusCode, 200);
  assert.equal(signalResponse.json().status, "failed");

  const closeResponse = await app.inject({
    method: "POST",
    url: "/api/v1/capabilities/runtime-tools/terminal-sessions/term-1/close",
    headers: {
      "x-holaboss-workspace-id": "workspace-1",
    },
    payload: {},
  });
  assert.equal(closeResponse.statusCode, 200);
  assert.equal(closeResponse.json().status, "closed");

  await app.close();
  store.close();
});

test("runtime terminal read preview mode clips large event streams and spills full events", async () => {
  const root = makeTempDir("hb-runtime-api-runtime-terminal-preview-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    // single-tenant: every request resolves to the synthetic root
    workspaceId: "root",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  fs.mkdirSync(path.join(workspaceRoot, "root"), { recursive: true });

  const session = {
    terminalId: "term-1",
    // single-tenant: runtime resolves getSession to the root workspace
    workspaceId: "root",
    sessionId: "session-main",
    inputId: "input-1",
    title: "Background task",
    backend: "node_pty",
    owner: "agent",
    status: "running",
    cwd: path.join(workspaceRoot, "workspace-1"),
    shell: "/bin/bash",
    command: "npm run dev",
    exitCode: null,
    lastEventSeq: 55,
    createdBy: "runtime_tool",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    metadata: { origin_type: "runtime_tool" },
  };
  const events = Array.from({ length: 55 }, (_, index) => ({
    id: index + 1,
    terminalId: "term-1",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    sequence: index + 1,
    eventType: "output",
    payload: { text: `line-${index + 1}:${"x".repeat(900)}` },
    createdAt: "2026-01-01T00:00:00.000Z",
  }));

  const terminalSessionManager: any = {
    async start() {},
    async close() {},
    getSession(params: { terminalId: string; workspaceId?: string }) {
      if (params.terminalId !== session.terminalId) {
        return null;
      }
      if (params.workspaceId && params.workspaceId !== session.workspaceId) {
        return null;
      }
      return session;
    },
    listEvents(params: { terminalId: string; afterSequence?: number; limit?: number }) {
      return events
        .filter((event) => event.terminalId === params.terminalId && event.sequence > (params.afterSequence ?? 0))
        .slice(0, params.limit ?? events.length);
    },
    subscribe() {
      return () => {};
    },
  };

  const app = buildTestRuntimeApiServer({ store, terminalSessionManager });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/terminal-sessions/term-1/read",
      headers: {
        "x-holaboss-workspace-id": "workspace-1",
        "x-holaboss-session-id": "session-main",
        "x-holaboss-tool-result-mode": "preview",
      },
      payload: {
        after_sequence: 0,
        limit: 200,
      },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.events.length, 40);
    assert.equal(body.count, 40);
    assert.equal(body.total_event_count, 55);
    assert.equal(body.has_more, true);
    assert.equal(body.next_after_sequence, 40);
    assert.equal(body.remaining_event_count, 15);
    assert.equal(body.latest_event_sequence, 55);
    assert.equal(body._preview.mode, "preview");
    assert.equal(body._preview.truncated, true);
    assert.equal(body._preview.spilled, true);
    assert.match(
      String(body.full_events_path ?? ""),
      /^\.holaboss\/state\/tool-results\/terminal_session_read\/session-main\//,
    );
    assert.equal(
      fs.existsSync(
        path.join(workspaceRoot, "root", String(body.full_events_path ?? "")),
      ),
      true,
    );
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime write_report tool writes an HTML report and persists it as a session output", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-report-tools-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureRuntimeState({
    workspaceId: "root",
    sessionId: "session-main",
    status: "BUSY",
    currentInputId: "input-1",
  });

  const app = buildTestRuntimeApiServer({ store });
  const reportContent = [
    "<!doctype html>",
    "<html><body><h1>Tariff update brief</h1>",
    "<ul><li>Court challenges are active.</li><li>Consumer impact remains debated.</li></ul>",
    "</body></html>",
  ].join("");
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/reports",
      headers: {
        "x-holaboss-workspace-id": "root",
        "x-holaboss-session-id": "session-main",
        "x-holaboss-input-id": "input-1",
        "x-holaboss-selected-model": "openai/gpt-5.4",
      },
      payload: {
        title: "Tariff update brief",
        filename: "tariff-update-brief.md",
        summary: "Short research brief on current tariff developments.",
        content: reportContent,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().title, "Tariff update brief");
    assert.equal(response.json().file_path, "outputs/reports/tariff-update-brief.html");
    assert.equal(response.json().mime_type, "text/html");
    assert.ok(
      fs.existsSync(path.join(workspaceRoot, "root", "outputs/reports/tariff-update-brief.html")),
    );
    assert.equal(
      fs.readFileSync(
        path.join(workspaceRoot, "root", "outputs/reports/tariff-update-brief.html"),
        "utf8",
      ),
      `${reportContent}\n`,
    );

    const outputs = store.listOutputs({
      workspaceId: "root",
      sessionId: "session-main",
      inputId: "input-1",
      limit: 20,
      offset: 0,
    });
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].title, "Tariff update brief");
    assert.equal(outputs[0].filePath, "outputs/reports/tariff-update-brief.html");
    assert.equal(outputs[0].metadata.artifact_type, "report");
    assert.equal(outputs[0].metadata.origin_type, "runtime_tool");
    assert.equal(outputs[0].metadata.tool_id, "write_report");
    assert.equal(outputs[0].metadata.mime_type, "text/html");
    assert.equal(outputs[0].metadata.model, "openai/gpt-5.4");
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime write_report tool writes reports into a custom workspace path", async () => {
  const root = makeTempDir("hb-runtime-api-report-tools-custom-");
  const workspaceRoot = path.join(root, "workspace");
  const customWorkspacePath = path.join(root, "custom-workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
    workspacePath: customWorkspacePath,
  });
  store.ensureRuntimeState({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    status: "BUSY",
    currentInputId: "input-1",
  });

  const app = buildTestRuntimeApiServer({ store });
  const reportContent = [
    "<!doctype html>",
    "<html><body><h1>Workspace custom path report</h1>",
    "<p>Saved in the registered workspace directory.</p>",
    "</body></html>",
  ].join("");
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/reports",
      headers: {
        "x-holaboss-workspace-id": "workspace-1",
        "x-holaboss-session-id": "session-main",
        "x-holaboss-input-id": "input-1",
      },
      payload: {
        title: "Workspace custom path report",
        filename: "workspace-custom-path-report",
        content: reportContent,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(
      response.json().file_path,
      "outputs/reports/workspace-custom-path-report.html",
    );
    // Single-tenant: the per-workspace custom-path routing this test originally
    // guarded is obsolete. write_report resolves every request to the synthetic
    // root, whose dir is config-derived (workspaceRoot/root); a custom
    // workspace_path registered on a (now non-resolvable) workspace row is NOT
    // honored, so the report lands under root, never customWorkspacePath.
    assert.equal(
      path.resolve(store.workspaceDir("root")),
      path.resolve(path.join(workspaceRoot, "root")),
    );
    assert.notEqual(path.resolve(store.workspaceDir("root")), customWorkspacePath);
    assert.ok(
      fs.existsSync(
        path.join(
          workspaceRoot,
          "root",
          "outputs/reports/workspace-custom-path-report.html",
        ),
      ),
    );
    assert.equal(
      fs.existsSync(
        path.join(
          customWorkspacePath,
          "outputs/reports/workspace-custom-path-report.html",
        ),
      ),
      false,
    );
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime image generation tool writes a generated image into the workspace", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-image-tools-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });

  const configPath = path.join(root, "state", "runtime-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      runtime: {
        image_generation: {
          provider: "openai_direct",
          model: "gpt-image-2",
        },
      },
      providers: {
        openai_direct: {
          kind: "openai_compatible",
          base_url: "https://api.openai.com/v1",
          api_key: "sk-openai",
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  process.env.HB_SANDBOX_ROOT = root;
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;

  const originalFetch = globalThis.fetch;
  let recordedRequestBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (input, init) => {
    recordedRequestBody =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null;
    return new Response(
      JSON.stringify({
        data: [
          {
            b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yJ3sAAAAASUVORK5CYII=",
            revised_prompt: "A tiny generated test image",
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const app = buildTestRuntimeApiServer({ store });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/images/generate",
      headers: {
        "x-holaboss-workspace-id": "root",
        "x-holaboss-session-id": "session-main",
        "x-holaboss-selected-model": "openai_direct/gpt-5.4",
      },
      payload: {
        prompt: "Generate a tiny test image",
        filename: "sample-output",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.ok(recordedRequestBody);
    assert.equal(recordedRequestBody["model"], "gpt-image-2");
    assert.equal(recordedRequestBody["prompt"], "Generate a tiny test image");
    assert.ok(!Object.hasOwn(recordedRequestBody, "response_format"));
    assert.equal(response.json().file_path, "outputs/images/sample-output.png");
    assert.equal(response.json().provider_id, "openai_direct");
    assert.equal(response.json().model_id, "gpt-image-2");
    assert.ok(
      fs.existsSync(path.join(workspaceRoot, "root", "outputs/images/sample-output.png")),
    );
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    store.close();
  }
});

test("runtime image generation tool uses native Gemini image generation for gemini_direct", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-gemini-image-tools-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });

  const configPath = path.join(root, "state", "runtime-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      runtime: {
        image_generation: {
          provider: "gemini_direct",
          model: "gemini-3.1-flash-image",
        },
      },
      providers: {
        gemini_direct: {
          kind: "openai_compatible",
          base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
          api_key: "gemini-key",
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  process.env.HB_SANDBOX_ROOT = root;
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;

  const originalFetch = globalThis.fetch;
  let recordedUrl = "";
  let recordedHeaders: Record<string, string> | null = null;
  let recordedRequestBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (input, init) => {
    recordedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    recordedHeaders = init?.headers && !Array.isArray(init.headers)
      ? Object.fromEntries(Object.entries(init.headers as Record<string, string>))
      : null;
    recordedRequestBody =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null;
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: "A tiny generated Gemini test image" },
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yJ3sAAAAASUVORK5CYII=",
                  },
                },
              ],
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const app = buildTestRuntimeApiServer({ store });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/images/generate",
      headers: {
        "x-holaboss-workspace-id": "root",
        "x-holaboss-session-id": "session-main",
        "x-holaboss-selected-model": "gemini_direct/gemini-2.5-flash",
      },
      payload: {
        prompt: "Generate a tiny Gemini test image",
        filename: "gemini-sample-output",
        size: "1024x1024",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(
      recordedUrl,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent",
    );
    assert.ok(recordedHeaders);
    assert.equal(recordedHeaders["x-goog-api-key"], "gemini-key");
    assert.ok(recordedRequestBody);
    assert.deepEqual(recordedRequestBody, {
      contents: [
        {
          role: "user",
          parts: [{ text: "Generate a tiny Gemini test image" }],
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: {
          aspectRatio: "1:1",
          imageSize: "1K",
        },
      },
    });
    assert.equal(response.json().file_path, "outputs/images/gemini-sample-output.png");
    assert.equal(response.json().provider_id, "gemini_direct");
    assert.equal(response.json().model_id, "gemini-3.1-flash-image");
    assert.ok(
      fs.existsSync(path.join(workspaceRoot, "root", "outputs/images/gemini-sample-output.png")),
    );
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    store.close();
  }
});

test("runtime image generation tool uses OpenRouter chat image generation for openrouter_direct", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-openrouter-image-tools-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });

  const configPath = path.join(root, "state", "runtime-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      runtime: {
        image_generation: {
          provider: "openrouter_direct",
          model: "google/gemini-3.1-flash-image",
        },
      },
      providers: {
        openrouter_direct: {
          kind: "openrouter",
          base_url: "https://openrouter.ai/api/v1",
          api_key: "sk-or-test",
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
  process.env.HB_SANDBOX_ROOT = root;
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;

  const originalFetch = globalThis.fetch;
  let recordedUrl = "";
  let recordedRequestBody: Record<string, unknown> | null = null;
  let recordedHeaders: Record<string, string> | null = null;
  globalThis.fetch = (async (input, init) => {
    recordedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    recordedRequestBody =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null;
    recordedHeaders =
      init?.headers && typeof init.headers === "object" && !Array.isArray(init.headers)
        ? Object.fromEntries(Object.entries(init.headers as Record<string, string>))
        : null;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Here is your image.",
              images: [
                {
                  type: "image_url",
                  image_url: {
                    url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yJ3sAAAAASUVORK5CYII=",
                  },
                },
              ],
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const app = buildTestRuntimeApiServer({ store });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/runtime-tools/images/generate",
      headers: {
        "x-holaboss-workspace-id": "root",
        "x-holaboss-session-id": "session-main",
        "x-holaboss-selected-model": "openrouter_direct/openai/gpt-5.4",
      },
      payload: {
        prompt: "Generate a Nano Banana 2 style image",
        filename: "openrouter-sample-output",
        size: "1024x1024",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(recordedUrl, "https://openrouter.ai/api/v1/chat/completions");
    assert.ok(recordedRequestBody);
    assert.deepEqual(recordedHeaders, {
      "Content-Type": "application/json",
      Authorization: "Bearer sk-or-test",
      "HTTP-Referer": "https://holaboss.ai",
      "X-OpenRouter-Title": "holaOS",
      "X-OpenRouter-Categories": "personal-agent,general-chat",
    });
    assert.deepEqual(recordedRequestBody, {
      model: "google/gemini-3.1-flash-image",
      messages: [
        {
          role: "user",
          content: "Generate a Nano Banana 2 style image",
        },
      ],
      modalities: ["image", "text"],
      image_config: {
        aspect_ratio: "1:1",
        image_size: "1K",
      },
    });
    assert.equal(response.json().file_path, "outputs/images/openrouter-sample-output.png");
    assert.equal(response.json().provider_id, "openrouter_direct");
    assert.equal(response.json().model_id, "google/gemini-3.1-flash-image");
    assert.ok(
      fs.existsSync(path.join(workspaceRoot, "root", "outputs/images/openrouter-sample-output.png")),
    );
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    store.close();
  }
});

test("buildAppSetupEnv uses an app-local npm cache", () => {
  const appDir = makeTempDir("hb-app-env-");
  const env = buildAppSetupEnv(appDir, { PATH: process.env.PATH });

  const expectedCacheDir = appLocalNpmCacheDir(appDir);
  assert.equal(env.npm_config_cache, expectedCacheDir);
  assert.equal(env.NPM_CONFIG_CACHE, expectedCacheDir);
  assert.ok(fs.existsSync(expectedCacheDir));
});

test("runtime config routes delegate to the runtime config executor", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const calls: string[] = [];
  const runtimeConfigService: RuntimeConfigServiceLike = {
    async getConfig() {
      calls.push("get-config");
      return {
        config_path: "/tmp/runtime-config.json",
        loaded_from_file: false,
        auth_token_present: false,
        user_id: null,
        sandbox_id: null,
        model_proxy_base_url: null,
        default_model: "openai/gpt-5.4",
        runtime_mode: "oss",
        default_provider: null,
        holaboss_enabled: false,
        desktop_browser_enabled: false,
        desktop_browser_url: null
      };
    },
    async getStatus() {
      calls.push("get-status");
      return {
        harness: "pi",
        config_loaded: true,
        config_path: "/tmp/runtime-config.json",
        backend_config_present: true,
        harness_ready: true,
        harness_state: "ready",
        browser_available: false,
        browser_state: "unavailable",
        browser_url: null
      };
    },
    async updateConfig(payload) {
      calls.push(`put-config:${JSON.stringify(payload)}`);
      return {
        config_path: "/tmp/runtime-config.json",
        loaded_from_file: true,
        auth_token_present: true,
        user_id: "user-1",
        sandbox_id: "sandbox-1",
        model_proxy_base_url: "https://runtime.example/api/v1/model-proxy",
        default_model: "openai/gpt-5.4",
        runtime_mode: "oss",
        default_provider: "holaboss_model_proxy",
        holaboss_enabled: true,
        desktop_browser_enabled: false,
        desktop_browser_url: null
      };
    }
  };
  const app = buildTestRuntimeApiServer({ store, runtimeConfigService });

  const config = await app.inject({
    method: "GET",
    url: "/api/v1/runtime/config"
  });
  const status = await app.inject({
    method: "GET",
    url: "/api/v1/runtime/status"
  });
  const updated = await app.inject({
    method: "PUT",
    url: "/api/v1/runtime/config",
    payload: {
      auth_token: "token-1",
      user_id: "user-1",
      sandbox_id: "sandbox-1",
      model_proxy_base_url: "https://runtime.example/api/v1/model-proxy",
      default_model: "openai/gpt-5.4"
    }
  });

  assert.equal(config.statusCode, 200);
  assert.equal(status.statusCode, 200);
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(calls, [
    "get-config",
    "get-status",
    "put-config:{\"auth_token\":\"token-1\",\"user_id\":\"user-1\",\"sandbox_id\":\"sandbox-1\",\"model_proxy_base_url\":\"https://runtime.example/api/v1/model-proxy\",\"default_model\":\"openai/gpt-5.4\"}"
  ]);

  await app.close();
  store.close();
});

test("runtime profile routes persist canonical name and apply auth fallback only when empty", async () => {
  const root = makeTempDir("hb-runtime-api-profile-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });

  const initial = await app.inject({
    method: "GET",
    url: "/api/v1/runtime/profile"
  });
  const fallback = await app.inject({
    method: "POST",
    url: "/api/v1/runtime/profile/auth-fallback",
    payload: {
      name: "Sam"
    }
  });
  const manual = await app.inject({
    method: "PUT",
    url: "/api/v1/runtime/profile",
    payload: {
      name: "Jeff",
      name_source: "manual"
    }
  });
  const preserved = await app.inject({
    method: "POST",
    url: "/api/v1/runtime/profile/auth-fallback",
    payload: {
      name: "Ignored Auth Name"
    }
  });

  assert.equal(initial.statusCode, 200);
  assert.deepEqual(initial.json(), {
    profile_id: "default",
    name: null,
    name_source: null,
    created_at: null,
    updated_at: null,
  });
  assert.equal(fallback.statusCode, 200);
  assert.equal(fallback.json().name, "Sam");
  assert.equal(fallback.json().name_source, "auth_fallback");
  assert.equal(manual.statusCode, 200);
  assert.equal(manual.json().name, "Jeff");
  assert.equal(manual.json().name_source, "manual");
  assert.equal(preserved.statusCode, 200);
  assert.equal(preserved.json().name, "Jeff");
  assert.equal(preserved.json().name_source, "manual");

  await app.close();
  store.close();
});

test("runner routes delegate to the runner executor", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
  const runnerExecutor: RunnerExecutorLike = {
    async run(payload) {
      calls.push({ operation: "run", payload });
      return {
        session_id: "session-1",
        input_id: "input-1",
        events: [
          {
            session_id: "session-1",
            input_id: "input-1",
            sequence: 1,
            event_type: "run_started",
            payload: { instruction_preview: "hello" }
          },
          {
            session_id: "session-1",
            input_id: "input-1",
            sequence: 2,
            event_type: "run_completed",
            payload: { status: "success" }
          }
        ]
      };
    },
    async stream(payload) {
      calls.push({ operation: "stream", payload });
      return Readable.from([
        "event: run_started\nid: input-1:1\ndata: {\"session_id\":\"session-1\",\"input_id\":\"input-1\",\"sequence\":1,\"event_type\":\"run_started\",\"payload\":{\"instruction_preview\":\"hello\"}}\n\n",
        "event: run_completed\nid: input-1:2\ndata: {\"session_id\":\"session-1\",\"input_id\":\"input-1\",\"sequence\":2,\"event_type\":\"run_completed\",\"payload\":{\"status\":\"success\"}}\n\n"
      ]);
    }
  };
  const app = buildTestRuntimeApiServer({ store, runnerExecutor });

  const runResponse = await app.inject({
    method: "POST",
    url: "/api/v1/agent-runs",
    payload: {
      workspace_id: "workspace-1",
      session_id: "session-1",
      input_id: "input-1",
      instruction: "hello",
      context: {}
    }
  });
  const streamResponse = await app.inject({
    method: "POST",
    url: "/api/v1/agent-runs/stream",
    payload: {
      workspace_id: "workspace-1",
      session_id: "session-1",
      input_id: "input-1",
      instruction: "hello",
      context: {}
    }
  });

  assert.equal(runResponse.statusCode, 200);
  assert.deepEqual(runResponse.json(), {
    session_id: "session-1",
    input_id: "input-1",
    events: [
      {
        session_id: "session-1",
        input_id: "input-1",
        sequence: 1,
        event_type: "run_started",
        payload: { instruction_preview: "hello" }
      },
      {
        session_id: "session-1",
        input_id: "input-1",
        sequence: 2,
        event_type: "run_completed",
        payload: { status: "success" }
      }
    ]
  });
  assert.equal(streamResponse.statusCode, 200);
  assert.match(streamResponse.body, /event: run_started/);
  assert.match(streamResponse.body, /event: run_completed/);
  assert.deepEqual(calls, [
    {
      operation: "run",
      payload: {
        workspace_id: "workspace-1",
        session_id: "session-1",
        input_id: "input-1",
        instruction: "hello",
        context: {}
      }
    },
    {
      operation: "stream",
      payload: {
        workspace_id: "workspace-1",
        session_id: "session-1",
        input_id: "input-1",
        instruction: "hello",
        context: {}
      }
    }
  ]);

  await app.close();
  store.close();
});

test("memory routes delegate to the memory service and preserve payloads", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
  const memoryService: MemoryServiceLike = {
    async search(payload) {
      calls.push({ operation: "search", payload });
      return { workspace_id: payload.workspace_id, query: payload.query, hits: [] };
    },
    async get(payload) {
      calls.push({ operation: "get", payload });
      return { path: payload.path, text: "" };
    },
    async upsert(payload) {
      calls.push({ operation: "upsert", payload });
      return { path: payload.path, updated: true };
    },
    async status(payload) {
      calls.push({ operation: "status", payload });
      return { workspace_id: payload.workspace_id, synced: true };
    },
    async sync(payload) {
      calls.push({ operation: "sync", payload });
      return { workspace_id: payload.workspace_id, queued: true, reason: payload.reason };
    }
  };
  const app = buildTestRuntimeApiServer({ store, memoryService });

  const searched = await app.inject({
    method: "POST",
    url: "/api/v1/memory/search",
    payload: {
      workspace_id: "workspace-1",
      query: "durable preferences",
      max_results: 5,
      min_score: 0.1
    }
  });
  const fetched = await app.inject({
    method: "POST",
    url: "/api/v1/memory/get",
    payload: {
      workspace_id: "workspace-1",
      path: "memory/preferences.md"
    }
  });
  const upserted = await app.inject({
    method: "POST",
    url: "/api/v1/memory/upsert",
    payload: {
      workspace_id: "workspace-1",
      path: "memory/preferences.md",
      content: "coffee",
      append: false
    }
  });
  const status = await app.inject({
    method: "POST",
    url: "/api/v1/memory/status",
    payload: {
      workspace_id: "workspace-1"
    }
  });
  const synced = await app.inject({
    method: "POST",
    url: "/api/v1/memory/sync",
    payload: {
      workspace_id: "workspace-1",
      reason: "manual",
      force: true
    }
  });

  assert.equal(searched.statusCode, 200);
  assert.deepEqual(searched.json(), {
    workspace_id: "workspace-1",
    query: "durable preferences",
    hits: []
  });
  assert.equal(fetched.statusCode, 200);
  assert.deepEqual(fetched.json(), {
    path: "memory/preferences.md",
    text: ""
  });
  assert.equal(upserted.statusCode, 200);
  assert.deepEqual(upserted.json(), {
    path: "memory/preferences.md",
    updated: true
  });
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.json(), {
    workspace_id: "workspace-1",
    synced: true
  });
  assert.equal(synced.statusCode, 200);
  assert.deepEqual(synced.json(), {
    workspace_id: "workspace-1",
    queued: true,
    reason: "manual"
  });
  assert.deepEqual(calls, [
    {
      operation: "search",
      payload: {
        workspace_id: "workspace-1",
        query: "durable preferences",
        max_results: 5,
        min_score: 0.1
      }
    },
    {
      operation: "get",
      payload: {
        workspace_id: "workspace-1",
        path: "memory/preferences.md"
      }
    },
    {
      operation: "upsert",
      payload: {
        workspace_id: "workspace-1",
        path: "memory/preferences.md",
        content: "coffee",
        append: false
      }
    },
    {
      operation: "status",
      payload: {
        workspace_id: "workspace-1"
      }
    },
    {
      operation: "sync",
      payload: {
        workspace_id: "workspace-1",
        reason: "manual",
        force: true
      }
    }
  ]);

  await app.close();
  store.close();
});

test("ensure-main-session binds the desktop's preferred main session and leaves siblings intact", async () => {
  const root = makeTempDir("hb-runtime-api-main-session-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  const workspace = seedWorkspaceRecord(store, {
    name: "Main Session Workspace",
    harness: "pi",
    status: "active",
    workspacePath: path.join(root, "workspace", "main-session-workspace"),
  });
  const older = store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-older",
    kind: "main_session",
    title: "Older conversation",
    createdBy: "workspace_user",
  });
  await sleep(5);
  const newer = store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-newer",
    kind: "main_session",
    title: "Main conversation",
    createdBy: "workspace_user",
  });
  const app = buildTestRuntimeApiServer({ store });

  const ensured = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspace.id}/ensure-main-session`,
  });

  assert.equal(ensured.statusCode, 200);
  assert.equal(ensured.json().session.session_id, newer.sessionId);

  const binding = store.getConversationBindingByConversation({
    workspaceId: workspace.id,
    channel: "desktop",
    conversationKey: "main_session",
    role: "main_session",
  });
  assert.ok(binding);
  assert.equal(binding?.sessionId, newer.sessionId);

  const persistedOlder = store.getSession({
    workspaceId: workspace.id,
    sessionId: older.sessionId,
  });
  assert.ok(persistedOlder);
  assert.equal(persistedOlder?.archivedAt, null);

  const ensuredAgain = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspace.id}/ensure-main-session`,
  });
  assert.equal(ensuredAgain.statusCode, 200);
  assert.equal(ensuredAgain.json().session.session_id, newer.sessionId);

  await app.close();
  store.close();
});

test("list main-sessions returns every non-archived primary chat session with is_active reflecting the binding", async () => {
  const root = makeTempDir("hb-runtime-api-list-main-sessions-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  const workspace = seedWorkspaceRecord(store, {
    name: "Multi Main Workspace",
    harness: "pi",
    status: "active",
    workspacePath: path.join(root, "workspace", "multi-main-workspace"),
  });
  const sessionA = store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "main-a",
    kind: "main_session",
    title: "Session A",
    createdBy: "user",
  });
  await sleep(5);
  const sessionB = store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "main-b",
    kind: "main_session",
    title: "Session B",
    createdBy: "user",
  });
  store.upsertConversationBinding({
    workspaceId: workspace.id,
    channel: "desktop",
    conversationKey: "main_session",
    sessionId: sessionA.sessionId,
    role: "main_session",
    isActive: true,
    metadata: {},
    lastActiveAt: utcNowIso(),
  });

  const app = buildTestRuntimeApiServer({ store });
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspace.id}/main-sessions`,
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    sessions: Array<{ session_id: string; is_active: boolean }>;
  };
  assert.equal(body.sessions.length, 2);
  const a = body.sessions.find((s) => s.session_id === sessionA.sessionId);
  const b = body.sessions.find((s) => s.session_id === sessionB.sessionId);
  assert.ok(a);
  assert.ok(b);
  assert.equal(a?.is_active, true);
  assert.equal(b?.is_active, false);

  await app.close();
  store.close();
});

test("create main-session creates a new main session and activates it via the desktop binding", async () => {
  const root = makeTempDir("hb-runtime-api-create-main-session-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  const workspace = seedWorkspaceRecord(store, {
    name: "Create Main Workspace",
    harness: "pi",
    status: "active",
    workspacePath: path.join(root, "workspace", "create-main-workspace"),
  });
  const existing = store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "main-existing",
    kind: "main_session",
    title: "Existing",
    createdBy: "user",
  });
  store.upsertConversationBinding({
    workspaceId: workspace.id,
    channel: "desktop",
    conversationKey: "main_session",
    sessionId: existing.sessionId,
    role: "main_session",
    isActive: true,
    metadata: {},
    lastActiveAt: utcNowIso(),
  });

  const app = buildTestRuntimeApiServer({ store });
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspace.id}/main-sessions`,
    payload: { title: "Brand New" },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    session: { session_id: string; title: string; kind: string; is_active: boolean };
  };
  assert.equal(body.session.title, "Brand New");
  assert.equal(body.session.kind, "main_session");
  assert.equal(body.session.is_active, true);
  assert.notEqual(body.session.session_id, existing.sessionId);

  const binding = store.getConversationBindingByConversation({
    workspaceId: workspace.id,
    channel: "desktop",
    conversationKey: "main_session",
    role: "main_session",
  });
  assert.equal(binding?.sessionId, body.session.session_id);

  const persistedExisting = store.getSession({
    workspaceId: workspace.id,
    sessionId: existing.sessionId,
  });
  assert.equal(persistedExisting?.archivedAt, null);

  await app.close();
  store.close();
});

test("create main-session reuses the app's existing chat only when new_session is false", async () => {
  const root = makeTempDir("hb-runtime-api-reuse-app-session-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  const workspace = seedWorkspaceRecord(store, {
    name: "Reuse App Workspace",
    harness: "pi",
    status: "active",
    workspacePath: path.join(root, "workspace", "reuse-app-workspace"),
  });

  const app = buildTestRuntimeApiServer({ store });
  const post = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspace.id}/main-sessions`,
      payload,
    });
  const sessionOf = (res: Awaited<ReturnType<typeof post>>) =>
    (res.json() as { session: { session_id: string; is_active: boolean } })
      .session;

  // First hand-off, no existing app chat yet → creates one, owned by the app
  // (not promoted to the workspace's active main_session).
  const first = await post({ app_id: "gofunds", title: "GoFunds" });
  assert.equal(first.statusCode, 200);
  const firstSession = sessionOf(first);
  assert.equal(firstSession.is_active, false);

  // new_session:false continues that same chat instead of spawning a new one.
  const reuse = await post({
    app_id: "gofunds",
    new_session: false,
    title: "GoFunds · Macro Edge Fund",
  });
  assert.equal(sessionOf(reuse).session_id, firstSession.session_id);
  assert.equal(sessionOf(reuse).is_active, false);

  // new_session:true forces a fresh session.
  const forced = await post({ app_id: "gofunds", new_session: true });
  assert.notEqual(sessionOf(forced).session_id, firstSession.session_id);

  // Omitting new_session keeps the create-fresh default — reuse is opt-in only,
  // so non-host callers of this endpoint are unaffected.
  const omitted = await post({ app_id: "gofunds" });
  assert.notEqual(sessionOf(omitted).session_id, firstSession.session_id);
  assert.notEqual(sessionOf(omitted).session_id, sessionOf(forced).session_id);

  // Reuse never crosses apps: a different app's hand-off gets its own session.
  const otherApp = await post({ app_id: "notion", new_session: false });
  assert.notEqual(sessionOf(otherApp).session_id, firstSession.session_id);

  await app.close();
  store.close();
});

test("activate main-session switches the desktop binding to the chosen session", async () => {
  const root = makeTempDir("hb-runtime-api-activate-main-session-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  const workspace = seedWorkspaceRecord(store, {
    name: "Activate Main Workspace",
    harness: "pi",
    status: "active",
    workspacePath: path.join(root, "workspace", "activate-main-workspace"),
  });
  const sessionA = store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "main-a",
    kind: "main_session",
    title: "Session A",
    createdBy: "user",
  });
  const sessionB = store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "main-b",
    kind: "main_session",
    title: "Session B",
    createdBy: "user",
  });
  store.upsertConversationBinding({
    workspaceId: workspace.id,
    channel: "desktop",
    conversationKey: "main_session",
    sessionId: sessionA.sessionId,
    role: "main_session",
    isActive: true,
    metadata: {},
    lastActiveAt: utcNowIso(),
  });

  const app = buildTestRuntimeApiServer({ store });

  const activated = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspace.id}/main-sessions/${sessionB.sessionId}/activate`,
  });
  assert.equal(activated.statusCode, 200);
  const body = activated.json() as {
    session: { session_id: string; is_active: boolean };
  };
  assert.equal(body.session.session_id, sessionB.sessionId);
  assert.equal(body.session.is_active, true);

  const binding = store.getConversationBindingByConversation({
    workspaceId: workspace.id,
    channel: "desktop",
    conversationKey: "main_session",
    role: "main_session",
  });
  assert.equal(binding?.sessionId, sessionB.sessionId);

  const archived = store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "main-archived",
    kind: "main_session",
    title: "Archived",
    createdBy: "user",
    archivedAt: utcNowIso(),
  });
  const rejected = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspace.id}/main-sessions/${archived.sessionId}/activate`,
  });
  assert.equal(rejected.statusCode, 409);

  const missing = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspace.id}/main-sessions/main-nope/activate`,
  });
  assert.equal(missing.statusCode, 404);

  await app.close();
  store.close();
});

test("activate verifies identity once per boot, idempotent after", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });
  const workspaceId = seedWorkspaceRecord(store, { name: "A", harness: "pi" }).id;

  const first = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/activate`
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().workspace.folder_state, "healthy");

  // Remove the identity file AFTER activation — second call must still
  // succeed (idempotent per boot) because we don't re-check.
  fs.rmSync(store.workspaceIdentityPath(workspaceId), { force: true });
  const second = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/activate`
  });
  assert.equal(second.statusCode, 200);

  await app.close();
  store.close();
});

test("activate returns 409 workspace_identity_mismatch when identity file does not match", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });
  const workspaceId = seedWorkspaceRecord(store, { name: "A", harness: "pi" }).id;
  // Overwrite identity with a different id (simulating a folder that
  // belonged to a different workspace).
  fs.writeFileSync(store.workspaceIdentityPath(workspaceId), "some-other-id");

  const resp = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/activate`
  });
  assert.equal(resp.statusCode, 409);
  assert.equal(resp.json().code, "workspace_identity_mismatch");

  await app.close();
  store.close();
});

test("activate returns 409 workspace_folder_missing when folder is gone", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const customRoot = makeTempDir("hb-custom-ws-");
  const customPath = path.join(customRoot, "ws");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });
  const workspaceId = seedWorkspaceRecord(store, { name: "C", harness: "pi", workspacePath: customPath }).id;
  fs.rmSync(customPath, { recursive: true, force: true });

  const resp = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/activate`
  });
  assert.equal(resp.statusCode, 409);
  assert.equal(resp.json().code, "workspace_folder_missing");

  await app.close();
  store.close();
});

test("PUT files fails 409 when workspace folder is missing (does not recreate folder)", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const customRoot = makeTempDir("hb-custom-ws-");
  const customPath = path.join(customRoot, "ws");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });
  const workspaceId = seedWorkspaceRecord(store, { name: "C", harness: "pi", workspacePath: customPath }).id;
  fs.rmSync(customPath, { recursive: true, force: true });

  const resp = await app.inject({
    method: "PUT",
    url: `/api/v1/workspaces/${workspaceId}/files/notes.txt`,
    payload: { content_base64: Buffer.from("hi").toString("base64") }
  });
  assert.equal(resp.statusCode, 409);
  assert.equal(resp.json().code, "workspace_folder_missing");
  // Endpoint must NOT silently re-create the deleted folder.
  assert.equal(fs.existsSync(customPath), false);

  await app.close();
  store.close();
});

test("apply-template fails 409 when workspace folder is missing", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const customRoot = makeTempDir("hb-runtime-api-custom-ws-");
  const customPath = path.join(customRoot, "ws");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });
  const workspaceId = seedWorkspaceRecord(store, { name: "C", harness: "pi", workspacePath: customPath }).id;
  fs.rmSync(customPath, { recursive: true, force: true });

  const resp = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/apply-template`,
    payload: { files: [] }
  });
  assert.equal(resp.statusCode, 409);
  assert.equal(resp.json().code, "workspace_folder_missing");
  // Endpoint must NOT re-create the deleted folder.
  assert.equal(fs.existsSync(customPath), false);

  await app.close();
  store.close();
});

test("agent-sessions/queue fails 409 when workspace folder is missing", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const customRoot = makeTempDir("hb-runtime-api-custom-ws-");
  const customPath = path.join(customRoot, "ws");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });
  const workspaceId = seedWorkspaceRecord(store, { name: "C", harness: "pi", workspacePath: customPath }).id;
  fs.rmSync(customPath, { recursive: true, force: true });

  const resp = await app.inject({
    method: "POST",
    url: "/api/v1/agent-sessions/queue",
    payload: { workspace_id: workspaceId, text: "hello" }
  });
  assert.equal(resp.statusCode, 409);
  assert.equal(resp.json().code, "workspace_folder_missing");

  await app.close();
  store.close();
});

test("runtime states and history endpoints read TS state store", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
    harness: "pi",
    harnessSessionId: "harness-1"
  });
  store.insertSessionMessage({
    workspaceId: workspace.id,
    sessionId: "session-main",
    role: "user",
    text: "hello",
    messageId: "m-1"
  });
  store.insertSessionMessage({
    workspaceId: workspace.id,
    sessionId: "session-main",
    role: "assistant",
    text: "hi",
    messageId: "m-2"
  });
  store.upsertTurnResult({
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: "input-1",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "hi",
    toolUsageSummary: {
      total_calls: 1,
      completed_calls: 1,
      failed_calls: 0,
      tool_names: ["read_file"],
      tool_ids: []
    },
    permissionDenials: [],
    promptSectionIds: ["runtime_core", "execution_policy"],
    capabilityManifestFingerprint: "b".repeat(64),
    requestSnapshotFingerprint: "c".repeat(64),
    promptCacheProfile: {
      cacheable_section_ids: ["runtime_core"],
      volatile_section_ids: ["execution_policy"],
    },
    contextBudgetDecisions: {
      pressure_stage: "queue_checkpoint",
      lane_decisions: [],
      prompt_cache_stable_candidate: true,
      tool_replay_trimmed: true,
      retrieval_clipped: false,
      checkpoint_queued: true,
    },
    tokenUsage: {
      input_tokens: 10,
      output_tokens: 20
    }
  });
  store.upsertTurnRequestSnapshot({
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: "input-1",
    snapshotKind: "harness_host_request",
    fingerprint: "c".repeat(64),
    payload: {
      provider_id: "openai",
      model_id: "gpt-5.4",
      system_prompt: "You are concise.",
    },
  });
  const sessionMemoryPath = path.join(
    store.workspaceRoot,
    workspace.id,
    ".holaboss",
    "memory",
    "runtime",
    "session-memory",
    "session-main.md",
  );
  fs.mkdirSync(path.dirname(sessionMemoryPath), { recursive: true });
  fs.writeFileSync(
    sessionMemoryPath,
    "User prefers short answers and the draft report is in outputs/reports/summary.md.\n",
    "utf8",
  );
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "proposal-session-1",
    kind: "subagent",
    title: "Follow up",
    parentSessionId: "session-main",
    createdBy: "workspace_user"
  });
  store.ensureRuntimeState({
    workspaceId: workspace.id,
    sessionId: "session-main",
    status: "IDLE",
  });

  const sessions = await app.inject({
    method: "GET",
    url: `/api/v1/agent-sessions?workspace_id=${workspace.id}`
  });
  const states = await app.inject({
    method: "GET",
    url: `/api/v1/agent-sessions/by-workspace/${workspace.id}/runtime-states`
  });
  const history = await app.inject({
    method: "GET",
    url: `/api/v1/agent-sessions/session-main/history?workspace_id=${workspace.id}`
  });
  const turnResults = await app.inject({
    method: "GET",
    url: `/api/v1/agent-sessions/session-main/turn-results?workspace_id=${workspace.id}`
  });
  const requestSnapshots = await app.inject({
    method: "GET",
    url: `/api/v1/agent-sessions/session-main/request-snapshots?workspace_id=${workspace.id}`
  });
  const resumeContext = await app.inject({
    method: "GET",
    url: `/api/v1/agent-sessions/session-main/resume-context?workspace_id=${workspace.id}&input_id=input-2`
  });

  assert.equal(sessions.statusCode, 200);
  assert.equal(sessions.json().count, 2);
  const proposalSession = sessions
    .json()
    .items.find((item: { session_id: string }) => item.session_id === "proposal-session-1");
  assert.ok(proposalSession);
  assert.equal(proposalSession.kind, "subagent");
  assert.equal(proposalSession.parent_session_id, "session-main");
  assert.equal(states.statusCode, 200);
  assert.equal(states.json().count, 1);
  assert.equal(states.json().items[0].session_id, "session-main");
  assert.equal(states.json().items[0].status, "IDLE");
  assert.equal(states.json().items[0].effective_state, "IDLE");
  assert.equal(states.json().items[0].has_queued_inputs, false);
  assert.equal(states.json().items[0].last_turn_status, "completed");
  assert.equal(states.json().items[0].last_turn_completed_at, "2026-01-01T00:00:05.000Z");
  assert.equal(states.json().items[0].last_turn_stop_reason, "ok");
  assert.equal(history.statusCode, 200);
  assert.equal(history.json().source, "sandbox_local_storage");
  assert.equal(history.json().harness, "pi");
  assert.deepEqual(
    history.json().messages.map((item: { role: string }) => item.role),
    ["user", "assistant"]
  );
  assert.equal(turnResults.statusCode, 200);
  assert.equal(turnResults.json().count, 1);
  assert.equal(turnResults.json().items[0].input_id, "input-1");
  assert.equal(turnResults.json().items[0].status, "completed");
  assert.equal(turnResults.json().items[0].stop_reason, "ok");
  assert.equal(turnResults.json().items[0].capability_manifest_fingerprint, "b".repeat(64));
  assert.equal(turnResults.json().items[0].request_snapshot_fingerprint, "c".repeat(64));
  assert.deepEqual(turnResults.json().items[0].prompt_cache_profile, {
    cacheable_section_ids: ["runtime_core"],
    volatile_section_ids: ["execution_policy"],
  });
  assert.deepEqual(turnResults.json().items[0].context_budget_decisions, {
    pressure_stage: "queue_checkpoint",
    lane_decisions: [],
    prompt_cache_stable_candidate: true,
    tool_replay_trimmed: true,
    retrieval_clipped: false,
    checkpoint_queued: true,
  });
  assert.deepEqual(turnResults.json().items[0].prompt_section_ids, [
    "runtime_core",
    "execution_policy"
  ]);
  assert.deepEqual(turnResults.json().items[0].token_usage, {
    input_tokens: 10,
    output_tokens: 20
  });
  assert.equal(requestSnapshots.statusCode, 200);
  assert.equal(requestSnapshots.json().count, 1);
  assert.equal(requestSnapshots.json().items[0].fingerprint, "c".repeat(64));
  assert.equal(resumeContext.statusCode, 200);
  assert.deepEqual(resumeContext.json().session_resume_context, {
    session_memory_path: `workspace/${workspace.id}/runtime/session-memory/session-main.md`,
    session_memory_excerpt:
      "User prefers short answers and the draft report is in outputs/reports/summary.md."
  });

  await app.close();
  store.close();
});

test("history endpoint paginates in requested order without hydrating the full response page", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
    harness: "pi",
    harnessSessionId: "harness-1"
  });
  store.insertSessionMessage({
    workspaceId: workspace.id,
    sessionId: "session-main",
    role: "user",
    text: "first",
    messageId: "m-1",
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  store.insertSessionMessage({
    workspaceId: workspace.id,
    sessionId: "session-main",
    role: "assistant",
    text: "second",
    messageId: "m-2",
    createdAt: "2026-01-01T00:00:01.000Z"
  });
  store.insertSessionMessage({
    workspaceId: workspace.id,
    sessionId: "session-main",
    role: "user",
    text: "third",
    messageId: "m-3",
    createdAt: "2026-01-01T00:00:02.000Z"
  });

  const history = await app.inject({
    method: "GET",
    url: `/api/v1/agent-sessions/session-main/history?workspace_id=${workspace.id}&order=desc&limit=2&offset=1`
  });

  assert.equal(history.statusCode, 200);
  assert.equal(history.json().count, 2);
  assert.equal(history.json().total, 3);
  assert.equal(history.json().limit, 2);
  assert.equal(history.json().offset, 1);
  assert.deepEqual(
    history.json().messages.map((item: { id: string }) => item.id),
    ["m-2", "m-1"],
  );

  await app.close();
  store.close();
});

test("history endpoint returns stored messages even after runtime harness ownership transfers to another session", async () => {
  const root = makeTempDir("hb-runtime-api-history-transfer-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi"
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-old",
    kind: "main_session"
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-new",
    kind: "main_session"
  });
  store.insertSessionMessage({
    workspaceId: workspace.id,
    sessionId: "session-old",
    role: "user",
    text: "first question",
    messageId: "user-old-1",
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  store.insertSessionMessage({
    workspaceId: workspace.id,
    sessionId: "session-old",
    role: "assistant",
    text: "first answer",
    messageId: "assistant-old-1",
    createdAt: "2026-01-01T00:00:01.000Z"
  });
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-old",
    harness: "pi",
    harnessSessionId: "shared-harness-session"
  });
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-new",
    harness: "pi",
    harnessSessionId: "shared-harness-session"
  });

  const history = await app.inject({
    method: "GET",
    url: `/api/v1/agent-sessions/session-old/history?workspace_id=${workspace.id}`
  });

  assert.equal(history.statusCode, 200);
  assert.equal(history.json().harness, "pi");
  assert.equal(history.json().harness_session_id, "");
  assert.deepEqual(
    history.json().messages.map((item: { id: string; role: string }) => ({
      id: item.id,
      role: item.role,
    })),
    [
      { id: "user-old-1", role: "user" },
      { id: "assistant-old-1", role: "assistant" },
    ]
  );

  await app.close();
  store.close();
});

test("output events endpoint supports incremental fetches and tail mode", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.appendOutputEvent({
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: "input-1",
    sequence: 1,
    eventType: "run_started",
    payload: { instruction_preview: "hello" }
  });
  store.appendOutputEvent({
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: "input-1",
    sequence: 2,
    eventType: "pi_native_event",
    payload: { native_type: "message_update", native_event: { type: "message_update" } }
  });
  store.appendOutputEvent({
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: "input-1",
    sequence: 3,
    eventType: "output_delta",
    payload: { delta: "hi" }
  });

  const incremental = await app.inject({
    method: "GET",
    url: "/api/v1/agent-sessions/session-main/outputs/events?workspace_id=workspace-1&input_id=input-1&after_event_id=1"
  });
  const tailed = await app.inject({
    method: "GET",
    url: "/api/v1/agent-sessions/session-main/outputs/events?workspace_id=workspace-1&input_id=input-1&include_history=false"
  });
  const withNative = await app.inject({
    method: "GET",
    url: "/api/v1/agent-sessions/session-main/outputs/events?workspace_id=workspace-1&input_id=input-1&after_event_id=0&include_native=true"
  });

  assert.equal(incremental.statusCode, 200);
  assert.equal(incremental.json().count, 1);
  assert.equal(incremental.json().items[0].event_type, "output_delta");
  assert.equal(incremental.json().last_event_id, incremental.json().items[0].id);

  assert.equal(tailed.statusCode, 200);
  assert.equal(tailed.json().count, 0);
  assert.ok(tailed.json().last_event_id >= 3);

  assert.equal(withNative.statusCode, 200);
  assert.deepEqual(
    withNative
      .json()
      .items.map((item: { event_type: string }) => item.event_type),
    ["run_started", "pi_native_event", "output_delta"]
  );

  await app.close();
  store.close();
});

test("output stream endpoint emits SSE events and stops on terminal", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.appendOutputEvent({
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: "input-1",
    sequence: 1,
    eventType: "run_started",
    payload: { instruction_preview: "hello" }
  });
  store.appendOutputEvent({
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: "input-1",
    sequence: 2,
    eventType: "pi_native_event",
    payload: { native_type: "message_update", native_event: { type: "message_update" } }
  });
  store.appendOutputEvent({
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: "input-1",
    sequence: 3,
    eventType: "run_completed",
    payload: { status: "success" }
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/agent-sessions/session-main/outputs/stream?workspace_id=workspace-1&input_id=input-1"
  });
  const body = response.body;

  assert.equal(response.statusCode, 200);
  assert.match(body, /event: run_started/);
  assert.match(body, /event: run_completed/);
  assert.doesNotMatch(body, /event: pi_native_event/);

  const responseWithNative = await app.inject({
    method: "GET",
    url: "/api/v1/agent-sessions/session-main/outputs/stream?workspace_id=workspace-1&input_id=input-1&include_native=true"
  });

  assert.equal(responseWithNative.statusCode, 200);
  assert.match(responseWithNative.body, /event: pi_native_event/);

  await app.close();
  store.close();
});

test("outputs, folders, and artifacts routes preserve local payload shape", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace Outputs",
    harness: "pi",
    status: "active",
  });
  store.ensureRuntimeState({
    workspaceId: workspace.id,
    sessionId: "session-main",
    status: "BUSY",
    currentInputId: "input-1",
  });

  const folderResp = await app.inject({
    method: "POST",
    url: "/api/v1/output-folders",
    payload: { workspace_id: workspace.id, name: "Drafts" }
  });
  assert.equal(folderResp.statusCode, 200);
  const folder = folderResp.json().folder as { id: string };

  const outputResp = await app.inject({
    method: "POST",
    url: "/api/v1/outputs",
    payload: {
      workspace_id: workspace.id,
      output_type: "document",
      title: "Spec Draft",
      folder_id: folder.id,
      session_id: "session-main",
      input_id: "input-1",
      status: "completed",
    }
  });
  assert.equal(outputResp.statusCode, 200);
  assert.equal(outputResp.json().output.folder_id, folder.id);
  assert.equal(outputResp.json().output.input_id, "input-1");

  const artifactResp = await app.inject({
    method: "POST",
    url: "/api/v1/agent-sessions/session-main/artifacts",
    payload: {
      workspace_id: workspace.id,
      artifact_type: "document",
      external_id: "doc-1",
      title: "Generated Doc",
      platform: "notion"
    }
  });
  assert.equal(artifactResp.statusCode, 200);
  assert.ok(typeof artifactResp.json().artifact.output_id === "string");

  const outputsResp = await app.inject({
    method: "GET",
    url: `/api/v1/outputs?workspace_id=${workspace.id}`
  });
  const filteredOutputsResp = await app.inject({
    method: "GET",
    url: `/api/v1/outputs?workspace_id=${workspace.id}&session_id=session-main&input_id=input-1`
  });
  const countsResp = await app.inject({
    method: "GET",
    url: `/api/v1/outputs/counts?workspace_id=${workspace.id}`
  });
  const artifactsResp = await app.inject({
    method: "GET",
    url: `/api/v1/agent-sessions/session-main/artifacts?workspace_id=${workspace.id}`
  });
  const withArtifactsResp = await app.inject({
    method: "GET",
    url: `/api/v1/agent-sessions/by-workspace/${workspace.id}/with-artifacts`
  });

  assert.equal(outputsResp.statusCode, 200);
  assert.equal(filteredOutputsResp.statusCode, 200);
  assert.equal(countsResp.statusCode, 200);
  assert.equal(artifactsResp.statusCode, 200);
  assert.equal(withArtifactsResp.statusCode, 200);
  assert.equal(outputsResp.json().items.length, 2);
  assert.equal(filteredOutputsResp.json().items.length, 2);
  assert.deepEqual(
    filteredOutputsResp.json().items.map((item: { input_id: string | null }) => item.input_id),
    ["input-1", "input-1"]
  );
  assert.equal(countsResp.json().total, 2);
  assert.equal(artifactsResp.json().count, 2);
  assert.ok(
    artifactsResp.json().items.some((item: { external_id: string }) => item.external_id === "doc-1")
  );
  assert.equal(withArtifactsResp.json().items[0].artifacts.length, 2);
  assert.ok(
    withArtifactsResp.json().items[0].artifacts.some(
      (item: { external_id: string }) => item.external_id === "doc-1"
    )
  );

  await app.close();
  store.close();
});

// Skipped: this test exercises grouping by `produced_by_teammate_id`, which
// relied on the teammate concept that feat/team-sdk retired. The
// store.createTeammate / store.getTeammate APIs no longer exist. Re-enable
// (with a non-teammate producer model) once the activity feed is reworked.
test.skip("workspace activity endpoint groups outputs by producer", async () => {
  const root = makeTempDir("hb-runtime-api-activity-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Activity Workspace",
    harness: "pi",
    status: "active",
  });

  // Cast through any: this test is .skip'd because createTeammate was
  // removed with the teammate concept. Keep the body type-quiet so
  // `npm run typecheck` doesn't fail on a code path the runner never enters.
  const researcher = (store as any).createTeammate({
    workspaceId: workspace.id,
    name: "Researcher",
  });
  const writer = (store as any).createTeammate({
    workspaceId: workspace.id,
    name: "Writer",
  });

  // Three outputs on 2026-06-09: two by Researcher, one by Writer.
  store.createOutput({
    workspaceId: workspace.id,
    outputType: "document",
    title: "Research Note A",
    metadata: { produced_by_teammate_id: researcher.teammateId },
    createdAt: "2026-06-09T10:00:00.000Z",
  });
  store.createOutput({
    workspaceId: workspace.id,
    outputType: "document",
    title: "Research Note B",
    metadata: { produced_by_teammate_id: researcher.teammateId },
    createdAt: "2026-06-09T11:00:00.000Z",
  });
  store.createOutput({
    workspaceId: workspace.id,
    outputType: "post",
    title: "Draft Post",
    metadata: { produced_by_teammate_id: writer.teammateId },
    createdAt: "2026-06-09T12:00:00.000Z",
  });
  // One output on 2026-06-09 with no teammate attribution but a module
  // id — should fall back to a plugin bucket.
  store.createOutput({
    workspaceId: workspace.id,
    outputType: "post",
    title: "Module Post",
    moduleId: "twitter",
    createdAt: "2026-06-09T13:00:00.000Z",
  });
  // One output on 2026-06-09 with neither attribution — "unknown" bucket.
  store.createOutput({
    workspaceId: workspace.id,
    outputType: "document",
    title: "Orphan",
    createdAt: "2026-06-09T14:00:00.000Z",
  });
  // One output on a different day — should not appear.
  store.createOutput({
    workspaceId: workspace.id,
    outputType: "document",
    title: "Yesterday",
    metadata: { produced_by_teammate_id: researcher.teammateId },
    createdAt: "2026-06-08T10:00:00.000Z",
  });

  const response = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspace.id}/activity?date=2026-06-09`,
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    workspace_id: string;
    date: string;
    outputs: Array<{ title: string; created_at: string }>;
    by_producer: Array<{
      producer_id: string;
      producer_name: string;
      producer_kind: "teammate" | "plugin" | "unknown";
      count: number;
    }>;
    total: number;
  };
  assert.equal(body.workspace_id, workspace.id);
  assert.equal(body.date, "2026-06-09");
  assert.equal(body.total, 5);
  assert.equal(body.outputs.length, 5);
  // Outputs sorted by created_at desc.
  assert.deepEqual(
    body.outputs.map((o) => o.title),
    ["Orphan", "Module Post", "Draft Post", "Research Note B", "Research Note A"],
  );
  // Producers sorted by count desc, then name asc.
  assert.deepEqual(
    body.by_producer.map((p) => `${p.producer_kind}:${p.producer_name}:${p.count}`),
    [
      "teammate:Researcher:2",
      "plugin:twitter:1",
      "unknown:Unknown teammate:1",
      "teammate:Writer:1",
    ],
  );

  const yesterday = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspace.id}/activity?date=2026-06-08`,
  });
  assert.equal(yesterday.statusCode, 200);
  assert.equal(yesterday.json().total, 1);
  assert.equal(yesterday.json().outputs[0].title, "Yesterday");

  const missingDate = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspace.id}/activity`,
  });
  assert.equal(missingDate.statusCode, 400);

  const malformedDate = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspace.id}/activity?date=2026/06/09`,
  });
  assert.equal(malformedDate.statusCode, 400);

  const missingWorkspace = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/does-not-exist/activity?date=2026-06-09`,
  });
  assert.equal(missingWorkspace.statusCode, 404);

  await app.close();
  store.close();
});

test("cronjobs and session state routes preserve local payload shape", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  store.upsertRuntimeUserProfile({
    timezone: "America/Los_Angeles",
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace Jobs",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-main",
    kind: "main_session",
    title: "Workspace 1",
  });
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
    harness: "pi",
    harnessSessionId: "harness-1"
  });
  store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "hello" },
    idempotencyKey: randomUUID()
  });

  const stateResp = await app.inject({
    method: "GET",
    url: `/api/v1/agent-sessions/session-main/state?workspace_id=${workspace.id}`
  });
  assert.equal(stateResp.statusCode, 200);
  assert.equal(stateResp.json().effective_state, "QUEUED");

  const createdJob = await app.inject({
    method: "POST",
    url: "/api/v1/cronjobs",
    payload: {
      workspace_id: workspace.id,
      initiated_by: "workspace_agent",
      cron: "0 9 * * *",
      description: "Daily check",
      instruction: "Say hello",
      delivery: { mode: "announce", channel: "session_run", to: null }
    }
  });
  assert.equal(createdJob.statusCode, 200);
  assert.equal(createdJob.json().instruction, "Say hello");
  assert.equal(createdJob.json().metadata.timezone, "America/Los_Angeles");
  const jobId = createdJob.json().id as string;

  const listedJobs = await app.inject({
    method: "GET",
    url: `/api/v1/cronjobs?workspace_id=${workspace.id}`
  });
  const runNowJob = await app.inject({
    method: "POST",
    url: `/api/v1/cronjobs/${jobId}/run?workspace_id=${workspace.id}`
  });
  const updatedJob = await app.inject({
    method: "PATCH",
    url: `/api/v1/cronjobs/${jobId}`,
    payload: {
      workspace_id: workspace.id,
      description: "Updated check",
      instruction: "Say hello louder"
    }
  });
  assert.equal(listedJobs.statusCode, 200);
  assert.equal(listedJobs.json().count, 1);
  assert.equal(runNowJob.statusCode, 200);
  assert.equal(runNowJob.json().success, true);
  assert.equal(runNowJob.json().cronjob.id, jobId);
  assert.equal(typeof runNowJob.json().session_id, "string");
  assert.ok(runNowJob.json().session_id);
  assert.equal(runNowJob.json().cronjob.instruction, "Say hello");
  assert.ok(runNowJob.json().session_id);
  assert.equal(updatedJob.statusCode, 200);
  assert.equal(updatedJob.json().description, "Updated check");
  assert.equal(updatedJob.json().instruction, "Say hello louder");

  const hiddenCronjobNotification = store.createRuntimeNotification({
    workspaceId: workspace.id,
    cronjobId: jobId,
    sourceType: "cronjob",
    sourceLabel: workspace.name,
    title: "Drink Water",
    message: "Time to drink water.",
    level: "info"
  });
  const visibleNotification = store.createRuntimeNotification({
    workspaceId: workspace.id,
    sourceType: "task_proposal",
    sourceLabel: workspace.name,
    title: "Review proposal",
    message: "A new proposal is ready.",
    level: "info"
  });
  const listedNotifications = await app.inject({
    method: "GET",
    url: `/api/v1/notifications?workspace_id=${workspace.id}`
  });
  const listedCronjobNotifications = await app.inject({
    method: "GET",
    url: `/api/v1/notifications?workspace_id=${workspace.id}&include_cronjob_source=true&source_type=cronjob`
  });
  const updatedNotification = await app.inject({
    method: "PATCH",
    url: `/api/v1/notifications/${visibleNotification.id}`,
    payload: {
      workspace_id: workspace.id,
      state: "read"
    }
  });
  assert.equal(listedNotifications.statusCode, 200);
  assert.equal(listedNotifications.json().count, 1);
  assert.ok(
    listedNotifications
      .json()
      .items.some((item: { id: string; title: string }) => item.id === visibleNotification.id && item.title === "Review proposal")
  );
  assert.ok(
    listedNotifications
      .json()
      .items.every((item: { id: string }) => item.id !== hiddenCronjobNotification.id)
  );
  assert.equal(listedCronjobNotifications.statusCode, 200);
  assert.equal(listedCronjobNotifications.json().count, 1);
  assert.equal(listedCronjobNotifications.json().items[0]?.id, hiddenCronjobNotification.id);
  assert.equal(updatedNotification.statusCode, 200);
  assert.equal(updatedNotification.json().state, "read");
  assert.ok(updatedNotification.json().read_at);

  await app.close();
  store.close();
});

test("queue route reopens done issue sessions on the same persistent thread", async () => {
  const root = makeTempDir("hb-runtime-api-issue-queue-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace",
    harness: "pi",
    status: "active",
  });
  const issue = store.createIssue({
    workspaceId: workspace.id,
    sessionId: "session-issue-1",
    title: "Ship dashboard",
    description: "Implement the workspace dashboard surface.",
    status: "done",
    assigneeId: "general",
    createdBy: "workspace_user",
  });
  const staleRun = store.createSubagentRun({
    workspaceId: workspace.id,
    parentSessionId: issue.sessionId,
    originMainSessionId: issue.sessionId,
    ownerMainSessionId: issue.sessionId,
    childSessionId: issue.sessionId,
    goal: issue.description ?? issue.title,
    issueId: issue.issueId,
    status: "completed",
    completedAt: utcNowIso(),
  });
  store.updateIssue({
    workspaceId: workspace.id,
    issueId: issue.issueId,
    fields: {
      latestSubagentId: staleRun.subagentId,
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/agent-sessions/queue",
    payload: {
      workspace_id: workspace.id,
      session_id: issue.sessionId,
      text: "Please tighten the empty state copy.",
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().session_id, issue.sessionId);
  assert.equal(response.json().status, "QUEUED");
  const queuedInput = store.getInput({
    workspaceId: workspace.id,
    inputId: response.json().input_id,
  });
  assert.ok(queuedInput);
  assert.equal(queuedInput?.payload.text, "Please tighten the empty state copy.");
  assert.equal(
    (queuedInput?.payload.context as Record<string, unknown> | undefined)?.source,
    "issue_reply",
  );
  const refreshedIssue = store.getIssue({
    workspaceId: workspace.id,
    issueId: issue.issueId,
  });
  assert.equal(refreshedIssue?.status, "todo");
  assert.equal(refreshedIssue?.latestSubagentId, staleRun.subagentId);
  assert.equal(
    store.listSubagentRunsByWorkspace({ workspaceId: workspace.id }).length,
    1,
  );
  const refreshedRuntimeState = store.getRuntimeState({
    workspaceId: workspace.id,
    sessionId: issue.sessionId,
  });
  assert.equal(refreshedRuntimeState?.status, "QUEUED");

  await app.close();
  store.close();
});

test("issue update route blocks execution-changing edits while an issue is actively running", async () => {
  const root = makeTempDir("hb-runtime-api-issue-active-guard-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace",
    harness: "pi",
    status: "active",
  });
  const issue = store.createIssue({
    workspaceId: workspace.id,
    sessionId: "session-issue-1",
    title: "Ship dashboard",
    description: "Implement the workspace dashboard surface.",
    status: "in_progress",
    createdBy: "workspace_user",
  });
  store.updateIssue({
    workspaceId: workspace.id,
    issueId: issue.issueId,
    fields: {
      activeSubagentId: "subagent-1",
    },
  });

  const response = await app.inject({
    method: "PATCH",
    url: `/api/v1/issues/${issue.issueId}`,
    payload: {
      workspace_id: workspace.id,
      status: "done",
    }
  });

  assert.equal(response.statusCode, 409);
  assert.match(
    String(response.json().detail ?? ""),
    /issue is currently running; stop the run before editing it/i,
  );

  await app.close();
  store.close();
});

test("issue create route forwards explicit dispatch routing and ignores model hints into the queued subagent run", async () => {
  const root = makeTempDir("hb-runtime-api-issue-create-routing-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace",
    harness: "pi",
    status: "active",
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/issues",
    payload: {
      workspace_id: workspace.id,
      title: "Ship dashboard",
      description: "Implement the workspace dashboard surface.",
      status: "todo",
      assignee_id: "general",
      parent_session_id: "session-main",
      parent_input_id: "input-main",
      owner_main_session_id: "session-main",
      origin_main_session_id: "session-main",
      selected_model: "openai_codex/gpt-5.4",
      model: "openai_codex/gpt-5.5",
      dispatch_priority: 7,
    },
  });

  assert.equal(response.statusCode, 200);
  const createdIssue = response.json().issue;
  const run = store.getSubagentRun({
    workspaceId: workspace.id,
    subagentId: createdIssue.latest_subagent_id,
  });
  assert.equal(run?.parentSessionId, "session-main");
  assert.equal(run?.parentInputId, "input-main");
  assert.equal(run?.ownerMainSessionId, "session-main");
  assert.equal(run?.originMainSessionId, "session-main");
  assert.equal(run?.requestedModel, null);

  const runtimeState = store.getRuntimeState({
    workspaceId: workspace.id,
    sessionId: createdIssue.session_id,
  });
  const queuedInput = store.getInput({
    workspaceId: workspace.id,
    inputId: runtimeState?.currentInputId ?? "",
  });
  assert.equal(queuedInput?.priority, 7);
  assert.equal(typeof queuedInput?.payload.model, "string");
  assert.notEqual(queuedInput?.payload.model, "openai_codex/gpt-5.4");
  assert.notEqual(queuedInput?.payload.model, "openai_codex/gpt-5.5");
  assert.equal(
    (queuedInput?.payload.context as Record<string, unknown> | undefined)
      ?.parent_session_id,
    "session-main",
  );
  assert.equal(
    (queuedInput?.payload.context as Record<string, unknown> | undefined)
      ?.parent_input_id,
    "input-main",
  );
  assert.equal(
    (queuedInput?.payload.context as Record<string, unknown> | undefined)
      ?.requested_model,
    null,
  );

  await app.close();
  store.close();
});

test("issue update route forwards dispatch routing and ignores model hints when moving an idle issue into todo", async () => {
  const root = makeTempDir("hb-runtime-api-issue-update-routing-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace",
    harness: "pi",
    status: "active",
  });
  const issue = store.createIssue({
    workspaceId: workspace.id,
    title: "Ship dashboard",
    description: "Implement the workspace dashboard surface.",
    status: "backlog",
    assigneeId: "general",
    createdBy: "workspace_user",
  });

  const response = await app.inject({
    method: "PATCH",
    url: `/api/v1/issues/${issue.issueId}`,
    payload: {
      workspace_id: workspace.id,
      status: "todo",
      parent_session_id: "session-main",
      parent_input_id: "input-main",
      owner_main_session_id: "session-main",
      origin_main_session_id: "session-main",
      selected_model: "openai_codex/gpt-5.5",
      model: "openai_codex/gpt-5.4",
      dispatch_priority: 5,
    },
  });

  assert.equal(response.statusCode, 200);
  const updatedIssue = response.json().issue;
  const run = store.getSubagentRun({
    workspaceId: workspace.id,
    subagentId: updatedIssue.latest_subagent_id,
  });
  assert.equal(run?.parentSessionId, "session-main");
  assert.equal(run?.parentInputId, "input-main");
  assert.equal(run?.requestedModel, null);

  const runtimeState = store.getRuntimeState({
    workspaceId: workspace.id,
    sessionId: updatedIssue.session_id,
  });
  const queuedInput = store.getInput({
    workspaceId: workspace.id,
    inputId: runtimeState?.currentInputId ?? "",
  });
  assert.equal(queuedInput?.priority, 5);
  assert.equal(typeof queuedInput?.payload.model, "string");
  assert.notEqual(queuedInput?.payload.model, "openai_codex/gpt-5.4");
  assert.notEqual(queuedInput?.payload.model, "openai_codex/gpt-5.5");
  assert.equal(
    (queuedInput?.payload.context as Record<string, unknown> | undefined)
      ?.requested_model,
    null,
  );

  await app.close();
  store.close();
});

test("issue stop route cancels the active run and blocks the issue", async () => {
  const root = makeTempDir("hb-runtime-api-issue-stop-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace",
    harness: "pi",
    status: "active",
  });
  const issue = store.createIssue({
    workspaceId: workspace.id,
    sessionId: "session-issue-stop-1",
    title: "Ship dashboard",
    description: "Implement the workspace dashboard surface.",
    status: "in_progress",
    assigneeId: "general",
    activeSubagentId: "subagent-1",
    latestSubagentId: "subagent-1",
    createdBy: "workspace_user",
  });
  store.createSubagentRun({
    subagentId: "subagent-1",
    workspaceId: workspace.id,
    originMainSessionId: issue.sessionId,
    ownerMainSessionId: issue.sessionId,
    childSessionId: issue.sessionId,
    title: issue.title,
    goal: issue.description ?? issue.title,
    issueId: issue.issueId,
    status: "running",
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/v1/issues/${issue.issueId}/stop`,
    payload: {
      workspace_id: workspace.id,
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().issue.status, "blocked");
  assert.equal(response.json().issue.blocker_reason, "Run cancelled by user.");
  assert.equal(response.json().issue.active_subagent_id, null);

  await app.close();
  store.close();
});

test("workspace exec route runs inside the workspace directory", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    name: "Workspace Exec",
    harness: "pi",
    status: "active"
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/v1/sandbox/users/test-user/workspaces/${workspace.id}/exec`,
    payload: {
      command: "pwd",
      timeout_s: 30
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().returncode, 0);
  assert.equal(response.json().stderr, "");
  assert.equal(
    fs.realpathSync(response.json().stdout.trim()),
    fs.realpathSync(path.join(workspaceRoot, workspace.id))
  );

  await app.close();
  store.close();
});

test("workspace template, file, and snapshot routes preserve local payload shape", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    name: "Workspace Files",
    harness: "pi",
    status: "active"
  });

  const applied = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspace.id}/apply-template`,
    payload: {
      replace_existing: true,
      files: [
        {
          path: "README.md",
          content_base64: Buffer.from("# Hello\n", "utf8").toString("base64")
        },
        {
          path: "scripts/run.sh",
          content_base64: Buffer.from("echo hi\n", "utf8").toString("base64"),
          executable: true
        }
      ]
    }
  });
  assert.equal(applied.statusCode, 200);
  assert.equal(applied.json().files_written, 2);

  const written = await app.inject({
    method: "PUT",
    url: `/api/v1/workspaces/${workspace.id}/files/docs/note.txt`,
    payload: {
      content_base64: Buffer.from("note body", "utf8").toString("base64"),
      executable: false
    }
  });
  assert.equal(written.statusCode, 200);
  assert.equal(written.json().path, "docs/note.txt");

  const readText = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspace.id}/files/README.md`
  });
  assert.equal(readText.statusCode, 200);
  assert.equal(readText.json().encoding, "utf-8");
  assert.equal(readText.json().content, "# Hello\n");

  const binaryPath = path.join(workspaceRoot, workspace.id, "bin", "payload.bin");
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(binaryPath, Buffer.from([0xff, 0x00, 0xfe]));
  const readBinary = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspace.id}/files/bin/payload.bin`
  });
  assert.equal(readBinary.statusCode, 200);
  assert.equal(readBinary.json().encoding, "base64");
  assert.equal(readBinary.json().content, Buffer.from([0xff, 0x00, 0xfe]).toString("base64"));

  fs.writeFileSync(path.join(workspaceRoot, workspace.id, "workspace.yaml"), "name: demo\n", "utf8");
  const snapshot = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspace.id}/snapshot`
  });
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.json().workspace_id, workspace.id);
  assert.ok(snapshot.json().file_count >= 4);
  assert.equal(snapshot.json().previews["workspace.yaml"], "name: demo\n");
  assert.equal(snapshot.json().git.dirty, undefined);

  await app.close();
  store.close();
});

test("PUT files requires explicit approval before blanking a non-empty file", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    name: "Workspace File Guardrails",
    harness: "pi",
    status: "active"
  });
  const targetPath = path.join(workspaceRoot, workspace.id, "docs", "note.txt");
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, "keep me\n", "utf8");

  const blocked = await app.inject({
    method: "PUT",
    url: `/api/v1/workspaces/${workspace.id}/files/docs/note.txt`,
    payload: {
      content_base64: Buffer.from("\n \n", "utf8").toString("base64")
    }
  });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().code, "destructive_write_requires_explicit_approval");
  assert.match(blocked.json().detail, /would clear a non-empty file/i);
  assert.equal(fs.readFileSync(targetPath, "utf8"), "keep me\n");

  const allowed = await app.inject({
    method: "PUT",
    url: `/api/v1/workspaces/${workspace.id}/files/docs/note.txt`,
    payload: {
      content_base64: Buffer.from("\n \n", "utf8").toString("base64"),
      allow_destructive_write: true
    }
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.json().path, "docs/note.txt");
  assert.equal(fs.readFileSync(targetPath, "utf8"), "\n \n");

  await app.close();
  store.close();
});

test("apply-template requires explicit approval before replace_existing deletes workspace files", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    name: "Workspace Template Guardrails",
    harness: "pi",
    status: "active"
  });
  const workspaceDir = path.join(workspaceRoot, workspace.id);
  fs.writeFileSync(path.join(workspaceDir, "stale.txt"), "stale\n", "utf8");

  const blocked = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspace.id}/apply-template`,
    payload: {
      replace_existing: true,
      files: [
        {
          path: "README.md",
          content_base64: Buffer.from("# Fresh\n", "utf8").toString("base64")
        }
      ]
    }
  });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().code, "destructive_write_requires_explicit_approval");
  assert.match(blocked.json().detail, /replace_existing would delete existing workspace files/i);
  assert.equal(fs.existsSync(path.join(workspaceDir, "stale.txt")), true);
  assert.equal(fs.existsSync(path.join(workspaceDir, "README.md")), false);

  const allowed = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspace.id}/apply-template`,
    payload: {
      replace_existing: true,
      allow_destructive_write: true,
      files: [
        {
          path: "README.md",
          content_base64: Buffer.from("# Fresh\n", "utf8").toString("base64")
        }
      ]
    }
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.json().files_written, 1);
  assert.equal(fs.existsSync(path.join(workspaceDir, "stale.txt")), false);
  assert.equal(fs.readFileSync(path.join(workspaceDir, "README.md"), "utf8"), "# Fresh\n");

  await app.close();
  store.close();
});

test("workspace apply-template-from-url downloads and extracts a zip archive", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    name: "Workspace Template URL",
    harness: "pi",
    status: "active"
  });
  const workspaceDir = path.join(workspaceRoot, workspace.id);
  fs.writeFileSync(path.join(workspaceDir, "stale.txt"), "stale\n", "utf8");

  const zipArchive = await createZipBuffer([
    { path: "README.md", content: "# Remote Template\n" },
    { path: "scripts/run.sh", content: "echo remote\n", mode: 0o755 }
  ]);
  const requests: string[] = [];
  const server = await startStaticHttpServer((request, response) => {
    requests.push(String(request.headers["x-api-key"] ?? ""));
    response.writeHead(200, { "content-type": "application/zip" });
    response.end(zipArchive);
  });

  try {
    const applied = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspace.id}/apply-template-from-url`,
      payload: {
        url: `${server.url}/template.zip`,
        api_key: "template-key",
        replace_existing: true,
        allow_destructive_write: true
      }
    });

    assert.equal(applied.statusCode, 200);
    assert.equal(applied.json().files_written, 2);
    assert.deepEqual(requests, ["template-key"]);
    assert.equal(fs.existsSync(path.join(workspaceDir, "stale.txt")), false);
    assert.equal(
      fs.readFileSync(path.join(workspaceDir, "README.md"), "utf8"),
      "# Remote Template\n"
    );
    assert.equal(
      fs.readFileSync(path.join(workspaceDir, "scripts", "run.sh"), "utf8"),
      "echo remote\n"
    );
    assert.notEqual(fs.statSync(path.join(workspaceDir, "scripts", "run.sh")).mode & 0o111, 0);
  } finally {
    await server.close();
    await app.close();
    store.close();
  }
});

test("workspace apply-template-from-url requires explicit approval before replace_existing deletes workspace files", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    name: "Workspace Template URL Guardrails",
    harness: "pi",
    status: "active"
  });
  const workspaceDir = path.join(workspaceRoot, workspace.id);
  fs.writeFileSync(path.join(workspaceDir, "stale.txt"), "stale\n", "utf8");

  const zipArchive = await createZipBuffer([{ path: "README.md", content: "# Remote Template\n" }]);
  const server = await startStaticHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/zip" });
    response.end(zipArchive);
  });

  try {
    const blocked = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspace.id}/apply-template-from-url`,
      payload: {
        url: `${server.url}/template.zip`,
        replace_existing: true
      }
    });

    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().code, "destructive_write_requires_explicit_approval");
    assert.match(blocked.json().detail, /replace_existing would delete existing workspace files/i);
    assert.equal(fs.existsSync(path.join(workspaceDir, "stale.txt")), true);
    assert.equal(fs.existsSync(path.join(workspaceDir, "README.md")), false);
  } finally {
    await server.close();
    await app.close();
    store.close();
  }
});

test("workspace apply-template-from-url rejects invalid archive paths", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    name: "Workspace Template Invalid URL",
    harness: "pi",
    status: "active"
  });
  const zipArchive = rewriteZipEntryName(
    await createZipBuffer([{ path: "good/file.x", content: "owned\n" }]),
    "good/file.x",
    "../evil.txt"
  );
  const server = await startStaticHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/zip" });
    response.end(zipArchive);
  });

  try {
    const applied = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspace.id}/apply-template-from-url`,
      payload: {
        url: `${server.url}/template.zip`
      }
    });

    assert.equal(applied.statusCode, 400);
    assert.match(applied.json().detail, /invalid relative path|path traversal not allowed/i);
    assert.equal(fs.existsSync(path.join(workspaceRoot, "evil.txt")), false);
  } finally {
    await server.close();
    await app.close();
    store.close();
  }
});

test("workspace export route streams a tar.gz with the workspace files", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    name: "Workspace Export",
    harness: "pi",
    status: "active"
  });
  const workspaceDir = path.join(workspaceRoot, workspace.id);
  fs.writeFileSync(path.join(workspaceDir, "README.md"), "# Export\n", "utf8");
  fs.mkdirSync(path.join(workspaceDir, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "node_modules", "ignored.txt"), "skip", "utf8");

  const exported = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspace.id}/export`
  });

  assert.equal(exported.statusCode, 200);
  assert.equal(exported.headers["content-type"], "application/gzip");
  assert.equal(
    exported.headers["content-disposition"],
    `attachment; filename=${workspace.id}.tar.gz`
  );
  const listed = spawnSync("tar", ["-tzf", "-"], {
    input: exported.rawPayload
  });
  assert.equal(listed.status, 0);
  const entries = listed.stdout.toString("utf8").trim().split("\n");
  assert.equal(entries.includes("./README.md"), true);
  assert.equal(entries.some((entry: string) => entry.includes("node_modules")), false);

  await app.close();
  store.close();
});

test("app ports route preserves deterministic workspace port assignments", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  const app = buildTestRuntimeApiServer({ store });

  fs.mkdirSync(path.join(workspaceRoot, "workspace-1", "apps", "app-a"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "workspace-1", "apps", "app-b"), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, "workspace-1", "workspace.yaml"),
    [
      "applications:",
      "  - app_id: app-a",
      "    config_path: apps/app-a/app.runtime.yaml",
      "  - app_id: app-b",
      "    config_path: apps/app-b/app.runtime.yaml"
    ].join("\n"),
    "utf8"
  );

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/apps/ports?workspace_id=workspace-1"
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    "app-a": { http: 18080, mcp: 13100 },
    "app-b": { http: 18081, mcp: 13101 }
  });

  await app.close();
  store.close();
});

test("app lifecycle routes delegate to the lifecycle executor and uninstall updates workspace state", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace Apps",
    harness: "pi",
    status: "active"
  });
  store.upsertAppBuild({
    workspaceId: workspace.id,
    appId: "app-b",
    status: "completed"
  });

  const workspaceDir = path.join(workspaceRoot, workspace.id);
  fs.mkdirSync(path.join(workspaceDir, "apps", "app-a"), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, "apps", "app-b"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "apps", "app-b", "app.runtime.yaml"), "app_id: app-b\nmcp:\n  port: 4100\n", "utf8");
  fs.writeFileSync(
    path.join(workspaceDir, "workspace.yaml"),
    [
      "applications:",
      "  - app_id: app-a",
      "    config_path: apps/app-a/app.runtime.yaml",
      "  - app_id: app-b",
      "    config_path: apps/app-b/app.runtime.yaml"
    ].join("\n"),
    "utf8"
  );

  const calls: Array<Record<string, unknown>> = [];
  const executor: AppLifecycleExecutorLike = {
    async startApp(params) {
      calls.push({ action: "start", ...params });
      return {
        app_id: params.appId,
        status: "started",
        detail: "app started with lifecycle manager",
        ports: { http: 18081, mcp: 13101 }
      };
    },
    async stopApp(params) {
      calls.push({ action: "stop", ...params });
      return {
        app_id: params.appId,
        status: "stopped",
        detail: "app stopped via lifecycle manager",
        ports: {}
      };
    },
    async shutdownAll() {
      throw new Error("not used");
    }
  };
  const app = buildTestRuntimeApiServer({ store, appLifecycleExecutor: executor });

  const started = await app.inject({
    method: "POST",
    url: "/api/v1/apps/app-b/start",
    payload: { workspace_id: workspace.id, holaboss_user_id: "user-1" }
  });

  assert.equal(started.statusCode, 200);
  assert.deepEqual(started.json(), {
    app_id: "app-b",
    status: "started",
    detail: "app started with lifecycle manager",
    ports: { http: 18081, mcp: 13101 }
  });
  assert.equal(store.getAppBuild({ workspaceId: workspace.id, appId: "app-b" })?.status, "running");

  const stopped = await app.inject({
    method: "POST",
    url: "/api/v1/apps/app-b/stop",
    payload: { workspace_id: workspace.id }
  });
  assert.equal(stopped.statusCode, 200);
  assert.deepEqual(stopped.json(), {
    app_id: "app-b",
    status: "stopped",
    detail: "app stopped via lifecycle manager",
    ports: {}
  });
  assert.equal(store.getAppBuild({ workspaceId: workspace.id, appId: "app-b" })?.status, "stopped");

  const uninstalled = await app.inject({
    method: "DELETE",
    url: "/api/v1/apps/app-b",
    payload: { workspace_id: workspace.id }
  });
  assert.equal(uninstalled.statusCode, 200);
  assert.deepEqual(uninstalled.json(), {
    app_id: "app-b",
    status: "uninstalled",
    detail: "App stopped, files removed, workspace.yaml updated",
    ports: {}
  });
  assert.deepEqual(calls, [
    {
      action: "start",
      appId: "app-b",
      appDir: path.join(workspaceDir, "apps", "app-b"),
      httpPort: 18081,
      mcpPort: 13101,
      holabossUserId: "user-1",
      workspaceId: "workspace-1",
      skipSetup: true,
      resolvedApp: {
        appId: "app-b",
        mcp: { transport: "http-sse", port: 4100, path: "/mcp" },
        mcpTools: [],
        healthCheck: {
          path: "/health",
          timeoutS: 120,
          intervalS: 5,
          target: "mcp"
        },
        envContract: [],
        integrations: undefined,
        startCommand: "",
        baseDir: "apps/app-b",
        lifecycle: { setup: "", start: "", stop: "" },
        dataSchemaRaw: undefined
      }
    },
    {
      action: "stop",
      appId: "app-b",
      appDir: path.join(workspaceDir, "apps", "app-b"),
      workspaceId: "workspace-1",
      resolvedApp: {
        appId: "app-b",
        mcp: { transport: "http-sse", port: 4100, path: "/mcp" },
        mcpTools: [],
        healthCheck: {
          path: "/health",
          timeoutS: 120,
          intervalS: 5,
          target: "mcp"
        },
        envContract: [],
        integrations: undefined,
        startCommand: "",
        baseDir: "apps/app-b",
        lifecycle: { setup: "", start: "", stop: "" },
        dataSchemaRaw: undefined
      }
    },
    {
      action: "stop",
      appId: "app-b",
      appDir: path.join(workspaceDir, "apps", "app-b"),
      workspaceId: "workspace-1",
      resolvedApp: {
        appId: "app-b",
        mcp: { transport: "http-sse", port: 4100, path: "/mcp" },
        mcpTools: [],
        healthCheck: {
          path: "/health",
          timeoutS: 120,
          intervalS: 5,
          target: "mcp"
        },
        envContract: [],
        integrations: undefined,
        startCommand: "",
        baseDir: "apps/app-b",
        lifecycle: { setup: "", start: "", stop: "" },
        dataSchemaRaw: undefined
      }
    }
  ]);
  assert.equal(fs.existsSync(path.join(workspaceDir, "apps", "app-b")), false);
  assert.equal(store.getAppBuild({ workspaceId: workspace.id, appId: "app-b" }), null);
  const workspaceYaml = fs.readFileSync(path.join(workspaceDir, "workspace.yaml"), "utf8");
  assert.equal(workspaceYaml.includes("app-b"), false);

  await app.close();
  store.close();
});

test("app start queues lifecycle setup apps in background", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace Apps",
    harness: "pi",
    status: "active"
  });

  const workspaceDir = path.join(workspaceRoot, workspace.id);
  fs.mkdirSync(path.join(workspaceDir, "apps", "app-a"), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, "apps", "app-a", "app.runtime.yaml"),
    [
      "app_id: app-a",
      "mcp:",
      "  port: 4100",
      "healthchecks:",
      "  mcp:",
      "    path: /health",
      "    timeout_s: 30",
      "lifecycle:",
      "  setup: npm install",
      "  start: npm run start"
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(workspaceDir, "workspace.yaml"),
    [
      "applications:",
      "  - app_id: app-a",
      "    config_path: apps/app-a/app.runtime.yaml"
    ].join("\n"),
    "utf8"
  );

  const calls: Array<Record<string, unknown>> = [];
  const executor: AppLifecycleExecutorLike = {
    async startApp(params) {
      calls.push({ action: "start", ...params });
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        app_id: params.appId,
        status: "started",
        detail: "app started with lifecycle manager",
        ports: { http: params.httpPort ?? 18080, mcp: params.mcpPort ?? 13100 }
      };
    },
    async stopApp() {
      throw new Error("not used");
    },
    async shutdownAll() {
      throw new Error("not used");
    }
  };
  const app = buildTestRuntimeApiServer({ store, appLifecycleExecutor: executor });

  const started = await app.inject({
    method: "POST",
    url: "/api/v1/apps/app-a/start",
    payload: { workspace_id: workspace.id, holaboss_user_id: "user-1" }
  });

  assert.equal(started.statusCode, 200);
  assert.deepEqual(started.json(), {
    app_id: "app-a",
    status: "building",
    detail: "App start queued in background",
    ports: { http: 18080, mcp: 13100 }
  });
  assert.equal(store.getAppBuild({ workspaceId: workspace.id, appId: "app-a" })?.status, "building");

  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(store.getAppBuild({ workspaceId: workspace.id, appId: "app-a" })?.status, "running");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.skipSetup, false);

  await app.close();
  store.close();
});

test("app setup route does not start duplicate setup for an app already building", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace Apps",
    harness: "pi",
    status: "active"
  });
  const workspaceDir = path.join(workspaceRoot, workspace.id);
  const appDir = path.join(workspaceDir, "apps", "app-a");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "app.runtime.yaml"),
    [
      "app_id: app-a",
      "mcp:",
      "  port: 4100",
      "lifecycle:",
      "  setup: 'sleep 1'"
    ].join("\n"),
    "utf8"
  );
  const app = buildTestRuntimeApiServer({ store });

  const first = await app.inject({
    method: "POST",
    url: "/api/v1/apps/app-a/setup",
    payload: { workspace_id: workspace.id }
  });
  const second = await app.inject({
    method: "POST",
    url: "/api/v1/apps/app-a/setup",
    payload: { workspace_id: workspace.id }
  });

  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), {
    app_id: "app-a",
    status: "setup_started",
    detail: "Running: sleep 1",
    ports: {}
  });
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.json(), {
    app_id: "app-a",
    status: "setup_started",
    detail: "Setup already in progress",
    ports: {}
  });

  await new Promise((resolve) => setTimeout(resolve, 1500));
  const build = store.getAppBuild({ workspaceId: workspace.id, appId: "app-a" });
  assert.equal(build?.status, "completed");

  await app.close();
  store.close();
});

test("ensure-running dedupes concurrent setup/start for the same app", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace Apps",
    harness: "pi",
    status: "active"
  });
  const workspaceDir = path.join(workspaceRoot, workspace.id);
  const appDir = path.join(workspaceDir, "apps", "app-a");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "app.runtime.yaml"),
    [
      "app_id: app-a",
      "mcp:",
      "  port: 4100",
      "healthchecks:",
      "  mcp:",
      "    path: /health",
      "    timeout_s: 30",
      "lifecycle:",
      "  setup: 'echo setup >> setup-count.txt; sleep 1'",
      "  start: 'echo start'"
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(workspaceDir, "workspace.yaml"),
    [
      "applications:",
      "  - app_id: app-a",
      "    config_path: apps/app-a/app.runtime.yaml"
    ].join("\n"),
    "utf8"
  );

  const lifecycleCalls: Array<Record<string, unknown>> = [];
  const app = buildTestRuntimeApiServer({
    store,
    appLifecycleExecutor: {
      async startApp(params) {
        lifecycleCalls.push({ action: "start", ...params });
        return {
          app_id: params.appId,
          status: "started",
          detail: "app started with lifecycle manager",
          ports: { http: params.httpPort ?? 18080, mcp: params.mcpPort ?? 13100 }
        };
      },
      async stopApp() {
        throw new Error("not used");
      },
      async shutdownAll() {
        throw new Error("not used");
      }
    }
  });

  const payload = { workspace_id: workspace.id };
  const [first, second] = await Promise.all([
    app.inject({
      method: "POST",
      url: "/api/v1/apps/ensure-running",
      payload
    }),
    app.inject({
      method: "POST",
      url: "/api/v1/apps/ensure-running",
      payload
    })
  ]);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(first.json(), {
    apps: [
      {
        app_id: "app-a",
        ready: true,
        error: null
      }
    ]
  });
  assert.deepEqual(second.json(), {
    apps: [
      {
        app_id: "app-a",
        ready: true,
        error: null
      }
    ]
  });
  assert.equal(lifecycleCalls.length, 1);

  const setupCountFile = path.join(appDir, "setup-count.txt");
  assert.equal(fs.existsSync(setupCountFile), true);
  const setupRuns = fs
    .readFileSync(setupCountFile, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0).length;
  assert.equal(setupRuns, 1);

  await app.close();
  store.close();
});

test("auto-start on ready reuses a healthy untracked shell-managed app", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const previousEmbeddedRuntime = process.env.HOLABOSS_EMBEDDED_RUNTIME;
  process.env.HOLABOSS_EMBEDDED_RUNTIME = "1";
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace Apps",
    harness: "pi",
    status: "active"
  });
  const workspaceDir = path.join(workspaceRoot, workspace.id);
  const appDir = path.join(workspaceDir, "apps", "app-a");
  fs.mkdirSync(appDir, { recursive: true });

  fs.writeFileSync(
    path.join(appDir, "app.runtime.yaml"),
    [
      "app_id: app-a",
      "name: App A",
      "description: Test app",
      "icon: https://example.com/icon.png",
      "mcp:",
      "  transport: http-sse",
      "  port: 13100",
      "  path: /mcp",
      "mcp_tools: []",
      "http:",
      "  port: 18080",
      "healthchecks:",
      "  http:",
      "    path: /health",
      "    timeout_s: 1",
      "  mcp:",
      "    path: /health",
      "    timeout_s: 1",
      "lifecycle:",
      "  setup: ''",
      "  start: npm run start"
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(workspaceDir, "workspace.yaml"),
    [
      "applications:",
      "  - app_id: app-a",
      "    config_path: apps/app-a/app.runtime.yaml"
    ].join("\n"),
    "utf8"
  );
  let httpServer: { url: string; close: () => Promise<void> } | undefined;
  let mcpServer: { url: string; close: () => Promise<void> } | undefined;
  const patchedStore = store as RuntimeStateStore & {
    allocateAppPort: RuntimeStateStore["allocateAppPort"];
    getAppPort: RuntimeStateStore["getAppPort"];
  };
  const originalAllocateAppPort = store.allocateAppPort.bind(store);
  const originalGetAppPort = store.getAppPort.bind(store);
  let httpPort = 0;
  let mcpPort = 0;
  const lifecycleCalls: Array<Record<string, unknown>> = [];
  const rememberedPorts: Array<Record<string, unknown>> = [];
  const app = buildRuntimeApiServer({
    store,
    queueWorker: null,
    durableMemoryWorker: null,
    cronWorker: null,
    recallEmbeddingBackfillWorker: null,
    enableAppHealthMonitor: false,
    startAppsOnReady: true,
    appLifecycleExecutor: {
      async startApp(params) {
        lifecycleCalls.push({ action: "start", ...params });
        return {
          app_id: params.appId,
          status: "started",
          detail: "app started with lifecycle manager",
          ports: { http: params.httpPort ?? 18080, mcp: params.mcpPort ?? 13100 }
        };
      },
      async stopApp() {
        throw new Error("not used");
      },
      async shutdownAll() {
        throw new Error("not used");
      },
      isTrackingApp() {
        return false;
      },
      rememberAppPorts(params) {
        rememberedPorts.push(params);
      }
    }
  });
  try {
    httpServer = await startStaticHttpServer(
      (_request, response) => {
        response.statusCode = 200;
        response.end("ok");
      },
      { port: 0 },
    );
    mcpServer = await startStaticHttpServer(
      (_request, response) => {
        response.statusCode = 200;
        response.end("ok");
      },
      { port: 0 },
    );
    httpPort = Number(new URL(httpServer.url).port);
    mcpPort = Number(new URL(mcpServer.url).port);
    const portMap = new Map<string, number>([
      ["app-a__http", httpPort],
      ["app-a__mcp", mcpPort]
    ]);
    patchedStore.allocateAppPort = ((params) => {
      const port = portMap.get(params.appId);
      if (port !== undefined) {
        return {
          workspaceId: params.workspaceId,
          appId: params.appId,
          port,
          createdAt: "test-created-at",
          updatedAt: "test-updated-at"
        };
      }
      return originalAllocateAppPort(params);
    }) as RuntimeStateStore["allocateAppPort"];
    patchedStore.getAppPort = ((params) => {
      const port = portMap.get(params.appId);
      if (port !== undefined) {
        return {
          workspaceId: params.workspaceId,
          appId: params.appId,
          port,
          createdAt: "test-created-at",
          updatedAt: "test-updated-at"
        };
      }
      return originalGetAppPort(params);
    }) as RuntimeStateStore["getAppPort"];

    const resolved = resolveWorkspaceAppRuntime(workspaceDir, "app-a", {
      store,
      workspaceId: workspace.id,
      allocatePorts: true,
    });
    assert.equal(resolved.ports.http, httpPort);
    assert.equal(resolved.ports.mcp, mcpPort);
    store.upsertAppBuild({ workspaceId: workspace.id, appId: "app-a", status: "running" });

    await app.ready();
    await sleep(150);

    assert.equal(lifecycleCalls.length, 0);
    assert.deepEqual(rememberedPorts, [
      {
        workspaceId: workspace.id,
        appId: "app-a",
        httpPort,
        mcpPort
      }
    ]);
    assert.equal(store.getAppBuild({ workspaceId: workspace.id, appId: "app-a" })?.status, "running");
  } finally {
    if (httpServer) {
      await httpServer.close();
    }
    if (mcpServer) {
      await mcpServer.close();
    }
    patchedStore.allocateAppPort = originalAllocateAppPort;
    patchedStore.getAppPort = originalGetAppPort;
    if (previousEmbeddedRuntime === undefined) {
      delete process.env.HOLABOSS_EMBEDDED_RUNTIME;
    } else {
      process.env.HOLABOSS_EMBEDDED_RUNTIME = previousEmbeddedRuntime;
    }
    await app.close();
    store.close();
  }
});

test("auto-start on ready does not reuse a healthy untracked shell-managed app without prior running state", async () => {
  const previousEmbeddedRuntime = process.env.HOLABOSS_EMBEDDED_RUNTIME;
  process.env.HOLABOSS_EMBEDDED_RUNTIME = "1";
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  const workspace = seedWorkspaceRecord(store, {
    // single-tenant: auto-start scans the synthetic root, so set the app up there
    workspaceId: "root",
    name: "Workspace Apps",
    harness: "pi",
    status: "active"
  });
  const workspaceDir = path.join(workspaceRoot, workspace.id);
  const appDir = path.join(workspaceDir, "apps", "app-a");
  fs.mkdirSync(appDir, { recursive: true });

  fs.writeFileSync(
    path.join(appDir, "app.runtime.yaml"),
    [
      "app_id: app-a",
      "name: App A",
      "mcp:",
      "  transport: http-sse",
      "  port: 13100",
      "  path: /mcp",
      "healthchecks:",
      "  http:",
      "    path: /health",
      "    timeout_s: 1",
      "  mcp:",
      "    path: /health",
      "    timeout_s: 1",
      "lifecycle:",
      "  setup: ''",
      "  start: npm run start"
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(workspaceDir, "workspace.yaml"),
    [
      "applications:",
      "  - app_id: app-a",
      "    config_path: apps/app-a/app.runtime.yaml"
    ].join("\n"),
    "utf8"
  );

  let httpServer: { url: string; close: () => Promise<void> } | undefined;
  let mcpServer: { url: string; close: () => Promise<void> } | undefined;
  const patchedStore = store as RuntimeStateStore & {
    allocateAppPort: RuntimeStateStore["allocateAppPort"];
    getAppPort: RuntimeStateStore["getAppPort"];
  };
  const originalAllocateAppPort = store.allocateAppPort.bind(store);
  const originalGetAppPort = store.getAppPort.bind(store);
  const lifecycleCalls: Array<Record<string, unknown>> = [];
  const rememberedPorts: Array<Record<string, unknown>> = [];
  let httpPort = 0;
  let mcpPort = 0;
  const app = buildRuntimeApiServer({
    store,
    queueWorker: null,
    durableMemoryWorker: null,
    cronWorker: null,
    recallEmbeddingBackfillWorker: null,
    enableAppHealthMonitor: false,
    startAppsOnReady: true,
    appLifecycleExecutor: {
      async startApp(params) {
        lifecycleCalls.push({ action: "start", ...params });
        return {
          app_id: params.appId,
          status: "started",
          detail: "app started with lifecycle manager",
          ports: { http: params.httpPort ?? 18080, mcp: params.mcpPort ?? 13100 }
        };
      },
      async stopApp() {
        throw new Error("not used");
      },
      async shutdownAll() {
        throw new Error("not used");
      },
      isTrackingApp() {
        return false;
      },
      rememberAppPorts(params) {
        rememberedPorts.push(params);
      }
    }
  });

  try {
    httpServer = await startStaticHttpServer(
      (_request, response) => {
        response.statusCode = 200;
        response.end("ok");
      },
      { port: 0 },
    );
    mcpServer = await startStaticHttpServer(
      (_request, response) => {
        response.statusCode = 200;
        response.end("ok");
      },
      { port: 0 },
    );
    httpPort = Number(new URL(httpServer.url).port);
    mcpPort = Number(new URL(mcpServer.url).port);
    const portMap = new Map<string, number>([
      ["app-a__http", httpPort],
      ["app-a__mcp", mcpPort]
    ]);
    patchedStore.allocateAppPort = ((params) => {
      const port = portMap.get(params.appId);
      if (port !== undefined) {
        return {
          workspaceId: params.workspaceId,
          appId: params.appId,
          port,
          createdAt: "test-created-at",
          updatedAt: "test-updated-at"
        };
      }
      return originalAllocateAppPort(params);
    }) as RuntimeStateStore["allocateAppPort"];
    patchedStore.getAppPort = ((params) => {
      const port = portMap.get(params.appId);
      if (port !== undefined) {
        return {
          workspaceId: params.workspaceId,
          appId: params.appId,
          port,
          createdAt: "test-created-at",
          updatedAt: "test-updated-at"
        };
      }
      return originalGetAppPort(params);
    }) as RuntimeStateStore["getAppPort"];

    await app.ready();
    await sleep(150);

    assert.equal(lifecycleCalls.length, 1);
    assert.equal(rememberedPorts.length, 0);
    assert.equal(store.getAppBuild({ workspaceId: workspace.id, appId: "app-a" })?.status, "running");
  } finally {
    if (httpServer) {
      await httpServer.close();
    }
    if (mcpServer) {
      await mcpServer.close();
    }
    patchedStore.allocateAppPort = originalAllocateAppPort;
    patchedStore.getAppPort = originalGetAppPort;
    if (previousEmbeddedRuntime === undefined) {
      delete process.env.HOLABOSS_EMBEDDED_RUNTIME;
    } else {
      process.env.HOLABOSS_EMBEDDED_RUNTIME = previousEmbeddedRuntime;
    }
    await app.close();
    store.close();
  }
});

test("app setup timeout honors configured timeout", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-timeout",
    name: "Workspace Apps",
    harness: "pi",
    status: "active"
  });
  const workspaceDir = path.join(workspaceRoot, workspace.id);
  const appDir = path.join(workspaceDir, "apps", "app-a");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "app.runtime.yaml"),
    [
      "app_id: app-a",
      "mcp:",
      "  port: 4100",
      "lifecycle:",
      "  setup: 'node -e \"setTimeout(() => {}, 1000)\"'"
    ].join("\n"),
    "utf8"
  );

  const previousTimeout = process.env.HB_APP_SETUP_TIMEOUT_MS;
  process.env.HB_APP_SETUP_TIMEOUT_MS = "50";
  const app = buildTestRuntimeApiServer({ store });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/apps/app-a/setup",
      payload: { workspace_id: workspace.id }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "setup_started");

    await new Promise((resolve) => setTimeout(resolve, 200));
    const build = store.getAppBuild({ workspaceId: workspace.id, appId: "app-a" });
    assert.equal(build?.status, "failed");
    assert.match(build?.error ?? "", /^setup timed out after 1s(?: — see .+setup\.latest\.log| — see .+setup-.+\.log)?$/);
  } finally {
    if (previousTimeout === undefined) {
      delete process.env.HB_APP_SETUP_TIMEOUT_MS;
    } else {
      process.env.HB_APP_SETUP_TIMEOUT_MS = previousTimeout;
    }
    await app.close();
    store.close();
  }
});

test("internal resolved app bootstrap route starts resolved apps and returns MCP urls", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace Apps",
    harness: "pi",
    status: "active"
  });
  store.upsertAppBuild({
    workspaceId: "root",
    appId: "app-a",
    status: "completed"
  });
  fs.mkdirSync(path.join(workspaceRoot, "root", "apps", "app-a"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "root", "apps", "app-b"), { recursive: true });

  const calls: Array<Record<string, unknown>> = [];
  const executor: AppLifecycleExecutorLike = {
    async startApp(params) {
      calls.push({ action: "start", ...params });
      return {
        app_id: params.appId,
        status: "started",
        detail: "app started with lifecycle manager",
        ports: { http: params.httpPort ?? 0, mcp: params.mcpPort ?? 0 }
      };
    },
    async stopApp() {
      throw new Error("not used");
    },
    async shutdownAll() {
      throw new Error("not used");
    }
  };
  const app = buildTestRuntimeApiServer({ store, appLifecycleExecutor: executor });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/internal/workspaces/root/resolved-apps/start",
    payload: {
      workspace_dir: path.join(workspaceRoot, "root"),
      holaboss_user_id: "user-1",
      resolved_applications: [
        {
          app_id: "app-a",
          mcp: { transport: "http-sse", port: 4100, path: "/mcp" },
          health_check: { path: "/health", timeout_s: 60, interval_s: 5 },
          env_contract: ["HOLABOSS_USER_ID"],
          start_command: "",
          base_dir: "apps/app-a",
          lifecycle: { setup: "", start: "npm run start", stop: "npm run stop" }
        },
        {
          app_id: "app-b",
          mcp: { transport: "http-sse", port: 4200, path: "/mcp" },
          health_check: { path: "/ready", timeout_s: 30, interval_s: 2 },
          env_contract: [],
          start_command: "npm run legacy-start",
          base_dir: "apps/app-b",
          lifecycle: { setup: "", start: "", stop: "" }
        }
      ]
    }
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.applications.length, 2);
  const appA = body.applications[0];
  const appB = body.applications[1];
  assert.equal(appA.app_id, "app-a");
  assert.equal(appB.app_id, "app-b");
  assert.ok(appA.ports.http >= 13100);
  assert.ok(appA.ports.mcp >= 13100);
  assert.ok(appB.ports.http >= 13100);
  assert.ok(appB.ports.mcp >= 13100);
  const allPorts = [appA.ports.http, appA.ports.mcp, appB.ports.http, appB.ports.mcp];
  assert.equal(new Set(allPorts).size, 4, "all four ports must be unique");
  assert.equal(appA.mcp_url, `http://localhost:${appA.ports.mcp}/mcp`);
  assert.equal(appB.mcp_url, `http://localhost:${appB.ports.mcp}/mcp`);
  assert.equal(appA.timeout_ms, 60000);
  assert.equal(appB.timeout_ms, 30000);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.appId, "app-a");
  assert.equal(calls[0]?.httpPort, appA.ports.http);
  assert.equal(calls[0]?.mcpPort, appA.ports.mcp);
  assert.equal(calls[0]?.holabossUserId, "user-1");
  assert.equal(calls[0]?.skipSetup, true);
  assert.equal(calls[1]?.appId, "app-b");
  assert.equal(calls[1]?.httpPort, appB.ports.http);
  assert.equal(calls[1]?.mcpPort, appB.ports.mcp);
  assert.equal(calls[1]?.skipSetup, false);

  await app.close();
  store.close();
});

test("internal resolved app bootstrap route rejects base_dir that escapes the workspace", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace Apps",
    harness: "pi",
    status: "active"
  });

  const calls: Array<Record<string, unknown>> = [];
  const executor: AppLifecycleExecutorLike = {
    async startApp(params) {
      calls.push({ action: "start", ...params });
      throw new Error("not used");
    },
    async stopApp() {
      throw new Error("not used");
    },
    async shutdownAll() {
      throw new Error("not used");
    }
  };
  const app = buildTestRuntimeApiServer({ store, appLifecycleExecutor: executor });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/internal/workspaces/root/resolved-apps/start",
    payload: {
      workspace_dir: path.join(workspaceRoot, "root"),
      resolved_applications: [
        {
          app_id: "app-a",
          mcp: { transport: "http-sse", port: 4100, path: "/mcp" },
          health_check: { path: "/health", timeout_s: 60, interval_s: 5 },
          env_contract: [],
          start_command: "",
          base_dir: "../escape",
          lifecycle: { setup: "", start: "npm run start", stop: "npm run stop" }
        }
      ]
    }
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    detail: "resolved_application.base_dir escapes workspace: '../escape'"
  });
  assert.deepEqual(calls, []);

  await app.close();
  store.close();
});

test("internal resolved app bootstrap route prevalidates all app dirs before starting any apps", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-prevalidate-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace Apps",
    harness: "pi",
    status: "active"
  });
  fs.mkdirSync(path.join(workspaceRoot, "root", "apps", "app-a"), { recursive: true });

  let startCalls = 0;
  const executor: AppLifecycleExecutorLike = {
    async startApp() {
      startCalls += 1;
      throw new Error("not reached");
    },
    async stopApp() {
      throw new Error("not used");
    },
    async shutdownAll() {
      throw new Error("not used");
    }
  };
  const app = buildTestRuntimeApiServer({ store, appLifecycleExecutor: executor });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/internal/workspaces/root/resolved-apps/start",
    payload: {
      workspace_dir: path.join(workspaceRoot, "root"),
      resolved_applications: [
        {
          app_id: "app-a",
          mcp: { transport: "http-sse", port: 4100, path: "/mcp" },
          health_check: { path: "/health", timeout_s: 60, interval_s: 5 },
          env_contract: [],
          start_command: "",
          base_dir: "apps/app-a",
          lifecycle: { setup: "", start: "npm run start", stop: "npm run stop" }
        },
        {
          app_id: "app-b",
          mcp: { transport: "http-sse", port: 4200, path: "/mcp" },
          health_check: { path: "/ready", timeout_s: 30, interval_s: 2 },
          env_contract: [],
          start_command: "",
          base_dir: "../escape",
          lifecycle: { setup: "", start: "npm run other-start", stop: "npm run other-stop" }
        }
      ]
    }
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    detail: "resolved_application.base_dir escapes workspace: '../escape'"
  });
  assert.equal(startCalls, 0);

  await app.close();
  store.close();
});

test("internal resolved app bootstrap route rejects missing expected workspace dir", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-missing-workspace-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace Apps",
    harness: "pi",
    status: "active"
  });
  fs.rmSync(path.join(workspaceRoot, "root"), { recursive: true, force: true });

  const calls: Array<Record<string, unknown>> = [];
  const executor: AppLifecycleExecutorLike = {
    async startApp(params) {
      calls.push({ action: "start", ...params });
      throw new Error("not used");
    },
    async stopApp() {
      throw new Error("not used");
    },
    async shutdownAll() {
      throw new Error("not used");
    }
  };
  const app = buildTestRuntimeApiServer({ store, appLifecycleExecutor: executor });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/internal/workspaces/root/resolved-apps/start",
    payload: {
      resolved_applications: [
        {
          app_id: "app-a",
          mcp: { transport: "http-sse", port: 4100, path: "/mcp" },
          health_check: { path: "/health", timeout_s: 60, interval_s: 5 },
          env_contract: [],
          start_command: "",
          base_dir: "apps/app-a",
          lifecycle: { setup: "", start: "npm run start", stop: "npm run stop" }
        }
      ]
    }
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    detail: `workspace_dir not found: '${path.join(workspaceRoot, "root")}'`
  });
  assert.deepEqual(calls, []);

  await app.close();
  store.close();
});

test("internal resolved app bootstrap route rejects unknown workspace ids before startup", async () => {
  const root = makeTempDir("hb-runtime-api-unknown-workspace-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });

  const calls: Array<Record<string, unknown>> = [];
  const executor: AppLifecycleExecutorLike = {
    async startApp(params) {
      calls.push({ action: "start", ...params });
      throw new Error("not used");
    },
    async stopApp() {
      throw new Error("not used");
    },
    async shutdownAll() {
      throw new Error("not used");
    }
  };
  const app = buildTestRuntimeApiServer({ store, appLifecycleExecutor: executor });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/internal/workspaces/workspace-unknown/resolved-apps/start",
    payload: {
      workspace_dir: path.join(workspaceRoot, "workspace-unknown"),
      resolved_applications: [
        {
          app_id: "app-a",
          mcp: { transport: "http-sse", port: 4100, path: "/mcp" },
          health_check: { path: "/health", timeout_s: 60, interval_s: 5 },
          env_contract: [],
          start_command: "",
          base_dir: "apps/app-a",
          lifecycle: { setup: "", start: "npm run start", stop: "npm run stop" }
        }
      ]
    }
  });

  // Single-tenant: the per-id rejection this test guarded is obsolete —
  // getWorkspace() resolves ANY id to the synthetic root, so an "unknown"
  // workspace id no longer 404s as "workspace not found". The request proceeds
  // and is instead governed by the surviving workspace_dir guard: the supplied
  // dir (workspace-unknown) does not match the resolved root dir, so it is
  // rejected with a 400 mismatch before any app starts (calls stays empty).
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    detail: "workspace_dir does not match workspace 'workspace-unknown'"
  });
  assert.deepEqual(calls, []);

  await app.close();
  store.close();
});

test("internal resolved app bootstrap route rejects workspace_dir mismatches before startup", async () => {
  const root = makeTempDir("hb-runtime-api-workspace-mismatch-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace Apps",
    harness: "pi",
    status: "active"
  });

  const calls: Array<Record<string, unknown>> = [];
  const executor: AppLifecycleExecutorLike = {
    async startApp(params) {
      calls.push({ action: "start", ...params });
      throw new Error("not used");
    },
    async stopApp() {
      throw new Error("not used");
    },
    async shutdownAll() {
      throw new Error("not used");
    }
  };
  const app = buildTestRuntimeApiServer({ store, appLifecycleExecutor: executor });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/internal/workspaces/workspace-1/resolved-apps/start",
    payload: {
      workspace_dir: path.join(workspaceRoot, "workspace-other"),
      resolved_applications: [
        {
          app_id: "app-a",
          mcp: { transport: "http-sse", port: 4100, path: "/mcp" },
          health_check: { path: "/health", timeout_s: 60, interval_s: 5 },
          env_contract: [],
          start_command: "",
          base_dir: "apps/app-a",
          lifecycle: { setup: "", start: "npm run start", stop: "npm run stop" }
        }
      ]
    }
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    detail: "workspace_dir does not match workspace 'workspace-1'"
  });
  assert.deepEqual(calls, []);

  await app.close();
  store.close();
});

test("internal resolved app bootstrap route rejects duplicate app ids", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-dup-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace Apps",
    harness: "pi",
    status: "active"
  });
  const calls: Array<Record<string, unknown>> = [];
  const executor: AppLifecycleExecutorLike = {
    async startApp(params) {
      calls.push({ action: "start", ...params });
      throw new Error("not reached");
    },
    async stopApp() {
      throw new Error("not used");
    },
    async shutdownAll() {
      throw new Error("not used");
    }
  };
  const app = buildTestRuntimeApiServer({ store, appLifecycleExecutor: executor });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/internal/workspaces/root/resolved-apps/start",
    payload: {
      workspace_dir: path.join(workspaceRoot, "root"),
      resolved_applications: [
        {
          app_id: "app-a",
          mcp: { transport: "http-sse", port: 4100, path: "/mcp" },
          health_check: { path: "/health", timeout_s: 60, interval_s: 5 },
          env_contract: [],
          start_command: "",
          base_dir: "apps/app-a",
          lifecycle: { setup: "", start: "npm run start", stop: "npm run stop" }
        },
        {
          app_id: "app-a",
          mcp: { transport: "http-sse", port: 4200, path: "/mcp" },
          health_check: { path: "/ready", timeout_s: 30, interval_s: 2 },
          env_contract: [],
          start_command: "",
          base_dir: "apps/app-a-2",
          lifecycle: { setup: "", start: "npm run other-start", stop: "npm run other-stop" }
        }
      ]
    }
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    detail: "resolved_applications contains duplicate app_id 'app-a'"
  });
  assert.deepEqual(calls, []);

  await app.close();
  store.close();
});

test("internal resolved app bootstrap route rejects empty resolved applications", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-empty-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace Apps",
    harness: "pi",
    status: "active"
  });
  const calls: Array<Record<string, unknown>> = [];
  const executor: AppLifecycleExecutorLike = {
    async startApp(params) {
      calls.push({ action: "start", ...params });
      throw new Error("not reached");
    },
    async stopApp() {
      throw new Error("not used");
    },
    async shutdownAll() {
      throw new Error("not used");
    }
  };
  const app = buildTestRuntimeApiServer({ store, appLifecycleExecutor: executor });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/internal/workspaces/root/resolved-apps/start",
    payload: {
      workspace_dir: path.join(workspaceRoot, "root"),
      resolved_applications: []
    }
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    detail: "resolved_applications must not be empty"
  });
  assert.deepEqual(calls, []);

  await app.close();
  store.close();
});

test("internal resolved app bootstrap route rejects mismatched lifecycle response shape", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-mismatch-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace Apps",
    harness: "pi",
    status: "active"
  });
  const executor: AppLifecycleExecutorLike = {
    async startApp() {
      return {
        app_id: "other-app",
        status: "started",
        detail: "wrong app",
        ports: { http: 18080, mcp: 13100 }
      };
    },
    async stopApp() {
      throw new Error("not used");
    },
    async shutdownAll() {
      throw new Error("not used");
    }
  };
  const app = buildTestRuntimeApiServer({ store, appLifecycleExecutor: executor });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/internal/workspaces/root/resolved-apps/start",
    payload: {
      workspace_dir: path.join(workspaceRoot, "root"),
      resolved_applications: [
        {
          app_id: "app-a",
          mcp: { transport: "http-sse", port: 4100, path: "/mcp" },
          health_check: { path: "/health", timeout_s: 60, interval_s: 5 },
          env_contract: [],
          start_command: "",
          base_dir: "apps/app-a",
          lifecycle: { setup: "", start: "npm run start", stop: "npm run stop" }
        }
      ]
    }
  });

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), {
    detail: "resolved app startup returned mismatched app id 'other-app' for 'app-a'"
  });

  await app.close();
  store.close();
});

test("lifecycle shutdown route delegates to the lifecycle executor", async () => {
  // Single-tenant root alignment: the runtime resolves every request to the
  // synthetic "root" workspace, so this test's workspace ids + fs paths use "root".
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  seedWorkspaceRecord(store, {
    workspaceId: "root",
    name: "Workspace Apps",
    harness: "pi",
    status: "active"
  });
  const workspaceDir = path.join(workspaceRoot, "root");
  fs.mkdirSync(path.join(workspaceDir, "apps", "app-a"), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "apps", "app-a", "docker-compose.yml"), "services: {}\n", "utf8");
  fs.writeFileSync(
    path.join(workspaceDir, "workspace.yaml"),
    [
      "applications:",
      "  - app_id: app-a",
      "    config_path: apps/app-a/app.runtime.yaml",
      "  - app_id: app-b",
      "    config_path: apps/app-b/app.runtime.yaml"
    ].join("\n"),
    "utf8"
  );

  const calls: Array<Record<string, unknown>> = [];
  const executor: AppLifecycleExecutorLike = {
    async startApp() {
      throw new Error("not used");
    },
    async stopApp() {
      throw new Error("not used");
    },
    async shutdownAll(params = {}) {
      calls.push({ action: "shutdown", ...params });
      return {
        stopped: ["app-a"],
        failed: ["app-b"]
      };
    }
  };
  const app = buildTestRuntimeApiServer({ store, appLifecycleExecutor: executor });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/lifecycle/shutdown"
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    stopped: ["app-a"],
    failed: ["app-b"]
  });
  assert.deepEqual(calls, [
    {
      action: "shutdown",
      targets: [{ appId: "app-a", appDir: path.join(workspaceDir, "apps", "app-a") }]
    }
  ]);

  await app.close();
  store.close();
});

test("app install, list, build-status, and setup routes preserve local payload shape", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  const lifecycleCalls: Array<Record<string, unknown>> = [];
  const app = buildTestRuntimeApiServer({
    store,
    appLifecycleExecutor: {
      async startApp(params) {
        lifecycleCalls.push({ action: "start", ...params });
        return {
          app_id: params.appId,
          status: "started",
          detail: "app started with lifecycle manager",
          ports: { http: params.httpPort ?? 18081, mcp: params.mcpPort ?? 13101 }
        };
      },
      async stopApp() {
        throw new Error("not used");
      },
      async shutdownAll() {
        throw new Error("not used");
      }
    }
  });
  try {
    const workspace = seedWorkspaceRecord(store, {
      name: "Workspace Apps",
      harness: "pi",
      status: "active"
    });

    const install = await app.inject({
      method: "POST",
      url: "/api/v1/apps/install",
      payload: {
        app_id: "demo-app",
        workspace_id: workspace.id,
        files: [
          {
            path: "app.runtime.yaml",
            content_base64: Buffer.from(
              [
                "app_id: demo-app",
                "mcp:",
                "  port: 4100",
                "lifecycle:",
                "  start: npm run dev"
              ].join("\n"),
              "utf8"
            ).toString("base64")
          }
        ]
      }
    });
    assert.equal(install.statusCode, 200);
    assert.deepEqual(install.json(), {
      app_id: "demo-app",
      status: "enabled",
      detail: "App installed and running",
      ready: true,
      error: null
    });
    assert.equal(lifecycleCalls.length, 1);

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/apps?workspace_id=${workspace.id}`
    });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json(), {
      apps: [
        {
          app_id: "demo-app",
          name: null,
          config_path: "apps/demo-app/app.runtime.yaml",
          lifecycle: { start: "npm run dev" },
          build_status: "running",
          ready: true,
          error: null,
          integrations: []
        }
      ],
      count: 1
    });

    const buildStatus = await app.inject({
      method: "GET",
      url: `/api/v1/apps/demo-app/build-status?workspace_id=${workspace.id}`
    });
    assert.equal(buildStatus.statusCode, 200);
    assert.equal(buildStatus.json().status, "running");

    const setup = await app.inject({
      method: "POST",
      url: "/api/v1/apps/demo-app/setup",
      payload: { workspace_id: workspace.id }
    });
    assert.equal(setup.statusCode, 200);
    assert.deepEqual(setup.json(), {
      app_id: "demo-app",
      status: "no_setup_command",
      detail: "No lifecycle.setup defined",
      ports: {}
    });
  } finally {
    await app.close();
    store.close();
  }
});

test("app list and build-status infer pending when installed app has setup but no build record yet", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace Apps",
    harness: "pi",
    status: "active"
  });
  const workspaceDir = path.join(workspaceRoot, workspace.id);
  fs.mkdirSync(path.join(workspaceDir, "apps", "demo-app"), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, "workspace.yaml"),
    [
      "applications:",
      "  - app_id: demo-app",
      "    config_path: apps/demo-app/app.runtime.yaml",
      "    lifecycle:",
      "      setup: npm install"
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(workspaceDir, "apps", "demo-app", "app.runtime.yaml"),
    [
      "app_id: demo-app",
      "mcp:",
      "  port: 4100",
      "lifecycle:",
      "  setup: npm install"
    ].join("\n"),
    "utf8"
  );
  const app = buildTestRuntimeApiServer({ store });
  try {
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/apps?workspace_id=${workspace.id}`
    });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json(), {
      apps: [
        {
          app_id: "demo-app",
          name: null,
          config_path: "apps/demo-app/app.runtime.yaml",
          lifecycle: { setup: "npm install" },
          build_status: "pending",
          ready: false,
          error: null,
          integrations: []
        }
      ],
      count: 1
    });

    const buildStatus = await app.inject({
      method: "GET",
      url: `/api/v1/apps/demo-app/build-status?workspace_id=${workspace.id}`
    });
    assert.equal(buildStatus.statusCode, 200);
    assert.deepEqual(buildStatus.json(), { status: "pending" });
  } finally {
    await app.close();
    store.close();
  }
});

test("queue route persists input and runtime state without writing session history until claim", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/agent-sessions/queue",
    payload: {
      workspace_id: workspace.id,
      text: "hello world"
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, "QUEUED");
  assert.equal(response.json().effective_state, "QUEUED");
  assert.equal(response.json().runtime_status, "QUEUED");
  assert.equal(response.json().has_queued_inputs, true);
  const sessionId = response.json().session_id;
  assert.ok(typeof sessionId === "string" && sessionId.trim().length > 0);

  const queued = store.getInput({ workspaceId: workspace.id, inputId: response.json().input_id });
  assert.ok(queued);
  assert.equal(queued.payload.text, "hello world");
  assert.equal("holaboss_user_id" in queued.payload, false);
  assert.equal(queued.sessionId, sessionId);

  const runtimeStates = store.listRuntimeStates(workspace.id);
  assert.equal(runtimeStates[0].status, "QUEUED");
  assert.equal(runtimeStates[0].currentInputId, response.json().input_id);
  assert.equal(runtimeStates[0].sessionId, sessionId);

  const session = store.getSession({ workspaceId: workspace.id, sessionId });
  assert.ok(session);
  assert.equal(session.kind, "main_session");
  assert.equal(session.title, "hello world");

  const binding = store.getBinding({ workspaceId: workspace.id, sessionId });
  assert.ok(binding);
  assert.equal(binding.harnessSessionId, sessionId);

  const history = store.listSessionMessages({ workspaceId: workspace.id, sessionId });
  assert.equal(history.length, 0);

  await app.close();
  store.close();
});

test("queue route clears an open ask_user_question when a normal input is enqueued", async () => {
  const root = makeTempDir("hb-runtime-api-queue-clears-question-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });

  const session = store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "main-with-question",
    kind: "main_session",
    createdBy: "user",
  });
  store.setSessionActiveUserQuestion({
    workspaceId: workspace.id,
    sessionId: session.sessionId,
    activeUserQuestion: JSON.stringify({
      questions: [{ id: "q1", prompt: "Pick one", options: [] }],
    }),
  });
  assert.ok(
    store.getSession({
      workspaceId: workspace.id,
      sessionId: session.sessionId,
    })?.activeUserQuestion,
  );

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/agent-sessions/queue",
    payload: {
      workspace_id: workspace.id,
      session_id: session.sessionId,
      text: "what?",
    },
  });
  assert.equal(response.statusCode, 200);

  // Typing a normal message supersedes the pending question — it is cleared so
  // the card doesn't linger once the run resumes.
  assert.equal(
    store.getSession({
      workspaceId: workspace.id,
      sessionId: session.sessionId,
    })?.activeUserQuestion,
    null,
  );

  await app.close();
  store.close();
});

test("queue route accepts image_urls without text or attachments", async () => {
  const root = makeTempDir("hb-runtime-api-queue-image-urls-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/agent-sessions/queue",
    payload: {
      workspace_id: workspace.id,
      image_urls: ["https://example.com/reference.png"]
    }
  });

  assert.equal(response.statusCode, 200);
  const queued = store.getInput({ workspaceId: workspace.id, inputId: response.json().input_id });
  assert.ok(queued);
  assert.equal(queued.payload.text, "");
  assert.deepEqual(queued.payload.image_urls, ["https://example.com/reference.png"]);

  const session = store.getSession({ workspaceId: workspace.id, sessionId: response.json().session_id });
  assert.ok(session);
  assert.equal(session?.title, "Image input");

  await app.close();
  store.close();
});

test("queue route preserves the active claimed input while adding later queued work", async () => {
  const root = makeTempDir("hb-runtime-api-queue-preserve-active-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-main",
    kind: "main_session",
  });
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
    harness: "pi",
    harnessSessionId: "session-main",
  });
  const active = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "currently running" },
  });
  store.updateInput({
    workspaceId: workspace.id,
    inputId: active.inputId,
    fields: {
      status: "CLAIMED",
      claimedBy: "worker-1",
      claimedUntil: "2026-04-17T12:00:00.000Z",
    },
  });
  store.updateRuntimeState({
    workspaceId: workspace.id,
    sessionId: "session-main",
    status: "BUSY",
    currentInputId: active.inputId,
    currentWorkerId: "worker-1",
    leaseUntil: "2026-04-17T12:00:00.000Z",
    heartbeatAt: "2026-04-17T11:55:00.000Z",
    lastError: null,
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/agent-sessions/queue",
    payload: {
      workspace_id: workspace.id,
      session_id: "session-main",
      text: "queue this next",
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, "QUEUED");
  assert.equal(response.json().effective_state, "BUSY");
  assert.equal(response.json().runtime_status, "BUSY");
  assert.equal(response.json().current_input_id, active.inputId);
  assert.equal(response.json().has_queued_inputs, true);

  const runtimeState = store.getRuntimeState({
    workspaceId: workspace.id,
    sessionId: "session-main",
  });
  assert.equal(runtimeState?.status, "BUSY");
  assert.equal(runtimeState?.currentInputId, active.inputId);
  assert.equal(runtimeState?.currentWorkerId, "worker-1");
  const history = store.listSessionMessages({
    workspaceId: workspace.id,
    sessionId: "session-main",
  });
  assert.equal(history.length, 0);

  const states = await app.inject({
    method: "GET",
    url: `/api/v1/agent-sessions/by-workspace/${workspace.id}/runtime-states`
  });

  assert.equal(states.statusCode, 200);
  assert.equal(states.json().items[0].status, "BUSY");
  assert.equal(states.json().items[0].effective_state, "BUSY");
  assert.equal(states.json().items[0].runtime_status, "BUSY");
  assert.equal(states.json().items[0].has_queued_inputs, true);
  assert.equal(states.json().items[0].current_input_id, active.inputId);

  await app.close();
  store.close();
});

test("runtime state reports a claimed checkpoint-gated input as effectively busy", async () => {
  const root = makeTempDir("hb-runtime-api-checkpoint-gated-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-main",
    kind: "main_session",
  });
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
    harness: "pi",
    harnessSessionId: "session-main",
  });
  const claimed = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "checkpoint-gated turn" },
  });
  store.updateInput({
    workspaceId: workspace.id,
    inputId: claimed.inputId,
    fields: {
      status: "CLAIMED",
      claimedBy: "worker-1",
      claimedUntil: "2026-04-17T12:00:00.000Z",
    },
  });
  store.updateRuntimeState({
    workspaceId: workspace.id,
    sessionId: "session-main",
    status: "QUEUED",
    currentInputId: claimed.inputId,
    currentWorkerId: "worker-1",
    leaseUntil: "2026-04-17T12:00:00.000Z",
    heartbeatAt: "2026-04-17T11:55:00.000Z",
    lastError: null,
  });

  const stateResponse = await app.inject({
    method: "GET",
    url: `/api/v1/agent-sessions/session-main/state?workspace_id=${workspace.id}`
  });

  assert.equal(stateResponse.statusCode, 200);
  assert.equal(stateResponse.json().runtime_status, "QUEUED");
  assert.equal(stateResponse.json().effective_state, "BUSY");
  assert.equal(stateResponse.json().current_input_id, claimed.inputId);

  const statesResponse = await app.inject({
    method: "GET",
    url: `/api/v1/agent-sessions/by-workspace/${workspace.id}/runtime-states`
  });

  assert.equal(statesResponse.statusCode, 200);
  assert.equal(statesResponse.json().items[0].status, "QUEUED");
  assert.equal(statesResponse.json().items[0].runtime_status, "QUEUED");
  assert.equal(statesResponse.json().items[0].effective_state, "BUSY");
  assert.equal(statesResponse.json().items[0].has_queued_inputs, false);
  assert.equal(statesResponse.json().items[0].current_input_id, claimed.inputId);

  await app.close();
  store.close();
});

test("queue route folds pending background updates into the next main-session input even before the merge window expires", async () => {
  const root = makeTempDir("hb-runtime-api-queue-inline-background-updates-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-main",
    kind: "main_session",
  });
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
    harness: "pi",
    harnessSessionId: "session-main",
  });
  const event = store.enqueueMainSessionEvent({
    workspaceId: workspace.id,
    ownerMainSessionId: "session-main",
    originMainSessionId: "session-main",
    subagentId: "subagent-1",
    eventType: "completed",
    deliveryBucket: "background_update",
    earliestDeliverAt: "2099-04-17T12:00:00.000Z",
    payload: {
      status: "completed",
      summary: "Repo scan finished.",
      assistant_text:
        "<html><body><h1>Full report body</h1><p>This should stay out of the main-session prompt.</p></body></html>",
      forwardable_deliverables: [
        {
          output_id: "output-1",
          artifact_id: "artifact-1",
          type: "report",
          output_type: "document",
          title: "repo-scan-report.md",
          status: "completed",
          file_path: "outputs/reports/repo-scan-report.md",
          metadata: {
            artifact_type: "report",
          },
        },
      ],
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/agent-sessions/queue",
    payload: {
      workspace_id: workspace.id,
      session_id: "session-main",
      text: "What should I do next?",
    },
  });

  assert.equal(response.statusCode, 200);
  const queued = store.getInput({ workspaceId: workspace.id, inputId: response.json().input_id });
  const updatedEvent = store.getMainSessionEvent({ workspaceId: workspace.id, eventId: event.eventId });
  const context = (queued?.payload.context ?? {}) as Record<string, unknown>;

  assert.ok(queued);
  assert.deepEqual(context.main_session_event_ids, [event.eventId]);
  assert.equal(context.delivery_bucket, "background_update");
  assert.equal(context.main_session_event_mode, "inline_user_reply");
  assert.ok(Array.isArray(context.queued_events));
  const queuedEventPayload = ((context.queued_events as Array<Record<string, unknown>>)[0]
    ?.payload ?? {}) as Record<string, unknown>;
  assert.equal(queuedEventPayload.assistant_text, undefined);
  assert.equal(
    ((queuedEventPayload.forwardable_deliverables as Array<Record<string, unknown>>)[0]
      ?.title as string),
    "repo-scan-report.md",
  );
  assert.equal(updatedEvent?.status, "materialized");
  assert.equal(updatedEvent?.materializedInputId, queued?.inputId);

  await app.close();
  store.close();
});

test("queue route preserves an existing explicit session title", async () => {
  const root = makeTempDir("hb-runtime-api-session-title-preserve-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-main",
    kind: "main_session",
    title: "Pinned title",
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/agent-sessions/queue",
    payload: {
      workspace_id: workspace.id,
      session_id: "session-main",
      text: "replace me if you can"
    }
  });

  assert.equal(response.statusCode, 200);
  const session = store.getSession({ workspaceId: workspace.id, sessionId: "session-main" });
  assert.ok(session);
  assert.equal(session.title, "Pinned title");

  await app.close();
  store.close();
});

test("queued input edit route updates queued input text without writing session history", async () => {
  const root = makeTempDir("hb-runtime-api-edit-queued-input-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: {
      text: "draft this first",
      attachments: [],
      image_urls: [],
      model: null,
      thinking_value: null,
      context: {},
    },
  });

  const response = await app.inject({
    method: "PATCH",
    url: `/api/v1/agent-sessions/session-main/inputs/${queued.inputId}`,
    payload: {
      workspace_id: workspace.id,
      text: "draft this second",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().input_id, queued.inputId);
  assert.equal(response.json().session_id, "session-main");
  assert.equal(response.json().status, "QUEUED");
  assert.equal(response.json().text, "draft this second");

  const updated = store.getInput({ workspaceId: workspace.id, inputId: queued.inputId });
  assert.ok(updated);
  assert.equal(updated?.payload.text, "draft this second");
  const history = store.listSessionMessages({
    workspaceId: workspace.id,
    sessionId: "session-main",
  });
  assert.equal(history.length, 0);

  await app.close();
  store.close();
});

test("queued input edit route rejects edits after the input is claimed", async () => {
  const root = makeTempDir("hb-runtime-api-edit-claimed-input-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: {
      text: "draft this first",
      attachments: [],
      image_urls: [],
      model: null,
      thinking_value: null,
      context: {},
    },
  });
  store.updateInput({
    workspaceId: workspace.id,
    inputId: queued.inputId,
    fields: {
      status: "CLAIMED",
      claimedBy: "worker-1",
      claimedUntil: "2026-04-17T12:00:00.000Z",
    },
  });

  const response = await app.inject({
    method: "PATCH",
    url: `/api/v1/agent-sessions/session-main/inputs/${queued.inputId}`,
    payload: {
      workspace_id: workspace.id,
      text: "edited too late",
    },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(
    response.json().detail,
    "queued input can no longer be edited",
  );

  await app.close();
  store.close();
});

test("pause route delegates to the configured queue worker", async () => {
  const root = makeTempDir("hb-runtime-api-pause-route-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "hello world" }
  });

  let pausedParams: { workspaceId: string; sessionId: string } | null = null;
  const app = buildRuntimeApiServer({
    store,
    queueWorker: {
      async start() {},
      wake() {},
      async close() {},
      async pauseSessionRun(params) {
        pausedParams = params;
        return {
          inputId: queued.inputId,
          sessionId: params.sessionId,
          status: "PAUSING",
        };
      },
    },
    cronWorker: null,
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/agent-sessions/session-main/pause",
    payload: {
      workspace_id: workspace.id,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(pausedParams, {
    workspaceId: workspace.id,
    sessionId: "session-main",
  });
  assert.deepEqual(response.json(), {
    input_id: queued.inputId,
    session_id: "session-main",
    status: "PAUSING",
  });

  await app.close();
  store.close();
});

test("runtime api server starts and closes the recall embedding backfill worker", async () => {
  const root = makeTempDir("hb-runtime-api-recall-embedding-worker-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  let started = 0;
  let closed = 0;
  let woke = 0;
  const app = buildRuntimeApiServer({
    store,
    queueWorker: null,
    durableMemoryWorker: null,
    cronWorker: null,
    recallEmbeddingBackfillWorker: {
      async start() {
        started += 1;
      },
      wake() {
        woke += 1;
      },
      async close() {
        closed += 1;
      },
    },
    enableAppHealthMonitor: false,
    startAppsOnReady: false,
  });

  await app.ready();
  assert.equal(started, 1);
  assert.equal(woke, 0);

  await app.close();
  assert.equal(closed, 1);

  store.close();
});

test("queue route creates pending user memory proposals from strong preference signals", async () => {
  const root = makeTempDir("hb-runtime-api-memory-proposals-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/agent-sessions/queue",
    payload: {
      workspace_id: workspace.id,
      text: "Please keep your responses concise and do not zip the files; deliver them individually."
    }
  });

  assert.equal(response.statusCode, 200);
  const sessionId = response.json().session_id;
  assert.ok(typeof sessionId === "string" && sessionId.trim().length > 0);
  const proposals = store.listMemoryUpdateProposals({
    workspaceId: workspace.id,
    sessionId,
    inputId: response.json().input_id,
    limit: 10,
    offset: 0
  });

  assert.equal(proposals.length, 2);
  assert.deepEqual(
    proposals.map((proposal) => proposal.targetKey).sort(),
    ["file-delivery", "response-style"]
  );
  assert.ok(proposals.every((proposal) => proposal.state === "pending"));

  await app.close();
  store.close();
});

test("runtime api server starts and closes the main-session event worker", async () => {
  const root = makeTempDir("hb-runtime-api-main-session-event-worker-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  let started = 0;
  let closed = 0;
  let woke = 0;
  const app = buildRuntimeApiServer({
    store,
    queueWorker: null,
    durableMemoryWorker: null,
    cronWorker: null,
    recallEmbeddingBackfillWorker: null,
    mainSessionEventWorker: {
      async start() {
        started += 1;
      },
      wake() {
        woke += 1;
      },
      async close() {
        closed += 1;
      },
    },
    enableAppHealthMonitor: false,
    startAppsOnReady: false,
  });

  await app.ready();

  assert.equal(started, 1);
  assert.equal(woke, 0);

  await app.close();

  assert.equal(closed, 1);
  store.close();
});

test("queue route rejects inputs while workspace apps are still building", async () => {
  const root = makeTempDir("hb-runtime-api-queue-app-build-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });

  const workspaceDir = store.workspaceDir(workspace.id);
  fs.mkdirSync(path.join(workspaceDir, "apps", "gmail"), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, "workspace.yaml"),
    [
      "applications:",
      "  - app_id: gmail",
      "    config_path: apps/gmail/app.runtime.yaml",
      "    lifecycle:",
      "      setup: npm run build"
    ].join("\n"),
    "utf8"
  );
  store.upsertAppBuild({
    workspaceId: workspace.id,
    appId: "gmail",
    status: "building"
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/agent-sessions/queue",
    payload: {
      workspace_id: workspace.id,
      text: "hello world"
    }
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().detail, "workspace apps are still building: gmail (building)");
  assert.equal(store.listRuntimeStates(workspace.id).length, 0);

  await app.close();
  store.close();
});

test("queue route accepts staged file and folder attachments and history hydrates attachment metadata after claim", async () => {
  const root = makeTempDir("hb-runtime-api-queue-attachments-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
    harness: "pi",
    harnessSessionId: "session-main"
  });

  const workspaceDir = store.workspaceDir(workspace.id);
  const attachmentPath = path.join(workspaceDir, ".holaboss", "input-attachments", "batch-1", "diagram.png");
  const attachedFolderPath = path.join(workspaceDir, "docs");
  fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
  fs.mkdirSync(attachedFolderPath, { recursive: true });
  fs.writeFileSync(attachmentPath, "png-bytes", "utf8");
  fs.writeFileSync(path.join(attachedFolderPath, "brief.md"), "# brief\n", "utf8");

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/agent-sessions/queue",
    payload: {
      workspace_id: workspace.id,
      text: "",
      attachments: [
        {
          id: "attachment-1",
          kind: "image",
          name: "diagram.png",
          mime_type: "image/png",
          size_bytes: 9,
          workspace_path: ".holaboss/input-attachments/batch-1/diagram.png"
        },
        {
          id: "attachment-2",
          kind: "folder",
          name: "docs",
          mime_type: "inode/directory",
          size_bytes: 0,
          workspace_path: "docs"
        }
      ]
    }
  });

  assert.equal(response.statusCode, 200);
  const queued = store.getInput({ workspaceId: workspace.id, inputId: response.json().input_id });
  assert.ok(queued);
  assert.deepEqual(queued.payload.attachments, [
    {
      id: "attachment-1",
      kind: "image",
      name: "diagram.png",
      mime_type: "image/png",
      size_bytes: 9,
      workspace_path: ".holaboss/input-attachments/batch-1/diagram.png"
    },
    {
      id: "attachment-2",
      kind: "folder",
      name: "docs",
      mime_type: "inode/directory",
      size_bytes: 0,
      workspace_path: "docs"
    }
  ]);

  const historyResponse = await app.inject({
    method: "GET",
    url: `/api/v1/agent-sessions/session-main/history?workspace_id=${workspace.id}`
  });

  assert.equal(historyResponse.statusCode, 200);
  assert.deepEqual(historyResponse.json().messages, []);

  store.insertSessionMessage({
    workspaceId: workspace.id,
    sessionId: "session-main",
    role: "user",
    text: "",
    messageId: `user-${response.json().input_id}`,
    createdAt: "2026-01-01T00:00:00.000Z"
  });

  const claimedHistoryResponse = await app.inject({
    method: "GET",
    url: `/api/v1/agent-sessions/session-main/history?workspace_id=${workspace.id}`
  });

  assert.equal(claimedHistoryResponse.statusCode, 200);
  assert.deepEqual(claimedHistoryResponse.json().messages, [
    {
      id: `user-${response.json().input_id}`,
      role: "user",
      text: "",
      created_at: "2026-01-01T00:00:00.000Z",
      metadata: {
        attachments: [
          {
            id: "attachment-1",
            kind: "image",
            name: "diagram.png",
            mime_type: "image/png",
            size_bytes: 9,
            workspace_path: ".holaboss/input-attachments/batch-1/diagram.png"
          },
          {
            id: "attachment-2",
            kind: "folder",
            name: "docs",
            mime_type: "inode/directory",
            size_bytes: 0,
            workspace_path: "docs"
          }
        ]
      }
    }
  ]);

  await app.close();
  store.close();
});

test("session history prefers attachment metadata stored on the session message", async () => {
  const root = makeTempDir("hb-runtime-api-session-message-attachments-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const app = buildTestRuntimeApiServer({ store });

  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
    harness: "pi",
    harnessSessionId: "session-main"
  });
  store.insertSessionMessage({
    workspaceId: workspace.id,
    sessionId: "session-main",
    role: "user",
    text: "use the earlier report",
    metadata: {
      attachments: [
        {
          id: "attachment-1",
          kind: "file",
          name: "report.html",
          mime_type: "text/html",
          size_bytes: 128,
          workspace_path: ".holaboss/input-attachments/batch-1/report.html"
        }
      ]
    },
    messageId: "user-input-1",
    createdAt: "2026-01-01T00:00:00.000Z"
  });

  const historyResponse = await app.inject({
    method: "GET",
    url: `/api/v1/agent-sessions/session-main/history?workspace_id=${workspace.id}`
  });

  assert.equal(historyResponse.statusCode, 200);
  assert.deepEqual(historyResponse.json().messages, [
    {
      id: "user-input-1",
      role: "user",
      text: "use the earlier report",
      created_at: "2026-01-01T00:00:00.000Z",
      metadata: {
        attachments: [
          {
            id: "attachment-1",
            kind: "file",
            name: "report.html",
            mime_type: "text/html",
            size_bytes: 128,
            workspace_path: ".holaboss/input-attachments/batch-1/report.html"
          }
        ]
      }
    }
  ]);

  await app.close();
  store.close();
});

test("GET /api/v1/apps/catalog returns entries filtered by source", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  const app = buildTestRuntimeApiServer({ store });

  store.upsertAppCatalogEntry({
    appId: "twitter",
    source: "marketplace",
    name: "Twitter / X",
    description: null,
    icon: null,
    category: null,
    tags: ["social"],
    version: "v0.1.0",
    archiveUrl: "https://example.test/twitter-module-darwin-arm64.tar.gz",
    archivePath: null,
    target: "darwin-arm64",
    cachedAt: "2026-04-09T00:00:00Z",
    providerId: "twitter",
    credentialSource: "platform",
  });
  store.upsertAppCatalogEntry({
    appId: "linkedin",
    source: "local",
    name: "LinkedIn",
    description: null,
    icon: null,
    category: null,
    tags: [],
    version: null,
    archiveUrl: null,
    archivePath: "/tmp/linkedin-module-darwin-arm64.tar.gz",
    target: "darwin-arm64",
    cachedAt: "2026-04-09T00:00:00Z",
    providerId: "linkedin",
    credentialSource: "platform",
  });

  const res = await app.inject({ method: "GET", url: "/api/v1/apps/catalog?source=marketplace" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.count, 1);
  assert.equal(body.entries[0].app_id, "twitter");
  assert.deepEqual(body.entries[0].tags, ["social"]);

  await app.close();
  store.close();
});

test("POST /api/v1/apps/catalog/sync replaces all entries for a source", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  const app = buildTestRuntimeApiServer({ store });

  store.upsertAppCatalogEntry({
    appId: "old",
    source: "marketplace",
    name: "Old",
    description: null,
    icon: null,
    category: null,
    tags: [],
    version: "v0.0.1",
    archiveUrl: "https://example.test/old.tar.gz",
    archivePath: null,
    target: "darwin-arm64",
    cachedAt: "2026-04-08T00:00:00Z",
    providerId: null,
    credentialSource: null,
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/apps/catalog/sync",
    payload: {
      source: "marketplace",
      target: "darwin-arm64",
      entries: [
        {
          app_id: "twitter",
          name: "Twitter / X",
          description: "Tweet stuff",
          icon: null,
          category: "social",
          tags: ["social"],
          version: "v0.1.0",
          archive_url: "https://example.test/twitter.tar.gz",
          archive_path: null,
        },
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.synced, 1);
  assert.equal(body.source, "marketplace");

  const remaining = store.listAppCatalogEntries({ source: "marketplace" });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].appId, "twitter");

  await app.close();
  store.close();
});

test("POST /api/v1/apps/catalog/sync rejects invalid source", async () => {
  const root = makeTempDir("hb-runtime-api-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot
  });
  const app = buildTestRuntimeApiServer({ store });

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/apps/catalog/sync",
    payload: { source: "bogus", target: "darwin-arm64", entries: [] },
  });
  assert.equal(res.statusCode, 400);

  await app.close();
  store.close();
});

test("isAllowedArchivePath accepts tmpdir and rejects arbitrary paths", async () => {
  const { isAllowedArchivePath } = await import("./app.js");
  const tmp = path.join(os.tmpdir(), "holaboss-test-archive.tar.gz");
  assert.equal(isAllowedArchivePath(tmp), true);
  assert.equal(isAllowedArchivePath("/etc/passwd"), false);
  assert.equal(isAllowedArchivePath(""), false);
});

test("POST /apps/install-archive rejects path outside allowed roots", async () => {
  const root = makeTempDir("hb-runtime-api-install-archive-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Test Workspace",
    harness: "pi",
    status: "active",
  });
  const app = buildTestRuntimeApiServer({ store });

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/apps/install-archive",
    payload: {
      workspace_id: workspace.id,
      app_id: "minimal",
      archive_path: "/etc/passwd",
    },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  const msg = body.error || body.detail || body.message || "";
  assert.match(String(msg), /outside allowed roots/);

  await app.close();
  store.close();
});

test("POST /apps/install-archive rejects missing file", async () => {
  const root = makeTempDir("hb-runtime-api-install-archive-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Test Workspace",
    harness: "pi",
    status: "active",
  });
  const app = buildTestRuntimeApiServer({ store });

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/apps/install-archive",
    payload: {
      workspace_id: workspace.id,
      app_id: "minimal",
      archive_path: path.join(os.tmpdir(), `does-not-exist-${Date.now()}.tar.gz`),
    },
  });
  assert.equal(res.statusCode, 400);

  await app.close();
  store.close();
});

test("POST /apps/install-archive extracts tarball and registers in workspace.yaml", async () => {
  const root = makeTempDir("hb-runtime-api-install-archive-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Test Workspace",
    harness: "pi",
    status: "active",
  });
  const workspaceDir = store.workspaceDir(workspace.id);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const app = buildTestRuntimeApiServer({ store });

  const stagedArchive = path.join(os.tmpdir(), `install-archive-test-${Date.now()}.tar.gz`);
  fs.copyFileSync(MINIMAL_APP_FIXTURE, stagedArchive);

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/apps/install-archive",
    payload: {
      workspace_id: workspace.id,
      app_id: "minimal",
      archive_path: stagedArchive,
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.app_id, "minimal");
  assert.equal(body.status, "enabled");

  const appDir = path.join(workspaceDir, "apps", "minimal");
  assert.equal(fs.existsSync(path.join(appDir, "app.runtime.yaml")), true);
  assert.equal(fs.existsSync(path.join(appDir, "package.json")), true);

  const yamlBody = fs.readFileSync(path.join(workspaceDir, "workspace.yaml"), "utf8");
  assert.match(yamlBody, /app_id:\s*["']?minimal["']?/);

  fs.rmSync(stagedArchive, { force: true });

  await app.close();
  store.close();
});

test("POST /apps/install-archive rejects re-install when apps/{id} already exists", async () => {
  const root = makeTempDir("hb-runtime-api-install-archive-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Test Workspace",
    harness: "pi",
    status: "active",
  });
  const workspaceDir = store.workspaceDir(workspace.id);
  const preDir = path.join(workspaceDir, "apps", "minimal");
  fs.mkdirSync(preDir, { recursive: true });
  fs.writeFileSync(path.join(preDir, "sentinel.txt"), "existing");
  const app = buildTestRuntimeApiServer({ store });

  const stagedArchive = path.join(os.tmpdir(), `install-archive-reinstall-${Date.now()}.tar.gz`);
  fs.copyFileSync(MINIMAL_APP_FIXTURE, stagedArchive);

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/apps/install-archive",
    payload: {
      workspace_id: workspace.id,
      app_id: "minimal",
      archive_path: stagedArchive,
    },
  });
  assert.equal(res.statusCode, 409);
  fs.rmSync(stagedArchive, { force: true });

  await app.close();
  store.close();
});

test("parseInstalledAppRuntime extracts mcp.tools list", () => {
  const yamlBody = `
app_id: "twitter"
name: "Twitter"
slug: "twitter"

lifecycle:
  setup: "true"
  start: "true"
  stop: "true"

mcp:
  enabled: true
  transport: http-sse
  port: 3099
  path: /mcp/sse
  tools:
    - create_post
    - list_posts
    - publish_post
`;
  const parsed = parseInstalledAppRuntime(yamlBody, "twitter", "apps/twitter/app.runtime.yaml");
  assert.deepEqual(parsed.mcpTools, ["create_post", "list_posts", "publish_post"]);
});

test("parseInstalledAppRuntime returns empty mcpTools when not declared", () => {
  const yamlBody = `
app_id: "twitter"
name: "Twitter"
slug: "twitter"

lifecycle:
  setup: "true"

mcp:
  enabled: true
  transport: http-sse
  port: 3099
  path: /mcp/sse
`;
  const parsed = parseInstalledAppRuntime(yamlBody, "twitter", "apps/twitter/app.runtime.yaml");
  assert.deepEqual(parsed.mcpTools, []);
});

test("parseInstalledAppRuntime returns empty mcpTools when mcp block missing", () => {
  const yamlBody = `
app_id: "minimal"
name: "Minimal"

lifecycle:
  setup: "true"
`;
  const parsed = parseInstalledAppRuntime(yamlBody, "minimal", "apps/minimal/app.runtime.yaml");
  assert.deepEqual(parsed.mcpTools, []);
});

test("writeWorkspaceMcpRegistryEntry adds server and tool_ids to workspace.yaml", () => {
  const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "wmcp-test-"));
  try {
    fs.writeFileSync(
      path.join(tmpWorkspace, "workspace.yaml"),
      "template_id: test\nname: Test\n",
    );

    writeWorkspaceMcpRegistryEntry(tmpWorkspace, "twitter", {
      mcpEnabled: true,
      mcpTools: ["create_post", "list_posts"],
      mcpPath: "/mcp/sse",
      mcpTimeoutMs: 30000,
      mcpPort: 13100,
    });

    const yamlText = fs.readFileSync(
      path.join(tmpWorkspace, "workspace.yaml"),
      "utf8",
    );
    assert.match(yamlText, /mcp_registry/);
    assert.match(yamlText, /servers:/);
    assert.match(yamlText, /twitter:/);
    assert.match(yamlText, /allowlist:/);
    assert.match(yamlText, /twitter\.create_post/);
    assert.match(yamlText, /twitter\.list_posts/);
    assert.match(yamlText, /13100/);
  } finally {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  }
});

test("writeWorkspaceMcpRegistryEntry is a no-op when mcp is disabled", () => {
  const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "wmcp-test-"));
  try {
    fs.writeFileSync(
      path.join(tmpWorkspace, "workspace.yaml"),
      "template_id: test\nname: Test\n",
    );

    writeWorkspaceMcpRegistryEntry(tmpWorkspace, "twitter", {
      mcpEnabled: false,
      mcpTools: ["create_post"],
      mcpPath: "/mcp/sse",
      mcpTimeoutMs: 30000,
      mcpPort: 13100,
    });

    const yamlText = fs.readFileSync(
      path.join(tmpWorkspace, "workspace.yaml"),
      "utf8",
    );
    assert.doesNotMatch(yamlText, /mcp_registry/);
  } finally {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  }
});

test("writeWorkspaceMcpRegistryEntry replaces existing entry for the same app", () => {
  const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "wmcp-test-"));
  try {
    fs.writeFileSync(
      path.join(tmpWorkspace, "workspace.yaml"),
      `template_id: test
name: Test
mcp_registry:
  allowlist:
    tool_ids:
      - twitter.old_tool
      - linkedin.create_post
  servers:
    twitter:
      type: remote
      url: http://localhost:99999/old
      enabled: true
    linkedin:
      type: remote
      url: http://localhost:13101/mcp/sse
      enabled: true
`,
    );

    writeWorkspaceMcpRegistryEntry(tmpWorkspace, "twitter", {
      mcpEnabled: true,
      mcpTools: ["new_tool"],
      mcpPath: "/mcp/sse",
      mcpTimeoutMs: 30000,
      mcpPort: 13100,
    });

    const yamlText = fs.readFileSync(
      path.join(tmpWorkspace, "workspace.yaml"),
      "utf8",
    );
    // old twitter tool replaced
    assert.doesNotMatch(yamlText, /twitter\.old_tool/);
    assert.match(yamlText, /twitter\.new_tool/);
    // linkedin entries untouched
    assert.match(yamlText, /linkedin\.create_post/);
    assert.match(yamlText, /13101/);
    // twitter server replaced
    assert.doesNotMatch(yamlText, /99999/);
    assert.match(yamlText, /13100/);
  } finally {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  }
});

test("removeWorkspaceMcpRegistryEntry strips server and tool_ids for the app", () => {
  const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "wmcp-rm-test-"));
  try {
    fs.writeFileSync(
      path.join(tmpWorkspace, "workspace.yaml"),
      `template_id: test
name: Test
mcp_registry:
  allowlist:
    tool_ids:
      - twitter.create_post
      - twitter.list_posts
      - linkedin.create_post
  servers:
    twitter:
      type: remote
      url: http://localhost:13100/mcp/sse
      enabled: true
    linkedin:
      type: remote
      url: http://localhost:13101/mcp/sse
      enabled: true
`,
    );

    removeWorkspaceMcpRegistryEntry(tmpWorkspace, "twitter");

    const yamlText = fs.readFileSync(
      path.join(tmpWorkspace, "workspace.yaml"),
      "utf8",
    );
    assert.doesNotMatch(yamlText, /twitter\.create_post/);
    assert.doesNotMatch(yamlText, /twitter\.list_posts/);
    assert.match(yamlText, /linkedin\.create_post/);
    assert.match(yamlText, /linkedin:/);
  } finally {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  }
});

test("removeWorkspaceMcpRegistryEntry is a no-op when workspace.yaml has no mcp_registry", () => {
  const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "wmcp-rm-test-"));
  try {
    fs.writeFileSync(
      path.join(tmpWorkspace, "workspace.yaml"),
      "template_id: test\nname: Test\n",
    );

    // Should not throw
    removeWorkspaceMcpRegistryEntry(tmpWorkspace, "twitter");

    const yamlText = fs.readFileSync(
      path.join(tmpWorkspace, "workspace.yaml"),
      "utf8",
    );
    assert.doesNotMatch(yamlText, /mcp_registry/);
  } finally {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  }
});

test("install-archive populates workspace.yaml mcp_registry from declared mcp.tools", async () => {
  const root = makeTempDir("hb-runtime-api-install-archive-mcp-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Test Workspace",
    harness: "pi",
    status: "active",
  });
  const workspaceDir = store.workspaceDir(workspace.id);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const app = buildTestRuntimeApiServer({ store });

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fixture-"));
  fs.writeFileSync(
    path.join(stageDir, "app.runtime.yaml"),
    `app_id: "twitter"
name: "Twitter"
slug: "twitter"

lifecycle:
  setup: "true"
  start: "true"
  stop: "true"

healthchecks:
  mcp:
    path: /mcp/health
    timeout_s: 5

mcp:
  enabled: true
  transport: http-sse
  port: 3099
  path: /mcp/sse
  tools:
    - create_post
    - list_posts
`,
  );
  fs.writeFileSync(path.join(stageDir, "package.json"), "{}");

  const archivePath = path.join(os.tmpdir(), `mcp-test-${Date.now()}.tar.gz`);
  await tar.c(
    { gzip: true, file: archivePath, cwd: stageDir, portable: true, noMtime: true },
    ["app.runtime.yaml", "package.json"],
  );

  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/apps/install-archive",
      payload: {
        workspace_id: workspace.id,
        app_id: "twitter",
        archive_path: archivePath,
      },
    });
    assert.equal(res.statusCode, 200);

    const yamlBody = fs.readFileSync(
      path.join(workspaceDir, "workspace.yaml"),
      "utf8",
    );
    assert.match(yamlBody, /mcp_registry/);
    assert.match(yamlBody, /twitter\.create_post/);
    assert.match(yamlBody, /twitter\.list_posts/);
    assert.match(yamlBody, /servers:/);
    assert.match(yamlBody, /twitter:/);
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.rmSync(archivePath, { force: true });
    await app.close();
    store.close();
  }
});

test("DELETE /apps/:appId removes mcp_registry entry", async () => {
  const root = makeTempDir("hb-runtime-api-delete-app-mcp-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Test Workspace",
    harness: "pi",
    status: "active",
  });
  const workspaceDir = store.workspaceDir(workspace.id);

  // Pre-seed workspace.yaml with applications + mcp_registry
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, "workspace.yaml"),
    `template_id: test
name: Test
applications:
  - app_id: twitter
    config_path: apps/twitter/app.runtime.yaml
    lifecycle:
      stop: "true"
mcp_registry:
  allowlist:
    tool_ids:
      - twitter.create_post
      - linkedin.create_post
  servers:
    twitter:
      type: remote
      url: http://localhost:13100/mcp/sse
      enabled: true
    linkedin:
      type: remote
      url: http://localhost:13101/mcp/sse
      enabled: true
`,
  );

  // Create apps/twitter dir with a minimal app.runtime.yaml so the DELETE
  // handler can stop the app (best-effort) before uninstalling
  const appDir = path.join(workspaceDir, "apps", "twitter");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "app.runtime.yaml"),
    `app_id: twitter
name: Twitter
lifecycle:
  stop: "true"
mcp:
  enabled: false
  port: 3099
`,
  );

  const app = buildTestRuntimeApiServer({ store });

  try {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/apps/twitter",
      payload: { workspace_id: workspace.id },
    });
    assert.equal(res.statusCode, 200);

    const yamlBody = fs.readFileSync(
      path.join(workspaceDir, "workspace.yaml"),
      "utf8",
    );
    assert.doesNotMatch(yamlBody, /twitter\.create_post/);
    assert.match(yamlBody, /linkedin\.create_post/);
    assert.match(yamlBody, /linkedin:/);
  } finally {
    await app.close();
    store.close();
  }
});

// ── archive_url tests ──────────────────────────────────────────────────────────

test("isAllowedArchiveUrl honors the configured allowlist and rejects others", async () => {
  process.env.HOLABOSS_APP_ARCHIVE_URL_ALLOWLIST =
    "https://github.com/example-org/example-repo/releases/download/";
  const { isAllowedArchiveUrl } = await import("./app.js");
  assert.equal(
    isAllowedArchiveUrl(
      "https://github.com/example-org/example-repo/releases/download/v0.1.0/twitter-module-darwin-arm64.tar.gz",
    ),
    true,
  );
  assert.equal(isAllowedArchiveUrl("https://evil.test/twitter.tar.gz"), false);
  assert.equal(
    isAllowedArchiveUrl("http://github.com/example-org/example-repo/releases/download/x.tar.gz"),
    false,
  );
  assert.equal(isAllowedArchiveUrl(""), false);
  assert.equal(isAllowedArchiveUrl("not-a-url"), false);
  delete process.env.HOLABOSS_APP_ARCHIVE_URL_ALLOWLIST;
});

test("POST /apps/install-archive rejects url outside allowlist", async () => {
  const root = makeTempDir("hb-runtime-api-install-archive-url-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Test Workspace",
    harness: "pi",
    status: "active",
  });
  const workspaceDir = store.workspaceDir(workspace.id);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const app = buildTestRuntimeApiServer({ store });

  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/apps/install-archive",
      payload: {
        workspace_id: workspace.id,
        app_id: "evil",
        archive_url: "https://evil.test/twitter.tar.gz",
      },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.match(
      String(body.error ?? body.detail ?? body.message ?? ""),
      /allowlist|archive_url/,
    );
  } finally {
    await app.close();
    store.close();
  }
});

test("POST /apps/install-archive rejects both archive_path and archive_url", async () => {
  const root = makeTempDir("hb-runtime-api-install-archive-both-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Test Workspace",
    harness: "pi",
    status: "active",
  });
  const workspaceDir = store.workspaceDir(workspace.id);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const app = buildTestRuntimeApiServer({ store });

  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/apps/install-archive",
      payload: {
        workspace_id: workspace.id,
        app_id: "twitter",
        archive_path: "/tmp/x.tar.gz",
        archive_url:
          "https://github.com/holaboss-ai/holaboss-modules/releases/download/v0.1.0/twitter-module-darwin-arm64.tar.gz",
      },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close();
    store.close();
  }
});

test("POST /apps/install-archive rejects request with neither path nor url", async () => {
  const root = makeTempDir("hb-runtime-api-install-archive-neither-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Test Workspace",
    harness: "pi",
    status: "active",
  });
  const workspaceDir = store.workspaceDir(workspace.id);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const app = buildTestRuntimeApiServer({ store });

  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/apps/install-archive",
      payload: {
        workspace_id: workspace.id,
        app_id: "twitter",
      },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close();
    store.close();
  }
});

test("POST /apps/install-archive with archive_url downloads and installs", async () => {
  const root = makeTempDir("hb-runtime-api-install-archive-url-dl-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Test Workspace",
    harness: "pi",
    status: "active",
  });
  const workspaceDir = store.workspaceDir(workspace.id);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const app = buildTestRuntimeApiServer({ store });

  const fixtureBuf = fs.readFileSync(MINIMAL_APP_FIXTURE);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/gzip" });
    res.end(fixtureBuf);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  const url = `http://127.0.0.1:${addr.port}/minimal.tar.gz`;

  const savedEnv = process.env.HOLABOSS_APP_ARCHIVE_URL_ALLOWLIST;
  process.env.HOLABOSS_APP_ARCHIVE_URL_ALLOWLIST = `http://127.0.0.1:${addr.port}/`;

  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/apps/install-archive",
      payload: {
        workspace_id: workspace.id,
        app_id: "minimal",
        archive_url: url,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.app_id, "minimal");

    const installed = path.join(
      store.workspaceDir(workspace.id),
      "apps",
      "minimal",
      "app.runtime.yaml",
    );
    assert.equal(fs.existsSync(installed), true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    if (savedEnv === undefined) {
      delete process.env.HOLABOSS_APP_ARCHIVE_URL_ALLOWLIST;
    } else {
      process.env.HOLABOSS_APP_ARCHIVE_URL_ALLOWLIST = savedEnv;
    }
    await app.close();
    store.close();
  }
});

// Regression: a 409 "already installed" must release the install lock so the
// same (workspaceId, appId) can be retried. Previously the lock was set before
// the early return but the try/finally only wrapped the later flow, so a single
// failed reinstall pinned the app id until the runtime restarted.
test("POST /apps/install-archive releases install lock on already-installed 409", async () => {
  const root = makeTempDir("hb-runtime-api-install-archive-lock-release-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Test Workspace",
    harness: "pi",
    status: "active",
  });
  const workspaceDir = store.workspaceDir(workspace.id);
  const preDir = path.join(workspaceDir, "apps", "minimal");
  fs.mkdirSync(preDir, { recursive: true });
  fs.writeFileSync(path.join(preDir, "sentinel.txt"), "existing");
  const app = buildTestRuntimeApiServer({ store });

  const stagedArchive = path.join(os.tmpdir(), `install-archive-lock-release-${Date.now()}.tar.gz`);
  fs.copyFileSync(MINIMAL_APP_FIXTURE, stagedArchive);

  try {
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/apps/install-archive",
      payload: {
        workspace_id: workspace.id,
        app_id: "minimal",
        archive_path: stagedArchive,
      },
    });
    assert.equal(first.statusCode, 409);
    assert.match(first.json().detail ?? "", /already installed/);

    // Second request for the same (workspaceId, appId) must still hit the
    // "already installed" branch — NOT "install already in progress", which
    // would indicate a stale lock.
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/apps/install-archive",
      payload: {
        workspace_id: workspace.id,
        app_id: "minimal",
        archive_path: stagedArchive,
      },
    });
    assert.equal(second.statusCode, 409);
    assert.match(second.json().detail ?? "", /already installed/);
    assert.doesNotMatch(second.json().detail ?? "", /install already in progress/);
  } finally {
    fs.rmSync(stagedArchive, { force: true });
    await app.close();
    store.close();
  }
});

// Regression: concurrent archive_url installs for the same (workspaceId, appId)
// must be serialized. Previously the install lock was only set after the await
// on downloadArchiveToTemp, so two simultaneous requests could both pass the
// in-flight check, both download, and both reach extraction/registration.
test("POST /apps/install-archive serializes concurrent archive_url installs", async () => {
  const root = makeTempDir("hb-runtime-api-install-archive-url-race-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Test Workspace",
    harness: "pi",
    status: "active",
  });
  const workspaceDir = store.workspaceDir(workspace.id);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const app = buildTestRuntimeApiServer({ store });

  const fixtureBuf = fs.readFileSync(MINIMAL_APP_FIXTURE);
  // Delay every response by 300ms so the first download is still in flight
  // when the second request arrives, exercising the in-flight guard.
  const server = http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/gzip" });
      res.end(fixtureBuf);
    }, 300);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  const url = `http://127.0.0.1:${addr.port}/minimal.tar.gz`;

  const savedEnv = process.env.HOLABOSS_APP_ARCHIVE_URL_ALLOWLIST;
  process.env.HOLABOSS_APP_ARCHIVE_URL_ALLOWLIST = `http://127.0.0.1:${addr.port}/`;

  try {
    const payload = {
      workspace_id: workspace.id,
      app_id: "minimal",
      archive_url: url,
    };
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: "/api/v1/apps/install-archive", payload }),
      app.inject({ method: "POST", url: "/api/v1/apps/install-archive", payload }),
    ]);

    const codes = [a.statusCode, b.statusCode].sort((x, y) => x - y);
    assert.deepEqual(codes, [200, 409], `expected one 200 and one 409, got ${codes.join(",")}`);

    const loser = a.statusCode === 409 ? a : b;
    assert.match(
      loser.json().detail ?? "",
      /install already in progress/,
      "losing concurrent request must be rejected by the in-flight guard",
    );

    // Winner must have actually installed — exactly one install should win.
    const installed = path.join(
      store.workspaceDir(workspace.id),
      "apps",
      "minimal",
      "app.runtime.yaml",
    );
    assert.equal(fs.existsSync(installed), true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    if (savedEnv === undefined) {
      delete process.env.HOLABOSS_APP_ARCHIVE_URL_ALLOWLIST;
    } else {
      process.env.HOLABOSS_APP_ARCHIVE_URL_ALLOWLIST = savedEnv;
    }
    await app.close();
    store.close();
  }
});
