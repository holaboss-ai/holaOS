import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  invokeWorkspaceSkill,
  prepareInstructionWithQuotedWorkspaceSkills,
  resolveWorkspaceSkills,
} from "./workspace-skills.js";

const ORIGINAL_ENV = {
  HOLABOSS_EMBEDDED_SKILLS_DIR: process.env.HOLABOSS_EMBEDDED_SKILLS_DIR,
  HOLABOSS_RUNTIME_ROOT: process.env.HOLABOSS_RUNTIME_ROOT,
};

const TEMP_DIRS: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

function writeSkill(root: string, skillId: string, description = `${skillId} skill`): string {
  const skillDir = path.join(root, skillId);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${skillId}\ndescription: ${description}\n---\n# ${skillId}\n`,
    "utf8"
  );
  return skillDir;
}

function expectedResolvedSkill(params: {
  root: string;
  skillId: string;
  origin: "workspace" | "embedded";
  grantedTools?: string[];
  grantedCommands?: string[];
  description?: string;
}) {
  const sourceDir = fs.realpathSync(path.join(params.root, params.skillId));
  return {
    skill_id: params.skillId,
    skill_name: params.skillId,
    description: params.description ?? `${params.skillId} skill`,
    source_dir: sourceDir,
    file_path: path.join(sourceDir, "SKILL.md"),
    origin: params.origin,
    granted_tools: params.grantedTools ?? [],
    granted_commands: params.grantedCommands ?? [],
  };
}

