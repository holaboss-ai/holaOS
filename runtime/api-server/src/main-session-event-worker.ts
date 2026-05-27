import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import {
  type ConversationBindingRecord,
  type MainSessionEventQueueRecord,
  type RuntimeStateStore,
  type WorkspaceRecord,
  utcNowIso,
} from "@holaboss/runtime-state-store";

import type { QueueWorkerLike } from "./queue-worker.js";
import { queuedMainSessionEventPromptEntry } from "./main-session-event-prompt.js";
import {
  isCoordinatorSessionKind,
  normalizedCoordinatorSessionKind,
  preferredCoordinatorSessionId,
} from "./coordinator-session-routing.js";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAIN_SESSION_EVENT_INPUT_PRIORITY = -100;
const MAIN_SESSION_EVENT_BATCH_HEADER =
  "[Holaboss Main Session Event Batch v1]";

type LoggerLike = {
  info: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
};

export interface MainSessionEventWorkerLike {
  start(): Promise<void>;
  wake(): void;
  close(): Promise<void>;
}

export interface RuntimeMainSessionEventWorkerOptions {
  store: RuntimeStateStore;
  queueWorker?: QueueWorkerLike | null;
  logger?: LoggerLike;
  pollIntervalMs?: number;
  initialDelayMs?: number;
}

const DEFAULT_INITIAL_DELAY_MS = 1_000;

function groupedEventPayload(events: MainSessionEventQueueRecord[]) {
  return events.map((event) => queuedMainSessionEventPromptEntry(event));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function integerOrZero(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function appendSubagentLifecycleOutputEvents(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sessionId: string;
  inputId: string;
  batch: MainSessionEventQueueRecord[];
  createdAt: string;
}): void {
  let sequence = params.store.latestOutputEventId({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    inputId: params.inputId,
  });
  for (const event of params.batch) {
    const payload = isRecord(event.payload) ? event.payload : {};
    sequence += 1;
    params.store.appendOutputEvent({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      inputId: params.inputId,
      sequence,
      eventType: "subagent_lifecycle_update",
      payload: {
        event_id: event.eventId,
        event_type: event.eventType,
        delivery_bucket: event.deliveryBucket,
        status: event.status,
        subagent_id: event.subagentId,
        subagent_payload: payload,
      },
      createdAt: params.createdAt,
    });
  }
}

function mainSessionEventBatchIdempotencyKey(
  events: MainSessionEventQueueRecord[],
): string {
  return `main-session-event-batch:${events
    .map((event) => `${event.eventId}@${event.updatedAt}`)
    .join(",")}`;
}

function ownerMainSessionDeliveryConfig(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sessionId: string;
  fallbackSessionId?: string | null;
}): { model: string | null; thinkingValue: string | null } {
  const readConfig = (sessionId: string | null | undefined) => {
    if (!sessionId) {
      return { model: null, thinkingValue: null };
    }
    const latestInput = params.store.getLatestInputForSession({
      workspaceId: params.workspaceId,
      sessionId,
      excludeContextSources: ["main_session_event_batch"],
      preferConfiguredModel: true,
    });
    return {
      model: optionalTrimmedString(latestInput?.payload.model),
      thinkingValue: optionalTrimmedString(latestInput?.payload.thinking_value),
    };
  };

  const primary = readConfig(params.sessionId);
  if (
    primary.model ||
    primary.thinkingValue ||
    !params.fallbackSessionId ||
    params.fallbackSessionId === params.sessionId
  ) {
    return primary;
  }
  const fallback = readConfig(params.fallbackSessionId);
  return {
    model: primary.model ?? fallback.model,
    thinkingValue: primary.thinkingValue ?? fallback.thinkingValue,
  };
}

function mainSessionEventDeliveryRetryPayload(
  event: MainSessionEventQueueRecord,
): Record<string, unknown> | null {
  const payload = isRecord(event.payload) ? event.payload : null;
  const retry = payload && isRecord(payload.delivery_retry)
    ? payload.delivery_retry
    : null;
  return retry;
}

