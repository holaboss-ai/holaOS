import fs from "node:fs";
import path from "node:path";

import {
  type EvalPlan,
  type EvalPlanRun,
  type EvalTarget,
  evalPlanSchema,
} from "@holaboss/remote-api/contract";
import type {
  EvaluationProposalRecord,
  EvaluationRecord,
  EvaluationRevisionRecord,
  EvaluationRunRecord,
  RuntimeStateStore,
} from "@holaboss/runtime-state-store";

import type { EvaluationEngine } from "./evaluation-engine.js";
import { readLocalModelProviders, resolveProductRuntimeConfig } from "./runtime-config.js";
import { currentRedactionIdentity, redactPublicText, type RedactionIdentity } from "./evaluation-redact.js";
import {
  buildDataLayer,
  collectRawData,
  dataLayerCsv,
  dataLayerMarkdown,
  type EvalDataLayer,
  findUnverifiedNumbers,
  parseReportHtml,
  renderReportHtml,
  renderReportMarkdown,
  resolvePlaceholders,
  shareBody,
  writeCharts,
} from "./evaluation-report.js";

export const EVAL_REQUIRED_KINDS = ["speed", "capability", "agent"] as const;
const ACTIVE_RUN_STATUSES = ["queued", "running"];
const REPORT_GENERATOR = "Evaluated with holaOS · capability pack general-v1 · agent pack agent-v1";

export type EvaluationServiceErrorCode = "NOT_FOUND" | "INVALID_STATE" | "INVALID_PLAN" | "INVALID_REPORT";

export class EvaluationServiceError extends Error {
  readonly code: EvaluationServiceErrorCode;

  constructor(code: EvaluationServiceErrorCode, message: string) {
    super(message);
    this.name = "EvaluationServiceError";
    this.code = code;
  }

  get statusCode(): number {
    switch (this.code) {
      case "NOT_FOUND":
        return 404;
      case "INVALID_STATE":
        return 409;
      default:
        return 422;
    }
  }
}

export interface EvalTargetOption {
  provider_id: string;
  model_id: string;
  base_url: string;
  engine: string;
  context_window: number | null;
  token: string;
}

export interface EvaluationServiceDeps {
  store: RuntimeStateStore;
  engine: EvaluationEngine;
  workspaceId: () => string;
  evalDir: (evalId: string) => string;
  localTargets: () => EvalTargetOption[];
  defaultModel: () => string | null;
  createSession: (params: { title: string }) => string;
  queueSessionMessage: (params: { sessionId: string; text: string; model: string | null }) => Promise<void>;
  redactionIdentity?: () => RedactionIdentity;
  pythonEnv?: () => NodeJS.ProcessEnv;
  now?: () => string;
}

type Wire = Record<string, unknown>;

function evaluationTargetsOf(record: EvaluationRecord): EvalTarget[] {
  const seen = new Map<string, EvalTarget>();
  const planRuns = record.plan && Array.isArray(record.plan.runs) ? (record.plan.runs as EvalPlanRun[]) : [];
  const requested = Array.isArray(record.source?.requested_targets) ? (record.source.requested_targets as EvalTarget[]) : [];
  for (const target of planRuns.length > 0 ? planRuns.map((run) => run.target) : requested) {
    if (target?.model_id && target.base_url) {
      seen.set(targetKey(target), target);
    }
  }
  return [...seen.values()];
}

