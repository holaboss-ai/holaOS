import type { ProviderRegistry } from "../../src/types.ts"

export const SLACK: ProviderRegistry = {
  id: "slack",
  baseUrl: "https://slack.com/api",
  allowedHosts: ["slack.com"],
  whoamiPath: "/auth.test",
  composioToolkit: "slack",
}
