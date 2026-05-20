import { createHash } from "node:crypto";

import type {
  MemoryEntryScope,
  MemoryEntrySourceType,
  MemoryEntryType,
  MemoryStalenessPolicy,
  MemoryVerificationPolicy,
  RuntimeStateStore,
  SessionMessageRecord,
  TurnResultRecord,
} from "@holaboss/runtime-state-store";

import type { MemoryServiceLike } from "./memory.js";
import {
  persistInteractionCandidate,
  rebuildAllInteractionTrees,
  rebuildInteractionEntityTree,
} from "./interaction-memory.js";
import { governanceRuleForMemoryType } from "./memory-governance.js";
import {
  assistantTextFromTurnArtifacts,
  compactedSummaryFromTurnArtifacts,
  latestUserMessageForSessionMessages,
  permissionDenialsFromTurnArtifacts,
  recentUserMessagesForTurn,
} from "./turn-semantic-artifacts.js";
import {
  extractDurableMemoryCandidatesFromModel,
  type DurableMemoryExtractionContext,
  type ExtractedDurableMemoryCandidate,
} from "./memory-writeback-extractor.js";
import type { MemoryModelClientConfig } from "./memory-model-client.js";
import { createRecallEmbeddingModelClient } from "./recall-embedding-model.js";

export interface DurableMemoryCandidate {
  memoryId: string;
  scope: Extract<MemoryEntryScope, "workspace" | "user">;
  memoryType: MemoryEntryType;
  subjectKey: string;
  path: string;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  verificationPolicy: MemoryVerificationPolicy;
  stalenessPolicy: MemoryStalenessPolicy;
  staleAfterSeconds: number | null;
  sourceMessageId?: string | null;
  sourceType: MemoryEntrySourceType;
  observedAt: string | null;
  lastVerifiedAt: string | null;
  confidence: number | null;
}

interface ModelDurableCandidate {
  extractedCandidate: ExtractedDurableMemoryCandidate;
  durableCandidate: DurableMemoryCandidate;
}

interface TurnWritebackContext {
  assistantText: string;
  compactedSummary: string | null;
  currentPermissionDenials: Array<Record<string, unknown>>;
  recentTurnPermissionDenials: Array<Array<Record<string, unknown>>>;
  recentTurnSummaries: string[];
  turnResult: TurnResultRecord;
  recentUserMessages: SessionMessageRecord[];
  completedTurnCount: number;
}

export interface TurnMemoryWritebackModelContext {
  modelClient?: MemoryModelClientConfig | null;
  instruction?: string | null;
}

const RECENT_TURNS_LIMIT = 5;
const RECENT_USER_MESSAGES_LIMIT = 6;
const MODEL_EXTRACTION_INTERVAL_TURNS = 5;
const MODEL_EXTRACTION_MIN_CONFIDENCE = 0.82;
const MODEL_EXTRACTION_MIN_CONFIDENCE_CORROBORATED = 0.6;
const MODEL_EXTRACTION_MIN_EVIDENCE_CHARS = 36;
const MODEL_EXTRACTION_MIN_EVIDENCE_CHARS_CORROBORATED = 16;

function safePathSegment(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function blockerKey(toolName: string, toolId: string | null, reason: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ toolName, toolId, reason }))
    .digest("hex")
    .slice(0, 16);
}

