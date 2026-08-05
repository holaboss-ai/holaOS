/**
 * Open-core SEAM for the enterprise fingerprint (anti-detect) browser engine.
 *
 * This file is OSS (MIT) and ships in the public core. It defines the interface
 * an engine must satisfy and loads the LICENSED implementation
 * (`@holaboss/fingerprint-ee`, a separate/gitignored package) at RUNTIME. When the
 * package is absent — every plain OSS build — `loadFingerprintEngine()` returns
 * null and callers fall back to the Contact-Sales flow. Nothing here depends on the
 * enterprise package at build time.
 *
 * Two ways the engine attaches (both optional; absent → Contact Sales):
 *   1. BUILD-TIME — the package present in `node_modules` (bare specifier below).
 *   2. RUNTIME PLUGIN — a self-contained prebuilt engine bundle (its `dist/` plus
 *      its `node_modules/`) dropped into `<userData>/fingerprint-ee/` (or the dir
 *      named by `$HOLABOSS_FINGERPRINT_ENGINE_PATH`), loaded by ABSOLUTE PATH. This
 *      lets an already-released OSS app gain the feature with NO rebuild.
 *
 * Build note: the bare specifier is held in a variable so bundlers don't resolve it
 * statically (it's absent in OSS builds); treat `@holaboss/fingerprint-ee` as
 * external/optional.
 */
import { app } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { BrowserContext } from "playwright-core";

import type {
  ProfileFingerprint,
  ProfileProxy,
} from "../../shared/browser-pane-protocol.js";

/** A cookie in the engine-neutral shape (1:1 with Playwright `addCookies`). */
export interface EngineCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
}

/** One external identity resolved from an import source (e.g. an AdsPower export). */
export interface ImportedProfile {
  name: string;
  group?: string;
  fingerprint: ProfileFingerprint;
  proxy?: ProfileProxy;
  cookies: EngineCookie[];
  startupUrls: string[];
  warnings: string[];
  source: "adspower";
}

export interface EngineBinaryStatus {
  available: boolean;
  version?: string;
  error?: string;
}

/**
 * Host-product branding for the shared browser bundle (dock name + app icon). The
 * OSS core supplies the identity; the engine stamps it onto the Camoufox.app so a
 * launched profile presents as the product, not "Camoufox". (Product owns the
 * brand policy; the engine owns the mechanism.)
 */
export interface BundleBranding {
  name?: string;
  icnsPath?: string;
}

export interface LaunchProfileInput {
  id: string;
  name: string;
  fingerprint: ProfileFingerprint;
  proxy?: ProfileProxy | null;
  headless?: boolean;
  userDataDir?: string;
  branding?: BundleBranding;
}

export interface LaunchedProfileBrowser {
  readonly browserType: "firefox" | "chromium";
  /** The live, in-process persistent context to drive (same playwright-core). */
  readonly context: BrowserContext;
  close(): Promise<void>;
}

/** The contract the enterprise package's `createCamoufoxEngine()` satisfies. */
export interface FingerprintBrowserEngine {
  readonly id: string;
  ensureBinary(): Promise<EngineBinaryStatus>;
  launch(input: LaunchProfileInput): Promise<LaunchedProfileBrowser>;
  importProfiles(fileBytes: Uint8Array): Promise<ImportedProfile[]>;
}

/** Shape of the enterprise package's default entry (a subset we call). */
interface EnterpriseModule {
  createCamoufoxEngine(): FingerprintBrowserEngine;
}

const ENTERPRISE_MODULE_ID = "@holaboss/fingerprint-ee";

// --- Runtime plugin path -----------------------------------------------------
//
// A drop-in engine bundle for an already-released app lives at:
//     <dir>/dist/index.js  +  <dir>/dist/service-client.js
// with the engine's own `node_modules/` beside `dist/` (self-contained, so the
// forked service child — a plain node process — resolves camoufox-js/etc. there).
// `dir` = $HOLABOSS_FINGERPRINT_ENGINE_PATH or `<userData>/fingerprint-ee`.

function pluginEngineDir(): string | null {
  const override = process.env.HOLABOSS_FINGERPRINT_ENGINE_PATH?.trim();
  if (override) {
    return override;
  }
  try {
    return path.join(app.getPath("userData"), "fingerprint-ee");
  } catch {
    return null; // Electron app not ready yet — no userData path
  }
}

/** Absolute path to a built entry in the plugin bundle, if the file exists. */
function pluginEntry(name: "index" | "service-client"): string | null {
  const dir = pluginEngineDir();
  if (!dir) {
    return null;
  }
  const abs = path.join(dir, "dist", `${name}.js`);
  return existsSync(abs) ? abs : null;
}

let cached: FingerprintBrowserEngine | null | undefined;

/**
 * Load the enterprise engine — from `node_modules` (build-time attach) OR a runtime
 * plugin drop-in — else null. Cached (incl. the null, so OSS builds don't retry).
 */
