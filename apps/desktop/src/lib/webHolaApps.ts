// Lists the web HolaApps available to show in the desktop "HolaApps" marketplace.
//
// Source of truth is the workflow-backend HolaApp catalogue, reached via the gateway at
// `/gateway/wapp/catalog` → backend `/api/v1/apps/catalog`. (The bare `/api/v1/apps` list
// is NOT gateway-reachable — the gateway requires a non-empty subpath — which is why a
// direct fetch always came back empty.) The gateway targets the workflow-backend with the
// user's Better Auth session and injects the `x-holaboss-user-id` the backend requires.
//
// No client-side fallback / built-in apps: the marketplace shows exactly what the server
// returns. When the list can't be fetched we return an empty catalogue and log why.

import { bffFetch } from "./bff-fetch-bridge";
import type {
  ApiKeyInstall,
  ApiKeyMcpAuth,
  AppDetail,
  AppDetailFeature,
  AppDetailScreenshot,
  AppLanding,
  CommandMcpInstall,
  HostedMcpInstall,
} from "./holaAppMarketplace";
import type { McpRequiredKey, McpTool } from "./mcpMarketplace";

/** A third-party connection an app declares it needs (e.g. `notion`). The
 * provider is the Composio toolkit slug == OAuth provider id == binding
 * integration_key, fed straight into the desktop's integration system. When
 * `required`, install gates on connecting (or selecting an existing) account. */
export interface HolaAppIntegrationRequirement {
  provider: string;
  required: boolean;
  whoami?: PendingIntegrationWhoami | null;
}

export interface WebHolaApp {
  holaAppId: string;
  title: string;
  description?: string;
  /** Favicon shown before the title in the launcher. Falls back to a generic
   * app glyph if absent or if the image fails to load. */
  iconUrl?: string;
  /** Absolute URL to open instead of the derived `<WEB_APP_BASE_URL>/apps/<id>`.
   * Used by apps that aren't Holaboss-hosted. */
  url?: string;
  /** Per-user install state, when the catalogue endpoint reports it (server-managed
   * install). Absent on older backends; the stub source ignores it. */
  installed?: boolean;
  /** Connections the app declares (parsed by the backend from the bundle and
   * shipped on `/api/v1/apps`). Drives the install-time connect/select gate.
   * Absent on backends that don't ship it yet. */
  integrations?: HolaAppIntegrationRequirement[];
  /** Tool names from the app's own MCP server (`mcp.tools[].name` in the catalog),
   * for apps whose capabilities come from a bundled MCP server rather than a
   * Composio integration (e.g. need-review, gofunds). Used as a soft tool hint to the
   * copilot. */
  mcpTools?: string[];
  /** API-key install config for apps with their OWN external MCP server
   * (OmniSocials, Publora) — served on the catalog entry. Drives the desktop's
   * blocked-until-keyed install gate. */
  apiKeyInstall?: ApiKeyInstall;
  /** Command/stdio MCP install (drawio) — served on the catalog entry. Drives the
   * desktop's one-click local-MCP attach + live editor surface. */
  commandMcpInstall?: CommandMcpInstall;
  /** Hosted-MCP install (jianguoyun) — served on the catalog entry. Drives the
   * desktop's credential gate + hosted-MCP attach (grouped under the app). */
  hostedMcpInstall?: HostedMcpInstall;
  /** Rich detail-page content (overview / features / screenshots) served on the
   * catalog entry. Drives the app detail view; absent fields fall back to
   * synthetic copy. */
  detail?: AppDetail;
  /** App-tailored chat empty-state (greeting / subtitle / starter prompts) served
   * on the catalog entry. Drives the app-session landing; absent ⇒ tailored
   * greeting from the app title. */
  landing?: AppLanding;
  /** Lifecycle status from the catalog. `coming_soon` renders a disabled Install
   * + badge (install is rejected server-side). Absent on older backends → treated
   * as ready. */
  status?: "ready" | "coming_soon";
  /** Marketplace grouping label (e.g. "Investment"). The grid groups cards by it;
   * absent ⇒ grouped under "Other". */
  category?: string;
  /** Highlighted in the marketplace "Featured" shelf. */
  featured?: boolean;
  /** Banner image for the Featured shelf's large card. */
  heroImageUrl?: string;
  /** Small badge label (e.g. "beta", "new"), rendered uppercased. Absent ⇒ none. */
  badge?: string;
  /** Capability chips shown on the card (backend-authored). Absent ⇒ no chips. */
  tags?: string[];
  /** ISO timestamp the app was added — drives the "Latest" sort. */
  createdAt?: string;
  /** Unique users who currently have the app installed — drives "Popular". */
  installCount?: number;
  /** Team-native: an org-owned Holaboss-native app (Need Review, HolaEmployee). These
   * surface in the ORG left column (org-mode only), NOT the app store — the store
   * filters them out. Served by the backend catalog from `HolaAppDefinition.teamNative`.
   * Absent/false ⇒ a personal / integration / mcp app that lives in the store. */
  teamNative?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Parse a backend `integrations[]` payload. Tolerant of older/missing shapes —
// a malformed entry is dropped, an absent array yields undefined so the field
// stays optional all the way through.
function normalizeIntegrations(
  value: unknown,
): HolaAppIntegrationRequirement[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parsed = value.flatMap((entry): HolaAppIntegrationRequirement[] => {
    if (!isRecord(entry)) {
      return [];
    }
    const provider = typeof entry.provider === "string" ? entry.provider : "";
    if (!provider) {
      return [];
    }
    return [
      {
        provider,
        required: entry.required === true,
        ...(isRecord(entry.whoami)
          ? { whoami: entry.whoami as unknown as PendingIntegrationWhoami }
          : {}),
      },
    ];
  });
  return parsed.length > 0 ? parsed : undefined;
}

// Parse the catalog `mcp` block into a flat list of tool names — the actionable
// part for the copilot's soft tool hint. Tolerant of the field being absent.
function normalizeMcpTools(value: unknown): string[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.tools)) {
    return undefined;
  }
  const names = value.tools.flatMap((tool): string[] => {
    if (!isRecord(tool) || typeof tool.name !== "string") {
      return [];
    }
    const name = tool.name.trim();
    return name ? [name] : [];
  });
  return names.length > 0 ? names : undefined;
}

