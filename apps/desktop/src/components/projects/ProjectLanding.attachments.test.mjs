import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PROJECT_LANDING_PATH = new URL("./ProjectLanding.tsx", import.meta.url);

test("project landing stages pending attachments before queuing the first input", async () => {
  const source = await readFile(PROJECT_LANDING_PATH, "utf8");

  assert.match(
    source,
    /const \[pendingAttachments, setPendingAttachments\] = useState</,
  );
  assert.match(
    source,
    /const stagedAttachments = await stagePendingFileAttachments\(/,
  );
  assert.match(
    source,
    /await window\.electronAPI\.workspace\.queueSessionInput\(\{[\s\S]*?attachments: stagedAttachments,/,
  );
  assert.match(source, /attachments=\{pendingAttachmentItems\}/);
  assert.match(source, /onAttachmentInputChange=\{onAttachmentInputChange\}/);
  assert.match(source, /onAddDroppedFiles=\{appendPendingLocalFiles\}/);
  assert.match(
    source,
    /onAddExplorerAttachments=\{appendPendingExplorerAttachments\}/,
  );
  assert.match(source, /onRemoveAttachment=\{removePendingAttachment\}/);
});

test("project landing keeps the created session and pending files available for retry", async () => {
  const source = await readFile(PROJECT_LANDING_PATH, "utf8");

  assert.match(source, /const pendingSessionIdRef = useRef<string \| null>\(null\);/);
  assert.match(source, /let sessionId = pendingSessionIdRef\.current;/);
  assert.match(source, /pendingSessionIdRef\.current = sessionId;/);
  assert.match(
    source,
    /await window\.electronAPI\.workspace\.queueSessionInput\([\s\S]*?setPendingAttachments\(\[\]\);\s*pendingSessionIdRef\.current = null;/,
  );
  const submitCatch = source.match(
    /\n    \} catch \(err\) \{\s*setError\([\s\S]*?\n    \} finally \{/,
  );
  assert.ok(submitCatch);
  assert.doesNotMatch(submitCatch[0], /setPendingAttachments\(\[\]\)/);
});
