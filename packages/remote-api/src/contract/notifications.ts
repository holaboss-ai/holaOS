import { oc } from "@orpc/contract";
import { z } from "zod";
import { workspaceScoped } from "./shared";

// On-the-wire notification record (snake_case, matching runtimeNotificationPayload).
// level/priority/state are the runtime's closed enums (the store only ever emits
// these); catchall preserves any runtime-added fields.
export const notificationRecordSchema = z
  .object({
    id: z.string(),
    workspace_id: z.string(),
    cronjob_id: z.string().nullable(),
    workflow_id: z.string().nullable(),
    workflow_run_id: z.string().nullable(),
    workflow_trigger_kind: z.string().nullable(),
    source_type: z.string(),
    source_label: z.string().nullable(),
    title: z.string(),
    message: z.string(),
    level: z.enum(["info", "success", "warning", "error"]),
    priority: z.enum(["low", "normal", "high", "critical"]),
    state: z.enum(["unread", "read", "dismissed"]),
    metadata: z.record(z.string(), z.unknown()),
    read_at: z.string().nullable(),
    dismissed_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .catchall(z.unknown());

const listInputSchema = z.object({
  // Omitted/null → notifications across all workspaces.
  workspaceId: z.string().nullish(),
  includeDismissed: z.boolean().optional(),
  includeCronjobSource: z.boolean().optional(),
  sourceType: z.string().nullish(),
  limit: z.number().int().min(1).optional(),
});

const listOutputSchema = z.object({
  items: z.array(notificationRecordSchema),
  count: z.number().int(),
});

const updateInputSchema = workspaceScoped.extend({
  notificationId: z.string().min(1),
  state: z.enum(["unread", "read", "dismissed"]).optional(),
});

export const notificationsContract = {
  list: oc.input(listInputSchema).output(listOutputSchema),
  update: oc
    .input(updateInputSchema)
    .errors({ NOT_FOUND: { message: "notification not found" } })
    .output(notificationRecordSchema),
};

export type NotificationRecord = z.infer<typeof notificationRecordSchema>;
