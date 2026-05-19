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
import {
  type BrowserWindow,
  type Session,
  type WebContents,
} from "electron";

import type { BrowserSpaceId } from "../../shared/browser-pane-protocol.js";
import {
  browserConsoleLevelRank,
  browserObservabilityLimit,
  browserObservedErrorSource,
  browserRequestFailure,
  browserRequestSummary,
  type BrowserConsoleEntry,
  type BrowserObservedError,
  type BrowserRequestRecord,
} from "./observability.js";

export interface HttpServiceTabRecord {
  view: { webContents: WebContents };
  state: { id: string };
  consoleEntries: BrowserConsoleEntry[];
  errorEntries: BrowserObservedError[];
  requests: Map<string, BrowserRequestRecord>;
  requestOrder: string[];
}

export interface HttpServiceWorkspaceState {
  workspaceId: string;
  session: Session;
  downloads: unknown[];
}

export interface OperatorSurfaceContextPayload {
  active_surface_id: string | null;
  surfaces: unknown[];
}

export interface BrowserHttpServiceDeps {
  getMainWindow: () => BrowserWindow | null;
  getActiveWorkspaceId: () => string;
  getAuthToken: () => string;
  homeUrl: string;
  browserSpaceId: (
    value?: string | null,
    fallback?: BrowserSpaceId,
  ) => BrowserSpaceId;

  ensureBrowserWorkspace: (
    workspaceId: string,
    space: BrowserSpaceId,
    sessionId: string | null,
  ) => Promise<HttpServiceWorkspaceState | null>;

  ensureUserBrowserLock: (
    workspaceId: string,
    sessionId: string,
    reason: string,
  ) => { ok: true } | { ok: false; lockHolderSessionId: string };

  touchAgentSessionBrowserSpace: (
    workspaceId: string,
    sessionId: string,
  ) => void;

  browserWorkspaceSnapshot: (
    workspaceId: string,
    space: BrowserSpaceId,
    sessionId: string | null,
    options: { useVisibleAgentSession: boolean },
  ) => unknown;

  browserTabSpaceState: (
    workspace: HttpServiceWorkspaceState | null,
    space: BrowserSpaceId,
    sessionId: string | null,
    options: { createIfMissing?: boolean; useVisibleAgentSession?: boolean },
  ) => { activeTabId: string } | null;

  getActiveBrowserTab: (
    workspaceId: string,
    space: BrowserSpaceId,
    sessionId: string | null,
    options: { useVisibleAgentSession: boolean },
  ) => HttpServiceTabRecord | null;

  syncBrowserState: (
    workspaceId: string,
    tabId: string,
    space: BrowserSpaceId,
    sessionId: string | null,
  ) => void;

  navigateActiveBrowserTab: (
    workspaceId: string,
    targetUrl: string,
    space: BrowserSpaceId,
    sessionId: string | null,
  ) => Promise<unknown>;

  createBrowserTab: (
    workspaceId: string,
    options: {
      url: string;
      browserSpace: BrowserSpaceId;
      sessionId: string | null;
    },
  ) => string | null;

  setActiveBrowserTab: (
    tabId: string,
    options: {
      workspaceId: string;
      space: BrowserSpaceId;
      sessionId: string | null;
      useVisibleAgentSession: boolean;
    },
  ) => Promise<unknown>;

  closeBrowserTab: (
    tabId: string,
    options: {
      workspaceId: string;
      space: BrowserSpaceId;
      sessionId: string | null;
      useVisibleAgentSession: boolean;
    },
  ) => Promise<unknown>;

  updateAttachedBrowserView: () => void;
  emitBrowserState: (workspaceId: string, space: BrowserSpaceId) => void;
  persistWorkspace: (workspaceId: string) => Promise<void>;

  emitWorkbenchOpenBrowser: (payload: {
    workspaceId: string;
    url: string;
    space: BrowserSpaceId;
    sessionId: string | null;
  }) => void;

  operatorSurfaceContextPayload: (
    workspaceId: string,
  ) => OperatorSurfaceContextPayload;

