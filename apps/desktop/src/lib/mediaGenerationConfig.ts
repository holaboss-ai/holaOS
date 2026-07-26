/**
 * Self-contained runtime-config logic for the agent's media-generation tools
 * (image + video). This mirrors the per-capability logic that used to live in
 * AuthPanel — it reads/writes only the `runtime.image_generation` and
 * `runtime.video_generation` slices of the runtime config document, so the
 * "Tools" settings can live anywhere (now the Customize → Capabilities pane)
 * without pulling in the rest of AuthPanel's provider machinery.
 *
 * Only the built-in `holaboss` provider is supported, so the multi-provider
 * template branches are intentionally dropped.
 */

export type MediaGenerationKind = "image" | "video";

export interface MediaGenerationDraft {
  /** "holaboss" once resolved, or "" when nothing is configured. */
  providerId: "holaboss" | "";
  model: string;
}

/**
 * No `defaultVideoModel` is plumbed from the runtime config (unlike image
 * generation), so seed the picker + placeholder with the house default.
 */
export const VIDEO_GENERATION_DEFAULT_MODEL = "bytedance/seedance-2.0";

// The runtime writes model bindings under this provider storage id.
const PROVIDER_STORAGE_ID = "holaboss_model_proxy";

type CatalogCapability =
  | "chat"
  | "image_generation"
  | "video_generation"
  | "embedding";

const CAPABILITY_ALIASES: Record<string, CatalogCapability> = {
  chat: "chat",
  text: "chat",
  completion: "chat",
  completions: "chat",
  responses: "chat",
  embedding: "embedding",
  embeddings: "embedding",
  image: "image_generation",
  images: "image_generation",
  image_generation: "image_generation",
  image_gen: "image_generation",
  video: "video_generation",
  videos: "video_generation",
  video_generation: "video_generation",
  video_gen: "video_generation",
};

interface KindConfig {
  /** snake_case key written into the runtime config document. */
  snakeKey: "image_generation" | "video_generation";
  /** camelCase legacy key to strip so the two shapes never coexist. */
  camelKey: "imageGeneration" | "videoGeneration";
  capability: CatalogCapability;
}

const KIND_CONFIG: Record<MediaGenerationKind, KindConfig> = {
  image: {
    snakeKey: "image_generation",
    camelKey: "imageGeneration",
    capability: "image_generation",
  },
  video: {
    snakeKey: "video_generation",
    camelKey: "videoGeneration",
    capability: "video_generation",
  },
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function firstNonEmptyString(
  ...values: Array<string | null | undefined>
): string {
  for (const value of values) {
    const normalized = (value ?? "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

export function parseRuntimeConfigDocument(
  rawText: string,
): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(rawText) as unknown);
  } catch {
    return {};
  }
}

function uniqueValues(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeCapability(value: string): CatalogCapability | "" {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) {
    return "";
  }
  return CAPABILITY_ALIASES[normalized] ?? "";
}

function modelSupportsCapability(
  model: RuntimeProviderModelPayload,
  capability: CatalogCapability,
): boolean {
  if (!Array.isArray(model.capabilities)) {
    return capability === "chat";
  }
  const capabilities = new Set<CatalogCapability>();
  for (const value of model.capabilities) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = normalizeCapability(value);
    if (normalized) {
      capabilities.add(normalized);
    }
  }
  if (capabilities.size === 0) {
    return capability === "chat";
  }
  return capabilities.has(capability);
}

/** Model ids the managed catalog lists for a given capability. */
function catalogModelIds(
  runtimeConfig: RuntimeConfigPayload | null,
  capability: CatalogCapability,
): string[] {
  const group = runtimeConfig?.providerModelGroups.find(
    (candidate) => candidate.providerId.trim() === PROVIDER_STORAGE_ID,
  );
  if (!group) {
    return [];
  }
  return uniqueValues(
    group.models
      .filter((model) => modelSupportsCapability(model, capability))
      .map((model) => (model.modelId || model.token).trim())
      .filter(Boolean),
  );
}

