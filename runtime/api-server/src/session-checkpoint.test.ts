import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";
import { seedWorkspaceRecord } from "./__test-helpers__/seed-workspace.js";

import {
  forceCompactSessionWithSnapshotMerge,
  type SessionCheckpointSessionOps,
} from "./session-checkpoint.js";

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
  let state = states.get(sessionFile);
  if (!state && fs.existsSync(sessionFile)) {
    const entries = fs
      .readFileSync(sessionFile, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown)
      .filter(
        (entry): entry is FakeSessionEntry =>
          typeof entry === "object" &&
          entry !== null &&
          "type" in entry &&
          (entry as { type?: string }).type !== "header",
      );
    state = {
      entries,
      leafId: entries.at(-1)?.id ?? null,
    };
    states.set(sessionFile, state);
  }
  assert.ok(state, `missing fake session state for ${sessionFile}`);
  return state;
}

function appendFakeMessage(
  states: Map<string, FakeSessionState>,
  sessionFile: string,
): string {
  const state = requireFakeSessionState(states, sessionFile);
  const id = nextFakeEntryId();
  const entry = {
    id,
    type: "message",
  } satisfies FakeSessionEntry;
  state.entries.push(entry);
  state.leafId = id;
  fs.appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
  return id;
}


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
  const entry = {
    id,
    type: "compaction",
    summary: params.summary,
    firstKeptEntryId: params.firstKeptEntryId,
    tokensBefore: params.tokensBefore,
    details: params.details,
    fromHook: params.fromHook,
  } satisfies FakeSessionEntry;
  state.entries.push(entry);
  state.leafId = id;
  fs.appendFileSync(params.sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
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

function rewriteFakeSessionFile(
  states: Map<string, FakeSessionState>,
  sessionFile: string,
): void {
  const state = requireFakeSessionState(states, sessionFile);
  const lines = [
    JSON.stringify({ type: "header" }),
    ...state.entries.map((entry) => JSON.stringify(entry)),
  ];
  fs.writeFileSync(sessionFile, `${lines.join("\n")}\n`, "utf8");
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
    lastBranchEntryType(sessionFile) {
      const state = requireFakeSessionState(states, sessionFile);
      return state.entries.at(-1)?.type ?? null;
    },
    stripTrailingCompactionEntries(sessionFile) {
      const state = requireFakeSessionState(states, sessionFile);
      let removed = 0;
      while (state.entries.at(-1)?.type === "compaction") {
        state.entries.pop();
        removed += 1;
      }
      if (removed > 0) {
        state.leafId = state.entries.at(-1)?.id ?? null;
        rewriteFakeSessionFile(states, sessionFile);
      }
      return removed;
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
      while (liveState.entries.at(-1)?.type === "compaction") {
        liveState.entries.pop();
      }
      liveState.leafId = liveState.entries.at(-1)?.id ?? null;
      rewriteFakeSessionFile(states, liveSessionFile);
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

test("forceCompactSessionWithSnapshotMerge retries after stripping a trailing compaction boundary", async () => {
  const { store, root } = makeStore("hb-session-checkpoint-recompact-");
  const sessions = new Map<string, FakeSessionState>();
  const sessionOps = createFakeSessionOps(sessions);
  try {
    const workspace = seedWorkspaceRecord(store, {
      workspaceId: "workspace-recompact",
      name: "Workspace Recompact",
      harness: "pi",
      status: "active",
    });
    const workspaceDir = store.workspaceDir(workspace.id);
    fs.mkdirSync(workspaceDir, { recursive: true });

    const liveSessionFile = createFakeSessionFile(root, sessions);
    const firstKeptEntryId = appendFakeMessage(sessions, liveSessionFile);
    appendFakeMessage(sessions, liveSessionFile);
    appendFakeCompaction({
      states: sessions,
      sessionFile: liveSessionFile,
      summary: "Existing compaction",
      firstKeptEntryId,
      tokensBefore: 120_000,
    });

    store.upsertBinding({
      workspaceId: workspace.id,
      sessionId: "session-recompact",
      harness: "pi",
      harnessSessionId: liveSessionFile,
    });
    store.upsertTurnRequestSnapshot({
      workspaceId: workspace.id,
      sessionId: "session-recompact",
      inputId: "input-recompact",
      snapshotKind: "harness_host_request",
      fingerprint: "snap-recompact",
      payload: {
        harness_request: {
          workspace_id: workspace.id,
          session_id: "session-recompact",
          input_id: "input-recompact",
        },
      },
    });

    const liveState = sessionOps.currentLeafCheckpointState(liveSessionFile);
    let compactionCalls = 0;
    const result = await forceCompactSessionWithSnapshotMerge({
      store,
      workspaceId: workspace.id,
      sessionId: "session-recompact",
      inputId: "input-recompact",
      harnessSessionId: liveSessionFile,
      baseLeafId: liveState.leafId,
      baseLatestCompactionId: liveState.latestCompactionId,
      sessionOps,
      runPiSessionCompactionFn: async (requestPayload) => {
        compactionCalls += 1;
        const snapshotSessionFile = String(requestPayload.harness_session_id);
        if (compactionCalls === 1) {
          return {
            compacted: false,
            session_file: snapshotSessionFile,
            reason: "already_compacted",
          };
        }
        appendFakeCompaction({
          states: sessions,
          sessionFile: snapshotSessionFile,
          summary: "Retightened compaction",
          firstKeptEntryId,
          tokensBefore: 90_000,
        });
        return {
          compacted: true,
          session_file: snapshotSessionFile,
          result: {
            summary: "Retightened compaction",
            firstKeptEntryId,
            tokensBefore: 90_000,
          },
          reason: null,
          diagnostics: {
            context_usage: {
              tokens: 32_000,
              contextWindow: 65_536,
              percent: 48.8,
            },
          },
          error: null,
        };
      },
    });

    assert.equal(compactionCalls, 2);
    assert.equal(result.outcome, "merged_without_boundary");
    assert.equal(result.merged, true);
    assert.equal(result.lastBranchEntryType, "compaction");
    assert.equal(result.retryAttempted, true);
    assert.equal(result.strippedTrailingCompactions, 1);
    const liveEntries = requireFakeSessionState(sessions, liveSessionFile).entries;
    assert.equal(
      liveEntries.filter((entry) => entry.type === "compaction").length,
      1,
    );
    assert.equal(latestFakeCompactionEntry(liveEntries)?.summary, "Retightened compaction");
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
