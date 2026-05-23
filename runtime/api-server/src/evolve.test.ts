import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import { processClaimedInput } from "./claimed-input-executor.js";
import { FilesystemMemoryService } from "./memory.js";
import {
  globalMemoryDirForWorkspaceRoot,
  workspaceMemoryDir,
} from "./workspace-bundle-paths.js";
import {
  LEGACY_DURABLE_MEMORY_WRITEBACK_JOB_TYPE,
  EVOLVE_JOB_TYPE,
  createEvolveTaskProposal,
  enqueueEvolveJob,
  processEvolveJob,
} from "./evolve.js";
import { persistSkillCandidate, reviewTurnForSkillCandidate } from "./evolve-skill-review.js";
import { RuntimeEvolveWorker } from "./evolve-worker.js";

const tempDirs: string[] = [];
const ORIGINAL_ENV = {
  HB_SANDBOX_ROOT: process.env.HB_SANDBOX_ROOT,
  HOLABOSS_RUNTIME_CONFIG_PATH: process.env.HOLABOSS_RUNTIME_CONFIG_PATH,
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
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
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeRuntimeState(prefix: string): {
  store: RuntimeStateStore;
  memoryService: FilesystemMemoryService;
  workspaceRoot: string;
} {
  const root = makeTempDir(prefix);
  const workspaceRoot = path.join(root, "workspace");
  return {
    workspaceRoot,
    store: new RuntimeStateStore({
      dbPath: path.join(root, "runtime.db"),
      workspaceRoot,
    }),
    memoryService: new FilesystemMemoryService({ workspaceRoot }),
  };
}

function listMarkdownFiles(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  const stat = fs.statSync(root);
  if (stat.isFile() && path.extname(root).toLowerCase() === ".md") {
    return [root];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md") {
        files.push(fullPath);
      }
    }
  }
  return files.sort();
}

function snapshotMemoryFiles(workspaceRoot: string, workspaceId: string): Record<string, string> {
  const workspaceDir = path.join(workspaceRoot, workspaceId);
  const workspaceRootDir = workspaceMemoryDir(workspaceDir);
  const globalRootDir = globalMemoryDirForWorkspaceRoot(workspaceRoot);
  const files: Record<string, string> = {};

  for (const filePath of listMarkdownFiles(workspaceRootDir)) {
    const relativePath = path.relative(workspaceRootDir, filePath).split(path.sep).join("/");
    files[`workspace/${workspaceId}/${relativePath}`] = fs.readFileSync(filePath, "utf8");
  }

  const rootIndexPath = path.join(globalRootDir, "MEMORY.md");
  if (fs.existsSync(rootIndexPath) && fs.statSync(rootIndexPath).isFile()) {
    files["MEMORY.md"] = fs.readFileSync(rootIndexPath, "utf8");
  }
  if (fs.existsSync(globalRootDir) && fs.statSync(globalRootDir).isDirectory()) {
    for (const entry of fs.readdirSync(globalRootDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name === "workspace") {
        continue;
      }
      for (const filePath of listMarkdownFiles(path.join(globalRootDir, entry.name))) {
        const relativePath = path.relative(globalRootDir, filePath).split(path.sep).join("/");
        files[relativePath] = fs.readFileSync(filePath, "utf8");
      }
    }
  }

  return files;
}

function listActiveInteractionLeaves(store: RuntimeStateStore, workspaceId: string) {
  return store.listInteractionLeaves({
    workspaceId,
    status: "active",
    limit: 10_000,
    offset: 0,
  });
}

function listActiveInteractionSummaries(store: RuntimeStateStore, workspaceId: string) {
  return store.listInteractionSummaryNodes({
    workspaceId,
    status: "active",
    limit: 10_000,
    offset: 0,
  });
}

function seedWorkspace(store: RuntimeStateStore): void {
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
}

function writeRuntimeConfig(root: string, document: Record<string, unknown>): void {
  const configPath = path.join(root, "state", "runtime-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(document, null, 2)}\n`,
    "utf8",
  );
  process.env.HB_SANDBOX_ROOT = root;
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;
}