function mainSessionEventLastStopReason(
  event: MainSessionEventQueueRecord,
): string | null {
  return optionalTrimmedString(
    mainSessionEventDeliveryRetryPayload(event)?.last_stop_reason,
  )?.toLowerCase() ?? null;
}

function mainSessionEventSessionResetRecoveryCount(
  event: MainSessionEventQueueRecord,
): number {
  return integerOrZero(
    mainSessionEventDeliveryRetryPayload(event)?.session_reset_recovery_count,
  );
}

function shouldRotateCoordinatorForSessionReset(
  event: MainSessionEventQueueRecord,
): boolean {
  return (
    mainSessionEventLastStopReason(event) === "session_reset_required" &&
    mainSessionEventSessionResetRecoveryCount(event) < 1
  );
}

function coordinatorResetSessionIdPrefix(
  kind: string | null | undefined,
): string {
  switch (normalizedCoordinatorSessionKind(kind)) {
    case "workspace_onboarding":
      return "workspace_onboarding";
    case "meeting_mode":
      return "meeting_mode";
    default:
      return "main";
  }
}

function rebindingTargetsForSession(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sessionId: string;
}): ConversationBindingRecord[] {
  return params.store
    .listConversationBindings({
      workspaceId: params.workspaceId,
      limit: 1000,
      offset: 0,
    })
    .filter(
      (binding) => binding.sessionId === params.sessionId && binding.isActive,
    );
}

function rotatedCoordinatorEvents(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  eventIds: string[];
  recoverySessionId: string;
}): MainSessionEventQueueRecord[] {
  return params.eventIds
    .map((eventId) =>
      params.store.getMainSessionEvent({
        workspaceId: params.workspaceId,
        eventId,
      }),
    )
    .filter((event): event is MainSessionEventQueueRecord => event !== null)
    .filter(
      (event) =>
        event.status === "pending" &&
        !event.deliveredAt &&
        !event.supersededAt &&
        event.ownerMainSessionId === params.recoverySessionId,
    )
    .sort((left, right) => {
      const leftTime = Date.parse(left.createdAt);
      const rightTime = Date.parse(right.createdAt);
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return left.eventId.localeCompare(right.eventId);
    });
}

