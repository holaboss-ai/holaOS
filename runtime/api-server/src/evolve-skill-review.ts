import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  EvolveSkillCandidateKind,
  EvolveSkillCandidateRecord,
  RuntimeStateStore,
  TurnResultRecord,
} from "@holaboss/runtime-state-store";

import type { MemoryModelClientConfig } from "./memory-model-client.js";
import { queryMemoryModelJson } from "./memory-model-client.js";
import type { MemoryServiceLike } from "./memory.js";
import {
  assistantTextFromTurnArtifacts,
  compactedSummaryFromTurnArtifacts,
  permissionDenialsFromTurnArtifacts,
  toolUsageSummaryFromTurnArtifacts,
} from "./turn-semantic-artifacts.js";
import { resolveWorkspaceSkills } from "./workspace-skills.js";

const SKILL_REVIEW_INTERVAL_TURNS = 3;
const RECENT_SKILL_REVIEW_TURN_LIMIT = 5;
const RECENT_SKILL_REVIEW_USER_MESSAGES_LIMIT = 4;
const EXISTING_WORKSPACE_SKILL_PROMPT_LIMIT = 6;
const EXISTING_WORKSPACE_SKILL_PROMPT_CHARS = 1400;
const MIN_SKILL_CONFIDENCE = 0.72;

export type SkillCandidatePromotionResult =
  | { status: "missing_candidate" | "not_ready" | "missing_draft" | "invalid_live_skill"; targetSkillPath: string | null }
  | { status: "already_promoted" | "promoted_existing_live_skill" | "promoted_from_draft"; targetSkillPath: string };

export interface SkillCandidateDraft {
  kind: EvolveSkillCandidateKind;
  title: string;
  summary: string;
  slug: string;
  skillMarkdown: string;
  confidence: number | null;
  evaluationNotes: string | null;
  sourceTurnInputIds: string[];
}

export interface SkillCandidateReviewResult {
  draft: SkillCandidateDraft | null;
  reason: "not_due" | "no_model" | "no_candidate" | "duplicate" | "too_weak" | "candidate_ready";
}

interface SkillReviewContext {
  modelClient: MemoryModelClientConfig | null;
  workspaceId: string;
  sessionId: string;
  inputId: string;
  instruction: string;
  assistantText: string;
  toolUsageSummary: Record<string, unknown>;
  permissionDenials: Array<Record<string, unknown>>;
  recentUserMessages: string[];
  recentTurnSummaries: string[];
  existingResolvedSkillIds: string[];
  existingWorkspaceSkills: Array<{
    skillId: string;
    markdown: string;
  }>;
}

interface ExtractedSkillReviewCandidate {
  kind: EvolveSkillCandidateKind;
  targetSkillId: string | null;
  title: string;
  summary: string;
  slug: string;
  whenToUse: string;
  workflow: string[];
  verification: string[];
  confidence: number | null;
  evaluationNotes: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clipText(value: string, maxChars: number): string {
  const normalized = compactWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function normalizeSkillSlug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "workspace-skill";
}

function normalizeConfidence(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  return null;
}

function normalizeLines(value: unknown, maxItems: number, maxChars = 220): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const line = clipText(item, maxChars);
    if (!line || seen.has(line)) {
      continue;
    }
    seen.add(line);
    normalized.push(line);
    if (normalized.length >= maxItems) {
      break;
    }
  }
  return normalized;
}

function shouldReviewSkillsOnTurn(completedTurnCount: number): boolean {
  return completedTurnCount > 0 && completedTurnCount % SKILL_REVIEW_INTERVAL_TURNS === 0;
}

function skillCandidateIdForInput(inputId: string): string {
  return `evolve-skill-${inputId}`;
}

export function skillCandidateProposalId(candidateId: string): string {
  return `evolve-proposal-${candidateId}`;
}

function skillCandidatePath(workspaceId: string, candidateId: string): string {
  return `workspace/${workspaceId}/evolve/skills/${candidateId}/SKILL.md`;
}

export function promotedWorkspaceSkillPath(slug: string): string {
  return `skills/${normalizeSkillSlug(slug)}/SKILL.md`;
}

