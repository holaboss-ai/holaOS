// A dedicated, streaming chat pane for a SERVER-SIDE HolaEmployee — same look + feel as
// the General agent: it reuses the General chat's ConversationTurns renderer (markdown,
// avatars, streaming live turn) AND the shared pi Composer (paste/drag-drop, attachment
// chips, stop button) rather than a hand-rolled message list + textarea. The transport is
// our pi-event SSE relayed over the gateway bridge (useEmployeeChat); committed turns feed
// `messages`, the in-progress turn feeds `liveAssistantTurn`.

import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Composer } from "@/components/panes/ChatPane/Composer";
import type { ComposerEditorHandle } from "@/components/panes/ChatPane/Composer/editor/ComposerEditor";
import { ConversationTurns } from "@/components/panes/ChatPane/ConversationTurns";
import type {
  AttachmentListItem,
  ChatComposerQuotedIntegrationItem,
  ChatComposerSlashCommandOption,
  ChatMessage,
} from "@/components/panes/ChatPane/types";
import { FileText, Loader2 } from "@/components/ui/icons";
import { clearViewedThread, markThreadViewed } from "./chatStore";
import { EmployeeAvatar } from "./EmployeeAvatar";
import { useEmployeeEquipment, useHolaEmployees } from "./useEmployees";
import {
  type EmployeeArtifact,
  type OutboundAttachment,
  useEmployeeChat,
} from "./useEmployeeChat";

/** Read a File to bare base64 (no data: prefix) for the chat transport. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

/** Renders a completed turn's artifacts inline: images shown directly, other files
 *  as downloadable chips. Bytes are inlined base64 by the backend (data URLs). */
