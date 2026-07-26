/**
 * Wall-clock ceiling for scheduled/automation runs.
 *
 * A cronjob-fired run is a long, legitimately-progressing browser/tool routine.
 * The default 30-min main-session cap fires both the runner's hard deadline and
 * pi's own abort timer mid-run (surfacing as "Request was aborted"). These runs
 * get the same 2h ceiling subagents already have; the harness timeout flows to
 * `payload.harness_timeout_seconds` (the runner slides its hard deadline to
 * run_started + this) and to pi's `request.timeout_seconds`. The 15-min idle
 * watchdog is unchanged, so a genuinely hung run is still stopped.
 */
export const SCHEDULED_RUN_TIMEOUT_SECONDS = 7200; // 2h

/**
 * Raise the harness timeout for a scheduled/automation run (session created by
 * a cronjob) to the scheduled ceiling, keeping any already-longer base value.
 * Non-scheduled runs keep the harness-computed timeout unchanged.
 */
export function resolveHarnessTimeoutSecondsForRun(params: {
  baseTimeoutSeconds: number | null;
  createdBy: string | null | undefined;
}): number | null {
  const isScheduled =
    (params.createdBy ?? "").trim().toLowerCase() === "cronjob";
  if (!isScheduled) {
    return params.baseTimeoutSeconds;
  }
  return Math.max(params.baseTimeoutSeconds ?? 0, SCHEDULED_RUN_TIMEOUT_SECONDS);
}

/**
 * The timeout ts-runner bakes into the live harness request (which becomes pi's
 * own `request.timeout_seconds` abort timer). The harness plugin computes a
 * per-session-kind default (1800 for main sessions, 7200 for subagents), but a
 * scheduled run's raised ceiling is carried on the request as
 * `harness_timeout_seconds` (resolveHarnessTimeoutSecondsForRun, threaded from
 * claimed-input-executor). Honor whichever is larger so a cronjob main-session
 * run isn't self-aborted at 30 min while the runner's hard deadline waits 2h.
 * A missing/zero override falls back to the plugin default (direct/legacy
 * callers that never set it).
 */
export function effectiveHarnessRunTimeoutSeconds(params: {
  pluginTimeoutSeconds: number;
  requestOverrideSeconds: number | null | undefined;
}): number {
  const override = params.requestOverrideSeconds ?? 0;
  return Math.max(params.pluginTimeoutSeconds, override > 0 ? override : 0);
}
