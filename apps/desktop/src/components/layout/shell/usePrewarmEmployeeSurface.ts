import { useEffect, useRef } from "react";
import { useHolaAppCatalog } from "./useHolaAppCatalog";

// Prewarm the HolaEmployee web surface as soon as it's known to be available — i.e.
// once the (auth-gated, org-scoped) catalog has loaded and contains it, which means
// we're signed in and the main process can seed a valid session into the surface.
// This kicks off a background (detached, invisible) load so the FIRST open reveals
// instantly via the warm-reopen path instead of paying a cold SPA download.
//
// Fires at most once per app run. Home is already warm by being the default landing,
// so only HolaEmployee — the other first-class surface — needs this.
export function usePrewarmEmployeeSurface(): void {
  const { catalog } = useHolaAppCatalog();
  const prewarmedRef = useRef(false);

  useEffect(() => {
    if (prewarmedRef.current) {
      return;
    }
    const appSurface = window.electronAPI?.appSurface;
    if (!appSurface?.prewarmWebApp) {
      return;
    }
    if (!catalog.some((entry) => entry.holaAppId === "holaemployee")) {
      return;
    }
    prewarmedRef.current = true;
    void appSurface.prewarmWebApp("holaemployee");
  }, [catalog]);
}