function ArtifactGallery({ artifacts }: { artifacts: EmployeeArtifact[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {artifacts.map((a, i) => {
        const dataUrl = `data:${a.mimeType};base64,${a.dataBase64}`;
        const key = `${a.filename}-${i}`;
        if (a.mimeType.startsWith("image/")) {
          return (
            <a
              className="block"
              download={a.filename}
              href={dataUrl}
              key={key}
              title={a.filename}
            >
              <img
                alt={a.filename}
                className="max-h-72 max-w-sm rounded-md border object-contain"
                src={dataUrl}
              />
            </a>
          );
        }
        return (
          <a
            className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2 text-foreground text-xs hover:bg-muted/70"
            download={a.filename}
            href={dataUrl}
            key={key}
          >
            <FileText className="size-4 shrink-0" />
            <span className="max-w-[16rem] truncate">{a.filename}</span>
          </a>
        );
      })}
    </div>
  );
}

export interface EmployeeChatPaneProps {
  employeeId: string;
  employeeName: string;
  /** A client-stable thread id; a new value starts a fresh conversation. */
  threadId: string;
  /** Freshly-started chat — no server history to load (skip the spinner). */
  isNew?: boolean;
}

export function EmployeeChatPane({
  employeeId,
  employeeName,
  threadId,
  isNew,
}: EmployeeChatPaneProps) {
  const {
    messages,
    isLoadingHistory,
    liveText,
    liveExecutionItems,
    lastArtifacts,
    lastArtifactMessageId,
    isStreaming,
    error,
    send,
    stop,
  } = useEmployeeChat(employeeId, threadId, isNew);

  // The employee's identity avatar (bg color + emoji, or the Holaboss brand mark for
  // the preset "Hola") — brands every assistant turn instead of the harness/workspace-
  // seeded face the local agent uses.
  const { data: roster } = useHolaEmployees();
  const assistantEmployee = useMemo(
    () => roster?.find((e) => e.employeeId === employeeId) ?? null,
    [roster, employeeId],
  );
  const assistantAvatar = assistantEmployee?.avatar ?? null;
  const assistantPreset = assistantEmployee?.preset ?? false;
  // Draft-vs-published state for the header chip. Only meaningful on the OWNER's own
  // employees (a shared employee, i.e. a member, always talks to the published version).
  // The owner's in-app chat runs the DRAFT, so this tells them which version they're testing.
  const draftState: "dirty" | "published" | null =
    assistantEmployee && !assistantEmployee.shared
      ? assistantEmployee.hasUnpublishedChanges
        ? "dirty"
        : assistantEmployee.published
          ? "published"
          : null
      : null;

  // The employee's equipped skills / capabilities / integrations → the composer's
  // "+" menu. These are always-on standing config (the transport carries no per-turn
  // selection), so a pick becomes a natural-language hint appended to the message.
  const { data: equipment } = useEmployeeEquipment(employeeId);
  const slashCommands = useMemo<ChatComposerSlashCommandOption[]>(() => {
    const skills = (equipment?.skills ?? []).map((s) => ({
      kind: "skill" as const,
      key: `skill:${s.id}`,
      command: s.label,
      label: s.label,
      description: "",
      searchText: s.label.toLowerCase(),
      skillId: s.id,
    }));
    const capabilities = (equipment?.capabilities ?? []).map((c) => ({
      kind: "capability" as const,
      key: `capability:${c.id}`,
      command: c.label,
      label: c.label,
      description: "",
      searchText: c.label.toLowerCase(),
      capabilityId: c.id,
      installedSkillIds: [],
      integrationProviders: [],
    }));
    return [...skills, ...capabilities];
  }, [equipment]);
  // id → label maps, so a picked skill/capability chip becomes a readable hint.
  const skillLabelById = useMemo(
    () => new Map((equipment?.skills ?? []).map((s) => [s.id, s.label])),
    [equipment],
  );
  const capabilityLabelById = useMemo(
    () => new Map((equipment?.capabilities ?? []).map((c) => [c.id, c.label])),
    [equipment],
  );

  const [quotedIntegrations, setQuotedIntegrations] = useState<
    ChatComposerQuotedIntegrationItem[]
  >([]);
  const [attachments, setAttachments] = useState<AttachmentListItem[]>([]);
  const [composerText, setComposerText] = useState("");
  // Skill/capability chips live in the editor (not `composerText`), so track their
  // presence separately to keep the send button enabled on a picks-only message.
  const [composerHasChips, setComposerHasChips] = useState(false);
  const [collapsedTraceByStepId, setCollapsedTraceByStepId] = useState<
    Record<string, boolean>
  >({});
  const toggleTraceStep = (stepId: string) =>
    setCollapsedTraceByStepId((c) => ({ ...c, [stepId]: !c[stepId] }));
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerEditorRef = useRef<ComposerEditorHandle | null>(null);

  // Keep the newest message in view as tokens stream in.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, liveText, liveExecutionItems]);

  // While this thread is on screen, it's "viewed" — a turn finishing here won't
  // flag it unread, and opening an unread thread clears its blue dot.
  useEffect(() => {
    markThreadViewed(employeeId, threadId);
    return () => clearViewedThread();
  }, [employeeId, threadId]);

  // Drop staged attachments when switching thread/employee (the AttachmentList
  // owns its own object URLs, so we only need to clear our list).
  useEffect(() => {
    setAttachments([]);
    setQuotedIntegrations([]);
    setComposerText("");
    setComposerHasChips(false);
    composerEditorRef.current?.clear();
  }, [employeeId, threadId]);

  const onSelectIntegration = useCallback((slug: string, name: string) => {
    setQuotedIntegrations((prev) =>
      prev.some((i) => i.slug === slug)
        ? prev
        : [...prev, { slug, name, logo: null }],
    );
  }, []);
  const onRemoveQuotedIntegration = useCallback((slug: string) => {
    setQuotedIntegrations((prev) => prev.filter((i) => i.slug !== slug));
  }, []);

  // Stage files (from the "+" picker, paste, or drag-drop). Images and other
  // files are both carried: the backend normalizer routes image/* to model
  // vision and stages every other file into the agent's sandbox inbox/ so it
  // can read them — same path Slack/Discord/WeChat use.
  const addFiles = useCallback((files: File[]) => {
    if (files.length === 0) {
      return;
    }
    setAttachments((prev) => [
      ...prev,
      ...files.map<AttachmentListItem>((file) => ({
        id: crypto.randomUUID(),
        kind: file.type.startsWith("image/") ? "image" : "file",
        name: file.name,
        size_bytes: file.size,
        file,
      })),
    ]);
  }, []);

  const onAttachmentInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      addFiles(Array.from(e.target.files ?? []));
      e.target.value = ""; // allow re-picking the same file
    },
    [addFiles],
  );

  const onRemoveAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const chatMessages = useMemo<ChatMessage[]>(
    () =>
      messages.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        ...(m.executionItems ? { executionItems: m.executionItems } : {}),
        ...(m.attachments ? { attachments: m.attachments } : {}),
      })),
    [messages],
  );
  const hasContent = chatMessages.length > 0 || liveText !== null;

  const submit = useCallback(async () => {
    const value = composerEditorRef.current?.getValue();
    const text = (value?.text ?? composerText).trim();
    // Explicitly picked skills/capabilities/integrations (chips) don't ride the
    // text-only transport, so translate them into a natural-language hint the
    // always-on employee honors ("[Using: Web Research, Notion]").
    const picks = [
      ...(value?.skillIds ?? []).map((id) => skillLabelById.get(id) ?? id),
      ...(value?.capabilityIds ?? []).map(
        (id) => capabilityLabelById.get(id) ?? id,
      ),
      ...quotedIntegrations.map((i) => i.name),
    ];
    if ((!text && picks.length === 0) || isStreaming) {
      return;
    }
    const message =
      picks.length > 0
        ? `${text ? `${text}\n\n` : ""}[Using: ${picks.join(", ")}]`
        : text;
    let outbound: OutboundAttachment[] | undefined;
    const staged = attachments.filter((a) => a.file);
    if (staged.length > 0) {
      outbound = await Promise.all(
        staged.map(async (a) => ({
          name: a.name,
          mimeType:
            a.file?.type ||
            (a.kind === "image" ? "image/png" : "application/octet-stream"),
          contentBase64: await fileToBase64(a.file as File),
        })),
      );
    }
    send(message, outbound, staged.length > 0 ? staged : undefined);
    composerEditorRef.current?.clear();
    setComposerText("");
    setComposerHasChips(false);
    setAttachments([]);
    setQuotedIntegrations([]);
  }, [
    attachments,
    capabilityLabelById,
    composerText,
    isStreaming,
    quotedIntegrations,
    send,
    skillLabelById,
  ]);

  const noop = useCallback(() => undefined, []);
  const returnFalse = useCallback(() => false, []);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        {assistantAvatar || assistantPreset ? (
          <EmployeeAvatar
            avatar={assistantAvatar}
            className="size-7 rounded-md text-[15px]"
            name={employeeName}
            preset={assistantPreset}
          />
        ) : (
          <span className="size-7 shrink-0 rounded-md bg-muted" />
        )}
        <p className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
          {employeeName}
        </p>
        {draftState === "dirty" ? (
          <span
            className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-[11px] text-amber-600 dark:text-amber-400"
            title="You're testing your draft — recipients still see the published version until you publish (in the employee's page)."
          >
            Draft · unpublished
          </span>
        ) : draftState === "published" ? (
          <span
            className="shrink-0 rounded-full bg-muted px-2 py-0.5 font-medium text-[11px] text-muted-foreground"
            title="Your draft matches the published version recipients see."
          >
            Published
          </span>
        ) : null}
      </div>

      <div
        className="chat-scrollbar-thin h-full min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
        ref={scrollRef}
      >
        {hasContent ? (
          <div className="flex w-full">
            <div className="min-w-0 flex-1">
              <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-2 px-4 pt-5 pb-3 sm:px-5">
                <ConversationTurns
                  assistantAvatar={assistantAvatar}
                  assistantAvatarPreset={assistantPreset}
                  assistantFooterAccessory={
                    lastArtifacts.length > 0 ? (
                      <ArtifactGallery artifacts={lastArtifacts} />
                    ) : null
                  }
                  assistantFooterAccessoryMessageId={lastArtifactMessageId}
                  assistantLabel={employeeName}
                  assistantMode="chat"
                  collapsedTraceByStepId={collapsedTraceByStepId}
                  liveAssistantTurn={
                    liveText === null
                      ? null
                      : {
                          text: liveText,
                          tone: "default",
                          segments: [],
                          executionItems: liveExecutionItems,
                        }
                  }
                  messages={chatMessages}
                  onToggleTraceStep={toggleTraceStep}
                  showExecutionInternals
                />
              </div>
            </div>
          </div>
        ) : isLoadingHistory ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
            {assistantAvatar || assistantPreset ? (
              <EmployeeAvatar
                avatar={assistantAvatar}
                className="size-12 rounded-full text-2xl"
                name={employeeName}
                preset={assistantPreset}
              />
            ) : null}
            <p className="font-medium text-foreground text-sm">
              {employeeName}
            </p>
            <p className="text-muted-foreground text-sm">
              Say hello to {employeeName}.
            </p>
          </div>
        )}
      </div>

      {error ? (
        <div className="mx-4 mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-xs">
          {error}
        </div>
      ) : null}

      <div className="px-4 pt-1 pb-4">
        <div className="mx-auto max-w-3xl">
          {/* The shared pi Composer — minus the model / reasoning / project
              selectors (an employee's model is fixed server-side). The "+" menu's
              Skills / Capabilities / Integrations submenus are populated from the
              employee's equipped set (read-only; picks become a message hint). */}
          <Composer
            attachments={attachments}
            composerEditorRef={composerEditorRef}
            disabled={false}
            employeeIntegrations={equipment?.integrations ?? []}
            fileInputRef={fileInputRef}
            input={composerText}
            isResponding={isStreaming}
            mentionableItems={[]}
            modelOptionGroups={[]}
            modelOptions={[]}
            modelSelectionUnavailableReason=""
            onAddDroppedFiles={addFiles}
            onAddExplorerAttachments={noop}
            onAttachmentInputChange={onAttachmentInputChange}
            onCancelDraft={returnFalse}
            onModelChange={noop}
            onOpenModelProviders={noop}
            onPause={stop}
            onPreviewAttachment={noop}
            onProjectChange={noop}
            onRecallLatest={returnFalse}
            onRemoveAttachment={onRemoveAttachment}
            onRemoveQuotedIntegration={onRemoveQuotedIntegration}
            onSelectIntegration={onSelectIntegration}
            onSubmit={() => void submit()}
            onThinkingValueChange={noop}
            onValueChange={(value) => {
              setComposerText(value.text);
              setComposerHasChips(
                (value.skillIds?.length ?? 0) +
                  (value.capabilityIds?.length ?? 0) >
                  0,
              );
            }}
            pauseDisabled={!isStreaming}
            pausePending={false}
            placeholder={`Message ${employeeName}…`}
            projectOptions={[]}
            quotedIntegrations={quotedIntegrations}
            quotedSkills={[]}
            resolvedModelLabel=""
            runtimeDefaultModelAvailable={false}
            runtimeDefaultModelLabel=""
            selectedModel=""
            selectedProjectId={null}
            selectedThinkingValue={null}
            showAccessoryControls
            showModelSelector={false}
            showProjectPicker={false}
            showThinkingValueSelector={false}
            slashCommands={slashCommands}
            submitDisabled={
              composerText.trim().length === 0 &&
              attachments.length === 0 &&
              !composerHasChips &&
              quotedIntegrations.length === 0
            }
            thinkingValues={[]}
          />
        </div>
      </div>
    </div>
  );
}
