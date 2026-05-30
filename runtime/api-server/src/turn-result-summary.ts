import type { TurnResultRecord } from "@holaboss/runtime-state-store";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const MAX_TURN_SUMMARY_LINES = 100;
const MAX_TURN_SUMMARY_CHARS = 40_000;

function firstNonEmptyLines(value: string, maxLines: number, maxChars: number): string[] {
  const lines = value
    .split(/\r?\n/)
    .map((line) => compactWhitespace(line))
    .filter(Boolean);
  if (lines.length === 0) {
    return [];
  }
  const selected: string[] = [];
  let totalChars = 0;
  for (const line of lines) {
    if (selected.length >= maxLines || totalChars >= maxChars) {
      break;
    }
    const remaining = maxChars - totalChars;
    const next =
      line.length > remaining
        ? `${line.slice(0, Math.max(0, remaining - 1)).trimEnd()}...`
        : line;
    if (!next) {
      break;
    }
    selected.push(next);
    totalChars += next.length;
  }
  return selected;
}

function pluralize(value: number, singular: string, plural = `${singular}s`): string {
  return value === 1 ? singular : plural;
}

function editedFilesFromToolUsageSummary(
  toolUsageSummary: Record<string, unknown>,
): string[] {
  const editedFiles = Array.isArray(toolUsageSummary.edited_files)
    ? toolUsageSummary.edited_files
    : [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of editedFiles) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = compactWhitespace(value);
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function editedFileRunSummary(turnResult: TurnResultRecord): string | null {
  const editedFiles = editedFilesFromToolUsageSummary(turnResult.toolUsageSummary);
  if (editedFiles.length === 0) {
    return null;
  }
  const preview = editedFiles.slice(0, 3);
  const previewText = preview.join(", ");
  if (turnResult.status === "waiting_user") {
    return editedFiles.length === 1
      ? `Updated ${previewText} and is waiting for user input.`
      : `Updated ${editedFiles.length} files, including ${previewText}, and is waiting for user input.`;
  }
  if (turnResult.status === "paused") {
    return editedFiles.length === 1
      ? `Updated ${previewText} before the run was paused.`
      : `Updated ${editedFiles.length} files, including ${previewText}, before the run was paused.`;
  }
  if (turnResult.status !== "completed") {
    return null;
  }
  if (editedFiles.length === 1) {
    return `Updated ${previewText}.`;
  }
  return editedFiles.length > 3
    ? `Updated ${editedFiles.length} files, including ${previewText}.`
    : `Updated ${editedFiles.length} files: ${previewText}.`;
}

function browserRunSummary(turnResult: TurnResultRecord): string | null {
  const browser = isRecord(turnResult.toolUsageSummary.browser)
    ? turnResult.toolUsageSummary.browser
    : null;
  if (!browser) {
    return null;
  }
  const totalCalls =
    typeof browser.total_calls === "number" && Number.isFinite(browser.total_calls)
      ? browser.total_calls
      : 0;
  if (totalCalls <= 0) {
    return null;
  }
  const stateReads =
    typeof browser.state_reads === "number" && Number.isFinite(browser.state_reads)
      ? browser.state_reads
      : 0;
  const actionCalls =
    typeof browser.action_calls === "number" && Number.isFinite(browser.action_calls)
      ? browser.action_calls
      : 0;
  const waitCalls =
    typeof browser.wait_calls === "number" && Number.isFinite(browser.wait_calls)
      ? browser.wait_calls
      : 0;
  const compactReads =
    typeof browser.compact_state_reads === "number" && Number.isFinite(browser.compact_state_reads)
      ? browser.compact_state_reads
      : 0;
  const truncatedReads =
    typeof browser.truncated_state_reads === "number" && Number.isFinite(browser.truncated_state_reads)
      ? browser.truncated_state_reads
      : 0;
  const parts = [`${totalCalls} browser ${pluralize(totalCalls, "call")}`];
  if (stateReads > 0) {
    parts.push(`${stateReads} state ${pluralize(stateReads, "read")}`);
  }
  if (actionCalls > 0) {
    parts.push(`${actionCalls} ${pluralize(actionCalls, "action")}`);
  }
  if (waitCalls > 0) {
    parts.push(`${waitCalls} ${pluralize(waitCalls, "wait")}`);
  }
  if (compactReads > 0) {
    parts.push(`${compactReads} compact snapshot${compactReads === 1 ? "" : "s"}`);
  }
  if (truncatedReads > 0) {
    parts.push(`${truncatedReads} truncated snapshot${truncatedReads === 1 ? "" : "s"}`);
  }
  const stopReason = compactWhitespace(turnResult.stopReason ?? "");
  if (turnResult.status === "failed") {
    return stopReason
      ? `Browser-heavy run failed after ${parts.join(", ")} with stop reason ${stopReason}.`
      : `Browser-heavy run failed after ${parts.join(", ")}.`;
  }
  if (turnResult.status === "waiting_user") {
    return `Browser-heavy run paused waiting for user input after ${parts.join(", ")}.`;
  }
  if (turnResult.status === "paused") {
    return `Browser-heavy run was paused after ${parts.join(", ")}.`;
  }
  return stopReason
    ? `Browser-heavy run completed after ${parts.join(", ")} with stop reason ${stopReason}.`
    : `Browser-heavy run completed after ${parts.join(", ")}.`;
}

export function compactTurnSummary(turnResult: TurnResultRecord): string | null {
  const assistantLines = firstNonEmptyLines(
    turnResult.assistantText,
    MAX_TURN_SUMMARY_LINES,
    MAX_TURN_SUMMARY_CHARS,
  );
  if (assistantLines.length > 0) {
    return assistantLines.join(" ");
  }
  const editedFileSummary = editedFileRunSummary(turnResult);
  if (editedFileSummary) {
    return editedFileSummary;
  }
  const browserSummary = browserRunSummary(turnResult);
  if (browserSummary) {
    return browserSummary;
  }
  if (turnResult.status === "waiting_user") {
    return "Run paused waiting for user input.";
  }
  if (turnResult.status === "paused") {
    return "Run was paused by the user before completion.";
  }
  if (turnResult.status === "failed") {
    const reason = compactWhitespace(turnResult.stopReason ?? "");
    return reason ? `Run failed: ${reason}.` : "Run failed.";
  }
  const stopReason = compactWhitespace(turnResult.stopReason ?? "");
  return stopReason ? `Run completed with stop reason ${stopReason}.` : null;
}
