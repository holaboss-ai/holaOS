/**
 * Pure fingerprint logic for `cloak`-engine Browser Profiles.
 *
 * Leaf-level (no electron, no fs, no clock) so it's unit-testable and shared by
 * the launcher (main.ts turns a fingerprint into `--fingerprint-*` flags) and,
 * later, the renderer's flag preview. See docs/cdp/fingerprint-profiles.md.
 *
 * SECURITY: every fingerprint field is interpolated into a browser command-line
 * flag. `sanitizeFingerprint` is the mandatory gate on ALL set-paths (import,
 * paste, adapter, manual edit) — key-whitelist + enum + range-clamp + charset +
 * length caps — so an untrusted template can never inject a flag or a
 * pathological value. `buildFingerprintArgs` assumes it was given sanitized data.
 */
import type {
  FingerprintBrand,
  FingerprintPlatform,
  ProfileFingerprint,
  ProfileProxy,
} from "../../shared/browser-pane-protocol.js";

/** Fingerprint seed range → a returning identity when fixed. */
export const FINGERPRINT_SEED_MIN = 10000;
export const FINGERPRINT_SEED_MAX = 99999;

const PLATFORMS: readonly FingerprintPlatform[] = ["windows", "macos", "linux"];
const BRANDS: readonly FingerprintBrand[] = [
  "Chrome",
  "Edge",
  "Opera",
  "Vivaldi",
];

// --- Flag builder -----------------------------------------------------------

/**
 * Materialise a (sanitized) fingerprint into CloakBrowser stealth flags. Omitted
 * fields fall through to seed-derived binary defaults. `--fingerprint` +
 * `--fingerprint-platform` are the baseline.
 *
 * We deliberately do NOT emit `--no-sandbox` (CloakBrowser's Docker/Linux-root
 * default): on a headed desktop it shows an "unsupported command-line flag"
 * infobar, disables the sandbox, and is itself a bot tell — the exact opposite of
 * what a stealth browser wants. The binary runs sandboxed fine on macOS/Windows.
 */
export function buildFingerprintArgs(fp: ProfileFingerprint): string[] {
  const args = [
    `--fingerprint=${fp.seed}`,
    `--fingerprint-platform=${fp.platform}`,
  ];
  const push = (flag: string, value: unknown) => {
    if (value !== undefined && value !== "") {
      args.push(`${flag}=${value}`);
    }
  };
  push("--fingerprint-gpu-vendor", fp.gpuVendor);
  push("--fingerprint-gpu-renderer", fp.gpuRenderer);
  push("--fingerprint-hardware-concurrency", fp.hardwareConcurrency);
  push("--fingerprint-device-memory", fp.deviceMemory);
  push("--fingerprint-screen-width", fp.screenWidth);
  push("--fingerprint-screen-height", fp.screenHeight);
  push("--fingerprint-brand", fp.brand);
  push("--fingerprint-brand-version", fp.brandVersion);
  push("--fingerprint-platform-version", fp.platformVersion);
  push("--fingerprint-timezone", fp.timezone);
  push("--fingerprint-locale", fp.locale);
  push("--fingerprint-storage-quota", fp.storageQuota);
  push("--fingerprint-fonts-dir", fp.fontsDir);
  push("--fingerprint-webrtc-ip", fp.webrtcIp);
  if (fp.noise === false) {
    args.push("--fingerprint-noise=false");
  }
  return args;
}

/** A minimal fingerprint: just an identity seed + a platform. */
export function defaultFingerprint(
  seed: number,
  platform: FingerprintPlatform,
): ProfileFingerprint {
  return { seed, platform };
}

// --- Sanitize (the untrusted-input gate) ------------------------------------

/**
 * Chrome flag values are spawned via an argv array (no shell), so the risk is
 * flag-parsing confusion, not shell injection. We still hard-reject control
 * chars, `=`, and a leading `--` (so a value can never masquerade as a second
 * flag) and cap length. The allow-list covers real GPU/brand strings, e.g.
 * "Google Inc. (NVIDIA)" and "ANGLE (NVIDIA, ... Direct3D11 vs_5_0 ps_5_0)".
 */
const SAFE_TEXT = /^[A-Za-z0-9 .,()\-/_:+#]*$/;
const IANA_TZ = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/;
const BCP47 = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const IPISH = /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9A-Fa-f:]+$/;

function safeText(v: unknown, maxLen: number): string | null {
  if (typeof v !== "string") {
    return null;
  }
  const s = v.trim();
  if (!s || s.length > maxLen || s.startsWith("--") || s.includes("=")) {
    return null;
  }
  return SAFE_TEXT.test(s) ? s : null;
}

function intInRange(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    return null;
  }
  return n;
}

export interface SanitizeFingerprintResult {
  value: Partial<ProfileFingerprint>;
  /** One message per field that was dropped as invalid. */
  warnings: string[];
}

/**
 * Coerce arbitrary (possibly untrusted) input into a partial fingerprint,
 * keeping ONLY well-formed known fields and reporting what was dropped. Never
 * throws. Unknown keys are ignored — nothing outside the whitelist survives.
 */
