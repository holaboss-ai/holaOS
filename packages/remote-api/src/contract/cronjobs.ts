import { oc } from "@orpc/contract";
import { z } from "zod";
import { workspaceScoped } from "./shared";

const deliverySchema = z.object({
  mode: z.string(),
  channel: z.string(),
  to: z.string().nullable(),
});

// On-the-wire cronjob record (snake_case, matching the runtime payload). The
// global desktop type carries workflow_id (the runtime backs cronjobs with
// workflows); catchall preserves any further runtime-added fields.
export const cronjobRecordSchema = z
  .object({
    id: z.string(),
    workflow_id: z.string(),
    workspace_id: z.string(),
    initiated_by: z.string(),
    name: z.string(),
    cron: z.string(),
    description: z.string(),
    instruction: z.string(),
    enabled: z.boolean(),
    delivery: deliverySchema,
    metadata: z.record(z.string(), z.unknown()),
    last_run_at: z.string().nullable(),
    next_run_at: z.string().nullable(),
    run_count: z.number(),
    last_status: z.string().nullable(),
    last_error: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .catchall(z.unknown());

const listInputSchema = workspaceScoped.extend({
  enabledOnly: z.boolean().optional(),
});

const listOutputSchema = z.object({
  jobs: z.array(cronjobRecordSchema),
  count: z.number().int(),
});

const runInputSchema = workspaceScoped.extend({
  jobId: z.string().min(1),
  model: z.string().nullish(),
  createdBy: z.string().nullish(),
  ownerMainSessionId: z.string().nullish(),
});

// The run response carries workflow_id / workflow_run_id alongside the cronjob;
// catchall keeps them without modelling the workflow domain here.
const runOutputSchema = z
  .object({
    success: z.boolean(),
    cronjob: cronjobRecordSchema,
    session_id: z.string().nullable(),
    notification_id: z.string().nullable(),
  })
  .catchall(z.unknown());

const createInputSchema = workspaceScoped.extend({
  initiatedBy: z.string().min(1),
  sessionId: z.string().nullish(),
  name: z.string().nullish(),
  cron: z.string().min(1),
  description: z.string().min(1),
  instruction: z.string().nullish(),
  enabled: z.boolean().optional(),
  delivery: deliverySchema,
  model: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const updateInputSchema = workspaceScoped.extend({
  jobId: z.string().min(1),
  session_id: z.string().nullish(),
  name: z.string().nullish(),
  cron: z.string().nullish(),
  description: z.string().nullish(),
  instruction: z.string().nullish(),
  enabled: z.boolean().optional(),
  delivery: deliverySchema.optional(),
  model: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const deleteInputSchema = workspaceScoped.extend({
  jobId: z.string().min(1),
});

const deleteOutputSchema = z.object({ success: z.boolean() });

export const cronjobsContract = {
  list: oc.input(listInputSchema).output(listOutputSchema),
  runNow: oc
    .input(runInputSchema)
    .errors({ NOT_FOUND: { message: "cronjob not found" } })
    .output(runOutputSchema),
  create: oc.input(createInputSchema).output(cronjobRecordSchema),
  update: oc
    .input(updateInputSchema)
    .errors({ NOT_FOUND: { message: "cronjob not found" } })
    .output(cronjobRecordSchema),
  delete: oc
    .input(deleteInputSchema)
    .errors({ NOT_FOUND: { message: "cronjob not found" } })
    .output(deleteOutputSchema),
};

export type CronjobRecord = z.infer<typeof cronjobRecordSchema>;
