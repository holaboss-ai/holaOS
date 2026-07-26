import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSetAtom } from "jotai";
import { Check, ChevronRight, Copy, PenLine } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import {
  chatComposerPrefillAtom,
  nextComposerPrefillKey,
} from "@/components/layout/shell/state/ui";
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
  const setComposerPrefill = useSetAtom(chatComposerPrefillAtom);
  const timeLabel = chatMessageTimeLabel(createdAt);
  const canCopy = text.trim().length > 0;
  const showHoverFooter = canCopy || Boolean(timeLabel);
  const parsedQuotedSkills = useMemo(
    () => parseSerializedQuotedSkillPrompt(text),
    [text],
  );
  const userBubbleText = parsedQuotedSkills.body || text.trim();
  const refTokens = [
    ...parsedQuotedSkills.skillIds.map((id) => `/${id}`),
    ...parsedQuotedSkills.integrationSlugs.map((slug) => `@${slug}`),
  ];

  const bubbleContentRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showQuotedRefs, setShowQuotedRefs] = useState(false);
  const [showExpandButton, setShowExpandButton] = useState(false);

  // Measure before paint — a post-paint effect would show a long message at
  // full height for one frame, then collapse with the max-height transition
  // (the visible flash on submit).
  useLayoutEffect(() => {
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

  // Seed the composer with this message so the user can edit and resend it.
  // Reuses the composer-prefill atom (same path as "Refine in chat"); the
  // resend creates a normal new turn in the current session — no in-place edit.
  const handleEditResend = () => {
    if (!canCopy) {
      return;
    }
    setComposerPrefill({
      text: userBubbleText,
      requestKey: nextComposerPrefillKey(),
      mode: "replace",
      sessionMode: "preserve",
      autoSubmit: false,
    });
  };

  return (
    <div className="group/user-turn flex min-w-0 justify-end">
      <div
        className={`relative z-0 flex min-w-0 max-w-[min(75%,40rem)] flex-col items-end gap-2 group-hover/user-turn:z-10 group-focus-within/user-turn:z-10 ${showHoverFooter ? "pb-7" : ""}`.trim()}
      >
        {refTokens.length > 0 ? (
          <div className="flex max-w-full flex-col items-end gap-1">
            <button
              className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setShowQuotedRefs((value) => !value)}
              type="button"
            >
              <ChevronRight
                className={`size-3 transition-transform ${
                  showQuotedRefs ? "rotate-90" : ""
                }`}
              />
              {refTokens.length}{" "}
              {refTokens.length === 1 ? "reference" : "references"}
            </button>
            {showQuotedRefs ? (
              <div className="max-w-full text-right text-[11px] text-muted-foreground">
                {refTokens.join("  ·  ")}
              </div>
            ) : null}
          </div>
        ) : null}
        {userBubbleText ? (
          <div className="theme-chat-user-bubble inline-flex min-w-0 max-w-full flex-col items-stretch rounded-lg px-3 py-1.5 text-foreground">
            <div
              ref={bubbleContentRef}
              className="relative overflow-hidden transition-[max-height] duration-stride ease-emphasized"
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
                aria-label="Edit and resend message"
                onClick={handleEditResend}
                className="size-6 rounded-lg text-muted-foreground hover:bg-fg-6 hover:text-foreground"
              >
                <PenLine className="size-3.5" strokeWidth={1.9} />
              </Button>
            ) : null}
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
              <span className="select-none whitespace-nowrap text-xs leading-none tabular-nums">
                {timeLabel}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