export function sanitizeFingerprint(raw: unknown): SanitizeFingerprintResult {
  const warnings: string[] = [];
  const value: Partial<ProfileFingerprint> = {};
  if (!raw || typeof raw !== "object") {
    return { value, warnings: ["fingerprint is not an object"] };
  }
  const r = raw as Record<string, unknown>;
  const drop = (k: string) => warnings.push(`dropped invalid ${k}`);
  const keep = <K extends keyof ProfileFingerprint>(
    k: K,
    parsed: ProfileFingerprint[K] | null,
  ) => {
    if (r[k] === undefined) {
      return;
    }
    if (parsed === null) {
      drop(k);
    } else {
      value[k] = parsed;
    }
  };

  keep("seed", intInRange(r.seed, FINGERPRINT_SEED_MIN, FINGERPRINT_SEED_MAX));
  keep(
    "platform",
    PLATFORMS.includes(r.platform as FingerprintPlatform)
      ? (r.platform as FingerprintPlatform)
      : null,
  );
  keep(
    "brand",
    BRANDS.includes(r.brand as FingerprintBrand)
      ? (r.brand as FingerprintBrand)
      : null,
  );
  keep("gpuVendor", safeText(r.gpuVendor, 128));
  keep("gpuRenderer", safeText(r.gpuRenderer, 256));
  keep("brandVersion", safeText(r.brandVersion, 32));
  keep("platformVersion", safeText(r.platformVersion, 32));
  keep("hardwareConcurrency", intInRange(r.hardwareConcurrency, 1, 64));
  keep("deviceMemory", intInRange(r.deviceMemory, 1, 64));
  keep("screenWidth", intInRange(r.screenWidth, 640, 7680));
  keep("screenHeight", intInRange(r.screenHeight, 480, 4320));
  keep("storageQuota", intInRange(r.storageQuota, 0, 1_000_000));

  const tz = typeof r.timezone === "string" ? r.timezone.trim() : "";
  keep("timezone", tz && tz.length <= 64 && IANA_TZ.test(tz) ? tz : null);
  const loc = typeof r.locale === "string" ? r.locale.trim() : "";
  keep("locale", loc && loc.length <= 35 && BCP47.test(loc) ? loc : null);
  const wip = typeof r.webrtcIp === "string" ? r.webrtcIp.trim() : "";
  keep(
    "webrtcIp",
    wip === "auto" || (wip && wip.length <= 45 && IPISH.test(wip)) ? wip : null,
  );
  const fonts = typeof r.fontsDir === "string" ? r.fontsDir.trim() : "";
  keep(
    "fontsDir",
    fonts &&
      fonts.length <= 1024 &&
      !fonts.startsWith("--") &&
      !/[=\n\r\0]/.test(fonts)
      ? fonts
      : null,
  );
  keep("noise", typeof r.noise === "boolean" ? r.noise : null);

  return { value, warnings };
}

/**
 * Sanitize AND require a usable identity (`seed` + `platform`). Returns a full
 * fingerprint or null — used when loading persisted profiles.
 */
export function coerceFingerprint(raw: unknown): ProfileFingerprint | null {
  const { value } = sanitizeFingerprint(raw);
  if (typeof value.seed !== "number" || value.platform === undefined) {
    return null;
  }
  return value as ProfileFingerprint;
}

/** Validate + normalise a per-profile proxy, or null if unusable. */
export function sanitizeProxy(raw: unknown): ProfileProxy | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const server = typeof r.server === "string" ? r.server.trim() : "";
  if (!server || server.length > 512 || /[\s\n\r\0]/.test(server)) {
    return null;
  }
  const proxy: ProfileProxy = { server };
  if (typeof r.username === "string" && r.username.length <= 256) {
    proxy.username = r.username;
  }
  if (typeof r.password === "string" && r.password.length <= 256) {
    proxy.password = r.password;
  }
  if (typeof r.geoip === "boolean") {
    proxy.geoip = r.geoip;
  }
  return proxy;
}

// --- Coherence (a soft detection safeguard) ---------------------------------

/**
 * Non-blocking warnings for internally inconsistent fingerprints — mismatches
 * are themselves a bot tell. Surfaced in the editor; never rejects.
 */
export function validateFingerprintCoherence(fp: ProfileFingerprint): string[] {
  const w: string[] = [];
  const gpu = `${fp.gpuVendor ?? ""} ${fp.gpuRenderer ?? ""}`.toLowerCase();
  if (
    fp.platform === "macos" &&
    /(nvidia|direct3d|d3d11|angle \(nvidia|radeon)/.test(gpu)
  ) {
    w.push("macOS platform with a Windows/PC-style GPU (Direct3D/NVIDIA/Radeon)");
  }
  if (fp.platform === "windows" && /(apple|metal)/.test(gpu)) {
    w.push("Windows platform with an Apple/Metal GPU");
  }
  if (
    fp.locale &&
    fp.timezone &&
    /^en-US/i.test(fp.locale) &&
    !/^America\//.test(fp.timezone)
  ) {
    w.push(
      `en-US locale with ${fp.timezone} timezone — enable geoip to match the proxy`,
    );
  }
  return w;
}
