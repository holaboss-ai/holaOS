import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "ChatPane.tsx");

test("chat pane serializes quoted skills into a leading slash block before queueing", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function serializeQuotedSkillPrompt\(/);
  assert.match(source, /quotedSkillIds\.map\(\(skillId\) => `\/\$\{skillId\}`\)/);
  assert.match(source, /\[\.\.\.lines, "", normalizedBody\]\.join\("\\n"\)/);
  assert.match(source, /const serializedPrompt = serializeQuotedSkillPrompt\(\s*trimmed,\s*quotedSkillIds,\s*\);/);
  assert.match(source, /text: serializedPrompt,/);
  assert.match(
    source,
    /window\.electronAPI\.workspace\.queueSessionInput\(\{[\s\S]*text: serializedPrompt,/,
  );
});

test("chat pane loads workspace skills into slash commands and quoted skill chips", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const \[quotedSkillIds, setQuotedSkillIds\] = useState<string\[\]>\(\[\]\);/);
  assert.match(source, /const \[availableWorkspaceSkills, setAvailableWorkspaceSkills\] = useState</);
  assert.match(source, /const loadAvailableWorkspaceSkills = async \(\) => \{/);
  assert.match(source, /window\.electronAPI\.workspace\.listSkills\(\s*selectedWorkspaceId,\s*\)/);
  assert.match(source, /let requestInFlight = false;/);
  assert.match(source, /const refreshVisibleWorkspaceSkills = \(\) => \{/);
  assert.match(source, /if \(document\.visibilityState !== "visible"\) \{\s*return;\s*\}/);
  assert.match(source, /const intervalId = window\.setInterval\(\(\) => \{\s*refreshVisibleWorkspaceSkills\(\);\s*\}, 1200\);/);
  assert.match(source, /window\.addEventListener\("focus", refreshVisibleWorkspaceSkills\);/);
  assert.match(source, /document\.addEventListener\(\s*"visibilitychange",\s*refreshVisibleWorkspaceSkills,\s*\);/);
  assert.match(source, /window\.clearInterval\(intervalId\);/);
  assert.match(source, /const slashCommandOptions = useMemo\(\s*\(\) => buildComposerSlashCommandOptions\(availableWorkspaceSkills\),/);
  assert.match(source, /quotedSkills=\{quotedSkills\}/);
  assert.match(source, /slashCommands=\{slashCommandOptions\}/);
  assert.doesNotMatch(source, /enabled: skill\?\.enabled \?\? false/);
});

test("chat composer renders a slash-triggered skill menu and removes the typed token on selection", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function findActiveSlashCommandRange\(/);
  assert.match(source, /function removeSlashCommandText\(/);
  assert.doesNotMatch(source, /\.filter\(\(skill\) => skill\.enabled\)/);
  assert.match(source, /const \[composerActionsMenuOpen, setComposerActionsMenuOpen\] = useState\(false\);/);
  assert.match(source, /const \[composerActionsView, setComposerActionsView\] = useState</);
  assert.match(source, /const \[skillPickerQuery, setSkillPickerQuery\] = useState\(""\);/);
  assert.match(source, /const \[dismissedSlashCommandKey, setDismissedSlashCommandKey\] = useState\(""\);/);
  assert.match(source, /const filteredSlashCommands = useMemo\(\(\) => \{/);
  assert.match(source, /const filteredSkillCommands = useMemo\(\(\) => \{/);
  assert.match(source, /const applySlashCommand = \(command: ChatComposerSlashCommandOption\) => \{/);
  assert.match(source, /const openSkillPickerFromComposerMenu = \(\) => \{/);
  assert.match(source, /const selectSkillFromPicker = \(command: ChatComposerSlashCommandOption\) => \{/);
  assert.match(source, /onSelectSlashCommand\(command\);/);
  assert.match(source, /Attach a file/);
  assert.match(source, /Use Skills/);
  assert.match(source, /placeholder="Search skills"/);
  assert.match(source, /className="embedded-input h-7 w-full min-w-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"/);
  assert.match(source, /onKeyDown=\{handleTextareaKeyDown\}/);
  assert.match(source, /activeSlashCommandKey !== dismissedSlashCommandKey/);
  assert.match(source, /document\.addEventListener\("pointerdown", handlePointerDown\);/);
  assert.match(source, /menu\.contains\(target\)/);
  assert.match(source, /setDismissedSlashCommandKey\(activeSlashCommandKey\);/);
  assert.match(source, /ref=\{slashCommandMenuRef\}/);
  assert.match(source, /pointer-events-none absolute left-3 right-3 top-4 z-20 -translate-y-\[calc\(100%\+2px\)\]/);
  assert.doesNotMatch(source, /<span className="mt-1 block truncate text-\[11px\] text-muted-foreground">\s*\{command\.command\}\s*<\/span>/);
  assert.doesNotMatch(source, /<span className="mt-0\.5 block truncate text-\[11px\] text-muted-foreground">\s*<span className="truncate">\{command\.command\}<\/span>\s*<\/span>/);
  assert.doesNotMatch(source, /command\.description \|\| command\.command/);
  assert.doesNotMatch(source, /Slash commands/);
  assert.match(source, /No slash commands match\./);
  assert.match(source, /No matching skills/);
  assert.match(source, /Remove quoted skill/);
  assert.match(source, /aria-label="Back to actions"/);
  assert.match(source, /command\.description \? \(/);
  assert.match(source, /onRemoveQuotedSkill\(command\.skillId\);/);
});
