import { HarnessAvatar } from "@/components/harness/HarnessAvatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Image,
  MessageCircle,
  PanelLeftOpen,
  PanelRightOpen,
  Upload,
} from "@/components/ui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WorkspaceIcon } from "@/components/ui/workspace-icon";
import {
  chatShareActionAtom,
  type ShareMode,
  type ShareSessionPayload,
} from "@/components/layout/shell/state/ui";
import { useOpenSharePreview } from "@/components/layout/shell/useOpenSharePreview";
import { cn } from "@/lib/utils";
import { useAtomValue, useSetAtom } from "jotai";
import { type CSSProperties, useCallback, useEffect, useRef } from "react";
import { ChatContextPopover, ChatContextToggle } from "./ChatContextPopover";

interface ChatHeaderProject {
  id: string;
  name: string;
  icon?: string | null;
  icon_color?: string | null;
}

interface ChatHeaderProps {
  agentName: string;
  subtitle?: string;
  /**
   * Harness driving the session — brands the leading avatar (Claude/Codex
   * show their own mark; pi keeps the Hola monogram).
   */
  harnessId?: string | null;
  /**
   * The active project. When set, its icon + name replace the agent
   * monogram + label in the leading identity block.
   */
  project?: ChatHeaderProject | null;
  onReturnToMainSession?: () => void;
  onOpenArtifacts?: () => void;
  outputsHasNew?: boolean;
  /**
   * Hides the leading avatar + agent name block. Used for the empty
   * "What can I help with?" state where the title is implied.
   */
  showAgentLabel?: boolean;
}

/** Just the leading identity block — the controls live in ChatHeaderToolbar,
 * rendered by the shell at the panel's far-right so they clear the centered
 * chat column and sit above the docked context card. */
export function ChatHeader({
  agentName,
  subtitle,
  harnessId = null,
  project,
  showAgentLabel = true,
}: ChatHeaderProps) {
  if (!showAgentLabel) return <div className="h-5" />;
  const title = project?.name?.trim() || agentName;
  return (
    <div className="flex min-w-0 items-center gap-2">
      {project ? (
        <WorkspaceIcon workspace={project} size="sm" className="shrink-0" />
      ) : (
        <HarnessAvatar harnessId={harnessId} size="sm" className="shrink-0" />
      )}
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-foreground">
          {title}
        </span>
        {subtitle ? (
          <span className="truncate text-xs leading-tight text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Publishes the active chat's "share to HolaHub" action to the shell, so the
 *  Share control can live in the right-side toolbar instead of the identity
 *  block. Renders nothing. `buildPayload` may be recreated each render (kept in a
 *  ref); the published action stays stable and is only (un)set as `enabled` /
 *  `hasOutputs` change — so streaming doesn't rewrite the atom on every token. */
export function ChatSharePublisher({
  enabled,
  hasOutputs,
  buildPayload,
}: {
  enabled: boolean;
  /** Whether the conversation produced shareable media — gates "Share outputs". */
  hasOutputs: boolean;
  buildPayload: () => ShareSessionPayload;
}) {
  const openSharePreview = useOpenSharePreview();
  const setAction = useSetAtom(chatShareActionAtom);
  const buildRef = useRef(buildPayload);
  buildRef.current = buildPayload;
  const open = useCallback(
    (mode: ShareMode) => openSharePreview(buildRef.current(), mode),
    [openSharePreview]
  );
  useEffect(() => {
    setAction(enabled ? { open, hasOutputs } : null);
    return () => setAction(null);
  }, [enabled, hasOutputs, open, setAction]);
  return null;
}

const SHARE_BTN =
  "flex h-7 items-center gap-1.5 rounded-lg px-2 text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground";

/** Share to HolaHub — a labeled action grouped with the other header controls on
 *  the right. Reads the action ChatPane publishes to `chatShareActionAtom`. When
 *  the conversation produced shareable outputs it's a dropdown ("Share
 *  conversation" / "Share outputs"); otherwise a plain button that shares the
 *  conversation. Renders nothing when there's nothing to share. */
function ShareSessionButton() {
  const action = useAtomValue(chatShareActionAtom);
  if (!action) return null;
  if (!action.hasOutputs) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Share conversation to HolaHub"
              onClick={() => action.open("conversation")}
              className={SHARE_BTN}
            />
          }
        >
          <Upload className="size-4" strokeWidth={1.75} />
          <span className="text-xs font-medium">Share</span>
        </TooltipTrigger>
        <TooltipContent>Share conversation to HolaHub</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Share to HolaHub" className={SHARE_BTN}>
        <Upload className="size-4" strokeWidth={1.75} />
        <span className="text-xs font-medium">Share</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6}>
        <DropdownMenuItem onClick={() => action.open("conversation")}>
          <MessageCircle className="size-3.5" />
          Share conversation
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => action.open("outputs")}>
          <Image className="size-3.5" />
          Share outputs
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The stable chat toolbar — Outputs + a panel toggle, present in every layout.
 * The shell positions it (absolute, far-right) so it stays at the panel edge
 * regardless of how narrow/centered the chat column is.
 */
export function ChatHeaderToolbar({
  className,
  style,
  pinned,
  cardCollapsed,
  onToggleCard,
  panelHidden,
  onTogglePanel,
  outputsHasNew = false,
  onOpenArtifacts,
  onContextOpen,
}: {
  className?: string;
  style?: CSSProperties;
  /** Chat owns the canvas → Outputs docks as a card (toggle); else popover. */
  pinned: boolean;
  cardCollapsed: boolean;
  onToggleCard: () => void;
  /** The middle tab panel is currently hidden (chat is the canvas). */
  panelHidden: boolean;
  onTogglePanel: () => void;
  outputsHasNew?: boolean;
  onOpenArtifacts?: () => void;
  /** Opening the popover counts as viewing outputs — clears the "new" dot. */
  onContextOpen?: () => void;
}) {
  return (
    <div className={cn("flex items-center gap-0.5", className)} style={style}>
      <ShareSessionButton />
      {pinned ? (
        <ChatContextToggle
          expanded={!cardCollapsed}
          onToggle={onToggleCard}
          hasNew={outputsHasNew}
        />
      ) : (
        <ChatContextPopover
          onOpenAll={onOpenArtifacts}
          hasNew={outputsHasNew}
          onOpen={onContextOpen}
        />
      )}
      <PanelToggle panelHidden={panelHidden} onToggle={onTogglePanel} />
    </div>
  );
}

/** Show ⇄ hide the middle tab panel. Always present so the toolbar is stable. */
function PanelToggle({
  panelHidden,
  onToggle,
}: {
  panelHidden: boolean;
  onToggle: () => void;
}) {
  const label = panelHidden ? "Show tabs panel" : "Hide tabs panel";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={onToggle}
            className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground"
          />
        }
      >
        {panelHidden ? (
          <PanelLeftOpen className="size-4" strokeWidth={1.75} />
        ) : (
          <PanelRightOpen className="size-4" strokeWidth={1.75} />
        )}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
