import { Boxes } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  OutputArtifactIcon,
  dedupeOutputsForDisplay,
  outputBrowserFilterForOutput,
  outputChangeLabel,
  outputKindLabel,
  sortOutputsLatestFirst,
} from "./ArtifactBrowserModal";
import type { ArtifactBrowserFilter } from "./types";

/**
 * Header-anchored artifact browser. Pops over from the ChatHeader's
 * `Boxes` button, lists every output produced in the session, and
 * jumps the user to the chosen output on click.
 *
 * The dialog-style ArtifactBrowserModal still handles per-reply
 * scoped browsing (Outputs.tsx triggers it inline). This component
 * is purely the session-wide entry point and follows the same
 * lightweight popover pattern as NotificationInbox so the chrome
 * stays consistent across header actions.
 */

const FILTER_OPTIONS: ReadonlyArray<{
  id: ArtifactBrowserFilter;
  label: string;
}> = [
  { id: "all", label: "All" },
  { id: "documents", label: "Docs" },
  { id: "images", label: "Images" },
  { id: "code", label: "Code" },
  { id: "links", label: "Links" },
  { id: "apps", label: "Apps" },
];

interface ArtifactBrowserPopoverProps {
  outputs: WorkspaceOutputRecordPayload[];
  onOpenOutput?: (output: WorkspaceOutputRecordPayload) => void;
}

export function ArtifactBrowserPopover({
  outputs,
  onOpenOutput,
}: ArtifactBrowserPopoverProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<ArtifactBrowserFilter>("all");

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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="View all artifacts"
                  aria-haspopup="dialog"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Boxes className="size-4" />
                </Button>
              }
            />
          }
        />
        <TooltipContent>All artifacts</TooltipContent>
      </Tooltip>

      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[380px] gap-0 p-0"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              Artifacts
            </span>
            {totalCount > 0 ? (
              <span className="rounded-full bg-fg-6 px-1.5 py-px text-[10px] font-medium tabular-nums text-muted-foreground">
                {totalCount}
              </span>
            ) : null}
          </div>
        </div>

        {totalCount > 0 ? (
          <div className="flex shrink-0 flex-wrap gap-1 border-b border-border px-2 py-1.5">
            {FILTER_OPTIONS.map((option) => {
              const active = filter === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setFilter(option.id)}
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors",
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

        {totalCount === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <div className="grid size-10 place-items-center rounded-full bg-fg-6 text-muted-foreground">
              <Boxes className="size-4" />
            </div>
            <div className="text-sm font-medium text-foreground">
              No artifacts yet
            </div>
            <div className="text-xs text-muted-foreground">
              Files, images, and links produced during this session will appear here.
            </div>
          </div>
        ) : filteredOutputs.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            No artifacts match this filter.
          </div>
        ) : (
          <div className="max-h-[420px] overflow-y-auto [overflow-anchor:none]">
            {filteredOutputs.map((output) => {
              const kindLabel = outputKindLabel(output);
              const changeLabel = outputChangeLabel(output);
              return (
                <button
                  key={output.id}
                  type="button"
                  onClick={() => {
                    if (onOpenOutput) {
                      setOpen(false);
                      onOpenOutput(output);
                    }
                  }}
                  disabled={!onOpenOutput}
                  className="group/artifact-row flex w-full min-w-0 items-start gap-2.5 border-b border-border px-3 py-2 text-left last:border-b-0 transition-colors hover:bg-fg-2 disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <OutputArtifactIcon output={output} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
                      {kindLabel}
                    </div>
                    <div className="truncate text-xs font-medium text-foreground">
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
      </PopoverContent>
    </Popover>
  );
}
