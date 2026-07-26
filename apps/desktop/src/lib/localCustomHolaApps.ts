// Local-only persistence for user-created ("custom") HolaApps.
//
// A custom HolaApp is defined entirely on THIS machine: a URL the desktop opens as
// the app's surface, plus an optional remote MCP server (a URL + headers, pasted as
// an mcpServers-style JSON config) whose tools the agent gets while the app is around.
// Everything lives in localStorage — mirroring the custom-MCP creds store
// (localMcpKeys.ts); no `/gateway/*` call ever carries it. The MCP is attached
// APP-OWNED (owner_app_id === holaAppId) and folded into the SAME per-turn re-attach
// set as a HolaApp's hostedMcpInstall (syncInstalledAppHostedMcps) — the app-owned
// sync reconciles that whole set, so custom apps must ride it rather than a separate
// call. It survives a restart and is torn down when the app is deleted.

import type { McpAttachInput } from "./mcpMarketplace";
import type { WebHolaApp } from "./webHolaApps";

export interface CustomHolaApp {
	/** Stable local id, always prefixed `custom-`. */
	holaAppId: string;
	title: string;
	/** The surface URL the app opens (e.g. https://notion.so). */
	url: string;
	iconUrl?: string;
	/** Resolved app-owned MCP attach input (ownerAppId === holaAppId). Absent ⇒ no MCP. */
	mcp?: McpAttachInput;
	/** The raw JSON the user pasted, kept so the create form can pre-fill on edit. */
	mcpConfigJson?: string;
	/** True while a headerless-MCP app is mid-sign-in (a DRAFT): committed apps drop it, and
	 *  a draft left by a session killed mid-add is purged on next startup. */
	pending?: boolean;
}

const KEY = "holaboss.holaapps.custom.v1";

function hasLocalStorage(): boolean {
	return typeof localStorage !== "undefined";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringMap(value: unknown): Record<string, string> {
	if (!isRecord(value)) {
		return {};
	}
	const out: Record<string, string> = {};
	for (const [name, entry] of Object.entries(value)) {
		if (typeof entry === "string") {
			out[name] = entry;
		}
	}
	return out;
}

function normalizeAttach(value: unknown): McpAttachInput | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const id = typeof value.id === "string" ? value.id : "";
	const mcpUrl = typeof value.mcpUrl === "string" ? value.mcpUrl : "";
	const ownerAppId =
		typeof value.ownerAppId === "string" ? value.ownerAppId : "";
	if (!(id && mcpUrl && ownerAppId)) {
		return undefined;
	}
	const tools = Array.isArray(value.tools)
		? value.tools.filter((tool): tool is string => typeof tool === "string")
		: [];
	return {
		id,
		mcpUrl,
		holabossHosted: value.holabossHosted === true,
		headerKeys: normalizeStringMap(value.headerKeys),
		queryKeys: normalizeStringMap(value.queryKeys),
		envKeys: normalizeStringMap(value.envKeys),
		tools,
		ownerAppId,
	};
}

function normalizeStored(value: unknown): CustomHolaApp | null {
	if (!isRecord(value)) {
		return null;
	}
	const holaAppId = typeof value.holaAppId === "string" ? value.holaAppId : "";
	const title = typeof value.title === "string" ? value.title : "";
	const url = typeof value.url === "string" ? value.url : "";
	if (!(holaAppId && title && url)) {
		return null;
	}
	const mcp = normalizeAttach(value.mcp);
	return {
		holaAppId,
		title,
		url,
		...(typeof value.iconUrl === "string" && value.iconUrl
			? { iconUrl: value.iconUrl }
			: {}),
		...(mcp ? { mcp } : {}),
		...(typeof value.mcpConfigJson === "string"
			? { mcpConfigJson: value.mcpConfigJson }
			: {}),
		...(value.pending === true ? { pending: true } : {}),
	};
}

