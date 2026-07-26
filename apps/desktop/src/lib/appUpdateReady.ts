export interface AppUpdateReady {
  version: string | null;
  tooltip: string;
}

// A downloaded update is installable only on a supported build with no error;
// beta and latest converge here since both auto-download in the background.
export function appUpdateReady(
  status: AppUpdateStatusPayload | null,
): AppUpdateReady | null {
  if (!status || !status.supported || !status.downloaded || status.error) {
    return null;
  }

  const trimmed = status.latestVersion?.trim();
  const version = trimmed ? trimmed : null;
  const tooltip = version
    ? `Update v${version} ready — click to restart & install`
    : "Update ready — click to restart & install";

  return { version, tooltip };
}
