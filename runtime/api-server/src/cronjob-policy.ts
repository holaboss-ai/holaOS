import {
  type CronjobRecord,
  type WorkspaceRecord,
} from "@holaboss/runtime-state-store";

export const LAB_CRONJOB_EXECUTION_DISABLED_METADATA_KEY = "lab_execution_disabled";
export const CRONJOB_AUTHOR_RECOMMENDED_ENABLED_METADATA_KEY = "author_recommended_enabled";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isDraftLabWorkspace(
  workspace: WorkspaceRecord | null | undefined,
): boolean {
  return workspace?.workspaceRole === "draft_lab";
}

export function cronjobAuthorRecommendedEnabledFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  fallbackEnabled: boolean,
): boolean {
  const preserved = isRecord(metadata)
    ? metadata[CRONJOB_AUTHOR_RECOMMENDED_ENABLED_METADATA_KEY]
    : undefined;
  return typeof preserved === "boolean" ? preserved : fallbackEnabled;
}

export function cronjobAuthorRecommendedEnabled(
  job: Pick<CronjobRecord, "enabled" | "metadata">,
): boolean {
  return cronjobAuthorRecommendedEnabledFromMetadata(job.metadata, job.enabled);
}

export function disableCronjobAutonomyForLab(params: {
  metadata?: Record<string, unknown> | null;
  recommendedEnabled: boolean;
}): {
  enabled: false;
  metadata: Record<string, unknown>;
  nextRunAt: null;
} {
  const metadata = {
    ...(isRecord(params.metadata) ? params.metadata : {}),
    [LAB_CRONJOB_EXECUTION_DISABLED_METADATA_KEY]: true,
    [CRONJOB_AUTHOR_RECOMMENDED_ENABLED_METADATA_KEY]: params.recommendedEnabled,
  };
  return {
    enabled: false,
    metadata,
    nextRunAt: null,
  };
}

export function stripLabCronjobExecutionDisabledMetadata(
  metadata?: Record<string, unknown> | null,
): Record<string, unknown> {
  const next = {
    ...(isRecord(metadata) ? metadata : {}),
  };
  delete next[LAB_CRONJOB_EXECUTION_DISABLED_METADATA_KEY];
  return next;
}
