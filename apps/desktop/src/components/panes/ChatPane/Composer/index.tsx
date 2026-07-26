import {
  type ChangeEvent,
  type DragEvent,
  type RefObject,
  forwardRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUp,
  Check,
  Feather,
  Folder,
  Image,
  Loader2,
  Paperclip,
  Play,
  Plug,
  Plus,
  Sparkles,
  Square,
  Upload,
  Wand2,
  X,
  Zap,
} from "@/components/ui/icons";
import { Icon as IconifyIcon } from "@iconify/react";
import { getCapabilityIcon } from "@/lib/capabilityGlyph";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAtomValue, useSetAtom } from "jotai";
import { BrowseIntegrationsSubmenu } from "./BrowseIntegrationsSubmenu";
import { EntityChip } from "@/components/ui/entity-chip";
import { ImageComposerControls } from "./ImageComposerControls";
import { imageComposerModeAtom } from "./imageMode";
import { VideoComposerControls } from "./VideoComposerControls";
import { videoComposerModeAtom } from "./videoMode";
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
  COMPOSER_SEND_BUTTON_WIDTH_PX,
} from "../constants";
import {
  ComposerEditor,
  type ComposerEditorHandle,
} from "./editor/ComposerEditor";
import type { ComposerValue } from "./editor/composerValue";
import type {
  AttachmentListItem,
  ChatComposerMentionItem,
  ChatComposerQuotedIntegrationItem,
  ChatComposerCapabilitySlashCommandOption,
  ChatComposerQuotedSkillItem,
  ChatComposerSkillSlashCommandOption,
  ChatComposerSlashCommandOption,
  ChatModelOption,
  ChatModelOptionGroup,
} from "../types";
import { ModelCombobox } from "./ModelCombobox";
import { ThinkingValueSelect } from "./ThinkingValueSelect";
import { HarnessModelPicker } from "@/components/harness/HarnessModelPicker";

