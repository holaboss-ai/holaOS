import type { IconType } from "@/components/ui/icons";
import type { ReactNode } from "react";

import {
  STOPLIGHT_PAD_PX,
  useStoplightCompensation,
} from "@/lib/StoplightContext";
import { cn } from "@/lib/utils";

export interface SettingsScreenNavEntry<TSection extends string> {
  id: TSection;
  label: string;
  icon: IconType;
}

export interface SettingsScreenProps<TSection extends string> {
  sections: ReadonlyArray<SettingsScreenNavEntry<TSection>>;
  activeSection: TSection;
  onSectionChange: (section: TSection) => void;
  /** Optional small bar pinned to the bottom of the left rail —
   *  hosts app-meta links (docs, help, version) without bloating
   *  the section list. */
  railFooter?: ReactNode;
  children: ReactNode;
}

/**
 * SettingsScreen
 *
 * Full-height settings shell. Two-column layout: a 240px nav rail on the
 * left (lighter surface, section entries with lucide icons), and a
 * scrollable content area on the right that hosts a `SettingsPage`.
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
  railFooter,
  children,
}: SettingsScreenProps<TSection>) {
  return (
    <div className="grid h-full min-h-0 w-full grid-cols-[220px_minmax(0,1fr)] bg-background">
      {/* Sidebar: softer border + calmer chrome. Active state uses the
          foreground/[0.06] tint shared with the popovers (cmd palette,
          model picker) — same calm-confident visual rhythm everywhere. */}
      <aside className="flex min-h-0 flex-col border-r border-border/60">
        <nav
          className="chat-scrollbar-thin flex-1 overflow-y-auto px-3 py-6"
        >
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
                      "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                      active
                        ? "bg-foreground/6 font-medium text-foreground"
                        : "text-foreground/65 hover:bg-foreground/4 hover:text-foreground",
                    )}
                  >
                    <Icon
                      className={cn(
                        "size-3.5 shrink-0",
                        active ? "text-foreground/80" : "text-foreground/55",
                      )}
                      strokeWidth={1.75}
                    />
                    <span className="min-w-0 truncate">{label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        {railFooter ? (
          <div className="shrink-0 border-t border-border/40 px-3 pb-2.5 pt-2">
            {railFooter}
          </div>
        ) : null}
      </aside>

      <main className="chat-scrollbar-thin min-h-0 overflow-y-auto [scrollbar-gutter:stable]">
        {children}
      </main>
    </div>
  );
}
