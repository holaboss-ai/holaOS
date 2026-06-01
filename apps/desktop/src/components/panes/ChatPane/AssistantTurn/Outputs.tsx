import { ArrowUpRight, ChevronDown, Folder } from "lucide-react";
import { useState } from "react";
import {
  OutputArtifactIcon,
  dedupeOutputsForDisplay,
  outputDisplayTitle,
  outputKindLabel,
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
  // Stable per-kind sequence numbers ("Tweet #2") used as the LAST
  // resort if neither output.title nor any metadata-derived label
  // (summary / filename / artifact_type) is available. With the new
  // outputDisplayTitle fallback chain, this counter ends up showing
  // far less often — but still wins over "Untitled artifact" when
  // the producer truly gave us nothing to name the row.
  const kindCounters = new Map<string, number>();
  const labelByOutputId = new Map<string, string>();
  for (const output of displayOutputs) {
    if (output.title?.trim()) continue;
    const kind = outputKindLabel(output);
    const next = (kindCounters.get(kind) ?? 0) + 1;
    kindCounters.set(kind, next);
    labelByOutputId.set(output.id, `${kind} #${next}`);
  }
  return (
    <div className="mt-3 flex max-w-[420px] flex-col gap-px">
      {visibleOutputs.map((output) => (
        <ArtifactRow
          key={output.id}
          defaultTitle={labelByOutputId.get(output.id)}
          onOpen={onOpenOutput}
          output={output}
        />
      ))}

      {shouldCollapse ? (
        <button
          aria-expanded={expanded}
          className="mt-1 flex h-8 items-center gap-2 rounded-md border border-dashed border-border px-2.5 text-left text-xs text-muted-foreground transition-colors hover:border-border/80 hover:bg-foreground/[0.04] hover:text-foreground"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          <Folder className="size-3 shrink-0" />
          <span className="flex-1">
            {expanded
              ? "Show less"
              : `+${
                  displayOutputs.length - INLINE_OUTPUT_COLLAPSE_THRESHOLD
                } more ${
                  displayOutputs.length -
                    INLINE_OUTPUT_COLLAPSE_THRESHOLD ===
                  1
                    ? "artifact"
                    : "artifacts"
                }`}
          </span>
          <ChevronDown
            className={`size-3 shrink-0 transition-transform ${
              expanded ? "rotate-180" : "rotate-0"
            }`}
          />
        </button>
      ) : displayOutputs.length > 1 ? (
        <button
          className="mt-1 flex h-7 items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
          onClick={() => onOpenAllArtifacts(displayOutputs)}
          type="button"
        >
          <Folder className="size-3 shrink-0" />
          <span>View artifacts in this reply ({displayOutputs.length})</span>
        </button>
      ) : null}
    </div>
  );
}

function ArtifactRow({
  defaultTitle,
  onOpen,
  output,
}: {
  defaultTitle: string | undefined;
  onOpen?: (output: WorkspaceOutputRecordPayload) => void;
  output: WorkspaceOutputRecordPayload;
}) {
  const displayTitle = outputDisplayTitle(output, defaultTitle);
  return (
    <button
      className="group flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-transparent px-2 text-left transition-colors hover:border-border hover:bg-foreground/[0.03] disabled:cursor-default disabled:hover:border-transparent disabled:hover:bg-transparent"
      disabled={!onOpen}
      onClick={() => onOpen?.(output)}
      type="button"
    >
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground transition-colors group-hover:bg-foreground/[0.06] group-hover:text-foreground">
        <OutputArtifactIcon output={output} size="sm" variant="bare" />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {displayTitle}
      </span>
      <span className="shrink-0 truncate text-xs text-muted-foreground/80">
        {outputSecondaryLabel(output)}
      </span>
      <ArrowUpRight className="size-3 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground" />
    </button>
  );
}
