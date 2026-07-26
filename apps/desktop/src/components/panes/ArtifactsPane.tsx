import { useAtomValue, useSetAtom } from "jotai";
import { listDisplayOutputs } from "@/lib/outputs";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  FilePlus,
  Filter,
  Folder,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  Star,
  Trash2,
  X,
} from "@/components/ui/icons";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  OutputArtifactIcon,
  dedupeOutputsForDisplay,
  outputDisplayTitle,
  outputKindLabel,
  sortOutputsLatestFirst,
} from "@/components/panes/ChatPane/ArtifactBrowserModal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { ArtifactTemplatePicker } from "@/components/panes/ArtifactTemplatePicker";
import {
  favoriteKey,
  isFavoriteAtom,
  toggleFavoriteAtom,
} from "@/components/layout/shell/state/favorites";
import { useWorkspaceOutputFolders } from "@/components/layout/shell/useWorkspaceLists";
import { FileTypeIcon } from "@/lib/fileIcon";
import { cn } from "@/lib/utils";
import { toolkitDisplayName } from "@/lib/toolkitDisplay";

/**
 * Workspace-scoped artifact browser, rendered as a full agent-pane
 * (`agentView.type === "artifacts"`). Sibling to Sessions / Inbox /
 * other workspace surfaces — same chrome, same back-to-chat affordance. Replaces
 * the modal-style ChatHeader entry; lets users browse every output
 * produced in the workspace without losing the chat composer state
 * (the chat pane is unmounted while this is open).
 *
 * Reply-scoped browsing (per assistant turn) still uses
 * ArtifactBrowserModal — that path is anchored to a specific
 * message and stays a transient overlay.
 */

const UNCATEGORIZED_FOLDER_KEY = "__uncategorized__";
// Pull a generous page so client-side search/filter operates on the whole
// library in the common case; server-side search backfills anything past it.
const OUTPUT_PAGE_LIMIT = 500;
const SEARCH_DEBOUNCE_MS = 250;

const TIME_BUCKET_ORDER = [
  "Today",
  "Yesterday",
  "This week",
  "Earlier",
] as const;
type TimeBucket = (typeof TIME_BUCKET_ORDER)[number];

// Source facet: which app produced it, or the agent for non-app outputs.
function outputSourceKey(output: WorkspaceOutputRecordPayload): string {
  const moduleId = (output.module_id ?? "").trim();
  return moduleId ? `app:${moduleId}` : "agent";
}

function outputSourceLabel(output: WorkspaceOutputRecordPayload): string {
  const moduleId = (output.module_id ?? "").trim();
  return moduleId ? toolkitDisplayName(moduleId) : "Agent";
}

function outputIsApp(output: WorkspaceOutputRecordPayload): boolean {
  return Boolean((output.module_id ?? "").trim());
}

function outputStatusValue(output: WorkspaceOutputRecordPayload): string {
  return (output.status ?? "").trim();
}

