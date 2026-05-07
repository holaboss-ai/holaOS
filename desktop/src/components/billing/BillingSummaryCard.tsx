import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CircleHelp, RefreshCw } from "lucide-react";

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

function billingTimelineLabel(overview: DesktopBillingOverviewPayload | null) {
  if (!overview) {
    return "Billing managed on web";
  }
  if (overview.expiresAt) {
    return `Expires on ${formatBillingDate(overview.expiresAt)}`;
  }
  if (overview.renewsAt) {
    return `Renews on ${formatBillingDate(overview.renewsAt)}`;
  }
  return "Billing managed on web";
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
      <section
        role="status"
        aria-busy="true"
        aria-label="Loading billing summary"
        className="overflow-hidden rounded-xl bg-card ring-1 ring-border"
      >
        {/* Header skeleton */}
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="h-4 w-24 animate-pulse rounded bg-muted-foreground/20" />
            <span className="h-5 w-20 animate-pulse rounded-full bg-muted-foreground/20" />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {onRefresh ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh billing"
                onClick={onRefresh}
                disabled
              >
                <RefreshCw className="size-3.5 animate-spin" />
              </Button>
            ) : null}
          </div>
        </div>

        <div className="h-px bg-border" />

        {/* Stats grid skeleton */}
        <div className="px-4 py-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <div>
              <span className="block h-6 w-16 animate-pulse rounded bg-muted-foreground/20" />
              <span className="mt-1 block h-3 w-12 animate-pulse rounded bg-muted-foreground/20" />
            </div>
            <div className="text-right">
              <span className="ml-auto block h-6 w-14 animate-pulse rounded bg-muted-foreground/20" />
              <span className="mt-1 ml-auto block h-3 w-12 animate-pulse rounded bg-muted-foreground/20" />
            </div>
          </div>
        </div>

        <div className="h-px bg-border" />

        {/* Bottom stats skeleton */}
        <div className="grid gap-1.5 px-4 py-3">
          {(["w-20", "w-16", "w-16"] as const).map((w) => (
            <div key={w} className="flex items-center justify-between">
              <span
                className={`h-3 animate-pulse rounded bg-muted-foreground/20 ${w}`}
              />
              <span className="h-3 w-10 animate-pulse rounded bg-muted-foreground/20" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  const hasOverview = Boolean(overview);
  const creditsValue = hasOverview
    ? (overview?.creditsBalance ?? 0).toLocaleString()
    : "—";

  const timelineLabel = billingTimelineLabel(overview);

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card [&>*+*]:border-t [&>*+*]:border-border">
      {/* Header row */}
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {overview?.planName || "Free"}
          </span>
          {timelineLabel !== "Billing managed on web" ? (
            <Badge variant="outline" className="shrink-0 text-muted-foreground">
              {timelineLabel}
            </Badge>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1">
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
            onClick={() => openBillingLink(links?.billingPageUrl)}
          >
            Manage
          </Button>
          <Button onClick={() => openBillingLink(links?.addCreditsUrl)}>
            Add credits
          </Button>
        </div>
      </div>

      {error ? (
        <div className="bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error.message}
        </div>
      ) : null}

      {!hasOverview && !error ? (
        <div className="px-4 py-3 text-sm text-muted-foreground">
          Sign in to view billing details.
        </div>
      ) : null}

      {/* Credits stat row */}
      <div className="px-4 py-3">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <div>
            <div className="text-lg font-semibold tabular-nums text-foreground">
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
                    />
                  }
                >
                  <CircleHelp className="size-3" />
                </PopoverTrigger>
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
            <div className="text-lg font-semibold tabular-nums text-foreground">
              {overview?.monthlyCreditsIncluded?.toLocaleString() ?? "—"}
            </div>
            <div className="text-sm text-muted-foreground">Monthly</div>
          </div>
        </div>
      </div>

      {/* List row */}
      <div className="grid gap-1.5 px-4 py-3 text-sm text-muted-foreground">
        <div className="flex items-center justify-between">
          <span>Total allocated</span>
          <span className="tabular-nums text-foreground">
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
    </section>
  );
}
