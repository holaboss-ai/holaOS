import { isInStoreCatalog, listStoreCatalog } from "./integration-store-catalog.js";

export interface IntegrationCatalogProviderRecord {
  provider_id: string;
  display_name: string;
  description: string;
  auth_modes: string[];
  supports_oss: boolean;
  supports_managed: boolean;
  default_scopes: string[];
  docs_url: string | null;
}

export const INTEGRATION_CATALOG_PROVIDERS: IntegrationCatalogProviderRecord[] = [
  {
    provider_id: "gmail",
    display_name: "Gmail",
    description: "Read, draft, and send emails through Gmail.",
    auth_modes: ["managed", "oauth_app", "manual_token"],
    supports_oss: true,
    supports_managed: true,
    default_scopes: ["gmail.send", "gmail.readonly"],
    docs_url: null
  },
  {
    provider_id: "googlesheets",
    display_name: "Google Sheets",
    description: "Read and manage spreadsheet data through Google Sheets.",
    auth_modes: ["managed", "oauth_app", "manual_token"],
    supports_oss: true,
    supports_managed: true,
    default_scopes: ["spreadsheets"],
    docs_url: null
  },
  {
    provider_id: "google",
    display_name: "Google",
    description: "Google account (legacy; prefer gmail or googlesheets).",
    auth_modes: ["managed", "oauth_app", "manual_token"],
    supports_oss: true,
    supports_managed: true,
    default_scopes: [],
    docs_url: null
  },
  {
    provider_id: "github",
    display_name: "GitHub",
    description: "Triage PRs, issues, and repository workflows.",
    auth_modes: ["managed", "oauth_app", "manual_token"],
    supports_oss: true,
    supports_managed: true,
    default_scopes: ["repo", "read:org"],
    docs_url: null
  },
  {
    provider_id: "reddit",
    display_name: "Reddit",
    description: "Read and manage Reddit content and moderation workflows.",
    auth_modes: ["managed", "oauth_app", "manual_token"],
    supports_oss: true,
    supports_managed: true,
    default_scopes: ["read", "submit"],
    docs_url: null
  },
  {
    provider_id: "twitter",
    display_name: "Twitter / X",
    description: "Read and publish social updates on X.",
    auth_modes: ["managed", "oauth_app", "manual_token"],
    supports_oss: true,
    supports_managed: true,
    default_scopes: ["tweet.read", "tweet.write"],
    docs_url: null
  },
  {
    provider_id: "linkedin",
    display_name: "LinkedIn",
    description: "Manage LinkedIn content and workflows.",
    auth_modes: ["managed", "oauth_app", "manual_token"],
    supports_oss: true,
    supports_managed: true,
    default_scopes: ["r_liteprofile", "w_member_social"],
    docs_url: null
  }
];

const PROVIDER_ALIASES: Record<string, string> = {
  x: "twitter",
};

export function normalizeIntegrationProviderId(providerId: string): string {
  return providerId.trim().toLowerCase();
}

export function integrationCatalogProviderIds(): string[] {
  return INTEGRATION_CATALOG_PROVIDERS.map((provider) => provider.provider_id);
}

// Union of the locally hosted OSS provider catalog (this file) and the
// curated Composio store catalog (integration-store-catalog.ts). Either
// one is a legitimate provider_id for an installed app.
function supportedProviderIds(): string[] {
  const set = new Set<string>(integrationCatalogProviderIds());
  for (const entry of listStoreCatalog()) {
    set.add(entry.slug.toLowerCase());
  }
  return [...set].sort();
}

function isProviderIdSupported(normalized: string): boolean {
  if (integrationCatalogProviderIds().includes(normalized)) return true;
  return isInStoreCatalog(normalized);
}

export function resolveIntegrationProviderAlias(providerId: string): string | null {
  const normalized = normalizeIntegrationProviderId(providerId);
  if (!normalized) {
    return null;
  }
  if (isProviderIdSupported(normalized)) {
    return normalized;
  }
  const alias = PROVIDER_ALIASES[normalized];
  return alias && isProviderIdSupported(alias) ? alias : null;
}

// Cheap Levenshtein distance for nearest-match suggestion. Small N (catalog
// is ~75 entries, slug length < 30) so straight DP is fine; pulling in a
// dependency for this is overkill.
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] ?? 0) + 1,
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}

function nearestSupportedProviderId(providerId: string): string | null {
  const target = providerId.trim().toLowerCase();
  if (!target) return null;
  let best: { slug: string; distance: number } | null = null;
  for (const slug of supportedProviderIds()) {
    const distance = levenshtein(target, slug);
    if (best === null || distance < best.distance) {
      best = { slug, distance };
    }
  }
  // Threshold: tolerate up to 2 edits, or 1/3 of slug length, whichever is
  // larger. Avoids surfacing wildly unrelated suggestions for typos like
  // "foo" → "github" (distance 6).
  const tolerance = Math.max(2, Math.floor(target.length / 3));
  if (!best || best.distance > tolerance) return null;
  return best.slug;
}

export function validateCanonicalIntegrationProviderId(providerId: string): string {
  const normalized = normalizeIntegrationProviderId(providerId);
  if (isProviderIdSupported(normalized)) {
    return normalized;
  }
  const alias = PROVIDER_ALIASES[normalized];
  if (alias && isProviderIdSupported(alias)) {
    throw new Error(
      `unknown integration provider '${providerId}'. Use canonical provider_id '${alias}' from the integration store catalog.`,
    );
  }
  const suggestion = nearestSupportedProviderId(normalized);
  const tail = suggestion
    ? ` Did you mean '${suggestion}'?`
    : " Call workspace_integrations_list_catalog to see supported provider_ids.";
  throw new Error(
    `unknown integration provider '${providerId}'.${tail}`,
  );
}