function configureBackgroundTaskModel(root: string): void {
  writeRuntimeConfig(root, {
    runtime: {
      background_tasks: {
        provider: "openai_direct",
        model: "gpt-5.4",
      },
    },
    providers: {
      openai_direct: {
        kind: "openai_compatible",
        base_url: "https://api.openai.com/v1",
        api_key: "sk-openai-test",
      },
    },
  });
}

const PROJECT_FALCON_MEMORY_RESPONSE = {
  memories: [
    {
      scope: "workspace",
      memory_type: "procedure",
      subject_key: "project-falcon:release-workflow",
      title: "Project Falcon release workflow",
      summary:
        "Project Falcon releases require test, build, and publish in that order.",
      tags: ["project-falcon", "release"],
      evidence:
        "Project Falcon release procedure: 1. Run npm run test. 2. Run npm run build. 3. Publish the bundle.",
      confidence: 0.96,
    },
  ],
};

function seedCompletedTurn(params: {
  store: RuntimeStateStore;
  inputId: string;
  messageId: string;
  messageText: string;
  assistantText: string;
  startedAt: string;
  completedAt: string;
}): void {
  params.store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    role: "user",
    text: params.messageText,
    messageId: params.messageId,
    createdAt: params.startedAt,
  });
  params.store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: params.inputId,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    status: "completed",
    stopReason: "ok",
    assistantText: params.assistantText,
  });
}

async function withMockedFetch<T>(fn: () => Promise<T>, responsePayload: Record<string, unknown>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify(responsePayload),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    )) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("queued evolve memory writeback persists durable memories and refreshes indexes", async () => {
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-evolve-memory-");
  seedWorkspace(store);
  configureBackgroundTaskModel(path.dirname(workspaceRoot));
  seedCompletedTurn({
    store,
    inputId: "input-1",
    messageId: "user-1",
    messageText: "Seed turn 1.",
    assistantText: "Completed seed turn 1.",
    startedAt: "2026-04-02T12:00:00.000Z",
    completedAt: "2026-04-02T12:00:05.000Z",
  });
  seedCompletedTurn({
    store,
    inputId: "input-2",
    messageId: "user-2",
    messageText: "Seed turn 2.",
    assistantText: "Completed seed turn 2.",
    startedAt: "2026-04-02T12:01:00.000Z",
    completedAt: "2026-04-02T12:01:05.000Z",
  });
  seedCompletedTurn({
    store,
    inputId: "input-3",
    messageId: "user-3",
    messageText: [
      "Project Falcon release procedure:",
      "1. Run `npm run test`.",
      "2. Run `npm run build`.",
      "3. Publish the bundle.",
    ].join("\n"),
    assistantText: "Captured the Project Falcon release workflow.",
    startedAt: "2026-04-02T12:02:00.000Z",
    completedAt: "2026-04-02T12:02:05.000Z",
  });
  const turnResult = store.getTurnResult({
    workspaceId: "workspace-1",
    inputId: "input-3",
  });
  assert.ok(turnResult);

  const queued = enqueueEvolveJob({
    store,
    workspaceId: turnResult.workspaceId,
    sessionId: turnResult.sessionId,
    inputId: turnResult.inputId,
    instruction: "Remember the durable Project Falcon workflow from this turn batch.",
  });

  await withMockedFetch(
    () =>
      processEvolveJob({
        store,
        record: queued,
        memoryService,
      }),
    PROJECT_FALCON_MEMORY_RESPONSE,
  );

  const files = snapshotMemoryFiles(workspaceRoot, "workspace-1");
  const leaves = listActiveInteractionLeaves(store, "workspace-1");

  assert.equal(leaves.length, 1);
  const releaseLeaf = leaves.find(
    (leaf) => leaf.title === "Project Falcon release workflow",
  );
  assert.ok(releaseLeaf);
  assert.match(files[releaseLeaf.path], /Project Falcon release workflow/);
  assert.equal(listActiveInteractionSummaries(store, "workspace-1").length, 0);

  store.close();
});

