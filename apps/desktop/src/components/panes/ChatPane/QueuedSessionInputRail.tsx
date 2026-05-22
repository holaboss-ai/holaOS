import { type ReactNode, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  CornerDownLeft,
  Loader2,
  PencilLine,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  normalizeErrorMessage,
  parseSerializedQuotedSkillPrompt,
} from "./helpers";
import type { QueuedSessionInput } from "./types";

// Linear-style spring: lively but lands clean.
const PANEL_SPRING = {
  type: "spring" as const,
  stiffness: 380,
  damping: 34,
  mass: 0.7,
};

const ITEM_SPRING = {
  type: "spring" as const,
  stiffness: 420,
  damping: 32,
  mass: 0.55,
};

const SOFT_EASE = [0.16, 1, 0.3, 1] as const;

const INSET_PX = 14;
const OVERLAP_PX = 24;
const ITEM_ROW_HEIGHT_PX = 32;
const PANEL_TOP_PAD_PX = 12;
const PANEL_BOTTOM_PAD_PX = 12;
const PANEL_SIDE_PAD_PX = 6;
const MAX_VISIBLE_ITEMS = 3;

export function queuedSessionInputPreviewText(item: QueuedSessionInput) {
  const parsedQuotedSkills = parseSerializedQuotedSkillPrompt(item.text);
  const previewText =
    parsedQuotedSkills.body ||
    parsedQuotedSkills.skillIds.map((skillId) => `/${skillId}`).join(" ");
  return previewText.replace(/\s+/g, " ").trim();
}

