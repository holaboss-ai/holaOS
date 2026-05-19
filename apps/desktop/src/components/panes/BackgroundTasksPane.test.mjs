import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SOURCE_PATH = new URL("./BackgroundTasksPane.tsx", import.meta.url);

test("background tasks pane polls workspace background tasks and supports inline read-only rendering", async () => {
  const source = await readFile(SOURCE_PATH, "utf8");

  assert.match(source, /const BACKGROUND_TASKS_POLL_INTERVAL_MS = 1000;/);
  assert.match(
    source,
    /onOpenTaskSession\?: \(task: BackgroundTaskRecordPayload\) => void;/,
  );
  assert.match(source, /variant = "full"/);
  assert.match(source, /window\.electronAPI\.workspace\.listBackgroundTasks\(\{\s*workspaceId: activeWorkspaceId,/);
  assert.match(source, /window\.electronAPI\.workspace\.archiveBackgroundTask\(\{/);
  assert.match(source, /Read-only view for workspace background work\./);
  assert.match(source, /No background tasks yet\./);
  assert.match(source, /window\.addEventListener\("focus", refreshVisibleTasks\);/);
  assert.match(source, /document\.addEventListener\("visibilitychange", refreshVisibleTasks\);/);
  assert.match(source, /if \(variant === "inline"\) \{/);
  assert.match(source, /if \(tasks\.length === 0 && !errorMessage\) \{\s*return null;\s*\}/);
  assert.match(source, /case "running":\s*return goal \|\| "Working in the background\.";?/);
  assert.match(source, /case "queued":\s*return goal \|\| "Queued to run\.";?/);
  assert.match(source, /case "completed":/);
  assert.doesNotMatch(source, /if \(summary\) \{\s*return summary;\s*\}\s*return task\.goal\.trim\(\) \|\| "No summary yet\.";?/);
  assert.match(source, /onClick=\{\(\) => setInlineExpanded\(\(value\) => !value\)\}/);
  assert.match(source, /const \[removingTaskId, setRemovingTaskId\] = useState<string \| null>\(null\);/);
  assert.match(source, /function canRemoveTask\(task: BackgroundTaskRecordPayload\)/);
  assert.match(source, /return status !== "queued" && status !== "running";/);
  assert.match(source, /const taskBody = \(\s*<div className="flex min-w-0 items-center gap-2">/);
  assert.match(source, /className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"/);
  assert.match(source, /className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"/);
  assert.match(source, /aria-label=\{`Remove background task \$\{task\.title\.trim\(\) \|\| task\.subagent_id\}`\}/);
  assert.match(source, /<Trash2 size=\{12\} \/>/);
  assert.doesNotMatch(
    source,
    /Read-only view for workspace background work\. Click a task to inspect its run transcript, then use the main session to cancel, retry, or answer blockers\./,
  );
  assert.match(source, /onClick=\{\(\) => onOpenTaskSession\(task\)\}/);
  assert.doesNotMatch(source, /Inspect run/);
  assert.doesNotMatch(source, /Updated \{/);
});
