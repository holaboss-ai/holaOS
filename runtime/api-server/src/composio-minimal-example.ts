import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL = "https://backend.composio.dev";

export interface CreateManagedConnectLinkParams {
  apiKey: string;
  toolkitSlug: string;
  userId: string;
  callbackUrl?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface ManagedConnectLinkResult {
  authConfigId: string;
  authConfigCreated: boolean;
  connectedAccountId: string;
  redirectUrl: string;
  expiresAt: string | null;
  userId: string;
}

export interface ConnectedAccount {
  id: string;
  status: string;
  authConfigId: string | null;
  toolkitSlug: string | null;
  userId: string | null;
}

export interface GetConnectedAccountParams {
  apiKey: string;
  connectedAccountId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface WaitForConnectedAccountParams extends GetConnectedAccountParams {
  /** Max time to wait in ms. Default 120_000 (2 min). */
  timeoutMs?: number;
  /** Poll interval in ms. Default 3_000 (3s). */
  intervalMs?: number;
}

export interface ProxyProviderRequestParams {
  apiKey: string;
  connectedAccountId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  endpoint: string;
  body?: unknown;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface ProxyProviderResponse<TData = unknown> {
  data: TData | null;
  status: number;
  headers: Record<string, string>;
}

interface AuthConfigListItem {
  id?: string;
  status?: string;
  is_composio_managed?: boolean;
  toolkit?: { slug?: string | null } | null;
}

function requiredString(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmed;
}

function buildHeaders(apiKey: string): HeadersInit {
  return {
    "x-api-key": requiredString(apiKey, "apiKey"),
    "Content-Type": "application/json",
    Accept: "application/json"
  };
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) {
    throw new Error(`Composio returned an empty response with status ${response.status}`);
  }
  return JSON.parse(text) as T;
}

function baseUrl(base?: string): string {
  return (base?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

async function listManagedAuthConfigs(params: {
  apiKey: string;
  toolkitSlug: string;
  baseUrl?: string;
  fetchImpl: typeof fetch;
}): Promise<AuthConfigListItem[]> {
  const query = new URLSearchParams({
    toolkit_slug: params.toolkitSlug,
    is_composio_managed: "true",
    show_disabled: "false"
  });
  const response = await params.fetchImpl(`${baseUrl(params.baseUrl)}/api/v3/auth_configs?${query.toString()}`, {
    headers: buildHeaders(params.apiKey)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to list auth configs: ${response.status} ${body}`);
  }
  const payload = await parseJson<{ items?: AuthConfigListItem[] }>(response);
  return payload.items ?? [];
}

async function createManagedAuthConfig(params: {
  apiKey: string;
  toolkitSlug: string;
  baseUrl?: string;
  fetchImpl: typeof fetch;
}): Promise<string> {
  const response = await params.fetchImpl(`${baseUrl(params.baseUrl)}/api/v3/auth_configs`, {
    method: "POST",
    headers: buildHeaders(params.apiKey),
    body: JSON.stringify({
      toolkit: { slug: params.toolkitSlug },
      auth_config: {
        type: "use_composio_managed_auth"
      }
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to create auth config: ${response.status} ${body}`);
  }
  const payload = await parseJson<{ id?: string; auth_config?: { id?: string } }>(response);
  const authConfigId = payload.id ?? payload.auth_config?.id ?? "";
  return requiredString(authConfigId, "authConfigId");
}

async function createConnectLink(params: {
  apiKey: string;
  authConfigId: string;
  userId: string;
  callbackUrl?: string;
  baseUrl?: string;
  fetchImpl: typeof fetch;
}): Promise<ManagedConnectLinkResult> {
  const response = await params.fetchImpl(`${baseUrl(params.baseUrl)}/api/v3/connected_accounts/link`, {
    method: "POST",
    headers: buildHeaders(params.apiKey),
    body: JSON.stringify({
      auth_config_id: params.authConfigId,
      user_id: params.userId,
      ...(params.callbackUrl ? { callback_url: params.callbackUrl } : {})
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to create connect link: ${response.status} ${body}`);
  }
  const payload = await parseJson<{
    redirect_url?: string;
    expires_at?: string | null;
    connected_account_id?: string;
  }>(response);
  return {
    authConfigId: params.authConfigId,
    authConfigCreated: false,
    connectedAccountId: requiredString(payload.connected_account_id ?? "", "connectedAccountId"),
    redirectUrl: requiredString(payload.redirect_url ?? "", "redirectUrl"),
    expiresAt: payload.expires_at ?? null,
    userId: params.userId
  };
}

export async function createManagedConnectLink(
  params: CreateManagedConnectLinkParams
): Promise<ManagedConnectLinkResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const toolkitSlug = requiredString(params.toolkitSlug, "toolkitSlug");
  const userId = requiredString(params.userId, "userId");
  const configs = await listManagedAuthConfigs({
    apiKey: params.apiKey,
    toolkitSlug,
    baseUrl: params.baseUrl,
    fetchImpl
  });
  const existing = configs.find(
    (config) =>
      config.status?.toUpperCase() === "ENABLED" &&
      config.is_composio_managed === true &&
      config.toolkit?.slug?.toLowerCase() === toolkitSlug.toLowerCase()
  );
  const authConfigId =
    existing?.id ??
    (await createManagedAuthConfig({
      apiKey: params.apiKey,
      toolkitSlug,
      baseUrl: params.baseUrl,
      fetchImpl
    }));

  const result = await createConnectLink({
    apiKey: params.apiKey,
    authConfigId,
    userId,
    callbackUrl: params.callbackUrl,
    baseUrl: params.baseUrl,
    fetchImpl
  });
  return {
    ...result,
    authConfigCreated: !existing
  };
}

export async function getConnectedAccount(
  params: GetConnectedAccountParams
): Promise<ConnectedAccount> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const id = requiredString(params.connectedAccountId, "connectedAccountId");
  const response = await fetchImpl(`${baseUrl(params.baseUrl)}/api/v3/connected_accounts/${id}`, {
    headers: buildHeaders(params.apiKey)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to get connected account: ${response.status} ${body}`);
  }
  const payload = await parseJson<{
    id?: string;
    status?: string;
    auth_config?: { id?: string } | null;
    toolkit?: { slug?: string } | null;
    user_id?: string;
  }>(response);
  return {
    id: payload.id ?? id,
    status: (payload.status ?? "unknown").toUpperCase(),
    authConfigId: payload.auth_config?.id ?? null,
    toolkitSlug: payload.toolkit?.slug ?? null,
    userId: payload.user_id ?? null
  };
}

export async function waitForConnectedAccount(
  params: WaitForConnectedAccountParams
): Promise<ConnectedAccount> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  const intervalMs = params.intervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const account = await getConnectedAccount(params);
    if (account.status === "ACTIVE") {
      return account;
    }
    if (Date.now() + intervalMs > deadline) {
      throw new Error(
        `Connected account ${params.connectedAccountId} did not become ACTIVE within ${timeoutMs}ms (last status: ${account.status})`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function proxyProviderRequest<TData = unknown>(
  params: ProxyProviderRequestParams
): Promise<ProxyProviderResponse<TData>> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const response = await fetchImpl(`${baseUrl(params.baseUrl)}/api/v3/tools/execute/proxy`, {
    method: "POST",
    headers: buildHeaders(params.apiKey),
    body: JSON.stringify({
      connected_account_id: requiredString(params.connectedAccountId, "connectedAccountId"),
      endpoint: requiredString(params.endpoint, "endpoint"),
      method: params.method,
      ...(params.body !== undefined ? { body: params.body } : {})
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Proxy request failed: ${response.status} ${body}`);
  }
  const payload = await parseJson<{
    data?: TData | null;
    status?: number;
    headers?: Record<string, string>;
  }>(response);
  return {
    data: payload.data ?? null,
    status: payload.status ?? response.status,
    headers: payload.headers ?? {}
  };
}

function parseCliArgs(argv: string[]): {
  toolkitSlug: string;
  userId: string;
  callbackUrl?: string;
  baseUrl?: string;
} {
  let toolkitSlug = "gmail";
  let userId = `holaboss-smoke-${Date.now()}`;
  let callbackUrl: string | undefined;
  let apiBaseUrl: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--toolkit" && argv[index + 1]) {
      toolkitSlug = argv[index + 1]!;
      index += 1;
      continue;
    }
    if (value === "--user-id" && argv[index + 1]) {
      userId = argv[index + 1]!;
      index += 1;
      continue;
    }
    if (value === "--callback-url" && argv[index + 1]) {
      callbackUrl = argv[index + 1]!;
      index += 1;
      continue;
    }
    if (value === "--base-url" && argv[index + 1]) {
      apiBaseUrl = argv[index + 1]!;
      index += 1;
    }
  }

  return { toolkitSlug, userId, callbackUrl, baseUrl: apiBaseUrl };
}

async function main(argv: string[]): Promise<void> {
  const apiKey = process.env.COMPOSIO_API_KEY ?? "";
  if (!apiKey.trim()) {
    throw new Error("COMPOSIO_API_KEY is required");
  }

  const args = parseCliArgs(argv);

  // Step 1: Create managed connect link (get OAuth redirect URL)
  const link = await createManagedConnectLink({
    apiKey,
    toolkitSlug: args.toolkitSlug,
    userId: args.userId,
    callbackUrl: args.callbackUrl,
    baseUrl: args.baseUrl
  });
  process.stdout.write(`\n--- Step 1: Connect link created ---\n`);
  process.stdout.write(`${JSON.stringify(link, null, 2)}\n`);
  process.stdout.write(`\nOpen this URL to complete OAuth:\n  ${link.redirectUrl}\n`);

  // Step 2: Wait for connected account to become ACTIVE
  process.stdout.write(`\n--- Step 2: Waiting for OAuth completion ---\n`);
  process.stdout.write(`Polling connected account ${link.connectedAccountId}...\n`);
  const account = await waitForConnectedAccount({
    apiKey,
    connectedAccountId: link.connectedAccountId,
    baseUrl: args.baseUrl,
    timeoutMs: 300_000,
    intervalMs: 5_000
  });
  process.stdout.write(`Connected account is ACTIVE!\n`);
  process.stdout.write(`${JSON.stringify(account, null, 2)}\n`);

  // Step 3: Make a proxy request to verify the token works
  process.stdout.write(`\n--- Step 3: Proxy test request ---\n`);
  const proxyEndpoint =
    args.toolkitSlug === "gmail" || args.toolkitSlug === "google"
      ? "https://gmail.googleapis.com/gmail/v1/users/me/profile"
      : args.toolkitSlug === "github"
        ? "https://api.github.com/user"
        : null;

  if (proxyEndpoint) {
    const proxyResult = await proxyProviderRequest({
      apiKey,
      connectedAccountId: link.connectedAccountId,
      method: "GET",
      endpoint: proxyEndpoint,
      baseUrl: args.baseUrl
    });
    process.stdout.write(`Proxy status: ${proxyResult.status}\n`);
    process.stdout.write(`Proxy data:\n${JSON.stringify(proxyResult.data, null, 2)}\n`);
  } else {
    process.stdout.write(`Skipping proxy test (no default endpoint for toolkit '${args.toolkitSlug}')\n`);
  }

  process.stdout.write(`\n--- Done: OAuth feasibility verified ---\n`);
}

const entryPath = process.argv[1] ? fileURLToPath(new URL(`file://${process.argv[1]}`)) : "";
if (process.argv[1] && fileURLToPath(import.meta.url) === entryPath) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
