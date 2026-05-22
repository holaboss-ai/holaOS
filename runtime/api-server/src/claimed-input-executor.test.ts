import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import {
  processClaimedInput,
  registerWorkspaceAgentRunEvent,
  registerWorkspaceAgentRunStarted,
} from "./claimed-input-executor.js";
import type { MemoryServiceLike } from "./memory.js";
import type { RuntimeSentryCaptureOptions } from "./runtime-sentry.js";
import type { PiContextUsage } from "./session-checkpoint.js";
import {
  persistWorkspaceHarnessSessionId,
  readWorkspaceHarnessSessionId,
} from "./ts-runner-session-state.js";

const tempDirs: string[] = [];
const ORIGINAL_ENV = {
  SANDBOX_AGENT_RUNNER_COMMAND_TEMPLATE:
    process.env.SANDBOX_AGENT_RUNNER_COMMAND_TEMPLATE,
  SANDBOX_AGENT_RUN_TIMEOUT_S: process.env.SANDBOX_AGENT_RUN_TIMEOUT_S,
  SANDBOX_AGENT_RUN_IDLE_TIMEOUT_S:
    process.env.SANDBOX_AGENT_RUN_IDLE_TIMEOUT_S,
  HB_SANDBOX_ROOT: process.env.HB_SANDBOX_ROOT,
  HOLABOSS_RUNTIME_CONFIG_PATH: process.env.HOLABOSS_RUNTIME_CONFIG_PATH,
  HOLABOSS_HARNESS_RUN_TIMEOUT_S: process.env.HOLABOSS_HARNESS_RUN_TIMEOUT_S,
};
const require = createRequire(import.meta.url);
const PI_PACKAGE_ENTRY_PATH = fileURLToPath(
  import.meta.resolve("@mariozechner/pi-coding-agent"),
);
const PI_SESSION_MANAGER_MODULE_PATH = path.join(
  path.dirname(PI_PACKAGE_ENTRY_PATH),
  "core",
  "session-manager.js",
);

function test(
  name: string,
  fn: () => void | Promise<void>,
): ReturnType<typeof nodeTest> {
  return nodeTest(name, { concurrency: false }, fn);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (ORIGINAL_ENV.SANDBOX_AGENT_RUNNER_COMMAND_TEMPLATE === undefined) {
    delete process.env.SANDBOX_AGENT_RUNNER_COMMAND_TEMPLATE;
  } else {
    process.env.SANDBOX_AGENT_RUNNER_COMMAND_TEMPLATE =
      ORIGINAL_ENV.SANDBOX_AGENT_RUNNER_COMMAND_TEMPLATE;
  }
  if (ORIGINAL_ENV.SANDBOX_AGENT_RUN_TIMEOUT_S === undefined) {
    delete process.env.SANDBOX_AGENT_RUN_TIMEOUT_S;
  } else {
    process.env.SANDBOX_AGENT_RUN_TIMEOUT_S =
      ORIGINAL_ENV.SANDBOX_AGENT_RUN_TIMEOUT_S;
  }
  if (ORIGINAL_ENV.SANDBOX_AGENT_RUN_IDLE_TIMEOUT_S === undefined) {
    delete process.env.SANDBOX_AGENT_RUN_IDLE_TIMEOUT_S;
  } else {
    process.env.SANDBOX_AGENT_RUN_IDLE_TIMEOUT_S =
      ORIGINAL_ENV.SANDBOX_AGENT_RUN_IDLE_TIMEOUT_S;
  }
  if (ORIGINAL_ENV.HB_SANDBOX_ROOT === undefined) {
    delete process.env.HB_SANDBOX_ROOT;
  } else {
    process.env.HB_SANDBOX_ROOT = ORIGINAL_ENV.HB_SANDBOX_ROOT;
  }
  if (ORIGINAL_ENV.HOLABOSS_RUNTIME_CONFIG_PATH === undefined) {
    delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  } else {
    process.env.HOLABOSS_RUNTIME_CONFIG_PATH =
      ORIGINAL_ENV.HOLABOSS_RUNTIME_CONFIG_PATH;
  }
  if (ORIGINAL_ENV.HOLABOSS_HARNESS_RUN_TIMEOUT_S === undefined) {
    delete process.env.HOLABOSS_HARNESS_RUN_TIMEOUT_S;
  } else {
    process.env.HOLABOSS_HARNESS_RUN_TIMEOUT_S =
      ORIGINAL_ENV.HOLABOSS_HARNESS_RUN_TIMEOUT_S;
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function makeStore(prefix: string): RuntimeStateStore {
  const root = makeTempDir(prefix);
  return new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspaces"),
  });
}

function setNodeRunnerCommand(lines: string[]): void {
  const scriptBase64 = Buffer.from(lines.join("\n"), "utf8").toString("base64");
  process.env.SANDBOX_AGENT_RUNNER_COMMAND_TEMPLATE = `printf '%s' '${scriptBase64}' | base64 --decode | {runtime_node} - {request_base64}`;
}

function openPiSessionManager(sessionFile: string) {
  const { SessionManager } = require(PI_SESSION_MANAGER_MODULE_PATH) as {
    SessionManager: {
      create: (cwd: string, sessionDir?: string) => {
        appendMessage: (message: Record<string, unknown>) => string;
        appendCompaction: (
          summary: string,
          firstKeptEntryId: string,
          tokensBefore: number,
          details?: unknown,
          fromHook?: boolean,
        ) => string | undefined;
        buildSessionContext: () => {
          messages: Array<Record<string, unknown>>;
        };
        getBranch: () => Array<Record<string, unknown>>;
        getEntries: () => Array<Record<string, unknown>>;
        getSessionFile: () => string | undefined;
      };
      open: (sessionFile: string) => {
        appendCompaction: (
          summary: string,
          firstKeptEntryId: string,
          tokensBefore: number,
          details?: unknown,
          fromHook?: boolean,
        ) => string | undefined;
        buildSessionContext: () => {
          messages: Array<Record<string, unknown>>;
        };
        getBranch: () => Array<Record<string, unknown>>;
        getEntries: () => Array<Record<string, unknown>>;
        getSessionFile: () => string | undefined;
      };
    };
  };
  return SessionManager.open(sessionFile);
}

function createPiSessionFile(params: {
  workspaceDir: string;
  sessionDir: string;
}) {
  fs.mkdirSync(params.sessionDir, { recursive: true });
  const { SessionManager } = require(PI_SESSION_MANAGER_MODULE_PATH) as {
    SessionManager: {
      create: (cwd: string, sessionDir?: string) => {
        appendMessage: (message: Record<string, unknown>) => string;
        appendCompaction: (
          summary: string,
          firstKeptEntryId: string,
          tokensBefore: number,
          details?: unknown,
          fromHook?: boolean,
        ) => string | undefined;
        buildSessionContext: () => {
          messages: Array<Record<string, unknown>>;
        };
        getBranch: () => Array<Record<string, unknown>>;
        getEntries: () => Array<Record<string, unknown>>;
        getSessionFile: () => string | undefined;
      };
    };
  };
  const sessionManager = SessionManager.create(
    params.workspaceDir,
    params.sessionDir,
  );
  const sessionFile = sessionManager.getSessionFile();
  assert.ok(sessionFile);
  return {
    sessionManager,
    sessionFile,
  };
}

function latestPiCompactionEntry(
  sessionFile: string,
): Record<string, unknown> | null {
  const branch = openPiSessionManager(sessionFile).getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === "compaction") {
      return entry;
    }
  }
  return null;
}

function upsertTurnRequestSnapshotFixture(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sessionId: string;
  inputId: string;
  model: string;
  providerId: string;
  modelId: string;
  modelProxyProvider?: string;
  systemPrompt?: string;
  instructionSize?: number;
}): void {
  const instructionSize = Math.max(1, params.instructionSize ?? 1024);
  const workspaceDir = params.store.workspaceDir(params.workspaceId);
  params.store.upsertTurnRequestSnapshot({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    inputId: params.inputId,
    snapshotKind: "harness_host_request",
    fingerprint: `snapshot-${params.inputId}`,
    payload: {
      schema_version: 1,
      snapshot_kind: "harness_host_request",
      workspace_id: params.workspaceId,
      session_id: params.sessionId,
      input_id: params.inputId,
      runtime_config: {
        provider_id: params.providerId,
        model_id: params.modelId,
        system_prompt: params.systemPrompt ?? "System prompt",
        context_messages: [],
        tools: {},
        workspace_tool_ids: [],
        workspace_skill_ids: [],
        workspace_config_checksum: `checksum-${params.workspaceId}`,
        model_client: {
          model_proxy_provider:
            params.modelProxyProvider ?? "openai_compatible",
          base_url: "https://runtime.example/api/v1/model-proxy",
          default_headers: {
            "X-API-Key": "snapshot-key",
          },
        },
      },
      harness_request: {
        workspace_id: params.workspaceId,
        workspace_dir: workspaceDir,
        session_id: params.sessionId,
        browser_tools_enabled: false,
        browser_space: null,
        input_id: params.inputId,
        context_messages: [],
        tools: {},
        provider_id: params.providerId,
        model_id: params.modelId,
        model: params.model,
        instruction: "x".repeat(instructionSize),
        attachments: [],
        image_urls: [],
        thinking_value: null,
        debug: false,
        harness_session_id: null,
        persisted_harness_session_id: null,
        timeout_seconds: 1800,
        runtime_api_base_url: null,
        system_prompt: params.systemPrompt ?? "System prompt",
        workspace_skill_dirs: [],
        mcp_servers: [],
        mcp_tool_refs: [],
        workspace_config_checksum: `checksum-${params.workspaceId}`,
        run_started_payload: null,
        model_client: {
          model_proxy_provider:
            params.modelProxyProvider ?? "openai_compatible",
          api_key: "runtime-api-key",
          base_url: "https://runtime.example/api/v1/model-proxy",
          default_headers: {
            "X-API-Key": "runtime-api-key",
          },
        },
      },
    },
  });
}

function piUserMessage(text: string): Record<string, unknown> {
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  };
}

function piAssistantMessage(text: string): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "responses",
    provider: "openai",
    model: "gpt-test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function piSessionMessageTexts(sessionFile: string): string[] {
  const context = openPiSessionManager(sessionFile).buildSessionContext();
  return context.messages.map((message) => {
    const content = message.content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .filter(
          (entry): entry is { type: string; text?: string } =>
            Boolean(entry) && typeof entry === "object",
        )
        .map((entry) => (entry.type === "text" ? entry.text ?? "" : ""))
        .join("");
    }
    return "";
  });
}

function writeRuntimeConfigDocument(document: Record<string, unknown>): string {
  const root = makeTempDir("hb-runtime-config-");
  const configPath = path.join(root, "state", "runtime-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(document, null, 2)}\n`,
    "utf8",
  );
  return configPath;
}

function outputEventsForInput(
  store: RuntimeStateStore,
  record: { workspaceId: string; sessionId: string; inputId: string },
) {
  return store.listOutputEvents({
    workspaceId: record.workspaceId,
    sessionId: record.sessionId,
    inputId: record.inputId,
  });
}

function turnResultForInput(
  store: RuntimeStateStore,
  record: { workspaceId: string; inputId: string },
) {
  return store.getTurnResult({
    workspaceId: record.workspaceId,
    inputId: record.inputId,
  });
}

function turnRequestSnapshotForInput(
  store: RuntimeStateStore,
  record: { workspaceId: string; inputId: string },
) {
  return store.getTurnRequestSnapshot({
    workspaceId: record.workspaceId,
    inputId: record.inputId,
  });
}

function createSubagentRunFixture(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  mainSessionId?: string;
  childSessionId?: string;
  title?: string;
  goal?: string;
  inputText?: string;
}) {
  const mainSessionId = params.mainSessionId ?? "session-main";
  const childSessionId = params.childSessionId ?? "session-subagent";
  params.store.ensureSession({
    workspaceId: params.workspaceId,
    sessionId: mainSessionId,
    kind: "main_session",
  });
  params.store.ensureSession({
    workspaceId: params.workspaceId,
    sessionId: childSessionId,
    kind: "subagent",
    parentSessionId: mainSessionId,
  });
  const queued = params.store.enqueueInput({
    workspaceId: params.workspaceId,
    sessionId: childSessionId,
    payload: { text: params.inputText ?? "handle the delegated task" },
  });
  const run = params.store.createSubagentRun({
    workspaceId: params.workspaceId,
    parentSessionId: mainSessionId,
    parentInputId: "parent-input-1",
    originMainSessionId: mainSessionId,
    ownerMainSessionId: mainSessionId,
    childSessionId,
    initialChildInputId: queued.inputId,
    currentChildInputId: queued.inputId,
    latestChildInputId: queued.inputId,
    title: params.title ?? "Delegated task",
    goal: params.goal ?? "Complete delegated work",
    status: "queued",
  });
  return { queued, run };
}

test("claimed input marks missing workspace failed and runtime error", async () => {
  const store = makeStore("hb-claimed-input-missing-workspace-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "hello" },
  });
  store.deleteWorkspace(workspace.id);

  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });

  assert.equal(claimed.length, 1);

  await processClaimedInput({
    store,
    record: claimed[0],
  });

  const updated = store.getInput({ workspaceId: workspace.id, inputId: queued.inputId });
  const runtimeState = store.getRuntimeState({
    workspaceId: workspace.id,
    sessionId: "session-main",
  });
  const events = outputEventsForInput(store, queued);
  const turnResult = turnResultForInput(store, queued);

  assert.ok(updated);
  assert.equal(updated.status, "FAILED");
  assert.ok(runtimeState);
  assert.equal(runtimeState.status, "ERROR");
  assert.deepEqual(runtimeState.lastError, { message: "workspace not found" });
  assert.deepEqual(events, []);
  assert.ok(turnResult);
  assert.equal(turnResult.status, "failed");
  assert.equal(turnResult.stopReason, "workspace_not_found");
  assert.equal(turnResult.assistantText, "");
  assert.deepEqual(turnResult.toolUsageSummary, {
    total_calls: 0,
    completed_calls: 0,
    failed_calls: 0,
    tool_names: [],
    tool_ids: [],
  });

  store.close();
});

