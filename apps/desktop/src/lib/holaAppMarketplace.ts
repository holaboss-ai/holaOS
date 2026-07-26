// Typed marketplace client for HolaApp bundles.
//
// Implements the desktop side of the marketplace/install contract
// (docs/plans/2026-06-27-holaapp-marketplace-api-contract.md): browse the catalog
// with per-user install state, install/uninstall.
//
// Everything sits behind the `MarketplaceSource` adapter so the local STUB used today
// (catalog from the existing `GET /api/v1/apps`, install state in localStorage) swaps
// to the real server endpoints with a one-line change once the backend ships them. The
// rest of the desktop (launcher, marketplace UI) depends only on the adapter, never the
// stub. v1 scope: hosted surfaces, MCP-only, session auth (see the contract).

import { bffFetch } from "./bff-fetch-bridge";
import { getIntegrationLogo } from "./integrationLogo";
import {
	customHolaAppMcpAttachInputs,
	customHolaAppsAsWebApps,
} from "./localCustomHolaApps";
import {
	type McpRequiredKey,
	type McpTool,
	syncInstalledAppHostedMcps,
} from "./mcpMarketplace";
import { toolkitDisplayName } from "./toolkitDisplay";
import {
	type HolaAppIntegrationRequirement,
	listWebHolaApps,
	type WebHolaApp,
} from "./webHolaApps";

export type { HolaAppIntegrationRequirement } from "./webHolaApps";

// ── contract types (v1 subset) ───────────────────────────────────────────────

export type AppSurface =
	| { type: "hosted"; path?: string; url?: string }
	| { type: "local"; port: number }
	| { type: "none" };

/** A marketplace card. Thin — no tools/skills (those are never surfaced). */
export interface AppCatalogEntry {
	holaAppId: string;
	title: string;
	description?: string;
	iconUrl?: string;
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
	version: string;
	installed: boolean;
	surface: AppSurface;
	/** Which tier of App this is — the merge's single discriminator:
	 *  - `connection`: a Composio toolkit with no interaction surface, driven
	 *    headless by the agent through the shared Composio MCP passthrough
	 *    (the former "integration").
	 *  - `module`: a materialized app-builder module with its own process + MCP.
	 *  - `hosted`: an App with a hosted web surface.
	 * Not intrinsic to a provider — a slug moves between tiers as a real module
	 * is authored for it. Absent ⇒ derive from `surface` via {@link appKind}. */
	kind?: "connection" | "module" | "hosted";
	/** Connections the app requires. When any is `required`, install gates on
	 * connecting (or selecting an existing) account before the app is added. */
	integrations?: HolaAppIntegrationRequirement[];
	/** Runtime-derived: the app is NOT added to the sidebar, but all of its
	 * required connections are already bound — so the agent can already use it in
	 * chat. Drives the card's "Connected" state + a secondary "Add to sidebar". */
	connectionBound?: boolean;
	/** Tool names from the app's own MCP server, for apps whose capabilities come
	 * from a bundled MCP server rather than a Composio integration. Used as a soft
	 * tool hint to the copilot. */
	mcpTools?: string[];
	/** API-key install flow (OmniSocials, Publora) — see ApiKeyInstall. Present ⇒
	 * install routes through the blocked-until-keyed gate: entering the key
	 * attaches the app's own external MCP server so the agent gains its tools. */
	apiKeyInstall?: ApiKeyInstall;
	/** Command/stdio MCP install (drawio) — see CommandMcpInstall. Present ⇒ install
	 * is one-click and attaches a LOCAL MCP server the runtime spawns; the app's
	 * `url` surface is loaded live (the agent drives it via the MCP). */
	commandMcpInstall?: CommandMcpInstall;
	/** Hosted-MCP install (jianguoyun) — see HostedMcpInstall. Present ⇒ install
	 * gates for the app's BYO credentials (requiredKeys), then attaches its
	 * Holaboss-hosted MCP (session bearer + those creds) grouped under the app. */
	hostedMcpInstall?: HostedMcpInstall;
	/** Rich detail-page content (overview / features / screenshots), served on the
	 * catalog entry so the app detail view is backend-managed. Absent fields fall
	 * back to synthetic copy in HolaAppDetailView. */
	detail?: AppDetail;
	/** App-tailored chat empty-state (greeting / subtitle / starter prompts) for
	 * sessions opened under this app. Absent ⇒ ChatPane shows a tailored greeting
	 * derived from the app title. */
	landing?: AppLanding;
	/** Lifecycle status. `coming_soon` → the card/detail render a disabled Install
	 * + "Coming soon" badge (install is also rejected server-side). Absent → ready. */
	status?: "ready" | "coming_soon";
	/** Team-native: an org-owned app (Need Review, HolaEmployee) shown in the ORG left
	 * column (org-mode only), never the app store. Backend-served from the
	 * `HolaAppDefinition.teamNative` flag. Absent/false ⇒ a store app. */
	teamNative?: boolean;
}

