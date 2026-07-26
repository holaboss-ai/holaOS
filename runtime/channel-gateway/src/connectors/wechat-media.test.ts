import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ChannelConnectionConfig } from "../config.js";
import { mediaUrl, WeChatConnector } from "./wechat.js";

const CDN = "https://novac2c.cdn.weixin.qq.com/c2c";

// Regression: inbound media used to hit the CDN root with the raw param → HTTP 400.
// The download endpoint is `{cdn}/download?encrypted_query_param=<url-encoded>` (mirrors
// the `/upload` path).
test("mediaUrl builds the /download endpoint with an encoded encrypted_query_param", () => {
  assert.equal(
    mediaUrl({ encrypt_query_param: "a b&c=d" }, CDN),
    `${CDN}/download?encrypted_query_param=${encodeURIComponent("a b&c=d")}`,
  );
});

test("mediaUrl passes a full_url through only when it's an allowed WeixinCDN host", () => {
  assert.equal(mediaUrl({ full_url: `${CDN}/download?x=1` }, CDN), `${CDN}/download?x=1`);
  assert.equal(mediaUrl({ full_url: "https://evil.example/x" }, CDN), null);
  assert.equal(mediaUrl(undefined, CDN), null);
});

function makeConfig(): ChannelConnectionConfig {
  return {
    platform: "wechat",
    connectionId: "default",
    enabled: true,
    workspaceId: "w1",
    token: "tok",
  };
}

test("wechat: sendMedia registers, encrypts, uploads, and sends an image item", async () => {
  const connector = new WeChatConnector({ config: makeConfig() });
  const tmp = path.join(os.tmpdir(), `hb-wechat-media-test-${process.pid}.png`);
  await fsp.writeFile(tmp, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5])); // 9 bytes

  const calls: Array<{ url: string; method: string; body?: Record<string, unknown>; isBytes: boolean }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const isBytes = init?.body instanceof Uint8Array;
    const body =
      !isBytes && typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ url, method: init?.method ?? "GET", body, isBytes });
    if (url.includes("getuploadurl")) {
      return new Response(
        JSON.stringify({ errcode: 0, upload_full_url: "https://novac2c.cdn.weixin.qq.com/c2c/upload?p=1" }),
        { status: 200 },
      );
    }
    if (url.includes("/upload?")) {
      return new Response("ok", { status: 200, headers: { "x-encrypted-param": "ENCPARAM" } });
    }
    return new Response(JSON.stringify({ errcode: 0 }), { status: 200 }); // sendmessage
  }) as typeof fetch;

  try {
    const res = await connector.sendMedia({ chatId: "u1" }, { kind: "image", path: tmp, name: "cat.png" });
    assert.equal(res.ok, true);

    // 1) getuploadurl carries the right media_type, a 16-byte hex key, and the
    //    PKCS7-padded ciphertext size (9 bytes → 16).
    const up = calls.find((c) => c.url.includes("getuploadurl"));
    assert.ok(up, "getuploadurl was called");
    assert.equal(up!.body?.media_type, 1); // MEDIA_IMAGE
    assert.equal(String(up!.body?.aeskey).length, 32); // 16-byte key as hex
    assert.equal(up!.body?.filesize, 16);

    // 2) the ciphertext is POSTed to the CDN as raw bytes.
    const cdn = calls.find((c) => c.url.includes("/upload?"));
    assert.ok(cdn, "CDN upload was called");
    assert.equal(cdn!.method, "POST");
    assert.ok(cdn!.isBytes, "ciphertext posted as bytes");

    // 3) the send message references the upload, and aes_key is base64(hex-string).
    const send = calls.find((c) => c.url.includes("sendmessage"));
    const item = (send!.body?.msg as { item_list: Array<Record<string, any>> }).item_list[0];
    assert.equal(item.type, 2); // ITEM_IMAGE
    assert.equal(item.image_item.media.encrypt_query_param, "ENCPARAM");
    assert.equal(item.image_item.media.encrypt_type, 1);
    const decodedKey = Buffer.from(item.image_item.media.aes_key, "base64").toString("ascii");
    assert.match(decodedKey, /^[0-9a-f]{32}$/); // the hex string, not raw bytes
  } finally {
    globalThis.fetch = realFetch;
    await fsp.rm(tmp, { force: true });
  }
});
