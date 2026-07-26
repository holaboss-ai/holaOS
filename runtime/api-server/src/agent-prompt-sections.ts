import { createHash } from "node:crypto";

import type {
  HarnessPromptLayerApplyAt,
  HarnessPromptLayerId,
  HarnessPromptLayerPayload,
} from "../../harnesses/src/types.js";

export type AgentPromptSectionChannel =
  | "system_prompt"
  | "context_message"
  | "attachment";

export type AgentPromptSectionVolatility = "stable" | "workspace" | "run";

export type AgentPromptSectionPrecedence =
  | "base_runtime"
  | "session_policy"
  | "capability_policy"
  | "runtime_context"
  | "workspace_policy"
  | "harness_addendum"
  | "agent_override"
  | "emergency_override";

export type AgentPromptChannelContents = Partial<Record<AgentPromptSectionChannel, string[]>>;

export interface AgentPromptSection {
  id: HarnessPromptLayerId;
  channel: AgentPromptSectionChannel;
  apply_at: HarnessPromptLayerApplyAt;
  precedence: AgentPromptSectionPrecedence;
  priority: number;
  volatility: AgentPromptSectionVolatility;
  content: string;
}

export interface AgentPromptCacheProfile {
  cacheable_section_ids: HarnessPromptLayerId[];
  volatile_section_ids: HarnessPromptLayerId[];
  context_message_ids: HarnessPromptLayerId[];
  resume_context_ids: HarnessPromptLayerId[];
  attachment_ids: HarnessPromptLayerId[];
  compatibility_context_ids: HarnessPromptLayerId[];
  delta_section_ids: HarnessPromptLayerId[];
  channel_section_ids: Partial<Record<AgentPromptSectionChannel, HarnessPromptLayerId[]>>;
  precedence_order: AgentPromptSectionPrecedence[];
  cacheable_system_prompt: string;
  volatile_system_prompt: string;
  cacheable_fingerprint: string;
  volatile_fingerprint: string | null;
  full_system_prompt_fingerprint: string;
}

const AGENT_PROMPT_SECTION_PRECEDENCE_ORDER: AgentPromptSectionPrecedence[] = [
  "base_runtime",
  "session_policy",
  "capability_policy",
  "runtime_context",
  "workspace_policy",
  "harness_addendum",
  "agent_override",
  "emergency_override",
];

const COMPATIBILITY_CONTEXT_CHANNELS = new Set<AgentPromptSectionChannel>([
  "context_message",
  "attachment",
]);

function normalizedContent(content: string): string {
  return content.trim();
}

function precedenceRank(value: AgentPromptSectionPrecedence): number {
  const index = AGENT_PROMPT_SECTION_PRECEDENCE_ORDER.indexOf(value);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

export function sortAgentPromptSections(
  sections: AgentPromptSection[]
): AgentPromptSection[] {
  return [...sections].sort((left, right) => {
    const precedenceDiff = precedenceRank(left.precedence) - precedenceRank(right.precedence);
    if (precedenceDiff !== 0) {
      return precedenceDiff;
    }
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }
    if (left.apply_at !== right.apply_at) {
      return left.apply_at.localeCompare(right.apply_at);
    }
    if (left.channel !== right.channel) {
      return left.channel.localeCompare(right.channel);
    }
    return left.id.localeCompare(right.id);
  });
}

export function normalizeAgentPromptSection(
  section: AgentPromptSection | null
): AgentPromptSection | null {
  if (!section) {
    return null;
  }
  const content = normalizedContent(section.content);
  if (!content) {
    return null;
  }
  return {
    ...section,
    content,
  };
}

export function collectAgentPromptSections(
  sections: Array<AgentPromptSection | null>
): AgentPromptSection[] {
  return sortAgentPromptSections(
    sections
      .map((section) => normalizeAgentPromptSection(section))
      .filter((section): section is AgentPromptSection => section !== null)
  );
}

export function renderAgentPromptSections(
  sections: AgentPromptSection[],
  channel: AgentPromptSectionChannel
): string {
  return sortAgentPromptSections(sections)
    .filter((section) => section.channel === channel)
    .map((section) => section.content)
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function collectPromptSectionContents(
  sections: AgentPromptSection[],
  channel: AgentPromptSectionChannel
): string[] {
  return sortAgentPromptSections(sections)
    .filter((section) => section.channel === channel)
    .map((section) => section.content)
    .filter(Boolean);
}

export function collectPromptChannelContents(
  sections: AgentPromptSection[]
): AgentPromptChannelContents {
  const sortedSections = sortAgentPromptSections(sections);
  const contents: AgentPromptChannelContents = {};
  for (const section of sortedSections) {
    contents[section.channel] ??= [];
    contents[section.channel]?.push(section.content);
  }
  return contents;
}

export function collectCompatibleContextMessageContents(
  sections: AgentPromptSection[]
): string[] {
  return sortAgentPromptSections(sections)
    .filter((section) => COMPATIBILITY_CONTEXT_CHANNELS.has(section.channel))
    .map((section) => section.content)
    .filter(Boolean);
}

export function projectPromptLayersFromSections(
  sections: AgentPromptSection[]
): HarnessPromptLayerPayload[] {
  return sortAgentPromptSections(sections)
    .filter((section) => section.channel === "system_prompt")
    .map((section) => ({
      id: section.id,
      apply_at: section.apply_at,
      content: section.content,
    }));
}

function fingerprintText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function buildPromptCacheProfileFromSections(
  sections: AgentPromptSection[]
): AgentPromptCacheProfile {
  const sortedSections = sortAgentPromptSections(sections);
  const normalized = sortedSections.filter((section) => section.channel === "system_prompt");
  const cacheableSections = normalized.filter((section) => section.volatility !== "run");
  const volatileSections = normalized.filter((section) => section.volatility === "run");
  const channelSectionIds = sortedSections.reduce<Partial<Record<AgentPromptSectionChannel, HarnessPromptLayerId[]>>>(
    (result, section) => {
      result[section.channel] ??= [];
      result[section.channel]?.push(section.id);
      return result;
    },
    {}
  );
  const contextMessageIds = channelSectionIds.context_message ?? [];
  const attachmentIds = channelSectionIds.attachment ?? [];
  const compatibilityContextIds = sortedSections
    .filter((section) => COMPATIBILITY_CONTEXT_CHANNELS.has(section.channel))
    .map((section) => section.id);
  const cacheableSystemPrompt = renderAgentPromptSections(cacheableSections, "system_prompt");
  const volatileSystemPrompt = renderAgentPromptSections(volatileSections, "system_prompt");
  const fullSystemPrompt = renderAgentPromptSections(normalized, "system_prompt");
  return {
    cacheable_section_ids: cacheableSections.map((section) => section.id),
    volatile_section_ids: volatileSections.map((section) => section.id),
    context_message_ids: contextMessageIds,
    resume_context_ids: [],
    attachment_ids: attachmentIds,
    compatibility_context_ids: compatibilityContextIds,
    delta_section_ids: compatibilityContextIds,
    channel_section_ids: channelSectionIds,
    precedence_order: [...AGENT_PROMPT_SECTION_PRECEDENCE_ORDER],
    cacheable_system_prompt: cacheableSystemPrompt,
    volatile_system_prompt: volatileSystemPrompt,
    cacheable_fingerprint: fingerprintText(cacheableSystemPrompt),
    volatile_fingerprint: volatileSystemPrompt ? fingerprintText(volatileSystemPrompt) : null,
    full_system_prompt_fingerprint: fingerprintText(fullSystemPrompt),
  };
}
