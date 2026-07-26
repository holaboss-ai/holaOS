/**
 * Harnesses still maturing — surfaced with a "Beta" tag in the agents list
 * and the harness picker. Currently none: the supported harnesses (pi,
 * claude-code, codex) are all considered stable.
 */
const BETA_HARNESS_IDS = new Set<string>([]);

export function isBetaHarness(id: string | null | undefined): boolean {
  return typeof id === "string" && BETA_HARNESS_IDS.has(id.toLowerCase());
}

/**
 * Agents that run against an external coding subscription (Claude Code → Claude
 * plan, Codex → ChatGPT/OpenAI plan) rather than the built-in Holaboss model
 * proxy. Surfaced with a subtle "to use with your code plan" hint so users know
 * they can reuse their existing plan instead of paying separately.
 */
const CODE_PLAN_HARNESS_IDS = new Set(["claude-code", "codex"]);

export function usesExternalCodePlan(id: string | null | undefined): boolean {
  return typeof id === "string" && CODE_PLAN_HARNESS_IDS.has(id.toLowerCase());
}

/** The hint copy shown beside external-code-plan agents. */
export const CODE_PLAN_HINT = "to use with your code plan";

/**
 * Per-harness setup / sign-in commands. An external CLI can be installed (on
 * PATH → "available") yet not authenticated or missing a model, in which case
 * runs come back empty. We surface this exact command as a login hint when a
 * harness reports "needs setup". Only commands we're confident about are
 * listed; everything else falls back to a generic message via
 * {@link harnessLoginHint}.
 */
const HARNESS_LOGIN_COMMAND: Record<string, string> = {
  codex: "codex login",
  "claude-code": "claude  (then sign in)",
};

/**
 * A short, actionable sign-in hint for a harness. Returns the exact command
 * when known, otherwise a generic instruction naming the CLI.
 */
export function harnessLoginHint(
  id: string | null | undefined,
  displayName?: string | null,
): string {
  const key = typeof id === "string" ? id.toLowerCase() : "";
  const command = HARNESS_LOGIN_COMMAND[key];
  if (command) {
    return `Sign in to the ${displayName || key} CLI: run \`${command}\` in a terminal, then re-detect.`;
  }
  const name = displayName || key || "this agent";
  return `Authenticate the ${name} CLI (and configure a model), then re-detect.`;
}
