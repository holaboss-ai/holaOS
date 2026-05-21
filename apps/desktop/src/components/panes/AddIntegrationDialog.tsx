import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Loader2, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

export interface AddIntegrationDialogIntegration {
  slug: string;
  providerId: string;
  name: string;
  description: string;
  logo: string | null;
  categories: string[];
  supportsManaged: boolean;
  tier?: "hero" | "supported";
}

interface AddIntegrationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  integrations: AddIntegrationDialogIntegration[];
  connectedProviderIds: Set<string>;
  connectingProviderId: string | null;
  canConnect: boolean;
  connectDisabledReason: string;
  onConnect: (integration: AddIntegrationDialogIntegration) => void;
}

const SUGGESTED_LIMIT = 6;

export function AddIntegrationDialog({
  open,
  onOpenChange,
  integrations,
  connectedProviderIds,
  connectingProviderId,
  canConnect,
  connectDisabledReason,
  onConnect,
}: AddIntegrationDialogProps) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const available = useMemo(
    () =>
      integrations.filter((i) => !connectedProviderIds.has(i.providerId)),
    [integrations, connectedProviderIds],
  );

  const suggested = useMemo(
    () =>
      available.filter((i) => i.tier === "hero").slice(0, SUGGESTED_LIMIT),
    [available],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return available;
    return available.filter((i) =>
      [i.name, i.providerId, i.description].some((v) =>
        v.toLowerCase().includes(q),
      ),
    );
  }, [available, query]);

  const grouped = useMemo(() => {
    const groups: Record<string, AddIntegrationDialogIntegration[]> = {};
    for (const integration of filtered) {
      const key = integration.categories[0] || "other";
      if (!groups[key]) groups[key] = [];
      groups[key]!.push(integration);
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-40 bg-foreground/30 opacity-0 transition-opacity duration-snappy ease-emphasized data-open:opacity-100" />
        <DialogPrimitive.Popup className="group fixed inset-0 z-40 grid place-items-center opacity-0 outline-none transition-opacity duration-base ease-emphasized data-open:opacity-100">
          <div
            className="flex h-[min(640px,calc(100vh-96px))] w-[min(560px,calc(100vw-48px))] scale-[0.97] flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl ring-1 ring-foreground/5 transition-transform duration-stride ease-emphasized group-data-[open]:scale-100"
            style={{ willChange: "transform" }}
          >
            <header className="shrink-0 border-border border-b p-3">
              <InputGroup
                className={cn(
                  "border-0",
                  // Strip the InputGroup container's focus-within ring too;
                  // the dialog header already has a border-b divider, no
                  // need for a second indicator inside it.
                  "has-[[data-slot=input-group-control]:focus-visible]:border-transparent has-[[data-slot=input-group-control]:focus-visible]:ring-0",
                )}
              >
                <InputGroupAddon align="inline-start">
                  <Search />
                </InputGroupAddon>
                <InputGroupInput
                  autoFocus
                  data-no-focus-ring
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search integrations…"
                  value={query}
                />
                <InputGroupAddon align="inline-end">
                  <DialogPrimitive.Close
                    render={
                      <InputGroupButton
                        aria-label="Close"
                        size="icon-xs"
                        type="button"
                        variant="ghost"
                      >
                        <X />
                      </InputGroupButton>
                    }
                  />
                </InputGroupAddon>
              </InputGroup>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {!query && suggested.length > 0 ? (
                <section className="px-4 pt-4 pb-1">
                  <h3 className="px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Suggested
                  </h3>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    {suggested.map((integration) => (
                      <SuggestedTile
                        canConnect={canConnect && integration.supportsManaged}
                        connecting={connectingProviderId === integration.providerId}
                        integration={integration}
                        key={integration.providerId}
                        onConnect={() => onConnect(integration)}
                        title={
                          canConnect
                            ? integration.supportsManaged
                              ? `Connect ${integration.name}`
                              : "Not supported by managed sign-in."
                            : connectDisabledReason
                        }
                      />
                    ))}
                  </div>
                </section>
              ) : null}

              {grouped.length === 0 ? (
                <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                  Nothing matches "{query}".
                </div>
              ) : (
                <div className="px-4 pt-4 pb-4">
                  {grouped.map(([category, items]) => (
                    <section className="mb-4 last:mb-0" key={category}>
                      <h3 className="px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        {category}
                      </h3>
                      <ul className="mt-1.5 divide-y divide-border/60">
                        {items.map((integration) => (
                          <li key={integration.providerId}>
                            <ListRow
                              canConnect={canConnect && integration.supportsManaged}
                              connecting={
                                connectingProviderId === integration.providerId
                              }
                              integration={integration}
                              onConnect={() => onConnect(integration)}
                              title={
                                canConnect
                                  ? integration.supportsManaged
                                    ? `Connect ${integration.name}`
                                    : "Not supported by managed sign-in."
                                  : connectDisabledReason
                              }
                            />
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
            </div>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function SuggestedTile({
  integration,
  connecting,
  canConnect,
  onConnect,
  title,
}: {
  integration: AddIntegrationDialogIntegration;
  connecting: boolean;
  canConnect: boolean;
  onConnect: () => void;
  title: string;
}) {
  return (
    <button
      className={cn(
        "flex flex-col items-center gap-2 rounded-lg border border-border bg-card px-3 py-3 text-center transition-colors",
        canConnect && !connecting
          ? "hover:bg-accent"
          : "cursor-not-allowed opacity-60",
      )}
      disabled={!canConnect || connecting}
      onClick={onConnect}
      title={title}
      type="button"
    >
      <ToolkitLogo logo={integration.logo} name={integration.name} size={32} />
      <span className="truncate text-xs font-medium text-foreground">
        {integration.name}
      </span>
      {connecting ? (
        <Loader2 className="size-3 animate-spin text-muted-foreground" />
      ) : null}
    </button>
  );
}

function ListRow({
  integration,
  connecting,
  canConnect,
  onConnect,
  title,
}: {
  integration: AddIntegrationDialogIntegration;
  connecting: boolean;
  canConnect: boolean;
  onConnect: () => void;
  title: string;
}) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors",
        canConnect && !connecting
          ? "hover:bg-accent"
          : "cursor-not-allowed opacity-60",
      )}
      disabled={!canConnect || connecting}
      onClick={onConnect}
      title={title}
      type="button"
    >
      <ToolkitLogo logo={integration.logo} name={integration.name} size={28} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-foreground">{integration.name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {integration.description}
        </div>
      </div>
      {connecting ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : null}
    </button>
  );
}

function ToolkitLogo({
  logo,
  name,
  size,
}: {
  logo: string | null;
  name: string;
  size: number;
}) {
  const [failed, setFailed] = useState(false);
  const sizeClass = size >= 32 ? "size-8" : "size-7";
  if (logo && !failed) {
    return (
      <img
        alt={`${name} logo`}
        className={cn(
          "shrink-0 rounded-md border border-border/60 bg-background object-contain p-1",
          sizeClass,
        )}
        onError={() => setFailed(true)}
        referrerPolicy="no-referrer"
        src={logo}
      />
    );
  }
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted text-xs font-medium text-muted-foreground",
        sizeClass,
      )}
    >
      {(name || "?").charAt(0).toUpperCase()}
    </div>
  );
}
