export interface WorkspaceAppDefinition {
  id: string;
  label: string;
}

export interface WorkspaceInstalledAppDefinition extends WorkspaceAppDefinition {
  configPath: string;
  lifecycle: InstalledWorkspaceAppPayload["lifecycle"];
  ready: boolean;
  error: string | null;
  integrations: InstalledWorkspaceAppIntegrationRequirement[];
}

function labelFromAppId(appId: string): string {
  return appId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveLabel(appId: string, yamlName: string | null | undefined): string {
  const trimmed = yamlName?.trim();
  if (trimmed) return trimmed;
  const id = appId.trim();
  return id ? labelFromAppId(id) : "";
}

export function hydrateInstalledWorkspaceApps(
  apps: InstalledWorkspaceAppPayload[]
): WorkspaceInstalledAppDefinition[] {
  return apps.map((app) => ({
    id: app.app_id,
    label: resolveLabel(app.app_id, app.name),
    configPath: app.config_path,
    lifecycle: app.lifecycle,
    ready: app.ready,
    error: app.error ?? null,
    integrations: app.integrations ?? [],
  }));
}

// Resolve a display record for an app id. Prefers the live installed-app
// list (which carries the yaml-derived name + integrations) and falls back
// to a title-cased identifier when the id is unknown. Returns null only for
// empty input.
export function getWorkspaceAppDefinition(
  appId: string | null | undefined,
  installedApps?: WorkspaceInstalledAppDefinition[]
): WorkspaceInstalledAppDefinition | WorkspaceAppDefinition | null {
  if (!appId) return null;
  const normalized = appId.trim();
  if (!normalized) return null;
  const installed = installedApps?.find((app) => app.id === normalized);
  if (installed) return installed;
  return {
    id: normalized,
    label: labelFromAppId(normalized),
  };
}

export function inferWorkspaceAppIdFromText(text: string): string | null {
  const normalized = text.toLowerCase();
  if (normalized.includes("linkedin")) {
    return "linkedin";
  }
  if (normalized.includes("twitter") || normalized.includes("tweet") || normalized.includes("thread")) {
    return "twitter";
  }
  if (normalized.includes("reddit") || normalized.includes("subreddit")) {
    return "reddit";
  }
  return null;
}

export function inferInstalledWorkspaceAppIdFromText(
  text: string,
  installedApps: WorkspaceInstalledAppDefinition[]
): string | null {
  const inferredAppId = inferWorkspaceAppIdFromText(text);
  if (!inferredAppId) {
    return null;
  }
  return installedApps.some((app) => app.id === inferredAppId) ? inferredAppId : null;
}
