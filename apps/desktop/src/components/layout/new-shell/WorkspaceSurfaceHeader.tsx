import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function WorkspaceSurfaceHeader({
  icon,
  eyebrow,
  title,
  description,
  meta,
  actions,
  statusMessage,
  className,
}: {
  icon?: ReactNode;
  eyebrow: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  statusMessage?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("border-b border-border px-6 py-4", className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-start gap-3">
            {icon ? (
              <div className="grid size-10 shrink-0 place-items-center rounded-2xl border border-border bg-card/80 shadow-sm">
                {icon}
              </div>
            ) : null}
            <div className="min-w-0">
              <div className="text-[11px] font-medium uppercase tracking-[0.24em] text-foreground/40">
                {eyebrow}
              </div>
              <h1 className="mt-1 text-[28px] font-semibold tracking-tight text-foreground">
                {title}
              </h1>
              {description ? (
                <div className="mt-1 max-w-3xl whitespace-pre-wrap text-sm text-foreground/55">
                  {description}
                </div>
              ) : null}
              {meta ? <div className="mt-3">{meta}</div> : null}
            </div>
          </div>
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {actions}
          </div>
        ) : null}
      </div>
      {statusMessage ? (
        <div className="mt-3 rounded-2xl border border-border bg-card/80 px-3 py-2 text-xs text-foreground/65">
          {statusMessage}
        </div>
      ) : null}
    </div>
  );
}
