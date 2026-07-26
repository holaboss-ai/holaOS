import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  ChannelArtifact,
  ChannelRuntimePort,
  FireMessageResult,
  IncomingAttachment,
  PollOutputsResult,
} from "@holaboss/runtime-channel-gateway";
import type { RuntimeStateStore, WorkspaceRecord } from "@holaboss/runtime-state-store";
import { resolveCanonicalWorkspaceId } from "../canonical-workspace.js";

const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024;

const ARTIFACT_IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".heic",
  ".tif",
  ".tiff",
]);
const ARTIFACT_VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi"]);
const ARTIFACT_VOICE_EXTS = new Set([
  ".ogg",
  ".oga",
  ".opus",
  ".mp3",
  ".m4a",
  ".wav",
]);
const ARTIFACT_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
};

function artifactKindForExt(ext: string): ChannelArtifact["kind"] {
  if (ARTIFACT_IMAGE_EXTS.has(ext)) return "image";
  if (ARTIFACT_VIDEO_EXTS.has(ext)) return "video";
  if (ARTIFACT_VOICE_EXTS.has(ext)) return "voice";
  return "document";
}

/** Harness id an IM-spawned session runs under. Mirrors cronjob-runtime.ts / app.ts. */
function resolveWorkspaceHarness(workspace: WorkspaceRecord): string {
  const harness = (workspace.harness ?? process.env.SANDBOX_AGENT_HARNESS ?? "pi").trim();
  return harness || "pi";
}

/**
 * Harness a channel's conversations run under: the per-connection preference
 * (stored in the connection's config_json, set from the desktop Channels UI)
 * if present, else the workspace default. This is resolved fresh on every
 * inbound message; when it differs from the conversation's current binding,
 * fireMessage re-binds the conversation to the new harness so switching a
 * connection's harness takes effect on the NEXT message of existing chats too
 * (the executor reads the binding's harness — claimed-input-executor.ts).
 */
function resolveChannelHarness(
  store: RuntimeStateStore,
  workspace: WorkspaceRecord,
  connectionId: string | null | undefined,
): string {
  if (connectionId) {
    const connection = store.getChannelConnection({
      workspaceId: workspace.id,
      connectionId,
    });
    const configured =
      typeof connection?.config.harness === "string"
        ? connection.config.harness.trim()
        : "";
    if (configured) return configured;
  }
  return resolveWorkspaceHarness(workspace);
}

/**
 * The per-channel model override for this connection, or null to inherit the
 * harness/workspace default. Read fresh on every inbound message (like the
 * harness), so a change from the desktop applies to the next message. The run's
 * executor resolves `payload.model ?? runtimeBinding.defaultModel`, so null here
 * transparently falls back to the default.
 */
function resolveChannelModel(
  store: RuntimeStateStore,
  workspaceId: string,
  connectionId: string | null | undefined,
): string | null {
  if (!connectionId) return null;
  const connection = store.getChannelConnection({ workspaceId, connectionId });
  const configured =
    typeof connection?.config.model === "string"
      ? connection.config.model.trim()
      : "";
  return configured.length > 0 ? configured : null;
}

/**
 * Turn the connector's downloaded temp files into harness input: images become
 * `data:` URIs (vision via image_urls), other files are copied into the workspace
 * and referenced by relative `workspace_path`. Temp files are removed afterwards.
 */
