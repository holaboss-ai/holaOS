import http from "node:http";
import https from "node:https";

export type CapabilityHttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeRuntimeApiBaseUrl(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

export function toolRequestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

function parseJsonText(text: string): unknown {
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text);
}

export async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  return parseJsonText(text);
}

export async function nodeRequestJson(params: {
  url: string;
  method: CapabilityHttpMethod;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; status: number; payload: unknown }> {
  const target = new URL(params.url);
  const client = target.protocol === "https:" ? https : http;

  return await new Promise((resolve, reject) => {
    const request = client.request(
      target,
      {
        method: params.method,
        headers: params.headers,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          try {
            resolve({
              ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
              status: response.statusCode ?? 0,
              payload: parseJsonText(text),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    request.on("error", reject);

    if (params.signal) {
      if (params.signal.aborted) {
        request.destroy(params.signal.reason instanceof Error ? params.signal.reason : new Error("Request aborted"));
      } else {
        params.signal.addEventListener(
          "abort",
          () => {
            request.destroy(params.signal?.reason instanceof Error ? params.signal.reason : new Error("Request aborted"));
          },
          { once: true },
        );
      }
    }

    if (params.body) {
      request.write(params.body);
    }
    request.end();
  });
}

export async function requestCapabilityJson(params: {
  url: string;
  method: CapabilityHttpMethod;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; status: number; payload: unknown }> {
  if (!params.fetchImpl) {
    return await nodeRequestJson(params);
  }
  const raw = await params.fetchImpl(params.url, {
    method: params.method,
    headers: params.headers,
    ...(params.body ? { body: params.body } : {}),
    signal: params.signal,
  });
  return {
    ok: raw.ok,
    status: raw.status,
    payload: await readJsonResponse(raw),
  };
}

const DEFAULT_COMPACT_TOOL_RESULT_THRESHOLD_BYTES = 32 * 1024;
const DEFAULT_COMPACT_TOOL_RESULT_PREVIEW_BYTES = 8 * 1024;

export interface FormattedCapabilityToolResult {
  text: string;
  compacted: boolean;
  serializedBytes: number;
  modelTextBytes: number;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function truncateUtf8Text(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) {
    return value;
  }

  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8ByteLength(value.slice(0, mid)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  const candidate = value.slice(0, low);
  return /[\uD800-\uDBFF]$/.test(candidate) ? candidate.slice(0, -1) : candidate;
}

function topLevelPayloadSummary(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return {
      type: "string",
      characters: value.length,
    };
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      items: value.length,
    };
  }
  if (!isRecord(value)) {
    return {
      type: value === null ? "null" : typeof value,
    };
  }

  const keys = Object.keys(value);
  const fieldSummaries: Record<string, unknown> = {};
  for (const key of keys.slice(0, 20)) {
    const fieldValue = value[key];
    if (typeof fieldValue === "string") {
      fieldSummaries[key] = { type: "string", characters: fieldValue.length };
    } else if (Array.isArray(fieldValue)) {
      fieldSummaries[key] = { type: "array", items: fieldValue.length };
    } else if (isRecord(fieldValue)) {
      fieldSummaries[key] = { type: "object", keys: Object.keys(fieldValue).slice(0, 20) };
    } else {
      fieldSummaries[key] = { type: fieldValue === null ? "null" : typeof fieldValue };
    }
  }

  return {
    type: "object",
    keys: keys.slice(0, 50),
    ...(keys.length > 50 ? { omitted_key_count: keys.length - 50 } : {}),
    fields: fieldSummaries,
  };
}

export function formatCapabilityToolResult(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  return JSON.stringify(payload, null, 2);
}

export function formatCapabilityToolResultForModel(
  payload: unknown,
  options?: {
    thresholdBytes?: number;
    previewBytes?: number;
  },
): FormattedCapabilityToolResult {
  const serialized = formatCapabilityToolResult(payload);
  const serializedBytes = utf8ByteLength(serialized);
  const thresholdBytes = options?.thresholdBytes ?? DEFAULT_COMPACT_TOOL_RESULT_THRESHOLD_BYTES;
  if (serializedBytes <= thresholdBytes) {
    return {
      text: serialized,
      compacted: false,
      serializedBytes,
      modelTextBytes: serializedBytes,
    };
  }

  const preview = truncateUtf8Text(
    serialized,
    options?.previewBytes ?? DEFAULT_COMPACT_TOOL_RESULT_PREVIEW_BYTES,
  );
  const envelope: Record<string, unknown> = {
    tool_result_format: "compact_envelope",
    status: "truncated",
    serialized_bytes: serializedBytes,
    summary: topLevelPayloadSummary(payload),
    preview,
    raw_result: {
      available: true,
      stored_in: "tool_result.details.raw",
    },
  };

  if (isRecord(payload) && typeof payload.ok === "boolean") {
    envelope.ok = payload.ok;
  }

  const text = JSON.stringify(envelope, null, 2);
  return {
    text,
    compacted: true,
    serializedBytes,
    modelTextBytes: utf8ByteLength(text),
  };
}
