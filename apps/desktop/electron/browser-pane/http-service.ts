/**
 * Renderer-→runtime browser HTTP bridge (BP-HTTP-SERVICE).
 *
 * Each desktop run launches a tiny localhost HTTP server. Module agents
 * inside the runtime call this server (via the runtime's
 * `desktop_browser` capability config) to drive the in-app browser:
 * navigate, click, type, evaluate, screenshot, list tabs, plus
 * observability routes (console / errors / requests / cookies) and
 * cookie set.
 *
 * This module owns the route handler. Server lifecycle (start/stop,
 * port allocation, auth-token rotation, capability-config sync) stays
 * in main.ts because it's tied to runtimeStatus + emitRuntimeState.
 */
import {
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import type { BrowserSpaceId } from "../../shared/browser-pane-protocol.js";

export interface OperatorSurfaceContextPayload {
  active_surface_id: string | null;
  surfaces: unknown[];
}

export interface BrowserHttpServiceDeps {
  getActiveWorkspaceId: () => string;
  listBrowserProfiles: () => Array<{
    id: string;
    name: string;
    running?: boolean;
    /** Whether this is the user's pinned default browser (drives no-profile calls). */
    isDefault?: boolean;
  }>;
  launchBrowserProfile: (
    profileId: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  closeBrowserProfile: (profileId: string) => { ok: boolean };
  /**
   * The profile a browser DRIVE targets when the request carries no explicit
   * `x-holaboss-browser-profile-id` header. Since the embedded browser is gone,
   * this makes the agent's browser tools always act on a real profile window
   * (the always-present "Default" profile) instead of the dead Electron tab —
   * so `browser_navigate` etc. auto-launch + drive a profile with no prior
   * `browser_use_profile` / `browser_launch_profile` call.
   */
  defaultBrowserProfileId: () => string | null;
  /**
   * Full-parity CDP drive for a profile with a LIVE spawned Chromium. When
   * present + `isLive`, the control service serves the profile's low-level
   * browser ops from the real window over CDP instead of the Electron tab.
   */
  profileCdp?: {
    isLive: (profileId: string) => boolean;
    /** Launch the profile's Chromium if not already running; resolves live-ness. */
    ensureLive: (profileId: string) => Promise<boolean>;
    /** Open a real new tab in the profile's Chromium and navigate it. */
    openTab: (
      profileId: string,
      url: string,
      sessionId?: string | null,
    ) => Promise<{
      url: string;
      title: string;
      loading: boolean;
      canGoBack: boolean;
      canGoForward: boolean;
    }>;
    evaluate: (
      profileId: string,
      expression: string,
      sessionId?: string | null,
    ) => Promise<unknown>;
    pageInfo: (
      profileId: string,
      sessionId?: string | null,
    ) => Promise<{
      url: string;
      title: string;
      loading: boolean;
      canGoBack: boolean;
      canGoForward: boolean;
    }>;
    navigate: (
      profileId: string,
      url: string,
      sessionId?: string | null,
    ) => Promise<void>;
    screenshot: (
      profileId: string,
      options: {
        fullPage?: boolean;
        format?: "png" | "jpeg";
        quality?: number;
      },
      sessionId?: string | null,
    ) => Promise<Buffer>;
    mouse: (
      profileId: string,
      x: number,
      y: number,
      action: "click" | "double_click" | "hover" | "context",
      sessionId?: string | null,
    ) => Promise<void>;
    setCookie: (
      profileId: string,
      cookie: {
        name: string;
        value: string;
        url?: string;
        domain?: string;
        path?: string;
        secure?: boolean;
        httpOnly?: boolean;
        sameSite?: "Strict" | "Lax" | "None";
        expires?: number;
      },
    ) => Promise<void>;
    keyboard: (
      profileId: string,
      options: {
        action: "press" | "insert_text";
        text?: string;
        key?: string;
        clear?: boolean;
        submit?: boolean;
      },
      sessionId?: string | null,
    ) => Promise<void>;
    cookies: (
      profileId: string,
      filter: { url?: string; name?: string; domain?: string },
      sessionId?: string | null,
    ) => Promise<
      Array<{
        name: string;
        value: string;
        domain: string;
        path: string;
        secure: boolean;
        httpOnly: boolean;
        session: boolean;
        sameSite: string;
        expirationDate: number | null;
      }>
    >;
  };
  // Same driver contract as profileCdp, but keyed by a HolaApp id instead of a
  // browser-profile id — it drives that app's own Electron BrowserView (the view
  // the user sees). Selected when the request carries `x-holaboss-browser-space: app`.
  appSurfaceCdp?: BrowserHttpServiceDeps["profileCdp"];
  getAuthToken: () => string;
  homeUrl: string;
  browserSpaceId: (
    value?: string | null,
    fallback?: BrowserSpaceId,
  ) => BrowserSpaceId;

  operatorSurfaceContextPayload: (
    workspaceId: string,
  ) => OperatorSurfaceContextPayload;
}

export interface BrowserHttpService {
  handleRequest: (
    request: IncomingMessage,
    response: ServerResponse<IncomingMessage>,
  ) => Promise<void>;
}

const INTERACTIVE_ELEMENTS_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "[role='button']",
  "[role='link']",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]",
].join(",");

