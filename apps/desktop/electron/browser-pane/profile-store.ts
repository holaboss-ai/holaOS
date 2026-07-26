/**
 * Pure metadata store for first-class Browser Profiles.
 *
 * This module owns ONLY the profile *catalogue* (names, ids, source) persisted
 * to `browser-profiles/index.json`. The actual browsing state (partition,
 * cookies, tabs) is a re-keyed browser-workspace managed by main.ts's existing
 * `ensureBrowserWorkspace` / `destroyBrowserWorkspace` lifecycle, keyed by the
 * profile id. Keeping this leaf-level (no electron, no fs, no clock) makes it
 * unit-testable; main.ts injects ids/timestamps and does the fs + session work.
 */
import type {
  BrowserProfile,
  BrowserProfileSource,
  FingerprintPlatform,
} from "../../shared/browser-pane-protocol.js";
import { coerceFingerprint, sanitizeProxy } from "./fingerprint.js";
import { BROWSER_PROFILE_ID_PREFIX, isBrowserProfileId } from "./utils.js";

/**
 * The fixed id + label of the always-present, undeletable profile. Its label was
 * historically "Default"; that word now names the *pinned* default selection
 * (`defaultProfileId`), so the permanent profile is labelled "Main" and existing
 * installs are migrated off the legacy name (see `ensureDefaultBrowserProfile`).
 */
export const DEFAULT_BROWSER_PROFILE_ID = `${BROWSER_PROFILE_ID_PREFIX}default`;
export const DEFAULT_BROWSER_PROFILE_NAME = "Main";
/** The permanent profile's pre-rename label, migrated to the current name on load. */
export const LEGACY_DEFAULT_BROWSER_PROFILE_NAME = "Default";

export interface BrowserProfileIndex {
  profiles: BrowserProfile[];
  /**
   * The profile the agent drives when a browser tool names none — the user's
   * "default browser". Points at the permanent profile until the user re-pins it
   * (see `setDefaultBrowserProfile` / `resolveDefaultBrowserProfileId`). Cleared
   * back to the permanent profile if the pinned one is deleted.
   */
  defaultProfileId?: string;
}

export function emptyBrowserProfileIndex(): BrowserProfileIndex {
  return { profiles: [] };
}

/**
 * Coerce arbitrary persisted JSON into a well-formed index: keep only entries
 * with a valid `bprofile_` id, dedupe by id, and normalise the rest.
 */
export function normalizeBrowserProfileIndex(raw: unknown): BrowserProfileIndex {
  const list =
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as { profiles?: unknown }).profiles)
      ? (raw as { profiles: unknown[] }).profiles
      : [];
  const profiles: BrowserProfile[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const candidate = entry as Partial<BrowserProfile>;
    if (typeof candidate.id !== "string" || !isBrowserProfileId(candidate.id)) {
      continue;
    }
    if (seen.has(candidate.id)) {
      continue;
    }
    const name =
      typeof candidate.name === "string" && candidate.name.trim()
        ? candidate.name.trim()
        : "Untitled profile";
    const source: BrowserProfileSource =
      candidate.source === "imported" ? "imported" : "created";
    const engine =
      candidate.engine === "cloak" || candidate.engine === "system"
        ? candidate.engine
        : undefined;
    // Re-validate on load: a persisted fingerprint/proxy is untrusted input too.
    const fingerprint = candidate.fingerprint
      ? coerceFingerprint(candidate.fingerprint)
      : null;
    const proxy = candidate.proxy ? sanitizeProxy(candidate.proxy) : null;
    profiles.push({
      id: candidate.id,
      name,
      createdAt:
        typeof candidate.createdAt === "string" ? candidate.createdAt : "",
      source,
      ...(typeof candidate.importedFrom === "string" && candidate.importedFrom
        ? { importedFrom: candidate.importedFrom }
        : {}),
      ...(typeof candidate.debugPort === "number" &&
      Number.isInteger(candidate.debugPort)
        ? { debugPort: candidate.debugPort }
        : {}),
      ...(engine ? { engine } : {}),
      ...(fingerprint ? { fingerprint } : {}),
      ...(proxy ? { proxy } : {}),
    });
    seen.add(candidate.id);
  }
  const rawDefault = (raw as { defaultProfileId?: unknown } | null)
    ?.defaultProfileId;
  const defaultProfileId =
    typeof rawDefault === "string" && isBrowserProfileId(rawDefault)
      ? rawDefault
      : undefined;
  return { profiles, ...(defaultProfileId ? { defaultProfileId } : {}) };
}

