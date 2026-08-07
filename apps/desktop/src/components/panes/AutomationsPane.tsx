import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDownNarrowWide,
  ArrowLeft,
  CalendarClock,
  Check,
  Bot,
  ChevronDown,
  Clock3,
  ExternalLink,
  Folder,
  Globe,
  Inbox,
  Lightbulb,
  Info,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Search,
  Sparkles,
  Sun,
  Trash2,
  type IconType,
} from "@/components/ui/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-shell";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { sharedCronjobsAtom, useWorkspaceProjects } from "@/components/layout/shell/useWorkspaceLists";
import { useStartAutomationCreation } from "@/components/layout/shell/useStartAutomationCreation";
import { cn } from "@/lib/utils";
import { cronToHumanReadable } from "@/lib/cron";
import { remoteApi } from "@/lib/remoteApiClient";
import { ModelCatalogRefreshButton } from "@/components/model/ModelCatalogRefreshButton";
import { displayModelLabel } from "@/components/panes/ChatPane/helpers";
import { displayThinkingValueLabel } from "@/components/panes/ChatPane/Composer/ThinkingValueSelect";
import { useChatComposerModelSelection } from "@/lib/chat/useChatComposerModelSelection";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { HarnessPicker } from "@/components/harness/HarnessPicker";
import { useAvailableHarnesses } from "@/components/harness/useAvailableHarnesses";
import {
  automationModelChoiceForHarness,
  automationThinkingChoiceForModel,
  reconcileAutomationModel,
  reconcileAutomationThinkingValue,
} from "@/components/panes/automationModelOptions";
import { SchedulePicker } from "@/components/panes/AutomationsPaneInlineEditors";
import {
  AUTOMATION_EXAMPLES,
  type AutomationExample,
} from "@/components/panes/automationExamples";
import { AutomationExamplePreviewDialog } from "@/components/panes/AutomationExamplePreviewDialog";
import {
  ManualAutomationDialog,
  type ManualAutomationDraft,
} from "@/components/panes/ManualAutomationDialog";
import { toast } from "sonner";

// Stable empty reference so the shared-atom `null` (never-loaded) state maps to
// the same array identity across renders.
const EMPTY_CRONJOBS: CronjobRecordPayload[] = [];

type AutomationsView = { mode: "index" } | { mode: "detail"; jobId: string };

type AutomationSortKey = "next_run" | "name" | "created";

const SORT_OPTIONS: Array<{ key: AutomationSortKey; label: string }> = [
  { key: "next_run", label: "Next run" },
  { key: "name", label: "Name" },
  { key: "created", label: "Recently created" },
];

const IMMINENT_WINDOW_MS = 60 * 60_000;

interface AutomationsPaneProps {
  workspaceId?: string | null;
  composerModel?: string | null;
  emptyWorkspaceMessage?: string;
  // Opens the spawned subagent's session (used by Run-now to surface
  // the live run in the chat panel). Kept for tool-trigger callers.
  onOpenRunSession?: (sessionId: string) => void;
  onRunNow?: (job: CronjobRecordPayload) => void;
}

interface RefreshDataOptions {
  suppressErrors?: boolean;
}

function normalizeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}