/** One "what you can do" card on the app detail page. */
export interface AppDetailFeature {
	title: string;
	body: string;
	/** Semantic icon key (e.g. "search", "pencil", "clock", "send", "plug"),
	 * mapped to a glyph in HolaAppDetailView; unknown/omitted → a generic glyph. */
	icon?: string;
}

/** One preview image on the app detail page. */
export interface AppDetailScreenshot {
	url: string;
	alt?: string;
}

/** Rich detail-page content served on the catalog entry (backend-managed). Every
 * field is optional; HolaAppDetailView renders synthetic, platform-level copy for
 * anything omitted, so an app supplies only what it wants to override. */
export interface AppDetail {
	overview?: string;
	features?: AppDetailFeature[];
	screenshots?: AppDetailScreenshot[];
}

/** App-tailored chat empty-state, served on the catalog entry (backend-managed).
 * A HolaApp owns its own sessions, so their landing greets + suggests in the
 * app's terms instead of the generic workspace copy. Every field optional; the
 * ChatPane falls back to a tailored greeting derived from the app title. */
export interface AppLanding {
	greeting?: string;
	subtitle?: string;
	/** Starter prompts sent verbatim as the first message when picked. */
	prompts?: string[];
}

/** API-key install config for an app that ships its OWN external MCP server,
 * authenticated by a key the user pastes on the desktop (OmniSocials, Publora).
 * Served on the catalog entry (backend) so no desktop code is per-app. */
export interface ApiKeyInstall {
	mcpUrl: string;
	instructionsUrl?: string;
	auth: ApiKeyMcpAuth;
	/** Custom "get your key" step shown in the gate (title + one detail line).
	 * When set it replaces the default sign-in / create-a-key copy. */
	keyInstructions?: { title: string; detail: string };
}

/** Command/stdio MCP install for an app whose tools come from a LOCAL MCP server
 * the desktop runtime spawns (e.g. drawio via `npx @next-ai-drawio/mcp-server`).
 * `command` is the full argv (executable + args); `env` are extra environment
 * vars for the spawned process (e.g. `PORT`). Served on the catalog entry so no
 * desktop code is per-app. Distinct from ApiKeyInstall (a remote HTTP server +
 * a user-supplied key) — here there is no key and the server runs locally. */
export interface CommandMcpInstall {
	command: string[];
	env?: Record<string, string>;
}

/** Hosted-MCP install for a HolaApp whose tools come from a Holaboss-HOSTED MCP
 * server (`/mcp/<id>/…`, so it needs the session bearer) that ALSO requires BYO
 * per-user credentials (e.g. jianguoyun's Nutstore account + token). Distinct
 * from a plain hosted app (no creds), `apiKeyInstall` (external server + one key,
 * no bearer) and `commandMcpInstall` (local process). The desktop gates for
 * `requiredKeys` then attaches the MCP via the marketplace machinery tagged
 * app-owned (owner_app_id) so it groups under the app. */
export interface HostedMcpInstall {
	mcpUrl: string;
	holabossHosted?: boolean;
	requiredKeys: McpRequiredKey[];
	tools?: McpTool[];
}

/** What the API-key install gate renders — the app id/title + its install config
 * (built from the active surface, not a per-app desktop table). */
