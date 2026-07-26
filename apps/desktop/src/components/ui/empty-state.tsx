
import type { IconType } from "@/components/ui/icons"
import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

/**
 * EmptyState — centered icon + title + optional description + optional
 * action. Replaces the multiple hand-rolled placeholder variants
 * scattered across panes (sidebar empties, dashboard "no rows",
 * automations "no schedules", etc.).
 *
 * Two visual presentations driven by `size`:
 *
 *  - `sm` (compact, default in dashboard panels) — small unframed icon
 *    at low opacity, `text-sm` title + `text-xs` copy. Good when the
 *    empty state shares a tight pane with chrome.
 *
 *  - `md` (roomier, default for sidebar / list empties) — icon wrapped
 *    in a chip background, `text-base` title + `text-sm` description.
 *    More presence for full-pane empties.
 *
 * Pass `action` to surface a CTA below the description.
 *
 * `minHeight` forces a min-height (used by chart panels so the panel
 * doesn't collapse when there's no data).
 */
export interface EmptyStateProps {
  icon?: IconType
  title: string
  description?: ReactNode
  action?: ReactNode
  size?: "sm" | "md"
  /** Force min-height (px). Useful for chart cells that shouldn't collapse. */
  minHeight?: number
  /**
   * Wrap the icon in a card-on-card chip framed by an Attio-style wide
   * hairline grid backdrop that fades to transparent at the outer
   * edges. Use for full-pane empties that need real presence
   * (Automations, primary list views). Default off so compact in-card
   * empties stay flat. Only applies when `size="md"`.
   */
  decorated?: boolean
  /** Extra classes on the outer wrapper. */
  className?: string
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  size = "sm",
  minHeight,
  decorated = false,
  className,
}: EmptyStateProps) {
  const isMd = size === "md"
  const wrapperClass = cn(
    "flex flex-col items-center justify-center text-center",
    isMd ? "gap-3 px-4 py-14" : "gap-2 py-10 text-muted-foreground",
    className,
  )
  const titleClass = isMd
    ? "text-base font-medium text-foreground"
    : "text-sm font-medium text-foreground"
  const descriptionClass = isMd
    ? "max-w-sm text-sm leading-6 text-muted-foreground"
    : "text-xs leading-5 opacity-70"

  return (
    <div
      className={wrapperClass}
      style={minHeight ? { minHeight } : undefined}
    >
      {Icon ? (
        isMd ? (
          decorated ? (
            <div className="relative flex h-24 w-72 items-center justify-center overflow-hidden">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0"
                style={{
                  backgroundImage:
                    "linear-gradient(to right, var(--color-fg-8) 1px, transparent 1px), linear-gradient(to bottom, var(--color-fg-8) 1px, transparent 1px)",
                  backgroundSize: "32px 32px",
                  backgroundPosition: "center center",
                  maskImage:
                    "radial-gradient(ellipse at center, black 0%, black 38%, transparent 80%)",
                  WebkitMaskImage:
                    "radial-gradient(ellipse at center, black 0%, black 38%, transparent 80%)",
                }}
              />
              <div className="relative grid size-12 place-items-center rounded-xl border border-border bg-card text-muted-foreground shadow-xs">
                <Icon className="size-[18px]" strokeWidth={1.6} />
              </div>
            </div>
          ) : (
            <div className="grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground">
              <Icon className="size-4" strokeWidth={1.6} />
            </div>
          )
        ) : (
          <Icon size={26} strokeWidth={1.5} className="opacity-45" />
        )
      ) : null}
      <p className={titleClass}>{title}</p>
      {description ? <p className={descriptionClass}>{description}</p> : null}
      {action ? <div className={isMd ? "mt-2" : "mt-1.5"}>{action}</div> : null}
    </div>
  )
}
