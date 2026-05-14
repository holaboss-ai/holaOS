import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  ChevronRight,
  Gift,
  RefreshCw,
  ShoppingCart,
  Sparkles,
  UserCog,
  Zap,
} from "lucide-react";
import { BillingSummaryCard } from "@/components/billing/BillingSummaryCard";
import {
  SettingsCard,
  SettingsSection,
} from "@/components/settings";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { trackUmamiEvent } from "@/lib/analytics/umami";
import { useDesktopBilling } from "@/lib/billing/useDesktopBilling";

// ============================================================================
// Helpers
// ============================================================================

function formatBillingDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatBillingDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const datePart = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timePart = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return `${datePart} · ${timePart}`;
}

const CATEGORY_LABELS: Record<string, string> = {
  llm: "Model",
  integration: "Integration",
  proactive: "Background work",
  workspace: "Workspace",
};

function titleCase(raw: string): string {
  return raw
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function humanizeCategory(raw: string): string {
  return CATEGORY_LABELS[raw] ?? titleCase(raw);
}

function readMetadataString(
  metadata: Record<string, unknown> | null,
  key: string,
): string | null {
  if (!metadata) {
    return null;
  }
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

type UsageItem = DesktopBillingUsageItemPayload;

function resolveUsageTitle(item: UsageItem): string {
  const category = item.category ?? null;
  const provider = readMetadataString(item.metadata, "provider");
  const modelId = readMetadataString(item.metadata, "modelId");
  const integrationId = readMetadataString(item.metadata, "integrationId");

  if (category === "llm" && modelId) {
    return provider ? `${provider} · ${modelId}` : modelId;
  }
  if (category === "integration" && integrationId) {
    return titleCase(integrationId);
  }
  if (category) {
    return humanizeCategory(category);
  }
  if (item.serviceType) {
    return titleCase(item.serviceType);
  }
  if (item.type === "allocate" || item.amount > 0) {
    return "Credits added";
  }
  if (
    item.reason &&
    item.reason.trim() &&
    item.reason !== "Service consumption" &&
    !item.reason.startsWith("Service consumption:")
  ) {
    return item.reason;
  }
  return titleCase(item.type);
}

function resolveUsageSubtitle(item: UsageItem): string | null {
  const operation = readMetadataString(item.metadata, "operation");
  const workspaceId = readMetadataString(item.metadata, "workspaceId");
  const modelId = readMetadataString(item.metadata, "modelId");

  if (operation && operation !== modelId) {
    return operation;
  }
  if (item.category === "llm" && workspaceId) {
    return `Workspace ${workspaceId.slice(0, 8)}`;
  }
  const reason = (item.reason ?? "").trim();
  if (!reason || reason.startsWith("Service consumption")) {
    return null;
  }
  return reason;
}

// ============================================================================
// Session Grouping
// ============================================================================

interface UsageGroup {
  key: string;
  items: UsageItem[];
  totalAmount: number;
  firstCreatedAt: string;
}

function groupBySession(items: UsageItem[]): UsageGroup[] {
  const groups: UsageGroup[] = [];
  let currentSessionId: string | null = null;
  let currentGroup: UsageGroup | null = null;

  for (const item of items) {
    const sessionId = readMetadataString(item.metadata, "sessionId");

    if (sessionId && sessionId === currentSessionId && currentGroup) {
      currentGroup.items.push(item);
      currentGroup.totalAmount += item.amount;
    } else {
      currentGroup = {
        key: sessionId ?? item.id,
        items: [item],
        totalAmount: item.amount,
        firstCreatedAt: item.createdAt,
      };
      groups.push(currentGroup);
      currentSessionId = sessionId;
    }
  }
  return groups;
}

function resolveGroupTitle(group: UsageGroup): string {
  const first = group.items[0];
  if (group.items.length === 1) {
    return resolveUsageTitle(first);
  }
  const modelId = readMetadataString(first.metadata, "modelId");
  const provider = readMetadataString(first.metadata, "provider");

  let label: string;
  if (first.category === "llm" && modelId) {
    label = provider ? `${provider} · ${modelId}` : modelId;
  } else if (first.category) {
    label = humanizeCategory(first.category);
  } else {
    label = "Chat";
  }
  return `${label} · ${group.items.length} calls`;
}

function resolveGroupSubtitle(group: UsageGroup): string | null {
  if (group.items.length <= 1) {
    return null;
  }
  const first = group.items[0];
  const sessionId = readMetadataString(first.metadata, "sessionId");
  const workspaceId = readMetadataString(first.metadata, "workspaceId");

  const parts: string[] = [];
  if (sessionId) {
    parts.push(`Session ${sessionId.slice(0, 8)}`);
  }
  if (workspaceId) {
    parts.push(`Workspace ${workspaceId.slice(0, 8)}`);
  }
  if (parts.length > 0) {
    return parts.join(" · ");
  }
  return null;
}

// ============================================================================
// Icons
// ============================================================================

function UsageIcon({ item }: { item: UsageItem }) {
  if (item.type === "consume") {
    return <Zap size={14} />;
  }
  switch (item.sourceType) {
    case "signup":
      return <Gift size={14} />;
    case "purchase":
      return <ShoppingCart size={14} />;
    case "admin":
      return <UserCog size={14} />;
    default:
      return <Sparkles size={14} />;
  }
}

// ============================================================================
// Row Components (matching web style)
// ============================================================================

function UsageRow({ item }: { item: UsageItem }) {
  const isCredit = item.amount > 0;
  const title = resolveUsageTitle(item);
  const subtitle = resolveUsageSubtitle(item);

  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <div
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
            isCredit
              ? "bg-success/10 text-success"
              : "bg-destructive/10 text-destructive"
          }`}
        >
          <UsageIcon item={item} />
        </div>
        <div className="min-w-0 leading-tight">
          <p className="truncate font-medium text-sm text-foreground">
            {title}
          </p>
          <p className="truncate text-muted-foreground text-xs tabular-nums">
            {subtitle ? `${subtitle} · ` : ""}
            {formatBillingDateTime(item.createdAt)}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {isCredit ? (
          <ArrowDownLeft size={14} className="text-success" />
        ) : (
          <ArrowUpRight size={14} className="text-destructive" />
        )}
        <span
          className={`font-semibold text-sm tabular-nums ${
            isCredit ? "text-success" : "text-destructive"
          }`}
        >
          {isCredit ? "+" : "-"}
          {Math.abs(item.amount).toLocaleString()}
        </span>
      </div>
    </div>
  );
}

function UsageGroupRow({
  group,
  expanded,
  onToggle,
}: {
  group: UsageGroup;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (group.items.length <= 1) {
    return <UsageRow item={group.items[0]} />;
  }

  const title = resolveGroupTitle(group);
  const subtitle = resolveGroupSubtitle(group);
  const isCredit = group.totalAmount > 0;

  return (
    <div>
      {/* Group header */}
      <div
        className="flex cursor-pointer items-center justify-between gap-3 py-3 transition-colors hover:bg-accent/30"
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        role="button"
        tabIndex={0}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
              isCredit
                ? "bg-success/10 text-success"
                : "bg-destructive/10 text-destructive"
            }`}
          >
            <ChevronRight
              size={14}
              className={`transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
            />
          </div>
          <div className="min-w-0 leading-tight">
            <p className="truncate font-medium text-sm text-foreground">
              {title}
            </p>
            <p className="truncate text-muted-foreground text-xs tabular-nums">
              {subtitle ? `${subtitle} · ` : ""}
              {formatBillingDateTime(group.firstCreatedAt)}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isCredit ? (
            <ArrowDownLeft size={14} className="text-success" />
          ) : (
            <ArrowUpRight size={14} className="text-destructive" />
          )}
          <span
            className={`font-semibold text-sm tabular-nums ${
              isCredit ? "text-success" : "text-destructive"
            }`}
          >
            {isCredit ? "+" : "-"}
            {Math.abs(group.totalAmount).toLocaleString()}
          </span>
        </div>
      </div>

      {/* Expanded children */}
      {expanded && (
        <div className="ml-9 border-l border-border pl-2">
          {group.items.map((item) => (
            <UsageRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Main
// ============================================================================

function openBillingLink(url: string | null | undefined) {
  const normalizedUrl = (url ?? "").trim();
  if (!normalizedUrl) {
    return;
  }
  void window.electronAPI.ui.openExternalUrl(normalizedUrl);
}

export function BillingSettingsPanel() {
  const { overview, usage, links, isLoading, error, refresh } =
    useDesktopBilling();

  useEffect(() => {
    trackUmamiEvent("billing_page_viewed", { surface: "desktop" });
  }, []);

  const showExpirationBanner = Boolean(overview?.expiresAt);
  const usageItems = usage?.items ?? [];
  const groups = useMemo(
    () => groupBySession(usageItems.slice(0, 30)),
    [usageItems],
  );
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(),
  );

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <div className="grid gap-6">
      {showExpirationBanner ? (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-warning/10 px-4 py-3 ring-1 ring-warning/30">
          <div className="flex min-w-0 items-center gap-2 text-sm text-warning">
            <AlertCircle size={16} className="shrink-0" />
            <span className="truncate">
              {overview?.planName || "Plan"} expires on{" "}
              {overview?.expiresAt ? formatBillingDate(overview.expiresAt) : ""}
            </span>
          </div>
          <Button
            variant="link"
            size="sm"
            onClick={() => openBillingLink(links?.billingPageUrl)}
          >
            Reactivate
          </Button>
        </div>
      ) : null}

      <SettingsSection title="Plan">
        <BillingSummaryCard
          overview={overview}
          usage={usage}
          links={links}
          isLoading={isLoading}
          error={error}
          onRefresh={() => {
            void refresh();
          }}
        />
      </SettingsSection>

      <SettingsSection
        title="Usage record"
        action={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={isLoading ? "Refreshing usage" : "Refresh usage"}
                  onClick={() => {
                    void refresh();
                  }}
                  disabled={isLoading}
                />
              }
            >
              <RefreshCw
                size={14}
                className={isLoading ? "animate-spin" : ""}
              />
            </TooltipTrigger>
            <TooltipContent side="top">
              {isLoading ? "Refreshing..." : "Refresh"}
            </TooltipContent>
          </Tooltip>
        }
      >
        <SettingsCard>
          {isLoading && groups.length === 0 ? (
            <div
              role="status"
              aria-busy="true"
              aria-label="Loading usage"
              className="px-4 py-2"
            >
              {[80, 96, 64].map((w) => (
                <div
                  key={w}
                  className="flex items-center gap-2.5 py-3"
                >
                  <span className="h-7 w-7 shrink-0 animate-pulse rounded-full bg-muted-foreground/20" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span
                      className="h-3 animate-pulse rounded bg-muted-foreground/20"
                      style={{ width: `${w}%` }}
                    />
                    <span className="h-2.5 w-32 animate-pulse rounded bg-muted-foreground/20" />
                  </div>
                  <span className="h-3 w-10 shrink-0 animate-pulse rounded bg-muted-foreground/20" />
                </div>
              ))}
            </div>
          ) : groups.length === 0 ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">
              No usage yet.
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.key} className="px-4">
                <UsageGroupRow
                  group={group}
                  expanded={expandedGroups.has(group.key)}
                  onToggle={() => toggleGroup(group.key)}
                />
              </div>
            ))
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