afterEach(() => {
  if (ORIGINAL_ENV.HOLABOSS_EMBEDDED_SKILLS_DIR === undefined) {
    delete process.env.HOLABOSS_EMBEDDED_SKILLS_DIR;
  } else {
    process.env.HOLABOSS_EMBEDDED_SKILLS_DIR = ORIGINAL_ENV.HOLABOSS_EMBEDDED_SKILLS_DIR;
  }
  if (ORIGINAL_ENV.HOLABOSS_RUNTIME_ROOT === undefined) {
    delete process.env.HOLABOSS_RUNTIME_ROOT;
  } else {
    process.env.HOLABOSS_RUNTIME_ROOT = ORIGINAL_ENV.HOLABOSS_RUNTIME_ROOT;
  }
  for (const dir of TEMP_DIRS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWorkspaceSkills includes embedded defaults when no workspace skills are configured", () => {
  const embeddedRoot = makeTempDir("hb-embedded-skills-");
  process.env.HOLABOSS_EMBEDDED_SKILLS_DIR = embeddedRoot;
  writeSkill(embeddedRoot, "holaboss-runtime");

  const workspaceDir = makeTempDir("hb-workspace-no-skills-");

  assert.deepEqual(resolveWorkspaceSkills(workspaceDir), [
    expectedResolvedSkill({
      root: embeddedRoot,
      skillId: "holaboss-runtime",
      origin: "embedded",
    })
  ]);
});

test("resolveWorkspaceSkills finds bundled embedded skills when HOLABOSS_RUNTIME_ROOT points at the bundle root", () => {
  delete process.env.HOLABOSS_EMBEDDED_SKILLS_DIR;
  const runtimeBundleRoot = makeTempDir("hb-runtime-bundle-root-");
  const embeddedRoot = path.join(runtimeBundleRoot, "runtime", "harnesses", "src", "embedded-skills");
  fs.mkdirSync(embeddedRoot, { recursive: true });
  writeSkill(embeddedRoot, "skill-creator");
  process.env.HOLABOSS_RUNTIME_ROOT = runtimeBundleRoot;

  const workspaceDir = makeTempDir("hb-workspace-bundle-embedded-skills-");

  assert.deepEqual(resolveWorkspaceSkills(workspaceDir), [
    expectedResolvedSkill({
      root: embeddedRoot,
      skillId: "skill-creator",
      origin: "embedded",
    }),
  ]);
});

test("resolveWorkspaceSkills keeps embedded defaults authoritative when workspace skills reuse the same id", () => {
  const embeddedRoot = makeTempDir("hb-embedded-skills-");
  process.env.HOLABOSS_EMBEDDED_SKILLS_DIR = embeddedRoot;
  writeSkill(embeddedRoot, "alpha", "embedded alpha");
  writeSkill(embeddedRoot, "beta", "embedded beta");

  const workspaceDir = makeTempDir("hb-workspace-skills-");
  const workspaceSkillsRoot = path.join(workspaceDir, "skills");
  writeSkill(workspaceSkillsRoot, "alpha", "workspace alpha");
  writeSkill(workspaceSkillsRoot, "gamma", "workspace gamma");

  const resolved = resolveWorkspaceSkills(workspaceDir);
  assert.deepEqual(
    resolved.map((skill) => ({ skill_id: skill.skill_id, origin: skill.origin })),
    [
      { skill_id: "alpha", origin: "embedded" },
      { skill_id: "beta", origin: "embedded" },
      { skill_id: "gamma", origin: "workspace" }
    ]
  );
  assert.equal(resolved[0]?.source_dir, fs.realpathSync(path.join(embeddedRoot, "alpha")));
});

test("resolveWorkspaceSkills includes workspace-local skills without requiring workspace.yaml skill allowlists", () => {
  const embeddedRoot = makeTempDir("hb-embedded-skills-");
  process.env.HOLABOSS_EMBEDDED_SKILLS_DIR = embeddedRoot;
  writeSkill(embeddedRoot, "holaboss-runtime");
  writeSkill(embeddedRoot, "beta");

  const workspaceDir = makeTempDir("hb-workspace-enabled-skills-");
  const workspaceSkillsRoot = path.join(workspaceDir, "skills");
  writeSkill(workspaceSkillsRoot, "alpha");
  writeSkill(workspaceSkillsRoot, "gamma");

  const resolved = resolveWorkspaceSkills(workspaceDir);
  assert.deepEqual(
    resolved.map((skill) => ({ skill_id: skill.skill_id, origin: skill.origin })),
    [
      { skill_id: "beta", origin: "embedded" },
      { skill_id: "holaboss-runtime", origin: "embedded" },
      { skill_id: "alpha", origin: "workspace" },
      { skill_id: "gamma", origin: "workspace" }
    ]
  );
});

test("resolveWorkspaceSkills ignores legacy agents.proactive.skills_path fallback", () => {
  const embeddedRoot = makeTempDir("hb-embedded-skills-empty-");
  process.env.HOLABOSS_EMBEDDED_SKILLS_DIR = embeddedRoot;
  const workspaceDir = makeTempDir("hb-workspace-legacy-skills-path-");
  const legacySkillsRoot = path.join(workspaceDir, "legacy-skills");
  writeSkill(legacySkillsRoot, "legacy-only");
  fs.writeFileSync(
    path.join(workspaceDir, "workspace.yaml"),
    ['agents:', '  proactive:', '    skills_path: "legacy-skills"'].join("\n"),
    "utf8"
  );

  assert.deepEqual(resolveWorkspaceSkills(workspaceDir), []);
});

test("resolveWorkspaceSkills ignores skills.path and still resolves workspace skills from fixed skills directory", () => {
  const embeddedRoot = makeTempDir("hb-embedded-skills-empty-");
  process.env.HOLABOSS_EMBEDDED_SKILLS_DIR = embeddedRoot;

  const workspaceDir = makeTempDir("hb-workspace-fixed-skills-path-");
  const customSkillsRoot = path.join(workspaceDir, "custom-skills");
  const fixedSkillsRoot = path.join(workspaceDir, "skills");
  writeSkill(customSkillsRoot, "custom-only");
  writeSkill(fixedSkillsRoot, "fixed-skill");
  fs.writeFileSync(
    path.join(workspaceDir, "workspace.yaml"),
    ['skills:', '  path: "custom-skills"'].join("\n"),
    "utf8"
  );

  assert.deepEqual(
    resolveWorkspaceSkills(workspaceDir).map((skill) => skill.skill_id),
    ["fixed-skill"]
  );
});

test("resolveWorkspaceSkills ignores invalid skill format when frontmatter is missing required fields", () => {
  const embeddedRoot = makeTempDir("hb-embedded-skills-empty-");
  process.env.HOLABOSS_EMBEDDED_SKILLS_DIR = embeddedRoot;

  const workspaceDir = makeTempDir("hb-workspace-invalid-skill-format-");
  const skillsRoot = path.join(workspaceDir, "skills");
  const invalidNoNameDir = path.join(skillsRoot, "invalid-no-name");
  const invalidNameMismatchDir = path.join(skillsRoot, "invalid-name-mismatch");
  const invalidNoDescriptionDir = path.join(skillsRoot, "invalid-no-description");
  const validDir = path.join(skillsRoot, "valid-skill");
  fs.mkdirSync(invalidNoNameDir, { recursive: true });
  fs.mkdirSync(invalidNameMismatchDir, { recursive: true });
  fs.mkdirSync(invalidNoDescriptionDir, { recursive: true });
  fs.mkdirSync(validDir, { recursive: true });
  fs.writeFileSync(path.join(invalidNoNameDir, "SKILL.md"), "---\ndescription: Missing name\n---\n# Missing name\n", "utf8");
  fs.writeFileSync(
    path.join(invalidNameMismatchDir, "SKILL.md"),
    "---\nname: another-skill\ndescription: Name mismatch\n---\n# Name mismatch\n",
    "utf8"
  );
  fs.writeFileSync(path.join(invalidNoDescriptionDir, "SKILL.md"), "---\nname: invalid-no-description\n---\n# Missing desc\n", "utf8");
  fs.writeFileSync(
    path.join(validDir, "SKILL.md"),
    "---\nname: valid-skill\ndescription: Valid skill\n---\n# Valid skill\n",
    "utf8"
  );

  assert.deepEqual(
    resolveWorkspaceSkills(workspaceDir).map((skill) => skill.skill_id),
    ["valid-skill"]
  );
});

test("prepareInstructionWithQuotedWorkspaceSkills strips leading slash skills into canonical blocks", () => {
  const embeddedRoot = makeTempDir("hb-embedded-skills-empty-");
  process.env.HOLABOSS_EMBEDDED_SKILLS_DIR = embeddedRoot;

  const workspaceDir = makeTempDir("hb-workspace-quoted-skills-");
  const skillsRoot = path.join(workspaceDir, "skills");
  const skillDir = path.join(skillsRoot, "customer_lookup");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: customer_lookup",
      "description: Customer lookup",
      "---",
      "",
      "# Customer Lookup",
      "",
      "Check the customer profile before writing the response.",
    ].join("\n"),
    "utf8"
  );

  const workspaceSkills = resolveWorkspaceSkills(workspaceDir);
  const prepared = prepareInstructionWithQuotedWorkspaceSkills({
    instruction: ["/customer_lookup", "/missing_skill", "", "Draft the follow-up email."].join("\n"),
    workspaceSkills,
  });

  assert.equal(prepared.body, "Draft the follow-up email.");
  assert.deepEqual(prepared.missing_quoted_skill_ids, ["missing_skill"]);
  assert.equal(prepared.quoted_skill_blocks.length, 1);
  assert.match(prepared.quoted_skill_blocks[0] ?? "", /<skill name="customer_lookup" location=".*customer_lookup\/SKILL\.md">/);
  assert.match(prepared.quoted_skill_blocks[0] ?? "", /References are relative to .*customer_lookup/);
  assert.match(prepared.quoted_skill_blocks[0] ?? "", /Check the customer profile before writing the response\./);
  assert.doesNotMatch(prepared.quoted_skill_blocks[0] ?? "", /^---$/m);
});

