import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import type { TeammateRecord } from "@holaboss/runtime-state-store";

import {
  deleteTeammateSkill,
  loadTeammateFilesystemSkills,
  resolvedTeammateSkillsForRecord,
  teammateSkillRelativeFilePath,
  teammateSkillRelativeSourceDir,
  upsertTeammateSkill,
  writeTeammateSkills,
} from "./teammate-skill-files.js";

const TEMP_DIRS: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

function baseTeammate(overrides: Partial<TeammateRecord> = {}): TeammateRecord {
  return {
    teammateId: "general",
    workspaceId: "workspace-1",
    name: "General",
    kind: "custom",
    status: "active",
    instructions: "Own implementation work.",
    capabilityProfile: {
      summary: null,
      capabilities: [],
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeTeammateSkills materializes teammate-local skill folders and reads them back as filesystem skills", () => {
  const workspaceDir = makeTempDir("hb-teammate-skills-write-");

  const resolved = writeTeammateSkills({
    workspaceDir,
    teammateId: "general",
    skills: [
      {
        name: "Frontend Playbook",
        content: "# Frontend Playbook\nUse the dashboard patterns.",
      },
    ],
  });

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.skillId, "frontend-playbook");
  assert.equal(resolved[0]?.name, "Frontend Playbook");
  assert.equal(resolved[0]?.storageOrigin, "filesystem");
  assert.equal(
    resolved[0]?.filePath,
    fs.realpathSync(path.join(
      workspaceDir,
      "teammates",
      "general",
      "skills",
      "frontend-playbook",
      "SKILL.md",
    )),
  );
  assert.equal(
    fs.existsSync(resolved[0]?.filePath ?? ""),
    true,
  );

  const raw = fs.readFileSync(resolved[0]?.filePath ?? "", "utf8");
  assert.match(raw, /^---\nname: frontend-playbook\ndescription: Frontend Playbook\n---/m);
  assert.match(raw, /Use the dashboard patterns\./);
});

test("writeTeammateSkills supports full skill bundles with explicit SKILL.md and sidecar trees", () => {
  const workspaceDir = makeTempDir("hb-teammate-skills-bundle-");

  const resolved = writeTeammateSkills({
    workspaceDir,
    teammateId: "general",
    skills: [
      {
        skillMarkdown: [
          "---",
          "name: research-playbook",
          "description: Research Playbook",
          "holaboss:",
          "  granted_tools: [web_search, browser]",
          "  granted_commands: [open-sources]",
          "---",
          "",
          "# Research Playbook",
          "",
          "Always cite sources.",
        ].join("\n"),
        sidecarFiles: [
          {
            path: "scripts/fetch.sh",
            content: "#!/bin/sh\ncurl \"$1\"\n",
          },
          {
            path: "references/sources.md",
            content: "# Sources\n\nUse primary sources first.\n",
          },
        ],
        directories: ["assets/templates"],
      },
    ],
  });

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.skillId, "research-playbook");
  assert.deepEqual(resolved[0]?.grantedTools, ["web_search", "browser"]);
  assert.deepEqual(resolved[0]?.grantedCommands, ["open-sources"]);
  assert.equal(resolved[0]?.hasSidecarAssets, true);
  assert.equal(resolved[0]?.sidecarFiles.length, 2);
  assert.equal(
    resolved[0]?.sidecarFiles.some((file) => file.relativePath === "scripts/fetch.sh"),
    true,
  );
  assert.equal(
    resolved[0]?.sidecarDirectories.includes("assets/templates"),
    true,
  );
  assert.equal(
    fs.existsSync(
      path.join(
        workspaceDir,
        "teammates",
        "general",
        "skills",
        "research-playbook",
        "scripts",
        "fetch.sh",
      ),
    ),
    true,
  );
  assert.match(resolved[0]?.skillMarkdown ?? "", /granted_tools:/);
  assert.match(resolved[0]?.skillMarkdown ?? "", /- web_search/);
  assert.match(resolved[0]?.skillMarkdown ?? "", /- browser/);
});

test("writeTeammateSkills preserves sidecar files for retained skills and deletes removed skill folders", () => {
  const workspaceDir = makeTempDir("hb-teammate-skills-sidecars-");
  const initial = writeTeammateSkills({
    workspaceDir,
    teammateId: "general",
    skills: [
      {
        skillId: "frontend-playbook",
        name: "Frontend Playbook",
        content: "# Frontend Playbook\nUse the dashboard patterns.",
      },
      {
        skillId: "research-notes",
        name: "Research Notes",
        content: "# Research Notes\nGather sources.",
      },
    ],
  });
  fs.writeFileSync(
    path.join(initial[0]?.sourceDir ?? "", "helpers.sh"),
    "#!/bin/sh\necho ok\n",
    "utf8",
  );

  const resolved = writeTeammateSkills({
    workspaceDir,
    teammateId: "general",
    skills: [
      {
        skillId: "frontend-playbook",
        name: "Frontend Playbook",
        content: "# Frontend Playbook\nKeep the helper.",
      },
    ],
  });

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.hasSidecarAssets, true);
  assert.equal(
    fs.existsSync(path.join(resolved[0]?.sourceDir ?? "", "helpers.sh")),
    true,
  );
  assert.match(resolved[0]?.skillMarkdown ?? "", /description: Frontend Playbook/);
  assert.equal(
    fs.existsSync(
      path.join(
        workspaceDir,
        "teammates",
        "general",
        "skills",
        "research-notes",
      ),
    ),
    false,
  );
});

