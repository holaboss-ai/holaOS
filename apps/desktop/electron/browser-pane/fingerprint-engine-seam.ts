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

export interface LaunchProfileInput {
  id: string;
  name: string;
  fingerprint: ProfileFingerprint;
  proxy?: ProfileProxy | null;
  headless?: boolean;
  userDataDir?: string;
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
