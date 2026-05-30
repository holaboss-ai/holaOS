import type { TeammateRecord } from "@holaboss/runtime-state-store";

import { resolvedTeammateSkillsForRecord } from "./teammate-skill-files.js";
import { resolveWorkspaceSkills } from "./workspace-skills.js";

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
  skills: Array<{
    name: string;
    description: string | null;
  }>;
  skill_names: string[];
}

const APP_DOMAIN_QUERY_PATTERN =
  /\b(app|apps|dashboard|dashboards|ui|frontend|client|surface|internal tool|integration module|polish|workspace_apps_[a-z_]+)\b/i;
const APP_DOMAIN_CAPABILITY_TOKENS = new Set([
  "app",
  "apps",
  "dashboard",
  "dashboards",
  "ui",
  "frontend",
  "client",
  "sdk",
  "polish",
  "lifecycle",
]);

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

function fallbackCapabilitySummaryWithSkills(params: {
  teammate: TeammateRecord;
  skills: Array<{ name: string }>;
}): string | null {
  const explicitSummary = nonEmptyText(params.teammate.capabilityProfile.summary);
  if (explicitSummary) {
    return explicitSummary;
  }
  const instructions = nonEmptyText(params.teammate.instructions);
  if (instructions) {
    return instructions;
  }
  const skillNames = uniqueStringsInOrder(params.skills.map((skill) => skill.name));
  if (skillNames.length > 0) {
    return `Primary domains: ${skillNames.join(", ")}.`;
  }
  return null;
}

function teammateRoutingSkills(
  teammate: TeammateRecord,
  workspaceDir?: string | null,
): Array<{ name: string; content: string }> {
  if (!workspaceDir) {
    return [];
  }
  return resolvedTeammateSkillsForRecord({
    workspaceDir,
    teammate,
  });
}

function teammateRoutingSkillMetadata(
  teammate: TeammateRecord,
  workspaceDir?: string | null,
): Array<{ name: string; description: string | null }> {
  if (!workspaceDir) {
    return [];
  }
  const teammateId = nonEmptyText(teammate.teammateId);
  if (!teammateId) {
    return [];
  }
  const seen = new Set<string>();
  const metadata: Array<{ name: string; description: string | null }> = [];
  for (const skill of resolveWorkspaceSkills(workspaceDir, { teammateId })) {
    if (skill.origin !== "teammate" || skill.owner_teammate_id !== teammateId) {
      continue;
    }
    const name = nonEmptyText(skill.skill_name);
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    metadata.push({
      name,
      description: nonEmptyText(skill.description) || null,
    });
  }
  return metadata;
}

export function buildTeammateRoutingRosterEntry(
  teammate: TeammateRecord,
  options: { workspaceDir?: string | null } = {},
): TeammateRoutingRosterEntry {
  const skills = teammateRoutingSkills(teammate, options.workspaceDir);
  const skillMetadata = teammateRoutingSkillMetadata(teammate, options.workspaceDir);
  const capabilities = uniqueStringsInOrder([
    ...teammate.capabilityProfile.capabilities,
  ]);
  return {
    teammate_id: teammate.teammateId,
    name: teammate.name,
    kind: teammate.kind,
    status: teammate.status,
    summary: fallbackCapabilitySummaryWithSkills({ teammate, skills }),
    capabilities,
    skills: skillMetadata,
    skill_names: uniqueStringsInOrder(skillMetadata.map((skill) => skill.name)),
  };
}

function teammateRoutingCorpusTokens(
  teammate: TeammateRecord,
  entry: TeammateRoutingRosterEntry,
  options: { workspaceDir?: string | null } = {},
): Set<string> {
  const skills = teammateRoutingSkills(teammate, options.workspaceDir);
  return new Set([
    ...routingTokens(teammate.name),
    ...routingTokens(entry.summary),
    ...entry.capabilities.flatMap((value) => routingTokens(value)),
    ...entry.skills.flatMap((skill) => [
      ...routingTokens(skill.name),
      ...routingTokens(skill.description),
    ]),
    ...routingTokens(teammate.instructions),
    ...skills.flatMap((skill) => [
      ...routingTokens(skill.name),
      ...routingTokens(skill.content),
    ]),
  ]);
}

function queryTargetsAppDomain(params: {
  queryText: string;
  queryTools: string[];
}): boolean {
  return (
    APP_DOMAIN_QUERY_PATTERN.test(params.queryText) ||
    params.queryTools.some((tool) => tool.startsWith("workspace_apps_"))
  );
}

function teammateOwnsAppDomain(
  teammate: TeammateRecord,
  entry: TeammateRoutingRosterEntry,
): boolean {
  if (teammate.teammateId === "app_builder") {
    return true;
  }
  const teammateTokens = new Set([
    ...routingTokens(teammate.teammateId),
    ...routingTokens(teammate.name),
    ...routingTokens(entry.summary),
    ...entry.capabilities.flatMap((value) => routingTokens(value)),
  ]);
  for (const token of APP_DOMAIN_CAPABILITY_TOKENS) {
    if (teammateTokens.has(token)) {
      return true;
    }
  }
  return false;
}

export function selectDelegatedTaskTeammateByCapability(params: {
  general: TeammateRecord;
  teammates: TeammateRecord[];
  query: DelegatedTaskRoutingQuery;
  workspaceDir?: string | null;
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
  const appDomainQuery = queryTargetsAppDomain({
    queryText,
    queryTools,
  });

  let bestTeammate = params.general;
  let bestScore = 0;
  for (const teammate of params.teammates) {
    if (
      teammate.status !== "active" ||
      teammate.teammateId === params.general.teammateId
    ) {
      continue;
    }
    const entry = buildTeammateRoutingRosterEntry(teammate, {
      workspaceDir: params.workspaceDir,
    });
    const corpusTokens = teammateRoutingCorpusTokens(teammate, entry, {
      workspaceDir: params.workspaceDir,
    });
    let score = 0;

    const normalizedName = nonEmptyText(teammate.name).toLowerCase();
    if (normalizedName && queryText.includes(normalizedName)) {
      score += 8;
    }

    const capabilityTokens = new Set(
      entry.capabilities.flatMap((value) => routingTokens(value)),
    );
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

    if (appDomainQuery && teammateOwnsAppDomain(teammate, entry)) {
      score += queryTools.some((tool) => tool.startsWith("workspace_apps_")) ? 10 : 6;
    }

    if (score > bestScore) {
      bestScore = score;
      bestTeammate = teammate;
    }
  }

  return bestTeammate;
}
