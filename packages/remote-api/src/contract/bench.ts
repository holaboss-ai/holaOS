import { oc } from "@orpc/contract";
import { z } from "zod";
import { workspaceScoped } from "./shared";

export const BENCH_RUN_STATUSES = ["running", "done", "failed", "cancelled"] as const;
export const BENCH_RUN_PHASES = ["preflight", "starting", "pulling", "running", "finishing"] as const;

/** Model config served by web for a public model page; `id` is the Radar model id. */
export const benchSubjectSchema = z.object({
  type: z.literal("model"),
  id: z.string().min(1),
  name: z.string().min(1),
  vendor: z.string().optional(),
  quant: z.string().min(1),
  ollama: z.object({
    tag: z.string().min(1),
    known_digests: z.array(z.string()).optional(),
    min_version: z.string().optional(),
  }),
  sampling: z.record(z.string(), z.number()).optional(),
  think: z.boolean().optional(),
  suites: z.array(z.string()).optional(),
});

/** Run-level failures such as ollama_missing or user_models_loaded arrive here, not as thrown errors. */
const benchRunErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const benchRunSchema = z.object({
  run_id: z.string(),
  status: z.enum(BENCH_RUN_STATUSES),
  phase: z.enum(BENCH_RUN_PHASES),
  suite: z.string(),
  subject: benchSubjectSchema,
  error: benchRunErrorSchema.nullable(),
  run_dir: z.string(),
  record_path: z.string().nullable(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
});

export const benchEventSchema = z
  .object({ seq: z.number().int(), at: z.number(), type: z.string() })
  .catchall(z.unknown());

const runIdInput = workspaceScoped.extend({ run_id: z.string().min(1) });

export const benchRunSummarySchema = z.object({
  run_id: z.string(),
  run_dir: z.string(),
  suite: z.string(),
  subject_id: z.string(),
  subject_name: z.string(),
  quant: z.string(),
  started_at: z.string(),
  decode_tps: z.number().nullable(),
  hardware: z.object({
    cpu: z.string().optional(),
    memory_gb: z.number().optional(),
    gpus: z.array(z.string()).optional(),
  }),
  cpu_busy_pct: z.number().nullable(),
  others_cpu_busy_pct: z.number().nullable().optional(),
});

export const benchContract = {
  start: oc
    .input(
      workspaceScoped.extend({
        subject: benchSubjectSchema,
        suite: z.string().min(1),
        unload_user_models: z.boolean().optional(),
      }),
    )
    .errors({
      BUSY: { message: "another benchmark or evaluation is running" },
      INVALID_SUBJECT: { message: "the model config is not valid" },
      UNKNOWN_SUITE: { message: "unknown suite" },
    })
    .output(benchRunSchema),
  /** Poll with the last seen `seq` as `after` to receive only new events. */
  get: oc
    .input(runIdInput.extend({ after: z.number().int().min(0).optional() }))
    .errors({ NOT_FOUND: { message: "benchmark run not found" } })
    .output(z.object({ run: benchRunSchema, events: z.array(benchEventSchema) })),
  /** The run in progress, whoever started it; the desktop records the screen while one exists. */
  current: oc.input(workspaceScoped).output(z.object({ run: benchRunSchema.nullable() })),
  cancel: oc
    .input(runIdInput)
    .errors({ NOT_FOUND: { message: "benchmark run not found" } })
    .output(benchRunSchema),
  record: oc
    .input(runIdInput)
    .errors({
      NOT_FOUND: { message: "benchmark run not found" },
      NOT_READY: { message: "the run has not produced a Run Record" },
    })
    .output(z.object({ record: z.record(z.string(), z.unknown()) })),
  /** Finished runs on disk, newest first; they outlive runtime restarts. */
  list: oc
    .input(workspaceScoped.extend({ subject_id: z.string().optional() }))
    .output(z.object({ runs: z.array(benchRunSummarySchema) })),
  /** Attach the desktop's recording and cards; files are names inside the run directory. */
  setArtifacts: oc
    .input(
      runIdInput.extend({
        recording: z.object({ file: z.string().min(1), scored_run: z.boolean() }).nullable(),
        cards: z.array(z.string().min(1)).max(8),
        recording_offset_s: z.number().min(0).optional(),
      }),
    )
    .errors({
      NOT_FOUND: { message: "benchmark run not found" },
      NOT_READY: { message: "the run has not produced a Run Record" },
      INVALID_ARTIFACTS: { message: "an artifact is not in the run directory" },
    })
    .output(z.object({ record: z.record(z.string(), z.unknown()) })),
};

export type BenchSubject = z.infer<typeof benchSubjectSchema>;
export type BenchRun = z.infer<typeof benchRunSchema>;
export type BenchEvent = z.infer<typeof benchEventSchema>;
export type BenchRunSummary = z.infer<typeof benchRunSummarySchema>;