function rotateCoordinatorSessionForReset(params: {
  store: RuntimeStateStore;
  workspace: WorkspaceRecord;
  ownerMainSessionId: string;
  events: MainSessionEventQueueRecord[];
}): {
  recoverySessionId: string;
  previousSessionId: string;
  events: MainSessionEventQueueRecord[];
} | null {
  if (!params.events.some(shouldRotateCoordinatorForSessionReset)) {
    return null;
  }
  const currentSession = params.store.getSession({
    workspaceId: params.workspace.id,
    sessionId: params.ownerMainSessionId,
  });
  const currentKind = normalizedCoordinatorSessionKind(currentSession?.kind);
  const recoverySessionId = `${coordinatorResetSessionIdPrefix(currentKind)}-${randomUUID()}`;
  const recoveryTitle =
    optionalTrimmedString(currentSession?.title) ??
    optionalTrimmedString(params.workspace.name) ??
    "Main Session";
  params.store.ensureSession({
    workspaceId: params.workspace.id,
    sessionId: recoverySessionId,
    kind: currentKind,
    title: recoveryTitle,
    parentSessionId: params.ownerMainSessionId,
    createdBy: "system",
  });
  const currentBinding = params.store.getBinding({
    workspaceId: params.workspace.id,
    sessionId: params.ownerMainSessionId,
  });
  params.store.upsertBinding({
    workspaceId: params.workspace.id,
    sessionId: recoverySessionId,
    harness: currentBinding?.harness ?? params.workspace.harness ?? "pi",
    harnessSessionId: recoverySessionId,
  });
  params.store.ensureRuntimeState({
    workspaceId: params.workspace.id,
    sessionId: recoverySessionId,
    status: "IDLE",
  });

  const rebindingTargets = rebindingTargetsForSession({
    store: params.store,
    workspaceId: params.workspace.id,
    sessionId: params.ownerMainSessionId,
  });
  for (const binding of rebindingTargets) {
    params.store.upsertConversationBinding({
      bindingId: binding.bindingId,
      workspaceId: binding.workspaceId,
      channel: binding.channel,
      conversationKey: binding.conversationKey,
      sessionId: recoverySessionId,
      role: binding.role,
      isActive: binding.isActive,
      metadata: binding.metadata,
      lastActiveAt: binding.lastActiveAt,
    });
  }

  const ownedRuns = params.store.listSubagentRunsByOwner({
    workspaceId: params.workspace.id,
    ownerMainSessionId: params.ownerMainSessionId,
    limit: 1000,
    offset: 0,
  });
  for (const run of ownedRuns) {
    params.store.transferSubagentOwnership({
      workspaceId: params.workspace.id,
      subagentId: run.subagentId,
      ownerMainSessionId: recoverySessionId,
    });
  }

  const recoveredAt = utcNowIso();
  for (const event of params.events) {
    const payload = isRecord(event.payload) ? event.payload : {};
    const retry = isRecord(payload.delivery_retry) ? payload.delivery_retry : {};
    const recoveryCount =
      integerOrZero(retry.session_reset_recovery_count) + 1;
    params.store.updateMainSessionEvent({
      workspaceId: params.workspace.id,
      eventId: event.eventId,
      fields: {
        ownerMainSessionId: recoverySessionId,
        payload: {
          ...payload,
          delivery_retry: {
            ...retry,
            session_reset_recovery_count: recoveryCount,
            recovered_owner_main_session_id: recoverySessionId,
            previous_owner_main_session_id: params.ownerMainSessionId,
            recovered_at: recoveredAt,
          },
        },
      },
    });
  }

  return {
    recoverySessionId,
    previousSessionId: params.ownerMainSessionId,
    events: rotatedCoordinatorEvents({
      store: params.store,
      workspaceId: params.workspace.id,
      eventIds: params.events.map((event) => event.eventId),
      recoverySessionId,
    }),
  };
}

