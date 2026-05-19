import { ArrowUpRight, ChevronDown, Folder } from "lucide-react";
import { useState } from "react";
import {
  OutputArtifactIcon,
  dedupeOutputsForDisplay,
  outputSecondaryLabel,
} from "../ArtifactBrowserModal";

const INLINE_OUTPUT_COLLAPSE_THRESHOLD = 3;

export function AssistantTurnOutputs({
  outputs,
  onOpenOutput,
  onOpenAllArtifacts,
}: {
  outputs: WorkspaceOutputRecordPayload[];
  onOpenOutput?: (output: WorkspaceOutputRecordPayload) => void;
  onOpenAllArtifacts: (outputs: WorkspaceOutputRecordPayload[]) => void;
}) {
  const displayOutputs = dedupeOutputsForDisplay(outputs);
  const [expanded, setExpanded] = useState(false);
  if (displayOutputs.length === 0) {
    return null;
  }
  const shouldCollapse =
    displayOutputs.length > INLINE_OUTPUT_COLLAPSE_THRESHOLD;
  const visibleOutputs =
    shouldCollapse && !expanded
      ? displayOutputs.slice(0, INLINE_OUTPUT_COLLAPSE_THRESHOLD)
      : displayOutputs;
  return (
    <div className="mt-3 flex max-w-[420px] flex-col">
      {visibleOutputs.map((output) => (
        <button
          key={output.id}
          type="button"
          onClick={() => onOpenOutput?.(output)}
          className="group flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-foreground/[0.04] disabled:cursor-default disabled:hover:bg-transparent"
          disabled={!onOpenOutput}
        >
          <OutputArtifactIcon output={output} variant="bare" size="sm" />
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">
            {output.title || "Untitled artifact"}
          </span>
          <span className="shrink-0 truncate text-xs text-muted-foreground">
            {outputSecondaryLabel(output)}
          </span>
          <ArrowUpRight className="size-3 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
        </button>
      ))}

      {shouldCollapse ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="flex h-7 items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
        >
          <Folder className="size-3 shrink-0" />
          <span className="flex-1">
            {expanded
              ? "Show less"
              : `Show ${displayOutputs.length - INLINE_OUTPUT_COLLAPSE_THRESHOLD} more`}
          </span>
          <ChevronDown
            className={`size-3 shrink-0 transition-transform ${expanded ? "rotate-180" : "rotate-0"}`}
          />
        </button>
      ) : displayOutputs.length > 1 ? (
        <button
          type="button"
          onClick={() => onOpenAllArtifacts(displayOutputs)}
          className="flex h-7 items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
        >
          <Folder className="size-3 shrink-0" />
          <span>View artifacts in this reply ({displayOutputs.length})</span>
        </button>
      ) : null}
    </div>
  );
}
