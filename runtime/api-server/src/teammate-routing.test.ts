import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import type { TeammateRecord } from "@holaboss/runtime-state-store";

import {
  buildTeammateRoutingRosterEntry,
  selectDelegatedTaskTeammateByCapability,
} from "./teammate-routing.js";
import { writeTeammateSkills } from "./teammate-skill-files.js";

const TEMP_DIRS: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

function teammate(overrides: Partial<TeammateRecord> = {}): TeammateRecord {
  return {
    teammateId: "general",
    workspaceId: "workspace-1",
    name: "General",
    kind: "custom",
    status: "active",
    instructions: null,
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

test("buildTeammateRoutingRosterEntry reflects teammate-local filesystem skill metadata", () => {
  const workspaceDir = makeTempDir("hb-teammate-routing-roster-");
  writeTeammateSkills({
    workspaceDir,
    teammateId: "frontend",
    skills: [
      {
        skillId: "frontend-playbook",
        skillMarkdown: [
          "---",
          "name: frontend-playbook",
          "description: Patterns for polished dashboard UI.",
          "---",
          "",
          "# Frontend Playbook",
          "Use the dashboard patterns.",
          "",
        ].join("\n"),
      },
    ],
  });

  const entry = buildTeammateRoutingRosterEntry(
    teammate({
      teammateId: "frontend",
      name: "Frontend",
    }),
    { workspaceDir },
  );

  assert.deepEqual(entry.skill_names, ["frontend-playbook"]);
  assert.deepEqual(entry.skills, [
    {
      name: "frontend-playbook",
      description: "Patterns for polished dashboard UI.",
    },
  ]);
  assert.equal(entry.capabilities.includes("Frontend Playbook"), false);
});

test("selectDelegatedTaskTeammateByCapability scores teammate-local filesystem skills for routing", () => {
  const workspaceDir = makeTempDir("hb-teammate-routing-select-");
  const general = teammate({
    teammateId: "general",
    name: "General",
  });
  const frontend = teammate({
    teammateId: "frontend",
    name: "Frontend",
    capabilityProfile: {
      summary: null,
      capabilities: [],
    },
  });
  writeTeammateSkills({
    workspaceDir,
    teammateId: "frontend",
    skills: [
      {
        skillId: "frontend-playbook",
        name: "Frontend Playbook",
        content: "# Frontend Playbook\nOwn React dashboard work and UI polish.",
      },
    ],
  });

  const selected = selectDelegatedTaskTeammateByCapability({
    general,
    teammates: [general, frontend],
    workspaceDir,
    query: {
      title: "Polish the dashboard",
      goal: "Tighten the React UI and empty states.",
      context: "Need frontend implementation help.",
      tools: ["file", "terminal"],
    },
  });

  assert.equal(selected.teammateId, "frontend");
});

test("selectDelegatedTaskTeammateByCapability prefers App Builder for app-domain work over General fallback", () => {
  const general = teammate({
    teammateId: "general",
    name: "General",
    kind: "system",
    capabilityProfile: {
      summary: "Fallback executor for non-app implementation and research.",
      capabilities: ["generalist", "implementation", "research", "fallback"],
    },
  });
  const appBuilder = teammate({
    teammateId: "app_builder",
    name: "App Builder",
    kind: "system",
    capabilityProfile: {
      summary: "Specialist builder for holaOS apps, dashboard surfaces, runtime wiring, and polish.",
      capabilities: ["apps", "dashboards", "ui", "sdk", "implementation", "lifecycle", "polish"],
    },
  });

  const selected = selectDelegatedTaskTeammateByCapability({
    general,
    teammates: [general, appBuilder],
    query: {
      title: "Build a client dashboard app",
      goal: "Create and register a managed workspace app, then build and verify it.",
      context: "This needs workspace_apps_scaffold and workspace_apps_build.",
      tools: ["workspace_apps_scaffold", "workspace_apps_build"],
    },
  });

  assert.equal(selected.teammateId, "app_builder");
});