export function QueuedSessionInputRail({
  items,
  onEditItem,
  onCancelItem,
  children,
}: {
  items: QueuedSessionInput[];
  onEditItem?: (item: QueuedSessionInput, nextText: string) => Promise<void>;
  onCancelItem?: (item: QueuedSessionInput) => Promise<void>;
  children: ReactNode;
}) {
  const [editingInputId, setEditingInputId] = useState("");
  const [editingDraft, setEditingDraft] = useState("");
  const [editingError, setEditingError] = useState("");
  const [savingInputId, setSavingInputId] = useState("");
  const [cancellingInputId, setCancellingInputId] = useState("");

  useEffect(() => {
    if (!editingInputId) {
      return;
    }
    const activeItem = items.find((item) => item.inputId === editingInputId);
    if (!activeItem || activeItem.status !== "queued") {
      setEditingInputId("");
      setEditingDraft("");
      setEditingError("");
      setSavingInputId("");
    }
  }, [editingInputId, items]);

  const cancelEditing = () => {
    setEditingInputId("");
    setEditingDraft("");
    setEditingError("");
    setSavingInputId("");
  };

  const saveEditingItem = async (item: QueuedSessionInput) => {
    if (!onEditItem || savingInputId || item.status !== "queued") {
      return;
    }
    setEditingError("");
    setSavingInputId(item.inputId);
    try {
      await onEditItem(item, editingDraft);
      cancelEditing();
    } catch (error) {
      setEditingError(normalizeErrorMessage(error));
    } finally {
      setSavingInputId("");
    }
  };

  const cancelItem = async (item: QueuedSessionInput) => {
    if (!onCancelItem || cancellingInputId || item.status !== "queued") {
      return;
    }
    setCancellingInputId(item.inputId);
    try {
      await onCancelItem(item);
    } catch {
      setCancellingInputId("");
    }
  };

  const visibleCount = Math.min(items.length, MAX_VISIBLE_ITEMS);
  const contentHeightPx = visibleCount * ITEM_ROW_HEIGHT_PX;
  const peekHeightPx =
    contentHeightPx + PANEL_TOP_PAD_PX + PANEL_BOTTOM_PAD_PX;
  // The composer overlaps the panel's bottom OVERLAP_PX px via marginTop,
  // so the panel needs the extra height to keep the visible peek = peekHeight.
  const panelHeightPx = peekHeightPx + OVERLAP_PX;
  // Parent reserves the full panel height; the composer's marginTop of
  // -OVERLAP_PX then lands its top edge exactly at peekHeight.
  const reservedTopPx = items.length > 0 ? panelHeightPx : 0;

  return (
    <motion.div
      className="relative"
      animate={{ paddingTop: reservedTopPx }}
      transition={PANEL_SPRING}
      initial={false}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0">
        <AnimatePresence initial={false}>
          {items.length > 0 ? (
            <motion.div
              key="queue-panel"
              initial={{ opacity: 0, y: -8, scale: 0.985 }}
              animate={{
                opacity: 1,
                y: 0,
                scale: 1,
                height: panelHeightPx,
              }}
              exit={{ opacity: 0, y: -6, scale: 0.985 }}
              transition={PANEL_SPRING}
              style={{
                left: `${INSET_PX}px`,
                right: `${INSET_PX}px`,
              }}
              className="pointer-events-auto absolute inset-x-0 overflow-hidden rounded-2xl border border-border/60 bg-background shadow-sm"
            >
              <div
                style={{
                  paddingTop: `${PANEL_TOP_PAD_PX}px`,
                  paddingBottom: `${PANEL_BOTTOM_PAD_PX}px`,
                  paddingLeft: `${PANEL_SIDE_PAD_PX}px`,
                  paddingRight: `${PANEL_SIDE_PAD_PX}px`,
                }}
              >
                <div
                  className="overflow-x-hidden overflow-y-auto"
                  style={{
                    maxHeight: `${MAX_VISIBLE_ITEMS * ITEM_ROW_HEIGHT_PX}px`,
                  }}
                >
                  <AnimatePresence initial={false} mode="popLayout">
                    {items.map((item) => {
                      const previewText = queuedSessionInputPreviewText(item);
                      const isEditing = editingInputId === item.inputId;
                      const isSaving = savingInputId === item.inputId;
                      const isQueued = item.status === "queued";
                      const canEdit = Boolean(onEditItem && isQueued);
                      const canCancel = Boolean(onCancelItem && isQueued);
                      const showActions = canEdit || canCancel;
                      return (
                        <motion.div
                          key={item.inputId}
                          layout="position"
                          initial={{
                            opacity: 0,
                            y: -6,
                            filter: "blur(2px)",
                          }}
                          animate={{
                            opacity: item.status === "sending" ? 0.55 : 1,
                            y: 0,
                            filter: "blur(0px)",
                          }}
                          exit={{
                            opacity: 0,
                            y: -4,
                            filter: "blur(2px)",
                          }}
                          transition={ITEM_SPRING}
                          className="group/queue-item rounded-lg px-2 transition-colors hover:bg-fg-2"
                        >
                          <AnimatePresence initial={false} mode="wait">
                            {isEditing ? (
                              <motion.div
                                key="edit"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{
                                  duration: 0.12,
                                  ease: SOFT_EASE,
                                }}
                                className="flex flex-col gap-1"
                              >
                                <div className="flex h-8 items-center gap-1.5">
                                  <CornerDownLeft className="size-3 shrink-0 text-muted-foreground/70" />
                                  <Input
                                    value={editingDraft}
                                    onChange={(event) =>
                                      setEditingDraft(event.target.value)
                                    }
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter") {
                                        event.preventDefault();
                                        void saveEditingItem(item);
                                      } else if (event.key === "Escape") {
                                        event.preventDefault();
                                        cancelEditing();
                                      }
                                    }}
                                    disabled={isSaving}
                                    autoFocus
                                    className="h-7 min-w-0 flex-1 rounded-md border-border/70 bg-background px-2 text-[13px]"
                                  />
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-xs"
                                    disabled={isSaving}
                                    onClick={() => {
                                      void saveEditingItem(item);
                                    }}
                                    className="size-6 rounded-md text-muted-foreground hover:bg-fg-6 hover:text-foreground"
                                    aria-label="Save queued message edit"
                                  >
                                    {isSaving ? (
                                      <Loader2 className="size-3 animate-spin" />
                                    ) : (
                                      <Check className="size-3" />
                                    )}
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-xs"
                                    disabled={isSaving}
                                    onClick={cancelEditing}
                                    className="size-6 rounded-md text-muted-foreground hover:bg-fg-6 hover:text-foreground"
                                    aria-label="Cancel queued message edit"
                                  >
                                    <X className="size-3" />
                                  </Button>
                                </div>
                                {editingError ? (
                                  <div className="pb-1 pl-[18px] text-[11px] leading-4 text-destructive">
                                    {editingError}
                                  </div>
                                ) : null}
                              </motion.div>
                            ) : (
                              <motion.div
                                key="view"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{
                                  duration: 0.12,
                                  ease: SOFT_EASE,
                                }}
                                className="flex h-8 items-center gap-2"
                              >
                                <CornerDownLeft className="size-3 shrink-0 text-muted-foreground/70" />
                                <div className="min-w-0 flex-1 truncate text-[13px] leading-5 text-foreground/85">
                                  {previewText || "Queued message"}
                                </div>
                                {showActions ? (
                                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 ease-out focus-within:opacity-100 group-hover/queue-item:opacity-100">
                                    {canEdit ? (
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-xs"
                                        disabled={
                                          cancellingInputId === item.inputId
                                        }
                                        onClick={() => {
                                          setEditingInputId(item.inputId);
                                          setEditingDraft(previewText);
                                          setEditingError("");
                                        }}
                                        className="size-6 rounded-md text-muted-foreground/70 hover:bg-fg-6 hover:text-foreground"
                                        aria-label="Edit queued message"
                                      >
                                        <PencilLine className="size-3" />
                                      </Button>
                                    ) : null}
                                    {canCancel ? (
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-xs"
                                        disabled={
                                          cancellingInputId === item.inputId
                                        }
                                        onClick={() => {
                                          void cancelItem(item);
                                        }}
                                        className="size-6 rounded-md text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive"
                                        aria-label="Cancel queued message"
                                      >
                                        {cancellingInputId === item.inputId ? (
                                          <Loader2 className="size-3 animate-spin" />
                                        ) : (
                                          <Trash2 className="size-3" />
                                        )}
                                      </Button>
                                    ) : null}
                                  </div>
                                ) : null}
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      <motion.div
        className="relative z-10 rounded-3xl bg-background"
        animate={{ marginTop: items.length > 0 ? -OVERLAP_PX : 0 }}
        transition={PANEL_SPRING}
        initial={false}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}
