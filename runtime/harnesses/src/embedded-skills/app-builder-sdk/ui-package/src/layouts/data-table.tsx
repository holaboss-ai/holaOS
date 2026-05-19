import type { ReactNode } from "react";

import { cn } from "../lib/utils.js";
import { LoadingState } from "./loading-state.js";
import { EmptyState } from "../primitives/empty-state.js";

export interface DataTableColumn<Row> {
  /** Column key — must be unique within a table. */
  id: string;
  /** Header label. */
  header: ReactNode;
  /** Cell content; receives the full row. */
  cell: (row: Row) => ReactNode;
  /**
   * Cell alignment. `right` for numeric / monetary columns; `center`
   * for icons / status badges.
   */
  align?: "left" | "right" | "center";
  /** Hide on small viewports (< sm). */
  hideOnSmall?: boolean;
  /** Width hint in CSS units (e.g. `120px`, `20%`). */
  width?: string;
}

export interface DataTableProps<Row> {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  /** Stable key per row. */
  rowKey: (row: Row) => string;
  /** Per-row click handler. Renders rows with hover affordance. */
  onRowClick?: (row: Row) => void;
  /** When true, body is replaced with a <LoadingState>. */
  isLoading?: boolean;
  /** Empty-state title (shown when not loading and rows is empty). */
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  className?: string;
}

const alignClass: Record<NonNullable<DataTableColumn<unknown>["align"]>, string> = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
};

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  isLoading,
  emptyTitle = "No data yet",
  emptyDescription,
  className,
}: DataTableProps<Row>) {
  if (isLoading) {
    return <LoadingState variant="list" />;
  }
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }
  return (
    <div className={cn("w-full overflow-x-auto", className)}>
      <table className="w-full table-fixed border-collapse text-sm">
        <thead className="border-b border-border bg-background">
          <tr>
            {columns.map((col) => (
              <th
                key={col.id}
                className={cn(
                  "px-3 py-2 text-xs font-medium text-muted-foreground",
                  alignClass[col.align ?? "left"],
                  col.hideOnSmall && "hidden sm:table-cell",
                )}
                style={col.width ? { width: col.width } : undefined}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn(
                "border-b border-border last:border-b-0 transition-colors",
                onRowClick && "cursor-pointer hover:bg-accent",
              )}
            >
              {columns.map((col) => (
                <td
                  key={col.id}
                  className={cn(
                    "truncate px-3 py-2 text-sm text-foreground",
                    alignClass[col.align ?? "left"],
                    col.hideOnSmall && "hidden sm:table-cell",
                  )}
                >
                  {col.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