test("claimed input persists runner events, assistant text, and idle state on success", async () => {
  const store = makeStore("hb-claimed-input-success-");
  let scheduledEvolveTasks = 0;
  let eventTypesAtSchedule: string[] = [];
  const memoryService: MemoryServiceLike = {
    async search() {
      return { results: [] };
    },
    async get() {
      return { path: "", text: "" };
    },
    async upsert(payload: Record<string, unknown>) {
      return { path: payload.path, text: payload.content };
    },
    async status() {
      return {};
    },
    async sync() {
      return {};
    },
  };
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "hello" },
  });
  setNodeRunnerCommand([
    "const request = process.argv.at(-1) ?? '';",
    "void request;",
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 1, event_type: 'run_started', payload: { instruction_preview: 'hello', prompt_section_ids: ['runtime_core', 'execution_policy', 'capability_policy'], capability_manifest_fingerprint: 'a'.repeat(64), request_snapshot_fingerprint: 'b'.repeat(64), prompt_cache_profile: { cacheable_section_ids: ['runtime_core', 'execution_policy'], volatile_section_ids: ['capability_policy'] } } }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 2, event_type: 'tool_call', payload: { phase: 'started', tool_name: 'read_file', call_id: 'call-1', error: false } }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 3, event_type: 'tool_call', payload: { phase: 'completed', tool_name: 'read_file', call_id: 'call-1', error: false } }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 4, event_type: 'tool_call', payload: { phase: 'started', tool_name: 'skill', call_id: 'call-skill', tool_args: { name: 'customer_lookup' }, error: false } }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 5, event_type: 'skill_invocation', payload: { phase: 'started', call_id: 'call-skill', requested_name: 'customer_lookup', skill_name: 'customer_lookup', skill_id: 'customer_lookup', error: false } }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 6, event_type: 'tool_call', payload: { phase: 'completed', tool_name: 'skill', call_id: 'call-skill', tool_args: { name: 'customer_lookup' }, error: false } }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 7, event_type: 'skill_invocation', payload: { phase: 'completed', call_id: 'call-skill', requested_name: 'customer_lookup', skill_name: 'customer_lookup', skill_id: 'customer_lookup', widening_scope: 'run', workspace_boundary_override: false, managed_tools: ['bash', 'deploy'], granted_tools: ['deploy'], active_granted_tools: ['deploy'], managed_commands: ['deploy-docs'], granted_commands: ['deploy-docs'], active_granted_commands: ['deploy-docs'], error: false } }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 8, event_type: 'tool_call', payload: { phase: 'completed', tool_name: 'deploy', tool_id: 'workspace.deploy', call_id: 'call-2', error: true, message: 'permission denied by policy' } }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 9, event_type: 'output_delta', payload: { delta: 'Hello from TS' } }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 10, event_type: 'run_completed', payload: { status: 'ok', usage: { input_tokens: 12, output_tokens: 34 } } }) + '\\n');`,
  ]);

  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });
  let terminalPersistedBeforeDone = false;
  const originalUpdateInput = store.updateInput.bind(store);
  store.updateInput = ((
    ...args: Parameters<typeof store.updateInput>
  ): ReturnType<typeof store.updateInput> => {
    const [params] = args;
    if (params.inputId === queued.inputId && params.fields.status === "DONE") {
      terminalPersistedBeforeDone = outputEventsForInput(store, queued).some(
        (event) => event.eventType === "run_completed"
      );
    }
    return originalUpdateInput(...args);
  }) as typeof store.updateInput;

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
    memoryService,
    runEvolveTasksFn: async (options) => {
      scheduledEvolveTasks += 1;
      eventTypesAtSchedule = outputEventsForInput(store, options.record).map(
        (event) => event.eventType
      );
    },
  });

  const updated = store.getInput({ workspaceId: workspace.id, inputId: queued.inputId });
  const runtimeState = store.getRuntimeState({
    workspaceId: workspace.id,
    sessionId: "session-main",
  });
  const events = outputEventsForInput(store, queued);
  const messages = store.listSessionMessages({
    workspaceId: workspace.id,
    sessionId: "session-main",
  });
  const turnResult = turnResultForInput(store, queued);

  assert.ok(updated);
  assert.equal(updated.status, "DONE");
  assert.ok(runtimeState);
  assert.equal(runtimeState.status, "IDLE");
  assert.equal(runtimeState.currentInputId, null);
  assert.equal(runtimeState.currentWorkerId, null);
  assert.equal(runtimeState.lastError, null);
  assert.equal(terminalPersistedBeforeDone, true);
  assert.deepEqual(
    events.map((event) => event.eventType),
    [
      "run_started",
      "tool_call",
      "tool_call",
      "tool_call",
      "skill_invocation",
      "tool_call",
      "skill_invocation",
      "tool_call",
      "output_delta",
      "run_completed",
    ],
  );
  assert.equal(scheduledEvolveTasks, 1);
  assert.deepEqual(eventTypesAtSchedule, [
    "run_started",
    "tool_call",
    "tool_call",
    "tool_call",
    "skill_invocation",
    "tool_call",
    "skill_invocation",
    "tool_call",
    "output_delta",
    "run_completed",
  ]);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, `user-${queued.inputId}`);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].text, "hello");
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].text, "Hello from TS");
  assert.ok(turnResult);
  assert.equal(turnResult.status, "completed");
  assert.equal(turnResult.stopReason, "ok");
  assert.equal(turnResult.assistantText, "Hello from TS");
  assert.deepEqual(turnResult.promptSectionIds, [
    "runtime_core",
    "execution_policy",
    "capability_policy",
  ]);
  assert.equal(turnResult.capabilityManifestFingerprint, "a".repeat(64));
  assert.equal(turnResult.requestSnapshotFingerprint, "b".repeat(64));
  assert.deepEqual(turnResult.promptCacheProfile, {
    cacheable_section_ids: ["runtime_core", "execution_policy"],
    volatile_section_ids: ["capability_policy"],
  });
  assert.deepEqual(turnResult.toolUsageSummary, {
    total_calls: 3,
    completed_calls: 2,
    failed_calls: 1,
    tool_names: ["deploy", "read_file", "skill"],
    tool_ids: ["workspace.deploy"],
    skill_invocations: {
      total_calls: 1,
      completed_calls: 1,
      failed_calls: 0,
      skill_names: ["customer_lookup"],
      skill_ids: ["customer_lookup"],
    },
    skill_policy_widening: {
      scope: "run",
      workspace_boundary_override: false,
      managed_tools: ["bash", "deploy"],
      granted_tools: ["deploy"],
      active_granted_tools: ["deploy"],
      managed_commands: ["deploy-docs"],
      granted_commands: ["deploy-docs"],
      active_granted_commands: ["deploy-docs"],
      activation_count: 1,
      denied_calls: 0,
      denied_tool_names: [],
    },
  });
  assert.deepEqual(turnResult.permissionDenials, [
    {
      tool_name: "deploy",
      tool_id: "workspace.deploy",
      reason: "permission denied by policy",
    },
  ]);
  assert.deepEqual(turnResult.tokenUsage, {
    input_tokens: 12,
    output_tokens: 34,
  });
  const snapshot = turnRequestSnapshotForInput(store, queued);
  assert.ok(snapshot);
  assert.equal(snapshot?.snapshotKind, "harness_host_request");
  assert.equal(snapshot?.workspaceId, workspace.id);
  assert.equal(snapshot?.sessionId, queued.sessionId);
  assert.equal(snapshot?.inputId, queued.inputId);

  store.close();
});

test("claimed input persists user attachment metadata on the session message", async () => {
  const store = makeStore("hb-claimed-input-attachment-metadata-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const workspaceDir = store.workspaceDir(workspace.id);
  const attachmentRelativePath = ".holaboss/input-attachments/batch-1/report.html";
  const attachmentAbsolutePath = path.join(workspaceDir, attachmentRelativePath);
  fs.mkdirSync(path.dirname(attachmentAbsolutePath), { recursive: true });
  fs.writeFileSync(attachmentAbsolutePath, "<html><body>report</body></html>", "utf8");
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: {
      text: "use this report",
      attachments: [
        {
          id: "attachment-1",
          kind: "file",
          name: "report.html",
          mime_type: "text/html",
          size_bytes: 32,
          workspace_path: attachmentRelativePath,
        },
      ],
    },
  });

  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });

  await processClaimedInput({
    store,
    record: claimed[0],
    executeRunnerRequestFn: async (_payload, options = {}) => {
      await options.onEvent?.({
        session_id: "session-main",
        input_id: queued.inputId,
        sequence: 1,
        event_type: "run_started",
        payload: {
          instruction_preview: "use this report",
          prompt_section_ids: ["runtime_core"],
          prompt_cache_profile: {
            cacheable_section_ids: ["runtime_core"],
            volatile_section_ids: [],
          },
        },
      });
      await options.onEvent?.({
        session_id: "session-main",
        input_id: queued.inputId,
        sequence: 2,
        event_type: "run_completed",
        payload: { status: "ok" },
      });
      return {
        events: [],
        skippedLines: [],
        stderr: "",
        returnCode: 0,
        sawTerminal: false,
      };
    },
  });

  const messages = store.listSessionMessages({
    workspaceId: workspace.id,
    sessionId: "session-main",
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.id, `user-${queued.inputId}`);
  assert.deepEqual(messages[0]?.metadata, {
    attachments: [
      {
        id: "attachment-1",
        kind: "file",
        name: "report.html",
        mime_type: "text/html",
        size_bytes: 32,
        workspace_path: attachmentRelativePath,
      },
    ],
  });

  store.close();
});

test("claimed input persists context-budget telemetry from replay clipping and checkpoint queueing", async () => {
  const store = makeStore("hb-claimed-input-context-budget-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "summarize this run" },
  });

  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });

  await processClaimedInput({
    store,
    record: claimed[0],
    executeRunnerRequestFn: async (_payload, options = {}) => {
      await options.onEvent?.({
        session_id: "session-main",
        input_id: queued.inputId,
        sequence: 1,
        event_type: "run_started",
        payload: {
          instruction_preview: "summarize this run",
          prompt_section_ids: ["runtime_core"],
          prompt_cache_profile: {
            cacheable_section_ids: ["runtime_core"],
            volatile_section_ids: [],
          },
        },
      });
      await options.onEvent?.({
        session_id: "session-main",
        input_id: queued.inputId,
        sequence: 2,
        event_type: "tool_call",
        payload: {
          phase: "completed",
          tool_name: "web_search",
          tool_id: "web_search",
          call_id: "call-1",
          error: false,
          result: {
            content: [
              {
                type: "text",
                text: "{\"note\":\"Inline replay omitted because the per-turn replay budget was exhausted.\"}",
              },
            ],
            details: {
              tool_id: "web_search",
              replay_budget: {
                mode: "reference_only",
                trimmed: true,
                trim_reason: "max_replay_chars",
                replay_chars: 25000,
                total_replay_chars: 24000,
                max_replay_chars: 24000,
                total_replay_items: 2,
                max_replay_items: 8,
              },
            },
          },
        },
      });
      await options.onEvent?.({
        session_id: "session-main",
        input_id: queued.inputId,
        sequence: 3,
        event_type: "run_completed",
        payload: {
          status: "ok",
          usage: { input_tokens: 20, output_tokens: 10 },
          context_usage: { tokens: 99000, context_window: 100000 },
          harness_session_id: path.join(
            store.workspaceDir(workspace.id),
            "pi-session.json",
          ),
        },
      });
      return {
        events: [],
        skippedLines: [],
        stderr: "",
        returnCode: 0,
        aborted: false,
        sawTerminal: true,
        abortReason: null,
      };
    },
    enqueueSessionCheckpointJobFn: () =>
      ({
        jobId: 1,
        jobType: "session_checkpoint",
        workspaceId: workspace.id,
        sessionId: "session-main",
        inputId: queued.inputId,
        status: "QUEUED",
        attempts: 0,
        priority: 10,
        payload: {},
        idempotencyKey: "checkpoint-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        claimedBy: null,
        claimedUntil: null,
        startedAt: null,
        completedAt: null,
        lastError: null,
      }) as never,
    runEvolveTasksFn: async () => {},
  });

  const turnResult = turnResultForInput(store, queued);
  const events = outputEventsForInput(store, queued);
  const terminalEvent = events.at(-1);
  const terminalBudgetDecisions = recordValue(
    terminalEvent?.payload.context_budget_decisions,
  );

  assert.ok(turnResult);
  assert.equal(turnResult.contextBudgetDecisions?.pressure_stage, "queue_checkpoint");
  assert.deepEqual(turnResult.contextBudgetDecisions?.lane_decisions, []);
  assert.equal(turnResult.contextBudgetDecisions?.prompt_cache_stable_candidate, true);
  assert.equal(turnResult.contextBudgetDecisions?.tool_replay_trimmed, true);
  assert.equal(turnResult.contextBudgetDecisions?.retrieval_clipped, false);
  assert.equal(turnResult.contextBudgetDecisions?.checkpoint_queued, true);
  assert.equal(terminalEvent?.eventType, "run_completed");
  assert.equal(terminalBudgetDecisions?.pressure_stage, "queue_checkpoint");
  assert.deepEqual(terminalBudgetDecisions?.lane_decisions, []);
  assert.equal(terminalBudgetDecisions?.prompt_cache_stable_candidate, true);
  assert.equal(terminalBudgetDecisions?.tool_replay_trimmed, true);
  assert.equal(terminalBudgetDecisions?.retrieval_clipped, false);
  assert.equal(terminalBudgetDecisions?.checkpoint_queued, true);

  store.close();
});

test("claimed input summarizes browser tool usage and browser telemetry", async () => {
  const store = makeStore("hb-claimed-input-browser-telemetry-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "check browser flow" },
  });
  setNodeRunnerCommand([
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 1, event_type: 'run_started', payload: {} }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 2, event_type: 'tool_call', payload: { phase: 'completed', tool_name: 'browser_get_state', tool_id: 'browser_get_state', call_id: 'call-browser-state', error: false, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, page: { url: 'https://example.com' }, state: { url: 'https://example.com', text: 'Visible text', elements: [{ index: 1 }], media: [] } }, null, 2) }], details: { tool_id: 'browser_get_state', browser_usage: { tool_id: 'browser_get_state', detail: 'compact', truncated: true, page_text_chars: 120 } } } } }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 3, event_type: 'tool_call', payload: { phase: 'completed', tool_name: 'browser_wait', tool_id: 'browser_wait', call_id: 'call-browser-wait', error: false, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, wait: { matched: true } }, null, 2) }], details: { tool_id: 'browser_wait', browser_usage: { tool_id: 'browser_wait', condition: 'function' } } } } }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 4, event_type: 'tool_call', payload: { phase: 'completed', tool_name: 'browser_type', tool_id: 'browser_type', call_id: 'call-browser-type', error: false, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, action: { ok: true }, page: { url: 'https://example.com/search' }, state: { url: 'https://example.com/search', elements: [{ index: 1 }], media: [] } }, null, 2) }], details: { tool_id: 'browser_type', browser_usage: { tool_id: 'browser_type', detail: 'compact', post_state: 'state', wait_condition: 'function', page_text_chars: 0 } } } } }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 5, event_type: 'run_completed', payload: { status: 'ok' } }) + '\\n');`,
  ]);

  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
  });

  const turnResult = turnResultForInput(store, queued);
  assert.ok(turnResult);
  assert.deepEqual(turnResult.toolUsageSummary, {
    total_calls: 3,
    completed_calls: 3,
    failed_calls: 0,
    tool_names: ["browser_get_state", "browser_type", "browser_wait"],
    tool_ids: ["browser_get_state", "browser_type", "browser_wait"],
    browser: {
      total_calls: 3,
      state_reads: 2,
      compact_state_reads: 2,
      standard_state_reads: 0,
      truncated_state_reads: 1,
      action_calls: 1,
      wait_calls: 1,
      find_calls: 0,
      screenshot_calls: 0,
      page_text_chars: 120,
    },
  });
  assert.equal(
    (turnResult.contextBudgetDecisions?.metrics as Record<string, unknown> | undefined)?.browser_tool_calls,
    3,
  );
  assert.equal(
    (turnResult.contextBudgetDecisions?.metrics as Record<string, unknown> | undefined)?.browser_state_reads,
    2,
  );
  assert.equal(
    (turnResult.contextBudgetDecisions?.metrics as Record<string, unknown> | undefined)?.browser_compact_state_reads,
    2,
  );
  assert.equal(
    (turnResult.contextBudgetDecisions?.metrics as Record<string, unknown> | undefined)?.browser_action_calls,
    1,
  );
  assert.equal(
    (turnResult.contextBudgetDecisions?.metrics as Record<string, unknown> | undefined)?.browser_wait_calls,
    1,
  );
  assert.equal(
    (turnResult.contextBudgetDecisions?.metrics as Record<string, unknown> | undefined)?.browser_truncated_state_reads,
    1,
  );
  assert.equal(
    (turnResult.contextBudgetDecisions?.metrics as Record<string, unknown> | undefined)?.browser_page_text_chars,
    120,
  );
  assert.ok(
    Number(
      (turnResult.contextBudgetDecisions?.metrics as Record<string, unknown> | undefined)?.browser_snapshot_bytes ?? 0,
    ) > 0,
  );

  store.close();
});

test("claimed input creates a completion notification for successful cronjob session runs", async () => {
  const store = makeStore("hb-claimed-input-cronjob-success-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-main",
    kind: "main_session",
    title: "Main Session",
    createdBy: "workspace_user",
  });
  const job = store.createCronjob({
    workspaceId: workspace.id,
    initiatedBy: "workspace_agent",
    name: "daily-sync",
    cron: "0 9 * * *",
    description: "Daily sync",
    instruction: "Sync the workspace.",
    delivery: { channel: "session_run" },
    metadata: {
      notification_title: "Daily Run",
      notification_priority: "high",
      source_session_id: "session-main",
    },
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-cron",
    kind: "cronjob",
    title: "Daily sync",
    createdBy: "workspace_agent",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-cron",
    payload: {
      text: "Sync the workspace.",
      context: {
        source: "cronjob",
        cronjob_id: job.id,
      },
    },
  });
  setNodeRunnerCommand([
    "const request = process.argv.at(-1) ?? '';",
    "void request;",
    `process.stdout.write(JSON.stringify({ session_id: 'session-cron', input_id: '${queued.inputId}', sequence: 1, event_type: 'run_started', payload: { instruction_preview: 'Sync the workspace.' } }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ session_id: 'session-cron', input_id: '${queued.inputId}', sequence: 2, event_type: 'output_delta', payload: { delta: 'Hello from cron' } }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ session_id: 'session-cron', input_id: '${queued.inputId}', sequence: 3, event_type: 'run_completed', payload: { status: 'ok' } }) + '\\n');`,
  ]);

  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
  });

  const notifications = store.listRuntimeNotifications({
    workspaceId: workspace.id,
  });
  const queuedEvents = store.listPendingMainSessionEvents({ workspaceId: workspace.id, ownerMainSessionId: "session-main",
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.title, "Daily Run Completed");
  assert.equal(notifications[0]?.message, "Hello from cron");
  assert.equal(notifications[0]?.level, "success");
  assert.equal(notifications[0]?.priority, "high");
  assert.equal(notifications[0]?.cronjobId, job.id);
  assert.equal(notifications[0]?.metadata.session_id, "session-cron");
  assert.equal(notifications[0]?.metadata.input_id, queued.inputId);
  assert.equal(notifications[0]?.metadata.turn_status, "completed");
  assert.equal(notifications[0]?.metadata.stop_reason, "ok");
  assert.equal(queuedEvents.length, 1);
  assert.equal(queuedEvents[0]?.eventType, "completed");
  assert.equal(queuedEvents[0]?.deliveryBucket, "background_update");
  assert.equal(queuedEvents[0]?.payload.cronjob_id, job.id);
  assert.equal(queuedEvents[0]?.payload.source_type, "cronjob");
  assert.equal(queuedEvents[0]?.payload.cronjob_name, "daily-sync");
  assert.equal(queuedEvents[0]?.payload.title, "Daily Sync");
  assert.equal(queuedEvents[0]?.payload.goal, "Daily sync");
  assert.equal(queuedEvents[0]?.payload.context, "Sync the workspace.");
  assert.equal(queuedEvents[0]?.payload.summary, "Hello from cron");
  assert.equal(queuedEvents[0]?.payload.cronjob_schedule, "0 9 * * *");
  assert.equal(queuedEvents[0]?.payload.cronjob_first_run, true);
  assert.equal(queuedEvents[0]?.payload.cronjob_delivery_channel, "session_run");
  assert.equal(queuedEvents[0]?.payload.cronjob_delivery_mode, "announce");

  store.close();
});

test("claimed input creates a completion notification for failed cronjob session runs", async () => {
  const store = makeStore("hb-claimed-input-cronjob-failure-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const job = store.createCronjob({
    workspaceId: workspace.id,
    initiatedBy: "workspace_agent",
    name: "daily-sync",
    cron: "0 9 * * *",
    description: "Daily sync",
    instruction: "Sync the workspace.",
    delivery: { channel: "session_run" },
    metadata: {
      notification_title: "Daily Run",
    },
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-cron",
    kind: "cronjob",
    title: "Daily sync",
    createdBy: "workspace_agent",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-cron",
    payload: {
      text: "Sync the workspace.",
      context: {
        source: "cronjob",
        cronjob_id: job.id,
      },
    },
  });
  setNodeRunnerCommand([
    "const request = process.argv.at(-1) ?? '';",
    "void request;",
    `process.stdout.write(JSON.stringify({ session_id: 'session-cron', input_id: '${queued.inputId}', sequence: 1, event_type: 'run_started', payload: { instruction_preview: 'Sync the workspace.' } }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ session_id: 'session-cron', input_id: '${queued.inputId}', sequence: 2, event_type: 'run_failed', payload: { type: 'ProviderError', message: 'boom' } }) + '\\n');`,
  ]);

  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
  });

  const notifications = store.listRuntimeNotifications({
    workspaceId: workspace.id,
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.title, "Daily Run Failed");
  assert.equal(notifications[0]?.message, "Run failed: ProviderError.");
  assert.equal(notifications[0]?.level, "error");
  assert.equal(notifications[0]?.priority, "normal");
  assert.equal(notifications[0]?.cronjobId, job.id);
  assert.equal(notifications[0]?.metadata.session_id, "session-cron");
  assert.equal(notifications[0]?.metadata.input_id, queued.inputId);
  assert.equal(notifications[0]?.metadata.turn_status, "failed");
  assert.equal(notifications[0]?.metadata.stop_reason, "ProviderError");

  store.close();
});

test("claimed input creates a completion notification for completed main-session runs", async () => {
  const store = makeStore("hb-claimed-input-main-session-notification-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-main",
    kind: "main_session",
    title: "Main Session",
    createdBy: "workspace_user",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "hello" },
  });
  setNodeRunnerCommand([
    "const request = process.argv.at(-1) ?? '';",
    "void request;",
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 1, event_type: 'run_started', payload: { instruction_preview: 'hello' } }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 2, event_type: 'output_delta', payload: { delta: 'Hello from the main session.' } }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 3, event_type: 'run_completed', payload: { status: 'ok' } }) + '\\n');`,
  ]);

  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
  });

  const notifications = store.listRuntimeNotifications({
    workspaceId: workspace.id,
    sourceType: "main_session",
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.title, "Workspace 1 — Reply ready");
  assert.equal(notifications[0]?.message, "Hello from the main session.");
  assert.equal(notifications[0]?.level, "info");
  assert.equal(notifications[0]?.sourceType, "main_session");
  assert.equal(notifications[0]?.metadata.session_id, "session-main");
  assert.equal(notifications[0]?.metadata.input_id, queued.inputId);
  assert.equal(notifications[0]?.metadata.turn_status, "completed");
  assert.equal(notifications[0]?.metadata.activation_state, "dismissed");

  store.close();
});

test("claimed input persists waiting_user terminal status for harnesses that support it", async () => {
  const store = makeStore("hb-claimed-input-pi-waiting-user-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "hello" },
  });
  setNodeRunnerCommand([
    "const request = process.argv.at(-1) ?? '';",
    "void request;",
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 1, event_type: 'run_started', payload: { instruction_preview: 'hello' } }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 2, event_type: 'run_completed', payload: { status: 'waiting_user' } }) + '\\n');`,
  ]);

  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
  });

  const updated = store.getInput({ workspaceId: workspace.id, inputId: queued.inputId });
  const runtimeState = store.getRuntimeState({
    workspaceId: workspace.id,
    sessionId: "session-main",
  });
  const turnResult = turnResultForInput(store, queued);

  assert.ok(updated);
  assert.equal(updated.status, "DONE");
  assert.ok(runtimeState);
  assert.equal(runtimeState.status, "WAITING_USER");
  assert.ok(turnResult);
  assert.equal(turnResult.status, "waiting_user");
  assert.equal(turnResult.stopReason, "waiting_user");

  store.close();
});

