import { ChevronDown, ChevronsUpDown, ChevronUp, Table2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ColorToken, TableColumnSpec, TableViewSpec } from "@/lib/dashboardSchema";

import { EmptyState } from "@/components/ui/empty-state";
import { RowDetailDialog } from "./RowDetailDialog";
import { isStatusColumn, StatusBadge } from "./StatusBadge";
import {
  colorClasses,
  defaultAlign,
  formatValue,
  resolveLinkTemplate,
} from "./format";
import { usePersistedState } from "./usePersistedState";

interface TableViewProps {
  view: TableViewSpec;
  columns: string[];
  rows: unknown[][];
  emptyState?: string;
  storageKeyBase?: string;
}

type SortDir = "asc" | "desc" | null;
interface SortState {
  column: string;
  dir: SortDir;
}

interface ResolvedColumn {
  name: string;
  index: number;
  spec: TableColumnSpec | null;
  align: "left" | "center" | "right";
  /** Falls back to the legacy status-by-name detection when no spec
   *  format is set. Lets us keep the v1 status-badge experience for
   *  unannotated dashboards. */
  isLegacyStatus: boolean;
}

// Renders a panel's rows as a comfortable Notion-style table: roomy
// padding, larger row text, hairline borders, soft hover. The view's
// `columns` field, when set, drives column order, format, alignment,
// width, color chips, and clickable links.
export function TableView({
  view,
  columns,
  rows,
  emptyState,
  storageKeyBase,
}: TableViewProps) {
  const visible = pickColumns(view, columns);
  const [sort, setSort] = usePersistedState<SortState | null>(
    storageKeyBase ? `${storageKeyBase}:table:sort` : undefined,
    null,
  );
  const [resizedWidths, setResizedWidths] = usePersistedState<Record<string, number>>(
    storageKeyBase ? `${storageKeyBase}:table:widths` : undefined,
    {},
  );

  // Effective width per column: spec.width > user resize > default.
  const effectiveWidths = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of visible) {
      out[c.name] = c.spec?.width ?? resizedWidths[c.name] ?? defaultColumnWidthPx(c);
    }
    return out;
  }, [visible, resizedWidths]);

  // Local sort: click a header to cycle asc → desc → null. Numeric
  // columns sort numerically; everything else falls through to
  // localeCompare so dates / strings / mixed values DTRT.
  const sortedRows = useMemo(() => {
    if (!sort || !sort.dir) return rows;
    const idx = columns.indexOf(sort.column);
    if (idx < 0) return rows;
    const sign = sort.dir === "asc" ? 1 : -1;
    return rows.slice().sort((a, b) => {
      const av = a[idx];
      const bv = b[idx];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === "number" && typeof bv === "number") {
        return sign * (av - bv);
      }
      return sign * String(av).localeCompare(String(bv));
    });
  }, [rows, sort, columns]);

  const [shownLimit, setShownLimit] = useState(500);
  const displayRows = sortedRows.slice(0, shownLimit);

  const [selectedRow, setSelectedRow] = useState<Record<string, unknown> | null>(
    null,
  );

  const detailColumns = useMemo<
    Array<{ name: string; label?: string; spec: TableColumnSpec | null }>
  >(
    () =>
      visible.map((c) => ({
        name: c.name,
        label: c.spec?.label,
        spec: c.spec,
      })),
    [visible],
  );

  const detailTitleColumn = useMemo(() => {
    const heavy = visible.find((c) => TEXT_HEAVY_NAMES.has(c.name.toLowerCase()));
    return heavy?.name ?? visible[0]?.name ?? null;
  }, [visible]);

  const cycleSort = (column: string) => {
    setSort((prev) => {
      if (!prev || prev.column !== column) return { column, dir: "asc" };
      return { column, dir: prev.dir === "asc" ? "desc" : "asc" };
    });
  };

  const beginResize = useCallback(
    (name: string, startX: number) => {
      const startWidth = effectiveWidths[name] ?? 160;
      const prevCursor = document.body.style.cursor;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (e: PointerEvent) => {
        const dx = e.clientX - startX;
        const next = Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, startWidth + dx));
        setResizedWidths((prev) => ({ ...prev, [name]: next }));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = "";
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [effectiveWidths],
  );

  const totalWidth = visible.reduce(
    (sum, c) => sum + (effectiveWidths[c.name] ?? 160),
    0,
  );

  const scrollWrapRef = useRef<HTMLDivElement | null>(null);
  const [edgeFade, setEdgeFade] = useState({ left: 0, right: 0 });
  const updateEdgeFade = useCallback(() => {
    const el = scrollWrapRef.current;
    if (!el) return;
    const FADE_PX = 24;
    const left = el.scrollLeft > 1 ? FADE_PX : 0;
    const right =
      el.scrollLeft < el.scrollWidth - el.clientWidth - 1 ? FADE_PX : 0;
    setEdgeFade((prev) =>
      prev.left === left && prev.right === right ? prev : { left, right },
    );
  }, []);
  useEffect(() => {
    updateEdgeFade();
    const el = scrollWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(updateEdgeFade);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateEdgeFade, totalWidth]);

  if (visible.length === 0) {
    return <EmptyState icon={Table2} title="No columns to display." />;
  }
  if (rows.length === 0) {
    return <EmptyState icon={Table2} title={emptyState ?? "Nothing here yet."} />;
  }

  return (
    <div className="group pt-1">
      <div
        ref={scrollWrapRef}
        onScroll={updateEdgeFade}
        className="scrollbar-ghost mask-edges-x overflow-x-auto"
        style={{
          ["--mask-left" as string]: `${edgeFade.left}px`,
          ["--mask-right" as string]: `${edgeFade.right}px`,
        }}
      >
        <table
          className="border-collapse text-sm"
          style={{ width: totalWidth, tableLayout: "fixed" }}
        >
          <colgroup>
            {visible.map((c) => (
              <col
                key={c.name}
                style={{ width: `${effectiveWidths[c.name]}px` }}
              />
            ))}
          </colgroup>
          <thead>
            <tr>
              {visible.map((c, idx) => {
                const active = sort?.column === c.name && sort.dir;
                const dir = active ? sort?.dir : null;
                const isLast = idx === visible.length - 1;
                return (
                  <th
                    key={c.name}
                    className={`group/th relative border-b border-border px-3 py-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground first:pl-1 last:pr-1 ${alignClass(c.align)}`}
                  >
                    <button
                      type="button"
                      onClick={() => cycleSort(c.name)}
                      title={
                        dir === "asc"
                          ? "Sorted ascending — click for descending"
                          : dir === "desc"
                            ? "Sorted descending — click for ascending"
                            : "Click to sort"
                      }
                      className={`-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-fg-6 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                        c.align === "right" ? "flex-row-reverse" : ""
                      } ${active ? "text-foreground" : ""}`}
                    >
                      <span>{c.spec?.label ?? c.name}</span>
                      {dir === "asc" ? (
                        <ChevronUp size={12} strokeWidth={2.25} className="opacity-80" />
                      ) : dir === "desc" ? (
                        <ChevronDown size={12} strokeWidth={2.25} className="opacity-80" />
                      ) : (
                        <ChevronsUpDown
                          size={11}
                          strokeWidth={1.75}
                          className="opacity-0 transition-opacity group-hover/th:opacity-50"
                        />
                      )}
                    </button>
                    {isLast ? null : (
                      <ResizeHandle
                        onStart={(startX) => beginResize(c.name, startX)}
                      />
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
        <tbody>
          {displayRows.map((row, rIdx) => {
            const rowObj = rowToObject(row, columns);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: SQL row order is the natural key
              <tr
                key={rIdx}
                onClick={(e) => {
                  if (
                    e.target instanceof HTMLElement &&
                    e.target.closest("a, button")
                  ) {
                    return;
                  }
                  setSelectedRow(rowObj);
                }}
                className="cursor-pointer border-b border-border transition-colors hover:bg-fg-4 last:border-b-0"
              >
                {visible.map((c) => (
                  <Cell key={c.name} column={c} value={row[c.index]} row={rowObj} />
                ))}
              </tr>
            );
          })}
          </tbody>
        </table>
      </div>
      {rows.length > displayRows.length ? (
        <div className="flex items-center gap-3 pt-3 text-xs text-muted-foreground">
          <span>
            Showing {displayRows.length} of {rows.length} rows.
          </span>
          <button
            type="button"
            onClick={() => setShownLimit((n) => n + 500)}
            className="rounded-md border border-border px-2 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
          >
            Show {Math.min(500, rows.length - displayRows.length)} more
          </button>
        </div>
      ) : null}
      <RowDetailDialog
        open={selectedRow !== null}
        onOpenChange={(next) => {
          if (!next) setSelectedRow(null);
        }}
        title={
          selectedRow && detailTitleColumn
            ? String(selectedRow[detailTitleColumn] ?? "Details")
            : "Details"
        }
        columns={detailColumns}
        row={selectedRow ?? {}}
      />
    </div>
  );
}

interface ResizeHandleProps {
  onStart: (clientX: number) => void;
}

// Thin draggable strip on the right edge of every header cell except
// the last. 1px visual at rest, expands to 3px + accent on hover.
// Pointer events bubble through the underlying header click area
// because we stop propagation in onPointerDown — no accidental
// sort-on-resize.
function ResizeHandle({ onStart }: ResizeHandleProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        onStart(e.clientX);
      }}
      onClick={(e) => e.stopPropagation()}
      className="absolute inset-y-0 -right-1 z-10 flex w-2 cursor-col-resize items-center justify-center transition-colors hover:bg-fg-12"
      title="Drag to resize column"
    >
      <span aria-hidden className="h-3 w-px bg-fg-24 transition-all group-hover/th:h-4" />
    </div>
  );
}

// Default column widths in pixels. Three rules layered: explicit
// `width:` in the spec wins, then user-resized (component state),
// then this default function. Wider defaults than before because
// the table now scrolls horizontally — better to be predictable
// and let the user scroll than to cram every column to 80px.
//
//   - `colors:` map / `format: tag` / status-named → 120px
//   - numeric formats → 110px
//   - datetime / date → 170px
//   - url → 140px
//   - image_url → 64px
//   - text columns named title/name/post/content/body/subject → 280px
//   - bare text columns → 160px (was implicit, gives wrap fallback)
function defaultColumnWidthPx(c: ResolvedColumn): number {
  const fmt = c.spec?.format;
  const hasChip = !!c.spec?.colors;
  if (hasChip || fmt === "tag") return 120;
  if (c.isLegacyStatus) return 130;
  if (fmt === "datetime" || fmt === "date") return 170;
  if (fmt === "url") return 140;
  if (fmt === "image_url") return 64;
  if (fmt === "currency") return 130;
  if (
    fmt === "integer" ||
    fmt === "number" ||
    fmt === "percent" ||
    fmt === "duration"
  ) {
    return 110;
  }
  if (TEXT_HEAVY_NAMES.has(c.name.toLowerCase())) return 280;
  return 160;
}

const TEXT_HEAVY_NAMES = new Set([
  "title",
  "name",
  "post",
  "content",
  "body",
  "subject",
  "description",
  "summary",
  "message",
  "label",
]);

const MIN_COLUMN_WIDTH = 56;
const MAX_COLUMN_WIDTH = 800;

function pickColumns(view: TableViewSpec, columns: string[]): ResolvedColumn[] {
  if (!view.columns || view.columns.length === 0) {
    return columns.map((name, index) => ({
      name,
      index,
      spec: null,
      align: "left" as const,
      isLegacyStatus: isStatusColumn(name),
    }));
  }
  const out: ResolvedColumn[] = [];
  for (const entry of view.columns) {
    if (typeof entry === "string") {
      const idx = columns.indexOf(entry);
      if (idx < 0) continue;
      out.push({
        name: entry,
        index: idx,
        spec: null,
        align: "left",
        isLegacyStatus: isStatusColumn(entry),
      });
      continue;
    }
    const idx = columns.indexOf(entry.name);
    if (idx < 0) continue;
    out.push({
      name: entry.name,
      index: idx,
      spec: entry,
      align: entry.align ?? defaultAlign(entry.format),
      isLegacyStatus: !entry.format && !entry.colors && isStatusColumn(entry.name),
    });
  }
  return out;
}

function rowToObject(row: unknown[], columns: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < columns.length; i += 1) {
    out[columns[i]] = row[i];
  }
  return out;
}

