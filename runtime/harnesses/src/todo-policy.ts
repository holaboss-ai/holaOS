import fs from "node:fs";
import path from "node:path";

export const HARNESS_TODO_STATE_DIR = "todos";
export const HARNESS_TODO_STATE_VERSION = 2;
export const HARNESS_TODO_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "abandoned",
] as const;
export const HARNESS_TODO_WRITE_OPS = ["replace", "add_phase", "add_task", "update", "remove_task"] as const;
export const HARNESS_TODO_WRITE_OPS_TEXT =
  "`replace`, `add_phase`, `add_task`, `update`, and `remove_task`";
export const HARNESS_TODO_WRITE_ALIAS_WARNING =
  "Do not invent alias op names such as `replace_all`, `update_task`, or `set_status`.";

export type HarnessTodoStatus = (typeof HARNESS_TODO_STATUSES)[number];

export interface HarnessTodoItem {
  id: string;
  content: string;
  status: HarnessTodoStatus;
  notes?: string;
  details?: string;
}

export interface HarnessTodoPhase {
  id: string;
  name: string;
  tasks: HarnessTodoItem[];
}

export interface HarnessTodoState {
  version: number;
  session_id: string;
  updated_at: string | null;
  phases: HarnessTodoPhase[];
  next_task_id: number;
  next_phase_id: number;
}

export interface HarnessToolTextContent {
  type: "text";
  text: string;
}

export interface HarnessToolResultLike<TDetails = unknown> {
  content: HarnessToolTextContent[];
  details?: TDetails;
}

export interface HarnessToolDefinitionLike<TParams = unknown, TDetails = unknown> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: TParams,
    signal: AbortSignal | undefined,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<HarnessToolResultLike<TDetails>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function sanitizeHarnessStateSegment(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "default";
}

export function resolveHarnessTodoStatePath(stateDir: string, sessionId: string): string {
  return path.join(stateDir, HARNESS_TODO_STATE_DIR, `${sanitizeHarnessStateSegment(sessionId)}.json`);
}

function emptyHarnessTodoState(sessionId: string): HarnessTodoState {
  return {
    version: HARNESS_TODO_STATE_VERSION,
    session_id: sessionId,
    updated_at: null,
    phases: [],
    next_task_id: 1,
    next_phase_id: 1,
  };
}

