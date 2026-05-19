import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "ChatPane.tsx");

test("chat pane can consume a one-shot composer prefill request", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /interface ChatPaneComposerPrefillRequest \{\s*text: string;\s*requestKey: number;\s*mode\?: "replace" \| "append";\s*\}/);
  assert.match(source, /composerPrefillRequest\?: ChatPaneComposerPrefillRequest \| null;/);
  assert.match(source, /onComposerPrefillConsumed\?: \(requestKey: number\) => void;/);
  assert.match(source, /const lastHandledComposerPrefillRequestKeyRef = useRef\(0\);/);
  assert.match(source, /const requestKey = composerPrefillRequest\?\.requestKey \?\? 0;/);
  assert.match(source, /requestKey === lastHandledComposerPrefillRequestKeyRef\.current/);
  assert.match(source, /const prefillMode = composerPrefillRequest\?\.mode \?\? "replace";/);
  assert.match(source, /if \(prefillMode === "append"\) \{/);
  assert.match(
    source,
    /setInput\(\(current\) =>\s*appendComposerPrefillText\(current, composerPrefillRequest\?\.text \?\? ""\),\s*\);/,
  );
  assert.match(source, /const parsedPrefill = parseSerializedQuotedSkillPrompt\(/);
  assert.match(source, /setInput\(parsedPrefill\.body\);/);
  assert.match(source, /setQuotedSkillIds\(parsedPrefill\.skillIds\);/);
  assert.match(source, /setPendingAttachments\(\[\]\);/);
  assert.match(source, /onComposerPrefillConsumed\?\.\(requestKey\);/);
});

