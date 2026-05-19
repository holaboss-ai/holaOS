import {
  CHAT_SERIALIZED_SKILL_COMMAND_PATTERN,
  MENTION_TOKEN_PATTERN,
} from "./constants";
import type {
  ChatComposerSlashCommandOption,
  ChatSerializedQuotedSkillBlock,
  PendingAttachment,
} from "./types";

export function initialBrowserState(
  space: BrowserSpaceId,
): BrowserTabListPayload {
  return {
    space,
    activeTabId: "",
    tabs: [],
    tabCounts: {
      user: 0,
      agent: 0,
    },
    sessionId: null,
    lifecycleState: null,
    controlMode: "none",
    controlSessionId: null,
  };
}

export function attachmentLooksLikeImage(
  name: string,
  mimeType?: string | null,
): boolean {
  const normalizedMimeType = (mimeType ?? "").trim().toLowerCase();
  if (normalizedMimeType.startsWith("image/")) {
    return true;
  }
  return /\.(avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|webp)$/i.test(
    name.trim(),
  );
}

export function pendingAttachmentIsImage(attachment: PendingAttachment): boolean {
  if (attachment.source === "local-file") {
    return attachmentLooksLikeImage(attachment.file.name, attachment.file.type);
  }
  return (
    attachment.kind === "image" ||
    attachmentLooksLikeImage(attachment.name, attachment.mime_type)
  );
}

export function supportsImageInput(
  inputModalities?: readonly string[] | null,
): boolean {
  if (!Array.isArray(inputModalities) || inputModalities.length === 0) {
    return true;
  }
  return inputModalities.includes("image");
}

export function imageInputUnsupportedMessage(modelLabel: string): string {
  const normalizedModelLabel = modelLabel.trim();
  if (!normalizedModelLabel) {
    return "The selected model doesn't support image inputs.";
  }
  return `${normalizedModelLabel} doesn't support image inputs.`;
}

export function parseSerializedQuotedSkillPrompt(
  value: string,
): ChatSerializedQuotedSkillBlock {
  const normalized = value.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const skillIds: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    if (!line) {
      break;
    }
    const match = CHAT_SERIALIZED_SKILL_COMMAND_PATTERN.exec(line);
    if (!match) {
      return {
        skillIds: [],
        body: normalized.trim(),
      };
    }
    skillIds.push(match[1] ?? "");
    index += 1;
  }

  if (skillIds.length === 0) {
    return {
      skillIds: [],
      body: normalized.trim(),
    };
  }

  if (index < lines.length && (lines[index]?.trim() ?? "") !== "") {
    return {
      skillIds: [],
      body: normalized.trim(),
    };
  }

  while (index < lines.length && (lines[index]?.trim() ?? "") === "") {
    index += 1;
  }

  return {
    skillIds: [...new Set(skillIds)],
    body: lines.slice(index).join("\n").trim(),
  };
}

export function appendComposerPrefillText(currentInput: string, text: string) {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return currentInput;
  }
  if (!currentInput.trim()) {
    return normalizedText;
  }
  return /[\s(]$/.test(currentInput)
    ? `${currentInput}${normalizedText}`
    : `${currentInput} ${normalizedText}`;
}

export function buildComposerSlashCommandOptions(
  skills: WorkspaceSkillRecordPayload[],
): ChatComposerSlashCommandOption[] {
  return skills
    .map((skill) => ({
      key: `skill:${skill.skill_id}`,
      kind: "skill" as const,
      command: `/${skill.skill_id}`,
      label: skill.title,
      description: skill.summary,
      searchText:
        `${skill.skill_id} ${skill.title} ${skill.summary}`.toLowerCase(),
      skillId: skill.skill_id,
    }))
    .sort((left, right) => left.command.localeCompare(right.command));
}

export function findActiveSlashCommandRange(
  value: string,
  caretIndex: number,
): { start: number; end: number; query: string } | null {
  if (caretIndex < 0 || caretIndex > value.length) {
    return null;
  }
  const prefix = value.slice(0, caretIndex);
  const whitespaceBoundary = Math.max(
    prefix.lastIndexOf(" "),
    prefix.lastIndexOf("\n"),
    prefix.lastIndexOf("\t"),
  );
  const start = whitespaceBoundary + 1;
  const rawToken = prefix.slice(start);
  if (!rawToken.startsWith("/") || rawToken.length === 0) {
    return null;
  }
  if (!/^\/[A-Za-z0-9_-]*$/.test(rawToken)) {
    return null;
  }
  return {
    start,
    end: caretIndex,
    query: rawToken.slice(1).toLowerCase(),
  };
}

export function removeSlashCommandText(
  value: string,
  range: { start: number; end: number },
): { value: string; caretIndex: number } {
  const before = value.slice(0, range.start);
  const after = value.slice(range.end);
  const nextValue =
    before.endsWith(" ") && after.startsWith(" ")
      ? `${before}${after.slice(1)}`
      : `${before}${after}`;
  return {
    value: nextValue,
    caretIndex: before.length,
  };
}

/** Mirrors `findActiveSlashCommandRange` for the `@`-mention trigger.
 *  Treated as a separate path so the two pickers can fire at different
 *  carets and against different item lists without one swallowing the
 *  other. The matched character set is wider than slash (allows `.`)
 *  so handles like `agent.work` resolve. */