test("upsertTeammateSkill updates one skill without deleting sibling skill folders", () => {
  const workspaceDir = makeTempDir("hb-teammate-skill-upsert-");
  writeTeammateSkills({
    workspaceDir,
    teammateId: "general",
    skills: [
      {
        skillId: "frontend-playbook",
        name: "Frontend Playbook",
        content: "# Frontend Playbook\nUse the dashboard patterns.",
      },
      {
        skillId: "research-notes",
        name: "Research Notes",
        content: "# Research Notes\nGather sources.",
      },
    ],
  });

  const updated = upsertTeammateSkill({
    workspaceDir,
    teammateId: "general",
    skill: {
      skillId: "frontend-playbook",
      name: "Frontend Playbook",
      content: "# Frontend Playbook\nKeep the patterns sharp.",
    },
  });

  assert.equal(updated.skillId, "frontend-playbook");
  assert.equal(
    fs.existsSync(
      path.join(
        workspaceDir,
        "teammates",
        "general",
        "skills",
        "research-notes",
        "SKILL.md",
      ),
    ),
    true,
  );
  const loaded = loadTeammateFilesystemSkills({
    workspaceDir,
    teammateId: "general",
  });
  assert.equal(loaded.length, 2);
});

test("deleteTeammateSkill removes only the targeted teammate-local skill folder", () => {
  const workspaceDir = makeTempDir("hb-teammate-skill-delete-");
  writeTeammateSkills({
    workspaceDir,
    teammateId: "general",
    skills: [
      {
        skillId: "frontend-playbook",
        name: "Frontend Playbook",
        content: "# Frontend Playbook\nUse the dashboard patterns.",
      },
      {
        skillId: "research-notes",
        name: "Research Notes",
        content: "# Research Notes\nGather sources.",
      },
    ],
  });

  assert.equal(
    deleteTeammateSkill({
      workspaceDir,
      teammateId: "general",
      skillId: "research-notes",
    }),
    true,
  );
  assert.equal(
    fs.existsSync(
      path.join(
        workspaceDir,
        "teammates",
        "general",
        "skills",
        "research-notes",
      ),
    ),
    false,
  );
  assert.equal(
    fs.existsSync(
      path.join(
        workspaceDir,
        "teammates",
        "general",
        "skills",
        "frontend-playbook",
        "SKILL.md",
      ),
    ),
    true,
  );
  assert.equal(
    deleteTeammateSkill({
      workspaceDir,
      teammateId: "general",
      skillId: "missing-skill",
    }),
    false,
  );
});

test("resolvedTeammateSkillsForRecord only returns filesystem-backed teammate skills", () => {
  const workspaceDir = makeTempDir("hb-teammate-skills-filesystem-only-");
  const teammate = baseTeammate();

  const empty = resolvedTeammateSkillsForRecord({
    workspaceDir,
    teammate,
  });
  assert.equal(empty.length, 0);

  writeTeammateSkills({
    workspaceDir,
    teammateId: teammate.teammateId,
    skills: [
      {
        skillId: "frontend-playbook",
        name: "Frontend Playbook",
        content: "# Frontend Playbook\nUse the dashboard patterns.",
      },
    ],
  });
  const resolved = resolvedTeammateSkillsForRecord({
    workspaceDir,
    teammate,
  });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.storageOrigin, "filesystem");
  assert.equal(resolved[0]?.skillId, "frontend-playbook");
});

test("teammate skill relative path helpers return workspace-relative paths", () => {
  assert.equal(
    teammateSkillRelativeSourceDir({
      teammateId: "general",
      skillId: "frontend-playbook",
    }),
    "teammates/general/skills/frontend-playbook",
  );
  assert.equal(
    teammateSkillRelativeFilePath({
      teammateId: "general",
      skillId: "frontend-playbook",
    }),
    "teammates/general/skills/frontend-playbook/SKILL.md",
  );
  const workspaceDir = makeTempDir("hb-teammate-skills-load-");
  writeTeammateSkills({
    workspaceDir,
    teammateId: "general",
    skills: [
      {
        skillId: "frontend-playbook",
        name: "Frontend Playbook",
        content: "# Frontend Playbook\nUse the dashboard patterns.",
      },
    ],
  });
  const loaded = loadTeammateFilesystemSkills({
    workspaceDir,
    teammateId: "general",
  });
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.storageOrigin, "filesystem");
});
