import type { ChannelConfigClient, ChannelConnectionConfig } from "./config.js";
import type { ChannelConnector } from "./connector.js";
import { ChannelEgress, type LoggerLike } from "./egress.js";
import type { ConnectorFactory } from "./factory.js";
import { ChannelIngress } from "./ingress.js";
import type { ChannelRuntimePort } from "./ports.js";

/** Reported when a connector transitions to connected/error, for live UI status. */
export interface ChannelStatusEvent {
  key: string;
  platform: string;
  connectionId: string;
  workspaceId: string | null;
  status: "connected" | "error";
  detail?: string;
}

export interface ChannelRuntimeManagerOptions {
  port: ChannelRuntimePort;
  configClient: ChannelConfigClient;
  connectorFactory: ConnectorFactory;
  logger?: LoggerLike;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Hot-reload cadence — how often to reconcile connectors with stored config. */
  refreshIntervalMs?: number;
  onStatus?: (event: ChannelStatusEvent) => void;
}

/**
 * Owns connector lifecycles for the runtime, exposing the `{ start, close }` shape
 * wired next to the cron/queue workers. Reconciles running connectors against the
 * config source on an interval (fingerprint diff), so adding/removing a connection
 * in the desktop UI connects/disconnects live without a runtime restart.
 */
export class ChannelRuntimeManager {
  readonly #options: ChannelRuntimeManagerOptions;
  readonly #ingress: ChannelIngress;
  readonly #connectors = new Map<string, ChannelConnector>();
  readonly #abort = new AbortController();
  #started = false;
  #reconciling = false;
  #refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ChannelRuntimeManagerOptions) {
    this.#options = options;
    const egress = new ChannelEgress({
      port: options.port,
      logger: options.logger,
      pollIntervalMs: options.pollIntervalMs,
      timeoutMs: options.timeoutMs,
    });
    this.#ingress = new ChannelIngress({ port: options.port, egress, logger: options.logger });
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    // Fire the first reconcile without blocking startup on network (getMe).
    void this.#reconcile();
    const intervalMs = Math.max(1000, this.#options.refreshIntervalMs ?? 4000);
    this.#refreshTimer = setInterval(() => void this.#reconcile(), intervalMs);
    this.#refreshTimer.unref?.();
  }

  /** Force an immediate reconcile — call right after a connection is added/removed. */
  async refresh(): Promise<void> {
    await this.#reconcile();
  }

  async close(): Promise<void> {
    if (this.#refreshTimer) {
      clearInterval(this.#refreshTimer);
      this.#refreshTimer = null;
    }
    this.#abort.abort();
    const connectors = [...this.#connectors.values()];
    this.#connectors.clear();
    await Promise.allSettled(connectors.map((connector) => connector.stop()));
  }

  async #reconcile(): Promise<void> {
    if (this.#reconciling || this.#abort.signal.aborted) return;
    this.#reconciling = true;
    try {
      let configs: ChannelConnectionConfig[];
      try {
        configs = (await this.#options.configClient.listConfigs()).filter((config) => config.enabled);
      } catch (err) {
        this.#options.logger?.error?.("channel manager: failed to load configs", err);
        return;
      }

      const desired = new Map<string, { config: ChannelConnectionConfig; connector: ChannelConnector }>();
      for (const config of configs) {
        let connector: ChannelConnector | null = null;
        try {
          connector = this.#options.connectorFactory(config);
        } catch (err) {
          this.#options.logger?.error?.(`channel manager: factory failed for ${config.platform}`, err);
          continue;
        }
        if (!connector) {
          this.#options.logger?.warn?.(`channel manager: unsupported platform ${config.platform}`);
          continue;
        }
        desired.set(connector.key, { config, connector });
      }

      for (const key of [...this.#connectors.keys()]) {
        if (!desired.has(key)) await this.#stopConnector(key);
      }

      for (const [key, entry] of desired) {
        if (this.#abort.signal.aborted) break;
        const current = this.#connectors.get(key);
        if (current) {
          if (current.fingerprint() === entry.connector.fingerprint()) continue;
          await this.#stopConnector(key);
        }
        await this.#startConnector(entry.connector, entry.config);
      }
    } finally {
      this.#reconciling = false;
    }
  }

  async #startConnector(connector: ChannelConnector, config: ChannelConnectionConfig): Promise<void> {
    connector.onMessage((message) =>
      this.#ingress.handle({ connector, message, signal: this.#abort.signal }),
    );
    try {
      await connector.start();
      this.#connectors.set(connector.key, connector);
      this.#options.logger?.info?.(`channel manager: started ${connector.key}`);
      this.#options.onStatus?.({
        key: connector.key,
        platform: config.platform,
        connectionId: config.connectionId,
        workspaceId: config.workspaceId ?? null,
        status: "connected",
      });
    } catch (err) {
      // Fold the reason into the message string — the structured logger drops the
      // error arg, which made start failures (bad token, disallowed intents,
      // missing SDK) opaque in runtime.log.
      const reason = err instanceof Error ? err.message : String(err);
      this.#options.logger?.error?.(`channel manager: failed to start ${connector.key}: ${reason}`, err);
      this.#options.onStatus?.({
        key: connector.key,
        platform: config.platform,
        connectionId: config.connectionId,
        workspaceId: config.workspaceId ?? null,
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async #stopConnector(key: string): Promise<void> {
    const connector = this.#connectors.get(key);
    if (!connector) return;
    this.#connectors.delete(key);
    try {
      await connector.stop();
      this.#options.logger?.info?.(`channel manager: stopped ${key}`);
    } catch (err) {
      this.#options.logger?.warn?.(`channel manager: error stopping ${key}`, err);
    }
  }
}
