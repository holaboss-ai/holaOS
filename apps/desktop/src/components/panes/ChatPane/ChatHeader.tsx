import { Boxes, Clock3, History, Inbox, PanelLeftClose } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/components/ui/agent-avatar";
import { StatusDot } from "@/components/ui/status-dot";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ChatHeaderProps {
  agentName: string;
  workspace: WorkspaceRecordPayload | null;
  subtitle?: string;
  onReturnToMainSession?: () => void;
  onOpenSessions?: () => void;
  onOpenInbox?: () => void;
  inboxUnreadCount: number;
  onOpenAutomations?: () => void;
  onOpenArtifacts?: () => void;
  /**
   * When provided, renders a leading PanelLeftClose icon button as the
   * leftmost element of the header. Wired by the new shell to enter
   * chat-focus layout (collapses the middle column). Optional so the
   * legacy AppShell — which has no focus mode — stays unchanged.
   */
  onEnterFocusMode?: () => void;
}

export function ChatHeader({
  agentName,
  workspace,
  subtitle,
  onReturnToMainSession,
  onOpenSessions,
  onOpenInbox,
  inboxUnreadCount,
  onOpenAutomations,
  onOpenArtifacts,
  onEnterFocusMode,
}: ChatHeaderProps) {
  const seed = workspace?.id ?? agentName ?? "default";

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {onEnterFocusMode ? (
          <TooltipProvider delay={250}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onEnterFocusMode()}
                    aria-label="Focus on chat"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <PanelLeftClose
                      className="size-4"
                      strokeWidth={1.5}
                    />
                  </Button>
                }
              />
              <TooltipContent>Focus on chat</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
        <AgentAvatar seed={seed} size="sm" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-foreground">
            {agentName}
          </span>
          {subtitle ? (
            <span className="truncate text-[11px] leading-tight text-muted-foreground">
              {subtitle}
            </span>
          ) : null}
        </div>
      </div>

      <TooltipProvider delay={250}>
        <div className="flex shrink-0 items-center gap-0.5">
          {onOpenSessions ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onOpenSessions()}
                    aria-label="Sessions"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <History className="size-4" />
                  </Button>
                }
              />
              <TooltipContent>Sessions</TooltipContent>
            </Tooltip>
          ) : null}

          {onOpenInbox ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onOpenInbox()}
                    aria-label="Inbox"
                    className="relative text-muted-foreground hover:text-foreground"
                  >
                    <Inbox className="size-4" />
                    {inboxUnreadCount > 0 ? (
                      <StatusDot
                        variant="destructive"
                        size="sm"
                        className="absolute right-1 top-1 border border-card"
                      />
                    ) : null}
                  </Button>
                }
              />
              <TooltipContent>Inbox</TooltipContent>
            </Tooltip>
          ) : null}

          {onOpenAutomations ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onOpenAutomations()}
                    aria-label="Automations"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Clock3 className="size-4" />
                  </Button>
                }
              />
              <TooltipContent>Automations</TooltipContent>
            </Tooltip>
          ) : null}

          {onOpenArtifacts ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onOpenArtifacts()}
                    aria-label="Artifacts"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Boxes className="size-4" />
                  </Button>
                }
              />
              <TooltipContent>Artifacts</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </TooltipProvider>
    </div>
  );
}
