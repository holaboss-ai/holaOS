import { ProviderBrandIcon } from "@/lib/providerBrandIcon";
import { cn } from "@/lib/utils";

import { harnessBrand } from "./harnessBrand";

/**
 * Per-harness favicon — one source of truth so the agents list, the picker,
 * and the chat avatar all show the same mark. Tiers:
 *   1. Full-colour vendor logos (none currently) render the actual favicon
 *      edge-to-edge — they carry their own background + shape.
 *   2. Monochrome provider marks in a neutral tile: pi → Hola, claude-code →
 *      Anthropic, codex → OpenAI (via the provider-icon set).
 *   3. Any unmapped id falls back to a brand-coloured monogram tile.
 *
 * All marks are bundled identifying logos (same nominative use as the existing
 * `@/assets/providers/*.svg`), sourced as real SVGs, never redrawn.
 */
export type HarnessIconSize = "xs" | "sm" | "md" | "lg";

/** Full-colour vendor logos (carry their own background + shape, so they
 *  render edge-to-edge rather than inside a neutral tile). */
const HARNESS_LOGO: Record<string, string> = {};

/** Monochrome (currentColor) marks rendered inside a neutral tile, alongside
 *  the provider marks. The vendor's logo is a single-colour glyph with no
 *  background of its own. */
const HARNESS_MONO_MARK: Record<string, string> = {};

interface Monogram {
  letter: string;
  /** Tile background tint (Tailwind needs literal class strings). */
  bg: string;
  /** Letter colour, light + dark. */
  text: string;
}

// Every shipped harness now has a real mark; the monogram path is kept as the
// generic fallback for any future / unmapped id (see monogramFor).
const HARNESS_MONOGRAM: Record<string, Monogram> = {};

const TILE_BY_SIZE: Record<HarnessIconSize, string> = {
  xs: "size-5 rounded",
  sm: "size-6 rounded-md",
  md: "size-7 rounded-md",
  lg: "size-8 rounded-lg",
};

// ~70% of the tile box — optically matches the full-bleed AgentAvatar face
// that pi/Hola renders at the same box size (a bare glyph at 60% read much
// smaller next to it).
const MARK_BY_SIZE: Record<HarnessIconSize, string> = {
  xs: "size-3.5",
  sm: "size-4",
  md: "size-[18px]",
  lg: "size-5",
};

const LETTER_BY_SIZE: Record<HarnessIconSize, string> = {
  xs: "text-[9px]",
  sm: "text-[10px]",
  md: "text-[11px]",
  lg: "text-xs",
};

/** Whether this harness has a dedicated favicon (provider mark, vendor logo,
 *  or monogram). False for pi/Hola and genuinely unknown ids, which callers
 *  may prefer to render as a generated avatar instead. */
export function harnessHasFavicon(id: string): boolean {
  if (HARNESS_LOGO[id] || HARNESS_MONO_MARK[id] || HARNESS_MONOGRAM[id]) {
    return true;
  }
  const brand = harnessBrand(id);
  return brand === "anthropic" || brand === "openai";
}

function providerMark(id: string): "anthropic" | "openai" | "holaboss" | null {
  if (HARNESS_LOGO[id] || HARNESS_MONO_MARK[id] || HARNESS_MONOGRAM[id]) {
    return null;
  }
  const brand = harnessBrand(id);
  return brand === "anthropic" || brand === "openai" || brand === "holaboss"
    ? brand
    : null;
}

function monogramFor(id: string, name: string | undefined): Monogram {
  return (
    HARNESS_MONOGRAM[id] ?? {
      letter: (name ?? id).charAt(0).toUpperCase() || "?",
      bg: "bg-fg-4",
      text: "text-foreground/70",
    }
  );
}

/** Inline a static vendored SVG so it fills its box. Same trusted-markup
 *  pattern as ProviderBrandIcon (assets are bundled, never user input). */
function SvgLogo({ markup, className }: { markup: string; className: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block overflow-hidden [&_svg]:size-full", className)}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

export function HarnessIcon({
  id,
  name,
  size = "md",
  bare = false,
  className,
}: {
  id: string;
  name?: string;
  size?: HarnessIconSize;
  /** Render just the mark (no neutral tile) for inline use next to text. */
  bare?: boolean;
  className?: string;
}) {
  const logo = HARNESS_LOGO[id];
  const monoMark = HARNESS_MONO_MARK[id];
  const mark = providerMark(id);

  // Tier 1 — full-colour vendor logo, edge-to-edge (it brings its own bg).
  if (logo) {
    return (
      <SvgLogo
        markup={logo}
        className={cn(bare ? cn(MARK_BY_SIZE[size], "rounded-sm") : TILE_BY_SIZE[size], className)}
      />
    );
  }

  // Tier 2 — monochrome mark (vendored SVG or provider icon) in a neutral tile.
  if (monoMark) {
    if (bare) {
      return (
        <SvgLogo markup={monoMark} className={cn(MARK_BY_SIZE[size], "text-foreground", className)} />
      );
    }
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex shrink-0 items-center justify-center border border-border/60 bg-fg-2 text-foreground",
          TILE_BY_SIZE[size],
          className,
        )}
      >
        <SvgLogo markup={monoMark} className={MARK_BY_SIZE[size]} />
      </span>
    );
  }
  if (mark) {
    if (bare) {
      return <ProviderBrandIcon brand={mark} className={cn(MARK_BY_SIZE[size], className)} />;
    }
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex shrink-0 items-center justify-center border border-border/60 bg-fg-2",
          TILE_BY_SIZE[size],
          className,
        )}
      >
        <ProviderBrandIcon brand={mark} className={MARK_BY_SIZE[size]} />
      </span>
    );
  }

  // Tier 3 — monogram.
  const mono = monogramFor(id, name);
  if (bare) {
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex items-center justify-center font-semibold leading-none",
          LETTER_BY_SIZE[size],
          mono.text,
          className,
        )}
      >
        {mono.letter}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-semibold leading-none",
        TILE_BY_SIZE[size],
        LETTER_BY_SIZE[size],
        mono.bg,
        mono.text,
        className,
      )}
    >
      {mono.letter}
    </span>
  );
}
