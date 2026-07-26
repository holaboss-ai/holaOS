import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChannelConfigClient, ChannelConnectionConfig } from "./config.js";
import type { ChannelCapabilities, ChannelConnector, IncomingMessageHandler } from "./connector.js";
import type { ConnectorFactory } from "./factory.js";
import { ChannelRuntimeManager } from "./manager.js";
import type { ChannelRuntimePort } from "./ports.js";

const CAPS: ChannelCapabilities = {
  editMessages: false,
  finalizeByResend: false,
  reactions: false,
  typing: false,
  typingRefreshMs: 0,
  markdown: "none",
  maxMessageLength: 4096,
  lengthUnit: "codepoints",
  interactiveButtons: false,
  threads: false,
  media: { image: false, document: false, voice: false, video: false },
};

const noopPort: ChannelRuntimePort = {
  resolveWorkspaceId: () => "w1",
  fireMessage: ({ sessionId }) => ({ sessionId, inputId: "i", created: true }),
  pollOutputs: () => ({ events: [], lastEventId: 0, terminal: null, finalText: null, error: null }),
  getTurnArtifacts: () => [],
};

class FakeConnector implements ChannelConnector {
  readonly platform = "telegram";
  readonly connectionId: string;
  readonly key: string;
  readonly capabilities = CAPS;
  started = 0;
  stopped = 0;
  readonly #fp: string;
  constructor(connectionId: string, fp: string) {
    this.connectionId = connectionId;
    this.key = `telegram:w1:${connectionId}`;
    this.#fp = fp;
  }
  fingerprint(): string {
    return this.#fp;
  }
  async start(): Promise<void> {
    this.started += 1;
  }
  async stop(): Promise<void> {
    this.stopped += 1;
  }
  onMessage(_handler: IncomingMessageHandler): void {}
  format(text: string): string {
    return text;
  }
  async sendText(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}

function cfg(connectionId: string, token: string): ChannelConnectionConfig {
  return { platform: "telegram", connectionId, enabled: true, workspaceId: "w1", token };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor timed out");
}

test("manager hot-reloads connectors as stored config changes", async () => {
  let configs: ChannelConnectionConfig[] = [];
  const all: FakeConnector[] = [];
  const configClient: ChannelConfigClient = { listConfigs: async () => configs };
  const factory: ConnectorFactory = (config) => {
    const connector = new FakeConnector(config.connectionId, `${config.connectionId}:${config.token}`);
    all.push(connector);
    return connector;
  };
  const net = (key: string): number => {
    const conns = all.filter((c) => c.key === key);
    return conns.reduce((s, c) => s + c.started, 0) - conns.reduce((s, c) => s + c.stopped, 0);
  };
  const totalStarts = (key: string): number =>
    all.filter((c) => c.key === key).reduce((s, c) => s + c.started, 0);

  const manager = new ChannelRuntimeManager({
    port: noopPort,
    configClient,
    connectorFactory: factory,
    refreshIntervalMs: 30,
  });

  try {
    await manager.start();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(net("telegram:w1:a"), 0, "nothing running with empty config");

    // Add connection a.
    configs = [cfg("a", "t1")];
    await waitFor(() => net("telegram:w1:a") === 1);

    // Change a's token → restart (old stops, new starts).
    configs = [cfg("a", "t2")];
    await waitFor(() => totalStarts("telegram:w1:a") === 2);
    assert.equal(net("telegram:w1:a"), 1, "exactly one 'a' running after restart");

    // Remove a → stop.
    configs = [];
    await waitFor(() => net("telegram:w1:a") === 0);
  } finally {
    await manager.close();
  }
});
