export interface DesktopBillingLinks {
  billingPageUrl: string;
  addCreditsUrl: string;
  upgradeUrl: string;
  usageUrl: string;
}

export const HOLABOSS_HOME_URL = "https://holaboss.ai";

export function normalizeBaseUrl(value: string | null | undefined): string {
  return (value ?? "").replace(/\/+$/u, "");
}

export function deriveAppBaseUrl(apiBaseUrl: string): string {
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

export function buildDesktopBillingLinks(appBaseUrl: string): DesktopBillingLinks {
  const normalizedBaseUrl = normalizeBaseUrl(appBaseUrl) || HOLABOSS_HOME_URL;
  return {
    billingPageUrl: `${normalizedBaseUrl}/app/settings?tab=billing`,
    addCreditsUrl: `${normalizedBaseUrl}/app/settings?tab=billing&intent=add-credits`,
    upgradeUrl: `${normalizedBaseUrl}/app/settings?tab=billing&intent=upgrade`,
    usageUrl: `${normalizedBaseUrl}/app/settings?tab=billing&intent=usage`,
  };
}
