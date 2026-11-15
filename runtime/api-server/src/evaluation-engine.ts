import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { EvaluationRunRecord, RuntimeStateStore } from "@holaboss/runtime-state-store";

import { runTarget } from "./evaluation-report.js";

export const SPEED_DEPTHS = [0, 8192, 32768];
const TERMINAL_RUN_STATUSES = new Set(["done", "failed", "cancelled"]);
const STDERR_TAIL_BYTES = 4000;
const STDOUT_TAIL_BYTES = 200_000;
const REACHABILITY_TIMEOUT_MS = 5000;

type SpawnImpl = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;

export interface EvaluationSettledEvent {
  evalId: string;
  done: number;
  failed: number;
  cancelled: number;
  proposalIds: string[];
}

export interface EvaluationEngineDeps {
  store: RuntimeStateStore;
  workspaceId: () => string;
  evalDir: (evalId: string) => string;
  holaevalPath: () => string;
  env: () => NodeJS.ProcessEnv;
  python?: string;
  spawnImpl?: SpawnImpl;
  fetchImpl?: typeof fetch;
  contextWindowFor?: (target: Record<string, unknown>) => number | null;
  waitForBrainIdle?: (evalId: string) => Promise<void>;
  /** While true, queued runs wait; call wake() once it clears. */
  isBlocked?: () => boolean;
  onSettled?: (event: EvaluationSettledEvent) => void;
  onError?: (error: unknown, context: { runId: string }) => void;
}

interface ActiveRun {
  runId: string;
  evalId: string;
  child: ChildProcess | null;
  cancelled: boolean;
}

function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return (lines[lines.length - 1] ?? "").slice(0, 240);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function holaevalArgs(params: {
  run: EvaluationRunRecord;
  holaevalPath: string;
  dataDir: string;
  contextWindow: number | null;
}): string[] {
  const { run } = params;
  const target = runTarget(run);
  const base = [
    "-I",
    params.holaevalPath,
  ];
  const common = ["--base-url", String(target.base_url ?? ""), "--model", String(target.model_id ?? "")];
  const contextArgs = params.contextWindow ? ["--context-window", String(params.contextWindow)] : [];
  const sampling = (run.spec.sampling ?? {}) as Record<string, unknown>;
  const samplingArgs: string[] = [];
  const temperature = numberOrNull(sampling.temperature);
  const topP = numberOrNull(sampling.top_p);
  const minP = numberOrNull(sampling.min_p);
  if (temperature !== null) samplingArgs.push("--temperature", String(temperature));
  if (topP !== null) samplingArgs.push("--top-p", String(topP));
  if (minP !== null) samplingArgs.push("--min-p", String(minP));
  const samples = numberOrNull(run.spec.samples);
  const sampleArgs = samples !== null ? ["--samples", String(samples)] : [];
  const out = ["--out", params.dataDir, "--label", run.runKey];
  switch (run.kind) {
    case "speed":
      return [...base, "speed", ...common, ...out, "--depths", SPEED_DEPTHS.join(","), ...contextArgs];
    case "capability":
      return [...base, "run", ...common, ...out, ...sampleArgs, ...samplingArgs, ...contextArgs];
    case "agent": {
      const conditions = Array.isArray(run.spec.agent_conditions) && run.spec.agent_conditions.length > 0
        ? (run.spec.agent_conditions as string[])
        : ["full", "lean"];
      return [
        ...base,
        "agent",
        ...common,
        ...out,
        "--conditions",
        conditions.join(","),
        ...sampleArgs,
        ...samplingArgs,
        ...contextArgs,
      ];
    }
    default:
      throw new Error(`unknown run kind: ${run.kind}`);
  }
}

export function resultFileFor(run: EvaluationRunRecord): string {
  switch (run.kind) {
    case "speed":
      return `speed-${run.runKey}.json`;
    case "capability":
      return `summary-${run.runKey}.json`;
    case "agent":
      return `agent-summary-${run.runKey}.json`;
    default:
      return `${run.kind}-${run.runKey}.json`;
  }
}

export class EvaluationEngine {
  private readonly deps: EvaluationEngineDeps;
  private active: ActiveRun | null = null;
  private ticking = false;
  private pendingWake = false;
  private stopped = false;

  constructor(deps: EvaluationEngineDeps) {
    this.deps = deps;
  }

  get busyWith(): { runId: string; evalId: string } | null {
    return this.active ? { runId: this.active.runId, evalId: this.active.evalId } : null;
  }