export function findActiveMentionRange(
  value: string,
  caretIndex: number,
): { start: number; end: number; query: string } | null {
  if (caretIndex < 0 || caretIndex > value.length) {
    return null;
  }
  const prefix = value.slice(0, caretIndex);
  const whitespaceBoundary = Math.max(
    prefix.lastIndexOf(" "),
    prefix.lastIndexOf("\n"),
    prefix.lastIndexOf("\t"),
  );
  const start = whitespaceBoundary + 1;
  const rawToken = prefix.slice(start);
  if (!rawToken.startsWith("@") || rawToken.length === 0) {
    return null;
  }
  // Allow `/` in handles so nested file paths (`@apps/twitter/post.md`)
  // round-trip — the parser still recognises the token if the user
  // moves the caret back into it.
  if (!/^@[\p{L}\p{N}_.\-/]*$/u.test(rawToken)) {
    return null;
  }
  return {
    start,
    end: caretIndex,
    query: rawToken.slice(1).toLowerCase(),
  };
}

export function replaceMentionText(
  value: string,
  range: { start: number; end: number },
  insertion: string,
): { value: string; caretIndex: number } {
  const before = value.slice(0, range.start);
  const after = value.slice(range.end);
  // Always insert a trailing space unless one is already present.
  // (Previously skipped when `after.length === 0`, which left the
  // inserted handle with the caret still inside its mention range —
  // findActiveMentionRange kept matching, the picker stayed open, and
  // the user had to press Escape to dismiss.) Adding the space
  // unconditionally breaks the range cleanly so the picker closes.
  const trailing = after.startsWith(" ") ? "" : " ";
  const nextValue = `${before}${insertion}${trailing}${after}`;
  return {
    value: nextValue,
    caretIndex: before.length + insertion.length + trailing.length,
  };
}

/** Pre-process raw chat text so that `@<handle>` tokens become
 *  markdown links pointing at the `holaboss-mention://` scheme.
 *  SimpleMarkdown's link renderer (with `renderMention` configured)
 *  swaps each one for an inline `EntityMention` chip. Keeps markdown
 *  rendering otherwise untouched. */
export function injectMentionLinks(text: string): string {
  if (!text.includes("@")) return text;
  return text.replace(MENTION_TOKEN_PATTERN, (_match, leading, handle) => {
    return `${leading}[@${handle}](holaboss-mention://${handle})`;
  });
}

export function displayModelLabel(model: string) {
  const trimmed = model.trim();
  if (!trimmed) {
    return "Unknown model";
  }

  const withoutProvider = trimmed.replace(/^(openai|anthropic)\//i, "");
  const sonnetModelMatch = withoutProvider.match(
    /^claude-sonnet-(\d+)-(\d+)$/i,
  );
  if (sonnetModelMatch) {
    return `Claude Sonnet ${sonnetModelMatch[1]}.${sonnetModelMatch[2]}`;
  }

  if (/^gpt-/i.test(withoutProvider)) {
    return withoutProvider
      .replace(/^gpt-/i, "GPT-")
      .replace(/-mini\b/gi, " Mini")
      .replace(/-codex\b/gi, " Codex")
      .replace(/-max\b/gi, " Max")
      .replace(/-spark\b/gi, " Spark");
  }

  return withoutProvider
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) =>
      /^\d+(\.\d+)?$/.test(part)
        ? part
        : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`,
    )
    .join(" ");
}

export function compactComposerModelLabel(label: string) {
  const normalizedLabel = label.trim();
  if (!normalizedLabel) {
    return "Model";
  }

  const autoMatch = normalizedLabel.match(/^Auto \((.+)\)$/i);
  if (autoMatch?.[1]) {
    return autoMatch[1].trim();
  }

  const segments = normalizedLabel
    .split("·")
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments[segments.length - 1] ?? normalizedLabel;
}

export function chatMessageTimeLabel(value: string | null | undefined): string {
  const timestamp = Date.parse(value || "");
  if (Number.isNaN(timestamp)) {
    return "";
  }
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function inputIdFromMessageId(
  messageId: string,
  role: "user" | "assistant",
) {
  const prefix = `${role}-`;
  return messageId.startsWith(prefix) ? messageId.slice(prefix.length) : "";
}

export function inputIdFromHistoryMessage(
  message: SessionHistoryMessagePayload,
) {
  if (message.role === "user" || message.role === "assistant") {
    return inputIdFromMessageId(message.id, message.role);
  }
  return "";
}

export function historyMessagesInDisplayOrder(
  messages: SessionHistoryMessagePayload[],
  order: "asc" | "desc",
) {
  return order === "desc" ? [...messages].reverse() : messages;
}

export function normalizeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}

export function turnInputIdsFromHistoryMessages(
  messages: SessionHistoryMessagePayload[],
) {
  const seen = new Set<string>();
  const inputIds: string[] = [];
  for (const message of messages) {
    const inputId = inputIdFromHistoryMessage(message);
    if (!inputId || seen.has(inputId)) {
      continue;
    }
    seen.add(inputId);
    inputIds.push(inputId);
  }
  return inputIds;
}