function formatRelativeTimestamp(value: string | null): string {
  if (!value) {
    return "—";
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  const diffMs = Date.now() - parsed;
  const diffMin = Math.round(diffMs / 60_000);
  if (Math.abs(diffMin) < 1) {
    return "just now";
  }
  if (Math.abs(diffMin) < 60) {
    return `${diffMin > 0 ? `${diffMin}m ago` : `in ${-diffMin}m`}`;
  }
  const diffHr = Math.round(diffMin / 60);
  if (Math.abs(diffHr) < 24) {
    return `${diffHr > 0 ? `${diffHr}h ago` : `in ${-diffHr}h`}`;
  }
  const date = new Date(parsed);
  const datePart = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const timePart = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${datePart}, ${timePart}`;
}

function jobTitle(job: CronjobRecordPayload): string {
  return job.name?.trim() || job.description?.trim() || "Untitled automation";
}

function jobExcerpt(job: CronjobRecordPayload): string {
  return job.description?.trim() || job.instruction?.trim() || "";
}

function jobDeliveryChannel(job: CronjobRecordPayload): string {
  return job.delivery?.channel?.trim().toLowerCase() || "";
}

function jobIsNotification(job: CronjobRecordPayload): boolean {
  return jobDeliveryChannel(job) === "system_notification";
}

function jobProjectId(job: CronjobRecordPayload): string | null {
  const value = job.metadata?.project_id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// The model pinned to this automation (metadata.selected_model), or null when
// it should follow the workspace default at run time. NB: the runtime strips a
// transient metadata.model on write, so the persisted pin lives under
// selected_model — see cronjob-runtime.ts.
function jobModel(job: CronjobRecordPayload): string | null {
  const value = job.metadata?.selected_model;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// The reasoning effort pinned to this automation (metadata.thinking_value), or
// null to follow the model's own default at run time. Read back in fireCronjob.
function jobThinkingValue(job: CronjobRecordPayload): string | null {
  const value = job.metadata?.thinking_value;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// The agent (harness) an automation's runs execute under (metadata.harness),
// defaulting to pi/Hola.
function jobHarness(job: CronjobRecordPayload): string {
  const value = job.metadata?.harness;
  return typeof value === "string" && value.trim() ? value.trim() : "pi";
}

// Lightweight fuzzy match: subsequence with contiguity + word-start bonuses.
// Returns a score (higher = better) or null when the query's characters aren't
// all present in order. A direct substring hit outranks any subsequence match,
// and an earlier hit ranks above a later one.
function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  const substringAt = t.indexOf(q);
  if (substringAt >= 0) return 10_000 - substringAt;
  let cursor = 0;
  let score = 0;
  let streak = 0;
  for (const char of q) {
    const at = t.indexOf(char, cursor);
    if (at < 0) return null;
    const prev = t[at - 1] ?? "";
    const wordStart = at === 0 || /[\s/_.-]/.test(prev);
    streak = at === cursor ? streak + 1 : 0;
    score += 1 + streak * 2 + (wordStart ? 4 : 0);
    cursor = at + 1;
  }
  return score;
}

// Best fuzzy score for an automation across its searchable fields (title,
// description, delivery channel, project). Null when nothing matches.
function automationSearchScore(
  job: CronjobRecordPayload,
  query: string,
  projectName: string | null,
): number | null {
  const fields = [
    jobTitle(job),
    job.description ?? "",
    jobDeliveryChannel(job),
    projectName ?? "",
  ];
  let best: number | null = null;
  for (const field of fields) {
    if (!field) continue;
    const score = fuzzyScore(query, field);
    if (score !== null) best = best === null ? score : Math.max(best, score);
  }
  return best;
}

// Sentinel <Select> value for "no pinned model → workspace default" (Select
// can't hold null/empty).
const MODEL_WORKSPACE_DEFAULT = "__workspace_default__";

// Sentinel <Select> value for "no pinned reasoning effort → model default".
const THINKING_MODEL_DEFAULT = "__model_default__";

function jobLastSessionId(job: CronjobRecordPayload): string | null {
  const value = job.metadata?.last_session_id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function scheduleLabel(job: CronjobRecordPayload): string {
  return cronToHumanReadable(job.cron) || job.cron;
}

/** Short "when does it fire next" hint; `imminent` drives the highlighted chip. */
function nextRunHint(
  job: CronjobRecordPayload,
  nowMs: number,
): { text: string; imminent: boolean } | null {
  if (!job.enabled || !job.next_run_at) {
    return null;
  }
  const ts = Date.parse(job.next_run_at);
  if (Number.isNaN(ts)) {
    return null;
  }
  const diffMs = ts - nowMs;
  if (diffMs <= 60_000) {
    return { text: "Runs any moment", imminent: true };
  }
  if (diffMs <= IMMINENT_WINDOW_MS) {
    return { text: `Runs in ${Math.round(diffMs / 60_000)}m`, imminent: true };
  }
  if (diffMs <= 24 * 60 * 60_000) {
    const date = new Date(ts);
    const time = date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const sameDay = date.getDate() === new Date(nowMs).getDate();
    return { text: `Runs ${sameDay ? "today" : "tomorrow"} ${time}`, imminent: false };
  }
  return null;
}

export function AutomationsPane({
  workspaceId,
  composerModel,
  emptyWorkspaceMessage = "Switch from the top bar to view its automations.",
  onOpenRunSession,
  onRunNow,
}: AutomationsPaneProps) {
  const [view, setView] = useState<AutomationsView>({ mode: "index" });
  const [sortKey, setSortKey] = useState<AutomationSortKey>("next_run");
  const [searchQuery, setSearchQuery] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [manualPrefill, setManualPrefill] =
    useState<Partial<ManualAutomationDraft> | null>(null);
  const [previewExample, setPreviewExample] =
    useState<AutomationExample | null>(null);
  const [editJobId, setEditJobId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] =
    useState<CronjobRecordPayload | null>(null);
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const activeWorkspaceId = workspaceId ?? selectedWorkspaceId;
  // Read/write the shared cronjobs cache so navigating back into Automations
  // renders with the last-known list on the first frame (kept warm by the
  // shell) rather than flashing the loading skeleton. The atom is `null` until
  // the first fetch resolves — `hasLoadedCronjobs` gates the skeleton so it
  // only ever shows on the genuine first load, not on every remount/refetch.
  const [cronjobsRaw, setCronjobsRaw] = useAtom(sharedCronjobsAtom);
  const cronjobs = cronjobsRaw ?? EMPTY_CRONJOBS;
  const hasLoadedCronjobs = cronjobsRaw !== null;
  const setCronjobs = useCallback(
    (
      updater:
        | CronjobRecordPayload[]
        | ((current: CronjobRecordPayload[]) => CronjobRecordPayload[]),
    ) => {
      setCronjobsRaw((prev) => {
        const current = prev ?? [];
        return typeof updater === "function" ? updater(current) : updater;
      });
    },
    [setCronjobsRaw],
  );
  const [isLoading, setIsLoading] = useState(false);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);

  const { projects } = useWorkspaceProjects(activeWorkspaceId || null);
  const projectNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) {
      map.set(project.project_id, project.name);
    }
    return map;
  }, [projects]);

  // Keep imminent-run countdowns fresh without refetching.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // Keep-awake mirrors Settings › Power (same machine-level preference the
  // Channels pane surfaces). Automations only fire while the machine is
  // awake, so nudge when it's off: the card appears only when the preference
  // was off on mount, and stays visible after flipping it on so the switch
  // doesn't vanish under the cursor.
  const [keepAwake, setKeepAwake] = useState(true);
  const [showKeepAwakeCard, setShowKeepAwakeCard] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.ui
      .getKeepAwakeEnabled()
      .then((enabled) => {
        if (cancelled) return;
        setKeepAwake(enabled);
        if (!enabled) setShowKeepAwakeCard(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const handleKeepAwakeChange = useCallback((enabled: boolean) => {
    setKeepAwake(enabled);
    void window.electronAPI?.ui
      .setKeepAwakeEnabled(enabled)
      .then((persisted) => setKeepAwake(persisted))
      .catch(() => undefined);
  }, []);

  const sortedJobs = useMemo(() => {
    const nextRunTs = (job: CronjobRecordPayload) => {
      const raw = Date.parse(job.next_run_at ?? "");
      return Number.isNaN(raw) ? Number.POSITIVE_INFINITY : raw;
    };
    return [...cronjobs].sort((left, right) => {
      if (left.enabled !== right.enabled) {
        return left.enabled ? -1 : 1;
      }
      if (sortKey === "name") {
        return jobTitle(left).localeCompare(jobTitle(right));
      }
      if (sortKey === "created") {
        return right.created_at.localeCompare(left.created_at);
      }
      return nextRunTs(left) - nextRunTs(right);
    });
  }, [cronjobs, sortKey]);

  // With a query, fuzzy-filter and rank by relevance (best match first) — that
  // ordering is more useful than the chosen sort while searching. Empty query
  // falls back to the sorted list.
  const trimmedQuery = searchQuery.trim();
  const visibleJobs = useMemo(() => {
    if (!trimmedQuery) return sortedJobs;
    return cronjobs
      .map((job) => ({
        job,
        score: automationSearchScore(
          job,
          trimmedQuery,
          projectNameById.get(jobProjectId(job) ?? "") ?? null,
        ),
      }))
      .filter((entry): entry is { job: CronjobRecordPayload; score: number } =>
        entry.score !== null,
      )
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.job);
  }, [trimmedQuery, sortedJobs, cronjobs, projectNameById]);

  const detailJob =
    view.mode === "detail"
      ? (cronjobs.find((job) => job.id === view.jobId) ?? null)
      : null;
  useEffect(() => {
    if (view.mode === "detail" && hasLoadedCronjobs && !detailJob) {
      setView({ mode: "index" });
    }
  }, [view, hasLoadedCronjobs, detailJob]);

  const editJob = editJobId
    ? (cronjobs.find((job) => job.id === editJobId) ?? null)
    : null;

  const refreshData = useCallback(
    async (options?: RefreshDataOptions) => {
      const suppressErrors = options?.suppressErrors ?? false;

      if (!activeWorkspaceId) {
        setCronjobs([]);
        return;
      }

      setIsLoading(true);
      try {
        const cronjobsResponse = await remoteApi.cronjobs.list({
        });

        setCronjobs(cronjobsResponse.jobs);
      } catch (error) {
        if (!suppressErrors) {
          toast.error("Couldn't load automations", {
            description: normalizeErrorMessage(error),
          });
        }
      } finally {
        setIsLoading(false);
      }
    },
    [activeWorkspaceId],
  );

  useEffect(() => {
    void refreshData();
  }, [refreshData]);

  const handleDelete = async (job: CronjobRecordPayload) => {
    setBusyJobId(job.id);
    try {
      await remoteApi.cronjobs.delete({
        jobId: job.id,
      });
      setCronjobs((previous) => previous.filter((item) => item.id !== job.id));
      setView((current) =>
        current.mode === "detail" && current.jobId === job.id
          ? { mode: "index" }
          : current,
      );
      toast.success(`Deleted "${jobTitle(job)}"`);
      void refreshData({ suppressErrors: true });
    } catch (error) {
      toast.error("Couldn't delete automation", {
        description: normalizeErrorMessage(error),
      });
    } finally {
      setBusyJobId(null);
    }
  };

  const handleUpdateCronjobField = useCallback(
    async (
      job: CronjobRecordPayload,
      payload: CronjobUpdatePayload,
      successMessage: string,
    ) => {
      setBusyJobId(job.id);
      try {
        const updated = await remoteApi.cronjobs.update({
          jobId: job.id,
          ...payload,
        });
        setCronjobs((previous) =>
          previous.map((item) => (item.id === updated.id ? updated : item)),
        );
        toast.success(successMessage);
        void refreshData({ suppressErrors: true });
      } catch (error) {
        toast.error("Couldn't save automation", {
          description: normalizeErrorMessage(error),
        });
        // Re-throw so the edit dialog can keep itself open and let the user
        // retry without losing their draft.
        throw error;
      } finally {
        setBusyJobId(null);
      }
    },
    [refreshData],
  );

  const handleToggleEnabled = async (job: CronjobRecordPayload) => {
    setBusyJobId(job.id);
    try {
      const updated = await remoteApi.cronjobs.update({
        jobId: job.id,
        enabled: !job.enabled,
      });
      setCronjobs((previous) =>
        previous.map((item) => (item.id === updated.id ? updated : item)),
      );
      toast.success(
        `${updated.enabled ? "Enabled" : "Paused"} "${jobTitle(updated)}"`,
      );
      void refreshData({ suppressErrors: true });
    } catch (error) {
      toast.error("Couldn't update automation", {
        description: normalizeErrorMessage(error),
      });
    } finally {
      setBusyJobId(null);
    }
  };

  const handleRunNow = async (job: CronjobRecordPayload) => {
    setBusyJobId(job.id);
    try {
      const response = await remoteApi.cronjobs.runNow({
        jobId: job.id,
        model: composerModel ?? undefined,
      });
      setCronjobs((previous) =>
        previous.map((item) =>
          item.id === response.cronjob.id ? response.cronjob : item,
        ),
      );
      toast.success(`Running "${jobTitle(response.cronjob)}" now`, {
        description: "Track it from the running task in chat.",
      });
      if (response.session_id && onOpenRunSession) {
        onOpenRunSession(response.session_id);
        return;
      }
      if (onRunNow) {
        onRunNow(response.cronjob);
        return;
      }
      void refreshData({ suppressErrors: true });
    } catch (error) {
      toast.error("Couldn't run automation", {
        description: normalizeErrorMessage(error),
      });
    } finally {
      setBusyJobId(null);
    }
  };

  // "Create with Hola" — hands off to the conversational builder: opens a fresh
  // pre-filled chat draft (same pattern as skill creation), where Hola explains
  // automations and interviews the user to set one up.
  const startAutomationCreation = useStartAutomationCreation();
  const handleCreateWithHola = () => {
    startAutomationCreation();
  };
  // Examples open a preview first — no chat turn is spent until the user
  // explicitly picks the conversational path from inside it.
  const handleUseExample = (example: AutomationExample) => {
    setPreviewExample(example);
  };
  const handleSetUpExample = (example: AutomationExample) => {
    setPreviewExample(null);
    setManualPrefill({
      name: example.name,
      instruction: example.instruction,
      cron: example.cron,
    });
    setManualOpen(true);
  };
  const handleCustomizeExampleWithHola = (example: AutomationExample) => {
    setPreviewExample(null);
    startAutomationCreation(example.draftPrompt);
  };

  // "Set up manually" — write a cronjob directly from the dialog draft.
  const createManualAutomation = useCallback(
    async (draft: ManualAutomationDraft) => {
      if (!activeWorkspaceId) {
        throw new Error("No workspace selected.");
      }
      await remoteApi.cronjobs.create({
        initiatedBy: "desktop_user",
        name: draft.name || undefined,
        cron: draft.cron,
        // description is required by the API — fall back to the instruction.
        description: draft.name || draft.instruction.slice(0, 120),
        instruction: draft.instruction,
        enabled: true,
        delivery: { mode: "announce", channel: draft.channel, to: null },
        // Per-automation overrides read back in fireCronjob. selected_model is
        // the pinned model (metadata.model is stripped by the runtime, so the
        // pin lives under selected_model — same key the edit dialog writes).
        metadata: {
          harness: draft.harness,
          ...(draft.projectId ? { project_id: draft.projectId } : {}),
          ...(draft.model ? { selected_model: draft.model } : {}),
          ...(draft.thinkingValue
            ? { thinking_value: draft.thinkingValue }
            : {}),
        },
      });
      toast.success(`Created "${draft.name || "automation"}"`);
      await refreshData({ suppressErrors: true });
    },
    [activeWorkspaceId, refreshData],
  );

  const saveEditedAutomation = useCallback(
    async (job: CronjobRecordPayload, draft: EditAutomationDraft) => {
      const metadata: Record<string, unknown> = { ...job.metadata };
      metadata.harness = draft.harness;
      if (draft.projectId) {
        metadata.project_id = draft.projectId;
      } else {
        delete metadata.project_id;
      }
      if (draft.model) {
        metadata.selected_model = draft.model;
      } else {
        delete metadata.selected_model;
      }
      if (draft.thinkingValue) {
        metadata.thinking_value = draft.thinkingValue;
      } else {
        delete metadata.thinking_value;
      }
      await handleUpdateCronjobField(
        job,
        {
          name: draft.name,
          instruction: draft.instruction,
          cron: draft.cron,
          metadata,
        },
        `Updated "${draft.name || jobTitle(job)}"`,
      );
    },
    [handleUpdateCronjobField],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {view.mode === "index" ? (
        <PageHeader
          title="Automations"
          actions={
            <>
              {cronjobs.length > 0 ? (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search automations…"
                    aria-label="Search automations"
                    className="h-7 w-40 pl-7 text-xs sm:w-48"
                  />
                </div>
              ) : null}
              {sortedJobs.length > 1 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
                      />
                    }
                  >
                    <ArrowDownNarrowWide className="size-3.5" />
                    {SORT_OPTIONS.find((option) => option.key === sortKey)?.label}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" sideOffset={6} className="w-44">
                    {SORT_OPTIONS.map((option) => (
                      <DropdownMenuItem
                        key={option.key}
                        onClick={() => setSortKey(option.key)}
                      >
                        {option.label}
                        {sortKey === option.key ? (
                          <Check className="ml-auto size-3.5" />
                        ) : null}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="More actions"
                    />
                  }
                >
                  <MoreHorizontal className="size-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={6} className="w-44">
                  <DropdownMenuItem
                    onClick={() => void refreshData()}
                    disabled={isLoading}
                  >
                    <RotateCw
                      className={cn("size-3.5", isLoading && "animate-spin")}
                    />
                    Refresh
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {/* Split button: the primary action goes straight to the
                  conversational builder; the manual form stays behind the
                  chevron for people who know exactly what they want. */}
              <div className="flex items-center">
                <Button
                  type="button"
                  variant="default"
                  size="sm"
                  className="h-7 gap-1.5 rounded-r-none"
                  onClick={handleCreateWithHola}
                >
                  <Plus className="size-3.5" />
                  Create
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        type="button"
                        variant="default"
                        size="sm"
                        aria-label="More ways to create"
                        className="h-7 rounded-l-none border-l border-primary-foreground/20 px-1.5"
                      />
                    }
                  >
                    <ChevronDown className="size-3.5 opacity-80" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" sideOffset={6} className="w-52">
                    <DropdownMenuItem
                      onClick={() => setManualOpen(true)}
                      disabled={!activeWorkspaceId}
                    >
                      <Pencil className="size-3.5" />
                      Set up manually
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </>
          }
        />
      ) : null}

      <ManualAutomationDialog
        open={manualOpen}
        onOpenChange={(open) => {
          setManualOpen(open);
          if (!open) setManualPrefill(null);
        }}
        workspaceId={activeWorkspaceId ?? null}
        initialDraft={manualPrefill}
        onCreate={createManualAutomation}
      />

      <AutomationExamplePreviewDialog
        example={previewExample}
        onOpenChange={(open) => {
          if (!open) setPreviewExample(null);
        }}
        onSetUp={handleSetUpExample}
        onCustomizeWithHola={handleCustomizeExampleWithHola}
      />

      <EditAutomationDialog
        job={editJob}
        projects={projects}
        workspaceId={activeWorkspaceId ?? null}
        onOpenChange={(open) => {
          if (!open) setEditJobId(null);
        }}
        onSave={saveEditedAutomation}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete this automation?"
        description={
          pendingDelete
            ? `"${jobTitle(pendingDelete)}" and its schedule will be permanently removed.`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (pendingDelete) {
            void handleDelete(pendingDelete);
          }
          setPendingDelete(null);
        }}
      />

      <div className="min-h-0 w-full flex-1 overflow-y-auto [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-5xl">
        {!activeWorkspaceId ? (
          <EmptyState
            icon={CalendarClock}
            size="md"
            decorated
            title="No workspace selected"
            description={emptyWorkspaceMessage}
          />
        ) : view.mode === "detail" && detailJob ? (
          <AutomationDetail
            job={detailJob}
            projectName={
              jobProjectId(detailJob)
                ? (projectNameById.get(jobProjectId(detailJob) ?? "") ??
                  "Unknown project")
                : null
            }
            busy={busyJobId === detailJob.id}
            onBack={() => setView({ mode: "index" })}
            onEdit={() => setEditJobId(detailJob.id)}
            onDelete={() => setPendingDelete(detailJob)}
            onRunNow={() => void handleRunNow(detailJob)}
            onToggleEnabled={() => void handleToggleEnabled(detailJob)}
            onOpenLastRun={
              jobLastSessionId(detailJob) && onOpenRunSession
                ? () => {
                    const sessionId = jobLastSessionId(detailJob);
                    if (sessionId) onOpenRunSession(sessionId);
                  }
                : null
            }
          />
        ) : !hasLoadedCronjobs && cronjobs.length === 0 ? (
          <SkeletonGrid />
        ) : cronjobs.length === 0 ? (
          <AutomationsEmptyState
            manualDisabled={!activeWorkspaceId}
            onCreateWithHola={handleCreateWithHola}
            onSetUpManually={() => setManualOpen(true)}
            onUseExample={handleUseExample}
          />
        ) : visibleJobs.length === 0 ? (
          <EmptyState
            icon={Search}
            size="md"
            title="No matching automations"
            description={`Nothing matches “${trimmedQuery}”. Try a different search.`}
          />
        ) : (
          <>
            {showKeepAwakeCard ? (
              <div className="px-6 pt-3">
                <div className="flex items-center gap-2.5 rounded-lg border border-border bg-fg-2 px-3 py-2">
                  <Info className="size-4 shrink-0 text-muted-foreground" />
                  <p className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                    Automations only run while your computer is awake.
                  </p>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <Sun
                      className={cn(
                        "size-3.5 transition-colors",
                        keepAwake ? "text-primary" : "text-muted-foreground",
                      )}
                    />
                    <span className="text-xs font-medium text-foreground">
                      Keep awake
                    </span>
                    <Switch
                      checked={keepAwake}
                      onCheckedChange={handleKeepAwakeChange}
                      aria-label="Keep computer awake"
                    />
                  </span>
                </div>
              </div>
            ) : null}
            <ul className="grid gap-3 px-6 py-3 sm:grid-cols-2">
              {visibleJobs.map((job) => (
                <AutomationCard
                  key={job.id}
                  job={job}
                  projectName={
                    jobProjectId(job)
                      ? (projectNameById.get(jobProjectId(job) ?? "") ??
                        "Unknown project")
                      : null
                  }
                  nowMs={nowMs}
                  busy={busyJobId === job.id}
                  onOpen={() => setView({ mode: "detail", jobId: job.id })}
                  onEdit={() => setEditJobId(job.id)}
                  onRunNow={() => void handleRunNow(job)}
                  onToggleEnabled={() => void handleToggleEnabled(job)}
                  onDelete={() => setPendingDelete(job)}
                />
              ))}
            </ul>
            {sortedJobs.length <= 2 ? (
              <ExamplesGallery
                heading="More examples"
                onUseExample={handleUseExample}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function AutomationCard({
  job,
  projectName,
  nowMs,
  busy,
  onOpen,
  onEdit,
  onRunNow,
  onToggleEnabled,
  onDelete,
}: {
  job: CronjobRecordPayload;
  projectName: string | null;
  nowMs: number;
  busy: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onRunNow: () => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
}) {
  const hint = nextRunHint(job, nowMs);
  return (
    <li
      className={cn(
        "relative rounded-xl border border-border bg-card transition-colors hover:bg-accent",
        busy && "opacity-60",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${jobTitle(job)}`}
        className="absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="pointer-events-none flex flex-col gap-2 px-4 pt-3.5 pb-4">
        <div className="flex items-center gap-1.5 pr-7">
          <span
            className={cn(
              "truncate text-sm font-medium text-foreground",
              !job.enabled && "text-muted-foreground",
            )}
          >
            {jobTitle(job)}
          </span>
          {jobIsNotification(job) ? (
            <Badge
              variant="outline"
              className="border-border bg-fg-2 px-1.5 py-0 text-[10px] font-medium leading-4 text-muted-foreground"
            >
              Notification
            </Badge>
          ) : null}
          {!job.enabled ? (
            <Badge
              variant="outline"
              className="border-border bg-fg-2 px-1.5 py-0 text-[10px] font-medium leading-4 text-muted-foreground"
            >
              Paused
            </Badge>
          ) : null}
        </div>
        <p className="line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground">
          {jobExcerpt(job)}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              "inline-flex min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
              job.enabled
                ? "border-success/20 bg-success/8 font-medium text-success"
                : "border-border bg-fg-2 text-muted-foreground",
            )}
          >
            <Clock3 className="size-3 shrink-0" />
            <span className="truncate">{scheduleLabel(job)}</span>
          </span>
          {hint ? (
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
                hint.imminent
                  ? "border-primary/25 bg-primary/10 font-medium text-primary"
                  : "border-border bg-fg-2 text-muted-foreground",
              )}
            >
              {hint.text}
            </span>
          ) : null}
          {projectName ? (
            <span className="inline-flex min-w-0 items-center gap-1 rounded-full border border-border bg-fg-2 px-2 py-0.5 text-[11px] text-muted-foreground">
              <Folder className="size-3 shrink-0" />
              <span className="truncate">{projectName}</span>
            </span>
          ) : null}
          {job.last_status === "error" || job.last_error ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-destructive">
              <AlertTriangle className="size-3" />
              Last run failed
            </span>
          ) : job.run_count === 0 && job.enabled ? (
            <span className="inline-flex shrink-0 items-center text-[11px] text-muted-foreground/70">
              Hasn't run yet
            </span>
          ) : null}
        </div>
      </div>
      <div className="absolute top-2 right-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Actions for ${jobTitle(job)}`}
                className="rounded-lg text-muted-foreground hover:text-foreground"
              />
            }
          >
            <MoreHorizontal size={14} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="w-44">
            <DropdownMenuItem onClick={onRunNow} disabled={busy}>
              <Play size={14} />
              Run now
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onEdit} disabled={busy}>
              <Pencil size={14} />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onToggleEnabled} disabled={busy}>
              <Clock3 size={14} />
              {job.enabled ? "Pause" : "Resume"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDelete} disabled={busy} variant="destructive">
              <Trash2 size={14} />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

