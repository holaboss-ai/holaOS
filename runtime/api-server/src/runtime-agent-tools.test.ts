import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

import { load as parseYaml } from "js-yaml";

import { RuntimeStateStore, utcNowIso } from "@holaboss/runtime-state-store";
import { seedWorkspaceRecord } from "./__test-helpers__/seed-workspace.js";

import {
  RuntimeAgentToolsService,
  RuntimeAgentToolsServiceError,
} from "./runtime-agent-tools.js";
import {
  resolveWorkspaceAppRuntime,
  writeWorkspaceMcpRegistryEntry,
} from "./workspace-apps.js";
import { noteHarnessWaitingForUserOnToolCompletion } from "../../harnesses/src/runner-events.js";

const ORIGINAL_ENV = {
  HB_SANDBOX_ROOT: process.env.HB_SANDBOX_ROOT,
  HOLABOSS_RUNTIME_CONFIG_PATH: process.env.HOLABOSS_RUNTIME_CONFIG_PATH,
};

function writeRuntimeConfig(root: string, document: Record<string, unknown>): void {
  const configPath = path.join(root, "state", "runtime-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  process.env.HB_SANDBOX_ROOT = root;
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;
}

async function startStaticHttpServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  port: number,
): Promise<{ close: () => Promise<void> }> {
  const server = http.createServer(handler);
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return {
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

test("continueSubagent queues a new input onto the same completed child session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-continue-"));
  writeRuntimeConfig(root, {
    runtime: {
      default_model: "openai/gpt-5.4",
    },
  });
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const mainSessionId = "main-1";
  const childSessionId = "subagent-child-1";
  const subagentId = "subagent-run-1";
  const completedAt = utcNowIso();

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.ensureSession({
      workspaceId,
      sessionId: mainSessionId,
      kind: "main_session",
      createdBy: "workspace_user",
    });
    store.createIssue({
      workspaceId,
      issueId: "HOL-1",
      sessionId: childSessionId,
      title: "Web search for AI",
      description: "Search the web for AI.",
      status: "done",
      assigneeId: "general",
      latestSubagentId: subagentId,
      completedAt,
    });
    store.ensureSession({
      workspaceId,
      sessionId: childSessionId,
      kind: "subagent",
      parentSessionId: mainSessionId,
      createdBy: "workspace_agent",
      archivedAt: completedAt,
    });
    const firstInput = store.enqueueInput({
      workspaceId,
      sessionId: childSessionId,
      payload: { text: "search the web for AI" },
    });
    store.updateInput({ workspaceId, inputId: firstInput.inputId, fields: { status: "DONE" } });
    store.upsertTurnResult({
      workspaceId,
      sessionId: childSessionId,
      inputId: firstInput.inputId,
      startedAt: completedAt,
      completedAt,
      status: "completed",
      stopReason: "success",
      assistantText: "Top AI results: item 1, item 2, item 3.",
    });
    store.createSubagentRun({
      subagentId,
      workspaceId,
      parentSessionId: mainSessionId,
      parentInputId: "parent-input-1",
      originMainSessionId: mainSessionId,
      ownerMainSessionId: mainSessionId,
      childSessionId,
      initialChildInputId: firstInput.inputId,
      currentChildInputId: null,
      latestChildInputId: firstInput.inputId,
      title: "Web search for AI",
      goal: "Search the web for AI.",
      sourceType: "delegate_task",
      issueId: "HOL-1",
      effectiveModel: "openai/gpt-5.4",
      status: "completed",
      summary: "Top AI results.",
      resultPayload: { summary: "Top AI results: item 1, item 2, item 3." },
      completedAt,
    });

    let wakeCalls = 0;
    const service = new RuntimeAgentToolsService(store, {
      workspaceRoot,
      queueWorker: {
        start: async () => {},
        wake: () => {
          wakeCalls += 1;
        },
        close: async () => {},
      },
    });

    const result = service.continueSubagent({
      workspaceId,
      sessionId: mainSessionId,
      inputId: "parent-input-2",
      subagentId,
      instruction: "Create a concise report from those AI results.",
      title: "AI report from search results",
      model: "gpt-test",
    }) as Record<string, unknown>;

    assert.equal(wakeCalls, 1);
    assert.equal(result.subagent_id, subagentId);
    assert.equal(result.child_session_id, childSessionId);
    assert.equal(result.status, "queued");
    assert.equal(result.current_child_input_id, result.latest_child_input_id);
    assert.equal(result.result_payload, null);
    assert.equal(result.completed_at, null);
    assert.equal(result.cancelled_at, null);
    assert.equal(result.effective_model, "gpt-test");
    const session = store.getSession({ workspaceId, sessionId: childSessionId });
    assert.equal(session?.archivedAt, null);
    const nextInputId = String(result.latest_child_input_id);
    const nextInput = store.getInput({ workspaceId, inputId: nextInputId });
    assert.ok(nextInput);
    assert.equal(nextInput?.sessionId, childSessionId);
    assert.equal(nextInput?.payload.model, "gpt-test");
    const nextInputText = String(nextInput?.payload.text ?? "");
    assert.match(nextInputText, /Create a concise report from those AI results\./);
    assert.match(nextInputText, /Continue from your previous result in this same child session\./);
    assert.deepEqual(nextInput?.payload.context, {
      source: "subagent_continue",
      subagent_id: subagentId,
      origin_main_session_id: mainSessionId,
      owner_main_session_id: mainSessionId,
      parent_session_id: mainSessionId,
      parent_input_id: "parent-input-2",
      continued_from_input_id: firstInput.inputId,
      continued_from_status: "completed",
    });
    const issue = store.getIssue({ workspaceId, issueId: "HOL-1" });
    assert.equal(issue?.status, "todo");
    assert.equal(issue?.latestSubagentId, subagentId);
    assert.equal(issue?.activeSubagentId, null);
    assert.equal(issue?.completedAt, null);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("continueSubagent inherits the composer-selected thinking value for the effective child model", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-continue-thinking-"));
  writeRuntimeConfig(root, {
    runtime: {
      default_model: "openai/gpt-5.4",
    },
  });
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const mainSessionId = "main-1";
  const childSessionId = "subagent-child-1";
  const subagentId = "subagent-run-1";
  const completedAt = utcNowIso();

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.ensureSession({
      workspaceId,
      sessionId: mainSessionId,
      kind: "main_session",
      createdBy: "workspace_user",
    });
    store.ensureSession({
      workspaceId,
      sessionId: childSessionId,
      kind: "subagent",
      parentSessionId: mainSessionId,
      createdBy: "workspace_agent",
      archivedAt: completedAt,
    });
    const parentInput = store.enqueueInput({
      workspaceId,
      sessionId: mainSessionId,
      payload: {
        text: "Find the latest crypto news.",
        model: "openai/gpt-5.5",
        thinking_value: "medium",
      },
    });
    const firstInput = store.enqueueInput({
      workspaceId,
      sessionId: childSessionId,
      payload: {
        text: "Research major crypto developments today.",
        model: "openai/gpt-5.5",
        thinking_value: "medium",
      },
    });
    store.updateInput({ workspaceId, inputId: firstInput.inputId, fields: { status: "DONE" } });
    store.upsertTurnResult({
      workspaceId,
      sessionId: childSessionId,
      inputId: firstInput.inputId,
      startedAt: completedAt,
      completedAt,
      status: "completed",
      stopReason: "success",
      assistantText: "Top crypto results.",
    });
    store.createSubagentRun({
      subagentId,
      workspaceId,
      parentSessionId: mainSessionId,
      parentInputId: parentInput.inputId,
      originMainSessionId: mainSessionId,
      ownerMainSessionId: mainSessionId,
      childSessionId,
      initialChildInputId: firstInput.inputId,
      currentChildInputId: null,
      latestChildInputId: firstInput.inputId,
      title: "Crypto research",
      goal: "Research crypto news.",
      sourceType: "delegate_task",
      effectiveModel: "openai/gpt-5.5",
      status: "completed",
      summary: "Top crypto results.",
      resultPayload: { summary: "Top crypto results." },
      completedAt,
    });

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const result = service.continueSubagent({
      workspaceId,
      sessionId: mainSessionId,
      inputId: parentInput.inputId,
      subagentId,
      instruction: "Write a concise crypto digest.",
      selectedModel: "openai/gpt-5.5",
    }) as Record<string, unknown>;

    const nextInput = store.getInput({ workspaceId, inputId: String(result.latest_child_input_id) });
    assert.equal(nextInput?.payload.model, "openai/gpt-5.5");
    assert.equal(nextInput?.payload.thinking_value, "medium");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("continueSubagent falls back to the controller session's latest model instead of the previous child model", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-continue-controller-model-"));
  writeRuntimeConfig(root, {
    runtime: {
      default_model: "openai/gpt-5.4",
    },
  });
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const mainSessionId = "main-1";
  const childSessionId = "subagent-child-1";
  const subagentId = "subagent-run-1";
  const completedAt = utcNowIso();

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.ensureSession({
      workspaceId,
      sessionId: mainSessionId,
      kind: "main_session",
      createdBy: "workspace_user",
    });
    store.ensureSession({
      workspaceId,
      sessionId: childSessionId,
      kind: "subagent",
      parentSessionId: mainSessionId,
      createdBy: "workspace_agent",
      archivedAt: completedAt,
    });
    store.enqueueInput({
      workspaceId,
      sessionId: mainSessionId,
      payload: {
        text: "Use model A first.",
        model: "openai/gpt-5.4",
        thinking_value: "low",
      },
    });
    const controllerInput = store.enqueueInput({
      workspaceId,
      sessionId: mainSessionId,
      payload: {
        text: "Switch the controller session to model B.",
        model: "openai/gpt-5.5",
        thinking_value: "medium",
      },
    });
    store.ensureRuntimeState({
      workspaceId,
      sessionId: mainSessionId,
      status: "QUEUED",
      currentInputId: controllerInput.inputId,
    });
    const firstInput = store.enqueueInput({
      workspaceId,
      sessionId: childSessionId,
      payload: {
        text: "Initial delegated task.",
        model: "openai/gpt-5.4",
        thinking_value: "low",
      },
    });
    store.updateInput({ workspaceId, inputId: firstInput.inputId, fields: { status: "DONE" } });
    store.upsertTurnResult({
      workspaceId,
      sessionId: childSessionId,
      inputId: firstInput.inputId,
      startedAt: completedAt,
      completedAt,
      status: "completed",
      stopReason: "success",
      assistantText: "Initial result.",
    });
    store.createSubagentRun({
      subagentId,
      workspaceId,
      parentSessionId: mainSessionId,
      parentInputId: "parent-input-1",
      originMainSessionId: mainSessionId,
      ownerMainSessionId: mainSessionId,
      childSessionId,
      initialChildInputId: firstInput.inputId,
      currentChildInputId: null,
      latestChildInputId: firstInput.inputId,
      title: "Initial delegated task",
      goal: "Finish the first delegated task.",
      sourceType: "delegate_task",
      effectiveModel: "openai/gpt-5.4",
      status: "completed",
      summary: "Initial result.",
      resultPayload: { summary: "Initial result." },
      completedAt,
    });

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const result = service.continueSubagent({
      workspaceId,
      sessionId: mainSessionId,
      subagentId,
      instruction: "Continue the same subagent with the controller session's current model.",
    }) as Record<string, unknown>;

    const nextInput = store.getInput({
      workspaceId,
      inputId: String(result.latest_child_input_id),
    });
    assert.equal(nextInput?.payload.model, "openai/gpt-5.5");
    assert.equal(nextInput?.payload.thinking_value, "medium");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("listTasks filters by task status and includes linked run state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-list-tasks-"));
  writeRuntimeConfig(root, {
    runtime: {
      default_model: "openai/gpt-5.4",
    },
  });
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const mainSessionId = "main-1";

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.ensureSession({
      workspaceId,
      sessionId: mainSessionId,
      kind: "main_session",
      createdBy: "workspace_user",
    });
    store.createIssue({
      workspaceId,
      issueId: "HOL-1",
      sessionId: "subagent-1",
      title: "Todo task",
      description: "Finish the todo task.",
      status: "todo",
      assigneeId: "general",
      latestSubagentId: "run-1",
    });
    store.createIssue({
      workspaceId,
      issueId: "HOL-2",
      sessionId: "subagent-2",
      title: "Blocked task",
      description: "Finish the blocked task.",
      status: "blocked",
      assigneeId: "general",
      blockerReason: "Need review.",
    });
    store.createSubagentRun({
      subagentId: "run-1",
      workspaceId,
      parentSessionId: mainSessionId,
      parentInputId: "input-1",
      originMainSessionId: mainSessionId,
      ownerMainSessionId: mainSessionId,
      childSessionId: "subagent-1",
      title: "Todo task",
      goal: "Finish the todo task.",
      issueId: "HOL-1",
      effectiveModel: "openai/gpt-5.4",
      status: "completed",
      summary: "Finished once already.",
      completedAt: utcNowIso(),
    });

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const result = service.listTasks({
      workspaceId,
      sessionId: mainSessionId,
      statuses: ["todo"],
      limit: 10,
    }) as { count: number; tasks: Array<Record<string, unknown>> };

    assert.equal(result.count, 1);
    assert.equal(result.tasks[0]?.task_id, "HOL-1");
    assert.equal(result.tasks[0]?.status, "todo");
    assert.equal(
      ((result.tasks[0]?.latest_run as Record<string, unknown> | null) ?? {})?.subagent_id,
      "run-1",
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rerunTask restarts an existing delegated task by task id", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-rerun-task-"));
  writeRuntimeConfig(root, {
    runtime: {
      default_model: "openai/gpt-5.4",
    },
  });
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const mainSessionId = "main-1";
  const childSessionId = "subagent-child-1";
  const subagentId = "subagent-run-1";
  const completedAt = utcNowIso();

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.ensureSession({
      workspaceId,
      sessionId: mainSessionId,
      kind: "main_session",
      createdBy: "workspace_user",
    });
    const controllerInput = store.enqueueInput({
      workspaceId,
      sessionId: mainSessionId,
      payload: {
        text: "Retry this task with the current composer model.",
        model: "holaboss_model_proxy/gpt-5.5",
        thinking_value: "medium",
      },
    });
    store.ensureRuntimeState({
      workspaceId,
      sessionId: mainSessionId,
      status: "QUEUED",
      currentInputId: controllerInput.inputId,
    });
    store.createIssue({
      workspaceId,
      issueId: "HOL-1",
      sessionId: childSessionId,
      title: "Crypto research",
      description: "Research crypto news.",
      status: "done",
      assigneeId: "general",
      latestSubagentId: subagentId,
      completedAt,
    });
    store.ensureSession({
      workspaceId,
      sessionId: childSessionId,
      kind: "subagent",
      parentSessionId: mainSessionId,
      createdBy: "workspace_agent",
      archivedAt: completedAt,
    });
    const firstInput = store.enqueueInput({
      workspaceId,
      sessionId: childSessionId,
      payload: {
        text: "Research crypto news.",
        model: "openai/gpt-5.4",
        thinking_value: "low",
      },
    });
    store.updateInput({ workspaceId, inputId: firstInput.inputId, fields: { status: "DONE" } });
    store.createSubagentRun({
      subagentId,
      workspaceId,
      parentSessionId: mainSessionId,
      parentInputId: "parent-input-1",
      originMainSessionId: mainSessionId,
      ownerMainSessionId: mainSessionId,
      childSessionId,
      initialChildInputId: firstInput.inputId,
      currentChildInputId: null,
      latestChildInputId: firstInput.inputId,
      title: "Crypto research",
      goal: "Research crypto news.",
      sourceType: "issue",
      sourceId: "HOL-1",
      issueId: "HOL-1",
      effectiveModel: "openai/gpt-5.4",
      status: "completed",
      summary: "Initial result.",
      resultPayload: { summary: "Initial result." },
      completedAt,
    });

    let wakeCalls = 0;
    const service = new RuntimeAgentToolsService(store, {
      workspaceRoot,
      queueWorker: {
        start: async () => {},
        wake: () => {
          wakeCalls += 1;
        },
        close: async () => {},
      },
    });

    const result = service.rerunTask({
      workspaceId,
      sessionId: mainSessionId,
      inputId: controllerInput.inputId,
      taskId: "HOL-1",
      selectedModel: "holaboss_model_proxy/gpt-5.5",
    }) as Record<string, unknown>;

    assert.equal(wakeCalls, 1);
    assert.equal(result.task_id, "HOL-1");
    assert.equal(result.status, "todo");
    assert.equal(
      ((result.latest_run as Record<string, unknown> | null) ?? {})?.status,
      "queued",
    );
    assert.equal(
      ((result.latest_run as Record<string, unknown> | null) ?? {})?.subagent_id,
      subagentId,
    );
    const rerunIssue = store.getIssue({ workspaceId, issueId: "HOL-1" });
    assert.equal(rerunIssue?.latestSubagentId, subagentId);
    assert.equal(rerunIssue?.completedAt, null);
    const rerunRun = store.getSubagentRun({ workspaceId, subagentId });
    assert.equal(rerunRun?.status, "queued");
    assert.equal(rerunRun?.currentChildInputId, rerunRun?.latestChildInputId);
    assert.equal(rerunRun?.effectiveModel, "holaboss_model_proxy/gpt-5.5");
    const rerunInput = rerunRun?.currentChildInputId
      ? store.getInput({ workspaceId, inputId: rerunRun.currentChildInputId })
      : null;
    assert.equal(rerunInput?.payload.model, "holaboss_model_proxy/gpt-5.5");
    assert.equal(rerunInput?.payload.thinking_value, "medium");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("delegateTask normalizes explicit compatibility assignees onto General", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-delegate-issue-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const mainSessionId = "main-1";

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.ensureSession({
      workspaceId,
      sessionId: mainSessionId,
      kind: "main_session",
      createdBy: "workspace_user",
    });
    const parentInput = store.enqueueInput({
      workspaceId,
      sessionId: mainSessionId,
      payload: {
        text: "Ship the dashboard UI update.",
      },
    });

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const result = service.delegateTask({
      workspaceId,
      sessionId: mainSessionId,
      inputId: parentInput.inputId,
      tasks: [
        {
          title: "Dashboard UI",
          goal: "Implement the dashboard cards and charts in React.",
          context: "This is frontend UI work for the workspace home dashboard.",
        },
      ],
    }) as { tasks?: Array<Record<string, unknown>> };

    const delegatedTask = result.tasks?.[0];
    assert.ok(delegatedTask);
    assert.equal(delegatedTask?.task_id, "WOR-1");
    assert.equal(delegatedTask?.issue_id, "WOR-1");
    assert.equal(delegatedTask?.subagent_id, undefined);
    const issue = store.getIssue({
      workspaceId,
      issueId: String(delegatedTask?.issue_id),
    });
    assert.ok(issue);
    assert.equal(issue?.status, "todo");
    assert.equal(issue?.assigneeId, null);
    const latestRun = store.getSubagentRunByChildSession({
      workspaceId,
      childSessionId: String(delegatedTask?.child_session_id ?? ""),
    });
    assert.ok(latestRun);
    assert.equal(issue?.latestSubagentId, latestRun?.subagentId);
    assert.equal(issue?.description, [
      "Implement the dashboard cards and charts in React.",
      "",
      "Context:",
      "This is frontend UI work for the workspace home dashboard.",
    ].join("\n"));
    assert.equal(delegatedTask?.child_session_id, issue?.sessionId);
    const delegatedInput = store.getInput({
      workspaceId,
      inputId: String(delegatedTask?.latest_child_input_id ?? ""),
    });
    assert.ok(delegatedInput);
    assert.equal(
      (delegatedInput?.payload.context as Record<string, unknown> | undefined)?.issue_id,
      issue?.issueId,
    );
    assert.equal(
      (delegatedInput?.payload.context as Record<string, unknown> | undefined)?.source,
      "issue_bootstrap",
    );
    assert.match(
      String(delegatedInput?.payload.text ?? ""),
      /Implement the dashboard cards and charts in React\./,
    );
    const issueSession = store.getSession({
      workspaceId,
      sessionId: String(delegatedTask?.child_session_id ?? ""),
    });
    assert.equal(issueSession?.parentSessionId, mainSessionId);
    assert.equal(issueSession?.archivedAt, null);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("delegateTask holds blocked tasks until workflow inputs complete", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-blocked-by-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const mainSessionId = "main-1";

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.ensureSession({
      workspaceId,
      sessionId: mainSessionId,
      kind: "main_session",
      createdBy: "workspace_user",
    });
    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const producerResult = service.delegateTask({
      workspaceId,
      sessionId: mainSessionId,
      tasks: [
        {
          title: "Dashboard API",
          goal: "Implement the dashboard API contract.",
        },
      ],
    }) as { tasks?: Array<Record<string, unknown>> };

    const producerTask = producerResult.tasks?.[0];
    assert.ok(producerTask);
    const blockedResult = service.delegateTask({
      workspaceId,
      sessionId: mainSessionId,
      tasks: [
        {
          title: "Dashboard UI",
          goal: "Implement the dashboard cards and charts in React.",
          blockedBy: [
            {
              taskId: String(producerTask.task_id),
              relation: "handoff",
              instruction: "Continue from the API contract handoff.",
            },
          ],
        },
      ],
    }) as { tasks?: Array<Record<string, unknown>> };

    const blockedTask = blockedResult.tasks?.[0];
    assert.ok(blockedTask);
    assert.equal(blockedTask.task_id, "WOR-2");
    assert.equal(blockedTask.workflow_blocked, true);
    assert.deepEqual(blockedTask.blocked_by_task_ids, [producerTask.task_id]);
    assert.deepEqual(blockedTask.blocked_by, [
      {
        task_id: producerTask.task_id,
        relation: "handoff",
        instruction: "Continue from the API contract handoff.",
      },
    ]);
    const blockedIssue = store.getIssue({
      workspaceId,
      issueId: String(blockedTask.task_id),
    });
    assert.equal(blockedIssue?.status, "todo");
    assert.deepEqual(blockedIssue?.blockedBy, [
      {
        taskId: String(producerTask.task_id),
        relation: "handoff",
        instruction: "Continue from the API contract handoff.",
      },
    ]);
    const blockedRuntime = store.getRuntimeState({
      workspaceId,
      sessionId: String(blockedTask.child_session_id ?? ""),
    });
    assert.equal(blockedRuntime?.status, "IDLE");
    assert.equal(blockedRuntime?.currentInputId, null);

    const producerRun = store.getSubagentRunByChildSession({
      workspaceId,
      childSessionId: String(producerTask.child_session_id ?? ""),
    });
    assert.ok(producerRun);
    const inputId = String(producerTask.latest_child_input_id ?? "");
    store.updateInput({
      workspaceId,
      inputId,
      fields: { status: "DONE" },
    });
    store.upsertTurnResult({
      workspaceId,
      sessionId: String(producerTask.child_session_id ?? ""),
      inputId,
      startedAt: utcNowIso(),
      completedAt: utcNowIso(),
      status: "completed",
      stopReason: "done",
      assistantText: "Implemented the API contract.",
    });
    store.updateRuntimeState({
      workspaceId,
      sessionId: String(producerTask.child_session_id ?? ""),
      status: "IDLE",
      currentInputId: null,
    });
    const hydratedProducer = service.getTask({
      workspaceId,
      taskId: String(producerTask.task_id),
    }) as Record<string, unknown>;
    assert.equal(hydratedProducer.status, "done");

    const autoQueuedRuntime = store.getRuntimeState({
      workspaceId,
      sessionId: String(blockedTask.child_session_id ?? ""),
    });
    assert.equal(autoQueuedRuntime?.status, "QUEUED");
    assert.ok(autoQueuedRuntime?.currentInputId);
    const autoQueuedInput = store.getInput({
      workspaceId,
      inputId: String(autoQueuedRuntime?.currentInputId ?? ""),
    });
    assert.ok(autoQueuedInput);
    const autoQueuedRun = store.getSubagentRunByChildSession({
      workspaceId,
      childSessionId: String(blockedTask.child_session_id ?? ""),
    });
    assert.ok(autoQueuedRun);
    assert.equal(autoQueuedRun.sourceType, "workflow_unblocked");
    assert.equal(autoQueuedRun.sourceId, producerTask.task_id);
    assert.match(
      String(autoQueuedInput.payload.text ?? ""),
      /Continue from this upstream task's result and carry the work forward/,
    );
    assert.match(
      String(autoQueuedInput.payload.text ?? ""),
      /Continue from the API contract handoff\./,
    );
    assert.match(
      String(autoQueuedInput.payload.text ?? ""),
      /Implemented the API contract\./,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("delegateTask defaults delegated work to the shared general executor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-delegate-general-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const mainSessionId = "main-1";

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.ensureSession({
      workspaceId,
      sessionId: mainSessionId,
      kind: "main_session",
      createdBy: "workspace_user",
    });
    const parentInput = store.enqueueInput({
      workspaceId,
      sessionId: mainSessionId,
      payload: {
        text: "Compare the latest vendor pricing and source the evidence.",
      },
    });

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const result = service.delegateTask({
      workspaceId,
      sessionId: mainSessionId,
      inputId: parentInput.inputId,
      tasks: [
        {
          title: "Vendor pricing comparison",
          goal: "Research current vendor pricing and summarize the differences.",
          context: "Need live sourcing and comparison notes.",
          tools: ["web_search"],
        },
      ],
    }) as { tasks?: Array<Record<string, unknown>> };
    assert.equal(result.tasks?.length, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("queueIssueReply reopens a completed issue on the same persistent issue session", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "hb-runtime-agent-tools-issue-reply-"),
  );
  const workspaceRoot = path.join(root, "workspaces");
  await mkdir(workspaceRoot, { recursive: true });
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const workspaceId = "workspace-1";
  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace",
      harness: "pi",
      status: "active",
    });
    const issue = store.createIssue({
      workspaceId,
      sessionId: "session-issue-1",
      title: "Ship dashboard",
      description: "Implement the workspace dashboard surface.",
      status: "done",
      assigneeId: "general",
      createdBy: "workspace_user",
    });
    const staleRun = store.createSubagentRun({
      workspaceId,
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
      workspaceId,
      issueId: issue.issueId,
      fields: {
        latestSubagentId: staleRun.subagentId,
      },
    });

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const result = service.queueIssueReply({
      workspaceId,
      issueId: issue.issueId,
      text: "Please tighten the empty state copy.",
    });

    assert.equal(result.issue.issueId, issue.issueId);
    assert.equal(result.issue.sessionId, issue.sessionId);
    assert.equal(result.issue.status, "todo");
    assert.equal(result.session.sessionId, issue.sessionId);
    assert.equal(result.run.run.subagentId, staleRun.subagentId);
    assert.equal(result.run.run.childSessionId, issue.sessionId);
    assert.equal(result.input.sessionId, issue.sessionId);
    assert.equal(result.input.payload.text, "Please tighten the empty state copy.");
    assert.equal(
      store.listSubagentRunsByWorkspace({ workspaceId }).length,
      1,
    );
    assert.equal(
      (result.input.payload.context as Record<string, unknown>)?.source,
      "issue_reply",
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("replyTask returns task-oriented payload when queuing a reply into an existing delegated task", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-reply-task-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const completedAt = utcNowIso();

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    const issue = store.createIssue({
      workspaceId,
      issueId: "HOL-1",
      sessionId: "session-issue-1",
      title: "Ship dashboard",
      description: "Implement the workspace dashboard surface.",
      status: "done",
      assigneeId: "general",
      createdBy: "workspace_user",
    });
    store.ensureSession({
      workspaceId,
      sessionId: issue.sessionId,
      kind: "subagent",
      parentSessionId: issue.sessionId,
      createdBy: "workspace_agent",
      archivedAt: completedAt,
    });
    const staleRun = store.createSubagentRun({
      workspaceId,
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
      workspaceId,
      issueId: issue.issueId,
      fields: {
        latestSubagentId: staleRun.subagentId,
      },
    });

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const result = service.replyTask({
      workspaceId,
      taskId: issue.issueId,
      text: "Please tighten the empty state copy.",
      priority: 3,
    }) as Record<string, unknown>;

    assert.equal(result.task_id, issue.issueId);
    assert.equal(result.status, "todo");
    assert.equal(
      ((result.latest_run as Record<string, unknown> | null) ?? {})?.task_id,
      issue.issueId,
    );
    assert.equal(
      ((result.latest_run as Record<string, unknown> | null) ?? {})?.subagent_id,
      staleRun.subagentId,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("replyTask refuses to queue work for a task with incomplete blockers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-reply-blocked-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    const blocker = store.createIssue({
      workspaceId,
      issueId: "HOL-1",
      sessionId: "session-issue-1",
      title: "API contract",
      description: "Define the API contract.",
      status: "todo",
      assigneeId: "general",
      createdBy: "workspace_user",
    });
    store.createIssue({
      workspaceId,
      issueId: "HOL-2",
      sessionId: "session-issue-2",
      title: "Dashboard UI",
      description: "Implement the dashboard surface.",
      status: "todo",
      assigneeId: "general",
      createdBy: "workspace_user",
      blockedBy: [
        {
          taskId: blocker.issueId,
          relation: "handoff",
          instruction: "Continue from the API contract handoff.",
        },
      ],
    });

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    assert.throws(
      () =>
        service.replyTask({
          workspaceId,
          taskId: "HOL-2",
          text: "Please start the UI implementation now.",
        }),
      (error) => {
        assert.ok(error instanceof RuntimeAgentToolsServiceError);
        assert.equal(error.statusCode, 409);
        assert.equal(error.code, "issue_blocked_by_incomplete_tasks");
        return true;
      },
    );
    const blockedRuntime = store.getRuntimeState({
      workspaceId,
      sessionId: "session-issue-2",
    });
    assert.equal(blockedRuntime?.status, "IDLE");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("delegateTask inherits the composer-selected model and thinking when no subagent default is configured", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-delegate-thinking-"));
  writeRuntimeConfig(root, {
    runtime: {
      default_model: "openai/gpt-5.4",
    },
  });
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const mainSessionId = "main-1";

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.ensureSession({
      workspaceId,
      sessionId: mainSessionId,
      kind: "main_session",
      createdBy: "workspace_user",
    });
    const parentInput = store.enqueueInput({
      workspaceId,
      sessionId: mainSessionId,
      payload: {
        text: "Find the latest crypto news.",
        model: "openai/gpt-5.5",
        thinking_value: "medium",
      },
    });

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const result = service.delegateTask({
      workspaceId,
      sessionId: mainSessionId,
      inputId: parentInput.inputId,
      selectedModel: "openai/gpt-5.5",
      tasks: [
        {
          goal: "Research major crypto developments today.",
        },
      ],
    }) as { tasks?: Array<Record<string, unknown>> };

    const tasks = result.tasks ?? [];
    assert.equal(tasks.length, 1);
    const childInput = store.getInput({ workspaceId, inputId: String(tasks[0]?.latest_child_input_id ?? "") });
    assert.equal(childInput?.payload.model, "openai/gpt-5.5");
    assert.equal(childInput?.payload.thinking_value, "medium");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("background task sync preserves persisted waiting-on-user blockers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-waiting-sync-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const mainSessionId = "main-1";
  const childSessionId = "subagent-child-1";
  const subagentId = "subagent-run-1";
  const completedAt = utcNowIso();

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.ensureSession({
      workspaceId,
      sessionId: mainSessionId,
      kind: "main_session",
      createdBy: "workspace_user",
    });
    store.createIssue({
      workspaceId,
      issueId: "HOL-1",
      sessionId: childSessionId,
      title: "Check account stats",
      description: "Inspect the account stats in the browser.",
      status: "todo",
      assigneeId: "general",
      latestSubagentId: subagentId,
    });
    store.ensureSession({
      workspaceId,
      sessionId: childSessionId,
      kind: "subagent",
      parentSessionId: mainSessionId,
      createdBy: "workspace_agent",
    });
    const input = store.enqueueInput({
      workspaceId,
      sessionId: childSessionId,
      payload: { text: "check account stats" },
    });
    store.updateInput({ workspaceId, inputId: input.inputId, fields: { status: "DONE" } });
    store.upsertTurnResult({
      workspaceId,
      sessionId: childSessionId,
      inputId: input.inputId,
      startedAt: completedAt,
      completedAt,
      status: "completed",
      stopReason: "success",
      assistantText: "The page is logged out, so I cannot inspect the account stats.",
    });
    store.createSubagentRun({
      subagentId,
      workspaceId,
      parentSessionId: mainSessionId,
      parentInputId: "parent-input-1",
      originMainSessionId: mainSessionId,
      ownerMainSessionId: mainSessionId,
      childSessionId,
      initialChildInputId: input.inputId,
      currentChildInputId: input.inputId,
      latestChildInputId: input.inputId,
      title: "Check account stats",
      goal: "Inspect the account stats in the browser.",
      sourceType: "delegate_task",
      issueId: "HOL-1",
      status: "completed",
      summary: "Blocked by login.",
      blockingPayload: {
        status: "waiting_on_user",
        blocking_question:
          "Please log in or complete the required access step, then tell me to continue.",
      },
      resultPayload: { summary: "The page is logged out." },
      completedAt,
    });

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const result = service.listBackgroundTasks({
      workspaceId,
      sessionId: mainSessionId,
      ownerMainSessionId: mainSessionId,
      statuses: ["waiting_on_user"],
    }) as Record<string, unknown>;
    const tasks = result.tasks as Array<Record<string, unknown>>;
    const updatedRun = store.getSubagentRun({ workspaceId, subagentId });

    assert.equal(result.count, 1);
    assert.equal(tasks[0]?.status, "waiting_on_user");
    assert.equal(updatedRun?.status, "waiting_on_user");
    assert.equal(updatedRun?.completedAt, null);
    assert.equal(updatedRun?.resultPayload, null);
    assert.equal(
      updatedRun?.blockingPayload?.blocking_question,
      "Please log in or complete the required access step, then tell me to continue.",
    );
    const issue = store.getIssue({ workspaceId, issueId: "HOL-1" });
    assert.equal(issue?.status, "blocked");
    assert.equal(
      issue?.blockerReason,
      "Please log in or complete the required access step, then tell me to continue.",
    );
    assert.equal(issue?.activeSubagentId, null);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("resumeSubagent preserves the prior child thinking value", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-resume-thinking-"));
  writeRuntimeConfig(root, {
    runtime: {
      default_model: "openai/gpt-5.4",
    },
  });
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const mainSessionId = "main-1";
  const childSessionId = "subagent-child-1";
  const subagentId = "subagent-run-1";
  const blockedAt = utcNowIso();

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.ensureSession({
      workspaceId,
      sessionId: mainSessionId,
      kind: "main_session",
      createdBy: "workspace_user",
    });
    store.createIssue({
      workspaceId,
      issueId: "HOL-1",
      sessionId: childSessionId,
      title: "Latest news on agent harnesses",
      description: "Research the latest news on agent harnesses.",
      status: "in_progress",
      assigneeId: "general",
      activeSubagentId: subagentId,
      latestSubagentId: subagentId,
    });
    store.ensureSession({
      workspaceId,
      sessionId: childSessionId,
      kind: "subagent",
      parentSessionId: mainSessionId,
      createdBy: "workspace_agent",
    });
    const blockedInput = store.enqueueInput({
      workspaceId,
      sessionId: childSessionId,
      payload: {
        text: "Check the latest X post stats in my current browser tab.",
        model: "openai/gpt-5.5",
        thinking_value: "medium",
        context: {
          source: "subagent",
        },
      },
    });
    store.updateInput({ workspaceId, inputId: blockedInput.inputId, fields: { status: "DONE" } });
    store.upsertTurnResult({
      workspaceId,
      sessionId: childSessionId,
      inputId: blockedInput.inputId,
      startedAt: blockedAt,
      completedAt: blockedAt,
      status: "completed",
      stopReason: "waiting_on_user",
      assistantText: "Please log in to continue.",
    });
    store.createSubagentRun({
      subagentId,
      workspaceId,
      parentSessionId: mainSessionId,
      parentInputId: "parent-input-1",
      originMainSessionId: mainSessionId,
      ownerMainSessionId: mainSessionId,
      childSessionId,
      initialChildInputId: blockedInput.inputId,
      currentChildInputId: blockedInput.inputId,
      latestChildInputId: blockedInput.inputId,
      title: "Check X stats",
      goal: "Inspect the latest X post stats in the user's current browser tab.",
      sourceType: "delegate_task",
      effectiveModel: "openai/gpt-5.5",
      status: "waiting_on_user",
      summary: "Blocked by login.",
      blockingPayload: {
        status: "waiting_on_user",
        blocking_question: "Please log in, then tell me to continue.",
      },
    });

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const result = service.resumeSubagent({
      workspaceId,
      sessionId: mainSessionId,
      inputId: "parent-input-2",
      subagentId,
      answer: "Logged in now.",
    }) as Record<string, unknown>;

    const resumedInput = store.getInput({ workspaceId, inputId: String(result.latest_child_input_id) });
    assert.equal(resumedInput?.payload.model, "openai/gpt-5.5");
    assert.equal(resumedInput?.payload.thinking_value, "medium");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("resumeSubagent falls back to the controller session's latest model instead of the blocked child model", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-resume-controller-model-"));
  writeRuntimeConfig(root, {
    runtime: {
      default_model: "openai/gpt-5.4",
    },
  });
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const mainSessionId = "main-1";
  const childSessionId = "subagent-child-1";
  const subagentId = "subagent-run-1";
  const blockedAt = utcNowIso();

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.ensureSession({
      workspaceId,
      sessionId: mainSessionId,
      kind: "main_session",
      createdBy: "workspace_user",
    });
    store.ensureSession({
      workspaceId,
      sessionId: childSessionId,
      kind: "subagent",
      parentSessionId: mainSessionId,
      createdBy: "workspace_agent",
    });
    store.enqueueInput({
      workspaceId,
      sessionId: mainSessionId,
      payload: {
        text: "Use model A first.",
        model: "openai/gpt-5.4",
        thinking_value: "low",
      },
    });
    const controllerInput = store.enqueueInput({
      workspaceId,
      sessionId: mainSessionId,
      payload: {
        text: "Switch the controller session to model B before resume.",
        model: "openai/gpt-5.5",
        thinking_value: "medium",
      },
    });
    store.ensureRuntimeState({
      workspaceId,
      sessionId: mainSessionId,
      status: "QUEUED",
      currentInputId: controllerInput.inputId,
    });
    const blockedInput = store.enqueueInput({
      workspaceId,
      sessionId: childSessionId,
      payload: {
        text: "Blocked delegated task.",
        model: "openai/gpt-5.4",
        thinking_value: "low",
        context: {
          source: "subagent",
        },
      },
    });
    store.updateInput({ workspaceId, inputId: blockedInput.inputId, fields: { status: "DONE" } });
    store.upsertTurnResult({
      workspaceId,
      sessionId: childSessionId,
      inputId: blockedInput.inputId,
      startedAt: blockedAt,
      completedAt: blockedAt,
      status: "completed",
      stopReason: "waiting_on_user",
      assistantText: "Please log in to continue.",
    });
    store.createSubagentRun({
      subagentId,
      workspaceId,
      parentSessionId: mainSessionId,
      parentInputId: "parent-input-1",
      originMainSessionId: mainSessionId,
      ownerMainSessionId: mainSessionId,
      childSessionId,
      initialChildInputId: blockedInput.inputId,
      currentChildInputId: blockedInput.inputId,
      latestChildInputId: blockedInput.inputId,
      title: "Blocked delegated task",
      goal: "Finish the blocked task.",
      sourceType: "delegate_task",
      effectiveModel: "openai/gpt-5.4",
      status: "waiting_on_user",
      summary: "Blocked pending user input.",
      blockingPayload: {
        status: "waiting_on_user",
        blocking_question: "Please log in, then tell me to continue.",
      },
    });

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const result = service.resumeSubagent({
      workspaceId,
      sessionId: mainSessionId,
      subagentId,
      answer: "Continue now.",
    }) as Record<string, unknown>;

    const resumedInput = store.getInput({
      workspaceId,
      inputId: String(result.latest_child_input_id),
    });
    assert.equal(resumedInput?.payload.model, "openai/gpt-5.5");
    assert.equal(resumedInput?.payload.thinking_value, "medium");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("listBackgroundTasks keeps a completed delegated run completed even if the child runtime still looks busy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-completed-busy-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const mainSessionId = "main-1";
  const childSessionId = "subagent-child-1";
  const subagentId = "subagent-run-1";
  const completedAt = utcNowIso();

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.ensureSession({
      workspaceId,
      sessionId: mainSessionId,
      kind: "main_session",
      createdBy: "workspace_user",
    });
    store.createIssue({
      workspaceId,
      issueId: "HOL-1",
      sessionId: childSessionId,
      title: "Summarize the workspace state",
      description: "Finish the delegated summary.",
      status: "in_progress",
      assigneeId: "general",
      activeSubagentId: subagentId,
      latestSubagentId: subagentId,
    });
    store.ensureSession({
      workspaceId,
      sessionId: childSessionId,
      kind: "subagent",
      parentSessionId: mainSessionId,
      createdBy: "workspace_agent",
    });
    const input = store.enqueueInput({
      workspaceId,
      sessionId: childSessionId,
      payload: { text: "Summarize the workspace state." },
    });
    store.updateInput({
      workspaceId,
      inputId: input.inputId,
      fields: {
        status: "CLAIMED",
        claimedBy: "worker-1",
        claimedUntil: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    store.updateRuntimeState({
      workspaceId,
      sessionId: childSessionId,
      status: "BUSY",
      currentInputId: input.inputId,
      currentWorkerId: "worker-1",
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      heartbeatAt: completedAt,
      lastError: null,
    });
    store.upsertTurnResult({
      workspaceId,
      sessionId: childSessionId,
      inputId: input.inputId,
      startedAt: completedAt,
      completedAt,
      status: "completed",
      stopReason: "success",
      assistantText: "Workspace summary complete.",
    });
    store.createSubagentRun({
      subagentId,
      workspaceId,
      parentSessionId: mainSessionId,
      parentInputId: "parent-input-1",
      originMainSessionId: mainSessionId,
      ownerMainSessionId: mainSessionId,
      childSessionId,
      initialChildInputId: input.inputId,
      currentChildInputId: input.inputId,
      latestChildInputId: input.inputId,
      title: "Workspace summary",
      goal: "Summarize the workspace state.",
      sourceType: "delegate_task",
      issueId: "HOL-1",
      status: "running",
      startedAt: completedAt,
    });

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const result = service.listBackgroundTasks({
      workspaceId,
      sessionId: mainSessionId,
      ownerMainSessionId: mainSessionId,
      statuses: ["completed"],
    }) as Record<string, unknown>;
    const tasks = result.tasks as Array<Record<string, unknown>>;
    const updatedRun = store.getSubagentRun({ workspaceId, subagentId });
    const issue = store.getIssue({ workspaceId, issueId: "HOL-1" });

    assert.equal(result.count, 1);
    assert.equal(tasks[0]?.status, "completed");
    assert.equal(updatedRun?.status, "completed");
    assert.equal(updatedRun?.summary, "Workspace summary complete.");
    assert.equal(updatedRun?.resultPayload?.summary, "Workspace summary complete.");
    assert.equal(issue?.status, "done");
    assert.equal(issue?.activeSubagentId, null);
    assert.notEqual(issue?.completedAt, null);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("listBackgroundTasks compacts long completed child replies into a short task summary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-completed-summary-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const mainSessionId = "main-1";
  const childSessionId = "subagent-child-1";
  const subagentId = "subagent-run-1";
  const completedAt = utcNowIso();
  const longAssistantText = new Array(8)
    .fill(
      "China markets rallied after a strong industrial profits print, while chip and payments headlines pointed to a broader theme of strategic resilience across the economy. Huawei, Tencent, and Nvidia all featured prominently, and the foreign-policy track stayed tense around the South China Sea and trade adjustments. The detailed report includes the full sourcing and takeaways for each headline.",
    )
    .join(" ");

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.ensureSession({
      workspaceId,
      sessionId: mainSessionId,
      kind: "main_session",
      createdBy: "workspace_user",
    });
    store.createIssue({
      workspaceId,
      issueId: "HOL-1",
      sessionId: childSessionId,
      title: "Summarize the China news",
      description: "Finish the delegated summary.",
      status: "in_progress",
      assigneeId: "general",
      activeSubagentId: subagentId,
      latestSubagentId: subagentId,
    });
    store.ensureSession({
      workspaceId,
      sessionId: childSessionId,
      kind: "subagent",
      parentSessionId: mainSessionId,
      createdBy: "workspace_agent",
    });
    const input = store.enqueueInput({
      workspaceId,
      sessionId: childSessionId,
      payload: { text: "Summarize the China news." },
    });
    store.updateInput({
      workspaceId,
      inputId: input.inputId,
      fields: {
        status: "CLAIMED",
        claimedBy: "worker-1",
        claimedUntil: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    store.updateRuntimeState({
      workspaceId,
      sessionId: childSessionId,
      status: "BUSY",
      currentInputId: input.inputId,
      currentWorkerId: "worker-1",
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      heartbeatAt: completedAt,
      lastError: null,
    });
    store.upsertTurnResult({
      workspaceId,
      sessionId: childSessionId,
      inputId: input.inputId,
      startedAt: completedAt,
      completedAt,
      status: "completed",
      stopReason: "success",
      assistantText: longAssistantText,
    });
    store.createSubagentRun({
      subagentId,
      workspaceId,
      parentSessionId: mainSessionId,
      parentInputId: "parent-input-1",
      originMainSessionId: mainSessionId,
      ownerMainSessionId: mainSessionId,
      childSessionId,
      initialChildInputId: input.inputId,
      currentChildInputId: input.inputId,
      latestChildInputId: input.inputId,
      title: "China summary",
      goal: "Summarize the China news.",
      sourceType: "delegate_task",
      issueId: "HOL-1",
      status: "running",
      startedAt: completedAt,
    });

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    service.listBackgroundTasks({
      workspaceId,
      sessionId: mainSessionId,
      ownerMainSessionId: mainSessionId,
      statuses: ["completed"],
    });
    const updatedRun = store.getSubagentRun({ workspaceId, subagentId });

    assert.equal(updatedRun?.status, "completed");
    assert.ok((updatedRun?.summary ?? "").startsWith("China markets rallied after a strong industrial profits print"));
    assert.ok((updatedRun?.summary ?? "").length <= 40_000);
    assert.ok((updatedRun?.summary ?? "").length > 0);
    assert.equal(updatedRun?.resultPayload?.summary, updatedRun?.summary);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelSubagent waits for a claimed child runtime to settle before returning", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const mainSessionId = "main-1";
  const childSessionId = "subagent-child-1";
  const subagentId = "subagent-run-1";
  const startedAt = utcNowIso();

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.ensureSession({
      workspaceId,
      sessionId: mainSessionId,
      kind: "main_session",
      createdBy: "workspace_user",
    });
    store.createIssue({
      workspaceId,
      issueId: "HOL-1",
      sessionId: childSessionId,
      title: "Latest news on agent harnesses",
      description: "Research the latest news on agent harnesses.",
      status: "in_progress",
      assigneeId: "general",
      activeSubagentId: subagentId,
      latestSubagentId: subagentId,
    });
    store.ensureSession({
      workspaceId,
      sessionId: childSessionId,
      kind: "subagent",
      parentSessionId: mainSessionId,
      createdBy: "workspace_agent",
    });

    const queued = store.enqueueInput({
      workspaceId,
      sessionId: childSessionId,
      payload: { text: "do work" },
    });
    store.updateInput({ workspaceId, inputId: queued.inputId, fields: {
      status: "CLAIMED",
      claimedBy: "worker-1",
      claimedUntil: new Date(Date.now() + 60_000).toISOString(),
    } });
    store.updateRuntimeState({
      workspaceId,
      sessionId: childSessionId,
      status: "BUSY",
      currentInputId: queued.inputId,
      currentWorkerId: "worker-1",
      leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      heartbeatAt: utcNowIso(),
      lastError: null,
    });
    store.createSubagentRun({
      subagentId,
      workspaceId,
      parentSessionId: mainSessionId,
      originMainSessionId: mainSessionId,
      ownerMainSessionId: mainSessionId,
      childSessionId,
      initialChildInputId: queued.inputId,
      currentChildInputId: queued.inputId,
      latestChildInputId: queued.inputId,
      title: "Latest news on agent harnesses",
      goal: "Research the latest news on agent harnesses.",
      sourceType: "delegate_task",
      issueId: "HOL-1",
      status: "running",
      startedAt,
    });

    let pauseCalls = 0;
    const service = new RuntimeAgentToolsService(store, {
      workspaceRoot,
      queueWorker: {
        start: async () => {},
        wake: () => {},
        close: async () => {},
        pauseSessionRun: async () => {
          pauseCalls += 1;
          setTimeout(() => {
            const pausedAt = utcNowIso();
            store.updateInput({ workspaceId, inputId: queued.inputId, fields: {
              status: "PAUSED",
              claimedBy: null,
              claimedUntil: null,
            } });
            store.updateRuntimeState({
              workspaceId,
              sessionId: childSessionId,
              status: "PAUSED",
              currentInputId: null,
              currentWorkerId: null,
              leaseUntil: null,
              heartbeatAt: null,
              lastError: null,
            });
            store.upsertTurnResult({
              workspaceId,
              sessionId: childSessionId,
              inputId: queued.inputId,
              startedAt,
              completedAt: pausedAt,
              status: "paused",
              stopReason: "paused",
              assistantText: "Run paused by user request",
            });
          }, 25);
          return {
            inputId: queued.inputId,
            sessionId: childSessionId,
            status: "PAUSING" as const,
          };
        },
      },
    });

    const result = (await service.cancelSubagent({
      workspaceId,
      sessionId: mainSessionId,
      subagentId,
    })) as Record<string, unknown>;

    assert.equal(pauseCalls, 1);
    assert.equal(result.status, "cancelled");
    assert.equal(result.summary, "Cancelled by user.");
    assert.equal(result.completed_at !== null, true);
    assert.deepEqual(result.live_state, {
      runtime_status: "PAUSED",
      current_input_id: queued.inputId,
      current_input_status: "PAUSED",
      latest_input_id: queued.inputId,
      latest_input_status: "PAUSED",
      latest_turn_status: "paused",
      latest_turn_stop_reason: "paused",
    });
    const issue = store.getIssue({ workspaceId, issueId: "HOL-1" });
    assert.equal(issue?.status, "blocked");
    assert.equal(issue?.blockerReason, "Run cancelled by user.");
    assert.equal(issue?.activeSubagentId, null);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

interface Harness {
  service: RuntimeAgentToolsService;
  workspaceId: string;
  workspaceDir: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-runtime-tools-"));
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
  const workspaceDir = path.join(workspaceRoot, workspace.id);
  fs.mkdirSync(path.join(workspaceDir, ".holaboss"), { recursive: true });

  const service = new RuntimeAgentToolsService(store, { workspaceRoot });
  return {
    service,
    workspaceId: workspace.id,
    workspaceDir,
    cleanup: () => {
      try {
        store.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("invokeSkill resolves workspace-local skills from a registered custom workspace path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-skill-custom-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const customRoot = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-skill-custom-workspace-"));
  const customWorkspaceDir = path.join(customRoot, "workspace");
  const skillDir = path.join(customWorkspaceDir, "skills", "deploy-helper");

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    seedWorkspaceRecord(store, {
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
      workspacePath: customWorkspaceDir,
    });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: deploy-helper",
        "description: Deployment helper",
        "---",
        "",
        "# Deploy Helper",
        "",
        "Use the deploy workflow carefully.",
      ].join("\n"),
      "utf8",
    );

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const result = service.invokeSkill({
      workspaceId: "workspace-1",
      requestedName: "deploy-helper",
      args: "Only use the docs path.",
    }) as {
      text: string;
      skill_id: string;
      skill_file_path: string;
    };

    assert.equal(result.skill_id, "deploy-helper");
    assert.match(result.text, /Only use the docs path\./);
    assert.equal(
      result.skill_file_path,
      fs.realpathSync(path.join(skillDir, "SKILL.md")),
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
    await rm(customRoot, { recursive: true, force: true });
  }
});

test("invokeSkill resolves workspace-scoped local skills for an assigned issue session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-skill-workspace-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    const workspace = seedWorkspaceRecord(store, {
      workspaceId: "workspace-1",
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
      store.workspaceDir(workspace.id),
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

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const result = service.invokeSkill({
      workspaceId: workspace.id,
      sessionId: issue.sessionId,
      requestedName: "frontend-playbook",
    }) as {
      text: string;
      skill_id: string;
      skill_file_path: string;
    };

    assert.equal(result.skill_id, "frontend-playbook");
    assert.match(result.text, /Use the dashboard patterns\./);
    assert.equal(
      result.skill_file_path,
      fs.realpathSync(path.join(skillDir, "SKILL.md")),
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace app runtime tools stay available to General-executor sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-app-builder-guard-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    const workspace = seedWorkspaceRecord(store, {
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    const generalIssue = store.createIssue({
      workspaceId: workspace.id,
      sessionId: "session-general-1",
      title: "Build an app",
      description: "Create a new dashboard app.",
      status: "todo",
      assigneeId: "general",
      createdBy: "workspace_user",
    });
    const appBuilderIssue = store.createIssue({
      workspaceId: workspace.id,
      sessionId: "session-app-builder-1",
      title: "Build an app",
      description: "Create a new dashboard app.",
      status: "todo",
      assigneeId: "general",
      createdBy: "workspace_user",
    });

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const generalResult = await service.scaffoldWorkspaceApp({
      workspaceId: workspace.id,
      sessionId: generalIssue.sessionId,
      appId: "demo-app-general",
      name: "Demo App General",
    });
    const result = await service.scaffoldWorkspaceApp({
      workspaceId: workspace.id,
      sessionId: appBuilderIssue.sessionId,
      appId: "demo-app-compat",
      name: "Demo App Compat",
    });

    assert.equal(generalResult.app_id, "demo-app-general");
    assert.equal(generalResult.app_dir, "apps/demo-app-general");
    assert.equal(result.app_id, "demo-app-compat");
    assert.equal(result.app_dir, "apps/demo-app-compat");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

let harness: Harness;
beforeEach(() => {
  harness = makeHarness();
});
afterEach(() => {
  harness.cleanup();
  if (ORIGINAL_ENV.HB_SANDBOX_ROOT === undefined) {
    delete process.env.HB_SANDBOX_ROOT;
  } else {
    process.env.HB_SANDBOX_ROOT = ORIGINAL_ENV.HB_SANDBOX_ROOT;
  }
  if (ORIGINAL_ENV.HOLABOSS_RUNTIME_CONFIG_PATH === undefined) {
    delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  } else {
    process.env.HOLABOSS_RUNTIME_CONFIG_PATH = ORIGINAL_ENV.HOLABOSS_RUNTIME_CONFIG_PATH;
  }
});

test("scaffoldWorkspaceApp and registerWorkspaceApp create a minimal managed app skeleton", async () => {
  const scaffold = await harness.service.scaffoldWorkspaceApp({
    workspaceId: harness.workspaceId,
    appId: "demo-app",
    name: "Demo App",
  });

  assert.equal(scaffold.app_id, "demo-app");
  assert.equal(scaffold.app_dir, "apps/demo-app");
  assert.equal(
    fs.existsSync(path.join(harness.workspaceDir, "apps", "demo-app", "app.runtime.yaml")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(harness.workspaceDir, "apps", "demo-app", "src", "server.ts")),
    true,
  );

  const firstRegister = await harness.service.registerWorkspaceApp({
    workspaceId: harness.workspaceId,
    appId: "demo-app",
  });
  assert.equal(firstRegister.changed, true);
  assert.equal(firstRegister.config_path, "apps/demo-app/app.runtime.yaml");

  const secondRegister = await harness.service.registerWorkspaceApp({
    workspaceId: harness.workspaceId,
    appId: "demo-app",
  });
  assert.equal(secondRegister.changed, false);

  const workspaceYaml = parseYaml(
    fs.readFileSync(path.join(harness.workspaceDir, "workspace.yaml"), "utf8"),
  ) as { applications?: Array<{ app_id: string; config_path: string }> };
  assert.deepEqual(workspaceYaml.applications, [
    {
      app_id: "demo-app",
      config_path: "apps/demo-app/app.runtime.yaml",
      lifecycle: {
        setup: "npm install",
        start: "npm run start",
      },
    },
  ]);

  const status = harness.service.getWorkspaceAppStatus({
    workspaceId: harness.workspaceId,
    appId: "demo-app",
  }) as {
    build_status: string;
    ready: boolean;
    config_path: string;
    ports: { http: number; mcp: number } | null;
    runtime_contract: {
      mcp: { sse_path: string; message_path: string; tools_declared: string[] };
      healthcheck: { path: string; target: string };
    } | null;
    revision: {
      source_updated_at: string | null;
      build_record_created_at: string | null;
      managed_runtime_stale: boolean | null;
    };
  };
  assert.equal(status.build_status, "pending");
  assert.equal(status.ready, false);
  assert.equal(status.config_path, "apps/demo-app/app.runtime.yaml");
  assert.ok(status.ports);
  assert.equal(typeof status.ports?.http, "number");
  assert.equal(typeof status.ports?.mcp, "number");
  assert.equal(status.runtime_contract?.mcp.sse_path, "/mcp/sse");
  assert.equal(status.runtime_contract?.mcp.message_path, "/mcp/messages");
  assert.equal(status.runtime_contract?.healthcheck.path, "/mcp/health");
  assert.equal(status.runtime_contract?.healthcheck.target, "mcp");
  assert.equal(typeof status.revision.source_updated_at, "string");
  assert.equal(status.revision.build_record_created_at, null);
  assert.equal(status.revision.managed_runtime_stale, null);

  const ports = harness.service.getWorkspaceAppPorts({
    workspaceId: harness.workspaceId,
    appId: "demo-app",
  }) as {
    ports: { http: number; mcp: number };
  };
  assert.equal(ports.ports.http, status.ports?.http);
  assert.equal(ports.ports.mcp, status.ports?.mcp);
});

test("workspace app registration rejects non-canonical integration providers", async () => {
  await harness.service.scaffoldWorkspaceApp({
    workspaceId: harness.workspaceId,
    appId: "x-demo",
    name: "X Demo",
  });
  fs.appendFileSync(
    path.join(harness.workspaceDir, "apps", "x-demo", "app.runtime.yaml"),
    [
      "",
      "integrations:",
      "  - key: primary_x",
      "    provider: x",
      "    capability: api",
      "    required: true",
      "",
    ].join("\n"),
    "utf8",
  );

  await assert.rejects(
    () =>
      harness.service.registerWorkspaceApp({
        workspaceId: harness.workspaceId,
        appId: "x-demo",
      }),
    (error) => {
      assert.equal(error instanceof RuntimeAgentToolsServiceError, true);
      assert.equal((error as RuntimeAgentToolsServiceError).statusCode, 400);
      assert.match(
        (error as RuntimeAgentToolsServiceError).message,
        /Use canonical provider_id 'twitter'/,
      );
      return true;
    },
  );
});

test("workspace app registration rejects providers outside the store catalog with a nearest-match suggestion", async () => {
  await harness.service.scaffoldWorkspaceApp({
    workspaceId: harness.workspaceId,
    appId: "typo-demo",
    name: "Typo Demo",
  });
  fs.appendFileSync(
    path.join(harness.workspaceDir, "apps", "typo-demo", "app.runtime.yaml"),
    [
      "",
      "integrations:",
      "  - key: primary",
      "    provider: gmial",
      "    capability: api",
      "    required: true",
      "",
    ].join("\n"),
    "utf8",
  );

  await assert.rejects(
    () =>
      harness.service.registerWorkspaceApp({
        workspaceId: harness.workspaceId,
        appId: "typo-demo",
      }),
    (error) => {
      assert.equal(error instanceof RuntimeAgentToolsServiceError, true);
      assert.equal((error as RuntimeAgentToolsServiceError).statusCode, 400);
      assert.match(
        (error as RuntimeAgentToolsServiceError).message,
        /unknown integration provider 'gmial'.*Did you mean 'gmail'/,
      );
      return true;
    },
  );
});

test("workspace app registration rejects source that hardcodes an upstream toolkit host", async () => {
  await harness.service.scaffoldWorkspaceApp({
    workspaceId: harness.workspaceId,
    appId: "host-bake-demo",
    name: "Host Bake Demo",
  });
  fs.appendFileSync(
    path.join(harness.workspaceDir, "apps", "host-bake-demo", "app.runtime.yaml"),
    [
      "",
      "integrations:",
      "  - key: primary",
      "    provider: twitter",
      "    capability: api",
      "    required: true",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.mkdirSync(
    path.join(harness.workspaceDir, "apps", "host-bake-demo", "src"),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(harness.workspaceDir, "apps", "host-bake-demo", "src", "client.ts"),
    [
      "// vibe-coded probe — exactly the bug class this lint is meant to catch.",
      "export async function probe() {",
      "  return await fetch(\"https://api.twitter.com/2/users/me\");",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  await assert.rejects(
    () =>
      harness.service.registerWorkspaceApp({
        workspaceId: harness.workspaceId,
        appId: "host-bake-demo",
      }),
    (error) => {
      assert.equal(error instanceof RuntimeAgentToolsServiceError, true);
      assert.equal((error as RuntimeAgentToolsServiceError).statusCode, 400);
      assert.match(
        (error as RuntimeAgentToolsServiceError).message,
        /api\.twitter\.com/,
      );
      assert.match(
        (error as RuntimeAgentToolsServiceError).message,
        /createRuntimeBrokerTransport/,
      );
      return true;
    },
  );
});

test("workspace app registration rejects providerEffectAction providers missing from integrations", async () => {
  await harness.service.scaffoldWorkspaceApp({
    workspaceId: harness.workspaceId,
    appId: "provider-effect-demo",
    name: "Provider Effect Demo",
  });
  fs.mkdirSync(
    path.join(harness.workspaceDir, "apps", "provider-effect-demo", "src"),
    { recursive: true },
  );
  fs.writeFileSync(
    path.join(harness.workspaceDir, "apps", "provider-effect-demo", "src", "send.ts"),
    [
      "import { providerEffectAction } from \"@holaboss/app-builder-sdk\";",
      "",
      "export const send = providerEffectAction({",
      "  provider: \"gmail\",",
      "  fromStates: [\"approved\"],",
      "  toState: \"sent\",",
      "  blockedState: \"send_blocked\",",
      "  buildRequest: ({ row }) => ({ to: row.email }),",
      "  execute: async ({ bridge, request }) => bridge.call(\"POST\", \"/messages/send\", request),",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  await assert.rejects(
    () =>
      harness.service.registerWorkspaceApp({
        workspaceId: harness.workspaceId,
        appId: "provider-effect-demo",
      }),
    (error) => {
      assert.equal(error instanceof RuntimeAgentToolsServiceError, true);
      assert.equal((error as RuntimeAgentToolsServiceError).statusCode, 400);
      assert.equal(
        (error as RuntimeAgentToolsServiceError).code,
        "workspace_app_provider_effect_integration_missing",
      );
      assert.match(
        (error as RuntimeAgentToolsServiceError).message,
        /providerEffectAction provider 'gmail'/,
      );
      assert.match(
        (error as RuntimeAgentToolsServiceError).message,
        /app\.runtime\.yaml integrations/i,
      );
      return true;
    },
  );
});

test("workspace app registration accepts store-catalog providers beyond the OSS provider list", async () => {
  // 'notion' is in the store catalog (hero tier) but not in the legacy
  // integration-catalog.ts OSS provider list. Pre-fix, this would have
  // been rejected as unknown.
  await harness.service.scaffoldWorkspaceApp({
    workspaceId: harness.workspaceId,
    appId: "notion-demo",
    name: "Notion Demo",
  });
  fs.appendFileSync(
    path.join(harness.workspaceDir, "apps", "notion-demo", "app.runtime.yaml"),
    [
      "",
      "integrations:",
      "  - key: primary",
      "    provider: notion",
      "    capability: api",
      "    required: true",
      "",
    ].join("\n"),
    "utf8",
  );

  const result = (await harness.service.registerWorkspaceApp({
    workspaceId: harness.workspaceId,
    appId: "notion-demo",
  })) as { registered: boolean };
  assert.equal(result.registered, true);
});

test("workspace app registration rejects a dashboard app whose src/client doesn't import any @holaboss/ui layout", async () => {
  await harness.service.scaffoldWorkspaceApp({
    workspaceId: harness.workspaceId,
    appId: "naked-dash",
    name: "Naked Dashboard",
  });
  const clientDir = path.join(
    harness.workspaceDir,
    "apps",
    "naked-dash",
    "src",
    "client",
  );
  fs.mkdirSync(clientDir, { recursive: true });
  // A dashboard component that does the exact failure mode: stack of
  // hand-rolled cards, no @holaboss/ui layout primitive in sight.
  fs.writeFileSync(
    path.join(clientDir, "Dashboard.tsx"),
    [
      "export function Dashboard() {",
      "  return (",
      "    <div className=\"flex flex-col gap-2\">",
      "      <div className=\"rounded border p-3\">Likes 0</div>",
      "      <div className=\"rounded border p-3\">Replies 0</div>",
      "    </div>",
      "  );",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  await assert.rejects(
    () =>
      harness.service.registerWorkspaceApp({
        workspaceId: harness.workspaceId,
        appId: "naked-dash",
      }),
    (error) => {
      assert.equal(error instanceof RuntimeAgentToolsServiceError, true);
      assert.equal((error as RuntimeAgentToolsServiceError).statusCode, 400);
      assert.match(
        (error as RuntimeAgentToolsServiceError).message,
        /only 0 distinct named import\(s\) from `@holaboss\/ui`/,
      );
      const msg = (error as RuntimeAgentToolsServiceError).message;
      assert.ok(msg.includes("Button"), `expected Button in error, got: ${msg}`);
      assert.ok(msg.includes("Card"), `expected Card in error, got: ${msg}`);
      assert.ok(msg.includes("ChartContainer"), `expected ChartContainer in error, got: ${msg}`);
      return true;
    },
  );
});

test("workspace app registration accepts a dashboard app that uses any @holaboss/ui layout", async () => {
  await harness.service.scaffoldWorkspaceApp({
    workspaceId: harness.workspaceId,
    appId: "real-dash",
    name: "Real Dashboard",
  });
  const clientDir = path.join(
    harness.workspaceDir,
    "apps",
    "real-dash",
    "src",
    "client",
  );
  fs.mkdirSync(clientDir, { recursive: true });
  fs.writeFileSync(
    path.join(clientDir, "Dashboard.tsx"),
    [
      "import { Badge, Button, Card } from \"@holaboss/ui\";",
      "export function Dashboard() {",
      "  return (",
      "    <Card>",
      "      <Badge>Live</Badge>",
      "      <Button>Refresh</Button>",
      "    </Card>",
      "  );",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  // Satisfy the workspace_app_missing_tailwind_compile lint — every
  // dashboard app with src/client/ must carry a .css entry under it that
  // declares @import "tailwindcss" so the app's own utilities compile.
  fs.writeFileSync(
    path.join(clientDir, "app.css"),
    "@import \"tailwindcss\";\n@source \"../client\";\n",
    "utf8",
  );

  const result = (await harness.service.registerWorkspaceApp({
    workspaceId: harness.workspaceId,
    appId: "real-dash",
  })) as { registered: boolean };
  assert.equal(result.registered, true);
});

test("workspace app registration ignores ui lint for integration-only apps without src/client", async () => {
  await harness.service.scaffoldWorkspaceApp({
    workspaceId: harness.workspaceId,
    appId: "headless-mod",
    name: "Headless Module",
  });
  // No src/client; the scaffold default is integration-only. Register
  // must not demand @holaboss/ui imports from these.
  const result = (await harness.service.registerWorkspaceApp({
    workspaceId: harness.workspaceId,
    appId: "headless-mod",
  })) as { registered: boolean };
  assert.equal(result.registered, true);
});

test("listIntegrationCatalog exposes canonical provider ids for app builders", async () => {
  const catalog = await harness.service.listIntegrationCatalog({
    workspaceId: harness.workspaceId,
  }) as {
    provider_ids: string[];
    providers: Array<{ provider_id: string; display_name: string }>;
    requirement: string;
  };

  assert.ok(catalog.provider_ids.includes("twitter"));
  assert.equal(catalog.provider_ids.includes("x"), false);
  assert.equal(
    catalog.providers.some((provider) => provider.provider_id === "twitter"),
    true,
  );
  assert.match(catalog.requirement, /use 'twitter' for X/i);
});

test("listIntegrationCatalog includes store-catalog-only toolkits", async () => {
  const catalog = await harness.service.listIntegrationCatalog({
    workspaceId: harness.workspaceId,
  }) as {
    provider_ids: string[];
    providers: Array<{
      provider_id: string;
      supports_managed: boolean;
      supports_oss: boolean;
    }>;
  };

  assert.ok(catalog.provider_ids.includes("googledocs"));
  const googledocs = catalog.providers.find(
    (provider) => provider.provider_id === "googledocs",
  );
  assert.equal(googledocs?.supports_managed, true);
  assert.equal(googledocs?.supports_oss, false);
  const gmail = catalog.providers.filter(
    (provider) => provider.provider_id === "gmail",
  );
  assert.equal(gmail.length, 1);
});

test("createCronjob binds and validates an explicit project", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-runtime-agent-tools-cronjob-project-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.createWorkspaceProject({
      workspaceId,
      projectId: "project-1",
      name: "Weekly reports",
      projectPath: path.join(root, "projects", "weekly-reports"),
    });
    const service = new RuntimeAgentToolsService(store, { workspaceRoot });

    const created = service.createCronjob({
      workspaceId,
      cron: "0 9 * * 1",
      description: "Weekly report",
      projectId: "project-1",
    }) as { metadata: Record<string, unknown> };
    assert.equal(created.metadata.project_id, "project-1");

    assert.throws(
      () =>
        service.createCronjob({
          workspaceId,
          cron: "0 9 * * 1",
          description: "Weekly report",
          projectId: "project-missing",
        }),
      /project/i,
    );
  } finally {
    try {
      store.close();
    } catch {
      // ignore
    }
  }
});

test("createCronjob defaults the project binding from the calling session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-runtime-agent-tools-cronjob-project-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.createWorkspaceProject({
      workspaceId,
      projectId: "project-1",
      name: "Weekly reports",
      projectPath: path.join(root, "projects", "weekly-reports"),
    });
    store.ensureSession({
      workspaceId,
      sessionId: "session-in-project",
      kind: "main_session",
      projectId: "project-1",
    });
    store.ensureSession({
      workspaceId,
      sessionId: "session-no-project",
      kind: "main_session",
    });
    const service = new RuntimeAgentToolsService(store, { workspaceRoot });

    const fromProjectChat = service.createCronjob({
      workspaceId,
      sessionId: "session-in-project",
      cron: "0 9 * * 1",
      description: "Weekly report",
    }) as { metadata: Record<string, unknown> };
    assert.equal(fromProjectChat.metadata.project_id, "project-1");

    const fromPlainChat = service.createCronjob({
      workspaceId,
      sessionId: "session-no-project",
      cron: "0 9 * * 1",
      description: "Weekly report",
    }) as { metadata: Record<string, unknown> };
    assert.equal(fromPlainChat.metadata.project_id, undefined);
  } finally {
    try {
      store.close();
    } catch {
      // ignore
    }
  }
});

test("updateCronjob rebinds and unbinds the project", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-runtime-agent-tools-cronjob-project-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.createWorkspaceProject({
      workspaceId,
      projectId: "project-1",
      name: "Weekly reports",
      projectPath: path.join(root, "projects", "weekly-reports"),
    });
    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const created = service.createCronjob({
      workspaceId,
      cron: "0 9 * * 1",
      description: "Weekly report",
    }) as { id: string };

    const bound = service.updateCronjob({
      workspaceId,
      jobId: created.id,
      projectId: "project-1",
    }) as { metadata: Record<string, unknown> };
    assert.equal(bound.metadata.project_id, "project-1");

    const unbound = service.updateCronjob({
      workspaceId,
      jobId: created.id,
      projectId: "",
    }) as { metadata: Record<string, unknown> };
    assert.equal(unbound.metadata.project_id, undefined);
  } finally {
    try {
      store.close();
    } catch {
      // ignore
    }
  }
});

test("listIntegrationCatalog exposes connected account namespaces", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-runtime-agent-tools-catalog-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.upsertIntegrationConnection({
      connectionId: "conn-gmail",
      providerId: "gmail",
      ownerUserId: "user-1",
      accountLabel: "Gmail label",
      accountEmail: "ops@example.com",
      authMode: "oauth_app",
      grantedScopes: [],
      status: "active",
      secretRef: "token-gmail",
    });
    store.upsertIntegrationConnection({
      connectionId: "conn-github",
      providerId: "github",
      ownerUserId: "user-1",
      accountLabel: "GitHub label",
      accountHandle: "octocat",
      authMode: "oauth_app",
      grantedScopes: [],
      status: "active",
      secretRef: "token-github",
    });
    store.upsertIntegrationConnection({
      connectionId: "conn-notion",
      providerId: "notion",
      ownerUserId: "user-1",
      accountLabel: "Workspace Docs",
      authMode: "oauth_app",
      grantedScopes: [],
      status: "active",
      secretRef: "token-notion",
    });

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const catalog = await service.listIntegrationCatalog({ workspaceId }) as {
      providers: Array<{
        provider_id: string;
        connected_accounts?: Array<{
          connection_id: string;
          account_namespace: string;
        }>;
      }>;
      requirement: string;
    };

    const gmail = catalog.providers.find((provider) => provider.provider_id === "gmail");
    const github = catalog.providers.find((provider) => provider.provider_id === "github");
    const notion = catalog.providers.find((provider) => provider.provider_id === "notion");

    assert.deepEqual(gmail?.connected_accounts, [
      { connection_id: "conn-gmail", account_namespace: "ops@example.com" },
    ]);
    assert.deepEqual(github?.connected_accounts, [
      { connection_id: "conn-github", account_namespace: "octocat" },
    ]);
    assert.deepEqual(notion?.connected_accounts, [
      { connection_id: "conn-notion", account_namespace: "Workspace Docs" },
    ]);
    assert.match(catalog.requirement, /account namespace/i);
  } finally {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildWorkspaceApp runs a deterministic app-local build script", async () => {
  await harness.service.scaffoldWorkspaceApp({
    workspaceId: harness.workspaceId,
    appId: "demo-app",
    name: "Demo App",
  });
  fs.writeFileSync(
    path.join(harness.workspaceDir, "apps", "demo-app", "package.json"),
    `${JSON.stringify(
      {
        name: "demo-app",
        version: "0.1.0",
        private: true,
        scripts: {
          build: "node -e \"process.stdout.write('build-ok')\"",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await harness.service.registerWorkspaceApp({
    workspaceId: harness.workspaceId,
    appId: "demo-app",
  });

  const built = await harness.service.buildWorkspaceApp({
    workspaceId: harness.workspaceId,
    appId: "demo-app",
  }) as {
    ok: boolean;
    timed_out: boolean;
    exit_code: number | null;
    stdout: string;
    command: string;
    build_script: string | null;
  };

  assert.equal(built.ok, true);
  assert.equal(built.timed_out, false);
  assert.equal(built.exit_code, 0);
  assert.equal(built.command, "npm run build");
  assert.equal(built.build_script, "node -e \"process.stdout.write('build-ok')\"");
  assert.match(built.stdout, /build-ok/);
});

test("ensureWorkspaceAppsRunning, restartWorkspaceApp, and waitUntilWorkspaceAppReady use managed lifecycle state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-app-lifecycle-"));
  writeRuntimeConfig(root, {
    runtime: {
      default_model: "openai/gpt-5.4",
    },
  });
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const calls: string[] = [];
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    const service = new RuntimeAgentToolsService(store, {
      workspaceRoot,
      appLifecycle: {
        ensureAppRunning: async (callWorkspaceId, callAppId) => {
          calls.push(`ensure:${callWorkspaceId}:${callAppId}`);
          store.upsertAppBuild({
            workspaceId: callWorkspaceId,
            appId: callAppId,
            status: "running",
          });
        },
        stopApp: async (callWorkspaceId, callAppId) => {
          calls.push(`stop:${callWorkspaceId}:${callAppId}`);
          store.upsertAppBuild({
            workspaceId: callWorkspaceId,
            appId: callAppId,
            status: "stopped",
          });
          return { stopped: true };
        },
      },
    });

    await service.scaffoldWorkspaceApp({
      workspaceId,
      appId: "demo-app",
      name: "Demo App",
    });
    await service.registerWorkspaceApp({
      workspaceId,
      appId: "demo-app",
    });

    const ensured = await service.ensureWorkspaceAppsRunning({
      workspaceId,
      appIds: ["demo-app"],
    }) as {
      app_ids: string[];
      status: { apps: Array<{ app_id: string; ready: boolean }> };
    };
    assert.deepEqual(ensured.app_ids, ["demo-app"]);
    assert.equal(calls[0], "ensure:workspace-1:demo-app");
    assert.equal(ensured.status.apps[0]?.ready, true);

    store.upsertAppBuild({
      workspaceId,
      appId: "demo-app",
      status: "building",
    });
    setTimeout(() => {
      store.upsertAppBuild({
        workspaceId,
        appId: "demo-app",
        status: "running",
      });
    }, 25);

    const waited = await service.waitUntilWorkspaceAppReady({
      workspaceId,
      appId: "demo-app",
      timeoutMs: 1000,
      pollIntervalMs: 10,
    }) as {
      ready: boolean;
      timed_out: boolean;
      build_status: string;
    };
    assert.equal(waited.ready, true);
    assert.equal(waited.timed_out, false);
    assert.equal(waited.build_status, "running");

    const restarted = await service.restartWorkspaceApp({
      workspaceId,
      appId: "demo-app",
    }) as {
      restarted: boolean;
      status: { ready: boolean };
    };
    assert.equal(restarted.restarted, true);
    assert.equal(restarted.status.ready, true);
    assert.deepEqual(calls.slice(-2), [
      "stop:workspace-1:demo-app",
      "ensure:workspace-1:demo-app",
    ]);

    const restartedAndWaited = await service.restartAndWaitUntilWorkspaceAppReady({
      workspaceId,
      appId: "demo-app",
      timeoutMs: 1_000,
      pollIntervalMs: 10,
    }) as {
      restarted: boolean;
      ready: boolean;
      timed_out: boolean;
    };
    assert.equal(restartedAndWaited.restarted, true);
    assert.equal(restartedAndWaited.ready, true);
    assert.equal(restartedAndWaited.timed_out, false);

    await sleep(20);
    fs.appendFileSync(
      path.join(workspaceRoot, workspaceId, "apps", "demo-app", "src", "server.ts"),
      "\n// stale after runtime start\n",
      "utf8",
    );
    const staleStatus = service.getWorkspaceAppStatus({
      workspaceId,
      appId: "demo-app",
    }) as {
      ready: boolean;
      revision: { managed_runtime_stale: boolean | null; source_updated_at: string | null; last_ready_at: string | null };
    };
    assert.equal(staleStatus.ready, true);
    assert.equal(staleStatus.revision.managed_runtime_stale, true);
    assert.equal(typeof staleStatus.revision.source_updated_at, "string");
    assert.equal(typeof staleStatus.revision.last_ready_at, "string");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureWorkspaceAppsRunning runs delegated task smoke tests and forwards parent turn context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-app-smoke-success-"));
  writeRuntimeConfig(root, {
    runtime: {
      default_model: "openai_codex/gpt-5.4",
    },
  });
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  let server: { close: () => Promise<void> } | null = null;
  const capturedBodies: Array<Record<string, unknown>> = [];

  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    const issue = store.createIssue({
      workspaceId,
      sessionId: "session-app-builder-1",
      title: "Build app",
      description: "Create an app.",
      status: "todo",
      assigneeId: "general",
      createdBy: "workspace_user",
    });
    const service = new RuntimeAgentToolsService(store, {
      workspaceRoot,
      appLifecycle: {
        ensureAppRunning: async (callWorkspaceId, callAppId) => {
          store.upsertAppBuild({
            workspaceId: callWorkspaceId,
            appId: callAppId,
            status: "running",
          });
        },
      },
    });

    await service.scaffoldWorkspaceApp({
      workspaceId,
      sessionId: issue.sessionId,
      appId: "demo-app",
      name: "Demo App",
    });
    fs.writeFileSync(
      path.join(workspaceRoot, workspaceId, "apps", "demo-app", "app.runtime.yaml"),
      `app_id: demo-app
name: Demo App
slug: demo-app
lifecycle:
  setup: npm install
  start: npm run start
healthchecks:
  mcp:
    path: /mcp/health
    timeout_s: 30
    interval_s: 5
mcp:
  transport: http-sse
  port: 13100
  path: /mcp/sse
  tools: []
env_contract:
  - HOLABOSS_WORKSPACE_ID
smoke_tests:
  - name: queue_task
    kind: delegated_task_action
    payload:
      action_name: delegate
      resource_name: report_request
      row_status: ready
      row_data:
        title: Smoke latest news
    expect:
      row_status: delegated
      task_statuses:
        - todo
      run_statuses:
        - queued
`,
      "utf8",
    );
    await service.registerWorkspaceApp({
      workspaceId,
      sessionId: issue.sessionId,
      appId: "demo-app",
    });

    const resolved = resolveWorkspaceAppRuntime(
      path.join(workspaceRoot, workspaceId),
      "demo-app",
      {
        store,
        workspaceId,
        allocatePorts: true,
      },
    );
    server = await startStaticHttpServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/__holaboss/actions/run") {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      capturedBodies.push(body);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        ok: true,
        created_row: true,
        row: {
          id: "row-1",
          resource: "report_request",
          status: "delegated",
          data: {
            title: "Smoke latest news",
          },
          external_id: "ISS-1",
          error_message: null,
          created_in_turn: typeof body.turn_context === "object" && body.turn_context
            ? (body.turn_context as Record<string, unknown>).turn_id ?? null
            : null,
          session_id: typeof body.turn_context === "object" && body.turn_context
            ? (body.turn_context as Record<string, unknown>).session_id ?? null
            : null,
          created_at: utcNowIso(),
          updated_at: utcNowIso(),
        },
        action: {
          ok: true,
          data: {
            task_id: "ISS-1",
            task: {
              task_id: "ISS-1",
              status: "todo",
              latest_run: {
                status: "queued",
                requested_model: null,
                effective_model: "openai_codex/gpt-5.4",
                parent_session_id: typeof body.turn_context === "object" && body.turn_context
                  ? (body.turn_context as Record<string, unknown>).session_id ?? null
                  : null,
                parent_input_id: typeof body.turn_context === "object" && body.turn_context
                  ? (body.turn_context as Record<string, unknown>).input_id ?? null
                  : null,
              },
            },
          },
        },
      }));
    }, resolved.ports.http);

    const result = await service.ensureWorkspaceAppsRunning({
      workspaceId,
      sessionId: issue.sessionId,
      appIds: ["demo-app"],
    }) as {
      smoke_tests?: Array<Record<string, unknown>>;
    };

    assert.equal(result.smoke_tests?.length, 1);
    assert.equal(result.smoke_tests?.[0]?.app_id, "demo-app");
    assert.equal(result.smoke_tests?.[0]?.name, "queue_task");
    assert.equal(result.smoke_tests?.[0]?.task_status, "todo");
    assert.equal(result.smoke_tests?.[0]?.run_status, "queued");
    assert.equal(result.smoke_tests?.[0]?.effective_model, "openai_codex/gpt-5.4");
    assert.equal(capturedBodies.length, 1);
    assert.equal(capturedBodies[0]?.action_name, "delegate");
    assert.equal((capturedBodies[0]?.turn_context as Record<string, unknown>)?.session_id, issue.sessionId);
    assert.match(String((capturedBodies[0]?.turn_context as Record<string, unknown>)?.input_id ?? ""), /^smoke:demo-app:queue_task:/);
  } finally {
    if (server) {
      await server.close();
    }
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureWorkspaceAppsRunning fails when delegated task smoke tests request a model override", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-app-smoke-failure-"));
  writeRuntimeConfig(root, {
    runtime: {
      default_model: "openai_codex/gpt-5.4",
    },
  });
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  let server: { close: () => Promise<void> } | null = null;

  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    const issue = store.createIssue({
      workspaceId,
      sessionId: "session-app-builder-1",
      title: "Build app",
      description: "Create an app.",
      status: "todo",
      assigneeId: "general",
      createdBy: "workspace_user",
    });
    const service = new RuntimeAgentToolsService(store, {
      workspaceRoot,
      appLifecycle: {
        ensureAppRunning: async (callWorkspaceId, callAppId) => {
          store.upsertAppBuild({
            workspaceId: callWorkspaceId,
            appId: callAppId,
            status: "running",
          });
        },
      },
    });

    await service.scaffoldWorkspaceApp({
      workspaceId,
      sessionId: issue.sessionId,
      appId: "demo-app",
      name: "Demo App",
    });
    fs.writeFileSync(
      path.join(workspaceRoot, workspaceId, "apps", "demo-app", "app.runtime.yaml"),
      `app_id: demo-app
name: Demo App
slug: demo-app
lifecycle:
  setup: npm install
  start: npm run start
healthchecks:
  mcp:
    path: /mcp/health
    timeout_s: 30
    interval_s: 5
mcp:
  transport: http-sse
  port: 13100
  path: /mcp/sse
  tools: []
env_contract:
  - HOLABOSS_WORKSPACE_ID
smoke_tests:
  - name: queue_task
    kind: delegated_task_action
    payload:
      action_name: delegate
      resource_name: report_request
      row_status: ready
      row_data:
        title: Smoke latest news
`,
      "utf8",
    );
    await service.registerWorkspaceApp({
      workspaceId,
      sessionId: issue.sessionId,
      appId: "demo-app",
    });

    const resolved = resolveWorkspaceAppRuntime(
      path.join(workspaceRoot, workspaceId),
      "demo-app",
      {
        store,
        workspaceId,
        allocatePorts: true,
      },
    );
    server = await startStaticHttpServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/__holaboss/actions/run") {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        ok: true,
        created_row: true,
        row: {
          id: "row-1",
          resource: "report_request",
          status: "delegated",
          data: {
            title: "Smoke latest news",
          },
          external_id: "ISS-1",
          error_message: null,
          created_in_turn: "smoke",
          session_id: issue.sessionId,
          created_at: utcNowIso(),
          updated_at: utcNowIso(),
        },
        action: {
          ok: true,
          data: {
            task: {
              task_id: "ISS-1",
              status: "todo",
              latest_run: {
                status: "queued",
                requested_model: "openai/gpt-5",
                effective_model: "openai_codex/gpt-5.4",
                parent_session_id: issue.sessionId,
                parent_input_id: "smoke:demo-app:queue_task:1",
              },
            },
          },
        },
      }));
    }, resolved.ports.http);

    await assert.rejects(
      () =>
        service.ensureWorkspaceAppsRunning({
          workspaceId,
          sessionId: issue.sessionId,
          appIds: ["demo-app"],
        }),
      (error: unknown) =>
        error instanceof RuntimeAgentToolsServiceError &&
        error.statusCode === 409 &&
        error.code === "workspace_app_smoke_test_failed" &&
        /requested_model/i.test(error.message),
    );
  } finally {
    if (server) {
      await server.close();
    }
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureWorkspaceAppsRunning omits pending_integrations for already bound app integrations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-bound-integration-"));
  writeRuntimeConfig(root, {
    runtime: {
      default_model: "openai/gpt-5.4",
    },
  });
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    const connection = store.upsertIntegrationConnection({
      connectionId: "conn-google",
      providerId: "google",
      ownerUserId: "user-1",
      accountLabel: "user@example.com",
      authMode: "oauth_app",
      grantedScopes: ["gmail.send"],
      status: "active",
      secretRef: "token-google",
    });
    store.upsertIntegrationBinding({
      bindingId: "bind-google",
      workspaceId,
      targetType: "app",
      targetId: "gmail-helper",
      integrationKey: "google",
      connectionId: connection.connectionId,
      isDefault: false,
    });
    const service = new RuntimeAgentToolsService(store, {
      workspaceRoot,
      appLifecycle: {
        ensureAppRunning: async (callWorkspaceId, callAppId) => {
          store.upsertAppBuild({
            workspaceId: callWorkspaceId,
            appId: callAppId,
            status: "running",
          });
        },
      },
    });

    await service.scaffoldWorkspaceApp({
      workspaceId,
      appId: "gmail-helper",
      name: "Gmail Helper",
    });
    fs.appendFileSync(
      path.join(workspaceRoot, workspaceId, "apps", "gmail-helper", "app.runtime.yaml"),
      [
        "",
        "integrations:",
        "  - key: primary_google",
        "    provider: google",
        "    capability: gmail",
        "    required: true",
        "    credential_source: platform",
        "",
      ].join("\n"),
      "utf8",
    );
    await service.registerWorkspaceApp({
      workspaceId,
      appId: "gmail-helper",
    });

    const result = (await service.ensureWorkspaceAppsRunning({
      workspaceId,
      appIds: ["gmail-helper"],
    })) as { pending_integrations?: unknown };

    assert.equal(result.pending_integrations, undefined);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureWorkspaceAppsRunning flags requires_session_refresh when a new MCP server appears", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-app-mcp-refresh-"));
  writeRuntimeConfig(root, { runtime: { default_model: "openai/gpt-5.4" } });
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    const workspaceDir = path.join(workspaceRoot, workspaceId);

    const service = new RuntimeAgentToolsService(store, {
      workspaceRoot,
      appLifecycle: {
        ensureAppRunning: async (callWorkspaceId, callAppId) => {
          // Mirror the real ensureAppRunning -> reconcileAppMcpRegistry path so
          // the mcp_registry diff actually reflects the new server entry.
          store.upsertAppBuild({
            workspaceId: callWorkspaceId,
            appId: callAppId,
            status: "running",
          });
          const callWorkspaceDir = path.join(workspaceRoot, callWorkspaceId);
          const resolved = resolveWorkspaceAppRuntime(callWorkspaceDir, callAppId, {
            store,
            workspaceId: callWorkspaceId,
            allocatePorts: true,
          });
          writeWorkspaceMcpRegistryEntry(callWorkspaceDir, callAppId, {
            mcpEnabled: true,
            mcpTools: resolved.resolvedApp.mcpTools,
            mcpPath: resolved.resolvedApp.mcp.path || "/mcp/sse",
            mcpTimeoutMs: 30000,
            mcpPort: resolved.ports.mcp,
            bumpStartedAt: true,
          });
        },
      },
    });

    await service.scaffoldWorkspaceApp({
      workspaceId,
      appId: "demo-app",
      name: "Demo App",
    });
    fs.writeFileSync(
      path.join(workspaceDir, "apps", "demo-app", "app.runtime.yaml"),
      `app_id: demo-app
name: Demo App
slug: demo-app
lifecycle:
  setup: npm install
  start: npm run start
healthchecks:
  mcp:
    path: /mcp/health
    timeout_s: 30
    interval_s: 5
mcp:
  transport: http-sse
  port: 13100
  path: /mcp/sse
  tools:
    - demo_tool
env_contract:
  - HOLABOSS_WORKSPACE_ID
`,
      "utf8",
    );
    await service.registerWorkspaceApp({
      workspaceId,
      appId: "demo-app",
    });

    const firstResult = (await service.ensureWorkspaceAppsRunning({
      workspaceId,
      appIds: ["demo-app"],
    })) as {
      requires_session_refresh?: boolean;
      new_mcp_servers?: string[];
      session_refresh_note?: string;
    };
    assert.equal(firstResult.requires_session_refresh, true);
    assert.deepEqual(firstResult.new_mcp_servers, ["demo-app"]);
    assert.equal(typeof firstResult.session_refresh_note, "string");
    assert.match(firstResult.session_refresh_note ?? "", /next user message/i);

    // Calling again should NOT flag refresh — server already in registry.
    const secondResult = (await service.ensureWorkspaceAppsRunning({
      workspaceId,
      appIds: ["demo-app"],
    })) as {
      requires_session_refresh?: boolean;
      new_mcp_servers?: string[];
    };
    assert.equal(secondResult.requires_session_refresh, undefined);
    assert.equal(secondResult.new_mcp_servers, undefined);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("findWorkspaceApps merges catalog and installed entries with dedup and query filter", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-find-apps-"));
  writeRuntimeConfig(root, { runtime: { default_model: "openai/gpt-5.4" } });
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.upsertAppCatalogEntry({
      appId: "twitter",
      source: "marketplace",
      name: "Twitter",
      description: "Post and read tweets",
      icon: null,
      category: "social",
      tags: ["social"],
      version: "1.0.0",
      archiveUrl: "https://example.com/twitter.tar.gz",
      archivePath: null,
      target: "macos-arm64",
      cachedAt: new Date().toISOString(),
      providerId: "twitter",
      credentialSource: "platform",
    });
    store.upsertAppCatalogEntry({
      appId: "linkedin",
      source: "marketplace",
      name: "LinkedIn",
      description: "Publish LinkedIn posts",
      icon: null,
      category: "social",
      tags: ["social"],
      version: "1.0.0",
      archiveUrl: "https://example.com/linkedin.tar.gz",
      archivePath: null,
      target: "macos-arm64",
      cachedAt: new Date().toISOString(),
      providerId: "linkedin",
      credentialSource: "platform",
    });
    const service = new RuntimeAgentToolsService(store, { workspaceRoot });

    // No installs yet — find should return both candidates, neither installed.
    const allFresh = (await service.findWorkspaceApps({ workspaceId })) as {
      results: Array<{ app_id: string; installed: boolean; source: string }>;
      count: number;
    };
    assert.equal(allFresh.count, 2);
    assert.deepEqual(
      allFresh.results.map((r) => r.app_id).sort(),
      ["linkedin", "twitter"],
    );
    assert.ok(allFresh.results.every((r) => !r.installed));

    // Mark linkedin as installed via direct workspace.yaml mutation.
    const workspaceDir = path.join(workspaceRoot, workspaceId);
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, "workspace.yaml"),
      "applications:\n  - app_id: linkedin\n    config_path: apps/linkedin/app.runtime.yaml\n",
      "utf8",
    );
    const afterInstall = (await service.findWorkspaceApps({ workspaceId })) as {
      results: Array<{ app_id: string; installed: boolean }>;
    };
    const linkedin = afterInstall.results.find((r) => r.app_id === "linkedin");
    const twitter = afterInstall.results.find((r) => r.app_id === "twitter");
    assert.equal(linkedin?.installed, true);
    assert.equal(twitter?.installed, false);

    // Query filter narrows to twitter only.
    const filtered = (await service.findWorkspaceApps({
      workspaceId,
      query: "Tweet",
    })) as { results: Array<{ app_id: string }>; count: number };
    assert.equal(filtered.count, 1);
    assert.equal(filtered.results[0]?.app_id, "twitter");

    // Source=installed only returns linkedin.
    const installedOnly = (await service.findWorkspaceApps({
      workspaceId,
      source: "installed",
    })) as { results: Array<{ app_id: string; source: string }> };
    assert.equal(installedOnly.results.length, 1);
    assert.equal(installedOnly.results[0]?.app_id, "linkedin");
    assert.equal(installedOnly.results[0]?.source, "installed");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("installWorkspaceApp delegates to lifecycle.installFromArchive and flags refresh on new MCP server", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-install-apps-"));
  writeRuntimeConfig(root, { runtime: { default_model: "openai/gpt-5.4" } });
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.upsertAppCatalogEntry({
      appId: "twitter",
      source: "marketplace",
      name: "Twitter",
      description: "Post and read tweets",
      icon: null,
      category: "social",
      tags: ["social"],
      version: "1.0.0",
      archiveUrl: "https://example.com/twitter.tar.gz",
      archivePath: null,
      target: "macos-arm64",
      cachedAt: new Date().toISOString(),
      providerId: "twitter",
      credentialSource: "platform",
    });

    const installCalls: Array<{ workspaceId: string; appId: string; archiveUrl: string | null }> = [];
    const service = new RuntimeAgentToolsService(store, {
      workspaceRoot,
      appLifecycle: {
        installFromArchive: async ({ workspaceId: w, appId, archiveUrl }) => {
          installCalls.push({ workspaceId: w, appId, archiveUrl: archiveUrl ?? null });
          // Simulate the real install: register in workspace.yaml + write
          // mcp_registry entry so the diff detects a new MCP server.
          const wsDir = path.join(workspaceRoot, w);
          fs.mkdirSync(wsDir, { recursive: true });
          fs.writeFileSync(
            path.join(wsDir, "workspace.yaml"),
            `applications:\n  - app_id: ${appId}\n    config_path: apps/${appId}/app.runtime.yaml\n`,
            "utf8",
          );
          writeWorkspaceMcpRegistryEntry(wsDir, appId, {
            mcpEnabled: true,
            mcpTools: ["twitter_create_post"],
            mcpPath: "/mcp/sse",
            mcpTimeoutMs: 30000,
            mcpPort: 13100,
          });
          // Provide a minimal app dir so getWorkspaceAppStatus doesn't crash.
          fs.mkdirSync(path.join(wsDir, "apps", appId), { recursive: true });
          fs.writeFileSync(
            path.join(wsDir, "apps", appId, "app.runtime.yaml"),
            `app_id: ${appId}\nname: Twitter\nslug: twitter\nlifecycle:\n  setup: "true"\n  start: "true"\nhealthchecks:\n  mcp:\n    path: /mcp/health\n    timeout_s: 30\n    interval_s: 5\nmcp:\n  transport: http-sse\n  port: 13100\n  path: /mcp/sse\n  tools:\n    - twitter_create_post\nenv_contract:\n  - HOLABOSS_WORKSPACE_ID\n`,
            "utf8",
          );
          return { ok: true, ready: true, detail: "App installed and running", error: null };
        },
      },
    });

    const result = (await service.installWorkspaceApp({
      workspaceId,
      appId: "twitter",
    })) as {
      app_id: string;
      ready: boolean;
      requires_session_refresh?: boolean;
      new_mcp_servers?: string[];
      provider_id: string | null;
      credential_source: string | null;
    };
    assert.equal(installCalls.length, 1);
    assert.equal(installCalls[0]?.archiveUrl, "https://example.com/twitter.tar.gz");
    assert.equal(result.app_id, "twitter");
    assert.equal(result.ready, true);
    assert.equal(result.requires_session_refresh, true);
    assert.deepEqual(result.new_mcp_servers, ["twitter"]);
    assert.equal(result.provider_id, "twitter");
    assert.equal(result.credential_source, "platform");
    assert.deepEqual(
      ((result as { pending_integrations?: Array<{ provider_id: string; app_id: string }> }).pending_integrations ?? []).map(
        (entry) => entry.provider_id,
      ),
      ["twitter"],
    );
    assert.match(
      (result as { integration_note?: string }).integration_note ?? "",
      /Connect button/i,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("installWorkspaceApp omits pending_integrations when the catalog entry has no provider", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-install-no-provider-"));
  writeRuntimeConfig(root, { runtime: { default_model: "openai/gpt-5.4" } });
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.upsertAppCatalogEntry({
      appId: "csv-tool",
      source: "marketplace",
      name: "CSV Tool",
      description: "Local CSV processor",
      icon: null,
      category: "internal",
      tags: [],
      version: "1.0.0",
      archiveUrl: "https://example.com/csv-tool.tar.gz",
      archivePath: null,
      target: "macos-arm64",
      cachedAt: new Date().toISOString(),
      providerId: null,
      credentialSource: null,
    });

    const service = new RuntimeAgentToolsService(store, {
      workspaceRoot,
      appLifecycle: {
        installFromArchive: async ({ workspaceId: w, appId }) => {
          const wsDir = path.join(workspaceRoot, w);
          fs.mkdirSync(wsDir, { recursive: true });
          fs.writeFileSync(
            path.join(wsDir, "workspace.yaml"),
            `applications:\n  - app_id: ${appId}\n    config_path: apps/${appId}/app.runtime.yaml\n`,
            "utf8",
          );
          fs.mkdirSync(path.join(wsDir, "apps", appId), { recursive: true });
          fs.writeFileSync(
            path.join(wsDir, "apps", appId, "app.runtime.yaml"),
            `app_id: ${appId}\nname: CSV Tool\nslug: csv-tool\nlifecycle:\n  setup: "true"\n  start: "true"\nhealthchecks:\n  mcp:\n    path: /mcp/health\n    timeout_s: 30\n    interval_s: 5\nmcp:\n  transport: http-sse\n  port: 13100\n  path: /mcp/sse\n  tools: []\nenv_contract:\n  - HOLABOSS_WORKSPACE_ID\n`,
            "utf8",
          );
          return { ok: true, ready: true, detail: "ok", error: null };
        },
      },
    });

    const result = (await service.installWorkspaceApp({
      workspaceId,
      appId: "csv-tool",
    })) as {
      pending_integrations?: unknown;
      integration_note?: unknown;
    };
    assert.equal(result.pending_integrations, undefined);
    assert.equal(result.integration_note, undefined);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("installWorkspaceApp throws when app_id is not in the catalog", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-install-missing-"));
  writeRuntimeConfig(root, { runtime: { default_model: "openai/gpt-5.4" } });
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    const service = new RuntimeAgentToolsService(store, {
      workspaceRoot,
      appLifecycle: {
        installFromArchive: async () => ({
          ok: true,
          ready: true,
          detail: "ok",
          error: null,
        }),
      },
    });

    await assert.rejects(
      service.installWorkspaceApp({ workspaceId, appId: "ghost-app" }),
      (error: unknown) => {
        if (!(error instanceof RuntimeAgentToolsServiceError)) {
          return false;
        }
        return error.code === "workspace_app_catalog_entry_not_found";
      },
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("end-to-end: ensure_running result drives harness waiting_user state", async () => {
  // Contract test linking the runtime-agent-tools side and the harness side
  // of the M1 design: ensureWorkspaceAppsRunning emits requires_session_refresh,
  // and noteHarnessWaitingForUserOnToolCompletion observes that flag and flips
  // the runner state. We do not spawn the actual harness subprocess here — the
  // boundary tested is the in-process tool-result -> harness state contract.
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-e2e-refresh-"));
  writeRuntimeConfig(root, { runtime: { default_model: "openai/gpt-5.4" } });
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });

  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    const service = new RuntimeAgentToolsService(store, {
      workspaceRoot,
      appLifecycle: {
        ensureAppRunning: async (callWorkspaceId, callAppId) => {
          store.upsertAppBuild({
            workspaceId: callWorkspaceId,
            appId: callAppId,
            status: "running",
          });
          const callWorkspaceDir = path.join(workspaceRoot, callWorkspaceId);
          const resolved = resolveWorkspaceAppRuntime(callWorkspaceDir, callAppId, {
            store,
            workspaceId: callWorkspaceId,
            allocatePorts: true,
          });
          writeWorkspaceMcpRegistryEntry(callWorkspaceDir, callAppId, {
            mcpEnabled: true,
            mcpTools: resolved.resolvedApp.mcpTools,
            mcpPath: resolved.resolvedApp.mcp.path || "/mcp/sse",
            mcpTimeoutMs: 30000,
            mcpPort: resolved.ports.mcp,
            bumpStartedAt: true,
          });
        },
      },
    });

    await service.scaffoldWorkspaceApp({
      workspaceId,
      appId: "demo-app",
      name: "Demo App",
    });
    fs.writeFileSync(
      path.join(workspaceRoot, workspaceId, "apps", "demo-app", "app.runtime.yaml"),
      `app_id: demo-app
name: Demo App
slug: demo-app
lifecycle:
  setup: npm install
  start: npm run start
healthchecks:
  mcp:
    path: /mcp/health
    timeout_s: 30
    interval_s: 5
mcp:
  transport: http-sse
  port: 13100
  path: /mcp/sse
  tools:
    - demo_tool
env_contract:
  - HOLABOSS_WORKSPACE_ID
`,
      "utf8",
    );
    await service.registerWorkspaceApp({
      workspaceId,
      appId: "demo-app",
    });

    const result = await service.ensureWorkspaceAppsRunning({
      workspaceId,
      appIds: ["demo-app"],
    });

    // Now feed the tool result through the harness boundary helper.
    const state = { waitingForUser: false };
    noteHarnessWaitingForUserOnToolCompletion({
      toolName: "workspace_apps_ensure_running",
      isError: false,
      state,
      result,
    });
    assert.equal(state.waitingForUser, true);

    // Subsequent ensure_running call (no new server) should NOT flip state.
    const secondResult = await service.ensureWorkspaceAppsRunning({
      workspaceId,
      appIds: ["demo-app"],
    });
    const secondState = { waitingForUser: false };
    noteHarnessWaitingForUserOnToolCompletion({
      toolName: "workspace_apps_ensure_running",
      isError: false,
      state: secondState,
      result: secondResult,
    });
    assert.equal(secondState.waitingForUser, false);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureWorkspaceAppsRunning queues post-build polish onto the same App Builder child session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-polish-subagent-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const mainSessionId = "main-1";
  const childSessionId = "subagent-app-builder-1";

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    store.ensureSession({
      workspaceId,
      sessionId: mainSessionId,
      kind: "main_session",
      createdBy: "workspace_user",
    });
    store.ensureSession({
      workspaceId,
      sessionId: childSessionId,
      kind: "subagent",
      parentSessionId: mainSessionId,
      createdBy: "workspace_agent",
    });
    store.createSubagentRun({
      workspaceId,
      parentSessionId: mainSessionId,
      parentInputId: "parent-input-1",
      originMainSessionId: mainSessionId,
      ownerMainSessionId: mainSessionId,
      childSessionId,
      title: "Build demo-app",
      goal: "Build demo-app",
      sourceType: "issue",
      status: "running",
    });

    const service = new RuntimeAgentToolsService(store, {
      workspaceRoot,
      appLifecycle: {
        ensureAppRunning: async () => {},
      },
    });

    await service.scaffoldWorkspaceApp({
      workspaceId,
      appId: "demo-app",
      name: "Demo App",
    });
    fs.mkdirSync(
      path.join(workspaceRoot, workspaceId, "apps", "demo-app", "src", "client"),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(workspaceRoot, workspaceId, "apps", "demo-app", "src", "client", "index.tsx"),
      [
        'import "@holaboss/ui/styles.css";',
        'import "./app.css";',
        'import { Button, Card, CardContent } from "@holaboss/ui";',
        "",
        "export default function DemoApp() {",
        "  return (",
        "    <Card>",
        "      <CardContent>",
        '        <Button type=\"button\">Launch</Button>',
        "      </CardContent>",
        "    </Card>",
        "  );",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(workspaceRoot, workspaceId, "apps", "demo-app", "src", "client", "app.css"),
      ['@import "tailwindcss";', '@source "../client";', ""].join("\n"),
      "utf8",
    );
    await service.registerWorkspaceApp({
      workspaceId,
      appId: "demo-app",
    });

    const result = await service.ensureWorkspaceAppsRunning({
      workspaceId,
      appIds: ["demo-app"],
      sessionId: childSessionId,
    }) as {
      polish_pass_queued?: Array<{ app_id: string; input_id: string; session_id: string }>;
    };

    assert.equal(result.polish_pass_queued?.length, 1);
    assert.equal(result.polish_pass_queued?.[0]?.session_id, childSessionId);
    const polishInput = store.getInput({
      workspaceId,
      inputId: String(result.polish_pass_queued?.[0]?.input_id ?? ""),
    });
    const context =
      polishInput?.payload.context &&
      typeof polishInput.payload.context === "object" &&
      !Array.isArray(polishInput.payload.context)
        ? (polishInput.payload.context as Record<string, unknown>)
        : null;
    assert.equal(polishInput?.sessionId, childSessionId);
    assert.equal(context?.source_type, "post_build_polish_pass");
    assert.equal(context?.continue_subagent_run, true);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("probeWorkspaceAppEndpoints checks managed UI and MCP surfaces deterministically", async () => {
  await harness.service.scaffoldWorkspaceApp({
    workspaceId: harness.workspaceId,
    appId: "demo-app",
    name: "Demo App",
  });
  fs.writeFileSync(
    path.join(harness.workspaceDir, "apps", "demo-app", "app.runtime.yaml"),
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
  await harness.service.registerWorkspaceApp({
    workspaceId: harness.workspaceId,
    appId: "demo-app",
  });

  const status = harness.service.getWorkspaceAppStatus({
    workspaceId: harness.workspaceId,
    appId: "demo-app",
  }) as { ports: { http: number; mcp: number } | null };
  assert.ok(status.ports);

  const uiServer = await startStaticHttpServer((request, response) => {
    if (request.url === "/") {
      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<html><body>demo app</body></html>");
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
  }, status.ports!.http);

  const mcpServer = await startStaticHttpServer((request, response) => {
    if (request.method === "POST" && request.url === "/transport/messages") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          id?: string | number | null;
          method?: string;
        };
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        if (body.method === "initialize") {
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? null,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: {
                  tools: { listChanged: false },
                },
                serverInfo: {
                  name: "demo-app",
                  version: "0.1.0",
                },
              },
            }),
          );
          return;
        }
        if (body.method === "tools/list") {
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id ?? null,
              result: {
                tools: [{ name: "demo_tool" }],
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
  }, status.ports!.mcp);

  try {
    const probed = await harness.service.probeWorkspaceAppEndpoints({
      workspaceId: harness.workspaceId,
      appId: "demo-app",
    }) as {
      all_ok: boolean;
      count: number;
      checks: Array<{ check: string; ok: boolean; tool_count?: number | null; url?: string }>;
    };

    assert.equal(probed.all_ok, true);
    assert.equal(probed.count, 4);
    assert.deepEqual(
      probed.checks.map((entry) => entry.check),
      ["ui", "mcp_health", "mcp_initialize", "mcp_tools_list"],
    );
    assert.ok(probed.checks.every((entry) => entry.ok === true));
    assert.equal(
      probed.checks.find((entry) => entry.check === "mcp_tools_list")?.tool_count,
      1,
    );
    assert.equal(
      probed.checks.find((entry) => entry.check === "mcp_health")?.url,
      `http://127.0.0.1:${status.ports!.http}/ready`,
    );
    assert.equal(
      probed.checks.find((entry) => entry.check === "mcp_initialize")?.url,
      `http://127.0.0.1:${status.ports!.mcp}/transport/messages`,
    );
  } finally {
    await uiServer.close();
    await mcpServer.close();
  }
});

test("updateWorkspaceInstructions appends a managed AGENTS.md rule without disturbing user-authored content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-agents-append-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const workspaceDir = path.join(workspaceRoot, workspaceId);

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, "AGENTS.md"),
      "# Workspace Rules\n\nUser-authored intro.\n",
      "utf8",
    );

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const result = await service.updateWorkspaceInstructions({
      workspaceId,
      op: "append_rule",
      rule: "Always start with a short summary.",
    }) as {
      changed: boolean;
      managed_rules: string[];
      full_text: string;
    };

    assert.equal(result.changed, true);
    assert.deepEqual(result.managed_rules, [
      "Always start with a short summary.",
    ]);
    assert.match(result.full_text, /# Workspace Rules/);
    assert.match(result.full_text, /User-authored intro\./);
    assert.match(
      result.full_text,
      /<!-- holaboss-managed-workspace-instructions:start -->/,
    );
    assert.match(
      result.full_text,
      /- Always start with a short summary\./,
    );

    const duplicate = await service.updateWorkspaceInstructions({
      workspaceId,
      op: "append_rule",
      rule: "Always start with a short summary.",
    }) as {
      changed: boolean;
      managed_rules: string[];
    };
    assert.equal(duplicate.changed, false);
    assert.deepEqual(duplicate.managed_rules, [
      "Always start with a short summary.",
    ]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("updateWorkspaceInstructions replaces and clears the managed AGENTS.md section while preserving user-authored content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-agents-replace-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const workspaceDir = path.join(workspaceRoot, workspaceId);

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    seedWorkspaceRecord(store, {
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, "AGENTS.md"),
      "# Workspace Rules\n\nUser-authored intro.\n",
      "utf8",
    );

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const replaced = await service.updateWorkspaceInstructions({
      workspaceId,
      op: "replace_managed_section",
      content: [
        "### Reply Template",
        "",
        "1. Summary",
        "2. Changes",
        "3. Risks",
      ].join("\n"),
    }) as {
      changed: boolean;
      managed_section_present: boolean;
      managed_section_content: string;
      full_text: string;
    };

    assert.equal(replaced.changed, true);
    assert.equal(replaced.managed_section_present, true);
    assert.match(
      replaced.managed_section_content,
      /### Reply Template/,
    );
    assert.match(replaced.full_text, /User-authored intro\./);
    assert.match(replaced.full_text, /1\. Summary/);

    const cleared = await service.updateWorkspaceInstructions({
      workspaceId,
      op: "replace_managed_section",
      content: "",
    }) as {
      changed: boolean;
      managed_section_present: boolean;
      full_text: string;
    };

    assert.equal(cleared.changed, true);
    assert.equal(cleared.managed_section_present, false);
    assert.match(cleared.full_text, /User-authored intro\./);
    assert.doesNotMatch(
      cleared.full_text,
      /holaboss-managed-workspace-instructions/,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("installCapability tool installs a workspace-authored capability", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-cap-tool-"));
  writeRuntimeConfig(root, { runtime: { default_model: "openai/gpt-5.4" } });
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({ dbPath: path.join(root, "runtime.db"), workspaceRoot });
  try {
    const workspaceId = "workspace-1";
    seedWorkspaceRecord(store, { workspaceId, name: "WS", harness: "pi", status: "active" });
    const capDir = path.join(store.workspaceDir(workspaceId), "capabilities", "demo-cap");
    fs.mkdirSync(capDir, { recursive: true });
    fs.writeFileSync(path.join(capDir, "capability.yaml"),
      "id: demo-cap\nname: Demo\ndescription: d\nversion: 0.1.0\nskills:\n  - ref: demo-skill\nintegrations: []\n", "utf8");

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const result = service.installCapability({ workspaceId, capabilityId: "demo-cap" }) as Record<string, unknown>;

    assert.ok(result.record);
    assert.equal(store.getWorkspaceCapability({ workspaceId, capabilityId: "demo-cap" })?.name, "Demo");
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