function buildMainSessionEventBatchInstruction(
  events: MainSessionEventQueueRecord[],
): string {
  const deliveryBucket = events[0]?.deliveryBucket ?? "background_update";
  const lines = [
    MAIN_SESSION_EVENT_BATCH_HEADER,
    "You are the workspace's main session.",
    "Write exactly one assistant message in your normal conversational voice based on the queued background task events below.",
    "Do not mention internal event ids, queueing, hidden workers, or implementation details.",
  ];
  if (deliveryBucket === "waiting_on_user") {
    lines.push(
      "These events are blocked on user input. Ask only what is needed to unblock the work, and separate the questions clearly with numbered items.",
    );
  } else {
    lines.push(
      "This message is a supplemental continuation only, not a fresh answer to the user's last conversational question.",
      "Do not repeat, paraphrase, or re-answer any direct reply the main session already gave. Only add the newly completed background results.",
      "These events are background updates. Keep the reply concise and natural.",
      "If completed work established clearly stable workspace-wide defaults that future runs should obey by default, record them in `AGENTS.md` with `update_workspace_instructions` before replying.",
      "Before writing to `AGENTS.md`, ask whether the agent should obey the information by default on most future runs in this workspace even when the current subject is not in scope.",
      "Use `AGENTS.md` for rules, defaults, conventions, and recurring commands that should shape behavior by default, not as a general fact store for subject-specific knowledge.",
      "Do not record named-subject knowledge in `AGENTS.md` unless it is explicitly intended to become a workspace-wide default instruction. This includes customer, project, vendor, person, system, or workflow-specific facts such as contacts, owners, thresholds, URLs, channels, prior outcomes, and subject-specific procedures.",
      "A statement being durable or phrased as `remember this` does not by itself make it an `AGENTS.md` item; if it is mainly contextual knowledge to recall later, keep it in memory instead.",
      "Do not persist one-off deliverables, unresolved hypotheses, partial investigations, or temporary runtime state. When in doubt, prefer memory or transient context over `AGENTS.md`.",
      "If an event comes from an automation or cronjob, treat it like a specific automation update rather than a generic status bulletin.",
      "Use the event title, goal, context, and deliverables to explain what ran and what changed in concrete terms.",
      "If an event includes `issue_id` or another task reference such as `source_id`, mention that reference naturally so the user can inspect the underlying task if they want.",
      "If an automation update is marked as the first run, you may mention that naturally when it helps orient the user.",
      "If there is only one update, phrase it as a normal conversational continuation without a `Background updates` heading.",
      "Do not start with stock phrases like `Quick follow-up`, `Brief update`, or `One quick update` unless the user already used that tone.",
      "Only use a clearly separated `Background updates` section when there are multiple distinct updates or the separation is needed for clarity.",
      "If there are multiple updates, use numbered items and keep each task distinct instead of blending them into one paragraph.",
      "Mention useful deliverables by title and treat them as attached artifacts or reports rather than raw file paths when possible.",
      "Do not paste long artifact bodies such as HTML, markdown, or full report content into chat. Keep those as attached deliverables and only summarize them briefly.",
    );
  }
  lines.push("");
  lines.push("[Queued Background Events]");
  lines.push(JSON.stringify(groupedEventPayload(events), null, 2));
  return lines.join("\n").trim();
}

function isMainSessionNaturallyPaused(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sessionId: string;
}): boolean {
  const runtimeState = params.store.getRuntimeState({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
  });
  const runtimeStatus = (runtimeState?.status ?? "").trim().toUpperCase();
  if (
    runtimeStatus === "BUSY" ||
    runtimeStatus === "QUEUED" ||
    runtimeStatus === "WAITING_USER" ||
    runtimeStatus === "PAUSED"
  ) {
    return false;
  }
  return !params.store.hasAvailableInputsForSession({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
  });
}

function materializableBatchForOwner(
  events: MainSessionEventQueueRecord[],
): MainSessionEventQueueRecord[] {
  const waiting = events.filter(
    (event) => event.deliveryBucket === "waiting_on_user",
  );
  if (waiting.length > 0) {
    return waiting;
  }
  return events.filter((event) => event.deliveryBucket === "background_update");
}

function eventQueueWorkspaces(store: RuntimeStateStore): WorkspaceRecord[] {
  const workspaces = new Map<string, WorkspaceRecord>();
  for (const workspace of store.listWorkspaces()) {
    workspaces.set(workspace.id, workspace);
    for (const lab of store.listWorkspaceLabs({
      sourceWorkspaceId: workspace.id,
      activeOnly: true,
    })) {
      workspaces.set(lab.id, lab);
    }
  }
  return [...workspaces.values()];
}

function resolveEventDeliveryOwnerMainSessionId(params: {
  store: RuntimeStateStore;
  workspace: WorkspaceRecord;
  event: MainSessionEventQueueRecord;
}): string | null {
  const ownerSession = params.store.getSession({
    workspaceId: params.workspace.id,
    sessionId: params.event.ownerMainSessionId,
  });
  if (ownerSession && !ownerSession.archivedAt && isCoordinatorSessionKind(ownerSession.kind)) {
    return ownerSession.sessionId;
  }
  const run = params.event.subagentId
    ? params.store.getSubagentRun({
        workspaceId: params.workspace.id,
        subagentId: params.event.subagentId,
      })
    : null;
  return preferredCoordinatorSessionId({
    store: params.store,
    workspace: params.workspace,
    preferredSessionIds: [
      params.event.originMainSessionId,
      run?.ownerMainSessionId,
      run?.originMainSessionId,
      run?.parentSessionId,
    ],
  });
}

