import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "./store.js";

const tempDirs: string[] = [];
const workspaceId = "workspace-1";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore(): RuntimeStateStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-evaluations-store-"));
  tempDirs.push(root);
  return new RuntimeStateStore({ dbPath: path.join(root, "runtime.db"), workspaceRoot: path.join(root, "workspace") });
}

test("evaluation round trip: create, update, find by session, list, delete cascades", () => {
  const store = makeStore();
  const created = store.createEvaluation({
    workspaceId,
    title: "MiniCPM5-2B on a laptop",
    questionType: "single_model",
    question: "Is MiniCPM5-2B usable as a local agent brain on a 48GB laptop?",
    brainModel: "holaboss_model_proxy/gpt-5.5",
  });
  assert.match(created.evalId, /^eval-/);
  assert.equal(created.status, "draft");
  assert.equal(created.plan, null);
  assert.equal(created.includeRawData, true);
  assert.equal(created.opinionMd, "");

  const plan = { runs: [{ key: "q4", label: "Q4_K_M", kinds: ["speed"] }], estimate_minutes: 5 };
  const updated = store.updateEvaluation({
    workspaceId,
    evalId: created.evalId,
    status: "planned",
    plan,
    sessionId: "session-1",
    includeRawData: false,
    opinionMd: "Fast enough: {{speed.q4.decode_tps@0}} tok/s",
  });
  assert.equal(updated?.status, "planned");
  assert.deepEqual(updated?.plan, plan);
  assert.equal(updated?.includeRawData, false);
  assert.equal(store.getEvaluationBySessionId({ workspaceId, sessionId: "session-1" })?.evalId, created.evalId);
  assert.equal(store.updateEvaluation({ workspaceId, evalId: "eval-missing", status: "planned" }), null);

  const run = store.createEvaluationRun({
    workspaceId,
    evalId: created.evalId,
    runKey: "q4",
    kind: "speed",
    label: "Q4_K_M",
    spec: { target: { model_id: "m" } },
  });
  assert.equal(run.status, "queued");
  const running = store.updateEvaluationRun({
    workspaceId,
    runId: run.runId,
    status: "running",
    progress: { done: 1, total: 3 },
    startedAt: "2026-10-11T00:00:00.000Z",
  });
  assert.deepEqual(running?.progress, { done: 1, total: 3 });
  assert.deepEqual(
    store.listEvaluationRuns({ workspaceId, statuses: ["running"] }).map((entry) => entry.runId),
    [run.runId],
  );

  const proposal = store.createEvaluationProposal({
    workspaceId,
    evalId: created.evalId,
    title: "Re-run with thinking off",
    rationale: "Long answers hit max_tokens",
    evidence: [{ run_key: "q4", task_id: "math-01" }],
    runs: [{ key: "q4-nothink" }],
    estimateMinutes: 4.4,
    createdBy: "agent",
  });
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.estimateMinutes, 4);
  const approved = store.setEvaluationProposalStatus({ workspaceId, proposalId: proposal.proposalId, status: "approved" });
  assert.equal(approved?.status, "approved");
  assert.ok(approved?.decidedAt);

  store.addEvaluationRevision({ workspaceId, evalId: created.evalId, opinionMd: "v1", author: "agent" });
  store.addEvaluationRevision({ workspaceId, evalId: created.evalId, opinionMd: "v2", author: "user" });
  assert.deepEqual(
    store.listEvaluationRevisions({ workspaceId, evalId: created.evalId }).map((entry) => entry.opinionMd),
    ["v2", "v1"],
  );

  const second = store.createEvaluation({
    workspaceId,
    title: "Second",
    questionType: "comparison",
    question: "Q?",
    parentEvalId: created.evalId,
    relation: "version",
  });
  assert.deepEqual(
    store.listEvaluations({ workspaceId }).map((entry) => entry.evalId),
    [second.evalId, created.evalId],
  );

  assert.equal(store.deleteEvaluation({ workspaceId, evalId: created.evalId }), true);
  assert.equal(store.getEvaluation({ workspaceId, evalId: created.evalId }), null);
  assert.deepEqual(store.listEvaluationRuns({ workspaceId, evalId: created.evalId }), []);
  assert.deepEqual(store.listEvaluationProposals({ workspaceId, evalId: created.evalId }), []);
  assert.deepEqual(store.listEvaluationRevisions({ workspaceId, evalId: created.evalId }), []);
});

test("deleteEvaluationRuns removes only the given statuses", () => {
  const store = makeStore();
  const evaluation = store.createEvaluation({ workspaceId, title: "T", questionType: "hardware", question: "Q?" });
  const spec = {};
  const queued = store.createEvaluationRun({ workspaceId, evalId: evaluation.evalId, runKey: "a", kind: "speed", label: "A", spec });
  const done = store.createEvaluationRun({ workspaceId, evalId: evaluation.evalId, runKey: "a", kind: "capability", label: "A", spec });
  store.updateEvaluationRun({ workspaceId, runId: done.runId, status: "done" });
  assert.equal(store.deleteEvaluationRuns({ workspaceId, evalId: evaluation.evalId, statuses: ["queued"] }), 1);
  assert.deepEqual(
    store.listEvaluationRuns({ workspaceId, evalId: evaluation.evalId }).map((entry) => entry.runId),
    [done.runId],
  );
  assert.equal(store.getEvaluationRun({ workspaceId, runId: queued.runId }), null);
});
