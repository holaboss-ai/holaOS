export type ClassifiedEnvValue =
  | { kind: "literal" }
  | { kind: "env"; name: string }
  | { kind: "malformed" };

const ENV_PLACEHOLDER = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Classify an MCP header / environment value: a literal, a well-formed
 * `{env:NAME}` placeholder, or a malformed one (looks like a placeholder but
 * the variable name is invalid, e.g. contains a hyphen).
 *
 * This must be the ONLY definition of the rule. Install-time validation
 * (parseMcpServer) and runtime resolution (resolveEnvPlaceholders) both call
 * it, so the two tiers can't disagree — disagreement is exactly how a malformed
 * placeholder used to pass install and then throw on every run.
 */
export function classifyEnvValue(value: string): ClassifiedEnvValue {
  const token = value.trim();
  const match = token.match(ENV_PLACEHOLDER);
  if (match) {
    return { kind: "env", name: match[1]! };
  }
  if (token.startsWith("{env:") && token.endsWith("}")) {
    return { kind: "malformed" };
  }
  return { kind: "literal" };
}