function titleCase(value: string): string {
  const normalized = compactWhitespace(value);
  if (!normalized) {
    return value;
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function repeatedPermissionKnowledgePath(
  turnResult: TurnResultRecord,
  toolName: string,
  toolId: string | null,
  reason: string
): string {
  const key = blockerKey(toolName, toolId, reason);
  return `workspace/${turnResult.workspaceId}/knowledge/blockers/permission-${key}.md`;
}

function workspaceCommandFactPath(turnResult: TurnResultRecord, purpose: WorkspaceCommandPurpose): string {
  return `workspace/${turnResult.workspaceId}/knowledge/facts/${safePathSegment(purpose, "command")}-command.md`;
}

function workspaceBusinessFactPath(turnResult: TurnResultRecord, slug: string): string {
  return `workspace/${turnResult.workspaceId}/knowledge/facts/${safePathSegment(slug, "fact")}.md`;
}

function workspaceProcedurePath(turnResult: TurnResultRecord, subject: WorkspaceProcedureSubject): string {
  return `workspace/${turnResult.workspaceId}/knowledge/procedures/${safePathSegment(subject, "procedure")}-procedure.md`;
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

function shouldRunModelExtractionForTurnCount(completedTurnCount: number): boolean {
  return completedTurnCount > 0 && completedTurnCount % MODEL_EXTRACTION_INTERVAL_TURNS === 0;
}

export interface ResponseStylePreference {
  style: "concise" | "detailed";
  evidence: string;
};

type MemorySourceEvidence = {
  text: string;
  sourceLabel: string;
  sourceType: MemoryEntrySourceType;
  observedAt: string | null;
  sourceMessageId?: string | null;
};

type WorkspaceCommandPurpose = "verification" | "build" | "development" | "deploy" | "release";

type WorkspaceProcedureSubject =
  | "verification"
  | "build"
  | "deploy"
  | "release"
  | "onboarding"
  | "approval"
  | "reporting"
  | "follow-up"
  | "handoff"
  | "escalation"
  | "review";

type WorkspaceCommandFact = {
  purpose: WorkspaceCommandPurpose;
  label: string;
  command: string;
  evidence: string;
};

type WorkspaceBusinessFact = {
  slug: string;
  title: string;
  summary: string;
  evidence: string;
  tags: string[];
};

type WorkspaceProcedure = {
  subject: WorkspaceProcedureSubject;
  label: string;
  steps: string[];
  evidence: string;
};

export function detectExplicitResponseStylePreference(messageText: string): ResponseStylePreference | null {
  const normalized = compactWhitespace(messageText);
  if (!normalized) {
    return null;
  }

  const concisePatterns = [
    /\bprefer\s+(?:responses?|answers?|replies)\s+(?:to be\s+)?(?:concise|brief|short)\b/i,
    /\b(?:keep|make)\s+(?:your\s+)?(?:responses?|answers?|replies)\s+(?:concise|brief|short)\b/i,
    /\b(?:be|stay)\s+(?:concise|brief|short)\b/i,
  ];
  for (const pattern of concisePatterns) {
    if (pattern.test(normalized)) {
      return {
        style: "concise",
        evidence: clippedText(normalized, 220),
      };
    }
  }

  const detailedPatterns = [
    /\bprefer\s+(?:responses?|answers?|replies)\s+(?:to be\s+)?(?:detailed|thorough|comprehensive|in-depth)\b/i,
    /\b(?:keep|make)\s+(?:your\s+)?(?:responses?|answers?|replies)\s+(?:detailed|thorough|comprehensive|in-depth)\b/i,
    /\b(?:be|stay)\s+(?:detailed|thorough|comprehensive)\b/i,
  ];
  for (const pattern of detailedPatterns) {
    if (pattern.test(normalized)) {
      return {
        style: "detailed",
        evidence: clippedText(normalized, 220),
      };
    }
  }

  return null;
}

function durableMemorySources(
  turnResult: TurnResultRecord,
  sessionMessages: SessionMessageRecord[],
  assistantText: string,
): MemorySourceEvidence[] {
  const sources: MemorySourceEvidence[] = [];
  const message = latestUserMessageForSessionMessages(sessionMessages);
  if (message) {
    sources.push({
      text: message.text,
      sourceLabel: "latest user message",
      sourceType: "session_message",
      observedAt: message.createdAt,
      sourceMessageId: message.id,
    });
  }
  if (compactWhitespace(assistantText)) {
    sources.push({
      text: assistantText,
      sourceLabel: "latest assistant turn",
      sourceType: "assistant_turn",
      observedAt: turnResult.completedAt ?? turnResult.updatedAt,
      sourceMessageId: null,
    });
  }
  return sources;
}

function workspaceCommandDefinitions(): Array<{
  purpose: WorkspaceCommandPurpose;
  label: string;
  patterns: RegExp[];
}> {
  return [
    {
      purpose: "verification",
      label: "verification",
      patterns: [
        /\b(?:main|default|primary|preferred|recommended|standard|canonical)\s+(?:verification|test(?:ing)?)\s+command\s+(?:is|:)\s*`([^`]+)`/i,
        /\b(?:for|during)\s+(?:verification|tests?|testing)[,:]?\s*(?:use|run)\s*`([^`]+)`/i,
        /\buse\s*`([^`]+)`\s*(?:for|to)\s+(?:verify|verification|run tests?|testing)\b/i,
      ],
    },
    {
      purpose: "build",
      label: "build",
      patterns: [
        /\b(?:main|default|primary|preferred|recommended|standard|canonical)\s+build\s+command\s+(?:is|:)\s*`([^`]+)`/i,
        /\b(?:for|during)\s+build(?:ing)?[,:]?\s*(?:use|run)\s*`([^`]+)`/i,
        /\buse\s*`([^`]+)`\s*(?:for|to)\s+build\b/i,
      ],
    },
    {
      purpose: "development",
      label: "development",
      patterns: [
        /\b(?:main|default|primary|preferred|recommended|standard|canonical)\s+(?:development|dev|start)\s+command\s+(?:is|:)\s*`([^`]+)`/i,
        /\b(?:for|during)\s+(?:development|dev|local development)[,:]?\s*(?:use|run)\s*`([^`]+)`/i,
        /\buse\s*`([^`]+)`\s*(?:for|to)\s+(?:start|run)\s+(?:the app|development|dev)\b/i,
      ],
    },
    {
      purpose: "deploy",
      label: "deployment",
      patterns: [
        /\b(?:main|default|primary|preferred|recommended|standard|canonical)\s+deploy(?:ment)?\s+command\s+(?:is|:)\s*`([^`]+)`/i,
        /\b(?:for|during)\s+deploy(?:ment)?[,:]?\s*(?:use|run)\s*`([^`]+)`/i,
        /\buse\s*`([^`]+)`\s*(?:for|to)\s+deploy\b/i,
      ],
    },
    {
      purpose: "release",
      label: "release",
      patterns: [
        /\b(?:main|default|primary|preferred|recommended|standard|canonical)\s+release\s+command\s+(?:is|:)\s*`([^`]+)`/i,
        /\b(?:for|during)\s+release(?:s)?[,:]?\s*(?:use|run)\s*`([^`]+)`/i,
        /\buse\s*`([^`]+)`\s*(?:for|to)\s+release\b/i,
      ],
    },
  ];
}

function detectWorkspaceCommandFacts(messageText: string): WorkspaceCommandFact[] {
  const normalized = compactWhitespace(messageText);
  if (!normalized) {
    return [];
  }
  return workspaceCommandDefinitions().flatMap((definition) => {
    for (const pattern of definition.patterns) {
      const match = normalized.match(pattern);
      const command = typeof match?.[1] === "string" ? compactWhitespace(match[1]) : "";
      if (command) {
        return [
          {
            purpose: definition.purpose,
            label: definition.label,
            command,
            evidence: clippedText(normalized, 240),
          },
        ];
      }
    }
    return [];
  });
}

function detectWorkspaceBusinessFacts(messageText: string): WorkspaceBusinessFact[] {
  const normalized = compactWhitespace(messageText);
  if (!normalized) {
    return [];
  }
  const facts: WorkspaceBusinessFact[] = [];
  const seen = new Set<string>();

  const cadenceMatch = normalized.match(
    /\b(weekly|daily|monthly|quarterly)\s+([a-z][a-z0-9 /-]+?)\s+(?:is|happens|runs|occurs)\s+([^.!?\n]+)\.?/i
  );
  if (cadenceMatch) {
    const cadence = compactWhitespace(cadenceMatch[1] ?? "");
    const subject = compactWhitespace(cadenceMatch[2] ?? "");
    const schedule = compactWhitespace(cadenceMatch[3] ?? "");
    if (cadence && subject && schedule) {
      const slug = `${safePathSegment(subject.toLowerCase(), "cadence")}-cadence`;
      const summary = `${clippedText(cadenceMatch[0].replace(/[.]+$/, ""), 220)}.`;
      seen.add(slug);
      facts.push({
        slug,
        title: `${titleCase(subject)} cadence`,
        summary,
        evidence: clippedText(cadenceMatch[0], 240),
        tags: ["cadence", cadence, ...subject.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)],
      });
    }
  }

  const approvalMatch = normalized.match(
    /\b([a-z0-9$][a-z0-9$,% /-]{2,}?)\s+require(?:s)?\s+([a-z][a-z0-9 /-]+?)\s+approval\b/i
  );
  if (approvalMatch) {
    const subject = compactWhitespace(approvalMatch[1] ?? "");
    const approver = compactWhitespace(approvalMatch[2] ?? "");
    if (subject && approver) {
      const slug = `${safePathSegment(subject.toLowerCase(), "approval")}-approval-rule`;
      if (!seen.has(slug)) {
        const summary = `${clippedText(approvalMatch[0].replace(/[.]+$/, ""), 220)} in this workspace.`;
        facts.push({
          slug,
          title: `${titleCase(approver)} approval rule`,
          summary: titleCase(summary),
          evidence: clippedText(approvalMatch[0], 240),
          tags: [
            "approval",
            approver.toLowerCase(),
            ...subject.toLowerCase().split(/[^a-z0-9$]+/).filter(Boolean),
          ],
        });
      }
    }
  }

  return facts;
}

function detectWorkspaceProcedure(messageText: string): WorkspaceProcedure[] {
  if (!messageText.trim()) {
    return [];
  }
  const lines = messageText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return [];
  }
  const numberedOrBulletedSteps = lines
    .filter((line) => /^\d+\.\s+/.test(line) || /^-\s+/.test(line))
    .map((line) => line.replace(/^(?:\d+\.\s+|-\s+)/, "").trim())
    .filter((line) => line.length > 0);
  if (numberedOrBulletedSteps.length < 2) {
    return [];
  }
  const fullText = lines.join("\n");
  const subjectMatchers: Array<{ subject: WorkspaceProcedureSubject; label: string; pattern: RegExp }> = [
    { subject: "verification", label: "verification", pattern: /\bverification\s+(?:procedure|process|workflow|steps)\b/i },
    { subject: "build", label: "build", pattern: /\bbuild\s+(?:procedure|process|workflow|steps)\b/i },
    { subject: "deploy", label: "deployment", pattern: /\bdeploy(?:ment)?\s+(?:procedure|process|workflow|steps)\b/i },
    { subject: "release", label: "release", pattern: /\brelease\s+(?:procedure|process|workflow|steps)\b/i },
    { subject: "onboarding", label: "onboarding", pattern: /\bonboarding\s+(?:procedure|process|workflow|steps)\b/i },
    { subject: "approval", label: "approval", pattern: /\bapproval\s+(?:procedure|process|workflow|steps)\b/i },
    { subject: "reporting", label: "reporting", pattern: /\breport(?:ing)?\s+(?:procedure|process|workflow|steps)\b/i },
    { subject: "follow-up", label: "follow-up", pattern: /\bfollow[- ]?up\s+(?:procedure|process|workflow|steps)\b/i },
    { subject: "handoff", label: "handoff", pattern: /\b(?:handoff|handover)\s+(?:procedure|process|workflow|steps)\b/i },
    { subject: "escalation", label: "escalation", pattern: /\bescalation\s+(?:procedure|process|workflow|steps)\b/i },
    { subject: "review", label: "review", pattern: /\b(?:review|sales review|weekly review|monthly review)\s+(?:procedure|process|workflow|steps)\b/i },
  ];
  for (const matcher of subjectMatchers) {
    if (matcher.pattern.test(fullText)) {
      return [
        {
          subject: matcher.subject,
          label: matcher.label,
          steps: numberedOrBulletedSteps.slice(0, 6),
          evidence: clippedText(compactWhitespace(fullText), 260),
        },
      ];
    }
  }
  return [];
}

function workspaceCommandFactCandidates(
  turnResult: TurnResultRecord,
  sessionMessages: SessionMessageRecord[],
  assistantText: string,
): DurableMemoryCandidate[] {
  const governance = governanceRuleForMemoryType("fact");
  const deduped = new Map<string, DurableMemoryCandidate>();
  for (const source of durableMemorySources(turnResult, sessionMessages, assistantText)) {
    for (const fact of detectWorkspaceCommandFacts(source.text)) {
      const summary = `Use \`${fact.command}\` for ${fact.label} in this workspace.`;
      const lines = [
        `# Workspace Fact: ${titleCase(fact.label)} Command`,
        "",
        `- Purpose: \`${fact.purpose}\``,
        `- Command: \`${fact.command}\``,
        `- Workspace ID: \`${turnResult.workspaceId}\``,
        `- Source: ${source.sourceLabel}`,
        `- Updated at: ${turnResult.completedAt ?? turnResult.updatedAt}`,
        "",
        "## Summary",
        "",
        summary,
        "",
        "## Evidence",
        "",
        fact.evidence,
      ];
      const memoryId = `workspace-fact:${turnResult.workspaceId}:command:${fact.purpose}`;
      if (!deduped.has(memoryId)) {
        deduped.set(memoryId, {
          memoryId,
          scope: "workspace",
          memoryType: "fact",
          subjectKey: `command:${fact.purpose}`,
          path: workspaceCommandFactPath(turnResult, fact.purpose),
          title: `${titleCase(fact.label)} command`,
          summary,
          content: `${lines.join("\n").trim()}\n`,
          tags: ["command", fact.purpose, fact.label],
          verificationPolicy: governance.verificationPolicy,
          stalenessPolicy: governance.stalenessPolicy,
          staleAfterSeconds: governance.staleAfterSeconds,
          sourceMessageId: source.sourceMessageId ?? null,
          sourceType: source.sourceType,
          observedAt: source.observedAt,
          lastVerifiedAt: source.observedAt,
          confidence: source.sourceType === "session_message" ? 0.94 : 0.88,
        });
      }
    }
  }
  return [...deduped.values()];
}

function workspaceBusinessFactCandidates(
  turnResult: TurnResultRecord,
  sessionMessages: SessionMessageRecord[],
  assistantText: string,
): DurableMemoryCandidate[] {
  const governance = governanceRuleForMemoryType("fact");
  const deduped = new Map<string, DurableMemoryCandidate>();
  for (const source of durableMemorySources(turnResult, sessionMessages, assistantText)) {
    for (const fact of detectWorkspaceBusinessFacts(source.text)) {
      const lines = [
        `# Workspace Fact: ${fact.title}`,
        "",
        `- Workspace ID: \`${turnResult.workspaceId}\``,
        `- Source: ${source.sourceLabel}`,
        `- Updated at: ${turnResult.completedAt ?? turnResult.updatedAt}`,
        "",
        "## Summary",
        "",
        fact.summary,
        "",
        "## Evidence",
        "",
        fact.evidence,
      ];
      const memoryId = `workspace-fact:${turnResult.workspaceId}:${fact.slug}`;
      if (!deduped.has(memoryId)) {
        deduped.set(memoryId, {
          memoryId,
          scope: "workspace",
          memoryType: "fact",
          subjectKey: `fact:${fact.slug}`,
          path: workspaceBusinessFactPath(turnResult, fact.slug),
          title: fact.title,
          summary: fact.summary,
          content: `${lines.join("\n").trim()}\n`,
          tags: [...fact.tags],
          verificationPolicy: governance.verificationPolicy,
          stalenessPolicy: governance.stalenessPolicy,
          staleAfterSeconds: governance.staleAfterSeconds,
          sourceMessageId: source.sourceMessageId ?? null,
          sourceType: source.sourceType,
          observedAt: source.observedAt,
          lastVerifiedAt: source.observedAt,
          confidence: source.sourceType === "session_message" ? 0.91 : 0.85,
        });
      }
    }
  }
  return [...deduped.values()];
}

function workspaceProcedureCandidates(
  turnResult: TurnResultRecord,
  sessionMessages: SessionMessageRecord[],
  assistantText: string,
): DurableMemoryCandidate[] {
  const governance = governanceRuleForMemoryType("procedure");
  const deduped = new Map<string, DurableMemoryCandidate>();
  for (const source of durableMemorySources(turnResult, sessionMessages, assistantText)) {
    for (const procedure of detectWorkspaceProcedure(source.text)) {
      const summary = `${titleCase(procedure.label)} procedure for this workspace.`;
      const lines = [
        `# Workspace Procedure: ${titleCase(procedure.label)}`,
        "",
        `- Procedure: \`${procedure.subject}\``,
        `- Workspace ID: \`${turnResult.workspaceId}\``,
        `- Source: ${source.sourceLabel}`,
        `- Updated at: ${turnResult.completedAt ?? turnResult.updatedAt}`,
        "",
        "## Summary",
        "",
        summary,
        "",
        "## Steps",
        "",
        ...procedure.steps.map((step, index) => `${index + 1}. ${step}`),
        "",
        "## Evidence",
        "",
        procedure.evidence,
      ];
      const memoryId = `workspace-procedure:${turnResult.workspaceId}:${procedure.subject}`;
      if (!deduped.has(memoryId)) {
        deduped.set(memoryId, {
          memoryId,
          scope: "workspace",
          memoryType: "procedure",
          subjectKey: `procedure:${procedure.subject}`,
          path: workspaceProcedurePath(turnResult, procedure.subject),
          title: `${titleCase(procedure.label)} procedure`,
          summary,
          content: `${lines.join("\n").trim()}\n`,
          tags: ["procedure", procedure.subject, procedure.label],
          verificationPolicy: governance.verificationPolicy,
          stalenessPolicy: governance.stalenessPolicy,
          staleAfterSeconds: governance.staleAfterSeconds,
          sourceMessageId: source.sourceMessageId ?? null,
          sourceType: source.sourceType,
          observedAt: source.observedAt,
          lastVerifiedAt: source.observedAt,
          confidence: source.sourceType === "session_message" ? 0.93 : 0.87,
        });
      }
    }
  }
  return [...deduped.values()];
}

function repeatedPermissionBlockerCandidates(params: {
  currentPermissionDenials: Array<Record<string, unknown>>;
  recentTurnPermissionDenials: Array<Array<Record<string, unknown>>>;
  turnResult: TurnResultRecord;
  summary: string | null;
}): DurableMemoryCandidate[] {
  const governance = governanceRuleForMemoryType("blocker");
  return params.currentPermissionDenials.flatMap((denial) => {
    const toolName = typeof denial.tool_name === "string" && denial.tool_name.trim() ? denial.tool_name.trim() : "unknown";
    const toolId = typeof denial.tool_id === "string" && denial.tool_id.trim() ? denial.tool_id.trim() : null;
    const reason = typeof denial.reason === "string" && denial.reason.trim() ? denial.reason.trim() : "permission denied";
    const recurrenceCount = params.recentTurnPermissionDenials.flatMap((denials) => denials).filter((candidate) => {
      const candidateToolName =
        typeof candidate.tool_name === "string" && candidate.tool_name.trim() ? candidate.tool_name.trim() : "unknown";
      const candidateToolId =
        typeof candidate.tool_id === "string" && candidate.tool_id.trim() ? candidate.tool_id.trim() : null;
      const candidateReason =
        typeof candidate.reason === "string" && candidate.reason.trim() ? candidate.reason.trim() : "permission denied";
      return candidateToolName === toolName && candidateToolId === toolId && candidateReason === reason;
    }).length;

    if (recurrenceCount < 2) {
      return [];
    }

    const summary =
      `${toolName}${toolId ? ` (\`${toolId}\`)` : ""} may be denied by workspace policy. Seen ${recurrenceCount} times in recent turns.`;
    const lines = [
      "# Workspace Knowledge: Recurring Permission Blocker",
      "",
      `- Tool: \`${toolName}\``,
      `- Tool ID: ${toolId ? `\`${toolId}\`` : "none"}`,
      `- Reason: ${reason}`,
      `- Workspace ID: \`${params.turnResult.workspaceId}\``,
      `- Last seen: ${params.turnResult.completedAt ?? params.turnResult.updatedAt}`,
      `- Recent recurrence count: ${recurrenceCount}`,
      "",
      "## Summary",
      "",
      summary,
      "",
      "## Latest Turn Summary",
      "",
      params.summary ?? "No compact summary available.",
    ];
    const key = blockerKey(toolName, toolId, reason);
    return [
      {
        memoryId: `workspace-blocker:${params.turnResult.workspaceId}:${key}`,
        scope: "workspace",
        memoryType: "blocker",
        subjectKey: `permission:${key}`,
        path: repeatedPermissionKnowledgePath(params.turnResult, toolName, toolId, reason),
        title: `${titleCase(toolName)} permission blocker`,
        summary,
        content: `${lines.join("\n").trim()}\n`,
        tags: ["permission", "blocker", toolName, ...(toolId ? [toolId] : [])],
        verificationPolicy: governance.verificationPolicy,
        stalenessPolicy: governance.stalenessPolicy,
        staleAfterSeconds: governance.staleAfterSeconds,
        sourceType: "permission_denial",
        observedAt: params.turnResult.completedAt ?? params.turnResult.updatedAt,
        lastVerifiedAt: params.turnResult.completedAt ?? params.turnResult.updatedAt,
        confidence: 0.92,
      },
    ];
  });
}

