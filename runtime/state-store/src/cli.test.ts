import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { handleRequest } from "./cli.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test("handleRequest maps binding and session message operations to snake_case payloads", () => {
  const root = makeTempDir("hb-state-store-cli-");
  const options = {
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  };

  const binding = handleRequest("upsert-binding", {
    options,
    workspace_id: "workspace-1",
    session_id: "session-main",
    harness: "pi",
    harness_session_id: "harness-1"
  }) as Record<string, unknown>;

  handleRequest("insert-session-message", {
    options,
    workspace_id: "workspace-1",
    session_id: "session-main",
    role: "user",
    text: "hello",
    message_id: "m-1",
    created_at: "2026-01-01T00:00:00+00:00"
  });
  const messages = handleRequest("list-session-messages", {
    options,
    workspace_id: "workspace-1",
    session_id: "session-main"
  }) as Array<Record<string, unknown>>;

  assert.equal(binding.workspace_id, "workspace-1");
  assert.equal(binding.harness_session_id, "harness-1");
  assert.deepEqual(messages, [
    {
      id: "m-1",
      role: "user",
      text: "hello",
      created_at: "2026-01-01T00:00:00+00:00",
      metadata: {}
    }
  ]);
});

test("handleRequest maps workspace CRUD operations to snake_case payloads", () => {
  const root = makeTempDir("hb-state-store-cli-");
  const options = {
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  };

  const created = handleRequest("create-workspace", {
    options,
    workspace_id: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "provisioning"
  }) as Record<string, unknown>;
  const listed = handleRequest("list-workspaces", {
    options
  }) as Array<Record<string, unknown>>;
  const updated = handleRequest("update-workspace", {
    options,
    workspace_id: "workspace-1",
    fields: {
      status: "active",
      onboarding_status: "pending"
    }
  }) as Record<string, unknown>;
  const deleted = handleRequest("delete-workspace", {
    options,
    workspace_id: "workspace-1"
  }) as Record<string, unknown>;

  assert.equal(created.id, "workspace-1");
  assert.equal(listed.length, 1);
  assert.equal(updated.status, "active");
  assert.equal(updated.onboarding_status, "pending");
  assert.equal(deleted.status, "deleted");
});

test("handleRequest returns the resolved workspace directory", () => {
  const root = makeTempDir("hb-state-store-cli-");
  const options = {
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  };

  handleRequest("create-workspace", {
    options,
    workspace_id: "workspace-1",
    name: "Workspace 1",
    harness: "pi"
  });

  const resolved = handleRequest("workspace-dir", {
    options,
    workspace_id: "workspace-1"
  });

  assert.equal(resolved, path.join(options.workspaceRoot, "workspace-1"));
});

test("handleRequest maps output event operations to snake_case payloads", () => {
  const root = makeTempDir("hb-state-store-cli-");
  const options = {
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  };

  handleRequest("append-output-event", {
    options,
    workspace_id: "workspace-1",
    session_id: "session-main",
    input_id: "input-1",
    sequence: 1,
    event_type: "run_started",
    payload: { instruction_preview: "hello" }
  });
  handleRequest("append-output-event", {
    options,
    workspace_id: "workspace-1",
    session_id: "session-main",
    input_id: "input-1",
    sequence: 2,
    event_type: "output_delta",
    payload: { delta: "hi" }
  });

  const latest = handleRequest("latest-output-event-id", {
    options,
    workspace_id: "workspace-1",
    session_id: "session-main",
    input_id: "input-1"
  });
  const incremental = handleRequest("list-output-events", {
    options,
    workspace_id: "workspace-1",
    session_id: "session-main",
    input_id: "input-1",
    after_event_id: 1
  }) as Array<Record<string, unknown>>;

  assert.equal(latest, 2);
  assert.deepEqual(incremental, [
    {
      id: 2,
      workspace_id: "workspace-1",
      session_id: "session-main",
      input_id: "input-1",
      sequence: 2,
      event_type: "output_delta",
      payload: { delta: "hi" },
      created_at: incremental[0]?.created_at
    }
  ]);
});

