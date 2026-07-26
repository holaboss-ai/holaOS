import { AtSign } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useReferenceFileInChat } from "./useReferenceFileInChat";

interface MentionInChatButtonProps {
  /** Absolute path of the file being previewed. */
  absolutePath: string;
}

/**
 * Compact toolbar button that drops the currently-previewed file into the
 * chat composer as a removable reference chip (its full path lives in the
 * chip's hover tooltip), so the user points the agent at the document
 * without a raw `@path` cluttering the message text.
 */
export function MentionInChatButton({ absolutePath }: MentionInChatButtonProps) {
  const referenceFileInChat = useReferenceFileInChat();

  if (!absolutePath) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Reference this file in chat"
            onClick={() => referenceFileInChat(absolutePath)}
            className="text-foreground/55 hover:text-foreground"
          />
        }
      >
        <AtSign className="size-3.5" strokeWidth={1.75} />
      </TooltipTrigger>
      <TooltipContent side="bottom" className="py-1">
        Reference in chat
      </TooltipContent>
    </Tooltip>
  );
}