export function evaluationToWire(record: EvaluationRecord): Wire {
  return {
    targets: evaluationTargetsOf(record),
    eval_id: record.evalId,
    title: record.title,
    question_type: record.questionType,
    question: record.question,
    status: record.status,
    plan: record.plan,
    brain_model: record.brainModel,
    session_id: record.sessionId,
    opinion_md: record.opinionMd,
    opinion_updated_at: record.opinionUpdatedAt,
    distribution: record.distribution,
    report_url: record.reportUrl,
    include_raw_data: record.includeRawData,
    parent_eval_id: record.parentEvalId,
    relation: record.relation,
    source: record.source,
    published_at: record.publishedAt,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

export function runToWire(record: EvaluationRunRecord): Wire {
  return {
    run_id: record.runId,
    eval_id: record.evalId,
    run_key: record.runKey,
    kind: record.kind,
    label: record.label,
    spec: record.spec,
    status: record.status,
    progress: record.progress,
    summary: record.summary,
    error: record.error,
    proposal_id: record.proposalId,
    started_at: record.startedAt,
    finished_at: record.finishedAt,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

export function proposalToWire(record: EvaluationProposalRecord): Wire {
  return {
    proposal_id: record.proposalId,
    eval_id: record.evalId,
    title: record.title,
    rationale: record.rationale,
    evidence: record.evidence,
    runs: record.runs,
    estimate_minutes: record.estimateMinutes,
    status: record.status,
    created_by: record.createdBy,
    decided_at: record.decidedAt,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function revisionToWire(record: EvaluationRevisionRecord): Wire {
  return {
    revision_id: record.revisionId,
    opinion_md: record.opinionMd,
    author: record.author,
    created_at: record.createdAt,
  };
}

function targetKey(target: { base_url: string; model_id: string }): string {
  return `${target.base_url.replace(/\/+$/, "")}::${target.model_id}`;
}

function issuesText(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .map((issue) => `${issue.path.map(String).join(".") || "plan"}: ${issue.message}`)
    .join("; ");
}

export function estimateRunMinutes(run: EvalPlanRun): number {
  const samples = run.samples ?? 3;
  let minutes = 0;
  for (const kind of run.kinds) {
    if (kind === "speed") minutes += 2;
    if (kind === "capability") minutes += 2.5 * samples;
    if (kind === "agent") minutes += 2 * samples * Math.max(1, run.agent_conditions?.length ?? 2);
  }
  return minutes;
}

export function estimatePlanMinutes(runs: EvalPlanRun[]): number {
  return Math.max(1, Math.round(runs.reduce((total, run) => total + estimateRunMinutes(run), 0)));
}

export function validatePlan(
  rawPlan: unknown,
  options: {
    questionType: string;
    requireGeneralPack: boolean;
    reservedKeys?: Set<string>;
    recomputeEstimate?: boolean;
  },
): EvalPlan {
  const parsed = evalPlanSchema.safeParse(rawPlan);
  if (!parsed.success) {
    throw new EvaluationServiceError("INVALID_PLAN", issuesText(parsed.error.issues));
  }
  const plan = parsed.data;
  const keys = new Set<string>();
  for (const run of plan.runs) {
    if (keys.has(run.key)) {
      throw new EvaluationServiceError("INVALID_PLAN", `run key "${run.key}" is used twice`);
    }
    if (options.reservedKeys?.has(run.key)) {
      throw new EvaluationServiceError("INVALID_PLAN", `run key "${run.key}" already exists in this evaluation`);
    }
    keys.add(run.key);
  }
  if (options.questionType === "comparison" && plan.runs.length < 2) {
    throw new EvaluationServiceError("INVALID_PLAN", "a comparison needs at least two runs");
  }
  if (options.requireGeneralPack) {
    const covered = new Map<string, { label: string; kinds: Set<string> }>();
    for (const run of plan.runs) {
      const key = targetKey(run.target);
      const entry = covered.get(key) ?? { label: run.label, kinds: new Set<string>() };
      for (const kind of run.kinds) entry.kinds.add(kind);
      covered.set(key, entry);
    }
    for (const entry of covered.values()) {
      const missing = EVAL_REQUIRED_KINDS.filter((kind) => !entry.kinds.has(kind));
      if (missing.length > 0) {
        throw new EvaluationServiceError(
          "INVALID_PLAN",
          `every model in the plan runs the standard pack (speed, capability, agent); ${entry.label} is missing ${missing.join(", ")}`,
        );
      }
    }
  }
  return {
    ...plan,
    estimate_minutes:
      options.recomputeEstimate || plan.estimate_minutes == null ? estimatePlanMinutes(plan.runs) : plan.estimate_minutes,
  };
}

function runSpec(run: EvalPlanRun, contextWindow: number | null): Record<string, unknown> {
  return {
    target: run.target,
    sampling: run.sampling ?? null,
    samples: run.samples ?? null,
    agent_conditions: run.agent_conditions ?? ["full", "lean"],
    context_window: contextWindow,
    notes: run.notes ?? null,
  };
}

function compactSummary(run: EvaluationRunRecord): Record<string, unknown> | null {
  const summary = run.summary;
  if (!summary) {
    return null;
  }
  if (run.kind === "speed") {
    const depths = Array.isArray(summary.depths) ? summary.depths : [];
    return {
      depths: depths.map((row) => {
        const entry = (row ?? {}) as Record<string, unknown>;
        return {
          depth: entry.depth,
          decode_tps: entry.engine_decode_tps ?? entry.decode_tps,
          prefill_tps: entry.engine_prefill_tps ?? entry.prefill_tps,
          ttft_s: entry.ttft_s,
          skipped: entry.skipped,
        };
      }),
    };
  }
  if (run.kind === "capability") {
    return { by_category: summary.by_category, skipped: summary.skipped };
  }
  if (run.kind === "agent") {
    const conditions = (summary.conditions ?? {}) as Record<string, Record<string, unknown>>;
    return {
      conditions: Object.fromEntries(
        Object.entries(conditions).map(([condition, entry]) => [
          condition,
          {
            passed: entry.passed,
            n: entry.n,
            prompt_tokens_avg: entry.prompt_tokens_avg,
            first_response_s_avg: entry.first_response_s_avg,
          },
        ]),
      ),
      skipped: summary.skipped,
    };
  }
  return summary;
}

export function currentDefaultModel(): string | null {
  try {
    return resolveProductRuntimeConfig({ requireAuth: false, requireBaseUrl: false }).defaultModel || null;
  } catch {
    return null;
  }
}

export function localEvalTargets(): EvalTargetOption[] {
  const options: EvalTargetOption[] = [];
  for (const provider of readLocalModelProviders()) {
    for (const modelId of provider.model_ids) {
      options.push({
        provider_id: provider.provider_id,
        model_id: modelId,
        base_url: provider.base_url,
        engine: provider.engine || "openai_compatible",
        context_window: provider.context_windows[modelId] ?? null,
        token: `${provider.provider_id}/${modelId}`,
      });
    }
  }
  return options;
}

export function evaluationDir(store: RuntimeStateStore, workspaceId: string, evalId: string): string {
  return path.join(store.workspaceDir(workspaceId), "evals", evalId);
}

export function renderEvaluationAgentContext(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  record: EvaluationRecord;
  evalDir: string;
  targets: EvalTargetOption[];
  defaultModel: string | null;
}): string {
  const { record } = params;
  const runs = params.store.listEvaluationRuns({ workspaceId: params.workspaceId, evalId: record.evalId });
  const proposals = params.store.listEvaluationProposals({ workspaceId: params.workspaceId, evalId: record.evalId });
  const targets = params.targets;
  const lines: string[] = [
    "## Evaluation mode",
    "",
    `This conversation is the analyst chat for the evaluation "${record.title}". The developer publishes the report under their own name; you help them plan, run, read and write it.`,
    "",
    `- Question (${record.questionType.replace("_", " ")}): ${record.question}`,
    `- Status: ${record.status}`,
    runs.length > 0
      ? `- Data files: ${path.join(params.evalDir, "data")} (raw task files are large; search them for a task id instead of reading them whole)`
      : "- Nothing has run yet; there are no data files.",
    `- Analyst model: ${record.brainModel ?? params.defaultModel ?? "default"}${(record.brainModel ?? params.defaultModel ?? "").startsWith("local_") ? " (runs on this machine; speed tests wait until you are idle)" : ""}`,
    "",
    "How to work:",
    "1. Plan: call eval_set_plan with runs (key, label, target, kinds, sampling, samples, agent_conditions). Every model in the plan must run all three standard kinds: speed, capability (general-v1) and agent (agent-v1, conditions full and lean). Add extra runs only when they answer the question (e.g. another quantization, sampling or thinking setting). Say what each run is for in `notes`. Then tell the developer to review the plan and press Start; you cannot start runs yourself.",
    "2. While runs execute, stay brief. When they finish, read the summaries and the raw task files, look for anomalies (truncated answers, format failures, a category far below the others, high variance, a skipped depth), and when one needs an experiment to explain it call eval_propose_followup: change one variable at a time, cite evidence (run key, task id, sample, what the output showed), estimate minutes. The developer approves it.",
    "3. Opinion: draft it with eval_write_opinion in the developer's first person, plain and specific: the answer to the question first, then what the numbers mean, trade-offs, who should use it, limits. Never type a measured number: cite it with a placeholder like {{speed.<run_key>.decode_tps@0}} — available keys are listed by eval_get. The developer edits and owns this text.",
    "4. Distribution: after the report is published, draft posts with eval_draft_posts (x_post, x_thread, cn_post, video_script). Every number comes from the report; link to the report URL when it is set.",
  ];
  if (targets.length > 0) {
    lines.push("", "Local models available as targets:");
    for (const target of targets.slice(0, 12)) {
      lines.push(
        `- provider_id ${target.provider_id}, model_id ${target.model_id}, base_url ${target.base_url}, engine ${target.engine}${target.context_window ? `, served context ${target.context_window}` : ""}`,
      );
    }
  } else {
    lines.push("", "No local model server is registered right now; ask the developer to start one (llama.cpp, Ollama, LM Studio or vLLM).");
  }
  if (record.plan) {
    lines.push("", "Current plan:", "```json", JSON.stringify(record.plan), "```");
  }
  if (runs.length > 0) {
    lines.push("", "Runs:");
    for (const run of runs) {
      const progress = run.progress as { done?: number; total?: number } | null;
      const detail =
        run.status === "running" && progress?.total
          ? ` ${progress.done ?? 0}/${progress.total}`
          : run.status === "failed"
            ? ` — ${run.error ?? "failed"}`
            : "";
      lines.push(`- ${run.runKey} · ${run.kind}: ${run.status}${detail}`);
    }
  }
  const pending = proposals.filter((proposal) => proposal.status === "pending");
  if (pending.length > 0) {
    lines.push("", `Follow-ups waiting for the developer: ${pending.map((proposal) => proposal.title).join("; ")}`);
  }
  lines.push(
    "",
    `Opinion layer: ${record.opinionMd.trim() ? `${record.opinionMd.trim().length} characters, last edited ${record.opinionUpdatedAt ?? "unknown"}` : "empty"}.`,
  );
  if (record.status === "published") {
    lines.push(
      `Published ${record.publishedAt ?? ""}; the data layer is locked.${record.reportUrl ? ` Report URL: ${record.reportUrl}` : " The developer has not pasted the post URL yet."}`,
    );
  }
  return lines.join("\n");
}

export class EvaluationService {
  private readonly deps: EvaluationServiceDeps;

  constructor(deps: EvaluationServiceDeps) {
    this.deps = deps;
  }

  private get ws(): string {
    return this.deps.workspaceId();
  }

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private identity(): RedactionIdentity {
    return this.deps.redactionIdentity?.() ?? currentRedactionIdentity();
  }

  private require(evalId: string): EvaluationRecord {
    const record = this.deps.store.getEvaluation({ workspaceId: this.ws, evalId });
    if (!record) {
      throw new EvaluationServiceError("NOT_FOUND", "evaluation not found");
    }
    return record;
  }

  private requireForSession(sessionId: string): EvaluationRecord {
    const record = this.deps.store.getEvaluationBySessionId({ workspaceId: this.ws, sessionId });
    if (!record) {
      throw new EvaluationServiceError(
        "NOT_FOUND",
        "this conversation is not attached to an evaluation; open the evaluation in holaOS and chat there",
      );
    }
    return record;
  }

  private runsOf(evalId: string): EvaluationRunRecord[] {
    return this.deps.store.listEvaluationRuns({ workspaceId: this.ws, evalId });
  }

  private brainIsLocal(record: EvaluationRecord): boolean {
    const model = record.brainModel ?? this.deps.defaultModel() ?? "";
    return model.startsWith("local_");
  }

  private contextWindowFor(target: EvalTarget): number | null {
    const match = this.deps
      .localTargets()
      .find(
        (option) =>
          option.model_id === target.model_id &&
          (option.provider_id === target.provider_id ||
            option.base_url.replace(/\/+$/, "") === target.base_url.replace(/\/+$/, "")),
      );
    return match?.context_window ?? null;
  }

  // ---- reads ----

  list(input: { limit?: number }): Wire {
    const evaluations = this.deps.store.listEvaluations({ workspaceId: this.ws, limit: input.limit });
    return {
      evaluations: evaluations.map((record) => {
        const runs = this.runsOf(record.evalId);
        const count = (status: string) => runs.filter((run) => run.status === status).length;
        const targets = new Set(evaluationTargetsOf(record).map((target) => target.model_id));
        return {
          ...evaluationToWire(record),
          run_counts: {
            total: runs.length,
            queued: count("queued"),
            running: count("running"),
            done: count("done"),
            failed: count("failed") + count("cancelled"),
          },
          targets: [...targets],
          pending_proposals: this.deps.store
            .listEvaluationProposals({ workspaceId: this.ws, evalId: record.evalId })
            .filter((proposal) => proposal.status === "pending").length,
        };
      }),
    };
  }

  get(input: { evalId: string }): Wire {
    const record = this.require(input.evalId);
    const newer = this.deps.store
      .listEvaluations({ workspaceId: this.ws, limit: 500 })
      .find((candidate) => candidate.parentEvalId === record.evalId && candidate.relation === "version");
    return {
      evaluation: evaluationToWire(record),
      runs: this.runsOf(record.evalId).map(runToWire),
      proposals: this.deps.store.listEvaluationProposals({ workspaceId: this.ws, evalId: record.evalId }).map(proposalToWire),
      revisions: this.deps.store
        .listEvaluationRevisions({ workspaceId: this.ws, evalId: record.evalId, limit: 20 })
        .map(revisionToWire),
      newer_version_id: newer?.evalId ?? null,
    };
  }

  targets(): Wire {
    return { targets: this.deps.localTargets() };
  }

  // ---- lifecycle ----

  async create(input: {
    title?: string | null;
    questionType: string;
    question: string;
    brainModel?: string | null;
    targets?: EvalTarget[];
  }): Promise<Wire> {
    const title = input.title?.trim() || input.question.trim().replace(/\s+/g, " ").slice(0, 80);
    const sessionId = this.deps.createSession({ title: `Eval · ${title}` });
    const record = this.deps.store.createEvaluation({
      workspaceId: this.ws,
      title,
      questionType: input.questionType,
      question: input.question.trim(),
      brainModel: input.brainModel ?? null,
      sessionId,
      source: input.targets && input.targets.length > 0 ? { requested_targets: input.targets } : null,
    });
    const targetLines = (input.targets ?? []).map(
      (target) => `- ${target.model_id} (${target.engine ?? "local"}, ${target.provider_id ?? target.base_url})`,
    );
    const text = [
      `Plan this evaluation and save the plan with eval_set_plan.`,
      "",
      `Question: ${record.question}`,
      `Type: ${record.questionType.replace("_", " ")}`,
      ...(targetLines.length > 0 ? ["Models to test:", ...targetLines] : []),
    ].join("\n");
    let kickoffError: string | null = null;
    try {
      await this.deps.queueSessionMessage({ sessionId, text, model: record.brainModel });
    } catch (error) {
      kickoffError = error instanceof Error ? error.message : String(error);
    }
    return { ...evaluationToWire(record), kickoff_error: kickoffError };
  }

  update(input: { evalId: string; title?: string; brainModel?: string | null; includeRawData?: boolean }): Wire {
    this.require(input.evalId);
    const record = this.deps.store.updateEvaluation({
      workspaceId: this.ws,
      evalId: input.evalId,
      title: input.title,
      brainModel: input.brainModel === undefined ? undefined : input.brainModel,
      includeRawData: input.includeRawData,
    });
    return evaluationToWire(record ?? this.require(input.evalId));
  }

  setPlan(input: { evalId: string; plan: unknown }, options: { keepEstimate?: boolean } = {}): Wire {
    const record = this.require(input.evalId);
    if (record.status !== "draft" && record.status !== "planned") {
      throw new EvaluationServiceError(
        "INVALID_STATE",
        "the plan is locked once the evaluation has started; propose a follow-up experiment instead",
      );
    }
    const plan = validatePlan(input.plan, {
      questionType: record.questionType,
      requireGeneralPack: false,
      recomputeEstimate: !options.keepEstimate,
    });
    const updated = this.deps.store.updateEvaluation({
      workspaceId: this.ws,
      evalId: record.evalId,
      plan: plan as unknown as Record<string, unknown>,
      status: "planned",
    });
    return evaluationToWire(updated ?? record);
  }

  start(input: { evalId: string }): Wire {
    const record = this.require(input.evalId);
    if (record.status !== "planned") {
      throw new EvaluationServiceError(
        "INVALID_STATE",
        record.status === "draft" ? "there is no plan yet" : "this evaluation has already started",
      );
    }
    const plan = validatePlan(record.plan, { questionType: record.questionType, requireGeneralPack: true });
    this.deps.store.deleteEvaluationRuns({
      workspaceId: this.ws,
      evalId: record.evalId,
      statuses: ["queued", "cancelled", "failed"],
    });
    for (const run of plan.runs) {
      for (const kind of EVAL_REQUIRED_KINDS.filter((candidate) => run.kinds.includes(candidate))) {
        this.deps.store.createEvaluationRun({
          workspaceId: this.ws,
          evalId: record.evalId,
          runKey: run.key,
          kind,
          label: run.label,
          spec: runSpec(run, this.contextWindowFor(run.target)),
        });
      }
    }
    this.deps.store.updateEvaluation({ workspaceId: this.ws, evalId: record.evalId, status: "running" });
    this.deps.engine.wake();
    return this.get({ evalId: record.evalId });
  }

  cancel(input: { evalId: string }): Wire {
    const record = this.require(input.evalId);
    this.deps.engine.cancelEvaluation(record.evalId);
    const runs = this.runsOf(record.evalId);
    if (!runs.some((run) => run.status === "running")) {
      const anyDone = runs.some((run) => run.status === "done");
      if (record.status === "running") {
        if (anyDone) {
          this.deps.store.updateEvaluation({ workspaceId: this.ws, evalId: record.evalId, status: "analyzing" });
        } else {
          this.deps.store.deleteEvaluationRuns({ workspaceId: this.ws, evalId: record.evalId, statuses: ["cancelled"] });
          this.deps.store.updateEvaluation({ workspaceId: this.ws, evalId: record.evalId, status: "planned" });
        }
      }
    }
    return this.get({ evalId: record.evalId });
  }

  retryRun(input: { evalId: string; runId: string }): Wire {
    const record = this.require(input.evalId);
    if (record.status === "published") {
      throw new EvaluationServiceError("INVALID_STATE", "published results are locked; re-run as a new version");
    }
    const run = this.deps.store.getEvaluationRun({ workspaceId: this.ws, runId: input.runId });
    if (!run || run.evalId !== record.evalId) {
      throw new EvaluationServiceError("NOT_FOUND", "run not found");
    }
    if (run.status !== "failed" && run.status !== "cancelled") {
      throw new EvaluationServiceError("INVALID_STATE", "only failed or cancelled runs can be retried");
    }
    this.deps.store.updateEvaluationRun({
      workspaceId: this.ws,
      runId: run.runId,
      status: "queued",
      error: null,
      progress: null,
      startedAt: null,
      finishedAt: null,
    });
    this.deps.store.updateEvaluation({ workspaceId: this.ws, evalId: record.evalId, status: "running" });
    this.deps.engine.wake();
    return this.get({ evalId: record.evalId });
  }

  decideProposal(input: { evalId: string; proposalId: string; decision: "approve" | "reject" }): Wire {
    const record = this.require(input.evalId);
    const proposal = this.deps.store.getEvaluationProposal({ workspaceId: this.ws, proposalId: input.proposalId });
    if (!proposal || proposal.evalId !== record.evalId) {
      throw new EvaluationServiceError("NOT_FOUND", "proposal not found");
    }
    if (proposal.status !== "pending") {
      throw new EvaluationServiceError("INVALID_STATE", "the proposal was already decided");
    }
    if (input.decision === "reject") {
      this.deps.store.setEvaluationProposalStatus({ workspaceId: this.ws, proposalId: proposal.proposalId, status: "rejected" });
      return this.get({ evalId: record.evalId });
    }
    if (record.status === "published") {
      throw new EvaluationServiceError("INVALID_STATE", "published results are locked; re-run as a new version");
    }
    const reserved = new Set(this.runsOf(record.evalId).map((run) => run.runKey));
    const plan = validatePlan(
      { runs: proposal.runs },
      { questionType: "single_model", requireGeneralPack: false, reservedKeys: reserved },
    );
    for (const run of plan.runs) {
      for (const kind of EVAL_REQUIRED_KINDS.filter((candidate) => run.kinds.includes(candidate))) {
        this.deps.store.createEvaluationRun({
          workspaceId: this.ws,
          evalId: record.evalId,
          runKey: run.key,
          kind,
          label: run.label,
          spec: runSpec(run, this.contextWindowFor(run.target)),
          proposalId: proposal.proposalId,
        });
      }
    }
    this.deps.store.setEvaluationProposalStatus({ workspaceId: this.ws, proposalId: proposal.proposalId, status: "approved" });
    this.deps.store.updateEvaluation({ workspaceId: this.ws, evalId: record.evalId, status: "running" });
    this.deps.engine.wake();
    return this.get({ evalId: record.evalId });
  }

  saveOpinion(input: { evalId: string; opinionMd: string }, author = "user"): Wire {
    const record = this.require(input.evalId);
    if (record.opinionMd === input.opinionMd) {
      return evaluationToWire(record);
    }
    const now = this.now();
    this.deps.store.addEvaluationRevision({ workspaceId: this.ws, evalId: record.evalId, opinionMd: input.opinionMd, author });
    const updated = this.deps.store.updateEvaluation({
      workspaceId: this.ws,
      evalId: record.evalId,
      opinionMd: input.opinionMd,
      opinionUpdatedAt: now,
    });
    return evaluationToWire(updated ?? record);
  }

  saveDistribution(input: { evalId: string; distribution: Record<string, unknown> }): Wire {
    const record = this.require(input.evalId);
    const updated = this.deps.store.updateEvaluation({
      workspaceId: this.ws,
      evalId: record.evalId,
      distribution: { ...input.distribution, updated_at: this.now() },
    });
    return evaluationToWire(updated ?? record);
  }

  setReportUrl(input: { evalId: string; url: string | null }): Wire {
    const record = this.require(input.evalId);
    const updated = this.deps.store.updateEvaluation({ workspaceId: this.ws, evalId: record.evalId, reportUrl: input.url });
    return evaluationToWire(updated ?? record);
  }

  delete(input: { evalId: string }): Wire {
    const record = this.require(input.evalId);
    if (this.runsOf(record.evalId).some((run) => ACTIVE_RUN_STATUSES.includes(run.status))) {
      throw new EvaluationServiceError("INVALID_STATE", "stop the running evaluation first");
    }
    const removed = this.deps.store.deleteEvaluation({ workspaceId: this.ws, evalId: record.evalId });
    fs.rmSync(this.deps.evalDir(record.evalId), { recursive: true, force: true });
    if (record.sessionId && this.deps.store.getSession({ workspaceId: this.ws, sessionId: record.sessionId })) {
      this.deps.store.deleteSession({ workspaceId: this.ws, sessionId: record.sessionId });
    }
    return { success: removed };
  }

  createVersion(input: { evalId: string }): Wire {
    const record = this.require(input.evalId);
    const title = record.title;
    const sessionId = this.deps.createSession({ title: `Eval · ${title} (new version)` });
    const created = this.deps.store.createEvaluation({
      workspaceId: this.ws,
      title,
      questionType: record.questionType,
      question: record.question,
      status: record.plan ? "planned" : "draft",
      plan: record.plan,
      brainModel: record.brainModel,
      sessionId,
      parentEvalId: record.evalId,
      relation: "version",
      source: { title: record.title, url: record.reportUrl, published_at: record.publishedAt },
    });
    return evaluationToWire(created);
  }

  importReproduction(input: { reportHtml: string; target?: EvalTarget | null; sourceUrl?: string | null }): Wire {
    const parsed = parseReportHtml(input.reportHtml);
    if (!parsed) {
      throw new EvaluationServiceError("INVALID_REPORT", "this file is not a holaOS evaluation report");
    }
    const options = this.deps.localTargets();
    let plan: Record<string, unknown> | null = null;
    const originalRuns = Array.isArray(parsed.plan?.runs) ? (parsed.plan?.runs as EvalPlanRun[]) : [];
    if (originalRuns.length > 0) {
      const distinctTargets = new Set(originalRuns.map((run) => run.target?.model_id));
      const runs = originalRuns.map((run) => {
        const local = distinctTargets.size > 1 || !input.target
          ? options.find((option) => option.model_id === run.target?.model_id)
          : undefined;
        const replacement: EvalTarget | null = local
          ? { provider_id: local.provider_id, model_id: local.model_id, base_url: local.base_url, engine: local.engine }
          : (input.target ?? null);
        return replacement ? { ...run, target: replacement } : run;
      });
      const candidate = evalPlanSchema.safeParse({
        runs,
        estimate_minutes: estimatePlanMinutes(runs),
        notes: typeof parsed.plan?.notes === "string" ? parsed.plan.notes : null,
      });
      plan = candidate.success ? (candidate.data as unknown as Record<string, unknown>) : null;
    }
    const sessionId = this.deps.createSession({ title: `Eval · ${parsed.title} (reproduction)` });
    const created = this.deps.store.createEvaluation({
      workspaceId: this.ws,
      title: `${parsed.title} (reproduction)`,
      questionType: parsed.question_type,
      question: parsed.question,
      status: plan ? "planned" : "draft",
      plan,
      sessionId,
      relation: "reproduction",
      source: { title: parsed.title, url: input.sourceUrl ?? null, original_plan: parsed.plan },
    });
    return evaluationToWire(created);
  }

  // ---- report ----

  private liveDataLayer(record: EvaluationRecord): EvalDataLayer {
    return buildDataLayer({
      evaluation: record,
      runs: this.runsOf(record.evalId),
      proposals: this.deps.store.listEvaluationProposals({ workspaceId: this.ws, evalId: record.evalId }),
      dataDir: path.join(this.deps.evalDir(record.evalId), "data"),
      brainIsLocal: this.brainIsLocal(record),
      now: this.now(),
    });
  }

  dataLayerFor(record: EvaluationRecord): { layer: EvalDataLayer; frozen: boolean } {
    if (record.snapshot && record.snapshot.schema) {
      return { layer: record.snapshot as unknown as EvalDataLayer, frozen: true };
    }
    return { layer: this.liveDataLayer(record), frozen: false };
  }

  report(input: { evalId: string }): Wire {
    const record = this.require(input.evalId);
    const { layer, frozen } = this.dataLayerFor(record);
    const resolved = resolvePlaceholders(record.opinionMd, layer.values);
    const charts = writeCharts({
      layer,
      title: record.title,
      chartsDir: path.join(this.deps.evalDir(record.evalId), "report", "charts"),
      identity: this.identity(),
    });
    return {
      data_layer: layer as unknown as Record<string, unknown>,
      markdown: dataLayerMarkdown(layer),
      opinion_rendered_md: resolved.text,
      placeholders: Object.entries(layer.values).map(([key, entry]) => ({ key, value: entry.value, label: entry.label })),
      unresolved_placeholders: resolved.unresolved,
      unverified_numbers: findUnverifiedNumbers(record.opinionMd, layer.values),
      charts: charts.map((chart) => ({ id: chart.id, title: chart.title, svg: chart.svg })),
      frozen,
    };
  }

  private writeReportFiles(record: EvaluationRecord): { dir: string; files: string[]; charts: Array<{ id: string; pngPath: string | null }> } {
    const { layer } = this.dataLayerFor(record);
    if (layer.runs.length === 0 || (layer.speed.length === 0 && layer.capability.length === 0 && layer.agent.length === 0)) {
      throw new EvaluationServiceError("INVALID_STATE", "nothing has finished running yet");
    }
    const identity = this.identity();
    const evalDir = this.deps.evalDir(record.evalId);
    const reportDir = path.join(evalDir, "report");
    const chartsDir = path.join(reportDir, "charts");
    fs.mkdirSync(chartsDir, { recursive: true });
    const charts = writeCharts({ layer, title: record.title, chartsDir, identity, png: true, env: this.deps.pythonEnv?.() });
    const opinion = redactPublicText(resolvePlaceholders(record.opinionMd, layer.values).text, identity);
    const publicLayer = JSON.parse(redactPublicText(JSON.stringify(layer), identity)) as EvalDataLayer;
    const publicRecord: EvaluationRecord = {
      ...record,
      title: redactPublicText(record.title, identity),
      question: redactPublicText(record.question, identity),
    };
    const runKeys = new Set(layer.runs.map((run) => run.key));
    const rawData = record.includeRawData ? collectRawData(path.join(evalDir, "data"), runKeys, identity) : null;
    const publicPlan = record.plan ? (JSON.parse(redactPublicText(JSON.stringify(record.plan), identity)) as Record<string, unknown>) : null;
    const html = renderReportHtml({
      evaluation: publicRecord,
      layer: publicLayer,
      opinionMarkdown: opinion,
      charts,
      plan: publicPlan,
      rawData,
      generator: REPORT_GENERATOR,
    });
    const markdown = renderReportMarkdown({
      evaluation: publicRecord,
      layer: publicLayer,
      opinionMarkdown: opinion,
      charts,
      generator: REPORT_GENERATOR,
      chartRefs: Object.fromEntries(charts.map((chart) => [chart.id, `charts/${chart.id}.${chart.pngPath ? "png" : "svg"}`])),
    });
    const files = [
      path.join(reportDir, "report.html"),
      path.join(reportDir, "report.md"),
      path.join(reportDir, "data.csv"),
    ];
    fs.writeFileSync(files[0] as string, html, "utf8");
    fs.writeFileSync(files[1] as string, markdown, "utf8");
    fs.writeFileSync(files[2] as string, dataLayerCsv(publicLayer), "utf8");
    for (const chart of charts) {
      files.push(chart.svgPath);
      if (chart.pngPath) {
        files.push(chart.pngPath);
      }
    }
    return { dir: reportDir, files, charts: charts.map((chart) => ({ id: chart.id, pngPath: chart.pngPath })) };
  }

  exportReport(input: { evalId: string }): Wire {
    const record = this.require(input.evalId);
    const written = this.writeReportFiles(record);
    return { dir: written.dir, files: written.files };
  }

  publish(input: { evalId: string }): Wire {
    let record = this.require(input.evalId);
    if (record.status === "running" || this.runsOf(record.evalId).some((run) => ACTIVE_RUN_STATUSES.includes(run.status))) {
      throw new EvaluationServiceError("INVALID_STATE", "wait for the running tests to finish before publishing");
    }
    if (record.status !== "analyzing" && record.status !== "published") {
      throw new EvaluationServiceError("INVALID_STATE", "run the evaluation before publishing");
    }
    if (!record.snapshot) {
      const layer = this.liveDataLayer(record);
      record =
        this.deps.store.updateEvaluation({
          workspaceId: this.ws,
          evalId: record.evalId,
          snapshot: layer as unknown as Record<string, unknown>,
          status: "published",
          publishedAt: this.now(),
        }) ?? record;
    }
    const written = this.writeReportFiles(record);
    const { layer } = this.dataLayerFor(record);
    const identity = this.identity();
    const opinion = redactPublicText(resolvePlaceholders(record.opinionMd, layer.values).text, identity);
    const encode = (filePath: string, contentType: string) => ({
      file_name: path.basename(filePath),
      content_type: contentType,
      data_base64: fs.readFileSync(filePath).toString("base64"),
    });
    const images = written.charts
      .filter((chart): chart is { id: string; pngPath: string } => Boolean(chart.pngPath))
      .slice(0, 4)
      .map((chart) => encode(chart.pngPath, "image/png"));
    const files = [
      encode(path.join(written.dir, "report.html"), "text/html"),
      encode(path.join(written.dir, "report.md"), "text/markdown"),
      encode(path.join(written.dir, "data.csv"), "text/csv"),
    ];
    return {
      title: redactPublicText(record.title, identity),
      body: redactPublicText(shareBody({ evaluation: record, layer, opinionMarkdown: opinion }), identity),
      images,
      files,
      dir: written.dir,
      evaluation: evaluationToWire(record),
    };
  }

  // ---- agent surface (scoped to the evaluation bound to the session) ----

  agentContext(sessionId: string): string | null {
    const record = this.deps.store.getEvaluationBySessionId({ workspaceId: this.ws, sessionId });
    if (!record) {
      return null;
    }
    return this.renderAgentContext(record);
  }

  renderAgentContext(record: EvaluationRecord): string {
    return renderEvaluationAgentContext({
      store: this.deps.store,
      workspaceId: this.ws,
      record,
      evalDir: this.deps.evalDir(record.evalId),
      targets: this.deps.localTargets(),
      defaultModel: this.deps.defaultModel(),
    });
  }

  agentGet(sessionId: string): Wire {
    const record = this.requireForSession(sessionId);
    const { layer, frozen } = this.dataLayerFor(record);
    const proposals = this.deps.store.listEvaluationProposals({ workspaceId: this.ws, evalId: record.evalId });
    return {
      evaluation: {
        eval_id: record.evalId,
        title: record.title,
        question: record.question,
        question_type: record.questionType,
        status: record.status,
        plan: record.plan,
        report_url: record.reportUrl,
        opinion_md: record.opinionMd,
      },
      data_dir: path.join(this.deps.evalDir(record.evalId), "data"),
      runs: this.runsOf(record.evalId).map((run) => ({
        run_key: run.runKey,
        kind: run.kind,
        label: run.label,
        status: run.status,
        error: run.error,
        progress: run.progress,
        target: run.spec.target,
        result: compactSummary(run),
      })),
      proposals: proposals.map((proposal) => ({
        title: proposal.title,
        status: proposal.status,
        rationale: proposal.rationale,
        runs: proposal.runs,
      })),
      placeholders: Object.fromEntries(
        Object.entries(layer.values).map(([key, entry]) => [key, `${entry.value} — ${entry.label}`]),
      ),
      data_layer_locked: frozen,
      limitations: layer.limitations,
      targets: this.deps.localTargets(),
    };
  }

  agentSetPlan(sessionId: string, plan: unknown): Wire {
    const record = this.requireForSession(sessionId);
    const updated = this.setPlan({ evalId: record.evalId, plan }, { keepEstimate: true });
    return {
      ok: true,
      status: updated.status,
      plan: updated.plan,
      next: "Ask the developer to review the plan in the Plan tab and press Start.",
    };
  }

  agentProposeFollowup(
    sessionId: string,
    input: { title: string; rationale: string; evidence: unknown[]; runs: unknown[]; estimate_minutes?: number | null },
  ): Wire {
    const record = this.requireForSession(sessionId);
    if (record.status === "published") {
      throw new EvaluationServiceError("INVALID_STATE", "the report is published; follow-ups belong in a new version");
    }
    if (record.status === "draft" || record.status === "planned") {
      throw new EvaluationServiceError("INVALID_STATE", "the evaluation has not run yet; change the plan instead");
    }
    if (!input.title?.trim() || !input.rationale?.trim()) {
      throw new EvaluationServiceError("INVALID_PLAN", "title and rationale are required");
    }
    if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
      throw new EvaluationServiceError("INVALID_PLAN", "cite at least one piece of evidence");
    }
    const reserved = new Set(this.runsOf(record.evalId).map((run) => run.runKey));
    const pendingKeys = this.deps.store
      .listEvaluationProposals({ workspaceId: this.ws, evalId: record.evalId })
      .filter((proposal) => proposal.status === "pending")
      .flatMap((proposal) => proposal.runs.map((run) => (run as { key?: string }).key ?? ""));
    for (const key of pendingKeys) reserved.add(key);
    const plan = validatePlan(
      { runs: input.runs },
      { questionType: "single_model", requireGeneralPack: false, reservedKeys: reserved },
    );
    const proposal = this.deps.store.createEvaluationProposal({
      workspaceId: this.ws,
      evalId: record.evalId,
      title: input.title,
      rationale: input.rationale,
      evidence: input.evidence,
      runs: plan.runs,
      estimateMinutes: input.estimate_minutes ?? estimatePlanMinutes(plan.runs),
      createdBy: "agent",
    });
    return {
      ok: true,
      proposal: proposalToWire(proposal),
      next: "The developer approves or rejects it in the Findings tab.",
    };
  }

  agentWriteOpinion(sessionId: string, opinionMd: string): Wire {
    const record = this.requireForSession(sessionId);
    const { layer } = this.dataLayerFor(record);
    this.saveOpinion({ evalId: record.evalId, opinionMd }, "agent");
    const resolved = resolvePlaceholders(opinionMd, layer.values);
    return {
      ok: true,
      unresolved_placeholders: resolved.unresolved,
      unverified_numbers: findUnverifiedNumbers(opinionMd, layer.values),
      next: "Tell the developer the draft is in the Report tab for them to edit.",
    };
  }

  agentDraftPosts(sessionId: string, distribution: Record<string, unknown>): Wire {
    const record = this.requireForSession(sessionId);
    const { layer } = this.dataLayerFor(record);
    const resolvedDistribution = JSON.parse(
      JSON.stringify(distribution, (_key, value: unknown) =>
        typeof value === "string" ? resolvePlaceholders(value, layer.values).text : value,
      ),
    ) as Record<string, unknown>;
    const merged = { ...(record.distribution ?? {}), ...resolvedDistribution };
    this.saveDistribution({ evalId: record.evalId, distribution: merged });
    const text = JSON.stringify(resolvedDistribution);
    return {
      ok: true,
      unverified_numbers: findUnverifiedNumbers(text, layer.values),
      next: "The drafts are in the Distribute tab for the developer to edit and copy.",
    };
  }

  // ---- engine callback ----

  async onRunsSettled(event: { evalId: string; done: number; failed: number; cancelled: number; proposalIds: string[] }): Promise<void> {
    const record = this.deps.store.getEvaluation({ workspaceId: this.ws, evalId: event.evalId });
    if (!record?.sessionId) {
      return;
    }
    const parts = [`${event.done} finished`];
    if (event.failed > 0) parts.push(`${event.failed} failed`);
    if (event.cancelled > 0) parts.push(`${event.cancelled} cancelled`);
    const followups = event.proposalIds.length > 0 ? "The approved follow-up experiment finished." : "All planned runs are done.";
    const text = [
      `[Evaluation update] ${followups} Runs: ${parts.join(", ")}.`,
      "Read the results (eval_get and the data files), propose follow-up experiments if something needs explaining, then draft or update the opinion with eval_write_opinion.",
    ].join("\n");
    await this.deps.queueSessionMessage({ sessionId: record.sessionId, text, model: record.brainModel });
  }
}
