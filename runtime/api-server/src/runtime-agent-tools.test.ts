import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

import Database from "better-sqlite3";
import { load as parseYaml } from "js-yaml";

import { RuntimeStateStore, utcNowIso } from "@holaboss/runtime-state-store";

import {
  ONBOARDING_IMPLEMENTING_STATE,
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
    store.createWorkspace({
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
    const assignee = store.ensureGeneralTeammate(workspaceId);
    store.createIssue({
      workspaceId,
      issueId: "HOL-1",
      sessionId: childSessionId,
      title: "Web search for AI",
      description: "Search the web for AI.",
      status: "done",
      assigneeTeammateId: assignee.teammateId,
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
      teammateId: assignee.teammateId,
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
    store.createWorkspace({
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
    store.createWorkspace({
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
    store.createWorkspace({
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
    const assignee = store.ensureGeneralTeammate(workspaceId);
    store.createIssue({
      workspaceId,
      issueId: "HOL-1",
      sessionId: "subagent-1",
      title: "Todo task",
      description: "Finish the todo task.",
      status: "todo",
      assigneeTeammateId: assignee.teammateId,
      latestSubagentId: "run-1",
    });
    store.createIssue({
      workspaceId,
      issueId: "HOL-2",
      sessionId: "subagent-2",
      title: "Blocked task",
      description: "Finish the blocked task.",
      status: "blocked",
      assigneeTeammateId: assignee.teammateId,
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
      teammateId: assignee.teammateId,
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
    store.createWorkspace({
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
    const assignee = store.ensureGeneralTeammate(workspaceId);
    store.createIssue({
      workspaceId,
      issueId: "HOL-1",
      sessionId: childSessionId,
      title: "Crypto research",
      description: "Research crypto news.",
      status: "done",
      assigneeTeammateId: assignee.teammateId,
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
      payload: { text: "Research crypto news." },
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
      teammateId: assignee.teammateId,
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
      taskId: "HOL-1",
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
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("delegateTask creates issue-owned runs for an explicitly assigned teammate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-delegate-issue-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const mainSessionId = "main-1";

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    store.createWorkspace({
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
    const teammate = store.createTeammate({
      workspaceId,
      name: "Frontend",
      instructions: "Own dashboard, UI, frontend, and React implementation work.",
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
          teammateId: teammate.teammateId,
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
    assert.equal(delegatedTask?.teammate_id, teammate.teammateId);
    assert.equal(delegatedTask?.subagent_id, undefined);
    const issue = store.getIssue({
      workspaceId,
      issueId: String(delegatedTask?.issue_id),
    });
    assert.ok(issue);
    assert.equal(issue?.status, "todo");
    assert.equal(issue?.assigneeTeammateId, teammate.teammateId);
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
      (delegatedInput?.payload.context as Record<string, unknown> | undefined)?.teammate_id,
      teammate.teammateId,
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

test("delegateTask requires an explicit teammate id", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-delegate-teammate-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const mainSessionId = "main-1";

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    store.createWorkspace({
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
    assert.throws(
      () =>
        service.delegateTask({
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
        }),
      (error: unknown) =>
        error instanceof RuntimeAgentToolsServiceError &&
        error.statusCode === 400 &&
        error.message === "teammate_id is required for delegated tasks",
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("delegateTask forbids workspace onboarding sessions from spawning subagents before implementing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-onboarding-direct-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const onboardingSessionId = "workspace-onboarding-1";

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    store.createWorkspace({
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
      onboardingStatus: "pending",
      onboardingSessionId,
    });
    store.ensureSession({
      workspaceId,
      sessionId: onboardingSessionId,
      kind: "workspace_onboarding",
      createdBy: "workspace_user",
    });
    const general = store.ensureGeneralTeammate(workspaceId);
    const parentInput = store.enqueueInput({
      workspaceId,
      sessionId: onboardingSessionId,
      payload: {
        text: "Build the approved workspace design.",
      },
    });

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    assert.throws(
      () =>
        service.delegateTask({
          workspaceId,
          sessionId: onboardingSessionId,
          inputId: parentInput.inputId,
          tasks: [
            {
              teammateId: general.teammateId,
              goal: "Build the approved workspace design.",
            },
          ],
        }),
      (error: unknown) =>
        error instanceof RuntimeAgentToolsServiceError &&
        error.statusCode === 403 &&
        error.code === "onboarding_delegation_forbidden" &&
        error.message === "workspace onboarding can delegate tasks only during implementing",
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("delegateTask allows workspace onboarding sessions to spawn subagents during implementing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-onboarding-implementing-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const onboardingSessionId = "workspace-onboarding-1";

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    store.createWorkspace({
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
      onboardingStatus: "pending",
      onboardingState: ONBOARDING_IMPLEMENTING_STATE,
      onboardingSessionId,
    });
    store.ensureSession({
      workspaceId,
      sessionId: onboardingSessionId,
      kind: "workspace_onboarding",
      createdBy: "workspace_user",
    });
    const general = store.ensureGeneralTeammate(workspaceId);
    const parentInput = store.enqueueInput({
      workspaceId,
      sessionId: onboardingSessionId,
      payload: {
        text: "Implement the approved workspace design.",
      },
    });

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const result = service.delegateTask({
      workspaceId,
      sessionId: onboardingSessionId,
      inputId: parentInput.inputId,
      tasks: [
        {
          teammateId: general.teammateId,
          title: "Workspace implementation",
          goal: "Implement the approved workspace design.",
          context: "Create the generic workspace structure and supporting files.",
        },
      ],
    }) as { tasks?: Array<Record<string, unknown>> };

    const delegatedTask = result.tasks?.[0];
    assert.ok(delegatedTask);
    assert.equal(delegatedTask?.task_id, "WOR-1");
    assert.equal(delegatedTask?.teammate_id, general.teammateId);
    const issue = store.getIssue({
      workspaceId,
      issueId: String(delegatedTask?.issue_id ?? ""),
    });
    assert.ok(issue);
    assert.equal(issue?.assigneeTeammateId, general.teammateId);
    assert.equal(delegatedTask?.child_session_id, issue?.sessionId);
    const issueSession = store.getSession({
      workspaceId,
      sessionId: String(delegatedTask?.child_session_id ?? ""),
    });
    assert.equal(issueSession?.parentSessionId, onboardingSessionId);
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
    store.createWorkspace({
      workspaceId,
      name: "Workspace",
      harness: "pi",
      status: "active",
    });
    const teammate = store.createTeammate({
      workspaceId,
      name: "Coder",
      instructions: "Own implementation tasks.",
    });
    const issue = store.createIssue({
      workspaceId,
      sessionId: "session-issue-1",
      title: "Ship dashboard",
      description: "Implement the workspace dashboard surface.",
      status: "done",
      assigneeTeammateId: teammate.teammateId,
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
      teammateId: teammate.teammateId,
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
    assert.equal(
      (result.input.payload.context as Record<string, unknown>)?.teammate_id,
      teammate.teammateId,
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
    store.createWorkspace({
      workspaceId,
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    const teammate = store.ensureGeneralTeammate(workspaceId);
    const issue = store.createIssue({
      workspaceId,
      issueId: "HOL-1",
      sessionId: "session-issue-1",
      title: "Ship dashboard",
      description: "Implement the workspace dashboard surface.",
      status: "done",
      assigneeTeammateId: teammate.teammateId,
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
      teammateId: teammate.teammateId,
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

test("delegateTask only opts into the user browser surface when the parent input literally says use my browser", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-delegate-browser-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const mainSessionId = "main-1";

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    store.createWorkspace({
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
    const explicitParentInput = store.enqueueInput({
      workspaceId,
      sessionId: mainSessionId,
      payload: {
        text: "Use my browser to open Notion and stop there.",
      },
    });
    const implicitParentInput = store.enqueueInput({
      workspaceId,
      sessionId: mainSessionId,
      payload: {
        text: "Open Notion in my current tab.",
      },
    });
    const general = store.ensureGeneralTeammate(workspaceId);

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const explicitResult = service.delegateTask({
      workspaceId,
      sessionId: mainSessionId,
      inputId: explicitParentInput.inputId,
      tasks: [
        {
          teammateId: general.teammateId,
          goal: "Open Notion and stop there.",
          useUserBrowserSurface: true,
        },
      ],
    }) as { tasks?: Array<Record<string, unknown>> };
    const implicitResult = service.delegateTask({
      workspaceId,
      sessionId: mainSessionId,
      inputId: implicitParentInput.inputId,
      tasks: [
        {
          teammateId: general.teammateId,
          goal: "Open Notion and stop there.",
          useUserBrowserSurface: true,
        },
      ],
    }) as { tasks?: Array<Record<string, unknown>> };

    const explicitInput = store.getInput({
      workspaceId,
      inputId: String(explicitResult.tasks?.[0]?.latest_child_input_id ?? ""),
    });
    const implicitInput = store.getInput({
      workspaceId,
      inputId: String(implicitResult.tasks?.[0]?.latest_child_input_id ?? ""),
    });

    assert.equal(
      (explicitInput?.payload.context as Record<string, unknown> | undefined)
        ?.use_user_browser_surface,
      true,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        (implicitInput?.payload.context as Record<string, unknown> | undefined) ?? {},
        "use_user_browser_surface",
      ),
      false,
    );
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
    store.createWorkspace({
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
    const general = store.ensureGeneralTeammate(workspaceId);
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
          teammateId: general.teammateId,
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

test("continueSubagent preserves the user browser surface flag for follow-up work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-continue-browser-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const mainSessionId = "main-1";
  const childSessionId = "subagent-child-1";
  const subagentId = "subagent-run-1";
  const completedAt = utcNowIso();

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    store.createWorkspace({
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
    const firstInput = store.enqueueInput({
      workspaceId,
      sessionId: childSessionId,
      payload: {
        text: "Open Notion in the current tab.",
        context: {
          source: "subagent",
          use_user_browser_surface: true,
        },
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
      assistantText: "Reached the login page.",
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
      title: "Open Notion",
      goal: "Open Notion in the user's current browser tab.",
      sourceType: "delegate_task",
      status: "completed",
      summary: "Reached login.",
      resultPayload: { summary: "Reached the login page." },
      completedAt,
    });

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const result = service.continueSubagent({
      workspaceId,
      sessionId: mainSessionId,
      inputId: "parent-input-2",
      subagentId,
      instruction: "Try again now that the page is ready.",
    }) as Record<string, unknown>;

    const nextInput = store.getInput({ workspaceId, inputId: String(result.latest_child_input_id) });
    assert.equal(
      (nextInput?.payload.context as Record<string, unknown> | undefined)
        ?.use_user_browser_surface,
      true,
    );
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
    store.createWorkspace({
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
    const assignee = store.ensureGeneralTeammate(workspaceId);
    store.createIssue({
      workspaceId,
      issueId: "HOL-1",
      sessionId: childSessionId,
      title: "Check account stats",
      description: "Inspect the account stats in the browser.",
      status: "todo",
      assigneeTeammateId: assignee.teammateId,
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
      teammateId: assignee.teammateId,
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

test("resumeSubagent preserves the user browser surface flag while waiting on user access", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-resume-browser-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const mainSessionId = "main-1";
  const childSessionId = "subagent-child-1";
  const subagentId = "subagent-run-1";
  const blockedAt = utcNowIso();

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    store.createWorkspace({
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
    const blockedInput = store.enqueueInput({
      workspaceId,
      sessionId: childSessionId,
      payload: {
        text: "Check the latest X post stats in my current browser tab.",
        context: {
          source: "subagent",
          use_user_browser_surface: true,
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
    assert.equal(
      (resumedInput?.payload.context as Record<string, unknown> | undefined)
        ?.use_user_browser_surface,
      true,
    );
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
    store.createWorkspace({
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
    const assignee = store.ensureGeneralTeammate(workspaceId);
    store.createIssue({
      workspaceId,
      issueId: "HOL-1",
      sessionId: childSessionId,
      title: "Latest news on agent harnesses",
      description: "Research the latest news on agent harnesses.",
      status: "in_progress",
      assigneeTeammateId: assignee.teammateId,
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
          use_user_browser_surface: true,
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
    store.createWorkspace({
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
          use_user_browser_surface: true,
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
    store.createWorkspace({
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
    const assignee = store.ensureGeneralTeammate(workspaceId);
    store.createIssue({
      workspaceId,
      issueId: "HOL-1",
      sessionId: childSessionId,
      title: "Summarize the workspace state",
      description: "Finish the delegated summary.",
      status: "in_progress",
      assigneeTeammateId: assignee.teammateId,
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
      teammateId: assignee.teammateId,
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
    store.createWorkspace({
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
    const assignee = store.ensureGeneralTeammate(workspaceId);
    store.createIssue({
      workspaceId,
      issueId: "HOL-1",
      sessionId: childSessionId,
      title: "Summarize the China news",
      description: "Finish the delegated summary.",
      status: "in_progress",
      assigneeTeammateId: assignee.teammateId,
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
      teammateId: assignee.teammateId,
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
    store.createWorkspace({
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
    const assignee = store.ensureGeneralTeammate(workspaceId);
    store.createIssue({
      workspaceId,
      issueId: "HOL-1",
      sessionId: childSessionId,
      title: "Latest news on agent harnesses",
      description: "Research the latest news on agent harnesses.",
      status: "in_progress",
      assigneeTeammateId: assignee.teammateId,
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
      teammateId: assignee.teammateId,
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
  dataDbPath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-runtime-tools-"));
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const workspaceDir = path.join(workspaceRoot, workspace.id);
  fs.mkdirSync(path.join(workspaceDir, ".holaboss"), { recursive: true });
  const dataDbPath = path.join(workspaceDir, ".holaboss", "data.db");

  const service = new RuntimeAgentToolsService(store, { workspaceRoot });
  return {
    service,
    workspaceId: workspace.id,
    workspaceDir,
    dataDbPath,
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
    store.createWorkspace({
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

test("invokeSkill resolves teammate-local skills for an assigned issue session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-skill-teammate-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    const workspace = store.createWorkspace({
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    const teammate = store.createTeammate({
      workspaceId: workspace.id,
      name: "Frontend",
      instructions: "Own the UI.",
    });
    const issue = store.createIssue({
      workspaceId: workspace.id,
      sessionId: "session-issue-1",
      title: "Ship dashboard",
      description: "Implement the dashboard.",
      status: "todo",
      assigneeTeammateId: teammate.teammateId,
      createdBy: "workspace_user",
    });
    const skillDir = path.join(
      store.workspaceDir(workspace.id),
      "teammates",
      teammate.teammateId,
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

test("createTeammate persists teammate metadata without bundling filesystem skills", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-create-teammate-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    const workspace = store.createWorkspace({
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    const hr = store.ensureHrTeammate(workspace.id);
    const hrIssue = store.createIssue({
      workspaceId: workspace.id,
      sessionId: "session-hr-1",
      title: "Create teammate",
      description: "Bootstrap a teammate.",
      status: "todo",
      assigneeTeammateId: hr.teammateId,
      createdBy: "workspace_user",
    });

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const result = service.createTeammate({
      workspaceId: workspace.id,
      sessionId: hrIssue.sessionId,
      name: "Researcher",
      instructions: "Own research work.",
      capabilityProfile: {
        summary: "Best for research and synthesis.",
        capabilities: ["research", "synthesis"],
      },
    }) as {
      name: string;
      teammate_id: string;
      capability_profile: {
        summary: string | null;
        capabilities: string[];
      };
      skills: Array<unknown>;
    };

    assert.equal(result.name, "Researcher");
    assert.equal(result.skills.length, 0);
    assert.equal(
      result.capability_profile.summary,
      "Best for research and synthesis.",
    );
    assert.deepEqual(result.capability_profile.capabilities, [
      "research",
      "synthesis",
    ]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("listTeammates returns the live current roster for HR sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-list-teammates-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    const workspace = store.createWorkspace({
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    const hr = store.ensureHrTeammate(workspace.id);
    const hrIssue = store.createIssue({
      workspaceId: workspace.id,
      sessionId: "session-hr-1",
      title: "Inspect teammate roster",
      description: "Inspect the current roster before teammate bootstrap.",
      status: "todo",
      assigneeTeammateId: hr.teammateId,
      createdBy: "workspace_user",
    });
    store.createTeammate({
      workspaceId: workspace.id,
      teammateId: "researcher",
      name: "Researcher",
      instructions: "Own research work.",
    });

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const result = service.listTeammates({
      workspaceId: workspace.id,
      sessionId: hrIssue.sessionId,
      limit: 10,
    }) as {
      tool_id: string;
      count: number;
      teammates: Array<{ teammate_id: string }>;
    };

    assert.equal(result.tool_id, "teammates_list");
    assert.equal(result.count, 4);
    assert.deepEqual(
      result.teammates.map((teammate) => teammate.teammate_id),
      ["general", "hr", "app_builder", "researcher"],
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("createTeammateSkill persists one teammate-local filesystem skill bundle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-create-teammate-skill-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    const workspace = store.createWorkspace({
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    const hr = store.ensureHrTeammate(workspace.id);
    const hrIssue = store.createIssue({
      workspaceId: workspace.id,
      sessionId: "session-hr-1",
      title: "Create teammate skill",
      description: "Bootstrap a teammate skill.",
      status: "todo",
      assigneeTeammateId: hr.teammateId,
      createdBy: "workspace_user",
    });
    const teammate = store.createTeammate({
      workspaceId: workspace.id,
      name: "Researcher",
      instructions: "Own research work.",
    });

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const result = service.createTeammateSkill({
      workspaceId: workspace.id,
      sessionId: hrIssue.sessionId,
      teammateId: teammate.teammateId,
      skill: {
        skillId: "research-playbook",
        skillMarkdown: [
          "---",
          "name: research-playbook",
          "description: Research Playbook",
          "holaboss:",
          "  granted_tools: [web_search, browser]",
          "  granted_commands: [open-sources]",
          "---",
          "",
          "# Research Playbook",
          "",
          "Always cite sources.",
        ].join("\n"),
        sidecarFiles: [
          {
            path: "scripts/fetch.sh",
            content: "#!/bin/sh\ncurl \"$1\"\n",
          },
        ],
        directories: ["assets/templates"],
      },
    }) as {
      teammate_id: string;
      workspace_id: string;
      tool_id: string;
      skill: {
        skill_id: string;
        storage_origin: string;
        file_path: string | null;
        granted_tools: string[];
        granted_commands: string[];
        sidecar_files: Array<{ path: string }>;
        sidecar_directories: string[];
      };
    };

    assert.equal(result.tool_id, "teammate_skills_create");
    assert.equal(result.teammate_id, teammate.teammateId);
    assert.equal(result.skill.skill_id, "research-playbook");
    assert.equal(result.skill.storage_origin, "filesystem");
    assert.deepEqual(result.skill.granted_tools, ["web_search", "browser"]);
    assert.deepEqual(result.skill.granted_commands, ["open-sources"]);
    assert.equal(result.skill.sidecar_files[0]?.path, "scripts/fetch.sh");
    assert.equal(
      result.skill.sidecar_directories.includes("assets/templates"),
      true,
    );
    assert.equal(fs.existsSync(String(result.skill.file_path ?? "")), true);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace app runtime tools are reserved for App Builder subagent sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-app-builder-guard-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    const workspace = store.createWorkspace({
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    const general = store.ensureGeneralTeammate(workspace.id);
    const appBuilder = store.ensureAppBuilderTeammate(workspace.id);
    const generalIssue = store.createIssue({
      workspaceId: workspace.id,
      sessionId: "session-general-1",
      title: "Build an app",
      description: "Create a new dashboard app.",
      status: "todo",
      assigneeTeammateId: general.teammateId,
      createdBy: "workspace_user",
    });
    const appBuilderIssue = store.createIssue({
      workspaceId: workspace.id,
      sessionId: "session-app-builder-1",
      title: "Build an app",
      description: "Create a new dashboard app.",
      status: "todo",
      assigneeTeammateId: appBuilder.teammateId,
      createdBy: "workspace_user",
    });

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    await assert.rejects(
      () =>
        service.scaffoldWorkspaceApp({
          workspaceId: workspace.id,
          sessionId: generalIssue.sessionId,
          appId: "demo-app",
          name: "Demo App",
        }),
      (error: unknown) =>
        error instanceof RuntimeAgentToolsServiceError &&
        error.statusCode === 403 &&
        error.code === "app_builder_teammate_required" &&
        error.message === "workspace_apps_scaffold is only available to the App Builder teammate",
    );

    const result = await service.scaffoldWorkspaceApp({
      workspaceId: workspace.id,
      sessionId: appBuilderIssue.sessionId,
      appId: "demo-app",
      name: "Demo App",
    });

    assert.equal(result.app_id, "demo-app");
    assert.equal(result.app_dir, "apps/demo-app");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

function seedTwitterPosts(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE twitter_posts (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      campaign_key TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_twitter_posts_status ON twitter_posts(status);
  `);
  const insert = db.prepare(
    "INSERT INTO twitter_posts (id, content, campaign_key, status, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  insert.run("p1", "First draft", "launch-a", "draft", "2026-04-28T00:00:00Z");
  insert.run("p2", "Second draft", "launch-a", "draft", "2026-04-28T00:00:01Z");
  insert.run("p3", "Published one", "launch-b", "published", "2026-04-28T00:00:02Z");
  db.close();
}

function seedCampaignPlans(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE campaign_plans (
      campaign_key TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      owner TEXT NOT NULL
    );
  `);
  const insert = db.prepare(
    "INSERT INTO campaign_plans (campaign_key, channel, owner) VALUES (?, ?, ?)",
  );
  insert.run("launch-a", "twitter", "alice");
  insert.run("launch-b", "twitter", "bob");
  db.close();
}

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

test("listIntegrationCatalog exposes canonical provider ids for app builders", () => {
  const catalog = harness.service.listIntegrationCatalog({
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
    store.createWorkspace({
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
    store.createWorkspace({
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
    store.createWorkspace({
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
    store.createWorkspace({
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
    store.createWorkspace({
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
    store.createWorkspace({
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
    store.createWorkspace({
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
    store.createWorkspace({
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

test("listDataTables auto-creates data.db on first read; returns empty list when no app has written", () => {
  const result = harness.service.listDataTables({ workspaceId: harness.workspaceId });
  // data.db is now a workspace-level resource owned by the runtime, so
  // it's materialized on demand instead of returning a "doesn't exist"
  // error. The _workspace_meta anchor row is runtime-internal (hidden).
  assert.deepEqual(result.tables, []);
  assert.equal(result.count, 0);
});

test("listDataTables introspects tables, columns, and row counts", () => {
  seedTwitterPosts(harness.dataDbPath);
  const result = harness.service.listDataTables({ workspaceId: harness.workspaceId });
  const tables = result.tables as Array<{
    name: string;
    columns: Array<{ name: string; type: string }>;
    row_count: number;
  }>;
  assert.equal(tables.length, 1);
  const posts = tables[0];
  assert.equal(posts.name, "twitter_posts");
  assert.equal(posts.row_count, 3);
  const colNames = posts.columns.map((c) => c.name);
  assert.deepEqual(colNames.slice(0, 5), ["id", "content", "campaign_key", "status", "created_at"]);
});

test("describeDataTable and sampleDataTableRows inspect shared workspace data deterministically", () => {
  seedTwitterPosts(harness.dataDbPath);

  const description = harness.service.describeDataTable({
    workspaceId: harness.workspaceId,
    tableName: "twitter_posts",
  }) as {
    table_name: string;
    row_count: number;
    columns: Array<{ name: string }>;
  };

  assert.equal(description.table_name, "twitter_posts");
  assert.equal(description.row_count, 3);
  assert.deepEqual(
    description.columns.map((column) => column.name).slice(0, 5),
    ["id", "content", "campaign_key", "status", "created_at"],
  );

  const sample = harness.service.sampleDataTableRows({
    workspaceId: harness.workspaceId,
    tableName: "twitter_posts",
    limit: 2,
  }) as {
    row_count: number;
    rows: Array<{ id: string; status: string }>;
  };

  assert.equal(sample.row_count, 2);
  assert.deepEqual(sample.rows.map((row) => row.id), ["p1", "p2"]);
  assert.deepEqual(sample.rows.map((row) => row.status), ["draft", "draft"]);
});

test("queryWorkspaceData previews mixed-source joins deterministically", () => {
  seedTwitterPosts(harness.dataDbPath);
  seedCampaignPlans(harness.dataDbPath);

  const result = harness.service.queryWorkspaceData({
    workspaceId: harness.workspaceId,
    query: `
      SELECT
        plans.owner,
        COUNT(*) AS post_count
      FROM twitter_posts AS posts
      JOIN campaign_plans AS plans
        ON plans.campaign_key = posts.campaign_key
      GROUP BY plans.owner
      ORDER BY plans.owner
    `,
    limit: 10,
  }) as {
    row_count: number;
    truncated: boolean;
    columns: Array<{ name: string }>;
    rows: Array<{ owner: string; post_count: number }>;
  };

  assert.equal(result.row_count, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.columns.map((column) => column.name),
    ["owner", "post_count"],
  );
  assert.deepEqual(result.rows, [
    { owner: "alice", post_count: 2 },
    { owner: "bob", post_count: 1 },
  ]);
});

test("queryWorkspaceData rejects unsafe SQL", () => {
  seedTwitterPosts(harness.dataDbPath);

  assert.throws(
    () =>
      harness.service.queryWorkspaceData({
        workspaceId: harness.workspaceId,
        query: "DELETE FROM twitter_posts",
      }),
    (error: unknown) =>
      error instanceof RuntimeAgentToolsServiceError &&
      error.code === "workspace_data_query_unsafe",
  );
});

test("listDataTables hides app-internal tables by default; includeSystem reveals them", () => {
  seedTwitterPosts(harness.dataDbPath);
  // Add the metrics-convention internal tables.
  const db = new Database(harness.dataDbPath);
  db.exec(`
    CREATE TABLE twitter_jobs (id TEXT PRIMARY KEY);
    CREATE TABLE twitter_metrics_runs (id INTEGER PRIMARY KEY, started_at TEXT);
    CREATE TABLE twitter_api_usage (date TEXT PRIMARY KEY);
    CREATE TABLE twitter_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE twitter_post_metrics (post_id TEXT, captured_at TEXT, PRIMARY KEY (post_id, captured_at));
  `);
  db.close();

  const filtered = harness.service.listDataTables({ workspaceId: harness.workspaceId });
  const filteredNames = (filtered.tables as Array<{ name: string }>).map((t) => t.name);
  assert.deepEqual(
    filteredNames.sort(),
    ["twitter_post_metrics", "twitter_posts"].sort(),
    "default response hides queues/runs/usage/settings",
  );
  assert.equal(filtered.hidden_system_count, 4);

  const all = harness.service.listDataTables({
    workspaceId: harness.workspaceId,
    includeSystem: true,
  });
  const allNames = (all.tables as Array<{ name: string }>).map((t) => t.name);
  assert.equal(allNames.length, 6);
  assert.equal(all.hidden_system_count, undefined);
});

test("updateWorkspaceInstructions appends a managed AGENTS.md rule without disturbing user-authored content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-runtime-agent-tools-agents-append-"));
  const workspaceRoot = path.join(root, "workspace");
  const dbPath = path.join(root, "runtime.db");
  const workspaceId = "workspace-1";
  const workspaceDir = path.join(workspaceRoot, workspaceId);

  const store = new RuntimeStateStore({ dbPath, workspaceRoot });
  try {
    store.createWorkspace({
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
    store.createWorkspace({
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
