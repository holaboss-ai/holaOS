import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";

import type { ColorToken, TableColumnSpec } from "@/lib/dashboardSchema";
import { cn } from "@/lib/utils";

import {
  colorClasses,
  formatValue,
  resolveLinkTemplate,
} from "./format";
import { isStatusColumn, StatusBadge } from "./StatusBadge";

export interface RowDetailColumn {
  name: string;
  label?: string;
  spec?: TableColumnSpec | null;
}

interface RowDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: string;
  columns: RowDetailColumn[];
  row: Record<string, unknown>;
}

export function RowDetailDialog({
  open,
  onOpenChange,
  title,
  subtitle,
  columns,
  row,
}: RowDetailDialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[90] bg-background/70 backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup
          className={cn(
            "fixed top-1/2 left-1/2 z-[91] flex max-h-[min(80vh,640px)] w-[min(560px,calc(100vw-32px))] flex-col",
            "-translate-x-1/2 -translate-y-1/2 rounded-xl border border-border",
            "bg-popover text-popover-foreground shadow-xl ring-1 ring-foreground/10",
            "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
            "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            "outline-none",
          )}
        >
          <header className="flex items-start gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="truncate text-sm font-semibold text-foreground">
                {title || "Details"}
              </DialogPrimitive.Title>
              {subtitle ? (
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {subtitle}
                </p>
              ) : null}
            </div>
            <DialogPrimitive.Close
              render={
                <button
                  type="button"
                  aria-label="Close"
                  className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              }
            />
          </header>
          <div className="scrollbar-ghost min-h-0 flex-1 overflow-y-auto px-5 py-3">
            <dl className="grid grid-cols-[minmax(96px,160px)_1fr] gap-x-4 gap-y-2.5 text-sm">
              {columns.map((col) => (
                <DetailRow key={col.name} column={col} row={row} />
              ))}
            </dl>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function DetailRow({
  column,
  row,
}: {
  column: RowDetailColumn;
  row: Record<string, unknown>;
}) {
  const value = row[column.name];
  return (
    <>
      <dt className="pt-0.5 text-xs uppercase tracking-wide text-muted-foreground">
        {column.label ?? column.spec?.label ?? column.name}
      </dt>
      <dd className="min-w-0 break-words text-foreground">
        <DetailValue column={column} value={value} row={row} />
      </dd>
    </>
  );
}

function DetailValue({
  column,
  value,
  row,
}: {
  column: RowDetailColumn;
  value: unknown;
  row: Record<string, unknown>;
}) {
  const spec = column.spec ?? null;
  const isEmpty = value === null || value === undefined || value === "";
  if (isEmpty) {
    return <span className="text-muted-foreground">—</span>;
  }

  if (spec?.format === "image_url" && typeof value === "string") {
    return (
      <img
        src={value}
        alt=""
        className="size-16 rounded-md border border-border object-cover"
      />
    );
  }

  if (spec?.format === "url" && typeof value === "string") {
    return (
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-primary underline-offset-4 hover:underline"
      >
        {value}
      </a>
    );
  }

  if (spec?.colors) {
    const key = String(value);
    const token = (spec.colors as Record<string, ColorToken>)[key];
    if (token) {
      const cls = colorClasses(token);
      return (
        <span
          className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ${cls.badge}`}
        >
          {key}
        </span>
      );
    }
  }

  if (!spec && isStatusColumn(column.name)) {
    return <StatusBadge value={String(value)} />;
  }

  const text = formatValue(value, spec?.format, { currency: spec?.currency });

  if (spec?.link) {
    const href = resolveLinkTemplate(spec.link, row);
    if (href) {
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline-offset-4 hover:underline"
        >
          {text}
        </a>
      );
    }
  }

  if (typeof value === "string" && value.includes("\n")) {
    return <span className="whitespace-pre-wrap leading-relaxed">{text}</span>;
  }

  return <span className="leading-relaxed">{text}</span>;
}
