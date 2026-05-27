import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import { buildAgentCapabilityManifest } from "./agent-capability-registry.js";
import type { AgentRuntimeConfigCliRequest } from "./agent-runtime-config.js";
import {
  decodeTsRunnerRequest,
  validateTsRunnerRequest,
} from "./ts-runner-contracts.js";
import type { TsRunnerEvent, TsRunnerRequest } from "./ts-runner-contracts.js";
import {
  relayTsRunnerEvent,
  resolvedApplicationMcpHeaders,
  resolveTsRunnerBootstrapState,
  runTsRunnerCli,
  type TsRunnerExecutionDeps,
} from "./ts-runner.js";
import { rebuildInteractionEntityTree } from "./interaction-memory.js";
import {
  requireRuntimeHarnessAdapter,
  type RuntimeHarnessPlugin,
} from "./harness-registry.js";
import {
  persistWorkspaceHarnessSessionId,
  readWorkspaceHarnessSessionId,
} from "./ts-runner-session-state.js";
import {
  globalMemoryDirForWorkspaceRoot,
  workspaceMemoryDir,
} from "./workspace-bundle-paths.js";

const ORIGINAL_SANDBOX_ROOT = process.env.HB_SANDBOX_ROOT;
const ORIGINAL_EMBEDDED_SKILLS_DIR = process.env.HOLABOSS_EMBEDDED_SKILLS_DIR;
const ORIGINAL_SANDBOX_RUNTIME_API_URL = process.env.SANDBOX_RUNTIME_API_URL;
const ORIGINAL_SANDBOX_RUNTIME_API_HOST = process.env.SANDBOX_RUNTIME_API_HOST;
const ORIGINAL_SANDBOX_RUNTIME_API_PORT = process.env.SANDBOX_RUNTIME_API_PORT;
const ORIGINAL_MODEL_PROXY_BASE_URL = process.env.HOLABOSS_MODEL_PROXY_BASE_URL;
const ORIGINAL_RUNTIME_CONFIG_PATH = process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
const ORIGINAL_SANDBOX_AUTH_TOKEN = process.env.HOLABOSS_SANDBOX_AUTH_TOKEN;
const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  if (ORIGINAL_SANDBOX_ROOT === undefined) {
    delete process.env.HB_SANDBOX_ROOT;
  } else {
    process.env.HB_SANDBOX_ROOT = ORIGINAL_SANDBOX_ROOT;
  }

  if (ORIGINAL_EMBEDDED_SKILLS_DIR === undefined) {
    delete process.env.HOLABOSS_EMBEDDED_SKILLS_DIR;
  } else {
    process.env.HOLABOSS_EMBEDDED_SKILLS_DIR = ORIGINAL_EMBEDDED_SKILLS_DIR;
  }

  if (ORIGINAL_SANDBOX_RUNTIME_API_URL === undefined) {
    delete process.env.SANDBOX_RUNTIME_API_URL;
  } else {
    process.env.SANDBOX_RUNTIME_API_URL = ORIGINAL_SANDBOX_RUNTIME_API_URL;
  }

  if (ORIGINAL_SANDBOX_RUNTIME_API_HOST === undefined) {
    delete process.env.SANDBOX_RUNTIME_API_HOST;
  } else {
    process.env.SANDBOX_RUNTIME_API_HOST = ORIGINAL_SANDBOX_RUNTIME_API_HOST;
  }

  if (ORIGINAL_SANDBOX_RUNTIME_API_PORT === undefined) {
    delete process.env.SANDBOX_RUNTIME_API_PORT;
  } else {
    process.env.SANDBOX_RUNTIME_API_PORT = ORIGINAL_SANDBOX_RUNTIME_API_PORT;
  }

  if (ORIGINAL_MODEL_PROXY_BASE_URL === undefined) {
    delete process.env.HOLABOSS_MODEL_PROXY_BASE_URL;
  } else {
    process.env.HOLABOSS_MODEL_PROXY_BASE_URL = ORIGINAL_MODEL_PROXY_BASE_URL;
  }

  if (ORIGINAL_RUNTIME_CONFIG_PATH === undefined) {
    delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  } else {
    process.env.HOLABOSS_RUNTIME_CONFIG_PATH = ORIGINAL_RUNTIME_CONFIG_PATH;
  }

  if (ORIGINAL_SANDBOX_AUTH_TOKEN === undefined) {
    delete process.env.HOLABOSS_SANDBOX_AUTH_TOKEN;
  } else {
    process.env.HOLABOSS_SANDBOX_AUTH_TOKEN = ORIGINAL_SANDBOX_AUTH_TOKEN;
  }

  globalThis.fetch = ORIGINAL_FETCH;
});

function encodeRequest(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

function setTempSandboxRoot(prefix: string): string {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  return sandboxRoot;
}

function writeMemoryFile(
  workspaceRoot: string,
  relPath: string,
  content: string,
): void {
  const normalized = relPath.replaceAll("\\", "/").replace(/^\/+/, "");
  const match = /^workspace\/([^/]+)\/(.+)$/.exec(normalized);
  const absPath = match
    ? path.join(workspaceMemoryDir(path.join(workspaceRoot, match[1])), match[2])
    : path.join(globalMemoryDirForWorkspaceRoot(workspaceRoot), ...normalized.split("/"));
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, "utf8");
}

function seedInteractionEntity(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  entityId: string;
  entityType: "project" | "workflow" | "preference" | "identity" | "person" | "customer" | "system" | "misc";
  canonicalName: string;
  slug: string;
  summary?: string | null;
  isSystem?: boolean;
}): void {
  params.store.upsertInteractionEntity({
    workspaceId: params.workspaceId,
    entityId: params.entityId,
    entityType: params.entityType,
    canonicalName: params.canonicalName,
    slug: params.slug,
    summary: params.summary ?? null,
    aliases: [],
    isSystem: params.isSystem ?? false,
    status: "active",
  });
}

