import {
  type ChangeEvent,
  type ClipboardEvent,
  type CompositionEvent,
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronRight,
  Loader2,
  Paperclip,
  Plus,
  Search,
  Sparkles,
  Square,
  Wand2,
  Waypoints,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EntityChip } from "@/components/ui/entity-chip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  EXPLORER_ATTACHMENT_DRAG_TYPE,
  type ExplorerAttachmentDragPayload,
  parseExplorerAttachmentDragPayload,
} from "@/lib/attachmentDrag";
import { getExplorerAttachmentClipboardEntry } from "@/lib/appClipboard";
import { AttachmentList } from "../AttachmentList";
import {
  COMPOSER_FOOTER_GAP_PX,
  COMPOSER_FULL_MODEL_CONTROL_WIDTH_PX,
  COMPOSER_FULL_PROVIDER_SETUP_WIDTH_PX,
  COMPOSER_FULL_THINKING_CONTROL_WIDTH_PX,
  COMPOSER_COMPACT_MODEL_CONTROL_MAX_WIDTH_PX,
  COMPOSER_COMPACT_THINKING_CONTROL_MAX_WIDTH_PX,
  COMPOSER_COMPACT_THINKING_CONTROL_MIN_WIDTH_PX,
} from "../constants";
import {
  findActiveMentionRange,
  findActiveSlashCommandRange,
  removeSlashCommandText,
  replaceMentionText,
} from "../helpers";
import type {
  AttachmentListItem,
  ChatComposerMentionItem,
  ChatComposerQuotedSkillItem,
  ChatComposerSlashCommandOption,
  ChatModelOption,
  ChatModelOptionGroup,
} from "../types";
import { ModelCombobox } from "./ModelCombobox";
import { ThinkingValueSelect } from "./ThinkingValueSelect";

interface ComposerProps {
  input: string;
  quotedSkills: ChatComposerQuotedSkillItem[];
  slashCommands: ChatComposerSlashCommandOption[];
  attachments: AttachmentListItem[];
  isResponding: boolean;
  pausePending: boolean;
  pauseDisabled: boolean;
  disabled: boolean;
  disabledReason?: string;
  selectedModel: string;
  resolvedModelLabel: string;
  runtimeDefaultModelLabel: string;
  modelOptions: ChatModelOption[];
  modelOptionGroups: ChatModelOptionGroup[];
  runtimeDefaultModelAvailable: boolean;
  selectedThinkingValue: string | null;
  thinkingValues: string[];
  showThinkingValueSelector: boolean;
  modelSelectionUnavailableReason: string;
  submitDisabled?: boolean;
  placeholder: string;
  showModelSelector: boolean;
  onModelChange: (value: string) => void;
  onThinkingValueChange: (value: string | null) => void;
  onOpenModelProviders: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onCompositionStart: (event: CompositionEvent<HTMLTextAreaElement>) => void;
  onCompositionEnd: (event: CompositionEvent<HTMLTextAreaElement>) => void;
  onAttachmentInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onPause: () => void;
  onAddDroppedFiles: (files: File[]) => void;
  onAddExplorerAttachments: (files: ExplorerAttachmentDragPayload[]) => void;
  onSelectSlashCommand: (command: ChatComposerSlashCommandOption) => void;
  /** Items the `@` picker offers — currently workspaces, future:
   *  apps / sessions / memories. Pre-shaped so the picker is just a
   *  presenter; the parent decides what's mentionable. */
  mentionableItems?: ChatComposerMentionItem[];
  onRemoveQuotedSkill: (skillId: string) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onPreviewAttachment: (attachment: AttachmentListItem) => void;
}

function attachmentFileExtension(mimeType?: string | null): string {
  const normalizedMimeType = (mimeType ?? "").trim().toLowerCase();
  if (!normalizedMimeType.includes("/")) {
    return "bin";
  }
  const subtype = normalizedMimeType.split("/")[1]?.split("+")[0]?.trim() || "";
  if (!subtype) {
    return "bin";
  }
  if (subtype === "jpeg") {
    return "jpg";
  }
  if (subtype === "svg") {
    return "svg";
  }
  return subtype;
}