test("claimed input persists a paused turn when the run is aborted mid-execution", async () => {
  const store = makeStore("hb-claimed-input-paused-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "pause this run" },
  });
  setNodeRunnerCommand([
    "const request = process.argv.at(-1) ?? '';",
    "void request;",
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 1, event_type: 'run_started', payload: { instruction_preview: 'pause this run' } }) + '\\n');`,
    "setInterval(() => {}, 1000);",
  ]);

  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });
  const controller = new AbortController();
  let evolveCalls = 0;
  const execution = processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
    abortSignal: controller.signal,
    runEvolveTasksFn: async () => {
      evolveCalls += 1;
    },
  });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (
      outputEventsForInput(store, queued).length > 0
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  controller.abort("user_requested_pause");
  await execution;

  const updated = store.getInput({ workspaceId: workspace.id, inputId: queued.inputId });
  const runtimeState = store.getRuntimeState({
    workspaceId: workspace.id,
    sessionId: "session-main",
  });
  const events = outputEventsForInput(store, queued);
  const turnResult = turnResultForInput(store, queued);
  const completedBudgetDecisions = recordValue(
    events[1]?.payload.context_budget_decisions,
  );

  assert.equal(evolveCalls, 1);
  assert.ok(updated);
  assert.equal(updated.status, "PAUSED");
  assert.ok(runtimeState);
  assert.equal(runtimeState.status, "PAUSED");
  assert.equal(runtimeState.currentInputId, null);
  assert.equal(runtimeState.lastError, null);
  assert.deepEqual(
    events.map((event) => event.eventType),
    ["run_started", "run_completed"],
  );
  assert.equal(events[1]?.payload.status, "paused");
  assert.equal(events[1]?.payload.stop_reason, "paused");
  assert.equal(events[1]?.payload.message, "Run paused by user request");
  assert.equal(completedBudgetDecisions?.pressure_stage, "normal");
  assert.deepEqual(completedBudgetDecisions?.lane_decisions, []);
  assert.equal(completedBudgetDecisions?.prompt_cache_stable_candidate, false);
  assert.equal(completedBudgetDecisions?.tool_replay_trimmed, false);
  assert.equal(completedBudgetDecisions?.retrieval_clipped, false);
  assert.equal(completedBudgetDecisions?.checkpoint_queued, false);
  assert.ok(turnResult);
  assert.equal(turnResult.status, "paused");
  assert.equal(turnResult.stopReason, "paused");

  store.close();
});

test("claimed input captures file outputs and persists an assistant turn for output-only runs", async () => {
  const store = makeStore("hb-claimed-input-file-output-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "create a report file" },
  });

  await processClaimedInput({
    store,
    record: queued,
    executeRunnerRequestFn: async (payload, options = {}) => {
      const workspaceDir = store.workspaceDir(workspace.id);
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.writeFileSync(path.join(workspaceDir, "report.md"), "# Report\n");
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

  const outputs = store.listOutputs({
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: queued.inputId,
    limit: 20,
    offset: 0,
  });
  const messages = store.listSessionMessages({
    workspaceId: workspace.id,
    sessionId: "session-main",
  });

  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].title, "report.md");
  assert.equal(outputs[0].filePath, "report.md");
  assert.equal(outputs[0].status, "completed");
  assert.equal(outputs[0].metadata.origin_type, "file");
  assert.equal(outputs[0].metadata.change_type, "created");
  assert.equal(outputs[0].metadata.category, "document");
  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, `user-${queued.inputId}`);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].text, "create a report file");
  assert.equal(messages[1].id, `assistant-${queued.inputId}`);
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].text, "");

  store.close();
});

test("claimed input writes completed subagent results and queues a background update", async () => {
  const store = makeStore("hb-claimed-input-subagent-completed-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const { queued, run } = createSubagentRunFixture({
    store,
    workspaceId: workspace.id,
    title: "Research competitors",
    goal: "Find recent proactive agent products",
  });

  await processClaimedInput({
    store,
    record: queued,
    executeRunnerRequestFn: async (payload, options = {}) => {
      store.createOutput({
        workspaceId: workspace.id,
        outputType: "document",
        title: "research-report.md",
        status: "completed",
        filePath: "outputs/research-report.md",
        sessionId: String(payload.session_id),
        inputId: String(payload.input_id),
        metadata: {
          artifact_type: "report",
          category: "document",
        },
      });
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
        event_type: "tool_call",
        payload: {
          phase: "completed",
          tool_name: "web_search",
          call_id: "call-1",
          error: false,
        },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 3,
        event_type: "output_delta",
        payload: { delta: "Research complete with a report attached." },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 4,
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

  const updatedRun = store.getSubagentRun({ workspaceId: run.workspaceId, subagentId: run.subagentId });
  const queuedEvents = store.listPendingMainSessionEvents({ workspaceId: workspace.id, ownerMainSessionId: "session-main",
  });

  assert.ok(updatedRun);
  assert.equal(updatedRun?.status, "completed");
  assert.equal(updatedRun?.latestChildInputId, queued.inputId);
  assert.equal(updatedRun?.currentChildInputId, null);
  assert.equal(updatedRun?.summary, "Research complete with a report attached.");
  assert.equal(updatedRun?.latestProgressPayload, null);
  assert.equal(updatedRun?.resultPayload?.status, "completed");
  assert.equal(updatedRun?.resultPayload?.goal, "Find recent proactive agent products");
  assert.equal(
    store.getSession({
      workspaceId: workspace.id,
      sessionId: run.childSessionId,
    })?.archivedAt,
    updatedRun?.completedAt,
  );
  assert.equal(
    Array.isArray(updatedRun?.resultPayload?.forwardable_deliverables)
      ? updatedRun?.resultPayload?.forwardable_deliverables.length
      : 0,
    1,
  );
  assert.equal(queuedEvents.length, 1);
  assert.equal(queuedEvents[0]?.eventType, "completed");
  assert.equal(queuedEvents[0]?.deliveryBucket, "background_update");
  assert.equal(queuedEvents[0]?.payload.status, "completed");
  assert.equal(
    Array.isArray(queuedEvents[0]?.payload.forwardable_deliverables)
      ? queuedEvents[0]?.payload.forwardable_deliverables.length
      : 0,
    1,
  );
  assert.ok(queuedEvents[0]?.latestDeliverAt);

  store.close();
});

test("claimed input preserves subagent pending integration workspace ids for lifecycle payloads", async () => {
  const store = makeStore("hb-claimed-input-subagent-pending-integrations-");
  const workspace = store.createWorkspace({
    workspaceId: "lab-workspace-1",
    name: "Workspace 1 Lab",
    harness: "pi",
    status: "active",
  });
  const { queued, run } = createSubagentRunFixture({
    store,
    workspaceId: workspace.id,
    title: "Start tracker app",
    goal: "Bring up the tracker app and hand off auth",
  });

  await processClaimedInput({
    store,
    record: queued,
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
        event_type: "tool_call",
        payload: {
          phase: "completed",
          tool_name: "workspace_apps_ensure_running",
          call_id: "call-ensure-1",
          error: false,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    workspace_id: workspace.id,
                    pending_integrations: [
                      {
                        workspace_id: workspace.id,
                        app_id: "twitter-tracker",
                        provider_id: "twitter",
                        credential_source: "platform",
                      },
                    ],
                  },
                  null,
                  2,
                ),
              },
            ],
          },
        },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 3,
        event_type: "output_delta",
        payload: { delta: "Tracker is ready for the user to connect Twitter." },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 4,
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

  const updatedRun = store.getSubagentRun({
    workspaceId: run.workspaceId,
    subagentId: run.subagentId,
  });
  const queuedEvents = store.listPendingMainSessionEvents({
    workspaceId: workspace.id,
    ownerMainSessionId: "session-main",
  });

  assert.equal(updatedRun?.resultPayload?.workspace_id, workspace.id);
  assert.deepEqual(updatedRun?.resultPayload?.pending_integrations, [
    {
      workspace_id: workspace.id,
      app_id: "twitter-tracker",
      provider_id: "twitter",
      credential_source: "platform",
    },
  ]);
  assert.equal(queuedEvents[0]?.payload.workspace_id, workspace.id);
  assert.deepEqual(queuedEvents[0]?.payload.pending_integrations, [
    {
      workspace_id: workspace.id,
      app_id: "twitter-tracker",
      provider_id: "twitter",
      credential_source: "platform",
    },
  ]);

  store.close();
});

test("claimed input writes waiting-on-user subagent blockers and queues a blocker event", async () => {
  const store = makeStore("hb-claimed-input-subagent-waiting-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const { queued, run } = createSubagentRunFixture({
    store,
    workspaceId: workspace.id,
    title: "Gmail setup",
    goal: "Finish Gmail OAuth setup",
  });

  await processClaimedInput({
    store,
    record: queued,
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
        payload: { delta: "Should I create a new GCP project for OAuth?" },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 3,
        event_type: "run_completed",
        payload: {
          status: "waiting_user",
          stop_reason: "waiting_user",
          summary: "Need a GCP project decision.",
        },
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

  const updatedRun = store.getSubagentRun({ workspaceId: run.workspaceId, subagentId: run.subagentId });
  const queuedEvents = store.listPendingMainSessionEvents({ workspaceId: workspace.id, ownerMainSessionId: "session-main",
  });

  assert.ok(updatedRun);
  assert.equal(updatedRun?.status, "waiting_on_user");
  assert.equal(updatedRun?.currentChildInputId, queued.inputId);
  assert.equal(updatedRun?.latestChildInputId, queued.inputId);
  assert.equal(updatedRun?.summary, "Should I create a new GCP project for OAuth?");
  assert.equal(updatedRun?.blockingPayload?.status, "waiting_on_user");
  assert.equal(
    updatedRun?.blockingPayload?.blocking_question,
    "Should I create a new GCP project for OAuth?",
  );
  assert.equal(queuedEvents.length, 1);
  assert.equal(queuedEvents[0]?.eventType, "waiting_on_user");
  assert.equal(queuedEvents[0]?.deliveryBucket, "waiting_on_user");
  assert.equal(queuedEvents[0]?.payload.status, "waiting_on_user");
  assert.equal(
    queuedEvents[0]?.payload.blocking_question,
    "Should I create a new GCP project for OAuth?",
  );
  assert.equal(queuedEvents[0]?.latestDeliverAt, null);

  store.close();
});

test("claimed input treats recoverable login blockers as waiting-on-user subagent blockers", async () => {
  const store = makeStore("hb-claimed-input-subagent-login-blocker-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const { queued, run } = createSubagentRunFixture({
    store,
    workspaceId: workspace.id,
    title: "Check latest post stats",
    goal: "Inspect the latest post stats in the browser",
  });

  await processClaimedInput({
    store,
    record: queued,
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
          delta:
            "I reached the page, but it is currently logged out, so I could not retrieve the latest post stats.",
        },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 3,
        event_type: "run_completed",
        payload: { status: "success" },
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

  const updatedRun = store.getSubagentRun({ workspaceId: run.workspaceId, subagentId: run.subagentId });
  const queuedEvents = store.listPendingMainSessionEvents({ workspaceId: workspace.id, ownerMainSessionId: "session-main",
  });

  assert.ok(updatedRun);
  assert.equal(updatedRun?.status, "waiting_on_user");
  assert.equal(updatedRun?.currentChildInputId, queued.inputId);
  assert.equal(updatedRun?.completedAt, null);
  assert.equal(
    updatedRun?.blockingPayload?.blocking_question,
    "Please log in or complete the required access step, then tell me to continue.",
  );
  assert.match(
    String(updatedRun?.blockingPayload?.partial_summary ?? ""),
    /currently logged out/,
  );
  assert.equal(queuedEvents.length, 1);
  assert.equal(queuedEvents[0]?.eventType, "waiting_on_user");
  assert.equal(queuedEvents[0]?.deliveryBucket, "waiting_on_user");
  assert.equal(
    queuedEvents[0]?.payload.blocking_question,
    "Please log in or complete the required access step, then tell me to continue.",
  );
  assert.equal(queuedEvents[0]?.latestDeliverAt, null);

  store.close();
});

test("claimed input writes failed subagent results and queues a failure update", async () => {
  const store = makeStore("hb-claimed-input-subagent-failed-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const { queued, run } = createSubagentRunFixture({
    store,
    workspaceId: workspace.id,
    title: "Fix the build",
    goal: "Repair the failing build",
  });

  await processClaimedInput({
    store,
    record: queued,
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
        event_type: "run_failed",
        payload: {
          type: "RuntimeError",
          message: "compiler crashed",
        },
      });
      return {
        events: [],
        skippedLines: [],
        stderr: "",
        returnCode: 1,
        sawTerminal: true,
      };
    },
  });

  const updatedRun = store.getSubagentRun({ workspaceId: run.workspaceId, subagentId: run.subagentId });
  const queuedEvents = store.listPendingMainSessionEvents({ workspaceId: workspace.id, ownerMainSessionId: "session-main",
  });

  assert.ok(updatedRun);
  assert.equal(updatedRun?.status, "failed");
  assert.equal(updatedRun?.latestChildInputId, queued.inputId);
  assert.equal(updatedRun?.errorPayload?.status, "failed");
  assert.equal(updatedRun?.errorPayload?.goal, "Repair the failing build");
  assert.equal(queuedEvents.length, 1);
  assert.equal(queuedEvents[0]?.eventType, "failed");
  assert.equal(queuedEvents[0]?.deliveryBucket, "background_update");
  assert.equal(queuedEvents[0]?.payload.status, "failed");

  store.close();
});

test("claimed input delivers materialized main-session event batches without inserting a fake user turn", async () => {
  const store = makeStore("hb-claimed-input-main-session-event-batch-");
  const workspace = store.createWorkspace({
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
  const event = store.enqueueMainSessionEvent({
    workspaceId: workspace.id,
    ownerMainSessionId: "session-main",
    originMainSessionId: "session-main",
    subagentId: "subagent-1",
    eventType: "completed",
    deliveryBucket: "background_update",
    payload: {
      status: "completed",
      summary: "Research is done.",
    },
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: {
      text: "[Holaboss Main Session Event Batch v1]\nSummarize the queued event.",
      context: {
        source: "main_session_event_batch",
        main_session_event_ids: [event.eventId],
        delivery_bucket: "background_update",
      },
    },
    idempotencyKey: `main-session-event-batch:${event.eventId}`,
  });
  store.markMainSessionEventsMaterialized({
    workspaceId: workspace.id,
    eventIds: [event.eventId],
    materializedInputId: queued.inputId,
  });

  let capturedInstruction = "";
  await processClaimedInput({
    store,
    record: queued,
    executeRunnerRequestFn: async (payload, options = {}) => {
      capturedInstruction = String(payload.instruction);
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
        payload: { delta: "The research is done and the report is ready." },
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

  const messages = store.listSessionMessages({
    workspaceId: workspace.id,
    sessionId: "session-main",
  });
  const updatedEvent = store.getMainSessionEvent({ workspaceId: workspace.id, eventId: event.eventId });

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, "assistant");
  assert.equal(
    messages[0]?.text,
    "The research is done and the report is ready.",
  );
  assert.doesNotMatch(capturedInstruction, /Pending Background Updates/);
  assert.match(capturedInstruction, /\[Holaboss Main Session Event Batch v1\]/);
  assert.equal(updatedEvent?.status, "delivered");
  assert.ok(updatedEvent?.deliveredAt);

  store.close();
});

test("claimed input requeues materialized main-session event batches when the reply fails", async () => {
  const store = makeStore("hb-claimed-input-main-session-event-requeue-");
  const workspace = store.createWorkspace({
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
  const event = store.enqueueMainSessionEvent({
    workspaceId: workspace.id,
    ownerMainSessionId: "session-main",
    originMainSessionId: "session-main",
    subagentId: "subagent-1",
    eventType: "failed",
    deliveryBucket: "background_update",
    payload: {
      status: "failed",
      summary: "Build fix failed.",
    },
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: {
      text: "[Holaboss Main Session Event Batch v1]\nSummarize the queued event.",
      context: {
        source: "main_session_event_batch",
        main_session_event_ids: [event.eventId],
        delivery_bucket: "background_update",
      },
    },
    idempotencyKey: `main-session-event-batch:${event.eventId}`,
  });
  store.markMainSessionEventsMaterialized({
    workspaceId: workspace.id,
    eventIds: [event.eventId],
    materializedInputId: queued.inputId,
  });

  await processClaimedInput({
    store,
    record: queued,
    executeRunnerRequestFn: async () => {
      throw new Error("model call failed");
    },
  });

  const updatedEvent = store.getMainSessionEvent({ workspaceId: workspace.id, eventId: event.eventId });
  const updatedPayload = recordValue(updatedEvent?.payload);
  const deliveryRetry = recordValue(updatedPayload?.delivery_retry);

  assert.equal(updatedEvent?.status, "pending");
  assert.equal(updatedEvent?.materializedInputId, null);
  assert.equal(updatedEvent?.deliveredAt, null);
  assert.ok(updatedEvent?.earliestDeliverAt);
  assert.equal(deliveryRetry?.attempt_count, 1);
  assert.equal(deliveryRetry?.retry_delay_ms, 5_000);
  assert.equal(deliveryRetry?.next_retry_at, updatedEvent?.earliestDeliverAt);
  assert.equal(typeof deliveryRetry?.last_attempt_at, "string");

  store.close();
});

test("claimed input requeues paused materialized main-session event batches without marking them delivered", async () => {
  const store = makeStore("hb-claimed-input-main-session-event-paused-");
  const workspace = store.createWorkspace({
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
  const event = store.enqueueMainSessionEvent({
    workspaceId: workspace.id,
    ownerMainSessionId: "session-main",
    originMainSessionId: "session-main",
    subagentId: "subagent-1",
    eventType: "completed",
    deliveryBucket: "background_update",
    payload: {
      status: "completed",
      summary: "Research is done.",
    },
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: {
      text: "[Holaboss Main Session Event Batch v1]\nSummarize the queued event.",
      context: {
        source: "main_session_event_batch",
        main_session_event_ids: [event.eventId],
        delivery_bucket: "background_update",
      },
    },
    idempotencyKey: `main-session-event-batch:${event.eventId}`,
  });
  store.markMainSessionEventsMaterialized({
    workspaceId: workspace.id,
    eventIds: [event.eventId],
    materializedInputId: queued.inputId,
  });

  await processClaimedInput({
    store,
    record: queued,
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
        event_type: "run_completed",
        payload: { status: "paused", stop_reason: "paused" },
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

  const updatedEvent = store.getMainSessionEvent({
    workspaceId: workspace.id,
    eventId: event.eventId,
  });
  const updatedPayload = recordValue(updatedEvent?.payload);
  const deliveryRetry = recordValue(updatedPayload?.delivery_retry);
  const messages = store.listSessionMessages({
    workspaceId: workspace.id,
    sessionId: "session-main",
  });

  assert.equal(messages.length, 0);
  assert.equal(updatedEvent?.status, "pending");
  assert.equal(updatedEvent?.materializedInputId, null);
  assert.equal(updatedEvent?.deliveredAt, null);
  assert.ok(updatedEvent?.earliestDeliverAt);
  assert.equal(deliveryRetry?.attempt_count, 0);
  assert.equal(deliveryRetry?.retry_delay_ms, 0);
  assert.equal(deliveryRetry?.next_retry_at, updatedEvent?.earliestDeliverAt);
  assert.equal(deliveryRetry?.last_stop_reason, "paused");

  store.close();
});

test("claimed input runs main-session followups on the bound session snapshot even when workspace pi state points elsewhere", async () => {
  const store = makeStore("hb-claimed-input-main-session-followup-snapshot-");
  const workspace = store.createWorkspace({
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
  const workspaceDir = store.workspaceDir(workspace.id);
  const { sessionManager, sessionFile: liveSessionFile } = createPiSessionFile({
    workspaceDir,
    sessionDir: path.join(workspaceDir, ".holaboss", "pi-sessions"),
  });
  sessionManager.appendMessage(
    piUserMessage("Tell me when the background task finishes."),
  );
  sessionManager.appendMessage(piAssistantMessage("Working on it."));
  persistWorkspaceHarnessSessionId({
    workspaceDir,
    harness: "pi",
    sessionId: liveSessionFile,
  });
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
    harness: "pi",
    harnessSessionId: liveSessionFile,
  });
  const { sessionManager: otherSessionManager, sessionFile: otherSessionFile } =
    createPiSessionFile({
      workspaceDir,
      sessionDir: path.join(workspaceDir, ".holaboss", "pi-sessions"),
    });
  otherSessionManager.appendMessage(
    piUserMessage("This is a subagent-only pi session."),
  );
  otherSessionManager.appendMessage(
    piAssistantMessage("Subagent result lives here."),
  );
  persistWorkspaceHarnessSessionId({
    workspaceDir,
    harness: "pi",
    sessionId: otherSessionFile,
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
      summary: "Research is done.",
    },
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: {
      text: "[Holaboss Main Session Event Batch v1]\nSummarize the queued event.",
      context: {
        source: "main_session_event_batch",
        main_session_event_ids: [event.eventId],
        delivery_bucket: "background_update",
      },
    },
    idempotencyKey: `main-session-event-batch:${event.eventId}`,
  });
  store.markMainSessionEventsMaterialized({
    workspaceId: workspace.id,
    eventIds: [event.eventId],
    materializedInputId: queued.inputId,
  });

  let snapshotSessionFile = "";
  let checkpointQueued = false;
  await processClaimedInput({
    store,
    record: queued,
    enqueueSessionCheckpointJobFn: () => {
      checkpointQueued = true;
      return null;
    },
    executeRunnerRequestFn: async (payload, options = {}) => {
      const execContext = recordValue(
        recordValue(payload.context)?._sandbox_runtime_exec_v1,
      );
      snapshotSessionFile =
        typeof execContext?.harness_session_id === "string"
          ? execContext.harness_session_id
          : "";
      assert.ok(snapshotSessionFile);
      assert.notEqual(snapshotSessionFile, liveSessionFile);
      assert.equal(path.basename(snapshotSessionFile), path.basename(liveSessionFile));
      assert.notEqual(
        path.basename(snapshotSessionFile),
        path.basename(otherSessionFile),
      );
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
        payload: { delta: "The report is ready." },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 3,
        event_type: "pi_native_event",
        payload: {
          native_type: "message_end",
          native_event: {
            type: "message_end",
            message: piAssistantMessage("The report is ready."),
          },
          harness_session_id: snapshotSessionFile,
        },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 4,
        event_type: "run_completed",
        payload: {
          status: "ok",
          harness_session_id: snapshotSessionFile,
        },
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

  assert.equal(checkpointQueued, false);
  assert.equal(
    store.getBinding({
      workspaceId: workspace.id,
      sessionId: "session-main",
    })?.harnessSessionId,
    liveSessionFile,
  );
  assert.equal(
    readWorkspaceHarnessSessionId({ workspaceDir, harness: "pi" }),
    liveSessionFile,
  );
  assert.equal(fs.existsSync(path.dirname(snapshotSessionFile)), false);
  assert.deepEqual(piSessionMessageTexts(liveSessionFile), [
    "Tell me when the background task finishes.",
    "Working on it.",
    "The report is ready.",
  ]);

  store.close();
});

test("claimed input folds attached background updates into a normal user turn", async () => {
  const store = makeStore("hb-claimed-input-inline-background-events-");
  const workspace = store.createWorkspace({
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
  const event = store.enqueueMainSessionEvent({
    workspaceId: workspace.id,
    ownerMainSessionId: "session-main",
    originMainSessionId: "session-main",
    subagentId: "subagent-1",
    eventType: "completed",
    deliveryBucket: "background_update",
    payload: {
      status: "completed",
      summary: "Build fix is done.",
      forwardable_deliverables: [
        {
          output_id: "output-1",
          artifact_id: "artifact-1",
          type: "report",
          output_type: "document",
          title: "build-fix-report.md",
          status: "completed",
          file_path: "outputs/reports/build-fix-report.md",
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
      text: "What changed?",
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
              summary: "Build fix is done.",
              assistant_text:
                "<html><body><h1>Build Fix Report</h1><p>Long HTML body that should not be pasted back into the main-session prompt.</p></body></html>",
              forwardable_deliverables: [
                {
                  output_id: "output-1",
                  artifact_id: "artifact-1",
                  type: "report",
                  output_type: "document",
                  title: "build-fix-report.md",
                  status: "completed",
                  module_id: "twitter",
                  module_resource_id: "post-123",
                  file_path: "outputs/reports/build-fix-report.md",
                  platform: "twitter",
                  metadata: {
                    artifact_type: "report",
                    presentation: {
                      kind: "app_resource",
                      view: "posts",
                      path: "/posts/post-123",
                    },
                    resource: {
                      entity_type: "post",
                      entity_id: "post-123",
                      label: "build-fix-report.md",
                    },
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

  let capturedInstruction = "";
  await processClaimedInput({
    store,
    record: queued,
    executeRunnerRequestFn: async (payload, options = {}) => {
      capturedInstruction = String(payload.instruction);
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
          delta: "The build fix is done. I updated the failing test helper and the deployment check still looks healthy.",
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

  const messages = store.listSessionMessages({
    workspaceId: workspace.id,
    sessionId: "session-main",
  });
  const updatedEvent = store.getMainSessionEvent({ workspaceId: workspace.id, eventId: event.eventId });
  const outputs = store.listOutputs({
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: queued.inputId,
    limit: 20,
    offset: 0,
  });

  assert.match(capturedInstruction, /Pending Background Updates/);
  assert.match(capturedInstruction, /Answer the user's latest message first\./);
  assert.match(capturedInstruction, /add them after your direct answer as a natural continuation/i);
  assert.match(capturedInstruction, /only one relevant update, weave it in without a `Background updates` heading/i);
  assert.match(capturedInstruction, /Do not introduce the added update with stock phrases like `Quick follow-up`/i);
  assert.match(capturedInstruction, /Only use a separate `Background updates` section when there are multiple distinct updates/i);
  assert.match(capturedInstruction, /numbered items/i);
  assert.doesNotMatch(capturedInstruction, /<html>/i);
  assert.match(capturedInstruction, /build-fix-report\.md/i);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "user");
  assert.equal(messages[0]?.text, "What changed?");
  assert.equal(messages[1]?.role, "assistant");
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0]?.title, "build-fix-report.md");
  assert.equal(outputs[0]?.moduleId, "twitter");
  assert.equal(outputs[0]?.moduleResourceId, "post-123");
  assert.equal(outputs[0]?.filePath, "outputs/reports/build-fix-report.md");
  assert.equal(outputs[0]?.metadata.origin_type, "forwarded_subagent");
  assert.deepEqual(outputs[0]?.metadata.presentation, {
    kind: "app_resource",
    view: "posts",
    path: "/posts/post-123",
  });
  assert.equal(outputs[0]?.metadata.owner_container_type, "background_update");
  assert.equal(outputs[0]?.metadata.owner_container_input_id, queued.inputId);
  assert.equal(outputs[0]?.metadata.owner_container_session_id, "session-main");
  assert.equal(updatedEvent?.status, "delivered");

  store.close();
});

test("claimed input renews its claim lease while the runner is still healthy", async () => {
  const store = makeStore("hb-claimed-input-lease-renewal-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "hello" },
  });
  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 1,
  });
  const claimedUntilBefore = claimed[0]?.claimedUntil ?? null;
  let claimedUntilDuringRun: string | null = null;

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
    executeRunnerRequestFn: async (payload, options = {}) => {
      await options.onHeartbeat?.();
      claimedUntilDuringRun =
        store.getInput({ workspaceId: workspace.id, inputId: String(payload.input_id) })?.claimedUntil ?? null;
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

  assert.ok(claimedUntilBefore);
  assert.ok(claimedUntilDuringRun);
  assert.notEqual(claimedUntilDuringRun, claimedUntilBefore);
  assert.ok(Date.parse(claimedUntilDuringRun) > Date.parse(claimedUntilBefore));

  store.close();
});

test("claimed input passes the harness timeout through to the outer runner watchdog", async () => {
  process.env.HOLABOSS_HARNESS_RUN_TIMEOUT_S = "45";

  const store = makeStore("hb-claimed-input-harness-timeout-payload-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "hello" },
  });
  let seenHarnessTimeout: number | null = null;

  await processClaimedInput({
    store,
    record: queued,
    executeRunnerRequestFn: async (payload, options = {}) => {
      seenHarnessTimeout =
        typeof payload.harness_timeout_seconds === "number"
          ? payload.harness_timeout_seconds
          : null;
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

  assert.equal(seenHarnessTimeout, 45);

  store.close();
});

test("claimed input treats streamed runner events as lease activity", async () => {
  const store = makeStore("hb-claimed-input-event-lease-renewal-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "hello" },
  });
  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 1,
  });
  const claimedUntilBefore = claimed[0]?.claimedUntil ?? null;
  let claimedUntilDuringRun: string | null = null;

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
    executeRunnerRequestFn: async (payload, options = {}) => {
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 1,
        event_type: "run_started",
        payload: {},
      });
      claimedUntilDuringRun =
        store.getInput({ workspaceId: workspace.id, inputId: String(payload.input_id) })?.claimedUntil ?? null;
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 2,
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

  assert.ok(claimedUntilBefore);
  assert.ok(claimedUntilDuringRun);
  assert.notEqual(claimedUntilDuringRun, claimedUntilBefore);
  assert.ok(Date.parse(claimedUntilDuringRun) > Date.parse(claimedUntilBefore));

  store.close();
});

test("claimed input honors a persisted failure terminal after claim recovery aborts the runner", async () => {
  const store = makeStore("hb-claimed-input-persisted-terminal-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "hello" },
  });
  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
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
        payload: { delta: "Partial answer" },
      });
      store.appendOutputEvent({
        workspaceId: workspace.id,
        sessionId: String(payload.session_id),
        inputId: String(payload.input_id),
        sequence: 3,
        eventType: "run_failed",
        payload: {
          type: "RuntimeError",
          message:
            "claimed input lease expired before the runner emitted a terminal event",
        },
      });
      return {
        events: [],
        skippedLines: [],
        stderr: "",
        returnCode: 130,
        sawTerminal: false,
        aborted: true,
        abortReason: "claim_expired",
      };
    },
  });

  const updated = store.getInput({ workspaceId: workspace.id, inputId: queued.inputId });
  const runtimeState = store.getRuntimeState({
    workspaceId: workspace.id,
    sessionId: "session-main",
  });
  const events = outputEventsForInput(store, queued);
  const messages = store.listSessionMessages({
    workspaceId: workspace.id,
    sessionId: "session-main",
  });
  const turnResult = turnResultForInput(store, queued);

  assert.ok(updated);
  assert.equal(updated.status, "FAILED");
  assert.ok(runtimeState);
  assert.equal(runtimeState.status, "ERROR");
  assert.deepEqual(
    events.map((event) => event.eventType),
    ["run_started", "output_delta", "run_failed"],
  );
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.id, `user-${queued.inputId}`);
  assert.equal(messages[0]?.text, "hello");
  assert.equal(messages[1]?.id, `assistant-${queued.inputId}`);
  assert.equal(messages[1]?.text, "Partial answer");
  assert.ok(turnResult);
  assert.equal(turnResult.status, "failed");
  assert.equal(turnResult.stopReason, "RuntimeError");

  store.close();
});

test("claimed input does not duplicate a file output already persisted earlier in the same turn", async () => {
  const store = makeStore("hb-claimed-input-file-output-dedupe-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "write a report artifact" },
  });

  await processClaimedInput({
    store,
    record: queued,
    executeRunnerRequestFn: async (payload, options = {}) => {
      const workspaceDir = store.workspaceDir(workspace.id);
      fs.mkdirSync(path.join(workspaceDir, "outputs", "reports"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(workspaceDir, "outputs", "reports", "report.md"),
        "# Report\n",
      );
      store.createOutput({
        workspaceId: workspace.id,
        outputType: "document",
        title: "Report",
        status: "completed",
        filePath: "outputs/reports/report.md",
        sessionId: String(payload.session_id),
        inputId: String(payload.input_id),
        metadata: {
          origin_type: "runtime_tool",
          change_type: "created",
          category: "document",
          artifact_type: "report",
        },
      });
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

  const outputs = store.listOutputs({
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: queued.inputId,
    limit: 20,
    offset: 0,
  });

  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].filePath, "outputs/reports/report.md");
  assert.equal(outputs[0].metadata.origin_type, "runtime_tool");

  store.close();
});

test("claimed input does not attach a workspace file output that was already recorded on another turn", async () => {
  const store = makeStore(
    "hb-claimed-input-cross-turn-file-output-dedupe-",
  );
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "open google" },
  });

  await processClaimedInput({
    store,
    record: queued,
    executeRunnerRequestFn: async (payload, options = {}) => {
      const workspaceDir = store.workspaceDir(workspace.id);
      fs.mkdirSync(path.join(workspaceDir, "outputs", "reports"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(workspaceDir, "outputs", "reports", "report.md"),
        "# Report\n",
      );
      store.createOutput({
        workspaceId: workspace.id,
        outputType: "document",
        title: "Report",
        status: "completed",
        filePath: "outputs/reports/report.md",
        sessionId: "subagent-1",
        inputId: "subagent-input-1",
        metadata: {
          origin_type: "runtime_tool",
          change_type: "created",
          category: "document",
          artifact_type: "report",
        },
      });
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

  const outputs = store.listOutputs({
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: queued.inputId,
    limit: 20,
    offset: 0,
  });

  assert.equal(outputs.length, 0);

  store.close();
});

test("claimed input records skill-policy denial audit in tool usage summary", async () => {
  const store = makeStore("hb-claimed-input-skill-policy-denial-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "hello" },
  });

  await processClaimedInput({
    store,
    record: queued,
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
        event_type: "tool_call",
        payload: {
          phase: "completed",
          tool_name: "bash",
          call_id: "call-denied",
          error: true,
          message:
            'permission denied by skill policy: tool "bash" is gated and must be widened',
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

  const turnResult = turnResultForInput(store, queued);
  assert.ok(turnResult);
  assert.deepEqual(turnResult.toolUsageSummary, {
    total_calls: 1,
    completed_calls: 0,
    failed_calls: 1,
    tool_names: ["bash"],
    tool_ids: [],
    skill_policy_widening: {
      scope: null,
      workspace_boundary_override: null,
      managed_tools: [],
      granted_tools: [],
      active_granted_tools: [],
      managed_commands: [],
      granted_commands: [],
      active_granted_commands: [],
      activation_count: 0,
      denied_calls: 1,
      denied_tool_names: ["bash"],
    },
  });

  store.close();
});

test("claimed input synthesizes run_failed when runner exits without terminal event", async () => {
  const store = makeStore("hb-claimed-input-failure-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "hello" },
  });
  setNodeRunnerCommand([
    "const request = process.argv.at(-1) ?? '';",
    "void request;",
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 1, event_type: 'run_started', payload: { instruction_preview: 'hello' } }) + '\\n');`,
  ]);

  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
  });

  const updated = store.getInput({ workspaceId: workspace.id, inputId: queued.inputId });
  const runtimeState = store.getRuntimeState({
    workspaceId: workspace.id,
    sessionId: "session-main",
  });
  const events = outputEventsForInput(store, queued);
  const turnResult = turnResultForInput(store, queued);

  assert.ok(updated);
  assert.equal(updated.status, "FAILED");
  assert.ok(runtimeState);
  assert.equal(runtimeState.status, "ERROR");
  assert.equal(events.length, 2);
  assert.equal(events[0].eventType, "run_started");
  assert.equal(events[1].eventType, "run_failed");
  assert.match(
    String(events[1].payload.message),
    /runner ended before terminal event/,
  );
  assert.ok(turnResult);
  assert.equal(turnResult.status, "failed");
  assert.equal(turnResult.stopReason, "RuntimeError");
  assert.equal(turnResult.assistantText, "");

  store.close();
});

