import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { beginFeishuRegistration, pollFeishuRegistration } from "./feishu-auth.js";

interface MockState {
  pollCalls: number;
  succeedAfter: number;
}

function startMock(state: MockState): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const action = params.get("action");
      const json = (obj: unknown): void => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (action === "init") return json({ supported_auth_methods: ["client_secret"] });
      if (action === "begin") {
        return json({
          device_code: "dev-123",
          verification_uri_complete: "https://applink.feishu.cn/client/qrcode?code=abc",
          user_code: "ABCD",
          interval: 1,
          expire_in: 600,
        });
      }
      if (action === "poll") {
        state.pollCalls += 1;
        if (state.pollCalls >= state.succeedAfter) {
          return json({
            client_id: "cli_app123",
            client_secret: "secret456",
            user_info: { open_id: "ou_user", tenant_brand: "feishu" },
          });
        }
        return json({ error: "authorization_pending" });
      }
      return json({});
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

test("begin returns a device code + QR url; poll pends then yields app credentials", async () => {
  const state: MockState = { pollCalls: 0, succeedAfter: 2 };
  const mock = await startMock(state);
  try {
    const start = await beginFeishuRegistration({ baseUrl: mock.baseUrl });
    assert.equal(start.deviceCode, "dev-123");
    assert.match(start.qrUrl, /qrcode\?code=abc/);
    assert.match(start.qrUrl, /from=holaos/);

    const pending = await pollFeishuRegistration(start.deviceCode, { baseUrl: mock.baseUrl });
    assert.equal(pending.status, "pending");

    const success = await pollFeishuRegistration(start.deviceCode, { baseUrl: mock.baseUrl });
    assert.equal(success.status, "success");
    assert.equal(success.appId, "cli_app123");
    assert.equal(success.appSecret, "secret456");
    assert.equal(success.domain, "feishu");
    assert.equal(success.openId, "ou_user");
  } finally {
    await mock.close();
  }
});

test("poll surfaces denied/expired terminal states", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "access_denied" }));
    });
  });
  const baseUrl = await new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );
  try {
    const result = await pollFeishuRegistration("dev-x", { baseUrl });
    assert.equal(result.status, "denied");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
