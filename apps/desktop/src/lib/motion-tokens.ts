// Mirrors --duration-* and --ease-* in styles/tokens.css so framer-motion
// stays in lockstep with the CSS side. Durations are seconds (framer's unit).

export const easings = {
  standard: [0.32, 0.08, 0.24, 1] as const,
  outQuint: [0.22, 1, 0.36, 1] as const,
  emphasized: [0.32, 0.72, 0, 1] as const,
  outExpo: [0.16, 1, 0.3, 1] as const,
} as const;

export const durations = {
  fast: 0.12,
  tap: 0.14,
  quick: 0.16,
  snappy: 0.18,
  base: 0.22,
  stride: 0.24,
  slow: 0.36,
} as const;
