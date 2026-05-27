import type { TeammateRecord } from "@holaboss/runtime-state-store";

export interface DelegatedTaskRoutingQuery {
  title: string;
  goal: string;
  context?: string | null;
  tools?: string[] | null;
}

export interface TeammateRoutingRosterEntry {
  teammate_id: string;
  name: string;
  kind: string;
  status: string;
  summary: string | null;
  capabilities: string[];
  preferred_tools: string[];
  skill_names: string[];
}

function nonEmptyText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function uniqueStringsInOrder(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = nonEmptyText(value);
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized;
}

function routingTokens(value: string | null | undefined): string[] {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function fallbackCapabilitySummary(teammate: TeammateRecord): string | null {
  const explicitSummary = nonEmptyText(teammate.capabilityProfile.summary);
  if (explicitSummary) {
    return explicitSummary;
  }
  const instructions = nonEmptyText(teammate.instructions);
  if (instructions) {
    return instructions;
  }
  const skillNames = uniqueStringsInOrder(teammate.skills.map((skill) => skill.name));
  if (skillNames.length > 0) {
    return `Primary domains: ${skillNames.join(", ")}.`;
  }
  return null;
}

export function buildTeammateRoutingRosterEntry(
  teammate: TeammateRecord,
): TeammateRoutingRosterEntry {
  const capabilities = uniqueStringsInOrder([
    ...teammate.capabilityProfile.capabilities,
    ...teammate.skills.map((skill) => skill.name),
  ]);
  return {
    teammate_id: teammate.teammateId,
    name: teammate.name,
    kind: teammate.kind,
    status: teammate.status,
    summary: fallbackCapabilitySummary(teammate),
    capabilities,
    preferred_tools: uniqueStringsInOrder(teammate.capabilityProfile.preferredTools),
    skill_names: uniqueStringsInOrder(teammate.skills.map((skill) => skill.name)),
  };
}

function teammateRoutingCorpusTokens(
  teammate: TeammateRecord,
  entry: TeammateRoutingRosterEntry,
): Set<string> {
  return new Set([
    ...routingTokens(teammate.name),
    ...routingTokens(entry.summary),
    ...entry.capabilities.flatMap((value) => routingTokens(value)),
    ...entry.preferred_tools.flatMap((value) => routingTokens(value)),
    ...routingTokens(teammate.instructions),
    ...teammate.skills.flatMap((skill) => [
      ...routingTokens(skill.name),
      ...routingTokens(skill.content),
    ]),
  ]);
}

export function selectDelegatedTaskTeammateByCapability(params: {
  general: TeammateRecord;
  teammates: TeammateRecord[];
  query: DelegatedTaskRoutingQuery;
}): TeammateRecord {
  const queryTools = uniqueStringsInOrder(params.query.tools ?? []);
  const queryTokens = new Set([
    ...routingTokens(params.query.title),
    ...routingTokens(params.query.goal),
    ...routingTokens(params.query.context ?? null),
    ...queryTools.flatMap((tool) => routingTokens(tool)),
  ]);
  if (queryTokens.size === 0 && queryTools.length === 0) {
    return params.general;
  }

  const queryText = [
    params.query.title,
    params.query.goal,
    params.query.context ?? "",
    ...queryTools,
  ]
    .join("\n")
    .toLowerCase();

  let bestTeammate = params.general;
  let bestScore = 0;
  for (const teammate of params.teammates) {
    if (
      teammate.status !== "active" ||
      teammate.teammateId === params.general.teammateId
    ) {
      continue;
    }
    const entry = buildTeammateRoutingRosterEntry(teammate);
    const corpusTokens = teammateRoutingCorpusTokens(teammate, entry);
    let score = 0;

    const normalizedName = nonEmptyText(teammate.name).toLowerCase();
    if (normalizedName && queryText.includes(normalizedName)) {
      score += 8;
    }

    const preferredTools = new Set(entry.preferred_tools.map((value) => value.toLowerCase()));
    for (const tool of queryTools) {
      const normalizedTool = tool.toLowerCase();
      if (preferredTools.has(normalizedTool)) {
        score += 10;
      }
    }

    const capabilityTokens = new Set([
      ...entry.capabilities.flatMap((value) => routingTokens(value)),
      ...entry.preferred_tools.flatMap((value) => routingTokens(value)),
    ]);
    const summaryTokens = new Set(routingTokens(entry.summary));
    for (const token of queryTokens) {
      if (capabilityTokens.has(token)) {
        score += 4;
        continue;
      }
      if (summaryTokens.has(token)) {
        score += 2;
        continue;
      }
      if (corpusTokens.has(token)) {
        score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestTeammate = teammate;
    }
  }

  return bestTeammate;
}