export type ApiKeyGateConfig = {
	holaAppId: string;
	title: string;
} & ApiKeyInstall;

/** How a user-supplied API key authenticates an app's MCP server:
 *  - `query`: appended to the URL as `?<param>=<key>` (OmniSocials `API_KEY`).
 *  - `header`: sent as the `<name>` request header `<prefix><key>`
 *    (Publora `Authorization: Bearer <key>`). */
export type ApiKeyMcpAuth =
	| { kind: "query"; param: string }
	| { kind: "header"; name: string; prefix?: string };

export type McpAuth = { mode: "session" } | { mode: "token"; token: string };

export interface McpServerSpec {
	id: string;
	transport: "http";
	url: string;
	auth: McpAuth;
	tools: string[];
	timeoutMs?: number;
}

export interface SkillDelivery {
	id: string;
	version: string;
	source:
		| { type: "inline"; files: { path: string; content: string }[] }
		| { type: "url"; url: string };
}

/** What the desktop applies to the local runtime on install. */
export interface AppProvisioning {
	mcp: McpServerSpec[];
	skills: SkillDelivery[];
}

/** The catalog entry as the server returns it, before install state is merged in. */
export type CatalogEntryBase = Omit<AppCatalogEntry, "installed">;

// ── the adapter the rest of the desktop depends on ───────────────────────────

export interface MarketplaceSource {
	/** Available apps + this user's install state. */
	listCatalog(): Promise<AppCatalogEntry[]>;
	/** Install; returns the provisioning the desktop applies locally. */
	install(holaAppId: string): Promise<AppProvisioning>;
	/** Uninstall. */
	uninstall(holaAppId: string): Promise<void>;
}

// ── local stub (until the backend ships the endpoints) ───────────────────────

/** Persistence for install state — abstracted so the stub is unit-testable. */
export interface InstalledStore {
	read(): string[] | null;
	write(ids: string[]): void;
}

/**
 * A stub `MarketplaceSource`: the catalog comes from `fetchCatalog` (today the real
 * `GET /api/v1/apps`), install state from `store`. Install/uninstall only toggle local
 * state and return placeholder provisioning — the real MCP/skill provisioning arrives
 * from the server later. Pure of `window`/`localStorage` so it can be tested with an
 * in-memory store.
 */
export function createStubMarketplaceSource(deps: {
	fetchCatalog: () => Promise<CatalogEntryBase[]>;
	store: InstalledStore;
}): MarketplaceSource {
	const { fetchCatalog, store } = deps;

	function installedIds(catalogIds: string[]): Set<string> {
		const stored = store.read();
		if (stored === null) {
			// Migration: when install state is first introduced, treat every app the catalog
			// currently surfaces as already installed — so the launcher doesn't go empty.
			store.write(catalogIds);
			return new Set(catalogIds);
		}
		return new Set(stored);
	}

	return {
		async listCatalog() {
			const base = await fetchCatalog();
			const installed = installedIds(base.map((entry) => entry.holaAppId));
			return base.map((entry) => ({
				...entry,
				installed: installed.has(entry.holaAppId),
			}));
		},
		async install(holaAppId) {
			const stored = store.read() ?? [];
			store.write([...stored, holaAppId]);
			// Stub: real MCP/skill provisioning will come from the server's install response.
			return { mcp: [], skills: [] };
		},
		async uninstall(holaAppId) {
			const stored = store.read() ?? [];
			store.write(stored.filter((id) => id !== holaAppId));
		},
	};
}

const STORAGE_KEY = "holaboss.holaapps.installed.v1";

const localStorageStore: InstalledStore = {
	read() {
		try {
			const raw =
				typeof localStorage !== "undefined"
					? localStorage.getItem(STORAGE_KEY)
					: null;
			if (!raw) {
				return null;
			}
			const parsed: unknown = JSON.parse(raw);
			return Array.isArray(parsed)
				? parsed.filter((id): id is string => typeof id === "string")
				: null;
		} catch {
			return null;
		}
	},
	write(ids) {
		try {
			if (typeof localStorage !== "undefined") {
				localStorage.setItem(STORAGE_KEY, JSON.stringify([...new Set(ids)]));
			}
		} catch {
			// ignore — install state is best-effort in the stub
		}
	},
};