test("createEvolveTaskProposal tags task proposals with the evolve source", () => {
  const { store } = makeRuntimeState("hb-evolve-proposal-");
  seedWorkspace(store);

  const proposal = createEvolveTaskProposal({
    store,
    workspaceId: "workspace-1",
    taskName: "Review risky evolve patch",
    taskPrompt: "Inspect the candidate skill patch before promotion.",
    taskGenerationRationale: "Evolve detected a risky procedural change that needs review.",
    proposalId: "proposal-evolve-1",
    createdAt: "2026-04-10T00:00:00.000Z",
  });

  assert.equal(proposal.proposalSource, "evolve");
  assert.equal(
    store.getTaskProposal({
      workspaceId: "workspace-1",
      proposalId: "proposal-evolve-1"
    })?.proposalSource,
    "evolve"
  );
  store.close();
});

test("skill review only proposes candidates on the configured completed-turn cadence", async () => {
  const { store } = makeRuntimeState("hb-evolve-skill-cadence-");
  seedWorkspace(store);
  for (let index = 1; index <= 2; index += 1) {
    store.upsertTurnResult({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      inputId: `input-${index}`,
      startedAt: `2026-04-0${Math.min(index, 9)}T12:00:00.000Z`,
      completedAt: `2026-04-0${Math.min(index, 9)}T12:00:05.000Z`,
      status: "completed",
      stopReason: "ok",
      assistantText: `Turn ${index} complete.`,
    });
  }
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-3",
    startedAt: "2026-04-10T12:00:00.000Z",
    completedAt: "2026-04-10T12:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "Validated the release process and captured the reusable workflow.",
    toolUsageSummary: { tool_names: ["read", "bash"], total_calls: 4 },
  });
  store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    role: "user",
    text: "Document the reusable release verification workflow.",
    messageId: "user-3",
    createdAt: "2026-04-10T12:00:00.000Z",
  });

  const notDue = await reviewTurnForSkillCandidate({
    store,
    turnResult: store.upsertTurnResult({
      workspaceId: "workspace-1",
      sessionId: "session-other",
      inputId: "single-turn",
      startedAt: "2026-04-10T13:00:00.000Z",
      completedAt: "2026-04-10T13:00:05.000Z",
      status: "completed",
      stopReason: "ok",
      assistantText: "One turn only.",
    }),
    modelClient: { baseUrl: "https://example.test/openai/v1", apiKey: "token", modelId: "gpt-test" },
    instruction: "Should not run yet.",
  });
  assert.equal(notDue.reason, "not_due");

  const result = await withMockedFetch(
    () =>
      reviewTurnForSkillCandidate({
        store,
        turnResult,
        modelClient: { baseUrl: "https://example.test/openai/v1", apiKey: "token", modelId: "gpt-test" },
        instruction: "Create a reusable skill if this workflow is broadly applicable.",
      }),
    {
      candidate: {
        title: "Release verification skill",
        summary: "Reusable release verification workflow.",
        slug: "release-verification",
        when_to_use: "Use when validating release readiness before shipping.",
        workflow: [
          "Run the release verification checks in order.",
          "Confirm build output and test status before shipping.",
        ],
        verification: ["Run npm run test.", "Confirm the release build succeeds."],
        confidence: 0.93,
        evaluation_notes: "Repeated validation flow worth promoting.",
      },
    }
  );

  assert.equal(result.reason, "candidate_ready");
  assert.equal(result.draft?.slug, "release-verification");
  assert.match(result.draft?.skillMarkdown ?? "", /name: release-verification/);
  store.close();
});

