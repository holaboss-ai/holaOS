import { Search } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";

export function Center() {
  return (
    <main className="flex min-w-[480px] flex-1 flex-col overflow-hidden">
      <NewTabLanding />
    </main>
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
