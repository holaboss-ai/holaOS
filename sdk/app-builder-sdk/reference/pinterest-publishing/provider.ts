import type { ProviderRegistry } from "../../src/types.ts"

export const PINTEREST: ProviderRegistry = {
  id: "pinterest",
  baseUrl: "https://api.pinterest.com/v5",
  allowedHosts: ["api.pinterest.com"],
  whoamiPath: "/user_account",
  composioToolkit: "pinterest",
}