function normalizeClipboardAttachmentFile(file: File, index: number): File {
  if (file.name.trim()) {
    return file;
  }

  const extension = attachmentFileExtension(file.type);
  const baseName = file.type.startsWith("image/")
    ? `pasted-image-${index + 1}`
    : `pasted-file-${index + 1}`;
  return new File([file], `${baseName}.${extension}`, {
    type: file.type,
    lastModified: file.lastModified || Date.now(),
  });
}

function clipboardFilesFromDataTransfer(
  dataTransfer: DataTransfer | null,
): File[] {
  if (!dataTransfer) {
    return [];
  }

  const clipboardFiles =
    dataTransfer.files.length > 0
      ? Array.from(dataTransfer.files)
      : Array.from(dataTransfer.items ?? []).flatMap((item) => {
          if (item.kind !== "file") {
            return [];
          }
          const file = item.getAsFile();
          return file ? [file] : [];
        });

  return clipboardFiles.map((file, index) =>
    normalizeClipboardAttachmentFile(file, index),
  );
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function fileFromClipboardImagePayload(
  payload: ClipboardImagePayload | null,
): File | null {
  const contentBase64 = payload?.content_base64?.trim() ?? "";
  if (!payload || !contentBase64) {
    return null;
  }

  try {
    return new File([base64ToArrayBuffer(contentBase64)], payload.name, {
      type: payload.mime_type || "image/png",
      lastModified: Date.now(),
    });
  } catch {
    return null;
  }
}

async function clipboardImageFileFromElectronClipboard(): Promise<File | null> {
  const payload = await window.electronAPI.clipboard.readImage();
  return fileFromClipboardImagePayload(payload);
}

function explorerAttachmentFilesFromClipboardText(
  clipboardText: string,
): ExplorerAttachmentDragPayload[] {
  const entry = getExplorerAttachmentClipboardEntry();
  if (!entry) {
    return [];
  }

  if (clipboardText.trim() !== entry.text) {
    return [];
  }

  return [entry.payload];
}

export function Composer({
  input,
  quotedSkills,
  slashCommands,
  attachments,
  isResponding,
  pausePending,
  pauseDisabled,
  disabled,
  disabledReason = "",
  selectedModel,
  resolvedModelLabel,
  runtimeDefaultModelLabel,
  modelOptions,
  modelOptionGroups,
  runtimeDefaultModelAvailable,
  selectedThinkingValue,
  thinkingValues,
  showThinkingValueSelector,
  modelSelectionUnavailableReason,
  submitDisabled = false,
  placeholder,
  showModelSelector,
  onModelChange,
  onThinkingValueChange,
  onOpenModelProviders,
  textareaRef,
  fileInputRef,
  onChange,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  onAttachmentInputChange,
  onPause,
  onAddDroppedFiles,
  onAddExplorerAttachments,
  onSelectSlashCommand,
  mentionableItems,
  onRemoveQuotedSkill,
  onRemoveAttachment,
  onPreviewAttachment,
}: ComposerProps) {
  const [isDragActive, setIsDragActive] = useState(false);
  const [composerActionsMenuOpen, setComposerActionsMenuOpen] = useState(false);
  const [composerActionsView, setComposerActionsView] = useState<
    "menu" | "skills"
  >("menu");
  const [skillPickerQuery, setSkillPickerQuery] = useState("");
  const [caretIndex, setCaretIndex] = useState(0);
  const [dismissedSlashCommandKey, setDismissedSlashCommandKey] = useState("");
  const [highlightedSlashIndex, setHighlightedSlashIndex] = useState(0);
  const [dismissedMentionKey, setDismissedMentionKey] = useState("");
  const [highlightedMentionIndex, setHighlightedMentionIndex] = useState(0);
  const composerFooterRef = useRef<HTMLDivElement | null>(null);
  const composerActionsRef = useRef<HTMLDivElement | null>(null);
  const composerFooterLayoutSyncFrameRef = useRef<number | null>(null);
  const slashCommandMenuRef = useRef<HTMLDivElement | null>(null);
  const [composerFooterLayout, setComposerFooterLayout] = useState({
    width: 0,
    actionsWidth: 0,
  });
  const noAvailableModels =
    !runtimeDefaultModelAvailable &&
    modelOptions.length === 0 &&
    modelOptionGroups.length === 0;
  const inputDisabled = disabled;
  const activeSlashRange = useMemo(
    () => findActiveSlashCommandRange(input, caretIndex),
    [caretIndex, input],
  );
  const activeSlashCommandKey = activeSlashRange
    ? `${activeSlashRange.start}:${activeSlashRange.end}:${activeSlashRange.query}`
    : "";
  const showSlashCommandMenu =
    !inputDisabled &&
    activeSlashRange !== null &&
    activeSlashCommandKey !== dismissedSlashCommandKey;
  const activeMentionRange = useMemo(
    // Slash takes precedence — both pickers can't be live at once.
    () =>
      activeSlashRange ? null : findActiveMentionRange(input, caretIndex),
    [activeSlashRange, caretIndex, input],
  );
  const activeMentionKey = activeMentionRange
    ? `${activeMentionRange.start}:${activeMentionRange.end}:${activeMentionRange.query}`
    : "";
  const mentionItemsList = mentionableItems ?? [];
  const filteredMentionItems = useMemo(() => {
    if (inputDisabled || !activeMentionRange || mentionItemsList.length === 0) {
      return [];
    }
    const query = activeMentionRange.query.trim().toLowerCase();
    if (!query) {
      return mentionItemsList;
    }
    return mentionItemsList.filter((item) => {
      const haystack = [item.handle, ...(item.keywords ?? [])]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [activeMentionRange, inputDisabled, mentionItemsList]);
  const showMentionMenu =
    !inputDisabled &&
    activeMentionRange !== null &&
    mentionItemsList.length > 0 &&
    filteredMentionItems.length > 0 &&
    activeMentionKey !== dismissedMentionKey;
  const filteredSlashCommands = useMemo(() => {
    if (inputDisabled || !activeSlashRange) {
      return [];
    }
    const query = activeSlashRange.query.trim().toLowerCase();
    if (!query) {
      return slashCommands;
    }
    return slashCommands.filter(
      (command) =>
        command.command.toLowerCase().includes(query) ||
        command.searchText.includes(query),
    );
  }, [activeSlashRange, inputDisabled, slashCommands]);
  const filteredSkillCommands = useMemo(() => {
    const query = skillPickerQuery.trim().toLowerCase();
    if (!query) {
      return slashCommands;
    }
    return slashCommands.filter(
      (command) =>
        command.command.toLowerCase().includes(query) ||
        command.searchText.includes(query),
    );
  }, [skillPickerQuery, slashCommands]);
  const quotedSkillIdSet = useMemo(
    () => new Set(quotedSkills.map((skill) => skill.skillId)),
    [quotedSkills],
  );
  const visibleModelOptions = modelOptionGroups.flatMap(
    (group) => group.options,
  );
  const selectedModelOptionLabel =
    visibleModelOptions.find((option) => option.value === selectedModel)
      ?.selectedLabel ??
    visibleModelOptions.find((option) => option.value === selectedModel)
      ?.label ??
    modelOptions.find((option) => option.value === selectedModel)
      ?.selectedLabel ??
    modelOptions.find((option) => option.value === selectedModel)?.label ??
    resolvedModelLabel;
  const cancelComposerFooterLayoutSync = () => {
    if (composerFooterLayoutSyncFrameRef.current === null) {
      return;
    }
    window.cancelAnimationFrame(composerFooterLayoutSyncFrameRef.current);
    composerFooterLayoutSyncFrameRef.current = null;
  };
  const syncComposerFooterLayout = () => {
    const footer = composerFooterRef.current;
    if (!footer) {
      return;
    }
    const footerStyle = window.getComputedStyle(footer);
    const horizontalPadding =
      Number.parseFloat(footerStyle.paddingLeft || "0") +
      Number.parseFloat(footerStyle.paddingRight || "0");
    const width = Math.max(
      0,
      Math.round(footer.clientWidth - horizontalPadding),
    );
    const actionsWidth = Math.round(
      composerActionsRef.current?.getBoundingClientRect().width ?? 0,
    );
    setComposerFooterLayout((current) =>
      current.width === width && current.actionsWidth === actionsWidth
        ? current
        : { width, actionsWidth },
    );
  };
  // Coalesce ResizeObserver bursts so compact/full footer transitions do not
  // synchronously re-enter render while the DOM is still settling.
  const scheduleComposerFooterLayoutSync = () => {
    if (composerFooterLayoutSyncFrameRef.current !== null) {
      return;
    }
    composerFooterLayoutSyncFrameRef.current = window.requestAnimationFrame(
      () => {
        composerFooterLayoutSyncFrameRef.current = null;
        syncComposerFooterLayout();
      },
    );
  };
  useLayoutEffect(() => {
    const footer = composerFooterRef.current;
    if (!footer) {
      return;
    }

    syncComposerFooterLayout();
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      scheduleComposerFooterLayoutSync();
    });
    resizeObserver.observe(footer);
    if (composerActionsRef.current) {
      resizeObserver.observe(composerActionsRef.current);
    }
    return () => {
      resizeObserver.disconnect();
      cancelComposerFooterLayoutSync();
    };
  }, []);
  useEffect(() => {
    setHighlightedSlashIndex(0);
  }, [activeSlashRange?.query, filteredSlashCommands.length]);
  useEffect(() => {
    setHighlightedMentionIndex(0);
  }, [activeMentionRange?.query, filteredMentionItems.length]);
  useEffect(() => {
    if (!dismissedMentionKey) {
      return;
    }
    if (!activeMentionKey) {
      setDismissedMentionKey("");
      return;
    }
    if (dismissedMentionKey !== activeMentionKey) {
      setDismissedMentionKey("");
    }
  }, [activeMentionKey, dismissedMentionKey]);
  useEffect(() => {
    if (!dismissedSlashCommandKey) {
      return;
    }
    if (!activeSlashCommandKey) {
      setDismissedSlashCommandKey("");
      return;
    }
    if (dismissedSlashCommandKey !== activeSlashCommandKey) {
      setDismissedSlashCommandKey("");
    }
  }, [activeSlashCommandKey, dismissedSlashCommandKey]);
  useEffect(() => {
    if (inputDisabled) {
      setComposerActionsMenuOpen(false);
      setComposerActionsView("menu");
      setSkillPickerQuery("");
      setDismissedSlashCommandKey("");
    }
  }, [inputDisabled]);
  useEffect(() => {
    if (!showSlashCommandMenu) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const menu = slashCommandMenuRef.current;
      const target = event.target;
      if (!menu || !(target instanceof Node) || menu.contains(target)) {
        return;
      }
      setDismissedSlashCommandKey(activeSlashCommandKey);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [activeSlashCommandKey, showSlashCommandMenu]);
  const visibleFooterControlCount = 1 + (showThinkingValueSelector ? 1 : 0) + 1;
  const fullPrimaryControlWidth = showModelSelector
    ? noAvailableModels
      ? COMPOSER_FULL_PROVIDER_SETUP_WIDTH_PX
      : COMPOSER_FULL_MODEL_CONTROL_WIDTH_PX
    : 0;
  const fullFooterControlWidth =
    fullPrimaryControlWidth +
    (showThinkingValueSelector ? COMPOSER_FULL_THINKING_CONTROL_WIDTH_PX : 0) +
    composerFooterLayout.actionsWidth +
    Math.max(0, visibleFooterControlCount - 1) * COMPOSER_FOOTER_GAP_PX;
  const compactFooterControlWidth = Math.max(
    0,
    composerFooterLayout.width -
      composerFooterLayout.actionsWidth -
      Math.max(0, visibleFooterControlCount - 1) * COMPOSER_FOOTER_GAP_PX,
  );
  const compactComposerControls =
    showModelSelector &&
    composerFooterLayout.width > 0 &&
    composerFooterLayout.actionsWidth > 0 &&
    composerFooterLayout.width < fullFooterControlWidth;
  const compactModelControlWidth = compactComposerControls
    ? Math.min(
        COMPOSER_COMPACT_MODEL_CONTROL_MAX_WIDTH_PX,
        Math.max(
          0,
          compactFooterControlWidth -
            (showThinkingValueSelector
              ? Math.min(
                  COMPOSER_COMPACT_THINKING_CONTROL_MIN_WIDTH_PX,
                  compactFooterControlWidth,
                )
              : 0),
        ),
      )
    : 0;
  const compactThinkingControlWidth = showThinkingValueSelector
    ? Math.max(
        Math.min(
          COMPOSER_COMPACT_THINKING_CONTROL_MAX_WIDTH_PX,
          compactFooterControlWidth - compactModelControlWidth,
        ),
        Math.min(
          COMPOSER_COMPACT_THINKING_CONTROL_MIN_WIDTH_PX,
          compactFooterControlWidth,
        ),
      )
    : 0;

  const syncCaretFromTextarea = (target: HTMLTextAreaElement | null) => {
    if (!target) {
      return;
    }
    setCaretIndex(target.selectionStart ?? target.value.length);
  };

  const handleTextareaChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onChange(event.target.value);
    syncCaretFromTextarea(event.target);
  };

  const applySlashCommand = (command: ChatComposerSlashCommandOption) => {
    onSelectSlashCommand(command);
    if (!activeSlashRange) {
      window.requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) {
          return;
        }
        textarea.focus();
        syncCaretFromTextarea(textarea);
      });
      return;
    }
    const nextInput = removeSlashCommandText(input, activeSlashRange);
    onChange(nextInput.value);
    setCaretIndex(nextInput.caretIndex);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      textarea.setSelectionRange(nextInput.caretIndex, nextInput.caretIndex);
    });
  };

  const applyMentionItem = (item: ChatComposerMentionItem) => {
    if (!activeMentionRange) {
      return;
    }
    const nextInput = replaceMentionText(
      input,
      activeMentionRange,
      `@${item.handle}`,
    );
    // Explicitly dismiss the current mention key so the picker can't
    // re-open against the freshly-inserted handle on the same render.
    setDismissedMentionKey(activeMentionKey);
    onChange(nextInput.value);
    setCaretIndex(nextInput.caretIndex);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      textarea.setSelectionRange(nextInput.caretIndex, nextInput.caretIndex);
    });
  };

  const handleTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentionMenu) {
      if (event.key === "ArrowDown" && filteredMentionItems.length > 0) {
        event.preventDefault();
        setHighlightedMentionIndex(
          (current) => (current + 1) % filteredMentionItems.length,
        );
        return;
      }
      if (event.key === "ArrowUp" && filteredMentionItems.length > 0) {
        event.preventDefault();
        setHighlightedMentionIndex(
          (current) =>
            (current - 1 + filteredMentionItems.length) %
            filteredMentionItems.length,
        );
        return;
      }
      if (
        (event.key === "Enter" || event.key === "Tab") &&
        filteredMentionItems.length > 0
      ) {
        event.preventDefault();
        applyMentionItem(
          filteredMentionItems[
            Math.min(highlightedMentionIndex, filteredMentionItems.length - 1)
          ]!,
        );
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedMentionKey(activeMentionKey);
        return;
      }
    }
    if (showSlashCommandMenu) {
      if (event.key === "ArrowDown" && filteredSlashCommands.length > 0) {
        event.preventDefault();
        setHighlightedSlashIndex(
          (current) => (current + 1) % filteredSlashCommands.length,
        );
        return;
      }
      if (event.key === "ArrowUp" && filteredSlashCommands.length > 0) {
        event.preventDefault();
        setHighlightedSlashIndex(
          (current) =>
            (current - 1 + filteredSlashCommands.length) %
            filteredSlashCommands.length,
        );
        return;
      }
      if (
        (event.key === "Enter" || event.key === "Tab") &&
        filteredSlashCommands.length > 0
      ) {
        event.preventDefault();
        applySlashCommand(
          filteredSlashCommands[
            Math.min(highlightedSlashIndex, filteredSlashCommands.length - 1)
          ]!,
        );
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setCaretIndex(-1);
        return;
      }
    }
    onKeyDown(event);
  };

  const handleTextareaPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedFiles = clipboardFilesFromDataTransfer(event.clipboardData);
    if (pastedFiles.length === 0) {
      const clipboardText =
        event.clipboardData?.getData("text/plain")?.trim() ?? "";
      const explorerFiles =
        explorerAttachmentFilesFromClipboardText(clipboardText);
      if (explorerFiles.length > 0) {
        event.preventDefault();
        onAddExplorerAttachments(explorerFiles);
        return;
      }

      const clipboardTypes = Array.from(event.clipboardData?.types ?? []);
      const hasClipboardImageType = clipboardTypes.some(
        (type) => type === "Files" || type.startsWith("image/"),
      );
      if (
        clipboardText ||
        (clipboardTypes.includes("text/html") && !hasClipboardImageType)
      ) {
        return;
      }

      event.preventDefault();
      void clipboardImageFileFromElectronClipboard()
        .then((file) => {
          if (file) {
            onAddDroppedFiles([file]);
          }
        })
        .catch(() => undefined);
      return;
    }

    event.preventDefault();
    onAddDroppedFiles(pastedFiles);
  };

  const openSkillPickerFromComposerMenu = () => {
    setComposerActionsView("skills");
    setSkillPickerQuery("");
  };

  const closeComposerActionsMenu = () => {
    setComposerActionsMenuOpen(false);
    setComposerActionsView("menu");
    setSkillPickerQuery("");
  };

  const selectSkillFromPicker = (command: ChatComposerSlashCommandOption) => {
    const alreadyQuoted = quotedSkills.some(
      (skill) => skill.skillId === command.skillId,
    );
    if (alreadyQuoted) {
      onRemoveQuotedSkill(command.skillId);
      return;
    }
    onSelectSlashCommand(command);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }
      textarea.focus();
      syncCaretFromTextarea(textarea);
    });
  };

  const allowAttachmentDrop = (dataTransfer: DataTransfer | null) => {
    if (!dataTransfer || disabled) {
      return false;
    }

    const types = Array.from(dataTransfer.types ?? []);
    if (types.includes(EXPLORER_ATTACHMENT_DRAG_TYPE)) {
      return true;
    }

    if ((dataTransfer.files?.length ?? 0) > 0) {
      return true;
    }

    return Array.from(dataTransfer.items ?? []).some(
      (item) => item.kind === "file",
    );
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!allowAttachmentDrop(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!isDragActive) {
      setIsDragActive(true);
    }
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setIsDragActive(false);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!allowAttachmentDrop(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    setIsDragActive(false);

    const explorerFiles: ExplorerAttachmentDragPayload[] = [];
    const rawExplorerPayload = event.dataTransfer.getData(
      EXPLORER_ATTACHMENT_DRAG_TYPE,
    );
    const parsedExplorerPayload =
      parseExplorerAttachmentDragPayload(rawExplorerPayload);
    if (parsedExplorerPayload) {
      explorerFiles.push(parsedExplorerPayload);
    }

    const droppedFiles = Array.from(event.dataTransfer.files ?? []);
    if (explorerFiles.length > 0) {
      onAddExplorerAttachments(explorerFiles);
    }
    if (droppedFiles.length > 0) {
      onAddDroppedFiles(droppedFiles);
    }
  };

  return (
    <div className="relative">
      {showSlashCommandMenu ? (
        <div className="pointer-events-none absolute left-3 right-3 top-4 z-20 -translate-y-[calc(100%+2px)]">
          <div
            ref={slashCommandMenuRef}
            className="pointer-events-auto overflow-hidden rounded-lg bg-popover shadow-md"
          >
            {filteredSlashCommands.length > 0 ? (
              <div className="max-h-[280px] overflow-y-auto p-1">
                {filteredSlashCommands.map((command, index) => (
                  <button
                    key={command.key}
                    type="button"
                    onClick={() => applySlashCommand(command)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors ${
                      index === highlightedSlashIndex
                        ? "bg-fg-8 text-foreground"
                        : "hover:bg-fg-4"
                    }`}
                  >
                    <Wand2 className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {command.label}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="px-3 py-2.5 text-xs text-muted-foreground">
                {slashCommands.length === 0
                  ? "No skills in this workspace yet — add one to create slash commands."
                  : "No skills match."}
              </div>
            )}
          </div>
        </div>
      ) : null}
      {showMentionMenu ? (
        <div className="pointer-events-none absolute left-3 right-3 top-4 z-20 -translate-y-[calc(100%+2px)]">
          <div className="pointer-events-auto overflow-hidden rounded-lg bg-popover shadow-md">
            <div className="max-h-[280px] overflow-y-auto p-1">
              {filteredMentionItems.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyMentionItem(item)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors ${
                    index === highlightedMentionIndex
                      ? "bg-fg-8 text-foreground"
                      : "hover:bg-fg-4"
                  }`}
                >
                  {item.kindIcon ? (
                    <span
                      aria-hidden="true"
                      className="shrink-0 text-muted-foreground"
                    >
                      {item.kindIcon}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {item.label}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className="relative overflow-hidden rounded-2xl bg-background shadow-md"
      >
        {isDragActive ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border border-dashed border-primary/50 bg-background/85 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-1.5 text-primary">
              <Paperclip className="size-5" />
              <span className="text-xs font-medium">
                Drop files to attach
              </span>
            </div>
          </div>
        ) : null}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={onAttachmentInputChange}
        />
        {attachments.length > 0 ? (
          <div className="border-b border-border px-4 py-3">
            <AttachmentList
              attachments={attachments}
              onPreview={onPreviewAttachment}
              onRemove={onRemoveAttachment}
            />
          </div>
        ) : null}
        {quotedSkills.length > 0 ? (
          <div className="border-b border-border px-4 py-2.5">
            <div className="flex flex-wrap gap-1">
              {quotedSkills.map((skill) => (
                <EntityChip
                  key={skill.skillId}
                  size="md"
                  icon={<Sparkles className="text-muted-foreground" />}
                  label={skill.title}
                  trailing={
                    <button
                      type="button"
                      onClick={() => onRemoveQuotedSkill(skill.skillId)}
                      className="grid size-4 place-items-center rounded-sm text-muted-foreground transition hover:bg-fg-8 hover:text-foreground"
                      aria-label={`Remove quoted skill ${skill.title}`}
                    >
                      <X className="size-3" />
                    </button>
                  }
                />
              ))}
            </div>
          </div>
        ) : null}
        <div className="px-5 pb-2 pt-3">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleTextareaChange}
            onKeyDown={handleTextareaKeyDown}
            onPaste={handleTextareaPaste}
            onSelect={(event) => syncCaretFromTextarea(event.currentTarget)}
            onClick={(event) => syncCaretFromTextarea(event.currentTarget)}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={onCompositionEnd}
            rows={1}
            disabled={inputDisabled}
            placeholder={
              inputDisabled
                ? disabledReason || "Chat unavailable right now"
                : placeholder
            }
            className="composer-input block max-h-[220px] min-h-[40px] w-full resize-none overflow-y-auto bg-transparent text-sm leading-7 text-foreground outline-none placeholder:text-muted-foreground/50 disabled:cursor-not-allowed disabled:opacity-55"
          />
        </div>

        <div
          ref={composerFooterRef}
          className={`px-3 pb-3 text-muted-foreground ${
            compactComposerControls
              ? "flex items-center gap-1.5 overflow-hidden"
              : "flex flex-wrap items-center gap-1.5"
          }`}
        >
          {showModelSelector ? (
            <div
              className={
                compactComposerControls
                  ? "min-w-0 shrink-0"
                  : noAvailableModels
                    ? "min-w-0 flex flex-1 basis-full flex-wrap items-center gap-2"
                    : "min-w-0 shrink-0"
              }
            >
              {noAvailableModels ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    onClick={onOpenModelProviders}
                    className={`shrink-0 justify-between rounded-lg bg-card text-xs font-semibold hover:border-primary hover:bg-card ${
                      compactComposerControls ? "px-2.5" : ""
                    }`}
                    aria-label="Configure model providers"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Waypoints className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">
                        {compactComposerControls
                          ? "Providers"
                          : "Set up providers"}
                      </span>
                    </span>
                    <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                  </Button>
                  <div
                    className={`min-w-0 text-[10px] leading-5 text-muted-foreground ${
                      compactComposerControls ? "hidden" : ""
                    }`}
                  >
                    Open provider settings to connect a model.
                  </div>
                </>
              ) : (
                <ModelCombobox
                  selectedModel={selectedModel}
                  selectedModelLabel={selectedModelOptionLabel}
                  runtimeDefaultModelLabel={runtimeDefaultModelLabel}
                  runtimeDefaultModelAvailable={runtimeDefaultModelAvailable}
                  modelOptions={modelOptions}
                  modelOptionGroups={modelOptionGroups}
                  disabled={disabled}
                  compact={compactComposerControls}
                  onModelChange={onModelChange}
                />
              )}
            </div>
          ) : (
            <div className="min-w-0 flex-1 text-xs leading-6 text-muted-foreground">
              Responses here stay in the workspace onboarding thread.
            </div>
          )}

          {showThinkingValueSelector ? (
            <div className="shrink-0">
              <ThinkingValueSelect
                selectedThinkingValue={selectedThinkingValue}
                thinkingValues={thinkingValues}
                disabled={disabled}
                compact={compactComposerControls}
                compactWidth={
                  compactComposerControls
                    ? compactThinkingControlWidth
                    : undefined
                }
                onThinkingValueChange={onThinkingValueChange}
              />
            </div>
          ) : null}

          <div
            ref={composerActionsRef}
            className="ml-auto flex shrink-0 items-center gap-1.5"
          >
            <Popover
              open={composerActionsMenuOpen}
              onOpenChange={(nextOpen) => {
                setComposerActionsMenuOpen(nextOpen);
                if (!nextOpen) {
                  setComposerActionsView("menu");
                  setSkillPickerQuery("");
                }
              }}
            >
              <PopoverTrigger
                disabled={inputDisabled}
                render={
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="Open composer actions"
                    className="rounded-lg"
                  />
                }
              >
                <Plus className="size-3.5" />
              </PopoverTrigger>
              <PopoverContent
                align="end"
                side="top"
                sideOffset={8}
                className={`gap-0 rounded-xl border border-border bg-popover p-0 shadow-xs ring-0 ${
                  composerActionsView === "skills" ? "w-[320px]" : "w-[224px]"
                }`}
              >
                {composerActionsView === "skills" ? (
                  <div className="flex flex-col">
                    <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setComposerActionsView("menu");
                          setSkillPickerQuery("");
                        }}
                        aria-label="Back to actions"
                        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        <ArrowLeft className="size-3.5" />
                      </button>
                      <Search className="size-3.5 shrink-0 text-muted-foreground" />
                      <input
                        value={skillPickerQuery}
                        onChange={(event) =>
                          setSkillPickerQuery(event.target.value)
                        }
                        placeholder="Search skills"
                        className="embedded-input h-7 w-full min-w-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                        autoFocus
                      />
                      {quotedSkillIdSet.size > 0 ? (
                        <span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                          {quotedSkillIdSet.size}
                        </span>
                      ) : null}
                    </div>
                    {filteredSkillCommands.length > 0 ? (
                      <div className="max-h-[288px] overflow-y-auto p-1">
                        {filteredSkillCommands.map((command) => {
                          const isSelected = quotedSkillIdSet.has(
                            command.skillId,
                          );
                          return (
                            <button
                              key={command.key}
                              type="button"
                              onClick={() => selectSkillFromPicker(command)}
                              aria-pressed={isSelected}
                              className={`group flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                                isSelected
                                  ? "bg-accent text-foreground"
                                  : "text-foreground hover:bg-accent"
                              }`}
                            >
                              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                                {isSelected ? (
                                  <Check className="size-3.5 text-primary" />
                                ) : (
                                  <Sparkles className="size-3.5 text-muted-foreground" />
                                )}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium text-foreground">
                                  {command.label}
                                </span>
                                {command.description ? (
                                  <span className="mt-0.5 block truncate text-[11px] leading-4 text-muted-foreground">
                                    {command.description}
                                  </span>
                                ) : null}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-1 px-4 py-6 text-center">
                        <Sparkles className="size-4 text-muted-foreground" />
                        <span className="text-xs font-medium text-foreground">
                          No matching skills
                        </span>
                        <span className="text-[11px] leading-4 text-muted-foreground">
                          Try a different search term.
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-0.5 p-1">
                    <button
                      type="button"
                      onClick={() => {
                        closeComposerActionsMenu();
                        fileInputRef.current?.click();
                      }}
                      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent"
                    >
                      <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        Attach a file
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={openSkillPickerFromComposerMenu}
                      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent"
                    >
                      <Zap className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        Use Skills
                      </span>
                      {quotedSkillIdSet.size > 0 ? (
                        <span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                          {quotedSkillIdSet.size}
                        </span>
                      ) : null}
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                    </button>
                  </div>
                )}
              </PopoverContent>
            </Popover>
            {isResponding ? (
              <Button
                type="button"
                size="icon-sm"
                aria-label="Pause"
                disabled={pausePending || pauseDisabled || disabled}
                onClick={onPause}
                className="rounded-lg"
              >
                {pausePending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Square className="size-3 fill-current" />
                )}
              </Button>
            ) : (
              <Button
                size="icon-sm"
                aria-label="Send message"
                disabled={
                  (!input.trim() &&
                    attachments.length === 0 &&
                    quotedSkills.length === 0) ||
                  disabled ||
                  submitDisabled
                }
                render={<button type="submit" />}
                className="rounded-lg"
              >
                <ArrowUp className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