function fingerprintText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function candidateMarkdown(draft: ExtractedSkillReviewCandidate, sourceTurnInputIds: string[]): string {
  const lines = [
    "---",
    `name: ${draft.slug}`,
    `description: ${draft.summary}`,
    "---",
    `# ${draft.title}`,
    "",
    "## When To Use",
    draft.whenToUse,
    "",
    "## Workflow",
    ...(draft.workflow.length > 0
      ? draft.workflow.map((step, index) => `${index + 1}. ${step}`)
      : ["1. Review the linked source turn and refine this draft before promotion."]),
    "",
    "## Verification",
    ...(draft.verification.length > 0
      ? draft.verification.map((step) => `- ${step}`)
      : ["- Verify the workflow against the current workspace before promotion."]),
    "",
    "## Source Context",
    `- Proposed by evolve from turn ids: ${sourceTurnInputIds.map((value) => `\`${value}\``).join(", ") || "`unknown`"}.`,
  ];
  lines.push(`- Candidate kind: \`${draft.kind}\`.`);
  if (draft.targetSkillId) {
    lines.push(`- Target workspace skill id: \`${draft.targetSkillId}\`.`);
  }
  if (draft.evaluationNotes) {
    lines.push(`- Evaluation notes: ${draft.evaluationNotes}`);
  }
  return `${lines.join("\n").trim()}\n`;
}

async function upsertWorkspaceMemoryFileIfChanged(params: {
  memoryService: MemoryServiceLike;
  workspaceId: string;
  path: string;
  content: string;
}): Promise<void> {
  const existing = await params.memoryService.get({
    workspace_id: params.workspaceId,
    path: params.path,
  });
  if ((existing.text as string | undefined) === params.content) {
    return;
  }
  await params.memoryService.upsert({
    workspace_id: params.workspaceId,
    path: params.path,
    content: params.content,
    append: false,
  });
}

function activeCandidate(records: EvolveSkillCandidateRecord[]): EvolveSkillCandidateRecord[] {
  return records.filter((record) => !["dismissed", "discarded"].includes(record.status));
}

function liveWorkspaceSkillExists(workspaceDir: string, slug: string): boolean {
  return resolveWorkspaceSkills(workspaceDir).some((skill) => skill.origin === "workspace" && skill.skill_id === slug);
}

function listWorkspaceSkillMarkdownFiles(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    return [];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const stack = [root];
  const results: string[] = [];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === "SKILL.md") {
        results.push(fullPath);
      }
    }
  }
  return results.sort();
}

function skillFrontmatterName(markdown: string): string | null {
  const frontmatterMatch = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatterMatch) {
    return null;
  }
  const nameMatch = frontmatterMatch[1].match(/(?:^|\r?\n)name:\s*([^\r\n]+)/i);
  if (!nameMatch?.[1]) {
    return null;
  }
  const normalized = normalizeSkillSlug(nameMatch[1]);
  return normalized || null;
}

function relativePosixPath(baseDir: string, targetPath: string): string {
  return path.relative(baseDir, targetPath).split(path.sep).join("/");
}