test("skill review can target an existing workspace skill as a patch candidate", async () => {
  const { store } = makeRuntimeState("hb-evolve-skill-patch-review-");
  seedWorkspace(store);
  const workspaceDir = store.workspaceDir("workspace-1");
  const liveSkillDir = path.join(workspaceDir, "skills", "release-verification");
  fs.mkdirSync(liveSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(liveSkillDir, "SKILL.md"),
    [
      "---",
      "name: release-verification",
      "description: Old release verification workflow.",
      "---",
      "# Release Verification",
      "",
      "## Workflow",
      "1. Run the old checks.",
    ].join("\n"),
    "utf8"
  );
  for (let index = 1; index <= 2; index += 1) {
    store.upsertTurnResult({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      inputId: `input-patch-${index}`,
      startedAt: `2026-04-0${Math.min(index, 9)}T12:00:00.000Z`,
      completedAt: `2026-04-0${Math.min(index, 9)}T12:00:05.000Z`,
      status: "completed",
      stopReason: "ok",
      assistantText: `Patch turn ${index} complete.`,
    });
  }
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-patch-3",
    startedAt: "2026-04-10T12:10:00.000Z",
    completedAt: "2026-04-10T12:10:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "Updated the release verification workflow to include an explicit build verification step.",
    toolUsageSummary: { tool_names: ["read", "bash"], total_calls: 3 },
  });
  store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    role: "user",
    text: "Update the release verification skill to include the new build check.",
    messageId: "user-patch-3",
    createdAt: "2026-04-10T12:10:00.000Z",
  });

  const result = await withMockedFetch(
    () =>
      reviewTurnForSkillCandidate({
        store,
        turnResult,
        modelClient: { baseUrl: "https://example.test/openai/v1", apiKey: "token", modelId: "gpt-test" },
        instruction: "Update existing workspace skills when the workflow has changed materially.",
      }),
    {
      candidate: {
        kind: "skill_patch",
        target_skill_id: "release-verification",
        title: "Release verification skill",
        summary: "Reusable release verification workflow with explicit build verification.",
        slug: "release-verification",
        when_to_use: "Use when validating release readiness before shipping.",
        workflow: [
          "Run the release verification checks in order.",
          "Confirm both tests and the build output before shipping.",
        ],
        verification: ["Run npm run test.", "Run npm run build."],
        confidence: 0.94,
        evaluation_notes: "Existing skill is missing the new build verification step.",
      },
    }
  );

  assert.equal(result.reason, "candidate_ready");
  assert.equal(result.draft?.kind, "skill_patch");
  assert.equal(result.draft?.slug, "release-verification");
  assert.match(result.draft?.skillMarkdown ?? "", /Candidate kind: `skill_patch`/);
  assert.match(result.draft?.skillMarkdown ?? "", /Target workspace skill id: `release-verification`/);
  store.close();
});

test("persistSkillCandidate writes the draft artifact and dedupes active candidates", async () => {
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-evolve-skill-persist-");
  seedWorkspace(store);
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-10",
    startedAt: "2026-04-10T12:00:00.000Z",
    completedAt: "2026-04-10T12:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "Reusable workflow captured.",
  });

  const candidate = await persistSkillCandidate({
    store,
    memoryService,
    turnResult,
    draft: {
      kind: "skill_create",
      title: "Release verification skill",
      summary: "Reusable release verification workflow.",
      slug: "release-verification",
      skillMarkdown: [
        "---",
        "name: release-verification",
        "description: Reusable release verification workflow.",
        "---",
        "# Release verification skill",
      ].join("\n"),
      confidence: 0.91,
      evaluationNotes: "Looks reusable.",
      sourceTurnInputIds: ["input-10"],
    },
  });

  const persistedAgain = await persistSkillCandidate({
    store,
    memoryService,
    turnResult,
    draft: {
      kind: "skill_create",
      title: "Release verification skill",
      summary: "Reusable release verification workflow.",
      slug: "release-verification",
      skillMarkdown: [
        "---",
        "name: release-verification",
        "description: Reusable release verification workflow.",
        "---",
        "# Release verification skill",
      ].join("\n"),
      confidence: 0.91,
      evaluationNotes: "Looks reusable.",
      sourceTurnInputIds: ["input-10"],
    },
  });

  const files = snapshotMemoryFiles(workspaceRoot, "workspace-1");
  assert.equal(candidate.kind, "skill_create");
  assert.equal(candidate.status, "draft");
  assert.equal(persistedAgain.candidateId, candidate.candidateId);
  assert.ok(files[candidate.skillPath]);
  assert.match(files[candidate.skillPath], /name: release-verification/);
  store.close();
});

