import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useAtom, useSetAtom, type PrimitiveAtom } from "jotai";
import { X } from "@/components/ui/icons";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { SettingsScreenRoot } from "@/components/layout/SettingsScreenRoot";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { KEYBOARD_SHORTCUT_GROUPS, shortcutKeyLabel } from "./keyboardShortcuts";
import {
  settingsOpenAtom,
  settingsSectionAtom,
  shortcutsHelpOpenAtom,
} from "./state/ui";
import { useSettingsState } from "./useSettingsState";
import { useOpenHolaApp } from "./useOpenHolaApp";
import { consumePendingAppOpen } from "@/lib/app-sdk-client";
import { useDesktopAuthSession } from "@/lib/auth/authClient";

export function Overlays() {
  return (
    <>
      <DeepLinkAppOpener />
      <SettingsOverlay />
      <KeyboardShortcutsOverlay />
    </>
  );
}

// Web deep link (ai.holaboss.app://open-app?appId=…) → main forwards it here;
// open the app surface via the normal useOpenHolaApp() flow. Title falls back to
// the appId — the web surface renders its own branding once loaded.
function DeepLinkAppOpener() {
  const openHolaApp = useOpenHolaApp();
  const { data: authSession } = useDesktopAuthSession();
  const userId = authSession?.user?.id ?? null;

  useEffect(() => {
    const open = (target: { appId: string; path?: string }) =>
      openHolaApp({
        holaAppId: target.appId,
        title: target.appId,
        ...(target.path ? { path: target.path } : {}),
      });
    // Realtime: deep links that arrive while this is mounted.
    const off = window.electronAPI?.appSurface?.onOpenFromDeepLink?.(open);
    // Catch-up: a deep link that landed before this mounted (cold start /
    // pre-sign-in) is cached in main; consume it once on mount.
    void window.electronAPI?.appSurface
      ?.consumePendingDeepLink?.()
      .then((target) => {
        if (target) {
          open(target);
        }
      });
    return () => off?.();
  }, [openHolaApp]);

  // Deferred deep link: the user hit "Open in desktop" on the web *before*
  // installing, so there was no running desktop to receive the URL scheme — the
  // intent was parked server-side instead. Once they're signed in here, claim
  // it and land them on the app they came for. Fires once per sign-in (userId
  // null → set); the server clears the row so a second call returns null.
  useEffect(() => {
    if (!userId) {
      return;
    }
    let cancelled = false;
    void consumePendingAppOpen()
      .then((target) => {
        if (cancelled || !target) {
          return;
        }
        openHolaApp({
          holaAppId: target.appId,
          title: target.appId,
          ...(target.path ? { path: target.path } : {}),
        });
      })
      .catch(() => {
        // best-effort: nothing parked, or not fully signed in yet
      });
    return () => {
      cancelled = true;
    };
  }, [userId, openHolaApp]);
  return null;
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
        <DialogPrimitive.Backdrop className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm opacity-0 transition-opacity duration-snappy ease-emphasized data-open:opacity-100" />
        <DialogPrimitive.Popup
          // Suppress base-ui's "focus the first focusable child" default
          // — that landed on the close X and made it look like the
          // headline action. The popup itself gets focus instead
          // (outline-none, so no visible ring); Esc still closes.
          initialFocus={false}
          // The popup fills the screen to center its card, so base-ui never
          // sees an outside-press. Close when the press lands on the backdrop
          // area (the wrapper itself), not bubbled from the card.
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setOpen(false);
            }
          }}
          className="group fixed inset-0 z-40 grid place-items-center opacity-0 outline-none transition-opacity duration-base ease-emphasized data-open:opacity-100"
        >
          <div
            className={`flex scale-[0.96] flex-col overflow-hidden rounded-xl border border-border/70 bg-muted shadow-2xl ring-1 ring-foreground/[0.04] transition-transform duration-stride ease-emphasized group-data-[open]:scale-100 ${SIZE_CLASS[size]}`}
            style={{ willChange: "transform" }}
          >
            {/* Title bar: confident-quiet — 13px medium reads as chrome
                without competing with the page H1 below. The bar is a
                touch taller (px-4.5 pt-3.5 pb-2.5) so the title and the
                close button both breathe. */}
            <div className="relative flex shrink-0 items-center px-4 pt-3 pb-2.5">
              <span className="text-sm font-medium tracking-wide text-foreground/75">
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
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-lg border-t border-border/40 bg-background">
              {children}
            </div>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function SettingsOverlay() {
  const [section, setSection] = useAtom(settingsSectionAtom);
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const settings = useSettingsState();
  const [appVersion, setAppVersion] = useState("");

  // Cross-process settings triggers (the composer's "Set up providers" button,
  // the app menu, the auth popup) round-trip through main and arrive here; open
  // the overlay and jump to the requested section. Without this listener the
  // ui:openSettingsPane event has no subscriber and those triggers do nothing.
  useEffect(() => {
    const off = window.electronAPI?.ui?.onOpenSettingsPane?.((next) => {
      setSection(next);
      setSettingsOpen(true);
    });
    return () => off?.();
  }, [setSection, setSettingsOpen]);

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
        colorScheme={settings.colorScheme}
        onColorSchemeChange={settings.onColorSchemeChange}
        fontFamily={settings.fontFamily}
        fontFamilies={settings.fontFamilies}
        onFontFamilyChange={settings.onFontFamilyChange}
        desktopNotificationsEnabled={settings.notificationsEnabled}
        onDesktopNotificationsChange={settings.onNotificationsChange}
        keepAwakeEnabled={settings.keepAwakeEnabled}
        onKeepAwakeChange={settings.onKeepAwakeChange}
        onOpenExternalUrl={settings.onOpenExternalUrl}
      />
    </PaneOverlay>
  );
}


function KeyboardShortcutsOverlay() {
  return (
    <PaneOverlay
      openAtom={shortcutsHelpOpenAtom}
      title="Keyboard shortcuts"
      size="md"
    >
      <div className="flex flex-col gap-5 overflow-y-auto p-5">
        {KEYBOARD_SHORTCUT_GROUPS.map((group) => (
          <div key={group.heading} className="flex flex-col gap-1.5">
            <div className="text-[10px] font-medium uppercase tracking-wider text-foreground/45">
              {group.heading}
            </div>
            <div className="flex flex-col">
              {group.items.map((item) => (
                <div
                  key={item.label}
                  className="flex items-center gap-3 rounded-md py-1.5 pl-2 pr-1 text-sm text-foreground/80"
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {item.keys.map((k, i) => (
                      <Kbd key={`${item.label}:${i}:${k}`}>
                        {shortcutKeyLabel(k)}
                      </Kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </PaneOverlay>
  );
}
