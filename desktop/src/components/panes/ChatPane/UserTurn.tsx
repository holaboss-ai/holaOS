import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EntityChip } from "@/components/ui/entity-chip";
import { EntityMention } from "@/components/ui/entity-mention";
import { SimpleMarkdown } from "@/components/marketplace/SimpleMarkdown";
import { AttachmentList } from "./AttachmentList";
import {
  chatMessageTimeLabel,
  injectMentionLinks,
  parseSerializedQuotedSkillPrompt,
} from "./helpers";
import type { AttachmentListItem, ChatAttachment } from "./types";

async function copyTextToClipboard(value: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  if (typeof document === "undefined") {
    throw new Error("Clipboard is unavailable.");
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);

  if (!copied) {
    throw new Error("Clipboard copy failed.");
  }
}

export const UserTurn = memo(UserTurnComponent, (prev, next) =>
  prev.text === next.text &&
  prev.createdAt === next.createdAt &&
  prev.attachments === next.attachments,
);

function UserTurnComponent({
  text,
  createdAt,
  attachments,
  onPreviewAttachment,
  onLinkClick,
  onLocalLinkClick,
}: {
  text: string;
  createdAt?: string;
  attachments: ChatAttachment[];
  onPreviewAttachment?: (attachment: AttachmentListItem) => void;
  onLinkClick?: (url: string) => void;
  onLocalLinkClick?: (href: string) => void;
}) {
  const [copyFeedbackVisible, setCopyFeedbackVisible] = useState(false);
  const copyResetTimerRef = useRef<number | null>(null);
  const timeLabel = chatMessageTimeLabel(createdAt);
  const canCopy = text.trim().length > 0;
  const showHoverFooter = canCopy || Boolean(timeLabel);
  const parsedQuotedSkills = useMemo(
    () => parseSerializedQuotedSkillPrompt(text),
    [text],
  );
  const userBubbleText = parsedQuotedSkills.body || text.trim();

  const bubbleContentRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showExpandButton, setShowExpandButton] = useState(false);

  useEffect(() => {
    const node = bubbleContentRef.current;
    if (!node) {
      return;
    }
    // 180px ~= 6–7 lines of chat-user-markdown at 0.875rem / 1.6 leading.
    setShowExpandButton(node.scrollHeight > 188);
  }, [userBubbleText]);

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    if (!canCopy) {
      return;
    }

    try {
      await copyTextToClipboard(text);
    } catch {
      return;
    }
    setCopyFeedbackVisible(true);
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = window.setTimeout(() => {
      setCopyFeedbackVisible(false);
      copyResetTimerRef.current = null;
    }, 1600);
  };

  return (
    <div className="group/user-turn flex min-w-0 justify-end">
      <div
        className={`relative z-0 flex min-w-0 max-w-[80%] flex-col items-end gap-2 group-hover/user-turn:z-10 group-focus-within/user-turn:z-10 ${showHoverFooter ? "pb-7" : ""}`.trim()}
      >
        {parsedQuotedSkills.skillIds.length > 0 ? (
          <div className="flex max-w-full flex-wrap justify-end gap-1">
            {parsedQuotedSkills.skillIds.map((skillId) => (
              <EntityChip
                key={skillId}
                icon={<Sparkles className="text-muted-foreground" />}
                label={`/${skillId}`}
              />
            ))}
          </div>
        ) : null}
        {userBubbleText ? (
          <div className="theme-chat-user-bubble inline-flex min-w-0 max-w-full flex-col items-stretch rounded-lg px-3 py-1.5 text-foreground">
            <div
              ref={bubbleContentRef}
              className="relative overflow-hidden transition-[max-height] duration-300 ease-out"
              style={{
                maxHeight: showExpandButton && !isExpanded ? 180 : undefined,
              }}
            >
              <SimpleMarkdown
                className="chat-markdown chat-user-markdown max-w-full"
                onLinkClick={onLinkClick}
                onLocalLinkClick={onLocalLinkClick}
                renderMention={(handle) => (
                  <EntityMention label={handle} />
                )}
              >
                {injectMentionLinks(userBubbleText)}
              </SimpleMarkdown>
              {showExpandButton && !isExpanded ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-10"
                  style={{
                    background:
                      "linear-gradient(to bottom, transparent, color-mix(in oklch, var(--muted) 85%, var(--foreground) 4%))",
                  }}
                />
              ) : null}
            </div>
            {showExpandButton ? (
              <button
                type="button"
                onClick={() => setIsExpanded((value) => !value)}
                className="mt-1.5 self-start text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {isExpanded ? "Show less" : "Show more"}
              </button>
            ) : null}
          </div>
        ) : null}
        {attachments.length > 0 ? (
          <AttachmentList
            attachments={attachments}
            className="justify-end"
            onPreview={onPreviewAttachment}
          />
        ) : null}
        {showHoverFooter ? (
          <div className="absolute bottom-0 right-1 flex w-max min-w-max max-w-none items-center gap-2 whitespace-nowrap text-xs text-muted-foreground opacity-0 pointer-events-none transition-opacity duration-150 group-hover/user-turn:opacity-100 group-hover/user-turn:pointer-events-auto group-focus-within/user-turn:opacity-100 group-focus-within/user-turn:pointer-events-auto">
            {canCopy ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={
                  copyFeedbackVisible
                    ? "Copied user message"
                    : "Copy user message"
                }
                onClick={() => {
                  void handleCopy();
                }}
                className="size-6 rounded-lg text-muted-foreground hover:bg-fg-6 hover:text-foreground"
              >
                {copyFeedbackVisible ? (
                  <Check className="size-3.5" strokeWidth={1.9} />
                ) : (
                  <Copy className="size-3.5" strokeWidth={1.9} />
                )}
              </Button>
            ) : null}
            {timeLabel ? (
              <span className="select-none whitespace-nowrap text-[10px] leading-none tabular-nums">
                {timeLabel}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
