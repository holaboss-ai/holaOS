import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import { EvaluationEngine, type EvaluationSettledEvent } from "./evaluation-engine.js";
import { EvaluationService, EvaluationServiceError, type EvalTargetOption } from "./evaluation-service.js";

const workspaceId = "workspace-1";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const target: EvalTargetOption = {
  provider_id: "local_llamacpp_8000",
  model_id: "MiniCPM5-2B-Q4_K_M",
  base_url: "http://127.0.0.1:8000/v1",
  engine: "llamacpp",
  context_window: 32768,
  token: "local_llamacpp_8000/MiniCPM5-2B-Q4_K_M",
};

function argValue(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? "") : "";
}

function fakeHolaeval(options: { failKind?: string } = {}) {
  const calls: string[][] = [];
  const spawnImpl = (_command: string, args: string[]) => {
    calls.push(args);
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    const subcommand = args[2];
    const out = argValue(args, "--out");
    const label = argValue(args, "--label");
    setImmediate(() => {
      let code = 0;
      if (subcommand === "probe") {
        child.stdout.write(
          `${JSON.stringify({
            engine: "llamacpp",
            engine_version: "b6000",
            server_props: { model_path: `/Users/${os.userInfo().username}/models/MiniCPM5-2B-Q4_K_M.gguf` },
            models: [{ id: target.model_id, context_window: 32768 }],
            machine: { cpu: "Test CPU", memory_gb: 48, power: "AC", platform: "test" },
          })}\n`,
        );
      } else if (subcommand === options.failKind) {
        child.stderr.write("Traceback\nConnectionRefusedError: boom\n");
        code = 1;
      } else if (subcommand === "speed") {
        const depths = [
          { depth: 0, ttft_s: 0.12, decode_tps: 110.2, engine_decode_tps: 114.5, engine_prefill_tps: 900.1 },
          { depth: 8192, ttft_s: 2.4, engine_decode_tps: 98.1, engine_prefill_tps: 3400 },
          { depth: 32768, skipped: "context window 32768 too small" },
        ];
        for (const row of depths) child.stdout.write(`${JSON.stringify(row)}\n`);
        fs.writeFileSync(path.join(out, `speed-${label}.json`), JSON.stringify({ label, depths }));
      } else if (subcommand === "run") {
        child.stdout.write("[1/2] math-01#0 PASS 1.0s\n[2/2] code-01#0 FAIL 2.0s (tests failed)\n");
        fs.writeFileSync(
          path.join(out, `summary-${label}.json`),
          JSON.stringify({
            label,
            pack: "general-v1",
            pack_version: 1,
            by_category: { math: { passed: 3, n: 3 }, code: { passed: 1, n: 3 } },
            by_task: {
              "math-01": { category: "math", passed: 3, n: 3, reasons: {} },
              "code-01": { category: "code", passed: 1, n: 3, reasons: { "tests failed": 2 } },
            },
            skipped: [],
          }),
        );
        fs.writeFileSync(path.join(out, `tasks-${label}.jsonl`), `${JSON.stringify({ id: "math-01", passed: true })}\n`);
      } else if (subcommand === "agent") {
        child.stdout.write("[1/1] read-config#0/full PASS 3.0s\n");
        fs.writeFileSync(
          path.join(out, `agent-summary-${label}.json`),
          JSON.stringify({
            label,
            pack: "agent-v1",
            pack_version: 1,
            conditions: {
              full: { passed: 4, n: 8, prompt_tokens_avg: 14800, first_response_s_avg: 6.2 },
              lean: { passed: 7, n: 8, prompt_tokens_avg: 1900, first_response_s_avg: 1.1 },
            },
            skipped: [],
          }),
        );
      }
      child.stdout.end();
      child.stderr.end();
      child.emit("close", code);
    });
    return child as never;
  };
  return { spawnImpl, calls };
}

