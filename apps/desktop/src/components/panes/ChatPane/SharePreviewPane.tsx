import type { ShareDraftSessionTurn } from "@holaboss/app-host/protocol";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useMemo, useState } from "react";
import { fileNameFromPath } from "@/components/layout/shell/state/internalTabs";
import {
  type ShareMode,
  shareInitialModeAtom,
  shareSessionPayloadAtom,
  workspaceOverlayAtom,
} from "@/components/layout/shell/state/ui";
import { useShareToHolahub } from "@/components/layout/shell/useShareToHolahub";
import { Button } from "@/components/ui/button";
import { Check, Square, X } from "@/components/ui/icons";
import { FileTypeIcon } from "@/lib/fileIcon";
import { cn } from "@/lib/utils";
import { AssistantTurn } from "./AssistantTurn";
import {
  gatherSessionSnapshot,
  gatherShareAttributionItems,
  gatherShareFiles,
  gatherShareImages,
  gatherShareVideos,
  isShareableDocOutput,
  isShareableMediaOutput,
  type ShareableOutput,
  visibleText,
} from "./AssistantTurn/shareCapture";
import type { ChatMessage } from "./types";
import { UserTurn } from "./UserTurn";

function shareableOutputCount(message: ChatMessage): number {
  return ((message.outputs ?? []) as ShareableOutput[]).filter(
    (o) => isShareableMediaOutput(o) || isShareableDocOutput(o)
  ).length;
}

// A turn worth offering to share: visible text (which may live in segments) or an
// attachable output. Mirrors gatherSessionSnapshot so what's shown is what posts.
function isShareableTurn(message: ChatMessage): boolean {
  if (message.role !== "user" && message.role !== "assistant") {
    return false;
  }
  return Boolean(visibleText(message)) || shareableOutputCount(message) > 0;
}

function ToggleBadge({ checked }: { checked: boolean }) {
  return checked ? (
    <span className="flex size-4 items-center justify-center rounded bg-primary text-primary-foreground">
      <Check className="size-3" strokeWidth={2.5} />
    </span>
  ) : (
    <Square className="size-4 text-muted-foreground" />
  );
}

/**
 * Full-page "Share to HolaHub" composer. Two ways to share, chosen by a header
 * toggle: **Conversation** renders the transcript with the real chat components
 * (pick turns → a "session" post), and **Outputs** lets the user pick just the
 * artifacts the assistant produced (→ a media "post", no transcript). Either way
 * the assembled draft is handed to the hub composer to caption + attach + publish.
 */
