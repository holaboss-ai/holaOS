import assert from "node:assert/strict";
import test from "node:test";

import type { BenchEvent } from "@holaboss/remote-api/contract";
import { benchmarkCardHtml, capabilityCardHtml, modelFontSize } from "./cards";
import { kitFileName, kitReadme, narrationScript, readAloudScript, resultsCsv, shareText } from "./kit";
import { type RunRecordView, busyReading, busyText, explainReason, hardwareLabel, readingComparison } from "./record";
import { preferredRecordingMime } from "./recording";
import { applyBenchEvents, initialProgress } from "./useBenchRun";

const record: RunRecordView = {
  run_id: "6f1c2a9e-3b7d-4e1a-9c55-0d2f8e7a4b11",
  suite: { id: "suite-standard", version: "1.0" },
  subject: {
    id: "openbmb-minicpm5-2b",
    name: "MiniCPM5-2B",
    vendor: "OpenBMB",
    quant: "Q4_K_M",
    tag: "openbmb/minicpm5-2b:q4_K_M",
    version: "71a44e98",
    digest_registered: false,
  },
  runtime: { hardware: { cpu: "Apple M4 Max", memory_gb: 64 }, provider: { engine: "ollama", version: "0.40.10" } },
  results: [
    { task: "speed@0", kind: "speed", status: "ok", metrics: { depth: 0, decode_tps: 102.1, ttft_ms: 62, vram_bytes: 2_033_702_665, model_bytes: 2_033_702_665, cpu_offload: false } },
    { task: "speed@8k", kind: "speed", status: "ok", metrics: { depth: 8192, decode_tps: 85.4, ttft_ms: 3301.7 } },
    { task: "code-intervals", kind: "task", category: "code", status: "ok", passed: 3, samples: 3 },
    { task: "tool-flight", kind: "task", category: "tool", status: "unsupported", passed: 0, samples: 0 },
    { task: "needle-8k", kind: "task", category: "long_context", status: "ok", passed: 2, samples: 3, reasons: { "answer missing '7391-QX'": 1 } },
  ],
  artifacts: { highlights: [{ t: 3.4, label: "first_token", task: "speed@0" }, { t: 72.2, label: "task_done", task: "needle-8k" }] },
  started_at: "2026-10-24T06:40:05Z",
};
const url = "https://hub.holaos.ai/bench/runs/6f1c2a9e-3b7d-4e1a-9c55-0d2f8e7a4b11";

const assets = { url, fontCss: "", qrSvg: '<svg id="qr"></svg>' };

test("the benchmark card leads with decode speed and carries the machine and a QR code", () => {
  const html = benchmarkCardHtml(record, assets);
  assert.match(html, /class="big">102</);
  assert.match(html, /62 ms/);
  assert.match(html, /85\.4<small>tok\/s/);
  assert.match(html, /1\.9 GB<small>on GPU/);
  assert.match(html, /≈ <b>77 words a second<\/b>, 19× faster than you read/);
  assert.match(html, /Apple M4 Max · 64 GB/);
  assert.match(html, /<svg id="qr"><\/svg>/);
  assert.match(html, />hub\.holaos\.ai</);
  assert.match(html, /suite-standard@1\.0/);
});

test("a model that spills to the CPU is labelled on the card", () => {
  const spilled = structuredClone(record);
  const speed = spilled.results[0];
  if (speed.kind === "speed") {
    speed.metrics.cpu_offload = true;
  }
  assert.match(benchmarkCardHtml(spilled, assets), /Partly on CPU/);
});

test("a run on a busy machine says so on both cards instead of the reading comparison", () => {
  const busy = structuredClone(record);
  busy.runtime.conditions = { cpu_busy_pct: 12, others_cpu_busy_pct: 41 };
  const html = benchmarkCardHtml(busy, assets);
  assert.match(html, /Other programs used 41% of the CPU while it generated/);
  assert.doesNotMatch(html, /words a second/);
  assert.match(capabilityCardHtml(busy, assets), /Other programs used 41% of the CPU while it generated/);
  const calm = structuredClone(record);
  calm.runtime.conditions = { cpu_busy_pct: 70, others_cpu_busy_pct: 40 };
  assert.doesNotMatch(benchmarkCardHtml(calm, assets), /Other programs used/);
});