function seedInteractionLeaf(params: {
  store: RuntimeStateStore;
  workspaceRoot: string;
  workspaceId: string;
  entityId: string;
  entitySlug: string;
  leafId: string;
  title: string;
  summary: string;
  content: string;
  subjectKey: string;
  sourceType?: string | null;
  observedAt?: string | null;
}): void {
  const relativePath = `workspace/${params.workspaceId}/interaction/entities/${params.entitySlug}/leaves/${params.leafId}.md`;
  params.store.upsertInteractionLeaf({
    workspaceId: params.workspaceId,
    leafId: params.leafId,
    entityId: params.entityId,
    subjectKey: params.subjectKey,
    path: relativePath,
    title: params.title,
    summary: params.summary,
    fingerprint: `fingerprint-${params.leafId}`,
    bodySha256: `sha-${params.leafId}`,
    tags: [],
    secondaryEntityIds: [],
    sourceType: params.sourceType ?? null,
    sourceEventId: null,
    sourceMessageId: null,
    sourceTurnInputId: "input-seed",
    admissionConfidence: 0.9,
    entityConfidence: 0.9,
    observedAt: params.observedAt ?? "2026-01-01T00:00:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  writeMemoryFile(params.workspaceRoot, relativePath, params.content);
}

function installMockRecallModelResponses(
  responses: Array<Record<string, unknown>>,
  requests?: Array<Record<string, unknown>>,
): void {
  process.env.HOLABOSS_MODEL_PROXY_BASE_URL = "http://127.0.0.1:4999";
  process.env.HOLABOSS_SANDBOX_AUTH_TOKEN = "test-token";
  let callIndex = 0;
  globalThis.fetch = (async (_input, init) => {
    if (requests && typeof init?.body === "string") {
      requests.push(JSON.parse(init.body) as Record<string, unknown>);
    }
    const payload = responses[Math.min(callIndex, responses.length - 1)] ?? {};
    callIndex += 1;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify(payload),
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
}

function baseRequest(): TsRunnerRequest {
  return {
    workspace_id: "workspace-1",
    session_id: "session-1",
    session_kind: "main_session",
    input_id: "input-1",
    instruction: "hello world",
    context: {},
    model: null,
    debug: false,
  };
}

function writeSessionMemory(params: {
  sandboxRoot: string;
  workspaceId: string;
  sessionId: string;
  content: string;
}): string {
  const targetPath = path.join(
    params.sandboxRoot,
    "workspace",
    "memory",
    "workspace",
    params.workspaceId,
    "runtime",
    "session-memory",
    `${params.sessionId}.md`,
  );
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${params.content}\n`, "utf8");
  return targetPath;
}

function baseCompiledPlan() {
  return {
    workspace_id: "workspace-1",
    mode: "single",
    general_config: {
      type: "single",
      agent: {
        id: "main",
        model: "openai/gpt-5.4",
        prompt: "You are concise.",
        role: null,
      },
    },
    schema_aliases: {},
    resolved_prompts: { main: "You are concise." },
    resolved_mcp_servers: [],
    resolved_mcp_tool_refs: [],
    workspace_mcp_catalog: [],
    config_checksum: "checksum-1",
    resolved_applications: [],
    mcp_tool_allowlist: [],
  } as const;
}

function testDeps(
  params: {
    harnessEvents?: TsRunnerEvent[];
    harnessResult?: Partial<
      Awaited<ReturnType<NonNullable<TsRunnerExecutionDeps["runHarnessHost"]>>>
    >;
    pluginOverrides?: Partial<RuntimeHarnessPlugin>;
  } = {},
): Partial<TsRunnerExecutionDeps> {
  const harnessEvents = params.harnessEvents ?? [];
  const buildPlugin = (harness: string): RuntimeHarnessPlugin => ({
    id: harness,
    adapter: requireRuntimeHarnessAdapter(harness),
    stageBrowserTools: () => ({ changed: false, toolIds: [] }),
    stageRuntimeTools: () => ({ changed: false, toolIds: [] }),
    stageSkills: () => ({ changed: false, skillIds: [] }),
    stageCommands: () => ({ changed: false, commandIds: [] }),
    prepareRun: async () => {},
    describeRuntimeStatus: async () => ({
      backendConfigPresent: false,
      harnessStatus: { ready: true, state: "ready" },
    }),
    handleRuntimeConfigUpdated: async () => {},
    ensureReady: async () => {},
    backendBaseUrl: () => "http://127.0.0.1:4096",
    timeoutSeconds: () => 1800,
    ...params.pluginOverrides,
  });
  return {
    compilePlan: () => baseCompiledPlan() as never,
    startWorkspaceMcpSidecar: async () => null,
    bootstrapApplications: async () => [],
    loadOperatorSurfaceContext: async () => null,
    projectAgentRuntimeConfig: () => ({
      provider_id: "openai",
      model_id: "gpt-5.4",
      mode: "code",
      system_prompt: "You are concise.",
      model_client: {
        model_proxy_provider: "openai_compatible",
        api_key: "token",
        base_url: "http://127.0.0.1:4000/openai/v1",
        default_headers: { "X-Test": "1" },
      },
      tools: { read: true },
      workspace_tool_ids: [],
      workspace_skill_ids: [],
      output_schema_member_id: null,
      output_format: null,
      workspace_config_checksum: "checksum-1",
    }),
    resolveHarnessPlugin: (harness) => buildPlugin(harness),
    runHarnessHost: async ({ emitEvent }) => {
      for (const event of harnessEvents) {
        await emitEvent(event);
      }
      return {
        exitCode: 0,
        stderr: "",
        sawEvent: harnessEvents.length > 0,
        terminalEmitted: harnessEvents.some((event) =>
          ["run_completed", "run_failed"].includes(event.event_type),
        ),
        lastSequence: harnessEvents.reduce(
          (max, event) => Math.max(max, event.sequence),
          0,
        ),
        ...params.harnessResult,
      };
    },
  };
}

test("decodeTsRunnerRequest decodes a valid runner request", () => {
  const request = decodeTsRunnerRequest(
    encodeRequest({
      holaboss_user_id: "user-1",
      workspace_id: "workspace-1",
      session_id: "session-1",
      input_id: "input-1",
      instruction: "hello",
      context: { k: "v" },
      model: "openai/gpt-5.4",
      debug: true,
    }),
  );

  assert.deepEqual(request, {
    holaboss_user_id: "user-1",
    workspace_id: "workspace-1",
    session_id: "session-1",
    session_kind: null,
    input_id: "input-1",
    instruction: "hello",
    attachments: [],
    image_urls: [],
    context: { k: "v" },
    model: "openai/gpt-5.4",
    thinking_value: null,
    debug: true,
  });
});

test("decodeTsRunnerRequest preserves the selected thinking value", () => {
  const request = decodeTsRunnerRequest(
    encodeRequest({
      workspace_id: "workspace-1",
      session_id: "session-1",
      input_id: "input-1",
      instruction: "hello",
      context: {},
      thinking_value: "medium",
    }),
  );

  assert.equal(request.thinking_value, "medium");
});

test("validateTsRunnerRequest rejects missing required fields", () => {
  assert.throws(
    () =>
      validateTsRunnerRequest({
        workspace_id: "workspace-1",
        session_id: "session-1",
        instruction: "hello",
        context: {},
      }),
    /input_id is required/,
  );
});

test("resolveTsRunnerBootstrapState ignores workspace persisted harness session when explicit session id is requested", () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-bootstrap-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  const workspaceDir = path.join(sandboxRoot, "workspace", "workspace-1");
  fs.mkdirSync(path.join(workspaceDir, ".holaboss"), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, ".holaboss", "harness-session-state.json"),
    JSON.stringify({
      version: 1,
      harness: "pi",
      main_session_id: "persisted-session-1",
    }),
    "utf8",
  );

  const bootstrap = resolveTsRunnerBootstrapState({
    workspace_id: "workspace-1",
    session_id: "session-1",
    input_id: "input-1",
    instruction: "hello",
    context: {
      _sandbox_runtime_exec_v1: {
        harness: "pi",
        harness_session_id: "requested-session-1",
      },
    },
    model: null,
    debug: false,
  });

  assert.equal(bootstrap.workspaceDir, workspaceDir);
  assert.equal(bootstrap.harness, "pi");
  assert.equal(bootstrap.requestedHarnessSessionId, "requested-session-1");
  assert.equal(bootstrap.persistedHarnessSessionId, null);
});

test("resolveTsRunnerBootstrapState uses the registered custom workspace path without cross-session persisted fallback", () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-custom-bootstrap-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  const workspaceRoot = path.join(sandboxRoot, "workspace");
  const customRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-custom-workspace-"),
  );
  const customWorkspaceDir = path.join(customRoot, "workspace");
  const store = new RuntimeStateStore({
    workspaceRoot,
    sandboxRoot,
  });
  try {
    store.createWorkspace({
      workspaceId: "workspace-1",
      name: "Custom Workspace",
      harness: "pi",
      workspacePath: customWorkspaceDir,
    });
  } finally {
    store.close();
  }
  fs.mkdirSync(path.join(customWorkspaceDir, ".holaboss"), { recursive: true });
  fs.writeFileSync(
    path.join(customWorkspaceDir, ".holaboss", "harness-session-state.json"),
    JSON.stringify({
      version: 1,
      harness: "pi",
      main_session_id: "persisted-custom-session",
    }),
    "utf8",
  );

  const bootstrap = resolveTsRunnerBootstrapState({
    workspace_id: "workspace-1",
    session_id: "session-1",
    input_id: "input-1",
    instruction: "hello",
    context: {
      _sandbox_runtime_exec_v1: {
        harness: "pi",
        harness_session_id: "requested-custom-session",
      },
    },
    model: null,
    debug: false,
  });

  assert.equal(bootstrap.workspaceRoot, workspaceRoot);
  assert.equal(bootstrap.workspaceDir, customWorkspaceDir);
  assert.equal(bootstrap.harness, "pi");
  assert.equal(bootstrap.requestedHarnessSessionId, "requested-custom-session");
  assert.equal(bootstrap.persistedHarnessSessionId, null);
});

test("resolveTsRunnerBootstrapState loads workspace persisted harness session only without an explicit session id", () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-persisted-bootstrap-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  const workspaceDir = path.join(sandboxRoot, "workspace", "workspace-1");
  fs.mkdirSync(path.join(workspaceDir, ".holaboss"), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, ".holaboss", "harness-session-state.json"),
    JSON.stringify({
      version: 1,
      harness: "pi",
      main_session_id: "persisted-session-1",
    }),
    "utf8",
  );

  const bootstrap = resolveTsRunnerBootstrapState({
    workspace_id: "workspace-1",
    session_id: "session-1",
    input_id: "input-1",
    instruction: "hello",
    context: {
      _sandbox_runtime_exec_v1: {
        harness: "pi",
      },
    },
    model: null,
    debug: false,
  });

  assert.equal(bootstrap.workspaceDir, workspaceDir);
  assert.equal(bootstrap.harness, "pi");
  assert.equal(bootstrap.requestedHarnessSessionId, null);
  assert.equal(bootstrap.persistedHarnessSessionId, "persisted-session-1");
});

test("relayTsRunnerEvent persists harness_session_id from terminal events", async () => {
  const workspaceDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-relay-"),
  );
  const emitted: Array<{
    event_type: string;
    payload: Record<string, unknown>;
  }> = [];

  await relayTsRunnerEvent({
    harness: "pi",
    workspaceDir,
    event: {
      session_id: "session-1",
      input_id: "input-1",
      sequence: 4,
      event_type: "run_completed",
      timestamp: new Date().toISOString(),
      payload: {
        status: "success",
        harness_session_id: "persisted-session-2",
      },
    },
    emitEvent: async (event) => {
      emitted.push({
        event_type: event.event_type,
        payload: event.payload,
      });
    },
  });

  assert.equal(emitted.length, 1);
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(
        path.join(workspaceDir, ".holaboss", "state", "harness-session-state.json"),
        "utf8",
      ),
    ),
    {
      version: 2,
      harness_sessions: {
        pi: {
          session_id: "persisted-session-2",
        },
      },
    },
  );
});

test("relayTsRunnerEvent clears persisted harness session ids after run_failed", async () => {
  const workspaceDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-relay-clear-"),
  );
  persistWorkspaceHarnessSessionId({
    workspaceDir,
    harness: "pi",
    sessionId: "persisted-session-2",
  });

  await relayTsRunnerEvent({
    harness: "pi",
    workspaceDir,
    event: {
      session_id: "session-1",
      input_id: "input-1",
      sequence: 4,
      event_type: "run_failed",
      timestamp: new Date().toISOString(),
      payload: {
        type: "OpenCodeSessionError",
        message: "boom",
        harness_session_id: "failed-session-1",
      },
    },
    emitEvent: async () => {},
  });

  assert.equal(
    readWorkspaceHarnessSessionId({ workspaceDir, harness: "pi" }),
    null,
  );
});

test("relayTsRunnerEvent skips harness-session-state writes for ephemeral harness runs", async () => {
  const workspaceDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-relay-ephemeral-"),
  );

  await relayTsRunnerEvent({
    harness: "pi",
    workspaceDir,
    persistHarnessSessionState: false,
    event: {
      session_id: "session-1",
      input_id: "input-1",
      sequence: 4,
      event_type: "run_completed",
      timestamp: new Date().toISOString(),
      payload: {
        status: "success",
        harness_session_id: "snapshot-session",
      },
    },
    emitEvent: async () => {},
  });

  assert.equal(
    readWorkspaceHarnessSessionId({ workspaceDir, harness: "pi" }),
    null,
  );
});

test("relayTsRunnerEvent skips harness-session-state clears for ephemeral harness runs", async () => {
  const workspaceDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-relay-ephemeral-failed-"),
  );
  persistWorkspaceHarnessSessionId({
    workspaceDir,
    harness: "pi",
    sessionId: "live-session",
  });

  await relayTsRunnerEvent({
    harness: "pi",
    workspaceDir,
    persistHarnessSessionState: false,
    event: {
      session_id: "session-1",
      input_id: "input-1",
      sequence: 4,
      event_type: "run_failed",
      timestamp: new Date().toISOString(),
      payload: {
        type: "OpenCodeSessionError",
        message: "boom",
        harness_session_id: "snapshot-session",
      },
    },
    emitEvent: async () => {},
  });

  assert.equal(
    readWorkspaceHarnessSessionId({ workspaceDir, harness: "pi" }),
    "live-session",
  );
});

test("runTsRunnerCli relays harness-host events after run_claimed", async () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-success-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  let stdout = "";
  let stderr = "";
  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        context: {
          _sandbox_runtime_exec_v1: {
            harness: "pi",
          },
        },
      }),
    ],
    {
      deps: testDeps({
        harnessEvents: [
          {
            session_id: "session-1",
            input_id: "input-1",
            sequence: 1,
            event_type: "run_started",
            timestamp: new Date().toISOString(),
            payload: { phase: "running" },
          },
          {
            session_id: "session-1",
            input_id: "input-1",
            sequence: 2,
            event_type: "run_completed",
            timestamp: new Date().toISOString(),
            payload: {
              status: "success",
              harness_session_id: "persisted-session-3",
            },
          },
        ],
      }),
      io: {
        stdout: {
          write(chunk: string) {
            stdout += chunk;
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write(chunk: string) {
            stderr += chunk;
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(stderr, "");

  const lines = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 3);
  assert.equal(lines[0].event_type, "run_claimed");
  assert.equal(lines[0].payload.instruction_preview, "hello world");
  assert.equal(lines[1].event_type, "run_started");
  assert.equal(lines[1].payload.phase, "running");
  assert.equal(lines[2].event_type, "run_completed");
  assert.equal(lines[2].payload.status, "success");
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(
        path.join(
          sandboxRoot,
          "workspace",
          "workspace-1",
          ".holaboss",
          "state",
          "harness-session-state.json",
        ),
        "utf8",
      ),
    ),
    {
      version: 2,
      harness_sessions: {
        pi: {
          session_id: "persisted-session-3",
        },
      },
    },
  );
});

test("runTsRunnerCli persists pi harness session ids when runtime context selects pi", async () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-pi-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  let stdout = "";
  let capturedHarness = "";

  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        context: {
          _sandbox_runtime_exec_v1: {
            harness: "pi",
          },
        },
      }),
    ],
    {
      deps: {
        ...testDeps({
          harnessEvents: [
            {
              session_id: "session-1",
              input_id: "input-1",
              sequence: 1,
              event_type: "run_started",
              timestamp: new Date().toISOString(),
              payload: { phase: "running" },
            },
            {
              session_id: "session-1",
              input_id: "input-1",
              sequence: 2,
              event_type: "run_completed",
              timestamp: new Date().toISOString(),
              payload: {
                status: "success",
                harness_session_id: "/tmp/pi-session.jsonl",
              },
            },
          ],
        }),
        runHarnessHost: async ({ harness, emitEvent }) => {
          capturedHarness = harness;
          await emitEvent({
            session_id: "session-1",
            input_id: "input-1",
            sequence: 1,
            event_type: "run_started",
            timestamp: new Date().toISOString(),
            payload: { phase: "running" },
          });
          await emitEvent({
            session_id: "session-1",
            input_id: "input-1",
            sequence: 2,
            event_type: "run_completed",
            timestamp: new Date().toISOString(),
            payload: {
              status: "success",
              harness_session_id: "/tmp/pi-session.jsonl",
            },
          });
          return {
            exitCode: 0,
            stderr: "",
            sawEvent: true,
            terminalEmitted: true,
            lastSequence: 2,
          };
        },
      },
      io: {
        stdout: {
          write(chunk: string) {
            stdout += chunk;
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(capturedHarness, "pi");
  assert.equal(stdout.trim().split("\n").length, 3);
  assert.deepEqual(
    JSON.parse(
      fs.readFileSync(
        path.join(
          sandboxRoot,
          "workspace",
          "workspace-1",
          ".holaboss",
          "state",
          "harness-session-state.json",
        ),
        "utf8",
      ),
    ),
    {
      version: 2,
      harness_sessions: {
        pi: {
          session_id: "/tmp/pi-session.jsonl",
        },
      },
    },
  );
});

test("runTsRunnerCli passes MCP servers and tool refs into the pi harness request for subagent sessions", async () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-pi-mcp-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  let capturedRequestPayload: Record<string, unknown> | null = null;

  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        session_kind: "subagent",
        context: {
          _sandbox_runtime_exec_v1: {
            harness: "pi",
          },
        },
      }),
    ],
    {
      deps: {
        ...testDeps(),
        compilePlan: () =>
          ({
            ...baseCompiledPlan(),
            resolved_mcp_servers: [
              {
                server_id: "docs",
                type: "remote",
                url: "http://127.0.0.1:9200/mcp",
                headers: [],
                environment: [],
                timeout_ms: 25000,
                enabled: true,
                command: [],
              },
            ],
            resolved_mcp_tool_refs: [
              {
                tool_id: "docs.lookup",
                server_id: "docs",
                tool_name: "lookup",
              },
            ],
          }) as never,
        runHarnessHost: async ({ requestPayload }) => {
          capturedRequestPayload = requestPayload;
          return {
            exitCode: 0,
            stderr: "",
            sawEvent: false,
            terminalEmitted: false,
            lastSequence: 0,
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedRequestPayload);
  assert.deepEqual(
    (capturedRequestPayload as { mcp_servers: Array<Record<string, unknown>> })
      .mcp_servers,
    [
      {
        name: "docs",
        config: {
          type: "remote",
          enabled: true,
          url: "http://127.0.0.1:9200/mcp",
          headers: {},
          timeout: 25000,
        },
      },
    ],
  );
  assert.deepEqual(
    (
      capturedRequestPayload as {
        mcp_tool_refs: Array<Record<string, unknown>>;
      }
    ).mcp_tool_refs,
    [
      {
        tool_id: "docs.lookup",
        server_id: "docs",
        tool_name: "lookup",
      },
    ],
  );
});

test("runTsRunnerCli only advertises structured output when the selected harness supports it", async () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-pi-structured-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  process.env.SANDBOX_RUNTIME_API_HOST = "127.0.0.1";
  process.env.SANDBOX_RUNTIME_API_PORT = "5060";
  let capturedRequestPayload: Record<string, unknown> | null = null;
  const capabilityManifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "main_session",
    defaultTools: ["read"],
    extraTools: [],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
  });

  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        context: {
          _sandbox_runtime_exec_v1: {
            harness: "pi",
          },
        },
      }),
    ],
    {
      deps: {
        ...testDeps(),
        projectAgentRuntimeConfig: () => ({
          provider_id: "openai",
          model_id: "gpt-5.4",
          mode: "code",
          system_prompt: "You are concise.",
          prompt_sections: [
            {
              id: "runtime_core",
              channel: "system_prompt",
              apply_at: "runtime_config",
              precedence: "base_runtime",
              priority: 100,
              volatility: "stable",
              content: "You are concise.",
            },
            {
              id: "execution_policy",
              channel: "system_prompt",
              apply_at: "runtime_config",
              precedence: "base_runtime",
              priority: 200,
              volatility: "stable",
              content: "Inspect before mutating.",
            },
            {
              id: "session_policy",
              channel: "system_prompt",
              apply_at: "runtime_config",
              precedence: "session_policy",
              priority: 300,
              volatility: "run",
              content: "This is the main session.",
            },
            {
              id: "capability_policy",
              channel: "system_prompt",
              apply_at: "runtime_config",
              precedence: "capability_policy",
              priority: 400,
              volatility: "run",
              content: "Use available tools.",
            },
          ],
          model_client: {
            model_proxy_provider: "openai_compatible",
            api_key: "token",
            base_url: "http://127.0.0.1:4000/openai/v1",
            default_headers: { "X-Test": "1" },
          },
          tools: { read: true },
          workspace_tool_ids: [],
          workspace_skill_ids: [],
          capability_manifest: capabilityManifest,
          output_schema_member_id: "main",
          output_format: { type: "json_schema", schema: { type: "object" } },
          workspace_config_checksum: "checksum-1",
        }),
        runHarnessHost: async ({ requestPayload }) => {
          capturedRequestPayload = requestPayload;
          return {
            exitCode: 0,
            stderr: "",
            sawEvent: false,
            terminalEmitted: false,
            lastSequence: 0,
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedRequestPayload);
  assert.equal(
    (capturedRequestPayload as { runtime_api_base_url?: string | null })
      .runtime_api_base_url,
    "http://127.0.0.1:5060",
  );
  const runStartedPayload = (
    capturedRequestPayload as { run_started_payload: Record<string, unknown> }
  ).run_started_payload;
  assert.deepEqual(
    {
      instruction_preview: runStartedPayload.instruction_preview,
      provider_id: runStartedPayload.provider_id,
      model_id: runStartedPayload.model_id,
      workspace_tool_ids: runStartedPayload.workspace_tool_ids,
      workspace_skill_ids: runStartedPayload.workspace_skill_ids,
      prompt_section_ids: runStartedPayload.prompt_section_ids,
      request_snapshot_fingerprint:
        runStartedPayload.request_snapshot_fingerprint,
      capability_manifest_fingerprint:
        runStartedPayload.capability_manifest_fingerprint,
      mcp_server_ids: runStartedPayload.mcp_server_ids,
      mcp_server_mappings: runStartedPayload.mcp_server_mappings,
      workspace_mcp_sidecar_reused:
        runStartedPayload.workspace_mcp_sidecar_reused,
      structured_output_enabled: runStartedPayload.structured_output_enabled,
      workspace_config_checksum: runStartedPayload.workspace_config_checksum,
    },
    {
      instruction_preview: "hello world",
      provider_id: "openai",
      model_id: "gpt-5.4",
      workspace_tool_ids: [],
      workspace_skill_ids: [],
      prompt_section_ids: [
        "runtime_core",
        "execution_policy",
        "session_policy",
        "capability_policy",
      ],
      request_snapshot_fingerprint:
        runStartedPayload.request_snapshot_fingerprint,
      capability_manifest_fingerprint:
        runStartedPayload.capability_manifest_fingerprint,
      mcp_server_ids: [],
      mcp_server_mappings: [],
      workspace_mcp_sidecar_reused: false,
      structured_output_enabled: false,
      workspace_config_checksum: "checksum-1",
    },
  );
  assert.equal(typeof runStartedPayload.bootstrap_started_at, "string");
  assert.equal(typeof runStartedPayload.bootstrap_ready_at, "string");
  assert.equal(typeof runStartedPayload.bootstrap_total_ms, "number");
  assert.ok((runStartedPayload.bootstrap_total_ms as number) >= 0);
  assert.match(
    String(runStartedPayload.request_snapshot_fingerprint ?? ""),
    /^[a-f0-9]{64}$/,
  );
  assert.match(
    String(runStartedPayload.capability_manifest_fingerprint ?? ""),
    /^[a-f0-9]{64}$/,
  );
  const bootstrapStageTimingKeys = Object.keys(
    (runStartedPayload.bootstrap_stage_timings_ms as Record<string, unknown>) ??
      {},
  ).sort();
  assert.deepEqual(bootstrapStageTimingKeys, [
    "build_harness_host_request",
    "compile_runtime_plan",
    "load_current_user_context",
    "load_operator_surface_context",
    "load_pending_user_memory_context",
    "load_recalled_memory_context",
    "load_recent_runtime_context",
    "load_session_attachment_context",
    "persist_turn_request_snapshot",
    "prepare_harness_run",
    "project_runtime_config",
    "resolve_workspace_skills",
    "stage_browser_tools",
    "stage_delegated_browser_tools",
    "stage_runtime_tools",
  ]);
});

test("runTsRunnerCli loads current user context from the runtime profile", async () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-current-user-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  const workspaceRoot = path.join(sandboxRoot, "workspace");
  const store = new RuntimeStateStore({
    workspaceRoot,
    sandboxRoot,
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.upsertRuntimeUserProfile({
    name: "Jeffrey",
    nameSource: "manual",
  });
  store.close();

  let capturedProjectRequest: AgentRuntimeConfigCliRequest | null = null;
  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        instruction: "Draft the email and sign with my name.",
      }),
    ],
    {
      deps: {
        ...testDeps({
          pluginOverrides: {
            stageRuntimeTools: () => ({
              changed: false,
              toolIds: ["delegate_task"],
            }),
          },
        }),
        projectAgentRuntimeConfig: (request) => {
          capturedProjectRequest = request;
          return {
            provider_id: "openai",
            model_id: "gpt-5.4",
            mode: "code",
            system_prompt: "You are concise.",
            model_client: {
              model_proxy_provider: "openai_compatible",
              api_key: "token",
              base_url: "http://127.0.0.1:4000/openai/v1",
              default_headers: { "X-Test": "1" },
            },
            tools: { read: true },
            workspace_tool_ids: [],
            workspace_skill_ids: [],
            output_schema_member_id: null,
            output_format: null,
            workspace_config_checksum: "checksum-1",
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedProjectRequest);
  assert.deepEqual(
    (
      capturedProjectRequest as {
        current_user_context: Record<string, unknown>;
      }
    ).current_user_context,
    {
      profile_id: "default",
      name: "Jeffrey",
      name_source: "manual",
    },
  );
});

test("runTsRunnerCli strips subagent orchestration tools from onboarding sessions", async () => {
  setTempSandboxRoot("hb-ts-runner-onboarding-tools-");
  let capturedProjectRequest: AgentRuntimeConfigCliRequest | null = null;

  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        session_kind: "onboarding",
      }),
    ],
    {
      deps: {
        ...testDeps({
          pluginOverrides: {
            stageBrowserTools: () => ({
              changed: false,
              toolIds: ["browser_get_state"],
            }),
            stageRuntimeTools: () => ({
              changed: false,
              toolIds: [
                "delegate_task",
                "get_subagent",
                "list_background_tasks",
                "cancel_subagent",
                "resume_subagent",
                "continue_subagent",
                "holaboss_onboarding_complete",
              ],
            }),
          },
        }),
        projectAgentRuntimeConfig: (request) => {
          capturedProjectRequest = request;
          return {
            provider_id: "openai",
            model_id: "gpt-5.4",
            mode: "code",
            system_prompt: "You are concise.",
            model_client: {
              model_proxy_provider: "openai_compatible",
              api_key: "token",
              base_url: "http://127.0.0.1:4000/openai/v1",
              default_headers: { "X-Test": "1" },
            },
            tools: { read: true },
            workspace_tool_ids: [],
            workspace_skill_ids: [],
            output_schema_member_id: null,
            output_format: null,
            workspace_config_checksum: "checksum-1",
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedProjectRequest);
  assert.equal(
    (capturedProjectRequest as { session_kind: string | null }).session_kind,
    "onboarding",
  );
  assert.deepEqual(
    (capturedProjectRequest as { browser_tool_ids: string[] }).browser_tool_ids,
    [],
  );
  assert.deepEqual(
    (capturedProjectRequest as { runtime_tool_ids: string[] }).runtime_tool_ids,
    ["holaboss_onboarding_complete"],
  );
  assert.deepEqual(
    (capturedProjectRequest as { extra_tools: string[] }).extra_tools,
    ["holaboss_onboarding_complete"],
  );
  assert.equal(
    "delegated_session_kind" in (capturedProjectRequest as Record<string, unknown>),
    false,
  );
});

test("runTsRunnerCli keeps staged execution tools on front-of-house workspace sessions", async () => {
  setTempSandboxRoot("hb-ts-runner-runtime-tools-");
  let capturedProjectRequest: AgentRuntimeConfigCliRequest | null = null;

  const exitCode = await runTsRunnerCli(
    ["--request-base64", encodeRequest(baseRequest())],
    {
      deps: {
        ...testDeps({
          pluginOverrides: {
            stageBrowserTools: ({ sessionKind }) => ({
              changed: false,
              toolIds:
                sessionKind === "main_session" || sessionKind === "subagent"
                  ? ["browser_get_state"]
                  : [],
            }),
            stageRuntimeTools: () => ({
              changed: false,
              toolIds: ["holaboss_onboarding_complete", "write_report"],
            }),
          },
        }),
        projectAgentRuntimeConfig: (request) => {
          capturedProjectRequest = request;
          return {
            provider_id: "openai",
            model_id: "gpt-5.4",
            mode: "code",
            system_prompt: "You are concise.",
            model_client: {
              model_proxy_provider: "openai_compatible",
              api_key: "token",
              base_url: "http://127.0.0.1:4000/openai/v1",
              default_headers: { "X-Test": "1" },
            },
            tools: { read: true },
            workspace_tool_ids: [],
            workspace_skill_ids: [],
            output_schema_member_id: null,
            output_format: null,
            workspace_config_checksum: "checksum-1",
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedProjectRequest);
  assert.equal(
    (capturedProjectRequest as { browser_tools_available: boolean })
      .browser_tools_available,
    true,
  );
  assert.deepEqual(
    (capturedProjectRequest as { browser_tool_ids: string[] }).browser_tool_ids,
    ["browser_get_state"],
  );
  assert.deepEqual(
    (capturedProjectRequest as { runtime_tool_ids: string[] }).runtime_tool_ids,
    ["holaboss_onboarding_complete", "write_report"],
  );
  assert.deepEqual(
    (capturedProjectRequest as { default_tools: string[] }).default_tools,
    [
      "read",
      "edit",
      "bash",
      "grep",
      "glob",
      "list",
      "question",
      "todowrite",
      "todoread",
      "skill",
    ],
  );
  assert.equal(
    "session_scratchpad_context" in (capturedProjectRequest as Record<string, unknown>),
    false,
  );
  assert.deepEqual(
    (capturedProjectRequest as { extra_tools: string[] }).extra_tools,
    [
      "web_search",
      "browser_get_state",
      "holaboss_onboarding_complete",
      "write_report",
    ],
  );
  assert.equal(
    (capturedProjectRequest as {
      delegated_session_kind?: string | null;
    }).delegated_session_kind,
    "subagent",
  );
  assert.equal(
    (capturedProjectRequest as {
      delegated_browser_tools_available?: boolean | null;
    }).delegated_browser_tools_available,
    true,
  );
  assert.deepEqual(
    (capturedProjectRequest as { delegated_browser_tool_ids?: string[] })
      .delegated_browser_tool_ids,
    ["browser_get_state"],
  );
  assert.deepEqual(
    (capturedProjectRequest as { delegated_runtime_tool_ids?: string[] })
      .delegated_runtime_tool_ids,
    ["holaboss_onboarding_complete", "write_report"],
  );
  assert.deepEqual(
    (capturedProjectRequest as { delegated_default_tools?: string[] })
      .delegated_default_tools,
    [
      "read",
      "edit",
      "bash",
      "grep",
      "glob",
      "list",
      "question",
      "todowrite",
      "todoread",
      "skill",
    ],
  );
  assert.deepEqual(
    (capturedProjectRequest as { delegated_extra_tools?: string[] })
      .delegated_extra_tools,
    [
      "web_search",
      "browser_get_state",
      "holaboss_onboarding_complete",
      "write_report",
    ],
  );
});

test("runTsRunnerCli exposes workspace-instructions updates only to main workspace sessions", async () => {
  setTempSandboxRoot("hb-ts-runner-workspace-instructions-main-");
  let capturedProjectRequest: AgentRuntimeConfigCliRequest | null = null;

  const exitCode = await runTsRunnerCli(
    ["--request-base64", encodeRequest(baseRequest())],
    {
      deps: {
        ...testDeps({
          pluginOverrides: {
            stageRuntimeTools: () => ({
              changed: false,
              toolIds: ["update_workspace_instructions"],
            }),
          },
        }),
        projectAgentRuntimeConfig: (request) => {
          capturedProjectRequest = request;
          return {
            provider_id: "openai",
            model_id: "gpt-5.4",
            mode: "code",
            system_prompt: "You are concise.",
            model_client: {
              model_proxy_provider: "openai_compatible",
              api_key: "token",
              base_url: "http://127.0.0.1:4000/openai/v1",
              default_headers: { "X-Test": "1" },
            },
            tools: { read: true },
            workspace_tool_ids: [],
            workspace_skill_ids: [],
            output_schema_member_id: null,
            output_format: null,
            workspace_config_checksum: "checksum-1",
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedProjectRequest);
  assert.deepEqual(
    (capturedProjectRequest as { runtime_tool_ids: string[] }).runtime_tool_ids,
    ["update_workspace_instructions"],
  );
  assert.deepEqual(
    (capturedProjectRequest as { extra_tools: string[] }).extra_tools,
    ["web_search", "update_workspace_instructions"],
  );
  assert.deepEqual(
    (capturedProjectRequest as { delegated_runtime_tool_ids?: string[] })
      .delegated_runtime_tool_ids,
    ["update_workspace_instructions"],
  );
});

test("runTsRunnerCli keeps workspace-instructions updates out of onboarding sessions", async () => {
  setTempSandboxRoot("hb-ts-runner-workspace-instructions-onboarding-");
  let capturedProjectRequest: AgentRuntimeConfigCliRequest | null = null;

  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        session_kind: "onboarding",
      }),
    ],
    {
      deps: {
        ...testDeps({
          pluginOverrides: {
            stageRuntimeTools: () => ({
              changed: false,
              toolIds: ["update_workspace_instructions"],
            }),
          },
        }),
        projectAgentRuntimeConfig: (request) => {
          capturedProjectRequest = request;
          return {
            provider_id: "openai",
            model_id: "gpt-5.4",
            mode: "code",
            system_prompt: "You are concise.",
            model_client: {
              model_proxy_provider: "openai_compatible",
              api_key: "token",
              base_url: "http://127.0.0.1:4000/openai/v1",
              default_headers: { "X-Test": "1" },
            },
            tools: { read: true },
            workspace_tool_ids: [],
            workspace_skill_ids: [],
            output_schema_member_id: null,
            output_format: null,
            workspace_config_checksum: "checksum-1",
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedProjectRequest);
  assert.deepEqual(
    (capturedProjectRequest as { runtime_tool_ids: string[] }).runtime_tool_ids,
    [],
  );
  assert.deepEqual(
    (capturedProjectRequest as { extra_tools: string[] }).extra_tools,
    [],
  );
});

test("runTsRunnerCli exposes workspace-instructions updates to subagent sessions", async () => {
  setTempSandboxRoot("hb-ts-runner-workspace-instructions-subagent-");
  let capturedProjectRequest: AgentRuntimeConfigCliRequest | null = null;

  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        session_kind: "subagent",
      }),
    ],
    {
      deps: {
        ...testDeps({
          pluginOverrides: {
            stageRuntimeTools: () => ({
              changed: false,
              toolIds: [
                "holaboss_update_workspace_instructions",
                "holaboss_delegate_task",
              ],
            }),
          },
        }),
        projectAgentRuntimeConfig: (request) => {
          capturedProjectRequest = request;
          return {
            provider_id: "openai",
            model_id: "gpt-5.4",
            mode: "code",
            system_prompt: "You are concise.",
            model_client: {
              model_proxy_provider: "openai_compatible",
              api_key: "token",
              base_url: "http://127.0.0.1:4000/openai/v1",
              default_headers: { "X-Test": "1" },
            },
            tools: { read: true },
            workspace_tool_ids: [],
            workspace_skill_ids: [],
            output_schema_member_id: null,
            output_format: null,
            workspace_config_checksum: "checksum-1",
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedProjectRequest);
  assert.deepEqual(
    (capturedProjectRequest as { runtime_tool_ids: string[] }).runtime_tool_ids,
    ["holaboss_update_workspace_instructions", "holaboss_delegate_task"],
  );
  assert.deepEqual(
    (capturedProjectRequest as { extra_tools: string[] }).extra_tools,
    ["web_search", "holaboss_update_workspace_instructions", "holaboss_delegate_task"],
  );
});

test("runTsRunnerCli keeps direct MCP tools on front-session requests", async () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-front-mcp-filter-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  let capturedProjectRequest: AgentRuntimeConfigCliRequest | null = null;

  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        context: {
          _sandbox_runtime_exec_v1: {
            harness: "pi",
          },
        },
      }),
    ],
    {
      deps: {
        ...testDeps(),
        compilePlan: () =>
          ({
            ...baseCompiledPlan(),
            resolved_mcp_tool_refs: [
              {
                tool_id: "docs.lookup",
                server_id: "docs",
                tool_name: "lookup",
              },
              {
                tool_id: "workspace.write_report",
                server_id: "workspace",
                tool_name: "write_report",
              },
            ],
          }) as never,
        projectAgentRuntimeConfig: (request) => {
          capturedProjectRequest = request;
          return {
            provider_id: "openai",
            model_id: "gpt-5.4",
            mode: "code",
            system_prompt: "You are concise.",
            model_client: {
              model_proxy_provider: "openai_compatible",
              api_key: "token",
              base_url: "http://127.0.0.1:4000/openai/v1",
            },
            tools: { read: true },
            workspace_tool_ids: [],
            workspace_skill_ids: [],
            output_schema_member_id: null,
            output_format: null,
            workspace_config_checksum: "checksum-1",
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedProjectRequest);
  assert.deepEqual(
    (
      capturedProjectRequest as {
        resolved_mcp_tool_refs: Array<Record<string, string>>;
      }
    ).resolved_mcp_tool_refs,
    [
      {
        tool_id: "docs.lookup",
        server_id: "docs",
        tool_name: "lookup",
      },
      {
        tool_id: "workspace.write_report",
        server_id: "workspace",
        tool_name: "write_report",
      },
    ],
  );
  assert.deepEqual(
    (
      capturedProjectRequest as {
        delegated_resolved_mcp_tool_refs?: Array<Record<string, string>>;
      }
    ).delegated_resolved_mcp_tool_refs,
    [
      {
        tool_id: "docs.lookup",
        server_id: "docs",
        tool_name: "lookup",
      },
      {
        tool_id: "workspace.write_report",
        server_id: "workspace",
        tool_name: "write_report",
      },
    ],
  );
});

test("runTsRunnerCli does not derive prompt continuity from the latest prior turn result alone", async () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-recent-context-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  const workspaceRoot = path.join(sandboxRoot, "workspace");
  const store = new RuntimeStateStore({
    workspaceRoot,
    sandboxRoot,
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-1",
    inputId: "input-0",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:05.000Z",
    status: "failed",
    stopReason: "permission_denied",
    assistantText: "",
    toolUsageSummary: {
      total_calls: 1,
      completed_calls: 0,
      failed_calls: 1,
      tool_names: ["deploy"],
      tool_ids: ["workspace.deploy"],
    },
    permissionDenials: [
      {
        tool_name: "deploy",
        tool_id: "workspace.deploy",
        reason: "permission denied by policy",
      },
    ],
    promptSectionIds: ["runtime_core", "execution_policy"],
    capabilityManifestFingerprint: "c".repeat(64),
    tokenUsage: { input_tokens: 3, output_tokens: 5 },
  });
  store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-1",
    role: "user",
    text: "Please continue after deploy permissions are fixed.",
    messageId: "user-input-0",
  });
  store.close();

  let capturedProjectRequest: AgentRuntimeConfigCliRequest | null = null;
  const exitCode = await runTsRunnerCli(
    ["--request-base64", encodeRequest(baseRequest())],
    {
      deps: {
        ...testDeps(),
        projectAgentRuntimeConfig: (request) => {
          capturedProjectRequest = request;
          return {
            provider_id: "openai",
            model_id: "gpt-5.4",
            mode: "code",
            system_prompt: "You are concise.",
            model_client: {
              model_proxy_provider: "openai_compatible",
              api_key: "token",
              base_url: "http://127.0.0.1:4000/openai/v1",
              default_headers: { "X-Test": "1" },
            },
            tools: { read: true },
            workspace_tool_ids: [],
            workspace_skill_ids: [],
            output_schema_member_id: null,
            output_format: null,
            workspace_config_checksum: "checksum-1",
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedProjectRequest);
  if (!capturedProjectRequest) {
    throw new Error("expected project runtime config request");
  }
  const runtimeConfigRequest =
    capturedProjectRequest as AgentRuntimeConfigCliRequest;
  assert.equal(runtimeConfigRequest.recent_runtime_context, undefined);
  assert.equal(
    (runtimeConfigRequest as { session_resume_context?: Record<string, unknown> })
      .session_resume_context,
    undefined,
  );
});

test("runTsRunnerCli does not project session memory into runtime prompt config", async () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-session-memory-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  const workspaceRoot = path.join(sandboxRoot, "workspace");
  const store = new RuntimeStateStore({
    workspaceRoot,
    sandboxRoot,
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.close();
  writeSessionMemory({
    sandboxRoot,
    workspaceId: "workspace-1",
    sessionId: "session-1",
    content:
      "Resume from compacted deploy attempt. Draft report path: outputs/reports/deploy.md.",
  });

  let capturedProjectRequest: AgentRuntimeConfigCliRequest | null = null;
  const exitCode = await runTsRunnerCli(
    ["--request-base64", encodeRequest(baseRequest())],
    {
      deps: {
        ...testDeps(),
        projectAgentRuntimeConfig: (request) => {
          capturedProjectRequest = request;
          return {
            provider_id: "openai",
            model_id: "gpt-5.4",
            mode: "code",
            system_prompt: "You are concise.",
            model_client: {
              model_proxy_provider: "openai_compatible",
              api_key: "token",
              base_url: "http://127.0.0.1:4000/openai/v1",
              default_headers: { "X-Test": "1" },
            },
            tools: { read: true },
            workspace_tool_ids: [],
            workspace_skill_ids: [],
            output_schema_member_id: null,
            output_format: null,
            workspace_config_checksum: "checksum-1",
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedProjectRequest);
  if (!capturedProjectRequest) {
    throw new Error("expected project runtime config request");
  }
  const runtimeConfigRequest =
    capturedProjectRequest as AgentRuntimeConfigCliRequest;
  assert.equal(runtimeConfigRequest.recent_runtime_context, undefined);
  assert.equal(
    (runtimeConfigRequest as { session_resume_context?: Record<string, unknown> })
      .session_resume_context,
    undefined,
  );
});

test("runTsRunnerCli projects prior attachment turns into session attachment context without collapsing duplicates", async () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-session-attachments-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  const workspaceRoot = path.join(sandboxRoot, "workspace");
  const store = new RuntimeStateStore({
    workspaceRoot,
    sandboxRoot,
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-1",
    role: "user",
    text: "Analyze this report.",
    metadata: {
      attachments: [
        {
          id: "attachment-1",
          kind: "file",
          name: "report.html",
          mime_type: "text/html",
          size_bytes: 128,
          workspace_path: ".holaboss/input-attachments/batch-1/report.html",
        },
      ],
    },
    messageId: "user-input-0",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-1",
    role: "user",
    text: "Check the same report again.",
    metadata: {
      attachments: [
        {
          id: "attachment-2",
          kind: "file",
          name: "report.html",
          mime_type: "text/html",
          size_bytes: 128,
          workspace_path: ".holaboss/input-attachments/batch-2/report.html",
        },
      ],
    },
    messageId: "user-input-0b",
    createdAt: "2026-01-01T00:05:00.000Z",
  });
  store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-1",
    role: "user",
    text: "Current turn attachments should stay out of the prior timeline.",
    metadata: {
      attachments: [
        {
          id: "attachment-current",
          kind: "file",
          name: "current.html",
          mime_type: "text/html",
          size_bytes: 64,
          workspace_path: ".holaboss/input-attachments/current.html",
        },
      ],
    },
    messageId: "user-input-1",
    createdAt: "2026-01-01T00:10:00.000Z",
  });
  store.close();

  let capturedProjectRequest: AgentRuntimeConfigCliRequest | null = null;
  const exitCode = await runTsRunnerCli(
    ["--request-base64", encodeRequest(baseRequest())],
    {
      deps: {
        ...testDeps(),
        projectAgentRuntimeConfig: (request) => {
          capturedProjectRequest = request;
          return {
            provider_id: "openai",
            model_id: "gpt-5.4",
            mode: "code",
            system_prompt: "You are concise.",
            model_client: {
              model_proxy_provider: "openai_compatible",
              api_key: "token",
              base_url: "http://127.0.0.1:4000/openai/v1",
              default_headers: { "X-Test": "1" },
            },
            tools: { read: true },
            workspace_tool_ids: [],
            workspace_skill_ids: [],
            output_schema_member_id: null,
            output_format: null,
            workspace_config_checksum: "checksum-1",
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedProjectRequest);
  if (!capturedProjectRequest) {
    throw new Error("expected project runtime config request");
  }
  const runtimeConfigRequest =
    capturedProjectRequest as AgentRuntimeConfigCliRequest;
  assert.deepEqual(runtimeConfigRequest.session_attachment_context, {
    turns: [
      {
        message_id: "user-input-0",
        created_at: "2026-01-01T00:00:00.000Z",
        text: "Analyze this report.",
        attachments: [
          {
            id: "attachment-1",
            kind: "file",
            name: "report.html",
            mime_type: "text/html",
            size_bytes: 128,
            workspace_path: ".holaboss/input-attachments/batch-1/report.html",
          },
        ],
      },
      {
        message_id: "user-input-0b",
        created_at: "2026-01-01T00:05:00.000Z",
        text: "Check the same report again.",
        attachments: [
          {
            id: "attachment-2",
            kind: "file",
            name: "report.html",
            mime_type: "text/html",
            size_bytes: 128,
            workspace_path: ".holaboss/input-attachments/batch-2/report.html",
          },
        ],
      },
    ],
    truncated: false,
  });
});

test("runTsRunnerCli injects report-routing recovery context for report-style main-session requests", async () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-report-routing-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  const workspaceRoot = path.join(sandboxRoot, "workspace");
  const store = new RuntimeStateStore({
    workspaceRoot,
    sandboxRoot,
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.close();

  let capturedProjectRequest: AgentRuntimeConfigCliRequest | null = null;
  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        instruction: "write me a report on what we did so far",
      }),
    ],
    {
      deps: {
        ...testDeps({
          pluginOverrides: {
            stageRuntimeTools: () => ({
              changed: false,
              toolIds: ["delegate_task"],
            }),
          },
        }),
        projectAgentRuntimeConfig: (request) => {
          capturedProjectRequest = request;
          return {
            provider_id: "openai",
            model_id: "gpt-5.4",
            mode: "code",
            system_prompt: "You are concise.",
            model_client: {
              model_proxy_provider: "openai_compatible",
              api_key: "token",
              base_url: "http://127.0.0.1:4000/openai/v1",
              default_headers: { "X-Test": "1" },
            },
            tools: { read: true },
            workspace_tool_ids: [],
            workspace_skill_ids: [],
            output_schema_member_id: null,
            output_format: null,
            workspace_config_checksum: "checksum-1",
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedProjectRequest);
  if (!capturedProjectRequest) {
    throw new Error("expected project runtime config request");
  }
  const runtimeConfigRequest = capturedProjectRequest as AgentRuntimeConfigCliRequest;
  assert.deepEqual(runtimeConfigRequest.runtime_tool_ids, [
    "delegate_task",
  ]);
  assert.deepEqual(runtimeConfigRequest.recent_runtime_context?.lines, [
    "The user is asking for a report-style deliverable. Keep chat as the coordination surface, not the deliverable surface.",
    "Do not paste a long report, memo, brief, recap, or document body into the conversation.",
    "Use `delegate_task` to produce the report artifact, then keep the main-session reply to a brief acknowledgement or short handoff.",
    "Only provide the full content inline if the user explicitly asks for it in chat and it will remain short.",
  ]);
});

test("runTsRunnerCli injects available-tool fallback context for concrete checks", async () => {
  setTempSandboxRoot("hb-ts-runner-account-ui-fallback-");

  let capturedProjectRequest: AgentRuntimeConfigCliRequest | null = null;
  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        instruction:
          "can you check out what are the stats for my latest post?",
      }),
    ],
    {
      deps: {
        ...testDeps({
          pluginOverrides: {
            stageRuntimeTools: () => ({
              changed: false,
              toolIds: ["delegate_task"],
            }),
          },
        }),
        loadOperatorSurfaceContext: async () => ({
          active_surface_id: "browser:user",
          surfaces: [
            {
              surface_id: "browser:user",
              surface_type: "browser",
              owner: "user",
              active: true,
              mutability: "takeover_allowed",
              summary: "User browser is open to the relevant site.",
            },
          ],
        }),
        projectAgentRuntimeConfig: (request) => {
          capturedProjectRequest = request;
          return {
            provider_id: "openai",
            model_id: "gpt-5.4",
            mode: "code",
            system_prompt: "You are concise.",
            model_client: {
              model_proxy_provider: "openai_compatible",
              api_key: "token",
              base_url: "http://127.0.0.1:4000/openai/v1",
              default_headers: { "X-Test": "1" },
            },
            tools: { read: true },
            workspace_tool_ids: [],
            workspace_skill_ids: [],
            output_schema_member_id: null,
            output_format: null,
            workspace_config_checksum: "checksum-1",
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedProjectRequest);
  if (!capturedProjectRequest) {
    throw new Error("expected project runtime config request");
  }
  const runtimeConfigRequest =
    capturedProjectRequest as AgentRuntimeConfigCliRequest;
  assert.deepEqual(runtimeConfigRequest.runtime_tool_ids, [
    "delegate_task",
  ]);
  assert.deepEqual(runtimeConfigRequest.recent_runtime_context?.lines, [
    "The user is asking for a concrete check or lookup where the first-choice tool might be missing.",
    "Do not stop at a missing MCP/API/native tool. Try the best available route before saying it cannot be done.",
    "Choose the route that can actually satisfy the request: direct tool first, then delegated browser, web, terminal, or file inspection as appropriate.",
    "Only ask the user for access/context or state a limitation after viable direct and delegated routes are unavailable, blocked, or genuinely need human input.",
  ]);
});

test("runTsRunnerCli does not emit a synthetic resume event before harness run events", async () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-resume-event-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  const workspaceRoot = path.join(sandboxRoot, "workspace");
  const store = new RuntimeStateStore({
    workspaceRoot,
    sandboxRoot,
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.close();
  writeSessionMemory({
    sandboxRoot,
    workspaceId: "workspace-1",
    sessionId: "session-1",
    content: "Resume from compacted deploy attempt.",
  });

  const output: string[] = [];
  const exitCode = await runTsRunnerCli(
    ["--request-base64", encodeRequest(baseRequest())],
    {
      deps: testDeps({
        harnessEvents: [
          {
            session_id: "session-1",
            input_id: "input-1",
            sequence: 1,
            event_type: "run_started",
            timestamp: "2026-01-01T00:00:00.000Z",
            payload: { phase: "running" },
          },
          {
            session_id: "session-1",
            input_id: "input-1",
            sequence: 2,
            event_type: "run_completed",
            timestamp: "2026-01-01T00:00:01.000Z",
            payload: { status: "success" },
          },
        ],
      }),
      io: {
        stdout: {
          write(chunk: string | Uint8Array) {
            output.push(
              typeof chunk === "string"
                ? chunk
                : Buffer.from(chunk).toString("utf8"),
            );
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  const lines = output
    .join("")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TsRunnerEvent);

  assert.equal(lines[0].event_type, "run_claimed");
  assert.equal(lines[1].event_type, "run_started");
  assert.equal(lines[2].event_type, "run_completed");
});

test("runTsRunnerCli derives recalled durable memory from interaction trees", async () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-recalled-memory-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  const workspaceRoot = path.join(sandboxRoot, "workspace");
  const configPath = path.join(sandboxRoot, "state", "runtime-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        runtime: {
          background_tasks: {
            provider: "holaboss_model_proxy",
            model: "gpt-5.4-mini",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const store = new RuntimeStateStore({
    workspaceRoot,
    sandboxRoot,
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  seedInteractionEntity({
    store,
    workspaceId: "workspace-1",
    entityId: "interaction:preference:response-style",
    entityType: "preference",
    canonicalName: "Response style",
    slug: "preference-response-style",
    summary: "User-facing response preferences.",
  });
  seedInteractionLeaf({
    store,
    workspaceRoot,
    workspaceId: "workspace-1",
    entityId: "interaction:preference:response-style",
    entitySlug: "preference-response-style",
    leafId: "leaf-response-style",
    title: "User response style",
    summary: "User prefers concise responses.",
    content: "# User response style\n\nUser prefers concise responses.\n",
    subjectKey: "preference:response-style",
    sourceType: "leaf",
  });
  seedInteractionEntity({
    store,
    workspaceId: "workspace-1",
    entityId: "interaction:misc:deploy-permissions",
    entityType: "misc",
    canonicalName: "Deploy permissions",
    slug: "misc-deploy-permissions",
    summary: "Deployment blockers for this workspace.",
  });
  seedInteractionLeaf({
    store,
    workspaceRoot,
    workspaceId: "workspace-1",
    entityId: "interaction:misc:deploy-permissions",
    entitySlug: "misc-deploy-permissions",
    leafId: "leaf-deploy-blocker",
    title: "Deploy permission blocker",
    summary: "Deploy calls may be denied by workspace policy.",
    content: "# Deploy permission blocker\n\nDeploy calls may be denied by workspace policy.\n",
    subjectKey: "permission:deploy",
    sourceType: "leaf",
  });
  await rebuildInteractionEntityTree({
    store,
    workspaceId: "workspace-1",
    entityId: "interaction:preference:response-style",
    summaryModelClient: null,
    embeddingClient: null,
  });
  await rebuildInteractionEntityTree({
    store,
    workspaceId: "workspace-1",
    entityId: "interaction:misc:deploy-permissions",
    summaryModelClient: null,
    embeddingClient: null,
  });
  store.close();

  let capturedProjectRequest: Record<string, unknown> | null = null;
  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        instruction: "Please deploy after fixing permissions and keep the response concise.",
      }),
    ],
    {
      deps: {
        ...testDeps(),
        projectAgentRuntimeConfig: (request) => {
          capturedProjectRequest = request as unknown as Record<
            string,
            unknown
          >;
          return {
            provider_id: "openai",
            model_id: "gpt-5.4",
            mode: "code",
            system_prompt: "You are concise.",
            model_client: {
              model_proxy_provider: "openai_compatible",
              api_key: "token",
              base_url: "http://127.0.0.1:4000/openai/v1",
              default_headers: { "X-Test": "1" },
            },
            tools: { read: true },
            workspace_tool_ids: [],
            workspace_skill_ids: [],
            output_schema_member_id: null,
            output_format: null,
            workspace_config_checksum: "checksum-1",
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedProjectRequest);
  const recalledMemoryContext = (
    capturedProjectRequest as {
      recalled_memory_context: {
        intent?: string;
        retrieval_pack?: Record<string, unknown>;
        evidence?: Array<Record<string, unknown>>;
        coverage?: Record<string, unknown>;
      };
    }
  ).recalled_memory_context;
  assert.equal(recalledMemoryContext.intent, "fact_lookup");
  assert.ok(Array.isArray(recalledMemoryContext.evidence));
  assert.ok(recalledMemoryContext.evidence.length >= 2);
  const leafEntries = recalledMemoryContext.evidence
    .filter((entry) => entry.kind === "leaf")
    .sort((left, right) => String(left.title).localeCompare(String(right.title)));
  assert.equal(leafEntries.length, 2);
  const deployLeaf = leafEntries.find((entry) => entry.title === "Deploy permission blocker");
  assert.ok(deployLeaf);
  assert.equal(deployLeaf.category, "interaction");
  assert.equal(deployLeaf.summary, "Deploy calls may be denied by workspace policy.");
  assert.equal(deployLeaf.freshness_state, "fresh");
  assert.equal(deployLeaf.kind, "leaf");
  assert.match(String(deployLeaf.tree_id ?? ""), /^interaction:/);
  assert.match(
    String(deployLeaf.updated_at ?? ""),
    /\d{4}-\d{2}-\d{2}T/,
  );
  const styleLeaf = leafEntries.find((entry) => entry.title === "User response style");
  assert.ok(styleLeaf);
  assert.equal(styleLeaf.category, "interaction");
  assert.equal(styleLeaf.summary, "User prefers concise responses.");
  assert.equal(styleLeaf.freshness_state, "stable");
  assert.equal(styleLeaf.kind, "leaf");
  assert.match(String(styleLeaf.tree_id ?? ""), /^interaction:/);
  assert.match(
    String(styleLeaf.updated_at ?? ""),
    /\d{4}-\d{2}-\d{2}T/,
  );
  assert.ok(recalledMemoryContext.retrieval_pack);
  assert.ok(recalledMemoryContext.coverage);
});

test("runTsRunnerCli uses the default recall embedding model even when background tasks model is configured", async () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-recall-background-model-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  const workspaceRoot = path.join(sandboxRoot, "workspace");
  const configPath = path.join(sandboxRoot, "state", "runtime-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        runtime: {
          background_tasks: {
            provider: "openai_direct",
            model: "gpt-5.3-codex",
          },
        },
        providers: {
          openai_direct: {
            kind: "openai_compatible",
            base_url: "https://api.openai.com/v1",
            api_key: "sk-openai",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;
  const store = new RuntimeStateStore({
    workspaceRoot,
    sandboxRoot,
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  seedInteractionEntity({
    store,
    workspaceId: "workspace-1",
    entityId: "interaction:workflow:deploy-procedure",
    entityType: "workflow",
    canonicalName: "Deploy procedure",
    slug: "workflow-deploy-procedure",
    summary: "Deployment procedure memory.",
  });
  seedInteractionLeaf({
    store,
    workspaceRoot,
    workspaceId: "workspace-1",
    entityId: "interaction:workflow:deploy-procedure",
    entitySlug: "workflow-deploy-procedure",
    leafId: "leaf-deploy-procedure",
    title: "Deploy procedure",
    summary: "Steps for deployment.",
    content: "# Deploy procedure\n\nSteps for deployment.\n",
    subjectKey: "procedure:deploy",
    sourceType: "leaf",
  });
  store.close();
  const recallRequests: Array<Record<string, unknown>> = [];
  process.env.HOLABOSS_MODEL_PROXY_BASE_URL = "http://127.0.0.1:4999";
  process.env.HOLABOSS_SANDBOX_AUTH_TOKEN = "test-token";
  globalThis.fetch = (async (_input, init) => {
    if (typeof init?.body === "string") {
      recallRequests.push(JSON.parse(init.body) as Record<string, unknown>);
    }
    return new Response(
      JSON.stringify({
        data: [
          {
            embedding: [0.12, 0.34, 0.56, 0.78],
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        model: "openai_direct/gpt-5.4",
        instruction: "how do I deploy?",
      }),
    ],
    {
      deps: testDeps(),
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  const embeddingRequests = recallRequests.filter((request) =>
    request.model === "text-embedding-3-small",
  );
  assert.equal(embeddingRequests.length, 1);
  assert.match(String(embeddingRequests[0]?.input), /how do i deploy/i);
});

test("runTsRunnerCli loads pending user memory proposals into prompt context for the same input", async () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-pending-user-memory-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  const workspaceRoot = path.join(sandboxRoot, "workspace");
  const store = new RuntimeStateStore({
    workspaceRoot,
    sandboxRoot,
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: "workspace-1",
    sessionId: "session-1",
    kind: "main_session",
    title: "Main",
  });
  store.createMemoryUpdateProposal({
    proposalId: "proposal-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    inputId: "input-1",
    proposalKind: "preference",
    targetKey: "file-delivery",
    title: "File delivery preference",
    summary:
      "Do not compress or zip multiple files; deliver them individually.",
    payload: {
      preference_type: "file_delivery",
      mode: "individual_files",
      avoid_archive: true,
    },
    evidence: "Please do not zip the files. Send them individually.",
    confidence: 0.97,
    sourceMessageId: "user-input-1",
    createdAt: "2026-04-03T10:00:00.000Z",
  });
  store.close();

  let capturedProjectRequest: Record<string, unknown> | null = null;
  const exitCode = await runTsRunnerCli(
    ["--request-base64", encodeRequest(baseRequest())],
    {
      deps: {
        ...testDeps(),
        projectAgentRuntimeConfig: (request) => {
          capturedProjectRequest = request as unknown as Record<
            string,
            unknown
          >;
          return {
            provider_id: "openai",
            model_id: "gpt-5.4",
            mode: "code",
            system_prompt: "You are concise.",
            model_client: {
              model_proxy_provider: "openai_compatible",
              api_key: "token",
              base_url: "http://127.0.0.1:4000/openai/v1",
              default_headers: { "X-Test": "1" },
            },
            tools: { read: true },
            workspace_tool_ids: [],
            workspace_skill_ids: [],
            output_schema_member_id: null,
            output_format: null,
            workspace_config_checksum: "checksum-1",
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedProjectRequest);
  const pendingUserMemoryContext = (
    capturedProjectRequest as {
      pending_user_memory_context: { entries: Array<Record<string, unknown>> };
    }
  ).pending_user_memory_context;

  assert.equal(pendingUserMemoryContext.entries.length, 1);
  assert.equal(
    pendingUserMemoryContext.entries[0]?.target_key,
    "file-delivery",
  );
  assert.equal(
    pendingUserMemoryContext.entries[0]?.summary,
    "Do not compress or zip multiple files; deliver them individually.",
  );
});

test("runTsRunnerCli does not load legacy session history exports into main-session prompt context", async () => {
  const sandboxRoot = setTempSandboxRoot("hb-ts-runner-legacy-session-history-");
  const workspaceDir = path.join(sandboxRoot, "workspace", "workspace-1");
  const legacyDir = path.join(
    workspaceDir,
    ".holaboss",
    "state",
    "legacy-session-histories",
  );
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyDir, "index.json"),
    JSON.stringify(
      [
        {
          session_id: "session-older",
          title: "Earlier planning chat",
          kind: "main_session",
          archived_at: "2026-04-24T06:52:27.419Z",
          message_count: 14,
          output_count: 1,
          json_path: path.join(legacyDir, "session-older.json"),
          markdown_path: path.join(legacyDir, "session-older.md"),
        },
      ],
      null,
      2,
    ),
    "utf8",
  );

  let capturedProjectRequest: Record<string, unknown> | null = null;
  const exitCode = await runTsRunnerCli(
    ["--request-base64", encodeRequest(baseRequest())],
    {
      deps: {
        ...testDeps(),
        projectAgentRuntimeConfig: (request) => {
          capturedProjectRequest = request as unknown as Record<string, unknown>;
          return {
            provider_id: "openai",
            model_id: "gpt-5.4",
            mode: "code",
            system_prompt: "You are concise.",
            model_client: {
              model_proxy_provider: "openai_compatible",
              api_key: "token",
              base_url: "http://127.0.0.1:4000/openai/v1",
              default_headers: { "X-Test": "1" },
            },
            tools: { read: true },
            workspace_tool_ids: [],
            workspace_skill_ids: [],
            output_schema_member_id: null,
            output_format: null,
            workspace_config_checksum: "checksum-1",
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedProjectRequest);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      capturedProjectRequest,
      "legacy_session_history_context",
    ),
    false,
  );
});

test("runTsRunnerCli loads operator surface context into prompt context for the same run", async () => {
  setTempSandboxRoot("hb-ts-runner-operator-surface-");

  let capturedProjectRequest: Record<string, unknown> | null = null;
  const exitCode = await runTsRunnerCli(
    ["--request-base64", encodeRequest(baseRequest())],
    {
      deps: {
        ...testDeps(),
        loadOperatorSurfaceContext: async () => ({
          active_surface_id: "browser:user",
          surfaces: [
            {
              surface_id: "browser:user",
              surface_type: "browser",
              owner: "user",
              active: true,
              mutability: "inspect_only",
              summary: "User browser surface with 1 open tab.",
            },
            {
              surface_id: "browser:agent",
              surface_type: "browser",
              owner: "agent",
              active: false,
              mutability: "agent_owned",
              summary: "Agent browser surface with 2 open tabs.",
            },
          ],
        }),
        projectAgentRuntimeConfig: (request) => {
          capturedProjectRequest = request as unknown as Record<
            string,
            unknown
          >;
          return {
            provider_id: "openai",
            model_id: "gpt-5.4",
            mode: "code",
            system_prompt: "You are concise.",
            model_client: {
              model_proxy_provider: "openai_compatible",
              api_key: "token",
              base_url: "http://127.0.0.1:4000/openai/v1",
              default_headers: { "X-Test": "1" },
            },
            tools: { read: true },
            workspace_tool_ids: [],
            workspace_skill_ids: [],
            output_schema_member_id: null,
            output_format: null,
            workspace_config_checksum: "checksum-1",
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedProjectRequest);
  assert.deepEqual(
    (
      capturedProjectRequest as {
        operator_surface_context: Record<string, unknown>;
      }
    ).operator_surface_context,
    {
      active_surface_id: "browser:user",
      surfaces: [
        {
          surface_id: "browser:user",
          surface_type: "browser",
          owner: "user",
          active: true,
          mutability: "inspect_only",
          summary: "User browser surface with 1 open tab.",
        },
        {
          surface_id: "browser:agent",
          surface_type: "browser",
          owner: "agent",
          active: false,
          mutability: "agent_owned",
          summary: "Agent browser surface with 2 open tabs.",
        },
      ],
    },
  );
});

test("runTsRunnerCli loads operator surface context from the desktop browser capability base URL", async () => {
  const sandboxRoot = setTempSandboxRoot(
    "hb-ts-runner-operator-surface-fetch-",
  );
  const configPath = path.join(sandboxRoot, "state", "runtime-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        capabilities: {
          desktop_browser: {
            enabled: true,
            url: "http://127.0.0.1:3555/api/v1/browser",
            auth_token: "browser-token",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;

  let capturedProjectRequest: Record<string, unknown> | null = null;
  const requests: Array<{
    url: string;
    token: string | null;
    workspaceId: string | null;
  }> = [];
  const {
    loadOperatorSurfaceContext: _ignoredLoadOperatorSurfaceContext,
    ...baseDeps
  } = testDeps();
  globalThis.fetch = (async (input, init) => {
    requests.push({
      url:
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : String(input),
      token:
        init?.headers &&
        typeof init.headers === "object" &&
        !Array.isArray(init.headers)
          ? ((init.headers as Record<string, string>)[
              "x-holaboss-desktop-token"
            ] ?? null)
          : null,
      workspaceId:
        init?.headers &&
        typeof init.headers === "object" &&
        !Array.isArray(init.headers)
          ? ((init.headers as Record<string, string>)[
              "x-holaboss-workspace-id"
            ] ?? null)
          : null,
    });
    return new Response(
      JSON.stringify({
        active_surface_id: "browser:user",
        surfaces: [
          {
            surface_id: "browser:user",
            surface_type: "browser",
            owner: "user",
            active: true,
            mutability: "inspect_only",
            summary: "User browser surface with 1 open tab.",
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const exitCode = await runTsRunnerCli(
    ["--request-base64", encodeRequest(baseRequest())],
    {
      deps: {
        ...baseDeps,
        projectAgentRuntimeConfig: (request) => {
          capturedProjectRequest = request as unknown as Record<
            string,
            unknown
          >;
          return {
            provider_id: "openai",
            model_id: "gpt-5.4",
            mode: "code",
            system_prompt: "You are concise.",
            model_client: {
              model_proxy_provider: "openai_compatible",
              api_key: "token",
              base_url: "http://127.0.0.1:4000/openai/v1",
              default_headers: { "X-Test": "1" },
            },
            tools: { read: true },
            workspace_tool_ids: [],
            workspace_skill_ids: [],
            output_schema_member_id: null,
            output_format: null,
            workspace_config_checksum: "checksum-1",
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(requests, [
    {
      url: "http://127.0.0.1:3555/api/v1/browser/operator-surface-context",
      token: "browser-token",
      workspaceId: "workspace-1",
    },
  ]);
  assert.ok(capturedProjectRequest);
  assert.deepEqual(
    (
      capturedProjectRequest as {
        operator_surface_context: Record<string, unknown>;
      }
    ).operator_surface_context,
    {
      active_surface_id: "browser:user",
      surfaces: [
        {
          surface_id: "browser:user",
          surface_type: "browser",
          owner: "user",
          active: true,
          mutability: "inspect_only",
          summary: "User browser surface with 1 open tab.",
        },
      ],
    },
  );
});

test("runTsRunnerCli defaults workspace sessions to the agent browser even when the user browser is active", async () => {
  let capturedHarnessRequest: Record<string, unknown> | null = null;

  const exitCode = await runTsRunnerCli(
    ["--request-base64", encodeRequest(baseRequest())],
    {
      deps: {
        ...testDeps(),
        loadOperatorSurfaceContext: async () => ({
          active_surface_id: "browser:user",
          surfaces: [
            {
              surface_id: "browser:user",
              surface_type: "browser",
              owner: "user",
              active: true,
              mutability: "takeover_allowed",
              summary: "User browser surface with 1 open tab.",
            },
            {
              surface_id: "browser:agent",
              surface_type: "browser",
              owner: "agent",
              active: false,
              mutability: "agent_owned",
              summary: "Agent browser surface with 1 open tab.",
            },
          ],
        }),
        runHarnessHost: async ({ requestPayload }) => {
          capturedHarnessRequest = requestPayload;
          return {
            exitCode: 0,
            stderr: "",
            sawEvent: false,
            terminalEmitted: false,
            lastSequence: 0,
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedHarnessRequest);
  assert.equal(
    (capturedHarnessRequest as { browser_space?: string | null }).browser_space,
    "agent",
  );
});

test("runTsRunnerCli defaults delegated sessions to the agent browser when the user browser is active", async () => {
  let capturedHarnessRequest: Record<string, unknown> | null = null;

  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        session_kind: "subagent",
      }),
    ],
    {
      deps: {
        ...testDeps(),
        loadOperatorSurfaceContext: async () => ({
          active_surface_id: "browser:user",
          surfaces: [
            {
              surface_id: "browser:user",
              surface_type: "browser",
              owner: "user",
              active: true,
              mutability: "takeover_allowed",
              summary: "User browser surface with 1 open tab.",
            },
            {
              surface_id: "browser:agent",
              surface_type: "browser",
              owner: "agent",
              active: false,
              mutability: "agent_owned",
              summary: "Agent browser surface with 1 open tab.",
            },
          ],
        }),
        runHarnessHost: async ({ requestPayload }) => {
          capturedHarnessRequest = requestPayload;
          return {
            exitCode: 0,
            stderr: "",
            sawEvent: false,
            terminalEmitted: false,
            lastSequence: 0,
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedHarnessRequest);
  assert.equal(
    (capturedHarnessRequest as { browser_space?: string | null }).browser_space,
    "agent",
  );
});

test("runTsRunnerCli honors explicit delegated requests to use the user browser surface", async () => {
  let capturedHarnessRequest: Record<string, unknown> | null = null;

  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        session_kind: "subagent",
        context: {
          use_user_browser_surface: true,
        },
      }),
    ],
    {
      deps: {
        ...testDeps(),
        loadOperatorSurfaceContext: async () => ({
          active_surface_id: "browser:user",
          surfaces: [
            {
              surface_id: "browser:user",
              surface_type: "browser",
              owner: "user",
              active: true,
              mutability: "takeover_allowed",
              summary: "User browser surface with 1 open tab.",
            },
            {
              surface_id: "browser:agent",
              surface_type: "browser",
              owner: "agent",
              active: false,
              mutability: "agent_owned",
              summary: "Agent browser surface with 1 open tab.",
            },
          ],
        }),
        runHarnessHost: async ({ requestPayload }) => {
          capturedHarnessRequest = requestPayload;
          return {
            exitCode: 0,
            stderr: "",
            sawEvent: false,
            terminalEmitted: false,
            lastSequence: 0,
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedHarnessRequest);
  assert.equal(
    (capturedHarnessRequest as { browser_space?: string | null }).browser_space,
    "user",
  );
});

test("runTsRunnerCli honors explicit workspace-session requests to use the user browser surface", async () => {
  let capturedHarnessRequest: Record<string, unknown> | null = null;

  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        context: {
          use_user_browser_surface: true,
        },
      }),
    ],
    {
      deps: {
        ...testDeps(),
        loadOperatorSurfaceContext: async () => ({
          active_surface_id: "browser:user",
          surfaces: [
            {
              surface_id: "browser:user",
              surface_type: "browser",
              owner: "user",
              active: true,
              mutability: "takeover_allowed",
              summary: "User browser surface with 1 open tab.",
            },
            {
              surface_id: "browser:agent",
              surface_type: "browser",
              owner: "agent",
              active: false,
              mutability: "agent_owned",
              summary: "Agent browser surface with 1 open tab.",
            },
          ],
        }),
        runHarnessHost: async ({ requestPayload }) => {
          capturedHarnessRequest = requestPayload;
          return {
            exitCode: 0,
            stderr: "",
            sawEvent: false,
            terminalEmitted: false,
            lastSequence: 0,
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedHarnessRequest);
  assert.equal(
    (capturedHarnessRequest as { browser_space?: string | null }).browser_space,
    "user",
  );
});

test("runTsRunnerCli recalls workspace interaction memory even with many newer cross-workspace leaves", async () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-recalled-memory-scope-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  const workspaceRoot = path.join(sandboxRoot, "workspace");
  const configPath = path.join(sandboxRoot, "state", "runtime-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        runtime: {
          background_tasks: {
            provider: "holaboss_model_proxy",
            model: "gpt-5.4-mini",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const store = new RuntimeStateStore({
    workspaceRoot,
    sandboxRoot,
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.createWorkspace({
    workspaceId: "workspace-2",
    name: "Workspace 2",
    harness: "pi",
    status: "active",
  });
  seedInteractionEntity({
    store,
    workspaceId: "workspace-1",
    entityId: "interaction:misc:deploy-permissions",
    entityType: "misc",
    canonicalName: "Deploy permissions",
    slug: "misc-deploy-permissions",
    summary: "Deployment blockers for workspace 1.",
  });
  seedInteractionLeaf({
    store,
    workspaceRoot,
    workspaceId: "workspace-1",
    entityId: "interaction:misc:deploy-permissions",
    entitySlug: "misc-deploy-permissions",
    leafId: "leaf-workspace-1-deploy",
    title: "Deploy permission blocker",
    summary: "Deploy calls may be denied by workspace policy.",
    content: "# Deploy permission blocker\n\nDeploy calls may be denied by workspace policy.\n",
    subjectKey: "permission:deploy",
    sourceType: "leaf",
    observedAt: "2026-01-01T00:00:00.000Z",
  });
  seedInteractionEntity({
    store,
    workspaceId: "workspace-2",
    entityId: "interaction:misc:workspace-2-notes",
    entityType: "misc",
    canonicalName: "Workspace 2 notes",
    slug: "misc-workspace-2-notes",
    summary: "Workspace 2 filler notes.",
  });
  for (let index = 0; index < 240; index += 1) {
    const minute = String(index % 60).padStart(2, "0");
    const second = String(index % 60).padStart(2, "0");
    seedInteractionLeaf({
      store,
      workspaceRoot,
      workspaceId: "workspace-2",
      entityId: "interaction:misc:workspace-2-notes",
      entitySlug: "misc-workspace-2-notes",
      leafId: `leaf-workspace-2-${index}`,
      title: `Workspace 2 note ${index}`,
      summary: `Non-matching note ${index}.`,
      content: `# Workspace 2 note ${index}\n\nNon-matching note ${index}.\n`,
      subjectKey: `fact:${index}`,
      sourceType: "leaf",
      observedAt: `2026-03-01T00:${minute}:${second}.000Z`,
    });
  }
  await rebuildInteractionEntityTree({
    store,
    workspaceId: "workspace-1",
    entityId: "interaction:misc:deploy-permissions",
    summaryModelClient: null,
    embeddingClient: null,
  });
  await rebuildInteractionEntityTree({
    store,
    workspaceId: "workspace-2",
    entityId: "interaction:misc:workspace-2-notes",
    summaryModelClient: null,
    embeddingClient: null,
  });
  store.close();

  let capturedProjectRequest: Record<string, unknown> | null = null;
  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        instruction: "Please fix deploy permission issues.",
      }),
    ],
    {
      deps: {
        ...testDeps(),
        projectAgentRuntimeConfig: (request) => {
          capturedProjectRequest = request as unknown as Record<
            string,
            unknown
          >;
          return {
            provider_id: "openai",
            model_id: "gpt-5.4",
            mode: "code",
            system_prompt: "You are concise.",
            model_client: {
              model_proxy_provider: "openai_compatible",
              api_key: "token",
              base_url: "http://127.0.0.1:4000/openai/v1",
              default_headers: { "X-Test": "1" },
            },
            tools: { read: true },
            workspace_tool_ids: [],
            workspace_skill_ids: [],
            output_schema_member_id: null,
            output_format: null,
            workspace_config_checksum: "checksum-1",
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedProjectRequest);
  const recalledMemoryContext = (
    capturedProjectRequest as {
      recalled_memory_context: { evidence: Array<Record<string, unknown>> };
    }
  ).recalled_memory_context;
  assert.ok(Array.isArray(recalledMemoryContext.evidence));
  assert.equal(
    recalledMemoryContext.evidence.some(
      (entry) =>
        entry.title === "Deploy permission blocker"
        && /^interaction:/.test(String(entry.tree_id ?? "")),
    ),
    true,
  );
  assert.equal(
    recalledMemoryContext.evidence.every((entry) => {
      const treeValue = String(entry.tree_id ?? "");
      return treeValue.startsWith("interaction:");
    }),
    true,
  );
});

test(
  "runTsRunnerCli waits long enough to include a fast recalled memory prefetch",
  { timeout: 3000 },
  async () => {
    setTempSandboxRoot("hb-ts-runner-recalled-memory-fast-");
    let capturedProjectRequest: Record<string, unknown> | null = null;

    const exitCode = await runTsRunnerCli(
      ["--request-base64", encodeRequest(baseRequest())],
      {
        deps: {
          ...testDeps(),
          loadRecalledMemoryContext: async () => {
            await new Promise((resolve) => setTimeout(resolve, 40));
            return {
              intent: "briefing",
              retrieval_pack: {
                known_facts: [],
                recent_high_signal_items: [
                  {
                    evidence_id: "memory-1",
                    category: "integration",
                    kind: "leaf",
                    title: "Customer escalation waiting on reply",
                    summary: "Customer thread is waiting on a reply before Friday.",
                    freshness_state: "fresh",
                    score: 5.5,
                    reason: "high_signal",
                  },
                ],
                constraints: [],
                blockers: [],
                open_questions: [],
                recommended_next_source: "gmail",
                recommended_next_step: {
                  type: "verify_live_state",
                  source: "gmail",
                  reason: "Email state may have changed.",
                },
              },
              evidence: [
                {
                  id: "memory-1",
                  category: "integration",
                  kind: "leaf",
                  tree_id: "integration:gmail:acct-1",
                  title: "Customer escalation waiting on reply",
                  summary: "Customer thread is waiting on a reply before Friday.",
                  excerpt: null,
                  freshness_state: "fresh",
                  freshness_note: "leaf memory from gmail account Ops Gmail.",
                  score: 5.5,
                  reasons: ["lexical_match"],
                  observed_at: "2026-05-24T00:00:00.000Z",
                  updated_at: "2026-05-24T00:00:00.000Z",
                  source_label: "Ops Gmail",
                  entity_name: null,
                  entity_type: null,
                  provider: "gmail",
                  account_label: "Ops Gmail",
                },
              ],
              gaps: [],
              coverage: {
                used_lexical: true,
                used_vector: false,
                used_neighbors: false,
                confidence: "high",
              },
            };
          },
          projectAgentRuntimeConfig: (request) => {
            capturedProjectRequest = request as unknown as Record<
              string,
              unknown
            >;
            return {
              provider_id: "openai",
              model_id: "gpt-5.4",
              mode: "code",
              system_prompt: "You are concise.",
              model_client: {
                model_proxy_provider: "openai_compatible",
                api_key: "token",
                base_url: "http://127.0.0.1:4000/openai/v1",
                default_headers: { "X-Test": "1" },
              },
              tools: { read: true },
              workspace_tool_ids: [],
              workspace_skill_ids: [],
              output_schema_member_id: null,
              output_format: null,
              workspace_config_checksum: "checksum-1",
            };
          },
        },
        io: {
          stdout: {
            write() {
              return true;
            },
          } as unknown as NodeJS.WritableStream,
          stderr: {
            write() {
              return true;
            },
          } as unknown as NodeJS.WritableStream,
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.ok(capturedProjectRequest);
    assert.ok(
      (capturedProjectRequest as { recalled_memory_context?: unknown })
        .recalled_memory_context,
    );
  },
);

test(
  "runTsRunnerCli does not block bootstrap when recalled memory prefetch is unresolved",
  { timeout: 3000 },
  async () => {
    const sandboxRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "hb-ts-runner-recalled-memory-prefetch-"),
    );
    process.env.HB_SANDBOX_ROOT = sandboxRoot;
    let capturedProjectRequest: Record<string, unknown> | null = null;
    let timeoutId: NodeJS.Timeout | null = null;

    try {
      const runPromise = runTsRunnerCli(
        ["--request-base64", encodeRequest(baseRequest())],
        {
          deps: {
            ...testDeps(),
            loadRecalledMemoryContext: async () =>
              await new Promise<null>(() => {}),
            projectAgentRuntimeConfig: (request) => {
              capturedProjectRequest = request as unknown as Record<
                string,
                unknown
              >;
              return {
                provider_id: "openai",
                model_id: "gpt-5.4",
                mode: "code",
                system_prompt: "You are concise.",
                model_client: {
                  model_proxy_provider: "openai_compatible",
                  api_key: "token",
                  base_url: "http://127.0.0.1:4000/openai/v1",
                  default_headers: { "X-Test": "1" },
                },
                tools: { read: true },
                workspace_tool_ids: [],
                workspace_skill_ids: [],
                output_schema_member_id: null,
                output_format: null,
                workspace_config_checksum: "checksum-1",
              };
            },
          },
          io: {
            stdout: {
              write() {
                return true;
              },
            } as unknown as NodeJS.WritableStream,
            stderr: {
              write() {
                return true;
              },
            } as unknown as NodeJS.WritableStream,
          },
        },
      );
      const timedOut = new Promise<number>((_resolve, reject) => {
        timeoutId = setTimeout(
          () =>
            reject(
              new Error(
                "runTsRunnerCli timed out while waiting on recall prefetch",
              ),
            ),
          1500,
        );
      });
      const exitCode = await Promise.race([runPromise, timedOut]);

      assert.equal(exitCode, 0);
      assert.ok(capturedProjectRequest);
      assert.equal(
        (capturedProjectRequest as { recalled_memory_context?: unknown })
          .recalled_memory_context,
        undefined,
      );
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  },
);

test("runTsRunnerCli stages browser tools for subagent executor sessions and strips orchestration runtime tools", async () => {
  setTempSandboxRoot("hb-ts-runner-browser-scope-");
  const seenSessionKinds: Array<string | null | undefined> = [];
  let capturedProjectRequest: Record<string, unknown> | null = null;

  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        session_kind: "subagent",
      }),
    ],
    {
      deps: {
        ...testDeps({
          pluginOverrides: {
            stageBrowserTools: ({ sessionKind }) => {
              seenSessionKinds.push(sessionKind);
              return {
                changed: false,
                toolIds:
                  sessionKind === "subagent"
                    ? ["browser_get_state"]
                    : [],
              };
            },
            stageRuntimeTools: () => ({
              changed: false,
              toolIds: [
                "holaboss_onboarding_complete",
                "delegate_task",
              ],
            }),
          },
        }),
        projectAgentRuntimeConfig: (request) => {
          capturedProjectRequest = request as unknown as Record<
            string,
            unknown
          >;
          return {
            provider_id: "openai",
            model_id: "gpt-5.4",
            mode: "code",
            system_prompt: "You are concise.",
            model_client: {
              model_proxy_provider: "openai_compatible",
              api_key: "token",
              base_url: "http://127.0.0.1:4000/openai/v1",
              default_headers: { "X-Test": "1" },
            },
            tools: { read: true },
            workspace_tool_ids: [],
            workspace_skill_ids: [],
            output_schema_member_id: null,
            output_format: null,
            workspace_config_checksum: "checksum-1",
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(seenSessionKinds, ["subagent"]);
  assert.ok(capturedProjectRequest);
  assert.equal(
    (capturedProjectRequest as { browser_tools_available: boolean })
      .browser_tools_available,
    true,
  );
  assert.equal(
    (capturedProjectRequest as { session_kind: string | null }).session_kind,
    "subagent",
  );
  assert.deepEqual(
    (capturedProjectRequest as { browser_tool_ids: string[] }).browser_tool_ids,
    ["browser_get_state"],
  );
  assert.deepEqual(
    (capturedProjectRequest as { runtime_tool_ids: string[] }).runtime_tool_ids,
    ["holaboss_onboarding_complete"],
  );
  assert.deepEqual(
    (capturedProjectRequest as { default_tools: string[] }).default_tools,
    [
      "read",
      "edit",
      "bash",
      "grep",
      "glob",
      "list",
      "question",
      "todowrite",
      "todoread",
      "skill",
    ],
  );
  assert.deepEqual(
    (capturedProjectRequest as { extra_tools: string[] }).extra_tools,
    ["web_search", "browser_get_state", "holaboss_onboarding_complete"],
  );
});

test("runTsRunnerCli passes image_urls into the pi harness request", async () => {
  const sandboxRoot = setTempSandboxRoot("hb-ts-runner-pi-image-urls-");
  const workspaceDir = path.join(sandboxRoot, "workspace", "workspace-1");
  fs.mkdirSync(workspaceDir, { recursive: true });

  let capturedHarnessRequest: Record<string, unknown> | null = null;

  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        image_urls: ["https://example.com/reference.png"],
        context: {
          _sandbox_runtime_exec_v1: {
            harness: "pi",
          },
        },
      }),
    ],
    {
      deps: {
        ...testDeps(),
        projectAgentRuntimeConfig: () => ({
          provider_id: "openai",
          model_id: "gpt-5.4",
          mode: "code",
          system_prompt: "You are concise.",
          model_client: {
            model_proxy_provider: "openai_compatible",
            api_key: "token",
            base_url: "http://127.0.0.1:4000/openai/v1",
            default_headers: { "X-Test": "1" },
          },
          tools: { read: true },
          workspace_tool_ids: [],
          workspace_skill_ids: [],
          output_schema_member_id: null,
          output_format: null,
          workspace_config_checksum: "checksum-1",
        }),
        runHarnessHost: async ({ requestPayload }) => {
          capturedHarnessRequest = requestPayload;
          return {
            exitCode: 0,
            stderr: "",
            sawEvent: false,
            terminalEmitted: false,
            lastSequence: 0,
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedHarnessRequest);
  assert.deepEqual(
    (capturedHarnessRequest as { image_urls: string[] }).image_urls,
    ["https://example.com/reference.png"],
  );
});

test("runTsRunnerCli includes embedded default skill ids and source directories for the pi harness", async () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-pi-embedded-skills-"),
  );
  const embeddedSkillsRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-embedded-skill-root-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  process.env.HOLABOSS_EMBEDDED_SKILLS_DIR = embeddedSkillsRoot;
  const workspaceDir = path.join(sandboxRoot, "workspace", "workspace-1");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const embeddedSkillDir = path.join(embeddedSkillsRoot, "holaboss-runtime");
  fs.mkdirSync(embeddedSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(embeddedSkillDir, "SKILL.md"),
    "---\nname: holaboss-runtime\ndescription: Runtime skill\n---\n# Holaboss Runtime\n",
    "utf8",
  );

  let capturedProjectRequest: Record<string, unknown> | null = null;
  let capturedHarnessRequest: Record<string, unknown> | null = null;

  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        context: {
          _sandbox_runtime_exec_v1: {
            harness: "pi",
          },
        },
      }),
    ],
    {
      deps: {
        ...testDeps(),
        projectAgentRuntimeConfig: (request) => {
          capturedProjectRequest = request as unknown as Record<
            string,
            unknown
          >;
          return {
            provider_id: "openai",
            model_id: "gpt-5.4",
            mode: "code",
            system_prompt: "You are concise.",
            model_client: {
              model_proxy_provider: "openai_compatible",
              api_key: "token",
              base_url: "http://127.0.0.1:4000/openai/v1",
              default_headers: { "X-Test": "1" },
            },
            tools: { read: true, skill: true },
            workspace_tool_ids: [],
            workspace_skill_ids: ["holaboss-runtime"],
            output_schema_member_id: null,
            output_format: null,
            workspace_config_checksum: "checksum-1",
          };
        },
        runHarnessHost: async ({ requestPayload }) => {
          capturedHarnessRequest = requestPayload;
          return {
            exitCode: 0,
            stderr: "",
            sawEvent: false,
            terminalEmitted: false,
            lastSequence: 0,
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedProjectRequest);
  assert.deepEqual(
    (capturedProjectRequest as { workspace_skill_ids: string[] })
      .workspace_skill_ids,
    ["holaboss-runtime"],
  );
  assert.ok(capturedHarnessRequest);
  assert.deepEqual(
    (
      capturedHarnessRequest as {
        workspace_skill_dirs: string[];
      }
    ).workspace_skill_dirs,
    [fs.realpathSync(embeddedSkillDir)],
  );
});

test("runTsRunnerCli keeps embedded skills authoritative when a workspace skill reuses the same id", async () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-pi-embedded-skill-shadow-"),
  );
  const embeddedSkillsRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-embedded-skill-shadow-root-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  process.env.HOLABOSS_EMBEDDED_SKILLS_DIR = embeddedSkillsRoot;
  const workspaceDir = path.join(sandboxRoot, "workspace", "workspace-1");
  const workspaceSkillDir = path.join(
    workspaceDir,
    "skills",
    "holaboss-runtime",
  );
  fs.mkdirSync(workspaceSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceSkillDir, "SKILL.md"),
    "---\nname: holaboss-runtime\ndescription: Workspace override\n---\n# Workspace Override\n",
    "utf8",
  );
  const embeddedSkillDir = path.join(embeddedSkillsRoot, "holaboss-runtime");
  fs.mkdirSync(embeddedSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(embeddedSkillDir, "SKILL.md"),
    "---\nname: holaboss-runtime\ndescription: Embedded runtime skill\n---\n# Holaboss Runtime\n",
    "utf8",
  );

  let capturedProjectRequest: Record<string, unknown> | null = null;
  let capturedHarnessRequest: Record<string, unknown> | null = null;

  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        context: {
          _sandbox_runtime_exec_v1: {
            harness: "pi",
          },
        },
      }),
    ],
    {
      deps: {
        ...testDeps(),
        projectAgentRuntimeConfig: (request) => {
          capturedProjectRequest = request as unknown as Record<
            string,
            unknown
          >;
          return {
            provider_id: "openai",
            model_id: "gpt-5.4",
            mode: "code",
            system_prompt: "You are concise.",
            model_client: {
              model_proxy_provider: "openai_compatible",
              api_key: "token",
              base_url: "http://127.0.0.1:4000/openai/v1",
              default_headers: { "X-Test": "1" },
            },
            tools: { read: true, skill: true },
            workspace_tool_ids: [],
            workspace_skill_ids: ["holaboss-runtime"],
            output_schema_member_id: null,
            output_format: null,
            workspace_config_checksum: "checksum-1",
          };
        },
        runHarnessHost: async ({ requestPayload }) => {
          capturedHarnessRequest = requestPayload;
          return {
            exitCode: 0,
            stderr: "",
            sawEvent: false,
            terminalEmitted: false,
            lastSequence: 0,
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedProjectRequest);
  assert.deepEqual(
    (capturedProjectRequest as { workspace_skill_ids: string[] })
      .workspace_skill_ids,
    ["holaboss-runtime"],
  );
  assert.ok(capturedHarnessRequest);
  assert.deepEqual(
    (
      capturedHarnessRequest as {
        workspace_skill_dirs: string[];
      }
    ).workspace_skill_dirs,
    [fs.realpathSync(embeddedSkillDir)],
  );
});

test("runTsRunnerCli resolves workspace skill ids and source directories for the pi harness", async () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-pi-skills-source-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  const workspaceDir = path.join(sandboxRoot, "workspace", "workspace-1");
  const skillDir = path.join(workspaceDir, "skills", "alpha");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: alpha\ndescription: Alpha skill\n---\n# Alpha\n",
    "utf8",
  );

  let capturedProjectRequest: Record<string, unknown> | null = null;
  let capturedHarnessRequest: Record<string, unknown> | null = null;

  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        instruction: ["/alpha", "", "Draft the follow-up email."].join("\n"),
        context: {
          _sandbox_runtime_exec_v1: {
            harness: "pi",
          },
        },
      }),
    ],
    {
      deps: {
        ...testDeps(),
        projectAgentRuntimeConfig: (request) => {
          capturedProjectRequest = request as unknown as Record<
            string,
            unknown
          >;
          return {
            provider_id: "openai",
            model_id: "gpt-5.4",
            mode: "code",
            system_prompt: "You are concise.",
            model_client: {
              model_proxy_provider: "openai_compatible",
              api_key: "token",
              base_url: "http://127.0.0.1:4000/openai/v1",
              default_headers: { "X-Test": "1" },
            },
            tools: { read: true },
            workspace_tool_ids: [],
            workspace_skill_ids: ["alpha"],
            output_schema_member_id: null,
            output_format: null,
            workspace_config_checksum: "checksum-1",
          };
        },
        runHarnessHost: async ({ requestPayload }) => {
          capturedHarnessRequest = requestPayload;
          return {
            exitCode: 0,
            stderr: "",
            sawEvent: false,
            terminalEmitted: false,
            lastSequence: 0,
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedProjectRequest);
  assert.equal(
    (capturedProjectRequest as { harness_id: string | null }).harness_id,
    "pi",
  );
  assert.deepEqual(
    (capturedProjectRequest as { workspace_skill_ids: string[] })
      .workspace_skill_ids,
    [
      "app-builder-sdk",
      "browser-core-efficient",
      "browser-qa",
      "build-dashboard",
      "frontend-design",
      "interface-design",
      "mcp-configurator",
      "skill-creator",
      "skill-installer",
      "alpha",
    ],
  );
  assert.ok(capturedHarnessRequest);
  assert.equal(
    (capturedHarnessRequest as { instruction: string }).instruction,
    ["/alpha", "", "Draft the follow-up email."].join("\n"),
  );
  assert.deepEqual(
    (
      capturedHarnessRequest as {
        workspace_skill_dirs: string[];
      }
    ).workspace_skill_dirs.map((skillDir) => path.basename(skillDir)),
    [
      "app-builder-sdk",
      "browser-core-efficient",
      "browser-qa",
      "build-dashboard",
      "frontend-design",
      "interface-design",
      "mcp-configurator",
      "skill-creator",
      "skill-installer",
      "alpha",
    ],
  );
});

test("runTsRunnerCli skips workspace command staging for harnesses that do not support it", async () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-pi-commands-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  let stageCommandsCalls = 0;

  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        context: {
          _sandbox_runtime_exec_v1: {
            harness: "pi",
          },
        },
      }),
    ],
    {
      deps: {
        ...testDeps({
          pluginOverrides: {
            stageCommands: () => {
              stageCommandsCalls += 1;
              return { changed: false, commandIds: [] };
            },
          },
        }),
        runHarnessHost: async () => ({
          exitCode: 0,
          stderr: "",
          sawEvent: false,
          terminalEmitted: false,
          lastSequence: 0,
        }),
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(stageCommandsCalls, 0);
});