  browserPagePayload: (tab: HttpServiceTabRecord) => Record<string, unknown>;
  withTemporarilyRenderedBrowserTab: <T>(
    tab: HttpServiceTabRecord,
    callback: () => Promise<T>,
    options?: {
      requireFocusedWindow?: boolean;
      workspaceId?: string | null;
      waitForRenderedFrame?: boolean;
    },
  ) => Promise<T>;

  withProgrammaticBrowserInput: <T>(
    webContents: WebContents,
    callback: () => Promise<T>,
  ) => Promise<T>;

  sendBrowserKeyPress: (
    webContents: WebContents,
    keyCode: string,
    modifiers?: Array<"meta" | "control">,
  ) => Promise<void>;

  clearFocusedBrowserTextInput: (webContents: WebContents) => Promise<void>;
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
  async function captureBrowserScreenshotWithRetries(
    tab: HttpServiceTabRecord,
  ): Promise<import("electron").NativeImage> {
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await tab.view.webContents.capturePage(undefined, {
          stayHidden: true,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        const shouldRetry = message.includes("UnknownVizError");
        if (!shouldRetry || attempt >= maxAttempts - 1) {
          throw error;
        }
        try {
          await tab.view.webContents.executeJavaScript("document.readyState", true);
        } catch {
          // Ignore renderer warmup failures and keep retrying.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error("Browser screenshot capture exhausted all retries.");
  }

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse<IncomingMessage>,
  ): Promise<void> {
    try {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      const pathname = requestUrl.pathname;
      const method = (request.method || "GET").toUpperCase();
      const targetSpace = spaceFromRequest(request, deps.browserSpaceId);
      const requestedWorkspaceId = workspaceIdFromRequest(request);
      const requestedSessionId = sessionIdFromRequest(request);
      const targetWorkspaceId =
        requestedWorkspaceId || deps.getActiveWorkspaceId();

      const authToken = deps.getAuthToken();
      if (!authToken || tokenFromRequest(request) !== authToken) {
        writeJson(response, 401, { error: "Unauthorized." });
        return;
      }

      if (method === "GET" && pathname === "/api/v1/browser/health") {
        writeJson(response, 200, { ok: true });
        return;
      }

      if (!targetWorkspaceId) {
        writeJson(response, 409, {
          error: "No active browser workspace is available.",
        });
        return;
      }

      const ensuredSessionId =
        targetSpace === "agent" ? requestedSessionId : null;
      const useVisibleAgentSession =
        targetSpace === "agent" && !requestedSessionId;

      const ensureTargetBrowserSpace = async (
        reason: string,
      ): Promise<HttpServiceWorkspaceState | null> => {
        const workspace = await deps.ensureBrowserWorkspace(
          targetWorkspaceId,
          targetSpace,
          ensuredSessionId,
        );
        if (!workspace) return null;
        if (targetSpace === "user") {
          if (!requestedSessionId) {
            writeJson(response, 400, {
              error:
                "Header 'x-holaboss-session-id' is required when targeting the user browser.",
            });
            return null;
          }
          const lockResult = deps.ensureUserBrowserLock(
            targetWorkspaceId,
            requestedSessionId,
            reason,
          );
          if (!lockResult.ok) {
            writeJson(response, 409, {
              error: "User browser is locked by another agent session.",
              code: "user_browser_locked",
              lock_holder_session_id: lockResult.lockHolderSessionId,
            });
            return null;
          }
        } else if (requestedSessionId) {
          deps.touchAgentSessionBrowserSpace(targetWorkspaceId, requestedSessionId);
        }
        return workspace;
      };

      if (method === "GET" && pathname === "/api/v1/browser/tabs") {
        if (!(await ensureTargetBrowserSpace("tabs"))) return;
        writeJson(
          response,
          200,
          deps.browserWorkspaceSnapshot(
            targetWorkspaceId,
            targetSpace,
            ensuredSessionId,
            { useVisibleAgentSession },
          ),
        );
        return;
      }

      if (method === "GET" && pathname === "/api/v1/browser/downloads") {
        const workspace = await ensureTargetBrowserSpace("downloads");
        if (!workspace) return;
        writeJson(response, 200, { downloads: workspace.downloads });
        return;
      }

      if (method === "GET" && pathname === "/api/v1/browser/console") {
        if (!(await ensureTargetBrowserSpace("console"))) return;
        const activeTab = deps.getActiveBrowserTab(
          targetWorkspaceId,
          targetSpace,
          ensuredSessionId,
          { useVisibleAgentSession },
        );
        if (!activeTab) {
          writeJson(response, 409, {
            error: "No active browser tab is available.",
          });
          return;
        }
        const requestedLevel = requestUrl.searchParams.get("level")?.trim() || "";
        const minimumLevel =
          requestedLevel === "debug" ||
          requestedLevel === "info" ||
          requestedLevel === "warning" ||
          requestedLevel === "error"
            ? requestedLevel
            : null;
        const filtered = [...activeTab.consoleEntries].filter((entry) =>
          minimumLevel
            ? browserConsoleLevelRank(entry.level) >=
              browserConsoleLevelRank(minimumLevel)
            : true,
        );
        const limit = browserObservabilityLimit(
          requestUrl.searchParams.get("limit"),
        );
        const entries = filtered.slice(-limit).reverse();
        writeJson(response, 200, {
          entries,
          total: filtered.length,
          truncated: filtered.length > entries.length,
        });
        return;
      }

      if (method === "GET" && pathname === "/api/v1/browser/errors") {
        if (!(await ensureTargetBrowserSpace("errors"))) return;
        const activeTab = deps.getActiveBrowserTab(
          targetWorkspaceId,
          targetSpace,
          ensuredSessionId,
          { useVisibleAgentSession },
        );
        if (!activeTab) {
          writeJson(response, 409, {
            error: "No active browser tab is available.",
          });
          return;
        }
        const requestedSource = browserObservedErrorSource(
          requestUrl.searchParams.get("source")?.trim() || null,
        );
        const filtered = [...activeTab.errorEntries].filter((entry) =>
          requestedSource ? entry.source === requestedSource : true,
        );
        const limit = browserObservabilityLimit(
          requestUrl.searchParams.get("limit"),
        );
        const errors = filtered.slice(-limit).reverse();
        writeJson(response, 200, {
          errors,
          total: filtered.length,
          truncated: filtered.length > errors.length,
        });
        return;
      }

      if (method === "GET" && pathname === "/api/v1/browser/requests") {
        if (!(await ensureTargetBrowserSpace("requests"))) return;
        const activeTab = deps.getActiveBrowserTab(
          targetWorkspaceId,
          targetSpace,
          ensuredSessionId,
          { useVisibleAgentSession },
        );
        if (!activeTab) {
          writeJson(response, 409, {
            error: "No active browser tab is available.",
          });
          return;
        }
        const requestedResourceType =
          requestUrl.searchParams.get("resource_type")?.trim().toLowerCase() ||
          "";
        const failuresOnly =
          requestUrl.searchParams.get("failures_only") === "true";
        const filtered = [...activeTab.requestOrder]
          .map((requestId) => activeTab.requests.get(requestId) ?? null)
          .filter(
            (request): request is BrowserRequestRecord => Boolean(request),
          )
          .filter((request) =>
            requestedResourceType
              ? request.resourceType.toLowerCase() === requestedResourceType
              : true,
          )
          .filter((request) =>
            failuresOnly ? browserRequestFailure(request) : true,
          );
        const limit = browserObservabilityLimit(
          requestUrl.searchParams.get("limit"),
        );
        const requests = filtered
          .slice(-limit)
          .reverse()
          .map((record) => browserRequestSummary(record));
        writeJson(response, 200, {
          requests,
          total: filtered.length,
          truncated: filtered.length > requests.length,
        });
        return;
      }

      if (method === "GET" && pathname.startsWith("/api/v1/browser/requests/")) {
        if (!(await ensureTargetBrowserSpace("request"))) return;
        const activeTab = deps.getActiveBrowserTab(
          targetWorkspaceId,
          targetSpace,
          ensuredSessionId,
          { useVisibleAgentSession },
        );
        if (!activeTab) {
          writeJson(response, 409, {
            error: "No active browser tab is available.",
          });
          return;
        }
        const requestId = decodeURIComponent(
          pathname.slice("/api/v1/browser/requests/".length),
        ).trim();
        if (!requestId) {
          writeJson(response, 400, { error: "Request id is required." });
          return;
        }
        const requestRecord = activeTab.requests.get(requestId) ?? null;
        if (!requestRecord) {
          writeJson(response, 404, {
            error: "Browser request not found for the active tab.",
          });
          return;
        }
        writeJson(response, 200, { request: requestRecord });
        return;
      }

      if (method === "GET" && pathname === "/api/v1/browser/cookies") {
        const workspace = await ensureTargetBrowserSpace("cookies:get");
        if (!workspace) return;
        const activeTab = deps.getActiveBrowserTab(
          targetWorkspaceId,
          targetSpace,
          ensuredSessionId,
          { useVisibleAgentSession },
        );
        const requestedCookieUrl =
          requestUrl.searchParams.get("url")?.trim() || "";
        const requestedName =
          requestUrl.searchParams.get("name")?.trim() || "";
        const requestedDomain =
          requestUrl.searchParams.get("domain")?.trim() || "";
        try {
          const fallbackUrl = activeTab?.view.webContents.getURL() || "";
          const cookies = await workspace.session.cookies.get({
            ...(requestedCookieUrl || fallbackUrl
              ? { url: requestedCookieUrl || fallbackUrl }
              : {}),
            ...(requestedName ? { name: requestedName } : {}),
            ...(requestedDomain ? { domain: requestedDomain } : {}),
          });
          writeJson(response, 200, {
            cookies: cookies.map((cookie) => ({
              name: cookie.name || "",
              value: cookie.value || "",
              domain: cookie.domain || "",
              path: cookie.path || "/",
              secure: Boolean(cookie.secure),
              httpOnly: Boolean(cookie.httpOnly),
              session: Boolean(cookie.session),
              sameSite: cookie.sameSite || "unspecified",
              expirationDate:
                typeof cookie.expirationDate === "number" &&
                Number.isFinite(cookie.expirationDate)
                  ? cookie.expirationDate
                  : null,
            })),
          });
        } catch (error) {
          writeJson(response, 400, {
            error:
              error instanceof Error
                ? error.message
                : "Failed to read browser cookies.",
          });
        }
        return;
      }

      if (method === "GET" && pathname === "/api/v1/browser/page") {
        if (!(await ensureTargetBrowserSpace("page"))) return;
        const activeTab = deps.getActiveBrowserTab(
          targetWorkspaceId,
          targetSpace,
          ensuredSessionId,
          { useVisibleAgentSession },
        );
        if (!activeTab) {
          writeJson(response, 409, {
            error: "No active browser tab is available.",
          });
          return;
        }
        deps.syncBrowserState(
          targetWorkspaceId,
          activeTab.state.id,
          targetSpace,
          ensuredSessionId,
        );
        writeJson(response, 200, deps.browserPagePayload(activeTab));
        return;
      }

      if (
        method === "GET" &&
        pathname === "/api/v1/browser/operator-surface-context"
      ) {
        await deps.ensureBrowserWorkspace(targetWorkspaceId, "user", null);
        await deps.ensureBrowserWorkspace(targetWorkspaceId, "agent", null);
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
        if (!(await ensureTargetBrowserSpace("navigate"))) return;
        if (
          targetWorkspaceId &&
          targetWorkspaceId === deps.getActiveWorkspaceId()
        ) {
          deps.emitWorkbenchOpenBrowser({
            workspaceId: targetWorkspaceId,
            url: targetUrl,
            space: targetSpace,
            sessionId: requestedSessionId || null,
          });
        }
        const snapshot = await deps.navigateActiveBrowserTab(
          targetWorkspaceId,
          targetUrl,
          targetSpace,
          ensuredSessionId,
        );
        writeJson(response, 200, snapshot);
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
        const workspace = await ensureTargetBrowserSpace("tabs:select");
        if (!workspace) return;
        const snapshot = await deps.setActiveBrowserTab(tabId, {
          workspaceId: workspace.workspaceId,
          space: targetSpace,
          sessionId: ensuredSessionId,
          useVisibleAgentSession,
        });
        writeJson(response, 200, snapshot);
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
        const workspace = await ensureTargetBrowserSpace("tabs:close");
        if (!workspace) return;
        const snapshot = await deps.closeBrowserTab(tabId, {
          workspaceId: workspace.workspaceId,
          space: targetSpace,
          sessionId: ensuredSessionId,
          useVisibleAgentSession,
        });
        writeJson(response, 200, snapshot);
        return;
      }

      if (method === "POST" && pathname === "/api/v1/browser/cookies") {
        const payload = await readJsonBody(request);
        const workspace = await ensureTargetBrowserSpace("cookies:set");
        if (!workspace) return;
        const activeTab = deps.getActiveBrowserTab(
          targetWorkspaceId,
          targetSpace,
          ensuredSessionId,
          { useVisibleAgentSession },
        );
        const activeTabUrl = activeTab?.view.webContents.getURL()?.trim() || "";
        const targetCookieUrl =
          (typeof payload.url === "string" && payload.url.trim()
            ? payload.url.trim()
            : activeTabUrl) || "";
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
        try {
          const expirationDate =
            typeof payload.expiration_date === "number" &&
            Number.isFinite(payload.expiration_date)
              ? payload.expiration_date
              : typeof payload.expirationDate === "number" &&
                  Number.isFinite(payload.expirationDate)
                ? payload.expirationDate
                : undefined;
          await workspace.session.cookies.set({
            url: targetCookieUrl,
            name: cookieName,
            value: typeof payload.value === "string" ? payload.value : "",
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
            ...(payload.same_site === "unspecified" ||
            payload.same_site === "no_restriction" ||
            payload.same_site === "lax" ||
            payload.same_site === "strict"
              ? { sameSite: payload.same_site }
              : payload.sameSite === "unspecified" ||
                  payload.sameSite === "no_restriction" ||
                  payload.sameSite === "lax" ||
                  payload.sameSite === "strict"
                ? { sameSite: payload.sameSite }
                : {}),
            ...(typeof expirationDate === "number" ? { expirationDate } : {}),
          });
          await workspace.session.cookies.flushStore();
          const cookies = await workspace.session.cookies.get({
            url: targetCookieUrl,
            name: cookieName,
          });
          const cookie = cookies[0] ?? null;
          writeJson(response, 200, {
            ok: true,
            cookie: cookie
              ? {
                  name: cookie.name || "",
                  value: cookie.value || "",
                  domain: cookie.domain || "",
                  path: cookie.path || "/",
                  secure: Boolean(cookie.secure),
                  httpOnly: Boolean(cookie.httpOnly),
                  session: Boolean(cookie.session),
                  sameSite: cookie.sameSite || "unspecified",
                  expirationDate:
                    typeof cookie.expirationDate === "number" &&
                    Number.isFinite(cookie.expirationDate)
                      ? cookie.expirationDate
                      : null,
                }
              : null,
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
        const background = payload.background === true;
        const workspace = await ensureTargetBrowserSpace("tabs:create");
        const tabSpace = deps.browserTabSpaceState(
          workspace,
          targetSpace,
          ensuredSessionId,
          {
            createIfMissing:
              targetSpace === "agent" && Boolean(requestedSessionId),
            useVisibleAgentSession,
          },
        );
        if (!workspace) {
          writeJson(response, 409, {
            error: "No active browser workspace is available.",
          });
          return;
        }

        const nextTabId = deps.createBrowserTab(targetWorkspaceId, {
          url: targetUrl,
          browserSpace: targetSpace,
          sessionId: ensuredSessionId,
        });
        if (!nextTabId) {
          writeJson(response, 500, { error: "Failed to create browser tab." });
          return;
        }

        if (!background && tabSpace) {
          tabSpace.activeTabId = nextTabId;
          if (targetWorkspaceId === deps.getActiveWorkspaceId()) {
            deps.updateAttachedBrowserView();
          }
        }

        deps.emitBrowserState(targetWorkspaceId, targetSpace);
        await deps.persistWorkspace(targetWorkspaceId);
        writeJson(
          response,
          200,
          deps.browserWorkspaceSnapshot(
            targetWorkspaceId,
            targetSpace,
            ensuredSessionId,
            { useVisibleAgentSession },
          ),
        );
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
        if (!(await ensureTargetBrowserSpace("evaluate"))) return;
        const activeTab = deps.getActiveBrowserTab(
          targetWorkspaceId,
          targetSpace,
          ensuredSessionId,
          { useVisibleAgentSession },
        );
        if (!activeTab) {
          writeJson(response, 409, {
            error: "No active browser tab is available.",
          });
          return;
        }
        const result = await deps.withTemporarilyRenderedBrowserTab(
          activeTab,
          async () =>
            activeTab.view.webContents.executeJavaScript(expression),
        );
        writeJson(response, 200, {
          tabId: activeTab.state.id,
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
        if (!(await ensureTargetBrowserSpace("context-click"))) return;
        const activeTab = deps.getActiveBrowserTab(
          targetWorkspaceId,
          targetSpace,
          ensuredSessionId,
          { useVisibleAgentSession },
        );
        if (!activeTab) {
          writeJson(response, 409, {
            error: "No active browser tab is available.",
          });
          return;
        }
        const mainWindow = deps.getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
          mainWindow.focus();
        }
        await deps.withTemporarilyRenderedBrowserTab(
          activeTab,
          async () =>
            deps.withProgrammaticBrowserInput(
              activeTab.view.webContents,
              async () => {
                activeTab.view.webContents.focus();
                await activeTab.view.webContents.sendInputEvent({
                  type: "mouseMove",
                  x,
                  y,
                });
                await activeTab.view.webContents.sendInputEvent({
                  type: "mouseDown",
                  x,
                  y,
                  button: "right",
                  clickCount: 1,
                });
                await activeTab.view.webContents.sendInputEvent({
                  type: "mouseUp",
                  x,
                  y,
                  button: "right",
                  clickCount: 1,
                });
              },
            ),
          {
            requireFocusedWindow: true,
            workspaceId: targetWorkspaceId,
          },
        );
        writeJson(response, 200, {
          ok: true,
          tabId: activeTab.state.id,
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
        if (!(await ensureTargetBrowserSpace("mouse"))) return;
        const activeTab = deps.getActiveBrowserTab(
          targetWorkspaceId,
          targetSpace,
          ensuredSessionId,
          { useVisibleAgentSession },
        );
        if (!activeTab) {
          writeJson(response, 409, {
            error: "No active browser tab is available.",
          });
          return;
        }
        const mainWindow = deps.getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
          mainWindow.focus();
        }
        let resolvedAction: unknown = null;
        await deps.withTemporarilyRenderedBrowserTab(
          activeTab,
          async () =>
            deps.withProgrammaticBrowserInput(
              activeTab.view.webContents,
              async () => {
                activeTab.view.webContents.focus();
                if (expression) {
                  resolvedAction = serializeEvalResult(
                    await activeTab.view.webContents.executeJavaScript(expression),
                  );
                  const resolvedPoint =
                    resolvedAction &&
                    typeof resolvedAction === "object" &&
                    !Array.isArray(resolvedAction)
                      ? (resolvedAction as Record<string, unknown>).result
                      : null;
                  x =
                    resolvedPoint &&
                    typeof resolvedPoint === "object" &&
                    !Array.isArray(resolvedPoint) &&
                    typeof (resolvedPoint as Record<string, unknown>).x === "number" &&
                    Number.isFinite((resolvedPoint as Record<string, unknown>).x)
                      ? Math.round((resolvedPoint as Record<string, unknown>).x as number)
                      : NaN;
                  y =
                    resolvedPoint &&
                    typeof resolvedPoint === "object" &&
                    !Array.isArray(resolvedPoint) &&
                    typeof (resolvedPoint as Record<string, unknown>).y === "number" &&
                    Number.isFinite((resolvedPoint as Record<string, unknown>).y)
                      ? Math.round((resolvedPoint as Record<string, unknown>).y as number)
                      : NaN;
                  if (!Number.isFinite(x) || x < 0 || !Number.isFinite(y) || y < 0) {
                    throw new Error("Resolved browser mouse action did not provide valid coordinates.");
                  }
                }
                await activeTab.view.webContents.sendInputEvent({
                  type: "mouseMove",
                  x,
                  y,
                });
                if (action === "click" || action === "double_click") {
                  await activeTab.view.webContents.sendInputEvent({
                    type: "mouseDown",
                    x,
                    y,
                    button: "left",
                    clickCount: 1,
                  });
                  await activeTab.view.webContents.sendInputEvent({
                    type: "mouseUp",
                    x,
                    y,
                    button: "left",
                    clickCount: 1,
                  });
                }
                if (action === "double_click") {
                  await activeTab.view.webContents.sendInputEvent({
                    type: "mouseDown",
                    x,
                    y,
                    button: "left",
                    clickCount: 2,
                  });
                  await activeTab.view.webContents.sendInputEvent({
                    type: "mouseUp",
                    x,
                    y,
                    button: "left",
                    clickCount: 2,
                  });
                }
              },
            ),
          {
            requireFocusedWindow: true,
            workspaceId: targetWorkspaceId,
          },
        );
        writeJson(response, 200, {
          ok: true,
          tabId: activeTab.state.id,
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
        if (!(await ensureTargetBrowserSpace("keyboard"))) return;
        const activeTab = deps.getActiveBrowserTab(
          targetWorkspaceId,
          targetSpace,
          ensuredSessionId,
          { useVisibleAgentSession },
        );
        if (!activeTab) {
          writeJson(response, 409, {
            error: "No active browser tab is available.",
          });
          return;
        }
        const mainWindow = deps.getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
          mainWindow.focus();
        }
        let focusedTarget: unknown = null;
        let resolvedAction: unknown = null;
        await deps.withTemporarilyRenderedBrowserTab(
          activeTab,
          async () =>
            deps.withProgrammaticBrowserInput(
              activeTab.view.webContents,
              async () => {
                activeTab.view.webContents.focus();
                if (expression) {
                  resolvedAction = serializeEvalResult(
                    await activeTab.view.webContents.executeJavaScript(expression),
                  );
                } else if (index !== null) {
                  focusedTarget = serializeEvalResult(
                    await activeTab.view.webContents.executeJavaScript(
                      focusIndexedKeyboardTargetExpression(index),
                    ),
                  );
                }
                if (action === "press") {
                  await deps.sendBrowserKeyPress(activeTab.view.webContents, key);
                  return;
                }
                if (clear) {
                  await deps.clearFocusedBrowserTextInput(activeTab.view.webContents);
                }
                if (text) {
                  await activeTab.view.webContents.insertText(text);
                }
                if (submit) {
                  await deps.sendBrowserKeyPress(
                    activeTab.view.webContents,
                    "Enter",
                  );
                }
              },
            ),
          {
            requireFocusedWindow: true,
            workspaceId: targetWorkspaceId,
          },
        );
        writeJson(response, 200, {
          ok: true,
          tabId: activeTab.state.id,
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
        if (!(await ensureTargetBrowserSpace("screenshot"))) return;
        const activeTab = deps.getActiveBrowserTab(
          targetWorkspaceId,
          targetSpace,
          ensuredSessionId,
          { useVisibleAgentSession },
        );
        if (!activeTab) {
          writeJson(response, 409, {
            error: "No active browser tab is available.",
          });
          return;
        }
        const format = payload.format === "jpeg" ? "jpeg" : "png";
        const qualityRaw =
          typeof payload.quality === "number" ? payload.quality : 90;
        const quality = Math.max(0, Math.min(100, Math.round(qualityRaw)));
        const image = await deps.withTemporarilyRenderedBrowserTab(
          activeTab,
          async () => captureBrowserScreenshotWithRetries(activeTab),
          { waitForRenderedFrame: true },
        );
        const buffer = format === "jpeg" ? image.toJPEG(quality) : image.toPNG();
        const size = image.getSize();
        writeJson(response, 200, {
          tabId: activeTab.state.id,
          mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
          width: size.width,
          height: size.height,
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
