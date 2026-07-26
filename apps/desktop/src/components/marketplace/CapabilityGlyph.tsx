import { Icon as IconifyIcon } from "@iconify/react";
import { getCapabilityIcon } from "@/lib/capabilityGlyph";
import { cn } from "@/lib/utils";

/** Monochrome solid glyph tile for a capability (Phosphor Fill) — the calm,
 *  consistent treatment shared by the browse grid, the installed list, and the
 *  detail hero, so a capability's icon is identical everywhere it appears.
 *  Brand color is reserved for the Recommended hero cards. */
export function CapabilityGlyph({
  id,
  category,
  icon,
  className,
  iconClassName = "size-6",
}: {
  id: string;
  category?: string;
  icon?: string;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span
      className={cn(
        "grid size-12 shrink-0 place-items-center rounded-2xl border border-border bg-muted text-foreground/70",
        className,
      )}
    >
      <IconifyIcon
        className={iconClassName}
        icon={getCapabilityIcon(id, category, icon)}
      />
    </span>
  );
}