export async function loadFingerprintEngine(): Promise<FingerprintBrowserEngine | null> {
  if (cached !== undefined) {
    return cached;
  }
  cached = null;
  try {
    const mod = (await import(ENTERPRISE_MODULE_ID)) as EnterpriseModule; // build-time attach
    if (typeof mod.createCamoufoxEngine === "function") {
      cached = mod.createCamoufoxEngine();
      return cached;
    }
  } catch {
    // not in node_modules — fall through to the runtime plugin path
  }
  const entry = pluginEntry("index");
  if (entry) {
    try {
      const mod = (await import(pathToFileURL(entry).href)) as EnterpriseModule;
      if (typeof mod.createCamoufoxEngine === "function") {
        cached = mod.createCamoufoxEngine();
      }
    } catch {
      // a bundle is present but failed to load → leave the feature off
    }
  }
  return cached;
}

/** True when a licensed engine is loaded — gate main-process feature paths on this. */
export function isFingerprintEngineAvailable(): boolean {
  return Boolean(cached);
}

/**
 * Cheap synchronous check for the renderer's UI gate: is an engine ATTACHED —
 * already loaded, or a plugin drop-in present on disk? No heavy import. (A build-
 * time attach is surfaced instead by the build-time `FEATURES.fingerprintBrowser`.)
 */
export function isFingerprintEnginePresent(): boolean {
  return Boolean(cached) || pluginEntry("index") !== null;
}

// --- Standalone fingerprint SERVICE client ----------------------------------
//
// The full "fingerprint browser is its own app" surface: the enterprise engine
// runs in its OWN process (crash-isolated, off the Electron main thread) and the
// core drives it entirely over IPC through this client. Mirrors the enterprise
// `FingerprintServiceClient`; structural typing keeps the two sides compatible.

export interface ServicePageInfo {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface ServiceCookie {
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

export interface ServiceKeyboardOpts {
  action: "press" | "insert_text";
  text?: string;
  key?: string;
  clear?: boolean;
  submit?: boolean;
}

export interface FingerprintServiceClient {
  /** `restoredTabs` = how many previous-session tabs the service reopened. */
  launch(input: LaunchProfileInput): Promise<{ ok: boolean; restoredTabs?: number }>;
  close(id: string): Promise<void>;
  running(): Promise<string[]>;
  isLive(id: string): Promise<boolean>;
  importProfiles(bytes: Uint8Array): Promise<ImportedProfile[]>;
  navigate(id: string, url: string, sessionId?: string | null): Promise<void>;
  evaluate(id: string, expression: string, sessionId?: string | null): Promise<unknown>;
  pageInfo(id: string, sessionId?: string | null): Promise<ServicePageInfo>;
  openTab(id: string, url: string, sessionId?: string | null): Promise<ServicePageInfo>;
  screenshot(
    id: string,
    options?: { fullPage?: boolean; format?: "png" | "jpeg"; quality?: number },
    sessionId?: string | null,
  ): Promise<Buffer>;
  mouse(
    id: string,
    x: number,
    y: number,
    action: "click" | "double_click" | "hover" | "context",
    sessionId?: string | null,
  ): Promise<void>;
  keyboard(id: string, opts: ServiceKeyboardOpts, sessionId?: string | null): Promise<void>;
  cookies(
    id: string,
    filter: { url?: string; name?: string; domain?: string },
    sessionId?: string | null,
  ): Promise<ServiceCookie[]>;
  setCookie(id: string, cookie: Record<string, unknown>): Promise<void>;
  addCookies(id: string, cookies: EngineCookie[]): Promise<{ added: number }>;
  onRunningChanged(cb: (ids: string[]) => void): void;
  dispose(): void;
}

interface EnterpriseServiceModule {
  createFingerprintServiceClient(): FingerprintServiceClient;
}

// A subpath into the enterprise package that pulls ONLY the lightweight service
// CLIENT (a `fork()` wrapper — ~2ms to load). We deliberately DON'T import the
// package barrel here: its `createCamoufoxEngine` re-export eagerly evaluates
// camoufox-js + exceljs + playwright (~0.5s) on the MAIN thread, which the main
// process never needs (all that runs in the forked service). Importing the barrel
// on a Launch click is what stalls the UI. Held in a variable so bundlers treat
// the optional package as an external runtime import.
const ENTERPRISE_SERVICE_MODULE_ID = "@holaboss/fingerprint-ee/service-client";

let cachedService: FingerprintServiceClient | null | undefined;

/**
 * Spawn (once) and return the enterprise fingerprint service, or null when the
 * licensed package is absent (OSS builds). Cached — the service process is a
 * singleton for the app's lifetime.
 */
export async function loadFingerprintService(): Promise<FingerprintServiceClient | null> {
  if (cachedService !== undefined) {
    return cachedService;
  }
  cachedService = null;
  try {
    const mod = (await import(ENTERPRISE_SERVICE_MODULE_ID)) as EnterpriseServiceModule; // build-time
    if (typeof mod.createFingerprintServiceClient === "function") {
      cachedService = mod.createFingerprintServiceClient();
      return cachedService;
    }
  } catch {
    // not in node_modules — fall through to the runtime plugin path
  }
  const entry = pluginEntry("service-client");
  if (entry) {
    try {
      const mod = (await import(pathToFileURL(entry).href)) as EnterpriseServiceModule;
      if (typeof mod.createFingerprintServiceClient === "function") {
        cachedService = mod.createFingerprintServiceClient();
      }
    } catch {
      // a bundle is present but failed to load
    }
  }
  return cachedService;
}
