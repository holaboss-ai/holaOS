import { useSetAtom } from "jotai";
import {
  AlertTriangle,
  ArrowUpRight,
  Link2,
  MessageCircleQuestion,
} from "@/components/ui/icons";
import {
  makeIssueDetailTabId,
  pendingIssueComposerFocusAtom,
} from "@/components/layout/shell/state/internalTabs";
import { cn } from "@/lib/utils";
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

function isWaitingStatus(value: string | null | undefined): boolean {
  return (value || "").trim().toLowerCase() === "waiting_on_user";
}

const FAILED_STATUSES = new Set(["failed", "error", "errored", "cancelled", "canceled"]);

function isFailedStatus(value: string | null | undefined): boolean {
  return FAILED_STATUSES.has((value || "").trim().toLowerCase());
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
  if (sourceType === "cronjob" || sourceType === "workflow") {
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
  const setPendingComposerFocus = useSetAtom(pendingIssueComposerFocusAtom);

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
        const waiting = isWaitingStatus(reference.status);
        const failed = isFailedStatus(reference.status);
        const workspaceId = reference.workspaceId?.trim() || "";
        const issueId =
          reference.issueId?.trim() || reference.sourceId?.trim() || "";
        const canReply = waiting && interactive && workspaceId && issueId;

        const handleActivate = () => {
          if (canReply) {
            const tabId = makeIssueDetailTabId(workspaceId, issueId);
            setPendingComposerFocus((prev) => {
              if (prev.has(tabId)) return prev;
              const next = new Set(prev);
              next.add(tabId);
              return next;
            });
          }
          onOpenReference?.(reference);
        };

        return (
          <button
            key={backgroundTaskReferenceKey(reference)}
            type="button"
            onClick={handleActivate}
            disabled={!interactive}
            className={cn(
              "group flex min-w-[280px] max-w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors duration-150 disabled:cursor-default",
              waiting
                ? "border-amber-500/30 bg-amber-500/[0.06] hover:bg-amber-500/[0.11] disabled:hover:bg-amber-500/[0.06]"
                : failed
                  ? "border-destructive/35 bg-destructive/[0.06] hover:bg-destructive/[0.11] disabled:hover:bg-destructive/[0.06]"
                  : "border-border/80 bg-background/70 hover:bg-muted/60 disabled:hover:bg-background/70",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "grid size-8 shrink-0 place-items-center rounded-md transition-colors",
                waiting
                  ? "bg-amber-500/15 text-amber-700 group-hover:bg-amber-500/20 dark:text-amber-300"
                  : failed
                    ? "bg-destructive/15 text-destructive group-hover:bg-destructive/20"
                    : "bg-fg-6 text-muted-foreground",
              )}
            >
              {waiting ? (
                <MessageCircleQuestion
                  className="size-4"
                  strokeWidth={1.75}
                />
              ) : failed ? (
                <AlertTriangle className="size-4" strokeWidth={1.75} />
              ) : (
                <Link2 className="size-3.5" />
              )}
            </span>
            <span className="min-w-0 flex-1 space-y-0.5">
              <span className="flex min-w-0 items-baseline gap-1.5 text-[12px]">
                <span
                  className={cn(
                    "truncate font-mono font-medium",
                    failed ? "text-destructive/85" : "text-foreground/70",
                  )}
                >
                  {primary}
                </span>
                {status ? (
                  <>
                    <span
                      aria-hidden
                      className={cn(
                        "shrink-0",
                        waiting
                          ? "text-amber-700/60 dark:text-amber-300/60"
                          : failed
                            ? "text-destructive/40"
                            : "text-foreground/30",
                      )}
                    >
                      ·
                    </span>
                    <span
                      className={cn(
                        "shrink-0 font-medium",
                        waiting
                          ? "text-amber-700 dark:text-amber-300"
                          : failed
                            ? "text-destructive"
                            : "text-foreground/55",
                      )}
                    >
                      {status}
                    </span>
                  </>
                ) : null}
              </span>
              <span
                className={cn(
                  "block truncate text-[13px] leading-snug",
                  waiting || failed ? "text-foreground/85" : "text-foreground/75",
                )}
              >
                {secondary}
              </span>
            </span>
            {canReply ? (
              <span
                aria-hidden
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2.5 text-[12px] font-medium transition-colors",
                  "bg-amber-500 text-white shadow-[0_1px_0_rgba(0,0,0,0.06)] group-hover:bg-amber-600",
                  "dark:bg-amber-400 dark:text-amber-950 dark:group-hover:bg-amber-300",
                )}
              >
                Reply
                <ArrowUpRight className="size-3.5" strokeWidth={2.25} />
              </span>
            ) : (
              <ArrowUpRight
                className={cn(
                  "size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5",
                  failed ? "text-destructive/70" : "text-muted-foreground",
                )}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