function normalizeApiKeyMcpAuth(value: unknown): ApiKeyMcpAuth | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.kind === "query" && typeof value.param === "string" && value.param) {
    return { kind: "query", param: value.param };
  }
  if (value.kind === "header" && typeof value.name === "string" && value.name) {
    return {
      kind: "header",
      name: value.name,
      ...(typeof value.prefix === "string" ? { prefix: value.prefix } : {}),
    };
  }
  return null;
}

// Parse the catalog `apiKeyInstall` block (OmniSocials/Publora). Requires an
// mcpUrl + a valid auth descriptor; tolerant of the optional copy fields.
function normalizeApiKeyInstall(value: unknown): ApiKeyInstall | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const mcpUrl = typeof value.mcpUrl === "string" ? value.mcpUrl : "";
  const auth = normalizeApiKeyMcpAuth(value.auth);
  if (!mcpUrl || !auth) {
    return undefined;
  }
  const instructionsUrl =
    typeof value.instructionsUrl === "string"
      ? value.instructionsUrl
      : undefined;
  const ki = value.keyInstructions;
  const keyInstructions =
    isRecord(ki) && typeof ki.title === "string" && typeof ki.detail === "string"
      ? { title: ki.title, detail: ki.detail }
      : undefined;
  return {
    mcpUrl,
    auth,
    ...(instructionsUrl ? { instructionsUrl } : {}),
    ...(keyInstructions ? { keyInstructions } : {}),
  };
}

// Parse the catalog `commandMcpInstall` block (drawio). Requires a non-empty
// string[] `command` (the argv); `env` is an optional string→string map. Tolerant
// of the field being absent or malformed — an invalid shape collapses to undefined.
function normalizeCommandMcpInstall(
  value: unknown,
): CommandMcpInstall | undefined {
  if (!isRecord(value) || !Array.isArray(value.command)) {
    return undefined;
  }
  const command = value.command.filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  if (command.length === 0) {
    return undefined;
  }
  let env: Record<string, string> | undefined;
  if (isRecord(value.env)) {
    const entries = Object.entries(value.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    if (entries.length > 0) {
      env = Object.fromEntries(entries);
    }
  }
  return { command, ...(env ? { env } : {}) };
}

// Parse a hostedMcpInstall `requiredKeys[]` entry (mirrors the MCP-marketplace
// contract: { target: header|query|env, name, label, help?, secret? }).
function normalizeHostedRequiredKey(value: unknown): McpRequiredKey | null {
  if (!isRecord(value)) {
    return null;
  }
  const target =
    value.target === "header" || value.target === "query" || value.target === "env"
      ? value.target
      : null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const label = typeof value.label === "string" ? value.label.trim() : "";
  if (!(target && name && label)) {
    return null;
  }
  return {
    target,
    name,
    label,
    ...(typeof value.help === "string" && value.help.trim() ? { help: value.help } : {}),
    ...(value.secret === true ? { secret: true } : {}),
  };
}

// Parse the catalog `hostedMcpInstall` block (jianguoyun): a Holaboss-hosted MCP
// that needs BYO credentials. Requires a non-empty `mcpUrl` and at least one
// valid `requiredKeys` entry (no keys ⇒ it's a plain hosted app, not this path).
// Malformed shapes collapse to undefined.
function normalizeHostedMcpInstall(
  value: unknown,
): HostedMcpInstall | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const mcpUrl = typeof value.mcpUrl === "string" ? value.mcpUrl.trim() : "";
  if (!mcpUrl) {
    return undefined;
  }
  const requiredKeys = Array.isArray(value.requiredKeys)
    ? value.requiredKeys
        .map(normalizeHostedRequiredKey)
        .filter((key): key is McpRequiredKey => key !== null)
    : [];
  if (requiredKeys.length === 0) {
    return undefined;
  }
  const tools = Array.isArray(value.tools)
    ? value.tools.flatMap((entry): McpTool[] =>
        isRecord(entry) && typeof entry.name === "string" && entry.name.trim()
          ? [
              {
                name: entry.name.trim(),
                description:
                  typeof entry.description === "string" ? entry.description : "",
              },
            ]
          : [],
      )
    : [];
  return {
    mcpUrl,
    ...(value.holabossHosted === false ? { holabossHosted: false } : {}),
    requiredKeys,
    ...(tools.length > 0 ? { tools } : {}),
  };
}

