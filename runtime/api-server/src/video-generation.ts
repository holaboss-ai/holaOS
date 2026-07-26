import fs from "node:fs/promises";
import path from "node:path";

import {
  createVideoGenerationModelClient,
  resolveVideoGenerationModelSelection,
  type VideoGenerationModelClient,
} from "./video-generation-model.js";
import { assertPublicHttpUrl } from "./ssrf-guard.js";

export interface GenerateWorkspaceVideoParams {
  workspaceRoot: string;
  workspaceId: string;
  /** Absolute base dir to write the output under (…/outputs/videos/<file>).
   *  For a project-bound session this is the project's path so artifacts land in
   *  the project — not the workspace root. Defaults to `<workspaceRoot>/<id>`. */
  outputRoot?: string | null;
  sessionId: string;
  inputId: string;
  selectedModel?: string | null;
  defaultProviderId?: string | null;
  prompt: string;
  filename?: string | null;
  size?: string | null;
  /** Optional duration hint in seconds (provider-specific). */
  seconds?: number | null;
}

export interface GenerateWorkspaceVideoResult {
  filePath: string;
  mimeType: string;
  sizeBytes: number;
  providerId: string;
  modelId: string;
  prompt: string;
}

// Video jobs are slow; poll the proxy until the job reaches a terminal state.
const POLL_INTERVAL_MS = 4_000;
const MAX_WAIT_MS = 9 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function sanitizeFilenameStem(value: string): string {
  const stem = value
    .trim()
    .replace(/[/\\]+/g, " ")
    .replace(/[^a-zA-Z0-9._ -]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_. ]+|[-_. ]+$/g, "");
  return stem || "generated-video";
}

function outputFilePath(params: {
  outputRoot: string;
  filename?: string | null;
  extension: string;
}): { absolutePath: string; relativePath: string } {
  const stem = sanitizeFilenameStem(firstString(params.filename) || "generated-video");
  const withExt = stem.toLowerCase().endsWith(params.extension)
    ? stem
    : `${stem}${params.extension}`;
  const relativePath = path.posix.join("outputs", "videos", withExt);
  const absolutePath = path.join(params.outputRoot, "outputs", "videos", withExt);
  return { absolutePath, relativePath };
}

function authHeaders(client: VideoGenerationModelClient): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(client.defaultHeaders ?? {}),
  };
  const hasAuth = Object.keys(headers).some((key) => {
    const k = key.trim().toLowerCase();
    return k === "authorization" || k === "x-api-key";
  });
  if (!hasAuth && client.apiKey) {
    headers.Authorization = `Bearer ${client.apiKey}`;
  }
  return headers;
}

/** A video object from the proxy — tolerant of the OpenAI video (Sora) shape
 *  ({id, status, ...}) and a plain {data:[{url|b64_json}]} sync response. */
interface VideoJob {
  id: string;
  status: string;
  url: string;
  b64: string;
  error: string;
}

function parseVideoJob(payload: unknown): VideoJob {
  const record = isRecord(payload) ? payload : {};
  const data =
    Array.isArray(record.data) && isRecord(record.data[0]) ? (record.data[0] as Record<string, unknown>) : {};
  const errorPayload = isRecord(record.error) ? record.error : {};
  // OpenRouter (the upstream behind the proxy) returns the finished asset as
  // `unsigned_urls: [...]`; OpenAI/Sora returns it via `/content`. Read both.
  const unsignedUrls = Array.isArray(record.unsigned_urls) ? record.unsigned_urls : [];
  const firstUnsignedUrl = typeof unsignedUrls[0] === "string" ? unsignedUrls[0] : "";
  return {
    id: firstString(record.id, data.id),
    status:
      firstString(record.status, data.status) ||
      (firstUnsignedUrl || data.url || data.b64_json ? "completed" : ""),
    url: firstString(
      record.url,
      data.url,
      firstUnsignedUrl,
      isRecord(record.video) ? (record.video as Record<string, unknown>).url : "",
    ),
    b64: firstString(record.b64_json, data.b64_json),
    error: firstString(record.error as string, errorPayload.message, data.error as string),
  };
}

// Terminal statuses across OpenAI/Sora + OpenRouter that mean the job won't
// produce a video.
const FAILED_STATUSES = new Set(["failed", "error", "cancelled", "expired"]);

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `video generation request failed with status ${response.status}`);
  }
  return response.json().catch(() => ({}));
}

