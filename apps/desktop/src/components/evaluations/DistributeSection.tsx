import { useMutation } from "@tanstack/react-query";
import { useAtomValue, useSetAtom } from "jotai";
import type { ReactNode } from "react";
import { toast } from "sonner";
import {
  chatComposerPrefillAtom,
  chatPanelHiddenAtom,
  nextComposerPrefillKey,
  selectedSessionIdAtom,
} from "@/components/layout/shell/state/ui";
import { Button } from "@/components/ui/button";
import { Copy, Loader2, MessageSquareText, Plus, Save, X } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { remoteApiQuery } from "@/lib/remoteApiQuery";
import { cn } from "@/lib/utils";
import { useInvalidateEvaluation } from "./data";
import { useServerDraft } from "./draft";
import { type EvaluationRecord, errorMessage, isRecord } from "./format";
import { Callout, Panel } from "./parts";
import { useOpenEvaluation } from "./useOpenEvaluation";

const X_POST_LIMIT = 280;

const DRAFT_REQUEST =
  "Write the distribution drafts for this evaluation from its report: one X post, an X thread, a short post in Chinese, and a video script with an outline. Use my voice from the write-up, keep every number as it appears in the data, and save them to the evaluation.";

interface XPost {
  text: string;
}
interface XThread {
  posts: string[];
}
interface CnPost {
  title: string;
  text: string;
}
interface VideoScript {
  title: string;
  outline: string[];
  script: string;
  assets: string[];
}

type FormatId = "x_post" | "x_thread" | "cn_post" | "video_script";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readXPost(value: unknown): XPost {
  return { text: isRecord(value) ? str(value.text) : "" };
}

function readXThread(value: unknown): XThread {
  return { posts: isRecord(value) ? strings(value.posts) : [] };
}

function readCnPost(value: unknown): CnPost {
  return isRecord(value)
    ? { title: str(value.title), text: str(value.text) }
    : { title: "", text: "" };
}

function readVideoScript(value: unknown): VideoScript {
  return isRecord(value)
    ? {
        title: str(value.title),
        outline: strings(value.outline),
        script: str(value.script),
        assets: strings(value.assets),
      }
    : { title: "", outline: [], script: "", assets: [] };
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied");
  } catch {
    toast.error("Couldn't copy to the clipboard.");
  }
}

