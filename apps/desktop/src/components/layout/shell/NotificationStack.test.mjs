import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SOURCE_PATH = new URL("./NotificationStack.tsx", import.meta.url);

test("notification stack routes session-bound notifications into the chat session opener", async () => {
  const source = await readFile(SOURCE_PATH, "utf8");

  assert.match(source, /chatPanelViewAtom/);
  assert.match(source, /chatSessionOpenRequestAtom/);
  assert.match(source, /const sessionRequestKeyRef = useRef\(0\);/);
  assert.match(source, /if \(target\.sessionId\) \{/);
  assert.match(source, /setChatPanelView\("chat"\);/);
  assert.match(
    source,
    /setChatSessionOpenRequest\(\{\s*sessionId: target\.sessionId,\s*requestKey: sessionRequestKeyRef\.current,\s*mode: "session",\s*\}\);/,
  );
});