test("claimed input succeeds when runner emits terminal event but keeps the process alive", async () => {
  const store = makeStore("hb-claimed-input-terminal-kill-");
  process.env.SANDBOX_AGENT_RUN_TIMEOUT_S = "1";
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "hello" },
  });
  setNodeRunnerCommand([
    "const request = process.argv.at(-1) ?? '';",
    "void request;",
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 1, event_type: 'run_started', payload: { instruction_preview: 'hello' } }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 2, event_type: 'run_completed', payload: { status: 'ok' } }) + '\\n');`,
    "setInterval(() => {}, 1000);",
  ]);

  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
  });

  const updated = store.getInput({ workspaceId: workspace.id, inputId: queued.inputId });
  const runtimeState = store.getRuntimeState({
    workspaceId: workspace.id,
    sessionId: "session-main",
  });
  const events = outputEventsForInput(store, queued);
  const turnResult = turnResultForInput(store, queued);

  assert.ok(updated);
  assert.equal(updated.status, "DONE");
  assert.ok(runtimeState);
  assert.equal(runtimeState.status, "IDLE");
  assert.deepEqual(
    events.map((event) => event.eventType),
    ["run_started", "run_completed"],
  );
  assert.ok(turnResult);
  assert.equal(turnResult.status, "completed");
  assert.equal(turnResult.stopReason, "ok");

  store.close();
});

test("claimed input fails when runner becomes idle after run_started", async () => {
  const store = makeStore("hb-claimed-input-idle-timeout-");
  process.env.SANDBOX_AGENT_RUN_TIMEOUT_S = "10";
  process.env.SANDBOX_AGENT_RUN_IDLE_TIMEOUT_S = "1";
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "hello" },
  });
  setNodeRunnerCommand([
    "const request = process.argv.at(-1) ?? '';",
    "void request;",
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 1, event_type: 'run_started', payload: { instruction_preview: 'hello' } }) + '\\n');`,
    "setInterval(() => {}, 1000);",
  ]);

  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
  });

  const updated = store.getInput({ workspaceId: workspace.id, inputId: queued.inputId });
  const runtimeState = store.getRuntimeState({
    workspaceId: workspace.id,
    sessionId: "session-main",
  });
  const events = outputEventsForInput(store, queued);
  const turnResult = turnResultForInput(store, queued);

  assert.ok(updated);
  assert.equal(updated.status, "FAILED");
  assert.ok(runtimeState);
  assert.equal(runtimeState.status, "ERROR");
  assert.equal(events.length, 2);
  assert.equal(events[0].eventType, "run_started");
  assert.equal(events[1].eventType, "run_failed");
  assert.match(String(events[1].payload.message), /idle/i);
  assert.ok(turnResult);
  assert.equal(turnResult.status, "failed");
  assert.equal(turnResult.stopReason, "RunnerCommandError");

  store.close();
});

test("claimed input stops without overwriting state after it loses its claim mid-run", async () => {
  const store = makeStore("hb-claimed-input-claim-lost-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "hello" },
  });
  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
    executeRunnerRequestFn: async (payload, options = {}) => {
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 1,
        event_type: "run_started",
        payload: {},
      });
      store.updateInput({ workspaceId: queued.workspaceId, inputId: queued.inputId, fields: {
        status: "FAILED",
        claimedBy: null,
        claimedUntil: null,
      } });
      store.updateRuntimeState({
        workspaceId: workspace.id,
        sessionId: "session-main",
        status: "ERROR",
        currentInputId: null,
        currentWorkerId: null,
        leaseUntil: null,
        heartbeatAt: null,
        lastError: { message: "recovered elsewhere" },
      });
      store.appendOutputEvent({
        workspaceId: workspace.id,
        sessionId: "session-main",
        inputId: queued.inputId,
        sequence: 2,
        eventType: "run_failed",
        payload: {
          type: "RuntimeError",
          message: "recovered elsewhere",
        },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 3,
        event_type: "output_delta",
        payload: { delta: "should not persist" },
      });
      return {
        events: [],
        skippedLines: [],
        stderr: "runner command aborted by caller",
        returnCode: 130,
        sawTerminal: false,
        aborted: true,
        abortReason:
          typeof options.signal?.reason === "string"
            ? options.signal.reason
            : null,
      };
    },
  });

  const updated = store.getInput({ workspaceId: workspace.id, inputId: queued.inputId });
  const runtimeState = store.getRuntimeState({
    workspaceId: workspace.id,
    sessionId: "session-main",
  });
  const events = outputEventsForInput(store, queued);
  const messages = store.listSessionMessages({
    workspaceId: workspace.id,
    sessionId: "session-main",
  });
  const turnResult = turnResultForInput(store, queued);

  assert.equal(updated?.status, "FAILED");
  assert.equal(updated?.claimedBy, null);
  assert.equal(runtimeState?.status, "ERROR");
  assert.deepEqual(
    events.map((event) => event.eventType),
    ["run_started", "run_failed"],
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.id, `user-${queued.inputId}`);
  assert.equal(turnResult, null);

  store.close();
});

