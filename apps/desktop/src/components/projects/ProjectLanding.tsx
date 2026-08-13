import { useQuery } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Composer } from "@/components/panes/ChatPane/Composer";
import type { ComposerEditorHandle } from "@/components/panes/ChatPane/Composer/editor/ComposerEditor";
import { ImageAttachmentPreviewModal } from "@/components/panes/ChatPane/ImageAttachmentPreviewModal";
import {
  attachmentUploadPayload,
  createPendingExplorerAttachment,
  createPendingLocalAttachment,
  pendingAttachmentsToListItems,
  stagePendingFileAttachments,
} from "@/components/panes/ChatPane/pendingAttachments";
import type {
  AttachmentListItem,
  ImageAttachmentPreviewState,
  PendingAttachment,
} from "@/components/panes/ChatPane/types";
import { RuntimeContextBar } from "@/components/harness/RuntimeContextBar";
import { OutputPreviewModal } from "@/components/panes/OutputPreviewModal";
import { ProjectOutputsRow } from "@/components/projects/ProjectOutputsRow";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MessageSquareText,
  MoreHorizontal,
  Pin,
  Trash2,
} from "@/components/ui/icons";
import { useChatComposerModelSelection } from "@/lib/chat/useChatComposerModelSelection";
import {
  attachmentLooksLikeImage,
  imageInputUnsupportedMessage,
  pendingAttachmentIsImage,
} from "@/components/panes/ChatPane/helpers";
import {
  type ExplorerAttachmentDragPayload,
  resolveExplorerAttachmentKind,
} from "@/lib/attachmentDrag";
import { cn } from "@/lib/utils";
import { remoteApiQuery } from "@/lib/remoteApiQuery";
import { toDisplayOutputs } from "@/lib/outputs";
import { useOpenWorkspaceOutput } from "@/components/layout/shell/useOpenWorkspaceOutput";
import { useShellSurfaceLeftInset } from "@/components/layout/shell/useShellSurfaceLeftInset";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { useAvailableHarnesses } from "@/components/harness/useAvailableHarnesses";
import {
  useWorkspaceMainSessions,
  useWorkspaceProjects,
} from "@/components/layout/shell/useWorkspaceLists";
import {
  chatPanelViewAtom,
  chatSessionOpenRequestAtom,
  focusModeAtom,
  projectViewAtom,
  selectedSessionIdAtom,
  sessionLastViewedAtAtom,
} from "@/components/layout/shell/state/ui";

/**
 * Project landing page (overlay).
 *
 * Shows a project-scoped composer to start work, an Outputs row of artifacts
 * produced in the project, and a Recents list of the project's chat sessions
 * (each with linked output chips). The first message creates the
 * project-bound session and drops into focus-mode chat. Follow-up affordances
 * (model selector, attach, mentions) live in the ChatPane composer.
 */

interface ProjectLandingProps {
  workspaceId: string | null;
  projectId: string;
}

const RECENTS_CAP = 8;
const GREETING = "What do you want to make?";

