import { addCollection } from "@iconify/react";
import phCollection from "@iconify-json/ph/icons.json";

// Idempotent Phosphor registration so `ph:*-fill` names resolve offline.
addCollection(phCollection as Parameters<typeof addCollection>[0]);

/**
 * Per-capability solid glyph (Phosphor Fill) for the browse grid + detail hero,
 * so capabilities read as a calm, consistent list like the skills store. Brand
 * logos stay reserved for the Recommended hero cards. Keyed by capability id
 * with a category fallback.
 */
const CAPABILITY_ICON: Record<string, string> = {
  // legacy / bundles
  "marketing-suite": "ph:megaphone-fill",
  "answer-engine-seo": "ph:robot-fill",
  "social-growth": "ph:trend-up-fill",
  "seo-to-social": "ph:arrows-clockwise-fill",
  "competitor-watch": "ph:binoculars-fill",
  "inbox-triage": "ph:tray-fill",
  "content-repurposer": "ph:arrows-clockwise-fill",
  "linkedin-ghostwriter": "ph:pen-nib-fill",
  // content
  "content-strategist": "ph:compass-fill",
  copywriter: "ph:pencil-fill",
  localizer: "ph:translate-fill",
  "linkedin-writer": "ph:briefcase-fill",
  "short-video-scripter": "ph:video-camera-fill",
  // marketing
  "social-media-manager": "ph:share-network-fill",
  "reddit-marketer": "ph:chat-circle-dots-fill",
  "email-campaigns": "ph:envelope-fill",
  "newsletter-builder": "ph:newspaper-fill",
  "audience-insights": "ph:users-three-fill",
  // seo
  "seo-writer": "ph:magnifying-glass-fill",
  "seo-brief-builder": "ph:clipboard-text-fill",
  "keyword-clusters": "ph:tree-structure-fill",
  "cross-channel-report": "ph:chart-line-up-fill",
  // research
  "deep-research": "ph:books-fill",
  "trend-radar": "ph:trend-up-fill",
  // documents
  "doc-co-author": "ph:file-text-fill",
  "spreadsheet-autopilot": "ph:table-fill",
  "deck-builder": "ph:presentation-chart-fill",
  "pdf-toolkit": "ph:file-pdf-fill",
  "doc-generator": "ph:file-doc-fill",
  "data-studio": "ph:chart-pie-slice-fill",
  // design
  "brand-kit": "ph:palette-fill",
  "canvas-designer": "ph:paint-brush-fill",
  "image-studio": "ph:image-fill",
  // productivity
  "team-comms": "ph:megaphone-fill",
  "meeting-assistant": "ph:calendar-check-fill",
  "email-assistant": "ph:paper-plane-tilt-fill",
  "proposal-studio": "ph:scroll-fill",
  "prd-builder": "ph:list-checks-fill",
};

const CATEGORY_ICON: Record<string, string> = {
  content: "ph:pen-nib-fill",
  marketing: "ph:megaphone-fill",
  seo: "ph:magnifying-glass-fill",
  research: "ph:books-fill",
  documents: "ph:file-text-fill",
  design: "ph:palette-fill",
  productivity: "ph:sparkle-fill",
  social: "ph:share-network-fill",
  analysis: "ph:chart-bar-fill",
};

export function getCapabilityIcon(
  id: string,
  category?: string,
  served?: string | null
): string {
  // The backend catalog is the source of truth for the glyph; the local map is
  // a fallback for ids it hasn't populated.
  if (served?.startsWith("ph:")) {
    return served;
  }
  const key = category?.trim().toLowerCase() ?? "";
  return CAPABILITY_ICON[id] ?? CATEGORY_ICON[key] ?? "ph:cube-fill";
}