function extractedMemoryPath(turnResult: TurnResultRecord, candidate: ExtractedDurableMemoryCandidate): string {
  const subjectToken = safePathSegment(candidate.subjectKey, "memory");
  if (candidate.scope === "user") {
    if (candidate.memoryType === "identity") {
      return `identity/${subjectToken}.md`;
    }
    return `preference/${subjectToken}.md`;
  }
  switch (candidate.memoryType) {
    case "procedure":
      return `workspace/${turnResult.workspaceId}/knowledge/procedures/${subjectToken}-procedure.md`;
    case "blocker":
      return `workspace/${turnResult.workspaceId}/knowledge/blockers/${subjectToken}.md`;
    case "reference":
      return `workspace/${turnResult.workspaceId}/knowledge/reference/${subjectToken}.md`;
    default:
      return `workspace/${turnResult.workspaceId}/knowledge/facts/${subjectToken}.md`;
  }
}

function extractedMemoryContent(params: {
  turnResult: TurnResultRecord;
  candidate: ExtractedDurableMemoryCandidate;
}): string {
  const lines = [
    `# ${params.candidate.title}`,
    "",
    `- Scope: \`${params.candidate.scope}\``,
    `- Type: \`${params.candidate.memoryType}\``,
    `- Subject: \`${params.candidate.subjectKey}\``,
    `- Workspace ID: \`${params.turnResult.workspaceId}\``,
    `- Session ID: \`${params.turnResult.sessionId}\``,
    `- Updated at: ${params.turnResult.completedAt ?? params.turnResult.updatedAt}`,
    "",
    "## Summary",
    "",
    params.candidate.summary,
  ];
  if (params.candidate.evidence) {
    lines.push("", "## Evidence", "", params.candidate.evidence);
  }
  return `${lines.join("\n").trim()}\n`;
}

