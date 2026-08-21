import { createHash } from "node:crypto";

export interface MemoryModelClientConfig {
  baseUrl: string;
  apiKey: string;
  defaultHeaders?: Record<string, string> | null;
  modelId: string;
  apiStyle?: "openai_compatible" | "anthropic_native" | "google_native" | "openrouter_image" | null;
}

export interface MemoryModelJsonQuery {
  systemPrompt: string;
  userPrompt: string;
  timeoutMs?: number;
  agentRole?: string | null;
}

export interface MemoryModelImageInput {
  mimeType: string;
  bytes: Uint8Array;
  detail?: "auto" | "low" | "high";
}

export interface MemoryModelVisionJsonQuery extends MemoryModelJsonQuery {
  images: MemoryModelImageInput[];
}

export interface MemoryModelEmbeddingQuery {
  input: string;
  /**
   * Whether this vector is a transient search key or gets persisted. Required —
   * the two want opposite handling when the input exceeds the model's cap, and
   * the default that "felt safe" (clip everything) silently corrupts the index.
   * See MemoryEmbeddingPurpose.
   */
  purpose: MemoryEmbeddingPurpose;
  timeoutMs?: number;
  agentRole?: string | null;
}

const AGENT_ROLE_HEADER_NAME = "X-Holaboss-Agent-Role";