test("resolveWorkspaceSkills captures declared granted tools and commands and invokeWorkspaceSkill returns canonical metadata", () => {
  const embeddedRoot = makeTempDir("hb-embedded-skills-empty-");
  process.env.HOLABOSS_EMBEDDED_SKILLS_DIR = embeddedRoot;

  const workspaceDir = makeTempDir("hb-workspace-skill-grants-");
  const skillDir = path.join(workspaceDir, "skills", "deploy-helper");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: deploy-helper",
      "description: Deployment helper",
      "holaboss:",
      "  granted_tools:",
      "    - bash",
      "    - Deploy",
      "  granted_commands: [deploy-docs]",
      "---",
      "",
      "# Deploy Helper",
      "",
      "Use the deploy workflow carefully.",
    ].join("\n"),
    "utf8"
  );

  const workspaceSkills = resolveWorkspaceSkills(workspaceDir);
  assert.deepEqual(workspaceSkills, [
    expectedResolvedSkill({
      root: path.join(workspaceDir, "skills"),
      skillId: "deploy-helper",
      origin: "workspace",
      grantedTools: ["bash", "deploy"],
      grantedCommands: ["deploy-docs"],
      description: "Deployment helper",
    }),
  ]);

  const invoked = invokeWorkspaceSkill({
    requestedName: "deploy-helper",
    args: "Only use the docs path.",
    workspaceSkills,
  });
  assert.match(invoked.text, /<skill name="deploy-helper" location=".*deploy-helper\/SKILL\.md">/);
  assert.match(invoked.text, /Only use the docs path\./);
  assert.deepEqual(invoked.granted_tools, ["bash", "deploy"]);
  assert.deepEqual(invoked.granted_commands, ["deploy-docs"]);
});

test("embedded app-builder-sdk skill only references bundled local assets", () => {
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  const skillDir = path.resolve(
    sourceDir,
    "../../harnesses/src/embedded-skills/app-builder-sdk",
  );
  const skillBody = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");

  assert.doesNotMatch(skillBody, /docs\/pm\/app-vibe-coding\.md/);
  assert.doesNotMatch(skillBody, /experiments\/app-builder-sdk\//);
  assert.doesNotMatch(skillBody, /holaOS\/desktop\//);
  // Snapshot lives as a single canonical sdk-package/ tree; no flat sdk/
  // duplicates and no nested sdk-package/reference/ duplicates.
  assert.doesNotMatch(skillBody, /`sdk\/[^`]+`/);
  assert.doesNotMatch(skillBody, /`sdk-package\/reference\//);
  assert.doesNotMatch(skillBody, /`ui-reference\//);
  assert.doesNotMatch(skillBody, /`ui-package\//);

  for (const relativePath of [
    "sdk-package/README.txt",
    "sdk-package/package.json",
    "sdk-package/src/index.ts",
    "sdk-package/src/types.ts",
    "sdk-package/src/app.ts",
    "reference/pinterest-publishing/app.ts",
    "reference/slack-messaging/server.ts",
    "reference/slack-messaging/app.runtime.yaml",
  ]) {
    assert.equal(
      fs.existsSync(path.join(skillDir, relativePath)),
      true,
      `expected embedded skill asset to exist: ${relativePath}`,
    );
  }
});
