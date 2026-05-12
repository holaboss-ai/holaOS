import { Boxes } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  OutputArtifactIcon,
  dedupeOutputsForDisplay,
  outputBrowserFilterForOutput,
  outputChangeLabel,
  outputKindLabel,
  sortOutputsLatestFirst,
} from "@/components/panes/ChatPane/ArtifactBrowserModal";
import type { ArtifactBrowserFilter } from "@/components/panes/ChatPane/types";
import { EmptyState } from "@/components/ui/empty-state";
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
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

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
  const filteredOutputs = useMemo(
    () =>
      sortOutputsLatestFirst(
        filter === "all"
          ? allDisplayOutputs
          : allDisplayOutputs.filter(
              (output) => outputBrowserFilterForOutput(output) === filter,
            ),
      ),
    [allDisplayOutputs, filter],
  );
  const totalCount = allDisplayOutputs.length;

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
            No artifacts match this filter.
          </div>
        ) : (
          <div className="grid gap-2">
            {filteredOutputs.map((output) => {
              const kindLabel = outputKindLabel(output);
              const changeLabel = outputChangeLabel(output);
              return (
                <button
                  key={output.id}
                  type="button"
                  onClick={() => onOpenOutput?.(output)}
                  disabled={!onOpenOutput}
                  className="group flex w-full min-w-0 items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/40 disabled:cursor-default disabled:hover:bg-card"
                >
                  <OutputArtifactIcon output={output} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {kindLabel}
                    </div>
                    <div className="truncate text-sm font-medium text-foreground">
                      {output.title || "Untitled artifact"}
                    </div>
                  </div>
                  {changeLabel ? (
                    <span className="shrink-0 self-center rounded-full border border-border px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                      {changeLabel}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
