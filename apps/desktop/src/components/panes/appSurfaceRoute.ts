interface AppSurfaceRouteInput {
  path?: string | null;
  resourceId?: string | null;
  view?: string | null;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

export function resolveAppSurfacePath({
  path,
  resourceId,
  view,
}: AppSurfaceRouteInput): string {
  const normalizedPath = (path || "").trim();
  if (normalizedPath) {
    return normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;
  }

  const normalizedView = trimSlashes((view || "").trim());
  const normalizedResourceId = (resourceId || "").trim();

  if (!normalizedResourceId) {
    if (!normalizedView || normalizedView === "home") {
      return "/";
    }
    return `/${normalizedView}`;
  }

  if (!normalizedView || normalizedView === "home") {
    return `/posts/${encodeURIComponent(normalizedResourceId)}`;
  }

  return `/${normalizedView}/${encodeURIComponent(normalizedResourceId)}`;
}
