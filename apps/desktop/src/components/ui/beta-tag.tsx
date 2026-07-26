import { cn } from "@/lib/utils";

/**
 * Quiet, understated marker — a neutral outlined chip rather than a loud coloured
 * badge. Defaults to "Beta" (used across maturing surfaces) but takes any short
 * `label` (e.g. a catalog-driven "new"), rendered uppercased.
 */
export function BetaTag({
  title,
  label = "Beta",
  className,
}: {
  /** Native tooltip shown on hover — defaults to the label. */
  title?: string;
  /** The chip text (rendered uppercased). */
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded border border-border px-1 py-px text-[9px] font-medium uppercase leading-none tracking-wide text-muted-foreground",
        className,
      )}
      title={title ?? label}
    >
      {label}
    </span>
  );
}
