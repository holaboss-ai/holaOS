import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  blockActiveSessionTodo,
  formatSessionTodoListText,
  formatSessionTodoWriteText,
  readSessionTodo,
  writeSessionTodo,
} from "./session-todo.js";

function createTodoWorkspaceRoot(prefix: string): { root: string; workspaceRoot: string; workspaceId: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspaceRoot = path.join(root, "workspace");
  const workspaceId = "workspace-1";
  fs.mkdirSync(path.join(workspaceRoot, workspaceId), { recursive: true });
  return { root, workspaceRoot, workspaceId };
}

test("session todo persists phased state and reads back an empty session independently", async () => {
  const { root, workspaceRoot, workspaceId } = createTodoWorkspaceRoot("session-todo-");

  try {
    const emptyState = await readSessionTodo({
      workspaceRoot,
      workspaceId,
      sessionId: "session-1",
    });
    assert.equal(formatSessionTodoListText(emptyState.phases), "No todo items are currently recorded for this session.");

    const { nextState } = await writeSessionTodo({
      workspaceRoot,
      workspaceId,
      sessionId: "session-1",
      toolParams: {
        ops: [
          {
            op: "replace",
            phases: [
              {
                name: "Investigation",
                tasks: [
                  {
                    content: "Inspect todowrite wiring",
                    status: "in_progress",
                    details: "runtime/harness-host/src/pi-runtime-tools.ts",
                  },
                  {
                    content: "Add tests",
                  },
                ],
              },
              {
                name: "Verification",
                tasks: [
                  {
                    content: "Verify session persistence",
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    assert.match(formatSessionTodoWriteText(nextState), /Updated todo plan with 3 tasks across 2 phases\./);

    const rereadState = await readSessionTodo({
      workspaceRoot,
      workspaceId,
      sessionId: "session-1",
    });
    assert.deepEqual(rereadState.phases, [
      {
        id: "phase-1",
        name: "Investigation",
        tasks: [
          {
            id: "task-1",
            content: "Inspect todowrite wiring",
            status: "in_progress",
            details: "runtime/harness-host/src/pi-runtime-tools.ts",
          },
          {
            id: "task-2",
            content: "Add tests",
            status: "pending",
          },
        ],
      },
      {
        id: "phase-2",
        name: "Verification",
        tasks: [
          {
            id: "task-3",
            content: "Verify session persistence",
            status: "pending",
          },
        ],
      },
    ]);

    const persistedStatePath = path.join(workspaceRoot, workspaceId, ".holaboss", "state", "todos", "session-1.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(persistedStatePath, "utf8")), {
      version: 2,
      session_id: "session-1",
      updated_at: rereadState.updated_at,
      phases: [
        {
          id: "phase-1",
          name: "Investigation",
          tasks: [
            {
              id: "task-1",
              content: "Inspect todowrite wiring",
              status: "in_progress",
              details: "runtime/harness-host/src/pi-runtime-tools.ts",
            },
            {
              id: "task-2",
              content: "Add tests",
              status: "pending",
            },
          ],
        },
        {
          id: "phase-2",
          name: "Verification",
          tasks: [
            {
              id: "task-3",
              content: "Verify session persistence",
              status: "pending",
            },
          ],
        },
      ],
      next_task_id: 4,
      next_phase_id: 3,
    });

    const otherSessionState = await readSessionTodo({
      workspaceRoot,
      workspaceId,
      sessionId: "session-2",
    });
    assert.equal(formatSessionTodoListText(otherSessionState.phases), "No todo items are currently recorded for this session.");

    await writeSessionTodo({
      workspaceRoot,
      workspaceId,
      sessionId: "session-1",
      toolParams: {
        ops: [{ op: "replace", phases: [] }],
      },
    });
    const clearedState = await readSessionTodo({
      workspaceRoot,
      workspaceId,
      sessionId: "session-1",
    });
    assert.equal(formatSessionTodoListText(clearedState.phases), "No todo items are currently recorded for this session.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("session todo applies incremental phased ops and preserves blocked tasks", async () => {
  const { root, workspaceRoot, workspaceId } = createTodoWorkspaceRoot("session-todo-ops-");

  try {
    await writeSessionTodo({
      workspaceRoot,
      workspaceId,
      sessionId: "session-1",
      toolParams: {
        ops: [
          {
            op: "replace",
            phases: [
              {
                name: "Implementation",
                tasks: [{ content: "Wire host todo state" }, { content: "Run host tests" }],
              },
            ],
          },
        ],
      },
    });

    await writeSessionTodo({
      workspaceRoot,
      workspaceId,
      sessionId: "session-1",
      toolParams: {
        ops: [
          { op: "update", id: "task-1", status: "completed" },
          { op: "add_phase", name: "Verification", tasks: [{ content: "Smoke test runtime flows" }] },
          { op: "add_task", phase: "phase-2", content: "Document the phased todo contract" },
          { op: "remove_task", id: "task-2" },
          { op: "update", id: "task-3", status: "blocked", details: "Blocked waiting for approval." },
        ],
      },
    });

    const rereadState = await readSessionTodo({
      workspaceRoot,
      workspaceId,
      sessionId: "session-1",
    });
    assert.deepEqual(rereadState.phases, [
      {
        id: "phase-1",
        name: "Implementation",
        tasks: [
          {
            id: "task-1",
            content: "Wire host todo state",
            status: "completed",
          },
        ],
      },
      {
        id: "phase-2",
        name: "Verification",
        tasks: [
          {
            id: "task-3",
            content: "Smoke test runtime flows",
            status: "blocked",
            details: "Blocked waiting for approval.",
          },
          {
            id: "task-4",
            content: "Document the phased todo contract",
            status: "pending",
          },
        ],
      },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("blockActiveSessionTodo blocks the active task and preserves later pending work", async () => {
  const { root, workspaceRoot, workspaceId } = createTodoWorkspaceRoot("session-todo-block-");

  try {
    await writeSessionTodo({
      workspaceRoot,
      workspaceId,
      sessionId: "session-1",
      toolParams: {
        ops: [
          {
            op: "replace",
            phases: [
              {
                name: "Implementation",
                tasks: [
                  { content: "Wait for approval" },
                  { content: "Continue after approval" },
                ],
              },
            ],
          },
        ],
      },
    });

    const blockedState = await blockActiveSessionTodo({
      workspaceRoot,
      workspaceId,
      sessionId: "session-1",
      detail: "Blocked waiting for approval.",
    });
    assert.ok(blockedState);
    assert.deepEqual(blockedState?.phases, [
      {
        id: "phase-1",
        name: "Implementation",
        tasks: [
          {
            id: "task-1",
            content: "Wait for approval",
            status: "blocked",
            details: "Blocked waiting for approval.",
          },
          {
            id: "task-2",
            content: "Continue after approval",
            status: "pending",
          },
        ],
      },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("session todo rejects legacy aliases and returns repair guidance for hallucinated ops", async () => {
  const { root, workspaceRoot, workspaceId } = createTodoWorkspaceRoot("session-todo-invalid-");

  try {
    await assert.rejects(
      () =>
        writeSessionTodo({
          workspaceRoot,
          workspaceId,
          sessionId: "session-1",
          toolParams: {
            ops: [
              {
                op: "replace",
                phases: [
                  {
                    title: "Implementation",
                    tasks: [{ title: "Wire host todo state" }],
                  },
                ],
              },
            ],
          },
        }),
      /Todo phases require `name`; use `name` instead of `title`\./,
    );

    await assert.rejects(
      () =>
        writeSessionTodo({
          workspaceRoot,
          workspaceId,
          sessionId: "session-1",
          toolParams: {
            ops: [{ op: "set_status", id: "task-1", status: "completed" }],
          },
        }),
      /Unsupported todo op "set_status".*Use `update` to change an existing task's status by task id.*Call `todoread` first if you need the current task ids\./is,
    );

    await assert.rejects(
      () =>
        writeSessionTodo({
          workspaceRoot,
          workspaceId,
          sessionId: "session-1",
          toolParams: {
            ops: [{ op: "update_task", id: "task-1", status: "completed" }],
          },
        }),
      /Unsupported todo op "update_task".*Use `update` to change an existing task's status by task id\./is,
    );

    await assert.rejects(
      () =>
        writeSessionTodo({
          workspaceRoot,
          workspaceId,
          sessionId: "session-1",
          toolParams: {
            ops: [
              {
                op: "replace_all",
                phases: [{ name: "Implementation", tasks: [{ content: "Wire host todo state" }] }],
              },
            ],
          },
        }),
      /Unsupported todo op "replace_all".*Use `replace` to replace the entire phased plan\./is,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
