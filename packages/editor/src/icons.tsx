// Inline SVG icons (lucide-style, 24x24 viewBox, currentColor stroke).
// Kept in this package so consumers don't need to wire an icon set.
// Sized through the parent's `font-size` via `1em` width/height.

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const base = (extra?: Partial<SVGProps<SVGSVGElement>>): SVGProps<SVGSVGElement> => ({
  width: "1em",
  height: "1em",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  ...extra,
});

export const IconBold = (p: IconProps) => (
  <svg {...base()} {...p}>
    <path d="M6 4h8a4 4 0 0 1 0 8H6z" />
    <path d="M6 12h9a4 4 0 0 1 0 8H6z" />
  </svg>
);

export const IconItalic = (p: IconProps) => (
  <svg {...base()} {...p}>
    <line x1="19" y1="4" x2="10" y2="4" />
    <line x1="14" y1="20" x2="5" y2="20" />
    <line x1="15" y1="4" x2="9" y2="20" />
  </svg>
);

export const IconUnderline = (p: IconProps) => (
  <svg {...base()} {...p}>
    <path d="M6 4v6a6 6 0 0 0 12 0V4" />
    <line x1="4" y1="20" x2="20" y2="20" />
  </svg>
);

export const IconStrike = (p: IconProps) => (
  <svg {...base()} {...p}>
    <path d="M16 4H9a3 3 0 0 0-2.83 4" />
    <path d="M14 12a4 4 0 0 1 0 8H6" />
    <line x1="4" y1="12" x2="20" y2="12" />
  </svg>
);

export const IconCode = (p: IconProps) => (
  <svg {...base()} {...p}>
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </svg>
);

export const IconLink = (p: IconProps) => (
  <svg {...base()} {...p}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
);

export const IconText = (p: IconProps) => (
  <svg {...base()} {...p}>
    <polyline points="4 7 4 4 20 4 20 7" />
    <line x1="9" y1="20" x2="15" y2="20" />
    <line x1="12" y1="4" x2="12" y2="20" />
  </svg>
);

export const IconHeading1 = (p: IconProps) => (
  <svg {...base()} {...p}>
    <path d="M4 12h8" />
    <path d="M4 18V6" />
    <path d="M12 18V6" />
    <path d="M17 12l3-2v8" />
  </svg>
);

export const IconHeading2 = (p: IconProps) => (
  <svg {...base()} {...p}>
    <path d="M4 12h8" />
    <path d="M4 18V6" />
    <path d="M12 18V6" />
    <path d="M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1" />
  </svg>
);

export const IconHeading3 = (p: IconProps) => (
  <svg {...base()} {...p}>
    <path d="M4 12h8" />
    <path d="M4 18V6" />
    <path d="M12 18V6" />
    <path d="M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2" />
    <path d="M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2" />
  </svg>
);

export const IconList = (p: IconProps) => (
  <svg {...base()} {...p}>
    <line x1="8" y1="6" x2="21" y2="6" />
    <line x1="8" y1="12" x2="21" y2="12" />
    <line x1="8" y1="18" x2="21" y2="18" />
    <line x1="3" y1="6" x2="3.01" y2="6" />
    <line x1="3" y1="12" x2="3.01" y2="12" />
    <line x1="3" y1="18" x2="3.01" y2="18" />
  </svg>
);

export const IconListOrdered = (p: IconProps) => (
  <svg {...base()} {...p}>
    <line x1="10" y1="6" x2="21" y2="6" />
    <line x1="10" y1="12" x2="21" y2="12" />
    <line x1="10" y1="18" x2="21" y2="18" />
    <path d="M4 6h1v4" />
    <path d="M4 10h2" />
    <path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />
  </svg>
);

export const IconListChecks = (p: IconProps) => (
  <svg {...base()} {...p}>
    <path d="m3 17 2 2 4-4" />
    <path d="m3 7 2 2 4-4" />
    <line x1="13" y1="6" x2="21" y2="6" />
    <line x1="13" y1="12" x2="21" y2="12" />
    <line x1="13" y1="18" x2="21" y2="18" />
  </svg>
);

export const IconQuote = (p: IconProps) => (
  <svg {...base()} {...p}>
    <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z" />
    <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z" />
  </svg>
);

export const IconCodeBlock = (p: IconProps) => (
  <svg {...base()} {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <polyline points="10 10 7 13 10 16" />
    <polyline points="14 10 17 13 14 16" />
  </svg>
);

export const IconDivider = (p: IconProps) => (
  <svg {...base()} {...p}>
    <line x1="3" y1="12" x2="21" y2="12" />
  </svg>
);

export const IconTable = (p: IconProps) => (
  <svg {...base()} {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="3" y1="9" x2="21" y2="9" />
    <line x1="3" y1="15" x2="21" y2="15" />
    <line x1="9" y1="3" x2="9" y2="21" />
    <line x1="15" y1="3" x2="15" y2="21" />
  </svg>
);

export const IconChevronDown = (p: IconProps) => (
  <svg {...base({ strokeWidth: 2.5 })} {...p}>
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

export const IconChevronRight = (p: IconProps) => (
  <svg {...base({ strokeWidth: 2.5 })} {...p}>
    <polyline points="9 6 15 12 9 18" />
  </svg>
);

export const IconPlus = (p: IconProps) => (
  <svg {...base({ strokeWidth: 2.25 })} {...p}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export const IconCopy = (p: IconProps) => (
  <svg {...base()} {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

export const IconTrash = (p: IconProps) => (
  <svg {...base()} {...p}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </svg>
);

export const IconCheck = (p: IconProps) => (
  <svg {...base({ strokeWidth: 2.5 })} {...p}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export const IconGrip = (p: IconProps) => (
  <svg {...base()} {...p}>
    <circle cx="9" cy="6" r="1.25" />
    <circle cx="9" cy="12" r="1.25" />
    <circle cx="9" cy="18" r="1.25" />
    <circle cx="15" cy="6" r="1.25" />
    <circle cx="15" cy="12" r="1.25" />
    <circle cx="15" cy="18" r="1.25" />
  </svg>
);