// A few Holaboss-hosted apps have been promoted OUT of the generic `/apps/<id>`
// app-store shell to their own first-class web route. Map their surface path here
// so the desktop opens the canonical URL directly instead of leaning on the
// frontend's back-compat redirect. (HolaEmployee → /employees; the old
// /apps/holaemployee still redirects, so this is an optimization, not a hard dep.)
const WEB_APP_PATH_OVERRIDES: Record<string, string> = {
	holaemployee: "/employees",
};

function webHolaAppPath(holaAppId: string): string {
	return WEB_APP_PATH_OVERRIDES[holaAppId] ?? `/apps/${holaAppId}`;
}

/** Map the existing `GET /api/v1/apps` shape to a catalog entry (v1: hosted surface). */
export function webHolaAppToCatalogEntry(app: WebHolaApp): CatalogEntryBase {
	return {
		holaAppId: app.holaAppId,
		title: app.title,
		...(app.description ? { description: app.description } : {}),
		...(app.iconUrl ? { iconUrl: app.iconUrl } : {}),
		version: "0.0.0",
		// A third-party `url` (e.g. Notion) loads directly; otherwise the surface derives
		// `<WEB_APP_BASE_URL>/<path>` — usually `/apps/<id>`, or a promoted route (see
		// WEB_APP_PATH_OVERRIDES) — mirroring how WebAppSurfacePane opens it.
		surface: app.url
			? { type: "hosted", url: app.url }
			: { type: "hosted", path: webHolaAppPath(app.holaAppId) },
		...(app.integrations ? { integrations: app.integrations } : {}),
		...(app.mcpTools ? { mcpTools: app.mcpTools } : {}),
		...(app.apiKeyInstall ? { apiKeyInstall: app.apiKeyInstall } : {}),
		...(app.commandMcpInstall
			? { commandMcpInstall: app.commandMcpInstall }
			: {}),
		...(app.hostedMcpInstall ? { hostedMcpInstall: app.hostedMcpInstall } : {}),
		...(app.detail ? { detail: app.detail } : {}),
		...(app.landing ? { landing: app.landing } : {}),
		...(app.status ? { status: app.status } : {}),
		...(app.category ? { category: app.category } : {}),
		...(app.featured ? { featured: true } : {}),
		...(app.heroImageUrl ? { heroImageUrl: app.heroImageUrl } : {}),
		...(app.badge ? { badge: app.badge } : {}),
		...(app.tags && app.tags.length > 0 ? { tags: app.tags } : {}),
		...(app.createdAt ? { createdAt: app.createdAt } : {}),
		...(app.installCount !== undefined
			? { installCount: app.installCount }
			: {}),
		...(app.teamNative ? { teamNative: true } : {}),
	};
}

// ── connection-tier Apps (former "integrations") ─────────────────────────────

/** A Composio store-catalog toolkit as the runtime serves it
 * (`workspace:listIntegrationStoreCatalog` → `IntegrationStoreCatalogEntry`).
 * Mirrored here so the synthesizer below is a pure, testable function of it. */
export interface StoreCatalogConnection {
	slug: string;
	tier: "hero" | "supported";
	category: string;
	beta?: boolean;
}

/** Derive an App's tier when the catalog entry doesn't state it explicitly.
 * `surface` alone determines it: no surface ⇒ headless connection, a local
 * port ⇒ an app-builder module, anything hosted ⇒ a hosted App. */
export function appKind(
	entry: Pick<AppCatalogEntry, "kind" | "surface">,
): "connection" | "module" | "hosted" {
	if (entry.kind) {
		return entry.kind;
	}
	switch (entry.surface.type) {
		case "none":
			return "connection";
		case "local":
			return "module";
		default:
			return "hosted";
	}
}