test("claimed input reports synthesized runner timeouts to Sentry", async () => {
  const store = makeStore("hb-claimed-input-sentry-timeout-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "hello" },
  });
  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });
  const sentryCaptures: RuntimeSentryCaptureOptions[] = [];

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
    captureRuntimeExceptionFn: (capture) => {
      sentryCaptures.push(capture);
    },
    executeRunnerRequestFn: async (payload, options = {}) => {
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 1,
        event_type: "run_started",
        payload: {},
      });
      return {
        events: [],
        skippedLines: [],
        stderr: "runner command timed out",
        returnCode: 124,
        sawTerminal: false,
      };
    },
  });

  assert.equal(sentryCaptures.length, 1);
  assert.equal(sentryCaptures[0]?.tags?.failure_kind, "runner_timeout");
  assert.equal(sentryCaptures[0]?.tags?.surface, "claimed_input_executor");
  assert.equal(
    sentryCaptures[0]?.contexts?.claimed_input?.input_id,
    queued.inputId,
  );

  store.close();
});

test("claimed input reports harness run_failed events to Sentry with redacted context", async () => {
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = writeRuntimeConfigDocument({
    runtime: {
      sandbox_id: "sandbox-1",
    },
    integrations: {
      holaboss: {
        auth_token: "token-1",
        user_id: "user-1",
        sandbox_id: "sandbox-1",
        model_proxy_base_url: "https://runtime.example/api/v1/model-proxy",
      },
    },
  });
  const store = makeStore("hb-claimed-input-sentry-terminal-failure-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: {
      text: "hello",
      context: {
        _sandbox_runtime_exec_v1: {
          model_proxy_api_key: "exec-token-1",
        },
      },
    },
  });
  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });
  const sentryCaptures: RuntimeSentryCaptureOptions[] = [];

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
    captureRuntimeExceptionFn: (capture) => {
      sentryCaptures.push(capture);
    },
    executeRunnerRequestFn: async (payload, options = {}) => {
      await options.onEvent?.({
        session_id: String(payload.session_id),
        input_id: String(payload.input_id),
        sequence: 1,
        event_type: "run_started",
        payload: {
          prompt_section_ids: ["prompt-1"],
          capability_manifest_fingerprint: "cap-1",
          request_snapshot_fingerprint: "req-1",
          prompt_cache_profile: {
            cache_key: "api_key=cache-secret",
          },
        },
      });
      await options.onEvent?.({
        session_id: String(payload.session_id),
        input_id: String(payload.input_id),
        sequence: 2,
        event_type: "tool_call",
        payload: {
          phase: "started",
          tool_name: "search_docs",
          call_id: "call-1",
          tool_args: { query: "status" },
        },
      });
      await options.onEvent?.({
        session_id: String(payload.session_id),
        input_id: String(payload.input_id),
        sequence: 3,
        event_type: "output_delta",
        payload: {
          delta: "Authorization: Bearer assistant-secret",
        },
      });
      await options.onEvent?.({
        session_id: String(payload.session_id),
        input_id: String(payload.input_id),
        sequence: 4,
        event_type: "run_failed",
        payload: {
          type: "ProviderError",
          message: "api_key=super-secret boom",
          harness_session_id: "failed-session",
        },
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

  assert.equal(sentryCaptures.length, 1);
  assert.equal(sentryCaptures[0]?.tags?.failure_kind, "terminal_providererror");
  assert.equal(sentryCaptures[0]?.tags?.surface, "claimed_input_executor");
  assert.equal(
    sentryCaptures[0]?.contexts?.claimed_input?.input_id,
    queued.inputId,
  );
  assert.equal(sentryCaptures[0]?.contexts?.runtime_binding?.user_id, "user-1");
  assert.equal(
    sentryCaptures[0]?.contexts?.runtime_binding?.sandbox_id,
    "sandbox-1",
  );
  assert.equal(
    sentryCaptures[0]?.contexts?.runtime_binding?.has_exec_model_proxy_api_key,
    true,
  );
  assert.equal(
    (sentryCaptures[0]?.error as Error).message,
    "api_key=[REDACTED] boom",
  );
  assert.equal(sentryCaptures[0]?.extras?.terminal_stop_reason, "ProviderError");
  assert.deepEqual(sentryCaptures[0]?.extras?.prompt_section_ids, ["prompt-1"]);
  assert.deepEqual(sentryCaptures[0]?.extras?.tool_usage_summary, {
    total_calls: 1,
    completed_calls: 0,
    failed_calls: 0,
    tool_names: ["search_docs"],
    tool_ids: [],
  });
  assert.equal(
    sentryCaptures[0]?.extras?.assistant_excerpt,
    "Authorization: [REDACTED]",
  );
  assert.equal(
    (sentryCaptures[0]?.extras?.terminal_payload as Record<string, unknown>)
      .message,
    "api_key=[REDACTED] boom",
  );
  assert.equal(
    (
      sentryCaptures[0]?.extras?.prompt_cache_profile as Record<string, unknown>
    ).cache_key,
    "api_key=[REDACTED]",
  );
  const recentRunnerEvents = sentryCaptures[0]?.extras?.recent_runner_events as Array<
    Record<string, unknown>
  >;
  assert.equal(recentRunnerEvents.length, 4);
  assert.equal(recentRunnerEvents[0]?.event_type, "run_started");
  assert.match(
    String((recentRunnerEvents[0]?.payload as Record<string, unknown>).preview),
    /api_key=\[REDACTED\]/,
  );
  assert.deepEqual(recentRunnerEvents[1]?.payload, {
    phase: "started",
    tool_name: "search_docs",
    call_id: "call-1",
  });
  assert.deepEqual(recentRunnerEvents[2]?.payload, {
    delta_chars: "Authorization: Bearer assistant-secret".length,
  });
  assert.deepEqual(recentRunnerEvents[3]?.payload, {
    type: "ProviderError",
    message: "api_key=[REDACTED] boom",
    harness_session_id: "failed-session",
  });

  store.close();
});

test("claimed input hydrates runtime exec context from runtime config", async () => {
  const store = makeStore("hb-claimed-input-runtime-context-");
  const sandboxRoot = makeTempDir("hb-runtime-config-root-");
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  fs.mkdirSync(path.join(sandboxRoot, "state"), { recursive: true });
  fs.writeFileSync(
    path.join(sandboxRoot, "state", "runtime-config.json"),
    `${JSON.stringify({ auth_token: "token-1", sandbox_id: "sandbox-1" }, null, 2)}\n`,
    "utf8",
  );

  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "hello", context: {} },
  });
  setNodeRunnerCommand([
    "const encoded = process.argv.at(-1) ?? '';",
    "const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));",
    "const ctx = payload.context._sandbox_runtime_exec_v1;",
    "process.stdout.write(JSON.stringify({ session_id: payload.session_id, input_id: payload.input_id, sequence: 1, event_type: 'run_started', payload: { runtime_exec_context: ctx } }) + '\\n');",
    "process.stdout.write(JSON.stringify({ session_id: payload.session_id, input_id: payload.input_id, sequence: 2, event_type: 'run_completed', payload: { status: 'ok' } }) + '\\n');",
  ]);

  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });
  const registeredRuns: Array<Record<string, string | null>> = [];

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
    registerRunStartedFn: async (params) => {
      registeredRuns.push({
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        inputId: params.inputId,
        runId: params.runId,
        selectedModel: params.selectedModel,
      });
    },
  });

  const events = outputEventsForInput(store, queued);
  assert.equal(events.length, 2);
  const runtimeExecContext = events[0].payload.runtime_exec_context as Record<
    string,
    unknown
  >;
  assert.equal(runtimeExecContext.model_proxy_api_key, "token-1");
  assert.equal(runtimeExecContext.sandbox_id, "sandbox-1");
  assert.equal(
    runtimeExecContext.run_id,
    `workspace-1:session-main:${queued.inputId}`,
  );
  assert.equal(runtimeExecContext.harness, "pi");
  assert.equal(runtimeExecContext.harness_session_id, "session-main");
  assert.deepEqual(registeredRuns, [
    {
      workspaceId: "workspace-1",
      sessionId: "session-main",
      inputId: queued.inputId,
      runId: `workspace-1:session-main:${queued.inputId}`,
      selectedModel: null,
    },
  ]);

  store.close();
});

test("claimed input relays tool, output, and terminal run events for backend-owned sentry traces", async () => {
  const store = makeStore("hb-claimed-input-sentry-run-events-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "go to bing" },
  });

  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });
  const relayedEvents: Array<{
    sequence: number;
    eventType: string;
    payload: Record<string, unknown>;
    timestamp: string;
  }> = [];

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
    registerRunStartedFn: async () => {},
    relayRunEventFn: async (params) => {
      relayedEvents.push({
        sequence: params.sequence,
        eventType: params.eventType,
        payload: params.payload,
        timestamp: params.timestamp,
      });
    },
    executeRunnerRequestFn: async (payload, options = {}) => {
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 1,
        event_type: "run_started",
        payload: { instruction_preview: "go to bing" },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 2,
        event_type: "tool_call",
        payload: {
          phase: "started",
          tool_name: "browser_navigate",
          call_id: "call-1",
          tool_args: { url: "https://bing.com" },
          source: "member-research",
          agent_id: "member-research",
        },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 3,
        event_type: "tool_call",
        payload: {
          phase: "completed",
          tool_name: "browser_navigate",
          call_id: "call-1",
          result: { navigated_to: "https://bing.com" },
          source: "member-research",
          agent_id: "member-research",
        },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 4,
        event_type: "output_delta",
        payload: { delta: "Opened Bing." },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 5,
        event_type: "run_completed",
        payload: {
          status: "ok",
          usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 },
        },
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

  assert.deepEqual(
    relayedEvents.map((event) => [event.sequence, event.eventType]),
    [
      [2, "tool_call"],
      [3, "tool_call"],
      [4, "output_delta"],
      [6, "run_completed"],
    ],
  );
  assert.deepEqual(relayedEvents[0]?.payload, {
    phase: "started",
    tool_name: "browser_navigate",
    call_id: "call-1",
    tool_args: { url: "https://bing.com" },
    source: "member-research",
    agent_id: "member-research",
  });
  assert.deepEqual(relayedEvents[1]?.payload, {
    phase: "completed",
    tool_name: "browser_navigate",
    call_id: "call-1",
    result: { navigated_to: "https://bing.com" },
    source: "member-research",
    agent_id: "member-research",
  });
  assert.deepEqual(relayedEvents[2]?.payload, {
    delta: "Opened Bing.",
  });
  const browserRunBudgetDecisions = recordValue(
    relayedEvents[3]?.payload.context_budget_decisions,
  );
  assert.equal(relayedEvents[3]?.payload.status, "ok");
  assert.deepEqual(relayedEvents[3]?.payload.usage, {
    input_tokens: 12,
    output_tokens: 34,
    total_tokens: 46,
  });
  assert.equal(relayedEvents[3]?.payload.final_output_text, "Opened Bing.");
  assert.equal(relayedEvents[3]?.payload.source, "runner");
  assert.equal(browserRunBudgetDecisions?.pressure_stage, "normal");
  assert.deepEqual(browserRunBudgetDecisions?.lane_decisions, []);
  assert.equal(browserRunBudgetDecisions?.prompt_cache_stable_candidate, false);
  assert.equal(browserRunBudgetDecisions?.tool_replay_trimmed, false);
  assert.equal(browserRunBudgetDecisions?.retrieval_clipped, false);
  assert.equal(browserRunBudgetDecisions?.checkpoint_queued, false);

  store.close();
});

test("claimed input relays skill invocations, coalesced output, and waiting-user run state", async () => {
  const store = makeStore("hb-claimed-input-sentry-rich-run-events-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "deploy after approval" },
  });

  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });
  const relayedEvents: Array<{
    sequence: number;
    eventType: string;
    payload: Record<string, unknown>;
    timestamp: string;
  }> = [];

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
    registerRunStartedFn: async () => {},
    relayRunEventFn: async (params) => {
      relayedEvents.push({
        sequence: params.sequence,
        eventType: params.eventType,
        payload: params.payload,
        timestamp: params.timestamp,
      });
    },
    executeRunnerRequestFn: async (payload, options = {}) => {
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 1,
        event_type: "run_started",
        payload: { instruction_preview: "deploy after approval" },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 2,
        event_type: "output_delta",
        payload: { delta: "Need " },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 3,
        event_type: "output_delta",
        payload: { delta: "approval." },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 4,
        event_type: "skill_invocation",
        payload: {
          phase: "started",
          call_id: "skill-1",
          requested_name: "deployment_review",
          skill_name: "deployment_review",
          skill_id: "deployment_review",
          source: "member-ops",
          agent_id: "member-ops",
        },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 5,
        event_type: "skill_invocation",
        payload: {
          phase: "completed",
          call_id: "skill-1",
          requested_name: "deployment_review",
          skill_name: "deployment_review",
          skill_id: "deployment_review",
          source: "member-ops",
          agent_id: "member-ops",
          granted_tools: ["deploy"],
          active_granted_tools: ["deploy"],
        },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 6,
        event_type: "tool_call",
        payload: {
          phase: "started",
          tool_name: "deploy",
          call_id: "call-1",
          tool_args: { env: "prod" },
          source: "member-ops",
          agent_id: "member-ops",
        },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 7,
        event_type: "tool_call",
        payload: {
          phase: "completed",
          tool_name: "deploy",
          call_id: "call-1",
          result: { status: "waiting_for_user" },
          source: "member-ops",
          agent_id: "member-ops",
        },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 8,
        event_type: "run_completed",
        payload: {
          status: "waiting_user",
          stop_reason: "waiting_user",
          summary: "Deploy paused waiting for confirmation.",
          usage: { input_tokens: 18, output_tokens: 7, total_tokens: 25 },
        },
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

  assert.deepEqual(
    relayedEvents.map((event) => [event.sequence, event.eventType]),
    [
      [3, "output_delta"],
      [4, "skill_invocation"],
      [5, "skill_invocation"],
      [6, "tool_call"],
      [7, "tool_call"],
      [9, "run_state"],
      [10, "run_completed"],
    ],
  );
  assert.deepEqual(relayedEvents[0]?.payload, {
    delta: "Need approval.",
  });
  assert.deepEqual(relayedEvents[1]?.payload, {
    phase: "started",
    call_id: "skill-1",
    requested_name: "deployment_review",
    skill_name: "deployment_review",
    skill_id: "deployment_review",
    source: "member-ops",
    agent_id: "member-ops",
  });
  assert.deepEqual(relayedEvents[2]?.payload, {
    phase: "completed",
    call_id: "skill-1",
    requested_name: "deployment_review",
    skill_name: "deployment_review",
    skill_id: "deployment_review",
    source: "member-ops",
    agent_id: "member-ops",
    granted_tools: ["deploy"],
    active_granted_tools: ["deploy"],
  });
  assert.deepEqual(relayedEvents[5]?.payload, {
    status: "waiting_user",
    stop_reason: "waiting_user",
    message: "Deploy paused waiting for confirmation.",
    source: "runner",
    terminal_event_type: "run_completed",
  });
  assert.equal(relayedEvents[6]?.payload.status, "waiting_user");
  assert.equal(relayedEvents[6]?.payload.stop_reason, "waiting_user");
  assert.equal(
    relayedEvents[6]?.payload.summary,
    "Deploy paused waiting for confirmation.",
  );
  assert.deepEqual(relayedEvents[6]?.payload.usage, {
    input_tokens: 18,
    output_tokens: 7,
    total_tokens: 25,
  });
  const waitingRunBudgetDecisions = recordValue(
    relayedEvents[6]?.payload.context_budget_decisions,
  );
  assert.equal(relayedEvents[6]?.payload.final_output_text, "Need approval.");
  assert.equal(relayedEvents[6]?.payload.source, "runner");
  assert.equal(waitingRunBudgetDecisions?.pressure_stage, "normal");
  assert.deepEqual(waitingRunBudgetDecisions?.lane_decisions, []);
  assert.equal(waitingRunBudgetDecisions?.prompt_cache_stable_candidate, false);
  assert.equal(waitingRunBudgetDecisions?.tool_replay_trimmed, false);
  assert.equal(waitingRunBudgetDecisions?.retrieval_clipped, false);
  assert.equal(waitingRunBudgetDecisions?.checkpoint_queued, false);

  store.close();
});

test("run-start registration strips the model-proxy path before calling the backend route", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];

  await registerWorkspaceAgentRunStarted({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    runId: "workspace-1:session-main:input-1",
    selectedModel: "gpt-5.4",
    runtimeBinding: {
      authToken: "token-1",
      userId: "user-1",
      sandboxId: "sandbox-1",
      modelProxyBaseUrl: "http://127.0.0.1:3060/api/v1/model-proxy",
    },
    fetchImpl: async (input, init) => {
      requests.push({
        url: input instanceof Request ? input.url : String(input),
        init,
      });
      return new Response(null, { status: 200 });
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.url,
    "http://127.0.0.1:3060/api/v1/sandbox/workspaces/workspace-1/agent-runs/start",
  );
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal(
    (requests[0]?.init?.headers as Record<string, string>)["X-API-Key"],
    "token-1",
  );
  assert.equal(
    (requests[0]?.init?.headers as Record<string, string>)[
      "X-Holaboss-User-Id"
    ],
    "user-1",
  );
  assert.equal(
    (requests[0]?.init?.headers as Record<string, string>)[
      "X-Holaboss-Sandbox-Id"
    ],
    "sandbox-1",
  );
  assert.equal(
    requests[0]?.init?.body,
    JSON.stringify({
      session_id: "session-main",
      input_id: "input-1",
      run_id: "workspace-1:session-main:input-1",
      model: "gpt-5.4",
    }),
  );
});

