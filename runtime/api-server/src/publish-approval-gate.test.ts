import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import { seedWorkspaceRecord } from "./__test-helpers__/seed-workspace.js";
import { executeComposioInlineTool } from "./composio-inline-execution.js";
import { ComposioService } from "./composio-service.js";
import { classifyPublishAction } from "./publish-action-classifier.js";
import {
  PUBLISH_APPROVAL_TTL_MS,
  PublishApprovalGate,
} from "./publish-approval-gate.js";
import { RuntimeAgentToolsService } from "./runtime-agent-tools.js";

const WORKSPACE_ID = "workspace-1";
const SESSION_ID = "main-1";
const TOOLKIT = "twitter";
const TOOL = "TWITTER_CREATION_OF_A_POST";
const ACCOUNT = "ca_twitter";

interface Harness {
  store: RuntimeStateStore;
  service: RuntimeAgentToolsService;
  gate: PublishApprovalGate;
  clock: { now: number };
  cleanup: () => Promise<void>;
}

async function setup(sessionKind = "main_session", createdBy: string | null = null): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "hb-publish-approval-"));
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  seedWorkspaceRecord(store, {
    workspaceId: WORKSPACE_ID,
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    kind: sessionKind,
    createdBy,
  });
  const clock = { now: Date.now() };
  const gate = new PublishApprovalGate({ store, now: () => clock.now });
  const service = new RuntimeAgentToolsService(store, { workspaceRoot });
  return {
    store,
    service,
    gate,
    clock,
    cleanup: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function authorize(
  harness: Harness,
  args: Record<string, unknown>,
  options: { toolSlug?: string; inputId?: string } = {},
) {
  const toolSlug = options.toolSlug ?? TOOL;
  const action = classifyPublishAction({ toolkitSlug: TOOLKIT, toolSlug });
  assert.ok(action);
  return harness.gate.authorize({
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    inputId: options.inputId ?? "input-1",
    action,
    toolkitSlug: TOOLKIT,
    connectedAccountId: ACCOUNT,
    arguments: args,
  });
}

function activeCard(harness: Harness): {
  title: string;
  questions: Array<{
    id: string;
    title: string;
    prompt: string;
    options: Array<{ id: string; label: string }>;
  }>;
} {
  const session = harness.store.getSession({
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
  });
  assert.ok(session?.activeUserQuestion, "an approval card is active");
  return JSON.parse(session.activeUserQuestion);
}

function answer(
  harness: Harness,
  answers: Array<{ question_id: string; option_id?: string; response_text?: string }>,
) {
  return harness.service.answerUserQuestion({
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    answers,
  });
}

function approveAll(harness: Harness) {
  const card = activeCard(harness);
  answer(
    harness,
    card.questions.map((question) => ({
      question_id: question.id,
      option_id: "approve",
    })),
  );
}

test("a publish call is blocked and shows the exact content until the user approves", async () => {
  const harness = await setup();
  try {
    const decision = authorize(harness, { text: "Shipping v2 today.\nDetails soon." });
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.code, "approval_required");

    const card = activeCard(harness);
    assert.equal(card.questions.length, 1);
    const question = card.questions[0]!;
    assert.match(question.id, /^publish_approval_[0-9a-f]{32}$/);
    assert.equal(question.title, "X · Creation of a post");
    assert.equal(question.prompt, "text:\nShipping v2 today.\nDetails soon.");
    assert.deepEqual(
      question.options.map((option) => option.id),
      ["decline", "approve"],
    );

    const again = authorize(harness, { text: "Shipping v2 today.\nDetails soon." });
    assert.equal(again.allowed, false);
    assert.equal(activeCard(harness).questions[0]!.id, question.id);
  } finally {
    await harness.cleanup();
  }
});

test("an approval of the exact payload lets the call through once", async () => {
  const harness = await setup();
  try {
    authorize(harness, { text: "Hello", reply_settings: "following" });
    approveAll(harness);

    const allowed = authorize(
      harness,
      { reply_settings: "following", text: "Hello", media: null },
      { inputId: "input-2" },
    );
    assert.deepEqual(allowed, { allowed: true });

    const reused = authorize(harness, { text: "Hello", reply_settings: "following" }, {
      inputId: "input-2",
    });
    assert.equal(reused.allowed, false);
    assert.equal(reused.allowed === false && reused.code, "approval_required");
  } finally {
    await harness.cleanup();
  }
});

test("an approval does not cover a different payload", async () => {
  const harness = await setup();
  try {
    authorize(harness, { text: "Version A" });
    approveAll(harness);

    const changed = authorize(harness, { text: "Version B" }, { inputId: "input-2" });
    assert.equal(changed.allowed, false);
    assert.equal(changed.allowed === false && changed.code, "approval_required");
    assert.equal(activeCard(harness).questions[0]!.prompt, "text: Version B");

    const otherTool = authorize(
      harness,
      { text: "Version A" },
      { toolSlug: "TWITTER_SEND_A_NEW_MESSAGE_TO_A_DM_CONVERSATION", inputId: "input-2" },
    );
    assert.equal(otherTool.allowed, false);
  } finally {
    await harness.cleanup();
  }
});

test("an approval expires", async () => {
  const harness = await setup();
  try {
    authorize(harness, { text: "Hello" });
    approveAll(harness);
    harness.clock.now += PUBLISH_APPROVAL_TTL_MS + 60_000;

    const expired = authorize(harness, { text: "Hello" }, { inputId: "input-2" });
    assert.equal(expired.allowed, false);
    assert.equal(expired.allowed === false && expired.code, "approval_required");
  } finally {
    await harness.cleanup();
  }
});

