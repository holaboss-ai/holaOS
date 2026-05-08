import { Globe, Sparkles, UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  WizardField,
  WorkspaceWizardLayout,
} from "./WorkspaceWizardLayout";

interface BrowserProfileStepProps {
  stepIndex: number;
  stepTotal: number;
  browserBootstrapMode: "fresh" | "copy_workspace" | "import_browser";
  setBrowserBootstrapMode: (
    value: "fresh" | "copy_workspace" | "import_browser",
  ) => void;
  browserBootstrapSourceWorkspaceId: string;
  setBrowserBootstrapSourceWorkspaceId: (workspaceId: string) => void;
  copySourceWorkspaces: WorkspaceRecordPayload[];
  browserImportSource: BrowserImportSource;
  setBrowserImportSource: (source: BrowserImportSource) => void;
  browserImportProfileDir: string;
  setBrowserImportProfileDir: (profileDir: string) => void;
  importProfiles: BrowserImportProfileOptionPayload[];
  importProfilesLoading: boolean;
  importProfilesError: string;
  createDisabled: boolean;
  workspaceErrorMessage: string;
  onBack: () => void;
  onCancel: () => void;
  onCreate: () => void;
}

const MODE_OPTIONS: Array<{
  id: "fresh" | "copy_workspace" | "import_browser";
  label: string;
  detail: string;
  icon: React.ReactNode;
}> = [
  {
    id: "fresh",
    label: "Start fresh",
    detail: "Brand new browser profile for this workspace.",
    icon: <Sparkles className="size-4 text-muted-foreground" />,
  },
  {
    id: "copy_workspace",
    label: "Copy from another workspace",
    detail: "Clone cookies and history from one of your workspaces.",
    icon: <Globe className="size-4 text-muted-foreground" />,
  },
  {
    id: "import_browser",
    label: "Import from a browser",
    detail: "Bring bookmarks, cookies, and history from Chrome, Arc, Safari…",
    icon: <UploadCloud className="size-4 text-muted-foreground" />,
  },
];

