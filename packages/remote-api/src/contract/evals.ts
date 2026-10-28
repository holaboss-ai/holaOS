import { oc } from "@orpc/contract";
import { z } from "zod";
import { workspaceScoped } from "./shared";

export const EVAL_RUN_KINDS = ["speed", "capability", "agent"] as const;
export const EVAL_AGENT_CONDITIONS = ["full", "lean"] as const;
export const EVAL_QUESTION_TYPES = ["single_model", "comparison", "hardware"] as const;

export const evalTargetSchema = z.object({
  provider_id: z.string().nullish(),
  model_id: z.string().min(1),
  base_url: z.string().min(1),
  engine: z.string().nullish(),
});

export const evalSamplingSchema = z.object({
  temperature: z.number().min(0).max(2).nullish(),
  top_p: z.number().min(0).max(1).nullish(),
  min_p: z.number().min(0).max(1).nullish(),
});

export const evalPlanRunSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "use lowercase letters, digits and dashes (max 40)"),
  label: z.string().min(1).max(80),
  target: evalTargetSchema,
  kinds: z.array(z.enum(EVAL_RUN_KINDS)).min(1),
  sampling: evalSamplingSchema.nullish(),
  samples: z.number().int().min(1).max(10).nullish(),
  agent_conditions: z.array(z.enum(EVAL_AGENT_CONDITIONS)).nullish(),
  notes: z.string().max(500).nullish(),
});

export const evalPlanSchema = z.object({
  runs: z.array(evalPlanRunSchema).min(1).max(12),
  estimate_minutes: z.number().min(0).nullish(),
  notes: z.string().max(2000).nullish(),
});