test(
  "runTsRunnerCli skips skill staging when the harness prep plan disables it",
  { concurrency: false },
  async () => {
    const sandboxRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "hb-ts-runner-pi-skills-"),
    );
    process.env.HB_SANDBOX_ROOT = sandboxRoot;
    const piHarnessAdapter = requireRuntimeHarnessAdapter("pi");
    const originalBuildRunnerPrepPlan = piHarnessAdapter.buildRunnerPrepPlan;
    let stageSkillsCalls = 0;

    piHarnessAdapter.buildRunnerPrepPlan = () => ({
      stageWorkspaceSkills: false,
      stageWorkspaceCommands: false,
      prepareMcpTooling: true,
      startWorkspaceMcpSidecar: true,
      bootstrapResolvedApplications: true,
    });
    try {
      const exitCode = await runTsRunnerCli(
        [
          "--request-base64",
          encodeRequest({
            ...baseRequest(),
            context: {
              _sandbox_runtime_exec_v1: {
                harness: "pi",
              },
            },
          }),
        ],
        {
          deps: {
            ...testDeps({
              pluginOverrides: {
                stageSkills: () => {
                  stageSkillsCalls += 1;
                  return { changed: false, skillIds: [] };
                },
              },
            }),
            runHarnessHost: async () => ({
              exitCode: 0,
              stderr: "",
              sawEvent: false,
              terminalEmitted: false,
              lastSequence: 0,
            }),
          },
          io: {
            stdout: {
              write() {
                return true;
              },
            } as unknown as NodeJS.WritableStream,
            stderr: {
              write() {
                return true;
              },
            } as unknown as NodeJS.WritableStream,
          },
        },
      );

      assert.equal(exitCode, 0);
      assert.equal(stageSkillsCalls, 0);
    } finally {
      piHarnessAdapter.buildRunnerPrepPlan = originalBuildRunnerPrepPlan;
    }
  },
);

