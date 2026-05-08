import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Globe, Loader2, UploadCloud, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { WorkspaceIcon } from "@/components/ui/workspace-icon";
import { cn } from "@/lib/utils";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";

const IMPORT_PROFILE_LIST_HANDLER_MISSING_MESSAGE =
  "No handler registered for 'workspace:listImportBrowserProfiles'";

const IMPORT_SOURCE_OPTIONS: Array<{
  label: string;
  value: BrowserImportSource;
}> = [
  { label: "Chrome", value: "chrome" },
  { label: "Chromium", value: "chromium" },
  { label: "Arc", value: "arc" },
  { label: "Safari export (.zip)", value: "safari" },
];

const PROFILE_SETUP_MODE_OPTIONS = [
  {
    value: "copy_workspace",
    label: "Copy from another workspace",
    detail: "Clone the browser state from one of your existing workspaces.",
    icon: Globe,
  },
  {
    value: "import_browser",
    label: "Import from a browser",
    detail: "Bring bookmarks, cookies, and history from Chrome, Arc, or Safari.",
    icon: UploadCloud,
  },
] as const;

type BrowserProfileSetupMode =
  (typeof PROFILE_SETUP_MODE_OPTIONS)[number]["value"];
type BrowserImportStatusTone = "info" | "success" | "error";

function normalizeErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return "Browser import failed.";
}

function importSummaryMessage(summary: BrowserImportSummaryPayload) {
  return browserProfileSummaryMessage({
    summary,
    prefix: `Imported ${summary.sourceLabel}.`,
  });
}

function browserProfileSummaryMessage(params: {
  summary: BrowserImportSummaryPayload;
  prefix: string;
}) {
  const { summary, prefix } = params;
  const detailParts = [
    `${summary.importedBookmarks} bookmarks`,
    `${summary.importedHistoryEntries} history entries`,
    `${summary.importedCookies} cookies`,
  ];
  if (summary.skippedCookies > 0) {
    detailParts.push(`${summary.skippedCookies} cookies skipped`);
  }
  return `${prefix} ${detailParts.join(", ")}. Refresh the current page if it still shows an expired-cookie error.`;
}

