/**
 * Browser Profiles management surface.
 *
 * Lists first-class browser profiles and lets the user create / rename /
 * import / delete them, and Launch⇄Close each one (a real Chrome process per
 * profile, see electron/main.ts `launchProfileChromium`). One instance per
 * profile; the button reflects live state pushed via `profiles:running`.
 * Profiles are independent of workspace, so this pane takes no workspaceId.
 * Layout mirrors the sibling panes (Projects / Automations / Channels).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserNameDialog } from "@/components/panes/BrowserNameDialog";
import { ContactSalesDialog } from "@/components/panes/ContactSalesDialog";
import { FingerprintDialog } from "@/components/panes/FingerprintDialog";
import { ProfileImportDialog } from "@/components/panes/ProfileImportDialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-shell";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChevronDown,
  Loader2,
  Pencil,
  Plus,
  ShieldCheck,
  Star,
  Trash2,
  UploadCloud,
} from "@/components/ui/icons";
import { FEATURES } from "@/lib/featureFlags";

type NameDialogState =
  | { mode: "create" }
  | { mode: "rename"; id: string; name: string };

type Profile = BrowserProfilePayload;

const DEFAULT_PROFILE_ID = "bprofile_default";

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const seconds = Math.round((Date.now() - then) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, unitSeconds] of units) {
    if (Math.abs(seconds) >= unitSeconds) {
      return rtf.format(-Math.round(seconds / unitSeconds), unit);
    }
  }
  return "just now";
}

export function ProfilesPane() {
  const api = window.electronAPI?.profiles;
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  // Profiles whose browser is starting but not yet live — the window can take a
  // couple seconds to appear (fingerprint engine cold-start), so the Launch button
  // shows a spinner in the gap between click and the pushed `running` update.
  const [launching, setLaunching] = useState<ReadonlySet<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<Profile | null>(null);
  const [fingerprintProfile, setFingerprintProfile] = useState<Profile | null>(
    null,
  );
  const [contactSalesOpen, setContactSalesOpen] = useState(false);
  // The fingerprint feature shows when the engine is ATTACHED: the build-time flag,
  // OR a runtime plugin drop-in (main reports the latter via fingerprintAvailable).
  // This is what lets a released OSS app light up the feature when the engine is
  // dropped into <userData>/fingerprint-ee — no rebuild.
  const [engineAvailable, setEngineAvailable] = useState(
    FEATURES.fingerprintBrowser,
  );

  const refresh = useCallback(async () => {
    if (!api) {
      setLoading(false);
      return;
    }
    setProfiles(await api.list());
    setLoading(false);
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Track which profiles have a live browser so the button reflects Launch⇄Close
  // — including when the user quits Chrome directly (main pushes profiles:running).
  useEffect(() => {
    if (!api) {
      return;
    }
    void api.runningIds().then((ids) => setRunning(new Set(ids)));
    return api.onRunningChange((ids) => setRunning(new Set(ids)));
  }, [api]);

  // Detect a runtime engine plugin drop-in (skip if the build flag already enables it).
  useEffect(() => {
    if (FEATURES.fingerprintBrowser || !api?.fingerprintAvailable) {
      return;
    }
    void api.fingerprintAvailable().then((ok) => {
      if (ok) {
        setEngineAvailable(true);
      }
    });
  }, [api]);

  const handleCreate = useCallback(
    async (name: string) => {
      if (api) {
        await api.create(name);
        await refresh();
      }
    },
    [api, refresh],
  );

  const handleRename = useCallback(
    async (id: string, name: string) => {
      if (api) {
        setProfiles(await api.rename(id, name));
      }
    },
    [api],
  );

  const removeProfile = useCallback(
    async (id: string) => {
      if (api) {
        setProfiles((await api.remove(id)).profiles);
      }
    },
    [api],
  );

  const handleSetDefault = useCallback(
    async (id: string) => {
      if (api?.setDefault) {
        setProfiles(await api.setDefault(id));
      }
    },
    [api],
  );

  // Launch a profile with a live "Launching…" state on its card, so there's clear
  // feedback while the browser starts (the window can take a beat to appear). The
  // pushed `running` update flips the button to Close once it's actually live.
  const beginLaunch = useCallback(
    async (id: string, url?: string) => {
      if (!api) {
        return;
      }
      setLaunchError(null);
      setLaunching((prev) => new Set(prev).add(id));
      try {
        const result = await api.launch(id, url);
        setLaunchError(
          result && !result.ok ? (result.error ?? "Failed to launch.") : null,
        );
      } catch (error) {
        setLaunchError((error as Error)?.message ?? "Failed to launch.");
      } finally {
        setLaunching((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [api],
  );

  const toggleLaunch = useCallback(
    async (id: string) => {
      if (!api) {
        return;
      }
      if (running.has(id)) {
        await api.close(id);
        return;
      }
      await beginLaunch(id);
    },
    [api, running, beginLaunch],
  );

  const onImported = useCallback(
    (result: ProfileImportResultPayload) => {
      void refresh();
      // On Windows the cookie transfer (over CDP) is what carries the login —
      // report its outcome; otherwise fall back to the binary-availability note.
      const note = result.cookieTransferWarning
        ? `Imported “${result.profile.name}”. Couldn’t carry the signed-in session: ${result.cookieTransferWarning}`
        : result.cookiesCaptured > 0
          ? `Imported “${result.profile.name}” with its signed-in session. Launch it to continue logged in.`
          : result.matchedBinaryAvailable
            ? `Imported “${result.profile.name}”. Launch it to continue with your saved logins and bookmarks.`
            : `Imported “${result.profile.name}”. Bookmarks and history carried over, but its browser isn’t installed — you may need to sign in again after launching.`;
      setImportNote(note);
    },
    [refresh],
  );

  // Import an AdsPower .xlsx export → fingerprint (cloak) profiles. The renderer
  // reads the picked file to bytes; main hands them to the enterprise engine.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleSpreadsheetSelected = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = ""; // allow re-picking the same file later
      if (!file || !api?.importSpreadsheet) {
        return;
      }
      const bytes = await file.arrayBuffer();
      const result = await api.importSpreadsheet(bytes);
      if (!result.ok) {
        setImportNote(result.error ?? "Import failed.");
        return;
      }
      await refresh();
      const extra =
        result.warnings.length > 0
          ? ` ${result.warnings[0]}${
              result.warnings.length > 1
                ? ` (+${result.warnings.length - 1} more)`
                : ""
            }`
          : "";
      setImportNote(
        `Imported ${result.imported} profile${
          result.imported === 1 ? "" : "s"
        } from AdsPower.${extra}`,
      );
    },
    [api, refresh],
  );

  const renderAddItems = () => (
    <>
      <DropdownMenuItem
        className="gap-2 rounded-md px-2 py-1.5 text-[13px]"
        onClick={() => setNameDialog({ mode: "create" })}
      >
        <Plus className="size-4" />
        Blank browser
      </DropdownMenuItem>
      <DropdownMenuItem
        className="gap-2 rounded-md px-2 py-1.5 text-[13px]"
        onClick={() => {
          setImportNote(null);
          setImportOpen(true);
        }}
      >
        <UploadCloud className="size-4" />
        Import from browser…
      </DropdownMenuItem>
      {engineAvailable ? (
        <DropdownMenuItem
          className="gap-2 rounded-md px-2 py-1.5 text-[13px]"
          onClick={() => fileInputRef.current?.click()}
        >
          <ShieldCheck className="size-4 text-violet-500" />
          Import from AdsPower…
        </DropdownMenuItem>
      ) : null}
    </>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <PageHeader
        title="Browsers"
        actions={
          <>
            {engineAvailable ? null : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => setContactSalesOpen(true)}
              >
                <ShieldCheck className="size-3.5 text-violet-500" />
                Fingerprint browser
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="sm" type="button" />}>
                <Plus className="size-3.5" />
                New browser
                <ChevronDown className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {renderAddItems()}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      <div className="mx-auto min-h-0 w-full max-w-5xl flex-1 overflow-y-auto px-6 pb-12">
        {launchError ? (
          <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
            {launchError}
          </div>
        ) : null}
        {importNote ? (
          <div className="mb-3 flex items-start justify-between gap-3 rounded-lg border border-border bg-fg-2 px-3 py-2 text-muted-foreground text-sm">
            <span className="min-w-0">{importNote}</span>
            <button
              type="button"
              onClick={() => setImportNote(null)}
              className="shrink-0 font-medium text-foreground/70 hover:text-foreground"
            >
              Dismiss
            </button>
          </div>
        ) : null}
        {loading ? (
          <div className="grid place-items-center py-24 text-muted-foreground text-sm">
            Loading…
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {profiles.map((profile, i) => {
              const isPermanent = profile.id === DEFAULT_PROFILE_ID;
              const isDefault = profile.isDefault ?? false;
              const isRunning = running.has(profile.id);
              const isLaunching = launching.has(profile.id);
              return (
                <div
                  key={profile.id}
                  className="group flex min-h-[9rem] flex-col justify-between gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-foreground/20"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <p className="truncate font-medium text-foreground text-sm">
                          {profile.name}
                        </p>
                        {isDefault ? (
                          <span
                            className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-[10px] text-amber-600 dark:text-amber-400"
                            title="The agent drives this browser when you don't name one"
                          >
                            <Star className="size-2.5" />
                            Default
                          </span>
                        ) : null}
                        {profile.engine === "fingerprint" ? (
                          <span
                            className="inline-flex shrink-0 items-center gap-0.5 rounded bg-violet-500/15 px-1.5 py-0.5 font-medium text-[10px] text-violet-600 dark:text-violet-400"
                            title="Anti-detect fingerprint identity"
                          >
                            <ShieldCheck className="size-2.5" />
                            Fingerprint
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 truncate text-muted-foreground text-xs">
                        {profile.source === "imported" ? "Imported" : "Created"}{" "}
                        {relativeTime(profile.createdAt)}
                      </p>
                    </div>
                    <span
                      className="shrink-0 tabular-nums text-muted-foreground text-xs"
                      title="Refer to this browser by number when asking the agent"
                    >
                      #{i + 1}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={isRunning ? "outline" : "default"}
                      className="h-7 gap-1.5 px-2.5 text-xs"
                      disabled={isLaunching}
                      onClick={() => void toggleLaunch(profile.id)}
                    >
                      {isLaunching ? (
                        <>
                          <Loader2 className="size-3.5 animate-spin" />
                          Launching…
                        </>
                      ) : isRunning ? (
                        "Close"
                      ) : (
                        "Launch"
                      )}
                    </Button>
                    <div className="flex items-center gap-1.5">
                      {isRunning ? (
                        <span className="flex items-center gap-1 font-medium text-emerald-600 text-xs dark:text-emerald-400">
                          <span
                            aria-hidden
                            className="size-1.5 rounded-full bg-emerald-500"
                          />
                          Live
                        </span>
                      ) : null}
                      {isDefault ? null : (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          title="Set as default browser"
                          className="size-7 p-0 text-muted-foreground opacity-0 transition-opacity hover:text-amber-500 focus-visible:opacity-100 group-hover:opacity-100"
                          onClick={() => void handleSetDefault(profile.id)}
                        >
                          <Star className="size-3.5" />
                        </Button>
                      )}
                      {engineAvailable ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          title="Fingerprint & engine"
                          className="size-7 p-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                          onClick={() => setFingerprintProfile(profile)}
                        >
                          <ShieldCheck className="size-3.5" />
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        title="Rename browser"
                        className="size-7 p-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                        onClick={() =>
                          setNameDialog({
                            mode: "rename",
                            id: profile.id,
                            name: profile.name,
                          })
                        }
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      {isPermanent ? null : (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          title="Delete browser"
                          className="size-7 p-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                          onClick={() => setPendingDelete(profile)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    className="flex min-h-[9rem] flex-col items-center justify-center gap-1.5 rounded-xl border border-border border-dashed px-4 text-center text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-accent hover:text-foreground"
                    type="button"
                  />
                }
              >
                <Plus className="size-5" />
                <span className="font-medium text-foreground text-sm">
                  New browser
                </span>
                <span className="max-w-[15rem] text-muted-foreground text-xs leading-snug">
                  A signed-in browser the agent can drive for you.
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {renderAddItems()}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
      <BrowserNameDialog
        open={nameDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setNameDialog(null);
          }
        }}
        mode={nameDialog?.mode ?? "create"}
        initialName={nameDialog?.mode === "rename" ? nameDialog.name : ""}
        onSubmit={(name) =>
          nameDialog?.mode === "rename"
            ? handleRename(nameDialog.id, name)
            : handleCreate(name)
        }
      />
      <ProfileImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={onImported}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null);
          }
        }}
        title={`Delete “${pendingDelete?.name ?? ""}”?`}
        description={`This permanently removes this profile and all of its saved logins, cookies, history, and site data. This can’t be undone.${
          pendingDelete && running.has(pendingDelete.id)
            ? " Its open browser will be closed."
            : ""
        }`}
        confirmLabel="Delete profile"
        destructive
        onConfirm={() => {
          if (pendingDelete) {
            void removeProfile(pendingDelete.id);
          }
        }}
      />
      <FingerprintDialog
        open={fingerprintProfile !== null}
        onOpenChange={(open) => {
          if (!open) {
            setFingerprintProfile(null);
          }
        }}
        profile={fingerprintProfile}
        onSaved={(next) => setProfiles(next)}
        onTest={(profileId) => {
          void beginLaunch(profileId, "https://browserscan.net");
        }}
      />
      <ContactSalesDialog
        open={contactSalesOpen}
        onOpenChange={setContactSalesOpen}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={handleSpreadsheetSelected}
      />
    </div>
  );
}
