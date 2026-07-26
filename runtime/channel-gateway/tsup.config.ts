import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  outDir: "dist",
  clean: true,
  splitting: false,
  platform: "node",
  target: "node20",
  sourcemap: true,
  dts: true,
  // The Lark + DingTalk + Discord + Slack SDKs are dynamically imported and
  // resolved at runtime from the api-server's vendored node_modules — never
  // bundle them here.
  external: [
    "@larksuiteoapi/node-sdk",
    "dingtalk-stream-sdk-nodejs",
    "discord.js",
    "@slack/web-api",
    "@slack/socket-mode",
    "qq-official-bot",
    "@wecom/aibot-node-sdk",
  ],
  outExtension() {
    return {
      js: ".mjs"
    };
  }
});
