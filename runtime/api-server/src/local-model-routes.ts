import type { FastifyInstance, FastifyReply } from "fastify";

import {
  discoverLocalModelEndpoints,
  isLocalModelEndpointError,
  LOCAL_MODEL_ENGINES,
  LocalModelDiscoveryError,
  normalizeLocalModelBaseUrl,
  probeLocalModelEndpoint,
  type LocalModelEndpoint,
  type LocalModelEngine,
  type LocalModelInfo,
  type LocalModelProbeOptions,
} from "./local-model-discovery.js";
import {
  isLocalModelProviderId,
  localModelProviderId,
  readLocalModelProviders,
  registerLocalModelProvider,
  RuntimeConfigServiceError,
  unregisterLocalModelProvider,
  type ConfiguredLocalModelProvider,
} from "./runtime-config.js";

class LocalModelRequestError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function sendLocalModelError(reply: FastifyReply, error: unknown, fallback: string) {
  if (error instanceof LocalModelRequestError || error instanceof RuntimeConfigServiceError) {
    return reply.code(error.statusCode).send({ detail: error.message });
  }
  if (error instanceof LocalModelDiscoveryError) {
    return reply.code(502).send({ detail: error.message });
  }
  return reply.code(500).send({ detail: error instanceof Error ? error.message : fallback });
}

function configuredProviderFor(
  configured: ConfiguredLocalModelProvider[],
  baseUrl: string,
  engine: string,
): ConfiguredLocalModelProvider | null {
  return (
    configured.find((provider) => provider.base_url === baseUrl) ??
    configured.find((provider) => provider.provider_id === localModelProviderId(baseUrl, engine)) ??
    null
  );
}

function annotateEndpoint(endpoint: LocalModelEndpoint, configured: ConfiguredLocalModelProvider[]) {
  const existing = configuredProviderFor(configured, endpoint.base_url, endpoint.engine);
  const providerId = existing?.provider_id ?? localModelProviderId(endpoint.base_url, endpoint.engine);
  const registeredModelIds = new Set(existing?.model_ids ?? []);
  return {
    ...endpoint,
    provider_id: providerId,
    registered: Boolean(existing),
    models: endpoint.models.map((model) => ({
      ...model,
      token: `${providerId}/${model.id}`,
      registered: registeredModelIds.has(model.id),
    })),
  };
}

function parseEngine(value: unknown): LocalModelEngine | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const engine = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!(LOCAL_MODEL_ENGINES as readonly string[]).includes(engine)) {
    throw new LocalModelRequestError(400, `engine must be one of ${LOCAL_MODEL_ENGINES.join(", ")}`);
  }
  return engine as LocalModelEngine;
}

function selectModels(
  available: LocalModelInfo[],
  requested: string[],
  providerId: string,
  baseUrl: string,
): LocalModelInfo[] {
  if (requested.length === 0) {
    return available;
  }
  const byId = new Map(available.map((model) => [model.id, model]));
  const selected: LocalModelInfo[] = [];
  const missing: string[] = [];
  for (const raw of requested) {
    const id = raw.startsWith(`${providerId}/`) ? raw.slice(providerId.length + 1) : raw;
    const model = byId.get(id);
    if (model) {
      if (!selected.includes(model)) {
        selected.push(model);
      }
    } else {
      missing.push(raw);
    }
  }
  if (missing.length > 0) {
    const availableIds = available.map((model) => model.id).join(", ") || "none";
    throw new LocalModelRequestError(
      400,
      `model(s) not served at ${baseUrl}: ${missing.join(", ")}. Available: ${availableIds}`,
    );
  }
  return selected;
}

export function registerLocalModelRoutes(app: FastifyInstance, options: LocalModelProbeOptions = {}): void {
  app.get("/api/v1/local-models/discover", async (request, reply) => {
    const query = isRecord(request.query) ? request.query : {};
    try {
      const entries = await discoverLocalModelEndpoints({ ...options, baseUrls: stringValues(query.base_url) });
      const configured = readLocalModelProviders();
      return {
        endpoints: entries
          .filter((entry): entry is LocalModelEndpoint => !isLocalModelEndpointError(entry))
          .map((endpoint) => annotateEndpoint(endpoint, configured)),
        errors: entries.filter(isLocalModelEndpointError),
      };
    } catch (error) {
      return sendLocalModelError(reply, error, "local model discovery failed");
    }
  });

  app.post("/api/v1/local-models/register", async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};
    try {
      const rawBaseUrl = typeof body.base_url === "string" ? body.base_url.trim() : "";
      if (!rawBaseUrl) {
        throw new LocalModelRequestError(400, "base_url is required");
      }
      let baseUrl: string;
      try {
        baseUrl = normalizeLocalModelBaseUrl(rawBaseUrl);
      } catch (error) {
        throw new LocalModelRequestError(400, error instanceof Error ? error.message : String(error));
      }
      const requestedEngine = parseEngine(body.engine);
      const endpoint = await probeLocalModelEndpoint(baseUrl, options);
      const existing = readLocalModelProviders().find((provider) => provider.base_url === endpoint.base_url);
      const engine = requestedEngine ?? (existing?.engine || endpoint.engine);
      const providerId = localModelProviderId(endpoint.base_url, engine);
      if (endpoint.models.length === 0) {
        throw new LocalModelRequestError(400, `the ${endpoint.engine} server at ${endpoint.base_url} has no chat models`);
      }
      const models = selectModels(endpoint.models, stringValues(body.models), providerId, endpoint.base_url);
      const registered = registerLocalModelProvider({ baseUrl: endpoint.base_url, engine, models });
      const replacedProviderId =
        existing && existing.provider_id !== registered.provider_id && isLocalModelProviderId(existing.provider_id)
          ? unregisterLocalModelProvider(existing.provider_id).provider_id
          : null;
      return {
        ...registered,
        ...(endpoint.engine_version ? { engine_version: endpoint.engine_version } : {}),
        ...(replacedProviderId ? { replaced_provider_id: replacedProviderId } : {}),
        usage: `Now selectable in the chat model picker. Reference a model as "${registered.provider_id}/<model id>", e.g. "${registered.models[0]?.token ?? ""}".`,
      };
    } catch (error) {
      return sendLocalModelError(reply, error, "local model registration failed");
    }
  });

  app.delete("/api/v1/local-models/:providerId", async (request, reply) => {
    const params = isRecord(request.params) ? request.params : {};
    const providerId = typeof params.providerId === "string" ? params.providerId.trim() : "";
    try {
      const result = unregisterLocalModelProvider(providerId);
      if (!result.removed) {
        throw new LocalModelRequestError(404, `local model provider not found: ${providerId}`);
      }
      return result;
    } catch (error) {
      return sendLocalModelError(reply, error, "local model provider removal failed");
    }
  });
}
