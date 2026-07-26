import { z } from "zod";

/**
 * workspace-removal Piece 3: the addressing key is gone. The runtime is
 * single-tenant and resolves the one workspace server-side, so procedure inputs
 * no longer carry `workspaceId`. Kept as an (empty) base that every domain still
 * `.extend()`s, so the per-domain input schemas don't all need rewriting; this
 * can be inlined away once the contract is reorganized.
 */
export const workspaceScoped = z.object({});

/**
 * The on-the-wire workspace record. Mirrors the snake_case payload produced by
 * the runtime's `workspaceRecordPayload`. `catchall` keeps runtime-added fields
 * (e.g. `implementation_activity`, `alignment_question`) instead of stripping
 * them during oRPC output validation.
 */
export const workspaceRecordSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    harness: z.string().nullable(),
    error_message: z.string().nullable(),
    onboarding_status: z.string(),
    onboarding_state: z.string().nullish(),
    onboarding_session_id: z.string().nullable(),
    alignment_question: z.record(z.string(), z.unknown()).nullish(),
    alignment_report: z.record(z.string(), z.unknown()).nullish(),
    verification_report: z.record(z.string(), z.unknown()).nullish(),
    onboarding_completed_at: z.string().nullable(),
    onboarding_completion_summary: z.string().nullable(),
    onboarding_requested_at: z.string().nullable(),
    onboarding_requested_by: z.string().nullable(),
    created_at: z.string().nullable(),
    updated_at: z.string().nullable(),
    deleted_at_utc: z.string().nullable(),
    icon: z.string().nullish(),
    icon_color: z.string().nullish(),
    workspace_path: z.string().nullish(),
    folder_state: z.enum(["healthy", "missing"]).nullish(),
    workspace_role: z.string().nullish(),
    source_workspace_id: z.string().nullish(),
    lab_purpose: z.string().nullish(),
    lab_status: z.string().nullish(),
  })
  .catchall(z.unknown());

export type WorkspaceRecord = z.infer<typeof workspaceRecordSchema>;