// Store-catalog categories arrive as terse slugs (crm, ci_cloud, ai_data). Map
// them to human labels for display; authored app categories are already
// Title-Case ("Social Media Ops") and pass through unchanged.
const CATEGORY_LABELS: Record<string, string> = {
	dev: "Developer",
	comm: "Communication",
	ci_cloud: "Cloud",
	db: "Database",
	observability: "Observability",
	ai_data: "AI & Data",
	social: "Social",
	email: "Email",
	analytics: "Analytics",
	crm: "CRM",
	ads: "Ads",
	seo: "SEO",
	cms: "CMS",
	design: "Design",
	forms: "Forms",
	calendar: "Calendar",
	commerce: "Commerce",
	video: "Video",
	productivity: "Productivity",
};

/** Human label for a catalog category — maps known store slugs, passes authored
 * categories through untouched. Display-only: filtering/grouping still key on the
 * raw category value. */
export function categoryLabel(raw?: string): string {
	const key = (raw ?? "").trim();
	if (!key) {
		return "";
	}
	return CATEGORY_LABELS[key.toLowerCase()] ?? key;
}

/** The one-word tier a card wears so its kind is legible without hovering:
 * "Connection" (headless, agent-driven) vs "App" (something you open). */
export function appTierLabel(
	entry: Pick<AppCatalogEntry, "kind" | "surface">,
): string {
	return appKind(entry) === "connection" ? "Connection" : "App";
}

/** Map one Composio store-catalog toolkit into a connection-tier catalog entry:
 * an App with no interaction surface, driven headless by the agent through the
 * shared Composio MCP passthrough. The provider slug is the required integration
 * — the same slug a future app-builder module for this provider would key on, so
 * upgrading a connection to a module reuses the connection unchanged. */
export function storeConnectionToCatalogEntry(
	entry: StoreCatalogConnection,
): CatalogEntryBase {
	const logo = getIntegrationLogo(entry.slug);
	return {
		holaAppId: entry.slug,
		title: toolkitDisplayName(entry.slug),
		kind: "connection",
		version: "0.0.0",
		surface: { type: "none" },
		integrations: [{ provider: entry.slug, required: true }],
		...(logo.url ? { iconUrl: logo.url } : {}),
		...(entry.category ? { category: entry.category } : {}),
		...(entry.beta ? { badge: "beta" } : {}),
		// Connections are NOT featured: the Featured shelf is a small curated
		// highlight, and flooding it with every hero toolkit buries the real picks.
		// Hero-ness still surfaces them via category + sort order.
	};
}

/** Every provider slug already "covered" by an authored app — its own
 * `holaAppId` PLUS every provider it lists in `integrations`. A synthesized
 * connection card for a covered slug is suppressed: the App is the one true
 * entry for that provider (e.g. the Notion App owns the `notion` connection, so
 * `notion` never gets its own bare Connection card). */
function coveredProviderSlugs(
	apps: Pick<AppCatalogEntry, "holaAppId" | "integrations">[],
): Set<string> {
	const covered = new Set<string>();
	for (const app of apps) {
		covered.add(app.holaAppId.trim().toLowerCase());
		for (const integration of app.integrations ?? []) {
			covered.add(integration.provider.trim().toLowerCase());
		}
	}
	return covered;
}

/** Fold synthesized connection cards into the authored app catalog. Authored
 * entries (module / hosted) WIN: a provider a real App already owns — as its id
 * OR as a required integration — is not re-added as a bare connection, so a
 * provider that has an App never shows two cards. */
export function mergeConnectionCatalog(
	apps: CatalogEntryBase[],
	storeEntries: StoreCatalogConnection[],
): CatalogEntryBase[] {
	const covered = coveredProviderSlugs(apps);
	const connections = storeEntries
		.filter((entry) => !covered.has(entry.slug.trim().toLowerCase()))
		.map(storeConnectionToCatalogEntry);
	return [...apps, ...connections];
}

/** Read the runtime's Composio store catalog through the desktop bridge.
 * Tolerant: a missing bridge or a failed call yields an empty list so the app
 * catalog still renders its authored entries. */
export async function fetchStoreConnections(): Promise<
	StoreCatalogConnection[]
