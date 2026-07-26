import fs from "node:fs/promises";
import path from "node:path";
import {
  migrateLegacyWorkspaceStatePath,
  workspaceStateRelativePath,
} from "./workspace-bundle-paths.js";

const SESSION_TODO_DIR_SEGMENTS = ["todos"] as const;
const LEGACY_SESSION_TODO_DIR_SEGMENTS = [".holaboss", "todos"] as const;
const LEGACY_PI_TODO_DIR_SEGMENTS = [".holaboss", "pi-agent", "todos"] as const;
const SESSION_TODO_STATE_VERSION = 2;

export const SESSION_TODO_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "abandoned",
] as const;

export const SESSION_TODO_WRITE_OPS = ["replace", "add_phase", "add_task", "update", "remove_task"] as const;
export const SESSION_TODO_WRITE_OPS_TEXT =
  "`replace`, `add_phase`, `add_task`, `update`, and `remove_task`";
export const SESSION_TODO_WRITE_ALIAS_WARNING =
  "Do not invent alias op names such as `replace_all`, `update_task`, or `set_status`.";

export type SessionTodoStatus = (typeof SESSION_TODO_STATUSES)[number];

export interface SessionTodoItem {
  id: string;
  content: string;
  status: SessionTodoStatus;
  notes?: string;
  details?: string;
}

export interface SessionTodoPhase {
  id: string;
  name: string;
  tasks: SessionTodoItem[];
}

export interface SessionTodoState {
  version: number;
  session_id: string;
  updated_at: string | null;
  phases: SessionTodoPhase[];
  next_task_id: number;
  next_phase_id: number;
}

