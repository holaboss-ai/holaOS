import { HarnessAvatar } from "@/components/harness/HarnessAvatar";
import {
  CODE_PLAN_HINT,
  harnessLoginHint,
  isBetaHarness,
  usesExternalCodePlan,
} from "@/components/harness/harnessMeta";
import {
  type HarnessReadinessRecord,
  sortHarnessesByStatus,
  useHarnessReadiness,
  useHarnessTesting,
} from "@/components/harness/harnessReadiness";
import { useAvailableHarnesses } from "@/components/harness/useAvailableHarnesses";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertTriangle,
  Check,
  Download,
  Loader2,
  MoreHorizontal,
  RotateCcw,
} from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";

/** Official install pages for CLI harnesses, opened in the default browser
 *  from the "not installed" hint. Only listed ids get the link. */
const HARNESS_INSTALL_URLS: Record<string, string> = {
  "claude-code": "https://claude.com/claude-code",
  codex: "https://developers.openai.com/codex/cli",
};

/**
 * Env-var prefix the runtime reads to override a harness's binary / model /
 * args (HOLABOSS_<PREFIX>_PATH / _MODEL / _ARGS). Mostly the uppercased id,
 * but `claude-code` historically uses the shorter `CLAUDE` prefix.
 */
const HARNESS_ENV_PREFIX: Record<string, string> = {
  "claude-code": "CLAUDE",
  codex: "CODEX",
};

/**
 * Agents settings — a scannable roster. One quiet row per agent (icon · name ·
 * status), with a single action only when one is actually needed and everything
 * secondary tucked behind a ⋯ menu. Hola (pi) is built in and always ready;
 * every other agent is a local CLI the runtime detects on PATH.
 */
export function AgentsSettingsPanel() {
  const { selectedWorkspace } = useWorkspaceDesktop();
  const workspaceId = selectedWorkspace?.id?.trim() || null;
  const { harnesses, isLoading, error, refresh } =
    useAvailableHarnesses(workspaceId);
  const { get: getReadiness } = useHarnessReadiness();

  // Usable agents first (Built-in → Ready → Installed → Needs setup →
  // Unavailable), stable within a status — shared with the harness pickers.
  const visible = sortHarnessesByStatus(harnesses, getReadiness);
  const readyCount = visible.filter(
    (entry) =>
      entry.detection === "in-process" ||
      getReadiness(entry.id)?.status === "ready",
  ).length;

  if (!workspaceId) {
    return (
      <SettingsCard>
        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
          Open a workspace to manage its agents.
        </div>
      </SettingsCard>
    );
  }

  return (
    <div className="grid gap-2.5">
      <div className="flex items-center justify-between px-0.5">
        <span className="text-xs tabular-nums text-muted-foreground">
          {visible.length > 0
            ? `${visible.length} ${visible.length === 1 ? "agent" : "agents"}${
                readyCount ? ` · ${readyCount} ready` : ""
              }`
            : ""}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={isLoading}
          onClick={() => void refresh()}
        >
          {isLoading ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RotateCcw className="size-3" />
          )}
          Re-detect
        </Button>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-card px-4 py-3 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="wrap-break-word">{error}</span>
        </div>
      ) : isLoading && harnesses.length === 0 ? (
        <SettingsCard>
          <div className="flex items-center justify-center gap-2 px-4 py-8 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Detecting agents…
          </div>
        </SettingsCard>
      ) : visible.length === 0 ? (
        <SettingsCard>
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            No agents detected.
          </div>
        </SettingsCard>
      ) : (
        <SettingsCard>
          {visible.map((entry) => (
            <AgentRow
              key={entry.id}
              entry={entry}
              onTest={() =>
                window.electronAPI.workspace.testHarnessConnection(
                  workspaceId,
                  entry.id,
                )
              }
            />
          ))}
        </SettingsCard>
      )}
    </div>
  );
}