> {
	try {
		const payload =
			await window.electronAPI.workspace?.listIntegrationStoreCatalog();
		const entries = payload?.entries;
		if (!Array.isArray(entries)) {
			return [];
		}
		return entries.flatMap((entry): StoreCatalogConnection[] => {
			const slug = typeof entry.slug === "string" ? entry.slug.trim() : "";
			if (!slug) {
				return [];
			}
			return [
				{
					slug,
					tier: entry.tier === "hero" ? "hero" : "supported",
					category: typeof entry.category === "string" ? entry.category : "",
					...(entry.beta ? { beta: true } : {}),
				},
			];
		});
	} catch {
		return [];
	}
}

/** Build the connection-tier cards for the live catalog: synthesize a card per
 * store toolkit not already present as an authored App, with `installed` derived
 * from whether the workspace holds an active connection for that provider.
 *
 * The connection + slug-mapping deps are imported dynamically so this module
 * stays free of the React/Electron surface at load time (its pure functions are
 * unit-tested under plain Node). On any failure, `installed` falls back to false
 * so the store still renders every connectable toolkit. */
/** The set of Composio toolkit slugs the workspace currently has a bound
 * connection for. Used to derive both a connection card's `installed` state and
 * an authored app's `connectionBound` state. Tolerant: any failure ⇒ empty set
 * (callers fall back to "not connected"). */
export async function fetchConnectedSlugs(): Promise<Set<string>> {
	const connectedSlugs = new Set<string>();
	try {
		const [
			{ listAllIntegrationConnections },
			{ composioToolkitSlugForProvider },
		] = await Promise.all([
			import("./listAllIntegrationConnections"),
			import("./workspaceDesktop"),
		]);
		const { connections } = await listAllIntegrationConnections();
		for (const connection of connections) {
			const slug = composioToolkitSlugForProvider(
				(connection.provider_id ?? "").trim().toLowerCase(),
			);
			if (slug) {
				connectedSlugs.add(slug);
			}
		}
	} catch {
		// empty set — the store still lists every toolkit as not-connected.
	}
	return connectedSlugs;
}

async function buildConnectionCards(
	existingIds: Set<string>,
	connectedSlugs: Set<string>,
): Promise<AppCatalogEntry[]> {
	const storeConnections = await fetchStoreConnections();
	if (storeConnections.length === 0) {
		return [];
	}
	return storeConnections
		.filter((entry) => !existingIds.has(entry.slug.trim().toLowerCase()))
		.map((entry) => ({
			...storeConnectionToCatalogEntry(entry),
			installed: connectedSlugs.has(entry.slug.trim().toLowerCase()),
		}));
}

/** True when an app's tools come from a Holaboss-HOSTED `/mcp/<id>` server (so
 * main should attach it). External-URL apps (Notion), API-key apps (OmniSocials,
 * Publora) and command/stdio apps (drawio) have no hosted MCP — main would just
 * skip them (or attaches them by a dedicated path), so we keep them out of the
 * per-turn hosted sync entirely. */
function usesHostedMcp(entry: AppCatalogEntry): boolean {
	return (
		!entry.apiKeyInstall &&
		!entry.commandMcpInstall &&
		// hostedMcpInstall apps carry BYO creds — they attach through the install
		// gate (marketplace machinery), NOT the credential-less per-turn hosted sync.
		!entry.hostedMcpInstall &&
		!(entry.surface.type === "hosted" && Boolean(entry.surface.url))
	);
}

async function defaultFetchCatalog(): Promise<CatalogEntryBase[]> {
	const apps = await listWebHolaApps();
	return apps.map(webHolaAppToCatalogEntry);
}

const stubSource = createStubMarketplaceSource({
	fetchCatalog: defaultFetchCatalog,
	store: localStorageStore,
});