test("processClaimedInput promotes accepted evolve skill candidates into live workspace skills", async () => {
  const { store, memoryService } = makeRuntimeState("hb-evolve-skill-promotion-");
  seedWorkspace(store);
  const workspaceDir = store.workspaceDir("workspace-1");
  store.ensureSession({
    workspaceId: "workspace-1",
    sessionId: "session-review",
    kind: "task_proposal",
    title: "Review evolve skill",
  });
  const draftMarkdown = [
    "---",
    "name: release-verification",
    "description: Reusable release verification workflow.",
    "---",
    "# Release verification skill",
    "",
    "## When To Use",
    "Use when validating release readiness before shipping.",
    "",
    "## Workflow",
    "1. Run the release verification checks in order.",
  ].join("\n");
  await memoryService.upsert({
    workspace_id: "workspace-1",
    path: "workspace/workspace-1/evolve/skills/evolve-skill-input-10/SKILL.md",
    content: draftMarkdown,
  });
  store.createEvolveSkillCandidate({
    candidateId: "evolve-skill-input-10",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-10",
    kind: "skill_create",
    status: "accepted",
    taskProposalId: "evolve-proposal-1",
    title: "Release verification skill",
    summary: "Reusable release verification workflow.",
    slug: "release-verification",
    skillPath: "workspace/workspace-1/evolve/skills/evolve-skill-input-10/SKILL.md",
    contentFingerprint: "fp-skill",
    sourceTurnInputIds: ["input-10"],
    acceptedAt: "2026-04-10T00:00:00.000Z",
  });

  const queued = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-review",
    payload: {
      text: "Review and promote the evolve candidate.",
      context: {
        source: "task_proposal",
        proposal_source: "evolve",
        evolve_candidate: {
          candidate_id: "evolve-skill-input-10",
          kind: "skill_create",
          title: "Release verification skill",
          summary: "Reusable release verification workflow.",
          slug: "release-verification",
          skill_path: "workspace/workspace-1/evolve/skills/evolve-skill-input-10/SKILL.md",
          target_skill_path: "skills/release-verification/SKILL.md",
          skill_markdown: draftMarkdown,
          task_proposal_id: "evolve-proposal-1",
        },
      },
    },
  });
  store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-review",
    role: "user",
    text: "Review and promote the evolve candidate.",
    messageId: `user-${queued.inputId}`,
  });
  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });

  await processClaimedInput({
    store,
    record: claimed[0],
    memoryService,
    runEvolveTasksFn: async () => {},
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
        payload: { delta: "Reviewed the skill draft and it is ready for promotion." },
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

  const liveSkillPath = path.join(workspaceDir, "skills", "release-verification", "SKILL.md");
  assert.equal(fs.readFileSync(liveSkillPath, "utf8"), draftMarkdown);
  assert.equal(
    store.getEvolveSkillCandidate({
      workspaceId: "workspace-1",
      candidateId: "evolve-skill-input-10"
    })?.status,
    "promoted"
  );
  assert.ok(
    store.getEvolveSkillCandidate({
      workspaceId: "workspace-1",
      candidateId: "evolve-skill-input-10"
    })?.promotedAt
  );
  store.close();
});

