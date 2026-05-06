import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import {
  type SessionCheckpointSessionOps,
  enqueueSessionCheckpointJob,
  processSessionCheckpointJob,
  shouldQueueSessionCheckpoint,
} from "./session-checkpoint.js";
import type { RuntimeSentryCaptureOptions } from "./runtime-sentry.js";

interface FakeSessionEntry {
  id: string;
  type: "message" | "compaction";
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  details?: unknown;
  fromHook?: boolean;
}

interface FakeSessionState {
  entries: FakeSessionEntry[];
  leafId: string | null;
}

let fakeSessionEntryCounter = 0;

function nextFakeEntryId(): string {
  fakeSessionEntryCounter += 1;
  return `entry-${fakeSessionEntryCounter}`;
}

function createFakeSessionFile(root: string, states: Map<string, FakeSessionState>): string {
  const sessionDir = fs.mkdtempSync(path.join(root, "pi-sessions-"));
  const sessionFile = path.join(sessionDir, "session.jsonl");
  fs.writeFileSync(sessionFile, '{"type":"header"}\n', "utf8");
  states.set(sessionFile, {
    entries: [],
    leafId: null,
  });
  return sessionFile;
}

function requireFakeSessionState(
  states: Map<string, FakeSessionState>,
  sessionFile: string,
): FakeSessionState {
  const state = states.get(sessionFile);
  assert.ok(state, `missing fake session state for ${sessionFile}`);
  return state;
}

function appendFakeMessage(
  states: Map<string, FakeSessionState>,
  sessionFile: string,
): string {
  const state = requireFakeSessionState(states, sessionFile);
  const id = nextFakeEntryId();
  state.entries.push({
    id,
    type: "message",
  });
  state.leafId = id;
  return id;
}

test("session checkpoint queues only after PI context crosses the 50 percent reserve", () => {
  assert.equal(
    shouldQueueSessionCheckpoint({
      tokens: 525_000,
      contextWindow: 1_050_000,
      percent: 50,
    }),
    false,
  );
  assert.equal(
    shouldQueueSessionCheckpoint({
      tokens: 525_001,
      contextWindow: 1_050_000,
      percent: 50.1,
    }),
    true,
  );
  assert.equal(
    shouldQueueSessionCheckpoint({
      tokens: 32_768,
      contextWindow: 65_536,
      percent: 50,
    }),
    false,
  );
  assert.equal(
    shouldQueueSessionCheckpoint({
      tokens: 32_769,
      contextWindow: 65_536,
      percent: 50.1,
    }),
    true,
  );
});

function appendFakeCompaction(params: {
  states: Map<string, FakeSessionState>;
  sessionFile: string;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
  fromHook?: boolean;
}): string {
  const state = requireFakeSessionState(params.states, params.sessionFile);
  const id = nextFakeEntryId();
  state.entries.push({
    id,
    type: "compaction",
    summary: params.summary,
    firstKeptEntryId: params.firstKeptEntryId,
    tokensBefore: params.tokensBefore,
    details: params.details,
    fromHook: params.fromHook,
  });
  state.leafId = id;
  return id;
}

function cloneFakeSession(
  states: Map<string, FakeSessionState>,
  sourceFile: string,
  targetFile: string,
): void {
  const source = requireFakeSessionState(states, sourceFile);
  states.set(targetFile, {
    entries: source.entries.map((entry) => ({ ...entry })),
    leafId: source.leafId,
  });
}

function latestFakeCompactionEntry(
  entries: FakeSessionEntry[],
): FakeSessionEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "compaction") {
      return entries[index];
    }
  }
  return null;
}

function createFakeSessionOps(
  states: Map<string, FakeSessionState>,
): SessionCheckpointSessionOps {
  return {
    currentLeafCheckpointState(sessionFile) {
      const state = requireFakeSessionState(states, sessionFile);
      return {
        leafId: state.leafId,
        latestCompactionId: latestFakeCompactionEntry(state.entries)?.id ?? null,
      };
    },
    canMergeCheckpointIntoLiveSession({
      sessionFile,
      baseLeafId,
      baseLatestCompactionId,
    }) {
      const state = requireFakeSessionState(states, sessionFile);
      if (baseLeafId && !state.entries.some((entry) => entry.id === baseLeafId)) {
        return false;
      }
      return (
        (latestFakeCompactionEntry(state.entries)?.id ?? null) ===
        (baseLatestCompactionId ?? null)
      );
    },
    appendSnapshotCompactionToLiveSession({
      liveSessionFile,
      snapshotSessionFile,
    }) {
      const liveState = requireFakeSessionState(states, liveSessionFile);
      const snapshotState = requireFakeSessionState(states, snapshotSessionFile);
      const snapshotCompaction = latestFakeCompactionEntry(snapshotState.entries);
      if (!snapshotCompaction?.firstKeptEntryId) {
        return false;
      }
      if (
        !liveState.entries.some(
          (entry) => entry.id === snapshotCompaction.firstKeptEntryId,
        )
      ) {
        return false;
      }
      appendFakeCompaction({
        states,
        sessionFile: liveSessionFile,
        summary: snapshotCompaction.summary ?? "",
        firstKeptEntryId: snapshotCompaction.firstKeptEntryId,
        tokensBefore: snapshotCompaction.tokensBefore ?? 0,
        details: snapshotCompaction.details,
        fromHook: snapshotCompaction.fromHook,
      });
      return true;
    },
  };
}