function AutomationDetail({
  job,
  projectName,
  busy,
  onBack,
  onEdit,
  onDelete,
  onRunNow,
  onToggleEnabled,
  onOpenLastRun,
}: {
  job: CronjobRecordPayload;
  projectName: string | null;
  busy: boolean;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRunNow: () => void;
  onToggleEnabled: () => void;
  onOpenLastRun: (() => void) | null;
}) {
  const harness =
    typeof job.metadata?.harness === "string" && job.metadata.harness.trim()
      ? job.metadata.harness.trim()
      : "pi";
  const pinnedModel = jobModel(job);
  const modelLabel = pinnedModel
    ? displayModelLabel(pinnedModel)
    : "Workspace default";
  return (
    <div className="px-6 pt-6 pb-10">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Automations
      </button>

      <div className="mt-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            {jobTitle(job)}
          </h2>
          {job.description?.trim() &&
          job.description.trim() !== job.instruction?.trim() ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {job.description.trim()}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            <Switch
              checked={job.enabled}
              onCheckedChange={onToggleEnabled}
              disabled={busy}
              aria-label={job.enabled ? "Pause automation" : "Enable automation"}
            />
            <Badge
              variant="outline"
              className={cn(
                "px-1.5 py-0 text-[10px] font-medium leading-4",
                job.enabled
                  ? "border-success/20 bg-success/8 text-success"
                  : "border-border bg-fg-2 text-muted-foreground",
              )}
            >
              {job.enabled ? "Active" : "Paused"}
            </Badge>
            {job.enabled && job.next_run_at ? (
              <span className="text-xs text-muted-foreground">
                Next run {formatRelativeTimestamp(job.next_run_at)}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Edit automation"
            onClick={onEdit}
            disabled={busy}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Delete automation"
            onClick={onDelete}
            disabled={busy}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 gap-1.5"
            onClick={onRunNow}
            disabled={busy}
          >
            <Play className="size-3.5" />
            Run now
          </Button>
        </div>
      </div>

      <div className="mt-6 grid gap-6 border-t border-border pt-6">
        <InstructionSection instruction={job.instruction ?? ""} />

        <div className="grid gap-5 sm:grid-cols-2">
          <DetailSection label="Repeats">
            <p className="text-sm text-foreground">{scheduleLabel(job)}</p>
            <code className="mt-1 inline-block rounded bg-fg-2 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {job.cron}
            </code>
          </DetailSection>

          <DetailSection label="Agent">
            <span className="inline-flex items-center gap-1.5 text-sm text-foreground">
              <Bot className="size-3.5 text-muted-foreground" />
              {harness}
            </span>
          </DetailSection>

          <DetailSection label="Model">
            <span className="inline-flex items-center gap-1.5 text-sm text-foreground">
              <Sparkles className="size-3.5 text-muted-foreground" />
              {modelLabel}
            </span>
          </DetailSection>

          <DetailSection label="Project" className="sm:col-span-2">
            {projectName ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-foreground">
                <Folder className="size-3.5 text-muted-foreground" />
                {projectName}
              </span>
            ) : (
              <p className="text-sm text-muted-foreground">
                None — runs and their output stay in the workspace. Edit to bind
                a project.
              </p>
            )}
          </DetailSection>

          <DetailSection label="Last run" className="sm:col-span-2">
            {job.run_count > 0 && job.last_run_at ? (
              <div className="flex flex-wrap items-center gap-2">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 rounded-full",
                    job.last_status === "error"
                      ? "bg-destructive"
                      : "bg-success",
                  )}
                />
                <span className="text-sm text-foreground">
                  {formatRelativeTimestamp(job.last_run_at)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {job.run_count} total
                </span>
                {onOpenLastRun ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-6 gap-1 px-2 text-xs"
                    onClick={onOpenLastRun}
                  >
                    <ExternalLink className="size-3" />
                    Open last run
                  </Button>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Hasn't run yet — try it once with Run now.
              </p>
            )}
            {job.last_error ? (
              <p className="mt-1.5 flex items-start gap-1 text-xs font-medium text-destructive">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                <span>{job.last_error}</span>
              </p>
            ) : null}
          </DetailSection>
        </div>
      </div>
    </div>
  );
}

function InstructionSection({ instruction }: { instruction: string }) {
  const [expanded, setExpanded] = useState(true);
  const trimmed = instruction.trim() || "—";
  const previewLine = trimmed.split("\n").find((line) => line.trim()) ?? "—";

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-fg-2">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left transition-colors hover:bg-accent"
      >
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-snappy",
            !expanded && "-rotate-90",
          )}
        />
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Instruction
        </span>
        {expanded ? null : (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {previewLine}
          </span>
        )}
      </button>
      {expanded ? (
        <div className="border-t border-border px-3.5 py-3">
          <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">
            {trimmed}
          </p>
        </div>
      ) : null}
    </section>
  );
}

