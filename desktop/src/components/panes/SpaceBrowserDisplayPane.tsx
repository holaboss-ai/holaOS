import {
  Camera,
  ChevronLeft,
  ChevronRight,
  Globe,
  Loader2,
  Maximize2,
  Minimize2,
  RefreshCcw,
  Star,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { browserSurfaceStatusSummary } from "@/components/panes/browserSessionUi";
import { BrowserProfileImportButton } from "@/components/panes/BrowserProfileImportButton";
import {
  BrowserCaptureStatusToast,
  useBrowserCaptureActions,
} from "@/components/panes/useBrowserCaptureActions";
import { useBrowserGlowPreview } from "@/components/panes/useBrowserGlowPreview";
import { useWorkspaceBrowser } from "@/components/panes/useWorkspaceBrowser";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";

const HOME_URL = "https://www.google.com";
const EXPLICIT_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;
const LOCALHOST_PATTERN = /^localhost(?::\d+)?(?:[/?#]|$)/i;
const IPV4_HOST_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[/?#]|$)/;
const IPV6_HOST_PATTERN = /^\[[0-9a-fA-F:]+\](?::\d+)?(?:[/?#]|$)/;

function normalizeUrl(rawInput: string) {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return HOME_URL;
  }

  if (EXPLICIT_SCHEME_PATTERN.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }
  if (
    LOCALHOST_PATTERN.test(trimmed) ||
    IPV4_HOST_PATTERN.test(trimmed) ||
    IPV6_HOST_PATTERN.test(trimmed)
  ) {
    return `http://${trimmed}`;
  }
  if (trimmed.includes(".")) {
    return `https://${trimmed}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

interface SpaceBrowserDisplayPaneProps {
  browserSpace: BrowserSpaceId;
  suspendNativeView?: boolean;
  layoutSyncKey?: string;
  embedded?: boolean;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

export function SpaceBrowserDisplayPane({
  browserSpace,
  suspendNativeView = false,
  layoutSyncKey = "",
  embedded = false,
  fullscreen = false,
  onToggleFullscreen,
}: SpaceBrowserDisplayPaneProps) {
  const [browserProfileImportDialogOpen, setBrowserProfileImportDialogOpen] =
    useState(false);
  const [inputValue, setInputValue] = useState("");
  const [addressFocused, setAddressFocused] = useState(false);
  const [highlightedSuggestionIndex, setHighlightedSuggestionIndex] =
    useState(-1);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const addressFieldRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const {
    activeTab,
    activeBookmark,
    historyEntries,
    isBookmarked,
    browserState,
    currentRuntimeState,
  } = useWorkspaceBrowser(browserSpace, {
    includeHistory: true,
    includeSessions: true,
  });
  const isActiveTabBusy = activeTab.loading || !activeTab.initialized;

  const sessionBrowserStatus = useMemo(
    () =>
      browserSurfaceStatusSummary({
        browserSpace,
        controlMode: browserState.controlMode,
        lifecycleState: browserState.lifecycleState,
        runtimeState: currentRuntimeState,
      }),
    [
      browserSpace,
      browserState.controlMode,
      browserState.lifecycleState,
      currentRuntimeState,
    ],
  );
  const glowPreviewEnabled = useBrowserGlowPreview();

  const showAgentActivityHighlight =
    sessionBrowserStatus?.tone === "active" || glowPreviewEnabled;
  const {
    actionStatus,
    captureScreenshotToClipboard,
    screenshotCapturePending,
  } = useBrowserCaptureActions();
  const effectiveSuspendNativeView =
    suspendNativeView || browserProfileImportDialogOpen;

  useEffect(() => {
    setInputValue(activeTab.url || "");
  }, [activeTab.id, activeTab.url]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    if (effectiveSuspendNativeView) {
      void window.electronAPI.browser.setBounds({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      });
      return;
    }

    let rafId = 0;

    const syncBounds = () => {
      const rect = viewport.getBoundingClientRect();
      void window.electronAPI.browser.setBounds({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };

    const queueSync = () => {
      window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(syncBounds);
    };

    queueSync();
    const observer = new ResizeObserver(queueSync);
    observer.observe(viewport);
    window.addEventListener("resize", queueSync);
    window.setTimeout(queueSync, 100);
    window.setTimeout(queueSync, 400);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", queueSync);
      window.cancelAnimationFrame(rafId);
    };
  }, [effectiveSuspendNativeView, layoutSyncKey]);

  useEffect(() => {
    return () => {
      void window.electronAPI.browser.setBounds({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      });
    };
  }, []);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void window.electronAPI.browser.navigate(normalizeUrl(inputValue));
  };

  const navigateTo = (rawInput: string) => {
    const nextUrl = normalizeUrl(rawInput);
    setInputValue(nextUrl);
    void window.electronAPI.browser.navigate(nextUrl);
  };

  const selectAddressInput = () => {
    addressInputRef.current?.focus();
    addressInputRef.current?.select();
  };

  const historySuggestions = useMemo(() => {
    if (!addressFocused) {
      return [];
    }

    const query = inputValue.trim().toLowerCase();
    const filtered = historyEntries.filter((entry) => {
      if (!query) {
        return true;
      }

      return (
        entry.url.toLowerCase().includes(query) ||
        entry.title.toLowerCase().includes(query)
      );
    });

    return filtered.filter((entry) => entry.url !== activeTab.url).slice(0, 6);
  }, [activeTab.url, addressFocused, historyEntries, inputValue]);

  useEffect(() => {
    if (!historySuggestions.length) {
      setHighlightedSuggestionIndex(-1);
      return;
    }

    setHighlightedSuggestionIndex((current) => {
      if (current < 0 || current >= historySuggestions.length) {
        return 0;
      }
      return current;
    });
  }, [historySuggestions]);

  const getAnchorBounds = (element: HTMLElement | null) => {
    if (!element) {
      return null;
    }

    const rect = element.getBoundingClientRect();
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    };
  };

  useEffect(() => {
    if (!addressFocused || historySuggestions.length === 0) {
      void window.electronAPI.browser.hideAddressSuggestions();
      return;
    }

    const bounds = getAnchorBounds(addressFieldRef.current);
    if (!bounds) {
      return;
    }

    const suggestions: AddressSuggestionPayload[] = historySuggestions.map(
      (entry) => ({
        id: entry.id,
        url: entry.url,
        title: entry.title,
        faviconUrl: entry.faviconUrl,
      }),
    );

    void window.electronAPI.browser.showAddressSuggestions(
      bounds,
      suggestions,
      highlightedSuggestionIndex,
    );
  }, [addressFocused, highlightedSuggestionIndex, historySuggestions]);

  useEffect(() => {
    return window.electronAPI.browser.onAddressSuggestionChosen((index) => {
      const entry = historySuggestions[index];
      if (!entry) {
        return;
      }

      setAddressFocused(false);
      setHighlightedSuggestionIndex(index);
      navigateTo(entry.url);
    });
  }, [historySuggestions]);

  const onAddressKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!historySuggestions.length) {
      if (event.key === "Escape") {
        setAddressFocused(false);
        void window.electronAPI.browser.hideAddressSuggestions();
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedSuggestionIndex(
        (current) => (current + 1) % historySuggestions.length,
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedSuggestionIndex((current) =>
        current <= 0 ? historySuggestions.length - 1 : current - 1,
      );
      return;
    }

    if (event.key === "Enter" && highlightedSuggestionIndex >= 0) {
      event.preventDefault();
      const entry = historySuggestions[highlightedSuggestionIndex];
      if (!entry) {
        return;
      }

      setAddressFocused(false);
      navigateTo(entry.url);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setAddressFocused(false);
      setHighlightedSuggestionIndex(-1);
      void window.electronAPI.browser.hideAddressSuggestions();
    }
  };

  const onToggleBookmark = () => {
    if (!activeTab.url) {
      return;
    }

    if (activeBookmark) {
      void window.electronAPI.browser.removeBookmark(activeBookmark.id);
      return;
    }

    void window.electronAPI.browser.addBookmark({
      url: activeTab.url,
      title: activeTab.title || activeTab.url,
    });
  };

  return (
    <section
      className={`relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden ${
        embedded ? "bg-transparent" : "rounded-xl border border-border bg-card"
      }`}
    >
      <div className="shrink-0 border-b border-border px-2 py-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Back"
            onClick={() => void window.electronAPI.browser.back()}
            disabled={!activeTab.canGoBack}
          >
            <ChevronLeft size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Forward"
            onClick={() => void window.electronAPI.browser.forward()}
            disabled={!activeTab.canGoForward}
          >
            <ChevronRight size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={activeTab.loading ? "Stop loading" : "Refresh"}
            onClick={() =>
              void (activeTab.loading
                ? window.electronAPI.browser.stopLoading()
                : window.electronAPI.browser.reload())
            }
            disabled={!activeTab.initialized && !activeTab.loading}
            title={activeTab.loading ? "Stop loading" : "Refresh"}
          >
            {activeTab.loading ? <X size={13} /> : <RefreshCcw size={13} />}
          </Button>

          <form onSubmit={onSubmit} className="min-w-0 flex-1">
            <div
              ref={addressFieldRef}
              className="flex h-7 min-w-0 items-center gap-2 rounded-md border border-border bg-muted px-2.5 transition-colors focus-within:border-muted-foreground"
              onClick={selectAddressInput}
            >
              {isActiveTabBusy ? (
                <Loader2
                  size={13}
                  className="shrink-0 animate-spin text-primary"
                />
              ) : (
                <Globe size={13} className="shrink-0 text-muted-foreground" />
              )}
              <input
                ref={addressInputRef}
                value={inputValue}
                onChange={(event) => setInputValue(event.target.value)}
                onFocus={(event) => {
                  event.currentTarget.select();
                  setAddressFocused(true);
                }}
                onClick={(event) => event.currentTarget.select()}
                onBlur={() =>
                  window.setTimeout(() => setAddressFocused(false), 120)
                }
                onKeyDown={onAddressKeyDown}
                className="embedded-input w-full min-w-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                placeholder="Enter URL or search"
              />
            </div>
          </form>

          <Button
            type="button"
            variant={isBookmarked ? "secondary" : "ghost"}
            size="icon-sm"
            onClick={onToggleBookmark}
            disabled={!activeTab.url}
            className={`shrink-0 rounded-md ${
              isBookmarked ? "text-primary" : ""
            }`}
            aria-label={isBookmarked ? "Remove bookmark" : "Add bookmark"}
          >
            <Star
              className="size-3.5"
              fill={isBookmarked ? "currentColor" : "none"}
            />
          </Button>
          <BrowserProfileImportButton
            buttonSize="icon-sm"
            buttonVariant="ghost"
            open={browserProfileImportDialogOpen}
            onOpenChange={setBrowserProfileImportDialogOpen}
            showLabel={false}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Copy browser screenshot"
            title="Copy browser screenshot"
            onClick={() => void captureScreenshotToClipboard()}
            disabled={!activeTab.initialized}
          >
            {screenshotCapturePending ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Camera size={13} />
            )}
          </Button>
          {onToggleFullscreen ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              title={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              onClick={onToggleFullscreen}
            >
              {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </Button>
          ) : null}
        </div>
        <BrowserCaptureStatusToast message={actionStatus} />
      </div>

      <div
        className={`min-h-0 flex-1 overflow-hidden ${fullscreen ? "p-0" : "p-3"}`}
      >
        <div
          ref={viewportRef}
          className={`relative h-full min-h-0 overflow-hidden bg-card transition-colors ${
            fullscreen ? "" : "rounded-xl border"
          } ${
            fullscreen
              ? ""
              : showAgentActivityHighlight
                ? "border-primary/40"
                : "border-border"
          }`}
        >

          {!activeTab.initialized ? (
            <div className="absolute inset-0 grid place-items-center bg-card p-6 text-center">
              <div className="flex flex-col items-center gap-3">
                <div className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
                  <Loader2 size={18} className="animate-spin" />
                </div>
                <div className="text-sm font-medium text-foreground">
                  Starting {browserSpace === "agent" ? "agent" : "user"} browser
                </div>
                <div className="max-w-[320px] text-xs leading-5 text-muted-foreground">
                  Opening the embedded{" "}
                  {browserSpace === "agent" ? "agent" : "user"} browser for this
                  workspace.
                </div>
              </div>
            </div>
          ) : null}

          {activeTab.error ? (
            <div className="absolute inset-x-4 bottom-4 flex items-start gap-2 rounded-lg border-l-2 border-warning bg-card px-3 py-2 text-xs leading-5 text-foreground shadow-sm">
              <StatusDot variant="warning" className="mt-0.5" />
              <span className="min-w-0 flex-1">{activeTab.error}</span>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