test(
  "runTsRunnerCli skips MCP prep when the harness prep plan disables it",
  { concurrency: false },
  async () => {
    const sandboxRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "hb-ts-runner-pi-no-mcp-"),
    );
    process.env.HB_SANDBOX_ROOT = sandboxRoot;
    const piHarnessAdapter = requireRuntimeHarnessAdapter("pi");
    const originalBuildRunnerPrepPlan = piHarnessAdapter.buildRunnerPrepPlan;
    let startWorkspaceMcpSidecarCalls = 0;
    let bootstrapApplicationsCalls = 0;
    let capturedProjectRequest: Record<string, unknown> | null = null;
    let capturedHarnessRequest: Record<string, unknown> | null = null;

    piHarnessAdapter.buildRunnerPrepPlan = () => ({
      stageWorkspaceSkills: true,
      stageWorkspaceCommands: false,
      prepareMcpTooling: false,
      startWorkspaceMcpSidecar: false,
      bootstrapResolvedApplications: false,
    });
    try {
      const exitCode = await runTsRunnerCli(
        [
          "--request-base64",
          encodeRequest({
            ...baseRequest(),
            context: {
              _sandbox_runtime_exec_v1: {
                harness: "pi",
              },
            },
          }),
        ],
        {
          deps: {
            ...testDeps(),
            compilePlan: () =>
              ({
                ...baseCompiledPlan(),
                resolved_mcp_servers: [
                  {
                    server_id: "workspace",
                    type: "local",
                    url: null,
                    headers: [],
                    environment: [],
                    timeout_ms: 20000,
                    enabled: true,
                    command: ["node", "workspace-mcp.js"],
                  },
                ],
                resolved_mcp_tool_refs: [
                  {
                    tool_id: "workspace.lookup",
                    server_id: "workspace",
                    tool_name: "lookup",
                  },
                ],
                workspace_mcp_catalog: [
                  {
                    tool_id: "workspace.lookup",
                    tool_name: "lookup",
                    module_path: "tools/lookup.ts",
                    symbol_name: "lookupTool",
                  },
                ],
                resolved_applications: [
                  {
                    app_id: "app-a",
                    mcp: { transport: "http-sse", port: 3099, path: "/mcp" },
                    health_check: {
                      path: "/health",
                      timeout_s: 60,
                      interval_s: 5,
                    },
                    env_contract: [],
                    start_command: "npm run start",
                    base_dir: "apps/app-a",
                    lifecycle: { setup: "", start: "", stop: "" },
                  },
                ],
              }) as never,
            projectAgentRuntimeConfig: (request) => {
              capturedProjectRequest = request as unknown as Record<
                string,
                unknown
              >;
              return {
                provider_id: "openai",
                model_id: "gpt-5.4",
                mode: "code",
                system_prompt: "You are concise.",
                model_client: {
                  model_proxy_provider: "openai_compatible",
                  api_key: "token",
                  base_url: "http://127.0.0.1:4000/openai/v1",
                  default_headers: { "X-Test": "1" },
                },
                tools: { read: true },
                workspace_tool_ids: [],
                workspace_skill_ids: [],
                output_schema_member_id: null,
                output_format: null,
                workspace_config_checksum: "checksum-1",
              };
            },
            startWorkspaceMcpSidecar: async () => {
              startWorkspaceMcpSidecarCalls += 1;
              return null;
            },
            bootstrapApplications: async () => {
              bootstrapApplicationsCalls += 1;
              return [];
            },
            runHarnessHost: async ({ requestPayload }) => {
              capturedHarnessRequest = requestPayload;
              return {
                exitCode: 0,
                stderr: "",
                sawEvent: false,
                terminalEmitted: false,
                lastSequence: 0,
              };
            },
          },
          io: {
            stdout: {
              write() {
                return true;
              },
            } as unknown as NodeJS.WritableStream,
            stderr: {
              write() {
                return true;
              },
            } as unknown as NodeJS.WritableStream,
          },
        },
      );

      assert.equal(exitCode, 0);
      assert.equal(startWorkspaceMcpSidecarCalls, 0);
      assert.equal(bootstrapApplicationsCalls, 0);
      assert.ok(capturedProjectRequest);
      assert.deepEqual(
        (
          capturedProjectRequest as {
            tool_server_id_map: Record<string, string>;
          }
        ).tool_server_id_map,
        {},
      );
      assert.deepEqual(
        (
          capturedProjectRequest as {
            resolved_mcp_tool_refs: Array<Record<string, string>>;
          }
        ).resolved_mcp_tool_refs,
        [],
      );
      assert.ok(capturedHarnessRequest);
      assert.deepEqual(
        (capturedHarnessRequest as { mcp_servers: unknown[] }).mcp_servers,
        [],
      );
      assert.deepEqual(
        (capturedHarnessRequest as { mcp_tool_refs: unknown[] }).mcp_tool_refs,
        [],
      );
    } finally {
      piHarnessAdapter.buildRunnerPrepPlan = originalBuildRunnerPrepPlan;
    }
  },
);