test("processClaimedInput promotes misplaced evolve workspace skill files into the live skills folder", async () => {
  const { store, memoryService } = makeRuntimeState("hb-evolve-skill-misplaced-promotion-");
  seedWorkspace(store);
  const workspaceDir = store.workspaceDir("workspace-1");
  store.ensureSession({
    workspaceId: "workspace-1",
    sessionId: "session-review",
    kind: "task_proposal",
    title: "Review evolve skill",
  });
  const draftMarkdown = [
    "---",
    "name: release-verification",
    "description: Reusable release verification workflow.",
    "---",
    "# Release verification skill",
    "",
    "## Workflow",
    "1. Run the baseline verification checks.",
  ].join("\n");
  const misplacedMarkdown = [
    "---",
    "name: release-verification",
    "description: Reusable release verification workflow.",
    "---",
    "# Release verification skill",
    "",
    "## Workflow",
    "1. Run the baseline verification checks.",
    "2. Confirm the generated release notes.",
  ].join("\n");
  await memoryService.upsert({
    workspace_id: "workspace-1",
    path: "workspace/workspace-1/evolve/skills/evolve-skill-input-10/SKILL.md",
    content: draftMarkdown,
  });
  store.createEvolveSkillCandidate({
    candidateId: "evolve-skill-input-10",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-10",
    kind: "skill_create",
    status: "accepted",
    taskProposalId: "evolve-proposal-1",
    title: "Release verification skill",
    summary: "Reusable release verification workflow.",
    slug: "release-verification",
    skillPath: "workspace/workspace-1/evolve/skills/evolve-skill-input-10/SKILL.md",
    contentFingerprint: "fp-skill",
    sourceTurnInputIds: ["input-10"],
    acceptedAt: "2026-04-10T00:00:00.000Z",
  });
  const misplacedSkillPath = path.join(
    workspaceDir,
    "evolve",
    "skills",
    "release-verification",
    "SKILL.md",
  );
  fs.mkdirSync(path.dirname(misplacedSkillPath), { recursive: true });
  fs.writeFileSync(misplacedSkillPath, misplacedMarkdown, "utf8");

  const queued = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-review",
    payload: {
      text: "Review and promote the evolve candidate.",
      context: {
        source: "task_proposal",
        proposal_source: "evolve",
        evolve_candidate: {
          candidate_id: "evolve-skill-input-10",
          kind: "skill_create",
          title: "Release verification skill",
          summary: "Reusable release verification workflow.",
          slug: "release-verification",
          skill_path: "workspace/workspace-1/evolve/skills/evolve-skill-input-10/SKILL.md",
          target_skill_path: "skills/release-verification/SKILL.md",
          skill_markdown: draftMarkdown,
          task_proposal_id: "evolve-proposal-1",
        },
      },
    },
  });
  store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-review",
    role: "user",
    text: "Review and promote the evolve candidate.",
    messageId: `user-${queued.inputId}`,
  });
  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });

  await processClaimedInput({
    store,
    record: claimed[0],
    memoryService,
    runEvolveTasksFn: async () => {},
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
        payload: { delta: "Reviewed the skill draft and promoted it." },
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

  const liveSkillPath = path.join(workspaceDir, "skills", "release-verification", "SKILL.md");
  assert.equal(fs.readFileSync(liveSkillPath, "utf8"), misplacedMarkdown);
  assert.equal(fs.existsSync(misplacedSkillPath), false);
  assert.equal(fs.existsSync(path.join(workspaceDir, "evolve")), false);
  const updatedDraft = await memoryService.get({
    workspace_id: "workspace-1",
    path: "workspace/workspace-1/evolve/skills/evolve-skill-input-10/SKILL.md",
  });
  assert.equal(updatedDraft.text, misplacedMarkdown);
  assert.equal(
    store.getEvolveSkillCandidate({
      workspaceId: "workspace-1",
      candidateId: "evolve-skill-input-10"
    })?.status,
    "promoted"
  );
  store.close();
});