test("chat pane appends reference prefills without clearing draft state", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function appendComposerPrefillText\(currentInput: string, text: string\) \{/);
  assert.match(source, /const normalizedText = text\.trim\(\);/);
  assert.match(source, /if \(!normalizedText\) \{\s*return currentInput;\s*\}/);
  assert.match(source, /if \(!currentInput\.trim\(\)\) \{\s*return normalizedText;\s*\}/);
  assert.match(source, /return \/\[\\s\(\]\$\/\.test\(currentInput\)/);
  assert.match(
    source,
    /if \(prefillMode === "append"\) \{\s*setInput\(\(current\) =>\s*appendComposerPrefillText\(current, composerPrefillRequest\?\.text \?\? ""\),\s*\);\s*\} else \{\s*const parsedPrefill = parseSerializedQuotedSkillPrompt\(/,
  );
});

test("chat pane can consume a one-shot explorer attachment request", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /interface ChatPaneExplorerAttachmentRequest \{\s*files: ExplorerAttachmentDragPayload\[];\s*requestKey: number;\s*\}/,
  );
  assert.match(
    source,
    /explorerAttachmentRequest\?: ChatPaneExplorerAttachmentRequest \| null;/,
  );
  assert.match(
    source,
    /onExplorerAttachmentRequestConsumed\?: \(requestKey: number\) => void;/,
  );
  assert.match(
    source,
    /const lastHandledExplorerAttachmentRequestKeyRef = useRef\(0\);/,
  );
  assert.match(
    source,
    /function appendPendingExplorerAttachments\(\s*files: ExplorerAttachmentDragPayload\[],\s*\) \{/,
  );
  assert.match(source, /resolveExplorerAttachmentKind\(file\) === "image"/);
  assert.match(
    source,
    /kind: resolveExplorerAttachmentKind\(file\)/,
  );
  assert.match(
    source,
    /stageSessionAttachmentPaths\(\{\s*workspace_id: selectedWorkspace\.id,\s*files: explorerFiles\.map\(\(entry\) => \(\{\s*absolute_path: entry\.absolutePath,\s*name: entry\.name,\s*mime_type: entry\.mime_type \?\? null,\s*kind: entry\.kind,\s*\}\)\),\s*\}\)/,
  );
  assert.match(
    source,
    /const requestKey = explorerAttachmentRequest\?\.requestKey \?\? 0;/,
  );
  assert.match(
    source,
    /requestKey === lastHandledExplorerAttachmentRequestKeyRef\.current/,
  );
  assert.match(
    source,
    /appendPendingExplorerAttachments\(explorerAttachmentRequest\?\.files \?\? \[\]\);/,
  );
  assert.match(
    source,
    /onExplorerAttachmentRequestConsumed\?\.\(requestKey\);/,
  );
});

test("chat pane can consume a one-shot artifact browser request", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /interface ChatPaneArtifactBrowserRequest \{\s*workspaceId: string;\s*outputs: WorkspaceOutputRecordPayload\[];\s*requestKey: number;\s*scope\?: "reply" \| "session";\s*\}/,
  );
  assert.match(
    source,
    /artifactBrowserRequest\?: ChatPaneArtifactBrowserRequest \| null;/,
  );
  assert.match(
    source,
    /onArtifactBrowserRequestConsumed\?: \(requestKey: number\) => void;/,
  );
  assert.match(
    source,
    /const lastHandledArtifactBrowserRequestKeyRef = useRef\(0\);/,
  );
  assert.match(
    source,
    /const requestKey = artifactBrowserRequest\?\.requestKey \?\? 0;/,
  );
  assert.match(
    source,
    /const requestWorkspaceId =\s*artifactBrowserRequest\?\.workspaceId\?\.trim\(\) \?\? "";/,
  );
  assert.match(
    source,
    /const normalizedWorkspaceId = \(selectedWorkspaceId \|\| ""\)\.trim\(\);/,
  );
  assert.match(
    source,
    /const mainSessionWorkspaceId =\s*\(desktopMainSession\?\.workspace_id \|\| ""\)\.trim\(\);/,
  );
  assert.match(
    source,
    /const mainSessionId = \(desktopMainSession\?\.session_id \|\| ""\)\.trim\(\);/,
  );
  assert.match(
    source,
    /const normalizedActiveSessionId = \(activeSessionId \|\| ""\)\.trim\(\);/,
  );
  assert.match(
    source,
    /const requestWorkspaceReady =\s*Boolean\(requestWorkspaceId\) &&[\s\S]*requestWorkspaceId === normalizedWorkspaceId &&[\s\S]*requestWorkspaceId === mainSessionWorkspaceId &&[\s\S]*Boolean\(mainSessionId\) &&[\s\S]*normalizedActiveSessionId === mainSessionId &&[\s\S]*!isLoadingHistory;/,
  );
  assert.match(
    source,
    /requestKey === lastHandledArtifactBrowserRequestKeyRef\.current/,
  );
  assert.match(source, /!requestWorkspaceReady/);
  assert.match(source, /setArtifactBrowserFilter\("all"\);/);
  assert.match(
    source,
    /setArtifactBrowserScopedOutputs\(artifactBrowserRequest\?\.outputs \?\? \[\]\);/,
  );
  assert.match(
    source,
    /setArtifactBrowserScope\(artifactBrowserRequest\?\.scope \?\? "reply"\);/,
  );
  assert.match(source, /setArtifactBrowserOpen\(true\);/);
  assert.match(
    source,
    /onArtifactBrowserRequestConsumed\?\.\(requestKey\);/,
  );
});

test("chat pane does not expose browser comment draft plumbing", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.doesNotMatch(source, /ChatPaneBrowserCommentRequest/);
  assert.doesNotMatch(source, /browserCommentRequest/);
  assert.doesNotMatch(source, /pendingBrowserCommentDraft/);
  assert.doesNotMatch(source, /BrowserChatCommentDraftItem/);
  assert.doesNotMatch(source, /browserComments=/);
  assert.doesNotMatch(source, /onClearBrowserComments/);
  assert.doesNotMatch(source, /Ask for follow-up changes/);
});
