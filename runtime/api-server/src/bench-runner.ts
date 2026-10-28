import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import BENCH_CONDITIONS from "./bench-conditions.json";
import {
  type BenchHighlight,
  type BenchSubject,
  type RunRecord,
  BenchSubjectError,
  type HolaevalBenchOutput,
  buildRunRecord,
  minOllamaVersion,
  parseBenchSubject,
} from "./bench-run-record.js";
import {
  OLLAMA_BENCH_PORT,
  OLLAMA_DOWNLOAD_URL,
  type OllamaEvidence,
  OllamaInstance,
  OllamaInstanceError,
  type OllamaPullProgress,
  type UserLoadedModel,
  cleanupOrphanOllama,
  compareOllamaVersions,
  findOllamaBinary,
  unloadUserModel,
  userLoadedModels,
} from "./ollama-instance.js";

export interface BenchSuite {
  pack: string;
  /** The holaeval subcommand that runs the pack; it writes `<command>-main.json`. */
  command: "bench" | "code";
  /** Where the suite may run. The coding suite executes model-written code and needs the macOS sandbox. */
  platforms?: readonly NodeJS.Platform[];
}

export const BENCH_SUITES: Readonly<Record<string, BenchSuite>> = {
  "suite-standard@1.0": { pack: "suite-standard-1.0.json", command: "bench" },
  "suite-coding@1.0": { pack: "suite-coding-1.0.json", command: "code", platforms: ["darwin"] },
};

const STDERR_TAIL_BYTES = 4000;
const BENCH_LABEL = "main";
const BUSY_SAMPLE_MS: number = BENCH_CONDITIONS.busy_sample_ms;
/** A run is busy when others used more than this much of the CPU while it generated; records without that reading use the pre-run sample. */
export const BUSY_OTHERS_CPU_PCT: number = BENCH_CONDITIONS.busy_others_cpu_pct;

export type BenchStatus = "running" | "done" | "failed" | "cancelled";
export type BenchPhase = "preflight" | "starting" | "pulling" | "running" | "finishing";
export type BenchErrorCode =
  | "busy"
  | "invalid_subject"
  | "unknown_suite"
  | "unsupported_platform"
  | "not_found"
  | "not_ready"
  | "invalid_artifacts"
  | "ollama_missing"
  | "ollama_too_old"
  | "user_models_loaded"
  | "start_failed"
  | "pull_failed"
  | "bench_failed";

export interface BenchEvent {
  seq: number;
  at: number;
  type: string;
  [field: string]: unknown;
}

export interface BenchRunState {
  run_id: string;
  status: BenchStatus;
  phase: BenchPhase;
  suite: string;
  subject: BenchSubject;
  error: { code: BenchErrorCode; message: string; details?: Record<string, unknown> } | null;
  run_dir: string;
  record_path: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface BenchRunSummary {
  run_id: string;
  run_dir: string;
  suite: string;
  subject_id: string;
  subject_name: string;
  quant: string;
  started_at: string;
  decode_tps: number | null;
  hardware: { cpu?: string; memory_gb?: number; gpus?: string[] };
  cpu_busy_pct: number | null;
}

const RUN_ID_PATTERN = /^[0-9a-f-]{36}$/;
const LIST_LIMIT = 20;

export class BenchError extends Error {
  readonly code: BenchErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: BenchErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "BenchError";
    this.code = code;
    this.details = details;
  }
}

export interface BenchInstance {
  readonly baseUrl: string;
  /** The server's pid, so holaeval can tell Ollama's processes from everything else. */
  readonly pid?: number | null;
  start(): Promise<{ baseUrl: string; version: string; stoppedLeftover?: boolean }>;
  assertMinVersion(minVersion: string): void;
  pull(model: string, onProgress?: (progress: OllamaPullProgress) => void): Promise<void>;
  digest(model: string): Promise<string | null>;
  evidence(): OllamaEvidence;
  stop(): Promise<void>;
}

type SpawnImpl = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;

