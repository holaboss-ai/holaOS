export function appShellMainGridClassName({
  hasWorkspaces,
  hasIntegratedTitleBar,
}: {
  hasWorkspaces: boolean;
  hasIntegratedTitleBar: boolean;
}): string {
  return [
    "relative",
    "z-10",
    "grid",
    "h-full",
    "w-full",
    hasWorkspaces
      ? "grid-rows-[auto_minmax(0,1fr)]"
      : "grid-rows-[minmax(0,1fr)]",
    "gap-1",
    "p-1.5",
    hasIntegratedTitleBar
      ? "sm:gap-1 sm:px-3 sm:pb-2 sm:pt-1.5"
      : "sm:gap-1.5 sm:p-2",
  ].join(" ");
}