function AgentRow({
  entry,
  onTest,
}: {
  entry: HarnessAvailabilityEntryPayload;
  onTest: () => Promise<HarnessConnectionTestResultPayload>;
}) {
  const isBuiltIn = entry.detection === "in-process";
  const models = entry.supported_models ?? [];
  const envPrefix = HARNESS_ENV_PREFIX[entry.id] ?? null;
  const readiness = useHarnessReadiness();
  const readinessRecord = readiness.get(entry.id);
  // Only surface the sign-in nudge once a test has actually FAILED.
  const showLoginHint =
    entry.available && !isBuiltIn && readinessRecord?.status === "needs_setup";
  // Verified agents don't need a Test button; built-in is always ready.
  const canTest =
    entry.available && !isBuiltIn && readinessRecord?.status !== "ready";
  const hasDetails =
    !entry.available ||
    showLoginHint ||
    models.length > 0 ||
    Boolean(envPrefix) ||
    isBuiltIn;

  return (
    <div className="group flex items-center gap-3.5 px-4 py-3 transition-colors hover:bg-fg-2">
      <HarnessAvatar
        harnessId={entry.id}
        size="lg"
        className={cn("shrink-0", !entry.available && "opacity-45")}
      />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span
          className={cn(
            "truncate text-sm font-medium tracking-tight",
            entry.available ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {entry.display_name}
        </span>
        {isBetaHarness(entry.id) ? (
          <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-amber-600 dark:text-amber-500">
            Beta
          </span>
        ) : null}
        {usesExternalCodePlan(entry.id) ? (
          <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
            {CODE_PLAN_HINT}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <StatusDot
          available={entry.available}
          builtIn={isBuiltIn}
          readiness={readinessRecord}
        />
        {canTest ? (
          <TestConnectionButton
            harnessId={entry.id}
            record={readinessRecord}
            onTest={onTest}
            onResult={(ok, detail) =>
              readiness.record(entry.id, ok ? "ready" : "needs_setup", detail)
            }
          />
        ) : null}
        {hasDetails ? (
          <AgentDetailsMenu
            entry={entry}
            models={models}
            envPrefix={envPrefix}
            isBuiltIn={isBuiltIn}
            showLoginHint={showLoginHint}
            loginDetail={readinessRecord?.detail}
          />
        ) : null}
      </div>
    </div>
  );
}

/** Secondary detail (models, overrides, setup hints) — off the row, in a menu. */
function AgentDetailsMenu({
  entry,
  models,
  envPrefix,
  isBuiltIn,
  showLoginHint,
  loginDetail,
}: {
  entry: HarnessAvailabilityEntryPayload;
  models: HarnessSupportedModelPayload[];
  envPrefix: string | null;
  isBuiltIn: boolean;
  showLoginHint: boolean;
  loginDetail?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`${entry.display_name} details`}
            className="text-muted-foreground"
          />
        }
      >
        <MoreHorizontal className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-80 p-0">
        {entry.available ? null : (
          <div className="flex items-start gap-2 border-b border-border/60 bg-fg-2 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
            <Download className="mt-0.5 size-3.5 shrink-0 text-foreground/45" />
            <span className="wrap-break-word">
              Install the{" "}
              {HARNESS_INSTALL_URLS[entry.id] ? (
                <button
                  type="button"
                  title={HARNESS_INSTALL_URLS[entry.id]}
                  onClick={() =>
                    void window.electronAPI?.profiles.launch(
                      "bprofile_default",
                      HARNESS_INSTALL_URLS[entry.id] ?? "",
                    )
                  }
                  className="font-medium text-foreground underline underline-offset-2 transition-colors hover:text-primary"
                >
                  {entry.display_name} CLI
                </button>
              ) : (
                `${entry.display_name} CLI`
              )}
              , then re-detect.
            </span>
          </div>
        )}

        {showLoginHint ? (
          <div className="flex items-start gap-2 border-b border-border/60 px-3 py-2.5 text-xs leading-5 text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="wrap-break-word">
              {harnessLoginHint(entry.id, entry.display_name)}
              {loginDetail ? (
                <span className="mt-0.5 block text-amber-700/70 dark:text-amber-400/70">
                  Last check: {loginDetail}
                </span>
              ) : null}
            </span>
          </div>
        ) : null}

        {models.length > 0 ? (
          <div className="px-3 py-2.5">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Models
            </div>
            <div className="grid max-h-56 gap-0.5 overflow-y-auto">
              {models.map((model) => (
                <div
                  key={model.id}
                  className="flex h-6 items-center justify-between gap-3 text-xs"
                >
                  <span className="truncate text-foreground/85">
                    {model.label}
                  </span>
                  {model.default ? (
                    <span className="shrink-0 rounded-full border border-border bg-fg-2 px-1.5 py-px text-[10px] font-medium leading-4 text-muted-foreground">
                      default
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : isBuiltIn ? (
          <div className="px-3 py-2.5 text-xs text-muted-foreground">
            Uses the runtime's provider models.
          </div>
        ) : entry.available ? (
          <div className="px-3 py-2.5 text-xs text-muted-foreground">
            No models yet — sign in, then re-detect.
          </div>
        ) : null}

        {envPrefix ? (
          <div className="border-t border-border/60 px-3 py-2.5">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Overrides
            </div>
            <div className="flex flex-col items-start gap-1">
              {(["PATH", "MODEL", "ARGS"] as const).map((suffix) => (
                <code
                  key={suffix}
                  className="rounded bg-fg-4 px-1.5 py-0.5 font-mono text-[10px] leading-4 text-foreground/70"
                >
                  {`HOLABOSS_${envPrefix}_${suffix}`}
                </code>
              ))}
            </div>
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Per-agent connection test. Runs the harness end-to-end with a tiny prompt and
 * reports a transient pass/fail — "Verified" means it launched, authenticated,
 * and its model responded, not just that the binary is on PATH.
 */
function TestConnectionButton({
  harnessId,
  record,
  onTest,
  onResult,
}: {
  /** Keys both the persisted result and the in-flight "testing" flag. */
  harnessId: string;
  /**
   * Persisted readiness for this agent. The button's resting Verified/Failed
   * display is DERIVED from this — not from local state — so the outcome
   * survives navigating away and coming back (and app restarts): the record
   * lives in `harnessReadinessAtom` (localStorage), and re-running the test
   * writes back through `onResult`, which flows in here as a fresh `record`.
   */
  record: HarnessReadinessRecord | null;
  onTest: () => Promise<HarnessConnectionTestResultPayload>;
  onResult?: (ok: boolean, detail: string) => void;
}) {
  // The in-flight flag lives in a session-scoped atom (keyed by harness id), not
  // component state, so the "Testing…" spinner survives navigating away and back
  // while the runtime test keeps running. The run below started the flag; its
  // `finally` clears it even if this button already unmounted.
  const { isTesting, setTesting } = useHarnessTesting();
  const testing = isTesting(harnessId);

  async function run() {
    if (testing) {
      return;
    }
    setTesting(harnessId, true);
    try {
      const result = await onTest();
      onResult?.(result.ok, result.detail ?? "");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Connection test failed.";
      onResult?.(false, message);
    } finally {
      setTesting(harnessId, false);
    }
  }

  const state: "idle" | "testing" | "ok" | "fail" = testing
    ? "testing"
    : record?.status === "ready"
      ? "ok"
      : record?.status === "needs_setup"
        ? "fail"
        : "idle";
  const detail = record?.detail ?? "";

  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      disabled={testing}
      onClick={() => void run()}
      title={state === "ok" || state === "fail" ? detail || undefined : undefined}
      className={cn(
        state === "ok" &&
          "border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
        state === "fail" && "border-destructive/40 text-destructive",
      )}
    >
      {state === "testing" ? (
        <>
          <Loader2 className="size-3 animate-spin" />
          Testing…
        </>
      ) : state === "ok" ? (
        <>
          <Check className="size-3" />
          Verified
        </>
      ) : state === "fail" ? (
        <>
          <AlertTriangle className="size-3" />
          Retry
        </>
      ) : (
        "Test connection"
      )}
    </Button>
  );
}

/**
 * Status as a quiet dot + label (the dot carries the colour, the label stays
 * muted) so a column of agents reads at a glance without loud pills.
 */
function StatusDot({
  available,
  builtIn,
  readiness,
}: {
  available: boolean;
  builtIn: boolean;
  readiness?: HarnessReadinessRecord | null;
}) {
  const status: { dot: string; label: string } = builtIn
    ? { dot: "bg-emerald-500", label: "Built-in" }
    : !available
      ? { dot: "border border-foreground/25", label: "Not installed" }
      : readiness?.status === "ready"
        ? { dot: "bg-emerald-500", label: "Ready" }
        : readiness?.status === "needs_setup"
          ? { dot: "bg-amber-500", label: "Needs setup" }
          : { dot: "bg-foreground/25", label: "Installed" };

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", status.dot)} />
      {status.label}
    </span>
  );
}
