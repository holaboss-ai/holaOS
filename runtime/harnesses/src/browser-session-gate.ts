/**
 * The single on/off gate for browser tools by session kind, across the runtime.
 * `pi` consults it in its in-process request build (`browser_tools_enabled`),
 * the CLI-harness MCP bridge consults it when deciding whether to expose the
 * browser tool family over `holaboss_runtime_tools`, and the runtime's
 * `browserToolsAllowedForSession` (harness-registry) delegates to it so the
 * capability manifest that ADVERTISES browser tools and the surfaces that WIRE
 * them can never disagree.
 *
 * Every agent-operating session gets browser tools — the main workspace loop
 * (its system prompt already advertises "direct access to … browser") as well
 * as subagents. Onboarding is the one exclusion: a constrained first-run flow
 * with no place for browser control. This is only the POLICY gate; the browser
 * still surfaces solely when the desktop browser capability is actually
 * reachable (stageBrowserTools requires it configured; the MCP resolver
 * self-gates on `browserCapabilityAvailable`), so an unconfigured browser yields
 * no tools regardless of session kind.
 */
export function browserToolsEnabledForSessionKind(
  sessionKind: string | null | undefined,
): boolean {
  const normalized = String(sessionKind ?? "").trim().toLowerCase();
  return normalized !== "onboarding";
}
