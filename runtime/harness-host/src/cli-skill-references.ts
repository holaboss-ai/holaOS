import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import {
  parseHarnessQuotedSkillInstruction,
  resolveHarnessQuotedSkillSectionsFromWorkspace,
  type HarnessWorkspaceSkillLoadResult,
  type HarnessWorkspaceSkillSource,
} from "../../harnesses/src/workspace-skills.js";

/**
 * Leading `/skill-name` lines in a Holaboss instruction are a wire convention
 * the desktop composer emits when a workspace skill is quoted. `pi` expands them
 * in-process (see resolveQuotedSkillSections in pi.ts). The CLI harnesses,
 * however, pass `request.instruction` verbatim to their CLI — so `claude` reads
 * the raw `/content-writer` line as a native slash command and answers
 * "Unknown command: /content-writer" (codex would similarly forward a
 * meaningless `/name` line). This shared helper reproduces pi's expansion so
 * every CLI harness inlines the referenced skill instead.
 */

// A lightweight skill loader for a single directory: a workspace skill dir holds
// a `SKILL.md` directly, and a skills-root dir holds one per immediate subdir.
// Covers both shapes so callers can pass either. (pi uses the pi-coding-agent
// loader; CLI harnesses must not pull that SDK in, and only need SKILL.md.)
function loadWorkspaceSkillsFromDir(
  dir: string,
): HarnessWorkspaceSkillLoadResult<HarnessWorkspaceSkillSource> {
  const skills: HarnessWorkspaceSkillSource[] = [];
  const addIfSkillDir = (skillDir: string): void => {
    const filePath = join(skillDir, "SKILL.md");
    if (existsSync(filePath)) {
      skills.push({ name: basename(skillDir), filePath, baseDir: skillDir });
    }
  };
  addIfSkillDir(dir);
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const subdir = join(dir, entry);
    try {
      if (statSync(subdir).isDirectory()) {
        addIfSkillDir(subdir);
      }
    } catch {
      // unreadable entry — skip
    }
  }
  return { skills, diagnostics: [] };
}

/**
 * Expand leading `/skill-name` references in a CLI harness instruction into
 * inlined `<skill>…</skill>` blocks (with the `/name` lines stripped from the
 * body) — mirroring how `pi` handles the same wire convention. No-op (returns
 * the instruction unchanged, no filesystem work) when there are no leading skill
 * references, which is the common case.
 *
 * Skill resolution mirrors pi: the workspace-local `skills/` dir plus the
 * request's `workspace_skill_dirs` (the same dirs claude-code stages under
 * `.claude/skills`). Unresolved references are surfaced as a note rather than
 * silently dropped.
 */
export function expandCliHarnessSkillReferences(params: {
  instruction: string;
  workspaceDir: string;
  workspaceSkillDirs: readonly string[];
}): string {
  // Fast path: no leading `/name` lines → don't touch the filesystem.
  if (parseHarnessQuotedSkillInstruction(params.instruction).skillIds.length === 0) {
    return params.instruction;
  }

  const { blocks, missing, body } = resolveHarnessQuotedSkillSectionsFromWorkspace({
    instruction: params.instruction,
    workspaceSkillDirs: [
      join(params.workspaceDir, "skills"),
      ...params.workspaceSkillDirs,
    ],
    loadSkillsFromDir: loadWorkspaceSkillsFromDir,
  });

  const sections: string[] = [];
  if (blocks.length > 0) {
    sections.push(["Quoted workspace skills:", ...blocks].join("\n\n"));
  }
  if (missing.length > 0) {
    sections.push(
      `Quoted workspace skills not found in this workspace: ${missing.join(", ")}`,
    );
  }
  const trimmedBody = body.trim();
  if (trimmedBody) {
    sections.push(trimmedBody);
  }
  // If parsing found only `/name` lines and nothing resolved (blocks + body
  // empty), fall back to the original so we never send an empty prompt.
  return sections.length > 0 ? sections.join("\n\n") : params.instruction;
}
