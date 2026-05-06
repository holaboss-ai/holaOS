import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";

import Database from "better-sqlite3";
import { load as parseYaml } from "js-yaml";

import { RuntimeStateStore, utcNowIso } from "@holaboss/runtime-state-store";

import {
  RuntimeAgentToolsService,
  RuntimeAgentToolsServiceError,
} from "./runtime-agent-tools.js";

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
      kind: "workspace_session",
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
      effectiveModel: "openai/gpt-5.4",
      status: "completed",
      summary: "Top AI results.",
      resultPayload: { assistant_text: "Top AI results: item 1, item 2, item 3." },
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
      kind: "workspace_session",
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
      resultPayload: { assistant_text: "Top crypto results." },
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
      kind: "workspace_session",
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

    const service = new RuntimeAgentToolsService(store, { workspaceRoot });
    const explicitResult = service.delegateTask({
      workspaceId,
      sessionId: mainSessionId,
      inputId: explicitParentInput.inputId,
      tasks: [
        {
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
      kind: "workspace_session",
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
      kind: "workspace_session",
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
      resultPayload: { assistant_text: "Reached the login page." },
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
      kind: "workspace_session",
      createdBy: "workspace_user",
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
      status: "completed",
      summary: "Blocked by login.",
      blockingPayload: {
        status: "waiting_on_user",
        blocking_question:
          "Please log in or complete the required access step, then tell me to continue.",
      },
      resultPayload: { assistant_text: "The page is logged out." },
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
      kind: "workspace_session",
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
      kind: "workspace_session",
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
      kind: "workspace_session",
      createdBy: "workspace_user",
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

function seedTwitterPosts(dbPath: string) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE twitter_posts (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_twitter_posts_status ON twitter_posts(status);
  `);
  const insert = db.prepare(
    "INSERT INTO twitter_posts (id, content, status, created_at) VALUES (?, ?, ?, ?)",
  );
  insert.run("p1", "First draft", "draft", "2026-04-28T00:00:00Z");
  insert.run("p2", "Second draft", "draft", "2026-04-28T00:00:01Z");
  insert.run("p3", "Published one", "published", "2026-04-28T00:00:02Z");
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
  assert.deepEqual(colNames.slice(0, 4), ["id", "content", "status", "created_at"]);
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

test("createDataTable writes rows into the shared workspace data.db", () => {
  const result = harness.service.createDataTable({
    workspaceId: harness.workspaceId,
    name: "demo_dashboard_data",
    columns: [
      { name: "id", type: "INTEGER", primary_key: true },
      { name: "account", type: "TEXT", not_null: true },
      { name: "category", type: "TEXT", not_null: true },
      { name: "value", type: "INTEGER", not_null: true },
    ],
    rows: [
      { id: 1, account: "Northwind", category: "Alpha", value: 42 },
      { id: 2, account: "Beacon", category: "Beta", value: 54 },
      { id: 3, account: "Atlas", category: "Gamma", value: 76 },
    ],
  });

  assert.equal(result.table_name, "demo_dashboard_data");
  assert.equal(result.row_count, 3);
  assert.equal(result.column_count, 4);
  assert.equal(result.db_path, ".holaboss/state/data.db");
  assert.equal(fs.existsSync(path.join(harness.workspaceDir, "data.db")), false);

  const tables = harness.service.listDataTables({ workspaceId: harness.workspaceId })
    .tables as Array<{
    name: string;
    row_count: number;
    columns: Array<{ name: string; type: string }>;
  }>;
  assert.equal(tables.length, 1);
  assert.equal(tables[0]?.name, "demo_dashboard_data");
  assert.equal(tables[0]?.row_count, 3);
  assert.deepEqual(
    tables[0]?.columns.map((column) => column.name),
    ["id", "account", "category", "value"],
  );
});

test("createDataTable + createDashboard supports empty-workspace demo dashboard flow", async () => {
  harness.service.createDataTable({
    workspaceId: harness.workspaceId,
    name: "demo_dashboard_data",
    columns: [
      { name: "id", type: "INTEGER", primary_key: true },
      { name: "item", type: "TEXT", not_null: true },
      { name: "category", type: "TEXT", not_null: true },
      { name: "value", type: "INTEGER", not_null: true },
      { name: "owner", type: "TEXT", not_null: true },
    ],
    rows: [
      { id: 1, item: "Northwind", category: "Alpha", value: 42, owner: "Ava" },
      { id: 2, item: "Bluebird", category: "Alpha", value: 67, owner: "Noah" },
      { id: 3, item: "Summit", category: "Beta", value: 31, owner: "Mia" },
      { id: 4, item: "Atlas", category: "Gamma", value: 76, owner: "Emma" },
    ],
  });

  const result = await harness.service.createDashboard({
    workspaceId: harness.workspaceId,
    name: "demo-showcase-dashboard",
    title: "Demo Showcase Dashboard",
    description: "Simple showcase dashboard with random demo data.",
    panels: [
      {
        type: "data_view",
        title: "Demo Data Table",
        query:
          "SELECT id, item, category, value, owner FROM demo_dashboard_data ORDER BY value DESC",
        views: [
          { type: "table", columns: ["id", "item", "category", "value", "owner"] },
        ],
        default_view: "table",
      },
      {
        type: "kpi",
        title: "Total Demo Value",
        query: "SELECT SUM(value) AS value FROM demo_dashboard_data",
      },
    ],
  });

  assert.equal(result.file_path, "files/dashboards/demo-showcase-dashboard.dashboard");
  assert.equal(
    fs.existsSync(path.join(harness.workspaceDir, "files", "dashboards", "demo-showcase-dashboard.dashboard")),
    true,
  );
});

test("createDashboard validates SQL and writes a YAML file", async () => {
  seedTwitterPosts(harness.dataDbPath);
  const result = await harness.service.createDashboard({
    workspaceId: harness.workspaceId,
    name: "social-overview",
    title: "Social Overview",
    description: "Drafts and publish status.",
    panels: [
      {
        type: "kpi",
        title: "Total Drafts",
        query: "SELECT COUNT(*) AS value FROM twitter_posts",
      },
      {
        type: "data_view",
        title: "All Posts",
        query: "SELECT id, content, status FROM twitter_posts",
        views: [
          { type: "table", columns: ["content", "status"] },
          { type: "board", group_by: "status", card_title: "content" },
        ],
        default_view: "board",
      },
    ],
  });

  assert.equal(result.panel_count, 2);
  assert.equal(result.file_path, "files/dashboards/social-overview.dashboard");
  const absolutePath = path.join(
    harness.workspaceDir,
    "files",
    "dashboards",
    "social-overview.dashboard",
  );
  assert.equal(fs.existsSync(absolutePath), true);

  const written = fs.readFileSync(absolutePath, "utf8");
  const parsed = parseYaml(written) as {
    title: string;
    description: string;
    panels: Array<{ type: string; views?: Array<{ type: string }> }>;
  };
  assert.equal(parsed.title, "Social Overview");
  assert.equal(parsed.description, "Drafts and publish status.");
  assert.equal(parsed.panels.length, 2);
  assert.equal(parsed.panels[0].type, "kpi");
  assert.equal(parsed.panels[1].type, "data_view");
  assert.deepEqual(
    parsed.panels[1].views?.map((v) => v.type),
    ["table", "board"],
  );
});

test("createDashboard rejects bad SQL with a 400 + named code", async () => {
  seedTwitterPosts(harness.dataDbPath);
  await assert.rejects(
    () =>
      harness.service.createDashboard({
        workspaceId: harness.workspaceId,
        name: "broken",
        title: "Broken",
        panels: [
          {
            type: "kpi",
            title: "Bad",
            query: "SELECT COUNT(*) AS value FROM nonexistent_table",
          },
        ],
      }),
    (err: unknown) => {
      assert.ok(err instanceof RuntimeAgentToolsServiceError);
      assert.equal(err.statusCode, 400);
      assert.equal(err.code, "dashboard_panel_query_invalid");
      return true;
    },
  );
  // No file should have been written.
  const dashboardsDir = path.join(harness.workspaceDir, "files", "dashboards");
  if (fs.existsSync(dashboardsDir)) {
    assert.deepEqual(fs.readdirSync(dashboardsDir), []);
  }
});

test("createDashboard rejects an unsafe filename slug", async () => {
  seedTwitterPosts(harness.dataDbPath);
  await assert.rejects(
    () =>
      harness.service.createDashboard({
        workspaceId: harness.workspaceId,
        name: "../escape",
        title: "X",
        panels: [
          {
            type: "kpi",
            title: "T",
            query: "SELECT 1 AS value",
          },
        ],
      }),
    (err: unknown) => {
      assert.ok(err instanceof RuntimeAgentToolsServiceError);
      assert.equal(err.code, "dashboard_name_invalid");
      return true;
    },
  );
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
