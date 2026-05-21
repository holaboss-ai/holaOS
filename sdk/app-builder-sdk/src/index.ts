// Public API surface for @holaboss/app-builder-sdk.

// Core
export { createApp } from "./app.ts"
export type { CreateAppOptions } from "./app.ts"
export { createBridge } from "./bridge.ts"
export type { TransportFn } from "./bridge.ts"
export { z } from "zod"

// State backends
export { SqliteStateBackend } from "./runtime/state-backend-sqlite.ts"
export type { SqliteStateBackendOpts } from "./runtime/state-backend-sqlite.ts"

// MCP server (production boot)
export { startMcpServer } from "./runtime/mcp-server.ts"
export type { StartMcpServerOpts, StartedMcpServer } from "./runtime/mcp-server.ts"

// Integration readiness — ask the runtime "is this provider ready for this
// app?" instead of pinging the upstream API host. Required for any UI that
// surfaces a "connected / needs connection" badge.
export { getIntegrationStatus } from "./runtime/integration-status.ts"
export type {
  IntegrationStatusCode,
  IntegrationStatusIssue,
  IntegrationStatusResult,
  GetIntegrationStatusOpts,
} from "./runtime/integration-status.ts"

// Bridge transports (pick the one that matches your deployment)
export { createBearerTokenTransport } from "./bridge-transports/bearer.ts"
export type { BearerTokenOpts } from "./bridge-transports/bearer.ts"
export { createComposioDirectTransport } from "./bridge-transports/composio-direct.ts"
export type { ComposioDirectOpts } from "./bridge-transports/composio-direct.ts"
export { createRuntimeBrokerTransport } from "./bridge-transports/runtime-broker.ts"
export type { RuntimeBrokerOpts } from "./bridge-transports/runtime-broker.ts"

export type {
  AppHandle,
  AppConfig,
  AppState,
  BridgeClient,
  BridgeError,
  BridgeErrorCode,
  DerivedTool,
  StateBackend,
  ProxyResult,
  ProviderRegistry,
  ResourceDef,
  ResourceHandle,
  StateTuple,
  ActionDef,
  ReversibleDef,
  Step,
  StepContext,
  StepResult,
  SyncDef,
  TurnContext,
  HttpMethod,
} from "./types.ts"