test("declining or replying in words does not approve", async () => {
  const harness = await setup();
  try {
    authorize(harness, { text: "Hello" });
    answer(harness, [
      { question_id: activeCard(harness).questions[0]!.id, option_id: "decline" },
    ]);
    const declined = authorize(harness, { text: "Hello" }, { inputId: "input-2" });
    assert.equal(declined.allowed === false && declined.code, "approval_declined");

    authorize(harness, { text: "Hello" }, { inputId: "input-3" });
    answer(harness, [
      {
        question_id: activeCard(harness).questions[0]!.id,
        response_text: "make it shorter",
      },
    ]);
    const revised = authorize(harness, { text: "Hello" }, { inputId: "input-4" });
    assert.equal(revised.allowed === false && revised.code, "approval_declined");
  } finally {
    await harness.cleanup();
  }
});

test("a lookalike question asked by the agent does not count as approval", async () => {
  const harness = await setup();
  try {
    authorize(harness, { text: "Hello" });
    harness.service.createUserQuestion({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      question: {
        title: "Approve before publishing",
        questions: [
          {
            id: "publish_approval_guess",
            prompt: "text: Hello",
            options: [
              { id: "decline", label: "Don't publish" },
              { id: "approve", label: "Publish exactly this" },
            ],
          },
        ],
      },
    });
    approveAll(harness);

    const decision = authorize(harness, { text: "Hello" }, { inputId: "input-2" });
    assert.equal(decision.allowed, false);
  } finally {
    await harness.cleanup();
  }
});

test("drafts blocked in the same turn share one approval card", async () => {
  const harness = await setup();
  try {
    authorize(harness, { text: "First" });
    authorize(harness, { text: "Second" });
    assert.deepEqual(
      activeCard(harness).questions.map((question) => question.prompt),
      ["text: First", "text: Second"],
    );
    approveAll(harness);
    assert.deepEqual(authorize(harness, { text: "Second" }, { inputId: "input-2" }), {
      allowed: true,
    });
    assert.deepEqual(authorize(harness, { text: "First" }, { inputId: "input-2" }), {
      allowed: true,
    });
  } finally {
    await harness.cleanup();
  }
});

test("a background session cannot request approval", async () => {
  const harness = await setup("subagent");
  try {
    const decision = authorize(harness, { text: "Hello" });
    assert.equal(decision.allowed === false && decision.code, "approval_unavailable");
    const session = harness.store.getSession({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
    });
    assert.equal(session?.activeUserQuestion ?? null, null);
  } finally {
    await harness.cleanup();
  }
});

test("scheduled and IM-channel sessions keep posting without a desktop approval card", async () => {
  for (const createdBy of ["cronjob", "im:telegram"]) {
    const harness = await setup("main_session", createdBy);
    try {
      const decision = authorize(harness, { text: "Scheduled post" });
      assert.equal(decision.allowed, true, createdBy);
      const session = harness.store.getSession({ workspaceId: WORKSPACE_ID, sessionId: SESSION_ID });
      assert.equal(session?.activeUserQuestion ?? null, null);
    } finally {
      await harness.cleanup();
    }
  }
});

function recordingComposio(): { composio: ComposioService; calls: string[] } {
  const calls: string[] = [];
  const composio = new ComposioService({
    honoBaseUrl: "https://app.holaboss.test",
    authCookie: "hb_session=abc",
    fetchImpl: async (input) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({ ok: true, data: { id: "post-1" }, log_id: "log-1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  return { composio, calls };
}

test("executeComposioInlineTool never reaches Composio for an unapproved publish", async () => {
  const harness = await setup();
  try {
    const { composio, calls } = recordingComposio();
    const run = (inputId: string) =>
      executeComposioInlineTool({
        composio,
        toolkitSlug: TOOLKIT,
        toolSlug: TOOL,
        connectedAccountId: ACCOUNT,
        arguments: { text: "Hello" },
        publishApproval: {
          gate: harness.gate,
          workspaceId: WORKSPACE_ID,
          sessionId: SESSION_ID,
          inputId,
        },
      });

    const blocked = await run("input-1");
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, "approval_required");
    assert.match(blocked.error_marker ?? "", /^\[composio_error:approval_required:twitter\] /);
    assert.equal(calls.length, 0);

    approveAll(harness);
    const published = await run("input-2");
    assert.equal(published.ok, true);
    assert.equal(calls.length, 1);

    const replay = await run("input-2");
    assert.equal(replay.ok, false);
    assert.equal(calls.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test("executeComposioInlineTool blocks a publish when no approval context is supplied", async () => {
  const { composio, calls } = recordingComposio();
  const blocked = await executeComposioInlineTool({
    composio,
    toolkitSlug: "linkedin",
    toolSlug: "LINKEDIN_CREATE_LINKED_IN_POST",
    connectedAccountId: "ca_li",
    arguments: { commentary: "Hello" },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error?.code, "approval_unavailable");
  assert.equal(calls.length, 0);

  const read = await executeComposioInlineTool({
    composio,
    toolkitSlug: "linkedin",
    toolSlug: "LINKEDIN_GET_MY_INFO",
    connectedAccountId: "ca_li",
    arguments: {},
  });
  assert.equal(read.ok, true);
  assert.equal(calls.length, 1);
});