function durableCandidateFromExtracted(params: {
  turnResult: TurnResultRecord;
  extracted: ExtractedDurableMemoryCandidate;
}): DurableMemoryCandidate {
  const governance = governanceRuleForMemoryType(params.extracted.memoryType);
  const pathValue = extractedMemoryPath(params.turnResult, params.extracted);
  const memoryId = `extracted:${createHash("sha256")
    .update(`${params.extracted.scope}:${params.extracted.memoryType}:${params.extracted.subjectKey}:${pathValue}`)
    .digest("hex")
    .slice(0, 24)}`;
  const observedAt = params.turnResult.completedAt ?? params.turnResult.updatedAt;
  return {
    memoryId,
    scope: params.extracted.scope,
    memoryType: params.extracted.memoryType,
    subjectKey: params.extracted.subjectKey,
    path: pathValue,
    title: params.extracted.title,
    summary: params.extracted.summary,
    content: extractedMemoryContent({
      turnResult: params.turnResult,
      candidate: params.extracted,
    }),
    tags: params.extracted.tags,
    verificationPolicy: governance.verificationPolicy,
    stalenessPolicy: governance.stalenessPolicy,
    staleAfterSeconds: governance.staleAfterSeconds,
    sourceType: "assistant_turn",
    observedAt,
    lastVerifiedAt: observedAt,
    confidence: params.extracted.confidence,
  };
}

