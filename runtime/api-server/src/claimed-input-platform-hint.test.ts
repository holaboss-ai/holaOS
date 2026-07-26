import assert from "node:assert/strict";
import test from "node:test";

import { instructionWithPlatformHint } from "./claimed-input-executor.js";

test("IM turns get a surface hint folded into the instruction", () => {
  const wechat = instructionWithPlatformHint({
    baseInstruction: "hello agent",
    context: { source: "im:wechat" },
  });
  assert.ok(wechat.startsWith("hello agent"));
  assert.match(wechat, /\[Channel\]/);
  assert.match(wechat, /WeChat/);
  // WeChat delivers verbatim text — the agent must avoid Markdown syntax.
  assert.match(wechat, /without Markdown/i);
  // No UI cards / OAuth on channels: route the user to the desktop app.
  assert.match(wechat, /desktop app/i);
  assert.match(wechat, /Never promise/i);

  const telegram = instructionWithPlatformHint({
    baseInstruction: "hello agent",
    context: { source: "im:telegram" },
  });
  // Telegram egress formats light Markdown, so no plain-text-only warning.
  assert.doesNotMatch(telegram, /without Markdown/i);
  assert.match(telegram, /desktop app/i);

  // Unknown platforms fall back to the safest (plain-text) hint.
  const unknown = instructionWithPlatformHint({
    baseInstruction: "hello agent",
    context: { source: "im:newapp" },
  });
  assert.match(unknown, /without Markdown/i);
});

test("non-IM turns are untouched", () => {
  for (const context of [
    null,
    {},
    { source: "desktop" },
    { source: "cronjob" },
  ]) {
    assert.equal(
      instructionWithPlatformHint({ baseInstruction: "hello agent", context }),
      "hello agent",
    );
  }
});
