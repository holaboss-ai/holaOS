import type { ProviderRegistry } from "../../src/types.ts"

export const TELEGRAM: ProviderRegistry = {
  id: "telegram",
  baseUrl: "https://api.telegram.org",
  allowedHosts: ["api.telegram.org"],
  whoamiPath: "/getMe",
  composioToolkit: "telegram",
}