async function extractedDurableMemoryCandidates(params: {
  turnResult: TurnResultRecord;
  assistantText: string;
  recentUserMessages: SessionMessageRecord[];
  recentTurnSummaries: string[];
  completedTurnCount: number;
  modelContext?: TurnMemoryWritebackModelContext | null;
}): Promise<ModelDurableCandidate[]> {
  if (!params.modelContext?.modelClient) {
    return [];
  }
  if (!shouldRunModelExtractionForTurnCount(params.completedTurnCount)) {
    return [];
  }
  const recentUserMessages = params.recentUserMessages
    .slice(-4)
    .map((message) => clippedText(message.text, 220));
  const extractionContext: DurableMemoryExtractionContext = {
    modelClient: params.modelContext.modelClient,
    workspaceId: params.turnResult.workspaceId,
    sessionId: params.turnResult.sessionId,
    inputId: params.turnResult.inputId,
    instruction: params.modelContext.instruction?.trim() || recentUserMessages[recentUserMessages.length - 1] || "",
    assistantText: clippedText(params.assistantText, 1400),
    recentUserMessages,
    recentTurnSummaries: params.recentTurnSummaries.slice(0, 4),
  };
  const extracted = await extractDurableMemoryCandidatesFromModel(extractionContext);
  return extracted.map((candidate) => ({
    extractedCandidate: candidate,
    durableCandidate: durableCandidateFromExtracted({
      turnResult: params.turnResult,
      extracted: candidate,
    }),
  }));
}

