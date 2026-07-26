import { bossmanSunglassesUrl } from "@/lib/assetPaths";
import { cn } from "@/lib/utils";
import { AgentAvatar, HOLA_AVATAR_URL } from "@/components/ui/agent-avatar";
import { HarnessIcon, type HarnessIconSize, harnessHasFavicon } from "./harnessIcon";

type HarnessAvatarSize = "sm" | "md" | "lg";

// HarnessAvatar's sizes map onto HarnessIcon's tile sizes (same box px) so a
// branded session and a generated AgentAvatar stay visually interchangeable.
const ICON_SIZE_BY_AVATAR_SIZE: Record<HarnessAvatarSize, HarnessIconSize> = {
  sm: "xs",
  md: "sm",
  lg: "md",
};

// Bossman's box mirrors AgentAvatar's size variants (same px + rounding) so the
// shaded Hola stays interchangeable with the plain Hola avatar.
const BOSSMAN_BOX_BY_SIZE: Record<HarnessAvatarSize, string> = {
  sm: "size-5 rounded",
  md: "size-6 rounded-md",
  lg: "size-7 rounded-md",
};

/**
 * Avatar for the agent, branded by the session's harness. Harnesses with a
 * dedicated favicon (Claude, Codex) render that mark; pi/Hola (and any
 * unmapped harness) keeps the generated AgentAvatar so existing sessions look
 * exactly as before. Mirrors AgentAvatar's box sizing so the two are
 * interchangeable.
 */
export function HarnessAvatar({
  harnessId,
  size = "md",
  seed,
  className,
}: {
  harnessId: string | null | undefined;
  size?: HarnessAvatarSize;
  seed?: string;
  className?: string;
}) {
  const id = harnessId ?? "pi";
  if (id.toLowerCase() === "bossman") {
    // Bossman = the Hola face wearing sunglasses. Composite the exact Hola
    // avatar (hola.webp) with a transparent sunglasses SVG overlaid on top; the
    // overlay's 0..100 viewBox maps 1:1 onto the square box so the lenses land
    // on Hola's eyes. Same box as AgentAvatar → interchangeable in header/turns.
    return (
      <span
        className={cn(
          "relative inline-flex shrink-0 scale-90 select-none items-center justify-center overflow-hidden bg-fg-6",
          BOSSMAN_BOX_BY_SIZE[size],
          className,
        )}
      >
        <img
          src={HOLA_AVATAR_URL}
          alt="Bossman"
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
        />
        <img
          src={bossmanSunglassesUrl}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 size-full"
        />
      </span>
    );
  }
  if (!harnessHasFavicon(id)) {
    // The full-bleed saturated face reads optically heavier than a glyph
    // tile at the same box — scale it down a notch so both sit level.
    return (
      <AgentAvatar
        seed={seed}
        size={size}
        className={cn("scale-90", className)}
      />
    );
  }
  return (
    <HarnessIcon id={id} size={ICON_SIZE_BY_AVATAR_SIZE[size]} className={className} />
  );
}
