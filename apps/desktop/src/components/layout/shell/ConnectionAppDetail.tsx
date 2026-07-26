import { ArrowLeft } from "@/components/ui/icons";
import type { AppCatalogEntry } from "@/lib/holaAppMarketplace";
import { ConnectionAccounts } from "./ConnectionAccounts";
import { HolaAppIcon } from "./HolaAppIcon";

// The detail surface for a connection-tier App (former "integration"). It is
// headless — there's no sidebar app or web preview to show — so this renders what
// actually matters: whether the workspace is connected, which account(s) power it,
// and per-account actions. Account management lives in the shared
// ConnectionAccounts block. Settings → Integrations is retired; this is the single
// place to manage a connection.

export function ConnectionAppDetail({
  entry,
  workspaceId,
  onBack,
  onChanged,
}: {
  entry: AppCatalogEntry;
  /** Active workspace — needed to read/set the per-workspace default account. */
  workspaceId: string | null;
  onBack: () => void;
  /** Fired after a change so the parent can refresh the catalog (the store card's
   * derived Installed/Connected state). */
  onChanged?: () => void | Promise<void>;
}) {
  const slug = entry.holaAppId.trim().toLowerCase();

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-6 py-6">
        <button
          className="-mx-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground text-sm transition-colors hover:bg-foreground/6 hover:text-foreground"
          onClick={onBack}
          type="button"
        >
          <ArrowLeft className="size-4" /> All apps
        </button>

        <div className="mt-5 flex items-start gap-4">
          <HolaAppIcon
            hero
            holaAppId={entry.holaAppId}
            iconUrl={entry.iconUrl}
            title={entry.title}
          />
          <div className="min-w-0 flex-1">
            <h2 className="min-w-0 truncate font-semibold text-foreground text-xl">
              {entry.title}
            </h2>
            <p className="mt-1 text-muted-foreground text-sm leading-relaxed">
              A connection your agent uses directly in chat — no app to open.
            </p>
          </div>
        </div>

        <ConnectionAccounts
          appTitle={entry.title}
          onChanged={onChanged}
          provider={slug}
          workspaceId={workspaceId}
        />

        <section className="mt-8">
          <h3 className="font-medium text-foreground text-sm">How it works</h3>
          <p className="mt-2 text-muted-foreground text-sm leading-relaxed">
            Authorize once. {entry.title}'s tools are then available to your agent
            in every chat in this workspace — ask in plain language and it acts on
            your behalf. There's nothing to open or manage here.
          </p>
        </section>
      </div>
    </div>
  );
}
