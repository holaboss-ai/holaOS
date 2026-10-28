import type { BenchRunSummary } from "@holaboss/remote-api/contract";
import { toast } from "sonner";
import { busyReading, formatTps, machineSummary } from "@/components/bench/record";
import { errorMessage, relativeTime } from "./format";
import { StatusPill } from "./parts";

/** Finished one-click benchmarks; a row reopens the bench window on that run. */
export function BenchmarkRunList({ runs }: { runs: BenchRunSummary[] }) {
  const open = (run: BenchRunSummary) => {
    void window.electronAPI.bench
      .open(run.subject_id, run.run_id)
      .catch((cause: unknown) => toast.error(errorMessage(cause, "Couldn't open the benchmark.")));
  };
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {runs.map((run) => {
        const busy = busyReading(run) !== null;
        return (
          <li className="group relative transition-colors hover:bg-fg-2" key={run.run_id}>
            <button
              aria-label={`Open the ${run.subject_name} benchmark`}
              className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              onClick={() => open(run)}
              type="button"
            />
            <div className="pointer-events-none flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium text-foreground text-sm">{run.subject_name}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{run.quant}</span>
                  {busy ? <StatusPill tone="warning">Busy machine</StatusPill> : null}
                </div>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {machineSummary(run.hardware)} · {relativeTime(run.started_at)}
                </p>
              </div>
              <span className="shrink-0 font-semibold text-foreground text-sm tabular-nums">
                {run.decode_tps === null ? "–" : formatTps(run.decode_tps)}
                <span className="ml-1 font-normal text-muted-foreground text-xs">tok/s</span>
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
