export type WorkspaceOnboardingPreference = "deterministic" | "agentic";

export const WORKSPACE_ONBOARDING_PREFERENCE_STORAGE_KEY =
  "holaboss-workspace-onboarding-preference-v1";

export function isWorkspaceOnboardingPreference(
  value: string,
): value is WorkspaceOnboardingPreference {
  return value === "deterministic" || value === "agentic";
}

export function loadWorkspaceOnboardingPreference(): WorkspaceOnboardingPreference {
  try {
    const stored = localStorage.getItem(
      WORKSPACE_ONBOARDING_PREFERENCE_STORAGE_KEY,
    );
    if (stored && isWorkspaceOnboardingPreference(stored)) {
      return stored;
    }
  } catch {
    // ignore
  }
  return "deterministic";
}

export function persistWorkspaceOnboardingPreference(
  value: WorkspaceOnboardingPreference,
) {
  try {
    localStorage.setItem(WORKSPACE_ONBOARDING_PREFERENCE_STORAGE_KEY, value);
  } catch {
    // ignore
  }
}
