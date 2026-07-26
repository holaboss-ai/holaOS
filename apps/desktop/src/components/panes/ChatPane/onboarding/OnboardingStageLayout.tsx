import { ArrowLeft, ArrowRight } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { motion } from "motion/react";
import type { ReactNode } from "react";

const STAGE_SPRING = {
  type: "spring" as const,
  stiffness: 360,
  damping: 32,
  mass: 0.6,
};

const ENTRANCE_TRANSITION = {
  duration: 0.42,
  ease: [0.22, 1, 0.36, 1] as const,
};

interface OnboardingStageLayoutProps {
  /** 1-based for display ("1 of 3"). */
  stageIndex: number;
  totalStages: number;
  /** Undefined disables the back arrow (used on stage 1). */
  onBack?: () => void;
  /** Undefined hides the skip link (used on the mandatory workspace stage). */
  onSkip?: () => void;
  /** Fires the primary CTA. Stage decides when to enable it. */
  onPrimaryAction: () => void;
  primaryActionLabel: string;
  /** Defaults to disabled until the stage signals readiness. */
  primaryActionDisabled?: boolean;
  /** Optional pending state — e.g. workspace creation in flight. */
  primaryActionPending?: boolean;
  skipLabel?: string;
  /** Left-column content. Typically: heading + supporting text + form. */
  left: ReactNode;
  /** Right-column content. Typically: the dotted-canvas preview. */
  right: ReactNode;
}

/**
 * Shared chrome for all integrations / workspace / browser onboarding
 * stages. Owns:
 *   - the card frame (border, shadow, min-h, entrance animation)
 *   - the top bar (back arrow + `N of M` indicator)
 *   - the split-grid body (left form / right canvas)
 *   - the footer (Skip ghost link + primary CTA with hover/arrow nudge)
 *
 * Stages should not re-create any of this — they just pass `left` /
 * `right` slots and the CTA wiring, so the visual rhythm stays exactly
 * the same as the user moves between stages.
 */
export function OnboardingStageLayout({
  stageIndex,
  totalStages,
  onBack,
  onSkip,
  onPrimaryAction,
  primaryActionLabel,
  primaryActionDisabled = false,
  primaryActionPending = false,
  skipLabel = "Skip for now",
  left,
  right,
}: OnboardingStageLayoutProps) {
  const ctaEnabled = !primaryActionDisabled && !primaryActionPending;

  return (
    <motion.div
      animate={{ opacity: 1, scale: 1 }}
      className="mx-auto flex w-full max-w-[1080px] min-h-[640px] flex-col overflow-hidden rounded-[20px] border border-border/60 bg-background shadow-[0_2px_8px_rgba(0,0,0,0.04),0_24px_48px_-12px_rgba(0,0,0,0.10)]"
      initial={{ opacity: 0, scale: 0.97 }}
      transition={ENTRANCE_TRANSITION}
    >
      {/* Top bar — back arrow appears only when there's a previous step
       * (no "disabled" state — an inert arrow on the first stage just
       * looks broken). Stage indicator anchors to the right. */}
      <div className="flex items-center justify-between px-8 pt-6">
        {onBack ? (
          <button
            aria-label="Previous step"
            className="-ml-1 grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-fg-6 hover:text-foreground"
            onClick={onBack}
            type="button"
          >
            <ArrowLeft className="size-4" />
          </button>
        ) : (
          <span aria-hidden className="size-7" />
        )}
        <span className="font-mono text-[11px] text-muted-foreground/60 tracking-[0.04em]">
          {stageIndex} of {totalStages}
        </span>
      </div>

      {/* Body — split layout. LEFT stays top-aligned (heading-first flow),
       * RIGHT centers the preview vertically inside its dotted frame. */}
      <div className="grid flex-1 grid-cols-1 gap-x-12 gap-y-8 px-8 pt-7 pb-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <div className="flex flex-col gap-6">{left}</div>
        <div
          aria-hidden
          className="relative flex h-full items-center justify-center rounded-2xl border border-border/30 bg-fg-2 p-6"
          style={{
            backgroundImage:
              "radial-gradient(var(--fg-12) 1px, transparent 1px)",
            backgroundSize: "18px 18px",
            backgroundPosition: "center",
          }}
        >
          {right}
        </div>
      </div>

      {/* Footer — skip + primary CTA */}
      <div className="flex items-center justify-between border-t border-border/50 bg-muted/30 px-8 py-3.5">
        {onSkip ? (
          <button
            className="rounded-md px-1.5 py-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={onSkip}
            type="button"
          >
            {skipLabel}
          </button>
        ) : (
          <span aria-hidden />
        )}
        <motion.button
          className={cn(
            "group/cta inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors",
            ctaEnabled
              ? "bg-primary text-primary-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06),0_0_0_1px_rgba(0,0,0,0.04)_inset] hover:bg-primary/92"
              : "cursor-not-allowed bg-muted text-muted-foreground/70",
          )}
          disabled={!ctaEnabled}
          onClick={onPrimaryAction}
          transition={STAGE_SPRING}
          type="button"
          whileHover={ctaEnabled ? { y: -0.5 } : undefined}
          whileTap={ctaEnabled ? { scale: 0.985 } : undefined}
        >
          {primaryActionPending ? "Working…" : primaryActionLabel}
          <motion.span
            animate={ctaEnabled ? { x: 0 } : { x: -2, opacity: 0.6 }}
            aria-hidden
            className="inline-flex"
            transition={{ type: "spring", stiffness: 420, damping: 28 }}
          >
            <ArrowRight className="size-3.5" />
          </motion.span>
        </motion.button>
      </div>
    </motion.div>
  );
}
