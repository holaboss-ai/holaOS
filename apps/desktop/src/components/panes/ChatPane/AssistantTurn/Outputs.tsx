import { PinStarButton } from "@/components/layout/shell/PinStarButton";
import { fileNameFromPath } from "@/components/layout/shell/state/internalTabs";
import {
  chatComposerPrefillAtom,
  discoverEnabledAtom,
} from "@/components/layout/shell/state/ui";
import { useOpenWorkspaceOutput } from "@/components/layout/shell/useOpenWorkspaceOutput";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Download,
  Eye,
  Folder,
  Gift,
  LayoutGrid,
  Loader2,
  Sparkles,
  Upload,
} from "@/components/ui/icons";
import { useShareToHolahub } from "@/components/layout/shell/useShareToHolahub";
import { billingRpcFetch } from "@/lib/app-sdk-client";
import { useQuery } from "@tanstack/react-query";
import {
  gatherShareAttributionItems,
  gatherShareImages,
  gatherShareVideos,
  isShareableMediaOutput,
  MAX_SHARE_IMAGES,
} from "./shareCapture";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FileBrandIcon, hasOfficeBrandIcon } from "@/lib/fileBrandIcon";
import { FileTypeIcon } from "@/lib/fileIcon";
import { useDefaultApp } from "@/lib/useFileIcon";
import {
  outputDeliverableKind,
  outputDisplayLabel,
  type OutputItem,
} from "@/lib/outputs";
import { cn } from "@/lib/utils";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { useAtomValue, useSetAtom } from "jotai";
import { useState } from "react";
import {
  dedupeOutputsForDisplay,
  OutputArtifactIcon,
  outputDisplayTitle,
  outputKindLabel,
  outputSecondaryLabel,
} from "../ArtifactBrowserModal";
import { slugifyFilePathForMention } from "../helpers";
import { selectTurnResultCards } from "../turnResultCards";

const INLINE_OUTPUT_COLLAPSE_THRESHOLD = 3;