interface BrowserProfileImportButtonProps {
  buttonClassName?: string;
  buttonSize?: "sm" | "icon-sm";
  buttonVariant?: "ghost" | "outline";
  showLabel?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function BrowserProfileImportButton({
  buttonClassName,
  buttonSize = "sm",
  buttonVariant = "outline",
  showLabel = true,
  open: controlledOpen,
  onOpenChange,
}: BrowserProfileImportButtonProps) {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const [internalOpen, setInternalOpen] = useState(false);
  const [profileSetupMode, setProfileSetupMode] =
    useState<BrowserProfileSetupMode>("import_browser");
  const [browserImportSource, setBrowserImportSource] =
    useState<BrowserImportSource>("chrome");
  const [browserImportProfileDir, setBrowserImportProfileDir] = useState("");
  const [importProfiles, setImportProfiles] = useState<
    BrowserImportProfileOptionPayload[]
  >([]);
  const [importProfilesLoading, setImportProfilesLoading] = useState(false);
  const [importProfilesError, setImportProfilesError] = useState("");
  const [profileSelectionDeferredToImportDialog, setProfileSelectionDeferredToImportDialog] =
    useState(false);
  const [copySourceWorkspaces, setCopySourceWorkspaces] = useState<
    WorkspaceRecordPayload[]
  >([]);
  const [copySourceWorkspaceId, setCopySourceWorkspaceId] = useState("");
  const [copySourceWorkspacesLoading, setCopySourceWorkspacesLoading] =
    useState(false);
  const [copySourceWorkspacesError, setCopySourceWorkspacesError] =
    useState("");
  const [importPending, setImportPending] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [statusTone, setStatusTone] =
    useState<BrowserImportStatusTone>("info");
  const [resultWarnings, setResultWarnings] = useState<string[]>([]);
  const open = controlledOpen ?? internalOpen;

  const setOpen = (nextOpen: boolean) => {
    if (controlledOpen === undefined) {
      setInternalOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    setStatusMessage("");
    setResultWarnings([]);
    setStatusTone("info");
  }, [browserImportSource, copySourceWorkspaceId, open, profileSetupMode]);

  useEffect(() => {
    if (!open) {
      return;
    }
    if (profileSetupMode !== "import_browser") {
      setImportProfiles([]);
      setImportProfilesLoading(false);
      setImportProfilesError("");
      setProfileSelectionDeferredToImportDialog(false);
      return;
    }
    if (!selectedWorkspaceId.trim()) {
      setImportProfiles([]);
      setImportProfilesLoading(false);
      setImportProfilesError("Select a workspace before importing a profile.");
      setProfileSelectionDeferredToImportDialog(false);
      return;
    }
    if (browserImportSource === "safari") {
      setImportProfiles([]);
      setImportProfilesLoading(false);
      setImportProfilesError("");
      setProfileSelectionDeferredToImportDialog(false);
      setBrowserImportProfileDir("");
      return;
    }

    let cancelled = false;
    setImportProfilesLoading(true);
    setImportProfilesError("");
    setProfileSelectionDeferredToImportDialog(false);
    void window.electronAPI.workspace
      .listImportBrowserProfiles(browserImportSource)
      .then((profiles) => {
        if (cancelled) {
          return;
        }
        setImportProfiles(profiles);
        if (
          profiles.length > 0 &&
          !profiles.some(
            (profile) => profile.profileDir === browserImportProfileDir,
          )
        ) {
          setBrowserImportProfileDir(profiles[0]?.profileDir ?? "");
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const message = normalizeErrorMessage(error);
        if (message.includes(IMPORT_PROFILE_LIST_HANDLER_MISSING_MESSAGE)) {
          setImportProfiles([]);
          setImportProfilesError(
            "Profile list is unavailable in this desktop session. Continue and choose the profile in the native import dialog.",
          );
          setProfileSelectionDeferredToImportDialog(true);
          return;
        }
        setImportProfiles([]);
        setImportProfilesError(message);
      })
      .finally(() => {
        if (!cancelled) {
          setImportProfilesLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [browserImportSource, open, profileSetupMode, selectedWorkspaceId]);

  useEffect(() => {
    if (!open) {
      return;
    }
    if (profileSetupMode !== "copy_workspace") {
      setCopySourceWorkspaces([]);
      setCopySourceWorkspacesLoading(false);
      setCopySourceWorkspacesError("");
      return;
    }
    if (!selectedWorkspaceId.trim()) {
      setCopySourceWorkspaces([]);
      setCopySourceWorkspacesLoading(false);
      setCopySourceWorkspacesError(
        "Select a workspace before copying a browser profile.",
      );
      return;
    }

    let cancelled = false;
    setCopySourceWorkspacesLoading(true);
    setCopySourceWorkspacesError("");
    void window.electronAPI.workspace
      .listWorkspaces()
      .then((response) => {
        if (cancelled) {
          return;
        }
        const availableWorkspaces = response.items.filter(
          (workspace) =>
            workspace.id !== selectedWorkspaceId &&
            workspace.folder_state !== "missing",
        );
        setCopySourceWorkspaces(availableWorkspaces);
        if (
          availableWorkspaces.length > 0 &&
          !availableWorkspaces.some(
            (workspace) => workspace.id === copySourceWorkspaceId,
          )
        ) {
          setCopySourceWorkspaceId(availableWorkspaces[0]?.id ?? "");
        }
        if (availableWorkspaces.length === 0) {
          setCopySourceWorkspaceId("");
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setCopySourceWorkspaces([]);
        setCopySourceWorkspaceId("");
        setCopySourceWorkspacesError(normalizeErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) {
          setCopySourceWorkspacesLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, profileSetupMode, selectedWorkspaceId]);

  const trimmedWorkspaceId = selectedWorkspaceId.trim();
  const selectedCopySourceWorkspace = useMemo(
    () =>
      copySourceWorkspaces.find(
        (workspace) => workspace.id === copySourceWorkspaceId,
      ) ?? null,
    [copySourceWorkspaceId, copySourceWorkspaces],
  );
  const canImport = useMemo(() => {
    if (!trimmedWorkspaceId || importPending) {
      return false;
    }
    if (profileSetupMode === "copy_workspace") {
      return copySourceWorkspaceId.trim().length > 0;
    }
    if (browserImportSource === "safari") {
      return true;
    }
    return (
      profileSelectionDeferredToImportDialog ||
      browserImportProfileDir.trim().length > 0
    );
  }, [
    browserImportProfileDir,
    browserImportSource,
    copySourceWorkspaceId,
    importPending,
    profileSelectionDeferredToImportDialog,
    profileSetupMode,
    trimmedWorkspaceId,
  ]);

  const handleImport = async () => {
    if (!canImport || !trimmedWorkspaceId) {
      return;
    }
    setImportPending(true);
    setStatusMessage("");
    setResultWarnings([]);
    setStatusTone("info");
    try {
      if (profileSetupMode === "copy_workspace") {
        const summary =
          await window.electronAPI.workspace.copyBrowserWorkspaceProfile({
            sourceWorkspaceId: copySourceWorkspaceId.trim(),
            targetWorkspaceId: trimmedWorkspaceId,
          });
        setStatusTone(summary.warnings.length > 0 ? "info" : "success");
        setStatusMessage(
          browserProfileSummaryMessage({
            summary,
            prefix: `Copied browser profile from ${
              selectedCopySourceWorkspace?.name || summary.sourceLabel
            }.`,
          }),
        );
        setResultWarnings(summary.warnings);
        return;
      }
      const summary = await window.electronAPI.workspace.importBrowserProfile({
        workspaceId: trimmedWorkspaceId,
        source: browserImportSource,
        profileDir:
          browserImportSource === "safari" ||
          profileSelectionDeferredToImportDialog
            ? undefined
            : browserImportProfileDir.trim() || undefined,
      });
      if (!summary) {
        setStatusTone("info");
        setStatusMessage("Browser import cancelled.");
        return;
      }
      setStatusTone(summary.warnings.length > 0 ? "info" : "success");
      setStatusMessage(importSummaryMessage(summary));
      setResultWarnings(summary.warnings);
    } catch (error) {
      setStatusTone("error");
      setStatusMessage(normalizeErrorMessage(error));
      setResultWarnings([]);
    } finally {
      setImportPending(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant={buttonVariant}
        size={buttonSize}
        className={cn(showLabel ? "gap-1.5" : "", buttonClassName)}
        aria-label="Import browser profile"
        aria-expanded={open}
        title="Import browser profile"
        disabled={!trimmedWorkspaceId}
        onClick={() => setOpen(true)}
      >
        <UploadCloud size={13} />
        {showLabel ? <span>Import</span> : null}
      </Button>

      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop className="fixed inset-0 z-[120] bg-scrim backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 duration-200" />
          <DialogPrimitive.Popup className="fixed top-1/2 left-1/2 z-[121] flex max-h-[min(780px,calc(100vh-32px))] w-[min(720px,calc(100vw-32px))] min-w-0 -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl border border-border bg-background shadow-xs outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.97] data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98] duration-200 ease-out">
            <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
              <div className="min-w-0">
                <DialogPrimitive.Title className="text-[20px] font-semibold text-foreground">
                  Set Up Browser Profile
                </DialogPrimitive.Title>
                <p className="mt-1.5 max-w-[44rem] text-sm leading-relaxed text-muted-foreground">
                  Re-import a browser profile or copy one from another
                  workspace into this workspace browser.
                </p>
              </div>

              <DialogPrimitive.Close
                render={
                  <button
                    type="button"
                    aria-label="Close browser profile import"
                    className={cn(
                      buttonVariants({ variant: "outline", size: "icon" }),
                      "shrink-0 rounded-full",
                    )}
                  >
                    <X size={16} />
                  </button>
                }
              />
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 [scrollbar-gutter:stable]">
              <div className="space-y-5">
                <div className="rounded-xl bg-fg-2 px-4 py-3 text-sm leading-relaxed text-muted-foreground shadow-2xs">
                  Current workspace cookies are replaced before import so stale
                  login state does not linger. Sites that rely on app-bound
                  encryption or non-cookie storage may still ask you to sign in
                  again.
                </div>

                <div className="grid gap-1.5">
                  {PROFILE_SETUP_MODE_OPTIONS.map((option) => {
                    const active = profileSetupMode === option.value;
                    const OptionIcon = option.icon;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={active}
                        className={cn(
                          "flex items-start gap-3 rounded-lg px-3.5 py-3 text-left transition-colors shadow-2xs focus-visible:[box-shadow:none!important]",
                          active
                            ? "bg-primary/[0.06] ring-1 ring-primary/30"
                            : "bg-fg-2 hover:bg-fg-4",
                        )}
                        onClick={() => setProfileSetupMode(option.value)}
                      >
                        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-background shadow-2xs">
                          <OptionIcon className="size-4 text-muted-foreground" />
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

                {profileSetupMode === "copy_workspace" ? (
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-foreground">
                      Source workspace
                    </label>
                    <div className="overflow-hidden rounded-lg bg-fg-2 shadow-2xs">
                      {copySourceWorkspacesLoading ? (
                        <p className="px-3 py-2.5 text-sm text-muted-foreground">
                          Loading workspaces…
                        </p>
                      ) : copySourceWorkspaces.length === 0 ? (
                        <p className="px-3 py-2.5 text-sm text-muted-foreground">
                          {copySourceWorkspacesError ||
                            "No other workspaces are available to copy from."}
                        </p>
                      ) : (
                        <div className="max-h-56 divide-y divide-border/40 overflow-y-auto">
                          {copySourceWorkspaces.map((workspace) => {
                            const checked =
                              copySourceWorkspaceId === workspace.id;
                            return (
                              <label
                                className={cn(
                                  "flex cursor-pointer items-start gap-2 px-3 py-2.5 text-sm transition-colors",
                                  checked ? "bg-background" : "hover:bg-fg-4",
                                )}
                                key={workspace.id}
                              >
                                <input
                                  checked={checked}
                                  className="mt-0.5 accent-primary"
                                  name="workspace-profile-copy"
                                  onChange={() =>
                                    setCopySourceWorkspaceId(workspace.id)
                                  }
                                  type="radio"
                                />
                                <WorkspaceIcon
                                  workspace={workspace}
                                  size="md"
                                  className="mt-0.5"
                                />
                                <span className="min-w-0">
                                  <span className="block font-medium text-foreground">
                                    {workspace.name || workspace.id}
                                  </span>
                                  <span className="block truncate text-xs text-muted-foreground">
                                    {workspace.workspace_path || workspace.id}
                                  </span>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <label className="block">
                      <span className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-foreground">
                        Source
                      </span>
                      <div className="rounded-lg bg-fg-2 shadow-2xs transition-colors focus-within:bg-background focus-within:shadow-xs">
                        <select
                          className="h-10 w-full rounded-lg border-0 bg-transparent px-3 text-sm text-foreground outline-none focus-visible:ring-0"
                          onChange={(event) =>
                            setBrowserImportSource(
                              event.target.value as BrowserImportSource,
                            )
                          }
                          value={browserImportSource}
                        >
                          {IMPORT_SOURCE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </label>

                    {browserImportSource === "safari" ? (
                      <p className="rounded-lg bg-fg-2 px-3 py-2.5 text-sm text-muted-foreground shadow-2xs">
                        Safari import opens a file picker for a Safari export
                        zip and only brings in bookmarks and history.
                      </p>
                    ) : (
                      <div>
                        <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-foreground">
                          Profile
                        </div>
                        {importProfilesError &&
                        !profileSelectionDeferredToImportDialog ? (
                          <p className="mb-1.5 text-xs leading-relaxed text-destructive">
                            {importProfilesError}
                          </p>
                        ) : null}
                        <div className="overflow-hidden rounded-lg bg-fg-2 shadow-2xs">
                          {importProfilesLoading ? (
                            <p className="px-3 py-2.5 text-sm text-muted-foreground">
                              Loading profiles…
                            </p>
                          ) : profileSelectionDeferredToImportDialog ? (
                            <p className="px-3 py-2.5 text-sm text-muted-foreground">
                              {importProfilesError}
                            </p>
                          ) : importProfiles.length === 0 ? (
                            <p className="px-3 py-2.5 text-sm text-muted-foreground">
                              {importProfilesError ||
                                "No importable profiles found for this browser."}
                            </p>
                          ) : (
                            <div className="max-h-56 divide-y divide-border/40 overflow-y-auto">
                              {importProfiles.map((profile) => {
                                const checked =
                                  browserImportProfileDir === profile.profileDir;
                                return (
                                  <label
                                    className={cn(
                                      "flex cursor-pointer items-start gap-2 px-3 py-2.5 text-sm transition-colors",
                                      checked
                                        ? "bg-background"
                                        : "hover:bg-fg-4",
                                    )}
                                    key={profile.profileDir}
                                  >
                                    <input
                                      checked={checked}
                                      className="mt-0.5 accent-primary"
                                      name="browser-profile-import"
                                      onChange={() =>
                                        setBrowserImportProfileDir(
                                          profile.profileDir,
                                        )
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
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="shrink-0 border-t border-border px-6 py-4">
              {statusMessage ? (
                <div
                  className={cn(
                    "mb-3 rounded-lg border px-3 py-2 text-xs leading-5",
                    statusTone === "error"
                      ? "border-destructive/25 bg-destructive/5 text-destructive"
                      : statusTone === "success"
                        ? "border-emerald-500/20 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300"
                        : "border-border bg-muted/30 text-foreground",
                  )}
                >
                  <p>{statusMessage}</p>
                  {resultWarnings.length > 0 ? (
                    <ul className="mt-2 list-disc space-y-1 pl-4">
                      {resultWarnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
                <DialogPrimitive.Close
                  render={
                    <button
                      type="button"
                      className={buttonVariants({
                        variant: "outline",
                        size: "sm",
                      })}
                    >
                      Close
                    </button>
                  }
                />
                <Button type="button" onClick={() => void handleImport()} disabled={!canImport}>
                  {importPending ? (
                    <>
                      <Loader2 className="animate-spin" />
                      <span>
                        {profileSetupMode === "copy_workspace"
                          ? "Copying…"
                          : "Importing…"}
                      </span>
                    </>
                  ) : (
                    <span>
                      {profileSetupMode === "copy_workspace"
                        ? "Copy Into Workspace Browser"
                        : "Import Into Workspace Browser"}
                    </span>
                  )}
                </Button>
              </div>
            </div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