test("run-start registration reports backend failures to Sentry", async () => {
  const sentryCaptures: RuntimeSentryCaptureOptions[] = [];
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    await registerWorkspaceAgentRunStarted({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      inputId: "input-1",
      runId: "workspace-1:session-main:input-1",
      selectedModel: "gpt-5.4",
      runtimeBinding: {
        authToken: "token-1",
        userId: "user-1",
        sandboxId: "sandbox-1",
        modelProxyBaseUrl: "http://127.0.0.1:3060/api/v1/model-proxy",
      },
      captureRuntimeExceptionFn: (capture) => {
        sentryCaptures.push(capture);
      },
      fetchImpl: async () =>
        new Response("binding lookup failed: api_key=secret-token", {
          status: 401,
        }),
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(sentryCaptures.length, 1);
  assert.equal(
    sentryCaptures[0]?.tags?.failure_kind,
    "backend_run_start_registration",
  );
  assert.equal(sentryCaptures[0]?.tags?.http_status, 401);
  assert.equal(
    sentryCaptures[0]?.contexts?.agent_run_registration?.path_suffix,
    "start",
  );
  assert.equal(sentryCaptures[0]?.contexts?.runtime_binding?.user_id, "user-1");
  assert.equal(
    sentryCaptures[0]?.extras?.response_body,
    "binding lookup failed: api_key=[REDACTED]",
  );
  assert.deepEqual(sentryCaptures[0]?.extras?.request_body, {
    session_id: "session-main",
    input_id: "input-1",
    run_id: "workspace-1:session-main:input-1",
    model: "gpt-5.4",
  });
});

test("run-start registration reports fetch socket diagnostics to Sentry", async () => {
  const sentryCaptures: RuntimeSentryCaptureOptions[] = [];
  const originalWarn = console.warn;
  console.warn = () => {};
  const fetchError = new TypeError("fetch failed");
  Object.assign(fetchError, {
    cause: {
      name: "SocketError",
      message: "other side closed",
      code: "UND_ERR_SOCKET",
      socket: {
        localAddress: "198.18.0.1",
        localPort: 51240,
        remoteAddress: "35.160.37.189",
        remotePort: 3060,
        remoteFamily: "IPv4",
        bytesWritten: 749,
        bytesRead: 0,
      },
    },
  });

  try {
    await registerWorkspaceAgentRunStarted({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      inputId: "input-1",
      runId: "workspace-1:session-main:input-1",
      selectedModel: "elephant-alpha",
      runtimeBinding: {
        authToken: "token-1",
        userId: "user-1",
        sandboxId: "sandbox-1",
        modelProxyBaseUrl: "http://127.0.0.1:3060/api/v1/model-proxy",
      },
      captureRuntimeExceptionFn: (capture) => {
        sentryCaptures.push(capture);
      },
      fetchImpl: async () => {
        throw fetchError;
      },
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(sentryCaptures.length, 1);
  assert.deepEqual(sentryCaptures[0]?.extras?.fetch_error, {
    error: {
      name: "TypeError",
      message: "fetch failed",
    },
    cause: {
      name: "SocketError",
      message: "other side closed",
      code: "UND_ERR_SOCKET",
    },
    socket: {
      localAddress: "198.18.0.1",
      localPort: 51240,
      remoteAddress: "35.160.37.189",
      remotePort: 3060,
      remoteFamily: "IPv4",
      bytesWritten: 749,
      bytesRead: 0,
    },
  });
  assert.equal(sentryCaptures[0]?.extras?.timeout_ms, 2000);
});

test("run-event registration strips the model-proxy path before calling the backend route", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];

  await registerWorkspaceAgentRunEvent({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    runId: "workspace-1:session-main:input-1",
    sequence: 3,
    eventType: "tool_call",
    payload: {
      phase: "completed",
      tool_name: "search_docs",
      call_id: "call-1",
      result: { title: "Bing" },
    },
    timestamp: "2026-04-18T00:00:00.000Z",
    runtimeBinding: {
      authToken: "token-1",
      userId: "user-1",
      sandboxId: "sandbox-1",
      modelProxyBaseUrl: "http://127.0.0.1:3060/api/v1/model-proxy",
    },
    fetchImpl: async (input, init) => {
      requests.push({
        url: input instanceof Request ? input.url : String(input),
        init,
      });
      return new Response(null, { status: 200 });
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.url,
    "http://127.0.0.1:3060/api/v1/sandbox/workspaces/workspace-1/agent-runs/events",
  );
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal(
    (requests[0]?.init?.headers as Record<string, string>)["X-API-Key"],
    "token-1",
  );
  assert.equal(
    (requests[0]?.init?.headers as Record<string, string>)[
      "X-Holaboss-User-Id"
    ],
    "user-1",
  );
  assert.equal(
    (requests[0]?.init?.headers as Record<string, string>)[
      "X-Holaboss-Sandbox-Id"
    ],
    "sandbox-1",
  );
  assert.equal(
    requests[0]?.init?.body,
    JSON.stringify({
      session_id: "session-main",
      input_id: "input-1",
      run_id: "workspace-1:session-main:input-1",
      sequence: 3,
      event_type: "tool_call",
      payload: {
        phase: "completed",
        tool_name: "search_docs",
        call_id: "call-1",
        result: { title: "Bing" },
      },
      timestamp: "2026-04-18T00:00:00.000Z",
    }),
  );
});

test("claimed input resolves evolve model context from the provider background tasks model", async () => {
  const store = makeStore("hb-claimed-input-background-model-");
  const sandboxRoot = makeTempDir("hb-claimed-input-background-root-");
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = path.join(
    sandboxRoot,
    "state",
    "runtime-config.json",
  );
  fs.mkdirSync(path.join(sandboxRoot, "state"), { recursive: true });
  fs.writeFileSync(
    process.env.HOLABOSS_RUNTIME_CONFIG_PATH,
    `${JSON.stringify(
      {
        runtime: {
          background_tasks: {
            provider: "anthropic_direct",
            model: "claude-sonnet-4-6",
          },
        },
        providers: {
          anthropic_direct: {
            kind: "anthropic_native",
            base_url: "https://api.anthropic.com",
            api_key: "sk-ant-test",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const memoryService: MemoryServiceLike = {
    async search() {
      return { results: [] };
    },
    async get() {
      return { path: "", text: "" };
    },
    async upsert(payload: Record<string, unknown>) {
      return { path: payload.path, text: payload.content };
    },
    async status() {
      return {};
    },
    async sync() {
      return {};
    },
  };
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "hello", model: "anthropic_direct/claude-opus-4-6" },
  });

  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });

  let capturedModelContext: Record<string, unknown> | null = null;
  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
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
    runEvolveTasksFn: async (options) => {
      capturedModelContext = options.modelContext as unknown as Record<
        string,
        unknown
      >;
    },
  });

  assert.ok(capturedModelContext);
  const modelContext = capturedModelContext as { modelClient: unknown };
  assert.deepEqual(modelContext.modelClient, {
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-ant-test",
    defaultHeaders: null,
    modelId: "claude-sonnet-4-6",
    apiStyle: "anthropic_native",
  });

  store.close();
});

test("claimed onboarding input instructs native onboarding tools directly", async () => {
  const store = makeStore("hb-claimed-input-onboarding-native-tools-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
    onboardingStatus: "pending",
    onboardingSessionId: "session-onboarding",
  });
  fs.writeFileSync(
    path.join(store.workspaceDir(workspace.id), "ONBOARD.md"),
    "# Workspace Onboarding\n\nAsk concise setup questions.\n",
    "utf8",
  );
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-onboarding",
    payload: { text: "yes" },
  });

  let capturedInstruction = "";
  await processClaimedInput({
    store,
    record: queued,
    executeRunnerRequestFn: async (payload, options = {}) => {
      capturedInstruction = String(payload.instruction ?? "");
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 1,
        event_type: "run_started",
        payload: { instruction_preview: capturedInstruction.slice(0, 120) },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 2,
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

  assert.match(capturedInstruction, /onboarding_status/);
  assert.match(capturedInstruction, /holaboss_onboarding_complete/);
  assert.doesNotMatch(capturedInstruction, /`hb`/);

  store.close();
});

test("claimed onboarding input includes ONBOARD.md verbatim", async () => {
  const store = makeStore("hb-claimed-input-onboarding-verbatim-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
    onboardingStatus: "pending",
    onboardingSessionId: "session-onboarding",
  });
  fs.writeFileSync(
    path.join(store.workspaceDir(workspace.id), "ONBOARD.md"),
    "opening_sentence: What is the primary goal for this workspace?\n\n# Workspace Onboarding\n\nAsk concise setup questions.\n",
    "utf8",
  );
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-onboarding",
    payload: { text: "yes" },
  });

  let capturedInstruction = "";
  await processClaimedInput({
    store,
    record: queued,
    executeRunnerRequestFn: async (payload, options = {}) => {
      capturedInstruction = String(payload.instruction ?? "");
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 1,
        event_type: "run_started",
        payload: { instruction_preview: capturedInstruction.slice(0, 120) },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 2,
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

  assert.match(
    capturedInstruction,
    /opening_sentence: What is the primary goal for this workspace\?/,
  );
  assert.doesNotMatch(
    capturedInstruction,
    /opening_sentence may already be visible/,
  );

  store.close();
});

test("claimed input persists replacement harness session id from terminal runner event", async () => {
  const store = makeStore("hb-claimed-input-harness-session-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
    harness: "pi",
    harnessSessionId: "existing-session",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "hello" },
  });
  setNodeRunnerCommand([
    "const request = process.argv.at(-1) ?? '';",
    "void request;",
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 1, event_type: 'run_started', payload: { status: 'started' } }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 2, event_type: 'run_completed', payload: { status: 'ok', harness_session_id: 'replacement-session' } }) + '\\n');`,
  ]);

  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
  });

  const binding = store.getBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
  });

  assert.ok(binding);
  assert.equal(binding.harnessSessionId, "replacement-session");

  store.close();
});

test("claimed input queues a background session checkpoint when PI context crosses the compaction threshold", async () => {
  const store = makeStore("hb-claimed-input-session-checkpoint-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const harnessSessionFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "hb-pi-session-")),
    "session.jsonl",
  );
  fs.writeFileSync(harnessSessionFile, '{"type":"header"}\n', "utf8");
  tempDirs.push(path.dirname(harnessSessionFile));
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "hello" },
  });
  let queuedCheckpointParams: {
    harnessSessionId: string | null;
    contextUsage: PiContextUsage | null;
    inputId: string;
    sessionId: string;
    workspaceId: string;
  } | null = null;

  await processClaimedInput({
    store,
    record: queued,
    enqueueSessionCheckpointJobFn: (params) => {
      queuedCheckpointParams = {
        harnessSessionId: params.harnessSessionId,
        contextUsage: params.contextUsage,
        inputId: params.inputId,
        sessionId: params.sessionId,
        workspaceId: params.workspaceId,
      };
      return null;
    },
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
        event_type: "run_completed",
        payload: {
          status: "success",
          harness_session_id: harnessSessionFile,
          context_usage: {
            tokens: 50_000,
            context_window: 65_536,
            percent: 76.3,
          },
        },
      });
      store.upsertBinding({
        workspaceId: workspace.id,
        sessionId: "session-main",
        harness: "pi",
        harnessSessionId: "session-main",
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

  if (!queuedCheckpointParams) {
    assert.fail("expected checkpoint enqueue to be called");
  }
  const checkpointParams: {
    harnessSessionId: string | null;
    contextUsage: PiContextUsage | null;
    inputId: string;
    sessionId: string;
    workspaceId: string;
  } = queuedCheckpointParams;
  assert.equal(checkpointParams.workspaceId, workspace.id);
  assert.equal(checkpointParams.sessionId, "session-main");
  assert.equal(checkpointParams.inputId, queued.inputId);
  assert.equal(checkpointParams.harnessSessionId, harnessSessionFile);
  assert.deepEqual(checkpointParams.contextUsage, {
    tokens: 50_000,
    contextWindow: 65_536,
    percent: 76.3,
  });

  store.close();
});

test("claimed input waits for an in-flight session checkpoint before starting the runner", async () => {
  const store = makeStore("hb-claimed-input-session-checkpoint-gate-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const checkpointJob = store.enqueuePostRunJob({
    jobType: "session_checkpoint",
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: "prior-input",
    payload: {
      context_usage: {
        tokens: 50_000,
        context_window: 65_536,
        percent: 76.3,
      },
    },
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "hello" },
  });

  let checkpointReleased = false;
  setTimeout(() => {
    checkpointReleased = true;
    store.updatePostRunJob({
      workspaceId: workspace.id,
      jobId: checkpointJob.jobId,
      fields: {
        status: "DONE",
        claimedBy: null,
        claimedUntil: null,
        lastError: null,
      },
    });
  }, 50);

  let runnerStarted = false;
  await processClaimedInput({
    store,
    record: queued,
    executeRunnerRequestFn: async (payload, options = {}) => {
      runnerStarted = true;
      assert.equal(checkpointReleased, true);
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
        event_type: "run_completed",
        payload: { status: "success" },
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

  assert.equal(runnerStarted, true);
  assert.equal(
    store.getPostRunJob({ workspaceId: workspace.id, jobId: checkpointJob.jobId })?.status,
    "DONE",
  );

  store.close();
});

test("claimed input passes persisted child session kind into the runner payload", async () => {
  const store = makeStore("hb-claimed-input-session-kind-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "proposal-session-1",
    kind: "task_proposal",
    parentSessionId: "session-main",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "proposal-session-1",
    payload: { text: "hello" },
  });

  let capturedSessionKind = "";
  await processClaimedInput({
    store,
    record: queued,
    executeRunnerRequestFn: async (payload, options = {}) => {
      capturedSessionKind = String(payload.session_kind ?? "");
      await options.onEvent?.({
        session_id: String(payload.session_id),
        input_id: String(payload.input_id),
        sequence: 1,
        event_type: "run_started",
        payload: {},
      });
      await options.onEvent?.({
        session_id: String(payload.session_id),
        input_id: String(payload.input_id),
        sequence: 2,
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

  assert.equal(capturedSessionKind, "task_proposal");
  store.close();
});

test("claimed input persists terminal harness session binding after run_failed", async () => {
  const store = makeStore("hb-claimed-input-harness-session-reset-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
    harness: "pi",
    harnessSessionId: "stale-pi-session",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "hello" },
  });
  setNodeRunnerCommand([
    "const request = process.argv.at(-1) ?? '';",
    "void request;",
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 1, event_type: 'run_started', payload: { status: 'started' } }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 2, event_type: 'run_failed', payload: { type: 'OpenCodeSessionError', message: 'boom', harness_session_id: 'failed-session' } }) + '\\n');`,
  ]);

  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
  });

  const binding = store.getBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
  });

  assert.ok(binding);
  assert.equal(binding.harnessSessionId, "failed-session");
  store.close();
});

test("claimed input keeps existing harness session binding when run_failed omits one", async () => {
  const store = makeStore("hb-claimed-input-harness-session-failed-keep-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
    harness: "pi",
    harnessSessionId: "stale-pi-session",
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "hello" },
  });
  setNodeRunnerCommand([
    "const request = process.argv.at(-1) ?? '';",
    "void request;",
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 1, event_type: 'run_started', payload: { status: 'started' } }) + '\\n');`,
    `process.stdout.write(JSON.stringify({ session_id: 'session-main', input_id: '${queued.inputId}', sequence: 2, event_type: 'run_failed', payload: { type: 'OpenCodeSessionError', message: 'boom' } }) + '\\n');`,
  ]);

  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
  });

  const binding = store.getBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
  });

  assert.ok(binding);
  assert.equal(binding.harnessSessionId, "stale-pi-session");
  store.close();
});