function hasHeuristicCorroboration(params: {
  turnResult: TurnResultRecord;
  extractedCandidate: ExtractedDurableMemoryCandidate;
  heuristicDurableCandidates: DurableMemoryCandidate[];
}): boolean {
  const extractedPath = extractedMemoryPath(params.turnResult, params.extractedCandidate);
  return params.heuristicDurableCandidates.some((candidate) => {
    if (candidate.path === extractedPath) {
      return true;
    }
    return (
      candidate.scope === params.extractedCandidate.scope &&
      candidate.memoryType === params.extractedCandidate.memoryType &&
      candidate.subjectKey === params.extractedCandidate.subjectKey
    );
  });
}

function acceptedModelDurableCandidates(params: {
  turnResult: TurnResultRecord;
  modelCandidates: ModelDurableCandidate[];
  heuristicDurableCandidates: DurableMemoryCandidate[];
}): DurableMemoryCandidate[] {
  const accepted: DurableMemoryCandidate[] = [];
  for (const modelCandidate of params.modelCandidates) {
    const corroborated = hasHeuristicCorroboration({
      turnResult: params.turnResult,
      extractedCandidate: modelCandidate.extractedCandidate,
      heuristicDurableCandidates: params.heuristicDurableCandidates,
    });
    const confidence = modelCandidate.extractedCandidate.confidence ?? -1;
    const evidenceChars = compactWhitespace(modelCandidate.extractedCandidate.evidence).length;
    const minConfidence = corroborated
      ? MODEL_EXTRACTION_MIN_CONFIDENCE_CORROBORATED
      : MODEL_EXTRACTION_MIN_CONFIDENCE;
    const minEvidenceChars = corroborated
      ? MODEL_EXTRACTION_MIN_EVIDENCE_CHARS_CORROBORATED
      : MODEL_EXTRACTION_MIN_EVIDENCE_CHARS;
    if (confidence < minConfidence || evidenceChars < minEvidenceChars) {
      continue;
    }
    if (modelCandidate.durableCandidate.scope === "user") {
      continue;
    }
    accepted.push(modelCandidate.durableCandidate);
  }
  return accepted;
}