function setup(options: { failKind?: string; isBlocked?: () => boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-evaluation-service-"));
  tempDirs.push(root);
  const store = new RuntimeStateStore({ dbPath: path.join(root, "runtime.db"), workspaceRoot: path.join(root, "workspace") });
  const queued: Array<{ sessionId: string; text: string; model: string | null }> = [];
  const settled: EvaluationSettledEvent[] = [];
  const fake = fakeHolaeval(options);
  let sessionCounter = 0;
  const evalDir = (evalId: string) => path.join(root, "workspace", "evals", evalId);
  const engine = new EvaluationEngine({
    store,
    workspaceId: () => workspaceId,
    evalDir,
    holaevalPath: () => "/bundle/holaeval.py",
    env: () => ({ ...process.env }),
    spawnImpl: fake.spawnImpl,
    fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    isBlocked: options.isBlocked,
    onSettled: (event) => {
      settled.push(event);
      void service.onRunsSettled(event);
    },
  });
  engine.wake = () => undefined;
  const service: EvaluationService = new EvaluationService({
    store,
    engine,
    workspaceId: () => workspaceId,
    evalDir,
    localTargets: () => [target],
    defaultModel: () => "holaboss_model_proxy/gpt-5.5",
    createSession: ({ title }) => {
      sessionCounter += 1;
      const sessionId = `session-${sessionCounter}`;
      store.ensureSession({ workspaceId, sessionId, kind: "main_session", title });
      return sessionId;
    },
    queueSessionMessage: async (message) => {
      queued.push(message);
    },
    redactionIdentity: () => ({ hostnames: ["devbox.local", "devbox"], usernames: [os.userInfo().username] }),
    now: () => "2026-10-11T08:00:00.000Z",
  });
  return { store, engine, service, queued, settled, fake, root, evalDir };
}

const planTarget = {
  provider_id: target.provider_id,
  model_id: target.model_id,
  base_url: target.base_url,
  engine: target.engine,
};

const fullPlan = {
  runs: [
    { key: "q4", label: "Q4_K_M", target: planTarget, kinds: ["speed", "capability", "agent"], samples: 3 },
  ],
};

async function startAndDrain(context: ReturnType<typeof setup>, evalId: string) {
  context.service.start({ evalId });
  await context.engine.drainForTest();
}

test("create queues a planning message in a new bound session", async () => {
  const context = setup();
  const created = await context.service.create({
    questionType: "single_model",
    question: "Is MiniCPM5-2B usable as a local agent brain on a 48GB laptop?",
    targets: [planTarget],
  });
  assert.equal(created.status, "draft");
  assert.equal(created.session_id, "session-1");
  assert.equal(context.queued.length, 1);
  assert.match(context.queued[0]?.text ?? "", /eval_set_plan/);
  assert.match(context.queued[0]?.text ?? "", /MiniCPM5-2B-Q4_K_M/);
  assert.match(context.service.agentContext("session-1") ?? "", /Evaluation mode/);
  assert.equal(context.service.agentContext("session-unrelated"), null);
});

test("start requires the standard pack for every model; comparisons need two runs", async () => {
  const context = setup();
  const created = await context.service.create({ questionType: "comparison", question: "A or B?" });
  const evalId = String(created.eval_id);
  assert.throws(
    () => context.service.setPlan({ evalId, plan: fullPlan }),
    (error: unknown) => error instanceof EvaluationServiceError && /at least two runs/.test(error.message),
  );
  context.service.setPlan({
    evalId,
    plan: {
      runs: [
        { key: "a", label: "A", target: planTarget, kinds: ["speed"] },
        { key: "b", label: "B", target: planTarget, kinds: ["capability"], sampling: { temperature: 0.7 } },
      ],
    },
  });
  assert.throws(
    () => context.service.start({ evalId }),
    (error: unknown) => error instanceof EvaluationServiceError && /missing agent/.test(error.message),
  );
  assert.throws(
    () =>
      context.service.setPlan({
        evalId,
        plan: { runs: [fullPlan.runs[0], { ...fullPlan.runs[0], label: "dup" }] },
      }),
    (error: unknown) => error instanceof EvaluationServiceError && /used twice/.test(error.message),
  );
});

test("a full run: engine executes serially, settles to analyzing and notifies the analyst", async () => {
  const context = setup();
  const created = await context.service.create({ questionType: "single_model", question: "Usable?" });
  const evalId = String(created.eval_id);
  context.service.setPlan({ evalId, plan: fullPlan });
  await startAndDrain(context, evalId);

  const detail = context.service.get({ evalId }) as { evaluation: { status: string }; runs: Array<Record<string, unknown>> };
  assert.equal(detail.evaluation.status, "analyzing");
  assert.deepEqual(
    detail.runs.map((run) => [run.kind, run.status]),
    [
      ["speed", "done"],
      ["capability", "done"],
      ["agent", "done"],
    ],
  );
  const subcommands = context.fake.calls.map((args) => args[2]);
  assert.deepEqual(subcommands, ["probe", "speed", "run", "agent"]);
  const speedArgs = context.fake.calls[1] ?? [];
  assert.equal(argValue(speedArgs, "--context-window"), "32768");
  assert.equal(argValue(context.fake.calls[3] ?? [], "--conditions"), "full,lean");
  assert.equal(context.settled.length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(context.queued.at(-1)?.text ?? "", /\[Evaluation update\] All planned runs are done/);

  const report = context.service.report({ evalId }) as Record<string, unknown>;
  const placeholders = report.placeholders as Array<{ key: string; value: unknown }>;
  assert.ok(placeholders.some((entry) => entry.key === "speed.q4.decode_tps@0" && entry.value === 114.5));
  assert.ok(placeholders.some((entry) => entry.key === "capability.q4.overall.rate" && entry.value === "66.7%"));
  assert.ok(placeholders.some((entry) => entry.key === "agent.q4.lean.rate" && entry.value === "87.5%"));
  assert.match(String(report.markdown), /\| Q4_K_M \| empty context \| 0.12 \| 900.1 \| 114.5 \|/);
  assert.match(String(report.markdown), /not measured: context window 32768 too small/);
  assert.deepEqual(
    (report.charts as Array<{ id: string }>).map((chart) => chart.id),
    ["speed", "capability", "agent"],
  );
  assert.equal(report.frozen, false);
});

test("agent tools are scoped to the bound session and check numbers against the data", async () => {
  const context = setup();
  const created = await context.service.create({ questionType: "single_model", question: "Usable?" });
  const evalId = String(created.eval_id);
  const sessionId = String(created.session_id);
  const planned = context.service.agentSetPlan(sessionId, fullPlan);
  assert.equal(planned.status, "planned");
  assert.throws(() => context.service.agentGet("other-session"), EvaluationServiceError);
  assert.throws(
    () =>
      context.service.agentProposeFollowup(sessionId, {
        title: "x",
        rationale: "y",
        evidence: [{ run_key: "q4" }],
        runs: [{ key: "q4-t0", label: "temp 0", target: planTarget, kinds: ["capability"] }],
      }),
    (error: unknown) => error instanceof EvaluationServiceError && error.code === "INVALID_STATE",
  );
  await startAndDrain(context, evalId);

  const proposal = context.service.agentProposeFollowup(sessionId, {
    title: "Code failures at temperature 0",
    rationale: "code-01 failed 2 of 3 samples; check whether sampling noise explains it",
    evidence: [{ run_key: "q4", task_id: "code-01", observation: "tests failed" }],
    runs: [{ key: "q4-t0", label: "Q4 · temperature 0", target: planTarget, kinds: ["capability"], sampling: { temperature: 0 } }],
  });
  const proposalId = String((proposal.proposal as Record<string, unknown>).proposal_id);
  assert.throws(
    () =>
      context.service.agentProposeFollowup(sessionId, {
        title: "dup",
        rationale: "dup",
        evidence: [{}],
        runs: [{ key: "q4", label: "again", target: planTarget, kinds: ["speed"] }],
      }),
    (error: unknown) => error instanceof EvaluationServiceError && /already exists/.test(error.message),
  );
  context.service.decideProposal({ evalId, proposalId, decision: "approve" });
  await context.engine.drainForTest();
  const detail = context.service.get({ evalId }) as {
    evaluation: { status: string };
    proposals: Array<{ status: string }>;
    runs: Array<{ run_key: string; proposal_id: string | null }>;
  };
  assert.equal(detail.evaluation.status, "analyzing");
  assert.equal(detail.proposals[0]?.status, "done");
  assert.ok(detail.runs.some((run) => run.run_key === "q4-t0" && run.proposal_id === proposalId));

  const written = context.service.agentWriteOpinion(
    sessionId,
    "On my laptop it decodes at {{speed.q4.decode_tps@0}} tok/s, and lean mode completes {{agent.q4.lean.rate}} of agent tasks. It fails 42% of the time and {{speed.q4.bogus}}.",
  );
  assert.deepEqual(written.unresolved_placeholders, ["speed.q4.bogus"]);
  assert.deepEqual(written.unverified_numbers, ["42%"]);
  const report = context.service.report({ evalId }) as Record<string, unknown>;
  assert.match(String(report.opinion_rendered_md), /decodes at 114.5 tok\/s, and lean mode completes 87.5% of agent tasks/);
  const revisions = (context.service.get({ evalId }) as { revisions: Array<{ author: string }> }).revisions;
  assert.equal(revisions[0]?.author, "agent");
  const context2 = context.service.agentContext(sessionId) ?? "";
  assert.match(context2, /q4-t0 · capability: done/);
});

test("publish freezes the data layer, redacts local details and returns a share draft", async () => {
  const context = setup();
  const created = await context.service.create({ questionType: "single_model", question: "Usable on devbox.local?" });
  const evalId = String(created.eval_id);
  context.service.setPlan({ evalId, plan: fullPlan });
  await startAndDrain(context, evalId);
  context.service.saveOpinion({
    evalId,
    opinionMd: "Served from http://127.0.0.1:8000/v1 at {{speed.q4.decode_tps@0}} tok/s. Files in /Users/someone/models/m.gguf.",
  });
  const published = context.service.publish({ evalId }) as Record<string, unknown>;
  const evaluation = published.evaluation as Record<string, unknown>;
  assert.equal(evaluation.status, "published");
  assert.equal(evaluation.published_at, "2026-10-11T08:00:00.000Z");
  assert.match(String(published.body), /Served from \[local server\] at 114\.5 tok\/s/);
  assert.match(String(published.body), /…\/m\.gguf/);
  assert.match(String(published.body), /Usable on \[host\]\?/);
  assert.deepEqual(
    (published.files as Array<{ file_name: string }>).map((file) => file.file_name),
    ["report.html", "report.md", "data.csv"],
  );
  const html = fs.readFileSync(path.join(String(published.dir), "report.html"), "utf8");
  assert.doesNotMatch(html, /127\.0\.0\.1/);
  assert.doesNotMatch(html, new RegExp(`/Users/${os.userInfo().username}/`));
  assert.match(html, /id="holaos-eval-report"/);
  assert.match(html, /id="holaos-eval-raw"/);
  assert.match(fs.readFileSync(path.join(String(published.dir), "data.csv"), "utf8"), /q4,Q4_K_M,speed,depth=0,decode_tps,114.5/);

  assert.throws(
    () => context.service.retryRun({ evalId, runId: "x" }),
    (error: unknown) => error instanceof EvaluationServiceError && error.code === "INVALID_STATE",
  );
  const frozen = context.service.report({ evalId }) as Record<string, unknown>;
  assert.equal(frozen.frozen, true);

  context.service.update({ evalId, includeRawData: false });
  const republished = context.service.publish({ evalId }) as Record<string, unknown>;
  const html2 = fs.readFileSync(path.join(String(republished.dir), "report.html"), "utf8");
  assert.doesNotMatch(html2, /id="holaos-eval-raw"/);
  assert.match(html2, /Raw data not public/);

  const version = context.service.createVersion({ evalId });
  assert.equal(version.relation, "version");
  assert.equal(version.status, "planned");
  assert.equal((context.service.get({ evalId }) as Record<string, unknown>).newer_version_id, version.eval_id);

  const reproduction = context.service.importReproduction({ reportHtml: html2, sourceUrl: "https://hub.example/p/1" });
  assert.equal(reproduction.relation, "reproduction");
  assert.equal(reproduction.status, "planned");
  assert.equal(((reproduction.plan as { runs: Array<{ target: { model_id: string } }> }).runs[0])?.target.model_id, target.model_id);
  assert.throws(
    () => context.service.importReproduction({ reportHtml: "<html></html>" }),
    (error: unknown) => error instanceof EvaluationServiceError && error.code === "INVALID_REPORT",
  );
});

test("failures, retry and cancel", async () => {
  const context = setup({ failKind: "run" });
  const created = await context.service.create({ questionType: "single_model", question: "Usable?" });
  const evalId = String(created.eval_id);
  context.service.setPlan({ evalId, plan: fullPlan });
  await startAndDrain(context, evalId);
  const detail = context.service.get({ evalId }) as { evaluation: { status: string }; runs: Array<Record<string, unknown>> };
  const failed = detail.runs.find((run) => run.kind === "capability");
  assert.equal(failed?.status, "failed");
  assert.match(String(failed?.error), /ConnectionRefusedError: boom/);
  assert.equal(detail.evaluation.status, "analyzing");
  const report = context.service.report({ evalId }) as { data_layer: { failed_runs: unknown[]; limitations: string[] } };
  assert.equal(report.data_layer.failed_runs.length, 1);

  context.service.retryRun({ evalId, runId: String(failed?.run_id) });
  assert.equal((context.service.get({ evalId }) as { evaluation: { status: string } }).evaluation.status, "running");
  context.service.cancel({ evalId });
  const afterCancel = context.service.get({ evalId }) as { evaluation: { status: string }; runs: Array<Record<string, unknown>> };
  assert.equal(afterCancel.runs.find((run) => run.run_id === failed?.run_id)?.status, "cancelled");
  assert.equal(afterCancel.evaluation.status, "analyzing");
  assert.throws(() => context.service.publish({ evalId: "eval-missing" }), EvaluationServiceError);
});

test("cancelling before anything finished returns to the editable plan", async () => {
  const context = setup();
  const created = await context.service.create({ questionType: "single_model", question: "Usable?" });
  const evalId = String(created.eval_id);
  context.service.setPlan({ evalId, plan: fullPlan });
  context.service.start({ evalId });
  const cancelled = context.service.cancel({ evalId }) as { evaluation: { status: string }; runs: unknown[] };
  assert.equal(cancelled.evaluation.status, "planned");
  assert.deepEqual(cancelled.runs, []);
  context.service.setPlan({ evalId, plan: { ...fullPlan, notes: "edited" } });
  const sessionId = String(created.session_id);
  assert.ok(context.store.getSession({ workspaceId, sessionId }));
  assert.equal(context.service.delete({ evalId }).success, true);
  assert.equal(context.store.getSession({ workspaceId, sessionId }), null);
});

test("engine marks runs interrupted by a restart as failed", async () => {
  const context = setup();
  const created = await context.service.create({ questionType: "single_model", question: "Usable?" });
  const evalId = String(created.eval_id);
  context.service.setPlan({ evalId, plan: fullPlan });
  context.service.start({ evalId });
  const first = context.store.listEvaluationRuns({ workspaceId, evalId })[0];
  context.store.updateEvaluationRun({ workspaceId, runId: String(first?.runId), status: "running" });
  assert.equal(context.engine.recoverInterruptedRuns(), 1);
  const recovered = context.store.getEvaluationRun({ workspaceId, runId: String(first?.runId) });
  assert.equal(recovered?.status, "failed");
  assert.match(String(recovered?.error), /restarted/);
});

test("queued runs wait while a benchmark holds the machine", async () => {
  let blocked = true;
  const context = setup({ isBlocked: () => blocked });
  const created = await context.service.create({ questionType: "single_model", question: "Usable?" });
  const evalId = String(created.eval_id);
  context.service.setPlan({ evalId, plan: fullPlan });
  await startAndDrain(context, evalId);
  assert.equal(context.fake.calls.length, 0);
  assert.ok(context.store.listEvaluationRuns({ workspaceId, evalId }).every((run) => run.status === "queued"));
  blocked = false;
  await context.engine.drainForTest();
  assert.ok(context.fake.calls.length > 0);
  assert.ok(context.store.listEvaluationRuns({ workspaceId, evalId }).every((run) => run.status === "done"));
});