// Parse the catalog `detail` block (overview / features / screenshots). Every
// field is optional and independently tolerant — a malformed feature/screenshot
// is dropped rather than failing the whole app, and an empty result collapses to
// undefined so the detail view falls back to its synthetic copy.
function normalizeDetailFeatures(
  value: unknown,
): AppDetailFeature[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const features = value.flatMap((entry): AppDetailFeature[] => {
    if (
      !isRecord(entry) ||
      typeof entry.title !== "string" ||
      typeof entry.body !== "string" ||
      !entry.title.trim() ||
      !entry.body.trim()
    ) {
      return [];
    }
    return [
      {
        title: entry.title,
        body: entry.body,
        ...(typeof entry.icon === "string" && entry.icon
          ? { icon: entry.icon }
          : {}),
      },
    ];
  });
  return features.length > 0 ? features : undefined;
}

function normalizeDetailScreenshots(
  value: unknown,
): AppDetailScreenshot[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const shots = value.flatMap((entry): AppDetailScreenshot[] => {
    if (!isRecord(entry) || typeof entry.url !== "string" || !entry.url.trim()) {
      return [];
    }
    return [
      {
        url: entry.url,
        ...(typeof entry.alt === "string" && entry.alt ? { alt: entry.alt } : {}),
      },
    ];
  });
  return shots.length > 0 ? shots : undefined;
}

function normalizeDetail(value: unknown): AppDetail | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const overview =
    typeof value.overview === "string" && value.overview.trim()
      ? value.overview
      : undefined;
  const features = normalizeDetailFeatures(value.features);
  const screenshots = normalizeDetailScreenshots(value.screenshots);
  if (!(overview || features || screenshots)) {
    return undefined;
  }
  return {
    ...(overview ? { overview } : {}),
    ...(features ? { features } : {}),
    ...(screenshots ? { screenshots } : {}),
  };
}

// Parse the catalog `landing` block (app-tailored chat empty state). Tolerant of
// the field being absent/malformed — drops non-string prompts, returns undefined
// when nothing usable remains so the field stays optional.
function normalizeLanding(value: unknown): AppLanding | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const greeting =
    typeof value.greeting === "string" && value.greeting.trim()
      ? value.greeting
      : undefined;
  const subtitle =
    typeof value.subtitle === "string" && value.subtitle.trim()
      ? value.subtitle
      : undefined;
  const prompts = Array.isArray(value.prompts)
    ? value.prompts.filter(
        (p): p is string => typeof p === "string" && p.trim().length > 0,
      )
    : undefined;
  const hasPrompts = prompts && prompts.length > 0;
  if (!(greeting || subtitle || hasPrompts)) {
    return undefined;
  }
  return {
    ...(greeting ? { greeting } : {}),
    ...(subtitle ? { subtitle } : {}),
    ...(hasPrompts ? { prompts } : {}),
  };
}

