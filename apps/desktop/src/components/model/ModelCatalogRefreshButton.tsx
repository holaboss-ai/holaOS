import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw } from "@/components/ui/icons";
import { useRefreshModelCatalog } from "@/lib/useRefreshModelCatalog";
import { cn } from "@/lib/utils";

/**
 * Shared "resync the model catalogue" affordance rendered inside every model
 * selector (composer, automations, channels). Clicking it re-pulls the runtime
 * catalogue; the fresh config broadcasts to the whole app, so every open picker
 * updates at once. Icon-only by default — pass `className` to fit the host.
 */
export function ModelCatalogRefreshButton({
  className,
}: {
  className?: string;
}) {
  const { refreshing, refresh } = useRefreshModelCatalog();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label="Resync models"
      title="Resync models"
      disabled={refreshing}
      // Stop the click from bubbling into a parent popover/select surface so a
      // resync never doubles as a selection or dismissal.
      onClick={(event) => {
        event.stopPropagation();
        void refresh();
      }}
      className={cn(
        "size-6 shrink-0 justify-center !p-0 text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      {refreshing ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <RefreshCw className="size-3.5" />
      )}
    </Button>
  );
}