export interface AddBrowserProfileInput {
  /** Caller-generated id; must carry the `bprofile_` prefix. */
  id: string;
  name: string;
  /** ISO timestamp supplied by the caller (keeps this module clock-free). */
  now: string;
  source?: BrowserProfileSource;
  importedFrom?: string;
}

/** Append a profile; returns the new index + the created record. Dedupes by id. */
export function addBrowserProfile(
  index: BrowserProfileIndex,
  input: AddBrowserProfileInput,
): { index: BrowserProfileIndex; profile: BrowserProfile } {
  if (!isBrowserProfileId(input.id)) {
    throw new Error(`invalid browser profile id: ${input.id}`);
  }
  const profile: BrowserProfile = {
    id: input.id,
    name: input.name.trim() || "Untitled profile",
    createdAt: input.now,
    source: input.source ?? "created",
    ...(input.importedFrom ? { importedFrom: input.importedFrom } : {}),
  };
  const profiles = index.profiles.filter((p) => p.id !== input.id);
  profiles.push(profile);
  return { index: { ...index, profiles }, profile };
}

export function renameBrowserProfile(
  index: BrowserProfileIndex,
  id: string,
  name: string,
): BrowserProfileIndex {
  const trimmed = name.trim();
  if (!trimmed) {
    return index;
  }
  return {
    ...index,
    profiles: index.profiles.map((p) =>
      p.id === id ? { ...p, name: trimmed } : p,
    ),
  };
}

export function removeBrowserProfile(
  index: BrowserProfileIndex,
  id: string,
): BrowserProfileIndex {
  // If the deleted profile was the pinned default, drop the pin so resolution
  // falls back to the permanent profile.
  const defaultProfileId =
    index.defaultProfileId === id ? undefined : index.defaultProfileId;
  return {
    ...index,
    profiles: index.profiles.filter((p) => p.id !== id),
    defaultProfileId,
  };
}

/**
 * Pin `id` as the default profile the agent drives when a browser tool names
 * none. Unknown ids are ignored (the pin is left unchanged) so a stale caller
 * can't silently blank the default.
 */
export function setDefaultBrowserProfile(
  index: BrowserProfileIndex,
  id: string,
): BrowserProfileIndex {
  if (!index.profiles.some((p) => p.id === id)) {
    return index;
  }
  return { ...index, defaultProfileId: id };
}

/**
 * Resolve the concrete profile the agent should drive by default: the user's pin
 * if it still exists, else the permanent profile, else the first profile. Total
 * as long as the index has ≥1 profile (returns null only for an empty index).
 */
export function resolveDefaultBrowserProfileId(
  index: BrowserProfileIndex,
): string | null {
  const { defaultProfileId, profiles } = index;
  if (defaultProfileId && profiles.some((p) => p.id === defaultProfileId)) {
    return defaultProfileId;
  }
  if (profiles.some((p) => p.id === DEFAULT_BROWSER_PROFILE_ID)) {
    return DEFAULT_BROWSER_PROFILE_ID;
  }
  return profiles[0]?.id ?? null;
}

/**
 * Guarantee the invariants the rest of the app relies on, on every load:
 *   - the permanent profile exists (prepended if missing);
 *   - it's migrated off the legacy "Default" label to the current name (only when
 *     still untouched, so a user's own rename is preserved);
 *   - `defaultProfileId` resolves to a real profile — the user's pin if it still
 *     exists, otherwise the permanent profile.
 */
export function ensureDefaultBrowserProfile(
  index: BrowserProfileIndex,
  now: string,
): BrowserProfileIndex {
  let profiles = index.profiles;
  if (!profiles.some((p) => p.id === DEFAULT_BROWSER_PROFILE_ID)) {
    const defaultProfile: BrowserProfile = {
      id: DEFAULT_BROWSER_PROFILE_ID,
      name: DEFAULT_BROWSER_PROFILE_NAME,
      createdAt: now,
      source: "created",
    };
    profiles = [defaultProfile, ...profiles];
  } else {
    // One-time rename migration for existing installs.
    profiles = profiles.map((p) =>
      p.id === DEFAULT_BROWSER_PROFILE_ID &&
      p.name === LEGACY_DEFAULT_BROWSER_PROFILE_NAME
        ? { ...p, name: DEFAULT_BROWSER_PROFILE_NAME }
        : p,
    );
  }
  const defaultProfileId =
    index.defaultProfileId &&
    profiles.some((p) => p.id === index.defaultProfileId)
      ? index.defaultProfileId
      : DEFAULT_BROWSER_PROFILE_ID;
  return { ...index, profiles, defaultProfileId };
}