test("handleRequest maps output folders, outputs, and artifacts to snake_case payloads", () => {
  const root = makeTempDir("hb-state-store-cli-");
  const options = {
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  };

  const folder = handleRequest("create-output-folder", {
    options,
    workspace_id: "workspace-1",
    name: "Drafts"
  }) as Record<string, unknown>;
  const output = handleRequest("create-output", {
    options,
    workspace_id: "workspace-1",
    output_type: "document",
    title: "Spec Draft",
    folder_id: String(folder.id),
    session_id: "session-main"
  }) as Record<string, unknown>;
  const artifact = handleRequest("create-session-artifact", {
    options,
    session_id: "session-main",
    workspace_id: "workspace-1",
    artifact_type: "document",
    external_id: "doc-1",
    platform: "notion",
    title: "Generated Doc"
  }) as Record<string, unknown>;
  const counts = handleRequest("get-output-counts", {
    options,
    workspace_id: "workspace-1"
  }) as Record<string, unknown>;
  const listedArtifacts = handleRequest("list-session-artifacts", {
    options,
    session_id: "session-main",
    workspace_id: "workspace-1"
  }) as Array<Record<string, unknown>>;

  assert.equal(folder.workspace_id, "workspace-1");
  assert.equal(output.folder_id, folder.id);
  assert.equal(artifact.external_id, "doc-1");
  assert.equal(counts.total, 2);
  assert.equal(listedArtifacts.length, 2);
  assert.ok(listedArtifacts.some((item) => item.platform === "notion"));
});

test("handleRequest maps cronjobs and task proposals to snake_case payloads", () => {
  const root = makeTempDir("hb-state-store-cli-");
  const options = {
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  };

  const job = handleRequest("create-cronjob", {
    options,
    workspace_id: "workspace-1",
    initiated_by: "workspace_agent",
    cron: "0 9 * * *",
    description: "Daily check",
    instruction: "Say hello",
    delivery: { mode: "announce", channel: "session_run", to: null }
  }) as Record<string, unknown>;
  const updatedJob = handleRequest("update-cronjob", {
    options,
    workspace_id: "workspace-1",
    job_id: String(job.id),
    description: "Updated check",
    instruction: "Say hello louder"
  }) as Record<string, unknown>;
  const proposal = handleRequest("create-task-proposal", {
    options,
    proposal_id: "proposal-1",
    workspace_id: "workspace-1",
    task_name: "Follow up",
    task_prompt: "Write a follow-up message",
    task_generation_rationale: "User has not replied",
    source_event_ids: ["evt-1"],
    created_at: "2026-01-01T00:00:00+00:00"
  }) as Record<string, unknown>;
  const updatedProposal = handleRequest("update-task-proposal-state", {
    options,
    workspace_id: "workspace-1",
    proposal_id: "proposal-1",
    state: "accepted"
  }) as Record<string, unknown>;

  assert.equal(job.workspace_id, "workspace-1");
  assert.equal(job.instruction, "Say hello");
  assert.equal(updatedJob.description, "Updated check");
  assert.equal(updatedJob.instruction, "Say hello louder");
  assert.equal(proposal.proposal_source, "proactive");
  assert.equal(proposal.source_event_ids instanceof Array, true);
  assert.equal(updatedProposal.state, "accepted");
});

test("handleRequest maps app build operations to snake_case payloads", () => {
  const root = makeTempDir("hb-state-store-cli-");
  const options = {
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  };

  const building = handleRequest("upsert-app-build", {
    options,
    workspace_id: "workspace-1",
    app_id: "app-1",
    status: "building"
  }) as Record<string, unknown>;
  const failed = handleRequest("upsert-app-build", {
    options,
    workspace_id: "workspace-1",
    app_id: "app-1",
    status: "failed",
    error: "boom"
  }) as Record<string, unknown>;
  const fetched = handleRequest("get-app-build", {
    options,
    workspace_id: "workspace-1",
    app_id: "app-1"
  }) as Record<string, unknown>;
  const deleted = handleRequest("delete-app-build", {
    options,
    workspace_id: "workspace-1",
    app_id: "app-1"
  });

  assert.equal(building.workspace_id, "workspace-1");
  assert.equal(building.app_id, "app-1");
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "boom");
  assert.equal(fetched.updated_at, failed.updated_at);
  assert.equal(deleted, true);
});
