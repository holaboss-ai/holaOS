import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "ChatPane.tsx");

test("user turns keep a visible bubble when the parsed prompt body is empty", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const userBubbleText = parsedQuotedSkills\.body \|\| text\.trim\(\);/,
  );
  assert.match(
    source,
    /setShowExpandButton\(node\.scrollHeight > 188\);[\s\S]*\}, \[userBubbleText\]\);/,
  );
  assert.match(source, /\{userBubbleText \? \(/);
  assert.match(
    source,
    /<SimpleMarkdown[\s\S]*className="chat-markdown chat-user-markdown max-w-full"[\s\S]*\{userBubbleText\}[\s\S]*<\/SimpleMarkdown>/,
  );
});