function alignClass(align: "left" | "center" | "right"): string {
  if (align === "right") return "text-right";
  if (align === "center") return "text-center";
  return "text-left";
}

function Cell({
  column,
  value,
  row,
}: {
  column: ResolvedColumn;
  value: unknown;
  row: Record<string, unknown>;
}) {
  const baseTd = `px-3 py-2.5 align-top first:pl-1 last:pr-1 ${alignClass(column.align)}`;
  const spec = column.spec;

  // Format-driven specialized rendering.
  if (spec?.format === "image_url" && typeof value === "string" && value) {
    return (
      <td className={baseTd}>
        <img
          src={value}
          alt=""
          className="h-8 w-8 shrink-0 rounded-md border border-border object-cover"
        />
      </td>
    );
  }

  if (spec?.format === "url") {
    const href = typeof value === "string" && value ? value : null;
    if (!href) {
      return (
        <td className={baseTd}>
          <span className="text-muted-foreground">—</span>
        </td>
      );
    }
    const label = spec.label ?? "Open";
    return (
      <td className={baseTd}>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-md text-primary underline-offset-4 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {label}
          <span aria-hidden className="text-[10px]">↗</span>
        </a>
      </td>
    );
  }

  // Color-mapped chip — explicit `colors:` map overrides the legacy
  // status detection. The map's key matches the cell's stringified
  // value exactly.
  if (spec?.colors && value !== null && value !== undefined) {
    const key = String(value);
    const token = (spec.colors as Record<string, ColorToken>)[key];
    if (token) {
      const cls = colorClasses(token);
      return (
        <td className={baseTd}>
          <span
            className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ${cls.badge}`}
          >
            {key}
          </span>
        </td>
      );
    }
  }

  // Legacy fallback: status-named column → StatusBadge.
  if (column.isLegacyStatus) {
    return (
      <td className={baseTd}>
        <StatusBadge value={String(value ?? "")} />
      </td>
    );
  }

  const text = formatValue(value, spec?.format, { currency: spec?.currency });

  // Optional link template — wraps whatever rendered value in an <a>.
  if (spec?.link) {
    const href = resolveLinkTemplate(spec.link, row);
    if (href) {
      return (
        <td className={baseTd}>
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md text-primary underline-offset-4 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {text}
          </a>
        </td>
      );
    }
  }

  // Default: formatted text. Long values get a 2-line clamp + tooltip.
  const isLong = text.length > 80;
  return (
    <td className={`${baseTd} text-foreground`}>
      {isLong ? (
        <span className="line-clamp-2 leading-snug" title={text}>
          {text}
        </span>
      ) : (
        <span
          className={`${
            column.align === "right" ? "tabular-nums" : ""
          } leading-relaxed`}
        >
          {text}
        </span>
      )}
    </td>
  );
}
