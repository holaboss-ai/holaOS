import type { ReactNode } from "react";

type GlyphProps = {
  className?: string;
  size?: number;
  resolution?: number;
  dotRadius?: number;
};

type ComputeFn = (x: number, y: number) => number | null;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function buildDots(
  cols: number,
  size: number,
  dotRadius: number,
  compute: ComputeFn,
): ReactNode[] {
  const step = size / cols;
  const dots: ReactNode[] = [];
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < cols; y++) {
      const raw = compute(x, y);
      if (raw === null) continue;
      const op = clamp01(raw);
      if (op < 0.04) continue;
      dots.push(
        <circle
          cx={x * step + step / 2}
          cy={y * step + step / 2}
          fillOpacity={op}
          key={`${x}-${y}`}
          r={dotRadius}
        />,
      );
    }
  }
  return dots;
}

function GlyphSvg({
  children,
  className,
  size,
  title,
}: {
  children: ReactNode;
  className?: string;
  size: number;
  title: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{title}</title>
      {children}
    </svg>
  );
}

/** Dotted square with a horizontal fade toward the right edge.
 *  Matches the "Block trades" glyph from the reference. */
export function DotGridSquare({
  className,
  dotRadius = 1.1,
  resolution = 22,
  size = 128,
}: GlyphProps) {
  const midY = (resolution - 1) / 2;
  const dots = buildDots(resolution, size, dotRadius, (x, y) => {
    const horiz = x / (resolution - 1);
    const vertDim = 1 - (Math.abs(y - midY) / midY) * 0.35;
    return horiz ** 1.15 * vertDim;
  });
  return (
    <GlyphSvg className={className} size={size} title="Dotted grid square">
      {dots}
    </GlyphSvg>
  );
}

/** Dotted disc with a lit top-right and a shadowed crescent in the lower-right.
 *  Matches the "Margin financing" globe glyph from the reference. */
export function DotSphere({
  className,
  dotRadius = 1.1,
  resolution = 26,
  size = 128,
}: GlyphProps) {
  const center = (resolution - 1) / 2;
  const radius = resolution / 2 - 0.5;
  const lightX = resolution - 1;
  const lightY = 0;
  const shadowX = center + radius * 0.38;
  const shadowY = center + radius * 0.2;
  const shadowRadius = radius * 0.52;
  const dots = buildDots(resolution, size, dotRadius, (x, y) => {
    const dist = Math.hypot(x - center, y - center);
    if (dist > radius) return null;
    const lightDist = Math.hypot(x - lightX, y - lightY) / (resolution * 1.05);
    const base = 1 - lightDist * 0.9;
    const shadowDist = Math.hypot(x - shadowX, y - shadowY);
    const shadowDim =
      shadowDist < shadowRadius
        ? 0.2 + (shadowDist / shadowRadius) * 0.55
        : 1;
    return base * shadowDim;
  });
  return (
    <GlyphSvg className={className} size={size} title="Dotted sphere">
      {dots}
    </GlyphSvg>
  );
}

/** Right-triangle wedge anchored at the bottom-right, brightest along the vertical right edge.
 *  Matches the "Asset management" wedge glyph from the reference. */
export function DotWedge({
  className,
  dotRadius = 1.1,
  resolution = 24,
  size = 128,
}: GlyphProps) {
  const dots = buildDots(resolution, size, dotRadius, (x, y) => {
    if (x + y < resolution - 1) return null;
    const rightDist = resolution - 1 - x;
    return 1 - rightDist / (resolution * 0.8);
  });
  return (
    <GlyphSvg className={className} size={size} title="Dotted wedge">
      {dots}
    </GlyphSvg>
  );
}

/** Dotted ring with angular light falloff — a quieter, circular counterpart to the sphere. */
export function DotRing({
  className,
  dotRadius = 1.1,
  resolution = 26,
  size = 128,
}: GlyphProps) {
  const center = (resolution - 1) / 2;
  const outer = resolution / 2 - 0.5;
  const inner = outer * 0.58;
  const dots = buildDots(resolution, size, dotRadius, (x, y) => {
    const dist = Math.hypot(x - center, y - center);
    if (dist > outer || dist < inner) return null;
    const angle = Math.atan2(y - center, x - center);
    const t = (Math.cos(angle + Math.PI * 0.75) + 1) / 2;
    return 0.2 + t * 0.9;
  });
  return (
    <GlyphSvg className={className} size={size} title="Dotted ring">
      {dots}
    </GlyphSvg>
  );
}

/** Diamond (rotated square) with a diagonal bias — lit from the top-right. */
export function DotDiamond({
  className,
  dotRadius = 1.1,
  resolution = 24,
  size = 128,
}: GlyphProps) {
  const center = (resolution - 1) / 2;
  const half = resolution / 2 - 0.5;
  const dots = buildDots(resolution, size, dotRadius, (x, y) => {
    const dx = Math.abs(x - center);
    const dy = Math.abs(y - center);
    if (dx + dy > half) return null;
    const bias = (x + (resolution - 1 - y)) / (2 * (resolution - 1));
    const core = 1 - (dx + dy) / half;
    return (0.3 + core * 0.65) * (0.35 + bias * 0.75);
  });
  return (
    <GlyphSvg className={className} size={size} title="Dotted diamond">
      {dots}
    </GlyphSvg>
  );
}

/** Quarter-arc pivoted at the bottom-left — sweep rises clockwise from horizontal to vertical. */
export function DotArc({
  className,
  dotRadius = 1.1,
  resolution = 26,
  size = 128,
}: GlyphProps) {
  const pivotX = 0;
  const pivotY = resolution - 1;
  const outer = resolution - 2;
  const inner = outer * 0.62;
  const dots = buildDots(resolution, size, dotRadius, (x, y) => {
    const dist = Math.hypot(x - pivotX, y - pivotY);
    if (dist > outer || dist < inner) return null;
    const angle = Math.atan2(pivotY - y, x - pivotX);
    if (angle < 0 || angle > Math.PI / 2) return null;
    const t = angle / (Math.PI / 2);
    return 0.28 + t * 0.75;
  });
  return (
    <GlyphSvg className={className} size={size} title="Dotted arc">
      {dots}
    </GlyphSvg>
  );
}

/** Horizontal bar of dots with a gradient fade — suggests flow / velocity. */
export function DotBar({
  className,
  dotRadius = 1.1,
  resolution = 26,
  size = 128,
}: GlyphProps) {
  const barTop = Math.floor(resolution * 0.38);
  const barBottom = Math.floor(resolution * 0.62);
  const dots = buildDots(resolution, size, dotRadius, (x, y) => {
    if (y < barTop || y > barBottom) return null;
    const midBar = (barTop + barBottom) / 2;
    const vert = 1 - Math.abs(y - midBar) / ((barBottom - barTop) / 2);
    const horiz = x / (resolution - 1);
    return horiz ** 0.9 * (0.4 + vert * 0.7);
  });
  return (
    <GlyphSvg className={className} size={size} title="Dotted bar">
      {dots}
    </GlyphSvg>
  );
}
