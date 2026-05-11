import { ArrowUpRight, Folder } from "lucide-react";
import {
  OutputArtifactIcon,
  dedupeOutputsForDisplay,
  outputSecondaryLabel,
} from "../ArtifactBrowserModal";

const MAX_VISIBLE_OUTPUTS = 3;

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
  if (displayOutputs.length === 0) {
    return null;
  }
  const visibleOutputs = displayOutputs.slice(0, MAX_VISIBLE_OUTPUTS);
  const overflowCount = displayOutputs.length - visibleOutputs.length;
  return (
    <div className="mt-3 flex flex-col gap-2">
      {visibleOutputs.map((output) => (
        <button
          key={output.id}
          type="button"
          onClick={() => onOpenOutput?.(output)}
          className="group flex max-w-[380px] items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-accent/50 disabled:cursor-default disabled:hover:border-border disabled:hover:bg-card"
          disabled={!onOpenOutput}
        >
          <OutputArtifactIcon output={output} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">
              {output.title || "Untitled artifact"}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {outputSecondaryLabel(output)}
            </div>
          </div>
          <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
        </button>
      ))}

      {displayOutputs.length > 1 ? (
        <button
          type="button"
          onClick={() => onOpenAllArtifacts(displayOutputs)}
          className="flex max-w-[380px] items-center gap-3 rounded-xl border border-dashed border-border px-3 py-2 text-left text-muted-foreground transition-colors hover:border-border hover:bg-accent/40 hover:text-foreground"
        >
          <div className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
            <Folder className="size-3.5" />
          </div>
          <span className="text-xs">
            {overflowCount > 0
              ? `View all ${displayOutputs.length} artifacts (+${overflowCount} more)`
              : `View artifacts in this reply (${displayOutputs.length})`}
          </span>
        </button>
      ) : null}
    </div>
  );
}