function mergeDurableCandidates(
  primary: DurableMemoryCandidate[],
  secondary: DurableMemoryCandidate[]
): DurableMemoryCandidate[] {
  const byPath = new Map<string, DurableMemoryCandidate>();
  for (const candidate of primary) {
    byPath.set(candidate.path, candidate);
  }
  for (const candidate of secondary) {
    if (!byPath.has(candidate.path)) {
      byPath.set(candidate.path, candidate);
    }
  }
  return [...byPath.values()];
}

function buildDurableMemoryCandidates(params: {
  assistantText: string;
  currentPermissionDenials: Array<Record<string, unknown>>;
  recentTurnPermissionDenials: Array<Array<Record<string, unknown>>>;
  turnResult: TurnResultRecord;
  summary: string | null;
  sessionMessages: SessionMessageRecord[];
}): DurableMemoryCandidate[] {
  return [
    ...workspaceCommandFactCandidates(params.turnResult, params.sessionMessages, params.assistantText),
    ...workspaceBusinessFactCandidates(params.turnResult, params.sessionMessages, params.assistantText),
    ...workspaceProcedureCandidates(params.turnResult, params.sessionMessages, params.assistantText),
    ...repeatedPermissionBlockerCandidates({
      currentPermissionDenials: params.currentPermissionDenials,
      recentTurnPermissionDenials: params.recentTurnPermissionDenials,
      turnResult: params.turnResult,
      summary: params.summary,
    }),
  ];
}

function loadTurnWritebackContext(store: RuntimeStateStore, turnResult: TurnResultRecord): TurnWritebackContext {
  // Keep turn_results as a deterministic execution ledger. Any short summary
  // used by background writeback is ephemeral evidence, not persisted state.
  const assistantText = assistantTextFromTurnArtifacts(store, turnResult);
  const compactedSummary = compactedSummaryFromTurnArtifacts(store, turnResult);
  const recentTurns = store.listTurnResults({
    workspaceId: turnResult.workspaceId,
    sessionId: turnResult.sessionId,
    limit: RECENT_TURNS_LIMIT,
    offset: 0,
  });
  const recentUserMessages = recentUserMessagesForTurn(store, turnResult, RECENT_USER_MESSAGES_LIMIT);
  return {
    assistantText,
    compactedSummary,
    currentPermissionDenials: permissionDenialsFromTurnArtifacts(store, turnResult),
    recentTurnPermissionDenials: recentTurns.map((item) => permissionDenialsFromTurnArtifacts(store, item)),
    recentTurnSummaries: recentTurns
      .slice(0, 4)
      .map((item) => compactedSummaryFromTurnArtifacts(store, item))
      .filter((summary): summary is string => Boolean(summary)),
    turnResult,
    recentUserMessages,
    completedTurnCount: store.countTurnResults({
      workspaceId: turnResult.workspaceId,
      sessionId: turnResult.sessionId,
      status: "completed",
    }),
  };
}

