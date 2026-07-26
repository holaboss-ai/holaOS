import { OutputArtifactIcon } from "@/components/panes/ChatPane/ArtifactBrowserModal";
import { ArrowUpRight } from "@/components/ui/icons";

interface ProjectOutputsRowProps {
  outputs: WorkspaceOutputRecordPayload[];
  onPreview: (output: WorkspaceOutputRecordPayload) => void;
  onOpenFull: (output: WorkspaceOutputRecordPayload) => void;
}

export function ProjectOutputsRow({
  outputs,
  onPreview,
  onOpenFull,
}: ProjectOutputsRowProps) {
  if (outputs.length === 0) {
    return null;
  }
  return (
    <div className="mt-10">
      <h2 className="px-1 text-sm font-medium text-muted-foreground">Outputs</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        {outputs.map((output) => {
          const title = output.title?.trim() || "Untitled";
          return (
            <div
              className="group/output flex min-w-0 max-w-56 items-center rounded-lg border border-border bg-card transition-colors hover:bg-accent"
              key={output.id}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-1 pl-3 text-left"
                onClick={() => onPreview(output)}
                title={title}
                type="button"
              >
                <OutputArtifactIcon output={output} size="sm" variant="bare" />
                <span className="truncate text-sm text-foreground">
                  {title}
                </span>
              </button>
              <button
                aria-label={`Open ${title} in a tab`}
                className="mr-1 grid size-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/8 hover:text-foreground focus-visible:opacity-100 group-hover/output:opacity-100"
                onClick={() => onOpenFull(output)}
                title="Open in tab"
                type="button"
              >
                <ArrowUpRight className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
