import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { CronExpressionParser } from "cron-parser";

import {
  type CronjobRecord,
  type RuntimeNotificationLevel,
  type RuntimeNotificationPriority,
  type RuntimeStateStore,
  utcNowIso,
  type WorkspaceRecord
} from "@holaboss/runtime-state-store";

import type { QueueWorkerLike } from "./queue-worker.js";
import { normalizeSubagentToolProfile } from "./runtime-agent-tools.js";
import { resolveSubagentExecutionModel } from "./subagent-model.js";

const DEFAULT_POLL_INTERVAL_MS = 60_000;

type LoggerLike = {
  info: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function titleCaseWords(value: string): string {
  return value.replace(/\b([a-z])/g, (match) => match.toUpperCase());
}

function cronjobNotificationTitle(job: CronjobRecord, metadata: Record<string, unknown>): string {
  const explicitTitle = normalizedString(metadata.notification_title);
  if (explicitTitle) {
    return explicitTitle;
  }
  const name = normalizedString(job.name);
  if (name) {
    return titleCaseWords(name.replace(/[_-]+/g, " ").replace(/\s+/g, " "));
  }
  return "Reminder";
}

function cronjobNotificationMessage(job: CronjobRecord, metadata: Record<string, unknown>): string {
  const explicitMessage = normalizedString(metadata.notification_message);
  if (explicitMessage) {
    return explicitMessage;
  }
  return normalizedString(job.description) || cronjobNotificationTitle(job, metadata);
}

function cronjobNotificationLevel(metadata: Record<string, unknown>): RuntimeNotificationLevel {
  const explicitLevel = normalizedString(metadata.notification_level || metadata.level).toLowerCase();
  if (explicitLevel === "success" || explicitLevel === "warning" || explicitLevel === "error") {
    return explicitLevel;
  }
  return "info";
}

function cronjobNotificationPriority(metadata: Record<string, unknown>): RuntimeNotificationPriority {
  const explicitPriority = normalizedString(metadata.notification_priority).toLowerCase();
  if (explicitPriority === "low" || explicitPriority === "high" || explicitPriority === "critical") {
    return explicitPriority;
  }
  return "normal";
}

function isCronjobMainSessionKind(value: string | null | undefined): boolean {
  const normalized = normalizedString(value).toLowerCase();
  return (
    normalized === "" ||
    normalized === "workspace_session" ||
    normalized === "main" ||
    normalized === "onboarding"
  );
}

function preferredCronjobMainSessionId(params: {
  store: RuntimeStateStore;
  workspace: WorkspaceRecord;
  metadata: Record<string, unknown>;
}): string | null {
  const preferredIds = [
    normalizedString(params.metadata.source_session_id),
    normalizedString(params.metadata.session_id),
  ].filter(Boolean);
  for (const sessionId of preferredIds) {
    const session = params.store.getSession({
      workspaceId: params.workspace.id,
      sessionId,
    });
    if (session && isCronjobMainSessionKind(session.kind)) {
      return session.sessionId;
    }
  }

  const desktopBinding = params.store.getConversationBindingByConversation({
    workspaceId: params.workspace.id,
    channel: "desktop",
    conversationKey: "workspace-main",
    role: "main",
  });
  if (desktopBinding) {
    return desktopBinding.sessionId;
  }

  const onboardingSessionId = normalizedString(params.workspace.onboardingSessionId);
  const sessions = params.store.listSessions({
    workspaceId: params.workspace.id,
    includeArchived: false,
    limit: 200,
    offset: 0,
  });
  const preferred = sessions.find((session) => {
    if (session.sessionId === onboardingSessionId) {
      return false;
    }
    return isCronjobMainSessionKind(session.kind);
  });
  if (preferred) {
    return preferred.sessionId;
  }
  return (
    sessions.find(
      (session) =>
        session.sessionId !== onboardingSessionId &&
        isCronjobMainSessionKind(session.kind),
    )?.sessionId ?? null
  );
}

function resolveCronjobMainSession(params: {
  store: RuntimeStateStore;
  workspace: WorkspaceRecord;
  metadata: Record<string, unknown>;
}): string {
  const existing = preferredCronjobMainSessionId(params);
  if (existing) {
    params.store.upsertConversationBinding({
      workspaceId: params.workspace.id,
      channel: "desktop",
      conversationKey: "workspace-main",
      sessionId: existing,
      role: "main",
      isActive: true,
      metadata: {},
      lastActiveAt: utcNowIso(),
    });
    return existing;
  }

  const sessionId = `main-${randomUUID()}`;
  params.store.ensureSession({
    workspaceId: params.workspace.id,
    sessionId,
    kind: "workspace_session",
    title: params.workspace.name.trim() || "Main Session",
    createdBy: "cronjob",
  });
  params.store.upsertConversationBinding({
    workspaceId: params.workspace.id,
    channel: "desktop",
    conversationKey: "workspace-main",
    sessionId,
    role: "main",
    isActive: true,
    metadata: {},
    lastActiveAt: utcNowIso(),
  });
  return sessionId;
}

function resolvedCronjobModel(params: {
  store: RuntimeStateStore;
  workspace: WorkspaceRecord;
  metadata: Record<string, unknown>;
  sessionId?: string | null;
}): string | null {
  void params;
  return resolveSubagentExecutionModel();
}

export function cronjobCheckIntervalMs(): number {
  const raw = (process.env.CRONJOB_RUNNER_CHECK_INTERVAL_SECONDS ?? "").trim();
  const parsed = Number.parseInt(raw || "60", 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  return Math.max(5, parsed) * 1000;
}

export function cronjobNextRunAt(cronExpression: string, now: Date): string | null {
  try {
    const interval = CronExpressionParser.parse(cronExpression, { currentDate: now });
    return interval.next().toISOString();
  } catch {
    return null;
  }
}

export function cronjobIsDue(job: CronjobRecord, now: Date): boolean {
  if (!job.enabled) {
    return false;
  }
  const nextRunAtRaw = normalizedString(job.nextRunAt);
  if (nextRunAtRaw) {
    const nextRunAt = new Date(nextRunAtRaw);
    if (!Number.isNaN(nextRunAt.getTime())) {
      return now >= nextRunAt;
    }
  }
  let lastScheduled: Date;
  try {
    lastScheduled = CronExpressionParser.parse(job.cron, { currentDate: now }).prev().toDate();
  } catch {
    return false;
  }
  if (!job.lastRunAt) {
    return true;
  }
  const lastRunAt = new Date(job.lastRunAt);
  if (Number.isNaN(lastRunAt.getTime())) {
    return true;
  }
  return lastRunAt < lastScheduled;
}

export function cronjobInstruction(description: string, metadata: Record<string, unknown>): string {
  const cleanedDescription = description.trim();
  const executionMetadata = Object.fromEntries(
    Object.entries(metadata ?? {}).filter(
      ([key]) =>
        ![
          "model",
          "session_id",
          "source_session_id",
          "priority",
          "idempotency_key"
        ].includes(key)
    )
  );
  if (Object.keys(executionMetadata).length === 0) {
    return cleanedDescription;
  }
  return `${cleanedDescription}\n\n[Cronjob Metadata]\n${JSON.stringify(executionMetadata)}`;
}

export function queueLocalCronjobRun(
  store: RuntimeStateStore,
  job: CronjobRecord,
  now: Date,
  wakeQueueWorker: (() => void) | undefined
): string {
  const workspace = store.getWorkspace(job.workspaceId);
  if (!workspace) {
    throw new Error(`workspace not found for cronjob ${job.id}`);
  }
  const metadata = isRecord(job.metadata) ? job.metadata : {};
  const mainSessionId = resolveCronjobMainSession({ store, workspace, metadata });
  const childSessionId = `subagent-${randomUUID()}`;
  const subagentId = randomUUID();
  const model = resolvedCronjobModel({
    store,
    workspace,
    metadata,
    sessionId: mainSessionId,
  });
  const priority = Number.isInteger(metadata.priority) ? (metadata.priority as number) : 0;
  const idempotencyKey = typeof metadata.idempotency_key === "string" ? metadata.idempotency_key : null;
  const executableInstruction = cronjobInstruction(job.instruction, metadata);
  const subagentTitle =
    normalizedString(job.name) ||
    normalizedString(job.description) ||
    "Scheduled task";
  const toolProfile = normalizeSubagentToolProfile({
    tools: ["terminal", "file", "browser", "web"],
  });

  store.ensureSession({
    workspaceId: job.workspaceId,
    sessionId: childSessionId,
    kind: "subagent",
    title: subagentTitle,
    parentSessionId: mainSessionId,
    createdBy: job.initiatedBy
  });
  if (!store.getBinding({ workspaceId: job.workspaceId, sessionId: childSessionId })) {
    const harness = (workspace.harness ?? process.env.SANDBOX_AGENT_HARNESS ?? "pi").trim() || "pi";
    store.upsertBinding({
      workspaceId: job.workspaceId,
      sessionId: childSessionId,
      harness,
      harnessSessionId: childSessionId
    });
  }

  store.ensureRuntimeState({
    workspaceId: job.workspaceId,
    sessionId: childSessionId,
    status: "QUEUED"
  });

  const record = store.enqueueInput({
    workspaceId: job.workspaceId,
    sessionId: childSessionId,
    priority,
    idempotencyKey,
    payload: {
      text: executableInstruction,
      image_urls: [],
      model,
      context: {
        source: "subagent",
        source_type: "cronjob",
        cronjob_id: job.id,
        subagent_id: subagentId,
        origin_main_session_id: mainSessionId,
        owner_main_session_id: mainSessionId,
        parent_session_id: mainSessionId,
        parent_input_id: null,
        task_title: subagentTitle,
        tool_profile: toolProfile,
        goal:
          normalizedString(job.description) ||
          normalizedString(job.instruction) ||
          subagentTitle,
      }
    }
  });
  store.createSubagentRun({
    subagentId,
    workspaceId: job.workspaceId,
    parentSessionId: mainSessionId,
    parentInputId: null,
    originMainSessionId: mainSessionId,
    ownerMainSessionId: mainSessionId,
    childSessionId,
    initialChildInputId: record.inputId,
    currentChildInputId: record.inputId,
    latestChildInputId: record.inputId,
    title: subagentTitle,
    goal:
      normalizedString(job.description) ||
      normalizedString(job.instruction) ||
      subagentTitle,
    context: normalizedString(job.instruction) || null,
    sourceType: "cronjob",
    sourceId: job.id,
    cronjobId: job.id,
    toolProfile,
    requestedModel: typeof metadata.model === "string" ? metadata.model : null,
    effectiveModel: model,
    status: "queued",
    lastEventAt: now.toISOString(),
  });

  store.updateRuntimeState({
    workspaceId: job.workspaceId,
    sessionId: childSessionId,
    status: "QUEUED",
    currentInputId: record.inputId,
    currentWorkerId: null,
    leaseUntil: null,
    heartbeatAt: now.toISOString(),
    lastError: null
  });

  wakeQueueWorker?.();
  return mainSessionId;
}

export function deliverLocalCronjobNotification(
  store: RuntimeStateStore,
  job: CronjobRecord,
  options?: { sessionId?: string | null },
): { id: string } {
  const workspace = store.getWorkspace(job.workspaceId);
  if (!workspace) {
    throw new Error(`workspace not found for cronjob ${job.id}`);
  }

  const metadata = isRecord(job.metadata) ? job.metadata : {};
  const sessionId =
    (typeof options?.sessionId === "string" && options.sessionId.trim()
      ? options.sessionId.trim()
      : null) ??
    resolveCronjobMainSession({ store, workspace, metadata });
  const notification = store.createRuntimeNotification({
    workspaceId: job.workspaceId,
    cronjobId: job.id,
    sourceType: "cronjob",
    sourceLabel: workspace.name.trim() || null,
    title: cronjobNotificationTitle(job, metadata),
    message: cronjobNotificationMessage(job, metadata),
    level: cronjobNotificationLevel(metadata),
    priority: cronjobNotificationPriority(metadata),
    metadata: {
      cronjob_id: job.id,
      cronjob_name: job.name,
      cronjob_description: job.description,
      cronjob_instruction: job.instruction,
      session_id:
        sessionId,
      delivery: job.delivery,
      cronjob_metadata: metadata
    }
  });
  return { id: notification.id };
}

export interface LocalCronjobDeliveryResult {
  channel: string | null;
  sessionId: string | null;
  notificationId: string | null;
}

export function executeLocalCronjobDelivery(
  store: RuntimeStateStore,
  job: CronjobRecord,
  now: Date,
  wakeQueueWorker: (() => void) | undefined,
): LocalCronjobDeliveryResult {
  const delivery = isRecord(job.delivery) ? job.delivery : {};
  const channel = typeof delivery.channel === "string" ? delivery.channel : null;
  if (channel === "session_run") {
    const sessionId = queueLocalCronjobRun(store, job, now, wakeQueueWorker);
    return {
      channel,
      sessionId,
      notificationId: null,
    };
  }
  if (channel === "system_notification") {
    const notification = deliverLocalCronjobNotification(store, job);
    return {
      channel,
      sessionId: null,
      notificationId: notification.id,
    };
  }
  throw new Error(`unsupported cronjob delivery channel: ${channel}`);
}

export interface CronWorkerLike {
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeCronWorkerOptions {
  store: RuntimeStateStore;
  logger?: LoggerLike;
  queueWorker?: QueueWorkerLike | null;
  pollIntervalMs?: number;
}

export class RuntimeCronWorker implements CronWorkerLike {
  readonly #store: RuntimeStateStore;
  readonly #logger: LoggerLike | undefined;
  readonly #queueWorker: QueueWorkerLike | null;
  readonly #pollIntervalMs: number;
  #stopped = false;
  #task: Promise<void> | null = null;
  #wakeResolver: (() => void) | null = null;

  constructor(options: RuntimeCronWorkerOptions) {
    this.#store = options.store;
    this.#logger = options.logger;
    this.#queueWorker = options.queueWorker ?? null;
    this.#pollIntervalMs = options.pollIntervalMs ?? cronjobCheckIntervalMs();
  }

  async start(): Promise<void> {
    if (this.#task) {
      return;
    }
    this.#stopped = false;
    this.#task = this.#runLoop();
  }

  async close(): Promise<void> {
    this.#stopped = true;
    const resolve = this.#wakeResolver;
    this.#wakeResolver = null;
    resolve?.();
    const task = this.#task;
    this.#task = null;
    await task;
  }

  async processDueCronjobsOnce(now = new Date()): Promise<number> {
    let processed = 0;
    for (const job of this.#store.listCronjobs({ enabledOnly: true })) {
      if (!cronjobIsDue(job, now)) {
        continue;
      }
      processed += 1;
      let status = "success";
      let error: string | null = null;
      try {
        const result = executeLocalCronjobDelivery(
          this.#store,
          job,
          now,
          () => this.#queueWorker?.wake(),
        );
        if (result.channel === "system_notification") {
          this.#logger?.info?.("Cronjob notification delivered", {
            event: "cronjob.delivery.system_notification",
            outcome: "success",
            cronjob_id: job.id,
            workspace_id: job.workspaceId
          });
        }
      } catch (caught) {
        status = "failed";
        error = caught instanceof Error ? caught.message : String(caught);
        this.#logger?.error?.("Cronjob execution failed", {
          event: "cronjob.execution",
          outcome: "error",
          cronjob_id: job.id,
          workspace_id: job.workspaceId,
          error
        });
      }

      this.#store.updateCronjob({
        workspaceId: job.workspaceId,
        jobId: job.id,
        lastRunAt: now.toISOString(),
        nextRunAt: cronjobNextRunAt(job.cron, now),
        runCount: job.runCount + (status === "success" ? 1 : 0),
        lastStatus: status,
        lastError: error
      });
    }
    return processed;
  }

  async #runLoop(): Promise<void> {
    while (!this.#stopped) {
      await this.processDueCronjobsOnce();
      if (this.#stopped) {
        return;
      }
      await Promise.race([
        sleep(this.#pollIntervalMs),
        new Promise<void>((resolve) => {
          this.#wakeResolver = resolve;
        })
      ]);
      this.#wakeResolver = null;
    }
  }
}
