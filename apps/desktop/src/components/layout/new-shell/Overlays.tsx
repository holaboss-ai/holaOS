import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useAtom, useSetAtom, type PrimitiveAtom } from "jotai";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SettingsScreenRoot } from "@/components/layout/SettingsScreenRoot";
import { AutomationsPane } from "@/components/panes/AutomationsPane";
import { MarketplacePane } from "@/components/panes/MarketplacePane";
import { Button } from "@/components/ui/button";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import {
  automationsOpenAtom,
  chatComposerPrefillAtom,
  focusModeAtom,
  marketplaceOpenAtom,
  settingsOpenAtom,
  settingsSectionAtom,
} from "./state/ui";
import { useSettingsState } from "./useSettingsState";

export function Overlays() {
  return (
    <>
      <AutomationsOverlay />
      <MarketplaceOverlay />
      <SettingsOverlay />
    </>
  );
}

type PaneOverlaySize = "md" | "lg" | "xl";

const SIZE_CLASS: Record<PaneOverlaySize, string> = {
  md: "w-[min(640px,calc(100vw-48px))] h-[min(560px,calc(100vh-96px))]",
  lg: "w-[min(880px,calc(100vw-48px))] h-[min(680px,calc(100vh-96px))]",
  xl: "w-[min(1100px,calc(100vw-48px))] h-[min(800px,calc(100vh-96px))]",
};

function PaneOverlay({
  openAtom,
  title,
  size = "lg",
  children,
}: {
  openAtom: PrimitiveAtom<boolean>;
  title: string;
  size?: PaneOverlaySize;
  children: ReactNode;
}) {
  const [open, setOpen] = useAtom(openAtom);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-40 bg-foreground/30 opacity-0 transition-opacity duration-snappy ease-emphasized data-open:opacity-100" />
        <DialogPrimitive.Popup className="group fixed inset-0 z-40 grid place-items-center opacity-0 outline-none transition-opacity duration-base ease-emphasized data-open:opacity-100">
          <div
            className={`flex scale-[0.96] flex-col overflow-hidden rounded-xl border border-border bg-muted shadow-2xl ring-1 ring-foreground/5 transition-transform duration-stride ease-emphasized group-data-[open]:scale-100 ${SIZE_CLASS[size]}`}
            style={{ willChange: "transform" }}
          >
            <div className="relative flex shrink-0 items-center px-4 pt-3 pb-2">
              <span className="text-sm font-medium text-foreground/90">
                {title}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="ml-auto text-foreground/55 hover:text-foreground"
              >
                <X className="size-3.5" />
              </Button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-lg border-t border-border/50 bg-background">
              {children}
            </div>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function AutomationsOverlay() {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const setAutomationsOpen = useSetAtom(automationsOpenAtom);
  const setFocusMode = useSetAtom(focusModeAtom);
  const setComposerPrefill = useSetAtom(chatComposerPrefillAtom);
  const prefillKeyRef = useRef(0);

  // Route schedule create/edit through the chat composer, matching the
  // legacy AppShell behavior. We close the overlay + exit focus so the
  // user lands in chat with the prefill text ready to edit.
  const sendChatPrefill = useCallback(
    (text: string) => {
      prefillKeyRef.current += 1;
      setComposerPrefill({
        text,
        requestKey: prefillKeyRef.current,
        mode: "replace",
        sessionMode: "draft",
      });
      setFocusMode(false);
      setAutomationsOpen(false);
    },
    [setAutomationsOpen, setComposerPrefill, setFocusMode],
  );

  const handleCreateSchedule = useCallback(() => {
    sendChatPrefill("Create a schedule for ");
  }, [sendChatPrefill]);

  const handleEditSchedule = useCallback(
    (job: CronjobRecordPayload) => {
      const label = job.name?.trim() || job.cron;
      sendChatPrefill(`Edit the "${label}" schedule: `);
    },
    [sendChatPrefill],
  );

  return (
    <PaneOverlay
      openAtom={automationsOpenAtom}
      title="Automations"
      size="md"
    >
      <AutomationsPane
        workspaceId={selectedWorkspaceId || null}
        onCreateSchedule={handleCreateSchedule}
        onEditSchedule={handleEditSchedule}
      />
    </PaneOverlay>
  );
}

function MarketplaceOverlay() {
  return (
    <PaneOverlay
      openAtom={marketplaceOpenAtom}
      title="Marketplace"
      size="xl"
    >
      <div className="h-full overflow-y-auto">
        <MarketplacePane variant="embedded" />
      </div>
    </PaneOverlay>
  );
}

function SettingsOverlay() {
  const setOpen = useSetAtom(settingsOpenAtom);
  const [section, setSection] = useAtom(settingsSectionAtom);
  const settings = useSettingsState();
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.appUpdate
      ?.getStatus()
      .then((status) => {
        if (!cancelled) setAppVersion(status?.currentVersion ?? "");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PaneOverlay openAtom={settingsOpenAtom} title="Settings" size="xl">
      <SettingsScreenRoot
        activeSection={section}
        appVersion={appVersion}
        onSectionChange={setSection}
        onBackToApp={() => setOpen(false)}
        colorScheme={settings.colorScheme}
        onColorSchemeChange={settings.onColorSchemeChange}
        themeVariant={settings.themeVariant}
        themeVariants={settings.themeVariants}
        onThemeVariantChange={settings.onThemeVariantChange}
        workspaceCardsPerRow={settings.cardsPerRow}
        onWorkspaceCardsPerRowChange={settings.onCardsPerRowChange}
        desktopNotificationsEnabled={settings.notificationsEnabled}
        onDesktopNotificationsChange={settings.onNotificationsChange}
        onOpenExternalUrl={settings.onOpenExternalUrl}
      />
    </PaneOverlay>
  );
}