function withAgentRoleHeader(
  headers: Record<string, string>,
  agentRole: string | null | undefined,
): Record<string, string> {
  const normalized = typeof agentRole === "string" ? agentRole.trim() : "";
  if (!normalized) {
    return headers;
  }
  const alreadyPresent = Object.keys(headers).some(
    (key) => key.toLowerCase() === AGENT_ROLE_HEADER_NAME.toLowerCase(),
  );
  if (alreadyPresent) {
    return headers;
  }
  return { ...headers, [AGENT_ROLE_HEADER_NAME]: normalized };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstNonEmptyString(...values: unknown[]): string {
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

function resolveJsonApiStyle(config: MemoryModelClientConfig): {
  baseUrl: string;
  modelId: string;
  apiStyle: "openai_compatible" | "anthropic_native" | null;
} {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
  const modelId = normalizeOpenAiModelId(config.modelId);
  const apiStyle =
    config.apiStyle === "anthropic_native"
      ? "anthropic_native"
      : config.apiStyle === "openai_compatible"
        ? "openai_compatible"
        : looksLikeOpenAiCompatBaseUrl(baseUrl)
          ? "openai_compatible"
          : looksLikeAnthropicBaseUrl(baseUrl)
            ? "anthropic_native"
            : null;
  return {
    baseUrl,
    modelId,
    apiStyle,
  };
}

function openAiImageContentParts(images: MemoryModelImageInput[]): Array<Record<string, unknown>> {
  return images.map((image) => ({
    type: "image_url",
    image_url: {
      url: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`,
      detail: image.detail ?? "high",
    },
  }));
}

function normalizeAnthropicImageMimeType(value: string): "image/jpeg" | "image/png" | "image/gif" | "image/webp" | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "image/jpg" || normalized === "image/jpeg") {
    return "image/jpeg";
  }
  if (normalized === "image/png") {
    return "image/png";
  }
  if (normalized === "image/gif") {
    return "image/gif";
  }
  if (normalized === "image/webp") {
    return "image/webp";
  }
  return null;
}

function anthropicImageContentParts(images: MemoryModelImageInput[]): Array<Record<string, unknown>> | null {
  const parts: Array<Record<string, unknown>> = [];
  for (const image of images) {
    const mediaType = normalizeAnthropicImageMimeType(image.mimeType);
    if (!mediaType) {
      return null;
    }
    parts.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: Buffer.from(image.bytes).toString("base64"),
      },
    });
  }
  return parts;
}

function looksLikeOpenAiCompatBaseUrl(baseUrl: string): boolean {
  const normalized = baseUrl.trim().toLowerCase().replace(/\/+$/, "");
  return normalized.endsWith("/openai/v1") || normalized.endsWith("/google/v1");
}

function looksLikeAnthropicBaseUrl(baseUrl: string): boolean {
  const normalized = baseUrl.trim().toLowerCase().replace(/\/+$/, "");
  if (!normalized) {
    return false;
  }
  if (normalized.endsWith("/anthropic/v1")) {
    return true;
  }
  try {
    const parsed = new URL(normalized);
    return parsed.hostname.toLowerCase() === "api.anthropic.com";
  } catch {
    return false;
  }
}

function hasExplicitAuthHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => {
    const normalized = key.trim().toLowerCase();
    return normalized === "authorization" || normalized === "x-api-key";
  });
}

function parseJsonObjectCandidate(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // fall through
  }

  // Common fallback: model wraps JSON in fenced markdown.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (!fenced || typeof fenced[1] !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(fenced[1]);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonValueCandidate(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function completionContent(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = choices.length > 0 && isRecord(choices[0]) ? choices[0] : null;
  const message = firstChoice && isRecord(firstChoice.message) ? firstChoice.message : null;
  if (!message) {
    return "";
  }
  if (typeof message.content === "string") {
    return message.content;
  }
  const content = Array.isArray(message.content) ? message.content : [];
  const firstTextPart = content.find((part) => isRecord(part) && typeof part.text === "string") as
    | { text: string }
    | undefined;
  return firstTextPart?.text ?? "";
}

function anthropicCompletionContent(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }
  const content = Array.isArray(payload.content) ? payload.content : [];
  const textParts = content
    .filter((part) => isRecord(part) && typeof part.text === "string")
    .map((part) => String((part as { text: string }).text));
  return textParts.join("\n").trim();
}

export function normalizeOpenAiModelId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex < 0) {
    return trimmed;
  }
  return trimmed.slice(slashIndex + 1).trim() || trimmed;
}

function anthropicMessagesEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) {
    return "";
  }
  const lower = normalized.toLowerCase();
  if (lower.endsWith("/anthropic/v1") || lower.endsWith("/v1")) {
    return `${normalized}/messages`;
  }
  return `${normalized}/v1/messages`;
}

export function modelCallFingerprint(params: {
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        model_id: params.modelId,
        system_prompt: params.systemPrompt,
        user_prompt: params.userPrompt,
      })
    )
    .digest("hex");
}

function headerValue(
  headers: Record<string, string>,
  headerName: string,
): string {
  const normalizedHeaderName = headerName.trim().toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.trim().toLowerCase() === normalizedHeaderName) {
      return value.trim();
    }
  }
  return "";
}

export async function queryMemoryModelJson(
  config: MemoryModelClientConfig,
  query: MemoryModelJsonQuery
): Promise<Record<string, unknown> | null> {
  const { baseUrl, modelId, apiStyle } = resolveJsonApiStyle(config);
  if (!baseUrl || !modelId || !apiStyle) {
    return null;
  }
  const headers: Record<string, string> = withAgentRoleHeader(
    {
      "Content-Type": "application/json",
      ...(config.defaultHeaders ?? {}),
    },
    query.agentRole,
  );

  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Math.min(query.timeoutMs ?? 7000, 20000));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let endpoint = "";
    let body: Record<string, unknown> = {};
    if (apiStyle === "anthropic_native") {
      endpoint = anthropicMessagesEndpoint(baseUrl);
      if (!hasExplicitAuthHeader(headers) && config.apiKey.trim()) {
        headers["x-api-key"] = config.apiKey.trim();
      }
      if (
        !Object.keys(headers).some(
          (key) => key.trim().toLowerCase() === "anthropic-version",
        )
      ) {
        headers["anthropic-version"] = "2023-06-01";
      }
      body = {
        model: modelId,
        temperature: 0,
        max_tokens: 1024,
        system: query.systemPrompt,
        messages: [
          {
            role: "user",
            content: query.userPrompt,
          },
        ],
      };
    } else {
      endpoint = `${baseUrl}/chat/completions`;
      if (!hasExplicitAuthHeader(headers) && config.apiKey.trim()) {
        headers.Authorization = `Bearer ${config.apiKey.trim()}`;
      }
      body = {
        model: modelId,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: query.systemPrompt,
          },
          {
            role: "user",
            content: query.userPrompt,
          },
        ],
      };
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json().catch(() => null);
    const text =
      apiStyle === "anthropic_native"
        ? anthropicCompletionContent(payload)
        : completionContent(payload);
    return parseJsonObjectCandidate(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function queryMemoryModelVisionJson(
  config: MemoryModelClientConfig,
  query: MemoryModelVisionJsonQuery,
): Promise<Record<string, unknown> | null> {
  if (!Array.isArray(query.images) || query.images.length === 0) {
    return queryMemoryModelJson(config, query);
  }
  const { baseUrl, modelId, apiStyle } = resolveJsonApiStyle(config);
  if (!baseUrl || !modelId || !apiStyle) {
    return null;
  }
  const headers: Record<string, string> = withAgentRoleHeader(
    {
      "Content-Type": "application/json",
      ...(config.defaultHeaders ?? {}),
    },
    query.agentRole,
  );

  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Math.min(query.timeoutMs ?? 12000, 30000));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let endpoint = "";
    let body: Record<string, unknown> = {};
    if (apiStyle === "anthropic_native") {
      const imageParts = anthropicImageContentParts(query.images);
      if (!imageParts) {
        return null;
      }
      endpoint = anthropicMessagesEndpoint(baseUrl);
      if (!hasExplicitAuthHeader(headers) && config.apiKey.trim()) {
        headers["x-api-key"] = config.apiKey.trim();
      }
      if (
        !Object.keys(headers).some(
          (key) => key.trim().toLowerCase() === "anthropic-version",
        )
      ) {
        headers["anthropic-version"] = "2023-06-01";
      }
      body = {
        model: modelId,
        temperature: 0,
        max_tokens: 1024,
        system: query.systemPrompt,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: query.userPrompt,
              },
              ...imageParts,
            ],
          },
        ],
      };
    } else {
      endpoint = `${baseUrl}/chat/completions`;
      if (!hasExplicitAuthHeader(headers) && config.apiKey.trim()) {
        headers.Authorization = `Bearer ${config.apiKey.trim()}`;
      }
      body = {
        model: modelId,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: query.systemPrompt,
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: query.userPrompt,
              },
              ...openAiImageContentParts(query.images),
            ],
          },
        ],
      };
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json().catch(() => null);
    const text =
      apiStyle === "anthropic_native"
        ? anthropicCompletionContent(payload)
        : completionContent(payload);
    return parseJsonObjectCandidate(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Embedding inputs are hard-capped by the model — text-embedding-3-small rejects
 * the WHOLE request over 8192 tokens ("Invalid 'input': maximum context length is
 * 8192 tokens") rather than truncating.
 *
 * The two callers of this function want OPPOSITE things when that happens, and it
 * cannot tell them apart on its own — which is why `purpose` is required:
 *
 *  - "query"    a transient search vector. Narrowing it costs a little recall
 *               precision and nothing else, so clip and carry on. Failing here
 *               means recall silently returns nothing and the agent answers
 *               without its own memory.
 *  - "document" a vector that gets PERSISTED, keyed by a content fingerprint that
 *               suppresses recomputation. A truncated one is stored as if it were
 *               the real thing and never revisited, so it must NOT be silently
 *               clipped — better to fail loudly and leave the entry unindexed.
 *
 * Getting this backwards is not hypothetical: clipping at this choke point turned
 * "an inline image is not indexed" into "an inline image is indexed as 6000 chars
 * of base64, indistinguishable from every other image, permanently".
 */
export type MemoryEmbeddingPurpose = "query" | "document";

/**
 * Token budget, with headroom under the model's 8192.
 *
 * The per-character costs below are measured CEILINGS from cl100k_base (the
 * encoding text-embedding-3-small uses), not averages — the whole point is that
 * the estimate must be an UPPER bound, or the clip does not actually guarantee
 * anything.
 *
 * An earlier version used 0.25 tokens per ASCII char ("~4 chars per token"),
 * which is true of English prose and hand-written code and false of everything
 * denser. Measured against a real tokenizer, that let 13 of 22 realistic input
 * classes through over the cap: base64 reached 20,109 tokens (2.45x), minified
 * JS 11,756, a lockfile-shaped JSON 10,933, stack traces 12,173. The failing
 * inputs in production were pasted files, so the bug survived the "fix" for
 * anything that wasn't prose.
 *
 * ASCII: scanning all 128 code points, the worst single character costs exactly
 * 1 token (rare punctuation; dense text like base64/hex/minified JS approaches
 * it). NON-ASCII: the BMP maxes at 3 (<=3 UTF-8 bytes), but astral planes reach
 * 4 (4 bytes -> 4 byte-fallback tokens) — Deseret, Cuneiform, Tangut, CJK ext-G,
 * plane-15/16 PUA, variation selectors.
 *
 * A consequence worth stating: since every character now costs at least one
 * token, the clipped string can never be longer than the budget in CHARACTERS
 * either. The tests assert that, which is a check independent of this estimator.
 */
export const MAX_EMBEDDING_QUERY_TOKENS = 7000;
const TOKENS_PER_ASCII_CHAR = 1;
const TOKENS_PER_NON_ASCII_CHAR = 4;

/** Upper-bound token estimate. Deliberately pessimistic — over-clipping a query
 *  is cheap, a rejected request is not. */
export function estimateEmbeddingTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    tokens +=
      char.codePointAt(0)! < 128
        ? TOKENS_PER_ASCII_CHAR
        : TOKENS_PER_NON_ASCII_CHAR;
  }
  return Math.ceil(tokens);
}

/** Clip to the token budget, cutting on a code-point boundary so the result can
 *  never end in a lone surrogate. */
export function clipToEmbeddingBudget(text: string): string {
  if (estimateEmbeddingTokens(text) <= MAX_EMBEDDING_QUERY_TOKENS) {
    return text;
  }
  let tokens = 0;
  let out = "";
  for (const char of text) {
    tokens +=
      char.codePointAt(0)! < 128
        ? TOKENS_PER_ASCII_CHAR
        : TOKENS_PER_NON_ASCII_CHAR;
    if (tokens > MAX_EMBEDDING_QUERY_TOKENS) break;
    out += char;
  }
  return out;
}

export async function queryMemoryModelEmbedding(
  config: MemoryModelClientConfig,
  query: MemoryModelEmbeddingQuery,
): Promise<Float32Array | null> {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
  const modelId = normalizeOpenAiModelId(config.modelId);
  const apiStyle =
    config.apiStyle === "openai_compatible"
      ? "openai_compatible"
      : config.apiStyle === "anthropic_native"
        ? "anthropic_native"
        : looksLikeOpenAiCompatBaseUrl(baseUrl)
          ? "openai_compatible"
          : looksLikeAnthropicBaseUrl(baseUrl)
            ? "anthropic_native"
            : null;
  if (!baseUrl || !modelId || apiStyle !== "openai_compatible") {
    return null;
  }
  const trimmedInput = query.input.trim();
  if (!trimmedInput) {
    return null;
  }
  // Only a query may be narrowed; a document must reach the model whole or not
  // at all (see MemoryEmbeddingPurpose).
  const normalizedInput =
    query.purpose === "query" ? clipToEmbeddingBudget(trimmedInput) : trimmedInput;
  const headers: Record<string, string> = withAgentRoleHeader(
    {
      "Content-Type": "application/json",
      ...(config.defaultHeaders ?? {}),
    },
    query.agentRole,
  );
  if (!hasExplicitAuthHeader(headers) && config.apiKey.trim()) {
    headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  }
  const endpoint = `${baseUrl}/embeddings`;
  const requestBody = {
    model: modelId,
    input: normalizedInput,
    encoding_format: "float" as const,
  };
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Math.min(query.timeoutMs ?? 7000, 20000));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify(requestBody),
    });
    const responseText = await response.text().catch(() => "");
    if (!response.ok) {
      // Previously this returned null with no trace anywhere in the file, so a
      // rejected embedding was indistinguishable from "no matches": recall came
      // back empty, the agent answered without its memory, and nothing said so.
      // An oversized DOCUMENT still lands here by design (it is not clipped), so
      // this is the only signal that an entry went unindexed.
      console.warn(
        `[memory-embedding] ${response.status} for a ${query.purpose} of ~${estimateEmbeddingTokens(normalizedInput)} est. tokens (${normalizedInput.length} chars): ${responseText.slice(0, 200)}`,
      );
      return null;
    }
    const payload = parseJsonValueCandidate(responseText);
    if (payload === null) {
      return null;
    }
    if (
      !isRecord(payload) ||
      !Array.isArray(payload.data) ||
      payload.data.length === 0 ||
      !isRecord(payload.data[0])
    ) {
      return null;
    }
    const embedding = Array.isArray(payload.data[0].embedding)
      ? payload.data[0].embedding
      : [];
    const values = embedding
      .map((value) => (typeof value === "number" ? value : Number(value)))
      .filter((value) => Number.isFinite(value));
    if (values.length === 0) {
      return null;
    }
    return new Float32Array(values);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizedStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const item of value) {
    const normalized = firstNonEmptyString(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}
