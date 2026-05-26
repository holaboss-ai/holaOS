import { app as electronApp } from "electron";
import { loadDesktopEnv } from "./desktopEnv";

electronApp.setName("holaOS");

loadDesktopEnv();

import * as Sentry from "@sentry/electron/main";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: !!process.env.SENTRY_DSN,
  enableLogs: !!process.env.SENTRY_DSN,
  // attachScreenshot was the dominant idle-CPU culprit on desktop: when true,
  // the @sentry/electron screenshots integration calls
  // `BrowserWindow.capturePage()` + `toPNG()` inside `processEvent` for every
  // non-transaction event the SDK ships — and `enableLogs` + the console
  // logging integration below funnel info/warn/error console writes through
  // that same path. CPU profile on a fresh idle launch attributed >70% of
  // process time to a single `processEvent` frame in screenshots.js.
  // If we ever want screenshots in crash reports, capture them manually
  // inside `beforeSend` and gate on `event.level === "fatal"`.
  attachScreenshot: false,
  maxBreadcrumbs: 200,
  integrations: [
    Sentry.consoleLoggingIntegration({
      levels: ["info", "warn", "error"],
    }),
  ],
  beforeSend(event, hint) {
    return enrichDesktopSentryEvent(event, hint);
  },
});

// Swallow EPIPE on stdio writes — a benign teardown race that Electron
// would otherwise surface as a "holaOS encountered an error" modal.
// Trigger: a child / utility process (or the embedded runtime) writes via
// `console.info`/`.warn`/`.error` after its stdio pipe has been closed on
// the parent side. Sentry's `consoleLoggingIntegration` above wraps those
// console methods and re-invokes the real ones, so the EPIPE surfaces here
// with a stack that ends in `sentry/core/build/cjs/instrument/console.js`
// — not actually a Sentry bug, just an unhandled write to a half-closed
// socket. Anything other than EPIPE we leave alone so the existing Sentry
// + Electron handlers still see it.
process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err?.code === "EPIPE") return;
});

import { electronClient } from "@better-auth/electron/client";
import { storage as electronAuthStorage } from "@better-auth/electron/storage";
import { createAuthClient } from "better-auth/client";
import Database from "better-sqlite3";
import {
  autoUpdater,
  type ProgressInfo,
  type UpdateInfo,
} from "electron-updater";
import {
  app,
  BrowserView,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  clipboard,
  dialog,
  DownloadItem,
  ipcMain,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  nativeImage,
  screen,
  session,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type SaveDialogOptions,
  type Session,
  type WebContents,
} from "electron";
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  type FSWatcher,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { URL, pathToFileURL } from "node:url";
import JSZip from "jszip";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  createMarketplaceSubmission as sdkCreateMarketplaceSubmission,
  deleteMarketplaceSubmission as sdkDeleteMarketplaceSubmission,
  finalizeMarketplaceSubmission as sdkFinalizeMarketplaceSubmission,
  generateMarketplaceTemplateContent as sdkGenerateMarketplaceTemplateContent,
  listMarketplaceAppTemplates as sdkListMarketplaceAppTemplates,
  listMarketplaceSubmissions as sdkListMarketplaceSubmissions,
  materializeMarketplaceTemplate as sdkMaterializeMarketplaceTemplate,
} from "@holaboss/app-sdk/core";
import {
  type ModelCatalogInputModality,
} from "../shared/model-catalog.js";
import * as modelCatalog from "../shared/model-catalog.js";
import { buildAppSdkClient } from "./appSdkClient.js";
import {
  bootstrapLocalControlPlaneDatabase,
  createLocalAppCatalogStore,
  createLocalIntegrationMetadataStore,
  createLocalRuntimeUserProfileStore,
  createLocalWorkspaceRegistry,
} from "./control-plane-owned-state.js";
import { ensureWorkspaceGitRepo } from "./workspace-git.js";
import { createLocalWorkspaceControlPlane } from "./workspace-control-plane.js";
import {
  createRuntimeClient,
  isTransientRuntimeError as sdkIsTransientRuntimeError,
  runtimeErrorFromBody,
} from "@holaboss/runtime-client";
import { installBffFetchHandler } from "./bff-fetch.js";
import { installBrowserPaneHandlers } from "./browser-pane/index.js";
import {
  copyBrowserWorkspaceProfile as importBrowsersCopyBrowserWorkspaceProfile,
  importBrowserProfileIntoWorkspace as importBrowsersImportBrowserProfileIntoWorkspace,
  importChromeProfileIntoWorkspace as importBrowsersImportChromeProfileIntoWorkspace,
  listImportBrowserProfiles as importBrowsersListImportBrowserProfiles,
  type BrowserCopySpaceAction,
  type BrowserImportDeps,
} from "./browser-pane/import-browsers.js";
import {
  createBrowserPanePopups,
  type BrowserPanePopups,
} from "./browser-pane/popups.js";
import {
  createBrowserPaneBookmarks,
  type BrowserPaneBookmarks,
} from "./browser-pane/bookmarks.js";
import {
  createBrowserPaneDownloads,
  type BrowserPaneDownloads,
} from "./browser-pane/downloads.js";
import {
  BROWSER_OBSERVABILITY_ENTRY_LIMIT,
  BROWSER_OBSERVABILITY_DEFAULT_LIMIT as BROWSER_OBSERVABILITY_DEFAULT_LIMIT_IMPORTED,
  BROWSER_REQUEST_HISTORY_LIMIT,
  appendBoundedEntry,
  browserConsoleLevelRank,
  browserConsoleLevelValue,
  browserHeaderFirstValue,
  browserHeaderRecord,
  browserIsoFromNetworkTimestamp,
  browserObservabilityLimit,
  browserObservedErrorSource,
  browserRequestBodyMetadata,
  browserRequestFailure,
  browserRequestIdValue,
  browserRequestSummary,
  browserResponseBodyMetadata,
  type BrowserConsoleEntry as BrowserConsoleEntryImported,
  type BrowserConsoleLevel as BrowserConsoleLevelImported,
  type BrowserErrorSource as BrowserErrorSourceImported,
  type BrowserObservedError as BrowserObservedErrorImported,
  type BrowserRequestBodyMetadata as BrowserRequestBodyMetadataImported,
  type BrowserRequestRecord as BrowserRequestRecordImported,
  type BrowserResponseBodyMetadata as BrowserResponseBodyMetadataImported,
} from "./browser-pane/observability.js";
import { createTabObservability } from "./browser-pane/tab-observability.js";
import { createBrowserUserLock } from "./browser-pane/user-lock.js";
import { createAgentSessionLifecycle } from "./browser-pane/agent-session-lifecycle.js";
import {
  createBrowserPaneTabState,
  type BrowserPaneTabState,
} from "./browser-pane/tab-state.js";
import {
  createBrowserHttpService,
  type BrowserHttpService,
} from "./browser-pane/http-service.js";
import { installBrowserPaneIpcHandlers } from "./browser-pane/handlers.js";
import type {
  BrowserCopyWorkspaceProfilePayload,
  BrowserImportProfilePayload,
  BrowserImportSource,
  BrowserWorkspaceImportTarget,
} from "./browser-pane/types.js";
import {
  browserAcceptedLanguages as browserAcceptedLanguagesUtil,
  browserChromeLikePlatformToken as browserChromeLikePlatformTokenUtil,
  browserContextSuggestedFilename as browserContextSuggestedFilenameUtil,
  browserSessionId as browserSessionIdUtil,
  browserSpaceId as browserSpaceIdUtil,
  browserWorkspacePartition as browserWorkspacePartitionUtil,
  browserWorkspaceStatePath as browserWorkspaceStatePathUtil,
  browserWorkspaceStorageDir as browserWorkspaceStorageDirUtil,
  createBrowserState as createBrowserStateUtil,
  emptyBrowserTabCountsPayload as emptyBrowserTabCountsPayloadUtil,
  isAbortedBrowserLoadError as isAbortedBrowserLoadErrorUtil,
  isAbortedBrowserLoadFailure as isAbortedBrowserLoadFailureUtil,
  isBrowserPopupWindowRequest as isBrowserPopupWindowRequestUtil,
  normalizeBrowserPopupFrameName as normalizeBrowserPopupFrameNameUtil,
  oppositeBrowserSpaceId as oppositeBrowserSpaceIdUtil,
  sanitizeBrowserWorkspaceSegment as sanitizeBrowserWorkspaceSegmentUtil,
  shouldTrackHistoryUrl as shouldTrackHistoryUrlUtil,
} from "./browser-pane/utils.js";

const APP_DISPLAY_NAME = "holaOS";
const MAC_APP_MENU_PRODUCT_LABEL = "holaOS";
const AUTH_CALLBACK_PROTOCOL = "ai.holaboss.app";
const DESKTOP_LAUNCH_ID = randomUUID();
const nodeRequire = createRequire(__filename);

interface XlsxPopulateCell {
  address(): string;
  value(): unknown;
  value(value: unknown): XlsxPopulateCell;
  hyperlink(): string | undefined;
  hyperlink(hyperlink: string): XlsxPopulateCell;
}

interface XlsxPopulateRange {
  value(): unknown;
}

interface XlsxPopulateWorksheet {
  name(): string;
  cell(row: number, column: number): XlsxPopulateCell;
  usedRange(): XlsxPopulateRange | undefined;
  hyperlink(address: string): string | undefined;
  hyperlink(address: string, hyperlink: string | null | undefined): XlsxPopulateWorksheet;
}

interface XlsxPopulateWorkbook {
  sheet(indexOrName: number | string): XlsxPopulateWorksheet | undefined;
  sheets(): XlsxPopulateWorksheet[];
  outputAsync(): Promise<Buffer | Uint8Array | ArrayBuffer>;
}

interface XlsxPopulateStatic {
  fromDataAsync(data: Buffer | Uint8Array | ArrayBuffer): Promise<XlsxPopulateWorkbook>;
}

const XlsxPopulate = nodeRequire("xlsx-populate") as XlsxPopulateStatic;
Sentry.setTags({
  desktop_launch_id: DESKTOP_LAUNCH_ID,
  process_kind: "electron_main",
});
const verboseTelemetryEnabled =
  process.env.HOLABOSS_VERBOSE_TELEMETRY?.trim() === "1";
const chromiumStderrLoggingEnabled =
  process.env.HOLABOSS_CHROMIUM_STDERR_LOGS?.trim() === "1";
const HOME_URL = "https://www.google.com";
const NEW_TAB_TITLE = "New Tab";
const DOWNLOADS_POPUP_WIDTH = 360;
const DOWNLOADS_POPUP_HEIGHT = 340;
const HISTORY_POPUP_WIDTH = 420;
const HISTORY_POPUP_HEIGHT = 420;
const AUTH_POPUP_WIDTH = 380;
const AUTH_POPUP_HEIGHT = 460;
const AUTH_POPUP_CLOSE_DELAY_MS = 260;
const AUTH_POPUP_MARGIN_PX = 8;
const DUPLICATE_BROWSER_POPUP_TAB_WINDOW_MS = 2_000;
const OVERFLOW_POPUP_WIDTH = 220;
const OVERFLOW_POPUP_HEIGHT = 172;
const ADDRESS_SUGGESTIONS_POPUP_MIN_HEIGHT = 88;
const ADDRESS_SUGGESTIONS_POPUP_MAX_HEIGHT = 320;
const MAIN_WINDOW_CLOSED_LISTENER_BUFFER = 8;
const MAIN_WINDOW_MIN_LISTENER_BUDGET = 32;
const USER_BROWSER_LOCK_TIMEOUT_MS = 15_000;
const SESSION_BROWSER_BUSY_CHECK_MS = 15_000;
const SESSION_BROWSER_COMPLETED_GRACE_MS = 30_000;
const SESSION_BROWSER_WARM_TTL_MS = 2 * 60 * 1000;
// BROWSER_OBSERVABILITY_ENTRY_LIMIT / BROWSER_REQUEST_HISTORY_LIMIT /
// BROWSER_OBSERVABILITY_DEFAULT_LIMIT moved to browser-pane/observability.ts.
const BROWSER_OBSERVABILITY_DEFAULT_LIMIT =
  BROWSER_OBSERVABILITY_DEFAULT_LIMIT_IMPORTED;
// Chromium cookie / profile-discovery constants moved to
// `browser-pane/import-chromium.ts`. Safari export filename constants
// moved to `browser-pane/import-browsers.ts`.
const APP_THEMES = new Set([
  "holaos-dark",
  "holaos-light",
  "catppuccin-dark",
  "catppuccin-light",
  "rose-pine-dark",
  "rose-pine-light",
  "solarized-dark",
  "solarized-light",
  "nord-dark",
  "nord-light",
  "one-dark-pro-dark",
  "one-dark-pro-light",
  "gruvbox-dark",
  "gruvbox-light",
  "vitesse-dark",
  "vitesse-light",
]);
const DEFAULT_APP_THEME = "holaos-light";
const GITHUB_RELEASES_OWNER = "holaboss-ai";
const GITHUB_RELEASES_REPO = "holaOS-releases";
const APP_UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const APP_UPDATE_SUPPORTED_PLATFORMS = new Set(["darwin", "win32"]);
const LOCAL_OSS_TEMPLATE_USER_ID = "local-oss";
const HOLABOSS_HOME_URL = "https://www.holaboss.ai";
const HOLABOSS_DOCS_URL = `https://github.com/${GITHUB_RELEASES_OWNER}/${GITHUB_RELEASES_REPO}`;
const HOLABOSS_HELP_URL = `${HOLABOSS_DOCS_URL}/issues`;
const RUNTIME_PROVIDER_KIND_HOLABOSS_PROXY = "holaboss_proxy";
const RUNTIME_PROVIDER_KIND_OPENAI_COMPATIBLE = "openai_compatible";
const RUNTIME_PROVIDER_KIND_ANTHROPIC_NATIVE = "anthropic_native";
const RUNTIME_PROVIDER_KIND_OPENROUTER = "openrouter";
const RUNTIME_HOLABOSS_PROVIDER_ID = "holaboss_model_proxy";
const RUNTIME_HOLABOSS_PROVIDER_ALIASES = [
  "holaboss",
  RUNTIME_HOLABOSS_PROVIDER_ID,
] as const;
const OPENAI_CODEX_PROVIDER_ID = "openai_codex";
const OPENAI_CODEX_PROVIDER_LABEL = "OpenAI Codex";
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const OPENAI_CODEX_DEFAULT_MODELS = ["gpt-5.4", "gpt-5.5", "gpt-5.3-codex"] as const;
const OPENAI_CODEX_OAUTH_ISSUER = "https://auth.openai.com";
const OPENAI_CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_OAUTH_DEVICE_CODE_URL =
  `${OPENAI_CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`;
const OPENAI_CODEX_OAUTH_DEVICE_TOKEN_URL =
  `${OPENAI_CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/token`;
const OPENAI_CODEX_OAUTH_TOKEN_URL =
  `${OPENAI_CODEX_OAUTH_ISSUER}/oauth/token`;
const OPENAI_CODEX_OAUTH_DEVICE_PAGE_URL =
  `${OPENAI_CODEX_OAUTH_ISSUER}/codex/device`;
const OPENAI_CODEX_OAUTH_REDIRECT_URI =
  `${OPENAI_CODEX_OAUTH_ISSUER}/deviceauth/callback`;
const OPENAI_CODEX_REFRESH_SKEW_MS = 5 * 60 * 1000;
const OPENAI_CODEX_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const OPENAI_CODEX_DEVICE_TIMEOUT_MS = 15 * 60 * 1000;
const RUNTIME_DEPRECATED_MODEL_IDS = new Set([
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex-max",
]);
const RUNTIME_LEGACY_DIRECT_PROVIDER_MODEL_ALIASES: Record<
  string,
  Record<string, string>
> = {
  anthropic_direct: {
    "claude-sonnet-4-5": "claude-sonnet-4-6",
  },
  gemini_direct: {
    "gemini-3.1-pro-preview": "gemini-2.5-pro",
    "gemini-2.5-flash-lite": "gemini-2.5-flash",
    "gemini-3.1-flash-lite-preview": "gemini-2.5-flash",
  },
};

interface DevLaunchContext {
  devServerUrl: string;
  userDataPath: string;
}

interface DesktopNativeNotificationPayload {
  title: string;
  body: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  force?: boolean;
}

function maybeAuthCallbackUrl(argument: string | undefined): string | null {
  if (!argument) {
    return null;
  }
  const normalized = argument.trim();
  if (!normalized) {
    return null;
  }
  return normalized.startsWith(`${AUTH_CALLBACK_PROTOCOL}://`) ||
    normalized.startsWith(`${AUTH_CALLBACK_PROTOCOL}:/`)
    ? normalized
    : null;
}

function devLaunchContextPath(): string {
  return path.join(app.getPath("appData"), APP_DISPLAY_NAME, "dev-launch.json");
}

const DEFAULT_APP_PROTOCOL_FLAGS_WITH_SEPARATE_VALUE = new Set([
  "--require",
  "-r",
]);

function defaultAppLaunchTargetArg(): string | null {
  for (let index = 1; index < process.argv.length; index += 1) {
    const argument = process.argv[index]?.trim();
    if (!argument) {
      continue;
    }
    if (argument.startsWith("-")) {
      if (
        DEFAULT_APP_PROTOCOL_FLAGS_WITH_SEPARATE_VALUE.has(argument) &&
        index + 1 < process.argv.length
      ) {
        index += 1;
      }
      continue;
    }
    if (maybeAuthCallbackUrl(argument)) {
      continue;
    }
    return path.resolve(argument);
  }
  return null;
}

function clearStaleDevLaunchContext() {
  if (defaultAppLaunchTargetArg()) {
    return;
  }
  try {
    unlinkSync(devLaunchContextPath());
  } catch {
    // Ignore missing or concurrently-removed files.
  }
}

function loadRecoveredDevLaunchContext(): DevLaunchContext | null {
  if (!defaultAppLaunchTargetArg()) {
    return null;
  }

  const hasAuthCallbackArgument = process.argv.some((value) =>
    maybeAuthCallbackUrl(value),
  );
  if (!hasAuthCallbackArgument) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      readFileSync(devLaunchContextPath(), "utf8"),
    ) as Partial<DevLaunchContext>;
    const devServerUrl =
      typeof parsed.devServerUrl === "string" ? parsed.devServerUrl.trim() : "";
    const userDataPath =
      typeof parsed.userDataPath === "string" ? parsed.userDataPath.trim() : "";
    if (!devServerUrl || !userDataPath) {
      return null;
    }
    return {
      devServerUrl,
      userDataPath,
    };
  } catch {
    return null;
  }
}

clearStaleDevLaunchContext();
const recoveredDevLaunchContext = loadRecoveredDevLaunchContext();
const RESOLVED_DEV_SERVER_URL =
  process.env.VITE_DEV_SERVER_URL?.trim() ||
  recoveredDevLaunchContext?.devServerUrl ||
  "";
const isDev = Boolean(RESOLVED_DEV_SERVER_URL);

const DEV_SHELL_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https:",
  "font-src 'self' data:",
  "connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:* https: wss:",
  "worker-src 'self' blob:",
  // App surfaces are rendered in renderer iframes and resolve to local
  // runtime ports such as http://localhost:38090 during development.
  "frame-src 'self' http://localhost:* http://127.0.0.1:* https:",
  "media-src 'self' data: blob: https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

// CSP for the main shell:
//   - prod: a strict policy is injected at build time as a <meta http-equiv>
//     tag in index.html (see vite.config.ts). file:// responses don't fire
//     onHeadersReceived in Electron, so the meta tag is the only enforcement
//     path there.
//   - dev: Vite HMR needs eval/inline + ws://localhost; we inject a relaxed
//     CSP via onHeadersReceived, scoped to the dev server origin so browser
//     tab navigations and other partitioned sessions are unaffected.
function applyMainShellContentSecurityPolicy(targetSession: Session): void {
  if (!isDev || !RESOLVED_DEV_SERVER_URL) {
    return;
  }
  const devOrigin = (() => {
    try {
      return new URL(RESOLVED_DEV_SERVER_URL).origin;
    } catch {
      return "";
    }
  })();
  if (!devOrigin) {
    return;
  }
  targetSession.webRequest.onHeadersReceived((details, callback) => {
    let inDevOrigin = false;
    try {
      inDevOrigin = new URL(details.url).origin === devOrigin;
    } catch {
      inDevOrigin = false;
    }
    if (!inDevOrigin) {
      callback({ responseHeaders: details.responseHeaders ?? undefined });
      return;
    }
    const nextHeaders: Record<string, string[]> = {};
    for (const [name, value] of Object.entries(details.responseHeaders ?? {})) {
      if (name.toLowerCase() === "content-security-policy") {
        continue;
      }
      nextHeaders[name] = Array.isArray(value) ? value : [value];
    }
    nextHeaders["Content-Security-Policy"] = [DEV_SHELL_CSP];
    callback({ responseHeaders: nextHeaders });
  });
}

function configureChromiumLoggingPolicy() {
  if (verboseTelemetryEnabled || chromiumStderrLoggingEnabled) {
    return;
  }

  delete process.env.ELECTRON_ENABLE_LOGGING;
  app.commandLine.appendSwitch("disable-logging");
  app.commandLine.appendSwitch("log-level", "3");
}

configureChromiumLoggingPolicy();

interface DirectoryEntryPayload {
  name: string;
  absolutePath: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

interface DirectoryPayload {
  currentPath: string;
  parentPath: string | null;
  entries: DirectoryEntryPayload[];
}

type FilePreviewKind =
  | "text"
  | "image"
  | "pdf"
  | "table"
  | "presentation"
  | "unsupported";

interface FilePreviewTableImagePayload {
  row: number;
  column: number;
  dataUrl: string;
  widthPx?: number;
  heightPx?: number;
  alt?: string;
}

interface FilePreviewTableSheetPayload {
  name: string;
  index: number;
  columns: string[];
  rows: string[][];
  links?: (string | null)[][];
  images?: FilePreviewTableImagePayload[];
  totalRows: number;
  totalColumns: number;
  truncated: boolean;
  hasHeaderRow: boolean;
}

type TablePreviewSheetCollection = FilePreviewTableSheetPayload[] & {
  previewOnly?: boolean;
};

interface FilePreviewPresentationTextBoxPayload {
  xPct: number;
  yPct: number;
  widthPct: number;
  heightPct: number;
  paragraphs: string[];
  align: "left" | "center" | "right" | "justify";
  fontSizePx?: number;
  bold?: boolean;
}

interface FilePreviewPresentationSlidePayload {
  index: number;
  boxes: FilePreviewPresentationTextBoxPayload[];
}

interface FilePreviewPayload {
  absolutePath: string;
  name: string;
  extension: string;
  kind: FilePreviewKind;
  mimeType?: string;
  content?: string;
  dataUrl?: string;
  tableSheets?: FilePreviewTableSheetPayload[];
  presentationSlides?: FilePreviewPresentationSlidePayload[];
  presentationWidth?: number;
  presentationHeight?: number;
  size: number;
  modifiedAt: string;
  isEditable: boolean;
  unsupportedReason?: string;
}

interface FileBookmarkPayload {
  id: string;
  targetPath: string;
  label: string;
  isDirectory: boolean;
  createdAt: string;
}

interface FileSystemMutationPayload {
  absolutePath: string;
}

type ExplorerExternalImportEntryPayload =
  | {
      kind: "directory";
      relativePath: string;
    }
  | {
      kind: "file";
      relativePath: string;
      content: Uint8Array;
    };

interface ExplorerExternalImportResultPayload {
  absolutePaths: string[];
}

type FileSystemCreateKind = "file" | "directory";

interface FilePreviewWatchSubscriptionPayload {
  subscriptionId: string;
  absolutePath: string;
}

interface FilePreviewChangePayload {
  absolutePath: string;
}

interface BrowserBoundsPayload {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BrowserVisibleSnapshotPayload {
  bounds: BrowserBoundsPayload;
  dataUrl: string;
}

interface BrowserStatePayload {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  initialized: boolean;
  error: string;
}

const BROWSER_SPACE_IDS = ["user", "agent"] as const;

type BrowserSpaceId = (typeof BROWSER_SPACE_IDS)[number];

interface BrowserTabCountsPayload {
  user: number;
  agent: number;
}

interface BrowserTabListPayload {
  space: BrowserSpaceId;
  activeTabId: string;
  tabs: BrowserStatePayload[];
  tabCounts: BrowserTabCountsPayload;
  sessionId: string | null;
  lifecycleState: BrowserSurfaceLifecycleState | null;
  controlMode: BrowserSurfaceControlMode;
  controlSessionId: string | null;
}

type BrowserSurfaceLifecycleState = "active" | "suspended";
type BrowserSurfaceControlMode = "none" | "user_locked" | "session_owned";

type OperatorSurfaceType = "browser" | "editor" | "terminal" | "app_surface";
type OperatorSurfaceOwner = "user" | "agent";
type OperatorSurfaceMutability = "inspect_only" | "takeover_allowed" | "agent_owned";

interface OperatorSurfacePayload {
  surface_id: string;
  surface_type: OperatorSurfaceType;
  owner: OperatorSurfaceOwner;
  active: boolean;
  mutability: OperatorSurfaceMutability;
  summary: string;
}

interface OperatorSurfaceContextPayload {
  active_surface_id: string | null;
  surfaces: OperatorSurfacePayload[];
}

interface ReportedOperatorSurfaceContextPayload extends OperatorSurfaceContextPayload {
  updated_at: string;
}

interface BrowserTabRecord {
  view: BrowserView;
  state: BrowserStatePayload;
  popupFrameName?: string;
  popupOpenedAtMs?: number;
  consoleEntries: BrowserConsoleEntry[];
  errorEntries: BrowserObservedError[];
  requests: Map<string, BrowserRequestRecord>;
  requestOrder: string[];
}

interface BrowserUserLockState {
  sessionId: string;
  acquiredAt: string;
  heartbeatAt: string;
  reason: string | null;
}

interface BrowserTabSpaceState {
  tabs: Map<string, BrowserTabRecord>;
  activeTabId: string;
  persistedTabs: BrowserWorkspaceTabPersistencePayload[];
  lifecycleState: BrowserSurfaceLifecycleState;
  lastTouchedAt: string;
  suspendTimer: ReturnType<typeof setTimeout> | null;
}

interface BrowserWorkspaceTabPersistencePayload {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
}

interface BrowserWorkspaceTabSpacePersistencePayload {
  activeTabId: string;
  tabs: BrowserWorkspaceTabPersistencePayload[];
}

interface BrowserWorkspacePersistencePayload {
  activeTabId: string;
  tabs: BrowserWorkspaceTabPersistencePayload[];
  spaces?: Partial<
    Record<BrowserSpaceId, BrowserWorkspaceTabSpacePersistencePayload>
  >;
  activeAgentSessionId?: string | null;
  agentSessions?: Record<string, BrowserWorkspaceTabSpacePersistencePayload>;
  bookmarks: BrowserBookmarkPayload[];
  downloads: BrowserDownloadPayload[];
  history: BrowserHistoryEntryPayload[];
}

interface BrowserWorkspaceState {
  workspaceId: string;
  partition: string;
  session: Session;
  browserIdentity: BrowserSessionIdentity;
  spaces: Record<BrowserSpaceId, BrowserTabSpaceState>;
  userBrowserLock: BrowserUserLockState | null;
  activeAgentSessionId: string | null;
  agentSessionSpaces: Map<string, BrowserTabSpaceState>;
  bookmarks: BrowserBookmarkPayload[];
  downloads: BrowserDownloadPayload[];
  history: BrowserHistoryEntryPayload[];
  downloadTrackingRegistered: boolean;
  pendingDownloadOverrides: BrowserDownloadOverride[];
}

interface BrowserDownloadOverride {
  url: string;
  defaultPath: string;
  dialogTitle: string;
  buttonLabel: string;
}

interface BrowserSessionIdentity {
  userAgent: string;
  acceptLanguages: string;
}

interface BrowserBookmarkPayload {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
  folderPath?: string[];
  createdAt: string;
}

type BrowserDownloadStatus =
  | "progressing"
  | "completed"
  | "cancelled"
  | "interrupted";

interface BrowserDownloadPayload {
  id: string;
  url: string;
  filename: string;
  targetPath: string;
  status: BrowserDownloadStatus;
  receivedBytes: number;
  totalBytes: number;
  createdAt: string;
  completedAt: string | null;
}

// Types + pure observability helpers moved to browser-pane/observability.ts
// (re-imported below).
type BrowserConsoleLevel = BrowserConsoleLevelImported;
type BrowserErrorSource = BrowserErrorSourceImported;
type BrowserConsoleEntry = BrowserConsoleEntryImported;
type BrowserObservedError = BrowserObservedErrorImported;
type BrowserRequestBodyMetadata = BrowserRequestBodyMetadataImported;
type BrowserResponseBodyMetadata = BrowserResponseBodyMetadataImported;
type BrowserRequestRecord = BrowserRequestRecordImported;

interface BrowserHistoryEntryPayload {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
  visitCount: number;
  createdAt: string;
  lastVisitedAt: string;
}

interface BrowserClipboardScreenshotPayload {
  tabId: string;
  pageTitle: string;
  url: string;
  width: number;
  height: number;
  copied: boolean;
}

interface ClipboardImagePayload {
  name: string;
  mime_type: string;
  content_base64: string;
  width: number;
  height: number;
}

// Browser import / chromium-family types moved to
// `browser-pane/types.ts` and re-imported above.

interface BrowserAnchorBoundsPayload {
  x: number;
  y: number;
  width: number;
  height: number;
}

type UiSettingsPaneSection =
  | "account"
  | "billing"
  | "providers"
  | "integrations"
  | "submissions"
  | "settings"
  | "about";

interface AddressSuggestionPayload {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
}

type RuntimeStatus =
  | "disabled"
  | "missing"
  | "starting"
  | "running"
  | "stopped"
  | "error";

interface RuntimeStatusPayload {
  status: RuntimeStatus;
  available: boolean;
  runtimeRoot: string | null;
  sandboxRoot: string | null;
  executablePath: string | null;
  url: string | null;
  pid: number | null;
  harness: string | null;
  desktopBrowserReady: boolean;
  desktopBrowserUrl: string | null;
  startupMessage: string | null;
  lastError: string;
}

interface RuntimeConfigPayload {
  configPath: string | null;
  loadedFromFile: boolean;
  authTokenPresent: boolean;
  userId: string | null;
  sandboxId: string | null;
  modelProxyBaseUrl: string | null;
  defaultModel: string | null;
  subagentModel: string | null;
  defaultBackgroundModel: string | null;
  defaultEmbeddingModel: string | null;
  defaultImageModel: string | null;
  controlPlaneBaseUrl: string | null;
  catalogVersion: string | null;
  providerModelGroups: RuntimeProviderModelGroupPayload[];
}

interface RuntimeProviderModelPayload {
  token: string;
  modelId: string;
  label?: string;
  reasoning?: boolean;
  thinkingValues?: string[];
  defaultThinkingValue?: string | null;
  inputModalities?: ModelCatalogInputModality[];
  capabilities?: string[];
}

interface RuntimeProviderModelGroupPayload {
  providerId: string;
  providerLabel: string;
  kind: string;
  models: RuntimeProviderModelPayload[];
}

interface RuntimeConfigUpdatePayload {
  authToken?: string | null;
  modelProxyApiKey?: string | null;
  userId?: string | null;
  sandboxId?: string | null;
  modelProxyBaseUrl?: string | null;
  defaultModel?: string | null;
  subagentModel?: string | null;
  defaultProvider?: string | null;
  defaultBackgroundModel?: string | null;
  defaultEmbeddingModel?: string | null;
  defaultImageModel?: string | null;
  controlPlaneBaseUrl?: string | null;
}

type RuntimeUserProfileNameSource = "manual" | "agent" | "authFallback";

interface RuntimeUserProfilePayload {
  profileId: string;
  name: string | null;
  nameSource: RuntimeUserProfileNameSource | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface RuntimeUserProfileUpdatePayload {
  profileId?: string | null;
  name?: string | null;
  nameSource?: RuntimeUserProfileNameSource | null;
}

interface AuthUserPayload {
  id: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
  [key: string]: unknown;
}

interface AuthErrorPayload {
  message?: string;
  status: number;
  statusText: string;
  path: string;
}

type AppUpdateChannel = "latest" | "beta";

interface AppUpdatePreferencesPayload {
  dismissedVersion?: string | null;
  dismissedReleaseTag?: string | null;
  preferredChannel?: AppUpdateChannel | null;
}

interface AppUpdateStatusPayload {
  supported: boolean;
  checking: boolean;
  available: boolean;
  downloaded: boolean;
  downloadProgressPercent: number | null;
  currentVersion: string;
  latestVersion: string | null;
  releaseName: string | null;
  publishedAt: string | null;
  dismissedVersion: string | null;
  lastCheckedAt: string | null;
  error: string;
  channel: AppUpdateChannel;
  preferredChannel: AppUpdateChannel | null;
}

interface DesktopWindowStatePayload {
  isFullScreen: boolean;
  isMaximized: boolean;
  isMinimized: boolean;
}
interface WorkbenchOpenBrowserPayload {
  workspaceId?: string | null;
  url?: string | null;
  space?: BrowserSpaceId | null;
  sessionId?: string | null;
}

let mainWindow: BrowserWindow | null = null;
let authPopupWindow: BrowserWindow | null = null;
let authPopupCloseTimer: ReturnType<typeof setTimeout> | null = null;
let statusItemTray: Tray | null = null;
const unresponsiveDesktopWindows = new WeakSet<BrowserWindow>();
let attachedBrowserTabView: BrowserView | null = null;
let attachedAppSurfaceView: BrowserView | null = null;
let currentTheme = "holaos-light";
let browserBounds: BrowserBoundsPayload = { x: 0, y: 0, width: 0, height: 0 };
// Popup state (downloads / history / overflow / address suggestions) lives in
// `browser-pane/popups.ts`. main.ts holds the module instance below and
// delegates IPC handler bodies through it.
const browserPanePopups: BrowserPanePopups = createBrowserPanePopups({
  getMainWindow: () => mainWindow,
  popupThemeCss: () => popupThemeCss(),
  preloadDir: () => __dirname,
});
const browserPaneBookmarks: BrowserPaneBookmarks = createBrowserPaneBookmarks({
  getMainWindow: () => mainWindow,
  getActiveWorkspaceId: () => activeBrowserWorkspaceId,
  getWorkspaceBookmarks: (workspaceId) =>
    browserWorkspaceOrEmpty(workspaceId)?.bookmarks ?? [],
});
const browserPaneDownloads: BrowserPaneDownloads = createBrowserPaneDownloads({
  getMainWindow: () => mainWindow,
  getActiveWorkspaceId: () => activeBrowserWorkspaceId,
  getWorkspace: (id) => browserWorkspaceFromMap(id),
  consumeDownloadOverride: (workspace, targetUrl) =>
    consumeBrowserDownloadOverride(
      workspace as unknown as BrowserWorkspaceState,
      targetUrl,
    ),
  resolveTargetPath: (workspaceId, filename) =>
    resolveWorkspaceDownloadTargetPath(workspaceId, filename),
  persistWorkspace: (workspaceId) => persistBrowserWorkspace(workspaceId),
  sendDownloadsToPopup: (downloads) =>
    browserPanePopups.sendDownloadsToPopup(downloads),
  hasOpenDownloadsPopup: () => browserPanePopups.hasOpenDownloadsPopup(),
});
const emitBookmarksState = browserPaneBookmarks.emitBookmarksState;
const emitDownloadsState = browserPaneDownloads.emitDownloadsState;
const ensureBrowserWorkspaceDownloadTracking = (
  workspace: BrowserWorkspaceState,
) =>
  browserPaneDownloads.ensureBrowserWorkspaceDownloadTracking(
    workspace as unknown as Parameters<
      typeof browserPaneDownloads.ensureBrowserWorkspaceDownloadTracking
    >[0],
  );
let activeBrowserWorkspaceId = "";
let activeBrowserSpaceId: BrowserSpaceId = "user";
let activeBrowserSessionId = "";
const browserWorkspaces = new Map<string, BrowserWorkspaceState>();
function* eachBrowserTabRecord(): IterableIterator<BrowserTabRecord> {
  for (const workspace of browserWorkspaces.values()) {
    for (const tab of workspace.spaces.user.tabs.values()) {
      yield tab;
    }
    for (const tab of workspace.spaces.agent.tabs.values()) {
      yield tab;
    }
    for (const tabSpace of workspace.agentSessionSpaces.values()) {
      for (const tab of tabSpace.tabs.values()) {
        yield tab;
      }
    }
  }
}
const tabObservability = createTabObservability({
  eachTabRecord: () => eachBrowserTabRecord(),
});
const browserTabForWebContentsId = tabObservability.browserTabForWebContentsId;
const appendBrowserObservedError = tabObservability.appendBrowserObservedError;
const upsertBrowserRequestRecord = tabObservability.upsertBrowserRequestRecord;
const trackBrowserRequestStart = tabObservability.trackBrowserRequestStart;
const trackBrowserRequestHeaders = tabObservability.trackBrowserRequestHeaders;
const trackBrowserRequestCompletion =
  tabObservability.trackBrowserRequestCompletion;
const trackBrowserRequestFailure = tabObservability.trackBrowserRequestFailure;
const sessionRuntimeStateCache = new Map<
  string,
  Map<string, SessionRuntimeRecordPayload>
>();
const agentSessionCache = new Map<
  string,
  Map<string, AgentSessionRecordPayload>
>();
// userBrowserInterruptPrompts (the dedup Set) and
// programmaticBrowserInputDepth (the per-WebContents re-entrant counter)
// moved into the closure of createBrowserUserLock — see further down where
// browserUserLock is instantiated.
const reportedOperatorSurfaceContexts = new Map<
  string,
  ReportedOperatorSurfaceContextPayload
>();
const appSurfaceViews = new Map<string, BrowserView>();
let appSurfaceBounds: BrowserBoundsPayload = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
};
let activeAppSurfaceId: string | null = null;
let fileBookmarks: FileBookmarkPayload[] = [];
const filePreviewWatchSubscriptions = new Map<
  string,
  {
    absolutePath: string;
    watcher: FSWatcher;
  }
>();
let runtimeProcess: ChildProcessWithoutNullStreams | null = null;
const intentionallyStoppedRuntimeProcesses =
  new WeakSet<ChildProcessWithoutNullStreams>();
const DEFERRED_RUNTIME_RESTART_POLL_MS = 5_000;
let deferredRuntimeRestartTimer: NodeJS.Timeout | null = null;
let deferredRuntimeRestartReason: string | null = null;
let deferredRuntimeRestartInFlight = false;
let appQuitCleanupPromise: Promise<void> | null = null;
let appQuitCleanupFinished = false;
let pendingAuthUser: AuthUserPayload | null = null;
let pendingAuthError: AuthErrorPayload | null = null;
let runtimeStatus: RuntimeStatusPayload = {
  status: "disabled",
  available: false,
  runtimeRoot: null,
  sandboxRoot: null,
  executablePath: null,
  url: null,
  pid: null,
  harness: null,
  desktopBrowserReady: false,
  desktopBrowserUrl: null,
  startupMessage: null,
  lastError: "",
};
let desktopBrowserServiceServer: HttpServer | null = null;
let desktopBrowserServiceUrl = "";
let desktopBrowserServiceAuthToken = "";
let appUpdateCheckTimer: NodeJS.Timeout | null = null;
let appUpdateCheckPromise: Promise<AppUpdateStatusPayload> | null = null;
let appUpdateDownloadPromise: Promise<Array<string>> | null = null;
let appUpdateEventsConfigured = false;
let appUpdatePreferences: AppUpdatePreferencesPayload = {};
let notificationPreferences: { enabled: boolean } = { enabled: true };
let codexOauthRefreshTimer: NodeJS.Timeout | null = null;
let codexOauthRefreshPromise: Promise<boolean> | null = null;
let runtimeModelCatalogState: RuntimeModelCatalogPayload = {
  catalogVersion: null,
  defaultBackgroundModel: null,
  defaultEmbeddingModel: null,
  defaultImageModel: null,
  providerModelGroups: [],
  fetchedAt: null,
};
let runtimeModelCatalogRefreshPromise: Promise<void> | null = null;
let lastRuntimeModelCatalogRefreshAtMs = 0;
let lastRuntimeModelCatalogRefreshFailureAtMs = 0;
let appUpdateStatus: AppUpdateStatusPayload = {
  supported: false,
  checking: false,
  available: false,
  downloaded: false,
  downloadProgressPercent: null,
  currentVersion: normalizeReleaseVersion(app.getVersion()),
  latestVersion: null,
  releaseName: null,
  publishedAt: null,
  dismissedVersion: null,
  lastCheckedAt: null,
  error: "",
  channel: "latest",
  preferredChannel: null,
};

function desktopWindowTelemetryRole(window: BrowserWindow | null | undefined): string {
  if (!window) {
    return "unknown";
  }
  if (window === mainWindow) {
    return "main";
  }
  if (window === authPopupWindow) {
    return "auth_popup";
  }
  const popupKind = browserPanePopups.classifyWindow(window);
  if (popupKind) {
    return popupKind;
  }
  return "browser_window";
}

function safeWebContentsUrl(contents: WebContents): string | null {
  try {
    return contents.getURL() || null;
  } catch {
    return null;
  }
}

function addDesktopLifecycleBreadcrumb(
  category: string,
  message: string,
  data?: Record<string, unknown>,
) {
  Sentry.addBreadcrumb({
    category: `desktop.${category}`,
    message,
    level: "info",
    data: data
      ? (redactDesktopSentryValue(data) as Record<string, unknown>)
      : undefined,
  });
}

function captureDesktopLifecycleEvent(params: {
  message: string;
  level: Sentry.SeverityLevel;
  fingerprint: string[];
  tags?: Record<string, string | null | undefined>;
  contexts?: Record<string, Record<string, unknown> | null | undefined>;
}) {
  Sentry.withScope((scope) => {
    scope.setLevel(params.level);
    scope.setFingerprint(params.fingerprint);
    for (const [key, value] of Object.entries(params.tags ?? {})) {
      const normalizedValue = value?.trim();
      if (normalizedValue) {
        scope.setTag(key, normalizedValue);
      }
    }
    for (const [key, context] of Object.entries(params.contexts ?? {})) {
      if (context) {
        scope.setContext(
          key,
          redactDesktopSentryValue(context) as Record<string, unknown>,
        );
      }
    }
    Sentry.captureMessage(params.message);
  });
}

// Port 5060 is SIP — blocked by Node.js fetch (undici "bad port").
const RUNTIME_API_PORT_FALLBACK = 5160;
const RUNTIME_API_PORT_RANGE_START = 39160;
const RUNTIME_API_PORT_RANGE_SIZE = 2000;
let resolvedRuntimeApiPort = RUNTIME_API_PORT_FALLBACK;

function parseRuntimeApiPort(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    return null;
  }
  if (parsed === 5060) {
    return null;
  }
  return parsed;
}

function runtimeApiPortForUserDataPath(userDataPath: string): number {
  const hash = Number.parseInt(
    createHash("sha256")
      .update(path.resolve(userDataPath), "utf8")
      .digest("hex")
      .slice(0, 8),
    16,
  );
  return RUNTIME_API_PORT_RANGE_START + (hash % RUNTIME_API_PORT_RANGE_SIZE);
}

function resolveRuntimeApiPort(): number {
  const explicit = parseRuntimeApiPort(
    process.env.HOLABOSS_RUNTIME_API_PORT?.trim() || "",
  );
  if (explicit !== null) {
    return explicit;
  }
  return runtimeApiPortForUserDataPath(app.getPath("userData"));
}

function runtimeApiPort(): number {
  return resolvedRuntimeApiPort;
}

function runtimePlatformFromProcessPlatform(
  platform: NodeJS.Platform = process.platform,
): "macos" | "linux" | "windows" {
  switch (platform) {
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      throw new Error(`Unsupported host platform: ${platform}`);
  }
}

function runtimeBundleDirName(
  runtimePlatform:
    | "macos"
    | "linux"
    | "windows" = runtimePlatformFromProcessPlatform(),
): string {
  return `runtime-${runtimePlatform}`;
}

function runtimeBundleExecutableRelativePaths(
  runtimePlatform:
    | "macos"
    | "linux"
    | "windows" = runtimePlatformFromProcessPlatform(),
): string[] {
  const base = path.join("bin", "sandbox-runtime");
  return runtimePlatform === "windows"
    ? [`${base}.mjs`, `${base}.cmd`, `${base}.ps1`, `${base}.exe`, base]
    : [base];
}

function runtimeBundleNodeRelativePaths(
  runtimePlatform:
    | "macos"
    | "linux"
    | "windows" = runtimePlatformFromProcessPlatform(),
): string[] {
  const base = path.join("node-runtime", "node_modules", ".bin", "node");
  const packagedBin =
    runtimePlatform === "windows"
      ? path.join("node-runtime", "bin", "node.exe")
      : path.join("node-runtime", "node_modules", "node", "bin", "node");
  return runtimePlatform === "windows"
    ? [packagedBin, `${base}.exe`, `${base}.cmd`, base]
    : [packagedBin, base];
}

function runtimeBundleNpmRelativePaths(
  runtimePlatform:
    | "macos"
    | "linux"
    | "windows" = runtimePlatformFromProcessPlatform(),
): string[] {
  const base = path.join("node-runtime", "node_modules", ".bin", "npm");
  return runtimePlatform === "windows"
    ? [
        path.join("node-runtime", "bin", "npm.cmd"),
        path.join("node-runtime", "bin", "npm"),
        `${base}.cmd`,
        base,
        path.join("node-runtime", "node_modules", "npm", "bin", "npm-cli.js"),
      ]
    : [
        base,
        path.join("node-runtime", "node_modules", "npm", "bin", "npm-cli.js"),
      ];
}

function runtimeBundlePythonRelativePaths(
  runtimePlatform:
    | "macos"
    | "linux"
    | "windows" = runtimePlatformFromProcessPlatform(),
): string[] {
  const base = path.join("python-runtime", "bin", "python");
  return runtimePlatform === "windows"
    ? [
        `${base}.cmd`,
        path.join("python-runtime", "python", "python.exe"),
        path.join("python-runtime", "python", "python3.exe"),
      ]
    : [base];
}

const CURRENT_RUNTIME_PLATFORM = runtimePlatformFromProcessPlatform();
const RUNTIME_BUNDLE_DIR = runtimeBundleDirName(CURRENT_RUNTIME_PLATFORM);
const DEV_RUNTIME_ROOT =
  process.env.HOLABOSS_DEV_RUNTIME_ROOT?.trim() ||
  path.join(os.tmpdir(), `holaboss-runtime-${CURRENT_RUNTIME_PLATFORM}-full`);
const configuredDesktopUserDataDir =
  process.env.HOLABOSS_DESKTOP_USER_DATA_DIR?.trim() || "";
const DESKTOP_USER_DATA_DIR = (
  configuredDesktopUserDataDir ||
  (isDev ? "holaboss-local-dev" : "holaboss-local")
).replace(/[\\/]+/g, "_");
const normalizeBaseUrl = (value: string): string =>
  value.trim().replace(/\/+$/, "");
interface PackagedDesktopConfig {
  authBaseUrl?: string;
  authSignInUrl?: string;
  backendBaseUrl?: string;
  desktopControlPlaneBaseUrl?: string;
  projectsUrl?: string;
  marketplaceUrl?: string;
  proactiveUrl?: string;
  appUpdateEnabled?: boolean;
  macWebAuthnKeychainAccessGroup?: string;
  updateChannel?: string;
}

interface ElectronWebAuthnApp {
  configureWebAuthn?: (options: {
    touchID?: {
      keychainAccessGroup: string;
    };
  }) => void;
}

interface RuntimeLaunchSpec {
  command: string;
  args: string[];
}

function loadPackagedDesktopConfig(): PackagedDesktopConfig {
  if (!app.isPackaged) {
    return {};
  }

  const configPath = path.join(process.resourcesPath, "holaboss-config.json");
  try {
    if (!existsSync(configPath)) {
      return {};
    }
    return JSON.parse(
      readFileSync(configPath, "utf8"),
    ) as PackagedDesktopConfig;
  } catch {
    return {};
  }
}

const packagedDesktopConfig = loadPackagedDesktopConfig();

function configuredMacWebAuthnKeychainAccessGroup(): string {
  return (
    process.env.HOLABOSS_MAC_WEBAUTHN_KEYCHAIN_ACCESS_GROUP?.trim() ||
    packagedDesktopConfig.macWebAuthnKeychainAccessGroup?.trim() ||
    ""
  );
}

function configureMacWebAuthnPlatformAuthenticator(): void {
  if (process.platform !== "darwin") {
    return;
  }
  const keychainAccessGroup = configuredMacWebAuthnKeychainAccessGroup();
  if (!keychainAccessGroup) {
    return;
  }
  const electronApp = app as typeof app & ElectronWebAuthnApp;
  if (typeof electronApp.configureWebAuthn !== "function") {
    return;
  }
  electronApp.configureWebAuthn({
    touchID: {
      keychainAccessGroup,
    },
  });
}

function normalizeAppUpdateChannel(
  value: string | null | undefined,
): AppUpdateChannel | null {
  const normalized = value?.trim().toLowerCase() || "";
  if (!normalized) {
    return null;
  }
  if (normalized === "latest") {
    return "latest";
  }
  if (normalized === "beta") {
    return "beta";
  }
  return null;
}

const DEFAULT_APP_UPDATE_CHANNEL =
  normalizeAppUpdateChannel(packagedDesktopConfig.updateChannel) ?? "latest";

function preferredAppUpdateChannel(): AppUpdateChannel | null {
  return normalizeAppUpdateChannel(appUpdatePreferences.preferredChannel);
}

function effectiveAppUpdateChannel(): AppUpdateChannel {
  return (
    normalizeAppUpdateChannel(process.env.HOLABOSS_APP_UPDATE_CHANNEL) ??
    preferredAppUpdateChannel() ??
    DEFAULT_APP_UPDATE_CHANNEL
  );
}

function syncAppUpdateChannelState() {
  appUpdateStatus = {
    ...appUpdateStatus,
    channel: effectiveAppUpdateChannel(),
    preferredChannel: preferredAppUpdateChannel(),
  };
}
const INTERNAL_DEV_BACKEND_OVERRIDES_ENABLED =
  Boolean(RESOLVED_DEV_SERVER_URL) ||
  process.env.HOLABOSS_INTERNAL_DEV?.trim() === "1";
function internalOverride(envName: string): string {
  if (!INTERNAL_DEV_BACKEND_OVERRIDES_ENABLED) {
    return "";
  }
  return process.env[envName]?.trim() || "";
}
function publicRuntimeEnv(envName: string): string {
  return process.env[envName]?.trim() || "";
}
function configuredRemoteBaseUrl(
  envNames: string[],
  packagedValue?: string,
): string {
  for (const envName of envNames) {
    const value = normalizeBaseUrl(
      internalOverride(envName) || publicRuntimeEnv(envName),
    );
    if (value) {
      return value;
    }
  }
  if (packagedValue) {
    return normalizeBaseUrl(packagedValue);
  }
  return "";
}
const AUTH_BASE_URL = configuredRemoteBaseUrl(
  ["HOLABOSS_AUTH_BASE_URL"],
  packagedDesktopConfig.authBaseUrl,
);
const BACKEND_BASE_URL = configuredRemoteBaseUrl(
  ["HOLABOSS_BACKEND_BASE_URL"],
  packagedDesktopConfig.backendBaseUrl,
);
const DESKTOP_CONTROL_PLANE_BASE_URL =
  configuredRemoteBaseUrl(
    ["HOLABOSS_DESKTOP_CONTROL_PLANE_BASE_URL"],
    packagedDesktopConfig.desktopControlPlaneBaseUrl,
  ) || serviceBaseUrlFromControlPlane(BACKEND_BASE_URL, 3060);
const AUTH_SIGN_IN_URL = configuredRemoteBaseUrl(
  ["HOLABOSS_AUTH_SIGN_IN_URL"],
  packagedDesktopConfig.authSignInUrl,
);

// Hosts the renderer is allowed to reach via the bff:fetch IPC bridge.
// Derived from the configured AUTH/BACKEND base URLs so the allowlist tracks
// whichever environment (prod, staging, local) the desktop is wired to.
function bffFetchAllowedHosts(): readonly string[] {
  const hosts = new Set<string>();
  for (const base of [AUTH_BASE_URL, BACKEND_BASE_URL]) {
    if (!base) continue;
    try {
      hosts.add(new URL(base).host);
    } catch {
      // ignore malformed config — the allowlist stays narrower
    }
  }
  return [...hosts];
}
const DESKTOP_RUNTIME_BINDING_EXCHANGE_PATH =
  "/api/v1/desktop-runtime/bindings/exchange";
const DESKTOP_RUNTIME_MODEL_CATALOG_PATH =
  "/api/v1/desktop-runtime/model-catalog";
const DESKTOP_RUNTIME_WORKSPACES_PATH =
  "/api/v1/desktop-runtime/workspaces";
const LOCAL_RUNTIME_SCHEMA_VERSION = 1;
const RUNTIME_BINDING_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
const RUNTIME_BINDING_REFRESH_FAILURE_BACKOFF_MS = 60 * 1000;
const RUNTIME_MODEL_CATALOG_REFRESH_INTERVAL_MS = 3 * 60 * 1000;
const RUNTIME_MODEL_CATALOG_REFRESH_FAILURE_BACKOFF_MS = 60 * 1000;
const RUNTIME_MODEL_CATALOG_FETCH_TIMEOUT_MS = 8_000;

type TrustedIpcSenderScope = "main" | "auth-popup";

function trustedIpcSenderWindow(
  scope: TrustedIpcSenderScope,
): BrowserWindow | null {
  if (scope === "main") {
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  }
  return authPopupWindow && !authPopupWindow.isDestroyed()
    ? authPopupWindow
    : null;
}

function assertTrustedIpcSender(
  event: IpcMainInvokeEvent,
  channel: string,
  allowedScopes: TrustedIpcSenderScope[],
) {
  const sender = event.sender;
  const allowed = allowedScopes.some((scope) => {
    const allowedWindow = trustedIpcSenderWindow(scope);
    return Boolean(allowedWindow && allowedWindow.webContents === sender);
  });
  if (!allowed) {
    throw new Error(`Unauthorized IPC sender for ${channel}.`);
  }
}

function handleTrustedIpc<Args extends unknown[], Result>(
  channel: string,
  allowedScopes: TrustedIpcSenderScope[],
  handler: (
    event: IpcMainInvokeEvent,
    ...args: Args
  ) => Result | Promise<Result>,
) {
  ipcMain.handle(channel, (event, ...args: Args) => {
    assertTrustedIpcSender(event, channel, allowedScopes);
    return handler(event, ...args);
  });
}

// Allowed characters for ids that originate from the renderer and end up
// being interpolated into URLs, file paths, or SQL bind parameters in the
// embedded runtime. Conservative on purpose: alnum, dash, underscore, dot.
// We reject path separators, whitespace, control chars, and anything that
// could break out of an URL path segment. These are NOT user-facing labels;
// they are workspace UUIDs and slug-style app ids.
const SAFE_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertSafeId(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${fieldName}: must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Invalid ${fieldName}: must not be empty`);
  }
  if (!SAFE_ID_REGEX.test(trimmed)) {
    throw new Error(
      `Invalid ${fieldName}: must match /[A-Za-z0-9._-]{1,128}/`,
    );
  }
  return trimmed;
}

function assertSafeWorkspaceId(value: unknown): string {
  return assertSafeId(value, "workspaceId");
}

function assertSafeAppId(value: unknown): string {
  return assertSafeId(value, "appId");
}

function configureStableUserDataPath() {
  const explicit =
    process.env.HOLABOSS_DESKTOP_USER_DATA_PATH?.trim() ||
    recoveredDevLaunchContext?.userDataPath?.trim() ||
    "";
  const nextUserDataPath = explicit
    ? path.resolve(explicit)
    : path.join(app.getPath("appData"), DESKTOP_USER_DATA_DIR);
  mkdirSync(nextUserDataPath, { recursive: true });
  if (app.getPath("userData") !== nextUserDataPath) {
    app.setPath("userData", nextUserDataPath);
  }
}

function persistDevLaunchContext() {
  if (!RESOLVED_DEV_SERVER_URL || !defaultAppLaunchTargetArg()) {
    return;
  }

  const nextContext: DevLaunchContext = {
    devServerUrl: RESOLVED_DEV_SERVER_URL,
    userDataPath: app.getPath("userData"),
  };
  const targetPath = devLaunchContextPath();
  mkdirSync(path.dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, JSON.stringify(nextContext, null, 2));
}

function appUpdatePreferencesPath() {
  return path.join(app.getPath("userData"), "app-update-preferences.json");
}

function loadAppUpdatePreferences(): AppUpdatePreferencesPayload {
  const preferencesPath = appUpdatePreferencesPath();
  try {
    if (!existsSync(preferencesPath)) {
      return {};
    }
    const parsed = JSON.parse(
      readFileSync(preferencesPath, "utf8"),
    ) as AppUpdatePreferencesPayload;
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function loadRuntimeModelCatalogCache(): RuntimeModelCatalogPayload {
  const cachePath = runtimeModelCatalogCachePath();
  try {
    if (!existsSync(cachePath)) {
      return {
        catalogVersion: null,
        defaultBackgroundModel: null,
        defaultEmbeddingModel: null,
        defaultImageModel: null,
        providerModelGroups: [],
        fetchedAt: null,
      };
    }
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as unknown;
    const payload = runtimeConfigObject(parsed);
    return {
      catalogVersion:
        runtimeConfigField(payload.catalogVersion as string | undefined) ||
        runtimeConfigField(payload.catalog_version as string | undefined) ||
        null,
      defaultBackgroundModel:
        normalizeRuntimeHolabossCatalogDefaultModelId(
          runtimeFirstNonEmptyString(
            payload.defaultBackgroundModel as string | undefined,
            payload.default_background_model as string | undefined,
          ),
        ) || null,
      defaultEmbeddingModel:
        normalizeRuntimeHolabossCatalogDefaultModelId(
          runtimeFirstNonEmptyString(
            payload.defaultEmbeddingModel as string | undefined,
            payload.default_embedding_model as string | undefined,
          ),
        ) || null,
      defaultImageModel:
        normalizeRuntimeHolabossCatalogDefaultModelId(
          runtimeFirstNonEmptyString(
            payload.defaultImageModel as string | undefined,
            payload.default_image_model as string | undefined,
          ),
        ) || null,
      providerModelGroups: normalizeRuntimeProviderModelGroups(
        Array.isArray(payload.providerModelGroups)
          ? payload.providerModelGroups
          : Array.isArray(payload.provider_model_groups)
            ? payload.provider_model_groups
            : [],
      ),
      fetchedAt:
        runtimeConfigField(payload.fetchedAt as string | undefined) || null,
    };
  } catch {
    return {
      catalogVersion: null,
      defaultBackgroundModel: null,
      defaultEmbeddingModel: null,
      defaultImageModel: null,
      providerModelGroups: [],
      fetchedAt: null,
    };
  }
}

async function persistAppUpdatePreferences() {
  await fs.mkdir(path.dirname(appUpdatePreferencesPath()), { recursive: true });
  await fs.writeFile(
    appUpdatePreferencesPath(),
    `${JSON.stringify(appUpdatePreferences, null, 2)}\n`,
    "utf8",
  );
}

function notificationPreferencesPath() {
  return path.join(app.getPath("userData"), "notification-preferences.json");
}

function loadNotificationPreferences(): { enabled: boolean } {
  const preferencesPath = notificationPreferencesPath();
  try {
    if (!existsSync(preferencesPath)) {
      return { enabled: true };
    }
    const parsed = JSON.parse(readFileSync(preferencesPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && "enabled" in parsed) {
      return { enabled: (parsed as { enabled: unknown }).enabled !== false };
    }
    return { enabled: true };
  } catch {
    return { enabled: true };
  }
}

async function persistNotificationPreferences() {
  await fs.mkdir(path.dirname(notificationPreferencesPath()), {
    recursive: true,
  });
  await fs.writeFile(
    notificationPreferencesPath(),
    `${JSON.stringify(notificationPreferences, null, 2)}\n`,
    "utf8",
  );
}

function serviceBaseUrlFromControlPlane(
  controlPlaneBaseUrl: string,
  port: number,
): string {
  try {
    const parsed = new URL(controlPlaneBaseUrl);
    const protocol = parsed.protocol || "http:";
    const hostname = parsed.hostname;
    if (!hostname) {
      return "";
    }
    return `${protocol}//${hostname}:${port}`;
  } catch {
    return "";
  }
}

function emitAppUpdateState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("appUpdate:state", appUpdateStatus);
}

function emitWorkbenchOpenBrowser(payload?: WorkbenchOpenBrowserPayload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("workbench:openBrowser", payload ?? {});
}

function emitThemeChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("ui:themeChanged", currentTheme);
  }
  if (authPopupWindow && !authPopupWindow.isDestroyed()) {
    authPopupWindow.webContents.send("ui:themeChanged", currentTheme);
  }
}

function normalizeReleaseVersion(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const match = trimmed.match(/(\d+\.\d+\.\d+)$/);
  return match ? match[1] : trimmed;
}

function currentAppVersion() {
  return normalizeReleaseVersion(app.getVersion());
}

function isReleaseStyleAppVersion(version: string) {
  return /^\d{4}\.\d+\.\d+$/.test(version.trim());
}

function currentDesktopReleaseTag() {
  const version = currentAppVersion();
  return version ? `holaOS-${version}` : "";
}

function appUpdateSupported() {
  if (!app.isPackaged || !APP_UPDATE_SUPPORTED_PLATFORMS.has(process.platform)) {
    return false;
  }

  if (typeof packagedDesktopConfig.appUpdateEnabled === "boolean") {
    return packagedDesktopConfig.appUpdateEnabled;
  }

  return isReleaseStyleAppVersion(currentAppVersion());
}

function dismissedAppUpdateVersion() {
  const dismissedVersion = normalizeReleaseVersion(
    appUpdatePreferences.dismissedVersion?.trim() ||
      appUpdatePreferences.dismissedReleaseTag?.trim() ||
      "",
  );
  return dismissedVersion || null;
}

function releaseNameFromUpdateInfo(info: UpdateInfo) {
  const releaseName =
    typeof info.releaseName === "string" ? info.releaseName.trim() : "";
  return releaseName || null;
}

function publishedAtFromUpdateInfo(info: UpdateInfo) {
  const publishedAt =
    typeof info.releaseDate === "string" ? info.releaseDate.trim() : "";
  return publishedAt || null;
}

function latestVersionFromUpdateInfo(info: UpdateInfo) {
  const latestVersion = normalizeReleaseVersion(info.version ?? "");
  return latestVersion || null;
}

function nextAppUpdateTimestamp() {
  return new Date().toISOString();
}

function applyAppUpdateInfo(
  info: UpdateInfo,
  overrides: Partial<AppUpdateStatusPayload> = {},
) {
  appUpdateStatus = {
    ...appUpdateStatus,
    supported: appUpdateSupported(),
    checking: false,
    currentVersion: currentAppVersion(),
    latestVersion: latestVersionFromUpdateInfo(info),
    releaseName: releaseNameFromUpdateInfo(info),
    publishedAt: publishedAtFromUpdateInfo(info),
    dismissedVersion: dismissedAppUpdateVersion(),
    lastCheckedAt: nextAppUpdateTimestamp(),
    error: "",
    ...overrides,
  };
}

function applyUnsupportedAppUpdateStatus() {
  appUpdateStatus = {
    ...appUpdateStatus,
    supported: false,
    checking: false,
    available: false,
    downloaded: false,
    downloadProgressPercent: null,
    currentVersion: currentAppVersion(),
    latestVersion: null,
    releaseName: null,
    publishedAt: null,
    dismissedVersion: dismissedAppUpdateVersion(),
    lastCheckedAt: nextAppUpdateTimestamp(),
    error: "",
  };
}

function clampDownloadProgressPercent(progress: ProgressInfo) {
  if (!Number.isFinite(progress.percent)) {
    return null;
  }
  return Math.max(0, Math.min(100, progress.percent));
}

function trackAppUpdateDownload(
  downloadPromise: Promise<Array<string>> | null | undefined,
) {
  if (!downloadPromise || appUpdateDownloadPromise) {
    return;
  }

  let trackedDownloadPromise: Promise<Array<string>>;
  trackedDownloadPromise = downloadPromise.finally(() => {
    if (appUpdateDownloadPromise === trackedDownloadPromise) {
      appUpdateDownloadPromise = null;
    }
  });
  appUpdateDownloadPromise = trackedDownloadPromise;
  void trackedDownloadPromise.catch(() => undefined);
}

function applyAutoUpdaterChannelConfiguration() {
  const channel = effectiveAppUpdateChannel();
  autoUpdater.allowPrerelease = channel === "beta";
  autoUpdater.channel = channel;
  syncAppUpdateChannelState();
}

function configureAutoUpdater() {
  if (!appUpdateSupported() || appUpdateEventsConfigured) {
    return;
  }

  appUpdateEventsConfigured = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  applyAutoUpdaterChannelConfiguration();

  autoUpdater.on("checking-for-update", () => {
    appUpdateStatus = {
      ...appUpdateStatus,
      supported: true,
      checking: true,
      available: false,
      downloaded: false,
      downloadProgressPercent: null,
      currentVersion: currentAppVersion(),
      dismissedVersion: dismissedAppUpdateVersion(),
      error: "",
    };
    emitAppUpdateState();
  });

  autoUpdater.on("update-available", (info) => {
    const latestVersion = latestVersionFromUpdateInfo(info);
    const dismissedVersion = dismissedAppUpdateVersion();
    applyAppUpdateInfo(info, {
      available: Boolean(latestVersion && dismissedVersion !== latestVersion),
      downloaded: false,
      downloadProgressPercent: 0,
    });
    emitAppUpdateState();
  });

  autoUpdater.on("download-progress", (progress) => {
    appUpdateStatus = {
      ...appUpdateStatus,
      checking: false,
      downloadProgressPercent: clampDownloadProgressPercent(progress),
      lastCheckedAt: nextAppUpdateTimestamp(),
      error: "",
    };
    emitAppUpdateState();
  });

  autoUpdater.on("update-downloaded", (info) => {
    appUpdateDownloadPromise = null;
    applyAppUpdateInfo(info, {
      available: false,
      downloaded: true,
      downloadProgressPercent: 100,
    });
    emitAppUpdateState();
  });

  autoUpdater.on("update-not-available", (info) => {
    appUpdateDownloadPromise = null;
    applyAppUpdateInfo(info, {
      available: false,
      downloaded: false,
      downloadProgressPercent: null,
    });
    emitAppUpdateState();
  });

  autoUpdater.on("error", (error) => {
    appUpdateDownloadPromise = null;
    appUpdateStatus = {
      ...appUpdateStatus,
      supported: appUpdateSupported(),
      checking: false,
      available: false,
      downloadProgressPercent: null,
      currentVersion: currentAppVersion(),
      dismissedVersion: dismissedAppUpdateVersion(),
      lastCheckedAt: nextAppUpdateTimestamp(),
      error:
        error instanceof Error ? error.message : "Failed to check for updates.",
    };
    emitAppUpdateState();
  });
}

async function checkForAppUpdates(): Promise<AppUpdateStatusPayload> {
  if (!appUpdateSupported()) {
    applyUnsupportedAppUpdateStatus();
    emitAppUpdateState();
    return appUpdateStatus;
  }

  if (appUpdateStatus.downloaded) {
    return appUpdateStatus;
  }

  if (appUpdateDownloadPromise) {
    return appUpdateStatus;
  }

  if (appUpdateCheckPromise) {
    return appUpdateCheckPromise;
  }

  configureAutoUpdater();
  appUpdateStatus = {
    ...appUpdateStatus,
    supported: true,
    checking: true,
    currentVersion: currentAppVersion(),
    dismissedVersion: dismissedAppUpdateVersion(),
    error: "",
  };
  emitAppUpdateState();

  appUpdateCheckPromise = (async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      trackAppUpdateDownload(result?.downloadPromise);
    } catch (error) {
      appUpdateStatus = {
        ...appUpdateStatus,
        supported: true,
        checking: false,
        available: false,
        downloadProgressPercent: null,
        currentVersion: currentAppVersion(),
        dismissedVersion: dismissedAppUpdateVersion(),
        lastCheckedAt: nextAppUpdateTimestamp(),
        error:
          error instanceof Error
            ? error.message
            : "Failed to check for updates.",
      };
    } finally {
      emitAppUpdateState();
      appUpdateCheckPromise = null;
    }

    return appUpdateStatus;
  })();

  return appUpdateCheckPromise;
}

function scheduleAppUpdateChecks() {
  if (!appUpdateSupported() || appUpdateCheckTimer) {
    return;
  }

  appUpdateCheckTimer = setInterval(() => {
    void checkForAppUpdates();
  }, APP_UPDATE_CHECK_INTERVAL_MS);
  appUpdateCheckTimer.unref();
}

async function dismissAppUpdate(
  version?: string | null,
): Promise<AppUpdateStatusPayload> {
  const nextDismissedVersion =
    normalizeReleaseVersion(
      version?.trim() || appUpdateStatus.latestVersion || "",
    ) || null;
  if (!nextDismissedVersion) {
    return appUpdateStatus;
  }

  appUpdatePreferences = {
    ...appUpdatePreferences,
    dismissedVersion: nextDismissedVersion,
    dismissedReleaseTag: nextDismissedVersion,
  };
  await persistAppUpdatePreferences();

  const dismissesCurrentVersion =
    appUpdateStatus.latestVersion === nextDismissedVersion;
  appUpdateStatus = {
    ...appUpdateStatus,
    available: dismissesCurrentVersion ? false : appUpdateStatus.available,
    downloaded: dismissesCurrentVersion ? false : appUpdateStatus.downloaded,
    downloadProgressPercent: dismissesCurrentVersion
      ? null
      : appUpdateStatus.downloadProgressPercent,
    dismissedVersion: nextDismissedVersion,
  };
  emitAppUpdateState();
  return appUpdateStatus;
}

async function setAppUpdateChannel(
  channel: AppUpdateChannel,
): Promise<AppUpdateStatusPayload> {
  const nextChannel = normalizeAppUpdateChannel(channel);
  if (!nextChannel) {
    throw new Error("Unsupported app update channel.");
  }

  const previousEffectiveChannel = effectiveAppUpdateChannel();
  const previousPreferredChannel = preferredAppUpdateChannel();
  appUpdatePreferences = {
    ...appUpdatePreferences,
    preferredChannel: nextChannel,
  };
  await persistAppUpdatePreferences();
  syncAppUpdateChannelState();

  const effectiveChannelChanged =
    effectiveAppUpdateChannel() !== previousEffectiveChannel;
  const preferredChannelChanged = previousPreferredChannel !== nextChannel;
  if (!appUpdateSupported() || (!effectiveChannelChanged && !preferredChannelChanged)) {
    emitAppUpdateState();
    return appUpdateStatus;
  }

  configureAutoUpdater();
  applyAutoUpdaterChannelConfiguration();
  appUpdateStatus = {
    ...appUpdateStatus,
    checking: false,
    available: false,
    downloaded: false,
    downloadProgressPercent: null,
    latestVersion: null,
    releaseName: null,
    publishedAt: null,
    lastCheckedAt: null,
    error: "",
    currentVersion: currentAppVersion(),
    dismissedVersion: dismissedAppUpdateVersion(),
  };
  emitAppUpdateState();
  return checkForAppUpdates();
}

async function installAppUpdateNow() {
  if (!appUpdateSupported()) {
    throw new Error("In-app updates are unavailable on this build.");
  }
  if (!appUpdateStatus.downloaded) {
    throw new Error("No downloaded update is ready to install.");
  }
  // electron-updater's NSIS flow spawns the installer before app.quit().
  // Finish our own runtime/browser-service teardown first so Windows doesn't
  // spend a long time waiting on locked files while replacing the app.
  await ensureAppQuitCleanup();
  // Windows silent installs give the user no visible progress while the large
  // packaged app is being replaced, which reads like the app vanished. Let
  // NSIS show its update progress there; keep macOS on the restart-in-place
  // path.
  if (process.platform === "win32") {
    autoUpdater.quitAndInstall(false, false);
    return;
  }
  autoUpdater.quitAndInstall(true, true);
}

async function openExternalUrl(rawUrl: string): Promise<void> {
  const normalizedUrl = rawUrl.trim();
  if (!normalizedUrl) {
    throw new Error("No external URL was provided.");
  }

  const parsed = new URL(normalizedUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }

  await shell.openExternal(parsed.toString());
}

function isHttpOrHttpsUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isBrowserPopupNavigationUrl(rawUrl: string): boolean {
  const normalizedUrl = rawUrl.trim();
  return normalizedUrl === "about:blank" || isHttpOrHttpsUrl(normalizedUrl);
}

function shouldAllowBrowserPopupWindow(
  normalizedUrl: string,
  frameName?: string | null,
  features?: string | null,
): boolean {
  return (
    isBrowserPopupNavigationUrl(normalizedUrl) &&
    (normalizedUrl === "about:blank" ||
      isBrowserPopupWindowRequest(frameName, features))
  );
}

function openExternalUrlFromMain(rawUrl: string, source: string): void {
  const normalizedUrl = rawUrl.trim();
  if (!normalizedUrl || normalizedUrl === "about:blank") {
    return;
  }

  try {
    new URL(normalizedUrl);
  } catch {
    return;
  }

  shell.openExternal(normalizedUrl).catch((error) => {
    console.warn(`[desktop] Failed to open external URL from ${source}:`, error);
  });
}

function emitOpenSettingsPane(section: UiSettingsPaneSection = "settings") {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("ui:openSettingsPane", section);
}

configureStableUserDataPath();
resolvedRuntimeApiPort = resolveRuntimeApiPort();
persistDevLaunchContext();
appUpdatePreferences = loadAppUpdatePreferences();
notificationPreferences = loadNotificationPreferences();
runtimeModelCatalogState = loadRuntimeModelCatalogCache();
appUpdateStatus = {
  ...appUpdateStatus,
  supported: appUpdateSupported(),
  dismissedVersion: dismissedAppUpdateVersion(),
  channel: effectiveAppUpdateChannel(),
  preferredChannel: preferredAppUpdateChannel(),
};

const desktopAuthClient =
  AUTH_BASE_URL && AUTH_SIGN_IN_URL
    ? createAuthClient({
        baseURL: AUTH_BASE_URL,
        plugins: [
          electronClient({
            signInURL: AUTH_SIGN_IN_URL,
            protocol: {
              scheme: AUTH_CALLBACK_PROTOCOL,
            },
            storage: electronAuthStorage(),
          }),
        ],
      })
    : null;

interface RuntimeBindingExchangePayload {
  sandbox_id: string;
  holaboss_user_id: string;
  target_kind: string;
  model_proxy_api_key?: string;
  auth_token?: string;
  model_proxy_base_url: string;
  default_model: string;
  default_background_model?: string;
  default_embedding_model?: string;
  default_image_model?: string;
  instance_id: string;
  provider: string;
  catalog_version?: string;
  provider_model_groups?: RuntimeProviderModelGroupPayload[];
}

interface RuntimeModelCatalogResponsePayload {
  catalog_version?: string;
  default_background_model?: string;
  default_embedding_model?: string;
  default_image_model?: string;
  provider_model_groups?: RuntimeProviderModelGroupPayload[];
}

interface RuntimeModelCatalogPayload {
  catalogVersion: string | null;
  defaultBackgroundModel: string | null;
  defaultEmbeddingModel: string | null;
  defaultImageModel: string | null;
  providerModelGroups: RuntimeProviderModelGroupPayload[];
  fetchedAt: string | null;
}

interface PopupThemePalette {
  fontFamily: string;
  text: string;
  textMuted: string;
  textSubtle: string;
  accent: string;
  accentStrong: string;
  border: string;
  borderSoft: string;
  hover: string;
  panelBg: string;
  panelBgAlt: string;
  controlBg: string;
  shadow: string;
  emptyBg: string;
  error: string;
}

function isLightAppTheme(theme: string): boolean {
  return theme.endsWith("-light") || theme === "holaboss" || theme === "sepia" || theme === "paper";
}

function getPopupThemePalette(theme: string): PopupThemePalette {
  if (isLightAppTheme(theme)) {
    return {
      fontFamily: '"IBM Plex Sans", "Aptos", "Segoe UI Variable", sans-serif',
      text: "rgba(33, 38, 49, 0.94)",
      textMuted: "rgba(96, 102, 114, 0.82)",
      textSubtle: "rgba(120, 128, 142, 0.66)",
      accent: "rgb(245, 132, 25)",
      accentStrong: "rgb(214, 95, 18)",
      border: "rgba(214, 220, 230, 0.7)",
      borderSoft: "rgba(214, 220, 230, 0.38)",
      hover: "rgba(245, 132, 25, 0.08)",
      panelBg: "rgba(255, 255, 255, 0.98)",
      panelBgAlt: "rgba(249, 250, 252, 0.98)",
      controlBg: "rgba(248, 250, 253, 0.94)",
      shadow: "0 10px 28px rgba(20, 28, 48, 0.10)",
      emptyBg: "rgba(250, 250, 251, 0.92)",
      error: "rgba(184, 67, 67, 0.94)",
    };
  }
  return {
    fontFamily: '"IBM Plex Sans", "Aptos", "Segoe UI Variable", sans-serif',
    text: "rgba(232, 234, 238, 0.94)",
    textMuted: "rgba(168, 174, 184, 0.84)",
    textSubtle: "rgba(146, 152, 162, 0.66)",
    accent: "rgb(245, 132, 25)",
    accentStrong: "rgb(255, 158, 76)",
    border: "rgba(255, 255, 255, 0.08)",
    borderSoft: "rgba(255, 255, 255, 0.05)",
    hover: "rgba(245, 132, 25, 0.10)",
    panelBg: "rgba(24, 26, 30, 0.98)",
    panelBgAlt: "rgba(20, 22, 26, 0.98)",
    controlBg: "rgba(28, 30, 34, 0.94)",
    shadow: "0 10px 28px rgba(0, 0, 0, 0.28)",
    emptyBg: "rgba(28, 30, 34, 0.92)",
    error: "rgba(255, 145, 145, 0.92)",
  };
}

function popupThemeCss(theme = currentTheme) {
  const palette = getPopupThemePalette(theme);
  const isLightTheme = isLightAppTheme(theme);
  const surfaceSoft = `color-mix(in srgb, ${palette.controlBg} 72%, ${palette.panelBgAlt} 28%)`;
  const surfaceSubtle = `color-mix(in srgb, ${palette.controlBg} 52%, ${palette.panelBgAlt} 48%)`;
  return `
      :root {
        color-scheme: ${isLightTheme ? "light" : "dark"};
        --popup-text: ${palette.text};
        --popup-text-muted: ${palette.textMuted};
        --popup-text-subtle: ${palette.textSubtle};
        --popup-accent: ${palette.accent};
        --popup-accent-strong: ${palette.accentStrong};
        --popup-border: ${palette.border};
        --popup-border-soft: ${palette.borderSoft};
        --popup-hover: ${palette.hover};
        --popup-panel-bg: ${palette.panelBg};
        --popup-panel-bg-alt: ${palette.panelBgAlt};
        --popup-control-bg: ${palette.controlBg};
        --popup-shadow: ${palette.shadow};
        --popup-error: ${palette.error};
      }
      body {
        font-family: ${palette.fontFamily};
        color: ${palette.text};
        background: transparent;
      }
      .panel {
        border: 1px solid ${palette.border};
        background: linear-gradient(180deg, ${palette.panelBg}, ${palette.panelBgAlt});
        box-shadow: ${palette.shadow};
      }
      .header {
        border-bottom-color: ${palette.borderSoft};
      }
      .content {
        background: color-mix(in srgb, ${palette.panelBg} 90%, transparent);
      }
      .avatar {
        border-color: color-mix(in srgb, ${palette.accent} 30%, ${palette.borderSoft});
        background: color-mix(in srgb, ${palette.accent} 14%, transparent);
        color: ${palette.accentStrong};
      }
      .identityName, .rowLabel, .heroTitle, .statusDetail {
        color: ${palette.text};
      }
      .title, .identity, .filename, .title-row {
        color: ${palette.text};
      }
      .summary, .url-row, .status, .section-title, .field label, .clock,
      .identity, .rowValue, .heroDescription, .statusLabel, .footnote, .authSectionTitle, .advancedHint {
        color: ${palette.textSubtle};
      }
      .button, .action, .item, .remove {
        color: ${palette.textMuted};
      }
      .button, .action, .badge, .input, .item, .empty {
        border-color: ${palette.borderSoft};
      }
      .button, .action, .badge, .input {
        background: ${palette.controlBg};
      }
      .hero, .row, .section, .statusStep, .advancedToggle, .stateMessage, .message {
        border-color: ${palette.borderSoft};
        background: ${surfaceSoft};
      }
      .empty, .item, .statusStep.current {
        background: ${surfaceSubtle};
      }
      .badge {
        color: ${palette.textMuted};
      }
      .badge.idle {
        background: ${surfaceSubtle};
        color: ${palette.textMuted};
      }
      .badge.ready {
        border-color: color-mix(in srgb, ${palette.accent} 42%, ${palette.borderSoft});
        background: color-mix(in srgb, ${palette.accent} 16%, transparent);
        color: ${palette.accentStrong};
      }
      .badge.syncing {
        border-color: color-mix(in srgb, ${palette.accentStrong} 30%, ${palette.borderSoft});
        background: color-mix(in srgb, ${palette.accentStrong} 12%, transparent);
        color: ${palette.accentStrong};
      }
      .badge.error {
        border-color: color-mix(in srgb, ${palette.error} 35%, ${palette.borderSoft});
        background: color-mix(in srgb, ${palette.error} 10%, transparent);
        color: ${palette.error};
      }
      .button.primary {
        border-color: ${palette.border};
        background: color-mix(in srgb, ${palette.accent} 14%, transparent);
        color: ${palette.accentStrong};
      }
      .button:hover, .action:hover, .item:hover, .item.active, .remove:hover {
        background: ${palette.hover};
        color: ${palette.accentStrong};
      }
      .input:focus {
        border-color: ${palette.accent};
      }
      .input {
        color: ${palette.text};
      }
      .input::placeholder {
        color: ${palette.textSubtle};
      }
      .statusStep.done {
        border-color: color-mix(in srgb, ${palette.accent} 42%, ${palette.borderSoft});
        background: color-mix(in srgb, ${palette.accent} 14%, transparent);
      }
      .statusStep.error {
        border-color: color-mix(in srgb, ${palette.error} 36%, ${palette.borderSoft});
        background: color-mix(in srgb, ${palette.error} 10%, transparent);
      }
      .statusDot {
        background: color-mix(in srgb, ${palette.textMuted} 62%, transparent);
      }
      .statusStep.done .statusDot {
        background: ${palette.accentStrong};
      }
      .statusStep.current .statusDot {
        background: ${palette.accent};
      }
      .statusStep.error .statusDot {
        background: ${palette.error};
      }
      .message.success {
        border-color: color-mix(in srgb, ${palette.accent} 40%, ${palette.borderSoft});
        color: ${palette.accentStrong};
      }
      .message.error {
        color: ${palette.error};
      }
      .bar {
        background: color-mix(in srgb, ${palette.textMuted} 10%, transparent);
      }
      .bar > span {
        background: linear-gradient(90deg, ${palette.accent}, ${palette.accentStrong});
      }`;
}

interface TemplateAgentInfoPayload {
  role: string;
  description: string;
}

interface TemplateViewInfoPayload {
  name: string;
  description: string;
}

interface TemplateAppEntryPayload {
  name: string;
  required: boolean;
}

interface TemplateMetadataPayload {
  name: string;
  repo: string;
  path: string;
  default_ref: string;
  description: string | null;
  is_hidden: boolean;
  is_coming_soon: boolean;
  allowed_user_ids: string[];
  icon: string;
  emoji: string | null;
  apps: TemplateAppEntryPayload[];
  min_optional_apps: number;
  tags: string[];
  category: string;
  long_description: string | null;
  agents: TemplateAgentInfoPayload[];
  views: TemplateViewInfoPayload[];
  install_count?: number;
  source?: string;
  verified?: boolean;
  author_name?: string;
  author_id?: string;
}

interface ResolvedTemplatePayload {
  name: string;
  repo: string;
  path: string;
  effective_ref: string;
  effective_commit: string | null;
  source: string;
}

interface MaterializedTemplateFilePayload {
  path: string;
  content_base64: string;
  executable: boolean;
  symlink_target?: string | null;
}

interface MaterializeTemplateResponsePayload {
  template: ResolvedTemplatePayload;
  files: MaterializedTemplateFilePayload[];
  file_count: number;
  total_bytes: number;
}

interface SpotlightItemPayload {
  label: string;
  title: string;
  description: string;
  template_name: string;
}

interface TemplateListResponsePayload {
  templates: TemplateMetadataPayload[];
  spotlight: SpotlightItemPayload[];
}

type WorkspaceLocationPayload = "local" | "cloud";

interface WorkspaceRecordPayload {
  id: string;
  location: WorkspaceLocationPayload;
  name: string;
  status: string;
  harness: string | null;
  error_message: string | null;
  onboarding_status: string;
  onboarding_state?: string | null;
  onboarding_session_id: string | null;
  alignment_question?: Record<string, unknown> | null;
  alignment_report?: Record<string, unknown> | null;
  verification_report?: Record<string, unknown> | null;
  onboarding_completed_at: string | null;
  onboarding_completion_summary: string | null;
  onboarding_requested_at: string | null;
  onboarding_requested_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  deleted_at_utc: string | null;
  workspace_path?: string | null;
  folder_state?: "healthy" | "missing" | null;
  workspace_role?: string | null;
  source_workspace_id?: string | null;
  lab_purpose?: string | null;
  lab_status?: string | null;
}

interface WorkspaceResponsePayload {
  workspace: WorkspaceRecordPayload;
}

interface WorkspaceLabResponsePayload {
  lab: WorkspaceRecordPayload | null;
  source: WorkspaceRecordPayload | null;
  session: AgentSessionRecordPayload | null;
  created?: boolean;
}

interface WorkspaceListResponsePayload {
  items: WorkspaceRecordPayload[];
  total: number;
  limit: number;
  offset: number;
}

interface WorkspaceOnboardingStatusPayload {
  workspace_id: string;
  onboarding_status: string;
  onboarding_state: string | null;
  alignment_question: Record<string, unknown> | null;
  alignment_report: Record<string, unknown> | null;
  verification_report: Record<string, unknown> | null;
  onboarding_completed_at: string | null;
  onboarding_completion_summary: string | null;
  onboarding_requested_at: string | null;
  onboarding_requested_by: string | null;
  lab_workspace_id?: string | null;
  lab_purpose?: string | null;
  lab_status?: string | null;
}

interface DiagnosticsExportRequestPayload {
  workspaceId?: string | null;
}

interface HtmlToPdfExportRequestPayload {
  html: string;
  suggestedName?: string;
  basePath?: string | null;
}

interface SubmissionListResponsePayload {
  submissions: Array<{
    id: string;
    author_id: string;
    author_name: string;
    template_name: string;
    template_id: string;
    version: string;
    status: "pending_review" | "published" | "rejected";
    manifest: Record<string, unknown>;
    archive_size_bytes: number;
    review_notes: string | null;
    reviewed_by: string | null;
    reviewed_at: string | null;
    created_at: string;
    updated_at: string;
  }>;
  count: number;
}

interface TaskProposalRecordPayload {
  proposal_id: string;
  workspace_id: string;
  task_name: string;
  task_prompt: string;
  task_generation_rationale: string;
  proposal_source: "proactive" | "evolve";
  created_at: string;
  state: string;
  source_event_ids: string[];
  accepted_session_id: string | null;
  accepted_input_id: string | null;
  accepted_at: string | null;
}

interface TaskProposalListResponsePayload {
  proposals: TaskProposalRecordPayload[];
  count: number;
}

interface BackgroundTaskLiveStatePayload {
  runtime_status: string | null;
  current_input_id: string | null;
  current_input_status: string | null;
  latest_input_id: string | null;
  latest_input_status: string | null;
  latest_turn_status: string | null;
  latest_turn_stop_reason: string | null;
}

interface BackgroundTaskRecordPayload {
  subagent_id: string;
  workspace_id: string;
  parent_session_id: string | null;
  parent_input_id: string | null;
  origin_main_session_id: string;
  owner_main_session_id: string;
  child_session_id: string;
  initial_child_input_id: string | null;
  current_child_input_id: string | null;
  latest_child_input_id: string | null;
  title: string;
  goal: string;
  context: string | null;
  source_type: string | null;
  source_id: string | null;
  proposal_id: string | null;
  cronjob_id: string | null;
  retry_of_subagent_id: string | null;
  tool_profile: Record<string, unknown>;
  requested_model: string | null;
  effective_model: string | null;
  status: string;
  summary: string | null;
  latest_progress_payload: Record<string, unknown> | null;
  blocking_payload: Record<string, unknown> | null;
  result_payload: Record<string, unknown> | null;
  error_payload: Record<string, unknown> | null;
  last_event_at: string | null;
  owner_transferred_at: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  updated_at: string;
  live_state: BackgroundTaskLiveStatePayload;
}

interface BackgroundTaskListRequestPayload {
  workspaceId: string;
  ownerMainSessionId?: string | null;
  statuses?: string[];
  limit?: number;
}

interface BackgroundTaskListResponsePayload {
  tasks: BackgroundTaskRecordPayload[];
  count: number;
}

interface MainSessionLegacyExportPayload {
  session_id: string;
  title: string | null;
  kind: string;
  archived_at: string;
  exported_at: string;
  message_count: number;
  output_count: number;
  json_path: string;
  markdown_path: string;
}

interface EnsureWorkspaceMainSessionResponsePayload {
  session: AgentSessionRecordPayload;
  migrated_legacy_sessions: MainSessionLegacyExportPayload[];
  migrated_legacy_session_count: number;
}

interface TaskProposalStateUpdatePayload {
  proposal: TaskProposalRecordPayload;
}

interface CronjobDeliveryPayload {
  mode: string;
  channel: string;
  to: string | null;
}

interface CronjobRecordPayload {
  id: string;
  workspace_id: string;
  initiated_by: string;
  name: string;
  cron: string;
  description: string;
  instruction: string;
  enabled: boolean;
  delivery: CronjobDeliveryPayload;
  metadata: Record<string, unknown>;
  last_run_at: string | null;
  next_run_at: string | null;
  run_count: number;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface CronjobListResponsePayload {
  jobs: CronjobRecordPayload[];
  count: number;
}

interface CronjobCreatePayload {
  workspace_id: string;
  initiated_by: string;
  session_id?: string;
  name?: string;
  cron: string;
  description: string;
  instruction?: string;
  enabled?: boolean;
  delivery: CronjobDeliveryPayload;
  model?: string;
  metadata?: Record<string, unknown>;
}

interface CronjobUpdatePayload {
  session_id?: string;
  name?: string;
  cron?: string;
  description?: string;
  instruction?: string;
  enabled?: boolean;
  delivery?: CronjobDeliveryPayload;
  model?: string;
  metadata?: Record<string, unknown>;
}

interface CronjobRunNowPayload {
  model?: string;
}

interface IntegrationCatalogProviderPayload {
  provider_id: string;
  display_name: string;
  description: string;
  auth_modes: string[];
  supports_oss: boolean;
  supports_managed: boolean;
  default_scopes: string[];
  docs_url: string | null;
}

interface IntegrationCatalogResponsePayload {
  providers: IntegrationCatalogProviderPayload[];
}

interface IntegrationConnectionPayload {
  connection_id: string;
  provider_id: string;
  owner_user_id: string;
  account_label: string;
  account_external_id: string | null;
  account_handle: string | null;
  account_email: string | null;
  context_cron_auto_fetch_enabled: boolean;
  last_context_fetch_attempted_at: string | null;
  last_context_fetch_completed_at: string | null;
  last_context_fetch_status: string | null;
  auth_mode: string;
  granted_scopes: string[];
  status: string;
  secret_ref: string | null;
  created_at: string;
  updated_at: string;
}

interface IntegrationMergeConnectionsResult {
  kept_connection_id: string;
  removed_count: number;
  repointed_bindings: number;
}

interface IntegrationConnectionListResponsePayload {
  connections: IntegrationConnectionPayload[];
}

interface IntegrationBindingPayload {
  binding_id: string;
  workspace_id: string;
  target_type: string;
  target_id: string;
  integration_key: string;
  connection_id: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

interface IntegrationBindingListResponsePayload {
  bindings: IntegrationBindingPayload[];
}

interface IntegrationUpsertBindingPayload {
  connection_id: string;
  is_default?: boolean;
}

interface IntegrationCreateConnectionPayload {
  provider_id: string;
  owner_user_id: string;
  account_label: string;
  auth_mode: string;
  granted_scopes: string[];
  secret_ref?: string;
}

interface IntegrationUpdateConnectionPayload {
  status?: string;
  secret_ref?: string;
  account_label?: string;
  /** Backfill provider-side identity. `null` clears, omit to leave alone. */
  account_handle?: string | null;
  account_email?: string | null;
  context_cron_auto_fetch_enabled?: boolean;
  last_context_fetch_attempted_at?: string | null;
  last_context_fetch_completed_at?: string | null;
  last_context_fetch_status?: string | null;
}

function normalizeIntegrationConnectionPayload(
  connection: Omit<
    IntegrationConnectionPayload,
    | "account_handle"
    | "account_email"
    | "context_cron_auto_fetch_enabled"
    | "last_context_fetch_attempted_at"
    | "last_context_fetch_completed_at"
    | "last_context_fetch_status"
  > & {
    account_handle?: string | null;
    account_email?: string | null;
    context_cron_auto_fetch_enabled?: boolean;
    last_context_fetch_attempted_at?: string | null;
    last_context_fetch_completed_at?: string | null;
    last_context_fetch_status?: string | null;
  },
): IntegrationConnectionPayload {
  return {
    ...connection,
    account_handle: connection.account_handle ?? null,
    account_email: connection.account_email ?? null,
    context_cron_auto_fetch_enabled:
      connection.context_cron_auto_fetch_enabled ?? true,
    last_context_fetch_attempted_at:
      connection.last_context_fetch_attempted_at ?? null,
    last_context_fetch_completed_at:
      connection.last_context_fetch_completed_at ?? null,
    last_context_fetch_status: connection.last_context_fetch_status ?? null,
  };
}

interface OAuthAppConfigPayload {
  provider_id: string;
  client_id: string;
  client_secret: string;
  authorize_url: string;
  token_url: string;
  scopes: string[];
  redirect_port: number;
  created_at: string;
  updated_at: string;
}

interface OAuthAppConfigListResponsePayload {
  configs: OAuthAppConfigPayload[];
}

interface OAuthAppConfigUpsertPayload {
  client_id: string;
  client_secret: string;
  authorize_url: string;
  token_url: string;
  scopes: string[];
  redirect_port?: number;
}

interface OAuthAuthorizeResponsePayload {
  authorize_url: string;
  state: string;
}

interface ComposioConnectResult {
  redirect_url: string;
  connected_account_id: string;
  auth_config_id: string;
  expires_at: string | null;
}

interface ComposioAccountStatus {
  id: string;
  status: string;
  authConfigId: string | null;
  toolkitSlug: string | null;
  userId: string | null;
  handle?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  email?: string | null;
  data?: Record<string, unknown> | null;
}

interface SessionRuntimeRecordPayload {
  workspace_id: string;
  session_id: string;
  status: string;
  effective_state?: string | null;
  runtime_status?: string | null;
  has_queued_inputs?: boolean;
  current_input_id: string | null;
  current_worker_id: string | null;
  lease_until: string | null;
  heartbeat_at: string | null;
  last_error: Record<string, unknown> | null;
  last_turn_status: string | null;
  last_turn_completed_at: string | null;
  last_turn_stop_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionRuntimeStateListResponsePayload {
  items: SessionRuntimeRecordPayload[];
  count: number;
}

interface SessionHistoryMessagePayload {
  id: string;
  role: string;
  text: string;
  created_at: string | null;
  metadata: Record<string, unknown>;
}

interface SessionInputAttachmentPayload {
  id: string;
  kind: "image" | "file" | "folder";
  name: string;
  mime_type: string;
  size_bytes: number;
  workspace_path: string;
}

interface StageSessionAttachmentFilePayload {
  name: string;
  mime_type?: string | null;
  content_base64: string;
}

interface StageSessionAttachmentsPayload {
  workspace_id: string;
  files: StageSessionAttachmentFilePayload[];
}

interface StageSessionAttachmentPathPayload {
  absolute_path: string;
  name?: string | null;
  mime_type?: string | null;
  kind?: "image" | "file" | "folder" | null;
}

interface StageSessionAttachmentPathsPayload {
  workspace_id: string;
  files: StageSessionAttachmentPathPayload[];
}

interface StageSessionAttachmentsResponsePayload {
  attachments: SessionInputAttachmentPayload[];
}

interface SessionHistoryResponsePayload {
  workspace_id: string;
  session_id: string;
  harness: string;
  harness_session_id: string;
  source: string;
  messages: SessionHistoryMessagePayload[];
  count: number;
  total: number;
  limit: number;
  offset: number;
  raw: unknown | null;
}

interface SessionHistoryRequestPayload {
  sessionId: string;
  workspaceId: string;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}

interface SessionOutputEventPayload {
  id: number;
  workspace_id: string;
  session_id: string;
  input_id: string;
  sequence: number;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

interface SessionOutputEventListRequestPayload {
  workspaceId: string;
  sessionId: string;
  inputId?: string | null;
}

interface SessionOutputEventListResponsePayload {
  items: SessionOutputEventPayload[];
  count: number;
  last_event_id: number;
}

interface EnqueueSessionInputResponsePayload {
  input_id: string;
  session_id: string;
  status: string;
  effective_state?: string | null;
  runtime_status?: string | null;
  current_input_id?: string | null;
  has_queued_inputs?: boolean;
}

interface PauseSessionRunResponsePayload {
  input_id: string;
  session_id: string;
  status: string;
}

interface UpdateQueuedSessionInputResponsePayload {
  input_id: string;
  session_id: string;
  status: string;
  text: string;
  updated_at: string;
}

interface CancelQueuedSessionInputResponsePayload {
  input_id: string;
  session_id: string;
  status: string;
  updated_at: string;
}

interface HolabossClientConfigPayload {
  projectsUrl: string;
  marketplaceUrl: string;
}

interface InstalledWorkspaceAppPayload {
  app_id: string;
  config_path: string;
  lifecycle: Record<string, string> | null;
  build_status?: string;
  ready: boolean;
  error: string | null;
}

interface InstalledWorkspaceAppListResponsePayload {
  apps: InstalledWorkspaceAppPayload[];
  count: number;
}

interface WorkspaceLifecycleBlockingAppPayload {
  app_id: string;
  status: string;
  error: string | null;
}

interface WorkspaceLifecyclePayload {
  workspace: WorkspaceRecordPayload;
  applications: InstalledWorkspaceAppPayload[];
  ready: boolean;
  reason: string | null;
  phase: string;
  phase_label: string;
  phase_detail: string | null;
  blocking_apps: WorkspaceLifecycleBlockingAppPayload[];
}

interface WorkspaceRuntimeSessionPayload {
  workspace_id: string;
  location: WorkspaceLocationPayload;
  runtime_base_url: string;
  runtime_auth_token: string | null;
  workspace_root: string;
}

interface WorkspaceOpenSessionPayload extends WorkspaceRuntimeSessionPayload {
  lifecycle: WorkspaceLifecyclePayload;
}

interface WorkspaceOutputRecordPayload {
  id: string;
  workspace_id: string;
  output_type: string;
  title: string;
  status: string;
  module_id: string | null;
  module_resource_id: string | null;
  file_path: string | null;
  html_content: string | null;
  session_id: string | null;
  artifact_id: string | null;
  folder_id: string | null;
  platform: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface WorkspaceOutputListResponsePayload {
  items: WorkspaceOutputRecordPayload[];
}

interface WorkspaceSkillRecordPayload {
  skill_id: string;
  source_dir: string;
  skill_file_path: string;
  title: string;
  summary: string;
  modified_at: string;
}

interface WorkspaceSkillListResponsePayload {
  workspace_id: string;
  workspace_root: string;
  skills_path: string;
  skills: WorkspaceSkillRecordPayload[];
}

interface HolabossCreateWorkspacePayload {
  holaboss_user_id: string;
  location?: WorkspaceLocationPayload | null;
  harness?: string | null;
  name: string;
  template_mode?: "template" | "empty" | "empty_onboarding" | null;
  template_root_path?: string | null;
  template_name?: string | null;
  template_ref?: string | null;
  template_commit?: string | null;
  /** App names from template metadata, used for integration resolution without materialization. */
  template_apps?: string[];
  workspace_onboarding_mode?: "start" | "skip" | null;
  workspace_onboarding_engine?: "deterministic" | "agentic" | null;
  /** Optional absolute path for the workspace's on-disk folder. When provided, the runtime registers this
   * as the workspace root instead of the default managed location. */
  workspace_path?: string | null;
}

interface TemplateFolderSelectionPayload {
  canceled: boolean;
  rootPath: string | null;
  templateName: string | null;
  description: string | null;
}

interface WorkspaceRuntimeFolderSelectionPayload {
  canceled: boolean;
  rootPath: string | null;
}

interface HolabossQueueSessionInputPayload {
  text: string;
  workspace_id: string;
  image_urls: string[] | null;
  attachments?: SessionInputAttachmentPayload[] | null;
  session_id?: string | null;
  idempotency_key?: string | null;
  priority?: number;
  model?: string | null;
  thinking_value?: string | null;
}

interface HolabossPauseSessionRunPayload {
  workspace_id: string;
  session_id: string;
}

interface HolabossUpdateQueuedSessionInputPayload {
  workspace_id: string;
  session_id: string;
  input_id: string;
  text: string;
}

interface HolabossCancelQueuedSessionInputPayload {
  workspace_id: string;
  session_id: string;
  input_id: string;
}

interface HolabossStreamSessionOutputsPayload {
  sessionId: string;
  workspaceId?: string | null;
  inputId?: string | null;
  includeHistory?: boolean;
  stopOnTerminal?: boolean;
}

interface HolabossListOutputsPayload {
  workspaceId: string;
  outputType?: string | null;
  status?: string | null;
  platform?: string | null;
  folderId?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
  limit?: number;
  offset?: number;
}

interface HolabossSessionStreamHandlePayload {
  streamId: string;
}

interface HolabossSessionStreamEventPayload {
  streamId: string;
  type: "event" | "error" | "done";
  event?: {
    event: string;
    id: string | null;
    data: unknown;
  };
  error?: string;
}

interface HolabossSessionStreamDebugEntry {
  at: string;
  streamId: string;
  phase: string;
  detail: string;
}

const DEFAULT_PROJECTS_URL =
  internalOverride("HOLABOSS_PROJECTS_URL") ||
  internalOverride("HOLABOSS_CLI_PROJECTS_URL") ||
  normalizeBaseUrl(packagedDesktopConfig.projectsUrl || "") ||
  serviceBaseUrlFromControlPlane(DESKTOP_CONTROL_PLANE_BASE_URL, 3033);
const DEFAULT_MARKETPLACE_URL =
  internalOverride("HOLABOSS_MARKETPLACE_URL") ||
  internalOverride("HOLABOSS_CLI_MARKETPLACE_URL") ||
  normalizeBaseUrl(packagedDesktopConfig.marketplaceUrl || "") ||
  serviceBaseUrlFromControlPlane(DESKTOP_CONTROL_PLANE_BASE_URL, 3037);
const DEFAULT_PROACTIVE_URL =
  internalOverride("HOLABOSS_PROACTIVE_URL") ||
  internalOverride("HOLABOSS_CLI_PROACTIVE_URL") ||
  normalizeBaseUrl(packagedDesktopConfig.proactiveUrl || "") ||
  serviceBaseUrlFromControlPlane(DESKTOP_CONTROL_PLANE_BASE_URL, 3032);

const sessionOutputStreams = new Map<string, AbortController>();
const sessionStreamDebugLog: HolabossSessionStreamDebugEntry[] = [];
let lastRuntimeStateSignature = "";
let lastRuntimeConfigSignature = "";
let lastRuntimeBindingRefreshAtMs = 0;
let lastRuntimeBindingRefreshUserId = "";
let lastRuntimeBindingRefreshFailureAtMs = 0;
let lastRuntimeBindingRefreshFailureUserId = "";
let runtimeBindingRefreshPromise: Promise<void> | null = null;
let runtimeConfigMutationPromise: Promise<void> | null = null;
let runtimeLifecycleChain: Promise<void> = Promise.resolve();
let runtimeStartupInFlight = false;
let startupAuthSyncPromise: Promise<void> | null = null;

function appendSessionStreamDebug(
  streamId: string,
  phase: string,
  detail: string,
) {
  if (!verboseTelemetryEnabled) {
    return;
  }
  sessionStreamDebugLog.push({
    at: new Date().toISOString(),
    streamId,
    phase,
    detail,
  });
  if (sessionStreamDebugLog.length > 1200) {
    sessionStreamDebugLog.splice(0, sessionStreamDebugLog.length - 1200);
  }
}

function sanitizeBrowserWorkspaceSegment(workspaceId: string) {
  return sanitizeBrowserWorkspaceSegmentUtil(workspaceId);
}

function browserWorkspaceStorageDir(workspaceId: string) {
  return browserWorkspaceStorageDirUtil(app.getPath("userData"), workspaceId);
}

function browserWorkspaceStatePath(workspaceId: string) {
  return browserWorkspaceStatePathUtil(app.getPath("userData"), workspaceId);
}

function browserWorkspacePartition(workspaceId: string) {
  return browserWorkspacePartitionUtil(workspaceId);
}

// ---------------------------------------------------------------------------
// browser-pane/import-browsers binding
//
// The chromium-family + Safari profile import flow lives in
// `electron/browser-pane/import-{chromium,browsers}.ts`. main.ts still owns
// the BrowserWorkspaceState graph and the renderer-notification surface, so
// we hand those to the import module via the deps object below.
// ---------------------------------------------------------------------------

function asBrowserImportTarget(
  workspace: BrowserWorkspaceState,
): BrowserWorkspaceImportTarget {
  return workspace as unknown as BrowserWorkspaceImportTarget;
}

function buildBrowserImportDepsBase(): Omit<BrowserImportDeps, "tabGraph"> {
  return {
    ensureBrowserWorkspace: async (workspaceId, space) => {
      const resolved = await ensureBrowserWorkspace(
        typeof workspaceId === "string" ? workspaceId : null,
        space ?? null,
      );
      return resolved ? asBrowserImportTarget(resolved) : null;
    },
    persistBrowserWorkspace: (workspaceId) =>
      persistBrowserWorkspace(workspaceId),
    emitBookmarksState: (workspaceId) => emitBookmarksState(workspaceId),
    emitHistoryState: (workspaceId) => emitHistoryState(workspaceId),
    emitDownloadsState: (workspaceId) => emitDownloadsState(workspaceId),
    emitBrowserState: (workspaceId, space) =>
      emitBrowserState(workspaceId, space),
    getActiveBrowserWorkspaceId: () => activeBrowserWorkspaceId,
    getActiveBrowserSpaceId: () => activeBrowserSpaceId,
    updateAttachedBrowserView: () => updateAttachedBrowserView(),
    getMainWindow: () => mainWindow,
  };
}

/**
 * Build the `tabGraph` deps for `copyBrowserWorkspaceProfile`. Per-call
 * because it captures the source/target workspace pair.
 */
function buildBrowserImportTabGraph(
  sourceWorkspaceId: string,
  targetWorkspaceId: string,
): BrowserImportDeps["tabGraph"] {
  return {
    forEachBrowserSpace: (callback) => {
      for (const browserSpace of BROWSER_SPACE_IDS) {
        const sourceWorkspace = browserWorkspaces.get(sourceWorkspaceId);
        const targetWorkspace = browserWorkspaces.get(targetWorkspaceId);
        if (!sourceWorkspace || !targetWorkspace) {
          return;
        }
        const sourceSpace = sourceWorkspace.spaces[browserSpace];
        const targetSpace = targetWorkspace.spaces[browserSpace];

        const action: BrowserCopySpaceAction = {
          resetTargetSpace: () => {
            clearBrowserTabSpaceSuspendTimer(targetSpace);
            for (const tab of targetSpace.tabs.values()) {
              closeBrowserTabRecord(tab);
            }
            targetSpace.tabs.clear();
            targetSpace.persistedTabs = [];
            targetSpace.lifecycleState = "active";
          },
          copyTabsAndResolveActive: () => {
            const tabIdMap = new Map<string, string>();
            for (const sourceTab of sourceSpace.tabs.values()) {
              const copiedTabId = createBrowserTab(targetWorkspaceId, {
                browserSpace,
                url: sourceTab.state.url || HOME_URL,
                title: sourceTab.state.title || NEW_TAB_TITLE,
                faviconUrl: sourceTab.state.faviconUrl,
                skipInitialHistoryRecord: true,
              });
              if (copiedTabId) {
                tabIdMap.set(sourceTab.state.id, copiedTabId);
              }
            }
            if (targetSpace.tabs.size === 0) {
              ensureBrowserTabSpaceInitialized(
                targetWorkspaceId,
                browserSpace,
              );
            }
            const mappedActiveTabId = tabIdMap.get(
              sourceSpace.activeTabId || "",
            );
            return (
              (mappedActiveTabId && targetSpace.tabs.has(mappedActiveTabId)
                ? mappedActiveTabId
                : Array.from(targetSpace.tabs.keys())[0]) || ""
            );
          },
          setActiveTab: (activeTabId) => {
            targetSpace.activeTabId = activeTabId;
          },
        };
        callback(browserSpace, action);
      }
    },
    resetAgentSessionSpaces: (workspaceId) => {
      const targetWorkspace = browserWorkspaces.get(workspaceId);
      if (!targetWorkspace) {
        return;
      }
      for (const tabSpace of targetWorkspace.agentSessionSpaces.values()) {
        clearBrowserTabSpaceSuspendTimer(tabSpace);
        for (const tab of tabSpace.tabs.values()) {
          closeBrowserTabRecord(tab);
        }
        tabSpace.tabs.clear();
      }
      targetWorkspace.agentSessionSpaces.clear();
    },
    clearUserBrowserLock: (workspaceId) => {
      const targetWorkspace = browserWorkspaces.get(workspaceId);
      if (targetWorkspace) {
        targetWorkspace.userBrowserLock = null;
      }
    },
    clearActiveAgentSession: (workspaceId) => {
      const targetWorkspace = browserWorkspaces.get(workspaceId);
      if (targetWorkspace) {
        targetWorkspace.activeAgentSessionId = null;
      }
    },
  };
}

function buildBrowserImportDeps(
  tabGraph?: BrowserImportDeps["tabGraph"],
): BrowserImportDeps {
  return {
    ...buildBrowserImportDepsBase(),
    tabGraph: tabGraph ?? {
      // Unused for non-copy import flows. Throw if a caller tries to use it.
      forEachBrowserSpace: () => {
        throw new Error("tabGraph not bound for this import flow");
      },
      resetAgentSessionSpaces: () => undefined,
      clearUserBrowserLock: () => undefined,
      clearActiveAgentSession: () => undefined,
    },
  };
}

const listImportBrowserProfiles = importBrowsersListImportBrowserProfiles;

const importBrowserProfileIntoWorkspace = (
  payload: BrowserImportProfilePayload,
) =>
  importBrowsersImportBrowserProfileIntoWorkspace(
    payload,
    buildBrowserImportDeps(),
  );

const copyBrowserWorkspaceProfile = (
  payload: BrowserCopyWorkspaceProfilePayload,
) => {
  const sourceId = payload.sourceWorkspaceId.trim();
  const targetId = payload.targetWorkspaceId.trim();
  return importBrowsersCopyBrowserWorkspaceProfile(
    payload,
    buildBrowserImportDeps(buildBrowserImportTabGraph(sourceId, targetId)),
  );
};

const importChromeProfileIntoWorkspace = (workspaceId: string) =>
  importBrowsersImportChromeProfileIntoWorkspace(
    workspaceId,
    buildBrowserImportDeps(),
  );

function browserChromeLikePlatformToken(): string {
  return browserChromeLikePlatformTokenUtil();
}

function browserAcceptedLanguages(): string {
  return browserAcceptedLanguagesUtil(app.getLocale());
}

function browserNativeIdentity(session: Session): BrowserSessionIdentity {
  const nativeUserAgent = session.getUserAgent().trim();
  const chromeVersion = (process.versions.chrome || "141.0.0.0").trim();
  return {
    userAgent:
      nativeUserAgent ||
      `Mozilla/5.0 (${browserChromeLikePlatformToken()}) AppleWebKit/537.36 ` +
        `(KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
    acceptLanguages: browserAcceptedLanguages(),
  };
}

function setRequestHeaderValue(
  headers: Record<string, string>,
  headerName: string,
  value: string,
): Record<string, string> {
  const normalized = headerName.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === normalized && key !== headerName) {
      delete headers[key];
    }
  }
  headers[headerName] = value;
  return headers;
}

// Pure observability helpers (browserObservabilityLimit / ConsoleLevelValue /
// ConsoleLevelRank / ObservedErrorSource / IsoFromNetworkTimestamp /
// HeaderRecord / HeaderFirstValue / ResponseBodyMetadata /
// RequestBodyMetadata / appendBoundedEntry) moved to
// browser-pane/observability.ts.

// Per-tab observability state mutation (browserTabForWebContentsId,
// appendBrowserObservedError, upsertBrowserRequestRecord,
// trackBrowserRequest{Start,Headers,Completion,Failure}) moved to
// browser-pane/tab-observability.ts. Wired below where browserWorkspaces
// is declared.

function configureBrowserWorkspaceSession(
  session: Session,
): BrowserSessionIdentity {
  const browserIdentity = browserNativeIdentity(session);
  session.setUserAgent(
    browserIdentity.userAgent,
    browserIdentity.acceptLanguages,
  );
  session.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      trackBrowserRequestStart(details);
      callback({});
    },
  );
  session.webRequest.onBeforeSendHeaders(
    { urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      const requestHeaders = {
        ...details.requestHeaders,
      } as Record<string, string>;
      setRequestHeaderValue(
        requestHeaders,
        "Accept-Language",
        browserIdentity.acceptLanguages,
      );
      trackBrowserRequestHeaders({
        ...details,
        requestHeaders,
      });
      callback({ requestHeaders });
    },
  );
  session.webRequest.onCompleted(
    { urls: ["http://*/*", "https://*/*"] },
    (details) => {
      trackBrowserRequestCompletion(details);
    },
  );
  session.webRequest.onErrorOccurred(
    { urls: ["http://*/*", "https://*/*"] },
    (details) => {
      trackBrowserRequestFailure(details);
    },
  );
  return browserIdentity;
}

function fileBookmarksPath() {
  return path.join(app.getPath("userData"), "file-bookmarks.json");
}

function runtimeLogsPath() {
  return path.join(app.getPath("userData"), "runtime.log");
}

function authStorageConfigPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function runtimeSandboxRoot() {
  return path.join(app.getPath("userData"), "sandbox-host");
}

function runtimeConfigPath() {
  return path.join(runtimeSandboxRoot(), "state", "runtime-config.json");
}

function runtimeModelCatalogCachePath() {
  return path.join(runtimeSandboxRoot(), "state", "runtime-model-catalog.json");
}

function legacyRuntimeDatabasePath() {
  return path.join(runtimeSandboxRoot(), "state", "runtime.db");
}

function hostStateDatabasePath() {
  return path.join(runtimeSandboxRoot(), "state", "host-state.db");
}

function runtimeDatabasePath() {
  return hostStateDatabasePath();
}

function controlPlaneDatabasePath() {
  return path.join(runtimeSandboxRoot(), "state", "control-plane.db");
}

function runtimeWorkspaceRoot() {
  return path.join(runtimeSandboxRoot(), "workspace");
}

const WORKSPACE_RUNTIME_LEGACY_BACKFILL_MARKER_KEY =
  "legacy_workspace_backfill_v1_complete";
const WORKSPACE_RUNTIME_MIGRATION_PROBE_TABLES = [
  "agent_sessions",
  "agent_runtime_sessions",
  "conversation_bindings",
  "agent_session_inputs",
  "post_run_jobs",
  "main_session_event_queue",
  "session_runtime_state",
  "session_output_events",
  "subagent_runs",
  "terminal_sessions",
  "terminal_session_events",
  "turn_request_snapshots",
  "turn_results",
  "session_messages",
  "task_proposals",
  "evolve_skill_candidates",
  "memory_update_proposals",
  "memory_entries",
  "memory_embedding_index",
  "memory_recall_vec",
  "output_folders",
  "outputs",
  "app_ports",
  "app_builds",
  "cronjobs",
  "runtime_notifications",
] as const;

const RUNTIME_MIGRATION_STARTUP_MESSAGE = "Migrating database";
const DEFAULT_RUNTIME_STARTUP_HEALTH_ATTEMPTS = 30;
const MIGRATION_RUNTIME_STARTUP_HEALTH_ATTEMPTS = 900;
const RUNTIME_STARTUP_HEALTH_DELAY_MS = 1000;

function sqliteTableExists(
  database: Database.Database,
  tableName: string,
): boolean {
  const row = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .get(tableName) as { present?: number } | undefined;
  return row?.present === 1;
}

function openReadonlySqliteDatabase(
  dbPath: string,
): Database.Database | null {
  if (!existsSync(dbPath)) {
    return null;
  }
  try {
    const database = new Database(dbPath, {
      readonly: true,
      fileMustExist: true,
    });
    database.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    return database;
  } catch {
    return null;
  }
}

function workspaceRuntimeDbPathForStartupCheck(
  workspaceId: string,
  workspacePath: string | null | undefined,
): string {
  const trimmedPath = workspacePath?.trim() || "";
  const rootPath = trimmedPath
    ? path.resolve(trimmedPath)
    : workspaceDirectoryPath(workspaceId);
  return path.join(rootPath, ".holaboss", "state", "runtime.db");
}

function workspaceRuntimeLegacyBackfillComplete(dbPath: string): boolean {
  const database = openReadonlySqliteDatabase(dbPath);
  if (!database) {
    return false;
  }

  try {
    if (!sqliteTableExists(database, "workspace_runtime_metadata")) {
      return false;
    }
    const row = database
      .prepare<[string], { value?: string }>(
        "SELECT value FROM workspace_runtime_metadata WHERE key = ? LIMIT 1",
      )
      .get(WORKSPACE_RUNTIME_LEGACY_BACKFILL_MARKER_KEY);
    return row?.value === "complete";
  } catch {
    return false;
  } finally {
    try {
      database.close();
    } catch {
      // ignore
    }
  }
}

function legacyWorkspaceRowsPendingMigration(
  database: Database.Database,
  workspaceId: string,
): boolean {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) {
    return false;
  }

  for (const tableName of WORKSPACE_RUNTIME_MIGRATION_PROBE_TABLES) {
    if (!sqliteTableExists(database, tableName)) {
      continue;
    }
    const row = database
      .prepare<[string], { present: number }>(
        `SELECT 1 AS present FROM ${tableName} WHERE workspace_id = ? LIMIT 1`,
      )
      .get(normalizedWorkspaceId);
    if (row?.present === 1) {
      return true;
    }
  }

  return false;
}

function hasPendingLegacyHostStateDatabaseFileMigration(): boolean {
  const nextPath = hostStateDatabasePath();
  const legacyPath = legacyRuntimeDatabasePath();
  return (
    nextPath !== legacyPath &&
    !existsSync(nextPath) &&
    existsSync(legacyPath)
  );
}

function hasPendingLegacyWorkspaceRuntimeMigration(): boolean {
  const sourceDbPath = existsSync(hostStateDatabasePath())
    ? hostStateDatabasePath()
    : existsSync(legacyRuntimeDatabasePath())
      ? legacyRuntimeDatabasePath()
      : null;
  if (!sourceDbPath) {
    return false;
  }

  const database = openReadonlySqliteDatabase(sourceDbPath);
  if (!database) {
    return false;
  }

  try {
    if (!sqliteTableExists(database, "workspaces")) {
      return false;
    }
    const workspaceColumns = new Set(
      (
        database.prepare("PRAGMA table_info(workspaces)").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    if (!workspaceColumns.has("id")) {
      return false;
    }

    const selectColumns = ["id"];
    if (workspaceColumns.has("workspace_path")) {
      selectColumns.push("workspace_path");
    }
    const whereClause = workspaceColumns.has("deleted_at_utc")
      ? " WHERE deleted_at_utc IS NULL"
      : "";
    const workspaceRows = database
      .prepare(`SELECT ${selectColumns.join(", ")} FROM workspaces${whereClause}`)
      .all() as Array<{
      id: string;
      workspace_path?: string | null;
    }>;

    for (const workspace of workspaceRows) {
      const workspaceId = String(workspace.id ?? "").trim();
      if (!workspaceId) {
        continue;
      }
      if (!legacyWorkspaceRowsPendingMigration(database, workspaceId)) {
        continue;
      }
      const workspaceDbPath = workspaceRuntimeDbPathForStartupCheck(
        workspaceId,
        workspace.workspace_path ?? null,
      );
      if (!workspaceRuntimeLegacyBackfillComplete(workspaceDbPath)) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  } finally {
    try {
      database.close();
    } catch {
      // ignore
    }
  }
}

function runtimeStartupMessage(): string | null {
  if (
    hasPendingLegacyHostStateDatabaseFileMigration() ||
    hasPendingLegacyWorkspaceRuntimeMigration()
  ) {
    return RUNTIME_MIGRATION_STARTUP_MESSAGE;
  }
  return null;
}

function runtimeStartupHealthWaitOptions(startupMessage: string | null | undefined) {
  return {
    attempts:
      startupMessage?.trim() === RUNTIME_MIGRATION_STARTUP_MESSAGE
        ? MIGRATION_RUNTIME_STARTUP_HEALTH_ATTEMPTS
        : DEFAULT_RUNTIME_STARTUP_HEALTH_ATTEMPTS,
    delayMs: RUNTIME_STARTUP_HEALTH_DELAY_MS,
  };
}

async function migrateLegacyHostStateDatabaseFiles() {
  const nextPath = hostStateDatabasePath();
  const legacyPath = legacyRuntimeDatabasePath();
  if (nextPath === legacyPath) {
    return;
  }
  try {
    await fs.access(nextPath);
    return;
  } catch {
    // continue
  }
  try {
    await fs.access(legacyPath);
  } catch {
    return;
  }
  await fs.mkdir(path.dirname(nextPath), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${legacyPath}${suffix}`;
    const target = `${nextPath}${suffix}`;
    try {
      await fs.access(source);
    } catch {
      continue;
    }
    try {
      await fs.access(target);
      continue;
    } catch {
      // continue
    }
    try {
      await fs.rename(source, target);
    } catch {
      await fs.copyFile(source, target);
      await fs.unlink(source);
    }
  }
}

function diagnosticsBundleWorkspaceSegment(
  workspace: WorkspaceRecordPayload | null,
) {
  const label = workspace?.name?.trim() || workspace?.id?.trim() || "";
  const sanitized = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return sanitized || null;
}

function diagnosticsBundleFileName(
  date = new Date(),
  workspace: WorkspaceRecordPayload | null = null,
) {
  const timestamp = date
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-");
  const workspaceSegment = diagnosticsBundleWorkspaceSegment(workspace);
  if (workspaceSegment) {
    return `holaboss-diagnostics-${workspaceSegment}-${timestamp}.zip`;
  }
  return `holaboss-diagnostics-${timestamp}.zip`;
}

function diagnosticsWorkspaceSummary(
  workspace: WorkspaceRecordPayload | null,
): Record<string, unknown> | null {
  if (!workspace) {
    return null;
  }
  return {
    id: workspace.id,
    name: workspace.name,
    status: workspace.status,
    harness: workspace.harness,
    onboarding_status: workspace.onboarding_status,
    created_at: workspace.created_at,
    updated_at: workspace.updated_at,
    deleted_at_utc: workspace.deleted_at_utc,
    workspace_path: workspace.workspace_path ?? null,
    folder_state: workspace.folder_state ?? null,
  };
}

function resolveDiagnosticsWorkspace(
  workspaceId?: string | null,
): WorkspaceRecordPayload | null {
  const normalizedWorkspaceId = workspaceId?.trim()
    ? assertSafeWorkspaceId(workspaceId)
    : "";
  if (!normalizedWorkspaceId) {
    return null;
  }

  let workspace =
    listWorkspacesFromLocalDb().items.find(
      (item) => item.id === normalizedWorkspaceId,
    ) ?? null;
  if (!workspace) {
    try {
      workspace = getLocalWorkspaceRecord(normalizedWorkspaceId);
    } catch {
      workspace = null;
    }
  }
  if (!workspace || workspace.deleted_at_utc) {
    throw new Error("Selected workspace is not available for diagnostics export.");
  }
  return workspace;
}

async function exportDesktopDiagnosticsBundle(
  payload?: DiagnosticsExportRequestPayload,
) {
  const workspace = resolveDiagnosticsWorkspace(payload?.workspaceId ?? null);
  const workspaceSummary = diagnosticsWorkspaceSummary(workspace);
  const workspaceRuntimeDbPath = workspace
    ? workspaceRuntimeDbPathForStartupCheck(
        workspace.id,
        workspace.workspace_path ?? null,
      )
    : null;
  const downloadsDir = app.getPath("downloads");
  const bundlePath = path.join(
    downloadsDir,
    diagnosticsBundleFileName(new Date(), workspace),
  );
  const { exportDiagnosticsBundle } = await import("./diagnostics-bundle.js");
  const result = await exportDiagnosticsBundle({
    bundlePath,
    runtimeLogPath: runtimeLogsPath(),
    runtimeDbPath: runtimeDatabasePath(),
    runtimeConfigPath: runtimeConfigPath(),
    workspaceRuntimeDbPath,
    workspaceId: workspace?.id ?? null,
    workspaceSummary,
    summary: {
      exported_at: utcNowIso(),
      app_version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      workspace: workspaceSummary,
      versions: {
        chrome: process.versions.chrome,
        electron: process.versions.electron,
        node: process.versions.node,
      },
      runtime_status: runtimeStatus,
    },
  });
  shell.showItemInFolder(result.bundlePath);
  return {
    ...result,
    workspaceId: workspace?.id ?? null,
    workspaceName: workspace?.name ?? null,
  };
}

function revealDiagnosticsBundle(targetPath: string): boolean {
  if (typeof targetPath !== "string" || targetPath.length === 0) {
    return false;
  }
  const downloadsDir = app.getPath("downloads");
  const resolved = path.resolve(targetPath);
  const relative = path.relative(downloadsDir, resolved);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep)
  ) {
    return false;
  }
  if (!/^holaboss-diagnostics-.+\.zip$/.test(path.basename(resolved))) {
    return false;
  }
  shell.showItemInFolder(resolved);
  return true;
}

const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const SENTRY_RUNTIME_LOG_TAIL_BYTES = 64 * 1024;
const SENTRY_RECENT_EVENT_LIMIT = 40;
const SENTRY_RECENT_STATE_LIMIT = 20;
const SENTRY_REDACTED_VALUE = "[REDACTED]";
const SENTRY_SENSITIVE_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /cookie/i,
  /^authorization$/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /refresh[_-]?token/i,
  /access[_-]?token/i,
];
const SENTRY_SENSITIVE_TEXT_ASSIGNMENT_PATTERN =
  /((?:token|secret|password|cookie|authorization|api[_-]?key|private[_-]?key|refresh[_-]?token|access[_-]?token)[^:=\n\r]{0,64}[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const SENTRY_AUTHORIZATION_BEARER_PATTERN =
  /(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+(?:\s+[^\s,;]+)?/gi;

function shouldRedactSentryKey(key: string): boolean {
  const normalized = key.trim();
  if (!normalized) {
    return false;
  }
  return SENTRY_SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function redactDesktopSentryValue(value: unknown, keyName = ""): unknown {
  if (shouldRedactSentryKey(keyName)) {
    if (value === null || value === undefined) {
      return value;
    }
    return SENTRY_REDACTED_VALUE;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactDesktopSentryValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactDesktopSentryValue(entry, key),
      ]),
    );
  }
  return value;
}

function redactDesktopSentryText(text: string): string {
  return text
    .replace(
      SENTRY_AUTHORIZATION_BEARER_PATTERN,
      `$1${SENTRY_REDACTED_VALUE}`,
    )
    .replace(
      SENTRY_SENSITIVE_TEXT_ASSIGNMENT_PATTERN,
      `$1${SENTRY_REDACTED_VALUE}`,
    );
}

function addSentryHintAttachment(
  hint: Sentry.EventHint | undefined,
  attachment: NonNullable<Sentry.EventHint["attachments"]>[number] | null,
) {
  if (!hint || !attachment) {
    return;
  }
  hint.attachments = [...(hint.attachments ?? []), attachment];
}

function runtimeSentryFileMetadata(filePath: string): Record<string, unknown> {
  if (!filePath) {
    return { path: null, exists: false };
  }
  try {
    const stats = statSync(filePath);
    return {
      path: path.basename(filePath),
      exists: true,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    };
  } catch {
    return {
      path: path.basename(filePath),
      exists: false,
    };
  }
}

function readFileTail(filePath: string, maxBytes: number): string | null {
  if (!filePath || !existsSync(filePath)) {
    return null;
  }
  const buffer = readFileSync(filePath);
  const start = Math.max(0, buffer.length - maxBytes);
  return buffer.subarray(start).toString("utf8");
}

function openRuntimeDiagnosticsDatabase(): Database.Database | null {
  const dbPath = runtimeDatabasePath();
  if (!existsSync(dbPath)) {
    return null;
  }
  const database = new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
  });
  database.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  return database;
}

function openWorkspaceRuntimeDiagnosticsDatabases(): Database.Database[] {
  const databases: Database.Database[] = [];
  const seenPaths = new Set<string>();
  let workspaces: WorkspaceRecordPayload[] = [];
  try {
    workspaces = localWorkspaceRegistry.listCachedWorkspaces().items;
  } catch {
    return [];
  }
  for (const workspace of workspaces) {
    const workspacePath = workspace.workspace_path?.trim() || "";
    if (!workspacePath) {
      continue;
    }
    const workspaceRuntimeDbPath = path.join(workspacePath, ".holaboss", "state", "runtime.db");
    if (!existsSync(workspaceRuntimeDbPath) || seenPaths.has(workspaceRuntimeDbPath)) {
      continue;
    }
    try {
      const database = new Database(workspaceRuntimeDbPath, {
        readonly: true,
        fileMustExist: true,
      });
      database.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      databases.push(database);
      seenPaths.add(workspaceRuntimeDbPath);
    } catch {
      // Ignore unhealthy or missing workspace-local runtime DBs in diagnostics snapshots.
    }
  }
  return databases;
}

function closeRuntimeDatabases(databases: Database.Database[]) {
  for (const database of databases) {
    try {
      database.close();
    } catch {
      // Ignore close errors while collecting diagnostics.
    }
  }
}

function readDesktopRuntimeDiagnosticsSnapshot(): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {
    captured_at: utcNowIso(),
    desktop: {
      launch_id: DESKTOP_LAUNCH_ID,
      app_version: app.getVersion(),
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      versions: {
        chrome: process.versions.chrome,
        electron: process.versions.electron,
        node: process.versions.node,
      },
    },
    runtime_status: runtimeStatus,
    persisted_runtime_process: readPersistedRuntimeProcessState(),
    files: {
      host_state_db: runtimeSentryFileMetadata(runtimeDatabasePath()),
      runtime_log: runtimeSentryFileMetadata(runtimeLogsPath()),
      runtime_config: runtimeSentryFileMetadata(runtimeConfigPath()),
    },
  };

  const database = openRuntimeDiagnosticsDatabase();
  if (!database) {
    return redactDesktopSentryValue(snapshot) as Record<string, unknown>;
  }

  const workspaceDatabases = openWorkspaceRuntimeDiagnosticsDatabases();
  try {
    const workspaceTerminalSessions = workspaceDatabases.flatMap((workspaceDatabase) =>
      workspaceDatabase.prepare(`
        SELECT terminal_id, workspace_id, session_id, input_id, owner, status, title, command, last_activity_at, created_at
        FROM terminal_sessions
      `).all() as Array<Record<string, unknown>>
    );
    workspaceTerminalSessions.sort((left, right) => {
      const activityCompare = String(right.last_activity_at ?? "").localeCompare(String(left.last_activity_at ?? ""));
      if (activityCompare !== 0) {
        return activityCompare;
      }
      const createdCompare = String(right.created_at ?? "").localeCompare(String(left.created_at ?? ""));
      if (createdCompare !== 0) {
        return createdCompare;
      }
      return String(right.terminal_id ?? "").localeCompare(String(left.terminal_id ?? ""));
    });
    const activeTerminalSessionCount = workspaceTerminalSessions.filter((row) =>
      ["starting", "running"].includes(String(row.status ?? ""))
    ).length;

    const workspaceAppBuilds = workspaceDatabases.flatMap((workspaceDatabase) =>
      workspaceDatabase.prepare(`
        SELECT workspace_id, app_id, status, error, updated_at
        FROM app_builds
        WHERE status IN ('running', 'failed')
      `).all() as Array<Record<string, unknown>>
    );
    workspaceAppBuilds.sort((left, right) =>
      String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? ""))
    );

    const workspaceRuntimeStateRows = workspaceDatabases.flatMap((workspaceDatabase) =>
      workspaceDatabase.prepare(`
        SELECT workspace_id, session_id, status, current_input_id, updated_at
        FROM session_runtime_state
      `).all() as Array<Record<string, unknown>>
    );
    workspaceRuntimeStateRows.sort((left, right) => {
      const updatedCompare = String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? ""));
      if (updatedCompare !== 0) {
        return updatedCompare;
      }
      const sessionCompare = String(right.session_id ?? "").localeCompare(String(left.session_id ?? ""));
      if (sessionCompare !== 0) {
        return sessionCompare;
      }
      return String(right.workspace_id ?? "").localeCompare(String(left.workspace_id ?? ""));
    });
    const activeSessionCount = workspaceRuntimeStateRows.filter((row) => {
      const status = String(row.status ?? "");
      return status === "BUSY" || status === "QUEUED" || row.current_input_id != null;
    }).length;
    const queuedInputCount = workspaceDatabases.reduce((total, workspaceDatabase) => {
      const row = workspaceDatabase
        .prepare(
          "SELECT COUNT(*) AS count FROM agent_session_inputs WHERE status IN ('queued', 'claimed')",
        )
        .get() as { count?: number } | undefined;
      return total + Number(row?.count ?? 0);
    }, 0);

    snapshot.database = {
      counts: {
        active_sessions: activeSessionCount,
        active_terminal_sessions: activeTerminalSessionCount,
        failed_app_builds: workspaceAppBuilds.length,
        queued_inputs: queuedInputCount,
      },
      recent_event_log: database.prepare(`
        SELECT category, event, outcome, detail, created_at
        FROM event_log
        ORDER BY created_at DESC
        LIMIT ?
      `).all(SENTRY_RECENT_EVENT_LIMIT),
      session_runtime_state: workspaceRuntimeStateRows.slice(0, SENTRY_RECENT_STATE_LIMIT),
      terminal_sessions: workspaceTerminalSessions.slice(0, SENTRY_RECENT_STATE_LIMIT),
      app_builds: workspaceAppBuilds.slice(0, SENTRY_RECENT_STATE_LIMIT),
    };
  } catch (error) {
    snapshot.database = {
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    closeRuntimeDatabases(workspaceDatabases);
    database.close();
  }

  return redactDesktopSentryValue(snapshot) as Record<string, unknown>;
}

function redactedRuntimeConfigAttachment() {
  const configPath = runtimeConfigPath();
  if (!existsSync(configPath)) {
    return null;
  }
  let data = "";
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    data = `${JSON.stringify(redactDesktopSentryValue(parsed), null, 2)}\n`;
  } catch {
    data = `${JSON.stringify(
      {
        error: "runtime-config.json could not be parsed for redaction.",
      },
      null,
      2,
    )}\n`;
  }
  return {
    filename: "runtime-config.redacted.json",
    data,
    contentType: "application/json",
  };
}

function runtimeLogTailAttachment() {
  const tail = readFileTail(runtimeLogsPath(), SENTRY_RUNTIME_LOG_TAIL_BYTES);
  if (!tail) {
    return null;
  }
  return {
    filename: "runtime-log-tail.txt",
    data: redactDesktopSentryText(tail),
    contentType: "text/plain",
  };
}

function enrichDesktopSentryEvent(
  event: Sentry.ErrorEvent,
  hint: Sentry.EventHint | undefined,
): Sentry.ErrorEvent {
  if (event.request?.headers) {
    delete event.request.headers.authorization;
    delete event.request.headers.cookie;
    delete event.request.headers["x-api-key"];
  }

  event.tags = {
    ...(event.tags ?? {}),
    desktop_launch_id: DESKTOP_LAUNCH_ID,
    process_kind: "electron_main",
  };

  // Skip the heavy diagnostics path (sqlite reads, file attachments, event-log
  // dumps) for non-error events — `enableLogs: true` funnels every console.*
  // call through here.
  const level = event.level;
  const isErrorish =
    level === "fatal" ||
    level === "error" ||
    Boolean(event.exception?.values?.length);
  if (!isErrorish) {
    return event;
  }

  const diagnostics = readDesktopRuntimeDiagnosticsSnapshot();
  const diagnosticsAttachment = {
    filename: "desktop-runtime-diagnostics.json",
    data: `${JSON.stringify(diagnostics, null, 2)}\n`,
    contentType: "application/json",
  };
  addSentryHintAttachment(hint, diagnosticsAttachment);
  addSentryHintAttachment(hint, runtimeLogTailAttachment());
  addSentryHintAttachment(hint, redactedRuntimeConfigAttachment());
  event.contexts = {
    ...(event.contexts ?? {}),
    desktop_process:
      (diagnostics.desktop as Record<string, unknown> | undefined) ?? {},
    embedded_runtime_status:
      (diagnostics.runtime_status as Record<string, unknown> | undefined) ?? {},
    embedded_runtime_files:
      (diagnostics.files as Record<string, unknown> | undefined) ?? {},
  };
  return event;
}

function processIsAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminatePid(pid: number, signal: NodeJS.Signals) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  try {
    process.kill(pid, signal);
  } catch {
    // ignore
  }
}

function utcNowIso() {
  return new Date().toISOString();
}

function openRuntimeDatabase() {
  const database = new Database(runtimeDatabasePath());
  database.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  database.pragma("foreign_keys = ON");
  return database;
}

// Cached sqlite handle + statement, disposed via `ensureAppQuitCleanup`.
type CachedRuntimeStatement = {
  get: () => Database.Statement;
  invalidate: () => void;
};
const cachedRuntimeStatementDisposers: Array<() => void> = [];
function cacheRuntimeStatement(sql: string): CachedRuntimeStatement {
  let database: Database.Database | null = null;
  let statement: Database.Statement | null = null;
  const disposer = () => {
    try {
      database?.close();
    } catch {
      // ignore
    }
    database = null;
    statement = null;
  };
  cachedRuntimeStatementDisposers.push(disposer);
  return {
    get() {
      if (!database) {
        database = openRuntimeDatabase();
      }
      if (!statement) {
        statement = database.prepare(sql);
      }
      return statement;
    },
    invalidate: disposer,
  };
}

function migrateLocalWorkspacesTable(database: Database.Database) {
  const tableInfo = database
    .prepare("PRAGMA table_info(workspaces)")
    .all() as Array<{ name: string }>;
  const columns = new Set(tableInfo.map((column) => column.name));
  if (!columns.has("holaboss_user_id")) {
    database.exec("DROP INDEX IF EXISTS idx_workspaces_user_updated;");
    return;
  }

  database.exec(`
    DROP INDEX IF EXISTS idx_workspaces_user_updated;
    ALTER TABLE workspaces RENAME TO workspaces_legacy_with_owner;

    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      harness TEXT,
      error_message TEXT,
      onboarding_status TEXT NOT NULL,
      onboarding_session_id TEXT,
      onboarding_completed_at TEXT,
      onboarding_completion_summary TEXT,
      onboarding_requested_at TEXT,
      onboarding_requested_by TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at_utc TEXT
    );
  `);

  const legacyRows = database
    .prepare(`
      SELECT
        id,
        ${columns.has("workspace_path") ? "workspace_path," : ""}
        name,
        status,
        harness,
        error_message,
        onboarding_status,
        onboarding_session_id,
        onboarding_completed_at,
        onboarding_completion_summary,
        onboarding_requested_at,
        onboarding_requested_by,
        created_at,
        updated_at,
        deleted_at_utc
      FROM workspaces_legacy_with_owner
    `)
    .all() as Array<Record<string, unknown>>;
  const insert = database.prepare(`
    INSERT INTO workspaces (
      id,
      workspace_path,
      name,
      status,
      harness,
      error_message,
      onboarding_status,
      onboarding_session_id,
      onboarding_completed_at,
      onboarding_completion_summary,
      onboarding_requested_at,
      onboarding_requested_by,
      created_at,
      updated_at,
      deleted_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of legacyRows) {
    const rawWorkspacePath =
      typeof row.workspace_path === "string" ? row.workspace_path.trim() : "";
    const workspacePath = rawWorkspacePath
      ? rawWorkspacePath.startsWith("__deleted__/")
        ? rawWorkspacePath
        : path.resolve(rawWorkspacePath)
      : workspaceDirectoryPath(String(row.id ?? ""));
    insert.run(
      row.id,
      workspacePath,
      row.name,
      row.status,
      row.harness ?? null,
      row.error_message ?? null,
      row.onboarding_status ?? "not_required",
      row.onboarding_session_id ?? null,
      row.onboarding_completed_at ?? null,
      row.onboarding_completion_summary ?? null,
      row.onboarding_requested_at ?? null,
      row.onboarding_requested_by ?? null,
      row.created_at ?? null,
      row.updated_at ?? null,
      row.deleted_at_utc ?? null,
    );
  }

  database.exec("DROP TABLE workspaces_legacy_with_owner;");
}

function migrateRuntimeInstallationStateTable(database: Database.Database) {
  const tableInfo = database
    .prepare("PRAGMA table_info(runtime_installation_state)")
    .all() as Array<{ name: string }>;
  if (!tableInfo.length) {
    return;
  }

  const columns = new Set(tableInfo.map((column) => column.name));
  if (!columns.has("runtime_flavor")) {
    return;
  }

  database.exec(`
    ALTER TABLE runtime_installation_state RENAME TO runtime_installation_state_legacy;

    CREATE TABLE runtime_installation_state (
      installation_key TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      runtime_root TEXT,
      runtime_platform TEXT NOT NULL,
      runtime_bundle_version TEXT,
      runtime_bundle_commit TEXT,
      bootstrap_status TEXT NOT NULL,
      bootstrap_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO runtime_installation_state (
      installation_key,
      schema_version,
      runtime_root,
      runtime_platform,
      runtime_bundle_version,
      runtime_bundle_commit,
      bootstrap_status,
      bootstrap_error,
      created_at,
      updated_at
    )
    SELECT
      installation_key,
      schema_version,
      runtime_root,
      runtime_platform,
      runtime_bundle_version,
      runtime_bundle_commit,
      bootstrap_status,
      bootstrap_error,
      created_at,
      updated_at
    FROM runtime_installation_state_legacy;

    DROP TABLE runtime_installation_state_legacy;
  `);
}

function migrateRuntimeProcessStateTable(database: Database.Database) {
  const tableInfo = database
    .prepare("PRAGMA table_info(runtime_process_state)")
    .all() as Array<{ name: string }>;
  if (!tableInfo.length) {
    return;
  }

  const columns = new Set(tableInfo.map((column) => column.name));
  if (!columns.has("launch_id")) {
    database.exec("ALTER TABLE runtime_process_state ADD COLUMN launch_id TEXT;");
  }
  if (!columns.has("sandbox_root")) {
    database.exec("ALTER TABLE runtime_process_state ADD COLUMN sandbox_root TEXT;");
  }
}

async function bootstrapRuntimeDatabase() {
  await fs.mkdir(path.dirname(runtimeDatabasePath()), { recursive: true });
  await migrateLegacyHostStateDatabaseFiles();

  const database = openRuntimeDatabase();
  try {
    database.pragma("journal_mode = WAL");
    migrateLocalWorkspacesTable(database);
    migrateRuntimeInstallationStateTable(database);
    migrateRuntimeProcessStateTable(database);
    database.exec(`
      CREATE TABLE IF NOT EXISTS runtime_installation_state (
        installation_key TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        runtime_root TEXT,
        runtime_platform TEXT NOT NULL,
        runtime_bundle_version TEXT,
        runtime_bundle_commit TEXT,
        bootstrap_status TEXT NOT NULL,
        bootstrap_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        harness TEXT,
        error_message TEXT,
        onboarding_status TEXT NOT NULL,
        onboarding_session_id TEXT,
        onboarding_completed_at TEXT,
        onboarding_completion_summary TEXT,
        onboarding_requested_at TEXT,
        onboarding_requested_by TEXT,
        created_at TEXT,
        updated_at TEXT,
        deleted_at_utc TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_workspaces_updated
        ON workspaces (updated_at DESC);

      CREATE TABLE IF NOT EXISTS runtime_process_state (
        process_key TEXT PRIMARY KEY,
        pid INTEGER,
        status TEXT NOT NULL,
        bind_host TEXT,
        bind_port INTEGER,
        base_url TEXT,
        launch_id TEXT,
        sandbox_root TEXT,
        last_started_at TEXT,
        last_stopped_at TEXT,
        last_healthy_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS event_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        event TEXT NOT NULL,
        outcome TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_event_log_category_created_at
        ON event_log (category, created_at DESC);
    `);

    const now = utcNowIso();
    const { runtimeRoot } = await resolveRuntimeRoot();
    database
      .prepare(
        `
        INSERT INTO runtime_installation_state (
          installation_key,
          schema_version,
          runtime_root,
          runtime_platform,
          runtime_bundle_version,
          runtime_bundle_commit,
          bootstrap_status,
          bootstrap_error,
          created_at,
          updated_at
        ) VALUES (
          @installation_key,
          @schema_version,
          @runtime_root,
          @runtime_platform,
          @runtime_bundle_version,
          @runtime_bundle_commit,
          @bootstrap_status,
          @bootstrap_error,
          @created_at,
          @updated_at
        )
        ON CONFLICT(installation_key) DO UPDATE SET
          schema_version = excluded.schema_version,
          runtime_root = excluded.runtime_root,
          runtime_platform = excluded.runtime_platform,
          runtime_bundle_version = excluded.runtime_bundle_version,
          runtime_bundle_commit = excluded.runtime_bundle_commit,
          bootstrap_status = excluded.bootstrap_status,
          bootstrap_error = excluded.bootstrap_error,
          updated_at = excluded.updated_at
      `,
      )
      .run({
        installation_key: "desktop-runtime",
        schema_version: LOCAL_RUNTIME_SCHEMA_VERSION,
        runtime_root: runtimeRoot,
        runtime_platform: process.platform,
        runtime_bundle_version: null,
        runtime_bundle_commit: null,
        bootstrap_status: "ready",
        bootstrap_error: null,
        created_at: now,
        updated_at: now,
      });
  } finally {
    database.close();
  }
}

function bootstrapControlPlaneDatabase() {
  bootstrapLocalControlPlaneDatabase({
    controlPlaneDatabasePath: controlPlaneDatabasePath,
    runtimeDatabasePath: runtimeDatabasePath,
    workspaceRoot: runtimeWorkspaceRoot,
  });
}

// `persistRuntimeProcessState` is invoked from ~13 sites and fires every
// time the embedded runtime transitions between starting/healthy/stopped/
// error. Each call previously opened a fresh sqlite handle, recompiled
// this 50-line INSERT+UPSERT, ran it, and closed the handle. The `prepare`
// step alone showed up at 261+254+39 ≈ 554 ms self in a 114s --cpu-prof
// trace; the surrounding `Database` constructor and `close` added ~180 ms
// more. Cache one open handle + one prepared statement at module scope so
// each call collapses to a single `.run({...})` after the first hit.
//
// Lifetime: the cached handle is closed in the existing app-quit handler
// alongside other runtime cleanup (see `releaseCachedRuntimeDatabase`
// below) so we don't strand a sqlite reader across an Electron relaunch.
let cachedRuntimeProcessStateDatabase: Database.Database | null = null;
let cachedRuntimeProcessStateStatement: Database.Statement | null = null;

function persistRuntimeProcessState(update: {
  pid?: number | null;
  status: string;
  lastStartedAt?: string | null;
  lastStoppedAt?: string | null;
  lastHealthyAt?: string | null;
  lastError?: string | null;
}) {
  if (!cachedRuntimeProcessStateDatabase) {
    cachedRuntimeProcessStateDatabase = openRuntimeDatabase();
  }
  if (!cachedRuntimeProcessStateStatement) {
    cachedRuntimeProcessStateStatement = cachedRuntimeProcessStateDatabase.prepare(
      `
      INSERT INTO runtime_process_state (
        process_key,
        pid,
        status,
        bind_host,
        bind_port,
        base_url,
        launch_id,
        sandbox_root,
        last_started_at,
        last_stopped_at,
        last_healthy_at,
        last_error,
        updated_at
      ) VALUES (
        @process_key,
        @pid,
        @status,
        @bind_host,
        @bind_port,
        @base_url,
        @launch_id,
        @sandbox_root,
        @last_started_at,
        @last_stopped_at,
        @last_healthy_at,
        @last_error,
        @updated_at
      )
      ON CONFLICT(process_key) DO UPDATE SET
        pid = excluded.pid,
        status = excluded.status,
        bind_host = excluded.bind_host,
        bind_port = excluded.bind_port,
        base_url = excluded.base_url,
        launch_id = excluded.launch_id,
        sandbox_root = excluded.sandbox_root,
        last_started_at = COALESCE(excluded.last_started_at, runtime_process_state.last_started_at),
        last_stopped_at = COALESCE(excluded.last_stopped_at, runtime_process_state.last_stopped_at),
        last_healthy_at = COALESCE(excluded.last_healthy_at, runtime_process_state.last_healthy_at),
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `,
    );
  }
  try {
    cachedRuntimeProcessStateStatement.run({
      process_key: "embedded-runtime",
      pid: update.pid ?? null,
      status: update.status,
      bind_host: "127.0.0.1",
      bind_port: runtimeApiPort(),
      base_url: runtimeBaseUrl(),
      launch_id: DESKTOP_LAUNCH_ID,
      sandbox_root: runtimeSandboxRoot(),
      last_started_at: update.lastStartedAt ?? null,
      last_stopped_at: update.lastStoppedAt ?? null,
      last_healthy_at: update.lastHealthyAt ?? null,
      last_error: update.lastError ?? null,
      updated_at: utcNowIso(),
    });
  } catch (error) {
    // Drop the cached handle on failure so the next call retries cleanly
    // instead of reusing a wedged statement (e.g. after a schema migration
    // or accidental DB delete during dev).
    try {
      cachedRuntimeProcessStateDatabase?.close();
    } catch {
      // ignore close errors on the failure path
    }
    cachedRuntimeProcessStateDatabase = null;
    cachedRuntimeProcessStateStatement = null;
    throw error;
  }
}

type PersistedRuntimeProcessStateRecord = {
  pid: number | null;
  status: string;
  bindHost: string | null;
  bindPort: number | null;
  baseUrl: string | null;
  launchId: string | null;
  sandboxRoot: string | null;
  lastStartedAt: string | null;
  lastStoppedAt: string | null;
  lastHealthyAt: string | null;
  lastError: string | null;
  updatedAt: string;
};

const readPersistedRuntimeProcessStateStatement = cacheRuntimeStatement(`
  SELECT
    pid,
    status,
    bind_host,
    bind_port,
    base_url,
    launch_id,
    sandbox_root,
    last_started_at,
    last_stopped_at,
    last_healthy_at,
    last_error,
    updated_at
  FROM runtime_process_state
  WHERE process_key = ?
  LIMIT 1
`);

function readPersistedRuntimeProcessState(): PersistedRuntimeProcessStateRecord | null {
  let row:
    | {
        pid: number | null;
        status: string;
        bind_host: string | null;
        bind_port: number | null;
        base_url: string | null;
        launch_id: string | null;
        sandbox_root: string | null;
        last_started_at: string | null;
        last_stopped_at: string | null;
        last_healthy_at: string | null;
        last_error: string | null;
        updated_at: string;
      }
    | undefined;
  try {
    row = readPersistedRuntimeProcessStateStatement.get().get("embedded-runtime") as typeof row;
  } catch {
    readPersistedRuntimeProcessStateStatement.invalidate();
    return null;
  }
  if (!row) {
    return null;
  }
  return {
    pid: typeof row.pid === "number" ? row.pid : null,
    status: row.status,
    bindHost: row.bind_host,
    bindPort: typeof row.bind_port === "number" ? row.bind_port : null,
    baseUrl: row.base_url,
    launchId: row.launch_id,
    sandboxRoot: row.sandbox_root,
    lastStartedAt: row.last_started_at,
    lastStoppedAt: row.last_stopped_at,
    lastHealthyAt: row.last_healthy_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

const appendRuntimeEventLogStatement = cacheRuntimeStatement(`
  INSERT INTO event_log (category, event, outcome, detail, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

function appendRuntimeEventLog(event: {
  category: string;
  event: string;
  outcome: string;
  detail?: string | null;
}) {
  Sentry.addBreadcrumb({
    category: `runtime.${event.category}`,
    message: event.event,
    level:
      event.outcome === "error"
        ? "error"
        : event.outcome === "success"
          ? "info"
          : "debug",
    data: {
      outcome: event.outcome,
      detail: event.detail ?? null,
    },
  });
  try {
    appendRuntimeEventLogStatement.get().run(
      event.category,
      event.event,
      event.outcome,
      event.detail ?? null,
      utcNowIso(),
    );
  } catch (error) {
    appendRuntimeEventLogStatement.invalidate();
    throw error;
  }
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath: string, payload: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
}

async function loadBrowserPersistence() {
  fileBookmarks = await readJsonFile<FileBookmarkPayload[]>(
    fileBookmarksPath(),
    [],
  );
}

async function appendRuntimeLog(line: string) {
  await fs.mkdir(path.dirname(runtimeLogsPath()), { recursive: true });
  await fs.appendFile(runtimeLogsPath(), line, "utf-8");
}

async function readRuntimeConfigFile(): Promise<Record<string, string>> {
  const configPath = runtimeConfigPath();
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const parsedRecord = parsed as Record<string, unknown>;
    const runtimePayload = runtimeConfigObject(parsedRecord.runtime);
    const subagentsPayload = runtimeConfigObject(
      runtimePayload.subagents ?? runtimePayload.subAgents,
    );
    const providersPayload = runtimeConfigObject(parsedRecord.providers);
    const integrationsPayload = runtimeConfigObject(parsedRecord.integrations);
    const holabossIntegration = runtimeConfigObject(
      integrationsPayload.holaboss,
    );
    const holabossProvider = runtimeConfigObject(
      providersPayload[RUNTIME_HOLABOSS_PROVIDER_ID],
    );
    const holabossLegacyPayload = runtimeConfigObject(parsedRecord.holaboss);
    const legacyPayload =
      Object.keys(holabossLegacyPayload).length > 0
        ? holabossLegacyPayload
        : parsedRecord;

    const normalized: Record<string, string> = {};
    const authToken = runtimeFirstNonEmptyString(
      holabossIntegration.auth_token as string | undefined,
      holabossProvider.api_key as string | undefined,
      legacyPayload.auth_token as string | undefined,
      legacyPayload.model_proxy_api_key as string | undefined,
    );
    const userId = runtimeFirstNonEmptyString(
      holabossIntegration.user_id as string | undefined,
      legacyPayload.user_id as string | undefined,
    );
    const bindingSandboxId = runtimeFirstNonEmptyString(
      holabossIntegration.sandbox_id as string | undefined,
      legacyPayload.sandbox_id as string | undefined,
    );
    const sandboxId =
      authToken && bindingSandboxId
        ? bindingSandboxId
        : runtimeFirstNonEmptyString(
            runtimePayload.sandbox_id as string | undefined,
            bindingSandboxId,
          );
    const modelProxyBaseUrl = runtimeFirstNonEmptyString(
      holabossProvider.base_url as string | undefined,
      legacyPayload.model_proxy_base_url as string | undefined,
    );
    const defaultModel = normalizeLegacyRuntimeModelToken(
      runtimeFirstNonEmptyString(
        runtimePayload.default_model as string | undefined,
        legacyPayload.default_model as string | undefined,
      ),
    );
    const subagentModel = normalizeLegacyRuntimeModelToken(
      runtimeFirstNonEmptyString(
        subagentsPayload.model as string | undefined,
        subagentsPayload.model_id as string | undefined,
        subagentsPayload.modelId as string | undefined,
      ),
    );
    const defaultProvider = runtimeFirstNonEmptyString(
      runtimePayload.default_provider as string | undefined,
      legacyPayload.default_provider as string | undefined,
    );
    const controlPlaneBaseUrl = runtimeFirstNonEmptyString(
      legacyPayload.control_plane_base_url as string | undefined,
    );

    if (authToken) {
      normalized.auth_token = authToken;
      normalized.model_proxy_api_key = authToken;
    }
    if (userId) {
      normalized.user_id = userId;
    }
    if (sandboxId) {
      normalized.sandbox_id = sandboxId;
    }
    if (modelProxyBaseUrl) {
      normalized.model_proxy_base_url = modelProxyBaseUrl;
    }
    if (defaultModel) {
      normalized.default_model = defaultModel;
    }
    if (subagentModel) {
      normalized.subagent_model = subagentModel;
    }
    if (defaultProvider) {
      normalized.default_provider = defaultProvider;
    }
    if (controlPlaneBaseUrl) {
      normalized.control_plane_base_url = controlPlaneBaseUrl;
    }

    return normalized;
  } catch {
    return {};
  }
}

async function readRuntimeConfigDocument(): Promise<Record<string, unknown>> {
  const configPath = runtimeConfigPath();
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ============================================================
// Provider validation — cheap probe per provider to confirm the
// stored credentials still work. Hit one read-only endpoint with
// a short timeout. We don't try to parse model lists or authn
// scopes; a 2xx is enough signal for "your key is alive".
// ============================================================

interface ValidateProviderResult {
  ok: boolean;
  detail: string;
}

const PROVIDER_DEFAULT_BASE_URL: Record<string, string> = {
  openai_direct: "https://api.openai.com",
  openai_codex: "https://api.openai.com",
  anthropic_direct: "https://api.anthropic.com",
  openrouter_direct: "https://openrouter.ai/api",
  gemini_direct: "https://generativelanguage.googleapis.com/v1beta/openai",
  minimax: "https://api.minimaxi.chat",
  ollama_local: "http://localhost:11434",
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

async function validateRuntimeProvider(
  providerId: string,
): Promise<ValidateProviderResult> {
  // Holaboss = managed proxy, gated by Better Auth session cookie.
  if (providerId === "holaboss") {
    const cookie = authCookieHeader();
    if (!cookie) {
      return { ok: false, detail: "Not signed in" };
    }
    return { ok: true, detail: "Signed in" };
  }

  const document = await readRuntimeConfigDocument();
  const providers = (document.providers as Record<string, unknown>) ?? {};
  const storageId =
    providerId === "holaboss" ? "holaboss_model_proxy" : providerId;
  const provider = providers[storageId] as Record<string, unknown> | undefined;
  if (!provider) {
    return { ok: false, detail: "Not configured" };
  }

  const apiKey = String(provider.api_key ?? "").trim();
  const configuredBase = String(provider.base_url ?? "").trim();
  const baseUrl = trimTrailingSlash(
    configuredBase || PROVIDER_DEFAULT_BASE_URL[providerId] || "",
  );
  if (!baseUrl) {
    return { ok: false, detail: "No base URL configured" };
  }
  if (!apiKey && providerId !== "ollama_local" && providerId !== "openai_codex") {
    return { ok: false, detail: "API key missing" };
  }

  let url = `${baseUrl}/v1/models`;
  const headers: Record<string, string> = {};
  if (providerId === "anthropic_direct") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (providerId === "ollama_local") {
    url = `${baseUrl}/api/tags`;
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  // 6s upper bound — anything slower is effectively "down" from the
  // user's perspective.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetchWithNetworkRetry(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (response.ok) {
      return { ok: true, detail: `${response.status} ${response.statusText || "OK"}` };
    }
    return { ok: false, detail: `HTTP ${response.status}` };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, detail: "Timed out" };
    }
    return {
      ok: false,
      detail: error instanceof Error ? error.message : "Network error",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function writeRuntimeConfigTextAtomically(
  nextText: string,
): Promise<void> {
  const configPath = runtimeConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, nextText, "utf-8");
  try {
    await fs.rename(tempPath, configPath);
  } catch {
    await fs.rm(configPath, { force: true }).catch(() => undefined);
    await fs.rename(tempPath, configPath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function openAiCodexAccessTokenExpiresAt(expiresIn: unknown): string {
  const rawSeconds =
    typeof expiresIn === "number"
      ? expiresIn
      : typeof expiresIn === "string"
        ? Number.parseInt(expiresIn, 10)
        : NaN;
  const seconds =
    Number.isFinite(rawSeconds) && rawSeconds > 0 ? rawSeconds : 3600;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function openAiCodexExpiryTimestampMs(value: unknown): number {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return 0;
  }
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function openAiCodexNeedsRefresh(
  expiresAt: unknown,
  skewMs = OPENAI_CODEX_REFRESH_SKEW_MS,
): boolean {
  const expiryTimestampMs = openAiCodexExpiryTimestampMs(expiresAt);
  if (!expiryTimestampMs) {
    return true;
  }
  return expiryTimestampMs - Date.now() <= skewMs;
}

function openAiCodexProviderStateFromDocument(document: Record<string, unknown>) {
  const providersPayload = runtimeConfigObject(document.providers);
  const providerPayload = runtimeConfigObject(
    providersPayload[OPENAI_CODEX_PROVIDER_ID],
  );
  const optionsPayload = runtimeConfigObject(providerPayload.options);
  return {
    providersPayload,
    providerPayload,
    optionsPayload,
    authMode: runtimeFirstNonEmptyString(
      providerPayload.auth_mode as string | undefined,
      optionsPayload.auth_mode as string | undefined,
    ),
    baseUrl: runtimeFirstNonEmptyString(
      providerPayload.base_url as string | undefined,
      providerPayload.baseURL as string | undefined,
      optionsPayload.base_url as string | undefined,
      optionsPayload.baseURL as string | undefined,
      OPENAI_CODEX_BASE_URL,
    ),
    accessToken: runtimeFirstNonEmptyString(
      providerPayload.api_key as string | undefined,
      providerPayload.auth_token as string | undefined,
    ),
    refreshToken: runtimeFirstNonEmptyString(
      optionsPayload.refresh_token as string | undefined,
      optionsPayload.refreshToken as string | undefined,
    ),
    accessTokenExpiresAt: runtimeFirstNonEmptyString(
      optionsPayload.access_token_expires_at as string | undefined,
      optionsPayload.accessTokenExpiresAt as string | undefined,
    ),
  };
}

function runtimeDocumentProviderModelIds(
  document: Record<string, unknown>,
  providerId: string,
): Set<string> {
  const modelsPayload = runtimeConfigObject(document.models);
  const modelIds = new Set<string>();
  for (const [token, rawModel] of Object.entries(modelsPayload)) {
    const modelPayload = runtimeConfigObject(rawModel);
    const configuredProviderId = runtimeFirstNonEmptyString(
      modelPayload.provider as string | undefined,
      modelPayload.provider_id as string | undefined,
      token.includes("/") ? token.split("/")[0]?.trim() : "",
    );
    if (configuredProviderId !== providerId) {
      continue;
    }
    const configuredModelId = runtimeFirstNonEmptyString(
      modelPayload.model as string | undefined,
      modelPayload.model_id as string | undefined,
      token.includes("/") ? token.split("/").slice(1).join("/").trim() : "",
    );
    if (configuredModelId) {
      modelIds.add(configuredModelId);
    }
  }
  return modelIds;
}

function withProviderDefaultModels(
  document: Record<string, unknown>,
  providerId: string,
  modelIds: readonly string[],
): Record<string, unknown> {
  const currentModels = runtimeConfigObject(document.models);
  const nextModels: Record<string, unknown> = { ...currentModels };
  const existingModelIds = runtimeDocumentProviderModelIds(document, providerId);
  let didAddModel = false;
  for (const modelId of modelIds) {
    const normalizedModelId = modelId.trim();
    if (!normalizedModelId || existingModelIds.has(normalizedModelId)) {
      continue;
    }
    nextModels[`${providerId}/${normalizedModelId}`] = {
      provider: providerId,
      model: normalizedModelId,
    };
    didAddModel = true;
  }
  if (!didAddModel) {
    return document;
  }
  return {
    ...document,
    models: nextModels,
  };
}

function withOpenAiCodexProviderState(
  document: Record<string, unknown>,
  update: {
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: string;
    lastRefreshAt?: string;
  },
): Record<string, unknown> {
  const providersPayload = runtimeConfigObject(document.providers);
  const existingProviderPayload = runtimeConfigObject(
    providersPayload[OPENAI_CODEX_PROVIDER_ID],
  );
  const existingOptionsPayload = runtimeConfigObject(existingProviderPayload.options);
  const nextProviderPayload: Record<string, unknown> = {
    ...existingProviderPayload,
    kind: RUNTIME_PROVIDER_KIND_OPENAI_COMPATIBLE,
    base_url: OPENAI_CODEX_BASE_URL,
    api_key: update.accessToken.trim(),
    options: {
      ...existingOptionsPayload,
      auth_mode: "codex_oauth",
      refresh_token: update.refreshToken.trim(),
      access_token_expires_at: update.accessTokenExpiresAt.trim(),
      last_refresh_at:
        update.lastRefreshAt?.trim() || existingOptionsPayload.last_refresh_at || utcNowIso(),
    },
  };
  const nextProviders = {
    ...providersPayload,
    [OPENAI_CODEX_PROVIDER_ID]: nextProviderPayload,
  };
  return withProviderDefaultModels({
    ...document,
    providers: nextProviders,
  }, OPENAI_CODEX_PROVIDER_ID, OPENAI_CODEX_DEFAULT_MODELS);
}

async function updateRuntimeConfigDocumentWithoutRestart(
  mutate: (currentDocument: Record<string, unknown>) => Record<string, unknown>,
): Promise<RuntimeConfigPayload> {
  let didWrite = false;
  await withRuntimeConfigMutationLock(async () => {
    const currentDocument = await readRuntimeConfigDocument();
    const nextDocument = mutate(currentDocument);
    const currentText =
      Object.keys(currentDocument).length > 0
        ? `${JSON.stringify(currentDocument, null, 2)}\n`
        : "";
    const nextText = `${JSON.stringify(nextDocument, null, 2)}\n`;
    if (currentText === nextText) {
      return;
    }
    await writeRuntimeConfigTextAtomically(nextText);
    didWrite = true;
  });

  const config = await getRuntimeConfigWithoutCatalogRefresh();
  if (didWrite) {
    await emitRuntimeConfig(config);
  }
  return config;
}

async function openAiCodexTokenResponseJson(
  response: Response,
  fallbackMessage: string,
): Promise<Record<string, unknown>> {
  try {
    const payload = (await response.json()) as unknown;
    return runtimeConfigObject(payload);
  } catch {
    throw new Error(fallbackMessage);
  }
}

function openAiCodexErrorMessage(
  payload: Record<string, unknown>,
  fallbackMessage: string,
): string {
  const errorPayload = runtimeConfigObject(payload.error);
  return runtimeFirstNonEmptyString(
    payload.error_description,
    payload.message,
    payload.detail,
    errorPayload.message,
    errorPayload.error_description,
    payload.error,
    fallbackMessage,
  );
}

async function updateDesktopBrowserCapabilityConfig(update: {
  enabled: boolean;
  url?: string;
  authToken?: string;
}): Promise<void> {
  await withRuntimeConfigMutationLock(async () => {
    const currentDocument = await readRuntimeConfigDocument();
    const capabilities =
      typeof currentDocument.capabilities === "object" &&
      currentDocument.capabilities
        ? { ...(currentDocument.capabilities as Record<string, unknown>) }
        : {};
    const desktopBrowser =
      typeof capabilities.desktop_browser === "object" &&
      capabilities.desktop_browser
        ? { ...(capabilities.desktop_browser as Record<string, unknown>) }
        : {};

    desktopBrowser.enabled = update.enabled;
    if (update.url && update.url.trim()) {
      desktopBrowser.url = update.url.trim();
    } else {
      delete desktopBrowser.url;
    }
    if (update.authToken && update.authToken.trim()) {
      desktopBrowser.auth_token = update.authToken.trim();
    } else {
      delete desktopBrowser.auth_token;
    }
    delete desktopBrowser.mcp_url;

    capabilities.desktop_browser = desktopBrowser;
    const nextDocument = {
      ...currentDocument,
      capabilities,
    };

    await writeRuntimeConfigTextAtomically(
      `${JSON.stringify(nextDocument, null, 2)}\n`,
    );
  });
}

function currentDesktopBrowserCapabilityConfig() {
  const enabled = Boolean(
    desktopBrowserServiceUrl.trim() && desktopBrowserServiceAuthToken.trim(),
  );
  return {
    enabled,
    url: enabled ? desktopBrowserServiceUrl : undefined,
    authToken: enabled ? desktopBrowserServiceAuthToken : undefined,
  };
}

async function syncDesktopBrowserCapabilityConfig(): Promise<void> {
  await updateDesktopBrowserCapabilityConfig(
    currentDesktopBrowserCapabilityConfig(),
  );
}

// desktopBrowserServiceTokenFromRequest moved to browser-pane/tab-state.ts.

// desktopBrowserWorkspaceIdFromRequest moved to browser-pane/tab-state.ts.

// desktopBrowserSessionIdFromRequest moved to browser-pane/tab-state.ts.

// desktopBrowserSpaceFromRequest moved to browser-pane/tab-state.ts.

// writeBrowserServiceJson moved to browser-pane/tab-state.ts.

// readBrowserServiceJsonBody moved to browser-pane/tab-state.ts.

// browserPagePayload moved to browser-pane/tab-state.ts.

function operatorSurfaceTypeValue(value: unknown): OperatorSurfaceType | null {
  return value === "browser" ||
    value === "editor" ||
    value === "terminal" ||
    value === "app_surface"
    ? value
    : null;
}

function operatorSurfaceOwnerValue(value: unknown): OperatorSurfaceOwner | null {
  return value === "user" || value === "agent" ? value : null;
}

function operatorSurfaceMutabilityValue(
  value: unknown,
): OperatorSurfaceMutability | null {
  return value === "inspect_only" ||
    value === "takeover_allowed" ||
    value === "agent_owned"
    ? value
    : null;
}

function normalizeOperatorSurfacePayload(
  value: unknown,
): OperatorSurfacePayload | null {
  const record = runtimeConfigObject(value);
  const surfaceId = runtimeFirstNonEmptyString(
    typeof record.surface_id === "string" ? record.surface_id : undefined,
  );
  const surfaceType = operatorSurfaceTypeValue(record.surface_type);
  const owner = operatorSurfaceOwnerValue(record.owner);
  const mutability = operatorSurfaceMutabilityValue(record.mutability);
  const summary = runtimeFirstNonEmptyString(
    typeof record.summary === "string" ? record.summary : undefined,
  );
  if (!surfaceId || !surfaceType || !owner || !mutability || !summary) {
    return null;
  }
  return {
    surface_id: surfaceId,
    surface_type: surfaceType,
    owner,
    active: record.active === true,
    mutability,
    summary,
  };
}

function normalizeReportedOperatorSurfaceContext(
  value: unknown,
): ReportedOperatorSurfaceContextPayload | null {
  const record = runtimeConfigObject(value);
  const surfaces = Array.isArray(record.surfaces)
    ? record.surfaces
        .map((surface) => normalizeOperatorSurfacePayload(surface))
        .filter((surface): surface is OperatorSurfacePayload => surface !== null)
    : [];
  if (surfaces.length === 0) {
    return null;
  }
  const activeSurfaceId = runtimeFirstNonEmptyString(
    typeof record.active_surface_id === "string"
      ? record.active_surface_id
      : undefined,
  );
  return {
    active_surface_id: activeSurfaceId ?? null,
    surfaces,
    updated_at: new Date().toISOString(),
  };
}

function browserSurfaceSummary(
  workspaceId: string,
  space: BrowserSpaceId,
  visibleInApp: boolean,
): string {
  const workspace = browserWorkspaceFromMap(workspaceId);
  const tabSpace = browserTabSpaceState(workspace, space, null, {
    useVisibleAgentSession: true,
  });
  const activeTabId = tabSpace?.activeTabId ?? "";
  const tabCount = browserTabSpaceTabCount(tabSpace);
  const activeTab =
    activeTabId && tabSpace?.tabs.size
      ? tabSpace.tabs.get(activeTabId) ?? null
      : null;
  const spaceLabel = space === "user" ? "User browser" : "Agent browser";
  const tabSummary = `${tabCount} open ${tabCount === 1 ? "tab" : "tabs"}`;
  const summaryParts = [`${spaceLabel} surface with ${tabSummary}.`];
  if (activeTab) {
    const activeTitle = activeTab.state.title?.trim() || activeTab.state.url?.trim() || "Untitled";
    const activeUrl = activeTab.state.url?.trim();
    summaryParts.push(`Active tab: "${activeTitle}"${activeUrl ? ` at ${activeUrl}` : ""}.`);
  } else {
    summaryParts.push("No active tab is currently selected.");
  }
  if (visibleInApp) {
    summaryParts.push("This surface is currently visible in the app.");
  }
  if (space === "user") {
    const userLock = activeUserBrowserLock(workspace);
    if (userLock) {
      summaryParts.push(
        `Exclusive control is currently held by agent session ${userLock.sessionId}.`,
      );
      summaryParts.push(
        "User interaction is intercepted first and only pauses the controlling session after explicit confirmation.",
      );
    } else {
      summaryParts.push(
        "Agent takeover is allowed through an exclusive workspace lock on this shared browser surface.",
      );
    }
  }
  summaryParts.push("It shares the workspace browser session and auth state with the other browser surface.");
  return summaryParts.join(" ");
}

function operatorSurfaceContextPayload(workspaceId: string): OperatorSurfaceContextPayload {
  const normalizedWorkspaceId = workspaceId.trim();
  const reportedContext =
    reportedOperatorSurfaceContexts.get(normalizedWorkspaceId) ?? null;
  const reportedSurfaces = reportedContext?.surfaces ?? [];
  const activeReportedSurfaceId =
    reportedContext?.active_surface_id?.trim() || "";
  const browserSurfaces: OperatorSurfacePayload[] = BROWSER_SPACE_IDS.map(
    (space): OperatorSurfacePayload => ({
    surface_id: `browser:${space}`,
    surface_type: "browser",
    owner: space === "user" ? "user" : "agent",
    active:
      activeReportedSurfaceId.length > 0
        ? activeReportedSurfaceId === `browser:${space}`
        : normalizedWorkspaceId === activeBrowserWorkspaceId &&
          activeBrowserSpaceId === space,
    mutability: space === "agent" ? "agent_owned" : "takeover_allowed",
    summary: browserSurfaceSummary(
      normalizedWorkspaceId,
      space,
      activeReportedSurfaceId.length > 0
        ? activeReportedSurfaceId === `browser:${space}`
        : normalizedWorkspaceId === activeBrowserWorkspaceId &&
          activeBrowserSpaceId === space,
    ),
  }),
  );
  const activeSurfaceId = activeReportedSurfaceId ||
    (normalizedWorkspaceId &&
    normalizedWorkspaceId === activeBrowserWorkspaceId
      ? `browser:${activeBrowserSpaceId}`
      : null);
  return {
    active_surface_id: activeSurfaceId,
    surfaces: [...reportedSurfaces, ...browserSurfaces],
  };
}

// serializeBrowserEvalResult moved to browser-pane/tab-state.ts.

function isAbortedBrowserLoadError(error: unknown): boolean {
  return isAbortedBrowserLoadErrorUtil(error);
}

function isAbortedBrowserLoadFailure(
  errorCode: number,
  errorDescription: string,
): boolean {
  return isAbortedBrowserLoadFailureUtil(errorCode, errorDescription);
}

// navigateActiveBrowserTab moved to browser-pane/tab-state.ts.

// handleDesktopBrowserServiceRequest moved to browser-pane/tab-state.ts.

async function startDesktopBrowserService(): Promise<void> {
  if (desktopBrowserServiceServer) {
    return;
  }

  const authToken = randomUUID();
  const server = createServer((request, response) => {
    void browserHttpService.handleRequest(request, response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to resolve desktop browser service address.");
  }

  desktopBrowserServiceServer = server;
  desktopBrowserServiceAuthToken = authToken;
  desktopBrowserServiceUrl = `http://127.0.0.1:${address.port}/api/v1/browser`;
  runtimeStatus = withDesktopBrowserStatus({
    ...runtimeStatus,
  });
  emitRuntimeState();
  await syncDesktopBrowserCapabilityConfig();
}

async function stopDesktopBrowserService(): Promise<void> {
  const server = desktopBrowserServiceServer;
  desktopBrowserServiceServer = null;
  desktopBrowserServiceUrl = "";
  desktopBrowserServiceAuthToken = "";

  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  runtimeStatus = withDesktopBrowserStatus({
    ...runtimeStatus,
  });
  emitRuntimeState();
  await syncDesktopBrowserCapabilityConfig();
}

function desktopBrowserStatusFields() {
  return {
    desktopBrowserReady: Boolean(desktopBrowserServiceUrl),
    desktopBrowserUrl: desktopBrowserServiceUrl || null,
  };
}

function withDesktopBrowserStatus(
  payload: Omit<
    RuntimeStatusPayload,
    "desktopBrowserReady" | "desktopBrowserUrl"
  >,
): RuntimeStatusPayload {
  return {
    ...payload,
    ...desktopBrowserStatusFields(),
  };
}

function resolveTargetWindow(
  senderWindow: BrowserWindow | null | undefined,
): BrowserWindow | null {
  if (senderWindow && !senderWindow.isDestroyed()) {
    return senderWindow;
  }
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function desktopWindowStatePayload(
  targetWindow: BrowserWindow | null | undefined = mainWindow,
): DesktopWindowStatePayload {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return {
      isFullScreen: false,
      isMaximized: false,
      isMinimized: false,
    };
  }

  return {
    isFullScreen: targetWindow.isFullScreen(),
    isMaximized: targetWindow.isMaximized(),
    isMinimized: targetWindow.isMinimized(),
  };
}

function emitWindowStateChanged(
  targetWindow: BrowserWindow | null | undefined = mainWindow,
) {
  const resolvedWindow = resolveTargetWindow(targetWindow);
  if (!resolvedWindow) {
    return;
  }
  // Window-state events ('maximize'/'minimize'/'ready-to-show'/...) can
  // race with window teardown. There are two distinct disposal states to
  // guard against:
  //   1. WebContents fully destroyed — caught by isDestroyed().
  //   2. WebContents alive but the underlying RenderFrame (WebFrameMain)
  //      has been disposed mid-teardown — send() throws
  //      `Render frame was disposed before WebFrameMain could be accessed`
  //      and isDestroyed() still returns false.
  // We catch (1) cheaply and try/catch (2) since it's not introspectable.
  const wc = resolvedWindow.webContents;
  if (wc.isDestroyed()) {
    return;
  }
  try {
    wc.send("ui:windowState", desktopWindowStatePayload(resolvedWindow));
  } catch (error) {
    if (
      error instanceof Error &&
      /render frame was disposed/i.test(error.message)
    ) {
      return;
    }
    throw error;
  }
}

function runtimeModelProxyApiKeyFromConfig(
  config: Record<string, string>,
): string {
  return (config.model_proxy_api_key || config.auth_token || "").trim();
}

function runtimeBindingModelProxyApiKey(
  binding: RuntimeBindingExchangePayload,
): string {
  return (binding.model_proxy_api_key || binding.auth_token || "").trim();
}

function runtimeConfigHasBindingMaterial(
  config: Record<string, string>,
): boolean {
  return (
    Boolean(runtimeModelProxyApiKeyFromConfig(config)) &&
    Boolean((config.user_id || "").trim()) &&
    Boolean((config.sandbox_id || "").trim()) &&
    Boolean((config.model_proxy_base_url || "").trim())
  );
}

function canUsePersistedRuntimeBindingWithoutAuth(
  config: Record<string, string>,
): boolean {
  if (process.env.HOLABOSS_INTERNAL_DEV?.trim() !== "1") {
    return false;
  }
  return runtimeConfigHasBindingMaterial(config);
}

async function writeRuntimeConfigFile(update: RuntimeConfigUpdatePayload) {
  const next = await withRuntimeConfigMutationLock(async () => {
    const current = await readRuntimeConfigFile();
    const currentDocument = await readRuntimeConfigDocument();
    const runtimePayload = runtimeConfigObject(currentDocument.runtime);
    const providersPayload = runtimeConfigObject(currentDocument.providers);
    const integrationsPayload = runtimeConfigObject(
      currentDocument.integrations,
    );
    const holabossIntegration = runtimeConfigObject(
      integrationsPayload.holaboss,
    );
    const holabossProvider = runtimeConfigObject(
      providersPayload[RUNTIME_HOLABOSS_PROVIDER_ID],
    );
    const next = { ...current };
    const entries: Array<[keyof RuntimeConfigUpdatePayload, string]> = [
      ["authToken", "auth_token"],
      ["modelProxyApiKey", "model_proxy_api_key"],
      ["userId", "user_id"],
      ["sandboxId", "sandbox_id"],
      ["modelProxyBaseUrl", "model_proxy_base_url"],
      ["defaultModel", "default_model"],
      ["subagentModel", "subagent_model"],
      ["defaultProvider", "default_provider"],
      ["controlPlaneBaseUrl", "control_plane_base_url"],
    ];

    for (const [inputKey, fileKey] of entries) {
      const value = update[inputKey];
      if (value === undefined) {
        continue;
      }
      const normalized = typeof value === "string" ? value.trim() : "";
      if (normalized) {
        next[fileKey] = normalized;
      } else {
        delete next[fileKey];
      }
    }

    const modelProxyApiKey = runtimeModelProxyApiKeyFromConfig(next);
    const managedDefaultBackgroundModel = normalizeRuntimeHolabossCatalogDefaultModelId(
      update.defaultBackgroundModel,
    );
    const managedDefaultEmbeddingModel = normalizeRuntimeHolabossCatalogDefaultModelId(
      update.defaultEmbeddingModel,
    );
    const managedDefaultImageModel = normalizeRuntimeHolabossCatalogDefaultModelId(
      update.defaultImageModel,
    );
    if (modelProxyApiKey) {
      next.auth_token = modelProxyApiKey;
      next.model_proxy_api_key = modelProxyApiKey;
    } else {
      delete next.auth_token;
      delete next.model_proxy_api_key;
    }

    const assignOrDelete = (
      target: Record<string, unknown>,
      key: string,
      value: string | undefined,
    ) => {
      const normalized = runtimeConfigField(value);
      if (normalized) {
        target[key] = normalized;
      } else {
        delete target[key];
      }
    };

    assignOrDelete(holabossIntegration, "auth_token", next.auth_token);
    assignOrDelete(holabossIntegration, "user_id", next.user_id);
    assignOrDelete(holabossIntegration, "sandbox_id", next.sandbox_id);
    assignOrDelete(holabossProvider, "api_key", next.auth_token);
    assignOrDelete(holabossProvider, "base_url", next.model_proxy_base_url);
    assignOrDelete(runtimePayload, "sandbox_id", next.sandbox_id);
    assignOrDelete(runtimePayload, "default_model", next.default_model);
    assignOrDelete(runtimePayload, "default_provider", next.default_provider);
    const currentSubagents = runtimeConfigObject(
      runtimePayload.subagents ?? runtimePayload.subAgents,
    );
    assignOrDelete(currentSubagents, "model", next.subagent_model);
    const currentBackgroundTasks = runtimeConfigObject(
      runtimePayload.background_tasks ?? runtimePayload.backgroundTasks,
    );
    const currentBackgroundProviderId = canonicalRuntimeProviderId(
      runtimeFirstNonEmptyString(
        currentBackgroundTasks.provider as string | undefined,
        currentBackgroundTasks.provider_id as string | undefined,
        currentBackgroundTasks.providerId as string | undefined,
      ),
    );
    const currentBackgroundModel = runtimeFirstNonEmptyString(
      currentBackgroundTasks.model as string | undefined,
      currentBackgroundTasks.model_id as string | undefined,
      currentBackgroundTasks.modelId as string | undefined,
    );
    const currentImageGeneration = runtimeConfigObject(
      runtimePayload.image_generation ?? runtimePayload.imageGeneration,
    );
    const currentRecallEmbeddings = runtimeConfigObject(
      runtimePayload.recall_embeddings ?? runtimePayload.recallEmbeddings,
    );
    const currentImageGenerationProviderId = canonicalRuntimeProviderId(
      runtimeFirstNonEmptyString(
        currentImageGeneration.provider as string | undefined,
        currentImageGeneration.provider_id as string | undefined,
        currentImageGeneration.providerId as string | undefined,
      ),
    );
    const currentImageGenerationModel = runtimeFirstNonEmptyString(
      currentImageGeneration.model as string | undefined,
      currentImageGeneration.model_id as string | undefined,
      currentImageGeneration.modelId as string | undefined,
    );
    const currentRecallEmbeddingsProviderId = canonicalRuntimeProviderId(
      runtimeFirstNonEmptyString(
        currentRecallEmbeddings.provider as string | undefined,
        currentRecallEmbeddings.provider_id as string | undefined,
        currentRecallEmbeddings.providerId as string | undefined,
      ),
    );
    const currentRecallEmbeddingsModel = runtimeFirstNonEmptyString(
      currentRecallEmbeddings.model as string | undefined,
      currentRecallEmbeddings.model_id as string | undefined,
      currentRecallEmbeddings.modelId as string | undefined,
    );
    delete runtimePayload.backgroundTasks;
    delete runtimePayload.recallEmbeddings;
    delete runtimePayload.imageGeneration;
    delete runtimePayload.subAgents;
    if (Object.keys(currentSubagents).length > 0) {
      runtimePayload.subagents = currentSubagents;
    } else {
      delete runtimePayload.subagents;
    }
    if (
      managedDefaultBackgroundModel &&
      runtimeModelProxyApiKeyFromConfig(next) &&
      runtimeConfigField(next.model_proxy_base_url) &&
      (Object.keys(currentBackgroundTasks).length === 0 ||
        (isHolabossProviderAlias(currentBackgroundProviderId) &&
          !currentBackgroundModel))
    ) {
      runtimePayload.background_tasks = {
        provider: RUNTIME_HOLABOSS_PROVIDER_ID,
        model: managedDefaultBackgroundModel,
      };
    } else if (Object.keys(currentBackgroundTasks).length > 0) {
      runtimePayload.background_tasks = currentBackgroundTasks;
    }
    if (
      managedDefaultEmbeddingModel &&
      runtimeModelProxyApiKeyFromConfig(next) &&
      runtimeConfigField(next.model_proxy_base_url) &&
      (
        Object.keys(currentRecallEmbeddings).length === 0 ||
        (isHolabossProviderAlias(currentRecallEmbeddingsProviderId) &&
          !currentRecallEmbeddingsModel)
      )
    ) {
      runtimePayload.recall_embeddings = {
        provider: RUNTIME_HOLABOSS_PROVIDER_ID,
        model: managedDefaultEmbeddingModel,
      };
    } else if (Object.keys(currentRecallEmbeddings).length > 0) {
      runtimePayload.recall_embeddings = currentRecallEmbeddings;
    }
    if (
      managedDefaultImageModel &&
      runtimeModelProxyApiKeyFromConfig(next) &&
      runtimeConfigField(next.model_proxy_base_url) &&
      (Object.keys(currentImageGeneration).length === 0 ||
        (isHolabossProviderAlias(currentImageGenerationProviderId) &&
          !currentImageGenerationModel))
    ) {
      runtimePayload.image_generation = {
        provider: RUNTIME_HOLABOSS_PROVIDER_ID,
        model: managedDefaultImageModel,
      };
    } else if (Object.keys(currentImageGeneration).length > 0) {
      runtimePayload.image_generation = currentImageGeneration;
    }

    if (
      Object.keys(holabossProvider).length > 0 &&
      !runtimeConfigField(holabossProvider.kind as string | undefined)
    ) {
      holabossProvider.kind = RUNTIME_PROVIDER_KIND_HOLABOSS_PROXY;
    }
    if (Object.keys(holabossIntegration).length > 0) {
      integrationsPayload.holaboss = holabossIntegration;
    } else {
      delete integrationsPayload.holaboss;
    }
    if (Object.keys(holabossProvider).length > 0) {
      providersPayload[RUNTIME_HOLABOSS_PROVIDER_ID] = holabossProvider;
    } else {
      delete providersPayload[RUNTIME_HOLABOSS_PROVIDER_ID];
    }

    const nextDocument = {
      ...currentDocument,
      runtime: runtimePayload,
      providers: providersPayload,
      integrations: integrationsPayload,
      holaboss: next,
    };
    await writeRuntimeConfigTextAtomically(
      `${JSON.stringify(nextDocument, null, 2)}\n`,
    );
    return next;
  });
  await syncDesktopBrowserCapabilityConfig();
  return next;
}

function runtimeConfigField(value: string | undefined): string {
  return (value || "").trim();
}

function runtimeConfigObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function runtimeFirstNonEmptyString(
  ...values: unknown[]
): string {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = value.trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function canonicalRuntimeProviderId(providerId: string): string {
  const normalized = providerId.trim();
  if (!normalized) {
    return "";
  }
  if (
    RUNTIME_HOLABOSS_PROVIDER_ALIASES.some(
      (alias) => alias === normalized.toLowerCase(),
    )
  ) {
    return RUNTIME_HOLABOSS_PROVIDER_ID;
  }
  return normalized;
}

function canonicalRuntimeModelToken(
  providerId: string,
  token: string,
  modelId: string,
): string {
  const canonicalProviderId = canonicalRuntimeProviderId(providerId);
  const normalizedModelId = modelId.trim();
  const normalizedToken = token.trim();
  if (!canonicalProviderId) {
    return normalizedToken;
  }
  if (!normalizedToken) {
    return `${canonicalProviderId}/${normalizedModelId}`;
  }
  if (canonicalProviderId !== RUNTIME_HOLABOSS_PROVIDER_ID) {
    return normalizedToken;
  }
  if (!normalizedToken.includes("/")) {
    return normalizedToken;
  }
  const [prefix, ...rest] = normalizedToken.split("/");
  if (
    rest.length > 0 &&
    RUNTIME_HOLABOSS_PROVIDER_ALIASES.some(
      (alias) => alias === prefix.trim().toLowerCase(),
    )
  ) {
    return `${canonicalProviderId}/${rest.join("/").trim()}`;
  }
  return normalizedToken;
}

function normalizeLegacyRuntimeModelToken(token: string): string {
  return token.trim();
}

function normalizeRuntimeProviderModelId(
  providerId: string,
  modelId: string,
): string {
  const normalizedProviderId = providerId.trim().toLowerCase();
  const normalizedModelId = modelId.trim();
  if (!normalizedProviderId || !normalizedModelId) {
    return normalizedModelId;
  }
  return (
    RUNTIME_LEGACY_DIRECT_PROVIDER_MODEL_ALIASES[normalizedProviderId]?.[
      normalizedModelId
    ] ?? normalizedModelId
  );
}

function normalizeRuntimeProviderModelToken(
  providerId: string,
  token: string,
  modelId: string,
): string {
  const normalizedProviderId = canonicalRuntimeProviderId(providerId);
  const normalizedModelId = normalizeRuntimeProviderModelId(
    normalizedProviderId,
    modelId,
  );
  const normalizedToken = token.trim();
  const providerPrefix = `${normalizedProviderId}/`;
  if (!normalizedToken.startsWith(providerPrefix)) {
    return normalizedToken || providerPrefix + normalizedModelId;
  }
  return `${providerPrefix}${normalizedModelId}`;
}

function runtimeProviderLabel(providerId: string): string {
  const normalized = providerId.trim().toLowerCase();
  if (normalized === OPENAI_CODEX_PROVIDER_ID) {
    return OPENAI_CODEX_PROVIDER_LABEL;
  }
  if (normalized === "openai" || normalized.includes("openai")) {
    return "OpenAI";
  }
  if (normalized === "anthropic" || normalized.includes("anthropic")) {
    return "Anthropic";
  }
  if (normalized.includes("openrouter")) {
    return "OpenRouter";
  }
  if (normalized.includes("gemini") || normalized.includes("google")) {
    return "Gemini";
  }
  if (normalized.includes("ollama")) {
    return "Ollama";
  }
  if (normalized.includes("minimax")) {
    return "MiniMax";
  }
  if (
    normalized === RUNTIME_HOLABOSS_PROVIDER_ID ||
    normalized === "holaboss" ||
    normalized.includes("holaboss")
  ) {
    return "Holaboss Proxy";
  }
  return providerId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeRuntimeProviderKind(
  rawKind: string,
  providerId: string,
  baseUrl: string,
): string {
  const normalizedProviderId = providerId.trim().toLowerCase();
  const normalizedKind = rawKind.trim().toLowerCase();
  const normalizedBaseUrl = baseUrl.trim().toLowerCase();
  if (
    normalizedKind === RUNTIME_PROVIDER_KIND_HOLABOSS_PROXY ||
    normalizedProviderId === RUNTIME_HOLABOSS_PROVIDER_ID ||
    normalizedProviderId === "holaboss" ||
    normalizedProviderId.includes("holaboss")
  ) {
    return RUNTIME_PROVIDER_KIND_HOLABOSS_PROXY;
  }
  if (!normalizedKind && normalizedBaseUrl.includes("model-proxy")) {
    return RUNTIME_PROVIDER_KIND_HOLABOSS_PROXY;
  }
  if (
    normalizedKind === RUNTIME_PROVIDER_KIND_OPENROUTER ||
    normalizedProviderId.includes("openrouter")
  ) {
    return RUNTIME_PROVIDER_KIND_OPENROUTER;
  }
  if (
    normalizedKind === RUNTIME_PROVIDER_KIND_ANTHROPIC_NATIVE ||
    normalizedKind === "anthropic" ||
    normalizedProviderId.includes("anthropic")
  ) {
    return RUNTIME_PROVIDER_KIND_ANTHROPIC_NATIVE;
  }
  return RUNTIME_PROVIDER_KIND_OPENAI_COMPATIBLE;
}

function runtimeModelIdFromToken(token: string): string {
  const normalizedToken = token.trim();
  if (!normalizedToken) {
    return "";
  }
  if (!normalizedToken.includes("/")) {
    return normalizedToken;
  }
  const [prefix, ...rest] = normalizedToken.split("/");
  const normalizedPrefix = prefix.trim().toLowerCase();
  if (
    normalizedPrefix.includes("openai") ||
    normalizedPrefix.includes("anthropic") ||
    normalizedPrefix.includes("holaboss") ||
    normalizedPrefix.includes("openrouter") ||
    normalizedPrefix.includes("gemini") ||
    normalizedPrefix.includes("google") ||
    normalizedPrefix.includes("ollama") ||
    normalizedPrefix.includes("minimax")
  ) {
    return rest.join("/").trim();
  }
  return normalizedToken;
}

function isDeprecatedRuntimeModelId(modelId: string): boolean {
  const normalized = runtimeModelIdFromToken(modelId).toLowerCase();
  return RUNTIME_DEPRECATED_MODEL_IDS.has(normalized);
}

const RUNTIME_MODEL_CAPABILITY_ALIASES: Record<string, string> = {
  chat: "chat",
  text: "chat",
  completion: "chat",
  completions: "chat",
  responses: "chat",
  image: "image_generation",
  images: "image_generation",
  image_generation: "image_generation",
  image_gen: "image_generation",
};

function normalizeRuntimeModelCapability(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!normalized) {
    return "";
  }
  return RUNTIME_MODEL_CAPABILITY_ALIASES[normalized] ?? normalized;
}

function normalizeRuntimeModelCapabilities(rawValues: unknown[]): string[] {
  const seen = new Set<string>();
  const capabilities: string[] = [];
  for (const value of rawValues) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = normalizeRuntimeModelCapability(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    capabilities.push(normalized);
  }
  return capabilities;
}

function runtimeModelCapabilityList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeRuntimeModelThinkingValues(rawValues: unknown[]): string[] {
  const seen = new Set<string>();
  const thinkingValues: string[] = [];
  for (const value of rawValues) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    thinkingValues.push(normalized);
  }
  return thinkingValues;
}

function runtimeModelThinkingValueList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeRuntimeModelInputModality(
  value: string,
): ModelCatalogInputModality | "" {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "text":
    case "image":
    case "audio":
    case "video":
      return normalized;
    default:
      return "";
  }
}

function normalizeRuntimeModelInputModalities(
  rawValues: unknown[],
): ModelCatalogInputModality[] {
  const seen = new Set<ModelCatalogInputModality>();
  const inputModalities: ModelCatalogInputModality[] = [];
  for (const value of rawValues) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = normalizeRuntimeModelInputModality(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    inputModalities.push(normalized);
  }
  return inputModalities;
}

function runtimeModelInputModalityList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function runtimeModelMetadataFromPayload(
  providerId: string,
  modelId: string,
  payload: Record<string, unknown>,
): Partial<RuntimeProviderModelPayload> {
  const fallback = modelCatalog.catalogMetadataForProviderModel(
    providerId,
    modelId,
  );
  const label =
    runtimeFirstNonEmptyString(
      payload.label as string | undefined,
      payload.display_label as string | undefined,
      payload.displayLabel as string | undefined,
      payload.name as string | undefined,
    ) || fallback?.label;
  const explicitReasoning =
    typeof payload.reasoning === "boolean" ? payload.reasoning : undefined;
  const useFallbackReasoningMetadata = explicitReasoning !== false;
  const explicitThinkingValues = normalizeRuntimeModelThinkingValues([
    ...runtimeModelThinkingValueList(payload.thinking_values),
    ...runtimeModelThinkingValueList(payload.thinkingValues),
  ]);
  const explicitInputModalities = normalizeRuntimeModelInputModalities([
    ...runtimeModelInputModalityList(payload.input_modalities),
    ...runtimeModelInputModalityList(payload.inputModalities),
    ...runtimeModelInputModalityList(payload.input),
  ]);
  const explicitDefaultThinkingValue =
    payload.default_thinking_value === null || payload.defaultThinkingValue === null
      ? null
      : runtimeFirstNonEmptyString(
          payload.default_thinking_value as string | undefined,
          payload.defaultThinkingValue as string | undefined,
        );
  const thinkingValues =
    explicitThinkingValues.length > 0
      ? explicitThinkingValues
      : useFallbackReasoningMetadata
        ? fallback?.thinkingValues
        : [];
  const inputModalities =
    explicitInputModalities.length > 0
      ? explicitInputModalities
      : fallback?.inputModalities;
  const defaultThinkingValue =
    explicitDefaultThinkingValue !== undefined
      ? explicitDefaultThinkingValue
      : useFallbackReasoningMetadata
        ? fallback?.defaultThinkingValue
        : null;
  const reasoning = explicitReasoning ?? fallback?.reasoning;

  return {
    ...(label ? { label } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(thinkingValues !== undefined ? { thinkingValues } : {}),
    ...(defaultThinkingValue !== undefined ? { defaultThinkingValue } : {}),
    ...(inputModalities !== undefined ? { inputModalities } : {}),
  };
}

function upsertRuntimeProviderModel(
  models: Map<string, RuntimeProviderModelPayload>,
  payload: RuntimeProviderModelPayload,
): void {
  const existing = models.get(payload.token);
  const mergedCapabilities = normalizeRuntimeModelCapabilities([
    ...(Array.isArray(existing?.capabilities) ? existing.capabilities : []),
    ...(Array.isArray(payload.capabilities) ? payload.capabilities : []),
  ]);
  models.set(payload.token, {
    token: payload.token,
    modelId: payload.modelId,
    ...(payload.label?.trim() || existing?.label
      ? { label: payload.label?.trim() || existing?.label }
      : {}),
    ...(payload.reasoning !== undefined
      ? { reasoning: payload.reasoning }
      : existing?.reasoning !== undefined
        ? { reasoning: existing.reasoning }
        : {}),
    ...(payload.thinkingValues !== undefined
      ? { thinkingValues: [...payload.thinkingValues] }
      : existing?.thinkingValues !== undefined
        ? { thinkingValues: [...existing.thinkingValues] }
        : {}),
    ...(payload.defaultThinkingValue !== undefined
      ? { defaultThinkingValue: payload.defaultThinkingValue }
      : existing?.defaultThinkingValue !== undefined
        ? { defaultThinkingValue: existing.defaultThinkingValue }
        : {}),
    ...(payload.inputModalities !== undefined
      ? { inputModalities: [...payload.inputModalities] }
      : existing?.inputModalities !== undefined
        ? { inputModalities: [...existing.inputModalities] }
        : {}),
    ...(mergedCapabilities.length > 0
      ? { capabilities: mergedCapabilities }
      : {}),
  });
}

function normalizeRuntimeProviderModelGroups(
  rawGroups: unknown[],
): RuntimeProviderModelGroupPayload[] {
  const providers = new Map<string, { label: string; kind: string }>();
  const groupedModels = new Map<
    string,
    Map<string, RuntimeProviderModelPayload>
  >();
  const ensureProviderGroup = (providerId: string) => {
    if (!groupedModels.has(providerId)) {
      groupedModels.set(
        providerId,
        new Map<string, RuntimeProviderModelPayload>(),
      );
    }
    return groupedModels.get(providerId)!;
  };

  for (const rawGroup of rawGroups) {
    const groupPayload = runtimeConfigObject(rawGroup);
    const providerId = canonicalRuntimeProviderId(
      runtimeFirstNonEmptyString(
        groupPayload.providerId as string | undefined,
        groupPayload.provider_id as string | undefined,
      ),
    );
    if (!providerId) {
      continue;
    }

    providers.set(providerId, {
      label:
        runtimeFirstNonEmptyString(
          groupPayload.providerLabel as string | undefined,
          groupPayload.provider_label as string | undefined,
        ) || runtimeProviderLabel(providerId),
      kind: normalizeRuntimeProviderKind(
        runtimeFirstNonEmptyString(
          groupPayload.kind as string | undefined,
          groupPayload.provider_kind as string | undefined,
        ),
        providerId,
        "",
      ),
    });

    const models = Array.isArray(groupPayload.models)
      ? groupPayload.models
      : [];
    for (const rawModel of models) {
      const modelPayload = runtimeConfigObject(rawModel);
      const modelId = normalizeRuntimeProviderModelId(
        providerId,
        runtimeFirstNonEmptyString(
          modelPayload.modelId as string | undefined,
          modelPayload.model_id as string | undefined,
          runtimeModelIdFromToken(
            runtimeFirstNonEmptyString(
              modelPayload.token as string | undefined,
              modelPayload.model_token as string | undefined,
            ),
          ),
        ),
      );
      if (
        !modelId ||
        isDeprecatedRuntimeModelId(modelId)
      ) {
        continue;
      }
      const token = canonicalRuntimeModelToken(
        providerId,
        normalizeRuntimeProviderModelToken(
          providerId,
          runtimeFirstNonEmptyString(
            modelPayload.token as string | undefined,
            modelPayload.model_token as string | undefined,
          ),
          modelId,
        ),
        modelId,
      );
      const capabilities = normalizeRuntimeModelCapabilities([
        ...runtimeModelCapabilityList(modelPayload.capabilities),
        ...runtimeModelCapabilityList(modelPayload.model_capabilities),
        ...runtimeModelCapabilityList(modelPayload.modalities),
        ...runtimeModelCapabilityList(modelPayload.model_modalities),
      ]);
      const metadata = runtimeModelMetadataFromPayload(
        providerId,
        modelId,
        modelPayload,
      );
      upsertRuntimeProviderModel(ensureProviderGroup(providerId), {
        token,
        modelId,
        ...metadata,
        ...(capabilities.length > 0 ? { capabilities } : {}),
      });
    }
  }

  const groups: RuntimeProviderModelGroupPayload[] = [];
  for (const [providerId, provider] of providers.entries()) {
    const models = Array.from(ensureProviderGroup(providerId).values());
    if (models.length === 0) {
      continue;
    }
    groups.push({
      providerId,
      providerLabel: provider.label,
      kind: provider.kind,
      models,
    });
  }
  return groups;
}

function normalizeRuntimeHolabossCatalogDefaultModelId(
  value: string | null | undefined,
): string {
  const normalized = runtimeFirstNonEmptyString(value);
  if (!normalized) {
    return "";
  }
  const modelId = normalizeRuntimeProviderModelId(
    RUNTIME_HOLABOSS_PROVIDER_ID,
    runtimeModelIdFromToken(normalized),
  );
  if (
    !modelId ||
    isDeprecatedRuntimeModelId(modelId)
  ) {
    return "";
  }
  return modelId;
}

function runtimeProviderModelGroups(
  document: Record<string, unknown>,
  _loadedLegacy: Record<string, string>,
  managedCatalogGroups: RuntimeProviderModelGroupPayload[],
): RuntimeProviderModelGroupPayload[] {
  const providersPayload = runtimeConfigObject(document.providers);
  const modelsPayload = runtimeConfigObject(document.models);
  const providers = new Map<
    string,
    { id: string; kind: string; label: string }
  >();
  const groupedModels = new Map<
    string,
    Map<string, RuntimeProviderModelPayload>
  >();
  const ensureProviderGroup = (providerId: string) => {
    if (!groupedModels.has(providerId)) {
      groupedModels.set(
        providerId,
        new Map<string, RuntimeProviderModelPayload>(),
      );
    }
    return groupedModels.get(providerId)!;
  };
  const addModel = (
    providerId: string,
    token: string,
    modelId: string,
    capabilities?: string[],
    metadata?: Partial<RuntimeProviderModelPayload>,
  ) => {
    const normalizedProviderId = canonicalRuntimeProviderId(providerId);
    const normalizedModelId = normalizeRuntimeProviderModelId(
      normalizedProviderId,
      modelId,
    );
    if (
      !normalizedProviderId ||
      !normalizedModelId ||
      isDeprecatedRuntimeModelId(normalizedModelId)
    ) {
      return;
    }
    const normalizedToken = canonicalRuntimeModelToken(
      normalizedProviderId,
      normalizeRuntimeProviderModelToken(
        normalizedProviderId,
        token,
        normalizedModelId,
      ),
      normalizedModelId,
    );
    if (isDeprecatedRuntimeModelId(normalizedToken)) {
      return;
    }
    const group = ensureProviderGroup(normalizedProviderId);
    upsertRuntimeProviderModel(group, {
      token: normalizedToken,
      modelId: normalizedModelId,
      ...(metadata ?? {}),
      ...(Array.isArray(capabilities) && capabilities.length > 0
        ? { capabilities }
        : {}),
    });
  };
  const mergeManagedCatalog = (groups: RuntimeProviderModelGroupPayload[]) => {
    for (const group of groups) {
      const providerId = canonicalRuntimeProviderId(group.providerId);
      if (!providerId) {
        continue;
      }
      if (!providers.has(providerId)) {
        providers.set(providerId, {
          id: providerId,
          kind: normalizeRuntimeProviderKind(group.kind, providerId, ""),
          label: group.providerLabel || runtimeProviderLabel(providerId),
        });
      }
      for (const model of group.models) {
        addModel(
          providerId,
          model.token,
          model.modelId,
          Array.isArray(model.capabilities) ? model.capabilities : [],
          {
            ...(model.label ? { label: model.label } : {}),
            ...(model.reasoning !== undefined
              ? { reasoning: model.reasoning }
              : {}),
            ...(model.thinkingValues !== undefined
              ? { thinkingValues: [...model.thinkingValues] }
              : {}),
            ...(model.defaultThinkingValue !== undefined
              ? { defaultThinkingValue: model.defaultThinkingValue }
              : {}),
            ...(model.inputModalities !== undefined
              ? { inputModalities: [...model.inputModalities] }
              : {}),
          },
        );
      }
    }
  };

  mergeManagedCatalog(managedCatalogGroups);

  for (const [providerId, rawProvider] of Object.entries(providersPayload)) {
    const canonicalProviderId = canonicalRuntimeProviderId(providerId);
    if (isHolabossProviderAlias(canonicalProviderId)) {
      continue;
    }
    const providerPayload = runtimeConfigObject(rawProvider);
    const optionsPayload = runtimeConfigObject(providerPayload.options);
    const baseUrl = runtimeFirstNonEmptyString(
      providerPayload.base_url as string | undefined,
      providerPayload.baseURL as string | undefined,
      optionsPayload.baseURL as string | undefined,
      optionsPayload.base_url as string | undefined,
    );
    const kind = normalizeRuntimeProviderKind(
      runtimeFirstNonEmptyString(
        providerPayload.kind as string | undefined,
        providerPayload.type as string | undefined,
        optionsPayload.kind as string | undefined,
      ),
      canonicalProviderId,
      baseUrl,
    );
    providers.set(canonicalProviderId, {
      id: canonicalProviderId,
      kind,
      label: runtimeProviderLabel(canonicalProviderId),
    });
  }

  for (const [token, rawModel] of Object.entries(modelsPayload)) {
    const modelPayload = runtimeConfigObject(rawModel);
    let providerId = runtimeFirstNonEmptyString(
      modelPayload.provider_id as string | undefined,
      modelPayload.provider as string | undefined,
    );
    let modelId = runtimeFirstNonEmptyString(
      modelPayload.model_id as string | undefined,
      modelPayload.model as string | undefined,
    );
    if (!providerId && token.includes("/")) {
      const [prefix, ...rest] = token.split("/");
      const normalizedPrefix = canonicalRuntimeProviderId(prefix);
      if (providers.has(normalizedPrefix) && rest.length > 0) {
        providerId = normalizedPrefix;
        modelId = modelId || rest.join("/");
      }
    }
    if (providerId && modelId) {
      const normalizedProviderId = canonicalRuntimeProviderId(providerId);
      if (isHolabossProviderAlias(normalizedProviderId)) {
        continue;
      }
      if (providers.has(normalizedProviderId)) {
        addModel(
          normalizedProviderId,
          token,
          modelId,
          undefined,
          runtimeModelMetadataFromPayload(
            normalizedProviderId,
            modelId,
            modelPayload,
          ),
        );
      }
    }
  }

  const groups: RuntimeProviderModelGroupPayload[] = [];
  const providerIds = new Set<string>([
    ...Array.from(providers.keys()),
    ...Array.from(groupedModels.keys()),
  ]);
  for (const providerId of providerIds) {
    const modelMap =
      groupedModels.get(providerId) ??
      new Map<string, RuntimeProviderModelPayload>();
    const provider = providers.get(providerId);
    if (modelMap.size === 0) {
      continue;
    }
    groups.push({
      providerId,
      providerLabel: provider?.label ?? runtimeProviderLabel(providerId),
      kind: provider?.kind ?? normalizeRuntimeProviderKind("", providerId, ""),
      models: Array.from(modelMap.values()),
    });
  }
  return groups;
}

function isHolabossProviderAlias(providerId: string): boolean {
  const normalized = providerId.trim().toLowerCase();
  return RUNTIME_HOLABOSS_PROVIDER_ALIASES.some(
    (alias) => alias === normalized,
  );
}

function runtimeModelCatalogPayloadFromResponse(
  payload:
    | RuntimeModelCatalogResponsePayload
    | RuntimeBindingExchangePayload
    | null
    | undefined,
): RuntimeModelCatalogPayload {
  return {
    catalogVersion:
      runtimeConfigField(payload?.catalog_version as string | undefined) ||
      null,
    defaultBackgroundModel:
      normalizeRuntimeHolabossCatalogDefaultModelId(
        runtimeConfigField(
          payload?.default_background_model as string | undefined,
        ) || "",
      ) || null,
    defaultEmbeddingModel:
      normalizeRuntimeHolabossCatalogDefaultModelId(
        runtimeConfigField(
          payload?.default_embedding_model as string | undefined,
        ) || "",
      ) || null,
    defaultImageModel:
      normalizeRuntimeHolabossCatalogDefaultModelId(
        runtimeConfigField(
          payload?.default_image_model as string | undefined,
        ) || "",
      ) || null,
    providerModelGroups: normalizeRuntimeProviderModelGroups(
      Array.isArray(payload?.provider_model_groups)
        ? payload.provider_model_groups
        : [],
    ),
    fetchedAt: utcNowIso(),
  };
}

async function syncRuntimeModelCatalogFromBinding(
  binding: RuntimeBindingExchangePayload,
): Promise<void> {
  const payload = runtimeModelCatalogPayloadFromResponse(binding);
  if (
    payload.catalogVersion ||
    payload.defaultBackgroundModel ||
    payload.defaultEmbeddingModel ||
    payload.defaultImageModel ||
    payload.providerModelGroups.length > 0
  ) {
    await persistRuntimeModelCatalog(payload);
    return;
  }
  await refreshRuntimeModelCatalogIfNeeded({ force: true }).catch(
    () => undefined,
  );
}

async function persistRuntimeModelCatalog(
  payload: RuntimeModelCatalogPayload,
): Promise<void> {
  runtimeModelCatalogState = payload;
  lastRuntimeModelCatalogRefreshAtMs = Date.now();
  lastRuntimeModelCatalogRefreshFailureAtMs = 0;
  await writeJsonFile(runtimeModelCatalogCachePath(), {
    catalogVersion: payload.catalogVersion,
    defaultBackgroundModel: payload.defaultBackgroundModel,
    defaultEmbeddingModel: payload.defaultEmbeddingModel,
    defaultImageModel: payload.defaultImageModel,
    providerModelGroups: payload.providerModelGroups,
    fetchedAt: payload.fetchedAt,
  });
}

async function clearRuntimeModelCatalog(): Promise<void> {
  runtimeModelCatalogState = {
    catalogVersion: null,
    defaultBackgroundModel: null,
    defaultEmbeddingModel: null,
    defaultImageModel: null,
    providerModelGroups: [],
    fetchedAt: null,
  };
  lastRuntimeModelCatalogRefreshAtMs = 0;
  lastRuntimeModelCatalogRefreshFailureAtMs = 0;
  try {
    await fs.rm(runtimeModelCatalogCachePath(), { force: true });
  } catch {
    // ignore cache cleanup errors
  }
}

async function withRuntimeModelCatalogRefreshLock<T>(
  work: () => Promise<T>,
): Promise<T> {
  while (runtimeModelCatalogRefreshPromise) {
    await runtimeModelCatalogRefreshPromise;
  }

  let releaseLock = () => {};
  runtimeModelCatalogRefreshPromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  try {
    return await work();
  } finally {
    releaseLock();
    runtimeModelCatalogRefreshPromise = null;
  }
}

function shouldRefreshRuntimeModelCatalog(force = false): boolean {
  if (force) {
    return true;
  }
  if (runtimeModelCatalogState.providerModelGroups.length === 0) {
    return true;
  }
  if (
    !runtimeModelCatalogState.defaultBackgroundModel ||
    !runtimeModelCatalogState.defaultEmbeddingModel ||
    !runtimeModelCatalogState.defaultImageModel
  ) {
    return true;
  }
  return (
    Date.now() - lastRuntimeModelCatalogRefreshAtMs >
    RUNTIME_MODEL_CATALOG_REFRESH_INTERVAL_MS
  );
}

function hasRecentRuntimeModelCatalogRefreshFailure(): boolean {
  return (
    lastRuntimeModelCatalogRefreshFailureAtMs > 0 &&
    Date.now() - lastRuntimeModelCatalogRefreshFailureAtMs <
      RUNTIME_MODEL_CATALOG_REFRESH_FAILURE_BACKOFF_MS
  );
}

async function fetchDesktopRuntimeModelCatalog(): Promise<RuntimeModelCatalogResponsePayload> {
  const controlPlaneBaseUrl = requireControlPlaneBaseUrl();
  const cookieHeader = authCookieHeader();
  if (!cookieHeader) {
    throw new Error("Better Auth session cookies are missing.");
  }

  const catalogUrl = `${controlPlaneBaseUrl}${DESKTOP_RUNTIME_MODEL_CATALOG_PATH}`;
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, RUNTIME_MODEL_CATALOG_FETCH_TIMEOUT_MS);
  timeout.unref();
  try {
    response = await fetch(catalogUrl, {
      method: "GET",
      headers: {
        Cookie: cookieHeader,
      },
      signal: controller.signal,
    });
  } catch (error) {
    const detail =
      controller.signal.aborted &&
      error instanceof Error &&
      error.name === "AbortError"
        ? `timed out after ${RUNTIME_MODEL_CATALOG_FETCH_TIMEOUT_MS}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(
      `Runtime model catalog request failed for ${catalogUrl}: ${detail}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      detail ||
        `Runtime model catalog request failed with status ${response.status}`,
    );
  }

  return response.json() as Promise<RuntimeModelCatalogResponsePayload>;
}

async function refreshRuntimeModelCatalogIfNeeded(options?: {
  force?: boolean;
}): Promise<RuntimeModelCatalogPayload> {
  if (!DESKTOP_CONTROL_PLANE_BASE_URL) {
    return runtimeModelCatalogState;
  }
  if (!authCookieHeader()) {
    return runtimeModelCatalogState;
  }
  if (!shouldRefreshRuntimeModelCatalog(Boolean(options?.force))) {
    let didSyncDefaults = false;
    if (await syncManagedHolabossDefaultsToRuntimeConfigIfNeeded()) {
      didSyncDefaults = true;
    }
    if (await syncOpenAiCodexDefaultsToRuntimeConfigIfNeeded()) {
      didSyncDefaults = true;
    }
    if (didSyncDefaults) {
      await emitRuntimeConfig();
    }
    return runtimeModelCatalogState;
  }
  if (!options?.force && hasRecentRuntimeModelCatalogRefreshFailure()) {
    let didSyncDefaults = false;
    if (await syncManagedHolabossDefaultsToRuntimeConfigIfNeeded()) {
      didSyncDefaults = true;
    }
    if (await syncOpenAiCodexDefaultsToRuntimeConfigIfNeeded()) {
      didSyncDefaults = true;
    }
    if (didSyncDefaults) {
      await emitRuntimeConfig();
    }
    return runtimeModelCatalogState;
  }

  try {
    await withRuntimeModelCatalogRefreshLock(async () => {
      if (!shouldRefreshRuntimeModelCatalog(Boolean(options?.force))) {
        return;
      }
      const payload = runtimeModelCatalogPayloadFromResponse(
        await fetchDesktopRuntimeModelCatalog(),
      );
      await persistRuntimeModelCatalog(payload);
      let didSyncDefaults = false;
      if (await syncManagedHolabossDefaultsToRuntimeConfigIfNeeded(payload)) {
        didSyncDefaults = true;
      }
      if (await syncOpenAiCodexDefaultsToRuntimeConfigIfNeeded()) {
        didSyncDefaults = true;
      }
      if (didSyncDefaults) {
        await emitRuntimeConfig();
      }
    });
  } catch (error) {
    lastRuntimeModelCatalogRefreshFailureAtMs = Date.now();
    if (runtimeModelCatalogState.providerModelGroups.length === 0) {
      throw error;
    }
  }

  return runtimeModelCatalogState;
}

async function getRuntimeConfigSnapshot(
  managedCatalog: RuntimeModelCatalogPayload = runtimeModelCatalogState,
): Promise<RuntimeConfigPayload> {
  const configPath = runtimeConfigPath();
  const loaded = await readRuntimeConfigFile();
  const document = await readRuntimeConfigDocument();
  return {
    configPath,
    loadedFromFile:
      Object.keys(document).length > 0 || Object.keys(loaded).length > 0,
    authTokenPresent: Boolean(runtimeModelProxyApiKeyFromConfig(loaded)),
    userId: loaded.user_id ?? null,
    sandboxId: loaded.sandbox_id ?? null,
    modelProxyBaseUrl: loaded.model_proxy_base_url ?? null,
    defaultModel: loaded.default_model ?? null,
    subagentModel: loaded.subagent_model ?? null,
    defaultBackgroundModel: managedCatalog.defaultBackgroundModel,
    defaultEmbeddingModel: managedCatalog.defaultEmbeddingModel,
    defaultImageModel: managedCatalog.defaultImageModel,
    controlPlaneBaseUrl: loaded.control_plane_base_url ?? null,
    catalogVersion: managedCatalog.catalogVersion,
    providerModelGroups: runtimeProviderModelGroups(
      document,
      loaded,
      managedCatalog.providerModelGroups,
    ),
  };
}

function refreshRuntimeModelCatalogInBackground(): void {
  void refreshRuntimeModelCatalogIfNeeded()
    .then(async () => {
      await emitRuntimeConfig();
    })
    .catch(() => undefined);
}

async function syncManagedHolabossDefaultsToRuntimeConfigIfNeeded(
  managedCatalog: RuntimeModelCatalogPayload = runtimeModelCatalogState,
): Promise<boolean> {
  const currentConfig = await readRuntimeConfigFile();
  const currentDocument = await readRuntimeConfigDocument();
  if (
    !runtimeBindingNeedsManagedHolabossDefaultsRefresh(
      currentConfig,
      currentDocument,
    )
  ) {
    return false;
  }

  await writeRuntimeConfigFile({
    defaultBackgroundModel: managedCatalog.defaultBackgroundModel,
    defaultEmbeddingModel: managedCatalog.defaultEmbeddingModel,
    defaultImageModel: managedCatalog.defaultImageModel,
  });
  return true;
}

async function syncOpenAiCodexDefaultsToRuntimeConfigIfNeeded(): Promise<boolean> {
  const currentDocument = await readRuntimeConfigDocument();
  const state = openAiCodexProviderStateFromDocument(currentDocument);
  if (
    state.authMode !== "codex_oauth" &&
    Object.keys(state.providerPayload).length === 0
  ) {
    return false;
  }
  const nextDocument = withProviderDefaultModels(
    currentDocument,
    OPENAI_CODEX_PROVIDER_ID,
    OPENAI_CODEX_DEFAULT_MODELS,
  );
  const currentText =
    Object.keys(currentDocument).length > 0
      ? `${JSON.stringify(currentDocument, null, 2)}\n`
      : "";
  const nextText = `${JSON.stringify(nextDocument, null, 2)}\n`;
  if (currentText === nextText) {
    return false;
  }
  await writeRuntimeConfigTextAtomically(nextText);
  return true;
}

function runtimeConfigRestartRequired(
  current: Record<string, string>,
  next: Record<string, string>,
): boolean {
  for (const key of [
    "auth_token",
    "model_proxy_api_key",
    "user_id",
    "sandbox_id",
    "model_proxy_base_url",
    "default_model",
    "control_plane_base_url",
  ] as const) {
    if (runtimeConfigField(current[key]) !== runtimeConfigField(next[key])) {
      return true;
    }
  }
  return false;
}

function normalizeDeferredRuntimeRestartReason(reason: string): string {
  const normalized = reason.trim();
  return normalized || "unspecified";
}

function listRuntimeRestartBlockingSessions(): Array<{
  workspaceId: string;
  sessionId: string;
  status: string;
  currentInputId: string | null;
}> {
  const databases = openWorkspaceRuntimeDiagnosticsDatabases();
  try {
    const rows = databases.flatMap((database) =>
      database.prepare(
        `
        SELECT
          workspace_id,
          session_id,
          status,
          current_input_id
        FROM session_runtime_state
        WHERE status IN ('BUSY', 'QUEUED')
           OR current_input_id IS NOT NULL
      `,
      ).all() as Array<{
      workspace_id: string;
      session_id: string;
      status: string;
      current_input_id: string | null;
    }>);
    return rows
      .map((row) => ({
        workspaceId: row.workspace_id.trim(),
        sessionId: row.session_id.trim(),
        status: row.status.trim(),
        currentInputId:
          typeof row.current_input_id === "string" &&
          row.current_input_id.trim()
            ? row.current_input_id.trim()
            : null,
      }))
      .filter((row) => row.workspaceId && row.sessionId);
  } finally {
    closeRuntimeDatabases(databases);
  }
}

function runtimeRestartBlockerDetail(
  blockers: Array<{
    workspaceId: string;
    sessionId: string;
    status: string;
    currentInputId: string | null;
  }>,
): string {
  return blockers
    .map((blocker) =>
      [
        blocker.workspaceId,
        blocker.sessionId,
        blocker.status,
        blocker.currentInputId ?? "-",
      ].join(":"),
    )
    .join(",");
}

function clearDeferredRuntimeRestartWatcher(): void {
  if (!deferredRuntimeRestartTimer) {
    return;
  }
  clearInterval(deferredRuntimeRestartTimer);
  deferredRuntimeRestartTimer = null;
}

async function maybeRunDeferredRuntimeRestart(): Promise<boolean> {
  const reason = deferredRuntimeRestartReason;
  if (!reason || deferredRuntimeRestartInFlight) {
    return false;
  }
  const healthy = await isRuntimeHealthy(runtimeBaseUrl());
  const blockers = healthy ? listRuntimeRestartBlockingSessions() : [];
  if (blockers.length > 0) {
    return false;
  }

  deferredRuntimeRestartInFlight = true;
  deferredRuntimeRestartReason = null;
  clearDeferredRuntimeRestartWatcher();
  appendRuntimeEventLog({
    category: "runtime",
    event: "embedded_runtime.restart_resumed",
    outcome: "start",
    detail: `reason=${normalizeDeferredRuntimeRestartReason(reason)}`,
  });
  try {
    await stopEmbeddedRuntime();
    void startEmbeddedRuntime();
    return true;
  } finally {
    deferredRuntimeRestartInFlight = false;
  }
}

function ensureDeferredRuntimeRestartWatcher(): void {
  if (deferredRuntimeRestartTimer) {
    return;
  }
  deferredRuntimeRestartTimer = setInterval(() => {
    void maybeRunDeferredRuntimeRestart();
  }, DEFERRED_RUNTIME_RESTART_POLL_MS);
  deferredRuntimeRestartTimer.unref();
}

async function restartEmbeddedRuntimeSafely(
  reason: string,
): Promise<"restarted" | "deferred"> {
  const normalizedReason = normalizeDeferredRuntimeRestartReason(reason);
  const healthy = await isRuntimeHealthy(runtimeBaseUrl());
  const blockers = healthy ? listRuntimeRestartBlockingSessions() : [];
  if (blockers.length > 0) {
    deferredRuntimeRestartReason = normalizedReason;
    ensureDeferredRuntimeRestartWatcher();
    appendRuntimeEventLog({
      category: "runtime",
      event: "embedded_runtime.restart_deferred",
      outcome: "deferred",
      detail: `reason=${normalizedReason} blockers=${runtimeRestartBlockerDetail(blockers)}`,
    });
    return "deferred";
  }

  deferredRuntimeRestartReason = null;
  clearDeferredRuntimeRestartWatcher();
  await stopEmbeddedRuntime();
  void startEmbeddedRuntime();
  return "restarted";
}

async function restartEmbeddedRuntimeIfNeeded(
  current: Record<string, string>,
  next: Record<string, string>,
  reason = "runtime_config_update",
): Promise<boolean> {
  if (!runtimeConfigRestartRequired(current, next)) {
    return false;
  }
  await restartEmbeddedRuntimeSafely(reason);
  return true;
}

function withRuntimeLifecycleLock<T>(work: () => Promise<T>): Promise<T> {
  const run = runtimeLifecycleChain.then(work, work);
  runtimeLifecycleChain = run.then(() => undefined).catch(() => undefined);
  return run;
}

async function withRuntimeBindingRefreshLock<T>(
  work: () => Promise<T>,
): Promise<T> {
  while (runtimeBindingRefreshPromise) {
    await runtimeBindingRefreshPromise;
  }

  let releaseLock = () => {};
  runtimeBindingRefreshPromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  try {
    return await work();
  } finally {
    releaseLock();
    runtimeBindingRefreshPromise = null;
  }
}

async function withRuntimeConfigMutationLock<T>(
  work: () => Promise<T>,
): Promise<T> {
  while (runtimeConfigMutationPromise) {
    await runtimeConfigMutationPromise;
  }

  let releaseLock = () => {};
  runtimeConfigMutationPromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  try {
    return await work();
  } finally {
    releaseLock();
    runtimeConfigMutationPromise = null;
  }
}

async function getRuntimeConfig(): Promise<RuntimeConfigPayload> {
  refreshRuntimeModelCatalogInBackground();
  if (await syncOpenAiCodexDefaultsToRuntimeConfigIfNeeded()) {
    return getRuntimeConfigSnapshot(runtimeModelCatalogState);
  }
  return getRuntimeConfigSnapshot(runtimeModelCatalogState);
}

async function getRuntimeConfigWithoutCatalogRefresh(): Promise<RuntimeConfigPayload> {
  const managedCatalog = runtimeModelCatalogState;
  let didSyncDefaults = false;
  if (await syncManagedHolabossDefaultsToRuntimeConfigIfNeeded(managedCatalog)) {
    didSyncDefaults = true;
  }
  if (await syncOpenAiCodexDefaultsToRuntimeConfigIfNeeded()) {
    didSyncDefaults = true;
  }
  if (didSyncDefaults) {
    return getRuntimeConfigSnapshot(runtimeModelCatalogState);
  }
  return getRuntimeConfigSnapshot(managedCatalog);
}

async function getRuntimeConfigDocumentText(): Promise<string> {
  await syncOpenAiCodexDefaultsToRuntimeConfigIfNeeded();
  const document = await readRuntimeConfigDocument();
  if (Object.keys(document).length > 0) {
    return `${JSON.stringify(document, null, 2)}\n`;
  }
  return `{
  "runtime": {
    "sandbox_id": "desktop:replace-me"
  },
  "providers": {},
  "models": {}
}
`;
}

async function setRuntimeConfigDocument(
  rawDocument: string,
): Promise<RuntimeConfigPayload> {
  const trimmed = rawDocument.trim();
  if (!trimmed) {
    throw new Error("Runtime config JSON is required.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Invalid runtime config JSON: ${error.message}`
        : "Invalid runtime config JSON.",
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Runtime config must be a JSON object.");
  }

  const nextText = `${JSON.stringify(parsed, null, 2)}\n`;
  let shouldRestartRuntime = false;
  await withRuntimeConfigMutationLock(async () => {
    const currentDocument = await readRuntimeConfigDocument();
    const currentText =
      Object.keys(currentDocument).length > 0
        ? `${JSON.stringify(currentDocument, null, 2)}\n`
        : "";

    if (currentText !== nextText) {
      await writeRuntimeConfigTextAtomically(nextText);
      shouldRestartRuntime = true;
    }
  });
  await syncDesktopBrowserCapabilityConfig();

  if (shouldRestartRuntime) {
    await restartEmbeddedRuntimeSafely("runtime_config_document");
  }

  const config = await getRuntimeConfig();
  await emitRuntimeConfig(config);
  return config;
}

async function requestOpenAiCodexDeviceCode(): Promise<{
  userCode: string;
  deviceAuthId: string;
  intervalSeconds: number;
}> {
  const response = await fetch(OPENAI_CODEX_OAUTH_DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: OPENAI_CODEX_OAUTH_CLIENT_ID,
    }),
  });
  const payload = await openAiCodexTokenResponseJson(
    response,
    "OpenAI Codex device-code login returned an invalid response.",
  );
  if (!response.ok) {
    throw new Error(
      openAiCodexErrorMessage(
        payload,
        `OpenAI Codex device-code login failed with status ${response.status}.`,
      ),
    );
  }
  const userCode = runtimeFirstNonEmptyString(
    payload.user_code as string | undefined,
  );
  const deviceAuthId = runtimeFirstNonEmptyString(
    payload.device_auth_id as string | undefined,
  );
  const rawInterval =
    typeof payload.interval === "number"
      ? payload.interval
      : Number.parseInt(String(payload.interval ?? ""), 10);
  const intervalSeconds =
    Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 5;
  if (!userCode || !deviceAuthId) {
    throw new Error(
      "OpenAI Codex device-code login response was missing required fields.",
    );
  }
  return {
    userCode,
    deviceAuthId,
    intervalSeconds: Math.max(3, intervalSeconds),
  };
}

async function waitForOpenAiCodexAuthorizationCode(
  params: {
    deviceAuthId: string;
    userCode: string;
    intervalSeconds: number;
  },
  options?: { signal?: AbortSignal },
): Promise<{
  authorizationCode: string;
  codeVerifier: string;
}> {
  const deadline = Date.now() + OPENAI_CODEX_DEVICE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (options?.signal?.aborted) {
      throw new Error("OpenAI Codex sign-in cancelled.");
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, params.intervalSeconds * 1000);
      const onAbort = () => {
        clearTimeout(timeout);
        reject(new Error("OpenAI Codex sign-in cancelled."));
      };
      options?.signal?.addEventListener("abort", onAbort, { once: true });
    });
    if (options?.signal?.aborted) {
      throw new Error("OpenAI Codex sign-in cancelled.");
    }
    const response = await fetch(OPENAI_CODEX_OAUTH_DEVICE_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        device_auth_id: params.deviceAuthId,
        user_code: params.userCode,
      }),
      signal: options?.signal,
    });
    if (response.status === 403 || response.status === 404) {
      continue;
    }
    const payload = await openAiCodexTokenResponseJson(
      response,
      "OpenAI Codex device authorization returned an invalid response.",
    );
    if (!response.ok) {
      throw new Error(
        openAiCodexErrorMessage(
          payload,
          `OpenAI Codex device authorization failed with status ${response.status}.`,
        ),
      );
    }
    const authorizationCode = runtimeFirstNonEmptyString(
      payload.authorization_code as string | undefined,
    );
    const codeVerifier = runtimeFirstNonEmptyString(
      payload.code_verifier as string | undefined,
    );
    if (!authorizationCode || !codeVerifier) {
      throw new Error(
        "OpenAI Codex device authorization response was missing required fields.",
      );
    }
    return {
      authorizationCode,
      codeVerifier,
    };
  }
  throw new Error("OpenAI Codex sign-in timed out after 15 minutes.");
}

async function exchangeOpenAiCodexAuthorizationCode(params: {
  authorizationCode: string;
  codeVerifier: string;
}): Promise<{
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
}> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.authorizationCode,
    redirect_uri: OPENAI_CODEX_OAUTH_REDIRECT_URI,
    client_id: OPENAI_CODEX_OAUTH_CLIENT_ID,
    code_verifier: params.codeVerifier,
  });
  const response = await fetch(OPENAI_CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const payload = await openAiCodexTokenResponseJson(
    response,
    "OpenAI Codex token exchange returned an invalid response.",
  );
  if (!response.ok) {
    throw new Error(
      openAiCodexErrorMessage(
        payload,
        `OpenAI Codex token exchange failed with status ${response.status}.`,
      ),
    );
  }
  const accessToken = runtimeFirstNonEmptyString(
    payload.access_token as string | undefined,
  );
  const refreshToken = runtimeFirstNonEmptyString(
    payload.refresh_token as string | undefined,
  );
  if (!accessToken || !refreshToken) {
    throw new Error(
      "OpenAI Codex token exchange did not return both access and refresh tokens.",
    );
  }
  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: openAiCodexAccessTokenExpiresAt(payload.expires_in),
  };
}

async function refreshOpenAiCodexAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
}> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OPENAI_CODEX_OAUTH_CLIENT_ID,
  });
  const response = await fetch(OPENAI_CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const payload = await openAiCodexTokenResponseJson(
    response,
    "OpenAI Codex token refresh returned an invalid response.",
  );
  if (!response.ok) {
    throw new Error(
      openAiCodexErrorMessage(
        payload,
        `OpenAI Codex token refresh failed with status ${response.status}.`,
      ),
    );
  }
  const accessToken = runtimeFirstNonEmptyString(
    payload.access_token as string | undefined,
  );
  const nextRefreshToken = runtimeFirstNonEmptyString(
    payload.refresh_token as string | undefined,
    refreshToken,
  );
  if (!accessToken || !nextRefreshToken) {
    throw new Error(
      "OpenAI Codex token refresh did not return valid credentials.",
    );
  }
  return {
    accessToken,
    refreshToken: nextRefreshToken,
    accessTokenExpiresAt: openAiCodexAccessTokenExpiresAt(payload.expires_in),
  };
}

interface CodexOAuthSession {
  challenge: { userCode: string; deviceAuthId: string; intervalSeconds: number };
  abort: AbortController;
  startedAt: number;
}

let activeCodexOAuthSession: CodexOAuthSession | null = null;
let pendingCodexOAuthStart: Promise<{
  userCode: string;
  intervalSeconds: number;
}> | null = null;
const CODEX_OAUTH_REUSE_WINDOW_MS = 60_000;

async function startOpenAiCodexOAuth(): Promise<{
  userCode: string;
  intervalSeconds: number;
}> {
  if (pendingCodexOAuthStart) {
    return pendingCodexOAuthStart;
  }
  if (
    activeCodexOAuthSession &&
    !activeCodexOAuthSession.abort.signal.aborted &&
    Date.now() - activeCodexOAuthSession.startedAt < CODEX_OAUTH_REUSE_WINDOW_MS
  ) {
    return {
      userCode: activeCodexOAuthSession.challenge.userCode,
      intervalSeconds: activeCodexOAuthSession.challenge.intervalSeconds,
    };
  }
  if (activeCodexOAuthSession) {
    activeCodexOAuthSession.abort.abort();
    activeCodexOAuthSession = null;
  }
  pendingCodexOAuthStart = (async () => {
    const challenge = await requestOpenAiCodexDeviceCode();
    clipboard.writeText(challenge.userCode);
    void shell.openExternal(OPENAI_CODEX_OAUTH_DEVICE_PAGE_URL).catch(() => undefined);
    activeCodexOAuthSession = {
      challenge,
      abort: new AbortController(),
      startedAt: Date.now(),
    };
    return {
      userCode: challenge.userCode,
      intervalSeconds: challenge.intervalSeconds,
    };
  })();
  try {
    return await pendingCodexOAuthStart;
  } finally {
    pendingCodexOAuthStart = null;
  }
}

async function awaitOpenAiCodexOAuth(): Promise<RuntimeConfigPayload> {
  const session = activeCodexOAuthSession;
  if (!session) {
    throw new Error("No OpenAI Codex sign-in is in progress. Click Connect to start one.");
  }
  try {
    const authorization = await waitForOpenAiCodexAuthorizationCode(
      session.challenge,
      { signal: session.abort.signal },
    );
    const exchanged = await exchangeOpenAiCodexAuthorizationCode(authorization);
    const config = await updateRuntimeConfigDocumentWithoutRestart(
      (currentDocument) =>
        withOpenAiCodexProviderState(currentDocument, {
          ...exchanged,
          lastRefreshAt: utcNowIso(),
        }),
    );
    ensureOpenAiCodexRefreshLoop();
    return config;
  } finally {
    if (activeCodexOAuthSession === session) {
      activeCodexOAuthSession = null;
    }
  }
}

function cancelOpenAiCodexOAuth(): void {
  if (!activeCodexOAuthSession) return;
  activeCodexOAuthSession.abort.abort();
  activeCodexOAuthSession = null;
}

async function connectOpenAiCodexProvider(): Promise<RuntimeConfigPayload> {
  await startOpenAiCodexOAuth();
  return awaitOpenAiCodexOAuth();
}

async function refreshOpenAiCodexProviderCredentials(options?: {
  force?: boolean;
}): Promise<boolean> {
  if (codexOauthRefreshPromise) {
    return codexOauthRefreshPromise;
  }
  const refreshWork = (async () => {
    const currentDocument = await readRuntimeConfigDocument();
    const state = openAiCodexProviderStateFromDocument(currentDocument);
    if (state.authMode !== "codex_oauth") {
      return false;
    }
    if (!state.refreshToken.trim()) {
      return false;
    }
    if (
      !options?.force &&
      !openAiCodexNeedsRefresh(state.accessTokenExpiresAt)
    ) {
      return false;
    }
    const refreshed = await refreshOpenAiCodexAccessToken(state.refreshToken);
    await updateRuntimeConfigDocumentWithoutRestart((document) =>
      withOpenAiCodexProviderState(document, {
        ...refreshed,
        lastRefreshAt: utcNowIso(),
      }),
    );
    return true;
  })();
  codexOauthRefreshPromise = refreshWork.finally(() => {
    codexOauthRefreshPromise = null;
  });
  return codexOauthRefreshPromise;
}

function ensureOpenAiCodexRefreshLoop(): void {
  if (codexOauthRefreshTimer) {
    return;
  }
  codexOauthRefreshTimer = setInterval(() => {
    void refreshOpenAiCodexProviderCredentials().catch((error) => {
      console.warn("OpenAI Codex token refresh failed:", error);
    });
  }, OPENAI_CODEX_REFRESH_INTERVAL_MS);
  codexOauthRefreshTimer.unref();
}

async function runtimeApiRequest<T>(
  pathname: string,
  init: RequestInit = {},
): Promise<T> {
  const status = await ensureRuntimeReady();
  const baseUrl = status.url ?? runtimeBaseUrl();
  const targetUrl = new URL(
    pathname,
    `${baseUrl.replace(/\/+$/, "")}/`,
  ).toString();
  const response = await fetch(targetUrl, init);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      detail.trim() ||
        `Runtime API request failed: ${response.status} ${response.statusText}`,
    );
  }
  return (await response.json()) as T;
}

const localRuntimeUserProfileStore = createLocalRuntimeUserProfileStore({
  controlPlaneDatabasePath: controlPlaneDatabasePath,
});

const localIntegrationMetadataStore = createLocalIntegrationMetadataStore({
  controlPlaneDatabasePath: controlPlaneDatabasePath,
});

const localAppCatalogStore = createLocalAppCatalogStore({
  controlPlaneDatabasePath: controlPlaneDatabasePath,
});
async function getRuntimeUserProfile(): Promise<RuntimeUserProfilePayload> {
  return localRuntimeUserProfileStore.getProfile();
}

async function setRuntimeUserProfile(
  payload: RuntimeUserProfileUpdatePayload,
): Promise<RuntimeUserProfilePayload> {
  return localRuntimeUserProfileStore.setProfile(payload);
}

async function applyRuntimeUserProfileAuthFallback(
  name: string,
  profileId = "default",
): Promise<RuntimeUserProfilePayload> {
  return localRuntimeUserProfileStore.applyAuthFallback(name, profileId);
}

async function syncRuntimeUserProfileFromAuth(
  user: AuthUserPayload,
): Promise<void> {
  const name = typeof user.name === "string" ? user.name.trim() : "";
  if (!name) {
    return;
  }
  try {
    await applyRuntimeUserProfileAuthFallback(name);
  } catch (error) {
    appendRuntimeEventLog({
      category: "auth",
      event: "runtime_profile.auth_fallback",
      outcome: "error",
      detail:
        error instanceof Error
          ? error.message
          : "Runtime profile auth fallback failed.",
    });
  }
}

async function exchangeDesktopRuntimeBinding(
  sandboxId: string,
): Promise<RuntimeBindingExchangePayload> {
  const controlPlaneBaseUrl = requireControlPlaneBaseUrl();
  const cookieHeader = authCookieHeader();
  if (!cookieHeader) {
    throw new Error("Better Auth session cookies are missing.");
  }

  const exchangeUrl = `${controlPlaneBaseUrl}${DESKTOP_RUNTIME_BINDING_EXCHANGE_PATH}`;
  let response: Response;
  try {
    response = await fetch(exchangeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
      },
      body: JSON.stringify({
        sandbox_id: sandboxId,
        target_kind: "desktop",
      }),
    });
  } catch (error) {
    throw new Error(
      `Runtime binding exchange request failed for ${exchangeUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      detail ||
        `Runtime binding exchange failed with status ${response.status}`,
    );
  }

  return response.json() as Promise<RuntimeBindingExchangePayload>;
}

function emitAuthAuthenticated(user: AuthUserPayload) {
  pendingAuthUser = user;
  pendingAuthError = null;
  const userId = authUserId(user);
  Sentry.setUser(userId ? { id: userId } : null);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("auth:authenticated", user);
  }
  if (authPopupWindow && !authPopupWindow.isDestroyed()) {
    authPopupWindow.webContents.send("auth:authenticated", user);
  }
  // Notify any pending 401 retry waiters that auth completed.
  for (const listener of gatewayAuthCallbackListeners) {
    listener();
  }
}

function emitAuthUserUpdated(user: AuthUserPayload | null) {
  pendingAuthUser = user;
  const userId = authUserId(user);
  Sentry.setUser(userId ? { id: userId } : null);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("auth:userUpdated", user);
  }
  if (authPopupWindow && !authPopupWindow.isDestroyed()) {
    authPopupWindow.webContents.send("auth:userUpdated", user);
  }
  // Notify 401 retry waiters — auth succeeded via session recovery
  // (handles callback paths C/D where emitAuthAuthenticated is not called).
  if (user) {
    for (const listener of gatewayAuthCallbackListeners) {
      listener();
    }
  }
}

function emitAuthError(payload: AuthErrorPayload) {
  pendingAuthError = payload;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("auth:error", payload);
  }
  if (authPopupWindow && !authPopupWindow.isDestroyed()) {
    authPopupWindow.webContents.send("auth:error", payload);
  }
  // Reject any pending 401 retry waiters so they fail fast instead of
  // hanging until the 2-minute timeout.
  for (const listener of gatewayAuthErrorListeners) {
    listener(payload);
  }
}

function emitPendingAuthState() {
  if (pendingAuthUser) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("auth:userUpdated", pendingAuthUser);
    }
    if (authPopupWindow && !authPopupWindow.isDestroyed()) {
      authPopupWindow.webContents.send("auth:userUpdated", pendingAuthUser);
    }
  }
  if (pendingAuthError) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("auth:error", pendingAuthError);
    }
    if (authPopupWindow && !authPopupWindow.isDestroyed()) {
      authPopupWindow.webContents.send("auth:error", pendingAuthError);
    }
    pendingAuthError = null;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("appUpdate:state", appUpdateStatus);
  }
}

function clearPersistedAuthCookie() {
  const configPath = authStorageConfigPath();
  if (!existsSync(configPath)) {
    return;
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const root = parsed && typeof parsed === "object" ? parsed : null;
    if (!root) {
      return;
    }

    const betterAuthRaw = root["better-auth"];
    if (
      !betterAuthRaw ||
      typeof betterAuthRaw !== "object" ||
      Array.isArray(betterAuthRaw)
    ) {
      return;
    }

    const betterAuth = { ...(betterAuthRaw as Record<string, unknown>) };
    let cleared = false;
    if ("cookie" in betterAuth) {
      delete betterAuth.cookie;
      cleared = true;
    }
    if ("local_cache" in betterAuth) {
      delete betterAuth.local_cache;
      cleared = true;
    }
    if (!cleared) {
      return;
    }
    if (Object.keys(betterAuth).length === 0) {
      delete root["better-auth"];
    } else {
      root["better-auth"] = betterAuth;
    }

    writeFileSync(configPath, `${JSON.stringify(root, null, 2)}\n`, "utf-8");
  } catch {
    // Best-effort recovery path for stale encrypted cookie state.
  }
}

function authCookieHeader() {
  if (!desktopAuthClient) {
    return "";
  }

  const isUsableCookieHeader = (value: string) => {
    const normalized = value.trim();
    if (!normalized) {
      return false;
    }
    if (normalized.toLowerCase().includes("invalid-encrypted-cookie")) {
      return false;
    }
    return normalized.includes("=");
  };

  const readCookieOrThrow = () => {
    const cookie = requireAuthClient().getCookie() || "";
    if (!isUsableCookieHeader(cookie)) {
      throw new Error("Better Auth cookie is missing or invalid.");
    }
    return cookie;
  };

  try {
    return readCookieOrThrow();
  } catch (error) {
    appendRuntimeEventLog({
      category: "auth",
      event: "auth.cookie.read",
      outcome: "error",
      detail:
        error instanceof Error
          ? error.message
          : "Failed to read Better Auth cookie.",
    });
    clearPersistedAuthCookie();

    try {
      return readCookieOrThrow();
    } catch (retryError) {
      appendRuntimeEventLog({
        category: "auth",
        event: "auth.cookie.read",
        outcome: "error",
        detail:
          retryError instanceof Error
            ? retryError.message
            : "Failed to read Better Auth cookie after reset.",
      });
      return "";
    }
  }
}

function requireAuthClient() {
  if (!desktopAuthClient) {
    throw new Error(
      "Remote authentication is not configured. Set HOLABOSS_AUTH_BASE_URL and HOLABOSS_AUTH_SIGN_IN_URL outside the public repo.",
    );
  }
  return desktopAuthClient;
}

let marketplaceAppSdkClientCache: ReturnType<typeof buildAppSdkClient> | null =
  null;

function getMarketplaceAppSdkClient() {
  if (marketplaceAppSdkClientCache) {
    return marketplaceAppSdkClientCache;
  }
  if (!AUTH_BASE_URL) {
    throw new Error(
      "Remote backend is not configured. Set HOLABOSS_AUTH_BASE_URL outside the public repo.",
    );
  }
  marketplaceAppSdkClientCache = buildAppSdkClient({
    baseURL: marketplaceBffBaseUrl(),
    getCookie: authCookieHeader,
    // Intentionally do NOT clear the persisted cookie on 401 — the marketplace
    // BFF may 401 for reasons unrelated to cookie validity (e.g. session
    // middleware not attaching to OpenAPIHono sub-routes). Clearing the cookie
    // would destroy a valid session shared with `billingFetch`, which would
    // then fail too. Treat cookie lifecycle as owned by the auth flow itself.
  });
  return marketplaceAppSdkClientCache;
}

function requireControlPlaneBaseUrl() {
  if (!DESKTOP_CONTROL_PLANE_BASE_URL) {
    throw new Error(
      "Remote backend is not configured. Set HOLABOSS_BACKEND_BASE_URL outside the public repo.",
    );
  }
  return DESKTOP_CONTROL_PLANE_BASE_URL;
}

async function getAuthenticatedUser(): Promise<AuthUserPayload | null> {
  if (!AUTH_BASE_URL) {
    return null;
  }

  const cookieHeader = authCookieHeader();
  if (!cookieHeader) {
    return null;
  }

  const response = await fetch(`${AUTH_BASE_URL}/api/auth/get-session`, {
    method: "GET",
    headers: {
      Cookie: cookieHeader,
    },
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      clearPersistedAuthCookie();
      return null;
    }
    const detail = await response.text();
    throw new Error(
      detail || `Failed to load auth session with status ${response.status}`,
    );
  }

  const payload = (await response.json()) as { user?: AuthUserPayload } | null;
  return payload?.user ?? null;
}

function authUserId(user: AuthUserPayload | null | undefined): string {
  if (!user || typeof user.id !== "string") {
    return "";
  }
  return user.id.trim();
}

function generateDesktopSandboxId(): string {
  return `desktop:${randomUUID()}`;
}

function runtimeConfigNeedsBindingRefresh(
  config: Record<string, string>,
  userId: string,
): boolean {
  const runtimeUserId = (config.user_id || "").trim();
  const hasAuthToken = Boolean(runtimeModelProxyApiKeyFromConfig(config));
  const hasSandboxId = Boolean((config.sandbox_id || "").trim());
  const runtimeControlPlaneBaseUrl = normalizeBaseUrl(
    config.control_plane_base_url || "",
  );
  if (!hasAuthToken || !hasSandboxId) {
    return true;
  }
  if (!runtimeControlPlaneBaseUrl) {
    return true;
  }
  if (runtimeControlPlaneBaseUrl !== DESKTOP_CONTROL_PLANE_BASE_URL) {
    return true;
  }
  return runtimeUserId !== userId;
}

function runtimeConfigIsControlPlaneManaged(
  config: Record<string, string>,
): boolean {
  const runtimeControlPlaneBaseUrl = normalizeBaseUrl(
    config.control_plane_base_url || "",
  );
  if (runtimeControlPlaneBaseUrl) {
    return runtimeControlPlaneBaseUrl === DESKTOP_CONTROL_PLANE_BASE_URL;
  }
  const modelProxyBaseUrl = normalizeBaseUrl(config.model_proxy_base_url || "");
  return modelProxyBaseUrl.includes("/api/v1/model-proxy");
}

function runtimeBindingNeedsManagedHolabossDefaultsRefresh(
  config: Record<string, string>,
  document: Record<string, unknown>,
): boolean {
  if (!runtimeConfigIsControlPlaneManaged(config)) {
    return false;
  }
  if (
    runtimeModelCatalogState.providerModelGroups.length > 0 &&
    (
      !runtimeModelCatalogState.defaultBackgroundModel ||
      !runtimeModelCatalogState.defaultEmbeddingModel ||
      !runtimeModelCatalogState.defaultImageModel
    )
  ) {
    return true;
  }

  const runtimePayload = runtimeConfigObject(document.runtime);
  const currentBackgroundTasks = runtimeConfigObject(
    runtimePayload.background_tasks ?? runtimePayload.backgroundTasks,
  );
  const currentImageGeneration = runtimeConfigObject(
    runtimePayload.image_generation ?? runtimePayload.imageGeneration,
  );
  const currentRecallEmbeddings = runtimeConfigObject(
    runtimePayload.recall_embeddings ?? runtimePayload.recallEmbeddings,
  );
  const currentBackgroundProviderId = canonicalRuntimeProviderId(
    runtimeFirstNonEmptyString(
      currentBackgroundTasks.provider as string | undefined,
      currentBackgroundTasks.provider_id as string | undefined,
      currentBackgroundTasks.providerId as string | undefined,
    ),
  );
  const currentBackgroundModel = runtimeFirstNonEmptyString(
    currentBackgroundTasks.model as string | undefined,
    currentBackgroundTasks.model_id as string | undefined,
    currentBackgroundTasks.modelId as string | undefined,
  );
  const currentImageGenerationProviderId = canonicalRuntimeProviderId(
    runtimeFirstNonEmptyString(
      currentImageGeneration.provider as string | undefined,
      currentImageGeneration.provider_id as string | undefined,
      currentImageGeneration.providerId as string | undefined,
    ),
  );
  const currentImageGenerationModel = runtimeFirstNonEmptyString(
    currentImageGeneration.model as string | undefined,
    currentImageGeneration.model_id as string | undefined,
    currentImageGeneration.modelId as string | undefined,
  );
  const currentRecallEmbeddingsProviderId = canonicalRuntimeProviderId(
    runtimeFirstNonEmptyString(
      currentRecallEmbeddings.provider as string | undefined,
      currentRecallEmbeddings.provider_id as string | undefined,
      currentRecallEmbeddings.providerId as string | undefined,
    ),
  );
  const currentRecallEmbeddingsModel = runtimeFirstNonEmptyString(
    currentRecallEmbeddings.model as string | undefined,
    currentRecallEmbeddings.model_id as string | undefined,
    currentRecallEmbeddings.modelId as string | undefined,
  );

  return (
    (Boolean(runtimeModelCatalogState.defaultBackgroundModel) &&
      (Object.keys(currentBackgroundTasks).length === 0 ||
        (isHolabossProviderAlias(currentBackgroundProviderId) &&
          !currentBackgroundModel))) ||
    (Boolean(runtimeModelCatalogState.defaultEmbeddingModel) &&
      (Object.keys(currentRecallEmbeddings).length === 0 ||
        (isHolabossProviderAlias(currentRecallEmbeddingsProviderId) &&
          !currentRecallEmbeddingsModel))) ||
    (Boolean(runtimeModelCatalogState.defaultImageModel) &&
      (Object.keys(currentImageGeneration).length === 0 ||
        (isHolabossProviderAlias(currentImageGenerationProviderId) &&
          !currentImageGenerationModel)))
  );
}

function configuredProviderIdForRuntimeModelToken(
  modelToken: string | null | undefined,
): string {
  const normalizedModelToken = normalizeLegacyRuntimeModelToken(
    runtimeConfigField(modelToken ?? ""),
  );
  if (!normalizedModelToken.includes("/")) {
    return "";
  }
  const [providerId] = normalizedModelToken.split("/");
  return providerId.trim();
}

function sessionQueueRequiresRuntimeBinding(
  config: Record<string, string>,
  selectedModelToken: string | null | undefined,
): boolean {
  const explicitProviderId =
    configuredProviderIdForRuntimeModelToken(selectedModelToken);
  if (explicitProviderId) {
    return isHolabossProviderAlias(explicitProviderId);
  }

  const defaultProviderId = runtimeConfigField(config.default_provider);
  if (defaultProviderId) {
    return isHolabossProviderAlias(defaultProviderId);
  }

  const defaultModelProviderId = configuredProviderIdForRuntimeModelToken(
    config.default_model,
  );
  if (defaultModelProviderId) {
    return isHolabossProviderAlias(defaultModelProviderId);
  }

  return runtimeConfigIsControlPlaneManaged(config);
}

function shouldForceRuntimeBindingRefresh(userId: string): boolean {
  if (!userId) {
    return false;
  }
  if (lastRuntimeBindingRefreshUserId !== userId) {
    return true;
  }
  return (
    Date.now() - lastRuntimeBindingRefreshAtMs >
    RUNTIME_BINDING_REFRESH_INTERVAL_MS
  );
}

function hasRecentTransientRuntimeBindingRefreshFailure(
  userId: string,
): boolean {
  if (!userId) {
    return false;
  }
  if (lastRuntimeBindingRefreshFailureUserId !== userId) {
    return false;
  }
  return (
    Date.now() - lastRuntimeBindingRefreshFailureAtMs <
    RUNTIME_BINDING_REFRESH_FAILURE_BACKOFF_MS
  );
}

function markTransientRuntimeBindingRefreshFailure(userId: string): void {
  if (!userId) {
    return;
  }
  lastRuntimeBindingRefreshFailureAtMs = Date.now();
  lastRuntimeBindingRefreshFailureUserId = userId;
}

function clearTransientRuntimeBindingRefreshFailure(): void {
  lastRuntimeBindingRefreshFailureAtMs = 0;
  lastRuntimeBindingRefreshFailureUserId = "";
}

async function clearRuntimeBindingSecrets(reason: string): Promise<void> {
  appendRuntimeEventLog({
    category: "auth",
    event: "runtime_binding.invalidate",
    outcome: "start",
    detail: reason,
  });
  const currentConfig = await readRuntimeConfigFile();
  const nextConfig = await writeRuntimeConfigFile({
    authToken: null,
    modelProxyApiKey: null,
    userId: null,
    sandboxId: null,
    modelProxyBaseUrl: null,
    controlPlaneBaseUrl: null,
  });
  await clearRuntimeModelCatalog();
  lastRuntimeBindingRefreshAtMs = 0;
  lastRuntimeBindingRefreshUserId = "";
  clearTransientRuntimeBindingRefreshFailure();
  await restartEmbeddedRuntimeIfNeeded(
    currentConfig,
    nextConfig,
    "runtime_binding_invalidate",
  );
  await emitRuntimeConfig();
  appendRuntimeEventLog({
    category: "auth",
    event: "runtime_binding.invalidate",
    outcome: "success",
    detail: reason,
  });
}

async function clearManagedHolabossDefaultSelection(
  reason: string,
): Promise<void> {
  const currentConfig = await readRuntimeConfigFile();
  const currentDocument = await readRuntimeConfigDocument();
  const defaultProviderId = runtimeConfigField(currentConfig.default_provider);
  const defaultModelToken = normalizeLegacyRuntimeModelToken(
    runtimeConfigField(currentConfig.default_model),
  );
  const subagentModelToken = normalizeLegacyRuntimeModelToken(
    runtimeConfigField(currentConfig.subagent_model),
  );
  const providerGroups = runtimeProviderModelGroups(
    currentDocument,
    currentConfig,
    runtimeModelCatalogState.providerModelGroups,
  );
  const holabossGroupHasModelToken = (token: string): boolean =>
    Boolean(token) &&
    providerGroups.some(
      (group) =>
        isHolabossProviderAlias(group.providerId) &&
        group.models.some((model) => model.token.trim() === token),
    );
  const clearDefaultProvider = isHolabossProviderAlias(defaultProviderId);
  const clearDefaultModel =
    clearDefaultProvider ||
    isHolabossProviderAlias(
      configuredProviderIdForRuntimeModelToken(defaultModelToken),
    ) ||
    holabossGroupHasModelToken(defaultModelToken);
  const clearSubagentModel =
    clearDefaultProvider ||
    isHolabossProviderAlias(
      configuredProviderIdForRuntimeModelToken(subagentModelToken),
    ) ||
    holabossGroupHasModelToken(subagentModelToken);
  if (!clearDefaultProvider && !clearDefaultModel && !clearSubagentModel) {
    return;
  }
  await writeRuntimeConfigFile({
    ...(clearDefaultProvider ? { defaultProvider: null } : {}),
    ...(clearDefaultModel ? { defaultModel: null } : {}),
    ...(clearSubagentModel ? { subagentModel: null } : {}),
  });
  await emitRuntimeConfig();
  appendRuntimeEventLog({
    category: "auth",
    event: "runtime_binding.invalidate_defaults",
    outcome: "success",
    detail: reason,
  });
}

async function provisionRuntimeBindingForAuthenticatedUser(
  user: AuthUserPayload,
  options?: {
    forceNewSandbox?: boolean;
    forceRefresh?: boolean;
    reason?: string;
  },
): Promise<void> {
  const userId = authUserId(user);
  if (!userId) {
    return;
  }

  await withRuntimeBindingRefreshLock(async () => {
    const forceNewSandbox = Boolean(options?.forceNewSandbox);
    const forceRefresh = Boolean(options?.forceRefresh);
    const currentConfig = await readRuntimeConfigFile();
    const currentDocument = await readRuntimeConfigDocument();
    const managedDefaultsNeedRefresh =
      runtimeBindingNeedsManagedHolabossDefaultsRefresh(
        currentConfig,
        currentDocument,
      );
    if (
      !forceNewSandbox &&
      !forceRefresh &&
      !runtimeConfigNeedsBindingRefresh(currentConfig, userId) &&
      !managedDefaultsNeedRefresh
    ) {
      await refreshRuntimeModelCatalogIfNeeded().catch(() => undefined);
      await syncRuntimeUserProfileFromAuth(user);
      return;
    }

    const runtimeSandboxId = (currentConfig.sandbox_id || "").trim();
    const runtimeUserId = (currentConfig.user_id || "").trim();
    const sandboxId =
      forceNewSandbox || !runtimeSandboxId || runtimeUserId !== userId
        ? generateDesktopSandboxId()
        : runtimeSandboxId;

    appendRuntimeEventLog({
      category: "auth",
      event: "runtime_binding.provision",
      outcome: "start",
      detail: options?.reason || null,
    });

    try {
      const binding = await exchangeDesktopRuntimeBinding(sandboxId);
      const modelProxyApiKey = runtimeBindingModelProxyApiKey(binding);
      if (!modelProxyApiKey) {
        throw new Error(
          "Runtime binding response missing model_proxy_api_key.",
        );
      }
      const nextConfig = await writeRuntimeConfigFile({
        authToken: modelProxyApiKey,
        modelProxyApiKey,
        userId: binding.holaboss_user_id,
        sandboxId: binding.sandbox_id,
        modelProxyBaseUrl: (binding.model_proxy_base_url || "").replace(
          "host.docker.internal",
          "127.0.0.1",
        ),
        defaultModel: binding.default_model,
        defaultBackgroundModel: binding.default_background_model ?? null,
        defaultEmbeddingModel: binding.default_embedding_model ?? null,
        defaultImageModel: binding.default_image_model ?? null,
        controlPlaneBaseUrl: DESKTOP_CONTROL_PLANE_BASE_URL,
      });
      await syncRuntimeModelCatalogFromBinding(binding);
      await restartEmbeddedRuntimeIfNeeded(
        currentConfig,
        nextConfig,
        "runtime_binding_provision",
      );
      await emitRuntimeConfig();
      await syncRuntimeUserProfileFromAuth(user);

      appendRuntimeEventLog({
        category: "auth",
        event: "runtime_binding.provision",
        outcome: "success",
        detail: `${options?.reason || "unknown"}:${binding.sandbox_id}`,
      });
      lastRuntimeBindingRefreshAtMs = Date.now();
      lastRuntimeBindingRefreshUserId = userId;
      clearTransientRuntimeBindingRefreshFailure();
    } catch (error) {
      appendRuntimeEventLog({
        category: "auth",
        event: "runtime_binding.provision",
        outcome: "error",
        detail:
          error instanceof Error
            ? error.message
            : "Failed to provision runtime binding.",
      });
      throw error;
    }
  });
}

async function ensureRuntimeBindingReadyForWorkspaceFlow(
  reason: string,
  options?: {
    forceRefresh?: boolean;
    allowProvisionWhenUnmanaged?: boolean;
    waitForStartupSync?: boolean;
  },
): Promise<void> {
  if (options?.waitForStartupSync !== false) {
    const startupSync = startupAuthSyncPromise;
    if (startupSync) {
      await startupSync;
    }
  }

  const currentConfig = await readRuntimeConfigFile();
  const controlPlaneManaged = runtimeConfigIsControlPlaneManaged(currentConfig);
  const allowProvisionWhenUnmanaged = Boolean(
    options?.allowProvisionWhenUnmanaged,
  );
  if (!controlPlaneManaged && !allowProvisionWhenUnmanaged) {
    return;
  }

  let user: AuthUserPayload | null;
  try {
    user = await getAuthenticatedUser();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const canUseExistingBindingOnSessionLookupFailure =
      runtimeConfigHasBindingMaterial(currentConfig) &&
      !Boolean(options?.forceRefresh) &&
      !(allowProvisionWhenUnmanaged && !controlPlaneManaged);
    if (
      canUseExistingBindingOnSessionLookupFailure &&
      isTransientRuntimeError(error)
    ) {
      appendRuntimeEventLog({
        category: "auth",
        event: "runtime_binding.session_lookup",
        outcome: "skipped",
        detail:
          `${reason}:using_existing_binding_after_transient_session_lookup_failure:` +
          detail,
      });
      return;
    }
    throw error;
  }
  if (!user) {
    if (canUsePersistedRuntimeBindingWithoutAuth(currentConfig)) {
      return;
    }
    await clearManagedHolabossDefaultSelection(
      `${reason}:missing_auth_session`,
    );
    if (runtimeModelProxyApiKeyFromConfig(currentConfig)) {
      await clearRuntimeBindingSecrets(`${reason}:missing_auth_session`);
    }
    throw new Error("Authentication session missing. Sign in again.");
  }

  const userId = authUserId(user);
  const bindingNeedsReplacement = runtimeConfigNeedsBindingRefresh(
    currentConfig,
    userId,
  );
  const hasExistingBindingMaterial =
    runtimeConfigHasBindingMaterial(currentConfig);
  const canUseExistingBindingOnRefreshFailure =
    hasExistingBindingMaterial &&
    !bindingNeedsReplacement &&
    !Boolean(options?.forceRefresh) &&
    !(allowProvisionWhenUnmanaged && !controlPlaneManaged);
  const shouldRefresh =
    Boolean(options?.forceRefresh) ||
    (allowProvisionWhenUnmanaged && !controlPlaneManaged) ||
    bindingNeedsReplacement ||
    shouldForceRuntimeBindingRefresh(userId);
  if (
    shouldRefresh &&
    canUseExistingBindingOnRefreshFailure &&
    hasRecentTransientRuntimeBindingRefreshFailure(userId)
  ) {
    appendRuntimeEventLog({
      category: "auth",
      event: "runtime_binding.provision",
      outcome: "skipped",
      detail: `${reason}:using_recent_binding_refresh_backoff`,
    });
    return;
  }
  if (shouldRefresh) {
    try {
      await provisionRuntimeBindingForAuthenticatedUser(user, {
        forceRefresh: true,
        forceNewSandbox: false,
        reason,
      });
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Binding exchange failed.";
      if (
        canUseExistingBindingOnRefreshFailure &&
        isTransientRuntimeError(error)
      ) {
        markTransientRuntimeBindingRefreshFailure(userId);
        appendRuntimeEventLog({
          category: "auth",
          event: "runtime_binding.provision",
          outcome: "skipped",
          detail: `${reason}:using_existing_binding_after_transient_refresh_failure:${detail}`,
        });
        return;
      }
      await clearRuntimeBindingSecrets(`${reason}:provision_failed`);
      throw new Error(`Runtime binding provisioning failed: ${detail}`);
    }
  }

  const refreshedConfig = await readRuntimeConfigFile();
  const hasBindingMaterial = runtimeConfigHasBindingMaterial(refreshedConfig);
  if (!hasBindingMaterial) {
    await clearRuntimeBindingSecrets(`${reason}:binding_incomplete`);
    throw new Error("Runtime binding is incomplete. Sign in again.");
  }
}

function nearestPackageJsonDirectory(startDirectory: string): string | null {
  let currentDirectory = path.resolve(startDirectory);

  while (true) {
    if (existsSync(path.join(currentDirectory, "package.json"))) {
      return currentDirectory;
    }
    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return null;
    }
    currentDirectory = parentDirectory;
  }
}

function defaultAppProtocolClientArgs(): string[] {
  const packageRoot = nearestPackageJsonDirectory(__dirname);
  if (packageRoot) {
    return [packageRoot];
  }

  const launchTargetArg = defaultAppLaunchTargetArg();
  if (launchTargetArg) {
    return [launchTargetArg];
  }

  const appPath = app.getAppPath().trim();
  return appPath ? [path.resolve(appPath)] : [];
}

function extractAuthToken(callbackUrl: string): string | null {
  try {
    const parsed = new URL(callbackUrl);
    if (parsed.protocol !== `${AUTH_CALLBACK_PROTOCOL}:`) {
      return null;
    }
    const callbackPath = `/${parsed.hostname}${parsed.pathname}`.replace(
      /\/+/g,
      "/",
    );
    if (callbackPath !== "/auth/callback") {
      return null;
    }
    if (parsed.hash.startsWith("#token=")) {
      const hashToken = parsed.hash.slice("#token=".length).trim();
      if (hashToken) {
        return hashToken;
      }
    }
    const queryToken = parsed.searchParams.get("token");
    if (typeof queryToken === "string" && queryToken.trim()) {
      return queryToken.trim();
    }
    return null;
  } catch {
    return null;
  }
}

async function handleAuthCallbackUrl(targetUrl: string) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  }

  const token = extractAuthToken(targetUrl);
  if (!token) {
    emitAuthError({
      message: "Invalid desktop authentication callback.",
      status: 400,
      statusText: "Bad Request",
      path: targetUrl,
    });
    return;
  }

  try {
    const result = await requireAuthClient().authenticate({ token });
    const user = (result.data?.user ?? null) as AuthUserPayload | null;
    if (user) {
      emitAuthAuthenticated(user);
      emitAuthUserUpdated(user);
      try {
        await provisionRuntimeBindingForAuthenticatedUser(user, {
          forceNewSandbox: true,
          reason: "auth_callback",
        });
      } catch (bindingError) {
        emitAuthError({
          message:
            bindingError instanceof Error
              ? `Signed in, but runtime binding provisioning failed: ${bindingError.message}`
              : "Signed in, but runtime binding provisioning failed.",
          status: 502,
          statusText: "Bad Gateway",
          path: DESKTOP_RUNTIME_BINDING_EXCHANGE_PATH,
        });
      }
      return;
    }
    const resolvedUser = await getAuthenticatedUser();
    emitAuthUserUpdated(resolvedUser);
    if (resolvedUser) {
      try {
        await provisionRuntimeBindingForAuthenticatedUser(resolvedUser, {
          forceNewSandbox: true,
          reason: "auth_callback_session_lookup",
        });
      } catch (bindingError) {
        emitAuthError({
          message:
            bindingError instanceof Error
              ? `Signed in, but runtime binding provisioning failed: ${bindingError.message}`
              : "Signed in, but runtime binding provisioning failed.",
          status: 502,
          statusText: "Bad Gateway",
          path: DESKTOP_RUNTIME_BINDING_EXCHANGE_PATH,
        });
      }
    }
  } catch (error) {
    const fallbackUser = await getAuthenticatedUser().catch(() => null);
    if (fallbackUser) {
      emitAuthUserUpdated(fallbackUser);
      try {
        await provisionRuntimeBindingForAuthenticatedUser(fallbackUser, {
          forceNewSandbox: true,
          reason: "auth_callback_fallback_session_lookup",
        });
      } catch (bindingError) {
        emitAuthError({
          message:
            bindingError instanceof Error
              ? `Signed in, but runtime binding provisioning failed: ${bindingError.message}`
              : "Signed in, but runtime binding provisioning failed.",
          status: 502,
          statusText: "Bad Gateway",
          path: DESKTOP_RUNTIME_BINDING_EXCHANGE_PATH,
        });
      }
      return;
    }

    emitAuthError({
      message:
        error instanceof Error
          ? error.message
          : "Authentication callback failed.",
      status: 500,
      statusText: "Internal Server Error",
      path: targetUrl,
    });
  }
}

async function syncPersistedAuthSessionOnStartup(): Promise<void> {
  try {
    const user = await getAuthenticatedUser();
    emitAuthUserUpdated(user);
    if (!user) {
      const currentConfig = await readRuntimeConfigFile();
      await clearManagedHolabossDefaultSelection(
        "startup_missing_auth_session",
      );
      if (runtimeModelProxyApiKeyFromConfig(currentConfig)) {
        await clearRuntimeBindingSecrets("startup_missing_auth_session");
      }
      return;
    }

    await provisionRuntimeBindingForAuthenticatedUser(user, {
      forceNewSandbox: false,
      forceRefresh: false,
      reason: "startup_session_restore",
    });
  } catch (error) {
    emitAuthError({
      message:
        error instanceof Error
          ? `Signed in, but runtime binding provisioning failed: ${error.message}`
          : "Signed in, but runtime binding provisioning failed.",
      status: 502,
      statusText: "Bad Gateway",
      path: DESKTOP_RUNTIME_BINDING_EXCHANGE_PATH,
    });
  }
}

function gatewayBaseUrl(service: string): string {
  return `${AUTH_BASE_URL.replace(/\/+$/, "")}/gateway/${service}`;
}

function projectsBaseUrl() {
  return AUTH_BASE_URL
    ? gatewayBaseUrl("projects")
    : DEFAULT_PROJECTS_URL.replace(/\/+$/, "");
}

function marketplaceBaseUrl() {
  return AUTH_BASE_URL
    ? gatewayBaseUrl("marketplace")
    : DEFAULT_MARKETPLACE_URL.replace(/\/+$/, "");
}

/**
 * BFF (Hono) marketplace base URL — used by the @holaboss/app-sdk client
 * (both main-side and renderer-direct via bff:fetch). Lives on the Hono
 * server at `/api/marketplace`, NOT behind the `/gateway/marketplace`
 * Python control-plane proxy. Distinct from `marketplaceBaseUrl()` which
 * targets that gateway proxy.
 */
function marketplaceBffBaseUrl() {
  if (!AUTH_BASE_URL) {
    return "";
  }
  return `${AUTH_BASE_URL.replace(/\/+$/, "")}/api/marketplace`;
}

async function controlPlaneHeaders(
  _service: "projects" | "marketplace" | "proactive",
  extraHeaders?: Record<string, string>,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };
  // Send Better Auth session cookie so the Hono gateway can resolve
  // the user identity. Main-process fetch is not subject to browser
  // CORS — the earlier "no Cookie" comment was about renderer-process
  // constraints that don't apply here.
  // TODO(phase-2): Once the Python backend reads X-Holaboss-User-Id
  // from the gateway-injected header, remove holaboss_user_id from
  // request bodies in requestControlPlaneJson callers.
  const cookie = authCookieHeader();
  if (cookie) {
    headers["Cookie"] = cookie;
  }
  return headers;
}

function proactiveBaseUrl() {
  return AUTH_BASE_URL
    ? gatewayBaseUrl("proactive")
    : DEFAULT_PROACTIVE_URL.replace(/\/+$/, "");
}

function runtimeProactiveBridgeBaseUrl() {
  return proactiveBaseUrl();
}

function embeddedRuntimeStartupConfigError() {
  if (runtimeProactiveBridgeBaseUrl()) {
    return "";
  }
  return (
    "Embedded runtime remote bridge is enabled but no remote base URL is configured. " +
    "Set HOLABOSS_BACKEND_BASE_URL or HOLABOSS_PROACTIVE_URL in apps/desktop/.env."
  );
}

function controlPlaneServiceBaseUrl(
  service: "projects" | "marketplace" | "proactive",
) {
  if (service === "projects") {
    return projectsBaseUrl();
  }
  if (service === "marketplace") {
    return marketplaceBaseUrl();
  }
  return proactiveBaseUrl();
}

async function readControlPlaneError(response: Response) {
  const text = await response.text();
  if (!text.trim()) {
    return `status=${response.status}`;
  }

  try {
    const payload = JSON.parse(text) as unknown;
    if (payload && typeof payload === "object" && "detail" in payload) {
      const detail = (payload as Record<string, unknown>).detail;
      return typeof detail === "string" ? detail : JSON.stringify(detail);
    }
    return JSON.stringify(payload);
  } catch {
    return text;
  }
}

/**
 * Deduplicates concurrent 401 sign-in prompts.
 * Opens the sign-in browser once, then waits for the auth callback
 * (deep link → handleAuthCallbackUrl → emitAuthAuthenticated or
 * emitAuthUserUpdated) before resolving. Rejects early on emitAuthError.
 * Callers retry their request after this resolves.
 */
let pendingGatewayAuthRetry: Promise<void> | null = null;

/** Listeners notified when emitAuthAuthenticated or emitAuthUserUpdated(non-null) fires. */
const gatewayAuthCallbackListeners = new Set<() => void>();

/** Listeners notified when emitAuthError fires so waiters reject promptly. */
const gatewayAuthErrorListeners = new Set<(err: AuthErrorPayload) => void>();

function waitForAuthCallback(timeoutMs = 120_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      gatewayAuthCallbackListeners.delete(successListener);
      gatewayAuthErrorListeners.delete(errorListener);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Sign-in timed out."));
    }, timeoutMs);

    const successListener = () => {
      cleanup();
      resolve();
    };

    const errorListener = (err: AuthErrorPayload) => {
      cleanup();
      reject(new Error(err.message ?? "Sign-in failed."));
    };

    gatewayAuthCallbackListeners.add(successListener);
    gatewayAuthErrorListeners.add(errorListener);
  });
}

/**
 * Codes that mean "the connection was disrupted before we got an HTTP
 * response" — i.e. transient network/TLS layer failures. Worth one
 * retry; not worth surfacing to the user.
 *
 * Common trigger: undici's connection pool reuses a socket that the
 * staging server has already half-closed (HTTP keep-alive race). Shows
 * up as `TypeError: fetch failed` with cause.code === 'ECONNRESET'.
 */
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function isTransientFetchError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const cause = (err as { cause?: { code?: string; name?: string } }).cause;
  if (!cause) return false;
  if (cause.code && TRANSIENT_NETWORK_CODES.has(cause.code)) return true;
  // undici sometimes reports the socket close as `name` only.
  return cause.name === "SocketError";
}

/**
 * Wraps fetch with a single retry against transient network errors.
 * Backoff is short (200ms) because keep-alive socket races resolve as
 * soon as a fresh connection is opened. Auth/HTTP-level failures (4xx,
 * 5xx) are returned untouched — those go through retryAfterSessionAuth.
 */
async function fetchWithNetworkRetry(
  ...args: Parameters<typeof fetch>
): Promise<Response> {
  try {
    return await fetch(...args);
  } catch (err) {
    if (!isTransientFetchError(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 200));
    return fetch(...args);
  }
}

/**
 * Re-auth recovery shared by every main-process fetch that depends on
 * the Better Auth session cookie. Behaviour:
 *   1. Take a 401 response that the caller already produced
 *   2. Single-flight: spawn the sign-in browser + waitForAuthCallback
 *      once across all concurrent 401s (pendingGatewayAuthRetry)
 *   3. After the user completes sign-in, ask the caller to re-execute
 *   4. If sign-in is dismissed/times out, return the original 401 so
 *      the caller can surface a sensible error
 *
 * Use this whenever a path otherwise hard-fails on a missing/expired
 * cookie. The caller is responsible for providing an `executeRequest`
 * that re-reads the cookie each call (since auth callback refreshes it).
 */
async function retryAfterSessionAuth(
  unauthorizedResponse: Response,
  executeRequest: () => Promise<Response>,
): Promise<Response> {
  if (unauthorizedResponse.status !== 401 || !desktopAuthClient) {
    return unauthorizedResponse;
  }
  // Don't auto-launch sign-in when the user has explicitly signed out (no
  // cookie). The retry is for *expired* sessions; for an intentional
  // sign-out, 401 is the expected result and pulling the user to the login
  // page surprises them ("clicked Settings, browser opened to sign-in").
  // The caller will surface the 401 as a normal "not authenticated" error.
  if (!authCookieHeader()) {
    return unauthorizedResponse;
  }
  try {
    if (!pendingGatewayAuthRetry) {
      const authComplete = waitForAuthCallback();
      requireAuthClient()
        .requestAuth()
        .catch(() => {});
      pendingGatewayAuthRetry = authComplete.finally(() => {
        pendingGatewayAuthRetry = null;
      });
    }
    await pendingGatewayAuthRetry;
    return await executeRequest();
  } catch {
    // User dismissed sign-in or auth failed — surface the original 401
    return unauthorizedResponse;
  }
}

async function requestControlPlaneJson<T>({
  service,
  method,
  path: requestPath,
  payload,
  params,
}: {
  service: "projects" | "marketplace" | "proactive";
  method: "GET" | "POST" | "DELETE";
  path: string;
  payload?: unknown;
  params?: Record<string, string | number | boolean | null | undefined>;
}): Promise<T> {
  const url = new URL(`${controlPlaneServiceBaseUrl(service)}${requestPath}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) {
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  const executeRequest = async () => {
    return fetchWithNetworkRetry(url.toString(), {
      method,
      headers: await controlPlaneHeaders(service),
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  };

  const maybeRetryRuntimeBinding = async (
    status: number,
    detail: string,
  ): Promise<boolean> => {
    if (service !== "marketplace" && service !== "proactive") {
      return false;
    }
    const normalizedDetail = detail.trim().toLowerCase();
    const looksLikeApiKeyAuthFailure =
      status === 401 ||
      status === 403 ||
      normalizedDetail.includes("invalid or missing api key") ||
      normalizedDetail.includes("api key") ||
      normalizedDetail.includes("unauthorized") ||
      normalizedDetail.includes("forbidden");
    if (!looksLikeApiKeyAuthFailure) {
      return false;
    }
    await ensureRuntimeBindingReadyForWorkspaceFlow(
      `control_plane_${service}_auth_retry`,
      {
        forceRefresh: true,
        allowProvisionWhenUnmanaged: true,
        waitForStartupSync: true,
      },
    );
    return true;
  };

  let response = await executeRequest();
  let errorDetail = "";
  if (!response.ok) {
    errorDetail = await readControlPlaneError(response);
    const retried = await maybeRetryRuntimeBinding(
      response.status,
      errorDetail,
    ).catch(() => false);
    if (retried) {
      response = await executeRequest();
      errorDetail = "";
    }
  }
  // Session 401 → run shared re-auth retry (extracted to retryAfterSessionAuth).
  // Composio paths now share the same single-flight, so concurrent control-plane
  // and Composio 401s won't race two sign-in browser windows.
  if (response.status === 401) {
    response = await retryAfterSessionAuth(response, executeRequest);
    if (response.ok) {
      errorDetail = "";
    }
  }
  if (!response.ok) {
    throw new Error(errorDetail || (await readControlPlaneError(response)));
  }
  if (response.status === 204) {
    return null as T;
  }

  const text = await response.text();
  if (!text.trim()) {
    const hdrs = Object.fromEntries(response.headers.entries());
    console.error(
      `[control-plane] Empty response: ${method} ${url.toString()} → status=${response.status} headers=${JSON.stringify(hdrs)}`,
    );
    throw new Error(
      `Empty response from ${service} ${method} ${requestPath} (status ${response.status})`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `Invalid JSON from ${service} ${method} ${requestPath} (status ${response.status}): ${text.slice(0, 200)}`,
    );
  }
}

async function requestDesktopControlPlaneJson<T>({
  method,
  path: requestPath,
  payload,
  params,
}: {
  method: "GET" | "POST";
  path: string;
  payload?: unknown;
  params?: Record<string, string | number | boolean | null | undefined>;
}): Promise<T> {
  const url = new URL(`${requireControlPlaneBaseUrl()}${requestPath}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) {
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  const executeRequest = async () => {
    return fetchWithNetworkRetry(url.toString(), {
      method,
      headers: await controlPlaneHeaders("projects"),
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  };

  let response = await executeRequest();
  if (response.status === 401) {
    response = await retryAfterSessionAuth(response, executeRequest);
  }
  if (!response.ok) {
    throw new Error(await readControlPlaneError(response));
  }
  if (response.status === 204) {
    return null as T;
  }

  const text = await response.text();
  if (!text.trim()) {
    throw new Error(
      `Empty response from desktop control plane ${method} ${requestPath} (status ${response.status})`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `Invalid JSON from desktop control plane ${method} ${requestPath} (status ${response.status}): ${text.slice(0, 200)}`,
    );
  }
}

function getHolabossClientConfig(): HolabossClientConfigPayload {
  return {
    projectsUrl: projectsBaseUrl(),
    marketplaceUrl: marketplaceBaseUrl(),
  };
}

function firstNonEmptyLine(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    return trimmed.replace(/^#+\s*/, "");
  }
  return null;
}

async function parseLocalTemplateMetadata(
  templateRoot: string,
): Promise<TemplateMetadataPayload> {
  const templateName = path.basename(templateRoot);
  const workspaceYamlPath = path.join(templateRoot, "workspace.yaml");
  const workspaceYaml = await fs.readFile(workspaceYamlPath, "utf-8");
  const resolvedName =
    workspaceYaml.match(/^\s*name:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim() ||
    templateName;

  let description: string | null = null;
  try {
    description = firstNonEmptyLine(
      await fs.readFile(path.join(templateRoot, "README.md"), "utf-8"),
    );
  } catch {
    try {
      description = firstNonEmptyLine(
        await fs.readFile(path.join(templateRoot, "AGENTS.md"), "utf-8"),
      );
    } catch {
      description = null;
    }
  }

  const skillsDir = path.join(templateRoot, "skills");
  let tags: string[] = [];
  if (existsSync(skillsDir)) {
    tags = (await fs.readdir(skillsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  return {
    name: templateName,
    repo: "local",
    path: templateName,
    default_ref: "local",
    description,
    is_hidden: false,
    is_coming_soon: false,
    allowed_user_ids: [],
    icon: "folder",
    emoji: null,
    apps: [],
    min_optional_apps: 0,
    tags,
    category: "local",
    long_description: description,
    agents: [],
    views: [],
    install_count: 0,
    source: "local",
    verified: false,
    author_name: "Local folder",
    author_id: "_local",
  };
}

interface AppTemplateListResponsePayload {
  templates: AppTemplateMetadataPayload[];
}

async function listAppTemplatesViaControlPlane(): Promise<AppTemplateListResponsePayload> {
  // Uses @holaboss/app-sdk against Hono's /api/marketplace/app-templates
  // route. Publicly readable, so the Cookie header is forwarded when a
  // session exists but the call still works anonymously.
  const client = getMarketplaceAppSdkClient();
  const data = await sdkListMarketplaceAppTemplates({ client });
  return {
    templates: data.templates as AppTemplateMetadataPayload[],
  };
}

// Hard cap on archive size to prevent runaway downloads from filling disk
// or OOMing the Electron main process. App tarballs are normally well under
// 50 MB; 500 MB leaves headroom while still bounding the worst case.
const MAX_APP_ARCHIVE_BYTES = 500 * 1024 * 1024;
// Whole-download timeout. Streaming progress doesn't reset this.
const APP_ARCHIVE_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

async function downloadAppArchive(url: string, appId: string): Promise<string> {
  const dir = path.join(os.tmpdir(), "holaboss-app-archives");
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${appId}-${Date.now()}.tar.gz`);

  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    abortController.abort(new Error("Download timed out"));
  }, APP_ARCHIVE_DOWNLOAD_TIMEOUT_MS);

  let fileStream: ReturnType<typeof createWriteStream> | null = null;
  try {
    const res = await fetch(url, { method: "GET", signal: abortController.signal });
    if (!res.ok || !res.body) {
      throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    }
    const totalHeader = res.headers.get("content-length");
    const total = totalHeader ? Number.parseInt(totalHeader, 10) : 0;
    if (total > MAX_APP_ARCHIVE_BYTES) {
      throw new Error(
        `App archive too large: ${total} bytes (max ${MAX_APP_ARCHIVE_BYTES})`,
      );
    }
    let received = 0;

    // Rewrap the WHATWG ReadableStream as a Node Readable, then pipeline
    // it into the file writer. pipeline() guarantees both sides see errors
    // and resources are torn down on failure — the previous hand-rolled
    // loop swallowed write() errors and attached its error handler too
    // late to catch them.
    const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    source.on("data", (chunk: Buffer) => {
      received += chunk.byteLength;
      if (received > MAX_APP_ARCHIVE_BYTES) {
        source.destroy(
          new Error(
            `App archive exceeded ${MAX_APP_ARCHIVE_BYTES} bytes during download`,
          ),
        );
        return;
      }
      mainWindow?.webContents.send("app-install-progress", {
        appId,
        phase: "downloading",
        bytes: received,
        total,
      });
    });

    fileStream = createWriteStream(filePath);
    await pipeline(source, fileStream);
    return filePath;
  } catch (error) {
    // Best-effort cleanup of the partially written archive so the temp dir
    // doesn't accumulate junk on every failed download.
    try {
      fileStream?.destroy();
    } catch {
      // ignore
    }
    try {
      await fs.rm(filePath, { force: true });
    } catch {
      // ignore
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function listTaskProposals(
  workspaceId: string,
): Promise<TaskProposalListResponsePayload> {
  if (!workspaceId.trim()) {
    return { proposals: [], count: 0 };
  }
  return requestWorkspaceRuntimeJson<TaskProposalListResponsePayload>(
    workspaceId,
    {
      method: "GET",
      path: "/api/v1/task-proposals/unreviewed",
      params: {
        workspace_id: workspaceId,
      },
    },
  );
}

async function listBackgroundTasks(
  payload: BackgroundTaskListRequestPayload,
): Promise<BackgroundTaskListResponsePayload> {
  if (!payload.workspaceId.trim()) {
    return { tasks: [], count: 0 };
  }
  return requestWorkspaceRuntimeJson<BackgroundTaskListResponsePayload>(
    payload.workspaceId,
    {
      method: "GET",
      path: "/api/v1/background-tasks",
      params: {
        workspace_id: payload.workspaceId,
        owner_main_session_id: payload.ownerMainSessionId ?? undefined,
        statuses:
          payload.statuses && payload.statuses.length > 0
            ? payload.statuses.join(",")
            : undefined,
        limit: payload.limit ?? 200,
      },
    },
  );
}

async function archiveBackgroundTask(
  payload: ArchiveBackgroundTaskPayload,
): Promise<ArchiveBackgroundTaskResponsePayload> {
  if (!payload.workspaceId.trim()) {
    throw new Error("workspaceId is required");
  }
  if (!payload.subagentId.trim()) {
    throw new Error("subagentId is required");
  }
  return requestWorkspaceRuntimeJson<ArchiveBackgroundTaskResponsePayload>(
    payload.workspaceId,
    {
      method: "POST",
      path: `/api/v1/background-tasks/${encodeURIComponent(payload.subagentId)}/archive`,
      payload: {
        workspace_id: payload.workspaceId,
        owner_main_session_id: payload.ownerMainSessionId ?? undefined,
      },
    },
  );
}

async function continueBackgroundTask(
  payload: ContinueBackgroundTaskPayload,
): Promise<ContinueBackgroundTaskResponsePayload> {
  if (!payload.workspaceId.trim()) {
    throw new Error("workspaceId is required");
  }
  if (!payload.subagentId.trim()) {
    throw new Error("subagentId is required");
  }
  if (!payload.ownerMainSessionId.trim()) {
    throw new Error("ownerMainSessionId is required");
  }
  const instruction = payload.instruction.trim();
  if (!instruction) {
    throw new Error("instruction is required");
  }
  return requestWorkspaceRuntimeJson<ContinueBackgroundTaskResponsePayload>(
    payload.workspaceId,
    {
      method: "POST",
      path: `/api/v1/capabilities/runtime-tools/subagents/${encodeURIComponent(payload.subagentId)}/continue`,
      payload: {
        workspace_id: payload.workspaceId,
        session_id: payload.ownerMainSessionId,
        instruction,
        title: payload.title ?? undefined,
      },
    },
  );
}

async function acceptTaskProposal(
  payload: TaskProposalAcceptPayload,
): Promise<TaskProposalAcceptResponsePayload> {
  return requestWorkspaceRuntimeJson<TaskProposalAcceptResponsePayload>(
    payload.workspace_id,
    {
      method: "POST",
      path: `/api/v1/task-proposals/${encodeURIComponent(payload.proposal_id)}/accept`,
      payload: {
        workspace_id: payload.workspace_id,
        task_name: payload.task_name,
        task_prompt: payload.task_prompt,
        session_id: payload.session_id,
        parent_session_id: payload.parent_session_id,
        created_by: payload.created_by,
        priority: payload.priority ?? 0,
        model: payload.model ?? null,
      },
    },
  );
}

async function listCronjobs(
  workspaceId: string,
  enabledOnly = false,
): Promise<CronjobListResponsePayload> {
  return requestWorkspaceRuntimeJson<CronjobListResponsePayload>(workspaceId, {
    method: "GET",
    path: "/api/v1/cronjobs",
    params: {
      workspace_id: workspaceId,
      enabled_only: enabledOnly,
    },
  });
}

async function runCronjobNow(
  workspaceId: string,
  jobId: string,
  payload?: CronjobRunNowPayload,
): Promise<CronjobRunResponsePayload> {
  return requestWorkspaceRuntimeJson<CronjobRunResponsePayload>(workspaceId, {
    method: "POST",
    path: `/api/v1/cronjobs/${encodeURIComponent(jobId)}/run`,
    params: {
      workspace_id: workspaceId,
    },
    payload,
  });
}

async function createCronjob(
  payload: CronjobCreatePayload,
): Promise<CronjobRecordPayload> {
  return requestWorkspaceRuntimeJson<CronjobRecordPayload>(payload.workspace_id, {
    method: "POST",
    path: "/api/v1/cronjobs",
    payload,
  });
}

async function updateCronjob(
  workspaceId: string,
  jobId: string,
  payload: CronjobUpdatePayload,
): Promise<CronjobRecordPayload> {
  return requestWorkspaceRuntimeJson<CronjobRecordPayload>(workspaceId, {
    method: "PATCH",
    path: `/api/v1/cronjobs/${encodeURIComponent(jobId)}`,
    payload: {
      workspace_id: workspaceId,
      ...payload,
    },
  });
}

async function deleteCronjob(
  workspaceId: string,
  jobId: string,
): Promise<{ success: boolean }> {
  return requestWorkspaceRuntimeJson<{ success: boolean }>(workspaceId, {
    method: "DELETE",
    path: `/api/v1/cronjobs/${encodeURIComponent(jobId)}`,
    params: {
      workspace_id: workspaceId,
    },
  });
}

const runtimeNotificationListCache = new Map<
  string,
  RuntimeNotificationListResponsePayload
>();

function runtimeNotificationListCacheKey(
  workspaceId?: string | null,
  includeDismissed = false,
  options?: {
    includeCronjobSource?: boolean;
    sourceType?: string | null;
  },
): string {
  return JSON.stringify({
    workspaceId: workspaceId?.trim() || null,
    includeDismissed,
    includeCronjobSource: options?.includeCronjobSource === true,
    sourceType: options?.sourceType?.trim() || null,
  });
}

function emptyRuntimeNotificationListResponse(): RuntimeNotificationListResponsePayload {
  return {
    items: [],
    count: 0,
  };
}

async function listNotifications(
  workspaceId?: string | null,
  includeDismissed = false,
  options?: {
    includeCronjobSource?: boolean;
    sourceType?: string | null;
  },
): Promise<RuntimeNotificationListResponsePayload> {
  const cacheKey = runtimeNotificationListCacheKey(
    workspaceId,
    includeDismissed,
    options,
  );
  try {
    const response = workspaceId?.trim()
      ? await requestWorkspaceRuntimeJson<RuntimeNotificationListResponsePayload>(
          workspaceId,
          {
            method: "GET",
            path: "/api/v1/notifications",
            params: {
              workspace_id: workspaceId,
              include_dismissed: includeDismissed,
              include_cronjob_source:
                options?.includeCronjobSource === true ? true : undefined,
              source_type: options?.sourceType ?? undefined,
              limit: 50,
            },
          },
        )
      : await requestRuntimeJson<RuntimeNotificationListResponsePayload>({
        method: "GET",
        path: "/api/v1/notifications",
        params: {
          workspace_id: workspaceId ?? undefined,
          include_dismissed: includeDismissed,
          include_cronjob_source:
            options?.includeCronjobSource === true ? true : undefined,
          source_type: options?.sourceType ?? undefined,
          limit: 50,
        },
      });
    runtimeNotificationListCache.set(cacheKey, response);
    return response;
  } catch (error) {
    if (isTransientRuntimeError(error)) {
      return (
        runtimeNotificationListCache.get(cacheKey) ??
        emptyRuntimeNotificationListResponse()
      );
    }
    throw error;
  }
}

async function updateNotification(
  workspaceId: string,
  notificationId: string,
  payload: RuntimeNotificationUpdatePayload,
): Promise<RuntimeNotificationRecordPayload> {
  const response = await requestWorkspaceRuntimeJson<RuntimeNotificationRecordPayload>(
    workspaceId,
    {
      method: "PATCH",
      path: `/api/v1/notifications/${encodeURIComponent(notificationId)}`,
      payload: {
        workspace_id: workspaceId,
        ...payload,
      },
    },
  );
  runtimeNotificationListCache.clear();
  return response;
}

async function listIntegrationCatalog(): Promise<IntegrationCatalogResponsePayload> {
  return runtimeClient.integrations.listCatalog();
}

async function listIntegrationConnections(params?: {
  providerId?: string;
  ownerUserId?: string;
}): Promise<IntegrationConnectionListResponsePayload> {
  return localIntegrationMetadataStore.listConnections(params);
}

async function listIntegrationBindings(
  workspaceId: string,
): Promise<IntegrationBindingListResponsePayload> {
  return requestWorkspaceRuntimeJson<IntegrationBindingListResponsePayload>(
    workspaceId,
    {
      method: "GET",
      path: "/api/v1/integrations/bindings",
      params: {
        workspace_id: workspaceId,
      },
    },
  );
}

interface WorkspaceDefaultAccountResponsePayload {
  connection_id: string | null;
}

interface SetWorkspaceDefaultAccountResponsePayload {
  connection_id: string;
}

// Layer 2 of the four-layer account-resolution model — "when this
// workspace makes a direct (non-app) Composio call for provider X,
// use this connection by default". REST routes are on the runtime
// API server; these IPC wrappers exist so the Settings UI + the
// IntegrationsPane connect flow can read / write them. See
// active-account-resolver.ts for the full resolution stack.
async function getWorkspaceDefaultAccount(
  workspaceId: string,
  providerId: string,
): Promise<WorkspaceDefaultAccountResponsePayload> {
  return requestWorkspaceRuntimeJson<WorkspaceDefaultAccountResponsePayload>(
    workspaceId,
    {
      method: "GET",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/${encodeURIComponent(providerId)}/default-account`,
    },
  );
}

async function setWorkspaceDefaultAccount(
  workspaceId: string,
  providerId: string,
  connectionId: string,
): Promise<SetWorkspaceDefaultAccountResponsePayload> {
  return requestWorkspaceRuntimeJson<SetWorkspaceDefaultAccountResponsePayload>(
    workspaceId,
    {
      method: "PUT",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/${encodeURIComponent(providerId)}/default-account`,
      payload: { connection_id: connectionId },
    },
  );
}

async function upsertIntegrationBinding(
  workspaceId: string,
  targetType: string,
  targetId: string,
  integrationKey: string,
  payload: IntegrationUpsertBindingPayload,
): Promise<IntegrationBindingPayload> {
  return requestWorkspaceRuntimeJson<IntegrationBindingPayload>(
    workspaceId,
    {
      method: "PUT",
      path: `/api/v1/integrations/bindings/${encodeURIComponent(workspaceId)}/${encodeURIComponent(targetType)}/${encodeURIComponent(targetId)}/${encodeURIComponent(integrationKey)}`,
      payload,
    },
  );
}

async function deleteIntegrationBinding(
  bindingId: string,
  workspaceId: string,
): Promise<{ deleted: boolean }> {
  return requestWorkspaceRuntimeJson<{ deleted: boolean }>(workspaceId, {
    method: "DELETE",
    path: `/api/v1/integrations/bindings/${encodeURIComponent(bindingId)}`,
    params: {
      workspace_id: workspaceId,
    },
  });
}

interface WorkspaceIntegrationConnectionView {
  connected_account_id: string;
  status: string;
  user_id: string;
  created_at: string;
}

interface WorkspaceIntegrationView {
  toolkit_slug: string;
  toolkit_name: string;
  toolkit_logo: string | null;
  supported: boolean;
  effective_state: "auto" | "disabled" | "pinned";
  effective_connection_id: string | null;
  pinned_connection_id: string | null;
  connections: WorkspaceIntegrationConnectionView[];
}

interface WorkspaceIntegrationsListResponse {
  workspace_id: string;
  integrations: WorkspaceIntegrationView[];
}

interface MemoryBrowserTreeNode {
  name: string;
  path: string;
  kind: "directory" | "file";
  size_bytes: number | null;
  modified_at: string | null;
  children?: MemoryBrowserTreeNode[];
}

interface MemoryBrowserTreeResponse {
  workspace_id: string;
  root: MemoryBrowserTreeNode;
  counts: {
    directories: number;
    files: number;
  };
}

interface MemoryBrowserFileResponse {
  workspace_id: string;
  path: string;
  name: string;
  size_bytes: number;
  modified_at: string;
  content: string;
}

type MemoryBrowserGraphForest = "workspace" | "integrations";
type MemoryBrowserGraphNodeKind = "root" | "tree" | "entity" | "branch" | "summary" | "leaf";

interface MemoryBrowserGraphNode {
  id: string;
  kind: MemoryBrowserGraphNodeKind;
  category: "interaction" | "integration";
  tree_id: string | null;
  label: string;
  subtitle: string | null;
  status: string | null;
  level: number | null;
  child_count: number | null;
  path: string | null;
}

interface MemoryBrowserGraphEdge {
  from: string;
  to: string;
  kind: "contains" | "parent_child" | "reference";
}

interface MemoryBrowserGraphResponse {
  workspace_id: string;
  forest: MemoryBrowserGraphForest;
  focus_tree_id: string | null;
  nodes: MemoryBrowserGraphNode[];
  edges: MemoryBrowserGraphEdge[];
}

async function listWorkspaceIntegrations(
  workspaceId: string,
): Promise<WorkspaceIntegrationsListResponse> {
  return requestWorkspaceRuntimeJson<WorkspaceIntegrationsListResponse>(workspaceId, {
    method: "GET",
    path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations`,
  });
}

async function setWorkspaceIntegrationOverride(
  workspaceId: string,
  toolkitSlug: string,
  payload: { state: "disabled" | "pinned"; pinned_connection_id?: string | null },
): Promise<unknown> {
  return requestWorkspaceRuntimeJson<unknown>(workspaceId, {
    method: "PUT",
    path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/${encodeURIComponent(toolkitSlug)}`,
    payload,
  });
}

async function clearWorkspaceIntegrationOverride(
  workspaceId: string,
  toolkitSlug: string,
): Promise<{ deleted: boolean }> {
  return requestWorkspaceRuntimeJson<{ deleted: boolean }>(workspaceId, {
    method: "DELETE",
    path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/${encodeURIComponent(toolkitSlug)}`,
  });
}

async function listMemoryBrowserTree(
  workspaceId: string,
): Promise<MemoryBrowserTreeResponse> {
  return requestWorkspaceRuntimeJson<MemoryBrowserTreeResponse>(workspaceId, {
    method: "GET",
    path: "/api/v1/memory/browser/tree",
    params: {
      workspace_id: workspaceId,
    },
  });
}

async function readMemoryBrowserFile(
  workspaceId: string,
  targetPath: string,
): Promise<MemoryBrowserFileResponse> {
  const normalizedPath =
    typeof targetPath === "string" ? targetPath.trim() : "";
  if (!normalizedPath) {
    throw new Error("readMemoryBrowserFile: path is required");
  }
  return requestWorkspaceRuntimeJson<MemoryBrowserFileResponse>(workspaceId, {
    method: "GET",
    path: "/api/v1/memory/browser/file",
    params: {
      workspace_id: workspaceId,
      path: normalizedPath,
    },
  });
}

async function listMemoryBrowserGraph(
  workspaceId: string,
  params: {
    forest: MemoryBrowserGraphForest;
    treeId?: string | null;
  },
): Promise<MemoryBrowserGraphResponse> {
  const forest = params.forest;
  if (forest !== "workspace" && forest !== "integrations") {
    throw new Error("listMemoryBrowserGraph: forest must be workspace or integrations");
  }
  return requestWorkspaceRuntimeJson<MemoryBrowserGraphResponse>(workspaceId, {
    method: "GET",
    path: "/api/v1/memory/browser/graph",
    params: {
      workspace_id: workspaceId,
      forest,
      tree_id: params.treeId?.trim() || undefined,
    },
  });
}

// Restarts a single workspace app via the runtime's capabilities tool. Used
// after an integration binding is added/changed so the app re-reads
// HOLABOSS_APP_GRANT (which is captured at boot in the bridge-transport
// module and otherwise stays stale until the next process restart).
async function restartWorkspaceApp(
  workspaceId: string,
  appId: string,
): Promise<{ workspace_id: string; app_id: string; restarted: boolean }> {
  const safeAppId = assertSafeAppId(appId);
  return requestWorkspaceRuntimeJson<{
    workspace_id: string;
    app_id: string;
    restarted: boolean;
  }>(workspaceId, {
    method: "POST",
    path: `/api/v1/capabilities/runtime-tools/workspace-apps/${encodeURIComponent(safeAppId)}/restart`,
    payload: { workspace_id: workspaceId },
  });
}

async function createIntegrationConnection(
  payload: IntegrationCreateConnectionPayload,
): Promise<IntegrationConnectionPayload> {
  return localIntegrationMetadataStore.createConnection(payload);
}

function runtimeIntegrationConnectionUpdatePayload(
  payload: IntegrationUpdateConnectionPayload,
): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  if (payload.status !== undefined) {
    update.status = payload.status;
  }
  if (payload.secret_ref !== undefined) {
    update.secret_ref = payload.secret_ref;
  }
  if (payload.account_label !== undefined) {
    update.account_label = payload.account_label;
  }
  if (payload.account_handle !== undefined) {
    update.account_handle = payload.account_handle;
  }
  if (payload.account_email !== undefined) {
    update.account_email = payload.account_email;
  }
  if (payload.context_cron_auto_fetch_enabled !== undefined) {
    update.context_cron_auto_fetch_enabled =
      payload.context_cron_auto_fetch_enabled;
  }
  return update;
}

async function updateIntegrationConnection(
  connectionId: string,
  payload: IntegrationUpdateConnectionPayload,
): Promise<IntegrationConnectionPayload> {
  const runtimeUpdate = runtimeIntegrationConnectionUpdatePayload(payload);
  if (Object.keys(runtimeUpdate).length > 0) {
    try {
      await requestRuntimeJson<IntegrationConnectionPayload>({
        method: "PATCH",
        path: `/api/v1/integrations/connections/${encodeURIComponent(connectionId)}`,
        payload: runtimeUpdate,
      });
    } catch (error) {
      if (payload.context_cron_auto_fetch_enabled !== undefined) {
        throw error;
      }
    }
  }
  return localIntegrationMetadataStore.updateConnection(connectionId, payload);
}

async function deleteIntegrationConnection(
  connectionId: string,
): Promise<{ deleted: boolean }> {
  return localIntegrationMetadataStore.deleteConnection(connectionId);
}

async function mergeIntegrationConnections(
  keepConnectionId: string,
  removeConnectionIds: string[],
): Promise<IntegrationMergeConnectionsResult> {
  return localIntegrationMetadataStore.mergeConnections(
    keepConnectionId,
    removeConnectionIds,
  );
}

async function listConnectionWorkspaceUsage(): Promise<{
  usage: Array<{
    connection_id: string;
    workspaces: Array<{
      workspace_id: string;
      target_type: string;
      target_id: string;
      integration_key: string;
    }>;
  }>;
}> {
  return localIntegrationMetadataStore.listConnectionWorkspaceUsage();
}

async function listIntegrationStoreCatalog(): Promise<{
  entries: Array<{ slug: string; tier: "hero" | "supported"; category: string }>;
}> {
  return requestRuntimeJson<{
    entries: Array<{ slug: string; tier: "hero" | "supported"; category: string }>;
  }>({
    method: "GET",
    path: "/api/v1/integrations/store-catalog",
  });
}

async function listAllWorkspaceIntegrationOverrides(): Promise<{
  overrides: Array<{
    workspace_id: string;
    toolkit_slug: string;
    state: "disabled" | "pinned";
    pinned_connection_id: string | null;
    created_at: string;
    updated_at: string;
  }>;
}> {
  return requestRuntimeJson<{
    overrides: Array<{
      workspace_id: string;
      toolkit_slug: string;
      state: "disabled" | "pinned";
      pinned_connection_id: string | null;
      created_at: string;
      updated_at: string;
    }>;
  }>({
    method: "GET",
    path: "/api/v1/integrations/all-workspace-overrides",
  });
}

async function listOAuthConfigs(): Promise<OAuthAppConfigListResponsePayload> {
  return localIntegrationMetadataStore.listOAuthConfigs();
}

async function upsertOAuthConfig(
  providerId: string,
  payload: OAuthAppConfigUpsertPayload,
): Promise<OAuthAppConfigPayload> {
  return localIntegrationMetadataStore.upsertOAuthConfig(providerId, payload);
}

async function deleteOAuthConfig(
  providerId: string,
): Promise<{ deleted: boolean }> {
  return localIntegrationMetadataStore.deleteOAuthConfig(providerId);
}

async function startOAuthFlow(
  provider: string,
): Promise<OAuthAuthorizeResponsePayload> {
  const runtimeConfig = await readRuntimeConfigFile();
  const userId = (runtimeConfig.user_id || "").trim() || "local";
  const result = await runtimeClient.integrations.authorizeOAuth({
    provider,
    owner_user_id: userId,
  });
  if (result.authorize_url) {
    shell.openExternal(result.authorize_url);
  }
  return result;
}

async function composioFetch<T>(
  path: string,
  method: "GET" | "POST" | "DELETE",
  payload?: unknown,
): Promise<T> {
  if (!AUTH_BASE_URL) {
    throw new Error(
      "Backend is not configured (HOLABOSS_AUTH_BASE_URL missing)",
    );
  }
  // Cookie is read inside executeRequest so the retry path picks up the
  // refreshed cookie set by the auth callback. Don't hard-fail on missing
  // cookie up front — the server's 401 + retryAfterSessionAuth pathway is
  // the canonical way to recover (matches requestControlPlaneJson).
  const executeRequest = async () => {
    const cookieHeader = authCookieHeader();
    return fetchWithNetworkRetry(`${AUTH_BASE_URL}${path}`, {
      method,
      headers: {
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  };

  let response = await executeRequest();
  if (response.status === 401) {
    response = await retryAfterSessionAuth(response, executeRequest);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Composio API error (${response.status}): ${text.slice(0, 300)}`,
    );
  }
  return response.json() as Promise<T>;
}

async function composioConnect(payload: {
  provider: string;
  owner_user_id: string;
  callback_url?: string;
  whoami?: PendingIntegrationWhoami | null;
}): Promise<ComposioConnectResult> {
  const provider = composioToolkitSlugForProvider(payload.provider);
  return composioFetch<ComposioConnectResult>(
    "/api/composio/connect",
    "POST",
    {
      ...payload,
      provider,
    },
  );
}

function composioToolkitSlugForProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "x") {
    return "twitter";
  }
  return normalized;
}

interface ComposioToolkit {
  slug: string;
  name: string;
  description: string;
  logo: string | null;
  auth_schemes: string[];
  categories: string[];
}

async function composioListToolkits(): Promise<{
  toolkits: ComposioToolkit[];
}> {
  // No upfront cookie short-circuit — that previously masked an expired
  // session as "no integrations available". composioFetch now triggers
  // re-auth on 401, so route through it normally.
  return composioFetch<{ toolkits: ComposioToolkit[] }>(
    "/api/composio/toolkits",
    "GET",
  );
}

interface ComposioConnectionSummary {
  id: string;
  toolkitSlug: string;
  toolkitName: string;
  toolkitLogo: string | null;
  userId: string;
  createdAt: string;
}

async function composioListConnections(): Promise<{
  connections: ComposioConnectionSummary[];
}> {
  return composioFetch<{ connections: ComposioConnectionSummary[] }>(
    "/api/composio/connections",
    "GET",
  );
}

// Extracts the raw session_token value out of a Better-Auth cookie
// string. The bearer plugin we enabled on Hono accepts this exact
// value as `Authorization: Bearer <token>`, so the runtime can use it
// to call /composio/internal/* without carrying a cookie jar. Verified
// end-to-end by the cookie/bearer probe.
function extractSessionTokenFromCookieHeader(cookie: string): string | null {
  if (!cookie) return null;
  for (const segment of cookie.split(/;\s*/)) {
    const idx = segment.indexOf("=");
    if (idx < 0) continue;
    const name = segment.slice(0, idx).trim();
    if (!name) continue;
    if (
      name === "better-auth.session_token" ||
      name === "__Secure-better-auth.session_token"
    ) {
      const value = segment.slice(idx + 1).trim();
      if (!value) continue;
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

function authBearerToken(): string {
  const cookie = authCookieHeader();
  if (!cookie) return "";
  return extractSessionTokenFromCookieHeader(cookie) ?? "";
}

// Diagnostic helper — hits the runtime's /api/v1/debug/composio-
// runtime-test endpoint, which exercises ComposioApiClient end-to-end
// (runtime env-injected bearer token → Hono /internal/tools/execute →
// Composio). Wired to a button in IntegrationsPane so we can confirm
// the full server-side stack. Also useful for low-level debugging
// while provider fetch plans are still expanding (the product
// integration context fetch flow now uses
// /api/v1/integrations/context-fetch).
async function debugComposioRuntimeTest(
  params: {
    providerSlug?: string;
    toolSlug?: string;
    arguments?: Record<string, unknown>;
  } = {},
): Promise<unknown> {
  return requestRuntimeJson<unknown>({
    method: "POST",
    path: "/api/v1/debug/composio-runtime-test",
    payload: {
      ...(params.providerSlug ? { provider_slug: params.providerSlug } : {}),
      ...(params.toolSlug ? { tool_slug: params.toolSlug } : {}),
      ...(params.arguments ? { arguments: params.arguments } : {}),
    },
  });
}

type IntegrationContextFetchStatusPayload = {
  connection_id: string;
  provider_id: string;
  run_id: string;
  supported: boolean;
  status: "running" | "completed" | "failed" | "unsupported";
  account_key: string | null;
  account_label: string | null;
  tree_id: string | null;
  current_chunk_label: string | null;
  chunks_total: number;
  chunks_completed: number;
  messages_seen: number;
  messages_persisted: number;
  leaves_created: number;
  leaves_superseding: number;
  leaves_unchanged: number;
  summary_nodes: number;
  actions: string[];
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
  fetched_at: string | null;
  error_message: string | null;
  reason: string | null;
};

type IntegrationContextFetchStartResponsePayload = {
  ok: true;
  started: boolean;
  deduped: boolean;
  status: IntegrationContextFetchStatusPayload;
};

type IntegrationContextFetchStatusListResponsePayload = {
  ok: true;
  statuses: IntegrationContextFetchStatusPayload[];
};

type IntegrationMemoryClearResponsePayload = {
  ok: true;
  provider_id: string;
  connection_id: string;
  cleared: boolean;
  tree_ids: string[];
  deleted_trees: number;
  deleted_leaves: number;
  deleted_summary_nodes: number;
  deleted_tree_edges: number;
  deleted_canonical_nodes: number;
  deleted_canonical_edges: number;
  deleted_relations: number;
  deleted_embeddings: number;
  deleted_files: number;
};
async function fetchIntegrationContext(
  connectionId: string,
): Promise<IntegrationContextFetchStartResponsePayload> {
  const trimmed = typeof connectionId === "string" ? connectionId.trim() : "";
  if (!trimmed) {
    throw new Error("fetchIntegrationContext: connection_id required");
  }
  return requestRuntimeJson<IntegrationContextFetchStartResponsePayload>({
    method: "POST",
    path: "/api/v1/integrations/context-fetch",
    payload: {
      connection_id: trimmed,
    },
  });
}

async function listIntegrationContextFetchStatuses(
  connectionIds: string[] = [],
): Promise<IntegrationContextFetchStatusListResponsePayload> {
  const normalized = connectionIds
    .map((connectionId) =>
      typeof connectionId === "string" ? connectionId.trim() : "",
    )
    .filter((connectionId) => connectionId.length > 0);
  return requestRuntimeJson<IntegrationContextFetchStatusListResponsePayload>({
    method: "GET",
    path: "/api/v1/integrations/context-fetch",
    params: normalized.length > 0
      ? { connection_ids: normalized.join(",") }
      : undefined,
  });
}

async function clearIntegrationMemory(
  connectionId: string,
): Promise<IntegrationMemoryClearResponsePayload> {
  const trimmed = typeof connectionId === "string" ? connectionId.trim() : "";
  if (!trimmed) {
    throw new Error("clearIntegrationMemory: connection_id required");
  }
  return requestRuntimeJson<IntegrationMemoryClearResponsePayload>({
    method: "POST",
    path: "/api/v1/integrations/memory-clear",
    payload: {
      connection_id: trimmed,
    },
  });
}
// Single entry point for "desktop directly calls a Composio action via
// the new /api/composio/internal/tools/execute surface."
//
// The helper does the two steps every Composio action call shares:
//   1. Resolve the user's connected_account_id for the requested
//      provider (`providerSlug`), via the existing /composio/connections
//      list — which already carries Better-Auth session via cookie.
//   2. POST /api/composio/internal/tools/execute with the resolved
//      connected_account_id, the action's `tool_slug`, and the
//      action-specific `arguments` map.
//
// Cookie is attached automatically by composioFetch; Hono accepts the
// session whether the caller sends Cookie or Authorization: Bearer
// (the same `c.get("user")` pathway resolves both).
//
// Example — fetch the user's 5 most recent Gmail messages:
//
//   const data = await composioExecute({
//     providerSlug: "gmail",
//     toolSlug: "GMAIL_FETCH_EMAILS",
//     arguments: { max_results: 5 },
//   });
//   // → { messages: [{ id, threadId, subject, sender, snippet, date, ... }], ... }
//
// To swap to another toolkit (Linear, GitHub, Notion, …) change three
// fields only: providerSlug, toolSlug, arguments. Curated action slugs
// live at GET /api/composio/internal/toolkits/<slug>/tools.
async function composioExecute<TData = unknown>(params: {
  providerSlug: string;
  toolSlug: string;
  arguments?: Record<string, unknown>;
}): Promise<TData | null> {
  const normalizedProvider = params.providerSlug.trim().toLowerCase();
  if (!normalizedProvider) {
    throw new Error("composioExecute: providerSlug is required");
  }
  if (!params.toolSlug.trim()) {
    throw new Error("composioExecute: toolSlug is required");
  }

  const { connections } = await composioListConnections();
  const connection = connections.find(
    (entry) => entry.toolkitSlug.toLowerCase() === normalizedProvider,
  );
  if (!connection) {
    throw new Error(
      `No active ${normalizedProvider} connection — the user needs to connect ${normalizedProvider} first.`,
    );
  }

  const result = await composioFetch<{
    ok: boolean;
    data: TData | null;
    log_id: string | null;
  }>("/api/composio/internal/tools/execute", "POST", {
    tool_slug: params.toolSlug,
    connected_account_id: connection.id,
    arguments: params.arguments ?? {},
  });

  return result.data ?? null;
}

async function composioAccountStatus(
  connectedAccountId: string,
): Promise<ComposioAccountStatus> {
  return composioFetch<ComposioAccountStatus>(
    `/api/composio/account/${encodeURIComponent(connectedAccountId)}`,
    "GET",
  );
}

/**
 * Composio returns this when the connected_account_id has been deleted
 * upstream — common for legacy rows whose external_id pointed at a
 * Composio account that's since been revoked or rotated. It's a
 * permanent, recoverable condition; surfacing it as an unhandled IPC
 * rejection just adds noise to the console.
 */
function isComposioAccountMissingError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /ConnectedAccount_ResourceNotFound|"code":606/.test(err.message);
}

/**
 * Synthetic "tombstone" status for an external account that no longer
 * exists. The frontend cache treats this like any other resolved
 * status — display falls through to the persisted connection fields,
 * and we don't keep re-fetching it on every mount.
 */
function missingComposioStatus(
  connectedAccountId: string,
): ComposioAccountStatus {
  return {
    id: connectedAccountId,
    status: "missing",
    authConfigId: null,
    toolkitSlug: null,
    userId: null,
  };
}

interface ComposioProxyResponse<TData = unknown> {
  data: TData | null;
  status: number;
  headers: Record<string, string>;
}

/**
 * Thrown by `composioProxyFetch` when the upstream provider (GitHub, Google,
 * etc.) responded with a non-2xx status. Hono's /composio/proxy returns 200
 * carrying `{ data, status, headers }` for the upstream response, so the
 * caller can't tell success from failure by HTTP status alone — without
 * this check, a 401 "Bad credentials" body gets handed to the whoami
 * extractor as if it were a normal user object, which is how we ended up
 * with the misleading "raw shape may have shifted" log instead of the
 * actually-useful "user needs to reconnect" signal.
 */
class ProviderHttpError extends Error {
  constructor(
    readonly providerId: string,
    readonly upstreamStatus: number,
    readonly bodyExcerpt: string,
  ) {
    super(
      `Provider ${providerId} returned HTTP ${upstreamStatus}: ${bodyExcerpt}`,
    );
    this.name = "ProviderHttpError";
  }
}

function isProviderAuthFailure(err: unknown): err is ProviderHttpError {
  return (
    err instanceof ProviderHttpError &&
    (err.upstreamStatus === 401 || err.upstreamStatus === 403)
  );
}

// Capitalize a provider slug for user-facing copy. The desktop has a
// richer toolkitDisplayName in src/lib/toolkitDisplay.ts but it isn't
// accessible from the main process; this covers the providers that show
// up in proxy whoami today (curated Hero pool) with a generic fallback
// for everything else.
function composioToolkitDisplayName(slug: string | null | undefined): string {
  const normalized = (slug ?? "").trim().toLowerCase();
  const KNOWN: Record<string, string> = {
    github: "GitHub",
    gmail: "Gmail",
    google: "Google",
    googlesheets: "Google Sheets",
    twitter: "Twitter / X",
    linkedin: "LinkedIn",
    reddit: "Reddit",
    notion: "Notion",
    slack: "Slack",
    discord: "Discord",
  };
  if (KNOWN[normalized]) return KNOWN[normalized];
  if (!normalized) return "the provider";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

/**
 * Call a provider's own API as the connected account, via Composio's
 * proxy. Used for whoami fallbacks when Composio's generic
 * `/api/composio/account/{id}` endpoint doesn't carry provider-side
 * identity (notably Twitter/X). `endpoint` is the absolute provider
 * URL — Composio attaches the connection's auth and forwards.
 */
async function composioProxyFetch<TData>(
  connectedAccountId: string,
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
  // Passed through purely for ProviderHttpError context; not used in the
  // request. Lets the caller see which provider the error came from when
  // they don't have it on hand to attach themselves.
  providerIdForErrors = "unknown",
): Promise<TData | null> {
  const wrapped = await composioFetch<ComposioProxyResponse<TData>>(
    "/api/composio/proxy",
    "POST",
    {
      connected_account_id: connectedAccountId,
      endpoint,
      method,
      ...(body !== undefined ? { body } : {}),
    },
  );
  if (wrapped.status >= 400) {
    const excerpt = (() => {
      try {
        return JSON.stringify(wrapped.data).slice(0, 200);
      } catch {
        return String(wrapped.data).slice(0, 200);
      }
    })();
    throw new ProviderHttpError(
      providerIdForErrors,
      wrapped.status,
      excerpt,
    );
  }
  return wrapped.data ?? null;
}

/**
 * Per-provider whoami via Composio proxy. When the toolkit's response
 * shape differs from the generic identity columns, we read the
 * provider's native user-me response and project handle / displayName /
 * avatarUrl out. Keep this table small — only providers where the
 * generic Composio whoami doesn't return identity (Twitter/X, etc.)
 * actually need a proxy fallback.
 */
interface ProxyWhoamiConfig {
  url: string;
  method: "GET" | "POST";
  body?: unknown;
  extract: (data: unknown) => Partial<ExtractedIdentity>;
}

function pickString(value: unknown): string | null {
  return trimOrNull(typeof value === "string" ? value : null);
}

const PROVIDER_PROXY_WHOAMI: Record<string, ProxyWhoamiConfig> = {
  twitter: {
    url: "https://api.x.com/2/users/me?user.fields=username,name,profile_image_url",
    method: "GET",
    extract: (raw) => {
      const root = (raw as { data?: unknown } | null)?.data ?? raw;
      const user = root as Record<string, unknown> | null;
      if (!user) return {};
      return {
        handle: pickString(user.username) ?? pickString(user.screen_name),
        displayName: pickString(user.name),
        avatarUrl:
          pickString(user.profile_image_url) ??
          pickString((user as Record<string, unknown>).profile_image_url_https),
      };
    },
  },
  x: {
    url: "https://api.x.com/2/users/me?user.fields=username,name,profile_image_url",
    method: "GET",
    extract: (raw) => {
      const root = (raw as { data?: unknown } | null)?.data ?? raw;
      const user = root as Record<string, unknown> | null;
      if (!user) return {};
      return {
        handle: pickString(user.username) ?? pickString(user.screen_name),
        displayName: pickString(user.name),
        avatarUrl:
          pickString(user.profile_image_url) ??
          pickString((user as Record<string, unknown>).profile_image_url_https),
      };
    },
  },
  reddit: {
    url: "https://oauth.reddit.com/api/v1/me",
    method: "GET",
    extract: (raw) => {
      const u = raw as Record<string, unknown> | null;
      if (!u) return {};
      return {
        handle: pickString(u.name),
        avatarUrl: pickString(u.icon_img) ?? pickString(u.snoovatar_img),
      };
    },
  },
  linkedin: {
    url: "https://api.linkedin.com/v2/userinfo",
    method: "GET",
    extract: (raw) => {
      const u = raw as Record<string, unknown> | null;
      if (!u) return {};
      return {
        email: pickString(u.email),
        displayName: pickString(u.name),
        avatarUrl: pickString(u.picture),
      };
    },
  },
  github: {
    url: "https://api.github.com/user",
    method: "GET",
    extract: (raw) => {
      const u = raw as Record<string, unknown> | null;
      if (!u) return {};
      return {
        handle: pickString(u.login),
        email: pickString(u.email),
        displayName: pickString(u.name),
        avatarUrl: pickString(u.avatar_url),
      };
    },
  },
  gmail: {
    url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    method: "GET",
    extract: (raw) => {
      const u = raw as Record<string, unknown> | null;
      if (!u) return {};
      return {
        email: pickString(u.emailAddress),
        displayName: pickString(u.emailAddress),
      };
    },
  },
  // Slack's Web API uses POST for everything (the body can be empty). auth.test
  // returns { ok, user, user_id, team, team_id, url } — handle is `user`, team
  // becomes a useful display name suffix. No email or avatar from this endpoint
  // (would need a second users.info call); leaving them null is fine because
  // composioAccountStatusEnriched only re-stores when at least one field is
  // populated, and handle alone is enough for dedupe.
  slack: {
    url: "https://slack.com/api/auth.test",
    method: "POST",
    body: {},
    extract: (raw) => {
      const u = raw as Record<string, unknown> | null;
      if (!u) return {};
      const user = pickString(u.user);
      const team = pickString(u.team);
      return {
        handle: user,
        displayName: user && team ? `${user} (${team})` : (user ?? team),
      };
    },
  },

  // Google's OIDC userinfo endpoint works for any Google OAuth token
  // with the openid/email/profile scopes — covers Calendar + Drive +
  // Tasks + Sheets connections from one shared shape.
  googlecalendar: {
    url: "https://www.googleapis.com/oauth2/v3/userinfo",
    method: "GET",
    extract: (raw) => {
      const u = raw as Record<string, unknown> | null;
      if (!u) return {};
      return {
        email: pickString(u.email),
        displayName: pickString(u.name),
        avatarUrl: pickString(u.picture),
      };
    },
  },
  googledrive: {
    url: "https://www.googleapis.com/oauth2/v3/userinfo",
    method: "GET",
    extract: (raw) => {
      const u = raw as Record<string, unknown> | null;
      if (!u) return {};
      return {
        email: pickString(u.email),
        displayName: pickString(u.name),
        avatarUrl: pickString(u.picture),
      };
    },
  },

  // Notion's `users.me` returns `{ type: "bot", bot: { owner: { user: {...} } }, ... }`
  // for integration tokens and `{ type: "person", person: { email } }` for
  // OAuth-as-user. Try both shapes.
  notion: {
    url: "https://api.notion.com/v1/users/me",
    method: "GET",
    extract: (raw) => {
      const u = raw as Record<string, unknown> | null;
      if (!u) return {};
      const person = (u.person ?? null) as Record<string, unknown> | null;
      const bot = (u.bot ?? null) as Record<string, unknown> | null;
      const botOwnerUser = (bot?.owner as Record<string, unknown> | undefined)
        ?.user as Record<string, unknown> | undefined;
      const botPerson = (botOwnerUser?.person ?? null) as
        | Record<string, unknown>
        | null;
      return {
        email: pickString(person?.email) ?? pickString(botPerson?.email),
        displayName:
          pickString(u.name) ?? pickString(botOwnerUser?.name),
        avatarUrl: pickString(u.avatar_url),
      };
    },
  },

  // Linear is GraphQL-only. The viewer query is the canonical identity
  // probe; Composio's proxy forwards arbitrary POST bodies.
  linear: {
    url: "https://api.linear.app/graphql",
    method: "POST",
    body: { query: "{ viewer { id name email displayName avatarUrl } }" },
    extract: (raw) => {
      const root = raw as { data?: { viewer?: Record<string, unknown> } } | null;
      const v = root?.data?.viewer ?? null;
      if (!v) return {};
      return {
        email: pickString(v.email),
        displayName: pickString(v.displayName) ?? pickString(v.name),
        avatarUrl: pickString(v.avatarUrl),
      };
    },
  },

  // Figma's REST API has a clean /v1/me.
  figma: {
    url: "https://api.figma.com/v1/me",
    method: "GET",
    extract: (raw) => {
      const u = raw as Record<string, unknown> | null;
      if (!u) return {};
      return {
        handle: pickString(u.handle),
        email: pickString(u.email),
        displayName: pickString(u.handle),
        avatarUrl: pickString(u.img_url),
      };
    },
  },

  // HubSpot — no clean per-user /me endpoint for OAuth tokens. The
  // closest is /oauth/v1/access-tokens/<token> but that needs the raw
  // token (which Composio doesn't surface to us) and returns hub-level
  // metadata, not user identity. Skip; row keeps the persisted label.

  // Stripe — accounts are organisational, not per-user. /v1/account
  // returns business_profile + email, but for the connected_account's
  // shop owner, not a generic user. Skip for now; if users complain
  // about "Stripe (Managed)" we wire it later.

  // Shopify — every shop has its own *.myshopify.com subdomain.
  // /admin/api/2024-01/shop.json works but the URL needs the shop slug,
  // which is on the Composio connection metadata, not on a generic /me.
  // Composio proxy's `endpoint` is an absolute URL — we'd need a
  // per-connection URL builder. Skip until we have multi-shop demand.

  // Mailchimp — same shape as Shopify. Every workspace has its own
  // datacenter prefix (us1, us2, …) in the base URL. Skip until needed.
};

async function tryProxyWhoami(
  connectedAccountId: string,
  providerId: string,
): Promise<Partial<ExtractedIdentity>> {
  const normalized = providerId.toLowerCase();
  const config = PROVIDER_PROXY_WHOAMI[normalized];
  if (!config) {
    // Expected for any toolkit outside the curated Hero pool — the UI
    // falls back to the persisted account_label ("Notion (Managed)"
    // etc.). Drop to debug so this stops looking like a real warning
    // every time the enrichment hook fires for a long-tail toolkit.
    console.debug(
      `[integrations] no proxy whoami config for provider=${normalized}; skipping fallback`,
    );
    return {};
  }
  try {
    const data = await composioProxyFetch<unknown>(
      connectedAccountId,
      config.url,
      config.method,
      config.body,
      normalized,
    );
    if (!data) {
      console.warn(
        `[integrations] proxy whoami for provider=${normalized} returned no data`,
      );
      return {};
    }
    const extracted = config.extract(data);
    if (
      !extracted.handle &&
      !extracted.email &&
      !extracted.displayName &&
      !extracted.avatarUrl
    ) {
      console.warn(
        `[integrations] proxy whoami for provider=${normalized} returned empty identity (raw shape may have shifted):`,
        JSON.stringify(data).slice(0, 300),
      );
    }
    return extracted;
  } catch (err) {
    // Upstream account deleted: re-throw so the IPC layer's existing
    // tombstone catch fires. Hono's /account/:id is KV-cached for 5min,
    // so a deleted ca can still look ACTIVE up there even while the
    // proxy path 606s — without this re-throw, the metadata snapshot
    // never learns the row is dead.
    if (isComposioAccountMissingError(err)) {
      throw err;
    }
    // Provider returned 401/403 — Composio's stored token doesn't work
    // against the provider anymore (user revoked the app, token rotated
    // externally, scope changed). Re-throw so the caller (Refresh button)
    // can surface a specific "needs reconnect" message naming the
    // provider, rather than the generic "shape shifted" copy that
    // used to mask this case.
    if (isProviderAuthFailure(err)) {
      throw err;
    }
    console.warn(
      `[integrations] proxy whoami failed for provider=${normalized}:`,
      err instanceof Error ? err.message : String(err),
    );
    return {};
  }
}

/**
 * Composio account status, enriched with per-provider proxy whoami
 * when the generic endpoint doesn't carry identity. The returned
 * status is shape-compatible with `ComposioAccountStatus` (extra
 * fields like avatarUrl get folded in), so frontend callers don't
 * need to distinguish between the two sources.
 */
async function composioAccountStatusEnriched(
  connectedAccountId: string,
  providerId: string | null | undefined,
): Promise<ComposioAccountStatus> {
  const status = await composioAccountStatus(connectedAccountId);
  if (!providerId) return status;
  const generic = extractComposioIdentity(providerId, status);
  // Skip the proxy round-trip when the generic whoami already covered
  // the basics — this is the common case for GitHub / Gmail / Reddit.
  if (generic.handle || generic.email) return status;
  // Skip proxy whoami unless Composio reports ACTIVE. INITIATED means
  // OAuth is still in progress; EXPIRED means the token's dead. In
  // either case the proxy call would 4xx and the row's identity stays
  // null until the next legitimate state.
  if ((status.status ?? "").toLowerCase() !== "active") return status;
  const proxy = await tryProxyWhoami(connectedAccountId, providerId);
  if (
    !proxy.handle &&
    !proxy.email &&
    !proxy.displayName &&
    !proxy.avatarUrl
  ) {
    return status;
  }
  return {
    ...status,
    handle: status.handle ?? proxy.handle ?? null,
    email: status.email ?? proxy.email ?? null,
    displayName: status.displayName ?? proxy.displayName ?? null,
    avatarUrl: status.avatarUrl ?? proxy.avatarUrl ?? null,
  };
}

/**
 * Extracted identity for a Composio-connected account, normalized across
 * providers. Composio's whoami endpoint populates the top-level
 * `handle/email/displayName/avatarUrl` for some toolkits (GitHub, Gmail)
 * but leaves them empty for others (Twitter/X, Reddit) — the actual
 * provider response gets passed through verbatim under `data` instead.
 * `extractComposioIdentity` reads the top-level fields first and falls
 * back to per-provider extraction from `data` so Twitter handles like
 * `@joshua` no longer show as "Account 1".
 */
function trimOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface ExtractedIdentity {
  handle: string | null;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

function extractComposioIdentity(
  providerId: string,
  status: ComposioAccountStatus,
): ExtractedIdentity {
  let handle = trimOrNull(status.handle);
  let email = trimOrNull(status.email);
  let displayName = trimOrNull(status.displayName);
  let avatarUrl = trimOrNull(status.avatarUrl);

  // Some Composio toolkits put the provider whoami response verbatim
  // under `data`; others wrap it in another `data` key (mirroring
  // provider response shape, e.g. Twitter v2's `{ data: { … } }`).
  const blob =
    status.data && typeof status.data === "object"
      ? ((status.data as Record<string, unknown>).data &&
        typeof (status.data as Record<string, unknown>).data === "object"
          ? ((status.data as Record<string, unknown>).data as Record<string, unknown>)
          : (status.data as Record<string, unknown>))
      : null;

  if (blob) {
    switch (providerId.toLowerCase()) {
      case "twitter":
      case "x":
        handle =
          handle ??
          trimOrNull(blob.username) ??
          trimOrNull(blob.screen_name) ??
          trimOrNull(blob.handle);
        displayName =
          displayName ?? trimOrNull(blob.name) ?? trimOrNull(blob.full_name);
        avatarUrl =
          avatarUrl ??
          trimOrNull(blob.profile_image_url) ??
          trimOrNull(blob.profile_image_url_https);
        break;
      case "github":
        handle = handle ?? trimOrNull(blob.login);
        email = email ?? trimOrNull(blob.email);
        displayName = displayName ?? trimOrNull(blob.name);
        avatarUrl = avatarUrl ?? trimOrNull(blob.avatar_url);
        break;
      case "reddit":
        handle = handle ?? trimOrNull(blob.name);
        avatarUrl =
          avatarUrl ??
          trimOrNull(blob.icon_img) ??
          trimOrNull(blob.snoovatar_img);
        break;
      case "linkedin":
        email = email ?? trimOrNull(blob.email);
        displayName =
          displayName ??
          (typeof blob.given_name === "string" || typeof blob.family_name === "string"
            ? trimOrNull(`${blob.given_name ?? ""} ${blob.family_name ?? ""}`)
            : null);
        avatarUrl = avatarUrl ?? trimOrNull(blob.picture);
        break;
      case "gmail":
      case "googlesheets":
      case "google":
        email = email ?? trimOrNull(blob.email);
        displayName = displayName ?? trimOrNull(blob.name);
        avatarUrl = avatarUrl ?? trimOrNull(blob.picture);
        break;
      default:
        // Best-effort generic field probe — many providers expose
        // `username`/`login`/`screen_name` for handle, `email`, `name`,
        // and `avatar_url` under various names.
        handle =
          handle ??
          trimOrNull(blob.username) ??
          trimOrNull(blob.login) ??
          trimOrNull(blob.screen_name) ??
          trimOrNull(blob.handle);
        email = email ?? trimOrNull(blob.email);
        displayName = displayName ?? trimOrNull(blob.name);
        avatarUrl =
          avatarUrl ??
          trimOrNull(blob.avatar_url) ??
          trimOrNull(blob.picture) ??
          trimOrNull(blob.profile_image_url);
        break;
    }
  }

  return { handle, email, displayName, avatarUrl };
}

async function composioFinalize(payload: {
  connected_account_id: string;
  provider: string;
  owner_user_id: string;
  account_label?: string;
  account_handle?: string | null;
  account_email?: string | null;
}): Promise<IntegrationConnectionPayload> {
  // Resolve the provider-side identity (handle / email / display name) from
  // Composio whoami before posting to /composio/finalize. The runtime uses
  // this identity to dedupe re-auth flows: each Composio re-auth mints a
  // new connected_account_id even for the same real account, but handle /
  // email stay stable, so the integration service updates the existing
  // connection row in place rather than spawning a duplicate.
  //
  // Whoami can fail (Composio side error, account not yet propagated, etc.).
  // When it does, we fall back to the legacy behaviour — store the row
  // without identity, no dedupe — instead of blocking the connect flow.
  let enrichedHandle = payload.account_handle ?? null;
  let enrichedEmail = payload.account_email ?? null;
  let resolvedLabel = payload.account_label;
  if (!enrichedHandle && !enrichedEmail) {
    try {
      const status = await composioAccountStatusEnriched(
        payload.connected_account_id,
        payload.provider,
      );
      const identity = extractComposioIdentity(payload.provider, status);
      enrichedHandle = identity.handle;
      enrichedEmail = identity.email;
      const preferredDisplayName =
        identity.displayName ?? enrichedHandle ?? enrichedEmail ?? null;
      if (preferredDisplayName && (!resolvedLabel || resolvedLabel.trim().length === 0)) {
        resolvedLabel = preferredDisplayName;
      }
    } catch {
      // Whoami failed — proceed without identity. Future reconnects of
      // this same external account will still create a new row until
      // whoami succeeds at least once.
    }
  }

  // Backfill identity on legacy NULL-identity rows for the same
  // (provider, owner). Connections created before identity columns
  // existed have account_handle / account_email = NULL, so the runtime's
  // dedupe-on-finalize finder can't see them as duplicates of the new
  // re-auth — and a fresh row is inserted, leaving the user with two
  // entries for the same real account. We pre-resolve their identity by
  // probing Composio whoami on each legacy row's external_id and PATCH
  // the result back to the runtime. After this loop, the dedupe finder
  // can match the legacy row by handle/email and merge in place.
  if (enrichedHandle || enrichedEmail) {
    try {
      const { connections } = await listIntegrationConnections({
        providerId: payload.provider,
        ownerUserId: payload.owner_user_id,
      });
      const legacyTargets = connections.filter(
        (c) =>
          c.status === "active" &&
          // Skip rows that already happen to point at the new Composio
          // account (could be a same-id re-finalize). Comparing on the
          // *external* id, not the internal connection_id.
          c.account_external_id !== payload.connected_account_id &&
          !c.account_handle &&
          !c.account_email &&
          typeof c.account_external_id === "string" &&
          c.account_external_id.trim().length > 0,
      );
      // Cap concurrent whoami probes — even a power user has a small
      // number of legacy rows, so 4 in-flight is plenty.
      const legacyConcurrency = 4;
      for (let i = 0; i < legacyTargets.length; i += legacyConcurrency) {
        const slice = legacyTargets.slice(i, i + legacyConcurrency);
        await Promise.all(
          slice.map(async (legacy) => {
            try {
              const probe = await composioAccountStatusEnriched(
                legacy.account_external_id as string,
                legacy.provider_id,
              );
              const identity = extractComposioIdentity(legacy.provider_id, probe);
              if (!identity.handle && !identity.email) return;
              await updateIntegrationConnection(legacy.connection_id, {
                account_handle: identity.handle,
                account_email: identity.email,
              });
            } catch {
              // Per-row failure is fine — that row simply won't dedupe
              // this round; we'll try again next time the user connects.
            }
          }),
        );
      }
    } catch {
      // listConnections failure shouldn't block the connect — just skip
      // the backfill pass entirely.
    }
  }

  return normalizeIntegrationConnectionPayload(
    await runtimeClient.integrations.composioFinalize({
      ...payload,
      ...(resolvedLabel ? { account_label: resolvedLabel } : {}),
      account_handle: enrichedHandle,
      account_email: enrichedEmail,
    }),
  );
}

async function composioDeleteUpstream(
  connectedAccountId: string,
): Promise<{ deleted: boolean; missing: boolean }> {
  const trimmed = typeof connectedAccountId === "string" ? connectedAccountId.trim() : "";
  if (!trimmed) {
    return { deleted: false, missing: false };
  }
  try {
    await composioFetch<{ deleted?: boolean }>(
      `/api/composio/connections/${encodeURIComponent(trimmed)}`,
      "DELETE",
    );
    return { deleted: true, missing: false };
  } catch (err) {
    if (isComposioAccountMissingError(err)) {
      return { deleted: false, missing: true };
    }
    // Composio's DELETE returns the upstream's body on non-2xx — 404 there
    // surfaces as "Composio API error (404)" via composioFetch.
    if (err instanceof Error && /\(404\)/.test(err.message)) {
      return { deleted: false, missing: true };
    }
    throw err;
  }
}

async function composioMcpEnsureRunning(workspaceId: string): Promise<unknown> {
  return requestRuntimeJson<unknown>({
    method: "POST",
    path: "/api/v1/composio-mcp/ensure-running",
    payload: { workspace_id: workspaceId },
  });
}

/**
 * Re-run identity enrichment for an existing connection. Reads the
 * connection's `account_external_id`, hits Composio whoami, runs the
 * per-provider extractor, and writes any newly-resolved handle/email
 * back to the connection. Used by the "Refresh" button in
 * IntegrationsPane to fix legacy rows that were created before the
 * per-provider extractor existed (e.g. Twitter rows showing
 * "Account 1") without the user having to disconnect and re-auth.
 *
 * Returns the updated connection (or the unchanged one if the probe
 * yielded no new identity).
 */
interface ComposioRefreshResult {
  connection: IntegrationConnectionPayload;
  /** True iff the probe resolved a new handle or email and we wrote it back. */
  changed: boolean;
  /** Short reason code when `changed === false`, for the UI to surface. */
  reason?:
    | "no_external_id"
    | "account_missing"
    | "no_new_identity"
    | "provider_credentials_rejected";
  /** Provider display name (e.g. "GitHub") — set when the UI needs to name
   *  the specific provider in a reconnect prompt. Currently set alongside
   *  `provider_credentials_rejected` so the message can read "GitHub
   *  credentials rejected" instead of a generic note. */
  providerLabel?: string;
  /** Upstream HTTP status the provider returned (only set with
   *  `provider_credentials_rejected`, typically 401 or 403). */
  providerStatus?: number;
}

async function composioRefreshConnection(
  connectionId: string,
): Promise<ComposioRefreshResult> {
  const trimmed = typeof connectionId === "string" ? connectionId.trim() : "";
  if (!trimmed) {
    throw new Error("composioRefreshConnection: connection_id required");
  }
  const { connections } = await listIntegrationConnections();
  const target = connections.find((c) => c.connection_id === trimmed);
  if (!target) {
    throw new Error(`composioRefreshConnection: connection ${trimmed} not found`);
  }
  if (!target.account_external_id) {
    return { connection: target, changed: false, reason: "no_external_id" };
  }
  let status: ComposioAccountStatus;
  try {
    status = await composioAccountStatusEnriched(
      target.account_external_id,
      target.provider_id,
    );
  } catch (err) {
    if (isComposioAccountMissingError(err)) {
      // Upstream account is gone. Don't blow up the Refresh button —
      // just return the existing row unchanged so the UI surfaces the
      // current persisted identity (Phase 2 / Slice 2 will mark these
      // rows stale + prompt the user to reconnect).
      return { connection: target, changed: false, reason: "account_missing" };
    }
    if (isProviderAuthFailure(err)) {
      // Composio still has the connection but its stored access token
      // failed against the provider (401/403). Surface a typed signal so
      // the UI can render "GitHub credentials rejected — please reconnect"
      // instead of the misleading generic "raw shape may have shifted".
      return {
        connection: target,
        changed: false,
        reason: "provider_credentials_rejected",
        providerLabel: composioToolkitDisplayName(target.provider_id),
        providerStatus: err.upstreamStatus,
      };
    }
    throw err;
  }
  const identity = extractComposioIdentity(target.provider_id, status);
  // Only write fields that gained a value — preserve persisted data on
  // a partial probe (e.g. handle resolved but email still missing).
  const update: { account_handle?: string | null; account_email?: string | null } = {};
  if (identity.handle && identity.handle !== target.account_handle) {
    update.account_handle = identity.handle;
  }
  if (identity.email && identity.email !== target.account_email) {
    update.account_email = identity.email;
  }
  if (Object.keys(update).length === 0) {
    return { connection: target, changed: false, reason: "no_new_identity" };
  }
  const updated = await updateIntegrationConnection(trimmed, update);
  return { connection: updated, changed: true };
}

interface TemplateIntegrationRequirement {
  key: string;
  provider: string;
  required: boolean;
  app_id: string;
}

interface ResolveTemplateIntegrationsResult {
  requirements: TemplateIntegrationRequirement[];
  connected_providers: string[];
  missing_providers: string[];
  provider_logos: Record<string, string>;
}

function extractIntegrationRequirementsFromTemplateFiles(
  files: MaterializedTemplateFilePayload[],
): TemplateIntegrationRequirement[] {
  const requirements: TemplateIntegrationRequirement[] = [];
  const appRuntimePattern = /^apps\/([^/]+)\/app\.runtime\.yaml$/;

  for (const file of files) {
    const match = file.path.match(appRuntimePattern);
    if (!match) continue;
    const appId = match[1];

    let parsed: Record<string, unknown>;
    try {
      const content = Buffer.from(file.content_base64, "base64").toString(
        "utf-8",
      );
      parsed = parseYaml(content) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;

    // List format: integrations: [{ key, provider, required }]
    if (Array.isArray(parsed.integrations)) {
      for (const entry of parsed.integrations) {
        if (entry && typeof entry === "object" && entry.key && entry.provider) {
          requirements.push({
            key: String(entry.key),
            provider: String(entry.provider),
            required: entry.required !== false,
            app_id: appId,
          });
        }
      }
    }
    // Legacy format: integration: { destination, credential_source }
    else if (
      parsed.integration &&
      typeof parsed.integration === "object" &&
      !Array.isArray(parsed.integration)
    ) {
      const legacy = parsed.integration as Record<string, unknown>;
      const destination = legacy.destination
        ? String(legacy.destination)
        : null;
      if (destination) {
        requirements.push({
          key: destination,
          provider: destination,
          required: true,
          app_id: appId,
        });
      }
    }
  }

  return requirements;
}

/**
 * Known app-name → provider mapping. Used to infer integration requirements
 * from template metadata (app names) without materializing the template.
 */
const APP_TO_PROVIDER: Record<string, string> = {
  gmail: "gmail",
  sheets: "googlesheets",
  github: "github",
  reddit: "reddit",
  twitter: "twitter",
  linkedin: "linkedin",
};

async function resolveTemplateIntegrations(
  payload: HolabossCreateWorkspacePayload,
): Promise<ResolveTemplateIntegrationsResult> {
  // Infer requirements from the app names in the payload or selected template
  const appNames: string[] = payload.template_apps ?? [];

  if (appNames.length === 0) {
    return {
      requirements: [],
      connected_providers: [],
      missing_providers: [],
      provider_logos: {},
    };
  }

  const requirements: TemplateIntegrationRequirement[] = [];
  const seenProviders = new Set<string>();

  for (const appName of appNames) {
    const provider = APP_TO_PROVIDER[appName.toLowerCase()];
    if (provider && !seenProviders.has(provider)) {
      seenProviders.add(provider);
      requirements.push({
        key: provider,
        provider,
        required: true,
        app_id: appName,
      });
    }
  }

  if (requirements.length === 0) {
    return {
      requirements: [],
      connected_providers: [],
      missing_providers: [],
      provider_logos: {},
    };
  }

  let connections: IntegrationConnectionPayload[] = [];
  try {
    const resp = await listIntegrationConnections();
    connections = resp.connections;
  } catch {
    // If we cannot reach the integration API, treat all as missing.
  }

  // Fetch toolkit logos from Composio
  const providerLogos: Record<string, string> = {};
  try {
    const { toolkits } = await composioListToolkits();
    for (const toolkit of toolkits) {
      if (toolkit.logo && seenProviders.has(toolkit.slug)) {
        providerLogos[toolkit.slug] = toolkit.logo;
      }
    }
  } catch {
    // Non-fatal — UI will fall back to built-in SVG icons
  }

  const connectedProviderSet = new Set(
    connections.filter((c) => c.status === "active").map((c) => c.provider_id),
  );

  const requiredProviders = [...seenProviders];
  const connectedProviders = requiredProviders.filter((p) =>
    connectedProviderSet.has(p),
  );
  const missingProviders = requiredProviders.filter(
    (p) => !connectedProviderSet.has(p),
  );

  return {
    requirements,
    connected_providers: connectedProviders,
    missing_providers: missingProviders,
    provider_logos: providerLogos,
  };
}

async function updateTaskProposalState(
  workspaceId: string,
  proposalId: string,
  state: string,
): Promise<TaskProposalStateUpdatePayload> {
  return requestWorkspaceRuntimeJson<TaskProposalStateUpdatePayload>(
    workspaceId,
    {
      method: "PATCH",
      path: `/api/v1/task-proposals/${encodeURIComponent(proposalId)}`,
      payload: {
        workspace_id: workspaceId,
        state,
      },
    },
  );
}

const LOCAL_TEMPLATE_IGNORE_NAMES = new Set([
  ".git",
  "node_modules",
  ".output",
  "dist",
  "build",
  ".turbo",
  "coverage",
  ".DS_Store",
  ".holaboss",
  ".opencode",
  "workspace.json",
]);
const LOCAL_TEMPLATE_APP_BINDINGS: Record<string, string[]> = {
  build_in_public: ["github", "twitter"],
  crm: ["gmail", "sheets"],
  gmail_assistant: ["gmail"],
  social_media: ["twitter", "linkedin", "reddit"],
  social_operator: ["twitter", "linkedin", "reddit"],
};
const LOCAL_APP_MCP_PORT_BASE = 13100;
const LOCAL_DEFAULT_APP_MCP_TIMEOUT_MS = 60000;
const LOCAL_MCP_TOOL_CALL_PATTERN = /\btool\(\s*["']([^"']+)["']/g;
const LOCAL_MCP_SOURCE_PATH_PATTERN = /(^|\/)(mcp\.(ts|tsx|js|mjs|cjs|py))$/;

interface LocalAppTemplateBinding {
  lifecycle: Record<string, string> | null;
  path: string | null;
  timeoutMs: number;
  toolNames: string[];
}

function shouldSkipLocalTemplateEntry(name: string) {
  return LOCAL_TEMPLATE_IGNORE_NAMES.has(name);
}

function shouldPreserveWorkspaceRuntimeEntry(name: string) {
  return name === ".holaboss" || name === "workspace.json";
}

function shouldSkipMaterializedWorkspacePath(relativePath: string) {
  const normalized = path.posix.normalize(relativePath.trim());
  if (!normalized || normalized === "." || normalized.startsWith("../")) {
    return false;
  }
  const rootSegment = normalized.split("/")[0];
  return (
    rootSegment === ".holaboss" ||
    rootSegment === ".opencode" ||
    rootSegment === "workspace.json"
  );
}

function decodeMaterializedTemplateFile(
  file: MaterializedTemplateFilePayload,
): string {
  return Buffer.from(file.content_base64, "base64").toString("utf-8");
}

function extractLocalAppToolNames(
  appFiles: MaterializedTemplateFilePayload[],
  declaredToolNames: string[],
): string[] {
  const toolNames = [...declaredToolNames];
  const seenToolNames = new Set(toolNames);
  for (const file of appFiles) {
    if (!LOCAL_MCP_SOURCE_PATH_PATTERN.test(file.path)) {
      continue;
    }
    const source = decodeMaterializedTemplateFile(file);
    for (const match of source.matchAll(LOCAL_MCP_TOOL_CALL_PATTERN)) {
      const toolName = match[1]?.trim();
      if (!toolName || seenToolNames.has(toolName)) {
        continue;
      }
      seenToolNames.add(toolName);
      toolNames.push(toolName);
    }
  }
  return toolNames;
}

function replaceOrAppendMaterializedTemplateFile(
  files: MaterializedTemplateFilePayload[],
  nextFile: MaterializedTemplateFilePayload,
) {
  const index = files.findIndex((file) => file.path === nextFile.path);
  if (index === -1) {
    files.push(nextFile);
    return;
  }
  files[index] = nextFile;
}

function localModulesRootCandidates() {
  return [
    internalOverride("HOLABOSS_MODULES_ROOT"),
    path.resolve(process.cwd(), "..", "..", "holaboss-modules"),
    path.resolve(process.cwd(), "..", "holaboss-modules"),
    path.resolve(app.getAppPath(), "..", "..", "..", "..", "holaboss-modules"),
  ].filter(Boolean);
}

function resolveLocalModulesRoot() {
  for (const candidate of localModulesRootCandidates()) {
    const resolved = path.resolve(candidate);
    if (existsSync(resolved)) {
      return resolved;
    }
  }
  return null;
}

function resolveLocalArchiveTarget():
  | "darwin-arm64"
  | "linux-x64"
  | "win32-x64" {
  const { platform, arch } = process;
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "win32" && arch === "x64") return "win32-x64";
  throw new Error(`Unsupported app archive target: ${platform}/${arch}`);
}

function localAppsRootCandidates() {
  return [
    internalOverride("HOLABOSS_APPS_ROOT"),
    path.resolve(process.cwd(), "..", "..", "hola-boss-apps"),
    path.resolve(process.cwd(), "..", "hola-boss-apps"),
    path.resolve(app.getAppPath(), "..", "..", "..", "..", "hola-boss-apps"),
  ].filter(Boolean) as string[];
}

function resolveLocalAppsRoot(): string | null {
  for (const candidate of localAppsRootCandidates()) {
    const resolved = path.resolve(candidate);
    if (existsSync(resolved)) {
      return resolved;
    }
  }
  return null;
}

interface LocalAppArchiveScanEntry {
  appId: string;
  filePath: string;
  target: string;
}

async function scanLocalAppArchives(): Promise<LocalAppArchiveScanEntry[]> {
  const root = resolveLocalAppsRoot();
  if (!root) return [];
  const distDir = path.join(root, "dist");
  if (!existsSync(distDir)) return [];
  let target: string;
  try {
    target = resolveLocalArchiveTarget();
  } catch {
    return [];
  }
  const files = await fs.readdir(distDir);
  const pattern = new RegExp(`^(.+)-module-${target}\\.tar\\.gz$`);
  const out: LocalAppArchiveScanEntry[] = [];
  for (const name of files) {
    const match = name.match(pattern);
    if (!match) continue;
    out.push({ appId: match[1], filePath: path.join(distDir, name), target });
  }
  return out;
}

async function collectLocalTrackedFiles(
  sourceRoot: string,
): Promise<MaterializedTemplateFilePayload[]> {
  const files: MaterializedTemplateFilePayload[] = [];

  async function walk(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldSkipLocalTemplateEntry(entry.name)) {
        continue;
      }
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      const relativePath = path
        .relative(sourceRoot, absolutePath)
        .split(path.sep)
        .join("/");
      const stats = await fs.lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        files.push({
          path: relativePath,
          content_base64: "",
          executable: false,
          symlink_target: await fs.readlink(absolutePath),
        });
      } else {
        const content = await fs.readFile(absolutePath);
        files.push({
          path: relativePath,
          content_base64: content.toString("base64"),
          executable: Boolean(stats.mode & 0o111),
        });
      }
    }
  }

  await walk(sourceRoot);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function collectLocalDirectoryFiles(
  sourceRoot: string,
  relativeRoot: string,
): Promise<MaterializedTemplateFilePayload[]> {
  const files: MaterializedTemplateFilePayload[] = [];

  async function walk(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".DS_Store") {
        continue;
      }
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      const relativePath = path
        .join(relativeRoot, path.relative(sourceRoot, absolutePath))
        .split(path.sep)
        .join("/");
      const stats = await fs.lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        files.push({
          path: relativePath,
          content_base64: "",
          executable: false,
          symlink_target: await fs.readlink(absolutePath),
        });
      } else {
        const content = await fs.readFile(absolutePath);
        files.push({
          path: relativePath,
          content_base64: content.toString("base64"),
          executable: Boolean(stats.mode & 0o111),
        });
      }
    }
  }

  if (!existsSync(sourceRoot)) {
    return files;
  }

  await walk(sourceRoot);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function extractLocalAppTemplateBinding(
  appFiles: MaterializedTemplateFilePayload[],
  appRuntimeFile: MaterializedTemplateFilePayload | null,
): LocalAppTemplateBinding | null {
  if (!appRuntimeFile) {
    return null;
  }

  const loaded = parseYaml(decodeMaterializedTemplateFile(appRuntimeFile));
  if (!loaded || typeof loaded !== "object") {
    return null;
  }

  const data = loaded as Record<string, unknown>;
  const lifecycleSource =
    data.lifecycle && typeof data.lifecycle === "object"
      ? (data.lifecycle as Record<string, unknown>)
      : null;
  const lifecycle: Record<string, string> = {};
  for (const key of ["setup", "start", "stop"]) {
    const value = lifecycleSource?.[key];
    if (typeof value === "string" && value.trim()) {
      lifecycle[key] = value.trim();
    }
  }

  const mcpSource =
    data.mcp && typeof data.mcp === "object"
      ? (data.mcp as Record<string, unknown>)
      : null;
  const healthchecksSource =
    data.healthchecks && typeof data.healthchecks === "object"
      ? (data.healthchecks as Record<string, unknown>)
      : null;

  let timeoutMs = LOCAL_DEFAULT_APP_MCP_TIMEOUT_MS;
  for (const key of ["mcp", "api"]) {
    const healthcheck = healthchecksSource?.[key];
    if (!healthcheck || typeof healthcheck !== "object") {
      continue;
    }
    const timeoutSeconds = (healthcheck as Record<string, unknown>).timeout_s;
    if (typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds)) {
      timeoutMs = Math.max(1000, Math.round(timeoutSeconds * 1000));
      break;
    }
    if (typeof timeoutSeconds === "string" && timeoutSeconds.trim()) {
      const parsed = Number.parseInt(timeoutSeconds.trim(), 10);
      if (Number.isFinite(parsed)) {
        timeoutMs = Math.max(1000, parsed * 1000);
        break;
      }
    }
  }

  const toolsSource = Array.isArray(data.tools) ? data.tools : [];
  const declaredToolNames = toolsSource
    .map((tool) =>
      tool &&
      typeof tool === "object" &&
      typeof (tool as Record<string, unknown>).name === "string"
        ? String((tool as Record<string, unknown>).name).trim()
        : "",
    )
    .filter(Boolean);
  const toolNames = extractLocalAppToolNames(appFiles, declaredToolNames);

  const mcpEnabled = mcpSource?.enabled !== false;
  const mcpPath =
    mcpEnabled && typeof mcpSource?.path === "string" && mcpSource.path.trim()
      ? mcpSource.path.trim()
      : mcpEnabled
        ? "/mcp"
        : null;

  if (Object.keys(lifecycle).length === 0 && !mcpPath) {
    return null;
  }

  return {
    lifecycle: Object.keys(lifecycle).length > 0 ? lifecycle : null,
    path: mcpPath,
    timeoutMs,
    toolNames,
  };
}

function ensureWorkspaceMcpRegistry(data: Record<string, unknown>): {
  allowlist: Record<string, unknown>;
  toolIds: string[];
  servers: Record<string, unknown>;
} {
  const registry =
    data.mcp_registry && typeof data.mcp_registry === "object"
      ? (data.mcp_registry as Record<string, unknown>)
      : {};
  data.mcp_registry = registry;

  const allowlist =
    registry.allowlist && typeof registry.allowlist === "object"
      ? (registry.allowlist as Record<string, unknown>)
      : {};
  registry.allowlist = allowlist;

  const toolIds = Array.isArray(allowlist.tool_ids)
    ? allowlist.tool_ids.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  allowlist.tool_ids = toolIds;

  const servers =
    registry.servers && typeof registry.servers === "object"
      ? (registry.servers as Record<string, unknown>)
      : {};
  registry.servers = servers;

  if (!registry.catalog || typeof registry.catalog !== "object") {
    registry.catalog = {};
  }

  return { allowlist, toolIds, servers };
}

function appendApplicationToWorkspaceYaml(
  workspaceYamlContent: string,
  appId: string,
  configPath: string,
  appFiles: MaterializedTemplateFilePayload[],
  appIndex: number,
) {
  const loaded = parseYaml(workspaceYamlContent);
  const data =
    loaded && typeof loaded === "object"
      ? (loaded as Record<string, unknown>)
      : {};
  const applications = Array.isArray(data.applications)
    ? [...data.applications]
    : [];
  let applicationEntry = applications.find(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      String((entry as Record<string, unknown>).app_id || "") === appId,
  ) as Record<string, unknown> | undefined;

  if (!applicationEntry) {
    applicationEntry = { app_id: appId, config_path: configPath };
    applications.push(applicationEntry);
  } else {
    applicationEntry.config_path = configPath;
  }
  data.applications = applications;

  const binding = extractLocalAppTemplateBinding(
    appFiles,
    appFiles.find((file) => file.path === "app.runtime.yaml") ?? null,
  );
  if (binding?.lifecycle) {
    applicationEntry.lifecycle = binding.lifecycle;
  }

  if (binding?.path) {
    const { toolIds, servers } = ensureWorkspaceMcpRegistry(data);
    servers[appId] = {
      type: "remote",
      url: `http://localhost:${LOCAL_APP_MCP_PORT_BASE + appIndex}${binding.path}`,
      enabled: true,
      timeout_ms: binding.timeoutMs,
    };
    const seenToolIds = new Set(toolIds);
    for (const toolName of binding.toolNames) {
      const toolId = `${appId}.${toolName}`;
      if (!seenToolIds.has(toolId)) {
        toolIds.push(toolId);
        seenToolIds.add(toolId);
      }
    }
  }

  return stringifyYaml(data, { defaultStringType: "QUOTE_DOUBLE" }).trimEnd();
}

function readLocalTemplateAppIds(
  templateRoot: string,
  workspaceYamlContent: string,
) {
  const loaded = parseYaml(workspaceYamlContent);
  const data =
    loaded && typeof loaded === "object"
      ? (loaded as Record<string, unknown>)
      : {};
  const applications = Array.isArray(data.applications)
    ? data.applications
    : [];
  if (applications.length > 0) {
    return [];
  }

  const templateId =
    (typeof data.template_id === "string" && data.template_id.trim()) ||
    path.basename(templateRoot).trim();
  return LOCAL_TEMPLATE_APP_BINDINGS[templateId] ?? [];
}

async function enrichLocalTemplateWithApps(
  templateRoot: string,
  files: MaterializedTemplateFilePayload[],
): Promise<MaterializedTemplateFilePayload[]> {
  if (process.env.HOLABOSS_INTERNAL_DEV?.trim() !== "1") {
    return files;
  }

  const workspaceYamlFile = files.find(
    (file) => file.path === "workspace.yaml",
  );
  if (!workspaceYamlFile) {
    return files;
  }

  const workspaceYamlContent =
    decodeMaterializedTemplateFile(workspaceYamlFile);
  const appIds = readLocalTemplateAppIds(templateRoot, workspaceYamlContent);
  if (appIds.length === 0) {
    return files;
  }

  const modulesRoot = resolveLocalModulesRoot();
  if (!modulesRoot) {
    throw new Error(
      "Local template enrichment needs holaboss-modules, but no local modules root was found.",
    );
  }

  let nextWorkspaceYaml = workspaceYamlContent;
  const nextFiles = [...files];
  for (const [index, appId] of appIds.entries()) {
    const appRoot = path.join(modulesRoot, appId);
    if (!existsSync(appRoot)) {
      throw new Error(
        `Local template enrichment could not find app module '${appId}' at '${appRoot}'.`,
      );
    }
    const appFiles = await collectLocalTrackedFiles(appRoot);
    const nodeModulesRoot = path.join(appRoot, "node_modules");
    const hasLocalNodeModules = existsSync(nodeModulesRoot);
    for (const appFile of appFiles) {
      let nextFile = appFile;
      if (appFile.path === "app.runtime.yaml") {
        const loaded = parseYaml(decodeMaterializedTemplateFile(appFile));
        const parsed =
          loaded && typeof loaded === "object"
            ? (loaded as Record<string, unknown>)
            : {};
        parsed.app_id = appId;
        if (
          hasLocalNodeModules &&
          parsed.lifecycle &&
          typeof parsed.lifecycle === "object"
        ) {
          const lifecycle = parsed.lifecycle as Record<string, unknown>;
          if (typeof lifecycle.setup === "string" && lifecycle.setup.trim()) {
            lifecycle.setup = `if [ -d node_modules ]; then NODE_OPTIONS=--max-old-space-size=384 npm run build; else ${lifecycle.setup.trim()}; fi`;
          }
        }
        nextFile = {
          ...appFile,
          content_base64: Buffer.from(
            stringifyYaml(parsed, { defaultStringType: "QUOTE_DOUBLE" }),
            "utf-8",
          ).toString("base64"),
        };
      }
      replaceOrAppendMaterializedTemplateFile(nextFiles, {
        ...nextFile,
        path: `apps/${appId}/${nextFile.path}`,
      });
    }
    nextWorkspaceYaml = appendApplicationToWorkspaceYaml(
      nextWorkspaceYaml,
      appId,
      `apps/${appId}/app.runtime.yaml`,
      appFiles,
      index,
    );
  }

  replaceOrAppendMaterializedTemplateFile(nextFiles, {
    path: "workspace.yaml",
    content_base64: Buffer.from(`${nextWorkspaceYaml}\n`, "utf-8").toString(
      "base64",
    ),
    executable: false,
  });
  nextFiles.sort((left, right) => left.path.localeCompare(right.path));
  return nextFiles;
}

async function copyLocalTemplateAppNodeModulesToWorkspace(
  templateRoot: string,
  workspaceId: string,
) {
  if (process.env.HOLABOSS_INTERNAL_DEV?.trim() !== "1") {
    return;
  }

  const workspaceYamlPath = path.join(templateRoot, "workspace.yaml");
  if (!existsSync(workspaceYamlPath)) {
    return;
  }

  const modulesRoot = resolveLocalModulesRoot();
  if (!modulesRoot) {
    return;
  }

  const workspaceYamlContent = await fs.readFile(workspaceYamlPath, "utf-8");
  const appIds = readLocalTemplateAppIds(templateRoot, workspaceYamlContent);
  if (appIds.length === 0) {
    return;
  }

  const workspaceDir = await resolveWorkspaceDir(workspaceId);
  for (const appId of appIds) {
    const sourceNodeModules = path.join(modulesRoot, appId, "node_modules");
    if (!existsSync(sourceNodeModules)) {
      continue;
    }
    const targetNodeModules = path.join(
      workspaceDir,
      "apps",
      appId,
      "node_modules",
    );
    await fs.rm(targetNodeModules, { recursive: true, force: true });
    await fs.cp(sourceNodeModules, targetNodeModules, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
  }
}

async function materializeLocalTemplate(payload: {
  template_root_path: string;
}): Promise<MaterializeTemplateResponsePayload> {
  const templateRoot = path.resolve(payload.template_root_path);
  const workspaceYamlPath = path.join(templateRoot, "workspace.yaml");
  if (!existsSync(workspaceYamlPath)) {
    throw new Error(
      `Template folder '${templateRoot}' is missing workspace.yaml.`,
    );
  }

  const metadata = await parseLocalTemplateMetadata(templateRoot);
  const files = await enrichLocalTemplateWithApps(
    templateRoot,
    await collectLocalTrackedFiles(templateRoot),
  );
  const totalBytes = files.reduce(
    (sum, file) => sum + Buffer.byteLength(file.content_base64, "base64"),
    0,
  );
  return {
    template: {
      name: metadata.name,
      repo: "local",
      path: templateRoot,
      effective_ref: "local",
      effective_commit: null,
      source: "template_folder",
    },
    files,
    file_count: files.length,
    total_bytes: totalBytes,
  };
}

async function materializeMarketplaceTemplate(payload: {
  holaboss_user_id: string;
  template_name: string;
  template_ref?: string | null;
  template_commit?: string | null;
}): Promise<MaterializeTemplateResponsePayload> {
  const client = getMarketplaceAppSdkClient();
  const data = await sdkMaterializeMarketplaceTemplate(payload, { client });
  return data as MaterializeTemplateResponsePayload;
}

async function pickTemplateFolder(): Promise<TemplateFolderSelectionPayload> {
  const ownerWindow = mainWindow ?? BrowserWindow.getFocusedWindow() ?? null;
  const options: OpenDialogOptions = {
    properties: ["openDirectory", "createDirectory"],
    title: "Choose Template Folder",
    buttonLabel: "Use Template Folder",
  };
  const result = ownerWindow
    ? await dialog.showOpenDialog(ownerWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) {
    return {
      canceled: true,
      rootPath: null,
      templateName: null,
      description: null,
    };
  }

  const rootPath = path.resolve(result.filePaths[0]);
  const workspaceYamlPath = path.join(rootPath, "workspace.yaml");
  if (!existsSync(workspaceYamlPath)) {
    throw new Error("Selected folder must contain a workspace.yaml file.");
  }

  const metadata = await parseLocalTemplateMetadata(rootPath);
  return {
    canceled: false,
    rootPath,
    templateName: metadata.name,
    description: metadata.description,
  };
}

async function pickWorkspaceRuntimeFolder(): Promise<WorkspaceRuntimeFolderSelectionPayload> {
  const ownerWindow = mainWindow ?? BrowserWindow.getFocusedWindow() ?? null;
  const options: OpenDialogOptions = {
    properties: ["openDirectory", "createDirectory"],
    title: "Choose Workspace Folder",
    buttonLabel: "Use This Folder",
    message: "Pick an empty folder where this workspace's files will live.",
  };
  const result = ownerWindow
    ? await dialog.showOpenDialog(ownerWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true, rootPath: null };
  }

  const rootPath = path.resolve(result.filePaths[0]);
  if (!path.isAbsolute(rootPath)) {
    throw new Error("Workspace folder path must be absolute.");
  }
  if (existsSync(rootPath)) {
    const stat = statSync(rootPath);
    if (!stat.isDirectory()) {
      throw new Error("Selected path is not a directory.");
    }
    const entries = readdirSync(rootPath).filter((name) => name !== ".DS_Store");
    if (entries.length > 0) {
      throw new Error(
        `Selected folder must be empty (found ${entries.length} items). Pick an empty folder or a new one.`,
      );
    }
  }
  return { canceled: false, rootPath };
}

function runtimeBaseUrl() {
  return `http://127.0.0.1:${runtimeApiPort()}`;
}

async function ensureRuntimeReady() {
  let attemptedRecovery = false;
  for (;;) {
    const status = await startEmbeddedRuntime();
    if (status.status === "running" && status.url) {
      return status;
    }

    const runtimeUrl = status.url ?? runtimeBaseUrl();
    if (status.status === "starting" && runtimeUrl) {
      const healthWait = runtimeStartupHealthWaitOptions(
        status.startupMessage,
      );
      const healthy = await waitForRuntimeHealth(
        runtimeUrl,
        healthWait.attempts,
        healthWait.delayMs,
      );
      if (healthy) {
        const refreshed = await refreshRuntimeStatus();
        if (refreshed.status === "running" && refreshed.url) {
          return refreshed;
        }
      }
    }

    const refreshed = await refreshRuntimeStatus();
    if (refreshed.status === "running" && refreshed.url) {
      return refreshed;
    }

    const failureMessage =
      refreshed.lastError || status.lastError || "Embedded runtime is not ready.";
    if (
      !attemptedRecovery &&
      isRuntimeHealthcheckStartupFailureMessage(failureMessage)
    ) {
      attemptedRecovery = true;
      await stopEmbeddedRuntime();
      await sleep(250);
      continue;
    }

    throw new Error(failureMessage);
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRuntimeHealthcheckStartupFailureMessage(message: string): boolean {
  return message
    .toLowerCase()
    .includes("runtime process started but did not pass health checks");
}

function isTransientRuntimeError(error: unknown): boolean {
  return (
    (error instanceof Error &&
      isRuntimeHealthcheckStartupFailureMessage(error.message)) ||
    sdkIsTransientRuntimeError(error)
  );
}

// Singleton runtime client. Owns retry/timeout/error parsing for every
// runtime call in this process; new endpoints should reach for typed methods
// (`runtimeClient.<domain>.<method>(...)`) or the generic `runtimeClient.request<T>()`
// rather than reintroducing inline fetch.
const runtimeClient = createRuntimeClient({
  getBaseURL: async () => {
    const status = await ensureRuntimeReady();
    if (!status.url) {
      throw new Error("Embedded runtime is not ready (no url yet).");
    }
    return status.url;
  },
});

async function requestRuntimeJsonViaHttp<T>(
  targetUrl: URL,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  payload?: unknown,
  timeoutMs = 15000,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const serializedPayload =
      payload === undefined ? null : JSON.stringify(payload);
    const headers =
      serializedPayload === null
        ? extraHeaders
        : {
            ...(extraHeaders ?? {}),
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(serializedPayload)),
          };
    const request = httpRequest(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || "80",
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method,
        headers,
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const statusCode = response.statusCode ?? 0;
          const body = Buffer.concat(chunks).toString("utf-8");
          if (statusCode < 200 || statusCode >= 300) {
            reject(
              runtimeErrorFromBody(statusCode, response.statusMessage, body),
            );
            return;
          }
          if (statusCode === 204 || !body.trim()) {
            resolve(null as T);
            return;
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch {
            reject(new Error("Runtime returned invalid JSON."));
          }
        });
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error("Runtime request timed out."));
    });
    request.on("error", (error) => {
      reject(error);
    });

    if (serializedPayload !== null) {
      request.write(serializedPayload);
    }
    request.end();
  });
}

async function requestRuntimeJson<T>({
  method,
  path: requestPath,
  payload,
  params,
  timeoutMs,
  retryTransientErrors = false,
}: {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  payload?: unknown;
  params?: Record<string, string | number | boolean | null | undefined>;
  timeoutMs?: number;
  retryTransientErrors?: boolean;
}): Promise<T> {
  const attempts = method === "GET" || retryTransientErrors ? 3 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const status = await ensureRuntimeReady();
      const url = new URL(`${status.url}${requestPath}`);
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          if (value === undefined || value === null || value === "") {
            continue;
          }
          url.searchParams.set(key, String(value));
        }
      }
      return requestRuntimeJsonViaHttp<T>(url, method, payload, timeoutMs);
    } catch (error) {
      if (attempt < attempts && isTransientRuntimeError(error)) {
        await sleep(250 * attempt);
        continue;
      }
      throw error;
    }
  }

  throw new Error("Runtime request failed after retries.");
}

function workspaceHarness() {
  return (
    (process.env.HOLABOSS_RUNTIME_HARNESS || "pi").trim().toLowerCase() || "pi"
  );
}

function normalizeRequestedWorkspaceHarness(
  value: string | null | undefined,
): string {
  const normalized = value?.trim().toLowerCase() || "pi";
  if (normalized === "pi") {
    return "pi";
  }
  throw new Error(`Unsupported workspace harness '${value}'.`);
}

function requestedWorkspaceTemplateMode(
  payload: HolabossCreateWorkspacePayload,
): "template" | "empty" {
  return payload.template_mode === "empty" ||
    payload.template_mode === "empty_onboarding"
    ? "empty"
    : "template";
}

function workspaceDirectoryPath(workspaceId: string) {
  // Hard-validate before path.join so a renderer can't smuggle ".." or
  // path separators in a workspace id and escape the workspace root.
  // assertSafeWorkspaceId rejects /, \, NUL, whitespace, and limits length.
  const safeId = assertSafeWorkspaceId(workspaceId);
  const root = runtimeWorkspaceRoot();
  const joined = path.join(root, safeId);
  // Belt-and-suspenders: even if SAFE_ID_REGEX is later relaxed, ensure
  // the resolved path is still under the workspace root.
  const resolved = path.resolve(joined);
  const resolvedRoot = path.resolve(root);
  if (
    resolved !== resolvedRoot &&
    !resolved.startsWith(resolvedRoot + path.sep)
  ) {
    throw new Error(`workspaceId resolves outside workspace root: ${workspaceId}`);
  }
  return joined;
}

// Cache of workspaceId -> absolute directory. Populated from runtime GET
// responses and from the create-workspace response. Custom-path workspaces
// live outside runtimeWorkspaceRoot() and can't be derived deterministically
// from the id, so call sites that need the on-disk path must go through
// resolveWorkspaceDir() instead of workspaceDirectoryPath().
const workspaceDirCache = new Map<string, string>();

function rememberWorkspaceDir(workspaceId: string, workspacePath: string | null | undefined): void {
  const trimmed = (workspacePath ?? "").trim();
  if (!trimmed) {
    return;
  }
  const safeId = assertSafeWorkspaceId(workspaceId);
  workspaceDirCache.set(safeId, path.resolve(trimmed));
}

function forgetWorkspaceDir(workspaceId: string): void {
  try {
    workspaceDirCache.delete(assertSafeWorkspaceId(workspaceId));
  } catch {
    // Ignore unsafe ids — they have no cache entry.
  }
}

const workspaceRuntimeSessionCache = new Map<
  string,
  WorkspaceRuntimeSessionPayload
>();
const cloudWorkspaceRecordCache = new Map<string, WorkspaceRecordPayload>();

function localWorkspaceLocation(): WorkspaceLocationPayload {
  return "local";
}

function cloudWorkspaceLocation(): WorkspaceLocationPayload {
  return "cloud";
}

function withWorkspaceLocation(
  workspace:
    | Omit<WorkspaceRecordPayload, "location">
    | WorkspaceRecordPayload
    | null
    | undefined,
): WorkspaceRecordPayload | null {
  if (!workspace) {
    return null;
  }
  return {
    ...workspace,
    location: localWorkspaceLocation(),
  };
}

function withCloudWorkspaceLocation(
  workspace:
    | Omit<WorkspaceRecordPayload, "location">
    | WorkspaceRecordPayload
    | null
    | undefined,
): WorkspaceRecordPayload | null {
  if (!workspace) {
    return null;
  }
  return {
    ...workspace,
    location: cloudWorkspaceLocation(),
  };
}

function withWorkspaceResponseLocation(
  response: Omit<WorkspaceResponsePayload, "workspace"> & {
    workspace: Omit<WorkspaceRecordPayload, "location"> | WorkspaceRecordPayload;
  },
): WorkspaceResponsePayload {
  return {
    ...response,
    workspace: withWorkspaceLocation(response.workspace)!,
  };
}

function withWorkspaceListLocation(
  response: Omit<WorkspaceListResponsePayload, "items"> & {
    items: Array<Omit<WorkspaceRecordPayload, "location"> | WorkspaceRecordPayload>;
  },
): WorkspaceListResponsePayload {
  return {
    ...response,
    items: response.items
      .map((item) => withWorkspaceLocation(item))
      .filter((item): item is WorkspaceRecordPayload => item !== null),
  };
}

function withWorkspaceLifecycleLocation(
  lifecycle: WorkspaceLifecyclePayload,
): WorkspaceLifecyclePayload {
  return {
    ...lifecycle,
    workspace: withWorkspaceLocation(lifecycle.workspace)!,
  };
}
function withCloudWorkspaceResponseLocation(
  response: Omit<WorkspaceResponsePayload, "workspace"> & {
    workspace: Omit<WorkspaceRecordPayload, "location"> | WorkspaceRecordPayload;
  },
): WorkspaceResponsePayload {
  return {
    ...response,
    workspace: withCloudWorkspaceLocation(response.workspace)!,
  };
}

function withCloudWorkspaceListLocation(
  response: Omit<WorkspaceListResponsePayload, "items"> & {
    items: Array<Omit<WorkspaceRecordPayload, "location"> | WorkspaceRecordPayload>;
  },
): WorkspaceListResponsePayload {
  return {
    ...response,
    items: response.items
      .map((item) => withCloudWorkspaceLocation(item))
      .filter((item): item is WorkspaceRecordPayload => item !== null),
  };
}

function withCloudWorkspaceLifecycleLocation(
  lifecycle: Omit<WorkspaceLifecyclePayload, "workspace"> & {
    workspace: Omit<WorkspaceRecordPayload, "location"> | WorkspaceRecordPayload;
  },
): WorkspaceLifecyclePayload {
  return {
    ...lifecycle,
    workspace: withCloudWorkspaceLocation(lifecycle.workspace)!,
  };
}
function resolveLocalWorkspaceRootPath(rawWorkspaceRoot: string): string {
  const normalizedPath = path.resolve(rawWorkspaceRoot);
  if (!path.isAbsolute(normalizedPath)) {
    throw new Error("Local workspace root must be an absolute path.");
  }
  return normalizedPath;
}

function localWorkspaceRootFromSession(
  session: WorkspaceRuntimeSessionPayload,
): string {
  if (session.location !== "local") {
    throw new Error(
      `Workspace ${session.workspace_id} is not available on the local filesystem.`,
    );
  }
  return resolveLocalWorkspaceRootPath(session.workspace_root);
}

function normalizeWorkspaceRuntimeSession(
  session: WorkspaceRuntimeSessionPayload,
): WorkspaceRuntimeSessionPayload {
  const location = session.location === "cloud"
    ? cloudWorkspaceLocation()
    : localWorkspaceLocation();
  const workspaceRoot = location === "local"
    ? localWorkspaceRootFromSession(session)
    : (session.workspace_root || "").trim() || "/workspace";
  return {
    ...session,
    location,
    workspace_id: assertSafeWorkspaceId(session.workspace_id),
    runtime_base_url: trimTrailingSlash(session.runtime_base_url.trim()),
    runtime_auth_token: (session.runtime_auth_token ?? "").trim() || null,
    workspace_root: workspaceRoot,
  };
}

function cacheWorkspaceRuntimeSession(
  session: WorkspaceRuntimeSessionPayload,
): WorkspaceRuntimeSessionPayload {
  const normalized = normalizeWorkspaceRuntimeSession(session);
  workspaceRuntimeSessionCache.set(normalized.workspace_id, normalized);
  return normalized;
}

function forgetWorkspaceRuntimeSession(workspaceId: string): void {
  try {
    workspaceRuntimeSessionCache.delete(assertSafeWorkspaceId(workspaceId));
  } catch {
    // Ignore unsafe ids — they have no cache entry.
  }
}

function workspaceRuntimeSessionHeaders(
  session: WorkspaceRuntimeSessionPayload,
): Record<string, string> | undefined {
  const authToken = (session.runtime_auth_token ?? "").trim();
  return authToken ? { "X-API-Key": authToken } : undefined;
}

async function buildWorkspaceRuntimeSession(
  workspaceId: string,
): Promise<WorkspaceRuntimeSessionPayload> {
  const safeWorkspaceId = assertSafeWorkspaceId(workspaceId);
  const location = await resolveWorkspaceLocation(safeWorkspaceId);
  if (location === "cloud") {
    const session = await fetchCloudWorkspaceOpenSession(safeWorkspaceId);
    return {
      workspace_id: session.workspace_id,
      location: session.location,
      runtime_base_url: session.runtime_base_url,
      runtime_auth_token: session.runtime_auth_token,
      workspace_root: session.workspace_root,
    };
  }
  const status = await ensureRuntimeReady();
  return {
    workspace_id: safeWorkspaceId,
    location: localWorkspaceLocation(),
    runtime_base_url: status.url ?? runtimeBaseUrl(),
    runtime_auth_token: null,
    workspace_root: resolveLocalWorkspaceRootPath(
      await resolveWorkspaceDir(safeWorkspaceId),
    ),
  };
}

async function resolveWorkspaceRuntimeSession(
  workspaceId: string,
  options: { refresh?: boolean } = {},
): Promise<WorkspaceRuntimeSessionPayload> {
  const safeWorkspaceId = assertSafeWorkspaceId(workspaceId);
  if (!options.refresh) {
    const cached = workspaceRuntimeSessionCache.get(safeWorkspaceId);
    if (cached) {
      return cached;
    }
  }
  return cacheWorkspaceRuntimeSession(
    await buildWorkspaceRuntimeSession(safeWorkspaceId),
  );
}

async function resolveLocalWorkspaceRoot(
  workspaceId: string,
  options: { refresh?: boolean } = {},
): Promise<string> {
  const session = await resolveWorkspaceRuntimeSession(workspaceId, options);
  return localWorkspaceRootFromSession(session);
}

async function ensureLocalWorkspaceRuntimeSessionReady(
  session: WorkspaceRuntimeSessionPayload,
): Promise<WorkspaceRuntimeSessionPayload> {
  if (session.location !== "local") {
    return session;
  }
  if (runtimeStatus.status === "running" && session.runtime_base_url.trim()) {
    return session;
  }
  const status = await ensureRuntimeReady();
  return cacheWorkspaceRuntimeSession({
    ...session,
    runtime_base_url: status.url ?? runtimeBaseUrl(),
  });
}
async function requestWorkspaceRuntimeJson<T>(
  workspaceId: string,
  {
    method,
    path: requestPath,
    payload,
    params,
    timeoutMs,
    retryTransientErrors = false,
  }: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    payload?: unknown;
    params?: Record<string, string | number | boolean | null | undefined>;
    timeoutMs?: number;
    retryTransientErrors?: boolean;
  },
): Promise<T> {
  const safeWorkspaceId = assertSafeWorkspaceId(workspaceId);
  const attempts = method === "GET" || retryTransientErrors ? 3 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const session = await ensureLocalWorkspaceRuntimeSessionReady(
        await resolveWorkspaceRuntimeSession(safeWorkspaceId, {
          refresh: attempt > 1,
        }),
      );
      const url = new URL(`${session.runtime_base_url}${requestPath}`);
      if (params) {
        for (const [key, value] of Object.entries(params)) {
          if (value === undefined || value === null || value === "") {
            continue;
          }
          url.searchParams.set(key, String(value));
        }
      }
      return requestRuntimeJsonViaHttp<T>(
        url,
        method,
        payload,
        timeoutMs,
        workspaceRuntimeSessionHeaders(session),
      );
    } catch (error) {
      if (attempt < attempts && isTransientRuntimeError(error)) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Workspace runtime request failed after retries.");
}

async function resolveWorkspaceDir(workspaceId: string): Promise<string> {
  const safeId = assertSafeWorkspaceId(workspaceId);
  const cached = workspaceDirCache.get(safeId);
  if (cached) {
    return cached;
  }
  try {
    const response = await runtimeClient.workspaces.get(safeId);
    const registered = response.workspace.workspace_path?.trim() || "";
    if (registered) {
      const resolved = path.resolve(registered);
      workspaceDirCache.set(safeId, resolved);
      return resolved;
    }
  } catch {
    // Fall through to the default (runtime may be unavailable at this moment).
  }
  return workspaceDirectoryPath(safeId);
}

// Synchronous lookup for hot paths (event listeners that can't await —
// e.g. session.on("will-download")). Returns the cached custom path when
// known, otherwise falls back to the default deterministic layout.
function resolveWorkspaceDirSync(workspaceId: string): string {
  const safeId = assertSafeWorkspaceId(workspaceId);
  const cached = workspaceDirCache.get(safeId);
  if (cached) {
    return cached;
  }
  return workspaceDirectoryPath(safeId);
}

function resolveWorkspaceDownloadTargetPath(
  workspaceId: string,
  filename: string,
): string {
  const downloadsDir = path.join(
    resolveWorkspaceDirSync(workspaceId),
    "Downloads",
  );
  mkdirSync(downloadsDir, { recursive: true });

  const sanitizedFilename = sanitizeAttachmentName(filename || "download");
  const parsed = path.parse(sanitizedFilename);
  const basename = parsed.name || "download";
  const extension = parsed.ext || "";

  let candidate = `${basename}${extension}`;
  let candidatePath = path.join(downloadsDir, candidate);
  let index = 2;
  while (existsSync(candidatePath)) {
    candidate = `${basename}-${index}${extension}`;
    candidatePath = path.join(downloadsDir, candidate);
    index += 1;
  }

  return candidatePath;
}

function sanitizeAttachmentName(name: string): string {
  const basename = path.basename(name || "").trim();
  const sanitized = basename
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || "attachment";
}

function dedupeAttachmentName(name: string, usedNames: Set<string>): string {
  const parsed = path.parse(name);
  const basename = parsed.name || "attachment";
  const extension = parsed.ext || "";
  let candidate = `${basename}${extension}`;
  let index = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${basename}-${index}${extension}`;
    index += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function attachmentMimeType(name: string, mimeType?: string | null): string {
  const normalized = (mimeType ?? "").trim().toLowerCase();
  if (normalized && normalized !== "application/octet-stream") {
    return normalized;
  }

  switch (path.extname(name).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".ts":
      return "text/typescript";
    case ".tsx":
      return "text/tsx";
    case ".js":
      return "text/javascript";
    case ".jsx":
      return "text/jsx";
    case ".css":
      return "text/css";
    case ".html":
      return "text/html";
    default:
      return "application/octet-stream";
  }
}

function attachmentKind(mimeType: string): "image" | "file" {
  return mimeType.startsWith("image/") ? "image" : "file";
}

function relativeWorkspaceAttachmentPath(
  workspaceDir: string,
  absolutePath: string,
): string {
  const relativePath = path.relative(workspaceDir, absolutePath);
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("Folder attachments must stay inside the workspace.");
  }
  return relativePath.split(path.sep).join(path.posix.sep);
}

function resolveWorkspaceMaterializedFilePath(
  workspaceRoot: string,
  relativePath: string,
) {
  const normalized = path.posix.normalize(relativePath.trim());
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("/") ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Invalid template file path: ${relativePath}`);
  }
  if (
    normalized
      .split("/")
      .some((part) => part === "." || part === ".." || part.length === 0)
  ) {
    throw new Error(`Invalid template file path: ${relativePath}`);
  }
  const absolute = path.resolve(workspaceRoot, normalized);
  const relativeToRoot = path.relative(workspaceRoot, absolute);
  if (
    relativeToRoot === "" ||
    relativeToRoot.startsWith("..") ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new Error(`Template file escaped workspace root: ${relativePath}`);
  }
  return absolute;
}

async function applyMaterializedTemplateToWorkspace(
  workspaceId: string,
  files: MaterializedTemplateFilePayload[],
) {
  const workspaceDir = await resolveWorkspaceDir(workspaceId);
  await fs.mkdir(workspaceDir, { recursive: true });

  const existingEntries = await fs.readdir(workspaceDir, {
    withFileTypes: true,
  });
  await Promise.all(
    existingEntries
      .filter((entry) => !shouldPreserveWorkspaceRuntimeEntry(entry.name))
      .map((entry) =>
        fs.rm(path.join(workspaceDir, entry.name), {
          recursive: true,
          force: true,
        }),
      ),
  );

  for (const item of files) {
    if (shouldSkipMaterializedWorkspacePath(item.path)) {
      continue;
    }
    const absolutePath = resolveWorkspaceMaterializedFilePath(
      workspaceDir,
      item.path,
    );
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    if (typeof item.symlink_target === "string" && item.symlink_target.trim()) {
      await fs.symlink(item.symlink_target, absolutePath);
    } else {
      const content = Buffer.from(item.content_base64, "base64");
      await fs.writeFile(absolutePath, content);
      if (item.executable) {
        await fs.chmod(absolutePath, 0o755);
      }
    }
  }
}

async function stageSessionAttachments(
  payload: StageSessionAttachmentsPayload,
): Promise<StageSessionAttachmentsResponsePayload> {
  const workspaceId = payload.workspace_id?.trim();
  if (!workspaceId) {
    throw new Error("workspace_id is required");
  }

  const files = Array.isArray(payload.files) ? payload.files : [];
  if (files.length === 0) {
    return { attachments: [] };
  }

  const workspaceDir = await resolveWorkspaceDir(workspaceId);
  await fs.mkdir(workspaceDir, { recursive: true });

  const batchId = randomUUID();
  const relativeRoot = path.posix.join(
    ".holaboss",
    "input-attachments",
    batchId,
  );
  const absoluteRoot = resolveWorkspaceMaterializedFilePath(
    workspaceDir,
    relativeRoot,
  );
  await fs.mkdir(absoluteRoot, { recursive: true });

  const usedNames = new Set<string>();
  const attachments: SessionInputAttachmentPayload[] = [];
  for (const [index, file] of files.entries()) {
    const contentBase64 =
      typeof file?.content_base64 === "string"
        ? file.content_base64.trim()
        : "";
    if (!contentBase64) {
      throw new Error(`files[${index}].content_base64 is required`);
    }

    const name = dedupeAttachmentName(
      sanitizeAttachmentName(file?.name ?? ""),
      usedNames,
    );
    const relativePath = path.posix.join(relativeRoot, name);
    const absolutePath = resolveWorkspaceMaterializedFilePath(
      workspaceDir,
      relativePath,
    );
    const content = Buffer.from(contentBase64, "base64");
    await fs.writeFile(absolutePath, content);

    const mimeType = attachmentMimeType(name, file?.mime_type);
    attachments.push({
      id: randomUUID(),
      kind: attachmentKind(mimeType),
      name,
      mime_type: mimeType,
      size_bytes: content.byteLength,
      workspace_path: relativePath,
    });
  }

  return { attachments };
}

async function stageSessionAttachmentPaths(
  payload: StageSessionAttachmentPathsPayload,
): Promise<StageSessionAttachmentsResponsePayload> {
  const workspaceId = payload.workspace_id?.trim();
  if (!workspaceId) {
    throw new Error("workspace_id is required");
  }

  const files = Array.isArray(payload.files) ? payload.files : [];
  if (files.length === 0) {
    return { attachments: [] };
  }

  const workspaceDir = await resolveWorkspaceDir(workspaceId);
  await fs.mkdir(workspaceDir, { recursive: true });

  const batchId = randomUUID();
  let relativeRoot: string | null = null;
  let absoluteRoot: string | null = null;

  const usedNames = new Set<string>();
  const attachments: SessionInputAttachmentPayload[] = [];
  for (const [index, file] of files.entries()) {
    const absolutePath =
      typeof file?.absolute_path === "string"
        ? path.resolve(file.absolute_path)
        : "";
    if (!absolutePath) {
      throw new Error(`files[${index}].absolute_path is required`);
    }

    const stat = await fs.stat(absolutePath);
    const requestedKind =
      file?.kind === "folder"
        ? "folder"
        : file?.kind === "image"
          ? "image"
          : "file";

    if (requestedKind === "folder") {
      if (!stat.isDirectory()) {
        throw new Error(`files[${index}] must reference a folder`);
      }

      attachments.push({
        id: randomUUID(),
        kind: "folder",
        name:
          sanitizeAttachmentName(file?.name ?? path.basename(absolutePath)) ||
          path.basename(absolutePath) ||
          "Folder",
        mime_type: "inode/directory",
        size_bytes: 0,
        workspace_path: relativeWorkspaceAttachmentPath(
          workspaceDir,
          absolutePath,
        ),
      });
      continue;
    }

    if (!stat.isFile()) {
      throw new Error(`files[${index}] must reference a file`);
    }

    if (!relativeRoot || !absoluteRoot) {
      relativeRoot = path.posix.join(
        ".holaboss",
        "input-attachments",
        batchId,
      );
      absoluteRoot = resolveWorkspaceMaterializedFilePath(
        workspaceDir,
        relativeRoot,
      );
      await fs.mkdir(absoluteRoot, { recursive: true });
    }

    const name = dedupeAttachmentName(
      sanitizeAttachmentName(file?.name ?? path.basename(absolutePath)),
      usedNames,
    );
    const relativePath = path.posix.join(relativeRoot, name);
    const targetPath = resolveWorkspaceMaterializedFilePath(
      workspaceDir,
      relativePath,
    );
    await fs.copyFile(absolutePath, targetPath);

    const mimeType = attachmentMimeType(name, file?.mime_type);
    attachments.push({
      id: randomUUID(),
      kind: attachmentKind(mimeType),
      name,
      mime_type: mimeType,
      size_bytes: stat.size,
      workspace_path: relativePath,
    });
  }

  return { attachments };
}

function cloneRuntimeStateRecord(
  record: SessionRuntimeRecordPayload,
): SessionRuntimeRecordPayload {
  return {
    ...record,
    last_error:
      record.last_error && typeof record.last_error === "object"
        ? { ...record.last_error }
        : null,
  };
}

function cachedRuntimeStateRecords(
  workspaceId: string,
): SessionRuntimeRecordPayload[] {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) {
    return [];
  }
  const workspaceRecords = sessionRuntimeStateCache.get(normalizedWorkspaceId);
  if (!workspaceRecords) {
    return [];
  }
  return Array.from(workspaceRecords.values()).map((record) =>
    cloneRuntimeStateRecord(record),
  );
}

function normalizeRuntimeStateRecord(
  record: SessionRuntimeRecordPayload,
): SessionRuntimeRecordPayload | null {
  const workspaceId = record.workspace_id.trim();
  const sessionId = browserSessionId(record.session_id);
  if (!workspaceId || !sessionId) {
    return null;
  }
  const now = utcNowIso();
  return {
    workspace_id: workspaceId,
    session_id: sessionId,
    status: record.status?.trim() || "IDLE",
    effective_state: record.effective_state?.trim() || null,
    runtime_status: record.runtime_status?.trim() || null,
    has_queued_inputs: record.has_queued_inputs === true,
    current_input_id: record.current_input_id ?? null,
    current_worker_id: record.current_worker_id ?? null,
    lease_until: record.lease_until ?? null,
    heartbeat_at: record.heartbeat_at ?? null,
    last_error:
      record.last_error && typeof record.last_error === "object"
        ? { ...record.last_error }
        : null,
    last_turn_status: record.last_turn_status ?? null,
    last_turn_completed_at: record.last_turn_completed_at ?? null,
    last_turn_stop_reason: record.last_turn_stop_reason ?? null,
    created_at: record.created_at || now,
    updated_at: record.updated_at || now,
  };
}

function cacheRuntimeStateRecords(
  workspaceId: string,
  items: SessionRuntimeRecordPayload[],
): SessionRuntimeRecordPayload[] {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) {
    return [];
  }
  const workspaceRecords = new Map<string, SessionRuntimeRecordPayload>();
  const normalizedItems: SessionRuntimeRecordPayload[] = [];
  for (const item of items) {
    const normalized = normalizeRuntimeStateRecord({
      ...item,
      workspace_id: normalizedWorkspaceId,
    });
    if (!normalized) {
      continue;
    }
    workspaceRecords.set(normalized.session_id, normalized);
    normalizedItems.push(cloneRuntimeStateRecord(normalized));
  }
  sessionRuntimeStateCache.set(normalizedWorkspaceId, workspaceRecords);
  return normalizedItems;
}

function cloneAgentSessionRecord(
  record: AgentSessionRecordPayload,
): AgentSessionRecordPayload {
  return { ...record };
}

function normalizeAgentSessionRecord(
  record: AgentSessionRecordPayload,
): AgentSessionRecordPayload | null {
  const workspaceId = record.workspace_id.trim();
  const sessionId = browserSessionId(record.session_id);
  if (!workspaceId || !sessionId) {
    return null;
  }
  const now = utcNowIso();
  return {
    workspace_id: workspaceId,
    session_id: sessionId,
    kind: record.kind?.trim() || "session",
    title: typeof record.title === "string" ? record.title : null,
    parent_session_id: record.parent_session_id?.trim() || null,
    source_proposal_id: record.source_proposal_id?.trim() || null,
    created_by: record.created_by?.trim() || null,
    source_type: record.source_type?.trim() || null,
    cronjob_id: record.cronjob_id?.trim() || null,
    proposal_id: record.proposal_id?.trim() || null,
    created_at: record.created_at || now,
    updated_at: record.updated_at || record.created_at || now,
    archived_at: record.archived_at?.trim() || null,
  };
}

function cacheAgentSessionRecords(
  workspaceId: string,
  items: AgentSessionRecordPayload[],
): AgentSessionRecordPayload[] {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) {
    return [];
  }
  const workspaceRecords = new Map<string, AgentSessionRecordPayload>();
  const normalizedItems: AgentSessionRecordPayload[] = [];
  for (const item of items) {
    const normalized = normalizeAgentSessionRecord({
      ...item,
      workspace_id: normalizedWorkspaceId,
    });
    if (!normalized) {
      continue;
    }
    workspaceRecords.set(normalized.session_id, normalized);
    normalizedItems.push(cloneAgentSessionRecord(normalized));
  }
  agentSessionCache.set(normalizedWorkspaceId, workspaceRecords);
  return normalizedItems;
}

function upsertCachedAgentSessionRecord(
  record: AgentSessionRecordPayload,
): AgentSessionRecordPayload | null {
  const normalized = normalizeAgentSessionRecord(record);
  if (!normalized) {
    return null;
  }
  let workspaceRecords = agentSessionCache.get(normalized.workspace_id);
  if (!workspaceRecords) {
    workspaceRecords = new Map<string, AgentSessionRecordPayload>();
    agentSessionCache.set(normalized.workspace_id, workspaceRecords);
  }
  workspaceRecords.set(normalized.session_id, normalized);
  return cloneAgentSessionRecord(normalized);
}

function cachedAgentSessionRecords(
  workspaceId: string,
): AgentSessionRecordPayload[] {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) {
    return [];
  }
  const workspaceRecords = agentSessionCache.get(normalizedWorkspaceId);
  if (!workspaceRecords) {
    return [];
  }
  return Array.from(workspaceRecords.values()).map((record) =>
    cloneAgentSessionRecord(record),
  );
}

function upsertCachedRuntimeStateRecord(
  record: SessionRuntimeRecordPayload,
): SessionRuntimeRecordPayload | null {
  const normalized = normalizeRuntimeStateRecord(record);
  if (!normalized) {
    return null;
  }
  let workspaceRecords = sessionRuntimeStateCache.get(normalized.workspace_id);
  if (!workspaceRecords) {
    workspaceRecords = new Map<string, SessionRuntimeRecordPayload>();
    sessionRuntimeStateCache.set(normalized.workspace_id, workspaceRecords);
  }
  workspaceRecords.set(normalized.session_id, normalized);
  return cloneRuntimeStateRecord(normalized);
}

function getCachedRuntimeStateRecord(
  workspaceId: string,
  sessionId: string,
): SessionRuntimeRecordPayload | null {
  const normalizedWorkspaceId = workspaceId.trim();
  const normalizedSessionId = browserSessionId(sessionId);
  if (!normalizedWorkspaceId || !normalizedSessionId) {
    return null;
  }
  const record = sessionRuntimeStateCache
    .get(normalizedWorkspaceId)
    ?.get(normalizedSessionId);
  return record ? cloneRuntimeStateRecord(record) : null;
}

function runtimeRecordEffectiveStatus(
  record: SessionRuntimeRecordPayload | null | undefined,
): string {
  return record?.effective_state?.trim().toUpperCase()
    || record?.status?.trim().toUpperCase()
    || "";
}

const localWorkspaceRegistry = createLocalWorkspaceRegistry({
  controlPlaneDatabasePath: controlPlaneDatabasePath,
  location: localWorkspaceLocation(),
});

function getLocalWorkspaceRecord(
  workspaceId: string,
): WorkspaceRecordPayload | null {
  return localWorkspaceRegistry.getWorkspaceRecord(workspaceId);
}

function emptyWorkspaceListResponse(
  limit = 100,
): WorkspaceListResponsePayload {
  return {
    items: [],
    total: 0,
    limit,
    offset: 0,
  };
}

function workspaceSortTimestamp(
  workspace: Pick<WorkspaceRecordPayload, "updated_at" | "created_at">,
): number {
  const updatedAt = Date.parse(workspace.updated_at ?? "");
  if (Number.isFinite(updatedAt)) {
    return updatedAt;
  }
  const createdAt = Date.parse(workspace.created_at ?? "");
  return Number.isFinite(createdAt) ? createdAt : 0;
}

function sortWorkspaces(
  left: WorkspaceRecordPayload,
  right: WorkspaceRecordPayload,
): number {
  const timestampDelta =
    workspaceSortTimestamp(right) - workspaceSortTimestamp(left);
  if (timestampDelta !== 0) {
    return timestampDelta;
  }
  return left.name.localeCompare(right.name, undefined, {
    sensitivity: "base",
  });
}

function mergeWorkspaceListResponses(
  ...responses: WorkspaceListResponsePayload[]
): WorkspaceListResponsePayload {
  const itemsById = new Map<string, WorkspaceRecordPayload>();
  for (const response of responses) {
    for (const item of response.items) {
      itemsById.set(item.id, item);
    }
  }
  const items = [...itemsById.values()].sort(sortWorkspaces);
  return {
    items,
    total: items.length,
    limit: items.length > 0
      ? Math.max(...responses.map((response) => response.limit), items.length)
      : Math.max(100, ...responses.map((response) => response.limit)),
    offset: 0,
  };
}

function rememberCloudWorkspaceRecord(
  workspace: WorkspaceRecordPayload,
): WorkspaceRecordPayload {
  const normalized = withCloudWorkspaceLocation(workspace)!;
  cloudWorkspaceRecordCache.set(normalized.id, normalized);
  return normalized;
}

function replaceCachedCloudWorkspaceRecords(
  items: WorkspaceRecordPayload[],
): WorkspaceListResponsePayload {
  cloudWorkspaceRecordCache.clear();
  for (const item of items) {
    rememberCloudWorkspaceRecord(item);
  }
  const cachedItems = [...cloudWorkspaceRecordCache.values()].sort(sortWorkspaces);
  return {
    items: cachedItems,
    total: cachedItems.length,
    limit: 100,
    offset: 0,
  };
}

function cachedCloudWorkspaceRecord(
  workspaceId: string,
): WorkspaceRecordPayload | null {
  return cloudWorkspaceRecordCache.get(workspaceId) ?? null;
}

function cachedCloudWorkspaceList(): WorkspaceListResponsePayload {
  const items = [...cloudWorkspaceRecordCache.values()].sort(sortWorkspaces);
  return {
    items,
    total: items.length,
    limit: 100,
    offset: 0,
  };
}

function canUseCachedCloudWorkspaceList(): boolean {
  return Boolean(DESKTOP_CONTROL_PLANE_BASE_URL)
    && Boolean(AUTH_BASE_URL)
    && Boolean(authCookieHeader());
}

async function canUseCloudWorkspaceControlPlane(): Promise<boolean> {
  if (!DESKTOP_CONTROL_PLANE_BASE_URL || !AUTH_BASE_URL) {
    return false;
  }
  if (!authCookieHeader()) {
    return false;
  }
  const user = await getAuthenticatedUser().catch(() => null);
  return Boolean(authUserId(user));
}

async function listCloudWorkspaces(): Promise<WorkspaceListResponsePayload> {
  if (!(await canUseCloudWorkspaceControlPlane())) {
    return emptyWorkspaceListResponse();
  }
  const response = await requestDesktopControlPlaneJson<WorkspaceListResponsePayload>({
    method: "GET",
    path: DESKTOP_RUNTIME_WORKSPACES_PATH,
  });
  const withLocation = withCloudWorkspaceListLocation(response);
  return replaceCachedCloudWorkspaceRecords(withLocation.items);
}

async function listCachedCloudWorkspaces(): Promise<WorkspaceListResponsePayload> {
  if (!canUseCachedCloudWorkspaceList()) {
    return emptyWorkspaceListResponse();
  }
  return cachedCloudWorkspaceList();
}

async function resolveWorkspaceLocation(
  workspaceId: string,
): Promise<WorkspaceLocationPayload> {
  const safeWorkspaceId = assertSafeWorkspaceId(workspaceId);
  const cachedSession = workspaceRuntimeSessionCache.get(safeWorkspaceId);
  if (cachedSession) {
    return cachedSession.location;
  }
  if (getLocalWorkspaceRecord(safeWorkspaceId)) {
    return localWorkspaceLocation();
  }
  if (cachedCloudWorkspaceRecord(safeWorkspaceId)) {
    return cloudWorkspaceLocation();
  }
  if (await canUseCloudWorkspaceControlPlane()) {
    try {
      await fetchCloudWorkspaceLifecycle(safeWorkspaceId);
      return cloudWorkspaceLocation();
    } catch {
      // Fall through to local.
    }
  }
  return localWorkspaceLocation();
}

async function listWorkspaces(): Promise<WorkspaceListResponsePayload> {
  const [localResponse, cloudResponse] = await Promise.all([
    listLocalWorkspaces().catch(() => listWorkspacesFromLocalDb()),
    listCloudWorkspaces().catch(() => emptyWorkspaceListResponse()),
  ]);
  return mergeWorkspaceListResponses(localResponse, cloudResponse);
}

async function listCachedWorkspaces(): Promise<WorkspaceListResponsePayload> {
  const [localResponse, cloudResponse] = await Promise.all([
    Promise.resolve(listWorkspacesFromLocalDb()),
    listCachedCloudWorkspaces(),
  ]);
  return mergeWorkspaceListResponses(localResponse, cloudResponse);
}

/**
 * Read the cached workspace registry directly from control-plane.db
 * without going through the sidecar. Used to hydrate the splash before
 * the sidecar finishes spawning + schema-ensure.
 *
 * Synchronous + fast (5-15ms) — better-sqlite3 with WAL allows this
 * read while the sidecar is still booting in another process.
 *
 * Returns an empty list (not an error) on any failure so the renderer
 * silently falls back to the sidecar path.
 */
function listWorkspacesFromLocalDb(): WorkspaceListResponsePayload {
  return localWorkspaceRegistry.listCachedWorkspaces();
}

async function listLocalWorkspaces(): Promise<WorkspaceListResponsePayload> {
  return listWorkspacesViaRuntime();
}

async function listWorkspacesViaRuntime(): Promise<WorkspaceListResponsePayload> {
  const response = await runtimeClient.workspaces.list({
    includeDeleted: false,
    limit: 100,
    offset: 0,
  });
  for (const item of response.items) {
    // List response is authoritative: reset cache so relocated workspaces
    // get the fresh path instead of a stale cached one.
    forgetWorkspaceDir(item.id);
    rememberWorkspaceDir(item.id, item.workspace_path);
  }
  return withWorkspaceListLocation(response);
}

const STATIC_APP_CATALOG: Record<
  string,
  {
    name: string;
    description: string | null;
    icon: string | null;
    category: string | null;
    tags: string[];
  }
> = {
  twitter: {
    name: "Twitter / X",
    description: "Short-form post drafting and thread editing.",
    icon: null,
    category: "social",
    tags: ["social media", "twitter"],
  },
  linkedin: {
    name: "LinkedIn",
    description: "Long-form post drafting and professional publishing.",
    icon: null,
    category: "social",
    tags: ["social media", "linkedin"],
  },
  reddit: {
    name: "Reddit",
    description: "Subreddit posts, comments and community replies.",
    icon: null,
    category: "social",
    tags: ["social media", "reddit"],
  },
  gmail: {
    name: "Gmail",
    description: "Email drafts, replies, and thread management.",
    icon: null,
    category: "communication",
    tags: ["email", "gmail"],
  },
  sheets: {
    name: "Google Sheets",
    description: "Spreadsheet data as a lightweight database.",
    icon: null,
    category: "productivity",
    tags: ["spreadsheet", "google sheets"],
  },
  github: {
    name: "GitHub",
    description: "Repository activity tracking and release notes.",
    icon: null,
    category: "developer",
    tags: ["github", "developer"],
  },
};

function staticCatalogMeta(appId: string) {
  return (
    STATIC_APP_CATALOG[appId] ?? {
      name: appId,
      description: null,
      icon: null,
      category: null,
      tags: [] as string[],
    }
  );
}

async function listAppCatalog(params: {
  source?: "marketplace" | "local";
}): Promise<AppCatalogListResponse> {
  return localAppCatalogStore.listCatalog({ source: params.source });
}

async function syncAppCatalog(params: {
  source: "marketplace" | "local";
}): Promise<AppCatalogSyncResponse> {
  const target = resolveLocalArchiveTarget();

  if (params.source === "marketplace") {
    const resp = await listAppTemplatesViaControlPlane();
    const entries: Array<Record<string, unknown>> = [];
    for (const tmpl of resp.templates) {
      const archives = Array.isArray(tmpl.archives) ? tmpl.archives : [];
      const matching = archives.find((a) => a?.target === target);
      if (!matching) continue;
      const meta = staticCatalogMeta(tmpl.name);
      entries.push({
        app_id: tmpl.name,
        name: meta.name,
        description: tmpl.description ?? meta.description,
        icon: tmpl.icon ?? meta.icon,
        category: tmpl.category ?? meta.category,
        tags:
          Array.isArray(tmpl.tags) && tmpl.tags.length > 0
            ? tmpl.tags
            : meta.tags,
        version: tmpl.version ?? null,
        archive_url: matching.url,
        archive_path: null,
        provider_id: tmpl.provider_id ?? null,
        credential_source: tmpl.credential_source ?? null,
      });
    }
    return localAppCatalogStore.syncCatalog({
      source: "marketplace",
      target,
      entries,
    });
  }

  const scanned = await scanLocalAppArchives();
  const entries = scanned.map((row) => {
    const meta = staticCatalogMeta(row.appId);
    return {
      app_id: row.appId,
      name: meta.name,
      description: meta.description,
      icon: meta.icon,
      category: meta.category,
      tags: meta.tags,
      version: null,
      archive_url: null,
      archive_path: row.filePath,
      provider_id: null,
      credential_source: null,
    };
  });
  return localAppCatalogStore.syncCatalog({
    source: "local",
    target,
    entries,
  });
}

async function installAppFromCatalog(params: {
  workspaceId: string;
  appId: string;
  source: "marketplace" | "local";
}): Promise<InstallAppFromCatalogResponse> {
  params = {
    ...params,
    workspaceId: assertSafeWorkspaceId(params.workspaceId),
    appId: assertSafeAppId(params.appId),
  };
  const listing = await listAppCatalog({ source: params.source });
  const entry = listing.entries.find((e) => e.app_id === params.appId);
  if (!entry) {
    throw new Error(
      `App '${params.appId}' not found in ${params.source} catalog`,
    );
  }

  let archivePath: string;
  let cleanupTempFile = false;
  if (params.source === "marketplace") {
    if (!entry.archive_url) {
      throw new Error(
        `Catalog entry for '${params.appId}' is missing archive_url`,
      );
    }
    mainWindow?.webContents.send("app-install-progress", {
      appId: params.appId,
      phase: "downloading",
      bytes: 0,
      total: 0,
    });
    archivePath = await downloadAppArchive(entry.archive_url, params.appId);
    cleanupTempFile = true;
  } else {
    if (!entry.archive_path) {
      throw new Error(
        `Catalog entry for '${params.appId}' is missing archive_path`,
      );
    }
    archivePath = entry.archive_path;
  }

  mainWindow?.webContents.send("app-install-progress", {
    appId: params.appId,
    phase: "installing",
    bytes: 0,
    total: 0,
  });

  try {
    const resp = await requestWorkspaceRuntimeJson<InstallAppFromCatalogResponse>(
      params.workspaceId,
      {
        method: "POST",
        path: "/api/v1/apps/install-archive",
        payload: {
          workspace_id: params.workspaceId,
          app_id: params.appId,
          archive_path: archivePath,
        },
        timeoutMs: 300_000,
      },
    );
    return resp;
  } finally {
    if (cleanupTempFile) {
      // Use the already-imported fs/promises namespace instead of a
      // dynamic import. The dynamic import could itself throw under
      // certain ESM-loader edge cases, leaving the temp archive on disk.
      try {
        await fs.rm(archivePath, { force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Mirrors the runtime's allowlist (see api-server/src/app.ts
// `isAllowedArchivePath`). The runtime ultimately re-validates, but
// checking here lets us decide whether the picked file already lives
// somewhere the runtime will accept or needs to be staged to
// ~/.holaboss/downloads first.
function isAllowedArchivePathForRuntime(p: string): boolean {
  if (!p) return false;
  const abs = path.resolve(p);
  const candidates: string[] = [path.resolve(os.tmpdir())];
  const envOverride = process.env.HOLABOSS_APP_ARCHIVE_DIR;
  if (envOverride && envOverride.trim().length > 0) {
    candidates.push(path.resolve(envOverride.trim()));
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && home.trim().length > 0) {
    candidates.push(path.resolve(home.trim(), ".holaboss", "downloads"));
  }
  for (const root of candidates) {
    if (abs === root || abs.startsWith(root + path.sep)) {
      return true;
    }
  }
  return false;
}

// Reads `app.runtime.yaml` from a tarball without extracting the rest, so
// a user-picked archive's app id can be resolved before we hand the path
// to the runtime. Uses the system `tar` binary (bundled on macOS, Linux,
// and Windows 10+) so we don't pull in a Node tar dep just for this dev
// path.
async function peekAppArchiveSlug(archivePath: string): Promise<string> {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    "tar",
    ["-xzOf", archivePath, "app.runtime.yaml"],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  if (result.status !== 0 || !result.stdout) {
    const tail = (result.stderr ?? "").slice(0, 300).trim();
    throw new Error(
      `Could not read app.runtime.yaml from archive (tar exit ${result.status})${tail ? `: ${tail}` : ""}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(result.stdout);
  } catch (err) {
    throw new Error(
      `app.runtime.yaml is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("app.runtime.yaml must be a mapping");
  }
  const record = parsed as Record<string, unknown>;
  const slugValue = record.slug ?? record.app_id;
  const slug = typeof slugValue === "string" ? slugValue.trim() : "";
  if (!slug) {
    throw new Error(
      "app.runtime.yaml must declare `slug` (or `app_id`) so the archive can be installed",
    );
  }
  return slug;
}

// Copies the picked archive into ~/.holaboss/downloads/ when it's outside
// the runtime's allowlist. Returns the path the runtime should consume
// plus a cleanup callback that's a no-op when no copy was needed.
async function stageArchiveForInstall(
  srcPath: string,
): Promise<{ stagedPath: string; cleanup: () => Promise<void> }> {
  const abs = path.resolve(srcPath);
  if (isAllowedArchivePathForRuntime(abs)) {
    return { stagedPath: abs, cleanup: async () => {} };
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) {
    throw new Error(
      "HOME/USERPROFILE is not set; cannot stage archive for install",
    );
  }
  const stagingDir = path.join(home, ".holaboss", "downloads");
  await fs.mkdir(stagingDir, { recursive: true });
  const stagedPath = path.join(stagingDir, path.basename(abs));
  await fs.copyFile(abs, stagedPath);
  return {
    stagedPath,
    cleanup: async () => {
      try {
        await fs.rm(stagedPath, { force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

async function installAppFromArchiveFile(params: {
  workspaceId: string;
  archivePath: string;
}): Promise<InstallAppFromCatalogResponse> {
  const workspaceId = assertSafeWorkspaceId(params.workspaceId);
  const archivePath = path.resolve(params.archivePath);

  const stat = await fs.stat(archivePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new Error(`Archive not found or not a file: ${archivePath}`);
  }
  if (!/\.(tar\.gz|tgz)$/i.test(archivePath)) {
    throw new Error(
      `Archive must be a .tar.gz or .tgz file: ${path.basename(archivePath)}`,
    );
  }

  const slug = await peekAppArchiveSlug(archivePath);
  const appId = assertSafeAppId(slug);

  const { stagedPath, cleanup } = await stageArchiveForInstall(archivePath);

  mainWindow?.webContents.send("app-install-progress", {
    appId,
    phase: "installing",
    bytes: 0,
    total: 0,
  });

  try {
    // SDK's installArchive defaults timeoutMs to 300_000 — equivalent to the
    // upstream change in main. Keeping the typed-method form.
    return await requestWorkspaceRuntimeJson<InstallAppFromCatalogResponse>(
      workspaceId,
      {
        method: "POST",
        path: "/api/v1/apps/install-archive",
        payload: {
          workspace_id: workspaceId,
          app_id: appId,
          archive_path: stagedPath,
        },
        timeoutMs: 300_000,
      },
    );
  } finally {
    await cleanup();
  }
}

// User-driven entry point: opens a file picker, then installs the picked
// tarball. Returns null when the user cancels so the renderer can
// distinguish cancel from error.
async function pickAndInstallAppFromArchiveFile(params: {
  workspaceId: string;
}): Promise<InstallAppFromCatalogResponse | null> {
  const workspaceId = assertSafeWorkspaceId(params.workspaceId);
  const dialogOptions: Electron.OpenDialogOptions = {
    title: "Install app from archive",
    buttonLabel: "Install",
    properties: ["openFile"],
    filters: [
      { name: "App archive", extensions: ["tar.gz", "tgz"] },
      { name: "All files", extensions: ["*"] },
    ],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return installAppFromArchiveFile({
    workspaceId,
    archivePath: result.filePaths[0],
  });
}

async function listInstalledApps(
  workspaceId: string,
): Promise<InstalledWorkspaceAppListResponsePayload> {
  const lifecycle = await getWorkspaceLifecycle(workspaceId);
  return {
    apps: lifecycle.applications,
    count: lifecycle.applications.length,
  };
}

async function listInstalledAppsViaRuntime(
  workspaceId: string,
): Promise<InstalledWorkspaceAppListResponsePayload> {
  return requestWorkspaceRuntimeJson<InstalledWorkspaceAppListResponsePayload>(
    workspaceId,
    {
      method: "GET",
      path: "/api/v1/apps",
      params: {
        workspace_id: workspaceId,
      },
    },
  );
}

async function removeInstalledApp(
  workspaceId: string,
  appId: string,
): Promise<void> {
  const safeWorkspaceId = assertSafeWorkspaceId(workspaceId);
  const safeAppId = assertSafeAppId(appId);
  await requestWorkspaceRuntimeJson<Record<string, unknown>>(safeWorkspaceId, {
    method: "DELETE",
    path: `/api/v1/apps/${encodeURIComponent(safeAppId)}`,
    payload: {
      workspace_id: safeWorkspaceId,
    },
    timeoutMs: 30000,
  });
}

async function controlPlaneWorkspaceUserId(): Promise<string | null> {
  // Check runtime config first — populated during binding provisioning.
  const runtimeConfig = await readRuntimeConfigFile();
  const runtimeUserId = (runtimeConfig.user_id || "").trim();
  if (runtimeUserId && runtimeUserId !== LOCAL_OSS_TEMPLATE_USER_ID) {
    return runtimeUserId;
  }

  // Fall back to authenticated user.
  const authenticatedUser = await getAuthenticatedUser().catch(() => null);
  const authId = authenticatedUser ? authUserId(authenticatedUser) : "";
  return authId.trim() || null;
}

function workspaceReadinessFromApps(apps: InstalledWorkspaceAppPayload[]) {
  const blockingApps = apps
    .filter((app) => !app.ready)
    .map((app) => ({
      app_id: app.app_id,
      status: app.error ? "error" : "initializing",
      error: app.error ?? null,
    }));

  if (blockingApps.length === 0) {
    return {
      ready: true,
      reason: null,
      blocking_apps: [],
    };
  }

  const hasErrors = blockingApps.some((app) => app.error);
  const prefix = hasErrors
    ? "Some apps failed to start"
    : "Apps are initializing";
  const details = blockingApps.map((app) => app.app_id).join(", ");
  return {
    ready: false,
    reason: `${prefix}: ${details}.`,
    blocking_apps: blockingApps,
  };
}

function workspaceLifecyclePhaseFromState(
  workspace: WorkspaceRecordPayload,
  readiness: ReturnType<typeof workspaceReadinessFromApps>,
) {
  const reason = readiness.reason?.trim() || null;
  const blockingStatuses = new Set(
    readiness.blocking_apps.map((app) =>
      (app.status || "").trim().toLowerCase(),
    ),
  );

  if ((workspace.status || "").trim().toLowerCase() === "error") {
    return {
      phase: "error",
      phase_label: "Workspace error",
      phase_detail:
        workspace.error_message || reason || "Workspace provisioning failed.",
    };
  }
  if ((workspace.status || "").trim().toLowerCase() === "provisioning") {
    return {
      phase: "provisioning_workspace",
      phase_label: "Configuring workspace",
      phase_detail: "Preparing the local workspace files and settings.",
    };
  }
  if (readiness.ready) {
    return {
      phase: "ready",
      phase_label: "Workspace ready",
      phase_detail: null,
    };
  }
  if (blockingStatuses.has("failed")) {
    return {
      phase: "error",
      phase_label: "Workspace error",
      phase_detail:
        reason || workspace.error_message || "Workspace apps failed to start.",
    };
  }
  if (blockingStatuses.has("building") || blockingStatuses.has("pending")) {
    return {
      phase: "building_apps",
      phase_label: "Building apps",
      phase_detail: reason || "Building workspace apps.",
    };
  }
  if (readiness.blocking_apps.length > 0) {
    return {
      phase: "starting_apps",
      phase_label: "Starting apps",
      phase_detail: reason || "Starting workspace apps.",
    };
  }
  return {
    phase: "preparing_workspace",
    phase_label: "Preparing workspace",
    phase_detail: reason || "Finalizing workspace startup.",
  };
}

async function getLocalWorkspaceLifecycle(
  workspaceId: string,
): Promise<WorkspaceLifecyclePayload> {
  return getWorkspaceLifecycleViaRuntime(assertSafeWorkspaceId(workspaceId));
}

const CARD_SUMMARY_TASK_STATUSES = [
  "running",
  "queued",
  "waiting_on_user",
  "failed",
];

function cardLifecycleStateFromPayload(
  payload: WorkspaceLifecyclePayload,
): "starting" | "ready" | "error" {
  if (payload.blocking_apps.length > 0) {
    return "error";
  }
  if (payload.reason && payload.reason.trim()) {
    return "error";
  }
  if (payload.ready) {
    return "ready";
  }
  return "starting";
}

function emptyCardTaskCounts(): WorkspaceCardSummaryTaskCountsPayload {
  return { running: 0, queued: 0, waiting_on_user: 0, failed: 0 };
}

function tallyCardTaskCounts(
  tasks: BackgroundTaskRecordPayload[],
): WorkspaceCardSummaryTaskCountsPayload {
  const counts = emptyCardTaskCounts();
  for (const task of tasks) {
    const status = (task.status || "").trim().toLowerCase();
    if (status === "running") {
      counts.running += 1;
    } else if (status === "queued") {
      counts.queued += 1;
    } else if (status === "waiting_on_user") {
      counts.waiting_on_user += 1;
    } else if (status === "failed") {
      counts.failed += 1;
    }
  }
  return counts;
}

async function buildWorkspaceCardSummary(
  workspaceId: string,
): Promise<WorkspaceCardSummaryPayload> {
  const [lifecycleResult, tasksResult] = await Promise.allSettled([
    getLocalWorkspaceLifecycle(workspaceId),
    listBackgroundTasks({
      workspaceId,
      statuses: CARD_SUMMARY_TASK_STATUSES,
      limit: 200,
    }),
  ]);

  const lifecycle =
    lifecycleResult.status === "fulfilled"
      ? cardLifecycleStateFromPayload(lifecycleResult.value)
      : "ready";

  const taskCounts =
    tasksResult.status === "fulfilled"
      ? tallyCardTaskCounts(tasksResult.value.tasks)
      : emptyCardTaskCounts();

  return {
    workspace_id: workspaceId,
    lifecycle,
    task_counts: taskCounts,
  };
}

async function listWorkspaceCardSummaries(
  workspaceIds: string[],
): Promise<WorkspaceCardSummariesResponsePayload> {
  const ids = Array.from(
    new Set(
      workspaceIds.map((id) => id.trim()).filter(Boolean),
    ),
  );
  if (ids.length === 0) {
    return { summaries: [] };
  }
  const results = await Promise.allSettled(
    ids.map((id) => buildWorkspaceCardSummary(id)),
  );
  const summaries: WorkspaceCardSummaryPayload[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      summaries.push(result.value);
    }
  }
  return { summaries };
}

async function openLocalWorkspace(
  workspaceId: string,
): Promise<WorkspaceOpenSessionPayload> {
  const safeWorkspaceId = assertSafeWorkspaceId(workspaceId);
  const session = await resolveWorkspaceRuntimeSession(safeWorkspaceId, {
    refresh: true,
  });
  await requestWorkspaceRuntimeJson<Record<string, unknown>>(safeWorkspaceId, {
    method: "POST",
    path: "/api/v1/apps/ensure-running",
    payload: { workspace_id: safeWorkspaceId },
    timeoutMs: 300000,
    retryTransientErrors: true,
  });
  return {
    ...session,
    lifecycle: await getWorkspaceLifecycleViaRuntime(safeWorkspaceId),
  };
}

async function fetchCloudWorkspaceLifecycle(
  workspaceId: string,
): Promise<WorkspaceLifecyclePayload> {
  const safeWorkspaceId = assertSafeWorkspaceId(workspaceId);
  const lifecycle = await requestDesktopControlPlaneJson<WorkspaceLifecyclePayload>(
    {
      method: "GET",
      path: `${DESKTOP_RUNTIME_WORKSPACES_PATH}/${encodeURIComponent(safeWorkspaceId)}/lifecycle`,
    },
  );
  const withLocation = withCloudWorkspaceLifecycleLocation(lifecycle);
  rememberCloudWorkspaceRecord(withLocation.workspace);
  return withLocation;
}

async function activateCloudWorkspaceRecord(
  workspaceId: string,
): Promise<WorkspaceResponsePayload> {
  const safeWorkspaceId = assertSafeWorkspaceId(workspaceId);
  const lifecycle = await requestDesktopControlPlaneJson<WorkspaceLifecyclePayload>(
    {
      method: "POST",
      path: `${DESKTOP_RUNTIME_WORKSPACES_PATH}/${encodeURIComponent(safeWorkspaceId)}/activate`,
    },
  );
  const withLocation = withCloudWorkspaceLifecycleLocation(lifecycle);
  rememberCloudWorkspaceRecord(withLocation.workspace);
  return { workspace: withLocation.workspace };
}

async function fetchCloudWorkspaceOpenSession(
  workspaceId: string,
): Promise<WorkspaceOpenSessionPayload> {
  const safeWorkspaceId = assertSafeWorkspaceId(workspaceId);
  const session = await requestDesktopControlPlaneJson<WorkspaceOpenSessionPayload>(
    {
      method: "POST",
      path: `${DESKTOP_RUNTIME_WORKSPACES_PATH}/${encodeURIComponent(safeWorkspaceId)}/open`,
    },
  );
  const lifecycle = withCloudWorkspaceLifecycleLocation(session.lifecycle);
  rememberCloudWorkspaceRecord(lifecycle.workspace);
  return {
    ...session,
    location: cloudWorkspaceLocation(),
    lifecycle,
  };
}

async function openCloudWorkspace(
  workspaceId: string,
): Promise<WorkspaceOpenSessionPayload> {
  const session = await fetchCloudWorkspaceOpenSession(workspaceId);
  cacheWorkspaceRuntimeSession({
    workspace_id: session.workspace_id,
    location: session.location,
    runtime_base_url: session.runtime_base_url,
    runtime_auth_token: session.runtime_auth_token,
    workspace_root: session.workspace_root,
  });
  return session;
}

async function getWorkspaceLifecycle(
  workspaceId: string,
): Promise<WorkspaceLifecyclePayload> {
  const safeWorkspaceId = assertSafeWorkspaceId(workspaceId);
  const location = await resolveWorkspaceLocation(safeWorkspaceId);
  return location === "cloud"
    ? fetchCloudWorkspaceLifecycle(safeWorkspaceId)
    : getLocalWorkspaceLifecycle(safeWorkspaceId);
}

async function activateWorkspace(
  workspaceId: string,
): Promise<WorkspaceLifecyclePayload> {
  return (await openWorkspace(workspaceId)).lifecycle;
}

async function openWorkspace(
  workspaceId: string,
): Promise<WorkspaceOpenSessionPayload> {
  const safeWorkspaceId = assertSafeWorkspaceId(workspaceId);
  const location = await resolveWorkspaceLocation(safeWorkspaceId);
  return location === "cloud"
    ? openCloudWorkspace(safeWorkspaceId)
    : openLocalWorkspace(safeWorkspaceId);
}

async function getWorkspaceLifecycleViaRuntime(
  workspaceId: string,
): Promise<WorkspaceLifecyclePayload> {
  const workspace =
    getLocalWorkspaceRecord(workspaceId) ??
    (await listWorkspacesViaRuntime()).items.find(
      (item) => item.id === workspaceId,
    ) ??
    null;
  if (!workspace) {
    throw new Error(`Workspace ${workspaceId} not found.`);
  }

  const installedApps = await listInstalledAppsViaRuntime(workspaceId);
  const readiness = workspaceReadinessFromApps(installedApps.apps);
  const phaseState = workspaceLifecyclePhaseFromState(workspace, readiness);

  return withWorkspaceLifecycleLocation({
    workspace,
    applications: installedApps.apps,
    ready: readiness.ready,
    reason: readiness.reason,
    phase: phaseState.phase,
    phase_label: phaseState.phase_label,
    phase_detail: phaseState.phase_detail,
    blocking_apps: readiness.blocking_apps,
  });
}

function outputDisplayPathForArtifactFiltering(
  output: WorkspaceOutputRecordPayload,
) {
  const metadataPath =
    typeof output.metadata?.file_path === "string"
      ? output.metadata.file_path.trim()
      : "";
  if (metadataPath) {
    return metadataPath;
  }
  const filePath =
    typeof output.file_path === "string" ? output.file_path.trim() : "";
  if (filePath) {
    return filePath;
  }
  const title = typeof output.title === "string" ? output.title.trim() : "";
  if (/[\\/]/.test(title) || /\.[A-Za-z0-9]+$/.test(title)) {
    return title;
  }
  return "";
}

function outputDisplayPathSegmentsForArtifactFiltering(
  output: WorkspaceOutputRecordPayload,
) {
  const normalizedPath = outputDisplayPathForArtifactFiltering(output)
    .replace(/[\\/]+/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  return normalizedPath ? normalizedPath.split("/").filter(Boolean) : [];
}

function shouldHideWorkspaceManagedArtifactOutput(
  output: WorkspaceOutputRecordPayload,
) {
  const segments = outputDisplayPathSegmentsForArtifactFiltering(output);
  if (segments.length === 0) {
    return false;
  }
  const fileName = segments[segments.length - 1];
  return fileName === "agents.md" || segments.includes("skills");
}

async function listOutputs(
  payload: string | HolabossListOutputsPayload,
): Promise<WorkspaceOutputListResponsePayload> {
  const requestPayload =
    typeof payload === "string" ? { workspaceId: payload } : payload;
  const response =
    await requestWorkspaceRuntimeJson<WorkspaceOutputListResponsePayload>(
      requestPayload.workspaceId,
      {
        method: "GET",
        path: "/api/v1/outputs",
        params: {
          workspace_id: requestPayload.workspaceId,
          output_type: requestPayload.outputType ?? undefined,
          status: requestPayload.status ?? undefined,
          platform: requestPayload.platform ?? undefined,
          folder_id: requestPayload.folderId ?? undefined,
          session_id: requestPayload.sessionId ?? undefined,
          input_id: requestPayload.inputId ?? undefined,
          limit: requestPayload.limit ?? 50,
          offset: requestPayload.offset ?? 0,
        },
      },
    );
  return {
    ...response,
    items: response.items.filter(
      (item) => !shouldHideWorkspaceManagedArtifactOutput(item),
    ),
  };
}

async function listOutputFolders(
  workspaceId: string,
): Promise<WorkspaceOutputFolderListResponsePayload> {
  return requestWorkspaceRuntimeJson<WorkspaceOutputFolderListResponsePayload>(
    workspaceId,
    {
      method: "GET",
      path: "/api/v1/output-folders",
      params: { workspace_id: workspaceId },
    },
  );
}

function normalizeWorkspaceSkillId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const skillId = value.trim();
  if (!skillId || skillId === "." || skillId === "..") {
    return null;
  }
  if (
    skillId.includes("/") ||
    skillId.includes("\\") ||
    skillId.includes("\0")
  ) {
    return null;
  }
  return skillId;
}

function sanitizeYamlScalar(rawValue: string): string {
  const trimmed = rawValue.replace(/\s+#.*$/, "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function humanizeSkillId(skillId: string): string {
  return skillId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function extractSkillMetadata(
  markdown: string,
  skillId: string,
): { title: string; summary: string } {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  let remaining = normalized;
  let summary = "";

  const frontmatterMatch = normalized.match(/^---\n([\s\S]*?)\n---\s*/);
  if (frontmatterMatch) {
    const descriptionMatch = frontmatterMatch[1].match(
      /^description:\s*(.+)$/m,
    );
    if (descriptionMatch) {
      summary = sanitizeYamlScalar(descriptionMatch[1]);
    }
    remaining = normalized.slice(frontmatterMatch[0].length).trim();
  }

  const titleMatch = remaining.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1]?.trim() || humanizeSkillId(skillId) || skillId;

  if (!summary) {
    const lines = remaining.split("\n");
    const paragraphLines: string[] = [];
    let collecting = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        if (collecting) {
          break;
        }
        continue;
      }
      if (!collecting && (line.startsWith("#") || line === "---")) {
        continue;
      }
      if (line.startsWith("```")) {
        if (collecting) {
          break;
        }
        continue;
      }
      collecting = true;
      paragraphLines.push(line);
    }
    summary = paragraphLines.join(" ").trim();
  }

  return {
    title,
    summary: summary || "No description provided.",
  };
}

async function readSkillCatalogFromRoot(params: {
  skillsRoot: string;
}): Promise<WorkspaceSkillRecordPayload[]> {
  let directoryEntries;
  try {
    directoryEntries = await fs.readdir(params.skillsRoot, {
      withFileTypes: true,
    });
  } catch {
    return [];
  }

  return (
    await Promise.all(
      directoryEntries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const skillId = normalizeWorkspaceSkillId(entry.name);
          if (!skillId) {
            return null;
          }
          const sourceDir = path.join(params.skillsRoot!, entry.name);
          const skillFilePath = path.join(sourceDir, "SKILL.md");
          try {
            const [content, stats] = await Promise.all([
              fs.readFile(skillFilePath, "utf-8"),
              fs.stat(skillFilePath),
            ]);
            const metadata = extractSkillMetadata(content, skillId);
            return {
              skill_id: skillId,
              source_dir: sourceDir,
              skill_file_path: skillFilePath,
              title: metadata.title,
              summary: metadata.summary,
              modified_at: stats.mtime.toISOString(),
            } satisfies WorkspaceSkillRecordPayload;
          } catch {
            return null;
          }
        }),
    )
  ).filter((skill): skill is WorkspaceSkillRecordPayload => Boolean(skill));
}

async function listWorkspaceSkills(
  workspaceId: string,
): Promise<WorkspaceSkillListResponsePayload> {
  const workspaceRoot = await resolveWorkspaceDir(workspaceId);
  const skillsPath = path.resolve(workspaceRoot, "skills");

  const workspaceSkills = await readSkillCatalogFromRoot({ skillsRoot: skillsPath });

  const skills = [...workspaceSkills].sort((left, right) =>
    left.title.localeCompare(right.title, undefined, {
      sensitivity: "base",
    }),
  );

  return {
    workspace_id: workspaceId,
    workspace_root: workspaceRoot,
    skills_path: skillsPath,
    skills,
  };
}

function renderMinimalWorkspaceYaml(
  workspace: WorkspaceRecordPayload,
  template: ResolvedTemplatePayload,
) {
  const createdAt = workspace.created_at ?? utcNowIso();
  const templateCommit = template.effective_commit
    ? `  commit: ${JSON.stringify(template.effective_commit)}\n`
    : "";
  return [
    `name: ${JSON.stringify(workspace.name)}`,
    `created_at: ${JSON.stringify(createdAt)}`,
    "agents:",
    '  id: "workspace.general"',
    '  model: "openai/gpt-5"',
    "mcp_registry:",
    "  allowlist:",
    "    tool_ids: []",
    "  servers:",
    "    workspace:",
    '      type: "local"',
    "      enabled: true",
    "      timeout_ms: 10000",
    "  catalog: {}",
    `template_id: ${JSON.stringify(template.name)}`,
    "template:",
    `  name: ${JSON.stringify(template.name)}`,
    `  repo: ${JSON.stringify(template.repo)}`,
    `  path: ${JSON.stringify(template.path)}`,
    `  ref: ${JSON.stringify(template.effective_ref)}`,
    templateCommit + `  imported_at: ${JSON.stringify(utcNowIso())}`,
  ].join("\n");
}

function renderEmptyWorkspaceYaml() {
  return [
    "agents:",
    "  id: workspace.general",
    "  model: openai/gpt-5",
    "mcp_registry:",
    "  allowlist:",
    "    tool_ids: []",
    "  servers: {}",
  ].join("\n");
}

function renderEmptyOnboardingGuide() {
  return [
    "# Workspace Onboarding",
    "",
    "Use this conversation to set up the workspace before regular execution starts.",
    "",
    "## Objectives",
    "",
    "- Ask concise questions to understand what this workspace is for.",
    "- Capture durable facts, preferences, and constraints.",
    "- Do not start execution work until onboarding is complete.",
    "",
    "## Gather",
    "",
    "- Primary goal for this workspace",
    "- Preferred outputs or deliverables",
    "- Style or tone preferences",
    "- Tools, accounts, or apps that matter",
    "- Constraints, deadlines, or things to avoid",
    "",
    "## Completion",
    "",
    "- Summarize the durable facts you collected.",
    "- Ask the user to confirm the summary is correct.",
    "- When the user confirms, request onboarding completion.",
  ].join("\n");
}

async function createLocalWorkspace(
  payload: HolabossCreateWorkspacePayload,
): Promise<WorkspaceResponsePayload> {
  // Structured stage logs for workspace create/install debugging. These
  // go to the Electron main process stdout; in dev they appear in the
  // terminal, in packaged builds they land in the platform log dir
  // under `holaboss-local/logs/main.log` (handled by Electron).
  const stageLog = (event: string, data?: Record<string, unknown>): void => {
    const line = { event: `desktop.${event}`, ts: new Date().toISOString(), ...(data ?? {}) };
    // eslint-disable-next-line no-console
    console.info(`[holaboss.createWorkspace] ${JSON.stringify(line)}`);
  };
  const stageError = (event: string, err: unknown, data?: Record<string, unknown>): void => {
    const line = {
      event: `desktop.${event}`,
      ts: new Date().toISOString(),
      err: err instanceof Error ? err.message : String(err),
      ...(data ?? {}),
    };
    // eslint-disable-next-line no-console
    console.error(`[holaboss.createWorkspace] ${JSON.stringify(line)}`);
  };

  const harness = normalizeRequestedWorkspaceHarness(payload.harness);
  const templateMode = requestedWorkspaceTemplateMode(payload);
  const templateRootPath = payload.template_root_path?.trim() || "";
  const templateName = payload.template_name?.trim() || "";
  const requiresRuntimeBinding =
    templateMode !== "empty" && !templateRootPath && Boolean(templateName);
  stageLog("begin", {
    templateMode,
    templateName,
    hasTemplateRootPath: Boolean(templateRootPath),
    harness,
    requiresRuntimeBinding,
    templateApps: payload.template_apps ?? [],
    templateAppsCount: (payload.template_apps ?? []).length,
  });
  if (requiresRuntimeBinding) {
    await ensureRuntimeBindingReadyForWorkspaceFlow("workspace_create");
  }
  // Desktop always materializes templates locally — never delegate to remote
  // projects service which would write files into a remote sandbox.
  let materializedTemplate: MaterializeTemplateResponsePayload | null = null;
  let resolvedTemplate: ResolvedTemplatePayload | null = null;
  if (templateMode === "empty") {
    resolvedTemplate = null;
  } else if (templateRootPath) {
    stageLog("materialize_local_template.start", { templateRootPath });
    try {
      materializedTemplate = await materializeLocalTemplate({
        template_root_path: templateRootPath,
      });
      resolvedTemplate = materializedTemplate.template;
      stageLog("materialize_local_template.ok", {
        fileCount: materializedTemplate.files.length,
      });
    } catch (error) {
      stageError("materialize_local_template.failed", error, { templateRootPath });
      throw new Error(
        contextualWorkspaceCreateError(
          "Couldn't materialize the local template",
          error,
        ),
      );
    }
  } else if (templateName) {
    stageLog("materialize_marketplace_template.start", { templateName });
    try {
      materializedTemplate = await materializeMarketplaceTemplate({
        holaboss_user_id: payload.holaboss_user_id,
        template_name: templateName,
        template_ref: payload.template_ref,
        template_commit: payload.template_commit,
      });
      resolvedTemplate = materializedTemplate.template;
      stageLog("materialize_marketplace_template.ok", {
        templateName,
        fileCount: materializedTemplate.files.length,
      });
    } catch (error) {
      stageError("materialize_marketplace_template.failed", error, { templateName });
      throw new Error(
        contextualWorkspaceCreateError(
          `Couldn't materialize the marketplace template '${templateName}'`,
          error,
        ),
      );
    }
  } else {
    throw new Error("Choose a local folder or a marketplace template first.");
  }
  const customWorkspacePath = payload.workspace_path?.trim() || "";
  let created: Awaited<ReturnType<typeof runtimeClient.workspaces.create>>;
  stageLog("runtime_post_workspaces.start", {
    hasCustomWorkspacePath: Boolean(customWorkspacePath),
  });
  try {
    created = await runtimeClient.workspaces.create({
      name: payload.name,
      harness,
      status: "provisioning",
      onboarding_status: "not_required",
      ...(customWorkspacePath ? { workspace_path: customWorkspacePath } : {}),
    });
    stageLog("runtime_post_workspaces.ok", { workspaceId: created.workspace.id });
  } catch (error) {
    stageError("runtime_post_workspaces.failed", error);
    throw new Error(
      contextualWorkspaceCreateError(
        "Couldn't create the workspace record",
        error,
      ),
    );
  }
  const workspaceId = created.workspace.id;
  rememberWorkspaceDir(workspaceId, created.workspace.workspace_path);
  forgetWorkspaceRuntimeSession(workspaceId);

  try {
    const workspaceDir = await resolveWorkspaceDir(workspaceId);
    stageLog("workspace_dir_resolved", { workspaceId, workspaceDir });
    const workspaceAgentsPath = path.join(workspaceDir, "AGENTS.md");
    const workspaceYamlPath = path.join(workspaceDir, "workspace.yaml");
    const workspaceOnboardPath = path.join(workspaceDir, "ONBOARD.md");
    const wantsEmptyOnboardingScaffold =
      payload.template_mode === "empty_onboarding";
    const requestedWorkspaceOnboardingEngine =
      templateMode === "empty" &&
      payload.workspace_onboarding_mode === "start" &&
      !wantsEmptyOnboardingScaffold &&
      payload.workspace_onboarding_engine === "agentic"
        ? "agentic"
        : templateMode === "empty" &&
            payload.workspace_onboarding_mode === "start" &&
            !wantsEmptyOnboardingScaffold
          ? "deterministic"
          : null;
    if (templateMode === "empty") {
      await fs.mkdir(path.join(workspaceDir, "skills"), { recursive: true });
      await fs.writeFile(workspaceAgentsPath, "", "utf-8");
      await fs.writeFile(
        workspaceYamlPath,
        `${renderEmptyWorkspaceYaml()}\n`,
        "utf-8",
      );
      if (wantsEmptyOnboardingScaffold) {
        await fs.writeFile(
          workspaceOnboardPath,
          `${renderEmptyOnboardingGuide()}\n`,
          "utf-8",
        );
      }
    } else if (materializedTemplate && resolvedTemplate) {
      stageLog("apply_template.start", {
        workspaceId,
        fileCount: materializedTemplate.files.length,
      });
      try {
        await applyMaterializedTemplateToWorkspace(
          workspaceId,
          materializedTemplate.files,
        );
        stageLog("apply_template.ok", { workspaceId });
      } catch (error) {
        stageError("apply_template.failed", error, { workspaceId });
        throw error;
      }
      if (templateRootPath) {
        stageLog("copy_local_node_modules.start", { workspaceId, templateRootPath });
        try {
          await copyLocalTemplateAppNodeModulesToWorkspace(
            templateRootPath,
            workspaceId,
          );
          stageLog("copy_local_node_modules.ok", { workspaceId });
        } catch (error) {
          stageError("copy_local_node_modules.failed", error, { workspaceId });
          throw error;
        }
      }

      let workspaceYamlExists = true;
      try {
        await fs.access(workspaceYamlPath);
      } catch {
        workspaceYamlExists = false;
      }
      if (!workspaceYamlExists) {
        const current = getLocalWorkspaceRecord(workspaceId);
        if (current) {
          await fs.writeFile(
            workspaceYamlPath,
            `${renderMinimalWorkspaceYaml(current, resolvedTemplate)}\n`,
            "utf-8",
          );
        }
      }
    }

    const workspaceGit = await ensureWorkspaceGitRepo(workspaceDir);
    if (!workspaceGit.available) {
      stageLog("workspace_git.skipped", {
        workspaceId,
        reason: workspaceGit.skippedReason ?? "git unavailable",
      });
    }

    let onboardingStatus = "NOT_REQUIRED";
    let onboardingState: string | null = null;
    let onboardingSessionId: string | null = null;
    const wantsDeterministicWorkspaceOnboarding =
      requestedWorkspaceOnboardingEngine === "deterministic";
    const wantsAgenticWorkspaceOnboarding =
      requestedWorkspaceOnboardingEngine === "agentic";
    const skipsWorkspaceOnboarding =
      templateMode === "empty" &&
      payload.workspace_onboarding_mode === "skip" &&
      !wantsEmptyOnboardingScaffold;
    try {
      const onboardContent = await fs.readFile(
        path.join(workspaceDir, "ONBOARD.md"),
        "utf-8",
      );
      if (onboardContent.trim()) {
        onboardingStatus = "PENDING";
        onboardingSessionId = crypto.randomUUID();
      }
    } catch {
      onboardingStatus = "NOT_REQUIRED";
      onboardingSessionId = null;
    }
    if (wantsDeterministicWorkspaceOnboarding) {
      onboardingStatus = "PENDING";
      onboardingState = "deterministic_intro";
      onboardingSessionId = null;
    }
    if (!onboardingSessionId && skipsWorkspaceOnboarding) {
      onboardingStatus = "COMPLETED";
      onboardingState = null;
    }

    stageLog("activate_workspace.start", { workspaceId, onboardingStatus });
    let updated: Awaited<ReturnType<typeof runtimeClient.workspaces.update>>;
    try {
      updated = await runtimeClient.workspaces.update(workspaceId, {
        status: "active",
        onboarding_status: onboardingStatus.toLowerCase(),
        onboarding_state: onboardingState,
        onboarding_session_id: onboardingSessionId,
        ...(skipsWorkspaceOnboarding
          ? {
              onboarding_completed_at: new Date().toISOString(),
              onboarding_completion_summary: "Workspace onboarding skipped by user",
              onboarding_requested_by: "workspace_user",
            }
          : {}),
        error_message: null,
      });
      stageLog("activate_workspace.ok", { workspaceId });
    } catch (error) {
      stageError("activate_workspace.failed", error, { workspaceId });
      throw error;
    }

    // --- Auto-bind integrations (best-effort) ---
    if (materializedTemplate) {
      try {
        const integrationReqs = extractIntegrationRequirementsFromTemplateFiles(
          materializedTemplate.files,
        );
        if (integrationReqs.length > 0) {
          let connections: IntegrationConnectionPayload[] = [];
          try {
            const resp = await listIntegrationConnections();
            connections = resp.connections.filter((c) => c.status === "active");
          } catch {
            // Cannot reach integration API; skip auto-bind.
          }

          if (connections.length > 0) {
            const connectionsByProvider = new Map<
              string,
              IntegrationConnectionPayload
            >();
            for (const conn of connections) {
              // Keep the first (most recently created) connection per provider
              if (!connectionsByProvider.has(conn.provider_id)) {
                connectionsByProvider.set(conn.provider_id, conn);
              }
            }

            for (const req of integrationReqs) {
              const conn = connectionsByProvider.get(req.provider);
              if (!conn) continue;
              try {
                await upsertIntegrationBinding(
                  workspaceId,
                  "app",
                  req.app_id,
                  req.key,
                  { connection_id: conn.connection_id, is_default: true },
                );
              } catch {
                // Best-effort: skip binding failures silently.
              }
            }
          }
        }
      } catch {
        // Auto-bind is best-effort; do not fail workspace creation.
      }
    }

    const templateAppNames = (payload.template_apps ?? []).filter(
      (name) => typeof name === "string" && name.trim(),
    );
    if (templateAppNames.length > 0) {
      stageLog("install_template_apps.start", {
        workspaceId,
        apps: templateAppNames,
      });
      try {
        await syncAppCatalog({ source: "marketplace" });
        stageLog("install_template_apps.catalog_synced", { workspaceId });
      } catch (error) {
        stageError("install_template_apps.catalog_sync_failed", error, {
          workspaceId,
        });
      }
      for (const appName of templateAppNames) {
        try {
          stageLog("install_template_apps.installing", {
            workspaceId,
            appId: appName,
          });
          await installAppFromCatalog({
            workspaceId,
            appId: appName,
            source: "marketplace",
          });
          stageLog("install_template_apps.installed", {
            workspaceId,
            appId: appName,
          });
        } catch (error) {
          stageError("install_template_apps.failed", error, {
            workspaceId,
            appId: appName,
          });
        }
      }
      stageLog("install_template_apps.done", { workspaceId });
    }

    if (onboardingSessionId) {
      try {
        await requestWorkspaceRuntimeJson<EnqueueSessionInputResponsePayload>(
          workspaceId,
          {
            method: "POST",
            path: "/api/v1/agent-sessions/queue",
            payload: {
              workspace_id: workspaceId,
              session_id: onboardingSessionId,
              text: "Start workspace onboarding now. Use ONBOARD.md as the guide and ask the first onboarding question only.",
              priority: 0,
            },
          },
        );
      } catch (error) {
        updated = await runtimeClient.workspaces
          .update(workspaceId, {
            error_message: contextualWorkspaceCreateError(
              "Workspace created, but automatic onboarding could not start",
              error,
            ),
          })
          .catch(() => updated);
      }
    }
    if (wantsAgenticWorkspaceOnboarding) {
      try {
        const onboardingLab = await requestWorkspaceRuntimeJson<{
          lab?: { id?: string | null } | null;
          source?: WorkspaceRecordPayload | null;
          session?: { session_id?: string | null } | null;
        }>(workspaceId, {
          method: "POST",
          path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/labs`,
          payload: { purpose: "workspace_onboarding" },
        });
        updated = onboardingLab.source
          ? { workspace: onboardingLab.source }
          : await runtimeClient.workspaces.get(workspaceId).catch(() => updated);
      } catch (error) {
        updated = await runtimeClient.workspaces
          .update(workspaceId, {
            error_message: contextualWorkspaceCreateError(
              "Workspace created, but workspace onboarding lab could not start",
              error,
            ),
          })
          .catch(() => updated);
      }
    }
    return withWorkspaceResponseLocation(updated);
  } catch (error) {
    await runtimeClient.workspaces
      .update(workspaceId, {
        status: "error",
        error_message: normalizeErrorMessage(error),
      })
      .catch(() => undefined);
    throw error;
  }
}

async function deleteLocalWorkspace(
  workspaceId: string,
  keepFiles?: boolean,
): Promise<WorkspaceResponsePayload> {
  const safeWorkspaceId = assertSafeWorkspaceId(workspaceId);
  const response = await runtimeClient.workspaces.delete(
    safeWorkspaceId,
    keepFiles !== undefined ? { keepFiles } : undefined,
  );
  forgetWorkspaceDir(safeWorkspaceId);
  forgetWorkspaceRuntimeSession(safeWorkspaceId);
  return withWorkspaceResponseLocation(response);
}

async function relocateWorkspace(
  workspaceId: string,
  newPath: string,
): Promise<WorkspaceResponsePayload> {
  const safeWorkspaceId = assertSafeWorkspaceId(workspaceId);
  if ((await resolveWorkspaceLocation(safeWorkspaceId)) !== "local") {
    throw new Error(
      "Remote workspaces do not have a host-local folder to relocate.",
    );
  }
  const response = await runtimeClient.workspaces.update(safeWorkspaceId, {
    workspace_path: newPath,
  });
  forgetWorkspaceDir(safeWorkspaceId);
  rememberWorkspaceDir(safeWorkspaceId, response.workspace.workspace_path);
  forgetWorkspaceRuntimeSession(safeWorkspaceId);
  return withWorkspaceResponseLocation(response);
}

async function activateLocalWorkspaceRecord(
  workspaceId: string,
): Promise<WorkspaceResponsePayload> {
  const safeWorkspaceId = assertSafeWorkspaceId(workspaceId);
  return withWorkspaceResponseLocation(
    await runtimeClient.workspaces.activate(safeWorkspaceId),
  );
}

async function createCloudWorkspace(
  payload: HolabossCreateWorkspacePayload,
): Promise<WorkspaceResponsePayload> {
  const templateName = payload.template_name?.trim() || "";
  if (!templateName) {
    throw new Error(
      "Remote workspace creation currently requires a marketplace template.",
    );
  }
  if ((payload.template_mode || "").trim().toLowerCase() === "empty") {
    throw new Error("Remote empty-workspace creation is not supported yet.");
  }
  if (payload.template_root_path?.trim()) {
    throw new Error("Remote workspaces cannot be created from a local template path.");
  }
  if (payload.workspace_path?.trim()) {
    throw new Error("Remote workspaces cannot be pinned to a local filesystem path.");
  }

  const response = await requestDesktopControlPlaneJson<WorkspaceResponsePayload>(
    {
      method: "POST",
      path: DESKTOP_RUNTIME_WORKSPACES_PATH,
      payload: {
        name: payload.name,
        template_name: templateName,
        template_ref: payload.template_ref?.trim() || undefined,
        template_commit: payload.template_commit?.trim() || undefined,
        selected_apps:
          (payload.template_apps ?? []).filter(
            (item) => typeof item === "string" && item.trim(),
          ),
      },
    },
  );
  const withLocation = withCloudWorkspaceResponseLocation(response);
  rememberCloudWorkspaceRecord(withLocation.workspace);
  forgetWorkspaceRuntimeSession(withLocation.workspace.id);
  return withLocation;
}

async function createWorkspace(
  payload: HolabossCreateWorkspacePayload,
): Promise<WorkspaceResponsePayload> {
  return payload.location === "cloud"
    ? createCloudWorkspace(payload)
    : createLocalWorkspace(payload);
}

async function createWorkspaceLab(
  workspaceId: string,
  purpose: "workspace_onboarding" | "meeting_mode",
): Promise<WorkspaceLabResponsePayload> {
  const safeWorkspaceId = assertSafeWorkspaceId(workspaceId);
  return requestWorkspaceRuntimeJson<WorkspaceLabResponsePayload>(
    safeWorkspaceId,
    {
      method: "POST",
      path: `/api/v1/workspaces/${encodeURIComponent(safeWorkspaceId)}/labs`,
      payload: { purpose },
    },
  );
}

async function deleteWorkspace(
  workspaceId: string,
  keepFiles?: boolean,
): Promise<WorkspaceResponsePayload> {
  const safeWorkspaceId = assertSafeWorkspaceId(workspaceId);
  const location = await resolveWorkspaceLocation(safeWorkspaceId);
  if (location === "cloud") {
    throw new Error("Remote workspace deletion is not supported yet.");
  }
  return deleteLocalWorkspace(safeWorkspaceId, keepFiles);
}

async function activateWorkspaceRecord(
  workspaceId: string,
): Promise<WorkspaceResponsePayload> {
  const safeWorkspaceId = assertSafeWorkspaceId(workspaceId);
  const location = await resolveWorkspaceLocation(safeWorkspaceId);
  return location === "cloud"
    ? activateCloudWorkspaceRecord(safeWorkspaceId)
    : activateLocalWorkspaceRecord(safeWorkspaceId);
}

const workspaceRegistry = {
  listCachedWorkspaces,
};

const desktopWorkspaceControlPlane = createLocalWorkspaceControlPlane({
  listWorkspaces,
  workspaceRegistry,
  createWorkspace,
  createWorkspaceLab,
  deleteWorkspace,
  activateWorkspaceRecord,
  getWorkspaceLifecycle,
  openWorkspace,
});

async function pickWorkspaceRelocationFolder(
  workspaceId: string,
): Promise<WorkspaceRuntimeFolderSelectionPayload> {
  const safeWorkspaceId = assertSafeWorkspaceId(workspaceId);
  if ((await resolveWorkspaceLocation(safeWorkspaceId)) !== "local") {
    throw new Error(
      "Remote workspaces do not have a host-local folder to relocate.",
    );
  }
  const ownerWindow = mainWindow ?? BrowserWindow.getFocusedWindow() ?? null;
  const options: OpenDialogOptions = {
    properties: ["openDirectory", "createDirectory"],
    title: "Relocate Workspace Folder",
    buttonLabel: "Use This Folder",
    message: "Pick an empty folder or the existing workspace folder to move this workspace to.",
  };
  const result = ownerWindow
    ? await dialog.showOpenDialog(ownerWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true, rootPath: null };
  }

  const rootPath = path.resolve(result.filePaths[0]);
  if (!path.isAbsolute(rootPath)) {
    throw new Error("Workspace folder path must be absolute.");
  }
  if (existsSync(rootPath)) {
    const stat = statSync(rootPath);
    if (!stat.isDirectory()) {
      throw new Error("Selected path is not a directory.");
    }
    // Accept if it contains a matching workspace identity file.
    for (const identityFilePath of [
      path.join(rootPath, ".holaboss", "state", "workspace_id"),
      path.join(rootPath, ".holaboss", "workspace_id"),
    ]) {
      if (!existsSync(identityFilePath)) {
        continue;
      }
      const storedId = readFileSync(identityFilePath, "utf-8").trim();
      if (storedId === safeWorkspaceId) {
        return { canceled: false, rootPath };
      }
      throw new Error(
        `Selected folder belongs to a different workspace. Pick an empty folder or the original workspace folder.`,
      );
    }
    // Accept if empty (excluding .DS_Store).
    const entries = readdirSync(rootPath).filter((name) => name !== ".DS_Store");
    if (entries.length > 0) {
      throw new Error(
        `Selected folder must be empty (found ${entries.length} items). Pick an empty folder or the original workspace folder.`,
      );
    }
  }
  return { canceled: false, rootPath };
}

async function listRuntimeStates(
  workspaceId: string,
): Promise<SessionRuntimeStateListResponsePayload> {
  try {
    const response =
      await requestWorkspaceRuntimeJson<SessionRuntimeStateListResponsePayload>(
        workspaceId,
        {
          method: "GET",
          path: `/api/v1/agent-sessions/by-workspace/${encodeURIComponent(workspaceId)}/runtime-states`,
          params: {
            limit: 100,
            offset: 0,
          },
        },
      );
    const items = cacheRuntimeStateRecords(workspaceId, response.items ?? []);
    return {
      ...response,
      items,
      count: items.length,
    };
  } catch (error) {
    if (isTransientRuntimeError(error)) {
      const items = cachedRuntimeStateRecords(workspaceId);
      if (items.length > 0) {
        return { items, count: items.length };
      }
    }
    throw error;
  }
}

function normalizeListAgentSessionsRequest(
  payload: string | ListAgentSessionsRequestPayload,
): {
  workspaceId: string;
  includeArchived: boolean;
  limit: number;
  offset: number;
} {
  if (typeof payload === "string") {
    return {
      workspaceId: payload.trim(),
      includeArchived: false,
      limit: 100,
      offset: 0,
    };
  }
  return {
    workspaceId: payload.workspaceId.trim(),
    includeArchived: payload.includeArchived === true,
    limit:
      typeof payload.limit === "number" && Number.isFinite(payload.limit)
        ? Math.max(1, Math.min(500, Math.trunc(payload.limit)))
        : 100,
    offset:
      typeof payload.offset === "number" && Number.isFinite(payload.offset)
        ? Math.max(0, Math.trunc(payload.offset))
        : 0,
  };
}

async function listAgentSessions(
  payload: string | ListAgentSessionsRequestPayload,
): Promise<AgentSessionListResponsePayload> {
  const requestPayload = normalizeListAgentSessionsRequest(payload);
  if (!requestPayload.workspaceId) {
    return { items: [], count: 0 };
  }
  try {
    const response = await requestWorkspaceRuntimeJson<AgentSessionListResponsePayload>(
      requestPayload.workspaceId,
      {
        method: "GET",
        path: "/api/v1/agent-sessions",
        params: {
          workspace_id: requestPayload.workspaceId,
          include_archived: requestPayload.includeArchived,
          limit: requestPayload.limit,
          offset: requestPayload.offset,
        },
      },
    );
    const items = cacheAgentSessionRecords(
      requestPayload.workspaceId,
      response.items ?? [],
    );
    return {
      ...response,
      items,
      count: items.length,
    };
  } catch (error) {
    if (isTransientRuntimeError(error)) {
      const items = cachedAgentSessionRecords(requestPayload.workspaceId).filter(
        (item) =>
          requestPayload.includeArchived ||
          !(item.archived_at || "").trim(),
      );
      if (items.length > 0) {
        return { items, count: items.length };
      }
    }
    throw error;
  }
}

async function ensureWorkspaceMainSession(
  workspaceId: string,
): Promise<EnsureWorkspaceMainSessionResponsePayload> {
  const response =
    await requestWorkspaceRuntimeJson<EnsureWorkspaceMainSessionResponsePayload>(
      workspaceId,
      {
        method: "POST",
        path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/ensure-main-session`,
      },
    );
  if (response.session) {
    upsertCachedAgentSessionRecord(response.session);
  }
  return response;
}

async function createAgentSession(
  payload: CreateAgentSessionPayload,
): Promise<CreateAgentSessionResponsePayload> {
  const response =
    await requestWorkspaceRuntimeJson<CreateAgentSessionResponsePayload>(
      payload.workspace_id,
      {
        method: "POST",
        path: "/api/v1/agent-sessions",
        payload: {
          workspace_id: payload.workspace_id,
          session_id: payload.session_id ?? undefined,
          kind: payload.kind ?? undefined,
          title: payload.title ?? undefined,
          parent_session_id: payload.parent_session_id ?? undefined,
          created_by: payload.created_by ?? undefined,
        },
      },
    );
  if (response.session) {
    upsertCachedAgentSessionRecord(response.session);
  }
  return response;
}

function isMissingSessionBindingError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.trim().toLowerCase() === "session binding not found"
  );
}

function isWorkspaceNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.trim().toLowerCase() === "workspace not found"
  );
}

function emptySessionHistoryPayload(
  sessionId: string,
  workspaceId: string,
  request: Pick<SessionHistoryRequestPayload, "limit" | "offset"> = {},
): SessionHistoryResponsePayload {
  return {
    workspace_id: workspaceId,
    session_id: sessionId,
    harness: "",
    harness_session_id: "",
    source: "sandbox_local_storage",
    messages: [],
    count: 0,
    total: 0,
    limit: request.limit ?? 200,
    offset: request.offset ?? 0,
    raw: null,
  };
}

async function getSessionHistory(
  payload: SessionHistoryRequestPayload,
): Promise<SessionHistoryResponsePayload> {
  try {
    return await requestWorkspaceRuntimeJson<SessionHistoryResponsePayload>(
      payload.workspaceId,
      {
        method: "GET",
        path: `/api/v1/agent-sessions/${encodeURIComponent(payload.sessionId)}/history`,
        params: {
          workspace_id: payload.workspaceId,
          limit: payload.limit ?? 200,
          offset: payload.offset ?? 0,
          order: payload.order ?? "asc",
        },
      },
    );
  } catch (error) {
    if (
      isMissingSessionBindingError(error) ||
      isWorkspaceNotFoundError(error)
    ) {
      return emptySessionHistoryPayload(
        payload.sessionId,
        payload.workspaceId,
        payload,
      );
    }
    throw error;
  }
}

async function getSessionOutputEvents(
  payload: SessionOutputEventListRequestPayload,
): Promise<SessionOutputEventListResponsePayload> {
  return requestWorkspaceRuntimeJson<SessionOutputEventListResponsePayload>(
    payload.workspaceId,
    {
      method: "GET",
      path: `/api/v1/agent-sessions/${encodeURIComponent(payload.sessionId)}/outputs/events`,
      params: {
        workspace_id: payload.workspaceId,
        input_id: payload.inputId ?? undefined,
        include_history: true,
        after_event_id: 0,
        include_native: false,
      },
    },
  );
}

function normalizeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Operation failed.";
}

function contextualWorkspaceCreateError(stage: string, error: unknown) {
  return `${stage}: ${normalizeErrorMessage(error)}`;
}

async function queueSessionInput(
  payload: HolabossQueueSessionInputPayload,
): Promise<EnqueueSessionInputResponsePayload> {
  await syncDesktopBrowserCapabilityConfig();
  const currentConfig = await readRuntimeConfigFile();
  if (sessionQueueRequiresRuntimeBinding(currentConfig, payload.model)) {
    await ensureRuntimeBindingReadyForWorkspaceFlow("session_queue");
  }
  const idempotencyKey =
    payload.idempotency_key?.trim() || `desktop-session-input:${randomUUID()}`;
  const response = await requestWorkspaceRuntimeJson<EnqueueSessionInputResponsePayload>(
    payload.workspace_id,
    {
      method: "POST",
      path: "/api/v1/agent-sessions/queue",
      payload: {
        workspace_id: payload.workspace_id,
        text: payload.text,
        image_urls: payload.image_urls,
        attachments: payload.attachments ?? null,
        session_id: payload.session_id,
        idempotency_key: idempotencyKey,
        priority: payload.priority ?? 0,
        model: payload.model,
        thinking_value: payload.thinking_value ?? null,
      },
      retryTransientErrors: true,
    },
  );
  const runtimeStatus = response.runtime_status?.trim() || response.status || "QUEUED";
  const effectiveState =
    response.effective_state?.trim() || runtimeStatus || "QUEUED";
  upsertCachedRuntimeStateRecord({
    workspace_id: payload.workspace_id,
    session_id: response.session_id,
    status: runtimeStatus,
    effective_state: effectiveState,
    runtime_status: runtimeStatus,
    has_queued_inputs: response.has_queued_inputs === true,
    current_input_id: response.current_input_id ?? response.input_id,
    current_worker_id: null,
    lease_until: null,
    heartbeat_at: null,
    last_error: null,
    last_turn_status: null,
    last_turn_completed_at: null,
    last_turn_stop_reason: null,
    created_at: utcNowIso(),
    updated_at: utcNowIso(),
  });
  return response;
}

async function getOnboardingStatus(
  workspaceId: string,
): Promise<WorkspaceOnboardingStatusPayload> {
  return requestWorkspaceRuntimeJson<WorkspaceOnboardingStatusPayload>(
    workspaceId,
    {
      method: "GET",
      path: "/api/v1/capabilities/runtime-tools/onboarding/status",
      params: {
        workspace_id: workspaceId,
      },
    },
  );
}

async function continueDeterministicOnboarding(
  workspaceId: string,
): Promise<WorkspaceResponsePayload> {
  const safeWorkspaceId = assertSafeWorkspaceId(workspaceId);
  const current = await runtimeClient.workspaces.get(safeWorkspaceId);
  const onboardingSessionId =
    current.workspace.onboarding_session_id?.trim() || "";
  if (onboardingSessionId) {
    throw new Error(
      "Deterministic onboarding is only available for non-agentic onboarding workspaces.",
    );
  }
  const status = (current.workspace.onboarding_status || "").trim().toLowerCase();
  if (status === "completed" || status === "not_required") {
    return withWorkspaceResponseLocation(current);
  }
  const currentState = (current.workspace.onboarding_state || "")
    .trim()
    .toLowerCase();
  if (currentState === "deterministic_intro") {
    return withWorkspaceResponseLocation(
      await runtimeClient.workspaces.update(safeWorkspaceId, {
        onboarding_status: "in_progress",
        onboarding_state: "deterministic_context_fetching",
        error_message: null,
      }),
    );
  }
  return withWorkspaceResponseLocation(
    await runtimeClient.workspaces.update(safeWorkspaceId, {
      onboarding_status: "completed",
      onboarding_state: null,
      onboarding_completed_at: new Date().toISOString(),
      onboarding_completion_summary: "Deterministic onboarding completed",
      onboarding_requested_by: "workspace_user",
      error_message: null,
    }),
  );
}

async function skipWorkspaceOnboarding(
  workspaceId: string,
): Promise<WorkspaceResponsePayload> {
  const safeWorkspaceId = assertSafeWorkspaceId(workspaceId);
  const current = await runtimeClient.workspaces.get(safeWorkspaceId);
  const currentWorkspace = current.workspace;
  const status = (currentWorkspace.onboarding_status || "").trim().toLowerCase();
  if (status === "completed" || status === "not_required") {
    return withWorkspaceResponseLocation(current);
  }

  const workspaceRole = (currentWorkspace.workspace_role || "")
    .trim()
    .toLowerCase();
  const sourceWorkspaceId =
    workspaceRole === "draft_lab"
      ? currentWorkspace.source_workspace_id?.trim() || safeWorkspaceId
      : safeWorkspaceId;
  let labWorkspaceId =
    workspaceRole === "draft_lab" ? safeWorkspaceId : "";

  if (!labWorkspaceId) {
    try {
      const onboardingStatus = await getOnboardingStatus(sourceWorkspaceId);
      labWorkspaceId = onboardingStatus.lab_workspace_id?.trim() || "";
    } catch {
      labWorkspaceId = "";
    }
  }

  if (labWorkspaceId) {
    const abandoned = await requestWorkspaceRuntimeJson<WorkspaceLabResponsePayload>(
      sourceWorkspaceId,
      {
        method: "POST",
        path: `/api/v1/workspace-labs/${encodeURIComponent(labWorkspaceId)}/abandon`,
        payload: {
          summary: "Workspace onboarding skipped",
        },
      },
    );
    if (abandoned.source) {
      return withWorkspaceResponseLocation({
        workspace: abandoned.source,
      });
    }
    return withWorkspaceResponseLocation(
      await runtimeClient.workspaces.get(sourceWorkspaceId),
    );
  }

  return withWorkspaceResponseLocation(
    await runtimeClient.workspaces.update(sourceWorkspaceId, {
      onboarding_status: "completed",
      onboarding_state: currentWorkspace.onboarding_session_id?.trim()
        ? "abandoned"
        : null,
      onboarding_session_id: null,
      onboarding_completed_at: new Date().toISOString(),
      onboarding_completion_summary: "Workspace onboarding skipped",
      onboarding_requested_by: "workspace_user",
      error_message: null,
    }),
  );
}

async function approveOnboardingAlignment(
  workspaceId: string,
): Promise<WorkspaceOnboardingStatusPayload> {
  return requestWorkspaceRuntimeJson<WorkspaceOnboardingStatusPayload>(
    workspaceId,
    {
      method: "POST",
      path: "/api/v1/capabilities/runtime-tools/onboarding/alignment/approve",
      payload: {
        workspace_id: workspaceId,
      },
    },
  );
}

async function answerOnboardingAlignmentQuestion(
  workspaceId: string,
  payload: {
    model?: string | null;
    thinkingValue?: string | null;
    optionId?: string | null;
    responseText?: string | null;
    notes?: string | null;
    answers?: Array<{
      questionId?: string | null;
      optionId?: string | null;
      responseText?: string | null;
      notes?: string | null;
    }>;
  },
): Promise<WorkspaceOnboardingStatusPayload> {
  return requestWorkspaceRuntimeJson<WorkspaceOnboardingStatusPayload>(
    workspaceId,
    {
      method: "POST",
      path: "/api/v1/capabilities/runtime-tools/onboarding/alignment-question/answer",
      payload: {
        workspace_id: workspaceId,
        model: payload.model ?? undefined,
        thinking_value: payload.thinkingValue ?? undefined,
        option_id: payload.optionId ?? undefined,
        response_text: payload.responseText ?? undefined,
        notes: payload.notes ?? undefined,
        answers: Array.isArray(payload.answers)
          ? payload.answers.map((answer) => ({
              question_id: answer.questionId ?? undefined,
              option_id: answer.optionId ?? undefined,
              response_text: answer.responseText ?? undefined,
              notes: answer.notes ?? undefined,
            }))
          : undefined,
      },
    },
  );
}

async function requestOnboardingAlignmentRevision(
  workspaceId: string,
): Promise<WorkspaceOnboardingStatusPayload> {
  return requestWorkspaceRuntimeJson<WorkspaceOnboardingStatusPayload>(
    workspaceId,
    {
      method: "POST",
      path: "/api/v1/capabilities/runtime-tools/onboarding/alignment/revise",
      payload: {
        workspace_id: workspaceId,
      },
    },
  );
}

async function requestOnboardingVerificationRevision(
  workspaceId: string,
): Promise<WorkspaceOnboardingStatusPayload> {
  return requestWorkspaceRuntimeJson<WorkspaceOnboardingStatusPayload>(
    workspaceId,
    {
      method: "POST",
      path: "/api/v1/capabilities/runtime-tools/onboarding/verification/revise",
      payload: {
        workspace_id: workspaceId,
      },
    },
  );
}

async function completeOnboarding(
  workspaceId: string,
  payload: { summary: string; requestedBy?: string | null },
): Promise<WorkspaceOnboardingStatusPayload | WorkspaceLabResponsePayload> {
  return requestWorkspaceRuntimeJson<
    WorkspaceOnboardingStatusPayload | WorkspaceLabResponsePayload
  >(workspaceId, {
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/onboarding/complete",
    payload: {
      workspace_id: workspaceId,
      summary: payload.summary,
      requested_by: payload.requestedBy ?? undefined,
    },
  });
}

async function pauseSessionRun(
  payload: HolabossPauseSessionRunPayload,
): Promise<PauseSessionRunResponsePayload> {
  const response = await requestWorkspaceRuntimeJson<PauseSessionRunResponsePayload>(
    payload.workspace_id,
    {
      method: "POST",
      path: `/api/v1/agent-sessions/${encodeURIComponent(payload.session_id)}/pause`,
      payload: {
        workspace_id: payload.workspace_id,
      },
    },
  );
  upsertCachedRuntimeStateRecord({
    workspace_id: payload.workspace_id,
    session_id: response.session_id || payload.session_id,
    status: response.status || "PAUSED",
    effective_state: response.status || "PAUSED",
    runtime_status: response.status || "PAUSED",
    has_queued_inputs: false,
    current_input_id: response.input_id || null,
    current_worker_id: null,
    lease_until: null,
    heartbeat_at: null,
    last_error: null,
    last_turn_status: null,
    last_turn_completed_at: null,
    last_turn_stop_reason: null,
    created_at: utcNowIso(),
    updated_at: utcNowIso(),
  });
  return response;
}

async function updateQueuedSessionInput(
  payload: HolabossUpdateQueuedSessionInputPayload,
): Promise<UpdateQueuedSessionInputResponsePayload> {
  return requestWorkspaceRuntimeJson<UpdateQueuedSessionInputResponsePayload>(
    payload.workspace_id,
    {
      method: "PATCH",
      path: `/api/v1/agent-sessions/${encodeURIComponent(payload.session_id)}/inputs/${encodeURIComponent(payload.input_id)}`,
      payload: {
        workspace_id: payload.workspace_id,
        text: payload.text,
      },
    },
  );
}

async function cancelQueuedSessionInput(
  payload: HolabossCancelQueuedSessionInputPayload,
): Promise<CancelQueuedSessionInputResponsePayload> {
  return requestWorkspaceRuntimeJson<CancelQueuedSessionInputResponsePayload>(
    payload.workspace_id,
    {
      method: "DELETE",
      path: `/api/v1/agent-sessions/${encodeURIComponent(payload.session_id)}/inputs/${encodeURIComponent(payload.input_id)}?workspace_id=${encodeURIComponent(payload.workspace_id)}`,
    },
  );
}

async function* iterSseEvents(stream: NodeJS.ReadableStream) {
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let eventId: string | null = null;
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length === 0) {
      return null;
    }
    const data = dataLines.join("\n");
    dataLines = [];
    const payload = { event: eventName, id: eventId, data };
    eventName = "message";
    eventId = null;
    return payload;
  };

  for await (const chunk of stream) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    buffer += decoder.decode(value, { stream: true });

    while (buffer.includes("\n")) {
      const newlineIndex = buffer.indexOf("\n");
      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const line = rawLine.replace(/\r$/, "");

      if (line.startsWith(":")) {
        continue;
      }

      if (line === "") {
        const event = flush();
        if (event) {
          yield event;
        }
        continue;
      }

      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim() || "message";
        continue;
      }

      if (line.startsWith("id:")) {
        eventId = line.slice("id:".length).trim() || null;
        continue;
      }

      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim().startsWith("data:")) {
    dataLines.push(buffer.trim().slice("data:".length).trim());
  }
  const tail = flush();
  if (tail) {
    yield tail;
  }
}

function emitSessionStreamEvent(payload: HolabossSessionStreamEventPayload) {
  const detail =
    payload.type === "event"
      ? `event=${payload.event?.event || "message"} id=${payload.event?.id || "-"}`
      : payload.type === "error"
        ? `error=${payload.error || "unknown"}`
        : "done";
  appendSessionStreamDebug(payload.streamId, `emit_${payload.type}`, detail);

  const windows = BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed(),
  );
  if (windows.length === 0) {
    appendSessionStreamDebug(payload.streamId, "emit_skipped", "no windows");
    return;
  }
  for (const win of windows) {
    try {
      win.webContents.send("workspace:sessionStream", payload);
    } catch (error) {
      appendSessionStreamDebug(
        payload.streamId,
        "emit_error",
        error instanceof Error ? error.message : "webContents.send failed",
      );
    }
  }
}

async function openSessionOutputStream(
  payload: HolabossStreamSessionOutputsPayload,
): Promise<HolabossSessionStreamHandlePayload> {
  const streamId = crypto.randomUUID();
  const controller = new AbortController();
  sessionOutputStreams.set(streamId, controller);
  appendSessionStreamDebug(streamId, "open_requested", JSON.stringify(payload));

  void (async () => {
    try {
      const workspaceSession = payload.workspaceId
        ? await resolveWorkspaceRuntimeSession(payload.workspaceId)
        : null;
      const status = workspaceSession ? null : await ensureRuntimeReady();
      const url = new URL(
        `/api/v1/agent-sessions/${payload.sessionId}/outputs/stream`,
        workspaceSession?.runtime_base_url ?? status?.url ?? runtimeBaseUrl(),
      );
      if (payload.inputId) {
        url.searchParams.set("input_id", payload.inputId);
      }
      if (payload.workspaceId) {
        url.searchParams.set("workspace_id", payload.workspaceId);
      }
      if (payload.includeHistory !== undefined) {
        url.searchParams.set(
          "include_history",
          payload.includeHistory ? "true" : "false",
        );
      }
      url.searchParams.set("include_native", "false");
      if (payload.stopOnTerminal !== undefined) {
        url.searchParams.set(
          "stop_on_terminal",
          payload.stopOnTerminal ? "true" : "false",
        );
      }
      appendSessionStreamDebug(streamId, "http_request_start", url.toString());
      await new Promise<void>((resolve, reject) => {
        const abortError = new Error("Stream aborted.");
        abortError.name = "AbortError";

        const request = httpRequest(
          {
            hostname: url.hostname,
            port: url.port || "80",
            path: `${url.pathname}${url.search}`,
            method: "GET",
            headers: {
              Accept: "text/event-stream",
              ...(workspaceSession?.runtime_auth_token
                ? {
                    "X-API-Key": workspaceSession.runtime_auth_token,
                  }
                : {}),
            },
            // Session output uses a long-lived SSE connection. Let runtime-side
            // queue and runner recovery determine terminal failure instead of
            // aborting the desktop stream after 30s of quiet.
            timeout: 0,
          },
          (response) => {
            const statusCode = response.statusCode ?? 0;
            appendSessionStreamDebug(
              streamId,
              "http_response",
              `status=${statusCode} message=${response.statusMessage || ""}`,
            );
            if (statusCode < 200 || statusCode >= 300) {
              const chunks: Buffer[] = [];
              response.on("data", (chunk) => {
                chunks.push(
                  Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
                );
              });
              response.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf-8");
                reject(
                  runtimeErrorFromBody(
                    statusCode,
                    response.statusMessage,
                    body,
                  ),
                );
              });
              return;
            }

            void (async () => {
              try {
                for await (const event of iterSseEvents(response)) {
                  appendSessionStreamDebug(
                    streamId,
                    "sse_event_raw",
                    `event=${event.event} id=${event.id || "-"}`,
                  );
                  let parsedData: unknown = event.data;
                  try {
                    parsedData = JSON.parse(event.data);
                  } catch {
                    parsedData = event.data;
                  }
                  const normalizedData =
                    parsedData &&
                    typeof parsedData === "object" &&
                    !Array.isArray(parsedData) &&
                    "event_type" in parsedData
                      ? parsedData
                      : {
                          event_type: event.event,
                          payload: parsedData,
                        };

                  emitSessionStreamEvent({
                    streamId,
                    type: "event",
                    event: {
                      event: event.event,
                      id: event.id,
                      data: normalizedData,
                    },
                  });
                  await new Promise<void>((resolve) => {
                    setImmediate(resolve);
                  });
                }
                appendSessionStreamDebug(
                  streamId,
                  "sse_complete",
                  "iterSseEvents completed",
                );
                resolve();
              } catch (streamError) {
                appendSessionStreamDebug(
                  streamId,
                  "sse_error",
                  streamError instanceof Error
                    ? streamError.message
                    : "unknown stream error",
                );
                reject(streamError);
              }
            })();
          },
        );

        const abortRequest = () => {
          request.destroy(abortError);
        };
        controller.signal.addEventListener("abort", abortRequest, {
          once: true,
        });
        request.on("close", () => {
          controller.signal.removeEventListener("abort", abortRequest);
        });
        request.on("timeout", () => {
          appendSessionStreamDebug(streamId, "http_timeout", "request timeout");
          request.destroy(new Error("Session stream request timed out."));
        });
        request.on("error", (requestError) => {
          appendSessionStreamDebug(
            streamId,
            "http_error",
            requestError instanceof Error
              ? requestError.message
              : "request error",
          );
          reject(requestError);
        });
        request.end();
      });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AbortError") {
        appendSessionStreamDebug(
          streamId,
          "open_error",
          error instanceof Error ? error.message : "unknown error",
        );
        emitSessionStreamEvent({
          streamId,
          type: "error",
          error:
            error instanceof Error
              ? error.message
              : "Failed to stream session output.",
        });
      }
    } finally {
      sessionOutputStreams.delete(streamId);
      appendSessionStreamDebug(streamId, "open_finally", "stream closed");
      emitSessionStreamEvent({ streamId, type: "done" });
    }
  })();

  return { streamId };
}

async function closeSessionOutputStream(
  streamId: string,
  reason?: string,
): Promise<void> {
  const controller = sessionOutputStreams.get(streamId);
  if (!controller) {
    appendSessionStreamDebug(
      streamId,
      "close_ignored",
      reason || "missing_controller",
    );
    return;
  }
  appendSessionStreamDebug(
    streamId,
    "close_requested",
    reason || "unspecified",
  );
  controller.abort();
  sessionOutputStreams.delete(streamId);
}

function emitRuntimeState(force = false) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const nextSignature = JSON.stringify({
    status: runtimeStatus.status,
    available: runtimeStatus.available,
    runtimeRoot: runtimeStatus.runtimeRoot,
    sandboxRoot: runtimeStatus.sandboxRoot,
    executablePath: runtimeStatus.executablePath,
    url: runtimeStatus.url,
    pid: runtimeStatus.pid,
    harness: runtimeStatus.harness,
    desktopBrowserReady: runtimeStatus.desktopBrowserReady,
    desktopBrowserUrl: runtimeStatus.desktopBrowserUrl,
    startupMessage: runtimeStatus.startupMessage,
    lastError: runtimeStatus.lastError,
  });
  if (!force && nextSignature === lastRuntimeStateSignature) {
    return;
  }
  lastRuntimeStateSignature = nextSignature;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("runtime:state", runtimeStatus);
  }
  if (authPopupWindow && !authPopupWindow.isDestroyed()) {
    authPopupWindow.webContents.send("runtime:state", runtimeStatus);
  }
}

async function emitRuntimeConfig(config?: RuntimeConfigPayload) {
  const payload = config ?? (await getRuntimeConfigWithoutCatalogRefresh());
  const nextSignature = JSON.stringify(payload);
  if (nextSignature === lastRuntimeConfigSignature) {
    return;
  }
  lastRuntimeConfigSignature = nextSignature;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("runtime:config", payload);
  }
  if (authPopupWindow && !authPopupWindow.isDestroyed()) {
    authPopupWindow.webContents.send("runtime:config", payload);
  }
}

async function fileExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

const REQUIRED_RUNTIME_ROOT_PATH_GROUPS = [
  runtimeBundleExecutableRelativePaths(CURRENT_RUNTIME_PLATFORM),
  ["package-metadata.json"],
  runtimeBundleNodeRelativePaths(CURRENT_RUNTIME_PLATFORM),
  runtimeBundleNpmRelativePaths(CURRENT_RUNTIME_PLATFORM),
  runtimeBundlePythonRelativePaths(CURRENT_RUNTIME_PLATFORM),
  [path.join("runtime", "metadata.json")],
  [path.join("runtime", "api-server", "dist", "index.mjs")],
];

async function firstExistingRelativePath(
  rootPath: string,
  relativePaths: readonly string[],
): Promise<string | null> {
  for (const relativePath of relativePaths) {
    const absolutePath = path.join(rootPath, relativePath);
    if (await fileExists(absolutePath)) {
      return absolutePath;
    }
  }
  return null;
}

async function resolveRuntimeExecutablePath(
  runtimeRoot: string,
): Promise<string | null> {
  return firstExistingRelativePath(
    runtimeRoot,
    runtimeBundleExecutableRelativePaths(CURRENT_RUNTIME_PLATFORM),
  );
}

async function resolveRuntimeNodePath(
  runtimeRoot: string,
): Promise<string | null> {
  return firstExistingRelativePath(
    runtimeRoot,
    runtimeBundleNodeRelativePaths(CURRENT_RUNTIME_PLATFORM),
  );
}

async function resolveRuntimeLaunchSpec(
  runtimeRoot: string,
  executablePath: string,
): Promise<RuntimeLaunchSpec | null> {
  const extension = path.extname(executablePath).toLowerCase();
  if (extension === ".mjs") {
    const nodePath = await resolveRuntimeNodePath(runtimeRoot);
    if (!nodePath) {
      return null;
    }
    return {
      command: nodePath,
      args: [executablePath],
    };
  }

  if (extension === ".ps1") {
    return {
      command: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        executablePath,
      ],
    };
  }

  if (extension === ".cmd" || extension === ".bat") {
    return {
      command: process.env.ComSpec?.trim() || "cmd.exe",
      args: ["/d", "/s", "/c", `"${executablePath}"`],
    };
  }

  return {
    command: executablePath,
    args: [],
  };
}

async function killWindowsProcessTree(pid: number | undefined | null) {
  if (!pid) {
    return;
  }

  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => resolve());
    killer.once("exit", () => resolve());
  });
}

async function validateRuntimeRoot(runtimeRoot: string) {
  for (const relativePaths of REQUIRED_RUNTIME_ROOT_PATH_GROUPS) {
    if (!(await firstExistingRelativePath(runtimeRoot, relativePaths))) {
      return `Runtime bundle is incomplete. Missing ${relativePaths.join(" or ")} under ${runtimeRoot}. Rebuild or restage ${RUNTIME_BUNDLE_DIR}.`;
    }
  }

  return null;
}

async function resolveRuntimeRoot() {
  const candidates = [
    process.env.HOLABOSS_RUNTIME_ROOT,
    isDev ? path.resolve(__dirname, "..", RUNTIME_BUNDLE_DIR) : undefined,
    isDev
      ? DEV_RUNTIME_ROOT
      : path.join(process.resourcesPath, RUNTIME_BUNDLE_DIR),
  ].filter((value): value is string =>
    Boolean(value && value.trim().length > 0),
  );

  let firstInvalidError: string | null = null;
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const validationError = await validateRuntimeRoot(resolved);
    if (!validationError) {
      return {
        runtimeRoot: resolved,
        validationError: null,
      };
    }
    if (!firstInvalidError) {
      firstInvalidError = validationError;
    }
  }

  return {
    runtimeRoot: null,
    validationError: firstInvalidError,
  };
}

async function waitForRuntimeHealth(
  url: string,
  attempts = DEFAULT_RUNTIME_STARTUP_HEALTH_ATTEMPTS,
  delayMs = RUNTIME_STARTUP_HEALTH_DELAY_MS,
  options: {
    abortWhen?: () => boolean;
  } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await isRuntimeHealthy(url)) {
      return true;
    }
    if (options.abortWhen?.()) {
      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (options.abortWhen?.()) {
      return false;
    }
  }

  return false;
}

async function isRuntimeHealthy(url: string) {
  return new Promise<boolean>((resolve) => {
    const target = new URL("/healthz", url);
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        timeout: 1500,
      },
      (response) => {
        response.resume();
        resolve(
          (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
        );
      },
    );

    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
    request.end();
  });
}

function persistedRuntimeMatchesCurrentLaunch(
  record: PersistedRuntimeProcessStateRecord | null,
  sandboxRoot: string,
) {
  return (
    record?.launchId === DESKTOP_LAUNCH_ID &&
    record?.sandboxRoot === sandboxRoot
  );
}

function processExists(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
  }
}

async function killRuntimeProcessByPid(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return false;
  }

  if (process.platform === "win32") {
    await killWindowsProcessTree(pid);
    return !processExists(pid);
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !processExists(pid);
  }

  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (!processExists(pid)) {
      return true;
    }
    await sleep(100);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return !processExists(pid);
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!processExists(pid)) {
      return true;
    }
    await sleep(100);
  }

  return !processExists(pid);
}

function windowsPowerShellPath() {
  const systemRoot = (process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows").trim();
  if (!systemRoot) {
    return "powershell.exe";
  }
  return path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function killRuntimePortListener(port: number) {
  if (!Number.isInteger(port) || port <= 0) {
    return;
  }

  try {
    if (process.platform === "win32") {
      execFileSync(
        windowsPowerShellPath(),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          [
            `$port = ${port};`,
            "Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |",
            "  Where-Object { $_.State -eq 'Listen' } |",
            "  Select-Object -ExpandProperty OwningProcess -Unique |",
            "  ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }",
          ].join(" "),
        ],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      return;
    }

    // Restrict to LISTEN state so health-check sockets do not kill the caller.
    execFileSync(
      "/bin/bash",
      [
        "-lc",
        `command -v lsof >/dev/null 2>&1 && kill $(lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null) 2>/dev/null || true`,
      ],
      {
        stdio: "ignore",
      },
    );
  } catch {
    // Ignore best-effort stale-port cleanup failures.
  }
}

async function waitForRuntimeShutdown(
  url: string,
  attempts = 20,
  delayMs = 150,
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!(await isRuntimeHealthy(url))) {
      return true;
    }
    await sleep(delayMs);
  }
  return !(await isRuntimeHealthy(url));
}

async function terminateDetachedRuntime(params: {
  reason: string;
  url: string;
  sandboxRoot: string;
}) {
  const persisted = readPersistedRuntimeProcessState();
  const pid = persisted?.pid ?? null;
  if (pid !== null) {
    await killRuntimeProcessByPid(pid);
  }
  let stopped = await waitForRuntimeShutdown(params.url, 10, 150);
  if (!stopped) {
    killRuntimePortListener(runtimeApiPort());
    stopped = await waitForRuntimeShutdown(params.url, 20, 150);
  }

  appendRuntimeEventLog({
    category: "runtime",
    event: "embedded_runtime.detached_cleanup",
    outcome: stopped ? "success" : "error",
    detail: `reason=${params.reason} launch_id=${persisted?.launchId ?? "unknown"} pid=${pid ?? "null"} sandbox_root=${persisted?.sandboxRoot ?? params.sandboxRoot}`,
  });

  if (stopped) {
    persistRuntimeProcessState({
      pid: null,
      status: "stopped",
      lastStoppedAt: utcNowIso(),
      lastError: "",
    });
  }

  return {
    stopped,
    persisted,
  };
}

async function ensureRuntimePortAvailable(params: {
  url: string;
  sandboxRoot: string;
  reason: string;
}) {
  if (!(await isRuntimeHealthy(params.url))) {
    return "available" as const;
  }

  const persisted = readPersistedRuntimeProcessState();
  if (persistedRuntimeMatchesCurrentLaunch(persisted, params.sandboxRoot)) {
    return "reused" as const;
  }

  const { stopped } = await terminateDetachedRuntime(params);
  return stopped ? ("available" as const) : ("blocked" as const);
}

function runtimeUnavailableStatus(hasBundle: boolean): RuntimeStatus {
  if (runtimeStartupInFlight && hasBundle) {
    return "starting";
  }
  if (runtimeProcess) {
    return "starting";
  }
  return hasBundle ? "stopped" : "missing";
}

async function refreshRuntimeStatus() {
  const { runtimeRoot, validationError } = await resolveRuntimeRoot();
  const executablePath = runtimeRoot
    ? await resolveRuntimeExecutablePath(runtimeRoot)
    : null;
  const sandboxRoot = runtimeSandboxRoot();
  const persisted = readPersistedRuntimeProcessState();
  const persistedPid = persistedRuntimeMatchesCurrentLaunch(
    persisted,
    sandboxRoot,
  )
    ? persisted?.pid ?? null
    : null;
  const harness = process.env.HOLABOSS_RUNTIME_HARNESS || "pi";
  const workflowBackend =
    process.env.HOLABOSS_RUNTIME_WORKFLOW_BACKEND || "remote_api";
  const url = runtimeBaseUrl();
  const healthy = await isRuntimeHealthy(url);
  const hasBundle = Boolean(runtimeRoot && executablePath);
  const unavailableStatus = runtimeUnavailableStatus(hasBundle);

  if (healthy) {
    persistRuntimeProcessState({
      pid: runtimeProcess?.pid ?? persistedPid,
      status: "running",
      lastHealthyAt: utcNowIso(),
      lastError: "",
    });
    runtimeStatus = withDesktopBrowserStatus({
      status: "running",
      available: hasBundle,
      runtimeRoot,
      sandboxRoot,
      executablePath,
      url,
      pid: runtimeProcess?.pid ?? persistedPid,
      harness,
      startupMessage: null,
      lastError: "",
    });
    emitRuntimeState();
    return runtimeStatus;
  }

  runtimeStatus = withDesktopBrowserStatus({
    ...runtimeStatus,
    available: hasBundle,
    runtimeRoot,
    sandboxRoot,
    executablePath,
    url,
    harness,
    status: unavailableStatus,
    startupMessage:
      unavailableStatus === "starting" ? runtimeStatus.startupMessage : null,
    lastError:
      hasBundle
        ? runtimeStartupInFlight
          ? ""
          : runtimeStatus.lastError
        : validationError ||
          `Runtime bundle not found. Set HOLABOSS_RUNTIME_ROOT or package ${RUNTIME_BUNDLE_DIR} into app resources.`,
  });
  emitRuntimeState();
  return runtimeStatus;
}

async function stopEmbeddedRuntime() {
  await withRuntimeLifecycleLock(async () => {
    const running = runtimeProcess;
    runtimeProcess = null;
    if (!running) {
      const url = runtimeBaseUrl();
      if (await isRuntimeHealthy(url)) {
        const { stopped } = await terminateDetachedRuntime({
          reason: "quit_without_child_handle",
          url,
          sandboxRoot: runtimeSandboxRoot(),
        });
        const nextStatus = stopped ? "stopped" : "error";
        const nextError = stopped
          ? ""
          : "Runtime is still responding after detached cleanup.";
        runtimeStatus = withDesktopBrowserStatus({
          ...runtimeStatus,
          status: nextStatus,
          pid: null,
          startupMessage: null,
          lastError: nextError,
        });
        if (!stopped) {
          persistRuntimeProcessState({
            pid: null,
            status: "error",
            lastStoppedAt: utcNowIso(),
            lastError: nextError,
          });
        }
        emitRuntimeState();
        return;
      }
      if (
        runtimeStatus.status === "running" ||
        runtimeStatus.status === "starting"
      ) {
        runtimeStatus = withDesktopBrowserStatus({
          ...runtimeStatus,
          status: "stopped",
          pid: null,
          startupMessage: null,
        });
        persistRuntimeProcessState({
          pid: null,
          status: "stopped",
          lastStoppedAt: utcNowIso(),
          lastError: "",
        });
        emitRuntimeState();
      }
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      let forceSettleTimer: NodeJS.Timeout | null = null;
      let sigkillTimer: NodeJS.Timeout | null = null;
      const settle = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (forceSettleTimer) {
          clearTimeout(forceSettleTimer);
        }
        if (sigkillTimer) {
          clearTimeout(sigkillTimer);
        }
        running.removeListener("exit", onExit);
        resolve();
      };
      const onExit = () => settle();
      running.once("exit", onExit);

      intentionallyStoppedRuntimeProcesses.add(running);
      if (process.platform === "win32") {
        void killWindowsProcessTree(running.pid).finally(() => {
          forceSettleTimer = setTimeout(() => settle(), 1000);
          forceSettleTimer.unref();
        });
        return;
      }

      sigkillTimer = setTimeout(() => {
        if (running.exitCode === null && running.signalCode === null) {
          try {
            running.kill("SIGKILL");
          } catch {
            settle();
            return;
          }
        }
        forceSettleTimer = setTimeout(() => settle(), 1000);
        forceSettleTimer.unref();
      }, 3000);
      sigkillTimer.unref();
      try {
        const signalSent = running.kill("SIGTERM");
        if (
          !signalSent &&
          (running.exitCode !== null || running.signalCode !== null)
        ) {
          settle();
        }
      } catch {
        settle();
      }
    });
  });
}

async function ensureAppQuitCleanup(): Promise<void> {
  if (appQuitCleanupFinished) {
    return;
  }
  if (!appQuitCleanupPromise) {
    // Block the final Electron quit until embedded services have been torn down.
    appQuitCleanupPromise = Promise.allSettled([
      stopDesktopBrowserService(),
      stopEmbeddedRuntime(),
    ])
      .then(() => {
        appQuitCleanupFinished = true;
      })
      .finally(() => {
        appQuitCleanupPromise = null;
        try {
          cachedRuntimeProcessStateDatabase?.close();
        } catch {
          // ignore
        }
        cachedRuntimeProcessStateDatabase = null;
        cachedRuntimeProcessStateStatement = null;
        for (const dispose of cachedRuntimeStatementDisposers) {
          try {
            dispose();
          } catch {
            // ignore
          }
        }
      });
  }
  await appQuitCleanupPromise;
}

async function startEmbeddedRuntime() {
  return withRuntimeLifecycleLock(async () => {
    runtimeStartupInFlight = true;
    try {
      if (runtimeProcess) {
        return refreshRuntimeStatus();
      }

      const { runtimeRoot, validationError } = await resolveRuntimeRoot();
      const executablePath = runtimeRoot
        ? await resolveRuntimeExecutablePath(runtimeRoot)
        : null;
      const sandboxRoot = runtimeSandboxRoot();
      const harness = process.env.HOLABOSS_RUNTIME_HARNESS || "pi";
      const workflowBackend =
        process.env.HOLABOSS_RUNTIME_WORKFLOW_BACKEND || "remote_api";
      const url = runtimeBaseUrl();

      await fs.mkdir(sandboxRoot, { recursive: true });
      await bootstrapRuntimeDatabase();
      bootstrapControlPlaneDatabase();
      const startupMessage = runtimeStartupMessage();

      const preflightRuntimePort = await ensureRuntimePortAvailable({
        url,
        sandboxRoot,
        reason: "startup_preflight",
      });
      if (preflightRuntimePort === "reused") {
        return refreshRuntimeStatus();
      }
      if (preflightRuntimePort === "blocked") {
        const portCleanupError =
          "A stale runtime is still bound to the profile runtime port. Quit the other desktop instance or kill the orphaned runtime process.";
        runtimeStatus = withDesktopBrowserStatus({
          ...runtimeStatus,
          status: "error",
          available: Boolean(runtimeRoot && executablePath),
          runtimeRoot,
          sandboxRoot,
          executablePath,
          url,
          pid: null,
          harness,
          startupMessage: null,
          lastError: portCleanupError,
        });
        persistRuntimeProcessState({
          pid: null,
          status: "error",
          lastError: portCleanupError,
        });
        emitRuntimeState();
        return runtimeStatus;
      }

      runtimeStatus = withDesktopBrowserStatus({
        ...runtimeStatus,
        status: runtimeRoot && executablePath ? "starting" : "missing",
        available: Boolean(runtimeRoot && executablePath),
        runtimeRoot,
        sandboxRoot,
        executablePath,
        url,
        pid: null,
        harness,
        startupMessage: runtimeRoot && executablePath ? startupMessage : null,
        lastError:
          runtimeRoot && executablePath
            ? ""
            : validationError ||
              `Runtime bundle not found. Set HOLABOSS_RUNTIME_ROOT or package ${RUNTIME_BUNDLE_DIR} into app resources.`,
      });
      emitRuntimeState();

      if (!runtimeRoot || !executablePath) {
        persistRuntimeProcessState({
          pid: null,
          status: "missing",
          lastError: runtimeStatus.lastError,
        });
        return runtimeStatus;
      }

      const startupConfigError = embeddedRuntimeStartupConfigError();
      if (startupConfigError) {
        runtimeStatus = withDesktopBrowserStatus({
          ...runtimeStatus,
          status: "error",
          pid: null,
          startupMessage: null,
          lastError: startupConfigError,
        });
        persistRuntimeProcessState({
          pid: null,
          status: "error",
          lastError: startupConfigError,
        });
        appendRuntimeEventLog({
          category: "runtime",
          event: "embedded_runtime.config_error",
          outcome: "error",
          detail: startupConfigError,
        });
        void appendRuntimeLog(`[embedded-runtime] ${startupConfigError}\n`);
        emitRuntimeState();
        return runtimeStatus;
      }

      const launchRuntimePort = await ensureRuntimePortAvailable({
        url,
        sandboxRoot,
        reason: "startup_before_spawn",
      });
      if (launchRuntimePort === "reused") {
        return refreshRuntimeStatus();
      }
      if (launchRuntimePort === "blocked") {
        const launchBlockedError =
          "A stale runtime reclaimed the profile runtime port before startup completed.";
        runtimeStatus = withDesktopBrowserStatus({
          ...runtimeStatus,
          status: "error",
          pid: null,
          startupMessage: null,
          lastError: launchBlockedError,
        });
        persistRuntimeProcessState({
          pid: null,
          status: "error",
          lastError: launchBlockedError,
        });
        appendRuntimeEventLog({
          category: "runtime",
          event: "embedded_runtime.launch_blocked",
          outcome: "error",
          detail: launchBlockedError,
        });
        emitRuntimeState();
        return runtimeStatus;
      }

      const launchSpec = await resolveRuntimeLaunchSpec(
        runtimeRoot,
        executablePath,
      );
      if (!launchSpec) {
        const launchError = `Runtime bundle is incomplete. Missing ${runtimeBundleNodeRelativePaths(CURRENT_RUNTIME_PLATFORM).join(" or ")} under ${runtimeRoot}. Rebuild or restage ${RUNTIME_BUNDLE_DIR}.`;
        runtimeStatus = withDesktopBrowserStatus({
          ...runtimeStatus,
          status: "error",
          pid: null,
          startupMessage: null,
          lastError: launchError,
        });
        persistRuntimeProcessState({
          pid: null,
          status: "error",
          lastError: launchError,
        });
        appendRuntimeEventLog({
          category: "runtime",
          event: "embedded_runtime.launch_error",
          outcome: "error",
          detail: launchError,
        });
        void appendRuntimeLog(`[embedded-runtime] ${launchError}\n`);
        emitRuntimeState();
        return runtimeStatus;
      }

      const child = spawn(launchSpec.command, launchSpec.args, {
        cwd: runtimeRoot,
        env: {
          ...process.env,
          HB_SANDBOX_ROOT: sandboxRoot,
          SANDBOX_AGENT_BIND_HOST: "127.0.0.1",
          SANDBOX_AGENT_BIND_PORT: String(runtimeApiPort()),
          HOLABOSS_EMBEDDED_RUNTIME: "1",
          SANDBOX_AGENT_HARNESS: harness,
          HOLABOSS_RUNTIME_WORKFLOW_BACKEND: workflowBackend,
          HOLABOSS_HOST_STATE_DB_PATH: runtimeDatabasePath(),
          HOLABOSS_RUNTIME_DB_PATH: runtimeDatabasePath(),
          HOLABOSS_CONTROL_PLANE_DB_PATH: controlPlaneDatabasePath(),
          HOLABOSS_RUNTIME_LOG_PATH: runtimeLogsPath(),
          HOLABOSS_RUNTIME_CONFIG_PATH: runtimeConfigPath(),
          HOLABOSS_DESKTOP_LAUNCH_ID: DESKTOP_LAUNCH_ID,
          HOLABOSS_DESKTOP_APP_VERSION: app.getVersion(),
          HOLABOSS_DESKTOP_BROWSER_ENABLED: currentDesktopBrowserCapabilityConfig()
            .enabled
            ? "true"
            : "false",
          HOLABOSS_DESKTOP_BROWSER_URL: desktopBrowserServiceUrl,
          HOLABOSS_DESKTOP_BROWSER_AUTH_TOKEN:
            desktopBrowserServiceAuthToken,
          // Proactive is temporarily disabled product-wide, so keep the
          // embedded runtime bridge worker off until the backend is re-enabled.
          PROACTIVE_ENABLE_REMOTE_BRIDGE: "0",
          PROACTIVE_BRIDGE_BASE_URL: runtimeProactiveBridgeBaseUrl(),
          PYTHONDONTWRITEBYTECODE: "1",
          HOLABOSS_AUTH_BASE_URL: AUTH_BASE_URL,
          HOLABOSS_AUTH_COOKIE: authCookieHeader() ?? "",
          // Bearer-form of the same Better-Auth session, used by
          // ComposioApiClient (runtime/api-server/src/composio-api-client.ts)
          // to call /api/composio/internal/* without a cookie jar. Same
          // session, transported differently. If empty (user not signed
          // in yet), createComposioApiClientFromEnv() returns null and
          // dependent features stay quietly disabled until the runtime
          // is restarted after sign-in.
          HOLABOSS_AUTH_BEARER_TOKEN: authBearerToken(),
        },
        stdio: "pipe",
        windowsHide: process.platform === "win32",
      });

      runtimeProcess = child;
      persistRuntimeProcessState({
        pid: child.pid ?? null,
        status: "starting",
        lastStartedAt: utcNowIso(),
        lastError: "",
      });
      appendRuntimeEventLog({
        category: "runtime",
        event: "embedded_runtime.start",
        outcome: "start",
        detail: `pid=${child.pid ?? "null"}`,
      });
      runtimeStatus = withDesktopBrowserStatus({
        ...runtimeStatus,
        status: "starting",
        pid: child.pid ?? null,
        startupMessage,
      });
      emitRuntimeState();

      child.stdout.on("data", (chunk) => {
        void appendRuntimeLog(String(chunk));
      });
      child.stderr.on("data", (chunk) => {
        void appendRuntimeLog(String(chunk));
      });

      child.once("exit", (code, signal) => {
        const wasIntentional =
          intentionallyStoppedRuntimeProcesses.delete(child);
        if (runtimeProcess === child) {
          runtimeProcess = null;
        }

        void (async () => {
          if (await isRuntimeHealthy(url)) {
            await refreshRuntimeStatus();
            return;
          }

          const cleanExit = wasIntentional || code === 0;
          const nextStatus = cleanExit ? "stopped" : "error";
          const nextError = cleanExit
            ? ""
            : `Runtime exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
          runtimeStatus = withDesktopBrowserStatus({
            ...runtimeStatus,
            status: nextStatus,
            pid: null,
            startupMessage: null,
            lastError: nextError,
          });
          persistRuntimeProcessState({
            pid: null,
            status: nextStatus,
            lastStoppedAt: utcNowIso(),
            lastError: nextError,
          });
          appendRuntimeEventLog({
            category: "runtime",
            event: "embedded_runtime.exit",
            outcome: cleanExit ? "success" : "error",
            detail: `code=${code ?? "null"} signal=${signal ?? "null"}${wasIntentional ? " intentional=true" : ""}`,
          });
          emitRuntimeState();
        })();
      });

      const healthWait = runtimeStartupHealthWaitOptions(startupMessage);
      const healthy = await waitForRuntimeHealth(
        url,
        healthWait.attempts,
        healthWait.delayMs,
        {
          abortWhen: () =>
            runtimeProcess !== child || child.exitCode !== null,
        },
      );
      if (healthy) {
        runtimeStatus = await refreshRuntimeStatus();
      } else {
        runtimeStatus = withDesktopBrowserStatus({
          ...runtimeStatus,
          status: "error",
          pid: child.pid ?? null,
          startupMessage: null,
          lastError:
            "Runtime process started but did not pass health checks. Check runtime.log in the Electron userData directory.",
        });
        persistRuntimeProcessState({
          pid: child.pid ?? null,
          status: "error",
          lastError: runtimeStatus.lastError,
        });
        appendRuntimeEventLog({
          category: "runtime",
          event: "embedded_runtime.healthcheck",
          outcome: "error",
          detail: runtimeStatus.lastError,
        });
      }
      emitRuntimeState();
      return runtimeStatus;
    } catch (error) {
      const startupError =
        error instanceof Error ? error.message : String(error);
      runtimeStatus = withDesktopBrowserStatus({
        ...runtimeStatus,
        status: "error",
        pid: null,
        startupMessage: null,
        lastError: startupError,
      });
      persistRuntimeProcessState({
        pid: null,
        status: "error",
        lastError: startupError,
      });
      appendRuntimeEventLog({
        category: "runtime",
        event: "embedded_runtime.start_error",
        outcome: "error",
        detail: startupError,
      });
      void appendRuntimeLog(`[embedded-runtime] ${startupError}\n`);
      emitRuntimeState();
      return runtimeStatus;
    } finally {
      runtimeStartupInFlight = false;
    }
  });
}

function persistFileBookmarks() {
  return writeJsonFile(fileBookmarksPath(), fileBookmarks);
}

function createBrowserState(
  overrides?: Partial<BrowserStatePayload>,
): BrowserStatePayload {
  return createBrowserStateUtil({ newTabTitle: NEW_TAB_TITLE }, overrides);
}

function browserSpaceId(
  value?: string | null,
  fallback: BrowserSpaceId = activeBrowserSpaceId,
): BrowserSpaceId {
  return browserSpaceIdUtil(value, fallback);
}

function browserSessionId(value?: string | null): string {
  return browserSessionIdUtil(value);
}

function createBrowserTabSpaceState(): BrowserTabSpaceState {
  const now = new Date().toISOString();
  return {
    tabs: new Map<string, BrowserTabRecord>(),
    activeTabId: "",
    persistedTabs: [],
    lifecycleState: "active",
    lastTouchedAt: now,
    suspendTimer: null,
  };
}

function browserTabSpaceTouch(tabSpace: BrowserTabSpaceState): void {
  tabSpace.lastTouchedAt = new Date().toISOString();
}

function clearBrowserTabSpaceSuspendTimer(tabSpace: BrowserTabSpaceState): void {
  if (!tabSpace.suspendTimer) {
    return;
  }
  clearTimeout(tabSpace.suspendTimer);
  tabSpace.suspendTimer = null;
}

function browserTabSpaceTabCount(tabSpace: BrowserTabSpaceState | null | undefined): number {
  if (!tabSpace) {
    return 0;
  }
  return tabSpace.tabs.size > 0 ? tabSpace.tabs.size : tabSpace.persistedTabs.length;
}

function browserTabSpacePersistencePayload(
  tabSpace: BrowserTabSpaceState,
): BrowserWorkspaceTabSpacePersistencePayload {
  return {
    activeTabId: tabSpace.activeTabId,
    tabs:
      tabSpace.tabs.size > 0
        ? serializedBrowserWorkspaceTabs(tabSpace)
        : [...tabSpace.persistedTabs],
  };
}

function browserStateFromPersistedTab(
  tab: BrowserWorkspaceTabPersistencePayload,
): BrowserStatePayload {
  return createBrowserState({
    id: tab.id,
    url: tab.url,
    title: tab.title,
    faviconUrl: tab.faviconUrl,
    initialized: true,
  });
}

function browserTabSpaceStates(
  tabSpace: BrowserTabSpaceState | null | undefined,
): BrowserStatePayload[] {
  if (!tabSpace) {
    return [];
  }
  if (tabSpace.tabs.size > 0 || tabSpace.lifecycleState === "active") {
    return Array.from(tabSpace.tabs.values(), ({ state }) => state);
  }
  return tabSpace.persistedTabs.map((tab) => browserStateFromPersistedTab(tab));
}

function emptyBrowserTabCountsPayload(): BrowserTabCountsPayload {
  return emptyBrowserTabCountsPayloadUtil();
}

function emptyBrowserTabListPayload(
  space: BrowserSpaceId = activeBrowserSpaceId,
): BrowserTabListPayload {
  return {
    space,
    activeTabId: "",
    tabs: [],
    tabCounts: emptyBrowserTabCountsPayload(),
    sessionId: space === "agent" ? (browserSessionId(activeBrowserSessionId) || null) : null,
    lifecycleState: null,
    controlMode: "none",
    controlSessionId: null,
  };
}

function defaultBrowserWorkspacePersistence(): BrowserWorkspacePersistencePayload {
  return {
    activeTabId: "",
    tabs: [],
    spaces: {
      user: { activeTabId: "", tabs: [] },
      agent: { activeTabId: "", tabs: [] },
    },
    activeAgentSessionId: null,
    agentSessions: {},
    bookmarks: [],
    downloads: [],
    history: [],
  };
}

// ---------------------------------------------------------------------------
// App surface BrowserView management
// ---------------------------------------------------------------------------

function getOrCreateAppSurfaceView(appId: string): BrowserView {
  const existing = appSurfaceViews.get(appId);
  if (existing) {
    return existing;
  }
  const view = new BrowserView({
    webPreferences: {
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  view.setAutoResize({
    width: false,
    height: false,
    horizontal: false,
    vertical: false,
  });
  view.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrlFromMain(url, "app surface window open");
    return { action: "deny" };
  });
  appSurfaceViews.set(appId, view);
  return view;
}

async function getAppHttpUrl(
  workspaceId: string,
  appId: string,
): Promise<string | null> {
  try {
    const ports = await requestWorkspaceRuntimeJson<
      Record<string, { http: number; mcp: number }>
    >(workspaceId, {
      method: "GET",
      path: "/api/v1/apps/ports",
      params: { workspace_id: workspaceId },
    });
    const appPorts = ports[appId];
    if (!appPorts?.http) {
      return null;
    }
    return `http://localhost:${appPorts.http}`;
  } catch {
    return null;
  }
}

function setAppSurfaceBounds(bounds: BrowserBoundsPayload): void {
  appSurfaceBounds = {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
  updateAttachedAppSurfaceView();
}

function updateAttachedAppSurfaceView(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (
    !activeAppSurfaceId ||
    appSurfaceBounds.width <= 0 ||
    appSurfaceBounds.height <= 0
  ) {
    if (attachedAppSurfaceView) {
      mainWindow.removeBrowserView(attachedAppSurfaceView);
      attachedAppSurfaceView = null;
    }
    return;
  }
  const view = appSurfaceViews.get(activeAppSurfaceId);
  if (!view) {
    if (attachedAppSurfaceView) {
      mainWindow.removeBrowserView(attachedAppSurfaceView);
      attachedAppSurfaceView = null;
    }
    return;
  }
  if (attachedAppSurfaceView !== view) {
    if (attachedAppSurfaceView) {
      mainWindow.removeBrowserView(attachedAppSurfaceView);
    }
    reserveMainWindowClosedListenerBudget(1);
    mainWindow.addBrowserView(view);
    attachedAppSurfaceView = view;
  }
  view.setBounds(appSurfaceBounds);
}

function detachAttachedMainWindowViews(): void {
  const win = mainWindow;
  if (win && !win.isDestroyed()) {
    if (attachedBrowserTabView) {
      try {
        win.setBrowserView(null);
      } catch {
        // best effort during renderer teardown
      }
    }
    if (attachedAppSurfaceView) {
      try {
        win.removeBrowserView(attachedAppSurfaceView);
      } catch {
        // best effort during renderer teardown
      }
    }
  }
  attachedBrowserTabView = null;
  attachedAppSurfaceView = null;
}

async function resolveAppSurfaceUrl(
  workspaceId: string,
  appId: string,
  urlPath?: string,
): Promise<string> {
  const baseUrl = await getAppHttpUrl(workspaceId, appId);
  if (!baseUrl) {
    throw new Error(`Could not resolve HTTP URL for app ${appId}`);
  }
  const normalizedPath = typeof urlPath === "string" ? urlPath.trim() : "";
  if (!normalizedPath) {
    return baseUrl;
  }
  const targetPath = normalizedPath.startsWith("/")
    ? normalizedPath
    : `/${normalizedPath}`;
  return `${baseUrl}${targetPath}`;
}

async function navigateAppSurface(
  workspaceId: string,
  appId: string,
  urlPath?: string,
): Promise<void> {
  const baseUrl = await getAppHttpUrl(workspaceId, appId);
  if (!baseUrl) {
    throw new Error(`Could not resolve HTTP URL for app ${appId}`);
  }
  const view = getOrCreateAppSurfaceView(appId);
  const targetUrl = urlPath ? `${baseUrl}${urlPath}` : baseUrl;
  activeAppSurfaceId = appId;
  await view.webContents.loadURL(targetUrl);
  updateAttachedAppSurfaceView();
}

function destroyAppSurfaceView(appId: string): void {
  const view = appSurfaceViews.get(appId);
  if (!view) {
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.removeBrowserView(view);
  }
  if (attachedAppSurfaceView === view) {
    attachedAppSurfaceView = null;
  }
  try {
    (view.webContents as unknown as { destroy?: () => void }).destroy?.();
  } catch {
    // best effort
  }
  appSurfaceViews.delete(appId);
  if (activeAppSurfaceId === appId) {
    activeAppSurfaceId = null;
  }
}

function hideAppSurface(): void {
  activeAppSurfaceId = null;
  updateAttachedAppSurfaceView();
}

// ---------------------------------------------------------------------------

function browserWorkspaceFromMap(
  workspaceId: string,
): BrowserWorkspaceState | null {
  return browserWorkspaces.get(workspaceId.trim()) ?? null;
}

function activeBrowserWorkspace(): BrowserWorkspaceState | null {
  if (!activeBrowserWorkspaceId) {
    return null;
  }
  return browserWorkspaceFromMap(activeBrowserWorkspaceId);
}

function browserWorkspaceOrEmpty(
  workspaceId?: string | null,
): BrowserWorkspaceState | null {
  const normalizedWorkspaceId =
    typeof workspaceId === "string"
      ? workspaceId.trim()
      : activeBrowserWorkspaceId;
  if (!normalizedWorkspaceId) {
    return null;
  }
  return browserWorkspaceFromMap(normalizedWorkspaceId);
}

function browserVisibleAgentSessionId(
  workspace: BrowserWorkspaceState | null | undefined,
): string {
  if (!workspace) {
    return "";
  }
  if (
    workspace.workspaceId === activeBrowserWorkspaceId &&
    activeBrowserSpaceId === "agent"
  ) {
    return (
      browserSessionId(activeBrowserSessionId) ||
      browserSessionId(workspace.activeAgentSessionId)
    );
  }
  return browserSessionId(workspace.activeAgentSessionId);
}

function browserAgentSessionSpaceState(
  workspace: BrowserWorkspaceState | null | undefined,
  sessionId?: string | null,
  options?: {
    createIfMissing?: boolean;
  },
): BrowserTabSpaceState | null {
  if (!workspace) {
    return null;
  }
  const normalizedSessionId = browserSessionId(sessionId);
  if (!normalizedSessionId) {
    return null;
  }
  let tabSpace = workspace.agentSessionSpaces.get(normalizedSessionId) ?? null;
  if (!tabSpace && options?.createIfMissing) {
    tabSpace = createBrowserTabSpaceState();
    workspace.agentSessionSpaces.set(normalizedSessionId, tabSpace);
  }
  return tabSpace;
}

function browserFallbackAgentSessionId(
  workspace: BrowserWorkspaceState | null | undefined,
): string {
  if (!workspace) {
    return "";
  }
  const persistedVisibleSessionId = browserSessionId(workspace.activeAgentSessionId);
  if (
    persistedVisibleSessionId &&
    browserAgentSessionSpaceState(workspace, persistedVisibleSessionId)
  ) {
    return persistedVisibleSessionId;
  }
  for (const sessionId of workspace.agentSessionSpaces.keys()) {
    return browserSessionId(sessionId);
  }
  return "";
}

function browserTabSpaceState(
  workspace: BrowserWorkspaceState | null | undefined,
  space: BrowserSpaceId,
  sessionId?: string | null,
  options?: {
    createIfMissing?: boolean;
    useVisibleAgentSession?: boolean;
  },
): BrowserTabSpaceState | null {
  if (!workspace) {
    return null;
  }
  if (space === "user") {
    return workspace.spaces.user ?? null;
  }
  const explicitSessionId = browserSessionId(sessionId);
  if (explicitSessionId) {
    return browserAgentSessionSpaceState(workspace, explicitSessionId, options);
  }
  if (options?.useVisibleAgentSession) {
    const visibleSessionId = browserVisibleAgentSessionId(workspace);
    const visibleSessionSpace = visibleSessionId
      ? browserAgentSessionSpaceState(workspace, visibleSessionId)
      : null;
    if (visibleSessionSpace) {
      return visibleSessionSpace;
    }
  }
  return workspace.spaces.agent ?? null;
}

function oppositeBrowserSpaceId(space: BrowserSpaceId): BrowserSpaceId {
  return oppositeBrowserSpaceIdUtil(space);
}

function browserWorkspaceTabCounts(
  workspace: BrowserWorkspaceState | null | undefined,
): BrowserTabCountsPayload {
  if (!workspace) {
    return emptyBrowserTabCountsPayload();
  }
  const visibleAgentSpace = browserTabSpaceState(workspace, "agent", null, {
    useVisibleAgentSession: true,
  });
  return {
    user: browserTabSpaceTabCount(workspace.spaces.user),
    agent: browserTabSpaceTabCount(visibleAgentSpace ?? workspace.spaces.agent),
  };
}

function serializedBrowserWorkspaceTabs(
  tabSpace: BrowserTabSpaceState,
): BrowserWorkspaceTabPersistencePayload[] {
  return Array.from(tabSpace.tabs.values(), ({ state }) => ({
    id: state.id,
    url: state.url,
    title: state.title,
    faviconUrl: state.faviconUrl,
  }));
}

function serializeBrowserWorkspace(
  workspace: BrowserWorkspaceState,
): BrowserWorkspacePersistencePayload {
  return {
    activeTabId: workspace.spaces.user.activeTabId,
    tabs: browserTabSpacePersistencePayload(workspace.spaces.user).tabs,
    spaces: {
      user: browserTabSpacePersistencePayload(workspace.spaces.user),
      agent: browserTabSpacePersistencePayload(workspace.spaces.agent),
    },
    activeAgentSessionId: browserSessionId(workspace.activeAgentSessionId) || null,
    agentSessions: Object.fromEntries(
      Array.from(workspace.agentSessionSpaces.entries()).map(
        ([sessionId, tabSpace]) => [
          sessionId,
          browserTabSpacePersistencePayload(tabSpace),
        ],
      ),
    ),
    bookmarks: workspace.bookmarks,
    downloads: workspace.downloads,
    history: workspace.history,
  };
}

function persistBrowserWorkspace(workspaceId: string) {
  const workspace = browserWorkspaceFromMap(workspaceId);
  if (!workspace) {
    return Promise.resolve();
  }
  return writeJsonFile(
    browserWorkspaceStatePath(workspace.workspaceId),
    serializeBrowserWorkspace(workspace),
  );
}

function createBrowserWorkspaceState(
  workspaceId: string,
): BrowserWorkspaceState {
  const browserSession = session.fromPartition(
    browserWorkspacePartition(workspaceId),
  );
  const browserIdentity = configureBrowserWorkspaceSession(browserSession);
  return {
    workspaceId,
    partition: browserWorkspacePartition(workspaceId),
    session: browserSession,
    browserIdentity,
    spaces: {
      user: createBrowserTabSpaceState(),
      agent: createBrowserTabSpaceState(),
    },
    userBrowserLock: null,
    activeAgentSessionId: null,
    agentSessionSpaces: new Map<string, BrowserTabSpaceState>(),
    bookmarks: [],
    downloads: [],
    history: [],
    downloadTrackingRegistered: false,
    pendingDownloadOverrides: [],
  };
}

function setVisibleAgentBrowserSession(
  workspace: BrowserWorkspaceState | null | undefined,
  sessionId?: string | null,
) {
  if (!workspace) {
    return;
  }
  const normalizedSessionId = browserSessionId(sessionId);
  workspace.activeAgentSessionId = normalizedSessionId || null;
  if (
    workspace.workspaceId === activeBrowserWorkspaceId &&
    activeBrowserSpaceId === "agent"
  ) {
    activeBrowserSessionId = normalizedSessionId;
  }
}

function seedVisibleAgentBrowserSession(
  workspace: BrowserWorkspaceState | null | undefined,
  sessionId?: string | null,
) {
  if (!workspace) {
    return;
  }
  const normalizedSessionId = browserSessionId(sessionId);
  const currentVisibleSessionId = browserSessionId(workspace.activeAgentSessionId);
  if (currentVisibleSessionId) {
    return;
  }
  if (!normalizedSessionId) {
    return;
  }
  workspace.activeAgentSessionId = normalizedSessionId;
  if (
    workspace.workspaceId === activeBrowserWorkspaceId &&
    activeBrowserSpaceId === "agent" &&
    !browserSessionId(activeBrowserSessionId)
  ) {
    activeBrowserSessionId = normalizedSessionId;
  }
}

function isVisibleAgentBrowserSession(
  workspaceId: string,
  sessionId?: string | null,
): boolean {
  return (
    activeBrowserWorkspaceId === workspaceId &&
    activeBrowserSpaceId === "agent" &&
    browserSessionId(activeBrowserSessionId) === browserSessionId(sessionId)
  );
}

// activeUserBrowserLock / releaseUserBrowserLock / ensureUserBrowserLock /
// pauseBrowserControlSession / agentBrowserSessionNeedsInterrupt /
// confirmBrowserInterrupt / maybePromptBrowserInterrupt /
// isProgrammaticBrowserInput / withProgrammaticBrowserInput moved to
// browser-pane/user-lock.ts. Wired below as `browserUserLock`.
const browserUserLock = createBrowserUserLock({
  getMainWindow: () => mainWindow,
  getWorkspace: (id) =>
    browserWorkspaceFromMap(id) as unknown as ReturnType<
      Parameters<typeof createBrowserUserLock>[0]["getWorkspace"]
    >,
  browserSessionId: (value) => browserSessionId(value),
  lockTimeoutMs: USER_BROWSER_LOCK_TIMEOUT_MS,
  pauseSessionRun: (params) => pauseSessionRun(params),
  isAgentSessionBusy: (workspaceId, sessionId) => {
    const runtimeRecord = getCachedRuntimeStateRecord(workspaceId, sessionId);
    const status = runtimeRecordEffectiveStatus(runtimeRecord);
    return status === "BUSY" || status === "QUEUED" || status === "PAUSING";
  },
});
const activeUserBrowserLock = browserUserLock.activeUserBrowserLock;
const releaseUserBrowserLock = browserUserLock.releaseUserBrowserLock;
const ensureUserBrowserLock = browserUserLock.ensureUserBrowserLock;
const pauseBrowserControlSession = browserUserLock.pauseBrowserControlSession;
const agentBrowserSessionNeedsInterrupt =
  browserUserLock.agentBrowserSessionNeedsInterrupt;
const confirmBrowserInterrupt = browserUserLock.confirmBrowserInterrupt;
const maybePromptBrowserInterrupt = browserUserLock.maybePromptBrowserInterrupt;
const isProgrammaticBrowserInput = browserUserLock.isProgrammaticBrowserInput;
const withProgrammaticBrowserInput = browserUserLock.withProgrammaticBrowserInput;

async function sendBrowserKeyPress(
  webContents: WebContents,
  keyCode: string,
  modifiers?: Array<"meta" | "control">,
): Promise<void> {
  const event = {
    keyCode,
    ...(modifiers && modifiers.length > 0 ? { modifiers } : {}),
  };
  await webContents.sendInputEvent({ type: "keyDown", ...event });
  await webContents.sendInputEvent({ type: "keyUp", ...event });
}

async function clearFocusedBrowserTextInput(
  webContents: WebContents,
): Promise<void> {
  const selectAllModifier = process.platform === "darwin" ? "meta" : "control";
  await sendBrowserKeyPress(webContents, "A", [selectAllModifier]);
  await sendBrowserKeyPress(webContents, "Backspace");
}

// Agent-session browser tab-space lifecycle (hydrate / suspend / schedule
// / touch / reconcile) moved to browser-pane/agent-session-lifecycle.ts.
// Wired via `agentSessionLifecycle` below.
const agentSessionLifecycle = createAgentSessionLifecycle({
  getWorkspace: (id) =>
    browserWorkspaceFromMap(id) as unknown as ReturnType<
      Parameters<typeof createAgentSessionLifecycle>[0]["getWorkspace"]
    >,
  browserSessionId: (value) => browserSessionId(value),
  browserAgentSessionSpaceState: (workspace, sessionId, options) =>
    browserAgentSessionSpaceState(
      workspace as unknown as BrowserWorkspaceState | null | undefined,
      sessionId,
      options,
    ) as unknown as ReturnType<
      Parameters<typeof createAgentSessionLifecycle>[0]["browserAgentSessionSpaceState"]
    >,
  clearBrowserTabSpaceSuspendTimer: (tabSpace) =>
    clearBrowserTabSpaceSuspendTimer(tabSpace as unknown as BrowserTabSpaceState),
  browserTabSpaceTouch: (tabSpace) =>
    browserTabSpaceTouch(tabSpace as unknown as BrowserTabSpaceState),
  browserTabSpacePersistencePayload: (tabSpace) =>
    browserTabSpacePersistencePayload(
      tabSpace as unknown as BrowserTabSpaceState,
    ),
  closeBrowserTabRecord: (tab) =>
    closeBrowserTabRecord(tab as unknown as BrowserTabRecord),
  isVisibleAgentBrowserSession: (workspaceId, sessionId) =>
    isVisibleAgentBrowserSession(workspaceId, sessionId),
  fetchSessionRuntimeStatus: async (workspaceId, sessionId) => {
    try {
      const runtimeStates = await listRuntimeStates(workspaceId);
      const record =
        runtimeStates.items.find(
          (item) => browserSessionId(item.session_id) === sessionId,
        ) ?? null;
      if (!record) {
        return null;
      }
      return {
        status: runtimeRecordEffectiveStatus(record),
        lastTurnStatus: record.last_turn_status?.trim().toLowerCase() ?? "",
      };
    } catch {
      return null;
    }
  },
  createBrowserTab: (workspaceId, options) =>
    createBrowserTab(workspaceId, options),
  ensureBrowserTabSpaceInitialized: (workspaceId, space, sessionId) =>
    ensureBrowserTabSpaceInitialized(workspaceId, space, sessionId),
  emitBrowserState: (workspaceId, space) => emitBrowserState(workspaceId, space),
  persistWorkspace: (workspaceId) => persistBrowserWorkspace(workspaceId),
  homeUrl: HOME_URL,
  newTabTitle: NEW_TAB_TITLE,
  busyCheckMs: SESSION_BROWSER_BUSY_CHECK_MS,
  warmTtlMs: SESSION_BROWSER_WARM_TTL_MS,
  completedGraceMs: SESSION_BROWSER_COMPLETED_GRACE_MS,
});
const hydrateAgentSessionBrowserSpace =
  agentSessionLifecycle.hydrateAgentSessionBrowserSpace;
const suspendAgentSessionBrowserSpace =
  agentSessionLifecycle.suspendAgentSessionBrowserSpace;
const scheduleAgentSessionBrowserLifecycleCheck =
  agentSessionLifecycle.scheduleAgentSessionBrowserLifecycleCheck;
const touchAgentSessionBrowserSpace =
  agentSessionLifecycle.touchAgentSessionBrowserSpace;
const reconcileAgentSessionBrowserSpace =
  agentSessionLifecycle.reconcileAgentSessionBrowserSpace;

// Browser-pane tab state — read+emit + lifecycle (createBrowserTab,
// navigation, popup-as-tab, context-menu) + download-prompt helpers.
const browserPaneTabState: BrowserPaneTabState = createBrowserPaneTabState({
  getMainWindow: () => mainWindow,
  getActiveWorkspaceId: () => activeBrowserWorkspaceId,
  getActiveSpaceId: () => activeBrowserSpaceId,
  getActiveSessionId: () => activeBrowserSessionId,
  getAttachedView: () => attachedBrowserTabView,
  setAttachedView: (view) => {
    attachedBrowserTabView = view;
  },
  getBrowserBounds: () => browserBounds,
  setBrowserBounds: (bounds) => {
    browserBounds = bounds;
  },
  getWorkspace: (id) =>
    browserWorkspaceFromMap(id) as unknown as ReturnType<
      Parameters<typeof createBrowserPaneTabState>[0]["getWorkspace"]
    >,
  getWorkspaceOrEmpty: (id) =>
    browserWorkspaceOrEmpty(id) as unknown as ReturnType<
      Parameters<typeof createBrowserPaneTabState>[0]["getWorkspaceOrEmpty"]
    >,
  persistWorkspace: (id) => persistBrowserWorkspace(id),
  browserSpaceId: (value) => browserSpaceId(value),
  browserSessionId: (value) => browserSessionId(value),
  browserTabSpaceState: (workspace, space, sessionId, options) =>
    browserTabSpaceState(
      workspace as unknown as BrowserWorkspaceState | null | undefined,
      space,
      sessionId,
      options,
    ) as unknown as ReturnType<
      Parameters<typeof createBrowserPaneTabState>[0]["browserTabSpaceState"]
    >,
  browserTabSpaceTouch: (tabSpace) =>
    browserTabSpaceTouch(tabSpace as unknown as BrowserTabSpaceState),
  browserWorkspaceSnapshot: (workspaceId, space, sessionId, options) =>
    browserWorkspaceSnapshot(workspaceId, space, sessionId, options),
  emptyBrowserTabListPayload: (space) => emptyBrowserTabListPayload(space),
  browserVisibleAgentSessionId: (workspace) =>
    browserVisibleAgentSessionId(
      workspace as unknown as BrowserWorkspaceState | null | undefined,
    ),
  createBrowserState: (state) => createBrowserState(state),
  scheduleAgentSessionBrowserLifecycleCheck: (workspaceId, sessionId) =>
    scheduleAgentSessionBrowserLifecycleCheck(workspaceId, sessionId),
  setVisibleAgentBrowserSession: (workspace, sessionId) =>
    setVisibleAgentBrowserSession(
      workspace as unknown as BrowserWorkspaceState,
      sessionId,
    ),
  seedVisibleAgentBrowserSession: (workspace, sessionId) =>
    seedVisibleAgentBrowserSession(
      workspace as unknown as BrowserWorkspaceState,
      sessionId,
    ),
  shouldTrackHistoryUrl: (url) => shouldTrackHistoryUrl(url),
  hasOpenHistoryPopup: () => browserPanePopups.hasOpenHistoryPopup(),
  sendHistoryToPopup: (history) =>
    browserPanePopups.sendHistoryToPopup(history),
  reserveMainWindowClosedListenerBudget: (count) =>
    reserveMainWindowClosedListenerBudget(count),
  homeUrl: HOME_URL,
  newTabTitle: NEW_TAB_TITLE,
  duplicateBrowserPopupTabWindowMs: DUPLICATE_BROWSER_POPUP_TAB_WINDOW_MS,
  shouldAllowBrowserPopupWindow: (url, frameName, features) =>
    shouldAllowBrowserPopupWindow(url, frameName, features),
  normalizeBrowserPopupFrameName: (frameName) =>
    normalizeBrowserPopupFrameName(frameName),
  isAbortedBrowserLoadError: (error) => isAbortedBrowserLoadError(error),
  isAbortedBrowserLoadFailure: (errorCode, errorDescription) =>
    isAbortedBrowserLoadFailure(errorCode, errorDescription),
  openExternalUrlFromMain: (url, reason) =>
    openExternalUrlFromMain(url, reason),
  appendBrowserObservedError: (tab, entry) =>
    appendBrowserObservedError(tab as unknown as BrowserTabRecord, entry),
  isProgrammaticBrowserInput: (webContents) =>
    isProgrammaticBrowserInput(webContents),
  maybePromptBrowserInterrupt: (workspaceId, space, sessionId) =>
    maybePromptBrowserInterrupt(workspaceId, space, sessionId),
  sanitizeAttachmentName: (name) => sanitizeAttachmentName(name),
  resolveWorkspaceDir: (id) => resolveWorkspaceDirSync(id),
  preloadDir: __dirname,
});
const getActiveBrowserTab = browserPaneTabState.getActiveBrowserTab;
const activeVisibleBrowserTarget = browserPaneTabState.activeVisibleBrowserTarget;
const currentBrowserTabPageTitle = browserPaneTabState.currentBrowserTabPageTitle;
const currentBrowserTabUrl = browserPaneTabState.currentBrowserTabUrl;
const applyBoundsToTab = browserPaneTabState.applyBoundsToTab;
const hasVisibleBrowserBounds = browserPaneTabState.hasVisibleBounds;
const updateAttachedBrowserView = browserPaneTabState.updateAttachedBrowserView;
const emitBrowserState = browserPaneTabState.emitBrowserState;
const emitHistoryState = browserPaneTabState.emitHistoryState;
const closeBrowserTabRecord = browserPaneTabState.closeBrowserTabRecord;
const syncBrowserState = browserPaneTabState.syncBrowserState;
const recordHistoryVisit = browserPaneTabState.recordHistoryVisit;
const setBrowserBounds = browserPaneTabState.setBounds;
const captureVisibleBrowserSnapshot = browserPaneTabState.captureVisibleSnapshot;
const focusBrowserTabInSpace = browserPaneTabState.focusBrowserTabInSpace;
const handleBrowserWindowOpenAsTab = browserPaneTabState.handleBrowserWindowOpenAsTab;
const showBrowserViewContextMenu = browserPaneTabState.showBrowserViewContextMenu;
const createBrowserTab = browserPaneTabState.createBrowserTab;
const initialBrowserTabSeed = browserPaneTabState.initialBrowserTabSeed;
const ensureBrowserTabSpaceInitialized =
  browserPaneTabState.ensureBrowserTabSpaceInitialized;
const queueBrowserDownloadPrompt = browserPaneTabState.queueBrowserDownloadPrompt;
const consumeBrowserDownloadOverride =
  browserPaneTabState.consumeBrowserDownloadOverride;
const browserContextSuggestedFilename =
  browserPaneTabState.browserContextSuggestedFilename;
const browserPagePayload = browserPaneTabState.browserPagePayload;
const withTemporarilyRenderedBrowserTab =
  browserPaneTabState.withTemporarilyRenderedBrowserTab;
const setActiveBrowserTabInner = browserPaneTabState.setActiveBrowserTab;
const closeBrowserTabInner = browserPaneTabState.closeBrowserTab;

/** Wrap tab-state's navigateActiveBrowserTab with workspace materialization. */
async function navigateActiveBrowserTab(
  workspaceId: string,
  targetUrl: string,
  space: BrowserSpaceId = activeBrowserSpaceId,
  sessionId?: string | null,
): Promise<BrowserTabListPayload> {
  await ensureBrowserWorkspace(workspaceId, space, sessionId);
  if (space === "agent" && browserSessionId(sessionId)) {
    touchAgentSessionBrowserSpace(workspaceId, sessionId);
  }
  return browserPaneTabState.navigateActiveBrowserTab(
    workspaceId,
    targetUrl,
    space,
    sessionId,
  );
}

/** Wrap tab-state's setActiveBrowserTab with workspace materialization. */
async function setActiveBrowserTab(
  tabId: string,
  options: {
    workspaceId?: string | null;
    space?: BrowserSpaceId | null;
    sessionId?: string | null;
    useVisibleAgentSession?: boolean;
  } = {},
): Promise<BrowserTabListPayload> {
  const browserSpace = browserSpaceId(options.space);
  const normalizedSessionId =
    browserSpace === "agent" ? browserSessionId(options.sessionId) : "";
  await ensureBrowserWorkspace(options.workspaceId, browserSpace, normalizedSessionId);
  return setActiveBrowserTabInner(tabId, options);
}

/** Wrap tab-state's closeBrowserTab with workspace materialization. */
async function closeBrowserTab(
  tabId: string,
  options: {
    workspaceId?: string | null;
    space?: BrowserSpaceId | null;
    sessionId?: string | null;
    useVisibleAgentSession?: boolean;
  } = {},
): Promise<BrowserTabListPayload> {
  const browserSpace = browserSpaceId(options.space);
  const normalizedSessionId =
    browserSpace === "agent" ? browserSessionId(options.sessionId) : "";
  await ensureBrowserWorkspace(options.workspaceId, browserSpace, normalizedSessionId);
  return closeBrowserTabInner(tabId, options);
}

// Renderer-→runtime browser HTTP service. The route handler lives in
// browser-pane/http-service.ts; here we just wire deps. Server lifecycle
// (start/stop, auth-token rotation, capability config sync) stays in
// main.ts.
const browserHttpService: BrowserHttpService = createBrowserHttpService({
  getMainWindow: () => mainWindow,
  getActiveWorkspaceId: () => activeBrowserWorkspaceId,
  getAuthToken: () => desktopBrowserServiceAuthToken,
  homeUrl: HOME_URL,
  browserSpaceId: (value, fallback) => browserSpaceId(value, fallback),
  ensureBrowserWorkspace: (workspaceId, space, sessionId) =>
    ensureBrowserWorkspace(workspaceId, space, sessionId) as unknown as ReturnType<
      Parameters<typeof createBrowserHttpService>[0]["ensureBrowserWorkspace"]
    >,
  ensureUserBrowserLock: (workspaceId, sessionId, reason) => {
    const result = ensureUserBrowserLock(workspaceId, sessionId, reason);
    return result.ok
      ? { ok: true }
      : { ok: false, lockHolderSessionId: result.lockHolderSessionId };
  },
  touchAgentSessionBrowserSpace: (workspaceId, sessionId) =>
    touchAgentSessionBrowserSpace(workspaceId, sessionId),
  browserWorkspaceSnapshot: (workspaceId, space, sessionId, options) =>
    browserWorkspaceSnapshot(workspaceId, space, sessionId, options),
  browserTabSpaceState: (workspace, space, sessionId, options) =>
    browserTabSpaceState(
      workspace as unknown as BrowserWorkspaceState | null | undefined,
      space,
      sessionId,
      options,
    ) as unknown as ReturnType<
      Parameters<typeof createBrowserHttpService>[0]["browserTabSpaceState"]
    >,
  getActiveBrowserTab: (workspaceId, space, sessionId, options) =>
    getActiveBrowserTab(workspaceId, space, sessionId, options) as unknown as ReturnType<
      Parameters<typeof createBrowserHttpService>[0]["getActiveBrowserTab"]
    >,
  syncBrowserState: (workspaceId, tabId, space, sessionId) =>
    syncBrowserState(workspaceId, tabId, space, sessionId),
  navigateActiveBrowserTab: (workspaceId, targetUrl, space, sessionId) =>
    navigateActiveBrowserTab(workspaceId, targetUrl, space, sessionId),
  createBrowserTab: (workspaceId, options) =>
    createBrowserTab(workspaceId, options),
  setActiveBrowserTab: (tabId, options) => setActiveBrowserTab(tabId, options),
  closeBrowserTab: (tabId, options) => closeBrowserTab(tabId, options),
  updateAttachedBrowserView: () => updateAttachedBrowserView(),
  emitBrowserState: (workspaceId, space) => emitBrowserState(workspaceId, space),
  persistWorkspace: (workspaceId) => persistBrowserWorkspace(workspaceId),
  emitWorkbenchOpenBrowser: (payload) => emitWorkbenchOpenBrowser(payload),
  operatorSurfaceContextPayload: (workspaceId) =>
    operatorSurfaceContextPayload(workspaceId),
  browserPagePayload: (tab) =>
    browserPagePayload(tab as unknown as BrowserTabRecord),
  withTemporarilyRenderedBrowserTab: (tab, callback, options) =>
    withTemporarilyRenderedBrowserTab(
      tab as unknown as BrowserTabRecord,
      callback,
      options,
    ),
  withProgrammaticBrowserInput: (webContents, callback) =>
    withProgrammaticBrowserInput(webContents, callback),
  sendBrowserKeyPress: (webContents, keyCode, modifiers) =>
    sendBrowserKeyPress(webContents, keyCode, modifiers),
  clearFocusedBrowserTextInput: (webContents) =>
    clearFocusedBrowserTextInput(webContents),
});

const TEXT_FILE_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".mdx",
  ".markdown",
  ".json",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".css",
  ".scss",
  ".html",
  ".xml",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".env",
  ".sh",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".swift",
  ".php",
  ".sql",
  ".log",
]);

const TABLE_FILE_EXTENSIONS = new Set([".csv", ".xlsx", ".xls"]);
const PREVIEW_STRIPPABLE_WORKSHEET_RELATIONSHIP_TYPES = new Set([
  "comments",
  "drawing",
  "vmlDrawing",
]);
const PRESENTATION_FILE_EXTENSIONS = new Set([".pptx"]);

const IMAGE_FILE_MIME_TYPES = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".bmp", "image/bmp"],
]);

const PDF_FILE_MIME_TYPES = new Map<string, string>([
  [".pdf", "application/pdf"],
]);

const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024 * 2;
const MAX_IMAGE_PREVIEW_BYTES = 1024 * 1024 * 12;
const MAX_TABLE_PREVIEW_BYTES = 1024 * 1024 * 8;
const MAX_PRESENTATION_PREVIEW_BYTES = 1024 * 1024 * 20;
const MAX_TABLE_PREVIEW_ROWS = 250;
const MAX_TABLE_PREVIEW_COLUMNS = 60;
const MAX_TABLE_PREVIEW_SHEETS = 8;
const DEFAULT_PRESENTATION_WIDTH_EMU = 12_192_000;
const DEFAULT_PRESENTATION_HEIGHT_EMU = 6_858_000;

function toPreviewTableCellValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  if (
    typeof value === "object" &&
    "text" in value &&
    typeof (value as { text?: unknown }).text === "function"
  ) {
    const textValue = (value as { text: () => unknown }).text();
    return typeof textValue === "string" ? textValue : String(textValue ?? "");
  }
  return String(value);
}

function trimTrailingEmptyTableCells(row: string[]): string[] {
  let lastNonEmptyIndex = row.length - 1;
  while (lastNonEmptyIndex >= 0 && row[lastNonEmptyIndex] === "") {
    lastNonEmptyIndex -= 1;
  }
  return row.slice(0, lastNonEmptyIndex + 1);
}

function normalizePreviewTableLinkTarget(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (/^localhost(?::\d+)?(?:[/?#]|$)/i.test(trimmed)) {
    return `http://${trimmed}`;
  }

  if (
    /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[/?#]|$)/.test(trimmed) ||
    /^(?:www\.)?(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?::\d+)?(?:[/?#]|$)/.test(
      trimmed,
    )
  ) {
    return /^www\./i.test(trimmed) ? `https://${trimmed}` : `https://${trimmed}`;
  }

  return null;
}

function trimTrailingEmptyTableLinkRow(
  row: (string | null)[],
  targetLength: number,
): (string | null)[] {
  return Array.from(
    { length: targetLength },
    (_unused, columnIndex) => row[columnIndex] ?? null,
  );
}

function worksheetRelationshipTypeKey(type: string): string {
  const normalizedType = type.trim();
  const lastSlashIndex = normalizedType.lastIndexOf("/");
  return lastSlashIndex >= 0
    ? normalizedType.slice(lastSlashIndex + 1)
    : normalizedType;
}

function zipPartPathFromRelationshipTarget(
  relationshipsPath: string,
  targetPath: string,
): string {
  if (targetPath.startsWith("/")) {
    return targetPath.slice(1);
  }
  const relationshipsDirectory = path.posix.dirname(relationshipsPath);
  const sourcePartDirectory = path.posix.dirname(relationshipsDirectory);
  return path.posix.normalize(
    path.posix.join(sourcePartDirectory, targetPath),
  );
}

function zipRelationshipsPathForPart(partPath: string): string {
  return path.posix.join(
    path.posix.dirname(partPath),
    "_rels",
    `${path.posix.basename(partPath)}.rels`,
  );
}

function zipPartPathFromRelationshipsPath(relationshipsPath: string): string {
  const relationshipsDirectory = path.posix.dirname(relationshipsPath);
  const sourcePartDirectory = path.posix.dirname(relationshipsDirectory);
  return path.posix.join(
    sourcePartDirectory,
    path.posix.basename(relationshipsPath, ".rels"),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseOpenXmlRelationships(relationshipsXml: string): Map<
  string,
  { type: string; target: string }
> {
  const relationships = new Map<string, { type: string; target: string }>();
  const relationshipMatches = relationshipsXml.matchAll(
    /<Relationship\b([^>]*)\/>/g,
  );
  for (const match of relationshipMatches) {
    const attributes = match[1] ?? "";
    const id = attributes.match(/\bId="([^"]+)"/)?.[1]?.trim();
    const type = attributes.match(/\bType="([^"]+)"/)?.[1]?.trim();
    const target = attributes.match(/\bTarget="([^"]+)"/)?.[1]?.trim();
    if (!id || !type || !target) {
      continue;
    }
    relationships.set(id, { type, target });
  }
  return relationships;
}

function workbookSheetPartPathsFromArchive(
  workbookXml: string,
  workbookRelationshipsXml: string,
): string[] {
  const workbookRelationships = parseOpenXmlRelationships(
    workbookRelationshipsXml,
  );
  const sheetPartPaths: string[] = [];
  const sheetMatches = workbookXml.matchAll(
    /<sheet\b[^>]*r:id="([^"]+)"[^>]*\/>/g,
  );
  for (const match of sheetMatches) {
    const relationshipId = match[1]?.trim();
    if (!relationshipId) {
      continue;
    }
    const relationship = workbookRelationships.get(relationshipId);
    if (!relationship) {
      continue;
    }
    sheetPartPaths.push(
      zipPartPathFromRelationshipTarget(
        "xl/_rels/workbook.xml.rels",
        relationship.target,
      ),
    );
  }
  return sheetPartPaths;
}

function openXmlIntTagValue(
  xml: string,
  tagName: string,
): number | null {
  const match = xml.match(
    new RegExp(`<${tagName}>(-?\\d+)</${tagName}>`, "i"),
  );
  const parsed = Number.parseInt(match?.[1] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function openXmlAttributeValue(
  xml: string,
  tagName: string,
  attributeName: string,
): string | null {
  const match = xml.match(
    new RegExp(
      `<(?:[A-Za-z0-9_]+:)?${tagName}\\b[^>]*${attributeName}="([^"]+)"[^>]*>`,
      "i",
    ),
  );
  return match?.[1]?.trim() || null;
}

function openXmlImageSizeFromAnchor(anchorXml: string): {
  widthPx?: number;
  heightPx?: number;
} {
  const extMatch = anchorXml.match(/<ext\b[^>]*cx="(\d+)"[^>]*cy="(\d+)"[^>]*\/>/i);
  const widthEmu = Number.parseInt(extMatch?.[1] ?? "", 10);
  const heightEmu = Number.parseInt(extMatch?.[2] ?? "", 10);
  return {
    widthPx:
      Number.isFinite(widthEmu) && widthEmu > 0
        ? Math.max(1, Math.round(widthEmu / 9525))
        : undefined,
    heightPx:
      Number.isFinite(heightEmu) && heightEmu > 0
        ? Math.max(1, Math.round(heightEmu / 9525))
        : undefined,
  };
}

function normalizeWorkbookPreviewSheetImages(
  images: Array<
    {
      sourceRow: number;
      sourceColumn: number;
      dataUrl: string;
      widthPx?: number;
      heightPx?: number;
      alt?: string;
    }
  >,
  sheet: FilePreviewTableSheetPayload,
): FilePreviewTableImagePayload[] {
  const headerOffset = sheet.hasHeaderRow ? 1 : 0;
  return images
    .map<FilePreviewTableImagePayload | null>((image) => {
      const row = image.sourceRow - headerOffset;
      const column = image.sourceColumn;
      if (
        row < 0 ||
        column < 0 ||
        row >= sheet.rows.length ||
        column >= sheet.columns.length
      ) {
        return null;
      }
      return {
        row,
        column,
        dataUrl: image.dataUrl,
        widthPx: image.widthPx,
        heightPx: image.heightPx,
        alt: image.alt,
      };
    })
    .filter((image): image is FilePreviewTableImagePayload => image !== null);
}

async function extractWorkbookPreviewImages(
  buffer: Buffer,
  tableSheets: FilePreviewTableSheetPayload[],
): Promise<FilePreviewTableSheetPayload[]> {
  if (tableSheets.length === 0) {
    return tableSheets;
  }

  const zip = await JSZip.loadAsync(buffer);
  const workbookFile = zip.file("xl/workbook.xml");
  const workbookRelationshipsFile = zip.file("xl/_rels/workbook.xml.rels");
  if (!workbookFile || !workbookRelationshipsFile) {
    return tableSheets;
  }

  const workbookXml = await workbookFile.async("string");
  const workbookRelationshipsXml = await workbookRelationshipsFile.async("string");
  const sheetPartPaths = workbookSheetPartPathsFromArchive(
    workbookXml,
    workbookRelationshipsXml,
  );

  const imagesBySheetIndex = new Map<
    number,
    Array<{
      sourceRow: number;
      sourceColumn: number;
      dataUrl: string;
      widthPx?: number;
      heightPx?: number;
      alt?: string;
    }>
  >();

  for (const [sheetIndex, worksheetPath] of sheetPartPaths.entries()) {
    if (sheetIndex >= tableSheets.length) {
      break;
    }

    const worksheetRelationshipsPath = zipRelationshipsPathForPart(worksheetPath);
    const worksheetRelationshipsFile = zip.file(worksheetRelationshipsPath);
    if (!worksheetRelationshipsFile) {
      continue;
    }

    const worksheetRelationshipsXml = await worksheetRelationshipsFile.async(
      "string",
    );
    const worksheetRelationships = parseOpenXmlRelationships(
      worksheetRelationshipsXml,
    );
    for (const relationship of worksheetRelationships.values()) {
      if (worksheetRelationshipTypeKey(relationship.type) !== "drawing") {
        continue;
      }

      const drawingPath = zipPartPathFromRelationshipTarget(
        worksheetRelationshipsPath,
        relationship.target,
      );
      const drawingFile = zip.file(drawingPath);
      if (!drawingFile) {
        continue;
      }
      const drawingRelationshipsPath = zipRelationshipsPathForPart(drawingPath);
      const drawingRelationshipsFile = zip.file(drawingRelationshipsPath);
      if (!drawingRelationshipsFile) {
        continue;
      }

      const drawingXml = await drawingFile.async("string");
      const drawingRelationshipsXml = await drawingRelationshipsFile.async(
        "string",
      );
      const drawingRelationships = parseOpenXmlRelationships(
        drawingRelationshipsXml,
      );
      const anchorMatches = drawingXml.matchAll(
        /<(?:xdr:)?(?:oneCellAnchor|twoCellAnchor)\b[\s\S]*?<\/(?:xdr:)?(?:oneCellAnchor|twoCellAnchor)>/g,
      );

      for (const anchorMatch of anchorMatches) {
        const anchorXml = anchorMatch[0];
        const fromXmlMatch = anchorXml.match(/<from>([\s\S]*?)<\/from>/i);
        const fromXml = fromXmlMatch?.[1] ?? "";
        const sourceColumn = openXmlIntTagValue(fromXml, "col");
        const sourceRow = openXmlIntTagValue(fromXml, "row");
        const imageRelationshipId =
          anchorXml.match(/<(?:[A-Za-z0-9_]+:)?blip\b[^>]*r:embed="([^"]+)"/i)?.[1] ??
          null;
        if (
          sourceColumn === null ||
          sourceRow === null ||
          !imageRelationshipId
        ) {
          continue;
        }

        const imageRelationship = drawingRelationships.get(imageRelationshipId);
        if (!imageRelationship) {
          continue;
        }

        const mediaPath = zipPartPathFromRelationshipTarget(
          drawingRelationshipsPath,
          imageRelationship.target,
        );
        const mediaFile = zip.file(mediaPath);
        if (!mediaFile) {
          continue;
        }

        const extension = path.posix.extname(mediaPath).toLowerCase();
        const mimeType = IMAGE_FILE_MIME_TYPES.get(extension);
        if (!mimeType) {
          continue;
        }

        const imageBuffer = await mediaFile.async("nodebuffer");
        const alt =
          openXmlAttributeValue(anchorXml, "cNvPr", "descr") ??
          openXmlAttributeValue(anchorXml, "cNvPr", "name") ??
          undefined;
        const sheetImages = imagesBySheetIndex.get(sheetIndex) ?? [];
        sheetImages.push({
          sourceRow,
          sourceColumn,
          dataUrl: `data:${mimeType};base64,${Buffer.from(imageBuffer).toString("base64")}`,
          ...openXmlImageSizeFromAnchor(anchorXml),
          alt: alt ? decodeXmlEntities(alt) : undefined,
        });
        imagesBySheetIndex.set(sheetIndex, sheetImages);
      }
    }
  }

  return tableSheets.map((sheet, sheetIndex) => {
    const sheetImages = normalizeWorkbookPreviewSheetImages(
      imagesBySheetIndex.get(sheetIndex) ?? [],
      sheet,
    );
    return sheetImages.length > 0
      ? {
          ...sheet,
          images: sheetImages,
        }
      : sheet;
  });
}

async function extractWorkbookPreviewImagesIfAvailable(
  buffer: Buffer,
  tableSheets: FilePreviewTableSheetPayload[],
): Promise<FilePreviewTableSheetPayload[]> {
  try {
    return await extractWorkbookPreviewImages(buffer, tableSheets);
  } catch {
    return tableSheets;
  }
}

function annotateTablePreviewSheets(
  tableSheets: FilePreviewTableSheetPayload[],
  previewOnly = false,
): TablePreviewSheetCollection {
  const sheets = [...tableSheets] as TablePreviewSheetCollection;
  if (previewOnly) {
    sheets.previewOnly = true;
  }
  return sheets;
}

async function collectWorkbookPreviewRelatedParts(
  zip: JSZip,
  partPath: string,
  partsToRemove: Set<string>,
  visitedParts: Set<string>,
): Promise<void> {
  if (visitedParts.has(partPath)) {
    return;
  }
  visitedParts.add(partPath);

  const partFile = zip.file(partPath);
  if (!partFile) {
    return;
  }
  partsToRemove.add(partPath);

  const relationshipsPath = zipRelationshipsPathForPart(partPath);
  const relationshipsFile = zip.file(relationshipsPath);
  if (!relationshipsFile) {
    return;
  }
  partsToRemove.add(relationshipsPath);

  const relationshipsXml = await relationshipsFile.async("string");
  const relationshipMatches = relationshipsXml.matchAll(
    /<Relationship\b[^>]*Target="([^"]+)"[^>]*\/>/g,
  );
  for (const match of relationshipMatches) {
    const targetPath = match[1];
    if (!targetPath) {
      continue;
    }
    await collectWorkbookPreviewRelatedParts(
      zip,
      zipPartPathFromRelationshipTarget(relationshipsPath, targetPath),
      partsToRemove,
      visitedParts,
    );
  }
}

async function stripWorkbookVisualArtifactsForPreview(
  buffer: Buffer,
): Promise<Buffer | null> {
  const zip = await JSZip.loadAsync(buffer);
  const partsToRemove = new Set<string>();
  const visitedParts = new Set<string>();
  const worksheetPartsToUpdate = new Set<string>();
  let removedAnyRelationships = false;

  for (const relationshipsPath of Object.keys(zip.files).filter(
    (candidatePath) =>
      candidatePath.startsWith("xl/worksheets/_rels/") &&
      candidatePath.endsWith(".xml.rels"),
  )) {
    const relationshipsFile = zip.file(relationshipsPath);
    if (!relationshipsFile) {
      continue;
    }

    const relationshipsXml = await relationshipsFile.async("string");
    const relationshipMatches = Array.from(
      relationshipsXml.matchAll(
        /<Relationship\b[^>]*Type="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>/g,
      ),
    );
    const removableRelationships = relationshipMatches.filter((match) =>
      PREVIEW_STRIPPABLE_WORKSHEET_RELATIONSHIP_TYPES.has(
        worksheetRelationshipTypeKey(match[1] ?? ""),
      ),
    );

    if (removableRelationships.length === 0) {
      continue;
    }

    removedAnyRelationships = true;
    worksheetPartsToUpdate.add(
      zipPartPathFromRelationshipsPath(relationshipsPath),
    );

    for (const match of removableRelationships) {
      const targetPath = match[2];
      if (!targetPath) {
        continue;
      }
      await collectWorkbookPreviewRelatedParts(
        zip,
        zipPartPathFromRelationshipTarget(relationshipsPath, targetPath),
        partsToRemove,
        visitedParts,
      );
    }

    const sanitizedRelationshipsXml = relationshipsXml.replace(
      /<Relationship\b[^>]*Type="([^"]+)"[^>]*\/>/g,
      (relationshipXml, rawType) =>
        PREVIEW_STRIPPABLE_WORKSHEET_RELATIONSHIP_TYPES.has(
          worksheetRelationshipTypeKey(String(rawType ?? "")),
        )
          ? ""
          : relationshipXml,
    );
    zip.file(relationshipsPath, sanitizedRelationshipsXml);
  }

  if (!removedAnyRelationships) {
    return null;
  }

  for (const worksheetPartPath of worksheetPartsToUpdate) {
    const worksheetFile = zip.file(worksheetPartPath);
    if (!worksheetFile) {
      continue;
    }
    const worksheetXml = await worksheetFile.async("string");
    const sanitizedWorksheetXml = worksheetXml.replace(
      /<(?:drawing|legacyDrawing|legacyDrawingHF)\b[^>]*\/>/g,
      "",
    );
    zip.file(worksheetPartPath, sanitizedWorksheetXml);
  }

  for (const partPath of partsToRemove) {
    zip.remove(partPath);
  }

  const contentTypesFile = zip.file("[Content_Types].xml");
  if (contentTypesFile) {
    let contentTypesXml = await contentTypesFile.async("string");
    for (const partPath of partsToRemove) {
      contentTypesXml = contentTypesXml.replace(
        new RegExp(
          `<Override PartName="/${escapeRegExp(partPath)}"[^>]*/>`,
          "g",
        ),
        "",
      );
    }

    for (const extension of ["png", "vml"]) {
      const extensionStillExists = Object.keys(zip.files).some((candidatePath) =>
        candidatePath.toLowerCase().endsWith(`.${extension}`),
      );
      if (extensionStillExists) {
        continue;
      }
      contentTypesXml = contentTypesXml.replace(
        new RegExp(`<Default Extension="${extension}"[^>]*/>`, "g"),
        "",
      );
    }

    zip.file("[Content_Types].xml", contentTypesXml);
  }

  const sanitizedBuffer = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(sanitizedBuffer);
}

function workbookRangeRows(range: XlsxPopulateRange | undefined): unknown[][] {
  if (!range) {
    return [];
  }

  const matrix = range.value();
  if (!Array.isArray(matrix)) {
    return [[matrix]];
  }

  return matrix.map((row) => (Array.isArray(row) ? row : [row]));
}

function workbookOutputToBuffer(
  output: Buffer | Uint8Array | ArrayBuffer,
): Buffer {
  if (Buffer.isBuffer(output)) {
    return output;
  }
  if (output instanceof Uint8Array) {
    return Buffer.from(output);
  }
  return Buffer.from(output);
}

function parseCsvRows(text: string): string[][] {
  if (!text) {
    return [];
  }

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = "";
  let inQuotes = false;
  let sawAnyCharacter = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    sawAnyCharacter = true;

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          currentCell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        currentCell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      currentRow.push(currentCell);
      currentCell = "";
      continue;
    }
    if (char === "\r" || char === "\n") {
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = "";
      if (char === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      continue;
    }

    currentCell += char;
  }

  if (
    sawAnyCharacter &&
    (
      currentCell.length > 0 ||
      currentRow.length > 0 ||
      (!text.endsWith("\n") && !text.endsWith("\r"))
    )
  ) {
    currentRow.push(currentCell);
    rows.push(currentRow);
  }

  return rows;
}

function serializeCsvCell(value: string): string {
  return /[",\n\r]/.test(value)
    ? `"${value.replace(/"/g, "\"\"")}"`
    : value;
}

function stringifyCsvRows(rows: string[][]): string {
  return rows
    .map((row) => row.map((cell) => serializeCsvCell(cell)).join(","))
    .join("\r\n");
}

function worksheetPreviewRows(worksheet: XlsxPopulateWorksheet): {
  rows: string[][];
  links: (string | null)[][];
} {
  const rows: string[][] = [];
  const links: (string | null)[][] = [];
  const worksheetRows = workbookRangeRows(worksheet.usedRange());

  worksheetRows.forEach((row, rowIndex) => {
    const values = row.map((cell) => toPreviewTableCellValue(cell));
    const rowLinks = values.map((value, columnIndex) => {
      const hyperlink = worksheet.cell(rowIndex + 1, columnIndex + 1).hyperlink();
      return normalizePreviewTableLinkTarget(hyperlink ?? value);
    });
    const trimmedValues = trimTrailingEmptyTableCells(values);
    rows.push(trimmedValues);
    links.push(trimTrailingEmptyTableLinkRow(rowLinks, trimmedValues.length));
  });

  return { rows, links };
}

function tablePreviewSheetFromRows(
  sheetName: string,
  sheetIndex: number,
  rawRows: string[][],
  rawLinks: (string | null)[][],
  totalSheetCount: number,
): FilePreviewTableSheetPayload {
  const totalColumns = rawRows.reduce(
    (max, row) => Math.max(max, row.length),
    0,
  );
  const visibleColumnCount = Math.min(
    Math.max(totalColumns, 1),
    MAX_TABLE_PREVIEW_COLUMNS,
  );
  const paddedRows = rawRows.map((row) =>
    Array.from(
      { length: visibleColumnCount },
      (_unused, columnIndex) => row[columnIndex] ?? "",
    ),
  );
  const paddedLinks = rawLinks.map((row) =>
    Array.from(
      { length: visibleColumnCount },
      (_unused, columnIndex) => row[columnIndex] ?? null,
    ),
  );
  const hasHeaderRow =
    paddedRows.length > 0 &&
    paddedRows[0].some((cell) => cell.trim().length > 0);
  const columns = hasHeaderRow
    ? paddedRows[0].map(
        (value, columnIndex) => value.trim() || `Column ${columnIndex + 1}`,
      )
    : Array.from(
        { length: visibleColumnCount },
        (_unused, columnIndex) => `Column ${columnIndex + 1}`,
      );
  const allRows = hasHeaderRow ? paddedRows.slice(1) : paddedRows;
  const allLinks = hasHeaderRow ? paddedLinks.slice(1) : paddedLinks;
  const rows = allRows.slice(0, MAX_TABLE_PREVIEW_ROWS);
  const links = allLinks.slice(0, MAX_TABLE_PREVIEW_ROWS);
  const truncated =
    allRows.length > rows.length ||
    totalColumns > visibleColumnCount ||
    totalSheetCount > MAX_TABLE_PREVIEW_SHEETS;

  return {
    name: sheetName || `Sheet ${sheetIndex + 1}`,
    index: sheetIndex,
    columns,
    rows,
    links,
    totalRows: allRows.length,
    totalColumns,
    truncated,
    hasHeaderRow,
  };
}

function normalizeWritableTableString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

function normalizeWritableTableSheets(
  value: unknown,
): FilePreviewTableSheetPayload[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map<FilePreviewTableSheetPayload | null>((sheet, sheetIndex) => {
      if (!sheet || typeof sheet !== "object") {
        return null;
      }

      const candidate = sheet as Partial<FilePreviewTableSheetPayload>;
      const columns = Array.isArray(candidate.columns)
        ? candidate.columns.map((column) =>
            normalizeWritableTableString(column),
          )
        : [];
      const rows = Array.isArray(candidate.rows)
        ? candidate.rows.map((row) =>
            Array.isArray(row)
              ? row.map((cell) => normalizeWritableTableString(cell))
              : [],
          )
        : [];
      const links = Array.isArray(candidate.links)
        ? candidate.links.map((row) =>
            Array.isArray(row)
              ? row.map((cell) => normalizePreviewTableLinkTarget(cell))
              : [],
          )
        : rows.map((row) => row.map(() => null));
      const normalizedName =
        typeof candidate.name === "string" && candidate.name.trim()
          ? candidate.name.trim()
          : `Sheet ${sheetIndex + 1}`;

      return {
        name: normalizedName,
        index:
          typeof candidate.index === "number" &&
          Number.isFinite(candidate.index)
            ? candidate.index
            : sheetIndex,
        columns,
        rows,
        links,
        totalRows:
          typeof candidate.totalRows === "number" &&
          Number.isFinite(candidate.totalRows)
            ? candidate.totalRows
            : rows.length,
        totalColumns:
          typeof candidate.totalColumns === "number" &&
          Number.isFinite(candidate.totalColumns)
            ? candidate.totalColumns
            : columns.length,
        truncated: Boolean(candidate.truncated),
        hasHeaderRow: candidate.hasHeaderRow !== false,
      };
    })
    .filter((sheet): sheet is FilePreviewTableSheetPayload => sheet !== null);
}

function sourceRowsFromTablePreviewSheet(
  sheet: FilePreviewTableSheetPayload,
): string[][] {
  const visibleColumnCount = Math.max(sheet.columns.length, 1);
  const sourceRows = sheet.hasHeaderRow
    ? [sheet.columns, ...sheet.rows]
    : sheet.rows;
  return sourceRows.map((row) =>
    Array.from(
      { length: visibleColumnCount },
      (_unused, columnIndex) => row[columnIndex] ?? "",
    ),
  );
}

function sourceLinksFromTablePreviewSheet(
  sheet: FilePreviewTableSheetPayload,
): (string | null)[][] {
  const visibleColumnCount = Math.max(sheet.columns.length, 1);
  const bodyLinks = (sheet.links ?? []).map((row) =>
    Array.from(
      { length: visibleColumnCount },
      (_unused, columnIndex) =>
        normalizePreviewTableLinkTarget(row[columnIndex]) ?? null,
    ),
  );

  if (sheet.hasHeaderRow) {
    return [Array.from({ length: visibleColumnCount }, () => null), ...bodyLinks];
  }

  return bodyLinks;
}

function applyPreviewSheetEditsToWorksheet(
  worksheet: XlsxPopulateWorksheet,
  sheet: FilePreviewTableSheetPayload,
) {
  const sourceRows = sourceRowsFromTablePreviewSheet(sheet);
  const sourceLinks = sourceLinksFromTablePreviewSheet(sheet);
  for (const [rowIndex, row] of sourceRows.entries()) {
    for (const [columnIndex, value] of row.entries()) {
      const cell = worksheet.cell(rowIndex + 1, columnIndex + 1);
      const hyperlink = sourceLinks[rowIndex]?.[columnIndex] ?? null;
      cell.value(value);
      if (hyperlink) {
        cell.hyperlink(hyperlink);
      } else {
        worksheet.hyperlink(cell.address(), undefined);
      }
    }
  }
}

async function writeCsvTablePreview(
  absolutePath: string,
  sheet: FilePreviewTableSheetPayload,
): Promise<void> {
  const sourceRows = sourceRowsFromTablePreviewSheet(sheet);
  await fs.writeFile(absolutePath, stringifyCsvRows(sourceRows), "utf-8");
}

async function writeWorkbookTablePreview(
  absolutePath: string,
  buffer: Buffer,
  tableSheets: FilePreviewTableSheetPayload[],
): Promise<void> {
  const workbook = await XlsxPopulate.fromDataAsync(buffer);

  for (const sheet of tableSheets) {
    const worksheet = workbook.sheet(sheet.index);
    if (!worksheet) {
      continue;
    }
    applyPreviewSheetEditsToWorksheet(worksheet, sheet);
  }

  const outputBuffer = await workbook.outputAsync();
  await fs.writeFile(absolutePath, workbookOutputToBuffer(outputBuffer));
}

async function buildWorkbookPreviewSheets(
  buffer: Buffer,
): Promise<FilePreviewTableSheetPayload[]> {
  const workbook = await XlsxPopulate.fromDataAsync(buffer);
  const worksheets = workbook.sheets();

  return worksheets.slice(0, MAX_TABLE_PREVIEW_SHEETS).map((worksheet, sheetIndex) => {
    const preview = worksheetPreviewRows(worksheet);
    return tablePreviewSheetFromRows(
      worksheet.name(),
      sheetIndex,
      preview.rows,
      preview.links,
      worksheets.length,
    );
  });
}

async function buildWorkbookPreviewSheetsWithFallback(
  buffer: Buffer,
): Promise<TablePreviewSheetCollection> {
  try {
    return annotateTablePreviewSheets(
      await extractWorkbookPreviewImagesIfAvailable(
        buffer,
        await buildWorkbookPreviewSheets(buffer),
      ),
    );
  } catch (error) {
    const sanitizedBuffer = await stripWorkbookVisualArtifactsForPreview(buffer);
    if (!sanitizedBuffer) {
      throw error;
    }
    return annotateTablePreviewSheets(
      await extractWorkbookPreviewImagesIfAvailable(
        buffer,
        await buildWorkbookPreviewSheets(sanitizedBuffer),
      ),
      true,
    );
  }
}

async function buildCsvPreviewSheets(
  buffer: Buffer,
): Promise<FilePreviewTableSheetPayload[]> {
  const rows = parseCsvRows(buffer.toString("utf8").replace(/^\uFEFF/, ""));
  const normalizedRows = rows.map((row) =>
    trimTrailingEmptyTableCells(
      row.map((cell) => toPreviewTableCellValue(cell)),
    ),
  );
  const links = normalizedRows.map((row) => row.map(() => null));

  return [
    tablePreviewSheetFromRows("Sheet 1", 0, normalizedRows, links, 1),
  ];
}

async function buildTablePreviewSheets(
  buffer: Buffer,
  extension: string,
): Promise<TablePreviewSheetCollection> {
  if (extension === ".csv") {
    return annotateTablePreviewSheets(await buildCsvPreviewSheets(buffer));
  }
  return buildWorkbookPreviewSheetsWithFallback(buffer);
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, decimal) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    );
}

function normalizePresentationText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function clampPresentationPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

function fontSizePxFromOpenXmlSize(
  rawSize: string | null | undefined,
): number | undefined {
  if (!rawSize) {
    return undefined;
  }
  const parsed = Number.parseInt(rawSize, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  const points = parsed / 100;
  return Math.max(12, Math.min(42, Math.round(points * (96 / 72))));
}

function presentationTextAlignFromOpenXml(
  rawAlign: string | null | undefined,
): FilePreviewPresentationTextBoxPayload["align"] {
  switch ((rawAlign ?? "").trim().toLowerCase()) {
    case "ctr":
      return "center";
    case "r":
      return "right";
    case "just":
    case "dist":
      return "justify";
    default:
      return "left";
  }
}

function parsePresentationSlideSize(
  presentationXml: string | null | undefined,
): { width: number; height: number } {
  const match = presentationXml?.match(
    /<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/i,
  );
  const width = Number.parseInt(match?.[1] ?? "", 10);
  const height = Number.parseInt(match?.[2] ?? "", 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return {
      width: DEFAULT_PRESENTATION_WIDTH_EMU,
      height: DEFAULT_PRESENTATION_HEIGHT_EMU,
    };
  }
  return { width, height };
}

function extractPresentationSlideTextBoxes(
  slideXml: string,
  slideWidth: number,
  slideHeight: number,
): FilePreviewPresentationTextBoxPayload[] {
  const boxes: FilePreviewPresentationTextBoxPayload[] = [];
  const shapeMatches = slideXml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/gi);
  for (const shapeMatch of shapeMatches) {
    const shapeXml = shapeMatch[0];
    if (!/<p:txBody\b/i.test(shapeXml)) {
      continue;
    }

    const paragraphs: string[] = [];
    let align: FilePreviewPresentationTextBoxPayload["align"] = "left";
    let alignResolved = false;
    let fontSizePx: number | undefined;
    let bold = false;
    const paragraphMatches = shapeXml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/gi);
    for (const paragraphMatch of paragraphMatches) {
      const paragraphXml = paragraphMatch[0];
      if (!alignResolved) {
        const paragraphAlign = paragraphXml.match(
          /<a:pPr\b[^>]*\balgn="([^"]+)"/i,
        )?.[1];
        if (paragraphAlign) {
          align = presentationTextAlignFromOpenXml(paragraphAlign);
          alignResolved = true;
        }
      }
      if (fontSizePx === undefined) {
        const rawSize =
          paragraphXml.match(
            /<(?:a:rPr|a:defRPr|a:endParaRPr)\b[^>]*\bsz="(\d+)"/i,
          )?.[1] ?? null;
        fontSizePx = fontSizePxFromOpenXmlSize(rawSize);
      }
      if (
        !bold &&
        /<(?:a:rPr|a:defRPr|a:endParaRPr)\b[^>]*\bb="1"/i.test(paragraphXml)
      ) {
        bold = true;
      }
      const textRuns = [...paragraphXml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/gi)]
        .map((match) => decodeXmlEntities(match[1] ?? ""))
        .join("");
      const normalizedText = normalizePresentationText(textRuns);
      if (normalizedText) {
        paragraphs.push(normalizedText);
      }
    }

    if (paragraphs.length === 0) {
      continue;
    }

    const xfrmMatch = shapeXml.match(
      /<a:xfrm\b[\s\S]*?<a:off\b[^>]*\bx="(\d+)"[^>]*\by="(\d+)"[^>]*\/>[\s\S]*?<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"[^>]*\/>[\s\S]*?<\/a:xfrm>/i,
    );
    const x = Number.parseInt(xfrmMatch?.[1] ?? "", 10);
    const y = Number.parseInt(xfrmMatch?.[2] ?? "", 10);
    const width = Number.parseInt(xfrmMatch?.[3] ?? "", 10);
    const height = Number.parseInt(xfrmMatch?.[4] ?? "", 10);
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      boxes.push({
        xPct: 8,
        yPct: clampPresentationPercent(10 + boxes.length * 12),
        widthPct: 84,
        heightPct: 12,
        paragraphs,
        align,
        ...(fontSizePx ? { fontSizePx } : {}),
        ...(bold ? { bold: true } : {}),
      });
      continue;
    }

    boxes.push({
      xPct: clampPresentationPercent((x / slideWidth) * 100),
      yPct: clampPresentationPercent((y / slideHeight) * 100),
      widthPct: clampPresentationPercent((width / slideWidth) * 100),
      heightPct: clampPresentationPercent((height / slideHeight) * 100),
      paragraphs,
      align,
      ...(fontSizePx ? { fontSizePx } : {}),
      ...(bold ? { bold: true } : {}),
    });
  }

  boxes.sort((left, right) => {
    if (left.yPct !== right.yPct) {
      return left.yPct - right.yPct;
    }
    return left.xPct - right.xPct;
  });

  if (boxes.length > 0) {
    return boxes;
  }

  const fallbackParagraphs = [...slideXml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/gi)]
    .map((match) =>
      normalizePresentationText(decodeXmlEntities(match[1] ?? "")),
    )
    .filter(Boolean);
  if (fallbackParagraphs.length === 0) {
    return [];
  }
  return [
    {
      xPct: 8,
      yPct: 10,
      widthPct: 84,
      heightPct: 80,
      paragraphs: fallbackParagraphs,
      align: "left",
    },
  ];
}

async function buildPresentationPreview(buffer: Buffer): Promise<{
  presentationSlides: FilePreviewPresentationSlidePayload[];
  presentationWidth: number;
  presentationHeight: number;
}> {
  const zip = await JSZip.loadAsync(buffer);
  const presentationXml = await zip.file("ppt/presentation.xml")?.async("text");
  const { width, height } = parsePresentationSlideSize(presentationXml);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true }),
    );
  const presentationSlides: FilePreviewPresentationSlidePayload[] = [];
  for (const [index, slideFilePath] of slideFiles.entries()) {
    const slideXml = await zip.file(slideFilePath)?.async("text");
    if (!slideXml) {
      continue;
    }
    presentationSlides.push({
      index: index + 1,
      boxes: extractPresentationSlideTextBoxes(slideXml, width, height),
    });
  }
  return {
    presentationSlides,
    presentationWidth: width,
    presentationHeight: height,
  };
}

function getFilePreviewKind(targetPath: string) {
  const extension = path.extname(targetPath).toLowerCase();
  if (!extension) {
    return { extension, kind: "text" as const };
  }

  if (TABLE_FILE_EXTENSIONS.has(extension)) {
    return { extension, kind: "table" as const };
  }

  if (PRESENTATION_FILE_EXTENSIONS.has(extension)) {
    return { extension, kind: "presentation" as const };
  }

  if (TEXT_FILE_EXTENSIONS.has(extension)) {
    return { extension, kind: "text" as const };
  }

  const mimeType = IMAGE_FILE_MIME_TYPES.get(extension);
  if (mimeType) {
    return { extension, kind: "image" as const, mimeType };
  }

  const pdfMimeType = PDF_FILE_MIME_TYPES.get(extension);
  if (pdfMimeType) {
    return { extension, kind: "pdf" as const, mimeType: pdfMimeType };
  }

  return { extension, kind: "unsupported" as const };
}

function describeProtectedWorkspaceExplorerPath(
  workspaceRoot: string | null,
  absolutePath: string,
): "workspace.yaml" | "AGENTS.md" | "skills" | null {
  if (!workspaceRoot) {
    return null;
  }

  const relativePath = path.relative(workspaceRoot, absolutePath);
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }

  const normalizedRelativePath = relativePath
    .trim()
    .replace(/[\\/]+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  if (!normalizedRelativePath) {
    return null;
  }
  if (normalizedRelativePath === "workspace.yaml") {
    return "workspace.yaml";
  }
  if (normalizedRelativePath === "agents.md") {
    return "AGENTS.md";
  }
  if (normalizedRelativePath === "skills") {
    return "skills";
  }
  return null;
}

function protectedWorkspaceExplorerPathMessage(
  protectedPathLabel: "workspace.yaml" | "AGENTS.md" | "skills",
) {
  if (protectedPathLabel === "skills") {
    return "The skills folder cannot be renamed, moved, or deleted from the file explorer.";
  }
  return `${protectedPathLabel} cannot be renamed, moved, or deleted from the file explorer.`;
}

function assertWorkspaceExplorerPathModifiable(
  workspaceRoot: string | null,
  absolutePath: string,
) {
  const protectedPathLabel = describeProtectedWorkspaceExplorerPath(
    workspaceRoot,
    absolutePath,
  );
  if (protectedPathLabel) {
    throw new Error(
      protectedWorkspaceExplorerPathMessage(protectedPathLabel),
    );
  }
}

async function readFilePreview(
  targetPath: string,
  workspaceId?: string | null,
): Promise<FilePreviewPayload> {
  const { absolutePath } = await resolveWorkspaceScopedExplorerPath(
    targetPath,
    workspaceId,
  );
  const stat = await fs.stat(absolutePath);

  if (stat.isDirectory()) {
    throw new Error("Target path is a directory.");
  }

  const { extension, kind, mimeType } = getFilePreviewKind(absolutePath);
  const basePayload: FilePreviewPayload = {
    absolutePath,
    name: path.basename(absolutePath),
    extension,
    kind,
    mimeType,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    isEditable: kind === "text",
  };

  if (kind === "table") {
    if (stat.size > MAX_TABLE_PREVIEW_BYTES) {
      return {
        ...basePayload,
        kind: "unsupported",
        isEditable: false,
        unsupportedReason: "Spreadsheet is too large to preview inline.",
      };
    }

    try {
      const buffer = await fs.readFile(absolutePath);
      const tableSheets = await buildTablePreviewSheets(buffer, extension);
      if (tableSheets.length === 0) {
        return {
          ...basePayload,
          kind: "unsupported",
          isEditable: false,
          unsupportedReason: "No sheet data could be extracted from this file.",
        };
      }

      return {
        ...basePayload,
        kind: "table",
        isEditable:
          extension !== ".xls" &&
          !tableSheets.previewOnly &&
          tableSheets.every((sheet) => !sheet.truncated),
        tableSheets,
      };
    } catch {
      return {
        ...basePayload,
        kind: "unsupported",
        isEditable: false,
        unsupportedReason:
          "Spreadsheet could not be parsed for inline preview.",
      };
    }
  }

  if (kind === "presentation") {
    if (stat.size > MAX_PRESENTATION_PREVIEW_BYTES) {
      return {
        ...basePayload,
        kind: "unsupported",
        isEditable: false,
        unsupportedReason: "Presentation is too large to preview inline.",
      };
    }

    try {
      const buffer = await fs.readFile(absolutePath);
      const {
        presentationSlides,
        presentationWidth,
        presentationHeight,
      } = await buildPresentationPreview(buffer);
      if (presentationSlides.length === 0) {
        return {
          ...basePayload,
          kind: "unsupported",
          isEditable: false,
          unsupportedReason:
            "No slide content could be extracted from this presentation.",
        };
      }
      return {
        ...basePayload,
        kind: "presentation",
        presentationSlides,
        presentationWidth,
        presentationHeight,
      };
    } catch {
      return {
        ...basePayload,
        kind: "unsupported",
        isEditable: false,
        unsupportedReason:
          "Presentation could not be parsed for inline preview.",
      };
    }
  }

  if (kind === "text") {
    if (stat.size > MAX_TEXT_PREVIEW_BYTES) {
      return {
        ...basePayload,
        kind: "unsupported",
        isEditable: false,
        unsupportedReason: "Text file is too large to preview inline.",
      };
    }

    return {
      ...basePayload,
      content: await fs.readFile(absolutePath, "utf-8"),
    };
  }

  if (kind === "image") {
    if (stat.size > MAX_IMAGE_PREVIEW_BYTES) {
      return {
        ...basePayload,
        kind: "unsupported",
        isEditable: false,
        unsupportedReason: "Image is too large to preview inline.",
      };
    }

    const buffer = await fs.readFile(absolutePath);
    return {
      ...basePayload,
      dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
    };
  }

  if (kind === "pdf") {
    const buffer = await fs.readFile(absolutePath);
    return {
      ...basePayload,
      dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
    };
  }

  return {
    ...basePayload,
    unsupportedReason: "Preview is not available for this file type yet.",
  };
}

async function writeTextFile(
  targetPath: string,
  content: string,
  workspaceId?: string | null,
): Promise<FilePreviewPayload> {
  const { absolutePath } = await resolveWorkspaceScopedExplorerPath(
    targetPath,
    workspaceId,
  );
  await fs.writeFile(absolutePath, content, "utf-8");
  return readFilePreview(absolutePath, workspaceId);
}

async function writeTableFile(
  targetPath: string,
  tableSheets: unknown,
  workspaceId?: string | null,
): Promise<FilePreviewPayload> {
  const { absolutePath } = await resolveWorkspaceScopedExplorerPath(
    targetPath,
    workspaceId,
  );
  const stat = await fs.stat(absolutePath);
  if (stat.isDirectory()) {
    throw new Error("Target path is a directory.");
  }

  const { extension, kind } = getFilePreviewKind(absolutePath);
  if (kind !== "table") {
    throw new Error("Target file is not a spreadsheet preview.");
  }
  if (extension === ".xls") {
    throw new Error("Legacy .xls files are preview-only in the inline editor.");
  }

  const normalizedTableSheets = normalizeWritableTableSheets(tableSheets);
  if (normalizedTableSheets.length === 0) {
    throw new Error(
      "Spreadsheet preview did not include any editable sheet data.",
    );
  }
  if (normalizedTableSheets.some((sheet) => sheet.truncated)) {
    throw new Error("Spreadsheet is too large to edit inline.");
  }

  if (extension === ".csv") {
    await writeCsvTablePreview(absolutePath, normalizedTableSheets[0]);
    return readFilePreview(absolutePath, workspaceId);
  }

  const buffer = await fs.readFile(absolutePath);
  await writeWorkbookTablePreview(absolutePath, buffer, normalizedTableSheets);
  return readFilePreview(absolutePath, workspaceId);
}

async function watchFilePreviewPath(
  targetPath: string,
  workspaceId?: string | null,
): Promise<FilePreviewWatchSubscriptionPayload> {
  const { absolutePath } = await resolveWorkspaceScopedExplorerPath(
    targetPath,
    workspaceId,
  );
  const watchedDirectoryPath = path.dirname(absolutePath);
  const watchedFileName = path.basename(absolutePath);
  const subscriptionId = `file-preview-watch:${randomUUID()}`;
  const watcher = watch(
    watchedDirectoryPath,
    { persistent: false },
    (_eventType, filename) => {
      const normalizedFilename =
        typeof filename === "string"
          ? filename
          : filename == null
            ? ""
            : String(filename);
      if (normalizedFilename && normalizedFilename !== watchedFileName) {
        return;
      }
      emitFilePreviewChanged({ absolutePath });
    },
  );

  filePreviewWatchSubscriptions.set(subscriptionId, {
    absolutePath,
    watcher,
  });
  watcher.on("error", () => {
    closeFilePreviewWatchSubscription(subscriptionId);
    emitFilePreviewChanged({ absolutePath });
  });

  return {
    subscriptionId,
    absolutePath,
  };
}

function isPathWithinRoot(rootPath: string, targetPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function shouldAutoRenameBookmarkLabel(
  bookmark: FileBookmarkPayload,
  previousTargetPath: string,
): boolean {
  return (
    bookmark.label === path.basename(previousTargetPath) ||
    bookmark.label === previousTargetPath
  );
}

function isSameOrDescendantPath(rootPath: string, targetPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

async function persistUpdatedFileBookmarks(
  nextBookmarks: FileBookmarkPayload[],
): Promise<void> {
  if (nextBookmarks === fileBookmarks) {
    return;
  }
  fileBookmarks = nextBookmarks;
  emitFileBookmarksState();
  await persistFileBookmarks();
}

async function resolveWorkspaceScopedExplorerPath(
  targetPath?: string | null,
  workspaceId?: string | null,
): Promise<{ absolutePath: string; workspaceRoot: string | null }> {
  const normalizedWorkspaceId =
    typeof workspaceId === "string" ? workspaceId.trim() : "";
  const trimmedTargetPath =
    typeof targetPath === "string" ? targetPath.trim() : "";

  if (!normalizedWorkspaceId) {
    const fallbackPath = trimmedTargetPath || runtimeSandboxRoot();
    return {
      absolutePath: path.resolve(fallbackPath),
      workspaceRoot: null,
    };
  }

  const workspaceRoot = await resolveLocalWorkspaceRoot(normalizedWorkspaceId);
  const resolvedTargetPath = trimmedTargetPath
    ? path.resolve(
        path.isAbsolute(trimmedTargetPath)
          ? trimmedTargetPath
          : path.join(workspaceRoot, trimmedTargetPath),
      )
    : workspaceRoot;

  if (!isPathWithinRoot(workspaceRoot, resolvedTargetPath)) {
    throw new Error(`Target path escapes workspace root: ${trimmedTargetPath}`);
  }

  return {
    absolutePath: resolvedTargetPath,
    workspaceRoot,
  };
}

async function ensureExplorerPathDoesNotExist(
  targetPath: string,
): Promise<void> {
  if (await fileExists(targetPath)) {
    const targetName = path.basename(targetPath) || targetPath;
    throw new Error(`A file or folder named "${targetName}" already exists.`);
  }
}

async function rewriteExplorerBookmarksAfterPathChange(
  previousAbsolutePath: string,
  nextAbsolutePath: string,
): Promise<void> {
  let didRewriteBookmarks = false;
  const nextBookmarks = fileBookmarks.map((bookmark) => {
    if (!isSameOrDescendantPath(previousAbsolutePath, bookmark.targetPath)) {
      return bookmark;
    }

    const relativePath = path.relative(
      previousAbsolutePath,
      bookmark.targetPath,
    );
    const rewrittenTargetPath = relativePath
      ? path.join(nextAbsolutePath, relativePath)
      : nextAbsolutePath;
    const rewrittenLabel =
      relativePath === "" &&
      shouldAutoRenameBookmarkLabel(bookmark, previousAbsolutePath)
        ? path.basename(nextAbsolutePath)
        : bookmark.label === bookmark.targetPath
          ? rewrittenTargetPath
          : bookmark.label;

    if (
      rewrittenTargetPath === bookmark.targetPath &&
      rewrittenLabel === bookmark.label
    ) {
      return bookmark;
    }

    didRewriteBookmarks = true;
    return {
      ...bookmark,
      targetPath: rewrittenTargetPath,
      label: rewrittenLabel,
    };
  });

  if (didRewriteBookmarks) {
    await persistUpdatedFileBookmarks(nextBookmarks);
  }
}

function numberedExplorerCreateName(baseName: string, attempt: number): string {
  if (attempt <= 1) {
    return baseName;
  }
  const extension = path.extname(baseName);
  const stem = extension ? baseName.slice(0, -extension.length) : baseName;
  return `${stem} ${attempt}${extension}`;
}

async function nextAvailableExplorerCreatePath(
  parentPath: string,
  baseName: string,
): Promise<string> {
  for (let attempt = 1; attempt < 10_000; attempt += 1) {
    const candidatePath = path.join(
      parentPath,
      numberedExplorerCreateName(baseName, attempt),
    );
    if (!(await fileExists(candidatePath))) {
      return candidatePath;
    }
  }

  throw new Error(`Failed to choose an available name for "${baseName}".`);
}

async function createExplorerPath(
  parentPath: string | null | undefined,
  kind: FileSystemCreateKind,
  workspaceId?: string | null,
): Promise<FileSystemMutationPayload> {
  const { absolutePath: parentAbsolutePath, workspaceRoot } =
    await resolveWorkspaceScopedExplorerPath(parentPath, workspaceId);
  const parentStat = await fs.stat(parentAbsolutePath);
  if (!parentStat.isDirectory()) {
    throw new Error("Target path is not a directory.");
  }

  const nextAbsolutePath = await nextAvailableExplorerCreatePath(
    parentAbsolutePath,
    kind === "directory" ? "New Folder" : "Untitled.txt",
  );
  if (workspaceRoot && !isPathWithinRoot(workspaceRoot, nextAbsolutePath)) {
    throw new Error("Created path escapes workspace root.");
  }

  if (kind === "directory") {
    await fs.mkdir(nextAbsolutePath);
  } else {
    await fs.writeFile(nextAbsolutePath, "", { flag: "wx" });
  }

  return {
    absolutePath: nextAbsolutePath,
  };
}

function normalizeExplorerImportRelativePath(relativePath: string) {
  const normalized = relativePath
    .trim()
    .replace(/[\\/]+/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!normalized) {
    throw new Error("Imported path cannot be empty.");
  }

  const segments = normalized
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\"),
    )
  ) {
    throw new Error(`Imported path is invalid: ${relativePath}`);
  }

  return segments.join("/");
}

function normalizeExplorerImportEntries(
  entries: unknown,
): ExplorerExternalImportEntryPayload[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("No files or folders were dropped.");
  }

  const normalizedEntries: ExplorerExternalImportEntryPayload[] = [];
  const seenRelativePaths = new Set<string>();

  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Dropped content could not be parsed.");
    }

    const kind = "kind" in entry ? entry.kind : "";
    const relativePath =
      "relativePath" in entry && typeof entry.relativePath === "string"
        ? normalizeExplorerImportRelativePath(entry.relativePath)
        : "";
    if (!relativePath) {
      throw new Error("Dropped content is missing a relative path.");
    }
    if (seenRelativePaths.has(relativePath)) {
      continue;
    }
    seenRelativePaths.add(relativePath);

    if (kind === "directory") {
      normalizedEntries.push({
        kind: "directory",
        relativePath,
      });
      continue;
    }

    if (kind !== "file") {
      throw new Error(`Unsupported dropped item kind: ${String(kind)}`);
    }

    const contentValue = "content" in entry ? entry.content : null;
    const content =
      contentValue instanceof Uint8Array
        ? contentValue
        : contentValue instanceof ArrayBuffer
          ? new Uint8Array(contentValue)
          : ArrayBuffer.isView(contentValue)
            ? new Uint8Array(
                contentValue.buffer.slice(
                  contentValue.byteOffset,
                  contentValue.byteOffset + contentValue.byteLength,
                ),
              )
            : Array.isArray(contentValue)
              ? Uint8Array.from(contentValue)
              : null;
    if (!content) {
      throw new Error(`Dropped file content is invalid: ${relativePath}`);
    }

    normalizedEntries.push({
      kind: "file",
      relativePath,
      content,
    });
  }

  return normalizedEntries;
}

function importedEntryDepth(relativePath: string) {
  return normalizeExplorerImportRelativePath(relativePath).split("/").length;
}

function resolveImportedEntryAbsolutePath(
  rootPathMap: Map<string, string>,
  relativePath: string,
) {
  const segments = normalizeExplorerImportRelativePath(relativePath).split("/");
  const rootAbsolutePath = rootPathMap.get(segments[0]);
  if (!rootAbsolutePath) {
    throw new Error(`Missing import root for ${relativePath}`);
  }

  if (segments.length === 1) {
    return rootAbsolutePath;
  }

  return path.join(rootAbsolutePath, ...segments.slice(1));
}

async function importExternalExplorerEntries(
  destinationDirectoryPath: string,
  entries: unknown,
  workspaceId?: string | null,
): Promise<ExplorerExternalImportResultPayload> {
  const normalizedEntries = normalizeExplorerImportEntries(entries);
  const { absolutePath: destinationAbsolutePath, workspaceRoot } =
    await resolveWorkspaceScopedExplorerPath(
      destinationDirectoryPath,
      workspaceId,
    );
  const destinationStat = await fs.stat(destinationAbsolutePath);
  if (!destinationStat.isDirectory()) {
    throw new Error("Destination is not a directory.");
  }

  const rootNames: string[] = [];
  for (const entry of normalizedEntries) {
    const [rootName = ""] = normalizeExplorerImportRelativePath(
      entry.relativePath,
    ).split("/");
    if (rootName && !rootNames.includes(rootName)) {
      rootNames.push(rootName);
    }
  }

  const rootPathMap = new Map<string, string>();
  for (const rootName of rootNames) {
    const nextRootAbsolutePath = await nextAvailableExplorerCreatePath(
      destinationAbsolutePath,
      rootName,
    );
    if (workspaceRoot && !isPathWithinRoot(workspaceRoot, nextRootAbsolutePath)) {
      throw new Error("Imported path escapes workspace root.");
    }
    rootPathMap.set(rootName, nextRootAbsolutePath);
  }

  const directoryEntries = normalizedEntries
    .filter(
      (
        entry,
      ): entry is Extract<ExplorerExternalImportEntryPayload, { kind: "directory" }> =>
        entry.kind === "directory",
    )
    .sort((left, right) => importedEntryDepth(left.relativePath) - importedEntryDepth(right.relativePath));
  for (const directoryEntry of directoryEntries) {
    const absolutePath = resolveImportedEntryAbsolutePath(
      rootPathMap,
      directoryEntry.relativePath,
    );
    if (workspaceRoot && !isPathWithinRoot(workspaceRoot, absolutePath)) {
      throw new Error("Imported path escapes workspace root.");
    }
    await fs.mkdir(absolutePath, { recursive: true });
  }

  const fileEntries = normalizedEntries
    .filter(
      (
        entry,
      ): entry is Extract<ExplorerExternalImportEntryPayload, { kind: "file" }> =>
        entry.kind === "file",
    )
    .sort((left, right) => importedEntryDepth(left.relativePath) - importedEntryDepth(right.relativePath));
  for (const fileEntry of fileEntries) {
    const absolutePath = resolveImportedEntryAbsolutePath(
      rootPathMap,
      fileEntry.relativePath,
    );
    if (workspaceRoot && !isPathWithinRoot(workspaceRoot, absolutePath)) {
      throw new Error("Imported path escapes workspace root.");
    }
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, Buffer.from(fileEntry.content));
  }

  return {
    absolutePaths: rootNames
      .map((rootName) => rootPathMap.get(rootName) ?? "")
      .filter(Boolean),
  };
}

async function renameExplorerPath(
  targetPath: string,
  nextName: string,
  workspaceId?: string | null,
): Promise<FileSystemMutationPayload> {
  const trimmedName = nextName.trim();
  if (!trimmedName) {
    throw new Error("Name cannot be empty.");
  }
  if (
    trimmedName === "." ||
    trimmedName === ".." ||
    trimmedName.includes("/") ||
    trimmedName.includes("\\")
  ) {
    throw new Error("Name must not contain path separators.");
  }

  const { absolutePath, workspaceRoot } =
    await resolveWorkspaceScopedExplorerPath(targetPath, workspaceId);

  if (
    workspaceRoot &&
    path.normalize(absolutePath) === path.normalize(workspaceRoot)
  ) {
    throw new Error("Workspace root cannot be renamed.");
  }
  assertWorkspaceExplorerPathModifiable(workspaceRoot, absolutePath);

  const nextAbsolutePath = path.join(path.dirname(absolutePath), trimmedName);
  if (path.normalize(nextAbsolutePath) === path.normalize(absolutePath)) {
    return { absolutePath };
  }

  if (workspaceRoot && !isPathWithinRoot(workspaceRoot, nextAbsolutePath)) {
    throw new Error("Renamed path escapes workspace root.");
  }
  await ensureExplorerPathDoesNotExist(nextAbsolutePath);

  await fs.rename(absolutePath, nextAbsolutePath);
  await rewriteExplorerBookmarksAfterPathChange(absolutePath, nextAbsolutePath);

  return {
    absolutePath: nextAbsolutePath,
  };
}

async function moveExplorerPath(
  sourcePath: string,
  destinationDirectoryPath: string,
  workspaceId?: string | null,
): Promise<FileSystemMutationPayload> {
  const { absolutePath: sourceAbsolutePath, workspaceRoot } =
    await resolveWorkspaceScopedExplorerPath(sourcePath, workspaceId);
  const { absolutePath: destinationAbsolutePath } =
    await resolveWorkspaceScopedExplorerPath(
      destinationDirectoryPath,
      workspaceId,
    );

  if (
    workspaceRoot &&
    path.normalize(sourceAbsolutePath) === path.normalize(workspaceRoot)
  ) {
    throw new Error("Workspace root cannot be moved.");
  }
  assertWorkspaceExplorerPathModifiable(workspaceRoot, sourceAbsolutePath);
  assertWorkspaceExplorerPathModifiable(workspaceRoot, destinationAbsolutePath);

  const sourceStat = await fs.stat(sourceAbsolutePath);
  const destinationStat = await fs.stat(destinationAbsolutePath);
  if (!destinationStat.isDirectory()) {
    throw new Error("Destination is not a directory.");
  }
  if (
    sourceStat.isDirectory() &&
    isSameOrDescendantPath(sourceAbsolutePath, destinationAbsolutePath)
  ) {
    throw new Error("Cannot move a folder into itself.");
  }

  if (
    path.normalize(path.dirname(sourceAbsolutePath)) ===
    path.normalize(destinationAbsolutePath)
  ) {
    return {
      absolutePath: sourceAbsolutePath,
    };
  }

  const nextAbsolutePath = await nextAvailableExplorerCreatePath(
    destinationAbsolutePath,
    path.basename(sourceAbsolutePath),
  );
  if (workspaceRoot && !isPathWithinRoot(workspaceRoot, nextAbsolutePath)) {
    throw new Error("Moved path escapes workspace root.");
  }

  await ensureExplorerPathDoesNotExist(nextAbsolutePath);
  await fs.rename(sourceAbsolutePath, nextAbsolutePath);
  await rewriteExplorerBookmarksAfterPathChange(
    sourceAbsolutePath,
    nextAbsolutePath,
  );

  return {
    absolutePath: nextAbsolutePath,
  };
}

async function copyExplorerPath(
  sourcePath: string,
  destinationDirectoryPath: string,
  workspaceId?: string | null,
): Promise<FileSystemMutationPayload> {
  const { absolutePath: sourceAbsolutePath, workspaceRoot } =
    await resolveWorkspaceScopedExplorerPath(sourcePath, workspaceId);
  const { absolutePath: destinationAbsolutePath } =
    await resolveWorkspaceScopedExplorerPath(
      destinationDirectoryPath,
      workspaceId,
    );

  const sourceStat = await fs.stat(sourceAbsolutePath);
  const destinationStat = await fs.stat(destinationAbsolutePath);
  if (!destinationStat.isDirectory()) {
    throw new Error("Destination is not a directory.");
  }
  if (
    workspaceRoot &&
    path.normalize(sourceAbsolutePath) === path.normalize(workspaceRoot)
  ) {
    throw new Error("Workspace root cannot be copied.");
  }
  assertWorkspaceExplorerPathModifiable(workspaceRoot, destinationAbsolutePath);
  if (
    sourceStat.isDirectory() &&
    isSameOrDescendantPath(sourceAbsolutePath, destinationAbsolutePath)
  ) {
    throw new Error("Cannot copy a folder into itself.");
  }

  const nextAbsolutePath = await nextAvailableExplorerCreatePath(
    destinationAbsolutePath,
    path.basename(sourceAbsolutePath),
  );
  if (workspaceRoot && !isPathWithinRoot(workspaceRoot, nextAbsolutePath)) {
    throw new Error("Copied path escapes workspace root.");
  }

  await fs.cp(sourceAbsolutePath, nextAbsolutePath, {
    recursive: sourceStat.isDirectory(),
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });

  return {
    absolutePath: nextAbsolutePath,
  };
}

async function deleteExplorerPath(
  targetPath: string,
  workspaceId?: string | null,
): Promise<{ deleted: boolean }> {
  const { absolutePath, workspaceRoot } =
    await resolveWorkspaceScopedExplorerPath(targetPath, workspaceId);

  if (
    workspaceRoot &&
    path.normalize(absolutePath) === path.normalize(workspaceRoot)
  ) {
    throw new Error("Workspace root cannot be deleted.");
  }
  assertWorkspaceExplorerPathModifiable(workspaceRoot, absolutePath);

  const stat = await fs.stat(absolutePath);
  if (stat.isDirectory()) {
    await fs.rm(absolutePath, { recursive: true, force: false });
  } else {
    await fs.unlink(absolutePath);
  }

  const nextBookmarks = fileBookmarks.filter(
    (bookmark) => !isSameOrDescendantPath(absolutePath, bookmark.targetPath),
  );
  if (nextBookmarks.length !== fileBookmarks.length) {
    await persistUpdatedFileBookmarks(nextBookmarks);
  }

  return { deleted: true };
}

async function revealExplorerPath(
  targetPath: string,
  workspaceId?: string | null,
): Promise<{ revealed: boolean }> {
  const { absolutePath } = await resolveWorkspaceScopedExplorerPath(
    targetPath,
    workspaceId,
  );
  if (!(await fileExists(absolutePath))) {
    throw new Error("Target path no longer exists.");
  }
  shell.showItemInFolder(absolutePath);
  return { revealed: true };
}

async function exportExplorerPathToFile(
  targetPath: string,
  workspaceId: string | null | undefined,
  payload?: { content?: string; suggestedName?: string },
): Promise<{ path: string | null; canceled: boolean }> {
  const { absolutePath } = await resolveWorkspaceScopedExplorerPath(
    targetPath,
    workspaceId,
  );
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) {
    throw new Error("Only files can be exported.");
  }

  const sourceBaseName = path.basename(absolutePath);
  const suggestedName = payload?.suggestedName?.trim() || sourceBaseName;
  const downloadsDir = app.getPath("downloads");
  const ownerWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? null;
  const options: SaveDialogOptions = {
    title: "Export file",
    defaultPath: path.join(downloadsDir, suggestedName),
    buttonLabel: "Export",
  };
  const result = ownerWindow
    ? await dialog.showSaveDialog(ownerWindow, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) {
    return { path: null, canceled: true };
  }

  const destination = path.resolve(result.filePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (typeof payload?.content === "string") {
    await fs.writeFile(destination, payload.content, "utf-8");
  } else {
    await fs.copyFile(absolutePath, destination);
  }
  return { path: destination, canceled: false };
}

const CONTENT_SECURITY_POLICY_META_PATTERN =
  /<meta\b[^>]*http-equiv=(["'])content-security-policy\1[^>]*>/gi;
const HTML_PDF_RENDER_SETTLE_TIMEOUT_MS = 15_000;

function htmlPdfSuggestedFileName(rawName: string | null | undefined): string {
  const trimmed = (rawName ?? "").trim();
  const segments = trimmed
    .split(/[/\\]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const leafName = segments.length > 0 ? segments[segments.length - 1] : "";
  if (!leafName) {
    return "export.pdf";
  }
  return leafName.replace(/\.[^./\\]+$/u, "") + ".pdf";
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function htmlPdfBaseHrefFromPath(
  absolutePath: string | null | undefined,
): string | null {
  const trimmed = (absolutePath ?? "").trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    return null;
  }
  const href = pathToFileURL(path.dirname(trimmed)).toString();
  return href.endsWith("/") ? href : `${href}/`;
}

function prepareHtmlForPdfExport(
  rawHtml: string,
  baseHref: string | null,
): string {
  const sanitizedHtml = rawHtml.replace(
    CONTENT_SECURITY_POLICY_META_PATTERN,
    "",
  );
  const baseTag =
    baseHref && !/<base\b[^>]*>/i.test(sanitizedHtml)
      ? `<base href="${escapeHtmlAttribute(baseHref)}">`
      : "";

  if (/<head\b[^>]*>/i.test(sanitizedHtml)) {
    return sanitizedHtml.replace(
      /<head\b([^>]*)>/i,
      `<head$1>${baseTag}`,
    );
  }
  if (/<html\b[^>]*>/i.test(sanitizedHtml)) {
    return sanitizedHtml.replace(
      /<html\b([^>]*)>/i,
      `<html$1><head>${baseTag}</head>`,
    );
  }
  return `<!doctype html><html><head>${baseTag}</head><body>${sanitizedHtml}</body></html>`;
}

async function waitForHtmlPdfRender(contents: WebContents): Promise<void> {
  if (contents.isLoading()) {
    await new Promise<void>((resolve) => {
      contents.once("did-stop-loading", () => resolve());
    });
  }

  await Promise.race([
    contents
      .executeJavaScript(`
        new Promise((resolve) => {
          const waitForImages = Promise.all(
            Array.from(document.images ?? []).map((image) => {
              if (image.complete) {
                return Promise.resolve();
              }
              return new Promise((done) => {
                const finish = () => done(null);
                image.addEventListener("load", finish, { once: true });
                image.addEventListener("error", finish, { once: true });
              });
            }),
          );
          const waitForFonts =
            document.fonts?.ready?.catch(() => undefined) ?? Promise.resolve();
          Promise.all([waitForImages, waitForFonts])
            .catch(() => undefined)
            .finally(() => {
              requestAnimationFrame(() => {
                requestAnimationFrame(() => resolve(null));
              });
            });
        });
      `)
      .catch(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(() => resolve(), HTML_PDF_RENDER_SETTLE_TIMEOUT_MS);
    }),
  ]);
}

async function exportHtmlToPdf(
  payload: HtmlToPdfExportRequestPayload,
): Promise<{ path: string | null; canceled: boolean }> {
  const html = payload.html ?? "";
  if (!html.trim()) {
    throw new Error("HTML content is empty.");
  }

  const suggestedName = htmlPdfSuggestedFileName(payload.suggestedName);
  const downloadsDir = app.getPath("downloads");
  const ownerWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? null;
  const options: SaveDialogOptions = {
    title: "Export PDF",
    defaultPath: path.join(downloadsDir, suggestedName),
    buttonLabel: "Export PDF",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  };
  const result = ownerWindow
    ? await dialog.showSaveDialog(ownerWindow, options)
    : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) {
    return { path: null, canceled: true };
  }

  const destination = path.resolve(result.filePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });

  const renderWindow = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  renderWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  let tempDirPath = "";
  try {
    tempDirPath = await fs.mkdtemp(
      path.join(app.getPath("temp"), "holaboss-html-pdf-"),
    );
    const tempHtmlPath = path.join(tempDirPath, "index.html");
    await fs.writeFile(
      tempHtmlPath,
      prepareHtmlForPdfExport(
        html,
        htmlPdfBaseHrefFromPath(payload.basePath),
      ),
      "utf-8",
    );
    await renderWindow.loadFile(tempHtmlPath);
    await waitForHtmlPdfRender(renderWindow.webContents);
    const pdfBuffer = await renderWindow.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
    });
    await fs.writeFile(destination, pdfBuffer);
  } finally {
    if (!renderWindow.isDestroyed()) {
      renderWindow.destroy();
    }
    if (tempDirPath) {
      await fs.rm(tempDirPath, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  return { path: destination, canceled: false };
}

async function listDirectory(
  targetPath?: string | null,
  workspaceId?: string | null,
): Promise<DirectoryPayload> {
  const { absolutePath: resolvedPath, workspaceRoot } =
    await resolveWorkspaceScopedExplorerPath(targetPath, workspaceId);
  await fs.mkdir(resolvedPath, { recursive: true });
  const stat = await fs.stat(resolvedPath);

  if (!stat.isDirectory()) {
    throw new Error("Target path is not a directory.");
  }

  const normalizedCurrent = path.normalize(resolvedPath);
  const normalizedRoot = path.normalize(
    workspaceRoot ? workspaceRoot : path.parse(resolvedPath).root,
  );
  const hideWorkspaceManagedRootEntries = normalizedCurrent === normalizedRoot;
  const dirEntries = await fs.readdir(resolvedPath, { withFileTypes: true });
  const entries: DirectoryEntryPayload[] = [];

  for (const dirEntry of dirEntries) {
    if (dirEntry.name.startsWith(".")) {
      continue;
    }
    const absolutePath = path.join(resolvedPath, dirEntry.name);
    if (
      hideWorkspaceManagedRootEntries &&
      dirEntry.isDirectory() &&
      dirEntry.name === "apps"
    ) {
      continue;
    }
    if (
      hideWorkspaceManagedRootEntries &&
      describeProtectedWorkspaceExplorerPath(workspaceRoot, absolutePath)
    ) {
      continue;
    }
    try {
      const meta = await fs.stat(absolutePath);
      entries.push({
        name: dirEntry.name,
        absolutePath,
        isDirectory: meta.isDirectory(),
        size: meta.isDirectory() ? 0 : meta.size,
        modifiedAt: meta.mtime.toISOString(),
      });
    } catch {
      continue;
    }
  }

  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  const parentPath =
    normalizedCurrent === normalizedRoot
      ? null
      : path.dirname(normalizedCurrent);

  return {
    currentPath: normalizedCurrent,
    parentPath,
    entries,
  };
}

function emitFileBookmarksState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("fs:bookmarks", fileBookmarks);
}

function emitFilePreviewChanged(payload: FilePreviewChangePayload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("fs:fileChanged", payload);
}

function closeFilePreviewWatchSubscription(subscriptionId: string) {
  const subscription = filePreviewWatchSubscriptions.get(subscriptionId);
  if (!subscription) {
    return;
  }
  filePreviewWatchSubscriptions.delete(subscriptionId);
  try {
    subscription.watcher.close();
  } catch {
    // Ignore watcher shutdown errors during cleanup.
  }
}

function closeAllFilePreviewWatchSubscriptions() {
  for (const subscriptionId of Array.from(
    filePreviewWatchSubscriptions.keys(),
  )) {
    closeFilePreviewWatchSubscription(subscriptionId);
  }
}

function createAuthPopupHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Account</title>
    <style>
      * { box-sizing: border-box; }
      html,
      body {
        margin: 0;
        height: 100vh;
        background: transparent;
        color: var(--popup-text);
        overflow: hidden;
      }
      @keyframes auth-popup-enter {
        from {
          opacity: 0;
          transform: translateY(-8px) scale(0.975);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }
      .panel {
        margin: ${AUTH_POPUP_MARGIN_PX}px;
        max-height: calc(100vh - ${AUTH_POPUP_MARGIN_PX * 2}px);
        border-radius: 26px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        transform-origin: top right;
        will-change: transform, opacity;
      }
      body.popup-opening .panel {
        animation: auth-popup-enter 180ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      @media (prefers-reduced-motion: reduce) {
        body.popup-opening .panel {
          animation: none;
        }
      }
      .profile {
        padding: 18px;
        border-bottom: 1px solid var(--popup-border-soft);
      }
      .profileRow {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .avatar {
        flex: 0 0 auto;
        width: 46px;
        height: 46px;
        border-radius: 999px;
        display: grid;
        place-items: center;
        font-size: 18px;
        font-weight: 600;
      }
      .identityWrap {
        min-width: 0;
        flex: 1 1 auto;
      }
      .identityName {
        font-size: 15px;
        font-weight: 600;
      }
      .identity {
        margin-top: 4px;
        font-size: 12px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .badge {
        flex: 0 0 auto;
        border-radius: 999px;
        padding: 8px 11px;
        font-size: 10px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .runtimeLine {
        margin-top: 14px;
        border-radius: 16px;
        border: 1px solid var(--popup-border-soft);
        background: color-mix(in srgb, var(--popup-control-bg) 68%, transparent);
        padding: 12px 14px;
      }
      .runtimeLabel {
        font-size: 10px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--popup-text-subtle);
      }
      .runtimeValue {
        margin-top: 6px;
        font-size: 12px;
        line-height: 1.5;
        color: var(--popup-text);
      }
      .content {
        flex: 1 1 auto;
        min-height: 0;
        display: grid;
        gap: 12px;
        overflow-y: auto;
        padding: 12px;
      }
      .button {
        width: 100%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        border-radius: 16px;
        border: 1px solid var(--popup-border-soft);
        padding: 12px 14px;
        font-size: 12px;
        cursor: pointer;
        transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
      }
      .button:disabled,
      .menuItem:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }
      .message {
        margin: 0;
        border-radius: 16px;
        border: 1px solid var(--popup-border-soft);
        padding: 12px 14px;
        font-size: 11px;
        line-height: 1.6;
      }
      .menuSection {
        display: grid;
        gap: 6px;
      }
      .menuSection + .menuSection {
        padding-top: 10px;
        border-top: 1px solid var(--popup-border-soft);
      }
      .menuItem {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        border-radius: 18px;
        border: 1px solid transparent;
        background: transparent;
        padding: 11px 12px;
        text-align: left;
        color: var(--popup-text);
        cursor: pointer;
        transition: background 140ms ease, border-color 140ms ease, color 140ms ease, transform 140ms ease;
      }
      .menuItem:hover {
        border-color: var(--popup-border-soft);
        background: color-mix(in srgb, var(--popup-control-bg) 72%, transparent);
      }
      .menuLead {
        min-width: 0;
        flex: 1 1 auto;
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .menuIcon {
        width: 36px;
        height: 36px;
        flex: 0 0 auto;
        display: grid;
        place-items: center;
        border-radius: 12px;
        border: 1px solid var(--popup-border-soft);
        background: color-mix(in srgb, var(--popup-control-bg) 85%, transparent);
        color: var(--popup-text-muted);
      }
      .menuIcon svg {
        width: 17px;
        height: 17px;
        stroke: currentColor;
        fill: none;
        stroke-width: 1.85;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .menuCopy {
        min-width: 0;
        flex: 1 1 auto;
      }
      .menuTitle {
        display: block;
        font-size: 13px;
        font-weight: 600;
      }
      .menuMeta {
        display: block;
        margin-top: 3px;
        font-size: 10px;
        line-height: 1.35;
        color: var(--popup-text-subtle);
      }
      .menuArrow {
        flex: 0 0 auto;
        font-size: 16px;
        color: var(--popup-text-subtle);
      }
      .menuItem:not(.detailed) .menuTitle {
        font-size: 12.5px;
        font-weight: 500;
      }
      .menuItem:not(.detailed) .menuCopy {
        display: flex;
        align-items: center;
      }
      .menuItem.danger {
        color: var(--popup-error);
      }
      .menuItem.danger .menuIcon {
        border-color: color-mix(in srgb, var(--popup-error) 28%, var(--popup-border-soft));
        background: color-mix(in srgb, var(--popup-error) 10%, transparent);
        color: var(--popup-error);
      }
      .menuItem.danger .menuMeta,
      .menuItem.danger .menuArrow {
        color: color-mix(in srgb, var(--popup-error) 70%, var(--popup-text-subtle));
      }
      .menuItem[hidden],
      .button[hidden],
      .message[hidden] {
        display: none !important;
      }
      ${popupThemeCss()}
    </style>
  </head>
  <body>
    <div id="panel" class="panel">
      <div class="profile">
        <div class="profileRow">
          <div id="avatar" class="avatar">H</div>
          <div class="identityWrap">
            <div id="identityName" class="identityName">holaOS account</div>
            <div id="identity" class="identity">Loading session...</div>
          </div>
          <div id="badge" class="badge idle">Checking</div>
        </div>

        <div class="runtimeLine">
          <div class="runtimeLabel">Desktop status</div>
          <div id="runtimeValue" class="runtimeValue">Checking local runtime connection...</div>
        </div>
      </div>

      <div class="content">
        <button id="signIn" class="button primary" type="button">Sign in with browser</button>
        <div id="notice" class="message success" hidden></div>

        <div class="menuSection">
          <button id="accountAction" class="item menuItem detailed" type="button">
            <span class="menuLead">
              <span class="menuIcon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M19 21a7 7 0 0 0-14 0"/><circle cx="12" cy="8" r="4"/></svg>
              </span>
              <span class="menuCopy">
                <span class="menuTitle">Account</span>
                <span id="accountMeta" class="menuMeta">Connected</span>
              </span>
            </span>
            <span class="menuArrow">&#8250;</span>
          </button>
          <button id="settingsAction" class="item menuItem" type="button">
            <span class="menuLead">
              <span class="menuIcon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M4 7h10"/><path d="M4 17h16"/><path d="M14 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/><path d="M10 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/></svg>
              </span>
              <span class="menuCopy">
                <span class="menuTitle">Settings</span>
              </span>
            </span>
            <span class="menuArrow">&#8250;</span>
          </button>
          <button id="homeAction" class="item menuItem" type="button">
            <span class="menuLead">
              <span class="menuIcon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="m3 10 9-7 9 7"/><path d="M5 9.5V20h14V9.5"/><path d="M9 20v-6h6v6"/></svg>
              </span>
              <span class="menuCopy">
                <span class="menuTitle">Homepage</span>
              </span>
            </span>
            <span class="menuArrow">&#8250;</span>
          </button>
          <button id="docsAction" class="item menuItem" type="button">
            <span class="menuLead">
              <span class="menuIcon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M6 4.5h9a3 3 0 0 1 3 3V20l-4-2-4 2-4-2-4 2V7.5a3 3 0 0 1 3-3Z"/></svg>
              </span>
              <span class="menuCopy">
                <span class="menuTitle">Docs</span>
              </span>
            </span>
            <span class="menuArrow">&#8250;</span>
          </button>
          <button id="helpAction" class="item menuItem" type="button">
            <span class="menuLead">
              <span class="menuIcon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 1 1 5.8 1c0 2-3 2-3 4"/><path d="M12 17h.01"/></svg>
              </span>
              <span class="menuCopy">
                <span class="menuTitle">Get help</span>
              </span>
            </span>
            <span class="menuArrow">&#8250;</span>
          </button>
        </div>

        <div class="menuSection">
          <button id="signOut" class="menuItem danger" type="button">
            <span class="menuLead">
              <span class="menuIcon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M20 19V5"/></svg>
              </span>
              <span class="menuCopy">
                <span class="menuTitle">Sign out</span>
              </span>
            </span>
            <span class="menuArrow">&#8250;</span>
          </button>
        </div>
      </div>
    </div>
    <script>
      const LINKS = {
        home: ${JSON.stringify(HOLABOSS_HOME_URL)},
        docs: ${JSON.stringify(HOLABOSS_DOCS_URL)},
        help: ${JSON.stringify(HOLABOSS_HELP_URL)}
      };

      const state = {
        user: null,
        runtimeConfig: null,
        runtimeStatus: null,
        isPending: true,
        isStartingSignIn: false,
        isSigningOut: false,
        authError: "",
        authMessage: ""
      };

      const els = {
        panel: document.getElementById("panel"),
        avatar: document.getElementById("avatar"),
        identityName: document.getElementById("identityName"),
        identity: document.getElementById("identity"),
        badge: document.getElementById("badge"),
        runtimeValue: document.getElementById("runtimeValue"),
        notice: document.getElementById("notice"),
        signIn: document.getElementById("signIn"),
        signOut: document.getElementById("signOut"),
        accountAction: document.getElementById("accountAction"),
        accountMeta: document.getElementById("accountMeta"),
        settingsAction: document.getElementById("settingsAction"),
        homeAction: document.getElementById("homeAction"),
        docsAction: document.getElementById("docsAction"),
        helpAction: document.getElementById("helpAction")
      };

      const sessionUserId = (user) => user && typeof user.id === "string" ? user.id : "";
      const sessionEmail = (user) => user && typeof user.email === "string" ? user.email : "";
      const sessionDisplayName = (user) => user && typeof user.name === "string" ? user.name.trim() : "";
      const sessionInitials = (user) => {
        const name = sessionDisplayName(user);
        if (name) {
          const initials = name
            .split(/\\s+/)
            .map((part) => part[0] || "")
            .join("")
            .slice(0, 2)
            .toUpperCase();
          if (initials) {
            return initials;
          }
        }
        const email = sessionEmail(user);
        return (email[0] || "H").toUpperCase();
      };

      const runtimeBindingReady = () => Boolean(state.runtimeConfig?.authTokenPresent)
        && Boolean((state.runtimeConfig?.sandboxId || "").trim())
        && Boolean((state.runtimeConfig?.modelProxyBaseUrl || "").trim());

      const runtimeStatusLabel = (isSignedIn) => {
        if (state.runtimeStatus?.status === "running") {
          return "Runtime connected and running.";
        }
        if (state.runtimeStatus?.status === "starting") {
          return "Runtime is starting.";
        }
        if (state.runtimeStatus?.status === "error") {
          return state.runtimeStatus?.lastError || "Runtime needs attention.";
        }
        if (runtimeBindingReady()) {
          return "Runtime connected and ready.";
        }
        return isSignedIn ? "Finishing runtime setup." : "Sign in to connect desktop features.";
      };

      const restartOpenAnimation = () => {
        document.body.classList.remove("popup-opening");
        void document.body.offsetWidth;
        document.body.classList.add("popup-opening");
      };

      const render = () => {
        const isSignedIn = Boolean(sessionUserId(state.user));
        const hasError = Boolean(state.authError);
        const ready = runtimeBindingReady();
        const badgeTone = hasError ? "error" : ready ? "ready" : isSignedIn ? "syncing" : "idle";
        const badgeLabel = state.isPending ? "Checking" : hasError ? "Needs help" : ready ? "Connected" : isSignedIn ? "Syncing" : "Signed out";
        const noticeText = state.authError || state.authMessage;

        els.avatar.textContent = sessionInitials(state.user);
        els.identityName.textContent = isSignedIn ? (sessionDisplayName(state.user) || "holaOS account") : "holaOS account";
        els.identity.textContent = isSignedIn ? (sessionEmail(state.user) || sessionUserId(state.user) || "Signed in") : "Not connected";
        els.badge.className = "badge " + badgeTone;
        els.badge.textContent = badgeLabel;
        els.runtimeValue.textContent = runtimeStatusLabel(isSignedIn);
        els.accountMeta.textContent = isSignedIn ? (ready ? "Connected" : "Syncing setup") : "Sign in required";

        els.signIn.hidden = isSignedIn;
        els.signIn.disabled = state.isStartingSignIn;
        els.signIn.textContent = state.isStartingSignIn ? "Opening sign-in..." : "Connect account";

        els.signOut.hidden = !isSignedIn;
        els.signOut.disabled = state.isSigningOut;
        els.notice.hidden = !noticeText;
        els.notice.className = "message " + (state.authError ? "error" : "success");
        els.notice.textContent = noticeText;
      };

      const closeAndScheduleNothing = () => {
        void window.authPopup.close();
      };

      const refreshSession = async () => {
        state.isPending = true;
        render();
        try {
          state.user = await window.authPopup.getUser();
          state.authError = "";
        } catch (error) {
          state.authError = error instanceof Error ? error.message : "Failed to refresh session.";
        } finally {
          state.isPending = false;
          render();
        }
      };

      const refreshConfig = async () => {
        try {
          state.runtimeConfig = await window.authPopup.getRuntimeConfig();
        } catch (error) {
          state.authError = error instanceof Error ? error.message : "Failed to load runtime config.";
        } finally {
          render();
        }
      };

      const refreshRuntimeStatus = async () => {
        try {
          state.runtimeStatus = await window.authPopup.getRuntimeStatus();
        } catch (error) {
          state.authError = error instanceof Error ? error.message : "Failed to load runtime status.";
        } finally {
          render();
        }
      };

      els.panel?.addEventListener("animationend", () => {
        document.body.classList.remove("popup-opening");
      });

      els.signIn.addEventListener("click", async () => {
        state.isStartingSignIn = true;
        state.authError = "";
        state.authMessage = "";
        render();
        try {
          await window.authPopup.requestAuth();
          state.authMessage = "Sign-in opened in your browser. Finish the flow there to connect this desktop.";
        } catch (error) {
          state.authError = error instanceof Error ? error.message : "Failed to start sign-in.";
        } finally {
          state.isStartingSignIn = false;
          render();
        }
      });

      els.signOut.addEventListener("click", async () => {
        state.isSigningOut = true;
        state.authError = "";
        state.authMessage = "";
        render();
        try {
          await window.authPopup.signOut();
          state.user = null;
          state.runtimeConfig = null;
          state.authMessage = "Signed out from this desktop session.";
        } catch (error) {
          state.authError = error instanceof Error ? error.message : "Failed to sign out.";
        } finally {
          state.isSigningOut = false;
          render();
        }
      });

      els.accountAction.addEventListener("click", async () => {
        await window.authPopup.openSettingsPane("account");
        closeAndScheduleNothing();
      });
      els.settingsAction.addEventListener("click", async () => {
        await window.authPopup.openSettingsPane("settings");
        closeAndScheduleNothing();
      });
      els.homeAction.addEventListener("click", async () => {
        await window.authPopup.openExternalUrl(LINKS.home);
        closeAndScheduleNothing();
      });
      els.docsAction.addEventListener("click", async () => {
        await window.authPopup.openExternalUrl(LINKS.docs);
        closeAndScheduleNothing();
      });
      els.helpAction.addEventListener("click", async () => {
        await window.authPopup.openExternalUrl(LINKS.help);
        closeAndScheduleNothing();
      });

      window.authPopup.onAuthenticated((user) => {
        state.user = user;
        state.isPending = false;
        state.authError = "";
        state.authMessage = "Desktop account connected.";
        void refreshConfig();
        void refreshRuntimeStatus();
        render();
      });

      window.authPopup.onUserUpdated((user) => {
        state.user = user;
        state.isPending = false;
        state.authError = "";
        render();
      });

      window.authPopup.onError((payload) => {
        state.isPending = false;
        state.authError = payload?.message || ((payload?.status || "") + " " + (payload?.statusText || "")).trim() || "Authentication failed.";
        render();
      });

      window.authPopup.onRuntimeConfigChange((config) => {
        state.runtimeConfig = config;
        render();
      });

      window.authPopup.onRuntimeStateChange((runtimeStatus) => {
        state.runtimeStatus = runtimeStatus;
        render();
      });

      window.authPopup.onOpened(() => {
        restartOpenAnimation();
      });

      Promise.all([refreshSession(), refreshConfig(), refreshRuntimeStatus()]).then(() => render());
    </script>
  </body>
</html>`;
}

function shouldTrackHistoryUrl(rawUrl: string) {
  return shouldTrackHistoryUrlUtil(rawUrl);
}

// recordHistoryVisit moved to browser-pane/tab-state.ts.

function browserWorkspaceSnapshot(
  workspaceId?: string | null,
  space?: BrowserSpaceId | null,
  sessionId?: string | null,
  options?: {
    useVisibleAgentSession?: boolean;
  },
): BrowserTabListPayload {
  const browserSpace = browserSpaceId(space);
  const workspace = browserWorkspaceOrEmpty(workspaceId);
  if (!workspace) {
    return emptyBrowserTabListPayload(browserSpace);
  }
  const normalizedSessionId = browserSessionId(sessionId);
  const tabSpace = browserTabSpaceState(
    workspace,
    browserSpace,
    normalizedSessionId,
    options,
  );
  const tabs = browserTabSpaceStates(tabSpace);
  const visibleSessionId =
    browserSpace === "agent" && options?.useVisibleAgentSession
      ? browserVisibleAgentSessionId(workspace)
      : "";
  const resolvedSessionId =
    browserSpace === "agent"
      ? normalizedSessionId ||
        (visibleSessionId &&
        browserAgentSessionSpaceState(workspace, visibleSessionId) === tabSpace
          ? visibleSessionId
          : "")
      : "";
  const lockSessionId =
    browserSpace === "user" ? activeUserBrowserLock(workspace)?.sessionId ?? "" : "";
  return {
    space: browserSpace,
    activeTabId: tabSpace?.activeTabId || tabs[0]?.id || "",
    tabs,
    tabCounts: browserWorkspaceTabCounts(workspace),
    sessionId: resolvedSessionId || null,
    lifecycleState:
      browserSpace === "agent" ? tabSpace?.lifecycleState ?? null : null,
    controlMode:
      browserSpace === "user"
        ? lockSessionId
          ? "user_locked"
          : "none"
        : resolvedSessionId
          ? "session_owned"
          : "none",
    controlSessionId:
      browserSpace === "user"
        ? lockSessionId || null
        : resolvedSessionId || null,
  };
}

// getActiveBrowserTab moved to browser-pane/tab-state.ts.

// activeVisibleBrowserTarget moved to browser-pane/tab-state.ts.

// currentBrowserTabPageTitle moved to browser-pane/tab-state.ts.

// currentBrowserTabUrl moved to browser-pane/tab-state.ts.

function reserveMainWindowClosedListenerBudget(additionalClosedListeners = 0) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  // Electron's deprecated BrowserView compatibility layer adds a fresh
  // BrowserWindow "closed" listener every time a view is attached, and those
  // listeners are not released when the view is detached.
  const desiredBudget = Math.max(
    MAIN_WINDOW_MIN_LISTENER_BUDGET,
    mainWindow.listenerCount("closed") +
      additionalClosedListeners +
      MAIN_WINDOW_CLOSED_LISTENER_BUFFER,
  );
  if (mainWindow.getMaxListeners() < desiredBudget) {
    mainWindow.setMaxListeners(desiredBudget);
  }
}

// applyBoundsToTab moved to browser-pane/tab-state.ts.

// hasVisibleBrowserBounds moved to browser-pane/tab-state.ts.

// emitBrowserState moved to browser-pane/tab-state.ts.

// emitHistoryState moved to browser-pane/tab-state.ts.

// closeBrowserTabRecord moved to browser-pane/tab-state.ts.

function destroyBrowserWorkspace(workspaceId: string) {
  const workspace = browserWorkspaceFromMap(workspaceId);
  if (!workspace) {
    return;
  }
  for (const browserSpace of BROWSER_SPACE_IDS) {
    clearBrowserTabSpaceSuspendTimer(workspace.spaces[browserSpace]);
    for (const tab of workspace.spaces[browserSpace].tabs.values()) {
      closeBrowserTabRecord(tab);
    }
    workspace.spaces[browserSpace].tabs.clear();
  }
  for (const tabSpace of workspace.agentSessionSpaces.values()) {
    clearBrowserTabSpaceSuspendTimer(tabSpace);
    for (const tab of tabSpace.tabs.values()) {
      closeBrowserTabRecord(tab);
    }
    tabSpace.tabs.clear();
  }
  workspace.userBrowserLock = null;
  workspace.agentSessionSpaces.clear();
  sessionRuntimeStateCache.delete(workspaceId);
  agentSessionCache.delete(workspaceId);
  browserWorkspaces.delete(workspaceId);
}

// updateAttachedBrowserView moved to browser-pane/tab-state.ts.

// syncBrowserState moved to browser-pane/tab-state.ts.

function normalizeBrowserPopupFrameName(frameName?: string | null): string {
  return normalizeBrowserPopupFrameNameUtil(frameName);
}

function isBrowserPopupWindowRequest(
  frameName?: string | null,
  features?: string | null,
): boolean {
  return isBrowserPopupWindowRequestUtil(frameName, features);
}

// focusBrowserTabInSpace moved to browser-pane/tab-state.ts.

// handleBrowserWindowOpenAsTab moved to browser-pane/tab-state.ts.

// browserContextSuggestedFilename moved to browser-pane/tab-state.ts.

// queueBrowserDownloadPrompt moved to browser-pane/tab-state.ts.

// consumeBrowserDownloadOverride moved to browser-pane/tab-state.ts.

// showBrowserViewContextMenu moved to browser-pane/tab-state.ts.

// createBrowserTab moved to browser-pane/tab-state.ts.

// initialBrowserTabSeed moved to browser-pane/tab-state.ts.

// ensureBrowserTabSpaceInitialized moved to browser-pane/tab-state.ts.

async function ensureBrowserWorkspace(
  workspaceId?: string | null,
  space?: BrowserSpaceId | null,
  sessionId?: string | null,
): Promise<BrowserWorkspaceState | null> {
  const normalizedWorkspaceId =
    typeof workspaceId === "string"
      ? workspaceId.trim()
      : activeBrowserWorkspaceId;
  const browserSpace = browserSpaceId(space);
  const normalizedSessionId = browserSessionId(sessionId);
  if (!normalizedWorkspaceId) {
    return null;
  }

  const existing = browserWorkspaceFromMap(normalizedWorkspaceId);
  if (existing) {
    if (
      ensureBrowserTabSpaceInitialized(
        normalizedWorkspaceId,
        browserSpace,
        normalizedSessionId,
      )
    ) {
      void persistBrowserWorkspace(normalizedWorkspaceId);
    }
    if (browserSpace === "agent" && normalizedSessionId) {
      hydrateAgentSessionBrowserSpace(normalizedWorkspaceId, normalizedSessionId);
      seedVisibleAgentBrowserSession(existing, normalizedSessionId);
      touchAgentSessionBrowserSpace(normalizedWorkspaceId, normalizedSessionId);
    }
    return existing;
  }

  const workspace = createBrowserWorkspaceState(normalizedWorkspaceId);
  browserWorkspaces.set(normalizedWorkspaceId, workspace);
  ensureBrowserWorkspaceDownloadTracking(workspace);

  const persisted = await readJsonFile<BrowserWorkspacePersistencePayload>(
    browserWorkspaceStatePath(normalizedWorkspaceId),
    defaultBrowserWorkspacePersistence(),
  );
  workspace.bookmarks = Array.isArray(persisted.bookmarks)
    ? persisted.bookmarks
    : [];
  workspace.downloads = Array.isArray(persisted.downloads)
    ? persisted.downloads
    : [];
  workspace.history = Array.isArray(persisted.history) ? persisted.history : [];
  workspace.activeAgentSessionId =
    browserSessionId(persisted.activeAgentSessionId) || null;

  const persistedSpaces =
    persisted.spaces && typeof persisted.spaces === "object"
      ? persisted.spaces
      : {};

  for (const persistedSpace of BROWSER_SPACE_IDS) {
    const tabSpace = workspace.spaces[persistedSpace];
    const storedSpace =
      persistedSpaces[persistedSpace] &&
      typeof persistedSpaces[persistedSpace] === "object"
        ? persistedSpaces[persistedSpace]
        : null;
    const persistedTabs = Array.isArray(storedSpace?.tabs)
      ? storedSpace.tabs
      : persistedSpace === "user" && Array.isArray(persisted.tabs)
        ? persisted.tabs
        : [];
    for (const persistedTab of persistedTabs) {
      if (!persistedTab || typeof persistedTab !== "object") {
        continue;
      }
      createBrowserTab(normalizedWorkspaceId, {
        browserSpace: persistedSpace,
        id: typeof persistedTab.id === "string" ? persistedTab.id : undefined,
        url:
          typeof persistedTab.url === "string" && persistedTab.url.trim()
            ? persistedTab.url.trim()
            : HOME_URL,
        title:
          typeof persistedTab.title === "string"
            ? persistedTab.title
            : NEW_TAB_TITLE,
        faviconUrl:
          typeof persistedTab.faviconUrl === "string"
            ? persistedTab.faviconUrl
            : undefined,
        skipInitialHistoryRecord: true,
      });
    }

    const persistedActiveTabId =
      typeof storedSpace?.activeTabId === "string"
        ? storedSpace.activeTabId.trim()
        : persistedSpace === "user" && typeof persisted.activeTabId === "string"
          ? persisted.activeTabId.trim()
          : "";
    tabSpace.activeTabId = tabSpace.tabs.has(persistedActiveTabId)
      ? persistedActiveTabId
      : (Array.from(tabSpace.tabs.keys())[0] ?? "");
  }

  const persistedAgentSessions =
    persisted.agentSessions && typeof persisted.agentSessions === "object"
      ? persisted.agentSessions
      : {};
  for (const [persistedSessionId, storedTabSpace] of Object.entries(
    persistedAgentSessions,
  )) {
    const normalizedPersistedSessionId = browserSessionId(persistedSessionId);
    if (!normalizedPersistedSessionId) {
      continue;
    }
    const agentTabSpace = browserAgentSessionSpaceState(
      workspace,
      normalizedPersistedSessionId,
      { createIfMissing: true },
    );
    if (!agentTabSpace) {
      continue;
    }
    const persistedTabs = Array.isArray(storedTabSpace?.tabs)
      ? storedTabSpace.tabs.filter(
          (persistedTab): persistedTab is BrowserWorkspaceTabPersistencePayload =>
            Boolean(persistedTab) && typeof persistedTab === "object",
        )
      : [];
    const persistedActiveTabId =
      typeof storedTabSpace?.activeTabId === "string"
        ? storedTabSpace.activeTabId.trim()
        : "";
    agentTabSpace.activeTabId = persistedActiveTabId;
    agentTabSpace.persistedTabs = persistedTabs;
    agentTabSpace.lifecycleState =
      persistedTabs.length > 0 ? "suspended" : "active";
  }

  if (
    ensureBrowserTabSpaceInitialized(
      normalizedWorkspaceId,
      browserSpace,
      normalizedSessionId,
    )
  ) {
    void persistBrowserWorkspace(normalizedWorkspaceId);
  }
  if (browserSpace === "agent" && normalizedSessionId) {
    hydrateAgentSessionBrowserSpace(normalizedWorkspaceId, normalizedSessionId);
    seedVisibleAgentBrowserSession(workspace, normalizedSessionId);
    touchAgentSessionBrowserSpace(normalizedWorkspaceId, normalizedSessionId);
  }
  return workspace;
}

async function setActiveBrowserWorkspace(
  workspaceId: string | null | undefined,
  space?: BrowserSpaceId | null,
  sessionId?: string | null,
) {
  const previousWorkspaceId = activeBrowserWorkspaceId;
  const previousSpace = activeBrowserSpaceId;
  const previousSessionId = activeBrowserSessionId;
  const normalizedWorkspaceId =
    typeof workspaceId === "string" ? workspaceId.trim() : "";
  const browserSpace = browserSpaceId(space);
  const normalizedSessionId = browserSessionId(sessionId);
  activeBrowserWorkspaceId = normalizedWorkspaceId;
  activeBrowserSpaceId = browserSpace;
  activeBrowserSessionId = browserSpace === "agent" ? normalizedSessionId : "";
  if (!normalizedWorkspaceId) {
    if (previousSpace === "agent" && browserSessionId(previousSessionId)) {
      scheduleAgentSessionBrowserLifecycleCheck(
        previousWorkspaceId,
        previousSessionId,
        SESSION_BROWSER_BUSY_CHECK_MS,
      );
    }
    // Detach the previous workspace's BrowserView when the active workspace
    // clears (e.g. entering Workspace Control Center) — otherwise it keeps
    // painting over the new view at its old bounds.
    updateAttachedBrowserView();
    emitBrowserState();
    emitBookmarksState();
    emitDownloadsState();
    emitHistoryState();
    return emptyBrowserTabListPayload(browserSpace);
  }

  const workspace = await ensureBrowserWorkspace(
    normalizedWorkspaceId,
    browserSpace,
    normalizedSessionId,
  );
  if (browserSpace === "agent") {
    if (normalizedSessionId) {
      hydrateAgentSessionBrowserSpace(normalizedWorkspaceId, normalizedSessionId);
      setVisibleAgentBrowserSession(workspace, normalizedSessionId);
      touchAgentSessionBrowserSpace(normalizedWorkspaceId, normalizedSessionId);
    } else {
      const visibleSessionId =
        browserVisibleAgentSessionId(workspace) ||
        browserFallbackAgentSessionId(workspace);
      activeBrowserSessionId = browserAgentSessionSpaceState(
        workspace,
        visibleSessionId,
      )
        ? visibleSessionId
        : "";
      if (activeBrowserSessionId) {
        hydrateAgentSessionBrowserSpace(normalizedWorkspaceId, activeBrowserSessionId);
        touchAgentSessionBrowserSpace(normalizedWorkspaceId, activeBrowserSessionId);
      }
    }
  }
  if (
    previousSpace === "agent" &&
    browserSessionId(previousSessionId) &&
    (previousWorkspaceId !== normalizedWorkspaceId ||
      browserSpace !== "agent" ||
      browserSessionId(previousSessionId) !== browserSessionId(activeBrowserSessionId))
  ) {
    scheduleAgentSessionBrowserLifecycleCheck(
      previousWorkspaceId,
      previousSessionId,
      SESSION_BROWSER_BUSY_CHECK_MS,
    );
  }
  updateAttachedBrowserView();
  emitBrowserState(normalizedWorkspaceId, browserSpace);
  emitBookmarksState(normalizedWorkspaceId);
  emitDownloadsState(normalizedWorkspaceId);
  emitHistoryState(normalizedWorkspaceId);
  return browserWorkspaceSnapshot(
    normalizedWorkspaceId,
    browserSpace,
    browserSpace === "agent" ? activeBrowserSessionId : null,
    { useVisibleAgentSession: true },
  );
}

// setActiveBrowserTab moved to browser-pane/tab-state.ts.

// closeBrowserTab moved to browser-pane/tab-state.ts.

// setBrowserBounds moved to browser-pane/tab-state.ts.

// captureVisibleBrowserSnapshot moved to browser-pane/tab-state.ts.

function ensureAuthPopupWindow() {
  if (authPopupWindow && !authPopupWindow.isDestroyed()) {
    return authPopupWindow;
  }

  if (!mainWindow) {
    return null;
  }

  authPopupWindow = new BrowserWindow({
    width: AUTH_POPUP_WIDTH,
    height: AUTH_POPUP_HEIGHT,
    parent: mainWindow,
    acceptFirstMouse: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    skipTaskbar: true,
    backgroundColor: "#00000000",
    transparent: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "authPopupPreload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  authPopupWindow.on("blur", () => {
    scheduleAuthPopupHide();
  });

  authPopupWindow.on("focus", () => {
    clearScheduledAuthPopupHide();
  });

  authPopupWindow.once("closed", () => {
    clearScheduledAuthPopupHide();
    authPopupWindow = null;
  });

  const html = createAuthPopupHtml();
  void authPopupWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
  );
  return authPopupWindow;
}

function clearScheduledAuthPopupHide() {
  if (!authPopupCloseTimer) {
    return;
  }

  clearTimeout(authPopupCloseTimer);
  authPopupCloseTimer = null;
}

function scheduleAuthPopupHide(delayMs = AUTH_POPUP_CLOSE_DELAY_MS) {
  clearScheduledAuthPopupHide();
  authPopupCloseTimer = setTimeout(
    () => {
      authPopupCloseTimer = null;
      hideAuthPopup();
    },
    Math.max(0, delayMs),
  );
}

function notifyAuthPopupOpened(popup: BrowserWindow) {
  if (popup.webContents.isLoadingMainFrame()) {
    popup.webContents.once("did-finish-load", () => {
      if (!popup.isDestroyed()) {
        popup.webContents.send("auth:opened");
      }
    });
    return;
  }

  popup.webContents.send("auth:opened");
}

function hideAuthPopup() {
  clearScheduledAuthPopupHide();
  authPopupWindow?.hide();
}

function showAuthPopup(anchorBounds: BrowserAnchorBoundsPayload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  clearScheduledAuthPopupHide();
  const popup = ensureAuthPopupWindow();
  if (!popup) {
    return;
  }

  const contentBounds = mainWindow.getContentBounds();
  const x = Math.round(
    Math.min(
      Math.max(contentBounds.x + anchorBounds.x, contentBounds.x + 8),
      contentBounds.x + contentBounds.width - AUTH_POPUP_WIDTH - 8,
    ),
  );
  const y = Math.round(contentBounds.y + anchorBounds.y + anchorBounds.height);

  popup.setBounds({
    x,
    y,
    width: AUTH_POPUP_WIDTH,
    height: AUTH_POPUP_HEIGHT,
  });
  if (popup.isVisible()) {
    return;
  }
  popup.show();
  popup.focus();
  notifyAuthPopupOpened(popup);
  emitPendingAuthState();
}

function toggleAuthPopup(anchorBounds: BrowserAnchorBoundsPayload) {
  if (
    authPopupWindow &&
    !authPopupWindow.isDestroyed() &&
    authPopupWindow.isVisible()
  ) {
    hideAuthPopup();
    return;
  }

  showAuthPopup(anchorBounds);
}

function resolveWindowsBackgroundMaterial():
  | "mica"
  | "acrylic"
  | undefined {
  if (process.platform !== "win32") return undefined;
  const buildNumber = Number.parseInt(
    os.release().split(".")[2] ?? "0",
    10,
  );
  // Win 11 22000+ supports Mica; Win 10 1809 (17763)+ supports Acrylic.
  if (buildNumber >= 22000) return "mica";
  if (buildNumber >= 17763) return "acrylic";
  return undefined;
}

function createMainWindow() {
  const isMac = process.platform === "darwin";
  const isWindows = process.platform === "win32";
  const winBackgroundMaterial = resolveWindowsBackgroundMaterial();

  const platformOptions: Electron.BrowserWindowConstructorOptions = isMac
    ? {
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 14, y: 16 },
        // 'sidebar' renders the Finder-style frosted glass — significantly
        // more visible than 'under-window' in dark mode, where Apple's
        // 'under-window' intentionally leans quiet/moody and is hard to
        // perceive as glass. Both materials adapt automatically to
        // light/dark; 'sidebar' just has more presence.
        vibrancy: "sidebar",
        visualEffectState: "active",
      }
    : isWindows
      ? {
          frame: false,
          ...(winBackgroundMaterial && {
            backgroundMaterial: winBackgroundMaterial,
          }),
        }
      : {};

  const appIcon = nativeImage.createFromPath(desktopAppIconPath());

  const win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    center: true,
    // On macOS we omit backgroundColor so the NSVisualEffectView (vibrancy)
    // paints the window backdrop — setting it to a transparent value would
    // mark the window itself as transparent and prevent vibrancy from
    // engaging. Other platforms keep the dark fill for a flicker-free first
    // paint.
    ...(isMac ? {} : { backgroundColor: "#050907" }),
    autoHideMenuBar: true,
    icon: appIcon,
    ...platformOptions,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow = win;
  attachedBrowserTabView = null;
  attachedAppSurfaceView = null;
  reserveMainWindowClosedListenerBudget();
  browserBounds = { x: 0, y: 0, width: 0, height: 0 };
  activeBrowserWorkspaceId = "";
  activeBrowserSpaceId = "user";
  activeBrowserSessionId = "";
  for (const workspaceId of Array.from(browserWorkspaces.keys())) {
    destroyBrowserWorkspace(workspaceId);
  }

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => undefined);
  win.webContents.on("did-finish-load", () => {
    win.webContents.setZoomFactor(1);
    win.webContents.setZoomLevel(0);
    emitBrowserState();
    emitRuntimeState(true);
    emitPendingAuthState();
    emitAppUpdateState();
    emitWindowStateChanged(win);
  });

  win.webContents.on("before-input-event", (event, input) => {
    const key = input.key.toLowerCase();
    const isZoomHotkey =
      input.control &&
      (key === "+" ||
        key === "-" ||
        key === "=" ||
        key === "0" ||
        key === "add" ||
        key === "subtract");
    if (isZoomHotkey) {
      event.preventDefault();
      win.webContents.setZoomFactor(1);
      win.webContents.setZoomLevel(0);
    }
  });

  if (isDev) {
    void win.loadURL(RESOLVED_DEV_SERVER_URL);
  } else {
    void win.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  win.on("maximize", () => {
    emitWindowStateChanged(win);
  });
  win.on("unmaximize", () => {
    emitWindowStateChanged(win);
  });
  win.on("minimize", () => {
    emitWindowStateChanged(win);
  });
  win.on("restore", () => {
    emitWindowStateChanged(win);
  });
  win.on("enter-full-screen", () => {
    emitWindowStateChanged(win);
  });
  win.on("leave-full-screen", () => {
    emitWindowStateChanged(win);
  });

  win.once("ready-to-show", () => {
    if (process.platform === "win32") {
      win.maximize();
      win.show();
      emitWindowStateChanged(win);
      return;
    }

    const display = screen.getDisplayMatching(win.getBounds());
    const workArea = display.workArea;
    const TARGET_WIDTH = 1600;
    const TARGET_HEIGHT = 980;
    const MARGIN = 48;
    const width = Math.min(TARGET_WIDTH, Math.max(1180, workArea.width - MARGIN));
    const height = Math.min(TARGET_HEIGHT, Math.max(720, workArea.height - MARGIN));
    const x = workArea.x + Math.round((workArea.width - width) / 2);
    const y = workArea.y + Math.round((workArea.height - height) / 2);
    win.setBounds({ x, y, width, height });
    win.show();
    emitWindowStateChanged(win);
  });

  win.once("closed", () => {
    authPopupWindow?.close();
    authPopupWindow = null;
    browserPanePopups.closeAllPopups();
    for (const workspaceId of Array.from(browserWorkspaces.keys())) {
      destroyBrowserWorkspace(workspaceId);
    }
    activeBrowserWorkspaceId = "";
    activeBrowserSpaceId = "user";
    activeBrowserSessionId = "";
    attachedBrowserTabView = null;
    attachedAppSurfaceView = null;
    closeAllFilePreviewWatchSubscriptions();
    mainWindow = null;
  });
}

function focusOrCreateMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  mainWindow.focus();
}

function desktopAppIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(__dirname, "..", "..", "resources", "icon.png");
}

function desktopStatusItemIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "holaStatusTemplate.png")
    : path.join(__dirname, "..", "..", "resources", "holaStatusTemplate.png");
}

function shouldShowNativeDesktopNotification(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }
  if (mainWindow.isMinimized() || !mainWindow.isVisible()) {
    return true;
  }
  return !mainWindow.isFocused();
}

function normalizedNativeNotificationText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function shouldUseMacDevelopmentNotificationFallback(): boolean {
  return process.platform === "darwin" && !app.isPackaged;
}

function appleScriptStringLiteral(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function logNativeDesktopNotificationEvent(
  event: string,
  payload: {
    title?: string | null;
    body?: string | null;
    force?: boolean;
    detail?: string | null;
  },
): void {
  const title = normalizedNativeNotificationText(payload.title ?? "", 80);
  const body = normalizedNativeNotificationText(payload.body ?? "", 120);
  const detail = normalizedNativeNotificationText(payload.detail ?? "", 160);
  const line = [
    `[desktop-notification] event=${event}`,
    `force=${payload.force === true ? "true" : "false"}`,
    `title=${JSON.stringify(title)}`,
    `body=${JSON.stringify(body)}`,
    detail ? `detail=${JSON.stringify(detail)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  void appendRuntimeLog(`${line}\n`);
}

function showMacDevelopmentNotificationFallback(payload: {
  title: string;
  body: string;
  force?: boolean;
}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const script = `display notification ${appleScriptStringLiteral(payload.body)} with title ${appleScriptStringLiteral(payload.title)}`;
    logNativeDesktopNotificationEvent("dev_fallback_requested", payload);
    const child = spawn("osascript", ["-e", script], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      logNativeDesktopNotificationEvent("dev_fallback_failed", {
        ...payload,
        detail: error instanceof Error ? error.message : String(error),
      });
      resolve(false);
    });
    child.once("exit", (code) => {
      if (code === 0) {
        logNativeDesktopNotificationEvent("dev_fallback_shown", payload);
        resolve(true);
        return;
      }
      logNativeDesktopNotificationEvent("dev_fallback_failed", {
        ...payload,
        detail: stderr.trim() || `osascript exit code ${code ?? "null"}`,
      });
      resolve(false);
    });
  });
}

function showNativeDesktopNotification(
  payload: DesktopNativeNotificationPayload,
): Promise<boolean> {
  const title = normalizedNativeNotificationText(payload.title, 80);
  const body = normalizedNativeNotificationText(payload.body, 240);
  const supported = Notification.isSupported();
  if (!supported) {
    logNativeDesktopNotificationEvent("skipped", {
      title,
      body,
      force: payload.force,
      detail: "Notification.isSupported() returned false.",
    });
    return Promise.resolve(false);
  }
  if (!notificationPreferences.enabled) {
    logNativeDesktopNotificationEvent("skipped", {
      title,
      body,
      force: payload.force,
      detail: "User disabled desktop notifications.",
    });
    return Promise.resolve(false);
  }
  if (!payload.force && !shouldShowNativeDesktopNotification()) {
    logNativeDesktopNotificationEvent("skipped", {
      title,
      body,
      force: payload.force,
      detail: "Main window is visible, focused, and not minimized.",
    });
    return Promise.resolve(false);
  }
  if (!title || !body) {
    logNativeDesktopNotificationEvent("skipped", {
      title,
      body,
      force: payload.force,
      detail: "Missing title or body after normalization.",
    });
    return Promise.resolve(false);
  }
  const useDevFallback = shouldUseMacDevelopmentNotificationFallback();

  return new Promise<boolean>((resolve) => {
    logNativeDesktopNotificationEvent("show_requested", {
      title,
      body,
      force: payload.force,
    });
    const notification = new Notification({
      title,
      body,
      icon: desktopAppIconPath(),
      silent: false,
    });
    let settled = false;
    let usedFallback = false;
    const closeNativeNotification = () => {
      try {
        notification.close();
      } catch {
        // Notification may already be closed; ignore.
      }
    };
    const settle = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    const fallbackThenSettle = (detail: string) => {
      if (settled) {
        return;
      }
      if (!useDevFallback) {
        settle(false);
        return;
      }
      // Suppress the native notification so it can't appear alongside the AppleScript one.
      usedFallback = true;
      closeNativeNotification();
      logNativeDesktopNotificationEvent("dev_fallback_attempt", {
        title,
        body,
        force: payload.force,
        detail,
      });
      void showMacDevelopmentNotificationFallback({
        title,
        body,
        force: payload.force,
      }).then((shown) => {
        settle(shown);
      });
    };
    const showTimeout = setTimeout(() => {
      logNativeDesktopNotificationEvent("show_timeout", {
        title,
        body,
        force: payload.force,
        detail: "Notification did not emit show within 1500ms.",
      });
      fallbackThenSettle("native_show_timeout");
    }, 1500);
    notification.on("show", () => {
      clearTimeout(showTimeout);
      if (usedFallback) {
        // Native notification arrived after we already triggered the dev fallback —
        // dismiss it so the user doesn't see two notifications for the same event.
        logNativeDesktopNotificationEvent("late_show_suppressed", {
          title,
          body,
          force: payload.force,
        });
        closeNativeNotification();
        return;
      }
      logNativeDesktopNotificationEvent("shown", {
        title,
        body,
        force: payload.force,
      });
      settle(true);
    });
    notification.on("failed", (_event, error) => {
      clearTimeout(showTimeout);
      const detail =
        typeof error === "string"
          ? error
          : error && typeof error === "object" && "message" in error
            ? String((error as { message?: unknown }).message ?? "unknown")
            : String(error ?? "unknown");
      logNativeDesktopNotificationEvent("failed", {
        title,
        body,
        force: payload.force,
        detail,
      });
      fallbackThenSettle(`native_failed:${detail}`);
    });
    notification.on("click", () => {
      logNativeDesktopNotificationEvent("clicked", {
        title,
        body,
        force: payload.force,
      });
      if (process.platform === "darwin") {
        app.dock?.show();
        app.focus({ steal: true });
      } else {
        app.focus();
      }
      focusOrCreateMainWindow();
      const workspaceId = (payload.workspaceId ?? "").trim();
      const sessionId = (payload.sessionId ?? "").trim();
      if (!workspaceId) return;
      const target = mainWindow;
      if (!target || target.isDestroyed() || target.webContents.isDestroyed()) {
        return;
      }
      const send = () => {
        if (target.isDestroyed() || target.webContents.isDestroyed()) return;
        target.webContents.send("ui:notificationActivated", {
          workspaceId,
          sessionId: sessionId || null,
        });
      };
      // Cold-start case: window was just created by focusOrCreateMainWindow,
      // renderer hasn't registered the IPC listener yet. Defer until the page
      // finishes loading (and one extra tick so React effects can run).
      if (target.webContents.isLoading()) {
        target.webContents.once("did-finish-load", () => {
          setTimeout(send, 200);
        });
      } else {
        send();
      }
    });
    notification.on("close", () => {
      logNativeDesktopNotificationEvent("closed", {
        title,
        body,
        force: payload.force,
      });
    });
    notification.show();
  });
}

function installMacStatusItem() {
  if (process.platform !== "darwin" || statusItemTray) {
    return;
  }

  const icon = nativeImage.createFromPath(desktopStatusItemIconPath());
  if (icon.isEmpty()) {
    return;
  }
  icon.setTemplateImage(true);

  statusItemTray = new Tray(icon);
  statusItemTray.setToolTip(MAC_APP_MENU_PRODUCT_LABEL);
  statusItemTray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: `Open ${MAC_APP_MENU_PRODUCT_LABEL}`,
        click: () => {
          focusOrCreateMainWindow();
        },
      },
      {
        label: `Quit ${MAC_APP_MENU_PRODUCT_LABEL}`,
        role: "quit",
      },
    ]),
  );
}

function installMacApplicationMenu() {
  if (process.platform !== "darwin") {
    return;
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.getName(),
      submenu: [
        {
          label: `Open ${MAC_APP_MENU_PRODUCT_LABEL}`,
          click: () => {
            focusOrCreateMainWindow();
          },
        },
        {
          label: `Quit ${MAC_APP_MENU_PRODUCT_LABEL}`,
          role: "quit",
        },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "Close Tab",
          accelerator: "CmdOrCtrl+W",
          click: () => {
            mainWindow?.webContents.send("app:closeActiveTab");
          },
        },
        {
          label: "Close Window",
          accelerator: "CmdOrCtrl+Shift+W",
          role: "close",
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", role: "undo" },
        { label: "Redo", role: "redo" },
        { type: "separator" },
        { label: "Cut", role: "cut" },
        { label: "Copy", role: "copy" },
        { label: "Paste", role: "paste" },
        { label: "Select All", role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        // Reload + Force Reload only useful in dev — packaged builds load
        // a static bundle, so reloading just re-renders the same artifact.
        ...(isDev
          ? ([
              { label: "Reload", role: "reload" },
              { label: "Force Reload", role: "forceReload" },
              { type: "separator" },
            ] as MenuItemConstructorOptions[])
          : []),
        { label: "Toggle Developer Tools", role: "toggleDevTools" },
        { type: "separator" },
        { label: "Actual Size", role: "resetZoom" },
        { label: "Zoom In", role: "zoomIn" },
        { label: "Zoom Out", role: "zoomOut" },
        { type: "separator" },
        { label: "Toggle Full Screen", role: "togglefullscreen" },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function readClipboardImagePayload(): ClipboardImagePayload | null {
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    return null;
  }

  const png = image.toPNG();
  if (png.length === 0) {
    return null;
  }

  const size = image.getSize();
  return {
    name: "pasted-image.png",
    mime_type: "image/png",
    content_base64: png.toString("base64"),
    width: size.width,
    height: size.height,
  };
}

const singleInstanceLock =
  process.env.HOLABOSS_DISABLE_SINGLE_INSTANCE_LOCK?.trim() === "1"
    ? true
    : app.requestSingleInstanceLock();
app.setName(
  process.platform === "darwin" && isDev
    ? MAC_APP_MENU_PRODUCT_LABEL
    : APP_DISPLAY_NAME,
);
if (!singleInstanceLock) {
  app.exit(0);
} else {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(
      AUTH_CALLBACK_PROTOCOL,
      process.execPath,
      defaultAppProtocolClientArgs(),
    );
  } else {
    app.setAsDefaultProtocolClient(AUTH_CALLBACK_PROTOCOL);
  }

  app.on("second-instance", (_event, commandLine) => {
    const callbackUrl = commandLine
      .map((value) => maybeAuthCallbackUrl(value))
      .find((value) => value !== null);
    if (callbackUrl) {
      void handleAuthCallbackUrl(callbackUrl);
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.on("open-url", (event, targetUrl) => {
    event.preventDefault();
    void handleAuthCallbackUrl(targetUrl);
  });

  const initialCallbackUrl = process.argv
    .map((value) => maybeAuthCallbackUrl(value))
    .find((value) => value !== null);
  if (initialCallbackUrl) {
    void handleAuthCallbackUrl(initialCallbackUrl);
  }
}

app.on("browser-window-created", (_event, window) => {
  window.on("unresponsive", () => {
    if (unresponsiveDesktopWindows.has(window)) {
      return;
    }
    unresponsiveDesktopWindows.add(window);
    captureDesktopLifecycleEvent({
      message: "Electron window became unresponsive",
      level: "warning",
      fingerprint: [
        "electron-window-unresponsive",
        desktopWindowTelemetryRole(window),
      ],
      tags: {
        desktop_window_role: desktopWindowTelemetryRole(window),
      },
      contexts: {
        desktop_window: {
          role: desktopWindowTelemetryRole(window),
          title: window.getTitle() || null,
          visible: window.isVisible(),
          focused: window.isFocused(),
          minimized: window.isMinimized(),
          maximized: window.isMaximized(),
        },
      },
    });
  });

  window.on("responsive", () => {
    unresponsiveDesktopWindows.delete(window);
    addDesktopLifecycleBreadcrumb(
      "window",
      "Browser window responsive again",
      {
        desktop_window_role: desktopWindowTelemetryRole(window),
        title: window.getTitle() || null,
      },
    );
  });
});

app.on("web-contents-created", (_event, contents) => {
  const contentsType = contents.getType();
  contents.on("render-process-gone", (_goneEvent, details) => {
    const ownerWindow = BrowserWindow.fromWebContents(contents);
    const ownerRole = desktopWindowTelemetryRole(ownerWindow);
    captureDesktopLifecycleEvent({
      message: "Electron renderer process gone",
      level: "error",
      fingerprint: [
        "electron-render-process-gone",
        contentsType,
        details.reason,
      ],
      tags: {
        desktop_window_role: ownerRole,
        webcontents_type: contentsType,
        render_process_reason: details.reason,
      },
      contexts: {
        render_process: {
          type: contentsType,
          reason: details.reason,
          exit_code: details.exitCode,
          url: safeWebContentsUrl(contents),
        },
        desktop_window: ownerWindow
          ? {
              role: ownerRole,
              title: ownerWindow.getTitle() || null,
            }
          : null,
      },
    });
    if (ownerWindow && ownerWindow === mainWindow && contentsType === "window") {
      detachAttachedMainWindowViews();
    }
  });
});

app.on("child-process-gone", (_event, details) => {
  captureDesktopLifecycleEvent({
    message: "Electron child process gone",
    level: "error",
    fingerprint: [
      "electron-child-process-gone",
      details.type,
      details.reason,
    ],
    tags: {
      child_process_type: details.type,
      child_process_reason: details.reason,
    },
    contexts: {
      child_process: {
        type: details.type,
        reason: details.reason,
        name: details.name ?? null,
        service_name: details.serviceName ?? null,
        exit_code: details.exitCode,
      },
    },
  });
});

app.whenReady().then(async () => {
  if (!singleInstanceLock) {
    return;
  }

  configureMacWebAuthnPlatformAuthenticator();

  if (process.platform === "darwin" && app.dock) {
    const dockIcon = nativeImage.createFromPath(desktopAppIconPath());
    if (!dockIcon.isEmpty()) {
      app.dock.setIcon(dockIcon);
    }
  }

  installMacStatusItem();
  installMacApplicationMenu();
  applyMainShellContentSecurityPolicy(session.defaultSession);

  await loadBrowserPersistence();
  await bootstrapRuntimeDatabase();
  bootstrapControlPlaneDatabase();
  ensureOpenAiCodexRefreshLoop();
  void refreshOpenAiCodexProviderCredentials().catch(() => undefined);

  installBffFetchHandler({
    getCookieHeader: () => authCookieHeader(),
    allowedHosts: () => bffFetchAllowedHosts(),
    register: (channel, handler) =>
      handleTrustedIpc(channel, ["main"], handler),
    log: (event) => {
      // Same shape as the rest of the structured logs — short, single-line,
      // single source of truth in main stdout.
      // eslint-disable-next-line no-console
      console.info(`[bff-fetch] ${JSON.stringify(event)}`);
    },
  });

  installBrowserPaneHandlers({
    getMainWindow: () => mainWindow,
    getCookieHeader: () => authCookieHeader(),
    register: (channel, handler) =>
      handleTrustedIpc(channel, ["main"], handler),
    log: (event) => {
      // eslint-disable-next-line no-console
      console.info(`[browser-pane] ${JSON.stringify(event)}`);
    },
  });

  handleTrustedIpc(
    "fs:listDirectory",
    ["main"],
    async (_event, targetPath?: string | null, workspaceId?: string | null) =>
      listDirectory(targetPath, workspaceId),
  );
  handleTrustedIpc(
    "fs:readFilePreview",
    ["main"],
    async (_event, targetPath: string, workspaceId?: string | null) =>
      readFilePreview(targetPath, workspaceId),
  );
  handleTrustedIpc(
    "fs:writeTextFile",
    ["main"],
    async (
      _event,
      targetPath: string,
      content: string,
      workspaceId?: string | null,
    ) => writeTextFile(targetPath, content, workspaceId),
  );
  handleTrustedIpc(
    "fs:writeTableFile",
    ["main"],
    async (
      _event,
      targetPath: string,
      tableSheets: FilePreviewTableSheetPayload[],
      workspaceId?: string | null,
    ) => writeTableFile(targetPath, tableSheets, workspaceId),
  );
  handleTrustedIpc(
    "fs:watchFile",
    ["main"],
    async (_event, targetPath: string, workspaceId?: string | null) =>
      watchFilePreviewPath(targetPath, workspaceId),
  );
  handleTrustedIpc(
    "fs:unwatchFile",
    ["main"],
    async (_event, subscriptionId: string) => {
      closeFilePreviewWatchSubscription(subscriptionId);
    },
  );
  handleTrustedIpc(
    "fs:createPath",
    ["main"],
    async (
      _event,
      parentPath: string | null | undefined,
      kind: FileSystemCreateKind,
      workspaceId?: string | null,
    ) => createExplorerPath(parentPath, kind, workspaceId),
  );
  handleTrustedIpc(
    "fs:importExternalEntries",
    ["main"],
    async (
      _event,
      destinationDirectoryPath: string,
      entries: ExplorerExternalImportEntryPayload[],
      workspaceId?: string | null,
    ) =>
      importExternalExplorerEntries(
        destinationDirectoryPath,
        entries,
        workspaceId,
      ),
  );
  handleTrustedIpc(
    "fs:renamePath",
    ["main"],
    async (
      _event,
      targetPath: string,
      nextName: string,
      workspaceId?: string | null,
    ) => renameExplorerPath(targetPath, nextName, workspaceId),
  );
  handleTrustedIpc(
    "fs:movePath",
    ["main"],
    async (
      _event,
      sourcePath: string,
      destinationDirectoryPath: string,
      workspaceId?: string | null,
    ) => moveExplorerPath(sourcePath, destinationDirectoryPath, workspaceId),
  );
  handleTrustedIpc(
    "fs:copyPath",
    ["main"],
    async (
      _event,
      sourcePath: string,
      destinationDirectoryPath: string,
      workspaceId?: string | null,
    ) => copyExplorerPath(sourcePath, destinationDirectoryPath, workspaceId),
  );
  handleTrustedIpc(
    "fs:deletePath",
    ["main"],
    async (_event, targetPath: string, workspaceId?: string | null) =>
      deleteExplorerPath(targetPath, workspaceId),
  );
  handleTrustedIpc(
    "fs:revealInFolder",
    ["main"],
    async (_event, targetPath: string, workspaceId?: string | null) =>
      revealExplorerPath(targetPath, workspaceId),
  );
  handleTrustedIpc(
    "fs:exportFileTo",
    ["main"],
    async (
      _event,
      targetPath: string,
      workspaceId?: string | null,
      payload?: { content?: string; suggestedName?: string },
    ) => exportExplorerPathToFile(targetPath, workspaceId, payload),
  );
  handleTrustedIpc(
    "fs:exportHtmlToPdf",
    ["main"],
    async (_event, payload: HtmlToPdfExportRequestPayload) =>
      exportHtmlToPdf(payload),
  );
  handleTrustedIpc("fs:getBookmarks", ["main"], () => fileBookmarks);
  handleTrustedIpc(
    "fs:addBookmark",
    ["main"],
    async (_event, targetPath: string, label?: string) => {
      const resolvedPath = path.resolve(targetPath);
      const stat = await fs.stat(resolvedPath);
      const nextLabel =
        label?.trim() || path.basename(resolvedPath) || resolvedPath;
      const existing = fileBookmarks.find(
        (bookmark) => bookmark.targetPath === resolvedPath,
      );

      if (existing) {
        if (
          existing.label !== nextLabel ||
          existing.isDirectory !== stat.isDirectory()
        ) {
          fileBookmarks = fileBookmarks.map((bookmark) =>
            bookmark.id === existing.id
              ? {
                  ...bookmark,
                  label: nextLabel,
                  isDirectory: stat.isDirectory(),
                }
              : bookmark,
          );
          emitFileBookmarksState();
          await persistFileBookmarks();
        }

        return fileBookmarks;
      }

      fileBookmarks = [
        {
          id: `file-bookmark-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          targetPath: resolvedPath,
          label: nextLabel,
          isDirectory: stat.isDirectory(),
          createdAt: new Date().toISOString(),
        },
        ...fileBookmarks,
      ];
      emitFileBookmarksState();
      await persistFileBookmarks();
      return fileBookmarks;
    },
  );
  handleTrustedIpc(
    "fs:removeBookmark",
    ["main"],
    async (_event, bookmarkId: string) => {
      fileBookmarks = fileBookmarks.filter(
        (bookmark) => bookmark.id !== bookmarkId,
      );
      emitFileBookmarksState();
      await persistFileBookmarks();
      return fileBookmarks;
    },
  );
  // Returns the *cached* runtime status. The full refreshRuntimeStatus()
  // path probes /healthz, which during boot — when the sidecar isn't up
  // yet — eats a 1500ms HTTP timeout per call. Push events
  // (`runtime:state`) already keep the cached value current; renderer
  // gets a real-time stream + can poll this IPC for the same state in
  // microseconds. (Boot timing: shaved ~1s off the splash by removing
  // the redundant probe round-trip from this hot path.)
  handleTrustedIpc("runtime:getStatus", ["main", "auth-popup"], () =>
    Promise.resolve(runtimeStatus),
  );
  handleTrustedIpc("runtime:restart", ["main"], async () => {
    await restartEmbeddedRuntimeSafely("manual_restart");
    return refreshRuntimeStatus();
  });
  // Full app relaunch — heavier hammer than runtime:restart, used by error
  // surfaces where the renderer/main may itself be in a bad state (e.g. the
  // "Holaboss couldn't start" blocker). Electron's app.relaunch() schedules
  // the next instance, then app.quit() exits the current one. Awaiting the
  // IPC roundtrip is meaningless because the process is going away — the
  // renderer just kicks it and forgets.
  handleTrustedIpc("app:relaunch", ["main"], () => {
    app.relaunch();
    app.quit();
  });
  handleTrustedIpc("auth:getUser", ["main", "auth-popup"], async () =>
    getAuthenticatedUser(),
  );
  // Renderer-side BFF clients (e.g. @holaboss/app-sdk in renderer, billing
  // RPC calls) reach the BFF via the bff:fetch IPC bridge — main injects
  // the auth cookie there, so the renderer never sees it. The two URL
  // accessors below stay because the renderer still needs to know which
  // host to target (encoded in the SDK's baseURL).
  handleTrustedIpc("auth:getApiBaseUrl", ["main"], () => AUTH_BASE_URL ?? "");
  handleTrustedIpc(
    "auth:getMarketplaceBaseUrl",
    ["main"],
    () => marketplaceBffBaseUrl(),
  );
  handleTrustedIpc("auth:requestAuth", ["main", "auth-popup"], async () => {
    await requireAuthClient().requestAuth();
  });
  handleTrustedIpc("auth:signOut", ["main", "auth-popup"], async () => {
    try {
      await requireAuthClient().signOut();
    } finally {
      clearPersistedAuthCookie();
    }
    const runtimeConfig = await readRuntimeConfigFile();
    await clearManagedHolabossDefaultSelection("auth_sign_out");
    if (
      runtimeConfigIsControlPlaneManaged(runtimeConfig) &&
      runtimeModelProxyApiKeyFromConfig(runtimeConfig)
    ) {
      await clearRuntimeBindingSecrets("auth_sign_out");
    }
    pendingAuthError = null;
    emitAuthUserUpdated(null);
  });
  handleTrustedIpc(
    "auth:showPopup",
    ["main"],
    (_event, anchorBounds: BrowserAnchorBoundsPayload) => {
      showAuthPopup(anchorBounds);
    },
  );
  handleTrustedIpc(
    "auth:togglePopup",
    ["main"],
    (_event, anchorBounds: BrowserAnchorBoundsPayload) => {
      toggleAuthPopup(anchorBounds);
    },
  );
  handleTrustedIpc(
    "auth:scheduleClosePopup",
    ["main", "auth-popup"],
    (_event, delayMs?: number) => {
      scheduleAuthPopupHide(
        typeof delayMs === "number" ? delayMs : AUTH_POPUP_CLOSE_DELAY_MS,
      );
    },
  );
  handleTrustedIpc("auth:cancelClosePopup", ["main", "auth-popup"], () => {
    clearScheduledAuthPopupHide();
  });
  handleTrustedIpc("auth:closePopup", ["main", "auth-popup"], () => {
    hideAuthPopup();
  });
  handleTrustedIpc("runtime:getConfig", ["main", "auth-popup"], () =>
    getRuntimeConfig(),
  );
  handleTrustedIpc("runtime:getProfile", ["main", "auth-popup"], () =>
    getRuntimeUserProfile(),
  );
  handleTrustedIpc("runtime:getConfigDocument", ["main", "auth-popup"], () =>
    getRuntimeConfigDocumentText(),
  );
  handleTrustedIpc(
    "runtime:setConfig",
    ["main", "auth-popup"],
    async (_event, payload: RuntimeConfigUpdatePayload) => {
      const currentConfig = await readRuntimeConfigFile();
      const nextConfig = await writeRuntimeConfigFile(payload);
      await restartEmbeddedRuntimeIfNeeded(
        currentConfig,
        nextConfig,
        "runtime_config_update",
      );
      const config = await getRuntimeConfig();
      await emitRuntimeConfig(config);
      return config;
    },
  );
  handleTrustedIpc(
    "runtime:setProfile",
    ["main", "auth-popup"],
    async (_event, payload: RuntimeUserProfileUpdatePayload) =>
      setRuntimeUserProfile(payload ?? {}),
  );
  handleTrustedIpc(
    "runtime:setConfigDocument",
    ["main", "auth-popup"],
    async (_event, rawDocument: string) =>
      setRuntimeConfigDocument(rawDocument),
  );
  handleTrustedIpc(
    "runtime:connectCodexOAuth",
    ["main", "auth-popup"],
    async () => connectOpenAiCodexProvider(),
  );
  handleTrustedIpc(
    "runtime:startCodexOAuth",
    ["main", "auth-popup"],
    async () => startOpenAiCodexOAuth(),
  );
  handleTrustedIpc(
    "runtime:awaitCodexOAuth",
    ["main", "auth-popup"],
    async () => awaitOpenAiCodexOAuth(),
  );
  handleTrustedIpc(
    "runtime:cancelCodexOAuth",
    ["main", "auth-popup"],
    async () => cancelOpenAiCodexOAuth(),
  );
  handleTrustedIpc(
    "runtime:refreshCodexToken",
    ["main", "auth-popup"],
    async () => {
      const refreshed = await refreshOpenAiCodexProviderCredentials({ force: true });
      const document = await readRuntimeConfigDocument();
      const state = openAiCodexProviderStateFromDocument(document);
      return {
        refreshed,
        accessTokenExpiresAt: state.accessTokenExpiresAt || null,
      };
    },
  );
  handleTrustedIpc(
    "runtime:validateProvider",
    ["main", "auth-popup"],
    async (_event, providerId: string) => validateRuntimeProvider(providerId),
  );
  handleTrustedIpc(
    "ui:getTheme",
    ["main", "auth-popup"],
    async () => currentTheme,
  );
  handleTrustedIpc(
    "ui:openSettingsPane",
    ["main", "auth-popup"],
    async (_event, section?: UiSettingsPaneSection) => {
      emitOpenSettingsPane(section ?? "settings");
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.focus();
      }
    },
  );
  handleTrustedIpc(
    "ui:openExternalUrl",
    ["main", "auth-popup"],
    async (_event, rawUrl: string) => {
      await openExternalUrl(rawUrl);
    },
  );
  handleTrustedIpc(
    "clipboard:readImage",
    ["main"],
    async () => readClipboardImagePayload(),
  );
  handleTrustedIpc(
    "clipboard:writeText",
    ["main"],
    async (_event, text: string) => {
      clipboard.writeText(typeof text === "string" ? text : "");
    },
  );
  handleTrustedIpc("ui:getWindowState", ["main"], async (event) => {
    return desktopWindowStatePayload(
      resolveTargetWindow(BrowserWindow.fromWebContents(event.sender)),
    );
  });
  handleTrustedIpc("ui:minimizeWindow", ["main"], async (event) => {
    const targetWindow = resolveTargetWindow(
      BrowserWindow.fromWebContents(event.sender),
    );
    if (!targetWindow) {
      return;
    }
    targetWindow.minimize();
  });
  handleTrustedIpc("ui:toggleWindowSize", ["main"], async (event) => {
    const targetWindow = resolveTargetWindow(
      BrowserWindow.fromWebContents(event.sender),
    );
    if (!targetWindow) {
      return;
    }

    if (targetWindow.isFullScreen()) {
      targetWindow.setFullScreen(false);
      return;
    }

    if (targetWindow.isMaximized()) {
      targetWindow.unmaximize();
      return;
    }

    targetWindow.maximize();
  });
  handleTrustedIpc("ui:closeWindow", ["main"], async (event) => {
    const targetWindow = resolveTargetWindow(
      BrowserWindow.fromWebContents(event.sender),
    );
    if (!targetWindow) {
      return;
    }
    targetWindow.close();
  });
  handleTrustedIpc(
    "ui:setTheme",
    ["main", "auth-popup"],
    async (_event, theme: string) => {
      currentTheme = APP_THEMES.has(theme) ? theme : DEFAULT_APP_THEME;
      emitThemeChanged();
      authPopupWindow?.close();
      authPopupWindow = null;
      browserPanePopups.closeAllPopups();
    },
  );
  handleTrustedIpc(
    "ui:showNativeNotification",
    ["main"],
    async (_event, payload: DesktopNativeNotificationPayload) => {
      return await showNativeDesktopNotification(payload);
    },
  );
  handleTrustedIpc(
    "ui:setBadgeCount",
    ["main"],
    async (_event, count: unknown) => {
      const numeric = typeof count === "number" ? count : Number(count);
      const safe = Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
      try {
        app.setBadgeCount(safe);
      } catch {
        // app.setBadgeCount is a no-op on platforms that don't support it
        // (Windows without setOverlayIcon, headless Linux). Swallow rather
        // than surface platform support as a renderer error.
      }
    },
  );
  handleTrustedIpc(
    "ui:getNotificationsEnabled",
    ["main"],
    async () => notificationPreferences.enabled,
  );
  handleTrustedIpc(
    "ui:setNotificationsEnabled",
    ["main"],
    async (_event, enabled: unknown) => {
      const next = enabled !== false;
      const wasEnabled = notificationPreferences.enabled;
      notificationPreferences = { enabled: next };
      try {
        await persistNotificationPreferences();
      } catch (error) {
        void appendRuntimeLog(
          `[notifications] failed to persist preference: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      // Confirmation ping when turning notifications on — proves to the
      // user the OS permission is granted and the new setting took effect.
      if (next && !wasEnabled) {
        void showNativeDesktopNotification({
          title: "Desktop notifications enabled",
          body: "You'll get reminded when scheduled tasks fire.",
          force: true,
        });
      }
      if (!next) {
        try {
          app.setBadgeCount(0);
        } catch {
          // ignore — see ui:setBadgeCount handler
        }
      }
      return next;
    },
  );
  handleTrustedIpc(
    "appUpdate:getStatus",
    ["main"],
    async () => appUpdateStatus,
  );
  handleTrustedIpc("appUpdate:checkNow", ["main"], async () =>
    checkForAppUpdates(),
  );
  handleTrustedIpc(
    "appUpdate:dismiss",
    ["main"],
    async (_event, version?: string | null) => dismissAppUpdate(version),
  );
  handleTrustedIpc(
    "appUpdate:setChannel",
    ["main"],
    async (_event, channel: AppUpdateChannel) => setAppUpdateChannel(channel),
  );
  handleTrustedIpc("appUpdate:installNow", ["main"], async () => {
    installAppUpdateNow();
  });
  handleTrustedIpc(
    "runtime:exchangeBinding",
    ["main", "auth-popup"],
    async (_event, sandboxId: string) => {
      const binding = await exchangeDesktopRuntimeBinding(sandboxId);
      const modelProxyApiKey = runtimeBindingModelProxyApiKey(binding);
      if (!modelProxyApiKey) {
        throw new Error(
          "Runtime binding response missing model_proxy_api_key.",
        );
      }
      const currentConfig = await readRuntimeConfigFile();
      const nextConfig = await writeRuntimeConfigFile({
        authToken: modelProxyApiKey,
        modelProxyApiKey,
        userId: binding.holaboss_user_id,
        sandboxId: binding.sandbox_id,
        modelProxyBaseUrl: (binding.model_proxy_base_url || "").replace(
          "host.docker.internal",
          "127.0.0.1",
        ),
        defaultModel: binding.default_model,
        defaultBackgroundModel: binding.default_background_model ?? null,
        defaultEmbeddingModel: binding.default_embedding_model ?? null,
        defaultImageModel: binding.default_image_model ?? null,
        controlPlaneBaseUrl: DESKTOP_CONTROL_PLANE_BASE_URL,
      });
      await syncRuntimeModelCatalogFromBinding(binding);
      await restartEmbeddedRuntimeIfNeeded(
        currentConfig,
        nextConfig,
        "runtime_binding_exchange_manual",
      );
      const config = await getRuntimeConfig();
      await emitRuntimeConfig(config);
      return config;
    },
  );
  handleTrustedIpc("workspace:getClientConfig", ["main"], () =>
    getHolabossClientConfig(),
  );
  handleTrustedIpc("workspace:pickTemplateFolder", ["main"], async () =>
    pickTemplateFolder(),
  );
  handleTrustedIpc(
    "workspace:pickWorkspaceRuntimeFolder",
    ["main"],
    async () => pickWorkspaceRuntimeFolder(),
  );
  handleTrustedIpc(
    "workspace:pickWorkspaceRelocationFolder",
    ["main"],
    async (_event, workspaceId: string) =>
      pickWorkspaceRelocationFolder(workspaceId),
  );
  handleTrustedIpc(
    "workspace:relocate",
    ["main"],
    async (_event, workspaceId: string, newPath: string) =>
      relocateWorkspace(workspaceId, newPath),
  );
  handleTrustedIpc(
    "workspace:activate",
    ["main"],
    async (_event, workspaceId: string) =>
      desktopWorkspaceControlPlane.activateWorkspaceRecord(workspaceId),
  );
  handleTrustedIpc(
    "workspace:listImportBrowserProfiles",
    ["main"],
    async (_event, source: BrowserImportSource) =>
      listImportBrowserProfiles(source),
  );
  handleTrustedIpc(
    "workspace:importBrowserProfile",
    ["main"],
    async (_event, payload: BrowserImportProfilePayload) =>
      importBrowserProfileIntoWorkspace(payload),
  );
  handleTrustedIpc(
    "workspace:copyBrowserWorkspaceProfile",
    ["main"],
    async (_event, payload: BrowserCopyWorkspaceProfilePayload) =>
      copyBrowserWorkspaceProfile(payload),
  );
  handleTrustedIpc(
    "workspace:listWorkspaces",
    ["main", "auth-popup"],
    async () => desktopWorkspaceControlPlane.listWorkspaces(),
  );
  // Cached read straight from control-plane.db without going through the
  // sidecar — used by the splash to hydrate before the sidecar
  // finishes spawning. Returns empty on any failure so the renderer
  // can silently fall back to the live sidecar path.
  handleTrustedIpc(
    "workspace:listWorkspacesCached",
    ["main"],
    async () => desktopWorkspaceControlPlane.listWorkspacesCached(),
  );
  handleTrustedIpc(
    "workspace:getWorkspaceLifecycle",
    ["main"],
    async (_event, workspaceId: string) =>
      desktopWorkspaceControlPlane.getWorkspaceLifecycle(workspaceId),
  );
  handleTrustedIpc(
    "workspace:listWorkspaceCardSummaries",
    ["main"],
    async (_event, workspaceIds: string[]) =>
      listWorkspaceCardSummaries(workspaceIds),
  );
  handleTrustedIpc(
    "workspace:activateWorkspace",
    ["main"],
    async (_event, workspaceId: string) =>
      desktopWorkspaceControlPlane.activateWorkspace(workspaceId),
  );
  handleTrustedIpc(
    "workspace:openWorkspace",
    ["main"],
    async (_event, workspaceId: string) =>
      desktopWorkspaceControlPlane.openWorkspace(workspaceId),
  );
  handleTrustedIpc(
    "workspace:listInstalledApps",
    ["main"],
    async (_event, workspaceId: string) => listInstalledApps(workspaceId),
  );
  handleTrustedIpc(
    "workspace:removeInstalledApp",
    ["main"],
    async (_event, workspaceId: string, appId: string) =>
      removeInstalledApp(workspaceId, appId),
  );
  handleTrustedIpc(
    "workspace:listAppCatalog",
    ["main"],
    async (_event, params: { source?: "marketplace" | "local" }) =>
      listAppCatalog(params),
  );
  handleTrustedIpc(
    "workspace:syncAppCatalog",
    ["main"],
    async (_event, params: { source: "marketplace" | "local" }) =>
      syncAppCatalog(params),
  );
  handleTrustedIpc(
    "workspace:installAppFromCatalog",
    ["main"],
    async (_event, params: InstallAppFromCatalogRequest) =>
      installAppFromCatalog({
        workspaceId: params.workspaceId,
        appId: params.appId,
        source: params.source,
      }),
  );
  handleTrustedIpc(
    "workspace:installAppFromArchiveFile",
    ["main"],
    async (_event, params: { workspaceId: string }) =>
      pickAndInstallAppFromArchiveFile({ workspaceId: params.workspaceId }),
  );
  handleTrustedIpc(
    "appSurface:navigate",
    ["main"],
    async (_event, workspaceId: string, appId: string, urlPath?: string) =>
      navigateAppSurface(workspaceId, appId, urlPath),
  );
  handleTrustedIpc(
    "appSurface:setBounds",
    ["main"],
    (_event, bounds: BrowserBoundsPayload) => {
      setAppSurfaceBounds(bounds);
    },
  );
  handleTrustedIpc("appSurface:reload", ["main"], (_event, appId: string) => {
    appSurfaceViews.get(appId)?.webContents.reload();
  });
  handleTrustedIpc("appSurface:destroy", ["main"], (_event, appId: string) => {
    destroyAppSurfaceView(appId);
  });
  handleTrustedIpc("appSurface:hide", ["main"], () => {
    hideAppSurface();
  });
  handleTrustedIpc(
    "appSurface:resolveUrl",
    ["main"],
    async (_event, workspaceId: string, appId: string, urlPath?: string) =>
      resolveAppSurfaceUrl(workspaceId, appId, urlPath),
  );
  handleTrustedIpc(
    "workspace:listOutputs",
    ["main"],
    async (_event, payload: string | HolabossListOutputsPayload) =>
      listOutputs(payload),
  );
  handleTrustedIpc(
    "workspace:listOutputFolders",
    ["main"],
    async (_event, workspaceId: string) => listOutputFolders(workspaceId),
  );
  handleTrustedIpc(
    "workspace:listSkills",
    ["main"],
    async (_event, workspaceId: string) => listWorkspaceSkills(workspaceId),
  );
  handleTrustedIpc(
    "workspace:getWorkspaceRoot",
    ["main"],
    async (_event, workspaceId: string) =>
      resolveLocalWorkspaceRoot(workspaceId),
  );
  handleTrustedIpc(
    "workspace:setOperatorSurfaceContext",
    ["main"],
    async (_event, workspaceId: string, context: unknown) => {
      const normalizedWorkspaceId = workspaceId.trim();
      if (!normalizedWorkspaceId) {
        return;
      }
      const normalizedContext = normalizeReportedOperatorSurfaceContext(context);
      if (!normalizedContext) {
        reportedOperatorSurfaceContexts.delete(normalizedWorkspaceId);
        return;
      }
      reportedOperatorSurfaceContexts.set(
        normalizedWorkspaceId,
        normalizedContext,
      );
    },
  );
  handleTrustedIpc(
    "workspace:createWorkspace",
    ["main"],
    async (_event, payload: HolabossCreateWorkspacePayload) =>
      desktopWorkspaceControlPlane.createWorkspace(payload),
  );
  handleTrustedIpc(
    "workspace:createWorkspaceLab",
    ["main"],
    async (
      _event,
      workspaceId: string,
      purpose: "workspace_onboarding" | "meeting_mode",
    ) => desktopWorkspaceControlPlane.createWorkspaceLab(workspaceId, purpose),
  );
  handleTrustedIpc(
    "workspace:deleteWorkspace",
    ["main"],
    async (_event, workspaceId: string, keepFiles?: boolean) =>
      desktopWorkspaceControlPlane.deleteWorkspace(workspaceId, keepFiles),
  );
  handleTrustedIpc(
    "workspace:updateAppearance",
    ["main"],
    async (
      _event,
      workspaceId: string,
      payload: { icon: string | null; iconColor: string | null },
    ) => {
      const safeId = String(workspaceId ?? "").trim();
      if (!safeId) {
        throw new Error("workspaceId is required");
      }
      const response = await runtimeClient.workspaces.update(safeId, {
        icon: payload?.icon ?? null,
        icon_color: payload?.iconColor ?? null,
      });
      return response;
    },
  );
  handleTrustedIpc(
    "workspace:listCronjobs",
    ["main"],
    async (_event, workspaceId: string, enabledOnly?: boolean) =>
      listCronjobs(workspaceId, enabledOnly),
  );
  handleTrustedIpc(
    "workspace:createCronjob",
    ["main"],
    async (_event, payload: CronjobCreatePayload) => createCronjob(payload),
  );
  handleTrustedIpc(
    "workspace:runCronjobNow",
    ["main"],
    async (_event, workspaceId: string, jobId: string, payload?: CronjobRunNowPayload) =>
      runCronjobNow(workspaceId, jobId, payload),
  );
  handleTrustedIpc(
    "workspace:updateCronjob",
    ["main"],
    async (_event, workspaceId: string, jobId: string, payload: CronjobUpdatePayload) =>
      updateCronjob(workspaceId, jobId, payload),
  );
  handleTrustedIpc(
    "workspace:deleteCronjob",
    ["main"],
    async (_event, workspaceId: string, jobId: string) =>
      deleteCronjob(workspaceId, jobId),
  );
  handleTrustedIpc(
    "workspace:listNotifications",
    ["main"],
    async (
      _event,
      workspaceId?: string | null,
      includeDismissed?: boolean,
      options?: {
        includeCronjobSource?: boolean;
        sourceType?: string | null;
      },
    ) => listNotifications(workspaceId, includeDismissed, options),
  );
  handleTrustedIpc(
    "workspace:updateNotification",
    ["main"],
    async (
      _event,
      workspaceId: string,
      notificationId: string,
      payload: RuntimeNotificationUpdatePayload,
    ) => updateNotification(workspaceId, notificationId, payload),
  );
  handleTrustedIpc(
    "workspace:listTaskProposals",
    ["main"],
    async (_event, workspaceId: string) => listTaskProposals(workspaceId),
  );
  handleTrustedIpc(
    "workspace:listBackgroundTasks",
    ["main"],
    async (_event, payload: BackgroundTaskListRequestPayload) =>
      listBackgroundTasks(payload),
  );
  handleTrustedIpc(
    "workspace:archiveBackgroundTask",
    ["main"],
    async (_event, payload: ArchiveBackgroundTaskPayload) =>
      archiveBackgroundTask(payload),
  );
  handleTrustedIpc(
    "workspace:continueBackgroundTask",
    ["main"],
    async (_event, payload: ContinueBackgroundTaskPayload) =>
      continueBackgroundTask(payload),
  );
  handleTrustedIpc(
    "workspace:acceptTaskProposal",
    ["main"],
    async (_event, payload: TaskProposalAcceptPayload) =>
      acceptTaskProposal(payload),
  );
  handleTrustedIpc(
    "workspace:updateTaskProposalState",
    ["main"],
    async (_event, workspaceId: string, proposalId: string, state: string) =>
      updateTaskProposalState(workspaceId, proposalId, state),
  );
  handleTrustedIpc(
    "workspace:listRuntimeStates",
    ["main"],
    async (_event, workspaceId: string) => listRuntimeStates(workspaceId),
  );
  handleTrustedIpc(
    "workspace:listAgentSessions",
    ["main"],
    async (_event, workspaceId: string) => listAgentSessions(workspaceId),
  );
  handleTrustedIpc(
    "workspace:ensureMainSession",
    ["main"],
    async (_event, workspaceId: string) => ensureWorkspaceMainSession(workspaceId),
  );
  handleTrustedIpc(
    "workspace:createAgentSession",
    ["main"],
    async (_event, payload: CreateAgentSessionPayload) =>
      createAgentSession(payload),
  );
  handleTrustedIpc(
    "workspace:getSessionHistory",
    ["main"],
    async (_event, payload: SessionHistoryRequestPayload) =>
      getSessionHistory(payload),
  );
  handleTrustedIpc(
    "workspace:getSessionOutputEvents",
    ["main"],
    async (_event, payload: SessionOutputEventListRequestPayload) =>
      getSessionOutputEvents(payload),
  );
  handleTrustedIpc(
    "workspace:stageSessionAttachments",
    ["main"],
    async (_event, payload: StageSessionAttachmentsPayload) =>
      stageSessionAttachments(payload),
  );
  handleTrustedIpc(
    "workspace:stageSessionAttachmentPaths",
    ["main"],
    async (_event, payload: StageSessionAttachmentPathsPayload) =>
      stageSessionAttachmentPaths(payload),
  );
  handleTrustedIpc(
    "workspace:queueSessionInput",
    ["main"],
    async (_event, payload: HolabossQueueSessionInputPayload) =>
      queueSessionInput(payload),
  );
  handleTrustedIpc(
    "workspace:getOnboardingStatus",
    ["main"],
    async (_event, workspaceId: string) => getOnboardingStatus(workspaceId),
  );
  handleTrustedIpc(
    "workspace:continueDeterministicOnboarding",
    ["main"],
    async (_event, workspaceId: string) =>
      continueDeterministicOnboarding(workspaceId),
  );
  handleTrustedIpc(
    "workspace:skipWorkspaceOnboarding",
    ["main"],
    async (_event, workspaceId: string) =>
      skipWorkspaceOnboarding(workspaceId),
  );
  handleTrustedIpc(
    "workspace:answerOnboardingAlignmentQuestion",
    ["main"],
    async (
      _event,
      workspaceId: string,
      payload: {
        optionId?: string | null;
        responseText?: string | null;
        notes?: string | null;
        answers?: Array<{
          questionId?: string | null;
          optionId?: string | null;
          responseText?: string | null;
          notes?: string | null;
        }>;
      },
    ) => answerOnboardingAlignmentQuestion(workspaceId, payload),
  );
  handleTrustedIpc(
    "workspace:approveOnboardingAlignment",
    ["main"],
    async (_event, workspaceId: string) =>
      approveOnboardingAlignment(workspaceId),
  );
  handleTrustedIpc(
    "workspace:requestOnboardingAlignmentRevision",
    ["main"],
    async (_event, workspaceId: string) =>
      requestOnboardingAlignmentRevision(workspaceId),
  );
  handleTrustedIpc(
    "workspace:requestOnboardingVerificationRevision",
    ["main"],
    async (_event, workspaceId: string) =>
      requestOnboardingVerificationRevision(workspaceId),
  );
  handleTrustedIpc(
    "workspace:completeOnboarding",
    ["main"],
    async (
      _event,
      workspaceId: string,
      payload: { summary: string; requestedBy?: string | null },
    ) => completeOnboarding(workspaceId, payload),
  );
  handleTrustedIpc(
    "workspace:pauseSessionRun",
    ["main"],
    async (_event, payload: HolabossPauseSessionRunPayload) =>
      pauseSessionRun(payload),
  );
  handleTrustedIpc(
    "workspace:updateQueuedSessionInput",
    ["main"],
    async (_event, payload: HolabossUpdateQueuedSessionInputPayload) =>
      updateQueuedSessionInput(payload),
  );
  handleTrustedIpc(
    "workspace:cancelQueuedSessionInput",
    ["main"],
    async (_event, payload: HolabossCancelQueuedSessionInputPayload) =>
      cancelQueuedSessionInput(payload),
  );
  handleTrustedIpc(
    "workspace:openSessionOutputStream",
    ["main"],
    async (_event, payload: HolabossStreamSessionOutputsPayload) =>
      openSessionOutputStream(payload),
  );
  handleTrustedIpc(
    "workspace:closeSessionOutputStream",
    ["main"],
    async (_event, streamId: string, reason?: string) =>
      closeSessionOutputStream(streamId, reason),
  );
  handleTrustedIpc("workspace:getSessionStreamDebug", ["main"], async () =>
    verboseTelemetryEnabled ? sessionStreamDebugLog.slice(-600) : [],
  );
  handleTrustedIpc(
    "workspace:isVerboseTelemetryEnabled",
    ["main"],
    async () => verboseTelemetryEnabled,
  );
  handleTrustedIpc("workspace:listIntegrationCatalog", ["main"], async () =>
    listIntegrationCatalog(),
  );
  handleTrustedIpc(
    "workspace:listIntegrationConnections",
    ["main"],
    async (_event, params?: { providerId?: string; ownerUserId?: string }) =>
      listIntegrationConnections(params),
  );
  handleTrustedIpc(
    "workspace:listIntegrationBindings",
    ["main"],
    async (_event, workspaceId: string) => listIntegrationBindings(workspaceId),
  );
  handleTrustedIpc(
    "workspace:getWorkspaceDefaultAccount",
    ["main"],
    async (_event, workspaceId: string, providerId: string) =>
      getWorkspaceDefaultAccount(workspaceId, providerId),
  );
  handleTrustedIpc(
    "workspace:setWorkspaceDefaultAccount",
    ["main"],
    async (
      _event,
      workspaceId: string,
      providerId: string,
      connectionId: string,
    ) => setWorkspaceDefaultAccount(workspaceId, providerId, connectionId),
  );
  handleTrustedIpc(
    "workspace:upsertIntegrationBinding",
    ["main"],
    async (
      _event,
      workspaceId: string,
      targetType: string,
      targetId: string,
      integrationKey: string,
      payload: IntegrationUpsertBindingPayload,
    ) =>
      upsertIntegrationBinding(
        workspaceId,
        targetType,
        targetId,
        integrationKey,
        payload,
      ),
  );
  handleTrustedIpc(
    "workspace:deleteIntegrationBinding",
    ["main"],
    async (_event, bindingId: string, workspaceId: string) =>
      deleteIntegrationBinding(bindingId, workspaceId),
  );
  handleTrustedIpc(
    "workspace:listConnectionWorkspaceUsage",
    ["main"],
    async () => listConnectionWorkspaceUsage(),
  );
  handleTrustedIpc(
    "workspace:listIntegrationStoreCatalog",
    ["main"],
    async () => listIntegrationStoreCatalog(),
  );
  handleTrustedIpc(
    "workspace:listAllWorkspaceIntegrationOverrides",
    ["main"],
    async () => listAllWorkspaceIntegrationOverrides(),
  );
  handleTrustedIpc(
    "workspace:listWorkspaceIntegrations",
    ["main"],
    async (_event, workspaceId: string) => listWorkspaceIntegrations(workspaceId),
  );
  handleTrustedIpc(
    "workspace:listMemoryBrowserTree",
    ["main"],
    async (_event, workspaceId: string) => listMemoryBrowserTree(workspaceId),
  );
  handleTrustedIpc(
    "workspace:readMemoryBrowserFile",
    ["main"],
    async (_event, workspaceId: string, targetPath: string) =>
      readMemoryBrowserFile(workspaceId, targetPath),
  );
  handleTrustedIpc(
    "workspace:listMemoryBrowserGraph",
    ["main"],
    async (
      _event,
      workspaceId: string,
      params: { forest: MemoryBrowserGraphForest; treeId?: string | null },
    ) => listMemoryBrowserGraph(workspaceId, params),
  );
  handleTrustedIpc(
    "workspace:setWorkspaceIntegrationOverride",
    ["main"],
    async (
      _event,
      workspaceId: string,
      toolkitSlug: string,
      payload: { state: "disabled" | "pinned"; pinned_connection_id?: string | null },
    ) => setWorkspaceIntegrationOverride(workspaceId, toolkitSlug, payload),
  );
  handleTrustedIpc(
    "workspace:clearWorkspaceIntegrationOverride",
    ["main"],
    async (_event, workspaceId: string, toolkitSlug: string) =>
      clearWorkspaceIntegrationOverride(workspaceId, toolkitSlug),
  );
  handleTrustedIpc(
    "workspace:restartApp",
    ["main"],
    async (_event, workspaceId: string, appId: string) =>
      restartWorkspaceApp(workspaceId, appId),
  );
  handleTrustedIpc(
    "workspace:createIntegrationConnection",
    ["main"],
    async (_event, payload: IntegrationCreateConnectionPayload) =>
      createIntegrationConnection(payload),
  );
  handleTrustedIpc(
    "workspace:updateIntegrationConnection",
    ["main"],
    async (
      _event,
      connectionId: string,
      payload: IntegrationUpdateConnectionPayload,
    ) => updateIntegrationConnection(connectionId, payload),
  );
  handleTrustedIpc(
    "workspace:deleteIntegrationConnection",
    ["main"],
    async (_event, connectionId: string) =>
      deleteIntegrationConnection(connectionId),
  );
  handleTrustedIpc(
    "workspace:mergeIntegrationConnections",
    ["main"],
    async (
      _event,
      keepConnectionId: string,
      removeConnectionIds: string[],
    ) =>
      mergeIntegrationConnections(keepConnectionId, removeConnectionIds),
  );
  handleTrustedIpc("workspace:listOAuthConfigs", ["main"], async () =>
    listOAuthConfigs(),
  );
  handleTrustedIpc(
    "workspace:upsertOAuthConfig",
    ["main"],
    async (_event, providerId: string, payload: OAuthAppConfigUpsertPayload) =>
      upsertOAuthConfig(providerId, payload),
  );
  handleTrustedIpc(
    "workspace:deleteOAuthConfig",
    ["main"],
    async (_event, providerId: string) => deleteOAuthConfig(providerId),
  );
  handleTrustedIpc(
    "workspace:startOAuthFlow",
    ["main"],
    async (_event, provider: string) => startOAuthFlow(provider),
  );
  handleTrustedIpc("workspace:composioListToolkits", ["main"], async () =>
    composioListToolkits(),
  );
  handleTrustedIpc("workspace:composioListConnections", ["main"], async () =>
    composioListConnections(),
  );
  // Unified entry point for any curated Composio action from the
  // desktop. Resolves the user's connection for `providerSlug`, then
  // POSTs /api/composio/internal/tools/execute with `toolSlug` and the
  // action-specific `arguments`. Invoke from the renderer dev console:
  //
  //   await window.electronAPI.workspace.composioExecute({
  //     providerSlug: "gmail",
  //     toolSlug: "GMAIL_FETCH_EMAILS",
  //     arguments: { max_results: 5 },
  //   })
  handleTrustedIpc(
    "workspace:composioExecute",
    ["main"],
    async (
      _event,
      params: {
        providerSlug: string;
        toolSlug: string;
        arguments?: Record<string, unknown>;
      },
    ) => composioExecute(params),
  );
  // Temporary diagnostic — runtime end-to-end probe through the new
  // ComposioApiClient. Button in IntegrationsPane fires this; remove
  // alongside the runtime endpoint once a real consumer lands.
  handleTrustedIpc(
    "workspace:debugComposioRuntimeTest",
    ["main"],
    async (
      _event,
      params?: {
        providerSlug?: string;
        toolSlug?: string;
        arguments?: Record<string, unknown>;
      },
    ) => debugComposioRuntimeTest(params ?? {}),
  );
  handleTrustedIpc(
    "workspace:fetchIntegrationContext",
    ["main"],
    async (_event, connectionId: string) => fetchIntegrationContext(connectionId),
  );
  handleTrustedIpc(
    "workspace:listIntegrationContextFetchStatuses",
    ["main"],
    async (_event, connectionIds?: string[]) =>
      listIntegrationContextFetchStatuses(
        Array.isArray(connectionIds) ? connectionIds : [],
      ),
  );
  handleTrustedIpc(
    "workspace:clearIntegrationMemory",
    ["main"],
    async (_event, connectionId: string) => clearIntegrationMemory(connectionId),
  );
  handleTrustedIpc(
    "workspace:composioConnect",
    ["main"],
    async (
      _event,
      payload: {
        provider: string;
        owner_user_id: string;
        callback_url?: string;
        whoami?: PendingIntegrationWhoami | null;
      },
    ) => composioConnect(payload),
  );
  handleTrustedIpc(
    "workspace:composioAccountStatus",
    ["main"],
    async (
      _event,
      connectedAccountId: string,
      providerId?: string | null,
    ) => {
      try {
        return providerId
          ? await composioAccountStatusEnriched(connectedAccountId, providerId)
          : await composioAccountStatus(connectedAccountId);
      } catch (err) {
        if (isComposioAccountMissingError(err)) {
          return missingComposioStatus(connectedAccountId);
        }
        throw err;
      }
    },
  );
  handleTrustedIpc(
    "workspace:composioFinalize",
    ["main"],
    async (
      _event,
      payload: {
        connected_account_id: string;
        provider: string;
        owner_user_id: string;
        account_label?: string;
      },
    ) => composioFinalize(payload),
  );
  handleTrustedIpc(
    "workspace:composioDeleteUpstream",
    ["main"],
    async (_event, connectedAccountId: string) =>
      composioDeleteUpstream(connectedAccountId),
  );
  handleTrustedIpc(
    "workspace:composioMcpEnsureRunning",
    ["main"],
    async (_event, workspaceId: string) => composioMcpEnsureRunning(workspaceId),
  );
  handleTrustedIpc(
    "workspace:composioRefreshConnection",
    ["main"],
    async (_event, connectionId: string) =>
      composioRefreshConnection(connectionId),
  );
  handleTrustedIpc(
    "workspace:resolveTemplateIntegrations",
    ["main"],
    async (_event, payload: HolabossCreateWorkspacePayload) =>
      resolveTemplateIntegrations(payload),
  );
  handleTrustedIpc(
    "workspace:createSubmission",
    ["main"],
    async (
      _event,
      payload: {
        workspaceId: string;
        name: string;
        description: string;
        authorName?: string;
        category: string;
        tags: string[];
        apps: string[];
        onboardingMd: string | null;
        readmeMd: string | null;
      },
    ) => {
      const holabossUserId = await controlPlaneWorkspaceUserId();
      const client = getMarketplaceAppSdkClient();
      // author_name is accepted by the backend but not yet reflected in the
      // kubb v3 generated SDK type (default-value fields are dropped).
      const body = {
        workspace_id: payload.workspaceId,
        name: payload.name,
        description: payload.description,
        category: payload.category,
        tags: payload.tags,
        apps: payload.apps,
        onboarding_md: payload.onboardingMd,
        readme_md: payload.readmeMd,
        holaboss_user_id: holabossUserId,
        author_name: payload.authorName ?? "",
      };
      return await sdkCreateMarketplaceSubmission(
        body as Parameters<typeof sdkCreateMarketplaceSubmission>[0],
        { client },
      );
    },
  );
  handleTrustedIpc(
    "workspace:packageAndUploadWorkspace",
    ["main"],
    async (
      event,
      params: {
        workspaceId: string;
        apps: string[];
        manifest: Record<string, unknown>;
        uploadUrl: string;
        forceExcludePaths?: string[];
      },
    ) => {
      const sender = event.sender;
      const emit = (
        phase: "packaging" | "uploading" | "done",
        detail: Record<string, unknown> = {},
      ) => {
        try {
          if (!sender.isDestroyed()) {
            sender.send("workspace:publishProgress", { phase, ...detail });
          }
        } catch {
          // best-effort
        }
      };
      try {
        const { packageWorkspace, uploadToPresignedUrl } =
          await import("./workspace-packager.js");
        const workspaceDir = await resolveWorkspaceDir(params.workspaceId);
        const runtimeUrl = runtimeBaseUrl();
        emit("packaging", { stage: "start" });
        const result = await packageWorkspace({
          workspaceDir,
          apps: params.apps,
          manifest: params.manifest,
          runtimeBaseUrl: runtimeUrl,
          workspaceId: params.workspaceId,
          forceExcludePaths: params.forceExcludePaths ?? [],
        });
        emit("packaging", { stage: "complete", archiveSizeBytes: result.archiveSizeBytes });
        emit("uploading", { stage: "start", totalBytes: result.archiveSizeBytes });
        await uploadToPresignedUrl(params.uploadUrl, result.archiveBuffer, {
          retries: 2,
          onProgress: ({ uploadedBytes, totalBytes }) => {
            emit("uploading", { stage: "progress", uploadedBytes, totalBytes });
          },
        });
        emit("done", { archiveSizeBytes: result.archiveSizeBytes });
        return { archiveSizeBytes: result.archiveSizeBytes };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emit("done", { error: msg });
        throw new Error(`packageAndUploadWorkspace failed: ${msg}`);
      }
    },
  );
  handleTrustedIpc(
    "workspace:previewBundle",
    ["main"],
    async (
      _event,
      params: { workspaceId: string; apps: string[]; forceExcludePaths?: string[] },
    ) => {
      const { previewBundle } = await import("./workspace-packager.js");
      const workspaceDir = await resolveWorkspaceDir(params.workspaceId);
      return previewBundle(workspaceDir, params.apps, params.forceExcludePaths ?? []);
    },
  );
  handleTrustedIpc(
    "workspace:checkTemplateName",
    ["main"],
    async (_event, name: string) => {
      // Local validation always runs; server check is best-effort and degrades
      // gracefully when the backend hasn't deployed the endpoint yet.
      const trimmed = (name ?? "").trim();
      const slug = trimmed
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 50);
      const localValid = trimmed.length > 0 && slug.length > 0;
      if (!localValid) {
        return { available: false, slug, conflict: null, reason: "invalid" as const };
      }
      try {
        const baseUrl = marketplaceBffBaseUrl();
        const cookie = await authCookieHeader();
        const url = `${baseUrl}/submissions/check-name?name=${encodeURIComponent(trimmed)}`;
        const res = await fetch(url, {
          method: "GET",
          headers: cookie ? { Cookie: cookie } : undefined,
        });
        if (!res.ok) {
          // Endpoint not ready — fall back to "available" so UI doesn't block.
          return { available: true, slug, conflict: null, reason: "fallback" as const };
        }
        const body = (await res.json()) as {
          available: boolean;
          slug: string;
          conflict?: "yours" | "other" | null;
          existing_template_id?: string | null;
        };
        return {
          available: body.available,
          slug: body.slug ?? slug,
          conflict: body.conflict ?? null,
          existingTemplateId: body.existing_template_id ?? null,
          reason: "checked" as const,
        };
      } catch {
        return { available: true, slug, conflict: null, reason: "fallback" as const };
      }
    },
  );
  handleTrustedIpc(
    "workspace:finalizeSubmission",
    ["main"],
    async (_event, submissionId: string) => {
      const holabossUserId = await controlPlaneWorkspaceUserId();
      const client = getMarketplaceAppSdkClient();
      return await sdkFinalizeMarketplaceSubmission(
        submissionId,
        { holaboss_user_id: holabossUserId },
        { client },
      );
    },
  );
  handleTrustedIpc(
    "workspace:generateTemplateContent",
    ["main"],
    async (
      _event,
      params: {
        contentType: "onboarding" | "readme";
        name: string;
        description: string;
        category: string;
        tags: string[];
        apps: string[];
      },
    ) => {
      const client = getMarketplaceAppSdkClient();
      return await sdkGenerateMarketplaceTemplateContent(
        {
          content_type: params.contentType,
          name: params.name,
          description: params.description,
          category: params.category,
          tags: params.tags,
          apps: params.apps,
        },
        { client },
      );
    },
  );
  handleTrustedIpc("workspace:listSubmissions", ["main"], async () => {
    const authorId = await controlPlaneWorkspaceUserId();
    if (!authorId) {
      throw new Error("Not authenticated — sign in first.");
    }
    const client = getMarketplaceAppSdkClient();
    const data = await sdkListMarketplaceSubmissions(
      { author_id: authorId },
      { client },
    );
    return data as SubmissionListResponsePayload;
  });
  handleTrustedIpc(
    "workspace:deleteSubmission",
    ["main"],
    async (_event: unknown, params: { submissionId: string }) => {
      const authorId = await controlPlaneWorkspaceUserId();
      if (!authorId) {
        throw new Error("Not authenticated — sign in first.");
      }
      const client = getMarketplaceAppSdkClient();
      const data = await sdkDeleteMarketplaceSubmission(
        params.submissionId,
        { author_id: authorId },
        { client },
      );
      return data as { deleted: boolean };
    },
  );
  handleTrustedIpc(
    "diagnostics:exportBundle",
    ["main"],
    async (_event, payload?: DiagnosticsExportRequestPayload) =>
      exportDesktopDiagnosticsBundle(payload),
  );
  handleTrustedIpc(
    "diagnostics:revealBundle",
    ["main"],
    async (_event, targetPath: string) => revealDiagnosticsBundle(targetPath),
  );
  handleTrustedIpc(
    "tabs:showContextMenu",
    ["main"],
    async (
      event,
      opts: {
        canCloseLeft: boolean;
        canCloseRight: boolean;
        canCloseOthers: boolean;
        hasDeleteFile: boolean;
      },
    ): Promise<
      | "close"
      | "closeOthers"
      | "closeToLeft"
      | "closeToRight"
      | "deleteFile"
      | null
    > => {
      type Action =
        | "close"
        | "closeOthers"
        | "closeToLeft"
        | "closeToRight"
        | "deleteFile";
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return null;
      return new Promise<Action | null>((resolve) => {
        let settled = false;
        const finish = (action: Action | null) => {
          if (settled) return;
          settled = true;
          resolve(action);
        };
        const template: MenuItemConstructorOptions[] = [
          {
            label: "Close tab",
            accelerator: "CmdOrCtrl+W",
            click: () => finish("close"),
          },
          {
            label: "Close others",
            enabled: opts.canCloseOthers,
            click: () => finish("closeOthers"),
          },
          {
            label: "Close tabs to the left",
            enabled: opts.canCloseLeft,
            click: () => finish("closeToLeft"),
          },
          {
            label: "Close tabs to the right",
            enabled: opts.canCloseRight,
            click: () => finish("closeToRight"),
          },
        ];
        if (opts.hasDeleteFile) {
          template.push(
            { type: "separator" },
            { label: "Delete file…", click: () => finish("deleteFile") },
          );
        }
        const menu = Menu.buildFromTemplate(template);
        menu.popup({ window: win, callback: () => finish(null) });
      });
    },
  );
  installBrowserPaneIpcHandlers({
    ipcMain,
    getMainWindow: () => mainWindow,
    getActiveWorkspaceId: () => activeBrowserWorkspaceId,
    getActiveSpaceId: () => activeBrowserSpaceId,
    getActiveSessionId: () => activeBrowserSessionId,
    ensureBrowserWorkspace: (workspaceId, space, sessionId) =>
      ensureBrowserWorkspace(workspaceId, space, sessionId) as unknown as ReturnType<
        Parameters<typeof installBrowserPaneIpcHandlers>[0]["ensureBrowserWorkspace"]
      >,
    setActiveBrowserWorkspace: (workspaceId, space, sessionId) =>
      setActiveBrowserWorkspace(workspaceId, space, sessionId),
    browserWorkspaceSnapshot: (workspaceId, space, sessionId, options) =>
      browserWorkspaceSnapshot(workspaceId, space, sessionId, options),
    emptyBrowserTabListPayload: (space) => emptyBrowserTabListPayload(space),
    browserTabSpaceState: (workspace, space, sessionId, options) =>
      browserTabSpaceState(
        workspace as unknown as BrowserWorkspaceState | null | undefined,
        space,
        sessionId,
        options,
      ) as unknown as ReturnType<
        Parameters<typeof installBrowserPaneIpcHandlers>[0]["browserTabSpaceState"]
      >,
    setBrowserBounds: (bounds) => setBrowserBounds(bounds),
    captureVisibleBrowserSnapshot: () => captureVisibleBrowserSnapshot(),
    navigateActiveBrowserTab: (workspaceId, targetUrl, space, sessionId) =>
      navigateActiveBrowserTab(workspaceId, targetUrl, space, sessionId),
    getActiveBrowserTab: (workspaceId, space, sessionId, options) =>
      getActiveBrowserTab(workspaceId, space, sessionId, options) as unknown as ReturnType<
        Parameters<typeof installBrowserPaneIpcHandlers>[0]["getActiveBrowserTab"]
      >,
    activeVisibleBrowserTarget: () => activeVisibleBrowserTarget(),
    currentBrowserTabPageTitle: (tab) => currentBrowserTabPageTitle(tab as unknown as BrowserTabRecord),
    currentBrowserTabUrl: (tab) => currentBrowserTabUrl(tab as unknown as BrowserTabRecord),
    createBrowserTab: (workspaceId, options) =>
      createBrowserTab(workspaceId, options),
    setActiveBrowserTab: (tabId, options) => setActiveBrowserTab(tabId, options),
    closeBrowserTab: (tabId, options) => closeBrowserTab(tabId, options),
    setVisibleAgentBrowserSession: (workspace, sessionId) =>
      setVisibleAgentBrowserSession(
        workspace as unknown as BrowserWorkspaceState,
        sessionId,
      ),
    updateAttachedBrowserView: () => updateAttachedBrowserView(),
    emitBrowserState: (workspaceId, space) => emitBrowserState(workspaceId, space),
    persistWorkspace: (workspaceId) => persistBrowserWorkspace(workspaceId),
    maybePromptBrowserInterrupt: (workspaceId, space, sessionId) =>
      maybePromptBrowserInterrupt(workspaceId, space, sessionId),
    emitBookmarksState: (workspaceId) => emitBookmarksState(workspaceId),
    emitDownloadsState: (workspaceId) => emitDownloadsState(workspaceId),
    emitHistoryState: (workspaceId) => emitHistoryState(workspaceId),
    popups: browserPanePopups,
    importChromeProfileIntoWorkspace: (workspaceId) =>
      importChromeProfileIntoWorkspace(workspaceId),
    isAbortedBrowserLoadError: (error) => isAbortedBrowserLoadError(error),
  });


  createMainWindow();
  configureAutoUpdater();
  scheduleAppUpdateChecks();
  void checkForAppUpdates();
  try {
    await startDesktopBrowserService();
  } catch (error) {
    void appendRuntimeLog(
      `[desktop-browser-service] failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  runtimeStatus = withDesktopBrowserStatus({
    ...runtimeStatus,
    status: "starting",
    url: runtimeBaseUrl(),
    sandboxRoot: runtimeSandboxRoot(),
    harness: process.env.HOLABOSS_RUNTIME_HARNESS || "pi",
    startupMessage: runtimeStartupMessage(),
    lastError: "",
  });
  emitRuntimeState();
  void startEmbeddedRuntime();
  startupAuthSyncPromise = syncPersistedAuthSessionOnStartup()
    .catch(() => undefined)
    .finally(() => {
      startupAuthSyncPromise = null;
    });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (appQuitCleanupFinished) {
    return;
  }
  event.preventDefault();
  void ensureAppQuitCleanup().finally(() => {
    app.quit();
  });
});
