import { createElement, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

function browserCaptureErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return "Browser capture failed.";
}

export function useBrowserCaptureActions() {
  const [actionStatus, setActionStatus] = useState("");
  const [busyAction, setBusyAction] = useState<"clipboard" | null>(null);
  const clearStatusTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (clearStatusTimeoutRef.current !== null) {
        window.clearTimeout(clearStatusTimeoutRef.current);
      }
    };
  }, []);

  const showActionStatus = (message: string) => {
    if (clearStatusTimeoutRef.current !== null) {
      window.clearTimeout(clearStatusTimeoutRef.current);
    }
    setActionStatus(message);
    clearStatusTimeoutRef.current = window.setTimeout(() => {
      setActionStatus("");
      clearStatusTimeoutRef.current = null;
    }, 1800);
  };

  const captureScreenshotToClipboard = async () => {
    if (busyAction) {
      return;
    }
    setBusyAction("clipboard");
    try {
      const result = await window.electronAPI.browser.captureScreenshotToClipboard();
      showActionStatus(
        result.copied
          ? "Copied screenshot to clipboard."
          : "Screenshot capture cancelled.",
      );
    } catch (error) {
      showActionStatus(browserCaptureErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  };

  return {
    actionStatus,
    busyAction,
    captureScreenshotToClipboard,
    screenshotCapturePending: busyAction === "clipboard",
  };
}

export function BrowserCaptureStatusToast({ message }: { message: string }) {
  if (!message || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    createElement(
      "div",
      {
        "aria-live": "polite",
        className:
          "pointer-events-none fixed left-1/2 top-4 z-[100] -translate-x-1/2 rounded-full border border-border bg-popover/95 px-3.5 py-2 text-xs font-medium text-popover-foreground shadow-xl ring-1 ring-border/60 backdrop-blur-xl",
      },
      message,
    ),
    document.body,
  );
}
