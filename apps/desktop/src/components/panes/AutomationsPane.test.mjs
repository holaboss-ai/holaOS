import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "AutomationsPane.tsx");
const examplesPath = path.join(__dirname, "automationExamples.ts");

test("automations pane reads scheduled tasks from the shared cronjobs cache", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const \[cronjobsRaw, setCronjobsRaw\] = useAtom\(sharedCronjobsAtom\);/);
  assert.match(source, /const activeWorkspaceId = workspaceId \?\? selectedWorkspaceId;/);
  assert.match(source, /remoteApi\.cronjobs\.list\(/);
});

test("toggle updates cronjob enabled state", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /await remoteApi\.cronjobs\.update\(\{\s*jobId: job\.id,\s*enabled: !job\.enabled,\s*\}\);/);
  assert.match(source, /aria-label=\{\s*job\.enabled \? "Pause automation" : "Enable automation"\s*\}/);
});

test("run-now can jump directly into the spawned scheduled session", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const handleRunNow = async \(job: CronjobRecordPayload\) => \{/);
  assert.match(
    source,
    /if \(response\.session_id && onOpenRunSession\) \{\s*onOpenRunSession\(response\.session_id\);\s*return;\s*\}/,
  );
});

test("every outcome is a toast — no in-page status banner survives", async () => {
  const source = await readFile(sourcePath, "utf8");

  // The banner and its tone plumbing are gone; sonner is the only channel.
  assert.doesNotMatch(source, /statusMessage|statusTone|statusBarClassName/);
  for (const call of [
    /toast\.success\(`Deleted "\$\{jobTitle\(job\)\}"`\)/,
    /toast\.success\(`Created "\$\{draft\.name \|\| "automation"\}"`\)/,
    /toast\.error\("Couldn't load automations", \{/,
    /toast\.error\("Couldn't delete automation", \{/,
    /toast\.error\("Couldn't save automation", \{/,
    /toast\.error\("Couldn't update automation", \{/,
  ]) {
    assert.match(source, call);
  }
});

test("a post-action refresh still swallows its own transient errors", async () => {
  const source = await readFile(sourcePath, "utf8");

  // Background refreshes fire after an action that already reported its own
  // outcome — a failure there must not stack a second toast on top of it.
  assert.match(source, /interface RefreshDataOptions \{\s*suppressErrors\?: boolean;\s*\}/);
  assert.match(source, /void refreshData\(\{ suppressErrors: true \}\);/);
  assert.match(
    source,
    /if \(!suppressErrors\) \{\s*toast\.error\("Couldn't load automations", \{/,
  );
});

test("empty state keeps the decorated icon and offers both creation paths as peer links", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function AutomationsEmptyState\(/);
  assert.match(source, /icon=\{CalendarClock\}[\s\S]*?decorated[\s\S]*?title="No automations yet"/);
  assert.match(source, /description="Tasks Hola runs for you automatically, on a schedule\."/);
  assert.match(source, /onClick=\{onCreateWithHola\}/);
  assert.match(source, /Create with Hola/);
  assert.match(source, /<span className="text-muted-foreground"> or <\/span>/);
  assert.match(source, /onClick=\{onSetUpManually\}/);
  assert.match(source, /set up manually/);
});

test("examples preview first and only spend a chat turn on explicit request", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /Start from an example/);
  assert.match(source, /AUTOMATION_EXAMPLES\.map\(\(example\) =>/);
  assert.match(
    source,
    /const handleUseExample = \(example: AutomationExample\) => \{\s*setPreviewExample\(example\);\s*\};/,
  );
  // "Set up" prefills the manual dialog — no conversation is consumed.
  assert.match(source, /setManualPrefill\(\{\s*name: example\.name,\s*instruction: example\.instruction,\s*cron: example\.cron,\s*\}\);/);
  // The Hola-interview path survives as the explicit opt-in.
  assert.match(source, /startAutomationCreation\(example\.draftPrompt\);/);
});

test("curated examples are outcome-named and include a zero-integration option", async () => {
  const examples = await readFile(examplesPath, "utf8");

  assert.match(examples, /id: "news-watch"/);
  assert.match(examples, /draftPrompt:/);
  // Prompts hand intent to Hola rather than auto-creating.
  assert.match(examples, /Ask me/);
});

test("header split button defaults to the conversational builder", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /className="h-7 gap-1\.5 rounded-r-none"\s+onClick=\{handleCreateWithHola\}/);
  assert.match(source, /aria-label="More ways to create"/);
});

test("cards open the automation detail view and keep actions in the corner menu", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function AutomationCard\(/);
  assert.match(source, /onOpen=\{\(\) => setView\(\{ mode: "detail", jobId: job\.id \}\)\}/);
  assert.match(source, /aria-label=\{`Open \$\{jobTitle\(job\)\}`\}/);
  assert.match(source, /aria-label=\{`Actions for \$\{jobTitle\(job\)\}`\}/);
  assert.match(source, /Run now/);
  assert.match(source, /Hasn't run yet/);
});

test("cards sort by next run by default with paused automations last", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /useState<AutomationSortKey>\("next_run"\)/);
  assert.match(source, /if \(left\.enabled !== right\.enabled\) \{\s*return left\.enabled \? -1 : 1;\s*\}/);
  assert.match(source, /\{ key: "next_run", label: "Next run" \}/);
});

test("imminent runs get a highlighted countdown chip on the card", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function nextRunHint\(/);
  assert.match(source, /Runs in \$\{Math\.round\(diffMs \/ 60_000\)\}m/);
  assert.match(source, /hint\.imminent[\s\S]{0,200}text-primary/);
});

test("project-bound automations surface the project on card and detail", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function jobProjectId\(/);
  assert.match(source, /useWorkspaceProjects\(activeWorkspaceId \|\| null\)/);
  assert.match(source, /<DetailSection label="Project"/);
});

test("detail view reads back last run with a status dot and can jump to it", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /job\.run_count > 0 && job\.last_run_at \? \(/);
  assert.match(
    source,
    /job\.last_status === "error"\s*\?\s*"bg-destructive"\s*:\s*"bg-success"/,
  );
  assert.match(source, /function jobLastSessionId\(/);
  assert.match(source, /Open last run/);
});

test("editing happens in a dialog that preserves untouched metadata", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function EditAutomationDialog\(/);
  assert.match(source, /const metadata: Record<string, unknown> = \{ \.\.\.job\.metadata \};/);
  assert.match(source, /delete metadata\.project_id;/);
});

test("automations expose their model: shown in detail, editable in the dialog, persisted to metadata", async () => {
  const source = await readFile(sourcePath, "utf8");

  // Reads the pinned model (metadata.model), null => follow workspace default.
  assert.match(
    source,
    /function jobModel\(job: CronjobRecordPayload\): string \| null/,
  );
  // Detail view surfaces it, falling back to "Workspace default".
  assert.match(source, /<DetailSection label="Model">/);
  assert.match(source, /pinnedModel[\s\S]*?"Workspace default"/);
  // Edit dialog exposes a Model picker fed by the same catalog as the composer.
  assert.match(source, /<EditField label="Model">/);
  assert.match(source, /useChatComposerModelSelection\(\)/);
  assert.match(source, /MODEL_WORKSPACE_DEFAULT/);
  // Saving pins (or clears) metadata.selected_model while preserving the rest.
  // (metadata.model is a transient request-time field the runtime strips.)
  assert.match(source, /metadata\.selected_model = draft\.model;/);
  assert.match(source, /delete metadata\.selected_model;/);
  // Manual create persists the same pinned-model key.
  assert.match(source, /selected_model: draft\.model/);
});

test("automations expose a reasoning-effort pin: editable in the dialog, persisted to metadata", async () => {
  const source = await readFile(sourcePath, "utf8");

  // Reads the pinned effort (metadata.thinking_value), null => model default.
  assert.match(
    source,
    /function jobThinkingValue\(job: CronjobRecordPayload\): string \| null/,
  );
  // Edit dialog offers a Thinking picker, gated on the model exposing any.
  assert.match(source, /automationThinkingChoiceForModel\(/);
  assert.match(source, /thinkingChoice\.thinkingValues\.length > 0/);
  assert.match(source, /<EditField label="Thinking">/);
  // Saving pins (or clears) metadata.thinking_value while preserving the rest.
  assert.match(source, /metadata\.thinking_value = draft\.thinkingValue;/);
  assert.match(source, /delete metadata\.thinking_value;/);
  // Manual create persists the same pinned-effort key.
  assert.match(source, /thinking_value: draft\.thinkingValue/);
});

test("edit dialog offers a catalogue resync next to the model picker", async () => {
  const source = await readFile(sourcePath, "utf8");
  assert.match(source, /ModelCatalogRefreshButton/);
});

test("edit dialog exposes an agent picker that re-scopes the model list and persists the harness", async () => {
  const source = await readFile(sourcePath, "utf8");

  // The edit form reads the pinned agent and offers the shared picker.
  assert.match(source, /function jobHarness\(job: CronjobRecordPayload\): string/);
  assert.match(source, /useAvailableHarnesses\(workspaceId\)/);
  assert.match(source, /<EditField label="Agent">/);
  // Model options are scoped to the selected agent and reconciled on change.
  assert.match(source, /automationModelChoiceForHarness\(/);
  assert.match(source, /const handleHarnessChange = /);
  assert.match(source, /reconcileAutomationModel\(/);
  assert.match(source, /onChange=\{handleHarnessChange\}/);
  // Saving persists the chosen agent to metadata.harness.
  assert.match(source, /metadata\.harness = draft\.harness;/);
});

test("sparse lists keep a compact examples gallery that disappears at three automations", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /\{sortedJobs\.length <= 2 \? \(\s*<ExamplesGallery/);
  assert.match(source, /function ExamplesGallery\(/);
});
