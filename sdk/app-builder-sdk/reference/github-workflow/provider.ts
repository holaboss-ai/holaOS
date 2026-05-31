import type { ProviderRegistry } from "../../src/types.ts"

export const GITHUB: ProviderRegistry = {
  id: "github",
  baseUrl: "https://api.github.com",
  allowedHosts: ["api.github.com"],
  whoamiPath: "/user",
  composioToolkit: "github",
}