test("busy is over 40% of the CPU while it generated, falling back to the pre-run sample", () => {
  assert.deepEqual(busyReading({ cpu_busy_pct: 90, others_cpu_busy_pct: 41 }), { pct: 41, whileGenerating: true });
  assert.equal(busyReading({ cpu_busy_pct: 90, others_cpu_busy_pct: 40 }), null);
  assert.deepEqual(busyReading({ cpu_busy_pct: 41, others_cpu_busy_pct: null }), { pct: 41, whileGenerating: false });
  assert.equal(busyReading({ cpu_busy_pct: 40 }), null);
  assert.equal(busyReading(undefined), null);
  assert.equal(busyText({ pct: 55, whileGenerating: false }), "Other programs used 55% of the CPU when the run started");
});

test("the capability card shows x/3, explains a miss and keeps unsupported apart from failed", () => {
  const html = capabilityCardHtml(record, assets);
  assert.match(html, /Writes a Python function that has to pass hidden unit tests/);
  assert.match(html, /class="score num">3\/3</);
  assert.match(html, /class="score num">2\/3</);
  assert.match(html, /answer did not contain the fact/);
  assert.match(html, /Not supported on Ollama/);
  assert.doesNotMatch(html, />0\/0</);
});

test("grader reasons read as plain language", () => {
  assert.equal(explainReason("destination='Tokyo' not in ['TYO', 'NRT', 'HND']"), 'destination = "Tokyo" · expected TYO / NRT / HND');
  assert.equal(explainReason("tests failed: AssertionError"), "failed a hidden unit test");
  assert.equal(explainReason("called book_hotel instead of search_flights"), "called book_hotel() instead of search_flights()");
  assert.equal(explainReason("something new"), "something new");
});

test("long model names get a smaller size so they stay on the card", () => {
  assert.equal(modelFontSize("MiniCPM5-2B", 56), 56);
  assert.ok(modelFontSize("Qwen3-Coder-30B-A3B-Instruct", 56) < 40);
  assert.equal(modelFontSize("x".repeat(80), 56), 34);
});

test("reading comparison uses 0.75 words a token and 4 words a second", () => {
  const reading = readingComparison(102);
  assert.equal(Math.round(reading?.wordsPerSecond ?? 0), 77);
  assert.equal(Math.round(reading?.timesReading ?? 0), 19);
  assert.equal(readingComparison(undefined), null);
});

