import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { useMemo, useState } from "react";
import {
  selectedSessionIdAtom,
} from "@/components/layout/shell/state/ui";
import { useShareToHolahub } from "@/components/layout/shell/useShareToHolahub";
import {
  ChevronRight,
  Inbox,
  Layers,
  Upload,
} from "@/components/ui/icons";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { StatusDot } from "@/components/ui/status-dot";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useOpenWorkspaceOutput } from "@/components/layout/shell/useOpenWorkspaceOutput";
import { FileBrandIcon } from "@/lib/fileBrandIcon";
import {
  listDisplayOutputs,
  outputDeliverableKind,
  type OutputItem,
  outputDisplayLabel,
} from "@/lib/outputs";
import { cn } from "@/lib/utils";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { OutputArtifactIcon } from "./ArtifactBrowserModal";
import { ShareGalleryDialog } from "./AssistantTurn/ShareGalleryDialog";
import {
  gatherShareAttributionItems,
  gatherShareImages,
  gatherShareVideos,
  isShareableMediaOutput,
  mergeOutputsByPath,
} from "./AssistantTurn/shareCapture";

const MAX_PREVIEW_OUTPUTS = 6;

type ChatContextData = {
  outputs: OutputItem[];
  openOutput: (output: OutputItem) => void;
};

/** Shared data for both the pinned card and the popover so they never drift. */
function useChatContextData(): ChatContextData {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  // Read the active session from the shell atom — ChatPane keeps it in sync on
  // the draft→real-session transition. useWorkspaceSelection's per-workspace
  // map is NOT updated then, so it would leave Outputs querying a stale (empty)
  // session and showing "No outputs yet" even after a file was produced.
  const selectedSessionId = useAtomValue(selectedSessionIdAtom);
  const { openOutput } = useOpenWorkspaceOutput();

  // Scope Outputs to the conversation in view — not every artifact the
  // workspace has ever produced.
  const outputsQuery = useQuery({
    queryKey: ["chat-context-outputs", selectedWorkspaceId, selectedSessionId],
    queryFn: () =>
      listDisplayOutputs({ limit: 500, sessionId: selectedSessionId }),
    enabled: Boolean(selectedWorkspaceId) && Boolean(selectedSessionId),
    staleTime: 15_000,
  });

  const outputs = outputsQuery.data?.items ?? [];

  return {
    outputs,
    openOutput: (output) => void openOutput(output),
  };
}

/**
 * Sharing this session's artifacts. Its dialog must be rendered OUTSIDE the
 * popover: opening it moves focus out, which dismisses the popover and would
 * take the dialog down with it — hence a hook the two layouts mount themselves.
 */
function useOutputShare(outputs: OutputItem[]) {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const shareToHolahub = useShareToHolahub();
  const [sharing, setSharing] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);

  // The whole session's shareable artifacts, not just the previewed few — the
  // gallery is the picker, so it shouldn't inherit the list's preview cap.
  const shareableOutputs = useMemo(
    () => mergeOutputsByPath(outputs.filter((o) => isShareableMediaOutput(o))),
    [outputs],
  );

  const shareChosen = (picked: WorkspaceOutputRecordPayload[]) => {
    const pickedIds = new Set(picked.map((o) => o.id));
    const chosen = shareableOutputs.filter((o) => pickedIds.has(o.id));
    if (chosen.length === 0 || sharing) {
      return;
    }
    // Seed the composer's "Draft with AI" with what was picked (their labels) —
    // this session share has no turn text, so without it the button hides.
    const sourceText = chosen
      .map((o) => outputDisplayLabel(o))
      .filter(Boolean)
      .join("\n");
    setSharing(true);
    Promise.all([
      gatherShareImages(chosen, selectedWorkspaceId ?? null),
      gatherShareVideos(chosen, selectedWorkspaceId ?? null),
    ])
      .then(([images, videos]) => {
        shareToHolahub({
          sourceText,
          images,
          videos,
          items: gatherShareAttributionItems(chosen),
        });
        setGalleryOpen(false);
      })
      .finally(() => setSharing(false));
  };

  return {
    canShare: shareableOutputs.length > 0,
    openGallery: () => setGalleryOpen(true),
    galleryProps: {
      onConfirm: shareChosen,
      onOpenChange: setGalleryOpen,
      open: galleryOpen,
      outputs: shareableOutputs,
      sharing,
      workspaceId: selectedWorkspaceId ?? null,
    },
  };
}