// Stub-backed source: catalogue from the server, install STATE in localStorage, tools
// discovered by the main process. install/uninstall/listCatalog also notify MAIN so it
// applies the local MCP attach/detach. The ACTIVE default until the backend's
// server-managed install endpoints are deployed.
// Kept as the fallback. Swap `marketplace` (bottom of file) back to this to disable the
// server-managed path.
export const stubMarketplace: MarketplaceSource = {
	async listCatalog() {
		const catalog = await stubSource.listCatalog();
		// Keep the main process in sync with what's installed (covers app restart), so its
		// per-turn MCP attach covers every installed app.
		void window.electronAPI.holaApps?.sync(
			catalog
				.filter((entry) => entry.installed)
				.map((entry) => entry.holaAppId),
		);
		return catalog;
	},
	async install(holaAppId) {
		const provisioning = await stubSource.install(holaAppId);
		void window.electronAPI.holaApps?.install(holaAppId);
		return provisioning;
	},
	async uninstall(holaAppId) {
		await stubSource.uninstall(holaAppId);
		void window.electronAPI.holaApps?.uninstall(holaAppId);
	},
};

// The gateway calls go to the backend/api host, NOT the www SPA host
// (getApiBaseUrl): the SPA's Cloudflare static-asset edge returns 405 for POST on
// /gateway/* before the Worker runs, so install/uninstall (POST) silently failed
// there. The api host accepts POST and the session cookie is valid on it.
async function backendBaseUrl(): Promise<string | null> {
	const base = (await window.electronAPI.auth.getBackendBaseUrl())?.replace(
		/\/+$/,
		"",
	);
	return base || null;
}

/**
 * Server-managed source: install STATE lives on the backend (per user, durable) and the
 * catalogue carries the `installed` flag; install/uninstall hit the backend, then notify
 * MAIN to apply/remove the local MCP. (Tools are still discovered by main for now; once the
 * install response's `provisioning.mcp[].tools` is threaded through to MAIN, that discovery
 * can be retired.)
 *
 * Swap `marketplace` below to this once holaboss-backend's
 * /gateway/wapp/{install,uninstall,installed} + the catalogue `installed` flag are deployed
 * (branch feat/holaapp-server-managed-install). See the marketplace API contract.
 */
export function createServerMarketplaceSource(): MarketplaceSource {
	return {
		async listCatalog() {
			const serverApps = await listWebHolaApps();
			// Fold in LOCAL user-created custom HolaApps (localCustomHolaApps) — they're
			// absent from the backend catalog; each carries installed:true + a `url`
			// surface, and its MCP is re-attached via the app-owned sync below.
			const serverIds = new Set(serverApps.map((app) => app.holaAppId));
			const apps = [
				...serverApps,
				...customHolaAppsAsWebApps().filter(
					(app) => !serverIds.has(app.holaAppId),
				),
			];
			const catalog: AppCatalogEntry[] = apps.map((app) => ({
				...webHolaAppToCatalogEntry(app),
				installed: app.installed ?? false,
			}));
			// Sync only apps that use a Holaboss-hosted `/mcp/<id>` server to main —
			// external / API-key apps (Notion, OmniSocials, Publora) have none, and
			// main skips them anyway; keep them out of the per-turn re-attach.
			void window.electronAPI.holaApps?.sync(
				catalog
					.filter((entry) => entry.installed && usesHostedMcp(entry))
					.map((entry) => entry.holaAppId),
			);
			// App-owned hosted MCPs (hostedMcpInstall apps like jianguoyun) ride their
			// OWN per-turn re-attach track — kept separate so the standalone marketplace
			// sync can't detach them. Rebuilds each config from the locally-stored creds.
			void syncInstalledAppHostedMcps(
				catalog.map((entry) => ({
					holaAppId: entry.holaAppId,
					title: entry.title,
					...(entry.iconUrl ? { iconUrl: entry.iconUrl } : {}),
					installed: entry.installed,
					...(entry.hostedMcpInstall
						? { hostedMcpInstall: entry.hostedMcpInstall }
						: {}),
				})),
				customHolaAppMcpAttachInputs(),
			);
			// Fold in the connection-tier Apps (former "integrations"): every Composio
			// toolkit becomes a headless, surface-less App card. An authored App wins on
			// any provider it OWNS or REQUIRES, so e.g. the Notion App is the sole Notion
			// card (no duplicate bare Connection).
			const covered = coveredProviderSlugs(catalog);
			const connectedSlugs = await fetchConnectedSlugs();
			// Mark an authored app whose required connection(s) are bound but which
			// isn't in the sidebar yet — the card then reads "Connected" + offers a
			// secondary "Add to sidebar".
			const withConnectionState = catalog.map((entry) => {
				if (entry.installed) {
					return entry;
				}
				const required = (entry.integrations ?? []).filter((i) => i.required);
				const bound =
					required.length > 0 &&
					required.every((i) =>
						connectedSlugs.has(i.provider.trim().toLowerCase()),
					);
				return bound ? { ...entry, connectionBound: true } : entry;
			});
			const connectionCards = await buildConnectionCards(
				covered,
				connectedSlugs,
			);
			return [...withConnectionState, ...connectionCards];
		},
		async install(holaAppId) {
			const base = await backendBaseUrl();
			if (!base) {
				throw new Error(
					"HolaApp install failed: backend base URL is not configured.",
				);
			}
			const resp = await bffFetch(
				`${base}/gateway/wapp/${encodeURIComponent(holaAppId)}/install`,
				{ method: "POST" },
			);
			if (!resp.ok) {
				// Don't swallow the failure: a silent non-2xx here is what made the
				// install button spin and then quietly do nothing.
				throw new Error(
					`HolaApp install failed: POST /gateway/wapp/${holaAppId}/install → ${resp.status}`,
				);
			}
			// Apply the local MCP attach — a no-op for apps with no hosted `/mcp/<id>`
			// (attachWebHolaAppMcp skips when it discovers zero tools).
			void window.electronAPI.holaApps?.install(holaAppId);
			return { mcp: [], skills: [] };
		},
		async uninstall(holaAppId) {
			const base = await backendBaseUrl();
			if (!base) {
				throw new Error(
					"HolaApp uninstall failed: backend base URL is not configured.",
				);
			}
			const resp = await bffFetch(
				`${base}/gateway/wapp/${encodeURIComponent(holaAppId)}/uninstall`,
				{ method: "POST" },
			);
			if (!resp.ok) {
				throw new Error(
					`HolaApp uninstall failed: POST /gateway/wapp/${holaAppId}/uninstall → ${resp.status}`,
				);
			}
			// Removes the MCP server entry from workspace.yaml — works for both hosted
			// and API-key/custom servers (both keyed by holaAppId).
			void window.electronAPI.holaApps?.uninstall(holaAppId);
		},
	};
}