export function SharePreviewPane() {
  const [payload] = useAtom(shareSessionPayloadAtom);
  const setOverlay = useSetAtom(workspaceOverlayAtom);
  const shareToHolahub = useShareToHolahub();

  const messages = useMemo(() => payload?.messages ?? [], [payload]);
  const turns = useMemo(
    () => messages.filter(isShareableTurn),
    [messages]
  );
  // Every shareable artifact across the conversation — images, videos, and
  // deliverable docs (pdf/pptx/md/…) — the unit of the Outputs mode.
  const shareableOutputs = useMemo(
    () =>
      messages.flatMap((m) =>
        ((m.outputs ?? []) as ShareableOutput[]).filter(
          (o) => isShareableMediaOutput(o) || isShareableDocOutput(o)
        )
      ),
    [messages]
  );

  const initialMode = useAtomValue(shareInitialModeAtom);
  const [mode, setMode] = useState<ShareMode>(initialMode);
  const effectiveMode: ShareMode =
    shareableOutputs.length > 0 ? mode : "conversation";

  const [excludedTurns, setExcludedTurns] = useState<Set<string>>(new Set());
  const [selectedOutputs, setSelectedOutputs] = useState<Set<string>>(
    () => new Set(shareableOutputs.map((o) => o.id))
  );
  const [collapsedTrace, setCollapsedTrace] = useState<Record<string, boolean>>(
    {}
  );
  const [includeModel, setIncludeModel] = useState(true);
  const [caption, setCaption] = useState("");
  const [posting, setPosting] = useState(false);

  const close = () => setOverlay(null);
  const toggleTurn = (id: string) =>
    setExcludedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  const toggleOutput = (id: string) =>
    setSelectedOutputs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  const toggleTrace = (stepId: string) =>
    setCollapsedTrace((prev) => ({ ...prev, [stepId]: !prev[stepId] }));

  const selectedTurns = turns.filter((t) => !excludedTurns.has(t.id));
  const chosenOutputs = shareableOutputs.filter((o) =>
    selectedOutputs.has(o.id)
  );
  const model = payload?.model?.trim() || "";

  const canPost =
    effectiveMode === "outputs"
      ? chosenOutputs.length > 0
      : selectedTurns.length > 0;

  const postConversation = async () => {
    if (!payload) {
      return;
    }
    const snapshot = await gatherSessionSnapshot(
      selectedTurns,
      payload.workspaceId,
      includeModel ? model : undefined
    );
    if (snapshot.turns.length === 0) {
      return;
    }
    // Credit the apps that actually produced this conversation's outputs, so a
    // shared session shows "Made with <App>" (not just skills).
    const items = gatherShareAttributionItems(
      selectedTurns.flatMap((t) => (t.outputs ?? []) as ShareableOutput[])
    );
    await shareToHolahub({ body: caption, items, session: snapshot });
  };

  const postOutputs = async () => {
    if (!payload) {
      return;
    }
    const [images, videos, files] = await Promise.all([
      gatherShareImages(chosenOutputs, payload.workspaceId),
      gatherShareVideos(chosenOutputs, payload.workspaceId),
      gatherShareFiles(chosenOutputs, payload.workspaceId),
    ]);
    if (images.length === 0 && videos.length === 0 && files.length === 0) {
      return;
    }
    // Seed the apps that made these outputs; the user adds any skills/MCPs in the
    // composer's attach picker next.
    const items = gatherShareAttributionItems(chosenOutputs);
    // Hidden context so the composer's "Draft with AI" can caption the artifact
    // from what the assistant said while making it.
    const sourceText = messages
      .filter((m) => m.role === "assistant")
      .map(visibleText)
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 6000);
    if (files.length > 0) {
      // Docs have no standalone-post transport, so wrap the picked artifacts in a
      // one-turn session (its file/media cards ARE the post — no transcript).
      const turn: ShareDraftSessionTurn = {
        role: "assistant",
        text: "",
        ...(images.length > 0 ? { images } : {}),
        ...(videos.length > 0 ? { videos } : {}),
        ...(files.length > 0 ? { files } : {}),
      };
      await shareToHolahub({
        body: caption,
        sourceText,
        items,
        session: { turns: [turn] },
      });
      return;
    }
    await shareToHolahub({ body: caption, sourceText, images, videos, items });
  };

  const post = async () => {
    if (!canPost || posting) {
      return;
    }
    setPosting(true);
    try {
      if (effectiveMode === "outputs") {
        await postOutputs();
      } else {
        await postConversation();
      }
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-border border-b px-4 py-2.5">
        <button
          aria-label="Cancel"
          className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground"
          onClick={close}
          type="button"
        >
          <X className="size-4" />
        </button>
        <span className="font-semibold text-foreground text-sm">
          Share to HolaHub
        </span>
        {shareableOutputs.length > 0 ? (
          <div className="flex items-center gap-0.5 rounded-lg bg-fg-6 p-0.5">
            {(["conversation", "outputs"] as const).map((m) => (
              <button
                className={cn(
                  "rounded-md px-2.5 py-1 font-medium text-xs transition-colors",
                  effectiveMode === m
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
                key={m}
                onClick={() => setMode(m)}
                type="button"
              >
                {m === "conversation" ? "Conversation" : "Outputs"}
              </button>
            ))}
          </div>
        ) : null}
        <span className="text-muted-foreground text-xs">
          {effectiveMode === "outputs"
            ? `${chosenOutputs.length}/${shareableOutputs.length} outputs`
            : `${selectedTurns.length}/${turns.length} turns`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {effectiveMode === "conversation" && model ? (
            <Button
              onClick={() => setIncludeModel((v) => !v)}
              size="sm"
              type="button"
              variant={includeModel ? "secondary" : "outline"}
            >
              <ToggleBadge checked={includeModel} />
              Show model
            </Button>
          ) : null}
          <Button
            disabled={!canPost || posting}
            onClick={() => void post()}
            size="sm"
            type="button"
          >
            {posting ? "Sharing…" : "Continue"}
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 py-6">
          <textarea
            className="w-full resize-none rounded-xl border border-border bg-card px-3.5 py-2.5 text-[15px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-primary/50"
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Add a caption… (optional — you can also let AI draft it next)"
            rows={2}
            value={caption}
          />

          {effectiveMode === "outputs" ? (
            <div className="flex flex-col gap-2">
              {shareableOutputs.map((output) => {
                const selected = selectedOutputs.has(output.id);
                const name = output.file_path
                  ? fileNameFromPath(output.file_path)
                  : "Output";
                return (
                  <button
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors",
                      selected
                        ? "border-primary/50 bg-primary/[0.06]"
                        : "border-border/70 bg-foreground/[0.02] hover:bg-foreground/[0.05]"
                    )}
                    key={output.id}
                    onClick={() => toggleOutput(output.id)}
                    type="button"
                  >
                    <ToggleBadge checked={selected} />
                    <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
                      <FileTypeIcon filePath={output.file_path ?? ""} size={18} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {name}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : turns.length === 0 ? (
            <p className="py-16 text-center text-muted-foreground text-sm">
              Nothing shareable in this conversation yet.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {turns.map((turn) => {
                const excluded = excludedTurns.has(turn.id);
                return (
                  <div className="flex items-start gap-2.5" key={turn.id}>
                    <button
                      aria-label={excluded ? "Include turn" : "Exclude turn"}
                      className="mt-2 shrink-0"
                      onClick={() => toggleTurn(turn.id)}
                      type="button"
                    >
                      <ToggleBadge checked={!excluded} />
                    </button>
                    <div
                      className={cn(
                        "min-w-0 flex-1 transition-opacity",
                        excluded && "opacity-40"
                      )}
                    >
                      {turn.role === "user" ? (
                        <UserTurn
                          attachments={turn.attachments ?? []}
                          createdAt={turn.createdAt}
                          text={turn.text}
                        />
                      ) : (
                        <AssistantTurn
                          collapsedTraceByStepId={collapsedTrace}
                          executionItems={turn.executionItems ?? []}
                          harnessId={payload?.harnessId ?? null}
                          label={payload?.label ?? ""}
                          mode={payload?.mode ?? ""}
                          onToggleTraceStep={toggleTrace}
                          outputs={turn.outputs ?? []}
                          segments={turn.segments ?? []}
                          showAvatar
                          showExecutionInternals={
                            payload?.showExecutionInternals ?? true
                          }
                          text={turn.text}
                          tone={turn.tone ?? "default"}
                          workspaceId={payload?.workspaceId ?? null}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