function makeStore(prefix: string): {
  store: RuntimeStateStore;
  root: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspaceRoot = path.join(root, "workspace");
  const sandboxRoot = root;
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(sandboxRoot, "state"), { recursive: true });
  return {
    store: new RuntimeStateStore({
      workspaceRoot,
      sandboxRoot,
      dbPath: path.join(sandboxRoot, "state", "runtime.db"),
    }),
    root,
  };
}

test("session checkpoint merges snapshot compaction into a live session that only appended new entries", async () => {
  const { store, root } = makeStore("hb-session-checkpoint-merge-");
  const sessions = new Map<string, FakeSessionState>();
  const sessionOps = createFakeSessionOps(sessions);
  try {
    const workspace = store.createWorkspace({
      workspaceId: "workspace-1",
      name: "Workspace 1",
      harness: "pi",
      status: "active",
    });
    const workspaceDir = store.workspaceDir(workspace.id);
    fs.mkdirSync(workspaceDir, { recursive: true });

    const liveSessionFile = createFakeSessionFile(root, sessions);
    appendFakeMessage(sessions, liveSessionFile);
    const baseLeafId = appendFakeMessage(sessions, liveSessionFile);

    store.upsertBinding({
      workspaceId: workspace.id,
      sessionId: "session-main",
      harness: "pi",
      harnessSessionId: liveSessionFile,
    });
    store.upsertTurnResult({
      workspaceId: workspace.id,
      sessionId: "session-main",
      inputId: "input-1",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: "completed",
      stopReason: "success",
      assistantText: "done",
      toolUsageSummary: {},
      permissionDenials: [],
      promptSectionIds: [],
      capabilityManifestFingerprint: null,
      requestSnapshotFingerprint: "snap-1",
      promptCacheProfile: null,
      tokenUsage: null,
      createdAt: new Date().toISOString(),
    });
    store.upsertTurnRequestSnapshot({
      workspaceId: workspace.id,
      sessionId: "session-main",
      inputId: "input-1",
      snapshotKind: "harness_host_request",
      fingerprint: "snap-1",
      payload: {
        harness_request: {
          workspace_id: workspace.id,
          session_id: "session-main",
          input_id: "input-1",
        },
      },
    });

    const queued = enqueueSessionCheckpointJob({
      store,
      workspaceId: workspace.id,
      sessionId: "session-main",
      inputId: "input-1",
      harness: "pi",
      harnessSessionId: liveSessionFile,
      contextUsage: {
        tokens: 50_000,
        contextWindow: 65_536,
        percent: 76.3,
      },
      sessionOps,
    });
    assert.ok(queued);

    appendFakeMessage(sessions, liveSessionFile);

    await processSessionCheckpointJob({
      store,
      record: queued!,
      sessionOps,
      runPiSessionCompactionFn: async (requestPayload) => {
        const snapshotPath = String(requestPayload.harness_session_id);
        cloneFakeSession(sessions, liveSessionFile, snapshotPath);
        const firstKeptEntryId =
          requireFakeSessionState(sessions, snapshotPath).entries[0]?.id ??
          baseLeafId ??
          "";
        appendFakeCompaction({
          states: sessions,
          sessionFile: snapshotPath,
          summary: "Compacted older context.",
          firstKeptEntryId,
          tokensBefore: 12345,
          details: { modifiedFiles: ["src/example.ts"] },
          fromHook: false,
        });
        return {
          compacted: true,
          session_file: snapshotPath,
        };
      },
    });

    const binding = store.getBinding({
      workspaceId: workspace.id,
      sessionId: "session-main",
    });
    assert.equal(binding?.harnessSessionId, liveSessionFile);

    const branch = requireFakeSessionState(sessions, liveSessionFile).entries;
    const latestEntry = branch.at(-1);
    assert.ok(latestEntry);
    assert.equal(latestEntry?.type, "compaction");
    assert.equal(latestEntry.summary, "Compacted older context.");
    assert.ok(branch.some((entry: FakeSessionEntry) => entry.id === baseLeafId));

    const updatedJob = store.getPostRunJob({ workspaceId: workspace.id, jobId: queued!.jobId });
    assert.equal(
      (
        updatedJob?.payload.checkpoint_result as { outcome?: string } | undefined
      )?.outcome,
      "merged_without_boundary",
    );
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("session checkpoint re-resolves model client auth while preserving snapshot proxy context headers", async () => {
  const { store, root } = makeStore("hb-session-checkpoint-auth-");
  const sessions = new Map<string, FakeSessionState>();
  const sessionOps = createFakeSessionOps(sessions);
  try {
    const workspace = store.createWorkspace({
      workspaceId: "workspace-auth",
      name: "Workspace Auth",
      harness: "pi",
      status: "active",
    });
    const workspaceDir = store.workspaceDir(workspace.id);
    fs.mkdirSync(workspaceDir, { recursive: true });

    const liveSessionFile = createFakeSessionFile(root, sessions);
    appendFakeMessage(sessions, liveSessionFile);
    appendFakeMessage(sessions, liveSessionFile);

    store.upsertBinding({
      workspaceId: workspace.id,
      sessionId: "session-auth",
      harness: "pi",
      harnessSessionId: liveSessionFile,
    });
    store.upsertTurnResult({
      workspaceId: workspace.id,
      sessionId: "session-auth",
      inputId: "input-auth",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: "completed",
      stopReason: "success",
      assistantText: "done",
      toolUsageSummary: {},
      permissionDenials: [],
      promptSectionIds: [],
      capabilityManifestFingerprint: null,
      requestSnapshotFingerprint: "snap-auth",
      promptCacheProfile: null,
      tokenUsage: null,
      createdAt: new Date().toISOString(),
    });
    store.upsertTurnRequestSnapshot({
      workspaceId: workspace.id,
      sessionId: "session-auth",
      inputId: "input-auth",
      snapshotKind: "harness_host_request",
      fingerprint: "snap-auth",
      payload: {
        runtime_config: {
          provider_id: "openai_codex",
          model_id: "gpt-5.4",
        },
        harness_request: {
          workspace_id: workspace.id,
          session_id: "session-auth",
          input_id: "input-auth",
          provider_id: "openai",
          model_id: "gpt-5.4",
          model_client: {
            api_key: "[redacted]",
            base_url: "http://127.0.0.1:3060/api/v1/model-proxy/openai/v1",
            default_headers: {
              "X-API-Key": "[redacted]",
              "X-Holaboss-User-Id": "user-auth",
              "X-Holaboss-Sandbox-Id": "sandbox-auth",
              "X-Holaboss-Workspace-Id": workspace.id,
              "X-Holaboss-Session-Id": "session-auth",
              "X-Holaboss-Input-Id": "input-auth",
              "X-Holaboss-Run-Id": `${workspace.id}:session-auth:input-auth`,
            },
          },
        },
      },
    });

    const queued = enqueueSessionCheckpointJob({
      store,
      workspaceId: workspace.id,
      sessionId: "session-auth",
      inputId: "input-auth",
      harness: "pi",
      harnessSessionId: liveSessionFile,
      contextUsage: {
        tokens: 50_000,
        contextWindow: 65_536,
        percent: 76.3,
      },
      sessionOps,
    });
    assert.ok(queued);

    let observedRequest: Record<string, unknown> | null = null;
    await processSessionCheckpointJob({
      store,
      record: queued!,
      sessionOps,
      resolveRuntimeModelClientFn: () => ({
        providerId: "openai",
        configuredProviderId: "holaboss_model_proxy",
        modelId: "gpt-5.4",
        modelToken: "openai/gpt-5.4",
        modelProxyProvider: "openai_compatible",
        modelClient: {
          model_proxy_provider: "openai_compatible",
          api_key: "real-proxy-token",
          base_url: "http://127.0.0.1:3060/api/v1/model-proxy/openai/v1",
          default_headers: null,
        },
      }),
      runPiSessionCompactionFn: async (requestPayload) => {
        observedRequest = requestPayload;
        const snapshotPath = String(requestPayload.harness_session_id);
        cloneFakeSession(sessions, liveSessionFile, snapshotPath);
        const firstKeptEntryId =
          requireFakeSessionState(sessions, snapshotPath).entries[0]?.id ?? "";
        appendFakeCompaction({
          states: sessions,
          sessionFile: snapshotPath,
          summary: "Compacted with fresh auth.",
          firstKeptEntryId,
          tokensBefore: 12345,
          details: {},
          fromHook: false,
        });
        return {
          compacted: true,
          session_file: snapshotPath,
        };
      },
    });

    assert.ok(observedRequest);
    const observedRequestRecord = observedRequest as Record<string, unknown>;
    const observedModelClient =
      "model_client" in observedRequestRecord && observedRequestRecord.model_client
        ? (observedRequestRecord.model_client as {
            api_key?: string;
            default_headers?: Record<string, string> | null;
          })
        : undefined;
    assert.equal(observedModelClient?.api_key, "real-proxy-token");
    assert.deepEqual(observedModelClient?.default_headers, {
      "X-API-Key": "real-proxy-token",
      "X-Holaboss-User-Id": "user-auth",
      "X-Holaboss-Sandbox-Id": "sandbox-auth",
      "X-Holaboss-Workspace-Id": workspace.id,
      "X-Holaboss-Session-Id": "session-auth",
      "X-Holaboss-Input-Id": "input-auth",
      "X-Holaboss-Run-Id": `${workspace.id}:session-auth:input-auth`,
    });

    const updatedJob = store.getPostRunJob({ workspaceId: workspace.id, jobId: queued!.jobId });
    assert.equal(
      (
        updatedJob?.payload.checkpoint_result as { outcome?: string } | undefined
      )?.outcome,
      "merged_without_boundary",
    );
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("session checkpoint records not_compacted when PI reports a compaction no-op", async () => {
  const { store, root } = makeStore("hb-session-checkpoint-not-compacted-");
  const sessions = new Map<string, FakeSessionState>();
  const sessionOps = createFakeSessionOps(sessions);
  try {
    const workspace = store.createWorkspace({
      workspaceId: "workspace-not-compacted",
      name: "Workspace Not Compacted",
      harness: "pi",
      status: "active",
    });
    const workspaceDir = store.workspaceDir(workspace.id);
    fs.mkdirSync(workspaceDir, { recursive: true });

    const liveSessionFile = createFakeSessionFile(root, sessions);
    appendFakeMessage(sessions, liveSessionFile);
    appendFakeMessage(sessions, liveSessionFile);

    store.upsertBinding({
      workspaceId: workspace.id,
      sessionId: "session-not-compacted",
      harness: "pi",
      harnessSessionId: liveSessionFile,
    });
    store.upsertTurnResult({
      workspaceId: workspace.id,
      sessionId: "session-not-compacted",
      inputId: "input-not-compacted",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: "completed",
      stopReason: "success",
      assistantText: "done",
      toolUsageSummary: {},
      permissionDenials: [],
      promptSectionIds: [],
      capabilityManifestFingerprint: null,
      requestSnapshotFingerprint: "snap-not-compacted",
      promptCacheProfile: null,
      tokenUsage: null,
      createdAt: new Date().toISOString(),
    });
    store.upsertTurnRequestSnapshot({
      workspaceId: workspace.id,
      sessionId: "session-not-compacted",
      inputId: "input-not-compacted",
      snapshotKind: "harness_host_request",
      fingerprint: "snap-not-compacted",
      payload: {
        harness_request: {
          workspace_id: workspace.id,
          session_id: "session-not-compacted",
          input_id: "input-not-compacted",
        },
      },
    });

    const queued = enqueueSessionCheckpointJob({
      store,
      workspaceId: workspace.id,
      sessionId: "session-not-compacted",
      inputId: "input-not-compacted",
      harness: "pi",
      harnessSessionId: liveSessionFile,
      contextUsage: {
        tokens: 50_000,
        contextWindow: 65_536,
        percent: 76.3,
      },
      sessionOps,
    });
    assert.ok(queued);

    await processSessionCheckpointJob({
      store,
      record: queued!,
      sessionOps,
      runPiSessionCompactionFn: async (requestPayload) => ({
        compacted: false,
        session_file: String(requestPayload.harness_session_id),
        reason: "already_compacted",
      }),
    });

    const updatedJob = store.getPostRunJob({ workspaceId: workspace.id, jobId: queued!.jobId });
    assert.equal(
      (
        updatedJob?.payload.checkpoint_result as
          | { outcome?: string; reason?: string | null }
          | undefined
      )?.outcome,
      "not_compacted",
    );
    assert.equal(
      (
        updatedJob?.payload.checkpoint_result as
          | { outcome?: string; reason?: string | null }
          | undefined
      )?.reason,
      "already_compacted",
    );
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("session checkpoint treats provider 422 summarization failures as a soft no-op and records compaction diagnostics", async () => {
  const { store, root } = makeStore("hb-session-checkpoint-soft-422-");
  const sessions = new Map<string, FakeSessionState>();
  const sessionOps = createFakeSessionOps(sessions);
  try {
    const workspace = store.createWorkspace({
      workspaceId: "workspace-soft-422",
      name: "Workspace Soft 422",
      harness: "pi",
      status: "active",
    });
    const workspaceDir = store.workspaceDir(workspace.id);
    fs.mkdirSync(workspaceDir, { recursive: true });

    const liveSessionFile = createFakeSessionFile(root, sessions);
    appendFakeMessage(sessions, liveSessionFile);
    appendFakeMessage(sessions, liveSessionFile);

    store.upsertBinding({
      workspaceId: workspace.id,
      sessionId: "session-soft-422",
      harness: "pi",
      harnessSessionId: liveSessionFile,
    });
    store.upsertTurnResult({
      workspaceId: workspace.id,
      sessionId: "session-soft-422",
      inputId: "input-soft-422",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: "completed",
      stopReason: "success",
      assistantText: "working on it",
      toolUsageSummary: {},
      permissionDenials: [],
      promptSectionIds: [],
      capabilityManifestFingerprint: null,
      requestSnapshotFingerprint: "snap-soft-422",
      promptCacheProfile: null,
      tokenUsage: null,
      createdAt: new Date().toISOString(),
    });
    store.upsertTurnRequestSnapshot({
      workspaceId: workspace.id,
      sessionId: "session-soft-422",
      inputId: "input-soft-422",
      snapshotKind: "harness_host_request",
      fingerprint: "snap-soft-422",
      payload: {
        harness_request: {
          workspace_id: workspace.id,
          session_id: "session-soft-422",
          input_id: "input-soft-422",
        },
      },
    });

    const queued = enqueueSessionCheckpointJob({
      store,
      workspaceId: workspace.id,
      sessionId: "session-soft-422",
      inputId: "input-soft-422",
      harness: "pi",
      harnessSessionId: liveSessionFile,
      contextUsage: {
        tokens: 50_000,
        contextWindow: 65_536,
        percent: 76.3,
      },
      sessionOps,
    });
    assert.ok(queued);
    const sentryCaptures: RuntimeSentryCaptureOptions[] = [];

    await processSessionCheckpointJob({
      store,
      record: queued!,
      sessionOps,
      captureRuntimeExceptionFn: (capture) => {
        sentryCaptures.push(capture);
      },
      runPiSessionCompactionFn: async () => {
        const error = new Error("Summarization failed: 422 status code (no body)") as Error & {
          commandResult?: Record<string, unknown>;
        };
        error.commandResult = {
          compacted: false,
          session_file: liveSessionFile,
          diagnostics: {
            preparation: {
              status: "ready",
              is_split_turn: true,
              first_kept_entry_id: "entry-2",
            },
            compaction_end: {
              error_message:
                "Compaction failed: Turn prefix summarization failed: 422 status code (no body)",
            },
          },
          error: {
            name: "APIError",
            message: "Summarization failed: 422 status code (no body)",
            status_code: 422,
            provider_message: "422 status code (no body)",
          },
        };
        throw error;
      },
    });

    const branch = requireFakeSessionState(sessions, liveSessionFile).entries;
    assert.equal(branch.at(-1)?.type, "message");

    const updatedJob = store.getPostRunJob({ workspaceId: workspace.id, jobId: queued!.jobId });
    assert.equal(
      (
        updatedJob?.payload.checkpoint_result as { outcome?: string } | undefined
      )?.outcome,
      "soft_provider_422",
    );
    assert.equal(sentryCaptures.length, 1);
    assert.equal(sentryCaptures[0]?.tags?.failure_kind, "soft_provider_422");
    assert.equal(sentryCaptures[0]?.tags?.surface, "session_checkpoint");
    assert.equal(
      sentryCaptures[0]?.contexts?.session_checkpoint?.input_id,
      "input-soft-422",
    );
    assert.deepEqual(
      (
        updatedJob?.payload.checkpoint_result as
          | { compaction?: Record<string, unknown> | null }
          | undefined
      )?.compaction,
      {
        session_file: liveSessionFile,
        reason: null,
        diagnostics: {
          preparation: {
            status: "ready",
            is_split_turn: true,
            first_kept_entry_id: "entry-2",
          },
          compaction_end: {
            error_message:
              "Compaction failed: Turn prefix summarization failed: 422 status code (no body)",
          },
        },
        result: null,
        error: {
          name: "APIError",
          message: "Summarization failed: 422 status code (no body)",
          status_code: 422,
          provider_message: "422 status code (no body)",
        },
      },
    );
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