test("text from the model config is escaped in cards", () => {
  const hostile = structuredClone(record);
  hostile.subject.name = '<img src=x onerror="alert(1)">';
  const html = benchmarkCardHtml(hostile, assets) + capabilityCardHtml(hostile, assets);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test("the kit carries a CSV, a data-only script and a dated name", () => {
  const csv = resultsCsv(record).trim().split("\n");
  assert.equal(csv[0], "task,kind,status,passed,samples,decode_tps,ttft_ms,engine_decode_tps,vram_bytes,cpu_offload");
  assert.equal(csv[1], "speed@0,speed,ok,,,102.1,62,,2033702665,false");
  assert.equal(csv[4], "tool-flight,task,unsupported,0,0,,,,,");
  const script = narrationScript(record, url);
  assert.match(script, /## Post\n\nMiniCPM5-2B on my Apple M4 Max · 64 GB: 102 tok\/s/);
  assert.match(script, /1\/ MiniCPM5-2B \(Q4_K_M\) running locally on Apple M4 Max · 64 GB with Ollama 0\.40\.10: 102 tokens a second, first token in 62 ms\. That is about 77 words a second\./);
  assert.match(script, /Tool calling: not supported by this Ollama build/);
  assert.match(script, /Long context: 2\/3 \(answer did not contain the fact\)/);
  assert.match(script, /- 0:03 Speed starts/);
  assert.match(script, /- 1:12 Long context done/);
  assert.doesNotMatch(script, /likely low/);
  assert.equal(kitFileName(record), "openbmb-minicpm5-2b-2026-10-24-holaos-kit.zip");
  assert.equal(
    shareText(record),
    "MiniCPM5-2B on my Apple M4 Max · 64 GB: 102 tok/s, first token in 62 ms, 85.4 tok/s with 8K of context. Code 3/3 · Tools n/a · 8K recall 2/3. Measured locally with holaOS.",
  );
  const busy = structuredClone(record);
  busy.runtime.conditions = { cpu_busy_pct: 70 };
  assert.match(narrationScript(busy, url), /Other programs used 70% of the CPU when the run started, so speed is likely low/);
});

test("a discrete GPU names the card, not the CPU", () => {
  const pc = structuredClone(record);
  pc.runtime.hardware = { cpu: "AMD Ryzen 9 7950X", memory_gb: 64, gpus: ["NVIDIA GeForce RTX 4090, 24564 MiB"] };
  assert.equal(hardwareLabel(pc), "RTX 4090 24 GB · 64 GB RAM");
});

test("runtime events fold into steps, a live rate and the token stream", () => {
  const recent: Array<{ at: number; n: number }> = [];
  const events: BenchEvent[] = [
    { seq: 1, at: 1000, type: "run_started" },
    { seq: 2, at: 1100, type: "machine_busy", cpu_busy_pct: 40 },
    { seq: 3, at: 1200, type: "pull_progress", status: "pulling", completed: 5, total: 10 },
    { seq: 4, at: 2000, type: "task_start", task: "speed@0", kind: "speed" },
    { seq: 5, at: 2100, type: "text", task: "speed@0", delta: "one, ", n: 10 },
    { seq: 6, at: 2600, type: "text", task: "speed@0", delta: "two, ", n: 50 },
    { seq: 7, at: 3000, type: "text", task: "speed@0", delta: "three", n: 40 },
    { seq: 8, at: 3100, type: "task_done", task: "speed@0", kind: "speed", decode_tps: 101.5, ttft_ms: 61 },
    { seq: 9, at: 3200, type: "task_start", task: "tool-flight", kind: "task" },
    { seq: 10, at: 3300, type: "task_done", task: "tool-flight", kind: "task", status: "unsupported" },
  ];
  const before = applyBenchEvents(initialProgress("suite-standard@1.0"), events.slice(0, 7), recent);
  assert.equal(before.runStartedAt, 1000);
  assert.equal(before.cpuBusyPct, 40);
  assert.deepEqual(before.pull, { status: "pulling", completed: 5, total: 10 });
  assert.equal(before.currentStep, "speed@0");
  assert.equal(before.stream, "one, two, three");
  assert.equal(Math.round(before.liveTps ?? 0), 100);
  const after = applyBenchEvents(before, events.slice(7), recent);
  const speed = after.steps.find((step) => step.id === "speed@0");
  assert.deepEqual([speed?.state, speed?.decodeTps, speed?.ttftMs], ["done", 101.5, 61]);
  assert.equal(after.steps.find((step) => step.id === "tool-flight")?.status, "unsupported");
  assert.equal(after.stream, "");
  assert.equal(after.steps.length, 6);
});

test("recording prefers H.264 MP4 and falls back to WebM", () => {
  assert.equal(preferredRecordingMime(() => true), "video/mp4;codecs=avc1.640028");
  assert.equal(preferredRecordingMime((mime) => mime.startsWith("video/webm")), "video/webm;codecs=vp9");
  assert.equal(preferredRecordingMime(() => false), null);
});

test("a coding run shows the try, the agent's tool calls and test results, and the score so far", () => {
  const events: BenchEvent[] = [
    { seq: 1, at: 1000, type: "task_start", task: "fix-pagination", kind: "task", category: "coding", samples: 3 },
    { seq: 2, at: 1100, type: "attempt_start", task: "fix-pagination", sample: 0 },
    { seq: 3, at: 1150, type: "text", task: "fix-pagination", delta: "Let me read it.", n: 4 },
    { seq: 3, at: 1200, type: "tool_call", task: "fix-pagination", sample: 0, turn: 1, name: "read", arg: "pager.py" },
    { seq: 4, at: 1300, type: "tool_result", task: "fix-pagination", sample: 0, turn: 1, name: "read", error: false, summary: "file text" },
    { seq: 4, at: 1350, type: "text", task: "fix-pagination", delta: "Now the tests.", n: 4 },
    { seq: 5, at: 1400, type: "tool_call", task: "fix-pagination", sample: 0, turn: 2, name: "run_tests", arg: "" },
    { seq: 6, at: 1500, type: "tool_result", task: "fix-pagination", sample: 0, turn: 2, name: "run_tests", error: true, summary: "FAILED: 2 failed" },
    { seq: 7, at: 1600, type: "sample_done", task: "fix-pagination", sample: 0, passed: true, reason: null, finish: "answered" },
    { seq: 8, at: 1700, type: "attempt_start", task: "fix-pagination", sample: 1 },
  ];
  const progress = applyBenchEvents(initialProgress("suite-coding@1.0"), events, []);
  assert.deepEqual(progress.attempt, { sample: 1, turn: 0 });
  assert.deepEqual(progress.activity, []);
  const step = progress.steps.find((entry) => entry.id === "fix-pagination");
  assert.equal(step?.label, "1 · Fix a failing test");
  assert.equal(step?.tried, 1);
  assert.equal(step?.passed, 1);
  const midTry = applyBenchEvents(initialProgress("suite-coding@1.0"), events.slice(0, 8), []);
  assert.deepEqual(midTry.activity, ["read pager.py", "run_tests", "  → FAILED: 2 failed"]);
  assert.deepEqual(midTry.attempt, { sample: 0, turn: 2 });
  assert.equal(applyBenchEvents(initialProgress("suite-coding@1.0"), events.slice(0, 7), []).stream, "Let me read it.\nNow the tests.\n");
});

test("the read-aloud scripts carry the measured numbers, state what didn't run, and read in about 50 seconds", () => {
  const coding = {
    tasks: [
      { task: "fix-pagination", status: "ok", passed: 3, samples: 3 },
      { task: "parse-duration", status: "ok", passed: 1, samples: 3 },
      { task: "csv-export", status: "ok", passed: 0, samples: 3 },
      { task: "checkout-bug", status: "ok", passed: 3, samples: 3 },
      { task: "calc-power", status: "ok", passed: 0, samples: 3 },
    ],
  };
  const en = readAloudScript(record, "en", url, coding);
  assert.match(en, /With an empty context: 102 tokens per second, first token in 62 milliseconds/);
  assert.match(en, /With 8,000 tokens in the context: 85\.4 tokens per second/);
  assert.match(en, /run on my Apple M4 Max with 64 GB\?/);
  assert.match(en, /served by Ollama 0\.40\.10\./);
  assert.match(en, /One miss, on long-context recall: answer did not contain the fact\./);
  assert.match(en, /code 3\/3 and long-context recall 2\/3/);
  assert.match(en, /Tool calling isn't supported by its Ollama build, so it didn't run\. That isn't a fail\./);
  assert.match(en, /it solved the failing test and the reported bug every time/);
  assert.match(en, /One run on one machine/);
  assert.ok(en.includes(url) && en.includes("linked below") && en.includes("hub.holaos.ai/methodology"));
  assert.doesNotMatch(en, /blazing|fastest|best|incredible|amazing/i);
  const spoken = en
    .split("\n")
    .filter((line) => line.startsWith("**"))
    .map((line) => line.replace(/^\*\*[^*]+\*\*\s*/, ""))
    .join(" ")
    .split(/\s+/).length;
  assert.ok(spoken >= 90 && spoken <= 155, `45-60 seconds aloud, got ${spoken} words`);

  const zh = readAloudScript({ ...record, runtime: { ...record.runtime, conditions: { cpu_busy_pct: 12, others_cpu_busy_pct: 45 } } }, "zh", null, coding);
  assert.match(zh, /每秒生成 102 个 token，首个 token 用时 62 毫秒/);
  assert.match(zh, /工具调用这一项，这个模型的 Ollama 版本不支持，所以没有跑，这不算失败。/);
  assert.match(zh, /它每次都做对了：修复失败的测试、修复用户报告的 bug。/);
  assert.match(zh, /生成期间，其他程序占用了 45% 的 CPU，速度可能偏低/);
  assert.match(zh, /尚未发布/);
  assert.match(zh, /在我的 Apple M4 Max（64 GB）上能跑多快/);

  const readme = kitReadme(record, ["benchmark-card.png", "recording.mp4", "script.en.md", "README.txt"], null);
  assert.match(readme, /Suite: suite-standard@1\.0/);
  assert.match(readme, /Run: not published/);
  assert.match(readme, /- recording\.mp4: The full, uncut recording/);
});