export interface BenchRunnerDeps {
  stateDir: () => string;
  runDir: (runId: string) => string;
  holaevalPath: () => string;
  packsDir: () => string;
  env: () => NodeJS.ProcessEnv;
  appVersion: () => string;
  python?: string;
  isBusy?: () => boolean;
  onIdle?: () => void;
  findBinary?: () => string | null;
  createInstance?: (binary: string) => BenchInstance;
  userModels?: () => Promise<UserLoadedModel[]>;
  unloadUserModel?: (name: string) => Promise<void>;
  spawnImpl?: SpawnImpl;
  fetchImpl?: typeof fetch;
  cpuBusy?: () => Promise<number | null>;
  platform?: NodeJS.Platform;
}

/** Share of CPU time spent busy across all cores over a short window. */
export async function measureCpuBusy(windowMs = BUSY_SAMPLE_MS): Promise<number | null> {
  const totals = () =>
    os.cpus().reduce(
      (sum, cpu) => {
        const { idle, ...rest } = cpu.times;
        const busy = Object.values(rest).reduce((a, b) => a + b, 0);
        return { busy: sum.busy + busy, all: sum.all + busy + idle };
      },
      { busy: 0, all: 0 },
    );
  const before = totals();
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  const after = totals();
  const all = after.all - before.all;
  return all > 0 ? Math.round(((after.busy - before.busy) / all) * 100) : null;
}

interface RunEntry {
  state: BenchRunState;
  events: BenchEvent[];
  unloadUserModels: boolean;
  child: ChildProcess | null;
  instance: BenchInstance | null;
  cancelled: boolean;
}

export class BenchRunner {
  private readonly deps: BenchRunnerDeps;
  private readonly runs = new Map<string, RunEntry>();
  private active: string | null = null;

  constructor(deps: BenchRunnerDeps) {
    this.deps = deps;
  }

  get busy(): boolean {
    return this.active !== null;
  }

  async recover(): Promise<boolean> {
    return await cleanupOrphanOllama(this.deps.stateDir(), this.deps.fetchImpl);
  }

  async shutdown(): Promise<void> {
    const entry = this.active ? this.runs.get(this.active) : undefined;
    if (entry) {
      entry.cancelled = true;
      entry.child?.kill("SIGTERM");
      await entry.instance?.stop();
    }
  }