export function ProjectLanding({
  workspaceId,
  projectId,
}: ProjectLandingProps) {
  const [composerText, setComposerText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachmentGateMessage, setAttachmentGateMessage] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingAttachment[]
  >([]);
  const [imageAttachmentPreview, setImageAttachmentPreview] =
    useState<ImageAttachmentPreviewState | null>(null);
  const composerEditorRef = useRef<ComposerEditorHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageAttachmentPreviewRequestIdRef = useRef(0);
  const imageAttachmentPreviewObjectUrlRef = useRef<string | null>(null);
  const pendingSessionIdRef = useRef<string | null>(null);

  const {
    effectiveChatModelPreference,
    resolvedChatModel,
    resolvedModelLabel,
    runtimeDefaultModelLabel,
    runtimeDefaultModelAvailable,
    availableChatModelOptions,
    availableChatModelOptionGroups,
    effectiveThinkingValue,
    selectedThinkingValues,
    selectedModelSupportsReasoning,
    selectedModelSupportsImageInput,
    modelSelectionUnavailableReason,
    setChatModelPreference,
    setSelectedThinkingValue,
  } = useChatComposerModelSelection();

  // Harness picked for the *next* session. The picker is only shown on
  // the empty-state landing screen — once a session exists it carries
  // its own immutable harness, and the ChatPane composer that takes over
  // for follow-ups doesn't expose a switch.
  const {
    harnesses: availableHarnesses,
    isLoading: harnessesLoading,
  } = useAvailableHarnesses(workspaceId);
  const [selectedHarnessId, setSelectedHarnessId] = useState<string>("pi");
  // Snap the picker to the first available harness whenever the list
  // refreshes; pi/Hola is always present, so this mostly just realigns
  // when "pi" isn't the runtime's first detected entry.
  useEffect(() => {
    if (availableHarnesses.length === 0) return;
    if (availableHarnesses.find((h) => h.id === selectedHarnessId && h.available)) {
      return;
    }
    const fallback =
      availableHarnesses.find((h) => h.id === "pi" && h.available) ??
      availableHarnesses.find((h) => h.available) ??
      availableHarnesses[0];
    if (fallback) {
      setSelectedHarnessId(fallback.id);
    }
  }, [availableHarnesses, selectedHarnessId]);
  // pi rides the Hola model catalogue; CLI harnesses carry their own
  // supported_models, so the composer's model picker must swap namespaces
  // with the harness (same split as ChatPane's empty composer).
  const harnessUsesHolaModelCatalog = selectedHarnessId === "pi";
  const harnessSupportedModels = useMemo(
    () =>
      harnessUsesHolaModelCatalog
        ? []
        : (availableHarnesses.find((h) => h.id === selectedHarnessId)
            ?.supported_models ?? []),
    [availableHarnesses, harnessUsesHolaModelCatalog, selectedHarnessId],
  );
  const [harnessChatModelOverride, setHarnessChatModelOverride] = useState<
    string | null
  >(null);
  const [harnessThinkingOverride, setHarnessThinkingOverride] = useState<
    string | null
  >(null);
  const selectedModelDisplayLabel = resolvedModelLabel.trim();
  const pendingImageInputUnsupportedMessage =
    harnessUsesHolaModelCatalog &&
    pendingAttachments.some((attachment) =>
      pendingAttachmentIsImage(attachment),
    ) &&
    !selectedModelSupportsImageInput
      ? `${imageInputUnsupportedMessage(selectedModelDisplayLabel)} Remove the attached image or switch models.`
      : "";

  useEffect(() => {
    setAttachmentGateMessage("");
  }, [effectiveChatModelPreference, harnessChatModelOverride]);
  // Keep the override legal for the current harness: clear it on the Hola
  // catalogue, snap to the default (or first) supported model otherwise.
  useEffect(() => {
    if (harnessSupportedModels.length === 0) {
      setHarnessChatModelOverride((current) => (current === null ? current : null));
      return;
    }
    setHarnessChatModelOverride((current) => {
      if (current && harnessSupportedModels.some((m) => m.id === current)) {
        return current;
      }
      const defaultModel =
        harnessSupportedModels.find((m) => m.default) ?? harnessSupportedModels[0];
      return defaultModel?.id ?? null;
    });
  }, [harnessSupportedModels]);
  const setProjectView = useSetAtom(projectViewAtom);
  const setChatPanelView = useSetAtom(chatPanelViewAtom);
  const setSelectedSessionId = useSetAtom(selectedSessionIdAtom);
  const setSessionOpenRequest = useSetAtom(chatSessionOpenRequestAtom);
  const setFocusMode = useSetAtom(focusModeAtom);
  const setLastViewedMap = useSetAtom(sessionLastViewedAtAtom);
  const { openOutput } = useOpenWorkspaceOutput();
  const { selectedWorkspace } = useWorkspaceDesktop();
  // Full-window overlay: the breadcrumb bar sits at x=0 when the sidebar is
  // collapsed, so reserve the macOS stoplight / floating expand-button gutter.
  const headerPaddingLeft = useShellSurfaceLeftInset("1.5rem");
  const [previewOutput, setPreviewOutput] =
    useState<WorkspaceOutputRecordPayload | null>(null);

  const goToOutputSession = useCallback(
    (sessionId: string) => {
      setPreviewOutput(null);
      setSelectedSessionId(sessionId);
      setSessionOpenRequest({
        sessionId,
        requestKey: Date.now(),
        readOnly: false,
      });
      setChatPanelView("chat");
      setProjectView(null);
      setFocusMode(true);
      setLastViewedMap((prev) => ({
        ...prev,
        [sessionId]: new Date().toISOString(),
      }));
      if (workspaceId) {
        void window.electronAPI.workspace
          .activateMainSession(workspaceId, sessionId)
          .catch(() => {
            // non-fatal
          });
      }
    },
    [
      workspaceId,
      setSelectedSessionId,
      setSessionOpenRequest,
      setChatPanelView,
      setProjectView,
      setFocusMode,
      setLastViewedMap,
    ],
  );

  // Read from the shared, workspace-keyed projects cache (kept warm by the
  // sidebar) so the project resolves on the first render — no empty/greeting
  // flash while an async fetch resolves when opening a project.
  const { projects } = useWorkspaceProjects(workspaceId);
  const project = useMemo(
    () => projects.find((p) => p.project_id === projectId) ?? null,
    [projects, projectId],
  );

  const { sessions } = useWorkspaceMainSessions(workspaceId);
  const projectSessions = useMemo(() => {
    return sessions
      .filter((s) => !s.archived_at && (s.project_id ?? null) === projectId)
      .slice(0, RECENTS_CAP);
  }, [sessions, projectId]);
  const projectSessionIds = useMemo(
    () =>
      new Set(
        sessions
          .filter(
            (s) => !s.archived_at && (s.project_id ?? null) === projectId,
          )
          .map((s) => s.session_id),
      ),
    [sessions, projectId],
  );

  const outputsQuery = useQuery(
    remoteApiQuery.outputs.list.queryOptions({
      input: { workspaceId: workspaceId ?? "", limit: 500 },
      enabled: Boolean(workspaceId),
      select: (data) => ({
        ...data,
        items: toDisplayOutputs(data.items),
      }),
    }),
  );
  const displayOutputs = useMemo(() => {
    const items = (outputsQuery.data?.items ??
      []) as WorkspaceOutputRecordPayload[];
    return items.filter(
      (item) =>
        item.project_id === projectId ||
        (item.session_id != null && projectSessionIds.has(item.session_id)),
    );
  }, [outputsQuery.data, projectId, projectSessionIds]);
  // If the project isn't in the shared cache, confirm it's genuinely gone
  // with a direct fetch before surfacing an error — avoids a false "no longer
  // exists" while the cache is still warming. The common case (project present
  // in cache) returns early, so this never runs on a normal open.
  useEffect(() => {
    if (!workspaceId || project) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response =
          await window.electronAPI.workspace.listProjects(workspaceId);
        if (cancelled) return;
        const match = response.items?.find((p) => p.project_id === projectId);
        if (!match) {
          setError("This project no longer exists.");
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load project",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, projectId, project]);

  const appendPendingLocalFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;

      const maxAttachmentBytes = 100 * 1024 * 1024;
      const maxAttachmentCount = 50;
      const acceptedFiles: File[] = [];
      let rejectedImageCount = 0;
      let oversizedCount = 0;
      for (const file of files) {
        if (
          harnessUsesHolaModelCatalog &&
          !selectedModelSupportsImageInput &&
          attachmentLooksLikeImage(file.name, file.type)
        ) {
          rejectedImageCount += 1;
          continue;
        }
        if (file.size > maxAttachmentBytes) {
          oversizedCount += 1;
          continue;
        }
        acceptedFiles.push(file);
      }

      const remainingSlots = Math.max(
        0,
        maxAttachmentCount - pendingAttachments.length,
      );
      const filesToAdd = acceptedFiles.slice(0, remainingSlots);
      const overflowCount = acceptedFiles.length - filesToAdd.length;
      const gateParts: string[] = [];
      if (rejectedImageCount > 0) {
        gateParts.push(
          `${imageInputUnsupportedMessage(selectedModelDisplayLabel)} Skipped ${rejectedImageCount} image attachment${rejectedImageCount === 1 ? "" : "s"}.`,
        );
      }
      if (oversizedCount > 0) {
        gateParts.push(
          `Skipped ${oversizedCount} file${oversizedCount === 1 ? "" : "s"} over 100MB.`,
        );
      }
      if (overflowCount > 0) {
        gateParts.push(
          `Limit ${maxAttachmentCount} attachments — skipped ${overflowCount}.`,
        );
      }
      setAttachmentGateMessage(gateParts.join(" "));

      if (filesToAdd.length === 0) return;
      setPendingAttachments((current) => [
        ...current,
        ...filesToAdd.map(createPendingLocalAttachment),
      ]);
    },
    [
      harnessUsesHolaModelCatalog,
      pendingAttachments.length,
      selectedModelDisplayLabel,
      selectedModelSupportsImageInput,
    ],
  );

  const appendPendingExplorerAttachments = useCallback(
    (files: ExplorerAttachmentDragPayload[]) => {
      if (files.length === 0) return;

      const maxAttachmentCount = 50;
      const acceptedFiles: ExplorerAttachmentDragPayload[] = [];
      let rejectedImageCount = 0;
      for (const file of files) {
        if (
          harnessUsesHolaModelCatalog &&
          !selectedModelSupportsImageInput &&
          resolveExplorerAttachmentKind(file) === "image"
        ) {
          rejectedImageCount += 1;
          continue;
        }
        acceptedFiles.push(file);
      }

      const remainingSlots = Math.max(
        0,
        maxAttachmentCount - pendingAttachments.length,
      );
      const filesToAdd = acceptedFiles.slice(0, remainingSlots);
      const overflowCount = acceptedFiles.length - filesToAdd.length;
      const gateParts: string[] = [];
      if (rejectedImageCount > 0) {
        gateParts.push(
          `${imageInputUnsupportedMessage(selectedModelDisplayLabel)} Skipped ${rejectedImageCount} image attachment${rejectedImageCount === 1 ? "" : "s"}.`,
        );
      }
      if (overflowCount > 0) {
        gateParts.push(
          `Limit ${maxAttachmentCount} attachments — skipped ${overflowCount}.`,
        );
      }
      setAttachmentGateMessage(gateParts.join(" "));

      if (filesToAdd.length === 0) return;
      setPendingAttachments((current) => [
        ...current,
        ...filesToAdd.map(createPendingExplorerAttachment),
      ]);
    },
    [
      harnessUsesHolaModelCatalog,
      pendingAttachments.length,
      selectedModelDisplayLabel,
      selectedModelSupportsImageInput,
    ],
  );

  const onAttachmentInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      appendPendingLocalFiles(Array.from(event.target.files ?? []));
      event.target.value = "";
    },
    [appendPendingLocalFiles],
  );

  const removePendingAttachment = useCallback((attachmentId: string) => {
    setPendingAttachments((current) =>
      current.filter((attachment) => attachment.id !== attachmentId),
    );
  }, []);

  const pendingAttachmentItems = useMemo(
    () => pendingAttachmentsToListItems(pendingAttachments),
    [pendingAttachments],
  );

  const clearImageAttachmentPreviewObjectUrl = useCallback(() => {
    if (!imageAttachmentPreviewObjectUrlRef.current) return;
    URL.revokeObjectURL(imageAttachmentPreviewObjectUrlRef.current);
    imageAttachmentPreviewObjectUrlRef.current = null;
  }, []);

  const closeImageAttachmentPreview = useCallback(() => {
    imageAttachmentPreviewRequestIdRef.current += 1;
    clearImageAttachmentPreviewObjectUrl();
    setImageAttachmentPreview(null);
  }, [clearImageAttachmentPreviewObjectUrl]);

  useEffect(() => {
    return () => clearImageAttachmentPreviewObjectUrl();
  }, [clearImageAttachmentPreviewObjectUrl]);

  const openImageAttachmentPreview = useCallback(
    async (attachment: AttachmentListItem) => {
      if (attachment.kind !== "image") return;
      const attachmentPath = attachment.workspace_path?.trim() || "";
      if (!attachment.file && !attachmentPath) return;

      imageAttachmentPreviewRequestIdRef.current += 1;
      const requestId = imageAttachmentPreviewRequestIdRef.current;
      clearImageAttachmentPreviewObjectUrl();
      let localObjectUrl = "";
      setImageAttachmentPreview({
        attachment,
        dataUrl: "",
        isLoading: true,
        errorMessage: "",
      });

      try {
        let dataUrl = "";
        if (attachment.file) {
          localObjectUrl = URL.createObjectURL(attachment.file);
          dataUrl = localObjectUrl;
        } else {
          const preview = await window.electronAPI.fs.readFilePreview(
            attachmentPath,
            workspaceId,
          );
          if (preview.kind !== "image" || !preview.dataUrl) {
            throw new Error(
              preview.unsupportedReason ||
                "Image preview is not available for this attachment.",
            );
          }
          dataUrl = preview.dataUrl;
        }
        if (imageAttachmentPreviewRequestIdRef.current !== requestId) {
          if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
          return;
        }
        if (localObjectUrl) {
          imageAttachmentPreviewObjectUrlRef.current = localObjectUrl;
        }
        setImageAttachmentPreview({
          attachment,
          dataUrl,
          isLoading: false,
          errorMessage: "",
        });
      } catch (previewError) {
        if (imageAttachmentPreviewRequestIdRef.current !== requestId) return;
        if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
        setImageAttachmentPreview({
          attachment,
          dataUrl: "",
          isLoading: false,
          errorMessage:
            previewError instanceof Error && previewError.message.trim()
              ? previewError.message
              : "Failed to load image preview.",
        });
      }
    },
    [clearImageAttachmentPreviewObjectUrl, workspaceId],
  );

  const handleSubmit = useCallback(async () => {
    if (!workspaceId || !project) return;
    const text = composerText.trim();
    if (!text && pendingAttachments.length === 0) return;
    if (pendingImageInputUnsupportedMessage) return;
    setSubmitting(true);
    setError(null);
    try {
      let sessionId = pendingSessionIdRef.current;
      if (!sessionId) {
        const createResponse =
          await window.electronAPI.workspace.createMainSession(workspaceId, {
            project_id: project.project_id,
            harness_id: selectedHarnessId,
          });
        sessionId = createResponse.session?.session_id ?? null;
        if (!sessionId) {
          throw new Error("Session was not returned by the runtime");
        }
        pendingSessionIdRef.current = sessionId;
      }
      await window.electronAPI.workspace.activateMainSession(
        workspaceId,
        sessionId,
      );
      const stagedAttachments = await stagePendingFileAttachments(
        pendingAttachments,
        {
          stageLocalFiles: async (files) =>
            (
              await window.electronAPI.workspace.stageSessionAttachments({
                workspace_id: workspaceId,
                files: await Promise.all(
                  files.map((entry) => attachmentUploadPayload(entry.file)),
                ),
              })
            ).attachments,
          stageExplorerFiles: async (files) =>
            (
              await window.electronAPI.workspace.stageSessionAttachmentPaths({
                workspace_id: workspaceId,
                files: files.map((entry) => ({
                  absolute_path: entry.absolutePath,
                  name: entry.name,
                  mime_type: entry.mime_type ?? null,
                  kind: entry.kind,
                })),
              })
            ).attachments,
        },
      );
      await window.electronAPI.workspace.queueSessionInput({
        workspace_id: workspaceId,
        session_id: sessionId,
        text,
        image_urls: null,
        attachments: stagedAttachments,
        model: harnessUsesHolaModelCatalog
          ? resolvedChatModel || null
          : harnessChatModelOverride,
        thinking_value: harnessUsesHolaModelCatalog
          ? effectiveThinkingValue
          : harnessThinkingOverride,
      });
      setPendingAttachments([]);
      pendingSessionIdRef.current = null;
      setSelectedSessionId(sessionId);
      setSessionOpenRequest({
        sessionId,
        requestKey: Date.now(),
        readOnly: false,
      });
      setChatPanelView("chat");
      setProjectView(null);
      setFocusMode(true);
      setLastViewedMap((prev) => ({
        ...prev,
        [sessionId]: new Date().toISOString(),
      }));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to start the session",
      );
    } finally {
      setSubmitting(false);
    }
  }, [
    workspaceId,
    project,
    composerText,
    pendingAttachments,
    pendingImageInputUnsupportedMessage,
    selectedHarnessId,
    harnessUsesHolaModelCatalog,
    harnessChatModelOverride,
    harnessThinkingOverride,
    resolvedChatModel,
    effectiveThinkingValue,
    setSelectedSessionId,
    setSessionOpenRequest,
    setChatPanelView,
    setProjectView,
    setFocusMode,
    setLastViewedMap,
  ]);

  const handleDeleteProject = useCallback(async () => {
    if (!workspaceId || !project) return;
    if (
      !window.confirm(
        `Delete project '${project.name}'? Sessions move to General. The folder on disk is left untouched.`,
      )
    ) {
      return;
    }
    try {
      await window.electronAPI.workspace.deleteProject(
        workspaceId,
        project.project_id,
      );
      setProjectView({ mode: "index" });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to delete project",
      );
    }
  }, [workspaceId, project, setProjectView]);

  const openSession = useCallback(
    async (session: MainSessionRecordPayload) => {
      if (!workspaceId) return;
      setSelectedSessionId(session.session_id);
      setSessionOpenRequest({
        sessionId: session.session_id,
        requestKey: Date.now(),
        readOnly: false,
      });
      setChatPanelView("chat");
      setProjectView(null);
      setFocusMode(true);
      setLastViewedMap((prev) => ({
        ...prev,
        [session.session_id]: new Date().toISOString(),
      }));
      try {
        await window.electronAPI.workspace.activateMainSession(
          workspaceId,
          session.session_id,
        );
      } catch {
        // non-fatal
      }
    },
    [
      workspaceId,
      setSelectedSessionId,
      setSessionOpenRequest,
      setChatPanelView,
      setProjectView,
      setFocusMode,
      setLastViewedMap,
    ],
  );

  const submitDisabled =
    (!composerText.trim() && pendingAttachments.length === 0) ||
    submitting ||
    Boolean(pendingImageInputUnsupportedMessage);

  const onFormSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (submitDisabled) return;
      void handleSubmit();
    },
    [handleSubmit, submitDisabled],
  );

  const noop = useCallback(() => undefined, []);
  const composerAttachmentNotice =
    attachmentGateMessage || pendingImageInputUnsupportedMessage ? (
      <div
        role="status"
        aria-live="polite"
        className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
      >
        {attachmentGateMessage || pendingImageInputUnsupportedMessage}
      </div>
    ) : null;

  const hasRecents = projectSessions.length > 0;
  const hasOutputs = displayOutputs.length > 0;
  const isEmpty = !hasRecents && !hasOutputs;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div
        className="flex shrink-0 items-center justify-between gap-2 pt-4 pr-6 transition-[padding-left] duration-stride ease-out-expo"
        style={{ paddingLeft: headerPaddingLeft }}
      >
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
          <button
            type="button"
            onClick={() => setProjectView({ mode: "index" })}
            className="shrink-0 rounded text-muted-foreground transition-colors hover:text-foreground"
          >
            Projects
          </button>
          <span aria-hidden className="shrink-0 text-muted-foreground/40">
            /
          </span>
          <span className="min-w-0 truncate text-foreground">
            {project?.name?.trim() || "Untitled project"}
          </span>
        </nav>
        <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          aria-label="Pin project"
          disabled
          className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-50"
        >
          <Pin className="size-4" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label="Project actions"
                className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
              >
                <MoreHorizontal className="size-4" />
              </button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => void handleDeleteProject()}
              variant="destructive"
              disabled={!project}
            >
              <Trash2 className="size-3.5" />
              Delete project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div
          className={cn(
            "mx-auto flex min-h-full w-full max-w-3xl flex-col px-6 pb-12",
            isEmpty ? "justify-center" : "pt-16",
          )}
        >
          <h1 className="mb-4 px-0.5 font-serif text-2xl font-medium tracking-tight text-foreground">
            {project?.name?.trim() || GREETING}
          </h1>
          <form onSubmit={onFormSubmit} className="w-full">
            <div className="overflow-hidden rounded-2xl bg-muted">
              <Composer
                input={composerText}
                quotedSkills={[]}
                quotedIntegrations={[]}
                slashCommands={[]}
                attachments={pendingAttachmentItems}
                isResponding={false}
                pausePending={false}
                pauseDisabled
                disabled={!project}
                selectedModel={effectiveChatModelPreference}
                resolvedModelLabel={resolvedModelLabel}
                runtimeDefaultModelLabel={runtimeDefaultModelLabel}
                modelOptions={availableChatModelOptions}
                modelOptionGroups={availableChatModelOptionGroups}
                runtimeDefaultModelAvailable={runtimeDefaultModelAvailable}
                selectedThinkingValue={
                  harnessUsesHolaModelCatalog
                    ? effectiveThinkingValue
                    : harnessThinkingOverride
                }
                thinkingValues={
                  harnessUsesHolaModelCatalog
                    ? selectedThinkingValues
                    : ["low", "medium", "high"]
                }
                showThinkingValueSelector={
                  harnessUsesHolaModelCatalog
                    ? selectedModelSupportsReasoning
                    : true
                }
                harnessSupportedModels={harnessSupportedModels}
                harnessSelectedModel={harnessChatModelOverride}
                onHarnessModelChange={setHarnessChatModelOverride}
                modelSelectionUnavailableReason={modelSelectionUnavailableReason}
                submitDisabled={submitDisabled}
                placeholder="What would you like to work on in this project?"
                showModelSelector
                showAccessoryControls
                selectedProjectId={null}
                projectOptions={[]}
                showProjectPicker={false}
                onProjectChange={noop}
                onModelChange={setChatModelPreference}
                onThinkingValueChange={
                  harnessUsesHolaModelCatalog
                    ? setSelectedThinkingValue
                    : setHarnessThinkingOverride
                }
                onOpenModelProviders={() =>
                  void window.electronAPI.ui.openSettingsPane("account")
                }
                fileInputRef={fileInputRef}
                onAttachmentInputChange={onAttachmentInputChange}
                onPause={noop}
                onAddDroppedFiles={appendPendingLocalFiles}
                onAddExplorerAttachments={appendPendingExplorerAttachments}
                mentionableItems={[]}
                onRemoveQuotedIntegration={noop}
                onSelectIntegration={noop}
                onRemoveAttachment={removePendingAttachment}
                onPreviewAttachment={(attachment) =>
                  void openImageAttachmentPreview(attachment)
                }
                composerEditorRef={composerEditorRef}
                onValueChange={(value) => setComposerText(value.text)}
                onSubmit={() => {
                  if (!submitDisabled) {
                    void handleSubmit();
                  }
                }}
                onRecallLatest={() => false}
                onCancelDraft={() => false}
              />
              <RuntimeContextBar
                harnesses={availableHarnesses}
                harnessesLoading={harnessesLoading}
                onHarnessChange={setSelectedHarnessId}
                selectedHarnessId={selectedHarnessId}
                workspaceHint={project?.name ?? null}
              />
            </div>
          </form>
          {composerAttachmentNotice}
          {error ? (
            <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}

          {isEmpty ? (
            <div className="mt-12 flex flex-col items-center justify-center gap-3 text-center">
              <MessageSquareText
                className="size-7 text-muted-foreground"
                aria-hidden
              />
              <p className="max-w-sm text-sm text-muted-foreground">
                Start a chat above to begin. The sessions and outputs you
                create in this project will show up here.
              </p>
            </div>
          ) : null}

          {hasOutputs ? (
            <ProjectOutputsRow
              onOpenFull={openOutput}
              onPreview={setPreviewOutput}
              outputs={displayOutputs}
            />
          ) : null}

          {hasRecents ? (
            <div className="mt-10">
              <h2 className="px-1 text-sm font-medium text-muted-foreground">
                Recents
              </h2>
              <div className="mt-3 flex flex-col gap-1">
                {projectSessions.map((session) => (
                  <RecentRow
                    key={session.session_id}
                    session={session}
                    onOpen={() => void openSession(session)}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <OutputPreviewModal
        onClose={() => setPreviewOutput(null)}
        onGoToSession={goToOutputSession}
        onOpenFull={(output) => {
          setPreviewOutput(null);
          openOutput(output);
        }}
        output={previewOutput}
        workspacePath={selectedWorkspace?.workspace_path ?? null}
      />
      <ImageAttachmentPreviewModal
        open={Boolean(imageAttachmentPreview)}
        preview={imageAttachmentPreview}
        onClose={closeImageAttachmentPreview}
      />
    </div>
  );
}

function RecentRow({
  session,
  onOpen,
}: {
  session: MainSessionRecordPayload;
  onOpen: () => void;
}) {
  const title = session.title?.trim() || "New chat";
  return (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-foreground/4">
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full border border-muted-foreground/40"
      />
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 text-left"
      >
        <div className="truncate text-sm font-medium text-foreground">
          {title}
        </div>
      </button>
      <span className="shrink-0 text-xs text-muted-foreground">
        {relativeTime(session.updated_at)}
      </span>
    </div>
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms) || ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}
