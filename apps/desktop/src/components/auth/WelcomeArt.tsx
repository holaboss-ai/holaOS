import type { ReactNode } from "react";
import { holabossLogoUrl } from "@/lib/assetPaths";
import { cn } from "@/lib/utils";

/**
 * Brand mark with three static halo rings fading outward. Reads as ambient
 * brand presence rather than a literal target. Used by the sign-in screen
 * and the workspace onboarding welcome moment.
 */
export function WelcomeHero() {
  return (
    <div className="flex justify-center">
      <div className="relative flex size-16 items-center justify-center">
        <span
          aria-hidden
          className="absolute inset-0 -m-5 rounded-full border border-primary/8"
        />
        <span
          aria-hidden
          className="absolute inset-0 -m-3 rounded-full border border-primary/16"
        />
        <span
          aria-hidden
          className="absolute inset-0 -m-1 rounded-full border border-primary/26"
        />
        <img
          alt=""
          aria-hidden
          className="size-12 object-contain"
          src={holabossLogoUrl}
        />
      </div>
    </div>
  );
}

interface FeatureCardProps {
  art: ReactNode;
  title: string;
  caption: string;
  delayMs?: number;
}

export function FeatureCard({
  art,
  title,
  caption,
  delayMs = 0,
}: FeatureCardProps) {
  const animated = delayMs > 0;
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-xl bg-fg-2 px-3 pt-5 pb-4 text-center",
        animated && "opacity-0 animate-fade-in-once",
      )}
      style={animated ? { animationDelay: `${delayMs}ms` } : undefined}
    >
      <div className="mt-1 mb-1 text-foreground/70 [&>svg]:size-10">{art}</div>
      <p className="mt-3 text-sm font-medium text-foreground">{title}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{caption}</p>
    </div>
  );
}
