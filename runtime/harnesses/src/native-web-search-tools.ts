export const NATIVE_WEB_SEARCH_TOOL_DEFINITIONS = [
  {
    id: "web_search",
    description:
      "Search the public web for current information across many sources — the PRIMARY tool for latest news, recent events, prices/quotes, general lookups, source discovery, and multi-source research, INCLUDING time-sensitive and \"today/latest/now\" questions. Prefer this over the browser for any web reading or research: it is faster, returns cited sources, and does not need a page open. Reach for browser tools only when the task genuinely needs interaction (logging in, clicking through an app or an authenticated page), direct UI/visual inspection, or a specific page this search cannot surface — NOT for general web reading or because a question is time-sensitive. It does not perform actions, read UI-only state, or reach pages behind a login; escalate to the browser only for those.",
    policy: "inspect"
  }
] as const;

export type NativeWebSearchToolId = (typeof NATIVE_WEB_SEARCH_TOOL_DEFINITIONS)[number]["id"];

// The name this tool is EXPOSED to the model under — deliberately NOT `web_search`.
//
// Anthropic's Messages API (and OpenAI's) reserve `web_search` for their built-in
// server-side web-search tool (`web_search_20250305`). When a *custom* client tool
// is sent under that exact name, the provider silently DROPS it before the model
// ever sees it — so the agent behaves as if it has no web search and falls back to
// the browser (verified 2026-07-12: two identically-shaped tools named `web_search`
// vs `web_lookup` sent to the proxy → the model can only call `web_lookup`).
//
// We therefore present the tool to the model under this non-reserved alias while
// keeping the internal id `web_search` everywhere else (capability manifest,
// enable-map, `tool_id` in results, telemetry, preview shaping). Only the wire-name
// the provider sees changes; nothing internal is keyed off it.
export const NATIVE_WEB_SEARCH_EXPOSED_TOOL_NAME = "search_web";

export const NATIVE_WEB_SEARCH_TOOL_IDS: NativeWebSearchToolId[] = NATIVE_WEB_SEARCH_TOOL_DEFINITIONS.map(
  (tool) => tool.id
);
