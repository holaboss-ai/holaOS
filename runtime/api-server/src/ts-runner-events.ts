import {
  type JsonObject,
  type TsRunnerEvent,
  type TsRunnerEventType,
  type TsRunnerPushCallbackConfig,
  type TsRunnerRequest,
  resolvePushCallbackConfig
} from "./ts-runner-contracts.js";
import { installBenignStdioEpipeGuard } from "./stdio-epipe.js";

export type TsRunnerPushEventClient = {
  config: TsRunnerPushCallbackConfig;
};

function jsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export function buildTsRunnerEvent(params: {
  sessionId: string;
  inputId: string;
  sequence: number;
  eventType: TsRunnerEventType;
  payload: Record<string, unknown>;
}): TsRunnerEvent {
  return {
    session_id: params.sessionId,
    input_id: params.inputId,
    sequence: params.sequence,
    event_type: params.eventType,
    timestamp: new Date().toISOString(),
    payload: jsonObject(params.payload)
  };
}

export function buildTsRunnerFailureEvent(params: {
  sessionId: string;
  inputId: string;
  sequence: number;
  message: string;
  errorType: string;
}): TsRunnerEvent {
  return buildTsRunnerEvent({
    sessionId: params.sessionId,
    inputId: params.inputId,
    sequence: params.sequence,
    eventType: "run_failed",
    payload: {
      type: params.errorType,
      message: params.message
    }
  });
}

export function createPushEventClient(request: TsRunnerRequest): TsRunnerPushEventClient | null {
  const config = resolvePushCallbackConfig(request);
  return config ? { config } : null;
}

export async function closePushEventClient(_pushClient: TsRunnerPushEventClient | null): Promise<void> {
  return;
}

export function writeTsRunnerEvent(io: { stdout: NodeJS.WritableStream }, event: TsRunnerEvent): void {
  installBenignStdioEpipeGuard({ stdout: io.stdout, stderr: null });
  io.stdout.write(`${JSON.stringify(event)}\n`);
}

export async function pushTsRunnerEventWithRetry(
  pushClient: TsRunnerPushEventClient,
  event: TsRunnerEvent,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const payload = {
    protocol_version: pushClient.config.protocol_version,
    run_id: pushClient.config.run_id,
    session_id: event.session_id,
    input_id: event.input_id,
    sequence: event.sequence,
    event_type: event.event_type,
    timestamp: event.timestamp,
    payload: event.payload
  };
  const headers = {
    Authorization: `Bearer ${pushClient.config.callback_token}`,
    "Content-Type": "application/json",
    "Idempotency-Key": `${pushClient.config.run_id}:${event.sequence}`
  };

  const maxAttempts = Math.max(1, pushClient.config.max_retries + 1);
  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    try {
      const response = await fetchImpl(pushClient.config.callback_url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(pushClient.config.ack_timeout_ms)
      });

      if (response.status < 300 || response.status === 409) {
        return;
      }
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        console.warn(
          `Push callback rejected event run_id=${pushClient.config.run_id} sequence=${event.sequence} status=${response.status}`
        );
        return;
      }
      if (response.status < 500 && response.status !== 429) {
        console.warn(
          `Push callback returned non-retryable status run_id=${pushClient.config.run_id} sequence=${event.sequence} status=${response.status}`
        );
        return;
      }
      if (attemptIndex >= maxAttempts - 1) {
        console.warn(
          `Push callback exhausted retries run_id=${pushClient.config.run_id} sequence=${event.sequence} status=${response.status}`
        );
        return;
      }
    } catch (error) {
      if (attemptIndex >= maxAttempts - 1) {
        console.warn(
          `Push callback failed after retries for run_id=${pushClient.config.run_id} sequence=${event.sequence}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return;
      }
    }

    const backoffMs = Math.min(2000, 200 * (2 ** attemptIndex));
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }
}

export async function emitTsRunnerEventWithPush(params: {
  io: { stdout: NodeJS.WritableStream };
  event: TsRunnerEvent;
  pushClient: TsRunnerPushEventClient | null;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  writeTsRunnerEvent(params.io, params.event);
  if (!params.pushClient) {
    return;
  }
  await pushTsRunnerEventWithRetry(params.pushClient, params.event, params.fetchImpl);
}
