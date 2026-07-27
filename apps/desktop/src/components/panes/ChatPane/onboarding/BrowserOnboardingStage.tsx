import { motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { Check, Globe, Loader2 } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { OnboardingStageLayout } from "./OnboardingStageLayout";

/**
 * Seed the default browser profile from a browser the user already signed into.
 *
 * A fresh install always has an empty "Main" profile, so the agent's first
 * browsing turn hits a logged-out web. Importing here copies a real Chromium
 * profile — cookies, logins, bookmarks — and makes it the default, so the agent
 * starts already signed in wherever the user is.
 *
 * As in the stage this replaces: the first profile of a browser is taken
 * automatically. A picker mid-onboarding buys multi-profile users little, and
 * Browsers → Import can target an exact profile later. Safari is absent because
 * its store can't be copied into Chrome's format.
 */

type ImportSource = Exclude<BrowserImportSource, "safari">;

const SOURCES: Array<{ value: ImportSource; label: string }> = [
  { value: "chrome", label: "Google Chrome" },
  { value: "edge", label: "Microsoft Edge" },
  { value: "brave", label: "Brave" },
  { value: "arc", label: "Arc" },
  { value: "dia", label: "Dia" },
  { value: "chromium", label: "Chromium" },
];

interface Detected {
  source: ImportSource;
  label: string;
  /** The profile taken automatically — the browser's first. */
  option: BrowserImportProfileOptionPayload;
  /** How many the browser has, so the copy can be honest about the choice. */
  total: number;
}

type Phase =
  | { kind: "detecting" }
  | { kind: "ready"; found: Detected[] }
  | { kind: "importing"; found: Detected[]; source: ImportSource }
  | { kind: "done"; found: Detected[]; source: ImportSource; name: string }
  | { kind: "error"; found: Detected[]; message: string };

export function BrowserOnboardingStage({
  stageIndex,
  totalStages,
  onBack,
  onSkip,
  onNext,
}: {
  stageIndex: number;
  totalStages: number;
  onBack: () => void;
  onSkip: () => void;
  onNext: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "detecting" });

  useEffect(() => {
    let alive = true;
    const api = window.electronAPI?.profiles;
    if (!api) {
      setPhase({ kind: "ready", found: [] });
      return;
    }
    void (async () => {
      const found: Detected[] = [];
      for (const { value, label } of SOURCES) {
        // A browser that isn't installed resolves to an empty list, so probing
        // every source IS the detection — there is no separate "is it there".
        const options = await api.listImportSources(value).catch(() => []);
        const first = options[0];
        if (first) {
          found.push({ source: value, label, option: first, total: options.length });
        }
      }
      if (alive) {
        setPhase({ kind: "ready", found });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const importFrom = useCallback(
    async (entry: Detected, found: Detected[]) => {
      const api = window.electronAPI?.profiles;
      if (!api) return;
      setPhase({ kind: "importing", found, source: entry.source });
      try {
        const result = await api.import({
          source: entry.source,
          profileDir: entry.option.profileDir,
          profileLabel: entry.option.profileLabel,
        });
        // The import lands a new profile; onboarding's whole point is that it
        // becomes the one the agent reaches for.
        await api.setDefault(result.profile.id);
        setPhase({
          kind: "done",
          found,
          source: entry.source,
          name: result.profile.name,
        });
      } catch (error) {
        setPhase({
          kind: "error",
          found,
          message:
            error instanceof Error && error.message.trim()
              ? error.message.trim()
              : "That import didn't finish.",
        });
      }
    },
    [],
  );

  const found = phase.kind === "detecting" ? [] : phase.found;
  const importedSource = phase.kind === "done" ? phase.source : null;

  return (
    <OnboardingStageLayout
      left={
        <>
          <div className="space-y-2.5">
            <h2 className="font-serif text-[26px] leading-[1.15] tracking-tight text-foreground">
              Bring your browser
            </h2>
            <p className="max-w-[440px] text-[13.5px] text-muted-foreground leading-[1.55]">
              {phase.kind === "ready" && found.length === 0
                ? "No Chromium browser turned up on this Mac, so holaOS will start with a fresh profile. You can import one later from Browsers."
                : "Copy a browser you're already signed into and holaOS browses as you — same logins, same bookmarks. Nothing leaves this machine."}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            {phase.kind === "detecting" ? (
              <p className="flex items-center gap-2 py-2 text-[13px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Looking for installed browsers…
              </p>
            ) : null}

            {found.map((entry) => (
              <BrowserCard
                busy={phase.kind === "importing" && phase.source === entry.source}
                disabled={phase.kind === "importing" || importedSource !== null}
                imported={importedSource === entry.source}
                key={entry.source}
                label={entry.label}
                onImport={() => void importFrom(entry, found)}
                profileLabel={entry.option.profileLabel}
                total={entry.total}
              />
            ))}
          </div>

          {phase.kind === "done" ? (
            <p className="text-[12.5px] text-muted-foreground">
              “{phase.name}” is now your default profile.
            </p>
          ) : null}
          {phase.kind === "error" ? (
            <p className="text-[12.5px] text-destructive">{phase.message}</p>
          ) : null}
        </>
      }
      onBack={onBack}
      onPrimaryAction={onNext}
      onSkip={onSkip}
      primaryActionDisabled={phase.kind === "importing"}
      primaryActionLabel={
        importedSource ? "Continue" : "Continue without importing"
      }
      right={<BrowserPreview />}
      stageIndex={stageIndex}
      totalStages={totalStages}
    />
  );
}

function BrowserCard({
  label,
  profileLabel,
  total,
  imported,
  busy,
  disabled,
  onImport,
}: {
  label: string;
  profileLabel: string;
  total: number;
  imported: boolean;
  busy: boolean;
  disabled: boolean;
  onImport: () => void;
}) {
  return (
    <motion.button
      aria-label={imported ? `${label} — imported` : `Import from ${label}`}
      className={cn(
        "relative flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
        imported
          ? "border-border/40 bg-muted/40"
          : "border-border bg-background hover:border-foreground/15 hover:bg-fg-2",
        busy && "cursor-progress opacity-90",
        disabled && !imported && !busy && "opacity-50",
      )}
      disabled={disabled || busy || imported}
      onClick={onImport}
      type="button"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-fg-4 text-muted-foreground">
        <Globe className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-[13.5px] text-foreground">
          {label}
        </span>
        <span className="block truncate text-[12px] text-muted-foreground">
          {total > 1
            ? `${profileLabel} · ${total - 1} other profile${total > 2 ? "s" : ""} available later`
            : profileLabel}
        </span>
      </span>
      {busy ? (
        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
      ) : imported ? (
        <Check className="size-4 shrink-0 text-success" />
      ) : null}
    </motion.button>
  );
}

function BrowserPreview() {
  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="w-full max-w-[320px] overflow-hidden rounded-xl border border-border bg-background shadow-sm">
        <div className="flex items-center gap-1.5 border-border/60 border-b px-3 py-2">
          <span className="size-2 rounded-full bg-fg-12" />
          <span className="size-2 rounded-full bg-fg-8" />
          <span className="size-2 rounded-full bg-fg-6" />
          <span className="ml-2 h-4 flex-1 rounded bg-fg-4" />
        </div>
        <div className="flex flex-col gap-2 p-4">
          <span className="h-2.5 w-2/3 rounded bg-fg-6" />
          <span className="h-2 w-full rounded bg-fg-4" />
          <span className="h-2 w-5/6 rounded bg-fg-4" />
          <span className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Check className="size-3 text-success" />
            Signed in as you
          </span>
        </div>
      </div>
    </div>
  );
}
