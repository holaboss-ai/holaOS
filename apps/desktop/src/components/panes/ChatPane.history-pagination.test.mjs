import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "ChatPane", "index.tsx");
// Page-size and threshold constants moved to the shared constants module
// when ChatPane was split into a directory.
const constantsPath = path.join(__dirname, "ChatPane", "constants.ts");

test("chat pane loads the newest history page first and prepends older messages on top scroll", async () => {
  const [source, constants] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(constantsPath, "utf8"),
  ]);

  assert.match(constants, /export const CHAT_HISTORY_PAGE_SIZE = \d+;/);
  assert.match(
    constants,
    /export const CHAT_HISTORY_TOP_LOAD_THRESHOLD_PX = \d+;/,
  );
  assert.match(
    source,
    /window\.electronAPI\.workspace\.getSessionHistory\(\{\s*sessionId: params\.sessionId,\s*workspaceId: params\.workspaceId,\s*limit: params\.limit,\s*offset: params\.offset,\s*order: params\.order,\s*\}\)/,
  );
  assert.match(
    source,
    /limit: CHAT_HISTORY_PAGE_SIZE,\s*offset: 0,\s*order: "desc",/,
  );
  assert.match(
    source,
    /async function loadOlderSessionHistory\(\)[\s\S]*offset: loadedHistoryMessageCount,[\s\S]*order: "desc",/,
  );
  assert.match(
    source,
    /currentTarget\.scrollTop <=\s*CHAT_HISTORY_TOP_LOAD_THRESHOLD_PX[\s\S]*void loadOlderSessionHistory\(\);/,
  );
  assert.match(source, /function assistantInputIdsFromChatMessages\(messages: ChatMessage\[]\)/);
  assert.match(source, /function prependUniqueChatMessages\(/);
  assert.match(
    source,
    /knownAssistantInputIds: assistantInputIdsFromChatMessages\(messages\),/,
  );
  assert.match(
    source,
    /setMessages\(\(prev\) =>\s*prependUniqueChatMessages\(page\.renderedMessages, prev\),\s*\);/,
  );
  assert.match(
    source,
    /const scrollHeightDelta =\s*container\.scrollHeight - pendingRestore\.scrollHeight;/,
  );
  assert.match(
    source,
    /container\.scrollTop = pendingRestore\.scrollTop \+ scrollHeightDelta;/,
  );
});