test("sample completed turn queues durable memory work until the evolve worker runs", async () => {
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-evolve-e2e-");
  seedWorkspace(store);
  configureBackgroundTaskModel(path.dirname(workspaceRoot));
  seedCompletedTurn({
    store,
    inputId: "seed-input-1",
    messageId: "seed-user-1",
    messageText: "Seed turn 1.",
    assistantText: "Completed seed turn 1.",
    startedAt: "2026-04-02T12:00:00.000Z",
    completedAt: "2026-04-02T12:00:05.000Z",
  });
  seedCompletedTurn({
    store,
    inputId: "seed-input-2",
    messageId: "seed-user-2",
    messageText: "Seed turn 2.",
    assistantText: "Completed seed turn 2.",
    startedAt: "2026-04-02T12:01:00.000Z",
    completedAt: "2026-04-02T12:01:05.000Z",
  });
  const queued = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: [
        "Project Falcon release procedure:",
        "1. Run `npm run test`.",
        "2. Run `npm run build`.",
        "3. Publish the bundle.",
      ].join("\n"),
    },
  });
  store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    role: "user",
    text: String(queued.payload.text ?? ""),
    messageId: `user-${queued.inputId}`,
    createdAt: "2026-04-02T12:00:00.000Z",
  });
  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "sandbox-agent-ts-worker",
    leaseSeconds: 300,
  });
  const worker = new RuntimeEvolveWorker({
    store,
    memoryService,
  });

  await processClaimedInput({
    store,
    record: claimed[0],
    memoryService,
    wakeDurableMemoryWorker: worker.wake.bind(worker),
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
        payload: { delta: "Captured the Project Falcon release workflow." },
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

  const immediateFiles = snapshotMemoryFiles(workspaceRoot, "workspace-1");
  const queuedJob = store.getPostRunJobByIdempotencyKey({
    workspaceId: "workspace-1",
    idempotencyKey: `${EVOLVE_JOB_TYPE}:${queued.inputId}`,
  });

  assert.ok(queuedJob);
  assert.equal(queuedJob.status, "QUEUED");
  assert.equal(immediateFiles["workspace/workspace-1/runtime/session-memory/session-main.md"], undefined);
  assert.deepEqual(listActiveInteractionLeaves(store, "workspace-1"), []);

  const processed = await withMockedFetch(
    () => worker.processAvailableJobsOnce(),
    PROJECT_FALCON_MEMORY_RESPONSE,
  );
  const updatedJob = store.getPostRunJobByIdempotencyKey({
    workspaceId: "workspace-1",
    idempotencyKey: `${EVOLVE_JOB_TYPE}:${queued.inputId}`,
  });
  const finalFiles = snapshotMemoryFiles(workspaceRoot, "workspace-1");

  assert.equal(processed, 1);
  assert.ok(updatedJob);
  assert.equal(updatedJob.status, "DONE");
  const leaves = listActiveInteractionLeaves(store, "workspace-1");
  assert.equal(leaves.length, 1);
  const releaseLeaf = leaves.find(
    (leaf) => leaf.title === "Project Falcon release workflow",
  );
  assert.ok(releaseLeaf);
  assert.ok(finalFiles[releaseLeaf.path]);

  store.close();
});

test("queued evolve memory writeback skips empty index generation when no durable memories are found", async () => {
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-evolve-noop-");
  seedWorkspace(store);
  store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    role: "user",
    text: "Please keep your responses concise.",
    messageId: "user-1",
    createdAt: "2026-04-02T12:00:00.000Z",
  });

  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    startedAt: "2026-04-02T12:00:00.000Z",
    completedAt: "2026-04-02T12:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "Done.",
  });

  const queued = enqueueEvolveJob({
    store,
    workspaceId: turnResult.workspaceId,
    sessionId: turnResult.sessionId,
    inputId: turnResult.inputId,
    instruction: "Remember the durable workspace rules from this turn.",
  });

  await processEvolveJob({
    store,
    record: queued,
    memoryService,
  });

  const files = snapshotMemoryFiles(workspaceRoot, "workspace-1");

  assert.deepEqual(Object.keys(files), []);
  assert.deepEqual(listActiveInteractionLeaves(store, "workspace-1"), []);
  assert.deepEqual(listActiveInteractionSummaries(store, "workspace-1"), []);

  store.close();
});

test("evolve memory worker marks claimed jobs done after successful execution", async () => {
  const { store, memoryService } = makeRuntimeState("hb-evolve-worker-");
  const queued = store.enqueuePostRunJob({
    jobType: EVOLVE_JOB_TYPE,
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    payload: {},
  });

  const seen: string[] = [];
  const worker = new RuntimeEvolveWorker({
    store,
    memoryService,
    executeClaimedJob: async (record) => {
      seen.push(record.jobId);
    },
  });

  const processed = await worker.processAvailableJobsOnce();
  const updated = store.getPostRunJob({ workspaceId: "workspace-1", jobId: queued.jobId });

  assert.equal(processed, 1);
  assert.deepEqual(seen, [queued.jobId]);
  assert.ok(updated);
  assert.equal(updated.status, "DONE");
  assert.equal(updated.claimedBy, null);
  assert.equal(updated.claimedUntil, null);

  store.close();
});