test("runTsRunnerCli pushes emitted events with retry semantics", async () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-push-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  let stdout = "";
  const attempts: Array<{ eventType: string; sequence: number }> = [];
  const statuses = [500, 204, 204, 204];
  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        ...baseRequest(),
        instruction: "hello",
        context: {
          _sandbox_runtime_push_v1: {
            run_id: "run-1",
            callback_url: "https://runtime.example/push",
            callback_token: "token-1",
            ack_timeout_ms: 500,
            max_retries: 1,
          },
        },
      }),
    ],
    {
      deps: testDeps({
        harnessEvents: [
          {
            session_id: "session-1",
            input_id: "input-1",
            sequence: 1,
            event_type: "run_started",
            timestamp: new Date().toISOString(),
            payload: { phase: "running" },
          },
          {
            session_id: "session-1",
            input_id: "input-1",
            sequence: 2,
            event_type: "run_completed",
            timestamp: new Date().toISOString(),
            payload: { status: "success" },
          },
        ],
      }),
      io: {
        stdout: {
          write(chunk: string) {
            stdout += chunk;
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
      fetchImpl: (async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          event_type: string;
          sequence: number;
        };
        attempts.push({ eventType: body.event_type, sequence: body.sequence });
        const status = statuses.shift() ?? 204;
        return new Response(status === 204 ? null : "", { status });
      }) as typeof fetch,
    },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(
    attempts.map((attempt) => `${attempt.eventType}:${attempt.sequence}`),
    ["run_claimed:1", "run_claimed:1", "run_started:1", "run_completed:2"],
  );
  assert.equal(stdout.trim().split("\n").length, 3);
});

