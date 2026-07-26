import { useEffect, useState } from "react";

export type NameCheckState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; slug: string; reason: "checked" | "fallback" }
  | { status: "taken"; slug: string; conflict: "yours" | "other"; existingTemplateId?: string | null }
  | { status: "invalid"; slug: string };

/**
 * Debounced live name-availability check. Calls back through the IPC bridge
 * which itself degrades gracefully if the backend endpoint isn't ready yet
 * (returns reason: "fallback").
 */
export function useNameCheck(name: string, debounceMs = 400): NameCheckState {
  const [state, setState] = useState<NameCheckState>({ status: "idle" });

  useEffect(() => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "checking" });
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const result = await window.electronAPI.workspace.checkTemplateName(trimmed);
        if (cancelled) {
          return;
        }
        if (result.reason === "invalid") {
          setState({ status: "invalid", slug: result.slug });
          return;
        }
        if (result.available) {
          setState({
            status: "available",
            slug: result.slug,
            reason: result.reason === "fallback" ? "fallback" : "checked",
          });
          return;
        }
        setState({
          status: "taken",
          slug: result.slug,
          conflict: result.conflict ?? "other",
          existingTemplateId: result.existingTemplateId,
        });
      } catch {
        if (!cancelled) {
          // Treat unknown failures as available so the user is never blocked.
          setState({ status: "available", slug: trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "_"), reason: "fallback" });
        }
      }
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [name, debounceMs]);

  return state;
}
