export interface AppSurfacePresentationInput {
  appId: string;
  label: string;
  summary?: string | null;
  resourceId?: string | null;
  view?: string | null;
}

export interface AppSurfacePresentation {
  layout: "split-stage";
  stageMode: "contained";
  eyebrow: string;
  headline: string;
  description: string;
  focusLabel: string;
  highlights: [string, string, string];
}

function titleCase(value: string): string {
  if (!value) {
    return "";
  }
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function focusContextLabel(view?: string | null): string {
  const normalized = view?.trim().toLowerCase() ?? "";
  if (normalized === "thread") {
    return "Thread";
  }
  if (normalized === "draft") {
    return "Draft";
  }
  if (normalized === "preview") {
    return "Preview";
  }
  if (normalized) {
    return titleCase(normalized);
  }
  return "Workspace";
}

function focusHighlight(view?: string | null): string {
  const label = focusContextLabel(view);
  if (label === "Thread") {
    return "Focused thread context";
  }
  if (label === "Draft") {
    return "Focused draft context";
  }
  return "Focused workspace context";
}

export function buildAppSurfacePresentation({
  appId,
  label,
  summary,
  resourceId,
  view,
}: AppSurfacePresentationInput): AppSurfacePresentation {
  const focusBase = focusContextLabel(view);
  const focusLabel = resourceId ? `${focusBase} ${resourceId}` : `${focusBase} view`;
  const normalizedAppId = appId.trim().toLowerCase();
  const defaultDescription =
    normalizedAppId === "gmail"
      ? "Email drafts and sending stay framed inside the workspace so the agent and your app context can live side by side."
      : "Keep the embedded app framed inside the workspace so surrounding tools stay readable and accessible.";

  return {
    layout: "split-stage",
    stageMode: "contained",
    eyebrow: "Workspace app",
    headline: label,
    description: summary?.trim() || defaultDescription,
    focusLabel,
    highlights: [
      "Contained workspace stage",
      focusHighlight(view),
      "Agent-assisted follow-up",
    ],
  };
}