export async function persistDurableMemoryCandidate(params: {
  store: RuntimeStateStore;
  memoryService: MemoryServiceLike;
  workspaceId: string;
  sessionId: string;
  inputId: string;
  candidate: DurableMemoryCandidate;
}): Promise<string> {
  void params.memoryService;
  const embeddingClient = createRecallEmbeddingModelClient({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    inputId: params.inputId,
  });
  const result = await persistInteractionCandidate({
    store: params.store,
    workspaceId: params.workspaceId,
    candidate: {
      subjectKey: params.candidate.subjectKey,
      title: params.candidate.title,
      summary: params.candidate.summary,
      content: params.candidate.content,
      tags: params.candidate.tags,
      memoryType: params.candidate.memoryType,
      sourceType: params.candidate.sourceType,
      sourceEventId: params.inputId,
      sourceMessageId: params.candidate.sourceMessageId ?? null,
      sourceTurnInputId: params.inputId,
      observedAt: params.candidate.observedAt ?? null,
      confidence: params.candidate.confidence ?? null,
    },
    modelClient: null,
    embeddingClient,
  });
  await rebuildInteractionEntityTree({
    store: params.store,
    workspaceId: params.workspaceId,
    entityId: result.entity.entityId,
    summaryModelClient: null,
    embeddingClient,
  });
  return result.leaf.path;
}

export async function refreshMemoryIndexes(params: {
  store: RuntimeStateStore;
  memoryService: MemoryServiceLike;
  workspaceId: string;
}): Promise<string[]> {
  void params.memoryService;
  await rebuildAllInteractionTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  return params.store
    .listInteractionSummaryNodes({
      workspaceId: params.workspaceId,
      status: "active",
      limit: 10_000,
      offset: 0,
    })
    .map((node) => node.path);
}

export async function writeTurnDurableMemory(params: {
  store: RuntimeStateStore;
  memoryService: MemoryServiceLike;
  turnResult: TurnResultRecord;
  modelContext?: TurnMemoryWritebackModelContext | null;
}): Promise<TurnResultRecord> {
  void params.memoryService;
  const context = loadTurnWritebackContext(params.store, params.turnResult);
  const heuristicDurableCandidates = buildDurableMemoryCandidates({
    assistantText: context.assistantText,
    currentPermissionDenials: context.currentPermissionDenials,
    recentTurnPermissionDenials: context.recentTurnPermissionDenials,
    turnResult: context.turnResult,
    summary: context.compactedSummary,
    sessionMessages: context.recentUserMessages,
  });
  const extractedCandidates = await extractedDurableMemoryCandidates({
    turnResult: context.turnResult,
    assistantText: context.assistantText,
    recentUserMessages: context.recentUserMessages,
    recentTurnSummaries: context.recentTurnSummaries,
    completedTurnCount: context.completedTurnCount,
    modelContext: params.modelContext ?? null,
  });
  const acceptedExtractedCandidates = acceptedModelDurableCandidates({
    turnResult: context.turnResult,
    modelCandidates: extractedCandidates,
    heuristicDurableCandidates,
  });
  const durableCandidates = mergeDurableCandidates(acceptedExtractedCandidates, heuristicDurableCandidates);
  if (durableCandidates.length === 0) {
    return (
      params.store.getTurnResult({
        workspaceId: context.turnResult.workspaceId,
        inputId: context.turnResult.inputId,
      }) ?? context.turnResult
    );
  }
  const embeddingClient = createRecallEmbeddingModelClient({
    workspaceId: context.turnResult.workspaceId,
    sessionId: context.turnResult.sessionId,
    inputId: context.turnResult.inputId,
  });
  const summaryModelClient = params.modelContext?.modelClient ?? null;
  const touchedEntityIds = new Set<string>();

  for (const candidate of durableCandidates) {
    const persisted = await persistInteractionCandidate({
      store: params.store,
      workspaceId: context.turnResult.workspaceId,
      candidate: {
        subjectKey: candidate.subjectKey,
        title: candidate.title,
        summary: candidate.summary,
        content: candidate.content,
        tags: candidate.tags,
        memoryType: candidate.memoryType,
        sourceType: candidate.sourceType,
        sourceEventId: context.turnResult.inputId,
        sourceMessageId: candidate.sourceMessageId ?? null,
        sourceTurnInputId: context.turnResult.inputId,
        observedAt: candidate.observedAt ?? null,
        confidence: candidate.confidence ?? null,
      },
      modelClient: params.modelContext?.modelClient ?? null,
      embeddingClient,
    });
    if (persisted.outcome !== "noop_duplicate") {
      touchedEntityIds.add(persisted.entity.entityId);
    }
  }
  for (const entityId of touchedEntityIds) {
    await rebuildInteractionEntityTree({
      store: params.store,
      workspaceId: context.turnResult.workspaceId,
      entityId,
      summaryModelClient,
      embeddingClient,
    });
  }
  return (
    params.store.getTurnResult({
      workspaceId: context.turnResult.workspaceId,
      inputId: context.turnResult.inputId,
    }) ?? context.turnResult
  );
}

export async function writeTurnMemory(params: {
  store: RuntimeStateStore;
  memoryService: MemoryServiceLike;
  turnResult: TurnResultRecord;
  modelContext?: TurnMemoryWritebackModelContext | null;
}): Promise<TurnResultRecord> {
  try {
    return await writeTurnDurableMemory({
      store: params.store,
      memoryService: params.memoryService,
      turnResult: params.turnResult,
      modelContext: params.modelContext ?? null,
    });
  } catch {
    return (
      params.store.getTurnResult({
        workspaceId: params.turnResult.workspaceId,
        inputId: params.turnResult.inputId,
      }) ?? params.turnResult
    );
  }
}