export function BrowserProfileStep({
  stepIndex,
  stepTotal,
  browserBootstrapMode,
  setBrowserBootstrapMode,
  browserBootstrapSourceWorkspaceId,
  setBrowserBootstrapSourceWorkspaceId,
  copySourceWorkspaces,
  browserImportSource,
  setBrowserImportSource,
  browserImportProfileDir,
  setBrowserImportProfileDir,
  importProfiles,
  importProfilesLoading,
  importProfilesError,
  createDisabled,
  workspaceErrorMessage,
  onBack,
  onCancel,
  onCreate,
}: BrowserProfileStepProps) {
  return (
    <WorkspaceWizardLayout
      description="The workspace ships with its own browser. Choose how to set it up."
      errorMessage={workspaceErrorMessage || null}
      primary={{
        label: "Create workspace",
        onClick: onCreate,
        disabled: createDisabled,
      }}
      secondary={{ label: "Back", onClick: onBack }}
      stepIndex={stepIndex}
      stepTotal={stepTotal}
      tertiary={{ label: "Cancel", onClick: onCancel }}
      title="Set up the browser"
      width="md"
    >
      <div className="space-y-5">
        {/* Mode selector */}
        <div className="grid gap-1.5">
          {MODE_OPTIONS.map((option) => {
            const active = browserBootstrapMode === option.id;
            return (
              <button
                aria-pressed={active}
                className={cn(
                  "flex items-start gap-3 rounded-lg px-3.5 py-3 text-left transition-colors shadow-2xs focus-visible:[box-shadow:none!important]",
                  active
                    ? "bg-primary/[0.06] ring-1 ring-primary/30"
                    : "bg-fg-2 hover:bg-fg-4",
                )}
                key={option.id}
                onClick={() => setBrowserBootstrapMode(option.id)}
                type="button"
              >
                <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-background shadow-2xs">
                  {option.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">
                    {option.label}
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {option.detail}
                  </p>
                </div>
                <span
                  aria-hidden
                  className={cn(
                    "mt-1 size-3.5 shrink-0 rounded-full border transition-colors",
                    active
                      ? "border-primary bg-primary"
                      : "border-fg-24 bg-background",
                  )}
                />
              </button>
            );
          })}
        </div>

        {browserBootstrapMode === "copy_workspace" ? (
          <WizardField htmlFor="copy-workspace-source" label="Source workspace">
            <div className="rounded-lg bg-fg-2 shadow-2xs transition-colors focus-within:bg-background focus-within:shadow-xs">
              <select
                className="h-10 w-full rounded-lg border-0 bg-transparent px-3 text-sm text-foreground outline-none focus-visible:ring-0"
                id="copy-workspace-source"
                onChange={(event) =>
                  setBrowserBootstrapSourceWorkspaceId(event.target.value)
                }
                value={browserBootstrapSourceWorkspaceId}
              >
                {copySourceWorkspaces.length > 0 ? null : (
                  <option value="">No workspaces available</option>
                )}
                {copySourceWorkspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name || workspace.id}
                  </option>
                ))}
              </select>
            </div>
          </WizardField>
        ) : null}

        {browserBootstrapMode === "import_browser" ? (
          <div className="space-y-4">
            <WizardField htmlFor="import-browser-source" label="Import source">
              <div className="rounded-lg bg-fg-2 shadow-2xs transition-colors focus-within:bg-background focus-within:shadow-xs">
                <select
                  className="h-10 w-full rounded-lg border-0 bg-transparent px-3 text-sm text-foreground outline-none focus-visible:ring-0"
                  id="import-browser-source"
                  onChange={(event) =>
                    setBrowserImportSource(
                      event.target.value as BrowserImportSource,
                    )
                  }
                  value={browserImportSource}
                >
                  <option value="chrome">Chrome</option>
                  <option value="chromium">Chromium</option>
                  <option value="arc">Arc</option>
                  <option value="safari">Safari export (.zip)</option>
                </select>
              </div>
            </WizardField>

            {browserImportSource === "safari" ? (
              <p className="rounded-lg bg-fg-2 px-3 py-2.5 text-sm text-muted-foreground shadow-2xs">
                Safari import opens a file picker after you click{" "}
                <span className="font-medium text-foreground">
                  Create workspace
                </span>
                .
              </p>
            ) : (
              <WizardField
                help={
                  importProfilesError ? (
                    <span className="text-destructive">
                      {importProfilesError}
                    </span>
                  ) : null
                }
                label="Profile"
              >
                <div className="overflow-hidden rounded-lg bg-fg-2 shadow-2xs">
                  {importProfilesLoading ? (
                    <p className="px-3 py-2.5 text-sm text-muted-foreground">
                      Loading profiles…
                    </p>
                  ) : importProfiles.length === 0 ? (
                    <p className="px-3 py-2.5 text-sm text-muted-foreground">
                      No importable profiles found for this browser.
                    </p>
                  ) : (
                    <div className="max-h-44 divide-y divide-border/40 overflow-y-auto">
                      {importProfiles.map((profile) => {
                        const checked =
                          browserImportProfileDir === profile.profileDir;
                        return (
                          <label
                            className={cn(
                              "flex cursor-pointer items-start gap-2 px-3 py-2 text-sm transition-colors",
                              checked ? "bg-background" : "hover:bg-fg-4",
                            )}
                            key={profile.profileDir}
                          >
                            <input
                              checked={checked}
                              className="mt-0.5 accent-primary"
                              name="import-profile"
                              onChange={() =>
                                setBrowserImportProfileDir(profile.profileDir)
                              }
                              type="radio"
                            />
                            <span className="min-w-0">
                              <span className="block font-medium text-foreground">
                                {profile.profileLabel}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {profile.profileDir}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              </WizardField>
            )}
          </div>
        ) : null}
      </div>
    </WorkspaceWizardLayout>
  );
}
