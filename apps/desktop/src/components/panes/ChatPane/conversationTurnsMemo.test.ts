import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "ConversationTurns.tsx"), "utf-8");

/**
 * AssistantTurn is memoized on a comparator that compares its array/object
 * props BY REFERENCE. A fresh `?? []` literal in the JSX therefore defeats the
 * memo for every message lacking that field — which is every message, for the
 * rarely-populated fields. One missed prop is enough to make the whole
 * comparator useless, so this guards the invariant rather than any one prop.
 */
function assistantTurnJsx(): string {
  const open = source.indexOf("<AssistantTurn");
  assert.notEqual(open, -1, "ConversationTurns must still render <AssistantTurn>");
  const close = source.indexOf("/>", open);
  assert.notEqual(close, -1, "could not find the end of the <AssistantTurn> element");
  return source.slice(open, close);
}

test("no AssistantTurn prop is defaulted to a freshly allocated literal", () => {
  const jsx = assistantTurnJsx();
  const inlineDefaults = [...jsx.matchAll(/(\w+)=\{[^}]*\?\?\s*(\[\]|\{\})/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    inlineDefaults,
    [],
    `these props allocate a new value every render, so the memo can never hit: ${inlineDefaults.join(", ")}`,
  );
});

test("backgroundTaskReferences uses the shared empty, like its siblings", () => {
  assert.match(source, /const NO_BACKGROUND_TASK_REFERENCES/);
  assert.match(
    assistantTurnJsx(),
    /backgroundTaskReferences=\{\s*message\.backgroundTaskReferences \?\? NO_BACKGROUND_TASK_REFERENCES\s*\}/,
  );
});