function tokenFromRequest(request: IncomingMessage): string {
  const raw = request.headers["x-holaboss-desktop-token"];
  if (Array.isArray(raw)) return (raw[0] || "").trim();
  return typeof raw === "string" ? raw.trim() : "";
}

function workspaceIdFromRequest(request: IncomingMessage): string {
  const raw = request.headers["x-holaboss-workspace-id"];
  if (Array.isArray(raw)) return (raw[0] || "").trim();
  return typeof raw === "string" ? raw.trim() : "";
}

function browserProfileIdFromRequest(request: IncomingMessage): string {
  const raw = request.headers["x-holaboss-browser-profile-id"];
  if (Array.isArray(raw)) return (raw[0] || "").trim();
  return typeof raw === "string" ? raw.trim() : "";
}

function sessionIdFromRequest(request: IncomingMessage): string {
  const raw = request.headers["x-holaboss-session-id"];
  if (Array.isArray(raw)) return (raw[0] || "").trim();
  return typeof raw === "string" ? raw.trim() : "";
}

function spaceFromRequest(
  request: IncomingMessage,
  browserSpaceId: BrowserHttpServiceDeps["browserSpaceId"],
): BrowserSpaceId {
  const raw = request.headers["x-holaboss-browser-space"];
  if (Array.isArray(raw)) return browserSpaceId(raw[0] || "", "agent");
  return browserSpaceId(typeof raw === "string" ? raw.trim() : "", "agent");
}

