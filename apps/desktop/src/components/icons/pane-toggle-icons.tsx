import type { SVGProps } from "react";

/**
 * Layout-mode picker icon — matches lucide's `Panel*` family in stroke
 * style and proportion (divider at the same 1:2 boundary as `PanelLeft`
 * / `PanelRight` — x=9 / x=15). Visible panes carry a low-opacity fill
 * on their half; hidden panes are left empty.
 *
 *   split      — divider at x=12, BOTH halves filled (both panes
 *                visible and balanced).
 *   focus_chat — divider at x=9, only right half filled (chat
 *                dominant; workspace collapsed).
 *   focus_work — divider at x=15, only left half filled (workspace
 *                dominant; chat collapsed).
 *
 * Three distinct geometries (different divider positions) + filled
 * sides keep the icons readable at 16px without labels.
 */

export type LayoutMode = "split" | "focus_chat" | "focus_work";

interface LayoutModeIconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  mode: LayoutMode;
}

// Match lucide's default stroke width / linecap / linejoin so this
// icon sits flush with the rest of the lucide icons in the titlebar
// (Home, Plus, Settings, etc.) — those all ship with strokeWidth=2.
const ICON_BASE_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

// Half-panel paths trace the outer frame's 2px corner radius so each
// filled side's outside corners match the frame; the inner edge
// against the divider stays square. Path string is parameterized by
// the divider's x so each mode's halves line up with its divider.
const buildLeftHalfFillPath = (dividerX: number) =>
  `M ${dividerX} 3 L 5 3 A 2 2 0 0 0 3 5 L 3 19 A 2 2 0 0 0 5 21 L ${dividerX} 21 Z`;
const buildRightHalfFillPath = (dividerX: number) =>
  `M ${dividerX} 3 L 19 3 A 2 2 0 0 1 21 5 L 21 19 A 2 2 0 0 1 19 21 L ${dividerX} 21 Z`;

export function LayoutModeIcon({ mode, ...rest }: LayoutModeIconProps) {
  const dividerX = mode === "focus_chat" ? 9 : mode === "focus_work" ? 15 : 12;
  // Each half is shown when its pane is visible: split = both,
  // focus_chat = right only (chat), focus_work = left only (work).
  const showLeftFill = mode === "split" || mode === "focus_work";
  const showRightFill = mode === "split" || mode === "focus_chat";
  return (
    <svg {...ICON_BASE_PROPS} {...rest}>
      {showLeftFill ? (
        <path
          d={buildLeftHalfFillPath(dividerX)}
          fill="currentColor"
          fillOpacity={0.22}
          stroke="none"
        />
      ) : null}
      {showRightFill ? (
        <path
          d={buildRightHalfFillPath(dividerX)}
          fill="currentColor"
          fillOpacity={0.22}
          stroke="none"
        />
      ) : null}
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d={`M${dividerX} 3v18`} />
    </svg>
  );
}
