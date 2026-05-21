import { AppWindow } from "lucide-react";
import { useState } from "react";
import { providerIcon } from "@/components/onboarding/constants";

type Stage = "backend" | "cdn" | "local" | "letter";

interface AppIconProps {
  /** Optional URL from the marketplace manifest. Tried first if present. */
  iconUrl?: string | null;
  /** Toolkit slug / app id used for CDN lookup and local SVG match. */
  appId: string;
  /**
   * Composio toolkit slug (e.g. `googlecalendar`, `googledrive`) when the
   * app's `app_id` differs from it (e.g. `gcalendar`, `gdrive`). Preferred
   * over `appId` for the CDN lookup since the Composio logo CDN is keyed
   * by toolkit slug — using `appId` 404s for any app whose internal id
   * isn't also a Composio slug.
   */
  providerId?: string | null;
  /** Human label, used to compute the letter-fallback character(s). */
  label: string;
  /**
   * Visual size variant.
   *  - "card":    36px chip with a 24px logo (catalog cards)
   *  - "row":     16px chip with a 16px logo (sidebar / inline rows)
   *  - "toolbar": 28px chip with a 22px logo (app surface toolbar)
   */
  size?: "card" | "row" | "toolbar";
}

/**
 * AppIcon — unified icon resolver across the desktop app surfaces.
 *
 * Stages, in order of preference:
 *   1. backend — `iconUrl` from the marketplace manifest (most authoritative)
 *   2. cdn     — `logos.composio.dev/api/{slug}` (widest coverage; same
 *                CDN IntegrationsPane uses, so visual style stays uniform)
 *   3. local   — hardcoded brand SVGs in providerIcon() (last-line
 *                brand-aware fallback for the providers we ship inline)
 *   4. letter  — initial(s) of the app name in a colored chip (last
 *                resort; only fires when CDN 404s and we have no local SVG)
 *
 * Every successful path lands in a chip with the same dimensions so
 * cards/rows align cleanly regardless of which fallback fired.
 */
export function AppIcon({
  iconUrl,
  appId,
  providerId,
  label,
  size = "card",
}: AppIconProps) {
  const localSvgPx =
    size === "card" ? 22 : size === "toolbar" ? 22 : 14;
  const localSvg = providerIcon(appId, localSvgPx);

  const initialStage: Stage = iconUrl ? "backend" : "cdn";
  const [stage, setStage] = useState<Stage>(initialStage);

  const containerClass =
    size === "card"
      ? "grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-muted/40"
      : size === "toolbar"
        ? "grid size-7 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-muted"
        : "grid size-4 shrink-0 place-items-center overflow-hidden rounded-sm";
  const letterClass =
    size === "card"
      ? "grid size-9 shrink-0 place-items-center rounded-lg bg-muted/40 text-sm font-semibold uppercase text-muted-foreground"
      : size === "toolbar"
        ? "grid size-7 shrink-0 place-items-center rounded-md border border-border bg-muted text-[10px] font-semibold uppercase text-muted-foreground"
        : "grid size-4 shrink-0 place-items-center rounded-sm bg-muted text-[9px] font-semibold uppercase text-muted-foreground";
  const imgClass =
    size === "card"
      ? "size-6 object-contain"
      : size === "toolbar"
        ? "size-[22px] object-contain"
        : "size-4 object-contain";

  if (stage === "backend" && iconUrl) {
    return (
      <span className={containerClass}>
        <img
          src={iconUrl}
          alt=""
          className={imgClass}
          onError={() => setStage("cdn")}
        />
      </span>
    );
  }

  if (stage === "cdn") {
    const cdnSlug = (providerId?.trim() || appId.trim()).toLowerCase();
    return (
      <span className={containerClass}>
        <img
          src={`https://logos.composio.dev/api/${cdnSlug}`}
          alt=""
          className={imgClass}
          onError={() => setStage(localSvg ? "local" : "letter")}
        />
      </span>
    );
  }

  if (stage === "local" && localSvg) {
    return <span className={containerClass}>{localSvg}</span>;
  }

  // Row-size fallback skips the letter chip — sidebar lists read cleaner
  // with a uniform muted-glyph icon than with one-off colored initials.
  if (size === "row") {
    return (
      <span className={containerClass}>
        <AppWindow className="size-3.5 text-foreground/55" />
      </span>
    );
  }

  return (
    <span className={letterClass}>
      {computeInitials(label, size === "card")}
    </span>
  );
}

/**
 * Card variant uses 1-letter initial; row variant uses 2 letters when the
 * label is multi-word — matches existing SpaceApplicationsExplorerPane
 * behaviour where 2-letter chips read better at 16px.
 */
function computeInitials(label: string, singleLetter: boolean): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  if (singleLetter || parts.length === 1) {
    return parts[0].slice(0, 1).toUpperCase();
  }
  return `${parts[0].slice(0, 1)}${parts[1].slice(0, 1)}`.toUpperCase();
}
