import { BetaTag } from "@/components/ui/beta-tag";
import { Button } from "@/components/ui/button";
import { Loader2 } from "@/components/ui/icons";
import {
  type AppCatalogEntry,
  appKind,
  appTierLabel,
  categoryLabel,
} from "@/lib/holaAppMarketplace";
import { HolaAppIcon } from "./HolaAppIcon";

// The catalog description drives the card body. Until every app ships a rich
// blurb, fall back to a synthetic line so a card never renders description-less —
// tier-aware, since a connection is connected (not installed).
function cardDescription(entry: AppCatalogEntry): string {
  const authored = entry.description?.trim();
  if (authored) {
    return authored;
  }
  if (appKind(entry) === "connection") {
    return `Connect ${entry.title} — your agent uses it right in chat.`;
  }
  return `${entry.title} — install it and your agent can help you use it.`;
}

/** A marketplace card — icon tile, title + category · tier, description, and the
 * add control. Whole card opens the detail view; the button connects/installs. */
export function HolaAppCard({
  entry,
  busy,
  onOpen,
  onToggle,
}: {
  entry: AppCatalogEntry;
  busy: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const comingSoon = !entry.installed && entry.status === "coming_soon";
  // Connection-tier Apps connect rather than install; the primary control and the
  // status pill say "Connect" / "Connected" to match.
  const isConnection = appKind(entry) === "connection";
  return (
    <div
      className="group flex cursor-pointer flex-col rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-foreground/20 hover:bg-accent/40"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="flex items-start gap-3">
        <div className="grid size-11 shrink-0 place-items-center rounded-xl border border-border bg-background">
          <HolaAppIcon
            holaAppId={entry.holaAppId}
            iconUrl={entry.iconUrl}
            sizeClass="size-6"
            title={entry.title}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="min-w-0 truncate font-medium text-foreground text-sm">
              {entry.title}
            </h3>
            {entry.badge ? <BetaTag label={entry.badge} /> : null}
          </div>
          <div className="mt-0.5 truncate text-muted-foreground text-xs">
            {[categoryLabel(entry.category), appTierLabel(entry)]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        {/* Action, matching the Customize cards: an outline button to add, and a
            muted label once installed (manage/uninstall lives in the detail). */}
        {comingSoon ? (
          <span className="shrink-0 whitespace-nowrap pt-1 text-muted-foreground text-xs">
            Coming soon
          </span>
        ) : entry.installed ? (
          <span className="shrink-0 whitespace-nowrap pt-1 text-muted-foreground text-xs">
            {isConnection ? "Connected" : "Installed"}
          </span>
        ) : entry.connectionBound && !isConnection ? (
          // Connected in chat but not in the sidebar — keep an easy upgrade path.
          <div className="flex shrink-0 items-center gap-2 pt-0.5">
            <span className="whitespace-nowrap text-emerald-600 text-xs dark:text-emerald-400">
              Connected
            </span>
            <Button
              className="h-7"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                onToggle();
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                "Add to sidebar"
              )}
            </Button>
          </div>
        ) : (
          <Button
            className="h-7 shrink-0"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : isConnection ? (
              "Connect"
            ) : (
              "Install"
            )}
          </Button>
        )}
      </div>

      <p className="mt-3 line-clamp-2 text-muted-foreground text-xs leading-relaxed">
        {cardDescription(entry)}
      </p>
    </div>
  );
}
