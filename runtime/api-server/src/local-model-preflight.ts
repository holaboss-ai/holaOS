import {
  readLocalModelProviderConfig,
  updateLocalModelContextWindow,
} from "./runtime-config.js";

export const MIN_LOCAL_AGENT_CONTEXT = 16_384;
export const RECOMMENDED_LOCAL_AGENT_CONTEXT = 32_768;
const PROBE_TIMEOUT_MS = 3_000;
const LOAD_TIMEOUT_MS = 180_000;

type FetchImpl = typeof fetch;

export class LocalModelNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalModelNotReadyError";
  }
}

const CONTEXT_ADVICE: Record<string, string> = {
  llamacpp: `Restart llama-server with a larger context, for example \`-c ${RECOMMENDED_LOCAL_AGENT_CONTEXT}\`.`,
  ollama: `Set OLLAMA_CONTEXT_LENGTH=${RECOMMENDED_LOCAL_AGENT_CONTEXT} and restart Ollama, or create a model variant with \`PARAMETER num_ctx ${RECOMMENDED_LOCAL_AGENT_CONTEXT}\`.`,
  lmstudio: `In LM Studio, reload the model with Context Length set to ${RECOMMENDED_LOCAL_AGENT_CONTEXT} or more.`,
  vllm: `Restart vLLM with \`--max-model-len ${RECOMMENDED_LOCAL_AGENT_CONTEXT}\` or more.`,
  sglang: `Restart SGLang with \`--context-length ${RECOMMENDED_LOCAL_AGENT_CONTEXT}\` or more.`,
};

export function localContextTooSmallMessage(engine: string, contextWindow: number): string {
  const advice =
    CONTEXT_ADVICE[engine] ??
    `Restart the model server with a context window of ${RECOMMENDED_LOCAL_AGENT_CONTEXT} tokens or more.`;
  return (
    `This local model is running with a context window of ${contextWindow.toLocaleString("en-US")} tokens, ` +
    `but holaOS needs at least ${MIN_LOCAL_AGENT_CONTEXT.toLocaleString("en-US")} tokens ` +
    `(${RECOMMENDED_LOCAL_AGENT_CONTEXT.toLocaleString("en-US")} recommended) for its instructions and tools. ${advice}`
  );
}

function serverRoot(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v\d+$/, "");
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function requestJson(
  fetchImpl: FetchImpl,
  url: string,
  init: { method?: string; body?: unknown; timeoutMs: number },
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(init.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${url} returned ${response.status}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function sameModel(entry: Record<string, unknown>, modelId: string): boolean {
  return [entry.name, entry.model, entry.id].some((value) => typeof value === "string" && value === modelId);
}

async function ollamaServedContext(fetchImpl: FetchImpl, root: string, modelId: string): Promise<number | null> {
  const readLoaded = async (): Promise<number | null | undefined> => {
    const ps = await requestJson(fetchImpl, `${root}/api/ps`, { timeoutMs: PROBE_TIMEOUT_MS });
    const models = isRecord(ps) && Array.isArray(ps.models) ? ps.models.filter(isRecord) : [];
    const entry = models.find((model) => sameModel(model, modelId));
    return entry ? positiveInteger(entry.context_length) : undefined;
  };
  const loaded = await readLoaded();
  if (loaded !== undefined) {
    return loaded;
  }
  await requestJson(fetchImpl, `${root}/api/generate`, {
    method: "POST",
    body: { model: modelId, prompt: "", keep_alive: "10m", stream: false },
    timeoutMs: LOAD_TIMEOUT_MS,
  });
  return (await readLoaded()) ?? null;
}

async function lmStudioServedContext(fetchImpl: FetchImpl, root: string, modelId: string): Promise<number | null> {
  const readLoaded = async (): Promise<number | null | undefined> => {
    const payload = await requestJson(fetchImpl, `${root}/api/v0/models`, { timeoutMs: PROBE_TIMEOUT_MS });
    const models = isRecord(payload) && Array.isArray(payload.data) ? payload.data.filter(isRecord) : [];
    const entry = models.find((model) => sameModel(model, modelId));
    if (!entry || entry.state !== "loaded") {
      return undefined;
    }
    return positiveInteger(entry.loaded_context_length);
  };
  const loaded = await readLoaded();
  if (loaded !== undefined) {
    return loaded;
  }
  await requestJson(fetchImpl, `${root}/v1/chat/completions`, {
    method: "POST",
    body: { model: modelId, messages: [{ role: "user", content: "ok" }], max_tokens: 1 },
    timeoutMs: LOAD_TIMEOUT_MS,
  });
  return (await readLoaded()) ?? null;
}

async function llamaCppServedContext(fetchImpl: FetchImpl, root: string): Promise<number | null> {
  const props = await requestJson(fetchImpl, `${root}/props`, { timeoutMs: PROBE_TIMEOUT_MS });
  if (!isRecord(props)) {
    return null;
  }
  const settings = isRecord(props.default_generation_settings) ? props.default_generation_settings : {};
  return positiveInteger(settings.n_ctx) ?? positiveInteger(props.n_ctx);
}

async function vllmServedContext(fetchImpl: FetchImpl, baseUrl: string, modelId: string): Promise<number | null> {
  const payload = await requestJson(fetchImpl, `${baseUrl.replace(/\/+$/, "")}/models`, { timeoutMs: PROBE_TIMEOUT_MS });
  const models = isRecord(payload) && Array.isArray(payload.data) ? payload.data.filter(isRecord) : [];
  const entry = models.find((model) => sameModel(model, modelId));
  return entry ? positiveInteger(entry.max_model_len) : null;
}

export async function servedLocalContextWindow(params: {
  engine: string;
  baseUrl: string;
  modelId: string;
  fetchImpl?: FetchImpl;
}): Promise<number | null> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const root = serverRoot(params.baseUrl);
  switch (params.engine) {
    case "ollama":
      return await ollamaServedContext(fetchImpl, root, params.modelId);
    case "lmstudio":
      return await lmStudioServedContext(fetchImpl, root, params.modelId);
    case "llamacpp":
      return await llamaCppServedContext(fetchImpl, root);
    case "vllm":
      return await vllmServedContext(fetchImpl, params.baseUrl, params.modelId);
    default:
      return null;
  }
}

export async function ensureLocalModelReady(
  target: { providerId: string; modelId: string },
  options: { fetchImpl?: FetchImpl } = {},
): Promise<void> {
  const provider = readLocalModelProviderConfig(target.providerId);
  if (!provider) {
    return;
  }
  let served: number | null;
  try {
    served = await servedLocalContextWindow({
      engine: provider.engine,
      baseUrl: provider.base_url,
      modelId: target.modelId,
      fetchImpl: options.fetchImpl,
    });
  } catch {
    throw new LocalModelNotReadyError(
      `The local model server at ${provider.base_url} is not responding. Start it again, or pick another model.`,
    );
  }
  if (served === null) {
    return;
  }
  updateLocalModelContextWindow(target.providerId, target.modelId, served);
  if (served < MIN_LOCAL_AGENT_CONTEXT) {
    throw new LocalModelNotReadyError(localContextTooSmallMessage(provider.engine, served));
  }
}
