import {
  discoverLocalModelEndpoints,
  isLocalModelEndpointError,
  type DiscoverLocalModelEndpointsOptions,
  type LocalModelDiscoveryEntry,
  type LocalModelEndpoint,
} from "./local-model-discovery.js";
import {
  localModelAutoDetectEnabled,
  localModelProviderId,
  readLocalModelProviders,
  registerLocalModelProvider,
  type ConfiguredLocalModelProvider,
  type RegisteredLocalModelProvider,
} from "./runtime-config.js";

export const LOCAL_MODEL_AUTODETECT_INTERVAL_MS = 30_000;
const LOCAL_MODEL_AUTODETECT_INITIAL_DELAY_MS = 2_000;

export interface LocalModelAutoDetectDeps {
  enabled?: () => boolean;
  discover?: (options: DiscoverLocalModelEndpointsOptions) => Promise<LocalModelDiscoveryEntry[]>;
  readProviders?: () => ConfiguredLocalModelProvider[];
  register?: typeof registerLocalModelProvider;
}

function existingProviderFor(
  configured: ConfiguredLocalModelProvider[],
  endpoint: LocalModelEndpoint,
): ConfiguredLocalModelProvider | null {
  return (
    configured.find((provider) => provider.base_url === endpoint.base_url) ??
    configured.find((provider) => provider.provider_id === localModelProviderId(endpoint.base_url, endpoint.engine)) ??
    null
  );
}

function unchanged(existing: ConfiguredLocalModelProvider, endpoint: LocalModelEndpoint): boolean {
  if (existing.model_ids.length !== endpoint.models.length) {
    return false;
  }
  return endpoint.models.every(
    (model) =>
      existing.model_ids.includes(model.id) &&
      (model.context_window === undefined || existing.context_windows[model.id] === model.context_window),
  );
}

export async function syncLocalModelProviders(
  deps: LocalModelAutoDetectDeps = {},
): Promise<RegisteredLocalModelProvider[]> {
  if (!(deps.enabled ?? localModelAutoDetectEnabled)()) {
    return [];
  }
  const entries = await (deps.discover ?? discoverLocalModelEndpoints)({});
  const configured = (deps.readProviders ?? readLocalModelProviders)();
  const register = deps.register ?? registerLocalModelProvider;
  const changed: RegisteredLocalModelProvider[] = [];
  for (const entry of entries) {
    if (isLocalModelEndpointError(entry) || entry.models.length === 0) {
      continue;
    }
    const existing = existingProviderFor(configured, entry);
    if (existing && unchanged(existing, entry)) {
      continue;
    }
    changed.push(
      register({
        baseUrl: entry.base_url,
        engine: existing?.engine || entry.engine,
        models: entry.models,
      }),
    );
  }
  return changed;
}

export function startLocalModelAutoDetect(options: {
  intervalMs?: number;
  initialDelayMs?: number;
  deps?: LocalModelAutoDetectDeps;
  onChange?: (changed: RegisteredLocalModelProvider[]) => void;
  onError?: (error: unknown) => void;
} = {}): () => void {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) {
      return;
    }
    running = true;
    try {
      const changed = await syncLocalModelProviders(options.deps);
      if (changed.length > 0) {
        options.onChange?.(changed);
      }
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };
  const initial = setTimeout(() => void tick(), options.initialDelayMs ?? LOCAL_MODEL_AUTODETECT_INITIAL_DELAY_MS);
  const interval = setInterval(() => void tick(), options.intervalMs ?? LOCAL_MODEL_AUTODETECT_INTERVAL_MS);
  initial.unref();
  interval.unref();
  return () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(interval);
  };
}