/** The house/default model shown as the picker placeholder. */
export function mediaGenerationDefaultModel(
  kind: MediaGenerationKind,
  runtimeConfig: RuntimeConfigPayload | null,
): string {
  if (kind === "image") {
    return (runtimeConfig?.defaultImageModel ?? "").trim();
  }
  return VIDEO_GENERATION_DEFAULT_MODEL;
}

export function mediaGenerationPlaceholder(
  kind: MediaGenerationKind,
  runtimeConfig: RuntimeConfigPayload | null,
): string {
  const fallback = mediaGenerationDefaultModel(kind, runtimeConfig);
  return fallback ? `Default: ${fallback}` : "Select a model";
}

/** Selectable model ids for the picker (current pick + catalog suggestions). */
export function mediaGenerationModelOptions(
  kind: MediaGenerationKind,
  draft: MediaGenerationDraft,
  runtimeConfig: RuntimeConfigPayload | null,
): string[] {
  const capability = KIND_CONFIG[kind].capability;
  const catalog = catalogModelIds(runtimeConfig, capability);
  // Until the managed catalog lists a video model, keep the house default
  // selectable so the picker is usable the moment the section is opened.
  const suggestions =
    kind === "video" && catalog.length === 0
      ? [VIDEO_GENERATION_DEFAULT_MODEL]
      : catalog;
  return uniqueValues([draft.model.trim(), ...suggestions]);
}

/**
 * A model can actually resolve (so the section isn't "Disabled") when the user
 * is signed in and a house default exists for this capability.
 */
export function hasResolvableMediaGenerationModel(
  kind: MediaGenerationKind,
  runtimeConfig: RuntimeConfigPayload | null,
  isSignedIn: boolean,
): boolean {
  return isSignedIn && Boolean(mediaGenerationDefaultModel(kind, runtimeConfig).trim());
}

/** Hydrate a draft from the persisted runtime config document. */
export function deriveMediaGenerationDraft(
  kind: MediaGenerationKind,
  document: Record<string, unknown>,
  runtimeConfig: RuntimeConfigPayload | null,
): MediaGenerationDraft {
  const { snakeKey, camelKey } = KIND_CONFIG[kind];
  const runtimePayload = asRecord(document.runtime);
  const payload = asRecord(runtimePayload[snakeKey] ?? runtimePayload[camelKey]);
  const rawProvider = firstNonEmptyString(
    payload.provider as string | undefined,
    payload.provider_id as string | undefined,
    payload.providerId as string | undefined,
  );
  const providerId: MediaGenerationDraft["providerId"] =
    rawProvider === "holaboss_model_proxy" || rawProvider === "holaboss"
      ? "holaboss"
      : "";
  return {
    providerId,
    model: providerId
      ? firstNonEmptyString(
          payload.model as string | undefined,
          payload.model_id as string | undefined,
          payload.modelId as string | undefined,
          mediaGenerationDefaultModel(kind, runtimeConfig),
        )
      : "",
  };
}

/**
 * Persist a model selection for one media-generation slice. Reads the current
 * config document, replaces only that slice, writes it back, and returns the
 * updated runtime config (or null when the desktop API is unavailable).
 */
export async function persistMediaGenerationModel(
  kind: MediaGenerationKind,
  model: string,
): Promise<RuntimeConfigPayload | null> {
  if (!window.electronAPI) {
    return null;
  }
  const { snakeKey, camelKey } = KIND_CONFIG[kind];
  const currentText = await window.electronAPI.runtime.getConfigDocument();
  const currentDocument = parseRuntimeConfigDocument(currentText);
  const nextRuntime: Record<string, unknown> = {
    ...asRecord(currentDocument.runtime),
  };
  delete nextRuntime[camelKey];
  const normalized = model.trim();
  if (normalized) {
    nextRuntime[snakeKey] = { provider: PROVIDER_STORAGE_ID, model: normalized };
  } else {
    delete nextRuntime[snakeKey];
  }
  const nextText = `${JSON.stringify(
    { ...currentDocument, runtime: nextRuntime },
    null,
    2,
  )}\n`;
  return window.electronAPI.runtime.setConfigDocument(nextText);
}
