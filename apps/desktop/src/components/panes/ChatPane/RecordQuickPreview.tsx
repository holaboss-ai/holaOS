import { useEffect, useState } from "react";

import { CalendarClock, Loader2, X, type IconType } from "@/components/ui/icons";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { remoteApi } from "@/lib/remoteApiClient";

export type RecordQuickPreviewTarget =
  { kind: "cronjob"; id: string; fallbackLabel: string };

interface RecordQuickPreviewProps {
  workspaceId: string;
  target: RecordQuickPreviewTarget;
  onClose: () => void;
}

const KIND_META: Record<
  RecordQuickPreviewTarget["kind"],
  { label: string; icon: IconType }
> = {
  cronjob: { label: "Cronjob", icon: CalendarClock },
};

interface FetchState {
  cronjob: CronjobRecordPayload | null;
}

export function RecordQuickPreview({
  workspaceId,
  target,
  onClose,
}: RecordQuickPreviewProps) {
  const [state, setState] = useState<FetchState>({
    cronjob: null,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setState({ cronjob: null });

    async function load() {
      try {
        const cronRes = await remoteApi.cronjobs.list({});
        if (cancelled) return;
        const cronjob = cronRes.jobs.find((job) => job.id === target.id) ?? null;
        setState({ cronjob });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, target.kind, target.id]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const meta = KIND_META[target.kind];
  const Icon = meta.icon;
  const headerTitle = state.cronjob?.name ?? target.fallbackLabel;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-scrim px-6 py-10 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={cn(
          "flex max-h-[82vh] w-full max-w-[680px] flex-col overflow-hidden",
          "rounded-2xl border border-border bg-background shadow-2xl",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-border bg-fg-4 px-5 py-3">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {meta.label}
            </div>
            <div className="mt-0.5 truncate text-sm font-medium text-foreground">
              {headerTitle}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close preview"
          >
            <X className="size-4" />
          </Button>
        </header>

        <div className="flex-1 overflow-auto bg-background">
          {isLoading ? (
            <div className="flex h-full min-h-[200px] items-center justify-center text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : error ? (
            <div className="flex h-full min-h-[200px] items-center justify-center px-6 text-sm text-destructive">
              {error}
            </div>
          ) : (
            <CronjobBody
              record={state.cronjob}
              fallbackId={target.id}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function CronjobBody({
  record,
  fallbackId,
}: {
  record: CronjobRecordPayload | null;
  fallbackId: string;
}) {
  if (!record) {
    return (
      <NotFound
        title="Cronjob not in the workspace yet"
        body={`No cronjob with id "${fallbackId}" was found. Building Agent may not have created it yet.`}
      />
    );
  }
  return (
    <div className="flex flex-col gap-5 px-5 py-5">
      <MetaRow
        label="Schedule"
        value={<code className="font-mono text-sm">{record.cron}</code>}
      />
      <MetaRow
        label="Enabled"
        value={record.enabled ? "Yes" : "No (provisioned but paused)"}
      />
      {record.description ? (
        <BodyBlock label="Description" text={record.description} />
      ) : null}
      <BodyBlock
        label="Instruction"
        empty="No instruction body."
        text={record.instruction}
      />
    </div>
  );
}

function MetaRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <div className="w-24 shrink-0 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="min-w-0 flex-1 text-sm text-foreground">{value}</div>
    </div>
  );
}

function BodyBlock({
  label,
  text,
  empty,
}: {
  label: string;
  text: string | null | undefined;
  empty?: string;
}) {
  const trimmed = (text ?? "").trim();
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {trimmed ? (
        <pre className="m-0 whitespace-pre-wrap break-words rounded-lg border border-border bg-fg-4 px-3 py-2.5 font-mono text-[12.5px] leading-6 text-fg-92">
          {trimmed}
        </pre>
      ) : (
        <div className="text-xs italic text-muted-foreground">
          {empty ?? "—"}
        </div>
      )}
    </div>
  );
}

function NotFound({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-1.5 px-8 text-center">
      <div className="text-sm font-medium text-foreground">{title}</div>
      <div className="text-xs text-muted-foreground">{body}</div>
    </div>
  );
}
