import type { ChannelPlatform, ChatType, IncomingMessage } from "./connector.js";

export interface SessionKeyParts {
  platform: ChannelPlatform;
  chatType: ChatType;
  chatId: string;
  threadId?: string;
}

/**
 * Derive the durable agent session id for an IM conversation.
 *
 * Shared-per-chat: the key is built from (platform, chatType, chatId) only — every
 * participant in a group/channel shares one session. A native thread gets its own
 * session via the `:thread:<id>` suffix. The same conversation always reproduces the
 * same id → the same persisted transcript is reloaded, giving cross-message memory.
 *
 * Mirrors the well-known `telegram:{chat_id}` keying scheme.
 * `platform` is part of the key, so the same human on two platforms gets two separate
 * sessions (no cross-platform identity merge).
 */
export function deriveSessionId(parts: SessionKeyParts): string {
  const base = `im:${parts.platform}:${parts.chatType}:${parts.chatId}`;
  const threadId = parts.threadId?.trim();
  return threadId ? `${base}:thread:${threadId}` : base;
}

/** Convenience wrapper that keys a normalized inbound message. */
export function sessionIdForMessage(message: IncomingMessage): string {
  return deriveSessionId({
    platform: message.platform,
    chatType: message.chatType,
    chatId: message.chatId,
    threadId: message.threadId,
  });
}
