import {
  CalendarDays,
  Columns3,
  GalleryThumbnails,
  type LucideIcon,
  List as ListIcon,
  Rows3,
  Table2,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  type DataViewPanel as DataViewPanelSpec,
  type DataViewSpec,
  resolveInitialView,
} from "@/lib/dashboardSchema";

import { BoardView } from "./BoardView";
import { ErrorMessage } from "./ErrorMessage";
import { ListView } from "./ListView";
import { TableView } from "./TableView";

interface DataViewPanelProps {
  panel: DataViewPanelSpec;
  state: DataViewState;
  storageKeyBase?: string;
  fullWidth?: boolean;
}

export type DataViewState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "data"; columns: string[]; rows: unknown[][] };

const VIEW_META: Record<DataViewSpec["type"], { label: string; icon: LucideIcon }> = {
  table: { label: "Table", icon: Table2 },
  board: { label: "Board", icon: Columns3 },
  list: { label: "List", icon: Rows3 },
  gallery: { label: "Gallery", icon: GalleryThumbnails },
  calendar: { label: "Calendar", icon: CalendarDays },
  timeline: { label: "Timeline", icon: ListIcon },
};

// Wraps a single panel's data in a Notion-style card: thin border,
// solid card surface, header with title + connected segmented view
// switcher with an animated indicator pill, body with the active
// view's content. Selected view state is component-local.
export function DataViewPanel({
  panel,
  state,
  storageKeyBase,
  fullWidth = false,
}: DataViewPanelProps) {
  const [activeViewType, setActiveViewType] = useState<DataViewSpec["type"]>(
    () => resolveInitialView(panel).type,
  );
  const activeView =
    panel.views.find((v) => v.type === activeViewType) ?? panel.views[0];

  const rowCount = state.kind === "data" ? state.rows.length : null;

  return (
    <section className="group overflow-hidden rounded-xl bg-card shadow-md smooth-corners">
      <header className="border-b border-border bg-fg-2 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-sm font-semibold tracking-tight text-foreground">
              {panel.title}
            </h3>
            {rowCount !== null ? (
              <span className="shrink-0 rounded-md bg-fg-6 px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-muted-foreground">
                {rowCount}
              </span>
            ) : null}
          </div>
          {panel.views.length > 1 ? (
            <ViewTabs
              views={panel.views}
              active={activeViewType}
              onChange={setActiveViewType}
            />
          ) : null}
        </div>
        {panel.description ? (
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {panel.description}
          </p>
        ) : null}
      </header>
      <div
        className={`scrollbar-ghost overflow-auto px-4 py-3 ${
          fullWidth ? "max-h-[800px]" : "max-h-[560px]"
        }`}
      >
        {state.kind === "loading" ? (
          <SkeletonRows />
        ) : state.kind === "error" ? (
          <ErrorMessage message={state.message} />
        ) : (
          <ViewBody
            view={activeView}
            state={state}
            emptyState={panel.empty_state}
            storageKeyBase={storageKeyBase}
          />
        )}
      </div>
    </section>
  );
}

function ViewBody({
  view,
  state,
  emptyState,
  storageKeyBase,
}: {
  view: DataViewSpec;
  state: Extract<DataViewState, { kind: "data" }>;
  emptyState?: string;
  storageKeyBase: string | undefined;
}) {
  if (view.type === "table") {
    return (
      <TableView
        view={view}
        columns={state.columns}
        rows={state.rows}
        emptyState={emptyState}
        storageKeyBase={storageKeyBase}
      />
    );
  }
  if (view.type === "board") {
    return (
      <BoardView
        view={view}
        columns={state.columns}
        rows={state.rows}
        emptyState={emptyState}
        storageKeyBase={storageKeyBase}
      />
    );
  }
  if (view.type === "list") {
    return (
      <ListView
        view={view}
        columns={state.columns}
        rows={state.rows}
        emptyState={emptyState}
      />
    );
  }
  // gallery / calendar / timeline — declared in v2 spec, renderer ships
  // in PR2. Show a clean placeholder rather than crashing.
  return (
    <div className="my-6 rounded-md border border-dashed border-border bg-fg-2 px-4 py-6 text-center text-xs text-muted-foreground">
      The <span className="font-medium text-foreground">{view.type}</span> view
      ships in the next dashboard release. Showing an alternate view above
      should keep this panel useful in the meantime.
    </div>
  );
}

interface ViewTabsProps {
  views: DataViewSpec[];
  active: DataViewSpec["type"];
  onChange: (type: DataViewSpec["type"]) => void;
}

// Segmented control with an animated background pill that slides under
// the active tab — that's the Notion / Linear / Apple finish that
// makes view switching feel solid instead of janky.
function ViewTabs({ views, active, onChange }: ViewTabsProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    const target = tabRefs.current[active];
    const container = containerRef.current;
    if (!target || !container) return;
    const cRect = container.getBoundingClientRect();
    const tRect = target.getBoundingClientRect();
    setIndicator({ left: tRect.left - cRect.left, width: tRect.width });
  }, [active, views.length]);

  // Recompute on container resize so the indicator stays under the tab
  // when the panel is resized (split-pane layouts, full-width toggle).
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => {
      const target = tabRefs.current[active];
      const container = containerRef.current;
      if (!target || !container) return;
      const cRect = container.getBoundingClientRect();
      const tRect = target.getBoundingClientRect();
      setIndicator({ left: tRect.left - cRect.left, width: tRect.width });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [active]);

  return (
    <div
      ref={containerRef}
      className="relative flex shrink-0 items-center rounded-md border border-border bg-muted/40 p-0.5"
    >
      {indicator ? (
        <span
          aria-hidden
          className="pointer-events-none absolute top-0.5 bottom-0.5 rounded bg-background shadow-[0_1px_2px_oklch(0_0_0/0.06)] transition-[left,width] duration-200 ease-out"
          style={{ left: indicator.left, width: indicator.width }}
        />
      ) : null}
      {views.map((view) => {
        const meta = VIEW_META[view.type];
        if (!meta) return null;
        const isActive = view.type === active;
        const Icon = meta.icon;
        return (
          <button
            ref={(el) => {
              tabRefs.current[view.type] = el;
            }}
            type="button"
            key={view.type}
            onClick={() => onChange(view.type)}
            title={meta.label}
            aria-label={`${meta.label} view`}
            aria-pressed={isActive}
            className={`relative z-10 grid size-6 place-items-center rounded transition-colors duration-150 ${
              isActive
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50`}
          >
            <Icon size={13} strokeWidth={1.75} />
          </button>
        );
      })}
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-2 py-3" aria-busy aria-label="Loading">
      {[80, 64, 92, 70, 76].map((width, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: skeleton order is not data-driven
          key={i}
          className="flex items-center gap-3"
        >
          <div className="animate-shimmer h-4 flex-1 rounded bg-fg-6" style={{ maxWidth: `${width}%` }} />
          <div className="animate-shimmer h-4 w-12 shrink-0 rounded bg-fg-6" />
        </div>
      ))}
    </div>
  );
}