export const evaluationSchema = z
  .object({
    eval_id: z.string(),
    title: z.string(),
    question_type: z.string(),
    question: z.string(),
    status: z.string(),
    plan: evalPlanSchema.nullable(),
    brain_model: z.string().nullable(),
    session_id: z.string().nullable(),
    opinion_md: z.string(),
    opinion_updated_at: z.string().nullable(),
    distribution: z.record(z.string(), z.unknown()).nullable(),
    report_url: z.string().nullable(),
    include_raw_data: z.boolean(),
    parent_eval_id: z.string().nullable(),
    relation: z.string().nullable(),
    source: z.record(z.string(), z.unknown()).nullable(),
    published_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .catchall(z.unknown());

export const evaluationRunSchema = z.object({
  run_id: z.string(),
  eval_id: z.string(),
  run_key: z.string(),
  kind: z.string(),
  label: z.string(),
  spec: z.record(z.string(), z.unknown()),
  status: z.string(),
  progress: z.record(z.string(), z.unknown()).nullable(),
  summary: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  proposal_id: z.string().nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const evaluationProposalSchema = z.object({
  proposal_id: z.string(),
  eval_id: z.string(),
  title: z.string(),
  rationale: z.string(),
  evidence: z.array(z.unknown()),
  runs: z.array(z.unknown()),
  estimate_minutes: z.number().nullable(),
  status: z.string(),
  created_by: z.string(),
  decided_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const evaluationRevisionSchema = z.object({
  revision_id: z.string(),
  opinion_md: z.string(),
  author: z.string(),
  created_at: z.string(),
});

const evaluationSummarySchema = evaluationSchema.extend({
  run_counts: z.object({
    total: z.number().int(),
    queued: z.number().int(),
    running: z.number().int(),
    done: z.number().int(),
    failed: z.number().int(),
  }),
  targets: z.array(z.string()),
  pending_proposals: z.number().int(),
});

const evalIdInput = workspaceScoped.extend({ evalId: z.string().min(1) });

const evaluationDetailSchema = z.object({
  evaluation: evaluationSchema,
  runs: z.array(evaluationRunSchema),
  proposals: z.array(evaluationProposalSchema),
  revisions: z.array(evaluationRevisionSchema),
  newer_version_id: z.string().nullable(),
});

export const evalTargetOptionSchema = z.object({
  provider_id: z.string(),
  model_id: z.string(),
  base_url: z.string(),
  engine: z.string(),
  context_window: z.number().nullable(),
  token: z.string(),
});

const placeholderSchema = z.object({
  key: z.string(),
  value: z.union([z.number(), z.string()]),
  label: z.string(),
});

const chartSchema = z.object({
  id: z.string(),
  title: z.string(),
  svg: z.string(),
});

export const evalReportSchema = z.object({
  data_layer: z.record(z.string(), z.unknown()),
  markdown: z.string(),
  opinion_rendered_md: z.string(),
  placeholders: z.array(placeholderSchema),
  unresolved_placeholders: z.array(z.string()),
  unverified_numbers: z.array(z.string()),
  charts: z.array(chartSchema),
  frozen: z.boolean(),
});

const exportOutputSchema = z.object({
  dir: z.string(),
  files: z.array(z.string()),
});

const shareFileSchema = z.object({
  file_name: z.string(),
  content_type: z.string(),
  data_base64: z.string(),
});

const shareDraftSchema = z.object({
  title: z.string(),
  body: z.string(),
  images: z.array(shareFileSchema).max(4),
  files: z.array(shareFileSchema).max(4),
  dir: z.string(),
});

const distributionSchema = z.record(z.string(), z.unknown());

export const evalsContract = {
  list: oc
    .input(workspaceScoped.extend({ limit: z.number().int().min(1).max(500).optional() }))
    .output(z.object({ evaluations: z.array(evaluationSummarySchema) })),
  get: oc
    .input(evalIdInput)
    .errors({ NOT_FOUND: { message: "evaluation not found" } })
    .output(evaluationDetailSchema),
  targets: oc
    .input(workspaceScoped)
    .output(z.object({ targets: z.array(evalTargetOptionSchema) })),
  create: oc
    .input(
      workspaceScoped.extend({
        title: z.string().max(160).nullish(),
        questionType: z.enum(EVAL_QUESTION_TYPES),
        question: z.string().min(1).max(2000),
        brainModel: z.string().nullish(),
        targets: z.array(evalTargetSchema).max(8).optional(),
      }),
    )
    .output(evaluationSchema.extend({ kickoff_error: z.string().nullable() })),
  update: oc
    .input(
      evalIdInput.extend({
        title: z.string().min(1).max(160).optional(),
        brainModel: z.string().nullish(),
        includeRawData: z.boolean().optional(),
      }),
    )
    .errors({ NOT_FOUND: { message: "evaluation not found" } })
    .output(evaluationSchema),
  setPlan: oc
    .input(evalIdInput.extend({ plan: evalPlanSchema }))
    .errors({
      NOT_FOUND: { message: "evaluation not found" },
      INVALID_STATE: { message: "the plan can no longer change" },
      INVALID_PLAN: { message: "the plan is not valid" },
    })
    .output(evaluationSchema),
  start: oc
    .input(evalIdInput)
    .errors({
      NOT_FOUND: { message: "evaluation not found" },
      INVALID_STATE: { message: "the evaluation cannot start" },
      INVALID_PLAN: { message: "the plan is not valid" },
    })
    .output(evaluationDetailSchema),
  cancel: oc
    .input(evalIdInput)
    .errors({ NOT_FOUND: { message: "evaluation not found" } })
    .output(evaluationDetailSchema),
  retryRun: oc
    .input(evalIdInput.extend({ runId: z.string().min(1) }))
    .errors({
      NOT_FOUND: { message: "run not found" },
      INVALID_STATE: { message: "only failed or cancelled runs can be retried" },
    })
    .output(evaluationDetailSchema),
  decideProposal: oc
    .input(
      evalIdInput.extend({
        proposalId: z.string().min(1),
        decision: z.enum(["approve", "reject"]),
      }),
    )
    .errors({
      NOT_FOUND: { message: "proposal not found" },
      INVALID_STATE: { message: "the proposal was already decided" },
    })
    .output(evaluationDetailSchema),
  saveOpinion: oc
    .input(evalIdInput.extend({ opinionMd: z.string().max(60_000) }))
    .errors({ NOT_FOUND: { message: "evaluation not found" } })
    .output(evaluationSchema),
  report: oc
    .input(evalIdInput)
    .errors({ NOT_FOUND: { message: "evaluation not found" } })
    .output(evalReportSchema),
  exportReport: oc
    .input(evalIdInput)
    .errors({
      NOT_FOUND: { message: "evaluation not found" },
      INVALID_STATE: { message: "nothing has finished running yet" },
    })
    .output(exportOutputSchema),
  publish: oc
    .input(evalIdInput)
    .errors({
      NOT_FOUND: { message: "evaluation not found" },
      INVALID_STATE: { message: "the evaluation is not ready to publish" },
    })
    .output(shareDraftSchema.extend({ evaluation: evaluationSchema })),
  setReportUrl: oc
    .input(evalIdInput.extend({ url: z.string().url().nullable() }))
    .errors({ NOT_FOUND: { message: "evaluation not found" } })
    .output(evaluationSchema),
  saveDistribution: oc
    .input(evalIdInput.extend({ distribution: distributionSchema }))
    .errors({ NOT_FOUND: { message: "evaluation not found" } })
    .output(evaluationSchema),
  createVersion: oc
    .input(evalIdInput)
    .errors({ NOT_FOUND: { message: "evaluation not found" } })
    .output(evaluationSchema),
  importReproduction: oc
    .input(
      workspaceScoped.extend({
        reportHtml: z.string().min(1).max(20_000_000),
        target: evalTargetSchema.nullish(),
        sourceUrl: z.string().url().nullish(),
      }),
    )
    .errors({ INVALID_REPORT: { message: "this file is not a holaOS evaluation report" } })
    .output(evaluationSchema),
  delete: oc
    .input(evalIdInput)
    .errors({
      NOT_FOUND: { message: "evaluation not found" },
      INVALID_STATE: { message: "stop the running evaluation first" },
    })
    .output(z.object({ success: z.boolean() })),
};

export type Evaluation = z.infer<typeof evaluationSchema>;
export type EvaluationRun = z.infer<typeof evaluationRunSchema>;
export type EvaluationProposal = z.infer<typeof evaluationProposalSchema>;
export type EvalPlan = z.infer<typeof evalPlanSchema>;
export type EvalPlanRun = z.infer<typeof evalPlanRunSchema>;
export type EvalTarget = z.infer<typeof evalTargetSchema>;
export type EvalTargetOption = z.infer<typeof evalTargetOptionSchema>;
export type EvalReport = z.infer<typeof evalReportSchema>;
