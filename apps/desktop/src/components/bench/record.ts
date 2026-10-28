/** Typed reads over a Run Record (hola.run-record/0.1); the runtime owns the schema. */

import BENCH_CONDITIONS from "../../../../../runtime/api-server/src/bench-conditions.json";

export interface SpeedMetrics {
  depth: number;
  decode_tps?: number;
  ttft_ms?: number;
  engine_decode_tps?: number;
  engine_prefill_tps?: number;
  vram_bytes?: number | null;
  model_bytes?: number | null;
  cpu_offload?: boolean | null;
}

export interface SpeedResult {
  task: string;
  kind: "speed";
  status: string;
  metrics: SpeedMetrics;
}

export interface TaskResult {
  task: string;
  kind: "task";
  category: string;
  status: "ok" | "unsupported" | "error" | "incomplete";
  passed: number;
  samples: number;
  reasons?: Record<string, number>;
}

export interface RunRecordView {
  schema?: string;
  run_id: string;
  suite: { id: string; version: string };
  subject: { id: string; name: string; vendor: string | null; quant: string; tag: string; version: string | null; digest_registered: boolean };
  runtime: {
    hardware: { cpu?: string; memory_gb?: number; gpus?: string[]; model?: string };
    provider: { engine: string; version: string | null };
    conditions?: { cpu_busy_pct: number | null; others_cpu_busy_pct?: number | null };
  };
  results: Array<SpeedResult | TaskResult>;
  artifacts: {
    highlights: Array<{ t: number; label: string; task?: string }>;
    recording?: { file: string; scored_run: boolean } | null;
    cards?: string[];
  };
  started_at: string;
}

export const TASK_INFO: Record<string, { title: string; short: string; what: string }> = {
  "code-intervals": { title: "Code", short: "Code", what: "Writes a Python function that has to pass hidden unit tests" },
  "tool-flight": { title: "Tool calling", short: "Tools", what: "Picks the right one of two tools and fills in its arguments" },
  "needle-8k": { title: "Long context", short: "8K recall", what: "Finds a single fact buried in 8,000 tokens of text" },
};

export const BUSY_OTHERS_CPU_PCT: number = BENCH_CONDITIONS.busy_others_cpu_pct;

export interface BusyReading {
  pct: number;
  /** False when only the sample from the second before the run exists. */
  whileGenerating: boolean;
}

/** Busy when other programs used over the shared limit while it generated; older records fall back to the pre-run sample. */
export function busyReading(conditions: { cpu_busy_pct?: number | null; others_cpu_busy_pct?: number | null } | undefined): BusyReading | null {
  const during = conditions?.others_cpu_busy_pct ?? null;
  if (during !== null) {
    return during > BUSY_OTHERS_CPU_PCT ? { pct: during, whileGenerating: true } : null;
  }
  const before = conditions?.cpu_busy_pct ?? null;
  return before !== null && before > BUSY_OTHERS_CPU_PCT ? { pct: before, whileGenerating: false } : null;
}

export function wasBusy(record: RunRecordView): BusyReading | null {
  return busyReading(record.runtime.conditions);
}

export function busyText(busy: BusyReading): string {
  return `Other programs used ${busy.pct}% of the CPU ${busy.whileGenerating ? "while it generated" : "when the run started"}`;
}

/** Grader reasons are written for engineers; this phrases the common ones for a card. */
export function explainReason(reason: string): string {
  const notIn = reason.match(/^(\w+)=(['"])(.*)\2 not in \[(.+)\]$/);
  if (notIn) {
    const expected = notIn[4].replace(/'/g, "").split(/,\s*/).join(" / ");
    return `${notIn[1]} = "${notIn[3]}" · expected ${expected}`;
  }
  const called = reason.match(/^called (\w+) instead of (\w+)$/);
  if (called) {
    return `called ${called[1]}() instead of ${called[2]}()`;
  }
  const plain: Array<[RegExp, string]> = [
    [/^tests failed/, "failed a hidden unit test"],
    [/^tests timed out/, "code ran past the time limit"],
    [/^no tool call/, "answered in text instead of calling a tool"],
    [/^ran out of tokens/, "ran out of tokens before answering"],
    [/^answer missing/, "answer did not contain the fact"],
    [/^prompt was truncated/, "the prompt did not fit the context window"],
  ];
  for (const [pattern, phrase] of plain) {
    if (pattern.test(reason)) {
      return phrase;
    }
  }
  return reason.length > 80 ? `${reason.slice(0, 79)}…` : reason;
}

export function topReason(task: TaskResult): string | null {
  const entries = Object.entries(task.reasons ?? {}).sort((a, b) => b[1] - a[1]);
  return entries[0]?.[0] ?? null;
}

// About 0.75 English words per token, and 240 words a minute for a fluent adult reader.
const WORDS_PER_TOKEN = 0.75;
const READING_WORDS_PER_SECOND = 4;

export function readingComparison(tokensPerSecond: number | undefined): { wordsPerSecond: number; timesReading: number } | null {
  if (!tokensPerSecond) {
    return null;
  }
  const wordsPerSecond = tokensPerSecond * WORDS_PER_TOKEN;
  return { wordsPerSecond, timesReading: wordsPerSecond / READING_WORDS_PER_SECOND };
}

export function speedResult(record: RunRecordView, task: string): SpeedMetrics | null {
  const result = record.results.find((entry) => entry.task === task && entry.kind === "speed");
  return result && result.kind === "speed" && result.status === "ok" ? result.metrics : null;
}

export function taskResults(record: RunRecordView): TaskResult[] {
  return record.results.filter((entry): entry is TaskResult => entry.kind === "task");
}

/** The machine as people say it: "Apple M5 Pro · 48 GB" or "RTX 4090 24 GB · 64 GB RAM". */
export function machineSummary(hw: { cpu?: string; memory_gb?: number; gpus?: string[] }): string {
  const gpu = hw.gpus?.[0]
    ?.replace(/^NVIDIA\s+(GeForce\s+)?/i, "")
    .replace(/,\s*(\d+)\s*MiB$/i, (_match, mib: string) => ` ${Math.round(Number(mib) / 1024)} GB`)
    .replace(/,\s*/g, " ");
  const memory = hw.memory_gb ? `${hw.memory_gb} GB` : "";
  if (gpu) {
    return [gpu, memory ? `${memory} RAM` : ""].filter(Boolean).join(" · ");
  }
  return [hw.cpu ?? "Unknown machine", memory].filter(Boolean).join(" · ");
}

export function hardwareLabel(record: RunRecordView): string {
  return machineSummary(record.runtime.hardware);
}

export function engineLabel(record: RunRecordView): string {
  const { engine, version } = record.runtime.provider;
  const name = engine === "ollama" ? "Ollama" : engine;
  return version ? `${name} ${version}` : name;
}

export function formatTps(value: number | undefined): string {
  return value === undefined ? "–" : value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

export function formatMs(value: number | undefined): string {
  if (value === undefined) {
    return "–";
  }
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
}

export function formatGb(bytes: number | null | undefined): string {
  return bytes ? `${(bytes / 2 ** 30).toFixed(1)} GB` : "–";
}

export function resultUrl(baseUrl: string, runId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${runId}`;
}
