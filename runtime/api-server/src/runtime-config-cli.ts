import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  type ProductRuntimeConfig,
  resolveProductRuntimeConfig,
  runtimeConfigResponse,
  updateRuntimeConfigDocument
} from "./runtime-config.js";
import { installBenignStdioEpipeGuard } from "./stdio-epipe.js";

type ResolveRuntimeConfigRequest = {
  require_auth?: boolean | null;
  require_user?: boolean | null;
  require_base_url?: boolean | null;
  include_default_base_url?: boolean | null;
};

type UpdateRuntimeConfigRequest = {
  auth_token?: string | null;
  user_id?: string | null;
  sandbox_id?: string | null;
  model_proxy_base_url?: string | null;
  default_model?: string | null;
  subagent_model?: string | null;
  runtime_mode?: string | null;
  default_provider?: string | null;
  holaboss_enabled?: boolean | string | null;
  desktop_browser_enabled?: boolean | string | null;
  desktop_browser_url?: string | null;
  desktop_browser_auth_token?: string | null;
};

function decodeCliRequest<T>(encoded: string): T {
  const trimmed = encoded.trim();
  if (!trimmed) {
    throw new Error("request_base64 is required");
  }
  const raw = Buffer.from(trimmed, "base64").toString("utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request payload must be an object");
  }
  return parsed as T;
}

function productRuntimeConfigResponse(config: ProductRuntimeConfig): Record<string, unknown> {
  return {
    auth_token: config.authToken,
    user_id: config.userId,
    sandbox_id: config.sandboxId,
    model_proxy_base_url: config.modelProxyBaseUrl,
    default_model: config.defaultModel,
    subagent_model: config.subagentModel,
    runtime_mode: config.runtimeMode,
    default_provider: config.defaultProvider,
    holaboss_enabled: config.holabossEnabled,
    desktop_browser_enabled: config.desktopBrowserEnabled,
    desktop_browser_url: config.desktopBrowserUrl,
    desktop_browser_auth_token: config.desktopBrowserAuthToken,
    config_path: config.configPath,
    loaded_from_file: config.loadedFromFile
  };
}

function resolveRuntimeConfig(request: ResolveRuntimeConfigRequest = {}): ProductRuntimeConfig {
  return resolveProductRuntimeConfig({
    requireAuth: request.require_auth ?? true,
    requireUser: request.require_user ?? false,
    requireBaseUrl: request.require_base_url ?? true,
    includeDefaultBaseUrl: request.include_default_base_url ?? false
  });
}

export async function runRuntimeConfigCli(
  argv: string[],
  options: {
    io?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
  } = {}
): Promise<number> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  installBenignStdioEpipeGuard(io);
  const operation = (argv[0] ?? "").trim().toLowerCase();
  const requestBase64 = argv[1] === "--request-base64" ? argv[2] ?? "" : argv[1] ?? "";

  if (!operation) {
    io.stderr.write("operation is required\n");
    return 2;
  }

  try {
    let response: Record<string, unknown>;
    if (operation === "resolve") {
      const request = requestBase64 ? decodeCliRequest<ResolveRuntimeConfigRequest>(requestBase64) : {};
      response = productRuntimeConfigResponse(resolveRuntimeConfig(request));
    } else if (operation === "status") {
      response = runtimeConfigResponse(
        resolveProductRuntimeConfig({
          requireAuth: false,
          requireUser: false,
          requireBaseUrl: false
        })
      );
    } else if (operation === "update") {
      const request = requestBase64 ? decodeCliRequest<UpdateRuntimeConfigRequest>(requestBase64) : {};
      response = productRuntimeConfigResponse(updateRuntimeConfigDocument(request));
    } else {
      io.stderr.write(`unsupported operation: ${operation}\n`);
      return 2;
    }
    io.stdout.write(JSON.stringify(response));
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runRuntimeConfigCli(process.argv.slice(2));
}

// See workspace-runtime-plan.ts for why the usual import.meta.url guard
// isn't sufficient when these files are re-bundled into dist/index.mjs.
const RUNTIME_CONFIG_CLI_BASENAME = "runtime-config-cli";
if (
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href &&
  path.basename(process.argv[1] ?? "", path.extname(process.argv[1] ?? "")) ===
    RUNTIME_CONFIG_CLI_BASENAME
) {
  await main();
}
