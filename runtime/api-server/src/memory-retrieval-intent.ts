export const MEMORY_RETRIEVAL_INTENTS = [
  "fact_lookup",
  "procedure_lookup",
  "briefing",
  "planning",
  "delta",
] as const;

export type MemoryRetrievalIntent = (typeof MEMORY_RETRIEVAL_INTENTS)[number];

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  const matches = compactWhitespace(value).toLowerCase().match(/[a-z0-9]{2,}/g);
  return matches ? [...new Set(matches)] : [];
}

function hasAnyToken(tokens: string[], expected: string[]): boolean {
  return expected.some((token) => tokens.includes(token));
}

export function normalizeMemoryRetrievalIntent(value: unknown): MemoryRetrievalIntent | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return MEMORY_RETRIEVAL_INTENTS.includes(normalized as MemoryRetrievalIntent)
    ? normalized as MemoryRetrievalIntent
    : null;
}

export function inferMemoryRetrievalIntent(query: string): MemoryRetrievalIntent {
  const normalized = compactWhitespace(query).toLowerCase();
  const tokens = tokenize(normalized);
  if (normalized.length === 0) {
    return "fact_lookup";
  }

  const hasBriefingPhrase =
    normalized.includes("should be aware")
    || normalized.includes("should i know")
    || normalized.includes("what matters")
    || normalized.includes("what should i know")
    || normalized.includes("anything important")
    || normalized.includes("important email")
    || normalized.includes("important emails")
    || normalized.includes("urgent email")
    || normalized.includes("urgent emails");
  const hasDeltaPhrase =
    normalized.includes("what changed")
    || normalized.includes("what's changed")
    || normalized.includes("whats changed")
    || normalized.includes("since last")
    || normalized.includes("new since")
    || normalized.includes("anything new");
  const hasProcedurePhrase =
    normalized.startsWith("how ")
    || normalized.includes("how do")
    || normalized.includes("runbook")
    || normalized.includes("procedure")
    || normalized.includes("workflow")
    || normalized.includes("steps");
  const hasPlanningPhrase =
    normalized.includes("next step")
    || normalized.includes("next steps")
    || normalized.includes("what should we do")
    || normalized.includes("how should we")
    || normalized.includes("plan")
    || normalized.includes("unblock");

  if (
    hasDeltaPhrase
    || (hasAnyToken(tokens, ["changed", "change", "delta", "new", "newer", "latest", "recent"]) && normalized.includes("since"))
  ) {
    return "delta";
  }
  if (
    hasBriefingPhrase
    || (hasAnyToken(tokens, ["important", "urgent", "aware", "triage", "priority", "recently", "lately"]) && hasAnyToken(tokens, ["email", "emails", "message", "messages", "inbox", "context"]))
  ) {
    return "briefing";
  }
  if (hasProcedurePhrase || hasAnyToken(tokens, ["procedure", "steps", "process", "workflow", "runbook"])) {
    return "procedure_lookup";
  }
  if (hasPlanningPhrase || hasAnyToken(tokens, ["plan", "planning", "unblock", "decide", "decision"])) {
    return "planning";
  }
  return "fact_lookup";
}
