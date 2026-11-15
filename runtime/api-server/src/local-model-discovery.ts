export type LocalModelEngine =
  | "ollama"
  | "lmstudio"
  | "llamacpp"
  | "vllm"
  | "sglang"
  | "mlx"
  | "openai_compatible";

export const LOCAL_MODEL_ENGINES: readonly LocalModelEngine[] = [
  "ollama",
  "lmstudio",
  "llamacpp",
  "vllm",
  "sglang",
  "mlx",
  "openai_compatible",
];

export interface LocalModelInfo {
  id: string;
  /** Context the server actually serves this model with; omitted when that is only known after loading. */
  context_window?: number;
  /** Largest context the model supports, when it differs from what is being served. */
  max_context_window?: number;
  loaded?: boolean;
  supports_vision?: boolean;
}

export interface LocalModelEndpoint {
  /** Always ends with `/v1`. */
  base_url: string;
  engine: LocalModelEngine;
  engine_version?: string;
  models: LocalModelInfo[];
}

/** Only produced for base URLs the caller passed explicitly; unreachable default candidates are omitted. */
export interface LocalModelEndpointError {
  base_url: string;
  error: string;
}

export type LocalModelDiscoveryEntry = LocalModelEndpoint | LocalModelEndpointError;

export interface LocalModelProbeOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface DiscoverLocalModelEndpointsOptions extends LocalModelProbeOptions {
  baseUrls?: string[];
}

export class LocalModelDiscoveryError extends Error {
  readonly baseUrl: string;

  constructor(baseUrl: string, message: string) {
    super(message);
    this.name = "LocalModelDiscoveryError";
    this.baseUrl = baseUrl;
  }
}

export const DEFAULT_LOCAL_MODEL_PROBE_TIMEOUT_MS = 1200;
const OLLAMA_SHOW_LIMIT = 20;
const EMBEDDING_MODEL_ID_PATTERN = /embed/i;

export const DEFAULT_LOCAL_MODEL_BASE_URLS: readonly string[] = [
  "http://127.0.0.1:11434/v1",
  "http://127.0.0.1:1234/v1",
  "http://127.0.0.1:8080/v1",
  "http://127.0.0.1:8000/v1",
  "http://127.0.0.1:30000/v1",
];

type JsonRecord = Record<string, unknown>;

type ProbeResponse =
  | { ok: true; reachable: true; status: number; json: unknown }
  | { ok: false; reachable: boolean; status: number | null; error: string };

export function isLocalModelEndpointError(
  entry: LocalModelDiscoveryEntry,
): entry is LocalModelEndpointError {
  return typeof (entry as LocalModelEndpointError).error === "string";
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordList(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    const numeric = typeof value === "string" && value.trim() ? Number(value) : value;
    if (typeof numeric === "number" && Number.isFinite(numeric) && numeric > 0) {
      return Math.floor(numeric);
    }
  }
  return undefined;
}

