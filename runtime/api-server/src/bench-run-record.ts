import type { OllamaEvidence } from "./ollama-instance.js";

export const RUN_RECORD_SCHEMA = "hola.run-record/0.1";

/** Model config served by web for a public model page; `id` is the Radar model id. */
export interface BenchSubject {
  type: "model";
  id: string;
  name: string;
  vendor?: string;
  quant: string;
  ollama: { tag: string; known_digests?: string[]; min_version?: string };
  sampling?: Record<string, number>;
  think?: boolean;
  suites?: string[];
}

export interface BenchHighlight {
  t: number;
  label: "first_token" | "task_done" | "error";
  task?: string;
}

export interface BenchArtifacts {
  recording: { file: string; scored_run: boolean } | null;
  cards: string[];
  highlights: BenchHighlight[];
  /** Directory of per-attempt agent transcripts; coding suite only. */
  transcripts?: string;
}

/** What `holaeval bench` writes. */
export interface HolaevalBenchOutput {
  suite: { id: string; version: string; sha256: string };
  test_agent: { executor: string; judge: string };
  model: string;
  capabilities: string[];
  request: Record<string, unknown>;
  warmup_load_ms: number | null;
  machine: Record<string, unknown>;
  /** What other programs used during the timed speed requests; absent from engines older than this field. */
  conditions?: Pick<BenchConditions, "others_cpu_busy_pct" | "others_gpu_busy_pct">;
  /** How model-written code was confined; coding suite only. */
  sandbox?: Record<string, unknown> | null;
  results: Array<Record<string, unknown>>;
  started_at: string;
  finished_at: string;
  wall_seconds: number;
}

export interface RunRecord {
  schema: typeof RUN_RECORD_SCHEMA;
  run_id: string;
  suite: { id: string; version: string; sha256: string };
  subject: {
    type: "model";
    id: string;
    name: string;
    vendor: string | null;
    version: string | null;
    quant: string;
    tag: string;
    digest_registered: boolean;
    capabilities: string[];
  };
  test_agent: { executor: string; judge: string; settings: Record<string, unknown> };
  runtime: {
    kind: "local";
    hardware: Record<string, unknown>;
    provider: OllamaEvidence["provider"];
    client: BenchClient;
    conditions: BenchConditions;
  };
  results: Array<Record<string, unknown>>;
  artifacts: BenchArtifacts;
  verification: null;
  provenance: null;
  submitter: null;
  signature: null;
  started_at: string;
  finished_at: string;
  wall_seconds: number;
}

/** The only field a desktop record and a `hola` CLI record of the same run differ in. */
export interface BenchClient {
  app: "holaOS" | "hola-cli";
  version: string;
}

/** What else the machine was doing; a busy machine measures slower. */
export interface BenchConditions {
  /** Whole-machine CPU busy in the second before the run; charts use this. */
  cpu_busy_pct: number | null;
  /** Median CPU (and NVIDIA GPU) share used by everything except Ollama across the timed speed requests. */
  others_cpu_busy_pct?: number | null;
  others_gpu_busy_pct?: number | null;
}

export class BenchSubjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchSubjectError";
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseBenchSubject(raw: unknown): BenchSubject {
  const value = (raw ?? {}) as Record<string, unknown>;
  const ollama = (value.ollama ?? {}) as Record<string, unknown>;
  if (value.type !== "model") {
    throw new BenchSubjectError("subject.type must be \"model\"");
  }
  for (const [key, field] of [["id", value.id], ["name", value.name], ["quant", value.quant], ["ollama.tag", ollama.tag]] as const) {
    if (!nonEmptyString(field)) {
      throw new BenchSubjectError(`subject.${key} is required`);
    }
  }
  return value as unknown as BenchSubject;
}

/** The higher of the suite's floor and the model's own floor; null when neither sets one. */
export function minOllamaVersion(
  suiteFloor: string | undefined,
  subject: BenchSubject,
  compare: (a: string, b: string) => number,
): string | null {
  const floors = [suiteFloor, subject.ollama.min_version].filter(nonEmptyString);
  return floors.reduce<string | null>((max, floor) => (max === null || compare(floor, max) > 0 ? floor : max), null);
}

/** Client-side fields only: verification, provenance, submitter and signature are filled by HolaHub on submit. */
export function buildRunRecord(params: {
  runId: string;
  bench: HolaevalBenchOutput;
  subject: BenchSubject;
  digest: string | null;
  evidence: OllamaEvidence;
  client: BenchClient;
  artifacts: BenchArtifacts;
  conditions: BenchConditions;
}): RunRecord {
  const { bench, subject, digest } = params;
  return {
    schema: RUN_RECORD_SCHEMA,
    run_id: params.runId,
    suite: bench.suite,
    subject: {
      type: "model",
      id: subject.id,
      name: subject.name,
      vendor: subject.vendor ?? null,
      version: digest,
      quant: subject.quant,
      tag: subject.ollama.tag,
      digest_registered: digest !== null && (subject.ollama.known_digests ?? []).includes(digest),
      capabilities: bench.capabilities,
    },
    test_agent: {
      ...bench.test_agent,
      settings: { ...bench.request, warmup_load_ms: bench.warmup_load_ms, ...(bench.sandbox ? { sandbox: bench.sandbox } : {}) },
    },
    runtime: {
      kind: params.evidence.kind,
      hardware: bench.machine,
      provider: params.evidence.provider,
      client: params.client,
      conditions: { ...params.conditions, ...bench.conditions },
    },
    results: bench.results,
    artifacts: params.artifacts,
    verification: null,
    provenance: null,
    submitter: null,
    signature: null,
    started_at: bench.started_at,
    finished_at: bench.finished_at,
    wall_seconds: bench.wall_seconds,
  };
}
