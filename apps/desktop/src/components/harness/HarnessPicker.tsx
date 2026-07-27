import { useSetAtom } from "jotai";
import { useMemo } from "react";

import {
  settingsOpenAtom,
  settingsSectionAtom,
} from "@/components/layout/shell/state/ui";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Check, ChevronDown, ChevronRight } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { HarnessAvatar } from "./HarnessAvatar";
import { isBetaHarness } from "./harnessMeta";
import {
  sortHarnessesByStatus,
  useHarnessReadiness,
} from "./harnessReadiness";

/**
 * Per-session harness picker. The runtime exposes which harnesses are
 * available locally; unavailable ones still appear in the menu but are
 * disabled with the install hint as a tooltip. The picker is meant to be
 * placed next to the composer on a "new session" surface — once a
 * session is created, its harness is immutable, so the picker should not
 * be shown on existing sessions.
 */
export function HarnessPicker({
  value,
  harnesses,
  disabled,
  isLoading,
  onChange,
  className,
  inline,
}: {
  value: string;
  harnesses: HarnessAvailabilityEntryPayload[];
  disabled?: boolean;
  isLoading?: boolean;
  onChange: (id: string) => void;
  className?: string;
  /** Render as a quiet inline trigger (icon + name + chevron), for use
   * inside a sentence-style caption rather than as a standalone pill. */
  inline?: boolean;
}) {
  const readiness = useHarnessReadiness();
  const sortedHarnesses = useMemo(
    () => sortHarnessesByStatus(harnesses, readiness.get),
    [harnesses, readiness.get],
  );
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const setSettingsSection = useSetAtom(settingsSectionAtom);
  const openAgentsSettings = () => {
    // Defer to the next tick so the dropdown finishes closing before the
    // Settings overlay opens — otherwise the menu's close/focus-return can
    // swallow the open and the click appears to do nothing.
    setTimeout(() => {
      setSettingsSection("agents");
      setSettingsOpen(true);
    }, 0);
  };

  const selectedLabel = useMemo(() => {
    if (isLoading && harnesses.length === 0) {
      return "Loading…";
    }
    return harnesses.find((h) => h.id === value)?.display_name ?? value;
  }, [harnesses, isLoading, value]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          inline ? (
            <button
              type="button"
              disabled={disabled || isLoading}
              className={cn(
                "inline-flex items-center gap-1 rounded font-medium text-foreground/80 outline-none transition-colors hover:text-foreground disabled:opacity-60",
                className,
              )}
            >
              <HarnessAvatar harnessId={value} size="sm" />
              <span>{selectedLabel}</span>
              <ChevronDown className="size-3 text-muted-foreground" />
            </button>
          ) : (
            // Field-style trigger (used in the Automations dialog): icon +
            // label left, chevron pushed to the right, full width.
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || isLoading}
              className={cn(
                "w-full justify-start gap-1.5 text-xs font-medium text-foreground",
                className,
              )}
            >
              <HarnessAvatar harnessId={value} size="sm" />
              <span className="flex-1 truncate text-left">{selectedLabel}</span>
              <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
            </Button>
          )
        }
      />
      <DropdownMenuContent align="start" className="min-w-[240px]">
        {sortedHarnesses.map((entry) => {
          const isBuiltIn = entry.detection === "in-process";
          // Only a verified-working agent is selectable. Built-in (Hola) needs
          // no verification; an external agent must pass a connection test
          // first. Rather than repeat a warning per row, a not-ready row shows
          // a compact "Set up" chip and — on click — jumps to Settings → Agents
          // (install / sign-in / test all live there) instead of selecting.
          const ready =
            isBuiltIn ||
            (entry.available && readiness.get(entry.id)?.status === "ready");
          return (
            <DropdownMenuItem
              key={entry.id}
              onClick={() => {
                if (ready) {
                  onChange(entry.id);
                } else {
                  openAgentsSettings();
                }
              }}
              title={ready ? entry.detection : "Set up in Settings → Agents"}
              className="flex items-center gap-2.5"
            >
              {/* Each agent shows its own avatar (Hola → the Hola face);
                  vendor harnesses fall through to their provider-mark tile.
                  All render at the same size-6 box so the icon column stays
                  aligned. */}
              <HarnessAvatar harnessId={entry.id} size="md" />
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="truncate text-sm">{entry.display_name}</span>
                {isBetaHarness(entry.id) ? (
                  <span className="shrink-0 rounded-sm border border-amber-500/30 bg-amber-500/10 px-1 text-[9px] font-medium text-amber-700 dark:text-amber-400">
                    Beta
                  </span>
                ) : null}
              </span>
              {ready ? (
                entry.id === value ? (
                  <Check className="size-4 shrink-0 text-foreground" />
                ) : null
              ) : (
                <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground/70">
                  Set up
                  <ChevronRight className="size-3.5" />
                </span>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
