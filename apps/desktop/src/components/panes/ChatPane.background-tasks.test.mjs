import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SOURCE_PATH = new URL("./ChatPane/index.tsx", import.meta.url);
const BACKGROUND_TASKS_SOURCE_PATH = new URL(
  "./BackgroundTasksPane.tsx",
  import.meta.url,
);
const CONVERSATION_TURNS_SOURCE_PATH = new URL(
  "./ChatPane/ConversationTurns.tsx",
  import.meta.url,
);
const TASK_REFERENCE_CARDS_SOURCE_PATH = new URL(
  "./ChatPane/BackgroundTaskReferenceCards.tsx",
  import.meta.url,
);

test("chat pane renders background tasks inline and removes the separate quick action", async () => {
  const source = await readFile(SOURCE_PATH, "utf8");
  const backgroundTasksSource = await readFile(
    BACKGROUND_TASKS_SOURCE_PATH,
    "utf8",
  );
  const conversationTurnsSource = await readFile(
    CONVERSATION_TURNS_SOURCE_PATH,
    "utf8",
  );
  const taskReferenceCardsSource = await readFile(
    TASK_REFERENCE_CARDS_SOURCE_PATH,
    "utf8",
  );

  assert.doesNotMatch(source, /onOpenBackgroundTasks\?: \(\) => void;/);
  assert.doesNotMatch(source, /<ChatHeader[\s\S]*onOpenBackgroundTasks=/);
  assert.doesNotMatch(source, /aria-label="Show background tasks"/);
  assert.doesNotMatch(source, /onClick=\{\(\) => onOpenBackgroundTasks\(\)\}/);
  assert.match(
    source,
    /onOpenBackgroundTask\?: \(task: BackgroundTaskRecordPayload\) => boolean;/,
  );
  assert.match(
    source,
    /isViewingBoundMainSession \? \(\s*<div className="flex shrink-0 justify-center px-4 pt-2 empty:hidden">[\s\S]*<BackgroundTasksPane[\s\S]*workspaceId=\{selectedWorkspaceId\}[\s\S]*variant="inline"/,
  );
  assert.match(
    source,
    /<BackgroundTasksPane[\s\S]*onOpenTaskSession=\{handleOpenBackgroundTaskSession\}/,
  );
  assert.match(backgroundTasksSource, /ownerMainSessionId\?: string \| null;/);
  assert.match(
    backgroundTasksSource,
    /ownerMainSessionId = null,[\s\S]*const activeOwnerMainSessionId = ownerMainSessionId\?\.trim\(\) \|\| null;/,
  );
  assert.match(
    backgroundTasksSource,
    /listBackgroundTasks\(\{[\s\S]*workspaceId: activeWorkspaceId,[\s\S]*ownerMainSessionId: activeOwnerMainSessionId,/,
  );
  assert.match(
    backgroundTasksSource,
    /function backgroundTaskOpenSessionTarget\(task: BackgroundTaskRecordPayload\) \{[\s\S]*task\.parent_session_id\?\.trim\(\)[\s\S]*task\.owner_main_session_id\.trim\(\)[\s\S]*task\.child_session_id\.trim\(\)/,
  );
  assert.match(
    source,
    /if \(onOpenBackgroundTask\?\.\(task\) === true\) \{\s*return;\s*\}/,
  );
  assert.match(
    source,
    /const taskMainSessionId =[\s\S]*task\.parent_session_id\?\.trim\(\)[\s\S]*task\.owner_main_session_id\.trim\(\)[\s\S]*setLocalSessionOpenRequestState\(\{[\s\S]*sessionId: taskMainSessionId,[\s\S]*readOnly: false,/,
  );
  assert.doesNotMatch(source, /<SubagentSessionsPane[\s\S]*variant="inline"/);
  assert.match(source, /handleOpenReadOnlyAgentSession\(\{[\s\S]*session_id: childSessionId,/);
  assert.doesNotMatch(source, /onOpenSessions\?: \(\) => void;/);
  assert.doesNotMatch(source, /onOpenSessions=\{onOpenSessions\}/);
  assert.doesNotMatch(source, /aria-label="Select agent session"/);
  assert.match(
    source,
    /function backgroundTaskReferencesFromSubagentLifecycle\([\s\S]*payload\.subagent_payload[\s\S]*parseBackgroundTaskReference\(subagentPayload\)/,
  );
  assert.match(source, /backgroundTaskReferences: restoredAssistantState\.backgroundTaskReferences,/);
  assert.match(
    source,
    /const handleOpenBackgroundTaskReference = useCallback\([\s\S]*const syntheticTask: BackgroundTaskRecordPayload = \{[\s\S]*source_type: sourceType,[\s\S]*source_id: sourceId,[\s\S]*onOpenBackgroundTask\?\.\(syntheticTask\);[\s\S]*\[onOpenBackgroundTask\]\s*,?\s*\);/,
  );
  assert.match(
    source,
    /<ConversationTurns[\s\S]*onOpenBackgroundTaskReference=\{\s*handleOpenBackgroundTaskReference\s*\}/,
  );
  assert.match(
    conversationTurnsSource,
    /import \{ BackgroundTaskReferenceCards \} from "\.\/BackgroundTaskReferenceCards";/,
  );
  assert.match(
    conversationTurnsSource,
    /message\.backgroundTaskReferences\?\.length[\s\S]*<BackgroundTaskReferenceCards[\s\S]*onOpenReference=\{onOpenBackgroundTaskReference\}/,
  );
  assert.match(
    taskReferenceCardsSource,
    /function backgroundTaskReferencePrimaryLabel\([\s\S]*reference\.issueId\?\.trim\(\)[\s\S]*reference\.sourceId\?\.trim\(\)/,
  );
});
