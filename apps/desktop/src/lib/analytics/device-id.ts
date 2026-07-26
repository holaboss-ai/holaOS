const DEVICE_ID_KEY = "hb_device_id";
const FIRST_LAUNCH_KEY = "hb_has_launched";
const LAST_LAUNCH_AT_KEY = "hb_last_launched_at";
// Collapse HMR reloads, auth-induced renderer refreshes, and multi-window
// re-mounts into one "launch" per ~5 minutes.
const LAUNCH_THROTTLE_MS = 5 * 60 * 1000;

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getDeviceId(): string {
  const storage = safeStorage();
  if (!storage) {
    return "";
  }
  const existing = storage.getItem(DEVICE_ID_KEY);
  if (existing) {
    return existing;
  }
  const fresh =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    storage.setItem(DEVICE_ID_KEY, fresh);
  } catch {
    // localStorage quota / private mode — fall through with the in-memory id
  }
  return fresh;
}

export interface LaunchRecord {
  isFirstLaunch: boolean;
}

/**
 * Returns a record on a real launch, or null when throttled (recent launch
 * already counted). Always advances the bookkeeping atomically.
 */
export function recordLaunch(): LaunchRecord | null {
  const storage = safeStorage();
  if (!storage) {
    return { isFirstLaunch: true };
  }
  const now = Date.now();
  const lastRaw = storage.getItem(LAST_LAUNCH_AT_KEY);
  const last = lastRaw ? Number.parseInt(lastRaw, 10) : 0;
  if (Number.isFinite(last) && now - last < LAUNCH_THROTTLE_MS) {
    return null;
  }
  const everLaunched = storage.getItem(FIRST_LAUNCH_KEY) === "1";
  try {
    storage.setItem(LAST_LAUNCH_AT_KEY, String(now));
    if (!everLaunched) {
      storage.setItem(FIRST_LAUNCH_KEY, "1");
    }
  } catch {
    // ignore — at worst we'll fire an extra event
  }
  return { isFirstLaunch: !everLaunched };
}
