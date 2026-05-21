/**
 * Holaboss Integration Store catalog — the curated list of Composio
 * toolkits we expose to users in Settings → Integrations and let the
 * agent reach.
 *
 * PM brief (`docs/pm/integration-store-user-flow.md`) defines this scope:
 *  - Domain: tech + marketing only. HR / legal / finance / vertical
 *    industries don't enter the catalog at all (not "Tier 2 long-tail"
 *    — just don't do).
 *  - Tier `hero` (~15-20): hand-curated tool sets + polished descriptions
 *    + first-run scripts. Used to power onboarding recommendations.
 *  - Tier `supported` (the rest of in-scope, ~100-200): auto-discovered
 *    via Composio /tools endpoint, heuristic top-N.
 *
 * Anything outside this catalog is hidden from the store and ignored by
 * the agent runtime — connecting it would be a dead-end UX.
 *
 * Add a row here to expose a new toolkit to users. Hero promotion needs
 * a matching entry in TOOLKIT_CATALOG (composio-tool-registry.ts).
 */

export type StoreTier = "hero" | "supported";

export type StoreCategory =
  | "dev"
  | "comm"
  | "ci_cloud"
  | "db"
  | "observability"
  | "ai_data"
  | "social"
  | "email"
  | "analytics"
  | "crm"
  | "ads"
  | "seo"
  | "cms"
  | "design"
  | "forms"
  | "calendar"
  | "commerce"
  | "video"
  | "productivity";

export interface StoreCatalogEntry {
  slug: string;
  tier: StoreTier;
  category: StoreCategory;
}

const RAW_ENTRIES: StoreCatalogEntry[] = [
  // ───── Hero ─────────────────────────────────────────────────────
  // Onboarding recommendations + workspace-create wizard pull from this set.
  { slug: "gmail", tier: "hero", category: "email" },
  { slug: "googlecalendar", tier: "hero", category: "calendar" },
  { slug: "googledrive", tier: "hero", category: "productivity" },
  { slug: "slack", tier: "hero", category: "comm" },
  { slug: "notion", tier: "hero", category: "productivity" },
  { slug: "linear", tier: "hero", category: "dev" },
  { slug: "github", tier: "hero", category: "dev" },
  { slug: "twitter", tier: "hero", category: "social" },
  { slug: "linkedin", tier: "hero", category: "social" },
  { slug: "reddit", tier: "hero", category: "social" },
  { slug: "hubspot", tier: "hero", category: "crm" },
  { slug: "stripe", tier: "hero", category: "commerce" },
  { slug: "shopify", tier: "hero", category: "commerce" },
  { slug: "mailchimp", tier: "hero", category: "email" },
  { slug: "figma", tier: "hero", category: "design" },

  // ───── Supported: tech ─────────────────────────────────────────
  { slug: "gitlab", tier: "supported", category: "dev" },
  { slug: "jira", tier: "supported", category: "dev" },
  { slug: "asana", tier: "supported", category: "dev" },
  { slug: "confluence", tier: "supported", category: "dev" },
  { slug: "clickup", tier: "supported", category: "dev" },
  { slug: "trello", tier: "supported", category: "dev" },
  { slug: "monday", tier: "supported", category: "dev" },
  { slug: "shortcut", tier: "supported", category: "dev" },
  { slug: "height", tier: "supported", category: "dev" },
  { slug: "vercel", tier: "supported", category: "ci_cloud" },
  { slug: "cloudflare", tier: "supported", category: "ci_cloud" },
  { slug: "fly", tier: "supported", category: "ci_cloud" },
  { slug: "render", tier: "supported", category: "ci_cloud" },
  { slug: "discord", tier: "supported", category: "comm" },
  { slug: "microsoft_teams", tier: "supported", category: "comm" },
  { slug: "zoom", tier: "supported", category: "comm" },
  { slug: "intercom", tier: "supported", category: "comm" },
  { slug: "supabase", tier: "supported", category: "db" },
  { slug: "airtable", tier: "supported", category: "db" },
  { slug: "googlesheets", tier: "supported", category: "db" },
  { slug: "sentry", tier: "supported", category: "observability" },
  { slug: "datadog", tier: "supported", category: "observability" },
  { slug: "pagerduty", tier: "supported", category: "observability" },
  { slug: "hugging_face", tier: "supported", category: "ai_data" },
  { slug: "pinecone", tier: "supported", category: "ai_data" },

  // ───── Supported: marketing ────────────────────────────────────
  { slug: "youtube", tier: "supported", category: "social" },
  { slug: "facebook", tier: "supported", category: "social" },

  { slug: "klaviyo", tier: "supported", category: "email" },
  { slug: "kit", tier: "supported", category: "email" },
  { slug: "sendgrid", tier: "supported", category: "email" },
  { slug: "outlook", tier: "supported", category: "email" },

  { slug: "google_analytics", tier: "supported", category: "analytics" },
  { slug: "mixpanel", tier: "supported", category: "analytics" },
  { slug: "amplitude", tier: "supported", category: "analytics" },
  { slug: "posthog", tier: "supported", category: "analytics" },

  { slug: "salesforce", tier: "supported", category: "crm" },
  { slug: "pipedrive", tier: "supported", category: "crm" },
  { slug: "attio", tier: "supported", category: "crm" },
  { slug: "zendesk", tier: "supported", category: "crm" },
  { slug: "freshdesk", tier: "supported", category: "crm" },
  { slug: "zoho", tier: "supported", category: "crm" },

  { slug: "googleads", tier: "supported", category: "ads" },
  { slug: "metaads", tier: "supported", category: "ads" },
  { slug: "linkedin_ads", tier: "supported", category: "ads" },

  { slug: "ahrefs", tier: "supported", category: "seo" },
  { slug: "semrush", tier: "supported", category: "seo" },

  { slug: "webflow", tier: "supported", category: "cms" },
  { slug: "contentful", tier: "supported", category: "cms" },

  { slug: "canva", tier: "supported", category: "design" },

  { slug: "tally", tier: "supported", category: "forms" },
  { slug: "googleforms", tier: "supported", category: "forms" },

  { slug: "calendly", tier: "supported", category: "calendar" },
  { slug: "cal", tier: "supported", category: "calendar" },

  { slug: "googletasks", tier: "supported", category: "productivity" },
  { slug: "dropbox", tier: "supported", category: "productivity" },
  { slug: "one_drive", tier: "supported", category: "productivity" },
  { slug: "box", tier: "supported", category: "productivity" },
];

const BY_SLUG = new Map<string, StoreCatalogEntry>(
  RAW_ENTRIES.map((entry) => [entry.slug.toLowerCase(), entry]),
);

export function listStoreCatalog(): StoreCatalogEntry[] {
  return [...RAW_ENTRIES];
}

export function getStoreCatalogEntry(toolkitSlug: string): StoreCatalogEntry | null {
  return BY_SLUG.get(toolkitSlug.trim().toLowerCase()) ?? null;
}

export function isInStoreCatalog(toolkitSlug: string): boolean {
  return BY_SLUG.has(toolkitSlug.trim().toLowerCase());
}

export function storeCatalogTier(toolkitSlug: string): StoreTier | null {
  return getStoreCatalogEntry(toolkitSlug)?.tier ?? null;
}
