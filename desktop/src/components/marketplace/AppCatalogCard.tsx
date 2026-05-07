import { useState } from "react";
import { Check, Download, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { AppIcon } from "@/components/marketplace/AppIcon";
import {
  accountAvatarFallbackChar,
  accountDisplayLabel,
  useEnrichedConnections,
} from "@/lib/integrationDisplay";
import { cn } from "@/lib/utils";

type AppCardState = "available" | "installing" | "installed";

interface AppCatalogCardProps {
  entry: AppCatalogEntryPayload;
  state: AppCardState;
  disabled: boolean;
  onInstall: () => void;
  /**
   * Display name override sourced from the Composio toolkit by
   * `entry.provider_id`. Used when the marketplace manifest's `name` is
   * just the slug (e.g. "gcalendar") and Composio knows the proper name
   * ("Google Calendar"). Falls back to `entry.name` when null.
   */
  displayName?: string | null;
  /** Logo URL from the Composio toolkit; takes precedence over `entry.icon`. */
  logoUrl?: string | null;
  /**
   * Active connections matching the app's expected provider. When the
   * caller has computed this list, the install footer renders an inline
   * account picker so the user binds at install time instead of
   * post-install in AppSurfacePane.
   *
   * - empty / undefined → no picker shown (legacy "connect first" flow
   *   still applies in AppsGallery if the app needs an integration).
   * - exactly one entry → no picker shown either; the caller silently
   *   binds to that account when Install is clicked.
   * - two or more → inline Select renders above the Install button.
   */
  availableAccounts?: IntegrationConnectionPayload[];
  selectedConnectionId?: string | null;
  onSelectAccount?: (connectionId: string) => void;
}

export function AppCatalogCard({
  entry,
  state,
  disabled,
  onInstall,
  displayName,
  logoUrl,
  availableAccounts,
  selectedConnectionId,
  onSelectAccount,
}: AppCatalogCardProps) {
  const label =
    displayName?.trim() || entry.name?.trim() || entry.app_id;
  const description = entry.description ?? "";
  const showAccountPicker =
    state === "available" &&
    Array.isArray(availableAccounts) &&
    availableAccounts.length >= 2 &&
    typeof onSelectAccount === "function";
  const accountMetadata = useEnrichedConnections(availableAccounts ?? []);
  const [avatarFailures, setAvatarFailures] = useState<Set<string>>(
    () => new Set(),
  );
  const activeConnectionId =
    selectedConnectionId ?? availableAccounts?.[0]?.connection_id ?? "";
  const activeIndex =
    availableAccounts?.findIndex(
      (c) => c.connection_id === activeConnectionId,
    ) ?? -1;
  const activeConn = activeIndex >= 0 ? availableAccounts?.[activeIndex] : null;
  const activeMeta = activeConn
    ? accountMetadata.get(activeConn.connection_id)
    : undefined;
  const activeLabel = activeConn
    ? accountDisplayLabel(activeConn, activeMeta, activeIndex)
    : "Choose account";
  const activeAvatar = activeMeta?.avatarUrl?.trim();
  const activeAvatarBroken = activeConn
    ? avatarFailures.has(activeConn.connection_id)
    : false;
  const showActiveAvatar =
    Boolean(activeAvatar) && !activeAvatarBroken && Boolean(activeConn);
  const activeFallback = accountAvatarFallbackChar(activeLabel);

  function markAvatarFailed(connectionId: string) {
    setAvatarFailures((prev) => {
      if (prev.has(connectionId)) return prev;
      const next = new Set(prev);
      next.add(connectionId);
      return next;
    });
  }
  return (
    <div
      data-slot="app-catalog-row"
      className={cn(
        "group flex items-center gap-3 px-3 py-2.5 transition-colors",
        "hover:bg-fg-2",
      )}
    >
      <AppIcon
        iconUrl={logoUrl ?? entry.icon}
        appId={entry.app_id}
        providerId={entry.provider_id}
        label={label}
        size="card"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {label}
          </span>
          {entry.version ? (
            <Badge
              variant="secondary"
              className="shrink-0 px-1.5 py-0 text-[10px] font-normal"
            >
              {entry.version}
            </Badge>
          ) : null}
        </div>
        {description ? (
          <p className="truncate text-xs text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {showAccountPicker ? (
          <Select
            value={activeConnectionId}
            onValueChange={(next) => {
              if (next) onSelectAccount?.(next);
            }}
          >
            <SelectTrigger
              className="h-7 min-w-[140px] gap-1.5 border-border bg-transparent px-2 text-xs [&>svg]:size-3 [&>svg]:shrink-0"
              size="sm"
              aria-label="Choose account"
              title={activeLabel}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {showActiveAvatar ? (
                  <img
                    alt=""
                    src={activeAvatar}
                    referrerPolicy="no-referrer"
                    className="size-4 shrink-0 rounded-full bg-muted object-cover"
                    onError={() =>
                      activeConn && markAvatarFailed(activeConn.connection_id)
                    }
                  />
                ) : (
                  <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground">
                    {activeFallback}
                  </span>
                )}
                <span className="truncate text-xs font-medium text-foreground">
                  {activeLabel}
                </span>
              </span>
            </SelectTrigger>
            <SelectContent
              align="start"
              className="min-w-[200px] gap-0 rounded-lg p-1 shadow-xs"
            >
              {availableAccounts?.map((conn, index) => {
                const meta = accountMetadata.get(conn.connection_id);
                const itemLabel = accountDisplayLabel(conn, meta, index);
                const avatarUrl = meta?.avatarUrl?.trim();
                const avatarBroken = avatarFailures.has(conn.connection_id);
                const showAvatar = Boolean(avatarUrl) && !avatarBroken;
                const fallbackChar = accountAvatarFallbackChar(itemLabel);
                return (
                  <SelectItem
                    key={conn.connection_id}
                    value={conn.connection_id}
                    className="rounded-md px-2.5 py-1.5 text-xs"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {showAvatar ? (
                        <img
                          alt=""
                          src={avatarUrl}
                          referrerPolicy="no-referrer"
                          className="size-4 shrink-0 rounded-full bg-muted object-cover"
                          onError={() => markAvatarFailed(conn.connection_id)}
                        />
                      ) : (
                        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground">
                          {fallbackChar}
                        </span>
                      )}
                      <span className="truncate font-medium text-foreground">
                        {itemLabel}
                      </span>
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        ) : null}
        {state === "installed" ? (
          <Button
            variant="ghost"
            size="sm"
            disabled
            className="text-muted-foreground"
          >
            <Check size={13} />
            Installed
          </Button>
        ) : state === "installing" ? (
          <Button variant="ghost" size="sm" disabled>
            <LoaderCircle size={13} className="animate-spin" />
            Installing…
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={onInstall}
            className={cn(
              // Reveal-on-hover so a long list reads as a quiet roster of
              // names; the install action surfaces only when the user is
              // pointing at a row. Focus-visible keeps it keyboard-reachable.
              "opacity-0 transition-opacity",
              "group-hover:opacity-100 focus-visible:opacity-100",
            )}
          >
            <Download size={13} />
            Install
          </Button>
        )}
      </div>
    </div>
  );
}

export type { AppCardState };