function DetailSection({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid content-start gap-1.5", className)}>
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

interface EditAutomationDraft {
  name: string;
  instruction: string;
  cron: string;
  projectId: string | null;
  model: string | null;
  thinkingValue: string | null;
  harness: string;
}

function EditAutomationDialog({
  job,
  projects,
  workspaceId,
  onOpenChange,
  onSave,
}: {
  job: CronjobRecordPayload | null;
  projects: WorkspaceProjectRecordPayload[];
  workspaceId: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (job: CronjobRecordPayload, draft: EditAutomationDraft) => Promise<void>;
}) {
  return (
    <DialogPrimitive.Root open={job !== null} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[90] bg-foreground/20 backdrop-blur-sm ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed top-[14%] left-1/2 z-[100] w-[480px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover shadow-2xl outline-none ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
          {job ? (
            <EditAutomationForm
              key={job.id}
              job={job}
              projects={projects}
              workspaceId={workspaceId}
              onCancel={() => onOpenChange(false)}
              onSave={onSave}
            />
          ) : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function EditAutomationForm({
  job,
  projects,
  workspaceId,
  onCancel,
  onSave,
}: {
  job: CronjobRecordPayload;
  projects: WorkspaceProjectRecordPayload[];
  workspaceId: string | null;
  onCancel: () => void;
  onSave: (job: CronjobRecordPayload, draft: EditAutomationDraft) => Promise<void>;
}) {
  const [name, setName] = useState(job.name ?? "");
  const [instruction, setInstruction] = useState(job.instruction ?? "");
  const [cron, setCron] = useState(job.cron);
  const [cronValid, setCronValid] = useState(true);
  const [projectId, setProjectId] = useState<string | null>(jobProjectId(job));
  const [model, setModel] = useState<string | null>(jobModel(job));
  const [thinkingValue, setThinkingValue] = useState<string | null>(
    jobThinkingValue(job),
  );
  const [harness, setHarness] = useState(jobHarness(job));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { harnesses, isLoading: harnessesLoading } =
    useAvailableHarnesses(workspaceId);
  const { runtimeConfig } = useWorkspaceDesktop();
  const { availableChatModelOptions, runtimeDefaultModelLabel } =
    useChatComposerModelSelection();
  // Models are scoped to the selected agent: pi/Hola uses the runtime catalogue
  // (same as the composer), CLI harnesses (claude-code, codex) only their own
  // namespace. Recomputes whenever the agent changes.
  const modelChoice = automationModelChoiceForHarness({
    harness,
    harnesses,
    chatModelOptions: availableChatModelOptions,
  });
  const workspaceDefaultModelLabel = runtimeDefaultModelLabel
    ? `Workspace default (${runtimeDefaultModelLabel})`
    : "Workspace default";
  const defaultOptionLabel = modelChoice.usesHarnessNamespace
    ? "Default (agent's default model)"
    : workspaceDefaultModelLabel;
  // A pin not in the current agent's list still shows so it isn't hidden.
  const modelNotInCatalog =
    model !== null && !modelChoice.options.some((option) => option.value === model);

  // Reasoning-effort levels for the pinned (or default) model — same source as
  // the composer. A CLI-namespace harness doesn't declare per-model effort, so
  // no default fallback there and the field stays hidden.
  const providerModelGroups = runtimeConfig?.providerModelGroups ?? [];
  const thinkingChoiceFor = (nextModel: string | null, namespace: boolean) =>
    automationThinkingChoiceForModel({
      model: nextModel,
      providerModelGroups,
      defaultModel: namespace ? null : (runtimeConfig?.defaultModel ?? null),
    });
  const thinkingChoice = thinkingChoiceFor(
    model,
    modelChoice.usesHarnessNamespace,
  );

  // Switching the agent re-scopes the model list; drop a now-invalid pin to the
  // new agent's default (or workspace default for pi), then reconcile the
  // reasoning-effort pin against the resulting model.
  const handleHarnessChange = (nextHarness: string) => {
    setHarness(nextHarness);
    const nextChoice = automationModelChoiceForHarness({
      harness: nextHarness,
      harnesses,
      chatModelOptions: availableChatModelOptions,
    });
    const nextModel = reconcileAutomationModel({ model, choice: nextChoice });
    setModel(nextModel);
    setThinkingValue((prev) =>
      reconcileAutomationThinkingValue({
        thinkingValue: prev,
        choice: thinkingChoiceFor(nextModel, nextChoice.usesHarnessNamespace),
      }),
    );
  };

  // Re-scope the reasoning-effort pin when the model changes under the same
  // agent (a new model may not offer the previously-pinned effort).
  const handleModelChange = (nextModel: string | null) => {
    setModel(nextModel);
    setThinkingValue((prev) =>
      reconcileAutomationThinkingValue({
        thinkingValue: prev,
        choice: thinkingChoiceFor(nextModel, modelChoice.usesHarnessNamespace),
      }),
    );
  };

  // Offer the picker when there is anything to pick — or when the job is
  // bound to a since-deleted project, so the user can still unbind it.
  const showProjectField = projects.length > 0 || projectId !== null;
  const boundProjectMissing =
    projectId !== null &&
    !projects.some((project) => project.project_id === projectId);

  const canSave = instruction.trim().length > 0 && cronValid && !submitting;

  const handleSave = async () => {
    if (!canSave) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSave(job, {
        name: name.trim(),
        instruction: instruction.trim(),
        cron: cron.trim(),
        projectId,
        model,
        thinkingValue,
        harness,
      });
      onCancel();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't save the automation.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto p-5">
      <DialogPrimitive.Title className="text-sm font-medium text-foreground">
        Edit automation
      </DialogPrimitive.Title>

      <EditField label="Name">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Weekly analytics recap"
          className="h-8 text-sm"
        />
      </EditField>

      <EditField label="Instruction">
        <textarea
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          rows={4}
          className="w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring dark:bg-input/30"
        />
      </EditField>

      <EditField label="Schedule">
        <SchedulePicker
          cron={cron}
          onChange={({ cron: next, valid }) => {
            setCron(next);
            setCronValid(valid);
          }}
        />
      </EditField>

      <EditField label="Agent">
        {/* Shared picker so automations get the same readiness gating as the
            composer. Changing the agent re-scopes the Model list below. */}
        <HarnessPicker
          value={harness}
          harnesses={harnesses}
          isLoading={harnessesLoading}
          onChange={handleHarnessChange}
          className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 font-normal hover:bg-fg-2"
        />
      </EditField>

      <EditField label="Model">
        <div className="flex items-center gap-1.5">
          <Select
            items={[
              { value: MODEL_WORKSPACE_DEFAULT, label: defaultOptionLabel },
              ...(modelNotInCatalog && model
                ? [{ value: model, label: displayModelLabel(model) }]
                : []),
              ...modelChoice.options,
            ]}
            value={model ?? MODEL_WORKSPACE_DEFAULT}
            onValueChange={(value) =>
              handleModelChange(value === MODEL_WORKSPACE_DEFAULT ? null : value)
            }
          >
            <SelectTrigger className="h-8 min-w-0 flex-1 bg-transparent text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start" className="min-w-[240px]">
              <SelectItem value={MODEL_WORKSPACE_DEFAULT}>
                {defaultOptionLabel}
              </SelectItem>
              {modelNotInCatalog && model ? (
                <SelectItem value={model}>{displayModelLabel(model)}</SelectItem>
              ) : null}
              {modelChoice.options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ModelCatalogRefreshButton className="size-8 rounded-md border border-input" />
        </div>
        <p className="text-[11px] text-muted-foreground">
          Follows the agent's default unless you pin a specific model. The list
          changes with the selected agent.
        </p>
      </EditField>

      {thinkingChoice.thinkingValues.length > 0 ? (
        <EditField label="Thinking">
          <Select
            items={[
              { value: THINKING_MODEL_DEFAULT, label: "Default (model's default)" },
              ...thinkingChoice.thinkingValues.map((value) => ({
                value,
                label: displayThinkingValueLabel(value),
              })),
            ]}
            value={thinkingValue ?? THINKING_MODEL_DEFAULT}
            onValueChange={(value) =>
              setThinkingValue(value === THINKING_MODEL_DEFAULT ? null : value)
            }
          >
            <SelectTrigger className="h-8 w-full bg-transparent text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start" className="min-w-[240px]">
              <SelectItem value={THINKING_MODEL_DEFAULT}>
                Default (model's default)
              </SelectItem>
              {thinkingChoice.thinkingValues.map((value) => (
                <SelectItem key={value} value={value}>
                  {displayThinkingValueLabel(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            Reasoning effort for each run. Defaults to the model's own setting.
          </p>
        </EditField>
      ) : null}

      {showProjectField ? (
        <EditField label="Project">
          <Select
            items={[
              { value: "none", label: "No project" },
              ...(boundProjectMissing && projectId
                ? [{ value: projectId, label: "Unknown project" }]
                : []),
              ...projects.map((project) => ({
                value: project.project_id,
                label: project.name,
              })),
            ]}
            value={projectId ?? "none"}
            onValueChange={(value) =>
              setProjectId(value === "none" ? null : value)
            }
          >
            <SelectTrigger className="h-8 w-full bg-transparent text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start" className="min-w-[220px]">
              <SelectItem value="none">No project</SelectItem>
              {boundProjectMissing && projectId ? (
                <SelectItem value={projectId}>Unknown project</SelectItem>
              ) : null}
              {projects.map((project) => (
                <SelectItem key={project.project_id} value={project.project_id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] leading-4 text-muted-foreground">
            Runs happen inside the project and their output is saved there.
          </p>
        </EditField>
      ) : null}

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-[11px] font-medium text-destructive">
          {error}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => void handleSave()}
          disabled={!canSave}
        >
          {submitting ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Save changes
        </Button>
      </div>
    </div>
  );
}

function EditField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

function AutomationsEmptyState({
  manualDisabled,
  onCreateWithHola,
  onSetUpManually,
  onUseExample,
}: {
  manualDisabled: boolean;
  onCreateWithHola: () => void;
  onSetUpManually: () => void;
  onUseExample: (example: AutomationExample) => void;
}) {
  return (
    <div className="flex flex-col">
      <EmptyState
        icon={CalendarClock}
        size="md"
        decorated
        title="No automations yet"
        description="Tasks Hola runs for you automatically, on a schedule."
        action={
          <div className="text-sm">
            <button
              type="button"
              onClick={onCreateWithHola}
              className="font-medium text-primary hover:underline"
            >
              Create with Hola
            </button>
            <span className="text-muted-foreground"> or </span>
            <button
              type="button"
              onClick={onSetUpManually}
              disabled={manualDisabled}
              className="font-medium text-primary hover:underline disabled:pointer-events-none disabled:opacity-50"
            >
              set up manually
            </button>
          </div>
        }
      />
      <ExamplesGallery
        heading="Start from an example"
        onUseExample={onUseExample}
      />
    </div>
  );
}

const EXAMPLE_STYLES: Record<string, { icon: IconType; tile: string }> = {
  "morning-briefing": {
    icon: Inbox,
    tile: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
  "content-ideas": {
    icon: Lightbulb,
    tile: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  "news-watch": {
    icon: Globe,
    tile: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  "meeting-prep": {
    icon: CalendarClock,
    tile: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  },
};

const EXAMPLE_STYLE_FALLBACK = {
  icon: Sparkles,
  tile: "bg-muted text-muted-foreground",
};

function ExamplesGallery({
  heading,
  onUseExample,
}: {
  heading: string;
  onUseExample: (example: AutomationExample) => void;
}) {
  return (
    <div className="px-6 pt-2 pb-8">
      <div className="px-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {heading}
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {AUTOMATION_EXAMPLES.map((example) => {
          const { icon: Icon, tile } =
            EXAMPLE_STYLES[example.id] ?? EXAMPLE_STYLE_FALLBACK;
          return (
            <button
              key={example.id}
              type="button"
              onClick={() => onUseExample(example)}
              className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-accent"
            >
              <span
                className={cn(
                  "grid size-9 shrink-0 place-items-center rounded-lg",
                  tile,
                )}
              >
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {example.name}
                </span>
                <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                  {example.benefit}
                </span>
                <span className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground/70">
                  <Clock3 className="size-3" />
                  {example.scheduleHint}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SkeletonGrid() {
  const rows = ["w-32", "w-44", "w-36", "w-40"];
  return (
    <ul
      role="status"
      aria-busy="true"
      aria-label="Loading automations"
      className="grid gap-3 px-6 py-3 sm:grid-cols-2"
    >
      {rows.map((titleW, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list
        <li
          key={index}
          className="flex flex-col gap-2.5 rounded-xl border border-border bg-card px-4 py-3.5"
        >
          <div className={`h-3.5 ${titleW} animate-pulse rounded bg-fg-8`} />
          <div className="h-2.5 w-full animate-pulse rounded bg-fg-6" />
          <div className="h-5 w-32 animate-pulse rounded-full bg-fg-6" />
        </li>
      ))}
    </ul>
  );
}