test("evolve memory worker retries once and then marks persistent failures failed", async () => {
  const { store, memoryService } = makeRuntimeState("hb-evolve-worker-retry-");
  const queued = store.enqueuePostRunJob({
    jobType: EVOLVE_JOB_TYPE,
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    payload: {},
  });

  const worker = new RuntimeEvolveWorker({
    store,
    memoryService,
    maxAttempts: 2,
    retryDelayMs: 0,
    executeClaimedJob: async () => {
      throw new Error("boom");
    },
  });

  const firstProcessed = await worker.processAvailableJobsOnce();
  const firstUpdated = store.getPostRunJob({ workspaceId: "workspace-1", jobId: queued.jobId });
  const secondProcessed = await worker.processAvailableJobsOnce();
  const secondUpdated = store.getPostRunJob({ workspaceId: "workspace-1", jobId: queued.jobId });

  assert.equal(firstProcessed, 1);
  assert.ok(firstUpdated);
  assert.equal(firstUpdated.status, "QUEUED");
  assert.equal(firstUpdated.attempt, 1);
  assert.deepEqual(firstUpdated.lastError, { message: "boom" });

  assert.equal(secondProcessed, 1);
  assert.ok(secondUpdated);
  assert.equal(secondUpdated.status, "FAILED");
  assert.equal(secondUpdated.attempt, 2);
  assert.deepEqual(secondUpdated.lastError, { message: "boom" });

  store.close();
});

test("evolve memory processor accepts legacy durable-memory job types", async () => {
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-evolve-legacy-job-");
  seedWorkspace(store);
  configureBackgroundTaskModel(path.dirname(workspaceRoot));
  seedCompletedTurn({
    store,
    inputId: "input-1",
    messageId: "user-1",
    messageText: "Seed turn 1.",
    assistantText: "Completed seed turn 1.",
    startedAt: "2026-04-02T12:00:00.000Z",
    completedAt: "2026-04-02T12:00:05.000Z",
  });
  seedCompletedTurn({
    store,
    inputId: "input-2",
    messageId: "user-2",
    messageText: "Seed turn 2.",
    assistantText: "Completed seed turn 2.",
    startedAt: "2026-04-02T12:01:00.000Z",
    completedAt: "2026-04-02T12:01:05.000Z",
  });
  seedCompletedTurn({
    store,
    inputId: "input-3",
    messageId: "user-3",
    messageText: [
      "Project Falcon release procedure:",
      "1. Run `npm run test`.",
      "2. Run `npm run build`.",
      "3. Publish the bundle.",
    ].join("\n"),
    assistantText: "Captured the Project Falcon release workflow.",
    startedAt: "2026-04-02T12:02:00.000Z",
    completedAt: "2026-04-02T12:02:05.000Z",
  });
  const legacyJob = store.enqueuePostRunJob({
    jobType: LEGACY_DURABLE_MEMORY_WRITEBACK_JOB_TYPE,
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-3",
    payload: {
      instruction: "Remember the durable Project Falcon workflow from this turn batch.",
    },
    idempotencyKey: `${LEGACY_DURABLE_MEMORY_WRITEBACK_JOB_TYPE}:input-3`,
  });

  await withMockedFetch(
    () =>
      processEvolveJob({
        store,
        record: legacyJob,
        memoryService,
      }),
    PROJECT_FALCON_MEMORY_RESPONSE,
  );

  const files = snapshotMemoryFiles(workspaceRoot, "workspace-1");

  const leaf = listActiveInteractionLeaves(store, "workspace-1").find(
    (entry) => entry.title === "Project Falcon release workflow",
  );
  assert.ok(leaf);
  assert.ok(files[leaf!.path]);

  store.close();
});
