import fs from "node:fs/promises";
import path from "node:path";

import {
  createImageGenerationModelClient,
  resolveImageGenerationModelSelection,
} from "./image-generation-model.js";

export interface GenerateWorkspaceImageParams {
  workspaceRoot: string;
  workspaceId: string;
  /** Absolute base dir to write the output under (…/outputs/images/<file>).
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
}

export interface GenerateWorkspaceImageResult {
  filePath: string;
  mimeType: string;
  sizeBytes: number;
  providerId: string;
  modelId: string;
  prompt: string;
  revisedPrompt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
}

function hasExplicitAuthHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => {
    const normalized = key.trim().toLowerCase();
    return normalized === "authorization" || normalized === "x-api-key" || normalized === "x-goog-api-key";
  });
}

function sanitizeFilenameStem(value: string): string {
  const stem = value
    .trim()
    .replace(/[/\\]+/g, " ")
    .replace(/[^a-zA-Z0-9._ -]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_. ]+|[-_. ]+$/g, "");
  return stem || "generated-image";
}

function detectImageFormat(bytes: Uint8Array): { extension: string; mimeType: string } {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { extension: ".png", mimeType: "image/png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: ".jpg", mimeType: "image/jpeg" };
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { extension: ".webp", mimeType: "image/webp" };
  }
  return { extension: ".png", mimeType: "image/png" };
}

function googleImageConfigFromSize(value: string): { aspectRatio: string; imageSize: string } | null {
  const normalized = value.trim().toLowerCase();
  const match = normalized.match(/^(\d+)\s*x\s*(\d+)$/);
  if (!match) {
    return null;
  }
  const width = Number.parseInt(match[1] ?? "", 10);
  const height = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const aspectRatioOptions = [
    ["1:1", 1 / 1],
    ["2:3", 2 / 3],
    ["3:2", 3 / 2],
    ["3:4", 3 / 4],
    ["4:3", 4 / 3],
    ["4:5", 4 / 5],
    ["5:4", 5 / 4],
    ["9:16", 9 / 16],
    ["16:9", 16 / 9],
    ["21:9", 21 / 9],
  ] as const;
  const requestedRatio = width / height;
  const [aspectRatio] = aspectRatioOptions.reduce((best, candidate) => {
    return Math.abs(candidate[1] - requestedRatio) < Math.abs(best[1] - requestedRatio) ? candidate : best;
  });
  const longestEdge = Math.max(width, height);
  const imageSize = longestEdge <= 1024 ? "1K" : longestEdge <= 2048 ? "2K" : "4K";
  return {
    aspectRatio,
    imageSize,
  };
}

function splitDataUrl(value: string): { mimeType: string; data: string } | null {
  const match = value.trim().match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match || !match[1] || !match[2]) {
    return null;
  }
  return {
    mimeType: match[1].trim().toLowerCase(),
    data: match[2].trim(),
  };
}

function googleNativeImagePayload(params: { modelId: string; prompt: string; size?: string | null }): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    responseModalities: ["TEXT", "IMAGE"],
  };
  const imageConfig = params.size ? googleImageConfigFromSize(params.size) : null;
  if (imageConfig) {
    generationConfig.imageConfig = imageConfig;
  }
  return {
    contents: [
      {
        role: "user",
        parts: [{ text: params.prompt }],
      },
    ],
    generationConfig,
  };
}

function googleNativeImageResult(payload: unknown): { b64: string; revisedPrompt: string | null } | null {
  if (!isRecord(payload)) {
    return null;
  }
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      continue;
    }
    const content = isRecord(candidate.content) ? candidate.content : null;
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const textFragments: string[] = [];
    for (const part of parts) {
      if (!isRecord(part)) {
        continue;
      }
      const text = firstString(part.text);
      if (text) {
        textFragments.push(text);
      }
      const inlineData = isRecord(part.inlineData) ? part.inlineData : null;
      const data = firstString(inlineData?.data);
      if (data) {
        return {
          b64: data,
          revisedPrompt: textFragments.join("").trim() || null,
        };
      }
    }
  }
  return null;
}

function openRouterImagePayload(params: { modelId: string; prompt: string; size?: string | null }): Record<string, unknown> {
  // OpenRouter's dedicated image router (POST /api/v1/images) — a flat
  // {model, prompt, ...} request that works across every image model
  // (gpt-image-*, gemini, seedream, flux). Replaces the old /chat/completions +
  // modalities:["image","text"] shape, which 404s for pure image models like
  // gpt-image-2 (whose output modality is ["image"] only). The response is the
  // OpenAI-images shape {data:[{b64_json}]}, parsed by the shared data[] path.
  const payload: Record<string, unknown> = {
    model: params.modelId,
    prompt: params.prompt,
  };
  const imageConfig = params.size ? googleImageConfigFromSize(params.size) : null;
  if (imageConfig) {
    payload.aspect_ratio = imageConfig.aspectRatio;
    payload.resolution = imageConfig.imageSize;
  }
  return payload;
}

function openRouterImageResult(payload: unknown): { b64: string; mimeType: string | null; revisedPrompt: string | null } | null {
  if (!isRecord(payload)) {
    return null;
  }
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  for (const choice of choices) {
    if (!isRecord(choice)) {
      continue;
    }
    const message = isRecord(choice.message) ? choice.message : null;
    if (!message) {
      continue;
    }
    const revisedPrompt = firstString(message.content) || null;
    const images = Array.isArray(message.images) ? message.images : [];
    for (const image of images) {
      if (!isRecord(image)) {
        continue;
      }
      const imageUrlPayload = isRecord(image.image_url)
        ? image.image_url
        : isRecord(image.imageUrl)
          ? image.imageUrl
          : null;
      const dataUrl = splitDataUrl(firstString(imageUrlPayload?.url));
      if (!dataUrl) {
        continue;
      }
      return {
        b64: dataUrl.data,
        mimeType: dataUrl.mimeType,
        revisedPrompt,
      };
    }
  }
  return null;
}

function outputFilePath(params: {
  outputRoot: string;
  filename?: string | null;
  extension: string;
}): { absolutePath: string; relativePath: string } {
  const requestedName = firstString(params.filename);
  const parsed = path.parse(requestedName || "");
  const stem = sanitizeFilenameStem(parsed.name || requestedName || "generated-image");
  const fileName = `${stem}${params.extension}`;
  const relativePath = path.posix.join("outputs", "images", fileName);
  return {
    absolutePath: path.join(params.outputRoot, relativePath),
    relativePath,
  };
}

export async function generateWorkspaceImage(
  params: GenerateWorkspaceImageParams,
): Promise<GenerateWorkspaceImageResult> {
  const prompt = firstString(params.prompt);
  if (!prompt) {
    throw new Error("prompt is required");
  }

  const client = createImageGenerationModelClient({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    inputId: params.inputId,
    selectedModel: params.selectedModel,
    defaultProviderId: params.defaultProviderId,
  });
  const selection = resolveImageGenerationModelSelection({
    selectedModel: params.selectedModel,
    defaultProviderId: params.defaultProviderId,
  });
  if (!client || !selection.providerId || !selection.modelId) {
    throw new Error(
      "Image generation is not configured. Configure an image generation provider and model in Model Providers.",
    );
  }

  const baseUrl = client.baseUrl.trim().replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(client.defaultHeaders ?? {}),
  };
  let endpoint = `${baseUrl}/images/generations`;
  let requestBody: Record<string, unknown> = {
    model: client.modelId,
    prompt,
    n: 1,
    ...(firstString(params.size) ? { size: firstString(params.size) } : {}),
  };
  if (client.apiStyle === "google_native") {
    if (!hasExplicitAuthHeader(headers) && client.apiKey.trim()) {
      headers["x-goog-api-key"] = client.apiKey.trim();
    }
    endpoint = `${baseUrl}/models/${encodeURIComponent(client.modelId)}:generateContent`;
    requestBody = googleNativeImagePayload({
      modelId: client.modelId,
      prompt,
      size: params.size,
    });
  } else if (client.apiStyle === "openrouter_image") {
    endpoint = `${baseUrl}/images`;
    if (!hasExplicitAuthHeader(headers) && client.apiKey.trim()) {
      headers.Authorization = `Bearer ${client.apiKey.trim()}`;
    }
    requestBody = openRouterImagePayload({
      modelId: client.modelId,
      prompt,
      size: params.size,
    });
  } else if (!hasExplicitAuthHeader(headers) && client.apiKey.trim()) {
    headers.Authorization = `Bearer ${client.apiKey.trim()}`;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      detail || `image generation failed with status ${response.status}`,
    );
  }

  const payload = await response.json().catch(() => ({}));
  const openAiImageData =
    isRecord(payload) && Array.isArray(payload.data) && isRecord(payload.data[0])
      ? payload.data[0]
      : null;
  const googleImageData =
    client.apiStyle === "google_native" ? googleNativeImageResult(payload) : null;
  const openRouterImageData =
    client.apiStyle === "openrouter_image" ? openRouterImageResult(payload) : null;
  const b64 = firstString(
    openAiImageData?.b64_json,
    googleImageData?.b64,
    openRouterImageData?.b64,
  );
  if (!b64) {
    throw new Error("image generation did not return b64_json output");
  }

  const buffer = Buffer.from(b64, "base64");
  const detectedFormat =
    openRouterImageData?.mimeType === "image/png"
      ? { extension: ".png", mimeType: "image/png" }
      : openRouterImageData?.mimeType === "image/jpeg"
        ? { extension: ".jpg", mimeType: "image/jpeg" }
        : openRouterImageData?.mimeType === "image/webp"
          ? { extension: ".webp", mimeType: "image/webp" }
          : detectImageFormat(buffer);
  const revisedPrompt =
    firstString(
      openAiImageData?.revised_prompt,
      googleImageData?.revisedPrompt,
      openRouterImageData?.revisedPrompt,
    ) || null;
  const { absolutePath, relativePath } = outputFilePath({
    outputRoot:
      firstString(params.outputRoot) ||
      path.join(params.workspaceRoot, params.workspaceId),
    filename: params.filename,
    extension: detectedFormat.extension,
  });

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, buffer);

  return {
    filePath: relativePath,
    mimeType: detectedFormat.mimeType,
    sizeBytes: buffer.length,
    providerId: selection.providerId,
    modelId: client.modelId,
    prompt,
    revisedPrompt,
  };
}