export function AssistantTurnOutputs({
  outputs,
  onOpenOutput,
  turnText,
  workspaceId,
}: {
  outputs: WorkspaceOutputRecordPayload[];
  onOpenOutput?: (output: WorkspaceOutputRecordPayload) => void;
  /** The assistant turn's text — hidden context for the composer's AI caption. */
  turnText?: string;
  workspaceId?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const setComposerPrefill = useSetAtom(chatComposerPrefillAtom);
  const { workspaces, installedApps } = useWorkspaceDesktop();
  const { openUrlInBrowserTab } = useOpenWorkspaceOutput();
  const shareToHolahub = useShareToHolahub();
  const [selectedShareIds, setSelectedShareIds] = useState<Set<string>>(
    new Set(),
  );
  const [sharing, setSharing] = useState(false);

  const { cards } = selectTurnResultCards(dedupeOutputsForDisplay(outputs));

  // Multi-share: when a turn produced ≥2 shareable media artifacts, let the user
  // pick a subset and post them together to HolaHub (a single turn-level Share
  // still handles the whole turn from the actions menu).
  // Sharing is part of the HolaHub community — hide every share affordance
  // (the CTA nudge + per-output multi-select) until the user opts in.
  const discoverEnabled = useAtomValue(discoverEnabledAtom);
  const shareableOutputIds = new Set(
    cards
      .filter(
        (card) => card.kind === "output" && isShareableMediaOutput(card.output),
      )
      .map((card) => (card.kind === "output" ? card.output.id : "")),
  );
  const selectableShare = discoverEnabled && shareableOutputIds.size >= 2;

  // "Share to win credits": the credits a live campaign grants for sharing an
  // output, or null when none is running (nudge falls back to plain encourage).
  const { data: shareReward } = useQuery({
    queryKey: ["rewards", "shareReward"],
    queryFn: () =>
      billingRpcFetch<{ credits: number | null }>("/rpc/rewards/shareReward"),
    staleTime: 5 * 60 * 1000,
  });
  const shareCredits = shareReward?.credits ?? null;

  const shareableCards = cards
    .filter(
      (card) => card.kind === "output" && isShareableMediaOutput(card.output),
    )
    .map((card) => (card as { output: WorkspaceOutputRecordPayload }).output);

  // Quick-share every shareable output in the turn (the nudge's action; the
  // per-item checkboxes still let the user post a subset).
  const shareAll = () => {
    if (shareableCards.length === 0 || sharing) {
      return;
    }
    setSharing(true);
    Promise.all([
      gatherShareImages(shareableCards, workspaceId ?? null),
      gatherShareVideos(shareableCards, workspaceId ?? null),
    ])
      .then(([images, videos]) => {
        shareToHolahub({
          sourceText: turnText,
          images,
          videos,
          items: gatherShareAttributionItems(shareableCards),
        });
      })
      .finally(() => setSharing(false));
  };

  const toggleShareSelect = (id: string) => {
    setSelectedShareIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < MAX_SHARE_IMAGES) {
        next.add(id);
      }
      return next;
    });
  };

  const shareSelected = () => {
    if (selectedShareIds.size === 0 || sharing) {
      return;
    }
    const chosen = cards
      .filter(
        (card) =>
          card.kind === "output" && selectedShareIds.has(card.output.id),
      )
      .map((card) => (card as { output: WorkspaceOutputRecordPayload }).output);
    setSharing(true);
    Promise.all([
      gatherShareImages(chosen, workspaceId ?? null),
      gatherShareVideos(chosen, workspaceId ?? null),
    ])
      .then(([images, videos]) => {
        shareToHolahub({
          sourceText: turnText,
          images,
          videos,
          items: gatherShareAttributionItems(chosen),
        });
        setSelectedShareIds(new Set());
      })
      .finally(() => setSharing(false));
  };

  // Per-kind sequence numbers ("Tweet #2") as the last-resort name for an
  // untitled deliverable.
  const kindCounters = new Map<string, number>();
  const labelByOutputId = new Map<string, string>();
  for (const card of cards) {
    if (card.kind !== "output" || card.output.title?.trim()) continue;
    const kind = outputKindLabel(card.output);
    const next = (kindCounters.get(kind) ?? 0) + 1;
    kindCounters.set(kind, next);
    labelByOutputId.set(card.output.id, `${kind} #${next}`);
  }

  const refine = (output: WorkspaceOutputRecordPayload) => {
    if (!(workspaceId && output.file_path)) return;
    const wsPath =
      workspaces.find((w) => w.id === workspaceId)?.workspace_path?.trim() ?? "";
    const prefix = wsPath ? `${wsPath.replace(/[\\/]+$/, "")}/` : "";
    const relative =
      prefix && output.file_path.startsWith(prefix)
        ? output.file_path.slice(prefix.length)
        : output.file_path;
    const handle = slugifyFilePathForMention(relative);
    if (!handle) return;
    setComposerPrefill({
      text: `Refine @${handle} — edit this file in place, save back to the same path, do not create a new file: `,
      requestKey: Date.now(),
      mode: "replace",
      sessionMode: "preserve",
    });
  };

  const openApp = (appId: string) => {
    if (!workspaceId) return;
    void (async () => {
      try {
        const url = await window.electronAPI.appSurface.resolveUrl(
          workspaceId,
          appId,
        );
        await openUrlInBrowserTab(url, { dedupBy: "origin" });
      } catch {
        // app may still be starting — status surfaces elsewhere
      }
    })();
  };

  if (cards.length === 0) {
    // No deliverables — build scaffolding (source, configs, lockfiles) is not
    // a user-facing artifact, so a pure-build turn shows no output area.
    return null;
  }

  const shouldCollapse = cards.length > INLINE_OUTPUT_COLLAPSE_THRESHOLD;
  const visibleCards =
    shouldCollapse && !expanded
      ? cards.slice(0, INLINE_OUTPUT_COLLAPSE_THRESHOLD)
      : cards;

  return (
    <div className="mt-3 flex max-w-[440px] flex-col gap-2">
      {visibleCards.map((card) =>
        card.kind === "app" ? (
          <ResultAppRow
            key={`app:${card.appId}`}
            label={
              installedApps.find((app) => app.id === card.appId)?.label ??
              card.appId
            }
            onOpen={() => openApp(card.appId)}
          />
        ) : (
          <ResultOutputRow
            key={card.output.id}
            defaultTitle={labelByOutputId.get(card.output.id)}
            output={card.output}
            selectable={selectableShare && shareableOutputIds.has(card.output.id)}
            selected={selectedShareIds.has(card.output.id)}
            workspaceId={workspaceId ?? null}
            onOpen={onOpenOutput}
            onRefine={() => refine(card.output)}
            onToggleSelect={() => toggleShareSelect(card.output.id)}
          />
        ),
      )}

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
              : `+${cards.length - INLINE_OUTPUT_COLLAPSE_THRESHOLD} more`}
          </span>
          <ChevronDown
            className={cn(
              "size-3 shrink-0 transition-transform",
              expanded ? "rotate-180" : "rotate-0",
            )}
          />
        </button>
      ) : null}

      {selectableShare && selectedShareIds.size > 0 ? (
        <button
          className="mt-1 flex h-9 items-center justify-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
          disabled={sharing}
          onClick={shareSelected}
          type="button"
        >
          {sharing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Upload className="size-4" strokeWidth={1.9} />
          )}
          Share {selectedShareIds.size} to HolaHub
          {shareCredits == null ? "" : ` · win ${shareCredits} credits`}
        </button>
      ) : discoverEnabled && shareableOutputIds.size >= 1 ? (
        shareCredits == null ? (
          <button
            className="group mt-1 flex w-full items-center gap-3 rounded-xl bg-primary/8 px-3.5 py-2.5 text-left ring-1 ring-primary/15 ring-inset transition-colors hover:bg-primary/12 disabled:opacity-60"
            disabled={sharing}
            onClick={shareAll}
            type="button"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
              {sharing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Upload className="size-4" strokeWidth={1.9} />
              )}
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block font-medium text-primary text-sm">
                Share to HolaHub
              </span>
              <span className="block text-muted-foreground text-xs">
                Show your creation to the community
              </span>
            </span>
            <ArrowUpRight className="size-4 shrink-0 text-primary transition-transform group-hover:translate-x-0.5" />
          </button>
        ) : (
          <button
            className="group mt-1 flex w-full items-center gap-3 rounded-xl bg-primary px-3.5 py-2.5 text-left text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-60"
            disabled={sharing}
            onClick={shareAll}
            type="button"
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/15">
              {sharing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Gift className="size-4" strokeWidth={1.9} />
              )}
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block font-semibold text-sm">
                Share to win {shareCredits} credits
              </span>
              <span className="block text-primary-foreground/80 text-xs">
                Post your creation to HolaHub
              </span>
            </span>
            <ArrowUpRight className="size-4 shrink-0 text-primary-foreground/80 transition-transform group-hover:translate-x-0.5" />
          </button>
        )
      ) : null}
    </div>
  );
}

