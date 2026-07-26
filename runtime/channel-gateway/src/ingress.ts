import type { ChannelConnector, IncomingMessage } from "./connector.js";
import { ChannelEgress, type LoggerLike } from "./egress.js";
import type { ChannelRuntimePort } from "./ports.js";
import { sessionIdForMessage } from "./session-key.js";

export interface ChannelIngressOptions {
  port: ChannelRuntimePort;
  egress: ChannelEgress;
  logger?: LoggerLike;
}

/**
 * Turns a normalized inbound message into a headless agent turn: resolve the
 * workspace, derive the durable session id, fire the message (create-or-reuse
 * session + enqueue), then hand off to the egress watcher for the reply. The
 * egress runs in the background so the connector's poll loop is never blocked.
 */
export class ChannelIngress {
  readonly #port: ChannelRuntimePort;
  readonly #egress: ChannelEgress;
  readonly #logger?: LoggerLike;

  constructor(options: ChannelIngressOptions) {
    this.#port = options.port;
    this.#egress = options.egress;
    this.#logger = options.logger;
  }

  async handle(params: {
    connector: ChannelConnector;
    message: IncomingMessage;
    signal?: AbortSignal;
  }): Promise<void> {
    const { connector, signal } = params;
    let message = params.message;
    if (!message.text.trim() && message.attachments.length === 0) return;

    const workspaceId = this.#port.resolveWorkspaceId({
      platform: message.platform,
      connectionId: message.connectionId,
      requestedWorkspaceId: message.workspaceId || null,
    });
    if (!workspaceId) {
      this.#logger?.warn?.(
        `channel ingress: no workspace for ${message.platform}/${message.connectionId}; dropping message`,
      );
      return;
    }
    message = { ...message, workspaceId };

    const sessionId = sessionIdForMessage(message);
    const idempotencyKey = this.#idempotencyKey(message);

    let fired;
    try {
      fired = this.#port.fireMessage({ message, sessionId, idempotencyKey });
    } catch (err) {
      this.#logger?.error?.("channel ingress: fireMessage failed", err);
      return;
    }

    if (!fired.created) {
      this.#logger?.debug?.(`channel ingress: duplicate ${idempotencyKey ?? "(no key)"}; skipping`);
      return;
    }

    // Fire-and-forget: do not block the connector's inbound loop on the agent turn.
    void this.#egress
      .watch({ connector, message, sessionId: fired.sessionId, inputId: fired.inputId, signal })
      .catch((err) => this.#logger?.error?.("channel ingress: egress watch crashed", err));
  }

  #idempotencyKey(message: IncomingMessage): string | null {
    const prefix = `im:${message.platform}:${message.connectionId}`;
    if (message.updateId != null) return `${prefix}:update:${message.updateId}`;
    if (message.messageId) return `${prefix}:msg:${message.messageId}`;
    return null;
  }
}
