import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useDesktopAuthSession } from "@/lib/auth/authClient";
import { billingRpcFetch } from "@/lib/app-sdk-client";

interface DesktopBillingContextValue {
  isAvailable: boolean;
  isLoading: boolean;
  error: Error | null;
  overview: DesktopBillingOverviewPayload | null;
  usage: DesktopBillingUsagePayload | null;
  links: DesktopBillingLinksPayload | null;
  hasHostedBillingAccount: boolean;
  isLowBalance: boolean;
  isOutOfCredits: boolean;
  refresh: () => Promise<void>;
}

const DesktopBillingContext = createContext<DesktopBillingContextValue | null>(
  null,
);

const DESKTOP_BILLING_TOKENS_PER_CREDIT = 2000;
const DESKTOP_BILLING_LOW_BALANCE_THRESHOLD = 10;
const HOLABOSS_HOME_URL = "https://holaboss.ai";

const DESKTOP_BILLING_PLAN_META = {
  basic: {
    planId: "basic",
    planName: "Holaboss",
    monthlyCreditsIncluded: 200 as number | null,
  },
  pro: {
    planId: "pro",
    planName: "Holaboss Pro",
    monthlyCreditsIncluded: 2000 as number | null,
  },
  customize: {
    planId: "customize",
    planName: "Holaboss Custom",
    monthlyCreditsIncluded: null as number | null,
  },
} as const;

type DesktopBillingPlanMeta =
  (typeof DESKTOP_BILLING_PLAN_META)[keyof typeof DESKTOP_BILLING_PLAN_META];

interface DesktopBillingQuotaRpc {
  balance: number;
  totalAllocated: number;
  totalUsed: number;
}

interface DesktopBillingTransactionRpc {
  id: string;
  type: string;
  sourceType: string | null;
  reason: string | null;
  serviceType: string | null;
  serviceId: string | null;
  category: string | null;
  metadata: Record<string, unknown> | null;
  amount: number;
  createdAt: string;
}

