import type { EvalReport } from "@holaboss/remote-api/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useShareToHolahub } from "@/components/layout/shell/useShareToHolahub";
import { SimpleMarkdown } from "@/components/marketplace/SimpleMarkdown";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  AlertTriangle,
  Download,
  ExternalLink,
  FolderOpen,
  GitBranch,
  Loader2,
  Lock,
  Save,
  Search,
  Send,
} from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { remoteApiQuery } from "@/lib/remoteApiQuery";
import { cn } from "@/lib/utils";
import { useInvalidateEvaluation } from "./data";
import { useServerDraft } from "./draft";
import {
  type EvaluationDetail,
  type EvaluationRecord,
  errorMessage,
  formatScalar,
  relativeTime,
} from "./format";
import { Callout, Panel, SegmentedControl } from "./parts";
import { useOpenEvaluation } from "./useOpenEvaluation";

const PLACEHOLDER_FILTER_THRESHOLD = 10;

function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

function asPlaceholderToken(value: string): string {
  const inner = value.trim().replace(/^\{\{\s*|\s*\}\}$/g, "");
  return `{{${inner}}}`;
}

function openExternal(url: string) {
  void window.electronAPI?.ui?.openExternalUrl(url);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function ReportSection({ detail }: { detail: EvaluationDetail }) {
  const evaluation = detail.evaluation;
  const evalId = evaluation.eval_id;
  const reportQuery = useQuery(
    remoteApiQuery.evals.report.queryOptions({
      input: { evalId },
      staleTime: 0,
    }),
  );
  const report = reportQuery.data ?? null;

  return (
    <div className="flex flex-col gap-4">
      {report?.frozen ? <FrozenCallout evaluation={evaluation} /> : null}
      <DataPanel
        error={reportQuery.isError ? errorMessage(reportQuery.error) : null}
        frozen={Boolean(report?.frozen)}
        loading={reportQuery.isPending}
        report={report}
      />
      <OpinionPanel evaluation={evaluation} report={report} />
      <PublishPanel evaluation={evaluation} frozen={Boolean(report?.frozen)} />
    </div>
  );
}

function FrozenCallout({ evaluation }: { evaluation: EvaluationRecord }) {
  const queryClient = useQueryClient();
  const openEvaluation = useOpenEvaluation();
  const versionMutation = useMutation(
    remoteApiQuery.evals.createVersion.mutationOptions({
      onSuccess: async (created) => {
        await queryClient.invalidateQueries({
          queryKey: remoteApiQuery.evals.list.key(),
        });
        openEvaluation(created);
      },
      onError: (cause) =>
        toast.error(errorMessage(cause, "Couldn't create a new version.")),
    }),
  );
  const published = evaluation.published_at
    ? new Date(evaluation.published_at).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <Callout
      action={
        <Button
          disabled={versionMutation.isPending}
          onClick={() =>
            versionMutation.mutate({ evalId: evaluation.eval_id })
          }
          size="sm"
          type="button"
          variant="outline"
        >
          {versionMutation.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <GitBranch className="size-3.5" />
          )}
          Re-run as new version
        </Button>
      }
      icon={<Lock />}
    >
      {published ? `Published ${published}. ` : ""}The data in this version is
      locked. To test again with a changed plan, start a new version; this one
      stays as published.
    </Callout>
  );
}