  start(input: { subject: unknown; suite: string; unload_user_models?: boolean }): BenchRunState {
    if (this.active || this.deps.isBusy?.()) {
      throw new BenchError("busy", "Another benchmark or evaluation is running. Wait for it to finish.");
    }
    let subject: BenchSubject;
    try {
      subject = parseBenchSubject(input.subject);
    } catch (error) {
      if (error instanceof BenchSubjectError) {
        throw new BenchError("invalid_subject", error.message);
      }
      throw error;
    }
    if (!BENCH_SUITES[input.suite]) {
      throw new BenchError("unknown_suite", `Unknown suite ${input.suite}.`);
    }
    const runId = randomUUID();
    const runDir = this.deps.runDir(runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "subject.json"), `${JSON.stringify(subject, null, 2)}\n`);
    const entry: RunEntry = {
      state: {
        run_id: runId,
        status: "running",
        phase: "preflight",
        suite: input.suite,
        subject,
        error: null,
        run_dir: runDir,
        record_path: null,
        started_at: new Date().toISOString(),
        finished_at: null,
      },
      events: [],
      unloadUserModels: input.unload_user_models === true,
      child: null,
      instance: null,
      cancelled: false,
    };
    this.runs.set(runId, entry);
    this.active = runId;
    this.emit(entry, "run_started", { suite: input.suite, subject_id: subject.id });
    void this.execute(entry);
    return { ...entry.state };
  }

  current(): BenchRunState | null {
    const entry = this.active ? this.runs.get(this.active) : undefined;
    return entry ? { ...entry.state } : null;
  }

  get(runId: string, after = 0): { run: BenchRunState; events: BenchEvent[] } {
    const entry = this.runs.get(runId);
    if (!entry) {
      throw new BenchError("not_found", "benchmark run not found");
    }
    return { run: { ...entry.state }, events: entry.events.filter((event) => event.seq > after) };
  }

  private benchRoot(): string {
    return path.dirname(this.deps.runDir("_"));
  }

  /** Runs from this session are in memory; earlier ones are read back from their run directory. */
  private recordPath(runId: string): string {
    const entry = this.runs.get(runId);
    if (entry) {
      if (!entry.state.record_path) {
        throw new BenchError("not_ready", "the run has not produced a Run Record");
      }
      return entry.state.record_path;
    }
    const file = RUN_ID_PATTERN.test(runId) ? path.join(this.benchRoot(), runId, "run-record.json") : "";
    if (!file || !fs.existsSync(file)) {
      throw new BenchError("not_found", "benchmark run not found");
    }
    return file;
  }

  record(runId: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(this.recordPath(runId), "utf8")) as Record<string, unknown>;
  }

  /** Finished runs on disk, newest first. */
  list(subjectId?: string): BenchRunSummary[] {
    const root = this.benchRoot();
    if (!fs.existsSync(root)) {
      return [];
    }
    const runs: BenchRunSummary[] = [];
    for (const name of fs.readdirSync(root)) {
      if (!RUN_ID_PATTERN.test(name)) {
        continue;
      }
      try {
        const record = JSON.parse(fs.readFileSync(path.join(root, name, "run-record.json"), "utf8")) as RunRecord;
        if (subjectId && record.subject.id !== subjectId) {
          continue;
        }
        const speed = record.results.find((result) => result.task === "speed@0") as { metrics?: { decode_tps?: number } } | undefined;
        runs.push({
          run_id: record.run_id,
          run_dir: path.join(root, name),
          suite: `${record.suite.id}@${record.suite.version}`,
          subject_id: record.subject.id,
          subject_name: record.subject.name,
          quant: record.subject.quant,
          started_at: record.started_at,
          decode_tps: speed?.metrics?.decode_tps ?? null,
          hardware: record.runtime.hardware as BenchRunSummary["hardware"],
          cpu_busy_pct: record.runtime.conditions?.cpu_busy_pct ?? null,
        });
      } catch {
        // an unfinished or unreadable run is not listed
      }
    }
    return runs.sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, LIST_LIMIT);
  }

  /** Called by the desktop once the recording and cards exist; `recording_offset_s` is how long after run start recording began. */
  setArtifacts(
    runId: string,
    input: { recording: { file: string; scored_run: boolean } | null; cards: string[]; recording_offset_s?: number },
  ): Record<string, unknown> {
    const recordPath = this.recordPath(runId);
    const record = this.record(runId) as unknown as RunRecord;
    const runDir = path.dirname(recordPath);
    const entry = this.runs.get(runId);
    const inRunDir = (file: string) => {
      const name = path.basename(file);
      if (!fs.existsSync(path.join(runDir, name))) {
        throw new BenchError("invalid_artifacts", `${name} is not in this run's directory.`);
      }
      return name;
    };
    const offset = input.recording ? (input.recording_offset_s ?? 0) : 0;
    record.artifacts = {
      ...record.artifacts,
      recording: input.recording ? { file: inRunDir(input.recording.file), scored_run: input.recording.scored_run } : null,
      cards: input.cards.map(inRunDir),
      highlights: entry
        ? benchHighlights(entry.events).map((h) => ({ ...h, t: Math.max(0, Math.round((h.t - offset) * 10) / 10) }))
        : record.artifacts.highlights,
    };
    fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    return record as unknown as Record<string, unknown>;
  }

  cancel(runId: string): BenchRunState {
    const entry = this.runs.get(runId);
    if (!entry) {
      throw new BenchError("not_found", "benchmark run not found");
    }
    if (entry.state.status === "running") {
      entry.cancelled = true;
      entry.child?.kill("SIGTERM");
      void entry.instance?.stop();
    }
    return { ...entry.state };
  }

  private emit(entry: RunEntry, type: string, fields: Record<string, unknown> = {}): void {
    entry.events.push({ ...fields, seq: entry.events.length + 1, at: Date.now(), type });
  }

  private setPhase(entry: RunEntry, phase: BenchPhase): void {
    entry.state.phase = phase;
    this.emit(entry, "phase", { phase });
  }

  private throwIfCancelled(entry: RunEntry): void {
    if (entry.cancelled) {
      throw new BenchError("bench_failed", "cancelled");
    }
  }

  private async execute(entry: RunEntry): Promise<void> {
    const { subject } = entry.state;
    let instance: BenchInstance | null = null;
    try {
      const suite = BENCH_SUITES[entry.state.suite];
      const platform = this.deps.platform ?? process.platform;
      if (suite.platforms && !suite.platforms.includes(platform)) {
        throw new BenchError(
          "unsupported_platform",
          "The coding scenario runs only on macOS for now. It's coming to Windows in November.",
          { platforms: [...suite.platforms] },
        );
      }
      const binary = (this.deps.findBinary ?? (() => findOllamaBinary()))();
      if (!binary) {
        throw new BenchError("ollama_missing", "Ollama is not installed.", { download_url: OLLAMA_DOWNLOAD_URL });
      }
      const loaded = await (this.deps.userModels ?? (() => userLoadedModels(this.deps.fetchImpl)))();
      if (loaded.length > 0) {
        if (!entry.unloadUserModels) {
          throw new BenchError(
            "user_models_loaded",
            "Your own Ollama has models in memory. They would slow the benchmark down.",
            { models: loaded },
          );
        }
        const unload = this.deps.unloadUserModel ?? ((name: string) => unloadUserModel(name, this.deps.fetchImpl));
        for (const model of loaded) {
          await unload(model.name);
        }
        this.emit(entry, "user_models_unloaded", { models: loaded.map((model) => model.name) });
      }

      const cpuBusy = await (this.deps.cpuBusy ?? measureCpuBusy)();
      if (cpuBusy !== null && cpuBusy > BUSY_OTHERS_CPU_PCT) {
        this.emit(entry, "machine_busy", { cpu_busy_pct: cpuBusy });
      }

      const packPath = path.join(this.deps.packsDir(), suite.pack);
      const pack = JSON.parse(fs.readFileSync(packPath, "utf8")) as { min_ollama_version?: string };
      instance = (
        this.deps.createInstance ??
        ((bin: string) => new OllamaInstance({ binary: bin, stateDir: this.deps.stateDir(), port: OLLAMA_BENCH_PORT }))
      )(binary);
      entry.instance = instance;
      this.setPhase(entry, "starting");
      const { version, stoppedLeftover } = await instance.start();
      if (stoppedLeftover) {
        this.emit(entry, "leftover_stopped", { message: "Stopped a benchmark Ollama left over from an earlier run." });
      }
      this.emit(entry, "engine_ready", { engine: "ollama", version });
      const floor = minOllamaVersion(pack.min_ollama_version, subject, compareOllamaVersions);
      if (floor) {
        instance.assertMinVersion(floor);
      }
      this.throwIfCancelled(entry);

      this.setPhase(entry, "pulling");
      await instance.pull(subject.ollama.tag, (progress) => this.emit(entry, "pull_progress", { ...progress }));
      const digest = await instance.digest(subject.ollama.tag);
      this.throwIfCancelled(entry);

      this.setPhase(entry, "running");
      const bench = await this.runHolaeval(entry, instance.baseUrl, packPath, suite.command, instance.pid ?? null);

      this.setPhase(entry, "finishing");
      const record = buildRunRecord({
        runId: entry.state.run_id,
        bench,
        subject,
        digest,
        evidence: instance.evidence(),
        client: { app: "holaOS", version: this.deps.appVersion() },
        artifacts: {
          recording: null,
          cards: [],
          highlights: benchHighlights(entry.events),
          ...(fs.existsSync(path.join(entry.state.run_dir, "transcripts")) ? { transcripts: "transcripts" } : {}),
        },
        conditions: { cpu_busy_pct: cpuBusy },
      });
      const recordPath = path.join(entry.state.run_dir, "run-record.json");
      fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
      entry.state.record_path = recordPath;
      entry.state.status = "done";
    } catch (error) {
      if (entry.cancelled) {
        entry.state.status = "cancelled";
      } else {
        entry.state.status = "failed";
        entry.state.error =
          error instanceof BenchError || error instanceof OllamaInstanceError
            ? { code: error.code, message: error.message, ...(error instanceof BenchError && error.details ? { details: error.details } : {}) }
            : { code: "bench_failed", message: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      await instance?.stop().catch(() => undefined);
      entry.instance = null;
      entry.state.finished_at = new Date().toISOString();
      this.emit(entry, "run_finished", { status: entry.state.status });
      fs.writeFileSync(
        path.join(entry.state.run_dir, "events.jsonl"),
        entry.events.map((event) => JSON.stringify(event)).join("\n") + "\n",
      );
      this.active = null;
      this.deps.onIdle?.();
    }
  }

  private async runHolaeval(
    entry: RunEntry,
    baseUrl: string,
    packPath: string,
    command: BenchSuite["command"],
    ollamaPid: number | null,
  ): Promise<HolaevalBenchOutput> {
    const runDir = entry.state.run_dir;
    const args = [
      "-I",
      this.deps.holaevalPath(),
      command,
      "--base-url",
      baseUrl,
      "--model",
      entry.state.subject.ollama.tag,
      "--pack",
      packPath,
      "--subject",
      path.join(runDir, "subject.json"),
      "--out",
      runDir,
      "--label",
      BENCH_LABEL,
      ...(ollamaPid && command === "bench" ? ["--ollama-pid", String(ollamaPid)] : []),
    ];
    const spawnImpl: SpawnImpl = this.deps.spawnImpl ?? ((command, spawnArgs, options) => spawn(command, spawnArgs, options));
    const python = this.deps.python ?? (process.platform === "win32" ? "python" : "python3");
    const child = spawnImpl(python, args, { cwd: runDir, env: { ...this.deps.env(), PYTHONUNBUFFERED: "1" } });
    entry.child = child;
    let stderr = "";
    let buffer = "";
    const onLine = (line: string) => {
      if (!line.startsWith("{")) {
        return;
      }
      try {
        const { event, t: _t, ...fields } = JSON.parse(line) as Record<string, unknown>;
        if (typeof event === "string") {
          this.emit(entry, event, fields);
        }
      } catch {
        // not an event line
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        onLine(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });
    const code = await new Promise<number | null>((resolve) => {
      child.on("error", (error) => {
        stderr += `\n${error.message}`;
        resolve(-1);
      });
      child.on("close", (exitCode) => {
        onLine(buffer.trim());
        resolve(exitCode);
      });
    });
    entry.child = null;
    this.throwIfCancelled(entry);
    if (code !== 0) {
      const last = stderr.trim().split("\n").pop() ?? `exited with code ${code}`;
      throw new BenchError("bench_failed", `The benchmark stopped: ${last}`);
    }
    return JSON.parse(fs.readFileSync(path.join(runDir, `${command}-${BENCH_LABEL}.json`), "utf8")) as HolaevalBenchOutput;
  }
}

/** Seconds from `run_started`, which is when the desktop starts recording. */
export function benchHighlights(events: BenchEvent[]): BenchHighlight[] {
  const origin = events.find((event) => event.type === "run_started")?.at;
  if (origin === undefined) {
    return [];
  }
  const at = (event: BenchEvent) => Math.round((event.at - origin) / 100) / 10;
  const highlights: BenchHighlight[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const task = typeof event.task === "string" ? event.task : undefined;
    if (!task || task === "warmup") {
      continue;
    }
    if (event.type === "text" && !seen.has(task)) {
      seen.add(task);
      highlights.push({ t: at(event), label: "first_token", task });
    } else if (event.type === "task_done") {
      highlights.push({ t: at(event), label: event.status === "error" ? "error" : "task_done", task });
    } else if (event.type === "sample_done" && typeof event.reason === "string" && event.reason.startsWith("request failed")) {
      highlights.push({ t: at(event), label: "error", task });
    }
  }
  return highlights;
}