export function DistributeSection({
  evaluation,
}: {
  evaluation: EvaluationRecord;
}) {
  const evalId = evaluation.eval_id;
  const distribution = isRecord(evaluation.distribution)
    ? evaluation.distribution
    : {};
  const invalidate = useInvalidateEvaluation(evalId);
  const openEvaluation = useOpenEvaluation();
  const selectedSessionId = useAtomValue(selectedSessionIdAtom);
  const setComposerPrefill = useSetAtom(chatComposerPrefillAtom);
  const setChatPanelHidden = useSetAtom(chatPanelHiddenAtom);
  const saveMutation = useMutation(
    remoteApiQuery.evals.saveDistribution.mutationOptions(),
  );

  const xPost = readXPost(distribution.x_post);
  const xThread = readXThread(distribution.x_thread);
  const cnPost = readCnPost(distribution.cn_post);
  const videoScript = readVideoScript(distribution.video_script);
  const hasAny =
    Boolean(xPost.text.trim()) ||
    xThread.posts.some((post) => post.trim()) ||
    Boolean(cnPost.text.trim() || cnPost.title.trim()) ||
    Boolean(videoScript.script.trim() || videoScript.outline.length > 0);

  const save = async (id: FormatId, value: unknown): Promise<boolean> => {
    try {
      const updated = await saveMutation.mutateAsync({
        evalId,
        distribution: { ...distribution, [id]: value },
      });
      await invalidate({ evaluation: updated });
      return true;
    } catch (cause) {
      toast.error(errorMessage(cause, "Couldn't save the draft."));
      return false;
    }
  };

  const sessionId = evaluation.session_id?.trim() || "";
  const askAgent = () => {
    if (!sessionId) {
      return;
    }
    if (selectedSessionId !== sessionId) {
      openEvaluation(evaluation);
    }
    setChatPanelHidden(false);
    setComposerPrefill({
      text: DRAFT_REQUEST,
      requestKey: nextComposerPrefillKey(),
      mode: "replace",
      sessionMode: "preserve",
      autoSubmit: true,
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {hasAny ? (
        <Callout icon={<MessageSquareText />}>
          To post from a connected account, ask the agent in the chat. It shows
          you the exact text to approve before anything goes out.
        </Callout>
      ) : (
        <Callout
          action={
            <Button
              disabled={!sessionId}
              onClick={askAgent}
              size="sm"
              type="button"
            >
              Ask the agent to draft them
            </Button>
          }
          icon={<MessageSquareText />}
        >
          No drafts yet. The agent can write them from the report in the chat
          on the right, or you can write your own below.
        </Callout>
      )}

      <XPostCard onSave={(value) => save("x_post", value)} saving={saveMutation.isPending} server={xPost} />
      <XThreadCard onSave={(value) => save("x_thread", value)} saving={saveMutation.isPending} server={xThread} />
      <CnPostCard onSave={(value) => save("cn_post", value)} saving={saveMutation.isPending} server={cnPost} />
      <VideoScriptCard onSave={(value) => save("video_script", value)} saving={saveMutation.isPending} server={videoScript} />
    </div>
  );
}

interface CardProps<T> {
  server: T;
  saving: boolean;
  onSave: (value: T) => Promise<boolean>;
}

function FormatCard<T>({
  title,
  description,
  server,
  saving,
  onSave,
  toCopy,
  isEmpty,
  children,
}: CardProps<T> & {
  title: string;
  description: string;
  toCopy: (value: T) => string;
  isEmpty: (value: T) => boolean;
  children: (
    draft: T,
    setDraft: (next: T | ((prev: T) => T)) => void,
  ) => ReactNode;
}) {
  const { draft, setDraft, dirty, discard, markSaved } =
    useServerDraft<T>(server);

  return (
    <Panel
      actions={
        <>
          {dirty ? (
            <Button
              disabled={saving}
              onClick={discard}
              size="xs"
              type="button"
              variant="ghost"
            >
              Discard
            </Button>
          ) : null}
          <Button
            disabled={!dirty || saving}
            onClick={() =>
              void onSave(draft).then((ok) => {
                if (ok) markSaved(draft);
              })
            }
            size="xs"
            type="button"
            variant="outline"
          >
            {saving && dirty ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Save className="size-3" />
            )}
            Save
          </Button>
          <Button
            disabled={isEmpty(draft)}
            onClick={() => void copyText(toCopy(draft))}
            size="xs"
            type="button"
            variant="ghost"
          >
            <Copy className="size-3" />
            Copy
          </Button>
        </>
      }
      description={description}
      title={title}
    >
      {children(draft, setDraft)}
    </Panel>
  );
}

function CharCount({ value, limit }: { value: string; limit: number }) {
  const count = Array.from(value).length;
  return (
    <span
      className={cn(
        "text-[11px] tabular-nums",
        count > limit ? "font-medium text-destructive" : "text-muted-foreground",
      )}
    >
      {count}/{limit}
    </span>
  );
}

function XPostCard(props: CardProps<XPost>) {
  return (
    <FormatCard
      {...props}
      description="One post, up to 280 characters."
      isEmpty={(value) => !value.text.trim()}
      title="X post"
      toCopy={(value) => value.text.trim()}
    >
      {(draft, setDraft) => (
        <div className="flex flex-col gap-1">
          <Textarea
            className="min-h-20 text-sm"
            onChange={(event) => setDraft({ text: event.target.value })}
            placeholder="Not written yet"
            value={draft.text}
          />
          <div className="flex justify-end">
            <CharCount limit={X_POST_LIMIT} value={draft.text} />
          </div>
        </div>
      )}
    </FormatCard>
  );
}

function XThreadCard(props: CardProps<XThread>) {
  return (
    <FormatCard
      {...props}
      description="One finding per post, in order."
      isEmpty={(value) => !value.posts.some((post) => post.trim())}
      title="X thread"
      toCopy={(value) =>
        value.posts
          .map((post) => post.trim())
          .filter(Boolean)
          .join("\n\n")
      }
    >
      {(draft, setDraft) => (
        <div className="flex flex-col gap-2">
          {draft.posts.map((post, index) => (
            <div className="flex items-start gap-2" key={index}>
              <span className="w-5 shrink-0 pt-2 text-right text-muted-foreground text-xs tabular-nums">
                {index + 1}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Textarea
                  className="min-h-16 text-sm"
                  onChange={(event) => {
                    const text = event.target.value;
                    setDraft((prev) => ({
                      posts: prev.posts.map((entry, i) =>
                        i === index ? text : entry,
                      ),
                    }));
                  }}
                  value={post}
                />
                <div className="flex justify-end">
                  <CharCount limit={X_POST_LIMIT} value={post} />
                </div>
              </div>
              <Button
                aria-label={`Remove post ${index + 1}`}
                className="mt-1 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() =>
                  setDraft((prev) => ({
                    posts: prev.posts.filter((_, i) => i !== index),
                  }))
                }
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <X className="size-3" />
              </Button>
            </div>
          ))}
          <div>
            <Button
              onClick={() =>
                setDraft((prev) => ({ posts: [...prev.posts, ""] }))
              }
              size="xs"
              type="button"
              variant="ghost"
            >
              <Plus className="size-3" />
              Add post
            </Button>
          </div>
        </div>
      )}
    </FormatCard>
  );
}

