/**
 * Import an installed browser profile as a NEW first-class Browser Profile.
 *
 * Because a launched profile is a real Chrome process (its own `--user-data-dir`),
 * importing natively copies the chosen Chrome/Chromium/Arc profile directory into
 * the new profile — cookies, logins, bookmarks and extensions carry over. Safari
 * is intentionally omitted: its store can't be copied into Chrome's format.
 */
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useEffect, useState } from "react";
import { Loader2, UploadCloud, X } from "@/components/ui/icons";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type ImportSource = Exclude<BrowserImportSource, "safari">;

const IMPORT_SOURCES: Array<{ label: string; value: ImportSource }> = [
  { label: "Google Chrome", value: "chrome" },
  { label: "Microsoft Edge", value: "edge" },
  { label: "Brave", value: "brave" },
  { label: "Arc", value: "arc" },
  { label: "Dia", value: "dia" },
  { label: "Chromium", value: "chromium" },
];

function sourceLabel(value: ImportSource) {
  return IMPORT_SOURCES.find((s) => s.value === value)?.label ?? value;
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "Import failed.";
}

interface ProfileImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (result: ProfileImportResultPayload) => void;
}

export function ProfileImportDialog({
  open,
  onOpenChange,
  onImported,
}: ProfileImportDialogProps) {
  const api = window.electronAPI?.profiles;
  const [source, setSource] = useState<ImportSource>("chrome");
  const [options, setOptions] = useState<BrowserImportProfileOptionPayload[]>(
    [],
  );
  const [selectedDir, setSelectedDir] = useState("");
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");

  useEffect(() => {
    if (!open || !api) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setListError("");
    setImportError("");
    void api
      .listImportSources(source)
      .then((found) => {
        if (cancelled) {
          return;
        }
        setOptions(found);
        setSelectedDir(found[0]?.profileDir ?? "");
      })
      .catch((error) => {
        if (!cancelled) {
          setOptions([]);
          setSelectedDir("");
          setListError(errorMessage(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, open, source]);

  const selectedOption = options.find((o) => o.profileDir === selectedDir);

  const handleImport = async () => {
    if (!api || !selectedDir || importing) {
      return;
    }
    setImporting(true);
    setImportError("");
    try {
      const result = await api.import({
        source,
        profileDir: selectedDir,
        profileLabel: selectedOption?.profileLabel ?? null,
      });
      onImported(result);
      onOpenChange(false);
    } catch (error) {
      setImportError(errorMessage(error));
    } finally {
      setImporting(false);
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[120] bg-scrim backdrop-blur-sm ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed top-1/2 left-1/2 z-[121] flex max-h-[min(680px,calc(100vh-32px))] w-[min(560px,calc(100vw-32px))] min-w-0 -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl border border-border bg-background shadow-xl outline-none ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.97] data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98]">
          <header className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
            <div className="min-w-0">
              <DialogPrimitive.Title className="font-semibold text-[19px] text-foreground">
                Import a browser profile
              </DialogPrimitive.Title>
              <p className="mt-1.5 max-w-[38rem] text-muted-foreground text-sm leading-relaxed">
                Create a new profile from an installed browser. Cookies, logins,
                bookmarks and extensions are copied over. Quit the source browser
                first for a complete copy.
              </p>
            </div>
            <DialogPrimitive.Close
              render={
                <button
                  type="button"
                  aria-label="Close import dialog"
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

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5 [scrollbar-gutter:stable]">
            <label className="block">
              <span className="mb-1.5 block font-medium text-foreground text-sm">
                Source browser
              </span>
              <Select
                items={IMPORT_SOURCES}
                onValueChange={(value) => setSource(value as ImportSource)}
                value={source}
              >
                <SelectTrigger className="h-10 w-full rounded-lg border-0 bg-fg-2 px-3 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  {IMPORT_SOURCES.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <div>
              <span className="mb-1.5 block font-medium text-foreground text-sm">
                Profile
              </span>
              <div className="overflow-hidden rounded-lg bg-fg-2">
                {loading ? (
                  <p className="px-3 py-2.5 text-muted-foreground text-sm">
                    Loading profiles…
                  </p>
                ) : options.length === 0 ? (
                  <p className="px-3 py-2.5 text-muted-foreground text-sm">
                    {listError ||
                      `No ${sourceLabel(source)} profiles were found on this Mac.`}
                  </p>
                ) : (
                  <div className="max-h-56 divide-y divide-border/40 overflow-y-auto">
                    {options.map((option) => {
                      const checked = selectedDir === option.profileDir;
                      return (
                        <label
                          key={option.profileDir}
                          className={cn(
                            "flex cursor-pointer items-start gap-2 px-3 py-2.5 text-sm transition-colors",
                            checked ? "bg-background" : "hover:bg-fg-4",
                          )}
                        >
                          <input
                            checked={checked}
                            className="mt-0.5 accent-primary"
                            name="profile-import-source"
                            onChange={() => setSelectedDir(option.profileDir)}
                            type="radio"
                          />
                          <span className="min-w-0">
                            <span className="block font-medium text-foreground">
                              {option.profileLabel}
                            </span>
                            <span className="block truncate text-muted-foreground text-xs">
                              {option.profileDir}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="shrink-0 border-t border-border px-6 py-4">
            {importError ? (
              <div className="mb-3 rounded-lg bg-destructive/8 px-3 py-2 text-destructive text-xs leading-5">
                {importError}
              </div>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <DialogPrimitive.Close
                render={
                  <button
                    type="button"
                    className={buttonVariants({ variant: "outline" })}
                  >
                    Cancel
                  </button>
                }
              />
              <Button
                type="button"
                onClick={() => void handleImport()}
                disabled={!selectedDir || importing}
              >
                {importing ? (
                  <>
                    <Loader2 className="animate-spin" />
                    <span>Importing…</span>
                  </>
                ) : (
                  <>
                    <UploadCloud size={14} />
                    <span>Import profile</span>
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
