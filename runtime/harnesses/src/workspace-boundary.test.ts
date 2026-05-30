import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createHarnessWorkspaceBoundaryPolicy,
  workspaceBoundaryViolationForToolCall,
} from "./workspace-boundary.js";

test("workspace boundary inspects hashline edit section headers", () => {
  const workspaceDir = path.join(os.tmpdir(), "workspace-boundary-fixture");
  const policy = createHarnessWorkspaceBoundaryPolicy(workspaceDir, false);

  const violation = workspaceBoundaryViolationForToolCall({
    toolName: "edit",
    toolParams: {
      input: "¶../outside.ts#0A3\nBOF\n+console.log('outside');",
    },
    policy,
  });

  assert.equal(violation, "params.input.section[0] points outside workspace: '../outside.ts'");
});

test("workspace boundary allows in-workspace hashline edit section headers", () => {
  const workspaceDir = path.join(os.tmpdir(), "workspace-boundary-fixture");
  const policy = createHarnessWorkspaceBoundaryPolicy(workspaceDir, false);

  const violation = workspaceBoundaryViolationForToolCall({
    toolName: "edit",
    toolParams: {
      input: "¶src/app.ts#0A3\nBOF\n+console.log('inside');",
    },
    policy,
  });

  assert.equal(violation, null);
});

test("workspace boundary allows approved external skill-local paths", () => {
  const workspaceDir = path.join(os.tmpdir(), "workspace-boundary-fixture");
  const externalSkillDir = path.join(
    os.tmpdir(),
    "workspace-boundary-embedded-skill",
    "create-teammate",
  );
  const policy = createHarnessWorkspaceBoundaryPolicy(workspaceDir, false, {
    allowedExternalDirs: [externalSkillDir],
  });

  const violation = workspaceBoundaryViolationForToolCall({
    toolName: "read",
    toolParams: {
      path: path.join(externalSkillDir, "SKILL.md"),
    },
    policy,
  });

  assert.equal(violation, null);
});
