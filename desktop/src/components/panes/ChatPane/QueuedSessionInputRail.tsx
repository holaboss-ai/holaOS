import { type ReactNode, useEffect, useState } from "react";
import {
  Check,
  CornerDownLeft,
  Loader2,
  PencilLine,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  normalizeErrorMessage,
  parseSerializedQuotedSkillPrompt,
} from "./helpers";
import type { QueuedSessionInput } from "./types";

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
  children,
}: {
  items: QueuedSessionInput[];
  onEditItem?: (item: QueuedSessionInput, nextText: string) => Promise<void>;
  children: ReactNode;
}) {
  const [editingInputId, setEditingInputId] = useState("");
  const [editingDraft, setEditingDraft] = useState("");
  const [editingError, setEditingError] = useState("");
  const [savingInputId, setSavingInputId] = useState("");
  const panelInsetPx = 18;
  const panelHeightPx = 112;
  const overlapPx = 28;
  const queueViewportHeightPx = 50;
  const reservedTopPx = 94;

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

  if (items.length === 0) {
    return <>{children}</>;
  }

  return (
    <div className="relative" style={{ paddingTop: `${reservedTopPx}px` }}>
      <div className="pointer-events-none absolute inset-x-0 top-0">
        <div
          className="pointer-events-auto absolute inset-x-0 overflow-hidden rounded-3xl bg-background shadow-md"
          style={{
            left: `${panelInsetPx}px`,
            right: `${panelInsetPx}px`,
            height: `${panelHeightPx}px`,
          }}
        >
          <div className="px-4 pt-4">
            <div
              className="overflow-y-auto pr-1.5"
              style={{ maxHeight: `${queueViewportHeightPx}px` }}
            >
              <div className="space-y-1.5">
                {items.map((item) => {
                  const previewText = queuedSessionInputPreviewText(item);
                  const isEditing = editingInputId === item.inputId;
                  const isSaving = savingInputId === item.inputId;
                  return (
                    <div
                      key={item.inputId}
                      className="rounded-xl px-1 text-sm leading-7 text-foreground"
                    >
                      {isEditing ? (
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-2">
                            <CornerDownLeft className="size-4 shrink-0 text-muted-foreground" />
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
                              className="h-8 min-w-0 flex-1 rounded-lg border-border bg-background px-2.5 text-sm"
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              disabled={isSaving}
                              onClick={() => {
                                void saveEditingItem(item);
                              }}
                              className="size-7 rounded-full text-muted-foreground hover:bg-fg-6 hover:text-foreground"
                              aria-label="Save queued message edit"
                            >
                              {isSaving ? (
                                <Loader2 className="size-3.5 animate-spin" />
                              ) : (
                                <Check className="size-3.5" />
                              )}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              disabled={isSaving}
                              onClick={cancelEditing}
                              className="size-7 rounded-full text-muted-foreground hover:bg-fg-6 hover:text-foreground"
                              aria-label="Cancel queued message edit"
                            >
                              <X className="size-3.5" />
                            </Button>
                          </div>
                          {editingError ? (
                            <div className="pl-6 text-xs leading-5 text-destructive">
                              {editingError}
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <div className="flex items-center gap-3">
                          <CornerDownLeft className="size-4 shrink-0 text-muted-foreground" />
                          <div className="min-w-0 flex-1 truncate">
                            {previewText || "Queued message"}
                          </div>
                          {onEditItem && item.status === "queued" ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              onClick={() => {
                                setEditingInputId(item.inputId);
                                setEditingDraft(previewText);
                                setEditingError("");
                              }}
                              className="size-7 rounded-full text-muted-foreground hover:bg-fg-6 hover:text-foreground"
                              aria-label="Edit queued message"
                            >
                              <PencilLine className="size-3.5" />
                            </Button>
                          ) : null}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div
        className="relative z-10 rounded-3xl bg-background"
        style={{ marginTop: `${-overlapPx}px` }}
      >
        {children}
      </div>
    </div>
  );
}