test(
  "runTsRunnerCli passes prepared MCP server ids into runtime config when no explicit MCP tool refs are resolved",
  { concurrency: false },
  async () => {
    const sandboxRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "hb-ts-runner-pi-mcp-server-ids-"),
    );
    process.env.HB_SANDBOX_ROOT = sandboxRoot;
    const piHarnessAdapter = requireRuntimeHarnessAdapter("pi");
    const originalBuildRunnerPrepPlan = piHarnessAdapter.buildRunnerPrepPlan;
    let capturedProjectRequest: Record<string, unknown> | null = null;
    let capturedHarnessRequest: Record<string, unknown> | null = null;

    piHarnessAdapter.buildRunnerPrepPlan = () => ({
      stageWorkspaceSkills: true,
      stageWorkspaceCommands: false,
      prepareMcpTooling: true,
      startWorkspaceMcpSidecar: false,
      bootstrapResolvedApplications: false,
    });
    try {
      const exitCode = await runTsRunnerCli(
        [
          "--request-base64",
          encodeRequest({
            ...baseRequest(),
            context: {
              _sandbox_runtime_exec_v1: {
                harness: "pi",
              },
            },
          }),
        ],
        {
          deps: {
            ...testDeps(),
            compilePlan: () =>
              ({
                ...baseCompiledPlan(),
                resolved_mcp_servers: [
                  {
                    server_id: "context7",
                    type: "remote",
                    url: "https://mcp.context7.com/mcp",
                    headers: [],
                    environment: [],
                    timeout_ms: 15000,
                    enabled: true,
                    command: null,
                  },
                ],
              }) as never,
            projectAgentRuntimeConfig: (request) => {
              capturedProjectRequest = request as unknown as Record<
                string,
                unknown
              >;
              return {
                provider_id: "openai",
                model_id: "gpt-5.4",
                mode: "code",
                system_prompt: "You are concise.",
                model_client: {
                  model_proxy_provider: "openai_compatible",
                  api_key: "token",
                  base_url: "http://127.0.0.1:4000/openai/v1",
                  default_headers: { "X-Test": "1" },
                },
                tools: { read: true },
                workspace_tool_ids: [],
                workspace_skill_ids: [],
                output_schema_member_id: null,
                output_format: null,
                workspace_config_checksum: "checksum-1",
              };
            },
            runHarnessHost: async ({ requestPayload }) => {
              capturedHarnessRequest = requestPayload;
              return {
                exitCode: 0,
                stderr: "",
                sawEvent: false,
                terminalEmitted: false,
                lastSequence: 0,
              };
            },
          },
          io: {
            stdout: {
              write() {
                return true;
              },
            } as unknown as NodeJS.WritableStream,
            stderr: {
              write() {
                return true;
              },
            } as unknown as NodeJS.WritableStream,
          },
        },
      );

      assert.equal(exitCode, 0);
      assert.ok(capturedProjectRequest);
      assert.deepEqual(
        (capturedProjectRequest as { resolved_mcp_server_ids: string[] })
          .resolved_mcp_server_ids,
        ["context7"],
      );
      assert.deepEqual(
        (
          capturedProjectRequest as {
            resolved_mcp_tool_refs: Array<Record<string, string>>;
          }
        ).resolved_mcp_tool_refs,
        [],
      );
      assert.ok(capturedHarnessRequest);
      assert.deepEqual(
        (
          capturedHarnessRequest as { mcp_servers: Array<{ name: string }> }
        ).mcp_servers.map((server) => server.name),
        ["context7"],
      );
      assert.deepEqual(
        (capturedHarnessRequest as { mcp_tool_refs: unknown[] }).mcp_tool_refs,
        [],
      );
    } finally {
      piHarnessAdapter.buildRunnerPrepPlan = originalBuildRunnerPrepPlan;
    }
  },
);

