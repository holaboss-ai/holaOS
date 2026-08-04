/**
 * Wire types for the browser-pane subsystem. Shared between Electron main
 * and renderer (and the popup preload bundles) so the IPC contract has one
 * source of truth.
 *
 * Existing inline interfaces in `desktop/src/types/electron.d.ts` (declared
 * as ambient globals there: BrowserBoundsPayload, BrowserStatePayload, ...)
 * are gradually migrated into this module so they can be imported across
 * the main process side as well. For now we re-export the renderer-visible
 * ones from here as concrete types.
 */

// Single-member alias kept to avoid churning every `space` parameter signature.
// The former "user" (global) space was removed; all tabs are session-owned, with
// `spaces.agent` serving as the sessionless default bucket.
export type BrowserSpaceId = "agent";

export interface BrowserBoundsPayload {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserAnchorBoundsPayload {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserStatePayload {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  initialized: boolean;
  // main's ambient global declares this as `error: string`. Keep
  // structurally compatible.
  error: string;
}

export interface BrowserTabCountsPayload {
  agent: number;
}

// Match main.ts's ambient declaration which uses a narrower set + null variant.
export type BrowserTabLifecycleState = "active" | "suspended" | null;

export type BrowserControlMode = "none" | "session_owned";

export interface BrowserTabListPayload {
  space: BrowserSpaceId;
  activeTabId: string;
  tabs: BrowserStatePayload[];
  tabCounts: BrowserTabCountsPayload;
  // main's ambient global allows null when no session is bound.
  sessionId: string | null;
  lifecycleState: BrowserTabLifecycleState;
  controlMode: BrowserControlMode;
  controlSessionId: string | null;
}

export interface BrowserVisibleSnapshotPayload {
  bounds: BrowserBoundsPayload;
  dataUrl: string;
}

export interface BrowserBookmarkPayload {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
  folderPath?: string[];
  createdAt: string;
}

export interface BrowserDownloadPayload {
  id: string;
  url: string;
  filename: string;
  targetPath: string | null;
  status: "in_progress" | "completed" | "cancelled" | "failed";
  receivedBytes: number;
  totalBytes: number;
  createdAt: string;
  completedAt: string | null;
}

export interface BrowserHistoryEntryPayload {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
  visitCount: number;
  createdAt: string;
  lastVisitedAt: string;
}

export interface BrowserClipboardScreenshotPayload {
  tabId: string;
  pageTitle: string;
  url: string;
  width: number;
  height: number;
  copied: boolean;
}

export interface AddressSuggestionPayload {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
}

// =============================================================================
// Browser profiles
// =============================================================================

/** How a Browser Profile came to exist. */
export type BrowserProfileSource = "created" | "imported";

/**
 * A first-class, user-managed browsing identity with its own persistent
 * Electron partition, decoupled from any workspace. The `id` carries the
 * `bprofile_` prefix (see `browser-pane/utils` `BROWSER_PROFILE_ID_PREFIX`).
 */
export interface BrowserProfile {
  id: string;
  name: string;
  createdAt: string;
  source: BrowserProfileSource;
  /** When `source === "imported"`, a human label of the origin (e.g. "Chrome — Default"). */
  importedFrom?: string;
  /**
   * The remote-debugging port this profile's Chrome binds to, assigned once (on
   * first launch) and persisted so it stays STABLE across app restarts — the
   * adopt-if-reachable path reconnects to it. Assigned collision-free across
   * profiles (distinct profiles never share a port); absent until first launch.
   */
  debugPort?: number;
  /**
   * Which engine drives this profile: `system` = the OS Chrome/Edge/… (default,
   * keeps real logins), `fingerprint` = the enterprise anti-detect engine
   * (Camoufox, run out-of-process) that spoofs `fingerprint`.
   */
  engine?: ProfileEngine;
  /** The spoofed fingerprint for a `fingerprint` profile (ignored when `system`). */
  fingerprint?: ProfileFingerprint;
  /** Per-profile network identity (proxy), independent of the fingerprint. */
  proxy?: ProfileProxy;
  /**
   * Whether this profile is the pinned "default browser" the agent drives when a
   * tool names none. DERIVED from the index's `defaultProfileId` and set only on
   * profiles sent to the renderer — never persisted onto the stored profile.
   */
  isDefault?: boolean;
}

/** The engine that drives a profile. */
export type ProfileEngine = "system" | "fingerprint";

/** OS a fingerprint presents as (`--fingerprint-platform`). */
export type FingerprintPlatform = "windows" | "macos" | "linux";

/** Browser brand a fingerprint presents as (`--fingerprint-brand`). */
export type FingerprintBrand = "Chrome" | "Edge" | "Opera" | "Vivaldi";

/**
 * A spoofed browser fingerprint, materialised into the fingerprint engine's config
 * (Camoufox, applied out-of-process). `seed` is the master identity (canvas/WebGL/
 * audio noise derive from it deterministically); the optional fields explicitly
 * override individual seed-derived values. Every field is validated on all
 * set-paths (untrusted-import safety) — see `sanitizeFingerprint`.
 */
export interface ProfileFingerprint {
  /** Master seed → returning identity. Stable per profile (10000–99999). */
  seed: number;
  platform: FingerprintPlatform;
  gpuVendor?: string; // WebGL UNMASKED_VENDOR_WEBGL
  gpuRenderer?: string; // WebGL UNMASKED_RENDERER_WEBGL
  hardwareConcurrency?: number; // navigator.hardwareConcurrency
  deviceMemory?: number; // navigator.deviceMemory (GB)
  screenWidth?: number;
  screenHeight?: number;
  brand?: FingerprintBrand;
  brandVersion?: string;
  platformVersion?: string; // Client Hints platform version
  timezone?: string; // IANA, e.g. "America/New_York"
  locale?: string; // BCP-47, e.g. "en-US"
  noise?: boolean; // false → --fingerprint-noise=false
  webrtcIp?: string; // "auto" | explicit IP
  fontsDir?: string;
  storageQuota?: number; // MB
}

/** Per-profile proxy. `geoip` matches timezone/locale/WebRTC-IP to the exit IP. */
export interface ProfileProxy {
  server: string; // "http://host:port" | "socks5://host:port"
  username?: string;
  password?: string;
  geoip?: boolean;
}

/**
 * A named, reusable fingerprint — the building block of the AdsPower-style
 * workflow (apply to a profile / import / share). Carries the fingerprint WITHOUT
 * a per-profile seed, unless it pins one to reproduce an exact identity (a clone
 * or a `captured` real device).
 */
export interface FingerprintTemplate {
  id: string; // ftpl_<uuid>
  name: string;
  createdAt: string;
  source: "builtin" | "imported" | "captured" | "user";
  fingerprint: Omit<ProfileFingerprint, "seed"> & { seed?: number };
}
