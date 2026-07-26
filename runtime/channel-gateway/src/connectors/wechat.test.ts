import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";

import { WeChatConnector, aesEcbDecrypt, parseAesKey } from "./wechat.js";

const baseConfig = {
  platform: "wechat" as const,
  connectionId: "c1",
  enabled: true,
  workspaceId: "w",
  token: "sess-token",
  apiBaseUrl: "https://ilinkai.weixin.qq.com",
  extra: { accountId: "bot@im.bot" },
};

test("WeChatConnector exposes iLink capabilities + working-text ack", () => {
  const connector = new WeChatConnector({ config: baseConfig });
  assert.equal(connector.platform, "wechat");
  assert.equal(connector.capabilities.reactions, false);
  assert.equal(connector.capabilities.typing, false);
  assert.equal(connector.capabilities.markdown, "none");
  assert.ok((connector.workingText ?? "").length > 0);
});

test("WeChatConnector requires a session token", () => {
  assert.throws(
    () =>
      new WeChatConnector({
        config: { platform: "wechat", connectionId: "c1", enabled: true, workspaceId: "w" },
      }),
    /session token/,
  );
});

test("parseAesKey accepts hex and base64 16-byte keys", () => {
  const hex = "00112233445566778899aabbccddeeff";
  assert.equal(parseAesKey(hex).length, 16);
  const b64 = Buffer.from(hex, "hex").toString("base64");
  assert.equal(parseAesKey(b64).length, 16);
  assert.deepEqual(parseAesKey(hex), parseAesKey(b64));
});

test("aesEcbDecrypt reverses AES-128-ECB + PKCS7 encryption", () => {
  const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const plaintext = Buffer.from("hello iLink media payload 🐧", "utf8");
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(true);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const decrypted = aesEcbDecrypt(encrypted, key);
  assert.deepEqual(decrypted, plaintext);
});

test("aesEcbDecrypt leaves non-block-aligned input untouched", () => {
  const key = Buffer.alloc(16, 1);
  const odd = Buffer.from([1, 2, 3]); // not a multiple of 16
  assert.deepEqual(aesEcbDecrypt(odd, key), odd);
});