function materializeAttachments(
  workspaceDir: string,
  attachments: readonly IncomingAttachment[],
): { attachments: Array<Record<string, unknown>>; imageUrls: string[] } {
  const payloadAttachments: Array<Record<string, unknown>> = [];
  const imageUrls: string[] = [];
  for (const att of attachments) {
    try {
      const isImage =
        att.kind === "image" || att.mimeType.toLowerCase().startsWith("image/");
      if (isImage) {
        const bytes = fs.readFileSync(att.sourcePath);
        if (bytes.length > 0 && bytes.length <= MAX_INLINE_IMAGE_BYTES) {
          imageUrls.push(`data:${att.mimeType};base64,${bytes.toString("base64")}`);
        }
      } else {
        const safe = att.name.replace(/[^\w.-]+/g, "_") || "file";
        const rel = path.join("attachments", "telegram", `${randomUUID()}-${safe}`);
        const abs = path.join(workspaceDir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.copyFileSync(att.sourcePath, abs);
        payloadAttachments.push({
          id: randomUUID(),
          kind: "file",
          name: safe,
          mime_type: att.mimeType,
          size_bytes: att.sizeBytes,
          workspace_path: rel,
        });
      }
    } catch {
      // Skip a single failed attachment rather than dropping the whole message.
    } finally {
      try {
        fs.rmSync(att.sourcePath, { force: true });
      } catch {
        // best-effort temp cleanup
      }
    }
  }
  return { attachments: payloadAttachments, imageUrls };
}

/**
 * The state-store-backed implementation of the channel gateway's runtime port. This
 * is the only IM code that touches the store — it keeps `@holaboss/runtime-channel-gateway`
 * decoupled. `fireMessage` is the `fireCronjob` analog (create-or-reuse session +
 * enqueue), plus a `conversation_bindings` row for the channel→session mapping.
 */
/**
 * When a channel's harness is switched, the conversation rebinds to a FRESH
 * harness session that shares no memory with the previous agent. Build a compact
 * handoff preamble from the conversation's recent transcript so the new agent
 * picks up mid-conversation instead of starting blank — prepended to the first
 * message after the switch. Best-effort: returns "" on any failure or empty
 * history.
 */
function buildHarnessHandoffPreamble(
  store: RuntimeStateStore,
  params: { workspaceId: string; sessionId: string; fromHarness: string; toHarness: string },
): string {
  let recent: Array<{ role: string; text: string }>;
  try {
    recent = store
      .listSessionMessages({
        workspaceId: params.workspaceId,
        sessionId: params.sessionId,
        order: "desc",
        limit: 16,
      })
      .reverse();
  } catch {
    return "";
  }
  const lines = recent
    .map((message) => {
      const text = (message.text ?? "").trim();
      if (!text) return null;
      const who = message.role === "user" ? "User" : "Assistant";
      const clipped = text.length > 600 ? `${text.slice(0, 600)}…` : text;
      return `${who}: ${clipped}`;
    })
    .filter((line): line is string => line !== null);
  if (lines.length === 0) {
    return "";
  }
  return [
    `[Handoff — you are taking over this channel conversation from the previous agent (${params.fromHarness} → ${params.toHarness}). You don't share its memory, so here is the recent conversation for context. Continue seamlessly: don't re-introduce yourself or repeat this context back to the user.]`,
    ...lines,
    "[End of prior context — the user's new message follows.]",
    "",
    "",
  ].join("\n");
}

export function createChannelRuntimePort(store: RuntimeStateStore): ChannelRuntimePort {
  return {
    resolveWorkspaceId(): string | null {
      // workspace-removal Piece 4: single-tenant — inbound channel messages
      // always route to the one workspace; any per-connection binding or
      // requested id is ignored.
      return resolveCanonicalWorkspaceId(store) || null;
    },

    fireMessage({ message, sessionId, idempotencyKey }): FireMessageResult {
      const workspaceId = message.workspaceId;
      const workspace = store.getWorkspace(workspaceId);
      if (!workspace) throw new Error(`workspace not found: ${workspaceId}`);

      store.ensureSession({
        workspaceId,
        sessionId,
        kind: "main_session",
        title: message.chatTitle?.trim() || `${message.platform} chat`,
        createdBy: `im:${message.platform}`,
      });
      const desiredHarness = resolveChannelHarness(
        store,
        workspace,
        message.connectionId,
      );
      const channelModel = resolveChannelModel(
        store,
        workspace.id,
        message.connectionId,
      );
      const existingBinding = store.getBinding({ workspaceId, sessionId });
      // On a harness SWITCH (existing binding, different harness — not the first
      // bind), the conversation rebinds to a fresh harness session that shares no
      // memory with the prior agent. Carry the recent transcript forward so the
      // new agent continues seamlessly instead of starting blank.
      let harnessHandoffPreamble = "";
      if (!existingBinding || existingBinding.harness !== desiredHarness) {
        if (existingBinding && existingBinding.harness !== desiredHarness) {
          harnessHandoffPreamble = buildHarnessHandoffPreamble(store, {
            workspaceId,
            sessionId,
            fromHarness: existingBinding.harness,
            toHarness: desiredHarness,
          });
        }
        // First message for this conversation, OR the channel's harness was
        // switched from the desktop after it was first bound. A session's
        // harness is immutable, so (re)bind the conversation to a fresh harness
        // session under the chosen agent — the next message runs on it. The
        // conversation's own transcript persists.
        store.upsertBinding({
          workspaceId,
          sessionId,
          harness: desiredHarness,
          harnessSessionId: sessionId,
        });
      }
      store.ensureRuntimeState({ workspaceId, sessionId, status: "IDLE" });

      const conversationKey = message.threadId
        ? `${message.chatId}:thread:${message.threadId}`
        : message.chatId;
      store.upsertConversationBinding({
        workspaceId,
        channel: message.platform,
        conversationKey,
        sessionId,
        metadata: {
          chat_id: message.chatId,
          chat_type: message.chatType,
          thread_id: message.threadId ?? null,
          connection_id: message.connectionId,
          chat_title: message.chatTitle ?? null,
          user_id: message.userId,
          user_name: message.userName ?? null,
        },
      });

      const media =
        message.attachments.length > 0
          ? materializeAttachments(store.workspaceDir(workspaceId), message.attachments)
          : { attachments: [] as Array<Record<string, unknown>>, imageUrls: [] as string[] };

      // Idempotency: a duplicate key returns the existing input (no new turn).
      const existing = idempotencyKey
        ? store.getInputByIdempotencyKey({ workspaceId, idempotencyKey })
        : null;
      const input = store.enqueueInput({
        workspaceId,
        sessionId,
        idempotencyKey,
        payload: {
          text: harnessHandoffPreamble
            ? `${harnessHandoffPreamble}${message.text}`
            : message.text,
          attachments: media.attachments,
          image_urls: media.imageUrls,
          model: channelModel,
          thinking_value: null,
          context: {
            source: `im:${message.platform}`,
            delivery_bucket: "im_reply",
            channel: {
              platform: message.platform,
              connection_id: message.connectionId,
              chat_id: message.chatId,
              chat_type: message.chatType,
              thread_id: message.threadId ?? null,
              message_id: message.messageId ?? null,
            },
            sender: { user_id: message.userId, user_name: message.userName ?? null },
          },
        },
      });

      return { sessionId, inputId: input.inputId, created: existing === null };
    },

    pollOutputs({ workspaceId, sessionId, inputId, afterEventId }): PollOutputsResult {
      const events = store.listOutputEvents({ workspaceId, sessionId, inputId, afterEventId });
      let lastEventId = afterEventId;
      let terminal: PollOutputsResult["terminal"] = null;
      let finalText: string | null = null;
      let error: string | null = null;

      for (const event of events) {
        if (event.id > lastEventId) lastEventId = event.id;
        if (event.eventType === "run_completed") {
          terminal = "completed";
          const output = event.payload.output;
          if (typeof output === "string") finalText = output;
        } else if (event.eventType === "run_failed") {
          terminal = "failed";
          const failure = event.payload.error;
          if (typeof failure === "string") error = failure;
        }
      }

      return {
        events: events.map((event) => ({
          id: event.id,
          sequence: event.sequence,
          eventType: event.eventType,
          payload: event.payload,
        })),
        lastEventId,
        terminal,
        finalText,
        error,
      };
    },

    getTurnArtifacts(params): ChannelArtifact[] {
      const { workspaceId, sessionId, inputId } = params;
      let workspaceDir: string;
      try {
        workspaceDir = store.workspaceDir(workspaceId);
      } catch {
        return [];
      }
      let outputs: ReturnType<RuntimeStateStore["listOutputs"]>;
      try {
        outputs = store.listOutputs({
          workspaceId,
          sessionId,
          inputId,
          limit: 50,
        });
      } catch {
        return [];
      }
      const artifacts: ChannelArtifact[] = [];
      for (const output of outputs) {
        const rel = output.filePath;
        if (!rel) {
          continue;
        }
        const abs = path.isAbsolute(rel) ? rel : path.join(workspaceDir, rel);
        try {
          if (!fs.statSync(abs).isFile()) {
            continue;
          }
        } catch {
          continue;
        }
        const ext = path.extname(abs).toLowerCase();
        artifacts.push({
          kind: artifactKindForExt(ext),
          path: abs,
          name: path.basename(abs),
          mimeType: ARTIFACT_MIME_BY_EXT[ext],
        });
      }
      return artifacts;
    },
  };
}
