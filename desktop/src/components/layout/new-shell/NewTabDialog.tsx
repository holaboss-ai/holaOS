import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useAtom } from "jotai";
import { CornerDownLeft, Globe, Search } from "lucide-react";
import { useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { newTabOpenAtom } from "./state/ui";

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

export function NewTabDialog() {
  const [open, setOpen] = useAtom(newTabOpenAtom);
  const [query, setQuery] = useState("");
  const trimmed = query.trim();
  const isUrlLike = looksLikeUrl(trimmed);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  const handleOpenInput = async () => {
    if (!trimmed) return;
    await window.electronAPI.browser.newTab(normalizeUrl(trimmed));
    handleOpenChange(false);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          className="fixed inset-0 z-[90] bg-foreground/20 backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
          style={{
            animationDuration: "180ms",
            animationTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        />
        <DialogPrimitive.Popup
          className="fixed top-[18%] left-1/2 z-[100] w-[560px] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover/95 shadow-2xl outline-none backdrop-blur-2xl data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          style={{
            animationDuration: "220ms",
            animationTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        >
          <Command className="bg-transparent">
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search or enter URL..."
            />
            <CommandList className="max-h-[420px] px-1.5 pt-1 pb-2">
              {trimmed ? null : (
                <CommandEmpty>
                  Type a URL or search query to open a new tab.
                </CommandEmpty>
              )}
              {trimmed ? (
                <CommandGroup heading={isUrlLike ? "Open URL" : "Search"}>
                  <CommandItem
                    value={trimmed}
                    onSelect={() => void handleOpenInput()}
                    className="group/cmd-item gap-2.5 py-1.5"
                  >
                    <span
                      aria-hidden
                      className="grid size-5 shrink-0 place-items-center rounded-[5px] bg-foreground/[0.06] text-foreground/55 ring-1 ring-inset ring-foreground/5 [&_svg]:size-3"
                    >
                      {isUrlLike ? <Globe /> : <Search />}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span className="truncate text-sm">
                        {isUrlLike ? trimmed : `Search "${trimmed}"`}
                      </span>
                      <span className="truncate text-xs text-foreground/40">
                        {isUrlLike
                          ? "Open as browser tab"
                          : "google.com/search"}
                      </span>
                    </span>
                    <CornerDownLeft className="size-3 text-foreground/40 opacity-0 transition-opacity duration-200 ease-out group-data-[selected=true]/cmd-item:opacity-100" />
                  </CommandItem>
                </CommandGroup>
              ) : null}
            </CommandList>
            <div className="flex items-center justify-between border-t border-border bg-foreground/[0.02] px-3 py-2 text-xs text-foreground/40">
              <span className="flex items-center gap-1.5">
                <span className="inline-flex gap-0.5">
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd>
                </span>
                navigate
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>↵</Kbd>
                open
                <span className="mx-1 text-foreground/20">·</span>
                <Kbd>esc</Kbd>
                close
              </span>
            </div>
          </Command>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
