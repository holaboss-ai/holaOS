import { Clock3, FileStack, Inbox, MessageCircle } from "lucide-react";
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
  onViewAllArtifacts?: () => void;
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
  onViewAllArtifacts,
}: ChatHeaderProps) {
  const seed = workspace?.id ?? agentName ?? "default";

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
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
                    <MessageCircle className="size-4" />
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

          {onViewAllArtifacts ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onViewAllArtifacts()}
                    aria-label="View all artifacts"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <FileStack className="size-4" />
                  </Button>
                }
              />
              <TooltipContent>All artifacts</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </TooltipProvider>
    </div>
  );
}