// Normalize a backend catalogue entry — `{ holaAppId, title, icon?, description? }` — to a
// WebHolaApp. Returns null for a malformed entry. The backend `icon` is a display glyph
// (often an emoji), NOT an image URL, so it is intentionally not mapped to `iconUrl` (the
// launcher renders iconUrl as an <img src>).
function normalizeApp(value: unknown): WebHolaApp | null {
  if (!isRecord(value)) {
    return null;
  }
  const holaAppId = typeof value.holaAppId === "string" ? value.holaAppId : "";
  const title = typeof value.title === "string" ? value.title : "";
  if (!holaAppId || !title) {
    return null;
  }
  const description =
    typeof value.description === "string" ? value.description : undefined;
  const iconUrl = typeof value.iconUrl === "string" ? value.iconUrl : undefined;
  const url = typeof value.url === "string" ? value.url : undefined;
  const installed = typeof value.installed === "boolean" ? value.installed : undefined;
  const integrations = normalizeIntegrations(value.integrations);
  const mcpTools = normalizeMcpTools(value.mcp);
  const apiKeyInstall = normalizeApiKeyInstall(value.apiKeyInstall);
  const commandMcpInstall = normalizeCommandMcpInstall(value.commandMcpInstall);
  const hostedMcpInstall = normalizeHostedMcpInstall(value.hostedMcpInstall);
  const detail = normalizeDetail(value.detail);
  const landing = normalizeLanding(value.landing);
  const status = value.status === "coming_soon" ? "coming_soon" : undefined;
  const category =
    typeof value.category === "string" && value.category.trim()
      ? value.category
      : undefined;
  const featured = value.featured === true ? true : undefined;
  const heroImageUrl =
    typeof value.heroImageUrl === "string" && value.heroImageUrl.trim()
      ? value.heroImageUrl
      : undefined;
  const badge =
    typeof value.badge === "string" && value.badge.trim()
      ? value.badge
      : undefined;
  const tags = Array.isArray(value.tags)
    ? value.tags.filter(
        (tag): tag is string => typeof tag === "string" && tag.trim().length > 0,
      )
    : undefined;
  const createdAt =
    typeof value.createdAt === "string" && value.createdAt.trim()
      ? value.createdAt
      : undefined;
  const installCount =
    typeof value.installCount === "number" && Number.isFinite(value.installCount)
      ? value.installCount
      : undefined;
  const teamNative = value.teamNative === true ? true : undefined;
  return {
    holaAppId,
    title,
    ...(description ? { description } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    ...(url ? { url } : {}),
    ...(installed !== undefined ? { installed } : {}),
    ...(integrations ? { integrations } : {}),
    ...(mcpTools ? { mcpTools } : {}),
    ...(apiKeyInstall ? { apiKeyInstall } : {}),
    ...(commandMcpInstall ? { commandMcpInstall } : {}),
    ...(hostedMcpInstall ? { hostedMcpInstall } : {}),
    ...(detail ? { detail } : {}),
    ...(landing ? { landing } : {}),
    ...(status ? { status } : {}),
    ...(category ? { category } : {}),
    ...(featured ? { featured } : {}),
    ...(heroImageUrl ? { heroImageUrl } : {}),
    ...(badge ? { badge } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(installCount !== undefined ? { installCount } : {}),
    ...(teamNative ? { teamNative } : {}),
  };
}

// The per-env server catalogue often omits gofunds in local dev (it's provisioned
// per environment), which drops it from the launcher. In dev only, re-add it so
// it stays openable while developing. Production shows exactly the server list.
const DEV_GOFUNDS: WebHolaApp = {
  holaAppId: "gofunds",
  title: "GoFunds",
  iconUrl: "https://gofunds.fun/favicon.ico",
  installed: true,
};

function withDevGoFunds(apps: WebHolaApp[]): WebHolaApp[] {
  if (!import.meta.env.DEV || apps.some((app) => app.holaAppId === "gofunds")) {
    return apps;
  }
  return [...apps, DEV_GOFUNDS];
}

export async function listWebHolaApps(): Promise<WebHolaApp[]> {
  return withDevGoFunds(await fetchServerCatalogue());
}

async function fetchServerCatalogue(): Promise<WebHolaApp[]> {
  try {
    // The backend/api host — NOT the www SPA host (getApiBaseUrl): the SPA's
    // Cloudflare static-asset edge 405s POST on /gateway/*, so install/uninstall
    // must use this host. The catalogue uses it too so its per-user `installed`
    // flag is read with the session injected (on www it was unauthenticated →
    // always false, so the launcher would never reflect an install).
    const base = (await window.electronAPI.auth.getBackendBaseUrl())?.replace(
      /\/+$/,
      "",
    );
    if (!base) {
      console.warn("[holaapps] no backend base URL — empty catalogue");
      return [];
    }
    const resp = await bffFetch(`${base}/gateway/wapp/catalog`);
    if (!resp.ok) {
      console.warn(
        `[holaapps] GET /gateway/wapp/catalog → ${resp.status}; empty catalogue`,
      );
      return [];
    }
    const data = (await resp.json()) as { apps?: unknown };
    const apps = Array.isArray(data.apps)
      ? data.apps
          .map(normalizeApp)
          .filter((app): app is WebHolaApp => app !== null)
      : [];
    if (apps.length === 0) {
      console.warn("[holaapps] /gateway/wapp/catalog returned no apps");
    }
    return apps;
  } catch (err) {
    console.warn("[holaapps] catalogue fetch failed; empty catalogue", err);
    return [];
  }
}
