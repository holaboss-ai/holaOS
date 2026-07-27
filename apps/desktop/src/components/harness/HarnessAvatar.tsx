import { cn } from "@/lib/utils";
import { AgentAvatar } from "@/components/ui/agent-avatar";
import { HarnessIcon, type HarnessIconSize, harnessHasFavicon } from "./harnessIcon";

type HarnessAvatarSize = "sm" | "md" | "lg";

// HarnessAvatar's sizes map onto HarnessIcon's tile sizes (same box px) so a
// branded session and a generated AgentAvatar stay visually interchangeable.
const ICON_SIZE_BY_AVATAR_SIZE: Record<HarnessAvatarSize, HarnessIconSize> = {
  sm: "xs",
  md: "sm",
  lg: "md",
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