  recoverInterruptedRuns(): number {
    const workspaceId = this.deps.workspaceId();
    const interrupted = this.deps.store.listEvaluationRuns({ workspaceId, statuses: ["running"] });
    const now = new Date().toISOString();
    for (const run of interrupted) {
      this.deps.store.updateEvaluationRun({
        workspaceId,
        runId: run.runId,
        status: "failed",
        error: "Interrupted because holaOS restarted. Retry to run it again.",
        finishedAt: now,
      });
    }
    const evalIds = new Set(interrupted.map((run) => run.evalId));
    for (const evalId of evalIds) {
      this.settleIfFinished(evalId);
    }
    return interrupted.length;
  }

  wake(): void {
    if (this.stopped) {
      return;
    }
    if (this.ticking) {
      this.pendingWake = true;
      return;
    }
    this.ticking = true;
    setImmediate(() => {
      void this.drain().finally(() => {
        this.ticking = false;
        if (this.pendingWake) {
          this.pendingWake = false;
          this.wake();
        }
      });
    });
  }

  async drainForTest(): Promise<void> {
    await this.drain();
  }

  stop(): void {
    this.stopped = true;
    this.active?.child?.kill("SIGTERM");
  }

  cancelEvaluation(evalId: string): void {
    const workspaceId = this.deps.workspaceId();
    const now = new Date().toISOString();
    for (const run of this.deps.store.listEvaluationRuns({ workspaceId, evalId, statuses: ["queued"] })) {
      this.deps.store.updateEvaluationRun({ workspaceId, runId: run.runId, status: "cancelled", finishedAt: now });
    }
    if (this.active?.evalId === evalId) {
      this.active.cancelled = true;
      this.active.child?.kill("SIGTERM");
    }
  }

  private nextQueuedRun(): EvaluationRunRecord | null {
    return this.deps.store.listEvaluationRuns({ workspaceId: this.deps.workspaceId(), statuses: ["queued"] })[0] ?? null;
  }