export function getBrowserProfile(
  index: BrowserProfileIndex,
  id: string,
): BrowserProfile | null {
  return index.profiles.find((p) => p.id === id) ?? null;
}

/**
 * Ensure a profile carries a fingerprint, seeding a minimal one (the given seed +
 * platform) if absent. Idempotent — an existing fingerprint is left untouched so
 * the profile's returning identity stays stable. `seed`/`platform` are injected
 * (this module stays clock/RNG-free); main.ts generates the random seed once, the
 * same way it injects timestamps and debug ports.
 */
export function ensureProfileFingerprint(
  index: BrowserProfileIndex,
  id: string,
  seed: number,
  platform: FingerprintPlatform,
): BrowserProfileIndex {
  return {
    ...index,
    profiles: index.profiles.map((p) =>
      p.id === id && !p.fingerprint
        ? { ...p, fingerprint: { seed, platform } }
        : p,
    ),
  };
}

// --- Remote-debugging port assignment ---------------------------------------
//
// Each profile's Chrome binds a fixed remote-debugging port so the agent can
// drive it over CDP, and so a Chrome that survived an app restart (our spawns
// are detached) can be reconnected to on relaunch. The port MUST be:
//   1. stable per profile across restarts (adopt-if-reachable relies on it), and
//   2. distinct across profiles — two profiles sharing a port is a real bug:
//      the second would either fail to bind or, worse, ADOPT the first profile's
//      Chrome, silently driving the wrong logged-in identity.
// A bare hash of the id gives (1) but not (2) — with N profiles over a 600-port
// range, collisions appear well before N is large. So we seed from the hash but
// linear-probe past ports already assigned to OTHER profiles, then persist the
// result onto the profile.

/** Inclusive lower bound of the debug-port range. */
export const BROWSER_PROFILE_DEBUG_PORT_MIN = 9300;
/** Number of ports in the range → [9300, 9899]. */
export const BROWSER_PROFILE_DEBUG_PORT_SPAN = 600;

/**
 * Deterministic *preferred* debug port for a profile — the collision-free seed
 * the assignment probes forward from. Purely a function of the id (stable), so
 * a lone profile always lands on the same port across restarts.
 */
export function preferredBrowserProfileDebugPort(profileId: string): number {
  let hash = 0;
  for (let i = 0; i < profileId.length; i += 1) {
    hash = (hash * 31 + profileId.charCodeAt(i)) >>> 0;
  }
  return (
    BROWSER_PROFILE_DEBUG_PORT_MIN + (hash % BROWSER_PROFILE_DEBUG_PORT_SPAN)
  );
}

/**
 * Resolve a STABLE, collision-free debug port for `profileId`, persisting it
 * onto the profile the first time. Returns the (possibly updated) index + port:
 *   - if the profile already carries a `debugPort`, it's returned unchanged;
 *   - otherwise we start from `preferredBrowserProfileDebugPort` and linear-probe
 *     forward (wrapping within the range) past every port already assigned to
 *     ANOTHER profile, then write the chosen port onto the profile.
 * Pure — the caller owns fs persistence. If the profile isn't in the index the
 * port is computed but not stored (nothing to attach it to).
 */
export function assignBrowserProfileDebugPort(
  index: BrowserProfileIndex,
  profileId: string,
): { index: BrowserProfileIndex; port: number } {
  const existing = getBrowserProfile(index, profileId);
  if (existing && typeof existing.debugPort === "number") {
    return { index, port: existing.debugPort };
  }

  const taken = new Set<number>();
  for (const profile of index.profiles) {
    if (profile.id !== profileId && typeof profile.debugPort === "number") {
      taken.add(profile.debugPort);
    }
  }

  const preferred = preferredBrowserProfileDebugPort(profileId);
  let port = preferred;
  for (let offset = 0; offset < BROWSER_PROFILE_DEBUG_PORT_SPAN; offset += 1) {
    const candidate =
      BROWSER_PROFILE_DEBUG_PORT_MIN +
      ((preferred - BROWSER_PROFILE_DEBUG_PORT_MIN + offset) %
        BROWSER_PROFILE_DEBUG_PORT_SPAN);
    if (!taken.has(candidate)) {
      port = candidate;
      break;
    }
  }

  const profiles = index.profiles.map((profile) =>
    profile.id === profileId ? { ...profile, debugPort: port } : profile,
  );
  return { index: { ...index, profiles }, port };
}
