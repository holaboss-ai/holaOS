/**
 * CDP drive for a profile's spawned Chromium (real Chrome), over Playwright.
 *
 * Each profile is launched (main.ts `launchProfileChromium`) as a real Chrome
 * with `--remote-debugging-port`. This module connects to that port with
 * Playwright (`connectOverCDP`) and exposes the small set of low-level browser
 * primitives the desktop browser control service drives a tab through —
 * `executeJavaScript`, page info, navigate, screenshot, input — so the SAME
 * agent browser tools can act on the launched profile window instead of the
 * embedded Electron BrowserView (full parity, driven over CDP).
 *
 * The agent's rich model (browser_get_state / find / click-by-index / scroll)
 * is produced by the api-server injecting JS via `/evaluate` -> executeJavaScript
 * -> here `page.evaluate`, so reproducing `evaluate` faithfully reproduces the
 * whole element model for free.
 *
 * Uses `playwright-core` (a runtime dependency) — the connect-only library
 * without the ~hundreds-of-MB bundled browsers, since we attach to the Chrome we
 * already spawned rather than launching Playwright's chromium.
 */
import {
  type Browser,
  type BrowserContext,
  chromium,
  type CDPSession,
  type Page,
} from "playwright-core";

interface ProfileConnection {
  // A chromium profile connects to a `browser` (over CDP) and drives its default
  // context. An engine (`cloak`) profile is driven through a PERSISTENT `context`
  // launched in-process (Camoufox/Firefox) — a persistent context has no parent
  // Browser (`context.browser()` is null), so exactly one of these is set.
  browser: Browser | null;
  context: BrowserContext | null;
  port: number;
  cdpByPage: WeakMap<Page, CDPSession>;
  // Per-agent tab isolation: each agent SESSION driving this profile gets its
  // own tracked tab (keyed by session id), so concurrent agents on the same
  // profile never clobber each other's active page. They still share cookies.
  pageBySession: Map<string, Page>;
}

const connections = new Map<string, ProfileConnection>();

/** Normalize a session id to a stable key ("" = no session → the human's tab). */
function sessionKey(sessionId?: string | null): string {
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : "";
}

/** Track `page` as session `key`'s active tab, self-cleaning when it closes. */
function bindSessionPage(profileId: string, key: string, page: Page): void {
  const connection = connections.get(profileId);
  if (!key || !connection) {
    return;
  }
  connection.pageBySession.set(key, page);
  page.on("close", () => {
    if (connection.pageBySession.get(key) === page) {
      connection.pageBySession.delete(key);
    }
  });
}

/** Connect to (or reuse a connection to) a profile's Chromium debugging port. */
async function connect(profileId: string, port: number): Promise<Browser> {
  const existing = connections.get(profileId);
  if (
    existing?.browser &&
    existing.port === port &&
    existing.browser.isConnected()
  ) {
    return existing.browser;
  }
  if (existing) {
    connections.delete(profileId);
  }
  // The debug port lags process start — a COLD Chrome launch on a fresh
  // user-data-dir (first run) can take many seconds to open it. Retry up to
  // ~20s; we return the instant it's reachable, so the generous ceiling only
  // costs anything when Chrome is genuinely slow or failed to start.
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      connections.set(profileId, {
        browser,
        context: null,
        port,
        cdpByPage: new WeakMap(),
        pageBySession: new Map(),
      });
      browser.on("disconnected", () => {
        if (connections.get(profileId)?.browser === browser) {
          connections.delete(profileId);
        }
      });
      return browser;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const detail = lastError instanceof Error ? ` (${lastError.message})` : "";
  throw new Error(
    `Timed out waiting for the profile browser's debug port on 127.0.0.1:${port}. ` +
      `Chrome may be slow to start or failed to launch.${detail}`,
  );
}

/**
 * Register an engine-launched PERSISTENT context (a `cloak` profile's Camoufox
 * Firefox context, launched in-process with a `user_data_dir` so cookies/logins
 * persist) under a profile's connection slot, so the whole drive path (navigate /
 * cookies / screenshot / input via the `profileCdp*` fns) works against it
 * UNCHANGED — they resolve through `resolveContext(profileId, port)`, which
 * returns this context once registered. A persistent context has no parent
 * Browser, so it IS the drive unit. `port` is the profile's stable debug port,
 * reused purely as the connection key so `profileChromiumPort` round-trips back.
 */
export function registerProfileContext(
  profileId: string,
  context: BrowserContext,
  port: number,
): void {
  const existing = connections.get(profileId);
  if (existing) {
    connections.delete(profileId);
  }
  connections.set(profileId, {
    browser: null,
    context,
    port,
    cdpByPage: new WeakMap(),
    pageBySession: new Map(),
  });
  context.on("close", () => {
    if (connections.get(profileId)?.context === context) {
      connections.delete(profileId);
    }
  });
}