/** The marketplace source the desktop uses. Server-managed install is LIVE — the backend's
 *  /gateway/wapp/{catalog,install,uninstall,installed} endpoints are deployed, so install
 *  state is per-user + durable. Revert to `stubMarketplace` to disable the server path. */
export const marketplace: MarketplaceSource = createServerMarketplaceSource();

/** Params to open an installed app's surface (mirrors `useOpenHolaApp`). */
export function catalogEntryToOpenParams(entry: AppCatalogEntry): {
	holaAppId: string;
	title: string;
	url?: string;
	integrations?: { provider: string; required: boolean }[];
	mcpTools?: string[];
	apiKeyInstall?: ApiKeyInstall;
	commandMcpInstall?: CommandMcpInstall;
} {
	return {
		holaAppId: entry.holaAppId,
		title: entry.title,
		...(entry.surface.type === "hosted" && entry.surface.url
			? { url: entry.surface.url }
			: {}),
		// Carry the declared integrations + MCP tool names so the copilot can be
		// nudged toward this app's relevant connections/tools (soft guide; see
		// activeSurfaceContextText). An app uses one or the other: a Composio
		// integration (e.g. Notion) or its own bundled MCP server (e.g. need-review).
		...(entry.integrations && entry.integrations.length > 0
			? {
					integrations: entry.integrations.map((integration) => ({
						provider: integration.provider,
						required: integration.required,
					})),
				}
			: {}),
		...(entry.mcpTools && entry.mcpTools.length > 0
			? { mcpTools: entry.mcpTools }
			: {}),
		...(entry.apiKeyInstall ? { apiKeyInstall: entry.apiKeyInstall } : {}),
		...(entry.commandMcpInstall
			? { commandMcpInstall: entry.commandMcpInstall }
			: {}),
	};
}
