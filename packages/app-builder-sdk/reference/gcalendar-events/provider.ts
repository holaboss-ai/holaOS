import type { ProviderRegistry } from "../../src/types.ts"

export const GCALENDAR: ProviderRegistry = {
  id: "gcalendar",
  baseUrl: "https://www.googleapis.com/calendar/v3",
  allowedHosts: ["www.googleapis.com"],
  whoamiPath: "/users/me/calendarList",
  composioToolkit: "googlecalendar",
}
