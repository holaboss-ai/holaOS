import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";
import { seedWorkspaceRecord } from "../__test-helpers__/seed-workspace.js";

import {
  createDingtalkConnection,
  createFeishuConnection,
  createTelegramConnection,
  listConnectionViews,
  setConnectionHarness,
  setConnectionModel,
} from "./connection-service.js";
import { createStoreChannelConfigClient } from "./store-config-client.js";

function startMockTelegram(opts: {
  ok: boolean;
  username?: string;
}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if ((req.url ?? "").endsWith("/getMe")) {
        res.end(
          JSON.stringify(
            opts.ok
              ? { ok: true, result: { id: 1, username: opts.username } }
              : { ok: false, description: "Unauthorized" },
          ),
        );
        return;
      }
      res.end(JSON.stringify({ ok: true, result: true }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    }),
  );
}

function makeStore(): { store: RuntimeStateStore; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-conn-svc-"));
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  // Single-tenant: channel connections live under the canonical root workspace,
  // which is what the gateway config client (createStoreChannelConfigClient)
  // enumerates via listWorkspaces(). Production creates them with
  // resolveCanonicalWs() === "root", so the tests scope to "root" too.
  seedWorkspaceRecord(store, { workspaceId: "root", name: "Test", harness: "pi", status: "active" });
  return { store, cleanup: () => { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("valid token → connected, surfaced to the gateway config (token never in the view)", async () => {
  const mock = await startMockTelegram({ ok: true, username: "mybot" });
  const { store, cleanup } = makeStore();
  try {
    const result = await createTelegramConnection(store, {
      workspaceId: "root",
      token: "123:GOOD",
      apiBaseUrl: mock.baseUrl,
    });
    assert.equal(result.ok, true);
    assert.equal(result.connection?.botUsername, "mybot");
    assert.equal(result.connection?.status, "connected");
    assert.ok(!("token" in (result.connection as object)), "view must not leak the token");

    const views = listConnectionViews(store, "root");
    assert.equal(views.length, 1);
    assert.equal(views[0]!.status, "connected");

    const configs = await createStoreChannelConfigClient(store).listConfigs();
    assert.equal(configs.length, 1);
    assert.equal(configs[0]!.token, "123:GOOD");
    assert.equal(configs[0]!.apiBaseUrl, mock.baseUrl);
  } finally {
    cleanup();
    await mock.close();
  }
});

test("setConnectionModel sets then clears the per-channel model override", () => {
  const { store, cleanup } = makeStore();
  try {
    store.upsertChannelConnection({
      workspaceId: "root",
      connectionId: "c1",
      platform: "telegram",
      config: { token: "t" },
    });

    const set = setConnectionModel(store, {
      workspaceId: "root",
      connectionId: "c1",
      model: "openai/gpt-5.4",
    });
    assert.equal(set?.model, "openai/gpt-5.4");
    assert.equal(listConnectionViews(store, "root")[0]!.model, "openai/gpt-5.4");

    // null clears the override (inherit the harness/workspace default).
    const cleared = setConnectionModel(store, {
      workspaceId: "root",
      connectionId: "c1",
      model: null,
    });
    assert.equal(cleared?.model, null);
    assert.equal(listConnectionViews(store, "root")[0]!.model, null);

    // Unknown connection → null (NOT_FOUND upstream).
    assert.equal(
      setConnectionModel(store, { workspaceId: "root", connectionId: "nope", model: "x" }),
      null,
    );
  } finally {
    cleanup();
  }
});

test("switching the harness clears the per-channel model override", () => {
  const { store, cleanup } = makeStore();
  try {
    // A channel pinned to Claude Code with a claude-namespaced model.
    store.upsertChannelConnection({
      workspaceId: "root",
      connectionId: "c1",
      platform: "telegram",
      config: { token: "t", harness: "claude-code", model: "claude-sonnet-4-6" },
    });
    assert.equal(listConnectionViews(store, "root")[0]!.model, "claude-sonnet-4-6");

    // Switching to pi invalidates that model (different namespace) → it's dropped,
    // so the channel runs on pi's default until a pi model is picked.
    const view = setConnectionHarness(store, {
      workspaceId: "root",
      connectionId: "c1",
      harness: "pi",
    });
    assert.equal(view?.harness, "pi");
    assert.equal(view?.model, null, "model override cleared on harness switch");
  } finally {
    cleanup();
  }
});

test("bad token → error + disabled, NOT surfaced to the manager", async () => {
  const mock = await startMockTelegram({ ok: false });
  const { store, cleanup } = makeStore();
  try {
    const result = await createTelegramConnection(store, {
      workspaceId: "root",
      token: "123:BAD",
      apiBaseUrl: mock.baseUrl,
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Unauthorized/);

    const views = listConnectionViews(store, "root");
    assert.equal(views[0]!.status, "error");

    const configs = await createStoreChannelConfigClient(store).listConfigs();
    assert.equal(configs.length, 0, "a disabled/errored connection is never started");
  } finally {
    cleanup();
    await mock.close();
  }
});

test("createFeishuConnection stores creds in config_json + surfaces to the gateway config", async () => {
  const { store, cleanup } = makeStore();
  try {
    const view = createFeishuConnection(store, {
      workspaceId: "root",
      appId: "cli_x",
      appSecret: "sec_y",
      domain: "feishu",
      openId: "ou_1",
      botName: "MyAgent",
    });
    assert.equal(view.platform, "feishu");
    assert.equal(view.status, "connected");
    assert.equal(view.botUsername, "MyAgent");

    const record = store.listChannelConnections({ workspaceId: "root" })[0]!;
    assert.equal(record.token, null, "no token column for Feishu");
    assert.equal(record.config.appId, "cli_x");
    assert.equal(record.config.appSecret, "sec_y");
    assert.equal(record.config.domain, "feishu");

    const configs = await createStoreChannelConfigClient(store).listConfigs();
    assert.equal(configs.length, 1);
    assert.equal(configs[0]!.platform, "feishu");
    assert.equal(configs[0]!.appId, "cli_x");
    assert.equal(configs[0]!.appSecret, "sec_y");
    assert.equal(configs[0]!.domain, "feishu");
    assert.equal(configs[0]!.token, undefined, "no token surfaced for Feishu");
  } finally {
    cleanup();
  }
});

test("createDingtalkConnection stores clientId/secret in config_json + surfaces to the gateway config", async () => {
  const { store, cleanup } = makeStore();
  try {
    const view = createDingtalkConnection(store, {
      workspaceId: "root",
      appId: "ding_client",
      appSecret: "ding_secret",
      botName: "MyAgent",
    });
    assert.equal(view.platform, "dingtalk");
    assert.equal(view.status, "connected");
    assert.equal(view.botUsername, "MyAgent");

    const record = store.listChannelConnections({ workspaceId: "root" })[0]!;
    assert.equal(record.token, null, "no token column for DingTalk");
    assert.equal(record.config.appId, "ding_client");
    assert.equal(record.config.appSecret, "ding_secret");

    const configs = await createStoreChannelConfigClient(store).listConfigs();
    assert.equal(configs.length, 1);
    assert.equal(configs[0]!.platform, "dingtalk");
    assert.equal(configs[0]!.appId, "ding_client");
    assert.equal(configs[0]!.appSecret, "ding_secret");
    assert.equal(configs[0]!.token, undefined, "no token surfaced for DingTalk");
  } finally {
    cleanup();
  }
});
