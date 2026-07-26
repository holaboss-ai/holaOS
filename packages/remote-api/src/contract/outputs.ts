import { oc } from "@orpc/contract";
import { z } from "zod";
import { workspaceScoped } from "./shared";

// The on-the-wire output record (snake_case, matching the runtime's
// outputPayload). catchall keeps any runtime-added fields.
export const outputRecordSchema = z
  .object({
    id: z.string(),
    workspace_id: z.string(),
    output_type: z.string(),
    title: z.string(),
    status: z.string(),
    module_id: z.string().nullable(),
    module_resource_id: z.string().nullable(),
    file_path: z.string().nullable(),
    html_content: z.string().nullable(),
    session_id: z.string().nullable(),
    project_id: z.string().nullable(),
    input_id: z.string().nullable(),
    artifact_id: z.string().nullable(),
    folder_id: z.string().nullable(),
    platform: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .catchall(z.unknown());

export const outputsListInput = workspaceScoped.extend({
  outputType: z.string().nullish(),
  status: z.string().nullish(),
  platform: z.string().nullish(),
  folderId: z.string().nullish(),
  sessionId: z.string().nullish(),
  inputId: z.string().nullish(),
  // "general" → only General outputs; "<projectId>" → that project; omitted → all.
  projectScope: z.string().nullish(),
  limit: z.number().int().min(1).optional(),
  offset: z.number().int().min(0).optional(),
});

const listOutputSchema = z.object({
  items: z.array(outputRecordSchema),
});

export const outputsContract = {
  list: oc.input(outputsListInput).output(listOutputSchema),
};

export type OutputRecord = z.infer<typeof outputRecordSchema>;
