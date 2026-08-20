// holaboss-2026.616.1 bundle cycle: cdhash 1ee72b15 stuck in Apple notary; bump bytes to force fresh ticket.
import { loadDesktopEnv } from "./desktopEnv";
import { applyLoginShellPathToEnv } from "./shell-path";
import { ensureExtractedWindowsRuntime } from "./runtime-archive";
import {
  resolveStagedAttachmentMimeType,
  stagedAttachmentKind,
} from "./attachment-staging";
import {
  HEIC_CONVERSION_OUTPUT_EXTENSION,
  HEIC_CONVERSION_OUTPUT_MIME_TYPE,
  convertHeicBufferToJpeg,
  convertHeicFileToJpeg,
  isHeicAttachmentMimeType,
  replaceAttachmentExtension,
} from "./heic-conversion";
import { normalizeInlineImageMaterialization } from "./image-normalization";
import { app as electronApp } from "electron";

import {
  type ChatStartAttachment,
  type ChatStartInput,
  type ChatStartResult,
  type EmployeesChangedInput,
  HOST_COLOR_SCHEME_CHANGED,
  HOST_EMPLOYEES_CHANGED_EVENT,
  HOST_INSTALL_EVENT,
  HOST_INSTALL_RESULT,
  HOST_INSTALL_STATUS_EVENT,
  HOST_INSTALL_STATUS_RESULT,
  HOST_IPC,
  HOST_OPEN_APP_EVENT,
  HOST_OPS,
  HOST_RENDERER_EVENT,
  type HostColorScheme,
  type HostResult,
  type InstalledItem,
  type InstalledList,
  type InstallInput,
  type InstallResult,
  type InstallResultMessage,
  type InstallStatusResultMessage,
  type OpenItemInput,
  type OpenItemResult,
  type ShareDraft,
} from "@holaboss/app-host/protocol";

loadDesktopEnv();

// GUI launches don't inherit the user's shell PATH, so binaries on
// shell-managed dirs — notably the Claude Code native installer's
// ~/.local/bin/claude (claude.exe on Windows) and npm-global CLIs in
// %APPDATA%\npm — are invisible to the embedded runtime's PATH probe + spawn.
// On macOS/Linux we resolve the login-shell PATH; on Windows we append the
// well-known per-user install dirs. Run before anything spawns child
// processes. Safe no-op when nothing needs adding.
applyLoginShellPathToEnv();

function initialDesktopAppName(): string {
  if (
    process.platform === "darwin" &&
    (!electronApp.isPackaged ||
      process.env.HOLABOSS_INTERNAL_DEV?.trim() === "1")
  ) {
    return "holaOS Dev";
  }
  return "holaOS";
}

electronApp.setName(initialDesktopAppName());


/**
 * Main-process crash visibility.
 *
 * Registering an `uncaughtException` listener suppresses Electron's own error
 * dialog and its non-zero exit, so whatever these handlers do IS the entire
 * crash story. Previously that was a bare `console.error`, which a packaged
 * app has nowhere to show: every production main-process crash was invisible,
 * and the process carried on in a half-broken state.
 *
 * There is no crash reporter behind this. Earlier comments here described
 * Sentry's `consoleLoggingIntegration` and "the existing Sentry + Electron
 * handlers" as if they were catching the rest; no `@sentry/*` dependency has
 * ever been in this package, `crashReporter` is never started, and the
 * renderer registers no `onerror`. Those comments have been removed rather
 * than left to reassure the next reader.
 *
 * So: mirror everything into runtime.log, which the diagnostics bundle
 * already collects — that makes a packaged crash recoverable after the fact
 * from a user's exported diagnostics instead of lost.
 */
function recordMainProcessCrash(kind: string, detail: unknown): void {
  const text =
    detail instanceof Error
      ? (detail.stack ?? `${detail.name}: ${detail.message}`)
      : String(detail);
  // eslint-disable-next-line no-console
  console.error(`[${kind}]`, detail);
  // Never let crash recording itself throw inside a crash handler. The try is
  // not redundant with the .catch: appendRuntimeLog closes over module-scope
  // state declared much further down this file, so a crash raised during early
  // module evaluation would hit its temporal dead zone synchronously.
  try {
    void appendRuntimeLog(`[${kind}] ${text}`).catch(() => undefined);
  } catch {
    // Logging unavailable this early — the console.error above still stands.
  }
}

// EPIPE on stdio writes is a benign teardown race that Electron would
// otherwise surface as a "holaOS encountered an error" modal. Trigger: a
// child / utility process (or the embedded runtime) writes via
// `console.info`/`.warn`/`.error` after its stdio pipe has been closed on the
// parent side. Suppressed silently and deliberately; everything else is
// recorded.
process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err?.code === "EPIPE") return;
  recordMainProcessCrash("uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
  recordMainProcessCrash("unhandledRejection", reason);
});

import {
  readJsonStateFile,
  writeJsonStateFileAtomically,
} from "./json-state-file.js";
import { electronClient } from "@better-auth/electron/client";
import { storage as electronAuthStorage } from "@better-auth/electron/storage";
import { createAuthClient } from "better-auth/client";
import { organizationClient } from "better-auth/client/plugins";
import Database from "better-sqlite3";
import {
  autoUpdater,
  type ProgressInfo,
  type UpdateInfo,
} from "electron-updater";
import {
  app,
  autoUpdater as electronAutoUpdater,
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
  powerSaveBlocker,
  screen,
  session,
  shell,
  systemPreferences,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type SaveDialogOptions,
  type Session,
  type WebContents,
} from "electron";
import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
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
import { URL, pathToFileURL } from "node:url";
import JSZip from "jszip";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  createMarketplaceSubmission as sdkCreateMarketplaceSubmission,
  deleteMarketplaceSubmission as sdkDeleteMarketplaceSubmission,
  finalizeMarketplaceSubmission as sdkFinalizeMarketplaceSubmission,
  generateMarketplaceTemplateContent as sdkGenerateMarketplaceTemplateContent,
  listMarketplaceSubmissions as sdkListMarketplaceSubmissions,
  materializeMarketplaceTemplate as sdkMaterializeMarketplaceTemplate,
} from "@holaboss/app-sdk/core";
import {
  type ModelCatalogInputModality,
} from "../shared/model-catalog.js";
import type { OnboardingAlignmentReport } from "../../../shared/onboarding-contract.js";
import * as modelCatalog from "../shared/model-catalog.js";
import { buildAppSdkClient } from "./appSdkClient.js";
import {
  bootstrapLocalControlPlaneDatabase,
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
import {
  createComposioEventsBridge,
  type ComposioEventsBridge,
} from "./composio-events-bridge.js";
import {
  createBrowserHttpService,
  type BrowserHttpService,
} from "./browser-pane/http-service.js";
import type {
  BrowserImportProfileOptionPayload,
  BrowserImportSource,
  ChromiumFamilyBrowser,
} from "./browser-pane/types.js";
import {
  BROWSER_PROFILE_ID_PREFIX,
  browserAcceptedLanguages as browserAcceptedLanguagesUtil,
  browserChromeLikePlatformToken as browserChromeLikePlatformTokenUtil,
  browserProfilePartition as browserProfilePartitionUtil,
  browserProfileStorageDir as browserProfileStorageDirUtil,
  browserSessionId as browserSessionIdUtil,
  browserSpaceId as browserSpaceIdUtil,
  browserWorkspacePartition as browserWorkspacePartitionUtil,
  isBrowserProfileId,
} from "./browser-pane/utils.js";
import {
  addBrowserProfile,
  assignBrowserProfileDebugPort,
  type BrowserProfileIndex,
  DEFAULT_BROWSER_PROFILE_ID,
  emptyBrowserProfileIndex,
  ensureDefaultBrowserProfile,
  ensureProfileFingerprint,
  getBrowserProfile,
  normalizeBrowserProfileIndex,
  removeBrowserProfile,
  renameBrowserProfile,
  resolveDefaultBrowserProfileId,
  setDefaultBrowserProfile,
} from "./browser-pane/profile-store.js";
import {
  FINGERPRINT_SEED_MAX,
  FINGERPRINT_SEED_MIN,
  sanitizeFingerprint,
  sanitizeProxy,
  validateFingerprintCoherence,
} from "./browser-pane/fingerprint.js";
import {
  type FingerprintServiceClient,
  isFingerprintEnginePresent,
  loadFingerprintService,
} from "./browser-pane/fingerprint-engine-seam.js";
import {
  installedEngineInfo,
  installFromUrl,
  installFromZip,
  type InstallProgress,
  resolveEngineDownloadUrl,
} from "./browser-pane/fingerprint-engine-installer.js";
import {
  addFingerprintTemplate,
  emptyFingerprintTemplateIndex,
  type FingerprintTemplateIndex,
  FINGERPRINT_TEMPLATE_ID_PREFIX,
  normalizeFingerprintTemplate,
  normalizeFingerprintTemplateIndex,
  removeFingerprintTemplate,
} from "./browser-pane/fingerprint-template-store.js";
import { FINGERPRINT_PRESETS } from "./browser-pane/fingerprint-presets.js";
import { copyChromiumProfileIntoUserDataDir } from "./browser-pane/import-chrome-profile.js";
import {
  captureCookiesFromChromeProfile,
  clearPendingImportedCookies,
  readPendingImportedCookies,
  writePendingImportedCookies,
} from "./browser-pane/cdp-cookie-transfer.js";
import {
  chromiumFamilyDisplayName,
  discoverChromiumFamilyImportProfiles,
} from "./browser-pane/import-chromium.js";
import {
  disconnectProfileCdp,
  profileCdpAddCookies,
  profileCdpCookies,
  profileCdpEvaluate,
  profileCdpKeyboard,
  profileCdpMouse,
  profileCdpNavigate,
  profileCdpOpenTab,
  profileCdpPageInfo,
  profileCdpScreenshot,
  profileCdpSetCookie,
  profileCdpTryAdopt,
} from "./profile-cdp.js";
import type {
  BrowserProfile,
  BrowserProfileSource,
  FingerprintPlatform,
  FingerprintTemplate,
  ProfileEngine,
  ProfileFingerprint,
} from "../shared/browser-pane-protocol.js";

const APP_DISPLAY_NAME = "holaOS";
const MAC_APP_MENU_PRODUCT_LABEL = "holaOS";
const MAC_DEV_APP_MENU_PRODUCT_LABEL = "holaOS Dev";
const AUTH_CALLBACK_PROTOCOL = "ai.holaboss.app";
const DESKTOP_LAUNCH_ID = randomUUID();
const nodeRequire = createRequire(__filename);

import type ExcelJSNamespace from "exceljs";
import type { IWorkbookData } from "@univerjs/core";
import { buildUniverWorkbookSnapshot } from "./spreadsheet/univer-snapshot.js";
import { applyUniverEditsToWorkbook } from "./spreadsheet/univer-writeback.js";
type ExcelJSWorkbook = ExcelJSNamespace.Workbook;
type ExcelJSWorksheet = ExcelJSNamespace.Worksheet;
type ExcelJSCell = ExcelJSNamespace.Cell;

interface ExcelJSModule {
  Workbook: new () => ExcelJSWorkbook;
}

const ExcelJS = nodeRequire("exceljs") as ExcelJSModule;

interface MammothConvertResult {
  value: string;
  messages: Array<{ type: string; message: string }>;
}
interface MammothModule {
  convertToHtml(input: { buffer: Buffer }): Promise<MammothConvertResult>;
  extractRawText(input: { buffer: Buffer }): Promise<MammothConvertResult>;
}
const mammoth = nodeRequire("mammoth") as MammothModule;

type HtmlToDocxFn = (
  html: string,
  headerHtml?: string | null,
  options?: Record<string, unknown>,
  footerHtml?: string | null,
) => Promise<Buffer>;
const htmlToDocx = nodeRequire("html-to-docx") as HtmlToDocxFn;

// Native macOS privacy-permission triggers (CGRequestScreenCaptureAccess etc.).
// Electron has no screen-recording request API — desktopCapturer.getSources
// only pre-checks and rejects, so it never registers the app. This module wraps
// the real CoreGraphics request call. Rebuilt for Electron via rebuild-native.
// It's a darwin-only native module (package.json `optionalDependencies`,
// os:["darwin"]) so it isn't installed or packaged on Windows/Linux — require it
// lazily and only behind a `process.platform === "darwin"` guard. A top-level
// import/require would throw MODULE_NOT_FOUND on app launch on those platforms.
function loadMacPermissions(): typeof import("node-mac-permissions") {
  return nodeRequire(
    "node-mac-permissions",
  ) as typeof import("node-mac-permissions");
}

const verboseTelemetryEnabled =
  process.env.HOLABOSS_VERBOSE_TELEMETRY?.trim() === "1";
const chromiumStderrLoggingEnabled =
  process.env.HOLABOSS_CHROMIUM_STDERR_LOGS?.trim() === "1";
const HOME_URL = "https://www.google.com";
// A fingerprint (anti-detect) profile lands here on a plain human Launch, so you
// immediately see how the identity presents — IP/WebRTC/DNS leaks, timezone
// coherence, canvas/WebGL, bot detection. Overridable per launch (a named URL) and
// skipped for agent auto-launches (they land on about:blank to claim the tab).
const FINGERPRINT_DEFAULT_LANDING_URL = "https://www.browserscan.net";
// A launched fingerprint profile presents as the host product (not "Camoufox") in
// the macOS dock / menu bar — the engine stamps this name + icon onto the shared
// Camoufox.app bundle (see @holaboss/fingerprint-ee brand.ts). One constant to
// change if we ever want a distinct browser sub-brand (e.g. "holaOS Browser").
const FINGERPRINT_BROWSER_BRAND_NAME = "holaOS";
const AUTH_POPUP_WIDTH = 380;
const AUTH_POPUP_HEIGHT = 460;
const AUTH_POPUP_CLOSE_DELAY_MS = 260;
const AUTH_POPUP_MARGIN_PX = 8;
const MAIN_WINDOW_CLOSED_LISTENER_BUFFER = 8;
const MAIN_WINDOW_MIN_LISTENER_BUDGET = 32;
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
const HOLABOSS_HOME_URL = "https://www.holaos.ai";
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
const RUNTIME_REMOVED_PROVIDER_IDS = new Set([
  "openai_codex",
  "openai_direct",
  "anthropic_direct",
  "gemini_direct",
  "ollama_direct",
  "ollama_local",
  "openrouter_direct",
  "minimax",
  "minimax_direct",
]);
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

// Deep links share the ai.holaboss.app scheme. `maybeAuthCallbackUrl` above is
// the scheme-prefix filter (picks our URL out of argv / commandLine); the host
// then decides intent — `open-app` opens a HolaApp surface, anything else is
// the OAuth callback. e.g. ai.holaboss.app://open-app?appId=gofunds[&path=/x]
/** Our scheme, parsed — or null for anything that isn't one of our deep links. */
function deepLinkUrl(argument: string | undefined): URL | null {
  if (!argument) {
    return null;
  }
  const normalized = argument.trim();
  if (!normalized.startsWith(`${AUTH_CALLBACK_PROTOCOL}:`)) {
    return null;
  }
  try {
    return new URL(normalized);
  } catch {
    return null;
  }
}

function maybeOpenAppUrl(
  argument: string | undefined,
): { appId: string; path?: string } | null {
  const parsed = deepLinkUrl(argument);
  if (!parsed || parsed.hostname !== "open-app") {
    return null;
  }
  const appId = parsed.searchParams.get("appId")?.trim();
  if (!appId) {
    return null;
  }
  const pathParam = parsed.searchParams.get("path")?.trim();
  return { appId, path: pathParam || undefined };
}

// A deep link that arrived before the renderer's DeepLinkAppOpener mounted (cold
// start / pre-sign-in / no workspace yet). The renderer pulls it via the
// consumePendingDeepLink IPC when it mounts, so no app-open link is lost.
let pendingOpenAppDeepLink: { appId: string; path?: string } | null = null;

// Deep link → open a HolaApp surface. Focus the window and hand off to the
// renderer, which drives the real useOpenHolaApp() flow (web surface + bridge).
// Also stash it as pending: on a cold start the send below has no subscriber
// yet, so the renderer consumes the pending target once it's ready.
function handleOpenAppDeepLink(target: {
  appId: string;
  path?: string;
}): void {
  pendingOpenAppDeepLink = target;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
    mainWindow.webContents.send("holaApp:openFromDeepLink", target);
  }
}

// `open-app` is the wrong verb for most of what the web hands over. Pressing Try
// this / Remix / Use as reference INSIDE the desktop installs what the post names
// and opens a composer; pressing Open in desktop on a skill opens a General chat
// carrying it. Expressed as "open a HolaApp surface", both arrive as a webview of
// HolaHub with the click undone — which is not what either button does here.
//
// These two verbs name the action instead, and land on the same functions the
// host bridge already calls for the in-desktop press.
function maybeHubActionUrl(
  argument: string | undefined,
): { postId: string; action: string; mediaId?: string } | null {
  const parsed = deepLinkUrl(argument);
  if (!parsed || parsed.hostname !== "hub-action") {
    return null;
  }
  const postId = parsed.searchParams.get("postId")?.trim();
  const action = parsed.searchParams.get("action")?.trim();
  if (!postId || !action) {
    return null;
  }
  const mediaId = parsed.searchParams.get("mediaId")?.trim();
  return { postId, action, ...(mediaId ? { mediaId } : {}) };
}

function maybeOpenItemUrl(
  argument: string | undefined,
): { type: string; ref: string; title?: string } | null {
  const parsed = deepLinkUrl(argument);
  if (!parsed || parsed.hostname !== "open-item") {
    return null;
  }
  const type = parsed.searchParams.get("type")?.trim();
  const ref = parsed.searchParams.get("ref")?.trim();
  if (!type || !ref) {
    return null;
  }
  const title = parsed.searchParams.get("title")?.trim();
  return { type, ref, ...(title ? { title } : {}) };
}

interface HubHandoff {
  action: string;
  title: string;
  prompt: string;
  model?: string;
  imageModel?: string;
  videoModel?: string;
  skillIds?: string[];
  items?: { type: string; ref: string }[];
  attachment?: {
    mediaId: string;
    kind: "image" | "video" | "file";
    /** A document's real name — it does not survive the trip to the bytes. */
    fileName?: string;
    contentType?: string;
  };
}

/** The shared artifact itself, for Use as reference. Best-effort: a reference
 *  that will not load is worth less than the hand-off it would otherwise block. */
async function hubReferenceAttachment(
  attachment: NonNullable<HubHandoff["attachment"]>,
): Promise<ChatStartAttachment | null> {
  try {
    const { mediaId, kind } = attachment;
    const url =
      kind === "file"
        ? `${AUTH_BASE_URL}/gateway/hub/public/file/${mediaId}/download`
        : `${AUTH_BASE_URL}/gateway/hub/public/media/${kind}/${mediaId}/bytes`;
    const response = await fetch(url, {
      headers: { Cookie: authCookieHeader() },
    });
    if (!response.ok) {
      return null;
    }
    const contentType =
      attachment.contentType ||
      response.headers.get("content-type") ||
      (kind === "video" ? "video/mp4" : "image/png");
    const buffer = Buffer.from(await response.arrayBuffer());
    // Name it after what it actually is — handing a composer an mp4 called
    // reference.png makes every downstream sniff of the extension wrong.
    const extension = contentType.split("/")[1]?.split(";")[0] || "bin";
    return {
      fileName: attachment.fileName || `reference.${extension}`,
      contentType,
      dataBase64: buffer.toString("base64"),
    };
  } catch {
    return null;
  }
}

// Try this / Remix / Use as reference, arriving from the web. HolaHub can only
// fire the link; the work is the same work the in-desktop press does, so it runs
// here: install what the post names, then open the composer seeded with it.
async function runHubActionDeepLink(target: {
  postId: string;
  action: string;
  mediaId?: string;
}): Promise<void> {
  try {
    const query = new URLSearchParams({ action: target.action });
    if (target.mediaId) {
      query.set("mediaId", target.mediaId);
    }
    const response = await fetch(
      `${AUTH_BASE_URL}/gateway/hub/posts/${encodeURIComponent(target.postId)}/handoff?${query}`,
      { headers: { Cookie: authCookieHeader() } },
    );
    if (!response.ok) {
      console.warn(`[hub-action] handoff ${target.action}: ${response.status}`);
      return;
    }
    const handoff = (await response.json()) as HubHandoff;

    // Best-effort, exactly as the in-desktop press treats it: an item that needs
    // connecting opens its own flow, and a failure there must not cost the
    // reader the session they asked for.
    await Promise.allSettled(
      (handoff.items ?? []).map((item) =>
        hostInstall(
          { appId: HUB_APP_ID },
          { type: item.type as InstallInput["type"], ref: item.ref },
        ),
      ),
    );

    const attachment = handoff.attachment
      ? await hubReferenceAttachment(handoff.attachment)
      : null;
    if (handoff.attachment && !attachment) {
      console.warn("[hub-action] reference bytes unavailable — not seeding");
      return;
    }

    await hostChatStart(
      { appId: HUB_APP_ID },
      {
        title: handoff.title,
        prompt: handoff.prompt,
        ...(handoff.model ? { model: handoff.model } : {}),
        ...(handoff.imageModel ? { imageModel: handoff.imageModel } : {}),
        ...(handoff.videoModel ? { videoModel: handoff.videoModel } : {}),
        ...(handoff.skillIds?.length ? { skillIds: handoff.skillIds } : {}),
        ...(attachment ? { attachments: [attachment] } : {}),
        // HolaHub is a system surface with no app row of its own to live under.
        general: true,
        newSession: true,
      },
    );
  } catch (error) {
    console.warn("[hub-action] failed", error);
  }
}

function focusMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  }
}

// Single entry for every ai.holaboss.app:// deep link. Every known verb is split
// off before the fallthrough, so an action link is never misread as an auth
// token — which is what an unrecognised hostname becomes.
function dispatchDeepLink(targetUrl: string): void {
  const openApp = maybeOpenAppUrl(targetUrl);
  if (openApp) {
    handleOpenAppDeepLink(openApp);
    return;
  }
  const hubAction = maybeHubActionUrl(targetUrl);
  if (hubAction) {
    focusMainWindow();
    void runHubActionDeepLink(hubAction);
    return;
  }
  const openItem = maybeOpenItemUrl(targetUrl);
  if (openItem) {
    focusMainWindow();
    void hostItemOpen(
      { appId: HUB_APP_ID },
      {
        type: openItem.type as OpenItemInput["type"],
        ref: openItem.ref,
        ...(openItem.title ? { title: openItem.title } : {}),
      },
    );
    return;
  }
  void handleAuthCallbackUrl(targetUrl);
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
  // runtime ports such as http://localhost:38090 during development. `data:`
  // is what a file preview frames a PDF from — the payload arrives as a data
  // URL, the same way images and video already do under img-src/media-src.
  "frame-src 'self' data: http://localhost:* http://127.0.0.1:* https:",
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

function configureEmbeddedOAuthCompatPolicy() {
  // Chromium ≥115 partitions third-party storage by top-level site, so a cookie
  // Gaia sets during an OAuth popup opened from a third-party HolaApp surface can
  // land in a partitioned jar and fail read-back mid-redirect — Google then serves
  // its "problem with your cookie settings" (CookieMismatch) page and sign-in dies.
  // Un-partition so embedded OAuth cookies survive the redirect chain.
  // Also disable UA client hints: Electron advertises a Chromium-only brand list
  // (no "Google Chrome") in Sec-CH-UA / navigator.userAgentData, which Gaia flags
  // as an unsupported/embedded client ("this browser may not be secure"). The
  // main-frame navigation's hints aren't reachable from webRequest, so suppress
  // them entirely and let Gaia fall back to the (stripped, plain-Chrome) UA string.
  app.commandLine.appendSwitch(
    "disable-features",
    "ThirdPartyStoragePartitioning,TrackingProtection3pcd,ThirdPartyCookieDeprecation,UserAgentClientHint",
  );
}

function shouldUseMacMockKeychain(): boolean {
  if (process.platform !== "darwin") {
    return false;
  }
  const override = process.env.HOLABOSS_MAC_USE_MOCK_KEYCHAIN?.trim();
  if (override === "1") {
    return true;
  }
  if (override === "0") {
    return false;
  }
  return !app.isPackaged || process.env.HOLABOSS_INTERNAL_DEV?.trim() === "1";
}

function configureMacKeychainPolicy() {
  if (!shouldUseMacMockKeychain()) {
    return;
  }
  // macOS otherwise persists Chromium secrets in Keychain Access under the
  // app's "Safe Storage" item, which blocks local/dev launches with an OS
  // password prompt as soon as any workspace browser profile has cookies.
  app.commandLine.appendSwitch("use-mock-keychain");
}

configureChromiumLoggingPolicy();
configureMacKeychainPolicy();
configureEmbeddedOAuthCompatPolicy();

function shouldUseDevMacAppIdentity(): boolean {
  return (
    process.platform === "darwin" &&
    (!app.isPackaged || process.env.HOLABOSS_INTERNAL_DEV?.trim() === "1")
  );
}

function configuredMacAppMenuProductLabel(): string {
  return shouldUseDevMacAppIdentity()
    ? MAC_DEV_APP_MENU_PRODUCT_LABEL
    : MAC_APP_MENU_PRODUCT_LABEL;
}

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
  | "video"
  | "pdf"
  | "table"
  | "presentation"
  | "document"
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
  univerSnapshot?: IWorkbookData;
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

const BROWSER_SPACE_IDS = ["agent"] as const;

type BrowserSpaceId = (typeof BROWSER_SPACE_IDS)[number];

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

interface BrowserSessionIdentity {
  userAgent: string;
  acceptLanguages: string;
}

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

// Sections the settings screen can actually render (SettingsScreenRoot's
// SETTINGS_NAV + its submissions branch). Kept identical in main.ts,
// preload.ts, authPopupPreload.ts and electron.d.ts.
//
// These four had drifted to four different lists, and three of the values they
// carried between them — "providers", "integrations", "about" — matched no
// render branch at all, so passing one opened Settings with a blank pane and
// no nav item selected.
type UiSettingsPaneSection =
  | "account"
  | "agents"
  | "billing"
  | "byok"
  | "channels"
  | "experimental"
  | "memory"
  | "settings"
  | "submissions";

const UI_SETTINGS_PANE_SECTIONS: readonly UiSettingsPaneSection[] = [
  "account",
  "agents",
  "billing",
  "byok",
  "channels",
  "experimental",
  "memory",
  "settings",
  "submissions",
];

/** Unknown sections fall back to General rather than opening a blank pane. */
function normalizeUiSettingsPaneSection(
  section: unknown,
): UiSettingsPaneSection {
  return UI_SETTINGS_PANE_SECTIONS.includes(section as UiSettingsPaneSection)
    ? (section as UiSettingsPaneSection)
    : "settings";
}

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
  contextWindow?: number;
  maxTokens?: number;
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
  orgId?: string | null;
  byoOrgId?: string | null;
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
  timezone: string | null;
  nameSource: RuntimeUserProfileNameSource | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface RuntimeUserProfileUpdatePayload {
  profileId?: string | null;
  name?: string | null;
  timezone?: string | null;
  nameSource?: RuntimeUserProfileNameSource | null;
}

interface AuthUserPayload {
  id: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
  timezone?: string | null;
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
let attachedAppSurfaceView: BrowserView | null = null;
let currentTheme = "holaos-light";
let activeBrowserWorkspaceId = "";
let activeBrowserSpaceId: BrowserSpaceId = "agent";
let activeBrowserSessionId = "";
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
// Surface keys whose last main-frame load failed — a reveal-in-place would pin
// the error page, so those reopen with a real load instead.
const appSurfaceLoadFailed = new Set<string>();
// Identity of each app-surface BrowserView keyed by its webContents.id, so a
// host-bridge IPC call can be resolved to its owning app WITHOUT trusting ids
// sent by the (untrusted) hosted page. Set on navigate, cleared on destroy.
// `workspaceId` is carried only by local app-builder surfaces; web HolaApps
// omit it (the single-tenant runtime resolves the workspace server-side).
const appSurfaceIdentity = new Map<
  number,
  { appId: string; workspaceId?: string }
>();
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
let composioEventsBridge: ComposioEventsBridge | null = null;
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
let appUpdateInstallInProgress = false;
let appUpdatePreferences: AppUpdatePreferencesPayload = {};
let notificationPreferences: { enabled: boolean } = { enabled: true };
let keepAwakePreferences: { enabled: boolean } = { enabled: true };
let keepAwakeBlockerId: number | null = null;
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

function safeWebContentsUrl(contents: WebContents): string | null {
  try {
    return contents.getURL() || null;
  } catch {
    return null;
  }
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
  webAppBaseUrl?: string;
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
// The web frontend origin that hosts web HolaApp pages (need-review et al.) —
// NOT a backend/api host. Mirrors the backend's WEB_APP_BASE_URL
// (prod https://www.holaos.ai, staging https://www.imerchstaging.com,
// local http://localhost:5173). Kept out of the public repo like the other
// origins; web HolaApp surfaces resolve to `<WEB_APP_BASE_URL>/apps/<id>`.
const WEB_APP_BASE_URL = configuredRemoteBaseUrl(
  ["HOLABOSS_WEB_APP_BASE_URL", "WEB_APP_BASE_URL"],
  packagedDesktopConfig.webAppBaseUrl,
);
// HolaHub is a system-level surface on its OWN subdomain (prod hub.holaos.ai,
// staging hub.imerchstaging.com, local http://localhost:5174) — NOT a
// `<WEB_APP_BASE_URL>/apps/<id>` HolaApp route. Derive its origin from
// WEB_APP_BASE_URL (www.* → hub.*, local :5173 → the hub dev server :5174),
/** HolaHub's app id — the identity a hand-off from it is attributed to. */
const HUB_APP_ID = "holahub";

// overridable with HOLABOSS_HUB_APP_BASE_URL. The "Home" nav loads its root.
const HUB_APP_BASE_URL = ((): string => {
  const explicit = configuredRemoteBaseUrl(["HOLABOSS_HUB_APP_BASE_URL"]);
  if (explicit) {
    return explicit;
  }
  if (!WEB_APP_BASE_URL) {
    return "";
  }
  try {
    const u = new URL(WEB_APP_BASE_URL);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      u.port = "5174";
    } else if (u.hostname.startsWith("www.")) {
      u.hostname = `hub.${u.hostname.slice(4)}`;
    } else if (!u.hostname.startsWith("hub.")) {
      u.hostname = `hub.${u.hostname}`;
    }
    return normalizeBaseUrl(u.origin);
  } catch {
    return "";
  }
})();
// Where web HolaApp MCP servers are reached — an SSE MCP at
// `<base>/mcp/<holaAppId>/sse`. The gateway treats `/mcp/*` as auth-exempt
// pass-through to the workflow-backend (the servers do their own bearer auth),
// so this defaults to the backend/api host. Override with
// HOLABOSS_WEB_HOLAAPP_MCP_BASE_URL if the MCP lives elsewhere.
const WEB_HOLAAPP_MCP_BASE_URL =
  configuredRemoteBaseUrl(["HOLABOSS_WEB_HOLAAPP_MCP_BASE_URL"]) ||
  BACKEND_BASE_URL;
const WEB_HOLAAPP_MCP_TIMEOUT_MS = 60_000;
// Cap on how long a web HolaApp surface load may block before we clear the renderer's
// "Opening…" spinner. The native view keeps painting the page after we resolve.
const WEB_HOLAAPP_LOAD_TIMEOUT_MS = 12_000;
// The app-surface preload (appSurfacePreload.ts) posts on this channel the instant
// the hosted page first paints, so the surface is revealed at first-contentful-paint
// instead of did-finish-load. Keep in sync with appSurfacePreload.ts.
const WEB_HOLAAPP_FIRST_PAINT_CHANNEL = "appSurface:content-painted";
// The active app surface's live location (current page URL + title), pushed to
// the renderer on in-surface navigation so the chat copilot knows which page the
// user is actually viewing. Keep in sync with the preload + electron.d.ts.
const APP_SURFACE_LOCATION_CHANNEL = "appSurface:location";
// A surface that failed to show anything. The view is a native BrowserView the
// renderer only reserves space for, so a load error, a dead renderer or a page
// that never paints all look identical from the DOM side: blank. Without this
// the pane has nothing to react to and the user gets a white rectangle.
const APP_SURFACE_FAILED_CHANNEL = "appSurface:failed";
// Per-app MCP tool lists are NOT hardcoded. The runtime treats an unspecified allowlist as
// "all tools from all enabled servers" (runtime/harnesses/src/mcp.ts), so attachWebHolaAppMcp
// attaches each installed app's server and clears the allowlist — see installedHolaAppIds.
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
// workspace-removal Piece 5.10: the single-tenant runtime resolves to one
// synthetic root workspace with this constant id. It is always LOCAL — never
// probe the cloud control plane for it (that probe is what produced the noisy
// `…/workspaces/root/lifecycle → 404`). Kept in sync with state-store's
// ROOT_WORKSPACE_ID. Dormant until the runtime starts returning this id.
const ROOT_WORKSPACE_ID = "root";
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

function keepAwakePreferencesPath() {
  return path.join(app.getPath("userData"), "keep-awake-preferences.json");
}

function loadKeepAwakePreferences(): { enabled: boolean } {
  const preferencesPath = keepAwakePreferencesPath();
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

async function persistKeepAwakePreferences() {
  await fs.mkdir(path.dirname(keepAwakePreferencesPath()), {
    recursive: true,
  });
  await fs.writeFile(
    keepAwakePreferencesPath(),
    `${JSON.stringify(keepAwakePreferences, null, 2)}\n`,
    "utf8",
  );
}

function stopKeepAwakeBlocker() {
  if (keepAwakeBlockerId === null) {
    return;
  }
  const id = keepAwakeBlockerId;
  keepAwakeBlockerId = null;
  try {
    if (powerSaveBlocker.isStarted(id)) {
      powerSaveBlocker.stop(id);
    }
  } catch (error) {
    void appendRuntimeLog(
      `[keep-awake] failed to stop power-save blocker: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

// `prevent-app-suspension` keeps the system from sleeping but lets the
// display dim/lock — matches the "keep my background work running" intent
// without forcing the screen to stay on.
function applyKeepAwakePreference() {
  if (keepAwakePreferences.enabled) {
    if (keepAwakeBlockerId !== null) {
      try {
        if (powerSaveBlocker.isStarted(keepAwakeBlockerId)) {
          return;
        }
      } catch {
        // fall through and re-start
      }
    }
    try {
      keepAwakeBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    } catch (error) {
      keepAwakeBlockerId = null;
      void appendRuntimeLog(
        `[keep-awake] failed to start power-save blocker: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  } else {
    stopKeepAwakeBlocker();
  }
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

// Every app theme is named `<variant>-<scheme>`, so the scheme a hosted web
// surface needs falls straight out of the theme the shell already reports.
function currentColorScheme(): HostColorScheme {
  return currentTheme.endsWith("-dark") ? "dark" : "light";
}

function emitThemeChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("ui:themeChanged", currentTheme);
  }
  if (authPopupWindow && !authPopupWindow.isDestroyed()) {
    authPopupWindow.webContents.send("ui:themeChanged", currentTheme);
  }
  const scheme = currentColorScheme();
  for (const view of appSurfaceViews.values()) {
    if (!view.webContents.isDestroyed()) {
      view.webContents.send(HOST_COLOR_SCHEME_CHANGED, scheme);
    }
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

function logAppUpdate(
  level: "info" | "warn" | "error" | "debug",
  message?: unknown,
): void {
  const text =
    message instanceof Error
      ? (message.stack ?? message.message)
      : typeof message === "string"
        ? message
        : String(message ?? "");
  void appendRuntimeLog(`[app-update] ${level}: ${text}\n`);
}

const appUpdateLogger = {
  info: (message?: unknown) => logAppUpdate("info", message),
  warn: (message?: unknown) => logAppUpdate("warn", message),
  error: (message?: unknown) => logAppUpdate("error", message),
  debug: (message?: unknown) => logAppUpdate("debug", message),
};

function applyAutoUpdaterChannelConfiguration() {
  const channel = effectiveAppUpdateChannel();
  autoUpdater.allowPrerelease = channel === "beta";
  autoUpdater.channel = channel;
  // electron-updater's `set channel` (and allowPrerelease) flips
  // `allowDowngrade` to true (AppUpdater: `this.allowDowngrade = true`). Combined
  // with generateUpdatesFilesForAllChannels, that means turning the beta toggle
  // OFF while on a newer beta silently auto-downloads the OLDER stable "latest"
  // build — isUpdateAvailable returns `allowDowngrade && isLatestVersionOlder`.
  // We never want to downgrade the user out from under themselves: leaving beta
  // should just stop future betas and keep the current build until a *newer*
  // stable ships. So force downgrade off after setting the channel — the
  // electron-updater docs explicitly sanction "set allowDowngrade explicitly
  // after" for exactly this case.
  autoUpdater.allowDowngrade = false;
  syncAppUpdateChannelState();
}

function configureAutoUpdater() {
  if (!appUpdateSupported() || appUpdateEventsConfigured) {
    return;
  }

  appUpdateEventsConfigured = true;
  autoUpdater.logger = appUpdateLogger;
  autoUpdater.autoDownload = true;
  // On Windows, NSIS spawns the installer before Electron finishes exiting.
  // The implicit install-on-quit path races our runtime shutdown and can
  // leave the main app resident long enough for the installer to show its
  // "app cannot be closed" retry dialog. Keep macOS on the simpler
  // auto-install path and make Windows use the explicit "Update now" flow.
  autoUpdater.autoInstallOnAppQuit = process.platform !== "win32";
  applyAutoUpdaterChannelConfiguration();

  electronAutoUpdater.on("before-quit-for-update", () => {
    appUpdateInstallInProgress =
      process.platform === "win32" || appQuitCleanupFinished;
  });

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

// macOS System Settings → Privacy & Security deep-link anchors per permission.
const MAC_PRIVACY_PANE_ANCHORS: Record<string, string> = {
  screen_recording: "Privacy_ScreenCapture",
  accessibility: "Privacy_Accessibility",
  input_monitoring: "Privacy_ListenEvent",
  full_disk_access: "Privacy_AllFiles",
  files_and_folders: "Privacy_FilesAndFolders",
  automation: "Privacy_Automation",
  camera: "Privacy_Camera",
  microphone: "Privacy_Microphone",
  location: "Privacy_LocationServices",
  privacy: "Privacy",
};

function openMacPrivacyPane(kind: string): boolean {
  const anchor = MAC_PRIVACY_PANE_ANCHORS[kind] ?? "Privacy";
  shell
    .openExternal(
      `x-apple.systempreferences:com.apple.preference.security?${anchor}`,
    )
    .catch((error) => {
      console.warn(
        `[macos-permission] failed to open settings pane (${kind}):`,
        error,
      );
    });
  return true;
}

type MacPermissionResult = {
  kind: string;
  platform: NodeJS.Platform;
  status: string;
  registered: boolean;
  opened: boolean;
};

// Ensure Holaboss is REGISTERED with macOS for the requested privacy permission.
// macOS only lists/grants an app for a permission after the app performs that
// permission's canonical trigger API — and those APIs live only here in the main
// process. For trigger-able kinds we invoke the API (which registers the app AND
// raises the system prompt — e.g. desktopCapturer for Screen Recording); for the
// rest we open the relevant Settings pane for a manual grant. The agent calls
// this (through the desktop bridge) when a host op fails for lack of a
// permission, then retries. In dev the unsigned binary registers as "Electron";
// a signed holaOS.app registers as "Holaboss".
async function ensureMacPermission(
  rawKind: string,
): Promise<MacPermissionResult> {
  const kind = rawKind.trim() || "privacy";
  if (process.platform !== "darwin") {
    return {
      kind,
      platform: process.platform,
      status: "unsupported",
      registered: false,
      opened: false,
    };
  }
  let status = "unknown";
  let registered = false;
  let opened = false;
  try {
    switch (kind) {
      case "screen_recording": {
        // Electron has no screen-recording request API (askForMediaAccess only
        // covers camera/mic), and desktopCapturer.getSources merely pre-checks +
        // rejects without registering the app. Use the native
        // CGRequestScreenCaptureAccess via node-mac-permissions: it raises the
        // system prompt on the first ask AND opens the Settings pane on failure
        // — that's what actually adds Holaboss to the Screen Recording list.
        // (getMediaAccessStatus reports "denied" even when merely not-yet-asked.)
        const { askForScreenCaptureAccess, getAuthStatus: getMacAuthStatus } =
          loadMacPermissions();
        status = getMacAuthStatus("screen");
        if (status !== "authorized") {
          try {
            askForScreenCaptureAccess(true);
            registered = true;
            opened = true;
          } catch (error) {
            console.warn(
              "[macos-permission] askForScreenCaptureAccess failed:",
              error,
            );
            opened = openMacPrivacyPane("screen_recording");
          }
          status = getMacAuthStatus("screen");
        }
        break;
      }
      case "camera":
      case "microphone": {
        const media = kind === "camera" ? "camera" : "microphone";
        status = systemPreferences.getMediaAccessStatus(media);
        if (status !== "granted") {
          try {
            await systemPreferences.askForMediaAccess(media);
            registered = true;
          } catch (error) {
            console.warn(
              `[macos-permission] askForMediaAccess(${media}) failed:`,
              error,
            );
            opened = openMacPrivacyPane(media);
          }
          status = systemPreferences.getMediaAccessStatus(media);
        }
        break;
      }
      case "accessibility": {
        if (systemPreferences.isTrustedAccessibilityClient(false)) {
          status = "granted";
        } else {
          // `true` adds Holaboss to the Accessibility list + raises the prompt.
          systemPreferences.isTrustedAccessibilityClient(true);
          registered = true;
          opened = openMacPrivacyPane("accessibility");
          status = systemPreferences.isTrustedAccessibilityClient(false)
            ? "granted"
            : "denied";
        }
        break;
      }
      default: {
        // No programmatic trigger (full disk, input monitoring, automation,
        // files & folders, location, …) — open the pane for a manual grant.
        opened = openMacPrivacyPane(kind);
        status = "unknown";
      }
    }
  } catch (error) {
    console.warn(`[macos-permission] ensureMacPermission(${kind}) failed:`, error);
  }
  return { kind, platform: process.platform, status, registered, opened };
}

// Bridge endpoint served on the desktop browser-service HTTP server so the
// runtime agent tool can reach the main-process permission APIs. Auth reuses
// the same per-launch desktop token the browser tools use.
async function handleMacosPermissionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  authToken: string,
): Promise<void> {
  const sendJson = (statusCode: number, body: unknown) => {
    response.writeHead(statusCode, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const headerToken = request.headers["x-holaboss-desktop-token"];
  const token = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (!authToken || token !== authToken) {
    sendJson(401, { error: "unauthorized" });
    return;
  }
  if ((request.method ?? "").toUpperCase() !== "POST") {
    sendJson(405, { error: "method not allowed" });
    return;
  }
  let raw = "";
  try {
    for await (const chunk of request) {
      raw += chunk;
      if (raw.length > 16_384) {
        break;
      }
    }
  } catch {
    raw = "";
  }
  let kind = "privacy";
  try {
    const parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed.kind === "string" && parsed.kind.trim()) {
      kind = parsed.kind.trim();
    }
  } catch {
    // keep default
  }
  try {
    sendJson(200, await ensureMacPermission(kind));
  } catch (error) {
    sendJson(500, {
      error:
        error instanceof Error ? error.message : "macos permission request failed",
    });
  }
}

function openExternalUrlFromMain(rawUrl: string, source: string): void {
  const normalizedUrl = rawUrl.trim();
  if (!normalizedUrl || normalizedUrl === "about:blank") {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    return;
  }
  // Security: only ever hand http/https to the OS URL handler. Mirrors the
  // guard in openExternalUrl — refuse file:, javascript:, custom-scheme, etc.
  // which shell.openExternal would otherwise dispatch to arbitrary handlers.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    console.warn(
      `[desktop] Refused to open non-http(s) external URL from ${source}: ${parsed.protocol}`,
    );
    return;
  }

  shell.openExternal(parsed.toString()).catch((error) => {
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
keepAwakePreferences = loadKeepAwakePreferences();
applyKeepAwakePreference();
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
          organizationClient(),
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
  alignment_report?: OnboardingAlignmentReport | null;
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

interface WorkspaceListResponsePayload {
  items: WorkspaceRecordPayload[];
  total: number;
  limit: number;
  offset: number;
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
  workflow_run_id: string | null;
  workflow_id: string | null;
  workflow_trigger_kind: string | null;
  issue_id: string | null;
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

interface EnsureWorkspaceMainSessionResponsePayload {
  session: AgentSessionRecordPayload;
}

interface MainSessionRecordPayload extends AgentSessionRecordPayload {
  is_active: boolean;
}

interface ListMainSessionsResponsePayload {
  sessions: MainSessionRecordPayload[];
}

interface CreateMainSessionPayload {
  title?: string | null;
  project_id?: string | null;
  harness_id?: string | null;
  /** The HolaApp that owns this session; when set the runtime does NOT promote it
   *  to the workspace's active main_session (it belongs to the app). */
  app_id?: string | null;
  /** Host hand-off intent: `false` reuses the app's existing chat (continue the
   *  conversation), `true` forces a fresh session. Omitted → always create. */
  new_session?: boolean;
}

interface CreateMainSessionResponsePayload {
  session: MainSessionRecordPayload;
}

interface ActivateMainSessionResponsePayload {
  session: MainSessionRecordPayload;
}

interface UpdateMainSessionPayload {
  title?: string | null;
}

interface UpdateMainSessionResponsePayload {
  session: MainSessionRecordPayload;
}

interface CronjobDeliveryPayload {
  mode: string;
  channel: string;
  to: string | null;
}

interface CronjobRecordPayload {
  id: string;
  workflow_id: string;
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
  owner_main_session_id?: string | null;
}

interface WorkflowNodePositionPayload {
  x: number;
  y: number;
}

interface WorkflowNodePayload {
  node_id: string;
  type: "agent" | "tool" | "trigger" | "condition" | "review";
  label: string;
  description: string | null;
  config: Record<string, unknown>;
  position: WorkflowNodePositionPayload | null;
}

interface WorkflowEdgePayload {
  edge_id: string;
  source_node_id: string;
  source_handle_id?: string | null;
  target_node_id: string;
  target_handle_id?: string | null;
  label: string | null;
  metadata: Record<string, unknown>;
}

interface WorkflowRecordPayload {
  workflow_id: string;
  workspace_id: string;
  plugin_id: string | null;
  name: string;
  description: string | null;
  status: "draft" | "active" | "archived";
  created_by: string | null;
  nodes: WorkflowNodePayload[];
  edges: WorkflowEdgePayload[];
  metadata: Record<string, unknown>;
  last_test_run_id: string | null;
  last_test_status: "passed" | "needs_attention" | "failed" | null;
  last_test_summary: string | null;
  last_test_at: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface WorkflowRunRecordPayload {
  run_id: string;
  workflow_id: string;
  workflow_revision_id: string | null;
  workspace_id: string;
  mode: "test" | "live";
  status:
    | "queued"
    | "running"
    | "blocked"
    | "completed"
    | "failed"
    | "cancelled"
    | "passed"
    | "needs_attention";
  summary: string;
  triggered_by: string | null;
  result: Record<string, unknown>;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkflowRevisionRecordPayload {
  workflow_revision_id: string;
  workflow_id: string;
  workspace_id: string;
  plugin_id: string | null;
  revision_number: number;
  name: string;
  description: string | null;
  status: "draft" | "active" | "archived";
  created_by: string | null;
  nodes: WorkflowNodePayload[];
  edges: WorkflowEdgePayload[];
  metadata: Record<string, unknown>;
  created_at: string;
}

interface WorkflowGraphCheckPayload {
  code: string;
  level: "info" | "warning" | "error";
  message: string;
}

interface WorkflowGraphAnalysisPayload {
  status: "passed" | "needs_attention" | "failed";
  summary: string;
  checks: WorkflowGraphCheckPayload[];
  counts: {
    nodes: number;
    edges: number;
    by_type: Record<string, number>;
  };
  can_execute: boolean;
}

interface WorkflowListResponsePayload {
  workflows: WorkflowRecordPayload[];
  count: number;
}

interface WorkflowRunListResponsePayload {
  runs: WorkflowRunRecordPayload[];
  count: number;
}

interface WorkflowRevisionListResponsePayload {
  revisions: WorkflowRevisionRecordPayload[];
  count: number;
}

interface CreateWorkflowPayload {
  workspace_id: string;
  plugin_id?: string | null;
  name: string;
  description?: string | null;
  status?: "draft" | "active" | "archived";
  created_by?: string | null;
  nodes?: WorkflowNodePayload[];
  edges?: WorkflowEdgePayload[];
  metadata?: Record<string, unknown>;
}

interface UpdateWorkflowPayload {
  name?: string;
  description?: string | null;
  status?: "draft" | "active" | "archived";
  created_by?: string | null;
  nodes?: WorkflowNodePayload[];
  edges?: WorkflowEdgePayload[];
  metadata?: Record<string, unknown>;
}

interface WorkflowNodeMutationResponsePayload {
  workflow: WorkflowRecordPayload;
  node: WorkflowNodePayload;
}

interface WorkflowNodeDeleteResponsePayload {
  success: boolean;
  deleted_node_id: string;
  workflow: WorkflowRecordPayload;
}

interface WorkflowEdgeMutationResponsePayload {
  workflow: WorkflowRecordPayload;
  edge: WorkflowEdgePayload;
}

interface WorkflowEdgeDeleteResponsePayload {
  success: boolean;
  deleted_edge_id: string;
  workflow: WorkflowRecordPayload;
}

interface WorkflowTestPayload {
  created_by?: string;
}

interface WorkflowNodeRunRecordPayload {
  node_run_id: string;
  run_id: string;
  workflow_id: string;
  workspace_id: string;
  node_id: string;
  node_type: "agent" | "tool" | "trigger" | "condition";
  status:
    | "queued"
    | "running"
    | "blocked"
    | "completed"
    | "failed"
    | "cancelled";
  issue_id: string | null;
  subagent_id: string | null;
  result: Record<string, unknown>;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkflowStartPayload {
  created_by?: string;
  trigger_kind?: "manual" | "cron";
  trigger_node_id?: string;
}

interface WorkflowTestResponsePayload {
  workflow: WorkflowRecordPayload;
  run: WorkflowRunRecordPayload;
  analysis: WorkflowGraphAnalysisPayload;
}

interface WorkflowAnalyzePayload {
  nodes?: WorkflowNodePayload[];
  edges?: WorkflowEdgePayload[];
}

interface WorkflowAnalyzeResponsePayload {
  analysis: WorkflowGraphAnalysisPayload;
}

interface WorkflowStartResponsePayload {
  workflow: WorkflowRecordPayload;
  run: WorkflowRunRecordPayload;
  node_runs: WorkflowNodeRunRecordPayload[];
  notifications: RuntimeNotificationRecordPayload[];
  issues: IssueRecordPayload[];
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
  // True when a credential (API-key/basic) connect finished server-side with
  // no OAuth redirect — the account is already live, skip the OAuth window.
  connected?: boolean;
}

interface ComposioToolkitAuthField {
  name: string;
  required: boolean;
  type: string;
  displayName: string;
  description: string;
}

interface ComposioToolkitAuth {
  // managed → run the OAuth Connect flow; otherwise collect `fields` (the
  // user's own key/credentials) and pass them to composioConnect.
  managed: boolean;
  scheme: string | null;
  fields: ComposioToolkitAuthField[];
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

interface SessionTurnResultPayload {
  workspace_id: string;
  session_id: string;
  input_id: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  stop_reason: string | null;
  assistant_text: string;
  tool_usage_summary: Record<string, unknown>;
  permission_denials: Array<Record<string, unknown>>;
  prompt_section_ids: string[];
  capability_manifest_fingerprint: string | null;
  request_snapshot_fingerprint: string | null;
  prompt_cache_profile: Record<string, unknown> | null;
  context_budget_decisions: Record<string, unknown> | null;
  token_usage: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

interface SessionTurnResultListRequestPayload {
  workspaceId: string;
  sessionId?: string | null;
  inputId?: string | null;
  status?: string | null;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}

interface SessionTurnResultListResponsePayload {
  workspace_id: string;
  session_id: string | null;
  items: SessionTurnResultPayload[];
  count: number;
  total: number;
  limit: number;
  offset: number;
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
  /** Ambient open-app context for the AGENT only — folded into the turn
   * instruction by the runtime, never persisted as the user message. */
  app_context_text?: string | null;
  workspace_id: string;
  image_urls: string[] | null;
  attachments?: SessionInputAttachmentPayload[] | null;
  session_id?: string | null;
  idempotency_key?: string | null;
  priority?: number;
  model?: string | null;
  thinking_value?: string | null;
  /** Owning HolaApp — stamps owning_app_id when this lazily creates the session. */
  app_id?: string | null;
}

interface HolabossPauseSessionRunPayload {
  workspace_id: string;
  session_id: string;
}

interface HolabossAnswerUserQuestionAnswer {
  question_id: string;
  option_id?: string | null;
  response_text?: string | null;
  notes?: string | null;
}

interface HolabossAnswerUserQuestionPayload {
  workspace_id: string;
  session_id: string;
  answers: HolabossAnswerUserQuestionAnswer[];
  model?: string | null;
  thinking_value?: string | null;
}

interface AnswerUserQuestionResponsePayload {
  workspace_id: string;
  session_id: string;
  active_user_question: Record<string, unknown> | null;
  input_id?: string;
  status?: string;
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

function browserWorkspacePartition(browserContextId: string) {
  return isBrowserProfileId(browserContextId)
    ? browserProfilePartitionUtil(browserContextId)
    : browserWorkspacePartitionUtil(browserContextId);
}

function browserChromeLikePlatformToken(): string {
  return browserChromeLikePlatformTokenUtil();
}

function browserAcceptedLanguages(): string {
  return browserAcceptedLanguagesUtil(app.getLocale());
}

// Google (and other SSO providers) flag non-standard User-Agents: the app-name
// (Holaboss/…) and Electron/… tokens Electron adds make Google treat the view
// as an embedded/untrusted client and break sign-in with a CookieMismatch page.
// Strip them so the browser presents as plain Chrome.
//
// Done by STRUCTURE, not by name: Electron inserts the product token between the
// `(KHTML, like Gecko)` marker and the `Chrome/…` token, then an `Electron/…`
// token before Safari. Matching those positions (rather than the literal app
// name via app.getName()) makes this robust to the product name — including
// dev names with spaces ("holaOS Dev") and any drift between the name baked
// into the UA and app.getName() at call time, which previously left the app
// token in place and re-triggered CookieMismatch.
function stripBrowserAppUserAgentTokens(userAgent: string): string {
  return userAgent
    .replace(/(\(KHTML, like Gecko\))\s+.+?(\s+Chrome\/)/i, "$1$2")
    .replace(/\sElectron\/\S+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const oauthCompatPatchedSessions = new WeakSet<Session>();

// The most recent Google OAuth *initiation* URL seen on an app-surface session
// (accounts.google.com/o/oauth2/...). Captured from the request layer because a
// server-side 302 to /CookieMismatch never commits a `did-navigate` for it, so the
// popup self-heal can't recover it from navigation events — see the popup handler.
let lastGoogleOAuthInitUrl: string | null = null;

// Gaia bounces an OAuth popup to /CookieMismatch when the shared browser partition
// carries stale/partial Google cookies (imported from a browser profile). Those
// cookies aren't needed for the flow — only the resulting third-party session
// cookie is — so wiping google.com cookies gives Gaia a clean slate to re-establish.
async function clearGoogleAuthCookies(sess: Session): Promise<number> {
  const all = await sess.cookies.get({});
  const google = all.filter((c) => /(^|\.)google\.com$/i.test(c.domain ?? ""));
  await Promise.all(
    google.map((c) => {
      const domain = (c.domain ?? "").replace(/^\./, "");
      const url = `http${c.secure ? "s" : ""}://${domain}${c.path ?? "/"}`;
      return sess.cookies.remove(url, c.name).catch(() => undefined);
    }),
  );
  return google.length;
}

// Make an app-surface session tolerate third-party OAuth (Typefully → Google, …):
// strip the `X-Requested-With` webview marker Gaia flags, and remember the Google
// OAuth initiation URL so the popup can self-heal a CookieMismatch bounce. The
// embedded-looking UA client hints are suppressed globally instead (see
// configureEmbeddedOAuthCompatPolicy — UserAgentClientHint disabled), since the
// main-frame navigation's hints aren't reachable from this layer.
function patchAppSurfaceOAuthCompat(surfaceSession: Session): void {
  if (oauthCompatPatchedSessions.has(surfaceSession)) {
    return;
  }
  oauthCompatPatchedSessions.add(surfaceSession);
  surfaceSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "x-requested-with") {
        delete headers[key];
      }
    }
    if (/\/\/accounts\.google\.com\/o\/oauth2\//i.test(details.url)) {
      lastGoogleOAuthInitUrl = details.url;
    }
    callback({ requestHeaders: headers });
  });
}

function browserNativeIdentity(session: Session): BrowserSessionIdentity {
  const nativeUserAgent = stripBrowserAppUserAgentTokens(
    session.getUserAgent().trim(),
  );
  const chromeVersion = (process.versions.chrome || "141.0.0.0").trim();
  return {
    userAgent:
      nativeUserAgent ||
      `Mozilla/5.0 (${browserChromeLikePlatformToken()}) AppleWebKit/537.36 ` +
        `(KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
    acceptLanguages: browserAcceptedLanguages(),
  };
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

function runtimeDataDatabasePath() {
  // The single root runtime store (sessions, conversation bindings, runs, …),
  // a sibling of control-plane.db. This is the live runtime data post
  // workspace-removal — what diagnostics most needs to capture.
  return path.join(runtimeSandboxRoot(), "state", "data.db");
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
/**
 * How long a single boot phase may sit unchanged before it counts as stalled
 * rather than working. Generous: a phase that is genuinely slow (a large
 * migration, an integrity check) is exactly what we want to wait for — the
 * thing worth giving up on is a phase that stops advancing entirely.
 */
const STALLED_BOOT_PHASE_ATTEMPTS = 300;

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

function diagnosticsBundleFileName(date = new Date()) {
  const timestamp = date
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-");
  return `holaboss-diagnostics-${timestamp}.zip`;
}

async function exportDesktopDiagnosticsBundle() {
  const downloadsDir = app.getPath("downloads");
  const bundlePath = path.join(downloadsDir, diagnosticsBundleFileName());
  const { exportDiagnosticsBundle } = await import("./diagnostics-bundle.js");
  // Workspaces were removed, so the bundle is one overall snapshot of the
  // runtime rather than a workspace-scoped slice: data.db is the root runtime
  // store (sessions, conversation bindings, runs), while host-state.db and
  // control-plane.db hold the host/control-plane registries. Missing files are
  // skipped, so a half-initialized runtime still exports whatever exists.
  const result = await exportDiagnosticsBundle({
    bundlePath,
    runtimeLogPath: runtimeLogsPath(),
    databases: [
      { sourcePath: runtimeDataDatabasePath(), archiveName: "data.db" },
      { sourcePath: hostStateDatabasePath(), archiveName: "host-state.db" },
      {
        sourcePath: controlPlaneDatabasePath(),
        archiveName: "control-plane.db",
      },
    ],
    runtimeConfigPath: runtimeConfigPath(),
    summary: {
      exported_at: utcNowIso(),
      app_version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      versions: {
        chrome: process.versions.chrome,
        electron: process.versions.electron,
        node: process.versions.node,
      },
      runtime_status: runtimeStatus,
    },
  });
  shell.showItemInFolder(result.bundlePath);
  return result;
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

      -- workspace-removal Piece 5.11: workspaces table no longer created in the
      -- host-state DB (single-tenant root; former workspaces are projects).
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
  if (isDev) {
    const tag = event.outcome === "error" ? "✗" : event.outcome === "success" ? "✓" : "·";
    const suffix = event.detail ? ` ${event.detail}` : "";
    // Single readable line in the dev terminal so `appendRuntimeEventLog`
    // (already called from ~23 sites) is finally grep-able from the
    // running electron process, not just SQLite + Sentry.
    console.log(
      `[${event.category}] ${tag} ${event.event} outcome=${event.outcome}${suffix}`,
    );
  }
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

// One-liner BFF fetch logger. Funnels every Hono-bound request through
// `appendRuntimeEventLog` so the dev terminal sees one structured line
// per fetch (and SQLite/Sentry get the same record for prod post-mortem).
function logBffFetch(args: {
  category: string;
  method: string;
  path: string;
  status: number | null;
  durationMs?: number;
  hasCookie?: boolean;
  bodyExcerpt?: string | null;
  error?: unknown;
}): void {
  const { category, method, path, status, durationMs, hasCookie, bodyExcerpt, error } =
    args;
  const outcome =
    error !== undefined
      ? "error"
      : status === null
        ? "error"
        : status === 401
          ? "unauthorized"
          : status >= 400
            ? "error"
            : "success";
  const detailParts: string[] = [
    `${method} ${path}`,
    `→ ${status ?? "ERR"}`,
  ];
  if (durationMs !== undefined) detailParts.push(`${durationMs}ms`);
  if (hasCookie !== undefined) detailParts.push(`cookie=${hasCookie ? "yes" : "no"}`);
  if (bodyExcerpt) detailParts.push(`body=${bodyExcerpt.slice(0, 240).replace(/\s+/g, " ")}`);
  if (error) detailParts.push(`err=${String(error).slice(0, 200)}`);
  appendRuntimeEventLog({
    category,
    event: "http_fetch",
    outcome,
    detail: detailParts.join(" "),
  });
}

// Thin wrappers over the shared, tested helpers in json-state-file.ts. Both
// halves matter together: the write is atomic so a crash mid-write cannot
// truncate the file, and the read quarantines an unparseable file instead of
// letting the fallback-then-write cycle destroy it.
async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  return readJsonStateFile(filePath, fallback, {
    log: (message) => {
      void appendRuntimeLog(message).catch(() => undefined);
    },
  });
}

async function writeJsonFile(filePath: string, payload: unknown) {
  return writeJsonStateFileAtomically(filePath, payload);
}

async function loadBrowserPersistence() {
  fileBookmarks = await readJsonFile<FileBookmarkPayload[]>(
    fileBookmarksPath(),
    [],
  );
}

// runtime.log is the SOLE sink for the embedded runtime's stdout/stderr (see the
// child-process wiring) plus desktop-side runtime events. Unbounded, it balloons
// across failed-boot retry loops — a real ~6 GB incident. Cap it: whenever the
// file grows past RUNTIME_LOG_MAX_BYTES, trim it to the most-recent
// RUNTIME_LOG_KEEP_BYTES (on a line boundary). The runtime side only ever READS
// the tail (Sentry attachment) or stat()s it, so trimming history is safe. All
// writes funnel through appendRuntimeLog and are serialized on one chain so a trim
// can never interleave with a concurrent fire-and-forget append.
const RUNTIME_LOG_MAX_BYTES = 32 * 1024 * 1024;
const RUNTIME_LOG_KEEP_BYTES = 4 * 1024 * 1024;
let runtimeLogKnownSize: number | null = null;
let runtimeLogWriteChain: Promise<void> = Promise.resolve();

async function trimRuntimeLogToTail(logPath: string): Promise<void> {
  const handle = await fs.open(logPath, "r");
  try {
    const { size } = await handle.stat();
    if (size <= RUNTIME_LOG_MAX_BYTES) {
      runtimeLogKnownSize = size;
      return;
    }
    const keep = Math.min(RUNTIME_LOG_KEEP_BYTES, size);
    const buffer = Buffer.alloc(keep);
    await handle.read(buffer, 0, keep, size - keep);
    // Drop the (likely partial) first line so the trimmed file starts cleanly.
    const newlineAt = buffer.indexOf(0x0a);
    const tail =
      newlineAt >= 0 && newlineAt + 1 < buffer.length
        ? buffer.subarray(newlineAt + 1)
        : buffer;
    await fs.writeFile(logPath, tail);
    runtimeLogKnownSize = tail.length;
  } finally {
    await handle.close();
  }
}

async function appendRuntimeLogInner(line: string): Promise<void> {
  const logPath = runtimeLogsPath();
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  if (runtimeLogKnownSize == null) {
    try {
      runtimeLogKnownSize = (await fs.stat(logPath)).size;
    } catch {
      runtimeLogKnownSize = 0;
    }
  }
  await fs.appendFile(logPath, line, "utf-8");
  runtimeLogKnownSize += Buffer.byteLength(line, "utf-8");
  if (runtimeLogKnownSize > RUNTIME_LOG_MAX_BYTES) {
    try {
      await trimRuntimeLogToTail(logPath);
    } catch {
      // Best-effort: if trimming fails, hard-reset rather than grow unbounded.
      try {
        await fs.writeFile(logPath, "");
        runtimeLogKnownSize = 0;
      } catch {
        // Logging must never crash the app — give up silently.
      }
    }
  }
}

function appendRuntimeLog(line: string): Promise<void> {
  // Serialize through one chain: ordered writes + no trim/append race. The chain
  // is kept alive with .catch (inner already swallows its own errors).
  const next = runtimeLogWriteChain.then(() => appendRuntimeLogInner(line));
  runtimeLogWriteChain = next.catch(() => {});
  return next;
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
  if (!apiKey && providerId !== "ollama_local") {
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

function managedHolabossRuntimeProviderGroup(
  providerModelGroups: RuntimeProviderModelGroupPayload[],
): RuntimeProviderModelGroupPayload | null {
  return (
    providerModelGroups.find(
      (group) =>
        canonicalRuntimeProviderId(group.providerId) ===
        RUNTIME_HOLABOSS_PROVIDER_ID,
    ) ?? null
  );
}

function managedHolabossRuntimeModelConfig(
  model: RuntimeProviderModelPayload,
): Record<string, unknown> {
  return {
    provider_id: RUNTIME_HOLABOSS_PROVIDER_ID,
    model_id: model.modelId,
    ...(model.label ? { label: model.label } : {}),
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    ...(model.thinkingValues !== undefined
      ? { thinking_values: [...model.thinkingValues] }
      : {}),
    ...(model.defaultThinkingValue !== undefined
      ? { default_thinking_value: model.defaultThinkingValue }
      : {}),
    ...(model.inputModalities !== undefined
      ? { input_modalities: [...model.inputModalities] }
      : {}),
    ...(model.contextWindow !== undefined
      ? { context_window: model.contextWindow }
      : {}),
    ...(model.maxTokens !== undefined
      ? { max_tokens: model.maxTokens }
      : {}),
  };
}

function withManagedHolabossProviderModels(
  document: Record<string, unknown>,
  providerModelGroups: RuntimeProviderModelGroupPayload[],
): Record<string, unknown> {
  const group = managedHolabossRuntimeProviderGroup(providerModelGroups);
  if (!group || group.models.length === 0) {
    return document;
  }
  const currentModels = runtimeConfigObject(document.models);
  const nextModels: Record<string, unknown> = { ...currentModels };
  let didChange = false;

  for (const model of group.models) {
    const token = canonicalRuntimeModelToken(
      RUNTIME_HOLABOSS_PROVIDER_ID,
      normalizeRuntimeProviderModelToken(
        RUNTIME_HOLABOSS_PROVIDER_ID,
        model.token,
        model.modelId,
      ),
      model.modelId,
    );
    const nextPayload = managedHolabossRuntimeModelConfig(model);
    const currentPayload = runtimeConfigObject(currentModels[token]);
    const currentText = JSON.stringify(currentPayload);
    const nextText = JSON.stringify(nextPayload);
    if (currentText === nextText) {
      continue;
    }
    nextModels[token] = nextPayload;
    didChange = true;
  }

  if (!didChange) {
    return document;
  }
  return {
    ...document,
    models: nextModels,
  };
}

function runtimeConfigNeedsManagedHolabossModelRefresh(
  document: Record<string, unknown>,
  providerModelGroups: RuntimeProviderModelGroupPayload[],
): boolean {
  return (
    withManagedHolabossProviderModels(document, providerModelGroups) !==
    document
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
  _workspaceId: string,
  _space: BrowserSpaceId,
  visibleInApp: boolean,
): string {
  // The embedded in-app browser engine is gone; the agent drives real profile
  // Chromium windows over CDP instead. There are no in-app tabs to enumerate,
  // so this reports the empty agent-browser surface.
  const summaryParts = [
    "Agent browser surface with 0 open tabs.",
    "No active tab is currently selected.",
  ];
  if (visibleInApp) {
    summaryParts.push("This surface is currently visible in the app.");
  }
  summaryParts.push("It uses the workspace browser session and auth state.");
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
    owner: "agent",
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

async function startDesktopBrowserService(): Promise<void> {
  if (desktopBrowserServiceServer) {
    return;
  }

  const authToken = randomUUID();
  const server = createServer((request, response) => {
    const requestPath = (request.url ?? "").split("?")[0];
    if (requestPath === "/api/v1/macos-permission") {
      void handleMacosPermissionRequest(request, response, authToken);
      return;
    }
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

let desktopBrowserServiceStartInFlight: Promise<void> | null = null;

/**
 * Bring up the agent-facing desktop browser service — guaranteed, logged, and
 * concurrency-safe.
 *
 * Starting it is the ONLY thing that flips `capabilities.desktop_browser.enabled`
 * → true in the runtime config, which is what surfaces the `browser_*` tools to
 * agents (in-process pi + external MCP harnesses). It therefore must not be
 * skippable by an unrelated failure earlier in the long `app.whenReady()` chain,
 * so it is also registered as its own ready step (see below). Concurrent callers
 * share one in-flight start (no double-bind); a couple of retries cover a
 * transient port race; any failure is logged rather than swallowed.
 *
 * The runtime reads the browser capability from its env, captured at spawn — so
 * if it already came up before the service (via an early start path), refresh it
 * once so agents actually receive the tools. Skipped when the runtime isn't up
 * yet: it will spawn with the capability already enabled.
 */
async function ensureDesktopBrowserServiceStarted(): Promise<void> {
  if (desktopBrowserServiceServer) {
    return;
  }
  if (!desktopBrowserServiceStartInFlight) {
    desktopBrowserServiceStartInFlight = (async () => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await startDesktopBrowserService();
          void appendRuntimeLog(
            `[desktop-browser-service] listening at ${desktopBrowserServiceUrl} — agent browser tools enabled\n`,
          );
          if (await isRuntimeHealthy(runtimeBaseUrl())) {
            void appendRuntimeLog(
              "[desktop-browser-service] runtime already running; refreshing it to surface browser tools\n",
            );
            void restartEmbeddedRuntimeSafely("desktop_browser_capability");
          }
          return;
        } catch (error) {
          void appendRuntimeLog(
            `[desktop-browser-service] start attempt ${attempt}/3 failed: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
          if (attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
      }
    })().finally(() => {
      desktopBrowserServiceStartInFlight = null;
    });
  }
  await desktopBrowserServiceStartInFlight;
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

// Org-billing: the desktop's active org (Better-Auth session activeOrganizationId).
// Written into the runtime config so model-proxy calls forward it as
// X-Holaboss-Org-Id and consumption attributes to this org. Best-effort — on any
// failure we return null and the product side falls back to the personal org.
async function resolveDesktopActiveOrgId(): Promise<string | null> {
  try {
    const active = await desktopAuthClient?.organization.getFullOrganization();
    const slug = active?.data?.slug;
    // Personal is modeled as "no org" (null) throughout org billing: its
    // sessions bill the personal wallet via the consume fallback and list under
    // Personal (null-org), so a team view never shows them. A real team org
    // returns its id.
    if (typeof slug === "string" && slug.startsWith("personal-")) {
      return null;
    }
    return active?.data?.id ?? null;
  } catch {
    return null;
  }
}

// BYO (bring-your-own-key) org — unlike resolveDesktopActiveOrgId this does NOT
// null out the personal org, because a solo user's BYO provider keys are stored
// under their real personal-org id (the web gateway resolves personal → that id).
// Forwarded as X-Holaboss-Byo-Org-Id so the backend can surface + run this org's
// BYO models. Billing still uses resolveDesktopActiveOrgId (null for personal),
// so wallet attribution is unchanged. See runtime-config byoOrgId.
async function resolveDesktopByoOrgId(): Promise<string | null> {
  try {
    const active = await desktopAuthClient?.organization.getFullOrganization();
    if (active?.data?.id) {
      return active.data.id;
    }
    // Personal often has NO explicitly-active org, so getFullOrganization returns
    // null — but the web gateway's resolveActiveOrg falls back to the user's oldest
    // membership (the personal team-of-one) and stored the BYO key under THAT id.
    // Mirror it here: prefer the personal-slug org, else the oldest, so the desktop
    // forwards the same org the key lives under.
    const list = await desktopAuthClient?.organization.list();
    const orgs = Array.isArray(list?.data) ? list.data : [];
    if (orgs.length === 0) {
      return null;
    }
    const personal = orgs.find(
      (org) => typeof org?.slug === "string" && org.slug.startsWith("personal-"),
    );
    if (personal?.id) {
      return personal.id;
    }
    const oldest = [...orgs].sort(
      (a, b) =>
        new Date(a?.createdAt ?? 0).getTime() -
        new Date(b?.createdAt ?? 0).getTime(),
    )[0];
    return oldest?.id ?? null;
  } catch {
    return null;
  }
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
      ["orgId", "org_id"],
      ["byoOrgId", "byo_org_id"],
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

    let nextDocument: Record<string, unknown> = {
      ...currentDocument,
      runtime: runtimePayload,
      providers: providersPayload,
      integrations: integrationsPayload,
      holaboss: next,
    };
    if (runtimeConfigIsControlPlaneManaged(next)) {
      nextDocument = withManagedHolabossProviderModels(
        nextDocument,
        runtimeModelCatalogState.providerModelGroups,
      );
    }
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
  video: "video_generation",
  videos: "video_generation",
  video_generation: "video_generation",
  video_gen: "video_generation",
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

function runtimePositiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      Number.isFinite(value) &&
      value > 0
    ) {
      return value;
    }
  }
  return undefined;
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
  const contextWindow = runtimePositiveInteger(
    payload.contextWindow,
    payload.context_window,
  );
  const maxTokens = runtimePositiveInteger(
    payload.maxTokens,
    payload.max_tokens,
  );

  return {
    ...(label ? { label } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(thinkingValues !== undefined ? { thinkingValues } : {}),
    ...(defaultThinkingValue !== undefined ? { defaultThinkingValue } : {}),
    ...(inputModalities !== undefined ? { inputModalities } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
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
    ...(payload.contextWindow !== undefined
      ? { contextWindow: payload.contextWindow }
      : existing?.contextWindow !== undefined
        ? { contextWindow: existing.contextWindow }
        : {}),
    ...(payload.maxTokens !== undefined
      ? { maxTokens: payload.maxTokens }
      : existing?.maxTokens !== undefined
        ? { maxTokens: existing.maxTokens }
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
    if (isRemovedRuntimeProviderId(providerId)) {
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
      if (!providerId || isRemovedRuntimeProviderId(providerId)) {
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
            ...(model.contextWindow !== undefined
              ? { contextWindow: model.contextWindow }
              : {}),
            ...(model.maxTokens !== undefined
              ? { maxTokens: model.maxTokens }
              : {}),
          },
        );
      }
    }
  };

  mergeManagedCatalog(managedCatalogGroups);

  for (const [providerId, rawProvider] of Object.entries(providersPayload)) {
    const canonicalProviderId = canonicalRuntimeProviderId(providerId);
    if (
      isHolabossProviderAlias(canonicalProviderId) ||
      isRemovedRuntimeProviderId(canonicalProviderId)
    ) {
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
      if (
        isHolabossProviderAlias(normalizedProviderId) ||
        isRemovedRuntimeProviderId(normalizedProviderId)
      ) {
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
    if (isRemovedRuntimeProviderId(providerId)) {
      continue;
    }
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

function isRemovedRuntimeProviderId(providerId: string): boolean {
  return RUNTIME_REMOVED_PROVIDER_IDS.has(providerId.trim().toLowerCase());
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
  // Forward the active org so the backend can add this org's BYO (your-key)
  // provider models to the catalog. Billing org is null for personal; the BYO
  // org is NOT (a solo user's keys live under their personal-org id), so send it
  // separately as X-Holaboss-Byo-Org-Id — that's what surfaces personal BYO models.
  const [activeOrgId, byoOrgId] = await Promise.all([
    resolveDesktopActiveOrgId(),
    resolveDesktopByoOrgId(),
  ]);
  const catalogHeaders: Record<string, string> = { Cookie: cookieHeader };
  if (activeOrgId) {
    catalogHeaders["X-Holaboss-Org-Id"] = activeOrgId;
  }
  if (byoOrgId) {
    catalogHeaders["X-Holaboss-Byo-Org-Id"] = byoOrgId;
  }
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, RUNTIME_MODEL_CATALOG_FETCH_TIMEOUT_MS);
  timeout.unref();
  const startedAt = Date.now();
  try {
    response = await fetch(catalogUrl, {
      method: "GET",
      headers: catalogHeaders,
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
    logBffFetch({
      category: "control_plane",
      method: "GET",
      path: DESKTOP_RUNTIME_MODEL_CATALOG_PATH,
      status: null,
      durationMs: Date.now() - startedAt,
      hasCookie: true,
      error: detail,
    });
    throw new Error(
      `Runtime model catalog request failed for ${catalogUrl}: ${detail}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = await response.text();
    logBffFetch({
      category: "control_plane",
      method: "GET",
      path: DESKTOP_RUNTIME_MODEL_CATALOG_PATH,
      status: response.status,
      durationMs: Date.now() - startedAt,
      hasCookie: true,
      bodyExcerpt: detail,
    });
    throw new Error(
      detail ||
        `Runtime model catalog request failed with status ${response.status}`,
    );
  }

  logBffFetch({
    category: "control_plane",
    method: "GET",
    path: DESKTOP_RUNTIME_MODEL_CATALOG_PATH,
    status: response.status,
    durationMs: Date.now() - startedAt,
    hasCookie: true,
  });

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
  return getRuntimeConfigSnapshot(runtimeModelCatalogState);
}

async function getRuntimeConfigWithoutCatalogRefresh(): Promise<RuntimeConfigPayload> {
  const managedCatalog = runtimeModelCatalogState;
  let didSyncDefaults = false;
  if (await syncManagedHolabossDefaultsToRuntimeConfigIfNeeded(managedCatalog)) {
    didSyncDefaults = true;
  }
  if (didSyncDefaults) {
    return getRuntimeConfigSnapshot(runtimeModelCatalogState);
  }
  return getRuntimeConfigSnapshot(managedCatalog);
}

async function getRuntimeConfigDocumentText(): Promise<string> {
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
  timezone?: string | null,
): Promise<RuntimeUserProfilePayload> {
  return localRuntimeUserProfileStore.applyAuthFallback(name, profileId, timezone);
}

function resolveLocalTimezone(): string | null {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone?.trim();
    return timezone || null;
  } catch {
    return null;
  }
}

async function syncRuntimeUserProfileFromAuth(
  user: AuthUserPayload,
): Promise<void> {
  const name = typeof user.name === "string" ? user.name.trim() : "";
  const timezone =
    (typeof user.timezone === "string" ? user.timezone.trim() : "") ||
    resolveLocalTimezone();
  try {
    await applyRuntimeUserProfileAuthFallback(name, "default", timezone);
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
  // Cookie just rotated. Drop any in-flight SSE stream and reconnect so
  // the bridge picks up the fresh session immediately rather than after
  // the next backoff tick.
  composioEventsBridge?.restart();
}

function emitAuthUserUpdated(user: AuthUserPayload | null) {
  pendingAuthUser = user;
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
    composioEventsBridge?.restart();
  } else {
    composioEventsBridge?.stop("auth_user_cleared");
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
  invalidateCachedAuthSession();
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

// In-process cookie cache. Populated by (a) the dev-only plaintext cache loaded
// at startup, (b) successful auth callbacks, and (c) any time better-auth's own
// storage adapter happens to read back a decryptable cookie. This is the
// single source of truth that downstream IPC fetchers read from, so a broken
// safeStorage key on Electron dev restart does not silently log the user out.
let cachedCookieHeader: string | null = null;

const COOKIE_READ_ERROR_LOG_TTL_MS = 5_000;
let cookieReadErrorLoggedAtMs = 0;
let blobHealthProbeCompleted = false;

function isUsableCookieHeader(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }
  if (normalized.toLowerCase().includes("invalid-encrypted-cookie")) {
    return false;
  }
  return normalized.includes("=");
}

function logCookieReadErrorOnce(detail: string): void {
  const now = Date.now();
  if (now - cookieReadErrorLoggedAtMs < COOKIE_READ_ERROR_LOG_TTL_MS) {
    return;
  }
  cookieReadErrorLoggedAtMs = now;
  appendRuntimeEventLog({
    category: "auth",
    event: "auth.cookie.read",
    outcome: "error",
    detail,
  });
}

function plaintextAuthCachePath(): string {
  return path.join(app.getPath("userData"), "dev-auth-cookie.json");
}

function loadPlaintextAuthCache(): string | null {
  if (!isDev) {
    return null;
  }
  const targetPath = plaintextAuthCachePath();
  if (!existsSync(targetPath)) {
    return null;
  }
  try {
    const raw = readFileSync(targetPath, "utf-8");
    const parsed = JSON.parse(raw) as { cookie?: unknown };
    const candidate = typeof parsed.cookie === "string" ? parsed.cookie : "";
    return isUsableCookieHeader(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function persistPlaintextAuthCache(cookieHeader: string): void {
  if (!isDev) {
    return;
  }
  if (!isUsableCookieHeader(cookieHeader)) {
    return;
  }
  try {
    writeFileSync(
      plaintextAuthCachePath(),
      `${JSON.stringify({ cookie: cookieHeader })}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );
  } catch {
    // Best-effort; never block sign-in on cache write failure.
  }
}

function clearPlaintextAuthCache(): void {
  cachedCookieHeader = null;
  if (!isDev) {
    return;
  }
  const targetPath = plaintextAuthCachePath();
  if (!existsSync(targetPath)) {
    return;
  }
  try {
    unlinkSync(targetPath);
  } catch {
    // Ignore — file system races during sign-out are not fatal.
  }
}

function captureCookieAfterSuccessfulAuth(): void {
  if (!desktopAuthClient) {
    return;
  }
  try {
    const fresh = requireAuthClient().getCookie() || "";
    if (isUsableCookieHeader(fresh)) {
      cachedCookieHeader = fresh;
      persistPlaintextAuthCache(fresh);
    }
  } catch {
    // Reading the just-written cookie is best-effort.
  }
}

function probeAuthCookieHealthOnce(): void {
  if (blobHealthProbeCompleted) {
    return;
  }
  blobHealthProbeCompleted = true;
  if (!desktopAuthClient) {
    return;
  }
  // Load the dev plaintext cache eagerly so the very first IPC read is hot.
  if (cachedCookieHeader === null) {
    const cached = loadPlaintextAuthCache();
    if (cached) {
      cachedCookieHeader = cached;
      return;
    }
  }
  // If config.json still holds an unreadable safeStorage blob from a prior
  // Electron run, every fetcher will collide on it for the lifetime of the
  // process. Detect that case once and wipe it so we surface "signed out"
  // cleanly instead of looping through eight identical decrypt failures.
  let liveCookie = "";
  try {
    liveCookie = requireAuthClient().getCookie() || "";
  } catch {
    liveCookie = "";
  }
  if (isUsableCookieHeader(liveCookie)) {
    cachedCookieHeader = liveCookie;
    persistPlaintextAuthCache(liveCookie);
    return;
  }
  const configPath = authStorageConfigPath();
  if (!existsSync(configPath)) {
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const betterAuth =
      parsed && typeof parsed === "object" && parsed["better-auth"] &&
      typeof parsed["better-auth"] === "object"
        ? (parsed["better-auth"] as Record<string, unknown>)
        : null;
    if (betterAuth && "cookie" in betterAuth) {
      appendRuntimeEventLog({
        category: "auth",
        event: "auth.cookie.startup_probe",
        outcome: "stale_blob_cleared",
        detail:
          "Persisted Better Auth cookie blob could not be decrypted (likely safeStorage key rotation); cleared so the app starts in a clean signed-out state.",
      });
      clearPersistedAuthCookie();
    }
  } catch {
    // Probe is best-effort.
  }
}

// Dev-mode hot reload for the runtime child process.
//
// `dev:runtime:watch` runs `tsup --watch` for each runtime package and
// symlinks `out/runtime-macos/runtime/{pkg}/dist` back to the source tree's
// dist directory, so an incremental rebuild lands in the location Electron
// already loads from. We just need to notice the rebuild and restart the
// child — Electron itself stays up, so the session cookie / renderer
// state / open windows are preserved across runtime code changes.
const DEV_RUNTIME_DIST_PACKAGES = ["api-server", "state-store", "harness-host"];
const DEV_RUNTIME_RESTART_DEBOUNCE_MS = 300;
let devRuntimeRestartTimer: NodeJS.Timeout | null = null;
let devRuntimeWatchersStarted = false;
const devRuntimeWatchers: FSWatcher[] = [];

function devRuntimeStagedDistDir(packageName: string): string {
  // __dirname inside the compiled main.cjs is
  // <repo>/apps/desktop/out/dist-electron. We watch the *staged* bundle
  // dist (not source-tree dist) because:
  //   * the runtime child loads from the staged dist (where the matching
  //     better-sqlite3 native binary lives, built for the bundled
  //     node-runtime's ABI);
  //   * watch-runtime-bundle.mjs copies source-tree dist -> staged dist
  //     after each tsup --watch rebuild, so the staged dist is the
  //     authoritative "is this restart-worthy" signal.
  // If we watched the source-tree dist instead, Electron could restart
  // the runtime before the file copy completed and the restart would
  // load the previous staged dist.
  return path.resolve(
    __dirname,
    "..",
    "runtime-macos",
    "runtime",
    packageName,
    "dist",
  );
}

function scheduleDevRuntimeRestart(reason: string): void {
  if (devRuntimeRestartTimer) {
    clearTimeout(devRuntimeRestartTimer);
  }
  devRuntimeRestartTimer = setTimeout(() => {
    devRuntimeRestartTimer = null;
    void restartEmbeddedRuntimeSafely(reason);
  }, DEV_RUNTIME_RESTART_DEBOUNCE_MS);
}

function setupDevRuntimeHotReload(): void {
  if (devRuntimeWatchersStarted || !isDev) {
    return;
  }
  devRuntimeWatchersStarted = true;
  for (const packageName of DEV_RUNTIME_DIST_PACKAGES) {
    const distDir = devRuntimeStagedDistDir(packageName);
    if (!existsSync(distDir)) {
      // staged dist hasn't been created yet — watch-runtime-bundle.mjs's
      // initial sync will populate it shortly, and the next save will
      // pick it up.
      continue;
    }
    try {
      const watcher = watch(distDir, (eventType, filename) => {
        if (!filename) return;
        if (!filename.endsWith(".mjs") && !filename.endsWith(".cjs")) return;
        scheduleDevRuntimeRestart(
          `dev_runtime_rebuilt:${packageName}/${filename}`,
        );
      });
      watcher.on("error", () => {
        // fs.watch can emit errors on macOS when the watched dir is
        // re-created; the watcher self-recovers on the next event so we
        // just swallow.
      });
      devRuntimeWatchers.push(watcher);
    } catch {
      // best-effort; missing watcher just falls back to manual restart
    }
  }
}

/**
 * Forward a rotated session cookie to the running runtime.
 *
 * Best-effort and deliberately silent: the runtime may not be up yet (this can
 * fire during startup, before the first spawn), and a failure here must never
 * break the caller — authCookieHeader() is on the path of ordinary requests.
 * A missed push self-corrects on the next rotation, and the spawn environment
 * carries the current value for any runtime started afterwards.
 */
function pushAuthCookieToRuntime(cookie: string): Promise<void> {
  return fetch(`${runtimeBaseUrl()}/api/v1/capabilities/auth-session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cookie }),
    signal: AbortSignal.timeout(5_000),
  })
    .then(() => undefined)
    .catch(() => undefined);
}

function authCookieHeader() {
  if (!desktopAuthClient) {
    return "";
  }

  // Always query better-auth's live storage first.
  //
  // Earlier this function short-circuited on `cachedCookieHeader` to
  // avoid hitting safeStorage on every call. That broke session
  // rotation: better-auth's client updates its stored cookie inside
  // the `onSuccess` fetch hook whenever the backend issues a fresh
  // `Set-Cookie` (which happens silently on `/api/auth/get-session`
  // and most other auth-touching endpoints). When we cached the very
  // first cookie value forever, every subsequent `authCookieHeader()`
  // returned the pre-rotation token. The backend then returned a
  // status 200 with `user: null` from get-session — looks like a
  // graceful "no session" but really means "you're sending a stale
  // token." `syncPersistedAuthSessionOnStartup` interpreted that as
  // signed-out and pushed `auth:userUpdated(null)` to the renderer,
  // which rendered the sign-in screen even though the user had a
  // perfectly valid session a moment ago — they would re-sign-in, the
  // rotation would happen again, and the loop repeated.
  //
  // The plaintext cache is now strictly a fallback for the case it
  // was originally built for (Electron dev restart where safeStorage
  // can't decrypt the prior run's blob); during a live session the
  // better-auth client's own storage is authoritative.
  let live = "";
  try {
    live = requireAuthClient().getCookie() || "";
  } catch {
    // fall through to plaintext fallback
  }
  if (isUsableCookieHeader(live)) {
    if (live !== cachedCookieHeader) {
      cachedCookieHeader = live;
      persistPlaintextAuthCache(live);
      // The runtime holds its own copy, taken from HOLABOSS_AUTH_COOKIE at
      // spawn. This function exists because that value rotates; the runtime had
      // no way to hear about it, so its cookie-authenticated calls (Composio
      // search / connections / proxy) eventually 401 while chat keeps working
      // on the model-proxy key. Rotation is detected exactly here, so this is
      // where it gets forwarded.
      void pushAuthCookieToRuntime(live);
    }
    return live;
  }

  // Better-auth's storage returned nothing usable. Use the in-memory
  // cache (loaded from plaintext at startup) so dev restarts with a
  // broken safeStorage key don't force a fresh sign-in.
  if (cachedCookieHeader && isUsableCookieHeader(cachedCookieHeader)) {
    return cachedCookieHeader;
  }
  const fallback = loadPlaintextAuthCache();
  if (fallback) {
    cachedCookieHeader = fallback;
    return fallback;
  }

  logCookieReadErrorOnce("Better Auth cookie is missing or invalid.");
  clearPersistedAuthCookie();
  return "";
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

// Brief in-memory cache for get-session results so the 401-retry
// session-alive check doesn't fire 5x/sec when many requests fail at
// once. Keyed on the cookie header — any cookie rotation forces a
// fresh lookup.
const AUTH_SESSION_CACHE_TTL_MS = 10_000;
let cachedAuthSession: {
  cookie: string;
  user: AuthUserPayload | null;
  atMs: number;
} | null = null;

function invalidateCachedAuthSession(): void {
  cachedAuthSession = null;
}

async function getAuthenticatedUser(): Promise<AuthUserPayload | null> {
  if (!AUTH_BASE_URL) {
    return null;
  }

  const cookieHeader = authCookieHeader();
  if (!cookieHeader) {
    invalidateCachedAuthSession();
    return null;
  }

  const now = Date.now();
  if (
    cachedAuthSession &&
    cachedAuthSession.cookie === cookieHeader &&
    now - cachedAuthSession.atMs < AUTH_SESSION_CACHE_TTL_MS
  ) {
    return cachedAuthSession.user;
  }

  const startedAt = Date.now();
  let response: Response;
  try {
    // Bounded deliberately: RequireAuth holds the entire shell on this
    // promise, so an unanswered request here is a permanent boot splash with
    // no error path — a captive portal or a slow api host, not just an
    // offline one. Failing is recoverable; hanging is not.
    response = await fetch(`${AUTH_BASE_URL}/api/auth/get-session`, {
      method: "GET",
      headers: {
        Cookie: cookieHeader,
      },
      signal: AbortSignal.timeout(MAIN_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    logBffFetch({
      category: "auth",
      method: "GET",
      path: "/api/auth/get-session",
      status: null,
      durationMs: Date.now() - startedAt,
      hasCookie: true,
      error,
    });
    throw error;
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      logBffFetch({
        category: "auth",
        method: "GET",
        path: "/api/auth/get-session",
        status: response.status,
        durationMs: Date.now() - startedAt,
        hasCookie: true,
      });
      clearPersistedAuthCookie();
      return null;
    }
    const detail = await response.text();
    logBffFetch({
      category: "auth",
      method: "GET",
      path: "/api/auth/get-session",
      status: response.status,
      durationMs: Date.now() - startedAt,
      hasCookie: true,
      bodyExcerpt: detail,
    });
    throw new Error(
      detail || `Failed to load auth session with status ${response.status}`,
    );
  }

  const payload = (await response.json()) as { user?: AuthUserPayload } | null;
  // get-session returns 200 with user:null when the cookie is stale or the
  // session was revoked server-side — log it as such so the dev terminal
  // shows the silent failure path (the one we fought in 506e4d43).
  logBffFetch({
    category: "auth",
    method: "GET",
    path: "/api/auth/get-session",
    status: response.status,
    durationMs: Date.now() - startedAt,
    hasCookie: true,
    bodyExcerpt: payload?.user ? `user=${payload.user.id}` : "user=null",
  });
  const resolvedUser = payload?.user ?? null;
  cachedAuthSession = {
    cookie: cookieHeader,
    user: resolvedUser,
    atMs: Date.now(),
  };
  return resolvedUser;
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
  if (
    runtimeConfigNeedsManagedHolabossModelRefresh(
      document,
      runtimeModelCatalogState.providerModelGroups,
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

// Keep runtime-config.json's `org_id` aligned with the live active org (the same
// value resolveDesktopActiveOrgId() and the renderer's getActiveOrganization()
// return). The /main-sessions filter reads currentActiveOrgId() from this file,
// so if it drifts from the active org the session list scopes to the wrong org.
// Only writes on a change. Best-effort — a failure leaves the previous org_id,
// which a manual org switch (auth:setActiveOrganization) still corrects.
async function syncRuntimeConfigActiveOrg(
  currentConfig: Record<string, string>,
): Promise<void> {
  try {
    const [activeOrgId, byoOrgId] = await Promise.all([
      resolveDesktopActiveOrgId(),
      resolveDesktopByoOrgId(),
    ]);
    const currentOrgId =
      typeof currentConfig.org_id === "string" && currentConfig.org_id.trim()
        ? currentConfig.org_id.trim()
        : null;
    const currentByoOrgId =
      typeof currentConfig.byo_org_id === "string" &&
      currentConfig.byo_org_id.trim()
        ? currentConfig.byo_org_id.trim()
        : null;
    // byoOrgId can change while orgId stays null (a personal user bills to the
    // null org but carries a personal-org id for BYO), so gate on either.
    if (activeOrgId !== currentOrgId || byoOrgId !== currentByoOrgId) {
      await writeRuntimeConfigFile({ orgId: activeOrgId, byoOrgId });
    }
  } catch {
    // Leave the existing org_id; the switch handler remains a fallback.
  }
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
      // Even when the binding is reused (the common re-boot / upgrade path), keep
      // the active-org attribution current. Without this, an upgrade that carried
      // over a stale `org_id` left /main-sessions scoped to the wrong org, so the
      // user booted into Personal with no sessions until a manual org switch.
      await syncRuntimeConfigActiveOrg(currentConfig);
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
      const [activeOrgId, byoOrgId] = await Promise.all([
        resolveDesktopActiveOrgId(),
        resolveDesktopByoOrgId(),
      ]);
      const nextConfig = await writeRuntimeConfigFile({
        authToken: modelProxyApiKey,
        modelProxyApiKey,
        userId: binding.holaboss_user_id,
        orgId: activeOrgId,
        byoOrgId,
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
      if (canUseExistingBindingOnRefreshFailure) {
        markTransientRuntimeBindingRefreshFailure(userId);
        appendRuntimeEventLog({
          category: "auth",
          event: "runtime_binding.provision",
          outcome: "skipped",
          detail: `${reason}:keep_existing_binding_after_refresh_failure:${detail}`,
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

// One-shot dedup so the same auth callback URL isn't exchanged twice. On
// macOS the deep link fires `open-url`, `second-instance`, and sometimes
// `process.argv`-on-launch for the same redirect — each path calls
// handleAuthCallbackUrl with the same URL. The second exchange uses an
// already-consumed token and the backend rejects it as "Invalid Better
// Auth session", which surfaces as a sign-in error to the waiting fetch
// and re-opens the sign-in browser — turning a single sign-in into a
// loop. Keep the entry for a minute so retries from any path collapse.
const PROCESSED_AUTH_CALLBACK_TTL_MS = 60_000;
const processedAuthCallbackUrls = new Map<string, NodeJS.Timeout>();

async function handleAuthCallbackUrl(targetUrl: string) {
  if (processedAuthCallbackUrls.has(targetUrl)) {
    return;
  }
  processedAuthCallbackUrls.set(
    targetUrl,
    setTimeout(() => {
      processedAuthCallbackUrls.delete(targetUrl);
    }, PROCESSED_AUTH_CALLBACK_TTL_MS),
  );
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
    captureCookieAfterSuccessfulAuth();
    const user = (result.data?.user ?? null) as AuthUserPayload | null;
    if (user) {
      emitAuthAuthenticated(user);
      emitAuthUserUpdated(user);
      try {
        // Do NOT force a new sandbox on every auth callback. The
        // existing logic in provisionRuntimeBindingForAuthenticatedUser
        // already generates a fresh sandbox when (a) no sandbox exists
        // yet, or (b) the signed-in user differs from the previously
        // bound user. Force-creating a new sandbox on every successful
        // sign-in tears down the runtime child process even when the
        // same user is signing in again, which causes an IPC outage
        // window in the renderer; the renderer interprets the outage as
        // a logged-out state and shows the sign-in card again, which
        // triggers another auth_callback, another forced sandbox, and
        // another restart — an endless login loop.
        await provisionRuntimeBindingForAuthenticatedUser(user, {
          forceNewSandbox: false,
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
          forceNewSandbox: false,
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
          forceNewSandbox: false,
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
// Hard floor on how often we open the sign-in popup automatically.
// Without this, a server endpoint that occasionally 401s while the
// session is actually fine (we saw `/api/v1/desktop-runtime/workspaces`
// behaving exactly this way during outages) would reopen the popup
// every time the user dismissed it.
const SIGNIN_POPUP_AUTO_COOLDOWN_MS = 60_000;
let lastAutoSigninPopupAtMs = 0;

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
 * Ceiling on any main-process request/response fetch.
 *
 * Node's fetch has no default timeout, so a backend that accepts the TCP
 * connection but never answers — the common hung-upstream failure, as opposed
 * to a refusal, which fails fast — leaves the renderer's promise pending for
 * undici's 300s headersTimeout. That surfaces as a spinner that never resolves
 * and never errors. 20s is well above any healthy call here and well below the
 * point where a user has concluded the app is broken.
 */
const MAIN_FETCH_TIMEOUT_MS = 20_000;

/**
 * Wraps fetch with a single retry against transient network errors, under a
 * bounded timeout.
 *
 * Backoff is short (200ms) because keep-alive socket races resolve as
 * soon as a fresh connection is opened. Auth/HTTP-level failures (4xx,
 * 5xx) are returned untouched — those go through retryAfterSessionAuth.
 *
 * A caller-supplied signal still wins: it is combined with the timeout rather
 * than replaced, so an explicit shorter deadline (or a cancellation) is
 * honoured. Timeouts are not retried — `isTransientFetchError` only matches
 * TypeErrors from undici, and an abort raises TimeoutError — so a stalled
 * upstream costs one timeout, not two.
 */
async function fetchWithNetworkRetry(
  ...args: Parameters<typeof fetch>
): Promise<Response> {
  const [input, init] = args;
  const callerSignal = init?.signal ?? null;
  // Built per attempt: reusing one signal would hand the retry an
  // already-aborted deadline.
  const initWithDeadline = (): RequestInit => {
    const timeoutSignal = AbortSignal.timeout(MAIN_FETCH_TIMEOUT_MS);
    return {
      ...init,
      signal: callerSignal
        ? AbortSignal.any([callerSignal, timeoutSignal])
        : timeoutSignal,
    };
  };
  try {
    return await fetch(input, initWithDeadline());
  } catch (err) {
    if (!isTransientFetchError(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 200));
    return fetch(input, initWithDeadline());
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
  if (!authCookieHeader()) {
    appendRuntimeEventLog({
      category: "auth",
      event: "session_retry_skipped",
      outcome: "skipped",
      detail: `path=${unauthorizedResponse.url} reason=no_cookie`,
    });
    return unauthorizedResponse;
  }

  // Verify the session is *actually* expired before opening sign-in.
  // get-session is the source of truth; some backend endpoints return
  // 401 transiently during their own outages (the prior bug:
  // `/api/v1/desktop-runtime/workspaces` 500s for ~10s then 401s once,
  // which fired the popup even though the session was perfectly fine
  // — get-session continued returning 200 user=… the whole time).
  // If the session is alive we do a single silent retry and skip the
  // popup entirely.
  const sessionUser = await getAuthenticatedUser().catch(() => null);
  if (sessionUser) {
    appendRuntimeEventLog({
      category: "auth",
      event: "session_alive_silent_retry",
      outcome: "start",
      detail: `path=${unauthorizedResponse.url}`,
    });
    try {
      const retried = await executeRequest();
      appendRuntimeEventLog({
        category: "auth",
        event: "session_alive_silent_retry",
        outcome: retried.ok ? "success" : "error",
        detail: `path=${unauthorizedResponse.url} status=${retried.status}`,
      });
      return retried;
    } catch (error) {
      appendRuntimeEventLog({
        category: "auth",
        event: "session_alive_silent_retry",
        outcome: "error",
        detail: `path=${unauthorizedResponse.url} err=${String(error).slice(0, 200)}`,
      });
      return unauthorizedResponse;
    }
  }

  // Session is genuinely dead. Rate-limit popup opens so a tight
  // 401-emitting loop can't reopen the browser the moment the user
  // dismisses it.
  const now = Date.now();
  if (
    !pendingGatewayAuthRetry &&
    now - lastAutoSigninPopupAtMs < SIGNIN_POPUP_AUTO_COOLDOWN_MS
  ) {
    appendRuntimeEventLog({
      category: "auth",
      event: "signin_popup_rate_limited",
      outcome: "skipped",
      detail: `path=${unauthorizedResponse.url} cooldown_remaining_ms=${
        SIGNIN_POPUP_AUTO_COOLDOWN_MS - (now - lastAutoSigninPopupAtMs)
      }`,
    });
    return unauthorizedResponse;
  }

  appendRuntimeEventLog({
    category: "auth",
    event: "session_retry_triggered",
    outcome: pendingGatewayAuthRetry ? "deduped" : "start",
    detail: `path=${unauthorizedResponse.url} popup=${pendingGatewayAuthRetry ? "in_flight" : "opening"}`,
  });
  try {
    if (!pendingGatewayAuthRetry) {
      lastAutoSigninPopupAtMs = now;
      const authComplete = waitForAuthCallback();
      appendRuntimeEventLog({
        category: "auth",
        event: "signin_popup_open",
        outcome: "start",
        detail: `trigger=retry_after_401 path=${unauthorizedResponse.url}`,
      });
      requireAuthClient()
        .requestAuth()
        .catch((error) => {
          appendRuntimeEventLog({
            category: "auth",
            event: "signin_popup_open",
            outcome: "error",
            detail: `err=${String(error).slice(0, 200)}`,
          });
        });
      pendingGatewayAuthRetry = authComplete.finally(() => {
        pendingGatewayAuthRetry = null;
      });
    }
    await pendingGatewayAuthRetry;
    return await executeRequest();
  } catch (error) {
    appendRuntimeEventLog({
      category: "auth",
      event: "session_retry_completed",
      outcome: "error",
      detail: `path=${unauthorizedResponse.url} err=${String(error).slice(0, 200)}`,
    });
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

// Per-path circuit breaker. After N consecutive 5xx responses we skip
// the path for COOLDOWN_MS so the client doesn't keep hammering a
// sick endpoint (current trigger: /api/v1/desktop-runtime/workspaces
// 500s for ~11s/request during projects-service outages).
const CONTROL_PLANE_5XX_THRESHOLD = 3;
const CONTROL_PLANE_COOLDOWN_MS = 30_000;
const controlPlaneConsecutive5xx = new Map<string, number>();
const controlPlaneCooldownUntil = new Map<string, number>();

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

  const cooldownUntil = controlPlaneCooldownUntil.get(requestPath) ?? 0;
  const nowMs = Date.now();
  if (nowMs < cooldownUntil) {
    appendRuntimeEventLog({
      category: "control_plane",
      event: "backoff_skip",
      outcome: "skipped",
      detail: `path=${requestPath} cooldown_remaining_ms=${cooldownUntil - nowMs}`,
    });
    throw new Error(
      `Control-plane ${requestPath} is in cooldown after repeated 5xx; will retry automatically.`,
    );
  }

  const executeRequest = async () => {
    const startedAt = Date.now();
    const headers = await controlPlaneHeaders("projects");
    const hasCookie = Boolean(authCookieHeader());
    try {
      const response = await fetchWithNetworkRetry(url.toString(), {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      logBffFetch({
        category: "control_plane",
        method,
        path: requestPath,
        status: response.status,
        durationMs: Date.now() - startedAt,
        hasCookie,
      });
      return response;
    } catch (error) {
      logBffFetch({
        category: "control_plane",
        method,
        path: requestPath,
        status: null,
        durationMs: Date.now() - startedAt,
        hasCookie,
        error,
      });
      throw error;
    }
  };

  let response = await executeRequest();
  if (response.status === 401) {
    response = await retryAfterSessionAuth(response, executeRequest);
  }
  if (response.status >= 500) {
    const next = (controlPlaneConsecutive5xx.get(requestPath) ?? 0) + 1;
    if (next >= CONTROL_PLANE_5XX_THRESHOLD) {
      controlPlaneCooldownUntil.set(
        requestPath,
        Date.now() + CONTROL_PLANE_COOLDOWN_MS,
      );
      controlPlaneConsecutive5xx.set(requestPath, 0);
      appendRuntimeEventLog({
        category: "control_plane",
        event: "backoff_triggered",
        outcome: "start",
        detail: `path=${requestPath} cooldown_ms=${CONTROL_PLANE_COOLDOWN_MS}`,
      });
    } else {
      controlPlaneConsecutive5xx.set(requestPath, next);
    }
  } else if (response.ok) {
    controlPlaneConsecutive5xx.delete(requestPath);
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

async function listIssues(
  workspaceId: string,
): Promise<IssueListResponsePayload> {
  if (!workspaceId.trim()) {
    return { issues: [], count: 0 };
  }
  return requestWorkspaceRuntimeJson<IssueListResponsePayload>(workspaceId, {
    method: "GET",
    path: "/api/v1/issues",
    params: {
      workspace_id: workspaceId,
    },
  });
}

async function createIssue(
  payload: CreateIssuePayload,
): Promise<CreateIssueResponsePayload> {
  return requestWorkspaceRuntimeJson<CreateIssueResponsePayload>(
    payload.workspace_id,
    {
      method: "POST",
      path: "/api/v1/issues",
      payload: {
        workspace_id: payload.workspace_id,
        blocked_by: payload.blocked_by ?? [],
        title: payload.title,
        description: payload.description ?? null,
        status: payload.status,
        priority: payload.priority ?? null,
        blocker_reason: payload.blocker_reason ?? null,
        attachments: payload.attachments ?? [],
      },
    },
  );
}

async function updateIssue(
  workspaceId: string,
  issueId: string,
  payload: UpdateIssuePayload,
): Promise<UpdateIssueResponsePayload> {
  if (!workspaceId.trim()) {
    throw new Error("workspace_id is required");
  }
  if (!issueId.trim()) {
    throw new Error("issueId is required");
  }
  return requestWorkspaceRuntimeJson<UpdateIssueResponsePayload>(workspaceId, {
    method: "PATCH",
    path: `/api/v1/issues/${encodeURIComponent(issueId)}`,
      payload: {
        workspace_id: workspaceId,
        blocked_by: payload.blocked_by ?? undefined,
        title: payload.title ?? undefined,
        description: payload.description ?? undefined,
        status: payload.status ?? undefined,
        priority: payload.priority ?? undefined,
        blocker_reason: payload.blocker_reason ?? undefined,
        attachments: payload.attachments ?? undefined,
      },
    });
}

async function stopIssueRun(
  workspaceId: string,
  issueId: string,
): Promise<StopIssueRunResponsePayload> {
  if (!workspaceId.trim()) {
    throw new Error("workspace_id is required");
  }
  if (!issueId.trim()) {
    throw new Error("issueId is required");
  }
  return requestWorkspaceRuntimeJson<StopIssueRunResponsePayload>(workspaceId, {
    method: "POST",
    path: `/api/v1/issues/${encodeURIComponent(issueId)}/stop`,
    payload: {
      workspace_id: workspaceId,
    },
  });
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

interface MemoryBrowserNodeEvidenceRef {
  ref_id: string;
  provider: string | null;
  account_namespace: string | null;
  connection_id: string | null;
  external_object_id: string | null;
  external_object_type: string | null;
  source_type: string | null;
  source_event_id: string | null;
  source_message_id: string | null;
  source_turn_input_id: string | null;
  observed_at: string | null;
  metadata: Record<string, unknown>;
}

type MemoryBrowserGraphForest = "workspace";
type MemoryBrowserGraphNodeKind = "root" | "section" | "tree" | "node" | "summary" | "leaf";

interface MemoryBrowserGraphNode {
  id: string;
  kind: MemoryBrowserGraphNodeKind;
  category: "workspace";
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

interface MemoryBrowserGraphLimits {
  max_layers: number;
  max_nodes: number;
  total_nodes: number;
  total_edges: number;
  displayed_nodes: number;
  displayed_edges: number;
  truncated_by_layers: boolean;
  truncated_by_nodes: boolean;
}

interface MemoryBrowserGraphResponse {
  workspace_id: string;
  forest: MemoryBrowserGraphForest;
  focus_tree_id: string | null;
  nodes: MemoryBrowserGraphNode[];
  edges: MemoryBrowserGraphEdge[];
  limits: MemoryBrowserGraphLimits;
}

interface MemoryBrowserNodeRelation {
  relation_type: string;
  source_node_id: string;
  source_label: string | null;
  source_tree_id: string | null;
  target_node_id: string;
  target_label: string | null;
  target_tree_id: string | null;
  target_entity_key: string | null;
  target_resolution_kind: "resolved" | "synthetic" | "missing";
  metadata: Record<string, unknown>;
}

interface MemoryBrowserNodeDetailResponse {
  workspace_id: string;
  node_id: string;
  tree_id: string | null;
  category: "workspace";
  kind: MemoryBrowserGraphNodeKind | null;
  label: string | null;
  subtitle: string | null;
  path: string | null;
  evidence_refs: MemoryBrowserNodeEvidenceRef[];
  outgoing_relations: MemoryBrowserNodeRelation[];
  incoming_relations: MemoryBrowserNodeRelation[];
}

// The first memory-browser read can trigger artifact-tree backfills and stale
// memory repairs for an older workspace. Those repair passes are legitimate
// read-time work, but they routinely exceed the generic 15s runtime request
// budget used by lighter settings endpoints.
const MEMORY_BROWSER_RUNTIME_TIMEOUT_MS = 120_000;

async function listMemoryBrowserTree(
  workspaceId: string,
): Promise<MemoryBrowserTreeResponse> {
  return requestWorkspaceRuntimeJson<MemoryBrowserTreeResponse>(workspaceId, {
    method: "GET",
    path: "/api/v1/memory/browser/tree",
    params: {
      workspace_id: workspaceId,
    },
    timeoutMs: MEMORY_BROWSER_RUNTIME_TIMEOUT_MS,
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
    timeoutMs: MEMORY_BROWSER_RUNTIME_TIMEOUT_MS,
  });
}

async function readMemoryBrowserNodeDetail(
  workspaceId: string,
  params: { nodeId: string; treeId?: string | null },
): Promise<MemoryBrowserNodeDetailResponse> {
  const nodeId = typeof params?.nodeId === "string" ? params.nodeId.trim() : "";
  if (!nodeId) {
    throw new Error("readMemoryBrowserNodeDetail: nodeId is required");
  }
  return requestWorkspaceRuntimeJson<MemoryBrowserNodeDetailResponse>(workspaceId, {
    method: "GET",
    path: "/api/v1/memory/browser/node-detail",
    params: {
      workspace_id: workspaceId,
      node_id: nodeId,
      tree_id: params?.treeId?.trim() || undefined,
    },
    timeoutMs: MEMORY_BROWSER_RUNTIME_TIMEOUT_MS,
  });
}

async function listMemoryBrowserGraph(
  workspaceId: string,
  params: {
    forest: MemoryBrowserGraphForest;
    treeId?: string | null;
    maxLayers?: number | null;
    maxNodes?: number | null;
  },
): Promise<MemoryBrowserGraphResponse> {
  const forest = params.forest;
  if (forest !== "workspace") {
    throw new Error("listMemoryBrowserGraph: forest must be workspace");
  }
  return requestWorkspaceRuntimeJson<MemoryBrowserGraphResponse>(workspaceId, {
    method: "GET",
    path: "/api/v1/memory/browser/graph",
    params: {
      workspace_id: workspaceId,
      forest,
      tree_id: params.treeId?.trim() || undefined,
      max_layers: params.maxLayers ?? undefined,
      max_nodes: params.maxNodes ?? undefined,
    },
    timeoutMs: MEMORY_BROWSER_RUNTIME_TIMEOUT_MS,
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
  return update;
}

async function updateIntegrationConnection(
  connectionId: string,
  payload: IntegrationUpdateConnectionPayload,
): Promise<IntegrationConnectionPayload> {
  const runtimeUpdate = runtimeIntegrationConnectionUpdatePayload(payload);
  if (Object.keys(runtimeUpdate).length > 0) {
    await requestRuntimeJson<IntegrationConnectionPayload>({
      method: "PATCH",
      path: `/api/v1/integrations/connections/${encodeURIComponent(connectionId)}`,
      payload: runtimeUpdate,
    });
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
    const startedAt = Date.now();
    const cookieHeader = authCookieHeader();
    try {
      const response = await fetchWithNetworkRetry(`${AUTH_BASE_URL}${path}`, {
        method,
        headers: {
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      logBffFetch({
        category: "composio",
        method,
        path,
        status: response.status,
        durationMs: Date.now() - startedAt,
        hasCookie: Boolean(cookieHeader),
      });
      return response;
    } catch (error) {
      logBffFetch({
        category: "composio",
        method,
        path,
        status: null,
        durationMs: Date.now() - startedAt,
        hasCookie: Boolean(cookieHeader),
        error,
      });
      throw error;
    }
  };

  let response = await executeRequest();
  if (response.status === 401) {
    response = await retryAfterSessionAuth(response, executeRequest);
  }

  if (!response.ok) {
    const text = await response.text();
    // Re-log on failure with the response body excerpt so the terminal
    // shows WHY the server rejected (e.g. "session_revoked", "csrf_mismatch").
    logBffFetch({
      category: "composio",
      method,
      path,
      status: response.status,
      hasCookie: Boolean(authCookieHeader()),
      bodyExcerpt: text,
    });
    throw new Error(
      `Composio API error (${response.status}): ${text.slice(0, 300)}`,
    );
  }
  // Any successful mutation (connect / reconnect / disconnect / execute)
  // can change the connection set, so drop the cached list — the next read
  // or keep-warm tick re-fetches the fresh truth.
  if (method !== "GET" && path.startsWith("/api/composio/")) {
    invalidateComposioConnectionsCache();
  }
  return response.json() as Promise<T>;
}

// ── Composio read cache ─────────────────────────────────────────────────────
// The connection list is the desktop's hottest Composio read: IntegrationsPane,
// the chat rail, the per-app-row binding poll and composioExecute all fetch it,
// and each call is a full Hono→Composio round trip (~600ms). Cache the two
// stable LIST reads in the main process (the fan-in point for every renderer
// surface) with inflight dedupe, and keep the connection list warm on a
// focus-gated timer so the UI always reads a fresh cache hit. Account-status
// reads are deliberately NOT cached — the OAuth connect poll needs live status.
const COMPOSIO_CONNECTIONS_PATH = "/api/composio/connections";
const COMPOSIO_TOOLKITS_PATH = "/api/composio/toolkits";
const COMPOSIO_CONNECTIONS_TTL_MS = 90_000;
const COMPOSIO_TOOLKITS_TTL_MS = 10 * 60_000;
const COMPOSIO_KEEP_WARM_INTERVAL_MS = 60_000;

interface ComposioCacheEntry {
  value: unknown;
  expiresAt: number;
}
const composioReadCache = new Map<string, ComposioCacheEntry>();
const composioReadInflight = new Map<string, Promise<unknown>>();
let composioKeepWarmTimer: NodeJS.Timeout | null = null;
// Bumped on every active-org switch. The read cache is keyed by PATH (not org),
// so an org switch invalidates it wholesale; the generation lets an in-flight
// request that started before the switch skip writing its now-stale result.
let composioCacheGeneration = 0;

async function composioCachedGet<T>(
  path: string,
  ttlMs: number,
  opts: { force?: boolean } = {},
): Promise<T> {
  if (!opts.force) {
    const cached = composioReadCache.get(path);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value as T;
    }
  }
  const inflight = composioReadInflight.get(path);
  if (inflight) {
    return inflight as Promise<T>;
  }
  const generationAtStart = composioCacheGeneration;
  const request = composioFetch<T>(path, "GET")
    .then((value) => {
      // Don't cache a result whose request began before an org switch — the
      // cache is path-keyed (org-blind), so writing it would re-poison the new
      // org with the previous org's data. The caller still gets `value`.
      if (generationAtStart === composioCacheGeneration) {
        composioReadCache.set(path, {
          value,
          expiresAt: Date.now() + ttlMs,
        });
      }
      return value;
    })
    .finally(() => {
      composioReadInflight.delete(path);
    });
  composioReadInflight.set(path, request as Promise<unknown>);
  return request as Promise<T>;
}

function invalidateComposioConnectionsCache(): void {
  composioReadCache.delete(COMPOSIO_CONNECTIONS_PATH);
}

// Wipe the (path-keyed, org-blind) composio read caches when the active org
// changes — their entries hold the PREVIOUS org's connections/toolkits and
// would otherwise be served stale until their TTL. Bumping the generation makes
// any in-flight request that began before the switch skip its cache write.
function resetComposioCachesForOrgSwitch(): void {
  composioCacheGeneration += 1;
  composioReadCache.clear();
  composioReadInflight.clear();
}

async function refreshComposioConnectionsCache(): Promise<void> {
  if (!authCookieHeader()) {
    return;
  }
  try {
    await composioCachedGet(
      COMPOSIO_CONNECTIONS_PATH,
      COMPOSIO_CONNECTIONS_TTL_MS,
      { force: true },
    );
  } catch {
    // Keep-warm is best-effort; the next read or tick retries.
  }
}

function startComposioKeepWarm(): void {
  if (composioKeepWarmTimer) {
    return;
  }
  composioKeepWarmTimer = setInterval(() => {
    // Only spend the round trip while the user is actually in the app —
    // pauses on blur/hide, resumes via the window "focus" handler's
    // immediate refresh.
    if (
      !authCookieHeader() ||
      !mainWindow ||
      mainWindow.isDestroyed() ||
      !mainWindow.isFocused()
    ) {
      return;
    }
    void refreshComposioConnectionsCache();
  }, COMPOSIO_KEEP_WARM_INTERVAL_MS);
  composioKeepWarmTimer.unref();
}

function stopComposioKeepWarm(): void {
  if (composioKeepWarmTimer) {
    clearInterval(composioKeepWarmTimer);
    composioKeepWarmTimer = null;
  }
}

async function composioConnect(payload: {
  provider: string;
  owner_user_id: string;
  callback_url?: string;
  whoami?: PendingIntegrationWhoami | null;
  auth_scheme?: string;
  credentials?: Record<string, string>;
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

// Read-only: how to connect this toolkit — OAuth (managed) or a credential
// form (scheme + fields). Drives the connect dialog's branch.
async function composioToolkitAuth(
  toolkitSlug: string,
): Promise<ComposioToolkitAuth> {
  const slug = composioToolkitSlugForProvider(toolkitSlug);
  return composioFetch<ComposioToolkitAuth>(
    `/api/composio/toolkits/${encodeURIComponent(slug)}/auth`,
    "GET",
  );
}

interface ComposioReconnectResult {
  id: string;
  status: string;
  redirect_url: string | null;
}

// Re-authorize an existing connected account IN PLACE (same connected_account_id)
// instead of minting a new one via /connect. Composio returns a fresh
// redirect_url for the OAuth re-grant; the connection id is preserved.
async function composioReconnect(
  connectedAccountId: string,
): Promise<ComposioReconnectResult> {
  return composioFetch<ComposioReconnectResult>(
    `/api/composio/connections/${encodeURIComponent(connectedAccountId)}/refresh`,
    "POST",
    {},
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
  return composioCachedGet<{ toolkits: ComposioToolkit[] }>(
    COMPOSIO_TOOLKITS_PATH,
    COMPOSIO_TOOLKITS_TTL_MS,
  );
}

interface ComposioConnectionSummary {
  id: string;
  status: string;
  toolkitSlug: string;
  toolkitName: string;
  toolkitLogo: string | null;
  userId: string;
  createdAt: string;
  canResolveIdentity?: boolean;
}

async function composioListConnections(force = false): Promise<{
  connections: ComposioConnectionSummary[];
}> {
  return composioCachedGet<{ connections: ComposioConnectionSummary[] }>(
    COMPOSIO_CONNECTIONS_PATH,
    COMPOSIO_CONNECTIONS_TTL_MS,
    { force },
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
// while provider fetch plans are still expanding.
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

/**
 * Status for a connection whose stored token failed against the provider
 * (whoami 401/403). Composio may still cache the account as ACTIVE, but the
 * credential is dead — surface "expired" so the UI prompts a reconnect and
 * status queries never throw an unhandled provider error to the renderer.
 */
function expiredComposioStatus(
  connectedAccountId: string,
): ComposioAccountStatus {
  return {
    id: connectedAccountId,
    status: "expired",
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
    if (isDev) {
      // Hono /api/composio/proxy returned 200 with this envelope, meaning
      // *the upstream provider* (Google / GitHub / Slack / etc.) rejected
      // Composio's proxied request. Dump the full envelope so we can see
      // the exact upstream status, headers, and body — the 200-char
      // excerpt above is rarely enough to tell scope-mismatch from
      // token-revoked from outright-misconfig.
      let fullBody: string;
      try {
        fullBody = JSON.stringify(wrapped.data, null, 2).slice(0, 4000);
      } catch {
        fullBody = String(wrapped.data).slice(0, 4000);
      }
      console.warn("[composio:proxy] upstream non-2xx", {
        provider: providerIdForErrors,
        connectedAccountId,
        upstreamMethod: method,
        upstreamEndpoint: endpoint,
        upstreamStatus: wrapped.status,
        upstreamHeaders: wrapped.headers,
        upstreamBody: fullBody,
      });
    }
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
  if (isDev) {
    // Entry trace so we can correlate the post-connect verification with
    // the upstream non-2xx logged inside composioProxyFetch. Critical
    // when debugging "did reconnect actually use the new account_id, or
    // are we still looking at the stale one?".
    console.info("[composio:whoami] calling", {
      provider: normalized,
      connectedAccountId,
      url: config.url,
      method: config.method,
    });
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
 * `@alice` no longer show as "Account 1".
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


  // Stage 3: Composio is the single source of truth — we no longer mirror the
  // connection into the local control-plane store. Display reads the remote
  // Hono API (Stage 1) and the agent resolves toolkits remote-first (Stage 2).
  // Return a synthetic payload keyed by the Composio account id so the connect
  // flow's default-account binding + app rebind reference the same id the
  // remote enumeration and bindings use; the pane refreshes from remote.
  const nowIso = new Date().toISOString();
  return {
    connection_id: payload.connected_account_id,
    provider_id: payload.provider,
    owner_user_id: payload.owner_user_id,
    account_label: resolvedLabel ?? payload.account_label ?? "",
    account_external_id: payload.connected_account_id,
    account_handle: enrichedHandle,
    account_email: enrichedEmail,
    auth_mode: "composio",
    granted_scopes: [],
    status: "active",
    secret_ref: null,
    created_at: nowIso,
    updated_at: nowIso,
  };
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

/**
 * Post-connect / post-install hook: make newly available tools reachable.
 *
 * The composio-mcp host this used to start no longer exists. Composio tools are
 * resolved inline now, and the runtime actively removes the legacy
 * `holaboss_composio` registry entry — so `/api/v1/composio-mcp/ensure-running`
 * has had no route for some time and every call here 404'd straight into the
 * callers' `catch {}`.
 *
 * That silently removed the only step that made a just-connected integration's
 * tools reachable: the runtime kept serving its cached tool listing (15 min TTL),
 * so the agent reported the publish tool as "still loading" turn after turn and
 * users abandoned the task.
 *
 * Refreshing is the live equivalent — it drops the workspace's MCP tool cache and
 * the cached Composio listing, so the next turn re-resolves both. Kept under the
 * original name so the three renderer call sites (chat connect proposal, add-app,
 * marketplace install) keep working; the name is stale and worth retiring
 * separately.
 */
async function composioMcpEnsureRunning(workspaceId: string): Promise<unknown> {
  return refreshWorkspaceMcpTools(workspaceId);
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

async function pickProjectFolder(
  event: Electron.IpcMainInvokeEvent,
): Promise<string | null> {
  // Projects accept ANY directory (existing or new) — no emptiness check.
  // Two projects pointing at the same path is allowed per spec.
  const ownerWindow =
    BrowserWindow.fromWebContents(event.sender) ??
    mainWindow ??
    BrowserWindow.getFocusedWindow() ??
    null;
  const options: OpenDialogOptions = {
    properties: ["openDirectory", "createDirectory"],
    title: "Choose Project Folder",
    buttonLabel: "Use This Folder",
    message: "Pick a folder for this project.",
  };
  const result = ownerWindow
    ? await dialog.showOpenDialog(ownerWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) {
    return null;
  }
  const chosen = path.resolve(result.filePaths[0]);
  if (!path.isAbsolute(chosen)) {
    throw new Error("Project folder path must be absolute.");
  }
  return chosen;
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
  if (
    error instanceof Error &&
    isRuntimeHealthcheckStartupFailureMessage(error.message)
  ) {
    return true;
  }
  if (isRuntimeRestartConnectivityError(error)) {
    return true;
  }
  return sdkIsTransientRuntimeError(error);
}

// ECONNREFUSED: runtime port is closed (process restarting or just died).
// ECONNRESET / socket hang up: in-flight request was severed when the
// runtime exited mid-call.
// ETIMEDOUT: connect() never got a SYN-ACK from the runtime within the
// kernel's connect timeout — typical when the runtime is alive (port
// still bound) but the event loop is blocked, so the accept queue
// stalls. Treat all four as transient: the recovery is to wait for
// the runtime to come back, then retry.
const RUNTIME_RESTART_CONNECTIVITY_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
]);
function isRuntimeRestartConnectivityError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code;
  if (code && RUNTIME_RESTART_CONNECTIVITY_CODES.has(code)) {
    return true;
  }
  const causeCode = (error as { cause?: { code?: string } }).cause?.code;
  return Boolean(
    causeCode && RUNTIME_RESTART_CONNECTIVITY_CODES.has(causeCode),
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
): Record<string, string> {
  const authToken = (session.runtime_auth_token ?? "").trim();
  return {
    "X-Holaboss-Workspace-Id": session.workspace_id,
    ...(authToken ? { "X-API-Key": authToken } : {}),
  };
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
  // GETs always retry. Mutations only retry on ECONNREFUSED (request never
  // reached the runtime → safe to replay) — not on ECONNRESET (request
  // may have been partially processed, replaying could duplicate).
  const baseAttempts = method === "GET" || retryTransientErrors ? 3 : 1;
  let attempt = 0;
  let lastError: unknown;
  const maxAttempts = 3;
  while (attempt < maxAttempts) {
    attempt += 1;
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
      return await requestRuntimeJsonViaHttp<T>(
        url,
        method,
        payload,
        timeoutMs,
        workspaceRuntimeSessionHeaders(session),
      );
    } catch (error) {
      lastError = error;
      const isRestart = isRuntimeRestartConnectivityError(error);
      const code = (error as { code?: string }).code;
      const safeToReplay =
        baseAttempts > 1 ||
        (method !== "GET" && code === "ECONNREFUSED");
      if (isRestart && safeToReplay && attempt < maxAttempts) {
        appendRuntimeEventLog({
          category: "runtime",
          event: "request_during_restart",
          outcome: "retry",
          detail: `${method} ${requestPath} code=${code ?? "unknown"} attempt=${attempt}/${maxAttempts}`,
        });
        try {
          await ensureRuntimeReady();
        } catch {
          // ensureRuntimeReady may itself throw if the runtime can't come
          // back; let the next iteration fail naturally with a clearer error.
        }
        continue;
      }
      if (attempt < baseAttempts && isTransientRuntimeError(error)) {
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new Error("Workspace runtime request failed after retries.");
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
      await ensureDefaultWorkspaceSkills(resolved);
      return resolved;
    }
  } catch {
    // Fall through to the default (runtime may be unavailable at this moment).
  }
  const fallbackDir = workspaceDirectoryPath(safeId);
  await ensureDefaultWorkspaceSkills(fallbackDir);
  return fallbackDir;
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

function workspaceRelativeFilePathOrNull(
  workspaceDir: string,
  absolutePath: string,
): string | null {
  const relativePath = path.relative(workspaceDir, absolutePath);
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    return null;
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

const ATTACHMENT_SIGNATURE_BYTES = 64;

async function readAttachmentSignature(
  absolutePath: string,
  maxBytes = ATTACHMENT_SIGNATURE_BYTES,
): Promise<Buffer> {
  const handle = await fs.open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function stageMaterializedAttachment(params: {
  workspaceDir: string;
  relativeRoot: string;
  usedNames: Set<string>;
  sourceName: string;
  declaredMimeType?: string | null;
  sourcePath?: string;
  content?: Buffer;
}): Promise<SessionInputAttachmentPayload> {
  async function persistAttachmentMaterialization(materialized: {
    name: string;
    mimeType: string;
    kind: "image" | "file";
    sourcePath?: string;
    content?: Buffer;
  }): Promise<SessionInputAttachmentPayload> {
    const stagedName = dedupeAttachmentName(
      materialized.name,
      params.usedNames,
    );
    const relativePath = path.posix.join(params.relativeRoot, stagedName);
    const absolutePath = resolveWorkspaceMaterializedFilePath(
      params.workspaceDir,
      relativePath,
    );
    if (materialized.content) {
      await fs.writeFile(absolutePath, materialized.content);
    } else if (materialized.sourcePath) {
      await fs.copyFile(materialized.sourcePath, absolutePath);
    } else {
      throw new Error("Attachment source bytes or source path is required");
    }
    const stat = await fs.stat(absolutePath);
    return {
      id: randomUUID(),
      kind: materialized.kind,
      name: stagedName,
      mime_type: materialized.mimeType,
      size_bytes: stat.size,
      workspace_path: relativePath,
    };
  }

  const name = sanitizeAttachmentName(params.sourceName);
  const inspectBytes =
    params.content ??
    await readAttachmentSignature(params.sourcePath ?? "");
  const resolvedMimeType = resolveStagedAttachmentMimeType({
    name,
    declaredMimeType: params.declaredMimeType,
    bytes: inspectBytes,
  });

  if (resolvedMimeType.startsWith("image/")) {
    let imageSourcePath = params.sourcePath;
    let imageSourceContent = params.content;
    let imageSourceMimeType = resolvedMimeType;
    let imageSourceName = name;
    let cleanupDir: string | null = null;

    try {
      if (isHeicAttachmentMimeType(resolvedMimeType)) {
        cleanupDir = await fs.mkdtemp(path.join(os.tmpdir(), "holaboss-heic-stage-"));
        imageSourceName = replaceAttachmentExtension(
          name,
          HEIC_CONVERSION_OUTPUT_EXTENSION,
        );
        imageSourcePath = path.join(
          cleanupDir,
          replaceAttachmentExtension(name, HEIC_CONVERSION_OUTPUT_EXTENSION),
        );
        imageSourceContent = undefined;
        if (params.content) {
          await convertHeicBufferToJpeg({
            bytes: params.content,
            sourceName: name,
            targetPath: imageSourcePath,
          });
        } else if (params.sourcePath) {
          await convertHeicFileToJpeg({
            sourcePath: params.sourcePath,
            targetPath: imageSourcePath,
          });
        } else {
          throw new Error("Attachment source bytes or source path is required");
        }
        imageSourceMimeType = HEIC_CONVERSION_OUTPUT_MIME_TYPE;
      }

      const normalizedImage = await normalizeInlineImageMaterialization({
        sourceMimeType: imageSourceMimeType,
        ...(imageSourceContent
          ? { sourceBytes: imageSourceContent }
          : imageSourcePath
            ? { sourcePath: imageSourcePath }
            : {}),
      });

      if (normalizedImage.action === "copy") {
        return await persistAttachmentMaterialization({
          name: imageSourceName,
          mimeType: normalizedImage.mimeType,
          kind: "image",
          ...(imageSourceContent
            ? { content: imageSourceContent }
            : imageSourcePath
              ? { sourcePath: imageSourcePath }
              : {}),
        });
      }

      if (normalizedImage.action === "write") {
        return await persistAttachmentMaterialization({
          name: replaceAttachmentExtension(
            imageSourceName,
            normalizedImage.outputExtension,
          ),
          mimeType: normalizedImage.mimeType,
          kind: "image",
          content: normalizedImage.bytes,
        });
      }

      console.warn(
        `[attachments] Image normalization downgraded ${name} to staged file: ${normalizedImage.reason}`,
      );
      return await persistAttachmentMaterialization({
        name: imageSourceName,
        mimeType: imageSourceMimeType,
        kind: "file",
        ...(imageSourceContent
          ? { content: imageSourceContent }
          : imageSourcePath
            ? { sourcePath: imageSourcePath }
            : {}),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `[attachments] Image staging failed for ${name}; staging original bytes as file instead: ${detail}`,
      );
      return await persistAttachmentMaterialization({
        name,
        mimeType: resolvedMimeType,
        kind: "file",
        ...(params.content
          ? { content: params.content }
          : params.sourcePath
            ? { sourcePath: params.sourcePath }
            : {}),
      });
    } finally {
      if (cleanupDir) {
        await fs.rm(cleanupDir, { recursive: true, force: true });
      }
    }
  }

  return await persistAttachmentMaterialization({
    name,
    mimeType: resolvedMimeType,
    kind: stagedAttachmentKind(resolvedMimeType),
    ...(params.content
      ? { content: params.content }
      : params.sourcePath
        ? { sourcePath: params.sourcePath }
        : {}),
  });
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

    const content = Buffer.from(contentBase64, "base64");
    attachments.push(
      await stageMaterializedAttachment({
        workspaceDir,
        relativeRoot,
        usedNames,
        sourceName: file?.name ?? "",
        declaredMimeType: file?.mime_type,
        content,
      }),
    );
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

    const inWorkspacePath = workspaceRelativeFilePathOrNull(
      workspaceDir,
      absolutePath,
    );
    if (requestedKind === "file" && inWorkspacePath) {
      const signature = await readAttachmentSignature(absolutePath);
      attachments.push({
        id: randomUUID(),
        kind: "file",
        name:
          sanitizeAttachmentName(file?.name ?? path.basename(absolutePath)) ||
          path.basename(absolutePath) ||
          "attachment",
        mime_type: resolveStagedAttachmentMimeType({
          name: path.basename(absolutePath),
          declaredMimeType: file?.mime_type,
          bytes: signature,
        }),
        size_bytes: stat.size,
        workspace_path: inWorkspacePath,
      });
      continue;
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

    attachments.push(
      await stageMaterializedAttachment({
        workspaceDir,
        relativeRoot,
        usedNames,
        sourceName: file?.name ?? path.basename(absolutePath),
        declaredMimeType: file?.mime_type,
        sourcePath: absolutePath,
      }),
    );
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
    active_user_question:
      record.active_user_question && typeof record.active_user_question === "object"
        ? (record.active_user_question as Record<string, unknown>)
        : null,
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

// Mirrors the runtime's syntheticRootWorkspace() (state-store) as a payload.
function syntheticRootWorkspaceRecord(): WorkspaceRecordPayload {
  return {
    id: ROOT_WORKSPACE_ID,
    location: localWorkspaceLocation(),
    name: "Workspace",
    status: "active",
    harness: null,
    error_message: null,
    onboarding_status: "not_required",
    onboarding_state: null,
    onboarding_session_id: null,
    onboarding_completed_at: null,
    onboarding_completion_summary: null,
    onboarding_requested_at: null,
    onboarding_requested_by: null,
    created_at: "1970-01-01T00:00:00.000Z",
    updated_at: "1970-01-01T00:00:00.000Z",
    deleted_at_utc: null,
    workspace_path: null,
    folder_state: "healthy",
    workspace_role: "source",
  };
}

// Guarantee one selectable workspace (the single-tenant root) when both the
// local-runtime and cloud sources come back empty.
function ensureRootWorkspaceFallback(
  response: WorkspaceListResponsePayload,
): WorkspaceListResponsePayload {
  if (response.items.length > 0) {
    return response;
  }
  const items = [syntheticRootWorkspaceRecord()];
  return {
    items,
    total: items.length,
    limit: Math.max(response.limit, 100),
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
  // The single-tenant synthetic root is always local — short-circuit before the
  // cloud-probe path so it never fetches a cloud lifecycle for "root" (404).
  if (safeWorkspaceId === ROOT_WORKSPACE_ID) {
    return localWorkspaceLocation();
  }
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
    // Runtime-unreachable resolves to root, not the stale former-workspace cache.
    listLocalWorkspaces().catch(() => emptyWorkspaceListResponse()),
    listCloudWorkspaces().catch(() => emptyWorkspaceListResponse()),
  ]);
  return ensureRootWorkspaceFallback(
    mergeWorkspaceListResponses(localResponse, cloudResponse),
  );
}

async function listCachedWorkspaces(): Promise<WorkspaceListResponsePayload> {
  const [localResponse, cloudResponse] = await Promise.all([
    Promise.resolve(listWorkspacesFromLocalDb()),
    listCachedCloudWorkspaces(),
  ]);
  return ensureRootWorkspaceFallback(
    mergeWorkspaceListResponses(localResponse, cloudResponse),
  );
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
  // Hide app-internal files (source, lockfiles, build output under apps/<id>/)
  // and workspace-managed scaffolding — these are never user-facing outputs.
  return (
    fileName === "agents.md" ||
    segments[0] === "apps" ||
    segments.includes("skills")
  );
}

async function listWorkspaceActivity(payload: {
  workspaceId: string;
  date: string;
}): Promise<WorkspaceActivityResponsePayload> {
  const response =
    await requestWorkspaceRuntimeJson<WorkspaceActivityResponsePayload>(
      payload.workspaceId,
      {
        method: "GET",
        path: `/api/v1/workspaces/${encodeURIComponent(payload.workspaceId)}/activity`,
        params: { date: payload.date },
      },
    );
  return {
    ...response,
    outputs: response.outputs.filter(
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

async function searchOutputs(
  payload: WorkspaceOutputSearchRequestPayload,
): Promise<WorkspaceOutputSearchResponsePayload> {
  const filters = payload.filters ?? {};
  const body: Record<string, unknown> = {
    query: payload.query,
    limit: payload.limit ?? 20,
    offset: payload.offset ?? 0,
  };
  const apiFilters: Record<string, unknown> = {};
  if (filters.producerId) {
    apiFilters.producer_id = filters.producerId;
  }
  if (filters.dateRange?.start || filters.dateRange?.end) {
    apiFilters.date_range = {
      start: filters.dateRange.start ?? undefined,
      end: filters.dateRange.end ?? undefined,
    };
  }
  if (Object.keys(apiFilters).length > 0) {
    body.filters = apiFilters;
  }
  const response =
    await requestWorkspaceRuntimeJson<WorkspaceOutputSearchResponsePayload>(
      payload.workspaceId,
      {
        method: "POST",
        path: `/api/v1/workspaces/${encodeURIComponent(payload.workspaceId)}/outputs/search`,
        payload: body,
      },
    );
  return response;
}

async function createOutput(
  payload: WorkspaceOutputCreatePayload,
): Promise<WorkspaceOutputCreateResponsePayload> {
  return requestWorkspaceRuntimeJson<WorkspaceOutputCreateResponsePayload>(
    payload.workspaceId,
    {
      method: "POST",
      path: "/api/v1/outputs",
      payload: {
        workspace_id: payload.workspaceId,
        output_type: payload.outputType,
        title: payload.title ?? "",
        file_path: payload.filePath ?? null,
        status: payload.status ?? "draft",
        session_id: payload.sessionId ?? null,
        input_id: payload.inputId ?? null,
        metadata: payload.metadata ?? {},
      },
    },
  );
}

async function updateOutput(payload: {
  workspaceId: string;
  outputId: string;
  title?: string | null;
  status?: string | null;
  folderId?: string | null;
  filePath?: string | null;
}): Promise<WorkspaceOutputCreateResponsePayload> {
  const body: Record<string, unknown> = { workspace_id: payload.workspaceId };
  if (payload.title !== undefined) {
    body.title = payload.title;
  }
  if (payload.status !== undefined) {
    body.status = payload.status;
  }
  if (payload.folderId !== undefined) {
    body.folder_id = payload.folderId;
  }
  if (payload.filePath !== undefined) {
    body.file_path = payload.filePath;
  }
  return requestWorkspaceRuntimeJson<WorkspaceOutputCreateResponsePayload>(
    payload.workspaceId,
    {
      method: "PATCH",
      path: `/api/v1/outputs/${encodeURIComponent(payload.outputId)}`,
      payload: body,
    },
  );
}

async function deleteOutput(payload: {
  workspaceId: string;
  outputId: string;
}): Promise<{ deleted: boolean }> {
  return requestWorkspaceRuntimeJson<{ deleted: boolean }>(
    payload.workspaceId,
    {
      method: "DELETE",
      path: `/api/v1/outputs/${encodeURIComponent(payload.outputId)}`,
      params: { workspace_id: payload.workspaceId },
    },
  );
}

const ARTIFACT_TEMPLATE_SCHEMA_VERSION = 1;

function artifactTemplatesRoot(): string {
  return path.join(app.getPath("userData"), "artifact-templates");
}

function slugifyArtifactTemplate(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "artifact";
}

async function listArtifactTemplates(): Promise<{
  templates: ArtifactTemplateRecordPayload[];
}> {
  const root = artifactTemplatesRoot();
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return { templates: [] };
  }
  const templates: ArtifactTemplateRecordPayload[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await fs.readFile(
        path.join(root, entry.name, "template.json"),
        "utf-8",
      );
      const meta = JSON.parse(raw) as Partial<ArtifactTemplateRecordPayload>;
      if (!meta?.id || !meta?.name) continue;
      templates.push({
        id: meta.id,
        name: meta.name,
        description: meta.description ?? null,
        category: meta.category ?? null,
        ext: meta.ext ?? "",
        outputType: meta.outputType ?? "document",
        fileName: meta.fileName ?? "",
        createdAt: meta.createdAt ?? "",
      });
    } catch {
      // skip malformed template dirs
    }
  }
  templates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { templates };
}

const ARTIFACT_TEMPLATE_PREVIEW_IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".avif",
]);
const ARTIFACT_TEMPLATE_PREVIEW_TEXT_EXTS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".html",
  ".htm",
  ".csv",
  ".tsv",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
  ".css",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
]);

async function readArtifactTemplatePreview(payload: {
  templateId: string;
}): Promise<ArtifactTemplatePreviewPayload> {
  const templateId = (payload.templateId ?? "").trim();
  if (
    !templateId ||
    templateId.includes("/") ||
    templateId.includes("\\") ||
    templateId.includes("..")
  ) {
    return { kind: "none" };
  }
  const dir = path.join(artifactTemplatesRoot(), templateId);
  let meta: (ArtifactTemplateRecordPayload & { contentFileName?: string }) | null =
    null;
  try {
    meta = JSON.parse(
      await fs.readFile(path.join(dir, "template.json"), "utf-8"),
    );
  } catch {
    return { kind: "none" };
  }
  const ext = (meta?.ext ?? "").toLowerCase();
  const contentFileName = meta?.contentFileName || `content${ext}`;
  const contentPath = path.join(dir, contentFileName);
  if (!existsSync(contentPath)) return { kind: "none" };
  try {
    if (ARTIFACT_TEMPLATE_PREVIEW_IMAGE_EXTS.has(ext)) {
      const buf = await fs.readFile(contentPath);
      if (buf.length > 2_000_000) return { kind: "none" };
      const mime =
        ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".svg"
            ? "image/svg+xml"
            : `image/${ext.slice(1)}`;
      return { kind: "image", dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
    }
    if (ARTIFACT_TEMPLATE_PREVIEW_TEXT_EXTS.has(ext) || ext === "") {
      const raw = await fs.readFile(contentPath, "utf-8");
      return { kind: "text", text: raw.slice(0, 1200) };
    }
  } catch {
    return { kind: "none" };
  }
  return { kind: "none" };
}

async function saveOutputAsArtifactTemplate(
  payload: SaveOutputAsArtifactTemplatePayload,
): Promise<ArtifactTemplateRecordPayload> {
  const workspaceId = (payload.workspaceId ?? "").trim();
  const sourceRelPath = (payload.filePath ?? "").trim();
  const name = (payload.name ?? "").trim();
  if (!workspaceId) throw new Error("workspaceId is required");
  if (!sourceRelPath) throw new Error("template source file is required");
  if (!name) throw new Error("template name is required");

  const { absolutePath } = await resolveWorkspaceScopedExplorerPath(
    sourceRelPath,
    workspaceId,
  );
  if (!existsSync(absolutePath)) {
    throw new Error(`source artifact file not found: ${sourceRelPath}`);
  }

  const ext = path.extname(absolutePath);
  const root = artifactTemplatesRoot();
  await fs.mkdir(root, { recursive: true });
  const templateId = `${slugifyArtifactTemplate(name)}-${Date.now().toString(36)}`;
  const templateDir = path.join(root, templateId);
  await fs.mkdir(templateDir, { recursive: true });
  const contentFileName = `content${ext}`;
  await fs.copyFile(absolutePath, path.join(templateDir, contentFileName));

  const record: ArtifactTemplateRecordPayload = {
    id: templateId,
    name,
    description: (payload.description ?? "").trim() || null,
    category: (payload.category ?? "").trim() || null,
    ext,
    outputType: (payload.outputType ?? "").trim() || "document",
    fileName: path.basename(absolutePath),
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(templateDir, "template.json"),
    `${JSON.stringify(
      { ...record, contentFileName, schemaVersion: ARTIFACT_TEMPLATE_SCHEMA_VERSION },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  return record;
}

// Where a session's deliverables live on disk. Project-bound sessions write
// under the project's own directory (outside the workspace root); everything
// else uses the workspace root. Mirrors the runtime's sessionOutputRoot so a
// file written here is found by resolveOutputAbsolutePath later.
async function resolveSessionDeliveryRoot(
  workspaceId: string,
  sessionId: string | null | undefined,
  workspaceRoot: string,
): Promise<string> {
  const normalizedSessionId =
    typeof sessionId === "string" ? sessionId.trim() : "";
  if (!normalizedSessionId) {
    return workspaceRoot;
  }
  try {
    const session = cachedAgentSessionRecords(workspaceId).find(
      (record) => record.session_id === normalizedSessionId,
    );
    const projectId =
      typeof session?.project_id === "string" ? session.project_id.trim() : "";
    if (!projectId) {
      return workspaceRoot;
    }
    const projects = await listWorkspaceProjects(workspaceId);
    const project = projects.items?.find(
      (entry) => entry.project_id === projectId,
    );
    const projectPath =
      typeof project?.project_path === "string"
        ? project.project_path.trim()
        : "";
    if (projectPath) {
      return path.resolve(projectPath);
    }
  } catch {
    // Fall back to the workspace root if the session/project can't be resolved.
  }
  return workspaceRoot;
}

async function createOutputFromArtifactTemplate(payload: {
  workspaceId: string;
  templateId: string;
  sessionId?: string | null;
  name?: string | null;
}): Promise<WorkspaceOutputCreateResponsePayload> {
  const workspaceId = (payload.workspaceId ?? "").trim();
  const templateId = (payload.templateId ?? "").trim();
  if (!workspaceId) throw new Error("workspaceId is required");
  if (!templateId) throw new Error("templateId is required");

  const templateDir = path.join(artifactTemplatesRoot(), templateId);
  const meta = JSON.parse(
    await fs.readFile(path.join(templateDir, "template.json"), "utf-8"),
  ) as ArtifactTemplateRecordPayload & { contentFileName?: string };
  const contentFileName = meta.contentFileName || `content${meta.ext ?? ""}`;
  const sourceContentPath = path.join(templateDir, contentFileName);
  if (!existsSync(sourceContentPath)) {
    throw new Error(`template content missing for ${templateId}`);
  }

  const workspaceRoot = await resolveLocalWorkspaceRoot(workspaceId);
  const deliveryRoot = await resolveSessionDeliveryRoot(
    workspaceId,
    payload.sessionId,
    workspaceRoot,
  );
  const ext = meta.ext ?? "";
  // Prefer a user-supplied name; strip a redundant trailing copy of the
  // template extension so "report.md" + .md doesn't become report-md.md.
  const requestedName = (payload.name ?? "").trim();
  let nameForFile = requestedName;
  if (ext && nameForFile.toLowerCase().endsWith(ext.toLowerCase())) {
    nameForFile = nameForFile.slice(0, -ext.length);
  }
  const baseName =
    slugifyArtifactTemplate(nameForFile) || slugifyArtifactTemplate(meta.name);
  let relName = `${baseName}${ext}`;
  let counter = 1;
  while (existsSync(path.join(deliveryRoot, relName))) {
    relName = `${baseName}-${counter}${ext}`;
    counter += 1;
  }
  await fs.copyFile(sourceContentPath, path.join(deliveryRoot, relName));

  return createOutput({
    workspaceId,
    outputType: meta.outputType || "document",
    title: requestedName || meta.name,
    filePath: relName,
    status: "draft",
    sessionId: payload.sessionId ?? null,
    metadata: { origin_type: "template", template_id: templateId },
  });
}

async function deleteArtifactTemplate(payload: {
  templateId: string;
}): Promise<{ deleted: boolean }> {
  const templateId = (payload.templateId ?? "").trim();
  if (
    !templateId ||
    templateId.includes("/") ||
    templateId.includes("\\") ||
    templateId.includes("..")
  ) {
    throw new Error("invalid templateId");
  }
  const templateDir = path.join(artifactTemplatesRoot(), templateId);
  if (!existsSync(templateDir)) return { deleted: false };
  await fs.rm(templateDir, { recursive: true, force: true });
  return { deleted: true };
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

  let frontmatterTitle = "";
  const frontmatterMatch = normalized.match(/^---\n([\s\S]*?)\n---\s*/);
  if (frontmatterMatch) {
    const titleMatch = frontmatterMatch[1].match(/^title:\s*(.+)$/m);
    if (titleMatch) {
      frontmatterTitle = sanitizeYamlScalar(titleMatch[1]);
    }
    const descriptionMatch = frontmatterMatch[1].match(
      /^description:\s*(.+)$/m,
    );
    if (descriptionMatch) {
      summary = sanitizeYamlScalar(descriptionMatch[1]);
    }
    remaining = normalized.slice(frontmatterMatch[0].length).trim();
  }

  const headingMatch = remaining.match(/^#\s+(.+)$/m);
  const title =
    frontmatterTitle ||
    headingMatch?.[1]?.trim() ||
    humanizeSkillId(skillId) ||
    skillId;

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

  // Seed the bundled defaults before listing, so the Installed view reflects
  // them regardless of how the workspace dir resolved (idempotent — the marker
  // makes repeat calls a cheap no-op).
  await ensureDefaultWorkspaceSkills(workspaceRoot);

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

async function deleteWorkspaceSkill(payload: {
  workspaceId: string;
  skillId: string;
}): Promise<{ deleted: boolean }> {
  const skillId = normalizeWorkspaceSkillId(payload.skillId);
  if (!skillId) {
    throw new Error("Invalid skill id");
  }
  const workspaceRoot = await resolveWorkspaceDir(payload.workspaceId);
  const skillsPath = path.resolve(workspaceRoot, "skills");
  const skillDir = path.resolve(skillsPath, skillId);
  if (path.dirname(skillDir) !== skillsPath) {
    throw new Error("Invalid skill path");
  }
  try {
    await fs.rm(skillDir, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { deleted: false };
    }
    throw error;
  }
  return { deleted: true };
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

// Per-workspace request coalescing + short result cache for
// `listRuntimeStates`. There are 10+ React polling sites in the
// renderer (WorkspaceControlCenter, ChatPane, IssueDetailPane,
// OperationsDrawer, AutomationsPane, …) each running its own
// setInterval at 750–2500ms against the same endpoint. Without
// coalescing, observed HTTP traffic was ~1.27 runtime-states
// requests/second per active workspace × 3 workspaces ≈ 3.8/s
// sustained, ~175k hits / 12.8h logged.
//
// In-flight coalesce: while one request is pending, any concurrent
// caller for the same workspace shares the same Promise.
// Short cache: after resolution, hold the value for
// `LIST_RUNTIME_STATES_CACHE_WINDOW_MS` so back-to-back polls within
// the window collapse to one HTTP call. The window is short enough
// (500ms) that UI freshness for "is the agent responding?" stays
// imperceptible; the per-renderer poll intervals (≥750ms) are
// upper-bounded by their own setInterval cadence, not by this cache.
const LIST_RUNTIME_STATES_CACHE_WINDOW_MS = 500;
type ListRuntimeStatesPending = {
  promise: Promise<SessionRuntimeStateListResponsePayload>;
  /** When set, the promise has settled and the cached value remains
   *  valid until this wall-clock millisecond. Until then, in-flight. */
  settledUntil: number | null;
};
const listRuntimeStatesPending = new Map<string, ListRuntimeStatesPending>();

async function listRuntimeStates(
  workspaceId: string,
): Promise<SessionRuntimeStateListResponsePayload> {
  const now = Date.now();
  const existing = listRuntimeStatesPending.get(workspaceId);
  if (existing) {
    if (existing.settledUntil === null) return existing.promise;
    if (existing.settledUntil > now) return existing.promise;
  }
  const promise = (async () => {
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
            // Short per-call timeout: this endpoint feeds a poller that
            // fires every ~1–2s. Letting it sit on the default 15s ×
            // 3 retries while the runtime is stuck makes every poll
            // tick a 45s zombie. Fail fast so the next tick gets a
            // fresh attempt instead of stacking behind a corpse.
            timeoutMs: 5000,
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
        // Transient connectivity (runtime restart, stuck event loop,
        // OS-level connect timeout). Degrade gracefully — return the
        // last known good cache if we have one, otherwise an empty
        // list. Either way, swallow the error so the IPC layer
        // doesn't log a stack on every tick (with the bare "?" /
        // listRuntimeStates polling cadence, a stuck runtime used to
        // pump ~12 stack traces / second through the dev console).
        const cached = cachedRuntimeStateRecords(workspaceId);
        return { items: cached, count: cached.length };
      }
      throw error;
    }
  })();
  const entry: ListRuntimeStatesPending = { promise, settledUntil: null };
  listRuntimeStatesPending.set(workspaceId, entry);
  // After settlement, freeze the entry as a cached value for the
  // coalesce window so concurrent late callers within the window
  // share it; expire it after that. We only clear the slot if the
  // entry is still the latest (a refresh might have replaced it).
  promise.then(
    () => {
      entry.settledUntil = Date.now() + LIST_RUNTIME_STATES_CACHE_WINDOW_MS;
      setTimeout(() => {
        if (listRuntimeStatesPending.get(workspaceId) === entry) {
          listRuntimeStatesPending.delete(workspaceId);
        }
      }, LIST_RUNTIME_STATES_CACHE_WINDOW_MS + 50);
    },
    () => {
      // Failed requests must not be cached — let the next caller
      // re-issue immediately.
      if (listRuntimeStatesPending.get(workspaceId) === entry) {
        listRuntimeStatesPending.delete(workspaceId);
      }
    },
  );
  return promise;
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
  opts?: { create?: boolean },
): Promise<EnsureWorkspaceMainSessionResponsePayload> {
  // create:false resolves the existing main session without creating a
  // placeholder (the renderer opens a lazy draft instead when null).
  const query = opts?.create === false ? "?create=false" : "";
  const response =
    await requestWorkspaceRuntimeJson<EnsureWorkspaceMainSessionResponsePayload>(
      workspaceId,
      {
        method: "POST",
        path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/ensure-main-session${query}`,
        retryTransientErrors: true,
      },
    );
  if (response.session) {
    upsertCachedAgentSessionRecord(response.session);
  }
  return response;
}

async function listWorkspaceMainSessions(
  workspaceId: string,
  appId?: string | null,
): Promise<ListMainSessionsResponsePayload> {
  // `appId` scopes the list to a HolaApp's own sessions (the app dropdown).
  // Absent it, the runtime returns the sidebar list, which excludes app
  // sessions.
  const scopedAppId = appId?.trim();
  const query = scopedAppId
    ? `?app_id=${encodeURIComponent(scopedAppId)}`
    : "";
  const response =
    await requestWorkspaceRuntimeJson<ListMainSessionsResponsePayload>(
      workspaceId,
      {
        method: "GET",
        path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/main-sessions${query}`,
        retryTransientErrors: true,
      },
    );
  for (const session of response.sessions ?? []) {
    upsertCachedAgentSessionRecord(session);
  }
  return response;
}

async function createWorkspaceMainSession(
  workspaceId: string,
  payload: CreateMainSessionPayload,
): Promise<CreateMainSessionResponsePayload> {
  const response =
    await requestWorkspaceRuntimeJson<CreateMainSessionResponsePayload>(
      workspaceId,
      {
        method: "POST",
        path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/main-sessions`,
        payload: payload ?? {},
        retryTransientErrors: true,
      },
    );
  if (response.session) {
    upsertCachedAgentSessionRecord(response.session);
  }
  return response;
}

async function listWorkspaceProjects(
  workspaceId: string,
): Promise<ListWorkspaceProjectsResponsePayload> {
  return requestWorkspaceRuntimeJson<ListWorkspaceProjectsResponsePayload>(
    workspaceId,
    {
      method: "GET",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/projects`,
      retryTransientErrors: true,
    },
  );
}

interface WorkspaceConfigYamlPayload {
  path: string;
  exists: boolean;
  content: string;
}

async function getWorkspaceConfigYaml(
  workspaceId: string,
): Promise<WorkspaceConfigYamlPayload> {
  return requestWorkspaceRuntimeJson<WorkspaceConfigYamlPayload>(workspaceId, {
    method: "GET",
    path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/config-yaml`,
    retryTransientErrors: true,
  });
}

interface WorkspaceMcpServerEntryPayload {
  id: string;
  transport: "remote" | "local";
  enabled: boolean;
  url?: string;
  command?: string[];
  appManaged: boolean;
  /** The app container that owns this server, when app-managed. Used to group
   *  app-owned servers under their app and keep the standalone pool separate. */
  ownerAppId?: string;
}

interface WorkspaceMcpServersPayload {
  servers: WorkspaceMcpServerEntryPayload[];
}

async function listWorkspaceMcpServers(
  workspaceId: string,
): Promise<WorkspaceMcpServersPayload> {
  return requestWorkspaceRuntimeJson<WorkspaceMcpServersPayload>(workspaceId, {
    method: "GET",
    path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/mcp-servers`,
    retryTransientErrors: true,
  });
}

async function deleteWorkspaceMcpServer(
  workspaceId: string,
  serverId: string,
): Promise<DeleteWorkspaceMcpServerResponsePayload> {
  return requestWorkspaceRuntimeJson<DeleteWorkspaceMcpServerResponsePayload>(
    workspaceId,
    {
      method: "DELETE",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/mcp-servers/${encodeURIComponent(serverId)}`,
    },
  );
}

// Invalidate the workspace's cached MCP tool discovery (same capability the
// agent's `mcp_refresh` tool uses) so every connected server is re-discovered
// on the next run.
async function refreshWorkspaceMcpTools(
  workspaceId: string,
): Promise<{ refreshed: boolean; servers?: string[] }> {
  return requestWorkspaceRuntimeJson<{ refreshed: boolean; servers?: string[] }>(
    workspaceId,
    {
      method: "POST",
      path: "/api/v1/capabilities/runtime-tools/mcp/refresh",
      payload: { workspace_id: workspaceId },
      retryTransientErrors: true,
    },
  );
}

interface AuthorizeWorkspaceMcpServerResponsePayload {
  ok: boolean;
  server_id: string;
  tool_count: number;
  detail: string;
  requires_session_refresh?: boolean;
}

// Run the interactive OAuth authorization for a remote MCP server. The runtime
// opens the system browser and blocks on the user's consent, so this HTTP call
// is long-lived (no retry — replaying would relaunch the browser). On success
// the server's tools become available on the next turn.
async function authorizeWorkspaceMcpServer(
  workspaceId: string,
  serverId: string,
  reauthorize = false,
): Promise<AuthorizeWorkspaceMcpServerResponsePayload> {
  return requestWorkspaceRuntimeJson<AuthorizeWorkspaceMcpServerResponsePayload>(
    workspaceId,
    {
      method: "POST",
      path: "/api/v1/capabilities/runtime-tools/mcp/authorize",
      payload: {
        workspace_id: workspaceId,
        server_id: serverId,
        reauthorize,
      },
      // Generous ceiling: the runtime waits up to ~3 min for browser consent.
      timeoutMs: 210_000,
    },
  );
}

// Cheap check: does a remote MCP server already hold a valid OAuth token? Lets
// the inline Authorize card show "Authorized" instead of a stale live button.
async function mcpServerAuthorized(
  workspaceId: string,
  serverId: string,
): Promise<{ authorized: boolean; registered?: boolean; server_id?: string }> {
  return requestWorkspaceRuntimeJson<{
    authorized: boolean;
    registered?: boolean;
    server_id?: string;
  }>(workspaceId, {
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/mcp/authorized",
    payload: { workspace_id: workspaceId, server_id: serverId },
    retryTransientErrors: true,
  });
}

interface HarnessSupportedModelEntry {
  id: string;
  label: string;
  provider: string;
  default?: boolean;
}

interface HarnessAvailabilityEntry {
  id: string;
  display_name: string;
  capabilities: {
    requiresBackend: boolean;
    supportsStructuredOutput: boolean;
    supportsWaitingUser: boolean;
    supportsSkills: boolean;
    supportsMcpTools: boolean;
  };
  available: boolean;
  detection: string;
  supported_models: HarnessSupportedModelEntry[];
}

interface ListHarnessAvailabilityResponsePayload {
  harnesses: HarnessAvailabilityEntry[];
}

interface HarnessConnectionTestResultPayload {
  ok: boolean;
  detail: string;
  duration_ms: number;
}

/**
 * Fetches the runtime's harness inventory. The runtime probes PATH for
 * each CLI harness's binary and caches the result for 60s; we just
 * forward the response so the renderer's picker can show available vs
 * not-installed states alongside detection hints.
 */
async function listHarnessAvailability(
  workspaceId: string,
): Promise<ListHarnessAvailabilityResponsePayload> {
  const response = await requestWorkspaceRuntimeJson<{
    harnesses?: HarnessAvailabilityEntry[];
  }>(workspaceId, {
    method: "GET",
    path: "/api/v1/runtime/status",
    retryTransientErrors: true,
  });
  return { harnesses: response.harnesses ?? [] };
}

async function testHarnessConnection(
  workspaceId: string,
  harnessId: string,
): Promise<HarnessConnectionTestResultPayload> {
  // The runtime runs the harness with a tiny prompt end-to-end; allow it ample
  // time (cold CLI start + auth + model latency) before the HTTP layer gives up.
  const response = await requestWorkspaceRuntimeJson<HarnessConnectionTestResultPayload>(
    workspaceId,
    {
      method: "POST",
      path: `/api/v1/runtime/harnesses/${encodeURIComponent(harnessId)}/test-connection`,
      timeoutMs: 70_000,
    },
  );
  return {
    ok: Boolean(response.ok),
    detail: typeof response.detail === "string" ? response.detail : "",
    duration_ms: typeof response.duration_ms === "number" ? response.duration_ms : 0,
  };
}

interface UpdateSessionHarnessResponsePayload {
  session: AgentSessionRecordPayload;
}

/**
 * Re-binds an empty session to a different harness. The runtime rejects
 * with HTTP 409 if the session has any queued inputs — that's the
 * "harness is immutable mid-session" guarantee. Used by the empty-
 * composer harness picker so a user can change their mind between
 * clicking "+ New chat" and sending the first message.
 */
async function updateWorkspaceSessionHarness(
  workspaceId: string,
  sessionId: string,
  harnessId: string,
): Promise<UpdateSessionHarnessResponsePayload> {
  const response =
    await requestWorkspaceRuntimeJson<UpdateSessionHarnessResponsePayload>(
      workspaceId,
      {
        method: "PATCH",
        path: `/api/v1/agent-sessions/${encodeURIComponent(sessionId)}/harness`,
        payload: { workspace_id: workspaceId, harness_id: harnessId },
        retryTransientErrors: true,
      },
    );
  if (response.session) {
    upsertCachedAgentSessionRecord(response.session);
  }
  return response;
}

async function createWorkspaceProject(
  workspaceId: string,
  payload: CreateWorkspaceProjectPayload,
): Promise<CreateWorkspaceProjectResponsePayload> {
  return requestWorkspaceRuntimeJson<CreateWorkspaceProjectResponsePayload>(
    workspaceId,
    {
      method: "POST",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/projects`,
      payload,
      retryTransientErrors: true,
    },
  );
}

async function updateWorkspaceProject(
  workspaceId: string,
  projectId: string,
  payload: UpdateWorkspaceProjectPayload,
): Promise<UpdateWorkspaceProjectResponsePayload> {
  return requestWorkspaceRuntimeJson<UpdateWorkspaceProjectResponsePayload>(
    workspaceId,
    {
      method: "PATCH",
      path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}`,
      payload,
      retryTransientErrors: true,
    },
  );
}

async function deleteWorkspaceProject(
  workspaceId: string,
  projectId: string,
): Promise<{ ok: true }> {
  return requestWorkspaceRuntimeJson<{ ok: true }>(workspaceId, {
    method: "DELETE",
    path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}`,
    retryTransientErrors: true,
  });
}

async function activateWorkspaceMainSession(
  workspaceId: string,
  sessionId: string,
): Promise<ActivateMainSessionResponsePayload> {
  const response =
    await requestWorkspaceRuntimeJson<ActivateMainSessionResponsePayload>(
      workspaceId,
      {
        method: "POST",
        path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/main-sessions/${encodeURIComponent(sessionId)}/activate`,
        retryTransientErrors: true,
      },
    );
  if (response.session) {
    upsertCachedAgentSessionRecord(response.session);
  }
  return response;
}

async function updateWorkspaceMainSession(
  workspaceId: string,
  sessionId: string,
  payload: UpdateMainSessionPayload,
): Promise<UpdateMainSessionResponsePayload> {
  const response =
    await requestWorkspaceRuntimeJson<UpdateMainSessionResponsePayload>(
      workspaceId,
      {
        method: "PATCH",
        path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/main-sessions/${encodeURIComponent(sessionId)}`,
        payload,
        retryTransientErrors: true,
      },
    );
  if (response.session) {
    upsertCachedAgentSessionRecord(response.session);
  }
  return response;
}

async function deleteWorkspaceMainSession(
  workspaceId: string,
  sessionId: string,
): Promise<{ ok: true }> {
  return requestWorkspaceRuntimeJson<{ ok: true }>(workspaceId, {
    method: "DELETE",
    path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/main-sessions/${encodeURIComponent(sessionId)}`,
    retryTransientErrors: true,
  });
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
          first_user_text: payload.first_user_text ?? undefined,
          parent_session_id: payload.parent_session_id ?? undefined,
          project_id: payload.project_id ?? undefined,
          created_by: payload.created_by ?? undefined,
          app_id: payload.app_id ?? undefined,
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
      timeoutMs: 30_000,
    },
  );
}

async function listTurnResults(
  payload: SessionTurnResultListRequestPayload,
): Promise<SessionTurnResultListResponsePayload> {
  return requestWorkspaceRuntimeJson<SessionTurnResultListResponsePayload>(
    payload.workspaceId,
    {
      method: "GET",
      path: `/api/v1/workspaces/${encodeURIComponent(payload.workspaceId)}/turn-results`,
      params: {
        session_id: payload.sessionId ?? undefined,
        input_id: payload.inputId ?? undefined,
        status: payload.status ?? undefined,
        limit: payload.limit ?? 500,
        offset: payload.offset ?? 0,
        order: payload.order ?? "desc",
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
  // Re-attach the workspace's web-HolaApp MCP servers before queuing the turn,
  // so the agent always has the tools regardless of whether the surface was
  // opened first. The runtime recompiles the plan from workspace.yaml per run,
  // so a refresh here takes effect on this very turn. Best-effort — never block
  // the chat on attach.
  await ensureWebHolaAppMcpAttached(payload.workspace_id);
  // Same for marketplace MCP servers — refreshes the session bearer for hosted servers so
  // the tools stay live regardless of when the server was installed.
  await ensureMarketplaceMcpAttached(payload.workspace_id);
  // …and app-owned hosted MCPs (a HolaApp's hostedMcpInstall, e.g. jianguoyun) —
  // same bearer refresh, from a set reconciled against installed apps.
  await ensureHostedAppMcpsAttached(payload.workspace_id);
  // …and system MCPs (HolaHub's agent MCP is global — always attached) so any
  // session, incl. an "Assisted by Hola" hand-off, can contribute items + post threads.
  await ensureSystemMcpAttached(payload.workspace_id);
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
        // Ambient open-app context for the agent only — the runtime folds it
        // into the turn instruction but never persists it as the user message.
        app_context_text: payload.app_context_text ?? null,
        image_urls: payload.image_urls,
        attachments: payload.attachments ?? null,
        session_id: payload.session_id,
        idempotency_key: idempotencyKey,
        priority: payload.priority ?? 0,
        model: payload.model,
        thinking_value: payload.thinking_value ?? null,
        // Stamps owning_app_id when this lazily creates a fresh app session
        // (ignored on an existing session — owning_app_id is immutable).
        app_id: payload.app_id ?? null,
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

async function answerSessionUserQuestion(
  payload: HolabossAnswerUserQuestionPayload,
): Promise<AnswerUserQuestionResponsePayload> {
  const response =
    await requestWorkspaceRuntimeJson<AnswerUserQuestionResponsePayload>(
      payload.workspace_id,
      {
        method: "POST",
        path: "/api/v1/capabilities/runtime-tools/ask-user-question/answer",
        payload: {
          workspace_id: payload.workspace_id,
          session_id: payload.session_id,
          answers: payload.answers,
          model: payload.model ?? undefined,
          thinking_value: payload.thinking_value ?? undefined,
        },
      },
    );
  // Answering enqueues the reply and wakes the worker runtime-side; reflect
  // the QUEUED state locally so the composer flips to "working" before the
  // first stream event lands.
  upsertCachedRuntimeStateRecord({
    workspace_id: payload.workspace_id,
    session_id: response.session_id || payload.session_id,
    status: "QUEUED",
    effective_state: "QUEUED",
    runtime_status: "QUEUED",
    has_queued_inputs: true,
    current_input_id: response.input_id ?? null,
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

// ── HolaEmployee desktop chat ────────────────────────────────────────────────
// Chat with a SERVER-SIDE HolaEmployee (the same employee reachable in Slack/Feishu)
// from the desktop, over the authed backend gateway (/gateway/wapp/holaemployee/*).
// The turn runs + streams server-side; the gateway resolves the caller's active org
// from the session cookie. Conversations are keyed `desktop:<userId>:<threadId>`
// server-side, so they're private per user and separate from channel threads.
// Additive to the local-runtime General agent — a different agent surface.
const employeeChatStreams = new Map<string, AbortController>();

function emitEmployeeStreamEvent(payload: HolabossSessionStreamEventPayload): void {
  for (const win of BrowserWindow.getAllWindows().filter(
    (w) => !w.isDestroyed(),
  )) {
    try {
      win.webContents.send("holaemployee:chatStream", payload);
    } catch {
      // ignore — window torn down mid-stream
    }
  }
}

// /gateway/wapp/* POSTs must hit the BACKEND/api host (the www SPA edge 405s POST).
function holaEmployeeGatewayBase(): string {
  return (BACKEND_BASE_URL || AUTH_BASE_URL || "").replace(/\/+$/, "");
}

async function holaEmployeeGatewayGet(pathSuffix: string): Promise<unknown> {
  const cookie = authCookieHeader();
  const res = await fetchWithNetworkRetry(
    `${holaEmployeeGatewayBase()}/gateway/wapp/holaemployee${pathSuffix}`,
    { headers: { Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}) } },
  );
  if (!res.ok) {
    throw new Error(`holaemployee ${pathSuffix} HTTP ${res.status}`);
  }
  return res.json();
}

async function listHolaEmployees(): Promise<unknown[]> {
  const body = (await holaEmployeeGatewayGet("/employees")) as {
    employees?: unknown[];
  };
  return body.employees ?? [];
}

async function listHolaEmployeeThreads(employeeId: string): Promise<unknown[]> {
  const body = (await holaEmployeeGatewayGet(
    `/employees/${encodeURIComponent(employeeId)}/threads`,
  )) as { threads?: unknown[] };
  return body.threads ?? [];
}

// The employee's equipped skills / capabilities / integrations (for the chat
// composer's "+" menu). Read-only reflection of the employee's standing config.
async function holaEmployeeEquipment(employeeId: string): Promise<unknown> {
  return holaEmployeeGatewayGet(
    `/employees/${encodeURIComponent(employeeId)}/equipment`,
  );
}

async function holaEmployeeThreadHistory(
  employeeId: string,
  threadId: string,
): Promise<unknown[]> {
  const body = (await holaEmployeeGatewayGet(
    `/employees/${encodeURIComponent(employeeId)}/threads/${encodeURIComponent(threadId)}`,
  )) as { messages?: unknown[] };
  return body.messages ?? [];
}

// POST-SSE: send the message + stream the turn's pi events (turn_event) then a final
// chat_completed. Uses fetch (HTTPS + cookie) → Readable.fromWeb → the shared SSE
// parser → the renderer via `holaemployee:chatStream`.
function openHolaEmployeeChatStream(payload: {
  employeeId: string;
  threadId: string;
  message: string;
  attachments?: { name: string; mimeType: string; contentBase64: string }[];
}): HolabossSessionStreamHandlePayload {
  const streamId = crypto.randomUUID();
  const controller = new AbortController();
  employeeChatStreams.set(streamId, controller);

  void (async () => {
    try {
      const cookie = authCookieHeader();
      const url = `${holaEmployeeGatewayBase()}/gateway/wapp/holaemployee/employees/${encodeURIComponent(payload.employeeId)}/chat/stream`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify({
          threadId: payload.threadId,
          message: payload.message,
          ...(payload.attachments && payload.attachments.length > 0
            ? { attachments: payload.attachments }
            : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        emitEmployeeStreamEvent({
          streamId,
          type: "error",
          error: `HTTP ${res.status}`,
        });
        return;
      }
      const nodeStream = Readable.fromWeb(
        res.body as Parameters<typeof Readable.fromWeb>[0],
      );
      for await (const event of iterSseEvents(nodeStream)) {
        let data: unknown = event.data;
        try {
          data = JSON.parse(event.data);
        } catch {
          data = event.data;
        }
        emitEmployeeStreamEvent({
          streamId,
          type: "event",
          event: { event: event.event, id: event.id, data },
        });
      }
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AbortError") {
        emitEmployeeStreamEvent({
          streamId,
          type: "error",
          error:
            error instanceof Error ? error.message : "Failed to stream chat.",
        });
      }
    } finally {
      employeeChatStreams.delete(streamId);
      emitEmployeeStreamEvent({ streamId, type: "done" });
    }
  })();

  return { streamId };
}

function closeHolaEmployeeChatStream(streamId: string): void {
  const controller = employeeChatStreams.get(streamId);
  if (!controller) {
    return;
  }
  controller.abort();
  employeeChatStreams.delete(streamId);
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
  // Windows packaged builds ship the runtime as a single archive; extract it
  // once (into userData) and prefer that path. Returns null on macOS/Linux, in
  // dev, or for a build that still ships the loose tree — then the existing
  // candidates below take over. See electron/runtime-archive.ts.
  const extractedWindowsRoot = await ensureExtractedWindowsRuntime({
    platform: process.platform,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userDataDir: app.getPath("userData"),
    bundleDirName: RUNTIME_BUNDLE_DIR,
    log: (message) => void appendRuntimeLog(`[runtime-archive] ${message}\n`),
  });
  const candidates = [
    process.env.HOLABOSS_RUNTIME_ROOT,
    extractedWindowsRoot ?? undefined,
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
    /** Called when the runtime moves to a new boot phase, so the splash can say
     *  what it is waiting for instead of showing a bare spinner. */
    onPhase?: (status: RuntimeBootStatus) => void;
  } = {},
) {
  // A fixed attempt count races an operation whose duration we do not control,
  // and the runtime always loses: an integrity check on a large data.db ran ~80s
  // against this 30s budget, so the desktop killed a runtime that was working,
  // and the kill left the marker that started the check again. Forever.
  //
  // So the budget is no longer blind. While the runtime reports a boot phase
  // that is CHANGING, it is making progress and gets more time; a phase that
  // stops moving is the actual "hung" signal, and an unreachable port is the
  // actual "dead" signal. Runtimes without the endpoint fall back to the plain
  // attempt count, unchanged.
  let lastPhase: string | null = null;
  let attemptsSpentOnThisPhase = 0;
  // One warning per phase: a line per poll for 80s buries the log it annotates.
  let overBudgetPhaseLogged = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await isRuntimeHealthy(url)) {
      return true;
    }
    if (options.abortWhen?.()) {
      return false;
    }

    const status = await fetchRuntimeBootStatus(url);
    if (status && !status.ready) {
      if (status.phase !== lastPhase) {
        // Progress: a new phase resets the patience for it, so the total budget
        // scales with how much work there is rather than with a guess.
        lastPhase = status.phase;
        attemptsSpentOnThisPhase = 0;
        overBudgetPhaseLogged = false;
        options.onPhase?.(status);
      } else {
        attemptsSpentOnThisPhase += 1;
      }
      // Mirror the runtime's own alarm into THIS log. The runtime warns in
      // runtime.log, but the desktop log is the one that comes back attached to
      // a bug report, and "the app hung on launch" is exactly the report where
      // knowing which phase overran is the whole diagnosis.
      if (status.phase_over_budget && !overBudgetPhaseLogged) {
        overBudgetPhaseLogged = true;
        console.warn(
          `[runtime] boot phase "${status.phase}" is over budget: ${status.phase_elapsed_ms}ms` +
            (status.phase_budget_ms ? ` (budget ${status.phase_budget_ms}ms)` : "") +
            ` — still advancing, so not treating it as dead`,
        );
      }
      if (attemptsSpentOnThisPhase < STALLED_BOOT_PHASE_ATTEMPTS) {
        // Don't count this against the overall budget — it is working.
        attempt -= 1;
      }
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

/** What the runtime is doing while it starts. `null` = it did not answer. */
interface RuntimeBootStatus {
  ready: boolean;
  phase: string;
  phase_elapsed_ms: number;
  total_elapsed_ms: number;
  /** Budget for the current phase, and whether it has been exceeded. Optional:
   *  a runtime older than the budgets simply omits them, and every reader here
   *  treats absent as "no opinion" rather than as "fine". */
  phase_budget_ms?: number;
  phase_over_budget?: boolean;
}

/**
 * Read /runtime/boot-status. Absent (404) on runtimes older than the endpoint,
 * which is why every caller treats `null` as "no information" and falls back to
 * the plain /healthz probe rather than assuming the worst.
 */
function fetchRuntimeBootStatus(url: string): Promise<RuntimeBootStatus | null> {
  return new Promise((resolve) => {
    const target = new URL("/runtime/boot-status", url);
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        timeout: 1500,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.resume();
          resolve(null);
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(body) as RuntimeBootStatus;
            resolve(
              typeof parsed?.phase === "string" ? parsed : null,
            );
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });
    request.on("error", () => resolve(null));
    request.end();
  });
}

interface DbMaintenanceStatusPayload {
  phase: "idle" | "estimating" | "pruning" | "done";
  heavy: boolean;
  deletedRows: number;
  estimatedRows: number;
  done: boolean;
}

/**
 * Poll the runtime's live retention-sweep progress. Drives the desktop's
 * blocking "Optimizing storage…" boot screen on a heavy first-run cleanup.
 * Fail-open: any error / non-2xx / unparseable body resolves to `null`, which
 * the renderer treats as "not blocking" so a hiccup can never trap the user on
 * the splash.
 */
function fetchDbMaintenanceStatus(): Promise<DbMaintenanceStatusPayload | null> {
  return new Promise((resolve) => {
    const target = new URL("/runtime/db-maintenance-status", runtimeBaseUrl());
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        timeout: 2000,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.resume();
          resolve(null);
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(body) as DbMaintenanceStatusPayload);
          } catch {
            resolve(null);
          }
        });
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });
    request.on("error", () => resolve(null));
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
    stopKeepAwakeBlocker();
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

function browserSpaceId(
  value?: string | null,
  fallback: BrowserSpaceId = activeBrowserSpaceId,
): BrowserSpaceId {
  return browserSpaceIdUtil(value, fallback);
}

function browserSessionId(value?: string | null): string {
  return browserSessionIdUtil(value);
}

// ---------------------------------------------------------------------------
// App surface BrowserView management
// ---------------------------------------------------------------------------

/**
 * Persistent Electron session for third-party HolaApp app-surfaces (Notion, …).
 * Uses the stable `persist:holaboss-browser-root` partition so a login the user
 * did in a surface survives restarts, plus a native (non-Electron) user-agent so
 * sites behave normally. This replaces the retired in-app browser's
 * `ensureBrowserWorkspace().session` — the app-surface never needed the tab
 * engine, only a durable cookie jar. `session.fromPartition` is a per-name
 * singleton, so repeat calls return the same configured session.
 */
function appSurfaceBrowserSession(): Session {
  const surfaceSession = session.fromPartition(
    browserWorkspacePartition(ROOT_WORKSPACE_ID),
  );
  const identity = browserNativeIdentity(surfaceSession);
  surfaceSession.setUserAgent(identity.userAgent, identity.acceptLanguages);
  patchAppSurfaceOAuthCompat(surfaceSession);
  return surfaceSession;
}

// Google (Gaia), Microsoft and Apple refuse OAuth in an embedded main frame
// ("disallowed_useragent" / a dead "Continue"), yet allow the same flow in a real
// popup window — which is why a sign-in that opens via window.open (Typefully) works
// while one that navigates the surface in place (Linear) stalls. These hosts serve
// ONLY auth, so any in-surface navigation to them is an OAuth flow we re-run as a popup.
const OAUTH_POPUP_ONLY_HOSTS = new Set([
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.live.com",
  "appleid.apple.com",
]);

function isOAuthPopupOnlyUrl(rawUrl: string): boolean {
  try {
    return OAUTH_POPUP_ONLY_HOSTS.has(new URL(rawUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function httpOrigin(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

function getOrCreateAppSurfaceView(
  appId: string,
  surfaceSession?: Electron.Session,
): BrowserView {
  const existing = appSurfaceViews.get(appId);
  if (existing) {
    const existingContents = existing.webContents as
      | Electron.WebContents
      | undefined;
    if (existingContents && !existingContents.isDestroyed()) {
      return existing;
    }
    // The cached surface's renderer died (crash) but the entry lingered — drop
    // the corpse and recreate below, else reopening dereferences a dead
    // webContents ("Cannot read properties of undefined (reading 'id')").
    destroyAppSurfaceView(appId);
  }
  const view = new BrowserView({
    webPreferences: {
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "appSurfacePreload.cjs"),
      // Third-party embedded surfaces (Notion, …) load in the workspace's
      // browser partition — the SAME cookie jar as the imported browser profile
      // and the agent's automation browser — so a login the user already has
      // (imported or done in the in-app browser) carries into the surface.
      // First-party Holaboss surfaces pass no session and keep the default
      // session (+ Better-Auth cookie seeding). `session` is immutable after
      // creation, so it must be set here; the view is cached per surface id and
      // the workspace is stable within a run.
      ...(surfaceSession ? { session: surfaceSession } : {}),
    },
  });
  view.setAutoResize({
    width: false,
    height: false,
    horizontal: false,
    vertical: false,
  });
  // Armed when an in-surface navigation to a popup-only OAuth host is redirected to the
  // window.open popup path (see will-navigate below); did-create-window consumes it to
  // bridge that popup back to the surface once auth returns to the app's origin.
  let pendingOAuthBridge: { appOrigin: string; returnUrl: string } | null = null;
  view.webContents.setWindowOpenHandler(({ url, disposition, features, frameName }) => {
    // Genuine popups (e.g. OAuth/login flows) call window.open with a named
    // target and/or window features and surface as disposition "new-window".
    // They rely on a real window.opener so the popup can postMessage the auth
    // result back — opening them externally returns null, which the page reports
    // as a blocked popup. Let these open as a child window sharing the surface
    // session (so cookies flow and the opener relationship is preserved). Plain
    // target=_blank links (anonymous frame, no features) still open externally.
    const isNamedTarget = frameName.length > 0 && frameName !== "_blank";
    const isPopup =
      disposition === "new-window" || features.length > 0 || isNamedTarget;
    if (isPopup) {
      console.log(
        `[app-surface][diag] popup allow url=${url} disp=${disposition} feat=${features} frame=${frameName} surfaceSession=${surfaceSession ? "set" : "none"}`,
      );
      return {
        action: "allow",
        // `overrideBrowserWindowOptions` is the real WindowOpenHandlerResponse
        // field — the former `overrides` key isn't, so it was silently dropped
        // (popup fell back to defaults, incl. the default session).
        overrideBrowserWindowOptions: {
          webPreferences: {
            // Don't expose the host bridge to a third-party auth popup.
            sandbox: false,
            nodeIntegration: false,
            contextIsolation: true,
            // Pin the popup to the SAME session as the surface. Child windows
            // do NOT inherit the opener's session (Electron >=14), so without
            // this the popup lands on the default session — which keeps the raw
            // `Holaboss/… Electron/…` UA. Google's Gaia flags that UA as an
            // embedded client and serves its CookieMismatch ("problem with your
            // cookie settings") page, breaking OAuth sign-in. Sharing the
            // surface session gives the popup the stripped plain-Chrome UA
            // (appSurfaceBrowserSession → setUserAgent) AND one cookie jar, so
            // a completed login carries into the surface. First-party surfaces
            // pass no session and keep the default session, as before.
            ...(surfaceSession ? { session: surfaceSession } : {}),
          },
        },
      };
    }
    openExternalUrlFromMain(url, "app surface window open");
    return { action: "deny" };
  });
  // Configure popups Electron creates for the allowed window.open calls above.
  view.webContents.on("did-create-window", (childWindow) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      childWindow.setParentWindow(mainWindow);
    }
    // If this popup was opened to satisfy an in-surface OAuth navigation we redirected
    // to window.open (see will-navigate), bridge it back: when it returns to the app's
    // own origin (auth done, cookie now in the shared jar), reload the surface at its
    // pre-auth URL — now signed in — and close the popup. Reload the ORIGINAL url, never
    // the popup's callback url (OAuth codes are single-use).
    const oauthBridge = pendingOAuthBridge;
    pendingOAuthBridge = null;
    if (oauthBridge) {
      let bridged = false;
      let settleTimer: ReturnType<typeof setTimeout> | null = null;
      // The popup reaching the app origin does NOT mean login is done: the provider
      // callback (e.g. linear.app/auth/google/callback) exchanges the code CLIENT-SIDE
      // and may SPA-route afterward, so closing the popup the instant it first hits the
      // app origin ABORTS that exchange → the surface reloads still logged-out. Instead
      // wait for the popup to SETTLE on the app origin (no further nav for a beat ⇒ the
      // session cookie is now in the shared jar), THEN reload the surface at its pre-auth
      // URL and close the popup. Timer fires outside the nav event ⇒ close is safe (no
      // SIGSEGV). Reload the ORIGINAL url, never the popup's callback url (codes are
      // single-use). Covers full-nav redirects (did-navigate) and SPA routes
      // (did-navigate-in-page).
      const onAppOrigin = (visitedUrl: string) => {
        if (bridged || httpOrigin(visitedUrl) !== oauthBridge.appOrigin) {
          return;
        }
        if (settleTimer) {
          clearTimeout(settleTimer);
        }
        settleTimer = setTimeout(() => {
          if (bridged) {
            return;
          }
          bridged = true;
          if (!view.webContents.isDestroyed()) {
            void view.webContents.loadURL(oauthBridge.returnUrl);
          }
          if (!childWindow.isDestroyed()) {
            childWindow.close();
          }
        }, 2500);
      };
      childWindow.webContents.on("did-navigate", (_e, u) => onAppOrigin(u));
      childWindow.webContents.on("did-navigate-in-page", (_e, u, isMainFrame) => {
        if (isMainFrame) {
          onAppOrigin(u);
        }
      });
    }
    try {
      const cw = childWindow.webContents;
      console.log(
        `[app-surface][diag] popup created onSurfaceSession=${cw.session === surfaceSession} ua=${cw.getUserAgent()}`,
      );
      let cookieMismatchHealed = false;
      cw.on("did-navigate", (_e, u, code) => {
        console.log(`[app-surface][diag] popup did-navigate code=${code} ${u}`);
        if (
          /\/\/accounts\.google\.com\/CookieMismatch/i.test(u) &&
          !cookieMismatchHealed &&
          lastGoogleOAuthInitUrl
        ) {
          cookieMismatchHealed = true;
          const retryUrl = lastGoogleOAuthInitUrl;
          void clearGoogleAuthCookies(cw.session).then((n) => {
            console.log(
              `[app-surface][diag] gaia cookie-mismatch self-heal: cleared ${n} google cookies, retrying`,
            );
            if (!cw.isDestroyed()) {
              void cw.loadURL(retryUrl);
            }
          });
        }
      });
      cw.on("did-fail-load", (_e, ec, ed, u) =>
        console.log(`[app-surface][diag] popup did-fail-load ${ec} ${ed} ${u}`),
      );
    } catch (err) {
      console.log(`[app-surface][diag] popup log error ${err}`);
    }
    // The popup is its own auth window; route any further window.open / external
    // links it spawns to the system browser rather than nesting more popups.
    childWindow.webContents.setWindowOpenHandler(({ url }) => {
      openExternalUrlFromMain(url, "app surface auth popup");
      return { action: "deny" };
    });
  });
  // Some sites (Linear, …) sign in by navigating the SURFACE ITSELF to a provider OAuth
  // page, which Google/Microsoft/Apple block in an embedded main frame (dead "Continue").
  // Those providers allow the flow in a real popup — which is why a window.open-based
  // sign-in (Typefully) works. So cancel the in-surface nav and re-issue it as a
  // window.open FROM the surface, routing it through the proven setWindowOpenHandler →
  // did-create-window popup path above (real popup, shared session). Do NOT hand-build a
  // BrowserWindow here — creating one from the surface crashes (SIGSEGV).
  view.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isOAuthPopupOnlyUrl(targetUrl)) {
      return;
    }
    const returnUrl = view.webContents.getURL();
    const appOrigin = httpOrigin(returnUrl);
    if (!appOrigin) {
      return; // no app origin to return to — let it navigate as before
    }
    event.preventDefault();
    const armedBridge = { appOrigin, returnUrl };
    pendingOAuthBridge = armedBridge;
    // userGesture=true so the popup isn't blocked; the width/height features make
    // setWindowOpenHandler treat it as a real popup (shared session). Only clear the
    // bridge WE armed, so a later OAuth can't be cancelled by our stale timer.
    const openPopupJs = `window.open(${JSON.stringify(
      targetUrl,
    )}, "_blank", "popup=yes,width=480,height=660")`;
    view.webContents.executeJavaScript(openPopupJs, true).catch(() => {
      if (pendingOAuthBridge === armedBridge) {
        pendingOAuthBridge = null;
      }
    });
    setTimeout(() => {
      if (pendingOAuthBridge === armedBridge) {
        pendingOAuthBridge = null;
      }
    }, 8000);
  });
  const emitAppSurfaceFailure = (payload: {
    kind: "load" | "crash" | "blank";
    code?: number;
    detail?: string;
    url?: string;
  }) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    const identity = appSurfaceIdentity.get(view.webContents.id)?.appId;
    mainWindow.webContents.send(APP_SURFACE_FAILED_CHANNEL, {
      appId: identity ?? appId,
      ...payload,
    });
  };
  view.webContents.on(
    "did-fail-load",
    (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // -3 = ERR_ABORTED (redirect / superseded nav) — benign, ignore.
      if (isMainFrame && errorCode !== -3) {
        console.warn(
          `[app-surface] did-fail-load ${errorCode} ${errorDescription} @ ${validatedURL}`,
        );
        appSurfaceLoadFailed.add(appId);
        emitAppSurfaceFailure({
          kind: "load",
          code: errorCode,
          detail: errorDescription,
          url: validatedURL,
        });
      }
    },
  );
  view.webContents.on("did-finish-load", () => {
    appSurfaceLoadFailed.delete(appId);
  });
  // Push the live location (current page URL + title) to the renderer so the
  // chat copilot knows which page the user is actually viewing — for ANY web
  // HolaApp surface (need-review, gofunds, third-party bundles like Notion).
  // Fires for full navigations, SPA in-page route changes (Notion), and title
  // updates. Only the active/visible surface drives chat context; a kept-alive
  // background view is ignored. The real holaAppId comes from the identity map
  // (the view is keyed by a namespaced `web:<id>` surface key).
  const emitAppSurfaceLocation = () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (!activeAppSurfaceId || appSurfaceViews.get(activeAppSurfaceId) !== view) {
      return;
    }
    const appId = appSurfaceIdentity.get(view.webContents.id)?.appId;
    if (!appId) {
      return;
    }
    mainWindow.webContents.send(APP_SURFACE_LOCATION_CHANNEL, {
      appId,
      url: view.webContents.getURL(),
      title: view.webContents.getTitle(),
    });
  };
  view.webContents.on("did-navigate", () => emitAppSurfaceLocation());
  view.webContents.on("did-navigate-in-page", (_e, _url, isMainFrame) => {
    if (isMainFrame) {
      emitAppSurfaceLocation();
    }
  });
  view.webContents.on("page-title-updated", () => emitAppSurfaceLocation());
  // A surface's renderer can die (OOM/GPU/page crash). Nothing else evicts a
  // crashed app-surface view, so self-heal here: drop the dead entry so the next
  // open recreates it instead of handing back a view whose webContents is gone.
  // Guard on identity so our own destroy path doesn't re-enter.
  view.webContents.on("render-process-gone", (_e, details) => {
    // Tell the pane BEFORE the view is dropped — afterwards there is no identity
    // left to attribute the failure to.
    emitAppSurfaceFailure({ kind: "crash", detail: details?.reason });
    if (appSurfaceViews.get(appId) === view) {
      destroyAppSurfaceView(appId);
    }
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
    if (attachedAppSurfaceView) {
      try {
        win.removeBrowserView(attachedAppSurfaceView);
      } catch {
        // best effort during renderer teardown
      }
    }
  }
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
  appSurfaceIdentity.set(view.webContents.id, { appId, workspaceId });
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
  // The webContents may already be gone (renderer crash) — read it defensively
  // so teardown never throws on a dead view and always reaches the map delete
  // below. Leaving the entry would wedge the surface open-path permanently.
  const wc = view.webContents as Electron.WebContents | undefined;
  if (wc && !wc.isDestroyed()) {
    appSurfaceIdentity.delete(wc.id);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.removeBrowserView(view);
    } catch {
      // best effort — the view may already be detached
    }
  }
  if (attachedAppSurfaceView === view) {
    attachedAppSurfaceView = null;
  }
  try {
    (wc as unknown as { destroy?: () => void } | undefined)?.destroy?.();
  } catch {
    // best effort
  }
  appSurfaceViews.delete(appId);
  appSurfaceLoadFailed.delete(appId);
  if (activeAppSurfaceId === appId) {
    activeAppSurfaceId = null;
  }
}

function hideAppSurface(): void {
  activeAppSurfaceId = null;
  updateAttachedAppSurfaceView();
}

// --- Web HolaApp surfaces -------------------------------------------------
// Web HolaApps (need-review et al.) are served by the remote web frontend,
// not the local workspace runtime. They reuse the exact same app-surface
// BrowserView machinery (getOrCreate / setBounds / attach / destroy / hide,
// and the committed host bridge) — only the URL resolver differs: the page
// loads from `<WEB_APP_BASE_URL>/apps/<holaAppId>` instead of a localhost
// app port. Surface keys are namespaced (`web:<id>`) so a web HolaApp can't
// collide with a same-named local app in the shared `appSurfaceViews` map.

function webHolaAppSurfaceKey(holaAppId: string): string {
  return `web:${holaAppId}`;
}

/** A view by either name. The renderer knows a HolaApp by its id; a web surface
 *  is stored under a namespaced key, and looking one up by the other silently
 *  returns nothing — which reads as "this surface is gone". */
function resolveAppSurfaceView(appIdOrKey: string) {
  return (
    appSurfaceViews.get(appIdOrKey) ??
    appSurfaceViews.get(webHolaAppSurfaceKey(appIdOrKey))
  );
}

function resolveWebHolaAppUrl(
  holaAppId: string,
  urlPath?: string,
  absoluteUrl?: string,
): string {
  // urlPath is concatenated verbatim (caller supplies a leading `/` or `?`),
  // mirroring navigateAppSurface — e.g. `?record=<id>` for a deep-link.
  const suffix = typeof urlPath === "string" ? urlPath : "";
  // Third-party apps (e.g. Notion) supply an absolute origin to load directly
  // instead of the Holaboss-hosted `<WEB_APP_BASE_URL>/apps/<id>` route.
  if (absoluteUrl) {
    return `${absoluteUrl}${suffix}`;
  }
  // HolaHub is a standalone app on its own subdomain, not a
  // `<WEB_APP_BASE_URL>/apps/<id>` HolaApp route. Its root is the feed;
  // deep-links use the suffix (e.g. `/threads/<id>`).
  if (holaAppId === "holahub") {
    if (!HUB_APP_BASE_URL) {
      throw new Error(
        "HUB_APP_BASE_URL is not configured — set HOLABOSS_HUB_APP_BASE_URL " +
          "(or HOLABOSS_WEB_APP_BASE_URL) to open HolaHub.",
      );
    }
    return `${HUB_APP_BASE_URL}${suffix}`;
  }
  if (!WEB_APP_BASE_URL) {
    throw new Error(
      "WEB_APP_BASE_URL is not configured — set HOLABOSS_WEB_APP_BASE_URL " +
        "(the web frontend origin) to open web HolaApps.",
    );
  }
  // HolaEmployee was promoted out of the generic `/apps/<id>` shell to a
  // first-class `/employees` route; `/apps/holaemployee` survives only as a
  // client-side redirect. Point the surface straight at `/employees` so we
  // (a) skip that redirect hop on first load and (b) let the warm-reopen
  // short-circuit match on reopen — the surface's live getURL() stays
  // `…/employees`, which `…/apps/holaemployee` never equals, so without this
  // EVERY away-and-back did a full reload + SPA re-boot (not a warm reveal).
  // Mirrors the renderer's WEB_APP_PATH_OVERRIDES, which the open path can't
  // apply since the URL is built here from the holaAppId alone.
  if (holaAppId === "holaemployee") {
    return `${WEB_APP_BASE_URL}/employees${suffix}`;
  }
  return `${WEB_APP_BASE_URL}/apps/${encodeURIComponent(holaAppId)}${suffix}`;
}

// The hosted web app gates its routes on a Better Auth session it checks
// against the auth host. The desktop holds that session out-of-band (a token in
// @better-auth/electron storage, NOT a browser cookie), so a fresh surface
// session is anonymous and the app bounces to its sign-in page. Seed the
// desktop's auth cookies into the surface session — scoped to both the auth/api
// host and the web origin — so the app sees the same signed-in user.
async function seedAppSurfaceAuthCookies(
  targetSession: Electron.Session,
): Promise<void> {
  const cookieHeader = authCookieHeader();
  if (!cookieHeader) {
    return;
  }
  // Seed the hub origin too so the standalone HolaHub surface is authenticated.
  // (Its session/data calls target the auth/api host — which is already seeded
  // and same-site to hub.* — so this is a safety net for any hub-origin cookie.)
  const hosts = [AUTH_BASE_URL, WEB_APP_BASE_URL, HUB_APP_BASE_URL].filter(
    (url): url is string => Boolean(url),
  );
  let seeded = 0;
  for (const segment of cookieHeader.split(/;\s*/)) {
    const idx = segment.indexOf("=");
    if (idx < 0) {
      continue;
    }
    const name = segment.slice(0, idx).trim();
    const value = segment.slice(idx + 1).trim();
    if (!name || !value || !name.includes("better-auth")) {
      continue;
    }
    for (const url of hosts) {
      try {
        await targetSession.cookies.set({
          url,
          name,
          value,
          secure: url.startsWith("https"),
          httpOnly: true,
          sameSite: "no_restriction",
        });
        seeded += 1;
      } catch (err) {
        console.warn(`[web-holaapp] failed to seed auth cookie ${name}:`, err);
      }
    }
  }
  console.log(`[web-holaapp] seeded ${seeded} auth cookie(s) into the surface`);
}

// Two URLs address the same document when they share an origin + pathname and
// differ only in query/hash — the SPA can transition between them client-side.
// Same origin = the same first-party SPA. A path / query / hash change within it is a
// client-side React Router navigation (see softNavigateAppSurface), so it needs no reload
// — this gates soft-nav on a warm first-party surface. Previously this also required the
// same PATHNAME (query-only swaps like ?section=), which forced a full SPA reboot on a real
// route change (e.g. /employees ↔ /employees/catalog); origin-only lets those soft-nav too.
function isSameOriginUrl(current: string, target: string): boolean {
  try {
    return new URL(current).origin === new URL(target).origin;
  } catch {
    return false;
  }
}

// Soft (client-side) navigation on a warm surface: push the new URL into the
// page's OWN history and fire popstate so React Router treats it as a POP and
// re-reads window.location (updating useSearchParams) WITHOUT a reload. Preserves
// RR's history-state shape (usr/key/idx) so its popstate handler doesn't warn
// about a missing idx. Returns false if the page couldn't accept it (caller then
// falls back to a hard load).
async function softNavigateAppSurface(
  webContents: Electron.WebContents,
  targetUrl: string,
): Promise<boolean> {
  const js = `(() => {
    try {
      // A warm view whose SPA is not mounted — it crashed, it bounced to a
      // sign-out, it never booted — accepts pushState happily and then renders
      // nothing. That is the blank pane: the caller treats the soft nav as a
      // success and never hard-loads. Decline so it does.
      var mount = document.getElementById("root") || document.body;
      if (!mount || mount.childElementCount === 0) { return false; }
      var u = new URL(${JSON.stringify(targetUrl)});
      var rel = u.pathname + u.search + u.hash;
      var prev = window.history.state;
      var idx = (prev && typeof prev.idx === "number") ? prev.idx : 0;
      var next = Object.assign({}, prev, { idx: idx + 1 });
      window.history.pushState(next, "", rel);
      window.dispatchEvent(new PopStateEvent("popstate", { state: next }));
      return true;
    } catch (e) { return false; }
  })()`;
  try {
    const ok = await webContents.executeJavaScript(js, true);
    return ok === true;
  } catch {
    return false;
  }
}

async function navigateWebHolaAppSurface(
  holaAppId: string,
  urlPath?: string,
  absoluteUrl?: string,
  forceReload = false,
  soft = false,
): Promise<void> {
  // Command/stdio-MCP apps (drawio) point their surface at a LOCAL editor server
  // that only comes up once the agent calls start_session. Load the captured live
  // session if we have one, else a "ready" placeholder — never the bare local
  // port, which is connection-refused until the first draw. (Detected by the
  // localhost surface URL; only these apps use one.)
  if (absoluteUrl && isLocalhostSurfaceUrl(absoluteUrl)) {
    absoluteUrl = commandMcpSurfaceUrl();
    urlPath = undefined;
  }
  const targetUrl = resolveWebHolaAppUrl(holaAppId, urlPath, absoluteUrl);
  const surfaceKey = webHolaAppSurfaceKey(holaAppId);
  const existing = appSurfaceViews.get(surfaceKey);
  // Third-party surfaces (absoluteUrl, e.g. Notion) are plain embedded browsers.
  // Bind them to a persistent partition + native user-agent so their logins
  // survive restarts and sites don't see an Electron UA. First-party Holaboss
  // surfaces stay on the default session (their auth is seeded separately below).
  let surfaceSession: Electron.Session | undefined;
  if (absoluteUrl && !existing) {
    surfaceSession = appSurfaceBrowserSession();
  }
  const view = getOrCreateAppSurfaceView(surfaceKey, surfaceSession);
  // The host bridge resolves the calling page's identity from this map. Carry
  // the real holaAppId (not the namespaced surface key) so hostChatStart can
  // attribute a chat.start to this app. The single-tenant runtime resolves the
  // workspace itself (ROOT_WORKSPACE_ID), so no workspace id is carried here.
  appSurfaceIdentity.set(view.webContents.id, { appId: holaAppId });
  activeAppSurfaceId = surfaceKey;
  updateAttachedAppSurfaceView();

  // (A0) Refresh reloads the page the surface is ON, never a rebuilt URL. The
  // pane sends the live pathname as the suffix, and the first-party resolver
  // appends it to a base that already carries `/apps/<id>` — reloading through
  // that path double-prefixes and lands on the web app's 404.
  if (
    forceReload &&
    existing &&
    !existing.webContents.isCrashed() &&
    existing.webContents.getURL() &&
    existing.webContents.getURL() !== "about:blank"
  ) {
    console.log(
      `[web-holaapp] ${holaAppId} refresh — reloading ${existing.webContents.getURL()}`,
    );
    existing.webContents.reload();
    return;
  }

  // (B) Warm reopen: a kept-alive view already sitting on the exact target URL
  // (idle, not crashed) needs no reload — return immediately so the renderer
  // reveals the already-painted page instantly. A user-initiated Refresh passes
  // forceReload to force a real reload past this short-circuit.
  if (
    !forceReload &&
    existing &&
    !existing.webContents.isLoading() &&
    !existing.webContents.isCrashed() &&
    !appSurfaceLoadFailed.has(surfaceKey) &&
    existing.webContents.getURL() === targetUrl
  ) {
    console.log(
      `[web-holaapp] ${holaAppId} already loaded — revealing without reload`,
    );
    return;
  }

  // (B1) Third-party surfaces are browsers, not routes: a live view already on the
  // app's own origin is wherever the user last navigated (a Notion page). Reopening
  // reveals it as-is instead of yanking them back to the entry URL. An explicit
  // deep-link (urlPath) or Refresh (forceReload) still navigates.
  if (
    absoluteUrl &&
    !forceReload &&
    !urlPath &&
    existing &&
    !existing.webContents.isCrashed() &&
    !appSurfaceLoadFailed.has(surfaceKey) &&
    isSameOriginUrl(existing.webContents.getURL(), targetUrl)
  ) {
    console.log(
      `[web-holaapp] ${holaAppId} keeping current page — revealing without reload`,
    );
    return;
  }

  // (B2) Soft client-side nav: the caller marked this surface query-driven and the warm
  // view is already on the same first-party SPA (same origin), differing in path / query /
  // hash — e.g. the Cloud rail switching ?section=, OR a real route change like
  // /employees ↔ /employees/catalog. React Router handles both client-side, so push the new
  // URL into the page's history instead of a full reload: instant, no "Opening…" flash and
  // no SPA reboot. If the page declines (not ready / threw), fall through to a hard load.
  if (
    soft &&
    !forceReload &&
    !absoluteUrl &&
    existing &&
    !existing.webContents.isLoading() &&
    !existing.webContents.isCrashed() &&
    !appSurfaceLoadFailed.has(surfaceKey) &&
    isSameOriginUrl(existing.webContents.getURL(), targetUrl)
  ) {
    const ok = await softNavigateAppSurface(existing.webContents, targetUrl);
    if (ok) {
      console.log(`[web-holaapp] ${holaAppId} soft-navigated → ${targetUrl}`);
      return;
    }
    console.log(
      `[web-holaapp] ${holaAppId} soft-nav declined (page not mounted) — hard loading`,
    );
  }

  // Third-party apps (absoluteUrl) are plain embedded browser surfaces: they
  // don't carry the Holaboss session and have no Holaboss MCP, so skip the
  // auth-cookie seeding and MCP attach (both are Holaboss-hosted-app concerns).
  if (!absoluteUrl) {
    // Re-seed on every navigate — the Better Auth token rotates. Must finish before the
    // page loads so the surface session is authenticated.
    //
    // NOTE: MCP is intentionally NOT attached here. An app's MCP follows INSTALL state, not
    // surface-open: installHolaApp attaches it, and ensureWebHolaAppMcpAttached re-applies
    // every installed app's MCP before each chat turn. Opening the surface is just viewing
    // the app's UI — it must not be what gives the agent its tools.
    await seedAppSurfaceAuthCookies(view.webContents.session);
  }
  console.log(`[web-holaapp] navigating ${holaAppId} → ${targetUrl}`);
  // (A) Reveal at first-contentful-paint, not did-finish-load. The renderer's
  // "Opening…" spinner clears when this resolves; appSurfacePreload posts
  // WEB_HOLAAPP_FIRST_PAINT_CHANNEL the instant the page first paints (≈ what a
  // browser shows), which usually wins the race below. The native view keeps
  // painting subresources after we resolve, exactly like a browser tab.
  const firstPaint = new Promise<void>((resolve) => {
    // webContents.ipc is per-WebContents, so this is scoped to this surface and
    // auto-removed after it fires once.
    view.webContents.ipc.once(WEB_HOLAAPP_FIRST_PAINT_CHANNEL, () => resolve());
  });
  // Bound the load. webContents.loadURL resolves on did-finish-load and can hang
  // indefinitely if the page stalls (slow network, auth redirect loop) — the
  // did-finish-load fallback and the hard timeout below cap the wait so the
  // spinner always clears. Errors are logged, not thrown, so a failed load reveals
  // the native view (the app's own error / sign-in page) instead of leaving the
  // spinner up.
  const load = view.webContents.loadURL(targetUrl).then(
    () => undefined,
    (err: unknown) => {
      // ERR_ABORTED (-3) = navigation superseded by a redirect / rapid re-navigation;
      // benign — the view still lands on the right page.
      const code = (err as { code?: unknown } | null)?.code;
      const errno = (err as { errno?: unknown } | null)?.errno;
      if (code !== "ERR_ABORTED" && errno !== -3) {
        console.warn(`[web-holaapp] ${holaAppId} load error:`, err);
      }
    },
  );
  await Promise.race([
    firstPaint,
    load,
    new Promise<void>((resolve) => {
      setTimeout(resolve, WEB_HOLAAPP_LOAD_TIMEOUT_MS);
    }),
  ]);
  // Final URL reveals a redirect (e.g. the web app bounced us to a sign-in page because
  // the surface session isn't authenticated) vs the app itself.
  const settledUrl = view.webContents.getURL();
  console.log(`[web-holaapp] ${holaAppId} settled at ${settledUrl}`);
  // Revealing a view that never got anywhere is the white rectangle: the race
  // above is deliberately permissive so a page that renders its OWN error still
  // shows, but a view sitting on about:blank has nothing to show at all.
  if (!settledUrl || settledUrl === "about:blank") {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(APP_SURFACE_FAILED_CHANNEL, {
        appId: holaAppId,
        kind: "blank",
        url: targetUrl,
      });
    }
  }
}

// Prewarm a web HolaApp surface: create its (detached, invisible) BrowserView and
// background-load the page so the FIRST open reveals instantly via the warm-reopen
// short-circuit instead of paying a cold SPA load. Best-effort — never throws.
// Skips when unauthenticated (so we don't cache a sign-in page) or when a view
// already exists (already warm). The view is loaded but NOT attached / made active,
// so it stays offscreen until the user actually opens the surface.
async function prewarmWebHolaAppSurface(holaAppId: string): Promise<void> {
  try {
    if (!WEB_APP_BASE_URL || !authCookieHeader()) {
      return;
    }
    const surfaceKey = webHolaAppSurfaceKey(holaAppId);
    const existing = appSurfaceViews.get(surfaceKey);
    if (existing && !existing.webContents.isCrashed()) {
      return;
    }
    const targetUrl = resolveWebHolaAppUrl(holaAppId);
    const view = getOrCreateAppSurfaceView(surfaceKey);
    appSurfaceIdentity.set(view.webContents.id, { appId: holaAppId });
    // Keep it responsive while detached so the prewarm load isn't background-throttled.
    view.webContents.setBackgroundThrottling(false);
    try {
      await seedAppSurfaceAuthCookies(view.webContents.session);
      console.log(`[web-holaapp] prewarming ${holaAppId} → ${targetUrl}`);
      await view.webContents.loadURL(targetUrl).then(
        () => console.log(`[web-holaapp] ${holaAppId} prewarmed`),
        (err: unknown) => {
          const code = (err as { code?: unknown } | null)?.code;
          if (code !== "ERR_ABORTED") {
            console.warn(`[web-holaapp] prewarm ${holaAppId} load error:`, err);
          }
        },
      );
    } finally {
      // The opt-out above is for the LOAD, per its comment — but nothing ever
      // put it back, so a detached, invisible page kept running its timers,
      // animations and polling at full cadence for the rest of the app
      // session. Restoring the default only affects the view while it is
      // hidden or occluded; an attached, visible surface is not throttled by
      // Chromium.
      //
      // In a `finally`, not at the end of the try: the cookie seed above can
      // reject, and the outer catch only logs — so on that path the opt-out
      // would otherwise be permanent, which is the leak this exists to close.
      if (!view.webContents.isDestroyed()) {
        view.webContents.setBackgroundThrottling(true);
      }
    }
  } catch (err) {
    console.warn(`[web-holaapp] prewarm ${holaAppId} failed:`, err);
  }
}

function destroyWebHolaAppSurface(holaAppId: string): void {
  destroyAppSurfaceView(webHolaAppSurfaceKey(holaAppId));
}

function asYamlRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Cache of each web HolaApp's MCP tool names, discovered live from the app's MCP. Avoids a
// network round-trip on every per-turn re-attach; cleared on uninstall.
const webHolaAppToolCache = new Map<string, string[]>();

function parseMcpToolsListResponse(text: string): string[] {
  const fromJson = (raw: string): string[] | null => {
    try {
      const obj = JSON.parse(raw) as {
        result?: { tools?: Array<{ name?: unknown }> };
      };
      const tools = obj?.result?.tools;
      if (Array.isArray(tools)) {
        return tools
          .map((tool) => tool?.name)
          .filter((name): name is string => typeof name === "string");
      }
    } catch {
      // not plain JSON — could be an SSE stream; fall through
    }
    return null;
  };
  const direct = fromJson(text);
  if (direct) {
    return direct;
  }
  // Streamable HTTP may answer with an SSE stream of `data:` events.
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^data:\s*(.*)$/);
    if (match) {
      const parsed = fromJson(match[1]);
      if (parsed) {
        return parsed;
      }
    }
  }
  return [];
}

// Discover a web HolaApp's MCP tool names (cached) via the same initialize + tools/list the
// runtime's MCP client does. Needed to enumerate the app's tools into the workspace.yaml
// allowlist (see attachWebHolaAppMcp): the pi ("Hola") harness builds its tool allowlist
// from those refs, so un-enumerated tools are silently filtered out of the agent.
async function discoverWebHolaAppMcpTools(holaAppId: string): Promise<string[]> {
  const cached = webHolaAppToolCache.get(holaAppId);
  if (cached) {
    return cached;
  }
  if (!WEB_HOLAAPP_MCP_BASE_URL) {
    return [];
  }
  const url = `${WEB_HOLAAPP_MCP_BASE_URL}/mcp/${encodeURIComponent(holaAppId)}/mcp`;
  const bearer = authBearerToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
  };
  try {
    // Some servers require an initialize handshake first; capture any session id it sets.
    const init = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "holaboss-desktop", version: "0.0.0" },
        },
      }),
    }).catch(() => null);
    const sessionId = init?.headers.get("mcp-session-id") ?? undefined;
    const resp = await fetch(url, {
      method: "POST",
      headers: { ...headers, ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    if (!resp.ok) {
      console.warn(`[web-holaapp] tools/list for ${holaAppId} → ${resp.status}`);
      return [];
    }
    const tools = parseMcpToolsListResponse(await resp.text());
    if (tools.length > 0) {
      webHolaAppToolCache.set(holaAppId, tools);
    }
    return tools;
  } catch (err) {
    console.warn(`[web-holaapp] tools/list failed for ${holaAppId}:`, err);
    return [];
  }
}

// Auto-attach a web HolaApp's MCP server to the workspace so the local agent (e.g. the
// Discuss chat) gets the app's tools live. Writes a remote MCP server entry into the
// workspace's workspace.yaml; the runtime reads it per run. Auth is the desktop's
// Better-Auth session bearer, written literally and refreshed on each attach. Idempotent.
// No-op if the MCP base or workspace.yaml is missing.
//
// Tools: the app's tools are DISCOVERED (cached) and enumerated into mcp_registry.allowlist.
// This is required, not optional — the pi ("Hola") harness builds its tool allowlist from
// the resolved allowlist refs, so an auto-attached server whose tools aren't enumerated here
// is silently filtered out of the agent (see runtime/harnesses/src/pi.ts). Existing entries
// and the workspace catalog are preserved so specifying the allowlist doesn't strip them.
async function attachWebHolaAppMcp(
  workspaceId: string,
  holaAppId: string,
): Promise<void> {
  if (!WEB_HOLAAPP_MCP_BASE_URL) {
    return;
  }
  try {
    const workspaceDir = await resolveWorkspaceDir(workspaceId);
    const yamlPath = path.join(workspaceDir, "workspace.yaml");
    if (!existsSync(yamlPath)) {
      return;
    }
    const data = asYamlRecord(parseYaml(await fs.readFile(yamlPath, "utf-8")));
    const registry = asYamlRecord(data.mcp_registry);
    const servers = asYamlRecord(registry.servers);
    const appServers = asYamlRecord(registry.app_servers);
    // Discover the app's tools FIRST. An id with no Holaboss-hosted `/mcp/<id>`
    // server (e.g. Notion, now a catalog-only external app served by the backend
    // — its tools come from a connected Composio account, not a hosted MCP)
    // yields zero tools: skip attaching entirely rather than write a dead server
    // entry the pi harness would just filter out (and re-probe every turn).
    const appToolNames = await discoverWebHolaAppMcpTools(holaAppId);
    if (appToolNames.length === 0) {
      return;
    }
    // Write the Better Auth bearer LITERALLY (fresh from the main process at
    // attach time) rather than a {env:...} placeholder. The placeholder
    // resolved from the runtime's SPAWN-time env, which silently broke whenever
    // the long-lived runtime was reused across restarts without the var.
    // Re-attach (every surface open) refreshes the token. Trade-off: the
    // session token lands in the local workspace.yaml — already present on the
    // machine via the runtime env / auth store, and refreshed on each open.
    const bearer = authBearerToken();
    // App-owned MCP → the `app_servers` section (grouped under its app
    // container), not the standalone `servers` pool.
    appServers[holaAppId] = {
      type: "remote",
      // mcporter (the runtime's MCP client) tries Streamable HTTP, then falls
      // back to SSE on the SAME url — so this must be the `/sse` rest-path (the
      // gateway forwards `/mcp/<app>/<rest>`). Pointing it at the streamable
      // `/mcp` rest-path made the SSE fallback 404 ("SSE error: Non-200 (404)").
      url: `${WEB_HOLAAPP_MCP_BASE_URL}/mcp/${encodeURIComponent(holaAppId)}/sse`,
      enabled: true,
      timeout_ms: WEB_HOLAAPP_MCP_TIMEOUT_MS,
      owner_app_id: holaAppId,
      ...(bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {}),
    };
    registry.app_servers = appServers;
    // Drop any legacy standalone-pool copy of this app's server.
    if (holaAppId in servers) {
      delete servers[holaAppId];
      registry.servers = servers;
    }

    // Enumerate the app's discovered tools into the allowlist, preserving
    // existing entries (other apps) + the workspace catalog.
    const allowlist = asYamlRecord(registry.allowlist);
    const existing = Array.isArray(allowlist.tool_ids)
      ? allowlist.tool_ids.filter((id): id is string => typeof id === "string")
      : [];
    const next = [
      ...existing.filter((id) => !id.startsWith(`${holaAppId}.`)),
      ...Object.keys(asYamlRecord(registry.catalog)),
      ...appToolNames.map((tool) => `${holaAppId}.${tool}`),
    ];
    allowlist.tool_ids = [...new Set(next)];
    registry.allowlist = allowlist;

    data.mcp_registry = registry;
    await fs.writeFile(
      yamlPath,
      `${stringifyYaml(data, { defaultStringType: "QUOTE_DOUBLE" }).trimEnd()}\n`,
      "utf-8",
    );
    console.log(
      `[web-holaapp] attached MCP server '${holaAppId}' (${appToolNames.length} tools) in ${yamlPath}`,
    );
  } catch (err) {
    console.warn(`[web-holaapp] failed to attach MCP for ${holaAppId}:`, err);
  }
}

// The web HolaApps the user has installed (synced from the renderer marketplace). Drives
// the per-turn MCP attach so the agent has every installed app's tools — not a hardcoded
// list. Rehydrated from the renderer via holaApps:sync on launch.
const installedHolaAppIds = new Set<string>();

// Remove a web HolaApp's MCP server from the workspace (on uninstall).
async function detachWebHolaAppMcp(
  workspaceId: string,
  holaAppId: string,
): Promise<void> {
  try {
    const workspaceDir = await resolveWorkspaceDir(workspaceId);
    const yamlPath = path.join(workspaceDir, "workspace.yaml");
    if (!existsSync(yamlPath)) {
      return;
    }
    const data = asYamlRecord(parseYaml(await fs.readFile(yamlPath, "utf-8")));
    const registry = asYamlRecord(data.mcp_registry);
    const servers = asYamlRecord(registry.servers);
    const appServers = asYamlRecord(registry.app_servers);
    const inServers = holaAppId in servers;
    const inAppServers = holaAppId in appServers;
    if (!inServers && !inAppServers) {
      return;
    }
    // The app's server lives in app_servers now; legacy installs may still have
    // it in the standalone `servers` pool — clear both.
    if (inServers) {
      delete servers[holaAppId];
      registry.servers = servers;
    }
    if (inAppServers) {
      delete appServers[holaAppId];
      registry.app_servers = appServers;
    }
    webHolaAppToolCache.delete(holaAppId);
    // Drop any stale allowlist ids for this app (harmless if absent).
    const allowlist = asYamlRecord(registry.allowlist);
    if (Array.isArray(allowlist.tool_ids)) {
      allowlist.tool_ids = allowlist.tool_ids.filter(
        (id) => typeof id === "string" && !id.startsWith(`${holaAppId}.`),
      );
      registry.allowlist = allowlist;
    }
    data.mcp_registry = registry;
    await fs.writeFile(
      yamlPath,
      `${stringifyYaml(data, { defaultStringType: "QUOTE_DOUBLE" }).trimEnd()}\n`,
      "utf-8",
    );
    console.log(`[web-holaapp] detached MCP server '${holaAppId}' in ${yamlPath}`);
  } catch (err) {
    console.warn(`[web-holaapp] failed to detach MCP for ${holaAppId}:`, err);
  }
}

// Reconcile the installed set with what the renderer reports (on launch / refresh):
// attach newly installed apps, detach removed ones.
async function syncInstalledHolaApps(holaAppIds: string[]): Promise<void> {
  const next = new Set(
    holaAppIds.filter((id) => typeof id === "string" && id.length > 0),
  );
  for (const id of installedHolaAppIds) {
    if (!next.has(id)) {
      await detachWebHolaAppMcp(ROOT_WORKSPACE_ID, id);
    }
  }
  for (const id of next) {
    if (!installedHolaAppIds.has(id)) {
      await attachWebHolaAppMcp(ROOT_WORKSPACE_ID, id);
    }
  }
  installedHolaAppIds.clear();
  for (const id of next) {
    installedHolaAppIds.add(id);
  }
}

async function installHolaApp(holaAppId: string): Promise<void> {
  installedHolaAppIds.add(holaAppId);
  await attachWebHolaAppMcp(ROOT_WORKSPACE_ID, holaAppId);
}

async function uninstallHolaApp(holaAppId: string): Promise<void> {
  installedHolaAppIds.delete(holaAppId);
  // Removing servers[holaAppId] from workspace.yaml covers hosted, api-key AND
  // command/stdio servers (all keyed by holaAppId); also drop it from the
  // command-MCP set so a stale capture isn't routed to a closed app.
  commandMcpAppIds.delete(holaAppId);
  // Stop the per-turn re-attach for this app's owned hosted MCP (jianguoyun) —
  // the server id IS the holaAppId; the detach below clears its app_servers entry.
  installedHostedAppMcps.delete(holaAppId);
  await detachWebHolaAppMcp(ROOT_WORKSPACE_ID, holaAppId);
}

// Attach every INSTALLED web HolaApp's MCP server to the workspace, regardless of whether
// its surface has been opened. Called before each chat turn is queued (see
// queueSessionInput): the runtime recompiles the plan from workspace.yaml every run, so
// attaching here guarantees the local agent has each installed app's tools even when the
// user chats WITHOUT first opening the surface. Best-effort + idempotent;
// attachWebHolaAppMcp refreshes the bearer and no-ops when there is no local
// workspace.yaml (e.g. remote-only runtimes).
async function ensureWebHolaAppMcpAttached(workspaceId: string): Promise<void> {
  for (const holaAppId of installedHolaAppIds) {
    await attachWebHolaAppMcp(workspaceId, holaAppId);
  }
}

// System-level MCP surfaces that aren't app-store HolaApps but whose agent MCP we
// always attach. HolaHub (the community feed) is NOT an installed HolaApp, but its
// contribute/post tools (/mcp/holahub) are GLOBAL — the agent can search / contribute
// / post to HolaHub from ANY session (e.g. an "Assisted by Hola" hand-off) without
// first opening the HolaHub surface. Attached the same way as an installed app's MCP
// (discover → app_servers entry → allowlist); auth rides the user's session bearer,
// so no surface-open is required.
const SYSTEM_MCP_APP_IDS = [HUB_APP_ID] as const;

async function ensureSystemMcpAttached(workspaceId: string): Promise<void> {
  for (const appId of SYSTEM_MCP_APP_IDS) {
    await attachWebHolaAppMcp(workspaceId, appId);
  }
}

// ── Marketplace MCP servers — the MCP-catalog install ─────────────────────────
// An installable MCP server the user picks in the desktop marketplace (renderer
// src/lib/mcpMarketplace.ts, catalog GET /gateway/wapp/mcp-catalog). Installing writes a
// REMOTE MCP server entry into workspace.yaml mcp_registry.servers[id], applying the user's
// required keys by target (header → headers, query → url query string) and — for
// holaboss-hosted servers — ALSO the Better-Auth session bearer, exactly like
// attachWebHolaAppMcp. The user's keys arrive over IPC from the renderer's LOCAL store
// (never a gateway call) and, like the existing api-key path, land only in the local
// workspace.yaml.
//
// env-target keys: the runtime's remote (HTTP) MCP transport carries only a url + headers
// (runtime/harnesses/src/mcp.ts) — a remote server has no env (env is a local/stdio
// concept). So env-target keys are UNSUPPORTED here and skipped with a warning. No
// marketplace entry uses env today (坚果云 authenticates with a header).

interface MarketplaceMcpAttachConfig {
  id: string;
  mcpUrl: string;
  holabossHosted: boolean;
  headerKeys: Record<string, string>;
  queryKeys: Record<string, string>;
  envKeys: Record<string, string>;
  tools: string[];
  /** Set when this MCP is owned by a HolaApp container (its hostedMcpInstall) —
   * written to app_servers with owner_app_id, not the standalone servers pool. */
  ownerAppId?: string;
}

// The marketplace MCP servers installed this session, keyed by id → resolved config. Drives
// the per-turn re-attach (refreshing the session bearer for hosted servers), like
// installedHolaAppIds. Rehydrated from the renderer via mcpMarketplace:sync on launch.
const installedMarketplaceMcps = new Map<string, MarketplaceMcpAttachConfig>();
// Cache of each marketplace MCP's discovered tool names (cleared on detach).
const marketplaceMcpToolCache = new Map<string, string[]>();

function stringRecordFromUnknown(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) {
        out[key] = value;
      }
    }
  }
  return out;
}

// Validate the attach config coming across IPC before we trust it.
function normalizeMarketplaceMcpConfig(
  value: unknown,
): MarketplaceMcpAttachConfig | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const v = value as Record<string, unknown>;
  const id = typeof v.id === "string" ? v.id.trim() : "";
  const mcpUrl = typeof v.mcpUrl === "string" ? v.mcpUrl.trim() : "";
  if (!id || !mcpUrl) {
    return null;
  }
  return {
    id,
    mcpUrl,
    holabossHosted: v.holabossHosted === true,
    headerKeys: stringRecordFromUnknown(v.headerKeys),
    queryKeys: stringRecordFromUnknown(v.queryKeys),
    envKeys: stringRecordFromUnknown(v.envKeys),
    tools: Array.isArray(v.tools)
      ? v.tools.filter(
          (tool): tool is string => typeof tool === "string" && tool.length > 0,
        )
      : [],
    ...(typeof v.ownerAppId === "string" && v.ownerAppId.trim()
      ? { ownerAppId: v.ownerAppId.trim() }
      : {}),
  };
}

// Resolve the server url: holaboss-hosted paths get the API base prepended; query-target
// keys are appended to the query string. External urls are used as-is (plus query keys).
function resolveMarketplaceMcpUrl(config: MarketplaceMcpAttachConfig): string {
  const base = config.holabossHosted
    ? `${WEB_HOLAAPP_MCP_BASE_URL}${config.mcpUrl}`
    : config.mcpUrl;
  const queryEntries = Object.entries(config.queryKeys);
  if (queryEntries.length === 0) {
    return base;
  }
  const qs = queryEntries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return `${base}${base.includes("?") ? "&" : "?"}${qs}`;
}

// Resolve the request headers: the header-target keys, plus (holaboss-hosted only) the
// Better-Auth session bearer, read fresh from the main process on each attach.
function resolveMarketplaceMcpHeaders(
  config: MarketplaceMcpAttachConfig,
): Record<string, string> {
  const bearer = config.holabossHosted ? authBearerToken() : "";
  return {
    ...config.headerKeys,
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
  };
}

// Discover a marketplace MCP's tool names via the same initialize + tools/list handshake the
// runtime's MCP client does, using the RESOLVED headers (so a server that only lists tools
// once authenticated — e.g. 坚果云 with its credential header — still enumerates). Cached.
async function discoverMarketplaceMcpTools(
  id: string,
  url: string,
  authHeaders: Record<string, string>,
): Promise<string[]> {
  const cached = marketplaceMcpToolCache.get(id);
  if (cached) {
    return cached;
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...authHeaders,
  };
  try {
    const init = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "holaboss-desktop", version: "0.0.0" },
        },
      }),
    }).catch(() => null);
    const sessionId = init?.headers.get("mcp-session-id") ?? undefined;
    const resp = await fetch(url, {
      method: "POST",
      headers: { ...headers, ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    if (!resp.ok) {
      console.warn(`[mcp-marketplace] tools/list for ${id} → ${resp.status}`);
      return [];
    }
    const tools = parseMcpToolsListResponse(await resp.text());
    if (tools.length > 0) {
      marketplaceMcpToolCache.set(id, tools);
    }
    return tools;
  } catch (err) {
    console.warn(`[mcp-marketplace] tools/list failed for ${id}:`, err);
    return [];
  }
}

// Attach a REMOTE MCP server (hosted or external, with resolved keys) to the workspace's
// workspace.yaml — the generic hosted-MCP attach shared by BOTH the standalone MCP
// marketplace AND app-owned hosted MCPs (a HolaApp's hostedMcpInstall, via attachAppOwned).
// Writes a remote server entry with the resolved url (+ query keys) and headers (header keys
// + session bearer for hosted servers); when config.ownerAppId is set it lands in app_servers
// (grouped under the app) instead of the standalone `servers` pool. Enumerates its tools into
// the allowlist (catalog-provided names, else discovered live). Idempotent; refreshes the bearer.
async function attachHostedMcpServer(
  workspaceId: string,
  config: MarketplaceMcpAttachConfig,
): Promise<void> {
  if (config.holabossHosted && !WEB_HOLAAPP_MCP_BASE_URL) {
    return;
  }
  if (Object.keys(config.envKeys).length > 0) {
    console.warn(
      `[mcp-marketplace] env-target keys for '${config.id}' are unsupported for a remote MCP server and were ignored:`,
      Object.keys(config.envKeys).join(", "),
    );
  }
  try {
    const workspaceDir = await resolveWorkspaceDir(workspaceId);
    const yamlPath = path.join(workspaceDir, "workspace.yaml");
    if (!existsSync(yamlPath)) {
      return;
    }
    const url = resolveMarketplaceMcpUrl(config);
    const headers = resolveMarketplaceMcpHeaders(config);
    // Prefer catalog-provided tool names; else probe the live server with the resolved
    // headers. Either way the allowlist must carry them or the pi harness filters them out.
    const toolNames =
      config.tools.length > 0
        ? config.tools
        : await discoverMarketplaceMcpTools(config.id, url, headers);

    const data = asYamlRecord(parseYaml(await fs.readFile(yamlPath, "utf-8")));
    const registry = asYamlRecord(data.mcp_registry);
    const servers = asYamlRecord(registry.servers);
    const appServers = asYamlRecord(registry.app_servers);
    const entry: Record<string, unknown> = {
      type: "remote",
      url,
      enabled: true,
      timeout_ms: WEB_HOLAAPP_MCP_TIMEOUT_MS,
      ...(config.ownerAppId ? { owner_app_id: config.ownerAppId } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
    // App-owned hosted MCP (hostedMcpInstall) → the app_servers section (grouped
    // under its app container); a standalone marketplace MCP → the servers pool.
    if (config.ownerAppId) {
      appServers[config.id] = entry;
      registry.app_servers = appServers;
      if (config.id in servers) {
        delete servers[config.id];
      }
      registry.servers = servers;
    } else {
      servers[config.id] = entry;
      registry.servers = servers;
    }

    // Enumerate this server's tools into the allowlist, preserving existing entries + the
    // workspace catalog. When we couldn't determine any tool names, leave the allowlist
    // untouched — writing a partial allowlist would filter this server's tools out.
    if (toolNames.length > 0) {
      const allowlist = asYamlRecord(registry.allowlist);
      const existing = Array.isArray(allowlist.tool_ids)
        ? allowlist.tool_ids.filter((id): id is string => typeof id === "string")
        : [];
      allowlist.tool_ids = [
        ...new Set([
          ...existing.filter((toolId) => !toolId.startsWith(`${config.id}.`)),
          ...Object.keys(asYamlRecord(registry.catalog)),
          ...toolNames.map((tool) => `${config.id}.${tool}`),
        ]),
      ];
      registry.allowlist = allowlist;
    } else {
      console.warn(
        `[mcp-marketplace] no tools resolved for '${config.id}'; attached the server but did not enumerate the allowlist`,
      );
    }

    data.mcp_registry = registry;
    await fs.writeFile(
      yamlPath,
      `${stringifyYaml(data, { defaultStringType: "QUOTE_DOUBLE" }).trimEnd()}\n`,
      "utf-8",
    );
    console.log(
      `[mcp-marketplace] attached MCP server '${config.id}' (${toolNames.length} tools) in ${yamlPath}`,
    );
  } catch (err) {
    console.warn(`[mcp-marketplace] failed to attach MCP for ${config.id}:`, err);
  }
}

// Re-attach every installed marketplace MCP before a turn (refreshing the session bearer for
// hosted servers) — mirrors ensureWebHolaAppMcpAttached. Best-effort + idempotent.
async function ensureMarketplaceMcpAttached(workspaceId: string): Promise<void> {
  for (const config of installedMarketplaceMcps.values()) {
    await attachHostedMcpServer(workspaceId, config);
  }
}

// Reconcile the installed set with what the renderer reports (on launch / refresh): attach
// newly installed servers, detach removed ones. Mirrors syncInstalledHolaApps. Detach reuses
// detachCustomMcpServer (removes the workspace.yaml server + its allowlist ids).
async function syncInstalledMarketplaceMcps(
  configs: MarketplaceMcpAttachConfig[],
): Promise<void> {
  const next = new Map(configs.map((config) => [config.id, config]));
  for (const id of installedMarketplaceMcps.keys()) {
    if (!next.has(id)) {
      marketplaceMcpToolCache.delete(id);
      await detachCustomMcpServer(ROOT_WORKSPACE_ID, id);
    }
  }
  installedMarketplaceMcps.clear();
  for (const [id, config] of next) {
    installedMarketplaceMcps.set(id, config);
    await attachHostedMcpServer(ROOT_WORKSPACE_ID, config);
  }
}

async function installMarketplaceMcp(
  config: MarketplaceMcpAttachConfig,
): Promise<void> {
  installedMarketplaceMcps.set(config.id, config);
  await attachHostedMcpServer(ROOT_WORKSPACE_ID, config);
}

async function uninstallMarketplaceMcp(id: string): Promise<void> {
  installedMarketplaceMcps.delete(id);
  marketplaceMcpToolCache.delete(id);
  await detachCustomMcpServer(ROOT_WORKSPACE_ID, id);
}

// ── App-owned hosted MCPs (a HolaApp's hostedMcpInstall, e.g. jianguoyun) ──────
// Tracked SEPARATELY from installedMarketplaceMcps: that set is reconciled
// against the MCP-marketplace catalog (which app MCPs are never in), so it would
// detach them. This set is reconciled against the INSTALLED APPS instead, and
// re-attached before every turn to refresh the session bearer — so an app-owned
// hosted MCP self-heals exactly like helm's ensureWebHolaAppMcpAttached (its own
// web-app attach can't refresh it: it discovers 0 tools without the BYO creds).
const installedHostedAppMcps = new Map<string, MarketplaceMcpAttachConfig>();

async function ensureHostedAppMcpsAttached(workspaceId: string): Promise<void> {
  for (const config of installedHostedAppMcps.values()) {
    await attachHostedMcpServer(workspaceId, config);
  }
}

// Reconcile the app-owned hosted-MCP set with what the renderer reports (on
// launch / catalog refresh): attach current, detach removed. Each config is
// built from an installed hostedMcpInstall app + its locally-stored creds.
async function syncHostedAppMcps(
  configs: MarketplaceMcpAttachConfig[],
): Promise<void> {
  const next = new Map(configs.map((config) => [config.id, config]));
  for (const id of installedHostedAppMcps.keys()) {
    if (!next.has(id)) {
      await detachCustomMcpServer(ROOT_WORKSPACE_ID, id);
    }
  }
  installedHostedAppMcps.clear();
  for (const [id, config] of next) {
    installedHostedAppMcps.set(id, config);
    await attachHostedMcpServer(ROOT_WORKSPACE_ID, config);
  }
}

// ── Custom (API-key) MCP servers — the OmniSocials-style install ──────────────
// An app's OWN external MCP server, authenticated by a user-supplied API key
// (passed as `?API_KEY=<key>`). We add it through the runtime's canonical
// mcp_connect capability — the SAME path the agent's `mcp_connect` tool uses —
// which upserts the server into workspace.yaml (durable across restarts, so no
// per-turn re-attach or separate key store is needed). There is no mcp_disconnect
// endpoint, so uninstall removes the server from workspace.yaml directly.

// How a user-supplied API key authenticates an app's MCP: a URL query param
// (OmniSocials `?API_KEY=<key>`) or a request header (Publora `Authorization:
// Bearer <key>`). Mirrors ApiKeyMcpAuth in the renderer (src/lib/holaAppMarketplace).
type CustomMcpAuth =
  | { kind: "query"; param: string }
  | { kind: "header"; name: string; prefix?: string };

// Validate the auth descriptor coming across IPC before we trust it.
function normalizeCustomMcpAuth(value: unknown): CustomMcpAuth | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const v = value as Record<string, unknown>;
  if (v.kind === "query" && typeof v.param === "string" && v.param) {
    return { kind: "query", param: v.param };
  }
  if (v.kind === "header" && typeof v.name === "string" && v.name) {
    return {
      kind: "header",
      name: v.name,
      ...(typeof v.prefix === "string" ? { prefix: v.prefix } : {}),
    };
  }
  return null;
}

// Build the authenticated request for an app's MCP: the key rides in a URL query
// param (OmniSocials) or a request header (Publora), per `auth`.
function buildCustomMcpAuthedRequest(
  mcpUrl: string,
  apiKey: string,
  auth: CustomMcpAuth,
): { url: string; headers: Record<string, string> } {
  if (auth.kind === "query") {
    const sep = mcpUrl.includes("?") ? "&" : "?";
    return {
      url: `${mcpUrl}${sep}${encodeURIComponent(auth.param)}=${encodeURIComponent(apiKey)}`,
      headers: {},
    };
  }
  return {
    url: mcpUrl,
    headers: { [auth.name]: `${auth.prefix ?? ""}${apiKey}` },
  };
}

// Pull a human error message out of an MCP/JSON-RPC error body — plain JSON or an
// SSE `data:` stream, `{ error: "msg" }` (Publora) or `{ error: { message } }`
// (OmniSocials). Null when the body carries no error.
function extractJsonRpcErrorMessage(text: string): string | null {
  const fromJson = (raw: string): string | null => {
    try {
      const err = (JSON.parse(raw) as { error?: unknown }).error;
      if (typeof err === "string" && err.trim()) {
        return err.trim();
      }
      const message = (err as { message?: unknown } | null)?.message;
      if (typeof message === "string" && message.trim()) {
        return message.trim();
      }
    } catch {
      // not plain JSON — could be an SSE stream; fall through
    }
    return null;
  };
  const direct = fromJson(text);
  if (direct) {
    return direct;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^data:\s*(.*)$/);
    if (match) {
      const parsed = fromJson(match[1]);
      if (parsed) {
        return parsed;
      }
    }
  }
  return null;
}

interface CustomMcpValidation {
  ok: boolean;
  toolCount?: number;
  error?: string;
}

// Verify a user-supplied API key BEFORE committing the attach: run the MCP
// initialize + tools/list handshake with the key. A rejected key answers 401 (or
// a JSON-RPC error) — both OmniSocials and Publora do — which we surface verbatim
// to the gate. Fails closed on a network error (never silently accepts a key we
// couldn't verify).
async function validateCustomMcpKey(
  mcpUrl: string,
  apiKey: string,
  auth: CustomMcpAuth,
): Promise<CustomMcpValidation> {
  const { url, headers: authHeaders } = buildCustomMcpAuthedRequest(
    mcpUrl,
    apiKey,
    auth,
  );
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...authHeaders,
  };
  const errorFrom = async (resp: Response): Promise<string> => {
    const text = await resp.text().catch(() => "");
    return (
      extractJsonRpcErrorMessage(text) ?? `That key was rejected (${resp.status}).`
    );
  };
  try {
    const init = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "holaboss-desktop", version: "0.0.0" },
        },
      }),
    });
    if (!init.ok) {
      return { ok: false, error: await errorFrom(init) };
    }
    const sessionId = init.headers.get("mcp-session-id") ?? undefined;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });
    if (!resp.ok) {
      return { ok: false, error: await errorFrom(resp) };
    }
    const text = await resp.text();
    const rpcError = extractJsonRpcErrorMessage(text);
    if (rpcError) {
      return { ok: false, error: rpcError };
    }
    return { ok: true, toolCount: parseMcpToolsListResponse(text).length };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error
          ? `Couldn't reach ${mcpUrl}: ${err.message}`
          : "Couldn't reach the MCP server to verify the key.",
    };
  }
}

// Connect an app's external MCP server via the runtime's mcp_connect capability.
// The key rides in a URL query param or a request header per `auth`. The server
// is written to workspace.yaml; its tools apply on the agent's NEXT turn. Throws
// (surfaced to the gate) if the runtime rejects the request.
async function attachCustomMcpServer(
  workspaceId: string,
  appId: string,
  mcpUrl: string,
  apiKey: string,
  auth: CustomMcpAuth,
): Promise<void> {
  const { url, headers } = buildCustomMcpAuthedRequest(mcpUrl, apiKey, auth);
  await requestWorkspaceRuntimeJson(workspaceId, {
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/mcp/connect",
    payload: {
      name: appId,
      url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      // Owned by this app container → runtime writes it to app_servers.
      owner_app_id: appId,
      workspace_id: workspaceId,
    },
    retryTransientErrors: true,
  });
  console.log(`[custom-mcp] connected '${appId}' via mcp_connect (${auth.kind})`);
}

// Remove a custom MCP server from workspace.yaml (uninstall). There is no
// runtime mcp_disconnect, so edit the config directly (mirrors detachWebHolaAppMcp).
async function detachCustomMcpServer(
  workspaceId: string,
  appId: string,
): Promise<void> {
  try {
    const workspaceDir = await resolveWorkspaceDir(workspaceId);
    const yamlPath = path.join(workspaceDir, "workspace.yaml");
    if (!existsSync(yamlPath)) {
      return;
    }
    const data = asYamlRecord(parseYaml(await fs.readFile(yamlPath, "utf-8")));
    const registry = asYamlRecord(data.mcp_registry);
    const servers = asYamlRecord(registry.servers);
    const appServers = asYamlRecord(registry.app_servers);
    const inServers = appId in servers;
    const inAppServers = appId in appServers;
    if (!inServers && !inAppServers) {
      return;
    }
    // App-owned server lives in app_servers now; legacy installs may be in the
    // standalone `servers` pool — clear both.
    if (inServers) {
      delete servers[appId];
      registry.servers = servers;
    }
    if (inAppServers) {
      delete appServers[appId];
      registry.app_servers = appServers;
    }
    const allowlist = asYamlRecord(registry.allowlist);
    if (Array.isArray(allowlist.tool_ids)) {
      allowlist.tool_ids = allowlist.tool_ids.filter(
        (id) => typeof id === "string" && !id.startsWith(`${appId}.`),
      );
      registry.allowlist = allowlist;
    }
    data.mcp_registry = registry;
    await fs.writeFile(
      yamlPath,
      `${stringifyYaml(data, { defaultStringType: "QUOTE_DOUBLE" }).trimEnd()}\n`,
      "utf-8",
    );
    console.log(`[custom-mcp] detached '${appId}' in ${yamlPath}`);
  } catch (err) {
    console.warn(`[custom-mcp] failed to detach ${appId}:`, err);
  }
}

// ── Command/stdio MCP servers — the drawio-style install ──────────────────────
// An app whose tools come from a LOCAL MCP server the runtime spawns (drawio:
// `npx @next-ai-drawio/mcp-server`, which also serves an embedded draw.io editor
// over HTTP). Attached through the SAME mcp_connect capability as the api-key
// servers, but with a `command` (+ env) instead of a url. Two desktop concerns:
//
//   1. Suppress + capture the browser popup. The drawio server's `start_session`
//      tool calls `open(<editorUrl>)` to pop the editor in the user's SYSTEM
//      browser. We redirect that into the in-app surface: a PATH shim (scoped to
//      the drawio process only) replaces `open`/`xdg-open` with a script that
//      writes the URL to a capture file and exits — no system browser. Main
//      watches the file and navigates the app's surface BrowserView to the
//      captured URL (a live editor session bound to the agent's diagram).
//   2. The editor HTTP server only starts when the agent calls start_session
//      (not at server boot), so before the first draw the surface shows a
//      "ready" placeholder rather than a connection-refused error.

// Command/stdio-MCP app ids attached this session (drives capture routing +
// uninstall teardown). Only drawio today.
const commandMcpAppIds = new Set<string>();
// Latest editor URL captured from the drawio server's suppressed `open()`. Kept
// in-memory (reset per launch) so a stale port from a prior session is never
// loaded on a cold surface open. Single value — one command-MCP app exists today;
// revisit if a second local-editor app is added (capture carries no app id).
let latestCommandMcpEditorUrl: string | null = null;
let commandMcpShim: { dir: string; captureFile: string } | null = null;
let commandMcpCaptureWatcher: FSWatcher | null = null;

// A minimal "ready" surface shown until the agent starts a live editor session.
const COMMAND_MCP_PLACEHOLDER_URL = `data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{height:100%;margin:0}
    body{display:flex;align-items:center;justify-content:center;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      background:#0b0b0c;color:#e7e7ea}
    .card{text-align:center;max-width:26rem;padding:2rem}
    h1{font-size:1.05rem;font-weight:600;margin:0 0 .5rem}
    p{font-size:.85rem;line-height:1.5;color:#9a9aa2;margin:0}
  </style></head><body><div class="card">
    <h1>draw.io is ready</h1>
    <p>Ask the agent to sketch a flowchart or diagram — it'll open here and update live as it draws.</p>
  </div></body></html>`,
)}`;

function isLocalhostSurfaceUrl(url: string): boolean {
  return /^http:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/.test(url);
}

// Create (once) the PATH shim that intercepts the drawio server's browser-open.
// The shim scripts write any http://localhost URL passed to `open`/`xdg-open`
// into the capture file and exit 0 (suppressing the real browser). Returns the
// shim dir (prepended to the drawio process's PATH) + capture file path; main
// watches the capture file and navigates the surface on change.
function ensureCommandMcpOpenShim(): { dir: string; captureFile: string } {
  if (commandMcpShim) {
    return commandMcpShim;
  }
  const dir = path.join(app.getPath("userData"), "command-mcp-open-shim");
  mkdirSync(dir, { recursive: true });
  const captureFile = path.join(dir, "captured-url");
  // POSIX sh: capture only localhost URLs (the editor) and always exit 0 so the
  // drawio process's open() resolves without launching anything.
  const script = [
    "#!/bin/sh",
    "# Holaboss: suppress the drawio MCP server's system-browser popup and capture",
    "# the editor URL so the desktop loads it into the in-app draw.io surface.",
    `capture=${JSON.stringify(captureFile)}`,
    'for arg in "$@"; do',
    "  case \"$arg\" in",
    '    http://localhost:*|http://127.0.0.1:*) printf "%s" "$arg" > "$capture" ;;',
    "  esac",
    "done",
    "exit 0",
    "",
  ].join("\n");
  for (const name of ["open", "xdg-open"]) {
    writeFileSync(path.join(dir, name), script, { mode: 0o755 });
  }
  // Watch the DIR (watching a not-yet-created file is unreliable) and react to
  // writes of the capture file. fs.watch fires on each write even if unchanged.
  try {
    commandMcpCaptureWatcher = watch(dir, (_event, filename) => {
      if (filename && filename !== "captured-url") {
        return;
      }
      try {
        if (!existsSync(captureFile)) {
          return;
        }
        const url = readFileSync(captureFile, "utf8").trim();
        if (url && isLocalhostSurfaceUrl(url)) {
          onCommandMcpEditorUrl(url);
        }
      } catch (err) {
        console.warn("[command-mcp] failed to read captured url:", err);
      }
    });
  } catch (err) {
    console.warn("[command-mcp] failed to watch shim dir:", err);
  }
  commandMcpShim = { dir, captureFile };
  return commandMcpShim;
}

// The drawio server opened an editor session; navigate every open command-MCP
// surface to the live URL (only drawio today). Skips when unchanged so repeated
// identical capture writes don't re-navigate.
function onCommandMcpEditorUrl(url: string): void {
  if (url === latestCommandMcpEditorUrl) {
    return;
  }
  latestCommandMcpEditorUrl = url;
  console.log(`[command-mcp] captured editor url ${url}`);
  for (const appId of commandMcpAppIds) {
    const view = appSurfaceViews.get(webHolaAppSurfaceKey(appId));
    if (view && !view.webContents.isDestroyed()) {
      view.webContents.loadURL(url).catch((err) => {
        console.warn(`[command-mcp] failed to navigate ${appId} surface:`, err);
      });
    }
  }
}

// The surface URL for a command-MCP app: the live editor session if captured,
// else the "ready" placeholder — never the bare local port, which is
// connection-refused until the agent's first start_session brings the editor up.
function commandMcpSurfaceUrl(): string {
  return latestCommandMcpEditorUrl ?? COMMAND_MCP_PLACEHOLDER_URL;
}

// Attach a local (stdio) MCP server via the runtime's mcp_connect capability.
// The `command` argv + `env` come from the catalog's commandMcpInstall. A scoped
// PATH shim is added to env so ONLY this server's browser-open is intercepted
// (not the runtime's other open() calls); npx stays resolvable via the
// login-shell PATH already applied to process.env (applyLoginShellPathToEnv).
// Idempotent (mcp_connect upserts the workspace.yaml entry).
async function attachCommandMcpServer(
  workspaceId: string,
  appId: string,
  command: string[],
  env: Record<string, string>,
): Promise<void> {
  const shim = ensureCommandMcpOpenShim();
  const scopedEnv: Record<string, string> = {
    ...env,
    PATH: `${shim.dir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  await requestWorkspaceRuntimeJson(workspaceId, {
    method: "POST",
    path: "/api/v1/capabilities/runtime-tools/mcp/connect",
    payload: {
      name: appId,
      command,
      env: scopedEnv,
      // Owned by this app container → runtime writes it to app_servers.
      owner_app_id: appId,
      workspace_id: workspaceId,
    },
    retryTransientErrors: true,
  });
  commandMcpAppIds.add(appId);
  console.log(`[command-mcp] connected '${appId}' (${command.join(" ")})`);
}

// Host bridge op: open/create a chat session for the calling surface's
// workspace, then hand off to the shell renderer (HOST_RENDERER_EVENT) to open
// it + prefill the composer with the prompt + app-context attachments.
// See docs/plans/2026-06-23-holaapp-desktop-host-bridge.md.
async function hostChatStart(
  identity: { appId: string; workspaceId?: string },
  input: ChatStartInput,
): Promise<HostResult<ChatStartResult>> {
  try {
    // Local app-builder surfaces carry their workspace id; web HolaApps don't
    // (the single-tenant runtime resolves it server-side from ROOT_WORKSPACE_ID).
    const { session } = await createWorkspaceMainSession(
      identity.workspaceId ?? ROOT_WORKSPACE_ID,
      {
        title: typeof input.title === "string" ? input.title : null,
        // Stamp the calling surface's HolaApp so this chat is owned by that app
        // (listed under its sidebar row + tool-scoped), not leaked into General.
        // A system surface (HolaHub) can opt into a General session instead —
        // its hand-off has no app row to live under.
        app_id: input.general ? null : identity.appId,
        // Every HolaApp hand-off defaults to continuing the app's existing chat
        // so the conversation + context build in one place; an app must pass
        // newSession:true (e.g. onboarding a brand-new fund) to force a fresh
        // session. Omitted → reuse. The generic create-session IPC never sets
        // this, so ordinary "New chat" flows still create fresh sessions.
        new_session: input.newSession ?? false,
      },
    );
    const sessionId = session?.session_id;
    if (!sessionId) {
      return { ok: false, error: "session_create_failed" };
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(HOST_RENDERER_EVENT, {
        session,
        input,
        sourceAppId: identity.appId,
      });
    }
    return { ok: true, data: { sessionId } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// A desktop output the shell (ChatPane) staged to share to HolaHub. Set by the
// trusted shell→main IPC (holahub:stage-share); the HolaHub web surface reads it
// via the `holahub.consume-pending-share` op to prefill its composer. Read is
// idempotent — the next stageShare overwrites it, so each share sees its own.
let pendingHolahubShare: ShareDraft | null = null;

// Host op `item.open`: a hosted page (HolaHub) asks the desktop to open an
// already-installed item. A holaapp opens its own surface — we hand off to the
// shell renderer (HOST_OPEN_APP_EVENT), which resolves the full app definition
// from the catalog by ref and opens it. A skill/mcp/capability has no surface, so
// we open a General chat where the installed capability is available (reusing the
// chat-start flow). See docs/plans/2026-06-23-holaapp-desktop-host-bridge.md.
async function hostItemOpen(
  identity: { appId: string; workspaceId?: string },
  input: OpenItemInput,
): Promise<HostResult<OpenItemResult>> {
  const ref = typeof input?.ref === "string" ? input.ref.trim() : "";
  if (!ref) {
    return { ok: false, error: "missing_ref" };
  }
  if (input.type === "holaapp") {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { ok: false, error: "no_window" };
    }
    mainWindow.webContents.send(HOST_OPEN_APP_EVENT, { ref });
    return { ok: true, data: { opened: true } };
  }
  // A skill/mcp/capability has no surface: open a fresh General chat AND carry
  // the item into that chat's composer, so "open" visibly lands the capability
  // where the user can prompt with it (rather than a bare empty chat). The item
  // is already installed, so the agent has it available.
  //
  // A skill is quoted as a real skill chip (skillIds) — its ref IS the workspace
  // skill_id. An mcp/capability has no composer chip, so it rides in as a context
  // pill instead.
  const title =
    typeof input.title === "string" && input.title.trim()
      ? input.title.trim()
      : ref;
  const started = await hostChatStart(
    identity,
    input.type === "skill"
      ? { general: true, newSession: true, skillIds: [ref] }
      : {
          general: true,
          newSession: true,
          context: [
            {
              app: "holahub",
              kind: input.type,
              title,
              refs: { ref, type: input.type },
            },
          ],
        },
  );
  if (!started.ok) {
    return started;
  }
  return { ok: true, data: { opened: true } };
}

// Host op `install`: a hosted page (HolaHub) asks the desktop to install a
// catalog item. We hand it to the shell renderer's headless installer
// (HOST_INSTALL_EVENT), which installs keyless items IN PLACE (no navigation)
// and opens the native connect surface for keyed/gated ones. It replies with the
// real outcome via HOST_INSTALL_RESULT, which we relay back to the invoking page
// so its button can show Installing → Installed / Connect. Request/response,
// correlated by requestId, with a timeout backstop.
const pendingInstalls = new Map<
  string,
  { resolve: (result: InstallResult) => void; timer: ReturnType<typeof setTimeout> }
>();
let installRequestSeq = 0;
const INSTALL_TIMEOUT_MS = 90_000;

function settleInstall(requestId: string, result: InstallResult): void {
  const pending = pendingInstalls.get(requestId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingInstalls.delete(requestId);
  pending.resolve(result);
}

function hostInstall(
  identity: { appId: string; workspaceId?: string },
  input: InstallInput,
): Promise<HostResult<InstallResult>> {
  const type = input?.type;
  const ref = typeof input?.ref === "string" ? input.ref.trim() : "";
  const allowed = ["skill", "mcp", "holaapp", "capability"];
  if (!(ref && allowed.includes(type))) {
    return Promise.resolve({ ok: false, error: "install requires { type, ref }" });
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    return Promise.resolve({ ok: false, error: "no_main_window" });
  }
  installRequestSeq += 1;
  const requestId = `install-${installRequestSeq}`;
  return new Promise<HostResult<InstallResult>>((resolve) => {
    const timer = setTimeout(() => {
      pendingInstalls.delete(requestId);
      resolve({ ok: true, data: { status: "error", message: "install timed out" } });
    }, INSTALL_TIMEOUT_MS);
    pendingInstalls.set(requestId, {
      resolve: (result) => resolve({ ok: true, data: result }),
      timer,
    });
    mainWindow?.webContents.send(HOST_INSTALL_EVENT, {
      requestId,
      type,
      ref,
      ...(input?.values ? { values: input.values } : {}),
      sourceAppId: identity.appId,
    });
  });
}

// install.status — a hosted page asks what's installed so it can show "Installed"
// instead of offering "Install" again. The shell renderer is authoritative: it
// reports skills, MCPs, capabilities AND the full HolaApp set (from the catalog's
// backend `installed` flags). `installedAppItems()` here is only a best-effort
// fallback for when there's no renderer / the ask times out. Request/response by
// requestId with a short timeout backstop (it's just a read).
const pendingStatuses = new Map<
  string,
  { resolve: (list: InstalledList) => void; timer: ReturnType<typeof setTimeout> }
>();
let statusRequestSeq = 0;
const STATUS_TIMEOUT_MS = 8_000;

// Fallback only: the HolaApps main tracks in `installedHolaAppIds` — a SUBSET
// (Holaboss-hosted `/mcp/<id>` apps; external / api-key apps are excluded), so this
// is used solely when the renderer can't answer.
function installedAppItems(): InstalledItem[] {
  return [...installedHolaAppIds].map((id) => ({
    type: "holaapp" as const,
    ref: id,
  }));
}

function settleInstallStatus(requestId: string, list: InstalledList): void {
  const pending = pendingStatuses.get(requestId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingStatuses.delete(requestId);
  pending.resolve(list);
}

function hostInstallStatus(): Promise<HostResult<InstalledList>> {
  // No renderer to ask → still report the apps main knows about.
  if (!mainWindow || mainWindow.isDestroyed()) {
    return Promise.resolve({ ok: true, data: { items: installedAppItems() } });
  }
  statusRequestSeq += 1;
  const requestId = `status-${statusRequestSeq}`;
  return new Promise<HostResult<InstalledList>>((resolve) => {
    const timer = setTimeout(() => {
      pendingStatuses.delete(requestId);
      resolve({ ok: true, data: { items: installedAppItems() } });
    }, STATUS_TIMEOUT_MS);
    pendingStatuses.set(requestId, {
      // The renderer already includes the full HolaApp set — take its list as-is.
      resolve: (list) => resolve({ ok: true, data: { items: list.items } }),
      timer,
    });
    mainWindow?.webContents.send(HOST_INSTALL_STATUS_EVENT, { requestId });
  });
}

// employees.changed — the `/employees` surface tells us its roster changed after
// a create/rename/archive. Fire-and-forget: nudge the shell renderer to refetch
// its roster query (the surface's gateway writes never touch this bridge, so the
// sidebar can't otherwise know). No result to wait on — resolve immediately.
function hostEmployeesChanged(
  _input: EmployeesChangedInput,
): HostResult<Record<string, never>> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(HOST_EMPLOYEES_CHANGED_EVENT);
  }
  return { ok: true, data: {} };
}


// Resolve a HolaApp session's own Electron app-surface webContents (the view the
// user is looking at). Tries the raw app id and the web-HolaApp surface key.
// Returns null when the surface isn't open or has been torn down.
function appSurfaceDriveWebContents(appId: string): Electron.WebContents | null {
  const id = (appId || "").trim();
  if (!id) {
    return null;
  }
  const view =
    appSurfaceViews.get(id) ?? appSurfaceViews.get(webHolaAppSurfaceKey(id));
  const wc = view?.webContents;
  if (!wc || wc.isDestroyed()) {
    return null;
  }
  return wc;
}

function appSurfacePageInfo(wc: Electron.WebContents): {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
} {
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
  };
}

function requireAppSurfaceWebContents(appId: string): Electron.WebContents {
  const wc = appSurfaceDriveWebContents(appId);
  if (!wc) {
    throw new Error("The app surface is not open.");
  }
  return wc;
}

// Renderer-→runtime browser HTTP service. The route handler lives in
// browser-pane/http-service.ts; here we just wire deps. Server lifecycle
// (start/stop, auth-token rotation, capability config sync) stays in
// main.ts.
const browserHttpService: BrowserHttpService = createBrowserHttpService({
  getActiveWorkspaceId: () => activeBrowserWorkspaceId,
  listBrowserProfiles: () => {
    const defaultId = resolveDefaultBrowserProfileId(browserProfileIndex);
    return listBrowserProfiles().map((profile) => ({
      id: profile.id,
      name: profile.name,
      running: runningProfileChromiumIds().includes(profile.id),
      isDefault: profile.id === defaultId,
    }));
  },
  launchBrowserProfile: (profileId) => launchProfileChromium(profileId),
  closeBrowserProfile: (profileId) => closeProfileChromium(profileId),
  // When a browser tool names no profile, drive the user's pinned "default
  // browser" (set on the Browsers page). The pin defaults to the permanent
  // profile until the user re-points it, so this is authoritative — it replaces
  // the old sole/first-running guess. (For identity-sensitive tasks the agent
  // should still name/ask per the profile tool prompts.)
  defaultBrowserProfileId: () =>
    resolveDefaultBrowserProfileId(browserProfileIndex) ??
    DEFAULT_BROWSER_PROFILE_ID,
  // Full-parity agent drive: when a profile has a LIVE spawned Chromium, the
  // control service routes its low-level ops to that real window over CDP
  // instead of the embedded Electron BrowserView.
  profileCdp: {
    isLive: (profileId) =>
      engineRunningIds.has(profileId) || profileChromiumPort(profileId) !== null,
    // Auto-launch on first drive: a browser tool targeting a not-yet-running
    // profile spawns its real Chromium (or, for a cloak profile, starts it in the
    // fingerprint service), so browsing always drives a profile window. Land on
    // about:blank (not HOME_URL) so the first drive CLAIMS that blank landing tab
    // (see profile-cdp / service `activePage`) instead of opening a second tab and
    // leaving a stray home page behind.
    ensureLive: async (profileId) => {
      if (!isBrowserProfileId(profileId)) {
        return false;
      }
      // Engine (cloak) profile → run through the fingerprint service.
      if (engineRunningIds.has(profileId)) {
        return true;
      }
      if (getBrowserProfile(browserProfileIndex, profileId)?.engine === "fingerprint") {
        const result = await launchProfileChromium(profileId, "about:blank");
        return result.ok && engineRunningIds.has(profileId);
      }
      const trackedPort = profileChromiumPort(profileId);
      if (trackedPort !== null) {
        // A SPAWNED instance we own is trustworthy. An ADOPTED instance
        // (proc:null) counts as running forever, so relaunch only when its port is
        // DEFINITIVELY refused — never on a transient stall.
        const instance = profileChromeInstances.get(profileId);
        const staleAdopted =
          instance?.proc === null &&
          (await profileDebugPortRefused(trackedPort));
        if (!staleAdopted) {
          return true;
        }
        logProfileChrome(
          `ensureLive ${profileId}: adopted port ${trackedPort} refused (chrome gone) → drop + relaunch`,
        );
        profileChromeInstances.delete(profileId);
        disconnectProfileCdp(profileId);
        emitProfilesRunning();
      }
      const result = await launchProfileChromium(profileId, "about:blank");
      return result.ok && profileChromiumPort(profileId) !== null;
    },
    openTab: (profileId, url, sessionId) => {
      if (engineRunningIds.has(profileId)) {
        return fingerprintServiceOrThrow().openTab(profileId, url, sessionId);
      }
      const port = profileChromiumPort(profileId);
      if (port === null) {
        throw new Error("The profile browser is not running.");
      }
      return profileCdpOpenTab(profileId, port, url, sessionId);
    },
    evaluate: (profileId, expression, sessionId) => {
      if (engineRunningIds.has(profileId)) {
        return fingerprintServiceOrThrow().evaluate(profileId, expression, sessionId);
      }
      const port = profileChromiumPort(profileId);
      if (port === null) {
        throw new Error("The profile browser is not running.");
      }
      return profileCdpEvaluate(profileId, port, expression, sessionId);
    },
    pageInfo: (profileId, sessionId) => {
      if (engineRunningIds.has(profileId)) {
        return fingerprintServiceOrThrow().pageInfo(profileId, sessionId);
      }
      const port = profileChromiumPort(profileId);
      if (port === null) {
        throw new Error("The profile browser is not running.");
      }
      return profileCdpPageInfo(profileId, port, sessionId);
    },
    navigate: (profileId, url, sessionId) => {
      if (engineRunningIds.has(profileId)) {
        return fingerprintServiceOrThrow().navigate(profileId, url, sessionId);
      }
      const port = profileChromiumPort(profileId);
      if (port === null) {
        throw new Error("The profile browser is not running.");
      }
      return profileCdpNavigate(profileId, port, url, sessionId);
    },
    screenshot: (profileId, options, sessionId) => {
      if (engineRunningIds.has(profileId)) {
        return fingerprintServiceOrThrow().screenshot(profileId, options, sessionId);
      }
      const port = profileChromiumPort(profileId);
      if (port === null) {
        throw new Error("The profile browser is not running.");
      }
      return profileCdpScreenshot(profileId, port, options, sessionId);
    },
    mouse: (profileId, x, y, action, sessionId) => {
      if (engineRunningIds.has(profileId)) {
        return fingerprintServiceOrThrow().mouse(profileId, x, y, action, sessionId);
      }
      const port = profileChromiumPort(profileId);
      if (port === null) {
        throw new Error("The profile browser is not running.");
      }
      return profileCdpMouse(profileId, port, x, y, action, sessionId);
    },
    keyboard: (profileId, options, sessionId) => {
      if (engineRunningIds.has(profileId)) {
        return fingerprintServiceOrThrow().keyboard(profileId, options, sessionId);
      }
      const port = profileChromiumPort(profileId);
      if (port === null) {
        throw new Error("The profile browser is not running.");
      }
      return profileCdpKeyboard(profileId, port, options, sessionId);
    },
    cookies: (profileId, filter, sessionId) => {
      if (engineRunningIds.has(profileId)) {
        return fingerprintServiceOrThrow().cookies(profileId, filter, sessionId);
      }
      const port = profileChromiumPort(profileId);
      if (port === null) {
        throw new Error("The profile browser is not running.");
      }
      return profileCdpCookies(profileId, port, filter, sessionId);
    },
    setCookie: (profileId, cookie) => {
      if (engineRunningIds.has(profileId)) {
        return fingerprintServiceOrThrow().setCookie(
          profileId,
          cookie as Record<string, unknown>,
        );
      }
      const port = profileChromiumPort(profileId);
      if (port === null) {
        throw new Error("The profile browser is not running.");
      }
      return profileCdpSetCookie(profileId, port, cookie);
    },
  },
  // App-surface driver: same contract as profileCdp but the "profileId" is a
  // HolaApp id, and every op runs against that app's own Electron BrowserView
  // (the surface the user sees) via webContents — not a separate Chromium.
  appSurfaceCdp: {
    isLive: (appId) => appSurfaceDriveWebContents(appId) !== null,
    // App surfaces are opened by the app UI, not launched here — "live" simply
    // means the view exists and is not destroyed.
    ensureLive: async (appId) => appSurfaceDriveWebContents(appId) !== null,
    openTab: async (appId, url) => {
      // No tabs in an app surface: navigate the single view and report it.
      const wc = requireAppSurfaceWebContents(appId);
      await wc.loadURL(url);
      return appSurfacePageInfo(wc);
    },
    evaluate: async (appId, expression) =>
      requireAppSurfaceWebContents(appId).executeJavaScript(expression, true),
    pageInfo: async (appId) => appSurfacePageInfo(requireAppSurfaceWebContents(appId)),
    navigate: async (appId, url) => {
      await requireAppSurfaceWebContents(appId).loadURL(url);
    },
    screenshot: async (appId, options) => {
      const image = await requireAppSurfaceWebContents(appId).capturePage();
      return options.format === "jpeg"
        ? image.toJPEG(typeof options.quality === "number" ? options.quality : 80)
        : image.toPNG();
    },
    mouse: async (appId, x, y, action) => {
      const wc = requireAppSurfaceWebContents(appId);
      const button = action === "context" ? "right" : "left";
      if (action === "hover") {
        wc.sendInputEvent({ type: "mouseMove", x, y });
        return;
      }
      const clickCount = action === "double_click" ? 2 : 1;
      wc.sendInputEvent({ type: "mouseDown", x, y, button, clickCount });
      wc.sendInputEvent({ type: "mouseUp", x, y, button, clickCount });
    },
    keyboard: async (appId, options) => {
      const wc = requireAppSurfaceWebContents(appId);
      if (options.action === "insert_text" && typeof options.text === "string") {
        if (options.clear) {
          const mod = process.platform === "darwin" ? "cmd" : "control";
          wc.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers: [mod] });
          wc.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers: [mod] });
          wc.sendInputEvent({ type: "keyDown", keyCode: "Delete" });
          wc.sendInputEvent({ type: "keyUp", keyCode: "Delete" });
        }
        for (const ch of options.text) {
          wc.sendInputEvent({ type: "char", keyCode: ch });
        }
        if (options.submit) {
          wc.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
          wc.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
        }
        return;
      }
      if (options.action === "press" && options.key) {
        wc.sendInputEvent({ type: "keyDown", keyCode: options.key });
        wc.sendInputEvent({ type: "keyUp", keyCode: options.key });
      }
    },
    cookies: async (appId, filter) => {
      const wc = requireAppSurfaceWebContents(appId);
      const list = await wc.session.cookies.get({
        url: filter.url,
        name: filter.name,
        domain: filter.domain,
      });
      return list.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain ?? "",
        path: cookie.path ?? "/",
        secure: cookie.secure ?? false,
        httpOnly: cookie.httpOnly ?? false,
        session: cookie.session ?? false,
        sameSite: cookie.sameSite ?? "unspecified",
        expirationDate:
          typeof cookie.expirationDate === "number" ? cookie.expirationDate : null,
      }));
    },
    setCookie: async (appId, cookie) => {
      const wc = requireAppSurfaceWebContents(appId);
      await wc.session.cookies.set({
        url: cookie.url ?? `https://${cookie.domain ?? ""}`,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite
          ? (cookie.sameSite.toLowerCase() as "unspecified" | "no_restriction" | "lax" | "strict")
          : undefined,
        expirationDate: cookie.expires,
      });
    },
  },
  getAuthToken: () => desktopBrowserServiceAuthToken,
  homeUrl: HOME_URL,
  browserSpaceId: (value, fallback) => browserSpaceId(value, fallback),
  operatorSurfaceContextPayload: (workspaceId) =>
    operatorSurfaceContextPayload(workspaceId),
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

const TABLE_FILE_EXTENSIONS = new Set([".csv", ".tsv", ".xlsx", ".xlsm", ".xls", ".ods"]);
const PREVIEW_STRIPPABLE_WORKSHEET_RELATIONSHIP_TYPES = new Set([
  "comments",
  "drawing",
  "vmlDrawing",
]);
const PRESENTATION_FILE_EXTENSIONS = new Set([".pptx"]);

const DOCUMENT_FILE_EXTENSIONS = new Set([".docx"]);

const MAX_DOCUMENT_PREVIEW_BYTES = 5 * 1024 * 1024;

const MAX_DOCX_EDIT_BYTES = 25 * 1024 * 1024;

const IMAGE_FILE_MIME_TYPES = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".bmp", "image/bmp"],
]);

const VIDEO_FILE_MIME_TYPES = new Map<string, string>([
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
  [".ogv", "video/ogg"],
]);

const PDF_FILE_MIME_TYPES = new Map<string, string>([
  [".pdf", "application/pdf"],
]);

const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024 * 2;
const MAX_IMAGE_PREVIEW_BYTES = 1024 * 1024 * 12;
// Generated clips are short but a few MB; cap so a huge file doesn't blow up
// the data-URL preview.
const MAX_VIDEO_PREVIEW_BYTES = 1024 * 1024 * 64;
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
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === "string") {
      return obj.text;
    }
    if (typeof obj.text === "function") {
      const textValue = (obj.text as () => unknown)();
      return typeof textValue === "string" ? textValue : String(textValue ?? "");
    }
    if ("result" in obj && obj.result !== undefined && obj.result !== null) {
      return toPreviewTableCellValue(obj.result);
    }
    if (Array.isArray(obj.richText)) {
      return obj.richText
        .map((segment) => {
          if (segment && typeof segment === "object" && "text" in segment) {
            const segmentText = (segment as { text?: unknown }).text;
            return typeof segmentText === "string" ? segmentText : "";
          }
          return "";
        })
        .join("");
    }
    if ("formula" in obj && typeof obj.formula === "string") {
      return "";
    }
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

function readWorksheetCellDisplayText(cell: ExcelJSCell): string {
  const value = cell.value;
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    const obj = value as unknown as Record<string, unknown>;
    if (typeof obj.hyperlink === "string" && typeof obj.text === "string") {
      return obj.text;
    }
    if ("formula" in obj || "sharedFormula" in obj) {
      if (obj.result !== undefined && obj.result !== null) {
        return toPreviewTableCellValue(obj.result);
      }
      return "";
    }
    if (Array.isArray(obj.richText)) {
      return toPreviewTableCellValue(value);
    }
    if ("error" in obj) {
      return typeof obj.error === "string" ? obj.error : "";
    }
  }
  if (typeof cell.text === "string" && cell.text.length > 0) {
    return cell.text;
  }
  return toPreviewTableCellValue(value);
}

function readWorksheetCellHyperlink(cell: ExcelJSCell): string | null {
  const value = cell.value;
  if (value && typeof value === "object") {
    const obj = value as unknown as Record<string, unknown>;
    if (typeof obj.hyperlink === "string") {
      return obj.hyperlink;
    }
  }
  if (typeof cell.hyperlink === "string" && cell.hyperlink.length > 0) {
    return cell.hyperlink;
  }
  return null;
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

function worksheetPreviewRows(worksheet: ExcelJSWorksheet): {
  rows: string[][];
  links: (string | null)[][];
} {
  const rows: string[][] = [];
  const links: (string | null)[][] = [];

  const rowCount = worksheet.rowCount;
  const columnCount = worksheet.columnCount;

  for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
    const row = worksheet.getRow(rowIndex);
    const values: string[] = [];
    const rowLinks: (string | null)[] = [];
    for (let columnIndex = 1; columnIndex <= columnCount; columnIndex += 1) {
      const cell = row.getCell(columnIndex);
      const displayValue = readWorksheetCellDisplayText(cell);
      const hyperlinkValue = readWorksheetCellHyperlink(cell);
      values.push(displayValue);
      rowLinks.push(
        normalizePreviewTableLinkTarget(hyperlinkValue ?? displayValue),
      );
    }
    const trimmedValues = trimTrailingEmptyTableCells(values);
    rows.push(trimmedValues);
    links.push(trimTrailingEmptyTableLinkRow(rowLinks, trimmedValues.length));
  }

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
  worksheet: ExcelJSWorksheet,
  sheet: FilePreviewTableSheetPayload,
) {
  const sourceRows = sourceRowsFromTablePreviewSheet(sheet);
  const sourceLinks = sourceLinksFromTablePreviewSheet(sheet);
  for (const [rowIndex, row] of sourceRows.entries()) {
    for (const [columnIndex, value] of row.entries()) {
      const cell = worksheet.getCell(rowIndex + 1, columnIndex + 1);
      const hyperlink = sourceLinks[rowIndex]?.[columnIndex] ?? null;
      if (hyperlink) {
        cell.value = { text: value, hyperlink };
      } else {
        cell.value = value;
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

async function loadExcelJSWorkbook(buffer: Buffer): Promise<ExcelJSWorkbook> {
  const workbook = new ExcelJS.Workbook();
  await (workbook.xlsx.load as unknown as (
    data: Uint8Array,
  ) => Promise<ExcelJSWorkbook>)(buffer);
  return workbook;
}

async function writeWorkbookTablePreview(
  absolutePath: string,
  buffer: Buffer,
  tableSheets: FilePreviewTableSheetPayload[],
): Promise<void> {
  const workbook = await loadExcelJSWorkbook(buffer);

  for (const sheet of tableSheets) {
    const worksheet = workbook.worksheets[sheet.index];
    if (!worksheet) {
      continue;
    }
    applyPreviewSheetEditsToWorksheet(worksheet, sheet);
  }

  const outputBuffer = await workbook.xlsx.writeBuffer();
  await fs.writeFile(absolutePath, workbookOutputToBuffer(outputBuffer));
}

async function buildWorkbookPreviewSheets(
  buffer: Buffer,
): Promise<FilePreviewTableSheetPayload[]> {
  const workbook = await loadExcelJSWorkbook(buffer);
  const worksheets = workbook.worksheets;

  return worksheets.slice(0, MAX_TABLE_PREVIEW_SHEETS).map((worksheet, sheetIndex) => {
    const preview = worksheetPreviewRows(worksheet);
    return tablePreviewSheetFromRows(
      worksheet.name,
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

// Full-fidelity snapshot for the Univer preview surface. Best-effort: any parse
// failure returns undefined and the renderer falls back to the flattened
// `tableSheets` legacy grid.
async function buildUniverSnapshotForPreview(
  buffer: Buffer,
  extension: string,
  name: string,
): Promise<IWorkbookData | undefined> {
  try {
    if (extension === ".csv") {
      const rows = parseCsvRows(buffer.toString("utf8").replace(/^\uFEFF/, ""));
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet("Sheet1");
      for (const row of rows) {
        worksheet.addRow(row);
      }
      return buildUniverWorkbookSnapshot(workbook, { name });
    }
    const workbook = await loadExcelJSWorkbook(buffer);
    return buildUniverWorkbookSnapshot(workbook, { name });
  } catch {
    return undefined;
  }
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

// Three-tier docx → HTML pipeline. Each tier is more tolerant and less
// faithful than the previous; we drop to the next one when the current
// returns empty so apps that emit non-Microsoft-shaped OOXML (Pages,
// LibreOffice, agent-generated files) still render their text.
async function renderDocumentBufferToHtml(buffer: Buffer): Promise<string> {
  // Tier 1: mammoth.convertToHtml — preserves headings, lists, tables.
  const htmlResult = await mammoth.convertToHtml({ buffer });
  if (htmlResult.value && htmlResult.value.trim().length > 0) {
    if (htmlResult.messages && htmlResult.messages.length > 0) {
      // biome-ignore lint/suspicious/noConsole: surfaces mammoth conversion warnings for debugging fidelity issues.
      console.warn(
        "[docx-preview] mammoth conversion warnings:",
        htmlResult.messages.slice(0, 5),
      );
    }
    return htmlResult.value;
  }
  // biome-ignore lint/suspicious/noConsole: empty mammoth HTML is the diagnostic signal we care about.
  console.warn(
    "[docx-preview] mammoth.convertToHtml returned empty; falling back to extractRawText",
    htmlResult.messages?.slice(0, 5),
  );

  // Tier 2: mammoth.extractRawText — plain text only, more tolerant.
  const rawResult = await mammoth.extractRawText({ buffer });
  const text = (rawResult.value ?? "").trim();
  if (text) {
    return paragraphsToHtml(text);
  }
  // biome-ignore lint/suspicious/noConsole: surfaces extractRawText also failing.
  console.warn(
    "[docx-preview] mammoth.extractRawText returned empty; falling back to JSZip <w:t> sweep",
  );

  // Tier 3: read word/document.xml directly and pull every <w:t> node.
  // Mirrors runtime/harnesses/src/attachment-content.ts extractDocxAttachmentText.
  // This bypasses mammoth's parser entirely and works on any well-formed
  // docx zip, regardless of which authoring tool produced it.
  const zip = await JSZip.loadAsync(buffer);
  const documentXml = await zip.file("word/document.xml")?.async("text");
  if (!documentXml) return "";
  const paragraphs = documentXml.match(/<w:p[\s\S]*?<\/w:p>/g) ?? [];
  const lines = paragraphs
    .map((paragraph) => {
      const matches = [...paragraph.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)];
      return decodeDocxXmlEntities(
        matches.map((match) => match[1] ?? "").join(""),
      ).trim();
    })
    .filter((line) => line.length > 0);
  if (lines.length === 0) return "";
  return paragraphsToHtml(lines.join("\n\n"));
}

function paragraphsToHtml(text: string): string {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map(
      (paragraph) =>
        `<p>${paragraph
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\r?\n/g, "<br />")}</p>`,
    )
    .join("\n");
}

function decodeDocxXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
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

  if (DOCUMENT_FILE_EXTENSIONS.has(extension)) {
    return { extension, kind: "document" as const };
  }

  if (TEXT_FILE_EXTENSIONS.has(extension)) {
    return { extension, kind: "text" as const };
  }

  const mimeType = IMAGE_FILE_MIME_TYPES.get(extension);
  if (mimeType) {
    return { extension, kind: "image" as const, mimeType };
  }

  const videoMimeType = VIDEO_FILE_MIME_TYPES.get(extension);
  if (videoMimeType) {
    return { extension, kind: "video" as const, mimeType: videoMimeType };
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

      const univerSnapshot = await buildUniverSnapshotForPreview(
        buffer,
        extension,
        basePayload.name,
      );

      return {
        ...basePayload,
        kind: "table",
        isEditable:
          extension !== ".xls" &&
          !tableSheets.previewOnly &&
          tableSheets.every((sheet) => !sheet.truncated),
        tableSheets,
        univerSnapshot,
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

  if (kind === "document") {
    if (stat.size > MAX_DOCUMENT_PREVIEW_BYTES) {
      return {
        ...basePayload,
        kind: "unsupported",
        isEditable: false,
        unsupportedReason: "Document is too large to preview inline.",
      };
    }

    try {
      const buffer = await fs.readFile(absolutePath);
      const html = await renderDocumentBufferToHtml(buffer);
      return {
        ...basePayload,
        kind: "document",
        content: html,
      };
    } catch (cause) {
      // biome-ignore lint/suspicious/noConsole: surfaces mammoth parse failures (e.g. Pages-exported docx oddities) so the main-process console captures them.
      console.warn(
        "[docx-preview] mammoth failed for",
        absolutePath,
        cause instanceof Error ? cause.message : cause,
      );
      // Keep the document kind even when the mammoth fallback render fails —
      // the inline docx editor loads from the raw bytes independently, so the
      // file is still openable. The empty content just disables the read-only
      // HTML fallback.
      return {
        ...basePayload,
        kind: "document",
        content: "",
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

  if (kind === "video") {
    if (stat.size > MAX_VIDEO_PREVIEW_BYTES) {
      return {
        ...basePayload,
        kind: "unsupported",
        isEditable: false,
        unsupportedReason: "Video is too large to preview inline.",
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

function univerSheetToCsvRows(snapshot: IWorkbookData): string[][] {
  const sheetId = snapshot.sheetOrder[0];
  const cellData = (snapshot.sheets[sheetId]?.cellData ?? {}) as Record<
    number,
    Record<number, { v?: unknown } | undefined>
  >;
  const rowIndexes = Object.keys(cellData).map(Number);
  const maxRow = rowIndexes.length > 0 ? Math.max(...rowIndexes) : -1;
  const rows: string[][] = [];
  for (let r = 0; r <= maxRow; r += 1) {
    const rowCells = cellData[r] ?? {};
    const columnIndexes = Object.keys(rowCells).map(Number);
    const maxColumn =
      columnIndexes.length > 0 ? Math.max(...columnIndexes) : -1;
    const row: string[] = [];
    for (let c = 0; c <= maxColumn; c += 1) {
      row.push(normalizeWritableTableString(rowCells[c]?.v));
    }
    rows.push(row);
  }
  return rows;
}

async function writeUniverWorkbookFile(
  targetPath: string,
  snapshot: unknown,
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

  const edited = snapshot as IWorkbookData;
  if (!edited || !Array.isArray(edited.sheetOrder)) {
    throw new Error("Spreadsheet preview did not include editable sheet data.");
  }

  if (extension === ".csv") {
    await fs.writeFile(
      absolutePath,
      stringifyCsvRows(univerSheetToCsvRows(edited)),
      "utf-8",
    );
    return readFilePreview(absolutePath, workspaceId);
  }

  const buffer = await fs.readFile(absolutePath);
  const workbook = await loadExcelJSWorkbook(buffer);
  const baseline = buildUniverWorkbookSnapshot(workbook, {
    name: path.basename(absolutePath),
  });
  applyUniverEditsToWorkbook(workbook, baseline, edited);
  const outputBuffer = await workbook.xlsx.writeBuffer();
  await fs.writeFile(absolutePath, workbookOutputToBuffer(outputBuffer));
  return readFilePreview(absolutePath, workspaceId);
}

// Persist Univer Docs edits back to .docx by rendering the edited HTML through
// html-to-docx. The whole file is regenerated, so callers only invoke this when
// the document was actually edited — an untouched .docx is never rewritten.
async function writeDocxFromHtml(
  targetPath: string,
  html: unknown,
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
  if (kind !== "document" || extension !== ".docx") {
    throw new Error("Target file is not an editable document.");
  }
  if (typeof html !== "string") {
    throw new Error("Document preview did not include editable content.");
  }

  const documentBuffer = await htmlToDocx(
    `<!DOCTYPE html><html><head><meta charset="utf-8" /></head><body>${html}</body></html>`,
  );
  await fs.writeFile(absolutePath, documentBuffer);
  return readFilePreview(absolutePath, workspaceId);
}

async function readFileBytes(
  targetPath: string,
  workspaceId?: string | null,
): Promise<Uint8Array> {
  const { absolutePath } = await resolveWorkspaceScopedExplorerPath(
    targetPath,
    workspaceId,
  );
  const stat = await fs.stat(absolutePath);
  if (stat.isDirectory()) {
    throw new Error("Target path is a directory.");
  }
  if (stat.size > MAX_DOCX_EDIT_BYTES) {
    throw new Error("File is too large to open in the inline editor.");
  }
  const buffer = await fs.readFile(absolutePath);
  return new Uint8Array(buffer);
}

async function writeBinaryFile(
  targetPath: string,
  bytes: Uint8Array | ArrayBuffer,
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
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  await fs.writeFile(absolutePath, data);
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

  // A target outside the per-workspace root is normal, not an attack: the
  // runtime writes outputs (and project-bound sessions run) OUTSIDE that root,
  // so the delivered files a user clicks legitimately live elsewhere. This
  // handler is already gated to the trusted main renderer (handleTrustedIpc /
  // assertTrustedIpcSender) and the in-process runtime already has full
  // filesystem access, so a workspace-root constraint here buys no security
  // while breaking real reads. Resolve any path; a null root just means "no
  // containing root to constrain later mutations against" — in-root targets
  // still return their root so those guardrails keep applying.
  return {
    absolutePath: resolvedTargetPath,
    workspaceRoot: isPathWithinRoot(workspaceRoot, resolvedTargetPath)
      ? workspaceRoot
      : null,
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

// Map a leading-dot extension to a packaged blank-template file. A 0-byte
// .xlsx / .docx / .pptx is corrupt per the OOXML spec; copying a minimal
// valid template instead means QuickLook, FilePreviewPane, and downstream
// Office apps all open the file successfully right after creation.
const BLANK_TEMPLATES: Record<string, string> = {
  ".docx": "blank.docx",
  ".xlsx": "blank.xlsx",
  ".pptx": "blank.pptx",
  ".png": "blank.png",
};

function blankTemplatesDirectory(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "blank-templates")
    : path.join(__dirname, "..", "..", "electron", "blank-templates");
}

function defaultSkillsDirectory(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "default-skills")
    : path.join(__dirname, "..", "..", "electron", "default-skills");
}

// Seed the bundled default skills into a workspace's skills/ folder, so they
// appear in the Installed list and the agent can use them — while staying
// user-deletable. The marker records which skills were ever seeded: one already
// in that list is never re-seeded (a default the user removes stays removed),
// while a default added in a later build is seeded on next open, so an existing
// workspace isn't stuck with the set that shipped when it was created. Never
// throws — seeding defaults must not block workspace resolution.
async function ensureDefaultWorkspaceSkills(workspaceRoot: string): Promise<void> {
  try {
    if (!workspaceRoot || !existsSync(workspaceRoot)) {
      return;
    }
    const markerPath = path.join(
      workspaceRoot,
      ".holaboss",
      "state",
      "default-skills-seeded.json",
    );
    let alreadySeeded: string[] = [];
    if (existsSync(markerPath)) {
      try {
        const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as {
          skills?: unknown;
        };
        if (!Array.isArray(marker.skills)) {
          return;
        }
        alreadySeeded = marker.skills.filter(
          (value): value is string => typeof value === "string",
        );
      } catch {
        // An unreadable marker means we can't tell "never seeded" from "user
        // deleted it" — leave the workspace alone rather than resurrect skills.
        return;
      }
    }
    const seededBefore = new Set(alreadySeeded);
    const sourceDir = defaultSkillsDirectory();
    if (!existsSync(sourceDir)) {
      return;
    }
    const skillsRoot = path.join(workspaceRoot, "skills");
    await fs.mkdir(skillsRoot, { recursive: true });
    const entries = await fs.readdir(sourceDir, { withFileTypes: true });
    const seeded: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skillId = entry.name;
      if (seededBefore.has(skillId)) {
        continue;
      }
      const dest = path.join(skillsRoot, skillId);
      // Don't clobber a skill the user (or a capability) already installed.
      if (existsSync(dest)) {
        continue;
      }
      await fs.cp(path.join(sourceDir, skillId), dest, { recursive: true });
      seeded.push(skillId);
    }
    if (existsSync(markerPath) && seeded.length === 0) {
      return;
    }
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(
      markerPath,
      JSON.stringify(
        { version: 1, skills: [...alreadySeeded, ...seeded] },
        null,
        2,
      ),
      "utf8",
    );
  } catch (error) {
    console.warn("[default-skills] seed failed:", error);
  }
}

function resolveBlankTemplatePath(
  extensionHint: string | null | undefined,
): string | null {
  if (!extensionHint) return null;
  const normalized = extensionHint.trim().toLowerCase();
  if (!normalized.startsWith(".")) return null;
  const filename = BLANK_TEMPLATES[normalized];
  if (!filename) return null;
  const templatePath = path.join(blankTemplatesDirectory(), filename);
  return existsSync(templatePath) ? templatePath : null;
}

async function createExplorerPath(
  parentPath: string | null | undefined,
  kind: FileSystemCreateKind,
  workspaceId?: string | null,
  extensionHint?: string | null,
  desiredName?: string | null,
): Promise<FileSystemMutationPayload> {
  const { absolutePath: parentAbsolutePath } =
    await resolveWorkspaceScopedExplorerPath(parentPath, workspaceId);
  const parentStat = await fs.stat(parentAbsolutePath);
  if (!parentStat.isDirectory()) {
    throw new Error("Target path is not a directory.");
  }

  const sanitizedDesiredName = sanitizeExplorerCreateName(desiredName);
  const baseName = sanitizedDesiredName
    ? sanitizedDesiredName
    : kind === "directory"
      ? "New Folder"
      : "Untitled.txt";
  const nextAbsolutePath = await nextAvailableExplorerCreatePath(
    parentAbsolutePath,
    baseName,
  );

  if (kind === "directory") {
    await fs.mkdir(nextAbsolutePath);
  } else {
    const templatePath = resolveBlankTemplatePath(extensionHint);
    if (templatePath) {
      await fs.copyFile(templatePath, nextAbsolutePath);
    } else {
      await fs.writeFile(nextAbsolutePath, "", { flag: "wx" });
    }
  }

  return {
    absolutePath: nextAbsolutePath,
  };
}

function sanitizeExplorerCreateName(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    return null;
  }
  return trimmed;
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
  const { absolutePath: destinationAbsolutePath } =
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

async function openExplorerPathInDefaultApp(
  targetPath: string,
  workspaceId?: string | null,
): Promise<{ opened: boolean; error?: string }> {
  const { absolutePath } = await resolveWorkspaceScopedExplorerPath(
    targetPath,
    workspaceId,
  );
  if (!(await fileExists(absolutePath))) {
    throw new Error("Target path no longer exists.");
  }
  // shell.openPath returns "" on success, an error string on failure
  // (e.g. no app registered for the extension). Convert into a payload
  // the renderer can react to without throwing.
  const error = await shell.openPath(absolutePath);
  if (error) {
    return { opened: false, error };
  }
  return { opened: true };
}

// JXA (JavaScript for Automation, ships with macOS — no native build) that
// resolves the LaunchServices default app for a file and returns its display
// name + app icon as a PNG data URL. The file path arrives as argv[0], so it is
// never interpolated into the script.
const MAC_DEFAULT_APP_JXA = `
function run(argv) {
  ObjC.import('AppKit');
  var ws = $.NSWorkspace.sharedWorkspace;
  var fileURL = $.NSURL.fileURLWithPath(argv[0]);
  var appURL = ws.URLForApplicationToOpenURL(fileURL);
  if (!appURL || !appURL.js) return JSON.stringify({ ok: false });
  var name = ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(appURL.path)).replace(/\\.app$/, '');
  var icon = ws.iconForFile(appURL.path);
  icon.setSize($.NSMakeSize(64, 64));
  var rep = $.NSBitmapImageRep.imageRepWithData(icon.TIFFRepresentation);
  var png = rep.representationUsingTypeProperties(4, $());
  var b64 = ObjC.unwrap(png.base64EncodedStringWithOptions(0));
  return JSON.stringify({ ok: true, name: name, icon: 'data:image/png;base64,' + b64 });
}
`;

function resolveMacDefaultApp(
  absolutePath: string,
): Promise<{ name: string; iconDataUrl: string } | null> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", MAC_DEFAULT_APP_JXA, absolutePath],
      { timeout: 4000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim()) as {
            ok?: boolean;
            name?: unknown;
            icon?: unknown;
          };
          if (
            parsed.ok === true &&
            typeof parsed.name === "string" &&
            parsed.name.length > 0 &&
            typeof parsed.icon === "string" &&
            parsed.icon.startsWith("data:image/")
          ) {
            // The JXA icon is full-resolution (app icons render up to 1024px);
            // downscale to a UI-sized glyph before it crosses IPC.
            let iconDataUrl = parsed.icon;
            try {
              const image = nativeImage.createFromDataURL(parsed.icon);
              if (!image.isEmpty()) {
                iconDataUrl = image
                  .resize({ width: 40, height: 40, quality: "best" })
                  .toDataURL();
              }
            } catch {
              // keep the full-size icon if resize fails
            }
            resolve({ name: parsed.name, iconDataUrl });
            return;
          }
        } catch {
          // fall through
        }
        resolve(null);
      },
    );
  });
}

// The default app that opens a file — its name and icon. On macOS resolves the
// real app (e.g. "Xcode" + its icon) via LaunchServices; otherwise / on failure
// falls back to the OS file icon (default app's document icon) with no name so
// the UI degrades to a generic "Open in default app".
async function getDefaultAppForFile(
  targetPath: string,
  workspaceId?: string | null,
): Promise<{ name: string | null; iconDataUrl: string | null }> {
  let absolutePath = "";
  try {
    ({ absolutePath } = await resolveWorkspaceScopedExplorerPath(
      targetPath,
      workspaceId,
    ));
  } catch {
    return { name: null, iconDataUrl: null };
  }
  if (!absolutePath || !(await fileExists(absolutePath))) {
    return { name: null, iconDataUrl: null };
  }
  if (process.platform === "darwin") {
    const resolved = await resolveMacDefaultApp(absolutePath);
    if (resolved) {
      return { name: resolved.name, iconDataUrl: resolved.iconDataUrl };
    }
  }
  try {
    const icon = await app.getFileIcon(absolutePath, { size: "normal" });
    return { name: null, iconDataUrl: icon.isEmpty() ? null : icon.toDataURL() };
  } catch {
    return { name: null, iconDataUrl: null };
  }
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
        letter-spacing: -0.01em;
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
        letter-spacing: -0.01em;
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
            <div id="identityName" class="identityName">Holaboss account</div>
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
        els.identityName.textContent = isSignedIn ? (sessionDisplayName(state.user) || "Holaboss account") : "Holaboss account";
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

// ===========================================================================
// Browser profiles — first-class, user-managed browsing identities
// ===========================================================================
//
// A profile is the browser-identity axis (its own persistent partition, tabs,
// and — later — window), keyed purely by `browserProfileId` and independent of
// any workspace (the desktop has a single ROOT_WORKSPACE_ID). The metadata
// catalogue lives in browser-profiles/index.json (browser-pane/profile-store);
// the browsing state reuses the id-agnostic browser-workspace engine, keyed by
// the profile id.

let browserProfileIndex: BrowserProfileIndex = emptyBrowserProfileIndex();

function browserProfileIndexPath(): string {
  return path.join(app.getPath("userData"), "browser-profiles", "index.json");
}

async function saveBrowserProfiles(): Promise<void> {
  await writeJsonFile(browserProfileIndexPath(), browserProfileIndex);
}

/** Load the profile catalogue and guarantee the always-present Default. */
async function loadBrowserProfiles(): Promise<void> {
  const raw = await readJsonFile<unknown>(browserProfileIndexPath(), null);
  browserProfileIndex = ensureDefaultBrowserProfile(
    normalizeBrowserProfileIndex(raw),
    new Date().toISOString(),
  );
  await saveBrowserProfiles();
}

function listBrowserProfiles(): BrowserProfile[] {
  return browserProfileIndex.profiles;
}

/**
 * Profiles as sent to the renderer, each tagged with the derived `isDefault`
 * flag (which one is the pinned default browser). The flag is computed on read
 * only — it's never persisted onto the stored profile.
 */
function listBrowserProfilePayloads(): BrowserProfile[] {
  const defaultId = resolveDefaultBrowserProfileId(browserProfileIndex);
  return browserProfileIndex.profiles.map((profile) => ({
    ...profile,
    isDefault: profile.id === defaultId,
  }));
}

/** Pin a profile as the default browser the agent drives when none is named. */
async function setDefaultBrowserProfileById(profileId: string): Promise<void> {
  browserProfileIndex = setDefaultBrowserProfile(browserProfileIndex, profileId);
  await saveBrowserProfiles();
}

// --- Fingerprint template catalogue -----------------------------------------
// Built-in presets (static) + the user's saved/imported templates, persisted to
// browser-profiles/fingerprint-templates.json. See docs/cdp/fingerprint-profiles.md §2.
let fingerprintTemplateIndex: FingerprintTemplateIndex =
  emptyFingerprintTemplateIndex();

function fingerprintTemplatesPath(): string {
  return path.join(
    app.getPath("userData"),
    "browser-profiles",
    "fingerprint-templates.json",
  );
}

async function saveFingerprintTemplates(): Promise<void> {
  await writeJsonFile(fingerprintTemplatesPath(), fingerprintTemplateIndex);
}

async function loadFingerprintTemplates(): Promise<void> {
  const raw = await readJsonFile<unknown>(fingerprintTemplatesPath(), null);
  fingerprintTemplateIndex = normalizeFingerprintTemplateIndex(raw);
}

/** Built-in presets first, then the user's saved/imported templates. */
function listFingerprintTemplates(): FingerprintTemplate[] {
  return [...FINGERPRINT_PRESETS, ...fingerprintTemplateIndex.templates];
}

/** Import an (untrusted) template from JSON — normalized + sanitized. */
async function importFingerprintTemplate(
  raw: unknown,
): Promise<{ templates: FingerprintTemplate[]; warnings: string[] }> {
  const { template, warnings } = normalizeFingerprintTemplate(
    raw,
    `${FINGERPRINT_TEMPLATE_ID_PREFIX}${randomUUID()}`,
    new Date().toISOString(),
  );
  if (template) {
    fingerprintTemplateIndex = addFingerprintTemplate(
      fingerprintTemplateIndex,
      template,
    );
    await saveFingerprintTemplates();
  }
  return { templates: listFingerprintTemplates(), warnings };
}

/** Save a fingerprint as a reusable user template. */
async function saveFingerprintTemplate(
  name: string,
  fingerprint: unknown,
): Promise<FingerprintTemplate[]> {
  const { template } = normalizeFingerprintTemplate(
    { name, source: "user", fingerprint },
    `${FINGERPRINT_TEMPLATE_ID_PREFIX}${randomUUID()}`,
    new Date().toISOString(),
  );
  if (template) {
    fingerprintTemplateIndex = addFingerprintTemplate(
      fingerprintTemplateIndex,
      template,
    );
    await saveFingerprintTemplates();
  }
  return listFingerprintTemplates();
}

async function deleteFingerprintTemplate(
  id: string,
): Promise<FingerprintTemplate[]> {
  fingerprintTemplateIndex = removeFingerprintTemplate(
    fingerprintTemplateIndex,
    id,
  );
  await saveFingerprintTemplates();
  return listFingerprintTemplates();
}

async function createBrowserProfile(input: {
  name: string;
  source?: BrowserProfileSource;
  importedFrom?: string;
}): Promise<BrowserProfile> {
  const { index, profile } = addBrowserProfile(browserProfileIndex, {
    id: `${BROWSER_PROFILE_ID_PREFIX}${randomUUID()}`,
    name: input.name,
    now: new Date().toISOString(),
    source: input.source,
    importedFrom: input.importedFrom,
  });
  browserProfileIndex = index;
  await saveBrowserProfiles();
  return profile;
}

async function renameBrowserProfileById(
  profileId: string,
  name: string,
): Promise<void> {
  browserProfileIndex = renameBrowserProfile(
    browserProfileIndex,
    profileId,
    name,
  );
  await saveBrowserProfiles();
}

/**
 * Delete a profile: tear down any live browser context, wipe its persistent
 * Electron partition + on-disk state, then drop it from the catalogue. The
 * Default profile is permanent (agents fall back to it) and cannot be deleted.
 */
async function deleteBrowserProfileById(profileId: string): Promise<boolean> {
  if (profileId === DEFAULT_BROWSER_PROFILE_ID) {
    return false;
  }
  // Stop a live Chromium first so we don't wipe its user-data-dir out from under
  // a running process (SIGTERM lets it quit; unlink-on-macOS frees files after).
  closeProfileChromium(profileId);
  await session
    .fromPartition(browserProfilePartitionUtil(profileId))
    .clearStorageData()
    .catch(() => undefined);
  await fs
    .rm(browserProfileStorageDirUtil(app.getPath("userData"), profileId), {
      recursive: true,
      force: true,
    })
    .catch(() => undefined);
  browserProfileIndex = removeBrowserProfile(browserProfileIndex, profileId);
  await saveBrowserProfiles();
  return true;
}

// --- Profile Chromium (real browser per profile) ----------------------------
// Each profile launches a real Chrome/Chromium as its own OS process with a
// per-profile --user-data-dir (a genuine Chrome profile) + a remote-debugging
// port so the agent can drive it via CDP. Running the browser out-of-process
// fully decouples it from the Electron main process.

interface ProfileChromeInstance {
  // null when the Chrome was ADOPTED (already reachable on the profile's fixed
  // debug port, e.g. it survived an app restart) rather than spawned by us.
  proc: ReturnType<typeof spawn> | null;
  port: number;
  userDataDir: string;
}

const profileChromeInstances = new Map<string, ProfileChromeInstance>();

// The fingerprint browser runs as its OWN process (see fingerprint-engine-seam
// `loadFingerprintService`): a cloak profile's Camoufox + relay + driving all live
// there, and the core drives it over IPC. We track the loaded client + the set of
// running engine profiles (kept in sync by the service's `onRunningChanged`).
let fingerprintService: FingerprintServiceClient | null = null;
const engineRunningIds = new Set<string>();

/** Load the fingerprint service once + subscribe to its running-set changes. */
async function ensureFingerprintService(): Promise<FingerprintServiceClient | null> {
  if (fingerprintService) {
    return fingerprintService;
  }
  const client = await loadFingerprintService();
  if (!client) {
    return null;
  }
  fingerprintService = client;
  client.onRunningChanged((ids) => {
    engineRunningIds.clear();
    for (const id of ids) {
      engineRunningIds.add(id);
    }
    emitProfilesRunning();
  });
  return client;
}

/** The loaded fingerprint service, or throw — call sites gate on `engineRunningIds`. */
function fingerprintServiceOrThrow(): FingerprintServiceClient {
  if (!fingerprintService) {
    throw new Error("The fingerprint browser is not running.");
  }
  return fingerprintService;
}

/** A cloak/engine profile is running while the service reports it running. */
function engineProfileRunning(profileId: string): boolean {
  return engineRunningIds.has(profileId);
}

/**
 * Resolve the STABLE, collision-free remote-debugging port for a profile,
 * persisting it onto the catalogue the first time (see
 * `assignBrowserProfileDebugPort`). Load-bearing on two counts:
 *   - our profile Chromes are spawned detached, so they OUTLIVE the app; on
 *     relaunch we must reconnect to the SAME port (adopt-if-reachable) rather
 *     than spawn a second process, which Chrome's per-user-data-dir singleton
 *     would just fold into the existing window, leaving CDP no reachable port.
 *   - distinct profiles must never share a port, or the second to launch would
 *     adopt the first's Chrome and drive the wrong logged-in identity.
 * The in-memory index is updated synchronously (before the awaited save), so a
 * concurrent launch sees the freshly-taken port when it probes.
 */
async function resolveProfileDebugPort(profileId: string): Promise<number> {
  const existing = getBrowserProfile(browserProfileIndex, profileId);
  if (existing && typeof existing.debugPort === "number") {
    return existing.debugPort;
  }
  const { index, port } = assignBrowserProfileDebugPort(
    browserProfileIndex,
    profileId,
  );
  browserProfileIndex = index;
  await saveBrowserProfiles();
  return port;
}

/** Running = we hold a live spawned proc, OR the instance was adopted (no proc). */
function profileChromeInstanceRunning(instance: ProfileChromeInstance): boolean {
  return instance.proc === null || instance.proc.exitCode === null;
}

/**
 * Kill any Chrome still holding a profile's user-data-dir on an UNKNOWN debug
 * port — an orphan from a prior session (detached spawns outlive the app) that
 * we can't drive. Called only right before spawning a fresh instance we control,
 * so that spawn can own the lock and open the profile's fixed debug port.
 * macOS/Linux best-effort (Windows: skipped).
 */
/**
 * Diagnostic trail for the profile-Chrome window lifecycle, written to the
 * runtime log (which the diagnostics export bundles). Every launch / adopt /
 * reclaim / spawn is recorded so a "multiple windows" report can be traced from
 * an exported bundle to the exact decision that opened each OS window.
 */
function logProfileChrome(message: string): void {
  void appendRuntimeLog(`[profile-chrome] ${message}\n`);
}

async function killOrphanedProfileChrome(userDataDir: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const needle = `--user-data-dir=${userDataDir}`;
  const findPids = () =>
    new Promise<number[]>((resolve) => {
      execFile("ps", ["-Ao", "pid=,command="], (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        const found: number[] = [];
        for (const line of stdout.split("\n")) {
          if (!line.includes(needle)) {
            continue;
          }
          const pid = Number.parseInt(line.trim().split(/\s+/)[0] ?? "", 10);
          if (Number.isFinite(pid)) {
            found.push(pid);
          }
        }
        resolve(found);
      });
    });
  const initial = await findPids();
  if (initial.length === 0) {
    return;
  }
  logProfileChrome(
    `killOrphan: found ${initial.length} chrome pid(s) [${initial.join(",")}] on ${userDataDir} → SIGKILL`,
  );
  // SIGKILL (not SIGTERM): the OS frees the SingletonLock the instant the
  // process dies, so we don't race a slow graceful shutdown before spawning.
  for (const pid of initial) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  // Confirm they're actually gone (lock released) before the caller spawns.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if ((await findPids()).length === 0) {
      return;
    }
  }
  // Survivors here are the smoking gun for a "second window": the caller's
  // --new-window spawn will fold into a Chrome we failed to reclaim.
  const survivors = await findPids();
  logProfileChrome(
    `killOrphan: WARNING ${survivors.length} chrome pid(s) [${survivors.join(",")}] SURVIVED on ${userDataDir}`,
  );
}

/**
 * Binaries for a specific Chromium family, checked FIRST when a profile was
 * imported from that family. macOS encrypts cookies/logins with a per-family
 * Keychain key ("<Family> Safe Storage"), so an imported profile only decrypts
 * when launched with the same family's binary.
 */
function chromiumFamilyBinaryCandidates(
  family: ChromiumFamilyBrowser,
): string[] {
  const byPlatform: Record<
    string,
    Partial<Record<ChromiumFamilyBrowser, string[]>>
  > = {
    darwin: {
      chrome: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
      chromium: ["/Applications/Chromium.app/Contents/MacOS/Chromium"],
      arc: ["/Applications/Arc.app/Contents/MacOS/Arc"],
      edge: [
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ],
      brave: [
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      ],
      dia: ["/Applications/Dia.app/Contents/MacOS/Dia"],
    },
    win32: {
      chrome: [
        `${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
      ],
      chromium: [
        `${process.env.LOCALAPPDATA ?? ""}\\Chromium\\Application\\chrome.exe`,
        `${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\Chromium\\Application\\chrome.exe`,
      ],
      edge: [
        `${process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)"}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\Microsoft\\Edge\\Application\\msedge.exe`,
      ],
      brave: [
        `${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
        `${process.env.LOCALAPPDATA ?? ""}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
      ],
      dia: [`${process.env.LOCALAPPDATA ?? ""}\\Dia\\Application\\dia.exe`],
    },
    linux: {
      chrome: ["/usr/bin/google-chrome"],
      chromium: ["/usr/bin/chromium", "/usr/bin/chromium-browser"],
      edge: ["/usr/bin/microsoft-edge"],
      brave: ["/usr/bin/brave-browser"],
    },
  };
  return byPlatform[process.platform]?.[family] ?? [];
}

/**
 * Standard Windows install locations for the Chromium-family browsers we can
 * drive, in preference order Chrome → Edge → Brave → Chromium — each across the
 * system dirs (Program Files, Program Files (x86)) AND the per-user LocalAppData
 * dir, where no-admin ("just for me") installs land. Edge (msedge.exe) ships on
 * essentially every Windows machine, so it's the reliable fallback when Chrome
 * isn't installed.
 */
function windowsChromiumBinaryCandidates(): string[] {
  const programFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
  const programFilesX86 =
    process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const at = (base: string, rest: string): string =>
    base ? `${base}\\${rest}` : "";
  return [
    at(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
    at(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
    at(localAppData, "Google\\Chrome\\Application\\chrome.exe"),
    at(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
    at(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
    at(programFiles, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
    at(localAppData, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
    at(localAppData, "Chromium\\Application\\chrome.exe"),
    at(programFiles, "Chromium\\Application\\chrome.exe"),
  ].filter((candidate) => candidate.length > 0);
}

/**
 * Windows last resort: resolve a Chromium-family browser from the registry's
 * "App Paths" (the same mechanism the shell uses for `start chrome`), so an
 * install in a NON-standard directory the hardcoded probing misses is still
 * found. Checks HKLM (all-users) then HKCU (per-user) for Chrome → Edge → Brave.
 * Best-effort: a missing key (or missing `reg`) just falls through. Only ever
 * runs on an explicit launch attempt after path probing came up empty.
 */
function findWindowsBrowserViaRegistry(): string | null {
  for (const appExe of ["chrome.exe", "msedge.exe", "brave.exe"]) {
    for (const root of ["HKLM", "HKCU"]) {
      try {
        const stdout = execFileSync(
          "reg",
          [
            "query",
            `${root}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${appExe}`,
            "/ve",
          ],
          { encoding: "utf8", windowsHide: true, timeout: 3000 },
        );
        // Default-value row: "(Default)    REG_SZ    C:\...\<browser>.exe".
        const row = stdout
          .split("\n")
          .find((line) => /REG_(?:EXPAND_)?SZ/.test(line));
        const resolved = row?.split(/REG_(?:EXPAND_)?SZ/)[1]?.trim();
        if (resolved && existsSync(resolved)) {
          return resolved;
        }
      } catch {
        // Key absent / reg unavailable → try the next candidate.
      }
    }
  }
  return null;
}

function findChromiumBinary(
  preferredFamily?: ChromiumFamilyBrowser | null,
): string | null {
  const candidatesByPlatform: Record<string, string[]> = {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Dia.app/Contents/MacOS/Dia",
    ],
    win32: windowsChromiumBinaryCandidates(),
    linux: [
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ],
  };
  const preferred = preferredFamily
    ? chromiumFamilyBinaryCandidates(preferredFamily)
    : [];
  const candidates = [
    ...preferred,
    ...(candidatesByPlatform[process.platform] ?? []),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) {
    return found;
  }
  // Non-standard install dir on Windows: consult the registry before giving up.
  if (process.platform === "win32") {
    return findWindowsBrowserViaRegistry();
  }
  return null;
}

/**
 * The browser family an imported profile should be launched with (so its
 * per-family-encrypted cookies decrypt). null for created/Default profiles or
 * an unrecognised source → caller falls back to the first available binary.
 */
const CHROMIUM_LAUNCH_FAMILIES: ReadonlySet<string> = new Set([
  "chrome",
  "chromium",
  "arc",
  "edge",
  "brave",
  "dia",
]);

function profileLaunchFamily(profileId: string): ChromiumFamilyBrowser | null {
  const profile = getBrowserProfile(browserProfileIndex, profileId);
  const family = profile?.source === "imported" ? profile.importedFrom : null;
  return family && CHROMIUM_LAUNCH_FAMILIES.has(family)
    ? (family as ChromiumFamilyBrowser)
    : null;
}

function profileChromeUserDataDir(
  profileId: string,
  engine: ProfileEngine | undefined,
): string {
  return path.join(
    browserProfileStorageDirUtil(app.getPath("userData"), profileId),
    // Engine-scoped. The cloak binary (an older Chromium) must NOT reuse a dir a
    // newer system Chrome stamped — Chromium SIGTRAPs on the version downgrade.
    // The two engines' cookies are encrypted differently anyway (§8: cloak = a
    // fresh identity), so separate dirs are correct, not just a crash workaround.
    engine === "fingerprint" ? "fingerprint" : "chrome",
  );
}

/**
 * Security: only http/https/about URLs may ever be handed to a spawned Chromium
 * as a positional argument. Blocks `--foo` argv-injection (a URL starting with
 * a dash would be parsed as a flag — mitigated further by the literal `--`
 * separator at the spawn sites) and dangerous schemes (file:, chrome:, etc.).
 * Returns a safe URL, falling back to HOME_URL for anything rejected.
 */
function safeChromiumPositionalUrl(rawUrl: string): string {
  const candidate = (rawUrl ?? "").trim();
  if (!candidate) {
    return HOME_URL;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return HOME_URL;
  }
  if (
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:" &&
    parsed.protocol !== "about:"
  ) {
    return HOME_URL;
  }
  return parsed.toString();
}

/**
 * Open a URL in a RUNNING profile's single window as a new TAB (over CDP) — one
 * window per profile, never a second OS window. Falls back to a same-instance
 * --new-window only if CDP is unreachable (still the profile's Chrome, never the
 * OS default browser).
 */
async function openUrlInProfileWindow(
  profileId: string,
  port: number,
  binary: string,
  userDataDir: string,
  url: string,
): Promise<void> {
  const safeUrl = safeChromiumPositionalUrl(url);
  try {
    await profileCdpOpenTab(profileId, port, safeUrl);
  } catch {
    logProfileChrome(
      `openUrlInProfileWindow ${profileId}: CDP openTab FAILED → SPAWN --new-window (port-less)`,
    );
    spawn(
      // `--` terminates flag parsing so the URL can never be read as a flag.
      binary,
      [`--user-data-dir=${userDataDir}`, "--new-window", "--", safeUrl],
      { detached: true, stdio: "ignore" },
    ).unref();
  }
}

// --- Fingerprint identity helpers -------------------------------------------
// `fingerprint`-engine profiles run OUT-OF-PROCESS in the fingerprint service
// (see launchEngineProfile). Only these small seed helpers, used when creating /
// backfilling a profile's identity, live here.

/** The fingerprint platform to seed a new profile with — the host OS, so we never
 *  spoof Windows-on-Mac by default (a font/GPU mismatch tell). */
function hostFingerprintPlatform(): FingerprintPlatform {
  if (process.platform === "win32") {
    return "windows";
  }
  if (process.platform === "darwin") {
    return "macos";
  }
  return "linux";
}

function randomFingerprintSeed(): number {
  const span = FINGERPRINT_SEED_MAX - FINGERPRINT_SEED_MIN + 1;
  return FINGERPRINT_SEED_MIN + Math.floor(Math.random() * span);
}

/** The browser binary for a (system) profile — the OS Chrome/Chromium/Edge/Brave. */
function resolveProfileBrowserBinary(profile: BrowserProfile | null): string | null {
  return findChromiumBinary(profile ? profileLaunchFamily(profile.id) : null);
}

/**
 * Set a profile's browser engine. Opting into `cloak` seeds a fingerprint so the
 * next launch is immediately valid. The pretty fingerprint editor lands in P4;
 * this is the write seam it (and dev flows) call.
 */
async function setBrowserProfileEngine(
  profileId: string,
  engine: ProfileEngine,
): Promise<void> {
  if (!getBrowserProfile(browserProfileIndex, profileId)) {
    return;
  }
  browserProfileIndex = {
    ...browserProfileIndex,
    profiles: browserProfileIndex.profiles.map((p) =>
      p.id === profileId ? { ...p, engine } : p,
    ),
  };
  if (engine === "fingerprint") {
    browserProfileIndex = ensureProfileFingerprint(
      browserProfileIndex,
      profileId,
      randomFingerprintSeed(),
      hostFingerprintPlatform(),
    );
  }
  await saveBrowserProfiles();
}

/**
 * Replace a profile's fingerprint from (untrusted) editor input, sanitized. A
 * missing seed/platform backfills from the existing fingerprint or the host, so
 * clearing an optional field clears it while the identity stays stable. Editing a
 * fingerprint implies the cloak engine.
 */
async function setBrowserProfileFingerprint(
  profileId: string,
  raw: unknown,
): Promise<void> {
  const profile = getBrowserProfile(browserProfileIndex, profileId);
  if (!profile) {
    return;
  }
  const { value } = sanitizeFingerprint(raw);
  const seed =
    typeof value.seed === "number"
      ? value.seed
      : (profile.fingerprint?.seed ?? randomFingerprintSeed());
  const platform =
    value.platform ??
    profile.fingerprint?.platform ??
    hostFingerprintPlatform();
  const fingerprint: ProfileFingerprint = { ...value, seed, platform };
  const updated: BrowserProfile = { ...profile, engine: "fingerprint", fingerprint };
  browserProfileIndex = {
    ...browserProfileIndex,
    profiles: browserProfileIndex.profiles.map((p) =>
      p.id === profileId ? updated : p,
    ),
  };
  await saveBrowserProfiles();
}

/**
 * Import fingerprint profiles from an anti-detect export (AdsPower `.xlsx`) via
 * the enterprise engine seam. Each row becomes a `cloak` profile carrying its
 * fingerprint + proxy; its cookies are staged for injection on first launch
 * (reusing the pending-cookies path). Requires the licensed engine
 * (`loadFingerprintService`); OSS builds return an actionable error.
 */
async function importFingerprintBrowserProfiles(
  fileBytes: Uint8Array,
): Promise<{ ok: boolean; error?: string; imported: number; warnings: string[] }> {
  const service = await ensureFingerprintService();
  if (!service) {
    return {
      ok: false,
      error:
        "The fingerprint browser is an enterprise feature and isn't available in this build.",
      imported: 0,
      warnings: [],
    };
  }
  let parsed;
  try {
    parsed = await service.importProfiles(fileBytes);
  } catch (error) {
    return {
      ok: false,
      error: `Couldn't read that file: ${(error as Error).message}`,
      imported: 0,
      warnings: [],
    };
  }

  const warnings: string[] = [];
  let imported = 0;
  for (const entry of parsed) {
    const id = `${BROWSER_PROFILE_ID_PREFIX}${randomUUID()}`;
    const { index } = addBrowserProfile(browserProfileIndex, {
      id,
      name: entry.name,
      now: new Date().toISOString(),
      source: "imported",
      importedFrom: entry.group ? `AdsPower · ${entry.group}` : "AdsPower",
    });
    browserProfileIndex = index;

    // Re-sanitize the (untrusted) imported fingerprint/proxy before persisting.
    const { value } = sanitizeFingerprint(entry.fingerprint);
    const fingerprint: ProfileFingerprint = {
      ...value,
      seed: typeof value.seed === "number" ? value.seed : randomFingerprintSeed(),
      platform: value.platform ?? hostFingerprintPlatform(),
    };
    const proxy = entry.proxy ? sanitizeProxy(entry.proxy) : null;
    browserProfileIndex = {
      ...browserProfileIndex,
      profiles: browserProfileIndex.profiles.map((p) =>
        p.id === id
          ? { ...p, engine: "fingerprint", fingerprint, ...(proxy ? { proxy } : {}) }
          : p,
      ),
    };

    // Stage the session cookies for injection on first launch. `EngineCookie`
    // is structurally the pending `TransferableCookie` shape.
    if (entry.cookies.length > 0) {
      await writePendingImportedCookies(
        profileChromeUserDataDir(id, "fingerprint"),
        entry.cookies,
      );
    }
    for (const w of entry.warnings) {
      warnings.push(`${entry.name}: ${w}`);
    }
    imported += 1;
  }
  await saveBrowserProfiles();
  return { ok: true, imported, warnings };
}

/**
 * One-time seed of an imported profile's login on Windows: inject the decrypted
 * cookies captured from the source at import time (see cdp-cookie-transfer.ts)
 * into the freshly-launched profile over CDP, then clear the pending file. The
 * target Chrome re-encrypts them with its own key, so App-Bound Encryption never
 * blocks the transfer. Best-effort — a failure just means the user signs in once,
 * and the pending file is kept so a later launch can retry.
 */
async function seedPendingImportedCookies(
  profileId: string,
  port: number,
  userDataDir: string,
): Promise<void> {
  try {
    const cookies = await readPendingImportedCookies(userDataDir);
    if (cookies.length === 0) {
      return;
    }
    const { added } = await profileCdpAddCookies(profileId, port, cookies);
    if (added > 0) {
      await clearPendingImportedCookies(userDataDir);
    }
  } catch {
    // Best-effort; leave the pending file so a later launch can retry.
  }
}

/**
 * Launch a `cloak` profile through the fingerprint SERVICE (its own process):
 * the service starts Camoufox (persistent context) + the relay + driving; the core
 * then injects any staged import cookies and opens the landing URL over IPC.
 * Tracked in `engineRunningIds` (kept in sync by the service). Reuses the running
 * browser (opens a tab) when already live.
 */
async function launchEngineProfile(
  profileId: string,
  profile: BrowserProfile,
  url?: string,
): Promise<{ ok: boolean; error?: string }> {
  const service = await ensureFingerprintService();
  if (!service) {
    return {
      ok: false,
      error:
        "The fingerprint browser is an enterprise feature and isn't available in this build.",
    };
  }
  // A caller-named URL (agent drive / open-tab) always wins over restore/landing.
  const namedUrl =
    typeof url === "string" && url.trim()
      ? safeChromiumPositionalUrl(url.trim())
      : null;

  // Already running (per the service): open the named URL as a new tab.
  if (engineRunningIds.has(profileId)) {
    if (namedUrl) {
      await service.openTab(profileId, namedUrl).catch(() => {});
    }
    return { ok: true };
  }

  const userDataDir = profileChromeUserDataDir(profileId, "fingerprint");
  await fs.mkdir(userDataDir, { recursive: true });

  let launchResult: { ok: boolean; restoredTabs?: number };
  try {
    launchResult = await service.launch({
      id: profileId,
      name: profile.name,
      fingerprint: profile.fingerprint ?? {
        seed: randomFingerprintSeed(),
        platform: hostFingerprintPlatform(),
      },
      proxy: profile.proxy ?? null,
      headless: false,
      userDataDir,
      branding: {
        name: FINGERPRINT_BROWSER_BRAND_NAME,
        icnsPath: fingerprintBrandIconPath(),
      },
    });
  } catch (error) {
    return {
      ok: false,
      error: `Couldn't start the fingerprint browser: ${(error as Error).message}`,
    };
  }
  // Mark running eagerly so a drive call right after launch routes to the service
  // (the service's runningChanged notification confirms it a beat later).
  engineRunningIds.add(profileId);

  // First launch after an import: seed the staged cookies into the persistent
  // context (they then persist in the profile's user_data_dir), then open the
  // landing page — all inside the service process.
  try {
    const pending = await readPendingImportedCookies(userDataDir);
    if (pending.length > 0) {
      await service.addCookies(profileId, pending);
      await clearPendingImportedCookies(userDataDir);
    }
  } catch {
    // Best-effort; leave the pending file so a later launch can retry.
  }
  // Where to land: a named URL wins; otherwise the service has already reopened
  // the previous session's tabs — only fall back to the leak-check page when there
  // was nothing to restore (a brand-new profile).
  if (namedUrl) {
    await service.navigate(profileId, namedUrl).catch(() => {});
  } else if (!launchResult.restoredTabs) {
    await service
      .navigate(profileId, safeChromiumPositionalUrl(FINGERPRINT_DEFAULT_LANDING_URL))
      .catch(() => {});
  }

  emitProfilesRunning();
  return { ok: true };
}

async function launchProfileChromium(
  profileId: string,
  url?: string,
): Promise<{ ok: boolean; error?: string }> {
  const profile = getBrowserProfile(browserProfileIndex, profileId);
  // `cloak` profiles run through the enterprise fingerprint engine (Camoufox),
  // not the detached-Chrome path below.
  if (profile && profile.engine === "fingerprint") {
    return launchEngineProfile(profileId, profile, url);
  }
  const binary = resolveProfileBrowserBinary(profile);
  if (!binary) {
    return {
      ok: false,
      error:
        "No Chrome / Chromium / Edge / Brave found. Install Google Chrome to use browser profiles.",
    };
  }
  const userDataDir = profileChromeUserDataDir(profileId, profile?.engine);
  await fs.mkdir(userDataDir, { recursive: true });
  // Security: reject non-http(s)/about landing URLs and dash-prefixed argv
  // injection before it reaches the Chromium spawn (falls back to HOME_URL).
  const landingUrl = safeChromiumPositionalUrl(
    typeof url === "string" && url.trim() ? url.trim() : HOME_URL,
  );

  const port = await resolveProfileDebugPort(profileId);

  // Already tracked + running (spawned or adopted): open the URL as a TAB in the
  // profile's existing window — one window per profile — never a second window.
  // No URL → no-op (Launch⇄Close toggle).
  const tracked = profileChromeInstances.get(profileId);
  if (tracked && profileChromeInstanceRunning(tracked)) {
    logProfileChrome(
      `launch ${profileId}: reuse tracked window (port=${tracked.port}, adopted=${tracked.proc === null})${typeof url === "string" && url.trim() ? " + open tab" : ""}`,
    );
    if (typeof url === "string" && url.trim()) {
      await openUrlInProfileWindow(
        profileId,
        tracked.port,
        binary,
        userDataDir,
        landingUrl,
      );
    }
    return { ok: true };
  }

  // A Chrome may already be reachable on this profile's fixed debug port (it
  // survived an app restart — our spawns are detached). Adopt it instead of
  // spawning: a fresh spawn would just route its --new-window into the existing
  // instance and exit, leaving us tracking a dead proc with no CDP port.
  if (await profileCdpTryAdopt(profileId, port)) {
    logProfileChrome(
      `launch ${profileId}: adopted existing chrome on port ${port}${typeof url === "string" && url.trim() ? " + open tab" : ""}`,
    );
    profileChromeInstances.set(profileId, { proc: null, port, userDataDir });
    if (typeof url === "string" && url.trim()) {
      await openUrlInProfileWindow(
        profileId,
        port,
        binary,
        userDataDir,
        landingUrl,
      );
    }
    emitProfilesRunning();
    return { ok: true };
  }

  // Nothing reachable on the fixed port. Reclaim any ORPHANED Chrome still
  // holding this profile's user-data-dir on an unknown port (old scheme / lost
  // tracking) so our fresh spawn can own the lock and open the fixed port.
  await killOrphanedProfileChrome(userDataDir);

  logProfileChrome(
    `launch ${profileId}: SPAWN --new-window (port=${port}, url=${landingUrl})`,
  );
  const proc = spawn(
    binary,
    [
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      // `--` terminates flag parsing so the (validated) URL can never be read
      // as a Chromium flag.
      "--",
      landingUrl,
    ],
    { detached: true, stdio: "ignore" },
  );
  proc.unref();
  profileChromeInstances.set(profileId, { proc, port, userDataDir });
  proc.on("exit", () => {
    if (profileChromeInstances.get(profileId)?.proc === proc) {
      profileChromeInstances.delete(profileId);
    }
    // Drop the CDP connection to the now-dead Chromium.
    disconnectProfileCdp(profileId);
    // Chrome quit (via Close or the user quitting it directly) → flip the row
    // back to Launch.
    emitProfilesRunning();
  });
  proc.on("error", (error) => {
    // eslint-disable-next-line no-console
    console.error("[profile-chrome] spawn failed", profileId, error);
    if (profileChromeInstances.get(profileId)?.proc === proc) {
      profileChromeInstances.delete(profileId);
    }
    emitProfilesRunning();
  });
  // First launch after a Windows import: seed the login cookies captured from
  // the source (fire-and-forget; it waits for the debug port internally).
  void seedPendingImportedCookies(profileId, port, userDataDir);
  emitProfilesRunning();
  return { ok: true };
}

/** Profile ids whose Chromium is currently running. */
function runningProfileChromiumIds(): string[] {
  const ids: string[] = [];
  for (const [id, instance] of profileChromeInstances) {
    if (profileChromeInstanceRunning(instance)) {
      ids.push(id);
    }
  }
  for (const id of engineRunningIds) {
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

/** The remote-debugging port of a profile's LIVE Chromium, or null if not running. */
function profileChromiumPort(profileId: string): number | null {
  const instance = profileChromeInstances.get(profileId);
  return instance && profileChromeInstanceRunning(instance)
    ? instance.port
    : null;
}

/**
 * Push the set of running profiles to the Profiles page so its Launch⇄Close
 * toggle stays in sync — including when Chrome is quit outside the app.
 */
function emitProfilesRunning(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(
      "profiles:running",
      runningProfileChromiumIds(),
    );
  }
}

/**
 * Whether a profile's debug port ACTIVELY REFUSES a connection — i.e. no Chrome
 * is listening (it exited/crashed). A response OR a slow/timed-out attempt both
 * resolve `false` (a busy-but-running Chrome), so a liveness check built on this
 * never tears down a live browser on a transient stall — only when the port is
 * genuinely gone (ECONNREFUSED).
 */
function profileDebugPortRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/json/version", method: "GET", timeout: 1000 },
      (res) => {
        res.resume();
        resolve(false);
      },
    );
    req.on("error", (error) => {
      resolve((error as NodeJS.ErrnoException).code === "ECONNREFUSED");
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/**
 * Count open page targets (windows/tabs) on a profile's debug port; -1 if the
 * port is unreachable (Chrome exited / not up yet).
 */
function profileDebugPortPageCount(port: number): Promise<number> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/json/list", method: "GET", timeout: 1500 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        res.on("end", () => {
          try {
            const targets = JSON.parse(
              Buffer.concat(chunks).toString("utf-8"),
            ) as Array<{ type?: string }>;
            resolve(
              Array.isArray(targets)
                ? targets.filter((t) => t.type === "page").length
                : -1,
            );
          } catch {
            resolve(-1);
          }
        });
      },
    );
    req.on("error", () => resolve(-1));
    req.on("timeout", () => {
      req.destroy();
      resolve(-1);
    });
    req.end();
  });
}

// Keep the Profiles page's Launch⇄Close toggle honest. `proc.on("exit")` only
// fires when the Chrome PROCESS exits — but on macOS closing the last window
// leaves the process alive (0 windows), and ADOPTED instances (proc === null)
// have no process we watch at all. So poll each tracked profile's debug port:
// unreachable → it exited; 0 windows (for 2 consecutive polls, to ride out
// transient states) → the user closed it, so fully close it and flip to Launch.
const profileEmptyWindowStreak = new Map<string, number>();

async function reconcileProfileChromeInstances(): Promise<void> {
  for (const [profileId, instance] of [...profileChromeInstances]) {
    const pageCount = await profileDebugPortPageCount(instance.port);
    if (!profileChromeInstances.has(profileId)) {
      continue; // closed out from under us while awaiting.
    }
    if (pageCount < 0) {
      // A freshly-spawned Chrome's debug port lags startup — don't reap a proc
      // that's still coming up; its own `exit` handler covers a real crash.
      if (instance.proc && instance.proc.exitCode === null) {
        continue;
      }
      logProfileChrome(
        `reconcile: port ${instance.port} unreachable → drop tracking for ${profileId} (adopted=${instance.proc === null}); next drive will relaunch`,
      );
      profileChromeInstances.delete(profileId);
      profileEmptyWindowStreak.delete(profileId);
      disconnectProfileCdp(profileId);
      emitProfilesRunning();
      continue;
    }
    if (pageCount === 0) {
      const streak = (profileEmptyWindowStreak.get(profileId) ?? 0) + 1;
      if (streak >= 2) {
        logProfileChrome(
          `reconcile: ${profileId} had 0 windows for 2 polls → close`,
        );
        profileEmptyWindowStreak.delete(profileId);
        closeProfileChromium(profileId);
      } else {
        profileEmptyWindowStreak.set(profileId, streak);
      }
    } else {
      profileEmptyWindowStreak.delete(profileId);
    }
  }
}

setInterval(() => {
  void reconcileProfileChromeInstances();
}, 3000).unref?.();

/**
 * Close a profile's Chromium (the Close half of the toggle). SIGTERM lets Chrome
 * shut down gracefully; its `exit` handler removes the instance and re-emits the
 * running set. The entry is kept until the process actually exits so a relaunch
 * during shutdown can't spawn a second instance on the same user-data-dir.
 */
function closeProfileChromium(profileId: string): { ok: boolean } {
  // Engine-backed (cloak) profile: the service owns the browser + relay; tell it to
  // close. Delete eagerly so a re-launch doesn't see a stale entry (the service's
  // runningChanged confirms).
  if (engineRunningIds.has(profileId)) {
    engineRunningIds.delete(profileId);
    void fingerprintService?.close(profileId).catch(() => {});
    emitProfilesRunning();
    return { ok: true };
  }
  const existing = profileChromeInstances.get(profileId);
  if (!existing) {
    return { ok: true };
  }
  if (existing.proc) {
    if (existing.proc.exitCode === null) {
      try {
        existing.proc.kill();
      } catch {
        // Already gone; the exit handler will reconcile.
      }
    }
    return { ok: true };
  }
  // Adopted (no proc we own): drop the CDP link, kill the Chrome by its
  // user-data-dir, and clear the entry (there's no exit handler to fire).
  disconnectProfileCdp(profileId);
  void killOrphanedProfileChrome(existing.userDataDir);
  profileChromeInstances.delete(profileId);
  emitProfilesRunning();
  return { ok: true };
}

export interface ProfileImportResult {
  profile: BrowserProfile;
  /** Whether the source `Local State` (encryption key + prefs) was copied. */
  copiedLocalState: boolean;
  /** Whether the matching family binary is installed (needed to decrypt cookies). */
  matchedBinaryAvailable: boolean;
  /**
   * Windows CDP cookie transfer: how many decrypted cookies were captured from
   * the source to seed the login on next launch (0 on macOS/Linux, where the
   * plain copy already carries logins), and a warning when it couldn't run.
   */
  cookiesCaptured: number;
  cookieTransferWarning: string | null;
}

/**
 * Import an installed Chromium-family browser profile as a NEW first-class
 * profile: create the catalogue entry, then natively copy the source profile
 * directory into the profile's real-Chrome user-data-dir (cookies, logins,
 * bookmarks, extensions). On any copy failure the half-created profile is rolled
 * back so a failed import never leaves a ghost.
 */
async function importBrowserProfileAsNewProfile(payload: {
  source: ChromiumFamilyBrowser;
  profileDir: string;
  profileLabel?: string | null;
  name?: string | null;
}): Promise<ProfileImportResult> {
  const source = payload.source;
  const sourceProfileDir =
    typeof payload.profileDir === "string" ? payload.profileDir.trim() : "";
  if (!sourceProfileDir) {
    throw new Error("Choose a browser profile to import.");
  }
  const displayName = chromiumFamilyDisplayName(source);
  const requestedName =
    typeof payload.name === "string" && payload.name.trim()
      ? payload.name.trim()
      : "";
  const label =
    typeof payload.profileLabel === "string" && payload.profileLabel.trim()
      ? payload.profileLabel.trim()
      : "";
  const name =
    requestedName || (label ? `${displayName} · ${label}` : `${displayName} import`);

  const profile = await createBrowserProfile({
    name,
    source: "imported",
    importedFrom: source,
  });
  try {
    // Imported profiles carry real Chrome logins → they run on the system
    // engine, so target the `chrome/` dir (never the cloak one).
    const targetUserDataDir = profileChromeUserDataDir(profile.id, "system");
    const result = await copyChromiumProfileIntoUserDataDir({
      sourceProfileDir,
      targetUserDataDir,
    });

    // A running source browser locks its SQLite DBs, so some files were skipped
    // and the login capture below can't run either. Fail with a clear, actionable
    // message (the catch below rolls the half-created profile back) instead of
    // leaving a degraded profile — the source browser must be fully closed.
    if (result.skippedLockedFiles.length > 0) {
      throw new Error(
        `Close ${displayName} completely, then import again — ${displayName} locks its profile data (cookies, history, logins) while it's open, so it can't be copied.`,
      );
    }

    // Windows: Chrome's App-Bound Encryption means the copied cookie files can't
    // be decrypted in the relocated profile, so the copy alone launches logged
    // out. Read DECRYPTED cookies from the source Chrome over CDP now and stash
    // them; they're injected on the target profile's next launch (see
    // launchProfileChromium). Best-effort — the rest of the profile still imports
    // if this can't run. macOS/Linux don't need it (their key is portable).
    let cookiesCaptured = 0;
    let cookieTransferWarning: string | null = null;
    if (process.platform === "win32") {
      const sourceBinary = chromiumFamilyBinaryCandidates(source).find(
        (candidate) => existsSync(candidate),
      );
      if (!sourceBinary) {
        cookieTransferWarning = `${displayName} isn't installed here, so signed-in sessions couldn't be carried over. Sign in once in the imported profile.`;
      } else {
        const capture = await captureCookiesFromChromeProfile({
          chromeBinary: sourceBinary,
          sourceUserDataDir: path.dirname(sourceProfileDir),
          sourceProfileDirName: path.basename(sourceProfileDir),
        });
        cookiesCaptured = capture.cookies.length;
        if (capture.cookies.length > 0) {
          await writePendingImportedCookies(
            targetUserDataDir,
            capture.cookies,
          ).catch(() => undefined);
        }
        cookieTransferWarning = capture.error;
      }
    }

    return {
      profile,
      copiedLocalState: result.copiedLocalState,
      matchedBinaryAvailable: chromiumFamilyBinaryCandidates(source).some(
        (candidate) => existsSync(candidate),
      ),
      cookiesCaptured,
      cookieTransferWarning,
    };
  } catch (error) {
    await deleteBrowserProfileById(profile.id).catch(() => undefined);
    throw error;
  }
}


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
        // Center the ~12px native traffic lights in the app's 40px (h-10) top
        // band: (40 - 12) / 2 = 14. (16 was tuned for a taller 44px bar and
        // left them sitting ~2px low against the agent name / toolbar row.)
        trafficLightPosition: { x: 14, y: 14 },
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
      // Disable Chromium's background timer + animation throttling for
      // the main window. With the default (true), setTimeout/setInterval
      // in the renderer get clamped to ≥1s while the window is hidden,
      // and intensive throttling can push the floor to ~1 minute. That
      // breaks any renderer-driven polling that depends on tight cadence
      // while the user is doing work in another app — most visibly the
      // Composio OAuth poll loop: a user who completes auth in their
      // browser and never explicitly clicks back to Electron sees the
      // "Connecting…" card sit unchanged for up to a minute before the
      // throttled tick finally fires. For a desktop product agent that
      // is *expected* to keep working while the user is away, the small
      // CPU/battery cost of running renderer timers at full cadence is
      // a clearly correct trade.
      backgroundThrottling: false,
    },
  });

  mainWindow = win;
  attachedAppSurfaceView = null;
  reserveMainWindowClosedListenerBudget();
  activeBrowserWorkspaceId = "";
  activeBrowserSpaceId = "agent";
  activeBrowserSessionId = "";

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => undefined);
  win.webContents.on("did-start-loading", () => {
    // A renderer reload (dev HMR full-reload, ⌘R) restarts the React tree, but
    // the app-surface BrowserView lives in the main process and persists — left
    // attached at its last bounds it lingers, misplaced, over the reloading UI
    // until React remounts and re-syncs. Detach it up front; WebAppSurfacePane
    // re-attaches at the correct bounds when it mounts again. No-op on the first
    // load (nothing attached) and harmless in production (no HMR reloads).
    detachAttachedMainWindowViews();
  });
  win.webContents.on("did-finish-load", () => {
    win.webContents.setZoomFactor(1);
    win.webContents.setZoomLevel(0);
    emitRuntimeState(true);
    emitPendingAuthState();
    emitAppUpdateState();
    emitWindowStateChanged(win);
    startComposioKeepWarm();
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

  win.on("focus", () => {
    // Show a fresh list the moment the user returns to the app.
    void refreshComposioConnectionsCache();
  });
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
    activeBrowserWorkspaceId = "";
    activeBrowserSpaceId = "agent";
    activeBrowserSessionId = "";
    attachedAppSurfaceView = null;
    // The window is gone: its attached surface view's webContents dies with it,
    // and any detached kept-alive views are now orphaned. Tear them all down so a
    // reopened window (macOS keeps the app alive → app.on("activate") rebuilds it)
    // starts from fresh surfaces instead of reusing a view whose webContents is
    // undefined — which is what made reopening Discover throw "reading 'id'".
    for (const surfaceKey of [...appSurfaceViews.keys()]) {
      destroyAppSurfaceView(surfaceKey);
    }
    closeAllFilePreviewWatchSubscriptions();
    stopComposioKeepWarm();
    // Session/chat SSE connections are opened with `timeout: 0` because they
    // are long-lived by design. Their only consumer is the renderer that just
    // died, and on macOS ⌘W leaves the app running — so without this each
    // open/close cycle stranded a never-timing-out socket to the runtime plus
    // its reader closure, and emitSessionStreamEvent just logged
    // "no windows" for the rest of the process's life.
    //
    // Aborting loses nothing: the run continues server-side and its events are
    // persisted, so a reopened window re-attaches from the store.
    for (const [streamId] of [...sessionOutputStreams]) {
      void closeSessionOutputStream(streamId, "main_window_closed");
    }
    for (const controller of [...employeeChatStreams.values()]) {
      controller.abort();
    }
    employeeChatStreams.clear();
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

// The `.icns` handed to the fingerprint engine to re-icon the Camoufox.app bundle
// (the dock icon of a launched profile). Bundled to `process.resourcesPath` via
// electron-builder `extraResources`; the repo copy in dev.
function fingerprintBrandIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.icns")
    : path.join(__dirname, "..", "..", "resources", "icon.icns");
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
  statusItemTray.setToolTip(configuredMacAppMenuProductLabel());
  statusItemTray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: `Open ${configuredMacAppMenuProductLabel()}`,
        click: () => {
          focusOrCreateMainWindow();
        },
      },
      {
        label: `Quit ${configuredMacAppMenuProductLabel()}`,
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
          label: `Open ${configuredMacAppMenuProductLabel()}`,
          click: () => {
            focusOrCreateMainWindow();
          },
        },
        {
          label: `Quit ${configuredMacAppMenuProductLabel()}`,
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

function installWindowsApplicationMenu() {
  if (process.platform !== "win32") {
    return;
  }

  // Windows gets the SAME File/Edit/View accelerators as macOS so the native
  // shortcuts work: Close Tab (Ctrl+W), Close Window (Ctrl+Shift+W), zoom,
  // DevTools and Full Screen. Without an application menu, none of these fire
  // on Windows (previously the menu was macOS-only). The main window is
  // frameless with `autoHideMenuBar`, so setting the menu registers the
  // accelerators WITHOUT drawing a visible menu bar. We drop the macOS-style
  // app-name submenu (Windows has no app menu convention).
  const template: MenuItemConstructorOptions[] = [
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
  process.platform === "darwin"
    ? configuredMacAppMenuProductLabel()
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
      dispatchDeepLink(callbackUrl);
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
    dispatchDeepLink(targetUrl);
  });

  const initialCallbackUrl = process.argv
    .map((value) => maybeAuthCallbackUrl(value))
    .find((value) => value !== null);
  if (initialCallbackUrl) {
    dispatchDeepLink(initialCallbackUrl);
  }
}

app.on("browser-window-created", (_event, window) => {
  window.on("unresponsive", () => {
    if (unresponsiveDesktopWindows.has(window)) {
      return;
    }
    unresponsiveDesktopWindows.add(window);
  });

  window.on("responsive", () => {
    unresponsiveDesktopWindows.delete(window);
  });
});

app.on("web-contents-created", (_event, contents) => {
  const contentsType = contents.getType();
  contents.on("render-process-gone", (_goneEvent, details) => {
    const ownerWindow = BrowserWindow.fromWebContents(contents);
    if (ownerWindow && ownerWindow === mainWindow && contentsType === "window") {
      detachAttachedMainWindowViews();
    }
  });
});


// Independent ready step: the agent browser capability must come up regardless
// of anything else in the long ready sequence below (it's what exposes browser_*
// tools to agents), so an unrelated earlier failure can't leave it disabled.
/**
 * Run one boot step, keeping a failure from aborting the rest of
 * `app.whenReady()`.
 *
 * Failures are recorded rather than swallowed: runtime.log is what the
 * diagnostics bundle collects, so a degraded launch stays diagnosable after
 * the fact instead of looking like a healthy one.
 */
async function runBootStep(
  label: string,
  run: () => Promise<unknown> | unknown,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    // eslint-disable-next-line no-console
    console.error(`[boot] ${label} failed`, error);
    void appendRuntimeLog(`[boot] ${label} failed: ${detail}`).catch(
      () => undefined,
    );
  }
}

app.whenReady().then(() => {
  void ensureDesktopBrowserServiceStarted();
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
  installWindowsApplicationMenu();
  applyMainShellContentSecurityPolicy(session.defaultSession);

  // Each of these loads persisted state from disk, and each can throw on
  // ordinary field conditions: a read-only or full userData dir, a corrupt or
  // locked SQLite file (bootstrapRuntimeDatabase is try/finally with no catch).
  // None is a prerequisite for showing a window.
  //
  // Unguarded, any one of them aborted the remaining ~2,600 lines of this
  // chain: all 249 IPC handler registrations, createMainWindow(), and the
  // app.on("activate") registration at the very end -- so the user got a dock
  // icon, no window, and clicking the dock did nothing. Degrading one
  // subsystem is recoverable; losing the window is not.
  await runBootStep("browser persistence", loadBrowserPersistence);
  await runBootStep("browser profiles", loadBrowserProfiles);
  await runBootStep("fingerprint templates", loadFingerprintTemplates);
  await runBootStep("runtime database", bootstrapRuntimeDatabase);
  await runBootStep("control-plane database", bootstrapControlPlaneDatabase);
  probeAuthCookieHealthOnce();
  setupDevRuntimeHotReload();

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

  composioEventsBridge = createComposioEventsBridge({
    getCookieHeader: () => authCookieHeader(),
    getApiBaseUrl: () => AUTH_BASE_URL ?? "",
    getTargetWindows: () =>
      mainWindow && !mainWindow.isDestroyed() ? [mainWindow] : [],
    log: (event) => {
      // eslint-disable-next-line no-console
      console.info(`[composio-events] ${JSON.stringify(event)}`);
    },
  });
  if (authCookieHeader()) {
    composioEventsBridge.start();
  }

  // Browser profile catalogue IPC (window-independent CRUD; the Profiles page
  // renderer calls these in a later phase). `profiles:launch` lands with the
  // profile window manager.
  handleTrustedIpc("profiles:list", ["main"], async () =>
    listBrowserProfilePayloads(),
  );
  handleTrustedIpc(
    "profiles:launch",
    ["main"],
    async (_event, profileId: string, url?: string | null) =>
      launchProfileChromium(profileId, url ?? undefined),
  );
  handleTrustedIpc(
    "profiles:close",
    ["main"],
    async (_event, profileId: string) => closeProfileChromium(profileId),
  );
  handleTrustedIpc("profiles:runningIds", ["main"], async () =>
    runningProfileChromiumIds(),
  );
  handleTrustedIpc(
    "profiles:create",
    ["main"],
    async (_event, name?: string | null) =>
      createBrowserProfile({
        name: typeof name === "string" && name.trim() ? name : "New profile",
      }),
  );
  handleTrustedIpc(
    "profiles:rename",
    ["main"],
    async (_event, profileId: string, name: string) => {
      await renameBrowserProfileById(profileId, name);
      return listBrowserProfilePayloads();
    },
  );
  handleTrustedIpc(
    "profiles:delete",
    ["main"],
    async (_event, profileId: string) => {
      const deleted = await deleteBrowserProfileById(profileId);
      return { deleted, profiles: listBrowserProfilePayloads() };
    },
  );
  // Pin the profile the agent drives when a browser tool names none.
  handleTrustedIpc(
    "profiles:setDefault",
    ["main"],
    async (_event, profileId: string) => {
      await setDefaultBrowserProfileById(profileId);
      return listBrowserProfilePayloads();
    },
  );
  // Import an installed Chrome/Chromium/Arc profile as a NEW profile. The source
  // list reuses the workspace import discovery; the import itself natively copies
  // the source profile dir into the new profile's real-Chrome user-data-dir.
  handleTrustedIpc(
    "profiles:listImportSources",
    ["main"],
    async (
      _event,
      source: BrowserImportSource,
    ): Promise<BrowserImportProfileOptionPayload[]> => {
      // Safari isn't a Chromium-family browser — nothing to discover here.
      if (source === "safari") {
        return [];
      }
      const { profiles } = await discoverChromiumFamilyImportProfiles(source);
      return profiles.map((profile) => ({
        profileId: profile.profileId,
        profileLabel: profile.profileLabel,
        profileDir: profile.profileDir,
      }));
    },
  );
  handleTrustedIpc(
    "profiles:import",
    ["main"],
    async (
      _event,
      payload: {
        source: ChromiumFamilyBrowser;
        profileDir: string;
        profileLabel?: string | null;
        name?: string | null;
      },
    ) => importBrowserProfileAsNewProfile(payload),
  );
  // Import fingerprint profiles from an anti-detect export (AdsPower .xlsx). The
  // renderer reads the picked file to bytes and passes them here; the enterprise
  // engine parses them into cloak profiles (fingerprint + proxy + staged cookies).
  handleTrustedIpc(
    "profiles:importSpreadsheet",
    ["main"],
    async (_event, fileBytes: ArrayBuffer | Uint8Array) => {
      const bytes =
        fileBytes instanceof Uint8Array ? fileBytes : new Uint8Array(fileBytes);
      return importFingerprintBrowserProfiles(bytes);
    },
  );
  // Runtime engine presence for the renderer's feature gate: true when an engine is
  // attached — build-time in node_modules, or a runtime plugin drop-in under
  // <userData>/fingerprint-ee. Lets a released OSS app light up the fingerprint UI
  // when the engine is dropped in, without needing the build-time flag.
  handleTrustedIpc("profiles:fingerprintAvailable", ["main"], async () =>
    isFingerprintEnginePresent(),
  );
  // --- One-click fingerprint engine installer (runtime plugin drop-in) ---
  handleTrustedIpc("fingerprint:installedInfo", ["main"], async () =>
    installedEngineInfo(),
  );
  handleTrustedIpc("fingerprint:downloadAvailable", ["main"], async () =>
    resolveEngineDownloadUrl() !== null,
  );
  handleTrustedIpc("fingerprint:installFromFile", ["main"], async (event) => {
    const pick = await dialog.showOpenDialog({
      title: "Choose the fingerprint engine bundle",
      properties: ["openFile"],
      filters: [{ name: "Engine bundle", extensions: ["zip"] }],
    });
    if (pick.canceled || !pick.filePaths[0]) {
      return { ok: false, canceled: true };
    }
    const onProgress = (p: InstallProgress) =>
      event.sender.send("fingerprint:installProgress", p);
    try {
      const info = await installFromZip(pick.filePaths[0], onProgress);
      return { ok: info.present, info };
    } catch (error) {
      const message = (error as Error).message;
      onProgress({ phase: "error", message });
      return { ok: false, error: message };
    }
  });
  handleTrustedIpc("fingerprint:installFromUrl", ["main"], async (event) => {
    const url = resolveEngineDownloadUrl();
    if (!url) {
      return { ok: false, error: "No engine download source is configured." };
    }
    const onProgress = (p: InstallProgress) =>
      event.sender.send("fingerprint:installProgress", p);
    try {
      const info = await installFromUrl(url, onProgress);
      return { ok: info.present, info };
    } catch (error) {
      const message = (error as Error).message;
      onProgress({ phase: "error", message });
      return { ok: false, error: message };
    }
  });
  // Opt a profile into the fingerprint (anti-detect) engine, or back to system
  // Chrome. Switching seeds a fingerprint so the next launch spoofs.
  handleTrustedIpc(
    "profiles:setEngine",
    ["main"],
    async (_event, profileId: string, engine: ProfileEngine) => {
      await setBrowserProfileEngine(
        profileId,
        engine === "fingerprint" ? "fingerprint" : "system",
      );
      return listBrowserProfilePayloads();
    },
  );
  handleTrustedIpc(
    "profiles:setFingerprint",
    ["main"],
    async (_event, profileId: string, fingerprint: unknown) => {
      await setBrowserProfileFingerprint(profileId, fingerprint);
      return listBrowserProfilePayloads();
    },
  );
  // Coherence warnings for an in-progress fingerprint edit (the editor's live
  // check) — pure, persists nothing.
  handleTrustedIpc(
    "profiles:previewFingerprint",
    ["main"],
    async (_event, raw: unknown) => {
      const { value } = sanitizeFingerprint(raw);
      const fingerprint: ProfileFingerprint = {
        ...value,
        seed: typeof value.seed === "number" ? value.seed : FINGERPRINT_SEED_MIN,
        platform: value.platform ?? "windows",
      };
      return { warnings: validateFingerprintCoherence(fingerprint) };
    },
  );
  // Fingerprint templates: built-in presets + user-saved/imported, reusable
  // across profiles. Import is untrusted → normalized/sanitized in main.
  handleTrustedIpc("fptemplates:list", ["main"], async () =>
    listFingerprintTemplates(),
  );
  handleTrustedIpc(
    "fptemplates:import",
    ["main"],
    async (_event, raw: unknown) => importFingerprintTemplate(raw),
  );
  handleTrustedIpc(
    "fptemplates:save",
    ["main"],
    async (_event, name: string, fingerprint: unknown) =>
      saveFingerprintTemplate(
        typeof name === "string" && name.trim()
          ? name.trim()
          : "My fingerprint",
        fingerprint,
      ),
  );
  handleTrustedIpc(
    "fptemplates:delete",
    ["main"],
    async (_event, id: string) => deleteFingerprintTemplate(id),
  );

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
    "fs:pathExists",
    ["main"],
    async (_event, targetPath?: string | null, workspaceId?: string | null) => {
      try {
        const { absolutePath } = await resolveWorkspaceScopedExplorerPath(
          targetPath,
          workspaceId,
        );
        return existsSync(absolutePath);
      } catch {
        return false;
      }
    },
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
    "fs:writeUniverWorkbook",
    ["main"],
    async (
      _event,
      targetPath: string,
      snapshot: unknown,
      workspaceId?: string | null,
    ) => writeUniverWorkbookFile(targetPath, snapshot, workspaceId),
  );
  handleTrustedIpc(
    "fs:writeDocxFromHtml",
    ["main"],
    async (
      _event,
      targetPath: string,
      html: unknown,
      workspaceId?: string | null,
    ) => writeDocxFromHtml(targetPath, html, workspaceId),
  );
  handleTrustedIpc(
    "fs:readFileBytes",
    ["main"],
    async (_event, targetPath: string, workspaceId?: string | null) =>
      readFileBytes(targetPath, workspaceId),
  );
  handleTrustedIpc(
    "fs:writeBinaryFile",
    ["main"],
    async (
      _event,
      targetPath: string,
      bytes: Uint8Array,
      workspaceId?: string | null,
    ) => writeBinaryFile(targetPath, bytes, workspaceId),
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
      extensionHint?: string | null,
      desiredName?: string | null,
    ) =>
      createExplorerPath(
        parentPath,
        kind,
        workspaceId,
        extensionHint,
        desiredName,
      ),
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
    "fs:openInDefaultApp",
    ["main"],
    async (_event, targetPath: string, workspaceId?: string | null) =>
      openExplorerPathInDefaultApp(targetPath, workspaceId),
  );
  handleTrustedIpc(
    "fs:getDefaultApp",
    ["main"],
    async (_event, targetPath: string, workspaceId?: string | null) =>
      getDefaultAppForFile(targetPath, workspaceId),
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
  handleTrustedIpc("runtime:getDbMaintenance", ["main"], () =>
    fetchDbMaintenanceStatus(),
  );
  // Boot phase, for the splash. Fail-open like the maintenance probe: a null
  // resolves to "no information", never to "blocked".
  handleTrustedIpc("runtime:getBootStatus", ["main"], () =>
    fetchRuntimeBootStatus(runtimeBaseUrl()).catch(() => null),
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
  // Organization (tenant) context. The active org is stored server-side on the
  // Better-Auth session (`session.activeOrganizationId`); the frontend gateway
  // reads it to inject `x-holaboss-org-id` on every proxied backend call — so
  // switching the active org here re-scopes the whole app with no per-call
  // header. We go through the client (not a manual fetch) so `set-active`'s
  // session rotation is captured by the client's Set-Cookie handling; a manual
  // fetch would leave the persisted cookie pointing at the old active org.
  handleTrustedIpc(
    "auth:listOrganizations",
    ["main", "auth-popup"],
    async () => {
      if (!desktopAuthClient) {
        return [];
      }
      const { data, error } = await desktopAuthClient.organization.list();
      if (error) {
        appendRuntimeEventLog({
          category: "auth",
          event: "org_list",
          outcome: "error",
          detail: error.message ?? String(error.status ?? ""),
        });
        return [];
      }
      return data ?? [];
    },
  );
  handleTrustedIpc(
    "auth:getActiveOrganization",
    ["main", "auth-popup"],
    async () => {
      if (!desktopAuthClient) {
        return null;
      }
      const { data, error } =
        await desktopAuthClient.organization.getFullOrganization();
      if (error) {
        appendRuntimeEventLog({
          category: "auth",
          event: "org_active_get",
          outcome: "error",
          detail: error.message ?? String(error.status ?? ""),
        });
        return null;
      }
      return data ?? null;
    },
  );
  handleTrustedIpc(
    "auth:setActiveOrganization",
    ["main", "auth-popup"],
    async (_event, organizationId: string | null) => {
      if (!desktopAuthClient) {
        return null;
      }
      const { data, error } = await desktopAuthClient.organization.setActive({
        organizationId,
      });
      if (error) {
        appendRuntimeEventLog({
          category: "auth",
          event: "org_set_active",
          outcome: "error",
          detail: error.message ?? String(error.status ?? ""),
        });
        return null;
      }
      // The active org lives on the session row; our cached get-session copy is
      // now stale (its activeOrganizationId changed). Drop it so the next
      // getAuthenticatedUser re-reads, and tell the renderer to refresh.
      invalidateCachedAuthSession();
      // The composio read cache is keyed by path, not org — the org just
      // changed, so its entries hold the previous org's connections. Wipe it so
      // the integrations pane re-fetches the new org's accounts instead of
      // serving the old ones until the TTL lapses.
      resetComposioCachesForOrgSwitch();
      // Org-owned sessions: keep runtime-config.json's `org_id` = the live active
      // org so a NEW session stamps the org the user is in at creation (the
      // runtime reads it fresh — resolveProductRuntimeConfig → readFileSync).
      // PERSONAL is modeled as "no org" (null): its sessions bill the personal
      // wallet via the consume fallback and are listed under Personal (null-org),
      // so a team view never shows them. Existing sessions keep their stamped
      // org. Best-effort — a write failure leaves the previous org, not a crash.
      try {
        const [switchedOrgId, switchedByoOrgId] = await Promise.all([
          resolveDesktopActiveOrgId(),
          resolveDesktopByoOrgId(),
        ]);
        await writeRuntimeConfigFile({
          orgId: switchedOrgId,
          byoOrgId: switchedByoOrgId,
        });
      } catch (orgWriteError) {
        appendRuntimeEventLog({
          category: "auth",
          event: "org_set_active",
          outcome: "error",
          detail: `runtime-config org write failed: ${
            orgWriteError instanceof Error
              ? orgWriteError.message
              : String(orgWriteError)
          }`,
        });
      }
      // The catalog is org-specific once BYO models are folded in, so force a
      // refetch for the NEW org and push it to the renderer — otherwise the model
      // picker keeps showing the previous org's BYO models until the next
      // TTL-gated background refresh.
      void refreshRuntimeModelCatalogIfNeeded({ force: true })
        .then(() => emitRuntimeConfig())
        .catch(() => undefined);
      emitAuthUserUpdated(await getAuthenticatedUser());
      return data ?? null;
    },
  );
  // Org member management (native Members surface). The member + invitation LIST
  // is read via auth:getActiveOrganization (getFullOrganization returns both);
  // these four are the mutations. Each returns { ok, error? } and the renderer
  // refetches the active org. Authorization is enforced server-side by
  // Better-Auth (admin+ to manage; can't touch owner) — we surface its error.
  handleTrustedIpc(
    "auth:inviteOrgMember",
    ["main"],
    async (
      _event,
      payload: { email: string; role: "admin" | "member" },
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!desktopAuthClient) {
        return { ok: false, error: "Authentication is not configured." };
      }
      const { error } = await desktopAuthClient.organization.inviteMember({
        email: payload.email,
        role: payload.role,
      });
      if (error) {
        appendRuntimeEventLog({
          category: "auth",
          event: "org_invite_member",
          outcome: "error",
          detail: error.message ?? String(error.status ?? ""),
        });
        return { ok: false, error: error.message ?? "Failed to send invite." };
      }
      return { ok: true };
    },
  );
  handleTrustedIpc(
    "auth:removeOrgMember",
    ["main"],
    async (
      _event,
      memberIdOrEmail: string,
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!desktopAuthClient) {
        return { ok: false, error: "Authentication is not configured." };
      }
      const { error } = await desktopAuthClient.organization.removeMember({
        memberIdOrEmail,
      });
      if (error) {
        appendRuntimeEventLog({
          category: "auth",
          event: "org_remove_member",
          outcome: "error",
          detail: error.message ?? String(error.status ?? ""),
        });
        return { ok: false, error: error.message ?? "Failed to remove member." };
      }
      return { ok: true };
    },
  );
  handleTrustedIpc(
    "auth:updateOrgMemberRole",
    ["main"],
    async (
      _event,
      payload: { memberId: string; role: "admin" | "member" },
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!desktopAuthClient) {
        return { ok: false, error: "Authentication is not configured." };
      }
      const { error } = await desktopAuthClient.organization.updateMemberRole({
        memberId: payload.memberId,
        role: payload.role,
      });
      if (error) {
        appendRuntimeEventLog({
          category: "auth",
          event: "org_update_member_role",
          outcome: "error",
          detail: error.message ?? String(error.status ?? ""),
        });
        return { ok: false, error: error.message ?? "Failed to update role." };
      }
      return { ok: true };
    },
  );
  handleTrustedIpc(
    "auth:cancelOrgInvitation",
    ["main"],
    async (
      _event,
      invitationId: string,
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!desktopAuthClient) {
        return { ok: false, error: "Authentication is not configured." };
      }
      const { error } = await desktopAuthClient.organization.cancelInvitation({
        invitationId,
      });
      if (error) {
        appendRuntimeEventLog({
          category: "auth",
          event: "org_cancel_invitation",
          outcome: "error",
          detail: error.message ?? String(error.status ?? ""),
        });
        return {
          ok: false,
          error: error.message ?? "Failed to cancel invitation.",
        };
      }
      return { ok: true };
    },
  );
  // Renderer-side BFF clients (e.g. @holaboss/app-sdk in renderer, billing
  // RPC calls) reach the BFF via the bff:fetch IPC bridge — main injects
  // the auth cookie there, so the renderer never sees it. The two URL
  // accessors below stay because the renderer still needs to know which
  // host to target (encoded in the SDK's baseURL).
  handleTrustedIpc("auth:getApiBaseUrl", ["main"], () => AUTH_BASE_URL ?? "");
  // HolaApp gateway calls (/gateway/wapp/*) must target the backend/api host, NOT
  // the www Cloudflare-Workers SPA host (AUTH_BASE_URL): the SPA's static-asset
  // edge returns 405 for POST on /gateway/* before the Worker runs (GET falls
  // through, which is why the catalogue worked but install/uninstall didn't). The
  // api host accepts POST, and the session cookie is valid there (same host the
  // runtime-binding exchange POSTs to). See exchangeDesktopRuntimeBinding.
  handleTrustedIpc(
    "auth:getBackendBaseUrl",
    ["main"],
    () => BACKEND_BASE_URL ?? "",
  );
  handleTrustedIpc(
    "auth:getMarketplaceBaseUrl",
    ["main"],
    () => marketplaceBffBaseUrl(),
  );
  handleTrustedIpc("auth:requestAuth", ["main", "auth-popup"], async () => {
    appendRuntimeEventLog({
      category: "auth",
      event: "signin_popup_open",
      outcome: "start",
      detail: "trigger=user_ipc",
    });
    await requireAuthClient().requestAuth();
  });
  handleTrustedIpc("auth:signOut", ["main", "auth-popup"], async () => {
    try {
      await requireAuthClient().signOut();
    } finally {
      clearPersistedAuthCookie();
      clearPlaintextAuthCache();
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
  // Force a re-fetch of the org's model catalogue (managed + BYO/custom-provider
  // models) and push the refreshed config to the renderer. Backs the "Refresh
  // model catalogue" action in Settings → BYOK — otherwise a provider added on
  // web (or a provider's newly-added model) only appears after the next
  // TTL-gated background refresh.
  handleTrustedIpc("runtime:refreshModelCatalog", ["main"], async () => {
    await refreshRuntimeModelCatalogIfNeeded({ force: true });
    const config = await getRuntimeConfig();
    await emitRuntimeConfig(config);
    return config;
  });
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
      emitOpenSettingsPane(normalizeUiSettingsPaneSection(section));
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
    "ui:getKeepAwakeEnabled",
    ["main"],
    async () => keepAwakePreferences.enabled,
  );
  handleTrustedIpc(
    "ui:setKeepAwakeEnabled",
    ["main"],
    async (_event, enabled: unknown) => {
      const next = enabled !== false;
      keepAwakePreferences = { enabled: next };
      applyKeepAwakePreference();
      try {
        await persistKeepAwakePreferences();
      } catch (error) {
        void appendRuntimeLog(
          `[keep-awake] failed to persist preference: ${error instanceof Error ? error.message : String(error)}\n`,
        );
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
  handleTrustedIpc(
    "appUpdate:installNow",
    ["main"],
    async () => installAppUpdateNow(),
  );
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
      const [activeOrgId, byoOrgId] = await Promise.all([
        resolveDesktopActiveOrgId(),
        resolveDesktopByoOrgId(),
      ]);
      const nextConfig = await writeRuntimeConfigFile({
        authToken: modelProxyApiKey,
        modelProxyApiKey,
        userId: binding.holaboss_user_id,
        orgId: activeOrgId,
        byoOrgId,
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
    "appSurface:navigate",
    ["main"],
    async (_event, workspaceId: string, appId: string, urlPath?: string) =>
      navigateAppSurface(workspaceId, appId, urlPath),
  );
  handleTrustedIpc(
    "appSurface:navigateWebApp",
    ["main"],
    async (
      _event,
      holaAppId: string,
      urlPath?: string,
      absoluteUrl?: string,
      forceReload?: boolean,
      soft?: boolean,
    ) =>
      navigateWebHolaAppSurface(
        holaAppId,
        urlPath,
        absoluteUrl,
        forceReload ?? false,
        soft ?? false,
      ),
  );
  handleTrustedIpc(
    "appSurface:prewarmWebApp",
    ["main"],
    async (_event, holaAppId: string) => prewarmWebHolaAppSurface(holaAppId),
  );
  handleTrustedIpc(
    "appSurface:destroyWebApp",
    ["main"],
    (_event, holaAppId: string) => {
      destroyWebHolaAppSurface(holaAppId);
    },
  );
  handleTrustedIpc(
    "holaApps:install",
    ["main"],
    async (_event, holaAppId: string) => installHolaApp(holaAppId),
  );
  handleTrustedIpc(
    "holaApps:uninstall",
    ["main"],
    async (_event, holaAppId: string) => uninstallHolaApp(holaAppId),
  );
  handleTrustedIpc(
    "holaApps:sync",
    ["main"],
    async (_event, holaAppIds: string[]) =>
      syncInstalledHolaApps(Array.isArray(holaAppIds) ? holaAppIds : []),
  );
  // API-key install gate (OmniSocials, Publora): VALIDATE the key against the
  // app's MCP (initialize + tools/list), and only on success connect the server
  // via the runtime's mcp_connect path. Returns { ok, toolCount?, error? } so the
  // gate can surface a rejected key and keep the chat blocked.
  handleTrustedIpc(
    "holaApps:attachApiKeyMcp",
    ["main"],
    async (
      _event,
      args: {
        holaAppId?: string;
        mcpUrl?: string;
        apiKey?: string;
        auth?: unknown;
      },
    ): Promise<{ ok: boolean; toolCount?: number; error?: string }> => {
      const holaAppId = typeof args?.holaAppId === "string" ? args.holaAppId : "";
      const mcpUrl = typeof args?.mcpUrl === "string" ? args.mcpUrl : "";
      const apiKey = typeof args?.apiKey === "string" ? args.apiKey.trim() : "";
      const auth = normalizeCustomMcpAuth(args?.auth);
      if (!holaAppId || !mcpUrl || !apiKey || !auth) {
        return { ok: false, error: "Missing API key or app configuration." };
      }
      const validation = await validateCustomMcpKey(mcpUrl, apiKey, auth);
      if (!validation.ok) {
        return { ok: false, error: validation.error ?? "That key was rejected." };
      }
      await attachCustomMcpServer(
        ROOT_WORKSPACE_ID,
        holaAppId,
        mcpUrl,
        apiKey,
        auth,
      );
      return {
        ok: true,
        ...(validation.toolCount != null
          ? { toolCount: validation.toolCount }
          : {}),
      };
    },
  );
  handleTrustedIpc(
    "holaApps:detachApiKeyMcp",
    ["main"],
    async (_event, holaAppId: string) => {
      if (typeof holaAppId !== "string" || !holaAppId) {
        return;
      }
      await detachCustomMcpServer(ROOT_WORKSPACE_ID, holaAppId);
    },
  );
  // Command/stdio MCP install (drawio): attach a LOCAL MCP server (the runtime
  // spawns it via the given argv) through the mcp_connect capability, with a
  // scoped browser-open shim so its editor loads in-app. One-click (no key/gate);
  // also called on launch to ensure-up. Idempotent. Detach rides the generic
  // holaApps:uninstall path (uninstallHolaApp removes the workspace.yaml entry).
  handleTrustedIpc(
    "holaApps:attachCommandMcp",
    ["main"],
    async (
      _event,
      args: { holaAppId?: string; command?: unknown; env?: unknown },
    ) => {
      const holaAppId = typeof args?.holaAppId === "string" ? args.holaAppId : "";
      const command = Array.isArray(args?.command)
        ? args.command.filter(
            (part): part is string => typeof part === "string" && part.length > 0,
          )
        : [];
      if (!holaAppId || command.length === 0) {
        return;
      }
      const env: Record<string, string> = {};
      if (args?.env && typeof args.env === "object") {
        for (const [key, value] of Object.entries(
          args.env as Record<string, unknown>,
        )) {
          if (typeof value === "string") {
            env[key] = value;
          }
        }
      }
      await attachCommandMcpServer(ROOT_WORKSPACE_ID, holaAppId, command, env);
    },
  );
  // Marketplace MCP install (mcp-catalog): attach a REMOTE MCP server to workspace.yaml,
  // applying the user's LOCAL keys by target (+ session bearer for hosted servers). The keys
  // arrive here over IPC and never leave the machine. sync/uninstall keep main's in-memory
  // set (used for the per-turn bearer refresh) reconciled with the renderer's local state.
  handleTrustedIpc(
    "mcpMarketplace:install",
    ["main"],
    async (_event, config: unknown) => {
      const normalized = normalizeMarketplaceMcpConfig(config);
      if (!normalized) {
        return;
      }
      await installMarketplaceMcp(normalized);
    },
  );
  // Attach an APP-OWNED hosted MCP (a HolaApp's hostedMcpInstall, e.g. jianguoyun).
  // Tracked in installedHostedAppMcps (NOT installedMarketplaceMcps, which is
  // reconciled against the MCP-marketplace catalog and would detach app MCPs).
  // Written to app_servers (owner_app_id) and re-attached per turn for the bearer
  // refresh; torn down with the app on uninstall.
  handleTrustedIpc(
    "mcpMarketplace:attachAppOwned",
    ["main"],
    async (_event, config: unknown) => {
      const normalized = normalizeMarketplaceMcpConfig(config);
      if (!normalized?.ownerAppId) {
        return;
      }
      installedHostedAppMcps.set(normalized.id, normalized);
      await attachHostedMcpServer(ROOT_WORKSPACE_ID, normalized);
    },
  );
  // Re-sync the app-owned hosted-MCP set from the renderer (on launch / catalog
  // refresh) so main can re-attach them per turn even after a restart.
  handleTrustedIpc(
    "mcpMarketplace:syncAppOwned",
    ["main"],
    async (_event, configs: unknown) => {
      const list = Array.isArray(configs)
        ? configs
            .map(normalizeMarketplaceMcpConfig)
            .filter(
              (config): config is MarketplaceMcpAttachConfig =>
                config !== null && Boolean(config.ownerAppId),
            )
        : [];
      await syncHostedAppMcps(list);
    },
  );
  handleTrustedIpc(
    "mcpMarketplace:uninstall",
    ["main"],
    async (_event, id: unknown) => {
      if (typeof id !== "string" || !id) {
        return;
      }
      await uninstallMarketplaceMcp(id);
    },
  );
  handleTrustedIpc(
    "mcpMarketplace:sync",
    ["main"],
    async (_event, configs: unknown) => {
      const list = Array.isArray(configs)
        ? configs
            .map(normalizeMarketplaceMcpConfig)
            .filter(
              (config): config is MarketplaceMcpAttachConfig => config !== null,
            )
        : [];
      await syncInstalledMarketplaceMcps(list);
    },
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
  // Is this surface actually showing anything? The pane cannot tell — the native
  // view paints over its own reserved space, and the failure paths we know about
  // only cover the causes we thought of. This is the backstop: ask the page
  // itself, so an unexplained blank still ends up as an error the user can act
  // on rather than a white rectangle.
  handleTrustedIpc(
    "appSurface:probe",
    ["main"],
    async (_event, appIdOrKey: string) => {
      const view = resolveAppSurfaceView(appIdOrKey);
      if (!view || view.webContents.isCrashed()) {
        return { missing: true, empty: true, url: "" };
      }
      const url = view.webContents.getURL();
      if (!url || url === "about:blank") {
        return { missing: false, empty: true, url };
      }
      if (view.webContents.isLoading()) {
        return { missing: false, empty: false, url };
      }
      try {
        const empty = (await view.webContents.executeJavaScript(
          `(() => {
            try {
              var b = document.body;
              if (!b || b.childElementCount === 0) { return true; }
              var text = (b.innerText || "").trim().length > 0;
              var visual = !!b.querySelector("img,canvas,svg,video,input,button");
              return !(text || visual);
            } catch (e) { return false; }
          })()`,
          true,
        )) as boolean;
        return { missing: false, empty: empty === true, url };
      } catch {
        // Never accuse a page we failed to inspect.
        return { missing: false, empty: false, url };
      }
    },
  );
  // Recovery for a surface stuck on a stale/half-authenticated page. Scoped to
  // the app's own origin: third-party surfaces share the workspace browser
  // partition with the imported profile and the agent's browser, so clearing the
  // partition would sign the user out of everything they own.
  handleTrustedIpc(
    "appSurface:clearAppData",
    ["main"],
    async (_event, appIdOrKey: string, appUrl?: string) => {
      const view = resolveAppSurfaceView(appIdOrKey);
      if (!view) {
        return;
      }
      const from = view.webContents.getURL() || appUrl || "";
      let origin = "";
      try {
        origin = from ? new URL(from).origin : "";
      } catch {
        origin = "";
      }
      if (!origin) {
        return;
      }
      await view.webContents.session.clearStorageData({ origin });
      view.webContents.reload();
    },
  );
  handleTrustedIpc("appSurface:hide", ["main"], () => {
    hideAppSurface();
  });
  // Synchronous by design: the app-surface preload reads this before the hosted
  // page's boot script runs, so the page never paints a frame in the wrong theme.
  ipcMain.on(HOST_IPC.colorScheme, (event) => {
    event.returnValue = currentColorScheme();
  });
  // Host bridge (called by the UNTRUSTED hosted page via appSurfacePreload).
  // NOT handleTrustedIpc: the caller is verified by mapping event.sender → its
  // owning app-surface, and the op is scoped to that surface's workspace.
  ipcMain.handle(HOST_IPC.capabilities, (event) =>
    appSurfaceIdentity.has(event.sender.id)
      ? [
          HOST_OPS.chatStart,
          HOST_OPS.install,
          HOST_OPS.installStatus,
          HOST_OPS.employeesChanged,
        ]
      : [],
  );
  // Renderer pulls a deep link that landed before its subscriber mounted
  // (cold start / pre-sign-in). Returns it once, then clears it.
  ipcMain.handle("holaApp:consumePendingDeepLink", () => {
    const target = pendingOpenAppDeepLink;
    pendingOpenAppDeepLink = null;
    return target;
  });
  ipcMain.handle(
    HOST_IPC.invoke,
    (event, msg: { op?: unknown; payload?: unknown }) => {
      const identity = appSurfaceIdentity.get(event.sender.id);
      if (!identity) {
        return { ok: false, error: "unknown_surface" };
      }
      const op = typeof msg?.op === "string" ? msg.op : "";
      if (op === HOST_OPS.chatStart) {
        return hostChatStart(identity, (msg?.payload ?? {}) as ChatStartInput);
      }
      if (op === HOST_OPS.install) {
        return hostInstall(identity, (msg?.payload ?? {}) as InstallInput);
      }
      if (op === HOST_OPS.installStatus) {
        return hostInstallStatus();
      }
      if (op === HOST_OPS.itemOpen) {
        return hostItemOpen(identity, (msg?.payload ?? {}) as OpenItemInput);
      }
      if (op === HOST_OPS.holahubConsumePendingShare) {
        // Idempotent read: don't clear here — a StrictMode double-consume would
        // otherwise get null and bounce the composer. The next stageShare
        // overwrites it, so a share always sees its own fresh draft.
        return { ok: true, data: pendingHolahubShare };
      }
      if (op === HOST_OPS.employeesChanged) {
        return hostEmployeesChanged((msg?.payload ?? {}) as EmployeesChangedInput);
      }
      return {
        ok: false,
        error: `unsupported op: ${op}`,
        code: "unsupported_op",
      };
    },
  );
  // Shell renderer's headless installer reports an install outcome; relay it to
  // the pending `install` invoke (from the hosted page). Only the main window's
  // shell renderer sends this.
  ipcMain.on(HOST_INSTALL_RESULT, (event, msg: InstallResultMessage) => {
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      event.sender.id !== mainWindow.webContents.id
    ) {
      return;
    }
    const requestId = typeof msg?.requestId === "string" ? msg.requestId : "";
    if (requestId && msg?.result && typeof msg.result.status === "string") {
      settleInstall(requestId, msg.result);
    }
  });
  // Shell renderer reports the installed-items list; relay it to the pending
  // `install.status` invoke. Only the main window's shell renderer sends this.
  ipcMain.on(HOST_INSTALL_STATUS_RESULT, (event, msg: InstallStatusResultMessage) => {
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      event.sender.id !== mainWindow.webContents.id
    ) {
      return;
    }
    const requestId = typeof msg?.requestId === "string" ? msg.requestId : "";
    if (requestId && msg?.list && Array.isArray(msg.list.items)) {
      settleInstallStatus(requestId, msg.list);
    }
  });
  // Shell (ChatPane) stages a desktop output to share; the HolaHub web surface
  // pulls it once via the holahub.consume-pending-share op. Trusted (main window
  // only) — the draft carries user content the hosted surface never gets to set.
  handleTrustedIpc(
    "holahub:stage-share",
    ["main"],
    (_event, draft: ShareDraft) => {
      pendingHolahubShare = draft;
      return true;
    },
  );
  handleTrustedIpc(
    "appSurface:resolveUrl",
    ["main"],
    async (_event, workspaceId: string, appId: string, urlPath?: string) =>
      resolveAppSurfaceUrl(workspaceId, appId, urlPath),
  );
  handleTrustedIpc(
    "workspace:listActivity",
    ["main"],
    async (_event, payload: { workspaceId: string; date: string }) =>
      listWorkspaceActivity(payload),
  );
  handleTrustedIpc(
    "workspace:listOutputFolders",
    ["main"],
    async (_event, workspaceId: string) => listOutputFolders(workspaceId),
  );
  handleTrustedIpc(
    "workspace:searchOutputs",
    ["main"],
    async (_event, payload: WorkspaceOutputSearchRequestPayload) =>
      searchOutputs(payload),
  );
  handleTrustedIpc(
    "workspace:createOutput",
    ["main"],
    async (_event, payload: WorkspaceOutputCreatePayload) =>
      createOutput(payload),
  );
  handleTrustedIpc(
    "workspace:updateOutput",
    ["main"],
    async (
      _event,
      payload: {
        workspaceId: string;
        outputId: string;
        title?: string | null;
        status?: string | null;
        folderId?: string | null;
        filePath?: string | null;
      },
    ) => updateOutput(payload),
  );
  handleTrustedIpc(
    "workspace:deleteOutput",
    ["main"],
    async (_event, payload: { workspaceId: string; outputId: string }) =>
      deleteOutput(payload),
  );
  handleTrustedIpc("workspace:listArtifactTemplates", ["main"], async () =>
    listArtifactTemplates(),
  );
  handleTrustedIpc(
    "workspace:readArtifactTemplatePreview",
    ["main"],
    async (_event, payload: { templateId: string }) =>
      readArtifactTemplatePreview(payload),
  );
  handleTrustedIpc(
    "workspace:saveOutputAsTemplate",
    ["main"],
    async (_event, payload: SaveOutputAsArtifactTemplatePayload) =>
      saveOutputAsArtifactTemplate(payload),
  );
  handleTrustedIpc(
    "workspace:createOutputFromTemplate",
    ["main"],
    async (
      _event,
      payload: {
        workspaceId: string;
        templateId: string;
        sessionId?: string | null;
        name?: string | null;
      },
    ) => createOutputFromArtifactTemplate(payload),
  );
  handleTrustedIpc(
    "workspace:deleteArtifactTemplate",
    ["main"],
    async (_event, payload: { templateId: string }) =>
      deleteArtifactTemplate(payload),
  );
  handleTrustedIpc(
    "workspace:listSkills",
    ["main"],
    async (_event, workspaceId: string) => listWorkspaceSkills(workspaceId),
  );
  handleTrustedIpc(
    "workspace:deleteSkill",
    ["main"],
    async (_event, payload: { workspaceId: string; skillId: string }) =>
      deleteWorkspaceSkill(payload),
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
    "workspace:listIssues",
    ["main"],
    async (_event, workspaceId: string) => listIssues(workspaceId),
  );
  handleTrustedIpc(
    "workspace:createIssue",
    ["main"],
    async (_event, payload: CreateIssuePayload) => createIssue(payload),
  );
  handleTrustedIpc(
    "workspace:updateIssue",
    ["main"],
    async (
      _event,
      workspaceId: string,
      issueId: string,
      payload: UpdateIssuePayload,
    ) => updateIssue(workspaceId, issueId, payload),
  );
  handleTrustedIpc(
    "workspace:stopIssueRun",
    ["main"],
    async (_event, workspaceId: string, issueId: string) =>
      stopIssueRun(workspaceId, issueId),
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
    async (_event, workspaceId: string, opts?: { create?: boolean }) =>
      ensureWorkspaceMainSession(workspaceId, opts),
  );
  handleTrustedIpc(
    "workspace:listMainSessions",
    ["main"],
    async (_event, workspaceId: string, appId?: string | null) =>
      listWorkspaceMainSessions(workspaceId, appId ?? null),
  );
  handleTrustedIpc(
    "workspace:createMainSession",
    ["main"],
    async (_event, workspaceId: string, payload?: CreateMainSessionPayload) =>
      createWorkspaceMainSession(workspaceId, payload ?? {}),
  );
  handleTrustedIpc(
    "workspace:activateMainSession",
    ["main"],
    async (_event, workspaceId: string, sessionId: string) =>
      activateWorkspaceMainSession(workspaceId, sessionId),
  );
  handleTrustedIpc(
    "workspace:updateMainSession",
    ["main"],
    async (
      _event,
      workspaceId: string,
      sessionId: string,
      payload: UpdateMainSessionPayload,
    ) => updateWorkspaceMainSession(workspaceId, sessionId, payload),
  );
  handleTrustedIpc(
    "workspace:deleteMainSession",
    ["main"],
    async (_event, workspaceId: string, sessionId: string) =>
      deleteWorkspaceMainSession(workspaceId, sessionId),
  );
  handleTrustedIpc(
    "workspace:listProjects",
    ["main"],
    async (_event, workspaceId: string) => listWorkspaceProjects(workspaceId),
  );
  handleTrustedIpc(
    "workspace:getConfigYaml",
    ["main"],
    async (_event, workspaceId: string) => getWorkspaceConfigYaml(workspaceId),
  );
  handleTrustedIpc(
    "workspace:listMcpServers",
    ["main"],
    async (_event, workspaceId: string) => listWorkspaceMcpServers(workspaceId),
  );
  handleTrustedIpc(
    "workspace:deleteMcpServer",
    ["main"],
    async (_event, workspaceId: string, serverId: string) =>
      deleteWorkspaceMcpServer(workspaceId, serverId),
  );
  handleTrustedIpc(
    "workspace:refreshMcpTools",
    ["main"],
    async (_event, workspaceId: string) => refreshWorkspaceMcpTools(workspaceId),
  );
  handleTrustedIpc(
    "workspace:authorizeMcpServer",
    ["main"],
    async (
      _event,
      workspaceId: string,
      serverId: string,
      reauthorize?: boolean,
    ) => authorizeWorkspaceMcpServer(workspaceId, serverId, reauthorize === true),
  );
  handleTrustedIpc(
    "workspace:mcpServerAuthorized",
    ["main"],
    async (_event, workspaceId: string, serverId: string) =>
      mcpServerAuthorized(workspaceId, serverId),
  );
  handleTrustedIpc(
    "workspace:listHarnessAvailability",
    ["main"],
    async (_event, workspaceId: string) => listHarnessAvailability(workspaceId),
  );
  handleTrustedIpc(
    "workspace:testHarnessConnection",
    ["main"],
    async (_event, workspaceId: string, harnessId: string) =>
      testHarnessConnection(workspaceId, harnessId),
  );
  handleTrustedIpc(
    "workspace:updateSessionHarness",
    ["main"],
    async (
      _event,
      workspaceId: string,
      sessionId: string,
      harnessId: string,
    ) => updateWorkspaceSessionHarness(workspaceId, sessionId, harnessId),
  );
  handleTrustedIpc(
    "workspace:createProject",
    ["main"],
    async (
      _event,
      workspaceId: string,
      payload: CreateWorkspaceProjectPayload,
    ) => createWorkspaceProject(workspaceId, payload),
  );
  handleTrustedIpc(
    "workspace:updateProject",
    ["main"],
    async (
      _event,
      workspaceId: string,
      projectId: string,
      payload: UpdateWorkspaceProjectPayload,
    ) => updateWorkspaceProject(workspaceId, projectId, payload),
  );
  handleTrustedIpc(
    "workspace:deleteProject",
    ["main"],
    async (_event, workspaceId: string, projectId: string) =>
      deleteWorkspaceProject(workspaceId, projectId),
  );
  handleTrustedIpc(
    "workspace:pickProjectFolder",
    ["main"],
    async (event) => pickProjectFolder(event),
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
    "workspace:listTurnResults",
    ["main"],
    async (_event, payload: SessionTurnResultListRequestPayload) =>
      listTurnResults(payload),
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
    "workspace:pauseSessionRun",
    ["main"],
    async (_event, payload: HolabossPauseSessionRunPayload) =>
      pauseSessionRun(payload),
  );
  handleTrustedIpc(
    "workspace:answerUserQuestion",
    ["main"],
    async (_event, payload: HolabossAnswerUserQuestionPayload) =>
      answerSessionUserQuestion(payload),
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
  // HolaEmployee desktop chat (server-side employees over the authed gateway).
  handleTrustedIpc("holaemployee:listEmployees", ["main"], async () =>
    listHolaEmployees(),
  );
  handleTrustedIpc(
    "holaemployee:listThreads",
    ["main"],
    async (_event, employeeId: string) => listHolaEmployeeThreads(employeeId),
  );
  handleTrustedIpc(
    "holaemployee:threadHistory",
    ["main"],
    async (_event, employeeId: string, threadId: string) =>
      holaEmployeeThreadHistory(employeeId, threadId),
  );
  handleTrustedIpc(
    "holaemployee:getEquipment",
    ["main"],
    async (_event, employeeId: string) => holaEmployeeEquipment(employeeId),
  );
  handleTrustedIpc(
    "holaemployee:openChatStream",
    ["main"],
    async (
      _event,
      payload: { employeeId: string; threadId: string; message: string },
    ) => openHolaEmployeeChatStream(payload),
  );
  handleTrustedIpc(
    "holaemployee:closeChatStream",
    ["main"],
    async (_event, streamId: string) => closeHolaEmployeeChatStream(streamId),
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
    "workspace:readMemoryBrowserNodeDetail",
    ["main"],
    async (
      _event,
      workspaceId: string,
      params: { nodeId: string; treeId?: string | null },
    ) => readMemoryBrowserNodeDetail(workspaceId, params),
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
  handleTrustedIpc(
    "workspace:composioListConnections",
    ["main"],
    async (_event, force?: boolean) => composioListConnections(force ?? false),
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
    "workspace:composioConnect",
    ["main"],
    async (
      _event,
      payload: {
        provider: string;
        owner_user_id: string;
        callback_url?: string;
        whoami?: PendingIntegrationWhoami | null;
        auth_scheme?: string;
        credentials?: Record<string, string>;
      },
    ) => composioConnect(payload),
  );
  handleTrustedIpc(
    "workspace:composioToolkitAuth",
    ["main"],
    async (_event, toolkitSlug: string) => composioToolkitAuth(toolkitSlug),
  );
  handleTrustedIpc(
    "workspace:composioReconnect",
    ["main"],
    async (_event, connectedAccountId: string) =>
      composioReconnect(connectedAccountId),
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
        if (isProviderAuthFailure(err)) {
          return expiredComposioStatus(connectedAccountId);
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
          // This runs while the user types a name. The fallback below is the
          // intended behaviour on a bad backend, but without a deadline it was
          // unreachable for undici's full 300s.
          signal: AbortSignal.timeout(5_000),
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
  handleTrustedIpc("diagnostics:exportBundle", ["main"], async () =>
    exportDesktopDiagnosticsBundle(),
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
        canCloseAll?: boolean;
        hasDeleteFile: boolean;
      },
    ): Promise<
      | "close"
      | "closeOthers"
      | "closeToLeft"
      | "closeToRight"
      | "closeAll"
      | "deleteFile"
      | null
    > => {
      type Action =
        | "close"
        | "closeOthers"
        | "closeToLeft"
        | "closeToRight"
        | "closeAll"
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
          {
            label: "Close all tabs",
            enabled: opts.canCloseAll !== false,
            click: () => finish("closeAll"),
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
  createMainWindow();
  configureAutoUpdater();
  scheduleAppUpdateChecks();
  void checkForAppUpdates();
  await ensureDesktopBrowserServiceStarted();
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
})
  .catch((error) => {
    // Anything still escaping the chain is unexpected and leaves the app with
    // no window and no explanation. Registering process-level handlers
    // suppresses Electron's own error dialog, so without this the failure is
    // completely silent: a dock icon that does nothing.
    const detail =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    // eslint-disable-next-line no-console
    console.error("[boot] app.whenReady failed", error);
    void appendRuntimeLog(`[boot] app.whenReady failed: ${detail}`).catch(
      () => undefined,
    );
    try {
      dialog.showErrorBox(
        "holaOS couldn't finish starting",
        `${detail}\n\nThe log is in runtime.log; Help → Export diagnostics collects it.`,
      );
    } catch {
      // A dialog this early can itself fail; the log above is the fallback.
    }
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (appQuitCleanupFinished || appUpdateInstallInProgress) {
    return;
  }
  event.preventDefault();
  void ensureAppQuitCleanup().finally(() => {
    app.quit();
  });
});