/** The Outputs + Sources body, shared by the pinned card and the popover. */
function ChatContextSections({
  data,
  onOpenAll,
  canShare,
  onShare,
}: {
  data: ChatContextData;
  onOpenAll?: () => void;
  canShare: boolean;
  onShare: () => void;
}) {
  const preview = data.outputs.slice(0, MAX_PREVIEW_OUTPUTS);

  return (
    <>
      <Section
        label="Outputs"
        action={
          onOpenAll && data.outputs.length > MAX_PREVIEW_OUTPUTS
            ? { label: `All ${data.outputs.length}`, onClick: onOpenAll }
            : undefined
        }
        trailing={
          canShare ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    aria-label="Share outputs to HolaHub"
                    className="grid size-5 place-items-center rounded text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground"
                    onClick={onShare}
                    type="button"
                  />
                }
              >
                <Upload className="size-3.5" strokeWidth={1.75} />
              </TooltipTrigger>
              <TooltipContent className="py-1" side="bottom">
                Share to HolaHub
              </TooltipContent>
            </Tooltip>
          ) : null
        }
      >
        {preview.length === 0 ? (
          <EmptyHint icon={<Inbox className="size-3.5" />} text="No outputs yet" />
        ) : (
          <ul className="flex flex-col gap-px">
            {preview.map((output, index) => (
              <li
                className="flex items-center rounded-md transition-colors hover:bg-fg-6"
                key={`${outputDisplayLabel(output)}-${index}`}
              >
                <button
                  className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left"
                  onClick={() => data.openOutput(output)}
                  type="button"
                >
                  <OutputRowIcon output={output} />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {outputDisplayLabel(output)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

/** Tab-open / tight layout: a top-right button that opens the context popover. */
export function ChatContextPopover({
  onOpenAll,
  hasNew = false,
  onOpen,
}: {
  onOpenAll?: () => void;
  hasNew?: boolean;
  onOpen?: () => void;
}) {
  const data = useChatContextData();
  const share = useOutputShare(data.outputs);
  return (
    <>
      <Popover
        onOpenChange={(open) => {
          if (open) {
            onOpen?.();
          }
        }}
      >
        <Tooltip>
          <PopoverTrigger
            render={
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Outputs & sources"
                    className="relative flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground data-[popup-open]:bg-fg-8 data-[popup-open]:text-foreground"
                  />
                }
              />
            }
          >
            <Layers className="size-4" strokeWidth={1.75} />
            {hasNew ? (
              <StatusDot
                variant="primary"
                size="sm"
                className="absolute top-1 right-1 border border-card"
              />
            ) : null}
          </PopoverTrigger>
          <TooltipContent>Outputs &amp; sources</TooltipContent>
        </Tooltip>
        <PopoverContent align="end" sideOffset={6} className="w-80 gap-0 p-0">
          <ChatContextSections
            canShare={share.canShare}
            data={data}
            onOpenAll={onOpenAll}
            onShare={share.openGallery}
          />
        </PopoverContent>
      </Popover>
      <ShareGalleryDialog {...share.galleryProps} />
    </>
  );
}

/**
 * Spacious / pinned layout: the same Layers button, but it collapses/expands
 * the docked card instead of opening a popover. Styling matches the popover
 * trigger so the control reads as one thing across layouts.
 */
export function ChatContextToggle({
  expanded,
  onToggle,
  hasNew = false,
  className,
}: {
  expanded: boolean;
  onToggle: () => void;
  hasNew?: boolean;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={
              expanded ? "Hide outputs & sources" : "Show outputs & sources"
            }
            aria-pressed={expanded}
            onClick={onToggle}
            className={cn(
              "relative flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground",
              expanded && "bg-fg-8 text-foreground",
              className,
            )}
          />
        }
      >
        <Layers className="size-4" strokeWidth={1.75} />
        {hasNew ? (
          <StatusDot
            variant="primary"
            size="sm"
            className="absolute top-1 right-1 border border-card"
          />
        ) : null}
      </TooltipTrigger>
      <TooltipContent>Outputs &amp; sources</TooltipContent>
    </Tooltip>
  );
}

/** Spacious / canvas layout: the same context pinned as a docked card. */
export function ChatContextCard({ onOpenAll }: { onOpenAll?: () => void }) {
  const data = useChatContextData();
  const share = useOutputShare(data.outputs);
  return (
    <>
      <div className="max-h-[70vh] w-80 animate-in overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover text-popover-foreground shadow-lg duration-fast fade-in-0 slide-in-from-right-2 ease-emphasized">
        <ChatContextSections
          canShare={share.canShare}
          data={data}
          onOpenAll={onOpenAll}
          onShare={share.openGallery}
        />
      </div>
      <ShareGalleryDialog {...share.galleryProps} />
    </>
  );
}

function OutputRowIcon({ output }: { output: OutputItem }) {
  // Capabilities/skills get their own glyph (Puzzle/Feather) — a yaml/md file
  // icon would read as config, not a deliverable.
  if (outputDeliverableKind(output)) {
    return <OutputArtifactIcon output={output} variant="bare" />;
  }
  const filePath =
    typeof output.file_path === "string" ? output.file_path.trim() : "";
  if (filePath) {
    return <FileBrandIcon className="shrink-0" filePath={filePath} size={18} />;
  }
  return <OutputArtifactIcon output={output} variant="bare" />;
}

function Section({
  label,
  action,
  trailing,
  children,
}: {
  label: string;
  action?: { label: string; onClick: () => void };
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="px-3 py-3">
      <div className="flex items-center gap-1 px-1 pb-1.5">
        <span className="flex-1 text-sm font-medium text-muted-foreground">
          {label}
        </span>
        {trailing}
        {action ? (
          <button
            type="button"
            onClick={action.onClick}
            className="flex items-center gap-0.5 rounded text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {action.label}
            <ChevronRight className="size-3" />
          </button>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function EmptyHint({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground/70">
      <span className="shrink-0">{icon}</span>
      {text}
    </div>
  );
}
