import { Rows3 } from "lucide-react";
import { useMemo, useState } from "react";

import type { ListViewSpec } from "@/lib/dashboardSchema";

import { EmptyState } from "@/components/ui/empty-state";
import { formatSmartDate, looksLikeDateColumn } from "./format";
import { RowDetailDialog } from "./RowDetailDialog";

interface ListViewProps {
  view: ListViewSpec;
  columns: string[];
  rows: unknown[][];
  emptyState?: string;
}

// Denser than table — no header row, primary + secondary + meta lines.
// Notion-list / Linear-issue-list style.
export function ListView({ view, columns, rows, emptyState }: ListViewProps) {
  const primaryIdx = columns.indexOf(view.primary);
  const secondaryIdx = view.secondary ? columns.indexOf(view.secondary) : -1;
  const metaIdx = view.meta ? columns.indexOf(view.meta) : -1;
  const metaIsDate = looksLikeDateColumn(view.meta);
  const [shownLimit, setShownLimit] = useState(500);
  const [selectedRow, setSelectedRow] = useState<Record<string, unknown> | null>(
    null,
  );

  const detailColumns = useMemo(
    () => columns.map((name) => ({ name })),
    [columns],
  );

  if (primaryIdx < 0) {
    return (
      <div className="py-10 text-center text-xs text-destructive">
        list view: column "{view.primary}" not in projection.
      </div>
    );
  }
  if (rows.length === 0) {
    return <EmptyState icon={Rows3} title={emptyState ?? "Nothing here yet."} />;
  }

  const display = rows.slice(0, shownLimit);

  return (
    <ul className="divide-y divide-border/40 pt-1">
      {display.map((row, idx) => {
        const primary = String(row[primaryIdx] ?? "");
        const secondary = secondaryIdx >= 0 ? String(row[secondaryIdx] ?? "") : "";
        const metaSmart =
          metaIdx >= 0 && metaIsDate ? formatSmartDate(row[metaIdx]) : null;
        const metaText =
          metaSmart?.text ??
          (metaIdx >= 0 ? String(row[metaIdx] ?? "") : "");
        const metaTitle = metaSmart?.full;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: SQL row order is the natural key
          <li
            key={idx}
            onClick={() => {
              const obj: Record<string, unknown> = {};
              for (let i = 0; i < columns.length; i += 1) {
                obj[columns[i]] = row[i];
              }
              setSelectedRow(obj);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                const obj: Record<string, unknown> = {};
                for (let i = 0; i < columns.length; i += 1) {
                  obj[columns[i]] = row[i];
                }
                setSelectedRow(obj);
              }
            }}
            role="button"
            tabIndex={0}
            className="group flex cursor-pointer items-baseline gap-3 px-1 py-2.5 transition-colors hover:bg-fg-4 focus-visible:bg-fg-4 focus-visible:outline-none"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium leading-snug text-foreground">
                {primary || <span className="text-muted-foreground">(untitled)</span>}
              </div>
              {secondary ? (
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {secondary}
                </div>
              ) : null}
            </div>
            {metaText ? (
              <div
                className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
                title={metaTitle}
              >
                {metaText}
              </div>
            ) : null}
          </li>
        );
      })}
      {rows.length > display.length ? (
        <li className="flex items-center gap-3 pt-3 text-xs text-muted-foreground">
          <span>
            Showing {display.length} of {rows.length}.
          </span>
          <button
            type="button"
            onClick={() => setShownLimit((n) => n + 500)}
            className="rounded-md border border-border px-2 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
          >
            Show {Math.min(500, rows.length - display.length)} more
          </button>
        </li>
      ) : null}
      <RowDetailDialog
        open={selectedRow !== null}
        onOpenChange={(next) => {
          if (!next) setSelectedRow(null);
        }}
        title={
          selectedRow ? String(selectedRow[view.primary] ?? "Details") : "Details"
        }
        subtitle={
          selectedRow && view.secondary
            ? String(selectedRow[view.secondary] ?? "")
            : undefined
        }
        columns={detailColumns}
        row={selectedRow ?? {}}
      />
    </ul>
  );
}
