import { ArrowUpRight, Link2 } from "lucide-react";
import type { ChatBackgroundTaskReference } from "./types";

function humanizeTaskStatus(value: string | null | undefined): string {
  const normalized = (value || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  switch (normalized) {
    case "waiting_on_user":
      return "Waiting";
    case "in_progress":
      return "In progress";
    default:
      return normalized
        .split(/[_\s-]+/)
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
  }
}

function backgroundTaskReferenceKey(reference: ChatBackgroundTaskReference) {
  return [
    reference.workspaceId,
    reference.sourceType ?? "",
    reference.issueId ?? "",
    reference.sourceId ?? "",
    reference.title ?? "",
  ].join("|");
}

function backgroundTaskReferencePrimaryLabel(
  reference: ChatBackgroundTaskReference,
) {
  return (
    reference.issueId?.trim() ||
    reference.sourceId?.trim() ||
    reference.title?.trim() ||
    "Open task"
  );
}

function backgroundTaskReferenceSecondaryLabel(
  reference: ChatBackgroundTaskReference,
) {
  const sourceType = (reference.sourceType ?? "").trim().toLowerCase();
  const title = (reference.title ?? "").trim();
  if (sourceType === "issue" || sourceType === "delegate_task") {
    return title || "Open related issue";
  }
  if (sourceType === "cronjob") {
    return title || "Open related automation";
  }
  return title || "Open related task";
}

export function BackgroundTaskReferenceCards({
  references,
  onOpenReference,
}: {
  references: ChatBackgroundTaskReference[];
  onOpenReference?: (reference: ChatBackgroundTaskReference) => void;
}) {
  if (references.length === 0) {
    return null;
  }

  return (
    <div className="flex max-w-full flex-wrap gap-2">
      {references.map((reference) => {
        const primary = backgroundTaskReferencePrimaryLabel(reference);
        const secondary = backgroundTaskReferenceSecondaryLabel(reference);
        const status = humanizeTaskStatus(reference.status);
        const interactive = typeof onOpenReference === "function";
        return (
          <button
            key={backgroundTaskReferenceKey(reference)}
            type="button"
            onClick={() => onOpenReference?.(reference)}
            disabled={!interactive}
            className="flex min-w-[220px] max-w-full items-start gap-2 rounded-lg border border-border/80 bg-background/70 px-3 py-2 text-left transition-colors hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-background/70"
          >
            <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-fg-6 text-muted-foreground">
              <Link2 className="size-3.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-xs font-semibold text-foreground">
                  {primary}
                </span>
                {status ? (
                  <span className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    {status}
                  </span>
                ) : null}
              </div>
              <div className="truncate pt-0.5 text-xs text-muted-foreground">
                {secondary}
              </div>
            </div>
            <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          </button>
        );
      })}
    </div>
  );
}
