import { useCallback, useEffect, useMemo, useState } from "react";
import { OutputArtifactIcon } from "@/components/panes/ChatPane/ArtifactBrowserModal";
import { cn } from "@/lib/utils";
import { useOpenWorkspaceOutput } from "./useOpenWorkspaceOutput";

const POLL_INTERVAL_MS = 15_000;

interface ActivityDay {
  date: string;
  data: WorkspaceActivityResponsePayload | null;
  loading: boolean;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayDate(): string {
  return formatLocalDate(new Date());
}

function yesterdayDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return formatLocalDate(d);
}

function relativeTimeShort(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "";
  const diffMs = Date.now() - parsed;
  if (diffMs < 0) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function useActivityForDate(
  workspaceId: string,
  date: string,
): ActivityDay {
  const [data, setData] = useState<WorkspaceActivityResponsePayload | null>(
    null,
  );
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    if (!workspaceId) {
      setData(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const response = await window.electronAPI.workspace.listActivity({
          workspaceId,
          date,
        });
        if (!cancelled) {
          setData(response);
        }
      } catch {
        // tolerate transient runtime errors — keep last known data
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    void load();
    const timer = window.setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [workspaceId, date]);

  return { date, data, loading };
}

interface ProducerGroup {
  producer: WorkspaceActivityProducerPayload;
  outputs: WorkspaceOutputRecordPayload[];
}

function producerKeyForOutput(output: WorkspaceOutputRecordPayload): string {
  const metadata = (output.metadata ?? {}) as Record<string, unknown>;
  const rawTeammate = metadata.produced_by_teammate_id;
  const teammateId =
    typeof rawTeammate === "string" && rawTeammate.trim()
      ? rawTeammate.trim()
      : null;
  if (teammateId) return `teammate:${teammateId}`;
  const rawPlugin = metadata.produced_by_plugin_id;
  const metadataPluginId =
    typeof rawPlugin === "string" && rawPlugin.trim()
      ? rawPlugin.trim()
      : null;
  const moduleId = (output.module_id ?? "").trim();
  const pluginId = metadataPluginId ?? (moduleId || null);
  if (pluginId) return `plugin:${pluginId}`;
  return "unknown:unknown";
}

function groupOutputsByProducer(
  data: WorkspaceActivityResponsePayload,
): ProducerGroup[] {
  const groups = new Map<string, ProducerGroup>();
  for (const producer of data.by_producer) {
    const key = `${producer.producer_kind}:${producer.producer_id}`;
    groups.set(key, { producer, outputs: [] });
  }
  for (const output of data.outputs) {
    const key = producerKeyForOutput(output);
    const group = groups.get(key);
    if (group) {
      group.outputs.push(output);
    }
  }
  return data.by_producer.map((producer) => {
    const key = `${producer.producer_kind}:${producer.producer_id}`;
    return groups.get(key) ?? { producer, outputs: [] };
  });
}

export function ActivityPane({ workspaceId }: { workspaceId: string }) {
  const today = useMemo(() => todayDate(), []);
  const yesterday = useMemo(() => yesterdayDate(), []);
  const todayState = useActivityForDate(workspaceId, today);
  const yesterdayState = useActivityForDate(workspaceId, yesterday);
  const { openOutput } = useOpenWorkspaceOutput();

  const handleOpenOutput = useCallback(
    (output: WorkspaceOutputRecordPayload) => {
      void openOutput(output);
    },
    [openOutput],
  );

  const hasTodayItems = (todayState.data?.total ?? 0) > 0;
  const hasYesterdayItems = (yesterdayState.data?.total ?? 0) > 0;
  const stillLoading = todayState.loading || yesterdayState.loading;
  const showEmpty =
    !stillLoading && !hasTodayItems && !hasYesterdayItems;

  return (
    <div className="flex h-full min-h-0 w-full justify-center overflow-auto">
      <div className="flex w-full max-w-2xl flex-col gap-10 px-8 pt-[10vh] pb-16">
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase text-foreground/40">
            Team activity
          </div>
          <div className="truncate text-xl font-medium text-foreground">
            Daily output
          </div>
        </div>

        {showEmpty ? (
          <EmptyState />
        ) : (
          <div className="space-y-10">
            <ActivityBand
              title="Today"
              state={todayState}
              emptyMessage="Your team is getting its first output ready…"
              onOpenOutput={handleOpenOutput}
            />
            {hasYesterdayItems ? (
              <ActivityBand
                title="Yesterday"
                state={yesterdayState}
                onOpenOutput={handleOpenOutput}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-border/60 bg-background px-5 py-8 text-center">
      <div className="text-sm text-foreground/55">
        Your team is getting its first output ready…
      </div>
    </div>
  );
}

function ActivityBand({
  title,
  state,
  emptyMessage,
  onOpenOutput,
}: {
  title: string;
  state: ActivityDay;
  emptyMessage?: string;
  onOpenOutput: (output: WorkspaceOutputRecordPayload) => void;
}) {
  const groups = useMemo(() => {
    if (!state.data) return [];
    return groupOutputsByProducer(state.data);
  }, [state.data]);

  return (
    <section className="space-y-3">
      <BandHeader title={title} total={state.data?.total ?? 0} />
      {state.data && state.data.total === 0 ? (
        emptyMessage ? (
          <div className="rounded-md border border-border/50 bg-background px-3 py-4 text-[12px] text-foreground/55">
            {emptyMessage}
          </div>
        ) : null
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <ProducerGroupBlock
              key={`${group.producer.producer_kind}:${group.producer.producer_id}`}
              group={group}
              onOpenOutput={onOpenOutput}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function BandHeader({ title, total }: { title: string; total: number }) {
  return (
    <div className="flex items-baseline gap-2">
      <h2 className="text-base font-medium text-foreground">{title}</h2>
      {total > 0 ? (
        <span className="text-[11px] text-foreground/40">
          {total} {total === 1 ? "output" : "outputs"}
        </span>
      ) : null}
    </div>
  );
}

function ProducerGroupBlock({
  group,
  onOpenOutput,
}: {
  group: ProducerGroup;
  onOpenOutput: (output: WorkspaceOutputRecordPayload) => void;
}) {
  if (group.outputs.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 px-1">
        <span className="text-[13px] font-medium text-foreground/85">
          {group.producer.producer_name}
        </span>
        <span className="text-[11px] text-foreground/45">
          · {group.producer.count}{" "}
          {group.producer.count === 1 ? "output" : "outputs"}
        </span>
      </div>
      <div className="flex flex-col">
        {group.outputs.map((output) => (
          <OutputRow
            key={output.id}
            output={output}
            onClick={() => onOpenOutput(output)}
          />
        ))}
      </div>
    </div>
  );
}

function OutputRow({
  output,
  onClick,
}: {
  output: WorkspaceOutputRecordPayload;
  onClick: () => void;
}) {
  const title = output.title?.trim() || untitledLabel(output);
  const relative = relativeTimeShort(output.created_at);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm",
        "transition-colors duration-snappy ease-out-expo hover:bg-foreground/[0.04]",
      )}
    >
      <OutputArtifactIcon output={output} size="sm" variant="bare" />
      <span className="min-w-0 flex-1 truncate text-foreground/85">
        {title}
      </span>
      {relative ? (
        <span className="shrink-0 text-[11px] text-foreground/40">
          {relative}
        </span>
      ) : null}
    </button>
  );
}

function untitledLabel(output: WorkspaceOutputRecordPayload): string {
  if (output.file_path) {
    const segments = output.file_path.split(/[\\/]/);
    const last = segments[segments.length - 1];
    if (last) return last;
  }
  return "Untitled output";
}