test("claimed input compacts a reused PI session before a smaller-window model run", async () => {
  const store = makeStore("hb-claimed-input-prerun-compaction-downshift-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const workspaceDir = store.workspaceDir(workspace.id);
  const { sessionManager, sessionFile } = createPiSessionFile({
    workspaceDir,
    sessionDir: path.join(workspaceDir, ".holaboss", "pi-sessions"),
  });
  sessionManager.appendMessage(piUserMessage("x".repeat(260_000)));
  const assistantEntryId = sessionManager.appendMessage(
    piAssistantMessage("previous response"),
  );
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
    harness: "pi",
    harnessSessionId: sessionFile,
  });
  const previousInput = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "previous", model: "openai_codex/gpt-5.4" },
  });
  store.updateInput({
    workspaceId: workspace.id,
    inputId: previousInput.inputId,
    fields: { status: "DONE" },
  });
  store.upsertTurnResult({
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: previousInput.inputId,
    startedAt: "2026-05-11T00:00:00.000Z",
    completedAt: "2026-05-11T00:01:00.000Z",
    status: "completed",
    stopReason: "completed",
    assistantText: "previous response",
    toolUsageSummary: {
      total_calls: 0,
      completed_calls: 0,
      failed_calls: 0,
      tool_names: [],
      tool_ids: [],
    },
    permissionDenials: [],
    promptSectionIds: [],
    capabilityManifestFingerprint: null,
    requestSnapshotFingerprint: null,
    promptCacheProfile: null,
    contextBudgetDecisions: {
      context_usage: {
        tokens: 650_000,
        context_window: 1_000_000,
        percent: 65,
      },
    },
    tokenUsage: null,
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "new task", model: "openai_codex/gpt-5.5" },
  });
  upsertTurnRequestSnapshotFixture({
    store,
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: queued.inputId,
    model: "openai_codex/gpt-5.5",
    providerId: "openai_codex",
    modelId: "gpt-5.5",
    instructionSize: 2_048,
  });
  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });
  let compactionCalls = 0;

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
    registerRunStartedFn: async () => {},
    relayRunEventFn: async () => {},
    resolveRuntimeModelClientFn: () => ({
      providerId: "openai_codex",
      configuredProviderId: "openai_codex",
      modelId: "gpt-5.5",
      modelToken: "openai_codex/gpt-5.5",
      modelProxyProvider: "openai_compatible",
      modelClient: {
        model_proxy_provider: "openai_compatible",
        api_key: "runtime-api-key",
        base_url: "https://runtime.example/api/v1/model-proxy",
        default_headers: {
          "X-API-Key": "runtime-api-key",
        },
      },
    }),
    runPiSessionCompactionFn: async (requestPayload) => {
      compactionCalls += 1;
      const snapshotSessionFile = String(requestPayload.harness_session_id);
      openPiSessionManager(snapshotSessionFile).appendCompaction(
        "Compacted history",
        assistantEntryId,
        650_000,
        { readFiles: [], modifiedFiles: [] },
        false,
      );
      return {
        compacted: true,
        session_file: snapshotSessionFile,
        result: {
          summary: "Compacted history",
          firstKeptEntryId: assistantEntryId,
          tokensBefore: 650_000,
          details: { readFiles: [], modifiedFiles: [] },
        },
        reason: null,
        diagnostics: {
          context_usage: {
            tokens: 650_000,
            contextWindow: 1_000_000,
            percent: 65,
          },
        },
        error: null,
      };
    },
    executeRunnerRequestFn: async (payload, options = {}) => {
      const execContext = recordValue(
        recordValue(payload.context)?._sandbox_runtime_exec_v1,
      );
      assert.equal(execContext?.harness_session_id, sessionFile);
      assert.ok(latestPiCompactionEntry(sessionFile));
      await options.onEvent?.({
        session_id: String(payload.session_id),
        input_id: String(payload.input_id),
        sequence: 1,
        event_type: "run_started",
        payload: {},
      });
      await options.onEvent?.({
        session_id: String(payload.session_id),
        input_id: String(payload.input_id),
        sequence: 2,
        event_type: "run_completed",
        payload: {
          status: "completed",
          harness_session_id: sessionFile,
          context_usage: {
            tokens: 110_000,
            context_window: 400_000,
            percent: 27.5,
          },
        },
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

  assert.equal(compactionCalls, 1);
  const turnResult = turnResultForInput(store, queued);
  const preRunTelemetry = recordValue(
    recordValue(turnResult?.contextBudgetDecisions)?.pre_run_compaction,
  );
  assert.equal(turnResult?.status, "completed");
  assert.ok(preRunTelemetry);
  assert.equal(preRunTelemetry?.initial_decision, "would_overflow");
  assert.equal(preRunTelemetry?.final_decision, "fit");
  assert.equal(preRunTelemetry?.trigger_reason, "model_downshift_projected_overflow");
  assert.equal(preRunTelemetry?.compaction_attempted, true);
  assert.equal(preRunTelemetry?.compaction_changed_branch, true);
  assert.equal(preRunTelemetry?.reset_required, false);
  assert.equal(preRunTelemetry?.previous_selected_model, "openai_codex/gpt-5.4");
  assert.equal(preRunTelemetry?.target_selected_model, "openai_codex/gpt-5.5");
  assert.ok(latestPiCompactionEntry(sessionFile));
  store.close();
});

test("claimed input synthesizes a turn request snapshot for main-session background followups before pre-run compaction", async () => {
  const store = makeStore(
    "hb-claimed-input-main-session-followup-prerun-snapshot-",
  );
  const workspace = store.createWorkspace({
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
  const workspaceDir = store.workspaceDir(workspace.id);
  const { sessionManager, sessionFile } = createPiSessionFile({
    workspaceDir,
    sessionDir: path.join(workspaceDir, ".holaboss", "pi-sessions"),
  });
  sessionManager.appendMessage(piUserMessage("x".repeat(260_000)));
  const assistantEntryId = sessionManager.appendMessage(
    piAssistantMessage("previous response"),
  );
  persistWorkspaceHarnessSessionId({
    workspaceDir,
    harness: "pi",
    sessionId: sessionFile,
  });
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
    harness: "pi",
    harnessSessionId: sessionFile,
  });
  const previousInput = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "previous", model: "openai_codex/gpt-5.4" },
  });
  store.updateInput({
    workspaceId: workspace.id,
    inputId: previousInput.inputId,
    fields: { status: "DONE" },
  });
  store.upsertTurnResult({
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: previousInput.inputId,
    startedAt: "2026-05-11T00:00:00.000Z",
    completedAt: "2026-05-11T00:01:00.000Z",
    status: "completed",
    stopReason: "completed",
    assistantText: "previous response",
    toolUsageSummary: {
      total_calls: 0,
      completed_calls: 0,
      failed_calls: 0,
      tool_names: [],
      tool_ids: [],
    },
    permissionDenials: [],
    promptSectionIds: [],
    capabilityManifestFingerprint: null,
    requestSnapshotFingerprint: null,
    promptCacheProfile: null,
    contextBudgetDecisions: {
      context_usage: {
        tokens: 650_000,
        context_window: 1_000_000,
        percent: 65,
      },
    },
    tokenUsage: null,
  });
  upsertTurnRequestSnapshotFixture({
    store,
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: previousInput.inputId,
    model: "openai_codex/gpt-5.4",
    providerId: "openai_codex",
    modelId: "gpt-5.4",
  });
  const malformedSnapshotInput = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: {
      text: "broken synthetic followup snapshot",
      model: "openai_codex/gpt-5.4",
    },
  });
  store.updateInput({
    workspaceId: workspace.id,
    inputId: malformedSnapshotInput.inputId,
    fields: { status: "FAILED" },
  });
  store.upsertTurnRequestSnapshot({
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: malformedSnapshotInput.inputId,
    snapshotKind: "harness_host_request",
    fingerprint: `snapshot-${malformedSnapshotInput.inputId}`,
    payload: {
      schema_version: 1,
      snapshot_kind: "harness_host_request",
      workspace_id: workspace.id,
      session_id: "session-main",
      input_id: malformedSnapshotInput.inputId,
      harness_id: "pi",
      raw_instruction: "broken synthetic followup snapshot",
      attachments: [],
      image_urls: [],
      runtime_config: {
        provider_id: "openai_codex",
        model_id: "gpt-5.4",
        model_client: {
          model_proxy_provider: "openai_compatible",
          base_url: "https://runtime.example/api/v1/model-proxy",
          default_headers: null,
        },
      },
      harness_request: {
        workspace_id: workspace.id,
        session_id: "session-main",
        input_id: malformedSnapshotInput.inputId,
        instruction: "broken synthetic followup snapshot",
        attachments: [],
        image_urls: [],
        provider_id: "openai_codex",
        model_id: "gpt-5.4",
        model_client: {
          model_proxy_provider: "openai_compatible",
          api_key: "[redacted]",
          base_url: "https://runtime.example/api/v1/model-proxy",
          default_headers: null,
        },
      },
    },
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
      summary: "Research report is ready.",
    },
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: {
      text: "[Holaboss Main Session Event Batch v1]\nSummarize the queued event.",
      model: "openai_codex/gpt-5.5",
      context: {
        source: "main_session_event_batch",
        main_session_event_ids: [event.eventId],
        delivery_bucket: "background_update",
      },
    },
    idempotencyKey: `main-session-event-batch:${event.eventId}`,
  });
  store.markMainSessionEventsMaterialized({
    workspaceId: workspace.id,
    eventIds: [event.eventId],
    materializedInputId: queued.inputId,
  });
  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });
  assert.equal(turnRequestSnapshotForInput(store, queued), null);
  let compactionCalls = 0;

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
    registerRunStartedFn: async () => {},
    relayRunEventFn: async () => {},
    resolveRuntimeModelClientFn: () => ({
      providerId: "openai_codex",
      configuredProviderId: "openai_codex",
      modelId: "gpt-5.5",
      modelToken: "openai_codex/gpt-5.5",
      modelProxyProvider: "openai_compatible",
      modelClient: {
        model_proxy_provider: "openai_compatible",
        api_key: "runtime-api-key",
        base_url: "https://runtime.example/api/v1/model-proxy",
        default_headers: {
          "X-API-Key": "runtime-api-key",
        },
      },
    }),
    runPiSessionCompactionFn: async (requestPayload) => {
      compactionCalls += 1;
      const snapshotSessionFile = String(requestPayload.harness_session_id);
      openPiSessionManager(snapshotSessionFile).appendCompaction(
        "Compacted followup history",
        assistantEntryId,
        650_000,
        { readFiles: [], modifiedFiles: [] },
        false,
      );
      return {
        compacted: true,
        session_file: snapshotSessionFile,
        result: {
          summary: "Compacted followup history",
          firstKeptEntryId: assistantEntryId,
          tokensBefore: 650_000,
          details: { readFiles: [], modifiedFiles: [] },
        },
        reason: null,
        diagnostics: {
          context_usage: {
            tokens: 650_000,
            contextWindow: 1_000_000,
            percent: 65,
          },
        },
        error: null,
      };
    },
    executeRunnerRequestFn: async (payload, options = {}) => {
      const execContext = recordValue(
        recordValue(payload.context)?._sandbox_runtime_exec_v1,
      );
      const snapshotSessionFile =
        typeof execContext?.harness_session_id === "string"
          ? execContext.harness_session_id
          : "";
      assert.ok(snapshotSessionFile);
      assert.notEqual(snapshotSessionFile, sessionFile);
      assert.ok(latestPiCompactionEntry(sessionFile));

      const snapshot = turnRequestSnapshotForInput(store, queued);
      const snapshotPayload = recordValue(snapshot?.payload);
      const harnessRequest = recordValue(snapshotPayload?.harness_request);
      assert.ok(snapshot);
      assert.equal(snapshot?.snapshotKind, "harness_host_request");
      assert.equal(harnessRequest?.provider_id, "openai_codex");
      assert.equal(harnessRequest?.model_id, "gpt-5.5");
      assert.equal(harnessRequest?.workspace_dir, workspaceDir);
      assert.equal(harnessRequest?.timeout_seconds, 1800);
      assert.equal(
        harnessRequest?.workspace_config_checksum,
        `checksum-${workspace.id}`,
      );
      assert.equal(
        recordValue(harnessRequest?.model_client)?.default_headers,
        null,
      );

      await options.onEvent?.({
        session_id: String(payload.session_id),
        input_id: String(payload.input_id),
        sequence: 1,
        event_type: "run_started",
        payload: {},
      });
      await options.onEvent?.({
        session_id: String(payload.session_id),
        input_id: String(payload.input_id),
        sequence: 2,
        event_type: "run_completed",
        payload: {
          status: "completed",
          harness_session_id: snapshotSessionFile,
          context_usage: {
            tokens: 110_000,
            context_window: 400_000,
            percent: 27.5,
          },
        },
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

  assert.equal(compactionCalls, 1);
  const snapshot = turnRequestSnapshotForInput(store, queued);
  const turnResult = turnResultForInput(store, queued);
  const preRunTelemetry = recordValue(
    recordValue(turnResult?.contextBudgetDecisions)?.pre_run_compaction,
  );
  assert.ok(snapshot);
  assert.equal(turnResult?.status, "completed");
  assert.ok(preRunTelemetry);
  assert.equal(preRunTelemetry?.initial_decision, "would_overflow");
  assert.equal(preRunTelemetry?.final_decision, "fit");
  store.close();
});

test("claimed input continues when pre-run compaction cannot get below the maintenance threshold", async () => {
  const store = makeStore("hb-claimed-input-prerun-compaction-soft-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const workspaceDir = store.workspaceDir(workspace.id);
  const { sessionManager, sessionFile } = createPiSessionFile({
    workspaceDir,
    sessionDir: path.join(workspaceDir, ".holaboss", "pi-sessions"),
  });
  sessionManager.appendMessage(piUserMessage("x".repeat(260_000)));
  sessionManager.appendMessage(piAssistantMessage("previous response"));
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
    harness: "pi",
    harnessSessionId: sessionFile,
  });
  const previousInput = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "previous", model: "openai_codex/gpt-5.5" },
  });
  store.updateInput({
    workspaceId: workspace.id,
    inputId: previousInput.inputId,
    fields: { status: "DONE" },
  });
  store.upsertTurnResult({
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: previousInput.inputId,
    startedAt: "2026-05-11T00:00:00.000Z",
    completedAt: "2026-05-11T00:01:00.000Z",
    status: "completed",
    stopReason: "completed",
    assistantText: "previous response",
    toolUsageSummary: {
      total_calls: 0,
      completed_calls: 0,
      failed_calls: 0,
      tool_names: [],
      tool_ids: [],
    },
    permissionDenials: [],
    promptSectionIds: [],
    capabilityManifestFingerprint: null,
    requestSnapshotFingerprint: null,
    promptCacheProfile: null,
    contextBudgetDecisions: {
      context_usage: {
        tokens: 130_100,
        context_window: 400_000,
        percent: 32.5,
      },
    },
    tokenUsage: null,
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "new task", model: "openai_codex/gpt-5.5" },
  });
  upsertTurnRequestSnapshotFixture({
    store,
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: queued.inputId,
    model: "openai_codex/gpt-5.5",
    providerId: "openai_codex",
    modelId: "gpt-5.5",
    instructionSize: 1_024,
  });
  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });
  let runnerCalled = false;

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
    registerRunStartedFn: async () => {},
    relayRunEventFn: async () => {},
    resolveRuntimeModelClientFn: () => ({
      providerId: "openai_codex",
      configuredProviderId: "openai_codex",
      modelId: "gpt-5.5",
      modelToken: "openai_codex/gpt-5.5",
      modelProxyProvider: "openai_compatible",
      modelClient: {
        model_proxy_provider: "openai_compatible",
        api_key: "runtime-api-key",
        base_url: "https://runtime.example/api/v1/model-proxy",
        default_headers: {
          "X-API-Key": "runtime-api-key",
        },
      },
    }),
    runPiSessionCompactionFn: async (requestPayload) => ({
      compacted: false,
      session_file: String(requestPayload.harness_session_id),
      result: null,
      reason: "already_compacted",
      diagnostics: {
        context_usage: {
          tokens: 130_100,
          contextWindow: 400_000,
          percent: 32.5,
        },
      },
      error: null,
    }),
    executeRunnerRequestFn: async (payload, options = {}) => {
      runnerCalled = true;
      await options.onEvent?.({
        session_id: String(payload.session_id),
        input_id: String(payload.input_id),
        sequence: 1,
        event_type: "run_started",
        payload: {},
      });
      await options.onEvent?.({
        session_id: String(payload.session_id),
        input_id: String(payload.input_id),
        sequence: 2,
        event_type: "run_completed",
        payload: {
          status: "completed",
          harness_session_id: sessionFile,
          context_usage: {
            tokens: 100_000,
            context_window: 400_000,
            percent: 25,
          },
        },
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

  assert.equal(runnerCalled, true);
  const updated = store.getInput({
    workspaceId: workspace.id,
    inputId: queued.inputId,
  });
  const turnResult = turnResultForInput(store, queued);
  const preRunTelemetry = recordValue(
    recordValue(turnResult?.contextBudgetDecisions)?.pre_run_compaction,
  );
  assert.equal(updated?.status, "DONE");
  assert.equal(turnResult?.status, "completed");
  assert.notEqual(turnResult?.stopReason, "session_reset_required");
  assert.ok(preRunTelemetry);
  assert.equal(preRunTelemetry?.initial_decision, "threshold_exceeded");
  assert.equal(preRunTelemetry?.final_decision, "threshold_exceeded");
  assert.equal(preRunTelemetry?.compaction_attempted, true);
  assert.equal(preRunTelemetry?.compaction_changed_branch, false);
  assert.equal(preRunTelemetry?.reset_required, false);
  store.close();
});

// Unreachable scenario after feat/onboarding introduced
// ensureClaimedInputTurnRequestSnapshot, which synthesizes a snapshot before
// pre-run compaction runs. The "no snapshot at pre-run time" branch this
// test exercised can no longer be hit from inside processClaimedInput.
// Left as a skip rather than deleted so an onboarding-author can decide
// whether the test is vestigial or the synth path needs a guarded exit.
nodeTest.skip("claimed input skips threshold-only pre-run compaction when no turn request snapshot exists", async () => {
  const store = makeStore("hb-claimed-input-prerun-no-snapshot-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const workspaceDir = store.workspaceDir(workspace.id);
  const { sessionManager, sessionFile } = createPiSessionFile({
    workspaceDir,
    sessionDir: path.join(workspaceDir, ".holaboss", "pi-sessions"),
  });
  sessionManager.appendMessage(piUserMessage("x".repeat(80_000)));
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
    harness: "pi",
    harnessSessionId: sessionFile,
  });
  const previousInput = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "previous", model: "openai_codex/gpt-5.5" },
  });
  store.updateInput({
    workspaceId: workspace.id,
    inputId: previousInput.inputId,
    fields: { status: "DONE" },
  });
  store.upsertTurnResult({
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: previousInput.inputId,
    startedAt: "2026-05-11T00:00:00.000Z",
    completedAt: "2026-05-11T00:01:00.000Z",
    status: "completed",
    stopReason: "completed",
    assistantText: "previous response",
    toolUsageSummary: {
      total_calls: 0,
      completed_calls: 0,
      failed_calls: 0,
      tool_names: [],
      tool_ids: [],
    },
    permissionDenials: [],
    promptSectionIds: [],
    capabilityManifestFingerprint: null,
    requestSnapshotFingerprint: null,
    promptCacheProfile: null,
    contextBudgetDecisions: {
      context_usage: {
        tokens: 40_000,
        context_window: 65_536,
        percent: 61,
      },
    },
    tokenUsage: null,
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "synthetic follow-up", model: "openai_codex/gpt-5.5" },
  });
  let runnerCalled = false;

  await processClaimedInput({
    store,
    record: queued,
    registerRunStartedFn: async () => {},
    relayRunEventFn: async () => {},
    executeRunnerRequestFn: async (payload, options = {}) => {
      runnerCalled = true;
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
        payload: { delta: "Done." },
      });
      await options.onEvent?.({
        session_id: payload.session_id,
        input_id: payload.input_id,
        sequence: 3,
        event_type: "run_completed",
        payload: { status: "completed" },
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

  const updated = store.getInput({
    workspaceId: workspace.id,
    inputId: queued.inputId,
  });
  const turnResult = turnResultForInput(store, queued);
  const preRunTelemetry = recordValue(
    recordValue(turnResult?.contextBudgetDecisions)?.pre_run_compaction,
  );

  assert.equal(runnerCalled, true);
  assert.equal(updated?.status, "DONE");
  assert.equal(turnResult?.status, "completed");
  assert.ok(preRunTelemetry);
  assert.equal(preRunTelemetry?.initial_decision, "threshold_exceeded");
  assert.equal(preRunTelemetry?.final_decision, "threshold_exceeded");
  assert.equal(preRunTelemetry?.compaction_attempted, false);
  assert.equal(preRunTelemetry?.reset_required, false);
  store.close();
});

test("claimed input retries once after a provider context overflow and succeeds after runtime compaction", async () => {
  const store = makeStore("hb-claimed-input-overflow-recovery-success-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const workspaceDir = store.workspaceDir(workspace.id);
  const { sessionManager, sessionFile } = createPiSessionFile({
    workspaceDir,
    sessionDir: path.join(workspaceDir, ".holaboss", "pi-sessions"),
  });
  sessionManager.appendMessage(piUserMessage("x".repeat(80_000)));
  const assistantEntryId = sessionManager.appendMessage(
    piAssistantMessage("previous response"),
  );
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
    harness: "pi",
    harnessSessionId: sessionFile,
  });
  const previousInput = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "previous", model: "openai_codex/gpt-5.5" },
  });
  store.updateInput({
    workspaceId: workspace.id,
    inputId: previousInput.inputId,
    fields: { status: "DONE" },
  });
  store.upsertTurnResult({
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: previousInput.inputId,
    startedAt: "2026-05-11T00:00:00.000Z",
    completedAt: "2026-05-11T00:01:00.000Z",
    status: "completed",
    stopReason: "completed",
    assistantText: "previous response",
    toolUsageSummary: {
      total_calls: 0,
      completed_calls: 0,
      failed_calls: 0,
      tool_names: [],
      tool_ids: [],
    },
    permissionDenials: [],
    promptSectionIds: [],
    capabilityManifestFingerprint: null,
    requestSnapshotFingerprint: null,
    promptCacheProfile: null,
    contextBudgetDecisions: {
      context_usage: {
        tokens: 100_000,
        context_window: 400_000,
        percent: 25,
      },
    },
    tokenUsage: null,
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "new task", model: "openai_codex/gpt-5.5" },
  });
  upsertTurnRequestSnapshotFixture({
    store,
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: queued.inputId,
    model: "openai_codex/gpt-5.5",
    providerId: "openai_codex",
    modelId: "gpt-5.5",
    instructionSize: 1_024,
  });
  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });
  let compactionCalls = 0;
  let runnerCalls = 0;

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
    registerRunStartedFn: async () => {},
    relayRunEventFn: async () => {},
    resolveRuntimeModelClientFn: () => ({
      providerId: "openai_codex",
      configuredProviderId: "openai_codex",
      modelId: "gpt-5.5",
      modelToken: "openai_codex/gpt-5.5",
      modelProxyProvider: "openai_compatible",
      modelClient: {
        model_proxy_provider: "openai_compatible",
        api_key: "runtime-api-key",
        base_url: "https://runtime.example/api/v1/model-proxy",
        default_headers: {
          "X-API-Key": "runtime-api-key",
        },
      },
    }),
    runPiSessionCompactionFn: async (requestPayload) => {
      compactionCalls += 1;
      const snapshotSessionFile = String(requestPayload.harness_session_id);
      openPiSessionManager(snapshotSessionFile).appendCompaction(
        "Overflow recovery compaction",
        assistantEntryId,
        100_000,
        { readFiles: [], modifiedFiles: [] },
        false,
      );
      return {
        compacted: true,
        session_file: snapshotSessionFile,
        result: {
          summary: "Overflow recovery compaction",
          firstKeptEntryId: assistantEntryId,
          tokensBefore: 100_000,
          details: { readFiles: [], modifiedFiles: [] },
        },
        reason: null,
        diagnostics: {
          context_usage: {
            tokens: 100_000,
            contextWindow: 400_000,
            percent: 25,
          },
        },
        error: null,
      };
    },
    executeRunnerRequestFn: async (payload, options = {}) => {
      runnerCalls += 1;
      if (runnerCalls === 1) {
        assert.equal(latestPiCompactionEntry(sessionFile), null);
        assert.equal(
          String(payload.instruction).includes("[Holaboss Retry Continuation v1]"),
          false,
        );
        await options.onEvent?.({
          session_id: String(payload.session_id),
          input_id: String(payload.input_id),
          sequence: 1,
          event_type: "run_started",
          payload: {},
        });
        await options.onEvent?.({
          session_id: String(payload.session_id),
          input_id: String(payload.input_id),
          sequence: 2,
          event_type: "run_failed",
          payload: {
            type: "ProviderError",
            message: "Your input exceeds the context window of this model.",
            harness_session_id: sessionFile,
          },
        });
        return {
          events: [],
          skippedLines: [],
          stderr: "",
          returnCode: 0,
          sawTerminal: true,
        };
      }
      assert.ok(latestPiCompactionEntry(sessionFile));
      assert.equal(
        String(payload.instruction).includes("[Holaboss Retry Continuation v1]"),
        true,
      );
      assert.equal(
        String(payload.instruction).includes("First inspect the current workspace and session state"),
        true,
      );
      await options.onEvent?.({
        session_id: String(payload.session_id),
        input_id: String(payload.input_id),
        sequence: 1,
        event_type: "run_started",
        payload: {},
      });
      await options.onEvent?.({
        session_id: String(payload.session_id),
        input_id: String(payload.input_id),
        sequence: 2,
        event_type: "run_completed",
        payload: {
          status: "completed",
          harness_session_id: sessionFile,
          context_usage: {
            tokens: 80_000,
            context_window: 400_000,
            percent: 20,
          },
        },
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

  assert.equal(compactionCalls, 1);
  assert.equal(runnerCalls, 2);
  const events = outputEventsForInput(store, queued);
  const turnResult = turnResultForInput(store, queued);
  const overflowRecovery = recordValue(
    recordValue(turnResult?.contextBudgetDecisions)?.overflow_recovery,
  );
  assert.equal(turnResult?.status, "completed");
  assert.deepEqual(
    events.map((event) => event.eventType),
    ["run_started", "run_started", "run_completed"],
  );
  assert.equal(events.some((event) => event.eventType === "run_failed"), false);
  assert.ok(overflowRecovery);
  assert.equal(overflowRecovery?.trigger_reason, "provider_context_overflow");
  assert.equal(overflowRecovery?.initial_error_type, "ProviderError");
  assert.equal(
    overflowRecovery?.initial_error_message,
    "Your input exceeds the context window of this model.",
  );
  assert.equal(overflowRecovery?.compaction_attempted, true);
  assert.equal(overflowRecovery?.compaction_changed_branch, true);
  assert.equal(overflowRecovery?.retry_attempted, true);
  assert.equal(overflowRecovery?.recovered, true);
  assert.equal(overflowRecovery?.reset_required, false);
  store.close();
});

test("claimed input retries long-running terminated PI subagent runs after snapshot compaction", async () => {
  const store = makeStore("hb-claimed-input-provider-terminated-recovery-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const workspaceDir = store.workspaceDir(workspace.id);
  const { sessionManager, sessionFile } = createPiSessionFile({
    workspaceDir,
    sessionDir: path.join(workspaceDir, ".holaboss", "pi-sessions"),
  });
  sessionManager.appendMessage(piUserMessage("previous task"));
  const assistantEntryId = sessionManager.appendMessage(
    piAssistantMessage("previous response"),
  );
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-main",
    kind: "main_session",
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-subagent",
    kind: "subagent",
    parentSessionId: "session-main",
  });
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-subagent",
    harness: "pi",
    harnessSessionId: sessionFile,
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-subagent",
    payload: {
      text: "finish the delegated app task",
      model: "openai_codex/gpt-5.4",
    },
  });
  upsertTurnRequestSnapshotFixture({
    store,
    workspaceId: workspace.id,
    sessionId: "session-subagent",
    inputId: queued.inputId,
    model: "openai_codex/gpt-5.4",
    providerId: "openai_codex",
    modelId: "gpt-5.4",
    instructionSize: 1_024,
  });
  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });
  let compactionCalls = 0;
  let runnerCalls = 0;

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
    registerRunStartedFn: async () => {},
    relayRunEventFn: async () => {},
    resolveRuntimeModelClientFn: () => ({
      providerId: "openai_codex",
      configuredProviderId: "openai_codex",
      modelId: "gpt-5.4",
      modelToken: "openai_codex/gpt-5.4",
      modelProxyProvider: "openai_compatible",
      modelClient: {
        model_proxy_provider: "openai_compatible",
        api_key: "runtime-api-key",
        base_url: "https://runtime.example/api/v1/model-proxy",
        default_headers: {
          "X-API-Key": "runtime-api-key",
        },
      },
    }),
    runPiSessionCompactionFn: async (requestPayload) => {
      compactionCalls += 1;
      const snapshotSessionFile = String(requestPayload.harness_session_id);
      openPiSessionManager(snapshotSessionFile).appendCompaction(
        "Provider termination recovery compaction",
        assistantEntryId,
        300_000,
        { readFiles: [], modifiedFiles: [] },
        false,
      );
      return {
        compacted: true,
        session_file: snapshotSessionFile,
        result: {
          summary: "Provider termination recovery compaction",
          firstKeptEntryId: assistantEntryId,
          tokensBefore: 300_000,
          details: { readFiles: [], modifiedFiles: [] },
        },
        reason: null,
        diagnostics: {
          context_usage: {
            tokens: 300_000,
            contextWindow: 1_000_000,
            percent: 30,
          },
        },
        error: null,
      };
    },
    executeRunnerRequestFn: async (payload, options = {}) => {
      runnerCalls += 1;
      if (runnerCalls === 2) {
        assert.ok(latestPiCompactionEntry(sessionFile));
      }
      assert.equal(
        String(payload.instruction).includes("[Holaboss Retry Continuation v1]"),
        runnerCalls === 2,
      );
      await options.onEvent?.({
        session_id: String(payload.session_id),
        input_id: String(payload.input_id),
        sequence: 1,
        event_type: "run_started",
        payload: {},
      });
      if (runnerCalls === 1) {
        await options.onEvent?.({
          session_id: String(payload.session_id),
          input_id: String(payload.input_id),
          sequence: 2,
          event_type: "run_failed",
          payload: {
            type: "ProviderError",
            message: "terminated",
            source: "pi",
            event: "message_end",
            harness_session_id: sessionFile,
            usage: {
              input_tokens: 965_140,
              cached_input_tokens: 876_032,
              output_tokens: 28_162,
              total_tokens: 993_302,
            },
          },
        });
        return {
          events: [],
          skippedLines: [],
          stderr: "",
          returnCode: 0,
          sawTerminal: true,
        };
      }
      await options.onEvent?.({
        session_id: String(payload.session_id),
        input_id: String(payload.input_id),
        sequence: 2,
        event_type: "run_completed",
        payload: {
          status: "completed",
          harness_session_id: sessionFile,
          context_usage: {
            tokens: 120_000,
            context_window: 1_000_000,
            percent: 12,
          },
        },
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

  assert.equal(compactionCalls, 1);
  assert.equal(runnerCalls, 2);
  const events = outputEventsForInput(store, queued);
  const turnResult = turnResultForInput(store, queued);
  const terminationRecovery = recordValue(
    recordValue(turnResult?.contextBudgetDecisions)?.provider_termination_recovery,
  );
  assert.equal(turnResult?.status, "completed");
  assert.deepEqual(
    events.map((event) => event.eventType),
    ["run_started", "run_started", "run_completed"],
  );
  assert.equal(events.some((event) => event.eventType === "run_failed"), false);
  assert.ok(terminationRecovery);
  assert.equal(
    terminationRecovery?.trigger_reason,
    "long_running_provider_termination",
  );
  assert.equal(terminationRecovery?.initial_error_type, "ProviderError");
  assert.equal(terminationRecovery?.initial_error_message, "terminated");
  assert.equal(terminationRecovery?.initial_input_tokens, 965_140);
  assert.equal(terminationRecovery?.compaction_attempted, true);
  assert.equal(terminationRecovery?.compaction_changed_branch, true);
  assert.equal(terminationRecovery?.retry_attempted, true);
  assert.equal(terminationRecovery?.recovered, true);
  store.close();
});

test("claimed input retries long-running terminated PI main-session runs after snapshot compaction", async () => {
  const store = makeStore("hb-claimed-input-provider-terminated-main-session-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const workspaceDir = store.workspaceDir(workspace.id);
  const { sessionManager, sessionFile } = createPiSessionFile({
    workspaceDir,
    sessionDir: path.join(workspaceDir, ".holaboss", "pi-sessions"),
  });
  sessionManager.appendMessage(piUserMessage("previous task"));
  sessionManager.appendMessage(piAssistantMessage("previous response"));
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
    harness: "pi",
    harnessSessionId: sessionFile,
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "finish the task", model: "openai_codex/gpt-5.4" },
  });
  upsertTurnRequestSnapshotFixture({
    store,
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: queued.inputId,
    model: "openai_codex/gpt-5.4",
    providerId: "openai_codex",
    modelId: "gpt-5.4",
    instructionSize: 1_024,
  });
  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });
  let compactionCalls = 0;
  let runnerCalls = 0;
  const assistantEntryId = sessionManager.appendMessage(
    piAssistantMessage("older response"),
  );

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
    registerRunStartedFn: async () => {},
    relayRunEventFn: async () => {},
    resolveRuntimeModelClientFn: () => ({
      providerId: "openai_codex",
      configuredProviderId: "openai_codex",
      modelId: "gpt-5.4",
      modelToken: "openai_codex/gpt-5.4",
      modelProxyProvider: "openai_compatible",
      modelClient: {
        model_proxy_provider: "openai_compatible",
        api_key: "runtime-api-key",
        base_url: "https://runtime.example/api/v1/model-proxy",
        default_headers: {
          "X-API-Key": "runtime-api-key",
        },
      },
    }),
    runPiSessionCompactionFn: async (requestPayload) => {
      compactionCalls += 1;
      const snapshotSessionFile = String(requestPayload.harness_session_id);
      openPiSessionManager(snapshotSessionFile).appendCompaction(
        "Provider termination recovery compaction",
        assistantEntryId,
        300_000,
        { readFiles: [], modifiedFiles: [] },
        false,
      );
      return {
        compacted: true,
        session_file: snapshotSessionFile,
        result: {
          summary: "Provider termination recovery compaction",
          firstKeptEntryId: assistantEntryId,
          tokensBefore: 300_000,
          details: { readFiles: [], modifiedFiles: [] },
        },
        reason: null,
        diagnostics: {
          context_usage: {
            tokens: 300_000,
            contextWindow: 1_000_000,
            percent: 30,
          },
        },
        error: null,
      };
    },
    executeRunnerRequestFn: async (payload, options = {}) => {
      runnerCalls += 1;
      if (runnerCalls === 2) {
        assert.ok(latestPiCompactionEntry(sessionFile));
      }
      assert.equal(
        String(payload.instruction).includes("[Holaboss Retry Continuation v1]"),
        runnerCalls === 2,
      );
      await options.onEvent?.({
        session_id: String(payload.session_id),
        input_id: String(payload.input_id),
        sequence: 1,
        event_type: "run_started",
        payload: {},
      });
      if (runnerCalls === 1) {
        await options.onEvent?.({
          session_id: String(payload.session_id),
          input_id: String(payload.input_id),
          sequence: 2,
          event_type: "run_failed",
          payload: {
            type: "ProviderError",
            message: "terminated",
            source: "pi",
            event: "message_end",
            harness_session_id: sessionFile,
            usage: {
              input_tokens: 965_140,
              cached_input_tokens: 876_032,
              output_tokens: 28_162,
              total_tokens: 993_302,
            },
          },
        });
        return {
          events: [],
          skippedLines: [],
          stderr: "",
          returnCode: 0,
          sawTerminal: true,
        };
      }
      await options.onEvent?.({
        session_id: String(payload.session_id),
        input_id: String(payload.input_id),
        sequence: 2,
        event_type: "run_completed",
        payload: {
          status: "completed",
          harness_session_id: sessionFile,
          context_usage: {
            tokens: 90_000,
            context_window: 1_000_000,
            percent: 9,
          },
        },
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

  assert.equal(compactionCalls, 1);
  assert.equal(runnerCalls, 2);
  const events = outputEventsForInput(store, queued);
  const turnResult = turnResultForInput(store, queued);
  const terminationRecovery = recordValue(
    recordValue(turnResult?.contextBudgetDecisions)?.provider_termination_recovery,
  );
  assert.equal(turnResult?.status, "completed");
  assert.deepEqual(
    events.map((event) => event.eventType),
    ["run_started", "run_started", "run_completed"],
  );
  assert.ok(terminationRecovery);
  assert.equal(terminationRecovery?.retry_attempted, true);
  assert.equal(terminationRecovery?.recovered, true);
  store.close();
});

test("claimed input does not retry short terminated PI provider errors", async () => {
  const store = makeStore("hb-claimed-input-provider-terminated-short-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const workspaceDir = store.workspaceDir(workspace.id);
  const { sessionManager, sessionFile } = createPiSessionFile({
    workspaceDir,
    sessionDir: path.join(workspaceDir, ".holaboss", "pi-sessions"),
  });
  sessionManager.appendMessage(piUserMessage("previous task"));
  sessionManager.appendMessage(piAssistantMessage("previous response"));
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
    harness: "pi",
    harnessSessionId: sessionFile,
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "finish the task", model: "openai_codex/gpt-5.4" },
  });
  upsertTurnRequestSnapshotFixture({
    store,
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: queued.inputId,
    model: "openai_codex/gpt-5.4",
    providerId: "openai_codex",
    modelId: "gpt-5.4",
    instructionSize: 1_024,
  });
  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });
  let compactionCalls = 0;
  let runnerCalls = 0;

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
    registerRunStartedFn: async () => {},
    relayRunEventFn: async () => {},
    resolveRuntimeModelClientFn: () => ({
      providerId: "openai_codex",
      configuredProviderId: "openai_codex",
      modelId: "gpt-5.4",
      modelToken: "openai_codex/gpt-5.4",
      modelProxyProvider: "openai_compatible",
      modelClient: {
        model_proxy_provider: "openai_compatible",
        api_key: "runtime-api-key",
        base_url: "https://runtime.example/api/v1/model-proxy",
        default_headers: {
          "X-API-Key": "runtime-api-key",
        },
      },
    }),
    runPiSessionCompactionFn: async () => {
      compactionCalls += 1;
      throw new Error("unexpected compaction");
    },
    executeRunnerRequestFn: async (payload, options = {}) => {
      runnerCalls += 1;
      assert.equal(
        String(payload.instruction).includes("[Holaboss Retry Continuation v1]"),
        false,
      );
      await options.onEvent?.({
        session_id: String(payload.session_id),
        input_id: String(payload.input_id),
        sequence: 1,
        event_type: "run_started",
        payload: {},
      });
      await options.onEvent?.({
        session_id: String(payload.session_id),
        input_id: String(payload.input_id),
        sequence: 2,
        event_type: "run_failed",
        payload: {
          type: "ProviderError",
          message: "terminated",
          source: "pi",
          event: "message_end",
          harness_session_id: sessionFile,
          usage: {
            input_tokens: 12_000,
            cached_input_tokens: 8_000,
            output_tokens: 600,
            total_tokens: 12_600,
          },
        },
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

  assert.equal(compactionCalls, 0);
  assert.equal(runnerCalls, 1);
  const events = outputEventsForInput(store, queued);
  const turnResult = turnResultForInput(store, queued);
  assert.equal(turnResult?.status, "failed");
  assert.deepEqual(
    events.map((event) => event.eventType),
    ["run_started", "run_failed"],
  );
  assert.equal(
    recordValue(turnResult?.contextBudgetDecisions)?.provider_termination_recovery,
    undefined,
  );
  store.close();
});

test("claimed input fails with session reset required when overflow persists after runtime recovery retry", async () => {
  const store = makeStore("hb-claimed-input-overflow-recovery-reset-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const workspaceDir = store.workspaceDir(workspace.id);
  const { sessionManager, sessionFile } = createPiSessionFile({
    workspaceDir,
    sessionDir: path.join(workspaceDir, ".holaboss", "pi-sessions"),
  });
  sessionManager.appendMessage(piUserMessage("x".repeat(80_000)));
  const assistantEntryId = sessionManager.appendMessage(
    piAssistantMessage("previous response"),
  );
  store.upsertBinding({
    workspaceId: workspace.id,
    sessionId: "session-main",
    harness: "pi",
    harnessSessionId: sessionFile,
  });
  const previousInput = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "previous", model: "openai_codex/gpt-5.5" },
  });
  store.updateInput({
    workspaceId: workspace.id,
    inputId: previousInput.inputId,
    fields: { status: "DONE" },
  });
  store.upsertTurnResult({
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: previousInput.inputId,
    startedAt: "2026-05-11T00:00:00.000Z",
    completedAt: "2026-05-11T00:01:00.000Z",
    status: "completed",
    stopReason: "completed",
    assistantText: "previous response",
    toolUsageSummary: {
      total_calls: 0,
      completed_calls: 0,
      failed_calls: 0,
      tool_names: [],
      tool_ids: [],
    },
    permissionDenials: [],
    promptSectionIds: [],
    capabilityManifestFingerprint: null,
    requestSnapshotFingerprint: null,
    promptCacheProfile: null,
    contextBudgetDecisions: {
      context_usage: {
        tokens: 100_000,
        context_window: 400_000,
        percent: 25,
      },
    },
    tokenUsage: null,
  });
  const queued = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: { text: "new task", model: "openai_codex/gpt-5.5" },
  });
  upsertTurnRequestSnapshotFixture({
    store,
    workspaceId: workspace.id,
    sessionId: "session-main",
    inputId: queued.inputId,
    model: "openai_codex/gpt-5.5",
    providerId: "openai_codex",
    modelId: "gpt-5.5",
    instructionSize: 1_024,
  });
  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });
  let compactionCalls = 0;
  let runnerCalls = 0;

  await processClaimedInput({
    store,
    record: claimed[0],
    claimedBy: "sandbox-agent-ts-worker",
    registerRunStartedFn: async () => {},
    relayRunEventFn: async () => {},
    resolveRuntimeModelClientFn: () => ({
      providerId: "openai_codex",
      configuredProviderId: "openai_codex",
      modelId: "gpt-5.5",
      modelToken: "openai_codex/gpt-5.5",
      modelProxyProvider: "openai_compatible",
      modelClient: {
        model_proxy_provider: "openai_compatible",
        api_key: "runtime-api-key",
        base_url: "https://runtime.example/api/v1/model-proxy",
        default_headers: {
          "X-API-Key": "runtime-api-key",
        },
      },
    }),
    runPiSessionCompactionFn: async (requestPayload) => {
      compactionCalls += 1;
      const snapshotSessionFile = String(requestPayload.harness_session_id);
      openPiSessionManager(snapshotSessionFile).appendCompaction(
        "Overflow recovery compaction",
        assistantEntryId,
        100_000,
        { readFiles: [], modifiedFiles: [] },
        false,
      );
      return {
        compacted: true,
        session_file: snapshotSessionFile,
        result: {
          summary: "Overflow recovery compaction",
          firstKeptEntryId: assistantEntryId,
          tokensBefore: 100_000,
          details: { readFiles: [], modifiedFiles: [] },
        },
        reason: null,
        diagnostics: {
          context_usage: {
            tokens: 100_000,
            contextWindow: 400_000,
            percent: 25,
          },
        },
        error: null,
      };
    },
    executeRunnerRequestFn: async (payload, options = {}) => {
      runnerCalls += 1;
      if (runnerCalls === 2) {
        assert.ok(latestPiCompactionEntry(sessionFile));
      }
      await options.onEvent?.({
        session_id: String(payload.session_id),
        input_id: String(payload.input_id),
        sequence: 1,
        event_type: "run_started",
        payload: {},
      });
      await options.onEvent?.({
        session_id: String(payload.session_id),
        input_id: String(payload.input_id),
        sequence: 2,
        event_type: "run_failed",
        payload: {
          type: "ProviderError",
          message: "context_length_exceeded: Your input exceeds the context window of this model.",
          harness_session_id: sessionFile,
        },
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

  assert.equal(compactionCalls, 1);
  assert.equal(runnerCalls, 2);
  const updated = store.getInput({
    workspaceId: workspace.id,
    inputId: queued.inputId,
  });
  const events = outputEventsForInput(store, queued);
  const turnResult = turnResultForInput(store, queued);
  const terminalPayload = events.at(-1)?.payload ?? null;
  const overflowRecovery = recordValue(
    recordValue(turnResult?.contextBudgetDecisions)?.overflow_recovery,
  );
  assert.equal(updated?.status, "FAILED");
  assert.equal(turnResult?.status, "failed");
  assert.equal(turnResult?.stopReason, "session_reset_required");
  assert.equal(recordValue(terminalPayload)?.error_type, "SessionResetRequiredError");
  assert.ok(
    String(recordValue(terminalPayload)?.message ?? "").includes(
      "session reset required",
    ),
  );
  assert.ok(overflowRecovery);
  assert.equal(overflowRecovery?.trigger_reason, "provider_context_overflow");
  assert.equal(overflowRecovery?.compaction_attempted, true);
  assert.equal(overflowRecovery?.compaction_changed_branch, true);
  assert.equal(overflowRecovery?.retry_attempted, true);
  assert.equal(overflowRecovery?.recovered, false);
  assert.equal(overflowRecovery?.reset_required, true);
  store.close();
});