function normalizeHarnessTodoStatus(value: unknown): HarnessTodoStatus | null {
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

function cloneHarnessTodoPhases(phases: HarnessTodoPhase[]): HarnessTodoPhase[] {
  return phases.map((phase) => ({
    id: phase.id,
    name: phase.name,
    tasks: phase.tasks.map((task) => ({ ...task })),
  }));
}

function countHarnessTodoTasks(phases: HarnessTodoPhase[]): number {
  return phases.reduce((total, phase) => total + phase.tasks.length, 0);
}

function flattenHarnessTodoSummaries(phases: HarnessTodoPhase[]): Array<{ content: string; status: HarnessTodoStatus }> {
  return phases.flatMap((phase) =>
    phase.tasks.map((task) => ({
      content: task.content,
      status: task.status,
    })),
  );
}

function nextHarnessTodoIds(phases: HarnessTodoPhase[]): { nextTaskId: number; nextPhaseId: number } {
  let maxTaskId = 0;
  let maxPhaseId = 0;

  for (const phase of phases) {
    const phaseMatch = /^phase-(\d+)$/u.exec(phase.id);
    if (phaseMatch) {
      maxPhaseId = Math.max(maxPhaseId, Number.parseInt(phaseMatch[1] ?? "0", 10));
    }
    for (const task of phase.tasks) {
      const taskMatch = /^task-(\d+)$/u.exec(task.id);
      if (taskMatch) {
        maxTaskId = Math.max(maxTaskId, Number.parseInt(taskMatch[1] ?? "0", 10));
      }
    }
  }

  return { nextTaskId: maxTaskId + 1, nextPhaseId: maxPhaseId + 1 };
}

function normalizePersistedHarnessTodoItem(value: unknown, fallbackId: string): HarnessTodoItem | null {
  if (!isRecord(value)) {
    return null;
  }
  const content = firstNonEmptyString(value.content, value.text, value.task, value.title);
  if (!content) {
    return null;
  }
  const status = normalizeHarnessTodoStatus(value.status) ?? "pending";
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

function normalizePersistedHarnessTodoPhase(
  value: unknown,
  fallbackId: string,
  nextTaskId: number,
): { phase: HarnessTodoPhase | null; nextTaskId: number } {
  if (!isRecord(value)) {
    return { phase: null, nextTaskId };
  }
  const name = firstNonEmptyString(value.name, value.title);
  if (!name) {
    return { phase: null, nextTaskId };
  }
  const tasks: HarnessTodoItem[] = [];
  let localNextTaskId = nextTaskId;
  if (Array.isArray(value.tasks)) {
    for (const rawTask of value.tasks) {
      const task = normalizePersistedHarnessTodoItem(rawTask, `task-${localNextTaskId}`);
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

function normalizeLegacyHarnessTodoPhases(todos: unknown[]): HarnessTodoPhase[] {
  const tasks: HarnessTodoItem[] = [];
  let nextTaskId = 1;
  for (const rawTask of todos) {
    const task = normalizePersistedHarnessTodoItem(rawTask, `task-${nextTaskId}`);
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

function normalizeInProgressHarnessTodoTask(phases: HarnessTodoPhase[]): void {
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

export function readHarnessTodoState(stateDir: string, sessionId: string): HarnessTodoState {
  const statePath = resolveHarnessTodoStatePath(stateDir, sessionId);
  let raw: string;
  try {
    raw = fs.readFileSync(statePath, "utf8");
  } catch {
    return emptyHarnessTodoState(sessionId);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyHarnessTodoState(sessionId);
  }
  if (!isRecord(parsed)) {
    return emptyHarnessTodoState(sessionId);
  }

  const normalizedSessionId = firstNonEmptyString(parsed.session_id, sessionId) ?? sessionId;
  let phases: HarnessTodoPhase[] = [];
  let nextTaskId = 1;

  if (Array.isArray(parsed.phases)) {
    for (const rawPhase of parsed.phases) {
      const normalized = normalizePersistedHarnessTodoPhase(rawPhase, `phase-${phases.length + 1}`, nextTaskId);
      nextTaskId = normalized.nextTaskId;
      if (normalized.phase) {
        phases.push(normalized.phase);
      }
    }
  } else if (Array.isArray(parsed.todos)) {
    phases = normalizeLegacyHarnessTodoPhases(parsed.todos);
  }

  normalizeInProgressHarnessTodoTask(phases);
  const computedIds = nextHarnessTodoIds(phases);
  return {
    version:
      typeof parsed.version === "number" && Number.isFinite(parsed.version)
        ? parsed.version
        : HARNESS_TODO_STATE_VERSION,
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

export function writeHarnessTodoState(params: {
  stateDir: string;
  sessionId: string;
  phases: HarnessTodoPhase[];
}): HarnessTodoState {
  const statePath = resolveHarnessTodoStatePath(params.stateDir, params.sessionId);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const phases = cloneHarnessTodoPhases(params.phases);
  normalizeInProgressHarnessTodoTask(phases);
  const ids = nextHarnessTodoIds(phases);
  const nextState: HarnessTodoState = {
    version: HARNESS_TODO_STATE_VERSION,
    session_id: params.sessionId,
    updated_at: new Date().toISOString(),
    phases,
    next_task_id: ids.nextTaskId,
    next_phase_id: ids.nextPhaseId,
  };
  const tempPath = `${statePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, statePath);
  return nextState;
}

export function hasPersistedHarnessTodoState(stateDir: string, sessionId: string): boolean {
  return countHarnessTodoTasks(readHarnessTodoState(stateDir, sessionId).phases) > 0;
}

export function hasBlockedPersistedHarnessTodoState(stateDir: string, sessionId: string): boolean {
  return readHarnessTodoState(stateDir, sessionId).phases
    .flatMap((phase) => phase.tasks)
    .some((task) => task.status === "blocked");
}

export function shouldRequireHarnessTodoReadBeforePrompt(params: {
  hasRequestedSessionFile: boolean;
  stateDir: string;
  sessionId: string;
}): boolean {
  return Boolean(params.hasRequestedSessionFile && hasPersistedHarnessTodoState(params.stateDir, params.sessionId));
}

export function buildHarnessTodoResumeInstruction(params: {
  hasRequestedSessionFile: boolean;
  stateDir: string;
  sessionId: string;
}): string {
  if (!shouldRequireHarnessTodoReadBeforePrompt(params)) {
    return "";
  }
  return [
    "Resumed session note:",
    "A persisted phased todo plan already exists for this session.",
    "Treat the user's newest message as the primary instruction for this turn.",
    "Use `todoread` when you need the current phase/task ids before continuing or updating the persisted plan.",
    "Only restore and continue the persisted todo immediately when the user's newest message clearly asks to continue it or clearly advances the same work.",
    "If the user's newest message is conversational, brief, acknowledges prior progress, or is otherwise ambiguous about continuation, respond to that message directly first and ask whether they want to continue the unfinished work.",
    `When you use \`todowrite\`, valid \`op\` values are exactly ${HARNESS_TODO_WRITE_OPS_TEXT}.`,
    HARNESS_TODO_WRITE_ALIAS_WARNING,
    "When you do resume the plan, continue executing it until the recorded work is complete or genuinely blocked.",
    "Once the user has clearly asked you to continue an unfinished plan and executable todo items remain, do not stop only to give progress updates or ask whether to continue.",
    "If the user's newest message clearly redirects to unrelated work, handle that new request first, keep the restored todo marked unfinished, and then propose continuing it once the unrelated request is complete.",
  ].join("\n");
}

export function applyHarnessTodoResumeInstruction(
  basePrompt: string,
  params: {
    hasRequestedSessionFile: boolean;
    stateDir: string;
    sessionId: string;
  },
): string {
  return [basePrompt.trim(), buildHarnessTodoResumeInstruction(params)].filter(Boolean).join("\n\n");
}

export function blockActiveHarnessTodoTask(params: {
  stateDir: string;
  sessionId: string;
  detail: string;
}): HarnessTodoState | null {
  const currentState = readHarnessTodoState(params.stateDir, params.sessionId);
  if (countHarnessTodoTasks(currentState.phases) === 0) {
    return null;
  }
  const nextPhases = cloneHarnessTodoPhases(currentState.phases);
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
  return writeHarnessTodoState({
    stateDir: params.stateDir,
    sessionId: params.sessionId,
    phases: nextPhases,
  });
}

function parseHarnessTodoInputTask(value: unknown, fallbackId: string): HarnessTodoItem {
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
  const status = value.status === undefined ? "pending" : normalizeHarnessTodoStatus(value.status);
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

function assertHarnessTodoStatusAllowed(params: {
  status: HarnessTodoStatus;
  allowBlockedStatus: boolean;
}): void {
  if (!params.allowBlockedStatus && params.status === "blocked") {
    throw new Error(
      "Todo status `blocked` is not allowed during workflow execution.",
    );
  }
}

function buildHarnessTodoPhaseFromInput(
  value: unknown,
  phaseId: string,
  nextTaskId: number,
  allowBlockedStatus = true,
): { phase: HarnessTodoPhase; nextTaskId: number } {
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
  const tasks: HarnessTodoItem[] = [];
  let localNextTaskId = nextTaskId;
  const rawTasks = Array.isArray(value.tasks) ? value.tasks : [];
  for (const rawTask of rawTasks) {
    const task = parseHarnessTodoInputTask(rawTask, `task-${localNextTaskId}`);
    assertHarnessTodoStatusAllowed({
      status: task.status,
      allowBlockedStatus,
    });
    tasks.push(task);
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

function parseHarnessTodoWriteOps(toolParams: unknown): Array<Record<string, unknown>> {
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

function harnessTodoWriteRepairError(op: Record<string, unknown>): Error {
  const opName = firstNonEmptyString(op.op);
  const baseLines = [
    `Unsupported todo op ${opName ? `"${opName}"` : '"<missing>"'}.`,
    `Valid \`op\` values are exactly ${HARNESS_TODO_WRITE_OPS_TEXT}.`,
    HARNESS_TODO_WRITE_ALIAS_WARNING,
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

function findHarnessTodoTask(phases: HarnessTodoPhase[], id: string): HarnessTodoItem | undefined {
  for (const phase of phases) {
    const task = phase.tasks.find((entry) => entry.id === id);
    if (task) {
      return task;
    }
  }
  return undefined;
}

function applyHarnessTodoOps(
  currentState: HarnessTodoState,
  ops: Array<Record<string, unknown>>,
  options: { allowBlockedStatus?: boolean } = {},
): { phases: HarnessTodoPhase[]; nextTaskId: number; nextPhaseId: number } {
  const allowBlockedStatus = options.allowBlockedStatus ?? true;
  const nextState = {
    phases: cloneHarnessTodoPhases(currentState.phases),
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
          const built = buildHarnessTodoPhaseFromInput(
            rawPhase,
            `phase-${nextState.nextPhaseId}`,
            nextState.nextTaskId,
            allowBlockedStatus,
          );
          nextState.nextPhaseId += 1;
          nextState.nextTaskId = built.nextTaskId;
          nextState.phases.push(built.phase);
        }
        break;
      }
      case "add_phase": {
        const built = buildHarnessTodoPhaseFromInput(
          op,
          `phase-${nextState.nextPhaseId}`,
          nextState.nextTaskId,
          allowBlockedStatus,
        );
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
        const task = parseHarnessTodoInputTask(op, `task-${nextState.nextTaskId}`);
        assertHarnessTodoStatusAllowed({
          status: task.status,
          allowBlockedStatus,
        });
        phase.tasks.push(task);
        nextState.nextTaskId += 1;
        break;
      }
      case "update": {
        const taskId = firstNonEmptyString(op.id);
        if (!taskId) {
          throw new Error("Todo update requires an `id`.");
        }
        const task = findHarnessTodoTask(nextState.phases, taskId);
        if (!task) {
          throw new Error(`Todo task "${taskId}" was not found.`);
        }
        if (op.status !== undefined) {
          const status = normalizeHarnessTodoStatus(op.status);
          if (!status) {
            throw new Error(`Unsupported todo status: ${String(op.status)}`);
          }
          assertHarnessTodoStatusAllowed({
            status,
            allowBlockedStatus,
          });
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
        throw harnessTodoWriteRepairError(op);
    }
    normalizeInProgressHarnessTodoTask(nextState.phases);
  }

  return nextState;
}

function currentHarnessTodoPhaseIndex(phases: HarnessTodoPhase[]): number {
  const currentIndex = phases.findIndex((phase) =>
    phase.tasks.some(
      (task) => task.status === "pending" || task.status === "in_progress" || task.status === "blocked",
    ),
  );
  if (currentIndex !== -1) {
    return currentIndex;
  }
  return phases.length === 0 ? -1 : phases.length - 1;
}

function formatHarnessTodoMarker(status: HarnessTodoStatus): string {
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

function formatHarnessTodoListText(phases: HarnessTodoPhase[]): string {
  const taskCount = countHarnessTodoTasks(phases);
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
      lines.push(`  ${formatHarnessTodoMarker(task.status)} ${task.id} ${task.content}`);
      if ((task.status === "in_progress" || task.status === "blocked") && task.details) {
        for (const detailLine of task.details.split("\n")) {
          lines.push(`      ${detailLine}`);
        }
      }
    }
  }
  return lines.join("\n");
}

function formatHarnessTodoWriteText(nextState: HarnessTodoState): string {
  const taskCount = countHarnessTodoTasks(nextState.phases);
  if (taskCount === 0) {
    return "Todo plan cleared.";
  }

  const incomplete = nextState.phases.flatMap((phase) =>
    phase.tasks
      .filter((task) => task.status === "pending" || task.status === "in_progress" || task.status === "blocked")
      .map((task) => ({ ...task, phaseName: phase.name })),
  );
  const currentPhaseIndex = currentHarnessTodoPhaseIndex(nextState.phases);
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
  lines.push(formatHarnessTodoListText(nextState.phases));
  return lines.join("\n");
}

function todoReadParametersSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {},
    additionalProperties: false,
  };
}

function todoWriteParametersSchema(): Record<string, unknown> {
  return {
    type: "object",
    description:
      `Update the session todo plan with explicit mutations. Valid \`op\` values are exactly ${HARNESS_TODO_WRITE_OPS_TEXT}. ${HARNESS_TODO_WRITE_ALIAS_WARNING}`,
    properties: {
      ops: {
        type: "array",
        description:
          `Incremental phased todo operations over the current session plan. Valid \`op\` values are exactly ${HARNESS_TODO_WRITE_OPS_TEXT}. Use \`name\` for phase titles and \`content\` for task text.`,
        items: {
          anyOf: [
            {
              type: "object",
              description:
                "Replace the entire phased plan. Use this to create the initial plan or rewrite the whole plan, not for a single task status change.",
              properties: {
                op: {
                  const: "replace",
                  description: "Replace the entire phased plan.",
                },
                phases: {
                  type: "array",
                  description: "Full replacement list of phases. Each phase requires `name`; each task requires `content`.",
                  items: {
                    type: "object",
                    description: "Phase object for a full-plan replacement. Use `name`, not `title`.",
                    properties: {
                      name: {
                        type: "string",
                        description: "Human-readable phase title.",
                      },
                      tasks: {
                        type: "array",
                        description: "Task objects for this phase. Use `content`, not `title`.",
                        items: {
                          type: "object",
                          description: "Task object. Use `content` as the task text.",
                          properties: {
                            content: {
                              type: "string",
                              description: "Required task text.",
                            },
                            status: {
                              type: "string",
                              enum: [...HARNESS_TODO_STATUSES],
                              description: "Optional task status.",
                            },
                            notes: {
                              type: "string",
                              description: "Short note for the task.",
                            },
                            details: {
                              type: "string",
                              description: "Longer supporting detail for the task.",
                            },
                          },
                          required: ["content"],
                          additionalProperties: false,
                        },
                      },
                    },
                    required: ["name"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["op", "phases"],
              additionalProperties: false,
            },
            {
              type: "object",
              description: "Append a new phase to the current plan.",
              properties: {
                op: {
                  const: "add_phase",
                  description: "Append a new phase to the current plan.",
                },
                name: {
                  type: "string",
                  description: "Human-readable phase title.",
                },
                tasks: {
                  type: "array",
                  description: "Optional initial tasks for the new phase.",
                  items: {
                    type: "object",
                    description: "Task object. Use `content` as the task text.",
                    properties: {
                      content: {
                        type: "string",
                        description: "Required task text.",
                      },
                      status: {
                        type: "string",
                        enum: [...HARNESS_TODO_STATUSES],
                        description: "Optional task status.",
                      },
                      notes: {
                        type: "string",
                        description: "Short note for the task.",
                      },
                      details: {
                        type: "string",
                        description: "Longer supporting detail for the task.",
                      },
                    },
                    required: ["content"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["op", "name"],
              additionalProperties: false,
            },
            {
              type: "object",
              description: "Append a new task to an existing phase by phase id.",
              properties: {
                op: {
                  const: "add_task",
                  description: "Append a new task to an existing phase by phase id.",
                },
                phase: {
                  type: "string",
                  description: "Existing phase id from `todoread` or a prior `todowrite` result, for example `phase-2`.",
                },
                content: {
                  type: "string",
                  description: "Required task text.",
                },
                status: {
                  type: "string",
                  enum: [...HARNESS_TODO_STATUSES],
                  description: "Optional task status.",
                },
                notes: {
                  type: "string",
                  description: "Short note for the task.",
                },
                details: {
                  type: "string",
                  description: "Longer supporting detail for the task.",
                },
              },
              required: ["op", "phase", "content"],
              additionalProperties: false,
            },
            {
              type: "object",
              description:
                "Update an existing task by task id. Use this for status changes, content edits, notes, or details.",
              properties: {
                op: {
                  const: "update",
                  description: "Update an existing task by task id. Use this for status changes.",
                },
                id: {
                  type: "string",
                  description: "Existing task id from `todoread` or a prior `todowrite` result, for example `task-3`.",
                },
                status: {
                  type: "string",
                  enum: [...HARNESS_TODO_STATUSES],
                  description: "New task status when changing status.",
                },
                content: {
                  type: "string",
                  description: "Replacement task text.",
                },
                notes: {
                  type: "string",
                  description: "Replacement short note for the task.",
                },
                details: {
                  type: "string",
                  description: "Replacement longer supporting detail for the task.",
                },
              },
              required: ["op", "id"],
              additionalProperties: false,
            },
            {
              type: "object",
              description: "Remove a single task by task id.",
              properties: {
                op: {
                  const: "remove_task",
                  description: "Remove a single task by task id.",
                },
                id: {
                  type: "string",
                  description: "Existing task id from `todoread` or a prior `todowrite` result.",
                },
              },
              required: ["op", "id"],
              additionalProperties: false,
            },
            {
              type: "object",
              description:
                "Fallback validation branch for malformed todo ops so the tool can return a repair hint. Do not rely on this shape.",
              properties: {
                op: { type: "string" },
                id: { type: "string" },
                phase: { type: "string" },
                name: { type: "string" },
                title: { type: "string" },
                content: { type: "string" },
                status: { type: "string" },
                notes: { type: "string" },
                details: { type: "string" },
                phases: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      name: { type: "string" },
                      title: { type: "string" },
                      tasks: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            content: { type: "string" },
                            title: { type: "string" },
                            status: { type: "string" },
                            notes: { type: "string" },
                            details: { type: "string" },
                          },
                          additionalProperties: false,
                        },
                      },
                    },
                    additionalProperties: false,
                  },
                },
              },
              required: ["op"],
              additionalProperties: false,
            },
          ],
        },
      },
    },
    required: ["ops"],
    additionalProperties: false,
  };
}

export function createHarnessTodoToolDefinitions(params: {
  stateDir: string;
  sessionId: string;
  allowBlockedStatus?: boolean;
}): HarnessToolDefinitionLike[] {
  const readDefinition: HarnessToolDefinitionLike = {
    name: "todoread",
    label: "Todo Read",
    description:
      "Read the current phased todo plan for this session, including the phase ids and task ids needed for later `todowrite` calls.",
    parameters: todoReadParametersSchema(),
    promptSnippet:
      "todoread: Read the current phased todo plan for this session and recover the phase/task ids needed for later `todowrite` mutations.",
    promptGuidelines: [
      "Use todoread before changing an existing phased plan when current todo state may matter.",
      "When resuming a session that already has todo state, call todoread before continuing that plan if you need the current phase/task ids.",
      "Use todoread to recover the exact phase ids and task ids before calling `update`, `add_task`, or `remove_task` on an existing plan.",
      "Treat the user's newest message as the primary instruction for the current turn.",
      "If the user's newest message clearly asks to continue the unfinished plan or clearly advances it, resume the plan after reading it.",
      "If the user's newest message is conversational, brief, acknowledges prior progress, or is otherwise ambiguous about continuation, respond first and ask whether they want to continue before resuming the unfinished plan.",
      "After reading an existing todo that the user has clearly asked you to continue, keep executing it until the recorded work is complete or genuinely blocked.",
      "Once the user has clearly asked you to continue an unfinished plan, do not stop only to give progress updates or ask whether to continue while executable todo items remain.",
      "If the user's newest message is clearly unrelated to the unfinished todo, preserve that todo as unfinished, handle the new request first, and then propose continuing the unfinished work.",
    ],
    execute: async (_toolCallId, _toolParams, signal) => {
      if (signal?.aborted) {
        throw new Error("Todo Read aborted before execution");
      }
      const state = readHarnessTodoState(params.stateDir, params.sessionId);
      const todoCount = countHarnessTodoTasks(state.phases);
      return {
        content: [{ type: "text", text: formatHarnessTodoListText(state.phases) }],
        details: {
          invocation_type: "todo_read",
          session_id: state.session_id,
          updated_at: state.updated_at,
          phase_count: state.phases.length,
          task_count: todoCount,
          todo_count: todoCount,
          phases: state.phases,
          todos: flattenHarnessTodoSummaries(state.phases),
        },
      };
    },
  };

  const writeDefinition: HarnessToolDefinitionLike = {
    name: "todowrite",
    label: "Todo Write",
    description:
      `Update the current phased todo plan for this session. Valid \`op\` values are exactly ${HARNESS_TODO_WRITE_OPS_TEXT}.`,
    parameters: todoWriteParametersSchema(),
    promptSnippet:
      `todowrite: Update the current phased todo plan for this session using only these \`op\` values: ${HARNESS_TODO_WRITE_OPS_TEXT}.`,
    promptGuidelines: [
      "Use todowrite for complex or long-running tasks that benefit from an explicit phased plan.",
      "The top-level phases are grouped tasks, and each phase's `tasks` entries are the actionable task items within that grouped task.",
      "Treat the user's newest message as the primary instruction for the current turn even when an unfinished todo already exists.",
      "When the user has clearly asked you to continue an unfinished todo, keep executing it until the recorded work is complete or genuinely blocked.",
      "If the user's newest message is conversational, brief, acknowledges prior progress, or is otherwise ambiguous about continuation, respond directly and ask whether they want to continue instead of auto-resuming the unfinished todo.",
      "Once the user has clearly asked you to continue an unfinished todo, do not stop only to give progress updates or ask whether to continue while executable todo items remain.",
      "If a new user message clearly redirects to unrelated work, do that work first without marking the existing unfinished todo complete, then propose resuming the unfinished work afterward.",
      `Valid \`op\` values are exactly ${HARNESS_TODO_WRITE_OPS_TEXT}.`,
      HARNESS_TODO_WRITE_ALIAS_WARNING,
      "Use `replace` only for the initial plan or a full rewrite of the entire plan, not for a single task status change.",
      "Use `update` to change an existing task's status, content, notes, or details by task id.",
      "Use `add_phase` to append a new phase, `add_task` to append a task to an existing phase by phase id, and `remove_task` to delete a task by task id.",
      "Use `name` for phase titles and `content` for task text; do not use `title` for either.",
      "On an existing plan, call `todoread` first so you have the current phase ids and task ids before writing mutations.",
      "Keep exactly one task `in_progress` whenever unfinished tasks remain unless the current task is blocked on user input or another external dependency.",
      ...(params.allowBlockedStatus === false
        ? [
            "During workflow execution, do not set todo task status to `blocked`; workflow-owned runs must fail instead of pausing on user input.",
          ]
        : []),
    ],
    execute: async (_toolCallId, toolParams, signal) => {
      if (signal?.aborted) {
        throw new Error("Todo Write aborted before execution");
      }
      const previousState = readHarnessTodoState(params.stateDir, params.sessionId);
      const ops = parseHarnessTodoWriteOps(toolParams);
      const nextPlan = applyHarnessTodoOps(previousState, ops, {
        allowBlockedStatus: params.allowBlockedStatus,
      });
      const nextState = writeHarnessTodoState({
        stateDir: params.stateDir,
        sessionId: params.sessionId,
        phases: nextPlan.phases,
      });
      const previousTodoCount = countHarnessTodoTasks(previousState.phases);
      const nextTodoCount = countHarnessTodoTasks(nextState.phases);
      return {
        content: [{ type: "text", text: formatHarnessTodoWriteText(nextState) }],
        details: {
          invocation_type: "todo_write",
          session_id: nextState.session_id,
          updated_at: nextState.updated_at,
          previous_phase_count: previousState.phases.length,
          phase_count: nextState.phases.length,
          previous_task_count: previousTodoCount,
          task_count: nextTodoCount,
          previous_todo_count: previousTodoCount,
          todo_count: nextTodoCount,
          phases: nextState.phases,
          todos: flattenHarnessTodoSummaries(nextState.phases),
        },
      };
    },
  };

  return [readDefinition, writeDefinition];
}
