import { useEffect, useState } from "react";

const BROWSER_GLOW_PREVIEW_EVENT = "holaboss:browser-glow-preview-change";

declare global {
  interface Window {
    __holabossBrowserGlowPreviewEnabled?: boolean;
    __holabossDevBrowserGlowPreview?: {
      on: () => void;
      off: () => void;
      toggle: () => void;
      set: (next: boolean) => void;
      get: () => boolean;
    };
  }
}

function setBrowserGlowPreviewEnabled(next: boolean) {
  window.__holabossBrowserGlowPreviewEnabled = next;
  window.dispatchEvent(
    new CustomEvent(BROWSER_GLOW_PREVIEW_EVENT, {
      detail: next,
    }),
  );
}

export function useBrowserGlowPreview() {
  const [enabled, setEnabled] = useState(
    () => window.__holabossBrowserGlowPreviewEnabled === true,
  );

  useEffect(() => {
    const applyCurrentState = () => {
      setEnabled(window.__holabossBrowserGlowPreviewEnabled === true);
    };

    const handlePreviewChange = () => {
      applyCurrentState();
    };

    applyCurrentState();
    window.addEventListener(
      BROWSER_GLOW_PREVIEW_EVENT,
      handlePreviewChange as EventListener,
    );
    window.__holabossDevBrowserGlowPreview = {
      on: () => setBrowserGlowPreviewEnabled(true),
      off: () => setBrowserGlowPreviewEnabled(false),
      toggle: () =>
        setBrowserGlowPreviewEnabled(
          window.__holabossBrowserGlowPreviewEnabled !== true,
        ),
      set: (next: boolean) => setBrowserGlowPreviewEnabled(next),
      get: () => window.__holabossBrowserGlowPreviewEnabled === true,
    };

    return () => {
      window.removeEventListener(
        BROWSER_GLOW_PREVIEW_EVENT,
        handlePreviewChange as EventListener,
      );
    };
  }, []);

  return enabled;
}
