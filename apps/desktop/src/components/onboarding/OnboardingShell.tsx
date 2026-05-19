import { ChevronLeft, X } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { holabossLogoUrl } from "@/lib/assetPaths";

interface OnboardingShellProps {
  /** When provided, top-left "Back" link is rendered. */
  onBack?: () => void;
  /** When provided, top-right close button is rendered (panel variant). */
  onClose?: () => void;
  /** Footer copy — defaults to the holaboss copyright row. */
  footer?: ReactNode;
  /** Optional override for the brand row label. */
  brandLabel?: string;
  children: ReactNode;
}

const COPYRIGHT_YEAR = new Date().getFullYear();

/**
 * Full-bleed onboarding canvas: brand row, hairline ruler, optional Back link,
 * centered content, footer copyright.
 */
export function OnboardingShell({
  onBack,
  onClose,
  footer,
  brandLabel = "holaOS",
  children,
}: OnboardingShellProps) {
  return (
    <div className="relative z-10 flex min-h-0 flex-1 flex-col bg-fg-2">
      {/* macOS draggable region */}
      <div className="titlebar-drag-region fixed top-0 right-0 left-0 z-10 h-[38px]" />

      {/* Brand row — logo + label, no wrapping square. */}
      <header className="window-drag relative z-20 flex shrink-0 items-center justify-between gap-3 px-7 pt-[44px] pb-4 sm:px-9">
        <div className="flex min-w-0 items-center gap-2.5">
          <img
            src={holabossLogoUrl}
            alt=""
            aria-hidden
            className="size-7 shrink-0 object-contain"
          />
          <span className="truncate text-base font-semibold tracking-tight text-foreground">
            {brandLabel}
          </span>
        </div>
        {onClose ? (
          <Button
            aria-label="Close"
            onClick={onClose}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X />
          </Button>
        ) : null}
      </header>

      {/* Hairline ruler beneath brand. */}
      <div aria-hidden className="mx-7 h-px bg-border sm:mx-9" />

      {/* Back link — default ghost button. */}
      <div className="flex shrink-0 items-center px-7 pt-7 pb-1 sm:px-9">
        {onBack ? (
          <Button onClick={onBack} size="sm" type="button" variant="ghost">
            <ChevronLeft />
            Back
          </Button>
        ) : (
          <span className="h-7" />
        )}
      </div>

      {/* Centered content slot. */}
      <main className="flex min-h-0 flex-1 items-center justify-center px-7 sm:px-9">
        {children}
      </main>

      {/* Footer ruler + copyright. */}
      <footer className="shrink-0">
        <div aria-hidden className="mx-7 h-px bg-border sm:mx-9" />
        <p className="px-7 py-4 text-xs text-muted-foreground sm:px-9">
          {footer ?? (
            <>
              © {COPYRIGHT_YEAR} holaboss Inc. <span className="px-1">|</span>{" "}
              All rights reserved
            </>
          )}
        </p>
      </footer>
    </div>
  );
}
