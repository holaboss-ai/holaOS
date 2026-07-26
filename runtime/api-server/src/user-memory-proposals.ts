import type {
  MemoryUpdateProposalKind,
  MemoryUpdateProposalRecord,
  RuntimeUserProfileNameSource,
} from "@holaboss/runtime-state-store";

import type { AgentPendingUserMemoryContext } from "./agent-runtime-prompt.js";
import { governanceRuleForMemoryType } from "./memory-governance.js";
import {
  detectExplicitResponseStylePreference,
  type DurableMemoryCandidate,
} from "./turn-memory-writeback.js";

export interface DetectedMemoryUpdateProposal {
  proposalKind: MemoryUpdateProposalKind;
  targetKey: string;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  evidence: string | null;
  confidence: number | null;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clippedText(value: string, maxChars: number): string {
  const normalized = compactWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function nonEmptyText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function summaryOverride(summary: string | null | undefined, fallback: string): string {
  const normalized = nonEmptyText(summary);
  return normalized || fallback;
}

function detectFileDeliveryPreference(messageText: string): DetectedMemoryUpdateProposal | null {
  const normalized = compactWhitespace(messageText);
  if (!normalized) {
    return null;
  }

  const avoidsArchive = /\b(?:do not|don't|dont|never)\s+(?:compress|zip|archive)\b/i.test(normalized);
  const prefersIndividualFiles =
    /\b(?:deliver|send|provide|attach|share)\b[\w\s,'"()-]{0,80}\b(?:individually|separately|one by one)\b/i.test(normalized) ||
    /\b(?:individual|separate)\s+(?:files|attachments|text files|documents)\b/i.test(normalized) ||
    /\binstead of\s+(?:a|one)?\s*(?:zip|archive)\b/i.test(normalized);

  if (!avoidsArchive && !prefersIndividualFiles) {
    return null;
  }
  if (!(avoidsArchive && prefersIndividualFiles)) {
    return null;
  }

  return {
    proposalKind: "preference",
    targetKey: "file-delivery",
    title: "File delivery preference",
    summary: "Do not compress or zip multiple files; deliver them individually.",
    payload: {
      preference_type: "file_delivery",
      mode: "individual_files",
      avoid_archive: true,
      avoid_zip: true,
    },
    evidence: clippedText(normalized, 220),
    confidence: 0.97,
  };
}

export function buildMemoryUpdateProposalsFromUserInput(messageText: string): DetectedMemoryUpdateProposal[] {
  const proposals: DetectedMemoryUpdateProposal[] = [];
  const responseStyle = detectExplicitResponseStylePreference(messageText);
  if (responseStyle) {
    proposals.push({
      proposalKind: "preference",
      targetKey: "response-style",
      title: "Response style preference",
      summary: `Prefer ${responseStyle.style} responses.`,
      payload: {
        preference_type: "response_style",
        style: responseStyle.style,
      },
      evidence: responseStyle.evidence,
      confidence: 0.99,
    });
  }
  const fileDelivery = detectFileDeliveryPreference(messageText);
  if (fileDelivery) {
    proposals.push(fileDelivery);
  }
  return proposals;
}

export function pendingUserMemoryContextFromProposals(
  proposals: MemoryUpdateProposalRecord[]
): AgentPendingUserMemoryContext | null {
  const entries = proposals
    .filter((proposal) => proposal.state === "pending")
    .map((proposal) => ({
      proposal_id: proposal.proposalId,
      proposal_kind: proposal.proposalKind,
      target_key: proposal.targetKey,
      title: proposal.title,
      summary: proposal.summary,
      confidence: proposal.confidence,
      evidence: proposal.evidence,
    }));
  if (entries.length === 0) {
    return null;
  }
  return {
    entries,
  };
}

function responseStyleMemoryCandidate(params: {
  proposal: MemoryUpdateProposalRecord;
  summary: string;
  acceptedAt: string;
}): DurableMemoryCandidate | null {
  const style = nonEmptyText(params.proposal.payload.style);
  if (!style) {
    return null;
  }
  const governance = governanceRuleForMemoryType("preference");
  const lines = [
    "# User Response Style Preference",
    "",
    `- Preference: \`${style}\``,
    `- Session ID: \`${params.proposal.sessionId}\``,
    `- Source message ID: ${params.proposal.sourceMessageId ? `\`${params.proposal.sourceMessageId}\`` : "unknown"}`,
    `- Updated at: ${params.acceptedAt}`,
    "",
    "## Summary",
    "",
    params.summary,
    "",
    "## Evidence",
    "",
    params.proposal.evidence ?? params.summary,
  ];
  return {
    memoryId: "user-preference:response-style",
    scope: "user",
    memoryType: "preference",
    subjectKey: "response-style",
    path: "preference/response-style.md",
    title: "User response style",
    summary: params.summary,
    content: `${lines.join("\n").trim()}\n`,
    tags: ["response-style", style],
    verificationPolicy: governance.verificationPolicy,
    stalenessPolicy: governance.stalenessPolicy,
    staleAfterSeconds: governance.staleAfterSeconds,
    sourceMessageId: params.proposal.sourceMessageId,
    sourceType: "session_message",
    observedAt: params.proposal.createdAt,
    lastVerifiedAt: params.acceptedAt,
    confidence: params.proposal.confidence,
  };
}

function fileDeliveryMemoryCandidate(params: {
  proposal: MemoryUpdateProposalRecord;
  summary: string;
  acceptedAt: string;
}): DurableMemoryCandidate {
  const governance = governanceRuleForMemoryType("preference");
  const lines = [
    "# User File Delivery Preference",
    "",
    "- Preference: `deliver_individual_files`",
    `- Session ID: \`${params.proposal.sessionId}\``,
    `- Source message ID: ${params.proposal.sourceMessageId ? `\`${params.proposal.sourceMessageId}\`` : "unknown"}`,
    `- Updated at: ${params.acceptedAt}`,
    "",
    "## Summary",
    "",
    params.summary,
    "",
    "## Evidence",
    "",
    params.proposal.evidence ?? params.summary,
  ];
  return {
    memoryId: "user-preference:file-delivery",
    scope: "user",
    memoryType: "preference",
    subjectKey: "file-delivery",
    path: "preference/file-delivery.md",
    title: "User file delivery",
    summary: params.summary,
    content: `${lines.join("\n").trim()}\n`,
    tags: ["file-delivery", "individual-files", "no-zip"],
    verificationPolicy: governance.verificationPolicy,
    stalenessPolicy: governance.stalenessPolicy,
    staleAfterSeconds: governance.staleAfterSeconds,
    sourceMessageId: params.proposal.sourceMessageId,
    sourceType: "session_message",
    observedAt: params.proposal.createdAt,
    lastVerifiedAt: params.acceptedAt,
    confidence: params.proposal.confidence,
  };
}

export function durableMemoryCandidateFromAcceptedProposal(params: {
  proposal: MemoryUpdateProposalRecord;
  summary?: string | null;
  acceptedAt: string;
}): DurableMemoryCandidate | null {
  if (params.proposal.proposalKind !== "preference") {
    return null;
  }
  const summary = summaryOverride(params.summary, params.proposal.summary);
  switch (params.proposal.targetKey) {
    case "response-style":
      return responseStyleMemoryCandidate({
        proposal: params.proposal,
        summary,
        acceptedAt: params.acceptedAt,
      });
    case "file-delivery":
      return fileDeliveryMemoryCandidate({
        proposal: params.proposal,
        summary,
        acceptedAt: params.acceptedAt,
      });
    default:
      return null;
  }
}

export function runtimeUserProfileUpdateFromAcceptedProposal(params: {
  proposal: MemoryUpdateProposalRecord;
}): {
  profileId: string;
  name: string | null;
  nameSource: RuntimeUserProfileNameSource;
} | null {
  if (params.proposal.proposalKind !== "profile") {
    return null;
  }
  const field = nonEmptyText(params.proposal.payload.field);
  if (field !== "name") {
    return null;
  }
  const value = summaryOverride(nonEmptyText(params.proposal.payload.value), params.proposal.summary);
  return {
    profileId: "default",
    name: value || null,
    nameSource: "agent",
  };
}
