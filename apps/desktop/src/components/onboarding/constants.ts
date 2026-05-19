import { createElement, type ReactElement } from "react";

export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  gmail: "Gmail",
  googlesheets: "Google Sheets",
  google: "Google",
  github: "GitHub",
  reddit: "Reddit",
  twitter: "Twitter / X",
  linkedin: "LinkedIn",
  hubspot: "HubSpot",
  attio: "Attio",
  calcom: "Cal.com",
  apollo: "Apollo.io",
  instantly: "Instantly",
  zoominfo: "ZoomInfo",
};

export function providerDisplayName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}

/**
 * Aliases mapping app_id (as used in the runtime catalog) to the canonical
 * provider key recognized by `providerIcon`. Add an entry whenever an app's
 * id and its brand-icon key diverge.
 */
const PROVIDER_ALIASES: Record<string, string> = {
  sheets: "googlesheets",
};

/**
 * Minimal brand-recognizable SVG icons for integration providers.
 * Each renders at the given size (default 20) with the provider's brand color.
 */
export function providerIcon(provider: string, size = 20): ReactElement | null {
  const s = String(size);
  const key = PROVIDER_ALIASES[provider] ?? provider;

  switch (key) {
    case "gmail":
      // Simplified envelope with Gmail red accent
      return createElement(
        "svg",
        { width: s, height: s, viewBox: "0 0 20 20", fill: "none", "aria-hidden": "true" },
        createElement("rect", { x: "2", y: "4", width: "16", height: "12", rx: "2", fill: "#EA4335" }),
        createElement("path", { d: "M2 6l8 5 8-5", stroke: "#fff", strokeWidth: "1.5", fill: "none" }),
        createElement("rect", { x: "2", y: "4", width: "16", height: "12", rx: "2", stroke: "#EA4335", strokeWidth: "0.5", fill: "none" }),
      );

    case "googlesheets":
      // Simplified spreadsheet grid with Sheets green
      return createElement(
        "svg",
        { width: s, height: s, viewBox: "0 0 20 20", fill: "none", "aria-hidden": "true" },
        createElement("rect", { x: "3", y: "2", width: "14", height: "16", rx: "2", fill: "#0F9D58" }),
        createElement("rect", { x: "5", y: "5", width: "10", height: "10", rx: "1", fill: "#fff" }),
        createElement("line", { x1: "5", y1: "8.5", x2: "15", y2: "8.5", stroke: "#0F9D58", strokeWidth: "0.75" }),
        createElement("line", { x1: "5", y1: "11.5", x2: "15", y2: "11.5", stroke: "#0F9D58", strokeWidth: "0.75" }),
        createElement("line", { x1: "10", y1: "5", x2: "10", y2: "15", stroke: "#0F9D58", strokeWidth: "0.75" }),
      );

    case "github":
      // GitHub octocat mark
      return createElement(
        "svg",
        { width: s, height: s, viewBox: "0 0 20 20", fill: "currentColor", "aria-hidden": "true" },
        createElement("path", {
          d: "M10 1.5a8.5 8.5 0 0 0-2.69 16.56c.43.08.58-.18.58-.4v-1.51c-2.38.52-2.88-1.01-2.88-1.01-.39-.99-.95-1.25-.95-1.25-.78-.53.06-.52.06-.52.86.06 1.31.88 1.31.88.76 1.31 2 .93 2.49.71.08-.55.3-.93.54-1.15-1.9-.21-3.9-.95-3.9-4.23 0-.93.33-1.7.88-2.3-.09-.21-.38-1.09.08-2.27 0 0 .72-.23 2.35.88a8.17 8.17 0 0 1 4.28 0c1.63-1.11 2.35-.88 2.35-.88.46 1.18.17 2.06.08 2.27.55.6.88 1.37.88 2.3 0 3.29-2 4.02-3.91 4.23.31.26.58.78.58 1.58v2.34c0 .22.15.49.59.4A8.5 8.5 0 0 0 10 1.5Z",
          fillRule: "evenodd",
        }),
      );

    case "reddit":
      // Reddit Snoo silhouette
      return createElement(
        "svg",
        { width: s, height: s, viewBox: "0 0 20 20", fill: "none", "aria-hidden": "true" },
        createElement("circle", { cx: "10", cy: "11", r: "7", fill: "#FF4500" }),
        createElement("circle", { cx: "7.5", cy: "10", r: "1.2", fill: "#fff" }),
        createElement("circle", { cx: "12.5", cy: "10", r: "1.2", fill: "#fff" }),
        createElement("path", { d: "M7.5 13c0 0 1.2 1.5 2.5 1.5s2.5-1.5 2.5-1.5", stroke: "#fff", strokeWidth: "0.75", fill: "none", strokeLinecap: "round" }),
        createElement("circle", { cx: "15", cy: "5", r: "1.5", fill: "#FF4500" }),
        createElement("line", { x1: "12", y1: "4", x2: "14", y2: "5", stroke: "#FF4500", strokeWidth: "1" }),
      );

    case "twitter":
      // X logo
      return createElement(
        "svg",
        { width: s, height: s, viewBox: "0 0 20 20", fill: "currentColor", "aria-hidden": "true" },
        createElement("path", { d: "M11.7 8.6 16.7 3h-1.2l-4.3 5L7.5 3H3l5.2 7.6L3 17h1.2l4.6-5.3L13 17h4.5L11.7 8.6Zm-1.6 1.9-.5-.8L4.8 4h1.8l3.5 5 .5.8 4.5 6.4h-1.8l-3.6-5.2-.5-.5Z" }),
      );

    case "linkedin":
      // LinkedIn "in" mark
      return createElement(
        "svg",
        { width: s, height: s, viewBox: "0 0 20 20", fill: "none", "aria-hidden": "true" },
        createElement("rect", { x: "2", y: "2", width: "16", height: "16", rx: "3", fill: "#0A66C2" }),
        createElement("path", { d: "M6.5 8.5v5M6.5 6v.5", stroke: "#fff", strokeWidth: "1.5", strokeLinecap: "round" }),
        createElement("path", { d: "M9.5 13.5v-3c0-1.1.9-2 2-2s2 .9 2 2v3", stroke: "#fff", strokeWidth: "1.5", strokeLinecap: "round", fill: "none" }),
      );

    case "calcom":
      // Cal.com — black rounded tile with white "Cal" wordmark.
      return createElement(
        "svg",
        { width: s, height: s, viewBox: "0 0 20 20", fill: "none", "aria-hidden": "true" },
        createElement("rect", { x: "1.5", y: "1.5", width: "17", height: "17", rx: "4", fill: "#000" }),
        createElement(
          "text",
          {
            x: "10",
            y: "13.5",
            textAnchor: "middle",
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
            fontSize: "8",
            fontWeight: "700",
            fill: "#fff",
            letterSpacing: "-0.5",
          },
          "Cal",
        ),
      );

    default:
      return null;
  }
}
