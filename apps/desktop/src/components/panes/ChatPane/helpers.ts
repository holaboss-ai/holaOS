import {
  CHAT_SERIALIZED_INTEGRATION_PATTERN,
  CHAT_SERIALIZED_SKILL_COMMAND_PATTERN,
  MENTION_TOKEN_PATTERN,
} from "./constants";
import type { InstalledCapability } from "@/components/panes/CapabilityDetailView";
import type {
  ChatComposerSlashCommandOption,
  ChatSerializedQuotedSkillBlock,
  PendingAttachment,
} from "./types";

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
  if (attachment.source === "explorer-path") {
    return (
      attachment.kind === "image" ||
      attachmentLooksLikeImage(attachment.name, attachment.mime_type)
    );
  }
  // app-context cards are never image input.
  return false;
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
    return "The selected model can't read images.";
  }
  return `${normalizedModelLabel} can't read images.`;
}

export function parseSerializedQuotedSkillPrompt(
  value: string,
): ChatSerializedQuotedSkillBlock {
  const normalized = value.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const skillIds: string[] = [];
  const integrationSlugs: string[] = [];
  let index = 0;

  const bail = (): ChatSerializedQuotedSkillBlock => ({
    skillIds: [],
    integrationSlugs: [],
    body: normalized.trim(),
  });

  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    if (!line) {
      break;
    }
    const skillMatch = CHAT_SERIALIZED_SKILL_COMMAND_PATTERN.exec(line);
    if (skillMatch) {
      skillIds.push(skillMatch[1] ?? "");
      index += 1;
      continue;
    }
    const integrationMatch = CHAT_SERIALIZED_INTEGRATION_PATTERN.exec(line);
    if (integrationMatch) {
      integrationSlugs.push(integrationMatch[1] ?? "");
      index += 1;
      continue;
    }
    return bail();
  }

  if (skillIds.length === 0 && integrationSlugs.length === 0) {
    return bail();
  }

  if (index < lines.length && (lines[index]?.trim() ?? "") !== "") {
    return bail();
  }

  while (index < lines.length && (lines[index]?.trim() ?? "") === "") {
    index += 1;
  }

  return {
    skillIds: [...new Set(skillIds)],
    integrationSlugs: [...new Set(integrationSlugs)],
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
  capabilities: InstalledCapability[] = [],
): ChatComposerSlashCommandOption[] {
  const skillOptions: ChatComposerSlashCommandOption[] = skills
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

  const capabilityOptions: ChatComposerSlashCommandOption[] = capabilities
    .map((capability) => {
      const description = capability.description ?? "";
      return {
        key: `capability:${capability.capabilityId}`,
        kind: "capability" as const,
        command: `/${capability.capabilityId}`,
        label: capability.name,
        description,
        searchText:
          `${capability.capabilityId} ${capability.name} ${description}`.toLowerCase(),
        capabilityId: capability.capabilityId,
        installedSkillIds: capability.installedSkillIds,
        integrationProviders: Object.keys(capability.integrationStatus),
      };
    })
    .sort((left, right) => left.command.localeCompare(right.command));

  return [...capabilityOptions, ...skillOptions];
}

/** Slugify a workspace-relative file path into a mention handle that
 *  round-trips through `findActiveMentionRange`. Non-letter / non-digit
 *  characters drop per segment; CJK filenames stay intact. Shared between
 *  the composer's mention list and any UI that wants to push an `@file`
 *  into the composer programmatically. */
export function slugifyFilePathForMention(relativePath: string): string {
  return relativePath
    .split("/")
    .map((segment) =>
      segment
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^\p{L}\p{N}_.\-]/gu, ""),
    )
    .filter(Boolean)
    .join("/");
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