interface ComposerProps {
  input: string;
  quotedSkills: ChatComposerQuotedSkillItem[];
  quotedIntegrations: ChatComposerQuotedIntegrationItem[];
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
  /** When the active session is bound to a non-pi harness (claude-code,
   *  codex), the composer renders these instead of ModelCombobox in the
   *  same toolbar slot. Empty list means pi/Hola mode and the regular
   *  ModelCombobox + provider catalogue takes over. */
  harnessSupportedModels?: HarnessSupportedModelPayload[];
  harnessSelectedModel?: string | null;
  onHarnessModelChange?: (modelId: string) => void;
  /** When false, hides the attachment "+" dropdown and the skills wand
   *  popover in the composer toolbar. Used by the embedded plugin
   *  onboarding chat where the agent drives a focused flow that doesn't
   *  need user attachments or skill quoting. */
  showAccessoryControls?: boolean;
  /** Which side the "+" accessory menu opens toward. The empty/centered
   *  composer passes "bottom" (there's room below it); the docked composer
   *  keeps "top" so the menu grows up over the transcript. */
  plusMenuSide?: "top" | "bottom";
  selectedProjectId: string | null;
  projectOptions: WorkspaceProjectRecordPayload[];
  showProjectPicker: boolean;
  onProjectChange: (projectId: string | null) => void;
  onModelChange: (value: string) => void;
  onThinkingValueChange: (value: string | null) => void;
  onOpenModelProviders: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onAttachmentInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onPause: () => void;
  onAddDroppedFiles: (files: File[]) => void;
  onAddExplorerAttachments: (files: ExplorerAttachmentDragPayload[]) => void;
  /** Items the `@` picker offers — currently workspaces, future:
   *  apps / sessions / memories. Pre-shaped so the picker is just a
   *  presenter; the parent decides what's mentionable. */
  mentionableItems?: ChatComposerMentionItem[];
  onRemoveQuotedIntegration: (slug: string) => void;
  /** Called when the user picks an integration from the +
   *  dropdown's "Integrations" submenu — drops a mention chip. */
  onSelectIntegration: (slug: string, name: string) => void;
  /** When provided (a HolaEmployee chat), the Integrations submenu lists exactly
   *  these equipped toolkits instead of the global connected-integrations browser. */
  employeeIntegrations?: { slug: string; name: string }[] | null;
  onRemoveAttachment: (attachmentId: string) => void;
  onPreviewAttachment: (attachment: AttachmentListItem) => void;
  composerEditorRef: RefObject<ComposerEditorHandle | null>;
  /** Seeds the editor on (re)mount so a prefill survives an editor swap. */
  composerInitialValue?: ComposerValue;
  onValueChange: (value: ComposerValue) => void;
  onSubmit: () => void;
  onRecallLatest: () => boolean;
  onCancelDraft: () => boolean;
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
  quotedIntegrations,
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
  harnessSupportedModels,
  harnessSelectedModel,
  onHarnessModelChange,
  showAccessoryControls = true,
  plusMenuSide = "top",
  selectedProjectId,
  projectOptions,
  showProjectPicker,
  onProjectChange,
  onModelChange,
  onThinkingValueChange,
  onOpenModelProviders,
  fileInputRef,
  onAttachmentInputChange,
  onPause,
  onAddDroppedFiles,
  onAddExplorerAttachments,
  mentionableItems,
  onRemoveQuotedIntegration,
  onSelectIntegration,
  employeeIntegrations = null,
  onRemoveAttachment,
  onPreviewAttachment,
  composerEditorRef,
  composerInitialValue,
  onValueChange,
  onSubmit,
  onRecallLatest,
  onCancelDraft,
}: ComposerProps) {
  const selectedProjectName = useMemo(() => {
    if (!selectedProjectId) {
      return "Work in a project";
    }
    return (
      projectOptions.find(
        (project) => project.project_id === selectedProjectId,
      )?.name ?? "Work in a project"
    );
  }, [projectOptions, selectedProjectId]);
  const [isDragActive, setIsDragActive] = useState(false);
  const imageMode = useAtomValue(imageComposerModeAtom);
  const setImageMode = useSetAtom(imageComposerModeAtom);
  const videoMode = useAtomValue(videoComposerModeAtom);
  const setVideoMode = useSetAtom(videoComposerModeAtom);
  const composerFooterRef = useRef<HTMLDivElement | null>(null);
  const composerActionsRef = useRef<HTMLDivElement | null>(null);
  const composerFooterLayoutSyncFrameRef = useRef<number | null>(null);
  const [composerFooterLayout, setComposerFooterLayout] = useState({
    width: 0,
    actionsWidth: 0,
  });
  const noAvailableModels =
    !runtimeDefaultModelAvailable &&
    modelOptions.length === 0 &&
    modelOptionGroups.length === 0;
  const inputDisabled = disabled;
  const plusMenuSkillCommands = useMemo(
    () =>
      slashCommands.filter(
        (command): command is ChatComposerSkillSlashCommandOption =>
          command.kind === "skill",
      ),
    [slashCommands],
  );
  const plusMenuCapabilityCommands = useMemo(
    () =>
      slashCommands.filter(
        (command): command is ChatComposerCapabilitySlashCommandOption =>
          command.kind === "capability",
      ),
    [slashCommands],
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
  const visibleFooterControlCount = 1 + (showThinkingValueSelector ? 1 : 0) + 1;
  const fullPrimaryControlWidth = showModelSelector
    ? noAvailableModels
      ? COMPOSER_FULL_PROVIDER_SETUP_WIDTH_PX
      : COMPOSER_FULL_MODEL_CONTROL_WIDTH_PX
    : 0;
  // Stable estimate of the full-size actions cluster (model + thinking + send),
  // used in place of the *measured* width below. The measured actions width
  // swings between compact and full, which fed back into this threshold and
  // made the model picker flicker at boundary widths.
  const fullActionsControlWidth =
    fullPrimaryControlWidth +
    (showThinkingValueSelector ? COMPOSER_FULL_THINKING_CONTROL_WIDTH_PX : 0) +
    COMPOSER_SEND_BUTTON_WIDTH_PX;
  const fullFooterControlWidth =
    fullPrimaryControlWidth +
    (showThinkingValueSelector ? COMPOSER_FULL_THINKING_CONTROL_WIDTH_PX : 0) +
    fullActionsControlWidth +
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


  const handleEditorPaste = (event: ClipboardEvent): boolean => {
    const pastedFiles = clipboardFilesFromDataTransfer(event.clipboardData);
    if (pastedFiles.length === 0) {
      const clipboardText =
        event.clipboardData?.getData("text/plain")?.trim() ?? "";
      const explorerFiles =
        explorerAttachmentFilesFromClipboardText(clipboardText);
      if (explorerFiles.length > 0) {
        onAddExplorerAttachments(explorerFiles);
        return true;
      }
      const clipboardTypes = Array.from(event.clipboardData?.types ?? []);
      const hasClipboardImageType = clipboardTypes.some(
        (type) => type === "Files" || type.startsWith("image/"),
      );
      if (
        clipboardText ||
        (clipboardTypes.includes("text/html") && !hasClipboardImageType)
      ) {
        return false;
      }
      void clipboardImageFileFromElectronClipboard()
        .then((file) => {
          if (file) {
            onAddDroppedFiles([file]);
          }
        })
        .catch(() => undefined);
      return true;
    }
    onAddDroppedFiles(pastedFiles);
    return true;
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
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className="relative overflow-hidden rounded-2xl border border-foreground/20 bg-background shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-8px_rgba(0,0,0,0.06)] transition-shadow duration-200 ease-out focus-within:shadow-[0_2px_4px_rgba(0,0,0,0.04),0_12px_32px_-8px_rgba(0,0,0,0.08)]"
      >
        {isDragActive ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border border-dashed border-primary/50 bg-background/85 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-1.5 text-primary">
              <Paperclip className="size-5" />
              <span className="text-xs font-medium">Drop files to attach</span>
            </div>
          </div>
        ) : null}
        {attachments.length > 0 ? (
          <div className="border-b border-border px-4 py-3">
            <AttachmentList
              attachments={attachments}
              onPreview={onPreviewAttachment}
              onRemove={onRemoveAttachment}
            />
          </div>
        ) : null}
        {quotedIntegrations.length > 0 ? (
          <div className="px-4 pt-2 pb-0.5">
            <div className="flex flex-wrap gap-1">
              {quotedIntegrations.map((integration) => (
                <EntityChip
                  key={`integration-${integration.slug}`}
                  size="sm"
                  icon={
                    integration.logo ? (
                      <img
                        alt=""
                        className="size-3 rounded-[3px] object-contain"
                        referrerPolicy="no-referrer"
                        src={integration.logo}
                      />
                    ) : (
                      <Plug className="size-3 text-muted-foreground" />
                    )
                  }
                  label={integration.name}
                  trailing={
                    <button
                      type="button"
                      onClick={() =>
                        onRemoveQuotedIntegration(integration.slug)
                      }
                      className="grid size-3.5 place-items-center rounded-sm text-muted-foreground transition hover:bg-fg-8 hover:text-foreground"
                      aria-label={`Remove integration ${integration.name}`}
                    >
                      <X className="size-2.5" />
                    </button>
                  }
                />
              ))}
            </div>
          </div>
        ) : null}
        <div className="px-4 pt-3.5 pb-1">
          <ComposerEditor
            ref={composerEditorRef}
            initialValue={composerInitialValue}
            disabled={inputDisabled}
            placeholder={
              inputDisabled
                ? disabledReason || "Chat unavailable right now"
                : placeholder
            }
            slashCommands={slashCommands}
            mentionItems={mentionableItems ?? []}
            onChange={onValueChange}
            onSubmit={onSubmit}
            onRecallLatest={onRecallLatest}
            onCancelDraft={onCancelDraft}
            onPasteFiles={handleEditorPaste}
          />
        </div>

        <div
          ref={composerFooterRef}
          className="flex items-center gap-1.5 px-4 pb-2.5 pt-1 text-muted-foreground"
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={onAttachmentInputChange}
          />
          {showAccessoryControls ? (
          <>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <ComposerIconButton
                  aria-label="Add attachment or integration"
                  disabled={inputDisabled}
                  className="rounded ring-1 ring-border/50"
                />
              }
            >
              <Plus className="size-3.5" strokeWidth={1.75} />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              side={plusMenuSide}
              sideOffset={6}
            >
              <DropdownMenuItem
                className="gap-2 rounded-md px-2 py-1.5 text-[13px]"
                onClick={() => {
                  setVideoMode(false);
                  setImageMode(true);
                  composerEditorRef.current?.insertSkill(
                    "image-generator",
                    "Image Generator",
                  );
                  composerEditorRef.current?.focus();
                }}
              >
                <Image className="size-4" />
                Create image
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2 rounded-md px-2 py-1.5 text-[13px]"
                onClick={() => {
                  setImageMode(false);
                  setVideoMode(true);
                  composerEditorRef.current?.focus();
                }}
              >
                <Play className="size-4" />
                Create video
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2 rounded-md px-2 py-1.5 text-[13px]"
                onClick={() => {
                  composerEditorRef.current?.insertSkill("pptx", "Slides");
                  composerEditorRef.current?.focus();
                }}
              >
                <Sparkles className="size-4" />
                Create slides
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="gap-2 rounded-md px-2 py-1.5 text-[13px]">
                  <Feather className="size-4" />
                  Skills
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-[320px] min-w-[240px] overflow-y-auto">
                  {plusMenuSkillCommands.length > 0 ? (
                    plusMenuSkillCommands.map((command) => (
                      <DropdownMenuItem
                        className="gap-2 rounded-md px-2 py-1.5 text-[13px]"
                        key={command.skillId}
                        onClick={() =>
                          composerEditorRef.current?.insertSkill(
                            command.skillId,
                            command.label,
                          )
                        }
                      >
                        <Feather className="size-4 text-muted-foreground" />
                        <span className="flex-1 truncate">{command.label}</span>
                      </DropdownMenuItem>
                    ))
                  ) : (
                    <DropdownMenuItem
                      className="gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground"
                      disabled
                    >
                      No skills installed
                    </DropdownMenuItem>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="gap-2 rounded-md px-2 py-1.5 text-[13px]">
                  <IconifyIcon className="size-4" icon={getCapabilityIcon("")} />
                  Capabilities
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-[320px] min-w-[240px] overflow-y-auto">
                  {plusMenuCapabilityCommands.length > 0 ? (
                    plusMenuCapabilityCommands.map((command) => (
                      <DropdownMenuItem
                        className="gap-2 rounded-md px-2 py-1.5 text-[13px]"
                        key={command.capabilityId}
                        onClick={() =>
                          composerEditorRef.current?.insertCapability(
                            command.capabilityId,
                            command.label,
                          )
                        }
                      >
                        <IconifyIcon
                          className="size-4 text-muted-foreground"
                          icon={getCapabilityIcon("")}
                        />
                        <span className="flex-1 truncate">{command.label}</span>
                      </DropdownMenuItem>
                    ))
                  ) : (
                    <DropdownMenuItem
                      className="gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground"
                      disabled
                    >
                      No capabilities installed
                    </DropdownMenuItem>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="gap-2 rounded-md px-2 py-1.5 text-[13px]">
                  <Plug className="size-4" />
                  Integrations
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-[240px]">
                  {employeeIntegrations ? (
                    employeeIntegrations.length > 0 ? (
                      employeeIntegrations.map((it) => (
                        <DropdownMenuItem
                          className="gap-2 rounded-md px-2 py-1.5 text-[13px]"
                          key={it.slug}
                          onClick={() => onSelectIntegration(it.slug, it.name)}
                        >
                          <Plug className="size-4 text-muted-foreground" />
                          <span className="flex-1 truncate">{it.name}</span>
                        </DropdownMenuItem>
                      ))
                    ) : (
                      <DropdownMenuItem
                        className="gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground"
                        disabled
                      >
                        No integrations connected
                      </DropdownMenuItem>
                    )
                  ) : (
                    <BrowseIntegrationsSubmenu
                      onSelectIntegration={onSelectIntegration}
                    />
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem
                className="gap-2 rounded-md px-2 py-1.5 text-[13px]"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="size-4" />
                Add files or photos
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {imageMode ? <ImageComposerControls /> : null}
          {videoMode ? <VideoComposerControls /> : null}
          </>
          ) : null}

          {!imageMode &&
          !videoMode &&
          showProjectPicker &&
          projectOptions.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    aria-label="Bind chat to a project"
                    className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground ring-1 ring-border/50 transition-colors hover:bg-accent"
                  />
                }
              >
                <Folder className="size-3.5" strokeWidth={1.75} />
                <span className="max-w-32 truncate">
                  {selectedProjectName}
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="bottom" sideOffset={6}>
                <DropdownMenuItem
                  className="gap-2 rounded-md px-2 py-1.5 text-[13px]"
                  onClick={() => onProjectChange(null)}
                >
                  {selectedProjectId === null ? (
                    <Check className="size-4 text-primary" />
                  ) : (
                    <span className="size-4" />
                  )}
                  No project
                </DropdownMenuItem>
                {projectOptions.map((project) => (
                  <DropdownMenuItem
                    key={project.project_id}
                    className="gap-2 rounded-md px-2 py-1.5 text-[13px]"
                    onClick={() => onProjectChange(project.project_id)}
                  >
                    {selectedProjectId === project.project_id ? (
                      <Check className="size-4 text-primary" />
                    ) : (
                      <Folder className="size-4 text-foreground/40" />
                    )}
                    <span className="truncate">{project.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          {/* Right cluster: model / thinking / send. ml-auto pushes the
              whole group flush to the right edge so it reads as the
              "submit" affordance. */}
          <div
            ref={composerActionsRef}
            className="ml-auto flex min-w-0 items-center gap-1.5"
          >
            {/* Model + reasoning effort sit tighter together (gap-0.5)
                than the rest of the toolbar's gap-1.5 — they're one
                conceptual cluster ("which brain am I talking to"). Hidden in
                image/video mode, where the media model + parameter controls own
                the row instead. */}
            {imageMode || videoMode ? null : (
            <div className="flex min-w-0 items-center gap-0.5">
              {harnessSupportedModels && harnessSupportedModels.length > 0 ? (
                // Non-pi harness slot: same conceptual position as
                // ModelCombobox, but scoped to the harness's own
                // namespace (claude-*, gpt-*-codex, …).
                <div className="min-w-0">
                  <HarnessModelPicker
                    value={harnessSelectedModel ?? null}
                    models={harnessSupportedModels}
                    disabled={disabled}
                    onChange={(id) => onHarnessModelChange?.(id)}
                  />
                </div>
              ) : showModelSelector ? (
                <div className="min-w-0">
                  {noAvailableModels ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onOpenModelProviders}
                      className="shrink-0 gap-1.5 rounded-md text-xs font-medium hover:border-primary"
                      aria-label="Configure model providers"
                    >
                      <Wand2 className="size-3.5 text-muted-foreground" />
                      <span className="truncate">
                        {compactComposerControls
                          ? "Providers"
                          : "Set up providers"}
                      </span>
                    </Button>
                  ) : (
                    <ModelCombobox
                      selectedModel={selectedModel}
                      selectedModelLabel={selectedModelOptionLabel}
                      runtimeDefaultModelLabel={runtimeDefaultModelLabel}
                      runtimeDefaultModelAvailable={
                        runtimeDefaultModelAvailable
                      }
                      modelOptions={modelOptions}
                      modelOptionGroups={modelOptionGroups}
                      disabled={disabled}
                      compact={compactComposerControls}
                      onModelChange={onModelChange}
                    />
                  )}
                </div>
              ) : null}

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
            </div>
            )}

            {/* Send / pause is a filled primary circle — the only colored
                element in the toolbar. Disabled state drops opacity but
                keeps the shape so the shell still reads "send lives
                here". */}
            {isResponding ? (
              <button
                type="button"
                aria-label="Pause"
                disabled={pausePending || pauseDisabled || disabled}
                onClick={onPause}
                className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {pausePending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Square className="size-3 fill-current" />
                )}
              </button>
            ) : (
              <button
                type="submit"
                aria-label="Send message"
                disabled={
                  (!input.trim() &&
                    attachments.length === 0 &&
                    quotedSkills.length === 0 &&
                    quotedIntegrations.length === 0) ||
                  disabled ||
                  submitDisabled
                }
                className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <ArrowUp className="size-4" strokeWidth={2} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Calm icon-only button for the composer footer's left cluster (Attach,
// Skills, future: voice). Pure-ghost rest state with a subtle surface
// tint on hover so the buttons look like inert glyphs until reached for
// — matches the toolbar feel in Claude.ai / Linear's composer.
const ComposerIconButton = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(function ComposerIconButton(
  { children, className = "", type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`relative grid size-7 shrink-0 place-items-center rounded-md text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:bg-foreground/[0.05] focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
});
