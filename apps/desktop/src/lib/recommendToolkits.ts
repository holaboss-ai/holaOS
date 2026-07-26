/**
 * Pick a handful of Composio toolkits to suggest when a workspace hasn't
 * connected any integrations yet.
 *
 * The renderer doesn't have AGENTS.md / template metadata, so the scorer
 * is intentionally narrow:
 *
 *   1. Start with a hand-picked "starter pack" — the toolkits almost every
 *      workspace eventually wants. Ordered roughly by general utility.
 *   2. Fill any remaining slots from the rest of the catalog so we always
 *      surface a full row even if a starter slug isn't published.
 *   3. If the workspace name/lab_purpose mentions something specific
 *      ("email triage", "twitter agent"), bubble matching toolkits up
 *      via the alias map below + tag/description scoring. Stable sort so
 *      ties keep the starter ordering.
 *
 * Deterministic — no LLM, no network. Pure function over the Composio
 * toolkit list already loaded in `useWorkspaceDesktop`.
 */

import type { ComposioToolkitMetadata } from "@/lib/workspaceDesktop";

// Workspace-hint tokens that map to a canonical Composio toolkit slug.
// "email" / "inbox" → "gmail" so a workspace called "Email triage" finds
// the right toolkit even though its description doesn't say "gmail".
const HINT_ALIASES: Record<string, string> = {
  email: "gmail",
  mail: "gmail",
  inbox: "gmail",
  calendar: "googlecalendar",
  cal: "googlecalendar",
  sheet: "googlesheets",
  sheets: "googlesheets",
  spreadsheet: "googlesheets",
  doc: "googledocs",
  docs: "googledocs",
  tweet: "twitter",
  repo: "github",
  git: "github",
  pr: "github",
  issue: "github",
  social: "twitter",
  marketing: "twitter",
  note: "notion",
  notes: "notion",
  wiki: "notion",
  message: "slack",
  messaging: "slack",
};

// Ordered by "almost every workspace eventually wants this." Canonical
// Composio slugs — callers should normalize their providers through
// composioToolkitSlugForProvider() before matching.
const STARTER_SLUGS = [
  "gmail",
  "googlecalendar",
  "github",
  "notion",
  "slack",
  "googlesheets",
  "googledocs",
  "twitter",
  "linkedin",
  "reddit",
];

interface RecommendOptions {
  toolkits: readonly ComposioToolkitMetadata[];
  /** Canonical Composio slugs of toolkits the user has already connected. */
  connectedSlugs: ReadonlySet<string>;
  /** Free-form workspace context — usually `workspace.name` + `lab_purpose`. */
  workspaceHint?: string | null;
  /** Max number of toolkits to return. Defaults to 6. */
  limit?: number;
}

export function recommendToolkits({
  toolkits,
  connectedSlugs,
  workspaceHint,
  limit = 6,
}: RecommendOptions): ComposioToolkitMetadata[] {
  const available = toolkits.filter(
    (kit) => !connectedSlugs.has(kit.slug.toLowerCase()),
  );
  if (available.length === 0) return [];

  // Build a slug-keyed index so STARTER_SLUGS and HINT_ALIASES can resolve
  // against either the canonical slug or a slugified display name (the
  // marketplace sometimes ships toolkits whose slug differs from what
  // users would naturally type).
  const bySlug = new Map<string, ComposioToolkitMetadata>();
  for (const kit of available) {
    const keys = [kit.slug, kit.name.replace(/\s+/g, "")]
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    for (const k of keys) {
      if (!bySlug.has(k)) bySlug.set(k, kit);
    }
  }

  const seen = new Set<string>();
  const picked: ComposioToolkitMetadata[] = [];

  // Starter pack, in order.
  for (const slug of STARTER_SLUGS) {
    if (picked.length >= limit) break;
    const kit = bySlug.get(slug);
    if (kit && !seen.has(kit.slug)) {
      picked.push(kit);
      seen.add(kit.slug);
    }
  }

  // Top-up from anything else, preserving catalog order — keeps the
  // recommendation row full even for small marketplaces.
  if (picked.length < limit) {
    for (const kit of available) {
      if (picked.length >= limit) break;
      if (!seen.has(kit.slug)) {
        picked.push(kit);
        seen.add(kit.slug);
      }
    }
  }

  const hint = (workspaceHint ?? "").trim().toLowerCase();
  if (!hint) return picked;

  // Tokenize the hint and expand via HINT_ALIASES. Short tokens are
  // skipped because words like "the" / "my" / "an" would otherwise
  // match every description in the catalog.
  const tokens = new Set<string>();
  for (const raw of hint.split(/[^a-z0-9]+/i)) {
    const t = raw.toLowerCase();
    if (t.length < 3) continue;
    tokens.add(t);
    const aliased = HINT_ALIASES[t];
    if (aliased) tokens.add(aliased);
  }
  if (tokens.size === 0) return picked;

  function score(kit: ComposioToolkitMetadata): number {
    const haystack = [kit.name, kit.description, kit.slug, ...kit.categories]
      .join(" ")
      .toLowerCase();
    let n = 0;
    for (const t of tokens) {
      if (haystack.includes(t)) n += 1;
    }
    return n;
  }

  // Decorate-sort-undecorate keeps the result stable: ties fall back to
  // the prior (starter-pack) ordering.
  return picked
    .map((kit, originalIndex) => ({
      kit,
      originalIndex,
      score: score(kit),
    }))
    .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex)
    .map((x) => x.kit);
}