test("runTsRunnerCli synthesizes run_failed when harness-host ends without a terminal event", async () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-no-terminal-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  let stdout = "";
  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({ ...baseRequest(), session_kind: "subagent" }),
    ],
    {
      deps: testDeps({
        harnessEvents: [
          {
            session_id: "session-1",
            input_id: "input-1",
            sequence: 1,
            event_type: "run_started",
            timestamp: new Date().toISOString(),
            payload: { phase: "running" },
          },
        ],
        harnessResult: {
          sawEvent: true,
          terminalEmitted: false,
          lastSequence: 1,
          exitCode: 0,
          stderr: "",
        },
      }),
      io: {
        stdout: {
          write(chunk: string) {
            stdout += chunk;
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  const lines = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 3);
  assert.equal(lines[2].event_type, "run_failed");
  assert.deepEqual(lines[2].payload, {
    type: "RuntimeError",
    message: "TypeScript harness host ended before terminal event",
  });
});

test("runTsRunnerCli appends bootstrapped app MCP servers into the harness-host request", async () => {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hb-ts-runner-apps-"),
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  let capturedRequestPayload: Record<string, unknown> | null = null;

  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({ ...baseRequest(), session_kind: "subagent" }),
    ],
    {
      deps: {
        ...testDeps(),
        compilePlan: () =>
          ({
            ...baseCompiledPlan(),
            resolved_applications: [
              {
                app_id: "app-a",
                mcp: { transport: "http-sse", port: 3099, path: "/mcp" },
                health_check: { path: "/health", timeout_s: 60, interval_s: 5 },
                env_contract: ["HOLABOSS_USER_ID"],
                start_command: "npm run start",
                base_dir: "apps/app-a",
                lifecycle: { setup: "", start: "", stop: "" },
              },
            ],
          }) as never,
        bootstrapApplications: async () => [
          {
            name: "app-a",
            config: {
              type: "remote",
              enabled: true,
              url: "http://localhost:13100/mcp",
              headers: { "X-Workspace-Id": "workspace-1" },
              timeout: 60000,
            },
          },
        ],
        runHarnessHost: async ({ requestPayload }) => {
          capturedRequestPayload = requestPayload;
          return {
            exitCode: 0,
            stderr: "",
            sawEvent: false,
            terminalEmitted: false,
            lastSequence: 0,
          };
        },
      },
      io: {
        stdout: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 0);
  assert.ok(capturedRequestPayload);
  const mcpServers = (
    capturedRequestPayload as { mcp_servers: Array<Record<string, unknown>> }
  ).mcp_servers;
  assert.deepEqual(
    mcpServers.map((server) => server.name),
    ["app-a"],
  );
});

test("resolvedApplicationMcpHeaders includes Holaboss turn context for app MCP calls", () => {
  assert.deepEqual(resolvedApplicationMcpHeaders(baseRequest()), {
    "X-Workspace-Id": "workspace-1",
    "X-Holaboss-Workspace-Id": "workspace-1",
    "X-Holaboss-Session-Id": "session-1",
    "X-Holaboss-Input-Id": "input-1",
  });
});

test("runTsRunnerCli emits validation failures as run_failed JSONL", async () => {
  setTempSandboxRoot("hb-ts-runner-validation-");
  let stdout = "";
  const exitCode = await runTsRunnerCli(
    [
      "--request-base64",
      encodeRequest({
        workspace_id: "workspace-1",
        session_id: "session-1",
        instruction: "hello",
        context: {},
      }),
    ],
    {
      io: {
        stdout: {
          write(chunk: string) {
            stdout += chunk;
            return true;
          },
        } as unknown as NodeJS.WritableStream,
        stderr: {
          write() {
            return true;
          },
        } as unknown as NodeJS.WritableStream,
      },
    },
  );

  assert.equal(exitCode, 1);

  const event = JSON.parse(stdout.trim());
  assert.equal(event.session_id, "session-1");
  assert.equal(event.input_id, "unknown");
  assert.equal(event.event_type, "run_failed");
  assert.equal(event.payload.type, "TsRunnerRequestError");
  assert.match(
    String(event.payload.message),
    /invalid runner request payload: input_id is required/,
  );
});
