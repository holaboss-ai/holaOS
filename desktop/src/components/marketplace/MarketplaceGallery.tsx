import { useMemo, useState } from "react";
import { LayoutGrid, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { KitCard } from "./KitCard";
import { FALLBACK_TEMPLATES } from "./fallbackTemplates";

interface MarketplaceGalleryProps {
  mode: "browse" | "pick";
  templates: TemplateMetadataPayload[];
  isLoading: boolean;
  authenticated: boolean;
  error?: string;
  onSelectKit: (template: TemplateMetadataPayload) => void;
  onRetry?: () => void;
  onSignIn?: () => void;
  onStartFromScratch?: () => void;
  onUseLocalTemplate?: () => void;
}

export function MarketplaceGallery({
  mode,
  templates,
  isLoading,
  authenticated,
  error,
  onSelectKit,
  onRetry,
  onStartFromScratch,
  onUseLocalTemplate,
}: MarketplaceGalleryProps) {
  const [query, setQuery] = useState("");

  const effectiveTemplates =
    templates.length > 0 ? templates : FALLBACK_TEMPLATES;

  const visibleTemplates = useMemo(() => {
    let available = effectiveTemplates.filter(
      (t: TemplateMetadataPayload) => !t.is_hidden,
    );
    const trimmed = query.trim().toLowerCase();
    if (trimmed) {
      available = available.filter((t: TemplateMetadataPayload) =>
        [t.name, t.description ?? "", ...t.tags, t.category].some((v) =>
          v.toLowerCase().includes(trimmed),
        ),
      );
    }
    return [...available].sort(
      (a: TemplateMetadataPayload, b: TemplateMetadataPayload) =>
        Number(a.is_coming_soon) - Number(b.is_coming_soon),
    );
  }, [effectiveTemplates, query]);

  const showLoading = authenticated && isLoading;
  const showError = authenticated && error;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {mode === "pick"
            ? "Pick a template to get started."
            : "Browse workspace templates."}
        </p>
        <div className="relative w-56 shrink-0">
          <Search
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="h-7 w-full rounded-md border border-border bg-background pl-7 pr-3 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-auto">
        {showLoading ? (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="animate-pulse rounded-lg border border-border p-4"
              >
                <div className="flex items-start gap-3">
                  <div className="size-7 rounded-md bg-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="h-3.5 w-20 rounded bg-muted" />
                    <div className="mt-2 h-3 w-full rounded bg-muted" />
                    <div className="mt-1 h-3 w-2/3 rounded bg-muted" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : showError ? (
          <div className="mt-8 text-center">
            <p className="text-sm text-foreground">Could not load templates</p>
            <p className="mt-1 text-xs text-muted-foreground">{error}</p>
            {onRetry ? (
              <Button
                variant="outline"
                size="sm"
                onClick={onRetry}
                className="mt-3"
              >
                Try again
              </Button>
            ) : null}
          </div>
        ) : visibleTemplates.length === 0 ? (
          <EmptyState
            icon={query.trim() ? Search : LayoutGrid}
            size="md"
            title={
              query.trim()
                ? "No templates match your search."
                : "No templates available yet."
            }
            className="mt-8"
          />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {visibleTemplates.map((t: TemplateMetadataPayload) => (
              <KitCard key={t.name} template={t} onClick={onSelectKit} />
            ))}
          </div>
        )}
      </div>

      {mode === "pick" && (onStartFromScratch || onUseLocalTemplate) ? (
        <div className="mt-4 flex items-center justify-center gap-3 border-t border-border pt-3">
          {onStartFromScratch ? (
            <Button
              variant="link"
              size="sm"
              onClick={onStartFromScratch}
              className="text-muted-foreground"
            >
              Start from scratch
            </Button>
          ) : null}
          {onStartFromScratch && onUseLocalTemplate ? (
            <span className="text-muted-foreground">|</span>
          ) : null}
          {onUseLocalTemplate ? (
            <Button
              variant="link"
              size="sm"
              onClick={onUseLocalTemplate}
              className="text-muted-foreground"
            >
              Use a local template
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
