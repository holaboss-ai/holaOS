import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "ChatPane", "index.tsx");

test("chat pane serializes quoted skills into a leading slash block before queueing", async () => {
  const source = await readFile(sourcePath, "utf8");

  // Renamed when the serializer grew @integration tokens alongside /skill.
  assert.match(source, /function serializeQuotedPrompt\(/);
  assert.match(source, /quotedSkillIds\.map\(\(skillId\) => `\/\$\{skillId\}`\)/);
  assert.match(source, /\[\.\.\.lines, "", normalizedBody\]\.join\("\\n"\)/);
  // Quoted skills and integrations are expanded before serialization now.
  assert.match(
    source,
    /const serializedPrompt = serializeQuotedPrompt\(\s*trimmed,\s*expandedQuoted\.skillIds,\s*expandedQuoted\.integrationSlugs,\s*\);/,
  );
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
  assert.match(source, /window\.electronAPI\.workspace\.listSkills\(selectedWorkspaceId\)/);
  assert.match(source, /let requestInFlight = false;/);
  assert.match(source, /const refreshVisibleWorkspaceSkills = \(\) => \{/);
  assert.match(source, /if \(document\.visibilityState !== "visible"\) \{\s*return;\s*\}/);
  assert.match(source, /const intervalId = window\.setInterval\(\(\) => \{\s*refreshVisibleWorkspaceSkills\(\);\s*\}, 1200\);/);
  assert.match(source, /window\.addEventListener\("focus", refreshVisibleWorkspaceSkills\);/);
  assert.match(source, /document\.addEventListener\(\s*"visibilitychange",\s*refreshVisibleWorkspaceSkills,\s*\);/);
  assert.match(source, /window\.clearInterval\(intervalId\);/);
  assert.match(
    source,
    /const slashCommandOptions = useMemo\(\s*\(\) =>\s*buildComposerSlashCommandOptions\(\s*availableWorkspaceSkills,\s*availableWorkspaceCapabilities,\s*\)/,
  );
  assert.match(source, /quotedSkills=\{quotedSkills\}/);
  assert.match(source, /slashCommands=\{slashCommandOptions\}/);
  assert.doesNotMatch(source, /enabled: skill\?\.enabled \?\? false/);
});