function fileExtensionUpper(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? "";
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0 ? name.slice(dotIndex + 1).toUpperCase() : "";
}

function ResultOutputRow({
  defaultTitle,
  output,
  selectable,
  selected,
  workspaceId,
  onOpen,
  onRefine,
  onToggleSelect,
}: {
  defaultTitle: string | undefined;
  output: WorkspaceOutputRecordPayload;
  selectable: boolean;
  selected: boolean;
  workspaceId: string | null;
  onOpen?: (output: WorkspaceOutputRecordPayload) => void;
  onRefine: () => void;
  onToggleSelect: () => void;
}) {
  const deliverableKind = outputDeliverableKind(output as OutputItem);
  const filePath = output.file_path ?? null;
  const iconPath = filePath ?? output.title ?? "";
  const displayTitle = filePath
    ? fileNameFromPath(filePath)
    : deliverableKind
      ? outputDisplayLabel(output as OutputItem)
      : outputDisplayTitle(output, defaultTitle);
  const extensionLabel = filePath ? fileExtensionUpper(filePath) : "";
  const secondaryLabel = extensionLabel
    ? [outputKindLabel(output), extensionLabel].filter(Boolean).join(" · ")
    : outputSecondaryLabel(output, { includeKind: false });

  // Real default app (name + icon) for the "Open in <App>" menu item.
  const { name: defaultAppName, iconUrl: openInIconUrl } = useDefaultApp(
    filePath,
    workspaceId,
  );

  const openInDefaultApp = () => {
    if (filePath) {
      void window.electronAPI.fs.openInDefaultApp(filePath, workspaceId);
    }
  };
  const revealInFolder = () => {
    if (filePath) {
      void window.electronAPI.fs.revealInFolder(filePath, workspaceId);
    }
  };
  const exportFile = () => {
    if (filePath) {
      void window.electronAPI.fs.exportFileTo(filePath, workspaceId, {
        suggestedName: displayTitle,
      });
    }
  };

  return (
    <div
      className={cn(
        "group flex w-full min-w-0 items-center gap-3 rounded-xl border px-3.5 py-2.5 transition-colors",
        selected
          ? "border-primary/50 bg-primary/[0.06]"
          : "border-border/70 bg-foreground/[0.02] hover:bg-foreground/[0.05]",
      )}
    >
      {selectable ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                aria-checked={selected}
                aria-label={
                  selected ? "Deselect from share" : "Select to share"
                }
                className={cn(
                  "grid size-5 shrink-0 place-items-center rounded-md border transition-colors",
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-transparent hover:border-primary/60",
                )}
                onClick={onToggleSelect}
                role="checkbox"
                type="button"
              />
            }
          >
            <Check className="size-3.5" strokeWidth={2.5} />
          </TooltipTrigger>
          <TooltipContent side="bottom" className="py-1">
            Select to share
          </TooltipContent>
        </Tooltip>
      ) : null}
      <button
        className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default"
        disabled={!onOpen}
        onClick={() => onOpen?.(output)}
        type="button"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted transition-colors group-hover:bg-foreground/[0.06]">
          {hasOfficeBrandIcon(iconPath) ? (
            <FileBrandIcon filePath={iconPath} size={20} />
          ) : deliverableKind ? (
            <OutputArtifactIcon output={output} variant="bare" />
          ) : (
            <FileTypeIcon filePath={iconPath} size={18} />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-foreground">
            {displayTitle}
          </span>
          <span className="truncate text-xs text-muted-foreground/80">
            {secondaryLabel}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {filePath ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Refine in chat"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRefine();
                    }}
                    className="grid size-5 place-items-center rounded text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground"
                  />
                }
              >
                <Sparkles className="size-3.5" strokeWidth={1.75} />
              </TooltipTrigger>
              <TooltipContent side="bottom" className="py-1">
                Refine in chat
              </TooltipContent>
            </Tooltip>
          ) : null}
          {workspaceId ? (
            <PinStarButton
              favorite={{
                kind: "output",
                workspaceId,
                outputId: output.id,
                title: displayTitle,
                filePath: output.file_path,
              }}
              notify
            />
          ) : null}
        </div>
        {filePath ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent"
              onClick={(e) => e.stopPropagation()}
            >
              Open in
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={6}>
              {onOpen ? (
                <DropdownMenuItem onClick={() => onOpen(output)}>
                  <Eye className="size-3.5" />
                  Open preview
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={openInDefaultApp}>
                {openInIconUrl ? (
                  <img
                    src={openInIconUrl}
                    alt=""
                    className="size-3.5 shrink-0 object-contain"
                  />
                ) : (
                  <ArrowUpRight className="size-3.5" />
                )}
                {defaultAppName ? `Open in ${defaultAppName}` : "Open in default app"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={revealInFolder}>
                <Folder className="size-3.5" />
                Reveal in Finder
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={exportFile}>
                <Download className="size-3.5" />
                Export…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}

function ResultAppRow({
  label,
  onOpen,
}: {
  label: string;
  onOpen: () => void;
}) {
  return (
    <button
      className="group flex w-full min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-foreground/[0.02] px-3.5 py-2.5 text-left transition-colors hover:bg-foreground/[0.05]"
      onClick={onOpen}
      type="button"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground transition-colors group-hover:bg-foreground/[0.06] group-hover:text-foreground">
        <LayoutGrid className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">
          {label}
        </span>
        <span className="truncate text-xs text-muted-foreground/80">App</span>
      </span>
    </button>
  );
}
