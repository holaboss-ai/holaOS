import { ChevronLeft, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { STOPLIGHT_PAD_PX, useStoplightCompensation } from "@/lib/StoplightContext";
import { cn } from "@/lib/utils";

export interface SettingsScreenNavEntry<TSection extends string> {
  id: TSection;
  label: string;
  icon: LucideIcon;
}

export interface SettingsScreenProps<TSection extends string> {
  /** Sections shown in the left rail in order. */
  sections: ReadonlyArray<SettingsScreenNavEntry<TSection>>;
  /** Currently active section id. */
  activeSection: TSection;
  /** Callback when the user picks a different section. */
  onSectionChange: (section: TSection) => void;
  /** "← Back to app" — returns the user to the previous shell view. */
  onBackToApp: () => void;
  /** The active page body (use SettingsPage). */
  children: ReactNode;
}

/**
 * SettingsScreen
 *
 * Full-height settings shell. Two-column layout: a 240px nav rail on the
 * left (lighter surface, "Back to app" + section entries with lucide
 * icons), and a scrollable content area on the right that hosts a
 * `SettingsPage`.
 *
 * Replaces the old modal `SettingsDialog`. Lives at AppShell level —
 * AppShell switches between "control_center" / "space" / "settings" by
 * mounting different roots, so this component owns its own scroll
 * region and stoplight compensation.
 */
export function SettingsScreen<TSection extends string>({
  sections,
  activeSection,
  onSectionChange,
  onBackToApp,
  children,
}: SettingsScreenProps<TSection>) {
  const compensateForStoplight = useStoplightCompensation();
  const railTopPad = compensateForStoplight ? STOPLIGHT_PAD_PX : 16;

  return (
    <div className="grid h-full min-h-0 w-full grid-cols-[240px_minmax(0,1fr)] bg-background">
      <aside className="flex min-h-0 flex-col border-r border-border bg-fg-2">
        <div
          className="px-3 pb-1"
          style={{ paddingTop: railTopPad }}
        >
          <button
            type="button"
            onClick={onBackToApp}
            className="window-no-drag flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <ChevronLeft className="size-4" />
            Back to app
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 pt-3 pb-4">
          <ul className="grid gap-0.5">
            {sections.map(({ id, label, icon: Icon }) => {
              const active = id === activeSection;
              return (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => onSectionChange(id)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                      active
                        ? "bg-accent font-medium text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <Icon className="size-4 shrink-0" strokeWidth={1.6} />
                    <span className="min-w-0 truncate">{label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>

      <main className="min-h-0 overflow-y-auto [scrollbar-gutter:stable]">
        {children}
      </main>
    </div>
  );
}
