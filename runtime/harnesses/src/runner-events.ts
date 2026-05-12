import {
  resolveHarnessSkillMetadata,
  type HarnessSkillMetadata,
} from "./skill-policy.js";

export interface HarnessRunnerWaitState {
  waitingForUser: boolean;
}

function optionalTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = optionalTrimmedString(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isHarnessSkillToolName(toolName: unknown): boolean {
  return typeof toolName === "string" && toolName.trim().toLowerCase() === "skill";
}

export function isHarnessQuestionToolName(toolName: unknown): boolean {
  return typeof toolName === "string" && toolName.trim().toLowerCase() === "question";
}

export function skillInvocationArgs(value: unknown): { requestedName: string | null; args: string | null } {
  if (!isRecord(value)) {
    return { requestedName: null, args: null };
  }
  return {
    requestedName: optionalTrimmedString(value.name),
    args: optionalTrimmedString(value.args),
  };
}

export function skillInvocationResultDetails(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  return isRecord(value.details) ? value.details : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => optionalTrimmedString(item))
    .filter((item): item is string => Boolean(item));
}

export function buildHarnessSkillInvocationStartPayload(params: {
  toolName: unknown;
  toolCallId: string;
  args: unknown;
  skillMetadataByAlias: ReadonlyMap<string, HarnessSkillMetadata>;
}): Record<string, unknown> | null {
  if (!isHarnessSkillToolName(params.toolName)) {
    return null;
  }
  const invocationArgs = skillInvocationArgs(params.args);
  const resolvedSkill = resolveHarnessSkillMetadata(params.skillMetadataByAlias, invocationArgs.requestedName);
  return {
    phase: "started",
    requested_name: invocationArgs.requestedName,
    skill_id: resolvedSkill?.skillId ?? null,
    skill_name: resolvedSkill?.skillName ?? invocationArgs.requestedName,
    skill_location: resolvedSkill?.filePath ?? null,
    granted_tools_expected: resolvedSkill?.grantedTools ?? [],
    granted_commands_expected: resolvedSkill?.grantedCommands ?? [],
    args: invocationArgs.args,
    error: false,
    event: "tool_execution_start",
    call_id: params.toolCallId,
  };
}

export function buildHarnessSkillInvocationEndPayload(params: {
  toolName: unknown;
  toolCallId: string;
  toolArgs: unknown;
  result: unknown;
  isError: boolean;
  skillMetadataByAlias: ReadonlyMap<string, HarnessSkillMetadata>;
}): Record<string, unknown> | null {
  if (!isHarnessSkillToolName(params.toolName)) {
    return null;
  }
  const invocationArgs = skillInvocationArgs(params.toolArgs);
  const resolvedSkill = resolveHarnessSkillMetadata(params.skillMetadataByAlias, invocationArgs.requestedName);
  const details = skillInvocationResultDetails(params.result);
  const policyWidening = isRecord(details?.policy_widening) ? details.policy_widening : null;
  const resultMessage = firstNonEmptyString(
    details?.message,
    details?.error_message,
    isRecord(params.result) ? params.result.message : undefined,
    isRecord(params.result) ? params.result.error : undefined,
    typeof params.result === "string" ? params.result : undefined,
  );

  return {
    phase: "completed",
    requested_name: invocationArgs.requestedName,
    skill_id: firstNonEmptyString(details?.skill_id, resolvedSkill?.skillId) ?? null,
    skill_name:
      firstNonEmptyString(details?.skill_name, resolvedSkill?.skillName, invocationArgs.requestedName) ?? null,
    skill_location: firstNonEmptyString(details?.skill_file_path, resolvedSkill?.filePath) ?? null,
    widening_scope: optionalTrimmedString(policyWidening?.scope),
    managed_tools: stringList(policyWidening?.managed_tools),
    granted_tools: stringList(policyWidening?.granted_tools),
    active_granted_tools: stringList(policyWidening?.active_granted_tools),
    managed_commands: stringList(policyWidening?.managed_commands),
    granted_commands: stringList(policyWidening?.granted_commands),
    active_granted_commands: stringList(policyWidening?.active_granted_commands),
    workspace_boundary_override:
      typeof policyWidening?.workspace_boundary_override === "boolean"
        ? policyWidening.workspace_boundary_override
        : null,
    args: invocationArgs.args,
    error: Boolean(params.isError),
    error_message: params.isError ? resultMessage ?? null : null,
    event: "tool_execution_end",
    call_id: params.toolCallId,
  };
}

export function summarizeHarnessQuestionPrompt(args: unknown, result: unknown): string | null {
  const candidates: unknown[] = [];
  if (isRecord(args)) {
    candidates.push(args.question, args.prompt, args.message, args.text, args.content);
  }
  if (isRecord(result)) {
    candidates.push(result.question, result.prompt, result.message, result.text, result.content);
    if (isRecord(result.details)) {
      candidates.push(
        result.details.question,
        result.details.prompt,
        result.details.message,
        result.details.text,
        result.details.content,
      );
    }
  }

  for (const candidate of candidates) {
    const normalized = optionalTrimmedString(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function isSessionRefreshRequiredResult(result: unknown): boolean {
  if (!isRecord(result)) {
    return false;
  }
  if (result.requires_session_refresh === true) {
    return true;
  }
  if (isRecord(result.details) && result.details.requires_session_refresh === true) {
    return true;
  }
  return false;
}

export function noteHarnessWaitingForUserOnToolCompletion(params: {
  toolName: unknown;
  isError: boolean;
  state: HarnessRunnerWaitState;
  result?: unknown;
}): void {
  if (params.isError) {
    return;
  }
  if (isHarnessQuestionToolName(params.toolName)) {
    params.state.waitingForUser = true;
    return;
  }
  if (isSessionRefreshRequiredResult(params.result)) {
    params.state.waitingForUser = true;
  }
}

export function resolveHarnessRunStatus(params: {
  waitingForUser: boolean;
  blockedOnUser?: boolean;
}): "success" | "waiting_user" {
  return params.waitingForUser || Boolean(params.blockedOnUser) ? "waiting_user" : "success";
}
