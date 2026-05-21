import { setTimeout as sleep } from "node:timers/promises";

import {
  type MainSessionEventQueueRecord,
  type RuntimeStateStore,
  type WorkspaceRecord,
  utcNowIso,
} from "@holaboss/runtime-state-store";

import type { QueueWorkerLike } from "./queue-worker.js";
import { queuedMainSessionEventPromptEntry } from "./main-session-event-prompt.js";

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
}): { model: string | null; thinkingValue: string | null } {
  const latestInput = params.store.getLatestInputForSession({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    excludeContextSources: ["main_session_event_batch"],
    preferConfiguredModel: true,
  });
  const model =
    typeof latestInput?.payload.model === "string" &&
    latestInput.payload.model.trim()
      ? latestInput.payload.model.trim()
      : null;
  const thinkingValue =
    typeof latestInput?.payload.thinking_value === "string" &&
    latestInput.payload.thinking_value.trim()
      ? latestInput.payload.thinking_value.trim()
      : null;
  return { model, thinkingValue };
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

      const byOwner = new Map<string, MainSessionEventQueueRecord[]>();
      for (const event of dueEvents) {
        const existing = byOwner.get(event.ownerMainSessionId) ?? [];
        existing.push(event);
        byOwner.set(event.ownerMainSessionId, existing);
      }

      for (const [ownerMainSessionId, events] of byOwner.entries()) {
        if (
          !isMainSessionNaturallyPaused({
            store: this.#store,
            workspaceId: workspace.id,
            sessionId: ownerMainSessionId,
          })
        ) {
          continue;
        }

        const batch = materializableBatchForOwner(events);
        if (batch.length === 0) {
          continue;
        }
        const eventIds = batch.map((event) => event.eventId);
        const deliveryConfig = ownerMainSessionDeliveryConfig({
          store: this.#store,
          workspaceId: workspace.id,
          sessionId: ownerMainSessionId,
        });
        const input = this.#store.enqueueInput({
          workspaceId: workspace.id,
          sessionId: ownerMainSessionId,
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
              owner_main_session_id: ownerMainSessionId,
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
          sessionId: ownerMainSessionId,
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
