import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RuntimeStateStore, utcNowIso } from "@holaboss/runtime-state-store";

import { RuntimeAgentToolsService } from "./runtime-agent-tools.js";

test("queueIssueReply routes a reopened issue back to the preferred main session", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "hb-runtime-agent-tools-issue-routing-reply-"),
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
    const mainSession = store.ensureSession({
      workspaceId,
      sessionId: "session-main",
      kind: "main_session",
      createdBy: "workspace_user",
    });
    store.upsertConversationBinding({
      workspaceId,
      sessionId: mainSession.sessionId,
      channel: "desktop",
      conversationKey: "main_session",
      role: "main_session",
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

    assert.equal(result.session.sessionId, issue.sessionId);
    assert.equal(result.run.run.subagentId, staleRun.subagentId);
    assert.equal(result.run.run.parentSessionId, mainSession.sessionId);
    assert.equal(result.run.run.originMainSessionId, mainSession.sessionId);
    assert.equal(result.run.run.ownerMainSessionId, mainSession.sessionId);
    assert.equal(store.listSubagentRunsByWorkspace({ workspaceId }).length, 1);
    assert.equal(
      (result.input.payload.context as Record<string, unknown>)
        ?.parent_session_id,
      mainSession.sessionId,
    );
    assert.equal(
      (result.input.payload.context as Record<string, unknown>)
        ?.origin_main_session_id,
      mainSession.sessionId,
    );
    assert.equal(
      (result.input.payload.context as Record<string, unknown>)
        ?.owner_main_session_id,
      mainSession.sessionId,
    );
    assert.equal(
      store.getSession({
        workspaceId,
        sessionId: issue.sessionId,
      })?.parentSessionId,
      mainSession.sessionId,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatchIssue routes a manual issue run back to the preferred main session", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "hb-runtime-agent-tools-issue-routing-dispatch-"),
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
    const mainSession = store.ensureSession({
      workspaceId,
      sessionId: "session-main",
      kind: "main_session",
      createdBy: "workspace_user",
    });
    store.upsertConversationBinding({
      workspaceId,
      sessionId: mainSession.sessionId,
      channel: "desktop",
      conversationKey: "main_session",
      role: "main_session",
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
      status: "todo",
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
    const result = service.dispatchIssue({
      workspaceId,
      issueId: issue.issueId,
      createdBy: "workspace_user",
    });

    assert.equal(result.run.run.subagentId, staleRun.subagentId);
    assert.equal(result.session.parentSessionId, mainSession.sessionId);
    assert.equal(result.run.run.parentSessionId, mainSession.sessionId);
    assert.equal(result.run.run.originMainSessionId, mainSession.sessionId);
    assert.equal(result.run.run.ownerMainSessionId, mainSession.sessionId);
    assert.equal(store.listSubagentRunsByWorkspace({ workspaceId }).length, 1);
    assert.equal(
      (result.input.payload.context as Record<string, unknown>)
        ?.parent_session_id,
      mainSession.sessionId,
    );
    assert.equal(
      (result.input.payload.context as Record<string, unknown>)
        ?.origin_main_session_id,
      mainSession.sessionId,
    );
    assert.equal(
      (result.input.payload.context as Record<string, unknown>)
        ?.owner_main_session_id,
      mainSession.sessionId,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