interface DesktopBillingSubscriptionRpc {
  status: string;
  plan: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

interface DesktopBillingInfoRpc {
  hasActiveSubscription: boolean;
  subscription: DesktopBillingSubscriptionRpc | null;
  stripeCustomerId: string | null;
}

function desktopBillingTokensToCredits(tokens: number): number {
  return Math.floor(tokens / DESKTOP_BILLING_TOKENS_PER_CREDIT);
}

function desktopBillingPlanMeta(
  plan: string | null | undefined,
): DesktopBillingPlanMeta {
  if (plan === "pro" || plan === "customize") {
    return DESKTOP_BILLING_PLAN_META[plan];
  }
  return DESKTOP_BILLING_PLAN_META.basic;
}

function normalizeBaseUrl(value: string | null | undefined): string {
  return (value ?? "").replace(/\/+$/u, "");
}

function deriveAppBaseUrl(apiBaseUrl: string): string {
  if (!apiBaseUrl) {
    return HOLABOSS_HOME_URL;
  }
  try {
    const parsed = new URL(apiBaseUrl);
    if (parsed.hostname === "localhost" && parsed.port === "4000") {
      parsed.port = "4321";
      return parsed.origin;
    }
    if (parsed.hostname.startsWith("api-preview.")) {
      parsed.hostname = parsed.hostname.replace(/^api-preview\./u, "preview.");
      return parsed.origin;
    }
    if (parsed.hostname === "api.holaos.ai") {
      // holaos.ai's web app is served from www., not app. (the app. subdomain
      // is unused). Other api.* hosts (e.g. api.holaboss.ai, api.imerchstaging.com)
      // still pair with app.* per their deploy layouts.
      parsed.hostname = "www.holaos.ai";
      return parsed.origin;
    }
    if (parsed.hostname.startsWith("api.")) {
      parsed.hostname = parsed.hostname.replace(/^api\./u, "app.");
      return parsed.origin;
    }
    return parsed.origin;
  } catch {
    return HOLABOSS_HOME_URL;
  }
}

function buildDesktopBillingLinks(appBaseUrl: string): DesktopBillingLinksPayload {
  const normalizedBaseUrl = normalizeBaseUrl(appBaseUrl) || HOLABOSS_HOME_URL;
  return {
    billingPageUrl: `${normalizedBaseUrl}/app/settings?tab=billing`,
    addCreditsUrl: `${normalizedBaseUrl}/app/settings?tab=billing&intent=add-credits`,
    upgradeUrl: `${normalizedBaseUrl}/app/settings?tab=billing&intent=upgrade`,
    usageUrl: `${normalizedBaseUrl}/app/settings?tab=billing&intent=usage`,
  };
}

async function fetchBillingOverview(): Promise<DesktopBillingOverviewPayload> {
  const [quota, billingInfo] = await Promise.all([
    billingRpcFetch<DesktopBillingQuotaRpc>("/rpc/quota/myQuota"),
    billingRpcFetch<DesktopBillingInfoRpc>("/rpc/billing/myBillingInfo"),
  ]);
  const subscription = billingInfo.subscription;
  const planMeta = desktopBillingPlanMeta(subscription?.plan);
  const renewsAt =
    subscription && !subscription.cancelAtPeriodEnd
      ? subscription.currentPeriodEnd
      : null;
  const expiresAt = subscription?.cancelAtPeriodEnd
    ? subscription.currentPeriodEnd
    : null;
  const creditsBalance = quota.balance;

  return {
    hasHostedBillingAccount: true,
    planId: planMeta.planId,
    planName: planMeta.planName,
    planStatus: subscription?.status ?? "inactive",
    renewsAt,
    expiresAt,
    creditsBalance,
    totalAllocated: quota.totalAllocated,
    totalUsed: quota.totalUsed,
    monthlyCreditsIncluded: planMeta.monthlyCreditsIncluded,
    monthlyCreditsUsed: null,
    dailyRefreshCredits: null,
    dailyRefreshTarget: null,
    lowBalanceThreshold: DESKTOP_BILLING_LOW_BALANCE_THRESHOLD,
    isLowBalance:
      creditsBalance > 0 &&
      creditsBalance < DESKTOP_BILLING_LOW_BALANCE_THRESHOLD,
  };
}

async function fetchBillingUsage(limit = 10): Promise<DesktopBillingUsagePayload> {
  const normalizedLimit = Math.max(1, Math.min(limit, 50));
  const items = await billingRpcFetch<DesktopBillingTransactionRpc[]>(
    "/rpc/quota/myTransactions",
    { limit: normalizedLimit },
  );
  return {
    items: items.map((transaction) => {
      const amount = desktopBillingTokensToCredits(transaction.amount);
      return {
        id: transaction.id,
        type: transaction.type,
        sourceType: transaction.sourceType,
        reason: transaction.reason,
        serviceType: transaction.serviceType,
        serviceId: transaction.serviceId,
        category: transaction.category,
        metadata: transaction.metadata,
        amount,
        absoluteAmount: Math.abs(amount),
        createdAt: transaction.createdAt,
      };
    }),
    count: items.length,
  };
}

async function fetchBillingLinks(): Promise<DesktopBillingLinksPayload> {
  const apiBaseUrl = await window.electronAPI.auth.getApiBaseUrl();
  return buildDesktopBillingLinks(deriveAppBaseUrl(apiBaseUrl));
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error("Failed to load desktop billing state.");
}

export function DesktopBillingProvider({
  children,
}: {
  children: ReactNode;
}) {
  const authSessionState = useDesktopAuthSession();
  const isAuthenticated = Boolean(authSessionState.data?.user?.id?.trim());
  const [isLoading, setIsLoading] = useState(authSessionState.isPending);
  const [error, setError] = useState<Error | null>(null);
  const [overview, setOverview] =
    useState<DesktopBillingOverviewPayload | null>(null);
  const [usage, setUsage] = useState<DesktopBillingUsagePayload | null>(null);
  const [links, setLinks] = useState<DesktopBillingLinksPayload | null>(null);

  const refresh = useCallback(async () => {
    if (!isAuthenticated) {
      setOverview(null);
      setUsage(null);
      setLinks(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    try {
      const [nextOverview, nextUsage, nextLinks] = await Promise.all([
        fetchBillingOverview(),
        fetchBillingUsage(),
        fetchBillingLinks(),
      ]);
      setOverview(nextOverview);
      setUsage(nextUsage);
      setLinks(nextLinks);
      setError(null);
    } catch (nextError) {
      setError(normalizeError(nextError));
    } finally {
      setIsLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (authSessionState.isPending) {
      setIsLoading(true);
      return;
    }
    void refresh();
  }, [authSessionState.isPending, refresh]);

  const isLowBalance = Boolean(
    overview &&
      (overview.isLowBalance ||
        (overview.creditsBalance > 0 &&
          overview.creditsBalance < overview.lowBalanceThreshold)),
  );
  const isOutOfCredits = overview ? overview.creditsBalance <= 0 : false;

  const value = useMemo<DesktopBillingContextValue>(
    () => ({
      isAvailable: isAuthenticated,
      isLoading,
      error,
      overview,
      usage,
      links,
      hasHostedBillingAccount: Boolean(overview?.hasHostedBillingAccount),
      isLowBalance,
      isOutOfCredits,
      refresh,
    }),
    [error, isAuthenticated, isLoading, isLowBalance, isOutOfCredits, links, overview, refresh, usage],
  );

  return (
    <DesktopBillingContext.Provider value={value}>
      {children}
    </DesktopBillingContext.Provider>
  );
}

export function useDesktopBilling(): DesktopBillingContextValue {
  const context = useContext(DesktopBillingContext);
  if (!context) {
    throw new Error(
      "useDesktopBilling must be used inside DesktopBillingProvider.",
    );
  }
  return context;
}