/** Every custom HolaApp this machine has defined. Tolerant of a corrupt store. */
export function readCustomHolaApps(): CustomHolaApp[] {
	if (!hasLocalStorage()) {
		return [];
	}
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) {
			return [];
		}
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed
			.map(normalizeStored)
			.filter((app): app is CustomHolaApp => app !== null);
	} catch {
		return [];
	}
}

function writeCustomHolaApps(apps: CustomHolaApp[]): void {
	if (!hasLocalStorage()) {
		return;
	}
	try {
		localStorage.setItem(KEY, JSON.stringify(apps));
	} catch {
		// best-effort — custom apps are local UI state
	}
}

/** Create or replace a custom app (keyed by holaAppId). */
export function upsertCustomHolaApp(app: CustomHolaApp): void {
	const rest = readCustomHolaApps().filter(
		(a) => a.holaAppId !== app.holaAppId,
	);
	writeCustomHolaApps([...rest, app]);
}

export function deleteCustomHolaApp(holaAppId: string): void {
	writeCustomHolaApps(
		readCustomHolaApps().filter((a) => a.holaAppId !== holaAppId),
	);
}

// One-time (per app session) cleanup of orphaned DRAFT apps: a headerless-MCP app saved
// mid-sign-in (`pending`) that a killed session never committed or discarded. Runs once, so
// it only sweeps drafts from a PREVIOUS session — never the one being added right now.
let orphanDraftsPurged = false;
export function purgeOrphanedDraftApps(): void {
	if (orphanDraftsPurged) {
		return;
	}
	orphanDraftsPurged = true;
	const all = readCustomHolaApps();
	const kept = all.filter((app) => !app.pending);
	if (kept.length !== all.length) {
		writeCustomHolaApps(kept);
	}
}

/** Custom apps as WebHolaApps (installed + ready) so they merge into the catalog and
 * open their `url` surface like any other hosted HolaApp. */
export function customHolaAppsAsWebApps(): WebHolaApp[] {
	return readCustomHolaApps().map((app) => ({
		holaAppId: app.holaAppId,
		title: app.title,
		url: app.url,
		installed: true,
		category: "Custom",
		...(app.iconUrl ? { iconUrl: app.iconUrl } : {}),
	}));
}

/** The resolved app-owned MCP attach inputs for every custom app that has one —
 * folded into the app-owned sync (syncInstalledAppHostedMcps) so main re-attaches
 * them per turn alongside the hosted-app MCPs, without either clobbering the other. */
export function customHolaAppMcpAttachInputs(): McpAttachInput[] {
	return readCustomHolaApps().flatMap((app) => (app.mcp ? [app.mcp] : []));
}

/** A stable, unique-enough id for a new custom app, derived from its title. */
export function customHolaAppId(title: string): string {
	const slug = title
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `custom-${slug || "app"}-${Date.now().toString(36)}`;
}

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		// Undefined is never a valid JSON.parse result, so callers read it as "failed".
		return undefined;
	}
}

// Accept { mcpServers: { "<name>": {...} } }, { servers: { … } }, or a bare
// single-server object ({ url, headers, … } / { command, … }).
function pickServerObject(
	obj: Record<string, unknown>,
): Record<string, unknown> | null {
	for (const container of [obj.mcpServers, obj.servers]) {
		if (isRecord(container)) {
			const first = Object.values(container).find(isRecord);
			if (first) {
				return first;
			}
		}
	}
	if (typeof obj.url === "string" || obj.command !== undefined) {
		return obj;
	}
	return null;
}

