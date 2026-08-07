import { randomUUID } from "node:crypto";

import { CronExpressionParser } from "cron-parser";
import {
  type CronjobRecord,
  type RuntimeStateStore,
  type WorkspaceRecord,
  utcNowIso,
} from "@holaboss/runtime-state-store";

/**
 * Native cronjob runtime. A cronjob is a scheduled prompt: on its `cron`
 * the scheduler starts a fresh main session that runs `instruction` and
 * lets the standard queue worker execute it. Replaces the previous model
 * where cronjobs were projected onto workflows.
 */

/** Harness id a cronjob-spawned session runs under: the cronjob's own
 *  `metadata.harness` (set when the automation was created) if present, else
 *  the workspace default. Mirrors how `metadata.model` is carried. */
function resolveCronjobHarness(
  workspace: WorkspaceRecord,
  cronjob: CronjobRecord,
): string {
  const pinned =
    typeof cronjob.metadata.harness === "string"
      ? cronjob.metadata.harness.trim()
      : "";
  if (pinned) return pinned;
  const harness = (workspace.harness ?? process.env.SANDBOX_AGENT_HARNESS ?? "pi").trim();
  return harness || "pi";
}

/** Resolve the IANA timezone a cron expression is interpreted in: the
 *  cronjob's pinned `metadata.timezone` if valid, else the process tz. */
export function resolveCronTimezone(
  metadata: Record<string, unknown> | null | undefined,
): string | undefined {
  const pinned =
    metadata && typeof metadata.timezone === "string" ? metadata.timezone.trim() : "";
  if (pinned) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: pinned });
      return pinned;
    } catch {
      // fall through to process tz
    }
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** Next fire time for a cron expression, or null when it can't be parsed. */
export function computeNextCronRun(
  cron: string,
  fromIso: string,
  timezone: string | undefined,
): string | null {
  try {
    const interval = CronExpressionParser.parse(cron, {
      currentDate: new Date(fromIso),
      tz: timezone,
    });
    return interval.next().toDate().toISOString();
  } catch {
    return null;
  }
}

export interface FireCronjobResult {
  sessionId: string;
  inputId: string;
}

/** The fired session's first turn. The instruction alone often *reads* like a
 *  scheduling request ("Every Monday at 9:00, …") and the session's agent has
 *  the scheduling tools — so state that the schedule already fired and the
 *  task is to be executed now. */
function buildRunTurnText(cronjob: CronjobRecord): string {
  const task = cronjob.instruction.trim() || cronjob.description.trim();
  const name = cronjob.name.trim() || "this automation";
  return [
    `Scheduled run of "${name}": its schedule already exists and has just fired. Do not create or modify any schedule — carry out the task below now, once.`,
    "",
    task,
  ].join("\n");
}

/**
 * Fire a cronjob now: start a fresh main session (tagged
 * `created_by="cronjob"` so the desktop groups it under "Scheduled") and
 * queue the cronjob's instruction as its first turn.
 */
export function fireCronjob(params: {
  store: RuntimeStateStore;
  workspace: WorkspaceRecord;
  cronjob: CronjobRecord;
  triggeredBy?: string | null;
}): FireCronjobResult {
  const { store, workspace, cronjob } = params;
  const sessionId = `scheduled-${randomUUID()}`;
  const boundProjectId =
    typeof cronjob.metadata.project_id === "string"
      ? cronjob.metadata.project_id.trim()
      : "";
  const projectId =
    boundProjectId &&
    store.getWorkspaceProject({
      workspaceId: workspace.id,
      projectId: boundProjectId,
    })
      ? boundProjectId
      : null;
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId,
    kind: "main_session",
    title: cronjob.name.trim() || cronjob.description.trim() || "Scheduled run",
    createdBy: "cronjob",
    projectId,
  });
  if (!store.getBinding({ workspaceId: workspace.id, sessionId })) {
    store.upsertBinding({
      workspaceId: workspace.id,
      sessionId,
      harness: resolveCronjobHarness(workspace, cronjob),
      harnessSessionId: sessionId,
    });
  }
  store.ensureRuntimeState({
    workspaceId: workspace.id,
    sessionId,
    status: "IDLE",
  });
  // The automation's pinned model lives in metadata.selected_model. The
  // transient request-time `metadata.model` is intentionally stripped on write
  // (see runtime-agent-tools cronjobPayload / metadataWithCronjobDefaults), so
  // read the persisted key here. Null => follow the workspace default.
  const pinnedModel = cronjob.metadata.selected_model;
  const model =
    typeof pinnedModel === "string" && pinnedModel.trim()
      ? pinnedModel.trim()
      : null;
  // The automation's pinned reasoning effort lives in metadata.thinking_value
  // (written by the desktop's automation dialogs, same key read back there).
  // Null => follow the model's own default effort.
  const pinnedThinking = cronjob.metadata.thinking_value;
  const thinkingValue =
    typeof pinnedThinking === "string" && pinnedThinking.trim()
      ? pinnedThinking.trim()
      : null;
  const input = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId,
    payload: {
      text: buildRunTurnText(cronjob),
      attachments: [],
      image_urls: [],
      model,
      thinking_value: thinkingValue,
      context: {
        cronjob_id: cronjob.id,
        triggered_by: params.triggeredBy?.trim() || "cron_worker",
      },
    },
  });
  store.updateCronjob({
    workspaceId: workspace.id,
    jobId: cronjob.id,
    metadata: { ...cronjob.metadata, last_session_id: sessionId },
  });
  return { sessionId, inputId: input.inputId };
}

/**
 * Fire every enabled cronjob in a workspace whose next_run_at has passed,
 * advancing each job's schedule. Returns the number fired.
 */
export function processDueCronjobs(params: {
  store: RuntimeStateStore;
  workspace: WorkspaceRecord;
  now?: string;
  logger?: { error?: (message: string, meta?: Record<string, unknown>) => void };
}): number {
  const now = params.now ?? utcNowIso();
  const due = params.store
    .listCronjobs({ workspaceId: params.workspace.id, enabledOnly: true })
    .filter((job) => job.nextRunAt != null && job.nextRunAt <= now);
  let fired = 0;
  for (const cronjob of due) {
    const nextRunAt = computeNextCronRun(
      cronjob.cron,
      now,
      resolveCronTimezone(cronjob.metadata),
    );
    try {
      fireCronjob({
        store: params.store,
        workspace: params.workspace,
        cronjob,
        triggeredBy: "cron_worker",
      });
      params.store.updateCronjob({
        workspaceId: params.workspace.id,
        jobId: cronjob.id,
        lastRunAt: now,
        nextRunAt,
        runCount: cronjob.runCount + 1,
        lastStatus: "fired",
        lastError: null,
      });
      fired += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      params.store.updateCronjob({
        workspaceId: params.workspace.id,
        jobId: cronjob.id,
        lastRunAt: now,
        nextRunAt,
        runCount: cronjob.runCount + 1,
        lastStatus: "error",
        lastError: message,
      });
      params.logger?.error?.("cronjob fire failed", {
        cronjob_id: cronjob.id,
        workspace_id: params.workspace.id,
        error: message,
      });
    }
  }
  return fired;
}
