import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RUN_RECORD_SCHEMA, type RunRecord } from "./bench-run-record.js";
import { BenchError, BenchRunner, type BenchRunnerDeps, benchHighlights } from "./bench-runner.js";
import { bundledHolaevalPath } from "./evaluation-routes.js";
import { OllamaInstance } from "./ollama-instance.js";

const tempDirs: string[] = [];
const holaeval = bundledHolaevalPath();
const packsDir = path.join(path.dirname(holaeval), "packs");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const subject = {
  type: "model",
  id: "openbmb-minicpm5-2b",
  name: "MiniCPM5-2B",
  vendor: "OpenBMB",
  quant: "Q4_K_M",
  ollama: { tag: "m:q4", known_digests: ["fakedigest"] },
  sampling: { temperature: 0.7, top_p: 0.8 },
};

/** An `ollama` executable that serves holaeval's fake Ollama on OLLAMA_HOST. */
function fakeOllamaBinary(dir: string, capabilities: string[], script = "None"): string {
  const file = path.join(dir, "ollama");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env python3
import importlib.util, os, time
spec = importlib.util.spec_from_file_location("holaeval", ${JSON.stringify(holaeval)})
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
host, port = os.environ["OLLAMA_HOST"].split(":")
h.fake_ollama(${JSON.stringify(capabilities)}, model="m:q4", port=int(port), script=${script})
while True:
    time.sleep(3600)
`,
    { mode: 0o755 },
  );
  return file;
}

function makeRunner(overrides: Partial<BenchRunnerDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-runner-"));
  tempDirs.push(dir);
  const stateDir = path.join(dir, "state");
  const binary = fakeOllamaBinary(dir, ["completion", "tools"]);
  let idle = 0;
  const runner = new BenchRunner({
    stateDir: () => stateDir,
    runDir: (runId) => path.join(dir, "runs", runId),
    holaevalPath: () => holaeval,
    packsDir: () => packsDir,
    env: () => ({ PATH: process.env.PATH }),
    appVersion: () => "0.0.0-test",
    findBinary: () => binary,
    createInstance: (bin) => new OllamaInstance({ binary: bin, stateDir, env: { PATH: process.env.PATH }, homedir: dir }),
    userModels: async () => [],
    cpuBusy: async () => 45,
    onIdle: () => {
      idle += 1;
    },
    ...overrides,
  });
  return { runner, dir, stateDir, idleCount: () => idle };
}

async function settle(runner: BenchRunner, runId: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { run } = runner.get(runId);
    if (run.status !== "running") {
      return runner.get(runId);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("benchmark did not finish");
}

test("one click runs the standard suite end to end and writes a Run Record", { skip: process.platform === "win32" }, async () => {
  const { runner, stateDir, idleCount } = makeRunner();
  const started = runner.start({ subject, suite: "suite-standard@1.0", showcase: true });
  assert.equal(started.status, "running");
  assert.equal(runner.current()?.run_id, started.run_id);
  assert.throws(() => runner.start({ subject, suite: "suite-standard@1.0" }), (error: unknown) => {
    return error instanceof BenchError && error.code === "busy";
  });

  const { run, events } = await settle(runner, started.run_id);
  assert.equal(run.status, "done", JSON.stringify(run.error));
  assert.equal(runner.current(), null);
  assert.equal(idleCount(), 1);
  assert.ok(!fs.existsSync(path.join(stateDir, "ollama-bench.json")), "the instance is stopped");

  const record = runner.record(started.run_id) as unknown as RunRecord;
  assert.equal(record.schema, RUN_RECORD_SCHEMA);
  assert.equal(record.run_id, started.run_id);
  assert.equal(record.subject.version, "fakedigest");
  assert.equal(record.subject.digest_registered, true);
  assert.equal(record.runtime.provider.version, "0.12.6");
  assert.equal(record.runtime.client.version, "0.0.0-test");
  assert.deepEqual(record.test_agent.settings.sampling, { temperature: 0.7, top_p: 0.8, min_p: 0 });
  assert.deepEqual(
    record.results.map((result) => [result.task, result.status]),
    [["speed@0", "ok"], ["speed@8k", "ok"], ["code-intervals", "ok"], ["tool-flight", "ok"], ["needle-8k", "ok"]],
  );
  assert.ok(record.artifacts.highlights.some((h) => h.label === "first_token" && h.task === "speed@0"));
  assert.equal(record.verification, null);
  assert.equal(record.runtime.conditions.cpu_busy_pct, 45);
  assert.ok("others_cpu_busy_pct" in record.runtime.conditions, "holaeval's during-run sample reaches the record");
  const speedRuns = (record.results[0] as { metrics: { runs: Array<Record<string, unknown>> } }).metrics.runs;
  assert.ok(speedRuns.every((run) => "others_cpu_busy_pct" in run));
  assert.ok(events.some((event) => event.type === "machine_busy" && event.cpu_busy_pct === 45));
  assert.ok(events.some((event) => event.type === "request_done" && event.task === "speed@0" && event.eval_count === 256));
  const showcase = events.filter((event) => event.task === "showcase");
  assert.deepEqual([showcase[0]?.type, showcase.at(-1)?.type], ["task_start", "task_done"], "the showcase runs after the scored tasks");
  assert.ok(!record.results.some((result) => result.task === "showcase"), "the showcase is never scored");

  const types = events.map((event) => event.type);
  assert.equal(types[0], "run_started");
  assert.equal(types.at(-1), "run_finished");
  for (const phase of ["starting", "pulling", "running", "finishing"]) {
    assert.ok(events.some((event) => event.type === "phase" && event.phase === phase), phase);
  }
  assert.ok(types.includes("pull_progress") && types.includes("text") && types.includes("task_done"));
  const after = events[events.length - 3].seq;
  assert.equal(runner.get(started.run_id, after).events.length, 2);
  assert.ok(fs.existsSync(path.join(run.run_dir, "events.jsonl")));

  fs.writeFileSync(path.join(run.run_dir, "recording.mp4"), "");
  fs.writeFileSync(path.join(run.run_dir, "benchmark-card.png"), "");
  // The desktop starts recording once the timed requests are done, so earlier moments aren't in the recording.
  const showcaseStart = record.artifacts.highlights.find((h) => h.label === "first_token" && h.task === "showcase")?.t;
  assert.ok(showcaseStart !== undefined, "the showcase has a first-token moment");
  const offset = Math.max(0, showcaseStart - 0.1);
  const updated = runner.setArtifacts(started.run_id, {
    recording: { file: path.join(run.run_dir, "recording.mp4"), scored_run: false },
    cards: ["benchmark-card.png"],
    recording_offset_s: offset,
  }) as unknown as RunRecord;
  assert.deepEqual(updated.artifacts.recording, { file: "recording.mp4", scored_run: false });
  assert.deepEqual(updated.artifacts.cards, ["benchmark-card.png"]);
  assert.ok(updated.artifacts.highlights.every((h) => h.t >= 0));
  assert.ok(!updated.artifacts.highlights.some((h) => h.task === "speed@0"), "speed@0 came before the recording");
  const shifted = updated.artifacts.highlights.find((h) => h.task === "showcase" && h.label === "first_token")?.t;
  assert.ok(shifted !== undefined && Math.abs(showcaseStart - offset - shifted) < 0.11);
  assert.deepEqual((runner.record(started.run_id) as unknown as RunRecord).artifacts.cards, ["benchmark-card.png"]);
  assert.throws(
    () => runner.setArtifacts(started.run_id, { recording: null, cards: ["../../etc/passwd"] }),
    (error: unknown) => error instanceof BenchError && error.code === "invalid_artifacts",
  );

  const listed = runner.list("openbmb-minicpm5-2b");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].run_id, started.run_id);
  assert.equal(listed[0].subject_name, "MiniCPM5-2B");
  assert.ok((listed[0].decode_tps ?? 0) > 0);
  assert.equal(listed[0].cpu_busy_pct, 45);
  assert.equal(listed[0].others_cpu_busy_pct, record.runtime.conditions.others_cpu_busy_pct ?? null);
  assert.deepEqual(runner.list("someone-else"), []);
});

test("the coding suite runs through holaeval code and records each attempt", { skip: process.platform !== "darwin" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-coding-"));
  tempDirs.push(dir);
  const binary = fakeOllamaBinary(dir, ["completion", "tools"], 'lambda prompt, body: (["Nothing to change."], None)');
  const { runner } = makeRunner({ findBinary: () => binary });
  const started = runner.start({ subject, suite: "suite-coding@1.0" });
  const { run } = await settle(runner, started.run_id, 120_000);
  assert.equal(run.status, "done", JSON.stringify(run.error));

  const record = runner.record(started.run_id) as unknown as RunRecord;
  assert.equal(record.suite.id, "suite-coding");
  assert.deepEqual(
    record.results.map((result) => [result.task, result.category, result.passed, result.samples]),
    [
      ["fix-pagination", "coding", 0, 3],
      ["parse-duration", "coding", 0, 3],
      ["csv-export", "coding", 0, 3],
      ["checkout-bug", "coding", 0, 3],
      ["calc-power", "coding", 0, 3],
    ],
  );
  const attempt = (record.results[0].attempts as Array<Record<string, unknown>>)[0];
  assert.equal(attempt.finish, "answered");
  assert.equal(attempt.reason, "hidden tests failed (4 of 8)");
  assert.equal((record.test_agent.settings.budgets as { max_turns: number }).max_turns, 15);
  assert.deepEqual(record.test_agent.settings.sandbox, { os: "seatbelt", audit_hook: true, network: false });
  assert.equal(record.artifacts.transcripts, "transcripts");
  assert.ok(fs.existsSync(path.join(run.run_dir, "transcripts", "calc-power-2.jsonl")));

  fs.writeFileSync(path.join(run.run_dir, "scene-card.png"), "");
  const updated = runner.setArtifacts(started.run_id, { recording: null, cards: ["scene-card.png"] }) as unknown as RunRecord;
  assert.equal(updated.artifacts.transcripts, "transcripts");

  const [listed] = runner.list("openbmb-minicpm5-2b");
  assert.equal(listed.suite, "suite-coding@1.0");
  assert.equal(listed.decode_tps, null);
});

test("the coding suite refuses to run outside macOS", async () => {
  const { runner } = makeRunner({ platform: "win32" });
  const started = runner.start({ subject, suite: "suite-coding@1.0" });
  const { run } = await settle(runner, started.run_id);
  assert.equal(run.status, "failed");
  assert.equal(run.error?.code, "unsupported_platform");
});

test("runs from before a restart can still be listed, read and given new cards", { skip: process.platform === "win32" }, async () => {
  const { runner, dir } = makeRunner();
  const { run_id } = runner.start({ subject, suite: "suite-standard@1.0" });
  const { run } = await settle(runner, run_id);
  assert.equal(run.status, "done");
  const highlights = (runner.record(run_id) as unknown as RunRecord).artifacts.highlights;

  const restarted = makeRunner({ runDir: (id) => path.join(dir, "runs", id) }).runner;
  assert.deepEqual(restarted.list().map((entry) => entry.run_id), [run_id]);
  assert.equal((restarted.record(run_id) as unknown as RunRecord).run_id, run_id);
  fs.writeFileSync(path.join(run.run_dir, "capability-card.png"), "");
  const updated = restarted.setArtifacts(run_id, { recording: null, cards: ["capability-card.png"] }) as unknown as RunRecord;
  assert.deepEqual(updated.artifacts.cards, ["capability-card.png"]);
  assert.deepEqual(updated.artifacts.highlights, highlights);
  assert.throws(() => restarted.record("00000000-0000-0000-0000-000000000000"), (error: unknown) => {
    return error instanceof BenchError && error.code === "not_found";
  });
  assert.throws(() => restarted.record("../../etc"), (error: unknown) => error instanceof BenchError && error.code === "not_found");
});

test("missing Ollama fails with the download link", async () => {
  const { runner } = makeRunner({ findBinary: () => null });
  const { run_id } = runner.start({ subject, suite: "suite-standard@1.0" });
  const { run } = await settle(runner, run_id);
  assert.throws(() => runner.record(run_id), (error: unknown) => error instanceof BenchError && error.code === "not_ready");
  assert.equal(run.status, "failed");
  assert.equal(run.error?.code, "ollama_missing");
  assert.equal(run.error?.details?.download_url, "https://ollama.com/download");
});

test("models held by the user's Ollama block the run until the user agrees to unload them", async () => {
  const unloaded: string[] = [];
  const { runner } = makeRunner({
    userModels: async () => [{ name: "qwen3:8b", size_vram: 5_000_000_000 }],
    unloadUserModel: async (name) => {
      unloaded.push(name);
    },
    findBinary: () => "/nonexistent/ollama",
  });
  const first = runner.start({ subject, suite: "suite-standard@1.0" });
  const blocked = await settle(runner, first.run_id);
  assert.equal(blocked.run.error?.code, "user_models_loaded");
  assert.deepEqual(unloaded, []);

  const second = runner.start({ subject, suite: "suite-standard@1.0", unload_user_models: true });
  const result = await settle(runner, second.run_id);
  assert.deepEqual(unloaded, ["qwen3:8b"]);
  assert.ok(result.events.some((event) => event.type === "user_models_unloaded"));
  assert.equal(result.run.error?.code, "start_failed");
});

test("an Ollama older than the model's floor stops before pulling", { skip: process.platform === "win32" }, async () => {
  const { runner } = makeRunner();
  const { run_id } = runner.start({ subject: { ...subject, ollama: { ...subject.ollama, min_version: "9.0.0" } }, suite: "suite-standard@1.0" });
  const { run, events } = await settle(runner, run_id);
  assert.equal(run.error?.code, "ollama_too_old");
  assert.ok(!events.some((event) => event.type === "phase" && event.phase === "pulling"));
});

test("a pre-run reading counts as busy only above the shared threshold", async () => {
  for (const [reading, busy] of [[40, false], [41, true]] as const) {
    const { runner } = makeRunner({ cpuBusy: async () => reading, findBinary: () => "/nonexistent/ollama" });
    const { run_id } = runner.start({ subject, suite: "suite-standard@1.0" });
    const { events } = await settle(runner, run_id);
    assert.equal(events.some((event) => event.type === "machine_busy"), busy, String(reading));
  }
});

test("bad input is rejected before anything starts", () => {
  const { runner } = makeRunner();
  assert.throws(() => runner.start({ subject: { ...subject, quant: "" }, suite: "suite-standard@1.0" }), (error: unknown) => {
    return error instanceof BenchError && error.code === "invalid_subject";
  });
  assert.throws(() => runner.start({ subject, suite: "suite-standard@9" }), (error: unknown) => {
    return error instanceof BenchError && error.code === "unknown_suite";
  });
  assert.throws(() => runner.get("nope"), (error: unknown) => error instanceof BenchError && error.code === "not_found");
});

test("an evaluation in progress blocks a benchmark", () => {
  const { runner } = makeRunner({ isBusy: () => true });
  assert.throws(() => runner.start({ subject, suite: "suite-standard@1.0" }), (error: unknown) => {
    return error instanceof BenchError && error.code === "busy";
  });
});

test("highlights are seconds from run start: first token, task done and errors", () => {
  const base = 1_000_000;
  const highlights = benchHighlights([
    { seq: 1, at: base, type: "run_started" },
    { seq: 2, at: base + 500, type: "text", task: "warmup" },
    { seq: 3, at: base + 4200, type: "text", task: "speed@0" },
    { seq: 4, at: base + 4300, type: "text", task: "speed@0" },
    { seq: 5, at: base + 9000, type: "task_done", task: "speed@0", kind: "speed" },
    { seq: 6, at: base + 12_000, type: "sample_done", task: "tool-flight", reason: "request failed: HTTP 500" },
    { seq: 7, at: base + 13_000, type: "task_done", task: "tool-flight", status: "error" },
  ]);
  assert.deepEqual(highlights, [
    { t: 4.2, label: "first_token", task: "speed@0" },
    { t: 9, label: "task_done", task: "speed@0" },
    { t: 12, label: "error", task: "tool-flight" },
    { t: 13, label: "error", task: "tool-flight" },
  ]);
});