function removeFileAndEmptyParents(filePath: string, stopDir: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    return;
  }
  let current = path.dirname(filePath);
  const normalizedStopDir = path.resolve(stopDir);
  while (current.startsWith(`${normalizedStopDir}${path.sep}`) && current !== normalizedStopDir) {
    try {
      if (fs.readdirSync(current).length > 0) {
        break;
      }
      fs.rmdirSync(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

function misplacedWorkspaceSkillArtifact(params: {
  workspaceDir: string;
  candidate: EvolveSkillCandidateRecord;
}): { filePath: string; markdown: string } | null {
  const evolveRoot = path.join(params.workspaceDir, "evolve");
  if (!fs.existsSync(evolveRoot)) {
    return null;
  }
  const slug = normalizeSkillSlug(params.candidate.slug);
  const candidateId = params.candidate.candidateId.toLowerCase();
  const preferredPaths = [
    path.join(evolveRoot, "skills", params.candidate.candidateId, "SKILL.md"),
    path.join(evolveRoot, "skills", slug, "SKILL.md"),
    path.join(evolveRoot, params.candidate.candidateId, "SKILL.md"),
    path.join(evolveRoot, slug, "SKILL.md"),
  ];
  const seen = new Set<string>();
  let bestMatch: { score: number; filePath: string; markdown: string } | null = null;
  for (const filePath of [...preferredPaths, ...listWorkspaceSkillMarkdownFiles(evolveRoot)]) {
    const resolvedPath = path.resolve(filePath);
    if (seen.has(resolvedPath)) {
      continue;
    }
    seen.add(resolvedPath);
    let markdown = "";
    try {
      markdown = fs.readFileSync(resolvedPath, "utf8");
    } catch {
      continue;
    }
    if (!markdown.trim()) {
      continue;
    }
    const relativePath = relativePosixPath(params.workspaceDir, resolvedPath).toLowerCase();
    const frontmatterName = skillFrontmatterName(markdown);
    let score = 0;
    if (resolvedPath === preferredPaths[0]) {
      score += 100;
    } else if (resolvedPath === preferredPaths[1]) {
      score += 95;
    } else if (resolvedPath === preferredPaths[2]) {
      score += 90;
    } else if (resolvedPath === preferredPaths[3]) {
      score += 85;
    }
    if (relativePath.includes(candidateId)) {
      score += 35;
    }
    if (relativePath.includes(slug)) {
      score += 30;
    }
    if (frontmatterName === slug) {
      score += 50;
    }
    if (markdown.includes(`# ${params.candidate.title}`)) {
      score += 10;
    }
    if (score <= 0) {
      continue;
    }
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { score, filePath: resolvedPath, markdown };
    }
  }
  return bestMatch ? { filePath: bestMatch.filePath, markdown: bestMatch.markdown } : null;
}

function existingResolvedSkillIds(store: RuntimeStateStore, workspaceId: string): string[] {
  return resolveWorkspaceSkills(store.workspaceDir(workspaceId)).map((skill) => skill.skill_id);
}

function existingWorkspaceSkillDrafts(
  store: RuntimeStateStore,
  workspaceId: string
): Array<{ skillId: string; markdown: string }> {
  return resolveWorkspaceSkills(store.workspaceDir(workspaceId))
    .filter((skill) => skill.origin === "workspace")
    .slice(0, EXISTING_WORKSPACE_SKILL_PROMPT_LIMIT)
    .map((skill) => {
      const skillFilePath = path.join(skill.source_dir, "SKILL.md");
      let markdown = "";
      try {
        markdown = fs.readFileSync(skillFilePath, "utf8");
      } catch {
        markdown = "";
      }
      return {
        skillId: skill.skill_id,
        markdown: clipText(markdown, EXISTING_WORKSPACE_SKILL_PROMPT_CHARS),
      };
    })
    .filter((skill) => skill.markdown.trim().length > 0);
}

function workspaceSkillMarkdown(store: RuntimeStateStore, workspaceId: string, skillId: string): string | null {
  const match = resolveWorkspaceSkills(store.workspaceDir(workspaceId)).find(
    (skill) => skill.origin === "workspace" && skill.skill_id === skillId
  );
  if (!match) {
    return null;
  }
  try {
    return fs.readFileSync(path.join(match.source_dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

function recentCompletedTurnSummaries(store: RuntimeStateStore, turnResult: TurnResultRecord): string[] {
  return store
    .listTurnResults({
      workspaceId: turnResult.workspaceId,
      sessionId: turnResult.sessionId,
      status: "completed",
      limit: RECENT_SKILL_REVIEW_TURN_LIMIT,
      offset: 0,
    })
    .map((item) => {
      const summary = compactedSummaryFromTurnArtifacts(store, item);
      if (summary) {
        return clipText(summary, 220);
      }
      return clipText(assistantTextFromTurnArtifacts(store, item), 220);
    })
    .filter(Boolean);
}

function recentUserMessages(store: RuntimeStateStore, turnResult: TurnResultRecord): string[] {
  return store
    .listSessionMessages({
      workspaceId: turnResult.workspaceId,
      sessionId: turnResult.sessionId,
      role: "user",
      order: "desc",
      limit: RECENT_SKILL_REVIEW_USER_MESSAGES_LIMIT,
      offset: 0,
    })
    .reverse()
    .map((message) => clipText(message.text, 240))
    .filter(Boolean);
}

async function extractSkillCandidateFromModel(context: SkillReviewContext): Promise<ExtractedSkillReviewCandidate | null> {
  if (!context.modelClient) {
    return null;
  }
  const payload = await queryMemoryModelJson(context.modelClient, {
    systemPrompt:
      "Review this completed turn for a reusable workspace-local skill. Return strict JSON only with this shape: " +
      '{"candidate":{"kind":"skill_create|skill_patch","target_skill_id":"string|null","title":"string","summary":"string","slug":"string","when_to_use":"string","workflow":["string"],"verification":["string"],"confidence":0.0,"evaluation_notes":"string"}|null}. ' +
      "Only propose a candidate when the workflow is reusable beyond a single one-off incident. " +
      "Use `skill_patch` only when updating an existing workspace-owned skill would materially improve it. " +
      "Use `skill_create` only when no existing skill captures the workflow. " +
      "Do not propose skills for transient runtime state, general advice, or facts that belong in durable memory instead of a reusable procedure.",
    userPrompt: [
      `Workspace ID: ${context.workspaceId}`,
      `Session ID: ${context.sessionId}`,
      `Input ID: ${context.inputId}`,
      "",
      `Instruction: ${context.instruction || "none"}`,
      "",
      "Recent user messages:",
      ...(context.recentUserMessages.length > 0 ? context.recentUserMessages.map((item) => `- ${item}`) : ["- none"]),
      "",
      "Recent completed turn summaries:",
      ...(context.recentTurnSummaries.length > 0 ? context.recentTurnSummaries.map((item) => `- ${item}`) : ["- none"]),
      "",
      "Latest assistant response:",
      context.assistantText || "none",
      "",
      "Tool usage summary JSON:",
      JSON.stringify(context.toolUsageSummary),
      "",
      "Permission denials JSON:",
      JSON.stringify(context.permissionDenials),
      "",
      "Existing resolved skill ids (embedded and workspace):",
      context.existingResolvedSkillIds.length > 0 ? context.existingResolvedSkillIds.join(", ") : "none",
      "",
      "Existing workspace-owned skill drafts:",
      ...(context.existingWorkspaceSkills.length > 0
        ? context.existingWorkspaceSkills.flatMap((skill) => [
            `## ${skill.skillId}`,
            skill.markdown,
            "",
          ])
        : ["none"]),
    ].join("\n"),
    timeoutMs: 8000,
  });
  if (!payload || !isRecord(payload.candidate)) {
    return null;
  }
  const candidate = payload.candidate;
  if (candidate === null) {
    return null;
  }
  const requestedKind = String(candidate.kind ?? "").trim().toLowerCase();
  const title = clipText(String(candidate.title ?? ""), 120);
  const summary = clipText(String(candidate.summary ?? ""), 220);
  const whenToUse = clipText(String(candidate.when_to_use ?? ""), 320);
  const slug = normalizeSkillSlug(String(candidate.slug ?? title));
  const targetSkillIdRaw = String(candidate.target_skill_id ?? "").trim();
  const workflow = normalizeLines(candidate.workflow, 8, 240);
  const verification = normalizeLines(candidate.verification, 6, 220);
  const confidence = normalizeConfidence(candidate.confidence);
  const evaluationNotes = clipText(String(candidate.evaluation_notes ?? ""), 280) || null;
  if (!title || !summary || !whenToUse || workflow.length < 2) {
    return null;
  }
  const resolvedKind: EvolveSkillCandidateKind = requestedKind === "skill_patch" ? "skill_patch" : "skill_create";
  const targetSkillId = targetSkillIdRaw ? normalizeSkillSlug(targetSkillIdRaw) : resolvedKind === "skill_patch" ? slug : null;
  return {
    kind: resolvedKind,
    targetSkillId,
    title,
    summary,
    slug,
    whenToUse,
    workflow,
    verification,
    confidence,
    evaluationNotes,
  };
}

export async function reviewTurnForSkillCandidate(params: {
  store: RuntimeStateStore;
  turnResult: TurnResultRecord;
  modelClient: MemoryModelClientConfig | null;
  instruction: string;
}): Promise<SkillCandidateReviewResult> {
  const completedTurnCount = params.store.countTurnResults({
    workspaceId: params.turnResult.workspaceId,
    sessionId: params.turnResult.sessionId,
    status: "completed",
  });
  if (!shouldReviewSkillsOnTurn(completedTurnCount)) {
    return { draft: null, reason: "not_due" };
  }
  if (!params.modelClient) {
    return { draft: null, reason: "no_model" };
  }
  const resolvedSkillIds = existingResolvedSkillIds(params.store, params.turnResult.workspaceId);
  const workspaceSkillDrafts = existingWorkspaceSkillDrafts(params.store, params.turnResult.workspaceId);
  const workspaceSkillIdSet = new Set(workspaceSkillDrafts.map((skill) => skill.skillId));
  const assistantText = assistantTextFromTurnArtifacts(params.store, params.turnResult);
  const toolUsageSummary = toolUsageSummaryFromTurnArtifacts(params.store, params.turnResult);
  const permissionDenials = permissionDenialsFromTurnArtifacts(params.store, params.turnResult);
  const extracted = await extractSkillCandidateFromModel({
    modelClient: params.modelClient,
    workspaceId: params.turnResult.workspaceId,
    sessionId: params.turnResult.sessionId,
    inputId: params.turnResult.inputId,
    instruction: params.instruction,
    assistantText,
    toolUsageSummary,
    permissionDenials,
    recentUserMessages: recentUserMessages(params.store, params.turnResult),
    recentTurnSummaries: recentCompletedTurnSummaries(params.store, params.turnResult),
    existingResolvedSkillIds: resolvedSkillIds,
    existingWorkspaceSkills: workspaceSkillDrafts,
  });
  if (!extracted) {
    return { draft: null, reason: "no_candidate" };
  }
  if ((extracted.confidence ?? 0) < MIN_SKILL_CONFIDENCE) {
    return { draft: null, reason: "too_weak" };
  }
  const normalizedTitleSlug = normalizeSkillSlug(extracted.title);
  const patchTargetSkillId = extracted.targetSkillId ?? extracted.slug;
  const isWorkspacePatchTarget = workspaceSkillIdSet.has(patchTargetSkillId);
  const kind: EvolveSkillCandidateKind =
    extracted.kind === "skill_patch" || isWorkspacePatchTarget ? "skill_patch" : "skill_create";
  const draftSkill = {
    ...extracted,
    kind,
    targetSkillId: kind === "skill_patch" ? patchTargetSkillId : null,
    slug: kind === "skill_patch" ? patchTargetSkillId : extracted.slug,
  } satisfies ExtractedSkillReviewCandidate;
  if (kind === "skill_create") {
    if (resolvedSkillIds.includes(draftSkill.slug) || resolvedSkillIds.includes(normalizedTitleSlug)) {
      return { draft: null, reason: "duplicate" };
    }
  } else {
    if (!workspaceSkillIdSet.has(draftSkill.slug)) {
      return { draft: null, reason: "duplicate" };
    }
    const existingMarkdown = workspaceSkillMarkdown(params.store, params.turnResult.workspaceId, draftSkill.slug);
    if (existingMarkdown && compactWhitespace(existingMarkdown) === compactWhitespace(candidateMarkdown(draftSkill, [params.turnResult.inputId]))) {
      return { draft: null, reason: "duplicate" };
    }
  }

  const sourceTurnInputIds = [params.turnResult.inputId];
  return {
    draft: {
      kind: draftSkill.kind,
      title: draftSkill.title,
      summary: draftSkill.summary,
      slug: draftSkill.slug,
      skillMarkdown: candidateMarkdown(draftSkill, sourceTurnInputIds),
      confidence: draftSkill.confidence,
      evaluationNotes: draftSkill.evaluationNotes,
      sourceTurnInputIds,
    },
    reason: "candidate_ready",
  };
}

export async function persistSkillCandidate(params: {
  store: RuntimeStateStore;
  memoryService: MemoryServiceLike;
  turnResult: TurnResultRecord;
  draft: SkillCandidateDraft;
}): Promise<EvolveSkillCandidateRecord> {
  const candidateId = skillCandidateIdForInput(params.turnResult.inputId);
  const existingById = params.store.getEvolveSkillCandidate({
    workspaceId: params.turnResult.workspaceId,
    candidateId,
  });
  if (existingById) {
    return existingById;
  }
  const skillPath = skillCandidatePath(params.turnResult.workspaceId, candidateId);
  const contentFingerprint = fingerprintText(params.draft.skillMarkdown);
  const duplicate = activeCandidate(
    params.store.listEvolveSkillCandidates({
      workspaceId: params.turnResult.workspaceId,
      limit: 200,
      offset: 0,
    })
  ).find((candidate) => candidate.slug === params.draft.slug || candidate.contentFingerprint === contentFingerprint);
  if (duplicate) {
    return duplicate;
  }
  await upsertWorkspaceMemoryFileIfChanged({
    memoryService: params.memoryService,
    workspaceId: params.turnResult.workspaceId,
    path: skillPath,
    content: params.draft.skillMarkdown,
  });
  return params.store.createEvolveSkillCandidate({
    candidateId,
    workspaceId: params.turnResult.workspaceId,
    sessionId: params.turnResult.sessionId,
    inputId: params.turnResult.inputId,
    kind: params.draft.kind,
    title: params.draft.title,
    summary: params.draft.summary,
    slug: params.draft.slug,
    skillPath,
    contentFingerprint,
    confidence: params.draft.confidence,
    evaluationNotes: params.draft.evaluationNotes,
    sourceTurnInputIds: params.draft.sourceTurnInputIds,
  });
}

export async function promoteAcceptedSkillCandidate(params: {
  store: RuntimeStateStore;
  memoryService: MemoryServiceLike;
  workspaceId: string;
  candidateId: string;
}): Promise<SkillCandidatePromotionResult> {
  const candidate = params.store.getEvolveSkillCandidate({
    workspaceId: params.workspaceId,
    candidateId: params.candidateId,
  });
  if (!candidate || !["skill_create", "skill_patch"].includes(candidate.kind)) {
    return { status: "missing_candidate", targetSkillPath: null };
  }
  const targetSkillPath = promotedWorkspaceSkillPath(candidate.slug);
  if (candidate.status === "promoted") {
    return { status: "already_promoted", targetSkillPath };
  }
  if (candidate.status !== "accepted") {
    return { status: "not_ready", targetSkillPath };
  }

  const workspaceDir = params.store.workspaceDir(candidate.workspaceId);
  const misplacedDraft = misplacedWorkspaceSkillArtifact({ workspaceDir, candidate });
  if (liveWorkspaceSkillExists(workspaceDir, candidate.slug)) {
    if (misplacedDraft) {
      removeFileAndEmptyParents(misplacedDraft.filePath, workspaceDir);
    }
    params.store.updateEvolveSkillCandidate({
      workspaceId: candidate.workspaceId,
      candidateId: candidate.candidateId,
      fields: {
        status: "promoted",
        promotedAt: new Date().toISOString(),
      },
    });
    return { status: "promoted_existing_live_skill", targetSkillPath };
  }

  let draftMarkdown = "";
  if (misplacedDraft) {
    draftMarkdown = misplacedDraft.markdown;
    await upsertWorkspaceMemoryFileIfChanged({
      memoryService: params.memoryService,
      workspaceId: candidate.workspaceId,
      path: candidate.skillPath,
      content: draftMarkdown,
    });
  } else {
    const draft = await params.memoryService.get({
      workspace_id: candidate.workspaceId,
      path: candidate.skillPath,
    });
    draftMarkdown = typeof draft.text === "string" ? draft.text : "";
  }
  if (!draftMarkdown.trim()) {
    return { status: "missing_draft", targetSkillPath };
  }

  const targetFilePath = path.join(workspaceDir, targetSkillPath);
  fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });
  const existing = fs.existsSync(targetFilePath) ? fs.readFileSync(targetFilePath, "utf8") : null;
  if (existing !== draftMarkdown) {
    fs.writeFileSync(targetFilePath, draftMarkdown, "utf8");
  }
  if (!liveWorkspaceSkillExists(workspaceDir, candidate.slug)) {
    return { status: "invalid_live_skill", targetSkillPath };
  }
  if (misplacedDraft) {
    removeFileAndEmptyParents(misplacedDraft.filePath, workspaceDir);
  }

  params.store.updateEvolveSkillCandidate({
    workspaceId: candidate.workspaceId,
    candidateId: candidate.candidateId,
    fields: {
      status: "promoted",
      promotedAt: new Date().toISOString(),
    },
  });
  return { status: "promoted_from_draft", targetSkillPath };
}
