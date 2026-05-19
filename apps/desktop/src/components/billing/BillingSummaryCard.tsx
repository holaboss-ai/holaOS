import { CircleHelp, RefreshCw } from "lucide-react";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";

interface BillingSummaryCardProps {
  overview: DesktopBillingOverviewPayload | null;
  usage: DesktopBillingUsagePayload | null;
  links: DesktopBillingLinksPayload | null;
  isLoading?: boolean;
  error?: Error | null;
  onRefresh?: () => void;
}

const CREDITS_HELP_ITEMS = [
  "Your available balance reflects all non-expired credit allocations minus usage.",
  "Monthly credits come from your subscription and expire at the end of the current billing period.",
  "Purchased credits and signup bonus credits do not expire.",
];

function formatBillingDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function billingTimelineLabel(
  overview: DesktopBillingOverviewPayload | null,
): string | null {
  if (!overview) {
    return null;
  }
  if (overview.expiresAt) {
    return `Expires ${formatBillingDate(overview.expiresAt)}`;
  }
  if (overview.renewsAt) {
    return `Renews ${formatBillingDate(overview.renewsAt)}`;
  }
  return null;
}

function openBillingLink(url: string | null | undefined) {
  const normalizedUrl = (url ?? "").trim();
  if (!normalizedUrl) {
    return;
  }
  void window.electronAPI.ui.openExternalUrl(normalizedUrl);
}

export function BillingSummaryCard({
  overview,
  links,
  isLoading = false,
  error = null,
  onRefresh,
}: BillingSummaryCardProps) {
  if (isLoading) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading billing summary"
      >
        <SettingsCard>
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="h-4 w-24 animate-pulse rounded bg-fg-8" />
            <span className="h-7 w-24 animate-pulse rounded-md bg-fg-8" />
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 px-4 py-3">
            <div>
              <span className="block h-6 w-16 animate-pulse rounded bg-fg-8" />
              <span className="mt-1 block h-3 w-12 animate-pulse rounded bg-fg-8" />
            </div>
            <div className="text-right">
              <span className="ml-auto block h-6 w-14 animate-pulse rounded bg-fg-8" />
              <span className="mt-1 ml-auto block h-3 w-12 animate-pulse rounded bg-fg-8" />
            </div>
          </div>
          <div className="grid gap-1.5 px-4 py-3">
            {(["w-20", "w-16", "w-16"] as const).map((w) => (
              <div key={w} className="flex items-center justify-between">
                <span className={`h-3 animate-pulse rounded bg-fg-8 ${w}`} />
                <span className="h-3 w-10 animate-pulse rounded bg-fg-8" />
              </div>
            ))}
          </div>
        </SettingsCard>
      </div>
    );
  }

  const hasOverview = Boolean(overview);
  const creditsValue = hasOverview
    ? (overview?.creditsBalance ?? 0).toLocaleString()
    : "—";

  const timelineLabel = billingTimelineLabel(overview);

  return (
    <SettingsCard>
      <SettingsRow
        label={overview?.planName || "Free"}
        description={timelineLabel ?? undefined}
      >
        <div className="flex items-center gap-1">
          {onRefresh ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh billing"
              onClick={onRefresh}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openBillingLink(links?.billingPageUrl)}
          >
            Manage
          </Button>
          <Button
            size="sm"
            onClick={() => openBillingLink(links?.addCreditsUrl)}
          >
            Add credits
          </Button>
        </div>
      </SettingsRow>

      {error ? (
        <div className="px-4 py-3 text-sm text-destructive">
          {error.message}
        </div>
      ) : null}

      {!hasOverview && !error ? (
        <div className="px-4 py-3 text-sm text-muted-foreground">
          Sign in to view billing details.
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 px-4 py-3">
        <div>
          <div className="text-lg font-semibold tabular-nums tracking-tight text-foreground">
            {creditsValue}
          </div>
          <div className="flex items-center gap-1 text-sm text-muted-foreground">
            <span>Credits</span>
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="About credits"
                    className="size-4 rounded-full text-muted-foreground"
                  >
                    <CircleHelp className="size-3" />
                  </Button>
                }
              />
              <PopoverContent align="start" className="w-80">
                <PopoverHeader>
                  <PopoverTitle>About credits</PopoverTitle>
                </PopoverHeader>
                <ul className="flex list-disc flex-col gap-2 pl-4 text-sm text-muted-foreground">
                  {CREDITS_HELP_ITEMS.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </PopoverContent>
            </Popover>
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold tabular-nums tracking-tight text-foreground">
            {overview?.monthlyCreditsIncluded?.toLocaleString() ?? "—"}
          </div>
          <div className="text-sm text-muted-foreground">Monthly</div>
        </div>
      </div>

      <div className="grid gap-1.5 px-4 py-3 text-sm text-muted-foreground">
        <div className="flex items-center justify-between">
          <span>Total allocated</span>
          <span className="tabular-nums tracking-tight text-foreground">
            {overview?.totalAllocated?.toLocaleString() ?? "—"}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span>Total used</span>
          <span className="tabular-nums tracking-tight text-foreground">
            {overview?.totalUsed?.toLocaleString() ?? "—"}
          </span>
        </div>
        {overview?.dailyRefreshCredits ? (
          <div className="flex items-center justify-between">
            <span>Daily refresh</span>
            <span className="tabular-nums tracking-tight text-foreground">
              {overview.dailyRefreshCredits.toLocaleString()}
            </span>
          </div>
        ) : null}
      </div>
    </SettingsCard>
  );
}
