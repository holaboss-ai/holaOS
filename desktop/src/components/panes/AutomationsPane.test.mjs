import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "AutomationsPane.tsx");

test("automations pane keeps scheduled tasks and completed runs as distinct data sets", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const \[cronjobs, setCronjobs\] = useState<CronjobRecordPayload\[]>\(\[\]\);/);
  assert.match(source, /const \[completedRuns, setCompletedRuns\] = useState<CompletedAutomationRun\[]>\(/);
  assert.match(source, /const activeWorkspaceId = workspaceId \?\? selectedWorkspaceId;/);
  assert.match(source, /window\.electronAPI\.workspace\.listCronjobs\(activeWorkspaceId\)/);
  assert.match(source, /window\.electronAPI\.workspace\.listAgentSessions\(activeWorkspaceId\)/);
  assert.match(source, /window\.electronAPI\.workspace\.listRuntimeStates\(activeWorkspaceId\)/);
  assert.match(source, /session\.kind\.trim\(\)\.toLowerCase\(\) === "cronjob"/);
});

test("scheduled tab toggle updates cronjob enabled state", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /await window\.electronAPI\.workspace\.updateCronjob\(job\.id, \{\s*enabled: !job\.enabled,\s*\}\);/);
  assert.match(source, /setCronjobs\(\(previous\) =>\s*previous\.map\(\(item\) => \(item\.id === updated\.id \? updated : item\)\),\s*\);/);
  assert.match(source, /aria-label=\{\s*job\.enabled\s*\?\s*"Disable schedule"\s*:\s*"Enable schedule"\s*\}/);
});

test("scheduled rows expose a run-now action for each automation", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const handleRunNow = async \(job: CronjobRecordPayload\) => \{/);
  assert.match(
    source,
    /await window\.electronAPI\.workspace\.runCronjobNow\(\s*job\.workspace_id,\s*job\.id,\s*composerModel \? \{ model: composerModel \} : undefined,\s*\);/,
  );
  assert.match(source, /item\.id === response\.cronjob\.id \? response\.cronjob : item/);
  assert.match(source, /if \(onRunNow\) \{\s*onRunNow\(response\.cronjob\);\s*return;\s*\}/);
  assert.match(source, /Run now/);
  assert.match(source, /<Play size=\{14\} \/>/);
});

test("post-action refresh preserves the current banner and suppresses transient refresh errors", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /interface RefreshDataOptions \{\s*preserveStatusMessage\?: boolean;\s*suppressErrors\?: boolean;\s*\}/);
  assert.match(source, /const refreshData = useCallback\(\s*async \(options\?: RefreshDataOptions\) => \{/);
  assert.match(source, /if \(!preserveStatusMessage\) \{\s*setStatusMessage\(""\);\s*\}/);
  assert.match(source, /if \(!suppressErrors\) \{\s*setStatusTone\("error"\);\s*setStatusMessage\(normalizeErrorMessage\(error\)\);\s*\}/);
  assert.match(source, /void refreshData\(\{\s*preserveStatusMessage: true,\s*suppressErrors: true,\s*\}\);/);
});

test("scheduled rows label whether an automation is a notification or task run", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function jobDeliveryChannel\(job: CronjobRecordPayload\): string \{/);
  assert.match(source, /if \(channel === "system_notification"\) \{\s*return "Notification";/);
  assert.match(source, /if \(channel === "session_run"\) \{\s*return "Task run";/);
  assert.match(source, /jobKindClassName\(job\)/);
  assert.match(source, /jobKindLabel\(job\)/);
});

test("new schedule button can route creation into the workspace chat", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /interface AutomationsPaneProps \{\s*workspaceId\?: string \| null;\s*composerModel\?: string \| null;\s*emptyWorkspaceMessage\?: string;\s*onOpenRunSession\?: \(sessionId: string\) => void;\s*onRunNow\?: \(job: CronjobRecordPayload\) => void;\s*onCreateSchedule\?: \(\) => void;\s*onEditSchedule\?: \(job: CronjobRecordPayload\) => void;\s*\}/);
  assert.match(source, /if \(onCreateSchedule\) \{\s*onCreateSchedule\(\);\s*return;\s*\}/);
  assert.match(source, /onClick=\{handleNewSchedule\}/);
});

test("completed runs open the corresponding sub-session when clicked", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /interface AutomationsPaneProps \{\s*workspaceId\?: string \| null;[\s\S]*onOpenRunSession\?: \(sessionId: string\) => void;/);
  assert.match(source, /onClick=\{\(\) => onOpenRunSession\?\.\(run\.sessionId\)\}/);
});

test("automations pane can embed inside settings and hide its standalone header", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /showHeader = true/);
  assert.match(source, /emptyWorkspaceMessage = "Choose a workspace from the top bar to view and manage automations\."/);
  assert.match(source, /toolbarLeading\?: ReactNode/);
  assert.match(source, /const content = \(/);
  assert.match(source, /if \(!showHeader\) \{\s*return content;\s*\}/);
  assert.match(source, /return <PaneCard className="shadow-md">\{content\}<\/PaneCard>;/);
  assert.match(source, /showHeader \? \(/);
  assert.match(source, /toolbarLeading \? \(/);
  assert.match(source, /!activeWorkspaceId \? \(\s*<EmptyState message=\{emptyWorkspaceMessage\} \/>/);
});

test("scheduled rows use a kebab menu for run, edit, and delete actions", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const handleEdit = \(job: CronjobRecordPayload\) => \{/);
  assert.match(source, /if \(onEditSchedule\) \{\s*onEditSchedule\(job\);\s*return;\s*\}/);
  assert.match(source, /Actions for \$\{jobTitle\(job\)\}/);
  assert.match(source, /<MoreHorizontal size=\{16\} \/>/);
  assert.match(source, /<Pencil size=\{16\} \/>/);
  assert.match(source, /Run now/);
  assert.match(source, /Edit/);
  assert.match(source, /Delete/);
});

test("new schedule button uses the shared primary button style", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /<Button\s+type="button"\s+size="default"\s+onClick=\{handleNewSchedule\}\s+className="rounded-full px-4"/);
  assert.doesNotMatch(source, /bg-foreground/);
});

test("automations toolbar uses shadcn Tabs primitive instead of custom pill buttons", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /from "@\/components\/ui\/tabs"/);
  assert.match(source, /<TabsTrigger value="scheduled">/);
  assert.match(source, /<TabsTrigger value="completed">/);
});
