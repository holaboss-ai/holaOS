import assert from "node:assert/strict";
import test from "node:test";

import { withWorkspaceMemoryReadModelRepairOperation } from "./workspace-memory-repair.js";

test("withWorkspaceMemoryReadModelRepairOperation coalesces concurrent repairs for the same workspace and model", async () => {
  let callCount = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const operation = async () => {
    callCount += 1;
    await gate;
  };

  const first = withWorkspaceMemoryReadModelRepairOperation(
    {
      workspaceId: "workspace-1",
      selectedModel: null,
    },
    operation,
  );
  const second = withWorkspaceMemoryReadModelRepairOperation(
    {
      workspaceId: "workspace-1",
      selectedModel: null,
    },
    operation,
  );

  assert.equal(callCount, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(callCount, 1);
});

test("withWorkspaceMemoryReadModelRepairOperation keeps different selected-model repairs independent", async () => {
  let callCount = 0;

  const operation = async () => {
    callCount += 1;
  };

  await Promise.all([
    withWorkspaceMemoryReadModelRepairOperation(
      {
        workspaceId: "workspace-1",
        selectedModel: null,
      },
      operation,
    ),
    withWorkspaceMemoryReadModelRepairOperation(
      {
        workspaceId: "workspace-1",
        selectedModel: "gpt-5.5",
      },
      operation,
    ),
  ]);

  assert.equal(callCount, 2);
});
