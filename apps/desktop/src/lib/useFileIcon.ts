import { useEffect, useState } from "react";

export interface DefaultAppInfo {
  /** Display name of the default app (e.g. "Xcode"); null when unresolved. */
  name: string | null;
  /** App icon (macOS) or the file's document icon, as a data URL. */
  iconUrl: string | null;
}

const EMPTY: DefaultAppInfo = { name: null, iconUrl: null };

/**
 * Resolves the OS default app for a file — its display name and icon. On macOS
 * this is the real app (e.g. "Xcode" + its icon) via LaunchServices; elsewhere
 * or on failure it degrades to just the file's document icon (name null), so
 * callers can render "Open in {name ?? 'default app'}".
 */
export function useDefaultApp(
  filePath: string | null | undefined,
  workspaceId: string | null,
): DefaultAppInfo {
  const [info, setInfo] = useState<DefaultAppInfo>(EMPTY);
  useEffect(() => {
    if (!filePath) {
      setInfo(EMPTY);
      return;
    }
    let cancelled = false;
    void window.electronAPI.fs
      .getDefaultApp(filePath, workspaceId)
      .then((result) => {
        if (!cancelled) {
          setInfo({ name: result.name, iconUrl: result.iconDataUrl });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setInfo(EMPTY);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, workspaceId]);
  return info;
}