/**
 * The BrowserContext a caller drives: the engine's registered persistent context
 * if present, else the default context of the profile's connected Chromium
 * (connecting to the debug port on demand).
 */
async function resolveContext(
  profileId: string,
  port: number,
): Promise<BrowserContext> {
  const existing = connections.get(profileId);
  if (existing?.context) {
    return existing.context;
  }
  const browser = await connect(profileId, port);
  return browser.contexts()[0] ?? (await browser.newContext());
}

/**
 * Try to adopt a Chrome ALREADY reachable on `port` for this profile — e.g. one
 * that survived an app restart (our spawns are detached). A single quick attempt
 * (no retry): the caller only wants to know "is one already listening?" so it can
 * reuse it instead of spawning a second process that would just route a
 * --new-window into it and exit. Registers the connection on success.
 */
export async function profileCdpTryAdopt(
  profileId: string,
  port: number,
): Promise<boolean> {
  const existing = connections.get(profileId);
  if (
    existing?.browser &&
    existing.port === port &&
    existing.browser.isConnected()
  ) {
    return true;
  }
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
      timeout: 1500,
    });
    if (existing) {
      connections.delete(profileId);
    }
    connections.set(profileId, {
      browser,
      context: null,
      port,
      cdpByPage: new WeakMap(),
      pageBySession: new Map(),
    });
    browser.on("disconnected", () => {
      if (connections.get(profileId)?.browser === browser) {
        connections.delete(profileId);
      }
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * A freshly-opened landing tab (blank / new-tab) a session may CLAIM instead of
 * spawning a second tab. Agent auto-launches land on `about:blank` (main.ts
 * `ensureLive`), so the first agent to drive reuses that tab rather than opening
 * its own and orphaning the landing page. Restricted to blank/new-tab pages so
 * claiming one never hijacks a human's — or another agent's — real navigated tab.
 */
function isClaimableLandingPage(page: Page): boolean {
  const url = page.url();
  return (
    url === "" ||
    url === "about:blank" ||
    url.startsWith("chrome://newtab") ||
    url.startsWith("chrome://new-tab-page")
  );
}

/**
 * The page a caller acts on. With a `sessionId` (an agent), each session gets
 * its OWN tab — tracked per (profile, session) — so concurrent agents on the
 * same profile never clobber each other's active page. The first drive claims
 * the window's unclaimed blank landing tab (so we don't leave it orphaned beside
 * a freshly-spawned one); later sessions open their own. Without a session (the
 * human, or legacy callers) it's the last tab NOT owned by an agent, so watching
 * the window doesn't collide with an agent's tab.
 */
async function activePage(
  profileId: string,
  port: number,
  sessionId?: string | null,
): Promise<Page> {
  const context = await resolveContext(profileId, port);
  const connection = connections.get(profileId);
  const live = context.pages().filter((page) => !page.isClosed());

  const key = sessionKey(sessionId);
  if (key && connection) {
    const tracked = connection.pageBySession.get(key);
    if (tracked && !tracked.isClosed()) {
      return tracked;
    }
    // No tab bound to this session yet. Claim the window's landing tab if it's
    // still a blank, unowned page (the one the launch just opened) so the first
    // agent to drive reuses it instead of spawning a second tab; otherwise open
    // a fresh one. Only blank pages are claimable — never a real navigated tab —
    // so this can't steal a human's or another session's page.
    const owned = new Set([...connection.pageBySession.values()]);
    const landing = live.find(
      (page) => !owned.has(page) && isClaimableLandingPage(page),
    );
    const page = landing ?? (await context.newPage());
    bindSessionPage(profileId, key, page);
    return page;
  }

  const owned = new Set(
    connection ? [...connection.pageBySession.values()] : [],
  );
  const unowned = live.filter((page) => !owned.has(page));
  return (
    unowned[unowned.length - 1] ??
    live[live.length - 1] ??
    (await context.newPage())
  );
}

/** A CDP session bound to the given page, cached per page for reuse. */
async function pageCdp(profileId: string, page: Page): Promise<CDPSession> {
  const connection = connections.get(profileId);
  const cached = connection?.cdpByPage.get(page);
  if (cached) {
    return cached;
  }
  const session = await page.context().newCDPSession(page);
  connection?.cdpByPage.set(page, session);
  return session;
}

export interface ProfileCdpPageInfo {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/**
 * Run a JavaScript expression in the active page and return its raw result.
 * Mirrors `webContents.executeJavaScript(expression)`; the caller serializes.
 */
export async function profileCdpEvaluate(
  profileId: string,
  port: number,
  expression: string,
  sessionId?: string | null,
): Promise<unknown> {
  const page = await activePage(profileId, port, sessionId);
  // Playwright treats a string arg as an expression evaluated in page context,
  // exactly like executeJavaScript — the injected IIFEs run unchanged.
  return await page.evaluate(expression);
}

/** Live page info (url/title + nav state) matching browserPagePayload's fields. */
export async function profileCdpPageInfo(
  profileId: string,
  port: number,
  sessionId?: string | null,
): Promise<ProfileCdpPageInfo> {
  const page = await activePage(profileId, port, sessionId);
  const url = page.url();
  let title = "";
  try {
    title = await page.title();
  } catch {
    title = "";
  }
  let canGoBack = false;
  let canGoForward = false;
  try {
    const session = await pageCdp(profileId, page);
    const history = (await session.send("Page.getNavigationHistory")) as {
      currentIndex: number;
      entries: unknown[];
    };
    canGoBack = history.currentIndex > 0;
    canGoForward = history.currentIndex < history.entries.length - 1;
  } catch {
    // Best-effort; nav buttons just stay disabled if history is unavailable.
  }
  return { url, title, loading: false, canGoBack, canGoForward };
}

/** Navigate the active page to a URL (mirrors loadURL / navigateActiveBrowserTab). */
export async function profileCdpNavigate(
  profileId: string,
  port: number,
  url: string,
  sessionId?: string | null,
): Promise<void> {
  const page = await activePage(profileId, port, sessionId);
  await page
    .goto(url, { waitUntil: "domcontentloaded", timeout: 30000 })
    .catch(async (error) => {
      // Surface only hard failures; sub-resource timeouts shouldn't abort a nav.
      if (page.url() === "about:blank") {
        throw error;
      }
    });
}

/**
 * Open a real new tab (page) in the profile's Chromium and navigate it, then
 * bring it to the front so it becomes the active page for subsequent ops
 * (mirrors createBrowserTab + setActiveBrowserTab). Backs `browser_open_tab`.
 */
export async function profileCdpOpenTab(
  profileId: string,
  port: number,
  url: string,
  sessionId?: string | null,
): Promise<ProfileCdpPageInfo> {
  const context = await resolveContext(profileId, port);
  const page = await context.newPage();
  // The agent moved to a new tab: make it this session's active page so
  // subsequent ops act on it (and it stays isolated from other agents).
  bindSessionPage(profileId, sessionKey(sessionId), page);
  await page
    .goto(url, { waitUntil: "domcontentloaded", timeout: 30000 })
    .catch((error) => {
      if (page.url() === "about:blank") {
        throw error;
      }
    });
  try {
    await page.bringToFront();
  } catch {
    // Best-effort focus within the window.
  }
  let title = "";
  try {
    title = await page.title();
  } catch {
    title = "";
  }
  return {
    url: page.url(),
    title,
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
}

/** Dispatch a real mouse action at viewport coordinates (mirrors sendInputEvent). */
export async function profileCdpMouse(
  profileId: string,
  port: number,
  x: number,
  y: number,
  action: "click" | "double_click" | "hover" | "context",
  sessionId?: string | null,
): Promise<void> {
  const page = await activePage(profileId, port, sessionId);
  await page.mouse.move(x, y);
  if (action === "click") {
    await page.mouse.click(x, y);
  } else if (action === "double_click") {
    await page.mouse.dblclick(x, y);
  } else if (action === "context") {
    await page.mouse.click(x, y, { button: "right" });
  }
  // hover === the move above
}

/**
 * Real keyboard input on the focused element (mirrors the /keyboard route's CDP
 * dispatch: press a key, or insert text with optional clear + submit). Focusing
 * the target happens caller-side via evaluate, exactly like the Electron path.
 */
export async function profileCdpKeyboard(
  profileId: string,
  port: number,
  opts: {
    action: "press" | "insert_text";
    text?: string;
    key?: string;
    clear?: boolean;
    submit?: boolean;
  },
  sessionId?: string | null,
): Promise<void> {
  const page = await activePage(profileId, port, sessionId);
  if (opts.action === "press") {
    if (opts.key) {
      await page.keyboard.press(opts.key);
    }
    return;
  }
  if (opts.clear) {
    // Select-all + delete clears the focused editable field.
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Delete");
  }
  if (opts.text) {
    await page.keyboard.insertText(opts.text);
  }
  if (opts.submit) {
    await page.keyboard.press("Enter");
  }
}

/** Capture a screenshot of the active page as a PNG/JPEG buffer. */
export async function profileCdpScreenshot(
  profileId: string,
  port: number,
  options: { fullPage?: boolean; format?: "png" | "jpeg"; quality?: number } = {},
  sessionId?: string | null,
): Promise<Buffer> {
  const page = await activePage(profileId, port, sessionId);
  return await page.screenshot({
    type: options.format === "jpeg" ? "jpeg" : "png",
    fullPage: Boolean(options.fullPage),
    ...(options.format === "jpeg" && typeof options.quality === "number"
      ? { quality: options.quality }
      : {}),
  });
}

export interface ProfileCdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  session: boolean;
  sameSite: string;
  expirationDate: number | null;
}

/**
 * Read the profile's cookies (mirrors session.cookies.get). Filters by url
 * (Playwright-native) plus optional name/domain, and maps Playwright's cookie
 * shape onto the control service's shape.
 */
export async function profileCdpCookies(
  profileId: string,
  port: number,
  filter: { url?: string; name?: string; domain?: string },
  sessionId?: string | null,
): Promise<ProfileCdpCookie[]> {
  const context = await resolveContext(profileId, port);
  let url = filter.url?.trim() ?? "";
  if (!url) {
    try {
      url = (await activePage(profileId, port, sessionId)).url();
    } catch {
      url = "";
    }
  }
  const raw = await context.cookies(url ? [url] : undefined);
  const sameSiteMap: Record<string, string> = {
    Strict: "strict",
    Lax: "lax",
    None: "no_restriction",
  };
  return raw
    .filter(
      (cookie) =>
        (!filter.name || cookie.name === filter.name) &&
        (!filter.domain || (cookie.domain ?? "").includes(filter.domain)),
    )
    .map((cookie) => ({
      name: cookie.name ?? "",
      value: cookie.value ?? "",
      domain: cookie.domain ?? "",
      path: cookie.path ?? "/",
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
      session: cookie.expires === -1 || cookie.expires === undefined,
      sameSite: cookie.sameSite ? sameSiteMap[cookie.sameSite] ?? "unspecified" : "unspecified",
      expirationDate:
        typeof cookie.expires === "number" &&
        cookie.expires !== -1 &&
        Number.isFinite(cookie.expires)
          ? cookie.expires
          : null,
    }));
}

/**
 * Set a cookie in the profile's context (mirrors session.cookies.set). Playwright
 * requires either `url` OR `domain`+`path`; the caller passes url by default.
 */
export async function profileCdpSetCookie(
  profileId: string,
  port: number,
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
): Promise<void> {
  const context = await resolveContext(profileId, port);
  await context.addCookies([
    {
      name: cookie.name,
      value: cookie.value,
      ...(cookie.url ? { url: cookie.url } : {}),
      ...(cookie.domain ? { domain: cookie.domain } : {}),
      ...(cookie.path ? { path: cookie.path } : {}),
      ...(typeof cookie.secure === "boolean" ? { secure: cookie.secure } : {}),
      ...(typeof cookie.httpOnly === "boolean"
        ? { httpOnly: cookie.httpOnly }
        : {}),
      ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
      ...(typeof cookie.expires === "number" ? { expires: cookie.expires } : {}),
    },
  ]);
}

/**
 * Batch-inject cookies into a profile's context (used to seed an imported
 * profile's login state — see browser-pane/cdp-cookie-transfer.ts). The target
 * Chrome re-encrypts them with its own key, so App-Bound Encryption never blocks
 * the transfer. Best-effort per cookie: returns how many were accepted so the
 * caller can report partial success.
 */
export async function profileCdpAddCookies(
  profileId: string,
  port: number,
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires?: number;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
  }>,
): Promise<{ added: number; failed: number }> {
  if (cookies.length === 0) {
    return { added: 0, failed: 0 };
  }
  const context = await resolveContext(profileId, port);
  let added = 0;
  let failed = 0;
  // addCookies is all-or-nothing per call, so add one at a time — a single
  // malformed cookie must not lose the whole logged-in set.
  for (const cookie of cookies) {
    try {
      await context.addCookies([
        {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path || "/",
          ...(typeof cookie.expires === "number"
            ? { expires: cookie.expires }
            : {}),
          ...(typeof cookie.secure === "boolean"
            ? { secure: cookie.secure }
            : {}),
          ...(typeof cookie.httpOnly === "boolean"
            ? { httpOnly: cookie.httpOnly }
            : {}),
          ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
        },
      ]);
      added += 1;
    } catch {
      failed += 1;
    }
  }
  return { added, failed };
}

/** Drop a profile's connection (e.g. when its Chromium exits). */
export function disconnectProfileCdp(profileId: string): void {
  const existing = connections.get(profileId);
  if (existing) {
    connections.delete(profileId);
    // Chromium: close the CDP connection. Engine (persistent context): the context
    // is owned by the engine handle (closed via closeProfileChromium), so only drop
    // the connection here — don't close the context out from under the handle.
    if (existing.browser) {
      void existing.browser.close().catch(() => undefined);
    }
  }
}
