import { useState } from "react";
import { AppWindow } from "@/components/ui/icons";
import { getHolaAppVisual } from "@/lib/holaAppVisual";

// The 56px hero treatment. A brand asset is its own tile — most ship an opaque
// background, so framing one draws a square inside a square. Our own glyphs have
// no background of their own and do need the frame to sit in.
// Tinted rather than a fixed surface token: the hero sits on a grey page in the
// detail views and on a white popover in the dialogs, and those two invert which
// solid reads as "raised".
const HERO_BOX = "grid size-14 shrink-0 place-items-center rounded-2xl";
const HERO_FRAME = `${HERO_BOX} border border-border bg-fg-4`;

// Favicon shown before a HolaApp's name. A curated local glyph (holaAppVisual)
// wins for apps that ship no real logo; otherwise the app's iconUrl, falling
// back to a generic app glyph when it's absent or fails to load.
export function HolaAppIcon({
  iconUrl,
  title,
  sizeClass = "size-4",
  holaAppId,
  hero = false,
}: {
  iconUrl?: string | null;
  title: string;
  /** Tailwind size utility for the glyph. Defaults to the sidebar/list size;
   * larger surfaces (e.g. the app detail hero) override it. */
  sizeClass?: string;
  /** When set and the app has a curated glyph, renders that instead of the
   * remote favicon — used for apps whose backend iconUrl is the generic
   * Holaboss placeholder. */
  holaAppId?: string;
  /** Render the 56px hero used by the app/connection detail pages and the
   * connect dialogs. Owns its own framing: a brand asset fills the box bare,
   * our glyphs keep the bordered tile. Ignores `sizeClass`. */
  hero?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const visual = getHolaAppVisual(holaAppId);
  if (visual) {
    const { Icon, className } = visual;
    // reicon glyphs render an inline `style={{ color: 'currentColor' }}`, which
    // outranks a `text-*` class set on the glyph itself — so the tint has to
    // live on a parent for currentColor to inherit it.
    const glyph = (
      <span className={`inline-grid shrink-0 place-items-center ${className}`}>
        <Icon className={hero ? "size-8" : sizeClass} />
      </span>
    );
    return hero ? <div className={HERO_FRAME}>{glyph}</div> : glyph;
  }
  if (iconUrl && !failed) {
    return hero ? (
      // Clip on the wrapper, not the image: the asset's own corner radius is
      // whatever the brand ships, and this makes every hero agree.
      <div className={`${HERO_BOX} overflow-hidden`}>
        <img
          alt=""
          aria-hidden="true"
          className="size-14 object-contain"
          onError={() => setFailed(true)}
          src={iconUrl}
        />
      </div>
    ) : (
      <img
        alt=""
        aria-hidden="true"
        className={`${sizeClass} shrink-0 rounded-xs object-contain`}
        onError={() => setFailed(true)}
        src={iconUrl}
      />
    );
  }
  const fallback = (
    <AppWindow
      aria-label={title}
      className={`${hero ? "size-8" : sizeClass} shrink-0 text-muted-foreground`}
    />
  );
  return hero ? <div className={HERO_FRAME}>{fallback}</div> : fallback;
}