type TodoPathResolution = {
  relativePath: string;
  absolutePath: string;
  legacyRelativePaths: string[];
  legacyAbsolutePaths: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = optionalTrimmedString(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function sanitizeSessionTodoSegment(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "session";
}

function todoPaths(params: {
  workspaceRoot: string;
  workspaceId: string;
  sessionId: string;
}): TodoPathResolution {
  const fileName = `${sanitizeSessionTodoSegment(params.sessionId)}.json`;
  const workspaceDir = path.join(params.workspaceRoot, params.workspaceId);
  const relativePath = workspaceStateRelativePath(...SESSION_TODO_DIR_SEGMENTS, fileName);
  const legacyRelativePaths = [
    path.posix.join(...LEGACY_SESSION_TODO_DIR_SEGMENTS, fileName),
    path.posix.join(...LEGACY_PI_TODO_DIR_SEGMENTS, fileName),
  ];
  let absolutePath = migrateLegacyWorkspaceStatePath({
    workspaceDir,
    relativeSegments: [...SESSION_TODO_DIR_SEGMENTS, fileName],
    legacyRelativeSegments: [...LEGACY_SESSION_TODO_DIR_SEGMENTS, fileName],
  });
  absolutePath = migrateLegacyWorkspaceStatePath({
    workspaceDir,
    relativeSegments: [...SESSION_TODO_DIR_SEGMENTS, fileName],
    legacyRelativeSegments: [...LEGACY_PI_TODO_DIR_SEGMENTS, fileName],
  });
  return {
    relativePath,
    absolutePath,
    legacyRelativePaths,
    legacyAbsolutePaths: legacyRelativePaths.map((legacyRelativePath) =>
      path.join(workspaceDir, legacyRelativePath),
    ),
  };
}

function emptySessionTodoState(sessionId: string): SessionTodoState {
  return {
    version: SESSION_TODO_STATE_VERSION,
    session_id: sessionId,
    updated_at: null,
    phases: [],
    next_task_id: 1,
    next_phase_id: 1,
  };
}

function cloneSessionTodoPhases(phases: SessionTodoPhase[]): SessionTodoPhase[] {
  return phases.map((phase) => ({
    id: phase.id,
    name: phase.name,
    tasks: phase.tasks.map((task) => ({ ...task })),
  }));
}

export function countSessionTodoTasks(phases: SessionTodoPhase[]): number {
  return phases.reduce((total, phase) => total + phase.tasks.length, 0);
}

export function flattenSessionTodoSummaries(
  phases: SessionTodoPhase[],
): Array<{ content: string; status: SessionTodoStatus }> {
  return phases.flatMap((phase) =>
    phase.tasks.map((task) => ({ content: task.content, status: task.status })),
  );
}

function nextSessionTodoIds(phases: SessionTodoPhase[]): { nextTaskId: number; nextPhaseId: number } {
  let nextTaskId = 1;
  let nextPhaseId = 1;
  for (const phase of phases) {
    const phaseMatch = /^phase-(\d+)$/i.exec(phase.id);
    if (phaseMatch) {
      nextPhaseId = Math.max(nextPhaseId, Number(phaseMatch[1]) + 1);
    }
    for (const task of phase.tasks) {
      const taskMatch = /^task-(\d+)$/i.exec(task.id);
      if (taskMatch) {
        nextTaskId = Math.max(nextTaskId, Number(taskMatch[1]) + 1);
      }
    }
  }
  return { nextTaskId, nextPhaseId };
}

function normalizeSessionTodoStatus(value: unknown): SessionTodoStatus | null {
  const normalized = optionalTrimmedString(value)?.toLowerCase().replace(/[\s-]+/g, "_") ?? "";
  switch (normalized) {
    case "pending":
    case "in_progress":
    case "blocked":
    case "completed":
    case "abandoned":
      return normalized;
    default:
      return null;
  }
}

function normalizePersistedSessionTodoItem(value: unknown, fallbackId: string): SessionTodoItem | null {
  if (!isRecord(value)) {
    return null;
  }
  const content = optionalTrimmedString(value.content);
  if (!content) {
    return null;
  }
  const status = normalizeSessionTodoStatus(value.status) ?? "pending";
  const id = firstNonEmptyString(value.id, fallbackId) ?? fallbackId;
  const notes = optionalTrimmedString(value.notes) ?? undefined;
  const details = optionalTrimmedString(value.details) ?? undefined;
  return {
    id,
    content,
    status,
    ...(notes ? { notes } : {}),
    ...(details ? { details } : {}),
  };
}

function normalizePersistedSessionTodoPhase(
  value: unknown,
  fallbackId: string,
  nextTaskId: number,
): { phase: SessionTodoPhase | null; nextTaskId: number } {
  if (!isRecord(value)) {
    return { phase: null, nextTaskId };
  }
  const name = optionalTrimmedString(value.name);
  if (!name) {
    return { phase: null, nextTaskId };
  }
  const tasks: SessionTodoItem[] = [];
  let localNextTaskId = nextTaskId;
  if (Array.isArray(value.tasks)) {
    for (const rawTask of value.tasks) {
      const task = normalizePersistedSessionTodoItem(rawTask, `task-${localNextTaskId}`);
      localNextTaskId += 1;
      if (task) {
        tasks.push(task);
      }
    }
  }
  return {
    phase: {
      id: firstNonEmptyString(value.id, fallbackId) ?? fallbackId,
      name,
      tasks,
    },
    nextTaskId: localNextTaskId,
  };
}

function normalizeLegacySessionTodoPhases(todos: unknown[]): SessionTodoPhase[] {
  const tasks: SessionTodoItem[] = [];
  let nextTaskId = 1;
  for (const rawTask of todos) {
    const task = normalizePersistedSessionTodoItem(rawTask, `task-${nextTaskId}`);
    nextTaskId += 1;
    if (task) {
      tasks.push(task);
    }
  }
  return tasks.length > 0
    ? [
        {
          id: "phase-1",
          name: "Tasks",
          tasks,
        },
      ]
    : [];
}

function normalizeInProgressSessionTodoTask(phases: SessionTodoPhase[]): void {
  const orderedTasks = phases.flatMap((phase) => phase.tasks);
  if (orderedTasks.length === 0) {
    return;
  }

  const inProgressTasks = orderedTasks.filter((task) => task.status === "in_progress");
  if (inProgressTasks.length > 1) {
    for (const task of inProgressTasks.slice(1)) {
      task.status = "pending";
    }
  }
  if (inProgressTasks.length > 0) {
    return;
  }

  const hasBlockedTask = orderedTasks.some((task) => task.status === "blocked");
  if (hasBlockedTask) {
    return;
  }

  const firstPendingTask = orderedTasks.find((task) => task.status === "pending");
  if (firstPendingTask) {
    firstPendingTask.status = "in_progress";
  }
}

async function readExistingStateText(paths: TodoPathResolution): Promise<string | null> {
  try {
    return await fs.readFile(paths.absolutePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  for (const legacyAbsolutePath of paths.legacyAbsolutePaths) {
    try {
      return await fs.readFile(legacyAbsolutePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return null;
}

export async function readSessionTodo(params: {
  workspaceRoot: string;
  workspaceId: string;
  sessionId: string;
}): Promise<SessionTodoState> {
  const paths = todoPaths(params);
  const raw = await readExistingStateText(paths);
  if (!raw) {
    return emptySessionTodoState(params.sessionId);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptySessionTodoState(params.sessionId);
  }
  if (!isRecord(parsed)) {
    return emptySessionTodoState(params.sessionId);
  }

  const normalizedSessionId = firstNonEmptyString(parsed.session_id, params.sessionId) ?? params.sessionId;
  let phases: SessionTodoPhase[] = [];
  let nextTaskId = 1;

  if (Array.isArray(parsed.phases)) {
    for (const rawPhase of parsed.phases) {
      const normalized = normalizePersistedSessionTodoPhase(rawPhase, `phase-${phases.length + 1}`, nextTaskId);
      nextTaskId = normalized.nextTaskId;
      if (normalized.phase) {
        phases.push(normalized.phase);
      }
    }
  } else if (Array.isArray(parsed.todos)) {
    phases = normalizeLegacySessionTodoPhases(parsed.todos);
  }

  normalizeInProgressSessionTodoTask(phases);
  const computedIds = nextSessionTodoIds(phases);

  return {
    version:
      typeof parsed.version === "number" && Number.isFinite(parsed.version)
        ? parsed.version
        : SESSION_TODO_STATE_VERSION,
    session_id: normalizedSessionId,
    updated_at: optionalTrimmedString(parsed.updated_at) ?? null,
    phases,
    next_task_id:
      typeof parsed.next_task_id === "number" && Number.isFinite(parsed.next_task_id)
        ? Math.max(parsed.next_task_id, computedIds.nextTaskId)
        : computedIds.nextTaskId,
    next_phase_id:
      typeof parsed.next_phase_id === "number" && Number.isFinite(parsed.next_phase_id)
        ? Math.max(parsed.next_phase_id, computedIds.nextPhaseId)
        : computedIds.nextPhaseId,
  };
}

async function writeSessionTodoState(params: {
  workspaceRoot: string;
  workspaceId: string;
  sessionId: string;
  phases: SessionTodoPhase[];
}): Promise<SessionTodoState> {
  const paths = todoPaths(params);
  const phases = cloneSessionTodoPhases(params.phases);
  normalizeInProgressSessionTodoTask(phases);
  const ids = nextSessionTodoIds(phases);
  const nextState: SessionTodoState = {
    version: SESSION_TODO_STATE_VERSION,
    session_id: params.sessionId,
    updated_at: new Date().toISOString(),
    phases,
    next_task_id: ids.nextTaskId,
    next_phase_id: ids.nextPhaseId,
  };

  await fs.mkdir(path.dirname(paths.absolutePath), { recursive: true });
  const tempPath = `${paths.absolutePath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, paths.absolutePath);
  for (const legacyAbsolutePath of paths.legacyAbsolutePaths) {
    await fs.rm(legacyAbsolutePath, { force: true }).catch(() => {});
  }
  return nextState;
}

function parseSessionTodoInputTask(value: unknown, fallbackId: string): SessionTodoItem {
  if (!isRecord(value)) {
    throw new Error("Todo task entries must be objects.");
  }
  const content = optionalTrimmedString(value.content);
  if (!content) {
    if (optionalTrimmedString(value.title)) {
      throw new Error("Todo tasks require `content`; use `content` instead of `title`.");
    }
    throw new Error("Todo tasks require a non-empty `content`.");
  }
  const status = value.status === undefined ? "pending" : normalizeSessionTodoStatus(value.status);
  if (!status) {
    throw new Error(`Unsupported todo status: ${String(value.status)}`);
  }
  const notes = optionalTrimmedString(value.notes) ?? undefined;
  const details = optionalTrimmedString(value.details) ?? undefined;
  const id = firstNonEmptyString(value.id, fallbackId) ?? fallbackId;
  return {
    id,
    content,
    status,
    ...(notes ? { notes } : {}),
    ...(details ? { details } : {}),
  };
}

function buildSessionTodoPhaseFromInput(
  value: unknown,
  phaseId: string,
  nextTaskId: number,
): { phase: SessionTodoPhase; nextTaskId: number } {
  if (!isRecord(value)) {
    throw new Error("Todo phases must be objects.");
  }
  const name = optionalTrimmedString(value.name);
  if (!name) {
    if (optionalTrimmedString(value.title)) {
      throw new Error("Todo phases require `name`; use `name` instead of `title`.");
    }
    throw new Error("Todo phases require a non-empty `name`.");
  }
  const tasks: SessionTodoItem[] = [];
  let localNextTaskId = nextTaskId;
  const rawTasks = Array.isArray(value.tasks) ? value.tasks : [];
  for (const rawTask of rawTasks) {
    tasks.push(parseSessionTodoInputTask(rawTask, `task-${localNextTaskId}`));
    localNextTaskId += 1;
  }
  return {
    phase: {
      id: firstNonEmptyString(value.id, phaseId) ?? phaseId,
      name,
      tasks,
    },
    nextTaskId: localNextTaskId,
  };
}

function parseSessionTodoWriteOps(toolParams: unknown): Array<Record<string, unknown>> {
  if (!isRecord(toolParams) || !Array.isArray(toolParams.ops)) {
    throw new Error("Todo Write requires an `ops` array.");
  }
  if (toolParams.ops.length === 0) {
    throw new Error("Todo Write requires at least one op.");
  }
  return toolParams.ops.map((op) => {
    if (!isRecord(op)) {
      throw new Error("Todo ops must be objects.");
    }
    return op;
  });
}

function sessionTodoWriteRepairError(op: Record<string, unknown>): Error {
  const opName = firstNonEmptyString(op.op);
  const baseLines = [
    `Unsupported todo op ${opName ? `"${opName}"` : '"<missing>"'}.`,
    `Valid \`op\` values are exactly ${SESSION_TODO_WRITE_OPS_TEXT}.`,
    SESSION_TODO_WRITE_ALIAS_WARNING,
  ];

  if (opName === "set_status" || opName === "update_task") {
    return new Error(
      [
        ...baseLines,
        "Use `update` to change an existing task's status by task id.",
        "Example:",
        '{"ops":[{"op":"update","id":"task-1","status":"completed"}]}',
        "Call `todoread` first if you need the current task ids.",
      ].join("\n"),
    );
  }

  if (opName === "replace_all") {
    return new Error(
      [
        ...baseLines,
        "Use `replace` to replace the entire phased plan.",
        "Example:",
        '{"ops":[{"op":"replace","phases":[{"name":"Phase name","tasks":[{"content":"Task text"}]}]}]}',
      ].join("\n"),
    );
  }

  return new Error(
    [
      ...baseLines,
      "Use `replace` for a full plan rewrite, `add_phase` to append a phase, `add_task` to append a task, `update` to modify an existing task by id, or `remove_task` to delete a task by id.",
    ].join("\n"),
  );
}

function findSessionTodoTask(phases: SessionTodoPhase[], id: string): SessionTodoItem | undefined {
  for (const phase of phases) {
    const task = phase.tasks.find((entry) => entry.id === id);
    if (task) {
      return task;
    }
  }
  return undefined;
}

function applySessionTodoOps(
  currentState: SessionTodoState,
  ops: Array<Record<string, unknown>>,
): { phases: SessionTodoPhase[]; nextTaskId: number; nextPhaseId: number } {
  const nextState = {
    phases: cloneSessionTodoPhases(currentState.phases),
    nextTaskId: currentState.next_task_id,
    nextPhaseId: currentState.next_phase_id,
  };

  for (const op of ops) {
    const opName = firstNonEmptyString(op.op);
    switch (opName) {
      case "replace": {
        if (!Array.isArray(op.phases)) {
          throw new Error("Todo replace requires a `phases` array.");
        }
        nextState.phases = [];
        nextState.nextTaskId = 1;
        nextState.nextPhaseId = 1;
        for (const rawPhase of op.phases) {
          const built = buildSessionTodoPhaseFromInput(
            rawPhase,
            `phase-${nextState.nextPhaseId}`,
            nextState.nextTaskId,
          );
          nextState.nextPhaseId += 1;
          nextState.nextTaskId = built.nextTaskId;
          nextState.phases.push(built.phase);
        }
        break;
      }
      case "add_phase": {
        const built = buildSessionTodoPhaseFromInput(op, `phase-${nextState.nextPhaseId}`, nextState.nextTaskId);
        nextState.nextPhaseId += 1;
        nextState.nextTaskId = built.nextTaskId;
        nextState.phases.push(built.phase);
        break;
      }
      case "add_task": {
        const phaseId = firstNonEmptyString(op.phase);
        if (!phaseId) {
          throw new Error("Todo add_task requires a `phase` id.");
        }
        const phase = nextState.phases.find((entry) => entry.id === phaseId);
        if (!phase) {
          throw new Error(`Todo phase "${phaseId}" was not found.`);
        }
        phase.tasks.push(parseSessionTodoInputTask(op, `task-${nextState.nextTaskId}`));
        nextState.nextTaskId += 1;
        break;
      }
      case "update": {
        const taskId = firstNonEmptyString(op.id);
        if (!taskId) {
          throw new Error("Todo update requires an `id`.");
        }
        const task = findSessionTodoTask(nextState.phases, taskId);
        if (!task) {
          throw new Error(`Todo task "${taskId}" was not found.`);
        }
        if (op.status !== undefined) {
          const status = normalizeSessionTodoStatus(op.status);
          if (!status) {
            throw new Error(`Unsupported todo status: ${String(op.status)}`);
          }
          task.status = status;
        }
        if (Object.prototype.hasOwnProperty.call(op, "content")) {
          const content = optionalTrimmedString(op.content);
          if (!content) {
            throw new Error("Todo update requires a non-empty `content` when provided.");
          }
          task.content = content;
        }
        if (Object.prototype.hasOwnProperty.call(op, "notes")) {
          const notes = optionalTrimmedString(op.notes);
          if (notes) {
            task.notes = notes;
          } else {
            delete task.notes;
          }
        }
        if (Object.prototype.hasOwnProperty.call(op, "details")) {
          const details = optionalTrimmedString(op.details);
          if (details) {
            task.details = details;
          } else {
            delete task.details;
          }
        }
        break;
      }
      case "remove_task": {
        const taskId = firstNonEmptyString(op.id);
        if (!taskId) {
          throw new Error("Todo remove_task requires an `id`.");
        }
        let removed = false;
        for (const phase of nextState.phases) {
          const taskIndex = phase.tasks.findIndex((task) => task.id === taskId);
          if (taskIndex === -1) {
            continue;
          }
          phase.tasks.splice(taskIndex, 1);
          removed = true;
          break;
        }
        if (!removed) {
          throw new Error(`Todo task "${taskId}" was not found.`);
        }
        break;
      }
      default:
        throw sessionTodoWriteRepairError(op);
    }
    normalizeInProgressSessionTodoTask(nextState.phases);
  }

  return nextState;
}

function currentSessionTodoPhaseIndex(phases: SessionTodoPhase[]): number {
  const currentIndex = phases.findIndex((phase) =>
    phase.tasks.some(
      (task) =>
        task.status === "pending" ||
        task.status === "in_progress" ||
        task.status === "blocked",
    ),
  );
  if (currentIndex !== -1) {
    return currentIndex;
  }
  return phases.length === 0 ? -1 : phases.length - 1;
}

function formatSessionTodoMarker(status: SessionTodoStatus): string {
  switch (status) {
    case "completed":
      return "[x]";
    case "in_progress":
      return "[>]";
    case "blocked":
      return "[!]";
    case "abandoned":
      return "[-]";
    default:
      return "[ ]";
  }
}

export function formatSessionTodoListText(phases: SessionTodoPhase[]): string {
  const taskCount = countSessionTodoTasks(phases);
  if (taskCount === 0) {
    return "No todo items are currently recorded for this session.";
  }

  const lines = [
    `Current session todo plan (${taskCount} task${taskCount === 1 ? "" : "s"} across ${phases.length} phase${phases.length === 1 ? "" : "s"}):`,
  ];
  for (const [index, phase] of phases.entries()) {
    const completedTasks = phase.tasks.filter(
      (task) => task.status === "completed" || task.status === "abandoned",
    ).length;
    lines.push(`Phase ${index + 1}/${phases.length} "${phase.name}" - ${completedTasks}/${phase.tasks.length} complete`);
    for (const task of phase.tasks) {
      lines.push(`  ${formatSessionTodoMarker(task.status)} ${task.id} ${task.content}`);
      if ((task.status === "in_progress" || task.status === "blocked") && task.details) {
        for (const detailLine of task.details.split("\n")) {
          lines.push(`      ${detailLine}`);
        }
      }
    }
  }
  return lines.join("\n");
}

export function formatSessionTodoWriteText(nextState: SessionTodoState): string {
  const taskCount = countSessionTodoTasks(nextState.phases);
  if (taskCount === 0) {
    return "Todo plan cleared.";
  }

  const incomplete = nextState.phases.flatMap((phase) =>
    phase.tasks
      .filter(
        (task) =>
          task.status === "pending" ||
          task.status === "in_progress" ||
          task.status === "blocked",
      )
      .map((task) => ({ ...task, phaseName: phase.name })),
  );
  const currentPhaseIndex = currentSessionTodoPhaseIndex(nextState.phases);
  const lines = [
    `Updated todo plan with ${taskCount} task${taskCount === 1 ? "" : "s"} across ${nextState.phases.length} phase${nextState.phases.length === 1 ? "" : "s"}.`,
  ];

  if (incomplete.length === 0) {
    lines.push("Remaining items: none.");
  } else {
    lines.push(`Remaining items (${incomplete.length}):`);
    for (const task of incomplete) {
      lines.push(`  - ${task.id} ${task.content} [${task.status}] (${task.phaseName})`);
      if ((task.status === "in_progress" || task.status === "blocked") && task.details) {
        for (const detailLine of task.details.split("\n")) {
          lines.push(`      ${detailLine}`);
        }
      }
    }
  }

  if (currentPhaseIndex !== -1) {
    const currentPhase = nextState.phases[currentPhaseIndex];
    const completedTasks = currentPhase.tasks.filter(
      (task) => task.status === "completed" || task.status === "abandoned",
    ).length;
    lines.push(`Current phase: ${currentPhase.name} (${completedTasks}/${currentPhase.tasks.length} complete).`);
  }

  lines.push("");
  lines.push(formatSessionTodoListText(nextState.phases));
  return lines.join("\n");
}

export async function writeSessionTodo(params: {
  workspaceRoot: string;
  workspaceId: string;
  sessionId: string;
  toolParams: unknown;
}): Promise<{ previousState: SessionTodoState; nextState: SessionTodoState }> {
  const previousState = await readSessionTodo(params);
  const ops = parseSessionTodoWriteOps(params.toolParams);
  const nextPlan = applySessionTodoOps(previousState, ops);
  const nextState = await writeSessionTodoState({
    workspaceRoot: params.workspaceRoot,
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    phases: nextPlan.phases,
  });
  return { previousState, nextState };
}

export async function blockActiveSessionTodo(params: {
  workspaceRoot: string;
  workspaceId: string;
  sessionId: string;
  detail: string;
}): Promise<SessionTodoState | null> {
  const currentState = await readSessionTodo(params);
  if (countSessionTodoTasks(currentState.phases) === 0) {
    return null;
  }
  const nextPhases = cloneSessionTodoPhases(currentState.phases);
  const activeTask =
    nextPhases.flatMap((phase) => phase.tasks).find((task) => task.status === "in_progress") ??
    nextPhases.flatMap((phase) => phase.tasks).find((task) => task.status === "pending");
  if (!activeTask) {
    return null;
  }
  activeTask.status = "blocked";
  const existingDetails = optionalTrimmedString(activeTask.details);
  activeTask.details =
    existingDetails && existingDetails !== params.detail
      ? `${existingDetails}\n${params.detail}`
      : params.detail;
  return await writeSessionTodoState({
    workspaceRoot: params.workspaceRoot,
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    phases: nextPhases,
  });
}

export async function readSessionTodoStatus(params: {
  workspaceRoot: string;
  workspaceId: string;
  sessionId: string;
}): Promise<{ exists: boolean; blocked: boolean; state: SessionTodoState }> {
  const state = await readSessionTodo(params);
  return {
    exists: countSessionTodoTasks(state.phases) > 0,
    blocked: state.phases.flatMap((phase) => phase.tasks).some((task) => task.status === "blocked"),
    state,
  };
}
