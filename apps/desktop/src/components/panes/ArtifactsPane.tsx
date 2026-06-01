import { useAtomValue, useSetAtom } from "jotai";
import { Boxes, Search, Star, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  OutputArtifactIcon,
  OutputChangeBadge,
  dedupeOutputsForDisplay,
  outputBrowserFilterForOutput,
  outputDisplayTitle,
  outputKindLabel,
  sortOutputsLatestFirst,
} from "@/components/panes/ChatPane/ArtifactBrowserModal";
import type { ArtifactBrowserFilter } from "@/components/panes/ChatPane/types";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import {
  favoriteKey,
  isFavoriteAtom,
  toggleFavoriteAtom,
} from "@/components/layout/shell/state/favorites";
import { cn } from "@/lib/utils";

/**
 * Workspace-scoped artifact browser, rendered as a full agent-pane
 * (`agentView.type === "artifacts"`). Sibling to Sessions / Inbox /
 * Automations — same chrome, same back-to-chat affordance. Replaces
 * the modal-style ChatHeader entry; lets users browse every output
 * produced in the workspace without losing the chat composer state
 * (the chat pane is unmounted while this is open).
 *
 * Reply-scoped browsing (per assistant turn) still uses
 * ArtifactBrowserModal — that path is anchored to a specific
 * message and stays a transient overlay.
 */

const FILTER_OPTIONS: ReadonlyArray<{
  id: ArtifactBrowserFilter;
  label: string;
}> = [
  { id: "all", label: "All" },
  { id: "documents", label: "Documents" },
  { id: "images", label: "Images" },
  { id: "code", label: "Code" },
  { id: "links", label: "Links" },
  { id: "apps", label: "Apps" },
];

interface ArtifactsPaneProps {
  workspaceId: string | null;
  onOpenOutput?: (output: WorkspaceOutputRecordPayload) => void;
  emptyWorkspaceMessage?: string;
}