async function downloadVideoBytes(
  client: VideoGenerationModelClient,
  baseUrl: string,
  job: VideoJob,
): Promise<Buffer> {
  // Prefer a direct content URL if the job exposes one; otherwise pull the
  // OpenAI-style /videos/{id}/content stream.
  const usingProviderUrl = Boolean(job.url);
  const downloadUrl = job.url || `${baseUrl}/videos/${encodeURIComponent(job.id)}/content`;

  // SSRF: `job.url` is provider-returned (untrusted) — validate it before
  // fetching. The proxy-constructed fallback URL is trusted (built from our own
  // baseUrl) so it doesn't need the guard.
  if (usingProviderUrl) {
    await assertPublicHttpUrl(downloadUrl);
  }

  const headers = authHeaders(client);
  delete headers["Content-Type"];

  // Never leak the client auth token to a download host that isn't the
  // model-proxy origin. When the provider hands back a URL on a different
  // origin (e.g. a CDN / signed storage URL), strip Authorization / x-api-key.
  let downloadOrigin: string | null = null;
  try {
    downloadOrigin = new URL(downloadUrl).origin;
  } catch {
    downloadOrigin = null;
  }
  let proxyOrigin: string | null = null;
  try {
    proxyOrigin = new URL(baseUrl).origin;
  } catch {
    proxyOrigin = null;
  }
  if (usingProviderUrl && downloadOrigin !== proxyOrigin) {
    for (const key of Object.keys(headers)) {
      const k = key.trim().toLowerCase();
      if (k === "authorization" || k === "x-api-key") {
        delete headers[key];
      }
    }
  }

  const response = await fetch(downloadUrl, { method: "GET", headers });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `video download failed with status ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function generateWorkspaceVideo(
  params: GenerateWorkspaceVideoParams,
): Promise<GenerateWorkspaceVideoResult> {
  const prompt = firstString(params.prompt);
  const selection = resolveVideoGenerationModelSelection({
    selectedModel: params.selectedModel,
    defaultProviderId: params.defaultProviderId,
  });
  const client = createVideoGenerationModelClient({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    inputId: params.inputId,
    selectedModel: params.selectedModel,
    defaultProviderId: params.defaultProviderId,
  });
  if (!client || !selection.modelId) {
    throw new Error(
      "Video generation is not configured — configure a video generation provider and model.",
    );
  }

  const baseUrl = client.baseUrl.trim().replace(/\/+$/, "");
  const headers = authHeaders(client);

  // 1. Submit the job (OpenAI Sora-compatible /videos endpoint on the proxy).
  //    Per the OpenAI video API, `seconds` is a string (e.g. "8") and `size`
  //    is a `WIDTHxHEIGHT` string (e.g. "1280x720").
  const requestBody: Record<string, unknown> = {
    model: client.modelId,
    prompt,
    ...(firstString(params.size) ? { size: firstString(params.size) } : {}),
    ...(typeof params.seconds === "number" && params.seconds > 0
      ? { seconds: String(params.seconds) }
      : {}),
  };
  const submitPayload = await fetchJson(`${baseUrl}/videos`, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  });
  let job = parseVideoJob(submitPayload);
  if (!job.id && !job.url && !job.b64) {
    throw new Error("video generation did not return a job id or output");
  }

  // 2. Poll until the job reaches a terminal state (unless it returned a
  //    finished video synchronously).
  const startedAt = Date.now();
  while (job.id && !job.url && !job.b64 && job.status !== "completed" && job.status !== "succeeded") {
    if (FAILED_STATUSES.has(job.status)) {
      throw new Error(job.error || `video generation ${job.status}`);
    }
    if (Date.now() - startedAt > MAX_WAIT_MS) {
      throw new Error("video generation timed out while waiting for the job to finish");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const pollPayload = await fetchJson(`${baseUrl}/videos/${encodeURIComponent(job.id)}`, {
      method: "GET",
      headers,
    });
    job = parseVideoJob(pollPayload);
  }
  if (job.status === "failed" || job.status === "error" || job.status === "cancelled") {
    throw new Error(job.error || `video generation ${job.status}`);
  }

  // 3. Materialize the bytes — inline base64 if present, else download.
  const buffer = job.b64 ? Buffer.from(job.b64, "base64") : await downloadVideoBytes(client, baseUrl, job);
  if (buffer.length === 0) {
    throw new Error("video generation returned an empty file");
  }

  const { absolutePath, relativePath } = outputFilePath({
    outputRoot:
      firstString(params.outputRoot) ||
      path.join(params.workspaceRoot, params.workspaceId),
    filename: params.filename,
    extension: ".mp4",
  });
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, buffer);

  return {
    filePath: relativePath,
    mimeType: "video/mp4",
    sizeBytes: buffer.length,
    providerId: selection.providerId,
    modelId: client.modelId,
    prompt,
  };
}
