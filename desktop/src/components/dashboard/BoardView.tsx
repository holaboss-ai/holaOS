import { Check, ChevronDown, Columns3 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { BoardViewSpec, ColorToken } from "@/lib/dashboardSchema";

import { EmptyState } from "@/components/ui/empty-state";
import { colorClasses, formatSmartDate, hashToColor, looksLikeDateColumn } from "./format";
import { RowDetailDialog } from "./RowDetailDialog";
import { isStatusColumn, StatusBadge } from "./StatusBadge";
import { usePersistedState } from "./usePersistedState";

interface BoardViewProps {
  view: BoardViewSpec;
  columns: string[];
  rows: unknown[][];
  emptyState?: string;
  storageKeyBase?: string;
}

// Read-only Kanban: rows are bucketed by distinct values of the
// active group-by column. The YAML `group_by` is the *initial*
// choice — users can switch live via the "Group by" picker in the
// header (Notion-style). Selection is component-local; we don't
// persist back to YAML in v2 because the dashboard is a pure
// function of its file.
export function BoardView({
  view,
  columns,
  rows,
  emptyState,
  storageKeyBase,
}: BoardViewProps) {
  const [activeGroupBy, setActiveGroupBy] = usePersistedState<string>(
    storageKeyBase ? `${storageKeyBase}:board:groupBy` : undefined,
    view.group_by,
  );
  const initialGroupBy = view.group_by;

  // Reset when the YAML changes the initial group_by underneath us
  // (e.g. agent re-emits the dashboard) and the previously-selected
  // column has gone away. Effect rather than render-phase setState.
  useEffect(() => {
    if (activeGroupBy !== view.group_by && !columns.includes(activeGroupBy)) {
      setActiveGroupBy(view.group_by);
    }
  }, [view.group_by, columns, activeGroupBy]);

  const titleIdx = columns.indexOf(view.card_title);
  const subtitleIdx = view.card_subtitle ? columns.indexOf(view.card_subtitle) : -1;
  const metaIdx = view.card_meta ? columns.indexOf(view.card_meta) : -1;
  const groupIdx = columns.indexOf(activeGroupBy);

  const groupableColumns = useMemo(
    () => candidateGroupColumns(columns, view),
    [columns, view],
  );

  const [selectedRow, setSelectedRow] = useState<Record<string, unknown> | null>(
    null,
  );

  const detailColumns = useMemo(
    () => columns.map((name) => ({ name })),
    [columns],
  );

  if (titleIdx < 0) {
    return (
      <div className="py-4 text-xs text-destructive">
        Board: <code className="font-mono">card_title</code> column "{view.card_title}" not in query result.
      </div>
    );
  }
  if (groupIdx < 0) {
    return (
      <div className="py-4 text-xs text-destructive">
        Board: <code className="font-mono">group_by</code> column "{activeGroupBy}" not in query result.
      </div>
    );
  }

  // ---- Bucket rows by the active group-by column ------------------
  const groups = new Map<string, unknown[][]>();
  for (const row of rows) {
    const raw = row[groupIdx];
    const key = raw === null || raw === undefined ? "—" : String(raw);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  // Honor explicit `group_order` only when grouping by the originally-
  // declared column; switching to a different group_by makes the
  // pinned order irrelevant. Falls through to insertion order.
  let ordered: Array<[string, unknown[][]]>;
  if (
    activeGroupBy === view.group_by &&
    view.group_order &&
    view.group_order.length > 0
  ) {
    const seen = new Set<string>();
    ordered = [];
    for (const k of view.group_order) {
      if (groups.has(k)) {
        ordered.push([k, groups.get(k)!]);
        seen.add(k);
      }
    }
    for (const [k, v] of groups.entries()) {
      if (!seen.has(k)) ordered.push([k, v]);
    }
  } else {
    ordered = Array.from(groups.entries());
  }

  // Picker pill: small chip in the body header, opens a Notion-style
  // dropdown of columns from the projection. Visible whether or not
  // there are rows so users can switch into a (now-empty) grouping.
  const picker = (
    <GroupByPicker
      active={activeGroupBy}
      candidates={groupableColumns}
      onChange={setActiveGroupBy}
      initial={initialGroupBy}
    />
  );

  if (ordered.length === 0) {
    return (
      <div className="pt-2">
        <div className="mb-2">{picker}</div>
        <EmptyState icon={Columns3} title={emptyState ?? "Nothing here yet."} />
      </div>
    );
  }

  // ---- Coloring rules ---------------------------------------------
  // When grouping by the originally-declared column, apply the
  // explicit `group_colors:` map if present. When the user switches
  // to a different column we fall through to hash-based coloring so
  // every grouping at least reads as a board.
  const onOriginal = activeGroupBy === view.group_by;
  const useExplicitColors =
    onOriginal && view.group_colors && Object.keys(view.group_colors).length > 0;
  const useLegacyStatus =
    !useExplicitColors && isStatusColumn(activeGroupBy);

  return (
    <div className="pt-2">
      <div className="mb-3">{picker}</div>
      <div className="flex gap-5 overflow-x-auto pb-1">
        {ordered.map(([groupValue, groupRows]) => (
          <div key={groupValue} className="flex w-60 shrink-0 flex-col">
            <div className="flex items-center gap-2 px-1 pb-2">
              {useLegacyStatus ? (
                <StatusBadge value={groupValue} />
              ) : (
                <ColumnHeader
                  value={groupValue}
                  explicit={(view.group_colors as Record<string, ColorToken> | undefined)?.[groupValue]}
                  useExplicit={Boolean(useExplicitColors)}
                />
              )}
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {groupRows.length}
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              {groupRows.slice(0, 200).map((row, rIdx) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: SQL row order is the natural key
                <article
                  key={rIdx}
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
                  className="cursor-pointer rounded-md border border-transparent bg-fg-4 px-3 py-2.5 text-xs transition-colors hover:border-border hover:bg-card focus-visible:border-border focus-visible:bg-card focus-visible:outline-none"
                >
                  <div className="line-clamp-3 leading-snug text-foreground">
                    {formatCell(row[titleIdx])}
                  </div>
                  {(subtitleIdx >= 0 || metaIdx >= 0) ? (
                    <div className="mt-1.5 flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
                      {subtitleIdx >= 0 ? (
                        <SmartDateOrText
                          column={view.card_subtitle}
                          value={row[subtitleIdx]}
                          className="min-w-0 truncate"
                        />
                      ) : (
                        <span />
                      )}
                      {metaIdx >= 0 ? (
                        <SmartDateOrText
                          column={view.card_meta}
                          value={row[metaIdx]}
                          className="shrink-0 tabular-nums"
                        />
                      ) : null}
                    </div>
                  ) : null}
                </article>
              ))}
              {groupRows.length > 200 ? (
                <div className="px-1 pt-1 text-[11px] text-muted-foreground">
                  +{groupRows.length - 200} more
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <RowDetailDialog
        open={selectedRow !== null}
        onOpenChange={(next) => {
          if (!next) setSelectedRow(null);
        }}
        title={
          selectedRow
            ? formatCell(selectedRow[view.card_title]) || "Details"
            : "Details"
        }
        subtitle={
          selectedRow && view.card_subtitle
            ? formatCell(selectedRow[view.card_subtitle])
            : undefined
        }
        columns={detailColumns}
        row={selectedRow ?? {}}
      />
    </div>
  );
}

// ----- Group-by picker ----------------------------------------------

interface GroupByPickerProps {
  active: string;
  candidates: string[];
  onChange: (column: string) => void;
  initial: string;
}

function GroupByPicker({
  active,
  candidates,
  onChange,
  initial,
}: GroupByPickerProps) {
  // Single-candidate boards (the only groupable column is the
  // already-active one) skip the dropdown entirely — the picker
  // would be useless decoration.
  if (candidates.length <= 1) {
    return (
      <div className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <span>Group by</span>
        <span className="rounded-md bg-muted px-1.5 py-0.5 font-medium text-foreground">
          {active}
        </span>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="group/picker inline-flex items-center gap-1 rounded-md border border-transparent px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-border hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:border-border data-[state=open]:bg-muted"
          >
            <span>Group by</span>
            <span className="font-medium text-foreground">{active}</span>
            <ChevronDown
              size={12}
              strokeWidth={2}
              className="opacity-60 transition-transform group-data-[state=open]/picker:rotate-180"
            />
          </button>
        }
      />
      <DropdownMenuContent align="start" sideOffset={4} className="min-w-[180px]">
        {candidates.map((col) => {
          const isActive = col === active;
          const isInitial = col === initial;
          return (
            <DropdownMenuItem
              key={col}
              onClick={() => onChange(col)}
              className="flex items-center justify-between gap-3"
            >
              <span className="flex-1 truncate text-sm">
                {col}
                {isInitial && col !== active ? (
                  <span className="ml-2 text-[10px] text-muted-foreground">default</span>
                ) : null}
              </span>
              {isActive ? (
                <Check size={13} strokeWidth={2} className="text-foreground" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Suggests a sensible candidate set for the group-by picker. Rules:
//   - the column originally declared in YAML is always present
//   - exclude title / subtitle / meta columns (they're the *content*,
//     grouping by them gives one card per column)
//   - exclude columns that look continuous: ending in _at / _id / _url,
//     or a literal "id" — grouping by these gives garbage
//   - everything else is fair game; the user can pick what they want
function candidateGroupColumns(
  columns: string[],
  view: BoardViewSpec,
): string[] {
  const exclude = new Set<string>();
  exclude.add(view.card_title);
  if (view.card_subtitle) exclude.add(view.card_subtitle);
  if (view.card_meta) exclude.add(view.card_meta);

  const continuous = (name: string) => {
    if (name === "id" || name.endsWith("_id")) return true;
    if (name.endsWith("_at") || name.endsWith("_time") || name.endsWith("_date")) return true;
    if (name.endsWith("_url")) return true;
    return false;
  };

  const out: string[] = [];
  // Always offer the YAML-declared group_by, even if it's continuous-
  // looking — the author put it there on purpose.
  if (columns.includes(view.group_by)) out.push(view.group_by);

  for (const col of columns) {
    if (col === view.group_by) continue;
    if (exclude.has(col)) continue;
    if (continuous(col)) continue;
    out.push(col);
  }
  return out;
}

function ColumnHeader({
  value,
  explicit,
  useExplicit,
}: {
  value: string;
  explicit: ColorToken | undefined;
  useExplicit: boolean;
}) {
  const token = useExplicit ? (explicit ?? "gray") : hashToColor(value);
  const cls = colorClasses(token);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium ${cls.badge}`}
    >
      <span aria-hidden className={`size-1.5 rounded-full ${cls.dot}`} />
      {value}
    </span>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

// Auto-format timestamp-looking columns into Notion's relative
// date scheme; otherwise just stringify. The full ISO is on the
// title attribute so users can hover for precision.
function SmartDateOrText({
  column,
  value,
  className,
}: {
  column: string | undefined;
  value: unknown;
  className?: string;
}) {
  if (looksLikeDateColumn(column)) {
    const smart = formatSmartDate(value);
    if (smart) {
      return (
        <span className={className} title={smart.full}>
          {smart.text}
        </span>
      );
    }
  }
  return <span className={className}>{formatCell(value)}</span>;
}