export class RuntimeMainSessionEventWorker
  implements MainSessionEventWorkerLike
{
  readonly #store: RuntimeStateStore;
  readonly #queueWorker: QueueWorkerLike | null;
  readonly #logger: LoggerLike | undefined;
  readonly #pollIntervalMs: number;
  readonly #initialDelayMs: number;
  #stopped = false;
  #task: Promise<void> | null = null;
  #wakeResolver: (() => void) | null = null;
  #hasWaitedInitialDelay = false;

  constructor(options: RuntimeMainSessionEventWorkerOptions) {
    this.#store = options.store;
    this.#queueWorker = options.queueWorker ?? null;
    this.#logger = options.logger;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  }

  async start(): Promise<void> {
    if (this.#task) {
      return;
    }
    this.#stopped = false;
    this.#task = this.#runLoop();
  }

  wake(): void {
    const resolve = this.#wakeResolver;
    this.#wakeResolver = null;
    resolve?.();
  }

  async close(): Promise<void> {
    this.#stopped = true;
    this.wake();
    const task = this.#task;
    this.#task = null;
    await task;
  }

  async processAvailableEventsOnce(): Promise<number> {
    const now = utcNowIso();
    let materialized = 0;

    for (const workspace of eventQueueWorkspaces(this.#store)) {
      this.#store.recoverFailedMaterializedMainSessionEvents({
        workspaceId: workspace.id,
        nowIso: now,
      });
      const dueEvents = this.#store.listPendingMainSessionEventsByWorkspace({
        workspaceId: workspace.id,
        before: now,
        limit: 500,
      });
      if (dueEvents.length === 0) {
        continue;
      }

      const reroutedSubagents = new Map<string, string>();
      const deliverableEvents: MainSessionEventQueueRecord[] = [];
      for (const event of dueEvents) {
        const resolvedOwnerMainSessionId = resolveEventDeliveryOwnerMainSessionId({
          store: this.#store,
          workspace,
          event,
        });
        if (!resolvedOwnerMainSessionId) {
          this.#store.markMainSessionEventsSuperseded({
            workspaceId: workspace.id,
            eventIds: [event.eventId],
          });
          continue;
        }
        if (event.ownerMainSessionId === resolvedOwnerMainSessionId) {
          deliverableEvents.push(event);
          continue;
        }
        if (event.subagentId) {
          const previousOwner = reroutedSubagents.get(event.subagentId);
          if (previousOwner !== resolvedOwnerMainSessionId) {
            this.#store.transferSubagentOwnership({
              workspaceId: workspace.id,
              subagentId: event.subagentId,
              ownerMainSessionId: resolvedOwnerMainSessionId,
            });
            reroutedSubagents.set(
              event.subagentId,
              resolvedOwnerMainSessionId,
            );
          }
        } else {
          this.#store.updateMainSessionEvent({
            workspaceId: workspace.id,
            eventId: event.eventId,
            fields: {
              ownerMainSessionId: resolvedOwnerMainSessionId,
            },
          });
        }
        const refreshed = this.#store.getMainSessionEvent({
          workspaceId: workspace.id,
          eventId: event.eventId,
        });
        if (
          refreshed &&
          refreshed.status === "pending" &&
          !refreshed.deliveredAt &&
          !refreshed.supersededAt
        ) {
          deliverableEvents.push(refreshed);
        }
      }
      if (deliverableEvents.length === 0) {
        continue;
      }

      const byOwner = new Map<string, MainSessionEventQueueRecord[]>();
      for (const event of deliverableEvents) {
        const existing = byOwner.get(event.ownerMainSessionId) ?? [];
        existing.push(event);
        byOwner.set(event.ownerMainSessionId, existing);
      }

      for (const [ownerMainSessionId, events] of byOwner.entries()) {
        let effectiveOwnerMainSessionId = ownerMainSessionId;
        let deliveryConfigFallbackSessionId: string | null = null;
        let effectiveEvents = events;
        const rotatedOwner = rotateCoordinatorSessionForReset({
          store: this.#store,
          workspace,
          ownerMainSessionId,
          events,
        });
        if (rotatedOwner) {
          effectiveOwnerMainSessionId = rotatedOwner.recoverySessionId;
          deliveryConfigFallbackSessionId = rotatedOwner.previousSessionId;
          effectiveEvents = rotatedOwner.events;
        }
        if (
          !isMainSessionNaturallyPaused({
            store: this.#store,
            workspaceId: workspace.id,
            sessionId: effectiveOwnerMainSessionId,
          })
        ) {
          continue;
        }

        const batch = materializableBatchForOwner(effectiveEvents);
        if (batch.length === 0) {
          continue;
        }
        const eventIds = batch.map((event) => event.eventId);
        const deliveryConfig = ownerMainSessionDeliveryConfig({
          store: this.#store,
          workspaceId: workspace.id,
          sessionId: effectiveOwnerMainSessionId,
          fallbackSessionId: deliveryConfigFallbackSessionId,
        });
        const input = this.#store.enqueueInput({
          workspaceId: workspace.id,
          sessionId: effectiveOwnerMainSessionId,
          priority: MAIN_SESSION_EVENT_INPUT_PRIORITY,
          idempotencyKey: mainSessionEventBatchIdempotencyKey(batch),
          payload: {
            text: buildMainSessionEventBatchInstruction(batch),
            attachments: [],
            image_urls: [],
            model: deliveryConfig.model,
            thinking_value: deliveryConfig.thinkingValue,
            context: {
              source: "main_session_event_batch",
              owner_main_session_id: effectiveOwnerMainSessionId,
              origin_main_session_ids: [
                ...new Set(batch.map((event) => event.originMainSessionId)),
              ],
              delivery_bucket: batch[0]?.deliveryBucket ?? "background_update",
              main_session_event_ids: eventIds,
              subagent_ids: [
                ...new Set(
                  batch
                    .map((event) => event.subagentId)
                    .filter((value): value is string => Boolean(value)),
                ),
              ],
              queued_events: groupedEventPayload(batch),
              generated_at: now,
            },
          },
        });
        this.#store.markMainSessionEventsMaterialized({
          workspaceId: workspace.id,
          eventIds,
          materializedInputId: input.inputId,
        });
        appendSubagentLifecycleOutputEvents({
          store: this.#store,
          workspaceId: workspace.id,
          sessionId: effectiveOwnerMainSessionId,
          inputId: input.inputId,
          batch,
          createdAt: now,
        });
        materialized += batch.length;
        this.#queueWorker?.wake();
      }
    }

    return materialized;
  }

  async #runLoop(): Promise<void> {
    while (!this.#stopped) {
      if (!this.#hasWaitedInitialDelay && this.#initialDelayMs > 0) {
        this.#hasWaitedInitialDelay = true;
        await this.#waitForWakeOrTimeout(this.#initialDelayMs);
        if (this.#stopped) {
          return;
        }
      }
      try {
        const processed = await this.processAvailableEventsOnce();
        if (processed > 0) {
          continue;
        }
      } catch (error) {
        this.#logger?.error(
          "main-session-event-worker iteration failed",
          error,
        );
      }
      await this.#waitForWakeOrTimeout();
    }
  }

  async #waitForWakeOrTimeout(timeoutMs = this.#pollIntervalMs): Promise<void> {
    await Promise.race([
      sleep(timeoutMs),
      new Promise<void>((resolve) => {
        this.#wakeResolver = resolve;
      }),
    ]);
    this.#wakeResolver = null;
  }
}