// A remote MCP exposed via a stdio bridge — `npx -y mcp-remote <url>`,
// `mcp-proxy <url>`, `supergateway --sse <url>`, etc. The desktop speaks remote
// MCP (and handles its OAuth) directly, so pull the http(s) URL out of the
// command + args and use it as the server url.
function remoteUrlFromCommand(server: Record<string, unknown>): string | null {
	const tokens: string[] = [];
	if (typeof server.command === "string") {
		tokens.push(server.command);
	}
	if (Array.isArray(server.args)) {
		for (const arg of server.args) {
			if (typeof arg === "string") {
				tokens.push(arg);
			}
		}
	}
	const found = tokens.find((token) => /^https?:\/\//i.test(token.trim()));
	return found ? found.trim() : null;
}

// Prepend https:// when a URL is entered without a scheme (mcp.example.com → https://…).
export function normalizeRemoteUrl(raw: string): string {
	const value = raw.trim();
	if (!value) {
		return value;
	}
	return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

// A single pasted token that is (or becomes, once https:// is prepended) a remote URL — so a
// provider that hands you only a URL, with or without the scheme, can be pasted as-is. A
// scheme-less token must have a dotted host so a stray word isn't misread as a URL.
function bareUrlOrNull(raw: string): string | null {
	const value = raw.trim();
	if (
		!value ||
		/\s/.test(value) ||
		value.startsWith("{") ||
		value.startsWith("[")
	) {
		return null;
	}
	const hasScheme = /^https?:\/\//i.test(value);
	const candidate = hasScheme ? value : `https://${value}`;
	try {
		const parsed = new URL(candidate);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return null;
		}
		if (hasScheme || parsed.hostname.includes(".")) {
			return candidate;
		}
	} catch {
		// not a URL — fall through to JSON parsing
	}
	return null;
}

/** Parse a pasted MCP config (mcpServers-style JSON, a `servers` map, or a bare
 * single-server object) into a resolved app-owned `McpAttachInput`. v1 supports
 * REMOTE (URL) servers with optional `headers`/`tools`; a command/stdio-only server
 * is rejected with a clear message. Returns `{ error }` on any problem. */
export function parseCustomMcpConfig(
	json: string,
	ownerAppId: string,
): { attach: McpAttachInput } | { error: string } {
	const trimmed = json.trim();
	if (!trimmed) {
		return { error: "Paste an MCP server config." };
	}
	// Many providers give ONLY a remote MCP URL (e.g. https://mcp.heygen.com/mcp/v1/) for an
	// "add custom connector" flow — accept a bare URL as shorthand for { url }. No headers ⇒
	// treated as OAuth, so sign-in opens on add (same as a headerless JSON config).
	const bare = bareUrlOrNull(trimmed);
	if (bare) {
		return {
			attach: {
				id: ownerAppId,
				mcpUrl: bare,
				holabossHosted: false,
				headerKeys: {},
				queryKeys: {},
				envKeys: {},
				tools: [],
				ownerAppId,
			},
		};
	}
	const parsed = safeJsonParse(trimmed);
	if (parsed === undefined) {
		return { error: "That isn't valid JSON." };
	}
	if (!isRecord(parsed)) {
		return { error: "Expected a JSON object." };
	}
	const server = pickServerObject(parsed);
	if (!server) {
		return { error: "No MCP server found in the config." };
	}
	const directUrl = typeof server.url === "string" ? server.url.trim() : "";
	const url = normalizeRemoteUrl(
		directUrl || remoteUrlFromCommand(server) || "",
	);
	if (!url) {
		if (server.command !== undefined) {
			return {
				error:
					"This looks like a local (stdio) MCP server — use its remote URL, or an 'npx mcp-remote <url>' bridge config.",
			};
		}
		return { error: 'The MCP server needs a "url".' };
	}
	const headerKeys = normalizeStringMap(server.headers);
	const tools = Array.isArray(server.tools)
		? server.tools.filter(
				(tool): tool is string =>
					typeof tool === "string" && tool.trim().length > 0,
			)
		: [];
	return {
		attach: {
			id: ownerAppId,
			mcpUrl: url,
			holabossHosted: false,
			headerKeys,
			queryKeys: {},
			envKeys: {},
			tools,
			ownerAppId,
		},
	};
}
