import { useEffect, useState } from "react";

type Listener = (isDark: boolean) => void;

let sharedObserver: MutationObserver | null = null;
let sharedIsDark = false;
const listeners = new Set<Listener>();

function readIsDarkAttr(): boolean {
  if (typeof document === "undefined") return false;
  const root = document.documentElement;
  return root.classList.contains("dark") || root.dataset.theme === "dark";
}

function ensureObserver() {
  if (sharedObserver !== null || typeof document === "undefined") {
    return;
  }
  sharedIsDark = readIsDarkAttr();
  sharedObserver = new MutationObserver(() => {
    const next = readIsDarkAttr();
    if (next === sharedIsDark) return;
    sharedIsDark = next;
    for (const listener of listeners) listener(next);
  });
  sharedObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme"],
  });
}

function subscribe(listener: Listener): () => void {
  ensureObserver();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && sharedObserver) {
      sharedObserver.disconnect();
      sharedObserver = null;
    }
  };
}

export function useIsDarkTheme(): boolean {
  const [isDark, setIsDark] = useState<boolean>(() => {
    ensureObserver();
    return sharedIsDark;
  });
  useEffect(() => subscribe(setIsDark), []);
  return isDark;
}
