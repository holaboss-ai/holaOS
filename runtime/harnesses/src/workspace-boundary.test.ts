import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createHarnessWorkspaceBoundaryPolicy,
  resolvePathWithinHarnessWorkspace,
} from "./workspace-boundary.js";

test("resolvePathWithinHarnessWorkspace resolves a relative path against the workspace dir", () => {
  const workspaceDir = path.join(os.tmpdir(), "workspace-boundary-fixture");
  const policy = createHarnessWorkspaceBoundaryPolicy(workspaceDir, false);

  const resolved = resolvePathWithinHarnessWorkspace(policy, "notes/todo.md");
  assert.equal(resolved, path.resolve(workspaceDir, "notes/todo.md"));
});

test("resolvePathWithinHarnessWorkspace resolves outside-workspace paths instead of rejecting them (boundary removed)", () => {
  const workspaceDir = path.join(os.tmpdir(), "workspace-boundary-fixture");
  const policy = createHarnessWorkspaceBoundaryPolicy(workspaceDir, false);

  // Previously returned null for a path outside the workspace; the boundary is
  // gone, so the absolute path is now resolved and returned.
  const outside = path.join(os.tmpdir(), "outside-ws", "README.md");
  const resolved = resolvePathWithinHarnessWorkspace(policy, outside);
  assert.notEqual(resolved, null);
  assert.ok(resolved!.endsWith(path.join("outside-ws", "README.md")));
});