  private async drain(): Promise<void> {
    while (!this.stopped && !this.deps.isBlocked?.()) {
      const run = this.nextQueuedRun();
      if (!run) {
        return;
      }
      try {
        await this.execute(run);
      } catch (error) {
        this.deps.onError?.(error, { runId: run.runId });
        this.finish(run, "failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private finish(
    run: EvaluationRunRecord,
    status: "done" | "failed" | "cancelled",
    fields: { error?: string | null; summary?: Record<string, unknown> | null } = {},
  ): void {
    const workspaceId = this.deps.workspaceId();
    this.deps.store.updateEvaluationRun({
      workspaceId,
      runId: run.runId,
      status,
      error: fields.error ?? null,
      summary: fields.summary,
      finishedAt: new Date().toISOString(),
    });
    this.settleIfFinished(run.evalId);
  }

  settleIfFinished(evalId: string): void {
    const workspaceId = this.deps.workspaceId();
    const runs = this.deps.store.listEvaluationRuns({ workspaceId, evalId });
    if (runs.length === 0 || runs.some((run) => !TERMINAL_RUN_STATUSES.has(run.status))) {
      return;
    }
    const evaluation = this.deps.store.getEvaluation({ workspaceId, evalId });
    if (!evaluation) {
      return;
    }
    const proposalIds = new Set<string>();
    for (const proposal of this.deps.store.listEvaluationProposals({ workspaceId, evalId })) {
      if (proposal.status === "approved" && runs.some((run) => run.proposalId === proposal.proposalId)) {
        this.deps.store.setEvaluationProposalStatus({ workspaceId, proposalId: proposal.proposalId, status: "done" });
        proposalIds.add(proposal.proposalId);
      }
    }
    if (evaluation.status !== "running") {
      return;
    }
    this.deps.store.updateEvaluation({ workspaceId, evalId, status: "analyzing" });
    this.deps.onSettled?.({
      evalId,
      done: runs.filter((run) => run.status === "done").length,
      failed: runs.filter((run) => run.status === "failed").length,
      cancelled: runs.filter((run) => run.status === "cancelled").length,
      proposalIds: [...proposalIds],
    });
  }

  private setProgress(run: EvaluationRunRecord, progress: Record<string, unknown>): void {
    this.deps.store.updateEvaluationRun({ workspaceId: this.deps.workspaceId(), runId: run.runId, progress });
  }

  private async checkReachable(baseUrl: string): Promise<string | null> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS) });
      return response.ok ? null : `The model server answered ${response.status}.`;
    } catch {
      return "The model server is not responding. Start it again, then retry this run.";
    }
  }

  private async spawnHolaeval(
    run: EvaluationRunRecord,
    args: string[],
    dataDir: string,
    onStdoutLine: (line: string) => void,
  ): Promise<{ code: number | null; stderr: string; stdout: string; cancelled: boolean }> {
    const spawnImpl: SpawnImpl = this.deps.spawnImpl ?? ((command, spawnArgs, options) => spawn(command, spawnArgs, options));
    const python = this.deps.python ?? (process.platform === "win32" ? "python" : "python3");
    const child = spawnImpl(python, args, { cwd: dataDir, env: { ...this.deps.env(), PYTHONUNBUFFERED: "1" } });
    if (this.active?.runId === run.runId) {
      this.active.child = child;
    }
    let stderr = "";
    let stdout = "";
    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-STDOUT_TAIL_BYTES);
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          onStdoutLine(line);
        }
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });
    return await new Promise((resolve) => {
      child.on("error", (error) => {
        resolve({ code: -1, stderr: `${stderr}\n${error.message}`, stdout, cancelled: this.active?.cancelled ?? false });
      });
      child.on("close", (code) => {
        if (buffer.trim()) {
          onStdoutLine(buffer.trim());
        }
        resolve({ code, stderr, stdout, cancelled: this.active?.cancelled ?? false });
      });
    });
  }

  private async probe(run: EvaluationRunRecord, dataDir: string): Promise<void> {
    const manifestPath = path.join(dataDir, `manifest-${run.runKey}.json`);
    if (fs.existsSync(manifestPath)) {
      return;
    }
    const target = runTarget(run);
    this.setProgress(run, { done: 0, total: null, last_line: "Checking the model server" });
    const result = await this.spawnHolaeval(
      run,
      ["-I", this.deps.holaevalPath(), "probe", "--base-url", String(target.base_url ?? ""), "--model", String(target.model_id ?? "")],
      dataDir,
      () => undefined,
    );
    if (result.code === 0) {
      const start = result.stdout.indexOf("{");
      try {
        const manifest = JSON.parse(result.stdout.slice(start)) as Record<string, unknown>;
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      } catch {
        // a manifest is optional; the run still proceeds
      }
    }
  }

  private async execute(queued: EvaluationRunRecord): Promise<void> {
    const workspaceId = this.deps.workspaceId();
    const run = this.deps.store.updateEvaluationRun({
      workspaceId,
      runId: queued.runId,
      status: "running",
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      progress: { done: 0, total: null, last_line: "Starting" },
    });
    if (!run) {
      return;
    }
    this.active = { runId: run.runId, evalId: run.evalId, child: null, cancelled: false };
    try {
      const dataDir = path.join(this.deps.evalDir(run.evalId), "data");
      fs.mkdirSync(dataDir, { recursive: true });
      const target = runTarget(run);
      const unreachable = await this.checkReachable(String(target.base_url ?? ""));
      if (unreachable) {
        this.finish(run, "failed", { error: unreachable });
        return;
      }
      if (run.kind === "speed" && this.deps.waitForBrainIdle) {
        this.setProgress(run, { done: 0, total: null, last_line: "Waiting for the analyst model to finish" });
        await this.deps.waitForBrainIdle(run.evalId);
      }
      if (this.active.cancelled) {
        this.finish(run, "cancelled");
        return;
      }
      await this.probe(run, dataDir);
      if (this.active.cancelled) {
        this.finish(run, "cancelled");
        return;
      }
      const contextWindow = numberOrNull(run.spec.context_window) ?? this.deps.contextWindowFor?.(target) ?? null;
      const args = holaevalArgs({ run, holaevalPath: this.deps.holaevalPath(), dataDir, contextWindow });
      let done = 0;
      let total: number | null = run.kind === "speed" ? SPEED_DEPTHS.length : null;
      let lastWrite = 0;
      const result = await this.spawnHolaeval(run, args, dataDir, (line) => {
        const counter = line.match(/^\[(\d+)\/(\d+)\]/);
        if (counter) {
          done = Number(counter[1]);
          total = Number(counter[2]);
        } else if (run.kind === "speed" && line.startsWith("{") && line.includes('"depth"')) {
          done += 1;
        }
        const now = Date.now();
        if (now - lastWrite > 500 || (total !== null && done >= total)) {
          lastWrite = now;
          this.setProgress(run, { done, total, last_line: lastLine(line) });
        }
      });
      if (result.cancelled) {
        this.finish(run, "cancelled");
        return;
      }
      if (result.code !== 0) {
        const detail = lastLine(result.stderr) || lastLine(result.stdout) || `exited with code ${result.code}`;
        this.finish(run, "failed", { error: detail });
        return;
      }
      const summaryPath = path.join(dataDir, resultFileFor(run));
      let summary: Record<string, unknown> | null = null;
      try {
        summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as Record<string, unknown>;
      } catch {
        this.finish(run, "failed", { error: `No results were written (${resultFileFor(run)}).` });
        return;
      }
      this.setProgress(run, { done: total ?? done, total: total ?? done, last_line: "Finished" });
      this.finish(run, "done", { summary });
    } finally {
      this.active = null;
    }
  }
}
