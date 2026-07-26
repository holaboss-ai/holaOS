import { BetaTag } from "@/components/ui/beta-tag";
import { Button } from "@/components/ui/button";
import { ExternalLink, Loader2, Server } from "@/components/ui/icons";
import type { McpCatalogEntry } from "@/lib/mcpMarketplace";
import { cn } from "@/lib/utils";
import { HolaAppIcon } from "./HolaAppIcon";

function cardDescription(entry: McpCatalogEntry): string {
  return (
    entry.description?.trim() ||
    `${entry.name} — install it to give your agent its tools.`
  );
}

/** A marketplace card for an installable MCP server — icon tile, name + category,
 * description, capability chips, and the install control. Distinct from HolaAppCard
 * because an MCP entry carries no HolaApp surface/detail view; installing prompts for the
 * server's required keys (McpInstallDialog) then attaches it to the agent. */
export function McpMarketplaceCard({
  entry,
  busy,
  onToggle,
}: {
  entry: McpCatalogEntry;
  busy: boolean;
  onToggle: () => void;
}) {
  const comingSoon = !entry.installed && entry.comingSoon;
  return (
    <div className="group/card flex flex-col rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-foreground/20 hover:bg-accent/40">
      <div className="flex items-start gap-3">
        <div className="grid size-11 shrink-0 place-items-center rounded-xl border border-border bg-background">
          {entry.iconUrl ? (
            <HolaAppIcon
              iconUrl={entry.iconUrl}
              sizeClass="size-6"
              title={entry.name}
            />
          ) : (
            <Server className="size-6 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="min-w-0 truncate font-medium text-foreground text-sm">
              {entry.name}
            </h3>
            {entry.badge ? <BetaTag label={entry.badge} /> : null}
            {entry.verified ? null : (
              <span className="inline-flex shrink-0 items-center rounded-full bg-amber-500/10 px-1.5 py-0.5 font-medium text-[10px] text-amber-600 dark:text-amber-400">
                Unverified
              </span>
            )}
          </div>
          {entry.category ? (
            <div className="mt-0.5 truncate text-muted-foreground text-xs">
              {entry.category}
            </div>
          ) : null}
        </div>
        {/* Installed stays low-key — a muted "Installed" label that only reveals
            "Uninstall" on card hover, so removal is reachable without a loud
            always-on button. */}
        {comingSoon ? (
          <span className="shrink-0 whitespace-nowrap pt-1 text-muted-foreground text-xs">
            Coming soon
          </span>
        ) : entry.installed ? (
          <Button
            aria-label={`Uninstall ${entry.name}`}
            className="h-7 shrink-0 whitespace-nowrap px-2 text-muted-foreground text-xs hover:text-destructive"
            disabled={busy}
            onClick={onToggle}
            size="sm"
            type="button"
            variant="ghost"
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <>
                <span className="group-hover/card:hidden">Installed</span>
                <span className="hidden group-hover/card:inline">Uninstall</span>
              </>
            )}
          </Button>
        ) : (
          <Button
            className="h-7 shrink-0"
            disabled={busy}
            onClick={onToggle}
            size="sm"
            type="button"
            variant="outline"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Install"}
          </Button>
        )}
      </div>

      <p className="mt-3 line-clamp-2 text-muted-foreground text-xs leading-relaxed">
        {cardDescription(entry)}
      </p>

      {entry.surfaceUrl ? (
        <button
          className="mt-3 inline-flex w-fit items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={() =>
            entry.surfaceUrl
              ? void window.electronAPI.profiles.launch(
                  "bprofile_default",
                  entry.surfaceUrl,
                )
              : undefined
          }
          type="button"
        >
          <ExternalLink className="size-3" />
          Open {entry.name}
        </button>
      ) : null}
    </div>
  );
}
