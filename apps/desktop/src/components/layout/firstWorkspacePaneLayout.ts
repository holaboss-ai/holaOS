type FirstWorkspacePaneStep =
  | "gallery"
  | "detail"
  | "select_apps"
  | "configure"
  | "browser_profile"
  | "connect_integrations";

/**
 * Outer section className used by FirstWorkspacePane. The pane itself is the
 * canvas (`bg-fg-2`) — this just controls scroll behavior and padding for the
 * inner step content. Step routing decides whether the content is a wide
 * marketplace browser (gallery/detail) or a centered card (everything else).
 */
export function firstWorkspacePaneSectionClassName(
  _step: FirstWorkspacePaneStep,
): string {
  return [
    "relative",
    "flex",
    "min-h-0",
    "min-w-0",
    "flex-1",
    "flex-col",
    "overflow-y-auto",
  ].join(" ");
}
