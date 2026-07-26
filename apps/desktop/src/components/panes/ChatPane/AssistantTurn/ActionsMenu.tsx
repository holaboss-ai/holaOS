import { useState } from "react";
import {
  Check,
  Copy,
  FileCode2,
  ListTree,
  MoreHorizontal,
  Upload,
} from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface AssistantTurnActionsMenuProps {
  copyText: string;
  onViewTurnDetails?: () => void;
  onViewFileChanges?: () => void;
  onShareToHolahub?: () => void;
  hasFileEdits?: boolean;
}

export function AssistantTurnActionsMenu({
  copyText,
  onViewTurnDetails,
  onViewFileChanges,
  onShareToHolahub,
  hasFileEdits,
}: AssistantTurnActionsMenuProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!copyText) {
      return;
    }
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }

  const showFileChanges = Boolean(onViewFileChanges) && Boolean(hasFileEdits);
  const canCopy = copyText.trim().length > 0;
  const canShare = Boolean(onShareToHolahub);
  const hasOverflowItems = Boolean(onViewTurnDetails) || showFileChanges;

  if (!canCopy && !canShare && !hasOverflowItems) {
    return null;
  }

  return (
    <div className="flex items-center gap-0.5">
      {canCopy ? (
        <Button
          aria-label={copied ? "Copied message" : "Copy message"}
          className="size-6 rounded-lg text-muted-foreground hover:bg-fg-6 hover:text-foreground"
          size="icon-xs"
          type="button"
          variant="ghost"
          onClick={() => void handleCopy()}
        >
          {copied ? (
            <Check className="size-3.5" strokeWidth={1.9} />
          ) : (
            <Copy className="size-3.5" strokeWidth={1.9} />
          )}
        </Button>
      ) : null}
      {canShare ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Share to HolaHub"
                className="size-6 rounded-lg text-muted-foreground hover:bg-fg-6 hover:text-foreground"
                onClick={onShareToHolahub}
                size="icon-xs"
                type="button"
                variant="ghost"
              />
            }
          >
            <Upload className="size-3.5" strokeWidth={1.9} />
          </TooltipTrigger>
          <TooltipContent>Share to HolaHub</TooltipContent>
        </Tooltip>
      ) : null}
      {hasOverflowItems ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label="Turn actions"
                className="size-6 rounded-lg text-muted-foreground hover:bg-fg-6 hover:text-foreground"
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <MoreHorizontal className="size-3.5" strokeWidth={1.9} />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-44" sideOffset={4}>
            {onViewTurnDetails ? (
              <DropdownMenuItem onClick={onViewTurnDetails}>
                <ListTree />
                View turn details
              </DropdownMenuItem>
            ) : null}
            {showFileChanges ? (
              <DropdownMenuItem onClick={onViewFileChanges}>
                <FileCode2 />
                View file changes
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
