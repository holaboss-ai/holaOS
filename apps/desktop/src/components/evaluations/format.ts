import type {
  EvalTarget,
  EvalTargetOption,
  EvaluationRun,
  RemoteApiOutputs,
} from "@holaboss/remote-api/contract";

export type EvaluationSummary =
  RemoteApiOutputs["evals"]["list"]["evaluations"][number];
export type EvaluationDetail = RemoteApiOutputs["evals"]["get"];
export type EvaluationRecord = EvaluationDetail["evaluation"];

export type QuestionType = "single_model" | "comparison" | "hardware";

export const QUESTION_TYPE_OPTIONS: Array<{
  value: QuestionType;
  label: string;
  description: string;
  placeholder: string;
}> = [
  {
    value: "single_model",
    label: "One model",
    description: "How well one model runs on this machine.",
    placeholder:
      "e.g. Is qwen3-8b at Q4 good enough to drive a coding agent on a 16 GB laptop?",
  },
  {
    value: "comparison",
    label: "Comparison",
    description: "Two or more models on the same tests, side by side.",
    placeholder:
      "e.g. Q4 or Q8 for gemma-3-12b: is the quality gain worth the slower decode?",
  },
  {
    value: "hardware",
    label: "Hardware",
    description: "How a model runs on this hardware, and where it hits limits.",
    placeholder:
      "e.g. How fast does this machine run a 14B model at 8k vs 32k context?",
  },
];

export function questionTypeLabel(value: string): string {
  return (
    QUESTION_TYPE_OPTIONS.find((option) => option.value === value)?.label ??
    value
  );
}

export type Tone = "neutral" | "active" | "success" | "warning" | "danger";

export const TONE_CLASSES: Record<Tone, string> = {
  neutral: "border-border bg-fg-2 text-muted-foreground",
  active: "border-info/25 bg-info/10 text-info",
  success: "border-success/20 bg-success/8 text-success",
  warning: "border-warning/40 bg-warning/16 text-foreground",
  danger: "border-destructive/20 bg-destructive/8 text-destructive",
};

const EVAL_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  planned: { label: "Planned", tone: "neutral" },
  running: { label: "Running", tone: "active" },
  analyzing: { label: "Analyzing", tone: "active" },
  published: { label: "Published", tone: "success" },
};

const RUN_STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "active" },
  done: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

const PROPOSAL_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Waiting for you", tone: "warning" },
  approved: { label: "Approved", tone: "active" },
  rejected: { label: "Rejected", tone: "neutral" },
  done: { label: "Done", tone: "success" },
};

function statusOf(
  table: Record<string, { label: string; tone: Tone }>,
  value: string,
) {
  return table[value] ?? { label: value, tone: "neutral" as Tone };
}

export const evalStatus = (value: string) => statusOf(EVAL_STATUS, value);
export const runStatus = (value: string) => statusOf(RUN_STATUS, value);
export const proposalStatus = (value: string) =>
  statusOf(PROPOSAL_STATUS, value);

export const RUN_KIND_LABELS: Record<string, string> = {
  speed: "Speed",
  capability: "Capability",
  agent: "Agent",
};

export const AGENT_CONDITION_LABELS: Record<string, string> = {
  full: "Full tools",
  lean: "Lean tools",
};

const ENGINE_LABELS: Record<string, string> = {
  llamacpp: "llama.cpp",
  "llama.cpp": "llama.cpp",
  llama_cpp: "llama.cpp",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  lm_studio: "LM Studio",
  vllm: "vLLM",
};

export function engineLabel(engine: string | null | undefined): string {
  const normalized = (engine ?? "").trim();
  if (!normalized) {
    return "";
  }
  return ENGINE_LABELS[normalized.toLowerCase()] ?? normalized;
}

export function targetKey(
  target: Pick<EvalTarget, "provider_id" | "model_id" | "base_url">,
): string {
  return `${target.provider_id ?? ""}::${target.model_id}::${target.base_url}`;
}

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function targetDetail(
  target: Pick<EvalTarget, "engine" | "base_url">,
): string {
  return [engineLabel(target.engine), hostOf(target.base_url)]
    .filter(Boolean)
    .join(" · ");
}

export function toEvalTarget(option: EvalTargetOption): EvalTarget {
  return {
    provider_id: option.provider_id,
    model_id: option.model_id,
    base_url: option.base_url,
    engine: option.engine,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readTarget(value: unknown): EvalTarget | null {
  if (!isRecord(value)) {
    return null;
  }
  const modelId = typeof value.model_id === "string" ? value.model_id : "";
  const baseUrl = typeof value.base_url === "string" ? value.base_url : "";
  if (!modelId) {
    return null;
  }
  return {
    provider_id:
      typeof value.provider_id === "string" ? value.provider_id : null,
    model_id: modelId,
    base_url: baseUrl,
    engine: typeof value.engine === "string" ? value.engine : null,
  };
}

export interface RunProgress {
  done: number;
  total: number;
  lastLine: string;
}

export function readProgress(run: EvaluationRun): RunProgress | null {
  const progress = run.progress;
  if (!isRecord(progress)) {
    return null;
  }
  const done = typeof progress.done === "number" ? progress.done : 0;
  const total = typeof progress.total === "number" ? progress.total : 0;
  const lastLine =
    typeof progress.last_line === "string" ? progress.last_line : "";
  return { done, total, lastLine };
}

export function isActiveRun(run: Pick<EvaluationRun, "status">): boolean {
  return run.status === "queued" || run.status === "running";
}

export function hasActiveRuns(
  runs: ReadonlyArray<Pick<EvaluationRun, "status">> | undefined,
): boolean {
  return Boolean(runs?.some(isActiveRun));
}

export function formatScalar(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return String(value);
    }
    return Number.isInteger(value)
      ? String(value)
      : String(Math.round(value * 100) / 100);
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean" || value === null) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function relativeTime(value: string | null | undefined): string {
  const normalized = (value ?? "").trim();
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) {
    return normalized;
  }
  const diffMin = Math.round((Date.now() - parsed) / 60_000);
  if (diffMin < 1) {
    return "just now";
  }
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) {
    return `${diffHr}h ago`;
  }
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) {
    return `${diffDay}d ago`;
  }
  return new Date(parsed).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatMinutes(minutes: number | null | undefined): string {
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) {
    return "";
  }
  if (minutes < 1) {
    return "under a minute";
  }
  if (minutes < 60) {
    return `about ${Math.round(minutes)} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest > 0 ? `about ${hours} h ${rest} min` : `about ${hours} h`;
}

export function errorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

export function pluralize(count: number, singular: string, plural?: string) {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}
