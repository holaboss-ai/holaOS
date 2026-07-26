import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { beginDingtalkRegistration, pollDingtalkRegistration } from "./dingtalk-auth.js";

interface MockState {
  pollCalls: number;
  succeedAfter: number;
}

function startMock(state: MockState): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "";
      const json = (obj: unknown): void => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (url.endsWith("/init")) return json({ errcode: 0, nonce: "nonce-1" });
      if (url.endsWith("/begin")) {
        return json({
          errcode: 0,
          device_code: "dev-1",
          verification_uri_complete: "https://login.dingtalk.com/qr?code=abc",
          interval: 1,
          expires_in: 7200,
        });
      }
      if (url.endsWith("/poll")) {
        state.pollCalls += 1;
        if (state.pollCalls >= state.succeedAfter) {
          return json({ errcode: 0, status: "SUCCESS", client_id: "ding_key", client_secret: "ding_secret" });
        }
        return json({ errcode: 0, status: "WAITING" });
      }
      return json({ errcode: 0 });
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

test("begin returns device code + QR; poll waits then yields client_id/secret", async () => {
  const state: MockState = { pollCalls: 0, succeedAfter: 2 };
  const mock = await startMock(state);
  try {
    const start = await beginDingtalkRegistration({ baseUrl: mock.baseUrl });
    assert.equal(start.deviceCode, "dev-1");
    assert.match(start.qrUrl, /qr\?code=abc/);

    const pending = await pollDingtalkRegistration(start.deviceCode, { baseUrl: mock.baseUrl });
    assert.equal(pending.status, "pending");

    const success = await pollDingtalkRegistration(start.deviceCode, { baseUrl: mock.baseUrl });
    assert.equal(success.status, "success");
    assert.equal(success.appId, "ding_key");
    assert.equal(success.appSecret, "ding_secret");
  } finally {
    await mock.close();
  }
});

test("errcode != 0 surfaces an error", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ errcode: 88, errmsg: "bad source" }));
    });
  });
  const baseUrl = await new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );
  try {
    await assert.rejects(() => beginDingtalkRegistration({ baseUrl }), /bad source|errcode=88/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
