import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { beginWechatRegistration, pollWechatRegistration } from "./wechat-auth.js";

interface MockState {
  pollCalls: number;
  confirmAfter: number;
}

function startMock(state: MockState): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    const json = (obj: unknown): void => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (url.startsWith("/ilink/bot/get_bot_qrcode")) {
      return json({ qrcode: "qr-token-123", qrcode_img_content: "https://applink.weixin.qq.com/x" });
    }
    if (url.startsWith("/ilink/bot/get_qrcode_status")) {
      state.pollCalls += 1;
      if (state.pollCalls >= state.confirmAfter) {
        return json({
          status: "confirmed",
          ilink_bot_id: "a5ace6fd@im.bot",
          bot_token: "sess-token-xyz",
          baseurl: "https://ilinkai.weixin.qq.com",
          ilink_user_id: "ou_user_1",
        });
      }
      return json({ status: "wait" });
    }
    json({});
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

test("beginWechatRegistration returns a device code + scannable QR url", async () => {
  const state: MockState = { pollCalls: 0, confirmAfter: 2 };
  const mock = await startMock(state);
  try {
    const start = await beginWechatRegistration({ baseUrl: mock.baseUrl });
    assert.equal(start.deviceCode, "qr-token-123");
    assert.equal(start.qrUrl, "https://applink.weixin.qq.com/x");
    assert.ok(start.expiresInSec > 0);
  } finally {
    await mock.close();
  }
});

test("pollWechatRegistration returns pending then success with credentials", async () => {
  const state: MockState = { pollCalls: 0, confirmAfter: 2 };
  const mock = await startMock(state);
  try {
    const first = await pollWechatRegistration("qr-token-123", { baseUrl: mock.baseUrl });
    assert.equal(first.status, "pending");
    const second = await pollWechatRegistration("qr-token-123", { baseUrl: mock.baseUrl });
    assert.equal(second.status, "success");
    assert.equal(second.botId, "a5ace6fd@im.bot");
    assert.equal(second.token, "sess-token-xyz");
    assert.equal(second.userId, "ou_user_1");
  } finally {
    await mock.close();
  }
});
