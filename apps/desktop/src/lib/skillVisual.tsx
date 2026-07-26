import { addCollection } from "@iconify/react";
import phCollection from "@iconify-json/ph/icons.json";

// Register Phosphor once (idempotent) so `ph:*-fill` names resolve offline —
// the same solid, glyph-forward set the workspace icons use.
addCollection(phCollection as Parameters<typeof addCollection>[0]);

/**
 * Per-skill solid glyph (Phosphor Fill), so the store reads as a varied,
 * scannable catalog instead of a wall of identical feathers. Keyed by the
 * marketplace skill id, with a category-level fallback for anything new.
 */
const SKILL_ICON: Record<string, string> = {
  // writing
  "content-writer": "ph:pen-nib-fill",
  copywriting: "ph:pencil-fill",
  "tone-adapter": "ph:sliders-horizontal-fill",
  translator: "ph:translate-fill",
  "idea-generator": "ph:lightbulb-fill",
  "content-strategy": "ph:compass-fill",
  social: "ph:share-network-fill",
  "linkedin-posts": "ph:linkedin-logo-fill",
  "reddit-posts": "ph:reddit-logo-fill",
  "tiktok-captions": "ph:tiktok-logo-fill",
  "video-marketing": "ph:video-camera-fill",
  "short-video-scripter": "ph:film-slate-fill",
  "youtube-scriptwriter": "ph:youtube-logo-fill",
  "email-marketing": "ph:envelope-fill",
  "email-writer": "ph:paper-plane-tilt-fill",
  "internal-comms": "ph:megaphone-fill",
  "doc-coauthoring": "ph:file-text-fill",
  "seo-content-writer": "ph:article-fill",
  "ai-seo": "ph:robot-fill",
  "proposal-writer": "ph:scroll-fill",
  // research
  "web-researcher": "ph:magnifying-glass-fill",
  "trend-spotter": "ph:trend-up-fill",
  "keyword-research": "ph:key-fill",
  "seo-content-brief": "ph:clipboard-text-fill",
  "seo-keyword-cluster": "ph:tree-structure-fill",
  // analysis
  "audience-analyst": "ph:users-three-fill",
  "performance-reporter": "ph:chart-bar-fill",
  "seo-ai-social-report": "ph:chart-line-up-fill",
  "seo-gaps-to-social-campaign": "ph:target-fill",
  "site-audit-to-social-distribution": "ph:magnifying-glass-plus-fill",
  xlsx: "ph:table-fill",
  "data-analyst": "ph:chart-pie-slice-fill",
  // productivity
  "image-generator": "ph:image-fill",
  "image-editor": "ph:magic-wand-fill",
  "thumbnail-designer": "ph:image-square-fill",
  "video-storyboarder": "ph:film-strip-fill",
  "deck-builder": "ph:presentation-fill",
  "pitch-deck-writer": "ph:rocket-launch-fill",
  "slide-designer": "ph:layout-fill",
  "content-planner": "ph:calendar-dots-fill",
  summarizer: "ph:note-fill",
  pdf: "ph:file-pdf-fill",
  docx: "ph:file-doc-fill",
  pptx: "ph:presentation-chart-fill",
  "brand-guidelines": "ph:palette-fill",
  "canvas-design": "ph:paint-brush-fill",
  "meeting-notes": "ph:calendar-check-fill",
  "prd-writer": "ph:list-checks-fill",
};

const CATEGORY_ICON: Record<string, string> = {
  writing: "ph:pen-nib-fill",
  marketing: "ph:megaphone-fill",
  research: "ph:magnifying-glass-fill",
  analysis: "ph:chart-bar-fill",
  productivity: "ph:sparkle-fill",
};

export function getSkillIcon(
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
  return SKILL_ICON[id] ?? CATEGORY_ICON[key] ?? "ph:feather-fill";
}