export function ArtifactsPane({
  workspaceId,
  onOpenOutput,
  emptyWorkspaceMessage = "Choose a workspace from the top bar to view its artifacts.",
}: ArtifactsPaneProps) {
  const [outputs, setOutputs] = useState<WorkspaceOutputRecordPayload[]>([]);
  const [filter, setFilter] = useState<ArtifactBrowserFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setOutputs([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErrorMessage("");
    window.electronAPI.workspace
      .listOutputs({ workspaceId, limit: 200 })
      .then((result) => {
        if (cancelled) return;
        setOutputs(result.items ?? []);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrorMessage(
          error instanceof Error ? error.message : "Failed to load artifacts.",
        );
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const allDisplayOutputs = useMemo(
    () => dedupeOutputsForDisplay(outputs),
    [outputs],
  );
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const filteredOutputs = useMemo(() => {
    let result =
      filter === "all"
        ? allDisplayOutputs
        : allDisplayOutputs.filter(
            (output) => outputBrowserFilterForOutput(output) === filter,
          );
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
  }, [allDisplayOutputs, filter, normalizedSearchQuery]);
  const totalCount = allDisplayOutputs.length;
  const isSearching = normalizedSearchQuery.length > 0;
  const groupedOutputs = useMemo(
    () => groupOutputsByTime(filteredOutputs),
    [filteredOutputs],
  );

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

  return (
    <div className="flex h-full min-h-0 flex-col">
      {totalCount > 0 ? (
        <>
          <div className="shrink-0 border-b border-border px-4 py-2 sm:px-5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search artifacts"
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
          </div>
          <div className="flex shrink-0 flex-wrap gap-1 border-b border-border px-4 py-2 sm:px-5">
            {FILTER_OPTIONS.map((option) => {
              const active = filter === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setFilter(option.id)}
                  className={cn(
                    "rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
                    active
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:bg-fg-6 hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
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
            />
          </div>
        ) : filteredOutputs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {isSearching
              ? `No artifacts match "${searchQuery.trim()}".`
              : "No artifacts match this filter."}
          </div>
        ) : (
          <div className="-mx-1 flex flex-col gap-3">
            {groupedOutputs.map((group) => (
              <div key={group.label} className="flex flex-col">
                <div className="px-2 pt-1 pb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                  {group.label}
                </div>
                {group.items.map((output) => (
                  <ArtifactRow
                    key={output.id}
                    output={output}
                    onOpen={onOpenOutput}
                    workspaceId={workspaceId}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ArtifactRow({
  output,
  onOpen,
  workspaceId,
}: {
  output: WorkspaceOutputRecordPayload;
  onOpen: ((output: WorkspaceOutputRecordPayload) => void) | undefined;
  workspaceId: string;
}) {
  const kindLabel = outputKindLabel(output);
  const title = outputDisplayTitle(output);
  const toggleFavorite = useSetAtom(toggleFavoriteAtom);
  const isFavoriteFn = useAtomValue(isFavoriteAtom);
  const favKey = favoriteKey({
    kind: "output",
    workspaceId,
    outputId: output.id,
  });
  const starred = isFavoriteFn(favKey);

  const handleToggleStar = (event: React.MouseEvent) => {
    event.stopPropagation();
    toggleFavorite({
      kind: "output",
      workspaceId,
      outputId: output.id,
      title,
    });
  };

  return (
    <div
      role="group"
      className="group/artifact relative flex items-center rounded-md transition-colors hover:bg-foreground/[0.04]"
    >
      <button
        type="button"
        onClick={() => onOpen?.(output)}
        disabled={!onOpen}
        className="flex h-9 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left disabled:cursor-default"
      >
        <OutputArtifactIcon output={output} variant="bare" />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {title}
        </span>
        <span className="shrink-0 truncate text-xs text-muted-foreground">
          {kindLabel}
        </span>
        <OutputChangeBadge output={output} />
      </button>
      <button
        type="button"
        aria-label={starred ? "Remove from favorites" : "Add to favorites"}
        title={starred ? "Remove from favorites" : "Add to favorites"}
        onClick={handleToggleStar}
        className={cn(
          "ml-1 mr-1 grid size-5 shrink-0 place-items-center rounded transition-[opacity,background-color,color] duration-snappy ease-out hover:bg-foreground/[0.06] hover:text-foreground",
          starred
            ? "opacity-100 text-foreground/70"
            : "opacity-0 group-hover/artifact:opacity-100 text-foreground/50",
        )}
      >
        <Star
          className={cn("size-3.5", starred && "fill-current")}
          strokeWidth={1.75}
        />
      </button>
    </div>
  );
}

interface ArtifactGroup {
  label: string;
  items: WorkspaceOutputRecordPayload[];
}

/**
 * Buckets outputs by recency relative to the local "now". Inputs are
 * already sorted latest-first by the caller, so within each bucket the
 * order is preserved.
 *
 * Empty buckets are dropped so the rendered list never shows a
 * dangling header. The Earlier bucket catches anything older than
 * the rolling 7-day window — switching to month-based buckets would
 * pretend at a precision the workspace's actual output volume usually
 * doesn't earn.
 */
function groupOutputsByTime(
  outputs: WorkspaceOutputRecordPayload[],
): ArtifactGroup[] {
  if (outputs.length === 0) {
    return [];
  }
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  // Rolling 7-day window (last week) — anything older falls into Earlier.
  const startOfThisWeek = startOfToday - 6 * 24 * 60 * 60 * 1000;

  const buckets: ArtifactGroup[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "Earlier this week", items: [] },
    { label: "Earlier", items: [] },
  ];

  for (const output of outputs) {
    const created = Date.parse(output.created_at || "");
    if (!Number.isFinite(created)) {
      buckets[3]!.items.push(output);
      continue;
    }
    if (created >= startOfToday) {
      buckets[0]!.items.push(output);
    } else if (created >= startOfYesterday) {
      buckets[1]!.items.push(output);
    } else if (created >= startOfThisWeek) {
      buckets[2]!.items.push(output);
    } else {
      buckets[3]!.items.push(output);
    }
  }

  return buckets.filter((bucket) => bucket.items.length > 0);
}