function titleCaseStatus(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function outputTimestamp(output: WorkspaceOutputRecordPayload): number {
  const parsed = Date.parse(output.updated_at || output.created_at || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function relativeArtifactTime(output: WorkspaceOutputRecordPayload): string {
  const ts = outputTimestamp(output);
  if (!ts) return "";
  const min = Math.floor(Math.max(0, Date.now() - ts) / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function artifactTimeBucket(output: WorkspaceOutputRecordPayload): TimeBucket {
  const ts = outputTimestamp(output);
  if (!ts) return "Earlier";
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  if (ts >= startOfToday) return "Today";
  if (ts >= startOfToday - 86_400_000) return "Yesterday";
  if (ts >= startOfToday - 6 * 86_400_000) return "This week";
  return "Earlier";
}

function bucketOutputsByTime(
  outputs: WorkspaceOutputRecordPayload[],
): Array<{ label: TimeBucket; items: WorkspaceOutputRecordPayload[] }> {
  const buckets = new Map<TimeBucket, WorkspaceOutputRecordPayload[]>();
  for (const output of outputs) {
    const bucket = artifactTimeBucket(output);
    const existing = buckets.get(bucket);
    if (existing) existing.push(output);
    else buckets.set(bucket, [output]);
  }
  return TIME_BUCKET_ORDER.filter((bucket) => buckets.has(bucket)).map(
    (bucket) => ({ label: bucket, items: buckets.get(bucket) ?? [] }),
  );
}

interface AppOutputGroup {
  key: string;
  label: string;
  items: WorkspaceOutputRecordPayload[];
  ts: number;
}

function groupOutputsByApp(
  outputs: WorkspaceOutputRecordPayload[],
): AppOutputGroup[] {
  const groups = new Map<string, AppOutputGroup>();
  for (const output of outputs) {
    const key = outputSourceKey(output);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: outputSourceLabel(output), items: [], ts: 0 };
      groups.set(key, group);
    }
    group.items.push(output);
    group.ts = Math.max(group.ts, outputTimestamp(output));
  }
  return [...groups.values()].sort((a, b) => b.ts - a.ts);
}

/** Strip a content snippet from the output's HTML; when a query is given,
 *  centre the window on the first match so the matched text is visible. */
function outputPlainSnippet(
  output: WorkspaceOutputRecordPayload,
  query: string,
): string {
  const html = output.html_content;
  if (!html) return "";
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  const q = query.trim();
  if (q) {
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx > 56) {
      const start = idx - 48;
      const slice = text.slice(start, start + 160);
      return `…${slice}${start + 160 < text.length ? "…" : ""}`;
    }
  }
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  while (cursor < text.length) {
    const idx = lower.indexOf(lowerQ, cursor);
    if (idx === -1) {
      parts.push(text.slice(cursor));
      break;
    }
    if (idx > cursor) parts.push(text.slice(cursor, idx));
    parts.push(
      <mark
        className="rounded-[3px] bg-primary/20 text-foreground"
        key={`m-${key}`}
      >
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    key += 1;
    cursor = idx + q.length;
  }
  return <>{parts}</>;
}

interface ArtifactsPaneProps {
  workspaceId: string | null;
  onOpenOutput?: (output: WorkspaceOutputRecordPayload) => void;
  emptyWorkspaceMessage?: string;
  defaultSessionId?: string | null;
}

export function ArtifactsPane({
  workspaceId,
  onOpenOutput,
  emptyWorkspaceMessage = "Choose a workspace from the top bar to view its artifacts.",
  defaultSessionId = null,
}: ArtifactsPaneProps) {
  const [outputs, setOutputs] = useState<WorkspaceOutputRecordPayload[]>([]);
  const [searchResults, setSearchResults] = useState<
    WorkspaceOutputRecordPayload[]
  >([]);
  const [sourceFilters, setSourceFilters] = useState<Set<string>>(
    () => new Set(),
  );
  const [statusFilters, setStatusFilters] = useState<Set<string>>(
    () => new Set(),
  );
  const [starredOnly, setStarredOnly] = useState(false);
  const [recentOnly, setRecentOnly] = useState(false);
  const isFavoriteFn = useAtomValue(isFavoriteAtom);
  const toggleFilterValue = useCallback(
    (setter: Dispatch<SetStateAction<Set<string>>>, value: string) => {
      setter((prev) => {
        const next = new Set(prev);
        if (next.has(value)) {
          next.delete(value);
        } else {
          next.add(value);
        }
        return next;
      });
    },
    [],
  );
  const [groupBy, setGroupBy] = useState<"recent" | "session">("recent");
  const [sessionScopeId, setSessionScopeId] = useState<string | null>(
    () => defaultSessionId?.trim() || null,
  );
  const [expandedAppGroupIds, setExpandedAppGroupIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [collapsedSessionIds, setCollapsedSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [mainSessions, setMainSessions] = useState<MainSessionRecordPayload[]>(
    [],
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] =
    useState<WorkspaceOutputRecordPayload | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const didAutoScopeRef = useRef(false);
  const folders = useWorkspaceOutputFolders(workspaceId);

  const reload = useCallback(async (): Promise<void> => {
    if (!workspaceId) {
      setOutputs([]);
      return;
    }
    const result = await listDisplayOutputs({
      limit: OUTPUT_PAGE_LIMIT,
    });
    setOutputs(result.items ?? []);
    setErrorMessage("");
  }, [workspaceId]);

  // Refetch on mount and window focus — event-driven, no polling interval.
  useEffect(() => {
    if (!workspaceId) {
      setOutputs([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErrorMessage("");
    reload()
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrorMessage(
          error instanceof Error ? error.message : "Failed to load artifacts.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    const onFocus = () => {
      void reload().catch(() => {
        // Focus refreshes are best-effort; keep the last good list on error.
      });
    };
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [workspaceId, reload]);

  // Reset folder view + facets when the workspace changes so we never strand
  // the user inside a folder or filter that belongs to a different workspace.
  useEffect(() => {
    setActiveFolderId(null);
    setSourceFilters(new Set());
    setStatusFilters(new Set());
    setStarredOnly(false);
    setRecentOnly(false);
    setGroupBy("recent");
    setCollapsedSessionIds(new Set());
    didAutoScopeRef.current = false;
  }, [workspaceId]);

  // Re-scope to the active chat whenever the user switches sessions.
  useEffect(() => {
    setSessionScopeId(defaultSessionId?.trim() || null);
  }, [defaultSessionId]);

  // Opening Outputs is most useful scoped to what you're working on now. When
  // the caller didn't pass an explicit session, default the scope to the
  // workspace's active main session once it loads. One-shot — clearing the
  // "This chat" chip to browse everything must stick.
  useEffect(() => {
    if (didAutoScopeRef.current) return;
    if (defaultSessionId?.trim()) {
      didAutoScopeRef.current = true;
      return;
    }
    const active = mainSessions.find((session) => session.is_active);
    if (active) {
      didAutoScopeRef.current = true;
      setSessionScopeId(active.session_id);
    }
  }, [defaultSessionId, mainSessions]);

  // Session titles for the "Group by session" view; id → display title.
  useEffect(() => {
    const id = workspaceId?.trim();
    if (!id) {
      setMainSessions([]);
      return;
    }
    let cancelled = false;
    window.electronAPI.workspace
      .listMainSessions(id)
      .then((response) => {
        if (!cancelled) setMainSessions(response.sessions ?? []);
      })
      .catch(() => {
        if (!cancelled) setMainSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const isSearching = normalizedSearchQuery.length > 0;

  // Debounced server-side search backfills hits past the loaded page.
  useEffect(() => {
    if (!workspaceId || !isSearching) {
      setSearchResults([]);
      return;
    }
    let cancelled = false;
    const query = searchQuery.trim();
    const handle = window.setTimeout(() => {
      window.electronAPI.workspace
        .searchOutputs({ workspaceId, query, limit: 50 })
        .then((response) => {
          if (cancelled) return;
          setSearchResults((response.results ?? []).map((r) => r.output));
        })
        .catch(() => {
          if (!cancelled) setSearchResults([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [workspaceId, isSearching, searchQuery]);

  const handleManualRefresh = useCallback(() => {
    setRefreshing(true);
    void reload()
      .catch((error: unknown) => {
        setErrorMessage(
          error instanceof Error ? error.message : "Failed to load artifacts.",
        );
      })
      .finally(() => setRefreshing(false));
  }, [reload]);

  const patchLocalOutput = useCallback(
    (outputId: string, patch: Partial<WorkspaceOutputRecordPayload>) => {
      setOutputs((prev) =>
        prev.map((o) => (o.id === outputId ? { ...o, ...patch } : o)),
      );
    },
    [],
  );

  const handleRename = useCallback(
    async (output: WorkspaceOutputRecordPayload, nextTitle: string) => {
      if (!workspaceId) return;
      const title = nextTitle.trim();
      if (!title || title === output.title) return;
      patchLocalOutput(output.id, { title });
      try {
        await window.electronAPI.workspace.updateOutput({
          workspaceId,
          outputId: output.id,
          title,
        });
      } catch (error) {
        toast.error("Couldn't rename artifact", {
          description:
            error instanceof Error ? error.message : "Please try again.",
        });
        void reload();
      }
    },
    [workspaceId, patchLocalOutput, reload],
  );

  const handleConfirmDelete = useCallback(async () => {
    const output = pendingDelete;
    setPendingDelete(null);
    if (!output || !workspaceId) return;
    setOutputs((prev) => prev.filter((o) => o.id !== output.id));
    try {
      await window.electronAPI.workspace.deleteOutput({
        workspaceId,
        outputId: output.id,
      });
    } catch (error) {
      toast.error("Couldn't delete artifact", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
      void reload();
    }
  }, [pendingDelete, workspaceId, reload]);

  const handleCreatedFromTemplate = useCallback(
    (output: WorkspaceOutputRecordPayload) => {
      setOutputs((prev) => [output, ...prev]);
      onOpenOutput?.(output);
      void reload();
    },
    [onOpenOutput, reload],
  );

  // When searching, fold server hits (beyond the loaded page) into the pool
  // so results aren't capped; otherwise just the loaded outputs.
  const pool = useMemo(() => {
    if (!isSearching || searchResults.length === 0) return outputs;
    const seen = new Set(outputs.map((o) => o.id));
    return [...outputs, ...searchResults.filter((o) => !seen.has(o.id))];
  }, [outputs, searchResults, isSearching]);

  const allDisplayOutputs = useMemo(
    () => dedupeOutputsForDisplay(pool),
    [pool],
  );
  const filteredOutputs = useMemo(() => {
    let result = allDisplayOutputs;
    if (sessionScopeId) {
      result = result.filter(
        (output) => output.session_id === sessionScopeId,
      );
    }
    if (sourceFilters.size > 0) {
      result = result.filter((output) =>
        sourceFilters.has(outputSourceKey(output)),
      );
    }
    if (statusFilters.size > 0) {
      result = result.filter((output) =>
        statusFilters.has(outputStatusValue(output)),
      );
    }
    if (starredOnly) {
      result = result.filter((output) =>
        isFavoriteFn(
          favoriteKey({
            kind: "output",
            workspaceId: workspaceId ?? "",
            outputId: output.id,
          }),
        ),
      );
    }
    if (recentOnly) {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      result = result.filter(
        (output) => Date.parse(output.updated_at) >= cutoff,
      );
    }
    if (normalizedSearchQuery) {
      result = result.filter((output) => {
        // Search the resolved display label, not just the raw title, so
        // outputs whose title fell back to a filename or summary still
        // match queries against that visible text.
        const title = outputDisplayTitle(output).toLowerCase();
        const kind = outputKindLabel(output).toLowerCase();
        return (
          title.includes(normalizedSearchQuery) ||
          kind.includes(normalizedSearchQuery)
        );
      });
    }
    return sortOutputsLatestFirst(result);
  }, [
    allDisplayOutputs,
    sessionScopeId,
    sourceFilters,
    statusFilters,
    starredOnly,
    recentOnly,
    isFavoriteFn,
    workspaceId,
    normalizedSearchQuery,
  ]);

  const sourceOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const output of allDisplayOutputs) {
      map.set(outputSourceKey(output), outputSourceLabel(output));
    }
    return [...map.entries()]
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [allDisplayOutputs]);
  const statusOptions = useMemo(() => {
    const set = new Set<string>();
    for (const output of allDisplayOutputs) {
      const status = outputStatusValue(output);
      if (status) set.add(status);
    }
    return [...set].sort();
  }, [allDisplayOutputs]);

  const sessionTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of mainSessions) {
      if (!session.session_id) continue;
      map.set(session.session_id, session.title?.trim() || "Untitled session");
    }
    return map;
  }, [mainSessions]);

  const SESSION_OTHER_KEY = "__session_other__";
  const sessionGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        id: string;
        label: string;
        items: WorkspaceOutputRecordPayload[];
        ts: number;
      }
    >();
    for (const output of filteredOutputs) {
      const sessionId = (output.session_id ?? "").trim();
      const key = sessionId || SESSION_OTHER_KEY;
      let group = groups.get(key);
      if (!group) {
        group = {
          id: key,
          label: sessionId
            ? (sessionTitleById.get(sessionId) ?? "Untitled session")
            : "Other",
          items: [],
          ts: 0,
        };
        groups.set(key, group);
      }
      group.items.push(output);
      group.ts = Math.max(group.ts, outputTimestamp(output));
    }
    return [...groups.values()].sort((a, b) => {
      // "Other" (session-less, e.g. app outputs) sinks to the bottom.
      if (a.id === SESSION_OTHER_KEY) return 1;
      if (b.id === SESSION_OTHER_KEY) return -1;
      return b.ts - a.ts;
    });
  }, [filteredOutputs, sessionTitleById]);

  const totalCount = useMemo(
    () => dedupeOutputsForDisplay(outputs).length,
    [outputs],
  );

  const activeSessionId =
    mainSessions.find((session) => session.is_active)?.session_id ?? null;
  const sessionScopeLabel = sessionScopeId
    ? sessionScopeId === activeSessionId
      ? "This chat"
      : (sessionTitleById.get(sessionScopeId) ?? "Session")
    : "All sessions";

  // Per-type counts over the search-filtered set (ignoring the active type
  // filter) so each chip shows how many match the current query.
  // `/` focuses search from anywhere in the pane (⌘K is the global search).
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      if (
        active?.tagName === "INPUT" ||
        active?.tagName === "TEXTAREA" ||
        active?.isContentEditable
      ) {
        return;
      }
      event.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const folderNamesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const folder of folders) {
      map.set(folder.id, folder.name || "Untitled folder");
    }
    return map;
  }, [folders]);

  // Reset back to the root when the active folder disappears (e.g. server
  // deletion mid-session) — otherwise we'd render a phantom empty view.
  useEffect(() => {
    if (!activeFolderId || activeFolderId === UNCATEGORIZED_FOLDER_KEY) return;
    if (!folderNamesById.has(activeFolderId)) {
      setActiveFolderId(null);
    }
  }, [activeFolderId, folderNamesById]);

  // Per-folder counts driven by the current filter so the root view
  // mirrors what the user will actually find on drill-in.
  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    let uncategorized = 0;
    for (const output of filteredOutputs) {
      if (output.folder_id) {
        counts.set(output.folder_id, (counts.get(output.folder_id) ?? 0) + 1);
      } else {
        uncategorized += 1;
      }
    }
    return { counts, uncategorized };
  }, [filteredOutputs]);

  const sortedFolders = useMemo(() => {
    return [...folders].sort(
      (left, right) =>
        (left.position ?? Number.POSITIVE_INFINITY) -
        (right.position ?? Number.POSITIVE_INFINITY),
    );
  }, [folders]);

  const folderRows = useMemo(
    () =>
      sortedFolders
        .map((folder) => ({
          id: folder.id,
          name: folder.name || "Untitled folder",
          count: folderCounts.counts.get(folder.id) ?? 0,
        }))
        // Hide folders whose contents are filtered out so the root view
        // doesn't dangle empty rows during an active filter/search.
        .filter((row) => row.count > 0),
    [sortedFolders, folderCounts],
  );

  const uncategorizedItems = useMemo(
    () => filteredOutputs.filter((output) => !output.folder_id),
    [filteredOutputs],
  );

  const folderScopedItems = useMemo(() => {
    if (!activeFolderId) return [];
    if (activeFolderId === UNCATEGORIZED_FOLDER_KEY) return uncategorizedItems;
    return filteredOutputs.filter(
      (output) => output.folder_id === activeFolderId,
    );
  }, [activeFolderId, filteredOutputs, uncategorizedItems]);

  if (!workspaceId) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6">
        <EmptyState
          icon={Boxes}
          title="No workspace selected"
          description={emptyWorkspaceMessage}
          size="md"
        />
      </div>
    );
  }

  const isAtRoot = activeFolderId === null;
  const activeFolderName = isAtRoot
    ? null
    : activeFolderId === UNCATEGORIZED_FOLDER_KEY
      ? "Uncategorized"
      : (folderNamesById.get(activeFolderId) ?? "Untitled folder");
  // Session grouping is its own browse mode — bypass the folder tree and
  // time bands. Search always flattens regardless of mode.
  const sessionMode = groupBy === "session" && !isSearching;
  // Searching across folders flattens the tree — folders are a
  // navigation aid, not a filter, so a query should hit everything.
  const showFolderTree =
    !sessionMode && isAtRoot && !isSearching && folderRows.length > 0;
  const visibleOutputs = isAtRoot
    ? isSearching
      ? filteredOutputs
      : uncategorizedItems
    : folderScopedItems;
  // At the root browse view, app-produced files are pulled out of the time
  // bands and tucked into their own collapsed group per app — agent outputs
  // stay foregrounded. Session/search modes keep everything flat.
  const appGroupingActive = isAtRoot && !sessionMode && !isSearching;
  const browseAgentOutputs = appGroupingActive
    ? visibleOutputs.filter((output) => !outputIsApp(output))
    : visibleOutputs;
  const browseAppGroups = appGroupingActive
    ? groupOutputsByApp(visibleOutputs.filter(outputIsApp))
    : [];
  // Browse: group by recency. Search: flat, ranked latest-first — time bands
  // would just fragment a handful of hits.
  const groupedVisibleOutputs = isSearching
    ? null
    : bucketOutputsByTime(browseAgentOutputs);

  const renderArtifactRow = (output: WorkspaceOutputRecordPayload) => (
    <ArtifactRow
      key={output.id}
      output={output}
      query={searchQuery}
      onOpen={onOpenOutput}
      workspaceId={workspaceId}
      onRename={handleRename}
      onRequestDelete={setPendingDelete}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {totalCount > 0 ? (
        <>
          {activeFolderName ? (
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 sm:px-5">
              <button
                type="button"
                onClick={() => setActiveFolderId(null)}
                aria-label="Back to all artifacts"
                className="grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground"
              >
                <ArrowLeft className="size-3.5" />
              </button>
              <div className="min-w-0 flex items-center gap-1.5 text-xs">
                <button
                  type="button"
                  onClick={() => setActiveFolderId(null)}
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  All artifacts
                </button>
                <ChevronRight className="size-3 text-muted-foreground/50" />
                <span className="truncate text-foreground font-medium">
                  {activeFolderName}
                </span>
              </div>
            </div>
          ) : null}
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 sm:px-5">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={
                  activeFolderName
                    ? `Search in ${activeFolderName}`
                    : "Search artifacts"
                }
                aria-label="Search artifacts"
                className="embedded-input h-8 rounded-md pl-8 pr-8 text-xs focus-visible:ring-0"
              />
              {isSearching ? (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery("");
                    searchInputRef.current?.focus();
                  }}
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              ) : null}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    aria-label="Filter by session"
                    className={cn(
                      "flex h-8 shrink-0 items-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors hover:bg-fg-6",
                      sessionScopeId ? "text-foreground" : "text-muted-foreground",
                    )}
                    title="Filter by session"
                    type="button"
                  >
                    <span className="max-w-32 truncate">{sessionScopeLabel}</span>
                    <ChevronDown className="size-3 shrink-0" />
                  </button>
                }
              />
              <DropdownMenuContent
                align="end"
                className="max-h-72 min-w-64 overflow-y-auto"
              >
                <DropdownMenuItem
                  className="gap-2"
                  onClick={() => setSessionScopeId(null)}
                >
                  <span className="grid size-3.5 shrink-0 place-items-center">
                    {sessionScopeId ? null : <Check className="size-3.5" />}
                  </span>
                  All sessions
                </DropdownMenuItem>
                {mainSessions.length > 0 ? <DropdownMenuSeparator /> : null}
                {mainSessions.map((session) => (
                  <DropdownMenuItem
                    className="gap-2"
                    key={session.session_id}
                    onClick={() => setSessionScopeId(session.session_id)}
                  >
                    <span className="grid size-3.5 shrink-0 place-items-center">
                      {sessionScopeId === session.session_id ? (
                        <Check className="size-3.5" />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {session.title?.trim() || "Untitled session"}
                    </span>
                    {session.is_active ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        current
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    aria-label="Filter"
                    className={cn(
                      "grid size-8 shrink-0 place-items-center rounded-md transition-colors hover:bg-fg-6 hover:text-foreground",
                      starredOnly ||
                        recentOnly ||
                        sourceFilters.size > 0 ||
                        statusFilters.size > 0
                        ? "text-foreground"
                        : "text-muted-foreground",
                    )}
                    title="Filter"
                    type="button"
                  >
                    <Filter className="size-3.5" />
                  </button>
                }
              />
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuCheckboxItem
                  checked={starredOnly}
                  onCheckedChange={(checked) => setStarredOnly(checked === true)}
                >
                  Starred
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={recentOnly}
                  onCheckedChange={(checked) => setRecentOnly(checked === true)}
                >
                  Last 7 days
                </DropdownMenuCheckboxItem>
                {sourceOptions.length > 0 || statusOptions.length > 0 ? (
                  <DropdownMenuSeparator />
                ) : null}
                {sourceOptions.length > 0 ? (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Source</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="min-w-44">
                      {sourceOptions.map((option) => (
                        <DropdownMenuCheckboxItem
                          checked={sourceFilters.has(option.key)}
                          key={option.key}
                          onCheckedChange={() =>
                            toggleFilterValue(setSourceFilters, option.key)
                          }
                        >
                          <span className="truncate">{option.label}</span>
                        </DropdownMenuCheckboxItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ) : null}
                {statusOptions.length > 0 ? (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Status</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="min-w-44">
                      {statusOptions.map((status) => (
                        <DropdownMenuCheckboxItem
                          checked={statusFilters.has(status)}
                          key={status}
                          onCheckedChange={() =>
                            toggleFilterValue(setStatusFilters, status)
                          }
                        >
                          <span className="truncate">
                            {titleCaseStatus(status)}
                          </span>
                        </DropdownMenuCheckboxItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              onClick={() => setTemplatePickerOpen(true)}
              aria-label="New from template"
              title="New from template"
              className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground"
            >
              <FilePlus className="size-3.5" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={handleManualRefresh}
              disabled={refreshing}
              aria-label="Refresh artifacts"
              title="Refresh"
              className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground disabled:opacity-60"
            >
              {refreshing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
            </button>
          </div>
          {sessionScopeId ||
          sourceFilters.size > 0 ||
          statusFilters.size > 0 ||
          starredOnly ||
          recentOnly ? (
            <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-4 py-1.5 sm:px-5">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                <AnimatePresence initial={false}>
                  {sessionScopeId ? (
                    <FilterPill
                      key="session-scope"
                      label={sessionScopeLabel}
                      onRemove={() => setSessionScopeId(null)}
                    />
                  ) : null}
                  {starredOnly ? (
                    <FilterPill
                      key="starred"
                      label="Starred"
                      onRemove={() => setStarredOnly(false)}
                    />
                  ) : null}
                  {recentOnly ? (
                    <FilterPill
                      key="recent"
                      label="Last 7 days"
                      onRemove={() => setRecentOnly(false)}
                    />
                  ) : null}
                  {[...sourceFilters].map((key) => (
                    <FilterPill
                      key={`source-${key}`}
                      label={`Source: ${
                        sourceOptions.find((s) => s.key === key)?.label ?? key
                      }`}
                      onRemove={() => toggleFilterValue(setSourceFilters, key)}
                    />
                  ))}
                  {[...statusFilters].map((status) => (
                    <FilterPill
                      key={`status-${status}`}
                      label={`Status: ${titleCaseStatus(status)}`}
                      onRemove={() =>
                        toggleFilterValue(setStatusFilters, status)
                      }
                    />
                  ))}
                </AnimatePresence>
              </div>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {filteredOutputs.length}
                {filteredOutputs.length === 1 ? " result" : " results"}
              </span>
              <button
                type="button"
                onClick={() => {
                  setSessionScopeId(null);
                  setSourceFilters(new Set());
                  setStatusFilters(new Set());
                  setStarredOnly(false);
                  setRecentOnly(false);
                }}
                className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground"
              >
                Clear
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5">
        {loading && totalCount === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            Loading artifacts…
          </div>
        ) : errorMessage ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              icon={Boxes}
              title="Couldn't load artifacts"
              description={errorMessage}
              size="md"
            />
          </div>
        ) : totalCount === 0 ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              icon={Boxes}
              title="No artifacts yet"
              description="Files, images, code, and links produced in this workspace will collect here."
              size="md"
              decorated
              action={
                <button
                  type="button"
                  onClick={() => setTemplatePickerOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-fg-6 hover:text-foreground"
                >
                  <FilePlus className="size-3.5" strokeWidth={1.75} />
                  New from template
                </button>
              }
            />
          </div>
        ) : (
            sessionMode
              ? sessionGroups.length === 0
              : !showFolderTree && visibleOutputs.length === 0
          ) ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {isSearching
              ? `No artifacts match "${searchQuery.trim()}".`
              : activeFolderName
                ? `${activeFolderName} is empty.`
                : "No artifacts match this filter."}
          </div>
        ) : sessionMode ? (
          <div className="-mx-1 flex flex-col">
            {sessionGroups.map((group) => {
              const collapsed = collapsedSessionIds.has(group.id);
              return (
                <div key={group.id}>
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsedSessionIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(group.id)) {
                          next.delete(group.id);
                        } else {
                          next.add(group.id);
                        }
                        return next;
                      })
                    }
                    className="mt-1.5 mb-0.5 flex w-full items-center gap-1.5 px-2 pt-1 text-left first:mt-0"
                  >
                    <ChevronRight
                      className={cn(
                        "size-3 shrink-0 text-muted-foreground/50 transition-transform",
                        !collapsed && "rotate-90",
                      )}
                      strokeWidth={1.75}
                    />
                    <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground/55">
                      {group.label}
                    </span>
                    <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/40">
                      {group.items.length}
                    </span>
                  </button>
                  {collapsed ? null : group.items.map(renderArtifactRow)}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="-mx-1 flex flex-col">
            {showFolderTree
              ? folderRows.map((row) => (
                  <FolderRow
                    key={row.id}
                    name={row.name}
                    count={row.count}
                    onOpen={() => setActiveFolderId(row.id)}
                  />
                ))
              : null}
            {showFolderTree && uncategorizedItems.length > 0 ? (
              <div className="mt-1 mb-1 px-2 pt-2 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground/60">
                Uncategorized
              </div>
            ) : null}
            {groupedVisibleOutputs
              ? groupedVisibleOutputs.map((group) => (
                  <div key={group.label}>
                    <div className="mt-1.5 mb-0.5 px-2 pt-1 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground/55 first:mt-0">
                      {group.label}
                    </div>
                    {group.items.map(renderArtifactRow)}
                  </div>
                ))
              : visibleOutputs.map(renderArtifactRow)}
            {browseAppGroups.length > 0 ? (
              <div className="mt-2 border-t border-border/50 pt-1">
                {browseAppGroups.map((group) => {
                  const expanded = expandedAppGroupIds.has(group.key);
                  return (
                    <div key={group.key}>
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedAppGroupIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(group.key)) {
                              next.delete(group.key);
                            } else {
                              next.add(group.key);
                            }
                            return next;
                          })
                        }
                        className="mt-1.5 mb-0.5 flex w-full items-center gap-1.5 px-2 pt-1 text-left first:mt-0"
                      >
                        <ChevronRight
                          className={cn(
                            "size-3 shrink-0 text-muted-foreground/50 transition-transform",
                            expanded && "rotate-90",
                          )}
                          strokeWidth={1.75}
                        />
                        <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground/55">
                          {group.label}
                        </span>
                        <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/40">
                          {group.items.length}
                        </span>
                      </button>
                      {expanded ? group.items.map(renderArtifactRow) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete this artifact?"
        description={
          pendingDelete
            ? `"${outputDisplayTitle(pendingDelete)}" will be removed from this workspace. This can't be undone.`
            : ""
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => void handleConfirmDelete()}
      />

      <ArtifactTemplatePicker
        workspaceId={workspaceId}
        open={templatePickerOpen}
        onOpenChange={setTemplatePickerOpen}
        onCreated={handleCreatedFromTemplate}
      />
    </div>
  );
}

function FilterPill({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <motion.span
      layout
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8 }}
      transition={{ type: "spring", stiffness: 520, damping: 34 }}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-fg-6 py-0.5 pl-2.5 pr-1 text-xs font-medium text-foreground"
    >
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className="grid size-4 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
      >
        <X className="size-2.5" strokeWidth={2} />
      </button>
    </motion.span>
  );
}

function FolderRow({
  name,
  count,
  onOpen,
}: {
  name: string;
  count: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-9 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-foreground/[0.04]"
    >
      <Folder
        className="size-4 shrink-0 text-muted-foreground/80"
        strokeWidth={1.75}
      />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {name}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground/70">{count}</span>
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" />
    </button>
  );
}

// File-backed artifacts use the same extension-based icon set as the sidebar
// (FileTypeIcon); module/app outputs (no file) keep the output-type icon.
function ArtifactRowIcon({
  output,
}: {
  output: WorkspaceOutputRecordPayload;
}) {
  const filePath = output.file_path?.trim();
  if (filePath) {
    return <FileTypeIcon filePath={filePath} size={16} className="shrink-0" />;
  }
  return <OutputArtifactIcon output={output} variant="bare" />;
}

function ArtifactRow({
  output,
  query,
  onOpen,
  workspaceId,
  onRename,
  onRequestDelete,
}: {
  output: WorkspaceOutputRecordPayload;
  query: string;
  onOpen: ((output: WorkspaceOutputRecordPayload) => void) | undefined;
  workspaceId: string;
  onRename: (
    output: WorkspaceOutputRecordPayload,
    nextTitle: string,
  ) => void | Promise<void>;
  onRequestDelete: (output: WorkspaceOutputRecordPayload) => void;
}) {
  const title = outputDisplayTitle(output);
  const snippet = outputPlainSnippet(output, query);
  const toggleFavorite = useSetAtom(toggleFavoriteAtom);
  const isFavoriteFn = useAtomValue(isFavoriteAtom);
  const favKey = favoriteKey({
    kind: "output",
    workspaceId,
    outputId: output.id,
  });
  const starred = isFavoriteFn(favKey);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title);
  const [menuOpen, setMenuOpen] = useState(false);

  const handleToggleStar = (event: React.MouseEvent) => {
    event.stopPropagation();
    toggleFavorite({
      kind: "output",
      workspaceId,
      outputId: output.id,
      title,
      filePath: output.file_path,
    });
  };

  const beginRename = () => {
    setDraft(title);
    setRenaming(true);
  };

  const commitRename = () => {
    setRenaming(false);
    void onRename(output, draft);
  };

  if (renaming) {
    return (
      <div className="flex h-9 items-center gap-2.5 rounded-md px-2">
        <ArtifactRowIcon output={output} />
        <Input
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitRename();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setRenaming(false);
            }
          }}
          aria-label="Rename artifact"
          className="embedded-input h-7 flex-1 rounded-md px-2 text-sm focus-visible:ring-1"
        />
      </div>
    );
  }

  return (
    <div
      role={onOpen ? "button" : "group"}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen ? () => onOpen(output) : undefined}
      onKeyDown={
        onOpen
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(output);
              }
            }
          : undefined
      }
      className={cn(
        "group/artifact relative flex items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-foreground/[0.04]",
        onOpen && "cursor-pointer",
      )}
    >
      <span className="mt-px shrink-0 text-muted-foreground">
        <ArtifactRowIcon output={output} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 shrink truncate text-left text-sm text-foreground">
            {title}
          </span>
          <div className="relative ml-auto flex shrink-0 items-center justify-end">
            <div
              className={cn(
                "flex items-center gap-1 transition-opacity duration-snappy ease-out group-hover/artifact:opacity-0",
                menuOpen && "opacity-0",
              )}
            >
              <span className="text-[11px] leading-none tabular-nums text-muted-foreground/55">
                {relativeArtifactTime(output)}
              </span>
              {starred ? (
                <Star
                  className="size-3.5 shrink-0 fill-current text-foreground/70"
                  strokeWidth={1.75}
                />
              ) : null}
            </div>
            <div
              className={cn(
                "absolute inset-y-0 right-0 flex items-center gap-0.5 opacity-0 transition-opacity duration-snappy ease-out group-hover/artifact:opacity-100 focus-within:opacity-100",
                menuOpen && "opacity-100",
              )}
            >
              <button
                type="button"
                aria-label={
                  starred ? "Remove from favorites" : "Add to favorites"
                }
                title={starred ? "Remove from favorites" : "Add to favorites"}
                onClick={handleToggleStar}
                className="grid size-5 shrink-0 place-items-center rounded text-foreground/55 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
              >
                <Star
                  className={cn("size-3.5", starred && "fill-current")}
                  strokeWidth={1.75}
                />
              </button>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Artifact actions"
                  onClick={(event) => event.stopPropagation()}
                  className="grid size-5 shrink-0 place-items-center rounded text-foreground/55 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                >
                  <MoreHorizontal className="size-3.5" strokeWidth={1.75} />
                </button>
              }
            />
            <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem onClick={beginRename} className="gap-2">
            <Pencil className="size-3.5" strokeWidth={1.75} />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => onRequestDelete(output)}
            className="gap-2 text-destructive data-[highlighted]:text-destructive"
          >
            <Trash2 className="size-3.5" strokeWidth={1.75} />
            Delete
          </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
            </div>
          </div>
        </div>
        {snippet ? (
          <span className="mt-0.5 block w-full truncate text-left text-xs text-muted-foreground/80">
            <HighlightedText query={query} text={snippet} />
          </span>
        ) : null}
      </div>
    </div>
  );
}