function writeJson(
  response: ServerResponse<IncomingMessage>,
  statusCode: number,
  payload: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(payload)}\n`);
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Routes that DRIVE a page (and are CDP-backed). A profile-targeted request to
 * one of these auto-launches the profile's Chromium so browsing always uses the
 * real window. Non-driving routes (health/profiles/tabs/…) never auto-launch.
 */
const CDP_DRIVING_PATHS: ReadonlySet<string> = new Set([
  "/api/v1/browser/page",
  "/api/v1/browser/navigate",
  "/api/v1/browser/evaluate",
  "/api/v1/browser/mouse",
  "/api/v1/browser/keyboard",
  "/api/v1/browser/screenshot",
  "/api/v1/browser/cookies",
]);

function serializeEvalResult(value: unknown): unknown {
  if (value === undefined) return null;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

/**
 * Read pixel dimensions straight from a PNG/JPEG buffer — used for the CDP
 * screenshot response, where Playwright returns only bytes (unlike Electron's
 * NativeImage.getSize()).
 */
function imageBufferDimensions(buffer: Buffer): {
  width: number;
  height: number;
} {
  // PNG: 8-byte signature, then IHDR with width@16 / height@20 (big-endian).
  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  // JPEG: scan segments for a Start-Of-Frame marker (0xFFC0..0xFFCF, minus the
  // non-SOF C4/C8/CC), which carries height@+5 / width@+7.
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
  }
  return { width: 0, height: 0 };
}

/**
 * Pull rounded {x,y} out of a resolved mouse-action payload (`{ result: {x,y} }`).
 * Returns NaN coordinates when absent, matching the inline Electron-path logic.
 */
function extractResolvedPoint(resolvedAction: unknown): { x: number; y: number } {
  const num = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? Math.round(value) : NaN;
  const resolvedPoint =
    resolvedAction && typeof resolvedAction === "object" && !Array.isArray(resolvedAction)
      ? (resolvedAction as Record<string, unknown>).result
      : null;
  if (
    resolvedPoint &&
    typeof resolvedPoint === "object" &&
    !Array.isArray(resolvedPoint)
  ) {
    const point = resolvedPoint as Record<string, unknown>;
    return { x: num(point.x), y: num(point.y) };
  }
  return { x: NaN, y: NaN };
}

function positiveIntegerPayload(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function optionalExpressionPayload(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function focusIndexedKeyboardTargetExpression(index: number): string {
  return `(() => {
    const selector = ${JSON.stringify(INTERACTIVE_ELEMENTS_SELECTOR)};
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const target = Array.from(document.querySelectorAll(selector)).filter((element) => isVisible(element))[${index - 1}] || null;
    if (!(target instanceof HTMLElement)) {
      throw new Error(${JSON.stringify(`No interactive element found for index ${index}.`)});
    }
    const editTarget =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.isContentEditable
        ? target
        : target.querySelector("input, textarea, [contenteditable]:not([contenteditable='false'])");
    if (!(editTarget instanceof HTMLElement)) {
      throw new Error(${JSON.stringify(`Element at index ${index} is not text-editable.`)});
    }
    editTarget.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    if (typeof editTarget.focus === "function") {
      try {
        editTarget.focus({ preventScroll: true });
      } catch {
        editTarget.focus();
      }
    }
    return {
      ok: true,
      index: ${index},
      tag_name: editTarget.tagName.toLowerCase(),
      role: editTarget.getAttribute("role") || "",
      editable: true,
    };
  })()`;
}

export function createBrowserHttpService(
  deps: BrowserHttpServiceDeps,
): BrowserHttpService {
  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse<IncomingMessage>,
  ): Promise<void> {
    try {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      const pathname = requestUrl.pathname;
      const method = (request.method || "GET").toUpperCase();
      const targetSpace = spaceFromRequest(request, deps.browserSpaceId);
      // A HolaApp-owned session drives its OWN Electron app surface (the view the
      // user is looking at), not the separate agent-profile Chromium. The runtime
      // relay signals this with `x-holaboss-browser-space: app` and the app id in
      // the profile header. We read the raw header (the normalized space type only
      // knows "agent") and, when it's "app", swap the driver to the app-surface
      // one — keyed by the app id exactly where profile ops are keyed by profile id.
      const rawBrowserSpace = (() => {
        const raw = request.headers["x-holaboss-browser-space"];
        if (Array.isArray(raw)) return (raw[0] || "").trim();
        return typeof raw === "string" ? raw.trim() : "";
      })();
      const isAppSurface = rawBrowserSpace === "app" && !!deps.appSurfaceCdp;
      const activeCdp = isAppSurface ? deps.appSurfaceCdp : deps.profileCdp;
      const requestedProfileId = browserProfileIdFromRequest(request);
      const requestedWorkspaceId = workspaceIdFromRequest(request);
      // Per-agent tab isolation: the calling agent's session id scopes which tab
      // in the profile a DRIVE acts on, so concurrent agents on the same profile
      // don't clobber each other. Empty (the human / legacy) → the profile's
      // front tab.
      const requestedSessionId = sessionIdFromRequest(request);
      // Profile is the primary browser selector (there is a single root
      // workspace). Fall back to the workspace / active browser only when no
      // profile is sent — legacy callers + the embedded browser during the
      // migration.
      const targetWorkspaceId =
        requestedProfileId || requestedWorkspaceId || deps.getActiveWorkspaceId();

      // The profile a DRIVE acts on: the explicit header if present, else the
      // app's Default profile. The embedded browser is gone, so browser tools
      // must always land on a real profile window — defaulting here makes
      // `browser_navigate` (and the whole act/state loop) spawn + drive the
      // Default profile even when the agent never called browser_use_profile.
      const driveProfileId = activeCdp
        ? requestedProfileId || (deps.defaultBrowserProfileId() ?? "")
        : "";

      // Full parity: a browser DRIVE auto-launches the target profile's real
      // Chromium (if needed) and acts on that window over CDP instead of the
      // embedded tab. Routes below branch on this and fall through to the
      // Electron path when null (non-driving routes never auto-launch).
      let cdpProfileId: string | null = null;
      if (
        activeCdp &&
        driveProfileId &&
        CDP_DRIVING_PATHS.has(pathname) &&
        (await activeCdp.ensureLive(driveProfileId))
      ) {
        cdpProfileId = driveProfileId;
      }

      const authToken = deps.getAuthToken();
      if (!authToken || tokenFromRequest(request) !== authToken) {
        writeJson(response, 401, { error: "Unauthorized." });
        return;
      }

      // Profile-only page ops. The embedded in-app browser is gone: a page DRIVE
      // acts on a spawned Chrome profile over CDP. If no profile can be launched
      // (`cdpProfileId` unresolved), fail clearly here instead of falling through
      // to the dead BrowserView engine and silently driving/creating an invisible
      // in-app tab. Non-driving routes (health/profiles/launch/close) are exempt.
      if (CDP_DRIVING_PATHS.has(pathname) && !cdpProfileId) {
        writeJson(response, 409, {
          error: isAppSurface
            ? "This HolaApp's surface is not open, so its browser view can't be inspected right now."
            : "No browser profile is available to drive. Make sure Google Chrome is installed so a Browser Profile can launch.",
        });
        return;
      }

      if (method === "GET" && pathname === "/api/v1/browser/health") {
        writeJson(response, 200, { ok: true });
        return;
      }

      if (method === "GET" && pathname === "/api/v1/browser/profiles") {
        writeJson(response, 200, { profiles: deps.listBrowserProfiles() });
        return;
      }

      // Launch / close a profile's native Chromium window. The target profile is
      // carried in the x-holaboss-browser-profile-id header (resolved agent-side).
      if (
        method === "POST" &&
        pathname === "/api/v1/browser/profiles/launch"
      ) {
        if (!requestedProfileId) {
          writeJson(response, 400, { error: "A browser profile id is required." });
          return;
        }
        const result = await deps.launchBrowserProfile(requestedProfileId);
        writeJson(response, result.ok ? 200 : 502, {
          profile_id: requestedProfileId,
          ...result,
        });
        return;
      }

      if (
        method === "POST" &&
        pathname === "/api/v1/browser/profiles/close"
      ) {
        if (!requestedProfileId) {
          writeJson(response, 400, { error: "A browser profile id is required." });
          return;
        }
        writeJson(response, 200, {
          profile_id: requestedProfileId,
          ...deps.closeBrowserProfile(requestedProfileId),
        });
        return;
      }

      if (!targetWorkspaceId) {
        writeJson(response, 409, {
          error: "No active browser workspace is available.",
        });
        return;
      }

      // Single-tab snapshot for the drive profile's live Chrome window, in the
      // shape the /tabs family returns. Used by GET /tabs and the best-effort
      // /tabs/select + /tabs/close responses.
      const driveProfileTabSnapshot = async (): Promise<
        Record<string, unknown>
      > => {
        if (
          activeCdp &&
          driveProfileId &&
          (await activeCdp.ensureLive(driveProfileId))
        ) {
          const info = await activeCdp.pageInfo(
            driveProfileId,
            requestedSessionId,
          );
          return {
            space: targetSpace,
            activeTabId: driveProfileId,
            tabs: [
              {
                id: driveProfileId,
                url: info.url,
                title: info.title,
                active: true,
              },
            ],
            tabCounts: { agent: 1 },
            sessionId: null,
            lifecycleState: null,
            controlMode: "none",
            controlSessionId: null,
          };
        }
        return {
          space: targetSpace,
          activeTabId: "",
          tabs: [],
          tabCounts: { agent: 0 },
          sessionId: null,
          lifecycleState: null,
          controlMode: "none",
          controlSessionId: null,
        };
      };

      if (method === "GET" && pathname === "/api/v1/browser/tabs") {
        writeJson(response, 200, await driveProfileTabSnapshot());
        return;
      }

      if (method === "GET" && pathname === "/api/v1/browser/downloads") {
        writeJson(response, 200, { downloads: [] });
        return;
      }

      if (method === "GET" && pathname === "/api/v1/browser/console") {
        writeJson(response, 200, {
          entries: [],
          total: 0,
          truncated: false,
        });
        return;
      }

      if (method === "GET" && pathname === "/api/v1/browser/errors") {
        writeJson(response, 200, { errors: [], total: 0, truncated: false });
        return;
      }

      if (method === "GET" && pathname === "/api/v1/browser/requests") {
        writeJson(response, 200, {
          requests: [],
          total: 0,
          truncated: false,
        });
        return;
      }

      if (method === "GET" && pathname.startsWith("/api/v1/browser/requests/")) {
        writeJson(response, 404, { error: "Browser request not found." });
        return;
      }

      if (method === "GET" && pathname === "/api/v1/browser/cookies") {
        const cookies = await activeCdp!.cookies(
          cdpProfileId!,
          {
            url: requestUrl.searchParams.get("url")?.trim() || undefined,
            name: requestUrl.searchParams.get("name")?.trim() || undefined,
            domain: requestUrl.searchParams.get("domain")?.trim() || undefined,
          },
          requestedSessionId,
        );
        writeJson(response, 200, { cookies });
        return;
      }

      if (method === "GET" && pathname === "/api/v1/browser/page") {
        const info = await activeCdp!.pageInfo(cdpProfileId!, requestedSessionId);
        writeJson(response, 200, {
          tabId: cdpProfileId,
          url: info.url,
          title: info.title,
          loading: info.loading,
          initialized: true,
          canGoBack: info.canGoBack,
          canGoForward: info.canGoForward,
          error: "",
        });
        return;
      }

      if (
        method === "GET" &&
        pathname === "/api/v1/browser/operator-surface-context"
      ) {
        writeJson(
          response,
          200,
          deps.operatorSurfaceContextPayload(targetWorkspaceId),
        );
        return;
      }

      if (method === "POST" && pathname === "/api/v1/browser/navigate") {
        const payload = await readJsonBody(request);
        const targetUrl =
          typeof payload.url === "string" ? payload.url.trim() : "";
        if (!targetUrl) {
          writeJson(response, 400, { error: "Field 'url' is required." });
          return;
        }
        await activeCdp!.navigate(
          cdpProfileId!,
          targetUrl,
          requestedSessionId,
        );
        const info = await activeCdp!.pageInfo(cdpProfileId!, requestedSessionId);
        writeJson(response, 200, {
          tabId: cdpProfileId,
          url: info.url,
          title: info.title,
          loading: info.loading,
          initialized: true,
          canGoBack: info.canGoBack,
          canGoForward: info.canGoForward,
          error: "",
        });
        return;
      }

      if (method === "POST" && pathname === "/api/v1/browser/tabs/select") {
        const payload = await readJsonBody(request);
        const tabId =
          typeof payload.tab_id === "string" && payload.tab_id.trim()
            ? payload.tab_id.trim()
            : typeof payload.tabId === "string" && payload.tabId.trim()
              ? payload.tabId.trim()
              : "";
        if (!tabId) {
          writeJson(response, 400, { error: "Field 'tab_id' is required." });
          return;
        }
        // A spawned profile is a single-window drive: there are no selectable
        // in-app tabs to switch. Best-effort — reflect the live profile's tab.
        if (
          activeCdp &&
          driveProfileId &&
          (await activeCdp.ensureLive(driveProfileId))
        ) {
          writeJson(response, 200, await driveProfileTabSnapshot());
          return;
        }
        writeJson(response, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/api/v1/browser/tabs/close") {
        const payload = await readJsonBody(request);
        const tabId =
          typeof payload.tab_id === "string" && payload.tab_id.trim()
            ? payload.tab_id.trim()
            : typeof payload.tabId === "string" && payload.tabId.trim()
              ? payload.tabId.trim()
              : "";
        if (!tabId) {
          writeJson(response, 400, { error: "Field 'tab_id' is required." });
          return;
        }
        // No closable in-app tab (the profile window is user/CDP-owned).
        // Best-effort — reflect the live profile's tab.
        if (
          activeCdp &&
          driveProfileId &&
          (await activeCdp.ensureLive(driveProfileId))
        ) {
          writeJson(response, 200, await driveProfileTabSnapshot());
          return;
        }
        writeJson(response, 200, { ok: true });
        return;
      }

      if (method === "POST" && pathname === "/api/v1/browser/cookies") {
        const payload = await readJsonBody(request);
        const targetCookieUrl =
          typeof payload.url === "string" && payload.url.trim()
            ? payload.url.trim()
            : "";
        const cookieName =
          typeof payload.name === "string" && payload.name.trim()
            ? payload.name.trim()
            : "";
        if (!targetCookieUrl) {
          writeJson(response, 400, {
            error:
              "Field 'url' is required when there is no active browser page.",
          });
          return;
        }
        if (!cookieName) {
          writeJson(response, 400, { error: "Field 'name' is required." });
          return;
        }
        if (
          !activeCdp ||
          !driveProfileId ||
          !(await activeCdp.ensureLive(driveProfileId))
        ) {
          writeJson(response, 409, {
            error: "No browser profile is available.",
          });
          return;
        }
        try {
          const expirationDate =
            typeof payload.expiration_date === "number" &&
            Number.isFinite(payload.expiration_date)
              ? payload.expiration_date
              : typeof payload.expirationDate === "number" &&
                  Number.isFinite(payload.expirationDate)
                ? payload.expirationDate
                : undefined;
          const sameSiteRaw =
            payload.same_site === "unspecified" ||
            payload.same_site === "no_restriction" ||
            payload.same_site === "lax" ||
            payload.same_site === "strict"
              ? payload.same_site
              : payload.sameSite === "unspecified" ||
                  payload.sameSite === "no_restriction" ||
                  payload.sameSite === "lax" ||
                  payload.sameSite === "strict"
                ? payload.sameSite
                : "";
          const sameSite =
            sameSiteRaw === "no_restriction"
              ? "None"
              : sameSiteRaw === "lax"
                ? "Lax"
                : sameSiteRaw === "strict"
                  ? "Strict"
                  : undefined;
          await activeCdp.setCookie(driveProfileId, {
            name: cookieName,
            value: typeof payload.value === "string" ? payload.value : "",
            url: targetCookieUrl,
            ...(typeof payload.domain === "string" && payload.domain.trim()
              ? { domain: payload.domain.trim() }
              : {}),
            ...(typeof payload.path === "string" && payload.path.trim()
              ? { path: payload.path.trim() }
              : {}),
            ...(typeof payload.secure === "boolean"
              ? { secure: payload.secure }
              : {}),
            ...(typeof payload.http_only === "boolean"
              ? { httpOnly: payload.http_only }
              : typeof payload.httpOnly === "boolean"
                ? { httpOnly: payload.httpOnly }
                : {}),
            ...(sameSite ? { sameSite } : {}),
            ...(typeof expirationDate === "number"
              ? { expires: expirationDate }
              : {}),
          });
          const cookies = await activeCdp.cookies(
            driveProfileId,
            { url: targetCookieUrl, name: cookieName },
            requestedSessionId,
          );
          writeJson(response, 200, {
            ok: true,
            cookie: cookies[0] ?? null,
          });
        } catch (error) {
          writeJson(response, 400, {
            error:
              error instanceof Error
                ? error.message
                : "Failed to set browser cookie.",
          });
        }
        return;
      }

      if (method === "POST" && pathname === "/api/v1/browser/tabs") {
        const payload = await readJsonBody(request);
        const targetUrl =
          typeof payload.url === "string" && payload.url.trim()
            ? payload.url.trim()
            : deps.homeUrl;
        // Profile drive: open a real new tab in the profile's Chromium (auto-
        // launching it first). `/tabs` isn't a CDP_DRIVING_PATH — it never
        // auto-launches for GET (list) — so resolve + ensure-live inline here.
        if (
          activeCdp &&
          driveProfileId &&
          (await activeCdp.ensureLive(driveProfileId))
        ) {
          const info = await activeCdp.openTab(
            driveProfileId,
            targetUrl,
            requestedSessionId,
          );
          writeJson(response, 200, {
            tabId: driveProfileId,
            activeTabId: driveProfileId,
            url: info.url,
            title: info.title,
            loading: info.loading,
            initialized: true,
            canGoBack: info.canGoBack,
            canGoForward: info.canGoForward,
            error: "",
            tabs: [
              {
                id: driveProfileId,
                url: info.url,
                title: info.title,
                active: true,
              },
            ],
          });
          return;
        }
        // Profile-only: with no launchable profile we must NOT mint an in-app
        // Electron BrowserView (that path is retired). Fail clearly instead.
        writeJson(response, 409, {
          error:
            "No browser profile is available to open a tab. Make sure Google Chrome is installed so a Browser Profile can launch.",
        });
        return;
      }

      if (method === "POST" && pathname === "/api/v1/browser/evaluate") {
        const payload = await readJsonBody(request);
        const expression =
          typeof payload.expression === "string"
            ? payload.expression.trim()
            : "";
        if (!expression) {
          writeJson(response, 400, {
            error: "Field 'expression' is required.",
          });
          return;
        }
        const result = await activeCdp!.evaluate(cdpProfileId!, expression, requestedSessionId);
        writeJson(response, 200, {
          tabId: cdpProfileId,
          result: serializeEvalResult(result),
        });
        return;
      }

      if (method === "POST" && pathname === "/api/v1/browser/context-click") {
        const payload = await readJsonBody(request);
        const x =
          typeof payload.x === "number" && Number.isFinite(payload.x)
            ? Math.round(payload.x)
            : NaN;
        const y =
          typeof payload.y === "number" && Number.isFinite(payload.y)
            ? Math.round(payload.y)
            : NaN;
        if (!Number.isFinite(x) || x < 0 || !Number.isFinite(y) || y < 0) {
          writeJson(response, 400, {
            error: "Fields 'x' and 'y' must be non-negative numbers.",
          });
          return;
        }
        if (
          !activeCdp ||
          !driveProfileId ||
          !(await activeCdp.ensureLive(driveProfileId))
        ) {
          writeJson(response, 409, {
            error: "No browser profile is available.",
          });
          return;
        }
        await activeCdp.mouse(
          driveProfileId,
          x,
          y,
          "context",
          requestedSessionId,
        );
        writeJson(response, 200, {
          ok: true,
          tabId: driveProfileId,
          x,
          y,
        });
        return;
      }

      if (method === "POST" && pathname === "/api/v1/browser/mouse") {
        const payload = await readJsonBody(request);
        let x =
          typeof payload.x === "number" && Number.isFinite(payload.x)
            ? Math.round(payload.x)
            : NaN;
        let y =
          typeof payload.y === "number" && Number.isFinite(payload.y)
            ? Math.round(payload.y)
            : NaN;
        const action =
          payload.action === "double_click" || payload.action === "hover"
            ? payload.action
            : "click";
        const expression = optionalExpressionPayload(payload.expression);
        if (
          !expression &&
          (!Number.isFinite(x) || x < 0 || !Number.isFinite(y) || y < 0)
        ) {
          writeJson(response, 400, {
            error: "Fields 'x' and 'y' must be non-negative numbers when no expression is provided.",
          });
          return;
        }
        let resolvedAction: unknown = null;
        if (expression) {
          resolvedAction = serializeEvalResult(
            await activeCdp!.evaluate(cdpProfileId!, expression, requestedSessionId),
          );
          const point = extractResolvedPoint(resolvedAction);
          x = point.x;
          y = point.y;
          if (!Number.isFinite(x) || x < 0 || !Number.isFinite(y) || y < 0) {
            throw new Error(
              "Resolved browser mouse action did not provide valid coordinates.",
            );
          }
        }
        await activeCdp!.mouse(
          cdpProfileId!,
          x,
          y,
          action,
          requestedSessionId,
        );
        writeJson(response, 200, {
          ok: true,
          tabId: cdpProfileId,
          action,
          x,
          y,
          ...(resolvedAction && typeof resolvedAction === "object"
            ? { resolved_action: resolvedAction }
            : {}),
        });
        return;
      }

      if (method === "POST" && pathname === "/api/v1/browser/keyboard") {
        const payload = await readJsonBody(request);
        const action = payload.action === "press" ? "press" : "insert_text";
        const text = typeof payload.text === "string" ? payload.text : "";
        const key =
          typeof payload.key === "string" && payload.key.trim()
            ? payload.key.trim()
            : "";
        const clear = payload.clear === true;
        const submit = payload.submit === true;
        const index = positiveIntegerPayload(payload.index);
        const expression = optionalExpressionPayload(payload.expression);
        if (action === "press" && !key) {
          writeJson(response, 400, {
            error: "Field 'key' is required for keyboard press actions.",
          });
          return;
        }
        let resolvedAction: unknown = null;
        let focusedTarget: unknown = null;
        if (expression) {
          resolvedAction = serializeEvalResult(
            await activeCdp!.evaluate(cdpProfileId!, expression, requestedSessionId),
          );
        } else if (index !== null) {
          focusedTarget = serializeEvalResult(
            await activeCdp!.evaluate(
              cdpProfileId!,
              focusIndexedKeyboardTargetExpression(index),
              requestedSessionId,
            ),
          );
        }
        await activeCdp!.keyboard(
          cdpProfileId!,
          {
            action,
            text,
            key,
            clear,
            submit,
          },
          requestedSessionId,
        );
        writeJson(response, 200, {
          ok: true,
          tabId: cdpProfileId,
          action,
          text_length: action === "insert_text" ? text.length : 0,
          key: action === "press" ? key : "",
          clear,
          submit,
          ...(resolvedAction && typeof resolvedAction === "object"
            ? { resolved_action: resolvedAction }
            : {}),
          ...(focusedTarget && typeof focusedTarget === "object"
            ? (focusedTarget as Record<string, unknown>)
            : {}),
        });
        return;
      }

      if (method === "POST" && pathname === "/api/v1/browser/screenshot") {
        const payload = await readJsonBody(request);
        const format = payload.format === "jpeg" ? "jpeg" : "png";
        const qualityRaw =
          typeof payload.quality === "number" ? payload.quality : 90;
        const quality = Math.max(0, Math.min(100, Math.round(qualityRaw)));
        const fullPage = payload.full_page === true;
        const buffer = await activeCdp!.screenshot(
          cdpProfileId!,
          {
            fullPage,
            format,
            quality,
          },
          requestedSessionId,
        );
        const { width, height } = imageBufferDimensions(buffer);
        writeJson(response, 200, {
          tabId: cdpProfileId,
          mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
          width,
          height,
          base64: buffer.toString("base64"),
        });
        return;
      }

      writeJson(response, 404, { error: "Not found." });
    } catch (error) {
      writeJson(response, 500, {
        error:
          error instanceof Error
            ? error.message
            : "Browser service request failed.",
      });
    }
  }

  return { handleRequest };
}
