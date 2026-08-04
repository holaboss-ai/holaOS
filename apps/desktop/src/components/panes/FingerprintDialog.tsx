/**
 * Fingerprint editor — turns a Browser Profile into an AdsPower-style anti-detect
 * identity. Toggle the engine (system Chrome ⇄ Fingerprint), edit the
 * spoofed fingerprint (platform / seed / GPU / hardware / screen / locale) and
 * per-profile proxy, with a live flag preview + coherence warnings from main.
 * See docs/cdp/fingerprint-profiles.md §5.
 */
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useCallback, useEffect, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { RefreshCw, X } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

type Engine = "system" | "fingerprint";
type Draft = FingerprintPayload;

const PLATFORMS: FingerprintPayload["platform"][] = ["windows", "macos", "linux"];
const BRANDS = ["Chrome", "Edge", "Opera", "Vivaldi"] as const;

const inputCls =
  "h-9 w-full rounded-lg bg-fg-2 px-2.5 text-foreground text-sm outline-none transition-colors focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring";
const labelCls = "mb-1 block font-medium text-muted-foreground text-xs";

function randomSeed(): number {
  return Math.floor(10_000 + Math.random() * 90_000);
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className={labelCls}>{label}</span>
      {children}
    </label>
  );
}

interface FingerprintDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: BrowserProfilePayload | null;
  onSaved: (profiles: BrowserProfilePayload[]) => void;
  /** Save the current config, then launch the profile on a fingerprint checker. */
  onTest: (profileId: string) => void;
}