function CnPostCard(props: CardProps<CnPost>) {
  return (
    <FormatCard
      {...props}
      description="A short post in Chinese, with a title."
      isEmpty={(value) => !(value.title.trim() || value.text.trim())}
      title="Chinese post"
      toCopy={(value) =>
        [value.title.trim(), value.text.trim()].filter(Boolean).join("\n\n")
      }
    >
      {(draft, setDraft) => (
        <div className="flex flex-col gap-2">
          <Input
            aria-label="Title"
            className="h-8 text-sm"
            onChange={(event) =>
              setDraft((prev) => ({ ...prev, title: event.target.value }))
            }
            placeholder="Title"
            value={draft.title}
          />
          <Textarea
            className="min-h-24 text-sm"
            onChange={(event) =>
              setDraft((prev) => ({ ...prev, text: event.target.value }))
            }
            placeholder="Not written yet"
            value={draft.text}
          />
        </div>
      )}
    </FormatCard>
  );
}

function VideoScriptCard(props: CardProps<VideoScript>) {
  return (
    <FormatCard
      {...props}
      description="Outline and script for a short video, plus the charts and clips to show."
      isEmpty={(value) => !(value.script.trim() || value.outline.length > 0)}
      title="Video script"
      toCopy={(value) =>
        [
          value.title.trim(),
          value.outline.length > 0
            ? `Outline\n${value.outline.map((item) => `- ${item}`).join("\n")}`
            : "",
          value.script.trim() ? `Script\n${value.script.trim()}` : "",
          value.assets.length > 0
            ? `Assets\n${value.assets.map((item) => `- ${item}`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n")
      }
    >
      {(draft, setDraft) => (
        <div className="flex flex-col gap-2">
          <Input
            aria-label="Title"
            className="h-8 text-sm"
            onChange={(event) =>
              setDraft((prev) => ({ ...prev, title: event.target.value }))
            }
            placeholder="Title"
            value={draft.title}
          />
          <LinesField
            label="Outline, one beat per line"
            onChange={(outline) => setDraft((prev) => ({ ...prev, outline }))}
            value={draft.outline}
          />
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">Script</span>
            <Textarea
              className="min-h-32 text-sm"
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, script: event.target.value }))
              }
              value={draft.script}
            />
          </div>
          <LinesField
            label="Assets, one per line"
            onChange={(assets) => setDraft((prev) => ({ ...prev, assets }))}
            value={draft.assets}
          />
        </div>
      )}
    </FormatCard>
  );
}

function LinesField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <Textarea
        className="min-h-16 text-sm"
        onChange={(event) => onChange(event.target.value.split("\n"))}
        onBlur={(event) => onChange(lines(event.target.value))}
        value={value.join("\n")}
      />
    </div>
  );
}
