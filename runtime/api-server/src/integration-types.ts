type JsonRecord = Record<string, unknown>;

export type IntegrationCredentialSource = "platform" | "manual" | "broker";

// Optional per-integration whoami descriptor. When set, the desktop forwards
// it to Hono's `/api/composio/connect` so the profile fetch (provider's own
// /me endpoint via Composio proxy) doesn't need a central PROVIDER_WHOAMI
// constant. A field value can be:
//   - a bare dot-path: "username", "data.profile.name"
//   - a string template containing `{path}` placeholders, used for
//     reconstructed URLs like Discord avatars:
//       "https://cdn.discordapp.com/avatars/{id}/{avatar}.png"
//   - an array of candidates (first non-empty wins), e.g. for legacy/v2
//     shape drift across provider API versions.
export type WhoamiFieldExpression = string | string[];

export interface WhoamiConfig {
  endpoint: string;
  fallback_endpoints?: string[];
  fields: {
    handle?: WhoamiFieldExpression;
    display_name?: WhoamiFieldExpression;
    avatar_url?: WhoamiFieldExpression;
    email?: WhoamiFieldExpression;
  };
}

export interface ResolvedIntegrationRequirement {
  key: string;
  provider: string;
  capability: string | null;
  scopes: string[];
  required: boolean;
  credentialSource: IntegrationCredentialSource;
  holabossUserIdRequired: boolean;
  whoami?: WhoamiConfig | null;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
}

function parseBool(value: unknown, defaultValue = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return defaultValue;
}

function parseScopes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseCredentialSource(value: unknown): IntegrationCredentialSource {
  const normalized = firstString(value).toLowerCase();
  if (!normalized) {
    return "platform";
  }
  if (normalized === "manual") {
    return "manual";
  }
  if (normalized === "broker") {
    return "broker";
  }
  if (normalized === "platform") {
    return "platform";
  }
  throw new Error(
    `invalid credential_source '${normalized}'. Expected one of: platform, manual, broker`,
  );
}

function parseWhoamiFieldExpression(value: unknown): WhoamiFieldExpression | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    const candidates = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
    return candidates.length > 0 ? candidates : undefined;
  }
  return undefined;
}

function parseWhoamiConfig(value: unknown): WhoamiConfig | null {
  if (!isRecord(value)) {
    return null;
  }
  const endpoint = firstString(value.endpoint);
  if (!endpoint) {
    return null;
  }
  const fallbacks = Array.isArray(value.fallback_endpoints)
    ? value.fallback_endpoints
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
  const rawFields = isRecord(value.fields) ? value.fields : {};
  const fields: WhoamiConfig["fields"] = {};
  const handle = parseWhoamiFieldExpression(rawFields.handle);
  if (handle !== undefined) fields.handle = handle;
  const displayName = parseWhoamiFieldExpression(
    rawFields.display_name ?? rawFields.displayName,
  );
  if (displayName !== undefined) fields.display_name = displayName;
  const avatarUrl = parseWhoamiFieldExpression(
    rawFields.avatar_url ?? rawFields.avatarUrl,
  );
  if (avatarUrl !== undefined) fields.avatar_url = avatarUrl;
  const email = parseWhoamiFieldExpression(rawFields.email);
  if (email !== undefined) fields.email = email;
  return {
    endpoint,
    ...(fallbacks.length > 0 ? { fallback_endpoints: fallbacks } : {}),
    fields,
  };
}

function parseIntegrationRequirement(
  value: unknown,
  fallbackKey: string,
): ResolvedIntegrationRequirement | null {
  if (!isRecord(value)) {
    return null;
  }

  const provider = firstString(value.provider, value.destination);
  if (!provider) {
    return null;
  }
  const key = firstString(value.key, provider, fallbackKey) || provider;
  const capability = firstString(value.capability) || null;
  const scopes = parseScopes(value.scopes);
  const whoami = parseWhoamiConfig(value.whoami);
  return {
    key,
    provider,
    capability,
    scopes,
    required: parseBool(value.required, true),
    credentialSource: parseCredentialSource(value.credential_source ?? value.credentialSource),
    holabossUserIdRequired: parseBool(
      value.holaboss_user_id_required ?? value.holabossUserIdRequired,
      false,
    ),
    ...(whoami ? { whoami } : {}),
  };
}

export function parseResolvedIntegrationRequirements(document: JsonRecord): ResolvedIntegrationRequirement[] {
  const resolved: ResolvedIntegrationRequirement[] = [];

  const hasLegacyIntegration = document.integration !== undefined && document.integration !== null;
  const hasIntegrationList = Array.isArray(document.integrations) && document.integrations.length > 0;
  if (hasLegacyIntegration && hasIntegrationList) {
    throw new Error("app.runtime.yaml cannot define both integration and integrations");
  }

  if (hasIntegrationList) {
    const integrationsList = document.integrations as unknown[];
    for (const [index, value] of integrationsList.entries()) {
      const parsed = parseIntegrationRequirement(value, `integration_${index}`);
      if (parsed) {
        resolved.push(parsed);
      }
    }
  } else if (hasLegacyIntegration) {
    const parsedLegacy = parseIntegrationRequirement(document.integration, "integration");
    if (parsedLegacy) {
      resolved.push(parsedLegacy);
    }
  }

  return resolved;
}
