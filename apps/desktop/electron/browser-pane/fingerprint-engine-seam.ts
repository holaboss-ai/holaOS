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
 * Build note: the import specifier is held in a variable so bundlers don't try to
 * resolve it statically (which would break the OSS build where it's absent). The
 * main-process bundler must treat `@holaboss/fingerprint-ee` as external/optional.
 */
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

let cached: FingerprintBrowserEngine | null | undefined;

/**
 * Load the enterprise engine if the licensed package is present, else null.
 * Cached after the first call (including the null result, so OSS builds don't
 * retry the import on every profile action).
 */
export async function loadFingerprintEngine(): Promise<FingerprintBrowserEngine | null> {
  if (cached !== undefined) {
    return cached;
  }
  try {
    const mod = (await import(ENTERPRISE_MODULE_ID)) as EnterpriseModule;
    cached = typeof mod.createCamoufoxEngine === "function" ? mod.createCamoufoxEngine() : null;
  } catch {
    // Absent (OSS build) or failed to load → feature is off; caller shows Contact Sales.
    cached = null;
  }
  return cached;
}

/** True when a licensed engine is loaded — gate main-process feature paths on this. */
export function isFingerprintEngineAvailable(): boolean {
  return Boolean(cached);
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
  try {
    const mod = (await import(ENTERPRISE_SERVICE_MODULE_ID)) as EnterpriseServiceModule;
    cachedService =
      typeof mod.createFingerprintServiceClient === "function"
        ? mod.createFingerprintServiceClient()
        : null;
  } catch {
    cachedService = null;
  }
  return cachedService;
}
