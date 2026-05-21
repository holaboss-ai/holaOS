import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Search } from "lucide-react";
import { useCallback, useState } from "react";
import { BrowserPane } from "@/components/panes/BrowserPane";
import { useWorkspaceBrowser } from "@/components/panes/useWorkspaceBrowser";
import { Input } from "@/components/ui/input";
import { FilePreviewPane } from "./FilePreviewPane";
import {
  activeInternalTabIdAtom,
  internalTabsAtom,
} from "./state/internalTabs";
import { browserViewSuspendedAtom } from "./state/ui";

export function Center() {
  const { browserState } = useWorkspaceBrowser("user");
  const hasActiveTab = browserState.tabs.length > 0;
  const suspendNativeView = useAtomValue(browserViewSuspendedAtom);
  const [activeInternalTabId, setActiveInternalTabId] = useAtom(
    activeInternalTabIdAtom,
  );
  const [internalTabs, setInternalTabs] = useAtom(internalTabsAtom);
  const activeInternal = activeInternalTabId
    ? internalTabs.find((t) => t.id === activeInternalTabId) ?? null
    : null;

  const closeActiveInternalTab = useCallback(() => {
    if (!activeInternalTabId) return;
    setInternalTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === activeInternalTabId);
      const next = prev.filter((t) => t.id !== activeInternalTabId);
      const fallback = next[idx - 1] ?? next[0] ?? null;
      setActiveInternalTabId(fallback?.id ?? null);
      return next;
    });
  }, [activeInternalTabId, setActiveInternalTabId, setInternalTabs]);

  return (
    <main className="flex min-w-[480px] flex-1 flex-col overflow-hidden">
      {activeInternal ? (
        activeInternal.kind === "image" ? (
          <EphemeralImagePane
            dataUrl={activeInternal.dataUrl}
            name={activeInternal.label}
          />
        ) : (
          <FilePreviewPane
            filePath={activeInternal.filePath}
            onClose={closeActiveInternalTab}
          />
        )
      ) : hasActiveTab ? (
        <BrowserPane
          variant="embedded"
          suspendNativeView={suspendNativeView}
        />
      ) : (
        <NewTabLanding />
      )}
    </main>
  );
}

function EphemeralImagePane({
  dataUrl,
  name,
}: {
  dataUrl: string;
  name: string;
}) {
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-muted p-6">
      <img
        src={dataUrl}
        alt={name}
        className="max-h-full max-w-full rounded-lg object-contain shadow-sm"
      />
    </div>
  );
}

function looksLikeUrl(input: string): boolean {
  if (!input) return false;
  if (input.startsWith("http://") || input.startsWith("https://")) return true;
  if (input.includes(" ")) return false;
  return /^[^\s]+\.[^\s]+$/.test(input);
}

function normalizeUrl(input: string): string {
  if (input.startsWith("http://") || input.startsWith("https://")) {
    return input;
  }
  if (looksLikeUrl(input)) {
    return `https://${input}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

function NewTabLanding() {
  const [query, setQuery] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    await window.electronAPI.browser.newTab(normalizeUrl(trimmed));
    setQuery("");
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 pt-24">
      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3"
      >
        <Search className="size-4 text-foreground/40" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search or enter URL"
          aria-label="Search or enter URL"
          autoFocus
          className="h-10 flex-1 border-0 bg-transparent text-sm focus-visible:ring-0"
        />
        <span className="text-xs text-foreground/40">↵</span>
      </form>
    </div>
  );
}
