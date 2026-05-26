import { Plug } from "lucide-react";
import { useState } from "react";
import { brandLogoOverride, getIntegrationLogo } from "@/lib/integrationLogo";
import { cn } from "@/lib/utils";

/**
 * Renders a provider logo with stable visual rules:
 *  - Square aspect ratio, contained image (never stretched).
 *  - White-on-white SVG protection via container background.
 *  - Failure path: graceful fallback to the Plug icon, never a broken image.
 *
 * Use this instead of raw <img src={composioLogoUrl}>; cf. the recent
 * bd82591c GitHub / Linear override commit — having one place to fix logo
 * issues means future provider-asset bugs cost one PR, not five.
 */
export function IntegrationLogo({
  slug,
  alt,
  className,
  size = "md",
  overrideUrl,
}: {
  slug: string;
  alt?: string;
  className?: string;
  /** sm = 6 (24px), md = 7 (28px), lg = 8 (32px). */
  size?: "sm" | "md" | "lg";
  /** Caller-provided logo URL (e.g. composioToolkitsByProvider) wins
   *  over the CDN guess when present. */
  overrideUrl?: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const brandOverride = brandLogoOverride(slug);
  const fromCatalog = overrideUrl?.trim() || null;
  const fromCdn = getIntegrationLogo(slug).url;
  // Brand override wins over caller-provided URL because the Composio
  // toolkit.logo for these slugs (github, linear) is itself broken — see
  // bd82591c. Otherwise the caller's URL wins over the CDN guess.
  const url = brandOverride ?? fromCatalog ?? fromCdn;
  const sizeClass =
    size === "sm" ? "size-6" : size === "lg" ? "size-8" : "size-7";

  if (!url || failed) {
    return (
      <span
        className={cn(
          sizeClass,
          "grid shrink-0 place-items-center rounded-md border border-border bg-background text-muted-foreground",
          className,
        )}
      >
        <Plug className="size-3.5" />
      </span>
    );
  }

  return (
    <span
      className={cn(
        sizeClass,
        "grid shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-background",
        className,
      )}
    >
      <img
        alt={alt ?? ""}
        className="size-full object-contain p-0.5"
        onError={() => setFailed(true)}
        referrerPolicy="no-referrer"
        src={url}
      />
    </span>
  );
}