export function FingerprintDialog({
  open,
  onOpenChange,
  profile,
  onSaved,
  onTest,
}: FingerprintDialogProps) {
  const api = window.electronAPI?.profiles;
  const [engine, setEngine] = useState<Engine>("system");
  const [fp, setFp] = useState<Draft>({ seed: randomSeed(), platform: "windows" });
  const [preview, setPreview] = useState<{ warnings: string[] }>({
    warnings: [],
  });
  const [saving, setSaving] = useState(false);
  const tapi = window.electronAPI?.fingerprintTemplates;
  const [templates, setTemplates] = useState<FingerprintTemplatePayload[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [templateNote, setTemplateNote] = useState<string | null>(null);

  // Seed the form each time the dialog opens.
  useEffect(() => {
    if (open && profile) {
      setEngine(profile.engine === "fingerprint" ? "fingerprint" : "system");
      setFp(profile.fingerprint ?? { seed: randomSeed(), platform: "windows" });
      setSaving(false);
    }
  }, [open, profile]);

  // Load the template catalogue (presets + saved) when the dialog opens.
  useEffect(() => {
    if (open && tapi) {
      void tapi.list().then(setTemplates);
      setImportOpen(false);
      setSaveOpen(false);
      setTemplateNote(null);
    }
  }, [open, tapi]);

  // Live coherence check as the draft changes — computed by main.
  useEffect(() => {
    if (!open || engine !== "fingerprint" || !api) {
      setPreview({ warnings: [] });
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      void api.previewFingerprint(fp).then((result) => {
        if (!cancelled) {
          setPreview(result);
        }
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, engine, fp, api]);

  const setField = useCallback(
    (patch: Partial<Draft>) => setFp((prev) => ({ ...prev, ...patch })),
    [],
  );
  const num = (raw: string): number | undefined => {
    const n = raw.trim() === "" ? Number.NaN : Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };

  if (!profile) {
    return null;
  }

  const persist = async (): Promise<BrowserProfilePayload[] | null> => {
    if (!api) {
      return null;
    }
    return engine === "fingerprint"
      ? api.setFingerprint(profile.id, fp)
      : api.setEngine(profile.id, "system");
  };
  const commit = async (thenTest: boolean) => {
    if (saving) {
      return;
    }
    setSaving(true);
    try {
      const profiles = await persist();
      if (profiles) {
        onSaved(profiles);
      }
      onOpenChange(false);
      if (thenTest) {
        onTest(profile.id);
      }
    } finally {
      setSaving(false);
    }
  };

  // Apply a template's fields to the draft; the profile keeps its own seed unless
  // the template pins one (a clone / captured device).
  const applyTemplate = (template: FingerprintTemplatePayload) => {
    setFp((prev) => ({
      ...prev,
      ...template.fingerprint,
      seed: template.fingerprint.seed ?? prev.seed,
    }));
    setTemplateNote(`Applied “${template.name}”.`);
  };
  const doImport = async () => {
    if (!tapi) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(importText);
    } catch {
      setTemplateNote("That isn’t valid JSON.");
      return;
    }
    const res = await tapi.import(parsed);
    setTemplates(res.templates);
    setImportText("");
    setImportOpen(false);
    setTemplateNote(
      res.warnings.length
        ? `Imported — ${res.warnings.length} invalid field(s) dropped.`
        : "Imported.",
    );
  };
  const doSaveTemplate = async () => {
    if (!tapi || !saveName.trim()) {
      return;
    }
    setTemplates(await tapi.save(saveName.trim(), fp));
    setSaveName("");
    setSaveOpen(false);
    setTemplateNote("Saved as a template.");
  };
  const doDeleteTemplate = async (id: string) => {
    if (tapi) {
      setTemplates(await tapi.delete(id));
    }
  };

  const engineButton = (value: Engine, label: string) => (
    <button
      type="button"
      onClick={() => setEngine(value)}
      className={cn(
        "flex-1 rounded-md px-3 py-1.5 font-medium text-xs transition-colors",
        engine === value
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );

  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[120] bg-scrim backdrop-blur-sm ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed top-1/2 left-1/2 z-[121] flex max-h-[min(88vh,760px)] w-[min(600px,calc(100vw-32px))] min-w-0 -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl border border-border bg-background shadow-xl outline-none ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.97] data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98]">
          <header className="flex items-start justify-between gap-4 border-border border-b px-6 py-5">
            <div className="min-w-0">
              <DialogPrimitive.Title className="truncate font-semibold text-[19px] text-foreground">
                Fingerprint · {profile.name}
              </DialogPrimitive.Title>
              <p className="mt-0.5 text-muted-foreground text-xs">
                Spoof a browsing identity so this profile looks like a distinct
                device.
              </p>
            </div>
            <DialogPrimitive.Close
              render={
                <button
                  aria-label="Close"
                  className={cn(
                    buttonVariants({ variant: "outline", size: "icon" }),
                    "shrink-0 rounded-full",
                  )}
                  type="button"
                >
                  <X size={16} />
                </button>
              }
            />
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {/* Engine toggle */}
            <div className="mb-5 flex items-center gap-1 rounded-lg bg-fg-2 p-1">
              {engineButton("system", "System Chrome")}
              {engineButton("fingerprint", "Fingerprint")}
            </div>

            {engine === "system" ? (
              <p className="rounded-lg border border-border bg-fg-2 px-3 py-2.5 text-muted-foreground text-sm">
                This profile launches your installed Chrome with real logins and
                no spoofing. Switch to <strong>Fingerprint</strong> to give it a
                distinct, detection-resistant fingerprint (a fresh identity —
                sign in inside it).
              </p>
            ) : (
              <div className="space-y-5">
                {/* Templates */}
                <section>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className={labelCls}>Start from a template</span>
                    <div className="flex gap-3 text-xs">
                      <button
                        type="button"
                        className="font-medium text-foreground/70 hover:text-foreground"
                        onClick={() => {
                          setSaveOpen((v) => !v);
                          setImportOpen(false);
                        }}
                      >
                        Save current
                      </button>
                      <button
                        type="button"
                        className="font-medium text-foreground/70 hover:text-foreground"
                        onClick={() => {
                          setImportOpen((v) => !v);
                          setSaveOpen(false);
                        }}
                      >
                        Import JSON
                      </button>
                    </div>
                  </div>
                  {templates.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {templates.map((t) => (
                        <span
                          key={t.id}
                          className="inline-flex items-center gap-1 rounded-full border border-border bg-fg-2 py-0.5 pr-1 pl-2.5 text-xs"
                        >
                          <button
                            type="button"
                            className="text-foreground"
                            onClick={() => applyTemplate(t)}
                            title="Apply to this profile"
                          >
                            {t.name}
                          </button>
                          {t.source === "builtin" ? null : (
                            <button
                              type="button"
                              aria-label="Delete template"
                              className="text-muted-foreground hover:text-destructive"
                              onClick={() => void doDeleteTemplate(t.id)}
                            >
                              <X size={11} />
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {saveOpen ? (
                    <div className="mt-2 flex gap-1.5">
                      <input
                        className={inputCls}
                        placeholder="Template name"
                        value={saveName}
                        onChange={(e) => setSaveName(e.target.value)}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 shrink-0"
                        onClick={() => void doSaveTemplate()}
                      >
                        Save
                      </Button>
                    </div>
                  ) : null}
                  {importOpen ? (
                    <div className="mt-2 space-y-1.5">
                      <textarea
                        className="h-20 w-full rounded-lg bg-fg-2 px-2.5 py-2 font-mono text-foreground text-xs outline-none transition-colors focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring"
                        placeholder={
                          '{"name":"…","fingerprint":{"platform":"windows","brand":"Chrome"}}'
                        }
                        value={importText}
                        onChange={(e) => setImportText(e.target.value)}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void doImport()}
                      >
                        Import
                      </Button>
                    </div>
                  ) : null}
                  {templateNote ? (
                    <p className="mt-2 text-muted-foreground text-xs">
                      {templateNote}
                    </p>
                  ) : null}
                </section>

                {preview.warnings.length > 0 ? (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-700 text-xs dark:text-amber-400">
                    {preview.warnings.map((w) => (
                      <div key={w}>⚠ {w}</div>
                    ))}
                  </div>
                ) : null}

                {/* Identity */}
                <section className="grid grid-cols-2 gap-3">
                  <Field label="Platform">
                    <select
                      className={inputCls}
                      value={fp.platform}
                      onChange={(e) =>
                        setField({
                          platform: e.target.value as Draft["platform"],
                        })
                      }
                    >
                      {PLATFORMS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Seed (identity)">
                    <div className="flex gap-1.5">
                      <input
                        className={inputCls}
                        inputMode="numeric"
                        value={fp.seed}
                        onChange={(e) =>
                          setField({ seed: num(e.target.value) ?? fp.seed })
                        }
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        title="Randomize (new identity)"
                        className="size-9 shrink-0"
                        onClick={() => setField({ seed: randomSeed() })}
                      >
                        <RefreshCw className="size-4" />
                      </Button>
                    </div>
                  </Field>
                  <Field label="Browser brand">
                    <select
                      className={inputCls}
                      value={fp.brand ?? ""}
                      onChange={(e) =>
                        setField({
                          brand: (e.target.value ||
                            undefined) as Draft["brand"],
                        })
                      }
                    >
                      <option value="">Auto (from seed)</option>
                      {BRANDS.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Brand version">
                    <input
                      className={inputCls}
                      placeholder="auto"
                      value={fp.brandVersion ?? ""}
                      onChange={(e) =>
                        setField({ brandVersion: e.target.value || undefined })
                      }
                    />
                  </Field>
                </section>

                {/* Hardware */}
                <section className="grid grid-cols-2 gap-3">
                  <Field label="GPU vendor">
                    <input
                      className={inputCls}
                      placeholder="auto (from seed)"
                      value={fp.gpuVendor ?? ""}
                      onChange={(e) =>
                        setField({ gpuVendor: e.target.value || undefined })
                      }
                    />
                  </Field>
                  <Field label="GPU renderer">
                    <input
                      className={inputCls}
                      placeholder="auto (from seed)"
                      value={fp.gpuRenderer ?? ""}
                      onChange={(e) =>
                        setField({ gpuRenderer: e.target.value || undefined })
                      }
                    />
                  </Field>
                  <Field label="CPU cores">
                    <input
                      className={inputCls}
                      inputMode="numeric"
                      placeholder="8"
                      value={fp.hardwareConcurrency ?? ""}
                      onChange={(e) =>
                        setField({ hardwareConcurrency: num(e.target.value) })
                      }
                    />
                  </Field>
                  <Field label="Memory (GB)">
                    <input
                      className={inputCls}
                      inputMode="numeric"
                      placeholder="8"
                      value={fp.deviceMemory ?? ""}
                      onChange={(e) =>
                        setField({ deviceMemory: num(e.target.value) })
                      }
                    />
                  </Field>
                  <Field label="Screen width">
                    <input
                      className={inputCls}
                      inputMode="numeric"
                      placeholder="1920"
                      value={fp.screenWidth ?? ""}
                      onChange={(e) =>
                        setField({ screenWidth: num(e.target.value) })
                      }
                    />
                  </Field>
                  <Field label="Screen height">
                    <input
                      className={inputCls}
                      inputMode="numeric"
                      placeholder="1080"
                      value={fp.screenHeight ?? ""}
                      onChange={(e) =>
                        setField({ screenHeight: num(e.target.value) })
                      }
                    />
                  </Field>
                </section>

                {/* Locale */}
                <section className="grid grid-cols-2 gap-3">
                  <Field label="Timezone (IANA)">
                    <input
                      className={inputCls}
                      placeholder="America/New_York"
                      value={fp.timezone ?? ""}
                      onChange={(e) =>
                        setField({ timezone: e.target.value || undefined })
                      }
                    />
                  </Field>
                  <Field label="Locale (BCP-47)">
                    <input
                      className={inputCls}
                      placeholder="en-US"
                      value={fp.locale ?? ""}
                      onChange={(e) =>
                        setField({ locale: e.target.value || undefined })
                      }
                    />
                  </Field>
                </section>

                <label className="flex items-center gap-2 text-foreground text-sm">
                  <input
                    type="checkbox"
                    checked={fp.noise !== false}
                    onChange={(e) => setField({ noise: e.target.checked })}
                  />
                  Canvas / WebGL / audio noise (recommended)
                </label>
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-between gap-2 border-border border-t px-6 py-4">
            <Button
              type="button"
              variant="ghost"
              disabled={engine !== "fingerprint" || saving}
              onClick={() => void commit(true)}
              title="Save & open browserscan.net in this profile"
            >
              Launch & test
            </Button>
            <div className="flex items-center gap-2">
              <DialogPrimitive.Close
                render={
                  <button
                    className={buttonVariants({ variant: "outline" })}
                    type="button"
                  >
                    Cancel
                  </button>
                }
              />
              <Button
                disabled={saving}
                onClick={() => void commit(false)}
                type="button"
              >
                Save
              </Button>
            </div>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