function DataPanel({
  report,
  loading,
  error,
  frozen,
}: {
  report: EvalReport | null;
  loading: boolean;
  error: string | null;
  frozen: boolean;
}) {
  const charts = report?.charts ?? [];
  const markdown = report?.markdown.trim() ?? "";
  const empty = !loading && !error && charts.length === 0 && !markdown;

  return (
    <Panel
      actions={
        frozen ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
            <Lock className="size-3" />
            Locked
          </span>
        ) : null
      }
      description="Built from the runs. Numbers here can't be edited by hand."
      title="Data"
    >
      {loading ? (
        <div className="flex flex-col gap-2">
          <div className="h-40 animate-pulse rounded-lg bg-fg-6" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-fg-6" />
        </div>
      ) : error ? (
        <p className="text-destructive text-sm">{error}</p>
      ) : empty ? (
        <p className="text-muted-foreground text-sm">
          No results yet. This fills in as runs finish.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {charts.length > 0 ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {charts.map((chart) => (
                <img
                  alt={chart.title}
                  className="w-full rounded-lg border border-border"
                  key={chart.id}
                  src={svgDataUrl(chart.svg)}
                />
              ))}
            </div>
          ) : null}
          {markdown ? (
            <div className="overflow-x-auto text-sm [&_table]:text-xs [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
              <SimpleMarkdown className="chat-markdown">{markdown}</SimpleMarkdown>
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

function OpinionPanel({
  evaluation,
  report,
}: {
  evaluation: EvaluationRecord;
  report: EvalReport | null;
}) {
  const evalId = evaluation.eval_id;
  const invalidate = useInvalidateEvaluation(evalId);
  const { draft, setDraft, dirty, discard, markSaved, changedWhileEditing } =
    useServerDraft<string>(evaluation.opinion_md);
  const [mode, setMode] = useState<"write" | "preview">("write");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const saveMutation = useMutation(
    remoteApiQuery.evals.saveOpinion.mutationOptions(),
  );

  const save = async () => {
    try {
      const updated = await saveMutation.mutateAsync({
        evalId,
        opinionMd: draft,
      });
      markSaved(updated.opinion_md);
      await invalidate({ evaluation: updated });
    } catch (cause) {
      toast.error(errorMessage(cause, "Couldn't save your write-up."));
    }
  };

  const insertPlaceholder = (key: string) => {
    const token = asPlaceholderToken(key);
    const element = textareaRef.current;
    if (mode !== "write" || !element) {
      void navigator.clipboard
        .writeText(token)
        .then(() => toast.success(`Copied ${token}`))
        .catch(() => undefined);
      return;
    }
    const start = element.selectionStart ?? draft.length;
    const end = element.selectionEnd ?? start;
    const next = `${draft.slice(0, start)}${token}${draft.slice(end)}`;
    setDraft(next);
    window.requestAnimationFrame(() => {
      element.focus();
      const caret = start + token.length;
      element.setSelectionRange(caret, caret);
    });
  };

  const unresolved = report?.unresolved_placeholders ?? [];
  const unverified = report?.unverified_numbers ?? [];
  const savedAt = evaluation.opinion_updated_at
    ? relativeTime(evaluation.opinion_updated_at)
    : "";

  return (
    <Panel
      actions={
        <SegmentedControl
          onChange={setMode}
          options={[
            { value: "write", label: "Write" },
            { value: "preview", label: "Preview" },
          ]}
          size="sm"
          value={mode}
        />
      }
      description="What you make of the results. Cite numbers with placeholders so they match the data."
      title="Write-up"
    >
      <div className="flex flex-col gap-3">
        {changedWhileEditing ? (
          <Callout
            action={
              <Button onClick={discard} size="sm" type="button" variant="ghost">
                Discard my edits
              </Button>
            }
            tone="warning"
          >
            The agent changed the write-up while you were editing it.
          </Callout>
        ) : null}

        {mode === "write" ? (
          <textarea
            aria-label="Write-up"
            className="min-h-64 w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2.5 text-foreground text-sm leading-6 outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring dark:bg-input/30"
            maxLength={60_000}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="The agent drafts this once results are in. Write what you'd tell another developer: what surprised you, what you'd use it for, where it falls short."
            ref={textareaRef}
            value={draft}
          />
        ) : report?.opinion_rendered_md.trim() ? (
          <div className="rounded-lg border border-border px-4 py-3">
            {dirty ? (
              <p className="mb-2 text-[11px] text-muted-foreground">
                Showing your last saved text.
              </p>
            ) : null}
            <SimpleMarkdown className="chat-markdown">
              {report.opinion_rendered_md}
            </SimpleMarkdown>
          </div>
        ) : (
          <p className="rounded-lg border border-border px-4 py-6 text-center text-muted-foreground text-sm">
            Nothing saved yet.
          </p>
        )}

        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {dirty ? "Unsaved changes" : savedAt ? `Saved ${savedAt}` : ""}
          </span>
          <div className="flex-1" />
          {dirty ? (
            <Button
              disabled={saveMutation.isPending}
              onClick={discard}
              size="sm"
              type="button"
              variant="ghost"
            >
              Discard
            </Button>
          ) : null}
          <Button
            disabled={!dirty || saveMutation.isPending}
            onClick={() => void save()}
            size="sm"
            type="button"
            variant="outline"
          >
            {saveMutation.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Save className="size-3.5" />
            )}
            Save
          </Button>
        </div>

        {unresolved.length > 0 ? (
          <Callout icon={<AlertTriangle />} tone="warning">
            {unresolved.length === 1
              ? "This placeholder doesn't match any number in the data: "
              : "These placeholders don't match any number in the data: "}
            <span className="font-mono">
              {unresolved.map(asPlaceholderToken).join(", ")}
            </span>
            {dirty ? " (checked against your last save)" : ""}
          </Callout>
        ) : null}
        {unverified.length > 0 ? (
          <Callout icon={<AlertTriangle />} tone="warning">
            {unverified.length === 1
              ? "This number in your text isn't linked to the data: "
              : "These numbers in your text aren't linked to the data: "}
            <span className="font-mono">{unverified.join(", ")}</span>. Cite
            measured numbers from the list below so they can't drift from the
            results.
            {dirty ? " (Checked against your last save.)" : ""}
          </Callout>
        ) : null}

        <PlaceholderList
          onPick={insertPlaceholder}
          placeholders={report?.placeholders ?? []}
          writing={mode === "write"}
        />
      </div>
    </Panel>
  );
}

function PlaceholderList({
  placeholders,
  writing,
  onPick,
}: {
  placeholders: EvalReport["placeholders"];
  writing: boolean;
  onPick: (key: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) {
      return placeholders;
    }
    return placeholders.filter(
      (entry) =>
        entry.key.toLowerCase().includes(query) ||
        entry.label.toLowerCase().includes(query),
    );
  }, [filter, placeholders]);

  if (placeholders.length === 0) {
    return null;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center gap-2 border-border border-b bg-fg-2 px-3 py-1.5">
        <span className="flex-1 font-medium text-[11px] text-muted-foreground">
          {writing
            ? "Numbers you can cite. Click one to insert it at the cursor."
            : "Numbers you can cite. Click one to copy its placeholder."}
        </span>
        {placeholders.length > PLACEHOLDER_FILTER_THRESHOLD ? (
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-1.5 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Filter numbers"
              className="h-6 w-36 pl-5 text-xs"
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter"
              value={filter}
            />
          </div>
        ) : null}
      </div>
      <ul className="max-h-56 divide-y divide-border overflow-y-auto">
        {visible.map((entry) => (
          <li key={entry.key}>
            <button
              className="flex w-full items-center gap-3 px-3 py-1.5 text-left transition-colors hover:bg-fg-2"
              onClick={() => onPick(entry.key)}
              type="button"
            >
              <span className="min-w-0 flex-1 truncate text-foreground text-xs">
                {entry.label}
              </span>
              <span className="shrink-0 text-foreground text-xs tabular-nums">
                {formatScalar(entry.value)}
              </span>
              <span className="w-56 shrink-0 truncate text-right font-mono text-[11px] text-muted-foreground">
                {asPlaceholderToken(entry.key)}
              </span>
            </button>
          </li>
        ))}
        {visible.length === 0 ? (
          <li className="px-3 py-2 text-muted-foreground text-xs">
            Nothing matches.
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function PublishPanel({
  evaluation,
  frozen,
}: {
  evaluation: EvaluationRecord;
  frozen: boolean;
}) {
  const evalId = evaluation.eval_id;
  const invalidate = useInvalidateEvaluation(evalId);
  const shareToHolahub = useShareToHolahub();
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [exported, setExported] = useState<{ dir: string; files: string[] } | null>(
    null,
  );
  const published = evaluation.status === "published" || frozen;

  const updateMutation = useMutation(
    remoteApiQuery.evals.update.mutationOptions({
      onSuccess: (updated) => invalidate({ evaluation: updated }),
      onError: (cause) =>
        toast.error(errorMessage(cause, "Couldn't update the setting.")),
    }),
  );
  const exportMutation = useMutation(
    remoteApiQuery.evals.exportReport.mutationOptions({
      onSuccess: (result) => setExported(result),
      onError: (cause) =>
        toast.error(errorMessage(cause, "Couldn't export the report.")),
    }),
  );
  const publishMutation = useMutation(
    remoteApiQuery.evals.publish.mutationOptions({
      onSuccess: async (draft) => {
        await invalidate({ evaluation: draft.evaluation });
        await shareToHolahub({
          title: draft.title,
          body: draft.body,
          form: "output",
          images: draft.images.map((image) => ({
            dataBase64: image.data_base64,
            contentType: image.content_type,
          })),
          files: draft.files.map((file) => ({
            fileName: file.file_name,
            contentType: file.content_type,
            dataBase64: file.data_base64,
          })),
        });
      },
      onError: (cause) =>
        toast.error(errorMessage(cause, "Couldn't publish the report.")),
    }),
  );

  const revealExport = () => {
    if (!exported) {
      return;
    }
    const first = exported.files[0];
    const target = first
      ? /^(?:[a-zA-Z]:[\\/]|\/)/.test(first)
        ? first
        : `${exported.dir.replace(/[\\/]+$/, "")}/${first}`
      : exported.dir;
    void window.electronAPI?.fs
      ?.revealInFolder(target)
      .catch((cause: unknown) =>
        toast.error(errorMessage(cause, "Couldn't open the folder.")),
      );
  };

  return (
    <Panel
      description="Export the files, or publish to HolaHub under your name."
      title="Publish"
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <Switch
            aria-label="Include raw data"
            checked={evaluation.include_raw_data}
            disabled={updateMutation.isPending}
            onCheckedChange={(checked) =>
              updateMutation.mutate({ evalId, includeRawData: checked })
            }
          />
          <span className="flex flex-col">
            <span className="font-medium text-foreground text-sm">
              Include raw data
            </span>
            <span className="text-muted-foreground text-xs">
              Puts every task's raw output in report.html so others can check your numbers.
            </span>
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={exportMutation.isPending}
            onClick={() => exportMutation.mutate({ evalId })}
            size="sm"
            type="button"
            variant="outline"
          >
            {exportMutation.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
            Export files
          </Button>
          <Button
            disabled={publishMutation.isPending}
            onClick={() =>
              published ? publishMutation.mutate({ evalId }) : setConfirmPublish(true)
            }
            size="sm"
            type="button"
          >
            {publishMutation.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Send className="size-3.5" />
            )}
            {published ? "Share to HolaHub again" : "Publish to HolaHub"}
          </Button>
        </div>

        {exported ? (
          <div className="flex items-start gap-2 rounded-lg border border-border bg-fg-2 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[11px] text-foreground" title={exported.dir}>
                {exported.dir}
              </p>
              {exported.files.length > 0 ? (
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {exported.files
                    .map((file) => file.split(/[\\/]/).pop() ?? file)
                    .join(", ")}
                </p>
              ) : null}
            </div>
            <Button onClick={revealExport} size="xs" type="button" variant="ghost">
              <FolderOpen className="size-3" />
              Show in folder
            </Button>
          </div>
        ) : null}

        <ReportUrlField evaluation={evaluation} />
      </div>

      <ConfirmDialog
        confirmLabel="Publish"
        description="The data in this version gets locked, and the HolaHub composer opens with the report attached. Nothing is posted until you press Post there."
        onConfirm={() => {
          setConfirmPublish(false);
          publishMutation.mutate({ evalId });
        }}
        onOpenChange={setConfirmPublish}
        open={confirmPublish}
        title="Publish this evaluation?"
      />
    </Panel>
  );
}

function ReportUrlField({ evaluation }: { evaluation: EvaluationRecord }) {
  const evalId = evaluation.eval_id;
  const invalidate = useInvalidateEvaluation(evalId);
  const saved = evaluation.report_url ?? "";
  const { draft, setDraft, dirty, markSaved } = useServerDraft<string>(saved);
  const trimmed = draft.trim();
  const valid = !trimmed || isHttpUrl(trimmed);
  const urlMutation = useMutation(
    remoteApiQuery.evals.setReportUrl.mutationOptions(),
  );

  const save = async () => {
    try {
      const updated = await urlMutation.mutateAsync({
        evalId,
        url: trimmed || null,
      });
      markSaved(updated.report_url ?? "");
      await invalidate({ evaluation: updated });
    } catch (cause) {
      toast.error(errorMessage(cause, "Couldn't save the link."));
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
        Post link
      </span>
      <div className="flex items-center gap-2">
        <Input
          aria-invalid={!valid}
          className="h-8 min-w-0 flex-1 text-sm"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && dirty && valid) {
              void save();
            }
          }}
          placeholder="https://"
          value={draft}
        />
        <Button
          disabled={!dirty || !valid || urlMutation.isPending}
          onClick={() => void save()}
          size="sm"
          type="button"
          variant="outline"
        >
          {urlMutation.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : null}
          Save
        </Button>
        {saved && !dirty ? (
          <Button
            aria-label="Open the post"
            onClick={() => openExternal(saved)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <ExternalLink className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <p className={cn("text-[11px] leading-4", valid ? "text-muted-foreground" : "text-destructive")}>
        {valid
          ? "After you post on HolaHub, paste the post's link here so this evaluation points to it."
          : "Enter a full link starting with https://"}
      </p>
    </div>
  );
}