export function localModelServerRoot(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("base_url is required");
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`invalid base_url: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`base_url must be an http(s) URL: ${raw}`);
  }
  const pathname = parsed.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

export function normalizeLocalModelBaseUrl(raw: string): string {
  return `${localModelServerRoot(raw)}/v1`;
}

async function probeJson(
  url: string,
  options: { method?: "GET" | "POST"; body?: unknown; timeoutMs: number; fetchImpl: typeof fetch },
): Promise<ProbeResponse> {
  let response: Response;
  try {
    response = await options.fetchImpl(url, {
      method: options.method ?? "GET",
      headers:
        options.body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    return {
      ok: false,
      reachable: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  let text = "";
  try {
    text = await response.text();
  } catch (error) {
    return {
      ok: false,
      reachable: true,
      status: response.status,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!response.ok) {
    return { ok: false, reachable: true, status: response.status, error: `HTTP ${response.status}` };
  }
  try {
    return { ok: true, reachable: true, status: response.status, json: JSON.parse(text) };
  } catch {
    return { ok: false, reachable: true, status: response.status, error: "response was not JSON" };
  }
}

function okRecord(response: ProbeResponse): JsonRecord | null {
  return response.ok && isRecord(response.json) ? response.json : null;
}

function openAiModelEntries(response: ProbeResponse): JsonRecord[] {
  const payload = okRecord(response);
  if (!payload || !Array.isArray(payload.data)) {
    return [];
  }
  return payload.data.filter(
    (entry): entry is JsonRecord => isRecord(entry) && nonEmptyString(entry.id).length > 0,
  );
}

function isOpenAiModelList(response: ProbeResponse): boolean {
  const payload = okRecord(response);
  return Boolean(payload && Array.isArray(payload.data));
}

function compactModel(model: LocalModelInfo): LocalModelInfo {
  return {
    id: model.id,
    ...(model.context_window !== undefined ? { context_window: model.context_window } : {}),
    ...(model.max_context_window !== undefined && model.max_context_window !== model.context_window
      ? { max_context_window: model.max_context_window }
      : {}),
    ...(model.loaded !== undefined ? { loaded: model.loaded } : {}),
    ...(model.supports_vision !== undefined ? { supports_vision: model.supports_vision } : {}),
  };
}

function genericOpenAiModels(
  entries: JsonRecord[],
  overrides: { contextWindow?: number; loaded?: boolean } = {},
): LocalModelInfo[] {
  return entries
    .filter((entry) => !EMBEDDING_MODEL_ID_PATTERN.test(nonEmptyString(entry.id)))
    .map((entry) =>
      compactModel({
        id: nonEmptyString(entry.id),
        context_window:
          positiveInteger(
            entry.max_model_len,
            entry.context_length,
            entry.context_window,
            entry.max_context_length,
          ) ?? overrides.contextWindow,
        loaded: overrides.loaded,
      }),
    );
}

function ownedBy(entries: JsonRecord[]): Set<string> {
  return new Set(entries.map((entry) => nonEmptyString(entry.owned_by).toLowerCase()).filter(Boolean));
}

function ollamaModelfileContext(show: JsonRecord | null): number | undefined {
  const numCtxMatch = /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(nonEmptyString(show?.parameters));
  return numCtxMatch ? positiveInteger(numCtxMatch[1]) : undefined;
}

function ollamaMaxContext(show: JsonRecord | null): number | undefined {
  if (!show) {
    return undefined;
  }
  const modelInfo = isRecord(show.model_info) ? show.model_info : {};
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(".context_length")) {
      const contextLength = positiveInteger(value);
      if (contextLength !== undefined) {
        return contextLength;
      }
    }
  }
  return undefined;
}

async function collectOllama(
  root: string,
  versionPayload: JsonRecord,
  options: Required<LocalModelProbeOptions>,
): Promise<LocalModelEndpoint> {
  const [tags, ps] = await Promise.all([
    probeJson(`${root}/api/tags`, options),
    probeJson(`${root}/api/ps`, options),
  ]);
  const names = recordList(okRecord(tags)?.models)
    .map((entry) => nonEmptyString(entry.name) || nonEmptyString(entry.model))
    .filter(Boolean);
  const loadedContext = new Map<string, number | undefined>();
  for (const entry of recordList(okRecord(ps)?.models)) {
    for (const name of [nonEmptyString(entry.name), nonEmptyString(entry.model)].filter(Boolean)) {
      loadedContext.set(name, positiveInteger(entry.context_length));
    }
  }
  const shows = await Promise.all(
    names.slice(0, OLLAMA_SHOW_LIMIT).map(async (name) =>
      okRecord(await probeJson(`${root}/api/show`, { ...options, method: "POST", body: { model: name } })),
    ),
  );
  const models: LocalModelInfo[] = [];
  for (const [index, name] of names.entries()) {
    const show = shows[index] ?? null;
    const capabilities = Array.isArray(show?.capabilities)
      ? show.capabilities.filter((value): value is string => typeof value === "string")
      : null;
    if (capabilities && capabilities.length > 0 && !capabilities.includes("completion")) {
      continue;
    }
    models.push(
      compactModel({
        id: name,
        context_window: loadedContext.get(name) ?? ollamaModelfileContext(show),
        max_context_window: ollamaMaxContext(show),
        loaded: loadedContext.has(name),
        supports_vision: capabilities ? capabilities.includes("vision") : undefined,
      }),
    );
  }
  const version = nonEmptyString(versionPayload.version);
  return {
    base_url: `${root}/v1`,
    engine: "ollama",
    ...(version ? { engine_version: version } : {}),
    models,
  };
}

function collectLmStudio(root: string, payload: JsonRecord): LocalModelEndpoint {
  const models = recordList(payload.data)
    .filter((entry) => nonEmptyString(entry.id) && nonEmptyString(entry.type).toLowerCase() !== "embeddings")
    .map((entry) => {
      const loaded = nonEmptyString(entry.state).toLowerCase() === "loaded";
      const type = nonEmptyString(entry.type).toLowerCase();
      return compactModel({
        id: nonEmptyString(entry.id),
        context_window: loaded ? positiveInteger(entry.loaded_context_length) : undefined,
        max_context_window: positiveInteger(entry.max_context_length),
        loaded,
        supports_vision: type ? type === "vlm" : undefined,
      });
    });
  return { base_url: `${root}/v1`, engine: "lmstudio", models };
}

function lmStudioPayload(response: ProbeResponse): JsonRecord | null {
  const payload = okRecord(response);
  if (!payload || !Array.isArray(payload.data)) {
    return null;
  }
  const entries = recordList(payload.data);
  if (entries.length === 0) {
    return payload;
  }
  return entries.some((entry) => "type" in entry || "max_context_length" in entry || "state" in entry)
    ? payload
    : null;
}

function llamaCppProps(response: ProbeResponse): JsonRecord | null {
  const payload = okRecord(response);
  if (!payload) {
    return null;
  }
  return "default_generation_settings" in payload ||
    "build_info" in payload ||
    "model_path" in payload ||
    "n_ctx" in payload
    ? payload
    : null;
}

function collectLlamaCpp(root: string, props: JsonRecord, modelsResponse: ProbeResponse): LocalModelEndpoint {
  const settings = isRecord(props.default_generation_settings) ? props.default_generation_settings : {};
  const contextWindow = positiveInteger(settings.n_ctx, props.n_ctx);
  const modalities = isRecord(props.modalities) ? props.modalities : null;
  const supportsVision = modalities && typeof modalities.vision === "boolean" ? modalities.vision : undefined;
  let ids = openAiModelEntries(modelsResponse)
    .map((entry) => nonEmptyString(entry.id))
    .filter((id) => id && !EMBEDDING_MODEL_ID_PATTERN.test(id));
  if (ids.length === 0) {
    const fallback =
      nonEmptyString(props.model_alias) || nonEmptyString(props.model_path).split(/[\\/]/).pop() || "";
    ids = fallback ? [fallback] : [];
  }
  const single = ids.length === 1;
  if (single && /[\\/]/.test(ids[0]) && /\.gguf$/i.test(ids[0])) {
    // A single-model llama-server ignores the request's `model` field, so the file path is not needed.
    ids = [(ids[0].split(/[\\/]/).pop() ?? ids[0]).replace(/\.gguf$/i, "")];
  }
  const buildInfo =
    nonEmptyString(props.build_info) ||
    (positiveInteger(props.build_number) !== undefined ? `b${positiveInteger(props.build_number)}` : "");
  return {
    base_url: `${root}/v1`,
    engine: "llamacpp",
    ...(buildInfo ? { engine_version: buildInfo } : {}),
    models: ids.map((id) =>
      compactModel({
        id,
        context_window: single ? contextWindow : undefined,
        loaded: single ? true : undefined,
        supports_vision: single ? supportsVision : undefined,
      }),
    ),
  };
}

function sglangModelInfo(response: ProbeResponse): JsonRecord | null {
  const payload = okRecord(response);
  return payload && ("model_path" in payload || "is_generation" in payload) ? payload : null;
}

async function identifyAndCollect(
  root: string,
  options: Required<LocalModelProbeOptions>,
): Promise<LocalModelEndpoint> {
  const [openAiModels, ollamaVersion] = await Promise.all([
    probeJson(`${root}/v1/models`, options),
    probeJson(`${root}/api/version`, options),
  ]);
  if (!openAiModels.ok && !openAiModels.reachable && !ollamaVersion.reachable) {
    throw new LocalModelDiscoveryError(
      `${root}/v1`,
      `No server is responding at ${root} (${openAiModels.error}). Discovery only finds model servers that are already running.`,
    );
  }
  const ollamaVersionPayload = okRecord(ollamaVersion);
  if (ollamaVersionPayload && nonEmptyString(ollamaVersionPayload.version)) {
    return await collectOllama(root, ollamaVersionPayload, options);
  }

  const [lmStudio, props, version, sglangInfo, sglangServer] = await Promise.all([
    probeJson(`${root}/api/v0/models`, options),
    probeJson(`${root}/props`, options),
    probeJson(`${root}/version`, options),
    probeJson(`${root}/get_model_info`, options),
    probeJson(`${root}/get_server_info`, options),
  ]);

  const lmStudioModels = lmStudioPayload(lmStudio);
  if (lmStudioModels) {
    return collectLmStudio(root, lmStudioModels);
  }
  const llamaProps = llamaCppProps(props);
  if (llamaProps) {
    return collectLlamaCpp(root, llamaProps, openAiModels);
  }

  const entries = openAiModelEntries(openAiModels);
  const owners = ownedBy(entries);
  const sglangInfoPayload = sglangModelInfo(sglangInfo);
  if (sglangInfoPayload || owners.has("sglang")) {
    const serverInfo = okRecord(sglangServer) ?? {};
    const engineVersion = nonEmptyString(serverInfo.version) || nonEmptyString(okRecord(version)?.version);
    let models = genericOpenAiModels(entries, {
      contextWindow: positiveInteger(serverInfo.context_length),
      loaded: true,
    });
    const modelPath = nonEmptyString(sglangInfoPayload?.model_path);
    if (models.length === 0 && modelPath && sglangInfoPayload?.is_generation !== false) {
      models = [compactModel({ id: modelPath, loaded: true })];
    }
    return {
      base_url: `${root}/v1`,
      engine: "sglang",
      ...(engineVersion ? { engine_version: engineVersion } : {}),
      models,
    };
  }

  const versionValue = nonEmptyString(okRecord(version)?.version);
  if (owners.has("vllm") || (versionValue && isOpenAiModelList(openAiModels))) {
    return {
      base_url: `${root}/v1`,
      engine: "vllm",
      ...(versionValue ? { engine_version: versionValue } : {}),
      models: genericOpenAiModels(entries, { loaded: true }),
    };
  }

  if (owners.has("llamacpp")) {
    return { base_url: `${root}/v1`, engine: "llamacpp", models: genericOpenAiModels(entries, { loaded: true }) };
  }

  if (isOpenAiModelList(openAiModels)) {
    const isMlx = entries.some((entry) => /mlx/i.test(nonEmptyString(entry.id))) || owners.has("mlx");
    return {
      base_url: `${root}/v1`,
      engine: isMlx ? "mlx" : "openai_compatible",
      models: genericOpenAiModels(entries),
    };
  }

  throw new LocalModelDiscoveryError(
    `${root}/v1`,
    `The server at ${root} responded, but not like a model server (GET ${root}/v1/models: ${
      openAiModels.ok ? "unexpected shape" : openAiModels.error
    }).`,
  );
}

/** Throws `LocalModelDiscoveryError` when nothing answers or the server is not a recognizable model server. */
export async function probeLocalModelEndpoint(
  baseUrl: string,
  options: LocalModelProbeOptions = {},
): Promise<LocalModelEndpoint> {
  let root: string;
  try {
    root = localModelServerRoot(baseUrl);
  } catch (error) {
    throw new LocalModelDiscoveryError(baseUrl, error instanceof Error ? error.message : String(error));
  }
  return await identifyAndCollect(root, {
    timeoutMs: options.timeoutMs ?? DEFAULT_LOCAL_MODEL_PROBE_TIMEOUT_MS,
    fetchImpl: options.fetchImpl ?? fetch,
  });
}

/** Unreachable default candidates are omitted; explicit `baseUrls` that fail come back as error entries. */
export async function discoverLocalModelEndpoints(
  options: DiscoverLocalModelEndpointsOptions = {},
): Promise<LocalModelDiscoveryEntry[]> {
  const candidates = new Map<string, boolean>();
  const invalid: LocalModelEndpointError[] = [];
  for (const raw of DEFAULT_LOCAL_MODEL_BASE_URLS) {
    candidates.set(localModelServerRoot(raw), false);
  }
  for (const raw of options.baseUrls ?? []) {
    if (typeof raw !== "string" || !raw.trim()) {
      continue;
    }
    let root: string;
    try {
      root = localModelServerRoot(raw);
    } catch (error) {
      invalid.push({ base_url: raw.trim(), error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    candidates.set(root, true);
  }

  const results = await Promise.all(
    Array.from(candidates.entries()).map(async ([root, explicit]): Promise<LocalModelDiscoveryEntry | null> => {
      try {
        return await probeLocalModelEndpoint(root, options);
      } catch (error) {
        if (!explicit) {
          return null;
        }
        return {
          base_url: `${root}/v1`,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  return [...results.filter((entry): entry is LocalModelDiscoveryEntry => entry !== null), ...invalid];
}
